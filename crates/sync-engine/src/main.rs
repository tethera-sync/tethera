#![forbid(unsafe_code)]

use std::env;
use std::ffi::OsString;
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
use sync_storage::mapping::{
    LegacyImportRequest, LegacyMigrationState, MappingConfiguration, MappingEvent, MappingStore,
    MappingStoreError, check_identifier,
};

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

const TETHERA_DATA_DIR: &str = "TETHERA_DATA_DIR";
const LEGACY_DATA_DIR: &str = "FOLDERSYNC_DATA_DIR";

/// The authoritative mapping database, or a typed reason why it cannot be used.
enum MappingStoreSlot {
    Ready(Box<MappingStore>),
    NotConfigured,
    Unavailable {
        status: &'static str,
        detail: String,
        schema_version: Option<i64>,
    },
}

struct DataDirectorySelection {
    path: Option<PathBuf>,
    used_legacy_name: bool,
}

fn select_data_directory(
    tethera: Option<OsString>,
    legacy: Option<OsString>,
) -> DataDirectorySelection {
    let usable = |value: OsString| {
        if value.to_string_lossy().trim().is_empty() {
            None
        } else {
            Some(PathBuf::from(value))
        }
    };
    if let Some(path) = tethera.and_then(usable) {
        return DataDirectorySelection {
            path: Some(path),
            used_legacy_name: false,
        };
    }
    if let Some(path) = legacy.and_then(usable) {
        return DataDirectorySelection {
            path: Some(path),
            used_legacy_name: true,
        };
    }
    DataDirectorySelection {
        path: None,
        used_legacy_name: false,
    }
}

struct RpcFailure {
    code: &'static str,
    message: String,
}

impl MappingStoreSlot {
    fn open() -> Self {
        let selection =
            select_data_directory(env::var_os(TETHERA_DATA_DIR), env::var_os(LEGACY_DATA_DIR));
        let Some(data_dir) = selection.path else {
            return Self::NotConfigured;
        };
        if selection.used_legacy_name {
            eprintln!(
                "{LEGACY_DATA_DIR} is deprecated; set {TETHERA_DATA_DIR} instead. The existing data directory is still being used."
            );
        }
        let db_path = data_dir.join("mappings.sqlite3");
        match MappingStore::open(&db_path) {
            Ok(store) => Self::Ready(Box::new(store)),
            Err(MappingStoreError::UnsupportedSchemaVersion { found }) => Self::Unavailable {
                status: "unsupported-schema",
                detail: format!(
                    "The mapping database uses schema version {found}, newer than this Tethera build supports. Upgrade Tethera before changing mappings."
                ),
                schema_version: Some(found),
            },
            Err(MappingStoreError::SchemaMigration(detail)) => Self::Unavailable {
                status: "migration-failed",
                detail: format!("The mapping database schema migration did not commit: {detail}"),
                schema_version: None,
            },
            Err(error) => Self::Unavailable {
                status: "unavailable",
                detail: format!("Failed to open the authoritative mapping database: {error}"),
                schema_version: None,
            },
        }
    }

    fn store(&self) -> Result<&MappingStore, RpcFailure> {
        match self {
            Self::Ready(store) => Ok(store),
            Self::NotConfigured => Err(RpcFailure {
                code: "MAPPING_STORE_NOT_CONFIGURED",
                message: format!(
                    "The mapping database is unavailable: no {TETHERA_DATA_DIR} was supplied."
                ),
            }),
            Self::Unavailable { status, detail, .. } => Err(RpcFailure {
                code: match *status {
                    "unsupported-schema" => "MAPPING_STORE_UNSUPPORTED_SCHEMA",
                    "migration-failed" => "MAPPING_STORE_MIGRATION_FAILED",
                    _ => "MAPPING_STORE_UNAVAILABLE",
                },
                message: detail.clone(),
            }),
        }
    }

    fn startup_warning(&self) -> Option<String> {
        match self {
            Self::Ready(_) => None,
            Self::NotConfigured => Some(format!(
                "{TETHERA_DATA_DIR} is not set: the authoritative mapping database is unavailable and mapping mutations are disabled."
            )),
            Self::Unavailable { detail, .. } => Some(format!(
                "{detail} Mapping mutations are disabled; no mapping is being treated as deleted or empty."
            )),
        }
    }

