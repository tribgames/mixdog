//! The real [`TodoStore`]: the session's list, kept on the session header as Node keeps it on the
//! session record (`session.todo = { phases, updatedAt }`, `runtime-core/todo-list.mjs`).
//!
//! Reads normalize what is stored the way `todoPhases` does (the stored record is untrusted);
//! an update computes its list from the header and commits `todo` and `updatedAt` as one header
//! change the session actor applies only while `todo` is still what the list was computed from
//! (the actor is the owner, as Node's synchronous session update is), so two `todo` calls never
//! lose each other's write: the loser computes again from the winner's list.
//! A thread's wait on the user (`noteTodoUserWait`) is in memory like Node's: the turn itself is.

use mixdog_core_ports::ports::todo_list::list_of;
use std::collections::HashSet;
use std::sync::{Arc, Mutex, PoisonError};

use async_trait::async_trait;
use mixdog_core_api::ids::ThreadId;
use mixdog_tools::state::todo::{TodoEdit, TodoList, TodoStore};
use serde_json::{Map, Value, json};

use mixdog_core_ports::ports::threads::ThreadState;
use mixdog_core_run::run_host::hop_host::port_message;
use mixdog_core_session::session::Clock;

pub struct ThreadTodos {
    threads: Arc<dyn ThreadState>,
    clock: Arc<dyn Clock>,
    /// Threads whose current turn waits on the user's decision.
    waits: Mutex<HashSet<ThreadId>>,
}

impl ThreadTodos {
    pub fn new(threads: Arc<dyn ThreadState>, clock: Arc<dyn Clock>) -> Self {
        Self { threads, clock, waits: Mutex::default() }
    }
}

#[async_trait]
impl TodoStore for ThreadTodos {
    /// A thread that cannot be read has no list.
    async fn read(&self, thread: &ThreadId) -> TodoList {
        self.threads.header(thread).await.map(|header| list_of(&header)).unwrap_or_default()
    }

