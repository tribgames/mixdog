//! The phone's repository review, as git-history.ts reads it (`gitReview`, `gitReviewDiff`, `gitReviewDiffs`).
//!
//! One status scan names the files that can differ from the diff base; only those whose status record or work-tree identity moved
//! (or whose row is older than [REVIEW_REVALIDATE]) are diffed again, limited to their paths, and the rest keep their cached row.
//! The commands, their order and the caches that decide whether one runs are Node's: nothing here writes an object into the
//! repository, and which command a call starts depends on what an earlier call left in these caches.

#![allow(clippy::disallowed_methods, clippy::disallowed_types, reason = "every blocking std::fs call in this module is the body of a lane job")]

use std::collections::HashMap;
use std::path::Path;
use std::sync::Mutex;
use std::sync::OnceLock;
use std::time::Duration;
use std::time::Instant;

use indexmap::IndexMap;
use mixdog_rt::MaintenanceIo;
use serde_json::Value;
use serde_json::json;
use tokio_util::sync::CancellationToken;

use crate::error::ScmFailure;
use crate::git::Git;
use crate::git::RunOptions;
use crate::inspect::history::DISPLAY_DIFF_ARGS;
use crate::inspect::history::untracked_patch;
use crate::inspect::review::parse_raw_numstat;
use crate::inspect::status::cache_key;
use crate::inspect::status::cached_git_root;
use crate::inspect::status::untracked_lines;
use crate::inspect::status::worktree_revision;
use crate::repo::on_lane;

/// Untracked files a review lists; the rest are only counted.
const REVIEW_UNTRACKED_LIMIT: usize = 256;
/// Output the review's status scan may produce before it fails instead of buffering more.
const REVIEW_STATUS_MAX_BYTES: u64 = 64 * 1024 * 1024;
/// Total patch text one batch returns before the remaining files are omitted.
const REVIEW_BATCH_PATCH_CHARS: usize = 8_000_000;
/// Pathspec text one batch passes on the command line (Windows caps it near 32k).
const REVIEW_BATCH_ARGS_CHARS: usize = 20_000;
const REVIEW_CACHE_MAX: usize = 16;
/// A cached row older than this is read again even when its identity stands.
const REVIEW_REVALIDATE: Duration = Duration::from_secs(30);
/// GIT_METADATA_TTL_MS: how long the default branch name is kept.
const METADATA_TTL: Duration = Duration::from_secs(60);

type Record = (String, u64, u64);

#[derive(Clone)]
struct TrackedEntry {
    key: String,
    record: Option<Record>,
    checked_at: Instant,
}

#[derive(Clone)]
struct UntrackedEntry {
    revision: String,
    additions: u64,
    checked_at: Instant,
}

#[derive(Clone, Default)]
struct ReviewCache {
    ref_key: String,
    tracked: IndexMap<String, TrackedEntry>,
    untracked: IndexMap<String, UntrackedEntry>,
}

#[derive(Default)]
struct Caches {
    base: HashMap<String, (Instant, String)>,
    reviews: IndexMap<String, ReviewCache>,
    committed: IndexMap<String, Vec<String>>,
    empty_tree: IndexMap<String, String>,
}

fn caches() -> std::sync::MutexGuard<'static, Caches> {
    static CACHES: OnceLock<Mutex<Caches>> = OnceLock::new();
    CACHES.get_or_init(Default::default).lock().unwrap_or_else(|e| e.into_inner())
}

/// boundedSet: the newest entry last, the oldest out past the bound.
fn bounded_set<V>(map: &mut IndexMap<String, V>, key: String, value: V) {
    map.shift_remove(&key);
    map.insert(key, value);
    while map.len() > REVIEW_CACHE_MAX {
        map.shift_remove_index(0);
    }
}

fn is_timeout(failure: &ScmFailure) -> bool {
    matches!(failure, ScmFailure::TimedOut { .. })
}

/// A failed read that is not a deadline: Node's `catch` falls through to its default.
fn or_default<T>(result: Result<T, ScmFailure>, default: T) -> Result<T, ScmFailure> {
    match result {
        Err(failure) if is_timeout(&failure) => Err(failure),
        Err(_) => Ok(default),
        Ok(value) => Ok(value),
    }
}

