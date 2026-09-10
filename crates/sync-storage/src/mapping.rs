//! Authoritative durable storage for folder-mapping configuration.
//!
//! The database stores configuration only. Paths are opaque strings and this module never opens,
//! scans, renames, moves, modifies, or deletes anything under a mapped directory.
//!
//! A mapping id is terminal once it has a tombstone. Replaying an active event for that id can
//! never make it active again; adding the same folders later must use a new mapping id.

use std::cmp::Ordering;
use std::collections::HashSet;
use std::path::Path;
use std::time::Duration;

use rusqlite::{Connection, OptionalExtension, Row, Transaction, TransactionBehavior, params};
use serde::{Deserialize, Serialize};
use time::OffsetDateTime;
use time::format_description::well_known::Rfc3339;

/// Schema version this build reads and writes. Version 1 is intentionally left unchanged below.
pub const SCHEMA_VERSION: i64 = 7;

const BUSY_TIMEOUT: Duration = Duration::from_secs(5);
const MAX_ID_LENGTH: usize = 200;
const MAX_EVENT_ID_LENGTH: usize = 1_024;
const MAX_NAME_LENGTH: usize = 200;
const MAX_PATH_LENGTH: usize = 4_096;
const MAX_IGNORE_PATTERNS: usize = 1_000;
const MAX_IGNORE_PATTERN_LENGTH: usize = 1_024;
const MAX_PREVIEW_ITEMS: usize = 10_000;
const MAX_PREVIEW_SERIALIZED_BYTES: usize = 2 * 1024 * 1024;
const MAX_HISTORY_DAYS: i64 = 3_650;
const MAX_HISTORY_BYTES: i64 = 1 << 50;
const MIN_FILE_SIZE_LIMIT_BYTES: i64 = 1_024;
const MAX_FILE_SIZE_LIMIT_BYTES: i64 = 1 << 40; // 1 TiB
const MAX_MIGRATION_ERROR_LENGTH: usize = 1_000;
const VALID_MODES: [&str; 3] = ["two-way", "send-only", "receive-only"];
const VALID_SETUP_STATUSES: [&str; 3] = ["pending-approval", "ready-for-initial-sync", "active"];

const V1_SELECT_COLUMNS: &str = "SELECT id, name, initiator_device_id, initiator_device_name,
            responder_device_id, responder_device_name,
            initiator_path, responder_path, mode, ignore_patterns,
            history_days, history_max_bytes, setup_status, pending_delivery,
            preview, created_at, updated_at
     FROM folder_mappings";

const ACTIVE_SELECT_COLUMNS: &str = "SELECT
            mapping.id, mapping.name,
            mapping.initiator_device_id, mapping.initiator_device_name,
            mapping.responder_device_id, mapping.responder_device_name,
            mapping.initiator_path, mapping.responder_path, mapping.mode,
            mapping.ignore_patterns, mapping.history_days, mapping.history_max_bytes,
            mapping.max_file_bytes,
            mapping.setup_status, mapping.preview, mapping.created_at, mapping.updated_at,
            revision.paused, revision.revision, revision.event_id, revision.author_device_id,
            EXISTS (
                SELECT 1 FROM mapping_delivery_outbox delivery
                WHERE delivery.mapping_id = mapping.id AND delivery.acknowledged_at IS NULL
            ) AS pending_delivery
        FROM folder_mappings mapping
        LEFT JOIN mapping_revisions revision ON revision.mapping_id = mapping.id";

/// User-visible mapping configuration. Both paths are preserved verbatim and never dereferenced.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MappingConfiguration {
    pub id: String,
    pub name: String,
    pub initiator_device_id: String,
    pub initiator_device_name: String,
    pub responder_device_id: String,
    pub responder_device_name: String,
    pub initiator_path: String,
    pub responder_path: String,
    pub mode: String,
    pub ignore_patterns: Vec<String>,
    pub history_days: i64,
    pub history_max_bytes: i64,
    #[serde(default)]
    pub max_file_bytes: Option<i64>,
    pub setup_status: String,
    pub paused: bool,
    pub preview: Option<MappingPreview>,
    pub created_at: String,
    pub updated_at: String,
}

impl MappingConfiguration {
    /// Validates every persisted or remotely delivered field without touching either path.
    ///
    /// # Errors
    ///
    /// Returns [`MappingStoreError::Invalid`] or [`MappingStoreError::InvalidParticipant`] when
    /// any bounded field, timestamp, path string, or participant relationship is invalid.
    pub fn validate(&self) -> Result<(), MappingStoreError> {
        check_identifier("id", &self.id)?;
        check_identifier("initiatorDeviceId", &self.initiator_device_id)?;
        check_identifier("responderDeviceId", &self.responder_device_id)?;
        if self.initiator_device_id == self.responder_device_id {
            return Err(MappingStoreError::Invalid(
                "mapping participants must be two different devices".to_owned(),
            ));
        }
        check_text("name", &self.name, MAX_NAME_LENGTH)?;
        check_text(
            "initiatorDeviceName",
            &self.initiator_device_name,
            MAX_NAME_LENGTH,
        )?;
        check_text(
            "responderDeviceName",
            &self.responder_device_name,
            MAX_NAME_LENGTH,
        )?;
        check_path("initiatorPath", &self.initiator_path)?;
        check_path("responderPath", &self.responder_path)?;
        if !VALID_MODES.contains(&self.mode.as_str()) {
            return Err(MappingStoreError::Invalid(format!(
                "mode must be one of {}, got {:?}",
                VALID_MODES.join(", "),
                self.mode
            )));
        }
        if !VALID_SETUP_STATUSES.contains(&self.setup_status.as_str()) {
            return Err(MappingStoreError::Invalid(format!(
                "setupStatus must be one of {}, got {:?}",
                VALID_SETUP_STATUSES.join(", "),
                self.setup_status
            )));
        }
        if !(0..=MAX_HISTORY_DAYS).contains(&self.history_days) {
            return Err(MappingStoreError::Invalid(format!(
                "historyDays must be between 0 and {MAX_HISTORY_DAYS}, got {}",
                self.history_days
            )));
        }
        if !(0..=MAX_HISTORY_BYTES).contains(&self.history_max_bytes) {
            return Err(MappingStoreError::Invalid(format!(
                "historyMaxBytes must be between 0 and {MAX_HISTORY_BYTES}, got {}",
                self.history_max_bytes
            )));
        }
        if let Some(limit) = self.max_file_bytes {
            if !(MIN_FILE_SIZE_LIMIT_BYTES..=MAX_FILE_SIZE_LIMIT_BYTES).contains(&limit) {
                return Err(MappingStoreError::Invalid(format!(
                    "maxFileBytes must be between {MIN_FILE_SIZE_LIMIT_BYTES} and {MAX_FILE_SIZE_LIMIT_BYTES} when set, got {limit}"
                )));
            }
        }
        if self.ignore_patterns.len() > MAX_IGNORE_PATTERNS {
            return Err(MappingStoreError::Invalid(format!(
                "ignorePatterns must hold at most {MAX_IGNORE_PATTERNS} entries, got {}",
                self.ignore_patterns.len()
            )));
        }
        for pattern in &self.ignore_patterns {
            if pattern.len() > MAX_IGNORE_PATTERN_LENGTH || pattern.contains('\0') {
                return Err(MappingStoreError::Invalid(format!(
                    "each ignorePatterns entry must be NUL-free and at most {MAX_IGNORE_PATTERN_LENGTH} characters"
                )));
            }
        }
        if let Some(preview) = &self.preview {
            preview.validate()?;
        }
        check_timestamp("createdAt", &self.created_at)?;
        check_timestamp("updatedAt", &self.updated_at)?;
        Ok(())
    }

    fn participant(&self, device_id: &str) -> bool {
        self.initiator_device_id == device_id || self.responder_device_id == device_id
    }

    fn other_participant(&self, device_id: &str) -> Result<&str, MappingStoreError> {
        if self.initiator_device_id == device_id {
            Ok(&self.responder_device_id)
        } else if self.responder_device_id == device_id {
            Ok(&self.initiator_device_id)
        } else {
            Err(MappingStoreError::InvalidParticipant(format!(
                "device {device_id:?} is not a participant in mapping {:?}",
                self.id
            )))
        }
    }
}

/// Bounded last-verified comparison summary retained with mapping configuration.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MappingPreview {
    pub local_files: u64,
    pub remote_files: u64,
    pub identical_files: u64,
    pub different_files: u64,
    pub local_only_files: u64,
    pub remote_only_files: u64,
    pub ignored_local: u64,
    pub ignored_remote: u64,
    pub bytes_to_remote: u64,
    pub bytes_to_local: u64,
    pub invalid_windows_names: Vec<String>,
    pub case_collisions: Vec<String>,
    pub truncated: bool,
    pub samples: Vec<MappingPreviewItem>,
}

impl MappingPreview {
    fn validate(&self) -> Result<(), MappingStoreError> {
        for (field, paths) in [
            ("preview.invalidWindowsNames", &self.invalid_windows_names),
            ("preview.caseCollisions", &self.case_collisions),
        ] {
            if paths.len() > MAX_PREVIEW_ITEMS {
                return Err(MappingStoreError::Invalid(format!(
                    "{field} must hold at most {MAX_PREVIEW_ITEMS} entries"
                )));
            }
            for path in paths {
                check_path(field, path)?;
            }
        }
        if self.samples.len() > MAX_PREVIEW_ITEMS {
            return Err(MappingStoreError::Invalid(format!(
                "preview.samples must hold at most {MAX_PREVIEW_ITEMS} entries"
            )));
        }
        for sample in &self.samples {
            check_path("preview.samples.path", &sample.path)?;
        }
        let serialized_size = serde_json::to_vec(self)?.len();
        if serialized_size > MAX_PREVIEW_SERIALIZED_BYTES {
            return Err(MappingStoreError::Invalid(format!(
                "preview must be at most {MAX_PREVIEW_SERIALIZED_BYTES} serialized bytes"
            )));
        }
        Ok(())
    }
}

/// One bounded path sample in a mapping comparison summary.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MappingPreviewItem {
    pub path: String,
    pub category: MappingPreviewCategory,
    pub size: Option<u64>,
}

/// Allowed classifications for a retained mapping comparison sample.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum MappingPreviewCategory {
    LocalOnly,
    RemoteOnly,
    Different,
    InvalidName,
    CaseCollision,
}

/// An active mapping plus deterministic ordering and local delivery state.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MappingRecord {
    pub mapping: MappingConfiguration,
    pub revision: i64,
    pub event_id: String,
    pub author_device_id: String,
    pub pending_delivery: bool,
}

impl MappingRecord {
    fn validate_event(&self) -> Result<(), MappingStoreError> {
        self.mapping.validate()?;
        check_revision(self.revision)?;
        check_event_id(&self.event_id)?;
        check_identifier("authorDeviceId", &self.author_device_id)?;
        if !self.mapping.participant(&self.author_device_id) {
            return Err(MappingStoreError::InvalidParticipant(format!(
                "event author {:?} is not a mapping participant",
                self.author_device_id
            )));
        }
        Ok(())
    }
}

/// Durable deletion evidence. Tombstones are never pruned automatically.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MappingTombstone {
    pub mapping_id: String,
    pub deletion_event_id: String,
    pub deletion_revision: i64,
    pub deletion_timestamp: String,
    pub deleting_device_id: String,
    pub last_known_update_revision: i64,
    pub tombstone_created_at: String,
    pub initiator_device_id: String,
    pub responder_device_id: String,
}

impl MappingTombstone {
    fn validate(&self) -> Result<(), MappingStoreError> {
        check_identifier("mappingId", &self.mapping_id)?;
        check_event_id(&self.deletion_event_id)?;
        check_revision(self.deletion_revision)?;
        if self.last_known_update_revision < 1
            || self.deletion_revision <= self.last_known_update_revision
        {
            return Err(MappingStoreError::Invalid(
                "deletionRevision must be greater than lastKnownUpdateRevision".to_owned(),
            ));
        }
        check_timestamp("deletionTimestamp", &self.deletion_timestamp)?;
        check_timestamp("tombstoneCreatedAt", &self.tombstone_created_at)?;
        check_identifier("deletingDeviceId", &self.deleting_device_id)?;
        check_identifier("initiatorDeviceId", &self.initiator_device_id)?;
        check_identifier("responderDeviceId", &self.responder_device_id)?;
        if self.initiator_device_id == self.responder_device_id {
            return Err(MappingStoreError::Invalid(
                "mapping participants must be two different devices".to_owned(),
            ));
        }
        if !self.participant(&self.deleting_device_id) {
            return Err(MappingStoreError::InvalidParticipant(format!(
                "deleting device {:?} is not a mapping participant",
                self.deleting_device_id
            )));
        }
        Ok(())
    }

    fn participant(&self, device_id: &str) -> bool {
        self.initiator_device_id == device_id || self.responder_device_id == device_id
    }
}

/// The bounded configuration event sent over an already authenticated peer session.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case", deny_unknown_fields)]
pub enum MappingEvent {
    Active { record: Box<MappingRecord> },
    Tombstone { tombstone: MappingTombstone },
}

impl MappingEvent {
    #[must_use]
    pub fn mapping_id(&self) -> &str {
        match self {
            Self::Active { record } => &record.mapping.id,
            Self::Tombstone { tombstone } => &tombstone.mapping_id,
        }
    }

    #[must_use]
    pub fn event_id(&self) -> &str {
        match self {
            Self::Active { record } => &record.event_id,
            Self::Tombstone { tombstone } => &tombstone.deletion_event_id,
        }
    }

    #[must_use]
    pub fn revision(&self) -> i64 {
        match self {
            Self::Active { record } => record.revision,
            Self::Tombstone { tombstone } => tombstone.deletion_revision,
        }
    }

    fn participants(&self) -> (&str, &str) {
        match self {
            Self::Active { record } => (
                &record.mapping.initiator_device_id,
                &record.mapping.responder_device_id,
            ),
            Self::Tombstone { tombstone } => (
                &tombstone.initiator_device_id,
                &tombstone.responder_device_id,
            ),
        }
    }

    fn author_device_id(&self) -> &str {
        match self {
            Self::Active { record } => &record.author_device_id,
            Self::Tombstone { tombstone } => &tombstone.deleting_device_id,
        }
    }

