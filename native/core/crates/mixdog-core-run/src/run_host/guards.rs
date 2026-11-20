//! The host half of the todo/goal turn guards (Node `session/loop/no-tool-turn/todo-check.mjs`
//! and `shared/background-wait.mjs`). The reminder logic is `mixdog_agent::todo::TodoGuards`;
//! this supplies what it reads — the list and the Goal through the session actor's stores, the
//! background work a turn waits on, and which calls count as work — and the turn-start step.

use std::sync::Arc;

use async_trait::async_trait;
use mixdog_agent::env::TurnGuards;
use mixdog_agent::todo::{TodoGuards, TodoPhase, TodoStatus, TodoTask, TodoView};
use mixdog_core_api::domain::provider::ToolCall;
use mixdog_protocol::JsonValue;
use mixdog_protocol::ThreadId;
use mixdog_tools::state::goal::GoalPort;
use mixdog_tools::state::todo as store;
use mixdog_tools::state::todo::{TodoList, TodoStore};


/// The running background work of the process (`hasActiveBackgroundTasks`).
#[async_trait]
pub trait RunningWork: Send + Sync {
    /// Whether a task owned by `session_id` on `surface` is running. `awaited_only` leaves out
    /// `detached` tasks.
    async fn has_active(&self, session_id: &str, surface: &str, awaited_only: bool) -> bool;
}

/// Whether the session waits on work that will wake it: an agent it started is still running, or a background shell job it
/// started is, for as long as it runs: a question the user asks meanwhile does not end the wait.
pub async fn awaiting_background_work(work: &dyn RunningWork, session_id: &str) -> bool {
    let id = mixdog_js::js_trim(session_id);
    if id.is_empty() {
        return false;
    }
    work.has_active(id, "agent", false).await || work.has_active(id, "shell", true).await
}

/// What the guards read, from the session's own stores.
pub struct HostTodoView {
    thread: ThreadId,
    session_id: String,
    todos: Arc<dyn TodoStore>,
    goals: Arc<dyn GoalPort>,
    work: Arc<dyn RunningWork>,
}

impl HostTodoView {
    /// The view of one thread; its session id (`awaitingBackgroundWork`'s key) is the thread's id.
    pub fn new(thread: ThreadId, todos: Arc<dyn TodoStore>, goals: Arc<dyn GoalPort>, work: Arc<dyn RunningWork>) -> Self {
        Self { session_id: thread.as_str().to_owned(), thread, todos, goals, work }
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
    ) -> Self {
        let view = Arc::new(HostTodoView { thread, session_id: session_id.to_owned(), todos, goals, work });
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
        self.view.todos.turn_started(&self.view.thread);
        self.guards.start_turn(genuine).await;
    }
}

const TODO_START_TEXT: &str = "Apply the Plan rule to this brief now, before your first tool call. Do not mention this reminder.";

fn todo_start_block() -> String {
    format!("<system-reminder>\n{TODO_START_TEXT}\n</system-reminder>")
}

/// Whether the runtime itself put the start reminder on this user message: it sits in the message's runtime-owned
/// reminder suffix (`meta.runtimeUserContext.suffix`, which the runtime writes and a retried message keeps), never in
/// the words the user typed. A message stored without that suffix counts as not told.
pub fn carries_todo_start(message: &JsonValue) -> bool {
    message.pointer("/meta/runtimeUserContext/suffix").and_then(JsonValue::as_str).is_some_and(|suffix| suffix.contains(&todo_start_block()))
}

/// `todoStartReminder`: a delegated agent received a new brief with no open list — the hidden
/// reminder trailing that prompt, once per prompt. `has_todo_tool` is whether its tools include
/// the todo tool; `hidden_agent` whether its role is a hidden one. The rule text alone was read
/// past on short multi-ask briefs, so the brief itself carries the nudge.
pub fn todo_start_reminder(delegated: bool, hidden_agent: bool, has_todo_tool: bool, open_items: usize) -> Option<String> {
    if !delegated || hidden_agent || !has_todo_tool || open_items > 0 {
        return None;
    }
    Some(todo_start_block())
}

