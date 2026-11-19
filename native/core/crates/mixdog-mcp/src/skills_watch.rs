//! Push-based skill and plugin change notification through the one workspace watcher
//! (`FolderWatcher`). The watcher's single sink receives every watch; this sink keeps only the
//! ones registered here and bumps a generation that subscribers await, so a change reloads the
//! skill list. Roots that could not be watched are collected on demand.

use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::Mutex;

use mixdog_workspace::watcher::ChangeKind;
use mixdog_workspace::watcher::ChangeSink;
use mixdog_workspace::watcher::FolderWatcher;
use tokio::sync::watch;

const WATCH_PREFIX: &str = "mcp.skills:";

struct Sink {
    generation: watch::Sender<u64>,
    /// Watches whose OS watch may be lost: the next registration takes them again.
    stale: Mutex<HashSet<String>>,
}

impl ChangeSink for Sink {
    fn changed(&self, watch_id: &str, _paths: Vec<String>, kind: ChangeKind) {
        if watch_id.starts_with(WATCH_PREFIX) {
            // A directory replaced at the same path can lose its OS watch without changing the target list.
            if matches!(kind, ChangeKind::Removed | ChangeKind::Renamed | ChangeKind::Overflow) {
                self.stale.lock().unwrap_or_else(|e| e.into_inner()).insert(watch_id.to_owned());
            }
            self.generation.send_modify(|g| *g += 1);
        }
    }
}

/// The registration last made: the targets when it covered them all, and each watch that registered (id, path, recursive).
#[derive(Default)]
struct Applied {
    complete: Option<WatchTargets>,
    watches: Vec<(String, PathBuf, bool)>,
    /// The number of the next watch id: an id names one registration, never a position in the targets.
    next: u64,
}

pub struct SkillsWatch {
    sink: Arc<Sink>,
    watcher: Mutex<Option<Arc<FolderWatcher>>>,
    applied: Mutex<Applied>,
}

impl Default for SkillsWatch {
    fn default() -> Self {
        Self::new()
    }
}

impl SkillsWatch {
    pub fn new() -> Self {
        let (generation, _) = watch::channel(0);
        Self { sink: Arc::new(Sink { generation, stale: Mutex::default() }), watcher: Mutex::new(None), applied: Mutex::default() }
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

    /// Whether all targets are covered. An incomplete registration must not bless a cached scan. A watch that still matches its
    /// target and has not lost its OS watch is kept as it is.
    pub fn set_targets(&self, targets: &WatchTargets) -> bool {
        let Some(watcher) = self.watcher.lock().unwrap_or_else(|e| e.into_inner()).clone() else { return false };
        let mut applied = self.applied.lock().unwrap_or_else(|e| e.into_inner());
        let stale = std::mem::take(&mut *self.sink.stale.lock().unwrap_or_else(|e| e.into_inner()));
        if stale.is_empty() && applied.complete.as_ref() == Some(targets) {
            return true;
        }
        let all = targets.deep.iter().map(|p| (p, true)).chain(targets.shallow.iter().map(|p| (p, false)));
        let wanted: Vec<(&PathBuf, bool)> = all.collect();
        let mut kept: Vec<(String, PathBuf, bool)> = Vec::new();
        for (id, path, recursive) in std::mem::take(&mut applied.watches) {
            let still_wanted = wanted.iter().any(|(p, r)| **p == path && *r == recursive);
            if !stale.contains(&id) && still_wanted && !kept.iter().any(|(_, p, r)| *p == path && *r == recursive) {
                kept.push((id, path, recursive));
            } else {
                watcher.unwatch(&id);
            }
        }
        let mut complete = true;
        for (path, recursive) in wanted {
            if kept.iter().any(|(_, p, r)| p == path && *r == recursive) {
                continue;
            }
            let id = format!("{WATCH_PREFIX}{}", applied.next);
            applied.next += 1;
            match watcher.watch(&id, path, recursive) {
                Ok(()) => kept.push((id, path.clone(), recursive)),
                Err(error) => {
                    complete = false;
                    tracing::debug!(root = %path.display(), message = %error.message, "skills root not watched");
                }
            }
        }
        applied.watches = kept;
        // A watch that failed is tried again by the next call.
        applied.complete = complete.then(|| targets.clone());
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