    fn validate(&self) -> Result<(), MappingStoreError> {
        match self {
            Self::Active { record } => {
                record.validate_event()?;
                if record.pending_delivery {
                    return Err(MappingStoreError::Invalid(
                        "remote active events must not carry sender-local pendingDelivery state"
                            .to_owned(),
                    ));
                }
                Ok(())
            }
            Self::Tombstone { tombstone } => tombstone.validate(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MappingDelivery {
    pub mapping_id: String,
    pub event_id: String,
    pub revision: i64,
    pub target_device_id: String,
    pub event: MappingEvent,
    pub created_at: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum ApplyStatus {
    Applied,
    Duplicate,
    Stale,
    Tombstoned,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApplyOutcome {
    pub status: ApplyStatus,
    pub mapping_id: String,
    pub event_id: String,
    pub revision: i64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum AcknowledgeStatus {
    Acknowledged,
    AlreadyAcknowledged,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AcknowledgeOutcome {
    pub status: AcknowledgeStatus,
    pub mapping_id: String,
    pub event_id: String,
    pub revision: i64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum LegacyMigrationState {
    Pending,
    Completed,
    Failed,
}

impl LegacyMigrationState {
    fn parse(value: &str) -> Result<Self, MappingStoreError> {
        match value {
            "pending" => Ok(Self::Pending),
            "completed" => Ok(Self::Completed),
            "failed" => Ok(Self::Failed),
            other => Err(MappingStoreError::CorruptMetadata {
                id: "legacy-import".to_owned(),
                detail: format!("unknown migration state {other:?}"),
            }),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LegacyMigrationStatus {
    pub state: LegacyMigrationState,
    pub source_fingerprint: Option<String>,
    pub imported_count: i64,
    pub completed_at: Option<String>,
    pub last_error: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LegacyImportRecord {
    pub mapping: MappingConfiguration,
    pub pending_delivery_target_device_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LegacyImportRequest {
    pub source_fingerprint: String,
    pub importing_device_id: String,
    pub imported_at: String,
    pub records: Vec<LegacyImportRecord>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LegacyImportOutcome {
    pub status: LegacyMigrationStatus,
    pub imported_count: usize,
    pub tombstoned_count: usize,
    pub already_completed: bool,
}

#[derive(Debug, thiserror::Error)]
pub enum MappingStoreError {
    #[error("database error: {0}")]
    Database(#[from] rusqlite::Error),
    #[error("serialisation error: {0}")]
    Serialisation(#[from] serde_json::Error),
    #[error("stored mapping {id} has a malformed {column} column: {source}")]
    CorruptRecord {
        id: String,
        column: &'static str,
        #[source]
        source: serde_json::Error,
    },
    #[error("stored mapping metadata for {id} is malformed: {detail}")]
    CorruptMetadata { id: String, detail: String },
    #[error(
        "the mapping index is at schema version {found}, which is newer than the version this build understands; upgrade Tethera"
    )]
    UnsupportedSchemaVersion { found: i64 },
    #[error("schema migration failed: {0}")]
    SchemaMigration(String),
    #[error("invalid mapping data: {0}")]
    Invalid(String),
    #[error("legacy mapping import is required before mappings can be read or changed")]
    MigrationRequired,
    #[error("legacy mapping import failed: {0}")]
    MigrationFailed(String),
    #[error("legacy mapping import already completed from a different source snapshot")]
    LegacyImportAlreadyCompleted,
    #[error("legacy mapping snapshot contains duplicate id {0:?}")]
    DuplicateMappingId(String),
    #[error("mapping {0:?} has a durable tombstone and cannot be revived")]
    Tombstoned(String),
    #[error("mapping {0:?} was not found")]
    NotFound(String),
    #[error("stale revision: expected {expected:?}, found {found:?}")]
    StaleRevision {
        expected: Option<i64>,
        found: Option<i64>,
    },
    #[error("invalid mapping participant: {0}")]
    InvalidParticipant(String),
    #[error("delivery acknowledgement did not exactly match a pending event")]
    AcknowledgementMismatch,
    #[error("mapping {mapping_id:?} received conflicting payloads for event {event_id:?}")]
    ConflictingEvent {
        mapping_id: String,
        event_id: String,
    },
}

/// Validates an opaque RPC/storage identifier.
///
/// # Errors
///
/// Returns [`MappingStoreError::Invalid`] when `value` is empty, too long, or contains a NUL.
pub fn check_identifier(field: &str, value: &str) -> Result<(), MappingStoreError> {
    check_text(field, value, MAX_ID_LENGTH)
}

fn check_text(field: &str, value: &str, max_length: usize) -> Result<(), MappingStoreError> {
    if value.trim().is_empty() {
        return Err(MappingStoreError::Invalid(format!(
            "{field} must not be empty"
        )));
    }
    if value.len() > max_length {
        return Err(MappingStoreError::Invalid(format!(
            "{field} must be at most {max_length} characters, got {}",
            value.len()
        )));
    }
    if value.contains('\0') {
        return Err(MappingStoreError::Invalid(format!(
            "{field} must not contain NUL bytes"
        )));
    }
    Ok(())
}

pub(crate) fn check_path(field: &str, value: &str) -> Result<(), MappingStoreError> {
    check_text(field, value, MAX_PATH_LENGTH)
}

fn check_event_id(value: &str) -> Result<(), MappingStoreError> {
    check_text("eventId", value, MAX_EVENT_ID_LENGTH)
}

fn check_revision(value: i64) -> Result<(), MappingStoreError> {
    if value < 1 {
        return Err(MappingStoreError::Invalid(
            "revision must be a positive integer".to_owned(),
        ));
    }
    Ok(())
}

fn check_timestamp(field: &str, value: &str) -> Result<(), MappingStoreError> {
    check_text(field, value, 64)?;
    OffsetDateTime::parse(value, &Rfc3339).map_err(|error| {
        MappingStoreError::Invalid(format!("{field} must be an RFC 3339 timestamp: {error}"))
    })?;
    Ok(())
}

fn check_fingerprint(value: &str) -> Result<(), MappingStoreError> {
    if value.len() != 64
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return Err(MappingStoreError::Invalid(
            "sourceFingerprint must be a lowercase SHA-256 hex digest".to_owned(),
        ));
    }
    Ok(())
}

#[derive(Debug)]
pub struct MappingStore {
    pub(crate) connection: Connection,
    journal_mode: String,
}

impl MappingStore {
    /// Opens the on-disk database and applies versioned schema migrations.
    ///
    /// # Errors
    ///
    /// Returns a structured storage, migration, lock, or unsupported-version error. A returned
    /// store has also passed an immediate write-transaction probe.
    pub fn open(path: impl AsRef<Path>) -> Result<Self, MappingStoreError> {
        let connection = Connection::open(path)?;
        Self::configure(connection)
    }

    /// Opens an in-memory database, primarily for tests.
    ///
    /// # Errors
    ///
    /// Returns a structured storage or schema-migration error.
    pub fn open_in_memory() -> Result<Self, MappingStoreError> {
        Self::configure(Connection::open_in_memory()?)
    }

    fn configure(connection: Connection) -> Result<Self, MappingStoreError> {
        connection.busy_timeout(BUSY_TIMEOUT)?;
        connection.pragma_update(None, "foreign_keys", true)?;
        let journal_mode: String =
            connection.query_row("PRAGMA journal_mode = WAL", [], |row| row.get(0))?;
        let store = Self {
            connection,
            journal_mode,
        };
        if let Err(error) = store.migrate() {
            return match error {
                unsupported @ MappingStoreError::UnsupportedSchemaVersion { .. } => {
                    Err(unsupported)
                }
                other => Err(MappingStoreError::SchemaMigration(other.to_string())),
            };
        }
        // Opening a WAL database can succeed while another connection holds the only writer
        // slot. Probe the exact transaction mode used by mapping mutations so health never calls
        // a read-only/locked authority ready and then presents writes as durable.
        let write_probe =
            Transaction::new_unchecked(&store.connection, TransactionBehavior::Immediate)?;
        write_probe.rollback()?;
        Ok(store)
    }

    #[must_use]
    pub fn journal_mode(&self) -> &str {
        &self.journal_mode
    }

    /// Reads the `SQLite` user schema version.
    ///
    /// # Errors
    ///
    /// Returns a database error when the schema metadata cannot be read.
    pub fn schema_version(&self) -> Result<i64, MappingStoreError> {
        Ok(self
            .connection
            .query_row("PRAGMA user_version", [], |row| row.get(0))?)
    }

    fn migrate(&self) -> Result<(), MappingStoreError> {
        let mut current = self.schema_version()?;
        if current > SCHEMA_VERSION {
            return Err(MappingStoreError::UnsupportedSchemaVersion { found: current });
        }

        if current < 1 {
            // Migration version 1 from PR #4 is intentionally preserved verbatim.
            let transaction =
                Transaction::new_unchecked(&self.connection, TransactionBehavior::Immediate)?;
            transaction.execute_batch(
                "CREATE TABLE IF NOT EXISTS folder_mappings (
                    id TEXT PRIMARY KEY,
                    name TEXT NOT NULL,
                    initiator_device_id TEXT NOT NULL,
                    initiator_device_name TEXT NOT NULL,
                    responder_device_id TEXT NOT NULL,
                    responder_device_name TEXT NOT NULL,
                    initiator_path TEXT NOT NULL,
                    responder_path TEXT NOT NULL,
                    mode TEXT NOT NULL,
                    ignore_patterns TEXT NOT NULL,
                    history_days INTEGER NOT NULL,
                    history_max_bytes INTEGER NOT NULL,
                    setup_status TEXT NOT NULL,
                    pending_delivery INTEGER NOT NULL DEFAULT 0,
                    preview TEXT,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                );
                CREATE INDEX IF NOT EXISTS folder_mappings_pending_delivery
                    ON folder_mappings (pending_delivery);
                PRAGMA user_version = 1;",
            )?;
            transaction.commit()?;
            current = 1;
        }

        if current < 2 {
            self.migrate_v1_to_v2()?;
            current = 2;
        }
        if current < 3 {
            self.migrate_v2_to_v3()?;
            current = 3;
        }
        if current < 4 {
            self.migrate_v3_to_v4()?;
            current = 4;
        }
        if current < 5 {
            self.migrate_v4_to_v5()?;
            current = 5;
        }
        if current < 6 {
            self.migrate_v5_to_v6()?;
            current = 6;
        }
        if current < 7 {
            self.migrate_v6_to_v7()?;
        }
        Ok(())
    }

    fn migrate_v6_to_v7(&self) -> Result<(), MappingStoreError> {
        let transaction =
            Transaction::new_unchecked(&self.connection, TransactionBehavior::Immediate)?;
        transaction.execute_batch(
            "CREATE TABLE IF NOT EXISTS scan_digest_cache (
                mapping_id TEXT NOT NULL REFERENCES folder_mappings(id) ON DELETE CASCADE,
                relative_path TEXT NOT NULL,
                device TEXT NOT NULL,
                inode TEXT NOT NULL,
                size INTEGER NOT NULL CHECK (size >= 0),
                modified_ns TEXT NOT NULL,
                changed_ns TEXT NOT NULL,
                digest TEXT NOT NULL,
                sweep_id TEXT NOT NULL,
                PRIMARY KEY (mapping_id, relative_path)
            ) WITHOUT ROWID;
            PRAGMA user_version = 7;",
        )?;
        transaction.commit()?;
        Ok(())
    }

    fn migrate_v5_to_v6(&self) -> Result<(), MappingStoreError> {
        let transaction =
            Transaction::new_unchecked(&self.connection, TransactionBehavior::Immediate)?;
        transaction.execute_batch(
            "CREATE TABLE IF NOT EXISTS scan_generations (
                generation_id TEXT PRIMARY KEY,
                mapping_id TEXT NOT NULL REFERENCES folder_mappings(id) ON DELETE CASCADE,
                participant_device_id TEXT NOT NULL,
                mapping_revision INTEGER NOT NULL CHECK (mapping_revision > 0),
                root TEXT NOT NULL,
                ignore_patterns TEXT NOT NULL,
                hash_mode TEXT NOT NULL CHECK (hash_mode IN ('full-sha256', 'preview')),
                state TEXT NOT NULL CHECK (state IN ('open', 'sealed', 'aborted')),
                entry_count INTEGER NOT NULL DEFAULT 0 CHECK (entry_count >= 0),
                next_sequence INTEGER NOT NULL DEFAULT 0 CHECK (next_sequence >= 0),
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                sealed_at TEXT,
                expires_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS scan_entries (
                generation_id TEXT NOT NULL REFERENCES scan_generations(generation_id) ON DELETE CASCADE,
                relative_path TEXT NOT NULL,
                digest TEXT,
                size INTEGER NOT NULL CHECK (size >= 0),
                PRIMARY KEY (generation_id, relative_path)
            );
            CREATE INDEX IF NOT EXISTS scan_generations_by_mapping
                ON scan_generations (mapping_id, state, updated_at);
            CREATE INDEX IF NOT EXISTS scan_entries_ordered
                ON scan_entries (generation_id, relative_path);
            PRAGMA user_version = 6;",
        )?;
        transaction.commit()?;
        Ok(())
    }

    fn migrate_v4_to_v5(&self) -> Result<(), MappingStoreError> {
        let transaction =
            Transaction::new_unchecked(&self.connection, TransactionBehavior::Immediate)?;
        transaction.execute_batch(
            "ALTER TABLE folder_mappings ADD COLUMN max_file_bytes INTEGER;
            PRAGMA user_version = 5;",
        )?;
        transaction.commit()?;
        Ok(())
    }

    fn migrate_v3_to_v4(&self) -> Result<(), MappingStoreError> {
        let transaction =
            Transaction::new_unchecked(&self.connection, TransactionBehavior::Immediate)?;
        transaction.execute_batch(
            "CREATE TABLE archive_objects (
                digest TEXT PRIMARY KEY,
                size INTEGER NOT NULL CHECK (size >= 0),
                object_key TEXT NOT NULL UNIQUE,
                state TEXT NOT NULL CHECK (state IN ('available', 'missing', 'corrupt')),
                created_at TEXT NOT NULL,
                verified_at TEXT NOT NULL,
                last_error TEXT
            );
            CREATE TABLE file_replacement_journal (
                id TEXT PRIMARY KEY,
                mapping_id TEXT NOT NULL,
                relative_path TEXT NOT NULL,
                sync_operation_id INTEGER,
                kind TEXT NOT NULL CHECK (kind IN ('sync', 'restore')),
                old_digest TEXT,
                old_size INTEGER CHECK (old_size IS NULL OR old_size >= 0),
                replacement_digest TEXT NOT NULL,
                replacement_size INTEGER NOT NULL CHECK (replacement_size >= 0),
                archive_digest TEXT,
                archive_object_key TEXT,
                restored_from_journal_id TEXT,
                state TEXT NOT NULL CHECK (state IN (
                    'planned', 'archived', 'installed', 'completed', 'aborted',
                    'recovery-required', 'integrity-failed'
                )),
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                completed_at TEXT,
                last_error TEXT,
                local_root TEXT NOT NULL,
                CHECK ((old_digest IS NULL) = (old_size IS NULL)),
                CHECK ((archive_digest IS NULL) = (archive_object_key IS NULL))
            );
            CREATE INDEX file_replacement_journal_history
                ON file_replacement_journal (mapping_id, created_at DESC, id DESC)
                WHERE archive_digest IS NOT NULL;
            CREATE INDEX file_replacement_journal_incomplete
                ON file_replacement_journal (created_at, id)
                WHERE state IN (
                    'planned', 'archived', 'installed', 'recovery-required', 'integrity-failed'
                );
            CREATE INDEX file_replacement_journal_recovery_issues
                ON file_replacement_journal (mapping_id, updated_at, id)
                WHERE state IN ('recovery-required', 'integrity-failed');
            CREATE UNIQUE INDEX file_replacement_journal_active_path
                ON file_replacement_journal (mapping_id, relative_path)
                WHERE state IN ('planned', 'archived', 'installed', 'recovery-required', 'integrity-failed');
            PRAGMA user_version = 4;",
        )?;
        transaction.commit()?;
        Ok(())
    }

    fn migrate_v2_to_v3(&self) -> Result<(), MappingStoreError> {
        let transaction =
            Transaction::new_unchecked(&self.connection, TransactionBehavior::Immediate)?;
        transaction.execute_batch(
            "CREATE TABLE file_sync_mapping_state (
                mapping_id TEXT PRIMARY KEY REFERENCES folder_mappings(id) ON DELETE CASCADE,
                initialized_at TEXT NOT NULL
            );
            CREATE TABLE file_sync_baselines (
                mapping_id TEXT NOT NULL REFERENCES folder_mappings(id) ON DELETE CASCADE,
                relative_path TEXT NOT NULL,
                digest TEXT NOT NULL,
                size INTEGER NOT NULL CHECK (size >= 0),
                verified_at TEXT NOT NULL,
                PRIMARY KEY (mapping_id, relative_path)
            );
            CREATE TABLE file_sync_operations (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                mapping_id TEXT NOT NULL REFERENCES folder_mappings(id) ON DELETE CASCADE,
                relative_path TEXT NOT NULL,
                direction TEXT NOT NULL CHECK (direction IN ('pull-remote', 'push-local')),
                source_digest TEXT NOT NULL,
                source_size INTEGER NOT NULL CHECK (source_size >= 0),
                expected_destination_digest TEXT,
                status TEXT NOT NULL CHECK (status IN ('pending', 'failed')),
                attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
                last_error TEXT,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                UNIQUE (mapping_id, relative_path, direction)
            );
            CREATE INDEX file_sync_operations_pending
                ON file_sync_operations (mapping_id, status, updated_at, id);
            CREATE TABLE file_sync_conflicts (
                mapping_id TEXT NOT NULL REFERENCES folder_mappings(id) ON DELETE CASCADE,
                relative_path TEXT NOT NULL,
                kind TEXT NOT NULL CHECK (kind IN (
                    'unbased-divergence', 'simultaneous-modification',
                    'deletion-not-propagated', 'direction-blocked'
                )),
                local_digest TEXT,
                remote_digest TEXT,
                detected_at TEXT NOT NULL,
                PRIMARY KEY (mapping_id, relative_path)
            );
            CREATE INDEX file_sync_conflicts_by_mapping
                ON file_sync_conflicts (mapping_id, detected_at, relative_path);
            PRAGMA user_version = 3;",
        )?;
        transaction.commit()?;
        Ok(())
    }

    fn migrate_v1_to_v2(&self) -> Result<(), MappingStoreError> {
        let transaction =
            Transaction::new_unchecked(&self.connection, TransactionBehavior::Immediate)?;
        transaction.execute_batch(
            "CREATE TABLE mapping_revisions (
                mapping_id TEXT PRIMARY KEY REFERENCES folder_mappings(id) ON DELETE CASCADE,
                revision INTEGER NOT NULL CHECK (revision > 0),
                event_id TEXT NOT NULL UNIQUE,
                author_device_id TEXT NOT NULL,
                paused INTEGER NOT NULL DEFAULT 0 CHECK (paused IN (0, 1)),
                created_at TEXT NOT NULL
            );
            CREATE TABLE mapping_tombstones (
                mapping_id TEXT PRIMARY KEY,
                deletion_event_id TEXT NOT NULL UNIQUE,
                deletion_revision INTEGER NOT NULL CHECK (deletion_revision > 0),
                deletion_timestamp TEXT NOT NULL,
                deleting_device_id TEXT NOT NULL,
                last_known_update_revision INTEGER NOT NULL CHECK (last_known_update_revision > 0),
                tombstone_created_at TEXT NOT NULL,
                initiator_device_id TEXT NOT NULL,
                responder_device_id TEXT NOT NULL
            );
            CREATE TABLE mapping_delivery_outbox (
                event_id TEXT NOT NULL,
                mapping_id TEXT NOT NULL,
                event_kind TEXT NOT NULL CHECK (event_kind IN ('active', 'tombstone')),
                revision INTEGER NOT NULL CHECK (revision > 0),
                target_device_id TEXT NOT NULL,
                event_json TEXT NOT NULL,
                created_at TEXT NOT NULL,
                acknowledged_at TEXT,
                PRIMARY KEY (event_id, target_device_id)
            );
            CREATE INDEX mapping_delivery_pending
                ON mapping_delivery_outbox (acknowledged_at, created_at, event_id);
            CREATE INDEX mapping_delivery_by_mapping
                ON mapping_delivery_outbox (mapping_id, acknowledged_at);
            CREATE TABLE mapping_legacy_import (
                singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
                state TEXT NOT NULL CHECK (state IN ('pending', 'completed', 'failed')),
                source_fingerprint TEXT,
                imported_count INTEGER NOT NULL DEFAULT 0 CHECK (imported_count >= 0),
                completed_at TEXT,
                last_error TEXT
            );
            INSERT INTO mapping_legacy_import (
                singleton, state, source_fingerprint, imported_count, completed_at, last_error
            ) VALUES (1, 'pending', NULL, 0, NULL, NULL);",
        )?;

        let legacy_rows = {
            let mut statement = transaction.prepare(V1_SELECT_COLUMNS)?;
            let rows = statement.query_map([], RawV1MappingRow::from_row)?;
            let mut collected = Vec::new();
            for row in rows {
                collected.push(row?);
            }
            collected
        };

        for raw in legacy_rows {
            let pending_delivery = raw.pending_delivery;
            let mapping = raw.into_configuration()?;
            mapping.validate()?;
            let author_device_id = if pending_delivery {
                mapping.responder_device_id.clone()
            } else {
                mapping.initiator_device_id.clone()
            };
            let event_id = make_event_id("v1", &mapping.id, 1, &author_device_id)?;
            write_revision(
                &transaction,
                &mapping.id,
                1,
                &event_id,
                &author_device_id,
                false,
                &mapping.updated_at,
            )?;
            if pending_delivery {
                let record = MappingRecord {
                    mapping: mapping.clone(),
                    revision: 1,
                    event_id: event_id.clone(),
                    author_device_id,
                    pending_delivery: false,
                };
                insert_delivery(
                    &transaction,
                    &MappingEvent::Active {
                        record: Box::new(record),
                    },
                    &mapping.initiator_device_id,
                    &mapping.updated_at,
                )?;
            }
        }

        transaction.execute_batch("PRAGMA user_version = 2;")?;
        transaction.commit()?;
        Ok(())
    }

    /// Reads the durable one-time legacy-import status.
    ///
    /// # Errors
    ///
    /// Returns a database or corrupt-metadata error if the status row is unavailable or invalid.
    pub fn legacy_migration_status(&self) -> Result<LegacyMigrationStatus, MappingStoreError> {
        read_migration_status(&self.connection)
    }

    /// Durably records a bounded legacy-import diagnostic without marking the import complete.
    ///
    /// # Errors
    ///
    /// Returns a database or corrupt-metadata error if the migration row cannot be updated.
    pub fn record_legacy_import_failure(&self, detail: &str) -> Result<(), MappingStoreError> {
        let current = self.legacy_migration_status()?;
        if current.state == LegacyMigrationState::Completed {
            return Ok(());
        }
        let sanitized: String = detail
            .chars()
            .filter(|character| *character != '\0')
            .take(MAX_MIGRATION_ERROR_LENGTH)
            .collect();
        self.connection.execute(
            "UPDATE mapping_legacy_import
             SET state = 'failed', last_error = ?1
             WHERE singleton = 1",
            params![sanitized],
        )?;
        Ok(())
    }

    /// Imports the legacy snapshot and reconciles any PR #4 rows in one transaction.
    ///
    /// # Errors
    ///
    /// Returns a validation, participant, tombstone, migration-state, or database error. No
    /// intended record commits unless the complete import and completion marker commit together.
    pub fn import_legacy(
        &self,
        request: &LegacyImportRequest,
    ) -> Result<LegacyImportOutcome, MappingStoreError> {
        let result = self.import_legacy_inner(request);
        if let Err(error) = &result {
            let _ = self.record_legacy_import_failure(&error.to_string());
        }
        result
    }

    #[allow(clippy::too_many_lines)]
    fn import_legacy_inner(
        &self,
        request: &LegacyImportRequest,
    ) -> Result<LegacyImportOutcome, MappingStoreError> {
        check_fingerprint(&request.source_fingerprint)?;
        check_identifier("importingDeviceId", &request.importing_device_id)?;
        check_timestamp("importedAt", &request.imported_at)?;
        let mut ids = HashSet::new();
        for record in &request.records {
            record.mapping.validate()?;
            if !ids.insert(record.mapping.id.clone()) {
                return Err(MappingStoreError::DuplicateMappingId(
                    record.mapping.id.clone(),
                ));
            }
            if !record.mapping.participant(&request.importing_device_id) {
                return Err(MappingStoreError::InvalidParticipant(format!(
                    "importing device is not a participant in mapping {:?}",
                    record.mapping.id
                )));
            }
            if let Some(target) = &record.pending_delivery_target_device_id {
                check_identifier("pendingDeliveryTargetDeviceId", target)?;
                let expected = record
                    .mapping
                    .other_participant(&request.importing_device_id)?;
                if target != expected {
                    return Err(MappingStoreError::InvalidParticipant(format!(
                        "pending-delivery target for mapping {:?} is not the other participant",
                        record.mapping.id
                    )));
                }
            }
        }

        let transaction =
            Transaction::new_unchecked(&self.connection, TransactionBehavior::Immediate)?;
        let current_status = read_migration_status(&transaction)?;
        if current_status.state == LegacyMigrationState::Completed {
            if current_status.source_fingerprint.as_deref()
                == Some(request.source_fingerprint.as_str())
            {
                return Ok(LegacyImportOutcome {
                    imported_count: usize::try_from(current_status.imported_count).unwrap_or(0),
                    tombstoned_count: 0,
                    already_completed: true,
                    status: current_status,
                });
            }
            return Err(MappingStoreError::LegacyImportAlreadyCompleted);
        }

        let existing = list_active_from(&transaction)?;
        let intended_ids: HashSet<&str> = request
            .records
            .iter()
            .map(|record| record.mapping.id.as_str())
            .collect();

        for record in &request.records {
            if tombstone_from(&transaction, &record.mapping.id)?.is_some() {
                return Err(MappingStoreError::Tombstoned(record.mapping.id.clone()));
            }
            if let Some(current) = active_from(&transaction, &record.mapping.id)? {
                ensure_same_participant_set(&current.mapping, &record.mapping)?;
            }
            let current_revision = revision_from(&transaction, &record.mapping.id)?.unwrap_or(0);
            let revision = current_revision
                .checked_add(1)
                .ok_or_else(|| MappingStoreError::Invalid("revision overflow".to_owned()))?;
            let event_id = make_event_id(
                "legacy",
                &record.mapping.id,
                revision,
                &request.importing_device_id,
            )?;
            let pending = record.pending_delivery_target_device_id.is_some();
            write_imported_mapping_row(&transaction, &record.mapping, pending)?;
            write_revision(
                &transaction,
                &record.mapping.id,
                revision,
                &event_id,
                &request.importing_device_id,
                record.mapping.paused,
                &request.imported_at,
            )?;
            if let Some(target) = &record.pending_delivery_target_device_id {
                let event = MappingEvent::Active {
                    record: Box::new(MappingRecord {
                        mapping: record.mapping.clone(),
                        revision,
                        event_id,
                        author_device_id: request.importing_device_id.clone(),
                        pending_delivery: false,
                    }),
                };
                insert_delivery(&transaction, &event, target, &request.imported_at)?;
            }
        }

        let mut tombstoned_count = 0;
        for current in existing {
            if intended_ids.contains(current.mapping.id.as_str()) {
                continue;
            }
            if !current.mapping.participant(&request.importing_device_id) {
                return Err(MappingStoreError::InvalidParticipant(format!(
                    "database mapping {:?} does not include the importing device",
                    current.mapping.id
                )));
            }
            let tombstone = tombstone_for_record(
                &current,
                &request.importing_device_id,
                &request.imported_at,
                "legacy-remove",
            )?;
            let target = current
                .mapping
                .other_participant(&request.importing_device_id)?;
            write_tombstone(&transaction, &tombstone)?;
            transaction.execute(
                "DELETE FROM folder_mappings WHERE id = ?1",
                params![current.mapping.id],
            )?;
            insert_delivery(
                &transaction,
                &MappingEvent::Tombstone { tombstone },
                target,
                &request.imported_at,
            )?;
            tombstoned_count += 1;
        }

        let imported_count = i64::try_from(request.records.len()).map_err(|_| {
            MappingStoreError::Invalid("legacy import contains too many mappings".to_owned())
        })?;
        transaction.execute(
            "UPDATE mapping_legacy_import
             SET state = 'completed', source_fingerprint = ?1, imported_count = ?2,
                 completed_at = ?3, last_error = NULL
             WHERE singleton = 1",
            params![
                request.source_fingerprint,
                imported_count,
                request.imported_at
            ],
        )?;
        transaction.commit()?;

        Ok(LegacyImportOutcome {
            status: self.legacy_migration_status()?,
            imported_count: request.records.len(),
            tombstoned_count,
            already_completed: false,
        })
    }

    /// Lists active mappings only. A healthy empty database returns an empty vector; every
    /// unavailable or incomplete authority state returns an error instead.
    ///
    /// # Errors
    ///
    /// Returns a migration-state, database, or corrupt-record error.
    pub fn list(&self) -> Result<Vec<MappingRecord>, MappingStoreError> {
        self.ensure_import_completed()?;
        list_active_from(&self.connection)
    }

    /// Gets one active mapping. Tombstoned ids return `None` and are never projected as active.
    ///
    /// # Errors
    ///
    /// Returns a validation, migration-state, database, or corrupt-record error.
    pub fn get(&self, id: &str) -> Result<Option<MappingRecord>, MappingStoreError> {
        self.ensure_import_completed()?;
        check_identifier("id", id)?;
        active_from(&self.connection, id)
    }

    /// Gets durable deletion evidence for one mapping id.
    ///
    /// # Errors
    ///
    /// Returns a validation, migration-state, database, or corrupt-record error.
    pub fn get_tombstone(&self, id: &str) -> Result<Option<MappingTombstone>, MappingStoreError> {
        self.ensure_import_completed()?;
        check_identifier("id", id)?;
        tombstone_from(&self.connection, id)
    }

    /// Creates or updates a local mapping and its exact delivery event atomically.
    ///
    /// # Errors
    ///
    /// Returns a validation, participant, stale-revision, tombstone, migration-state, or database
    /// error. No active row is changed when an error is returned.
    pub fn upsert_local(
        &self,
        mapping: &MappingConfiguration,
        author_device_id: &str,
        delivery_target_device_id: Option<&str>,
        expected_revision: Option<i64>,
        occurred_at: &str,
    ) -> Result<MappingRecord, MappingStoreError> {
        self.ensure_import_completed()?;
        mapping.validate()?;
        check_identifier("authorDeviceId", author_device_id)?;
        if let Some(expected_revision) = expected_revision {
            check_revision(expected_revision)?;
        }
        check_timestamp("occurredAt", occurred_at)?;
        if !mapping.participant(author_device_id) {
            return Err(MappingStoreError::InvalidParticipant(format!(
                "author is not a participant in mapping {:?}",
                mapping.id
            )));
        }
        if let Some(target) = delivery_target_device_id {
            check_identifier("deliveryTargetDeviceId", target)?;
            if target != mapping.other_participant(author_device_id)? {
                return Err(MappingStoreError::InvalidParticipant(
                    "delivery target is not the other mapping participant".to_owned(),
                ));
            }
        }

        let transaction =
            Transaction::new_unchecked(&self.connection, TransactionBehavior::Immediate)?;
        if tombstone_from(&transaction, &mapping.id)?.is_some() {
            return Err(MappingStoreError::Tombstoned(mapping.id.clone()));
        }
        let current = active_from(&transaction, &mapping.id)?;
        if let Some(current) = &current {
            ensure_same_participants(&current.mapping, mapping)?;
        }
        let found_revision = current.as_ref().map(|record| record.revision);
        if expected_revision != found_revision {
            return Err(MappingStoreError::StaleRevision {
                expected: expected_revision,
                found: found_revision,
            });
        }
        let revision = found_revision
            .unwrap_or(0)
            .checked_add(1)
            .ok_or_else(|| MappingStoreError::Invalid("revision overflow".to_owned()))?;
        let event_id = make_event_id("active", &mapping.id, revision, author_device_id)?;
        write_mapping_row(&transaction, mapping, delivery_target_device_id.is_some())?;
        write_revision(
            &transaction,
            &mapping.id,
            revision,
            &event_id,
            author_device_id,
            mapping.paused,
            occurred_at,
        )?;
        if let Some(target) = delivery_target_device_id {
            let event = MappingEvent::Active {
                record: Box::new(MappingRecord {
                    mapping: mapping.clone(),
                    revision,
                    event_id: event_id.clone(),
                    author_device_id: author_device_id.to_owned(),
                    pending_delivery: false,
                }),
            };
            insert_delivery(&transaction, &event, target, occurred_at)?;
        }
        transaction.commit()?;
        self.get(&mapping.id)?
            .ok_or_else(|| MappingStoreError::CorruptMetadata {
                id: mapping.id.clone(),
                detail: "committed mapping disappeared".to_owned(),
            })
    }

    /// Replaces an active row with a durable, terminal tombstone in one transaction.
    ///
    /// # Errors
    ///
    /// Returns a validation, participant, stale-revision, not-found, migration-state, or database
    /// error. No active row is removed unless its tombstone and outbox event commit.
    pub fn remove_local(
        &self,
        id: &str,
        deleting_device_id: &str,
        delivery_target_device_id: Option<&str>,
        expected_revision: i64,
        occurred_at: &str,
    ) -> Result<MappingTombstone, MappingStoreError> {
        self.ensure_import_completed()?;
        check_identifier("id", id)?;
        check_identifier("deletingDeviceId", deleting_device_id)?;
        check_revision(expected_revision)?;
        check_timestamp("occurredAt", occurred_at)?;

        let transaction =
            Transaction::new_unchecked(&self.connection, TransactionBehavior::Immediate)?;
        if let Some(existing) = tombstone_from(&transaction, id)? {
            if !existing.participant(deleting_device_id) {
                return Err(MappingStoreError::InvalidParticipant(
                    "deleting device is not a mapping participant".to_owned(),
                ));
            }
            if existing.last_known_update_revision != expected_revision {
                return Err(MappingStoreError::StaleRevision {
                    expected: Some(expected_revision),
                    found: Some(existing.last_known_update_revision),
                });
            }
            if let Some(target) = delivery_target_device_id {
                check_identifier("deliveryTargetDeviceId", target)?;
                let other = if existing.initiator_device_id == deleting_device_id {
                    &existing.responder_device_id
                } else {
                    &existing.initiator_device_id
                };
                if target != other {
                    return Err(MappingStoreError::InvalidParticipant(
                        "delivery target is not the other mapping participant".to_owned(),
                    ));
                }
            }
            return Ok(existing);
        }
        let current = active_from(&transaction, id)?
            .ok_or_else(|| MappingStoreError::NotFound(id.to_owned()))?;
        if !current.mapping.participant(deleting_device_id) {
            return Err(MappingStoreError::InvalidParticipant(
                "deleting device is not a mapping participant".to_owned(),
            ));
        }
        if current.revision != expected_revision {
            return Err(MappingStoreError::StaleRevision {
                expected: Some(expected_revision),
                found: Some(current.revision),
            });
        }
        if let Some(target) = delivery_target_device_id {
            check_identifier("deliveryTargetDeviceId", target)?;
            if target != current.mapping.other_participant(deleting_device_id)? {
                return Err(MappingStoreError::InvalidParticipant(
                    "delivery target is not the other mapping participant".to_owned(),
                ));
            }
        }
        let tombstone =
            tombstone_for_record(&current, deleting_device_id, occurred_at, "tombstone")?;
        write_tombstone(&transaction, &tombstone)?;
        transaction.execute("DELETE FROM folder_mappings WHERE id = ?1", params![id])?;
        if let Some(target) = delivery_target_device_id {
            transaction.execute(
                "DELETE FROM mapping_delivery_outbox
                 WHERE mapping_id = ?1 AND target_device_id = ?2
                   AND event_kind = 'active' AND acknowledged_at IS NULL",
                params![id, target],
            )?;
            insert_delivery(
                &transaction,
                &MappingEvent::Tombstone {
                    tombstone: tombstone.clone(),
                },
                target,
                occurred_at,
            )?;
        }
        transaction.commit()?;
        Ok(tombstone)
    }

    /// Applies an event received from the named authenticated peer. Device identities must match
    /// both the event author and the mapping participants before any row changes.
    ///
    /// # Errors
    ///
    /// Returns a validation, participant, migration-state, corrupt-record, or database error.
    #[allow(clippy::too_many_lines)]
    pub fn apply_remote(
        &self,
        event: &MappingEvent,
        authenticated_peer_device_id: &str,
        local_device_id: &str,
    ) -> Result<ApplyOutcome, MappingStoreError> {
        self.ensure_import_completed()?;
        event.validate()?;
        check_identifier("authenticatedPeerDeviceId", authenticated_peer_device_id)?;
        check_identifier("localDeviceId", local_device_id)?;
        let (initiator, responder) = event.participants();
        if authenticated_peer_device_id == local_device_id
            || event.author_device_id() != authenticated_peer_device_id
            || !(initiator == authenticated_peer_device_id
                || responder == authenticated_peer_device_id)
            || !(initiator == local_device_id || responder == local_device_id)
        {
            return Err(MappingStoreError::InvalidParticipant(
                "authenticated peer and local device must be the event's two participants"
                    .to_owned(),
            ));
        }

        let transaction =
            Transaction::new_unchecked(&self.connection, TransactionBehavior::Immediate)?;
        let outcome = match event {
            MappingEvent::Active { record } => {
                if tombstone_from(&transaction, &record.mapping.id)?.is_some() {
                    ApplyOutcome {
                        status: ApplyStatus::Tombstoned,
                        mapping_id: record.mapping.id.clone(),
                        event_id: record.event_id.clone(),
                        revision: record.revision,
                    }
                } else if let Some(current) = active_from(&transaction, &record.mapping.id)? {
                    ensure_same_participants(&current.mapping, &record.mapping)?;
                    match compare_events(
                        record.revision,
                        &record.event_id,
                        current.revision,
                        &current.event_id,
                    ) {
                        Ordering::Less => ApplyOutcome {
                            status: ApplyStatus::Stale,
                            mapping_id: record.mapping.id.clone(),
                            event_id: record.event_id.clone(),
                            revision: record.revision,
                        },
                        Ordering::Equal => {
                            if current.mapping != record.mapping
                                || current.author_device_id != record.author_device_id
                            {
                                return Err(MappingStoreError::ConflictingEvent {
                                    mapping_id: record.mapping.id.clone(),
                                    event_id: record.event_id.clone(),
                                });
                            }
                            ApplyOutcome {
                                status: ApplyStatus::Duplicate,
                                mapping_id: record.mapping.id.clone(),
                                event_id: record.event_id.clone(),
                                revision: record.revision,
                            }
                        }
                        Ordering::Greater => {
                            apply_active_record(&transaction, record)?;
                            ApplyOutcome {
                                status: ApplyStatus::Applied,
                                mapping_id: record.mapping.id.clone(),
                                event_id: record.event_id.clone(),
                                revision: record.revision,
                            }
                        }
                    }
                } else {
                    apply_active_record(&transaction, record)?;
                    ApplyOutcome {
                        status: ApplyStatus::Applied,
                        mapping_id: record.mapping.id.clone(),
                        event_id: record.event_id.clone(),
                        revision: record.revision,
                    }
                }
            }
            MappingEvent::Tombstone { tombstone } => {
                let status = if let Some(current) =
                    tombstone_from(&transaction, &tombstone.mapping_id)?
                {
                    match compare_events(
                        tombstone.deletion_revision,
                        &tombstone.deletion_event_id,
                        current.deletion_revision,
                        &current.deletion_event_id,
                    ) {
                        Ordering::Less => ApplyStatus::Stale,
                        Ordering::Equal => {
                            if current != *tombstone {
                                return Err(MappingStoreError::ConflictingEvent {
                                    mapping_id: tombstone.mapping_id.clone(),
                                    event_id: tombstone.deletion_event_id.clone(),
                                });
                            }
                            ApplyStatus::Duplicate
                        }
                        Ordering::Greater => {
                            write_tombstone(&transaction, tombstone)?;
                            ApplyStatus::Applied
                        }
                    }
                } else {
                    if let Some(active) = active_from(&transaction, &tombstone.mapping_id)? {
                        if active.mapping.initiator_device_id != tombstone.initiator_device_id
                            || active.mapping.responder_device_id != tombstone.responder_device_id
                        {
                            return Err(MappingStoreError::InvalidParticipant(
                                "tombstone participants do not match the active mapping".to_owned(),
                            ));
                        }
                    }
                    write_tombstone(&transaction, tombstone)?;
                    ApplyStatus::Applied
                };
                // Tombstones are terminal for a mapping id, even if an active update was delivered
                // concurrently with a higher wall-clock timestamp. Revision/event ordering is used
                // between tombstones; wall clocks never revive an id.
                if matches!(status, ApplyStatus::Applied | ApplyStatus::Duplicate) {
                    transaction.execute(
                        "DELETE FROM folder_mappings WHERE id = ?1",
                        params![tombstone.mapping_id],
                    )?;
                }
                ApplyOutcome {
                    status,
                    mapping_id: tombstone.mapping_id.clone(),
                    event_id: tombstone.deletion_event_id.clone(),
                    revision: tombstone.deletion_revision,
                }
            }
        };
        transaction.commit()?;
        Ok(outcome)
    }

    /// Lists unacknowledged, immutable mapping-configuration outbox events.
    ///
    /// # Errors
    ///
    /// Returns a migration-state, database, serialisation, or corrupt-record error.
    pub fn list_pending_delivery(&self) -> Result<Vec<MappingDelivery>, MappingStoreError> {
        self.ensure_import_completed()?;
        let mut statement = self.connection.prepare(
            "SELECT mapping_id, event_id, revision, target_device_id, event_json, created_at
             FROM mapping_delivery_outbox
             WHERE acknowledged_at IS NULL
             ORDER BY created_at ASC, event_id ASC, target_device_id ASC",
        )?;
        let rows = statement.query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, i64>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, String>(4)?,
                row.get::<_, String>(5)?,
            ))
        })?;
        let mut deliveries = Vec::new();
        for row in rows {
            let (mapping_id, event_id, revision, target_device_id, event_json, created_at) = row?;
            let event: MappingEvent = serde_json::from_str(&event_json).map_err(|source| {
                MappingStoreError::CorruptRecord {
                    id: mapping_id.clone(),
                    column: "event_json",
                    source,
                }
            })?;
            if event.mapping_id() != mapping_id
                || event.event_id() != event_id
                || event.revision() != revision
            {
                return Err(MappingStoreError::CorruptMetadata {
                    id: mapping_id,
                    detail: "outbox identity does not match its event payload".to_owned(),
                });
            }
            deliveries.push(MappingDelivery {
                mapping_id,
                event_id,
                revision,
                target_device_id,
                event,
                created_at,
            });
        }
        Ok(deliveries)
    }

    /// Clears one pending item only when the authenticated peer acknowledgement matches its full
    /// identity. Duplicate acknowledgements are idempotent; stale/mismatched ones are rejected.
    ///
    /// # Errors
    ///
    /// Returns a validation, acknowledgement-mismatch, migration-state, or database error.
    pub fn acknowledge_delivery(
        &self,
        mapping_id: &str,
        event_id: &str,
        revision: i64,
        authenticated_peer_device_id: &str,
        acknowledged_at: &str,
    ) -> Result<AcknowledgeOutcome, MappingStoreError> {
        self.ensure_import_completed()?;
        check_identifier("mappingId", mapping_id)?;
        check_event_id(event_id)?;
        check_revision(revision)?;
        check_identifier("authenticatedPeerDeviceId", authenticated_peer_device_id)?;
        check_timestamp("acknowledgedAt", acknowledged_at)?;
        let transaction =
            Transaction::new_unchecked(&self.connection, TransactionBehavior::Immediate)?;
        let acknowledged: Option<Option<String>> = transaction
            .query_row(
                "SELECT acknowledged_at FROM mapping_delivery_outbox
                 WHERE mapping_id = ?1 AND event_id = ?2 AND revision = ?3
                   AND target_device_id = ?4",
                params![mapping_id, event_id, revision, authenticated_peer_device_id],
                |row| row.get(0),
            )
            .optional()?;
        let Some(previous_acknowledgement) = acknowledged else {
            return Err(MappingStoreError::AcknowledgementMismatch);
        };
        let status = if previous_acknowledgement.is_some() {
            AcknowledgeStatus::AlreadyAcknowledged
        } else {
            transaction.execute(
                "UPDATE mapping_delivery_outbox SET acknowledged_at = ?1
                 WHERE mapping_id = ?2 AND event_id = ?3 AND revision = ?4
                   AND target_device_id = ?5 AND acknowledged_at IS NULL",
                params![
                    acknowledged_at,
                    mapping_id,
                    event_id,
                    revision,
                    authenticated_peer_device_id
                ],
            )?;
            AcknowledgeStatus::Acknowledged
        };
        transaction.execute(
            "UPDATE folder_mappings
             SET pending_delivery = CASE WHEN EXISTS (
                 SELECT 1 FROM mapping_delivery_outbox delivery
                 WHERE delivery.mapping_id = folder_mappings.id
                   AND delivery.acknowledged_at IS NULL
             ) THEN 1 ELSE 0 END
             WHERE id = ?1",
            params![mapping_id],
        )?;
        transaction.commit()?;
        Ok(AcknowledgeOutcome {
            status,
            mapping_id: mapping_id.to_owned(),
            event_id: event_id.to_owned(),
            revision,
        })
    }

    pub(crate) fn ensure_import_completed(&self) -> Result<(), MappingStoreError> {
        let status = self.legacy_migration_status()?;
        match status.state {
            LegacyMigrationState::Completed => Ok(()),
            LegacyMigrationState::Pending => Err(MappingStoreError::MigrationRequired),
            LegacyMigrationState::Failed => Err(MappingStoreError::MigrationFailed(
                status
                    .last_error
                    .unwrap_or_else(|| "the previous attempt did not commit".to_owned()),
            )),
        }
    }
}

fn revision_from(connection: &Connection, id: &str) -> Result<Option<i64>, MappingStoreError> {
    Ok(connection
        .query_row(
            "SELECT revision FROM mapping_revisions WHERE mapping_id = ?1",
            params![id],
            |row| row.get(0),
        )
        .optional()?)
}

fn read_migration_status(
    connection: &Connection,
) -> Result<LegacyMigrationStatus, MappingStoreError> {
    let (state, source_fingerprint, imported_count, completed_at, last_error): (
        String,
        Option<String>,
        i64,
        Option<String>,
        Option<String>,
    ) = connection.query_row(
        "SELECT state, source_fingerprint, imported_count, completed_at, last_error
         FROM mapping_legacy_import WHERE singleton = 1",
        [],
        |row| {
            Ok((
                row.get(0)?,
                row.get(1)?,
                row.get(2)?,
                row.get(3)?,
                row.get(4)?,
            ))
        },
    )?;
    Ok(LegacyMigrationStatus {
        state: LegacyMigrationState::parse(&state)?,
        source_fingerprint,
        imported_count,
        completed_at,
        last_error,
    })
}

fn make_event_id(
    kind: &str,
    mapping_id: &str,
    revision: i64,
    author_device_id: &str,
) -> Result<String, MappingStoreError> {
    let event_id = format!("{kind}:{mapping_id}:{revision}:{author_device_id}");
    check_event_id(&event_id)?;
    Ok(event_id)
}

fn compare_events(
    incoming_revision: i64,
    incoming_event_id: &str,
    current_revision: i64,
    current_event_id: &str,
) -> Ordering {
    incoming_revision
        .cmp(&current_revision)
        .then_with(|| incoming_event_id.cmp(current_event_id))
}

fn ensure_same_participants(
    current: &MappingConfiguration,
    incoming: &MappingConfiguration,
) -> Result<(), MappingStoreError> {
    if current.initiator_device_id != incoming.initiator_device_id
        || current.responder_device_id != incoming.responder_device_id
    {
        return Err(MappingStoreError::InvalidParticipant(format!(
            "mapping {:?} cannot change participants",
            current.id
        )));
    }
    if current.created_at != incoming.created_at {
        return Err(MappingStoreError::Invalid(
            "createdAt cannot change after a mapping is created".to_owned(),
        ));
    }
    Ok(())
}

/// The legacy JSON snapshot did not retain initiator/responder orientation. During the one-time
/// import only, the same two device ids may be deterministically reordered; normal updates keep
/// the stricter positional participant check above.
fn ensure_same_participant_set(
    current: &MappingConfiguration,
    incoming: &MappingConfiguration,
) -> Result<(), MappingStoreError> {
    let same_order = current.initiator_device_id == incoming.initiator_device_id
        && current.responder_device_id == incoming.responder_device_id;
    let reverse_order = current.initiator_device_id == incoming.responder_device_id
        && current.responder_device_id == incoming.initiator_device_id;
    if !same_order && !reverse_order {
        return Err(MappingStoreError::InvalidParticipant(format!(
            "mapping {:?} cannot change participants during legacy import",
            current.id
        )));
    }
    Ok(())
}

fn write_mapping_row(
    transaction: &Transaction<'_>,
    mapping: &MappingConfiguration,
    pending_delivery: bool,
) -> Result<(), MappingStoreError> {
    let ignore_patterns = serde_json::to_string(&mapping.ignore_patterns)?;
    let preview = mapping
        .preview
        .as_ref()
        .map(serde_json::to_string)
        .transpose()?;
    transaction.execute(
        "INSERT INTO folder_mappings (
            id, name, initiator_device_id, initiator_device_name,
            responder_device_id, responder_device_name,
            initiator_path, responder_path, mode, ignore_patterns,
            history_days, history_max_bytes, max_file_bytes, setup_status, pending_delivery,
            preview, created_at, updated_at
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18)
        ON CONFLICT(id) DO UPDATE SET
            name = excluded.name,
            initiator_device_id = excluded.initiator_device_id,
            initiator_device_name = excluded.initiator_device_name,
            responder_device_id = excluded.responder_device_id,
            responder_device_name = excluded.responder_device_name,
            initiator_path = excluded.initiator_path,
            responder_path = excluded.responder_path,
            mode = excluded.mode,
            ignore_patterns = excluded.ignore_patterns,
            history_days = excluded.history_days,
            history_max_bytes = excluded.history_max_bytes,
            max_file_bytes = excluded.max_file_bytes,
            setup_status = excluded.setup_status,
            pending_delivery = excluded.pending_delivery,
            preview = excluded.preview,
            updated_at = excluded.updated_at",
        params![
            mapping.id,
            mapping.name,
            mapping.initiator_device_id,
            mapping.initiator_device_name,
            mapping.responder_device_id,
            mapping.responder_device_name,
            mapping.initiator_path,
            mapping.responder_path,
            mapping.mode,
            ignore_patterns,
            mapping.history_days,
            mapping.history_max_bytes,
            mapping.max_file_bytes,
            mapping.setup_status,
            pending_delivery,
            preview,
            mapping.created_at,
            mapping.updated_at,
        ],
    )?;
    Ok(())
}

/// Legacy JSON remains authoritative until the one-time import commits, so it must replace every
/// persisted configuration field, including `created_at`. Normal local and remote updates keep
/// `created_at` immutable through `ensure_same_participants`.
fn write_imported_mapping_row(
    transaction: &Transaction<'_>,
    mapping: &MappingConfiguration,
    pending_delivery: bool,
) -> Result<(), MappingStoreError> {
    write_mapping_row(transaction, mapping, pending_delivery)?;
    let changed = transaction.execute(
        "UPDATE folder_mappings SET created_at = ?1 WHERE id = ?2",
        params![mapping.created_at, mapping.id],
    )?;
    if changed != 1 {
        return Err(MappingStoreError::CorruptMetadata {
            id: mapping.id.clone(),
            detail: "legacy import could not replace the mapping creation timestamp".to_owned(),
        });
    }
    Ok(())
}

#[allow(clippy::too_many_arguments)]
fn write_revision(
    transaction: &Transaction<'_>,
    mapping_id: &str,
    revision: i64,
    event_id: &str,
    author_device_id: &str,
    paused: bool,
    created_at: &str,
) -> Result<(), MappingStoreError> {
    transaction.execute(
        "INSERT INTO mapping_revisions (
            mapping_id, revision, event_id, author_device_id, paused, created_at
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6)
         ON CONFLICT(mapping_id) DO UPDATE SET
            revision = excluded.revision,
            event_id = excluded.event_id,
            author_device_id = excluded.author_device_id,
            paused = excluded.paused,
            created_at = excluded.created_at",
        params![
            mapping_id,
            revision,
            event_id,
            author_device_id,
            paused,
            created_at
        ],
    )?;
    Ok(())
}

fn apply_active_record(
    transaction: &Transaction<'_>,
    record: &MappingRecord,
) -> Result<(), MappingStoreError> {
    write_mapping_row(transaction, &record.mapping, false)?;
    write_revision(
        transaction,
        &record.mapping.id,
        record.revision,
        &record.event_id,
        &record.author_device_id,
        record.mapping.paused,
        &record.mapping.updated_at,
    )
}

fn tombstone_for_record(
    record: &MappingRecord,
    deleting_device_id: &str,
    occurred_at: &str,
    event_kind: &str,
) -> Result<MappingTombstone, MappingStoreError> {
    let deletion_revision = record
        .revision
        .checked_add(1)
        .ok_or_else(|| MappingStoreError::Invalid("revision overflow".to_owned()))?;
    Ok(MappingTombstone {
        mapping_id: record.mapping.id.clone(),
        deletion_event_id: make_event_id(
            event_kind,
            &record.mapping.id,
            deletion_revision,
            deleting_device_id,
        )?,
        deletion_revision,
        deletion_timestamp: occurred_at.to_owned(),
        deleting_device_id: deleting_device_id.to_owned(),
        last_known_update_revision: record.revision,
        tombstone_created_at: occurred_at.to_owned(),
        initiator_device_id: record.mapping.initiator_device_id.clone(),
        responder_device_id: record.mapping.responder_device_id.clone(),
    })
}

fn write_tombstone(
    transaction: &Transaction<'_>,
    tombstone: &MappingTombstone,
) -> Result<(), MappingStoreError> {
    tombstone.validate()?;
    transaction.execute(
        "INSERT INTO mapping_tombstones (
            mapping_id, deletion_event_id, deletion_revision, deletion_timestamp,
            deleting_device_id, last_known_update_revision, tombstone_created_at,
            initiator_device_id, responder_device_id
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
         ON CONFLICT(mapping_id) DO UPDATE SET
            deletion_event_id = excluded.deletion_event_id,
            deletion_revision = excluded.deletion_revision,
            deletion_timestamp = excluded.deletion_timestamp,
            deleting_device_id = excluded.deleting_device_id,
            last_known_update_revision = excluded.last_known_update_revision,
            tombstone_created_at = excluded.tombstone_created_at,
            initiator_device_id = excluded.initiator_device_id,
            responder_device_id = excluded.responder_device_id",
        params![
            tombstone.mapping_id,
            tombstone.deletion_event_id,
            tombstone.deletion_revision,
            tombstone.deletion_timestamp,
            tombstone.deleting_device_id,
            tombstone.last_known_update_revision,
            tombstone.tombstone_created_at,
            tombstone.initiator_device_id,
            tombstone.responder_device_id,
        ],
    )?;
    Ok(())
}

fn insert_delivery(
    transaction: &Transaction<'_>,
    event: &MappingEvent,
    target_device_id: &str,
    created_at: &str,
) -> Result<(), MappingStoreError> {
    check_identifier("targetDeviceId", target_device_id)?;
    check_timestamp("createdAt", created_at)?;
    event.validate()?;
    let event_json = serde_json::to_string(event)?;
    let event_kind = match event {
        MappingEvent::Active { .. } => "active",
        MappingEvent::Tombstone { .. } => "tombstone",
    };
    let inserted = transaction.execute(
        "INSERT INTO mapping_delivery_outbox (
            event_id, mapping_id, event_kind, revision, target_device_id,
            event_json, created_at, acknowledged_at
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, NULL)
         ON CONFLICT(event_id, target_device_id) DO NOTHING",
        params![
            event.event_id(),
            event.mapping_id(),
            event_kind,
            event.revision(),
            target_device_id,
            event_json,
            created_at,
        ],
    )?;
    if inserted == 0 {
        let (existing_mapping_id, existing_revision, existing_json): (String, i64, String) =
            transaction.query_row(
                "SELECT mapping_id, revision, event_json
                 FROM mapping_delivery_outbox
                 WHERE event_id = ?1 AND target_device_id = ?2",
                params![event.event_id(), target_device_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )?;
        let existing_event: MappingEvent =
            serde_json::from_str(&existing_json).map_err(|source| {
                MappingStoreError::CorruptRecord {
                    id: existing_mapping_id.clone(),
                    column: "event_json",
                    source,
                }
            })?;
        if existing_mapping_id != event.mapping_id()
            || existing_revision != event.revision()
            || existing_event != *event
        {
            return Err(MappingStoreError::ConflictingEvent {
                mapping_id: event.mapping_id().to_owned(),
                event_id: event.event_id().to_owned(),
            });
        }
    }
    Ok(())
}

fn active_from(
    connection: &Connection,
    id: &str,
) -> Result<Option<MappingRecord>, MappingStoreError> {
    let row = connection
        .query_row(
            &format!("{ACTIVE_SELECT_COLUMNS} WHERE mapping.id = ?1"),
            params![id],
            RawActiveRow::from_row,
        )
        .optional()?;
    row.map(RawActiveRow::into_record).transpose()
}

fn list_active_from(connection: &Connection) -> Result<Vec<MappingRecord>, MappingStoreError> {
    let mut statement = connection.prepare(&format!(
        "{ACTIVE_SELECT_COLUMNS} ORDER BY mapping.created_at ASC, mapping.id ASC"
    ))?;
    let rows = statement.query_map([], RawActiveRow::from_row)?;
    let mut records = Vec::new();
    for row in rows {
        records.push(row?.into_record()?);
    }
    Ok(records)
}

fn tombstone_from(
    connection: &Connection,
    id: &str,
) -> Result<Option<MappingTombstone>, MappingStoreError> {
    Ok(connection
        .query_row(
            "SELECT mapping_id, deletion_event_id, deletion_revision, deletion_timestamp,
                    deleting_device_id, last_known_update_revision, tombstone_created_at,
                    initiator_device_id, responder_device_id
             FROM mapping_tombstones WHERE mapping_id = ?1",
            params![id],
            |row| {
                Ok(MappingTombstone {
                    mapping_id: row.get(0)?,
                    deletion_event_id: row.get(1)?,
                    deletion_revision: row.get(2)?,
                    deletion_timestamp: row.get(3)?,
                    deleting_device_id: row.get(4)?,
                    last_known_update_revision: row.get(5)?,
                    tombstone_created_at: row.get(6)?,
                    initiator_device_id: row.get(7)?,
                    responder_device_id: row.get(8)?,
                })
            },
        )
        .optional()?)
}

struct RawV1MappingRow {
    id: String,
    name: String,
    initiator_device_id: String,
    initiator_device_name: String,
    responder_device_id: String,
    responder_device_name: String,
    initiator_path: String,
    responder_path: String,
    mode: String,
    ignore_patterns: String,
    history_days: i64,
    history_max_bytes: i64,
    // Only populated by `RawActiveRow::from_row`, which reads the current (post-v5) schema.
    // `V1_SELECT_COLUMNS` reads the historical pre-v5 table shape during the v1-to-v2 migration,
    // where this column never existed, so `RawV1MappingRow::from_row` always sets this to `None`.
    max_file_bytes: Option<i64>,
    setup_status: String,
    pending_delivery: bool,
    preview: Option<String>,
    created_at: String,
    updated_at: String,
}

impl RawV1MappingRow {
    fn from_row(row: &Row<'_>) -> rusqlite::Result<Self> {
        Ok(Self {
            id: row.get(0)?,
            name: row.get(1)?,
            initiator_device_id: row.get(2)?,
            initiator_device_name: row.get(3)?,
            responder_device_id: row.get(4)?,
            responder_device_name: row.get(5)?,
            initiator_path: row.get(6)?,
            responder_path: row.get(7)?,
            mode: row.get(8)?,
            ignore_patterns: row.get(9)?,
            history_days: row.get(10)?,
            history_max_bytes: row.get(11)?,
            max_file_bytes: None,
            setup_status: row.get(12)?,
            pending_delivery: row.get(13)?,
            preview: row.get(14)?,
            created_at: row.get(15)?,
            updated_at: row.get(16)?,
        })
    }

    fn into_configuration(self) -> Result<MappingConfiguration, MappingStoreError> {
        let ignore_patterns = serde_json::from_str(&self.ignore_patterns).map_err(|source| {
            MappingStoreError::CorruptRecord {
                id: self.id.clone(),
                column: "ignore_patterns",
                source,
            }
        })?;
        let preview = self
            .preview
            .as_deref()
            .map(serde_json::from_str)
            .transpose()
            .map_err(|source| MappingStoreError::CorruptRecord {
                id: self.id.clone(),
                column: "preview",
                source,
            })?;
        Ok(MappingConfiguration {
            id: self.id,
            name: self.name,
            initiator_device_id: self.initiator_device_id,
            initiator_device_name: self.initiator_device_name,
            responder_device_id: self.responder_device_id,
            responder_device_name: self.responder_device_name,
            initiator_path: self.initiator_path,
            responder_path: self.responder_path,
            mode: self.mode,
            ignore_patterns,
            history_days: self.history_days,
            history_max_bytes: self.history_max_bytes,
            max_file_bytes: self.max_file_bytes,
            setup_status: self.setup_status,
            paused: false,
            preview,
            created_at: self.created_at,
            updated_at: self.updated_at,
        })
    }
}

struct RawActiveRow {
    v1: RawV1MappingRow,
    paused: Option<bool>,
    revision: Option<i64>,
    event_id: Option<String>,
    author_device_id: Option<String>,
    pending_delivery: bool,
}

impl RawActiveRow {
    fn from_row(row: &Row<'_>) -> rusqlite::Result<Self> {
        Ok(Self {
            v1: RawV1MappingRow {
                id: row.get(0)?,
                name: row.get(1)?,
                initiator_device_id: row.get(2)?,
                initiator_device_name: row.get(3)?,
                responder_device_id: row.get(4)?,
                responder_device_name: row.get(5)?,
                initiator_path: row.get(6)?,
                responder_path: row.get(7)?,
                mode: row.get(8)?,
                ignore_patterns: row.get(9)?,
                history_days: row.get(10)?,
                history_max_bytes: row.get(11)?,
                max_file_bytes: row.get(12)?,
                setup_status: row.get(13)?,
                pending_delivery: false,
                preview: row.get(14)?,
                created_at: row.get(15)?,
                updated_at: row.get(16)?,
            },
            paused: row.get(17)?,
            revision: row.get(18)?,
            event_id: row.get(19)?,
            author_device_id: row.get(20)?,
            pending_delivery: row.get(21)?,
        })
    }

    fn into_record(self) -> Result<MappingRecord, MappingStoreError> {
        let id = self.v1.id.clone();
        let mut mapping = self.v1.into_configuration()?;
        let paused = self
            .paused
            .ok_or_else(|| MappingStoreError::CorruptMetadata {
                id: id.clone(),
                detail: "missing mapping_revisions row".to_owned(),
            })?;
        mapping.paused = paused;
        let revision = self
            .revision
            .ok_or_else(|| MappingStoreError::CorruptMetadata {
                id: id.clone(),
                detail: "missing revision".to_owned(),
            })?;
        let event_id = self
            .event_id
            .ok_or_else(|| MappingStoreError::CorruptMetadata {
                id: id.clone(),
                detail: "missing event id".to_owned(),
            })?;
        let author_device_id =
            self.author_device_id
                .ok_or_else(|| MappingStoreError::CorruptMetadata {
                    id,
                    detail: "missing author device id".to_owned(),
                })?;
        let record = MappingRecord {
            mapping,
            revision,
            event_id,
            author_device_id,
            pending_delivery: self.pending_delivery,
        };
        record.validate_event()?;
        Ok(record)
    }
}

#[cfg(test)]
mod tests {
    use std::fs;

    use rusqlite::{Transaction, TransactionBehavior};

    use super::{
        AcknowledgeStatus, ApplyStatus, LegacyImportRecord, LegacyImportRequest,
        LegacyMigrationState, MappingConfiguration, MappingEvent, MappingRecord, MappingStore,
        MappingStoreError, MappingTombstone, SCHEMA_VERSION, insert_delivery,
    };

    const NOW: &str = "2026-08-02T12:00:00Z";
    const LATER: &str = "2026-08-02T13:00:00Z";
    const FINGERPRINT: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

    fn sample(id: &str) -> MappingConfiguration {
        MappingConfiguration {
            id: id.to_owned(),
            name: "Projects".to_owned(),
            initiator_device_id: "linux-box".to_owned(),
            initiator_device_name: "Linux Mint".to_owned(),
            responder_device_id: "win-box".to_owned(),
            responder_device_name: "Windows 11".to_owned(),
            initiator_path: "/home/tommy/Projects".to_owned(),
            responder_path: "C:\\Users\\tommy\\Projects".to_owned(),
            mode: "two-way".to_owned(),
            ignore_patterns: vec!["node_modules/".to_owned(), "*.tmp".to_owned()],
            history_days: 30,
            history_max_bytes: 5_000_000_000,
            max_file_bytes: None,
            setup_status: "ready-for-initial-sync".to_owned(),
            paused: false,
            preview: None,
            created_at: "2026-08-01T00:00:00Z".to_owned(),
            updated_at: NOW.to_owned(),
        }
    }

    fn import_request(records: Vec<LegacyImportRecord>) -> LegacyImportRequest {
        LegacyImportRequest {
            source_fingerprint: FINGERPRINT.to_owned(),
            importing_device_id: "linux-box".to_owned(),
            imported_at: NOW.to_owned(),
            records,
        }
    }

    fn complete_empty_import(store: &MappingStore) {
        store
            .import_legacy(&import_request(Vec::new()))
            .expect("complete empty import");
    }

    fn ready_store() -> MappingStore {
        let store = MappingStore::open_in_memory().expect("open");
        complete_empty_import(&store);
        store
    }

    fn create_local(store: &MappingStore, id: &str) -> MappingRecord {
        store
            .upsert_local(&sample(id), "linux-box", Some("win-box"), None, NOW)
            .expect("create mapping")
    }

    fn seed_v1(path: &Path, records: &[MappingConfiguration]) {
        let connection = rusqlite::Connection::open(path).expect("open v1");
        connection
            .execute_batch(
                "CREATE TABLE folder_mappings (
                    id TEXT PRIMARY KEY, name TEXT NOT NULL,
                    initiator_device_id TEXT NOT NULL, initiator_device_name TEXT NOT NULL,
                    responder_device_id TEXT NOT NULL, responder_device_name TEXT NOT NULL,
                    initiator_path TEXT NOT NULL, responder_path TEXT NOT NULL,
                    mode TEXT NOT NULL, ignore_patterns TEXT NOT NULL,
                    history_days INTEGER NOT NULL, history_max_bytes INTEGER NOT NULL,
                    setup_status TEXT NOT NULL, pending_delivery INTEGER NOT NULL DEFAULT 0,
                    preview TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
                );
                PRAGMA user_version = 1;",
            )
            .expect("create v1 schema");
        for record in records {
            connection
                .execute(
                    "INSERT INTO folder_mappings VALUES (
                        ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10,
                        ?11, ?12, ?13, 0, NULL, ?14, ?15
                    )",
                    rusqlite::params![
                        record.id,
                        record.name,
                        record.initiator_device_id,
                        record.initiator_device_name,
                        record.responder_device_id,
                        record.responder_device_name,
                        record.initiator_path,
                        record.responder_path,
                        record.mode,
                        serde_json::to_string(&record.ignore_patterns).expect("patterns"),
                        record.history_days,
                        record.history_max_bytes,
                        record.setup_status,
                        record.created_at,
                        record.updated_at,
                    ],
                )
                .expect("insert v1 record");
        }
    }

    use std::path::Path;

    #[test]
    fn fresh_database_requires_legacy_import_instead_of_looking_empty() {
        let store = MappingStore::open_in_memory().expect("open");
        assert_eq!(store.schema_version().expect("version"), SCHEMA_VERSION);
        assert!(matches!(
            store.list(),
            Err(MappingStoreError::MigrationRequired)
        ));
        assert_eq!(
            store.legacy_migration_status().expect("status").state,
            LegacyMigrationState::Pending
        );
    }

    #[test]
    fn migrates_schema_v1_to_current_without_losing_paths() {
        let directory = tempfile::tempdir().expect("tempdir");
        let path = directory.path().join("mappings.sqlite3");
        let mut mapping = sample("legacy-1");
        mapping.initiator_path = "\\\\server\\share\\Projects".to_owned();
        mapping.responder_path = "/mnt/data/Projects".to_owned();
        seed_v1(&path, &[mapping]);

        let store = MappingStore::open(&path).expect("migrate");
        assert_eq!(store.schema_version().expect("version"), SCHEMA_VERSION);
        let revision: (i64, String, bool) = store
            .connection
            .query_row(
                "SELECT revision, author_device_id, paused FROM mapping_revisions
                 WHERE mapping_id = 'legacy-1'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .expect("revision");
        assert_eq!(revision, (1, "linux-box".to_owned(), false));
    }

    #[test]
    fn schema_migration_is_idempotent() {
        let directory = tempfile::tempdir().expect("tempdir");
        let path = directory.path().join("mappings.sqlite3");
        seed_v1(&path, &[sample("mapping-1")]);
        drop(MappingStore::open(&path).expect("first migration"));
        let reopened = MappingStore::open(&path).expect("second migration");
        assert_eq!(reopened.schema_version().expect("version"), SCHEMA_VERSION);
        assert!(
            super::revision_from(&reopened.connection, "mapping-1")
                .expect("revision")
                .is_some()
        );
    }

    #[test]
    fn migrates_schema_v3_to_v4_without_rewriting_existing_mapping_state() {
        let directory = tempfile::tempdir().expect("tempdir");
        let path = directory.path().join("mappings.sqlite3");
        seed_v1(&path, &[sample("existing-v3-mapping")]);
        drop(MappingStore::open(&path).expect("create representative current schema"));

        let connection = rusqlite::Connection::open(&path).expect("open representative v3");
        connection
            .execute_batch(
                "DROP TABLE file_replacement_journal;
                 DROP TABLE archive_objects;
                 ALTER TABLE folder_mappings DROP COLUMN max_file_bytes;
                 PRAGMA user_version = 3;",
            )
            .expect("downgrade representative schema to v3");
        drop(connection);

        let reopened = MappingStore::open(&path).expect("migrate v3 to v4");
        assert_eq!(reopened.schema_version().expect("version"), SCHEMA_VERSION);
        let mapping_count: i64 = reopened
            .connection
            .query_row(
                "SELECT COUNT(*) FROM folder_mappings WHERE id = 'existing-v3-mapping'",
                [],
                |row| row.get(0),
            )
            .expect("mapping count");
        let journal_table_count: i64 = reopened
            .connection
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master
                 WHERE type = 'table' AND name = 'file_replacement_journal'",
                [],
                |row| row.get(0),
            )
            .expect("journal table count");
        assert_eq!(mapping_count, 1);
        assert_eq!(journal_table_count, 1);
    }

    #[test]
    fn migrates_schema_v4_to_v5_without_rewriting_existing_mapping_state() {
        let directory = tempfile::tempdir().expect("tempdir");
        let path = directory.path().join("mappings.sqlite3");
        let original = sample("existing-v4-mapping");
        seed_v1(&path, std::slice::from_ref(&original));
        drop(MappingStore::open(&path).expect("create representative current schema"));

        let connection = rusqlite::Connection::open(&path).expect("open representative v4");
        connection
            .execute_batch(
                "ALTER TABLE folder_mappings DROP COLUMN max_file_bytes;
                 PRAGMA user_version = 4;",
            )
            .expect("downgrade representative schema to v4");
        drop(connection);

        let reopened = MappingStore::open(&path).expect("migrate v4 to v5");
        assert_eq!(reopened.schema_version().expect("version"), SCHEMA_VERSION);

        let mapping_count: i64 = reopened
            .connection
            .query_row(
                "SELECT COUNT(*) FROM folder_mappings WHERE id = 'existing-v4-mapping'",
                [],
                |row| row.get(0),
            )
            .expect("mapping count");
        assert_eq!(mapping_count, 1);

        // Legacy import status is untouched by this migration, so `get`/`list` still refuse to
        // read until the one-time import completes; read the migrated row directly instead.
        let (max_file_bytes, initiator_path, responder_path, name): (
            Option<i64>,
            String,
            String,
            String,
        ) = reopened
            .connection
            .query_row(
                "SELECT max_file_bytes, initiator_path, responder_path, name
                 FROM folder_mappings WHERE id = 'existing-v4-mapping'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .expect("migrated row");
        assert_eq!(max_file_bytes, None);
        assert_eq!(initiator_path, original.initiator_path);
        assert_eq!(responder_path, original.responder_path);
        assert_eq!(name, original.name);
    }

    #[test]
    fn schema_migration_v4_to_v5_is_idempotent() {
        let directory = tempfile::tempdir().expect("tempdir");
        let path = directory.path().join("mappings.sqlite3");
        seed_v1(&path, &[sample("mapping-1")]);
        drop(MappingStore::open(&path).expect("create representative current schema"));

        let connection = rusqlite::Connection::open(&path).expect("open representative v4");
        connection
            .execute_batch(
                "ALTER TABLE folder_mappings DROP COLUMN max_file_bytes;
                 PRAGMA user_version = 4;",
            )
            .expect("downgrade representative schema to v4");
        drop(connection);

        drop(MappingStore::open(&path).expect("first v4-to-v5 migration"));
        let reopened = MappingStore::open(&path).expect("second open of already-migrated v5 db");
        assert_eq!(reopened.schema_version().expect("version"), SCHEMA_VERSION);
        assert!(
            super::revision_from(&reopened.connection, "mapping-1")
                .expect("revision")
                .is_some()
        );
    }

    #[test]
    fn migrates_schema_v5_to_v6_without_rewriting_existing_mapping_state() {
        let directory = tempfile::tempdir().expect("tempdir");
        let path = directory.path().join("mappings.sqlite3");
        let original = sample("existing-v5-mapping");
        seed_v1(&path, std::slice::from_ref(&original));
        drop(MappingStore::open(&path).expect("create representative current schema"));

        let connection = rusqlite::Connection::open(&path).expect("open representative v5");
        connection
            .execute_batch(
                "DROP TABLE IF EXISTS scan_entries;
                 DROP TABLE IF EXISTS scan_generations;
                 PRAGMA user_version = 5;",
            )
            .expect("downgrade representative schema to v5");
        drop(connection);

        let reopened = MappingStore::open(&path).expect("migrate v5 to v6");
        assert_eq!(reopened.schema_version().expect("version"), SCHEMA_VERSION);
        let mapping_count: i64 = reopened
            .connection
            .query_row(
                "SELECT COUNT(*) FROM folder_mappings WHERE id = 'existing-v5-mapping'",
                [],
                |row| row.get(0),
            )
            .expect("mapping count");
        assert_eq!(mapping_count, 1);
        let generation_tables: i64 = reopened
            .connection
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name IN ('scan_generations', 'scan_entries')",
                [],
                |row| row.get(0),
            )
            .expect("generation tables");
        assert_eq!(generation_tables, 2);
    }

    #[test]
    fn migrates_schema_v6_to_v7_without_rewriting_existing_mapping_state() {
        let directory = tempfile::tempdir().expect("tempdir");
        let path = directory.path().join("mappings.sqlite3");
        let original = sample("existing-v6-mapping");
        seed_v1(&path, std::slice::from_ref(&original));
        drop(MappingStore::open(&path).expect("create representative current schema"));

        let connection = rusqlite::Connection::open(&path).expect("open representative v6");
        connection
            .execute_batch(
                "DROP TABLE IF EXISTS scan_digest_cache;
                 PRAGMA user_version = 6;",
            )
            .expect("downgrade representative schema to v6");
        drop(connection);

        let reopened = MappingStore::open(&path).expect("migrate v6 to v7");
        assert_eq!(reopened.schema_version().expect("version"), SCHEMA_VERSION);
        let mapping_count: i64 = reopened
            .connection
            .query_row(
                "SELECT COUNT(*) FROM folder_mappings WHERE id = 'existing-v6-mapping'",
                [],
                |row| row.get(0),
            )
            .expect("mapping count");
        assert_eq!(mapping_count, 1);
        let cache_table: i64 = reopened
            .connection
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'scan_digest_cache'",
                [],
                |row| row.get(0),
            )
            .expect("cache table");
        assert_eq!(cache_table, 1);

        // Reopening an already-migrated database is idempotent.
        drop(reopened);
        let reopened_again = MappingStore::open(&path).expect("reopen migrated database");
        assert_eq!(
            reopened_again.schema_version().expect("version"),
            SCHEMA_VERSION
        );
    }

