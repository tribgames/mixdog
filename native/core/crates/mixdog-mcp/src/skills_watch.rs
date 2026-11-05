//! Push-based skill and plugin change notification through the one workspace watcher
//! (`FolderWatcher`). The watcher's single sink receives every watch; this sink keeps only the
//! ones registered here and bumps a generation that subscribers await, so a change reloads the
//! skill list without any polling.

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
}

impl ChangeSink for Sink {
    fn changed(&self, watch_id: &str, _paths: Vec<String>, _kind: ChangeKind) {
        if watch_id.starts_with(WATCH_PREFIX) {
            self.generation.send_modify(|g| *g += 1);
        }
    }
}

pub struct SkillsWatch {
    sink: Arc<Sink>,
    watcher: Mutex<Option<Arc<FolderWatcher>>>,
    ids: Mutex<Vec<String>>,
}

impl Default for SkillsWatch {
    fn default() -> Self {
        Self::new()
    }
}

impl SkillsWatch {
    pub fn new() -> Self {
        let (generation, _) = watch::channel(0);
        Self { sink: Arc::new(Sink { generation }), watcher: Mutex::new(None), ids: Mutex::new(Vec::new()) }
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

    /// Replaces the watched directories; ones that do not exist yet are skipped (their parent
    /// plugin or skills root being created is seen through the roots that do exist).
    pub fn set_roots(&self, roots: &[PathBuf]) {
        let Some(watcher) = self.watcher.lock().unwrap_or_else(|e| e.into_inner()).clone() else { return };
        let mut ids = self.ids.lock().unwrap_or_else(|e| e.into_inner());
        for id in ids.drain(..) {
            watcher.unwatch(&id);
        }
        for (index, root) in roots.iter().enumerate() {
            let id = format!("{WATCH_PREFIX}{index}");
            match watcher.watch(&id, root, true) {
                Ok(()) => ids.push(id),
                Err(error) => tracing::debug!(root = %root.display(), message = %error.message, "skills root not watched"),
            }
        }
    }
}
