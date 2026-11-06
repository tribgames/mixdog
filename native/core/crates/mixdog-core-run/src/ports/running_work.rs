//! The real [`RunningWork`]: the background work a session started and still has running, read the
//! way Node's `hasActiveBackgroundTasks` reads its task table (`runtime/shared/background-tasks.mjs`).
//!
//! Node keeps agent jobs and background shell jobs in one table; the Rust process keeps the agent
//! jobs on the agent [`JobBoard`] and the shell jobs on the exec runtime, so the question is put to
//! the one that holds the surface asked about. The user cycle a shell job is stamped with when it
//! moves to the background (`stampShellJobCycle`) is read from the same [`UserCycles`] the turn
//! guards open cycles on.

use std::sync::Arc;

use async_trait::async_trait;
use mixdog_agent::agent_tool::board::JobBoard;
use mixdog_core_api::ids::ThreadId;
use mixdog_tools::exec::{ExecRuntime, OwnerCycles};

use crate::run_host::guards::{RunningWork, UserCycles};

/// The user cycles as the exec runtime stamps them on a job.
struct CycleOf(Arc<UserCycles>);

impl OwnerCycles for CycleOf {
    fn current(&self, owner: &ThreadId) -> u64 {
        self.0.current(owner.as_str())
    }
}

/// The shell jobs as the guards ask about them.
trait ShellWork: Send + Sync {
    fn has_active(&self, owner: &ThreadId, awaited_only: bool, user_cycle: Option<u64>) -> bool;
}

impl ShellWork for ExecRuntime {
    fn has_active(&self, owner: &ThreadId, awaited_only: bool, user_cycle: Option<u64>) -> bool {
        ExecRuntime::has_active(self, owner, awaited_only, user_cycle)
    }
}

pub struct ProcessWork {
    board: JobBoard,
    shell: Arc<dyn ShellWork>,
}

impl ProcessWork {
    /// `cycles` must be the one the session deps carry (`SessionDeps.cycles`): the exec runtime
    /// reads its owners' cycles from it, once, before any job moves to the background.
    pub fn new(board: JobBoard, exec: Arc<ExecRuntime>, cycles: Arc<UserCycles>) -> Self {
        exec.set_cycles(Arc::new(CycleOf(cycles)));
        Self { board, shell: exec }
    }
}

#[async_trait]
impl RunningWork for ProcessWork {
    /// Only the two surfaces the guards ask about exist here; an agent job is never `detached`
    /// and carries no user cycle (a cycle filter on it matches nothing, as in Node).
    async fn has_active(&self, session_id: &str, surface: &str, awaited_only: bool, user_cycle: Option<u64>) -> bool {
        match surface {
            "agent" => user_cycle.is_none() && self.board.has_running(session_id),
            "shell" => self.shell.has_active(&ThreadId::from(session_id), awaited_only, user_cycle),
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
            fn has_active(&self, _: &ThreadId, _: bool, _: Option<u64>) -> bool {
                false
            }
        }
        let board = JobBoard::new(Arc::new(Fixed), None, None);
        let work = ProcessWork { board: board.clone(), shell: Arc::new(NoShell) };
        let cycles = UserCycles::default();
        assert!(!awaiting_background_work(&work, &cycles, "s1").await);
        let started = board.register(job(Some("s1"), None)).expect("register");
        board.register(job(None, Some("s2"))).expect("register");
        board.register(job(None, None)).expect("register");
        assert!(work.has_active("s1", "agent", false, None).await);
        assert!(awaiting_background_work(&work, &cycles, "s1").await);
        assert!(work.has_active("s2", "agent", false, None).await, "a job with no caller belongs to its owner");
        assert!(!work.has_active("s3", "agent", false, None).await, "nor to anyone else");
        assert!(!work.has_active("s1", "agent", false, Some(0)).await, "an agent job carries no user cycle");
        assert!(!work.has_active("s1", "other", false, None).await);
        assert!(board.complete(&started, Completion::new("completed")));
        assert!(!awaiting_background_work(&work, &cycles, "s1").await, "a finished job is not work");
    }
}