    #[test]
    fn max_file_bytes_round_trips_through_upsert_and_read() {
        let store = ready_store();
        let mut mapping = sample("with-limit");
        mapping.max_file_bytes = Some(50 * 1024 * 1024);
        let created = store
            .upsert_local(&mapping, "linux-box", None, None, NOW)
            .expect("create mapping with limit");
        assert_eq!(created.mapping.max_file_bytes, Some(50 * 1024 * 1024));

        let fetched = store.get("with-limit").expect("get").expect("present");
        assert_eq!(fetched.mapping.max_file_bytes, Some(50 * 1024 * 1024));

        let mut unlimited = fetched.mapping.clone();
        unlimited.max_file_bytes = None;
        let updated = store
            .upsert_local(&unlimited, "linux-box", None, Some(fetched.revision), LATER)
            .expect("clear limit");
        assert_eq!(updated.mapping.max_file_bytes, None);

        let refetched = store.get("with-limit").expect("get").expect("present");
        assert_eq!(refetched.mapping.max_file_bytes, None);
    }

    #[test]
    fn validate_rejects_out_of_range_max_file_bytes() {
        let mut mapping = sample("bounds-invalid");
        for invalid in [0_i64, 1_023, (1_i64 << 40) + 1] {
            mapping.max_file_bytes = Some(invalid);
            assert!(
                matches!(mapping.validate(), Err(MappingStoreError::Invalid(_))),
                "expected {invalid} to be rejected"
            );
        }
    }

