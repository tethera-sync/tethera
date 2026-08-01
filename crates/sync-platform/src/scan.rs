//! Recursive folder scanning that produces a `sync_core::manifest::FileManifest`.
//!
//! Mirrors the walk order and limits of `apps/desktop/src/main/folder-manifest.ts`'s
//! `scanFolder`, but hashes eligible files with `BLAKE3` instead of `SHA-256` — this is the
//! Rust-engine scanner the roadmap's durable-index slice moves folder scanning to.

use std::fs;
use std::io;
use std::path::Path;
use std::time::UNIX_EPOCH;

use sync_core::manifest::{FileManifest, FileManifestEntry, IgnoreMatcher, normalize_relative};

const MAX_MANIFEST_FILES: usize = 10_000;
const MAX_HASH_FILE_BYTES: u64 = 16 * 1024 * 1024;

/// Recursively scans `root`, skipping symlinks and anything matched by `ignore_patterns`, and
/// `BLAKE3`-hashing every file up to 16 MiB. Stops (marking the manifest `truncated`) after
/// 10,000 files rather than scanning an arbitrarily large tree unbounded.
///
/// # Errors
///
/// Returns `Err` if `root` does not exist or is not a directory.
pub fn scan_folder(root: &Path, ignore_patterns: &[String]) -> io::Result<FileManifest> {
    if !root.is_dir() {
        return Err(io::Error::new(io::ErrorKind::NotADirectory, "the selected path is not a folder"));
    }

    let matcher = IgnoreMatcher::new(ignore_patterns);
    let mut state = ScanState::default();
    visit(root, "", &matcher, &mut state);

    Ok(FileManifest {
        root_path: root.to_string_lossy().into_owned(),
        files: state.files,
        ignored: state.ignored,
        unreadable: state.unreadable,
        truncated: state.truncated,
    })
}

#[derive(Default)]
struct ScanState {
    files: Vec<FileManifestEntry>,
    ignored: u32,
    unreadable: u32,
    truncated: bool,
}

fn visit(directory_path: &Path, relative_directory: &str, matcher: &IgnoreMatcher, state: &mut ScanState) {
    if state.truncated {
        return;
    }
    let Ok(entries) = fs::read_dir(directory_path) else {
        state.unreadable += 1;
        return;
    };

    for entry in entries {
        if state.truncated {
            break;
        }
        visit_entry(entry, relative_directory, matcher, state);
    }
}

fn visit_entry(
    entry: io::Result<fs::DirEntry>,
    relative_directory: &str,
    matcher: &IgnoreMatcher,
    state: &mut ScanState,
) {
    let Ok(entry) = entry else {
        state.unreadable += 1;
        return;
    };
    let name = entry.file_name();
    let relative_path = normalize_relative(&join_relative(relative_directory, &name.to_string_lossy()));

    let Ok(file_type) = entry.file_type() else {
        state.unreadable += 1;
        return;
    };

    let is_directory = file_type.is_dir();
    if matcher.is_ignored(&relative_path, is_directory) {
        state.ignored += 1;
        return;
    }
    if file_type.is_symlink() {
        state.ignored += 1;
        return;
    }
    if is_directory {
        visit(&entry.path(), &relative_path, matcher, state);
        return;
    }
    if !file_type.is_file() {
        return;
    }
    if state.files.len() >= MAX_MANIFEST_FILES {
        state.truncated = true;
        return;
    }

    match fs::metadata(entry.path()) {
        Ok(metadata) => push_file(state, relative_path, &entry.path(), &metadata),
        Err(_) => state.unreadable += 1,
    }
}

fn push_file(state: &mut ScanState, relative_path: String, absolute_path: &Path, metadata: &fs::Metadata) {
    let digest = if metadata.len() <= MAX_HASH_FILE_BYTES {
        let Ok(digest) = hash_file(absolute_path) else {
            state.unreadable += 1;
            return;
        };
        Some(digest)
    } else {
        None
    };
    state.files.push(FileManifestEntry { path: relative_path, size: metadata.len(), modified_ms: modified_ms(metadata), digest });
}

