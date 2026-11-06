//! The host half of the todo/goal turn guards (Node `session/loop/no-tool-turn/todo-check.mjs`
//! and `shared/background-wait.mjs`). The reminder logic is `mixdog_agent::todo::TodoGuards`;
//! this supplies what it reads — the list and the Goal through the session actor's stores, the
//! background work a turn waits on, and which calls count as work — and the turn-start step.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use mixdog_agent::env::TurnGuards;
use mixdog_agent::todo::{TodoGuards, TodoPhase, TodoStatus, TodoTask, TodoView};
use mixdog_core_api::domain::provider::ToolCall;
use mixdog_protocol::ThreadId;
use mixdog_tools::state::goal::GoalPort;
use mixdog_tools::state::todo as store;
use mixdog_tools::state::todo::{TodoList, TodoStore};

use super::result_reuse::is_mutating_call;

/// Session id -> its user cycle number (`userCycles` of `background-wait.mjs`). In memory like
/// the shell jobs it stamps: a restarted process has no running jobs from an earlier cycle.
#[derive(Default)]
pub struct UserCycles(Mutex<HashMap<String, u64>>);

impl UserCycles {
    /// `beginUserCycle`: a genuine user prompt opened a new cycle.
    pub fn begin(&self, session_id: &str) {
        let id = mixdog_js::js_trim(session_id);
        if !id.is_empty() {
            *self.0.lock().unwrap_or_else(std::sync::PoisonError::into_inner).entry(id.to_owned()).or_default() += 1;
        }
    }

    /// `currentUserCycle`; a background shell job is stamped with it when it starts
    /// (`stampShellJobCycle`).
    pub fn current(&self, session_id: &str) -> u64 {
        self.0.lock().unwrap_or_else(std::sync::PoisonError::into_inner).get(mixdog_js::js_trim(session_id)).copied().unwrap_or(0)
    }
}

/// The running background work of the process (`hasActiveBackgroundTasks`).
#[async_trait]
pub trait RunningWork: Send + Sync {
    /// Whether a task owned by `session_id` on `surface` is running. `awaited_only` leaves out
    /// `detached` tasks; `user_cycle` keeps only tasks stamped with that cycle.
    async fn has_active(&self, session_id: &str, surface: &str, awaited_only: bool, user_cycle: Option<u64>) -> bool;
}

/// `awaitingBackgroundWork({ sessionId })`: an agent it started is still running, or a background
/// shell job it started in the current user cycle is.
pub async fn awaiting_background_work(work: &dyn RunningWork, cycles: &UserCycles, session_id: &str) -> bool {
    let id = mixdog_js::js_trim(session_id);
    if id.is_empty() {
        return false;
    }
    work.has_active(id, "agent", false, None).await || work.has_active(id, "shell", true, Some(cycles.current(id))).await
}

fn phases_of(list: &TodoList) -> Vec<TodoPhase> {
    list.phases
        .iter()
        .map(|phase| TodoPhase {
            tasks: phase
                .tasks
                .iter()
                .map(|task| TodoTask {
                    content: task.content.clone(),
                    status: match task.status {
                        store::TodoStatus::Pending => TodoStatus::Pending,
                        store::TodoStatus::InProgress => TodoStatus::InProgress,
                        store::TodoStatus::Completed => TodoStatus::Completed,
                        store::TodoStatus::Abandoned => TodoStatus::Abandoned,
                    },
                })
                .collect(),
        })
        .collect()
}

/// What the guards read, from the session's own stores.
pub struct HostTodoView {
    thread: ThreadId,
    session_id: String,
    todos: Arc<dyn TodoStore>,
    goals: Arc<dyn GoalPort>,
    work: Arc<dyn RunningWork>,
    cycles: Arc<UserCycles>,
}

#[async_trait]
impl TodoView for HostTodoView {
    async fn phases(&self) -> Vec<TodoPhase> {
        phases_of(&self.todos.read(&self.thread).await)
    }

    async fn goal_active(&self) -> bool {
        // A Goal that cannot be read is no active Goal (`activeGoal` catches).
        self.goals
            .status(&self.thread)
            .await
            .ok()
            .and_then(|snapshot| snapshot.goal)
            .is_some_and(|goal| goal.get("status").and_then(|s| s.as_str()) == Some("active"))
    }

    async fn awaiting_background_work(&self) -> bool {
        awaiting_background_work(self.work.as_ref(), &self.cycles, &self.session_id).await
    }

    fn is_mutation(&self, call: &ToolCall) -> bool {
        is_mutating_call(&call.name, &call.arguments)
    }
}

