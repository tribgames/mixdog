//! The one OS watcher (DS §4.3): a single `notify` backend for the whole core,
//! every consumer attached by reference. Changes are pushed; nothing polls.
//! Events of a watch are collected for a fixed trailing 250 ms window and pushed
//! as one `fs/changed` per kind. A recursive watch of a checkout, or of a folder
//! inside one, also follows its repository's git dirs (a linked worktree keeps
//! them outside the folder, a sub-folder has them above it), skipping the object
//! store; those events carry kind `git`.

use std::collections::BTreeSet;
use std::collections::HashMap;
use std::path::Path;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::PoisonError;
use std::sync::Weak;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Duration;
use std::time::Instant;

use crossbeam_channel::Receiver;
use crossbeam_channel::Sender;
use crossbeam_channel::unbounded;
use notify::EventKind;
use notify::RecommendedWatcher;
use notify::RecursiveMode;
use notify::Watcher;
use notify::event::ModifyKind;

use crate::error::Reason;
use crate::error::WsError;
use crate::error::WsResult;
use crate::pathguard::comparable;
use crate::pathguard::is_within;
use crate::watch::BATCH_WINDOW_MS;
use crate::watch::git_event_delivered;

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum ChangeKind {
    Modified,
    Removed,
    Renamed,
    Git,
    Overflow,
}

impl ChangeKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Modified => "modified",
            Self::Removed => "removed",
            Self::Renamed => "renamed",
            Self::Git => "git",
            Self::Overflow => "overflow",
        }
    }
}

/// Receives each pushed batch. Called on the watcher's worker thread, and by the end of a [`hold_root`] (its `Overflow`); it must
/// not block.
pub trait ChangeSink: Send + Sync + 'static {
    fn changed(&self, watch_id: &str, paths: Vec<String>, kind: ChangeKind);
}

enum Message {
    Event(notify::Result<notify::Event>, QueuedChange),
    Stop,
}

/// Covers ingress through application, not just the public feed's batch window.
/// The notify callback cannot take the watcher state lock: registering a watch
/// under that lock can wait for the backend thread.
struct QueuedChange(Option<Arc<AtomicUsize>>);

impl QueuedChange {
    fn new(pending: &Arc<AtomicUsize>, event: &notify::Result<notify::Event>) -> Self {
        let changes_coverage = event.as_ref().map_or(true, |event| event.need_rescan() || !matches!(event.kind, EventKind::Access(_)));
        Self(changes_coverage.then(|| {
            pending.fetch_add(1, Ordering::SeqCst);
            pending.clone()
        }))
    }
}

impl Drop for QueuedChange {
    fn drop(&mut self) {
        if let Some(pending) = &self.0 {
            pending.fetch_sub(1, Ordering::SeqCst);
        }
    }
}

fn enqueue_event(tx: &Sender<Message>, pending: &Arc<AtomicUsize>, event: notify::Result<notify::Event>) {
    let change = QueuedChange::new(pending, &event);
    let _ = tx.send(Message::Event(event, change));
}

struct Sub {
    path: PathBuf,
    recursive: bool,
    git_dirs: Vec<PathBuf>,
    /// The trailing window this watch's events are collected for before they are pushed.
    window_ms: u64,
}

#[derive(Default)]
struct OsPath {
    /// The path the backend knows the watch by (the first one registered of its case-folded key).
    path: PathBuf,
    /// `path` resolved, as the backend may name it in events ([`crate::pathguard::resolved`]).
    real: PathBuf,
    recursive_refs: usize,
    direct_refs: usize,
    coverage: Option<Arc<()>>,
}

struct State {
    watcher: Option<RecommendedWatcher>,
    subs: HashMap<String, Sub>,
    os: HashMap<PathBuf, OsPath>,
    registry: crate::watch::WatchRegistry,
    /// Told when a hold's end opens a watch's handles again.
    sink: Arc<dyn ChangeSink>,
}

/// The roots no watcher of this process may hold a handle under, one entry per live [`RootHold`].
static HELD: Mutex<Vec<PathBuf>> = Mutex::new(Vec::new());
/// Every watcher of this process, for a hold to reach the ones it did not create.
static WATCHERS: Mutex<Vec<Weak<Mutex<State>>>> = Mutex::new(Vec::new());

fn held(path: &Path) -> bool {
    HELD.lock().unwrap_or_else(PoisonError::into_inner).iter().any(|root| is_within(root, path))
}

fn live_watchers() -> Vec<Arc<Mutex<State>>> {
    let mut all = WATCHERS.lock().unwrap_or_else(PoisonError::into_inner);
    all.retain(|state| state.strong_count() > 0);
    all.iter().filter_map(Weak::upgrade).collect()
}

/// Returns once the backend has acted on every unwatch sent to it before: Windows' backend only queues an unwatch for its own thread,
/// which closes the handle later, and answers a configure request after everything queued ahead of it. The other backends unwatch
/// within the call. A request the backend did not answer is no proof: an error.
fn settle(watcher: &mut RecommendedWatcher) -> WsResult<()> {
    #[cfg(windows)]
    watcher
        .configure(notify::Config::default())
        .map_err(|error| WsError::new(Reason::Io, format!("The file watcher did not confirm that it closed its watches: {error}")))?;
    #[cfg(not(windows))]
    let _ = watcher;
    Ok(())
}

