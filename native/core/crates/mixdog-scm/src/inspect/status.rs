//! `git/status`: one porcelain-v2 scan, the staged and unstaged line counts, the remote
//! summary and the operation in progress, folded into the desktop's `GitStatusResult` and
//! the inspector's `RepoStatus` from the same scan.

#![allow(clippy::disallowed_methods, clippy::disallowed_types, reason = "every blocking std::fs call in this module is the body of a lane job")]

use std::collections::HashMap;
use std::path::Path;
use std::path::PathBuf;

use mixdog_core_api::domain::repo::ChangeKind;
use mixdog_core_api::domain::repo::ObjectId;
use mixdog_core_api::domain::repo::RepoOperation;
use mixdog_core_api::domain::repo::StatusEntry;
use mixdog_core_api::domain::repo::Upstream;
use mixdog_rt::MaintenanceIo;
use serde::Serialize;
use tokio_util::sync::CancellationToken;
use url::Url;

use crate::error::ScmFailure;
use crate::error::scrub_credentials;
use crate::git::Git;
use crate::git::RunOptions;
use crate::git::STATUS_MAX_BYTES;
use crate::git::nul_records;
use crate::repo::RepoIdentity;
use crate::repo::on_lane;
use crate::repo::operation_in_progress;

/// Untracked rows one status lists. Each costs a file read for its line count and a row in
/// every reply, so a tree with hundreds of thousands of them would stall the daemon; the rest
/// are only counted.
pub const UNTRACKED_LIMIT: usize = 1000;
const UNTRACKED_PROBE_BYTES: usize = 8 * 1024;
const UNTRACKED_MAX_BYTES: u64 = 8 * 1024 * 1024;

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GitFileEntry {
    pub path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub old_path: Option<String>,
    pub index: String,
    pub worktree: String,
    pub untracked: bool,
    pub conflicted: bool,
    pub staged_additions: u64,
    pub staged_deletions: u64,
    pub unstaged_additions: u64,
    pub unstaged_deletions: u64,
    pub additions: u64,
    pub deletions: u64,
}

#[derive(Serialize, Clone, Debug, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub struct GitStatusJson {
    pub repository: bool,
    pub root: String,
    pub branch: String,
    pub detached: bool,
    pub unborn: bool,
    pub upstream: bool,
    pub upstream_name: String,
    pub remote: bool,
    pub remote_url: String,
    pub ahead: u64,
    pub behind: u64,
    pub operation: String,
    pub files: Vec<GitFileEntry>,
    pub untracked_omitted: u64,
}

/// What one scan learned; the desktop JSON and the inspector view are projections of it.
#[derive(Clone, Debug)]
pub struct StatusScan {
    pub json: GitStatusJson,
    pub head: Option<ObjectId>,
    pub operation: Option<RepoOperation>,
    pub branch: Option<String>,
    pub upstream: Option<Upstream>,
    pub entries: Vec<StatusEntry>,
}

