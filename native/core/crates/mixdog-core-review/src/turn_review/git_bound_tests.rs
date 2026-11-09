//! A wedged git child cannot hang the review: every command runs under the limit Node gives it
//! (`turn-worktree-snapshot.mjs` `COMMAND_TIMEOUT_MS`, `run-child.mjs` ETIMEDOUT), whatever the
//! turn's cancel does, and a capture that times out releases the worktree lock. Every expectation
//! is read from Node's recording (`fixtures/turn-git-bounds/bounds.json`).

use std::path::Path;
use std::sync::Arc;
use std::sync::Mutex;
use std::time::Duration;

use async_trait::async_trait;
use mixdog_core_api::domain::common::EventSource;
use mixdog_core_api::domain::process::CommandSpec;
use mixdog_core_api::domain::process::ExitStatus;
use mixdog_core_api::domain::process::KillReason;
use mixdog_core_api::domain::process::OutputStream;
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

/// A process manager of git children that answer `rev-parse --show-toplevel` with `top` and
/// otherwise never exit on their own: only the spawn's run limit ends them, as the real manager does.
struct Wedged {
    top: String,
    /// Whether `rev-parse --show-toplevel` is answered (a capture needs its root) or wedges too.
    answers_top: bool,
    limits: Mutex<Vec<(String, Option<std::time::Duration>)>>,
    /// When each spawn was made, on the test clock.
    spawned: Mutex<Vec<(String, tokio::time::Instant)>>,
    pending: Mutex<Vec<(ProcessHandle, SpawnRequest)>>,
}

struct Events {
    queue: std::collections::VecDeque<ProcessEvent>,
    limit: Option<std::time::Duration>,
}

#[async_trait]
impl EventSource<ProcessEvent> for Events {
    async fn next(&mut self) -> Option<ProcessEvent> {
        if let Some(event) = self.queue.pop_front() {
            return Some(event);
        }
        match self.limit {
            Some(limit) => {
                tokio::time::sleep(limit).await;
                Some(ProcessEvent::Exited { seq: 0, exit: ProcessExit { status: ExitStatus::Signal(9), killed: Some(KillReason::TimeLimit) } })
            }
            None => std::future::pending().await,
        }
    }
}

#[async_trait]
impl ProcessManager for Wedged {
    async fn spawn(&self, request: SpawnRequest) -> Result<SpawnedProcess, ProcessError> {
        let CommandSpec::Argv { args, .. } = &request.command else { unreachable!("git is spawned by argv") };
        self.limits.lock().unwrap().push((args.join(" "), request.time_limit));
        self.spawned.lock().unwrap().push((args.join(" "), tokio::time::Instant::now()));
        self.pending.lock().unwrap().push((request.handle.clone(), request.clone()));
        Ok(SpawnedProcess { handle: request.handle, pid: 1 })
    }

