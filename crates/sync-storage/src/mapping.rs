//! Durable storage for approved and in-flight folder-mapping proposals.
//!
//! This is a private, per-machine index. It stores each side's *local* absolute path so this
//! device can find its own folder again after a restart; those paths are never used as a
//! network identity or a cryptographic identifier, and are never sent anywhere by this module.
//!
//! Paths are stored verbatim — a Windows `C:\Users\...` path and a Linux `/home/...` path both
//! round-trip byte-for-byte. Nothing here normalises slashes, because the stored path has to
//! stay valid for the operating system that produced it.
//!
//! Concurrency: the database runs in WAL mode with a busy timeout, so two engine processes
//! pointed at the same file serialise their writes rather than corrupting each other. A
//! [`MappingStore`] itself owns a single non-`Sync` [`Connection`] and is therefore confined to
//! the thread that opened it.

use std::path::Path;
use std::time::Duration;

use rusqlite::{Connection, OptionalExtension, Row, params};
use serde::{Deserialize, Serialize};
use serde_json::Value;

/// Schema version this build reads and writes. Bump it and add a migration step in
/// [`MappingStore::migrate`] whenever the table shape changes.
pub const SCHEMA_VERSION: i64 = 1;

/// How long a write waits for another process's lock before giving up.
const BUSY_TIMEOUT: Duration = Duration::from_secs(5);

const MAX_ID_LENGTH: usize = 200;
const MAX_NAME_LENGTH: usize = 200;
const MAX_PATH_LENGTH: usize = 4096;
const MAX_IGNORE_PATTERNS: usize = 1_000;
const MAX_IGNORE_PATTERN_LENGTH: usize = 1_024;
const MAX_HISTORY_DAYS: i64 = 3_650;
const MAX_HISTORY_BYTES: i64 = 1 << 50;

/// The sync modes a stored mapping may declare. Kept in step with `SyncMode` in
/// `sync-core::manifest` and the desktop's `SyncMode` contract.
const VALID_MODES: [&str; 3] = ["two-way", "send-only", "receive-only"];

const SELECT_COLUMNS: &str = "SELECT id, name, initiator_device_id, initiator_device_name,
            responder_device_id, responder_device_name,
            initiator_path, responder_path, mode, ignore_patterns,
            history_days, history_max_bytes, setup_status, pending_delivery,
            preview, created_at, updated_at
     FROM folder_mappings";

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MappingRecord {
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
    pub setup_status: String,
    pub pending_delivery: bool,
    pub preview: Option<Value>,
    pub created_at: String,
    pub updated_at: String,
}

impl MappingRecord {
    /// Rejects records that would put nonsense in the index.
    ///
    /// The engine is only ever driven by this machine's own desktop shell over an authenticated
    /// pipe, so this is a consistency guard rather than a trust boundary — but it keeps a
    /// malformed write from becoming a permanently unreadable row.
    ///
    /// # Errors
    ///
    /// Returns [`MappingStoreError::Invalid`] describing the first field that failed.
    pub fn validate(&self) -> Result<(), MappingStoreError> {
        check_identifier("id", &self.id)?;
        check_identifier("initiatorDeviceId", &self.initiator_device_id)?;
        check_identifier("responderDeviceId", &self.responder_device_id)?;
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
        check_text("initiatorPath", &self.initiator_path, MAX_PATH_LENGTH)?;
        check_text("responderPath", &self.responder_path, MAX_PATH_LENGTH)?;
        check_text("setupStatus", &self.setup_status, MAX_NAME_LENGTH)?;

        if !VALID_MODES.contains(&self.mode.as_str()) {
            return Err(MappingStoreError::Invalid(format!(
                "mode must be one of {}, got {:?}",
                VALID_MODES.join(", "),
                self.mode
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
        if self.ignore_patterns.len() > MAX_IGNORE_PATTERNS {
            return Err(MappingStoreError::Invalid(format!(
                "ignorePatterns must hold at most {MAX_IGNORE_PATTERNS} entries, got {}",
                self.ignore_patterns.len()
            )));
        }
        if let Some(pattern) = self
            .ignore_patterns
            .iter()
            .find(|pattern| pattern.len() > MAX_IGNORE_PATTERN_LENGTH)
        {
            return Err(MappingStoreError::Invalid(format!(
                "each ignorePatterns entry must be at most {MAX_IGNORE_PATTERN_LENGTH} characters, got {}",
                pattern.len()
            )));
        }
        Ok(())
    }
}

/// Validates an id used as a lookup key or as a stored device/mapping identifier.
///
/// # Errors
///
/// Returns [`MappingStoreError::Invalid`] when `value` is blank or overlong.
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
    Ok(())
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
    #[error(
        "the mapping index is at schema version {found}, which is newer than the version this build understands; upgrade Tethera"
    )]
    UnsupportedSchemaVersion { found: i64 },
    #[error("invalid mapping record: {0}")]
    Invalid(String),
}

#[derive(Debug)]
pub struct MappingStore {
    connection: Connection,
    journal_mode: String,
}

impl MappingStore {
    /// Opens (creating if needed) a `SQLite` database at `path` and applies migrations.
    ///
    /// # Errors
    ///
    /// Returns `Err` if the database file cannot be opened, is locked past the busy timeout, or
    /// was written by a newer schema version than this build understands.
    pub fn open(path: impl AsRef<Path>) -> Result<Self, MappingStoreError> {
        let connection = Connection::open(path)?;
        Self::configure(connection)
    }

