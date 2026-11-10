//! Read-only history reads of the desktop panes: branches, log, show, diffs, file at a
//! revision, stash list. Text formats are git's own (relative dates included), parsed into the
//! shapes the panes already receive.

#![allow(clippy::disallowed_methods, clippy::disallowed_types, reason = "every blocking std::fs call in this module is the body of a lane job")]

use std::collections::HashSet;
use std::path::Path;
use std::path::PathBuf;

use serde::Serialize;
use tokio_util::sync::CancellationToken;

use crate::error::ScmFailure;
use crate::git::Git;
use crate::git::RunOptions;
use crate::git::nul_records;
use crate::inspect::status::parse_numstat;

pub const DISPLAY_DIFF_ARGS: [&str; 3] = ["--no-ext-diff", "--no-textconv", "--no-color"];

const BRANCH_FORMAT: &str = "--format=%(refname)%00%(refname:short)%00%(HEAD)%00%(upstream:short)\
%00%(committerdate:iso-strict)%00%(committerdate:relative)%00%(ahead-behind:HEAD)";

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GitBranchEntry {
    pub name: String,
    pub current: bool,
    pub remote: bool,
    pub upstream: String,
    pub last_commit_at: String,
    pub last_commit_relative: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ahead: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub behind: Option<u64>,
}

fn compare_names(left: &str, right: &str) -> std::cmp::Ordering {
    left.to_lowercase()
        .cmp(&right.to_lowercase())
        // Lowercase sorts first among spellings of one name.
        .then_with(|| right.cmp(left))
}

pub async fn branches(
    git: &Git,
    cancel: &CancellationToken,
    cwd: &Path,
) -> Result<Vec<GitBranchEntry>, ScmFailure> {
    let raw = git
        .read(
            cancel,
            cwd,
            &["for-each-ref", BRANCH_FORMAT, "refs/heads", "refs/remotes"],
        )
        .await?;
    let mut rows: Vec<GitBranchEntry> = raw
        .lines()
        .filter_map(|line| {
            let mut fields = line.split('\0');
            let reference = fields.next().filter(|value| !value.is_empty())?;
            let name = fields.next().filter(|value| !value.is_empty())?;
            if name.ends_with("/HEAD") {
                return None;
            }
            let head = fields.next().unwrap_or("");
            let upstream = fields.next().unwrap_or("");
            let committed = fields.next().unwrap_or("");
            let relative = fields.next().unwrap_or("");
            let counts = fields.next().unwrap_or("");
            let mut counted = counts.split_whitespace();
            let (ahead, behind) = (counted.next(), counted.next());
            let numbers = match (ahead.and_then(|a| a.parse().ok()), behind.and_then(|b| b.parse().ok())) {
                (Some(a), Some(b)) => Some((a, b)),
                _ => None,
            };
            Some(GitBranchEntry {
                name: name.to_owned(),
                current: head.trim() == "*",
                remote: reference.starts_with("refs/remotes/"),
                upstream: upstream.to_owned(),
                last_commit_at: committed.trim().to_owned(),
                last_commit_relative: relative.trim().to_owned(),
                ahead: numbers.map(|n| n.0),
                behind: numbers.map(|n| n.1),
            })
        })
        .collect();
    rows.sort_by(|left, right| {
        right
            .current
            .cmp(&left.current)
            .then(left.remote.cmp(&right.remote))
            .then_with(|| compare_names(&left.name, &right.name))
    });
    Ok(rows)
}

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GitLogEntry {
    pub hash: String,
    pub short_hash: String,
    pub subject: String,
    pub when: String,
    pub author: String,
    pub authored_at: String,
    pub pushed: bool,
    pub parents: Vec<String>,
    pub refs: Vec<String>,
    pub tags: Vec<String>,
    pub branches: Vec<String>,
    pub remotes: Vec<String>,
}

fn display_ref(value: &str) -> String {
    let value = value.trim();
    let value = value.strip_prefix("HEAD -> ").unwrap_or(value);
    let value = value
        .strip_prefix("tag:")
        .map_or(value, |rest| rest.trim_start());
    for prefix in ["refs/heads/", "refs/remotes/", "refs/tags/"] {
        if let Some(rest) = value.strip_prefix(prefix) {
            return rest.to_owned();
        }
    }
    value.to_owned()
}

#[derive(Default)]
struct DecodedRefs {
    refs: Vec<String>,
    tags: Vec<String>,
    branches: Vec<String>,
    remotes: Vec<String>,
}

