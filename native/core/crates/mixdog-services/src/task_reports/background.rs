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

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use mixdog_agent::agent_tool::board::{Completion, JobOwner, NewJob, JobMeta};
    use mixdog_agent::env::Clock;
    use serde_json::Value;

    use super::*;

    const GOLDEN: &str = include_str!("../../../../fixtures/session-activity/golden.json");

    struct Fixed;
    impl Clock for Fixed {
        fn now_ms(&self) -> i64 {
            1_800_000_000_000
        }
    }

    fn text(value: &Value) -> Option<String> {
        value.as_str().filter(|s| !s.is_empty()).map(str::to_owned)
    }

    /// The recorded registrations on a board; only the agent surface lives there.
    fn recorded_board() -> (JobBoard, Value) {
        let golden: Value = serde_json::from_str(GOLDEN).unwrap();
        let background = golden["backgroundTasks"].clone();
        let board = JobBoard::new(Arc::new(Fixed), None, None);
        for spec in background["registered"].as_array().unwrap().iter().filter(|s| s["surface"] == "agent") {
            let id = board
                .register(NewJob {
                    task_id: text(&spec["taskId"]),
                    operation: "run".to_owned(),
                    owner: JobOwner { caller_session_id: text(&spec["notify"]["callerSessionId"]), owner_session_id: text(&spec["notify"]["routingSessionId"]), host_pid: None },
                    meta: JobMeta { session_id: text(&spec["meta"]["sessionId"]), ..JobMeta::default() },
                    ..NewJob::default()
                })
                .unwrap();
            if let Some(finish) = spec["finish"].as_str() {
                board.complete(&id, Completion::new(finish));
            }
        }
        (board, background)
    }

    #[test]
    fn the_agent_tasks_equal_node_s_rows() {
        let (board, background) = recorded_board();
        let rows: Vec<(String, Option<String>, bool)> = BoardReads::new(board).agent_tasks().into_iter().map(|t| (t.task_id, t.session_id, t.running)).collect();
        let expected: Vec<(String, Option<String>, bool)> = background["agentTasks"]
            .as_array()
            .unwrap()
            .iter()
            .map(|t| (t["taskId"].as_str().unwrap().to_owned(), text(&t["sessionId"]), t["running"] == true))
            .collect();
        assert_eq!(rows, expected);
    }

    #[test]
    fn the_task_owners_equal_node_s_active_session_ids() {
        let (board, background) = recorded_board();
        let mut owners: Vec<String> = BoardReads::new(board).agent_task_owners().into_iter().collect();
        owners.sort();
        let expected: Vec<String> = background["agentTaskOwners"].as_array().unwrap().iter().map(|v| v.as_str().unwrap().to_owned()).collect();
        assert_eq!(owners, expected);
    }
}