pub fn path_text(path: &Path) -> String {
    let text = path.to_string_lossy();
    text.strip_prefix(r"\\?\").unwrap_or(&text).to_owned()
}

fn letter(value: Option<char>) -> char {
    match value {
        None | Some('.') => ' ',
        Some(other) => other,
    }
}

fn kind(letter: char) -> ChangeKind {
    match letter {
        'M' => ChangeKind::Modified,
        'A' => ChangeKind::Added,
        'D' => ChangeKind::Deleted,
        'R' => ChangeKind::Renamed,
        'C' => ChangeKind::Copied,
        'T' => ChangeKind::TypeChanged,
        '?' => ChangeKind::Untracked,
        '!' => ChangeKind::Ignored,
        _ => ChangeKind::Unmodified,
    }
}

fn path_after_fields(record: &str, fields: usize) -> &str {
    let mut rest = record;
    for _ in 0..fields {
        match rest.find(' ') {
            Some(at) => rest = &rest[at + 1..],
            None => return "",
        }
    }
    rest
}

struct Parsed {
    files: Vec<GitFileEntry>,
    branch: String,
    oid: String,
    upstream_name: String,
    ahead: u64,
    behind: u64,
    untracked_omitted: u64,
}

fn parse_porcelain(text: &str) -> Parsed {
    let mut parsed = Parsed {
        files: Vec::new(),
        branch: String::new(),
        oid: String::new(),
        upstream_name: String::new(),
        ahead: 0,
        behind: 0,
        untracked_omitted: 0,
    };
    let mut records = nul_records(text);
    let mut listed = 0usize;
    while let Some(record) = records.next() {
        if let Some(value) = record.strip_prefix("# branch.oid ") {
            parsed.oid = value.to_owned();
        } else if let Some(value) = record.strip_prefix("# branch.head ") {
            parsed.branch = value.to_owned();
        } else if let Some(value) = record.strip_prefix("# branch.upstream ") {
            parsed.upstream_name = value.to_owned();
        } else if let Some(value) = record.strip_prefix("# branch.ab ") {
            let mut parts = value.split(' ');
            let number = |part: Option<&str>| {
                part.and_then(|p| p.trim_start_matches(['+', '-']).parse::<u64>().ok())
                    .unwrap_or(0)
            };
            parsed.ahead = number(parts.next());
            parsed.behind = number(parts.next());
        } else if let Some(path) = record.strip_prefix("? ") {
            // Git prints every tracked change before the first untracked path, so everything
            // past the limit is untracked and is counted unread.
            if listed >= UNTRACKED_LIMIT {
                parsed.untracked_omitted += 1;
            } else if !path.is_empty() {
                parsed.files.push(file_entry(path, '?', '?', true, false));
                listed += 1;
            }
        } else if let Some(kind_char) = record.chars().next().filter(|c| matches!(c, '1' | '2' | 'u')) {
            let xy: Vec<char> = record.chars().skip(2).take(2).collect();
            let fields = match kind_char {
                '1' => 8,
                '2' => 9,
                _ => 10,
            };
            let path = path_after_fields(record, fields);
            if path.is_empty() {
                continue;
            }
            let mut file = file_entry(
                path,
                letter(xy.first().copied()),
                letter(xy.get(1).copied()),
                false,
                kind_char == 'u',
            );
            if kind_char == '2' {
                // A rename's origin follows as its own record.
                if let Some(origin) = records.next() {
                    file.old_path = Some(origin.to_owned());
                }
            }
            parsed.files.push(file);
        }
    }
    parsed
}

fn file_entry(path: &str, index: char, worktree: char, untracked: bool, conflicted: bool) -> GitFileEntry {
    GitFileEntry {
        path: path.to_owned(),
        old_path: None,
        index: index.to_string(),
        worktree: worktree.to_string(),
        untracked,
        conflicted,
        staged_additions: 0,
        staged_deletions: 0,
        unstaged_additions: 0,
        unstaged_deletions: 0,
        additions: 0,
        deletions: 0,
    }
}

/// `git diff --numstat -z` rows by path. A rename row has an empty path and is followed by
/// its old and new path.
pub fn parse_numstat(text: &str) -> HashMap<String, (u64, u64)> {
    let mut stats = HashMap::new();
    let mut fields = text.split('\0');
    while let Some(field) = fields.next() {
        let mut parts = field.splitn(3, '\t');
        let (Some(adds), Some(dels), Some(path)) = (parts.next(), parts.next(), parts.next()) else {
            continue;
        };
        let count = |value: &str| match value {
            "-" => Some(0),
            digits => digits.parse::<u64>().ok(),
        };
        let (Some(adds), Some(dels)) = (count(adds), count(dels)) else {
            continue;
        };
        let path = if path.is_empty() {
            let _old = fields.next();
            fields.next().unwrap_or("")
        } else {
            path
        };
        if !path.is_empty() {
            stats.insert(path.to_owned(), (adds, dels));
        }
    }
    stats
}

/// The public form of a remote URL: no credentials, query or fragment.
pub fn public_remote_url(value: &str) -> String {
    let raw = value.trim();
    if raw.is_empty() {
        return String::new();
    }
    match Url::parse(raw) {
        Ok(mut url) if matches!(url.scheme(), "http" | "https" | "ssh") => {
            let _ = url.set_username("");
            let _ = url.set_password(None);
            url.set_query(None);
            url.set_fragment(None);
            url.to_string()
        }
        _ => scrub_credentials(raw),
    }
}

/// `(remote names, primary fetch url)` from `git remote -v`.
fn parse_remotes(text: &str) -> (Vec<String>, String) {
    let mut names: Vec<String> = Vec::new();
    let mut urls: HashMap<String, String> = HashMap::new();
    for line in text.lines() {
        let line = line.trim();
        let mut parts = line.split_whitespace();
        let (Some(name), Some(url), Some(role)) = (parts.next(), parts.next(), parts.next()) else {
            continue;
        };
        if role != "(fetch)" && role != "(push)" {
            continue;
        }
        if !names.iter().any(|known| known == name) {
            names.push(name.to_owned());
        }
        if role == "(fetch)" || !urls.contains_key(name) {
            urls.insert(name.to_owned(), url.to_owned());
        }
    }
    let primary = if names.iter().any(|name| name == "origin") {
        Some("origin".to_owned())
    } else {
        names.first().cloned()
    };
    let url = primary
        .and_then(|name| urls.get(&name).cloned())
        .map(|url| public_remote_url(&url))
        .unwrap_or_default();
    (names, url)
}

/// How long a directory's remote list is kept (GIT_METADATA_TTL_MS, git-read-utils.ts).
const REMOTE_METADATA_TTL: std::time::Duration = std::time::Duration::from_secs(60);

/// The remote names and primary url of a directory, read at most once per [REMOTE_METADATA_TTL] (remoteMetadata in git-status.ts).
/// Node never drops the entry earlier, so a remote added a moment after a status shows in the next one only once the minute is
/// out. A read git fails (no timeout) is kept as "no remotes" for the same time; a timeout is not kept.
pub(crate) async fn remote_metadata(
    git: &Git,
    cancel: &CancellationToken,
    root: &Path,
    options: &RunOptions,
) -> Result<(Vec<String>, String), ScmFailure> {
    // The clock a replay of Node's recording moves only by an explicit advance (seam.rs), never by waiting out the minute.
    let now = crate::seam::cache_clock();
    type Entry = (std::time::Instant, (Vec<String>, String));
    static CACHE: std::sync::OnceLock<std::sync::Mutex<HashMap<String, Entry>>> = std::sync::OnceLock::new();
    let cache = CACHE.get_or_init(Default::default);
    // gitCacheKey: the path, lower-cased on Windows.
    let key = if cfg!(windows) { path_text(root).to_lowercase() } else { path_text(root) };
    if let Some((read_at, value)) = cache.lock().unwrap_or_else(|e| e.into_inner()).get(&key)
        && now.saturating_duration_since(*read_at) < REMOTE_METADATA_TTL
    {
        return Ok(value.clone());
    }
    let text = match git.text(cancel, root, &["--no-optional-locks", "remote", "-v"], options).await {
        Ok(text) => text,
        Err(ScmFailure::Command { .. }) => String::new(),
        Err(other) => return Err(other),
    };
    let value = parse_remotes(&text);
    cache.lock().unwrap_or_else(|e| e.into_inner()).insert(key, (now, value.clone()));
    Ok(value)
}

/// Lines of an untracked file; 0 for what cannot be counted (binary, empty, oversized, gone).
fn untracked_lines(root: &Path, path: &str) -> u64 {
    use std::io::Read;
    let Ok(mut file) = std::fs::File::open(root.join(path)) else {
        return 0;
    };
    let Ok(meta) = file.metadata() else { return 0 };
    if meta.len() == 0 || meta.len() > UNTRACKED_MAX_BYTES {
        return 0;
    }
    let mut data = Vec::with_capacity(meta.len() as usize);
    if file.read_to_end(&mut data).is_err() {
        return 0;
    }
    if data[..data.len().min(UNTRACKED_PROBE_BYTES)].contains(&0) {
        return 0;
    }
    let newlines = data.iter().filter(|byte| **byte == b'\n').count() as u64;
    newlines + u64::from(data.last() != Some(&b'\n'))
}

/// The identity of a work-tree file in a review row (`worktreeRevision`): the parts of Node's
/// `stat(path, { bigint: true })` that libuv fills, `size:mtimeNs:ctimeNs:ino`, or `deleted` when
/// the file is gone. Any write moves the change time even when a tool restores the modify time,
/// and a replacing rename moves the file id.
pub fn worktree_revision(root: &Path, path: &str) -> String {
    revision_of(&root.join(path)).unwrap_or_else(|| "deleted".to_owned())
}

fn revision_text(size: u64, mtime_ns: i128, ctime_ns: i128, ino: u64) -> String {
    format!("{size}:{mtime_ns}:{ctime_ns}:{ino}")
}

#[cfg(unix)]
fn revision_of(path: &Path) -> Option<String> {
    use std::os::unix::fs::MetadataExt;
    let meta = std::fs::metadata(path).ok()?;
    let nanos = |seconds: i64, nsec: i64| i128::from(seconds) * 1_000_000_000 + i128::from(nsec);
    let (mtime_ns, ctime_ns, ino) = crate::seam::file_identity(
        path,
        (nanos(meta.mtime(), meta.mtime_nsec()), nanos(meta.ctime(), meta.ctime_nsec()), meta.ino()),
    );
    Some(revision_text(meta.size(), mtime_ns, ctime_ns, ino))
}

/// libuv's `FILETIME_TO_TIMESPEC`: 100 ns ticks since 1601 as nanoseconds since the Unix epoch.
#[cfg(any(windows, test))]
fn filetime_ns(ticks: i64) -> i128 {
    (i128::from(ticks) - 116_444_736_000_000_000) * 100
}

/// libuv's `fs__stat_handle` field sources on Windows: the handle is opened for attributes only
/// with backup semantics (a directory opens too), `st_size` is the standard info's `EndOfFile`,
/// `st_mtim` the basic info's `LastWriteTime`, `st_ctim` its `ChangeTime`, and `st_ino` the
/// 64-bit file index (`FILE_INTERNAL_INFORMATION.IndexNumber`, the same value as
/// `nFileIndexHigh`/`nFileIndexLow`).
#[cfg(windows)]
fn revision_of(path: &Path) -> Option<String> {
    use std::ffi::c_void;
    use std::os::windows::fs::OpenOptionsExt;
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::Storage::FileSystem::BY_HANDLE_FILE_INFORMATION;
    use windows_sys::Win32::Storage::FileSystem::FILE_BASIC_INFO;
    use windows_sys::Win32::Storage::FileSystem::FILE_FLAG_BACKUP_SEMANTICS;
    use windows_sys::Win32::Storage::FileSystem::FILE_READ_ATTRIBUTES;
    use windows_sys::Win32::Storage::FileSystem::FILE_SHARE_DELETE;
    use windows_sys::Win32::Storage::FileSystem::FILE_SHARE_READ;
    use windows_sys::Win32::Storage::FileSystem::FILE_SHARE_WRITE;
    use windows_sys::Win32::Storage::FileSystem::FILE_STANDARD_INFO;
    use windows_sys::Win32::Storage::FileSystem::FileBasicInfo;
    use windows_sys::Win32::Storage::FileSystem::FileStandardInfo;
    use windows_sys::Win32::Storage::FileSystem::GetFileInformationByHandle;
    use windows_sys::Win32::Storage::FileSystem::GetFileInformationByHandleEx;
    let file = std::fs::OpenOptions::new()
        .access_mode(FILE_READ_ATTRIBUTES)
        .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE)
        .custom_flags(FILE_FLAG_BACKUP_SEMANTICS)
        .open(path)
        .ok()?;
    let handle = file.as_raw_handle();
    // SAFETY: `handle` is open for the whole block; each call fills a zeroed out-struct of the
    // exact size it is told.
    unsafe {
        let mut basic: FILE_BASIC_INFO = std::mem::zeroed();
        let mut standard: FILE_STANDARD_INFO = std::mem::zeroed();
        let mut index: BY_HANDLE_FILE_INFORMATION = std::mem::zeroed();
        let basic_read = GetFileInformationByHandleEx(
            handle,
            FileBasicInfo,
            std::ptr::from_mut(&mut basic).cast::<c_void>(),
            std::mem::size_of::<FILE_BASIC_INFO>() as u32,
        );
        let standard_read = GetFileInformationByHandleEx(
            handle,
            FileStandardInfo,
            std::ptr::from_mut(&mut standard).cast::<c_void>(),
            std::mem::size_of::<FILE_STANDARD_INFO>() as u32,
        );
        if basic_read == 0 || standard_read == 0 || GetFileInformationByHandle(handle, &mut index) == 0 {
            return None;
        }
        let (mtime_ns, ctime_ns, ino) = crate::seam::file_identity(
            path,
            (
                filetime_ns(basic.LastWriteTime),
                filetime_ns(basic.ChangeTime),
                (u64::from(index.nFileIndexHigh) << 32) | u64::from(index.nFileIndexLow),
            ),
        );
        Some(revision_text(
            standard.EndOfFile as u64,
            mtime_ns,
            ctime_ns,
            ino,
        ))
    }
}
/// A folder outside any repository.
pub fn not_a_repository() -> GitStatusJson {
    GitStatusJson::default()
}

