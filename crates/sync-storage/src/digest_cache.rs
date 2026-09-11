//! Rust-owned SQLite scan digest cache: a derived performance cache the
//! desktop scanner may consult to skip re-hashing an unchanged file.
//!
//! This table is not authoritative sync state. Losing it only costs
//! re-hashing on the next scan. Identity fields (`device`, `inode`,
//! `modifiedNs`, `changedNs`) are exact decimal renderings of values that can
//! exceed i64/f64 precision on some platforms, so they are stored and
//! returned as text, never parsed into integers. Trusting a cached digest
//! against the current filesystem state is a decision the desktop makes; the
//! engine only stores and returns exact values.

use rusqlite::{OptionalExtension, Transaction, TransactionBehavior, params};
use serde::{Deserialize, Serialize};

use crate::file_sync::require_active_mapping;
use crate::mapping::{MappingStore, MappingStoreError, check_identifier};

pub const MAX_BATCH_ENTRIES: usize = 1_000;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CachedDigestEntry {
    pub path: String,
    pub device: String,
    pub inode: String,
    pub size: i64,
    pub modified_ns: String,
    pub changed_ns: String,
    pub digest: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DigestCacheLookupRequest {
    pub mapping_id: String,
    pub paths: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DigestCacheLookupResult {
    pub entries: Vec<CachedDigestEntry>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DigestCacheRecordRequest {
    pub mapping_id: String,
    pub sweep_id: String,
    pub entries: Vec<CachedDigestEntry>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DigestCacheRecordResult {
    pub recorded: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DigestCachePruneRequest {
    pub mapping_id: String,
    pub keep_sweep_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DigestCachePruneResult {
    pub removed: i64,
}

/// Exact decimal digit string used for device/inode/timestamp identity
/// fields. An optional leading `-` is permitted so signed nanosecond
/// timestamps round-trip; device and inode never carry a sign.
fn validate_decimal_identity(
    field: &str,
    value: &str,
    allow_negative: bool,
) -> Result<(), MappingStoreError> {
    let digits = if allow_negative {
        value.strip_prefix('-').unwrap_or(value)
    } else {
        value
    };
    let invalid =
        digits.is_empty() || digits.len() > 20 || !digits.bytes().all(|byte| byte.is_ascii_digit());
    if invalid {
        return Err(MappingStoreError::Invalid(format!(
            "{field} must be 1 to 20 ASCII decimal digits{}",
            if allow_negative {
                " with an optional leading '-'"
            } else {
                ""
            }
        )));
    }
    Ok(())
}

fn validate_cached_digest_entry(entry: &CachedDigestEntry) -> Result<(), MappingStoreError> {
    crate::file_sync::validate_path(&entry.path)?;
    crate::file_sync::validate_size(entry.size)?;
    crate::file_sync::validate_digest(&entry.digest)?;
    validate_decimal_identity("device", &entry.device, false)?;
    validate_decimal_identity("inode", &entry.inode, false)?;
    validate_decimal_identity("modifiedNs", &entry.modified_ns, true)?;
    validate_decimal_identity("changedNs", &entry.changed_ns, true)?;
    Ok(())
}

fn reject_duplicate_paths<'a>(
    paths: impl Iterator<Item = &'a str>,
) -> Result<(), MappingStoreError> {
    let mut seen = std::collections::HashSet::new();
    for path in paths {
        if !seen.insert(path) {
            return Err(MappingStoreError::Invalid(format!(
                "batch contains duplicate path {path:?}"
            )));
        }
    }
    Ok(())
}

impl MappingStore {
    /// Looks up cached digest rows for the given paths under one mapping.
    ///
    /// Only paths with a stored row are returned; the order is unspecified.
    ///
    /// # Errors
    ///
    /// Returns a validation, mapping-state, or database error.
    pub fn lookup_digest_cache(
        &self,
        request: &DigestCacheLookupRequest,
    ) -> Result<DigestCacheLookupResult, MappingStoreError> {
        self.ensure_import_completed()?;
        check_identifier("mappingId", &request.mapping_id)?;
        if request.paths.is_empty() || request.paths.len() > MAX_BATCH_ENTRIES {
            return Err(MappingStoreError::Invalid(format!(
                "lookup accepts 1 to {MAX_BATCH_ENTRIES} paths"
            )));
        }
        for path in &request.paths {
            crate::file_sync::validate_path(path)?;
        }
        reject_duplicate_paths(request.paths.iter().map(String::as_str))?;

        let transaction =
            Transaction::new_unchecked(&self.connection, TransactionBehavior::Immediate)?;
        require_active_mapping(&transaction, &request.mapping_id)?;
        let mut entries = Vec::with_capacity(request.paths.len());
        {
            let mut statement = transaction.prepare(
                "SELECT relative_path, device, inode, size, modified_ns, changed_ns, digest
                 FROM scan_digest_cache
                 WHERE mapping_id = ?1 AND relative_path = ?2",
            )?;
            for path in &request.paths {
                let found = statement
                    .query_row(params![request.mapping_id, path], |row| {
                        Ok(CachedDigestEntry {
                            path: row.get(0)?,
                            device: row.get(1)?,
                            inode: row.get(2)?,
                            size: row.get(3)?,
                            modified_ns: row.get(4)?,
                            changed_ns: row.get(5)?,
                            digest: row.get(6)?,
                        })
                    })
                    .optional()?;
                if let Some(entry) = found {
                    validate_cached_digest_entry(&entry).map_err(|error| {
                        MappingStoreError::CorruptMetadata {
                            id: request.mapping_id.clone(),
                            detail: format!(
                                "scan digest cache row for {path:?} is invalid: {error}"
                            ),
                        }
                    })?;
                    entries.push(entry);
                }
            }
        }
        transaction.commit()?;
        Ok(DigestCacheLookupResult { entries })
    }

    /// Upserts a batch of cached digest rows for one mapping and sweep.
    ///
    /// # Errors
    ///
    /// Returns a validation, mapping-state, or database error without
    /// committing a partial batch.
    pub fn record_digest_cache(
        &self,
        request: &DigestCacheRecordRequest,
    ) -> Result<DigestCacheRecordResult, MappingStoreError> {
        self.ensure_import_completed()?;
        check_identifier("mappingId", &request.mapping_id)?;
        check_identifier("sweepId", &request.sweep_id)?;
        if request.entries.is_empty() || request.entries.len() > MAX_BATCH_ENTRIES {
            return Err(MappingStoreError::Invalid(format!(
                "record accepts 1 to {MAX_BATCH_ENTRIES} entries"
            )));
        }
        for entry in &request.entries {
            validate_cached_digest_entry(entry)?;
        }
        reject_duplicate_paths(request.entries.iter().map(|entry| entry.path.as_str()))?;

        let transaction =
            Transaction::new_unchecked(&self.connection, TransactionBehavior::Immediate)?;
        require_active_mapping(&transaction, &request.mapping_id)?;
        for entry in &request.entries {
            transaction.execute(
                "INSERT INTO scan_digest_cache (
                    mapping_id, relative_path, device, inode, size, modified_ns, changed_ns, digest, sweep_id
                 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
                 ON CONFLICT(mapping_id, relative_path) DO UPDATE SET
                    device = excluded.device,
                    inode = excluded.inode,
                    size = excluded.size,
                    modified_ns = excluded.modified_ns,
                    changed_ns = excluded.changed_ns,
                    digest = excluded.digest,
                    sweep_id = excluded.sweep_id",
                params![
                    request.mapping_id,
                    entry.path,
                    entry.device,
                    entry.inode,
                    entry.size,
                    entry.modified_ns,
                    entry.changed_ns,
                    entry.digest,
                    request.sweep_id,
                ],
            )?;
        }
        transaction.commit()?;
        Ok(DigestCacheRecordResult {
            recorded: i64::try_from(request.entries.len()).unwrap_or(i64::MAX),
        })
    }

    /// Deletes a mapping's cached rows left over from a prior sweep token.
    ///
    /// The desktop calls this only after a complete sweep that re-recorded
    /// every eligible file, so pruning by token stays correct even across a
    /// wall-clock jump.
    ///
    /// # Errors
    ///
    /// Returns a validation, mapping-state, or database error.
    pub fn prune_digest_cache(
        &self,
        request: &DigestCachePruneRequest,
    ) -> Result<DigestCachePruneResult, MappingStoreError> {
        self.ensure_import_completed()?;
        check_identifier("mappingId", &request.mapping_id)?;
        check_identifier("keepSweepId", &request.keep_sweep_id)?;

        let transaction =
            Transaction::new_unchecked(&self.connection, TransactionBehavior::Immediate)?;
        require_active_mapping(&transaction, &request.mapping_id)?;
        let removed = transaction.execute(
            "DELETE FROM scan_digest_cache WHERE mapping_id = ?1 AND sweep_id != ?2",
            params![request.mapping_id, request.keep_sweep_id],
        )?;
        transaction.commit()?;
        Ok(DigestCachePruneResult {
            removed: i64::try_from(removed).unwrap_or(i64::MAX),
        })
    }
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

    fn entry(path: &str, digit: char) -> CachedDigestEntry {
        CachedDigestEntry {
            path: path.to_owned(),
            device: "12345".to_owned(),
            inode: "67890".to_owned(),
            size: 4,
            modified_ns: "1700000000000000000".to_owned(),
            changed_ns: "-1700000000000000000".to_owned(),
            digest: digit.to_string().repeat(64),
        }
    }

    #[test]
    fn record_then_lookup_round_trips_exact_strings() {
        let store = active_store();
        let recorded = store
            .record_digest_cache(&DigestCacheRecordRequest {
                mapping_id: "mapping-1".to_owned(),
                sweep_id: "sweep-1".to_owned(),
                entries: vec![entry("a.txt", 'a')],
            })
            .expect("record");
        assert_eq!(recorded.recorded, 1);

        let looked_up = store
            .lookup_digest_cache(&DigestCacheLookupRequest {
                mapping_id: "mapping-1".to_owned(),
                paths: vec!["a.txt".to_owned(), "missing.txt".to_owned()],
            })
            .expect("lookup");
        assert_eq!(looked_up.entries.len(), 1);
        let found = &looked_up.entries[0];
        assert_eq!(found.path, "a.txt");
        assert_eq!(found.device, "12345");
        assert_eq!(found.inode, "67890");
        assert_eq!(found.modified_ns, "1700000000000000000");
        assert_eq!(found.changed_ns, "-1700000000000000000");
        assert_eq!(found.digest, "a".repeat(64));
    }

    #[test]
    fn lookup_rejects_a_corrupted_persisted_row() {
        let store = active_store();
        store
            .record_digest_cache(&DigestCacheRecordRequest {
                mapping_id: "mapping-1".to_owned(),
                sweep_id: "sweep-1".to_owned(),
                entries: vec![entry("a.txt", 'a')],
            })
            .expect("record");
        store
            .connection
            .execute(
                "UPDATE scan_digest_cache SET digest = 'not-a-digest' WHERE mapping_id = 'mapping-1'",
                [],
            )
            .expect("corrupt row");

        assert!(matches!(
            store.lookup_digest_cache(&DigestCacheLookupRequest {
                mapping_id: "mapping-1".to_owned(),
                paths: vec!["a.txt".to_owned()],
            }),
            Err(MappingStoreError::CorruptMetadata { .. })
        ));
    }

    #[test]
    fn re_recording_a_path_overwrites_every_column() {
        let store = active_store();
        store
            .record_digest_cache(&DigestCacheRecordRequest {
                mapping_id: "mapping-1".to_owned(),
                sweep_id: "sweep-1".to_owned(),
                entries: vec![entry("a.txt", 'a')],
            })
            .expect("record");
        let mut updated = entry("a.txt", 'b');
        updated.size = 9;
        store
            .record_digest_cache(&DigestCacheRecordRequest {
                mapping_id: "mapping-1".to_owned(),
                sweep_id: "sweep-2".to_owned(),
                entries: vec![updated],
            })
            .expect("re-record");

        let row_count: i64 = store
            .connection
            .query_row(
                "SELECT COUNT(*) FROM scan_digest_cache WHERE mapping_id = 'mapping-1'",
                [],
                |row| row.get(0),
            )
            .expect("row count");
        assert_eq!(row_count, 1);

        let looked_up = store
            .lookup_digest_cache(&DigestCacheLookupRequest {
                mapping_id: "mapping-1".to_owned(),
                paths: vec!["a.txt".to_owned()],
            })
            .expect("lookup");
        assert_eq!(looked_up.entries[0].size, 9);
        assert_eq!(looked_up.entries[0].digest, "b".repeat(64));
    }

    #[test]
    fn prune_removes_only_rows_from_a_different_sweep() {
        let store = active_store();
        store
            .record_digest_cache(&DigestCacheRecordRequest {
                mapping_id: "mapping-1".to_owned(),
                sweep_id: "sweep-1".to_owned(),
                entries: vec![entry("a.txt", 'a'), entry("b.txt", 'b')],
            })
            .expect("record sweep 1");
        store
            .record_digest_cache(&DigestCacheRecordRequest {
                mapping_id: "mapping-1".to_owned(),
                sweep_id: "sweep-2".to_owned(),
                entries: vec![entry("a.txt", 'a')],
            })
            .expect("re-record a.txt under sweep 2");

        let pruned = store
            .prune_digest_cache(&DigestCachePruneRequest {
                mapping_id: "mapping-1".to_owned(),
                keep_sweep_id: "sweep-2".to_owned(),
            })
            .expect("prune");
        assert_eq!(pruned.removed, 1);

        let looked_up = store
            .lookup_digest_cache(&DigestCacheLookupRequest {
                mapping_id: "mapping-1".to_owned(),
                paths: vec!["a.txt".to_owned(), "b.txt".to_owned()],
            })
            .expect("lookup");
        assert_eq!(looked_up.entries.len(), 1);
        assert_eq!(looked_up.entries[0].path, "a.txt");
    }

    #[test]
    fn removing_a_mapping_cascades_its_cache_rows() {
        let store = active_store();
        store
            .record_digest_cache(&DigestCacheRecordRequest {
                mapping_id: "mapping-1".to_owned(),
                sweep_id: "sweep-1".to_owned(),
                entries: vec![entry("a.txt", 'a')],
            })
            .expect("record");
        store
            .remove_local("mapping-1", "a-device", None, 1, "2026-08-08T12:01:00Z")
            .expect("remove mapping");
        let row_count: i64 = store
            .connection
            .query_row("SELECT COUNT(*) FROM scan_digest_cache", [], |row| {
                row.get(0)
            })
            .expect("row count");
        assert_eq!(row_count, 0);
    }

    #[test]
    fn validation_rejects_batches_over_the_limit() {
        let store = active_store();
        let entries: Vec<CachedDigestEntry> = (0..=MAX_BATCH_ENTRIES)
            .map(|index| entry(&format!("file-{index}.txt"), 'a'))
            .collect();
        assert!(matches!(
            store.record_digest_cache(&DigestCacheRecordRequest {
                mapping_id: "mapping-1".to_owned(),
                sweep_id: "sweep-1".to_owned(),
                entries,
            }),
            Err(MappingStoreError::Invalid(_))
        ));

        let paths: Vec<String> = (0..=MAX_BATCH_ENTRIES)
            .map(|index| format!("file-{index}.txt"))
            .collect();
        assert!(matches!(
            store.lookup_digest_cache(&DigestCacheLookupRequest {
                mapping_id: "mapping-1".to_owned(),
                paths,
            }),
            Err(MappingStoreError::Invalid(_))
        ));
    }

    #[test]
    fn validation_rejects_duplicate_paths() {
        let store = active_store();
        assert!(matches!(
            store.record_digest_cache(&DigestCacheRecordRequest {
                mapping_id: "mapping-1".to_owned(),
                sweep_id: "sweep-1".to_owned(),
                entries: vec![entry("a.txt", 'a'), entry("a.txt", 'b')],
            }),
            Err(MappingStoreError::Invalid(_))
        ));
        assert!(matches!(
            store.lookup_digest_cache(&DigestCacheLookupRequest {
                mapping_id: "mapping-1".to_owned(),
                paths: vec!["a.txt".to_owned(), "a.txt".to_owned()],
            }),
            Err(MappingStoreError::Invalid(_))
        ));
    }

    #[test]
    fn validation_rejects_malformed_identity_fields() {
        let store = active_store();
        let mut non_decimal_inode = entry("a.txt", 'a');
        non_decimal_inode.inode = "not-a-number".to_owned();
        let mut oversized_device = entry("a.txt", 'a');
        oversized_device.device = "1".repeat(21);
        let mut malformed_modified_ns = entry("a.txt", 'a');
        malformed_modified_ns.modified_ns = "12a".to_owned();
        let mut invalid_digest = entry("a.txt", 'a');
        invalid_digest.digest = "not-a-digest".to_owned();

        for bad in [
            non_decimal_inode,
            oversized_device,
            malformed_modified_ns,
            invalid_digest,
        ] {
            assert!(matches!(
                store.record_digest_cache(&DigestCacheRecordRequest {
                    mapping_id: "mapping-1".to_owned(),
                    sweep_id: "sweep-1".to_owned(),
                    entries: vec![bad],
                }),
                Err(MappingStoreError::Invalid(_))
            ));
        }
    }

    #[test]
    fn validation_rejects_a_non_active_or_missing_mapping() {
        let store = active_store();
        store
            .upsert_local(
                &MappingConfiguration {
                    id: "mapping-pending".to_owned(),
                    name: "Pending".to_owned(),
                    initiator_device_id: "a-device".to_owned(),
                    initiator_device_name: "A".to_owned(),
                    responder_device_id: "b-device".to_owned(),
                    responder_device_name: "B".to_owned(),
                    initiator_path: "/tmp/c".to_owned(),
                    responder_path: "/tmp/d".to_owned(),
                    mode: "two-way".to_owned(),
                    ignore_patterns: Vec::new(),
                    history_days: 0,
                    history_max_bytes: 0,
                    max_file_bytes: None,
                    setup_status: "pending-approval".to_owned(),
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
            .expect("insert pending mapping");

        assert!(matches!(
            store.record_digest_cache(&DigestCacheRecordRequest {
                mapping_id: "mapping-pending".to_owned(),
                sweep_id: "sweep-1".to_owned(),
                entries: vec![entry("a.txt", 'a')],
            }),
            Err(MappingStoreError::Invalid(_))
        ));
        assert!(matches!(
            store.record_digest_cache(&DigestCacheRecordRequest {
                mapping_id: "mapping-missing".to_owned(),
                sweep_id: "sweep-1".to_owned(),
                entries: vec![entry("a.txt", 'a')],
            }),
            Err(MappingStoreError::NotFound(_))
        ));
    }
}