    fn subscribe(&self, handle: &ProcessHandle, _: Option<u64>) -> Result<Box<dyn EventSource<ProcessEvent>>, ProcessError> {
        let request = self.pending.lock().unwrap().iter().find(|(h, _)| h == handle).map(|(_, r)| r.clone()).ok_or(ProcessError::UnknownHandle)?;
        let CommandSpec::Argv { args, .. } = &request.command else { unreachable!() };
        let mut queue = std::collections::VecDeque::new();
        let mut limit = request.time_limit;
        if self.answers_top && args.iter().any(|a| a == "--show-toplevel") {
            queue.push_back(ProcessEvent::Output { seq: 0, stream: OutputStream::Stdout, bytes: format!("{}\n", self.top).into_bytes() });
            queue.push_back(ProcessEvent::Exited { seq: 1, exit: ProcessExit { status: ExitStatus::Code(0), killed: None } });
            limit = None;
        }
        Ok(Box::new(Events { queue, limit }))
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
    normalized(message, &super::git_command::git_command())
}

/// The program the review resolves is the one Node's recording resolved on this machine.
#[test]
fn the_review_names_the_git_node_names() {
    assert_eq!(super::git_command::git_command(), bounds()["gitCommand"].as_str().unwrap());
}

fn strings(value: &serde_json::Value) -> Vec<String> {
    value.as_array().expect("an array").iter().map(|a| a.as_str().expect("a string").to_owned()).collect()
}

fn rig(data: &Path, top: &str, answers_top: bool) -> (Arc<Wedged>, Arc<dyn ReviewGit>, ScmWorktrees) {
    let tokens = mixdog_rt::testing::tokens();
    let processes = Arc::new(Wedged { top: top.to_owned(), answers_top, limits: Mutex::default(), spawned: Mutex::default(), pending: Mutex::default() });
    let scm = mixdog_scm::engine::Scm::new(processes.clone(), tokens.maintenance_io, data.join("scm-scratch"));
    let disk: Arc<dyn ReviewDisk> = Arc::new(super::disk::LaneDisk::new(tokens));
    let git: Arc<dyn ReviewGit> = Arc::new(ScmGit::new(scm));
    let shadow = Arc::new(ShadowRepos::new(data.join("turn-worktree-snapshots-v1"), git.clone(), disk));
    (processes, git, ScmWorktrees::new(shadow))
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
    let (processes, git, _) = rig(dir.path(), &top, false);
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
    let named: Vec<_> = processes.limits.lock().unwrap().iter().map(|(_, l)| *l).collect();
    let expected: Vec<_> = cases.iter().map(|c| Some(millis(&c["timeoutMs"]))).collect();
    assert_eq!(named, expected);

    // The default is the capture limit, and the Undo's apply the longer one, as Node ran them.
    let args = strings(&cases[3]["args"]);
    let default = git.run(&top, &args, Vec::new()).await.err().expect("fails");
    assert_eq!(review_text(&default), normalized(&format!("{} {} timed out after {}ms", recorded["gitCommand"].as_str().unwrap(), args.join(" "), recorded["sourceLimits"]["commandTimeoutMs"]), recorded["gitCommand"].as_str().unwrap()));
    let applied = git.run_with(&top, &args, Vec::new(), &GitOptions::timeout(super::ports::APPLY_TIMEOUT)).await.err().expect("fails");
    assert_eq!(review_text(&applied), normalized(&format!("{} {} timed out after {}ms", recorded["gitCommand"].as_str().unwrap(), args.join(" "), recorded["sourceLimits"]["applyTimeoutMs"]), recorded["gitCommand"].as_str().unwrap()));
}

/// Two captures of one root started together, the first one's git wedged: the one queued behind
/// it starts no git until the first has given up at the recorded limit, then runs its own (and
/// wedges at its own); both answer `None`, the turn goes on without a worktree snapshot.
#[tokio::test(start_paused = true)]
async fn a_wedged_capture_gives_up_and_the_queued_one_runs_after_it() {
    let dir = tempfile::tempdir().unwrap();
    let work = dir.path().join("work");
    let disk = super::disk::LaneDisk::new(mixdog_rt::testing::tokens());
    disk.create_dir_all(&work).await.unwrap();
    let top = work.to_string_lossy().into_owned();
    let (processes, _, worktrees) = rig(dir.path(), &top, true);
    let recorded = bounds();
    let captures = &recorded["measured"]["captures"];
    let limit = Duration::from_secs(captures["first"]["afterSeconds"].as_u64().unwrap());
    assert_eq!(captures["first"]["code"], "ETIMEDOUT");

    let started = tokio::time::Instant::now();
    let (first, second) = tokio::join!(worktrees.create(&top), worktrees.create(&top));
    assert!(first.is_none() && second.is_none(), "a wedged baseline is dropped");
    assert_eq!(started.elapsed(), limit * 2, "the second capture waited for the first, then ran its own");

    let spawned = processes.spawned.lock().unwrap().clone();
    let work_spawns: Vec<_> = spawned.iter().filter(|(args, _)| !args.contains("--show-toplevel")).collect();
    let first_at = work_spawns[0].1;
    let later: Vec<_> = work_spawns.iter().filter(|(_, at)| *at > first_at).collect();
    assert!(!later.is_empty(), "the queued capture ran git after the first");
    assert!(later.iter().all(|(_, at)| at.duration_since(first_at) >= limit), "no git of the queued capture before the first gave up");
}

/// A git that records only its first `write-tree` as timed out (with Node's recorded text) and
/// runs every other command for real.
struct FirstWriteTreeWedges {
    inner: Arc<dyn ReviewGit>,
    verb: String,
    limit_ms: u64,
    log: Mutex<Vec<(String, bool)>>,
}

#[async_trait]
impl ReviewGit for FirstWriteTreeWedges {
    async fn run_with(&self, cwd: &str, args: &[String], input: Vec<u8>, options: &GitOptions) -> Result<super::ports::GitRun, String> {
        let wedge = {
            let mut log = self.log.lock().unwrap();
            let wedge = args.contains(&self.verb) && !log.iter().any(|(_, wedged)| *wedged);
            log.push((args.join(" "), wedge));
            wedge
        };
        if wedge {
            return Err(format!("{} {} timed out after {}ms", super::git_command::git_command(), args.join(" "), self.limit_ms));
        }
        self.inner.run_with(cwd, args, input, options).await
    }
}

/// The recorded concurrent queue over a real repository and real Git: the capture whose
/// `write-tree` times out gives up with `None` and frees the root, and the capture queued behind
/// it runs its own git only afterwards and snapshots the worktree.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_capture_queued_behind_a_timed_out_one_runs_and_snapshots() {
    let dir = tempfile::tempdir().unwrap();
    let tokens = mixdog_rt::testing::tokens();
    let processes = Arc::new(mixdog_spawn::LocalProcessManager::new(tokens.spawn_io, mixdog_spawn::ProcessConfig::default()));
    let scm = mixdog_scm::engine::Scm::new(processes, tokens.maintenance_io, dir.path().join("scm-scratch"));
    let disk: Arc<dyn ReviewDisk> = Arc::new(super::disk::LaneDisk::new(tokens));
    let real: Arc<dyn ReviewGit> = Arc::new(ScmGit::new(scm));
    let work = dir.path().join("work");
    disk.create_dir_all(&work).await.unwrap();
    let top = work.to_string_lossy().into_owned();
    disk.write_atomic(&work.join("a.txt"), b"one\n".to_vec()).await.unwrap();
    let init = real.run(&top, &["init".to_owned(), "-q".to_owned()], Vec::new()).await.unwrap();
    assert_eq!(init.code, 0);
    let toplevel = real.run(&top, &["rev-parse".to_owned(), "--show-toplevel".to_owned()], Vec::new()).await.unwrap();
    let root = String::from_utf8(toplevel.stdout).unwrap().trim().to_owned();

