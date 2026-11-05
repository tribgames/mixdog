//! Per-path mutual exclusion inside the core: the in-process half of Node's
//! `withBuiltinPathLocks` (`builtin/path-locks.mjs`). Locks are per exact path key: every
//! holder of one key runs one at a time, in arrival order, and several keys are taken in
//! sorted order so two callers never deadlock. A key does not cover the paths under it.
//!
//! In Node a mutating git call locks the work tree root and `edit`/`apply_patch` lock their
//! target files (`withEditTargetLock`, `withBuiltinPathLocks(lockPaths)`), so a git write and
//! an edit of a file under that folder do NOT wait for each other there, and do not here. Two
//! git writes in one folder, or two edits of one file, do. (The cross-process advisory lock
//! is not needed: one core owns the data directory.)

use std::collections::HashMap;
use std::path::Path;
use std::sync::Arc;
use std::sync::Mutex;

use mixdog_scm::locks::path_key;
use tokio::sync::OwnedSemaphorePermit;
use tokio::sync::Semaphore;
use tokio_util::sync::CancellationToken;

static LOCKS: Mutex<Option<HashMap<String, Arc<Semaphore>>>> = Mutex::new(None);

/// Holds the locks of its paths until dropped.
#[must_use = "the paths stay locked while the guard lives"]
pub struct PathLocks {
    held: Vec<Held>,
}

struct Held {
    key: String,
    semaphore: Arc<Semaphore>,
    permit: Option<OwnedSemaphorePermit>,
}

impl Drop for Held {
    fn drop(&mut self) {
        let mut map = LOCKS.lock().expect("path locks");
        drop(self.permit.take());
        // Waiters hold their own clone, taken under this same lock before they wait, so a
        // count of two (the map's and ours) means nobody is behind us.
        if Arc::strong_count(&self.semaphore) == 2
            && let Some(locks) = map.as_mut()
        {
            locks.remove(&self.key);
        }
    }
}

/// Number of paths with a holder or a waiter (tests).
pub fn path_lock_count() -> usize {
    LOCKS.lock().expect("path locks").as_ref().map_or(0, HashMap::len)
}

/// Waits for the lock of every path in `paths`; `None` when `cancel` fires first.
pub async fn lock_paths(paths: &[&Path], cancel: &CancellationToken) -> Option<PathLocks> {
    let mut keyed: Vec<String> = paths.iter().map(|p| path_key(p)).collect();
    keyed.sort();
    keyed.dedup();
    let mut held: Vec<Held> = Vec::new();
    for key in keyed {
        let semaphore = {
            let mut map = LOCKS.lock().expect("path locks");
            map.get_or_insert_with(HashMap::new)
                .entry(key.clone())
                .or_insert_with(|| Arc::new(Semaphore::new(1)))
                .clone()
        };
        // Pushed before the wait so a cancelled wait still releases its map entry.
        held.push(Held { key, semaphore: semaphore.clone(), permit: None });
        let permit = tokio::select! {
            permit = semaphore.acquire_owned() => permit.ok()?,
            () = cancel.cancelled() => return None,
        };
        if let Some(last) = held.last_mut() {
            last.permit = Some(permit);
        }
    }
    Some(PathLocks { held })
}

impl PathLocks {
    pub fn len(&self) -> usize {
        self.held.len()
    }

    pub fn is_empty(&self) -> bool {
        self.held.is_empty()
    }
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::AtomicUsize;
    use std::sync::atomic::Ordering;
    use std::time::Duration;

    use super::*;

    #[tokio::test]
    async fn one_path_runs_one_holder_at_a_time_in_arrival_order() {
        let cancel = CancellationToken::new();
        let first = lock_paths(&[Path::new("/r/a")], &cancel).await.unwrap();
        let order = Arc::new(Mutex::new(Vec::new()));
        let running = Arc::new(AtomicUsize::new(0));
        let mut tasks = Vec::new();
        for n in 0..3 {
            let (order, running, cancel) = (order.clone(), running.clone(), cancel.clone());
            tasks.push(tokio::spawn(async move {
                let _held = lock_paths(&[Path::new("/r/a")], &cancel).await.unwrap();
                assert_eq!(running.fetch_add(1, Ordering::SeqCst), 0);
                tokio::time::sleep(Duration::from_millis(5)).await;
                order.lock().unwrap().push(n);
                running.fetch_sub(1, Ordering::SeqCst);
            }));
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        // A different path is not blocked by the first holder.
        let other = lock_paths(&[Path::new("/r/b")], &cancel).await.unwrap();
        drop(other);
        drop(first);
        for task in tasks {
            task.await.unwrap();
        }
        assert_eq!(*order.lock().unwrap(), [0, 1, 2]);
    }

    #[tokio::test]
    async fn a_folder_lock_does_not_cover_file_locks_under_it_as_in_node() {
        let cancel = CancellationToken::new();
        // A git write holds the work tree; an edit locks its target file (and its real path).
        let git_write = lock_paths(&[Path::new("/r/work")], &cancel).await.unwrap();
        let edit = tokio::time::timeout(
            Duration::from_millis(200),
            lock_paths(&[Path::new("/r/work/src/a.rs"), Path::new("/r/work/src/a.rs")], &cancel),
        )
        .await
        .expect("an edit under the folder is not held up by the git write")
        .unwrap();
        assert_eq!(edit.len(), 1, "the target and its real path are one key");
        // The same key does wait: a second git write in the folder, and a second edit of the file.
        let second_git = tokio::time::timeout(Duration::from_millis(100), lock_paths(&[Path::new("/r/work")], &cancel)).await;
        assert!(second_git.is_err());
        let second_edit =
            tokio::time::timeout(Duration::from_millis(100), lock_paths(&[Path::new("/r/work/src/a.rs")], &cancel)).await;
        assert!(second_edit.is_err());
        // Spelling differences of one folder (separators, trailing slash) are one key.
        let alias = tokio::time::timeout(Duration::from_millis(100), lock_paths(&[Path::new("/r/work/")], &cancel)).await;
        assert!(alias.is_err());
        drop((git_write, edit));
    }

    #[tokio::test]
    async fn entries_are_dropped_once_unused_and_a_cancelled_wait_leaves_none() {
        let cancel = CancellationToken::new();
        let held = lock_paths(&[Path::new("/r/only-here"), Path::new("/r/only-here-too")], &cancel)
            .await
            .unwrap();
        assert_eq!(held.len(), 2);
        let waiting = CancellationToken::new();
        let stop = waiting.clone();
        let waiter = tokio::spawn(async move { lock_paths(&[Path::new("/r/only-here")], &stop).await.is_none() });
        tokio::time::sleep(Duration::from_millis(10)).await;
        waiting.cancel();
        assert!(waiter.await.unwrap());
        drop(held);
        let keys = LOCKS.lock().unwrap();
        assert!(keys.as_ref().is_none_or(|m| !m.contains_key(&path_key(Path::new("/r/only-here")))));
    }
}
