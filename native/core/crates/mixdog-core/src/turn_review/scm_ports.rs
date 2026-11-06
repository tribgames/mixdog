//! The Git ports over WP-SCM's engine: one Git child to completion ([`ScmGit`]) and a turn's
//! worktree baseline ([`ScmWorktrees`]).
//!
//! Node keeps the baseline in a shadow repository of its own; this one captures the work tree's
//! tree through the scm engine's scratch index (`work_tree_tree`), so the user's index is never
//! touched. The recorded first states of the paths a tool wrote (`baselineFiles`) fill the holes
//! that capture leaves (ignored or large untracked files), exactly as `materializeToolBaselines`
//! does. Nothing here reads the captured current tree: the review shows the tracked segments.
// Every std::fs call here is the body of a lane job or a sync probe Node makes with `*Sync`.
#![allow(clippy::disallowed_methods, reason = "Node's canonicalPath is synchronous")]

use std::collections::HashSet;
use std::path::Path;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::atomic::AtomicU64;
use std::sync::atomic::Ordering;

use async_trait::async_trait;
use indexmap::IndexMap;
use mixdog_core_api::turn_review::ReviewContent;
use mixdog_scm::engine::Scm;
use mixdog_scm::git::RunOptions;
use serde_json::Value;
use tokio_util::sync::CancellationToken;

use super::nodepath;
use super::patch::clean;
use super::ports::GitRun;
use super::ports::ReviewDisk;
use super::ports::ReviewGit;
use super::ports::ReviewWorktrees;
use super::ports::WorktreeBase;
use super::tracker::PATCH_EDIT_MAX_BYTES;

/// `COMMAND_MAX_BYTES`.
const COMMAND_MAX_BYTES: u64 = 8 * 1024 * 1024;
const MAX_UNTRACKED_FILE_BYTES: usize = 2 * 1024 * 1024;

/// `runGitOffThread` over the scm engine's git runner.
pub struct ScmGit {
    scm: Arc<Scm>,
}

impl ScmGit {
    pub fn new(scm: Arc<Scm>) -> Self {
        Self { scm }
    }
}

#[async_trait]
impl ReviewGit for ScmGit {
    async fn run(&self, cwd: &str, args: &[String], input: Vec<u8>) -> Result<GitRun, String> {
        let refs: Vec<&str> = args.iter().map(String::as_str).collect();
        let options = RunOptions { input: (!input.is_empty()).then_some(input), max_output: Some(COMMAND_MAX_BYTES), ..RunOptions::default() };
        let out = self.scm.git.outcome(&CancellationToken::new(), Path::new(cwd), &refs, &options).await.map_err(|e| e.to_string())?;
        Ok(GitRun { code: out.code.unwrap_or(-1), stdout: out.stdout, stderr: out.stderr })
    }
}

/// `pathKey`.
fn path_key(value: &str) -> String {
    let text = clean(value).replace('\\', "/");
    if cfg!(windows) { text.to_lowercase() } else { text }
}

