#![forbid(unsafe_code)]

use std::env;
use std::io::{self, BufRead, Write};
use std::path::{Path, PathBuf};

use serde::Deserialize;
use serde::de::DeserializeOwned;
use serde_json::{Value, json};
use sync_core::manifest::{
    CompareOptions, FileManifest, Platform, SyncMode, compare_manifests, compute_sync_plan,
};
use sync_platform::scan::scan_folder;
use sync_protocol::{HealthResponse, MappingStoreHealth, ProtocolVersion, RpcRequest, RpcResponse};
use sync_storage::mapping::{MappingRecord, MappingStore, check_identifier};

/// Longest path `manifest.scan` will accept, so a malformed request cannot hand the walker an
/// unbounded string.
const MAX_SCAN_PATH_LENGTH: usize = 4096;

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

    // The store is opened once, on this thread, and every request is served from this loop, so
    // the non-`Sync` `rusqlite::Connection` inside it never crosses a thread boundary. Dropping
    // it when the loop ends closes the database and releases its WAL lock before the process
    // exits, so a restarted engine finds the file unlocked.
    let mapping_store = MappingStoreSlot::open();
    if let Some(detail) = mapping_store.startup_warning() {
        eprintln!("{detail}");
    }

    let stdin = io::stdin();
    let mut stdout = io::stdout().lock();

    for line in stdin.lock().lines() {
        let Ok(line) = line else {
            break;
        };
        if line.trim().is_empty() {
            continue;
        }

        let response = handle_line(&line, &expected_token, &mapping_store);
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

/// The mapping index, or the reason there isn't one.
///
/// Persistence is deliberately optional: a database that will not open must not stop the engine
/// from serving `health` or from running a scan, and must not stop the desktop shell from
/// pairing or approving a mapping. What it must not do is fail silently — the reason is kept
/// here and reported through `health` so the shell can say persistence is off rather than
/// letting the user believe an approval was durably recorded.
enum MappingStoreSlot {
    Ready(Box<MappingStore>),
    /// No `FOLDERSYNC_DATA_DIR`; nothing is being persisted this session.
    NotConfigured,
    /// A data directory was supplied but the database could not be opened.
    Unavailable(String),
}

impl MappingStoreSlot {
    /// Opens the mapping index under `FOLDERSYNC_DATA_DIR`, if the desktop shell provided one.
    fn open() -> Self {
        let Ok(data_dir) = env::var("FOLDERSYNC_DATA_DIR") else {
            return Self::NotConfigured;
        };
        if data_dir.trim().is_empty() {
            return Self::NotConfigured;
        }
        let db_path = PathBuf::from(data_dir).join("mappings.sqlite3");
        match MappingStore::open(&db_path) {
            Ok(store) => Self::Ready(Box::new(store)),
            Err(error) => Self::Unavailable(format!(
                "Failed to open the mapping index at {}: {error}",
                db_path.display()
            )),
        }
    }

    /// The store, or the message to hand back to a caller that needs one.
    fn store(&self) -> Result<&MappingStore, String> {
        match self {
            Self::Ready(store) => Ok(store),
            Self::NotConfigured => Err(
                "The mapping index is unavailable: no FOLDERSYNC_DATA_DIR was supplied, so nothing is being persisted."
                    .to_owned(),
            ),
            Self::Unavailable(detail) => {
                Err(format!("The mapping index is unavailable: {detail}"))
            }
        }
    }

    /// A line for stderr at startup when persistence is not working, or `None` when it is.
    fn startup_warning(&self) -> Option<String> {
        match self {
            Self::Ready(_) => None,
            Self::NotConfigured => Some(
                "FOLDERSYNC_DATA_DIR is not set: folder mappings will not be persisted this session."
                    .to_owned(),
            ),
            Self::Unavailable(detail) => {
                Some(format!("{detail} — folder mappings will not be persisted this session."))
            }
        }
    }

    fn health(&self) -> MappingStoreHealth {
        match self {
            Self::Ready(store) => MappingStoreHealth {
                status: "ready",
                detail: None,
                schema_version: store.schema_version().ok(),
                journal_mode: Some(store.journal_mode().to_owned()),
            },
            Self::NotConfigured => MappingStoreHealth::unusable(
                "not-configured",
                "No FOLDERSYNC_DATA_DIR was supplied, so mappings are not being persisted.",
            ),
            Self::Unavailable(detail) => {
                MappingStoreHealth::unusable("unavailable", detail.clone())
            }
        }
    }
}

/// Deserialises a method's parameters, turning both "missing" and "wrong shape" into the
/// structured error the caller gets back.
fn parse_params<T: DeserializeOwned>(params: Option<Value>, method: &str) -> Result<T, String> {
    let Some(params) = params else {
        return Err(format!("{method} requires params"));
    };
    serde_json::from_value(params).map_err(|error| format!("Invalid params for {method}: {error}"))
}

fn handle_line(line: &str, expected_token: &str, mapping_store: &MappingStoreSlot) -> Value {
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
                mapping_store: mapping_store.health(),
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
        "manifest.scan" => handle_manifest_scan(request),
        "manifest.compare" => handle_manifest_compare(request),
        "plan.build" => handle_plan_build(request),
        other => serde_json::to_value(RpcResponse::<Value>::error(
            request.id,
            format!("Unknown method: {other}"),
        ))
        .expect("serialising an RPC error should not fail"),
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
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

/// Pulls a validated mapping id out of a request's params.
fn mapping_id(params: Option<Value>, method: &str) -> Result<String, String> {
    let params: MappingIdParams = parse_params(params, method)?;
    check_identifier("id", &params.id)
        .map_err(|error| format!("Invalid params for {method}: {error}"))?;
    Ok(params.id)
}

fn handle_mapping_upsert(request: RpcRequest, mapping_store: &MappingStoreSlot) -> Value {
    let store = match mapping_store.store() {
        Ok(store) => store,
        Err(message) => return error_response(request.id, message),
    };
    let record: MappingRecord = match parse_params(request.params, "mapping.upsert") {
        Ok(record) => record,
        Err(message) => return error_response(request.id, message),
    };
    match store.upsert(&record) {
        Ok(()) => success_response(request.id, record),
        Err(store_error) => error_response(
            request.id,
            format!("Failed to store mapping: {store_error}"),
        ),
    }
}

fn handle_mapping_get(request: RpcRequest, mapping_store: &MappingStoreSlot) -> Value {
    let store = match mapping_store.store() {
        Ok(store) => store,
        Err(message) => return error_response(request.id, message),
    };
    let id = match mapping_id(request.params, "mapping.get") {
        Ok(id) => id,
        Err(message) => return error_response(request.id, message),
    };
    match store.get(&id) {
        Ok(record) => success_response(request.id, record),
        Err(store_error) => {
            error_response(request.id, format!("Failed to read mapping: {store_error}"))
        }
    }
}

fn handle_mapping_list(request: RpcRequest, mapping_store: &MappingStoreSlot) -> Value {
    let store = match mapping_store.store() {
        Ok(store) => store,
        Err(message) => return error_response(request.id, message),
    };
    match store.list() {
        Ok(records) => success_response(request.id, records),
        Err(store_error) => error_response(
            request.id,
            format!("Failed to list mappings: {store_error}"),
        ),
    }
}

fn handle_mapping_list_pending_delivery(
    request: RpcRequest,
    mapping_store: &MappingStoreSlot,
) -> Value {
    let store = match mapping_store.store() {
        Ok(store) => store,
        Err(message) => return error_response(request.id, message),
    };
    match store.list_pending_delivery() {
        Ok(records) => success_response(request.id, records),
        Err(store_error) => error_response(
            request.id,
            format!("Failed to list pending mappings: {store_error}"),
        ),
    }
}

fn handle_mapping_delete(request: RpcRequest, mapping_store: &MappingStoreSlot) -> Value {
    let store = match mapping_store.store() {
        Ok(store) => store,
        Err(message) => return error_response(request.id, message),
    };
    let id = match mapping_id(request.params, "mapping.delete") {
        Ok(id) => id,
        Err(message) => return error_response(request.id, message),
    };
    // Removes only this index row. Nothing under the mapped folder is touched.
    match store.delete(&id) {
        Ok(deleted) => success_response(request.id, json!({ "deleted": deleted })),
        Err(store_error) => error_response(
            request.id,
            format!("Failed to delete mapping: {store_error}"),
        ),
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ManifestScanParams {
    path: String,
    #[serde(default)]
    ignore_patterns: Vec<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ManifestCompareParams {
    local: FileManifest,
    remote: FileManifest,
    mode: SyncMode,
    local_platform: Platform,
    remote_platform: Platform,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PlanBuildParams {
    local: FileManifest,
    remote: FileManifest,
    mode: SyncMode,
}

/// Reads a folder into a manifest.
///
/// The engine is a child process of this machine's own desktop shell, talking over an inherited
/// stdio pipe and gated on the session token checked in `handle_line`, so it is not a network
/// surface — it can only ever read what the user running the app could already read. It is
/// still a broad read, so the path is bounded and required to be absolute rather than resolved
/// against whatever working directory the engine happened to inherit. The scan itself is
/// strictly read-only and never follows a symlink out of the folder it was given.
fn handle_manifest_scan(request: RpcRequest) -> Value {
    let params: ManifestScanParams = match parse_params(request.params, "manifest.scan") {
        Ok(params) => params,
        Err(message) => return error_response(request.id, message),
    };
    if params.path.trim().is_empty() {
        return error_response(request.id, "manifest.scan requires a non-empty path");
    }
    if params.path.len() > MAX_SCAN_PATH_LENGTH {
        return error_response(
            request.id,
            format!("manifest.scan path must be at most {MAX_SCAN_PATH_LENGTH} characters"),
        );
    }
    let path = Path::new(&params.path);
    if !path.is_absolute() {
        return error_response(
            request.id,
            "manifest.scan requires an absolute path so it never resolves against the engine's working directory",
        );
    }
    match scan_folder(path, &params.ignore_patterns) {
        Ok(manifest) => success_response(request.id, manifest),
        Err(scan_error) => {
            error_response(request.id, format!("Failed to scan folder: {scan_error}"))
        }
    }
}

fn handle_manifest_compare(request: RpcRequest) -> Value {
    let params: ManifestCompareParams = match parse_params(request.params, "manifest.compare") {
        Ok(params) => params,
        Err(message) => return error_response(request.id, message),
    };
    let options = CompareOptions {
        mode: params.mode,
        local_platform: params.local_platform,
        remote_platform: params.remote_platform,
    };
    let preview = compare_manifests(&params.local, &params.remote, options);
    success_response(request.id, preview)
}

fn handle_plan_build(request: RpcRequest) -> Value {
    let params: PlanBuildParams = match parse_params(request.params, "plan.build") {
        Ok(params) => params,
        Err(message) => return error_response(request.id, message),
    };
    let plan = compute_sync_plan(&params.local, &params.remote, params.mode);
    success_response(request.id, plan)
}

#[cfg(test)]
mod tests {
    use super::{MappingStoreSlot, handle_line};
    use sync_storage::mapping::{MappingStore, SCHEMA_VERSION};

    /// A slot backed by a real in-memory database.
    fn ready_store() -> MappingStoreSlot {
        MappingStoreSlot::Ready(Box::new(
            MappingStore::open_in_memory().expect("open in-memory store"),
        ))
    }

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

    /// Builds a request line with the given method and raw JSON params.
    fn request(method: &str, params: &str) -> String {
        format!(r#"{{"id":"1","method":"{method}","sessionToken":"correct","params":{params}}}"#)
    }

    #[test]
    fn health_requires_the_session_token() {
        let response = handle_line(
            r#"{"id":"1","method":"health","sessionToken":"wrong"}"#,
            "correct",
            &MappingStoreSlot::NotConfigured,
        );
        assert_eq!(response["ok"], false);
    }

    #[test]
    fn every_mapping_method_requires_the_session_token() {
        let store = ready_store();
        for method in [
            "mapping.upsert",
            "mapping.get",
            "mapping.list",
            "mapping.listPendingDelivery",
            "mapping.delete",
            "manifest.scan",
            "manifest.compare",
            "plan.build",
        ] {
            let line = format!(
                r#"{{"id":"1","method":"{method}","sessionToken":"wrong","params":{}}}"#,
                sample_mapping_json()
            );
            let response = handle_line(&line, "correct", &store);
            assert_eq!(
                response["ok"], false,
                "{method} must reject a bad session token"
            );
            assert_eq!(
                response["error"], "Invalid RPC session token.",
                "{method} must fail on the token before it looks at anything else"
            );
        }
        // The rejected upsert must not have reached the database.
        let listed = handle_line(
            r#"{"id":"2","method":"mapping.list","sessionToken":"correct"}"#,
            "correct",
            &store,
        );
        assert_eq!(listed["result"].as_array().expect("array").len(), 0);
    }

    #[test]
    fn a_missing_session_token_is_rejected() {
        let response = handle_line(
            r#"{"id":"1","method":"mapping.list"}"#,
            "correct",
            &ready_store(),
        );
        assert_eq!(response["ok"], false);
    }

    #[test]
    fn health_returns_protocol_metadata() {
        let response = handle_line(
            r#"{"id":"1","method":"health","sessionToken":"correct"}"#,
            "correct",
            &MappingStoreSlot::NotConfigured,
        );
        assert_eq!(response["ok"], true);
        assert_eq!(response["result"]["protocol"], "0.1");
    }

    #[test]
    fn health_reports_a_working_mapping_store() {
        let response = handle_line(
            r#"{"id":"1","method":"health","sessionToken":"correct"}"#,
            "correct",
            &ready_store(),
        );
        assert_eq!(response["result"]["mappingStore"]["status"], "ready");
        assert_eq!(
            response["result"]["mappingStore"]["schemaVersion"],
            SCHEMA_VERSION
        );
        // In-memory databases report `memory`; an on-disk one reports `wal`.
        assert_eq!(response["result"]["mappingStore"]["journalMode"], "memory");
    }

    #[test]
    fn health_admits_when_nothing_is_being_persisted() {
        let response = handle_line(
            r#"{"id":"1","method":"health","sessionToken":"correct"}"#,
            "correct",
            &MappingStoreSlot::NotConfigured,
        );
        assert_eq!(
            response["result"]["mappingStore"]["status"],
            "not-configured"
        );
        assert!(
            response["result"]["mappingStore"]["detail"].is_string(),
            "the shell needs a reason it can show, not just a status"
        );
    }

    #[test]
    fn health_admits_when_the_database_could_not_be_opened() {
        let slot = MappingStoreSlot::Unavailable("disk is on fire".to_owned());
        let response = handle_line(
            r#"{"id":"1","method":"health","sessionToken":"correct"}"#,
            "correct",
            &slot,
        );
        assert_eq!(response["result"]["mappingStore"]["status"], "unavailable");
        assert!(
            response["result"]["mappingStore"]["detail"]
                .as_str()
                .expect("detail")
                .contains("disk is on fire")
        );
        assert!(response["result"]["mappingStore"]["schemaVersion"].is_null());
    }

    #[test]
    fn unknown_method_still_errors() {
        let response = handle_line(
            r#"{"id":"1","method":"nope","sessionToken":"correct"}"#,
            "correct",
            &MappingStoreSlot::NotConfigured,
        );
        assert_eq!(response["ok"], false);
    }

    #[test]
    fn no_method_exposes_raw_sql() {
        let response = handle_line(
            r#"{"id":"1","method":"mapping.query","sessionToken":"correct","params":{"sql":"SELECT 1"}}"#,
            "correct",
            &ready_store(),
        );
        assert_eq!(response["ok"], false);
        assert!(
            response["error"]
                .as_str()
                .expect("error")
                .starts_with("Unknown method")
        );
    }

    #[test]
    fn a_sql_shaped_mapping_id_is_treated_as_a_literal_id() {
        let store = ready_store();
        handle_line(
            &request("mapping.upsert", sample_mapping_json()),
            "correct",
            &store,
        );

        let response = handle_line(
            &request(
                "mapping.delete",
                r#"{"id":"x'; DROP TABLE folder_mappings; --"}"#,
            ),
            "correct",
            &store,
        );
        assert_eq!(response["ok"], true);
        assert_eq!(
            response["result"]["deleted"], false,
            "no row has that literal id"
        );

        let listed = handle_line(
            r#"{"id":"2","method":"mapping.list","sessionToken":"correct"}"#,
            "correct",
            &store,
        );
        assert_eq!(
            listed["result"].as_array().expect("array").len(),
            1,
            "the table must still be there with its row"
        );
    }

    #[test]
    fn mapping_methods_report_an_unavailable_store() {
        for method in [
            "mapping.list",
            "mapping.listPendingDelivery",
            "mapping.get",
            "mapping.delete",
            "mapping.upsert",
        ] {
            let line = format!(
                r#"{{"id":"1","method":"{method}","sessionToken":"correct","params":{{"id":"mapping-1"}}}}"#
            );
            let response = handle_line(&line, "correct", &MappingStoreSlot::NotConfigured);
            assert_eq!(
                response["ok"], false,
                "{method} should fail without a store"
            );
            assert!(
                response["error"]
                    .as_str()
                    .expect("error")
                    .contains("unavailable"),
                "{method} should say the index is unavailable, got {:?}",
                response["error"]
            );
        }
    }

    #[test]
    fn mapping_upsert_then_get_round_trips() {
        let store = ready_store();
        let response = handle_line(
            &request("mapping.upsert", sample_mapping_json()),
            "correct",
            &store,
        );
        assert_eq!(response["ok"], true);
        assert_eq!(response["result"]["id"], "mapping-1");

        let response = handle_line(
            &request("mapping.get", r#"{"id":"mapping-1"}"#),
            "correct",
            &store,
        );
        assert_eq!(response["ok"], true);
        assert_eq!(response["result"]["id"], "mapping-1");
        assert_eq!(response["result"]["setupStatus"], "pending-approval");
    }

    #[test]
    fn mapping_paths_round_trip_unchanged_for_both_platforms() {
        let store = ready_store();
        handle_line(
            &request("mapping.upsert", sample_mapping_json()),
            "correct",
            &store,
        );

        let response = handle_line(
            &request("mapping.get", r#"{"id":"mapping-1"}"#),
            "correct",
            &store,
        );
        assert_eq!(response["result"]["initiatorPath"], "/home/tommy/Projects");
        assert_eq!(
            response["result"]["responderPath"], "C:\\Users\\tommy\\Projects",
            "a Windows path must survive the round trip with its backslashes"
        );
    }

    #[test]
    fn mapping_get_returns_null_for_unknown_id() {
        let response = handle_line(
            &request("mapping.get", r#"{"id":"missing"}"#),
            "correct",
            &ready_store(),
        );
        assert_eq!(response["ok"], true);
        assert!(response["result"].is_null());
    }

    #[test]
    fn mapping_list_and_delete_round_trip() {
        let store = ready_store();
        handle_line(
            &request("mapping.upsert", sample_mapping_json()),
            "correct",
            &store,
        );

        let list_response = handle_line(
            r#"{"id":"2","method":"mapping.list","sessionToken":"correct"}"#,
            "correct",
            &store,
        );
        assert_eq!(list_response["result"].as_array().expect("array").len(), 1);

        let delete_response = handle_line(
            &request("mapping.delete", r#"{"id":"mapping-1"}"#),
            "correct",
            &store,
        );
        assert_eq!(delete_response["result"]["deleted"], true);

        let list_after_delete = handle_line(
            r#"{"id":"4","method":"mapping.list","sessionToken":"correct"}"#,
            "correct",
            &store,
        );
        assert_eq!(
            list_after_delete["result"].as_array().expect("array").len(),
            0
        );
    }

    #[test]
    fn deleting_a_missing_mapping_succeeds_and_reports_that_nothing_was_removed() {
        let response = handle_line(
            &request("mapping.delete", r#"{"id":"never-existed"}"#),
            "correct",
            &ready_store(),
        );
        assert_eq!(response["ok"], true);
        assert_eq!(response["result"]["deleted"], false);
    }

    #[test]
    fn mapping_list_pending_delivery_filters_to_pending_records() {
        let store = ready_store();
        handle_line(
            &request("mapping.upsert", sample_mapping_json()),
            "correct",
            &store,
        );

        let pending = sample_mapping_json()
            .replace("mapping-1", "mapping-2")
            .replace(r#""pendingDelivery": false"#, r#""pendingDelivery": true"#);
        handle_line(&request("mapping.upsert", &pending), "correct", &store);

        let response = handle_line(
            r#"{"id":"3","method":"mapping.listPendingDelivery","sessionToken":"correct"}"#,
            "correct",
            &store,
        );
        let records = response["result"].as_array().expect("array");
        assert_eq!(records.len(), 1);
        assert_eq!(records[0]["id"], "mapping-2");
    }

    #[test]
    fn mapping_upsert_rejects_invalid_payloads() {
        let store = ready_store();
        let cases: [(&str, &str); 8] = [
            ("missing most fields", r#"{"id":"only-an-id"}"#),
            ("not an object", r"[1,2,3]"),
            ("null", r"null"),
            (
                "empty id",
                &sample_mapping_json().replace(r#""id": "mapping-1""#, r#""id": """#),
            ),
            (
                "unknown mode",
                &sample_mapping_json().replace(r#""mode": "two-way""#, r#""mode": "sideways""#),
            ),
            (
                "negative history days",
                &sample_mapping_json().replace(r#""historyDays": 30"#, r#""historyDays": -5"#),
            ),
            (
                "absurd history limit",
                &sample_mapping_json().replace(r#""historyDays": 30"#, r#""historyDays": 99999"#),
            ),
            (
                "history days of the wrong type",
                &sample_mapping_json()
                    .replace(r#""historyDays": 30"#, r#""historyDays": "thirty""#),
            ),
        ];

        for (label, params) in cases {
            let response = handle_line(&request("mapping.upsert", params), "correct", &store);
            assert_eq!(response["ok"], false, "{label} should be rejected");
            assert!(
                response["error"].is_string(),
                "{label} should come back with a structured error message"
            );
        }

        let listed = handle_line(
            r#"{"id":"9","method":"mapping.list","sessionToken":"correct"}"#,
            "correct",
            &store,
        );
        assert_eq!(
            listed["result"].as_array().expect("array").len(),
            0,
            "no invalid payload should have been stored"
        );
    }

    #[test]
    fn mapping_id_methods_reject_blank_and_malformed_ids() {
        let store = ready_store();
        for method in ["mapping.get", "mapping.delete"] {
            for params in [
                r#"{"id":""}"#,
                r#"{"id":"   "}"#,
                r#"{"id":123}"#,
                r"{}",
                r#"{"identifier":"mapping-1"}"#,
                r#"{"id":"mapping-1","extra":"unexpected"}"#,
            ] {
                let response = handle_line(&request(method, params), "correct", &store);
                assert_eq!(
                    response["ok"], false,
                    "{method} should reject params {params}"
                );
            }
        }
    }

    #[test]
    fn mapping_methods_require_params_when_they_take_them() {
        let store = ready_store();
        for method in ["mapping.get", "mapping.delete", "mapping.upsert"] {
            let line = format!(r#"{{"id":"1","method":"{method}","sessionToken":"correct"}}"#);
            let response = handle_line(&line, "correct", &store);
            assert_eq!(response["ok"], false, "{method} should require params");
            assert!(
                response["error"]
                    .as_str()
                    .expect("error")
                    .contains("requires params")
            );
        }
    }

    #[test]
    fn a_malformed_request_line_does_not_crash_the_loop() {
        for line in ["not json at all", "{", r#"{"id":"1"}"#, "[]"] {
            let response = handle_line(line, "correct", &ready_store());
            assert_eq!(response["ok"], false, "{line} should be rejected");
            assert!(response["error"].is_string());
        }
    }

    #[test]
    fn manifest_scan_finds_and_hashes_a_real_file() {
        let root = tempfile::tempdir().expect("create tempdir");
        std::fs::write(root.path().join("hello.txt"), b"hello").expect("write file");
        let params = format!(
            r#"{{"path":{path},"ignorePatterns":[]}}"#,
            path = serde_json::to_string(&root.path().to_string_lossy()).expect("serialise path")
        );

        let response = handle_line(
            &request("manifest.scan", &params),
            "correct",
            &MappingStoreSlot::NotConfigured,
        );

        assert_eq!(response["ok"], true);
        let files = response["result"]["files"].as_array().expect("files array");
        assert_eq!(files.len(), 1);
        assert_eq!(files[0]["path"], "hello.txt");
        assert!(files[0]["digest"].is_string());
    }

    #[test]
    fn manifest_scan_errors_for_a_missing_path() {
        let response = handle_line(
            &request(
                "manifest.scan",
                r#"{"path":"/does/not/exist","ignorePatterns":[]}"#,
            ),
            "correct",
            &MappingStoreSlot::NotConfigured,
        );
        assert_eq!(response["ok"], false);
    }

    #[test]
    fn manifest_scan_rejects_empty_and_relative_paths() {
        for params in [
            r#"{"path":""}"#,
            r#"{"path":"   "}"#,
            r#"{"path":"relative/folder"}"#,
            r#"{"path":"../../etc"}"#,
            r#"{"path":123}"#,
            r"{}",
        ] {
            let response = handle_line(
                &request("manifest.scan", params),
                "correct",
                &MappingStoreSlot::NotConfigured,
            );
            assert_eq!(response["ok"], false, "{params} should be rejected");
        }
    }

    fn manifest_json(files: &str) -> String {
        format!(
            r#"{{"rootPath":"/tmp","files":[{files}],"ignored":0,"unreadable":0,"truncated":false}}"#
        )
    }

    #[test]
    fn manifest_compare_classifies_local_and_remote_only_files() {
        let local = manifest_json(r#"{"path":"only-local.txt","size":5,"modifiedMs":1}"#);
        let remote = manifest_json(r#"{"path":"only-remote.txt","size":7,"modifiedMs":1}"#);
        let params = format!(
            r#"{{"local":{local},"remote":{remote},"mode":"two-way","localPlatform":"linux","remotePlatform":"linux"}}"#
        );

        let response = handle_line(
            &request("manifest.compare", &params),
            "correct",
            &MappingStoreSlot::NotConfigured,
        );

        assert_eq!(response["ok"], true);
        assert_eq!(response["result"]["localOnlyFiles"], 1);
        assert_eq!(response["result"]["remoteOnlyFiles"], 1);
    }

    #[test]
    fn manifest_compare_rejects_an_unknown_mode() {
        let manifest = manifest_json("");
        let params = format!(
            r#"{{"local":{manifest},"remote":{manifest},"mode":"sideways","localPlatform":"linux","remotePlatform":"linux"}}"#
        );

        let response = handle_line(
            &request("manifest.compare", &params),
            "correct",
            &MappingStoreSlot::NotConfigured,
        );
        assert_eq!(response["ok"], false);
    }

    #[test]
    fn plan_build_pulls_remote_only_files() {
        let local = manifest_json("");
        let remote = manifest_json(r#"{"path":"new.txt","size":5,"modifiedMs":1,"digest":"abc"}"#);
        let params = format!(r#"{{"local":{local},"remote":{remote},"mode":"two-way"}}"#);

        let response = handle_line(
            &request("plan.build", &params),
            "correct",
            &MappingStoreSlot::NotConfigured,
        );

        assert_eq!(response["ok"], true);
        let to_pull = response["result"]["toPull"]
            .as_array()
            .expect("toPull array");
        assert_eq!(to_pull.len(), 1);
        assert_eq!(to_pull[0]["path"], "new.txt");
    }

    #[test]
    fn an_engine_reopening_a_database_finds_the_previous_sessions_rows() {
        let directory = tempfile::tempdir().expect("tempdir");
        let path = directory.path().join("mappings.sqlite3");

        let first = MappingStoreSlot::Ready(Box::new(
            MappingStore::open(&path).expect("open first session"),
        ));
        handle_line(
            &request("mapping.upsert", sample_mapping_json()),
            "correct",
            &first,
        );
        // Ending the session drops the connection and releases the database.
        drop(first);

        let second = MappingStoreSlot::Ready(Box::new(
            MappingStore::open(&path).expect("a released database must reopen cleanly"),
        ));
        let response = handle_line(
            &request("mapping.get", r#"{"id":"mapping-1"}"#),
            "correct",
            &second,
        );
        assert_eq!(response["result"]["id"], "mapping-1");
    }
}
