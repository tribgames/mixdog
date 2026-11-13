//! `todo`: the per-owner step list. One list lives on each session record (the Lead session and
//! each agent session); the session actor owns it and persists it with the session. This module
//! is the pure list logic plus the tool front end; the store seam serializes updates of one list.

use std::collections::HashSet;

use async_trait::async_trait;
use mixdog_core_api::domain::tool::Tool;
use mixdog_core_api::domain::tool::ToolContext;
use mixdog_core_api::domain::tool::ToolOutcome;
use mixdog_core_api::domain::tool::ToolSpec;
use mixdog_protocol::JsonValue;
use mixdog_protocol::ThreadId;
use serde::Deserialize;
use serde::Serialize;
use serde_json::Value;

use crate::orch::util::action_failed;
use crate::orch::util::invalid;
use crate::orch::util::one_line;
use crate::orch::util::spec_from_def;
use crate::orch::util::text;

pub const TODO_OPS: [&str; 6] = ["set", "advance", "done", "start", "drop", "view"];
/// A plan of more steps than this is a backlog, not the steps of one request.
pub const MAX_TODO_ITEMS: usize = 15;
pub const MAX_TODO_TEXT_LENGTH: usize = 200;
const DEFAULT_TODO_PHASE: &str = "Tasks";

#[derive(Clone, Copy, PartialEq, Eq, Debug, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TodoStatus {
    Pending,
    InProgress,
    Completed,
    Abandoned,
}

impl TodoStatus {
    fn mark(self) -> char {
        match self {
            Self::Completed => 'x',
            Self::InProgress => '>',
            Self::Pending => ' ',
            Self::Abandoned => '-',
        }
    }

    fn open(self) -> bool {
        matches!(self, Self::Pending | Self::InProgress)
    }
}

#[derive(Clone, PartialEq, Eq, Debug, Serialize, Deserialize)]
pub struct TodoTask {
    pub content: String,
    pub status: TodoStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
}

impl TodoTask {
    fn pending(content: String) -> Self {
        Self {
            content,
            status: TodoStatus::Pending,
            note: None,
        }
    }
}

#[derive(Clone, PartialEq, Eq, Debug, Serialize, Deserialize)]
pub struct TodoPhase {
    pub name: String,
    pub tasks: Vec<TodoTask>,
}

/// The session's list. An empty `phases` is "no list".
#[derive(Clone, PartialEq, Eq, Debug, Default, Serialize, Deserialize)]
pub struct TodoList {
    pub phases: Vec<TodoPhase>,
    pub updated_at_ms: i64,
}

impl TodoList {
    fn tasks(&self) -> impl Iterator<Item = &TodoTask> {
        self.phases.iter().flat_map(|phase| phase.tasks.iter())
    }

    fn tasks_mut(&mut self) -> impl Iterator<Item = &mut TodoTask> {
        self.phases.iter_mut().flat_map(|phase| phase.tasks.iter_mut())
    }

    /// Pending and in-progress items: the work the completion check asks about.
    pub fn open_items(&self) -> Vec<&TodoTask> {
        self.tasks().filter(|task| task.status.open()).collect()
    }

    /// Every item not completed or dropped: what an agent leaves undone when it ends.
    pub fn unfinished_items(&self) -> Vec<&TodoTask> {
        self.tasks()
            .filter(|task| !matches!(task.status, TodoStatus::Completed | TodoStatus::Abandoned))
            .collect()
    }

    /// A list with items, every one completed or dropped.
    pub fn all_closed(&self) -> bool {
        self.tasks().next().is_some() && self.unfinished_items().is_empty()
    }

    /// Agent status rows: completed over total (dropped items leave the total) and the current
    /// item.
    pub fn progress(&self) -> Option<TodoProgress> {
        let (completed, abandoned, total) = self.counts();
        if total == 0 {
            return None;
        }
        Some(TodoProgress {
            completed,
            total: total - abandoned,
            current: self
                .tasks()
                .find(|task| task.status == TodoStatus::InProgress)
                .map(|task| task.content.clone()),
        })
    }

    /// Lines naming what an agent leaves undone, empty when nothing is.
    pub fn not_done_report(&self) -> String {
        let unfinished = self.unfinished_items();
        if unfinished.is_empty() {
            return String::new();
        }
        let mut lines = vec!["Not done:".to_owned()];
        lines.extend(unfinished.iter().map(|task| format!("- {}", task.content)));
        lines.join("\n")
    }

