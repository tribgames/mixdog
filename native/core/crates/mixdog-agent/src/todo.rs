//! End-of-turn and mid-turn reminders about the session's todo list and Goal.
//!
//! A turn that ends without a tool call while pending or in-progress items
//! remain gets one hidden reminder naming them, and the loop sends again.
//! Bounded: at most [`MAX_REMINDERS`] per user cycle (reset only by a genuine
//! user prompt), and silent after a reminder that produced no progress. Skipped
//! while the turn genuinely waits on the user, an agent or a background shell.

use std::sync::Arc;
use std::sync::Mutex;

use async_trait::async_trait;
use mixdog_core_api::domain::provider::ToolCall;

use crate::env::TurnGuards;
use crate::message::AgentMessage;
use crate::message::ToolKind;

pub const MAX_REMINDERS: u32 = 3;
/// Successful mutating calls without a todo call before the mid-turn nudge.
pub const STALE_MUTATIONS: u32 = 10;
pub const TODO_TOOL: &str = "todo";

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum TodoStatus {
    Pending,
    InProgress,
    Completed,
    Abandoned,
}

impl TodoStatus {
    fn label(self) -> &'static str {
        match self {
            Self::Pending => "pending",
            Self::InProgress => "in_progress",
            Self::Completed => "completed",
            Self::Abandoned => "abandoned",
        }
    }

    fn open(self) -> bool {
        matches!(self, Self::Pending | Self::InProgress)
    }
}

#[derive(Clone, PartialEq, Eq, Debug)]
pub struct TodoTask {
    pub content: String,
    pub status: TodoStatus,
}

#[derive(Clone, PartialEq, Eq, Debug, Default)]
pub struct TodoPhase {
    pub tasks: Vec<TodoTask>,
}

/// The session's list and the facts around it.
#[async_trait]
pub trait TodoView: Send + Sync {
    /// The list, read from the session actor that owns it.
    async fn phases(&self) -> Vec<TodoPhase>;
    async fn goal_active(&self) -> bool;
    async fn awaiting_background_work(&self) -> bool;
    /// The turn waits on the user outside the loop's own sight (an `ask_user` question left
    /// unanswered, which the todo store records).
    async fn user_waiting(&self) -> bool;
    /// Whether a call changes files, runs commands or mutates a repository
    /// (typed from the tool's annotations by the host).
    fn is_mutation(&self, call: &ToolCall) -> bool;
    /// A genuine user prompt opened a cycle: the host's side of `beginTodoTurn` (the background-work cycle,
    /// a finished list's clearing).
    async fn genuine_prompt(&self);
}

#[derive(Default)]
struct Check {
    reminders: u32,
    awaiting_progress: bool,
    audit_asked: bool,
    stale_mutations: u32,
    create_nudged: bool,
    user_wait: bool,
    /// `session.todoCheck` exists: a genuine prompt opened a cycle, or a check read it (`checkState`).
    kept: bool,
}

impl Check {
    /// `session.todoCheck` as the record holds it; the wait is in memory only (`userWaits`).
    fn from_saved(saved: &serde_json::Value) -> Self {
        let count = |key: &str| saved.get(key).and_then(serde_json::Value::as_u64).map_or(0, |n| u32::try_from(n).unwrap_or(u32::MAX));
        let flag = |key: &str| saved.get(key).and_then(serde_json::Value::as_bool).unwrap_or(false);
        Self {
            reminders: count("reminders"),
            awaiting_progress: flag("awaitingProgress"),
            audit_asked: flag("auditAsked"),
            stale_mutations: count("staleMutations"),
            create_nudged: flag("createNudged"),
            user_wait: false,
            kept: saved.is_object(),
        }
    }

    fn to_saved(&self) -> Option<serde_json::Value> {
        if !self.kept {
            return None;
        }
        let mut saved = serde_json::json!({ "reminders": self.reminders, "awaitingProgress": self.awaiting_progress, "auditAsked": self.audit_asked });
        if self.stale_mutations > 0 {
            saved["staleMutations"] = self.stale_mutations.into();
        }
        if self.create_nudged {
            saved["createNudged"] = true.into();
        }
        Some(saved)
    }
}

pub struct TodoGuards {
    view: Arc<dyn TodoView>,
    /// Hidden roles define their own output contract.
    hidden_agent: bool,
    check: Mutex<Check>,
}

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
}

impl TodoGuards {
    pub fn new(view: Arc<dyn TodoView>, hidden_agent: bool) -> Self {
        Self {
            view,
            hidden_agent,
            check: Mutex::new(Check::default()),
        }
    }

