//! Recursive folder scanning that produces a `sync_core::manifest::FileManifest`.
//!
//! Mirrors the walk order and limits of `apps/desktop/src/main/folder-manifest.ts`'s
//! `scanFolder`, but hashes eligible files with `BLAKE3` instead of `SHA-256` — this is the
//! Rust-engine scanner the roadmap's durable-index slice moves folder scanning to.
//!
//! # Status: preliminary
//!
//! This is a **preview** scanner, not the durable index. It builds one whole manifest in memory
//! in a single pass and holds every entry there, so the ceilings below are deliberate guards
//! against unbounded memory use rather than product limits. In particular it is **not** ready
//! for the terabyte-scale mappings Tethera targets: at 10,000 files it stops early and reports
//! `truncated`, and the caller gets a partial picture. Removing these ceilings needs the
//! streaming, resumable, database-backed scan planned for the durable-index slice — see
//! `docs/15-IMPLEMENTATION-STATUS.md`.
//!
//! Both ceilings are temporary:
//!
//! - [`MAX_MANIFEST_FILES`] — stop after 10,000 files and set `truncated`.
//! - [`MAX_HASH_FILE_BYTES`] — files over 16 MiB are listed with size and mtime but no digest,
//!   so comparison falls back to the size/mtime heuristic for them.
//!
//! # Safety properties
//!
//! - **Read-only.** Nothing in this module creates, writes, moves or deletes a file. It opens
//!   files for reading to hash them and otherwise only reads directory entries and metadata.
//! - **Never follows symlinks.** Entry types come from `read_dir`, which does not dereference,
//!   so a symlink is counted as ignored and never traversed or hashed. That also means the walk
//!   cannot be lured outside `root` or into a cycle by a crafted link.
//! - **Bounded depth.** Traversal stops at [`MAX_SCAN_DEPTH`] so a pathological tree cannot
//!   exhaust the stack.
//! - **Partial failures do not abort the scan.** An unreadable directory, entry, or file is
//!   counted in `unreadable` and skipped; the walk continues.
//!
//! # Ignore patterns
//!
//! Patterns are matched by `sync_core::manifest::IgnoreMatcher` against each entry's
//! `/`-separated path relative to `root`, using gitignore-flavoured syntax: `*` (any run of
//! characters within one segment), `?` (one character within a segment), `**` (crosses
//! segments), a trailing `/` to match directories only, and basename-only matching for a
//! pattern containing no `/`. Matching is case-insensitive. A matched directory is skipped
//! whole — its contents are never walked and count as one `ignored`, not one per file.
//! Negation (`!`) is not supported.

use std::fs;
use std::io;
use std::path::Path;
use std::time::UNIX_EPOCH;

use sync_core::manifest::{FileManifest, FileManifestEntry, IgnoreMatcher, normalize_relative};

/// Temporary ceiling on manifest size; see the module docs.
const MAX_MANIFEST_FILES: usize = 10_000;
/// Temporary ceiling on the size of a file this scanner will hash; see the module docs.
const MAX_HASH_FILE_BYTES: u64 = 16 * 1024 * 1024;
/// Deepest directory nesting the walk will descend into, so a pathological (or adversarial)
/// tree cannot exhaust the stack. Directories below this are counted as `unreadable`.
const MAX_SCAN_DEPTH: usize = 64;

/// Recursively scans `root`, skipping symlinks and anything matched by `ignore_patterns`, and
/// `BLAKE3`-hashing every file up to 16 MiB by streaming it rather than reading it into memory.
/// Stops (marking the manifest `truncated`) after 10,000 files rather than scanning an
/// arbitrarily large tree unbounded.
///
/// Read-only: this never writes to, moves or deletes anything under `root`. See the module docs
/// for the full set of guarantees and for why the limits here are temporary.
///
/// # Errors
///
/// Returns `Err` if `root` does not exist or is not a directory. Failures *within* the tree —
/// an unreadable subdirectory or file — are counted in `FileManifest::unreadable` and do not
/// abort the scan.
pub fn scan_folder(root: &Path, ignore_patterns: &[String]) -> io::Result<FileManifest> {
    if !root.is_dir() {
        return Err(io::Error::new(
            io::ErrorKind::NotADirectory,
            "the selected path is not a folder",
        ));
    }

    let matcher = IgnoreMatcher::new(ignore_patterns);
    let mut state = ScanState::default();
    visit(root, "", 0, &matcher, &mut state);

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

fn visit(
    directory_path: &Path,
    relative_directory: &str,
    depth: usize,
    matcher: &IgnoreMatcher,
    state: &mut ScanState,
) {
    if state.truncated {
        return;
    }
    if depth >= MAX_SCAN_DEPTH {
        state.unreadable += 1;
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
        visit_entry(entry, relative_directory, depth, matcher, state);
    }
}

fn visit_entry(
    entry: io::Result<fs::DirEntry>,
    relative_directory: &str,
    depth: usize,
    matcher: &IgnoreMatcher,
    state: &mut ScanState,
) {
    let Ok(entry) = entry else {
        state.unreadable += 1;
        return;
    };
    let name = entry.file_name();
    // `file_name` is a single path component, so the joined path can only ever grow downward
    // from the root — an entry cannot name `..` or contain a separator and walk back out.
    let relative_path =
        normalize_relative(&join_relative(relative_directory, &name.to_string_lossy()));

    // `DirEntry::file_type` reports the entry itself and never dereferences a symlink, so a
    // link to a directory is seen as a symlink here rather than as a directory to descend into.
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
        visit(&entry.path(), &relative_path, depth + 1, matcher, state);
        return;
    }
    if !file_type.is_file() {
        return;
    }
    if state.files.len() >= MAX_MANIFEST_FILES {
        state.truncated = true;
        return;
    }

    // `DirEntry::metadata` does not follow symlinks either, so an entry that turned into one
    // between the check above and here still cannot redirect the scan at a linked target.
    match entry.metadata() {
        Ok(metadata) => push_file(state, relative_path, &entry.path(), &metadata),
        Err(_) => state.unreadable += 1,
    }
}