    /// The open list as a hidden reminder (after compaction, or appended to a Goal
    /// continuation); empty when nothing is open.
    pub fn context_block(&self, lead: &str, whole: bool) -> String {
        if self.phases.is_empty() {
            return String::new();
        }
        if !whole && self.unfinished_items().is_empty() {
            return String::new();
        }
        ["<todo_state>", lead, &self.render(), "</todo_state>"].join("\n")
    }

    fn counts(&self) -> (usize, usize, usize) {
        let completed = self.tasks().filter(|t| t.status == TodoStatus::Completed).count();
        let abandoned = self.tasks().filter(|t| t.status == TodoStatus::Abandoned).count();
        (completed, abandoned, self.tasks().count())
    }

    fn progress_label(&self) -> String {
        let (completed, abandoned, total) = self.counts();
        format!("{completed}/{}", total - abandoned)
    }

    /// The whole list as text: set/view replies and context re-injection.
    pub fn render(&self) -> String {
        if self.phases.is_empty() {
            return "todo: empty".to_owned();
        }
        let mut lines = vec![self.progress_label()];
        for phase in &self.phases {
            lines.push(phase.name.clone());
            for task in &phase.tasks {
                let detail = task.note.as_deref().map(|n| format!(" — {n}")).unwrap_or_default();
                lines.push(format!("  [{}] {}{detail}", task.status.mark(), task.content));
            }
        }
        lines.join("\n")
    }

    /// Exactly one in_progress while actionable work exists: several keep the earliest, none
    /// starts the earliest pending.
    fn normalize(&mut self) {
        let mut seen_active = false;
        for task in self.tasks_mut() {
            if task.status == TodoStatus::InProgress {
                if seen_active {
                    task.status = TodoStatus::Pending;
                }
                seen_active = true;
            }
        }
        if !seen_active
            && let Some(next) = self.tasks_mut().find(|t| t.status == TodoStatus::Pending)
        {
            next.status = TodoStatus::InProgress;
        }
        self.phases.retain(|phase| !phase.tasks.is_empty());
    }
}

#[derive(Clone, PartialEq, Eq, Debug)]
pub struct TodoProgress {
    pub completed: usize,
    pub total: usize,
    pub current: Option<String>,
}

/// What a `todo` call does to the list.
#[derive(Clone, PartialEq, Eq, Debug)]
pub enum TodoRun {
    View(String),
    Commit { list: TodoList, reply: String },
}

fn item_text(value: &Value, what: &str) -> Result<String, String> {
    let raw = match value {
        Value::Null => String::new(),
        Value::String(s) => s.clone(),
        other => other.to_string(),
    };
    let text = one_line(&raw);
    if text.is_empty() {
        return Err(format!("todo: {what} wording is required"));
    }
    if mixdog_js::utf16_len(&text) > MAX_TODO_TEXT_LENGTH {
        return Err(format!("todo: {what} exceeds {MAX_TODO_TEXT_LENGTH} characters"));
    }
    Ok(text)
}

fn arg_line(args: &Value, key: &str) -> String {
    match args.get(key) {
        None | Some(Value::Null) => String::new(),
        Some(Value::String(s)) => one_line(s),
        Some(other) => one_line(&other.to_string()),
    }
}

/// `set`: the whole plan in order, replacing the list there was. `done` says how many of its leading steps are
/// already finished, for a plan set again part-way through.
fn set_list(args: &Value, now_ms: i64) -> Result<TodoList, String> {
    let items = match args.get("items") {
        Some(Value::Array(items)) if !items.is_empty() => items,
        _ => return Err("todo: set requires items".to_owned()),
    };
    if items.len() > MAX_TODO_ITEMS {
        return Err(format!("todo: at most {MAX_TODO_ITEMS} steps"));
    }
    let finished = match args.get("done") {
        None | Some(Value::Null) => 0,
        Some(count) => count
            .as_u64()
            .and_then(|n| usize::try_from(n).ok())
            .filter(|n| *n <= items.len())
            .ok_or_else(|| "todo: done is how many of the leading steps are already finished".to_owned())?,
    };
    let mut seen = HashSet::new();
    let mut tasks = Vec::with_capacity(items.len());
    for (at, raw) in items.iter().enumerate() {
        let content = item_text(raw, "step")?;
        if !seen.insert(content.clone()) {
            return Err(format!("todo: duplicate step \"{content}\""));
        }
        let mut task = TodoTask::pending(content);
        if at < finished {
            task.status = TodoStatus::Completed;
        }
        tasks.push(task);
    }
    let mut list = TodoList {
        phases: vec![TodoPhase { name: DEFAULT_TODO_PHASE.to_owned(), tasks }],
        updated_at_ms: now_ms,
    };
    list.normalize();
    Ok(list)
}