/// Keeps every watcher of this process from holding a handle at or under `root` until it is dropped: Windows refuses to rename or
/// delete a folder while a handle is open inside it. When this returns, the handles there are closed; watches registered there in
/// the meantime keep their registration without one. The drop opens them again, unless another hold still covers them, and tells
/// each watch it served `Overflow` (it may have missed changes, and the folder may have been replaced). An error when a watcher
/// could not confirm its handles closed; the hold is ended then.
pub fn hold_root(root: &Path) -> WsResult<RootHold> {
    HELD.lock().unwrap_or_else(PoisonError::into_inner).push(root.to_path_buf());
    let hold = RootHold { root: root.to_path_buf() };
    // After the push: a watch opened from now on sees the hold, and one opened before is closed here.
    for state in live_watchers() {
        state.lock().unwrap_or_else(PoisonError::into_inner).close_under(Some(root))?;
    }
    Ok(hold)
}

/// A live [`hold_root`].
pub struct RootHold {
    root: PathBuf,
}

impl Drop for RootHold {
    fn drop(&mut self) {
        {
            let mut held = HELD.lock().unwrap_or_else(PoisonError::into_inner);
            if let Some(at) = held.iter().position(|root| *root == self.root) {
                held.remove(at);
            }
        }
        for state in live_watchers() {
            let (sink, resumed) = {
                let mut state = state.lock().unwrap_or_else(PoisonError::into_inner);
                (state.sink.clone(), state.reopen_under(&self.root))
            };
            for id in resumed {
                sink.changed(&id, Vec::new(), ChangeKind::Overflow);
            }
        }
    }
}

pub struct FolderWatcher {
    state: Arc<Mutex<State>>,
    stop: Sender<Message>,
    pending: Arc<AtomicUsize>,
}

/// The git dir and common dir of the repository a folder belongs to, found as
/// git finds it: the nearest `.git` at or above the folder, so a folder below
/// its repository's root follows that root's metadata. `.git` itself, or the
/// targets a linked worktree's `.git` file names.
#[allow(clippy::disallowed_methods, reason = "a stat per ancestor and two tiny reads, called only inside the lane job that registers a watch")]
pub fn git_dirs_of(dir: &Path) -> Vec<PathBuf> {
    let Some(checkout) = dir.ancestors().find(|folder| folder.join(".git").exists()) else {
        return Vec::new();
    };
    let dot_git = checkout.join(".git");
    let mut dirs = Vec::new();
    if dot_git.is_dir() {
        dirs.push(dot_git);
    } else if let Ok(text) = std::fs::read_to_string(&dot_git)
        && let Some(target) = text.trim().strip_prefix("gitdir:")
    {
        let git_dir = checkout.join(target.trim());
        if let Ok(common) = std::fs::read_to_string(git_dir.join("commondir")) {
            dirs.push(crate::pathguard::lexical(&git_dir.join(common.trim())));
        }
        dirs.push(crate::pathguard::lexical(&git_dir));
    }
    dirs.retain(|d| d.is_dir());
    dirs.dedup();
    dirs
}

/// A watch the backend refused, as Node's `fs.watch` threw it: libuv's code and text for the OS error, `watch '<path>'`.
#[allow(
    clippy::disallowed_methods,
    clippy::disallowed_types,
    reason = "a stat and an open that name a refused watch's error, called only inside the lane job that registers the watch"
)]
fn watch_failure(error: &notify::Error, path: &Path) -> WsError {
    // libuv opens the path itself and fails with what the system said; the backend checks the path first and says it in words of its
    // own, so a path the system cannot even stat is named by that system error.
    if let Err(stat) = std::fs::metadata(path) {
        return crate::nodeerr::io_error(&stat, "watch", path);
    }
    // libuv opens a directory to watch for listing (`FILE_LIST_DIRECTORY`, `FILE_FLAG_BACKUP_SEMANTICS`); a folder the user may not list
    // fails there with the system's own error, which the backend reports as a missing path.
    #[cfg(windows)]
    if path.is_dir() {
        use std::os::windows::fs::OpenOptionsExt;
        const FILE_FLAG_BACKUP_SEMANTICS: u32 = 0x0200_0000;
        if let Err(open) = std::fs::OpenOptions::new().read(true).custom_flags(FILE_FLAG_BACKUP_SEMANTICS).open(path) {
            return crate::nodeerr::io_error(&open, "watch", path);
        }
    }
    let failure = match &error.kind {
        notify::ErrorKind::Io(io) => crate::nodeerr::io_error(io, "watch", path),
        notify::ErrorKind::PathNotFound => crate::nodeerr::io_error(&std::io::ErrorKind::NotFound.into(), "watch", path),
        // The inotify watch limit: libuv's ENOSPC.
        notify::ErrorKind::MaxFilesWatch => WsError::coded("ENOSPC", String::new()),
        _ => WsError::new(Reason::Io, format!("Cannot watch {}: {error}", path.display())),
    };
    // Node names the watch limit in words of its own (`node:internal/fs/watchers` FSWatcher.prototype[kFSWatchStart], Node 22.20).
    if failure.reason == Reason::Coded("ENOSPC") {
        return WsError::coded("ENOSPC", format!("ENOSPC: System limit for number of file watchers reached, watch '{}'", path.display()));
    }
    failure
}

fn classify(kind: &EventKind) -> ChangeKind {
    match kind {
        EventKind::Remove(_) => ChangeKind::Removed,
        EventKind::Modify(ModifyKind::Name(_)) => ChangeKind::Renamed,
        _ => ChangeKind::Modified,
    }
}

/// What follows `root` in `path`; `None` when `path` is neither `root` nor under it.
fn below(root: &Path, path: &Path) -> Option<PathBuf> {
    is_within(root, path).then(|| path.components().skip(root.components().count()).collect())
}

fn joined(root: &Path, rest: &Path) -> PathBuf {
    if rest.as_os_str().is_empty() { root.to_path_buf() } else { root.join(rest) }
}