    /// The cycle state the session record carries (`session.todoCheck`), when it has any.
    pub fn with_saved(self, saved: Option<&serde_json::Value>) -> Self {
        if let Some(saved) = saved {
            *lock(&self.check) = Check::from_saved(saved);
        }
        self
    }

    /// A turn starts: `genuine` (a real user prompt) opens a new cycle.
    pub fn begin_turn(&self, genuine: bool) {
        let mut check = lock(&self.check);
        check.user_wait = false;
        if genuine {
            *check = Check { kept: true, ..Check::default() };
        }
    }

    /// `beginTodoTurn` whole: the cycle state, and what the host does for a genuine prompt.
    pub async fn start_turn(&self, genuine: bool) {
        self.begin_turn(genuine);
        if genuine {
            self.view.genuine_prompt().await;
        }
    }
}

fn reminder(lines: impl IntoIterator<Item = String>) -> String {
    let mut all = vec!["<system-reminder>".to_owned()];
    all.extend(lines);
    all.push("</system-reminder>".to_owned());
    all.join("\n")
}

#[async_trait]
impl TurnGuards for TodoGuards {
    fn note_progress(&self) {
        lock(&self.check).awaiting_progress = false;
    }

    fn note_user_wait(&self) {
        lock(&self.check).user_wait = true;
    }

    fn saved(&self) -> Option<serde_json::Value> {
        lock(&self.check).to_saved()
    }

    async fn stale_reminder(&self, calls: &[ToolCall], results: &[AgentMessage]) -> Option<String> {
        if self.hidden_agent {
            return None;
        }
        // Read before taking the lock: it is never held across an await.
        let phases = self.view.phases().await;
        let mut check = lock(&self.check);
        check.kept = true;
        for call in calls {
            if call.name == TODO_TOOL {
                check.stale_mutations = 0;
                continue;
            }
            let landed = results
                .iter()
                .find(|m| m.tool_call_id() == Some(call.id.as_str()))
                .is_some_and(|m| !matches!(m.tool_kind, Some(ToolKind::Error | ToolKind::Skipped)));
            if landed && self.view.is_mutation(call) {
                check.stale_mutations += 1;
            }
        }
        let has_open = phases.iter().flat_map(|p| &p.tasks).any(|t| t.status.open());
        if !phases.is_empty() && !has_open {
            check.stale_mutations = 0;
            return None;
        }
        if phases.is_empty() && check.create_nudged {
            return None;
        }
        if check.stale_mutations < STALE_MUTATIONS {
            return None;
        }
        check.stale_mutations = 0;
        if phases.is_empty() {
            check.create_nudged = true;
            return Some(reminder([
                "No todo list exists for this work yet. If it has three or more steps, init one now with the steps left and keep it current; if it is a single step, ignore this. Keep working; do not mention this reminder.".to_owned(),
            ]));
        }
        let mut lines = vec![
            "The todo tool has not been used for a while. Mark finished items done now (one call each, never batched at the end) so the in-progress pointer is on what you are doing. Keep working; do not mention this reminder.".to_owned(),
        ];
        lines.extend(
            phases
                .iter()
                .flat_map(|p| &p.tasks)
                .map(|t| format!("- [{}] {}", t.status.label(), t.content)),
        );
        Some(reminder(lines))
    }