fn plain(path: String) -> String {
    match path.strip_prefix(r"\\?\UNC\") {
        Some(rest) => format!(r"\\{rest}"),
        None => path.strip_prefix(r"\\?\").map(str::to_owned).unwrap_or(path),
    }
}

/// `canonicalPath(value)`: `resolve` plus the symlinks of the nearest existing ancestor.
fn canonical(value: &str) -> String {
    let full = nodepath::resolve_host(&[value]);
    let mut head = full.clone();
    while !Path::new(&head).exists() {
        let parent = nodepath::resolve_host(&[&head, ".."]);
        if parent == head {
            return full;
        }
        head = parent;
    }
    let Ok(real) = std::fs::canonicalize(&head) else { return full };
    let rest = nodepath::relative_host(&head, &full);
    nodepath::resolve_host(&[&plain(real.to_string_lossy().into_owned()), &rest])
}

enum Pending {
    Absent,
    Bytes(Vec<u8>),
    Omitted(u64),
}

struct State {
    baseline_tree: String,
    tool_paths: HashSet<String>,
    pending: IndexMap<String, Pending>,
    files: IndexMap<String, Value>,
}

struct ScmBase {
    scm: Arc<Scm>,
    git: Arc<dyn ReviewGit>,
    disk: Arc<dyn ReviewDisk>,
    root: String,
    state: Mutex<State>,
    /// One materialization at a time (`withStateLock`).
    refreshing: tokio::sync::Mutex<()>,
}

pub struct ScmWorktrees {
    scm: Arc<Scm>,
    git: Arc<dyn ReviewGit>,
    disk: Arc<dyn ReviewDisk>,
}

impl ScmWorktrees {
    pub fn new(scm: Arc<Scm>, git: Arc<dyn ReviewGit>, disk: Arc<dyn ReviewDisk>) -> Self {
        Self { scm, git, disk }
    }
}

#[async_trait]
impl ReviewWorktrees for ScmWorktrees {
    async fn create(&self, worktree: &str) -> Option<Arc<dyn WorktreeBase>> {
        let cwd = nodepath::resolve_host(&[if clean(worktree).is_empty() { "." } else { clean(worktree) }]);
        let top = self.git.run(&cwd, &["rev-parse".to_owned(), "--show-toplevel".to_owned()], Vec::new()).await.ok().filter(|r| r.code == 0)?;
        let top = String::from_utf8_lossy(&top.stdout).trim().to_owned();
        if top.is_empty() {
            return None;
        }
        let root = nodepath::resolve_host(&[&top]);
        let tree = mixdog_scm::inspect::review::work_tree_tree(
            &self.scm.git,
            self.scm.lane,
            &CancellationToken::new(),
            Path::new(&root),
            &self.scm.scratch_dir().join("review"),
        )
        .await
        .ok()
        .filter(|tree| !tree.is_empty())?;
        Some(Arc::new(ScmBase {
            scm: self.scm.clone(),
            git: self.git.clone(),
            disk: self.disk.clone(),
            root,
            state: Mutex::new(State { baseline_tree: tree, tool_paths: HashSet::new(), pending: IndexMap::new(), files: IndexMap::new() }),
            refreshing: tokio::sync::Mutex::new(()),
        }))
    }

    /// Nothing reads a captured current tree here, so a boundary signal has nothing to mark.
    fn note_change(&self, _paths: Option<&[String]>) {}

    fn canonical_path(&self, path: &str) -> String {
        canonical(path)
    }
}

impl ScmBase {
    async fn git(&self, args: &[&str], input: Vec<u8>) -> Result<GitRun, String> {
        let args: Vec<String> = args.iter().map(|a| (*a).to_owned()).collect();
        self.git.run(&self.root, &args, input).await
    }

    async fn checked(&self, args: &[&str], input: Vec<u8>) -> Result<Vec<u8>, String> {
        let out = self.git(args, input).await?;
        if out.code != 0 {
            let stderr = String::from_utf8_lossy(&out.stderr);
            let detail = clean(&stderr);
            return Err(format!("git {} failed ({}): {}", args.join(" "), out.code, if detail.is_empty() { "no diagnostic" } else { detail }));
        }
        Ok(out.stdout)
    }

    /// `materializeToolBaselines`.
    async fn materialize(&self) -> Result<(), String> {
        let (tree, pending): (String, Vec<(String, Option<Vec<u8>>, Option<u64>)>) = {
            let state = self.state.lock().unwrap_or_else(|e| e.into_inner());
            let rows = state
                .pending
                .iter()
                .map(|(path, p)| match p {
                    Pending::Absent => (path.clone(), None, None),
                    Pending::Bytes(bytes) => (path.clone(), Some(bytes.clone()), None),
                    Pending::Omitted(size) => (path.clone(), None, Some(*size)),
                })
                .collect();
            (state.baseline_tree.clone(), rows)
        };
        if pending.is_empty() {
            return Ok(());
        }
        let paths: Vec<&str> = pending.iter().map(|(p, ..)| p.as_str()).collect();
        let mut args = vec!["ls-tree", "-r", "-z", "--name-only", tree.as_str(), "--"];
        args.extend(&paths);
        let listed = self.checked(&args, Vec::new()).await?;
        let nul_list = |bytes: &[u8]| -> Vec<String> {
            String::from_utf8_lossy(bytes).split('\0').map(|v| v.trim().to_owned()).filter(|v| !v.is_empty()).collect()
        };
        let present: HashSet<String> = nul_list(&listed).iter().map(|p| path_key(p)).collect();
        // A leading ':' is pathspec magic to ls-tree and check-ignore.
        let literal = paths.iter().all(|p| !p.starts_with(':'));
        let tracked: Option<HashSet<String>> = {
            let out = self.git(&["-c", "core.quotepath=false", "ls-files", "--cached", "-z"], Vec::new()).await?;
            (out.code == 0).then(|| nul_list(&out.stdout).iter().map(|p| path_key(p)).collect())
        };
        let is_tracked = |path: &str| tracked.as_ref().is_some_and(|t| t.contains(&path_key(path)));
        let asks_ignored = |(path, content, omitted): &(String, Option<Vec<u8>>, Option<u64>)| {
            omitted.is_none() && content.as_ref().is_some_and(|c| c.len() <= MAX_UNTRACKED_FILE_BYTES) && !present.contains(&path_key(path)) && !is_tracked(path)
        };
        let mut ignored: HashSet<String> = HashSet::new();
        if !literal || pending.iter().any(asks_ignored) {
            let input = format!("{}\0", paths.join("\0")).into_bytes();
            let out = self.git(&["check-ignore", "--no-index", "-z", "--stdin"], input).await?;
            if out.code > 1 {
                return Err(format!("git check-ignore failed ({}): {}", out.code, clean(&String::from_utf8_lossy(&out.stderr))));
            }
            ignored = nul_list(&out.stdout).iter().map(|p| path_key(p)).collect();
        }
        // Entries the baseline tree lacks and the capture could not have held.
        let missing: Vec<(String, Option<Vec<u8>>, Option<u64>)> = pending
            .iter()
            .filter(|(path, content, omitted)| {
                !present.contains(&path_key(path))
                    && (content.is_none()
                        || omitted.is_some()
                        || (!is_tracked(path) && (ignored.contains(&path_key(path)) || content.as_ref().is_some_and(|c| c.len() > MAX_UNTRACKED_FILE_BYTES))))
            })
            .cloned()
            .collect();
        let absent: Option<HashSet<String>> = literal.then(|| paths.iter().map(|p| path_key(p)).filter(|k| !present.contains(k)).collect());
        let (next_tree, files) = self.apply_baseline_files(&tree, &missing, absent.as_ref()).await?;
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        state.baseline_tree = next_tree;
        for entry in files {
            let key = path_key(entry.get("path").and_then(Value::as_str).unwrap_or(""));
            state.files.insert(key, entry);
        }
        for (path, ..) in &pending {
            state.pending.shift_remove(path);
        }
        Ok(())
    }

    /// `applyBaselineFilesUnlocked`: `tree` with the recorded first states applied.
    async fn apply_baseline_files(
        &self,
        tree: &str,
        all: &[(String, Option<Vec<u8>>, Option<u64>)],
        absent: Option<&HashSet<String>>,
    ) -> Result<(String, Vec<Value>), String> {
        let safe = |path: &str| self.safe_relative(path);
        let mut files: Vec<Value> = Vec::new();
        for (path, _, omitted) in all.iter().filter(|e| e.2.is_some()) {
            files.push(serde_json::json!({"path": safe(path)?, "oid": null, "omitted": true, "size": omitted.unwrap_or(0)}));
        }
        let mut entries = Vec::new();
        for (path, content, _) in all.iter().filter(|e| e.2.is_none()) {
            let rel = safe(path)?;
            let noop = content.is_none() && absent.is_some_and(|a| a.contains(&path_key(&rel)));
            entries.push((rel, content.clone(), noop));
        }
        if entries.iter().all(|e| e.2) {
            files.extend(entries.iter().map(|(path, ..)| serde_json::json!({"path": path, "oid": null})));
            return Ok((tree.to_owned(), files));
        }
        static SEQ: AtomicU64 = AtomicU64::new(0);
        let dir = self.scm.scratch_dir().join("review");
        self.disk.create_dir_all(&dir).await.map_err(|e| e.to_string())?;
        let index = dir.join(format!("index.baseline-{}-{}", std::process::id(), SEQ.fetch_add(1, Ordering::SeqCst) + 1));
        let outcome = self.apply_in_index(&index, tree, entries, &mut files).await;
        let _ = self.disk.remove(&index).await;
        let mut lock = index.into_os_string();
        lock.push(".lock");
        let _ = self.disk.remove(Path::new(&lock)).await;
        Ok((outcome?, files))
    }

    async fn apply_in_index(&self, index: &Path, tree: &str, entries: Vec<(String, Option<Vec<u8>>, bool)>, files: &mut Vec<Value>) -> Result<String, String> {
        let options = RunOptions { index_file: Some(index.to_path_buf()), max_output: Some(COMMAND_MAX_BYTES), ..RunOptions::default() };
        self.indexed(&options, vec!["read-tree", tree], None).await?;
        for (path, content, noop) in entries {
            if noop {
                files.push(serde_json::json!({"path": path, "oid": null}));
                continue;
            }
            let oid = match content {
                Some(bytes) => Some(clean(&self.indexed(&options, vec!["hash-object", "-w", "--stdin", "--path", &path], Some(bytes)).await?).to_owned()),
                None => None,
            };
            match &oid {
                Some(oid) => {
                    self.indexed(&options, vec!["update-index", "--add", "--cacheinfo", "100644", oid, &path], None).await?;
                }
                None => {
                    self.indexed(&options, vec!["update-index", "--force-remove", "--", &path], None).await?;
                }
            }
            files.push(serde_json::json!({"path": path, "oid": oid}));
        }
        Ok(clean(&self.indexed(&options, vec!["write-tree"], None).await?).to_owned())
    }

    /// One Git child against the scratch index.
    async fn indexed(&self, options: &RunOptions, args: Vec<&str>, input: Option<Vec<u8>>) -> Result<String, String> {
        let options = RunOptions { input, ..options.clone() };
        let out = self.scm.git.outcome(&CancellationToken::new(), Path::new(&self.root), &args, &options).await.map_err(|e| e.to_string())?;
        if out.code != Some(0) {
            return Err(format!("git {} failed ({}): {}", args.join(" "), out.code.unwrap_or(-1), clean(&String::from_utf8_lossy(&out.stderr))));
        }
        Ok(out.stdout_text())
    }

    /// `safeRelativePath(root, value)`.
    fn safe_relative(&self, value: &str) -> Result<String, String> {
        let requested = clean(value);
        if requested.is_empty() {
            return Err("turn review file path is required".into());
        }
        let full = nodepath::resolve_host(&[&self.root, requested]);
        let rel = nodepath::relative_host(&self.root, &full);
        if rel.is_empty() || rel == "." || nodepath::is_absolute_host(&rel) || nodepath::split_segments(&rel).contains(&"..") {
            return Err("turn review file path is outside the worktree".into());
        }
        Ok(rel.replace('\\', "/"))
    }
}

#[async_trait]
impl WorktreeBase for ScmBase {
    fn root(&self) -> String {
        self.root.clone()
    }

    fn baseline_tree(&self) -> String {
        self.state.lock().unwrap_or_else(|e| e.into_inner()).baseline_tree.clone()
    }

    fn baseline_files(&self) -> Vec<Value> {
        self.state.lock().unwrap_or_else(|e| e.into_inner()).files.values().cloned().collect()
    }

    /// `recordTurnWorktreeFileChange`.
    fn record_file_change(&self, path: &str, before: &ReviewContent) {
        let rel = nodepath::relative_host(&self.root, &canonical(path)).replace('\\', "/");
        if rel.is_empty() || nodepath::is_absolute_host(&rel) || rel.split('/').any(|s| s == "..") {
            return;
        }
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        if !state.tool_paths.insert(rel.clone()) {
            return;
        }
        // Bytes never captured, or beyond the tool-baseline bound, keep only their size.
        let pending = match before {
            ReviewContent::Absent => Pending::Absent,
            ReviewContent::Bytes(bytes) if bytes.len() <= PATCH_EDIT_MAX_BYTES => Pending::Bytes(bytes.to_vec()),
            ReviewContent::Bytes(bytes) => Pending::Omitted(bytes.len() as u64),
            ReviewContent::Omitted { size, .. } => Pending::Omitted(*size),
        };
        state.pending.insert(rel, pending);
    }

    /// `refreshTurnWorktreeSnapshot`: the tool baselines recorded since are folded into the
    /// baseline tree. Best effort: a failure leaves them pending for the next refresh.
    async fn refresh(&self, _force: bool) {
        let _guard = self.refreshing.lock().await;
        let _ = self.materialize().await;
    }
}
