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
    // `pathKey`: `.` and `..` fold and a relative spelling is the one under the working directory.
    let resolved = mixdog_js::nodepath::resolve_host(&[&path.to_string_lossy()]);
    let text = resolved.replace('\\', "/");
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
        mixdog_rt::time::sleep(Duration::from_millis(20)).await;
        assert!(!whole.is_finished(), "a whole-repository write waits for both");
        drop(a);
        mixdog_rt::time::sleep(Duration::from_millis(20)).await;
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
        mixdog_rt::time::sleep(Duration::from_millis(20)).await;
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
        mixdog_rt::time::sleep(Duration::from_millis(20)).await;
        assert!(!later.is_finished());
        drop(first);
        let whole = whole.await.unwrap().unwrap();
        assert!(!later.is_finished());
        drop(whole);
        assert!(later.await.unwrap().is_ok());
    }

    /// Node's keys of the spellings of one directory (`gitRepoLockKey`), recorded on Windows, where the keys fold case.
    #[cfg(windows)]
    #[test]
    fn spellings_of_one_directory_share_a_key_as_in_node() {
        let doc: serde_json::Value = serde_json::from_str(mixdog_testkit::fixture!("../../fixtures/tools-untested/scm-locks.json")).unwrap();
        assert_eq!(doc["platform"], "win32");
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join("Repo").join(".git").join("x")).unwrap();
        let root = dir.path().to_string_lossy().into_owned();
        let root_key = path_key(dir.path());
        // The recorded key spells the checkout's root `<ROOT>` and separates with `\`; the core's key separates with `/`.
        let mut failures = Vec::new();
        for case in doc["keys"].as_array().unwrap() {
            let spelling = case["spelling"].as_str().unwrap();
            let got = path_key(Path::new(&spelling.replace("<ROOT>", &root))).replacen(&root_key, "<ROOT>", 1);
            let want = case["key"].as_str().unwrap().replace('\\', "/");
            if got != want {
                failures.push(format!("{spelling}: Node key {want:?}, here {got:?}"));
            }
        }
        assert!(failures.is_empty(), "{}", failures.join("\n"));
    }

    /// Node's scenarios (`git-repo-rw-lock.test.mjs`): each step is made in the recorded order; a held write's start and end
    /// and a quick write's run are events, and the events at each snapshot and at the end must be Node's.
    #[cfg(windows)]
    #[tokio::test]
    async fn writes_are_granted_in_the_order_node_grants_them() {
        use futures::FutureExt as _;
        use std::future::Future;
        use std::pin::Pin;

        type Acquire = Pin<Box<dyn Future<Output = Result<RepoGuard, ScmFailure>>>>;
        enum State {
            Pending(Acquire),
            Held(RepoGuard),
            Done,
        }
        struct Task {
            hold: bool,
            cancel: CancellationToken,
            state: State,
        }

        fn poll_once(name: &str, task: &mut Task, events: &mut Vec<String>, rejected: &mut Vec<String>) {
            let State::Pending(acquire) = &mut task.state else { return };
            match acquire.now_or_never() {
                None => {}
                Some(Ok(guard)) if task.hold => {
                    events.push(format!("{name}:start"));
                    task.state = State::Held(guard);
                }
                Some(Ok(_)) => {
                    events.push(name.to_owned());
                    task.state = State::Done;
                }
                Some(Err(failure)) => {
                    assert_eq!(failure, ScmFailure::Cancelled);
                    rejected.push(format!("{name}: AbortError"));
                    task.state = State::Done;
                }
            }
        }

        let doc: serde_json::Value = serde_json::from_str(mixdog_testkit::fixture!("../../fixtures/tools-untested/scm-locks.json")).unwrap();
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir(dir.path().join("Worktree")).unwrap();
        let root = dir.path().to_string_lossy().into_owned();
        let place = |text: &str| text.replace("<ROOT>", &root);
        let mut failures = Vec::new();
        for scenario in doc["scenarios"].as_array().unwrap() {
            let locks = RepoLocks::new();
            let mut tasks: Vec<(String, Task)> = Vec::new();
            let (mut events, mut rejected, mut snapshots) = (Vec::new(), Vec::new(), Vec::new());
            for op in scenario["ops"].as_array().unwrap() {
                let name = op["name"].as_str().unwrap_or("").to_owned();
                match op["op"].as_str().unwrap() {
                    "run" => {
                        let repo = std::path::PathBuf::from(place(op["repo"].as_str().unwrap()));
                        let scopes: Option<Vec<std::path::PathBuf>> = op["scopes"].as_array().map(|list| list.iter().map(|s| std::path::PathBuf::from(place(s.as_str().unwrap()))).collect());
                        let cancel = CancellationToken::new();
                        let acquire: Acquire = Box::pin({
                            let (locks, cancel) = (locks.clone(), cancel.clone());
                            async move {
                                let trees: Option<Vec<&Path>> = scopes.as_ref().map(|list| list.iter().map(std::path::PathBuf::as_path).collect());
                                locks.acquire(&repo, trees.as_deref(), &cancel).await
                            }
                        });
                        let mut task = Task { hold: op["hold"] == true, cancel, state: State::Pending(acquire) };
                        poll_once(&name, &mut task, &mut events, &mut rejected);
                        tasks.push((name, task));
                    }
                    "settle" => {
                        for (name, task) in &mut tasks {
                            poll_once(name, task, &mut events, &mut rejected);
                        }
                    }
                    "snapshot" => snapshots.push(events.clone()),
                    "release" => {
                        let (_, task) = tasks.iter_mut().find(|(n, _)| *n == name).unwrap();
                        assert!(matches!(task.state, State::Held(_)), "{}: release of {name}, which holds nothing", scenario["name"]);
                        events.push(format!("{name}:end"));
                        task.state = State::Done;
                    }
                    "abort" => {
                        let (_, task) = tasks.iter_mut().find(|(n, _)| *n == name).unwrap();
                        task.cancel.cancel();
                        for (name, task) in &mut tasks {
                            poll_once(name, task, &mut events, &mut rejected);
                        }
                    }
                    "await" => {
                        let (_, task) = tasks.iter_mut().find(|(n, _)| *n == name).unwrap();
                        poll_once(&name, task, &mut events, &mut rejected);
                        assert!(matches!(task.state, State::Done), "{}: {name} is still waiting where Node's await ended", scenario["name"]);
                    }
                    other => panic!("unknown step {other}"),
                }
            }
            let want_snapshots: Vec<Vec<String>> = scenario["snapshots"].as_array().unwrap().iter().map(|s| s.as_array().unwrap().iter().map(|e| e.as_str().unwrap().to_owned()).collect()).collect();
            let want_events: Vec<String> = scenario["events"].as_array().unwrap().iter().map(|e| e.as_str().unwrap().to_owned()).collect();
            let want_rejected: Vec<String> = scenario["rejected"].as_array().unwrap().iter().map(|e| e.as_str().unwrap().to_owned()).collect();
            if snapshots != want_snapshots || events != want_events || rejected != want_rejected {
                failures.push(format!("{}:\n  Node {:?} {:?} {:?}\n  here {snapshots:?} {events:?} {rejected:?}", scenario["name"], want_snapshots, want_events, want_rejected));
            }
        }
        assert!(failures.is_empty(), "{}", failures.join("\n"));
    }

    #[tokio::test(start_paused = true)]
    async fn repositories_do_not_wait_on_each_other() {
        let locks = RepoLocks::new();
        let cancel = CancellationToken::new();
        let _held = locks.acquire(Path::new("/one/.git"), None, &cancel).await.unwrap();
        let other = mixdog_rt::time::timeout(
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
        mixdog_rt::time::sleep(Duration::from_millis(20)).await;
        waiter_cancel.cancel();
        assert_eq!(waiter.await.unwrap().err(), Some(ScmFailure::Cancelled));
        drop(held);
        assert!(locks.acquire(repo, None, &cancel).await.is_ok());
    }
}