/// Scans the work tree at `root`. Without `line_stats` no file has add/delete counts (the
/// numstat reads and the untracked line counts are skipped), as the pane's `skipLineStats` asks.
pub async fn scan(
    git: &Git,
    lane: MaintenanceIo,
    cancel: &CancellationToken,
    identity: &RepoIdentity,
    head: Option<ObjectId>,
    line_stats: bool,
) -> Result<StatusScan, ScmFailure> {
    let root = identity
        .work_tree
        .clone()
        .ok_or(ScmFailure::NotARepository)?;
    let read = RunOptions::read();
    let status_options = RunOptions {
        max_output: Some(STATUS_MAX_BYTES),
        ..RunOptions::read()
    };
    // git-status.ts starts every read at once (the listing, both numstats, the remote list, the work-tree root) and leaves the
    // siblings of a failed one running, so a git that cannot start is attempted by each of them: `join!`, not `try_join!`,
    // which would drop the others at the first failure. The first failure in this order is the one reported.
    let (porcelain, staged, unstaged, remotes, top_level) = tokio::join!(
        git.text(
            cancel,
            &root,
            &[
                "--no-optional-locks",
                "status",
                "--porcelain=v2",
                "-z",
                "--branch",
                "--untracked-files=all",
            ],
            &status_options,
        ),
        async {
            if line_stats {
                git.text(cancel, &root, &["--no-optional-locks", "diff", "--cached", "--numstat", "-z"], &read)
                    .await
            } else {
                Ok(String::new())
            }
        },
        async {
            if line_stats {
                git.text(cancel, &root, &["--no-optional-locks", "diff", "--numstat", "-z"], &read).await
            } else {
                Ok(String::new())
            }
        },
        remote_metadata(git, cancel, &root, &read),
        // cachedGitRoot: asked for its failure only (a timeout or a git that cannot start); the root itself is the identity's.
        git.text(cancel, &root, &["--no-optional-locks", "rev-parse", "--show-toplevel"], &read),
    );
    let (porcelain, staged, unstaged, remotes) = (porcelain?, staged?, unstaged?, remotes?);
    match top_level {
        Err(failure @ (ScmFailure::Unavailable { .. } | ScmFailure::TimedOut { .. })) => return Err(failure),
        _ => {}
    }
    let mut parsed = parse_porcelain(&porcelain);
    let staged = parse_numstat(&staged);
    let unstaged = parse_numstat(&unstaged);
    let (remote_names, remote_url) = remotes;
    let git_dir = identity.git_dir.clone();
    let operation = on_lane(lane, cancel, move || operation_in_progress(&git_dir)).await?;
    let untracked_paths: Vec<String> = parsed
        .files
        .iter()
        .filter(|file| line_stats && file.untracked)
        .map(|file| file.path.clone())
        .collect();
    let counted_root: PathBuf = root.clone();
    let untracked_counts = on_lane(lane, cancel, move || {
        untracked_paths
            .into_iter()
            .map(|path| {
                let lines = untracked_lines(&counted_root, &path);
                (path, lines)
            })
            .collect::<HashMap<_, _>>()
    })
    .await?;
    for file in &mut parsed.files {
        let staged_row = staged.get(&file.path).copied().unwrap_or((0, 0));
        let unstaged_row = unstaged.get(&file.path).copied().unwrap_or((0, 0));
        file.staged_additions = staged_row.0;
        file.staged_deletions = staged_row.1;
        file.unstaged_additions = if file.untracked {
            untracked_counts.get(&file.path).copied().unwrap_or(0)
        } else {
            unstaged_row.0
        };
        file.unstaged_deletions = unstaged_row.1;
        file.additions = file.staged_additions + file.unstaged_additions;
        file.deletions = file.staged_deletions + file.unstaged_deletions;
    }
    let unborn = parsed.oid == "(initial)";
    let detached = parsed.branch == "(detached)";
    let branch = if detached {
        if !parsed.oid.is_empty() && !unborn {
            format!("HEAD ({})", &parsed.oid[..parsed.oid.len().min(8)])
        } else {
            "Detached HEAD".to_owned()
        }
    } else {
        parsed.branch.clone()
    };
    let entries = parsed.files.iter().map(entry_view).collect();
    let upstream = (!parsed.upstream_name.is_empty()).then(|| Upstream {
        name: parsed.upstream_name.clone(),
        ahead: parsed.ahead as u32,
        behind: parsed.behind as u32,
    });
    let json = GitStatusJson {
        repository: true,
        root: path_text(&root),
        branch: branch.clone(),
        detached,
        unborn,
        upstream: upstream.is_some(),
        upstream_name: parsed.upstream_name,
        remote: !remote_names.is_empty(),
        remote_url,
        ahead: parsed.ahead,
        behind: parsed.behind,
        operation: operation_text(operation).to_owned(),
        files: parsed.files,
        untracked_omitted: parsed.untracked_omitted,
    };
    Ok(StatusScan {
        json,
        head,
        operation,
        branch: (!detached).then_some(branch),
        upstream,
        entries,
    })
}