impl State {
    fn apply(&mut self, path: &Path) -> WsResult<()> {
        let key = comparable(path);
        let Some(entry) = self.os.get_mut(&key) else {
            if let Some(w) = self.watcher.as_mut() {
                let _ = w.unwatch(path);
            }
            return Ok(());
        };
        entry.coverage = None;
        let mode = if entry.recursive_refs > 0 { RecursiveMode::Recursive } else { RecursiveMode::NonRecursive };
        let path = entry.path.clone();
        let Some(w) = self.watcher.as_mut() else {
            // No backend (a test's controlled watcher): its registrations are covered, and only the events the test queues change them.
            entry.coverage = Some(Arc::new(()));
            return Ok(());
        };
        let _ = w.unwatch(&path);
        // Under a held root the registration stays without a handle; the hold's end opens it.
        if held(&path) {
            return Ok(());
        }
        w.watch(&path, mode).map_err(|error| watch_failure(&error, &path))?;
        // Resolved at each open: a hold's end may reopen the watch on a folder that replaced the old one.
        entry.real = crate::pathguard::resolved(&path);
        entry.coverage = Some(Arc::new(()));
        Ok(())
    }

    /// Gives up every OS watch at or under `root` (every one for `None`), returning once the backend has closed their handles (and
    /// any it was told to close before).
    fn close_under(&mut self, root: Option<&Path>) -> WsResult<()> {
        let State { watcher, os, .. } = self;
        let Some(w) = watcher.as_mut() else { return Ok(()) };
        for entry in os.values_mut().filter(|entry| root.is_none_or(|root| is_within(root, &entry.path))) {
            entry.coverage = None;
            let _ = w.unwatch(&entry.path);
        }
        settle(w)
    }

    /// Opens again the OS watches under `root` that no other hold covers; the ids of the watches they serve.
    fn reopen_under(&mut self, root: &Path) -> Vec<String> {
        let paths: Vec<PathBuf> = self.os.values().map(|entry| entry.path.clone()).filter(|path| is_within(root, path) && !held(path)).collect();
        for path in &paths {
            // One the mutation left missing stays closed; its watches are told all the same.
            let _ = self.apply(path);
        }
        let reopened: Vec<PathBuf> = paths.iter().map(|path| comparable(path)).collect();
        self.subs
            .iter()
            .filter(|(_, sub)| std::iter::once(&sub.path).chain(&sub.git_dirs).any(|path| reopened.contains(&comparable(path))))
            .map(|(id, _)| id.clone())
            .collect()
    }

    fn add_os(&mut self, path: &Path, recursive: bool) -> WsResult<()> {
        let entry = self.os.entry(comparable(path)).or_insert_with(|| OsPath { path: path.to_path_buf(), real: path.to_path_buf(), ..OsPath::default() });
        let before = (entry.recursive_refs > 0, entry.direct_refs + entry.recursive_refs > 0);
        let uncovered = entry.coverage.is_none();
        if recursive {
            entry.recursive_refs += 1
        } else {
            entry.direct_refs += 1
        }
        let after = (entry.recursive_refs > 0, true);
        if (before != after || uncovered)
            && let Err(error) = self.apply(path)
        {
            self.remove_os(path, recursive);
            return Err(error);
        }
        Ok(())
    }

    /// A reported path in every form the watches are compared in: first as the backend named it, then with each registered root it
    /// is under replaced by that root's resolved form ([`OsPath::real`]). A backend names a file under one spelling of its folder
    /// only: inotify keeps one path per directory (the one registered last), macOS names the resolved one. The roots were resolved
    /// when their watches opened, so nothing is read from the disk here (a held root admits no handle).
    fn forms(&self, path: &Path) -> Vec<PathBuf> {
        let mut forms = vec![path.to_path_buf()];
        forms.extend(self.os.values().filter_map(|entry| Some(joined(&entry.real, &below(&entry.path, path)?))));
        forms
    }

    /// The path whose `forms` ([`Self::forms`]) these are, as the watch registered at `registered` names it: as the backend named it
    /// when that is the watch's own spelling, else the form under the watch's resolved root, moved to the registered one. `None`
    /// when no form is under the watch.
    fn spelled(&self, registered: &Path, forms: &[PathBuf]) -> Option<PathBuf> {
        if let Some(named) = forms.first().filter(|named| is_within(registered, named)) {
            return Some(named.clone());
        }
        let real = &self.os.get(&comparable(registered))?.real;
        forms.iter().find_map(|form| below(real, form)).map(|rest| joined(registered, &rest))
    }

    fn remove_os(&mut self, path: &Path, recursive: bool) {
        let key = comparable(path);
        let Some(entry) = self.os.get_mut(&key) else { return };
        let registered = entry.path.clone();
        let was_recursive = entry.recursive_refs > 0;
        if recursive {
            entry.recursive_refs = entry.recursive_refs.saturating_sub(1)
        } else {
            entry.direct_refs = entry.direct_refs.saturating_sub(1)
        }
        let empty = entry.recursive_refs + entry.direct_refs == 0;
        let still_recursive = entry.recursive_refs > 0;
        if empty {
            self.os.remove(&key);
        }
        if empty || was_recursive != still_recursive {
            let _ = self.apply(&registered);
        }
    }
}

impl FolderWatcher {
    pub fn new(sink: Arc<dyn ChangeSink>) -> WsResult<Self> {
        Self::build(sink, true)
    }

    /// A watcher with no OS backend: it sees only the events a test queues (`queue_test_change`).
    #[cfg(test)]
    pub(crate) fn without_backend(sink: Arc<dyn ChangeSink>) -> Self {
        Self::build(sink, false).expect("a watcher without a backend starts")
    }

