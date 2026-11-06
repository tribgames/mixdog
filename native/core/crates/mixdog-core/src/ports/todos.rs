//! The real [`TodoStore`]: the session's list, kept on the session header as Node keeps it on the
//! session record (`session.todo = { phases, updatedAt }`, `runtime-core/todo-list.mjs`).
//!
//! Reads normalize what is stored the way `todoPhases` does (the stored record is untrusted);
//! an update runs against the list read under the thread's own lock, so two `todo` calls of one
//! turn never lose each other's write, and commits `todo` and `updatedAt` as one header change.
//! A thread's wait on the user (`noteTodoUserWait`) is in memory like Node's: the turn itself is.

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex, PoisonError};

use async_trait::async_trait;
use mixdog_core_api::ids::ThreadId;
use mixdog_store::schema::record::Header;
use mixdog_tools::state::todo::{TodoEdit, TodoList, TodoPhase, TodoStatus, TodoStore, TodoTask};
use serde_json::{Map, Value, json};
use tokio::sync::Mutex as AsyncMutex;

use super::threads::ThreadState;
use crate::run_host::hop_host::port_message;
use crate::session::Clock;

const DEFAULT_TODO_PHASE: &str = "Tasks";

pub struct ThreadTodos {
    threads: Arc<dyn ThreadState>,
    clock: Arc<dyn Clock>,
    /// One lock per thread that has updated its list; a thread never waits on another's.
    locks: Mutex<HashMap<ThreadId, Arc<AsyncMutex<()>>>>,
    /// Threads whose current turn waits on the user's decision.
    waits: Mutex<HashSet<ThreadId>>,
}

impl ThreadTodos {
    pub fn new(threads: Arc<dyn ThreadState>, clock: Arc<dyn Clock>) -> Self {
        Self { threads, clock, locks: Mutex::default(), waits: Mutex::default() }
    }

    fn lock_of(&self, thread: &ThreadId) -> Arc<AsyncMutex<()>> {
        self.locks.lock().unwrap_or_else(PoisonError::into_inner).entry(thread.clone()).or_default().clone()
    }
}

/// `oneLine`: `String(value ?? '').replace(/\s+/g, ' ').trim()`.
fn one_line(value: Option<&Value>) -> String {
    let text = match value {
        None | Some(Value::Null) => String::new(),
        Some(other) => mixdog_js::value_to_string(other),
    };
    text.split(mixdog_js::is_js_space).filter(|part| !part.is_empty()).collect::<Vec<_>>().join(" ")
}

