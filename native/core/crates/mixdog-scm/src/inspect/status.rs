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

/// A folder outside any repository.
pub fn not_a_repository() -> GitStatusJson {
    GitStatusJson::default()
}

/// Scans the work tree at `root`.
pub async fn scan(
    git: &Git,
    lane: MaintenanceIo,
    cancel: &CancellationToken,
    identity: &RepoIdentity,
    head: Option<ObjectId>,
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
    let (porcelain, staged, unstaged, remotes) = tokio::try_join!(
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
        git.text(
            cancel,
            &root,
            &["--no-optional-locks", "diff", "--cached", "--numstat", "-z"],
            &read,
        ),
        git.text(
            cancel,
            &root,
            &["--no-optional-locks", "diff", "--numstat", "-z"],
            &read
        ),
        git.text(cancel, &root, &["--no-optional-locks", "remote", "-v"], &read),
    )?;
    let mut parsed = parse_porcelain(&porcelain);
    let staged = parse_numstat(&staged);
    let unstaged = parse_numstat(&unstaged);
    let (remote_names, remote_url) = parse_remotes(&remotes);
    let git_dir = identity.git_dir.clone();
    let operation = on_lane(lane, cancel, move || operation_in_progress(&git_dir)).await?;
    let untracked_paths: Vec<String> = parsed
        .files
        .iter()
        .filter(|file| file.untracked)
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