/// The turn guards of one session, with the turn-start step that belongs to them.
pub struct SessionGuards {
    guards: Arc<TodoGuards>,
    view: Arc<HostTodoView>,
}

impl SessionGuards {
    /// `hidden_agent`: the role's name is one of the hidden agents (it defines its own output).
    pub fn new(
        thread: ThreadId,
        session_id: &str,
        hidden_agent: bool,
        todos: Arc<dyn TodoStore>,
        goals: Arc<dyn GoalPort>,
        work: Arc<dyn RunningWork>,
        cycles: Arc<UserCycles>,
    ) -> Self {
        let view = Arc::new(HostTodoView { thread, session_id: session_id.to_owned(), todos, goals, work, cycles });
        Self { guards: Arc::new(TodoGuards::new(view.clone(), hidden_agent)), view }
    }

    /// Install as the loop's `guards`.
    pub fn guards(&self) -> Arc<dyn TurnGuards> {
        self.guards.clone()
    }

    /// `beginTodoTurn`: a turn starts; `genuine` (a real user prompt) opens a new reminder cycle.
    /// A finished list stays on screen until the user moves on, then goes the way a finished Goal
    /// does; an active Goal keeps it for its audit.
    pub async fn begin_turn(&self, genuine: bool) {
        self.guards.begin_turn(genuine);
        if !genuine {
            return;
        }
        self.view.cycles.begin(&self.view.session_id);
        if self.view.todos.read(&self.view.thread).await.all_closed() && !self.view.goal_active().await {
            // `clearTodo`; a failed write leaves the list as it was.
            let _ = self.view.todos.update(&self.view.thread, &mut |_| Ok(TodoList::default())).await;
        }
    }
}

/// `todoStartReminder`: a delegated agent received a new brief with no open list — the hidden
/// reminder trailing that prompt, once per prompt. `has_todo_tool` is whether its tools include
/// the todo tool; `hidden_agent` whether its role is a hidden one.
pub fn todo_start_reminder(delegated: bool, hidden_agent: bool, has_todo_tool: bool, open_items: usize) -> Option<String> {
    if !delegated || hidden_agent || !has_todo_tool || open_items > 0 {
        return None;
    }
    Some(
        [
            "<system-reminder>",
            "If this brief has three or more steps or several asks, init the todo list with every ask as its own item in the same response as your first tool call; each item the brief lists is its own todo item, never folded into one. A single step or a plain answer needs none. Do not mention this reminder.",
            "</system-reminder>",
        ]
        .join("\n"),
    )
}

#[cfg(test)]
mod tests {
    use mixdog_tools::orch::util::PortError;
    use mixdog_tools::state::goal::{GoalSettlement, GoalSnapshot};
    use serde_json::{json, Value};

    use super::*;

    struct Todos(Mutex<TodoList>);

    #[async_trait]
    impl TodoStore for Todos {
        async fn read(&self, _: &ThreadId) -> TodoList {
            self.0.lock().unwrap().clone()
        }
        async fn update(
            &self,
            _: &ThreadId,
            f: &mut store::TodoEdit<'_>,
        ) -> Result<(), String> {
            let current = self.0.lock().unwrap().clone();
            let next = f(&current)?;
            *self.0.lock().unwrap() = next;
            Ok(())
        }
        fn note_user_wait(&self, _: &ThreadId) {}
    }

