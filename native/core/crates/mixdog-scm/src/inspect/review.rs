//! The pushed review (DS §5.3): the work tree against the tree captured at the start of a
//! scope, computed once per inspector key. The summary is small and inline; the per-file
//! patches stay here and are paged out to `review/diff/get` from this cache.

#![allow(clippy::disallowed_methods, clippy::disallowed_types, reason = "every blocking std::fs call in this module is the body of a lane job")]

use std::collections::BTreeMap;
use std::collections::HashMap;

use mixdog_core_api::domain::repo::ChangeKind;
use mixdog_core_api::domain::repo::InspectorKey;
use mixdog_core_api::domain::repo::ObjectId;
use mixdog_core_api::domain::repo::ReviewFile;
use mixdog_core_api::domain::repo::ReviewPage;
use mixdog_core_api::domain::repo::ReviewSummary;
use mixdog_rt::MaintenanceIo;
use tokio_util::sync::CancellationToken;

use crate::error::ScmFailure;
use crate::git::Git;
use crate::git::RunOptions;
use crate::git::STATUS_MAX_BYTES;
use crate::inspect::history::DISPLAY_DIFF_ARGS;
use crate::inspect::status::parse_numstat;
use crate::repo::RepoIdentity;
use crate::repo::on_lane;

/// Untracked files a review lists; the rest are not part of it.
/// Patch text kept per review; files past it are listed without a patch.
const PATCH_BUDGET_BYTES: usize = 8_000_000;
/// Patch text of one page.
const PAGE_BYTES: usize = 256 * 1024;

pub struct ReviewEntry {
    pub summary: ReviewSummary,
    patches: Vec<String>,
}

impl ReviewEntry {
    fn index(&self, path: &str) -> Option<usize> {
        self.summary.files.iter().position(|file| file.path == path)
    }

    /// One file's patch, or files from `cursor` (a file index) until the page is full.
    pub fn page(&self, path: Option<&str>, cursor: Option<&str>) -> ReviewPage {
        let key = self.summary.key.clone();
        if let Some(path) = path {
            let patch = self
                .index(path)
                .map(|at| self.patches[at].clone())
                .unwrap_or_default();
            return ReviewPage {
                key,
                patch,
                next_cursor: None,
            };
        }
        let start = cursor.and_then(|value| value.parse::<usize>().ok()).unwrap_or(0);
        let mut patch = String::new();
        let mut at = start;
        while at < self.patches.len() {
            if !patch.is_empty() && patch.len() + self.patches[at].len() > PAGE_BYTES {
                break;
            }
            patch.push_str(&self.patches[at]);
            at += 1;
        }
        ReviewPage {
            key,
            patch,
            next_cursor: (at < self.patches.len()).then(|| at.to_string()),
        }
    }
}

fn change_kind(letter: char) -> ChangeKind {
    match letter {
        'A' => ChangeKind::Added,
        'D' => ChangeKind::Deleted,
        'T' => ChangeKind::TypeChanged,
        'U' => ChangeKind::Conflicted,
        _ => ChangeKind::Modified,
    }
}

/// `git diff --raw --numstat -z` rows by path: the status letter and the line counts.
pub(crate) fn parse_raw_numstat(raw: &str) -> BTreeMap<String, (ChangeKind, u64, u64)> {
    let mut rows: BTreeMap<String, (ChangeKind, u64, u64)> = BTreeMap::new();
    let mut fields = raw.split('\0');
    while let Some(field) = fields.next() {
        if let Some(meta) = field.strip_prefix(':') {
            let Some(path) = fields.next().filter(|path| !path.is_empty()) else {
                continue;
            };
            let letter = meta
                .rsplit(' ')
                .next()
                .and_then(|status| status.chars().next())
                .unwrap_or('M');
            rows.entry(path.to_owned())
                .and_modify(|row| row.0 = change_kind(letter))
                .or_insert((change_kind(letter), 0, 0));
        }
    }
    for (path, (adds, dels)) in parse_numstat(raw) {
        if let Some(row) = rows.get_mut(&path) {
            row.1 = adds;
            row.2 = dels;
        }
    }
    rows
}

/// Splits a unified diff at its `diff --git` headers into path → patch. A path git would
/// quote in a header cannot be matched back and is absent from the result.
fn split_patches(diff: &str, paths: &[&str]) -> HashMap<String, String> {
    let wanted: HashMap<String, &str> = paths
        .iter()
        .map(|path| (format!("diff --git a/{path} b/{path}"), *path))
        .collect();
    let mut out = HashMap::new();
    let mut offset = 0usize;
    let mut starts: Vec<(usize, Option<&str>)> = Vec::new();
    for line in diff.split_inclusive('\n') {
        if line.starts_with("diff --git ") {
            let header = line.trim_end_matches(['\n', '\r']);
            starts.push((offset, wanted.get(header).copied()));
        }
        offset += line.len();
    }
    for (index, (start, path)) in starts.iter().enumerate() {
        let end = starts.get(index + 1).map_or(diff.len(), |next| next.0);
        if let Some(path) = path {
            out.insert((*path).to_owned(), diff[*start..end].to_owned());
        }
    }
    out
}

