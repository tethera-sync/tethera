//! Durable verified-file baselines, reconciliation conflicts, and retryable transfer work.

use std::collections::{BTreeSet, HashMap};

use rusqlite::{OptionalExtension, Transaction, TransactionBehavior, params};
use serde::{Deserialize, Serialize};
use time::OffsetDateTime;
use time::format_description::well_known::Rfc3339;

use crate::mapping::{MappingStore, MappingStoreError, check_identifier};

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

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReconcileResult {
    pub mapping_id: String,
    pub initialized: bool,
    pub baseline_count: i64,
    pub verified_count: usize,
    pub operations: Vec<SyncOperation>,
    pub conflicts: Vec<SyncConflict>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileSyncState {
    pub mapping_id: String,
    pub initialized: bool,
    pub baseline_count: i64,
    pub operations: Vec<SyncOperation>,
    pub conflicts: Vec<SyncConflict>,
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
            })
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
        Ok(FileSyncState {
            mapping_id: mapping_id.to_owned(),
            initialized,
            baseline_count,
            operations,
            conflicts,
        })
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
        mapping_id: &str,
        path: &str,
        digest: &str,
        size: i64,
        verified_at: &str,
    ) -> Result<FileSyncState, MappingStoreError> {
        self.ensure_import_completed()?;
        check_identifier("mappingId", mapping_id)?;
        validate_path(path)?;
        validate_digest(digest)?;
        validate_size(size)?;
        validate_timestamp("verifiedAt", verified_at)?;
        let transaction =
            Transaction::new_unchecked(&self.connection, TransactionBehavior::Immediate)?;
        require_active_mapping(&transaction, mapping_id)?;
        upsert_baseline(&transaction, mapping_id, path, digest, size, verified_at)?;
        transaction.execute(
            "DELETE FROM file_sync_operations WHERE mapping_id = ?1 AND relative_path = ?2",
            params![mapping_id, path],
        )?;
        transaction.execute(
            "DELETE FROM file_sync_conflicts WHERE mapping_id = ?1 AND relative_path = ?2",
            params![mapping_id, path],
        )?;
        transaction.commit()?;
        self.file_sync_state(mapping_id)
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
                insert_operation(transaction, request, operation)?;
            }
        }
    }
    Ok(())
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
    request: &ReconcileRequest,
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
            request.mapping_id,
            operation.path,
            operation.direction.as_str(),
            operation.source_digest,
            operation.source_size,
            operation.expected_destination_digest,
            request.observed_at,
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

fn validate_path(path: &str) -> Result<(), MappingStoreError> {
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

fn validate_digest(digest: &str) -> Result<(), MappingStoreError> {
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

fn validate_size(size: i64) -> Result<(), MappingStoreError> {
    if size < 0 {
        return Err(MappingStoreError::Invalid(
            "file size must not be negative".to_owned(),
        ));
    }
    Ok(())
}

fn validate_timestamp(field: &str, value: &str) -> Result<(), MappingStoreError> {
    OffsetDateTime::parse(value, &Rfc3339).map_err(|error| {
        MappingStoreError::Invalid(format!("{field} must be an RFC 3339 timestamp: {error}"))
    })?;
    Ok(())
}

fn require_active_mapping(
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
            "continuous reconciliation requires an active mapping".to_owned(),
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

fn upsert_baseline(
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
        let acknowledgement = store
            .complete_file_operation(plan.operations[0].id, &"b".repeat(64), 4, NOW)
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
