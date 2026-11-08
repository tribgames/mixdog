//! A wedged git child cannot hang the review: every command runs under the limit Node gives it
//! (`turn-worktree-snapshot.mjs` `COMMAND_TIMEOUT_MS`, `run-child.mjs` ETIMEDOUT), whatever the
//! turn's cancel does, and a capture that times out releases the worktree lock.
#![allow(clippy::disallowed_methods, clippy::disallowed_types, reason = "test setup: a real directory")]

use std::path::Path;
use std::sync::Arc;
use std::sync::Mutex;

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
    limits: Mutex<Vec<(String, Option<std::time::Duration>)>>,
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
        self.pending.lock().unwrap().push((request.handle.clone(), request.clone()));
        Ok(SpawnedProcess { handle: request.handle, pid: 1 })
    }

    fn subscribe(&self, handle: &ProcessHandle, _: Option<u64>) -> Result<Box<dyn EventSource<ProcessEvent>>, ProcessError> {
        let request = self.pending.lock().unwrap().iter().find(|(h, _)| h == handle).map(|(_, r)| r.clone()).ok_or(ProcessError::UnknownHandle)?;
        let CommandSpec::Argv { args, .. } = &request.command else { unreachable!() };
        let mut queue = std::collections::VecDeque::new();
        let mut limit = request.time_limit;
        if args.iter().any(|a| a == "--show-toplevel") {
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

fn rig(data: &Path, top: &str) -> (Arc<Wedged>, Arc<dyn ReviewGit>, ScmWorktrees) {
    let tokens = mixdog_rt::testing::tokens();
    let processes = Arc::new(Wedged { top: top.to_owned(), limits: Mutex::default(), pending: Mutex::default() });
    let scm = mixdog_scm::engine::Scm::new(processes.clone(), tokens.maintenance_io, data.join("scm-scratch"));
    let disk: Arc<dyn ReviewDisk> = Arc::new(super::disk::LaneDisk::new(tokens));
    let git: Arc<dyn ReviewGit> = Arc::new(ScmGit::new(scm));
    let shadow = Arc::new(ShadowRepos::new(data.join("turn-worktree-snapshots-v1"), git.clone(), disk));
    (processes, git, ScmWorktrees::new(shadow))
}

/// A hung git fails with Node's ETIMEDOUT text once its limit has passed, and the run's limit is
/// the one the caller named.
#[tokio::test(start_paused = true)]
async fn a_hung_git_fails_at_its_limit() {
    let dir = tempfile::tempdir().unwrap();
    let top = dir.path().to_string_lossy().into_owned();
    let (processes, git, _) = rig(dir.path(), &top);
    let args: Vec<String> = ["cat-file", "-t", "abc"].map(String::from).to_vec();

    let default = git.run(&top, &args, Vec::new()).await.err().expect("a wedged git fails");
    assert_eq!(default, "git cat-file -t abc timed out after 30000ms");
    let applied = git.run_with(&top, &args, Vec::new(), &GitOptions::timeout(super::ports::APPLY_TIMEOUT)).await.err().expect("fails");
    assert_eq!(applied, "git cat-file -t abc timed out after 60000ms");
    let limits: Vec<_> = processes.limits.lock().unwrap().iter().map(|(_, l)| l.map(|d| d.as_millis())).collect();
    assert_eq!(limits, vec![Some(30_000), Some(60_000)]);
}

/// A baseline whose capture wedges answers `None` (the turn goes on without a worktree snapshot)
/// and gives the root's lock back, so the next capture runs instead of queueing behind it.
#[tokio::test(start_paused = true)]
async fn a_wedged_capture_gives_up_and_frees_the_root() {
    let dir = tempfile::tempdir().unwrap();
    let work = dir.path().join("work");
    std::fs::create_dir(&work).unwrap();
    let top = work.to_string_lossy().into_owned();
    let (_, _, worktrees) = rig(dir.path(), &top);

    assert!(worktrees.create(&top).await.is_none(), "the wedged baseline is dropped");
    assert!(worktrees.create(&top).await.is_none(), "the next capture is not stuck behind the first");
}