async fn hash_empty_tree(git: &Git, cancel: &CancellationToken, root: &Path) -> Result<String, ScmFailure> {
    Ok(git
        .text(cancel, root, &["--no-optional-locks", "hash-object", "-t", "tree", "/dev/null"], &RunOptions::read())
        .await?
        .trim()
        .to_owned())
}

async fn cached_empty_tree(git: &Git, cancel: &CancellationToken, root: &Path) -> Result<String, ScmFailure> {
    let key = cache_key(root);
    if let Some(tree) = caches().empty_tree.get(&key) {
        return Ok(tree.clone());
    }
    let tree = hash_empty_tree(git, cancel, root).await?;
    bounded_set(&mut caches().empty_tree, key, tree.clone());
    Ok(tree)
}

/// `hasHead`: false reads as an unborn HEAD; only a deadline is an error.
async fn has_head(git: &Git, cancel: &CancellationToken, root: &Path) -> Result<bool, ScmFailure> {
    or_default(
        git.text(cancel, root, &["rev-parse", "--verify", "HEAD"], &RunOptions::read()).await.map(|_| true),
        false,
    )
}

/// `resolveReviewBase`: the default branch name, kept for the metadata TTL.
async fn resolve_review_base(git: &Git, cancel: &CancellationToken, cwd: &Path) -> Result<String, ScmFailure> {
    let key = cache_key(cwd);
    let kept = caches().base.get(&key).filter(|(expires, _)| *expires > crate::seam::cache_clock()).map(|(_, base)| base.clone());
    if let Some(base) = kept {
        return Ok(base);
    }
    let remember = |base: String| {
        caches().base.insert(key.clone(), (crate::seam::cache_clock() + METADATA_TTL, base.clone()));
        base
    };
    let read = RunOptions::read();
    match git.text(cancel, cwd, &["--no-optional-locks", "symbolic-ref", "refs/remotes/origin/HEAD"], &read).await {
        Ok(head) => {
            let short = head.trim().strip_prefix("refs/remotes/").unwrap_or(head.trim()).to_owned();
            if !short.is_empty() {
                return Ok(remember(short));
            }
        }
        // A timeout must not settle (and cache) the fallback base.
        Err(failure) if is_timeout(&failure) => return Err(failure),
        Err(_) => {}
    }
    for (candidate, full) in [
        ("origin/main", "refs/remotes/origin/main"),
        ("origin/master", "refs/remotes/origin/master"),
        ("main", "refs/heads/main"),
        ("master", "refs/heads/master"),
    ] {
        match git.text(cancel, cwd, &["--no-optional-locks", "rev-parse", "--verify", "--quiet", full], &read).await {
            Ok(_) => return Ok(remember(candidate.to_owned())),
            Err(failure) if is_timeout(&failure) => return Err(failure),
            Err(_) => {}
        }
    }
    Ok(remember("HEAD".to_owned()))
}

/// `resolveMergeBase`: `base` is the default-branch name, `ref` its merge-base sha with HEAD.
async fn resolve_merge_base(git: &Git, cancel: &CancellationToken, cwd: &Path) -> Result<(String, String), ScmFailure> {
    let base = resolve_review_base(git, cancel, cwd).await?;
    if base == "HEAD" {
        return Ok((base, "HEAD".to_owned()));
    }
    let merged = or_default(
        git.text(cancel, cwd, &["--no-optional-locks", "merge-base", &base, "HEAD"], &RunOptions::read())
            .await
            .map(|text| text.trim().to_owned()),
        String::new(),
    )?;
    let reference = if merged.is_empty() { "HEAD".to_owned() } else { merged };
    Ok((base, reference))
}

/// `resolveReviewRef`: HEAD for uncommitted work, the merge-base for the branch view, the empty tree while HEAD is unborn.
pub(crate) async fn resolve_review_ref(git: &Git, cancel: &CancellationToken, root: &Path, source: &str) -> Result<(String, String), ScmFailure> {
    if !has_head(git, cancel, root).await? {
        return Ok(("HEAD".to_owned(), hash_empty_tree(git, cancel, root).await?));
    }
    if source == "uncommitted" {
        return Ok(("HEAD".to_owned(), "HEAD".to_owned()));
    }
    resolve_merge_base(git, cancel, root).await
}