const MCP_TOOL_PREFIX: &str = "mcp__plugin_mixdog_mixdog__";

/// A tool name without its MCP plugin prefix.
pub fn strip_mcp(name: &str) -> &str {
    name.strip_prefix(MCP_TOOL_PREFIX).unwrap_or(name)
}

// ---- mutation classes ----

pub fn is_shell_tool(name: &str) -> bool {
    matches!(strip_mcp(name), "shell" | "bash_session")
}

/// `_isGitMutationTool`: an unknown github action counts as a mutation.
pub fn is_git_mutation(name: &str, args: &JsonValue) -> bool {
    match strip_mcp(name).to_lowercase().as_str() {
        "git" => mixdog_tools::git::git_call_mutates(args),
        "github" => mixdog_tools::github::github_call_mutates(args),
        _ => false,
    }
}

/// `_isMutationTool(name, args) || _isShellTool(name)`: the work a todo list tracks — file
/// edits, command execution and mutating git/github requests.
pub fn is_mutating_call(name: &str, args: &JsonValue) -> bool {
    let lowered = strip_mcp(name).to_lowercase();
    lowered == "apply_patch" || lowered == "edit" || is_git_mutation(name, args) || is_shell_tool(name)
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;

    use mixdog_tools::orch::util::PortError;
    use mixdog_tools::state::goal::{GoalSettlement, GoalSnapshot};
    use serde_json::json;

    use super::*;

    struct Todos(Mutex<TodoList>);

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

    /// Running tasks as `(session, surface, detached)`.
    struct Work(Vec<(&'static str, &'static str, bool)>);

    #[async_trait]
    impl RunningWork for Work {
        async fn has_active(&self, session_id: &str, surface: &str, awaited_only: bool) -> bool {
            self.0.iter().any(|(s, sf, detached)| *s == session_id && *sf == surface && !(awaited_only && *detached))
        }
    }

    fn list(status: &str) -> TodoList {
        serde_json::from_value(json!({
            "phases": [{ "name": "p", "tasks": [{ "content": "a", "status": status }] }],
            "updated_at_ms": 0,
        }))
        .unwrap()
    }
    fn guards(list: TodoList, goal: Option<&'static str>, work: Work) -> (SessionGuards, Arc<Todos>) {
        let todos = Arc::new(Todos(Mutex::new(list)));
        let guards = SessionGuards::new(ThreadId::from("t"), "s1", false, todos.clone(), Arc::new(Goal(goal)), Arc::new(work));
        (guards, todos)
    }

    #[tokio::test]
    async fn a_genuine_prompt_clears_a_finished_list_unless_a_goal_is_active() {
        let (g, todos) = guards(list("completed"), None, Work(vec![]));
        g.begin_turn(false).await;
        assert!(!todos.0.lock().unwrap().phases.is_empty(), "an automatic continuation keeps it");
        g.begin_turn(true).await;
        assert!(todos.0.lock().unwrap().phases.is_empty());
        let (g, todos) = guards(list("completed"), Some("active"), Work(vec![]));
        g.begin_turn(true).await;
        assert!(!todos.0.lock().unwrap().phases.is_empty(), "an active Goal keeps it for its audit");
        let (g, todos) = guards(list("pending"), None, Work(vec![]));
        g.begin_turn(true).await;
        assert!(!todos.0.lock().unwrap().phases.is_empty(), "open items stay");
    }

    #[tokio::test]
    async fn the_completion_reminder_waits_out_a_background_job_across_the_users_next_prompts() {
        // A running shell job is waited on however many prompts the user sent since it started;
        // a detached one never is; a running agent always is.
        let work = Work(vec![("s1", "shell", false)]);
        let (g, _) = guards(list("pending"), None, work);
        g.begin_turn(true).await;
        assert!(g.guards().completion_reminder(false).await.is_none());
        g.begin_turn(true).await;
        assert!(g.guards().completion_reminder(false).await.is_none(), "a question asked meanwhile does not end the wait");
        let work = Work(vec![("s1", "shell", true)]);
        let (g, _) = guards(list("pending"), None, work);
        g.begin_turn(true).await;
        let text = g.guards().completion_reminder(false).await.expect("a detached process is not awaited");
        assert!(text.contains("1 open todo item(s)") && text.contains("(Reminder 1/3)"), "{text}");
        let work = Work(vec![("s1", "agent", false)]);
        let (g, _) = guards(list("pending"), None, work);
        assert!(g.guards().completion_reminder(false).await.is_none());
        let work = Work(vec![("other", "agent", false)]);
        let (g, _) = guards(list("pending"), None, work);
        assert!(g.guards().completion_reminder(false).await.is_some(), "another session's agent is not ours");
    }

    #[tokio::test]
    async fn a_closed_list_asks_for_the_goal_audit_once() {
        let (g, _) = guards(list("completed"), Some("active"), Work(vec![]));
        assert!(g.guards().completion_reminder(false).await.expect("audit").contains("Audit each user condition"));
        assert!(g.guards().completion_reminder(false).await.is_none(), "asked once");
        let (g, _) = guards(list("completed"), Some("blocked"), Work(vec![]));
        assert!(g.guards().completion_reminder(false).await.is_none(), "only an active Goal");
    }

    #[test]
    fn a_message_is_told_only_by_the_runtimes_own_suffix() {
        let reminder = todo_start_reminder(true, false, true, 0).unwrap();
        let sent = json!({ "role": "user", "content": format!("brief\n\n{reminder}"), "meta": { "runtimeUserContext": { "prefix": "", "suffix": format!("\n\n{reminder}") } } });
        assert!(carries_todo_start(&sent));
        let quoted = json!({ "role": "user", "content": format!("what does this mean: {reminder}") });
        assert!(!carries_todo_start(&quoted), "the user's own words never count");
        let quoted_with_suffix = json!({ "role": "user", "content": format!("{reminder}\n\nnote"), "meta": { "runtimeUserContext": { "prefix": "", "suffix": "\n\nnote" } } });
        assert!(!carries_todo_start(&quoted_with_suffix));
        assert!(!carries_todo_start(&json!({ "role": "user", "content": "brief" })), "a message stored before the fact existed");
    }

    #[test]
    fn the_start_reminder_only_trails_a_brief_of_an_agent_with_no_open_list() {
        assert!(todo_start_reminder(true, false, true, 0).unwrap().starts_with("<system-reminder>\nApply the Plan rule"));
        for (delegated, hidden, tool, open) in [(false, false, true, 0), (true, true, true, 0), (true, false, false, 0), (true, false, true, 2)] {
            assert!(todo_start_reminder(delegated, hidden, tool, open).is_none());
        }
    }

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
        fn user_waiting(&self, _: &ThreadId) -> bool {
            false
        }
        fn turn_started(&self, _: &ThreadId) {}
    }


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
        awaiting_background_work(self.work.as_ref(), &self.session_id).await
    }

    async fn user_waiting(&self) -> bool {
        self.todos.user_waiting(&self.thread)
    }

    fn is_mutation(&self, call: &ToolCall) -> bool {
        is_mutating_call(&call.name, &call.arguments)
    }

    /// A finished list stays on screen until the user moves on and then goes the way a finished Goal does; an active
    /// Goal keeps it for its audit.
    async fn genuine_prompt(&self) {
        if self.todos.read(&self.thread).await.all_closed() && !self.goal_active().await {
            // `clearTodo`; a failed write leaves the list as it was.
            let _ = self.todos.update(&self.thread, &mut |_| Ok(TodoList::default())).await;
        }
    }
}
