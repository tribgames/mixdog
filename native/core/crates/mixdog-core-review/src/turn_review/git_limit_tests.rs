//! A wedged git child cannot hang the review: every command runs under its limit and fails with a text naming the command and
//! the limit once that has passed, whatever else the turn does.

use std::sync::Arc;
use std::sync::Mutex;
use std::time::Duration;

use async_trait::async_trait;
use mixdog_core_api::domain::common::EventSource;
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

use super::ports::APPLY_TIMEOUT;
use super::ports::COMMAND_TIMEOUT;
use super::ports::GC_TIMEOUT;
use super::ports::GitOptions;
use super::ports::ReviewGit;
use super::scm_ports::ScmGit;

/// The child never exits on its own: it ends only when the run limit the spawn named kills it, as the real manager does.
struct HeldUntilLimit(Option<Duration>);

#[async_trait]
impl EventSource<ProcessEvent> for HeldUntilLimit {
    async fn next(&mut self) -> Option<ProcessEvent> {
        match self.0.take() {
            Some(limit) => {
                mixdog_rt::time::sleep(limit).await;
                Some(ProcessEvent::Exited { seq: 0, exit: ProcessExit { status: ExitStatus::Signal(9), killed: Some(KillReason::TimeLimit) } })
            }
            None => std::future::pending().await,
        }
    }
}

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
        Ok(Box::new(HeldUntilLimit(limit)))
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

fn git_over(processes: Arc<Wedged>, scratch: &std::path::Path) -> ScmGit {
    let tokens = mixdog_rt::testing::tokens();
    ScmGit::new(mixdog_scm::engine::Scm::new(processes, tokens.maintenance_io, scratch.join("scm-scratch")))
}

fn args(words: &[&str]) -> Vec<String> {
    words.iter().map(|word| (*word).to_owned()).collect()
}

#[test]
fn the_review_limits_its_git_commands_to_thirty_seconds_and_gc_and_apply_longer() {
    assert_eq!(COMMAND_TIMEOUT, Duration::from_secs(30));
    assert_eq!(GC_TIMEOUT, Duration::from_secs(300));
    assert!(APPLY_TIMEOUT > COMMAND_TIMEOUT, "an undo's apply may take longer than a capture");
}

#[tokio::test(start_paused = true)]
async fn a_hung_git_fails_naming_the_command_and_its_limit_exactly_when_the_limit_has_passed() {
    let dir = tempfile::tempdir().unwrap();
    let top = dir.path().to_string_lossy().into_owned();
    let processes = Arc::new(Wedged { limits: Mutex::default(), pending: Mutex::default() });
    let git = git_over(processes.clone(), dir.path());
    let git_command = mixdog_scm::git_launch::git_command();
    let command = args(&["write-tree"]);
    let limit = Duration::from_secs(12);

    let started = tokio::time::Instant::now();
    let error = git.run_with(&top, &command, Vec::new(), &GitOptions::timeout(limit)).await.err().expect("a wedged git fails");
    assert_eq!(error, format!("{git_command} write-tree timed out after 12000ms"));
    assert_eq!(started.elapsed(), limit);
    assert_eq!(*processes.limits.lock().unwrap(), [Some(limit)], "the limit reaches the process manager");
}

#[tokio::test(start_paused = true)]
async fn a_git_run_without_a_named_limit_takes_the_capture_limit_and_an_apply_the_longer_one() {
    let dir = tempfile::tempdir().unwrap();
    let top = dir.path().to_string_lossy().into_owned();
    let processes = Arc::new(Wedged { limits: Mutex::default(), pending: Mutex::default() });
    let git = git_over(processes, dir.path());
    let git_command = mixdog_scm::git_launch::git_command();
    let command = args(&["status", "--porcelain"]);

    let default = git.run(&top, &command, Vec::new()).await.err().expect("fails");
    assert_eq!(default, format!("{git_command} status --porcelain timed out after 30000ms"));

    let applied = git.run_with(&top, &command, Vec::new(), &GitOptions::timeout(APPLY_TIMEOUT)).await.err().expect("fails");
    assert_eq!(applied, format!("{git_command} status --porcelain timed out after {}ms", APPLY_TIMEOUT.as_millis()));
}