    let recorded = bounds();
    let captures = &recorded["measured"]["captures"];
    let limit = recorded["sourceLimits"]["commandTimeoutMs"].as_u64().unwrap();
    let verb = captures["first"]["hung"]["verb"].as_str().unwrap().to_owned();
    assert_eq!(captures["first"]["code"], "ETIMEDOUT");
    assert!(captures["second"]["resolved"].as_bool().unwrap() && captures["second"]["startedGitOnlyAfterFirstTimedOut"].as_bool().unwrap());
    let wedging = Arc::new(FirstWriteTreeWedges { inner: real, verb: verb.clone(), limit_ms: limit, log: Mutex::default() });
    let git: Arc<dyn ReviewGit> = wedging.clone();
    let shadow = Arc::new(ShadowRepos::new(dir.path().join("turn-worktree-snapshots-v1"), git, disk));
    let worktrees = ScmWorktrees::new(shadow);

    let (a, b) = tokio::join!(worktrees.create(&root), worktrees.create(&root));
    let queued = match (a, b) {
        (None, Some(snapshot)) | (Some(snapshot), None) => snapshot,
        (a, b) => panic!("one capture gives up and the other snapshots, got {} and {}", a.is_some(), b.is_some()),
    };
    assert!(!queued.baseline_tree().is_empty(), "the queued capture has its baseline tree");

    let log = wedging.log.lock().unwrap().clone();
    let wedged_at = log.iter().position(|(_, wedged)| *wedged).expect("a write-tree wedged");
    assert!(log[wedged_at].0.contains(&verb));
    // The queued capture's own git (more than its root read) follows the wedge, and a
    // successful write-tree of it ends the log's captures.
    assert!(log[wedged_at + 1..].iter().any(|(args, _)| args.contains(&verb)), "the queued capture wrote its tree");
    assert!(log[..wedged_at].iter().all(|(args, _)| !args.contains(&verb)), "no tree was written before the wedge");
}

/// A real kill: Node's recorded hung alias run through the real process manager and the real Git.
/// The run times out at the recorded limit with the recorded text, only after the alias was
/// reached, and the killed tree no longer holds the file the alias opened.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_real_hung_git_is_killed_at_its_limit_with_its_tree() {
    let dir = tempfile::tempdir().unwrap();
    let tokens = mixdog_rt::testing::tokens();
    let processes = Arc::new(mixdog_spawn::LocalProcessManager::new(tokens.spawn_io, mixdog_spawn::ProcessConfig::default()));
    let scm = mixdog_scm::engine::Scm::new(processes, tokens.maintenance_io, dir.path().join("scm-scratch"));
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
    // A file a live process holds open cannot be removed on Windows: the tree is gone.
    disk.remove(&held).await.expect("nothing of the killed tree still holds the file");
}