struct ReviewStatus {
    head: String,
    /// Tracked path → its status record: every path whose work tree may differ from HEAD.
    tracked: IndexMap<String, String>,
    untracked: Vec<String>,
    untracked_omitted: usize,
}

fn path_after(record: &str, fields: usize) -> &str {
    let mut rest = record;
    for _ in 0..fields {
        match rest.find(' ') {
            Some(at) => rest = &rest[at + 1..],
            None => return "",
        }
    }
    rest
}

/// `reviewStatus`: one `status --porcelain=v2` scan. A failed scan rejects: its answer is unknown, never "no changes".
async fn review_status(git: &Git, cancel: &CancellationToken, root: &Path) -> Result<ReviewStatus, ScmFailure> {
    let options = RunOptions { max_output: Some(REVIEW_STATUS_MAX_BYTES), ..RunOptions::read() };
    let text = git
        .text(
            cancel,
            root,
            &["--no-optional-locks", "status", "--porcelain=v2", "-z", "--branch", "--no-ahead-behind", "--untracked-files=all", "--no-renames"],
            &options,
        )
        .await?;
    let mut result = ReviewStatus { head: String::new(), tracked: IndexMap::new(), untracked: Vec::new(), untracked_omitted: 0 };
    let mut rename: Option<&str> = None;
    for record in text.split('\0') {
        if let Some(rename_record) = rename.take() {
            // The origin field of a rename: both sides map to its record.
            if !record.is_empty() {
                result.tracked.insert(record.to_owned(), rename_record.to_owned());
            }
            continue;
        }
        if record.is_empty() {
            continue;
        }
        if let Some(oid) = record.strip_prefix("# branch.oid ") {
            result.head = oid.to_owned();
        } else if let Some(path) = record.strip_prefix("? ") {
            // Git prints every untracked path after the tracked changes, so the rest is only counted.
            if result.untracked.len() >= REVIEW_UNTRACKED_LIMIT {
                result.untracked_omitted += 1;
            } else {
                result.untracked.push(path.to_owned());
            }
        } else if record.starts_with("1 ") {
            result.tracked.insert(path_after(record, 8).to_owned(), record.to_owned());
        } else if record.starts_with("u ") {
            result.tracked.insert(path_after(record, 10).to_owned(), record.to_owned());
        } else if record.starts_with("2 ") {
            result.tracked.insert(path_after(record, 9).to_owned(), record.to_owned());
            rename = Some(record);
        }
    }
    Ok(result)
}

/// Paths a branch review's base and HEAD differ in: committed changes a work-tree status cannot name. Both are commit ids, so the
/// answer is kept.
async fn committed_paths(git: &Git, cancel: &CancellationToken, root: &Path, reference: &str, head: &str) -> Result<Vec<String>, ScmFailure> {
    let key = format!("{}\0{reference}\0{head}", cache_key(root));
    let kept = caches().committed.get(&key).cloned();
    if let Some(paths) = kept {
        return Ok(paths);
    }
    let raw = git
        .text(cancel, root, &["--no-optional-locks", "diff", "--name-only", "-z", "--no-renames", reference, head], &RunOptions::read())
        .await?;
    let paths: Vec<String> = raw.split('\0').filter(|path| !path.is_empty()).map(str::to_owned).collect();
    bounded_set(&mut caches().committed, key, paths.clone());
    Ok(paths)
}

fn utf16_len(text: &str) -> usize {
    text.encode_utf16().count()
}

