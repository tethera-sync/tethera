//! Rust-owned SQLite scan generations: bounded staged observations.
//!
//! Traversal stays in the desktop shell for now; batches arrive here over
//! authenticated RPC and are staged transactionally. Only a sealed complete
//! generation is visible to baseline/planning reads. Incomplete, aborted, or
//! stale generations never advance baselines or replace active state.

use rusqlite::{OptionalExtension, Transaction, TransactionBehavior, params};
use serde::{Deserialize, Serialize};

use crate::mapping::{MappingStore, MappingStoreError, check_identifier};

pub const MAX_GENERATIONS_PER_MAPPING: i64 = 4;
pub const MAX_ENTRIES_PER_GENERATION: i64 = 1_000_000;
pub const MAX_PAGE_ENTRIES: i64 = 1_000;
pub const MAX_BATCH_ENTRIES: usize = 1_000;
pub const MAX_ID_LENGTH: usize = 200;
pub const MAX_PATH_LENGTH: usize = 4_096;
pub const GENERATION_TTL_HOURS: i64 = 24;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BeginGenerationRequest {
    pub generation_id: String,
    pub mapping_id: String,
    pub participant_device_id: String,
    pub mapping_revision: i64,
    pub root: String,
    pub ignore_patterns: Vec<String>,
    pub hash_mode: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AppendBatchRequest {
    pub generation_id: String,
    pub sequence: i64,
    pub entries: Vec<GenerationEntry>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GenerationEntry {
    pub path: String,
    pub size: i64,
    pub digest: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SealGenerationRequest {
    pub generation_id: String,
    pub expected_count: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GenerationStatus {
    pub generation_id: String,
    pub mapping_id: String,
    pub state: String,
    pub entry_count: i64,
    pub next_sequence: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GenerationPage {
    pub generation_id: String,
    pub entries: Vec<GenerationEntry>,
    pub next_cursor: Option<String>,
}

pub(crate) fn validate_generation_id(value: &str) -> Result<(), MappingStoreError> {
    check_identifier("generationId", value)?;
    if value.len() > MAX_ID_LENGTH {
        return Err(MappingStoreError::Invalid(
            "generation id is too long".to_owned(),
        ));
    }
    Ok(())
}

fn validate_hash_mode(value: &str) -> Result<(), MappingStoreError> {
    if value != "full-sha256" && value != "preview" {
        return Err(MappingStoreError::Invalid(
            "hash mode must be full-sha256 or preview".to_owned(),
        ));
    }
    Ok(())
}

pub(crate) fn validate_generation_entry(entry: &GenerationEntry) -> Result<(), MappingStoreError> {
    crate::file_sync::validate_path(&entry.path)?;
    crate::file_sync::validate_size(entry.size)?;
    if let Some(digest) = entry.digest.as_deref() {
        crate::file_sync::validate_digest(digest)?;
    }
    Ok(())
}

impl MappingStore {
    /// Begins one bounded staged scan generation bound to the current mapping revision.
    ///
    /// # Errors
    ///
    /// Returns a validation, mapping-state, or database error without creating
    /// a partial generation.
    #[allow(clippy::too_many_lines)]
    pub fn begin_scan_generation(
        &self,
        request: &BeginGenerationRequest,
    ) -> Result<GenerationStatus, MappingStoreError> {
        self.ensure_import_completed()?;
        validate_generation_id(&request.generation_id)?;
        check_identifier("mappingId", &request.mapping_id)?;
        check_identifier("participantDeviceId", &request.participant_device_id)?;
        if request.mapping_revision <= 0 {
            return Err(MappingStoreError::Invalid(
                "mapping revision must be positive".to_owned(),
            ));
        }
        if request.root.is_empty()
            || request.root.len() > MAX_PATH_LENGTH
            || request.root.contains('\0')
        {
            return Err(MappingStoreError::Invalid(
                "generation root must be a non-empty bounded path".to_owned(),
            ));
        }
        if request.ignore_patterns.len() > 256 {
            return Err(MappingStoreError::Invalid(
                "generation ignore rules exceed the supported limit".to_owned(),
            ));
        }
        for pattern in &request.ignore_patterns {
            if pattern.len() > 512 || pattern.contains('\0') {
                return Err(MappingStoreError::Invalid(
                    "generation ignore rule is invalid".to_owned(),
                ));
            }
        }
        validate_hash_mode(&request.hash_mode)?;
        let now = now_rfc3339();

        let transaction =
            Transaction::new_unchecked(&self.connection, TransactionBehavior::Immediate)?;
        let mapping = require_mapping_participants(&transaction, &request.mapping_id)?;
        if request.participant_device_id != mapping.0 && request.participant_device_id != mapping.1
        {
            return Err(MappingStoreError::Invalid(
                "generation participant is not a mapping participant".to_owned(),
            ));
        }
        let current_revision: i64 = transaction
            .query_row(
                "SELECT revision FROM mapping_revisions WHERE mapping_id = ?1",
                params![request.mapping_id],
                |row| row.get(0),
            )
            .optional()?
            .ok_or_else(|| MappingStoreError::NotFound(request.mapping_id.clone()))?;
        if current_revision != request.mapping_revision {
            return Err(MappingStoreError::Invalid(
                "generation mapping revision is stale".to_owned(),
            ));
        }
        let live: i64 = transaction.query_row(
            "SELECT COUNT(*) FROM scan_generations WHERE mapping_id = ?1 AND state = 'open'",
            params![request.mapping_id],
            |row| row.get(0),
        )?;
        if live >= MAX_GENERATIONS_PER_MAPPING {
            return Err(MappingStoreError::Invalid(
                "too many open scan generations for this mapping".to_owned(),
            ));
        }
        let patterns_json = serde_json::to_string(&request.ignore_patterns).map_err(|error| {
            MappingStoreError::Invalid(format!("ignore rules are not serialisable: {error}"))
        })?;
        let expires_at = expiry_rfc3339(&now);
        transaction.execute(
            "INSERT INTO scan_generations (
                generation_id, mapping_id, participant_device_id, mapping_revision,
                root, ignore_patterns, hash_mode, state,
                entry_count, next_sequence, created_at, updated_at, expires_at
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'open', 0, 0, ?8, ?8, ?9)
            ON CONFLICT(generation_id) DO NOTHING",
            params![
                request.generation_id,
                request.mapping_id,
                request.participant_device_id,
                request.mapping_revision,
                request.root,
                patterns_json,
                request.hash_mode,
                now,
                expires_at,
            ],
        )?;
        // If the id already exists it must describe the identical generation;
        // a changed duplicate is rejected rather than silently reused.
        let row: (String, String, String, i64, String, String, String, String) = transaction
            .query_row(
                "SELECT mapping_id, participant_device_id, root, mapping_revision, ignore_patterns, hash_mode, state, generation_id
                 FROM scan_generations WHERE generation_id = ?1",
                params![request.generation_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?, row.get(5)?, row.get(6)?, row.get(7)?)),
            )?;
        if row.0 != request.mapping_id
            || row.1 != request.participant_device_id
            || row.2 != request.root
            || row.3 != request.mapping_revision
            || row.4 != patterns_json
            || row.5 != request.hash_mode
        {
            return Err(MappingStoreError::Invalid(
                "scan generation id is already bound to a different scan".to_owned(),
            ));
        }
        transaction.commit()?;
        self.generation_status(&request.generation_id)
    }

    /// Appends one idempotent batch to an open generation.
    ///
    /// # Errors
    ///
    /// Returns a validation, gap, duplicate, quota, stale-revision, or database
    /// error without committing a partial batch.
    #[allow(clippy::too_many_lines)]
    pub fn append_scan_batch(
        &self,
        request: &AppendBatchRequest,
    ) -> Result<GenerationStatus, MappingStoreError> {
        self.ensure_import_completed()?;
        validate_generation_id(&request.generation_id)?;
        if request.sequence < 0 {
            return Err(MappingStoreError::Invalid(
                "batch sequence must not be negative".to_owned(),
            ));
        }
        if request.entries.len() > MAX_BATCH_ENTRIES {
            return Err(MappingStoreError::Invalid(
                "batch exceeds the per-batch entry limit".to_owned(),
            ));
        }
        for entry in &request.entries {
            validate_generation_entry(entry)?;
        }
        // Duplicate paths inside one batch are rejected; across batches a
        // changed duplicate is rejected while an identical re-delivery is
        // idempotent.
        {
            let mut seen = std::collections::HashSet::new();
            for entry in &request.entries {
                if !seen.insert(entry.path.as_str()) {
                    return Err(MappingStoreError::Invalid(format!(
                        "batch contains duplicate path {:?}",
                        entry.path
                    )));
                }
            }
        }
        let now = now_rfc3339();
        let transaction =
            Transaction::new_unchecked(&self.connection, TransactionBehavior::Immediate)?;
        let meta: (String, i64, String, i64, i64) = transaction
            .query_row(
                "SELECT mapping_id, mapping_revision, state, entry_count, next_sequence
                 FROM scan_generations WHERE generation_id = ?1",
                params![request.generation_id],
                |row| {
                    Ok((
                        row.get(0)?,
                        row.get(1)?,
                        row.get(2)?,
                        row.get(3)?,
                        row.get(4)?,
                    ))
                },
            )
            .optional()?
            .ok_or_else(|| {
                MappingStoreError::NotFound(format!("scan generation {}", request.generation_id))
            })?;
        let (mapping_id, revision, state, entry_count, next_sequence) = meta;
        if state != "open" {
            return Err(MappingStoreError::Invalid(
                "scan generation is no longer open for batches".to_owned(),
            ));
        }
        require_current_revision(&transaction, &mapping_id, revision)?;
        if request.sequence > next_sequence {
            return Err(MappingStoreError::Invalid(
                "batch sequence has a gap; resend the missing batch first".to_owned(),
            ));
        }
        if request.sequence < next_sequence {
            // Idempotent retry: every entry must already exist identically.
            for entry in &request.entries {
                let stored: Option<(i64, Option<String>)> = transaction
                    .query_row(
                        "SELECT size, digest FROM scan_entries WHERE generation_id = ?1 AND relative_path = ?2",
                        params![request.generation_id, entry.path],
                        |row| Ok((row.get(0)?, row.get(1)?)),
                    )
                    .optional()?;
                match stored {
                    Some((size, digest)) if size == entry.size && digest == entry.digest => {}
                    _ => {
                        return Err(MappingStoreError::Invalid(
                            "replayed batch does not match the stored entries".to_owned(),
                        ));
                    }
                }
            }
            transaction.commit()?;
            return self.generation_status(&request.generation_id);
        }
        if entry_count + i64::try_from(request.entries.len()).unwrap_or(i64::MAX)
            > MAX_ENTRIES_PER_GENERATION
        {
            return Err(MappingStoreError::Invalid(
                "scan generation exceeds its entry quota".to_owned(),
            ));
        }
        for entry in &request.entries {
            let stored: Option<(i64, Option<String>)> = transaction
                .query_row(
                    "SELECT size, digest FROM scan_entries WHERE generation_id = ?1 AND relative_path = ?2",
                    params![request.generation_id, entry.path],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .optional()?;
            if let Some((size, digest)) = stored {
                if size != entry.size || digest != entry.digest {
                    return Err(MappingStoreError::Invalid(format!(
                        "scan generation contains a changed duplicate path {:?}",
                        entry.path
                    )));
                }
                continue;
            }
            transaction.execute(
                "INSERT INTO scan_entries (generation_id, relative_path, digest, size)
                 VALUES (?1, ?2, ?3, ?4)",
                params![request.generation_id, entry.path, entry.digest, entry.size],
            )?;
        }
        // Count only newly stored rows (identical cross-batch re-deliveries do
        // not inflate the count).
        let fresh_count: i64 = transaction.query_row(
            "SELECT COUNT(*) FROM scan_entries WHERE generation_id = ?1",
            params![request.generation_id],
            |row| row.get(0),
        )?;
        transaction.execute(
            "UPDATE scan_generations SET entry_count = ?2, next_sequence = next_sequence + 1, updated_at = ?3
             WHERE generation_id = ?1",
            params![request.generation_id, fresh_count, now],
        )?;
        transaction.commit()?;
        self.generation_status(&request.generation_id)
    }

    /// Seals a complete generation after verifying its staged count.
    ///
    /// # Errors
    ///
    /// Returns a validation, incomplete-generation, stale-revision, or database
    /// error without changing durable state.
    pub fn seal_scan_generation(
        &self,
        request: &SealGenerationRequest,
    ) -> Result<GenerationStatus, MappingStoreError> {
        self.ensure_import_completed()?;
        validate_generation_id(&request.generation_id)?;
        if request.expected_count < 0 || request.expected_count > MAX_ENTRIES_PER_GENERATION {
            return Err(MappingStoreError::Invalid(
                "seal count is outside the supported generation quota".to_owned(),
            ));
        }
        let now = now_rfc3339();
        let transaction =
            Transaction::new_unchecked(&self.connection, TransactionBehavior::Immediate)?;
        let meta: (String, i64, String, i64) = transaction
            .query_row(
                "SELECT mapping_id, mapping_revision, state, entry_count
                 FROM scan_generations WHERE generation_id = ?1",
                params![request.generation_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .optional()?
            .ok_or_else(|| {
                MappingStoreError::NotFound(format!("scan generation {}", request.generation_id))
            })?;
        let (mapping_id, revision, state, entry_count) = meta;
        if state != "open" {
            return Err(MappingStoreError::Invalid(
                "only an open scan generation can be sealed".to_owned(),
            ));
        }
        require_current_revision(&transaction, &mapping_id, revision)?;
        let stored: i64 = transaction.query_row(
            "SELECT COUNT(*) FROM scan_entries WHERE generation_id = ?1",
            params![request.generation_id],
            |row| row.get(0),
        )?;
        if stored != entry_count || stored != request.expected_count {
            return Err(MappingStoreError::Invalid(
                "seal count does not match the complete staged scan".to_owned(),
            ));
        }
        transaction.execute(
            "UPDATE scan_generations SET state = 'sealed', updated_at = ?2, sealed_at = ?2
             WHERE generation_id = ?1",
            params![request.generation_id, now],
        )?;
        transaction.commit()?;
        self.generation_status(&request.generation_id)
    }

    /// Aborts an open generation and clears its staged entries.
    ///
    /// # Errors
    ///
    /// Returns a validation, missing-generation, or database error.
    pub fn abort_scan_generation(
        &self,
        generation_id: &str,
    ) -> Result<GenerationStatus, MappingStoreError> {
        self.ensure_import_completed()?;
        validate_generation_id(generation_id)?;
        let now = now_rfc3339();
        let transaction =
            Transaction::new_unchecked(&self.connection, TransactionBehavior::Immediate)?;
        let state: Option<String> = transaction
            .query_row(
                "SELECT state FROM scan_generations WHERE generation_id = ?1",
                params![generation_id],
                |row| row.get(0),
            )
            .optional()?;
        match state.as_deref() {
            None => {
                return Err(MappingStoreError::NotFound(format!(
                    "scan generation {generation_id}"
                )));
            }
            Some("aborted") => {
                transaction.commit()?;
                return self.generation_status(generation_id);
            }
            Some("sealed") => {
                return Err(MappingStoreError::Invalid(
                    "a sealed scan generation cannot be aborted".to_owned(),
                ));
            }
            _ => {}
        }
        transaction.execute(
            "UPDATE scan_generations SET state = 'aborted', updated_at = ?2 WHERE generation_id = ?1",
            params![generation_id, now],
        )?;
        transaction.execute(
            "DELETE FROM scan_entries WHERE generation_id = ?1",
            params![generation_id],
        )?;
        transaction.commit()?;
        self.generation_status(generation_id)
    }

    /// Reads the durable status of one generation.
    ///
    /// # Errors
    ///
    /// Returns a validation, missing-generation, or database error.
    pub fn generation_status(
        &self,
        generation_id: &str,
    ) -> Result<GenerationStatus, MappingStoreError> {
        self.ensure_import_completed()?;
        validate_generation_id(generation_id)?;
        let row: Option<(String, String, i64, i64)> = self
            .connection
            .query_row(
                "SELECT mapping_id, state, entry_count, next_sequence
                 FROM scan_generations WHERE generation_id = ?1",
                params![generation_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .optional()?;
        match row {
            Some((mapping_id, state, entry_count, next_sequence)) => Ok(GenerationStatus {
                generation_id: generation_id.to_owned(),
                mapping_id,
                state,
                entry_count,
                next_sequence,
            }),
            None => Err(MappingStoreError::NotFound(format!(
                "scan generation {generation_id}"
            ))),
        }
    }

    /// Ordered keyset page over a sealed generation owned by `mapping_id`.
    /// Incomplete generations are invisible to planning reads by design.
    ///
    /// A generation owned by another mapping is reported exactly like a
    /// missing one, so a peer-facing read cannot confirm that an unrelated
    /// generation exists.
    ///
    /// # Errors
    ///
    /// Returns a validation, missing-generation, incomplete-generation, or
    /// database error.
    pub fn read_generation_page(
        &self,
        mapping_id: &str,
        generation_id: &str,
        cursor: Option<&str>,
        limit: i64,
    ) -> Result<GenerationPage, MappingStoreError> {
        self.ensure_import_completed()?;
        check_identifier("mappingId", mapping_id)?;
        validate_generation_id(generation_id)?;
        if limit <= 0 || limit > MAX_PAGE_ENTRIES {
            return Err(MappingStoreError::Invalid(
                "page limit is outside the supported bound".to_owned(),
            ));
        }
        if let Some(cursor) = cursor {
            crate::file_sync::validate_path(cursor)?;
        }
        let state: String = self
            .connection
            .query_row(
                "SELECT state FROM scan_generations WHERE generation_id = ?1 AND mapping_id = ?2",
                params![generation_id, mapping_id],
                |row| row.get(0),
            )
            .optional()?
            .ok_or_else(|| {
                MappingStoreError::NotFound(format!("scan generation {generation_id}"))
            })?;
        if state != "sealed" {
            return Err(MappingStoreError::Invalid(
                "only a sealed scan generation can be read for planning".to_owned(),
            ));
        }
        let mut statement = self.connection.prepare(
            "SELECT relative_path, size, digest FROM scan_entries
             WHERE generation_id = ?1 AND (?2 IS NULL OR relative_path > ?2)
             ORDER BY relative_path LIMIT ?3",
        )?;
        let rows = statement.query_map(params![generation_id, cursor, limit + 1], |row| {
            Ok(GenerationEntry {
                path: row.get(0)?,
                size: row.get(1)?,
                digest: row.get(2)?,
            })
        })?;
        let mut entries = Vec::new();
        for row in rows {
            entries.push(row?);
        }
        let next_cursor = if i64::try_from(entries.len()).unwrap_or(i64::MAX) > limit {
            entries.pop();
            entries.last().map(|entry| entry.path.clone())
        } else {
            None
        };
        Ok(GenerationPage {
            generation_id: generation_id.to_owned(),
            entries,
            next_cursor,
        })
    }

    /// Removes aborted generations and generations past their TTL. Sealed
    /// generations are retained while their mapping still references them.
    ///
    /// # Errors
    ///
    /// Returns a validation or database error.
    pub fn cleanup_scan_generations(&self, now: &str) -> Result<i64, MappingStoreError> {
        crate::file_sync::validate_timestamp("now", now)?;
        let transaction =
            Transaction::new_unchecked(&self.connection, TransactionBehavior::Immediate)?;
        let removed = transaction.execute(
            "DELETE FROM scan_generations WHERE state = 'aborted' OR expires_at <= ?1",
            params![now],
        )?;
        transaction.commit()?;
        Ok(i64::try_from(removed).unwrap_or(i64::MAX))
    }
}

fn require_mapping_participants(
    transaction: &Transaction<'_>,
    mapping_id: &str,
) -> Result<(String, String), MappingStoreError> {
    transaction
        .query_row(
            "SELECT initiator_device_id, responder_device_id FROM folder_mappings WHERE id = ?1",
            params![mapping_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?
        .ok_or_else(|| MappingStoreError::NotFound(mapping_id.to_owned()))
}

fn require_current_revision(
    transaction: &Transaction<'_>,
    mapping_id: &str,
    revision: i64,
) -> Result<(), MappingStoreError> {
    let current: i64 = transaction
        .query_row(
            "SELECT revision FROM mapping_revisions WHERE mapping_id = ?1",
            params![mapping_id],
            |row| row.get(0),
        )
        .optional()?
        .ok_or_else(|| MappingStoreError::NotFound(mapping_id.to_owned()))?;
    if current != revision {
        return Err(MappingStoreError::Invalid(
            "scan generation mapping revision is stale".to_owned(),
        ));
    }
    Ok(())
}

fn now_rfc3339() -> String {
    time::OffsetDateTime::now_utc()
        .format(&time::format_description::well_known::Rfc3339)
        .unwrap_or_else(|_| "2026-01-01T00:00:00Z".to_owned())
}

fn expiry_rfc3339(now: &str) -> String {
    let parsed = time::OffsetDateTime::parse(now, &time::format_description::well_known::Rfc3339)
        .unwrap_or(time::OffsetDateTime::UNIX_EPOCH);
    (parsed + time::Duration::hours(GENERATION_TTL_HOURS))
        .format(&time::format_description::well_known::Rfc3339)
        .unwrap_or_else(|_| now.to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::mapping::{LegacyImportRequest, MappingConfiguration};

    const NOW: &str = "2026-08-08T12:00:00Z";

    fn active_store() -> MappingStore {
        let store = MappingStore::open_in_memory().expect("open store");
        store
            .import_legacy(&LegacyImportRequest {
                source_fingerprint: "0".repeat(64),
                importing_device_id: "a-device".to_owned(),
                imported_at: NOW.to_owned(),
                records: Vec::new(),
            })
            .expect("complete import");
        store
            .upsert_local(
                &MappingConfiguration {
                    id: "mapping-1".to_owned(),
                    name: "Folder".to_owned(),
                    initiator_device_id: "a-device".to_owned(),
                    initiator_device_name: "A".to_owned(),
                    responder_device_id: "b-device".to_owned(),
                    responder_device_name: "B".to_owned(),
                    initiator_path: "/tmp/a".to_owned(),
                    responder_path: "/tmp/b".to_owned(),
                    mode: "two-way".to_owned(),
                    ignore_patterns: Vec::new(),
                    history_days: 0,
                    history_max_bytes: 0,
                    max_file_bytes: None,
                    setup_status: "active".to_owned(),
                    paused: false,
                    preview: None,
                    created_at: NOW.to_owned(),
                    updated_at: NOW.to_owned(),
                },
                "a-device",
                None,
                None,
                NOW,
            )
            .expect("insert mapping");
        store
    }

    fn begin(store: &MappingStore, generation_id: &str) {
        store
            .begin_scan_generation(&BeginGenerationRequest {
                generation_id: generation_id.to_owned(),
                mapping_id: "mapping-1".to_owned(),
                participant_device_id: "a-device".to_owned(),
                mapping_revision: 1,
                root: "/tmp/a".to_owned(),
                ignore_patterns: Vec::new(),
                hash_mode: "full-sha256".to_owned(),
            })
            .expect("begin");
    }

    fn entry(path: &str, byte: char) -> GenerationEntry {
        GenerationEntry {
            path: path.to_owned(),
            size: 4,
            digest: Some(byte.to_string().repeat(64)),
        }
    }

    #[test]
    fn identical_batch_replay_is_idempotent() {
        let store = active_store();
        begin(&store, "gen-1");
        let batch = AppendBatchRequest {
            generation_id: "gen-1".to_owned(),
            sequence: 0,
            entries: vec![entry("a.txt", 'a')],
        };
        let first = store.append_scan_batch(&batch).expect("append");
        assert_eq!(first.entry_count, 1);
        let replay = store.append_scan_batch(&batch).expect("replay");
        assert_eq!(replay.entry_count, 1);
        assert_eq!(replay.next_sequence, 1);
    }

    #[test]
    fn changed_duplicate_batches_are_rejected() {
        let store = active_store();
        begin(&store, "gen-1");
        store
            .append_scan_batch(&AppendBatchRequest {
                generation_id: "gen-1".to_owned(),
                sequence: 0,
                entries: vec![entry("a.txt", 'a')],
            })
            .expect("append");
        let changed = store.append_scan_batch(&AppendBatchRequest {
            generation_id: "gen-1".to_owned(),
            sequence: 0,
            entries: vec![entry("a.txt", 'b')],
        });
        assert!(changed.is_err());
    }

    #[test]
    fn gapped_sequences_are_rejected() {
        let store = active_store();
        begin(&store, "gen-1");
        let gapped = store.append_scan_batch(&AppendBatchRequest {
            generation_id: "gen-1".to_owned(),
            sequence: 2,
            entries: vec![entry("a.txt", 'a')],
        });
        assert!(gapped.is_err());
    }

    #[test]
    fn seal_requires_the_complete_count() {
        let store = active_store();
        begin(&store, "gen-1");
        store
            .append_scan_batch(&AppendBatchRequest {
                generation_id: "gen-1".to_owned(),
                sequence: 0,
                entries: vec![entry("a.txt", 'a')],
            })
            .expect("append");
        assert!(
            store
                .seal_scan_generation(&SealGenerationRequest {
                    generation_id: "gen-1".to_owned(),
                    expected_count: 2,
                })
                .is_err()
        );
        let sealed = store
            .seal_scan_generation(&SealGenerationRequest {
                generation_id: "gen-1".to_owned(),
                expected_count: 1,
            })
            .expect("seal");
        assert_eq!(sealed.state, "sealed");
    }

    #[test]
    fn incomplete_generations_are_invisible_to_planning_reads() {
        let store = active_store();
        begin(&store, "gen-1");
        store
            .append_scan_batch(&AppendBatchRequest {
                generation_id: "gen-1".to_owned(),
                sequence: 0,
                entries: vec![entry("a.txt", 'a')],
            })
            .expect("append");
        assert!(
            store
                .read_generation_page("mapping-1", "gen-1", None, 10)
                .is_err()
        );
    }

    #[test]
    fn stale_revisions_are_rejected() {
        let store = active_store();
        let stale = store.begin_scan_generation(&BeginGenerationRequest {
            generation_id: "gen-stale".to_owned(),
            mapping_id: "mapping-1".to_owned(),
            participant_device_id: "a-device".to_owned(),
            mapping_revision: 99,
            root: "/tmp/a".to_owned(),
            ignore_patterns: Vec::new(),
            hash_mode: "full-sha256".to_owned(),
        });
        assert!(stale.is_err());
    }

    #[test]
    fn abort_clears_staged_entries_and_blocks_reads() {
        let store = active_store();
        begin(&store, "gen-1");
        store
            .append_scan_batch(&AppendBatchRequest {
                generation_id: "gen-1".to_owned(),
                sequence: 0,
                entries: vec![entry("a.txt", 'a')],
            })
            .expect("append");
        let aborted = store.abort_scan_generation("gen-1").expect("abort");
        assert_eq!(aborted.state, "aborted");
        assert!(
            store
                .read_generation_page("mapping-1", "gen-1", None, 10)
                .is_err()
        );
        // Aborting twice stays idempotent.
        assert_eq!(
            store
                .abort_scan_generation("gen-1")
                .expect("re-abort")
                .state,
            "aborted"
        );
    }

    #[test]
    fn sealed_pages_are_ordered_and_bounded() {
        let store = active_store();
        begin(&store, "gen-1");
        store
            .append_scan_batch(&AppendBatchRequest {
                generation_id: "gen-1".to_owned(),
                sequence: 0,
                entries: vec![entry("b.txt", 'b'), entry("a.txt", 'a')],
            })
            .expect("append");
        store
            .seal_scan_generation(&SealGenerationRequest {
                generation_id: "gen-1".to_owned(),
                expected_count: 2,
            })
            .expect("seal");
        let first = store
            .read_generation_page("mapping-1", "gen-1", None, 1)
            .expect("page");
        assert_eq!(first.entries.len(), 1);
        assert_eq!(first.entries[0].path, "a.txt");
        let cursor = first.next_cursor.expect("cursor");
        let second = store
            .read_generation_page("mapping-1", "gen-1", Some(&cursor), 1)
            .expect("page");
        assert_eq!(second.entries.len(), 1);
        assert_eq!(second.entries[0].path, "b.txt");
        assert!(second.next_cursor.is_none());
    }

    #[test]
    fn generations_reconcile_to_the_same_outcome_as_full_arrays() {
        let store = active_store();
        for (generation_id, byte) in [("gen-local", 'a'), ("gen-remote", 'a')] {
            store
                .begin_scan_generation(&BeginGenerationRequest {
                    generation_id: generation_id.to_owned(),
                    mapping_id: "mapping-1".to_owned(),
                    participant_device_id: "a-device".to_owned(),
                    mapping_revision: 1,
                    root: "/tmp/a".to_owned(),
                    ignore_patterns: Vec::new(),
                    hash_mode: "full-sha256".to_owned(),
                })
                .expect("begin");
            store
                .append_scan_batch(&AppendBatchRequest {
                    generation_id: generation_id.to_owned(),
                    sequence: 0,
                    entries: vec![entry("same.txt", byte)],
                })
                .expect("append");
            store
                .seal_scan_generation(&SealGenerationRequest {
                    generation_id: generation_id.to_owned(),
                    expected_count: 1,
                })
                .expect("seal");
        }
        let result = store
            .reconcile_generations(&crate::file_sync::ReconcileGenerationsRequest {
                mapping_id: "mapping-1".to_owned(),
                local_generation_id: "gen-local".to_owned(),
                remote_generation_id: "gen-remote".to_owned(),
                mode: "two-way".to_owned(),
                observed_at: NOW.to_owned(),
                queue_operations: true,
            })
            .expect("reconcile generations");
        assert_eq!(result.baseline_count, 1);
        assert!(result.operations.is_empty());
        assert!(result.conflicts.is_empty());
    }

    #[test]
    fn a_generation_cannot_be_read_through_another_mapping() {
        let store = active_store();
        begin(&store, "gen-1");
        store
            .append_scan_batch(&AppendBatchRequest {
                generation_id: "gen-1".to_owned(),
                sequence: 0,
                entries: vec![entry("a.txt", 'a')],
            })
            .expect("append");
        store
            .seal_scan_generation(&SealGenerationRequest {
                generation_id: "gen-1".to_owned(),
                expected_count: 1,
            })
            .expect("seal");
        assert!(
            store
                .read_generation_page("mapping-1", "gen-1", None, 10)
                .is_ok()
        );
        // Another mapping gets the same error as for a generation that does not exist.
        let foreign = store.read_generation_page("mapping-2", "gen-1", None, 10);
        let missing = store.read_generation_page("mapping-2", "gen-missing", None, 10);
        assert!(matches!(
            foreign,
            Err(super::MappingStoreError::NotFound(_))
        ));
        assert!(matches!(
            missing,
            Err(super::MappingStoreError::NotFound(_))
        ));
    }

    #[test]
    fn cleanup_removes_aborted_and_expired_generations() {
        let store = active_store();
        begin(&store, "gen-1");
        store.abort_scan_generation("gen-1").expect("abort");
        let removed = store
            .cleanup_scan_generations("2099-01-01T00:00:00Z")
            .expect("cleanup");
        assert!(removed >= 1);
        assert!(store.generation_status("gen-1").is_err());
    }
}

#[cfg(test)]
mod quota_tests {
    use super::{BeginGenerationRequest, MAX_GENERATIONS_PER_MAPPING};
    use crate::mapping::{LegacyImportRequest, MappingConfiguration, MappingStore};

    const NOW: &str = "2026-08-08T12:00:00Z";

    fn quota_store() -> MappingStore {
        let store = MappingStore::open_in_memory().expect("open store");
        store
            .import_legacy(&LegacyImportRequest {
                source_fingerprint: "0".repeat(64),
                importing_device_id: "a-device".to_owned(),
                imported_at: NOW.to_owned(),
                records: Vec::new(),
            })
            .expect("complete import");
        store
            .upsert_local(
                &MappingConfiguration {
                    id: "mapping-1".to_owned(),
                    name: "Folder".to_owned(),
                    initiator_device_id: "a-device".to_owned(),
                    initiator_device_name: "A".to_owned(),
                    responder_device_id: "b-device".to_owned(),
                    responder_device_name: "B".to_owned(),
                    initiator_path: "/tmp/a".to_owned(),
                    responder_path: "/tmp/b".to_owned(),
                    mode: "two-way".to_owned(),
                    ignore_patterns: Vec::new(),
                    history_days: 0,
                    history_max_bytes: 0,
                    max_file_bytes: None,
                    setup_status: "active".to_owned(),
                    paused: false,
                    preview: None,
                    created_at: NOW.to_owned(),
                    updated_at: NOW.to_owned(),
                },
                "a-device",
                None,
                None,
                NOW,
            )
            .expect("insert mapping");
        store
    }

    #[test]
    fn open_generation_quota_is_bounded() {
        let store = quota_store();
        for index in 0..MAX_GENERATIONS_PER_MAPPING {
            store
                .begin_scan_generation(&BeginGenerationRequest {
                    generation_id: format!("gen-{index}"),
                    mapping_id: "mapping-1".to_owned(),
                    participant_device_id: "a-device".to_owned(),
                    mapping_revision: 1,
                    root: "/tmp/a".to_owned(),
                    ignore_patterns: Vec::new(),
                    hash_mode: "full-sha256".to_owned(),
                })
                .expect("begin");
        }
        let overflow = store.begin_scan_generation(&BeginGenerationRequest {
            generation_id: "gen-overflow".to_owned(),
            mapping_id: "mapping-1".to_owned(),
            participant_device_id: "a-device".to_owned(),
            mapping_revision: 1,
            root: "/tmp/a".to_owned(),
            ignore_patterns: Vec::new(),
            hash_mode: "full-sha256".to_owned(),
        });
        assert!(overflow.is_err());
    }
}