/// The position of the step a 1-based `index` names, counted over the whole list in order.
fn step_index(list: &TodoList, args: &Value) -> Result<usize, String> {
    let total = list.tasks().count();
    args.get("index")
        .and_then(Value::as_u64)
        .and_then(|n| usize::try_from(n).ok())
        .filter(|n| (1..=total).contains(n))
        .map(|n| n - 1)
        .ok_or_else(|| format!("todo: index is a step number from 1 to {total}"))
}

fn summary_line(list: &TodoList, op: &str, content: &str) -> String {
    let mut parts = vec![list.progress_label(), format!("{op}: {content}")];
    match list.tasks().find(|t| t.status == TodoStatus::InProgress) {
        Some(current) => parts.push(format!("next: {}", current.content)),
        None => parts.push("all closed".to_owned()),
    }
    parts.join(" · ")
}

/// Runs one `todo` call against the owner's list. Pure: the caller commits the result.
pub fn run(current: &TodoList, args: &Value, now_ms: i64) -> Result<TodoRun, String> {
    let op = arg_line(args, "op").to_lowercase();
    if !TODO_OPS.contains(&op.as_str()) {
        return Err(format!("todo: op must be one of {}", TODO_OPS.join(", ")));
    }
    if op == "view" {
        return Ok(TodoRun::View(current.render()));
    }
    if op == "set" {
        let list = set_list(args, now_ms)?;
        let reply = list.render();
        return Ok(TodoRun::Commit { list, reply });
    }
    let mut list = current.clone();
    if list.phases.is_empty() {
        return Err("todo: the list is empty; set it first".to_owned());
    }
    let note = arg_line(args, "note");
    let close = |task: &mut TodoTask| {
        task.status = TodoStatus::Completed;
        if !note.is_empty() {
            task.note = Some(note.clone());
        }
        task.content.clone()
    };
    let content = match op.as_str() {
        "advance" => match list.tasks_mut().find(|task| task.status == TodoStatus::InProgress) {
            Some(task) => close(task),
            None => return Err("todo: every step is closed; set a new list for new work".to_owned()),
        },
        "done" => {
            let at = step_index(&list, args)?;
            match list.tasks_mut().nth(at) {
                Some(task) => close(task),
                None => return Err("todo: no such step".to_owned()),
            }
        }
        "drop" => {
            let at = step_index(&list, args)?;
            match list.tasks_mut().nth(at) {
                Some(task) if task.status == TodoStatus::Completed => {
                    return Err(format!("todo: step {} is completed and stays closed", at + 1));
                }
                Some(task) => {
                    task.status = TodoStatus::Abandoned;
                    task.content.clone()
                }
                None => return Err("todo: no such step".to_owned()),
            }
        }
        _ => {
            let at = step_index(&list, args)?;
            if list.tasks().nth(at).is_some_and(|task| task.status == TodoStatus::Completed) {
                return Err(format!("todo: step {} is completed and stays closed", at + 1));
            }
            for task in list.tasks_mut() {
                if task.status == TodoStatus::InProgress {
                    task.status = TodoStatus::Pending;
                }
            }
            match list.tasks_mut().nth(at) {
                Some(task) => {
                    task.status = TodoStatus::InProgress;
                    task.content.clone()
                }
                None => return Err("todo: no such step".to_owned()),
            }
        }
    };
    list.normalize();
    list.updated_at_ms = now_ms;
    let reply = summary_line(&list, &op, &content);
    Ok(TodoRun::Commit { list, reply })
}

