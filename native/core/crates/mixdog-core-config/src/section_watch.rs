//! Wakes a section producer when another process changes the files its value is read from.
//! Node reads these on every call (`listAgents` scans the agent folders, `listWorkflows` the
//! pack folders, the provider setup the account files), so a pushed value must follow them.
//!
//! The parents are watched one level deep, so a root that does not exist yet is noticed when it
//! is created and joins the watch then; each root that exists is watched recursively. A change
//! under a root, or of a named file directly in a parent, wakes the notifier. The producer
//! compares what it computes with what it last pushed, so a wake without a change pushes nothing.

use std::ffi::OsString;
use std::path::Path;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::OnceLock;
use std::sync::Weak;

use mixdog_workspace::error::WsError;
use mixdog_workspace::watcher::ChangeKind;
use mixdog_workspace::watcher::ChangeSink;
use mixdog_workspace::watcher::FolderWatcher;
use tokio::sync::Notify;

/// What to watch: `roots` (folders, recursively) and `files` (`(folder, file name)`, directly in
/// the folder). Every folder above them is watched one level deep.
#[derive(Clone, Debug, Default)]
pub struct Watched {
    pub roots: Vec<PathBuf>,
    pub files: Vec<(PathBuf, OsString)>,
}

struct Sink {
    id: &'static str,
    watched: Watched,
    notify: Arc<Notify>,
    watcher: OnceLock<Weak<FolderWatcher>>,
}

impl Sink {
    fn hit(&self, path: &Path) -> bool {
        self.watched.roots.iter().any(|root| path.starts_with(root))
            || self.watched.files.iter().any(|(dir, name)| path.parent() == Some(dir.as_path()) && path.file_name() == Some(name.as_os_str()))
    }
}

impl ChangeSink for Sink {
    fn changed(&self, _watch_id: &str, paths: Vec<String>, _kind: ChangeKind) {
        // A batch naming no path is a rescan: it may be any of them.
        if !paths.is_empty() && !paths.iter().any(|path| self.hit(Path::new(path))) {
            return;
        }
        if let Some(watcher) = self.watcher.get().and_then(Weak::upgrade) {
            for (index, root) in self.watched.roots.iter().enumerate() {
                if paths.iter().any(|path| Path::new(path) == root.as_path()) {
                    // The root was just created. A root that cannot be watched yet leaves the others
                    // working, and its next event retries.
                    let _ = watcher.watch(&format!("{}-root-{index}", self.id), root, true);
                }
            }
        }
        self.notify.notify_one();
    }
}

/// Keeps the watches alive; dropping it stops them.
pub struct FolderTrigger {
    _watcher: Arc<FolderWatcher>,
}

impl FolderTrigger {
    pub fn start(id: &'static str, watched: Watched, notify: Arc<Notify>) -> Result<Self, WsError> {
        let sink = Arc::new(Sink { id, watched: watched.clone(), notify, watcher: OnceLock::new() });
        let watcher = Arc::new(FolderWatcher::new(sink.clone())?);
        let _ = sink.watcher.set(Arc::downgrade(&watcher));
        let mut parents: Vec<&Path> = Vec::new();
        for path in watched.roots.iter().map(PathBuf::as_path).chain(watched.files.iter().map(|(dir, _)| dir.as_path())) {
            let parent = if watched.roots.iter().any(|root| root.as_path() == path) { path.parent() } else { Some(path) };
            if let Some(parent) = parent
                && !parents.contains(&parent)
            {
                parents.push(parent);
            }
        }
        for (index, parent) in parents.into_iter().enumerate() {
            watcher.watch(&format!("{id}-parent-{index}"), parent, false)?;
        }
        for (index, root) in watched.roots.iter().enumerate() {
            // A root that does not exist yet is picked up when its parent reports it.
            let _ = watcher.watch(&format!("{id}-root-{index}"), root, true);
        }
        Ok(Self { _watcher: watcher })
    }
}
