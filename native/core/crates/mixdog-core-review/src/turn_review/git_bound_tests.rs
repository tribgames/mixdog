//! A wedged git child cannot hang the review: every command runs under the limit Node gives it
//! (`turn-worktree-snapshot.mjs` `COMMAND_TIMEOUT_MS`, `run-child.mjs` ETIMEDOUT), whatever the
//! turn's cancel does, and a capture that times out releases the worktree lock. Every expectation
//! is read from Node's recording (`fixtures/turn-git-bounds/bounds.json`).

use std::sync::Arc;
use std::sync::Mutex;
use std::sync::atomic::AtomicBool;
use std::sync::atomic::Ordering;
use std::time::Duration;

use async_trait::async_trait;
use mixdog_core_api::domain::common::EventSource;
use mixdog_core_api::domain::process::CommandSpec;
use mixdog_core_api::domain::process::ExitStatus;
use mixdog_core_api::domain::process::KillReason;
use mixdog_core_api::domain::process::ProcessError;
use mixdog_core_api::domain::process::ProcessEvent;
use mixdog_core_api::domain::process::ProcessExit;
use mixdog_core_api::domain::process::ProcessInfo;
use mixdog_core_api::domain::process::ProcessManager;
use mixdog_core_api::domain::process::PtySize;
use mixdog_core_api::domain::process::SpawnRequest;
use mixdog_core_api::domain::process::SpawnedProcess;
use mixdog_protocol::ProcessHandle;

use super::ports::GitOptions;
use super::ports::ReviewDisk;
use super::ports::ReviewGit;
use super::ports::ReviewWorktrees;
use super::scm_ports::ScmGit;
use super::scm_ports::ScmWorktrees;
use super::shadow::ShadowRepos;

/// What the real process manager does with a child it kills at its run limit: the exit, with the
/// time limit as its reason, once the limit has passed.
struct HeldUntilLimit {
    limit: Option<Duration>,
}

#[async_trait]
impl EventSource<ProcessEvent> for HeldUntilLimit {
    async fn next(&mut self) -> Option<ProcessEvent> {
        match self.limit {
            Some(limit) => {
                tokio::time::sleep(limit).await;
                self.limit = None;
                Some(ProcessEvent::Exited { seq: 0, exit: ProcessExit { status: ExitStatus::Signal(9), killed: Some(KillReason::TimeLimit) } })
            }
            None => std::future::pending().await,
        }
    }
}

/// A process manager whose git children never exit on their own: only the spawn's run limit ends
/// them, as the real manager does.
struct Wedged {
    limits: Mutex<Vec<Option<Duration>>>,
    pending: Mutex<Vec<(ProcessHandle, Option<Duration>)>>,
}

#[async_trait]
impl ProcessManager for Wedged {
    async fn spawn(&self, request: SpawnRequest) -> Result<SpawnedProcess, ProcessError> {
        self.limits.lock().unwrap().push(request.time_limit);
        self.pending.lock().unwrap().push((request.handle.clone(), request.time_limit));
        Ok(SpawnedProcess { handle: request.handle, pid: 1 })
    }

    fn subscribe(&self, handle: &ProcessHandle, _: Option<u64>) -> Result<Box<dyn EventSource<ProcessEvent>>, ProcessError> {
        let limit = self.pending.lock().unwrap().iter().find(|(h, _)| h == handle).map(|(_, limit)| *limit).ok_or(ProcessError::UnknownHandle)?;
        Ok(Box::new(HeldUntilLimit { limit }))
    }

    async fn write_stdin(&self, _: &ProcessHandle, _: Vec<u8>) -> Result<(), ProcessError> {
        Ok(())
    }

    fn close_stdin(&self, _: &ProcessHandle) -> Result<(), ProcessError> {
        Ok(())
    }

    fn resize_pty(&self, _: &ProcessHandle, _: PtySize) -> Result<(), ProcessError> {
        Ok(())
    }