    fn health(&self) -> MappingStoreHealth {
        match self {
            Self::Ready(store) => match store.legacy_migration_status() {
                Ok(migration) => MappingStoreHealth {
                    status: "ready",
                    detail: migration.last_error,
                    schema_version: store.schema_version().ok(),
                    journal_mode: Some(store.journal_mode().to_owned()),
                    migration_state: Some(
                        match migration.state {
                            LegacyMigrationState::Pending => "pending",
                            LegacyMigrationState::Completed => "completed",
                            LegacyMigrationState::Failed => "failed",
                        }
                        .to_owned(),
                    ),
                    mutations_enabled: migration.state == LegacyMigrationState::Completed,
                },
                Err(error) => MappingStoreHealth {
                    status: "unavailable",
                    detail: Some(format!("Mapping-store metadata is unreadable: {error}")),
                    schema_version: store.schema_version().ok(),
                    journal_mode: Some(store.journal_mode().to_owned()),
                    migration_state: Some("failed".to_owned()),
                    mutations_enabled: false,
                },
            },
            Self::NotConfigured => MappingStoreHealth::unusable(
                "not-configured",
                format!("No {TETHERA_DATA_DIR} was supplied."),
            ),
            Self::Unavailable {
                status,
                detail,
                schema_version,
            } => {
                let mut health = MappingStoreHealth::unusable(status, detail.clone());
                health.schema_version = *schema_version;
                health
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
                "errorCode": "INVALID_REQUEST",
                "error": format!("Invalid request: {error}")
            });
        }
    };

    if request.session_token != expected_token {
        return serde_json::to_value(RpcResponse::<Value>::error_with_code(
            request.id,
            "AUTHENTICATION_FAILED",
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
        "mapping.remove" => handle_mapping_remove(request, mapping_store),
        "mapping.applyRemote" => handle_mapping_apply_remote(request, mapping_store),
        "mapping.acknowledgeDelivery" => {
            handle_mapping_acknowledge_delivery(request, mapping_store)
        }
        "mapping.getMigrationStatus" => handle_mapping_get_migration_status(request, mapping_store),
        "mapping.importLegacy" => handle_mapping_import_legacy(request, mapping_store),
        "mapping.recordMigrationFailure" => {
            handle_mapping_record_migration_failure(request, mapping_store)
        }
        "manifest.scan" => handle_manifest_scan(request),
        "manifest.compare" => handle_manifest_compare(request),
        "plan.build" => handle_plan_build(request),
        other => serde_json::to_value(RpcResponse::<Value>::error_with_code(
            request.id,
            "METHOD_NOT_FOUND",
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
    error_response_with_code(id, "RPC_ERROR", message)
}

fn error_response_with_code(
    id: String,
    code: impl Into<String>,
    message: impl Into<String>,
) -> Value {
    serde_json::to_value(RpcResponse::<Value>::error_with_code(id, code, message))
        .expect("serialising an RPC error response should not fail")
}

fn rpc_failure_response(id: String, failure: RpcFailure) -> Value {
    error_response_with_code(id, failure.code, failure.message)
}

fn store_error_response(id: String, context: &str, error: &MappingStoreError) -> Value {
    error_response_with_code(id, mapping_error_code(error), format!("{context}: {error}"))
}

fn mapping_error_code(error: &MappingStoreError) -> &'static str {
    match error {
        MappingStoreError::Database(_) => "MAPPING_STORE_UNAVAILABLE",
        MappingStoreError::Serialisation(_)
        | MappingStoreError::CorruptRecord { .. }
        | MappingStoreError::CorruptMetadata { .. } => "MAPPING_STORE_CORRUPT",
        MappingStoreError::UnsupportedSchemaVersion { .. } => "MAPPING_STORE_UNSUPPORTED_SCHEMA",
        MappingStoreError::SchemaMigration(_) => "MAPPING_STORE_MIGRATION_FAILED",
        MappingStoreError::MigrationRequired => "MAPPING_MIGRATION_REQUIRED",
        MappingStoreError::MigrationFailed(_) => "MAPPING_MIGRATION_FAILED",
        MappingStoreError::LegacyImportAlreadyCompleted => "LEGACY_IMPORT_ALREADY_COMPLETED",
        MappingStoreError::DuplicateMappingId(_) => "LEGACY_IMPORT_DUPLICATE_ID",
        MappingStoreError::Tombstoned(_) => "MAPPING_TOMBSTONED",
        MappingStoreError::NotFound(_) => "MAPPING_NOT_FOUND",
        MappingStoreError::StaleRevision { .. } => "MAPPING_STALE_REVISION",
        MappingStoreError::InvalidParticipant(_) => "MAPPING_INVALID_PARTICIPANT",
        MappingStoreError::AcknowledgementMismatch => "MAPPING_ACK_MISMATCH",
        MappingStoreError::ConflictingEvent { .. } => "MAPPING_EVENT_CONFLICT",
        MappingStoreError::Invalid(_) => "INVALID_PARAMS",
    }
}

fn require_no_params(params: Option<&Value>, method: &str) -> Result<(), String> {
    if params.is_some() {
        return Err(format!(
            "Invalid params for {method}: no params are accepted"
        ));
    }
    Ok(())
}

/// Pulls a validated mapping id out of a request's params.
fn mapping_id(params: Option<Value>, method: &str) -> Result<String, String> {
    let params: MappingIdParams = parse_params(params, method)?;
    check_identifier("id", &params.id)
        .map_err(|error| format!("Invalid params for {method}: {error}"))?;
    Ok(params.id)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct MappingUpsertParams {
    mapping: MappingConfiguration,
    author_device_id: String,
    delivery_target_device_id: Option<String>,
    expected_revision: Option<i64>,
    occurred_at: String,
}

fn handle_mapping_upsert(request: RpcRequest, mapping_store: &MappingStoreSlot) -> Value {
    let params: MappingUpsertParams = match parse_params(request.params, "mapping.upsert") {
        Ok(params) => params,
        Err(message) => return error_response_with_code(request.id, "INVALID_PARAMS", message),
    };
    let store = match mapping_store.store() {
        Ok(store) => store,
        Err(failure) => return rpc_failure_response(request.id, failure),
    };
    match store.upsert_local(
        &params.mapping,
        &params.author_device_id,
        params.delivery_target_device_id.as_deref(),
        params.expected_revision,
        &params.occurred_at,
    ) {
        Ok(record) => success_response(request.id, record),
        Err(error) => store_error_response(request.id, "Failed to store mapping", &error),
    }
}

fn handle_mapping_get(request: RpcRequest, mapping_store: &MappingStoreSlot) -> Value {
    let id = match mapping_id(request.params, "mapping.get") {
        Ok(id) => id,
        Err(message) => return error_response_with_code(request.id, "INVALID_PARAMS", message),
    };
    let store = match mapping_store.store() {
        Ok(store) => store,
        Err(failure) => return rpc_failure_response(request.id, failure),
    };
    match store.get(&id) {
        Ok(record) => success_response(request.id, record),
        Err(error) => store_error_response(request.id, "Failed to read mapping", &error),
    }
}

fn handle_mapping_list(request: RpcRequest, mapping_store: &MappingStoreSlot) -> Value {
    if let Err(message) = require_no_params(request.params.as_ref(), "mapping.list") {
        return error_response_with_code(request.id, "INVALID_PARAMS", message);
    }
    let store = match mapping_store.store() {
        Ok(store) => store,
        Err(failure) => return rpc_failure_response(request.id, failure),
    };
    match store.list() {
        Ok(records) => success_response(request.id, records),
        Err(error) => store_error_response(request.id, "Failed to list mappings", &error),
    }
}

fn handle_mapping_list_pending_delivery(
    request: RpcRequest,
    mapping_store: &MappingStoreSlot,
) -> Value {
    if let Err(message) = require_no_params(request.params.as_ref(), "mapping.listPendingDelivery")
    {
        return error_response_with_code(request.id, "INVALID_PARAMS", message);
    }
    let store = match mapping_store.store() {
        Ok(store) => store,
        Err(failure) => return rpc_failure_response(request.id, failure),
    };
    match store.list_pending_delivery() {
        Ok(deliveries) => success_response(request.id, deliveries),
        Err(error) => store_error_response(request.id, "Failed to list pending mappings", &error),
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct MappingRemoveParams {
    id: String,
    deleting_device_id: String,
    delivery_target_device_id: Option<String>,
    expected_revision: i64,
    occurred_at: String,
}

fn handle_mapping_remove(request: RpcRequest, mapping_store: &MappingStoreSlot) -> Value {
    let params: MappingRemoveParams = match parse_params(request.params, "mapping.remove") {
        Ok(params) => params,
        Err(message) => return error_response_with_code(request.id, "INVALID_PARAMS", message),
    };
    let store = match mapping_store.store() {
        Ok(store) => store,
        Err(failure) => return rpc_failure_response(request.id, failure),
    };
    match store.remove_local(
        &params.id,
        &params.deleting_device_id,
        params.delivery_target_device_id.as_deref(),
        params.expected_revision,
        &params.occurred_at,
    ) {
        Ok(tombstone) => success_response(request.id, tombstone),
        Err(error) => store_error_response(request.id, "Failed to remove mapping", &error),
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct MappingApplyRemoteParams {
    event: MappingEvent,
    authenticated_peer_device_id: String,
    local_device_id: String,
}

fn handle_mapping_apply_remote(request: RpcRequest, mapping_store: &MappingStoreSlot) -> Value {
    let params: MappingApplyRemoteParams = match parse_params(request.params, "mapping.applyRemote")
    {
        Ok(params) => params,
        Err(message) => {
            return error_response_with_code(request.id, "INVALID_PARAMS", message);
        }
    };
    let store = match mapping_store.store() {
        Ok(store) => store,
        Err(failure) => return rpc_failure_response(request.id, failure),
    };
    match store.apply_remote(
        &params.event,
        &params.authenticated_peer_device_id,
        &params.local_device_id,
    ) {
        Ok(outcome) => success_response(request.id, outcome),
        Err(error) => {
            store_error_response(request.id, "Failed to apply peer mapping event", &error)
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct MappingAcknowledgeParams {
    mapping_id: String,
    event_id: String,
    revision: i64,
    authenticated_peer_device_id: String,
    acknowledged_at: String,
}

fn handle_mapping_acknowledge_delivery(
    request: RpcRequest,
    mapping_store: &MappingStoreSlot,
) -> Value {
    let params: MappingAcknowledgeParams =
        match parse_params(request.params, "mapping.acknowledgeDelivery") {
            Ok(params) => params,
            Err(message) => {
                return error_response_with_code(request.id, "INVALID_PARAMS", message);
            }
        };
    let store = match mapping_store.store() {
        Ok(store) => store,
        Err(failure) => return rpc_failure_response(request.id, failure),
    };
    match store.acknowledge_delivery(
        &params.mapping_id,
        &params.event_id,
        params.revision,
        &params.authenticated_peer_device_id,
        &params.acknowledged_at,
    ) {
        Ok(outcome) => success_response(request.id, outcome),
        Err(error) => {
            store_error_response(request.id, "Failed to acknowledge mapping delivery", &error)
        }
    }
}

fn handle_mapping_get_migration_status(
    request: RpcRequest,
    mapping_store: &MappingStoreSlot,
) -> Value {
    if let Err(message) = require_no_params(request.params.as_ref(), "mapping.getMigrationStatus") {
        return error_response_with_code(request.id, "INVALID_PARAMS", message);
    }
    let store = match mapping_store.store() {
        Ok(store) => store,
        Err(failure) => return rpc_failure_response(request.id, failure),
    };
    match store.legacy_migration_status() {
        Ok(status) => success_response(request.id, status),
        Err(error) => store_error_response(request.id, "Failed to read migration status", &error),
    }
}

fn handle_mapping_import_legacy(request: RpcRequest, mapping_store: &MappingStoreSlot) -> Value {
    let params: LegacyImportRequest = match parse_params(request.params, "mapping.importLegacy") {
        Ok(params) => params,
        Err(message) => {
            if let Ok(store) = mapping_store.store() {
                let _ = store.record_legacy_import_failure(&message);
            }
            return error_response_with_code(request.id, "INVALID_PARAMS", message);
        }
    };
    let store = match mapping_store.store() {
        Ok(store) => store,
        Err(failure) => return rpc_failure_response(request.id, failure),
    };
    match store.import_legacy(&params) {
        Ok(outcome) => success_response(request.id, outcome),
        Err(error) => {
            store_error_response(request.id, "Legacy mapping import did not commit", &error)
        }
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct MappingMigrationFailureParams {
    detail: String,
}

fn handle_mapping_record_migration_failure(
    request: RpcRequest,
    mapping_store: &MappingStoreSlot,
) -> Value {
    let params: MappingMigrationFailureParams =
        match parse_params(request.params, "mapping.recordMigrationFailure") {
            Ok(params) => params,
            Err(message) => {
                return error_response_with_code(request.id, "INVALID_PARAMS", message);
            }
        };
    if params.detail.trim().is_empty() {
        return error_response_with_code(
            request.id,
            "INVALID_PARAMS",
            "migration failure detail must not be empty",
        );
    }
    let store = match mapping_store.store() {
        Ok(store) => store,
        Err(failure) => return rpc_failure_response(request.id, failure),
    };
    match store.record_legacy_import_failure(&params.detail) {
        Ok(()) => match store.legacy_migration_status() {
            Ok(status) => success_response(request.id, status),
            Err(error) => {
                store_error_response(request.id, "Failed to read migration status", &error)
            }
        },
        Err(error) => {
            store_error_response(request.id, "Failed to record migration failure", &error)
        }
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
    use std::ffi::OsString;

    use super::{MappingStoreSlot, handle_line, mapping_error_code, select_data_directory};
    use sync_storage::mapping::{
        LegacyImportRequest, MappingStore, MappingStoreError, SCHEMA_VERSION,
    };

    /// A slot backed by a real in-memory database.
    fn ready_store() -> MappingStoreSlot {
        let store = MappingStore::open_in_memory().expect("open in-memory store");
        store
            .import_legacy(&LegacyImportRequest {
                source_fingerprint: "0".repeat(64),
                importing_device_id: "linux-box".to_owned(),
                imported_at: "2026-08-01T00:00:00Z".to_owned(),
                records: Vec::new(),
            })
            .expect("complete empty legacy import");
        MappingStoreSlot::Ready(Box::new(store))
    }

    fn sample_mapping_json() -> &'static str {
        r#"{
            "mapping": {
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
                "paused": false,
                "preview": null,
                "createdAt": "2026-08-01T00:00:00Z",
                "updatedAt": "2026-08-01T00:00:00Z"
            },
            "authorDeviceId": "linux-box",
            "deliveryTargetDeviceId": null,
            "expectedRevision": null,
            "occurredAt": "2026-08-01T00:00:00Z"
        }"#
    }

    /// Builds a request line with the given method and raw JSON params.
    fn request(method: &str, params: &str) -> String {
        format!(r#"{{"id":"1","method":"{method}","sessionToken":"correct","params":{params}}}"#)
    }

    fn remove_mapping_json(id: &str, expected_revision: i64) -> String {
        format!(
            r#"{{"id":"{id}","deletingDeviceId":"linux-box","deliveryTargetDeviceId":null,"expectedRevision":{expected_revision},"occurredAt":"2026-08-01T00:01:00Z"}}"#
        )
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
    fn conflicting_event_has_a_stable_structured_error_code() {
        assert_eq!(
            mapping_error_code(&MappingStoreError::ConflictingEvent {
                mapping_id: "mapping-1".to_owned(),
                event_id: "active:mapping-1:1:linux-box".to_owned(),
            }),
            "MAPPING_EVENT_CONFLICT"
        );
    }

    #[test]
    fn every_mapping_method_requires_the_session_token() {
        let store = ready_store();
        for method in [
            "mapping.upsert",
            "mapping.get",
            "mapping.list",
            "mapping.listPendingDelivery",
            "mapping.remove",
            "mapping.applyRemote",
            "mapping.acknowledgeDelivery",
            "mapping.getMigrationStatus",
            "mapping.importLegacy",
            "mapping.recordMigrationFailure",
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
        assert_eq!(
            response["result"]["mappingStore"]["migrationState"],
            "completed"
        );
        assert_eq!(response["result"]["mappingStore"]["mutationsEnabled"], true);
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
        let slot = MappingStoreSlot::Unavailable {
            status: "unavailable",
            detail: "disk is on fire".to_owned(),
            schema_version: None,
        };
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
    fn health_distinguishes_a_newer_unsupported_database() {
        let slot = MappingStoreSlot::Unavailable {
            status: "unsupported-schema",
            detail: "upgrade Tethera before changing mappings".to_owned(),
            schema_version: Some(SCHEMA_VERSION + 1),
        };
        let response = handle_line(
            r#"{"id":"1","method":"health","sessionToken":"correct"}"#,
            "correct",
            &slot,
        );
        assert_eq!(
            response["result"]["mappingStore"]["status"],
            "unsupported-schema"
        );
        assert_eq!(
            response["result"]["mappingStore"]["schemaVersion"],
            SCHEMA_VERSION + 1
        );
        assert_eq!(
            response["result"]["mappingStore"]["mutationsEnabled"],
            false
        );
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
                "mapping.get",
                r#"{"id":"x'; DROP TABLE folder_mappings; --"}"#,
            ),
            "correct",
            &store,
        );
        assert_eq!(response["ok"], true);
        assert!(response["result"].is_null(), "no row has that literal id");

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
        let cases = [
            (
                "mapping.list",
                r#"{"id":"1","method":"mapping.list","sessionToken":"correct"}"#.to_owned(),
            ),
            (
                "mapping.listPendingDelivery",
                r#"{"id":"1","method":"mapping.listPendingDelivery","sessionToken":"correct"}"#
                    .to_owned(),
            ),
            (
                "mapping.get",
                request("mapping.get", r#"{"id":"mapping-1"}"#),
            ),
            (
                "mapping.remove",
                request("mapping.remove", &remove_mapping_json("mapping-1", 1)),
            ),
            (
                "mapping.upsert",
                request("mapping.upsert", sample_mapping_json()),
            ),
            (
                "mapping.acknowledgeDelivery",
                request(
                    "mapping.acknowledgeDelivery",
                    r#"{"mappingId":"mapping-1","eventId":"event-1","revision":1,"authenticatedPeerDeviceId":"win-box","acknowledgedAt":"2026-08-01T00:02:00Z"}"#,
                ),
            ),
            (
                "mapping.getMigrationStatus",
                r#"{"id":"1","method":"mapping.getMigrationStatus","sessionToken":"correct"}"#
                    .to_owned(),
            ),
            (
                "mapping.importLegacy",
                request(
                    "mapping.importLegacy",
                    &format!(
                        r#"{{"sourceFingerprint":"{}","importingDeviceId":"linux-box","importedAt":"2026-08-01T00:00:00Z","records":[]}}"#,
                        "0".repeat(64)
                    ),
                ),
            ),
            (
                "mapping.recordMigrationFailure",
                request(
                    "mapping.recordMigrationFailure",
                    r#"{"detail":"state.json is unreadable"}"#,
                ),
            ),
        ];
        for (method, line) in cases {
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
        assert_eq!(response["result"]["mapping"]["id"], "mapping-1");
        assert_eq!(response["result"]["revision"], 1);

        let response = handle_line(
            &request("mapping.get", r#"{"id":"mapping-1"}"#),
            "correct",
            &store,
        );
        assert_eq!(response["ok"], true);
        assert_eq!(response["result"]["mapping"]["id"], "mapping-1");
        assert_eq!(
            response["result"]["mapping"]["setupStatus"],
            "pending-approval"
        );
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
        assert_eq!(
            response["result"]["mapping"]["initiatorPath"],
            "/home/tommy/Projects"
        );
        assert_eq!(
            response["result"]["mapping"]["responderPath"], "C:\\Users\\tommy\\Projects",
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
    fn mapping_list_and_remove_round_trip() {
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

        let remove_response = handle_line(
            &request("mapping.remove", &remove_mapping_json("mapping-1", 1)),
            "correct",
            &store,
        );
        assert_eq!(remove_response["ok"], true);
        assert_eq!(remove_response["result"]["mappingId"], "mapping-1");
        assert_eq!(remove_response["result"]["deletionRevision"], 2);

        let list_after_delete = handle_line(
            r#"{"id":"4","method":"mapping.list","sessionToken":"correct"}"#,
            "correct",
            &store,
        );
        assert_eq!(
            list_after_delete["result"].as_array().expect("array").len(),
            0
        );
        let get_after_remove = handle_line(
            &request("mapping.get", r#"{"id":"mapping-1"}"#),
            "correct",
            &store,
        );
        assert!(get_after_remove["result"].is_null());
        let resurrection = handle_line(
            &request("mapping.upsert", sample_mapping_json()),
            "correct",
            &store,
        );
        assert_eq!(resurrection["errorCode"], "MAPPING_TOMBSTONED");
    }

    #[test]
    fn removing_a_missing_mapping_is_a_structured_error() {
        let response = handle_line(
            &request("mapping.remove", &remove_mapping_json("never-existed", 1)),
            "correct",
            &ready_store(),
        );
        assert_eq!(response["ok"], false);
        assert_eq!(response["errorCode"], "MAPPING_NOT_FOUND");
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
            .replace(
                r#""deliveryTargetDeviceId": null"#,
                r#""deliveryTargetDeviceId": "win-box""#,
            );
        handle_line(&request("mapping.upsert", &pending), "correct", &store);

        let response = handle_line(
            r#"{"id":"3","method":"mapping.listPendingDelivery","sessionToken":"correct"}"#,
            "correct",
            &store,
        );
        let records = response["result"].as_array().expect("array");
        assert_eq!(records.len(), 1);
        assert_eq!(records[0]["mappingId"], "mapping-2");
        assert_eq!(records[0]["targetDeviceId"], "win-box");
    }

    #[test]
    fn pending_delivery_requires_the_exact_authenticated_acknowledgement() {
        let store = ready_store();
        let pending = sample_mapping_json().replace(
            r#""deliveryTargetDeviceId": null"#,
            r#""deliveryTargetDeviceId": "win-box""#,
        );
        let created = handle_line(&request("mapping.upsert", &pending), "correct", &store);
        let event_id = created["result"]["eventId"].as_str().expect("event id");

        let stale = format!(
            r#"{{"mappingId":"mapping-1","eventId":{event_id},"revision":2,"authenticatedPeerDeviceId":"win-box","acknowledgedAt":"2026-08-01T00:02:00Z"}}"#,
            event_id = serde_json::to_string(event_id).expect("event id json")
        );
        let response = handle_line(
            &request("mapping.acknowledgeDelivery", &stale),
            "correct",
            &store,
        );
        assert_eq!(response["errorCode"], "MAPPING_ACK_MISMATCH");

        let exact = format!(
            r#"{{"mappingId":"mapping-1","eventId":{event_id},"revision":1,"authenticatedPeerDeviceId":"win-box","acknowledgedAt":"2026-08-01T00:02:00Z"}}"#,
            event_id = serde_json::to_string(event_id).expect("event id json")
        );
        let response = handle_line(
            &request("mapping.acknowledgeDelivery", &exact),
            "correct",
            &store,
        );
        assert_eq!(response["result"]["status"], "acknowledged");
        let duplicate = handle_line(
            &request("mapping.acknowledgeDelivery", &exact),
            "correct",
            &store,
        );
        assert_eq!(duplicate["result"]["status"], "already-acknowledged");
        let pending_after = handle_line(
            r#"{"id":"3","method":"mapping.listPendingDelivery","sessionToken":"correct"}"#,
            "correct",
            &store,
        );
        assert_eq!(pending_after["result"].as_array().expect("array").len(), 0);
    }

    #[test]
    fn remote_events_require_the_authenticated_mapping_participant() {
        let sender = ready_store();
        let created = handle_line(
            &request("mapping.upsert", sample_mapping_json()),
            "correct",
            &sender,
        );
        let event = serde_json::json!({
            "kind": "active",
            "record": created["result"].clone(),
        });
        let receiver = ready_store();
        let invalid = serde_json::json!({
            "event": event,
            "authenticatedPeerDeviceId": "mallory",
            "localDeviceId": "win-box",
        });
        let response = handle_line(
            &request("mapping.applyRemote", &invalid.to_string()),
            "correct",
            &receiver,
        );
        assert_eq!(response["errorCode"], "MAPPING_INVALID_PARTICIPANT");

        let valid = serde_json::json!({
            "event": event,
            "authenticatedPeerDeviceId": "linux-box",
            "localDeviceId": "win-box",
        });
        let response = handle_line(
            &request("mapping.applyRemote", &valid.to_string()),
            "correct",
            &receiver,
        );
        assert_eq!(response["result"]["status"], "applied");
        let duplicate = handle_line(
            &request("mapping.applyRemote", &valid.to_string()),
            "correct",
            &receiver,
        );
        assert_eq!(duplicate["result"]["status"], "duplicate");
    }

    #[test]
    fn migration_status_and_failure_are_explicit_until_import_commits() {
        let store = MappingStoreSlot::Ready(Box::new(
            MappingStore::open_in_memory().expect("open pending store"),
        ));
        let status = handle_line(
            r#"{"id":"1","method":"mapping.getMigrationStatus","sessionToken":"correct"}"#,
            "correct",
            &store,
        );
        assert_eq!(status["result"]["state"], "pending");
        let list = handle_line(
            r#"{"id":"2","method":"mapping.list","sessionToken":"correct"}"#,
            "correct",
            &store,
        );
        assert_eq!(list["errorCode"], "MAPPING_MIGRATION_REQUIRED");

        let failed = handle_line(
            &request(
                "mapping.recordMigrationFailure",
                r#"{"detail":"legacy record is malformed"}"#,
            ),
            "correct",
            &store,
        );
        assert_eq!(failed["result"]["state"], "failed");

        let import = format!(
            r#"{{"sourceFingerprint":"{}","importingDeviceId":"linux-box","importedAt":"2026-08-01T00:00:00Z","records":[]}}"#,
            "a".repeat(64)
        );
        let imported = handle_line(&request("mapping.importLegacy", &import), "correct", &store);
        assert_eq!(imported["result"]["status"]["state"], "completed");
        let list = handle_line(
            r#"{"id":"3","method":"mapping.list","sessionToken":"correct"}"#,
            "correct",
            &store,
        );
        assert_eq!(list["ok"], true);
        assert_eq!(list["result"].as_array().expect("array").len(), 0);
    }

    #[test]
    fn unknown_fields_and_invalid_revisions_are_rejected() {
        let store = ready_store();
        let mut params: serde_json::Value =
            serde_json::from_str(sample_mapping_json()).expect("mapping json");
        params["unexpected"] = serde_json::json!(true);
        let response = handle_line(
            &request("mapping.upsert", &params.to_string()),
            "correct",
            &store,
        );
        assert_eq!(response["errorCode"], "INVALID_PARAMS");

        params.as_object_mut().expect("object").remove("unexpected");
        params["expectedRevision"] = serde_json::json!(0);
        let response = handle_line(
            &request("mapping.upsert", &params.to_string()),
            "correct",
            &store,
        );
        assert_eq!(response["errorCode"], "INVALID_PARAMS");

        params["expectedRevision"] = serde_json::Value::Null;
        params["mapping"]["preview"] = serde_json::json!({
            "localFiles": 0,
            "remoteFiles": 0,
            "identicalFiles": 0,
            "differentFiles": 0,
            "localOnlyFiles": 0,
            "remoteOnlyFiles": 0,
            "ignoredLocal": 0,
            "ignoredRemote": 0,
            "bytesToRemote": 0,
            "bytesToLocal": 0,
            "invalidWindowsNames": [],
            "caseCollisions": [],
            "truncated": false,
            "samples": [],
            "unexpected": true
        });
        let response = handle_line(
            &request("mapping.upsert", &params.to_string()),
            "correct",
            &store,
        );
        assert_eq!(response["errorCode"], "INVALID_PARAMS");

        let response = handle_line(
            r#"{"id":"1","method":"mapping.list","sessionToken":"correct","unexpected":true}"#,
            "correct",
            &store,
        );
        assert_eq!(response["errorCode"], "INVALID_REQUEST");
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
        for params in [
            r#"{"id":""}"#,
            r#"{"id":"   "}"#,
            r#"{"id":123}"#,
            r"{}",
            r#"{"identifier":"mapping-1"}"#,
            r#"{"id":"mapping-1","extra":"unexpected"}"#,
        ] {
            let response = handle_line(&request("mapping.get", params), "correct", &store);
            assert_eq!(
                response["ok"], false,
                "mapping.get should reject params {params}"
            );
        }
    }

    #[test]
    fn mapping_methods_require_params_when_they_take_them() {
        let store = ready_store();
        for method in [
            "mapping.get",
            "mapping.remove",
            "mapping.upsert",
            "mapping.applyRemote",
            "mapping.acknowledgeDelivery",
            "mapping.importLegacy",
            "mapping.recordMigrationFailure",
        ] {
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
        if let MappingStoreSlot::Ready(store) = &first {
            store
                .import_legacy(&LegacyImportRequest {
                    source_fingerprint: "0".repeat(64),
                    importing_device_id: "linux-box".to_owned(),
                    imported_at: "2026-08-01T00:00:00Z".to_owned(),
                    records: Vec::new(),
                })
                .expect("complete import before writing mappings");
        }
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
        assert_eq!(response["result"]["mapping"]["id"], "mapping-1");
    }

    #[test]
    fn tethera_data_dir_takes_precedence_over_the_deprecated_name() {
        let selection = select_data_directory(
            Some(OsString::from("/new/tethera")),
            Some(OsString::from("/old/foldersync")),
        );
        assert_eq!(
            selection.path.expect("selected"),
            std::path::Path::new("/new/tethera")
        );
        assert!(!selection.used_legacy_name);
    }

    #[test]
    fn deprecated_data_dir_is_a_compatible_fallback() {
        let selection = select_data_directory(None, Some(OsString::from("/old/foldersync")));
        assert_eq!(
            selection.path.expect("selected"),
            std::path::Path::new("/old/foldersync")
        );
        assert!(selection.used_legacy_name);
    }
}