/// Re-reads the rows of `stale` paths against `reference`; `whole` when the path list outgrew the command line and the whole diff
/// was read instead.
async fn diff_stale_rows(
    git: &Git,
    cancel: &CancellationToken,
    root: &Path,
    reference: &str,
    stale: &[String],
) -> Result<(IndexMap<String, Record>, bool), ScmFailure> {
    let arg_chars: usize = stale.iter().map(|path| utf16_len(path) + 3).sum();
    let whole = arg_chars > REVIEW_BATCH_ARGS_CHARS;
    let mut args = vec!["-c", "core.quotePath=false", "--no-optional-locks", "--literal-pathspecs", "diff", reference, "--raw", "--numstat", "--no-renames", "-z"];
    if !whole {
        args.push("--");
        args.extend(stale.iter().map(String::as_str));
    }
    let raw = git.text(cancel, root, &args, &RunOptions::read()).await?;
    let records = parse_raw_numstat(&raw)
        .into_iter()
        .map(|(path, (kind, adds, dels))| (path, (crate::service::kind_letter(kind).to_owned(), adds, dels)))
        .collect();
    Ok((records, whole))
}

fn not_a_repository() -> Value {
    json!({ "repository": false, "root": "", "base": "", "files": [], "untrackedOmitted": 0 })
}

/// `gitReview(cwd, source)`: the review rows of the work tree against the diff base.
pub async fn git_review(git: &Git, lane: MaintenanceIo, cancel: &CancellationToken, cwd: &Path, source: &str) -> Result<Value, ScmFailure> {
    let root = match cached_git_root(git, cancel, cwd).await {
        Ok(root) => root,
        Err(failure) if is_timeout(&failure) => return Err(failure),
        Err(_) => return Ok(not_a_repository()),
    };
    let root_path = Path::new(&root);
    // The merge-base read runs beside the status scan; an unborn HEAD drops it.
    let (status, merge_base) = tokio::join!(biased; review_status(git, cancel, root_path), async {
        if source == "uncommitted" { Ok(None) } else { resolve_merge_base(git, cancel, root_path).await.map(Some) }
    });
    let status = status?;
    let merge_base = merge_base?;
    let unborn = status.head.is_empty() || status.head == "(initial)";
    let mut base = "HEAD".to_owned();
    let mut reference = "HEAD".to_owned();
    if unborn {
        reference = cached_empty_tree(git, cancel, root_path).await?;
    } else if let Some((merged_base, merged_ref)) = merge_base {
        (base, reference) = (merged_base, merged_ref);
    }
    // Every path the work tree can differ from `reference` in: a status candidate, or (base ≠ HEAD) a path the commits since the
    // base touched.
    let mut candidates = status.tracked.clone();
    if !unborn && reference != "HEAD" && reference != status.head {
        let committed = or_default(committed_paths(git, cancel, root_path, &reference, &status.head).await, Vec::new())?;
        for path in committed {
            candidates.entry(path).or_default();
        }
    }
    let tracked_paths: Vec<String> = candidates.keys().cloned().collect();
    let untracked_paths = status.untracked.clone();
    let all_paths: Vec<String> = tracked_paths.iter().chain(&untracked_paths).cloned().collect();
    let revisions: HashMap<String, String> = on_lane(lane, cancel, {
        let root = root.clone();
        let all_paths = all_paths.clone();
        move || {
            all_paths
                .into_iter()
                .map(|path| {
                    let revision = worktree_revision(Path::new(&root), &path);
                    (path, revision)
                })
                .collect()
        }
    })
    .await?;
    let revision_of = |path: &str| revisions.get(path).cloned().unwrap_or_default();
    // Cached rows hold while the base, HEAD and every edited attributes file (which can turn a file binary or change its line
    // endings) stand.
    let is_attributes = |path: &&String| path.rsplit('/').next() == Some(".gitattributes");
    let mut parts = vec![reference.clone(), if unborn { String::new() } else { status.head.clone() }];
    parts.extend(all_paths.iter().filter(is_attributes).map(|path| format!("{path}\0{}", revision_of(path))));
    let ref_key = parts.join("\0");
    let cache_id = format!("{}\0{source}", cache_key(root_path));
    let previous = caches().reviews.get(&cache_id).cloned();
    let prior_tracked = match &previous {
        Some(known) if known.ref_key == ref_key => known.tracked.clone(),
        _ => IndexMap::new(),
    };
    let mut tracked: IndexMap<String, TrackedEntry> = IndexMap::new();
    let mut stale: Vec<String> = Vec::new();
    let now = crate::seam::cache_clock();
    let fresh = |checked_at: Instant| now.saturating_duration_since(checked_at) < REVIEW_REVALIDATE;
    for path in &tracked_paths {
        let key = format!("{}\0{}", candidates[path], revision_of(path));
        match prior_tracked.get(path) {
            Some(known) if known.key == key && fresh(known.checked_at) => {
                tracked.insert(path.clone(), known.clone());
            }
            _ => {
                tracked.insert(path.clone(), TrackedEntry { key, record: None, checked_at: now });
                stale.push(path.clone());
            }
        }
    }
    if !stale.is_empty() {
        let (records, whole) = diff_stale_rows(git, cancel, root_path, &reference, &stale).await?;
        for path in &stale {
            if let Some(entry) = tracked.get_mut(path) {
                entry.record = records.get(path).cloned();
            }
        }
        if whole {
            for (path, record) in records {
                tracked.entry(path).or_insert(TrackedEntry { key: String::new(), record: Some(record), checked_at: now });
            }
        }
    }
    let mut files: IndexMap<String, Value> = IndexMap::new();
    for (path, entry) in &tracked {
        let Some((status_letter, additions, deletions)) = &entry.record else { continue };
        files.insert(
            path.clone(),
            json!({ "path": path, "status": status_letter, "additions": additions, "deletions": deletions, "untracked": false, "revision": revision_of(path) }),
        );
    }
    let mut untracked: IndexMap<String, UntrackedEntry> = IndexMap::new();
    for path in &untracked_paths {
        let revision = revision_of(path);
        let known = previous.as_ref().and_then(|cache| cache.untracked.get(path));
        let entry = match known {
            // Recounting reads the file once: any moved identity field or an aged row is simply counted again.
            Some(known) if known.revision == revision && fresh(known.checked_at) => known.clone(),
            _ => {
                let counted = on_lane(lane, cancel, {
                    let (root, path) = (root.clone(), path.clone());
                    move || untracked_lines(Path::new(&root), &path)
                })
                .await?;
                UntrackedEntry { revision, additions: counted, checked_at: now }
            }
        };
        untracked.insert(path.clone(), entry);
    }
    for path in &untracked_paths {
        let entry = &untracked[path];
        files.insert(
            path.clone(),
            json!({ "path": path, "status": "A", "additions": entry.additions, "deletions": 0, "untracked": true, "revision": entry.revision }),
        );
    }
    // A row read past the arg budget has no key: it is read again next time.
    tracked.retain(|_, entry| !entry.key.is_empty());
    bounded_set(&mut caches().reviews, cache_id, ReviewCache { ref_key, tracked, untracked });
    let mut rows: Vec<Value> = files.into_values().collect();
    rows.sort_by(|a, b| mixdog_js::locale_compare(a["path"].as_str().unwrap_or_default(), b["path"].as_str().unwrap_or_default()));
    Ok(json!({ "repository": true, "root": root, "base": base, "files": rows, "untrackedOmitted": status.untracked_omitted }))
}

