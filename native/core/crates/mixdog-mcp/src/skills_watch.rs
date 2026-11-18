//! Push-based skill and plugin change notification through the one workspace watcher
//! (`FolderWatcher`). The watcher's single sink receives every watch; this sink keeps only the
//! ones registered here and bumps a generation that subscribers await, so a change reloads the
//! skill list. Roots that could not be watched are collected on demand.

use std::path::PathBuf;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::atomic::{AtomicU64, Ordering};

use mixdog_workspace::watcher::ChangeKind;
use mixdog_workspace::watcher::ChangeSink;
use mixdog_workspace::watcher::FolderWatcher;
use tokio::sync::watch;

const WATCH_PREFIX: &str = "mcp.skills:";

struct Sink {
    generation: watch::Sender<u64>,
    registration: AtomicU64,
}

impl ChangeSink for Sink {
    fn changed(&self, watch_id: &str, _paths: Vec<String>, kind: ChangeKind) {
        if watch_id.starts_with(WATCH_PREFIX) {
            // A directory replaced at the same path can lose its OS watch without changing the target list.
            if matches!(kind, ChangeKind::Removed | ChangeKind::Renamed | ChangeKind::Overflow) {
                self.registration.fetch_add(1, Ordering::Relaxed);
            }
            self.generation.send_modify(|g| *g += 1);
        }
    }
}

pub struct SkillsWatch {
    sink: Arc<Sink>,
    watcher: Mutex<Option<Arc<FolderWatcher>>>,
    /// The targets last registered in full, and the watch ids that registered.
    ids: Mutex<(Option<(WatchTargets, u64)>, Vec<String>)>,
}

impl Default for SkillsWatch {
    fn default() -> Self {
        Self::new()
    }
}

impl SkillsWatch {
    pub fn new() -> Self {
        let (generation, _) = watch::channel(0);
        Self { sink: Arc::new(Sink { generation, registration: AtomicU64::new(0) }), watcher: Mutex::new(None), ids: Mutex::new((None, Vec::new())) }
    }

    /// The sink the workspace watcher must be built with (compose it with its other sinks).
    pub fn sink(&self) -> Arc<dyn ChangeSink> {
        self.sink.clone()
    }

    /// Binds the workspace watcher the roots are registered on.
    pub fn attach(&self, watcher: Arc<FolderWatcher>) {
        *self.watcher.lock().unwrap_or_else(|e| e.into_inner()) = Some(watcher);
    }

    /// The generation changes whenever a watched skill or plugin directory changes.
    pub fn subscribe(&self) -> watch::Receiver<u64> {
        self.sink.generation.subscribe()
    }

    /// Replaces the watched directories; ones that do not exist yet are skipped (the caller
    /// resolves a missing root to its nearest existing ancestor: [`set_targets`](Self::set_targets)).
    pub fn set_roots(&self, roots: &[PathBuf]) {
        let _ = self.set_targets(&WatchTargets { deep: roots.to_vec(), shallow: Vec::new() });
    }

    /// Whether all targets are covered. An incomplete registration must not bless a cached scan.
    pub fn set_targets(&self, targets: &WatchTargets) -> bool {
        let Some(watcher) = self.watcher.lock().unwrap_or_else(|e| e.into_inner()).clone() else { return false };
        let mut applied = self.ids.lock().unwrap_or_else(|e| e.into_inner());
        let registration = self.sink.registration.load(Ordering::Relaxed);
        if applied.0.as_ref().is_some_and(|(old, revision)| old == targets && *revision == registration) {
            return true;
        }
        for id in applied.1.drain(..) {
            watcher.unwatch(&id);
        }
        let mut complete = true;
        let all = targets.deep.iter().map(|p| (p, true)).chain(targets.shallow.iter().map(|p| (p, false)));
        for (index, (path, recursive)) in all.enumerate() {
            let id = format!("{WATCH_PREFIX}{index}");
            match watcher.watch(&id, path, recursive) {
                Ok(()) => applied.1.push(id),
                Err(error) => {
                    complete = false;
                    tracing::debug!(root = %path.display(), message = %error.message, "skills root not watched");
                }
            }
        }
        // A watch that failed is tried again by the next call.
        applied.0 = complete.then(|| (targets.clone(), registration));
        complete
    }
}

/// What the skill list depends on: directories watched with everything under them, and directories
/// watched for their direct entries only (a plugin root's manifests, the nearest existing ancestor
/// of a skills root that does not exist yet).
#[derive(Clone, Default, PartialEq, Eq, Debug)]
pub struct WatchTargets {
    pub deep: Vec<PathBuf>,
    pub shallow: Vec<PathBuf>,
}
