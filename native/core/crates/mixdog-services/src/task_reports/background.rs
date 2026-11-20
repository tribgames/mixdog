//! The background agent tasks the report watchers read (`listBackgroundTasks({ surface: 'agent' })`
//! and `activeBackgroundTaskSessionIds({ surface: 'agent' })` of `runtime/shared/background-tasks.mjs`).
//! The registry itself is the agent crate's [`JobBoard`]; this is the adapter that reads it in the
//! shapes `AgentRegistry::agent_tasks` and `agent_task_owners` return.

use std::collections::HashSet;

use mixdog_agent::agent_tool::board::JobBoard;
use mixdog_agent::agent_tool::scope::Scope;

use super::chain::AgentTask;

/// The two registry reads over one board.
#[derive(Clone)]
pub struct BoardReads {
    board: JobBoard,
}

impl BoardReads {
    pub fn new(board: JobBoard) -> Self {
        Self { board }
    }

    /// `activeBackgroundTaskSessionIds({ surface: 'agent' })`.
    pub fn agent_task_owners(&self) -> HashSet<String> {
        self.board.running_owners()
    }

    /// `agentTaskRows(listBackgroundTasks)`: every agent task, oldest first, with the session its
    /// meta names (`task.sessionId`, absent when blank).
    pub fn agent_tasks(&self) -> Vec<AgentTask> {
        self.board
            .list_jobs(&Scope::default())
            .into_iter()
            .map(|job| AgentTask { running: job.status == "running", session_id: job.meta.session_id.filter(|id| !id.is_empty()), task_id: job.task_id })
            .collect()
    }
}