/// `gitReviewDiff(cwd, path, untracked, source)`: one file's patch.
pub async fn git_review_diff(git: &Git, cancel: &CancellationToken, cwd: &Path, path: &str, untracked: bool, source: &str) -> Result<String, ScmFailure> {
    let root = cached_git_root(git, cancel, cwd).await?;
    let root_path = Path::new(&root);
    if untracked {
        return Ok(untracked_patch(root_path, path));
    }
    let (_, reference) = resolve_review_ref(git, cancel, root_path, source).await?;
    let mut args = vec!["--no-optional-locks", "diff"];
    args.extend(DISPLAY_DIFF_ARGS);
    args.extend(["--src-prefix=a/", "--dst-prefix=b/", &reference, "--", path]);
    git.text(cancel, root_path, &args, &RunOptions::read()).await
}

/// Paths git would quote in a diff header, so the header cannot be matched back.
fn unmatchable_header_path(path: &str) -> bool {
    path.chars().any(|c| c == '"' || c == '\\' || c < '\u{20}')
}

/// `gitReviewDiffs(cwd, files, source)`: one `git diff` over every tracked path (split per file) plus file reads for the untracked
/// ones. Paths that cannot be served in bulk come back in `omitted`.
pub async fn git_review_diffs(git: &Git, cancel: &CancellationToken, cwd: &Path, files: &[Value], source: &str) -> Result<Value, ScmFailure> {
    let root = cached_git_root(git, cancel, cwd).await?;
    let root_path = Path::new(&root);
    let mut patches: Vec<Value> = Vec::new();
    let mut omitted: Vec<String> = Vec::new();
    let mut tracked: Vec<String> = Vec::new();
    let mut untracked: Vec<String> = Vec::new();
    let mut arg_chars = 0usize;
    // `new Map(files.map(...)).values()`: a repeated path counts once, at its first position, with its last entry.
    let mut unique: IndexMap<String, bool> = IndexMap::new();
    for file in files {
        let Some(path) = file.get("path").and_then(Value::as_str) else { continue };
        unique.insert(path.to_owned(), file.get("untracked").and_then(Value::as_bool) == Some(true));
    }
    for (path, is_untracked) in unique {
        if is_untracked {
            untracked.push(path);
            continue;
        }
        arg_chars += utf16_len(&path) + 3;
        if unmatchable_header_path(&path) || arg_chars > REVIEW_BATCH_ARGS_CHARS {
            omitted.push(path);
        } else {
            tracked.push(path);
        }
    }
    let mut budget = REVIEW_BATCH_PATCH_CHARS;
    let mut accept = |path: String, patch: String, omitted: &mut Vec<String>| {
        let length = utf16_len(&patch);
        if length > budget {
            omitted.push(path);
            return;
        }
        budget -= length;
        patches.push(json!({ "path": path, "patch": patch }));
    };
    if !tracked.is_empty() {
        let (_, reference) = resolve_review_ref(git, cancel, root_path, source).await?;
        let mut args = vec!["-c", "core.quotePath=false", "--no-optional-locks", "--literal-pathspecs", "diff"];
        args.extend(DISPLAY_DIFF_ARGS);
        // Headers are matched back as `a/<path> b/<path>`: pin the prefixes against diff.noprefix and diff.mnemonicPrefix.
        args.extend(["--src-prefix=a/", "--dst-prefix=b/", "--no-renames", &reference, "--"]);
        args.extend(tracked.iter().map(String::as_str));
        let output = match git.text(cancel, root_path, &args, &RunOptions::read()).await {
            Ok(text) => Some(text),
            Err(ScmFailure::OutputTooLarge { .. }) => {
                omitted.extend(tracked.iter().cloned());
                None
            }
            Err(other) => return Err(other),
        };
        if let Some(output) = output {
            let by_header: HashMap<String, &String> = tracked.iter().map(|path| (format!("diff --git a/{path} b/{path}"), path)).collect();
            let mut chunks: HashMap<&String, String> = HashMap::new();
            let mut unmatched = false;
            // output.split(/^(?=diff --git )/m): a chunk starts at each line that begins `diff --git `.
            let mut starts: Vec<usize> = output
                .match_indices("diff --git ")
                .filter(|(at, _)| *at == 0 || output.as_bytes()[at - 1] == b'\n')
                .map(|(at, _)| at)
                .collect();
            if starts.first() != Some(&0) {
                starts.insert(0, 0);
            }
            for (index, start) in starts.iter().enumerate() {
                let end = starts.get(index + 1).copied().unwrap_or(output.len());
                let chunk = &output[*start..end];
                if chunk.is_empty() {
                    continue;
                }
                let header = chunk.split('\n').next().unwrap_or("");
                match by_header.get(header) {
                    Some(path) => {
                        chunks.insert(path, chunk.to_owned());
                    }
                    None => unmatched = true,
                }
            }
            // A path with no chunk is unchanged only when every chunk git printed was attributed; otherwise its patch may be among
            // the unmatched ones.
            for path in &tracked {
                match chunks.remove(path) {
                    Some(chunk) => accept(path.clone(), chunk, &mut omitted),
                    None if unmatched => omitted.push(path.clone()),
                    None => accept(path.clone(), String::new(), &mut omitted),
                }
            }
        }
    }
    for path in untracked {
        let patch = untracked_patch(root_path, &path);
        accept(path, patch, &mut omitted);
    }
    Ok(json!({ "patches": patches, "omitted": omitted }))
}