    async fn update(&self, thread: &ThreadId, f: &mut TodoEdit<'_>) -> Result<(), String> {
        let mut header = self.threads.header(thread).await.map_err(|error| port_message(&error))?;
        loop {
            let seen = header.get("todo").cloned().unwrap_or(Value::Null);
            let next = f(&list_of(&header))?;
            // `clearTodo` leaves `todo: null`; every commit stamps the session's `updatedAt` with its own.
            let at = if next.updated_at_ms > 0 { next.updated_at_ms } else { self.clock.now_ms() };
            let mut set = Map::new();
            let todo = if next.phases.is_empty() { Value::Null } else { json!({ "phases": next.phases, "updatedAt": at }) };
            set.insert("todo".into(), todo);
            set.insert("updatedAt".into(), json!(at));
            let expect = Map::from_iter([("todo".to_owned(), seen)]);
            // A refusal: another edit (or a header read behind the actor's) moved `todo`; compute again from it.
            match self.threads.patch_header_if(thread, expect, set, Vec::new()).await.map_err(|error| port_message(&error))? {
                None => return Ok(()),
                Some(mut current) => match current.shift_remove("todo") {
                    Some(todo) if !todo.is_null() => header.insert("todo".into(), todo),
                    _ => header.shift_remove("todo"),
                },
            };
        }
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
    use mixdog_tools::state::todo::{TodoPhase, TodoStatus, TodoTask};
    use mixdog_core_session::session::thread_state::SessionThreads;
    use mixdog_core_session::session::SessionDirectory;

    fn obj(value: Value) -> Map<String, Value> {
        value.as_object().cloned().unwrap()
    }

    async fn store(header: Value) -> (ThreadTodos, Arc<dyn ThreadState>, ThreadId, mixdog_core_session::session::testing::Rig) {
        let rig = mixdog_core_session::session::testing::Rig::new();
        let directory = Arc::new(SessionDirectory::new(rig.deps()));
        let thread = ThreadId::from("sess_todo");
        directory.create_with_id(thread.clone(), obj(header), json!({})).await.expect("create");
        let threads: Arc<dyn ThreadState> = Arc::new(SessionThreads::new(directory));
        (ThreadTodos::new(threads.clone(), rig.clock.clone()), threads, thread, rig)
    }

    fn golden() -> Value {
        let path = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/todo-list/golden.json");
        let bytes = mixdog_statefile::read_content(&path).expect("read golden.json").expect("golden.json exists");
        serde_json::from_slice(&bytes).expect("golden.json parses")
    }

    /// `todoPhases`: a stored record is untrusted. Every case is Node's own `todoPhases` over the
    /// same stored record (`fixtures/todo-list/golden.json`, recorded by `record-todo-list.mjs`).
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_stored_list_reads_as_node_normalizes_it() {
        let golden = golden();
        let cases = golden["reads"].as_array().expect("reads");
        assert!(cases.len() >= 7);
        for case in cases {
            let record = case["todo"].clone();
            let (todos, _, thread, _rig) = store(json!({ "todo": record })).await;
            let list = todos.read(&thread).await;
            assert_eq!(json!(list.phases), case["phases"], "{}", case["name"]);
            if let Some(at) = record.get("updatedAt").and_then(Value::as_i64) {
                assert_eq!(list.updated_at_ms, at, "{}", case["name"]);
            }
        }
    }

    /// The tool's operations through the production `run` and `ThreadTodos::update` over `SessionThreads`: a commit
    /// leaves the list and the session's `updatedAt` at the call's time, a refusal leaves the header as it was. (Node's
    /// recorded operations were `init`/`append`/`rm` by item wording; the tool is now `set`/`advance` and step numbers,
    /// so the cases are this tool's own. What a stored list reads as, and a cleared one, are still Node's, above and
    /// below.)
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn every_operation_commits_the_record_or_leaves_it() {
        let golden = golden();
        let at = golden["at"].as_i64().expect("at");
        let two = json!({ "phases": [{ "name": "Tasks", "tasks": [{ "content": "A", "status": "in_progress" }, { "content": "B", "status": "pending" }] }], "updatedAt": 5 });
        let cases = [
            ("set from nothing", Value::Null, json!({ "op": "set", "items": ["A", "B"] }), Ok("0/2\nTasks\n  [>] A\n  [ ] B")),
            ("set over open steps", two.clone(), json!({ "op": "set", "items": ["A", "C"], "done": 1 }), Ok("1/2\nTasks\n  [x] A\n  [>] C")),
            ("advance", two.clone(), json!({ "op": "advance", "note": "ok" }), Ok("1/2 · advance: A · next: B")),
            ("done by number", two.clone(), json!({ "op": "done", "index": 2 }), Ok("1/2 · done: B · next: A")),
            ("start by number", two.clone(), json!({ "op": "start", "index": 2 }), Ok("0/2 · start: B · next: B")),
            ("drop by number", two.clone(), json!({ "op": "drop", "index": 2 }), Ok("0/1 · drop: B · next: A")),
            ("advance with no list", Value::Null, json!({ "op": "advance" }), Err("todo: the list is empty; set it first")),
            ("a number past the list", two.clone(), json!({ "op": "done", "index": 3 }), Err("todo: index is a step number from 1 to 2")),
            ("an operation of the earlier tool", two.clone(), json!({ "op": "init", "items": ["Z"] }), Err("todo: op must be one of set, advance, done, start, drop, view")),
        ];
        for (name, before_todo, args, want) in cases {
            let (todos, threads, thread, _rig) = store(json!({ "todo": before_todo, "updatedAt": 1 })).await;
            let before = threads.header(&thread).await.expect("header");
            let mut reply = None;
            let result = todos
                .update(&thread, &mut |list| match mixdog_tools::state::todo::run(list, &args, at) {
                    Ok(mixdog_tools::state::todo::TodoRun::Commit { list, reply: r }) => {
                        reply = Some(r);
                        Ok(list)
                    }
                    Ok(mixdog_tools::state::todo::TodoRun::View(r)) => {
                        reply = Some(r);
                        Ok(list.clone())
                    }
                    Err(message) => Err(message),
                })
                .await;
            let header = threads.header(&thread).await.expect("header");
            match (want, result) {
                (Err(want), Err(got)) => {
                    assert_eq!(got, want, "{name}");
                    // Nothing moved: not the list, not the session's time.
                    assert_eq!((header.get("todo"), header.get("updatedAt")), (before.get("todo"), before.get("updatedAt")), "{name}");
                }
                (Ok(want), Ok(())) => {
                    assert_eq!(reply.as_deref(), Some(want), "{name}");
                    assert_eq!((&header["todo"]["updatedAt"], &header["updatedAt"]), (&json!(at), &json!(at)), "{name}");
                    assert_eq!(mixdog_core_ports::ports::todo_list::list_of(&header).render(), todos.read(&thread).await.render(), "{name}");
                }
                (want, got) => panic!("{name}: wanted {want:?}, got {got:?}"),
            }
        }
        let cleared = &golden["cleared"];
        let (todos, threads, thread, rig) = store(json!({ "todo": cleared["before"] })).await;
        // Node stamps the clear from its clock, frozen at `at` in the recording: drive ours to it.
        rig.clock.0.store(at as u64, std::sync::atomic::Ordering::SeqCst);
        todos.update(&thread, &mut |_| Ok(TodoList::default())).await.expect("clear");
        let header = threads.header(&thread).await.expect("header");
        assert_eq!((&header["todo"], &header["updatedAt"]), (&cleared["after"]["todo"], &cleared["after"]["updatedAt"]));
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

    /// Node updates the session synchronously, so edits made at once all land: each one is
    /// computed from the list the one before left.
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn edits_made_at_once_all_land() {
        let (todos, threads, thread, _rig) = store(json!({})).await;
        let add = |content: String| {
            let todos = &todos;
            let thread = &thread;
            async move {
                todos
                    .update(thread, &mut |current| {
                        let mut next = current.clone();
                        if next.phases.is_empty() {
                            next.phases.push(TodoPhase { name: "Tasks".into(), tasks: Vec::new() });
                        }
                        next.phases[0].tasks.push(TodoTask { content: content.clone(), status: TodoStatus::Pending, note: None });
                        next.updated_at_ms = 0;
                        Ok(next)
                    })
                    .await
            }
        };
        let results = futures::future::join_all((0..8).map(|n| add(format!("t{n}")))).await;
        assert!(results.iter().all(Result::is_ok));
        let mut seen: Vec<String> = todos.read(&thread).await.phases[0].tasks.iter().map(|task| task.content.clone()).collect();
        seen.sort();
        assert_eq!(seen, (0..8).map(|n| format!("t{n}")).collect::<Vec<_>>());
        assert_eq!(threads.header(&thread).await.expect("header")["todo"]["phases"][0]["tasks"].as_array().map(Vec::len), Some(8));
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
