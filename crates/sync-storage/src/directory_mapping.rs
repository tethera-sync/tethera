//! Approved directory aliases. Paths remain opaque and never trigger filesystem access here.
use std::collections::HashSet;

use rusqlite::{OptionalExtension, Transaction, TransactionBehavior, params};
use serde::{Deserialize, Serialize};

use crate::mapping::{MappingStore, MappingStoreError};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DirectoryMapping {
    pub path: String,
    pub local_path: String,
    pub remote_path: String,
    pub older_local_paths: Vec<String>,
    pub older_remote_paths: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DirectoryIdentity {
    pub device: String,
    pub inode: String,
    pub modified_ns: String,
    pub changed_ns: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DirectoryCleanupRequest {
    pub mapping_id: String,
    pub device_id: String,
    pub path: String,
    pub identity: Option<DirectoryIdentity>,
    #[serde(default)]
    pub complete: bool,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DirectoryCleanup {
    pub identity: DirectoryIdentity,
    pub completed: bool,
}

impl MappingStore {
    /// Records an exact directory before a recoverable OS-trash operation. Completed records
    /// survive mapping removal so cleanup evidence never disappears with the configuration.
    ///
    /// # Errors
    /// Rejects unapproved paths, inactive mappings, invalid identities and database failures.
    pub fn directory_cleanup(
        &self,
        request: &DirectoryCleanupRequest,
    ) -> Result<Option<DirectoryCleanup>, MappingStoreError> {
        let transaction =
            Transaction::new_unchecked(&self.connection, TransactionBehavior::Immediate)?;
        let record = self
            .get(&request.mapping_id)?
            .ok_or_else(|| MappingStoreError::NotFound(request.mapping_id.clone()))?;
        let mapping = &record.mapping;
        let initiator = request.device_id == mapping.initiator_device_id;
        if !initiator && request.device_id != mapping.responder_device_id {
            return Err(MappingStoreError::InvalidParticipant(
                "Directory cleanup participant mismatch".to_owned(),
            ));
        }
        if mapping.setup_status != "ready-for-initial-sync"
            || mapping.paused
            || record.pending_delivery
        {
            return Err(MappingStoreError::Invalid(
                "Directory cleanup requires an approved initial merge".to_owned(),
            ));
        }
        let approved = mapping
            .preview
            .as_ref()
            .and_then(|preview| preview.directory_mappings.as_ref())
            .is_some_and(|entries| {
                entries.iter().any(|entry| {
                    let older = if initiator {
                        &entry.older_local_paths
                    } else {
                        &entry.older_remote_paths
                    };
                    older.contains(&request.path)
                })
            });
        if !approved {
            return Err(MappingStoreError::Invalid(
                "Directory cleanup path was not approved".to_owned(),
            ));
        }
        if let Some(identity) = &request.identity {
            for value in [
                &identity.device,
                &identity.inode,
                &identity.modified_ns,
                &identity.changed_ns,
            ] {
                let digits = value.strip_prefix('-').unwrap_or(value);
                if digits.is_empty()
                    || digits.len() > 20
                    || !digits.bytes().all(|byte| byte.is_ascii_digit())
                {
                    return Err(MappingStoreError::Invalid(
                        "Invalid directory identity".to_owned(),
                    ));
                }
            }
            if identity.device == "0" || identity.inode == "0" {
                return Err(MappingStoreError::Invalid(
                    "Directory identity is unavailable".to_owned(),
                ));
            }
            transaction.execute("INSERT OR IGNORE INTO directory_cleanup (mapping_id, device_id, relative_path, identity) VALUES (?1, ?2, ?3, ?4)",
                params![request.mapping_id, request.device_id, request.path, serde_json::to_string(identity)?])?;
        }
        let existing: Option<(String, bool)> = transaction.query_row(
            "SELECT identity, completed FROM directory_cleanup WHERE mapping_id = ?1 AND device_id = ?2 AND relative_path = ?3",
            params![request.mapping_id, request.device_id, request.path], |row| Ok((row.get(0)?, row.get(1)?)),
        ).optional()?;
        let Some((identity, completed)) = existing else {
            return Ok(None);
        };
        let identity: DirectoryIdentity = serde_json::from_str(&identity)?;
        if request.complete {
            if request.identity.as_ref() != Some(&identity) {
                return Err(MappingStoreError::Invalid(
                    "Directory cleanup identity changed".to_owned(),
                ));
            }
            transaction.execute("UPDATE directory_cleanup SET completed = 1 WHERE mapping_id = ?1 AND device_id = ?2 AND relative_path = ?3",
                params![request.mapping_id, request.device_id, request.path])?;
        }
        transaction.commit()?;
        Ok(Some(DirectoryCleanup {
            identity,
            completed: completed || request.complete,
        }))
    }
}

/// Validates bounded, case-equivalent, consistently nested approved paths.
///
/// # Errors
/// Rejects paths outside the corresponding case group or selected parent directory.
pub fn validate_directory_mappings(mappings: &[DirectoryMapping]) -> Result<(), MappingStoreError> {
    let invalid = || MappingStoreError::Invalid("Invalid directory case mapping".to_owned());
    if mappings.len() > 100 {
        return Err(invalid());
    }
    let mut keys = HashSet::new();
    for mapping in mappings {
        for parent in mappings {
            if mapping
                .path
                .to_lowercase()
                .starts_with(&format!("{}/", parent.path.to_lowercase()))
                && (!mapping.path.starts_with(&format!("{}/", parent.path))
                    || !std::iter::once(&mapping.local_path)
                        .chain(&mapping.older_local_paths)
                        .all(|path| path.starts_with(&format!("{}/", parent.local_path)))
                    || !std::iter::once(&mapping.remote_path)
                        .chain(&mapping.older_remote_paths)
                        .all(|path| path.starts_with(&format!("{}/", parent.remote_path))))
            {
                return Err(invalid());
            }
        }
        let key = mapping.path.to_lowercase();
        if !keys.insert(key.clone())
            || mapping.older_local_paths.len() > 100
            || mapping.older_remote_paths.len() > 100
        {
            return Err(invalid());
        }
        for path in [&mapping.path, &mapping.local_path, &mapping.remote_path]
            .into_iter()
            .chain(&mapping.older_local_paths)
            .chain(&mapping.older_remote_paths)
        {
            if path.len() > 4096
                || path.contains(['\\', '\0', ':'])
                || path.to_lowercase() != key
                || path.split('/').any(|part| {
                    part.is_empty() || part == "." || part == ".." || part.starts_with(".tethera-")
                })
            {
                return Err(invalid());
            }
        }
        if mapping.older_local_paths.contains(&mapping.local_path)
            || mapping.older_remote_paths.contains(&mapping.remote_path)
        {
            return Err(invalid());
        }
    }
    Ok(())
}
