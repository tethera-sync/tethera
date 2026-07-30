//! Cross-platform filesystem boundary.
#![forbid(unsafe_code)]
use std::path::{Path,PathBuf};
pub fn checked_join(root:&Path,relative:&Path)->Result<PathBuf,&'static str>{if relative.is_absolute(){return Err("absolute relative path")}if relative.components().any(|c|matches!(c,std::path::Component::ParentDir|std::path::Component::RootDir)){return Err("path escapes root")}Ok(root.join(relative))}