    fn build(sink: Arc<dyn ChangeSink>, backend: bool) -> WsResult<Self> {
        let (tx, rx) = unbounded::<Message>();
        let callback_tx = tx.clone();
        let pending = Arc::new(AtomicUsize::new(0));
        let callback_pending = pending.clone();
        let watcher = if backend {
            Some(
                notify::recommended_watcher(move |event| {
                    enqueue_event(&callback_tx, &callback_pending, event);
                })
                .map_err(|e| WsError::new(Reason::Io, format!("Cannot start the file watcher: {e}")))?,
            )
        } else {
            None
        };
        let state = Arc::new(Mutex::new(State {
            watcher,
            subs: HashMap::new(),
            os: HashMap::new(),
            registry: crate::watch::WatchRegistry::default(),
            sink: sink.clone(),
        }));
        WATCHERS.lock().unwrap_or_else(PoisonError::into_inner).push(Arc::downgrade(&state));
        let worker_state = state.clone();
        std::thread::Builder::new()
            .name("mixdog-fs-watcher".into())
            .spawn(move || run(rx, worker_state, sink))
            .map_err(|e| WsError::new(Reason::Io, e.to_string()))?;
        Ok(Self { state, stop: tx, pending })
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, State> {
        self.state.lock().expect("watcher state")
    }

    /// Attaches `id` to `path`. Consumers of one `(path, recursive)` share one OS watch. Its events are pushed after the standard
    /// [`BATCH_WINDOW_MS`] window.
    pub fn watch(&self, id: &str, path: &Path, recursive: bool) -> WsResult<()> {
        self.watch_windowed(id, path, recursive, BATCH_WINDOW_MS)
    }

    /// [`Self::watch`] with this watch's own batch window: its events are pushed `window_ms` after the first of a burst. The window is
    /// the watch's alone; every other watch keeps its own, and consumers of one OS watch share the events, not the timing.
    pub fn watch_windowed(&self, id: &str, path: &Path, recursive: bool, window_ms: u64) -> WsResult<()> {
        let mut state = self.lock();
        if state.subs.contains_key(id) {
            return Err(WsError::invalid("Watch id is already in use."));
        }
        let git_dirs = if recursive { git_dirs_of(path) } else { Vec::new() };
        state.registry.add(path, recursive);
        state.add_os(path, recursive).inspect_err(|_| {
            state.registry.remove(path, recursive);
        })?;
        for git in git_dirs.iter().filter(|g| !is_within(path, g)) {
            // A git dir that cannot be watched only loses its own events.
            let _ = state.add_os(git, true);
        }
        state.subs.insert(id.to_owned(), Sub { path: path.to_path_buf(), recursive, git_dirs, window_ms });
        Ok(())
    }

    pub fn unwatch(&self, id: &str) {
        let mut state = self.lock();
        let Some(sub) = state.subs.remove(id) else { return };
        state.registry.remove(&sub.path, sub.recursive);
        state.remove_os(&sub.path, sub.recursive);
        for git in sub.git_dirs.iter().filter(|g| !is_within(&sub.path, g)) {
            state.remove_os(git, true);
        }
    }

    /// The current root revision under uninterrupted recursive coverage, shared
    /// by all subscribers. `None` means the registration cannot validate a cache.
    pub(crate) fn coverage(&self, id: &str) -> Option<Arc<()>> {
        let state = self.lock();
        if self.pending.load(Ordering::SeqCst) != 0 {
            return None;
        }
        let sub = state.subs.get(id).filter(|sub| sub.recursive)?;
        state.os.get(&comparable(&sub.path))?.coverage.clone()
    }

    /// A cache can borrow an existing recursive watch, but not a direct watch
    /// or a registration whose backend has lost coverage.
    pub fn recursive_revision(&self, path: &Path) -> Option<Arc<()>> {
        let state = self.lock();
        if self.pending.load(Ordering::SeqCst) != 0 {
            return None;
        }
        state
            .subs
            .values()
            .filter(|sub| sub.recursive && is_within(&sub.path, path))
            .filter_map(|sub| {
                let revision = state.os.get(&comparable(&sub.path))?.coverage.as_ref()?;
                let git_covered = sub
                    .git_dirs
                    .iter()
                    .filter(|dir| !is_within(&sub.path, dir))
                    .all(|dir| state.os.get(&comparable(dir)).is_some_and(|watch| watch.recursive_refs > 0 && watch.coverage.is_some()));
                git_covered.then_some((sub.path.components().count(), revision))
            })
            .min_by_key(|(depth, _)| *depth)
            .map(|(_, revision)| revision.clone())
    }

    /// Live OS watches (shared ones counted once).
    pub fn open_watches(&self) -> usize {
        self.lock().os.len()
    }
}

impl Drop for FolderWatcher {
    fn drop(&mut self) {
        let _ = self.stop.send(Message::Stop);
        let mut state = self.lock();
        // Closed before the backend goes: its own stop closes them later, on its thread (see `hold_root`).
        // Nothing is left to do for a backend that did not answer.
        let _ = state.close_under(None);
        state.watcher = None;
    }
}

type Pending = HashMap<(String, ChangeKind), BTreeSet<String>>;

fn route(state: &mut State, event: &notify::Event, pending: &mut Pending) {
    let base_kind = classify(&event.kind);
    if matches!(event.kind, EventKind::Access(_)) {
        return;
    }
    let mut changed_roots = BTreeSet::new();
    for reported in &event.paths {
        // Matched by resolved root, whatever spelling the backend named the file in; each watch takes it in its own spelling: two
        // watches may name one folder through different links.
        let forms = state.forms(reported);
        for (id, sub) in &state.subs {
            let in_folder = state.spelled(&sub.path, &forms);
            let in_git = in_folder
                .as_ref()
                .and_then(|path| sub.git_dirs.iter().find(|g| is_within(g, path)).map(|g| (g, path.clone())))
                .or_else(|| sub.git_dirs.iter().find_map(|g| state.spelled(g, &forms).map(|path| (g, path))));
            let path = match (&in_git, in_folder) {
                (Some((_, path)), _) => path.clone(),
                (None, Some(path)) => path,
                (None, None) => continue,
            };
            // Cache coverage observes every change, including git events the
            // public feed deliberately filters out.
            if sub.recursive {
                changed_roots.insert(comparable(&sub.path));
            }
            let kind = if let Some((git, _)) = in_git {
                let relative = path.strip_prefix(git).unwrap_or(Path::new(""));
                if !git_event_delivered(relative) {
                    continue;
                }
                ChangeKind::Git
            } else if sub.recursive || path.parent().is_some_and(|p| comparable(p) == comparable(&sub.path)) || comparable(&path) == comparable(&sub.path) {
                base_kind
            } else {
                continue;
            };
            pending.entry((id.clone(), kind)).or_default().insert(path.to_string_lossy().into_owned());
        }
    }
    // Search freshness follows the OS root, not the subscriber that owned a
    // queued batch. The subscriber can disappear before that batch is pushed.
    for root in changed_roots {
        if let Some(path) = state.os.get_mut(&root)
            && path.coverage.is_some()
        {
            path.coverage = Some(Arc::new(()));
        }
    }
}

type Batch = Vec<((String, ChangeKind), BTreeSet<String>)>;

/// The fixed trailing window of each watch: the first event of a burst for a watch fixes that watch's deadline (its own
/// `window_ms`), later events join the same batch without moving it. Time is an argument, so the window is testable without a
/// clock.
#[derive(Default)]
struct Batcher {
    pending: Pending,
    flush_at: HashMap<String, Instant>,
}

impl Batcher {
    fn event(&mut self, state: &mut State, event: &notify::Event, now: Instant) {
        if event.need_rescan() {
            // A pathless event can conceal loss of the watch itself.
            self.lost(state, now);
            return;
        }
        if matches!(classify(&event.kind), ChangeKind::Removed | ChangeKind::Renamed) {
            let affected: Vec<PathBuf> = event.paths.iter().flat_map(|path| state.forms(path)).collect();
            for (root, path) in &mut state.os {
                if affected.iter().any(|affected| is_within(affected, root) || is_within(affected, &path.real)) {
                    path.coverage = None;
                }
            }
        }
        route(state, event, &mut self.pending);
        self.arm(state, now);
    }

