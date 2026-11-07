//! The write lock of one repository (keyed by its common dir): one fair FIFO queue per
//! repository and nothing shared between repositories. A write names the work trees it
//! touches; writes conflict only when those sets intersect, and a whole-repository write (a
//! managed worktree mutation, object pruning) conflicts with every write of that repository.
//! A waiting write is granted once it conflicts with no running write and no earlier waiting
//! write, so none starves and a later write that conflicts with nothing ahead of it runs at
//! once. Reads never take it.

use std::collections::HashMap;
use std::path::Path;
use std::sync::Arc;
use std::sync::Mutex;

use tokio::sync::oneshot;
use tokio_util::sync::CancellationToken;

use crate::error::ScmFailure;

/// Case-insensitive on Windows, separator-normalized: two spellings of one directory never
/// hold separate locks.
pub fn path_key(path: &Path) -> String {
    let text = path.to_string_lossy().replace('\\', "/");
    let text = text.trim_end_matches('/');
    if cfg!(windows) {
        text.to_lowercase()
    } else {
        text.to_owned()
    }
}

/// `None` is the whole repository.
type Scopes = Option<Vec<String>>;

fn conflicts(left: &Scopes, right: &Scopes) -> bool {
    match (left, right) {
        (Some(left), Some(right)) => left.iter().any(|scope| right.contains(scope)),
        _ => true,
    }
}

struct Entry {
    id: u64,
    scopes: Scopes,
    grant: Option<oneshot::Sender<()>>,
}

#[derive(Default)]
struct RepoState {
    running: Vec<(u64, Scopes)>,
    queue: Vec<Entry>,
    next_id: u64,
}

impl RepoState {
    fn drain(&mut self) {
        let mut waiting: Vec<Entry> = Vec::new();
        for mut entry in std::mem::take(&mut self.queue) {
            let blocked = self
                .running
                .iter()
                .any(|(_, scopes)| conflicts(scopes, &entry.scopes))
                || waiting.iter().any(|earlier| conflicts(&earlier.scopes, &entry.scopes));
            if blocked {
                waiting.push(entry);
            } else {
                self.running.push((entry.id, entry.scopes.clone()));
                if let Some(grant) = entry.grant.take() {
                    // A waiter that already left is released by its guard's drop.
                    let _ = grant.send(());
                }
            }
        }
        self.queue = waiting;
    }
}

#[derive(Default)]
pub struct RepoLocks {
    repos: Mutex<HashMap<String, RepoState>>,
}

impl RepoLocks {
    pub fn new() -> Arc<Self> {
        Arc::new(Self::default())
    }

    fn with<R>(&self, repo: &str, f: impl FnOnce(&mut RepoState) -> R) -> R {
        let mut repos = self.repos.lock().expect("repo locks");
        let state = repos.entry(repo.to_owned()).or_default();
        let out = f(state);
        if state.running.is_empty() && state.queue.is_empty() {
            repos.remove(repo);
        }
        out
    }

    /// Waits for the repository's write lock. `cancel` leaves the queue without ever holding it.
    pub async fn acquire(
        self: &Arc<Self>,
        common_dir: &Path,
        work_trees: Option<&[&Path]>,
        cancel: &CancellationToken,
    ) -> Result<RepoGuard, ScmFailure> {
        let repo = path_key(common_dir);
        let scopes: Scopes = work_trees
            .filter(|trees| !trees.is_empty())
            .map(|trees| trees.iter().map(|tree| path_key(tree)).collect());
        let (grant, granted) = oneshot::channel();
        let id = self.with(&repo, |state| {
            let id = state.next_id;
            state.next_id += 1;
            state.queue.push(Entry {
                id,
                scopes,
                grant: Some(grant),
            });
            state.drain();
            id
        });
        // The guard exists before the wait: dropping it (on cancel or on a dropped future)
        // takes the entry out of the queue or releases it if it was already granted.
        let guard = RepoGuard {
            locks: self.clone(),
            repo,
            id,
        };
        tokio::select! {
            _ = granted => Ok(guard),
            _ = cancel.cancelled() => Err(ScmFailure::Cancelled),
        }
    }
}