    fn kill(&self, _: &ProcessHandle) -> Result<(), ProcessError> {
        Ok(())
    }

    fn list(&self) -> Vec<ProcessInfo> {
        Vec::new()
    }
}

/// The real process manager, observed: every spawn is logged with the test clock's time, and the
/// first git child whose arguments hold `verb` is not started at all but held until its run limit,
/// where it ends as a child killed at that limit does.
struct Observed {
    inner: Arc<mixdog_spawn::LocalProcessManager>,
    verb: Option<String>,
    claimed: AtomicBool,
    held: Mutex<Option<(ProcessHandle, Option<Duration>)>>,
    spawns: Mutex<Vec<(Vec<String>, tokio::time::Instant, ProcessHandle)>>,
}

impl Observed {
    fn new(inner: Arc<mixdog_spawn::LocalProcessManager>, verb: Option<&str>) -> Arc<Self> {
        Arc::new(Self { inner, verb: verb.map(str::to_owned), claimed: AtomicBool::new(false), held: Mutex::default(), spawns: Mutex::default() })
    }

    fn is_held(&self, handle: &ProcessHandle) -> bool {
        self.held.lock().unwrap().as_ref().is_some_and(|(held, _)| held == handle)
    }
}

#[async_trait]
impl ProcessManager for Observed {
    async fn spawn(&self, request: SpawnRequest) -> Result<SpawnedProcess, ProcessError> {
        let CommandSpec::Argv { args, .. } = &request.command else { unreachable!("git is spawned by argv") };
        self.spawns.lock().unwrap().push((args.clone(), tokio::time::Instant::now(), request.handle.clone()));
        let hold = self.verb.as_ref().is_some_and(|verb| args.contains(verb)) && !self.claimed.swap(true, Ordering::SeqCst);
        if hold {
            *self.held.lock().unwrap() = Some((request.handle.clone(), request.time_limit));
            return Ok(SpawnedProcess { handle: request.handle, pid: 1 });
        }
        self.inner.spawn(request).await
    }

    fn subscribe(&self, handle: &ProcessHandle, from: Option<u64>) -> Result<Box<dyn EventSource<ProcessEvent>>, ProcessError> {
        if let Some((_, limit)) = self.held.lock().unwrap().as_ref().filter(|(held, _)| held == handle) {
            return Ok(Box::new(HeldUntilLimit { limit: *limit }));
        }
        self.inner.subscribe(handle, from)
    }

    async fn write_stdin(&self, handle: &ProcessHandle, bytes: Vec<u8>) -> Result<(), ProcessError> {
        if self.is_held(handle) {
            return Ok(());
        }
        self.inner.write_stdin(handle, bytes).await
    }

    fn close_stdin(&self, handle: &ProcessHandle) -> Result<(), ProcessError> {
        if self.is_held(handle) {
            return Ok(());
        }
        self.inner.close_stdin(handle)
    }

    fn resize_pty(&self, handle: &ProcessHandle, size: PtySize) -> Result<(), ProcessError> {
        self.inner.resize_pty(handle, size)
    }

    fn kill(&self, handle: &ProcessHandle) -> Result<(), ProcessError> {
        if self.is_held(handle) {
            return Ok(());
        }
        self.inner.kill(handle)
    }

    fn list(&self) -> Vec<ProcessInfo> {
        self.inner.list()
    }
}

/// Node's recording of the bounds (`record-turn-git-bounds.mjs`).
fn bounds() -> serde_json::Value {
    serde_json::from_str(include_str!("../../../../fixtures/turn-git-bounds/bounds.json")).unwrap()
}

fn millis(value: &serde_json::Value) -> Duration {
    Duration::from_millis(value.as_u64().expect("milliseconds"))
}

/// A message with the machine's git executable path replaced by `<GIT>`: the same step on
/// Node's recording (its recorded `gitCommand`) and on the review's text (its own resolution).
fn normalized(text: &str, git: &str) -> String {
    assert!(text.starts_with(&format!("{git} ")), "{text:?} does not name {git}");
    text.replace(git, "<GIT>")
}