    /// Opens an in-memory database, primarily for tests.
    ///
    /// # Errors
    ///
    /// Returns `Err` if the database cannot be created or migrated.
    pub fn open_in_memory() -> Result<Self, MappingStoreError> {
        let connection = Connection::open_in_memory()?;
        Self::configure(connection)
    }

    /// Applies the same pragmas and migrations to every connection, so an in-memory test store
    /// behaves like the on-disk one. `journal_mode` is the one unavoidable difference: an
    /// in-memory database reports `memory` and cannot be put into WAL.
    fn configure(connection: Connection) -> Result<Self, MappingStoreError> {
        connection.busy_timeout(BUSY_TIMEOUT)?;
        connection.pragma_update(None, "foreign_keys", true)?;
        // `PRAGMA journal_mode` answers with the mode actually in force, which is not always
        // the one asked for, so read the answer back rather than assuming the write took.
        let journal_mode: String =
            connection.query_row("PRAGMA journal_mode = WAL", [], |row| row.get(0))?;
        let store = Self {
            connection,
            journal_mode,
        };
        store.migrate()?;
        Ok(store)
    }

    /// The journal mode the database is actually running in — `wal` on disk, `memory` for an
    /// in-memory store. Surfaced so startup diagnostics can report it instead of assuming WAL.
    #[must_use]
    pub fn journal_mode(&self) -> &str {
        &self.journal_mode
    }

    /// The schema version currently recorded in the database.
    ///
    /// # Errors
    ///
    /// Returns `Err` if the pragma cannot be read.
    pub fn schema_version(&self) -> Result<i64, MappingStoreError> {
        Ok(self
            .connection
            .query_row("PRAGMA user_version", [], |row| row.get(0))?)
    }

    /// Brings the database up to [`SCHEMA_VERSION`].
    ///
    /// Every step runs inside a single transaction that also bumps `user_version`, and `SQLite`
    /// rolls `user_version` back with the rest of the transaction. A migration therefore either
    /// lands completely or not at all — it can never leave a half-migrated database claiming to
    /// be at the new version.
    fn migrate(&self) -> Result<(), MappingStoreError> {
        let current = self.schema_version()?;
        if current > SCHEMA_VERSION {
            return Err(MappingStoreError::UnsupportedSchemaVersion { found: current });
        }
        if current == SCHEMA_VERSION {
            return Ok(());
        }

        if current < 1 {
            // `IF NOT EXISTS` matters here beyond first run: builds from before this migration
            // existed created the same table while leaving `user_version` at 0, so v0
            // databases in the wild may already have it. Adopting them converges every
            // database on one shape for version 1.
            self.connection.execute_batch(
                "BEGIN IMMEDIATE;
                CREATE TABLE IF NOT EXISTS folder_mappings (
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
                PRAGMA user_version = 1;
                COMMIT;",
            )?;
        }

        Ok(())
    }

    /// Inserts a mapping, or updates an existing mapping with the same id.
    ///
    /// The write is idempotent: replaying the same record leaves the same row. `created_at` is
    /// only ever written by the insert, so re-upserting an existing id preserves the original
    /// creation time while taking the new `updated_at`.
    ///
    /// # Errors
    ///
    /// Returns `Err` if the record fails validation, cannot be serialised, or the write fails.
    pub fn upsert(&self, record: &MappingRecord) -> Result<(), MappingStoreError> {
        record.validate()?;
        let ignore_patterns = serde_json::to_string(&record.ignore_patterns)?;
        let preview = record
            .preview
            .as_ref()
            .map(serde_json::to_string)
            .transpose()?;

        self.connection.execute(
            "INSERT INTO folder_mappings (
                id, name, initiator_device_id, initiator_device_name,
                responder_device_id, responder_device_name,
                initiator_path, responder_path, mode, ignore_patterns,
                history_days, history_max_bytes, setup_status, pending_delivery,
                preview, created_at, updated_at
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17)
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
                setup_status = excluded.setup_status,
                pending_delivery = excluded.pending_delivery,
                preview = excluded.preview,
                updated_at = excluded.updated_at",
            params![
                record.id,
                record.name,
                record.initiator_device_id,
                record.initiator_device_name,
                record.responder_device_id,
                record.responder_device_name,
                record.initiator_path,
                record.responder_path,
                record.mode,
                ignore_patterns,
                record.history_days,
                record.history_max_bytes,
                record.setup_status,
                record.pending_delivery,
                preview,
                record.created_at,
                record.updated_at,
            ],
        )?;
        Ok(())
    }