fn join_relative(relative_directory: &str, name: &str) -> String {
    if relative_directory.is_empty() { name.to_owned() } else { format!("{relative_directory}/{name}") }
}

fn modified_ms(metadata: &fs::Metadata) -> i64 {
    metadata
        .modified()
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map_or(0, |duration| i64::try_from(duration.as_millis()).unwrap_or(i64::MAX))
}

fn hash_file(path: &Path) -> io::Result<String> {
    let mut hasher = blake3::Hasher::new();
    let mut file = fs::File::open(path)?;
    io::copy(&mut file, &mut hasher)?;
    Ok(hasher.finalize().to_hex().to_string())
}

#[cfg(test)]
mod tests {
    use std::fs;

    use super::scan_folder;

    #[test]
    fn scans_nested_files_and_hashes_them_with_blake3() {
        let root = tempfile::tempdir().expect("create tempdir");
        fs::write(root.path().join("top.txt"), b"hello").expect("write file");
        fs::create_dir(root.path().join("nested")).expect("create nested dir");
        fs::write(root.path().join("nested/inner.txt"), b"world").expect("write nested file");

        let manifest = scan_folder(root.path(), &[]).expect("scan folder");

        assert_eq!(manifest.files.len(), 2);
        assert!(!manifest.truncated);
        let top = manifest.files.iter().find(|entry| entry.path == "top.txt").expect("top.txt present");
        assert_eq!(top.digest.as_deref(), Some(blake3::hash(b"hello").to_hex().as_str()));
        let inner = manifest.files.iter().find(|entry| entry.path == "nested/inner.txt").expect("nested file present");
        assert_eq!(inner.digest.as_deref(), Some(blake3::hash(b"world").to_hex().as_str()));
    }

    #[test]
    fn respects_ignore_patterns_and_counts_them() {
        let root = tempfile::tempdir().expect("create tempdir");
        fs::create_dir(root.path().join("node_modules")).expect("create ignored dir");
        fs::write(root.path().join("node_modules/pkg.js"), b"ignored").expect("write ignored file");
        fs::write(root.path().join("keep.txt"), b"kept").expect("write kept file");

        let manifest = scan_folder(root.path(), &["node_modules/".to_owned()]).expect("scan folder");

        assert_eq!(manifest.files.len(), 1);
        assert_eq!(manifest.files[0].path, "keep.txt");
        assert_eq!(manifest.ignored, 1);
    }

    #[test]
    fn errors_when_the_root_is_not_a_directory() {
        let root = tempfile::tempdir().expect("create tempdir");
        let file_path = root.path().join("not-a-dir.txt");
        fs::write(&file_path, b"x").expect("write file");

        assert!(scan_folder(&file_path, &[]).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn skips_symlinks() {
        use std::os::unix::fs::symlink;

        let root = tempfile::tempdir().expect("create tempdir");
        fs::write(root.path().join("real.txt"), b"real").expect("write real file");
        symlink(root.path().join("real.txt"), root.path().join("link.txt")).expect("create symlink");

        let manifest = scan_folder(root.path(), &[]).expect("scan folder");

        assert_eq!(manifest.files.len(), 1);
        assert_eq!(manifest.files[0].path, "real.txt");
        assert_eq!(manifest.ignored, 1);
    }

    #[test]
    fn does_not_hash_files_over_the_16_mib_threshold() {
        let root = tempfile::tempdir().expect("create tempdir");
        let big = vec![0u8; 16 * 1024 * 1024 + 1];
        fs::write(root.path().join("big.bin"), &big).expect("write big file");

        let manifest = scan_folder(root.path(), &[]).expect("scan folder");

        assert_eq!(manifest.files.len(), 1);
        assert_eq!(manifest.files[0].digest, None);
        assert_eq!(manifest.files[0].size, big.len() as u64);
    }
}
