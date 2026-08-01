#![forbid(unsafe_code)]

use std::env;
use std::io::{self, BufRead, Write};
use std::path::PathBuf;

use serde::Deserialize;
use serde_json::{Value, json};
use sync_protocol::{HealthResponse, ProtocolVersion, RpcRequest, RpcResponse};
use sync_storage::mapping::{MappingRecord, MappingStore};

const MAPPING_STORE_UNAVAILABLE: &str =
    "Mapping store is unavailable: FOLDERSYNC_DATA_DIR was not set or the database failed to open.";

fn main() {
    if env::args().any(|argument| argument == "--rpc-stdio") {
        run_stdio_rpc();
        return;
    }

    let version = ProtocolVersion::default();
    println!(
        "Tethera engine {} — protocol {version}",
        env!("CARGO_PKG_VERSION")
    );
}

fn run_stdio_rpc() {
    let expected_token = match env::var("FOLDERSYNC_RPC_SESSION_TOKEN") {
        Ok(token) if !token.is_empty() => token,
        _ => {
            eprintln!("FOLDERSYNC_RPC_SESSION_TOKEN is required in RPC mode");
            std::process::exit(2);
        }
    };

    let mapping_store = open_mapping_store();

    let stdin = io::stdin();
    let mut stdout = io::stdout().lock();

    for line in stdin.lock().lines() {
        let Ok(line) = line else {
            break;
        };
        if line.trim().is_empty() {
            continue;
        }

        let response = handle_line(&line, &expected_token, mapping_store.as_ref());
        if serde_json::to_writer(&mut stdout, &response).is_err() {
            break;
        }
        if writeln!(&mut stdout).is_err() || stdout.flush().is_err() {
            break;
        }

        if response
            .get("result")
            .and_then(|result| result.get("shuttingDown"))
            .and_then(Value::as_bool)
            == Some(true)
        {
            break;
        }
    }
}

/// Opens the mapping index under `FOLDERSYNC_DATA_DIR`, if the desktop shell provided one.
fn open_mapping_store() -> Option<MappingStore> {
    let data_dir = env::var("FOLDERSYNC_DATA_DIR").ok()?;
    let db_path = PathBuf::from(data_dir).join("mappings.sqlite3");
    match MappingStore::open(&db_path) {
        Ok(store) => Some(store),
        Err(error) => {
            eprintln!(
                "Failed to open mapping store at {}: {error}",
                db_path.display()
            );
            None
        }
    }
}

fn handle_line(line: &str, expected_token: &str, mapping_store: Option<&MappingStore>) -> Value {
    let request = match serde_json::from_str::<RpcRequest>(line) {
        Ok(request) => request,
        Err(error) => {
            return json!({
                "id": "unknown",
                "ok": false,
                "error": format!("Invalid request: {error}")
            });
        }
    };

    if request.session_token != expected_token {
        return serde_json::to_value(RpcResponse::<Value>::error(
            request.id,
            "Invalid RPC session token.",
        ))
        .expect("serialising an RPC error should not fail");
    }

    match request.method.as_str() {
        "health" => serde_json::to_value(RpcResponse::success(
            request.id,
            HealthResponse {
                name: "Tethera engine",
                version: env!("CARGO_PKG_VERSION"),
                protocol: ProtocolVersion::default().to_string(),
            },
        ))
        .expect("serialising a health response should not fail"),
        "shutdown" => serde_json::to_value(RpcResponse::success(
            request.id,
            json!({ "shuttingDown": true }),
        ))
        .expect("serialising a shutdown response should not fail"),
        "mapping.upsert" => handle_mapping_upsert(request, mapping_store),
        "mapping.get" => handle_mapping_get(request, mapping_store),
        "mapping.list" => handle_mapping_list(request, mapping_store),
        "mapping.listPendingDelivery" => {
            handle_mapping_list_pending_delivery(request, mapping_store)
        }
        "mapping.delete" => handle_mapping_delete(request, mapping_store),
        other => serde_json::to_value(RpcResponse::<Value>::error(
            request.id,
            format!("Unknown method: {other}"),
        ))
        .expect("serialising an RPC error should not fail"),
    }
}

#[derive(Deserialize)]
struct MappingIdParams {
    id: String,
}