    /// # Errors
    ///
    /// Returns `Err` if `id` is blank or overlong, the query fails, or the stored record holds
    /// malformed JSON.
    pub fn get(&self, id: &str) -> Result<Option<MappingRecord>, MappingStoreError> {
        check_identifier("id", id)?;
        let row = self
            .connection
            .query_row(
                &format!("{SELECT_COLUMNS} WHERE id = ?1"),
                params![id],
                RawMappingRow::from_row,
            )
            .optional()?;
        row.map(RawMappingRow::into_record).transpose()
    }

    /// # Errors
    ///
    /// Returns `Err` if the query fails or a stored record holds malformed JSON.
    pub fn list(&self) -> Result<Vec<MappingRecord>, MappingStoreError> {
        self.query_list(&format!("{SELECT_COLUMNS} ORDER BY created_at ASC, id ASC"))
    }

    /// Mappings this device has approved but not yet handed to the peer.
    ///
    /// # Errors
    ///
    /// Returns `Err` if the query fails or a stored record holds malformed JSON.
    pub fn list_pending_delivery(&self) -> Result<Vec<MappingRecord>, MappingStoreError> {
        self.query_list(&format!(
            "{SELECT_COLUMNS} WHERE pending_delivery = 1 ORDER BY created_at ASC, id ASC"
        ))
    }

    /// Runs one of the fixed statements above. No caller ever supplies SQL: `sql` is always a
    /// constant assembled inside this module, and every value is bound as a parameter.
    fn query_list(&self, sql: &str) -> Result<Vec<MappingRecord>, MappingStoreError> {
        let mut statement = self.connection.prepare(sql)?;
        let rows = statement.query_map([], RawMappingRow::from_row)?;
        let mut records = Vec::new();
        for row in rows {
            records.push(row?.into_record()?);
        }
        Ok(records)
    }

