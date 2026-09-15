//! Durable metadata and state transitions for reversible live-file replacement.

use std::collections::HashSet;

use rusqlite::{OptionalExtension, Transaction, TransactionBehavior, params};
use serde::{Deserialize, Serialize};
use time::OffsetDateTime;
use time::format_description::well_known::Rfc3339;

use crate::file_sync::{
    require_active_mapping, upsert_baseline, validate_digest, validate_path, validate_size,
    validate_timestamp,
};
use crate::mapping::{
    MAX_HISTORY_DAYS, MappingStore, MappingStoreError, check_identifier, check_path,
};

const MAX_ERROR_LENGTH: usize = 2_000;
const MAX_RETENTION_BATCH: u16 = 1_000;
const JOURNAL_COLUMNS: &str = "id, mapping_id, relative_path, sync_operation_id, kind,
     old_digest, old_size, replacement_digest, replacement_size,
     archive_digest, archive_object_key, restored_from_journal_id,
     state, created_at, updated_at, completed_at, last_error, local_root,
     (SELECT state FROM archive_objects WHERE digest = file_replacement_journal.archive_digest),
     (SELECT verified_at FROM archive_objects WHERE digest = file_replacement_journal.archive_digest),
     (SELECT last_error FROM archive_objects WHERE digest = file_replacement_journal.archive_digest)";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ArchiveObjectState {
    Available,
    Missing,
    Corrupt,
}

