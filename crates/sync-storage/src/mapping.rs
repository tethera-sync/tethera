//! Durable storage for approved and in-flight folder-mapping proposals.
use std::path::Path;

use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};
use serde_json::Value;

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

#[derive(Debug, thiserror::Error)]
pub enum MappingStoreError {
    #[error("database error: {0}")]
    Database(#[from] rusqlite::Error),
    #[error("serialisation error: {0}")]
    Serialisation(#[from] serde_json::Error),
}

pub struct MappingStore {
    connection: Connection,
}

impl MappingStore {
    /// Opens (creating if needed) a `SQLite` database at `path` and applies migrations.
    ///
    /// # Errors
    ///
    /// Returns `Err` if the database file cannot be opened or migrated.
    pub fn open(path: impl AsRef<Path>) -> Result<Self, MappingStoreError> {
        let connection = Connection::open(path)?;
        connection.pragma_update(None, "journal_mode", "WAL")?;
        connection.pragma_update(None, "foreign_keys", true)?;
        let store = Self { connection };
        store.migrate()?;
        Ok(store)
    }

    /// Opens an in-memory database, primarily for tests.
    ///
    /// # Errors
    ///
    /// Returns `Err` if the database cannot be created or migrated.
    pub fn open_in_memory() -> Result<Self, MappingStoreError> {
        let connection = Connection::open_in_memory()?;
        let store = Self { connection };
        store.migrate()?;
        Ok(store)
    }

    fn migrate(&self) -> Result<(), MappingStoreError> {
        self.connection.execute_batch(
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
            );",
        )?;
        Ok(())
    }

    /// Inserts a mapping, or replaces every field of an existing mapping with the same id.
    ///
    /// # Errors
    ///
    /// Returns `Err` if the record cannot be serialised or the write fails.
    pub fn upsert(&self, record: &MappingRecord) -> Result<(), MappingStoreError> {
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
    /// Returns `Err` if the query fails or the stored record cannot be deserialised.
    pub fn get(&self, id: &str) -> Result<Option<MappingRecord>, MappingStoreError> {
        let row = self
            .connection
            .query_row(
                "SELECT id, name, initiator_device_id, initiator_device_name,
                        responder_device_id, responder_device_name,
                        initiator_path, responder_path, mode, ignore_patterns,
                        history_days, history_max_bytes, setup_status, pending_delivery,
                        preview, created_at, updated_at
                 FROM folder_mappings WHERE id = ?1",
                params![id],
                Self::row_to_columns,
            )
            .optional()?;
        row.map(Self::columns_to_record).transpose()
    }

    /// # Errors
    ///
    /// Returns `Err` if the query fails or a stored record cannot be deserialised.
    pub fn list(&self) -> Result<Vec<MappingRecord>, MappingStoreError> {
        self.list_where("1 = 1", params![])
    }

    /// # Errors
    ///
    /// Returns `Err` if the query fails or a stored record cannot be deserialised.
    pub fn list_pending_delivery(&self) -> Result<Vec<MappingRecord>, MappingStoreError> {
        self.list_where("pending_delivery = 1", params![])
    }

    fn list_where(
        &self,
        predicate: &str,
        query_params: &[&dyn rusqlite::ToSql],
    ) -> Result<Vec<MappingRecord>, MappingStoreError> {
        let sql = format!(
            "SELECT id, name, initiator_device_id, initiator_device_name,
                    responder_device_id, responder_device_name,
                    initiator_path, responder_path, mode, ignore_patterns,
                    history_days, history_max_bytes, setup_status, pending_delivery,
                    preview, created_at, updated_at
             FROM folder_mappings WHERE {predicate} ORDER BY created_at ASC"
        );
        let mut statement = self.connection.prepare(&sql)?;
        let rows = statement.query_map(query_params, Self::row_to_columns)?;
        let mut records = Vec::new();
        for row in rows {
            records.push(Self::columns_to_record(row?)?);
        }
        Ok(records)
    }

    /// Returns `true` if a mapping with `id` existed and was removed.
    ///
    /// # Errors
    ///
    /// Returns `Err` if the delete statement fails.
    pub fn delete(&self, id: &str) -> Result<bool, MappingStoreError> {
        let affected = self
            .connection
            .execute("DELETE FROM folder_mappings WHERE id = ?1", params![id])?;
        Ok(affected > 0)
    }

    #[allow(clippy::type_complexity)]
    fn row_to_columns(
        row: &rusqlite::Row<'_>,
    ) -> rusqlite::Result<(
        String,
        String,
        String,
        String,
        String,
        String,
        String,
        String,
        String,
        String,
        i64,
        i64,
        String,
        bool,
        Option<String>,
        String,
        String,
    )> {
        Ok((
            row.get(0)?,
            row.get(1)?,
            row.get(2)?,
            row.get(3)?,
            row.get(4)?,
            row.get(5)?,
            row.get(6)?,
            row.get(7)?,
            row.get(8)?,
            row.get(9)?,
            row.get(10)?,
            row.get(11)?,
            row.get(12)?,
            row.get(13)?,
            row.get(14)?,
            row.get(15)?,
            row.get(16)?,
        ))
    }

    #[allow(clippy::type_complexity)]
    fn columns_to_record(
        columns: (
            String,
            String,
            String,
            String,
            String,
            String,
            String,
            String,
            String,
            String,
            i64,
            i64,
            String,
            bool,
            Option<String>,
            String,
            String,
        ),
    ) -> Result<MappingRecord, MappingStoreError> {
        let (
            id,
            name,
            initiator_device_id,
            initiator_device_name,
            responder_device_id,
            responder_device_name,
            initiator_path,
            responder_path,
            mode,
            ignore_patterns,
            history_days,
            history_max_bytes,
            setup_status,
            pending_delivery,
            preview,
            created_at,
            updated_at,
        ) = columns;

        Ok(MappingRecord {
            id,
            name,
            initiator_device_id,
            initiator_device_name,
            responder_device_id,
            responder_device_name,
            initiator_path,
            responder_path,
            mode,
            ignore_patterns: serde_json::from_str(&ignore_patterns)?,
            history_days,
            history_max_bytes,
            setup_status,
            pending_delivery,
            preview: preview.map(|value| serde_json::from_str(&value)).transpose()?,
            created_at,
            updated_at,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::{MappingRecord, MappingStore};

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
    fn list_returns_mappings_ordered_by_creation() {
        let store = MappingStore::open_in_memory().expect("open store");
        let mut first = sample("mapping-1");
        first.created_at = "2026-08-01T00:00:00Z".to_owned();
        let mut second = sample("mapping-2");
        second.created_at = "2026-08-02T00:00:00Z".to_owned();

        store.upsert(&second).expect("insert second");
        store.upsert(&first).expect("insert first");

        let ids: Vec<String> = store.list().expect("list").into_iter().map(|record| record.id).collect();
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
    fn delete_removes_a_mapping_and_reports_whether_it_existed() {
        let store = MappingStore::open_in_memory().expect("open store");
        store.upsert(&sample("mapping-1")).expect("insert");

        assert!(store.delete("mapping-1").expect("delete"));
        assert!(!store.delete("mapping-1").expect("delete again"));
        assert_eq!(store.get("mapping-1").expect("get"), None);
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
}
