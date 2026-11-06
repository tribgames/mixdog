//! The shadow repository (Node `turn-worktree-snapshot.mjs`): a bare repository of the review's own
//! per root, under `<data>/turn-worktree-snapshots-v1/<sha256(pathKey(root))[..24]>`, that borrows
//! the user's objects through `objects/info/alternates` and keeps its own index. A turn's baseline
//! tree and every tool-baseline blob are written there, so the user's `.git` is never written to
//! and their garbage collection never takes a baseline. Maintained by `git gc --auto`
//! (`--prune=7.days.ago`) one minute after its first use in the process, removed by [`forget_root`].
//!
//! Not ported: the batched blob hashing (`hashBlobs`, `addsReplaceNothing`), which only saves
//! process spawns; the per-entry path it falls back to produces the same tree and rows.
// Every std::fs call is behind `ReviewDisk`; the only sync probes are Node's `*Sync` ones.
#![allow(clippy::disallowed_methods, reason = "Node's canonicalPath is synchronous")]

use std::collections::HashMap;
use std::collections::HashSet;
use std::path::Path;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::Mutex;

/// One tool-written file for the baseline index: path, bytes, mode, and whether it is a link.
type ToolEntry = (String, Option<Vec<u8>>, Option<String>, bool);

use mixdog_rt::ChainGuard;
use mixdog_rt::SerialChain;
use std::sync::atomic::AtomicBool;
use std::sync::atomic::AtomicU64;
use std::sync::atomic::Ordering;

use indexmap::IndexMap;
use mixdog_core_api::turn_review::ReviewContent;
use serde_json::Value;
use sha2::Digest;
use sha2::Sha256;

use super::nodepath;
use super::patch::clean;
use super::patch::split_patch_sections;
use super::ports::GitOptions;
use super::ports::GitRun;
use super::ports::OUTPUT_OVERFLOW;
use super::ports::ReviewDisk;
use super::ports::ReviewGit;
use super::review_diff::Obj;
use super::review_diff::PATCH_TOO_LARGE;
use super::review_diff::REVIEW_FILE_PATCH_MAX_BYTES;
use super::review_diff::REVIEW_PATCH_MAX_BYTES;
use super::review_diff::ReviewPatchBudget;
use super::review_diff::patch_omitted_file;
use super::review_diff::review_diff_too_large;
use super::tracker::PATCH_EDIT_MAX_BYTES;

type R<T> = Result<T, String>;

const COMMAND_MAX_BYTES: u64 = 8 * 1024 * 1024;
const PATCH_OUTPUT_SLACK_BYTES: u64 = 64 * 1024;
const PATCH_BATCH_FILES: usize = 32;
pub(super) const MAX_UNTRACKED_FILE_BYTES: usize = 2 * 1024 * 1024;
const MAX_TOOL_BASELINE_BYTES: usize = PATCH_EDIT_MAX_BYTES;
const SHADOW_GC_PRUNE: &str = "7.days.ago";
const SHADOW_GC_DELAY: std::time::Duration = std::time::Duration::from_secs(60);
const REMOVED_CODE: &str = "TURN_WORKTREE_SNAPSHOT_REMOVED";

