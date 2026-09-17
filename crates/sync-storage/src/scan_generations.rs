//! Rust-owned SQLite scan generations: bounded staged observations.
//!
//! Traversal stays in the desktop shell for now; batches arrive here over
//! authenticated RPC and are staged transactionally. Only a sealed complete
//! generation is visible to baseline/planning reads. Incomplete, aborted, or
//! stale generations never advance baselines or replace active state.

use rusqlite::{OptionalExtension, Transaction, TransactionBehavior, params, params_from_iter};
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
        let now = now_rfc3339()?;

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
        let expires_at = expiry_rfc3339(&now)?;
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
        let now = now_rfc3339()?;
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
            let stored = stored_entries(&transaction, &request.generation_id, &request.entries)?;
            if request
                .entries
                .iter()
                .any(|entry| !stored_matches_entry(stored.get(entry.path.as_str()), entry))
            {
                return Err(MappingStoreError::Invalid(
                    "replayed batch does not match the stored entries".to_owned(),
                ));
            }
            transaction.commit()?;
            return self.generation_status(&request.generation_id);
        }
        // The stored rows for the bounded batch are loaded once, so a
        // duplicate is classified identical or conflicting without a query
        // per entry.
        let stored = stored_entries(&transaction, &request.generation_id, &request.entries)?;
        let mut inserted: i64 = 0;
        {
            let mut insert = transaction.prepare_cached(
                "INSERT INTO scan_entries (generation_id, relative_path, digest, size)
                 VALUES (?1, ?2, ?3, ?4)
                 ON CONFLICT(generation_id, relative_path) DO NOTHING",
            )?;
            for entry in &request.entries {
                if insert.execute(params![
                    request.generation_id,
                    entry.path,
                    entry.digest,
                    entry.size
                ])? == 1
                {
                    inserted += 1;
                    continue;
                }
                if !stored_matches_entry(stored.get(entry.path.as_str()), entry) {
                    return Err(MappingStoreError::Invalid(format!(
                        "scan generation contains a changed duplicate path {:?}",
                        entry.path
                    )));
                }
            }
        }
        // The quota applies to rows this batch actually staged: an identical
        // path re-delivered from an earlier batch does not consume quota.
        if entry_count
            .checked_add(inserted)
            .is_none_or(|count| count > MAX_ENTRIES_PER_GENERATION)
        {
            return Err(MappingStoreError::Invalid(
                "scan generation exceeds its entry quota".to_owned(),
            ));
        }
        transaction.execute(
            "UPDATE scan_generations
             SET entry_count = entry_count + ?2, next_sequence = next_sequence + 1, updated_at = ?3
             WHERE generation_id = ?1",
            params![request.generation_id, inserted, now],
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
        let now = now_rfc3339()?;
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
        let now = now_rfc3339()?;
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

/// Loads the stored rows for one bounded batch of unique paths in a single
/// query, so classifying a delivered entry never costs a query per entry.
fn stored_entries(
    transaction: &Transaction<'_>,
    generation_id: &str,
    entries: &[GenerationEntry],
) -> Result<std::collections::HashMap<String, (i64, Option<String>)>, MappingStoreError> {
    if entries.is_empty() {
        return Ok(std::collections::HashMap::new());
    }
    let placeholders = vec!["?"; entries.len()].join(", ");
    let mut statement = transaction.prepare_cached(&format!(
        "SELECT relative_path, size, digest FROM scan_entries
         WHERE generation_id = ?1 AND relative_path IN ({placeholders})"
    ))?;
    let mut rows = statement.query(params_from_iter(
        std::iter::once(generation_id).chain(entries.iter().map(|entry| entry.path.as_str())),
    ))?;
    let mut stored = std::collections::HashMap::with_capacity(entries.len());
    while let Some(row) = rows.next()? {
        let path: String = row.get(0)?;
        let size: i64 = row.get(1)?;
        let digest: Option<String> = row.get(2)?;
        stored.insert(path, (size, digest));
    }
    Ok(stored)
}

fn stored_matches_entry(stored: Option<&(i64, Option<String>)>, entry: &GenerationEntry) -> bool {
    matches!(stored, Some((size, digest)) if *size == entry.size && *digest == entry.digest)
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

fn format_rfc3339(timestamp: time::OffsetDateTime) -> Result<String, MappingStoreError> {
    timestamp
        .format(&time::format_description::well_known::Rfc3339)
        .map_err(|error| {
            MappingStoreError::Invalid(format!("the system clock could not be formatted: {error}"))
        })
}

fn now_rfc3339() -> Result<String, MappingStoreError> {
    format_rfc3339(time::OffsetDateTime::now_utc())
}

fn expiry_rfc3339(now: &str) -> Result<String, MappingStoreError> {
    let parsed = time::OffsetDateTime::parse(now, &time::format_description::well_known::Rfc3339)
        .map_err(|error| {
        MappingStoreError::Invalid(format!("a generation timestamp is malformed: {error}"))
    })?;
    (parsed + time::Duration::hours(GENERATION_TTL_HOURS))
        .format(&time::format_description::well_known::Rfc3339)
        .map_err(|error| {
            MappingStoreError::Invalid(format!(
                "a generation expiry could not be formatted: {error}"
            ))
        })
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

    fn sealed_generation(store: &MappingStore, generation_id: &str, files: &[(&str, char)]) {
        begin(store, generation_id);
        store
            .append_scan_batch(&AppendBatchRequest {
                generation_id: generation_id.to_owned(),
                sequence: 0,
                entries: files
                    .iter()
                    .map(|(path, byte)| entry(path, *byte))
                    .collect(),
            })
            .expect("append");
        store
            .seal_scan_generation(&SealGenerationRequest {
                generation_id: generation_id.to_owned(),
                expected_count: i64::try_from(files.len()).expect("count fits"),
            })
            .expect("seal");
    }

    fn observed(files: &[(&str, char)]) -> Vec<crate::file_sync::ObservedFile> {
        files
            .iter()
            .map(|(path, byte)| crate::file_sync::ObservedFile {
                path: (*path).to_owned(),
                size: 4,
                digest: byte.to_string().repeat(64),
            })
            .collect()
    }

    use crate::file_sync::{ConflictKind, SyncDirection};

    type Files = &'static [(&'static str, char)];

    type Outcome = (
        usize,
        i64,
        Vec<(String, SyncDirection, String, Option<String>)>,
        Vec<(String, ConflictKind, Option<String>, Option<String>)>,
    );

    fn outcome(result: &crate::file_sync::ReconcileResult) -> Outcome {
        (
            result.verified_count,
            result.baseline_count,
            result
                .operations
                .iter()
                .map(|operation| {
                    (
                        operation.path.clone(),
                        operation.direction,
                        operation.source_digest.clone(),
                        operation.expected_destination_digest.clone(),
                    )
                })
                .collect(),
            result
                .conflicts
                .iter()
                .map(|conflict| {
                    (
                        conflict.path.clone(),
                        conflict.kind,
                        conflict.local_digest.clone(),
                        conflict.remote_digest.clone(),
                    )
                })
                .collect(),
        )
    }

    /// The set-based generation planner must reach exactly the outcome of
    /// the full-array planner for every planning category.
    #[test]
    fn set_based_generation_planning_matches_full_array_planning() {
        let rounds: [(Files, Files, &str); 3] = [
            (
                // Uninitialized: identical paths are baselined, others are unbased.
                &[
                    ("same", 'a'),
                    ("both", 'a'),
                    ("local-only", 'a'),
                    ("differs", 'a'),
                    ("gone", 'a'),
                    ("one-gone", 'a'),
                ],
                &[
                    ("same", 'a'),
                    ("both", 'a'),
                    ("remote-only", 'a'),
                    ("differs", 'b'),
                    ("gone", 'a'),
                    ("one-gone", 'a'),
                ],
                "two-way",
            ),
            (
                &[
                    ("same", 'a'),
                    ("both", 'b'),
                    ("local-new", 'c'),
                    ("differs", 'a'),
                    ("local-edit", 'd'),
                    ("remote-edit", 'a'),
                ],
                &[
                    ("same", 'a'),
                    ("both", 'c'),
                    ("remote-new", 'c'),
                    ("differs", 'b'),
                    ("local-edit", 'a'),
                    ("remote-edit", 'e'),
                    ("one-gone", 'a'),
                ],
                "two-way",
            ),
            (
                &[("same", 'a'), ("local-new", 'c'), ("remote-edit", 'a')],
                &[("same", 'a'), ("remote-new", 'c'), ("remote-edit", 'e')],
                "send-only",
            ),
        ];
        let arrays = active_store();
        let generations = active_store();
        // Round two edits paths that the first round baselined.
        for (index, (local, remote, mode)) in rounds.iter().enumerate() {
            let local_id = format!("gen-local-{index}");
            let remote_id = format!("gen-remote-{index}");
            sealed_generation(&generations, &local_id, local);
            sealed_generation(&generations, &remote_id, remote);
            let from_generations = generations
                .reconcile_generations(&crate::file_sync::ReconcileGenerationsRequest {
                    mapping_id: "mapping-1".to_owned(),
                    local_generation_id: local_id,
                    remote_generation_id: remote_id,
                    mode: (*mode).to_owned(),
                    observed_at: NOW.to_owned(),
                    queue_operations: true,
                })
                .expect("reconcile generations");
            let from_arrays = arrays
                .reconcile_files(&crate::file_sync::ReconcileRequest {
                    mapping_id: "mapping-1".to_owned(),
                    local: observed(local),
                    remote: observed(remote),
                    mode: (*mode).to_owned(),
                    observed_at: NOW.to_owned(),
                    queue_operations: true,
                    ignore_patterns: Vec::new(),
                })
                .expect("reconcile arrays");
            assert_eq!(
                outcome(&from_generations),
                outcome(&from_arrays),
                "round {index}"
            );
            assert!(
                !from_arrays.operations.is_empty() || index == 0,
                "round {index} exercises queued operations"
            );
        }
    }

    #[test]
    fn a_generation_without_digests_cannot_be_planned() {
        let store = active_store();
        begin(&store, "gen-local");
        store
            .append_scan_batch(&AppendBatchRequest {
                generation_id: "gen-local".to_owned(),
                sequence: 0,
                entries: vec![GenerationEntry {
                    path: "a.txt".to_owned(),
                    size: 4,
                    digest: None,
                }],
            })
            .expect("append");
        store
            .seal_scan_generation(&SealGenerationRequest {
                generation_id: "gen-local".to_owned(),
                expected_count: 1,
            })
            .expect("seal");
        sealed_generation(&store, "gen-remote", &[("a.txt", 'a')]);
        let result = store.reconcile_generations(&crate::file_sync::ReconcileGenerationsRequest {
            mapping_id: "mapping-1".to_owned(),
            local_generation_id: "gen-local".to_owned(),
            remote_generation_id: "gen-remote".to_owned(),
            mode: "two-way".to_owned(),
            observed_at: NOW.to_owned(),
            queue_operations: true,
        });
        assert!(matches!(result, Err(MappingStoreError::Invalid(_))));
        assert_eq!(
            store
                .file_sync_state("mapping-1")
                .expect("state")
                .baseline_count,
            0
        );
    }

    #[test]
    fn a_cross_batch_duplicate_counts_once_and_a_changed_one_is_rejected() {
        let store = active_store();
        begin(&store, "gen-1");
        store
            .append_scan_batch(&AppendBatchRequest {
                generation_id: "gen-1".to_owned(),
                sequence: 0,
                entries: vec![entry("a.txt", 'a')],
            })
            .expect("append");
        let repeated = store
            .append_scan_batch(&AppendBatchRequest {
                generation_id: "gen-1".to_owned(),
                sequence: 1,
                entries: vec![entry("a.txt", 'a'), entry("b.txt", 'b')],
            })
            .expect("identical cross-batch duplicate");
        assert_eq!((repeated.entry_count, repeated.next_sequence), (2, 2));
        let changed = store.append_scan_batch(&AppendBatchRequest {
            generation_id: "gen-1".to_owned(),
            sequence: 2,
            entries: vec![entry("c.txt", 'c'), entry("b.txt", 'x')],
        });
        assert!(changed.is_err());
        let status = store.generation_status("gen-1").expect("status");
        assert_eq!((status.entry_count, status.next_sequence), (2, 2));
        store
            .seal_scan_generation(&SealGenerationRequest {
                generation_id: "gen-1".to_owned(),
                expected_count: 2,
            })
            .expect("seal the rolled-back count");
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

    #[test]
    fn an_unformattable_timestamp_is_an_error_never_a_fallback() {
        // RFC 3339 cannot represent negative years; constructing one here is
        // the deterministic stand-in for a system clock the formatter rejects.
        let unformattable = time::Date::from_calendar_date(-1, time::Month::January, 1)
            .expect("time can hold negative years")
            .midnight()
            .assume_utc();
        assert!(matches!(
            format_rfc3339(unformattable),
            Err(MappingStoreError::Invalid(_))
        ));
    }
}

#[cfg(test)]
mod quota_tests {
    use super::{
        AppendBatchRequest, BeginGenerationRequest, GenerationEntry, MAX_ENTRIES_PER_GENERATION,
        MAX_GENERATIONS_PER_MAPPING,
    };
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

    #[test]
    fn quota_counts_inserted_rows_not_delivered_entries() {
        let store = quota_store();
        store
            .begin_scan_generation(&BeginGenerationRequest {
                generation_id: "gen-quota".to_owned(),
                mapping_id: "mapping-1".to_owned(),
                participant_device_id: "a-device".to_owned(),
                mapping_revision: 1,
                root: "/tmp/a".to_owned(),
                ignore_patterns: Vec::new(),
                hash_mode: "full-sha256".to_owned(),
            })
            .expect("begin");
        let kept = GenerationEntry {
            path: "kept.txt".to_owned(),
            size: 4,
            digest: Some("a".repeat(64)),
        };
        store
            .append_scan_batch(&AppendBatchRequest {
                generation_id: "gen-quota".to_owned(),
                sequence: 0,
                entries: vec![kept.clone()],
            })
            .expect("append");
        // Seed the generation one row below its quota; staging a million rows
        // would only slow the test down.
        store
            .connection
            .execute(
                "UPDATE scan_generations SET entry_count = ?2 WHERE generation_id = ?1",
                rusqlite::params!["gen-quota", MAX_ENTRIES_PER_GENERATION - 1],
            )
            .expect("seed the boundary count");
        let boundary = store
            .append_scan_batch(&AppendBatchRequest {
                generation_id: "gen-quota".to_owned(),
                sequence: 1,
                entries: vec![
                    kept,
                    GenerationEntry {
                        path: "new.txt".to_owned(),
                        size: 4,
                        digest: Some("b".repeat(64)),
                    },
                ],
            })
            .expect("an identical duplicate must not consume quota");
        assert_eq!(boundary.entry_count, MAX_ENTRIES_PER_GENERATION);
        let overflow = store.append_scan_batch(&AppendBatchRequest {
            generation_id: "gen-quota".to_owned(),
            sequence: 2,
            entries: vec![GenerationEntry {
                path: "overflow.txt".to_owned(),
                size: 4,
                digest: Some("c".repeat(64)),
            }],
        });
        assert!(overflow.is_err());
        let status = store.generation_status("gen-quota").expect("status");
        assert_eq!(status.entry_count, MAX_ENTRIES_PER_GENERATION);
        let staged: i64 = store
            .connection
            .query_row(
                "SELECT COUNT(*) FROM scan_entries
                 WHERE generation_id = 'gen-quota' AND relative_path = 'overflow.txt'",
                [],
                |row| row.get(0),
            )
            .expect("count the rejected row");
        assert_eq!(staged, 0);
    }
}

/// Release-mode scale measurement for staging and generation reconciliation.
/// Run with `cargo test -p sync-storage --release -- --ignored --nocapture
/// generation_scale`.
#[cfg(test)]
mod scale_tests {
    use std::time::Instant;

    use super::{
        AppendBatchRequest, BeginGenerationRequest, GenerationEntry, MAX_BATCH_ENTRIES,
        SealGenerationRequest,
    };
    use crate::file_sync::ReconcileGenerationsRequest;
    use crate::mapping::{LegacyImportRequest, MappingConfiguration, MappingStore};

    const NOW: &str = "2026-08-08T12:00:00Z";
    const FILES_PER_SIDE: usize = 250_000;

    fn file_store(path: &std::path::Path) -> MappingStore {
        let store = MappingStore::open(path).expect("open store");
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

    fn stage(store: &MappingStore, generation_id: &str, changed: usize) -> std::time::Duration {
        let started = Instant::now();
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
        let entries = (0..FILES_PER_SIDE)
            .map(|index| GenerationEntry {
                path: format!("dir-{:03}/file-{index:07}.bin", index % 500),
                size: i64::try_from(index).expect("index fits"),
                digest: Some(format!(
                    "{:064x}",
                    if index < changed { index + 1 } else { index }
                )),
            })
            .collect::<Vec<_>>();
        for (sequence, batch) in entries.chunks(MAX_BATCH_ENTRIES).enumerate() {
            store
                .append_scan_batch(&AppendBatchRequest {
                    generation_id: generation_id.to_owned(),
                    sequence: i64::try_from(sequence).expect("sequence fits"),
                    entries: batch.to_vec(),
                })
                .expect("append");
        }
        store
            .seal_scan_generation(&SealGenerationRequest {
                generation_id: generation_id.to_owned(),
                expected_count: i64::try_from(FILES_PER_SIDE).expect("count fits"),
            })
            .expect("seal");
        started.elapsed()
    }

    fn reconcile(store: &MappingStore, local: &str, remote: &str) -> (std::time::Duration, usize) {
        let started = Instant::now();
        let result = store
            .reconcile_generations(&ReconcileGenerationsRequest {
                mapping_id: "mapping-1".to_owned(),
                local_generation_id: local.to_owned(),
                remote_generation_id: remote.to_owned(),
                mode: "two-way".to_owned(),
                observed_at: NOW.to_owned(),
                queue_operations: true,
            })
            .expect("reconcile");
        (
            started.elapsed(),
            result.operations.len() + result.conflicts.len(),
        )
    }

    #[test]
    #[ignore = "release-mode scale measurement"]
    fn generation_scale() {
        let directory = tempfile::tempdir().expect("tempdir");
        let store = file_store(&directory.path().join("scale.sqlite3"));
        let local = stage(&store, "gen-local-1", 0);
        let remote = stage(&store, "gen-remote-1", 0);
        println!("stage {FILES_PER_SIDE} files: local {local:?}, remote {remote:?}");
        let (first, _) = reconcile(&store, "gen-local-1", "gen-remote-1");
        println!("first reconcile (baselines recorded): {first:?}");
        let (unchanged, _) = reconcile(&store, "gen-local-1", "gen-remote-1");
        println!("unchanged reconcile: {unchanged:?}");
        store.abort_scan_generation("gen-local-1").ok();
        stage(&store, "gen-local-2", 1_000);
        let (changed, items) = reconcile(&store, "gen-local-2", "gen-remote-1");
        println!("reconcile with 1000 local changes: {changed:?} ({items} operations/conflicts)");
        assert_eq!(items, 1_000);
    }
}