/// The commit a repository review diffs against: HEAD for uncommitted work, the merge-base with
/// the default branch for the branch view (origin's HEAD, else `origin/main`, `origin/master`,
/// `main`, `master`; HEAD when none exists). An unborn HEAD is diffed against the empty tree.
/// The name is the review's `base` as the pane shows it: the default branch, else `HEAD`.
pub async fn repo_base(
    git: &Git,
    cancel: &CancellationToken,
    root: &std::path::Path,
    source: &str,
) -> Result<(String, ObjectId), ScmFailure> {
    use crate::inspect::history::empty_tree;
    use crate::inspect::history::has_head;
    if !has_head(git, cancel, root).await? {
        return Ok(("HEAD".to_owned(), ObjectId(empty_tree(git, cancel, root).await?)));
    }
    let resolve = |rev: String| async move {
        let output = git
            .outcome(cancel, root, &["--no-optional-locks", "rev-parse", "--verify", "--quiet", &rev], &RunOptions::read())
            .await?;
        Ok::<_, ScmFailure>(output.success().then(|| output.stdout_text().trim().to_owned()))
    };
    if source == "uncommitted" {
        return Ok(("HEAD".to_owned(), ObjectId(resolve("HEAD^{commit}".into()).await?.unwrap_or_default())));
    }
    let origin_head = git
        .outcome(
            cancel,
            root,
            &["--no-optional-locks", "symbolic-ref", "refs/remotes/origin/HEAD"],
            &RunOptions::read(),
        )
        .await?;
    let mut base = origin_head
        .success()
        .then(|| origin_head.stdout_text().trim().trim_start_matches("refs/remotes/").to_owned())
        .filter(|name| !name.is_empty());
    if base.is_none() {
        for (name, full) in [
            ("origin/main", "refs/remotes/origin/main"),
            ("origin/master", "refs/remotes/origin/master"),
            ("main", "refs/heads/main"),
            ("master", "refs/heads/master"),
        ] {
            if resolve(full.to_owned()).await?.is_some() {
                base = Some(name.to_owned());
                break;
            }
        }
    }
    let head = resolve("HEAD^{commit}".into()).await?.unwrap_or_default();
    let Some(base) = base else {
        return Ok(("HEAD".to_owned(), ObjectId(head)));
    };
    let merged = git
        .outcome(cancel, root, &["--no-optional-locks", "merge-base", &base, "HEAD"], &RunOptions::read())
        .await?;
    let found = merged.stdout_text().trim().to_owned();
    let point = if merged.success() && !found.is_empty() { found } else { head };
    Ok((base, ObjectId(point)))
}

/// The tree of the work tree as it is now, untracked files included and ignored ones left out,
/// built in a scratch index so the user's index is never touched.
pub async fn work_tree_tree(
    git: &Git,
    lane: MaintenanceIo,
    cancel: &CancellationToken,
    root: &std::path::Path,
    scratch: &std::path::Path,
) -> Result<String, ScmFailure> {
    static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let dir = scratch.to_path_buf();
    on_lane(lane, cancel, {
        let dir = dir.clone();
        move || std::fs::create_dir_all(dir)
    })
    .await??;
    let index = dir.join(format!(
        "{}-{}.index",
        std::process::id(),
        NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
    ));
    let options = RunOptions {
        index_file: Some(index.clone()),
        ..RunOptions::default()
    };
    let built = async {
        let head = git
            .outcome(cancel, root, &["rev-parse", "--verify", "--quiet", "HEAD^{commit}"], &RunOptions::default())
            .await?;
        if head.success() {
            git.text(cancel, root, &["read-tree", head.stdout_text().trim()], &options).await?;
        } else {
            git.text(cancel, root, &["read-tree", "--empty"], &options).await?;
        }
        // `git add -A` refuses the whole add over a nested repository with no commit ("does not have a commit checked out"), while Node's
        // review (a status scan) lists it as an untracked folder; such a folder is left out of the tree, and the caller adds its row.
        let others = git
            .text(cancel, root, &["--no-optional-locks", "ls-files", "--others", "--exclude-standard", "-z"], &RunOptions::read())
            .await?;
        let mut pathspec: Vec<String> = Vec::new();
        for folder in others.split('\0').filter_map(|record| record.strip_suffix('/')) {
            let head = git
                .outcome(cancel, &root.join(folder), &["rev-parse", "--verify", "--quiet", "HEAD^{commit}"], &RunOptions::default())
                .await?;
            if !head.success() {
                pathspec.push(format!(":(exclude,literal){folder}"));
            }
        }
        let mut add = vec!["add", "-A", "--", "."];
        add.extend(pathspec.iter().map(String::as_str));
        git.text(cancel, root, &add, &options).await?;
        Ok::<_, ScmFailure>(git.text(cancel, root, &["write-tree"], &options).await?.trim().to_owned())
    }
    .await;
    let _ = std::fs::remove_file(&index);
    built
}