/// `pathKey` of this module: forward slashes, folded on Windows.
pub(super) fn shadow_key(value: &str) -> String {
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
pub(super) fn canonical_path(value: &str) -> String {
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

/// `safeRelativePath(root, value)`.
pub(super) fn safe_relative_path(root: &str, value: &str) -> R<String> {
    let requested = clean(value);
    if requested.is_empty() {
        return Err("turn review file path is required".into());
    }
    let full = nodepath::resolve_host(&[root, requested]);
    let rel = nodepath::relative_host(root, &full);
    if rel.is_empty() || rel == "." || nodepath::is_absolute_host(&rel) || nodepath::split_segments(&rel).contains(&"..") {
        return Err("turn review file path is outside the worktree".into());
    }
    Ok(rel.replace('\\', "/"))
}

fn nul_list(bytes: &[u8]) -> Vec<String> {
    String::from_utf8_lossy(bytes).split('\0').map(|v| v.trim().to_owned()).filter(|v| !v.is_empty()).collect()
}

fn literal_pathspec(path: &str) -> String {
    format!(":(literal){path}")
}

/// One recorded first state of a path (`baselineFiles`, or a pending tool baseline).
#[derive(Clone, Debug)]
pub(super) struct BaselineEntry {
    pub path: String,
    pub content: Option<Vec<u8>>,
    pub oid: Option<String>,
    pub omitted: bool,
    pub size: u64,
}

impl BaselineEntry {
    pub(super) fn from_value(value: &Value) -> Option<Self> {
        let map = value.as_object()?;
        Some(Self {
            path: map.get("path").and_then(Value::as_str)?.to_owned(),
            content: None,
            oid: map.get("oid").and_then(Value::as_str).filter(|o| !o.is_empty()).map(str::to_owned),
            omitted: map.get("omitted") == Some(&Value::Bool(true)),
            size: map.get("size").and_then(Value::as_f64).unwrap_or(0.0) as u64,
        })
    }
}

#[derive(Clone)]
struct Capture {
    seq: u64,
    stamp: u64,
    explicit: HashSet<String>,
    tree: String,
}

#[derive(Default)]
struct RootState {
    initialized: bool,
    source_index_path: Option<String>,
    source_paths: Option<SourcePaths>,
    source_index_identity: Option<String>,
    source_tracked: HashSet<String>,
    line_ending_args: Vec<String>,
    change_stamp: u64,
    capture_seq: u64,
    last_capture: Option<Capture>,
    forgotten: bool,
}

#[derive(Clone, Default)]
struct SourcePaths {
    exclude: Option<String>,
    index: Option<String>,
    common_dir: Option<String>,
}

struct Gc {
    started: Arc<AtomicBool>,
    task: tokio::task::JoinHandle<()>,
}

/// One worktree root's shadow repository and in-memory state.
pub(super) struct Root {
    pub(super) root: String,
    canonical_key: String,
    git_dir: PathBuf,
    /// `withStateLock`: one capture at a time.
    lock: Arc<SerialChain>,
    state: Mutex<RootState>,
    gc: Mutex<Option<Gc>>,
    repos: Arc<ReposShared>,
}

struct ReposShared {
    store: PathBuf,
    git: Arc<dyn ReviewGit>,
    disk: Arc<dyn ReviewDisk>,
    states: Mutex<IndexMap<String, Arc<Root>>>,
    maintained: Mutex<HashSet<PathBuf>>,
    temp_seq: AtomicU64,
}

pub struct ShadowRepos {
    shared: Arc<ReposShared>,
}

/// A diff between two trees, bounded as a review reply.
#[derive(Clone, Default)]
pub(super) struct TreeReview {
    pub patch: String,
    pub files: Vec<Obj>,
    pub patch_truncated: bool,
    pub diff_too_large: bool,
    pub current_tree: String,
}

impl ShadowRepos {
    /// `store`: `<data>/turn-worktree-snapshots-v1`.
    pub fn new(store: PathBuf, git: Arc<dyn ReviewGit>, disk: Arc<dyn ReviewDisk>) -> Self {
        Self {
            shared: Arc::new(ReposShared {
                store,
                git,
                disk,
                states: Mutex::new(IndexMap::new()),
                maintained: Mutex::new(HashSet::new()),
                temp_seq: AtomicU64::new(0),
            }),
        }
    }

    /// `repositoryRoot(worktree)`.
    pub(super) async fn repository_root(&self, worktree: &str) -> Option<String> {
        let cwd = nodepath::resolve_host(&[if clean(worktree).is_empty() { "." } else { clean(worktree) }]);
        let out = self.shared.git.run(&cwd, &["rev-parse".to_owned(), "--show-toplevel".to_owned()], Vec::new()).await.ok()?;
        if out.code != 0 {
            return None;
        }
        let top = String::from_utf8_lossy(&out.stdout).trim().to_owned();
        (!top.is_empty()).then(|| nodepath::resolve_host(&[&top]))
    }

    pub(super) fn state_for_root(&self, root: &str) -> Arc<Root> {
        let key = shadow_key(root);
        let digest = Sha256::digest(key.as_bytes());
        let name: String = digest.iter().flat_map(|b| [b >> 4, b & 15]).take(24).map(|n| char::from_digit(n as u32, 16).expect("hex")).collect();
        let git_dir = self.shared.store.join(name);
        let mut states = self.shared.states.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(state) = states.get(&key)
            && state.git_dir == git_dir {
                return state.clone();
            }
        let state = Arc::new(Root {
            root: root.to_owned(),
            // Matched beside `root`'s own spelling: a watcher on a canonical root reports this one.
            canonical_key: shadow_key(&canonical_path(root)),
            git_dir,
            lock: SerialChain::new(),
            state: Mutex::new(RootState::default()),
            gc: Mutex::new(None),
            repos: self.shared.clone(),
        });
        states.insert(key, state.clone());
        state
    }

    /// `noteTurnWorktreeChange(paths)`: a path dirties the roots it lies under and the roots it
    /// contains; `None` dirties every root.
    pub fn note_change(&self, paths: Option<&[String]>) {
        let states: Vec<Arc<Root>> = self.shared.states.lock().unwrap_or_else(|e| e.into_inner()).values().cloned().collect();
        if states.is_empty() {
            return;
        }
        let list: Vec<&String> = paths.unwrap_or(&[]).iter().filter(|v| !clean(v).is_empty()).collect();
        if list.is_empty() {
            for state in &states {
                state.state.lock().unwrap_or_else(|e| e.into_inner()).change_stamp += 1;
            }
            return;
        }
        let roots: Vec<(usize, String)> = states
            .iter()
            .enumerate()
            .flat_map(|(i, s)| {
                let mut keys = vec![shadow_key(&s.root)];
                if s.canonical_key != keys[0] {
                    keys.push(s.canonical_key.clone());
                }
                keys.into_iter().map(move |k| (i, k))
            })
            .collect();
        let mut stamped: HashSet<usize> = HashSet::new();
        let mut seen: HashSet<String> = HashSet::new();
        for value in list {
            if stamped.len() == states.len() {
                break;
            }
            let spelled = shadow_key(&nodepath::resolve_host(&[value]));
            if !seen.insert(spelled) {
                continue;
            }
            let key = shadow_key(&canonical_path(value));
            let dir = if key.ends_with('/') { key.clone() } else { format!("{key}/") };
            for (index, root) in &roots {
                if key == *root || key.starts_with(&format!("{root}/")) || root.starts_with(&dir) {
                    stamped.insert(*index);
                }
            }
        }
        for index in stamped {
            states[index].state.lock().unwrap_or_else(|e| e.into_inner()).change_stamp += 1;
        }
    }

    /// `forgetTurnWorktreeRoot(root)`: serialize behind the root's pending capture work, remove its
    /// shadow repository and state, and refuse any write a snapshot still holding the old state
    /// attempts afterwards. Returns the removed and the kept (undeletable) shadow paths.
    pub async fn forget_root(&self, root: &str) -> (Vec<PathBuf>, Vec<PathBuf>) {
        let (mut removed, mut kept) = (Vec::new(), Vec::new());
        let text = clean(root);
        if text.is_empty() {
            return (removed, kept);
        }
        let keys: HashSet<String> = [shadow_key(&nodepath::resolve_host(&[text])), shadow_key(&canonical_path(text))].into_iter().collect();
        let mut git_dirs: Vec<PathBuf> = Vec::new();
        let add_dir = |dir: PathBuf, dirs: &mut Vec<PathBuf>| {
            if !dirs.contains(&dir) {
                dirs.push(dir);
            }
        };
        for key in &keys {
            let digest = Sha256::digest(key.as_bytes());
            let name: String = digest.iter().flat_map(|b| [b >> 4, b & 15]).take(24).map(|n| char::from_digit(n as u32, 16).expect("hex")).collect();
            add_dir(self.shared.store.join(name), &mut git_dirs);
        }
        let states: Vec<(String, Arc<Root>)> = self.shared.states.lock().unwrap_or_else(|e| e.into_inner()).iter().map(|(k, v)| (k.clone(), v.clone())).collect();
        for (key, state) in states {
            if !keys.contains(&key) && !keys.contains(&shadow_key(&state.root)) {
                continue;
            }
            add_dir(state.git_dir.clone(), &mut git_dirs);
            let _guard = state.lock.acquire().await;
            state.state.lock().unwrap_or_else(|e| e.into_inner()).forgotten = true;
            {
                let mut states = self.shared.states.lock().unwrap_or_else(|e| e.into_inner());
                if states.get(&key).is_some_and(|s| Arc::ptr_eq(s, &state)) {
                    states.shift_remove(&key);
                }
            }
            let gc = state.gc.lock().unwrap_or_else(|e| e.into_inner()).take();
            if let Some(gc) = gc {
                if gc.started.load(Ordering::SeqCst) {
                    let _ = gc.task.await;
                } else {
                    gc.task.abort();
                }
            }
            self.shared.maintained.lock().unwrap_or_else(|e| e.into_inner()).remove(&state.git_dir);
        }
        for git_dir in git_dirs {
            if self.shared.disk.lstat(&git_dir).await.ok().flatten().is_none() {
                continue;
            }
            let _ = self.shared.disk.remove_tree(&git_dir).await;
            if self.shared.disk.lstat(&git_dir).await.ok().flatten().is_some() {
                kept.push(git_dir);
            } else {
                removed.push(git_dir);
            }
        }
        (removed, kept)
    }
}

impl Root {
    fn disk(&self) -> &Arc<dyn ReviewDisk> {
        &self.repos.disk
    }

    fn st(&self) -> std::sync::MutexGuard<'_, RootState> {
        self.state.lock().unwrap_or_else(|e| e.into_inner())
    }

    pub(super) fn bump_change(&self) {
        self.st().change_stamp += 1;
    }

    pub(super) fn change_stamp(&self) -> u64 {
        self.st().change_stamp
    }

    pub(super) fn capture_sequence(&self) -> u64 {
        self.st().capture_seq
    }

    pub(super) async fn lock(&self) -> ChainGuard {
        self.lock.acquire().await
    }

    pub(super) async fn disk_exists(&self, path: &str) -> bool {
        self.disk().stat(Path::new(path)).await.ok().flatten().is_some()
    }

    pub(super) async fn shadow_run(&self, args: &[&str], input: Vec<u8>) -> R<GitRun> {
        self.shadow(args, input).await
    }

    pub(super) async fn plain_run(&self, args: &[&str], input: Vec<u8>, allow_failure: bool) -> R<GitRun> {
        self.run_args(args.iter().map(|a| (*a).to_owned()).collect(), input, &GitOptions::default(), allow_failure).await
    }

    pub(super) fn source_tracked(&self) -> HashSet<String> {
        self.st().source_tracked.clone()
    }

    /// `assertStateLive`.
    fn assert_live(&self) -> R<()> {
        if self.st().forgotten {
            return Err(format!("turn worktree snapshot for {} was removed ({REMOVED_CODE})", self.root));
        }
        Ok(())
    }

    /// `shadowArgs`.
    fn shadow_args(&self, args: &[&str], work_tree: Option<&str>) -> R<Vec<String>> {
        self.assert_live()?;
        let mut out = self.st().line_ending_args.clone();
        out.extend(["-c", "core.safecrlf=false", "-c", "core.quotepath=false", "--git-dir"].map(str::to_owned));
        out.push(self.git_dir.to_string_lossy().into_owned());
        out.push("--work-tree".into());
        out.push(work_tree.unwrap_or(&self.root).to_owned());
        out.extend(args.iter().map(|a| (*a).to_owned()));
        Ok(out)
    }

    /// `runGit`: a non-zero exit is an error unless `allow_failure`.
    async fn run_args(&self, args: Vec<String>, input: Vec<u8>, options: &GitOptions, allow_failure: bool) -> R<GitRun> {
        let out = self.repos.git.run_with(&self.root, &args, input, options).await?;
        if out.code != 0 && !allow_failure {
            let stderr = String::from_utf8_lossy(&out.stderr);
            let detail = clean(&stderr);
            return Err(format!("git {} failed ({}): {}", args.join(" "), out.code, if detail.is_empty() { "no diagnostic" } else { detail }));
        }
        Ok(out)
    }

    async fn shadow(&self, args: &[&str], input: Vec<u8>) -> R<GitRun> {
        self.run_args(self.shadow_args(args, None)?, input, &GitOptions::default(), false).await
    }

    async fn plain_git(&self, args: &[&str], allow_failure: bool) -> R<GitRun> {
        self.run_args(args.iter().map(|a| (*a).to_owned()).collect(), Vec::new(), &GitOptions::default(), allow_failure).await
    }

    async fn exists(&self, path: &Path) -> bool {
        self.disk().lstat(path).await.ok().flatten().is_some()
    }

    // ── state ──────────────────────────────────────────────────────────────

    /// `sourceGitPaths`: the source repository's info/exclude, index and common directory.
    async fn source_git_paths(&self) -> R<SourcePaths> {
        if let Some(paths) = self.st().source_paths.clone() {
            return Ok(paths);
        }
        let out = self
            .plain_git(&["rev-parse", "--path-format=absolute", "--git-path", "info/exclude", "--git-path", "index", "--git-common-dir"], true)
            .await?;
        let text = String::from_utf8_lossy(&out.stdout).into_owned();
        let lines: Vec<&str> = text.split('\n').map(|l| l.strip_suffix('\r').unwrap_or(l)).filter(|l| !l.is_empty()).collect();
        if out.code == 0 && lines.len() == 3 && lines.iter().all(|l| !clean(l).is_empty()) {
            let paths = SourcePaths {
                exclude: Some(nodepath::resolve_host(&[&self.root, clean(lines[0])])),
                index: Some(nodepath::resolve_host(&[&self.root, clean(lines[1])])),
                common_dir: Some(clean(lines[2]).to_owned()),
            };
            self.st().source_paths = Some(paths.clone());
            return Ok(paths);
        }
        let git_path = |suffix: &'static str| async move {
            let out = self.plain_git(&["rev-parse", "--path-format=absolute", "--git-path", suffix], true).await.ok()?;
            let value = clean(&String::from_utf8_lossy(&out.stdout)).to_owned();
            (out.code == 0 && !value.is_empty()).then(|| nodepath::resolve_host(&[&self.root, &value]))
        };
        let common = {
            let out = self.plain_git(&["rev-parse", "--path-format=absolute", "--git-common-dir"], true).await.ok();
            out.and_then(|o| {
                let value = clean(&String::from_utf8_lossy(&o.stdout)).to_owned();
                (o.code == 0 && !value.is_empty()).then_some(value)
            })
        };
        Ok(SourcePaths { exclude: git_path("info/exclude").await, index: git_path("index").await, common_dir: common })
    }

    /// `sourceLineEndingArgs`: the source repository's own line-ending conversion.
    async fn source_line_ending_args(&self) -> Vec<String> {
        let out = self.plain_git(&["config", "--get-regexp", "^core\\.(autocrlf|eol)$"], true).await;
        let mut values: IndexMap<String, String> = IndexMap::new();
        if let Ok(out) = out {
            for line in String::from_utf8_lossy(&out.stdout).lines() {
                let line = line.trim();
                let lower = line.to_lowercase();
                for key in ["core.autocrlf", "core.eol"] {
                    if lower.starts_with(key) {
                        let rest = &line[key.len()..];
                        if rest.starts_with(char::is_whitespace)
                            && let Some(value) = rest.split_whitespace().next() {
                                values.insert(key.to_owned(), value.to_owned());
                            }
                    }
                }
            }
        }
        values.into_iter().flat_map(|(key, value)| ["-c".to_owned(), format!("{key}={value}")]).collect()
    }

    async fn sync_source_exclude(&self, source: Option<&str>) {
        let Some(source) = source else { return };
        if !self.exists(Path::new(source)).await {
            return;
        }
        let target = self.git_dir.join("info").join("exclude");
        if let Some(dir) = target.parent() {
            let _ = self.disk().create_dir_all(dir).await;
        }
        let _ = self.disk().copy_file(Path::new(source), &target).await;
    }

    async fn sync_alternates(&self, common_dir: Option<&str>) {
        let Some(common) = common_dir else { return };
        let source_objects = PathBuf::from(nodepath::resolve_host(&[&self.root, common])).join("objects");
        if !self.exists(&source_objects).await {
            return;
        }
        let mut alternates = vec![source_objects.to_string_lossy().into_owned()];
        if let Ok(Some(bytes)) = self.disk().read(&source_objects.join("info").join("alternates")).await {
            for item in String::from_utf8_lossy(&bytes).lines().map(str::trim).filter(|l| !l.is_empty()) {
                if self.exists(Path::new(item)).await {
                    alternates.push(item.to_owned());
                }
            }
        }
        let mut seen = HashSet::new();
        alternates.retain(|a| seen.insert(a.clone()));
        let target = self.git_dir.join("objects").join("info").join("alternates");
        let _ = self.disk().write_atomic(&target, format!("{}\n", alternates.join("\n")).into_bytes()).await;
    }

    async fn source_index_identity(&self) -> R<String> {
        let path = {
            let cached = self.st().source_index_path.clone();
            match cached {
                Some(path) => Some(path),
                None => {
                    let path = self.source_git_paths().await?.index;
                    self.st().source_index_path = path.clone();
                    path
                }
            }
        };
        let Some(path) = path else { return Ok("missing".into()) };
        Ok(match self.disk().lstat(Path::new(&path)).await.ok().flatten() {
            Some(stat) => format!("{}:{}:{}", stat.size, stat.mtime_ms, stat.change_ms),
            None => "missing".into(),
        })
    }

    /// `refreshSourceTracked`.
    async fn refresh_source_tracked(&self, force: bool) -> R<()> {
        let identity = self.source_index_identity().await?;
        if !force && self.st().source_index_identity.as_deref() == Some(identity.as_str()) {
            return Ok(());
        }
        let out = self.plain_git(&["-c", "core.quotepath=false", "ls-files", "--cached", "-z"], true).await?;
        if out.code != 0 {
            return Ok(());
        }
        let mut state = self.st();
        state.source_tracked = nul_list(&out.stdout).iter().map(|p| shadow_key(p)).collect();
        state.source_index_identity = Some(identity);
        Ok(())
    }

    /// `ensureState`: the repository exists, borrows the source's objects and exclude list, and its
    /// index mirrors the source's.
    pub(super) async fn ensure_state(&self) -> R<()> {
        self.assert_live()?;
        let config = self.git_dir.join("config");
        if self.st().initialized && self.exists(&config).await {
            return Ok(());
        }
        if let Some(parent) = self.git_dir.parent() {
            self.disk().create_dir_all(parent).await.map_err(|e| e.to_string())?;
        }
        if !self.exists(&config).await {
            // The short-lived prototype layout (`git init <dir>` made <dir>/.git) is migrated.
            if self.exists(&self.git_dir.join(".git").join("config")).await {
                self.disk().remove_tree(&self.git_dir).await.map_err(|e| e.to_string())?;
            }
            self.plain_git(&["init", "--bare", &self.git_dir.to_string_lossy()], false).await?;
            // One atomic config write replaces nine serial `git config` processes.
            let text = [
                "[core]",
                "\trepositoryformatversion = 0",
                "\tbare = false",
                "\tlongpaths = true",
                "\tsymlinks = true",
                "\tfsmonitor = false",
                "\tuntrackedCache = true",
                "[feature]",
                "\tmanyFiles = true",
                "[index]",
                "\tversion = 4",
                "\tthreads = true",
                "",
            ]
            .join("\n");
            self.disk().write_atomic(&config, text.into_bytes()).await.map_err(|e| e.to_string())?;
        }
        // Every (re)initialisation reads the source layout afresh.
        self.st().source_paths = None;
        let paths = self.source_git_paths().await?;
        let (line_ending, ..) = tokio::join!(self.source_line_ending_args(), self.sync_source_exclude(paths.exclude.as_deref()), self.sync_alternates(paths.common_dir.as_deref()));
        self.st().line_ending_args = line_ending;
        self.refresh_source_tracked(true).await?;
        self.reset_shadow_index().await?;
        self.st().initialized = true;
        Ok(())
    }

    /// `resetShadowIndex`: the shadow index starts as a copy of the source index.
    async fn reset_shadow_index(&self) -> R<()> {
        self.st().last_capture = None;
        let cached = self.st().source_index_path.clone();
        let source = match cached {
            Some(path) => Some(path),
            None => {
                let path = self.source_git_paths().await?.index;
                self.st().source_index_path = path.clone();
                path
            }
        };
        let target = self.git_dir.join("index");
        if let Some(source) = source.filter(|s| !s.is_empty())
            && self.exists(Path::new(&source)).await {
                let now = self.disk().now_ms();
                let temporary = PathBuf::from(format!("{}.{}.{}.tmp", target.display(), std::process::id(), now as u64));
                self.disk().copy_file(Path::new(&source), &temporary).await.map_err(|e| e.to_string())?;
                let _ = self.disk().remove(&target).await;
                self.disk().rename(&temporary, &target).await.map_err(|e| e.to_string())?;
                return Ok(());
            }
        let _ = self.disk().remove(&target).await;
        self.shadow(&["read-tree", "--empty"], Vec::new()).await?;
        Ok(())
    }

    /// `changedWorktreePaths`: the paths a capture must add, and the large untracked ones it leaves out.
    async fn changed_worktree_paths(&self) -> R<(Vec<String>, Vec<String>)> {
        self.refresh_source_tracked(false).await?;
        let (tracked, untracked) = tokio::join!(
            self.shadow(&["diff-files", "--name-only", "-z", "--", "."], Vec::new()),
            self.shadow(&["ls-files", "--others", "--exclude-standard", "-z", "--", "."], Vec::new())
        );
        let (tracked, untracked) = (nul_list(&tracked?.stdout), nul_list(&untracked?.stdout));
        let source_tracked = self.st().source_tracked.clone();
        let source_tracked_paths: Vec<String> = tracked.iter().filter(|v| source_tracked.contains(&shadow_key(v))).cloned().collect();
        let shadow_tracked: HashSet<String> = tracked.iter().map(|v| shadow_key(v)).collect();
        let mut changed_untracked: Vec<String> = Vec::new();
        let mut seen = HashSet::new();
        for value in tracked.iter().filter(|v| !source_tracked.contains(&shadow_key(v))).chain(untracked.iter()) {
            if seen.insert(value.clone()) {
                changed_untracked.push(value.clone());
            }
        }
        // Never hash a newly created multi-MB build artifact just to power a review bar.
        let (mut allowed, mut excluded) = (Vec::new(), Vec::new());
        for chunk in changed_untracked.chunks(16) {
            let fulls: Vec<PathBuf> = chunk.iter().map(|rel| PathBuf::from(nodepath::resolve_host(&[&self.root, rel]))).collect();
            let stats = futures::future::join_all(fulls.iter().map(|full| self.disk().lstat(full))).await;
            for (rel, stat) in chunk.iter().zip(stats) {
                match stat {
                    Ok(Some(stat)) if stat.is_file && stat.size as usize > MAX_UNTRACKED_FILE_BYTES => excluded.push(rel.clone()),
                    Ok(Some(_)) => allowed.push(rel.clone()),
                    // A previously indexed untracked path was deleted: include the deletion.
                    _ => {
                        if shadow_tracked.contains(&shadow_key(rel)) {
                            allowed.push(rel.clone());
                        }
                    }
                }
            }
        }
        let mut paths = source_tracked_paths;
        let mut have: HashSet<String> = paths.iter().cloned().collect();
        for p in allowed {
            if have.insert(p.clone()) {
                paths.push(p);
            }
        }
        Ok((paths, excluded))
    }

    /// `captureTreeUnlocked`: the tree of the worktree now (the caller holds the lock). `after`: a
    /// capture that began after that sequence, with no reported write since, is shared.
    pub(super) async fn capture_tree(&self, tool_paths: &HashSet<String>, after: Option<u64>) -> R<String> {
        self.ensure_state().await?;
        if let Some(after) = after {
            let state = self.st();
            if let Some(last) = &state.last_capture
                && last.seq > after && last.stamp == state.change_stamp && tool_paths.iter().all(|rel| last.explicit.contains(rel)) {
                    return Ok(last.tree.clone());
                }
        }
        let seq = {
            let mut state = self.st();
            state.capture_seq += 1;
            state.last_capture = None;
            state.capture_seq
        };
        let stamp = self.st().change_stamp;
        let (mut paths, excluded_untracked) = self.changed_worktree_paths().await?;
        for rel in tool_paths {
            match self.disk().lstat(Path::new(&nodepath::resolve_host(&[&self.root, rel]))).await {
                Ok(Some(stat)) if stat.is_file || stat.is_symlink => paths.push(rel.clone()),
                Ok(_) => {}
                Err(e) => return Err(e.to_string()),
            }
        }
        if !paths.is_empty() {
            let mut unique = Vec::new();
            let mut seen = HashSet::new();
            for p in paths {
                if seen.insert(p.clone()) {
                    unique.push(p);
                }
            }
            let input = format!("{}\0", unique.join("\0")).into_bytes();
            self.shadow(&["add", "--force", "--all", "--sparse", "--pathspec-from-file=-", "--pathspec-file-nul"], input).await?;
        }
        let excluded: Vec<String> = excluded_untracked.into_iter().filter(|rel| !tool_paths.contains(rel)).collect();
        if !excluded.is_empty() {
            // A small untracked file may already live in the persistent shadow index; one that grew
            // past the bound loses only its index entry.
            let input = format!("{}\0", excluded.join("\0")).into_bytes();
            self.shadow(&["update-index", "--force-remove", "-z", "--stdin"], input).await?;
        }
        let tree = clean(&String::from_utf8_lossy(&self.shadow(&["write-tree"], Vec::new()).await?.stdout)).to_owned();
        self.st().last_capture = Some(Capture { seq, stamp, explicit: tool_paths.clone(), tree: tree.clone() });
        Ok(tree)
    }

    /// `recordedTreeUnlocked`: a collected or never-written baseline restores nothing.
    pub(super) async fn recorded_tree(&self, tree: &str) -> R<bool> {
        self.ensure_state().await?;
        let out = self.run_args(self.shadow_args(&["cat-file", "-t", tree], None)?, Vec::new(), &GitOptions::default(), true).await?;
        Ok(out.code == 0 && clean(&String::from_utf8_lossy(&out.stdout)) == "tree")
    }

    // ── baselines ──────────────────────────────────────────────────────────

    /// `applyBaselineFilesUnlocked`: `tree` with `entries` (recorded first states) applied.
    /// `absent`: keys of paths known not to be in `tree`, whose removal is a no-op.
    pub(super) async fn apply_baseline_files(&self, tree: &str, all: &[BaselineEntry], absent: Option<&HashSet<String>>) -> R<(String, Vec<Value>)> {
        let mut files: Vec<Value> = Vec::new();
        // Omitted baselines change no tree: they are carried as metadata only.
        for entry in all.iter().filter(|e| e.omitted) {
            files.push(serde_json::json!({"path": safe_relative_path(&self.root, &entry.path)?, "oid": null, "omitted": true, "size": entry.size}));
        }
        let mut entries: Vec<ToolEntry> = Vec::new();
        for entry in all.iter().filter(|e| !e.omitted) {
            let path = safe_relative_path(&self.root, &entry.path)?;
            let noop = entry.content.is_none() && entry.oid.is_none() && absent.is_some_and(|a| a.contains(&shadow_key(&path)));
            entries.push((path, entry.content.clone(), entry.oid.clone(), noop));
        }
        if entries.iter().all(|e| e.3) {
            files.extend(entries.iter().map(|e| serde_json::json!({"path": e.0, "oid": null})));
            return Ok((tree.to_owned(), files));
        }
        let index = self.git_dir.join(format!("index.baseline-{}-{}", std::process::id(), self.repos.temp_seq.fetch_add(1, Ordering::SeqCst) + 1));
        let mut applied = files.clone();
        let outcome = self.apply_in_index(tree, &entries, &mut applied, Some(&index)).await;
        let _ = self.disk().remove(&index).await;
        let mut lock = index.into_os_string();
        lock.push(".lock");
        let _ = self.disk().remove(Path::new(&lock)).await;
        match outcome {
            Ok(tree) => Ok((tree, applied)),
            // The original sequence in the shadow index: it fails, if at all, as before.
            Err(_) => {
                let mut applied = files;
                let tree = self.apply_in_shadow_index(tree, &entries, &mut applied).await?;
                Ok((tree, applied))
            }
        }
    }

    async fn apply_in_index(&self, tree: &str, entries: &[ToolEntry], files: &mut Vec<Value>, index: Option<&Path>) -> R<String> {
        let options = GitOptions { index_file: index.map(Path::to_path_buf), max_bytes: None };
        let run = |args: Vec<&str>, input: Vec<u8>| {
            let args = self.shadow_args(&args, None);
            let options = options.clone();
            async move { self.run_args(args?, input, &options, false).await }
        };
        run(vec!["read-tree", tree], Vec::new()).await?;
        for (path, content, recorded, noop) in entries {
            if *noop {
                files.push(serde_json::json!({"path": path, "oid": null}));
                continue;
            }
            let mut oid = recorded.clone();
            if let Some(bytes) = content {
                let out = run(vec!["hash-object", "-w", "--stdin", "--path", path], bytes.clone()).await?;
                oid = Some(clean(&String::from_utf8_lossy(&out.stdout)).to_owned());
            }
            match &oid {
                Some(oid) => run(vec!["update-index", "--add", "--cacheinfo", "100644", oid, path], Vec::new()).await?,
                None => run(vec!["update-index", "--force-remove", "--", path], Vec::new()).await?,
            };
            files.push(serde_json::json!({"path": path, "oid": oid}));
        }
        let out = run(vec!["write-tree"], Vec::new()).await?;
        Ok(clean(&String::from_utf8_lossy(&out.stdout)).to_owned())
    }

    /// `applyInShadowIndex`: the shadow index saved as a tree, used, restored.
    async fn apply_in_shadow_index(&self, tree: &str, entries: &[ToolEntry], files: &mut Vec<Value>) -> R<String> {
        let saved = clean(&String::from_utf8_lossy(&self.shadow(&["write-tree"], Vec::new()).await?.stdout)).to_owned();
        let outcome = self.apply_in_index(tree, entries, files, None).await;
        self.shadow(&["read-tree", &saved], Vec::new()).await?;
        outcome
    }

    // ── diffs ──────────────────────────────────────────────────────────────

    /// The `diff --git` sections of one patch read, keyed by path; `None` once its output passed `max_bytes`.
    async fn patch_sections_by_path(&self, baseline: &str, current: &str, pathspec: &[String], max_bytes: usize) -> R<Option<IndexMap<String, Vec<u8>>>> {
        let mut args = vec!["diff", "--no-ext-diff", "--unified=3", "--find-renames", baseline, current, "--"];
        args.extend(pathspec.iter().map(String::as_str));
        let options = GitOptions { index_file: None, max_bytes: Some(max_bytes as u64 + PATCH_OUTPUT_SLACK_BYTES) };
        match self.run_args(self.shadow_args(&args, None)?, Vec::new(), &options, false).await {
            Ok(out) => Ok(Some(sections_by_path(&String::from_utf8_lossy(&out.stdout)))),
            Err(e) if e == OUTPUT_OVERFLOW => Ok(None),
            Err(e) => Err(e),
        }
    }

    /// `combinedTreeDiff`: a range's name-status, numstat and whole patch from one `git diff`.
    async fn combined_tree_diff(&self, range: &[String]) -> R<Option<Combined>> {
        let mut args = vec!["diff", "--raw", "--numstat", "--patch", "--no-ext-diff", "--unified=3", "-z"];
        args.extend(range.iter().map(String::as_str));
        let options = GitOptions { index_file: None, max_bytes: Some(COMMAND_MAX_BYTES + PATCH_OUTPUT_SLACK_BYTES) };
        let out = match self.run_args(self.shadow_args(&args, None)?, Vec::new(), &options, true).await {
            Ok(out) => out,
            Err(e) if e == OUTPUT_OVERFLOW => return Ok(None),
            Err(e) => return Err(e),
        };
        if out.code != 0 {
            return Ok(None);
        }
        let text = String::from_utf8_lossy(&out.stdout).into_owned();
        if text.is_empty() {
            return Ok(Some(Combined::default()));
        }
        let mut name_status: Vec<String> = Vec::new();
        let mut cursor = 0usize;
        let token = |cursor: &mut usize| -> Option<String> {
            let end = text[*cursor..].find('\0')? + *cursor;
            let value = text[*cursor..end].to_owned();
            *cursor = end + 1;
            Some(value)
        };
        while text[cursor..].starts_with(':') {
            let Some(header) = token(&mut cursor) else { return Ok(None) };
            let status = header.rsplit(' ').next().unwrap_or("").to_owned();
            if status.is_empty() {
                return Ok(None);
            }
            let mut paths = vec![token(&mut cursor)];
            if status.starts_with('R') || status.starts_with('C') {
                paths.push(token(&mut cursor));
            }
            if paths.iter().any(|p| p.as_deref().is_none_or(str::is_empty)) {
                return Ok(None);
            }
            name_status.push(status);
            name_status.extend(paths.into_iter().flatten());
        }
        let numstat_end = if text[cursor..].starts_with('\0') {
            cursor
        } else {
            match text[cursor..].find("\0\0") {
                Some(i) => cursor + i + 1,
                None => return Ok(None),
            }
        };
        Ok(Some(Combined {
            statuses: parse_name_status(&format!("{}\0", name_status.join("\0"))),
            stats: parse_numstat(&text[cursor..numstat_end]),
            sections: sections_by_path(&text[numstat_end + 1..]),
        }))
    }

    /// After the whole range overflowed: patches read in path batches, the smallest changes first.
    async fn batched_patch_sections(&self, baseline: &str, current: &str, files: &[Obj], sections: &mut IndexMap<String, Vec<u8>>) -> R<()> {
        let lines = |f: &Obj| f.get("additions").and_then(Value::as_f64).unwrap_or(0.0) + f.get("deletions").and_then(Value::as_f64).unwrap_or(0.0);
        let mut remaining = REVIEW_PATCH_MAX_BYTES as i64;
        let mut queue: Vec<&Obj> = files.iter().filter(|f| 2.0 * lines(f) <= REVIEW_FILE_PATCH_MAX_BYTES as f64).collect();
        queue.sort_by(|a, b| lines(a).partial_cmp(&lines(b)).unwrap_or(std::cmp::Ordering::Equal));
        let mut index = 0;
        while index < queue.len() && remaining > 0 {
            let mut stack: Vec<Vec<&Obj>> = vec![queue[index..(index + PATCH_BATCH_FILES).min(queue.len())].to_vec()];
            // Depth-first, first half first, as the recursive reads of the original run.
            while let Some(batch) = stack.pop() {
                if batch.is_empty() || remaining <= 0 {
                    continue;
                }
                let pathspec: Vec<String> = batch
                    .iter()
                    .flat_map(|f| {
                        let path = f.get("path").and_then(Value::as_str).map(literal_pathspec);
                        let old = f.get("oldPath").and_then(Value::as_str).filter(|p| !p.is_empty()).map(literal_pathspec);
                        [path, old].into_iter().flatten()
                    })
                    .collect();
                match self.patch_sections_by_path(baseline, current, &pathspec, remaining as usize).await? {
                    None => {
                        if batch.len() == 1 {
                            continue;
                        }
                        let half = batch.len().div_ceil(2);
                        stack.push(batch[half..].to_vec());
                        stack.push(batch[..half].to_vec());
                    }
                    Some(found) => {
                        for (key, section) in found {
                            if section.len() <= REVIEW_FILE_PATCH_MAX_BYTES {
                                remaining -= section.len() as i64;
                            }
                            sections.insert(key, section);
                        }
                    }
                }
            }
            index += PATCH_BATCH_FILES;
        }
        Ok(())
    }

    async fn bounded_tree_patch(&self, baseline: &str, current: &str, pathspec: &[String], files: Vec<Obj>) -> R<(String, Vec<Obj>)> {
        let mut sections = self.patch_sections_by_path(baseline, current, pathspec, COMMAND_MAX_BYTES as usize).await?;
        // Read whole, every file has its section; read in batches, a file without one was too large.
        let whole = sections.is_some();
        if sections.is_none() {
            let mut found = IndexMap::new();
            self.batched_patch_sections(baseline, current, &files, &mut found).await?;
            sections = Some(found);
        }
        Ok(bounded_from_sections(files, &sections.unwrap_or_default(), whole))
    }

    /// `diffTreesUnlocked`: the review of `current` against `baseline`, scoped to `paths`.
    pub(super) async fn diff_trees(&self, baseline: &str, current: &str, paths: Option<&[String]>) -> R<TreeReview> {
        if baseline.is_empty() || current.is_empty() || baseline == current {
            return Ok(TreeReview { current_tree: current.to_owned(), ..TreeReview::default() });
        }
        // A scoped review restricts the range to the paths its session owns: the baseline describes
        // the whole worktree, concurrent sessions included.
        let pathspec: Vec<String> = match paths {
            Some(p) if !p.is_empty() => p.to_vec(),
            _ => vec![".".into()],
        };
        let mut range: Vec<String> = vec!["--find-renames".into(), baseline.into(), current.into(), "--".into()];
        range.extend(pathspec.iter().cloned());
        if let Some(combined) = self.combined_tree_diff(&range).await? {
            let files = review_files(&combined.statuses, &combined.stats);
            let (patch, files) = bounded_from_sections(files, &combined.sections, true);
            let diff_too_large = review_diff_too_large(&files, &patch);
            return Ok(TreeReview { patch, files, patch_truncated: false, diff_too_large, current_tree: current.to_owned() });
        }
        let range_refs: Vec<&str> = range.iter().map(String::as_str).collect();
        let mut ns = vec!["diff", "--name-status", "-z"];
        ns.extend(&range_refs);
        let mut num = vec!["diff", "--numstat", "-z"];
        num.extend(&range_refs);
        let (name_status, numstat) = tokio::join!(self.shadow(&ns, Vec::new()), self.shadow(&num, Vec::new()));
        let files = review_files(&parse_name_status(&String::from_utf8_lossy(&name_status?.stdout)), &parse_numstat(&String::from_utf8_lossy(&numstat?.stdout)));
        let (patch, files) = self.bounded_tree_patch(baseline, current, &pathspec, files).await?;
        let diff_too_large = review_diff_too_large(&files, &patch);
        Ok(TreeReview { patch, files, patch_truncated: false, diff_too_large, current_tree: current.to_owned() })
    }

    /// `filePatchUnlocked`: one file's patch between two trees, up to `max_bytes`.
    pub(super) async fn file_patch(&self, baseline: &str, current: &str, path: &str, old_path: &str, max_bytes: usize) -> R<Obj> {
        let mut reply = Obj::new();
        if baseline.is_empty() || current.is_empty() || baseline == current {
            reply.insert("patch".into(), Value::String(String::new()));
            return Ok(reply);
        }
        let pathspec: Vec<String> = [path, old_path].into_iter().filter(|p| !p.is_empty()).map(literal_pathspec).collect();
        let sections = self.patch_sections_by_path(baseline, current, &pathspec, max_bytes).await?;
        let section = sections.as_ref().and_then(|s| s.get(&shadow_key(path)).or_else(|| (!old_path.is_empty()).then(|| s.get(&shadow_key(old_path))).flatten()));
        if sections.is_none() || section.is_some_and(|s| s.len() > max_bytes) {
            reply.insert("patch".into(), Value::String(String::new()));
            reply.insert("patchOmitted".into(), Value::Bool(true));
            reply.insert("reason".into(), Value::String(PATCH_TOO_LARGE.into()));
            return Ok(reply);
        }
        reply.insert("patch".into(), Value::String(section.map(|s| String::from_utf8_lossy(s).into_owned()).unwrap_or_default()));
        Ok(reply)
    }

    // ── maintenance ────────────────────────────────────────────────────────

    /// `scheduleShadowGc`: one maintenance pass per repository per process, off the turn's critical path.
    pub(super) fn schedule_gc(self: &Arc<Self>) {
        if self.st().forgotten {
            return;
        }
        if !self.repos.maintained.lock().unwrap_or_else(|e| e.into_inner()).insert(self.git_dir.clone()) {
            return;
        }
        let started = Arc::new(AtomicBool::new(false));
        let (root, flag) = (self.clone(), started.clone());
        let task = tokio::spawn(async move {
            tokio::time::sleep(SHADOW_GC_DELAY).await;
            flag.store(true, Ordering::SeqCst);
            // Outside the state lock: collection can run for minutes and git serializes itself
            // through gc.lock. `forget_root` waits for this before deleting the repository.
            if let Ok(args) = root.shadow_args(&["gc", "--auto", &format!("--prune={SHADOW_GC_PRUNE}"), "--quiet"], None) {
                let _ = root.run_args(args, Vec::new(), &GitOptions::default(), true).await;
            }
        });
        *self.gc.lock().unwrap_or_else(|e| e.into_inner()) = Some(Gc { started, task });
    }
}