/// `normalizeTask`: a stored status outside the four loads as pending (a `blocked` item of an
/// older release), a blank note is no note.
fn task_of(raw: &Value) -> Option<TodoTask> {
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
fn list_of(header: &Header) -> TodoList {
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

#[async_trait]
impl TodoStore for ThreadTodos {
    /// A thread that cannot be read has no list.
    async fn read(&self, thread: &ThreadId) -> TodoList {
        self.threads.header(thread).await.map(|header| list_of(&header)).unwrap_or_default()
    }

    async fn update(&self, thread: &ThreadId, f: &mut TodoEdit<'_>) -> Result<(), String> {
        let lock = self.lock_of(thread);
        let _held = lock.lock().await;
        let header = self.threads.header(thread).await.map_err(|error| port_message(&error))?;
        let next = f(&list_of(&header))?;
        // `clearTodo` leaves `todo: null`; every commit stamps the session's `updatedAt` with its own.
        let at = if next.updated_at_ms > 0 { next.updated_at_ms } else { self.clock.now_ms() };
        let mut set = Map::new();
        let todo = if next.phases.is_empty() { Value::Null } else { json!({ "phases": next.phases, "updatedAt": at }) };
        set.insert("todo".into(), todo);
        set.insert("updatedAt".into(), json!(at));
        self.threads.patch_header(thread, set, Vec::new()).await.map_err(|error| port_message(&error))
    }

    fn note_user_wait(&self, thread: &ThreadId) {
        self.waits.lock().unwrap_or_else(PoisonError::into_inner).insert(thread.clone());
    }

    fn user_waiting(&self, thread: &ThreadId) -> bool {
        self.waits.lock().unwrap_or_else(PoisonError::into_inner).contains(thread)
    }

    /// `beginTodoTurn`: a new turn clears the wait.
    fn turn_started(&self, thread: &ThreadId) {
        self.waits.lock().unwrap_or_else(PoisonError::into_inner).remove(thread);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ports::threads::SessionThreads;
    use crate::session::SessionDirectory;

    fn obj(value: Value) -> Map<String, Value> {
        value.as_object().cloned().unwrap()
    }

    async fn store(header: Value) -> (ThreadTodos, Arc<dyn ThreadState>, ThreadId, crate::session::testing::Rig) {
        let rig = crate::session::testing::Rig::new();
        let directory = Arc::new(SessionDirectory::new(rig.deps()));
        let thread = ThreadId::from("sess_todo");
        directory.create_with_id(thread.clone(), obj(header), json!({})).await.expect("create");
        let threads: Arc<dyn ThreadState> = Arc::new(SessionThreads::new(directory));
        (ThreadTodos::new(threads.clone(), rig.clock.clone()), threads, thread, rig)
    }

    /// `todoPhases`: a stored record is untrusted. The cases are run through Node's
    /// `todoSnapshot` (todo-list.mjs): whitespace runs fold, a blank phase name is `Tasks`, an
    /// unknown status (a stored `blocked`) is pending with its extra keys gone, a task without
    /// wording and a phase without tasks leave.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_stored_list_reads_as_node_normalizes_it() {
        let (todos, _, thread, _rig) = store(json!({
            "todo": { "updatedAt": 41, "phases": [
                { "name": "  Build \n step ", "tasks": [
                    { "content": " Write\t the  code ", "status": "blocked", "blocker": "waiting" },
                    { "content": "Ship", "status": "completed", "note": "  all\n done " },
                    { "content": "   ", "status": "pending" },
                    { "status": "pending" },
                    "stray",
                ] },
                { "name": "", "tasks": [{ "content": "Loose", "status": "in_progress", "note": " " }] },
                { "name": "Empty", "tasks": [] },
                { "name": "Bad" },
            ] },
        }))
        .await;
        let list = todos.read(&thread).await;
        assert_eq!(
            json!(list.phases),
            json!([
                { "name": "Build step", "tasks": [
                    { "content": "Write the code", "status": "pending" },
                    { "content": "Ship", "status": "completed", "note": "all done" },
                ] },
                { "name": "Tasks", "tasks": [{ "content": "Loose", "status": "in_progress" }] },
            ])
        );
        assert_eq!(list.updated_at_ms, 41);
    }

    /// `commitPhases` / `clearTodo`: `session.todo = { phases, updatedAt }` with the session's
    /// `updatedAt` set beside it; a cleared list is `todo: null`.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn an_update_commits_the_record_and_a_cleared_list_is_null() {
        let (todos, threads, thread, rig) = store(json!({})).await;
        assert!(todos.read(&thread).await.phases.is_empty());
        let written = TodoList {
            phases: vec![TodoPhase {
                name: "Tasks".into(),
                tasks: vec![TodoTask { content: "A".into(), status: TodoStatus::InProgress, note: None }],
            }],
            updated_at_ms: 777,
        };
        let sent = written.clone();
        todos.update(&thread, &mut |_| Ok(sent.clone())).await.expect("update");
        let header = threads.header(&thread).await.expect("header");
        assert_eq!(header["todo"], json!({ "phases": [{ "name": "Tasks", "tasks": [{ "content": "A", "status": "in_progress" }] }], "updatedAt": 777 }));
        assert_eq!(header["updatedAt"], json!(777));
        assert_eq!(todos.read(&thread).await, written);
        todos.update(&thread, &mut |_| Ok(TodoList::default())).await.expect("clear");
        let header = threads.header(&thread).await.expect("header");
        assert_eq!((header["todo"].clone(), header["updatedAt"].clone()), (Value::Null, json!(rig.clock.now_ms())));
        assert!(todos.read(&thread).await.phases.is_empty());
    }

    /// An edit that refuses leaves the list as it was; the next edit sees the one before it.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_refused_edit_changes_nothing_and_edits_apply_in_turn() {
        let (todos, threads, thread, _rig) = store(json!({})).await;
        let one = |content: &str| TodoList {
            phases: vec![TodoPhase { name: "Tasks".into(), tasks: vec![TodoTask { content: content.into(), status: TodoStatus::Pending, note: None }] }],
            updated_at_ms: 5,
        };
        let first = one("first");
        todos.update(&thread, &mut |_| Ok(first.clone())).await.expect("first");
        assert_eq!(todos.update(&thread, &mut |_| Err("todo: no item".into())).await, Err("todo: no item".to_owned()));
        let mut seen = Vec::new();
        let second = one("second");
        todos
            .update(&thread, &mut |current| {
                seen.push(current.phases[0].tasks[0].content.clone());
                Ok(second.clone())
            })
            .await
            .expect("second");
        assert_eq!(seen, ["first"]);
        assert_eq!(threads.header(&thread).await.expect("header")["todo"]["phases"][0]["tasks"][0]["content"], "second");
    }

    /// `noteTodoUserWait` / `beginTodoTurn`: the wait lasts until the next turn starts.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_wait_on_the_user_ends_when_the_next_turn_starts() {
        let (todos, _, thread, _rig) = store(json!({})).await;
        assert!(!todos.user_waiting(&thread));
        todos.note_user_wait(&thread);
        assert!(todos.user_waiting(&thread));
        assert!(!todos.user_waiting(&ThreadId::from("other")));
        todos.turn_started(&thread);
        assert!(!todos.user_waiting(&thread));
    }
}