    /// Fixes the deadline of every watch that has events collected and none yet.
    fn arm(&mut self, state: &State, now: Instant) {
        for (id, _) in self.pending.keys() {
            if !self.flush_at.contains_key(id) {
                let window_ms = state.subs.get(id).map_or(BATCH_WINDOW_MS, |sub| sub.window_ms);
                self.flush_at.insert(id.clone(), now + Duration::from_millis(window_ms));
            }
        }
    }

    fn overflow(&mut self, state: &State, now: Instant) {
        for id in state.subs.keys() {
            self.pending.entry((id.clone(), ChangeKind::Overflow)).or_default();
        }
        self.arm(state, now);
    }

    /// A backend error cannot establish which registrations still cover their roots.
    fn lost(&mut self, state: &mut State, now: Instant) {
        for path in state.os.values_mut() {
            path.coverage = None;
        }
        self.overflow(state, now);
    }

    /// The earliest deadline of a watch with events collected.
    fn deadline(&self) -> Option<Instant> {
        self.flush_at.values().min().copied()
    }

    /// The batches of the watches whose deadline has come; the others keep collecting.
    fn flush(&mut self, now: Instant) -> Batch {
        let due: Vec<String> = self.flush_at.iter().filter(|(_, at)| **at <= now).map(|(id, _)| id.clone()).collect();
        for id in &due {
            self.flush_at.remove(id);
        }
        let keys: Vec<(String, ChangeKind)> = self.pending.keys().filter(|(id, _)| due.contains(id)).cloned().collect();
        let mut batch: Batch = keys.into_iter().filter_map(|key| self.pending.remove(&key).map(|paths| (key, paths))).collect();
        batch.sort_by(|a, b| a.0.cmp(&b.0));
        batch
    }
}

#[cfg(test)]
pub(crate) fn queue_test_change(watcher: &FolderWatcher, path: PathBuf) {
    let event = notify::Event::new(EventKind::Modify(ModifyKind::Any)).add_path(path);
    let mut batcher = Batcher::default();
    batcher.event(&mut watcher.lock(), &event, Instant::now());
    // Deliberately do not deliver the batch: search freshness must not depend on it.
}

fn run(rx: Receiver<Message>, state: Arc<Mutex<State>>, sink: Arc<dyn ChangeSink>) {
    let mut batcher = Batcher::default();
    loop {
        let message = match batcher.deadline() {
            Some(deadline) => match rx.recv_timeout(deadline.saturating_duration_since(Instant::now())) {
                Ok(m) => Some(m),
                Err(crossbeam_channel::RecvTimeoutError::Timeout) => None,
                Err(crossbeam_channel::RecvTimeoutError::Disconnected) => return,
            },
            None => match rx.recv() {
                Ok(m) => Some(m),
                Err(_) => return,
            },
        };
        let now = Instant::now();
        match message {
            Some(Message::Stop) => return,
            Some(Message::Event(event, queued)) => {
                let mut state = state.lock().expect("watcher state");
                match event {
                    Ok(event) => batcher.event(&mut state, &event, now),
                    Err(_) => batcher.lost(&mut state, now),
                }
                drop(queued);
            }
            None => {}
        }
        if batcher.deadline().is_some_and(|deadline| deadline <= now) {
            for ((id, kind), paths) in batcher.flush(now) {
                sink.changed(&id, paths.into_iter().collect(), kind);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The watcher limit (inotify's `max_user_watches`) is answered as Node words it: libuv's ENOSPC with Node's own text in place of
    /// "no space left on device" (`node:internal/fs/watchers` FSWatcher.prototype[kFSWatchStart], Node 22.20).
    #[test]
    fn a_watch_over_the_watcher_limit_says_what_node_says() {
        let dir = tempfile::tempdir().unwrap();
        let error = watch_failure(&notify::Error::new(notify::ErrorKind::MaxFilesWatch), dir.path());
        assert_eq!(error.reason, Reason::Coded("ENOSPC"));
        assert_eq!(error.message, format!("ENOSPC: System limit for number of file watchers reached, watch '{}'", dir.path().display()));
    }
    use std::sync::mpsc;

    struct Collect(Mutex<mpsc::Sender<(String, Vec<String>, ChangeKind)>>);
    impl ChangeSink for Collect {
        fn changed(&self, id: &str, paths: Vec<String>, kind: ChangeKind) {
            let _ = self.0.lock().unwrap().send((id.to_owned(), paths, kind));
        }
    }

    fn watcher() -> (FolderWatcher, mpsc::Receiver<(String, Vec<String>, ChangeKind)>) {
        let (tx, rx) = mpsc::channel();
        (FolderWatcher::new(Arc::new(Collect(Mutex::new(tx)))).unwrap(), rx)
    }

    #[test]
    fn burst_is_batched_covers_all_paths_and_shares_one_os_watch() {
        let dir = tempfile::tempdir().unwrap();
        let root = crate::pathguard::canonical(dir.path()).unwrap();
        let (watcher, rx) = watcher();
        watcher.watch("w1", &root, true).unwrap();
        watcher.watch("w2", &root, true).unwrap();
        assert_eq!(watcher.open_watches(), 1);
        // Synthetic backend events and synthetic instants: the window is a function of the first
        // event's time alone, so no clock or OS timing is involved.
        let start = Instant::now();
        let mut batcher = Batcher::default();
        {
            let mut state = watcher.lock();
            for i in 0..200u32 {
                let event = notify::Event::new(EventKind::Modify(ModifyKind::Any)).add_path(root.join(format!("f{i}.txt")));
                batcher.event(&mut state, &event, start + Duration::from_millis(u64::from(i)));
            }
        }
        assert_eq!(batcher.deadline(), Some(start + Duration::from_millis(BATCH_WINDOW_MS)), "later events must not move the window");
        let batch = batcher.flush(start + Duration::from_millis(BATCH_WINDOW_MS));
        assert!(batcher.deadline().is_none());
        // One notification per watch, each covering every path.
        assert_eq!(batch.len(), 2);
        for ((id, kind), paths) in &batch {
            assert!(id == "w1" || id == "w2");
            assert_eq!(*kind, ChangeKind::Modified);
            assert_eq!(paths.iter().filter(|p| p.ends_with(".txt")).count(), 200);
        }
        drop(rx);
        watcher.unwatch("w1");
        watcher.unwatch("w2");
        assert_eq!(watcher.open_watches(), 0);
    }

    /// A watch with its own window is pushed when that window ends, ahead of a watch on the standard one, which keeps collecting.
    #[test]
    fn a_watch_with_its_own_window_is_pushed_on_it_and_others_keep_theirs() {
        let dir = tempfile::tempdir().unwrap();
        let root = crate::pathguard::canonical(dir.path()).unwrap();
        let (watcher, _rx) = watcher();
        watcher.watch_windowed("fast", &root, false, 40).unwrap();
        watcher.watch("slow", &root, false).unwrap();
        let start = Instant::now();
        let mut batcher = Batcher::default();
        {
            let mut state = watcher.lock();
            let event = notify::Event::new(EventKind::Modify(ModifyKind::Any)).add_path(root.join("a.txt"));
            batcher.event(&mut state, &event, start);
        }
        assert_eq!(batcher.deadline(), Some(start + Duration::from_millis(40)));
        let first = batcher.flush(start + Duration::from_millis(40));
        assert_eq!(first.iter().map(|((id, _), _)| id.as_str()).collect::<Vec<_>>(), ["fast"]);
        assert_eq!(batcher.deadline(), Some(start + Duration::from_millis(BATCH_WINDOW_MS)), "the other watch is not hurried");
        let second = batcher.flush(start + Duration::from_millis(BATCH_WINDOW_MS));
        assert_eq!(second.iter().map(|((id, _), _)| id.as_str()).collect::<Vec<_>>(), ["slow"]);
    }

    #[test]
    fn an_enqueued_change_blocks_coverage_before_the_worker_applies_it() {
        let dir = tempfile::tempdir().unwrap();
        let root = crate::pathguard::canonical(dir.path()).unwrap();
        let (watcher, _rx) = watcher();
        watcher.watch("root", &root, true).unwrap();
        let before = watcher.recursive_revision(&root).unwrap();
        let (tx, worker_queue) = unbounded();
        let event = notify::Event::new(EventKind::Modify(ModifyKind::Any)).add_path(root.join("changed.txt"));
        enqueue_event(&tx, &watcher.pending, Ok(event));
        assert!(watcher.recursive_revision(&root).is_none());
        let Message::Event(Ok(event), queued) = worker_queue.recv().unwrap() else { panic!("queued change") };
        Batcher::default().event(&mut watcher.lock(), &event, Instant::now());
        assert!(watcher.recursive_revision(&root).is_none());
        drop(queued);
        assert!(!Arc::ptr_eq(&before, &watcher.recursive_revision(&root).unwrap()));
    }

    /// A hold closes the handles under its root before it returns (Windows renames the folder at once), keeps a watch registered
    /// meanwhile without one, never touches the watch of a folder outside it, and at its end opens them again on the new folder
    /// with an `Overflow` to each watch it served.
    #[test]
    fn a_held_root_has_no_handle_until_the_hold_ends_and_other_watches_keep_theirs() {
        let dir = tempfile::tempdir().unwrap();
        let base = crate::pathguard::canonical(dir.path()).unwrap();
        let (root, other) = (base.join("plugin"), base.join("other"));
        std::fs::create_dir_all(root.join("skills")).unwrap();
        std::fs::create_dir_all(&other).unwrap();
        let (watcher, rx) = watcher();
        watcher.watch("skills", &root.join("skills"), true).unwrap();
        watcher.watch("other", &other, true).unwrap();
        let untouched = watcher.recursive_revision(&other).unwrap();
        let hold = hold_root(&root).unwrap();
        assert!(watcher.recursive_revision(&root.join("skills")).is_none());
        watcher.watch("late", &root, false).unwrap();
        std::fs::rename(&root, base.join("plugin.backup")).expect("no handle is open under the held root");
        std::fs::create_dir_all(root.join("skills")).unwrap();
        drop(hold);
        assert!(Arc::ptr_eq(&untouched, &watcher.recursive_revision(&other).unwrap()), "the unrelated watch was reopened");
        let mut resumed: Vec<String> = rx.try_iter().filter(|(_, _, kind)| *kind == ChangeKind::Overflow).map(|(id, ..)| id).collect();
        resumed.sort();
        assert_eq!(resumed, ["late", "skills"]);
        std::fs::write(root.join("skills").join("new.txt"), "x").unwrap();
        loop {
            let (id, paths, _) = rx.recv_timeout(Duration::from_secs(5)).expect("the reopened watch reports the new folder");
            if id == "skills" && paths.iter().any(|p| p.ends_with("new.txt")) {
                break;
            }
        }
    }

    /// Two recursive watches on one folder through two spellings (a link and its target; macOS' `/var/…` and `/private/var/…`): an
    /// event reaches both, each in its own spelling, and both revisions change, whichever spelling the backend names the file in
    /// (macOS the resolved one, inotify the one registered last) and whichever watch was registered first.
    #[test]
    fn one_event_reaches_the_watches_of_both_spellings_of_a_folder() {
        let dir = tempfile::tempdir().unwrap();
        let real = crate::pathguard::canonical(dir.path()).unwrap().join("project");
        std::fs::create_dir_all(&real).unwrap();
        let link = real.with_file_name("link-to-project");
        let shown = |path: &Path| BTreeSet::from([path.join("a.txt").to_string_lossy().into_owned()]);
        for order in [["real", "link"], ["link", "real"]] {
            for named in [&real, &link] {
                let case = format!("registered {order:?}, named under {}", named.display());
                let watcher = FolderWatcher::without_backend(Arc::new(Collect(Mutex::new(mpsc::channel().0))));
                for id in order {
                    watcher.watch(id, if id == "real" { &real } else { &link }, true).unwrap();
                }
                // What opening the link's watch on a backend finds; this watcher has none, and the link is not on the disk.
                watcher.lock().os.get_mut(&comparable(&link)).unwrap().real = real.clone();
                let (real_before, link_before) = (watcher.recursive_revision(&real).unwrap(), watcher.recursive_revision(&link).unwrap());
                let start = Instant::now();
                let mut batcher = Batcher::default();
                let event = notify::Event::new(EventKind::Modify(ModifyKind::Any)).add_path(named.join("a.txt"));
                batcher.event(&mut watcher.lock(), &event, start);
                let batch = batcher.flush(start + Duration::from_millis(BATCH_WINDOW_MS));
                assert_eq!(batch, [(("link".into(), ChangeKind::Modified), shown(&link)), (("real".into(), ChangeKind::Modified), shown(&real))], "{case}");
                assert!(!Arc::ptr_eq(&real_before, &watcher.recursive_revision(&real).unwrap()), "{case}");
                assert!(!Arc::ptr_eq(&link_before, &watcher.recursive_revision(&link).unwrap()), "{case}");
            }
        }
    }

    #[test]
    fn a_pathless_rescan_revokes_coverage_and_reaches_every_watch() {
        let dir = tempfile::tempdir().unwrap();
        let root = crate::pathguard::canonical(dir.path()).unwrap();
        let (watcher, _rx) = watcher();
        watcher.watch("one", &root, true).unwrap();
        watcher.watch("two", &root, true).unwrap();
        let before = watcher.coverage("one").expect("initial coverage");
        let rescan = notify::Event::new(EventKind::Other).set_flag(notify::event::Flag::Rescan);
        let start = Instant::now();
        let mut batcher = Batcher::default();
        batcher.event(&mut watcher.lock(), &rescan, start);
        assert!(watcher.coverage("one").is_none());
        assert!(watcher.coverage("two").is_none());
        let batch = batcher.flush(start + Duration::from_millis(BATCH_WINDOW_MS));
        assert_eq!(batch, [(("one".into(), ChangeKind::Overflow), BTreeSet::new()), (("two".into(), ChangeKind::Overflow), BTreeSet::new()),]);
        watcher.watch("reopened", &root, true).unwrap();
        let after = watcher.coverage("one").expect("rearmed coverage");
        assert!(!Arc::ptr_eq(&before, &after));
    }

    #[test]
    fn git_dir_events_are_tagged_and_objects_are_skipped() {
        let dir = tempfile::tempdir().unwrap();
        let root = crate::pathguard::canonical(dir.path()).unwrap();
        std::fs::create_dir_all(root.join(".git/objects")).unwrap();
        let (watcher, rx) = watcher();
        watcher.watch("w", &root, true).unwrap();
        std::fs::write(root.join(".git/objects/blob"), "x").unwrap();
        std::fs::write(root.join(".git/index"), "x").unwrap();
        // Until the `.git/index` write is announced; the objects write came first and is filtered
        // by the watcher itself, so it would never arrive later.
        let mut git_paths: Vec<String> = Vec::new();
        while !git_paths.iter().any(|p| p.ends_with("index")) {
            let (_, paths, kind) = rx.recv().expect("the watcher is alive");
            if kind == ChangeKind::Git {
                git_paths.extend(paths);
            }
        }
        while let Ok((_, paths, kind)) = rx.try_recv() {
            if kind == ChangeKind::Git {
                git_paths.extend(paths);
            }
        }
        assert!(git_paths.iter().any(|p| p.ends_with("index")));
        assert!(!git_paths.iter().any(|p| p.contains("objects")));
    }

    /// The git events of a watch until both `wanted` file names were announced; panics if the watcher goes quiet first.
    fn git_events_until(rx: &mpsc::Receiver<(String, Vec<String>, ChangeKind)>, wanted: &[&str]) -> Vec<String> {
        let mut git_paths: Vec<String> = Vec::new();
        while !wanted.iter().all(|name| git_paths.iter().any(|p| p.ends_with(name))) {
            let (_, paths, kind) = rx.recv_timeout(Duration::from_secs(5)).expect("a git event");
            if kind == ChangeKind::Git {
                git_paths.extend(paths);
            }
        }
        git_paths
    }

    /// A project opened below its repository's root (`/repo/app`) follows the repository's own metadata: a commit (the branch ref
    /// moves) and a branch change (HEAD is rewritten) made outside the folder reach the watch as git events.
    #[test]
    fn a_folder_below_its_repository_root_sees_a_commit_and_a_branch_change_outside_it() {
        let dir = tempfile::tempdir().unwrap();
        let repo = crate::pathguard::canonical(dir.path()).unwrap();
        std::fs::create_dir_all(repo.join(".git/refs/heads")).unwrap();
        std::fs::write(repo.join(".git/HEAD"), "ref: refs/heads/main\n").unwrap();
        std::fs::create_dir_all(repo.join("app/src")).unwrap();
        let app = repo.join("app");
        assert_eq!(git_dirs_of(&app), vec![repo.join(".git")]);
        assert_eq!(git_dirs_of(&app.join("src")), vec![repo.join(".git")], "any depth below the root");
        let (watcher, rx) = watcher();
        watcher.watch("app", &app, true).unwrap();
        assert_eq!(watcher.open_watches(), 2, "the folder and its repository's git dir");
        std::fs::write(repo.join(".git/refs/heads/main"), "0123456789abcdef0123456789abcdef01234567\n").unwrap();
        std::fs::write(repo.join(".git/HEAD"), "ref: refs/heads/feature\n").unwrap();
        let git_paths = git_events_until(&rx, &["main", "HEAD"]);
        assert!(git_paths.iter().all(|p| is_within(&repo.join(".git"), Path::new(p))));
        watcher.unwatch("app");
        assert_eq!(watcher.open_watches(), 0);
    }

    /// A linked worktree's sub-folder follows the worktree's own git dir and the common dir its branches live in.
    #[test]
    fn a_folder_below_a_linked_worktree_follows_its_git_dir_and_common_dir() {
        let dir = tempfile::tempdir().unwrap();
        let base = crate::pathguard::canonical(dir.path()).unwrap();
        let common = base.join("main/.git");
        let git_dir = common.join("worktrees/wt");
        std::fs::create_dir_all(&git_dir).unwrap();
        std::fs::write(git_dir.join("commondir"), "../..\n").unwrap();
        std::fs::create_dir_all(base.join("wt/app")).unwrap();
        std::fs::write(base.join("wt/.git"), format!("gitdir: {}\n", git_dir.display())).unwrap();
        assert_eq!(git_dirs_of(&base.join("wt/app")), git_dirs_of(&base.join("wt")));
        assert_eq!(git_dirs_of(&base.join("wt/app")), vec![common, git_dir]);
    }

    /// A folder at its repository's root keeps its own `.git` (inside the watch: no second OS watch), as before.
    #[test]
    fn a_root_level_folder_keeps_its_own_git_dir() {
        let dir = tempfile::tempdir().unwrap();
        let repo = crate::pathguard::canonical(dir.path()).unwrap();
        std::fs::create_dir_all(repo.join(".git/refs/heads")).unwrap();
        assert_eq!(git_dirs_of(&repo), vec![repo.join(".git")]);
        let (watcher, rx) = watcher();
        watcher.watch("root", &repo, true).unwrap();
        assert_eq!(watcher.open_watches(), 1);
        std::fs::write(repo.join(".git/HEAD"), "ref: refs/heads/feature\n").unwrap();
        git_events_until(&rx, &["HEAD"]);
        watcher.unwatch("root");
    }

    #[test]
    fn external_write_is_pushed_by_the_os_event() {
        let dir = tempfile::tempdir().unwrap();
        let root = crate::pathguard::canonical(dir.path()).unwrap();
        std::fs::write(root.join("a.txt"), "1").unwrap();
        let (watcher, rx) = watcher();
        watcher.watch("w", &root, false).unwrap();
        std::fs::write(root.join("a.txt"), "2").unwrap();
        let (_, paths, _) = rx.recv().unwrap();
        assert!(paths.iter().any(|p| p.ends_with("a.txt")));
    }
}