// ── parsing ────────────────────────────────────────────────────────────────

#[derive(Default)]
struct Combined {
    statuses: IndexMap<String, NameStatus>,
    stats: IndexMap<String, NumStat>,
    sections: IndexMap<String, Vec<u8>>,
}

#[derive(Clone)]
struct NameStatus {
    path: String,
    old_path: Option<String>,
    status: String,
}

#[derive(Clone)]
struct NumStat {
    path: String,
    old_path: Option<String>,
    additions: Option<f64>,
    deletions: Option<f64>,
    binary: bool,
}

fn parse_name_status(text: &str) -> IndexMap<String, NameStatus> {
    let mut out = IndexMap::new();
    let tokens: Vec<&str> = text.split('\0').collect();
    let mut index = 0;
    while index < tokens.len() {
        let raw = tokens[index];
        index += 1;
        if raw.is_empty() {
            continue;
        }
        let code = raw.chars().next().unwrap_or('M');
        let old = tokens.get(index).copied().unwrap_or("");
        index += 1;
        if old.is_empty() {
            continue;
        }
        let renamed = code == 'R' || code == 'C';
        let new = if renamed {
            let value = tokens.get(index).copied().unwrap_or("");
            index += 1;
            value
        } else {
            old
        };
        if new.is_empty() {
            continue;
        }
        out.insert(shadow_key(new), NameStatus { path: new.replace('\\', "/"), old_path: renamed.then(|| old.replace('\\', "/")), status: code.to_string() });
    }
    out
}

