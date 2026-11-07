//! `SessionSeams::todo_view`: the todo list, Goal and background work as the turn guards read
//! them. A thin binder over [`HostTodoView`]; the session id Node's `awaitingBackgroundWork`
//! takes is the thread's own id (`goal_lane::continuation_input` reads it the same way).

use std::sync::Arc;

use mixdog_agent::todo::TodoView;
use mixdog_protocol::ThreadId;
use mixdog_store::schema::record::Header;
use mixdog_tools::state::goal::GoalPort;
use mixdog_tools::state::todo::TodoStore;

use crate::run_host::guards::{HostTodoView, RunningWork, UserCycles};

/// What every session's guards read from, built once.
pub struct TodoViews {
    todos: Arc<dyn TodoStore>,
    goals: Arc<dyn GoalPort>,
    work: Arc<dyn RunningWork>,
    cycles: Arc<UserCycles>,
}

impl TodoViews {
    /// `cycles` is the one the session deps carry: the turn guards begin it at each genuine prompt.
    pub fn new(todos: Arc<dyn TodoStore>, goals: Arc<dyn GoalPort>, work: Arc<dyn RunningWork>, cycles: Arc<UserCycles>) -> Self {
        Self { todos, goals, work, cycles }
    }

    /// The seam: `todo_view(&ThreadId, &Header)`. The header names nothing the guards read.
    pub fn todo_view(&self, thread: &ThreadId, _header: &Header) -> Arc<dyn TodoView> {
        Arc::new(HostTodoView::new(
            thread.clone(),
            self.todos.clone(),
            self.goals.clone(),
            self.work.clone(),
            self.cycles.clone(),
        ))
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;

    use async_trait::async_trait;
    use mixdog_agent::todo::TodoStatus;
    use mixdog_tools::orch::util::PortError;
    use mixdog_tools::state::goal::{GoalSettlement, GoalSnapshot};
    use mixdog_tools::state::todo::{TodoEdit, TodoList};
    use serde_json::json;

    use super::*;

    struct Todos(Mutex<TodoList>);

    #[async_trait]
    impl TodoStore for Todos {
        async fn read(&self, _: &ThreadId) -> TodoList {
            self.0.lock().unwrap().clone()
        }
        async fn update(&self, _: &ThreadId, _: &mut TodoEdit<'_>) -> Result<(), String> {
            Ok(())
        }
        fn note_user_wait(&self, _: &ThreadId) {}
        fn user_waiting(&self, _: &ThreadId) -> bool {
            false
        }
        fn turn_started(&self, _: &ThreadId) {}
    }

    struct Goal(Result<Option<&'static str>, ()>);

    #[async_trait]
    impl GoalPort for Goal {
        async fn status(&self, _: &ThreadId) -> Result<GoalSnapshot, PortError> {
            match self.0 {
                Ok(status) => Ok(GoalSnapshot { goal: status.map(|s| json!({ "id": "g", "status": s })), remaining_ms: None }),
                Err(()) => Err(PortError::Cancelled),
            }
        }
        async fn create(&self, _: &ThreadId, _: String, _: Option<u64>) -> Result<GoalSnapshot, PortError> {
            unreachable!()
        }
        async fn settle(&self, _: &ThreadId, _: GoalSettlement) -> Result<GoalSnapshot, PortError> {
            unreachable!()
        }
    }

    /// Running tasks as `(session, surface)`.
    struct Work(Vec<(&'static str, &'static str)>);

    #[async_trait]
    impl RunningWork for Work {
        async fn has_active(&self, session_id: &str, surface: &str, _: bool, _: Option<u64>) -> bool {
            self.0.iter().any(|(s, sf)| *s == session_id && *sf == surface)
        }
    }

    fn views(goal: Result<Option<&'static str>, ()>, work: Work) -> TodoViews {
        let list: TodoList = serde_json::from_value(json!({
            "phases": [{ "name": "p", "tasks": [{ "content": "a", "status": "in_progress" }] }],
            "updated_at_ms": 0,
        }))
        .unwrap();
        TodoViews::new(Arc::new(Todos(Mutex::new(list))), Arc::new(Goal(goal)), Arc::new(work), Arc::new(UserCycles::default()))
    }

    #[tokio::test]
    async fn the_view_reads_the_threads_list_goal_and_work() {
        let header = Header::default();
        let view = views(Ok(Some("active")), Work(vec![("t1", "agent")])).todo_view(&ThreadId::from("t1"), &header);
        let phases = view.phases().await;
        assert_eq!(phases[0].tasks[0].content, "a");
        assert_eq!(phases[0].tasks[0].status, TodoStatus::InProgress);
        assert!(view.goal_active().await);
        assert!(view.awaiting_background_work().await, "an agent the thread started is running");
        let other = views(Ok(Some("blocked")), Work(vec![("t1", "agent")])).todo_view(&ThreadId::from("t2"), &header);
        assert!(!other.goal_active().await, "only an active Goal counts");
        assert!(!other.awaiting_background_work().await, "another thread's agent is not ours");
        let unreadable = views(Err(()), Work(vec![])).todo_view(&ThreadId::from("t1"), &header);
        assert!(!unreadable.goal_active().await, "a Goal that cannot be read is no active Goal");
    }
}
