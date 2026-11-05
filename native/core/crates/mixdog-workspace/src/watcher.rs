//! The one OS watcher (DS §4.3): a single `notify` backend for the whole core,
//! every consumer attached by reference. Changes are pushed; nothing polls.
//! Events of a watch are collected for a fixed trailing 250 ms window and pushed
//! as one `fs/changed` per kind. A recursive watch of a checkout also follows
//! its git dirs (a linked worktree keeps them outside the folder), skipping the
//! object store; those events carry kind `git`.

use std::collections::BTreeSet;
use std::collections::HashMap;
use std::path::Path;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::Mutex;
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

/// Receives each pushed batch. Called on the watcher's worker thread; it must not block.
pub trait ChangeSink: Send + Sync + 'static {
    fn changed(&self, watch_id: &str, paths: Vec<String>, kind: ChangeKind);
}

enum Message {
    Event(notify::Result<notify::Event>),
    Stop,
}

struct Sub {
    path: PathBuf,
    recursive: bool,
    git_dirs: Vec<PathBuf>,
}

#[derive(Default)]
struct OsPath {
    recursive_refs: usize,
    direct_refs: usize,
}

struct State {
    watcher: Option<RecommendedWatcher>,
    subs: HashMap<String, Sub>,
    os: HashMap<PathBuf, OsPath>,
    registry: crate::watch::WatchRegistry,
}

pub struct FolderWatcher {
    state: Arc<Mutex<State>>,
    stop: Sender<Message>,
}

/// The git dir and common dir of a checkout folder: `.git` itself, or the
/// targets a linked worktree's `.git` file names.
#[allow(clippy::disallowed_methods, reason = "two tiny reads, called only inside the lane job that registers a watch")]
pub fn git_dirs_of(dir: &Path) -> Vec<PathBuf> {
    let dot_git = dir.join(".git");
    let mut dirs = Vec::new();
    if dot_git.is_dir() {
        dirs.push(dot_git);
    } else if let Ok(text) = std::fs::read_to_string(&dot_git) {
        if let Some(target) = text.trim().strip_prefix("gitdir:") {
            let git_dir = dir.join(target.trim());
            if let Ok(common) = std::fs::read_to_string(git_dir.join("commondir")) {
                dirs.push(crate::pathguard::lexical(&git_dir.join(common.trim())));
            }
            dirs.push(crate::pathguard::lexical(&git_dir));
        }
    }
    dirs.retain(|d| d.is_dir());
    dirs.dedup();
    dirs
}

fn classify(kind: &EventKind) -> ChangeKind {
    match kind {
        EventKind::Remove(_) => ChangeKind::Removed,
        EventKind::Modify(ModifyKind::Name(_)) => ChangeKind::Renamed,
        _ => ChangeKind::Modified,
    }
}

impl State {
    fn apply(&mut self, path: &Path) -> WsResult<()> {
        let key = comparable(path);
        let Some(entry) = self.os.get(&key) else {
            if let Some(w) = self.watcher.as_mut() {
                let _ = w.unwatch(path);
            }
            return Ok(());
        };
        let mode = if entry.recursive_refs > 0 { RecursiveMode::Recursive } else { RecursiveMode::NonRecursive };
        let Some(w) = self.watcher.as_mut() else { return Ok(()) };
        let _ = w.unwatch(path);
        w.watch(path, mode).map_err(|e| WsError::new(Reason::Io, format!("Cannot watch {}: {e}", path.display())))
    }

    fn add_os(&mut self, path: &Path, recursive: bool) -> WsResult<()> {
        let entry = self.os.entry(comparable(path)).or_default();
        let before = (entry.recursive_refs > 0, entry.direct_refs + entry.recursive_refs > 0);
        if recursive { entry.recursive_refs += 1 } else { entry.direct_refs += 1 }
        let after = (entry.recursive_refs > 0, true);
        if before != after {
            if let Err(error) = self.apply(path) {
                self.remove_os(path, recursive);
                return Err(error);
            }
        }
        Ok(())
    }

    fn remove_os(&mut self, path: &Path, recursive: bool) {
        let key = comparable(path);
        let Some(entry) = self.os.get_mut(&key) else { return };
        let was_recursive = entry.recursive_refs > 0;
        if recursive { entry.recursive_refs = entry.recursive_refs.saturating_sub(1) } else { entry.direct_refs = entry.direct_refs.saturating_sub(1) }
        let empty = entry.recursive_refs + entry.direct_refs == 0;
        let still_recursive = entry.recursive_refs > 0;
        if empty {
            self.os.remove(&key);
        }
        if empty || was_recursive != still_recursive {
            let _ = self.apply(path);
        }
    }
}