fn entry_view(file: &GitFileEntry) -> StatusEntry {
    let first = file.index.chars().next().unwrap_or(' ');
    let second = file.worktree.chars().next().unwrap_or(' ');
    let (index, worktree) = if file.conflicted {
        (ChangeKind::Conflicted, ChangeKind::Conflicted)
    } else {
        (kind(first), kind(second))
    };
    StatusEntry {
        path: file.path.clone(),
        orig_path: file.old_path.clone(),
        index,
        worktree,
    }
}

/// The desktop's `operation` string; bisect is not one of the four it shows.
pub fn operation_text(operation: Option<RepoOperation>) -> &'static str {
    match operation {
        Some(RepoOperation::Merge) => "merge",
        Some(RepoOperation::Rebase) => "rebase",
        Some(RepoOperation::CherryPick) => "cherry-pick",
        Some(RepoOperation::Revert) => "revert",
        Some(RepoOperation::Bisect) | None => "",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Node's `worktreeRevision` strings, recorded by `fixtures/desktop/revision/record.mjs`: the
    /// tick counts libuv reads are the recorded nanoseconds back at 100 ns resolution.
    #[test]
    fn a_revision_is_node_s_string_for_the_recorded_stat() {
        let recorded: serde_json::Value = serde_json::from_str(include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../fixtures/desktop/revision/corpus.json"
        )))
        .unwrap();
        for case in recorded["cases"].as_array().unwrap() {
            let number = |key: &str| case[key].as_str().unwrap().parse::<i128>().unwrap();
            let ticks = |key: &str| (number(key) / 100 + 116_444_736_000_000_000) as i64;
            assert_eq!(filetime_ns(ticks("mtimeNs")), number("mtimeNs"), "{}", case["name"]);
            assert_eq!(filetime_ns(ticks("ctimeNs")), number("ctimeNs"), "{}", case["name"]);
            let text = revision_text(number("size") as u64, number("mtimeNs"), number("ctimeNs"), number("ino") as u64);
            assert_eq!(text, case["revision"].as_str().unwrap(), "{}", case["name"]);
        }
    }

    /// The live read on this host agrees with `std` where `std` exposes the field.
    #[test]
    fn a_revision_read_matches_std_metadata() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("f.txt"), "hello").unwrap();
        let revision = worktree_revision(dir.path(), "f.txt");
        let parts: Vec<&str> = revision.split(':').collect();
        assert_eq!(parts.len(), 4, "{revision}");
        assert_eq!(parts[0], "5");
        let modified = std::fs::metadata(dir.path().join("f.txt")).unwrap().modified().unwrap();
        let nanos = modified.duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
        assert_eq!(parts[1].parse::<u128>().unwrap(), nanos);
        assert!(parts[2].parse::<u128>().unwrap() > 0 && parts[3].parse::<u64>().unwrap() > 0);
        // A directory opens too (libuv's backup semantics); a missing file is `deleted`.
        std::fs::create_dir(dir.path().join("sub")).unwrap();
        assert_eq!(worktree_revision(dir.path(), "sub").split(':').count(), 4);
        assert_eq!(worktree_revision(dir.path(), "missing"), "deleted");
    }
    #[test]
    fn porcelain_v2_rows_become_file_entries() {
        let text = "# branch.oid 0123456789abcdef\0# branch.head main\0# branch.upstream origin/main\0# branch.ab +2 -1\0\
1 .M N... 100644 100644 100644 aaa bbb a.txt\0\
2 R. N... 100644 100644 100644 aaa bbb R100 new name.txt\0old name.txt\0\
u UU N... 100644 100644 100644 100644 aaa bbb ccc conflict.txt\0\
? new.txt\0";
        let parsed = parse_porcelain(text);
        assert_eq!((parsed.ahead, parsed.behind), (2, 1));
        let paths: Vec<_> = parsed.files.iter().map(|f| f.path.as_str()).collect();
        assert_eq!(paths, ["a.txt", "new name.txt", "conflict.txt", "new.txt"]);
        assert_eq!(parsed.files[0].worktree, "M");
        assert_eq!(parsed.files[0].index, " ");
        assert_eq!(parsed.files[1].old_path.as_deref(), Some("old name.txt"));
        assert!(parsed.files[2].conflicted);
        assert!(parsed.files[3].untracked);
    }

    #[test]
    fn untracked_rows_past_the_limit_are_only_counted() {
        let mut text = String::new();
        for n in 0..UNTRACKED_LIMIT + 3 {
            text.push_str(&format!("? f{n}\0"));
        }
        let parsed = parse_porcelain(&text);
        assert_eq!(parsed.files.len(), UNTRACKED_LIMIT);
        assert_eq!(parsed.untracked_omitted, 3);
    }

    #[test]
    fn numstat_reads_renames_and_binary_rows() {
        let stats = parse_numstat("1\t0\ta.txt\0-\t-\timg.png\03\t1\t\0old\0new\0");
        assert_eq!(stats["a.txt"], (1, 0));
        assert_eq!(stats["img.png"], (0, 0));
        assert_eq!(stats["new"], (3, 1));
    }

    #[test]
    fn remote_urls_lose_credentials() {
        let (names, url) = parse_remotes(
            "origin\thttps://user:pw@example.com/a/b.git?token=x#f (fetch)\norigin\thttps://example.com/a/b.git (push)\n",
        );
        assert_eq!(names, ["origin"]);
        assert_eq!(url, "https://example.com/a/b.git");
    }
}