    async fn completion_reminder(&self, turn_limited: bool) -> Option<String> {
        if turn_limited || self.hidden_agent {
            return None;
        }
        let phases = self.view.phases().await;
        if phases.is_empty() {
            return None;
        }
        // Read before taking the lock: it is never held across an await.
        let background = self.view.awaiting_background_work().await;
        let goal = self.view.goal_active().await;
        let user_waiting = self.view.user_waiting().await;
        let mut check = lock(&self.check);
        check.kept = true;
        if check.awaiting_progress || check.user_wait || user_waiting {
            return None;
        }
        let open: Vec<&TodoTask> = phases
            .iter()
            .flat_map(|p| &p.tasks)
            .filter(|t| t.status.open())
            .collect();
        if !open.is_empty() {
            if check.reminders >= MAX_REMINDERS || background {
                return None;
            }
            check.reminders += 1;
            check.awaiting_progress = true;
            let mut lines = vec![format!(
                "You ended the turn with {} open todo item(s):",
                open.len()
            )];
            lines.extend(open.iter().map(|t| format!("- {}", t.content)));
            lines.push("Continue them, or close each with the todo tool (done or drop).".to_owned());
            lines.push(format!("(Reminder {}/{MAX_REMINDERS})", check.reminders));
            return Some(reminder(lines));
        }
        if check.audit_asked || !goal || background {
            return None;
        }
        check.audit_asked = true;
        check.awaiting_progress = true;
        Some(reminder([
            "Every todo item is closed but the Goal is still active. Audit each user condition of the Goal objective against current evidence: when all are proven met, call goal with action complete; otherwise append the remaining work to todo and continue.".to_owned(),
        ]))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct View {
        phases: Vec<TodoPhase>,
        goal: bool,
    }

    #[async_trait]
    impl TodoView for View {
        async fn phases(&self) -> Vec<TodoPhase> {
            self.phases.clone()
        }
        async fn goal_active(&self) -> bool {
            self.goal
        }
        async fn awaiting_background_work(&self) -> bool {
            false
        }
        async fn user_waiting(&self) -> bool {
            false
        }
        fn is_mutation(&self, call: &ToolCall) -> bool {
            call.name == "edit"
        }
        async fn genuine_prompt(&self) {}
    }

    /// `session.todoCheck` rides the record: a reminder counted in one turn is still counted in the next
    /// (an automatic continuation keeps it), and a genuine prompt opens a new cycle.
    #[tokio::test]
    async fn the_cycle_state_round_trips_through_the_record() {
        let view = || Arc::new(View { phases: open_list(), goal: false });
        let first = TodoGuards::new(view(), false);
        assert_eq!(first.saved(), None, "no check read yet");
        first.start_turn(true).await;
        assert_eq!(first.saved(), Some(serde_json::json!({ "reminders": 0, "awaitingProgress": false, "auditAsked": false })));
        assert!(first.completion_reminder(false).await.is_some());
        let saved = first.saved();
        assert_eq!(saved, Some(serde_json::json!({ "reminders": 1, "awaitingProgress": true, "auditAsked": false })));
        let next = TodoGuards::new(view(), false).with_saved(saved.as_ref());
        next.start_turn(false).await;
        assert!(next.completion_reminder(false).await.is_none(), "the continuation still awaits progress");
        next.start_turn(true).await;
        assert_eq!(next.saved(), Some(serde_json::json!({ "reminders": 0, "awaitingProgress": false, "auditAsked": false })));
    }

    fn open_list() -> Vec<TodoPhase> {
        vec![TodoPhase {
            tasks: vec![TodoTask {
                content: "write".into(),
                status: TodoStatus::InProgress,
            }],
        }]
    }

    #[tokio::test]
    async fn open_items_remind_three_times_and_only_after_progress() {
        let guards = TodoGuards::new(
            Arc::new(View {
                phases: open_list(),
                goal: false,
            }),
            false,
        );
        let first = guards.completion_reminder(false).await.unwrap();
        assert!(first.contains("1 open todo item(s)") && first.contains("(Reminder 1/3)"));
        assert!(guards.completion_reminder(false).await.is_none(), "no progress yet");
        guards.note_progress();
        assert!(guards.completion_reminder(false).await.is_some());
        guards.note_progress();
        assert!(guards.completion_reminder(false).await.is_some());
        guards.note_progress();
        assert!(guards.completion_reminder(false).await.is_none(), "cap of three");
        assert!(guards.completion_reminder(true).await.is_none());
    }

    #[tokio::test]
    async fn a_denied_approval_makes_the_turn_wait_on_the_user() {
        let guards = TodoGuards::new(
            Arc::new(View {
                phases: open_list(),
                goal: false,
            }),
            false,
        );
        guards.note_user_wait();
        assert!(guards.completion_reminder(false).await.is_none());
        guards.begin_turn(false);
        assert!(guards.completion_reminder(false).await.is_some());
    }

    /// A question left unanswered is recorded outside the loop (the todo store): the check
    /// reads it from the view (`userWaits.has(id)`).
    #[tokio::test]
    async fn a_question_the_view_reports_unanswered_makes_the_turn_wait_on_the_user() {
        struct Waiting(View);
        #[async_trait]
        impl TodoView for Waiting {
            async fn phases(&self) -> Vec<TodoPhase> {
                self.0.phases().await
            }
            async fn goal_active(&self) -> bool {
                false
            }
            async fn awaiting_background_work(&self) -> bool {
                false
            }
            async fn user_waiting(&self) -> bool {
                true
            }
            fn is_mutation(&self, _: &ToolCall) -> bool {
                false
            }
            async fn genuine_prompt(&self) {}
        }
        let guards = TodoGuards::new(Arc::new(Waiting(View { phases: open_list(), goal: false })), false);
        assert!(guards.completion_reminder(false).await.is_none());
    }
}
