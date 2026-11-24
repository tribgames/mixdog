//! Push-based skill and plugin change notification through the one workspace watcher
//! (`FolderWatcher`). The watcher's single sink receives every watch; this sink keeps only the
//! ones registered here and bumps a generation that subscribers await, so a change reloads the
//! skill list. Roots that could not be watched are collected on demand.

use std::collections::HashMap;
use std::collections::HashSet;
use std::path::Path;
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
    /// The watches of a folder kept only for some of its entries ([`WatchTargets::entries`]): the folder and those entries'
    /// names, in lower case. A change of another entry of the folder changes nothing (the data folder's log, written all the
    /// time); the folder's own removal or rename always counts.
    entries: Mutex<HashMap<String, (String, Vec<String>)>>,
}

fn lower(path: &Path) -> String {
    path.to_string_lossy().to_lowercase()
}

impl Sink {
    fn concerns(&self, watch_id: &str, paths: &[String], kind: ChangeKind) -> bool {
        let entries = self.entries.lock().unwrap_or_else(|e| e.into_inner());
        let Some((folder, names)) = entries.get(watch_id) else { return true };
        let another_entry = |path: &Path| match (path.parent(), path.file_name()) {
            (Some(parent), Some(name)) => lower(parent) == *folder && !names.contains(&name.to_string_lossy().to_lowercase()),
            _ => false,
        };
        matches!(kind, ChangeKind::Overflow) || paths.is_empty() || paths.iter().any(|path| !another_entry(Path::new(path)))
    }
}

impl ChangeSink for Sink {
    fn changed(&self, watch_id: &str, paths: Vec<String>, kind: ChangeKind) {
        if watch_id.starts_with(WATCH_PREFIX) && self.concerns(watch_id, &paths, kind) {
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
        Self { sink: Arc::new(Sink { generation, stale: Mutex::default(), entries: Mutex::default() }), watcher: Mutex::new(None), applied: Mutex::default() }
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
        let _ = self.set_targets(&WatchTargets { deep: roots.to_vec(), ..WatchTargets::default() });
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
        let all = targets.deep.iter().map(|p| (p.clone(), true)).chain(targets.shallow.iter().map(|p| (p.clone(), false)));
        let mut wanted: Vec<(PathBuf, bool)> = all.collect();
        // A folder watched whole is not narrowed to some of its entries.
        let mut narrowed: Vec<(PathBuf, Vec<String>)> = Vec::new();
        for entry in &targets.entries {
            let (Some(folder), Some(name)) = (entry.parent(), entry.file_name()) else { continue };
            if targets.shallow.iter().any(|p| p == folder) {
                continue;
            }
            let name = name.to_string_lossy().to_lowercase();
            match narrowed.iter_mut().find(|(p, _)| p == folder) {
                Some((_, names)) => names.push(name),
                None => {
                    narrowed.push((folder.to_path_buf(), vec![name]));
                    wanted.push((folder.to_path_buf(), false));
                }
            }
        }
        let mut kept: Vec<(String, PathBuf, bool)> = Vec::new();
        for (id, path, recursive) in std::mem::take(&mut applied.watches) {
            let still_wanted = wanted.iter().any(|(p, r)| *p == path && *r == recursive);
            if !stale.contains(&id) && still_wanted && !kept.iter().any(|(_, p, r)| *p == path && *r == recursive) {
                kept.push((id, path, recursive));
            } else {
                watcher.unwatch(&id);
            }
        }
        let mut complete = true;
        for (path, recursive) in wanted {
            if kept.iter().any(|(_, p, r)| *p == path && *r == recursive) {
                continue;
            }
            let id = format!("{WATCH_PREFIX}{}", applied.next);
            applied.next += 1;
            match watcher.watch(&id, &path, recursive) {
                Ok(()) => kept.push((id, path, recursive)),
                Err(error) => {
                    complete = false;
                    tracing::debug!(root = %path.display(), message = %error.message, "skills root not watched");
                }
            }
        }
        *self.sink.entries.lock().unwrap_or_else(|e| e.into_inner()) = kept
            .iter()
            .filter(|(_, _, recursive)| !recursive)
            .filter_map(|(id, path, _)| narrowed.iter().find(|(p, _)| p == path).map(|(_, names)| (id.clone(), (lower(path), names.clone()))))
            .collect();
        applied.watches = kept;
        // A watch that failed is tried again by the next call.
        applied.complete = complete.then(|| targets.clone());
        complete
    }
}

/// What the skill list depends on: directories watched with everything under them, directories
/// watched for their direct entries (a plugin root's manifests), and single entries watched through
/// their folder (a skills root's own place in its parent, the step toward a skills root that does not
/// exist yet in its nearest existing ancestor).
#[derive(Clone, Default, PartialEq, Eq, Debug)]
pub struct WatchTargets {
    pub deep: Vec<PathBuf>,
    pub shallow: Vec<PathBuf>,
    pub entries: Vec<PathBuf>,
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A data folder watched for its skills folder only, with that watch's id.
    fn narrowed() -> (tempfile::TempDir, PathBuf, SkillsWatch, String) {
        let dir = tempfile::tempdir().unwrap();
        let data = dir.path().canonicalize().unwrap();
        let skills = data.join("skills");
        std::fs::create_dir_all(&skills).unwrap();
        let watch = SkillsWatch::new();
        watch.attach(Arc::new(FolderWatcher::new(watch.sink()).unwrap()));
        assert!(watch.set_targets(&WatchTargets { deep: vec![skills.clone()], shallow: Vec::new(), entries: vec![skills] }));
        let folder = watch.applied.lock().unwrap().watches.iter().find(|(_, path, recursive)| *path == data && !recursive).map(|(id, _, _)| id.clone());
        (dir, data, watch, folder.expect("the data folder is watched"))
    }

    /// A folder watched for one entry of it (the data folder, for its skills folder) changes the skill list when that entry
    /// changes, and not when the folder's other files do (the log beside it, written all the time).
    #[test]
    fn a_folder_watched_for_an_entry_ignores_its_other_files() {
        let (_dir, data, watch, folder) = narrowed();
        let changes = watch.subscribe();
        let sink = watch.sink();
        sink.changed(&folder, vec![data.join("daemon.log").to_string_lossy().into_owned()], ChangeKind::Modified);
        assert_eq!(*changes.borrow(), 0);
        sink.changed(&folder, vec![data.join("skills").to_string_lossy().into_owned()], ChangeKind::Removed);
        assert_eq!(*changes.borrow(), 1);
    }

    /// The folder's own removal or rename, reported under the folder's own path, changes the skill list and has the folder
    /// watched again: its OS watch is gone with it.
    #[test]
    fn a_folder_watched_for_an_entry_hears_its_own_removal() {
        let (_dir, data, watch, folder) = narrowed();
        let changes = watch.subscribe();
        watch.sink().changed(&folder, vec![data.to_string_lossy().into_owned()], ChangeKind::Removed);
        assert_eq!(*changes.borrow(), 1);
        assert!(watch.sink.stale.lock().unwrap().contains(&folder));
    }
}
