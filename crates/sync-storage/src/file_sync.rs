//! Durable verified-file baselines, reconciliation conflicts, and retryable transfer work.

use std::collections::{BTreeSet, HashMap};

use rusqlite::{OptionalExtension, Transaction, TransactionBehavior, params};
use serde::{Deserialize, Serialize};
use time::OffsetDateTime;
use time::format_description::well_known::Rfc3339;

use crate::mapping::{MappingStore, MappingStoreError, check_identifier};
use crate::version_archive::{
    ReplacementRecoveryIssue, mark_completed, recovery_issues_for_mapping,
    require_installed_sync_entry,
};

const MAX_FILES: usize = 10_000;
const MAX_PATH_LENGTH: usize = 4_096;
const MAX_ERROR_LENGTH: usize = 2_000;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ObservedFile {
    pub path: String,
    pub size: i64,
    pub digest: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum SyncDirection {
    PullRemote,
    PushLocal,
}

impl SyncDirection {
    fn as_str(self) -> &'static str {
        match self {
            Self::PullRemote => "pull-remote",
            Self::PushLocal => "push-local",
        }
    }

    fn parse(value: &str) -> Result<Self, MappingStoreError> {
        match value {
            "pull-remote" => Ok(Self::PullRemote),
            "push-local" => Ok(Self::PushLocal),
            other => Err(MappingStoreError::CorruptMetadata {
                id: "file-sync-operation".to_owned(),
                detail: format!("unknown direction {other:?}"),
            }),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ConflictKind {
    UnbasedDivergence,
    SimultaneousModification,
    DeletionNotPropagated,
    DirectionBlocked,
}

impl ConflictKind {
    fn as_str(self) -> &'static str {
        match self {
            Self::UnbasedDivergence => "unbased-divergence",
            Self::SimultaneousModification => "simultaneous-modification",
            Self::DeletionNotPropagated => "deletion-not-propagated",
            Self::DirectionBlocked => "direction-blocked",
        }
    }

    fn parse(value: &str) -> Result<Self, MappingStoreError> {
        match value {
            "unbased-divergence" => Ok(Self::UnbasedDivergence),
            "simultaneous-modification" => Ok(Self::SimultaneousModification),
            "deletion-not-propagated" => Ok(Self::DeletionNotPropagated),
            "direction-blocked" => Ok(Self::DirectionBlocked),
            other => Err(MappingStoreError::CorruptMetadata {
                id: "file-sync-conflict".to_owned(),
                detail: format!("unknown conflict kind {other:?}"),
            }),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncOperation {
    pub id: i64,
    pub mapping_id: String,
    pub path: String,
    pub direction: SyncDirection,
    pub source_digest: String,
    pub source_size: i64,
    pub expected_destination_digest: Option<String>,
    pub status: String,
    pub attempts: i64,
    pub last_error: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncConflict {
    pub mapping_id: String,
    pub path: String,
    pub kind: ConflictKind,
    pub local_digest: Option<String>,
    pub remote_digest: Option<String>,
    pub detected_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReconcileRequest {
    pub mapping_id: String,
    pub local: Vec<ObservedFile>,
    pub remote: Vec<ObservedFile>,
    pub mode: String,
    pub observed_at: String,
    pub queue_operations: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReconcileGenerationsRequest {
    pub mapping_id: String,
    pub local_generation_id: String,
    pub remote_generation_id: String,
    pub mode: String,
    pub observed_at: String,
    pub queue_operations: bool,
}

const GENERATION_RECONCILE_PAGE: i64 = 1_000;

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ResolveConflictRequest {
    pub mapping_id: String,
    pub path: String,
    pub direction: SyncDirection,
    pub local_digest: String,
    pub local_size: i64,
    pub remote_digest: String,
    pub remote_size: i64,
    pub requested_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AuthorizeFileApplicationRequest {
    pub mapping_id: String,
    pub path: String,
    pub digest: String,
    pub size: i64,
    pub expected_destination_digest: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ApplyVerifiedFileRequest {
    pub operation_id: i64,
    pub mapping_id: String,
    pub path: String,
    pub digest: String,
    pub size: i64,
    pub verified_at: String,
    pub replacement_journal_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileApplicationAuthorization {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub operation_id: Option<i64>,
    pub already_verified: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReconcileResult {
    pub mapping_id: String,
    pub initialized: bool,
    pub baseline_count: i64,
    pub verified_count: usize,
    pub operations: Vec<SyncOperation>,
    pub conflicts: Vec<SyncConflict>,
    pub recovery_issues: Vec<ReplacementRecoveryIssue>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileSyncState {
    pub mapping_id: String,
    pub initialized: bool,
    pub baseline_count: i64,
    pub operations: Vec<SyncOperation>,
    pub conflicts: Vec<SyncConflict>,
    pub recovery_issues: Vec<ReplacementRecoveryIssue>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileSyncMutationAck {
    pub mapping_id: String,
}

#[derive(Debug, Clone)]
struct PlannedOperation {
    path: String,
    direction: SyncDirection,
    source_digest: String,
    source_size: i64,
    expected_destination_digest: Option<String>,
}

#[derive(Debug, Clone)]
struct PlannedConflict {
    path: String,
    kind: ConflictKind,
    local_digest: Option<String>,
    remote_digest: Option<String>,
}

struct ReconciliationPlan {
    verified_count: usize,
    operations: Vec<PlannedOperation>,
    conflicts: Vec<PlannedConflict>,
}

impl MappingStore {
    /// Reconciles two full SHA-256 observations against the last verified common baseline.
    /// Identical paths advance the baseline; one-sided safe changes become durable operations;
    /// ambiguous changes become durable conflicts and never mutate a user file.
    ///
    /// # Errors
    ///
    /// Returns a validation, mapping-state, corrupt-metadata, or database error without
    /// committing a partial reconciliation.
    pub fn reconcile_files(
        &self,
        request: &ReconcileRequest,
    ) -> Result<ReconcileResult, MappingStoreError> {
        self.ensure_import_completed()?;
        validate_reconcile_request(request)?;
        let transaction =
            Transaction::new_unchecked(&self.connection, TransactionBehavior::Immediate)?;
        require_active_mapping(&transaction, &request.mapping_id)?;
        if has_active_replacement_journal(&transaction, &request.mapping_id)? {
            return Err(MappingStoreError::Invalid(
                "file reconciliation is blocked by an active replacement recovery journal"
                    .to_owned(),
            ));
        }
        let initialized = transaction.query_row(
            "SELECT EXISTS(SELECT 1 FROM file_sync_mapping_state WHERE mapping_id = ?1)",
            params![request.mapping_id],
            |row| row.get::<_, bool>(0),
        )?;
        let baselines = read_baselines(&transaction, &request.mapping_id)?;
        let local = observation_map(&request.local)?;
        let remote = observation_map(&request.remote)?;
        let plan = plan_reconciliation(
            &transaction,
            request,
            initialized,
            &baselines,
            &local,
            &remote,
        )?;
        persist_reconciliation(&transaction, request, &plan.operations, &plan.conflicts)?;
        transaction.commit()?;
        self.file_sync_state(&request.mapping_id)
            .map(|state| ReconcileResult {
                mapping_id: state.mapping_id,
                initialized: state.initialized,
                baseline_count: state.baseline_count,
                verified_count: plan.verified_count,
                operations: state.operations,
                conflicts: state.conflicts,
                recovery_issues: state.recovery_issues,
            })
    }

    /// Reconciles two sealed scan generations with bounded indexed reads.
    ///
    /// Observations are streamed in ordered pages and merged without ever
    /// materialising full manifests, baselines, or path sets. The completed
    /// plan is published atomically; a failure commits nothing. Incomplete
    /// generations are invisible: only `sealed` generations with matching
    /// mapping, revision, and full SHA-256 digests are accepted.
    ///
    /// # Errors
    ///
    /// Returns a validation, mapping-state, or database error without
    /// committing a partial reconciliation.
    pub fn reconcile_generations(
        &self,
        request: &ReconcileGenerationsRequest,
    ) -> Result<ReconcileResult, MappingStoreError> {
        self.ensure_import_completed()?;
        validate_generations_request(request)?;
        let transaction =
            Transaction::new_unchecked(&self.connection, TransactionBehavior::Immediate)?;
        require_active_mapping(&transaction, &request.mapping_id)?;
        if has_active_replacement_journal(&transaction, &request.mapping_id)? {
            return Err(MappingStoreError::Invalid(
                "file reconciliation is blocked by an active replacement recovery journal"
                    .to_owned(),
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
        let local_meta = sealed_generation_meta(
            &transaction,
            &request.local_generation_id,
            &request.mapping_id,
        )?;
        let remote_meta = sealed_generation_meta(
            &transaction,
            &request.remote_generation_id,
            &request.mapping_id,
        )?;
        if local_meta.revision != current_revision || remote_meta.revision != current_revision {
            return Err(MappingStoreError::Invalid(
                "scan generation mapping revision is stale".to_owned(),
            ));
        }
        if local_meta.hash_mode != "full-sha256" || remote_meta.hash_mode != "full-sha256" {
            return Err(MappingStoreError::Invalid(
                "generation reconciliation requires full SHA-256 observations".to_owned(),
            ));
        }
        let initialized = transaction.query_row(
            "SELECT EXISTS(SELECT 1 FROM file_sync_mapping_state WHERE mapping_id = ?1)",
            params![request.mapping_id],
            |row| row.get::<_, bool>(0),
        )?;
        let plan = plan_generations_reconciliation(
            &transaction,
            request,
            initialized,
            &request.local_generation_id,
            &request.remote_generation_id,
        )?;
        persist_generations_reconciliation(
            &transaction,
            request,
            &plan.operations,
            &plan.conflicts,
        )?;
        transaction.commit()?;
        self.file_sync_state(&request.mapping_id)
            .map(|state| ReconcileResult {
                mapping_id: state.mapping_id,
                initialized: state.initialized,
                baseline_count: state.baseline_count,
                verified_count: plan.verified_count,
                operations: state.operations,
                conflicts: state.conflicts,
                recovery_issues: state.recovery_issues,
            })
    }

    /// Bounded page over durable operations, ordered by id.
    ///
    /// # Errors
    ///
    /// Returns a validation or database error.
    pub fn file_sync_operations_page(
        &self,
        mapping_id: &str,
        cursor: Option<i64>,
        limit: i64,
    ) -> Result<(Vec<SyncOperation>, Option<i64>), MappingStoreError> {
        self.ensure_import_completed()?;
        check_identifier("mappingId", mapping_id)?;
        if limit <= 0 || limit > 1_000 {
            return Err(MappingStoreError::Invalid(
                "operations page limit is outside the supported bound".to_owned(),
            ));
        }
        let mut statement = self.connection.prepare(
            "SELECT id, mapping_id, relative_path, direction, source_digest, source_size,
                    expected_destination_digest, status, attempts, last_error, created_at, updated_at
             FROM file_sync_operations
             WHERE mapping_id = ?1 AND (?2 IS NULL OR id > ?2)
             ORDER BY id LIMIT ?3",
        )?;
        let rows =
            statement.query_map(params![mapping_id, cursor, limit + 1], operation_from_row)?;
        let mut operations = Vec::new();
        for row in rows {
            operations.push(row?);
        }
        let next = if i64::try_from(operations.len()).unwrap_or(i64::MAX) > limit {
            operations.pop();
            operations.last().map(|operation| operation.id)
        } else {
            None
        };
        Ok((operations, next))
    }

    /// Bounded page over durable conflicts, ordered by path.
    ///
    /// # Errors
    ///
    /// Returns a validation or database error.
    pub fn file_sync_conflicts_page(
        &self,
        mapping_id: &str,
        cursor: Option<&str>,
        limit: i64,
    ) -> Result<(Vec<SyncConflict>, Option<String>), MappingStoreError> {
        self.ensure_import_completed()?;
        check_identifier("mappingId", mapping_id)?;
        if limit <= 0 || limit > 1_000 {
            return Err(MappingStoreError::Invalid(
                "conflicts page limit is outside the supported bound".to_owned(),
            ));
        }
        if let Some(cursor) = cursor {
            validate_path(cursor)?;
        }
        let mut statement = self.connection.prepare(
            "SELECT mapping_id, relative_path, kind, local_digest, remote_digest, detected_at
             FROM file_sync_conflicts
             WHERE mapping_id = ?1 AND (?2 IS NULL OR relative_path > ?2)
             ORDER BY relative_path LIMIT ?3",
        )?;
        let rows = statement.query_map(params![mapping_id, cursor, limit + 1], |row| {
            let kind: String = row.get(2)?;
            Ok(SyncConflict {
                mapping_id: row.get(0)?,
                path: row.get(1)?,
                kind: ConflictKind::parse(&kind).map_err(|error| {
                    rusqlite::Error::FromSqlConversionFailure(
                        2,
                        rusqlite::types::Type::Text,
                        Box::new(error),
                    )
                })?,
                local_digest: row.get(3)?,
                remote_digest: row.get(4)?,
                detected_at: row.get(5)?,
            })
        })?;
        let mut conflicts = Vec::new();
        for row in rows {
            conflicts.push(row?);
        }
        let next = if i64::try_from(conflicts.len()).unwrap_or(i64::MAX) > limit {
            conflicts.pop();
            conflicts.last().map(|conflict| conflict.path.clone())
        } else {
            None
        };
        Ok((conflicts, next))
    }

    /// Returns the durable baseline, retry, and conflict projection for one mapping.
    ///
    /// # Errors
    ///
    /// Returns a validation, migration-state, corrupt-metadata, or database error.
    pub fn file_sync_state(&self, mapping_id: &str) -> Result<FileSyncState, MappingStoreError> {
        self.ensure_import_completed()?;
        check_identifier("mappingId", mapping_id)?;
        let initialized = self.connection.query_row(
            "SELECT EXISTS(SELECT 1 FROM file_sync_mapping_state WHERE mapping_id = ?1)",
            params![mapping_id],
            |row| row.get::<_, bool>(0),
        )?;
        let baseline_count = self.connection.query_row(
            "SELECT COUNT(*) FROM file_sync_baselines WHERE mapping_id = ?1",
            params![mapping_id],
            |row| row.get(0),
        )?;
        let operations = read_operations(&self.connection, mapping_id)?;
        let conflicts = read_conflicts(&self.connection, mapping_id)?;
        let recovery_issues = recovery_issues_for_mapping(&self.connection, mapping_id)?;
        Ok(FileSyncState {
            mapping_id: mapping_id.to_owned(),
            initialized,
            baseline_count,
            operations,
            conflicts,
            recovery_issues,
        })
    }

    /// Turns one exact two-sided conflict into durable retryable transfer work.
    ///
    /// The conflict remains present until the normal verified-operation completion path advances
    /// the common baseline. Repeating the same choice is idempotent; a different or stale choice
    /// is rejected rather than replacing work that may already be in flight.
    ///
    /// # Errors
    ///
    /// Returns a validation, missing-conflict, stale-conflict, active-operation, mapping-state, or
    /// database error without committing a partial transition.
    pub fn resolve_file_conflict(
        &self,
        request: &ResolveConflictRequest,
    ) -> Result<FileSyncState, MappingStoreError> {
        self.ensure_import_completed()?;
        check_identifier("mappingId", &request.mapping_id)?;
        validate_path(&request.path)?;
        validate_digest(&request.local_digest)?;
        validate_size(request.local_size)?;
        validate_digest(&request.remote_digest)?;
        validate_size(request.remote_size)?;
        validate_timestamp("requestedAt", &request.requested_at)?;

        let transaction =
            Transaction::new_unchecked(&self.connection, TransactionBehavior::Immediate)?;
        require_active_mapping(&transaction, &request.mapping_id)?;
        let conflict = read_conflicts(&transaction, &request.mapping_id)?
            .into_iter()
            .find(|conflict| conflict.path == request.path)
            .ok_or_else(|| {
                MappingStoreError::NotFound(format!(
                    "file conflict {}:{}",
                    request.mapping_id, request.path
                ))
            })?;
        if conflict.local_digest.as_deref() != Some(request.local_digest.as_str())
            || conflict.remote_digest.as_deref() != Some(request.remote_digest.as_str())
        {
            return Err(MappingStoreError::Invalid(
                "the file conflict changed before the selected version could be recorded"
                    .to_owned(),
            ));
        }

        let operation = match request.direction {
            SyncDirection::PushLocal => PlannedOperation {
                path: request.path.clone(),
                direction: request.direction,
                source_digest: request.local_digest.clone(),
                source_size: request.local_size,
                expected_destination_digest: Some(request.remote_digest.clone()),
            },
            SyncDirection::PullRemote => PlannedOperation {
                path: request.path.clone(),
                direction: request.direction,
                source_digest: request.remote_digest.clone(),
                source_size: request.remote_size,
                expected_destination_digest: Some(request.local_digest.clone()),
            },
        };
        if let Some(existing) = read_operations(&transaction, &request.mapping_id)?
            .into_iter()
            .find(|candidate| candidate.path == request.path)
        {
            let same_choice = existing.direction == operation.direction
                && existing.source_digest == operation.source_digest
                && existing.source_size == operation.source_size
                && existing.expected_destination_digest == operation.expected_destination_digest;
            if !same_choice {
                return Err(MappingStoreError::Invalid(
                    "a different file operation is already pending for this conflict".to_owned(),
                ));
            }
            transaction.rollback()?;
            return self.file_sync_state(&request.mapping_id);
        }

        insert_operation(
            &transaction,
            &request.mapping_id,
            &request.requested_at,
            &operation,
        )?;
        transaction.commit()?;
        self.file_sync_state(&request.mapping_id)
    }

    /// Authorizes an incoming file application only when it matches exact durable pull work.
    /// A missing operation is accepted solely as an idempotent retry of the current verified
    /// baseline, never as permission to mutate the filesystem.
    ///
    /// # Errors
    ///
    /// Returns a validation, inactive-mapping, unauthorized-application, corrupt-metadata, or
    /// database error.
    pub fn authorize_file_application(
        &self,
        request: &AuthorizeFileApplicationRequest,
    ) -> Result<FileApplicationAuthorization, MappingStoreError> {
        self.ensure_import_completed()?;
        check_identifier("mappingId", &request.mapping_id)?;
        validate_path(&request.path)?;
        validate_digest(&request.digest)?;
        validate_size(request.size)?;
        if let Some(digest) = request.expected_destination_digest.as_deref() {
            validate_digest(digest)?;
        }

        let transaction =
            Transaction::new_unchecked(&self.connection, TransactionBehavior::Deferred)?;
        require_active_mapping(&transaction, &request.mapping_id)?;
        let operations = read_operations(&transaction, &request.mapping_id)?;
        if let Some(operation) = operations.iter().find(|operation| {
            operation.path == request.path
                && operation.direction == SyncDirection::PullRemote
                && operation.source_digest == request.digest
                && operation.source_size == request.size
                && operation.expected_destination_digest == request.expected_destination_digest
        }) {
            let result = FileApplicationAuthorization {
                operation_id: Some(operation.id),
                already_verified: false,
            };
            transaction.commit()?;
            return Ok(result);
        }
        if operations
            .iter()
            .any(|operation| operation.path == request.path)
        {
            return Err(MappingStoreError::Invalid(
                "incoming file application does not match the durable operation".to_owned(),
            ));
        }
        let baseline = read_baselines(&transaction, &request.mapping_id)?
            .get(&request.path)
            .cloned();
        let has_conflict = read_conflicts(&transaction, &request.mapping_id)?
            .iter()
            .any(|conflict| conflict.path == request.path);
        if baseline.as_ref() == Some(&(request.digest.clone(), request.size)) && !has_conflict {
            transaction.commit()?;
            return Ok(FileApplicationAuthorization {
                operation_id: None,
                already_verified: true,
            });
        }
        Err(MappingStoreError::Invalid(
            "incoming file application has no matching durable operation".to_owned(),
        ))
    }

    /// Commits a successfully verified operation into the common baseline.
    ///
    /// # Errors
    ///
    /// Returns a validation, missing-operation, corrupt-metadata, or database error.
    pub fn complete_file_operation(
        &self,
        operation_id: i64,
        digest: &str,
        size: i64,
        verified_at: &str,
        replacement_journal_id: Option<&str>,
    ) -> Result<FileSyncMutationAck, MappingStoreError> {
        validate_digest(digest)?;
        validate_size(size)?;
        validate_timestamp("verifiedAt", verified_at)?;
        let transaction =
            Transaction::new_unchecked(&self.connection, TransactionBehavior::Immediate)?;
        let operation = operation_by_id(&transaction, operation_id)?
            .ok_or_else(|| MappingStoreError::NotFound(format!("file operation {operation_id}")))?;
        if operation.source_digest != digest || operation.source_size != size {
            return Err(MappingStoreError::Invalid(
                "completed file metadata did not match the durable operation".to_owned(),
            ));
        }
        let installed_entry =
            installed_replacement_entry(&transaction, &operation, replacement_journal_id)?;
        upsert_baseline(
            &transaction,
            &operation.mapping_id,
            &operation.path,
            digest,
            size,
            verified_at,
        )?;
        transaction.execute(
            "DELETE FROM file_sync_operations WHERE id = ?1",
            params![operation_id],
        )?;
        if let Some(entry_id) = installed_entry {
            mark_completed(&transaction, &entry_id, verified_at)?;
        }
        transaction.execute(
            "DELETE FROM file_sync_conflicts WHERE mapping_id = ?1 AND relative_path = ?2",
            params![operation.mapping_id, operation.path],
        )?;
        transaction.commit()?;
        Ok(FileSyncMutationAck {
            mapping_id: operation.mapping_id,
        })
    }

    /// Records a file version verified by the authenticated peer after transfer.
    ///
    /// # Errors
    ///
    /// Returns a validation, inactive-mapping, migration-state, or database error.
    pub fn apply_verified_file(
        &self,
        request: &ApplyVerifiedFileRequest,
    ) -> Result<FileSyncState, MappingStoreError> {
        self.ensure_import_completed()?;
        check_identifier("mappingId", &request.mapping_id)?;
        validate_path(&request.path)?;
        validate_digest(&request.digest)?;
        validate_size(request.size)?;
        validate_timestamp("verifiedAt", &request.verified_at)?;
        let transaction =
            Transaction::new_unchecked(&self.connection, TransactionBehavior::Immediate)?;
        require_active_mapping(&transaction, &request.mapping_id)?;
        let operation = operation_by_id(&transaction, request.operation_id)?;
        let Some(operation) = operation else {
            let baseline = read_baselines(&transaction, &request.mapping_id)?
                .get(&request.path)
                .cloned();
            let has_conflict = read_conflicts(&transaction, &request.mapping_id)?
                .iter()
                .any(|conflict| conflict.path == request.path);
            if baseline.as_ref() == Some(&(request.digest.clone(), request.size)) && !has_conflict {
                transaction.commit()?;
                return self.file_sync_state(&request.mapping_id);
            }
            return Err(MappingStoreError::Invalid(
                "verified file did not match durable synchronization work".to_owned(),
            ));
        };
        if operation.mapping_id != request.mapping_id
            || operation.path != request.path
            || operation.direction != SyncDirection::PullRemote
            || operation.source_digest != request.digest
            || operation.source_size != request.size
        {
            return Err(MappingStoreError::Invalid(
                "verified file did not match the exact durable pull operation".to_owned(),
            ));
        }
        let installed_entry = installed_replacement_entry(
            &transaction,
            &operation,
            request.replacement_journal_id.as_deref(),
        )?;
        upsert_baseline(
            &transaction,
            &request.mapping_id,
            &request.path,
            &request.digest,
            request.size,
            &request.verified_at,
        )?;
        transaction.execute(
            "DELETE FROM file_sync_operations WHERE id = ?1",
            params![request.operation_id],
        )?;
        if let Some(entry_id) = installed_entry {
            mark_completed(&transaction, &entry_id, &request.verified_at)?;
        }
        transaction.execute(
            "DELETE FROM file_sync_conflicts WHERE mapping_id = ?1 AND relative_path = ?2",
            params![request.mapping_id, request.path],
        )?;
        transaction.commit()?;
        self.file_sync_state(&request.mapping_id)
    }

    /// Persists a bounded failure diagnostic and increments the operation attempt count.
    ///
    /// # Errors
    ///
    /// Returns a validation, missing-operation, or database error.
    pub fn fail_file_operation(
        &self,
        operation_id: i64,
        detail: &str,
        failed_at: &str,
    ) -> Result<FileSyncMutationAck, MappingStoreError> {
        validate_timestamp("failedAt", failed_at)?;
        let sanitized: String = detail
            .chars()
            .filter(|character| *character != '\0')
            .take(MAX_ERROR_LENGTH)
            .collect();
        if sanitized.trim().is_empty() {
            return Err(MappingStoreError::Invalid(
                "operation failure detail must not be empty".to_owned(),
            ));
        }
        let mapping_id: String = self.connection.query_row(
            "SELECT mapping_id FROM file_sync_operations WHERE id = ?1",
            params![operation_id],
            |row| row.get(0),
        )?;
        self.connection.execute(
            "UPDATE file_sync_operations
             SET status = 'failed', attempts = attempts + 1, last_error = ?2, updated_at = ?3
             WHERE id = ?1",
            params![operation_id, sanitized, failed_at],
        )?;
        Ok(FileSyncMutationAck { mapping_id })
    }
}

fn plan_reconciliation(
    transaction: &Transaction<'_>,
    request: &ReconcileRequest,
    initialized: bool,
    baselines: &HashMap<String, (String, i64)>,
    local: &HashMap<String, ObservedFile>,
    remote: &HashMap<String, ObservedFile>,
) -> Result<ReconciliationPlan, MappingStoreError> {
    let paths = local
        .keys()
        .chain(remote.keys())
        .chain(baselines.keys())
        .cloned()
        .collect::<BTreeSet<_>>();
    let mut plan = ReconciliationPlan {
        verified_count: 0,
        operations: Vec::new(),
        conflicts: Vec::new(),
    };
    for path in &paths {
        let local_file = local.get(path);
        let remote_file = remote.get(path);
        let baseline = baselines.get(path);
        match (local_file, remote_file) {
            (Some(local_file), Some(remote_file)) if local_file.digest == remote_file.digest => {
                upsert_baseline(
                    transaction,
                    &request.mapping_id,
                    path,
                    &local_file.digest,
                    local_file.size,
                    &request.observed_at,
                )?;
                plan.verified_count += 1;
            }
            (Some(local_file), Some(remote_file)) => plan_divergent_pair(
                path,
                local_file,
                remote_file,
                baseline,
                &request.mode,
                &mut plan.operations,
                &mut plan.conflicts,
            ),
            (Some(file), None) => plan_one_sided(
                path,
                file,
                true,
                baseline.is_some(),
                initialized,
                &request.mode,
                &mut plan,
            ),
            (None, Some(file)) => plan_one_sided(
                path,
                file,
                false,
                baseline.is_some(),
                initialized,
                &request.mode,
                &mut plan,
            ),
            (None, None) => {
                plan.conflicts.push(PlannedConflict {
                    path: path.clone(),
                    kind: ConflictKind::DeletionNotPropagated,
                    local_digest: None,
                    remote_digest: None,
                });
            }
        }
    }
    Ok(plan)
}

fn plan_one_sided(
    path: &str,
    file: &ObservedFile,
    is_local: bool,
    has_baseline: bool,
    initialized: bool,
    mode: &str,
    plan: &mut ReconciliationPlan,
) {
    if has_baseline || !initialized {
        plan.conflicts.push(PlannedConflict {
            path: path.to_owned(),
            kind: if has_baseline {
                ConflictKind::DeletionNotPropagated
            } else {
                ConflictKind::UnbasedDivergence
            },
            local_digest: is_local.then(|| file.digest.clone()),
            remote_digest: (!is_local).then(|| file.digest.clone()),
        });
        return;
    }
    let allowed = (is_local && mode != "receive-only") || (!is_local && mode != "send-only");
    if !allowed {
        plan.conflicts.push(PlannedConflict {
            path: path.to_owned(),
            kind: ConflictKind::DirectionBlocked,
            local_digest: is_local.then(|| file.digest.clone()),
            remote_digest: (!is_local).then(|| file.digest.clone()),
        });
        return;
    }
    plan.operations.push(PlannedOperation {
        path: path.to_owned(),
        direction: if is_local {
            SyncDirection::PushLocal
        } else {
            SyncDirection::PullRemote
        },
        source_digest: file.digest.clone(),
        source_size: file.size,
        expected_destination_digest: None,
    });
}

fn persist_reconciliation(
    transaction: &Transaction<'_>,
    request: &ReconcileRequest,
    operations: &[PlannedOperation],
    conflicts: &[PlannedConflict],
) -> Result<(), MappingStoreError> {
    persist_operations(transaction, request, operations)?;
    persist_conflicts(transaction, request, conflicts)?;
    transaction.execute(
        "INSERT INTO file_sync_mapping_state (mapping_id, initialized_at)
         VALUES (?1, ?2)
         ON CONFLICT(mapping_id) DO NOTHING",
        params![request.mapping_id, request.observed_at],
    )?;
    Ok(())
}

fn persist_operations(
    transaction: &Transaction<'_>,
    request: &ReconcileRequest,
    operations: &[PlannedOperation],
) -> Result<(), MappingStoreError> {
    let existing = read_operations(transaction, &request.mapping_id)?
        .into_iter()
        .map(|operation| {
            (
                (
                    operation.path.clone(),
                    operation.direction.as_str().to_owned(),
                ),
                operation,
            )
        })
        .collect::<HashMap<_, _>>();
    let active_replacement_operation_ids =
        active_replacement_operation_ids(transaction, &request.mapping_id)?;
    let desired_keys = if request.queue_operations {
        operations
            .iter()
            .map(|operation| {
                (
                    operation.path.clone(),
                    operation.direction.as_str().to_owned(),
                )
            })
            .collect::<BTreeSet<_>>()
    } else {
        BTreeSet::new()
    };
    for (key, operation) in &existing {
        if !desired_keys.contains(key) {
            if active_replacement_operation_ids.contains(&operation.id) {
                continue;
            }
            transaction.execute(
                "DELETE FROM file_sync_operations WHERE id = ?1",
                params![operation.id],
            )?;
        }
    }
    if request.queue_operations {
        for operation in operations {
            let key = (
                operation.path.clone(),
                operation.direction.as_str().to_owned(),
            );
            let unchanged = existing.get(&key).is_some_and(|current| {
                current.source_digest == operation.source_digest
                    && current.source_size == operation.source_size
                    && current.expected_destination_digest == operation.expected_destination_digest
            });
            if !unchanged {
                if existing
                    .get(&key)
                    .is_some_and(|current| active_replacement_operation_ids.contains(&current.id))
                {
                    return Err(MappingStoreError::Invalid(
                        "reconciliation cannot replace an operation with an active recovery journal"
                            .to_owned(),
                    ));
                }
                insert_operation(
                    transaction,
                    &request.mapping_id,
                    &request.observed_at,
                    operation,
                )?;
            }
        }
    }
    Ok(())
}

fn active_replacement_operation_ids(
    transaction: &Transaction<'_>,
    mapping_id: &str,
) -> Result<BTreeSet<i64>, MappingStoreError> {
    let mut statement = transaction.prepare(
        "SELECT sync_operation_id FROM file_replacement_journal
         WHERE mapping_id = ?1 AND sync_operation_id IS NOT NULL
           AND state IN ('planned', 'archived', 'installed', 'recovery-required', 'integrity-failed')",
    )?;
    let rows = statement.query_map(params![mapping_id], |row| row.get::<_, i64>(0))?;
    rows.collect::<Result<BTreeSet<_>, _>>().map_err(Into::into)
}

fn has_active_replacement_journal(
    transaction: &Transaction<'_>,
    mapping_id: &str,
) -> Result<bool, MappingStoreError> {
    transaction
        .query_row(
            "SELECT EXISTS(
                SELECT 1 FROM file_replacement_journal
                WHERE mapping_id = ?1
                  AND state IN ('planned', 'archived', 'installed', 'recovery-required', 'integrity-failed')
            )",
            params![mapping_id],
            |row| row.get(0),
        )
        .map_err(Into::into)
}

fn persist_conflicts(
    transaction: &Transaction<'_>,
    request: &ReconcileRequest,
    conflicts: &[PlannedConflict],
) -> Result<(), MappingStoreError> {
    let existing = read_conflicts(transaction, &request.mapping_id)?
        .into_iter()
        .map(|conflict| (conflict.path.clone(), conflict))
        .collect::<HashMap<_, _>>();
    let desired_paths = conflicts
        .iter()
        .map(|conflict| conflict.path.clone())
        .collect::<BTreeSet<_>>();
    for (path, conflict) in &existing {
        if !desired_paths.contains(path) {
            transaction.execute(
                "DELETE FROM file_sync_conflicts WHERE mapping_id = ?1 AND relative_path = ?2",
                params![request.mapping_id, conflict.path],
            )?;
        }
    }
    for conflict in conflicts {
        let unchanged = existing.get(&conflict.path).is_some_and(|current| {
            current.kind == conflict.kind
                && current.local_digest == conflict.local_digest
                && current.remote_digest == conflict.remote_digest
        });
        if unchanged {
            continue;
        }
        transaction.execute(
            "INSERT INTO file_sync_conflicts (
                mapping_id, relative_path, kind, local_digest, remote_digest, detected_at
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6)
            ON CONFLICT(mapping_id, relative_path) DO UPDATE SET
                kind = excluded.kind,
                local_digest = excluded.local_digest,
                remote_digest = excluded.remote_digest,
                detected_at = excluded.detected_at",
            params![
                request.mapping_id,
                conflict.path,
                conflict.kind.as_str(),
                conflict.local_digest,
                conflict.remote_digest,
                request.observed_at,
            ],
        )?;
    }
    Ok(())
}

fn insert_operation(
    transaction: &Transaction<'_>,
    mapping_id: &str,
    created_at: &str,
    operation: &PlannedOperation,
) -> Result<(), MappingStoreError> {
    transaction.execute(
        "INSERT INTO file_sync_operations (
            mapping_id, relative_path, direction, source_digest, source_size,
            expected_destination_digest, status, attempts, last_error, created_at, updated_at
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'pending', 0, NULL, ?7, ?7)
        ON CONFLICT(mapping_id, relative_path, direction) DO UPDATE SET
            source_digest = excluded.source_digest,
            source_size = excluded.source_size,
            expected_destination_digest = excluded.expected_destination_digest,
            status = 'pending', attempts = 0, last_error = NULL,
            created_at = excluded.created_at, updated_at = excluded.updated_at",
        params![
            mapping_id,
            operation.path,
            operation.direction.as_str(),
            operation.source_digest,
            operation.source_size,
            operation.expected_destination_digest,
            created_at,
        ],
    )?;
    Ok(())
}

fn plan_divergent_pair(
    path: &str,
    local: &ObservedFile,
    remote: &ObservedFile,
    baseline: Option<&(String, i64)>,
    mode: &str,
    operations: &mut Vec<PlannedOperation>,
    conflicts: &mut Vec<PlannedConflict>,
) {
    let Some((baseline_digest, _)) = baseline else {
        conflicts.push(PlannedConflict {
            path: path.to_owned(),
            kind: ConflictKind::UnbasedDivergence,
            local_digest: Some(local.digest.clone()),
            remote_digest: Some(remote.digest.clone()),
        });
        return;
    };
    let local_changed = local.digest != *baseline_digest;
    let remote_changed = remote.digest != *baseline_digest;
    if local_changed && remote_changed {
        conflicts.push(PlannedConflict {
            path: path.to_owned(),
            kind: ConflictKind::SimultaneousModification,
            local_digest: Some(local.digest.clone()),
            remote_digest: Some(remote.digest.clone()),
        });
    } else if local_changed {
        if mode == "receive-only" {
            conflicts.push(PlannedConflict {
                path: path.to_owned(),
                kind: ConflictKind::DirectionBlocked,
                local_digest: Some(local.digest.clone()),
                remote_digest: Some(remote.digest.clone()),
            });
        } else {
            operations.push(PlannedOperation {
                path: path.to_owned(),
                direction: SyncDirection::PushLocal,
                source_digest: local.digest.clone(),
                source_size: local.size,
                expected_destination_digest: Some(remote.digest.clone()),
            });
        }
    } else if remote_changed {
        if mode == "send-only" {
            conflicts.push(PlannedConflict {
                path: path.to_owned(),
                kind: ConflictKind::DirectionBlocked,
                local_digest: Some(local.digest.clone()),
                remote_digest: Some(remote.digest.clone()),
            });
        } else {
            operations.push(PlannedOperation {
                path: path.to_owned(),
                direction: SyncDirection::PullRemote,
                source_digest: remote.digest.clone(),
                source_size: remote.size,
                expected_destination_digest: Some(local.digest.clone()),
            });
        }
    }
}

fn validate_reconcile_request(request: &ReconcileRequest) -> Result<(), MappingStoreError> {
    check_identifier("mappingId", &request.mapping_id)?;
    validate_timestamp("observedAt", &request.observed_at)?;
    if !["two-way", "send-only", "receive-only"].contains(&request.mode.as_str()) {
        return Err(MappingStoreError::Invalid(
            "mode must be two-way, send-only, or receive-only".to_owned(),
        ));
    }
    if request.local.len() > MAX_FILES || request.remote.len() > MAX_FILES {
        return Err(MappingStoreError::Invalid(format!(
            "each observation may contain at most {MAX_FILES} files"
        )));
    }
    for file in request.local.iter().chain(&request.remote) {
        validate_path(&file.path)?;
        validate_size(file.size)?;
        validate_digest(&file.digest)?;
    }
    Ok(())
}

struct SealedGenerationMeta {
    revision: i64,
    hash_mode: String,
}

fn sealed_generation_meta(
    transaction: &Transaction<'_>,
    generation_id: &str,
    mapping_id: &str,
) -> Result<SealedGenerationMeta, MappingStoreError> {
    crate::scan_generations::validate_generation_id(generation_id)?;
    let row: Option<(String, i64, String, String)> = transaction
        .query_row(
            "SELECT mapping_id, mapping_revision, hash_mode, state
             FROM scan_generations WHERE generation_id = ?1",
            params![generation_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )
        .optional()?;
    match row {
        Some((owner, revision, hash_mode, state)) => {
            if owner != mapping_id {
                return Err(MappingStoreError::Invalid(
                    "scan generation does not belong to this mapping".to_owned(),
                ));
            }
            if state != "sealed" {
                return Err(MappingStoreError::Invalid(
                    "scan generation is not sealed and complete".to_owned(),
                ));
            }
            Ok(SealedGenerationMeta {
                revision,
                hash_mode,
            })
        }
        None => Err(MappingStoreError::NotFound(format!(
            "scan generation {generation_id}"
        ))),
    }
}

fn validate_generations_request(
    request: &ReconcileGenerationsRequest,
) -> Result<(), MappingStoreError> {
    check_identifier("mappingId", &request.mapping_id)?;
    crate::scan_generations::validate_generation_id(&request.local_generation_id)?;
    crate::scan_generations::validate_generation_id(&request.remote_generation_id)?;
    validate_timestamp("observedAt", &request.observed_at)?;
    if !["two-way", "send-only", "receive-only"].contains(&request.mode.as_str()) {
        return Err(MappingStoreError::Invalid(
            "mode must be two-way, send-only, or receive-only".to_owned(),
        ));
    }
    if request.local_generation_id == request.remote_generation_id {
        return Err(MappingStoreError::Invalid(
            "local and remote generations must differ".to_owned(),
        ));
    }
    Ok(())
}

#[derive(Debug, Clone)]
struct GenerationObserved {
    digest: String,
    size: i64,
}

/// Streams two sealed generations and the baseline in path order, planning
/// without materialising any full set. Baseline advances for identical paths
/// are applied inline within the same transaction.
#[allow(clippy::too_many_lines)]
fn plan_generations_reconciliation(
    transaction: &Transaction<'_>,
    request: &ReconcileGenerationsRequest,
    initialized: bool,
    local_generation: &str,
    remote_generation: &str,
) -> Result<ReconciliationPlan, MappingStoreError> {
    let mut plan = ReconciliationPlan {
        verified_count: 0,
        operations: Vec::new(),
        conflicts: Vec::new(),
    };
    let mut cursor: Option<String> = None;
    loop {
        let (paths, next) = read_distinct_paths_page(
            transaction,
            &request.mapping_id,
            local_generation,
            remote_generation,
            cursor.as_deref(),
            GENERATION_RECONCILE_PAGE,
        )?;
        if paths.is_empty() {
            break;
        }
        for path in &paths {
            let local_file = read_generation_entry(transaction, local_generation, path)?;
            let remote_file = read_generation_entry(transaction, remote_generation, path)?;
            let baseline = read_baseline_entry(transaction, &request.mapping_id, path)?;
            match (local_file, remote_file) {
                (Some(local_file), Some(remote_file))
                    if local_file.digest == remote_file.digest =>
                {
                    upsert_baseline(
                        transaction,
                        &request.mapping_id,
                        path,
                        &local_file.digest,
                        local_file.size,
                        &request.observed_at,
                    )?;
                    plan.verified_count += 1;
                }
                (Some(local_file), Some(remote_file)) => {
                    let local = ObservedFile {
                        path: path.clone(),
                        size: local_file.size,
                        digest: local_file.digest.clone(),
                    };
                    let remote = ObservedFile {
                        path: path.clone(),
                        size: remote_file.size,
                        digest: remote_file.digest.clone(),
                    };
                    plan_divergent_pair(
                        path,
                        &local,
                        &remote,
                        baseline.as_ref(),
                        &request.mode,
                        &mut plan.operations,
                        &mut plan.conflicts,
                    );
                }
                (Some(file), None) => {
                    let observed = ObservedFile {
                        path: path.clone(),
                        size: file.size,
                        digest: file.digest.clone(),
                    };
                    plan_one_sided(
                        path,
                        &observed,
                        true,
                        baseline.is_some(),
                        initialized,
                        &request.mode,
                        &mut plan,
                    );
                }
                (None, Some(file)) => {
                    let observed = ObservedFile {
                        path: path.clone(),
                        size: file.size,
                        digest: file.digest.clone(),
                    };
                    plan_one_sided(
                        path,
                        &observed,
                        false,
                        baseline.is_some(),
                        initialized,
                        &request.mode,
                        &mut plan,
                    );
                }
                (None, None) => {
                    plan.conflicts.push(PlannedConflict {
                        path: path.clone(),
                        kind: ConflictKind::DeletionNotPropagated,
                        local_digest: None,
                        remote_digest: None,
                    });
                }
            }
        }
        match next {
            Some(next_cursor) => cursor = Some(next_cursor),
            None => break,
        }
    }
    Ok(plan)
}

fn read_distinct_paths_page(
    transaction: &Transaction<'_>,
    mapping_id: &str,
    local_generation: &str,
    remote_generation: &str,
    cursor: Option<&str>,
    limit: i64,
) -> Result<(Vec<String>, Option<String>), MappingStoreError> {
    let mut statement = transaction.prepare(
        "SELECT path FROM (
            SELECT relative_path AS path FROM scan_entries WHERE generation_id = ?1
            UNION
            SELECT relative_path AS path FROM scan_entries WHERE generation_id = ?2
            UNION
            SELECT relative_path AS path FROM file_sync_baselines WHERE mapping_id = ?3
        ) WHERE (?4 IS NULL OR path > ?4)
        ORDER BY path LIMIT ?5",
    )?;
    let rows = statement.query_map(
        params![
            local_generation,
            remote_generation,
            mapping_id,
            cursor,
            limit + 1
        ],
        |row| row.get::<_, String>(0),
    )?;
    let mut paths = Vec::new();
    for row in rows {
        paths.push(row?);
    }
    let next = if i64::try_from(paths.len()).unwrap_or(i64::MAX) > limit {
        paths.pop();
        paths.last().cloned()
    } else {
        None
    };
    Ok((paths, next))
}

fn read_generation_entry(
    transaction: &Transaction<'_>,
    generation_id: &str,
    path: &str,
) -> Result<Option<GenerationObserved>, MappingStoreError> {
    let row: Option<(Option<String>, i64)> = transaction
        .query_row(
            "SELECT digest, size FROM scan_entries WHERE generation_id = ?1 AND relative_path = ?2",
            params![generation_id, path],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?;
    match row {
        None => Ok(None),
        Some((None, _)) => Err(MappingStoreError::Invalid(
            "generation reconciliation requires full SHA-256 observations".to_owned(),
        )),
        Some((Some(digest), size)) => {
            validate_digest(&digest)?;
            Ok(Some(GenerationObserved { digest, size }))
        }
    }
}

fn read_baseline_entry(
    transaction: &Transaction<'_>,
    mapping_id: &str,
    path: &str,
) -> Result<Option<(String, i64)>, MappingStoreError> {
    transaction
        .query_row(
            "SELECT digest, size FROM file_sync_baselines WHERE mapping_id = ?1 AND relative_path = ?2",
            params![mapping_id, path],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()
        .map_err(Into::into)
}

fn persist_generations_reconciliation(
    transaction: &Transaction<'_>,
    request: &ReconcileGenerationsRequest,
    operations: &[PlannedOperation],
    conflicts: &[PlannedConflict],
) -> Result<(), MappingStoreError> {
    let proxy = ReconcileRequest {
        mapping_id: request.mapping_id.clone(),
        local: Vec::new(),
        remote: Vec::new(),
        mode: request.mode.clone(),
        observed_at: request.observed_at.clone(),
        queue_operations: request.queue_operations,
    };
    persist_reconciliation(transaction, &proxy, operations, conflicts)
}

pub(crate) fn validate_path(path: &str) -> Result<(), MappingStoreError> {
    if path.is_empty() || path.len() > MAX_PATH_LENGTH || path.contains('\0') {
        return Err(MappingStoreError::Invalid(
            "relative file paths must be non-empty, NUL-free, and at most 4096 bytes".to_owned(),
        ));
    }
    let normalized = path.replace('\\', "/");
    if normalized.starts_with('/')
        || normalized
            .split('/')
            .any(|part| part.is_empty() || part == "." || part == "..")
        || (normalized.len() >= 2 && normalized.as_bytes()[1] == b':')
    {
        return Err(MappingStoreError::Invalid(
            "file paths must remain relative to the approved mapping root".to_owned(),
        ));
    }
    Ok(())
}

pub(crate) fn validate_digest(digest: &str) -> Result<(), MappingStoreError> {
    if digest.len() != 64
        || !digest
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
    {
        return Err(MappingStoreError::Invalid(
            "file digests must be lowercase SHA-256 hex".to_owned(),
        ));
    }
    Ok(())
}

pub(crate) fn validate_size(size: i64) -> Result<(), MappingStoreError> {
    if size < 0 {
        return Err(MappingStoreError::Invalid(
            "file size must not be negative".to_owned(),
        ));
    }
    Ok(())
}

pub(crate) fn validate_timestamp(field: &str, value: &str) -> Result<(), MappingStoreError> {
    OffsetDateTime::parse(value, &Rfc3339).map_err(|error| {
        MappingStoreError::Invalid(format!("{field} must be an RFC 3339 timestamp: {error}"))
    })?;
    Ok(())
}

/// Fails unless the mapping exists and is active: a missing mapping is
/// `NotFound`, one in any other setup state is `Invalid`.
pub(crate) fn require_active_mapping(
    transaction: &Transaction<'_>,
    mapping_id: &str,
) -> Result<(), MappingStoreError> {
    let setup_status: Option<String> = transaction
        .query_row(
            "SELECT setup_status FROM folder_mappings WHERE id = ?1",
            params![mapping_id],
            |row| row.get(0),
        )
        .optional()?;
    match setup_status.as_deref() {
        Some("active") => Ok(()),
        Some(_) => Err(MappingStoreError::Invalid(
            "this operation requires an active mapping".to_owned(),
        )),
        None => Err(MappingStoreError::NotFound(mapping_id.to_owned())),
    }
}

fn observation_map(
    files: &[ObservedFile],
) -> Result<HashMap<String, ObservedFile>, MappingStoreError> {
    let mut result = HashMap::with_capacity(files.len());
    for file in files {
        if result.insert(file.path.clone(), file.clone()).is_some() {
            return Err(MappingStoreError::Invalid(format!(
                "observation contains duplicate path {:?}",
                file.path
            )));
        }
    }
    Ok(result)
}

fn read_baselines(
    transaction: &Transaction<'_>,
    mapping_id: &str,
) -> Result<HashMap<String, (String, i64)>, MappingStoreError> {
    let mut statement = transaction.prepare(
        "SELECT relative_path, digest, size FROM file_sync_baselines WHERE mapping_id = ?1",
    )?;
    let rows = statement.query_map(params![mapping_id], |row| {
        Ok((row.get(0)?, (row.get(1)?, row.get(2)?)))
    })?;
    rows.collect::<Result<HashMap<_, _>, _>>()
        .map_err(Into::into)
}

pub(crate) fn upsert_baseline(
    transaction: &Transaction<'_>,
    mapping_id: &str,
    path: &str,
    digest: &str,
    size: i64,
    verified_at: &str,
) -> Result<(), MappingStoreError> {
    transaction.execute(
        "INSERT INTO file_sync_baselines (mapping_id, relative_path, digest, size, verified_at)
         VALUES (?1, ?2, ?3, ?4, ?5)
         ON CONFLICT(mapping_id, relative_path) DO UPDATE SET
            digest = excluded.digest, size = excluded.size, verified_at = excluded.verified_at
         WHERE file_sync_baselines.digest <> excluded.digest
            OR file_sync_baselines.size <> excluded.size",
        params![mapping_id, path, digest, size, verified_at],
    )?;
    Ok(())
}

fn installed_replacement_entry(
    transaction: &Transaction<'_>,
    operation: &SyncOperation,
    entry_id: Option<&str>,
) -> Result<Option<String>, MappingStoreError> {
    if operation.direction != SyncDirection::PullRemote
        || operation.expected_destination_digest.is_none()
    {
        return Ok(None);
    }
    let id =
        require_installed_sync_entry(transaction, entry_id, operation.id)?.ok_or_else(|| {
            MappingStoreError::Invalid(
                "a replacing operation requires an installed archive journal".to_owned(),
            )
        })?;
    Ok(Some(id))
}

fn operation_by_id(
    connection: &Transaction<'_>,
    operation_id: i64,
) -> Result<Option<SyncOperation>, MappingStoreError> {
    connection
        .query_row(
            "SELECT id, mapping_id, relative_path, direction, source_digest, source_size,
                    expected_destination_digest, status, attempts, last_error, created_at, updated_at
             FROM file_sync_operations WHERE id = ?1",
            params![operation_id],
            operation_from_row,
        )
        .optional()
        .map_err(Into::into)
}

fn read_operations(
    connection: &rusqlite::Connection,
    mapping_id: &str,
) -> Result<Vec<SyncOperation>, MappingStoreError> {
    let mut statement = connection.prepare(
        "SELECT id, mapping_id, relative_path, direction, source_digest, source_size,
                expected_destination_digest, status, attempts, last_error, created_at, updated_at
         FROM file_sync_operations WHERE mapping_id = ?1 ORDER BY id",
    )?;
    let rows = statement.query_map(params![mapping_id], operation_from_row)?;
    rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
}

fn operation_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<SyncOperation> {
    let direction: String = row.get(3)?;
    Ok(SyncOperation {
        id: row.get(0)?,
        mapping_id: row.get(1)?,
        path: row.get(2)?,
        direction: SyncDirection::parse(&direction).map_err(|error| {
            rusqlite::Error::FromSqlConversionFailure(
                3,
                rusqlite::types::Type::Text,
                Box::new(error),
            )
        })?,
        source_digest: row.get(4)?,
        source_size: row.get(5)?,
        expected_destination_digest: row.get(6)?,
        status: row.get(7)?,
        attempts: row.get(8)?,
        last_error: row.get(9)?,
        created_at: row.get(10)?,
        updated_at: row.get(11)?,
    })
}

fn read_conflicts(
    connection: &rusqlite::Connection,
    mapping_id: &str,
) -> Result<Vec<SyncConflict>, MappingStoreError> {
    let mut statement = connection.prepare(
        "SELECT mapping_id, relative_path, kind, local_digest, remote_digest, detected_at
         FROM file_sync_conflicts WHERE mapping_id = ?1 ORDER BY relative_path",
    )?;
    let rows = statement.query_map(params![mapping_id], |row| {
        let kind: String = row.get(2)?;
        Ok(SyncConflict {
            mapping_id: row.get(0)?,
            path: row.get(1)?,
            kind: ConflictKind::parse(&kind).map_err(|error| {
                rusqlite::Error::FromSqlConversionFailure(
                    2,
                    rusqlite::types::Type::Text,
                    Box::new(error),
                )
            })?,
            local_digest: row.get(3)?,
            remote_digest: row.get(4)?,
            detected_at: row.get(5)?,
        })
    })?;
    rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::mapping::{LegacyImportRequest, MappingConfiguration};
    use crate::version_archive::PrepareReplacementRequest;

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

    fn file(path: &str, digest_byte: char) -> ObservedFile {
        ObservedFile {
            path: path.to_owned(),
            size: 4,
            digest: digest_byte.to_string().repeat(64),
        }
    }

    fn reconcile(
        store: &MappingStore,
        local: Vec<ObservedFile>,
        remote: Vec<ObservedFile>,
    ) -> ReconcileResult {
        store
            .reconcile_files(&ReconcileRequest {
                mapping_id: "mapping-1".to_owned(),
                local,
                remote,
                mode: "two-way".to_owned(),
                observed_at: NOW.to_owned(),
                queue_operations: true,
            })
            .expect("reconcile")
    }

    fn apply_verified(
        store: &MappingStore,
        operation_id: i64,
        path: &str,
        digest: &str,
        replacement_journal_id: Option<&str>,
    ) -> Result<FileSyncState, MappingStoreError> {
        store.apply_verified_file(&ApplyVerifiedFileRequest {
            operation_id,
            mapping_id: "mapping-1".to_owned(),
            path: path.to_owned(),
            digest: digest.to_owned(),
            size: 4,
            verified_at: NOW.to_owned(),
            replacement_journal_id: replacement_journal_id.map(str::to_owned),
        })
    }

    fn assert_no_conflicts(store: &MappingStore, participant: &str) {
        assert!(
            store
                .file_sync_state("mapping-1")
                .unwrap_or_else(|error| panic!("read {participant} state: {error}"))
                .conflicts
                .is_empty(),
            "{participant} retained a conflict after exact completion"
        );
    }

    #[test]
    fn identical_files_seed_a_verified_baseline() {
        let store = active_store();
        let result = reconcile(
            &store,
            vec![file("same.txt", 'a')],
            vec![file("same.txt", 'a')],
        );
        assert_eq!(result.baseline_count, 1);
        assert!(result.operations.is_empty());
        assert!(result.conflicts.is_empty());
    }

    #[test]
    fn first_observation_never_guesses_that_a_one_sided_file_is_new() {
        let store = active_store();
        let result = reconcile(&store, vec![file("legacy.txt", 'a')], Vec::new());
        assert!(result.operations.is_empty());
        assert_eq!(result.conflicts.len(), 1);
        assert_eq!(result.conflicts[0].kind, ConflictKind::UnbasedDivergence);

        let result = reconcile(
            &store,
            vec![file("legacy.txt", 'a'), file("new.txt", 'b')],
            vec![file("legacy.txt", 'a')],
        );
        assert_eq!(result.operations.len(), 1);
        assert_eq!(result.operations[0].path, "new.txt");
    }

    #[test]
    fn a_one_sided_change_from_baseline_becomes_a_durable_operation() {
        let store = active_store();
        reconcile(
            &store,
            vec![file("notes.txt", 'a')],
            vec![file("notes.txt", 'a')],
        );
        let result = reconcile(
            &store,
            vec![file("notes.txt", 'b')],
            vec![file("notes.txt", 'a')],
        );
        assert_eq!(result.operations.len(), 1);
        assert_eq!(result.operations[0].direction, SyncDirection::PushLocal);
        let original_digest = "a".repeat(64);
        assert_eq!(
            result.operations[0].expected_destination_digest.as_deref(),
            Some(original_digest.as_str())
        );

        let reopened_state = store.file_sync_state("mapping-1").expect("state");
        assert_eq!(reopened_state.operations, result.operations);
    }

    #[test]
    fn a_new_file_on_the_non_authoritative_side_is_a_durable_direction_conflict() {
        for (mode, local, remote, expected_local_digest, expected_remote_digest) in [
            (
                "receive-only",
                vec![file("seed.txt", 'a'), file("destination-only.txt", 'b')],
                vec![file("seed.txt", 'a')],
                Some("b".repeat(64)),
                None,
            ),
            (
                "send-only",
                vec![file("seed.txt", 'a')],
                vec![file("seed.txt", 'a'), file("destination-only.txt", 'c')],
                None,
                Some("c".repeat(64)),
            ),
        ] {
            let store = active_store();
            reconcile(
                &store,
                vec![file("seed.txt", 'a')],
                vec![file("seed.txt", 'a')],
            );

            let result = store
                .reconcile_files(&ReconcileRequest {
                    mapping_id: "mapping-1".to_owned(),
                    local,
                    remote,
                    mode: mode.to_owned(),
                    observed_at: NOW.to_owned(),
                    queue_operations: true,
                })
                .expect("reconcile non-authoritative one-way addition");

            assert!(result.operations.is_empty());
            assert_eq!(result.conflicts.len(), 1);
            assert_eq!(result.conflicts[0].kind, ConflictKind::DirectionBlocked);
            assert_eq!(result.conflicts[0].local_digest, expected_local_digest);
            assert_eq!(result.conflicts[0].remote_digest, expected_remote_digest);

            let durable = store.file_sync_state("mapping-1").expect("durable state");
            assert_eq!(durable.conflicts, result.conflicts);
        }
    }

    #[test]
    fn a_new_file_on_the_authoritative_side_still_queues_one_way_transfer() {
        for (mode, local, remote, expected_direction) in [
            (
                "send-only",
                vec![file("seed.txt", 'a'), file("source.txt", 'b')],
                vec![file("seed.txt", 'a')],
                SyncDirection::PushLocal,
            ),
            (
                "receive-only",
                vec![file("seed.txt", 'a')],
                vec![file("seed.txt", 'a'), file("source.txt", 'b')],
                SyncDirection::PullRemote,
            ),
        ] {
            let store = active_store();
            reconcile(
                &store,
                vec![file("seed.txt", 'a')],
                vec![file("seed.txt", 'a')],
            );

            let result = store
                .reconcile_files(&ReconcileRequest {
                    mapping_id: "mapping-1".to_owned(),
                    local,
                    remote,
                    mode: mode.to_owned(),
                    observed_at: NOW.to_owned(),
                    queue_operations: true,
                })
                .expect("reconcile authoritative one-way addition");

            assert!(result.conflicts.is_empty());
            assert_eq!(result.operations.len(), 1);
            assert_eq!(result.operations[0].direction, expected_direction);
            assert_eq!(result.operations[0].path, "source.txt");
        }
    }

    #[test]
    fn unchanged_reconciliation_preserves_retry_and_conflict_metadata() {
        let store = active_store();
        reconcile(
            &store,
            vec![file("notes.txt", 'a'), file("conflict.txt", 'a')],
            vec![file("notes.txt", 'a'), file("conflict.txt", 'a')],
        );
        let first = reconcile(
            &store,
            vec![file("notes.txt", 'b'), file("conflict.txt", 'b')],
            vec![file("notes.txt", 'a'), file("conflict.txt", 'c')],
        );
        store
            .fail_file_operation(
                first.operations[0].id,
                "peer offline",
                "2026-08-08T12:01:00Z",
            )
            .expect("record failure");

        let repeated = store
            .reconcile_files(&ReconcileRequest {
                mapping_id: "mapping-1".to_owned(),
                local: vec![file("notes.txt", 'b'), file("conflict.txt", 'b')],
                remote: vec![file("notes.txt", 'a'), file("conflict.txt", 'c')],
                mode: "two-way".to_owned(),
                observed_at: "2026-08-08T13:00:00Z".to_owned(),
                queue_operations: true,
            })
            .expect("repeat reconciliation");

        assert_eq!(repeated.operations[0].id, first.operations[0].id);
        assert_eq!(repeated.operations[0].attempts, 1);
        assert_eq!(repeated.operations[0].status, "failed");
        assert_eq!(repeated.conflicts[0].detected_at, NOW);
    }

    #[test]
    fn simultaneous_changes_are_conflicts_and_never_operations() {
        let store = active_store();
        reconcile(
            &store,
            vec![file("notes.txt", 'a')],
            vec![file("notes.txt", 'a')],
        );
        let result = reconcile(
            &store,
            vec![file("notes.txt", 'b')],
            vec![file("notes.txt", 'c')],
        );
        assert!(result.operations.is_empty());
        assert_eq!(
            result.conflicts[0].kind,
            ConflictKind::SimultaneousModification
        );
    }

    #[test]
    fn an_explicit_exact_conflict_choice_becomes_durable_retryable_work() {
        let store = active_store();
        reconcile(
            &store,
            vec![file("notes.txt", 'a')],
            vec![file("notes.txt", 'a')],
        );
        reconcile(
            &store,
            vec![file("notes.txt", 'b')],
            vec![file("notes.txt", 'c')],
        );

        let resolved = store
            .resolve_file_conflict(&ResolveConflictRequest {
                mapping_id: "mapping-1".to_owned(),
                path: "notes.txt".to_owned(),
                direction: SyncDirection::PushLocal,
                local_digest: "b".repeat(64),
                local_size: 4,
                remote_digest: "c".repeat(64),
                remote_size: 4,
                requested_at: "2026-08-08T12:01:00Z".to_owned(),
            })
            .expect("resolve exact conflict");

        assert_eq!(resolved.operations.len(), 1);
        assert_eq!(resolved.operations[0].direction, SyncDirection::PushLocal);
        assert_eq!(resolved.operations[0].source_digest, "b".repeat(64));
        assert_eq!(
            resolved.operations[0].expected_destination_digest,
            Some("c".repeat(64))
        );
        assert_eq!(resolved.conflicts.len(), 1);

        let repeated = store
            .resolve_file_conflict(&ResolveConflictRequest {
                mapping_id: "mapping-1".to_owned(),
                path: "notes.txt".to_owned(),
                direction: SyncDirection::PushLocal,
                local_digest: "b".repeat(64),
                local_size: 4,
                remote_digest: "c".repeat(64),
                remote_size: 4,
                requested_at: "2026-08-08T12:02:00Z".to_owned(),
            })
            .expect("repeat exact resolution");
        assert_eq!(repeated.operations[0].id, resolved.operations[0].id);
    }

    #[test]
    fn conflict_resolution_rejects_stale_or_missing_versions() {
        let store = active_store();
        reconcile(
            &store,
            vec![file("notes.txt", 'b')],
            vec![file("notes.txt", 'c')],
        );

        let stale = store.resolve_file_conflict(&ResolveConflictRequest {
            mapping_id: "mapping-1".to_owned(),
            path: "notes.txt".to_owned(),
            direction: SyncDirection::PullRemote,
            local_digest: "d".repeat(64),
            local_size: 4,
            remote_digest: "c".repeat(64),
            remote_size: 4,
            requested_at: "2026-08-08T12:01:00Z".to_owned(),
        });
        assert!(stale.is_err());

        let one_sided = active_store();
        reconcile(&one_sided, vec![file("only-here.txt", 'a')], Vec::new());
        let missing = one_sided.resolve_file_conflict(&ResolveConflictRequest {
            mapping_id: "mapping-1".to_owned(),
            path: "only-here.txt".to_owned(),
            direction: SyncDirection::PushLocal,
            local_digest: "a".repeat(64),
            local_size: 4,
            remote_digest: "b".repeat(64),
            remote_size: 4,
            requested_at: "2026-08-08T12:01:00Z".to_owned(),
        });
        assert!(missing.is_err());
    }

    #[test]
    fn incoming_application_requires_exact_durable_work_or_an_identical_baseline() {
        let store = active_store();
        reconcile(&store, Vec::new(), Vec::new());
        reconcile(&store, Vec::new(), vec![file("remote.txt", 'b')]);

        let authorized = store
            .authorize_file_application(&AuthorizeFileApplicationRequest {
                mapping_id: "mapping-1".to_owned(),
                path: "remote.txt".to_owned(),
                digest: "b".repeat(64),
                size: 4,
                expected_destination_digest: None,
            })
            .expect("exact durable pull is authorized");
        assert!(!authorized.already_verified);
        assert!(authorized.operation_id.is_some());

        let unauthorized = store.authorize_file_application(&AuthorizeFileApplicationRequest {
            mapping_id: "mapping-1".to_owned(),
            path: "remote.txt".to_owned(),
            digest: "c".repeat(64),
            size: 4,
            expected_destination_digest: None,
        });
        assert!(unauthorized.is_err());

        let operation_id = authorized.operation_id.expect("authorized operation id");
        let wrong_operation = apply_verified(
            &store,
            operation_id + 1,
            "remote.txt",
            &"b".repeat(64),
            None,
        );
        assert!(wrong_operation.is_err());
        assert_eq!(
            store
                .file_sync_state("mapping-1")
                .expect("state after rejected acknowledgement")
                .operations[0]
                .id,
            operation_id
        );

        apply_verified(&store, operation_id, "remote.txt", &"b".repeat(64), None)
            .expect("record verified incoming file");
        let repeated = store
            .authorize_file_application(&AuthorizeFileApplicationRequest {
                mapping_id: "mapping-1".to_owned(),
                path: "remote.txt".to_owned(),
                digest: "b".repeat(64),
                size: 4,
                expected_destination_digest: None,
            })
            .expect("lost acknowledgement is idempotent");
        assert!(repeated.already_verified);
        assert_eq!(repeated.operation_id, None);
    }

    #[test]
    fn recovery_issue_blocks_reconciliation_without_orphaning_its_operation() {
        let store = active_store();
        reconcile(
            &store,
            vec![file("notes.txt", 'a')],
            vec![file("notes.txt", 'a')],
        );
        let pending = reconcile(
            &store,
            vec![file("notes.txt", 'a')],
            vec![file("notes.txt", 'b')],
        );
        let operation = pending.operations[0].clone();
        store
            .prepare_replacement(&PrepareReplacementRequest {
                id: "replacement-recovery-1".to_owned(),
                mapping_id: "mapping-1".to_owned(),
                path: "notes.txt".to_owned(),
                sync_operation_id: Some(operation.id),
                old_digest: "a".repeat(64),
                old_size: 4,
                replacement_digest: "b".repeat(64),
                replacement_size: 4,
                local_root: "/tmp/a".to_owned(),
                created_at: NOW.to_owned(),
            })
            .expect("prepare replacement");
        store
            .record_replacement_issue(
                "replacement-recovery-1",
                false,
                "installation interrupted",
                NOW,
            )
            .expect("record recovery issue");

        let result = store.reconcile_files(&ReconcileRequest {
            mapping_id: "mapping-1".to_owned(),
            local: vec![file("notes.txt", 'c')],
            remote: vec![file("notes.txt", 'c')],
            mode: "two-way".to_owned(),
            observed_at: NOW.to_owned(),
            queue_operations: true,
        });
        assert!(result.is_err());

        let state = store.file_sync_state("mapping-1").expect("state");
        assert_eq!(state.operations, vec![operation]);
        assert_eq!(state.recovery_issues.len(), 1);
    }

    #[test]
    fn mirrored_two_peer_choice_archives_the_receiver_and_clears_both_conflicts() {
        let coordinator = active_store();
        let peer = active_store();
        reconcile(
            &coordinator,
            vec![file("notes.txt", 'a')],
            vec![file("notes.txt", 'a')],
        );
        reconcile(
            &peer,
            vec![file("notes.txt", 'a')],
            vec![file("notes.txt", 'a')],
        );
        reconcile(
            &coordinator,
            vec![file("notes.txt", 'b')],
            vec![file("notes.txt", 'c')],
        );
        reconcile(
            &peer,
            vec![file("notes.txt", 'c')],
            vec![file("notes.txt", 'b')],
        );

        let coordinator_state = coordinator
            .resolve_file_conflict(&ResolveConflictRequest {
                mapping_id: "mapping-1".to_owned(),
                path: "notes.txt".to_owned(),
                direction: SyncDirection::PushLocal,
                local_digest: "b".repeat(64),
                local_size: 4,
                remote_digest: "c".repeat(64),
                remote_size: 4,
                requested_at: NOW.to_owned(),
            })
            .expect("record coordinator choice");
        let peer_state = peer
            .resolve_file_conflict(&ResolveConflictRequest {
                mapping_id: "mapping-1".to_owned(),
                path: "notes.txt".to_owned(),
                direction: SyncDirection::PullRemote,
                local_digest: "c".repeat(64),
                local_size: 4,
                remote_digest: "b".repeat(64),
                remote_size: 4,
                requested_at: NOW.to_owned(),
            })
            .expect("record mirrored peer choice");
        let peer_operation = &peer_state.operations[0];
        let authorization = peer
            .authorize_file_application(&AuthorizeFileApplicationRequest {
                mapping_id: "mapping-1".to_owned(),
                path: "notes.txt".to_owned(),
                digest: "b".repeat(64),
                size: 4,
                expected_destination_digest: Some("c".repeat(64)),
            })
            .expect("authorize mirrored incoming replacement");
        assert_eq!(authorization.operation_id, Some(peer_operation.id));

        let journal = peer
            .prepare_replacement(&PrepareReplacementRequest {
                id: "peer-replacement-1".to_owned(),
                mapping_id: "mapping-1".to_owned(),
                path: "notes.txt".to_owned(),
                sync_operation_id: authorization.operation_id,
                old_digest: "c".repeat(64),
                old_size: 4,
                replacement_digest: "b".repeat(64),
                replacement_size: 4,
                local_root: "/tmp/b".to_owned(),
                created_at: NOW.to_owned(),
            })
            .expect("prepare receiver archive");
        peer.mark_replacement_archived(
            &journal.id,
            &"c".repeat(64),
            4,
            &format!("sha256/cc/{}", "c".repeat(64)),
            NOW,
        )
        .expect("archive displaced peer copy");
        peer.mark_replacement_installed(&journal.id, NOW)
            .expect("install selected copy");
        apply_verified(
            &peer,
            peer_operation.id,
            "notes.txt",
            &"b".repeat(64),
            Some(&journal.id),
        )
        .expect("complete receiver replacement");
        coordinator
            .complete_file_operation(
                coordinator_state.operations[0].id,
                &"b".repeat(64),
                4,
                NOW,
                None,
            )
            .expect("complete coordinator operation");

        assert_no_conflicts(&coordinator, "coordinator");
        assert_no_conflicts(&peer, "peer");
    }

    #[test]
    fn a_missing_baseline_never_guesses_between_different_existing_files() {
        let store = active_store();
        let result = reconcile(
            &store,
            vec![file("notes.txt", 'b')],
            vec![file("notes.txt", 'c')],
        );
        assert!(result.operations.is_empty());
        assert_eq!(result.conflicts[0].kind, ConflictKind::UnbasedDivergence);
    }

    #[test]
    fn deletion_is_surfaced_without_recreating_or_removing_a_file() {
        let store = active_store();
        reconcile(
            &store,
            vec![file("notes.txt", 'a')],
            vec![file("notes.txt", 'a')],
        );
        let result = reconcile(&store, vec![file("notes.txt", 'a')], Vec::new());
        assert!(result.operations.is_empty());
        assert_eq!(
            result.conflicts[0].kind,
            ConflictKind::DeletionNotPropagated
        );
    }

    #[test]
    fn bilateral_deletion_keeps_a_tombstone_like_baseline_and_blocks_resurrection() {
        let store = active_store();
        reconcile(
            &store,
            vec![file("old.txt", 'a')],
            vec![file("old.txt", 'a')],
        );
        let deleted = reconcile(&store, Vec::new(), Vec::new());
        assert_eq!(deleted.conflicts.len(), 1);
        assert_eq!(
            deleted.conflicts[0].kind,
            ConflictKind::DeletionNotPropagated
        );

        let restored = reconcile(&store, vec![file("old.txt", 'a')], Vec::new());
        assert!(restored.operations.is_empty());
        assert_eq!(restored.conflicts.len(), 1);
    }

    #[test]
    fn completion_advances_baseline_and_clears_the_operation() {
        let store = active_store();
        reconcile(
            &store,
            vec![file("notes.txt", 'a')],
            vec![file("notes.txt", 'a')],
        );
        let plan = reconcile(
            &store,
            vec![file("notes.txt", 'b')],
            vec![file("notes.txt", 'a')],
        );
        let operation = &plan.operations[0];
        assert_eq!(operation.direction, SyncDirection::PushLocal);
        let acknowledgement = store
            .complete_file_operation(operation.id, &"b".repeat(64), 4, NOW, None)
            .expect("complete");
        assert_eq!(acknowledgement.mapping_id, "mapping-1");
        let state = store.file_sync_state("mapping-1").expect("state");
        assert!(state.operations.is_empty());
        assert!(state.conflicts.is_empty());
    }

    #[test]
    fn tombstoning_a_mapping_cascades_file_sync_metadata() {
        let store = active_store();
        reconcile(
            &store,
            vec![file("notes.txt", 'a')],
            vec![file("notes.txt", 'a')],
        );
        store
            .remove_local("mapping-1", "a-device", None, 1, NOW)
            .expect("remove mapping");
        let state = store.file_sync_state("mapping-1").expect("empty state");
        assert!(!state.initialized);
        assert_eq!(state.baseline_count, 0);
        assert!(state.operations.is_empty());
        assert!(state.conflicts.is_empty());
    }
}