impl FolderWatcher {
    pub fn new(sink: Arc<dyn ChangeSink>) -> WsResult<Self> {
        let (tx, rx) = unbounded::<Message>();
        let callback_tx = tx.clone();
        let watcher = notify::recommended_watcher(move |event| {
            let _ = callback_tx.send(Message::Event(event));
        })
        .map_err(|e| WsError::new(Reason::Io, format!("Cannot start the file watcher: {e}")))?;
        let state = Arc::new(Mutex::new(State {
            watcher: Some(watcher),
            subs: HashMap::new(),
            os: HashMap::new(),
            registry: crate::watch::WatchRegistry::default(),
        }));
        let worker_state = state.clone();
        std::thread::Builder::new()
            .name("mixdog-fs-watcher".into())
            .spawn(move || run(rx, worker_state, sink))
            .map_err(|e| WsError::new(Reason::Io, e.to_string()))?;
        Ok(Self { state, stop: tx })
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, State> {
        self.state.lock().expect("watcher state")
    }

    /// Attaches `id` to `path`. Consumers of one `(path, recursive)` share one OS watch.
    pub fn watch(&self, id: &str, path: &Path, recursive: bool) -> WsResult<()> {
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
        state.subs.insert(id.to_owned(), Sub { path: path.to_path_buf(), recursive, git_dirs });
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

    /// Live OS watches (shared ones counted once).
    pub fn open_watches(&self) -> usize {
        self.lock().os.len()
    }
}

impl Drop for FolderWatcher {
    fn drop(&mut self) {
        let _ = self.stop.send(Message::Stop);
        self.lock().watcher = None;
    }
}

type Pending = HashMap<(String, ChangeKind), BTreeSet<String>>;

fn route(state: &State, event: &notify::Event, pending: &mut Pending) {
    let overflow = event.need_rescan();
    let base_kind = classify(&event.kind);
    if matches!(event.kind, EventKind::Access(_)) && !overflow {
        return;
    }
    for path in &event.paths {
        for (id, sub) in &state.subs {
            let in_git = sub.git_dirs.iter().find(|g| is_within(g, path));
            let kind = if let Some(git) = in_git {
                let relative = path.strip_prefix(git).unwrap_or(Path::new(""));
                if !git_event_delivered(relative) {
                    continue;
                }
                ChangeKind::Git
            } else if is_within(&sub.path, path)
                && (sub.recursive || path.parent().is_some_and(|p| comparable(p) == comparable(&sub.path)) || comparable(path) == comparable(&sub.path))
            {
                if overflow { ChangeKind::Overflow } else { base_kind }
            } else {
                continue;
            };
            pending.entry((id.clone(), kind)).or_default().insert(path.to_string_lossy().into_owned());
        }
    }
}

fn run(rx: Receiver<Message>, state: Arc<Mutex<State>>, sink: Arc<dyn ChangeSink>) {
    let window = Duration::from_millis(BATCH_WINDOW_MS);
    let mut pending: Pending = HashMap::new();
    let mut flush_at: Option<Instant> = None;
    loop {
        let message = match flush_at {
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
        match message {
            Some(Message::Stop) => return,
            Some(Message::Event(Ok(event))) => {
                let before = pending.len();
                route(&state.lock().expect("watcher state"), &event, &mut pending);
                if flush_at.is_none() && (pending.len() > before || !pending.is_empty()) {
                    flush_at = Some(Instant::now() + window);
                }
            }
            Some(Message::Event(Err(_))) => {
                // The backend lost events: every watch re-reads.
                let state = state.lock().expect("watcher state");
                for id in state.subs.keys() {
                    pending.entry((id.clone(), ChangeKind::Overflow)).or_default();
                }
                flush_at.get_or_insert(Instant::now() + window);
            }
            None => {
                flush_at = None;
                let mut batch: Vec<_> = pending.drain().collect();
                batch.sort_by(|a, b| a.0.cmp(&b.0));
                for ((id, kind), paths) in batch {
                    sink.changed(&id, paths.into_iter().collect(), kind);
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
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
        for i in 0..200 {
            std::fs::write(root.join(format!("f{i}.txt")), "x").unwrap();
        }
        std::thread::sleep(Duration::from_millis(900));
        let mut notifications = 0;
        let mut seen = BTreeSet::new();
        while let Ok((id, paths, _)) = rx.try_recv() {
            if id == "w1" {
                notifications += 1;
                seen.extend(paths);
            }
        }
        assert!(notifications >= 1 && notifications <= 5, "{notifications}");
        assert_eq!(seen.iter().filter(|p| p.ends_with(".txt")).count(), 200);
        watcher.unwatch("w1");
        watcher.unwatch("w2");
        assert_eq!(watcher.open_watches(), 0);
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
        std::thread::sleep(Duration::from_millis(700));
        let mut git_paths = Vec::new();
        while let Ok((_, paths, kind)) = rx.try_recv() {
            if kind == ChangeKind::Git {
                git_paths.extend(paths);
            }
        }
        assert!(git_paths.iter().any(|p| p.ends_with("index")));
        assert!(!git_paths.iter().any(|p| p.contains("objects")));
    }

    #[test]
    fn external_write_is_pushed_within_the_window() {
        let dir = tempfile::tempdir().unwrap();
        let root = crate::pathguard::canonical(dir.path()).unwrap();
        std::fs::write(root.join("a.txt"), "1").unwrap();
        let (watcher, rx) = watcher();
        watcher.watch("w", &root, false).unwrap();
        let started = Instant::now();
        std::fs::write(root.join("a.txt"), "2").unwrap();
        let (_, paths, _) = rx.recv_timeout(Duration::from_millis(1500)).unwrap();
        assert!(started.elapsed() < Duration::from_millis(400), "{:?}", started.elapsed());
        assert!(paths.iter().any(|p| p.ends_with("a.txt")));
    }
}