impl ArchiveObjectState {
    fn as_str(self) -> &'static str {
        match self {
            Self::Available => "available",
            Self::Missing => "missing",
            Self::Corrupt => "corrupt",
        }
    }

    fn parse(value: &str) -> Result<Self, MappingStoreError> {
        match value {
            "available" => Ok(Self::Available),
            "missing" => Ok(Self::Missing),
            "corrupt" => Ok(Self::Corrupt),
            other => Err(corrupt(format!("unknown archive object state {other:?}"))),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ReplacementKind {
    Sync,
    Restore,
}

impl ReplacementKind {
    fn parse(value: &str) -> Result<Self, MappingStoreError> {
        match value {
            "sync" => Ok(Self::Sync),
            "restore" => Ok(Self::Restore),
            other => Err(corrupt(format!("unknown replacement kind {other:?}"))),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ReplacementState {
    Planned,
    Archived,
    Installed,
    Completed,
    Aborted,
    RecoveryRequired,
    IntegrityFailed,
}

impl ReplacementState {
    fn as_str(self) -> &'static str {
        match self {
            Self::Planned => "planned",
            Self::Archived => "archived",
            Self::Installed => "installed",
            Self::Completed => "completed",
            Self::Aborted => "aborted",
            Self::RecoveryRequired => "recovery-required",
            Self::IntegrityFailed => "integrity-failed",
        }
    }

    fn parse(value: &str) -> Result<Self, MappingStoreError> {
        match value {
            "planned" => Ok(Self::Planned),
            "archived" => Ok(Self::Archived),
            "installed" => Ok(Self::Installed),
            "completed" => Ok(Self::Completed),
            "aborted" => Ok(Self::Aborted),
            "recovery-required" => Ok(Self::RecoveryRequired),
            "integrity-failed" => Ok(Self::IntegrityFailed),
            other => Err(corrupt(format!("unknown replacement state {other:?}"))),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReplacementJournalEntry {
    pub id: String,
    pub mapping_id: String,
    pub path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sync_operation_id: Option<i64>,
    pub kind: ReplacementKind,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub old_digest: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub old_size: Option<i64>,
    pub replacement_digest: String,
    pub replacement_size: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub archive_digest: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub archive_object_key: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub restored_from_journal_id: Option<String>,
    pub state: ReplacementState,
    pub created_at: String,
    pub updated_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub completed_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_error: Option<String>,
    pub local_root: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub archive_state: Option<ArchiveObjectState>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub archive_verified_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub archive_error: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReplacementRecoveryIssue {
    pub id: String,
    pub path: String,
    pub state: ReplacementState,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_error: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PrepareReplacementRequest {
    pub id: String,
    pub mapping_id: String,
    pub path: String,
    pub sync_operation_id: Option<i64>,
    pub old_digest: String,
    pub old_size: i64,
    pub replacement_digest: String,
    pub replacement_size: i64,
    pub local_root: String,
    pub created_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PrepareRestoreRequest {
    pub id: String,
    pub source_journal_id: String,
    pub expected_current_digest: Option<String>,
    pub expected_current_size: Option<i64>,
    pub local_root: String,
    pub created_at: String,
}

/// An archived version the owning folder's retention policy allows removing.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PrunableArchiveEntry {
    pub id: String,
    pub path: String,
    pub local_root: String,
    pub old_digest: String,
    pub old_size: i64,
    pub created_at: String,
}

/// An archive object no journal entry references any more, waiting for its file to be removed.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ArchiveObjectDeletion {
    pub digest: String,
    pub object_key: String,
    pub size: i64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ArchivePruneResult {
    pub pruned_entries: usize,
    pub queued_object_deletions: usize,
}

struct RetentionPolicy {
    oldest_kept: Option<OffsetDateTime>,
    max_bytes: Option<i64>,
}

impl MappingStore {
    /// Creates an immutable replacement intent only after matching it to durable sync work.
    ///
    /// # Errors
    ///
    /// Returns a validation, stale-operation, active-replacement, corrupt-metadata, or database
    /// error.
    pub fn prepare_replacement(
        &self,
        request: &PrepareReplacementRequest,
    ) -> Result<ReplacementJournalEntry, MappingStoreError> {
        validate_prepare_replacement(request)?;
        let transaction =
            Transaction::new_unchecked(&self.connection, TransactionBehavior::Immediate)?;
        let operation_id = matching_operation_id(&transaction, request)?;
        require_active_mapping(&transaction, &request.mapping_id)?;
        ensure_no_other_active_entry(
            &transaction,
            &request.mapping_id,
            &request.path,
            &request.id,
        )?;
        ensure_content_not_queued_for_deletion(&transaction, &request.old_digest)?;
        transaction.execute(
            "INSERT INTO file_replacement_journal (
                id, mapping_id, relative_path, sync_operation_id, kind,
                old_digest, old_size, replacement_digest, replacement_size,
                archive_digest, archive_object_key, restored_from_journal_id,
                state, created_at, updated_at, completed_at, last_error, local_root
             ) VALUES (?1, ?2, ?3, ?4, 'sync', ?5, ?6, ?7, ?8,
                       NULL, NULL, NULL, 'planned', ?9, ?9, NULL, NULL, ?10)
             ON CONFLICT(id) DO NOTHING",
            params![
                request.id,
                request.mapping_id,
                request.path,
                operation_id,
                request.old_digest,
                request.old_size,
                request.replacement_digest,
                request.replacement_size,
                request.created_at,
                request.local_root,
            ],
        )?;
        let entry = entry_by_id(&transaction, &request.id)?
            .ok_or_else(|| MappingStoreError::NotFound(request.id.clone()))?;
        if entry.mapping_id != request.mapping_id
            || entry.path != request.path
            || entry.sync_operation_id != Some(operation_id)
            || entry.kind != ReplacementKind::Sync
            || entry.old_digest.as_deref() != Some(request.old_digest.as_str())
            || entry.old_size != Some(request.old_size)
            || entry.replacement_digest != request.replacement_digest
            || entry.replacement_size != request.replacement_size
            || entry.local_root != request.local_root
        {
            return Err(MappingStoreError::Invalid(
                "replacement journal id already identifies different work".to_owned(),
            ));
        }
        transaction.commit()?;
        Ok(entry)
    }

    /// Creates a restore intent. Restoring over a live file archives that file through the same
    /// replacement state machine; recreating a missing file begins in `archived` because there is
    /// no displaced content.
    ///
    /// # Errors
    ///
    /// Returns a validation, unavailable-source-version, inactive-mapping, active-replacement,
    /// corrupt-metadata, or database error.
    pub fn prepare_restore(
        &self,
        request: &PrepareRestoreRequest,
    ) -> Result<ReplacementJournalEntry, MappingStoreError> {
        check_identifier("id", &request.id)?;
        check_identifier("sourceJournalId", &request.source_journal_id)?;
        check_path("localRoot", &request.local_root)?;
        validate_timestamp("createdAt", &request.created_at)?;
        match (
            &request.expected_current_digest,
            request.expected_current_size,
        ) {
            (Some(digest), Some(size)) => {
                validate_digest(digest)?;
                validate_size(size)?;
            }
            (None, None) => {}
            _ => {
                return Err(MappingStoreError::Invalid(
                    "restore current digest and size must either both be present or both be absent"
                        .to_owned(),
                ));
            }
        }
        let transaction =
            Transaction::new_unchecked(&self.connection, TransactionBehavior::Immediate)?;
        let source = entry_by_id(&transaction, &request.source_journal_id)?
            .ok_or_else(|| MappingStoreError::NotFound(request.source_journal_id.clone()))?;
        if !matches!(
            source.state,
            ReplacementState::Completed | ReplacementState::Aborted
        ) || source.archive_digest.as_deref() != source.old_digest.as_deref()
            || source.archive_object_key.is_none()
            || source.old_digest.is_none()
            || source.old_size.is_none()
            || source.archive_state != Some(ArchiveObjectState::Available)
        {
            return Err(MappingStoreError::Invalid(
                "the selected version is not a completed, available archive entry".to_owned(),
            ));
        }
        let replacement_digest = source
            .old_digest
            .clone()
            .ok_or_else(|| corrupt("validated archive source lost its digest".to_owned()))?;
        let replacement_size = source
            .old_size
            .ok_or_else(|| corrupt("validated archive source lost its size".to_owned()))?;
        require_active_mapping(&transaction, &source.mapping_id)?;
        ensure_no_other_active_entry(&transaction, &source.mapping_id, &source.path, &request.id)?;
        if let Some(current_digest) = &request.expected_current_digest {
            ensure_content_not_queued_for_deletion(&transaction, current_digest)?;
        }
        let state = if request.expected_current_digest.is_some() {
            ReplacementState::Planned
        } else {
            ReplacementState::Archived
        };
        transaction.execute(
            "INSERT INTO file_replacement_journal (
                id, mapping_id, relative_path, sync_operation_id, kind,
                old_digest, old_size, replacement_digest, replacement_size,
                archive_digest, archive_object_key, restored_from_journal_id,
                state, created_at, updated_at, completed_at, last_error, local_root
             ) VALUES (?1, ?2, ?3, NULL, 'restore', ?4, ?5, ?6, ?7,
                       NULL, NULL, ?8, ?9, ?10, ?10, NULL, NULL, ?11)
             ON CONFLICT(id) DO NOTHING",
            params![
                request.id,
                source.mapping_id,
                source.path,
                request.expected_current_digest,
                request.expected_current_size,
                replacement_digest,
                replacement_size,
                request.source_journal_id,
                state.as_str(),
                request.created_at,
                request.local_root,
            ],
        )?;
        let entry = entry_by_id(&transaction, &request.id)?
            .ok_or_else(|| MappingStoreError::NotFound(request.id.clone()))?;
        if entry.mapping_id != source.mapping_id
            || entry.path != source.path
            || entry.kind != ReplacementKind::Restore
            || entry.old_digest != request.expected_current_digest
            || entry.old_size != request.expected_current_size
            || entry.replacement_digest != replacement_digest
            || entry.replacement_size != replacement_size
            || entry.restored_from_journal_id.as_deref() != Some(request.source_journal_id.as_str())
            || entry.local_root != request.local_root
        {
            return Err(MappingStoreError::Invalid(
                "restore journal id already identifies different work".to_owned(),
            ));
        }
        transaction.commit()?;
        Ok(entry)
    }

    /// Records a verified content-addressed object before live installation is authorized.
    ///
    /// # Errors
    ///
    /// Returns a validation, missing-entry, invalid-transition, metadata-collision, corrupt-
    /// metadata, or database error.
    pub fn mark_replacement_archived(
        &self,
        entry_id: &str,
        archive_digest: &str,
        archive_size: i64,
        object_key: &str,
        archived_at: &str,
    ) -> Result<ReplacementJournalEntry, MappingStoreError> {
        check_identifier("entryId", entry_id)?;
        validate_digest(archive_digest)?;
        validate_size(archive_size)?;
        validate_timestamp("archivedAt", archived_at)?;
        validate_object_key(archive_digest, object_key)?;
        let transaction =
            Transaction::new_unchecked(&self.connection, TransactionBehavior::Immediate)?;
        let entry = entry_by_id(&transaction, entry_id)?
            .ok_or_else(|| MappingStoreError::NotFound(entry_id.to_owned()))?;
        if entry.old_digest.as_deref() != Some(archive_digest)
            || entry.old_size != Some(archive_size)
        {
            return Err(MappingStoreError::Invalid(
                "archived content does not match the displaced version in the journal".to_owned(),
            ));
        }
        if !matches!(
            entry.state,
            ReplacementState::Planned | ReplacementState::Archived
        ) {
            return Err(invalid_transition(entry.state, ReplacementState::Archived));
        }
        ensure_content_not_queued_for_deletion(&transaction, archive_digest)?;
        transaction.execute(
            "INSERT INTO archive_objects (
                digest, size, object_key, state, created_at, verified_at, last_error
             ) VALUES (?1, ?2, ?3, 'available', ?4, ?4, NULL)
             ON CONFLICT(digest) DO UPDATE SET
                state = 'available', verified_at = excluded.verified_at, last_error = NULL
             WHERE archive_objects.size = excluded.size
               AND archive_objects.object_key = excluded.object_key",
            params![archive_digest, archive_size, object_key, archived_at],
        )?;
        let object_matches: bool = transaction.query_row(
            "SELECT EXISTS(
                SELECT 1 FROM archive_objects
                WHERE digest = ?1 AND size = ?2 AND object_key = ?3 AND state = 'available'
            )",
            params![archive_digest, archive_size, object_key],
            |row| row.get(0),
        )?;
        if !object_matches {
            return Err(MappingStoreError::Invalid(
                "archive digest already identifies incompatible stored metadata".to_owned(),
            ));
        }
        transaction.execute(
            "UPDATE file_replacement_journal
             SET archive_digest = ?2, archive_object_key = ?3, state = 'archived',
                 updated_at = ?4, last_error = NULL
             WHERE id = ?1",
            params![entry_id, archive_digest, object_key, archived_at],
        )?;
        let updated = required_entry_by_id(&transaction, entry_id)?;
        transaction.commit()?;
        Ok(updated)
    }

    /// Marks the exact journaled replacement as installed after filesystem verification.
    ///
    /// # Errors
    ///
    /// Returns a validation, missing-entry, invalid-transition, corrupt-metadata, or database
    /// error.
    pub fn mark_replacement_installed(
        &self,
        entry_id: &str,
        installed_at: &str,
    ) -> Result<ReplacementJournalEntry, MappingStoreError> {
        check_identifier("entryId", entry_id)?;
        validate_timestamp("installedAt", installed_at)?;
        let transaction =
            Transaction::new_unchecked(&self.connection, TransactionBehavior::Immediate)?;
        let entry = entry_by_id(&transaction, entry_id)?
            .ok_or_else(|| MappingStoreError::NotFound(entry_id.to_owned()))?;
        if !matches!(
            entry.state,
            ReplacementState::Archived | ReplacementState::Installed
        ) {
            return Err(invalid_transition(entry.state, ReplacementState::Installed));
        }
        transaction.execute(
            "UPDATE file_replacement_journal
             SET state = 'installed', updated_at = ?2, last_error = NULL WHERE id = ?1",
            params![entry_id, installed_at],
        )?;
        let updated = required_entry_by_id(&transaction, entry_id)?;
        transaction.commit()?;
        Ok(updated)
    }

    /// Completes an installed restore without altering unrelated sync state.
    ///
    /// # Errors
    ///
    /// Returns a validation, missing-entry, invalid-transition, corrupt-metadata, or database
    /// error.
    pub fn complete_restore(
        &self,
        entry_id: &str,
        completed_at: &str,
    ) -> Result<ReplacementJournalEntry, MappingStoreError> {
        check_identifier("entryId", entry_id)?;
        validate_timestamp("completedAt", completed_at)?;
        let transaction =
            Transaction::new_unchecked(&self.connection, TransactionBehavior::Immediate)?;
        let entry = entry_by_id(&transaction, entry_id)?
            .ok_or_else(|| MappingStoreError::NotFound(entry_id.to_owned()))?;
        if entry.kind != ReplacementKind::Restore || entry.state != ReplacementState::Installed {
            return Err(MappingStoreError::Invalid(
                "only an installed restore can be completed".to_owned(),
            ));
        }
        mark_completed(&transaction, entry_id, completed_at)?;
        let updated = required_entry_by_id(&transaction, entry_id)?;
        transaction.commit()?;
        Ok(updated)
    }

    /// Reads one durable replacement or restore journal entry.
    ///
    /// # Errors
    ///
    /// Returns a validation, missing-entry, corrupt-metadata, or database error.
    pub fn replacement_entry(
        &self,
        entry_id: &str,
    ) -> Result<ReplacementJournalEntry, MappingStoreError> {
        check_identifier("entryId", entry_id)?;
        entry_by_id(&self.connection, entry_id)?
            .ok_or_else(|| MappingStoreError::NotFound(entry_id.to_owned()))
    }

    /// Lists every entry that startup must reconcile before synchronization resumes.
    ///
    /// # Errors
    ///
    /// Returns a corrupt-metadata or database error.
    pub fn incomplete_replacements(
        &self,
    ) -> Result<Vec<ReplacementJournalEntry>, MappingStoreError> {
        let query = format!(
            "SELECT {JOURNAL_COLUMNS} FROM file_replacement_journal
             WHERE state IN (
                'planned', 'archived', 'installed', 'recovery-required', 'integrity-failed'
             ) ORDER BY created_at, id"
        );
        let mut statement = self.connection.prepare(&query)?;
        let rows = statement.query_map([], entry_from_row)?;
        rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
    }

    /// Lists retained archived versions for one mapping, newest first.
    ///
    /// # Errors
    ///
    /// Returns a validation, corrupt-metadata, or database error.
    pub fn archived_versions(
        &self,
        mapping_id: &str,
        limit: Option<u32>,
    ) -> Result<Vec<ReplacementJournalEntry>, MappingStoreError> {
        check_identifier("mappingId", mapping_id)?;
        let limit = match limit {
            Some(0) => {
                return Err(MappingStoreError::Invalid(
                    "limit must be greater than zero".to_owned(),
                ));
            }
            Some(limit) => i64::from(limit),
            None => -1,
        };
        // SQLite treats a negative LIMIT as "no upper bound", so one query covers both cases.
        let query = format!(
            "SELECT {JOURNAL_COLUMNS} FROM file_replacement_journal
             WHERE mapping_id = ?1 AND archive_digest IS NOT NULL
             ORDER BY created_at DESC, id DESC
             LIMIT ?2"
        );
        let mut statement = self.connection.prepare(&query)?;
        let rows = statement.query_map(params![mapping_id, limit], entry_from_row)?;
        rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
    }

    /// Lists archived versions of one active folder that its retention policy allows removing.
    ///
    /// A version leaves once it is older than the folder's `history_days`, or once newer versions
    /// already fill its `history_max_bytes`. A zero limit disables that dimension. Unfinished
    /// replacements and the source of an unfinished restore are never listed. Nothing is changed.
    ///
    /// # Errors
    ///
    /// Returns a validation, inactive-mapping, corrupt-metadata, or database error.
    pub fn prunable_archive_entries(
        &self,
        mapping_id: &str,
        now: &str,
        limit: u16,
    ) -> Result<Vec<PrunableArchiveEntry>, MappingStoreError> {
        check_identifier("id", mapping_id)?;
        let now = parse_timestamp("now", now)?;
        validate_retention_limit(limit)?;
        let limit = usize::from(limit);
        let transaction =
            Transaction::new_unchecked(&self.connection, TransactionBehavior::Deferred)?;
        let mut entries = Vec::new();
        visit_prunable_entries(&transaction, mapping_id, now, |entry| {
            entries.push(entry);
            entries.len() < limit
        })?;
        transaction.commit()?;
        Ok(entries)
    }

    /// Removes the requested versions that the retention policy still allows removing, and queues
    /// every archive object that no remaining journal entry needs for file deletion.
    ///
    /// The policy is evaluated again inside this transaction, so a version that became protected
    /// or retained after it was listed stays. Content stays queued, and new archive references to
    /// it are refused, until [`Self::complete_archive_object_deletion`] confirms its file is gone.
    ///
    /// # Errors
    ///
    /// Returns a validation, inactive-mapping, corrupt-metadata, or database error.
    pub fn prune_archive_entries(
        &self,
        mapping_id: &str,
        entry_ids: &[String],
        now: &str,
    ) -> Result<ArchivePruneResult, MappingStoreError> {
        check_identifier("id", mapping_id)?;
        let now_time = parse_timestamp("now", now)?;
        if entry_ids.is_empty() || entry_ids.len() > usize::from(MAX_RETENTION_BATCH) {
            return Err(MappingStoreError::Invalid(format!(
                "entryIds must contain between 1 and {MAX_RETENTION_BATCH} ids"
            )));
        }
        let mut requested = HashSet::with_capacity(entry_ids.len());
        for id in entry_ids {
            check_identifier("entryIds", id)?;
            if !requested.insert(id.as_str()) {
                return Err(MappingStoreError::Invalid(
                    "entryIds must not contain duplicates".to_owned(),
                ));
            }
        }
        let transaction =
            Transaction::new_unchecked(&self.connection, TransactionBehavior::Immediate)?;
        let mut pruned = Vec::new();
        visit_prunable_entries(&transaction, mapping_id, now_time, |entry| {
            if requested.contains(entry.id.as_str()) {
                pruned.push((entry.id, entry.old_digest));
            }
            pruned.len() < requested.len()
        })?;
        let mut released_digests = HashSet::new();
        for (id, digest) in &pruned {
            transaction.execute(
                "DELETE FROM file_replacement_journal WHERE id = ?1",
                params![id],
            )?;
            released_digests.insert(digest.as_str());
        }
        let mut queued_object_deletions = 0;
        for digest in released_digests {
            if queue_unreferenced_object(&transaction, digest, now)? {
                queued_object_deletions += 1;
            }
        }
        transaction.commit()?;
        Ok(ArchivePruneResult {
            pruned_entries: pruned.len(),
            queued_object_deletions,
        })
    }

    /// Lists archive objects whose files still have to be removed, oldest queue entries first.
    ///
    /// # Errors
    ///
    /// Returns a validation or database error.
    pub fn pending_archive_object_deletions(
        &self,
        limit: u16,
    ) -> Result<Vec<ArchiveObjectDeletion>, MappingStoreError> {
        validate_retention_limit(limit)?;
        let mut statement = self.connection.prepare(
            "SELECT digest, object_key, size FROM archive_object_deletions
             ORDER BY queued_at, digest
             LIMIT ?1",
        )?;
        let rows = statement.query_map(params![limit], |row| {
            Ok(ArchiveObjectDeletion {
                digest: row.get(0)?,
                object_key: row.get(1)?,
                size: row.get(2)?,
            })
        })?;
        rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
    }

    /// Records that a queued archive object's file is gone, so the same content can be archived
    /// again. Repeating the confirmation is harmless and returns `false`.
    ///
    /// # Errors
    ///
    /// Returns a validation or database error.
    pub fn complete_archive_object_deletion(
        &self,
        digest: &str,
    ) -> Result<bool, MappingStoreError> {
        validate_digest(digest)?;
        let removed = self.connection.execute(
            "DELETE FROM archive_object_deletions WHERE digest = ?1",
            params![digest],
        )?;
        Ok(removed == 1)
    }

    /// Persists an explicit recovery or integrity failure without discarding archive metadata.
    ///
    /// # Errors
    ///
    /// Returns a validation, terminal-entry, corrupt-metadata, or database error.
    pub fn record_replacement_issue(
        &self,
        entry_id: &str,
        integrity_failure: bool,
        detail: &str,
        occurred_at: &str,
    ) -> Result<ReplacementJournalEntry, MappingStoreError> {
        check_identifier("entryId", entry_id)?;
        validate_timestamp("occurredAt", occurred_at)?;
        let detail = sanitize_error(detail)?;
        let state = if integrity_failure {
            ReplacementState::IntegrityFailed
        } else {
            ReplacementState::RecoveryRequired
        };
        let updated = self.connection.execute(
            "UPDATE file_replacement_journal
             SET state = ?2, updated_at = ?3, last_error = ?4
             WHERE id = ?1 AND state NOT IN ('completed', 'aborted')",
            params![entry_id, state.as_str(), occurred_at, detail],
        )?;
        if updated == 0 {
            return Err(MappingStoreError::Invalid(
                "completed replacement history cannot be changed into a recovery failure"
                    .to_owned(),
            ));
        }
        self.replacement_entry(entry_id)
    }

    /// Marks a previously published archive object missing or corrupt after verification fails.
    ///
    /// # Errors
    ///
    /// Returns a validation, missing-object, invalid-state, corrupt-metadata, or database error.
    pub fn record_archive_object_issue(
        &self,
        entry_id: &str,
        state: ArchiveObjectState,
        detail: &str,
        occurred_at: &str,
    ) -> Result<ReplacementJournalEntry, MappingStoreError> {
        check_identifier("entryId", entry_id)?;
        validate_timestamp("occurredAt", occurred_at)?;
        if state == ArchiveObjectState::Available {
            return Err(MappingStoreError::Invalid(
                "archive object issue state must be missing or corrupt".to_owned(),
            ));
        }
        let detail = sanitize_error(detail)?;
        let transaction =
            Transaction::new_unchecked(&self.connection, TransactionBehavior::Immediate)?;
        let entry = required_entry_by_id(&transaction, entry_id)?;
        let digest = entry.archive_digest.ok_or_else(|| {
            MappingStoreError::Invalid("journal entry has no published archive object".to_owned())
        })?;
        let updated = transaction.execute(
            "UPDATE archive_objects
             SET state = ?2, verified_at = ?3, last_error = ?4
             WHERE digest = ?1",
            params![digest, state.as_str(), occurred_at, detail],
        )?;
        if updated != 1 {
            return Err(corrupt(
                "journal entry references archive metadata that is no longer present".to_owned(),
            ));
        }
        let result = required_entry_by_id(&transaction, entry_id)?;
        transaction.commit()?;
        Ok(result)
    }

    /// Resolves a crash window using caller-verified live and archive digests. It never guesses:
    /// an expected old live file aborts the replacement; the exact replacement rolls forward;
    /// every other observation becomes an explicit recovery-required state.
    ///
    /// # Errors
    ///
    /// Returns a validation, missing-entry, inconsistent-operation, corrupt-metadata, or database
    /// error.
    pub fn recover_replacement(
        &self,
        entry_id: &str,
        live_digest: Option<&str>,
        archive_available: bool,
        recovered_at: &str,
    ) -> Result<ReplacementJournalEntry, MappingStoreError> {
        check_identifier("entryId", entry_id)?;
        if let Some(digest) = live_digest {
            validate_digest(digest)?;
        }
        validate_timestamp("recoveredAt", recovered_at)?;
        let transaction =
            Transaction::new_unchecked(&self.connection, TransactionBehavior::Immediate)?;
        let entry = entry_by_id(&transaction, entry_id)?
            .ok_or_else(|| MappingStoreError::NotFound(entry_id.to_owned()))?;
        if matches!(
            entry.state,
            ReplacementState::Completed | ReplacementState::Aborted
        ) {
            transaction.commit()?;
            return Ok(entry);
        }
        let archive_required = entry.old_digest.is_some();
        if archive_required && !archive_available && entry.state != ReplacementState::Planned {
            update_issue(
                &transaction,
                entry_id,
                ReplacementState::IntegrityFailed,
                "The archived previous version is missing or failed integrity verification.",
                recovered_at,
            )?;
        } else if live_digest == entry.old_digest.as_deref() {
            transaction.execute(
                "UPDATE file_replacement_journal
                 SET state = 'aborted', updated_at = ?2, completed_at = ?2, last_error = NULL
                 WHERE id = ?1",
                params![entry_id, recovered_at],
            )?;
        } else if live_digest == Some(entry.replacement_digest.as_str()) && archive_available {
            finish_recovered_replacement(&transaction, &entry, recovered_at)?;
        } else {
            update_issue(
                &transaction,
                entry_id,
                ReplacementState::RecoveryRequired,
                "The live file matches neither the archived version nor the planned replacement.",
                recovered_at,
            )?;
        }
        let updated = required_entry_by_id(&transaction, entry_id)?;
        transaction.commit()?;
        Ok(updated)
    }
}

pub(crate) fn require_installed_sync_entry(
    transaction: &Transaction<'_>,
    entry_id: Option<&str>,
    operation_id: i64,
) -> Result<Option<String>, MappingStoreError> {
    let Some(entry_id) = entry_id else {
        return Ok(None);
    };
    check_identifier("replacementJournalId", entry_id)?;
    let entry = entry_by_id(transaction, entry_id)?
        .ok_or_else(|| MappingStoreError::NotFound(entry_id.to_owned()))?;
    if entry.kind != ReplacementKind::Sync
        || entry.sync_operation_id != Some(operation_id)
        || entry.state != ReplacementState::Installed
    {
        return Err(MappingStoreError::Invalid(
            "replacement completion did not match an installed durable journal entry".to_owned(),
        ));
    }
    Ok(Some(entry.id))
}

pub(crate) fn mark_completed(
    transaction: &Transaction<'_>,
    entry_id: &str,
    completed_at: &str,
) -> Result<(), MappingStoreError> {
    transaction.execute(
        "UPDATE file_replacement_journal
         SET state = 'completed', updated_at = ?2, completed_at = ?2, last_error = NULL
         WHERE id = ?1 AND state = 'installed'",
        params![entry_id, completed_at],
    )?;
    Ok(())
}

pub(crate) fn recovery_issues_for_mapping(
    connection: &rusqlite::Connection,
    mapping_id: &str,
) -> Result<Vec<ReplacementRecoveryIssue>, MappingStoreError> {
    let mut statement = connection.prepare(
        "SELECT id, relative_path, state, last_error
         FROM file_replacement_journal
         WHERE mapping_id = ?1 AND state IN ('recovery-required', 'integrity-failed')
         ORDER BY updated_at, id",
    )?;
    let rows = statement.query_map(params![mapping_id], |row| {
        let state: String = row.get(2)?;
        Ok(ReplacementRecoveryIssue {
            id: row.get(0)?,
            path: row.get(1)?,
            state: ReplacementState::parse(&state).map_err(to_sql_conversion(2))?,
            last_error: row.get(3)?,
        })
    })?;
    rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
}

fn matching_operation_id(
    transaction: &Transaction<'_>,
    request: &PrepareReplacementRequest,
) -> Result<i64, MappingStoreError> {
    let mut statement = transaction.prepare(
        "SELECT id FROM file_sync_operations
         WHERE mapping_id = ?1 AND relative_path = ?2
           AND source_digest = ?3 AND source_size = ?4
           AND expected_destination_digest = ?5
           AND (?6 IS NULL OR id = ?6)",
    )?;
    let rows = statement
        .query_map(
            params![
                request.mapping_id,
                request.path,
                request.replacement_digest,
                request.replacement_size,
                request.old_digest,
                request.sync_operation_id,
            ],
            |row| row.get::<_, i64>(0),
        )?
        .collect::<Result<Vec<_>, _>>()?;
    match rows.as_slice() {
        [id] => Ok(*id),
        [] => Err(MappingStoreError::Invalid(
            "replacement no longer matches durable reconciliation work".to_owned(),
        )),
        _ => Err(corrupt(
            "multiple durable operations matched one replacement".to_owned(),
        )),
    }
}

fn finish_recovered_replacement(
    transaction: &Transaction<'_>,
    entry: &ReplacementJournalEntry,
    recovered_at: &str,
) -> Result<(), MappingStoreError> {
    if entry.kind == ReplacementKind::Sync {
        let operation_id = entry.sync_operation_id.ok_or_else(|| {
            corrupt("sync replacement is missing its operation identity".to_owned())
        })?;
        let operation: Option<(String, String, i64)> = transaction
            .query_row(
                "SELECT source_digest, relative_path, source_size
                 FROM file_sync_operations WHERE id = ?1 AND mapping_id = ?2",
                params![operation_id, entry.mapping_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .optional()?;
        if let Some((digest, path, size)) = operation {
            if digest != entry.replacement_digest
                || path != entry.path
                || size != entry.replacement_size
            {
                return Err(corrupt(
                    "recovered replacement no longer matches its durable operation".to_owned(),
                ));
            }
            upsert_baseline(
                transaction,
                &entry.mapping_id,
                &entry.path,
                &entry.replacement_digest,
                entry.replacement_size,
                recovered_at,
            )?;
            transaction.execute(
                "DELETE FROM file_sync_operations WHERE id = ?1",
                params![operation_id],
            )?;
            transaction.execute(
                "DELETE FROM file_sync_conflicts WHERE mapping_id = ?1 AND relative_path = ?2",
                params![entry.mapping_id, entry.path],
            )?;
        } else {
            let baseline: Option<(String, i64)> = transaction
                .query_row(
                    "SELECT digest, size FROM file_sync_baselines
                     WHERE mapping_id = ?1 AND relative_path = ?2",
                    params![entry.mapping_id, entry.path],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .optional()?;
            if baseline.as_ref()
                != Some(&(entry.replacement_digest.clone(), entry.replacement_size))
            {
                return Err(corrupt(
                    "recovered replacement has neither its durable operation nor an exact completed baseline"
                        .to_owned(),
                ));
            }
        }
    }
    transaction.execute(
        "UPDATE file_replacement_journal SET state = 'installed', updated_at = ?2 WHERE id = ?1",
        params![entry.id, recovered_at],
    )?;
    mark_completed(transaction, &entry.id, recovered_at)
}

fn validate_prepare_replacement(
    request: &PrepareReplacementRequest,
) -> Result<(), MappingStoreError> {
    check_identifier("id", &request.id)?;
    check_identifier("mappingId", &request.mapping_id)?;
    validate_path(&request.path)?;
    validate_digest(&request.old_digest)?;
    validate_size(request.old_size)?;
    validate_digest(&request.replacement_digest)?;
    validate_size(request.replacement_size)?;
    check_path("localRoot", &request.local_root)?;
    validate_timestamp("createdAt", &request.created_at)?;
    if request.old_digest == request.replacement_digest {
        return Err(MappingStoreError::Invalid(
            "a replacement must change the file digest".to_owned(),
        ));
    }
    Ok(())
}

fn ensure_no_other_active_entry(
    transaction: &Transaction<'_>,
    mapping_id: &str,
    path: &str,
    entry_id: &str,
) -> Result<(), MappingStoreError> {
    let existing: Option<String> = transaction
        .query_row(
            "SELECT id FROM file_replacement_journal
             WHERE mapping_id = ?1 AND relative_path = ?2
               AND state IN ('planned', 'archived', 'installed', 'recovery-required', 'integrity-failed')",
            params![mapping_id, path],
            |row| row.get(0),
        )
        .optional()?;
    if existing.as_deref().is_some_and(|id| id != entry_id) {
        return Err(MappingStoreError::Invalid(
            "another durable replacement is already active for this file".to_owned(),
        ));
    }
    Ok(())
}

/// Refuses a new archive reference to content whose object file is queued for deletion: the
/// desktop may already have removed that file, so reusing it could record an archive that does
/// not exist.
fn ensure_content_not_queued_for_deletion(
    transaction: &Transaction<'_>,
    digest: &str,
) -> Result<(), MappingStoreError> {
    let queued: bool = transaction.query_row(
        "SELECT EXISTS(SELECT 1 FROM archive_object_deletions WHERE digest = ?1)",
        params![digest],
        |row| row.get(0),
    )?;
    if queued {
        return Err(MappingStoreError::Invalid(
            "an earlier archived copy of this content is still being removed by version history cleanup; retry shortly"
                .to_owned(),
        ));
    }
    Ok(())
}

/// Streams one active mapping's removable versions, newest first, until `visit` returns `false`.
///
/// Versions are kept newest first while they are within the age limit and the distinct archived
/// bytes kept so far fit the storage cap. Once the cap is exceeded, that version and every older
/// one are removable, so the oldest versions always leave first. Content shared by several kept
/// versions is counted once because it is stored once.
fn visit_prunable_entries(
    connection: &rusqlite::Connection,
    mapping_id: &str,
    now: OffsetDateTime,
    mut visit: impl FnMut(PrunableArchiveEntry) -> bool,
) -> Result<(), MappingStoreError> {
    let policy = retention_policy(connection, mapping_id, now)?;
    let restore_sources = unfinished_restore_sources(connection)?;
    let mut statement = connection.prepare(
        "SELECT id, relative_path, local_root, archive_digest, old_size, created_at
         FROM file_replacement_journal
         WHERE mapping_id = ?1 AND archive_digest IS NOT NULL
           AND state IN ('completed', 'aborted')
         ORDER BY created_at DESC, id DESC",
    )?;
    let mut rows = statement.query(params![mapping_id])?;
    let mut kept_digests = HashSet::new();
    let mut kept_bytes: i64 = 0;
    let mut cap_exceeded = false;
    while let Some(row) = rows.next()? {
        let id: String = row.get(0)?;
        if restore_sources.contains(&id) {
            continue;
        }
        let old_size: Option<i64> = row.get(4)?;
        let entry = PrunableArchiveEntry {
            path: row.get(1)?,
            local_root: row.get(2)?,
            old_digest: row.get(3)?,
            old_size: old_size.ok_or_else(|| {
                corrupt(format!(
                    "archived journal entry {id:?} has no archived size"
                ))
            })?,
            created_at: row.get(5)?,
            id,
        };
        let created_at = OffsetDateTime::parse(&entry.created_at, &Rfc3339).map_err(|error| {
            corrupt(format!(
                "journal entry {:?} has an invalid creation time: {error}",
                entry.id
            ))
        })?;
        let expired = policy
            .oldest_kept
            .is_some_and(|oldest_kept| created_at < oldest_kept);
        if !expired && !cap_exceeded {
            if kept_digests.insert(entry.old_digest.clone()) {
                kept_bytes = kept_bytes.saturating_add(entry.old_size);
            }
            cap_exceeded = policy.max_bytes.is_some_and(|max| kept_bytes > max);
            if !cap_exceeded {
                continue;
            }
        }
        if !visit(entry) {
            break;
        }
    }
    Ok(())
}

fn retention_policy(
    connection: &rusqlite::Connection,
    mapping_id: &str,
    now: OffsetDateTime,
) -> Result<RetentionPolicy, MappingStoreError> {
    let (days, max_bytes): (i64, i64) = connection
        .query_row(
            "SELECT history_days, history_max_bytes FROM folder_mappings
             WHERE id = ?1 AND setup_status = 'active'",
            params![mapping_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?
        .ok_or_else(|| MappingStoreError::NotFound(mapping_id.to_owned()))?;
    if !(0..=MAX_HISTORY_DAYS).contains(&days) || max_bytes < 0 {
        return Err(MappingStoreError::CorruptMetadata {
            id: mapping_id.to_owned(),
            detail: "stored version history limits are out of range".to_owned(),
        });
    }
    let oldest_kept = if days == 0 {
        None
    } else {
        Some(now.checked_sub(time::Duration::days(days)).ok_or_else(|| {
            MappingStoreError::Invalid("now is outside the supported time range".to_owned())
        })?)
    };
    Ok(RetentionPolicy {
        oldest_kept,
        max_bytes: (max_bytes > 0).then_some(max_bytes),
    })
}

/// Journal entries an unfinished restore is copying from. Their row is kept until the restore
/// settles; the object is independently protected through the restore's replacement digest.
fn unfinished_restore_sources(
    connection: &rusqlite::Connection,
) -> Result<HashSet<String>, MappingStoreError> {
    let mut statement = connection.prepare(
        "SELECT restored_from_journal_id FROM file_replacement_journal
         WHERE restored_from_journal_id IS NOT NULL
           AND state IN ('planned', 'archived', 'installed', 'recovery-required', 'integrity-failed')",
    )?;
    let rows = statement.query_map([], |row| row.get::<_, String>(0))?;
    rows.collect::<Result<HashSet<_>, _>>().map_err(Into::into)
}

/// Moves one archive object into the deletion queue when no journal entry archives it and no
/// unfinished replacement or restore could still read or re-archive it. Returns whether it moved.
fn queue_unreferenced_object(
    transaction: &Transaction<'_>,
    digest: &str,
    queued_at: &str,
) -> Result<bool, MappingStoreError> {
    let queued = transaction.execute(
        "INSERT INTO archive_object_deletions (digest, object_key, size, queued_at)
         SELECT digest, object_key, size, ?2 FROM archive_objects
         WHERE digest = ?1
           AND NOT EXISTS (
               SELECT 1 FROM file_replacement_journal WHERE archive_digest = ?1
           )
           AND NOT EXISTS (
               SELECT 1 FROM file_replacement_journal
               WHERE state IN ('planned', 'archived', 'installed', 'recovery-required', 'integrity-failed')
                 AND (old_digest = ?1 OR replacement_digest = ?1)
           )
         ON CONFLICT DO NOTHING",
        params![digest, queued_at],
    )?;
    if queued == 0 {
        return Ok(false);
    }
    transaction.execute(
        "DELETE FROM archive_objects WHERE digest = ?1",
        params![digest],
    )?;
    Ok(true)
}

fn validate_retention_limit(limit: u16) -> Result<(), MappingStoreError> {
    if limit == 0 || limit > MAX_RETENTION_BATCH {
        return Err(MappingStoreError::Invalid(format!(
            "limit must be between 1 and {MAX_RETENTION_BATCH}"
        )));
    }
    Ok(())
}

fn parse_timestamp(field: &str, value: &str) -> Result<OffsetDateTime, MappingStoreError> {
    OffsetDateTime::parse(value, &Rfc3339).map_err(|error| {
        MappingStoreError::Invalid(format!("{field} must be an RFC 3339 timestamp: {error}"))
    })
}

fn validate_object_key(digest: &str, object_key: &str) -> Result<(), MappingStoreError> {
    let expected = format!("sha256/{}/{}", &digest[..2], digest);
    if object_key != expected {
        return Err(MappingStoreError::Invalid(
            "archive object keys must be derived from the verified SHA-256 digest".to_owned(),
        ));
    }
    Ok(())
}

fn sanitize_error(detail: &str) -> Result<String, MappingStoreError> {
    let sanitized = detail
        .chars()
        .filter(|character| *character != '\0')
        .take(MAX_ERROR_LENGTH)
        .collect::<String>();
    if sanitized.trim().is_empty() {
        return Err(MappingStoreError::Invalid(
            "replacement failure detail must not be empty".to_owned(),
        ));
    }
    Ok(sanitized)
}

fn update_issue(
    transaction: &Transaction<'_>,
    entry_id: &str,
    state: ReplacementState,
    detail: &str,
    occurred_at: &str,
) -> Result<(), MappingStoreError> {
    transaction.execute(
        "UPDATE file_replacement_journal
         SET state = ?2, updated_at = ?3, last_error = ?4 WHERE id = ?1",
        params![entry_id, state.as_str(), occurred_at, detail],
    )?;
    Ok(())
}

fn invalid_transition(from: ReplacementState, to: ReplacementState) -> MappingStoreError {
    MappingStoreError::Invalid(format!(
        "replacement journal cannot transition from {} to {}",
        from.as_str(),
        to.as_str()
    ))
}

fn corrupt(detail: String) -> MappingStoreError {
    MappingStoreError::CorruptMetadata {
        id: "file-replacement-journal".to_owned(),
        detail,
    }
}

fn entry_by_id(
    connection: &rusqlite::Connection,
    entry_id: &str,
) -> Result<Option<ReplacementJournalEntry>, MappingStoreError> {
    let query = format!("SELECT {JOURNAL_COLUMNS} FROM file_replacement_journal WHERE id = ?1");
    connection
        .query_row(&query, params![entry_id], entry_from_row)
        .optional()
        .map_err(Into::into)
}

fn required_entry_by_id(
    connection: &rusqlite::Connection,
    entry_id: &str,
) -> Result<ReplacementJournalEntry, MappingStoreError> {
    entry_by_id(connection, entry_id)?.ok_or_else(|| {
        corrupt(format!(
            "replacement journal entry {entry_id:?} disappeared during its transaction"
        ))
    })
}

fn entry_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<ReplacementJournalEntry> {
    let kind: String = row.get(4)?;
    let state: String = row.get(12)?;
    let archive_state: Option<String> = row.get(18)?;
    Ok(ReplacementJournalEntry {
        id: row.get(0)?,
        mapping_id: row.get(1)?,
        path: row.get(2)?,
        sync_operation_id: row.get(3)?,
        kind: ReplacementKind::parse(&kind).map_err(to_sql_conversion(4))?,
        old_digest: row.get(5)?,
        old_size: row.get(6)?,
        replacement_digest: row.get(7)?,
        replacement_size: row.get(8)?,
        archive_digest: row.get(9)?,
        archive_object_key: row.get(10)?,
        restored_from_journal_id: row.get(11)?,
        state: ReplacementState::parse(&state).map_err(to_sql_conversion(12))?,
        created_at: row.get(13)?,
        updated_at: row.get(14)?,
        completed_at: row.get(15)?,
        last_error: row.get(16)?,
        local_root: row.get(17)?,
        archive_state: archive_state
            .as_deref()
            .map(ArchiveObjectState::parse)
            .transpose()
            .map_err(to_sql_conversion(18))?,
        archive_verified_at: row.get(19)?,
        archive_error: row.get(20)?,
    })
}

fn to_sql_conversion(column: usize) -> impl FnOnce(MappingStoreError) -> rusqlite::Error {
    move |error| {
        rusqlite::Error::FromSqlConversionFailure(
            column,
            rusqlite::types::Type::Text,
            Box::new(error),
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::file_sync::{ObservedFile, ReconcileRequest, ReconcileResult};
    use crate::mapping::{LegacyImportRequest, MappingConfiguration};

    const NOW: &str = "2026-08-11T10:00:00Z";
    const LATER: &str = "2026-08-11T10:01:00Z";

    fn active_store(path: Option<&std::path::Path>) -> MappingStore {
        let store = path.map_or_else(
            || MappingStore::open_in_memory().expect("open store"),
            |path| MappingStore::open(path).expect("open store"),
        );
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
                    history_days: 30,
                    history_max_bytes: 1 << 30,
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

    fn file(path: &str, digest: char) -> ObservedFile {
        ObservedFile {
            path: path.to_owned(),
            size: 4,
            digest: digest.to_string().repeat(64),
        }
    }

    fn reconcile(store: &MappingStore, path: &str, local: char, remote: char) -> ReconcileResult {
        store
            .reconcile_files(&ReconcileRequest {
                mapping_id: "mapping-1".to_owned(),
                local: vec![file(path, local)],
                remote: vec![file(path, remote)],
                mode: "two-way".to_owned(),
                observed_at: NOW.to_owned(),
                queue_operations: true,
            })
            .expect("reconcile")
    }

    fn planned_replacement(store: &MappingStore, id: &str) -> ReplacementJournalEntry {
        planned_replacement_at(store, id, "notes.txt", NOW)
    }

    fn planned_replacement_at(
        store: &MappingStore,
        id: &str,
        path: &str,
        created_at: &str,
    ) -> ReplacementJournalEntry {
        reconcile(store, path, 'a', 'a');
        let plan = reconcile(store, path, 'a', 'b');
        let operation = &plan.operations[0];
        store
            .prepare_replacement(&PrepareReplacementRequest {
                id: id.to_owned(),
                mapping_id: "mapping-1".to_owned(),
                path: path.to_owned(),
                sync_operation_id: Some(operation.id),
                old_digest: "a".repeat(64),
                old_size: 4,
                replacement_digest: "b".repeat(64),
                replacement_size: 4,
                local_root: "/tmp/a".to_owned(),
                created_at: created_at.to_owned(),
            })
            .expect("prepare replacement")
    }

    /// Drives one replacement through the whole durable lifecycle to `completed`, which is the
    /// state real archive history is read from. Each entry must finish before the next one is
    /// planned, because an unfinished replacement deliberately blocks further reconciliation.
    fn archived_version(
        store: &MappingStore,
        id: &str,
        path: &str,
        created_at: &str,
    ) -> ReplacementJournalEntry {
        let planned = planned_replacement_at(store, id, path, created_at);
        let operation_id = planned.sync_operation_id.expect("planned sync operation");
        archive_old(store, &planned);
        store
            .mark_replacement_installed(id, LATER)
            .expect("mark installed");
        store
            .complete_file_operation(operation_id, &"b".repeat(64), 4, LATER, Some(id))
            .expect("complete replacement");
        store.replacement_entry(id).expect("archived version")
    }

    fn archive_old(
        store: &MappingStore,
        entry: &ReplacementJournalEntry,
    ) -> ReplacementJournalEntry {
        store
            .mark_replacement_archived(
                &entry.id,
                &"a".repeat(64),
                4,
                &format!("sha256/aa/{}", "a".repeat(64)),
                LATER,
            )
            .expect("mark archived")
    }

    #[test]
    fn replacement_journal_survives_reopen_and_completes_with_operation() {
        let directory = tempfile::tempdir().expect("tempdir");
        let database = directory.path().join("mappings.sqlite3");
        let store = active_store(Some(&database));
        let entry = planned_replacement(&store, "replacement-1");
        let archived = archive_old(&store, &entry);
        assert_eq!(archived.state, ReplacementState::Archived);
        drop(store);

        let reopened = MappingStore::open(&database).expect("reopen");
        let durable = reopened
            .replacement_entry(&entry.id)
            .expect("durable entry");
        assert_eq!(
            durable.archive_digest.as_deref(),
            Some("a".repeat(64).as_str())
        );
        reopened
            .mark_replacement_installed(&entry.id, LATER)
            .expect("mark installed");
        reopened
            .complete_file_operation(
                entry.sync_operation_id.expect("operation"),
                &"b".repeat(64),
                4,
                LATER,
                Some(&entry.id),
            )
            .expect("complete");
        assert_eq!(
            reopened.replacement_entry(&entry.id).expect("entry").state,
            ReplacementState::Completed
        );
    }

    #[test]
    fn replacement_cannot_complete_without_an_installed_archive() {
        let store = active_store(None);
        let entry = planned_replacement(&store, "replacement-1");
        let error = store
            .complete_file_operation(
                entry.sync_operation_id.expect("operation"),
                &"b".repeat(64),
                4,
                LATER,
                None,
            )
            .expect_err("archive is mandatory");
        assert!(error.to_string().contains("archive journal"));
    }

    #[test]
    fn crash_before_install_aborts_when_the_old_live_digest_remains() {
        let store = active_store(None);
        let entry = archive_old(&store, &planned_replacement(&store, "replacement-1"));
        let recovered = store
            .recover_replacement(&entry.id, Some(&"a".repeat(64)), true, LATER)
            .expect("recover");
        assert_eq!(recovered.state, ReplacementState::Aborted);
        assert_eq!(
            store
                .file_sync_state("mapping-1")
                .expect("state")
                .operations
                .len(),
            1
        );
    }

    #[test]
    fn crash_after_install_rolls_forward_only_from_exact_digest_evidence() {
        let store = active_store(None);
        let entry = archive_old(&store, &planned_replacement(&store, "replacement-1"));
        let recovered = store
            .recover_replacement(&entry.id, Some(&"b".repeat(64)), true, LATER)
            .expect("recover");
        assert_eq!(recovered.state, ReplacementState::Completed);
        assert!(
            store
                .file_sync_state("mapping-1")
                .expect("state")
                .operations
                .is_empty()
        );
    }

    #[test]
    fn recovery_never_completes_when_both_operation_and_matching_baseline_are_missing() {
        let store = active_store(None);
        let entry = archive_old(&store, &planned_replacement(&store, "replacement-1"));
        store
            .connection
            .execute(
                "DELETE FROM file_sync_operations WHERE id = ?1",
                params![entry.sync_operation_id.expect("operation")],
            )
            .expect("remove operation to simulate inconsistent durable state");

        let error = store
            .recover_replacement(&entry.id, Some(&"b".repeat(64)), true, LATER)
            .expect_err("missing durable completion evidence must stop recovery");
        assert!(error.to_string().contains("exact completed baseline"));
        assert_eq!(
            store.replacement_entry(&entry.id).expect("entry").state,
            ReplacementState::Archived
        );
    }

    #[test]
    fn missing_archive_is_an_explicit_integrity_failure() {
        let store = active_store(None);
        let entry = archive_old(&store, &planned_replacement(&store, "replacement-1"));
        let recovered = store
            .recover_replacement(&entry.id, Some(&"b".repeat(64)), false, LATER)
            .expect("recover");
        assert_eq!(recovered.state, ReplacementState::IntegrityFailed);
        assert!(
            !store
                .file_sync_state("mapping-1")
                .expect("state")
                .operations
                .is_empty()
        );
    }

    #[test]
    fn concurrent_replacements_for_one_path_are_rejected() {
        let store = active_store(None);
        let first = planned_replacement(&store, "replacement-1");
        let error = store
            .prepare_replacement(&PrepareReplacementRequest {
                id: "replacement-2".to_owned(),
                mapping_id: first.mapping_id,
                path: first.path,
                sync_operation_id: first.sync_operation_id,
                old_digest: first.old_digest.expect("old digest"),
                old_size: first.old_size.expect("old size"),
                replacement_digest: first.replacement_digest,
                replacement_size: first.replacement_size,
                local_root: first.local_root,
                created_at: LATER.to_owned(),
            })
            .expect_err("second active replacement must fail");
        assert!(error.to_string().contains("already active"));
    }

    #[test]
    fn restore_is_journaled_and_preserves_the_version_it_replaces() {
        let store = active_store(None);
        let source = archive_old(&store, &planned_replacement(&store, "replacement-1"));
        store
            .mark_replacement_installed(&source.id, LATER)
            .expect("installed");
        store
            .complete_file_operation(
                source.sync_operation_id.expect("operation"),
                &"b".repeat(64),
                4,
                LATER,
                Some(&source.id),
            )
            .expect("complete source");

        let restore = store
            .prepare_restore(&PrepareRestoreRequest {
                id: "restore-1".to_owned(),
                source_journal_id: source.id,
                expected_current_digest: Some("b".repeat(64)),
                expected_current_size: Some(4),
                local_root: "/tmp/a".to_owned(),
                created_at: LATER.to_owned(),
            })
            .expect("prepare restore");
        store
            .mark_replacement_archived(
                &restore.id,
                &"b".repeat(64),
                4,
                &format!("sha256/bb/{}", "b".repeat(64)),
                LATER,
            )
            .expect("archive current version");
        store
            .mark_replacement_installed(&restore.id, LATER)
            .expect("restore installed");
        let completed = store
            .complete_restore(&restore.id, LATER)
            .expect("complete restore");
        assert_eq!(completed.state, ReplacementState::Completed);
        assert_eq!(
            completed.archive_digest.as_deref(),
            Some("b".repeat(64).as_str())
        );
    }

    #[test]
    fn missing_live_restore_is_idempotent_and_omits_null_wire_fields() {
        let store = active_store(None);
        let source = archive_old(&store, &planned_replacement(&store, "replacement-1"));
        store
            .mark_replacement_installed(&source.id, LATER)
            .expect("installed");
        store
            .complete_file_operation(
                source.sync_operation_id.expect("operation"),
                &"b".repeat(64),
                4,
                LATER,
                Some(&source.id),
            )
            .expect("complete source");
        let request = PrepareRestoreRequest {
            id: "restore-missing".to_owned(),
            source_journal_id: source.id,
            expected_current_digest: None,
            expected_current_size: None,
            local_root: "/tmp/a".to_owned(),
            created_at: LATER.to_owned(),
        };

        let first = store.prepare_restore(&request).expect("prepare restore");
        let repeated = store
            .prepare_restore(&request)
            .expect("repeat same restore");
        assert_eq!(first, repeated);
        assert_eq!(first.state, ReplacementState::Archived);
        let wire = serde_json::to_value(&first).expect("serialize entry");
        assert!(wire.get("oldDigest").is_none());
        assert!(wire.get("oldSize").is_none());
        assert!(wire.get("syncOperationId").is_none());

        let recovered = store
            .recover_replacement(&first.id, Some(&"a".repeat(64)), true, LATER)
            .expect("roll forward installed missing-live restore");
        assert_eq!(recovered.state, ReplacementState::Completed);
    }

    #[test]
    fn completed_archive_integrity_state_survives_reopen() {
        let directory = tempfile::tempdir().expect("tempdir");
        let database = directory.path().join("mappings.sqlite3");
        let store = active_store(Some(&database));
        let source = archive_old(&store, &planned_replacement(&store, "replacement-1"));
        store
            .mark_replacement_installed(&source.id, LATER)
            .expect("installed");
        store
            .complete_file_operation(
                source.sync_operation_id.expect("operation"),
                &"b".repeat(64),
                4,
                LATER,
                Some(&source.id),
            )
            .expect("complete source");
        let corrupt_entry = store
            .record_archive_object_issue(
                &source.id,
                ArchiveObjectState::Corrupt,
                "digest mismatch",
                LATER,
            )
            .expect("record corruption");
        assert_eq!(
            corrupt_entry.archive_state,
            Some(ArchiveObjectState::Corrupt)
        );
        assert_eq!(
            corrupt_entry.archive_error.as_deref(),
            Some("digest mismatch")
        );
        drop(store);

        let reopened = MappingStore::open(&database).expect("reopen");
        let durable = reopened
            .replacement_entry(&source.id)
            .expect("durable archive state");
        assert_eq!(durable.archive_state, Some(ArchiveObjectState::Corrupt));
        let missing = reopened
            .record_archive_object_issue(
                &source.id,
                ArchiveObjectState::Missing,
                "object disappeared",
                LATER,
            )
            .expect("record missing object");
        assert_eq!(missing.archive_state, Some(ArchiveObjectState::Missing));
        assert!(
            reopened
                .prepare_restore(&PrepareRestoreRequest {
                    id: "unsafe-restore".to_owned(),
                    source_journal_id: source.id,
                    expected_current_digest: None,
                    expected_current_size: None,
                    local_root: "/tmp/a".to_owned(),
                    created_at: LATER.to_owned(),
                })
                .is_err()
        );
    }

    #[test]
    fn archived_history_survives_mapping_removal() {
        let store = active_store(None);
        let entry = archive_old(&store, &planned_replacement(&store, "replacement-1"));
        store
            .remove_local("mapping-1", "a-device", None, 1, LATER)
            .expect("remove mapping");
        let versions = store.archived_versions("mapping-1", None).expect("history");
        assert_eq!(versions, vec![entry]);
    }

    #[test]
    fn archived_versions_supports_bounded_reads_in_created_at_then_id_order() {
        let store = active_store(None);

        let first = archived_version(
            &store,
            "replacement-1",
            "notes-1.txt",
            "2026-08-11T10:00:00Z",
        );
        let second = archived_version(
            &store,
            "replacement-2",
            "notes-2.txt",
            "2026-08-11T10:01:00Z",
        );
        let third = archived_version(
            &store,
            "replacement-3",
            "notes-3.txt",
            "2026-08-11T10:01:00Z",
        );

        let limited = store
            .archived_versions("mapping-1", Some(2))
            .expect("limited history");
        assert_eq!(limited, vec![third.clone(), second.clone()]);

        let all = store
            .archived_versions("mapping-1", None)
            .expect("full history");
        assert_eq!(all, vec![third, second, first]);
    }

    const RETENTION_NOW: &str = "2026-09-20T10:00:00Z";

    fn set_history_limits(store: &MappingStore, days: i64, max_bytes: i64) {
        store
            .connection
            .execute(
                "UPDATE folder_mappings SET history_days = ?1, history_max_bytes = ?2
                 WHERE id = 'mapping-1'",
                params![days, max_bytes],
            )
            .expect("set history limits");
    }

    fn digest_of(content: char) -> String {
        content.to_string().repeat(64)
    }

    /// Completes a replacement of `path` whose archived four-byte previous content is `old`.
    fn completed_version(
        store: &MappingStore,
        id: &str,
        path: &str,
        created_at: &str,
        old: char,
        new: char,
    ) -> ReplacementJournalEntry {
        reconcile(store, path, old, old);
        let operation_id = reconcile(store, path, old, new).operations[0].id;
        store
            .prepare_replacement(&PrepareReplacementRequest {
                id: id.to_owned(),
                mapping_id: "mapping-1".to_owned(),
                path: path.to_owned(),
                sync_operation_id: Some(operation_id),
                old_digest: digest_of(old),
                old_size: 4,
                replacement_digest: digest_of(new),
                replacement_size: 4,
                local_root: "/tmp/a".to_owned(),
                created_at: created_at.to_owned(),
            })
            .expect("prepare replacement");
        store
            .mark_replacement_archived(
                id,
                &digest_of(old),
                4,
                &format!("sha256/{old}{old}/{}", digest_of(old)),
                LATER,
            )
            .expect("mark archived");
        store
            .mark_replacement_installed(id, LATER)
            .expect("mark installed");
        store
            .complete_file_operation(operation_id, &digest_of(new), 4, LATER, Some(id))
            .expect("complete replacement");
        store.replacement_entry(id).expect("completed version")
    }

    fn prunable_ids(store: &MappingStore) -> Vec<String> {
        store
            .prunable_archive_entries("mapping-1", RETENTION_NOW, 100)
            .expect("list prunable versions")
            .into_iter()
            .map(|entry| entry.id)
            .collect()
    }

    fn archive_object_count(store: &MappingStore, content: char) -> i64 {
        store
            .connection
            .query_row(
                "SELECT COUNT(*) FROM archive_objects WHERE digest = ?1",
                params![digest_of(content)],
                |row| row.get(0),
            )
            .expect("count archive objects")
    }

    #[test]
    fn retention_offers_versions_older_than_the_history_window() {
        let store = active_store(None);
        set_history_limits(&store, 30, 0);
        completed_version(&store, "old", "old.txt", "2026-08-01T10:00:00Z", 'c', '1');
        completed_version(
            &store,
            "boundary",
            "boundary.txt",
            "2026-08-21T10:00:00Z",
            'd',
            '2',
        );
        completed_version(
            &store,
            "recent",
            "recent.txt",
            "2026-09-10T10:00:00Z",
            'e',
            '3',
        );

        assert_eq!(prunable_ids(&store), vec!["old"]);
    }

    #[test]
    fn retention_keeps_the_newest_versions_that_fit_the_storage_cap() {
        let store = active_store(None);
        set_history_limits(&store, 0, 8);
        completed_version(
            &store,
            "oldest",
            "one.txt",
            "2026-09-01T10:00:00Z",
            'c',
            '1',
        );
        completed_version(
            &store,
            "shared-older",
            "two.txt",
            "2026-09-02T10:00:00Z",
            'd',
            '2',
        );
        completed_version(
            &store,
            "shared-newer",
            "three.txt",
            "2026-09-03T10:00:00Z",
            'd',
            '3',
        );
        completed_version(
            &store,
            "newest",
            "four.txt",
            "2026-09-04T10:00:00Z",
            'e',
            '4',
        );

        // The newest content and the content shared by two versions fill eight bytes exactly.
        assert_eq!(prunable_ids(&store), vec!["oldest"]);

        set_history_limits(&store, 0, 7);
        assert_eq!(
            prunable_ids(&store),
            vec!["shared-newer", "shared-older", "oldest"]
        );
    }

    #[test]
    fn zero_history_limits_keep_every_version() {
        let store = active_store(None);
        set_history_limits(&store, 0, 0);
        completed_version(
            &store,
            "ancient",
            "one.txt",
            "2020-01-01T00:00:00Z",
            'c',
            '1',
        );

        assert!(prunable_ids(&store).is_empty());
    }

    #[test]
    fn retention_never_offers_unfinished_work_or_the_source_of_an_unfinished_restore() {
        let store = active_store(None);
        set_history_limits(&store, 1, 0);
        let source = completed_version(
            &store,
            "source",
            "restored.txt",
            "2026-08-01T10:00:00Z",
            'c',
            '1',
        );
        completed_version(
            &store,
            "plain",
            "plain.txt",
            "2026-08-01T10:00:00Z",
            'd',
            '2',
        );
        let restore = store
            .prepare_restore(&PrepareRestoreRequest {
                id: "restore-1".to_owned(),
                source_journal_id: source.id,
                expected_current_digest: Some(digest_of('1')),
                expected_current_size: Some(4),
                local_root: "/tmp/a".to_owned(),
                created_at: "2026-08-02T10:00:00Z".to_owned(),
            })
            .expect("prepare restore");
        store
            .mark_replacement_archived(
                &restore.id,
                &digest_of('1'),
                4,
                &format!("sha256/11/{}", digest_of('1')),
                LATER,
            )
            .expect("archive the current content before restoring");

        assert_eq!(prunable_ids(&store), vec!["plain"]);
        let result = store
            .prune_archive_entries(
                "mapping-1",
                &["source".to_owned(), "plain".to_owned()],
                RETENTION_NOW,
            )
            .expect("prune");
        assert_eq!(
            result,
            ArchivePruneResult {
                pruned_entries: 1,
                queued_object_deletions: 1
            }
        );
        assert_eq!(archive_object_count(&store, 'c'), 1);
        assert_eq!(archive_object_count(&store, '1'), 1);
    }

    #[test]
    fn pruning_removes_only_still_prunable_versions_and_queues_unreferenced_content() {
        let store = active_store(None);
        set_history_limits(&store, 30, 0);
        completed_version(
            &store,
            "expired-unique",
            "one.txt",
            "2026-07-01T10:00:00Z",
            'c',
            '1',
        );
        completed_version(
            &store,
            "expired-shared",
            "two.txt",
            "2026-07-02T10:00:00Z",
            'd',
            '2',
        );
        let recent = completed_version(
            &store,
            "recent-shared",
            "three.txt",
            "2026-09-10T10:00:00Z",
            'd',
            '3',
        );
        let requested = [
            "expired-unique".to_owned(),
            "expired-shared".to_owned(),
            "recent-shared".to_owned(),
        ];

        let result = store
            .prune_archive_entries("mapping-1", &requested, RETENTION_NOW)
            .expect("prune");
        assert_eq!(
            result,
            ArchivePruneResult {
                pruned_entries: 2,
                queued_object_deletions: 1
            }
        );
        assert_eq!(
            store.archived_versions("mapping-1", None).expect("history"),
            vec![recent]
        );
        assert_eq!(
            store
                .pending_archive_object_deletions(10)
                .expect("pending deletions"),
            vec![ArchiveObjectDeletion {
                digest: digest_of('c'),
                object_key: format!("sha256/cc/{}", digest_of('c')),
                size: 4,
            }]
        );
        assert_eq!(archive_object_count(&store, 'c'), 0);
        assert_eq!(archive_object_count(&store, 'd'), 1);

        let repeated = store
            .prune_archive_entries("mapping-1", &requested, RETENTION_NOW)
            .expect("repeat prune");
        assert_eq!(
            repeated,
            ArchivePruneResult {
                pruned_entries: 0,
                queued_object_deletions: 0
            }
        );
    }

    #[test]
    fn queued_content_is_not_archived_again_until_its_file_deletion_is_confirmed() {
        let directory = tempfile::tempdir().expect("tempdir");
        let database = directory.path().join("mappings.sqlite3");
        let store = active_store(Some(&database));
        set_history_limits(&store, 30, 0);
        completed_version(
            &store,
            "expired",
            "one.txt",
            "2026-07-01T10:00:00Z",
            'c',
            '1',
        );
        store
            .prune_archive_entries("mapping-1", &["expired".to_owned()], RETENTION_NOW)
            .expect("prune");
        drop(store);

        // A cleanup pass interrupted before removing the file leaves its queue entry durable.
        let reopened = MappingStore::open(&database).expect("reopen");
        assert_eq!(
            reopened
                .pending_archive_object_deletions(10)
                .expect("pending deletions")
                .len(),
            1
        );
        reconcile(&reopened, "two.txt", 'c', 'c');
        let operation_id = reconcile(&reopened, "two.txt", 'c', '2').operations[0].id;
        let request = PrepareReplacementRequest {
            id: "reuses-queued-content".to_owned(),
            mapping_id: "mapping-1".to_owned(),
            path: "two.txt".to_owned(),
            sync_operation_id: Some(operation_id),
            old_digest: digest_of('c'),
            old_size: 4,
            replacement_digest: digest_of('2'),
            replacement_size: 4,
            local_root: "/tmp/a".to_owned(),
            created_at: LATER.to_owned(),
        };
        let error = reopened
            .prepare_replacement(&request)
            .expect_err("queued content must not gain a new archive reference");
        assert!(error.to_string().contains("still being removed"));

        assert!(
            reopened
                .complete_archive_object_deletion(&digest_of('c'))
                .expect("confirm deletion")
        );
        assert!(
            !reopened
                .complete_archive_object_deletion(&digest_of('c'))
                .expect("repeat confirmation")
        );
        reopened
            .prepare_replacement(&request)
            .expect("content can be archived again after deletion");
    }

    #[test]
    fn retention_requests_are_validated() {
        let store = active_store(None);
        assert!(
            store
                .prunable_archive_entries("mapping-1", RETENTION_NOW, 0)
                .is_err()
        );
        assert!(
            store
                .prunable_archive_entries("mapping-1", RETENTION_NOW, 1_001)
                .is_err()
        );
        assert!(
            store
                .prunable_archive_entries("mapping-1", "yesterday", 1)
                .is_err()
        );
        assert!(matches!(
            store.prunable_archive_entries("missing", RETENTION_NOW, 1),
            Err(MappingStoreError::NotFound(_))
        ));
        assert!(
            store
                .prune_archive_entries("mapping-1", &[], RETENTION_NOW)
                .is_err()
        );
        assert!(
            store
                .prune_archive_entries(
                    "mapping-1",
                    &["same".to_owned(), "same".to_owned()],
                    RETENTION_NOW
                )
                .is_err()
        );
        assert!(store.pending_archive_object_deletions(0).is_err());
        assert!(
            store
                .complete_archive_object_deletion("not-a-digest")
                .is_err()
        );
    }

    #[test]
    fn archived_versions_rejects_zero_limit() {
        let store = active_store(None);
        let error = store
            .archived_versions("mapping-1", Some(0))
            .expect_err("zero limit must be rejected");
        assert!(matches!(
            error,
            MappingStoreError::Invalid(message) if message == "limit must be greater than zero"
        ));
    }
}