fn decode_refs(decorations: &str) -> DecodedRefs {
    let mut decoded = DecodedRefs::default();
    for raw in decorations.split(", ") {
        let entry = raw.trim();
        if entry.is_empty() {
            continue;
        }
        let name = display_ref(entry);
        if name.is_empty() {
            continue;
        }
        decoded.refs.push(name.clone());
        let head = entry.strip_prefix("HEAD -> ").unwrap_or(entry);
        if head.starts_with("tag:") {
            decoded.tags.push(name);
        } else if head.starts_with("refs/remotes/") {
            decoded.remotes.push(name);
        } else if head != "HEAD" {
            decoded.branches.push(name);
        }
    }
    decoded
}

pub async fn log(
    git: &Git,
    cancel: &CancellationToken,
    cwd: &Path,
    query: &str,
    skip: u32,
    limit: u32,
) -> Result<Vec<GitLogEntry>, ScmFailure> {
    let query: String = query.trim().chars().take(200).collect();
    let skip = format!("--skip={skip}");
    let limit = format!("-n{}", limit.clamp(1, 100));
    let grep = format!("--grep={query}");
    let mut args = vec![
        "log",
        "--all",
        "--topo-order",
        "--decorate=full",
        skip.as_str(),
        limit.as_str(),
    ];
    if !query.is_empty() {
        args.push("--regexp-ignore-case");
        args.push(grep.as_str());
    }
    args.push("--pretty=format:%H%x1f%h%x1f%P%x1f%D%x1f%s%x1f%cr%x1f%an%x1f%aI");
    let output = git
        .outcome(cancel, cwd, &args, &RunOptions::read())
        .await?;
    // An empty history reads as []; a cut-off read is an error, never "no commits".
    if !output.success() {
        return Ok(Vec::new());
    }
    let unpushed = unpushed_commits(git, cancel, cwd).await?;
    Ok(output
        .stdout_text()
        .lines()
        .filter(|line| !line.is_empty())
        .map(|line| {
            let mut fields = line.split('\u{1f}');
            let mut next = || fields.next().unwrap_or("").to_owned();
            let hash = next();
            let short_hash = next();
            let parents = next();
            let decorations = next();
            let subject = next();
            let when = next();
            let author = next();
            let authored_at = next();
            let decoded = decode_refs(&decorations);
            GitLogEntry {
                pushed: !unpushed.contains(&hash),
                parents: parents.split_whitespace().map(str::to_owned).collect(),
                hash,
                short_hash,
                subject,
                when,
                author,
                authored_at,
                refs: decoded.refs,
                tags: decoded.tags,
                branches: decoded.branches,
                remotes: decoded.remotes,
            }
        })
        .collect())
}

/// Commits not on the upstream. Without an upstream no commit of HEAD is on a remote.
async fn unpushed_commits(
    git: &Git,
    cancel: &CancellationToken,
    cwd: &Path,
) -> Result<HashSet<String>, ScmFailure> {
    let options = RunOptions::read();
    let with_upstream = git
        .outcome(cancel, cwd, &["rev-list", "@{u}..HEAD"], &options)
        .await?;
    let listed = if with_upstream.success() {
        with_upstream
    } else {
        git.outcome(cancel, cwd, &["rev-list", "HEAD"], &options)
            .await?
    };
    if !listed.success() {
        return Ok(HashSet::new());
    }
    Ok(listed
        .stdout_text()
        .split_whitespace()
        .map(str::to_owned)
        .collect())
}

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GitCommitFile {
    pub path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub old_path: Option<String>,
    pub status: String,
    pub additions: u64,
    pub deletions: u64,
}

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GitCommitDetails {
    pub hash: String,
    pub short_hash: String,
    pub subject: String,
    pub author: String,
    pub email: String,
    pub authored_at: String,
    pub parents: Vec<String>,
    pub files: Vec<GitCommitFile>,
}

fn parse_commit_files(status_raw: &str, numstat_raw: &str) -> Vec<GitCommitFile> {
    let stats = parse_numstat(numstat_raw);
    let mut fields = status_raw.split('\0');
    let mut files = Vec::new();
    while let Some(token) = fields.next() {
        if token.is_empty() {
            continue;
        }
        let status = token.chars().next().unwrap_or('M');
        let old_path = if status == 'R' || status == 'C' {
            fields.next().filter(|value| !value.is_empty()).map(str::to_owned)
        } else {
            None
        };
        let path = fields.next().unwrap_or("");
        if path.is_empty() {
            continue;
        }
        let (additions, deletions) = stats.get(path).copied().unwrap_or((0, 0));
        files.push(GitCommitFile {
            path: path.to_owned(),
            old_path,
            status: status.to_string(),
            additions,
            deletions,
        });
    }
    files
}