#[must_use = "the repository stays locked while the guard lives"]
pub struct RepoGuard {
    locks: Arc<RepoLocks>,
    repo: String,
    id: u64,
}

impl Drop for RepoGuard {
    fn drop(&mut self) {
        let id = self.id;
        self.locks.with(&self.repo, |state| {
            state.queue.retain(|entry| entry.id != id);
            state.running.retain(|(running, _)| *running != id);
            state.drain();
        });
    }
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use super::*;

    #[tokio::test(start_paused = true)]
    async fn disjoint_work_trees_run_together_and_whole_repo_waits() {
        let locks = RepoLocks::new();
        let cancel = CancellationToken::new();
        let repo = Path::new("/r/.git");
        let a = locks.acquire(repo, Some(&[Path::new("/r/a")]), &cancel).await.unwrap();
        let b = locks.acquire(repo, Some(&[Path::new("/r/b")]), &cancel).await.unwrap();
        let whole = {
            let locks = locks.clone();
            let cancel = cancel.clone();
            tokio::spawn(async move { locks.acquire(Path::new("/r/.git"), None, &cancel).await })
        };
        tokio::time::sleep(Duration::from_millis(20)).await;
        assert!(!whole.is_finished(), "a whole-repository write waits for both");
        drop(a);
        tokio::time::sleep(Duration::from_millis(20)).await;
        assert!(!whole.is_finished());
        drop(b);
        assert!(whole.await.unwrap().is_ok());
    }

    #[tokio::test(start_paused = true)]
    async fn a_later_write_never_overtakes_a_conflicting_earlier_one() {
        let locks = RepoLocks::new();
        let cancel = CancellationToken::new();
        let repo = Path::new("/r/.git");
        let first = locks.acquire(repo, Some(&[Path::new("/r/a")]), &cancel).await.unwrap();
        let whole = {
            let locks = locks.clone();
            let cancel = cancel.clone();
            tokio::spawn(async move { locks.acquire(Path::new("/r/.git"), None, &cancel).await })
        };
        tokio::time::sleep(Duration::from_millis(20)).await;
        // Conflicts with nothing running, but the whole-repo write ahead of it does conflict.
        let later = {
            let locks = locks.clone();
            let cancel = cancel.clone();
            tokio::spawn(async move {
                locks
                    .acquire(Path::new("/r/.git"), Some(&[Path::new("/r/b")]), &cancel)
                    .await
            })
        };
        tokio::time::sleep(Duration::from_millis(20)).await;
        assert!(!later.is_finished());
        drop(first);
        let whole = whole.await.unwrap().unwrap();
        assert!(!later.is_finished());
        drop(whole);
        assert!(later.await.unwrap().is_ok());
    }

    #[tokio::test(start_paused = true)]
    async fn repositories_do_not_wait_on_each_other() {
        let locks = RepoLocks::new();
        let cancel = CancellationToken::new();
        let _held = locks.acquire(Path::new("/one/.git"), None, &cancel).await.unwrap();
        let other = tokio::time::timeout(
            Duration::from_millis(200),
            locks.acquire(Path::new("/two/.git"), None, &cancel),
        )
        .await;
        assert!(other.is_ok());
    }

    #[tokio::test(start_paused = true)]
    async fn a_cancelled_waiter_leaves_the_queue() {
        let locks = RepoLocks::new();
        let cancel = CancellationToken::new();
        let repo = Path::new("/r/.git");
        let held = locks.acquire(repo, None, &cancel).await.unwrap();
        let waiter_cancel = CancellationToken::new();
        let waiter = {
            let locks = locks.clone();
            let token = waiter_cancel.clone();
            tokio::spawn(async move { locks.acquire(Path::new("/r/.git"), None, &token).await })
        };
        tokio::time::sleep(Duration::from_millis(20)).await;
        waiter_cancel.cancel();
        assert_eq!(waiter.await.unwrap().err(), Some(ScmFailure::Cancelled));
        drop(held);
        assert!(locks.acquire(repo, None, &cancel).await.is_ok());
    }
}