    /// Removes the mapping's row from this index. Returns `true` if a row existed.
    ///
    /// This only ever deletes the index record. Nothing in this module opens, moves or deletes
    /// any file inside a mapped folder.
    ///
    /// # Errors
    ///
    /// Returns `Err` if `id` is blank or overlong, or the delete statement fails.
    pub fn delete(&self, id: &str) -> Result<bool, MappingStoreError> {
        check_identifier("id", id)?;
        let affected = self
            .connection
            .execute("DELETE FROM folder_mappings WHERE id = ?1", params![id])?;
        Ok(affected > 0)
    }
}

/// A row exactly as stored, with the two JSON columns still unparsed. Splitting the read into
/// "pull the columns" and "parse the JSON" keeps `rusqlite`'s error type out of the JSON failure
/// path, so malformed stored JSON surfaces as a structured
/// [`MappingStoreError::CorruptRecord`] naming the row and column rather than as a panic or an
/// opaque database error.
struct RawMappingRow {
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
    setup_status: String,
    pending_delivery: bool,
    preview: Option<String>,
    created_at: String,
    updated_at: String,
}

impl RawMappingRow {
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
            setup_status: row.get(12)?,
            pending_delivery: row.get(13)?,
            preview: row.get(14)?,
            created_at: row.get(15)?,
            updated_at: row.get(16)?,
        })
    }

    fn into_record(self) -> Result<MappingRecord, MappingStoreError> {
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

        Ok(MappingRecord {
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
            setup_status: self.setup_status,
            pending_delivery: self.pending_delivery,
            preview,
            created_at: self.created_at,
            updated_at: self.updated_at,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::{MappingRecord, MappingStore, MappingStoreError, SCHEMA_VERSION};

    /// One way of breaking a valid record, for the validation table below.
    type Mutation = Box<dyn Fn(&mut MappingRecord)>;

    fn sample(id: &str) -> MappingRecord {
        MappingRecord {
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
            setup_status: "pending-approval".to_owned(),
            pending_delivery: false,
            preview: None,
            created_at: "2026-08-01T00:00:00Z".to_owned(),
            updated_at: "2026-08-01T00:00:00Z".to_owned(),
        }
    }

    #[test]
    fn round_trips_a_mapping_through_upsert_and_get() {
        let store = MappingStore::open_in_memory().expect("open store");
        let record = sample("mapping-1");
        store.upsert(&record).expect("upsert");

        let fetched = store.get("mapping-1").expect("get").expect("present");
        assert_eq!(fetched, record);
    }

    #[test]
    fn get_returns_none_for_missing_mapping() {
        let store = MappingStore::open_in_memory().expect("open store");
        assert_eq!(store.get("missing").expect("get"), None);
    }

    #[test]
    fn upsert_replaces_an_existing_mapping_by_id() {
        let store = MappingStore::open_in_memory().expect("open store");
        store.upsert(&sample("mapping-1")).expect("insert");

        let mut updated = sample("mapping-1");
        updated.setup_status = "active".to_owned();
        updated.pending_delivery = true;
        store.upsert(&updated).expect("update");

        let fetched = store.get("mapping-1").expect("get").expect("present");
        assert_eq!(fetched.setup_status, "active");
        assert!(fetched.pending_delivery);
        assert_eq!(store.list().expect("list").len(), 1);
    }

    #[test]
    fn upsert_is_idempotent_for_an_unchanged_record() {
        let store = MappingStore::open_in_memory().expect("open store");
        let record = sample("mapping-1");
        store.upsert(&record).expect("insert");
        store.upsert(&record).expect("replay");
        store.upsert(&record).expect("replay again");

        assert_eq!(store.list().expect("list"), vec![record]);
    }

    #[test]
    fn upsert_preserves_created_at_and_advances_updated_at() {
        let store = MappingStore::open_in_memory().expect("open store");
        store.upsert(&sample("mapping-1")).expect("insert");

        let mut updated = sample("mapping-1");
        updated.created_at = "2030-01-01T00:00:00Z".to_owned();
        updated.updated_at = "2026-08-02T12:00:00Z".to_owned();
        store.upsert(&updated).expect("update");

        let fetched = store.get("mapping-1").expect("get").expect("present");
        assert_eq!(
            fetched.created_at, "2026-08-01T00:00:00Z",
            "created_at must survive an update, even one that tries to overwrite it"
        );
        assert_eq!(fetched.updated_at, "2026-08-02T12:00:00Z");
    }

    #[test]
    fn list_returns_mappings_ordered_by_creation() {
        let store = MappingStore::open_in_memory().expect("open store");
        let mut first = sample("mapping-1");
        first.created_at = "2026-08-01T00:00:00Z".to_owned();
        let mut second = sample("mapping-2");
        second.created_at = "2026-08-02T00:00:00Z".to_owned();

        store.upsert(&second).expect("insert second");
        store.upsert(&first).expect("insert first");

        let ids: Vec<String> = store
            .list()
            .expect("list")
            .into_iter()
            .map(|record| record.id)
            .collect();
        assert_eq!(ids, vec!["mapping-1", "mapping-2"]);
    }

    #[test]
    fn list_pending_delivery_filters_to_pending_only() {
        let store = MappingStore::open_in_memory().expect("open store");
        let mut pending = sample("mapping-pending");
        pending.pending_delivery = true;
        let delivered = sample("mapping-delivered");

        store.upsert(&pending).expect("insert pending");
        store.upsert(&delivered).expect("insert delivered");

        let results = store.list_pending_delivery().expect("list pending");
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].id, "mapping-pending");
    }

    #[test]
    fn clearing_pending_delivery_removes_a_mapping_from_the_pending_list() {
        let store = MappingStore::open_in_memory().expect("open store");
        let mut record = sample("mapping-1");
        record.pending_delivery = true;
        store.upsert(&record).expect("insert pending");
        assert_eq!(store.list_pending_delivery().expect("pending").len(), 1);

        record.pending_delivery = false;
        store.upsert(&record).expect("mark delivered");
        assert!(store.list_pending_delivery().expect("pending").is_empty());
    }

    #[test]
    fn delete_removes_a_mapping_and_reports_whether_it_existed() {
        let store = MappingStore::open_in_memory().expect("open store");
        store.upsert(&sample("mapping-1")).expect("insert");

        assert!(store.delete("mapping-1").expect("delete"));
        assert!(!store.delete("mapping-1").expect("delete again"));
        assert_eq!(store.get("mapping-1").expect("get"), None);
    }

    #[test]
    fn delete_leaves_other_mappings_alone() {
        let store = MappingStore::open_in_memory().expect("open store");
        store.upsert(&sample("mapping-1")).expect("insert one");
        store.upsert(&sample("mapping-2")).expect("insert two");

        assert!(store.delete("mapping-1").expect("delete"));
        let remaining: Vec<String> = store
            .list()
            .expect("list")
            .into_iter()
            .map(|record| record.id)
            .collect();
        assert_eq!(remaining, vec!["mapping-2"]);
    }

    #[test]
    fn preserves_a_preview_payload_through_round_trip() {
        let store = MappingStore::open_in_memory().expect("open store");
        let mut record = sample("mapping-1");
        record.preview = Some(serde_json::json!({
            "identicalCount": 12,
            "differentCount": 3,
            "estimatedBytes": 40_960,
        }));
        store.upsert(&record).expect("upsert");

        let fetched = store.get("mapping-1").expect("get").expect("present");
        assert_eq!(fetched.preview, record.preview);
    }

    #[test]
    fn stores_windows_and_linux_paths_verbatim() {
        let store = MappingStore::open_in_memory().expect("open store");
        let mut record = sample("mapping-1");
        record.initiator_path = "/home/tommy/My Projects/ünïcode".to_owned();
        record.responder_path = "C:\\Users\\tommy\\My Projects\\ünïcode".to_owned();
        store.upsert(&record).expect("upsert");

        let fetched = store.get("mapping-1").expect("get").expect("present");
        assert_eq!(fetched.initiator_path, "/home/tommy/My Projects/ünïcode");
        assert_eq!(
            fetched.responder_path, "C:\\Users\\tommy\\My Projects\\ünïcode",
            "backslashes must not be rewritten into forward slashes"
        );

        let mut reversed = sample("mapping-2");
        reversed.initiator_path = "\\\\server\\share\\Projects".to_owned();
        reversed.responder_path = "/mnt/data/Projects".to_owned();
        store.upsert(&reversed).expect("upsert UNC path");

        let fetched = store.get("mapping-2").expect("get").expect("present");
        assert_eq!(fetched.initiator_path, "\\\\server\\share\\Projects");
        assert_eq!(fetched.responder_path, "/mnt/data/Projects");
    }

    #[test]
    fn rejects_records_that_fail_validation() {
        let store = MappingStore::open_in_memory().expect("open store");

        let cases: Vec<(&str, Mutation)> = vec![
            (
                "empty id",
                Box::new(|record: &mut MappingRecord| record.id = String::new()),
            ),
            (
                "blank id",
                Box::new(|record: &mut MappingRecord| record.id = "   ".to_owned()),
            ),
            (
                "overlong id",
                Box::new(|record: &mut MappingRecord| record.id = "x".repeat(201)),
            ),
            (
                "empty name",
                Box::new(|record: &mut MappingRecord| record.name = String::new()),
            ),
            (
                "empty initiator device id",
                Box::new(|record: &mut MappingRecord| record.initiator_device_id = String::new()),
            ),
            (
                "empty responder device id",
                Box::new(|record: &mut MappingRecord| record.responder_device_id = String::new()),
            ),
            (
                "empty initiator path",
                Box::new(|record: &mut MappingRecord| record.initiator_path = String::new()),
            ),
            (
                "empty responder path",
                Box::new(|record: &mut MappingRecord| record.responder_path = String::new()),
            ),
            (
                "unknown mode",
                Box::new(|record: &mut MappingRecord| record.mode = "sideways".to_owned()),
            ),
            (
                "empty mode",
                Box::new(|record: &mut MappingRecord| record.mode = String::new()),
            ),
            (
                "negative history days",
                Box::new(|record: &mut MappingRecord| record.history_days = -1),
            ),
            (
                "absurd history days",
                Box::new(|record: &mut MappingRecord| record.history_days = 10_000),
            ),
            (
                "negative history bytes",
                Box::new(|record: &mut MappingRecord| record.history_max_bytes = -1),
            ),
            (
                "too many ignore patterns",
                Box::new(|record: &mut MappingRecord| {
                    record.ignore_patterns = vec!["x".to_owned(); 1_001];
                }),
            ),
            (
                "overlong ignore pattern",
                Box::new(|record: &mut MappingRecord| {
                    record.ignore_patterns = vec!["x".repeat(1_025)];
                }),
            ),
        ];

        for (label, mutate) in cases {
            let mut record = sample("mapping-1");
            mutate(&mut record);
            let error = store.upsert(&record).expect_err(label);
            assert!(
                matches!(error, MappingStoreError::Invalid(_)),
                "{label} should be rejected as invalid, got {error:?}"
            );
        }

        assert!(
            store.list().expect("list").is_empty(),
            "no invalid record should have reached the database"
        );
    }

    #[test]
    fn rejects_blank_ids_on_read_and_delete() {
        let store = MappingStore::open_in_memory().expect("open store");
        assert!(matches!(
            store.get("").expect_err("blank get"),
            MappingStoreError::Invalid(_)
        ));
        assert!(matches!(
            store.delete("  ").expect_err("blank delete"),
            MappingStoreError::Invalid(_)
        ));
    }

    #[test]
    fn a_fresh_database_is_stamped_with_the_current_schema_version() {
        let store = MappingStore::open_in_memory().expect("open store");
        assert_eq!(store.schema_version().expect("version"), SCHEMA_VERSION);
    }

    #[test]
    fn adopts_a_version_zero_database_written_before_migrations_existed() {
        let directory = tempfile::tempdir().expect("tempdir");
        let path = directory.path().join("mappings.sqlite3");

        // Exactly what the pre-migration build left behind: the table, no `user_version`.
        let legacy = rusqlite::Connection::open(&path).expect("open legacy");
        legacy
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
                INSERT INTO folder_mappings VALUES (
                    'legacy-1', 'Projects', 'linux-box', 'Linux Mint', 'win-box', 'Windows 11',
                    '/home/tommy/Projects', 'C:\\Users\\tommy\\Projects', 'two-way', '[]',
                    30, 5000000000, 'active', 0, NULL,
                    '2026-07-01T00:00:00Z', '2026-07-01T00:00:00Z'
                );",
            )
            .expect("seed the legacy schema");
        drop(legacy);

        let store = MappingStore::open(&path).expect("open and migrate");
        assert_eq!(store.schema_version().expect("version"), SCHEMA_VERSION);
        assert_eq!(
            store.get("legacy-1").expect("get").expect("present").name,
            "Projects",
            "migrating must not drop rows the old build wrote"
        );
    }

    #[test]
    fn migrating_twice_is_a_no_op() {
        let directory = tempfile::tempdir().expect("tempdir");
        let path = directory.path().join("mappings.sqlite3");

        let first = MappingStore::open(&path).expect("open");
        first.upsert(&sample("mapping-1")).expect("insert");
        drop(first);

        let second = MappingStore::open(&path).expect("reopen");
        assert_eq!(second.schema_version().expect("version"), SCHEMA_VERSION);
        assert!(second.get("mapping-1").expect("get").is_some());
    }

    #[test]
    fn refuses_to_open_a_database_from_a_newer_schema_version() {
        let directory = tempfile::tempdir().expect("tempdir");
        let path = directory.path().join("mappings.sqlite3");

        let future = rusqlite::Connection::open(&path).expect("open");
        future
            .pragma_update(None, "user_version", SCHEMA_VERSION + 1)
            .expect("stamp a future version");
        drop(future);

        let error = MappingStore::open(&path).expect_err("should refuse");
        assert!(
            matches!(
                error,
                MappingStoreError::UnsupportedSchemaVersion { found } if found == SCHEMA_VERSION + 1
            ),
            "expected an unsupported-version error, got {error:?}"
        );
    }

    #[test]
    fn an_on_disk_database_runs_in_wal_mode_with_foreign_keys_on() {
        let directory = tempfile::tempdir().expect("tempdir");
        let store = MappingStore::open(directory.path().join("mappings.sqlite3")).expect("open");
        assert_eq!(store.journal_mode(), "wal");

        let foreign_keys: bool = store
            .connection
            .query_row("PRAGMA foreign_keys", [], |row| row.get(0))
            .expect("read foreign_keys");
        assert!(foreign_keys, "foreign key enforcement should be on");
    }

    #[test]
    fn malformed_stored_json_surfaces_as_a_structured_error() {
        let directory = tempfile::tempdir().expect("tempdir");
        let store = MappingStore::open(directory.path().join("mappings.sqlite3")).expect("open");
        store.upsert(&sample("mapping-1")).expect("insert");

        store
            .connection
            .execute(
                "UPDATE folder_mappings SET ignore_patterns = '{not valid json' WHERE id = ?1",
                rusqlite::params!["mapping-1"],
            )
            .expect("corrupt the row");

        let error = store.get("mapping-1").expect_err("should not panic");
        assert!(
            matches!(
                &error,
                MappingStoreError::CorruptRecord { id, column, .. }
                    if id == "mapping-1" && *column == "ignore_patterns"
            ),
            "expected a corrupt-record error naming the column, got {error:?}"
        );
        // The same failure has to stay structured on the list path too, not just the point read.
        assert!(matches!(
            store.list().expect_err("list should not panic"),
            MappingStoreError::CorruptRecord { .. }
        ));
    }

    #[test]
    fn a_corrupt_preview_column_is_reported_against_its_own_column() {
        let directory = tempfile::tempdir().expect("tempdir");
        let store = MappingStore::open(directory.path().join("mappings.sqlite3")).expect("open");
        store.upsert(&sample("mapping-1")).expect("insert");
        store
            .connection
            .execute(
                "UPDATE folder_mappings SET preview = 'nonsense' WHERE id = ?1",
                rusqlite::params!["mapping-1"],
            )
            .expect("corrupt the row");

        let error = store.get("mapping-1").expect_err("should not panic");
        assert!(
            matches!(&error, MappingStoreError::CorruptRecord { column, .. } if *column == "preview"),
            "expected the preview column to be named, got {error:?}"
        );
    }

    #[test]
    fn opening_an_unusable_path_returns_an_error_instead_of_panicking() {
        let directory = tempfile::tempdir().expect("tempdir");
        // A directory can never be opened as a database file.
        let error = MappingStore::open(directory.path()).expect_err("should fail to open");
        assert!(matches!(error, MappingStoreError::Database(_)));

        // Neither can a path whose parent directory does not exist.
        let missing = directory
            .path()
            .join("no-such-dir")
            .join("mappings.sqlite3");
        assert!(MappingStore::open(missing).is_err());
    }

    #[test]
    fn a_file_that_is_not_a_database_fails_to_open_cleanly() {
        let directory = tempfile::tempdir().expect("tempdir");
        let path = directory.path().join("mappings.sqlite3");
        std::fs::write(&path, b"this is definitely not a SQLite database").expect("write junk");

        assert!(
            MappingStore::open(&path).is_err(),
            "a corrupt database file must surface an error, not a panic"
        );
    }

    #[test]
    fn a_second_store_on_the_same_file_sees_the_first_stores_writes() {
        let directory = tempfile::tempdir().expect("tempdir");
        let path = directory.path().join("mappings.sqlite3");

        let first = MappingStore::open(&path).expect("open first");
        let second = MappingStore::open(&path).expect("open second");

        first.upsert(&sample("mapping-1")).expect("write via first");
        assert!(
            second.get("mapping-1").expect("read via second").is_some(),
            "a WAL reader must see a committed write from another connection"
        );

        second
            .upsert(&sample("mapping-2"))
            .expect("write via second");
        assert_eq!(
            first.list().expect("list via first").len(),
            2,
            "two connections must converge on one table, not fork it"
        );
    }
}