/// A list edit: takes the current list for any borrow. (Written as an elided `&TodoList` in the
/// method, `async_trait` lifts it into a lifetime parameter of the method, and an implementor
/// could then hand the edit only a `'static` list.)
/// `adoptLegacyGoalTasks(session, legacyTasks)` (`runtime-core/todo-list.mjs`): the tasks a Goal record written before the
/// todo list still carries, folded into the stored list. An item already listed keeps its state; the adopted ones go
/// under `Goal` beside an existing list, or are the list (`Tasks`) when there was none. The wording stays whole (old
/// tasks allowed longer text). `None` when nothing was adopted. This is the stored list's own fold, not a `todo` call.
pub fn adopt_legacy_goal_tasks(current: &TodoList, legacy: &[Value], now_ms: i64) -> Option<TodoList> {
    let line = |value: Option<&Value>| match value {
        None | Some(Value::Null) => String::new(),
        Some(Value::String(text)) => one_line(text),
        Some(other) => one_line(&mixdog_js::value_to_string(other)),
    };
    let mut existing: Vec<String> = current.tasks().map(|task| task.content.clone()).collect();
    let mut adopted = Vec::new();
    for raw in legacy {
        // `raw?.text ?? raw?.content`.
        let content = line(raw.get("text").filter(|text| !text.is_null()).or_else(|| raw.get("content")));
        if content.is_empty() || existing.contains(&content) {
            continue;
        }
        existing.push(content.clone());
        // `LEGACY_GOAL_TASK_STATUS`; an unknown status (and `awaiting_approval`) is pending.
        let status = match line(raw.get("status")).to_lowercase().as_str() {
            "in_progress" => TodoStatus::InProgress,
            "completed" => TodoStatus::Completed,
            "dropped" => TodoStatus::Abandoned,
            _ => TodoStatus::Pending,
        };
        adopted.push(TodoTask { content, status, note: None });
    }
    if adopted.is_empty() {
        return None;
    }
    let mut list = TodoList { phases: current.phases.clone(), updated_at_ms: now_ms };
    let name = if list.phases.is_empty() { DEFAULT_TODO_PHASE } else { "Goal" };
    match list.phases.iter_mut().find(|phase| phase.name == name) {
        Some(phase) => phase.tasks.extend(adopted),
        None => list.phases.push(TodoPhase { name: name.to_owned(), tasks: adopted }),
    }
    list.normalize();
    Some(list)
}