fn recorded_text(message: &serde_json::Value) -> String {
    normalized(message.as_str().expect("a message"), bounds()["gitCommand"].as_str().expect("the recorded git"))
}

fn review_text(message: &str) -> String {
    normalized(message, &mixdog_scm::git_launch::git_command())
}

/// The program the review resolves is the one Node's recording resolved on this machine.
#[test]
fn the_review_names_the_git_node_names() {
    assert_eq!(mixdog_scm::git_launch::git_command(), bounds()["gitCommand"].as_str().unwrap());
}

fn strings(value: &serde_json::Value) -> Vec<String> {
    value.as_array().expect("an array").iter().map(|a| a.as_str().expect("a string").to_owned()).collect()
}

/// The limits the Rust review runs its git children under are the ones Node's source sets.
#[test]
fn the_limits_are_the_ones_node_recorded() {
    let limits = &bounds()["sourceLimits"];
    assert_eq!(super::ports::COMMAND_TIMEOUT, millis(&limits["commandTimeoutMs"]));
    assert_eq!(super::ports::GC_TIMEOUT, millis(&limits["gcTimeoutMs"]));
    assert_eq!(super::ports::APPLY_TIMEOUT, millis(&limits["applyTimeoutMs"]));
    assert_eq!(super::ports::IGNORED_PATHS_TIMEOUT, millis(&limits["ignoredPathsTimeoutMs"]));
}

/// A hung git fails with Node's recorded ETIMEDOUT text, exactly when the limit the caller named has passed.
#[tokio::test(start_paused = true)]
async fn a_hung_git_fails_with_the_recorded_text_at_its_limit() {
    let dir = tempfile::tempdir().unwrap();
    let top = dir.path().to_string_lossy().into_owned();
    let tokens = mixdog_rt::testing::tokens();
    let processes = Arc::new(Wedged { limits: Mutex::default(), pending: Mutex::default() });
    let git: Arc<dyn ReviewGit> = Arc::new(ScmGit::new(mixdog_scm::engine::Scm::new(processes.clone(), tokens.maintenance_io, dir.path().join("scm-scratch"))));
    let recorded = bounds();
    let cases = recorded["timeoutCases"].as_array().unwrap();
    assert!(!cases.is_empty());
    for case in cases {
        let (args, limit) = (strings(&case["args"]), millis(&case["timeoutMs"]));
        assert_eq!(case["code"], "ETIMEDOUT");
        let started = tokio::time::Instant::now();
        let error = git.run_with(&top, &args, Vec::new(), &GitOptions::timeout(limit)).await.err().expect("a wedged git fails");
        assert_eq!(review_text(&error), recorded_text(&case["message"]));
        assert_eq!(started.elapsed(), limit);
    }
    let named = processes.limits.lock().unwrap().clone();
    let expected: Vec<_> = cases.iter().map(|c| Some(millis(&c["timeoutMs"]))).collect();
    assert_eq!(named, expected);

    // The default is the capture limit, and the Undo's apply the longer one, as Node ran them.
    let git_command = recorded["gitCommand"].as_str().unwrap();
    let args = strings(&cases[3]["args"]);
    let default = git.run(&top, &args, Vec::new()).await.err().expect("fails");
    let text = |limit: &serde_json::Value| normalized(&format!("{git_command} {} timed out after {limit}ms", args.join(" ")), git_command);
    assert_eq!(review_text(&default), text(&recorded["sourceLimits"]["commandTimeoutMs"]));
    let applied = git.run_with(&top, &args, Vec::new(), &GitOptions::timeout(super::ports::APPLY_TIMEOUT)).await.err().expect("fails");
    assert_eq!(review_text(&applied), text(&recorded["sourceLimits"]["applyTimeoutMs"]));
}