pub async fn show(
    git: &Git,
    cancel: &CancellationToken,
    cwd: &Path,
    hash: &str,
) -> Result<GitCommitDetails, ScmFailure> {
    let metadata_args = ["show", "-s", "--format=%H%x1f%h%x1f%s%x1f%an%x1f%ae%x1f%aI%x1f%P", hash];
    let status_args = ["show", "--format=", "--name-status", "-z", "--find-renames", "--first-parent", hash];
    let numstat_args = ["show", "--format=", "--numstat", "-z", "--find-renames", "--first-parent", hash];
    // Promise.all (git-history.ts:298): the three start in this order; the first to fail in time is the failure reported, at once.
    let read = |args: &[&str]| {
        let (git, cancel, cwd) = (git.clone(), cancel.clone(), cwd.to_path_buf());
        let args: Vec<String> = args.iter().map(|arg| (*arg).to_owned()).collect();
        async move { git.read(&cancel, &cwd, &args.iter().map(String::as_str).collect::<Vec<_>>()).await }
    };
    let ((metadata, status_raw), numstat_raw) =
        crate::promise_all::all2(crate::promise_all::all2(read(&metadata_args), read(&status_args)), read(&numstat_args)).await?;
    let mut fields = metadata.trim().split('\u{1f}');
    let full_hash = fields.next().unwrap_or(hash).to_owned();
    let short_hash = fields
        .next()
        .map(str::to_owned)
        .unwrap_or_else(|| hash.chars().take(8).collect());
    let mut text = || fields.next().unwrap_or("").to_owned();
    let subject = text();
    let author = text();
    let email = text();
    let authored_at = text();
    let parents = text();
    Ok(GitCommitDetails {
        hash: full_hash,
        short_hash,
        subject,
        author,
        email,
        authored_at,
        parents: parents.split_whitespace().map(str::to_owned).collect(),
        files: parse_commit_files(&status_raw, &numstat_raw),
    })
}

pub async fn show_diff(
    git: &Git,
    cancel: &CancellationToken,
    cwd: &Path,
    hash: &str,
    path: &str,
) -> Result<String, ScmFailure> {
    let mut args = vec!["show"];
    args.extend(DISPLAY_DIFF_ARGS);
    args.extend(["--format=", "--patch", "--find-renames", "--first-parent", hash, "--", path]);
    git.read(cancel, cwd, &args).await
}

/// File content at `rev`, or `None` when it does not exist there.
pub async fn show_file(
    git: &Git,
    cancel: &CancellationToken,
    cwd: &Path,
    rev: &str,
    path: &str,
) -> Result<Option<String>, ScmFailure> {
    let spec = format!("{rev}:{}", path.replace('\\', "/"));
    let output = git
        .outcome(cancel, cwd, &["show", &spec], &RunOptions::read())
        .await?;
    Ok(output.success().then(|| output.stdout_text()))
}

/// Whether HEAD names a commit; an unborn branch is diffed against the empty tree.
pub async fn has_head(git: &Git, cancel: &CancellationToken, cwd: &Path) -> Result<bool, ScmFailure> {
    Ok(git
        .outcome(cancel, cwd, &["rev-parse", "--verify", "HEAD"], &RunOptions::read())
        .await?
        .success())
}

/// The empty tree of this repository's object format.
pub async fn empty_tree(git: &Git, cancel: &CancellationToken, cwd: &Path) -> Result<String, ScmFailure> {
    let options = RunOptions {
        input: Some(Vec::new()),
        ..RunOptions::read()
    };
    Ok(git
        .text(cancel, cwd, &["--no-optional-locks", "hash-object", "-t", "tree", "--stdin"], &options)
        .await?
        .trim()
        .to_owned())
}

/// The ref uncommitted work is diffed against: HEAD, or the empty tree while unborn.
pub async fn uncommitted_base(
    git: &Git,
    cancel: &CancellationToken,
    cwd: &Path,
) -> Result<String, ScmFailure> {
    if has_head(git, cancel, cwd).await? {
        Ok("HEAD".to_owned())
    } else {
        empty_tree(git, cancel, cwd).await
    }
}