pub async fn compute(
    git: &Git,
    lane: MaintenanceIo,
    cancel: &CancellationToken,
    identity: &RepoIdentity,
    key: InspectorKey,
    base: &ObjectId,
    scratch: &std::path::Path,
) -> Result<ReviewEntry, ScmFailure> {
    let root = identity
        .work_tree
        .clone()
        .ok_or(ScmFailure::NotARepository)?;
    let options = RunOptions {
        max_output: Some(STATUS_MAX_BYTES),
        ..RunOptions::read()
    };
    // Both sides are trees: the captured base and the work tree as it is now (untracked files
    // included, ignored ones left out), built in a scratch index. A file the base already held
    // is no change, however git's own index sees it.
    let current = work_tree_tree(git, lane, cancel, &root, scratch).await?;
    let diff_args = ["--no-optional-locks", "diff", "--raw", "--numstat", "-z", "--no-renames", &base.0, &current];
    let raw = git.text(cancel, &root, &diff_args, &options).await?;
    let tracked = parse_raw_numstat(&raw);
    let tracked_paths: Vec<&str> = tracked.keys().map(String::as_str).collect();
    let mut patches = if tracked_paths.is_empty() {
        HashMap::new()
    } else {
        let mut args = vec!["--no-optional-locks", "diff"];
        args.extend(DISPLAY_DIFF_ARGS);
        args.extend(["--no-renames", &base.0, &current]);
        let diff = git.text(cancel, &root, &args, &options).await?;
        split_patches(&diff, &tracked_paths)
    };
    // A header git quoted: ask for that one file alone.
    for path in &tracked_paths {
        if !patches.contains_key(*path) {
            let mut args = vec!["--no-optional-locks", "diff"];
            args.extend(DISPLAY_DIFF_ARGS);
            let literal = format!(":(literal){path}");
            args.extend(["--no-renames", &base.0, &current, "--", &literal]);
            patches.insert((*path).to_owned(), git.text(cancel, &root, &args, &options).await?);
        }
    }
    // Every changed file is listed: the work tree's tree has no cap to omit anything under.
    let omitted = 0u32;
    let mut files = Vec::new();
    let mut bodies = Vec::new();
    let mut spent = 0usize;
    let mut rows: Vec<(String, ChangeKind, u64, u64, String)> = Vec::new();
    for (path, (status, adds, dels)) in &tracked {
        rows.push((
            path.clone(),
            *status,
            *adds,
            *dels,
            patches.remove(path).unwrap_or_default(),
        ));
    }
    rows.sort_by(|left, right| left.0.cmp(&right.0));
    for (path, status, adds, dels, patch) in rows {
        let kept = if spent + patch.len() <= PATCH_BUDGET_BYTES {
            spent += patch.len();
            patch
        } else {
            String::new()
        };
        files.push(ReviewFile {
            path,
            status,
            adds,
            dels,
        });
        bodies.push(kept);
    }
    Ok(ReviewEntry {
        summary: ReviewSummary { key, files, omitted },
        patches: bodies,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn raw_and_numstat_rows_join_by_path() {
        let rows = parse_raw_numstat(
            ":100644 100644 aaa bbb M\0a.txt\0:000000 100644 000 ccc A\0b.txt\02\t1\ta.txt\05\t0\tb.txt\0",
        );
        assert_eq!(rows["a.txt"], (ChangeKind::Modified, 2, 1));
        assert_eq!(rows["b.txt"], (ChangeKind::Added, 5, 0));
    }

    #[test]
    fn patches_split_at_their_headers() {
        let diff = "diff --git a/a.txt b/a.txt\n@@ -1 +1 @@\n-x\n+y\ndiff --git a/b.txt b/b.txt\n@@ -1 +1 @@\n-1\n+2\n";
        let parts = split_patches(diff, &["a.txt", "b.txt"]);
        assert!(parts["a.txt"].ends_with("+y\n"));
        assert!(parts["b.txt"].starts_with("diff --git a/b.txt"));
    }
}
