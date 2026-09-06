//! Folder manifests, initial comparison and no-write sync planning.
//!
//! Mirrors `apps/desktop/src/main/folder-manifest.ts` and `initial-sync.ts` field-for-field so
//! the Rust engine can eventually replace the Node.js implementation without changing the shape
//! either side of the protocol depends on. Digests here are produced by whichever scanner built
//! the manifest (`sync-platform::scan_folder` uses `BLAKE3`; the current Node.js scanner still
//! uses `SHA-256`) — this module never hashes anything itself, it only compares what it's given.

use std::collections::{HashMap, HashSet};
use std::fmt;
use std::sync::LazyLock;

use regex::Regex;
use serde::{Deserialize, Serialize};

static WINDOWS_RESERVED_NAME: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(\..*)?$")
        .expect("static regex should compile")
});

const MAX_SAMPLE_ITEMS: usize = 14;

/// Longest ignore pattern the matcher accepts, mirroring the desktop and
/// engine envelopes (256 patterns of at most 512 units). Anything longer
/// fails closed instead of reaching the regex compiler, so a hostile caller
/// can never turn pattern compilation into a panic.
const MAX_IGNORE_PATTERN_LENGTH: usize = 512;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum SyncMode {
    TwoWay,
    SendOnly,
    ReceiveOnly,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Platform {
    Linux,
    Windows,
    Unknown,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileManifestEntry {
    pub path: String,
    pub size: u64,
    pub modified_ms: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub digest: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileManifest {
    pub root_path: String,
    pub files: Vec<FileManifestEntry>,
    pub ignored: u32,
    pub unreadable: u32,
    pub truncated: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum PreviewCategory {
    LocalOnly,
    RemoteOnly,
    Different,
    InvalidName,
    CaseCollision,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MappingPreviewItem {
    pub path: String,
    pub category: PreviewCategory,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub size: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FolderMappingPreview {
    pub local_files: usize,
    pub remote_files: usize,
    pub identical_files: usize,
    pub different_files: usize,
    pub local_only_files: usize,
    pub remote_only_files: usize,
    pub ignored_local: u32,
    pub ignored_remote: u32,
    pub bytes_to_remote: u64,
    pub bytes_to_local: u64,
    pub invalid_windows_names: Vec<String>,
    pub case_collisions: Vec<String>,
    pub truncated: bool,
    pub samples: Vec<MappingPreviewItem>,
}

#[derive(Debug, Clone, Copy)]
pub struct CompareOptions {
    pub mode: SyncMode,
    pub local_platform: Platform,
    pub remote_platform: Platform,
}

/// Compares two manifests and produces the same summary the folder-mapping wizard shows the
/// user before approval: which files are identical, one-sided or different, an estimate of the
/// bytes that would move in each direction, and any Windows-invalid names or case-only
/// collisions that would block approval.
#[must_use]
pub fn compare_manifests(
    local: &FileManifest,
    remote: &FileManifest,
    options: CompareOptions,
) -> FolderMappingPreview {
    let local_by_path: HashMap<&str, &FileManifestEntry> = local
        .files
        .iter()
        .map(|entry| (entry.path.as_str(), entry))
        .collect();
    let remote_by_path: HashMap<&str, &FileManifestEntry> = remote
        .files
        .iter()
        .map(|entry| (entry.path.as_str(), entry))
        .collect();

    let mut paths: Vec<&str> = local_by_path
        .keys()
        .chain(remote_by_path.keys())
        .copied()
        .collect();
    paths.sort_unstable();
    paths.dedup();

    let mut tally = CompareTally::default();
    for relative_path in paths {
        let local_entry = local_by_path.get(relative_path).copied();
        let remote_entry = remote_by_path.get(relative_path).copied();
        tally.classify(relative_path, local_entry, remote_entry, options.mode);
    }

    let (mut invalid_windows_names, mut case_collisions) =
        collect_platform_issues(local, remote, options);

    for invalid in invalid_windows_names.iter().take(4) {
        add_sample(
            &mut tally.samples,
            invalid,
            PreviewCategory::InvalidName,
            None,
        );
    }
    for collision in case_collisions.iter().take(4) {
        add_sample(
            &mut tally.samples,
            collision,
            PreviewCategory::CaseCollision,
            None,
        );
    }

    invalid_windows_names.truncate(100);
    case_collisions.truncate(100);

    FolderMappingPreview {
        local_files: local.files.len(),
        remote_files: remote.files.len(),
        identical_files: tally.identical_files,
        different_files: tally.different_files,
        local_only_files: tally.local_only_files,
        remote_only_files: tally.remote_only_files,
        ignored_local: local.ignored + local.unreadable,
        ignored_remote: remote.ignored + remote.unreadable,
        bytes_to_remote: tally.bytes_to_remote,
        bytes_to_local: tally.bytes_to_local,
        invalid_windows_names,
        case_collisions,
        truncated: local.truncated || remote.truncated,
        samples: tally.samples,
    }
}

/// Running totals while walking the union of both manifests' paths.
#[derive(Default)]
struct CompareTally {
    identical_files: usize,
    different_files: usize,
    local_only_files: usize,
    remote_only_files: usize,
    bytes_to_remote: u64,
    bytes_to_local: u64,
    samples: Vec<MappingPreviewItem>,
}

impl CompareTally {
    /// Folds one path — present on either side, or both — into the totals.
    fn classify(
        &mut self,
        relative_path: &str,
        local_entry: Option<&FileManifestEntry>,
        remote_entry: Option<&FileManifestEntry>,
        mode: SyncMode,
    ) {
        match (local_entry, remote_entry) {
            (Some(local_entry), None) => {
                self.local_only_files += 1;
                if mode != SyncMode::ReceiveOnly {
                    self.bytes_to_remote += local_entry.size;
                }
                add_sample(
                    &mut self.samples,
                    relative_path,
                    PreviewCategory::LocalOnly,
                    Some(local_entry.size),
                );
            }
            (None, Some(remote_entry)) => {
                self.remote_only_files += 1;
                if mode != SyncMode::SendOnly {
                    self.bytes_to_local += remote_entry.size;
                }
                add_sample(
                    &mut self.samples,
                    relative_path,
                    PreviewCategory::RemoteOnly,
                    Some(remote_entry.size),
                );
            }
            (Some(local_entry), Some(remote_entry)) => {
                if entries_look_identical(local_entry, remote_entry) {
                    self.identical_files += 1;
                    return;
                }

                self.different_files += 1;
                match mode {
                    SyncMode::SendOnly => self.bytes_to_remote += local_entry.size,
                    SyncMode::ReceiveOnly => self.bytes_to_local += remote_entry.size,
                    SyncMode::TwoWay => {
                        if local_entry.modified_ms >= remote_entry.modified_ms {
                            self.bytes_to_remote += local_entry.size;
                        } else {
                            self.bytes_to_local += remote_entry.size;
                        }
                    }
                }
                add_sample(
                    &mut self.samples,
                    relative_path,
                    PreviewCategory::Different,
                    Some(local_entry.size.max(remote_entry.size)),
                );
            }
            (None, None) => {
                // `paths` is the deduped union of both manifests' keys, so at
                // least one side always has an entry. Guard the construction
                // invariant without panicking if a future refactor breaks it.
                debug_assert!(
                    false,
                    "classify paths come from the union of both manifests"
                );
            }
        }
    }
}

/// Whether the same path on both sides can be treated as unchanged.
///
/// Digests decide it when both sides have one. When neither does — the file was over the
/// scanner's hashing ceiling — this falls back to size plus a two-second modification-time
/// window, which absorbs filesystems that store coarser timestamps than others. One side having
/// a digest and the other not is never "identical": there is nothing to compare.
fn entries_look_identical(
    local_entry: &FileManifestEntry,
    remote_entry: &FileManifestEntry,
) -> bool {
    let digest_match = matches!((&local_entry.digest, &remote_entry.digest), (Some(local), Some(remote)) if local == remote);
    let metadata_match = local_entry.digest.is_none()
        && remote_entry.digest.is_none()
        && local_entry.size == remote_entry.size
        && (local_entry.modified_ms - remote_entry.modified_ms).abs() <= 2_000;
    digest_match || metadata_match
}

fn add_sample(
    samples: &mut Vec<MappingPreviewItem>,
    path: &str,
    category: PreviewCategory,
    size: Option<u64>,
) {
    if samples.len() < MAX_SAMPLE_ITEMS {
        samples.push(MappingPreviewItem {
            path: path.to_owned(),
            category,
            size,
        });
    }
}

/// Collects Windows-invalid filenames and case-only collisions on whichever side would land on
/// a Windows filesystem, sorted for stable output. Skipped for a side receiving nothing, since
/// there's nothing that side would ever write to disk.
fn collect_platform_issues(
    local: &FileManifest,
    remote: &FileManifest,
    options: CompareOptions,
) -> (Vec<String>, Vec<String>) {
    let mut invalid_windows_names = HashSet::new();
    let mut case_collisions = HashSet::new();

    if options.remote_platform == Platform::Windows && options.mode != SyncMode::ReceiveOnly {
        for entry in &local.files {
            if has_windows_invalid_path(&entry.path) {
                invalid_windows_names.insert(entry.path.clone());
            }
        }
        case_collisions.extend(find_case_collisions(&local.files));
    }
    if options.local_platform == Platform::Windows && options.mode != SyncMode::SendOnly {
        for entry in &remote.files {
            if has_windows_invalid_path(&entry.path) {
                invalid_windows_names.insert(entry.path.clone());
            }
        }
        case_collisions.extend(find_case_collisions(&remote.files));
    }

    let mut invalid_windows_names: Vec<String> = invalid_windows_names.into_iter().collect();
    invalid_windows_names.sort_unstable();
    let mut case_collisions: Vec<String> = case_collisions.into_iter().collect();
    case_collisions.sort_unstable();
    (invalid_windows_names, case_collisions)
}

/// The maximum size of a file the current (pre-chunking) initial sync will transfer whole.
pub const MAX_TRANSFER_FILE_BYTES: u64 = 8 * 1024 * 1024;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncSkip {
    pub path: String,
    pub reason: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncPlan {
    pub to_pull: Vec<FileManifestEntry>,
    pub skipped: Vec<SyncSkip>,
}

/// Builds a no-write plan of what an initial sync would pull from `remote` into `local`,
/// without touching the filesystem. Only ever pulls: files that exist on the remote side but
/// not locally are copied down. Files that exist on both sides but differ are left alone
/// (skipped, with a reason) rather than guessing a winner. Local-only files are picked up when
/// the *other* device runs its own initial sync and pulls them from here.
#[must_use]
pub fn compute_sync_plan(local: &FileManifest, remote: &FileManifest, mode: SyncMode) -> SyncPlan {
    if mode == SyncMode::SendOnly {
        return SyncPlan {
            to_pull: Vec::new(),
            skipped: Vec::new(),
        };
    }

    let local_by_path: HashMap<&str, &FileManifestEntry> = local
        .files
        .iter()
        .map(|entry| (entry.path.as_str(), entry))
        .collect();
    let mut to_pull = Vec::new();
    let mut skipped = Vec::new();

    for remote_entry in &remote.files {
        let Some(local_entry) = local_by_path.get(remote_entry.path.as_str()) else {
            if remote_entry.size > MAX_TRANSFER_FILE_BYTES {
                skipped.push(SyncSkip {
                    path: remote_entry.path.clone(),
                    reason: "Larger than the 8 MiB initial-sync limit.".to_owned(),
                });
            } else {
                to_pull.push(remote_entry.clone());
            }
            continue;
        };

        if entries_look_identical(local_entry, remote_entry) {
            continue;
        }

        skipped.push(SyncSkip {
            path: remote_entry.path.clone(),
            reason: "Exists on both computers with different content; skipped until conflict resolution is available.".to_owned(),
        });
    }

    SyncPlan { to_pull, skipped }
}

/// Matches relative paths against gitignore-flavoured patterns: `*`, `?`, `**`, a trailing `/`
/// for directory-only rules, and basename-only matching when a pattern has no `/`.
#[derive(Debug)]
pub struct IgnoreMatcher {
    rules: Vec<IgnoreRule>,
}

#[derive(Debug)]
struct IgnoreRule {
    directory_only: bool,
    basename_only: bool,
    regex: Regex,
}

/// Rejected ignore pattern, carrying the offending value for a precise error.
/// Display truncates it so an oversized pattern never floods logs or RPC errors.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InvalidIgnorePattern {
    pub pattern: String,
}

impl fmt::Display for InvalidIgnorePattern {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        const SHOWN: usize = 64;
        let shown: String = self.pattern.chars().take(SHOWN).collect();
        if self.pattern.chars().count() > SHOWN {
            write!(formatter, "invalid ignore pattern {shown:?}…")
        } else {
            write!(formatter, "invalid ignore pattern {shown:?}")
        }
    }
}

impl std::error::Error for InvalidIgnorePattern {}

impl IgnoreMatcher {
    /// Builds a matcher for already-validated patterns, skipping anything that
    /// cannot compile. Construction sites that must fail closed on hostile
    /// input (folder scans) use [`IgnoreMatcher::try_new`] instead.
    #[must_use]
    pub fn new(patterns: &[String]) -> Self {
        let rules = patterns
            .iter()
            .filter_map(|pattern| build_rule(pattern))
            .flatten()
            .collect();
        Self { rules }
    }

    /// Builds a matcher, rejecting the first pattern that is oversized or
    /// cannot compile instead of silently changing what gets ignored.
    ///
    /// # Errors
    ///
    /// Returns [`InvalidIgnorePattern`] for the first pattern that exceeds
    /// the length envelope or cannot compile; blanks and comments are still
    /// skipped silently.
    pub fn try_new(patterns: &[String]) -> Result<Self, InvalidIgnorePattern> {
        let mut rules = Vec::with_capacity(patterns.len());
        for pattern in patterns {
            if let Some(pattern_rules) = build_rule(pattern) {
                rules.extend(pattern_rules);
            } else if !ignorable_pattern(pattern) {
                return Err(InvalidIgnorePattern {
                    pattern: pattern.clone(),
                });
            }
        }
        Ok(Self { rules })
    }

    #[must_use]
    pub fn is_ignored(&self, relative_path: &str, is_directory: bool) -> bool {
        let normalized = normalize_relative(relative_path);
        let basename = normalized.rsplit('/').next().unwrap_or(normalized.as_str());
        self.rules.iter().any(|rule| {
            if rule.directory_only && !is_directory {
                return false;
            }
            let subject = if rule.basename_only {
                basename
            } else {
                normalized.as_str()
            };
            rule.regex.is_match(subject)
        })
    }
}

#[must_use]
pub fn normalize_relative(relative_path: &str) -> String {
    strip_leading_dot_slash(&relative_path.replace('\\', "/"))
}

fn strip_leading_dot_slash(path: &str) -> String {
    path.strip_prefix("./")
        .map_or_else(|| path.to_owned(), ToOwned::to_owned)
}

/// Patterns that never become rules: blanks and comments, after the same
/// normalization the matcher applies.
fn ignorable_pattern(pattern: &str) -> bool {
    let normalized = strip_leading_dot_slash(&pattern.trim().replace('\\', "/"));
    normalized.is_empty() || normalized.starts_with('#')
}

/// Compiles one ignore-file line into its regex rule(s).
///
/// A pattern normally becomes exactly one [`IgnoreRule`]. A pattern ending in `/**` (e.g.
/// `node_modules/**`) additionally emits a *derived* rule matching the directory itself: without
/// it, the regex only matches paths *inside* the directory, so `scan_folder` would still open and
/// walk a directory it was told to skip whole, matching every entry underneath one at a time
/// instead of pruning the subtree.
fn build_rule(pattern: &str) -> Option<Vec<IgnoreRule>> {
    let normalized = strip_leading_dot_slash(&pattern.trim().replace('\\', "/"));
    if normalized.is_empty() || normalized.starts_with('#') {
        return None;
    }
    let directory_only = normalized.ends_with('/');
    let source = if directory_only {
        normalized[..normalized.len() - 1].to_owned()
    } else {
        normalized
    };
    if source.len() > MAX_IGNORE_PATTERN_LENGTH {
        return None;
    }
    // Anchoring is decided from the *full* pattern, before `**` is parsed away: gitignore
    // anchors any pattern containing a slash to the scan root, regardless of where the slash
    // sits relative to a `**` segment.
    let basename_only = !source.contains('/');
    let regex = glob_to_regex(&source)?;
    let mut rules = vec![IgnoreRule {
        directory_only,
        basename_only,
        regex,
    }];

    if let Some(prefix) = source.strip_suffix("/**") {
        if !prefix.is_empty() {
            let prefix_regex = glob_to_regex(prefix)?;
            rules.push(IgnoreRule {
                directory_only: true,
                basename_only,
                regex: prefix_regex,
            });
        }
    }

    Some(rules)
}

/// Compiles a gitignore-flavoured glob body (no trailing slash, already stripped) to an anchored,
/// case-insensitive regex.
///
/// `**` is not a bare wildcard: gitignore gives it segment-crossing meaning that depends on where
/// it sits in the pattern, so it is handled positionally rather than as "two stars in a row":
///
/// - a leading `**/` matches zero or more whole leading segments;
/// - `/**/` in the middle matches zero or more whole segments between two literal segments;
/// - a trailing `/**` matches a slash followed by anything;
/// - anywhere else, `**` falls back to a plain `.*`.
///
/// A single `*` or `?` stays confined to one path segment (`[^/]*` / `[^/]`), matching gitignore
/// and the pre-existing behaviour for non-`**` globs.
fn glob_to_regex(pattern: &str) -> Option<Regex> {
    let chars: Vec<char> = pattern.chars().collect();
    let length = chars.len();
    let mut source = String::new();
    let mut index = 0;
    while index < length {
        if index == 0 && starts_with_at(&chars, 0, &['*', '*', '/']) {
            source.push_str("(?:.*/)?");
            index += 3;
        } else if starts_with_at(&chars, index, &['/', '*', '*', '/']) {
            source.push_str("/(?:.*/)?");
            index += 4;
        } else if index + 3 == length && starts_with_at(&chars, index, &['/', '*', '*']) {
            source.push_str("/.*");
            index += 3;
        } else if chars[index] == '*' && chars.get(index + 1) == Some(&'*') {
            source.push_str(".*");
            index += 2;
        } else if chars[index] == '*' {
            source.push_str("[^/]*");
            index += 1;
        } else if chars[index] == '?' {
            source.push_str("[^/]");
            index += 1;
        } else {
            source.push_str(&regex::escape(&chars[index].to_string()));
            index += 1;
        }
    }
    Regex::new(&format!("(?i)^{source}$")).ok()
}

/// True when `chars[index..]` starts with exactly `expected`, without panicking when fewer than
/// `expected.len()` characters remain.
fn starts_with_at(chars: &[char], index: usize, expected: &[char]) -> bool {
    chars.get(index..index + expected.len()) == Some(expected)
}

#[must_use]
pub fn has_windows_invalid_path(relative_path: &str) -> bool {
    relative_path.split('/').any(|segment| {
        if segment.is_empty() || segment.ends_with('.') || segment.ends_with(' ') {
            return true;
        }
        if WINDOWS_RESERVED_NAME.is_match(segment) {
            return true;
        }
        segment
            .chars()
            .any(|character| "<>:\"|?*".contains(character) || (character as u32) <= 0x1F)
    })
}

#[must_use]
pub fn find_case_collisions(files: &[FileManifestEntry]) -> Vec<String> {
    let mut seen: HashMap<String, &str> = HashMap::new();
    let mut collisions = Vec::new();
    for entry in files {
        let folded = entry.path.to_lowercase();
        match seen.get(folded.as_str()) {
            Some(&previous) if previous != entry.path => {
                let label = format!("{previous} ↔ {}", entry.path);
                if !collisions.contains(&label) {
                    collisions.push(label);
                }
            }
            Some(_) => {}
            None => {
                seen.insert(folded, &entry.path);
            }
        }
    }
    collisions
}

#[cfg(test)]
mod tests {
    use super::{
        CompareOptions, FileManifest, FileManifestEntry, IgnoreMatcher, Platform, SyncMode,
        compare_manifests, compute_sync_plan, find_case_collisions, has_windows_invalid_path,
    };

    fn manifest(files: Vec<FileManifestEntry>) -> FileManifest {
        FileManifest {
            root_path: "/tmp/test".to_owned(),
            files,
            ignored: 0,
            unreadable: 0,
            truncated: false,
        }
    }

    fn entry(path: &str, size: u64, modified_ms: i64, digest: Option<&str>) -> FileManifestEntry {
        FileManifestEntry {
            path: path.to_owned(),
            size,
            modified_ms,
            digest: digest.map(ToOwned::to_owned),
        }
    }

    #[test]
    fn classifies_identical_one_sided_and_different_files() {
        let local = manifest(vec![
            entry("same.txt", 3, 1, Some("same")),
            entry("local.txt", 10, 2, Some("local")),
            entry("changed.txt", 8, 5, Some("new")),
        ]);
        let remote = manifest(vec![
            entry("same.txt", 3, 1, Some("same")),
            entry("remote.txt", 20, 2, Some("remote")),
            entry("changed.txt", 7, 4, Some("old")),
        ]);

        let preview = compare_manifests(
            &local,
            &remote,
            CompareOptions {
                mode: SyncMode::TwoWay,
                local_platform: Platform::Linux,
                remote_platform: Platform::Windows,
            },
        );

        assert_eq!(preview.identical_files, 1);
        assert_eq!(preview.local_only_files, 1);
        assert_eq!(preview.remote_only_files, 1);
        assert_eq!(preview.different_files, 1);
        assert_eq!(preview.bytes_to_remote, 18);
        assert_eq!(preview.bytes_to_local, 20);
    }

    #[test]
    fn detects_windows_invalid_and_case_colliding_paths() {
        assert!(has_windows_invalid_path("CON.txt"));
        assert!(has_windows_invalid_path("folder/name?.txt"));
        assert_eq!(
            find_case_collisions(&[
                entry("Readme.md", 1, 1, None),
                entry("README.md", 1, 1, None)
            ]),
            vec!["Readme.md ↔ README.md".to_owned()],
        );
    }

    #[test]
    fn ignore_matcher_supports_basename_and_recursive_globs() {
        let matcher = IgnoreMatcher::new(&[
            "node_modules/".to_owned(),
            "*.tmp".to_owned(),
            "build/**".to_owned(),
        ]);
        assert!(matcher.is_ignored("node_modules", true));
        assert!(matcher.is_ignored("cache/file.tmp", false));
        assert!(matcher.is_ignored("build/assets/app.js", false));
        assert!(!matcher.is_ignored("src/app.ts", false));
        // `build/**` must also prune the `build` directory itself, not just match paths
        // underneath it — otherwise a scanner still opens and walks the excluded directory.
        assert!(matcher.is_ignored("build", true));
    }

    /// Precise `**` semantics table: each pattern's directory-pruning and deep-path behaviour
    /// against a root-level match, a nested match, and the paths underneath each. The `false`
    /// results for deep paths under a bare-basename pattern are correct because a real scanner
    /// prunes the whole directory and never queries anything underneath it.
    #[test]
    fn ignore_matcher_matches_the_double_star_semantics_table() {
        let root_dir = ("node_modules", true);
        let nested_dir = ("src/node_modules", true);
        let root_deep_file = ("node_modules/pkg/index.js", false);
        let nested_deep_file = ("src/node_modules/pkg/index.js", false);

        let cases: &[(&str, [bool; 4])] = &[
            ("node_modules", [true, true, false, false]),
            ("node_modules/", [true, true, false, false]),
            ("**/node_modules", [true, true, false, false]),
            ("node_modules/**", [true, false, true, false]),
            ("**/node_modules/**", [true, true, true, true]),
        ];

        for (pattern, expected) in cases {
            let matcher = IgnoreMatcher::new(&[(*pattern).to_owned()]);
            assert_eq!(
                matcher.is_ignored(root_dir.0, root_dir.1),
                expected[0],
                "pattern {pattern:?} against {root_dir:?}"
            );
            assert_eq!(
                matcher.is_ignored(nested_dir.0, nested_dir.1),
                expected[1],
                "pattern {pattern:?} against {nested_dir:?}"
            );
            assert_eq!(
                matcher.is_ignored(root_deep_file.0, root_deep_file.1),
                expected[2],
                "pattern {pattern:?} against {root_deep_file:?}"
            );
            assert_eq!(
                matcher.is_ignored(nested_deep_file.0, nested_deep_file.1),
                expected[3],
                "pattern {pattern:?} against {nested_deep_file:?}"
            );
        }
    }

    #[test]
    fn ignore_matcher_confines_a_directory_glob_to_one_segment() {
        let matcher = IgnoreMatcher::new(&["cache/*.tmp".to_owned()]);
        assert!(matcher.is_ignored("cache/a.tmp", false));
        assert!(!matcher.is_ignored("cache/sub/a.tmp", false));
        assert!(!matcher.is_ignored("other/a.tmp", false));
    }

    #[test]
    fn ignore_matcher_matches_a_basename_glob_at_any_depth() {
        let matcher = IgnoreMatcher::new(&["*.tmp".to_owned()]);
        assert!(matcher.is_ignored("a.tmp", false));
        assert!(matcher.is_ignored("deep/dir/a.tmp", false));
    }

    #[test]
    fn ignore_matcher_matches_double_star_between_literal_segments() {
        let matcher = IgnoreMatcher::new(&["a/**/b".to_owned()]);
        assert!(matcher.is_ignored("a/b", false));
        assert!(matcher.is_ignored("a/x/y/b", false));
        assert!(!matcher.is_ignored("a/c", false));
    }

    #[test]
    fn oversized_patterns_fail_closed_instead_of_reaching_the_regex_compiler() {
        let oversized = "a".repeat(513);
        let error = IgnoreMatcher::try_new(std::slice::from_ref(&oversized))
            .expect_err("an oversized pattern must fail closed");
        assert_eq!(error.pattern, oversized);

        let boundary = "b".repeat(512);
        let matcher = IgnoreMatcher::try_new(&[boundary])
            .expect("a 512-unit pattern stays inside the envelope");
        assert!(!matcher.is_ignored("other.txt", false));
    }

    #[test]
    fn lenient_construction_skips_only_the_uncompilable_rule() {
        let matcher = IgnoreMatcher::new(&["*.tmp".to_owned(), "a".repeat(600)]);
        assert!(matcher.is_ignored("cache/file.tmp", false));
        assert!(!matcher.is_ignored("src/app.ts", false));
    }

    #[test]
    fn lenient_construction_skips_an_oversized_multibyte_pattern() {
        // 171 repetitions of U+754C are 513 UTF-8 bytes: over the envelope despite fitting in
        // 171 characters, so the rule is skipped rather than half-applied.
        let oversized = "界".repeat(171);
        let matcher = IgnoreMatcher::new(std::slice::from_ref(&oversized));
        assert!(!matcher.is_ignored(&oversized, false));
        // 170 repetitions are 510 bytes: inside the envelope and still match.
        let boundary = "界".repeat(170);
        let matcher = IgnoreMatcher::new(std::slice::from_ref(&boundary));
        assert!(matcher.is_ignored(&boundary, false));
    }

    #[test]
    fn question_mark_matches_one_astral_code_point() {
        let matcher = IgnoreMatcher::new(&["?.txt".to_owned()]);
        assert!(matcher.is_ignored("😀.txt", false));
        assert!(!matcher.is_ignored("ab.txt", false));
    }

    #[test]
    fn invalid_pattern_display_truncates_oversized_values() {
        let rendered = format!(
            "{}",
            super::InvalidIgnorePattern {
                pattern: "x".repeat(200),
            }
        );
        assert!(rendered.len() < 200);
        assert!(rendered.contains('…'));
    }

    #[test]
    fn compute_sync_plan_pulls_remote_only_and_skips_conflicting_files() {
        let local = manifest(vec![entry("shared.txt", 3, 1, Some("same"))]);
        let remote = manifest(vec![
            entry("shared.txt", 3, 1, Some("different")),
            entry("new.txt", 5, 1, Some("digest")),
        ]);

        let plan = compute_sync_plan(&local, &remote, SyncMode::TwoWay);
        assert_eq!(plan.to_pull.len(), 1);
        assert_eq!(plan.to_pull[0].path, "new.txt");
        assert_eq!(plan.skipped.len(), 1);
        assert_eq!(plan.skipped[0].path, "shared.txt");
    }

    #[test]
    fn compute_sync_plan_skips_oversized_remote_only_files() {
        let remote = manifest(vec![entry("huge.bin", 9 * 1024 * 1024, 1, None)]);
        let plan = compute_sync_plan(&manifest(vec![]), &remote, SyncMode::TwoWay);
        assert!(plan.to_pull.is_empty());
        assert_eq!(plan.skipped.len(), 1);
        assert!(plan.skipped[0].reason.contains("8 MiB"));
    }

    #[test]
    fn compute_sync_plan_is_empty_for_send_only() {
        let remote = manifest(vec![entry("new.txt", 5, 1, Some("digest"))]);
        let plan = compute_sync_plan(&manifest(vec![]), &remote, SyncMode::SendOnly);
        assert!(plan.to_pull.is_empty());
        assert!(plan.skipped.is_empty());
    }
}