fn parse_numstat(text: &str) -> IndexMap<String, NumStat> {
    let mut out = IndexMap::new();
    let mut cursor = 0usize;
    while cursor < text.len() {
        let Some(first_tab) = text[cursor..].find('\t').map(|i| i + cursor) else { break };
        let Some(second_tab) = text[first_tab + 1..].find('\t').map(|i| i + first_tab + 1) else { break };
        let Some(path_end) = text[second_tab + 1..].find('\0').map(|i| i + second_tab + 1) else { break };
        let added_raw = &text[cursor..first_tab];
        let deleted_raw = &text[first_tab + 1..second_tab];
        let mut path = text[second_tab + 1..path_end].to_owned();
        let mut old_path = None;
        cursor = path_end + 1;
        if path.is_empty() {
            let Some(old_end) = text[cursor..].find('\0').map(|i| i + cursor) else { break };
            let Some(new_end) = text[old_end + 1..].find('\0').map(|i| i + old_end + 1) else { break };
            old_path = Some(text[cursor..old_end].to_owned());
            path = text[old_end + 1..new_end].to_owned();
            cursor = new_end + 1;
        }
        if path.is_empty() {
            continue;
        }
        let count = |raw: &str| (raw != "-").then(|| raw.parse::<f64>().unwrap_or(0.0));
        out.insert(
            shadow_key(&path),
            NumStat {
                path: path.replace('\\', "/"),
                old_path: old_path.filter(|p| !p.is_empty()).map(|p| p.replace('\\', "/")),
                additions: count(added_raw),
                deletions: count(deleted_raw),
                binary: added_raw == "-" || deleted_raw == "-",
            },
        );
    }
    out
}