/// Node's recorded queue (`measured.captures`), over a real repository and real Git: two captures
/// of one root started together, the first one's `write-tree` held pending until its 30 s deadline
/// (paused time). The first gives up with `None` at the limit and frees the root; the one queued
/// behind it starts no git until then, then runs its own `write-tree` and snapshots the worktree.
#[tokio::test(start_paused = true)]
async fn a_capture_queued_behind_a_hung_write_tree_runs_after_the_limit_and_snapshots() {
    let recorded = bounds();
    let captures = &recorded["measured"]["captures"];
    let limit = millis(&recorded["sourceLimits"]["commandTimeoutMs"]);
    let verb = captures["first"]["hung"]["verb"].as_str().unwrap().to_owned();
    assert_eq!(captures["first"]["code"], "ETIMEDOUT");
    assert_eq!(Duration::from_secs(captures["first"]["afterSeconds"].as_u64().unwrap()), limit);
    assert!(captures["second"]["resolved"].as_bool().unwrap() && captures["second"]["hasBaselineTree"].as_bool().unwrap() && captures["second"]["startedGitOnlyAfterFirstTimedOut"].as_bool().unwrap());

    let dir = tempfile::tempdir().unwrap();
    let tokens = mixdog_rt::testing::tokens();
    let real = Arc::new(mixdog_spawn::LocalProcessManager::new(tokens.spawn_io, mixdog_spawn::ProcessConfig::default()));
    let processes = Observed::new(real, Some(&verb));
    let scm = mixdog_scm::engine::Scm::new(processes.clone(), tokens.maintenance_io, dir.path().join("scm-scratch"));
    let disk: Arc<dyn ReviewDisk> = Arc::new(super::disk::LaneDisk::new(tokens));
    let git: Arc<dyn ReviewGit> = Arc::new(ScmGit::new(scm));
    let work = dir.path().join("work");
    disk.create_dir_all(&work).await.unwrap();
    let top = work.to_string_lossy().into_owned();
    disk.write_atomic(&work.join("a.txt"), b"one\n".to_vec()).await.unwrap();
    assert_eq!(git.run(&top, &["init".to_owned(), "-q".to_owned()], Vec::new()).await.unwrap().code, 0);
    let toplevel = git.run(&top, &["rev-parse".to_owned(), "--show-toplevel".to_owned()], Vec::new()).await.unwrap();
    let root = String::from_utf8(toplevel.stdout).unwrap().trim().to_owned();
    // The repository's own setup wrote no tree.
    assert!(processes.held.lock().unwrap().is_none());

    let shadow = Arc::new(ShadowRepos::new(dir.path().join("turn-worktree-snapshots-v1"), git, disk));
    let worktrees = ScmWorktrees::new(shadow);
    let started = tokio::time::Instant::now();
    let (first, second) = tokio::join!(worktrees.create(&root), worktrees.create(&root));
    assert!(first.is_none(), "the capture whose write-tree hung gives up");
    let snapshot = second.expect("the queued capture runs and snapshots");
    assert!(!snapshot.baseline_tree().is_empty(), "the queued capture has its baseline tree");
    assert_eq!(started.elapsed(), limit, "the queued capture ran at the first one's deadline");

    let spawns = processes.spawns.lock().unwrap().clone();
    let held_at = spawns.iter().position(|(args, _, handle)| args.contains(&verb) && processes.is_held(handle)).expect("a write-tree was held");
    let hung_at = spawns[held_at].1;
    assert!(spawns[..held_at].iter().all(|(args, at, _)| !args.contains(&verb) && *at <= hung_at), "no tree was written before the hung one");
    let after = &spawns[held_at + 1..];
    assert!(after.iter().all(|(_, at, _)| at.duration_since(hung_at) >= limit), "no git of the queued capture before the first gave up");
    assert!(after.iter().any(|(args, _, _)| args.contains(&verb)), "the queued capture wrote its tree");
}

