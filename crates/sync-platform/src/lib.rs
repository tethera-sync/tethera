//! Cross-platform filesystem boundary.
#![forbid(unsafe_code)]
use std::path::{Path, PathBuf};

pub mod scan;

/// Joins `relative` onto `root`, rejecting paths that would escape it.
///
/// # Errors
///
/// Returns `Err` if `relative` is absolute or contains a parent-directory
/// or root component that would allow it to escape `root`.
pub fn checked_join(root: &Path, relative: &Path) -> Result<PathBuf, &'static str> {
    if relative.is_absolute() {
        return Err("absolute relative path");
    }
    if relative.components().any(|c| {
        matches!(
            c,
            std::path::Component::ParentDir | std::path::Component::RootDir
        )
    }) {
        return Err("path escapes root");
    }
    Ok(root.join(relative))
}
