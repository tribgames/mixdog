//! Watch registry: consumers of one `(path, recursive)` share one OS watch
//! (DS §4.3). Reference-counted; the OS backend is attached by the caller.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

/// Fixed trailing batching window inside the watcher.
pub const BATCH_WINDOW_MS: u64 = 250;

type Key = (PathBuf, bool);

#[derive(Default)]
pub struct WatchRegistry {
    counts: HashMap<Key, usize>,
}

/// What the caller must do with the OS watch after a registry change.
#[derive(Debug, PartialEq, Eq)]
pub enum OsWatch {
    Open,
    Keep,
    Close,
}

impl WatchRegistry {
    pub fn add(&mut self, path: &Path, recursive: bool) -> OsWatch {
        let n = self.counts.entry((fold(path), recursive)).or_insert(0);
        *n += 1;
        if *n == 1 { OsWatch::Open } else { OsWatch::Keep }
    }

    pub fn remove(&mut self, path: &Path, recursive: bool) -> OsWatch {
        let key = (fold(path), recursive);
        match self.counts.get_mut(&key) {
            None => OsWatch::Keep,
            Some(n) if *n > 1 => {
                *n -= 1;
                OsWatch::Keep
            }
            Some(_) => {
                self.counts.remove(&key);
                OsWatch::Close
            }
        }
    }

    pub fn open_watches(&self) -> usize {
        self.counts.len()
    }
}

fn fold(path: &Path) -> PathBuf {
    if cfg!(windows) {
        PathBuf::from(path.to_string_lossy().to_lowercase())
    } else {
        path.to_path_buf()
    }
}

/// Events under a git dir's `objects/` are not delivered.
pub fn git_event_delivered(relative_to_git_dir: &Path) -> bool {
    relative_to_git_dir.components().next().is_none_or(|c| c.as_os_str() != "objects")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn two_consumers_share_one_os_watch() {
        let mut r = WatchRegistry::default();
        assert_eq!(r.add(Path::new("/p"), true), OsWatch::Open);
        assert_eq!(r.add(Path::new("/p"), true), OsWatch::Keep);
        assert_eq!(r.add(Path::new("/p"), false), OsWatch::Open);
        assert_eq!(r.remove(Path::new("/p"), true), OsWatch::Keep);
        assert_eq!(r.remove(Path::new("/p"), true), OsWatch::Close);
        assert_eq!(r.open_watches(), 1);
    }

    #[test]
    fn objects_skipped() {
        assert!(!git_event_delivered(Path::new("objects/ab/cd")));
        assert!(git_event_delivered(Path::new("refs/heads/x")));
    }
}
