//! `SQLite`, journal and archive interfaces.
#![forbid(unsafe_code)]

pub mod digest_cache;
pub mod file_sync;
pub mod mapping;
pub mod scan_generations;
pub mod version_archive;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OperationPhase {
    Planned,
    Receiving,
    Verified,
    ArchivedOld,
    Committed,
    Indexed,
    Acknowledged,
}