/// Every spawn of a process manager, remembered, so a test can ask for the exit of the last one.
struct Remembered {
    inner: Arc<mixdog_spawn::LocalProcessManager>,
    handles: Mutex<Vec<ProcessHandle>>,
}

#[async_trait]
impl ProcessManager for Remembered {
    async fn spawn(&self, request: SpawnRequest) -> Result<SpawnedProcess, ProcessError> {
        self.handles.lock().unwrap().push(request.handle.clone());
        self.inner.spawn(request).await
    }

    fn subscribe(&self, handle: &ProcessHandle, from: Option<u64>) -> Result<Box<dyn EventSource<ProcessEvent>>, ProcessError> {
        self.inner.subscribe(handle, from)
    }

    async fn write_stdin(&self, handle: &ProcessHandle, bytes: Vec<u8>) -> Result<(), ProcessError> {
        self.inner.write_stdin(handle, bytes).await
    }

    fn close_stdin(&self, handle: &ProcessHandle) -> Result<(), ProcessError> {
        self.inner.close_stdin(handle)
    }

    fn resize_pty(&self, handle: &ProcessHandle, size: PtySize) -> Result<(), ProcessError> {
        self.inner.resize_pty(handle, size)
    }

    fn kill(&self, handle: &ProcessHandle) -> Result<(), ProcessError> {
        self.inner.kill(handle)
    }

    fn list(&self) -> Vec<ProcessInfo> {
        self.inner.list()
    }
}

/// A real kill: Node's recorded hung alias run through the real process manager and the real Git.
/// The run times out at the recorded limit with the recorded text, only after the alias was
/// reached. The run answers as soon as the kill is issued (as Node's does); the killed tree's own
/// exit, the manager's event for it, is what the test waits for before it touches the file the
/// alias held open.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_real_hung_git_is_killed_at_its_limit_with_its_tree() {
    let dir = tempfile::tempdir().unwrap();
    let tokens = mixdog_rt::testing::tokens();
    let inner = Arc::new(mixdog_spawn::LocalProcessManager::new(tokens.spawn_io, mixdog_spawn::ProcessConfig::default()));
    let processes = Arc::new(Remembered { inner, handles: Mutex::default() });
    let scm = mixdog_scm::engine::Scm::new(processes.clone(), tokens.maintenance_io, dir.path().join("scm-scratch"));
    let disk = super::disk::LaneDisk::new(tokens);
    let git = ScmGit::new(scm);
    let cwd = dir.path().join("real-kill");
    disk.create_dir_all(&cwd).await.unwrap();
    let recorded = bounds();
    let kill = &recorded["realKill"];
    assert!(kill["aliasReached"].as_bool().unwrap() && kill["heldFileReleased"].as_bool().unwrap());
    let (args, limit) = (strings(&kill["args"]), millis(&kill["timeoutMs"]));

    let started = std::time::Instant::now();
    let error = git.run_with(&cwd.to_string_lossy(), &args, Vec::new(), &GitOptions::timeout(limit)).await.err().expect("the hung git is killed");
    assert_eq!(review_text(&error), recorded_text(&kill["message"]));
    assert!(started.elapsed() >= limit, "killed before its limit");
    let held = cwd.join("held.marker");
    assert!(disk.stat(&held).await.unwrap().is_some(), "the alias was reached");

    // The exit event of the killed git is published after its tree is ended.
    let handle = processes.handles.lock().unwrap().last().cloned().expect("git was spawned");
    let mut events = processes.subscribe(&handle, Some(0)).unwrap();
    let exit = loop {
        match events.next().await.expect("the killed git's exit is published") {
            ProcessEvent::Exited { exit, .. } => break exit,
            _ => continue,
        }
    };
    assert_eq!(exit.killed, Some(KillReason::TimeLimit));
    // A file a live process holds open cannot be removed on Windows: the tree is gone.
    disk.remove(&held).await.expect("nothing of the killed tree still holds the file");
}