fn sections_by_path(patch_text: &str) -> IndexMap<String, Vec<u8>> {
    let bytes = patch_text.as_bytes();
    let mut sections = IndexMap::new();
    for section in split_patch_sections(bytes) {
        let path = section.new_path.as_deref().or(section.old_path.as_deref());
        if let Some(path) = path.filter(|p| !p.is_empty()) {
            sections.insert(shadow_key(path), bytes[section.start..section.end].to_vec());
        }
    }
    sections
}

/// `reviewFiles`: review rows from the name-status and numstat reads of one range.
fn review_files(statuses: &IndexMap<String, NameStatus>, stats: &IndexMap<String, NumStat>) -> Vec<Obj> {
    let mut keys: Vec<&String> = statuses.keys().collect();
    keys.extend(stats.keys().filter(|k| !statuses.contains_key(*k)));
    let mut files: Vec<Obj> = keys
        .into_iter()
        .map(|key| {
            let (status, stat) = (statuses.get(key), stats.get(key));
            let path = status.map(|s| s.path.clone()).or_else(|| stat.map(|s| s.path.clone())).filter(|p| !p.is_empty()).unwrap_or_else(|| key.clone());
            let old_path = status.and_then(|s| s.old_path.clone()).or_else(|| stat.and_then(|s| s.old_path.clone()));
            let number = |v: Option<f64>| v.map_or(Value::Null, |n| Value::from(n as u64));
            let mut file = Obj::new();
            file.insert("path".into(), Value::String(path));
            file.insert("oldPath".into(), old_path.map_or(Value::Null, Value::String));
            file.insert("status".into(), Value::String(status.map_or_else(|| "M".to_owned(), |s| s.status.clone())));
            file.insert("additions".into(), number(stat.and_then(|s| s.additions)));
            file.insert("deletions".into(), number(stat.and_then(|s| s.deletions)));
            file.insert("binary".into(), Value::Bool(stat.is_some_and(|s| s.binary)));
            file
        })
        .collect();
    files.sort_by(|a, b| mixdog_js::locale_compare(a["path"].as_str().unwrap_or(""), b["path"].as_str().unwrap_or("")));
    files
}