/// A patch for a file that is not tracked yet: every line added.
pub fn untracked_patch(root: &Path, path: &str) -> String {
    // Node's `join(root, path)` appends: an absolute `path` names a place under the root (`C:\repo\C:\outside\x`), never outside it
    // (`Path::join` would replace the root).
    let under_root = PathBuf::from(format!("{}{}{}", root.display(), std::path::MAIN_SEPARATOR, path.trim_start_matches(['/', '\\'])));
    let Ok(bytes) = std::fs::read(under_root) else {
        return String::new();
    };
    if bytes.is_empty() || bytes.contains(&0) {
        return String::new();
    }
    let text = String::from_utf8_lossy(&bytes);
    let mut lines: Vec<&str> = text.split('\n').collect();
    if lines.last() == Some(&"") {
        lines.pop();
    }
    if lines.is_empty() {
        return String::new();
    }
    let mut out = format!(
        "diff --git a/{path} b/{path}\n--- /dev/null\n+++ b/{path}\n@@ -0,0 +1,{} @@\n",
        lines.len()
    );
    for line in lines {
        out.push('+');
        out.push_str(line);
        out.push('\n');
    }
    out
}

pub async fn diff(
    git: &Git,
    cancel: &CancellationToken,
    root: &Path,
    path: &str,
    staged: bool,
    worktree_only: bool,
    untracked: bool,
) -> Result<String, ScmFailure> {
    if untracked {
        return Ok(untracked_patch(root, path));
    }
    let base = if staged {
        "--cached".to_owned()
    } else if worktree_only {
        String::new()
    } else {
        // resolveReviewRef(root, 'uncommitted'): the unborn case hashes the empty tree as Node does.
        crate::phone_review::resolve_review_ref(git, cancel, root, "uncommitted").await?.1
    };
    let mut args = vec!["--no-optional-locks", "diff"];
    args.extend(DISPLAY_DIFF_ARGS);
    if !base.is_empty() {
        args.push(&base);
    }
    args.extend(["--", path]);
    git.read(cancel, root, &args).await
}

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
pub struct GitStashEntry {
    #[serde(rename = "ref")]
    pub reference: String,
    pub message: String,
    pub when: String,
}

pub async fn stash_list(
    git: &Git,
    cancel: &CancellationToken,
    cwd: &Path,
) -> Result<Vec<GitStashEntry>, ScmFailure> {
    let raw = git
        .run(cancel, cwd, &["stash", "list", "--format=%gd%x00%s%x00%cr"])
        .await?;
    Ok(raw
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .filter_map(|line| {
            let mut fields = line.split('\0');
            let reference = fields.next().unwrap_or("");
            reference.starts_with("stash@{").then(|| GitStashEntry {
                reference: reference.to_owned(),
                message: fields.next().unwrap_or("").to_owned(),
                when: fields.next().unwrap_or("").to_owned(),
            })
        })
        .collect())
}

/// Paths of a NUL-separated name list.
pub fn name_list(text: &str) -> Vec<String> {
    nul_records(text).map(str::to_owned).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decorations_split_into_branches_tags_and_remotes() {
        let decoded = decode_refs(
            "HEAD -> refs/heads/main, tag: refs/tags/v1, refs/remotes/origin/main, refs/heads/feature",
        );
        assert_eq!(decoded.refs, ["main", "v1", "origin/main", "feature"]);
        assert_eq!(decoded.tags, ["v1"]);
        assert_eq!(decoded.remotes, ["origin/main"]);
        assert_eq!(decoded.branches, ["main", "feature"]);
    }

    #[test]
    fn name_status_and_numstat_join_by_path() {
        let files = parse_commit_files("M\0a.txt\0R100\0old\0new\0", "2\t1\ta.txt\03\t0\t\0old\0new\0");
        assert_eq!(files[0].additions, 2);
        assert_eq!(files[1].old_path.as_deref(), Some("old"));
        assert_eq!(files[1].path, "new");
        assert_eq!(files[1].additions, 3);
    }

    #[test]
    fn untracked_patch_adds_every_line() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("new.txt"), "untracked\n").unwrap();
        assert_eq!(
            untracked_patch(dir.path(), "new.txt"),
            "diff --git a/new.txt b/new.txt\n--- /dev/null\n+++ b/new.txt\n@@ -0,0 +1,1 @@\n+untracked\n"
        );
    }
}

#[cfg(test)]
mod untracked_join_tests {
    /// An absolute path is read under the root, as Node's `join` places it, never at the place it names.
    #[test]
    fn an_absolute_path_is_not_read_outside_the_root() {
        let root = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let secret = outside.path().join("secret.txt");
        std::fs::write(&secret, "outside\n").unwrap();
        assert_eq!(super::untracked_patch(root.path(), &secret.to_string_lossy()), "");
    }
}