pub type TodoEdit<'f> = dyn for<'a> FnMut(&'a TodoList) -> Result<TodoList, String> + Send + 'f;

/// The session actor's list store. `update` runs `f` against the current list under the
/// owner's own serialization (two `todo` calls of one turn never lose each other's write) and
/// commits what it returns; `f`'s error leaves the list untouched.
#[async_trait]
pub trait TodoStore: Send + Sync {
    async fn read(&self, thread: &ThreadId) -> TodoList;

    async fn update(
        &self,
        thread: &ThreadId,
        f: &mut TodoEdit<'_>,
    ) -> Result<(), String>;

    /// An `ask_user` question left unanswered: the turn may end waiting on the user.
    fn note_user_wait(&self, thread: &ThreadId);

    /// Whether the thread's current turn waits on the user (`userWaits.has`).
    fn user_waiting(&self, thread: &ThreadId) -> bool;

    /// A turn of the thread starts: its wait on the user ends (`beginTodoTurn`).
    fn turn_started(&self, thread: &ThreadId);
}

pub struct TodoTool {
    spec: ToolSpec,
    store: std::sync::Arc<dyn TodoStore>,
}

impl TodoTool {
    pub fn new(store: std::sync::Arc<dyn TodoStore>) -> Self {
        Self {
            spec: spec_from_def(include_str!("defs/todo.json"), false, &[]),
            store,
        }
    }
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or_default()
}

#[async_trait]
impl Tool for TodoTool {
    fn spec(&self) -> &ToolSpec {
        &self.spec
    }

    async fn call(&self, ctx: &ToolContext, args: JsonValue) -> ToolOutcome {
        let at = now_ms();
        let current = self.store.read(&ctx.thread_id).await;
        // A view never commits; every other op commits through `update` so a concurrent call
        // is applied on top of the list it left, not on the list read above.
        if let Ok(TodoRun::View(reply)) = run(&current, &args, at) {
            return text(reply);
        }
        let mut reply = String::new();
        let mut run_error = None;
        let result = self
            .store
            .update(&ctx.thread_id, &mut |list| match run(list, &args, at) {
                Ok(TodoRun::Commit { list, reply: r }) => {
                    reply = r;
                    Ok(list)
                }
                Ok(TodoRun::View(r)) => {
                    reply = r;
                    Ok(list.clone())
                }
                Err(message) => {
                    run_error = Some(message.clone());
                    Err(message)
                }
            })
            .await;
        match (result, run_error) {
            (Ok(()), _) => text(reply),
            (Err(_), Some(message)) => Err(invalid("op", message)),
            (Err(message), None) => Err(action_failed("todo", message)),
        }
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    /// Node's own `adoptLegacyGoalTasks` over these sessions and legacy tasks (run on `runtime-core/todo-list.mjs`; `phases` is
    /// `session.todo.phases` afterwards, `null` when it answered false).
    const NODE_ADOPTIONS: &str = r#"[{"name":"empty list","todo":null,"legacy":[{"text":"Write  the\nplan","status":"completed"},{"text":"Ship it","status":"in_progress"},{"text":"Tell the user","status":"awaiting_approval"},{"text":"Old idea","status":"dropped"}],"adopted":true,"phases":[{"name":"Tasks","tasks":[{"content":"Write the plan","status":"completed"},{"content":"Ship it","status":"in_progress"},{"content":"Tell the user","status":"pending"},{"content":"Old idea","status":"abandoned"}]}]},{"name":"existing list","todo":{"phases":[{"name":"Tasks","tasks":[{"content":"Ship it","status":"in_progress"},{"content":"Review","status":"pending"}]}],"updatedAt":5},"legacy":[{"text":"Ship it","status":"completed"},{"text":"Deploy","status":"IN_PROGRESS"},{"text":"Deploy","status":"pending"},{"content":"Measure","status":" Pending "},{"text":"","status":"pending"},null,{"text":"Odd","status":"blocked"}],"adopted":true,"phases":[{"name":"Tasks","tasks":[{"content":"Ship it","status":"in_progress"},{"content":"Review","status":"pending"}]},{"name":"Goal","tasks":[{"content":"Deploy","status":"pending"},{"content":"Measure","status":"pending"},{"content":"Odd","status":"pending"}]}]},{"name":"existing Goal phase","todo":{"phases":[{"name":"Goal","tasks":[{"content":"A","status":"completed"}]}],"updatedAt":5},"legacy":[{"text":"B","status":"pending"},{"text":"C","status":"pending"}],"adopted":true,"phases":[{"name":"Goal","tasks":[{"content":"A","status":"completed"},{"content":"B","status":"in_progress"},{"content":"C","status":"pending"}]}]},{"name":"all listed","todo":{"phases":[{"name":"Tasks","tasks":[{"content":"A","status":"completed"}]}],"updatedAt":5},"legacy":[{"text":"A","status":"pending"}],"adopted":false,"phases":null},{"name":"none","todo":null,"legacy":[],"adopted":false,"phases":null},{"name":"all closed","todo":null,"legacy":[{"text":"Done one","status":"completed"},{"text":"Dropped one","status":"dropped"}],"adopted":true,"phases":[{"name":"Tasks","tasks":[{"content":"Done one","status":"completed"},{"content":"Dropped one","status":"abandoned"}]}]}]"#;

    #[test]
    fn a_legacy_goals_tasks_fold_into_the_stored_list_as_node_folds_them() {
        let cases: Vec<Value> = serde_json::from_str(NODE_ADOPTIONS).expect("cases");
        assert_eq!(cases.len(), 6);
        for case in &cases {
            let phases: Vec<TodoPhase> = serde_json::from_value(case["todo"].get("phases").cloned().unwrap_or_else(|| json!([]))).expect("phases");
            let current = TodoList { phases, updated_at_ms: 5 };
            let got = adopt_legacy_goal_tasks(&current, case["legacy"].as_array().expect("legacy"), 9);
            assert_eq!(json!(got.is_some()), case["adopted"], "{}", case["name"]);
            assert_eq!(got.as_ref().map_or(Value::Null, |list| json!(list.phases)), case["phases"], "{}", case["name"]);
            assert!(got.is_none_or(|list| list.updated_at_ms == 9), "{}", case["name"]);
        }
    }

    fn commit(list: &TodoList, args: Value) -> (TodoList, String) {
        match run(list, &args, 7).expect("ok") {
            TodoRun::Commit { list, reply } => (list, reply),
            TodoRun::View(_) => panic!("view"),
        }
    }

    #[test]
    fn set_renders_the_plan_and_starts_its_first_step() {
        let (list, reply) = commit(&TodoList::default(), json!({"op":"set","items":["Read spec","Write code"]}));
        assert_eq!(reply, "0/2\nTasks\n  [>] Read spec\n  [ ] Write code");
        assert_eq!(list.phases.len(), 1);
    }

    #[test]
    fn advance_closes_the_step_in_progress_and_starts_the_next() {
        let (list, _) = commit(&TodoList::default(), json!({"op":"set","items":["A","B"]}));
        let (list, reply) = commit(&list, json!({"op":"advance","note":"ok"}));
        assert_eq!(reply, "1/2 · advance: A · next: B");
        assert_eq!(list.render(), "1/2\nTasks\n  [x] A — ok\n  [>] B");
        let (list, reply) = commit(&list, json!({"op":"advance"}));
        assert_eq!(reply, "2/2 · advance: B · all closed");
        assert_eq!(
            run(&list, &json!({"op":"advance"}), 1).unwrap_err(),
            "todo: every step is closed; set a new list for new work"
        );
    }

    /// A plan that changed is set again, whatever was open: the steps already finished are counted, not repeated.
    #[test]
    fn set_replaces_a_list_with_open_steps() {
        let (list, _) = commit(&TodoList::default(), json!({"op":"set","items":["A","B","C"]}));
        let (list, _) = commit(&list, json!({"op":"advance"}));
        let (list, reply) = commit(&list, json!({"op":"set","items":["A","B2","D"],"done":1}));
        assert_eq!(reply, "1/3\nTasks\n  [x] A\n  [>] B2\n  [ ] D");
        assert_eq!(list.open_items().len(), 2);
    }

    #[test]
    fn done_and_start_take_a_step_number() {
        let (list, _) = commit(&TodoList::default(), json!({"op":"set","items":["A","B","C"]}));
        let (list, reply) = commit(&list, json!({"op":"done","index":2}));
        assert_eq!(reply, "1/3 · done: B · next: A");
        let (list, reply) = commit(&list, json!({"op":"start","index":3}));
        assert_eq!(reply, "1/3 · start: C · next: C");
        assert_eq!(list.render(), "1/3\nTasks\n  [ ] A\n  [x] B\n  [>] C");
        assert_eq!(
            run(&list, &json!({"op":"start","index":2}), 1).unwrap_err(),
            "todo: step 2 is completed and stays closed"
        );
        // A step given up leaves the count; the pointer goes back to the earliest open one.
        let (list, reply) = commit(&list, json!({"op":"drop","index":3}));
        assert_eq!(reply, "1/2 · drop: C · next: A");
        assert_eq!(list.render(), "1/2
Tasks
  [>] A
  [x] B
  [-] C");
    }

    #[test]
    fn refusals_say_what_to_send() {
        assert_eq!(
            run(&TodoList::default(), &json!({"op":"advance"}), 1).unwrap_err(),
            "todo: the list is empty; set it first"
        );
        assert_eq!(run(&TodoList::default(), &json!({"op":"set"}), 1).unwrap_err(), "todo: set requires items");
        assert_eq!(
            run(&TodoList::default(), &json!({"op":"set","items":["A","A"]}), 1).unwrap_err(),
            "todo: duplicate step \"A\""
        );
        let many: Vec<String> = (0..=MAX_TODO_ITEMS).map(|n| format!("step {n}")).collect();
        assert_eq!(run(&TodoList::default(), &json!({"op":"set","items":many}), 1).unwrap_err(), "todo: at most 15 steps");
        let (list, _) = commit(&TodoList::default(), json!({"op":"set","items":["A"]}));
        assert_eq!(run(&list, &json!({"op":"done","index":2}), 1).unwrap_err(), "todo: index is a step number from 1 to 1");
        assert_eq!(run(&list, &json!({"op":"done"}), 1).unwrap_err(), "todo: index is a step number from 1 to 1");
        assert_eq!(
            run(&list, &json!({"op":"init","items":["B"]}), 1).unwrap_err(),
            "todo: op must be one of set, advance, done, start, drop, view"
        );
        assert_eq!(run(&TodoList::default(), &json!({"op":"view"}), 1), Ok(TodoRun::View("todo: empty".to_owned())));
    }

    /// A list stored by an earlier version (named phases) is still numbered through, in order.
    #[test]
    fn a_list_of_several_phases_is_numbered_through() {
        let stored = TodoList {
            phases: vec![
                TodoPhase {
                    name: "P1".to_owned(),
                    tasks: vec![TodoTask { content: "a".to_owned(), status: TodoStatus::Completed, note: None }],
                },
                TodoPhase {
                    name: "P2".to_owned(),
                    tasks: vec![TodoTask::pending("b".to_owned()), TodoTask::pending("c".to_owned())],
                },
            ],
            updated_at_ms: 1,
        };
        let (_, reply) = commit(&stored, json!({"op":"done","index":3}));
        assert_eq!(reply, "2/3 · done: c · next: b");
    }
}
