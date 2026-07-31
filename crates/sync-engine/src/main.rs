#![forbid(unsafe_code)]

use std::env;
use std::io::{self, BufRead, Write};

use serde_json::{Value, json};
use sync_protocol::{HealthResponse, ProtocolVersion, RpcRequest, RpcResponse};

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

    let stdin = io::stdin();
    let mut stdout = io::stdout().lock();

    for line in stdin.lock().lines() {
        let Ok(line) = line else {
            break;
        };
        if line.trim().is_empty() {
            continue;
        }

        let response = handle_line(&line, &expected_token);
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

fn handle_line(line: &str, expected_token: &str) -> Value {
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

    let method = request.method.clone();
    match method.as_str() {
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
        _ => serde_json::to_value(RpcResponse::<Value>::error(
            request.id,
            format!("Unknown method: {method}"),
        ))
        .expect("serialising an RPC error should not fail"),
    }
}

#[cfg(test)]
mod tests {
    use super::handle_line;

    #[test]
    fn health_requires_the_session_token() {
        let response = handle_line(
            r#"{"id":"1","method":"health","sessionToken":"wrong"}"#,
            "correct",
        );
        assert_eq!(response["ok"], false);
    }

    #[test]
    fn health_returns_protocol_metadata() {
        let response = handle_line(
            r#"{"id":"1","method":"health","sessionToken":"correct"}"#,
            "correct",
        );
        assert_eq!(response["ok"], true);
        assert_eq!(response["result"]["protocol"], "0.1");
    }
}