/// `boundedTreePatchFromSections`: `files` with the patch `sections` that fit the reply caps;
/// `whole`: the sections are a complete read, so a file without one has no patch.
fn bounded_from_sections(files: Vec<Obj>, sections: &IndexMap<String, Vec<u8>>, whole: bool) -> (String, Vec<Obj>) {
    let mut budget = ReviewPatchBudget::default();
    let mut kept: Vec<u8> = Vec::new();
    let bounded = files
        .into_iter()
        .map(|file| {
            let section = sections.get(&shadow_key(file["path"].as_str().unwrap_or("")));
            match section {
                None if whole => file,
                Some(section) if budget.admit(section.len()) => {
                    kept.extend_from_slice(section);
                    file
                }
                _ => patch_omitted_file(file),
            }
        })
        .collect();
    (String::from_utf8_lossy(&kept).into_owned(), bounded)
}

pub(super) fn pending_content(before: &ReviewContent) -> (Option<Vec<u8>>, Option<u64>) {
    // recordTurnWorktreeFileChange: bytes beyond the tool-baseline bound are neither kept nor hashed.
    match before {
        ReviewContent::Absent => (None, None),
        ReviewContent::Bytes(bytes) if bytes.len() <= MAX_TOOL_BASELINE_BYTES => (Some(bytes.to_vec()), None),
        ReviewContent::Bytes(bytes) => (None, Some(bytes.len() as u64)),
        ReviewContent::Omitted { size, .. } => (None, Some(*size)),
    }
}

/// The root states by key, for tests of the cleanup.
#[allow(dead_code)]
pub(super) fn state_keys(repos: &ShadowRepos) -> HashMap<String, PathBuf> {
    repos.shared.states.lock().unwrap_or_else(|e| e.into_inner()).iter().map(|(k, v)| (k.clone(), v.git_dir.clone())).collect()
}