fn success_response(id: String, result: impl serde::Serialize) -> Value {
    serde_json::to_value(RpcResponse::success(id, result))
        .expect("serialising an RPC success response should not fail")
}

fn error_response(id: String, message: impl Into<String>) -> Value {
    serde_json::to_value(RpcResponse::<Value>::error(id, message))
        .expect("serialising an RPC error response should not fail")
}

fn handle_mapping_upsert(request: RpcRequest, mapping_store: Option<&MappingStore>) -> Value {
    let Some(store) = mapping_store else {
        return error_response(request.id, MAPPING_STORE_UNAVAILABLE);
    };
    let record = match request.params.map(serde_json::from_value::<MappingRecord>) {
        Some(Ok(record)) => record,
        Some(Err(parse_error)) => {
            return error_response(request.id, format!("Invalid mapping record: {parse_error}"));
        }
        None => return error_response(request.id, "mapping.upsert requires params"),
    };
    match store.upsert(&record) {
        Ok(()) => success_response(request.id, record),
        Err(store_error) => {
            error_response(request.id, format!("Failed to store mapping: {store_error}"))
        }
    }
}

fn handle_mapping_get(request: RpcRequest, mapping_store: Option<&MappingStore>) -> Value {
    let Some(store) = mapping_store else {
        return error_response(request.id, MAPPING_STORE_UNAVAILABLE);
    };
    let params = match request.params.map(serde_json::from_value::<MappingIdParams>) {
        Some(Ok(params)) => params,
        Some(Err(parse_error)) => {
            return error_response(request.id, format!("Invalid params: {parse_error}"));
        }
        None => return error_response(request.id, "mapping.get requires an id"),
    };
    match store.get(&params.id) {
        Ok(record) => success_response(request.id, record),
        Err(store_error) => {
            error_response(request.id, format!("Failed to read mapping: {store_error}"))
        }
    }
}

fn handle_mapping_list(request: RpcRequest, mapping_store: Option<&MappingStore>) -> Value {
    let Some(store) = mapping_store else {
        return error_response(request.id, MAPPING_STORE_UNAVAILABLE);
    };
    match store.list() {
        Ok(records) => success_response(request.id, records),
        Err(store_error) => {
            error_response(request.id, format!("Failed to list mappings: {store_error}"))
        }
    }
}

fn handle_mapping_list_pending_delivery(
    request: RpcRequest,
    mapping_store: Option<&MappingStore>,
) -> Value {
    let Some(store) = mapping_store else {
        return error_response(request.id, MAPPING_STORE_UNAVAILABLE);
    };
    match store.list_pending_delivery() {
        Ok(records) => success_response(request.id, records),
        Err(store_error) => error_response(
            request.id,
            format!("Failed to list pending mappings: {store_error}"),
        ),
    }
}