    struct Goal(Option<&'static str>);

    #[async_trait]
    impl GoalPort for Goal {
        async fn status(&self, _: &ThreadId) -> Result<GoalSnapshot, PortError> {
            Ok(GoalSnapshot { goal: self.0.map(|s| json!({ "id": "g", "status": s })), remaining_ms: None })
        }
        async fn create(&self, _: &ThreadId, _: String, _: Option<u64>) -> Result<GoalSnapshot, PortError> {
            unreachable!()
        }
        async fn settle(&self, _: &ThreadId, _: GoalSettlement) -> Result<GoalSnapshot, PortError> {
            unreachable!()
        }
        async fn extend(&self, _: &ThreadId, _: u64) -> Result<GoalSnapshot, PortError> {
            unreachable!()
        }
    }

    /// Running tasks as `(session, surface, detached, user_cycle)`.
    struct Work(Vec<(&'static str, &'static str, bool, u64)>);

    #[async_trait]
    impl RunningWork for Work {
        async fn has_active(&self, session_id: &str, surface: &str, awaited_only: bool, user_cycle: Option<u64>) -> bool {
            self.0.iter().any(|(s, sf, detached, cycle)| {
                *s == session_id && *sf == surface && !(awaited_only && *detached) && user_cycle.is_none_or(|c| c == *cycle)
            })
        }
    }

    fn list(status: &str) -> TodoList {
        serde_json::from_value(json!({
            "phases": [{ "name": "p", "tasks": [{ "content": "a", "status": status }] }],
            "updated_at_ms": 0,
        }))
        .unwrap()
    }
    fn guards(list: TodoList, goal: Option<&'static str>, work: Work) -> (SessionGuards, Arc<Todos>, Arc<UserCycles>) {
        let todos = Arc::new(Todos(Mutex::new(list)));
        let cycles = Arc::new(UserCycles::default());
        let guards = SessionGuards::new(
            ThreadId::from("t"),
            "s1",
            false,
            todos.clone(),
            Arc::new(Goal(goal)),
            Arc::new(work),
            cycles.clone(),
        );
        (guards, todos, cycles)
    }

    #[tokio::test]
    async fn a_genuine_prompt_clears_a_finished_list_unless_a_goal_is_active() {
        let (g, todos, cycles) = guards(list("completed"), None, Work(vec![]));
        g.begin_turn(false).await;
        assert!(!todos.0.lock().unwrap().phases.is_empty(), "an automatic continuation keeps it");
        assert_eq!(cycles.current("s1"), 0);
        g.begin_turn(true).await;
        assert!(todos.0.lock().unwrap().phases.is_empty());
        assert_eq!(cycles.current("s1"), 1);
        let (g, todos, _) = guards(list("completed"), Some("active"), Work(vec![]));
        g.begin_turn(true).await;
        assert!(!todos.0.lock().unwrap().phases.is_empty(), "an active Goal keeps it for its audit");
        let (g, todos, _) = guards(list("pending"), None, Work(vec![]));
        g.begin_turn(true).await;
        assert!(!todos.0.lock().unwrap().phases.is_empty(), "open items stay");
    }

    #[tokio::test]
    async fn the_completion_reminder_waits_out_background_work_of_the_current_cycle_only() {
        // A shell job stamped with cycle 1 is waited on in cycle 1, not once cycle 2 begins;
        // a detached one never is; a running agent always is.
        let work = Work(vec![("s1", "shell", false, 1)]);
        let (g, _, _) = guards(list("pending"), None, work);
        g.begin_turn(true).await;
        assert!(g.guards().completion_reminder(false).await.is_none());
        g.begin_turn(true).await;
        let text = g.guards().completion_reminder(false).await.expect("cycle 2 has no job to wait on");
        assert!(text.contains("1 open todo item(s)") && text.contains("(Reminder 1/3)"), "{text}");
        let work = Work(vec![("s1", "shell", true, 1)]);
        let (g, _, _) = guards(list("pending"), None, work);
        g.begin_turn(true).await;
        assert!(g.guards().completion_reminder(false).await.is_some(), "a detached process is not awaited");
        let work = Work(vec![("s1", "agent", false, 0)]);
        let (g, _, _) = guards(list("pending"), None, work);
        assert!(g.guards().completion_reminder(false).await.is_none());
        let work = Work(vec![("other", "agent", false, 0)]);
        let (g, _, _) = guards(list("pending"), None, work);
        assert!(g.guards().completion_reminder(false).await.is_some(), "another session's agent is not ours");
    }

    #[tokio::test]
    async fn a_closed_list_asks_for_the_goal_audit_once() {
        let (g, _, _) = guards(list("completed"), Some("active"), Work(vec![]));
        assert!(g.guards().completion_reminder(false).await.expect("audit").contains("Audit each user condition"));
        assert!(g.guards().completion_reminder(false).await.is_none(), "asked once");
        let (g, _, _) = guards(list("completed"), Some("blocked"), Work(vec![]));
        assert!(g.guards().completion_reminder(false).await.is_none(), "only an active Goal");
    }

    /// `_isMutationTool || _isShellTool` of Node's `tool-classify.mjs` on 19 calls.
    #[test]
    fn mutating_calls_follow_node() {
        let golden: Value = serde_json::from_str(include_str!("golden/mutating_calls.json")).unwrap();
        for row in golden.as_array().unwrap() {
            let (name, args) = (row[0].as_str().unwrap(), &row[1]);
            assert_eq!(json!(is_mutating_call(name, args)), row[2], "{name} {args}");
        }
    }

    #[test]
    fn the_start_reminder_only_trails_a_brief_of_an_agent_with_no_open_list() {
        assert!(todo_start_reminder(true, false, true, 0).unwrap().starts_with("<system-reminder>\nIf this brief"));
        for (delegated, hidden, tool, open) in [(false, false, true, 0), (true, true, true, 0), (true, false, false, 0), (true, false, true, 2)] {
            assert!(todo_start_reminder(delegated, hidden, tool, open).is_none());
        }
    }
}
