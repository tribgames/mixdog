//! The pure normalizers of a session's todo list: what the session header's `todo` record holds,
//! as `todoPhases(session)` reads it (`runtime-core/todo-list.mjs`).

use mixdog_store::schema::record::Header;
use mixdog_tools::state::todo::{TodoList, TodoPhase, TodoStatus, TodoTask};
use serde_json::Value;

pub const DEFAULT_TODO_PHASE: &str = "Tasks";

/// `oneLine`: `String(value ?? '').replace(/\s+/g, ' ').trim()`.
pub fn one_line(value: Option<&Value>) -> String {
    let text = match value {
        None | Some(Value::Null) => String::new(),
        Some(other) => mixdog_js::value_to_string(other),
    };
    text.split(mixdog_js::is_js_space).filter(|part| !part.is_empty()).collect::<Vec<_>>().join(" ")
}

/// `normalizeTask`: a stored status outside the four loads as pending (a `blocked` item of an
/// older release), a blank note is no note.
pub fn task_of(raw: &Value) -> Option<TodoTask> {
    let content = one_line(raw.get("content"));
    if content.is_empty() {
        return None;
    }
    let status = match raw.get("status").and_then(Value::as_str) {
        Some("in_progress") => TodoStatus::InProgress,
        Some("completed") => TodoStatus::Completed,
        Some("abandoned") => TodoStatus::Abandoned,
        _ => TodoStatus::Pending,
    };
    let note = Some(one_line(raw.get("note"))).filter(|note| !note.is_empty());
    Some(TodoTask { content, status, note })
}

/// `todoPhases(session)`, with the record's `updatedAt`.
pub fn list_of(header: &Header) -> TodoList {
    let record = header.get("todo");
    let phases = record
        .and_then(|todo| todo.get("phases"))
        .and_then(Value::as_array)
        .map(|phases| {
            phases
                .iter()
                .map(|phase| {
                    let name = one_line(phase.get("name"));
                    let tasks = phase.get("tasks").and_then(Value::as_array).map(|tasks| tasks.iter().filter_map(task_of).collect()).unwrap_or_default();
                    TodoPhase { name: if name.is_empty() { DEFAULT_TODO_PHASE.to_owned() } else { name }, tasks }
                })
                .filter(|phase: &TodoPhase| !phase.tasks.is_empty())
                .collect()
        })
        .unwrap_or_default();
    let updated_at_ms = record.and_then(|todo| todo.get("updatedAt")).map_or(0.0, |at| mixdog_js::to_number(at));
    TodoList { phases, updated_at_ms: if updated_at_ms.is_finite() { updated_at_ms as i64 } else { 0 } }
}

/// `todoSnapshot(session)`: what the session state's `todo` holds, `{ phases, completed, abandoned, total }`;
/// `None` for an empty list.
pub fn snapshot_of(header: &Header) -> Option<Value> {
    let phases = list_of(header).phases;
    if phases.is_empty() {
        return None;
    }
    let count = |status: TodoStatus| phases.iter().flat_map(|phase| phase.tasks.iter()).filter(|task| task.status == status).count();
    let total: usize = phases.iter().map(|phase| phase.tasks.len()).sum();
    Some(serde_json::json!({
        "phases": phases,
        "completed": count(TodoStatus::Completed),
        "abandoned": count(TodoStatus::Abandoned),
        "total": total,
    }))
}
