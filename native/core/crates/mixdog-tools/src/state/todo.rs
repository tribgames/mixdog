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

pub const TODO_OPS: [&str; 7] = ["init", "start", "done", "drop", "append", "rm", "view"];
pub const MAX_TODO_ITEMS: usize = 50;
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

    /// The whole list as text: init/view replies and context re-injection.
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

fn init_phases(args: &Value) -> Result<Vec<TodoPhase>, String> {
    let named: Vec<(Value, Vec<Value>)> = match (args.get("phases"), args.get("items")) {
        (Some(Value::Array(phases)), _) if !phases.is_empty() => phases
            .iter()
            .map(|entry| {
                let items = entry.get("items").and_then(Value::as_array).cloned().unwrap_or_default();
                (entry.get("name").cloned().unwrap_or(Value::Null), items)
            })
            .collect(),
        (_, Some(Value::Array(items))) if !items.is_empty() => {
            let phase = arg_line(args, "phase");
            let name = if phase.is_empty() { DEFAULT_TODO_PHASE.to_owned() } else { phase };
            vec![(Value::String(name), items.clone())]
        }
        _ => return Err("todo: init requires items or phases".to_owned()),
    };
    let mut seen = HashSet::new();
    let mut phase_names = HashSet::new();
    let mut phases = Vec::with_capacity(named.len());
    for (raw_name, items) in named {
        let name = item_text(&raw_name, "phase")?;
        if !phase_names.insert(name.clone()) {
            return Err(format!("todo: duplicate phase \"{name}\""));
        }
        if items.is_empty() {
            return Err(format!("todo: phase \"{name}\" has no items"));
        }
        let mut tasks = Vec::with_capacity(items.len());
        for raw in &items {
            let content = item_text(raw, "item")?;
            if !seen.insert(content.clone()) {
                return Err(format!("todo: duplicate item \"{content}\""));
            }
            tasks.push(TodoTask::pending(content));
        }
        phases.push(TodoPhase { name, tasks });
    }
    if seen.len() > MAX_TODO_ITEMS {
        return Err(format!("todo: at most {MAX_TODO_ITEMS} items"));
    }
    Ok(phases)
}

fn find_task(list: &TodoList, raw: &str) -> Result<(usize, usize), String> {
    let content = one_line(raw);
    if content.is_empty() {
        return Err("todo: item (its exact wording) is required".to_owned());
    }
    for (p, phase) in list.phases.iter().enumerate() {
        if let Some(t) = phase.tasks.iter().position(|task| task.content == content) {
            return Ok((p, t));
        }
    }
    Err(format!("todo: no item \"{content}\"; view the list for exact wordings"))
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
    if op == "init" {
        // Replacing a list that still has unfinished work would silently erase it.
        let unfinished = current.unfinished_items();
        if !unfinished.is_empty() {
            let mut named: Vec<String> =
                unfinished.iter().take(5).map(|t| format!("\"{}\"", t.content)).collect();
            if unfinished.len() > named.len() {
                named.push(format!("{} more", unfinished.len() - named.len()));
            }
            return Err(format!(
                "todo: init would erase unfinished items ({}); done or drop each first, or append to add asks",
                named.join(", ")
            ));
        }
        let mut list = TodoList {
            phases: init_phases(args)?,
            updated_at_ms: now_ms,
        };
        list.normalize();
        let reply = list.render();
        return Ok(TodoRun::Commit { list, reply });
    }
    let mut list = current.clone();
    if list.phases.is_empty() {
        return Err("todo: the list is empty; init it first".to_owned());
    }
    let content = match op.as_str() {
        "start" => {
            let (p, t) = find_task(&list, &arg_line(args, "item"))?;
            if list.phases[p].tasks[t].status == TodoStatus::Completed {
                return Err(format!("todo: \"{}\" is completed and stays closed", list.phases[p].tasks[t].content));
            }
            for task in list.tasks_mut() {
                if task.status == TodoStatus::InProgress {
                    task.status = TodoStatus::Pending;
                }
            }
            list.phases[p].tasks[t].status = TodoStatus::InProgress;
            list.phases[p].tasks[t].content.clone()
        }
        "done" => {
            let (p, t) = find_task(&list, &arg_line(args, "item"))?;
            let note = arg_line(args, "note");
            let task = &mut list.phases[p].tasks[t];
            task.status = TodoStatus::Completed;
            if !note.is_empty() {
                task.note = Some(note);
            }
            task.content.clone()
        }
        "drop" => {
            let (p, t) = find_task(&list, &arg_line(args, "item"))?;
            let task = &mut list.phases[p].tasks[t];
            if task.status == TodoStatus::Completed {
                return Err(format!("todo: \"{}\" is completed and stays closed", task.content));
            }
            task.status = TodoStatus::Abandoned;
            task.content.clone()
        }
        "append" => append_items(&mut list, args)?,
        _ => {
            let (p, t) = find_task(&list, &arg_line(args, "item"))?;
            list.phases[p].tasks.remove(t).content
        }
    };
    list.normalize();
    list.updated_at_ms = now_ms;
    let reply = summary_line(&list, &op, &content);
    Ok(TodoRun::Commit { list, reply })
}