fn push_file(
    state: &mut ScanState,
    relative_path: String,
    absolute_path: &Path,
    metadata: &fs::Metadata,
) {
    let digest = if metadata.len() <= MAX_HASH_FILE_BYTES {
        let Ok(digest) = hash_file(absolute_path) else {
            state.unreadable += 1;
            return;
        };
        Some(digest)
    } else {
        None
    };
    state.files.push(FileManifestEntry {
        path: relative_path,
        size: metadata.len(),
        modified_ms: modified_ms(metadata),
        digest,
    });
}

fn join_relative(relative_directory: &str, name: &str) -> String {
    if relative_directory.is_empty() {
        name.to_owned()
    } else {
        format!("{relative_directory}/{name}")
    }
}

fn modified_ms(metadata: &fs::Metadata) -> i64 {
    metadata
        .modified()
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map_or(0, |duration| {
            i64::try_from(duration.as_millis()).unwrap_or(i64::MAX)
        })
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
        let top = manifest
            .files
            .iter()
            .find(|entry| entry.path == "top.txt")
            .expect("top.txt present");
        assert_eq!(
            top.digest.as_deref(),
            Some(blake3::hash(b"hello").to_hex().as_str())
        );
        let inner = manifest
            .files
            .iter()
            .find(|entry| entry.path == "nested/inner.txt")
            .expect("nested file present");
        assert_eq!(
            inner.digest.as_deref(),
            Some(blake3::hash(b"world").to_hex().as_str())
        );
    }

    #[test]
    fn respects_ignore_patterns_and_counts_them() {
        let root = tempfile::tempdir().expect("create tempdir");
        fs::create_dir(root.path().join("node_modules")).expect("create ignored dir");
        fs::write(root.path().join("node_modules/pkg.js"), b"ignored").expect("write ignored file");
        fs::write(root.path().join("keep.txt"), b"kept").expect("write kept file");

        let manifest =
            scan_folder(root.path(), &["node_modules/".to_owned()]).expect("scan folder");

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
        symlink(root.path().join("real.txt"), root.path().join("link.txt"))
            .expect("create symlink");

        let manifest = scan_folder(root.path(), &[]).expect("scan folder");

        assert_eq!(manifest.files.len(), 1);
        assert_eq!(manifest.files[0].path, "real.txt");
        assert_eq!(manifest.ignored, 1);
    }

    #[cfg(unix)]
    #[test]
    fn a_symlinked_directory_is_never_traversed() {
        use std::os::unix::fs::symlink;

        let outside = tempfile::tempdir().expect("create outside tempdir");
        fs::write(outside.path().join("secret.txt"), b"outside the root").expect("write outside");

        let root = tempfile::tempdir().expect("create tempdir");
        fs::write(root.path().join("inside.txt"), b"inside").expect("write inside file");
        symlink(outside.path(), root.path().join("escape")).expect("create directory symlink");

        let manifest = scan_folder(root.path(), &[]).expect("scan folder");

        assert_eq!(
            manifest.files.len(),
            1,
            "a symlinked directory must not be walked into"
        );
        assert_eq!(manifest.files[0].path, "inside.txt");
        assert!(
            manifest
                .files
                .iter()
                .all(|entry| !entry.path.contains("secret")),
            "nothing outside the root may appear in the manifest"
        );
    }

    #[cfg(unix)]
    #[test]
    fn a_symlink_cycle_terminates_instead_of_looping_forever() {
        use std::os::unix::fs::symlink;

        let root = tempfile::tempdir().expect("create tempdir");
        fs::create_dir(root.path().join("nested")).expect("create nested dir");
        fs::write(root.path().join("nested/file.txt"), b"content").expect("write file");
        symlink(root.path(), root.path().join("nested/loop")).expect("create cycle");

        let manifest = scan_folder(root.path(), &[]).expect("scan folder");

        assert_eq!(manifest.files.len(), 1);
        assert_eq!(manifest.files[0].path, "nested/file.txt");
        assert!(!manifest.truncated, "a cycle must not exhaust the file cap");
    }

    #[test]
    fn every_manifest_path_stays_relative_and_inside_the_root() {
        let root = tempfile::tempdir().expect("create tempdir");
        fs::create_dir_all(root.path().join("a/b/c")).expect("create nested dirs");
        fs::write(root.path().join("a/b/c/deep.txt"), b"deep").expect("write deep file");
        fs::write(root.path().join("top.txt"), b"top").expect("write top file");

        let manifest = scan_folder(root.path(), &[]).expect("scan folder");

        assert_eq!(manifest.files.len(), 2);
        for entry in &manifest.files {
            assert!(
                !entry.path.starts_with('/') && !entry.path.contains(".."),
                "{} escaped the root",
                entry.path
            );
        }
        assert!(
            manifest
                .files
                .iter()
                .any(|entry| entry.path == "a/b/c/deep.txt"),
            "nested paths should be reported with forward slashes relative to the root"
        );
    }

    #[cfg(unix)]
    #[test]
    fn an_unreadable_subdirectory_is_counted_without_aborting_the_scan() {
        use std::os::unix::fs::PermissionsExt;

        let root = tempfile::tempdir().expect("create tempdir");
        fs::write(root.path().join("readable.txt"), b"fine").expect("write readable file");
        let locked = root.path().join("locked");
        fs::create_dir(&locked).expect("create locked dir");
        fs::write(locked.join("hidden.txt"), b"hidden").expect("write hidden file");
        fs::set_permissions(&locked, fs::Permissions::from_mode(0o000)).expect("lock the dir");

        let manifest = scan_folder(root.path(), &[]).expect("scan folder");

        // Restore permissions so the tempdir can clean itself up.
        fs::set_permissions(&locked, fs::Permissions::from_mode(0o755)).expect("unlock the dir");

        assert_eq!(
            manifest.files.len(),
            1,
            "the readable sibling must still be scanned"
        );
        assert_eq!(manifest.files[0].path, "readable.txt");
        assert_eq!(
            manifest.unreadable, 1,
            "the unreadable directory should be counted, not fatal"
        );
    }

    #[test]
    fn stops_descending_past_the_depth_limit_instead_of_overflowing_the_stack() {
        let root = tempfile::tempdir().expect("create tempdir");
        let mut deep = root.path().to_path_buf();
        for level in 0..(super::MAX_SCAN_DEPTH + 5) {
            deep = deep.join(format!("level-{level}"));
        }
        fs::create_dir_all(&deep).expect("create a very deep tree");
        fs::write(deep.join("too-deep.txt"), b"unreachable").expect("write deep file");

        let manifest = scan_folder(root.path(), &[]).expect("scan folder");

        assert!(
            manifest.files.is_empty(),
            "nothing below the depth limit should be listed"
        );
        assert!(
            manifest.unreadable >= 1,
            "hitting the depth limit should be reported as unreadable"
        );
    }

    #[test]
    fn scanning_never_modifies_the_folder_it_reads() {
        let root = tempfile::tempdir().expect("create tempdir");
        fs::write(root.path().join("one.txt"), b"one").expect("write file");
        fs::create_dir(root.path().join("nested")).expect("create nested dir");
        fs::write(root.path().join("nested/two.txt"), b"two").expect("write nested file");

        let before = listing(root.path());
        scan_folder(root.path(), &[]).expect("scan folder");
        let after = listing(root.path());

        assert_eq!(before, after, "a scan must leave the folder byte-identical");
    }

    /// Every path under `root`, with each file's contents, sorted for comparison.
    fn listing(root: &std::path::Path) -> Vec<(String, Option<Vec<u8>>)> {
        let mut found = Vec::new();
        let mut queue = vec![root.to_path_buf()];
        while let Some(directory) = queue.pop() {
            for entry in fs::read_dir(&directory).expect("read dir") {
                let entry = entry.expect("read entry");
                let path = entry.path();
                let label = path
                    .strip_prefix(root)
                    .expect("under root")
                    .to_string_lossy()
                    .into_owned();
                if entry.file_type().expect("file type").is_dir() {
                    queue.push(path);
                    found.push((label, None));
                } else {
                    found.push((label, Some(fs::read(&path).expect("read file"))));
                }
            }
        }
        found.sort();
        found
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