    #[test]
    fn validate_accepts_max_file_bytes_bounds_and_none() {
        let mut mapping = sample("bounds-valid");
        for valid in [None, Some(1_024_i64), Some(1_i64 << 40)] {
            mapping.max_file_bytes = valid;
            assert!(
                mapping.validate().is_ok(),
                "expected {valid:?} to be accepted"
            );
        }
    }

    #[test]
    fn schema_migration_rolls_back_when_a_v1_row_is_malformed() {
        let directory = tempfile::tempdir().expect("tempdir");
        let path = directory.path().join("mappings.sqlite3");
        let mut malformed = sample("mapping-1");
        malformed.mode = "sideways".to_owned();
        seed_v1(&path, &[malformed]);

        assert!(matches!(
            MappingStore::open(&path),
            Err(MappingStoreError::SchemaMigration(_))
        ));
        let connection = rusqlite::Connection::open(&path).expect("inspect rollback");
        let version: i64 = connection
            .query_row("PRAGMA user_version", [], |row| row.get(0))
            .expect("version");
        let revisions_table: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'mapping_revisions'",
                [],
                |row| row.get(0),
            )
            .expect("table count");
        let mapping_count: i64 = connection
            .query_row("SELECT COUNT(*) FROM folder_mappings", [], |row| row.get(0))
            .expect("mapping count");
        assert_eq!(version, 1);
        assert_eq!(revisions_table, 0);
        assert_eq!(mapping_count, 1);
    }

    #[test]
    fn newer_schema_is_refused() {
        let directory = tempfile::tempdir().expect("tempdir");
        let path = directory.path().join("mappings.sqlite3");
        let connection = rusqlite::Connection::open(&path).expect("open");
        connection
            .pragma_update(None, "user_version", SCHEMA_VERSION + 1)
            .expect("future version");
        drop(connection);
        assert!(matches!(
            MappingStore::open(&path),
            Err(MappingStoreError::UnsupportedSchemaVersion { found }) if found == SCHEMA_VERSION + 1
        ));
    }

    #[test]
    fn a_locked_database_is_an_error_and_never_an_empty_mapping_list() {
        let directory = tempfile::tempdir().expect("tempdir");
        let path = directory.path().join("mappings.sqlite3");
        drop(MappingStore::open(&path).expect("create database"));
        let blocker = rusqlite::Connection::open(&path).expect("blocker");
        blocker
            .execute_batch("BEGIN EXCLUSIVE;")
            .expect("exclusive lock");

        let result = MappingStore::open(&path);
        assert!(result.is_err(), "a locked authority must not open as empty");
        blocker.execute_batch("ROLLBACK;").expect("release lock");
    }

    #[test]
    fn legacy_import_is_transactional_and_rejects_duplicates() {
        let store = MappingStore::open_in_memory().expect("open");
        let duplicate = LegacyImportRecord {
            mapping: sample("same-id"),
            pending_delivery_target_device_id: None,
        };
        let error = store
            .import_legacy(&import_request(vec![duplicate.clone(), duplicate]))
            .expect_err("duplicate must fail");
        assert!(matches!(error, MappingStoreError::DuplicateMappingId(_)));
        assert_eq!(
            store.legacy_migration_status().expect("status").state,
            LegacyMigrationState::Failed
        );
        let row_count: i64 = store
            .connection
            .query_row("SELECT COUNT(*) FROM folder_mappings", [], |row| row.get(0))
            .expect("count");
        assert_eq!(row_count, 0);
    }

    #[test]
    fn legacy_import_rolls_back_every_record_when_a_late_write_fails() {
        let store = MappingStore::open_in_memory().expect("open");
        store
            .connection
            .execute_batch(
                "CREATE TRIGGER reject_second_import BEFORE INSERT ON mapping_revisions
                 WHEN NEW.mapping_id = 'mapping-2'
                 BEGIN SELECT RAISE(ABORT, 'test rollback'); END;",
            )
            .expect("trigger");
        let request = import_request(vec![
            LegacyImportRecord {
                mapping: sample("mapping-1"),
                pending_delivery_target_device_id: None,
            },
            LegacyImportRecord {
                mapping: sample("mapping-2"),
                pending_delivery_target_device_id: None,
            },
        ]);
        assert!(store.import_legacy(&request).is_err());
        let mapping_count: i64 = store
            .connection
            .query_row("SELECT COUNT(*) FROM folder_mappings", [], |row| row.get(0))
            .expect("mapping count");
        let revision_count: i64 = store
            .connection
            .query_row("SELECT COUNT(*) FROM mapping_revisions", [], |row| {
                row.get(0)
            })
            .expect("revision count");
        assert_eq!(mapping_count, 0);
        assert_eq!(revision_count, 0);
        assert_eq!(
            store.legacy_migration_status().expect("status").state,
            LegacyMigrationState::Failed
        );
    }

    #[test]
    fn legacy_import_is_idempotent_only_for_the_same_fingerprint() {
        let store = MappingStore::open_in_memory().expect("open");
        let request = import_request(vec![LegacyImportRecord {
            mapping: sample("mapping-1"),
            pending_delivery_target_device_id: None,
        }]);
        store.import_legacy(&request).expect("first import");
        let replay = store.import_legacy(&request).expect("same import");
        assert!(replay.already_completed);
        assert_eq!(store.list().expect("list").len(), 1);

        let mut different = request;
        different.source_fingerprint =
            "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb".to_owned();
        assert!(matches!(
            store.import_legacy(&different),
            Err(MappingStoreError::LegacyImportAlreadyCompleted)
        ));
        assert_eq!(store.list().expect("still intact").len(), 1);
    }

    #[test]
    fn legacy_import_exactly_replaces_a_pr4_write_through_row() {
        let directory = tempfile::tempdir().expect("tempdir");
        let path = directory.path().join("mappings.sqlite3");
        let mut write_through = sample("mapping-1");
        write_through.created_at = "2026-07-01T00:00:00Z".to_owned();
        write_through.name = "Stale write-through name".to_owned();
        seed_v1(&path, &[write_through]);

        let store = MappingStore::open(&path).expect("migrate v1");
        let imported = sample("mapping-1");
        store
            .import_legacy(&import_request(vec![LegacyImportRecord {
                mapping: imported.clone(),
                pending_delivery_target_device_id: Some("win-box".to_owned()),
            }]))
            .expect("legacy import");

        let committed = store
            .get("mapping-1")
            .expect("read committed mapping")
            .expect("mapping exists");
        assert_eq!(committed.mapping, imported);
        let pending = store.list_pending_delivery().expect("pending delivery");
        assert_eq!(pending.len(), 1);
        let MappingEvent::Active { record } = &pending[0].event else {
            panic!("legacy active mapping must queue an active event");
        };
        assert_eq!(record.mapping, imported);
        assert!(!record.pending_delivery);
    }

    #[test]
    fn import_tombstones_database_rows_absent_from_the_legacy_authority() {
        let directory = tempfile::tempdir().expect("tempdir");
        let path = directory.path().join("mappings.sqlite3");
        seed_v1(&path, &[sample("stale-pr4-row")]);
        let store = MappingStore::open(&path).expect("migrate");
        store
            .import_legacy(&import_request(Vec::new()))
            .expect("empty snapshot is authoritative");
        assert!(store.list().expect("list").is_empty());
        assert!(
            store
                .get_tombstone("stale-pr4-row")
                .expect("tombstone")
                .is_some()
        );
    }

    #[test]
    fn tombstone_survives_reopen_and_excludes_active_mapping() {
        let directory = tempfile::tempdir().expect("tempdir");
        let path = directory.path().join("mappings.sqlite3");
        let store = MappingStore::open(&path).expect("open");
        complete_empty_import(&store);
        let record = create_local(&store, "mapping-1");
        store
            .remove_local(
                "mapping-1",
                "linux-box",
                Some("win-box"),
                record.revision,
                LATER,
            )
            .expect("remove");
        drop(store);

        let reopened = MappingStore::open(&path).expect("reopen");
        assert!(reopened.list().expect("list").is_empty());
        assert!(
            reopened
                .get_tombstone("mapping-1")
                .expect("tombstone")
                .is_some()
        );
    }

    #[test]
    fn stale_active_event_cannot_resurrect_a_tombstoned_mapping() {
        let sender = ready_store();
        let record = create_local(&sender, "mapping-1");
        let stale = MappingEvent::Active {
            record: Box::new(MappingRecord {
                pending_delivery: false,
                ..record.clone()
            }),
        };
        let tombstone = sender
            .remove_local(
                "mapping-1",
                "linux-box",
                Some("win-box"),
                record.revision,
                LATER,
            )
            .expect("remove");

        let receiver = ready_store();
        receiver
            .apply_remote(
                &MappingEvent::Tombstone {
                    tombstone: tombstone.clone(),
                },
                "linux-box",
                "win-box",
            )
            .expect("apply tombstone");
        let outcome = receiver
            .apply_remote(&stale, "linux-box", "win-box")
            .expect("stale active is safely ignored");
        assert_eq!(outcome.status, ApplyStatus::Tombstoned);
        assert!(receiver.list().expect("list").is_empty());
    }

    #[test]
    fn duplicate_tombstone_delivery_is_idempotent() {
        let sender = ready_store();
        let record = create_local(&sender, "mapping-1");
        let tombstone = sender
            .remove_local(
                "mapping-1",
                "linux-box",
                Some("win-box"),
                record.revision,
                LATER,
            )
            .expect("remove");
        let event = MappingEvent::Tombstone { tombstone };
        let receiver = ready_store();
        assert_eq!(
            receiver
                .apply_remote(&event, "linux-box", "win-box")
                .expect("first")
                .status,
            ApplyStatus::Applied
        );
        assert_eq!(
            receiver
                .apply_remote(&event, "linux-box", "win-box")
                .expect("duplicate")
                .status,
            ApplyStatus::Duplicate
        );

        let mut conflicting = event.clone();
        let MappingEvent::Tombstone { tombstone } = &mut conflicting else {
            unreachable!("test event is a tombstone")
        };
        tombstone.deletion_timestamp = "2026-08-02T00:00:01Z".to_owned();
        assert!(matches!(
            receiver.apply_remote(&conflicting, "linux-box", "win-box"),
            Err(MappingStoreError::ConflictingEvent { .. })
        ));
    }

    #[test]
    fn duplicate_active_identity_rejects_a_conflicting_payload() {
        let sender = ready_store();
        let record = create_local(&sender, "mapping-1");
        let event = MappingEvent::Active {
            record: Box::new(MappingRecord {
                pending_delivery: false,
                ..record
            }),
        };
        let receiver = ready_store();
        receiver
            .apply_remote(&event, "linux-box", "win-box")
            .expect("apply active event");

        let mut conflicting = event;
        let MappingEvent::Active { record } = &mut conflicting else {
            unreachable!("test event is active")
        };
        record.mapping.name = "Different payload, same event identity".to_owned();
        assert!(matches!(
            receiver.apply_remote(&conflicting, "linux-box", "win-box"),
            Err(MappingStoreError::ConflictingEvent { .. })
        ));
    }

    #[test]
    fn outbox_identity_cannot_hide_a_conflicting_payload() {
        let store = ready_store();
        let record = create_local(&store, "mapping-1");
        let event = MappingEvent::Active {
            record: Box::new(MappingRecord {
                pending_delivery: false,
                ..record
            }),
        };
        let transaction =
            Transaction::new_unchecked(&store.connection, TransactionBehavior::Immediate)
                .expect("transaction");
        insert_delivery(&transaction, &event, "win-box", NOW).expect("first outbox event");

        let mut conflicting = event;
        let MappingEvent::Active { record } = &mut conflicting else {
            unreachable!("test event is active")
        };
        record.mapping.paused = true;
        assert!(matches!(
            insert_delivery(&transaction, &conflicting, "win-box", NOW),
            Err(MappingStoreError::ConflictingEvent { .. })
        ));
    }

    #[test]
    fn readding_same_paths_requires_a_new_mapping_id() {
        let store = ready_store();
        let original = create_local(&store, "old-id");
        store
            .remove_local("old-id", "linux-box", None, original.revision, LATER)
            .expect("remove");
        assert!(matches!(
            store.upsert_local(&sample("old-id"), "linux-box", None, None, LATER),
            Err(MappingStoreError::Tombstoned(_))
        ));
        let replacement = store
            .upsert_local(&sample("new-id"), "linux-box", None, None, LATER)
            .expect("new id");
        assert_eq!(
            replacement.mapping.initiator_path,
            original.mapping.initiator_path
        );
    }

    #[test]
    fn removal_transaction_rolls_back_when_tombstone_write_fails() {
        let store = ready_store();
        let record = create_local(&store, "mapping-1");
        store
            .connection
            .execute_batch(
                "CREATE TRIGGER reject_tombstone BEFORE INSERT ON mapping_tombstones
                 BEGIN SELECT RAISE(ABORT, 'test rollback'); END;",
            )
            .expect("trigger");
        assert!(
            store
                .remove_local(
                    "mapping-1",
                    "linux-box",
                    Some("win-box"),
                    record.revision,
                    LATER,
                )
                .is_err()
        );
        assert!(store.get("mapping-1").expect("active remains").is_some());
        assert!(
            store
                .get_tombstone("mapping-1")
                .expect("no tombstone")
                .is_none()
        );
    }

    #[test]
    fn pending_delivery_requires_an_exact_authenticated_acknowledgement() {
        let store = ready_store();
        let record = create_local(&store, "mapping-1");
        let pending = store.list_pending_delivery().expect("pending");
        assert_eq!(pending.len(), 1);
        assert!(matches!(
            store.acknowledge_delivery(
                "mapping-1",
                &record.event_id,
                record.revision + 1,
                "win-box",
                LATER
            ),
            Err(MappingStoreError::AcknowledgementMismatch)
        ));
        assert_eq!(
            store.list_pending_delivery().expect("still pending").len(),
            1
        );

        let ack = store
            .acknowledge_delivery(
                "mapping-1",
                &record.event_id,
                record.revision,
                "win-box",
                LATER,
            )
            .expect("ack");
        assert_eq!(ack.status, AcknowledgeStatus::Acknowledged);
        assert!(store.list_pending_delivery().expect("cleared").is_empty());
        assert!(
            !store
                .get("mapping-1")
                .expect("get")
                .expect("present")
                .pending_delivery
        );
        assert_eq!(
            store
                .acknowledge_delivery(
                    "mapping-1",
                    &record.event_id,
                    record.revision,
                    "win-box",
                    LATER,
                )
                .expect("duplicate ack")
                .status,
            AcknowledgeStatus::AlreadyAcknowledged
        );
    }

    #[test]
    fn tombstone_supersedes_an_unacknowledged_active_delivery() {
        let store = ready_store();
        let active = create_local(&store, "mapping-1");
        assert_eq!(store.list_pending_delivery().expect("active").len(), 1);

        store
            .remove_local(
                "mapping-1",
                "linux-box",
                Some("win-box"),
                active.revision,
                LATER,
            )
            .expect("remove");
        let pending = store.list_pending_delivery().expect("tombstone only");
        assert_eq!(pending.len(), 1);
        assert!(matches!(pending[0].event, MappingEvent::Tombstone { .. }));
    }

    #[test]
    fn two_peers_reconcile_active_then_tombstone_with_exact_acknowledgements() {
        let sender = ready_store();
        let receiver = ready_store();
        let active = create_local(&sender, "mapping-1");
        let delivery = sender
            .list_pending_delivery()
            .expect("active delivery")
            .into_iter()
            .next()
            .expect("active pending");
        let applied = receiver
            .apply_remote(&delivery.event, "linux-box", "win-box")
            .expect("authenticated active delivery");
        sender
            .acknowledge_delivery(
                &applied.mapping_id,
                &applied.event_id,
                applied.revision,
                "win-box",
                LATER,
            )
            .expect("exact active ack");
        assert!(
            sender
                .list_pending_delivery()
                .expect("active acked")
                .is_empty()
        );

        let tombstone = sender
            .remove_local(
                "mapping-1",
                "linux-box",
                Some("win-box"),
                active.revision,
                LATER,
            )
            .expect("local tombstone");
        let deletion = sender
            .list_pending_delivery()
            .expect("tombstone delivery")
            .into_iter()
            .next()
            .expect("tombstone pending");
        let applied = receiver
            .apply_remote(&deletion.event, "linux-box", "win-box")
            .expect("authenticated tombstone delivery");
        assert_eq!(applied.event_id, tombstone.deletion_event_id);
        sender
            .acknowledge_delivery(
                &applied.mapping_id,
                &applied.event_id,
                applied.revision,
                "win-box",
                "2026-08-02T14:00:00Z",
            )
            .expect("exact tombstone ack");
        assert!(
            sender
                .list_pending_delivery()
                .expect("deletion acked")
                .is_empty()
        );
        assert!(receiver.list().expect("receiver active list").is_empty());

        let stale = MappingEvent::Active {
            record: Box::new(MappingRecord {
                pending_delivery: false,
                ..active
            }),
        };
        assert_eq!(
            receiver
                .apply_remote(&stale, "linux-box", "win-box")
                .expect("stale replay")
                .status,
            ApplyStatus::Tombstoned
        );
    }

    #[test]
    fn out_of_order_active_events_converge_deterministically() {
        let sender = ready_store();
        let first = create_local(&sender, "mapping-1");
        let mut updated = first.mapping.clone();
        updated.name = "Projects updated".to_owned();
        updated.updated_at = LATER.to_owned();
        let second = sender
            .upsert_local(
                &updated,
                "linux-box",
                Some("win-box"),
                Some(first.revision),
                LATER,
            )
            .expect("second");
        let first_event = MappingEvent::Active {
            record: Box::new(MappingRecord {
                pending_delivery: false,
                ..first
            }),
        };
        let second_event = MappingEvent::Active {
            record: Box::new(MappingRecord {
                pending_delivery: false,
                ..second
            }),
        };
        let receiver = ready_store();
        receiver
            .apply_remote(&second_event, "linux-box", "win-box")
            .expect("newer first");
        assert_eq!(
            receiver
                .apply_remote(&first_event, "linux-box", "win-box")
                .expect("older later")
                .status,
            ApplyStatus::Stale
        );
        assert_eq!(
            receiver
                .get("mapping-1")
                .expect("get")
                .expect("present")
                .mapping
                .name,
            "Projects updated"
        );
    }

    #[test]
    fn paths_round_trip_without_file_operations() {
        let directory = tempfile::tempdir().expect("tempdir");
        let sentinel = directory.path().join("sentinel.txt");
        fs::write(&sentinel, b"unchanged").expect("sentinel");
        let store = ready_store();
        let mut mapping = sample("mapping-1");
        mapping.initiator_path = "\\\\server\\share\\Projects".to_owned();
        mapping.responder_path = "/mnt/data/Projects".to_owned();
        let record = store
            .upsert_local(&mapping, "linux-box", None, None, NOW)
            .expect("store paths");
        assert_eq!(record.mapping.initiator_path, "\\\\server\\share\\Projects");
        assert_eq!(record.mapping.responder_path, "/mnt/data/Projects");
        assert_eq!(fs::read(&sentinel).expect("sentinel"), b"unchanged");
    }

    #[test]
    fn malformed_stored_state_returns_a_structured_error() {
        let store = ready_store();
        create_local(&store, "mapping-1");
        store
            .connection
            .execute(
                "UPDATE folder_mappings SET ignore_patterns = '{not json' WHERE id = ?1",
                rusqlite::params!["mapping-1"],
            )
            .expect("corrupt");
        assert!(matches!(
            store.get("mapping-1"),
            Err(MappingStoreError::CorruptRecord {
                column: "ignore_patterns",
                ..
            })
        ));
    }

    #[test]
    fn invalid_revision_and_participants_are_rejected() {
        let store = ready_store();
        assert!(matches!(
            store.upsert_local(&sample("mapping-1"), "stranger", None, None, NOW),
            Err(MappingStoreError::InvalidParticipant(_))
        ));
        let record = create_local(&store, "mapping-1");
        assert!(matches!(
            store.remove_local("mapping-1", "linux-box", None, record.revision + 1, LATER),
            Err(MappingStoreError::StaleRevision { .. })
        ));
    }

    #[test]
    fn malformed_tombstone_is_rejected() {
        let store = ready_store();
        let tombstone = MappingTombstone {
            mapping_id: "mapping-1".to_owned(),
            deletion_event_id: "delete:mapping-1:1:linux-box".to_owned(),
            deletion_revision: 1,
            deletion_timestamp: NOW.to_owned(),
            deleting_device_id: "linux-box".to_owned(),
            last_known_update_revision: 1,
            tombstone_created_at: NOW.to_owned(),
            initiator_device_id: "linux-box".to_owned(),
            responder_device_id: "win-box".to_owned(),
        };
        assert!(matches!(
            store.apply_remote(
                &MappingEvent::Tombstone { tombstone },
                "linux-box",
                "win-box"
            ),
            Err(MappingStoreError::Invalid(_))
        ));
    }

    #[test]
    fn on_disk_store_uses_wal_and_tombstones_are_not_pruned() {
        let directory = tempfile::tempdir().expect("tempdir");
        let store = MappingStore::open(directory.path().join("mappings.sqlite3")).expect("open");
        assert_eq!(store.journal_mode(), "wal");
        complete_empty_import(&store);
        let record = create_local(&store, "mapping-1");
        store
            .remove_local("mapping-1", "linux-box", None, record.revision, LATER)
            .expect("remove");
        let count: i64 = store
            .connection
            .query_row("SELECT COUNT(*) FROM mapping_tombstones", [], |row| {
                row.get(0)
            })
            .expect("count");
        assert_eq!(count, 1);
    }
}
