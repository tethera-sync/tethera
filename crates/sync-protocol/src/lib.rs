//! Shared protocol types used between the desktop shell and sync engine.
#![forbid(unsafe_code)]

use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProtocolVersion {
    pub major: u16,
    pub minor: u16,
}

impl Default for ProtocolVersion {
    fn default() -> Self {
        Self { major: 0, minor: 1 }
    }
}

impl std::fmt::Display for ProtocolVersion {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(formatter, "{}.{}", self.major, self.minor)
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RpcRequest {
    pub id: String,
    pub method: String,
    #[serde(default)]
    pub params: Option<Value>,
    pub session_token: String,
}

#[derive(Debug, Serialize)]
pub struct RpcResponse<T>
where
    T: Serialize,
{
    pub id: String,
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<T>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

impl<T> RpcResponse<T>
where
    T: Serialize,
{
    pub fn success(id: String, result: T) -> Self {
        Self {
            id,
            ok: true,
            result: Some(result),
            error: None,
        }
    }

    pub fn error(id: String, error: impl Into<String>) -> Self {
        Self {
            id,
            ok: false,
            result: None,
            error: Some(error.into()),
        }
    }
}

#[derive(Debug, Serialize)]
pub struct HealthResponse {
    pub name: &'static str,
    pub version: &'static str,
    pub protocol: String,
}

#[cfg(test)]
mod tests {
    use super::{ProtocolVersion, RpcRequest};

    #[test]
    fn parses_camel_case_session_token() {
        let request: RpcRequest = serde_json::from_str(
            r#"{"id":"1","method":"health","sessionToken":"secret"}"#,
        )
        .expect("request should parse");

        assert_eq!(request.id, "1");
        assert_eq!(request.method, "health");
        assert_eq!(request.session_token, "secret");
    }

    #[test]
    fn protocol_version_has_stable_display() {
        assert_eq!(ProtocolVersion::default().to_string(), "0.1");
    }
}
