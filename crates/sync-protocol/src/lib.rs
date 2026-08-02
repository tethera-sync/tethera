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
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RpcRequest {
    pub id: String,
    pub method: String,
    #[serde(default)]
    pub params: Option<Value>,
    pub session_token: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
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
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error_code: Option<String>,
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
            error_code: None,
        }
    }

    pub fn error(id: String, error: impl Into<String>) -> Self {
        Self::error_with_code(id, "RPC_ERROR", error)
    }

    pub fn error_with_code(
        id: String,
        error_code: impl Into<String>,
        error: impl Into<String>,
    ) -> Self {
        Self {
            id,
            ok: false,
            result: None,
            error: Some(error.into()),
            error_code: Some(error_code.into()),
        }
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HealthResponse {
    pub name: &'static str,
    pub version: &'static str,
    pub protocol: String,
    /// Whether the authoritative mapping database is usable in this session. The desktop uses
    /// this state to gate reads and mutations instead of treating an unavailable store as empty.
    pub mapping_store: MappingStoreHealth,
}

/// Reported state of the engine's `SQLite` mapping index.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MappingStoreHealth {
    /// `ready` — open, writable and imported. Other values identify an explicit unavailable,
    /// unsupported-schema or migration state; mapping reads and mutations then fail closed.
    pub status: &'static str,
    /// Why the store is unusable, when it is.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
    /// Schema version of the open database.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub schema_version: Option<i64>,
    /// Journal mode actually in force — `wal` for a healthy on-disk database.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub journal_mode: Option<String>,
    /// One-time `state.json` import state. Mapping reads and mutations remain disabled until this
    /// says `completed`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub migration_state: Option<String>,
    /// Whether mapping writes can safely commit in this engine session.
    pub mutations_enabled: bool,
}

impl MappingStoreHealth {
    #[must_use]
    pub fn unusable(status: &'static str, detail: impl Into<String>) -> Self {
        Self {
            status,
            detail: Some(detail.into()),
            schema_version: None,
            journal_mode: None,
            migration_state: None,
            mutations_enabled: false,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{ProtocolVersion, RpcRequest, RpcResponse};

    #[test]
    fn parses_camel_case_session_token() {
        let request: RpcRequest =
            serde_json::from_str(r#"{"id":"1","method":"health","sessionToken":"secret"}"#)
                .expect("request should parse");

        assert_eq!(request.id, "1");
        assert_eq!(request.method, "health");
        assert_eq!(request.session_token, "secret");
    }

    #[test]
    fn protocol_version_has_stable_display() {
        assert_eq!(ProtocolVersion::default().to_string(), "0.1");
    }

    #[test]
    fn structured_errors_use_the_camel_case_wire_contract() {
        let value = serde_json::to_value(RpcResponse::<serde_json::Value>::error_with_code(
            "1".to_owned(),
            "MAPPING_NOT_FOUND",
            "missing",
        ))
        .expect("serialise response");

        assert_eq!(value["errorCode"], "MAPPING_NOT_FOUND");
        assert!(value.get("error_code").is_none());
    }
}