fn handle_mapping_delete(request: RpcRequest, mapping_store: Option<&MappingStore>) -> Value {
    let Some(store) = mapping_store else {
        return error_response(request.id, MAPPING_STORE_UNAVAILABLE);
    };
    let params = match request.params.map(serde_json::from_value::<MappingIdParams>) {
        Some(Ok(params)) => params,
        Some(Err(parse_error)) => {
            return error_response(request.id, format!("Invalid params: {parse_error}"));
        }
        None => return error_response(request.id, "mapping.delete requires an id"),
    };
    match store.delete(&params.id) {
        Ok(deleted) => success_response(request.id, json!({ "deleted": deleted })),
        Err(store_error) => {
            error_response(request.id, format!("Failed to delete mapping: {store_error}"))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::handle_line;
    use sync_storage::mapping::MappingStore;

    fn sample_mapping_json() -> &'static str {
        r#"{
            "id": "mapping-1",
            "name": "Projects",
            "initiatorDeviceId": "linux-box",
            "initiatorDeviceName": "Linux Mint",
            "responderDeviceId": "win-box",
            "responderDeviceName": "Windows 11",
            "initiatorPath": "/home/tommy/Projects",
            "responderPath": "C:\\Users\\tommy\\Projects",
            "mode": "two-way",
            "ignorePatterns": ["node_modules/"],
            "historyDays": 30,
            "historyMaxBytes": 5000000000,
            "setupStatus": "pending-approval",
            "pendingDelivery": false,
            "preview": null,
            "createdAt": "2026-08-01T00:00:00Z",
            "updatedAt": "2026-08-01T00:00:00Z"
        }"#
    }

    #[test]
    fn health_requires_the_session_token() {
        let response = handle_line(
            r#"{"id":"1","method":"health","sessionToken":"wrong"}"#,
            "correct",
            None,
        );
        assert_eq!(response["ok"], false);
    }

    #[test]
    fn health_returns_protocol_metadata() {
        let response = handle_line(
            r#"{"id":"1","method":"health","sessionToken":"correct"}"#,
            "correct",
            None,
        );
        assert_eq!(response["ok"], true);
        assert_eq!(response["result"]["protocol"], "0.1");
    }

    #[test]
    fn unknown_method_still_errors() {
        let response = handle_line(
            r#"{"id":"1","method":"nope","sessionToken":"correct"}"#,
            "correct",
            None,
        );
        assert_eq!(response["ok"], false);
    }

    #[test]
    fn mapping_methods_require_a_store() {
        let response = handle_line(
            r#"{"id":"1","method":"mapping.list","sessionToken":"correct"}"#,
            "correct",
            None,
        );
        assert_eq!(response["ok"], false);
        assert!(response["error"].as_str().unwrap().contains("unavailable"));
    }

    #[test]
    fn mapping_upsert_then_get_round_trips() {
        let store = MappingStore::open_in_memory().expect("open store");
        let upsert_line = format!(
            r#"{{"id":"1","method":"mapping.upsert","sessionToken":"correct","params":{params}}}"#,
            params = sample_mapping_json()
        );
        let response = handle_line(&upsert_line, "correct", Some(&store));
        assert_eq!(response["ok"], true);
        assert_eq!(response["result"]["id"], "mapping-1");

        let get_line =
            r#"{"id":"2","method":"mapping.get","sessionToken":"correct","params":{"id":"mapping-1"}}"#;
        let response = handle_line(get_line, "correct", Some(&store));
        assert_eq!(response["ok"], true);
        assert_eq!(response["result"]["id"], "mapping-1");
        assert_eq!(response["result"]["setupStatus"], "pending-approval");
    }

    #[test]
    fn mapping_get_returns_null_for_unknown_id() {
        let store = MappingStore::open_in_memory().expect("open store");
        let response = handle_line(
            r#"{"id":"1","method":"mapping.get","sessionToken":"correct","params":{"id":"missing"}}"#,
            "correct",
            Some(&store),
        );
        assert_eq!(response["ok"], true);
        assert!(response["result"].is_null());
    }

    #[test]
    fn mapping_list_and_delete_round_trip() {
        let store = MappingStore::open_in_memory().expect("open store");
        let upsert_line = format!(
            r#"{{"id":"1","method":"mapping.upsert","sessionToken":"correct","params":{params}}}"#,
            params = sample_mapping_json()
        );
        handle_line(&upsert_line, "correct", Some(&store));

        let list_response = handle_line(
            r#"{"id":"2","method":"mapping.list","sessionToken":"correct"}"#,
            "correct",
            Some(&store),
        );
        assert_eq!(list_response["result"].as_array().expect("array").len(), 1);

        let delete_response = handle_line(
            r#"{"id":"3","method":"mapping.delete","sessionToken":"correct","params":{"id":"mapping-1"}}"#,
            "correct",
            Some(&store),
        );
        assert_eq!(delete_response["result"]["deleted"], true);

        let list_after_delete = handle_line(
            r#"{"id":"4","method":"mapping.list","sessionToken":"correct"}"#,
            "correct",
            Some(&store),
        );
        assert_eq!(
            list_after_delete["result"].as_array().expect("array").len(),
            0
        );
    }

    #[test]
    fn mapping_upsert_rejects_malformed_params() {
        let store = MappingStore::open_in_memory().expect("open store");
        let response = handle_line(
            r#"{"id":"1","method":"mapping.upsert","sessionToken":"correct","params":{"id":"only-an-id"}}"#,
            "correct",
            Some(&store),
        );
        assert_eq!(response["ok"], false);
    }
}