fn append_items(list: &mut TodoList, args: &Value) -> Result<String, String> {
    let items = match args.get("items") {
        Some(Value::Array(items)) => items.iter().map(|raw| item_text(raw, "item")).collect::<Result<Vec<_>, _>>()?,
        _ => Vec::new(),
    };
    if items.is_empty() {
        return Err("todo: append requires items".to_owned());
    }
    let mut existing: HashSet<String> = list.tasks().map(|t| t.content.clone()).collect();
    for content in &items {
        if !existing.insert(content.clone()) {
            return Err(format!("todo: item \"{content}\" already exists"));
        }
    }
    if existing.len() > MAX_TODO_ITEMS {
        return Err(format!("todo: at most {MAX_TODO_ITEMS} items"));
    }
    let requested = arg_line(args, "phase");
    let name = if !requested.is_empty() {
        requested
    } else {
        list.phases.last().map(|p| p.name.clone()).unwrap_or_else(|| DEFAULT_TODO_PHASE.to_owned())
    };
    let index = match list.phases.iter().position(|p| p.name == name) {
        Some(index) => index,
        None => {
            list.phases.push(TodoPhase { name, tasks: Vec::new() });
            list.phases.len() - 1
        }
    };
    list.phases[index].tasks.extend(items.iter().cloned().map(TodoTask::pending));
    Ok(items.join(", "))
}

/// The session actor's list store. `update` runs `f` against the current list under the
/// owner's own serialization (two `todo` calls of one turn never lose each other's write) and
/// commits what it returns; `f`'s error leaves the list untouched.
#[async_trait]
pub trait TodoStore: Send + Sync {
    async fn read(&self, thread: &ThreadId) -> TodoList;

    async fn update(
        &self,
        thread: &ThreadId,
        f: &mut (dyn FnMut(&TodoList) -> Result<TodoList, String> + Send),
    ) -> Result<(), String>;

    /// An `ask_user` question left unanswered: the turn may end waiting on the user.
    fn note_user_wait(&self, thread: &ThreadId);
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

    fn commit(list: &TodoList, args: Value) -> (TodoList, String) {
        match run(list, &args, 7).expect("ok") {
            TodoRun::Commit { list, reply } => (list, reply),
            TodoRun::View(_) => panic!("view"),
        }
    }

    #[test]
    fn init_renders_progress_and_starts_first_item() {
        let (list, reply) = commit(
            &TodoList::default(),
            json!({"op":"init","items":["Read spec","Write code"]}),
        );
        assert_eq!(reply, "0/2\nTasks\n  [>] Read spec\n  [ ] Write code");
        assert_eq!(list.phases.len(), 1);
    }

    #[test]
    fn done_moves_the_pointer_and_summarizes() {
        let (list, _) = commit(&TodoList::default(), json!({"op":"init","items":["A","B"]}));
        let (list, reply) = commit(&list, json!({"op":"done","item":"A","note":"ok"}));
        assert_eq!(reply, "1/2 · done: A · next: B");
        assert_eq!(list.render(), "1/2\nTasks\n  [x] A — ok\n  [>] B");
        let (_, reply) = commit(&list, json!({"op":"done","item":"B"}));
        assert_eq!(reply, "2/2 · done: B · all closed");
    }

    #[test]
    fn init_refuses_to_erase_unfinished_work() {
        let (list, _) = commit(&TodoList::default(), json!({"op":"init","items":["A"]}));
        let error = run(&list, &json!({"op":"init","items":["B"]}), 1).unwrap_err();
        assert_eq!(
            error,
            "todo: init would erase unfinished items (\"A\"); done or drop each first, or append to add asks"
        );
    }

    #[test]
    fn errors_use_the_existing_wordings() {
        assert_eq!(
            run(&TodoList::default(), &json!({"op":"start","item":"x"}), 1).unwrap_err(),
            "todo: the list is empty; init it first"
        );
        let (list, _) = commit(&TodoList::default(), json!({"op":"init","items":["A"]}));
        assert_eq!(
            run(&list, &json!({"op":"done","item":"Z"}), 1).unwrap_err(),
            "todo: no item \"Z\"; view the list for exact wordings"
        );
        let (list, _) = commit(&list, json!({"op":"done","item":"A"}));
        assert_eq!(
            run(&list, &json!({"op":"drop","item":"A"}), 1).unwrap_err(),
            "todo: \"A\" is completed and stays closed"
        );
        assert_eq!(
            run(&TodoList::default(), &json!({"op":"view"}), 1),
            Ok(TodoRun::View("todo: empty".to_owned()))
        );
    }

    #[test]
    fn append_adds_to_the_last_phase_and_rm_removes() {
        let (list, _) = commit(&TodoList::default(), json!({"op":"init","items":["A"]}));
        let (list, reply) = commit(&list, json!({"op":"append","items":["B","C"],"phase":"More"}));
        assert_eq!(reply, "0/3 · append: B, C · next: A");
        assert_eq!(list.phases[1].name, "More");
        let (_, reply) = commit(&list, json!({"op":"rm","item":"B"}));
        assert_eq!(reply, "0/2 · rm: B · next: A");
    }
}
