//! The real [`RunningWork`]: the background work a session started and still has running, read the
//! way Node's `hasActiveBackgroundTasks` reads its task table (`runtime/shared/background-tasks.mjs`).
//!
//! Node keeps agent jobs and background shell jobs in one table; the Rust process keeps the agent
//! jobs on the agent [`JobBoard`] and the shell jobs on the exec runtime, so the question is put to
//! the one that holds the surface asked about.

use std::sync::Arc;

use async_trait::async_trait;
use mixdog_agent::agent_tool::board::JobBoard;
use mixdog_core_api::ids::ThreadId;
use mixdog_tools::exec::ExecRuntime;

use crate::run_host::guards::RunningWork;

/// The shell jobs as the guards ask about them.
trait ShellWork: Send + Sync {
    fn has_active(&self, owner: &ThreadId, awaited_only: bool) -> bool;
}

impl ShellWork for ExecRuntime {
    fn has_active(&self, owner: &ThreadId, awaited_only: bool) -> bool {
        ExecRuntime::has_active(self, owner, awaited_only)
    }
}

pub struct ProcessWork {
    board: JobBoard,
    shell: Arc<dyn ShellWork>,
}

impl ProcessWork {
    pub fn new(board: JobBoard, exec: Arc<ExecRuntime>) -> Self {
        Self { board, shell: exec }
    }
}

#[async_trait]
impl RunningWork for ProcessWork {
    /// Only the two surfaces the guards ask about exist here; an agent job is never `detached`.
    async fn has_active(&self, session_id: &str, surface: &str, awaited_only: bool) -> bool {
        match surface {
            "agent" => self.board.has_running(session_id),
            "shell" => self.shell.has_active(&ThreadId::from(session_id), awaited_only),
            _ => false,
        }
    }
}

#[cfg(test)]
mod tests {
    use mixdog_agent::agent_tool::board::{Completion, JobOwner, NewJob};
    use mixdog_agent::env::Clock;

    use super::*;
    use crate::run_host::guards::awaiting_background_work;

    struct Fixed;
    impl Clock for Fixed {
        fn now_ms(&self) -> i64 {
            1_000
        }
    }

    fn job(caller: Option<&str>, owner: Option<&str>) -> NewJob {
        NewJob {
            operation: "run".into(),
            owner: JobOwner { caller_session_id: caller.map(str::to_owned), owner_session_id: owner.map(str::to_owned), host_pid: None },
            ..NewJob::default()
        }
    }

    /// The agent half of `hasActiveBackgroundTasks({ callerSessionId, surface: 'agent' })` and of
    /// `awaitingBackgroundWork`: a running job the session started counts (its caller, else the
    /// session that owns it); another session's, a job nobody owns and a finished one do not.
    #[tokio::test]
    async fn a_session_waits_on_the_agent_jobs_it_started_while_they_run() {
        struct NoShell;
        impl ShellWork for NoShell {
            fn has_active(&self, _: &ThreadId, _: bool) -> bool {
                false
            }
        }
        let board = JobBoard::new(Arc::new(Fixed), None, None);
        let work = ProcessWork { board: board.clone(), shell: Arc::new(NoShell) };
        assert!(!awaiting_background_work(&work, "s1").await);
        let started = board.register(job(Some("s1"), None)).expect("register");
        board.register(job(None, Some("s2"))).expect("register");
        board.register(job(None, None)).expect("register");
        assert!(work.has_active("s1", "agent", false).await);
        assert!(awaiting_background_work(&work, "s1").await);
        assert!(work.has_active("s2", "agent", false).await, "a job with no caller belongs to its owner");
        assert!(!work.has_active("s3", "agent", false).await, "nor to anyone else");
        assert!(!work.has_active("s1", "other", false).await);
        assert!(board.complete(&started, Completion::new("completed")));
        assert!(!awaiting_background_work(&work, "s1").await, "a finished job is not work");
    }
}
