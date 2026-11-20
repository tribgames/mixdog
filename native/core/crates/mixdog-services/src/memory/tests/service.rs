//! The recall composition (which source answers, in which order, with which
//! arguments) against the Node product, and the PG-backed memory module
//! against the recall goldens.

use std::collections::VecDeque;
use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use mixdog_core_api::call::CallContext;
use mixdog_core_api::ids::Method;
use mixdog_core_api::{CoreRequest, DomainService, Reply};
use serde_json::{Value, json};

use crate::memory::service::{MemoryModule, MemoryService, SessionData, SessionSource};

#[derive(Default)]
struct FakeMemory {
    calls: Mutex<Vec<Value>>,
    results: Mutex<VecDeque<String>>,
    /// The sessions marked as having loaded the module, in call order.
    noted: Mutex<Vec<String>>,
}

#[async_trait]
impl MemoryModule for FakeMemory {
    async fn memory(&self, args: Value) -> String {
        self.calls.lock().expect("calls").push(json!(["memory", args]));
        "ingest_session: considered=1 inserted=1".into()
    }

    async fn recall(&self, args: Value, _: &tokio_util::sync::CancellationToken) -> String {
        self.calls.lock().expect("calls").push(json!(["recall", args]));
        self.results.lock().expect("results").pop_front().unwrap_or_else(|| "(no results)".into())
    }

    fn note_session_use(&self, thread: &str) {
        self.noted.lock().expect("noted").push(thread.to_owned());
    }
}

struct Sessions {
    session: Option<SessionData>,
    cwd: Option<String>,
    title: String,
}

#[async_trait]
impl SessionSource for Sessions {
    async fn session(&self, _thread_id: Option<&str>) -> Option<SessionData> {
        self.session.clone()
    }

    async fn current_cwd(&self, _thread_id: Option<&str>) -> Option<String> {
        self.cwd.clone()
    }

    async fn profile_title(&self) -> String {
        self.title.clone()
    }
}

fn request(params: Value) -> CoreRequest {
    CoreRequest { method: Method("memory/recall"), params, op: None, ctx: CallContext::internal("test") }
}

async fn ask(service: &MemoryService, params: Value) -> String {
    match service.call(request(params)).await.expect("answers") {
        Reply::Value(Value::String(text)) => text,
        _ => panic!("a recall answers with text"),
    }
}

/// A thread's recall that reaches the memory runtime (`memoryModule()`) marks that session's runtime as holding the
/// module; one its own rows answer, or one that names no thread, marks nothing.
#[tokio::test]
async fn a_recall_that_reaches_the_memory_runtime_marks_its_session() {
    let memory = Arc::new(FakeMemory::default());
    let session = SessionData { id: "sess_1".into(), messages: vec![json!({ "role": "user", "content": "the lighthouse is green" })] };
    let service = MemoryService::new(memory.clone(), Arc::new(Sessions { session: Some(session), cwd: None, title: String::new() }));
    ask(&service, json!({ "threadId": "sess_1", "query": "lighthouse" })).await;
    assert!(memory.noted.lock().expect("noted").is_empty(), "answered from the session's own rows");
    ask(&service, json!({ "threadId": "sess_1", "query": "harbor" })).await;
    ask(&service, json!({ "query": "harbor" })).await;
    assert_eq!(*memory.noted.lock().expect("noted"), ["sess_1"]);
}

fn service_with(memory: &Arc<FakeMemory>, session: Option<SessionData>, title: &str) -> MemoryService {
    MemoryService::new(memory.clone(), Arc::new(Sessions { session, cwd: Some("/work/current".into()), title: title.to_owned() }))
}

fn live_session() -> SessionData {
    SessionData { id: "sess_1".into(), messages: vec![json!({ "role": "user", "content": "the lighthouse is green" })] }
}

fn calls(memory: &FakeMemory) -> Vec<Value> {
    memory.calls.lock().unwrap().clone()
}

#[tokio::test]
async fn an_identity_question_is_answered_from_the_profile_title_and_asks_memory_nothing() {
    let memory = Arc::new(FakeMemory::default());
    let service = service_with(&memory, None, "  Alice  ");
    let answer = ask(&service, json!({ "query": "Who am I" })).await;
    assert_eq!(
        answer,
        "[profile] Current configured user name/identity: Alice. This profile value is authoritative; ignore stale memory rows that say the user's identity is unknown."
    );
    assert!(calls(&memory).is_empty());
}

#[tokio::test]
async fn an_identity_question_with_no_profile_title_goes_to_memory_like_any_other() {
    let memory = Arc::new(FakeMemory::default());
    let service = service_with(&memory, None, "");
    ask(&service, json!({ "query": "whoami" })).await;
    assert_eq!(calls(&memory), [json!(["recall", { "query": "whoami", "cwd": "/work/current" }])]);
}

#[tokio::test]
async fn a_recall_without_a_session_asks_memory_once_with_the_query_and_the_threads_directory() {
    let memory = Arc::new(FakeMemory { results: Mutex::new(VecDeque::from(["the answer".to_owned()])), ..FakeMemory::default() });
    let service = service_with(&memory, None, "");
    assert_eq!(ask(&service, json!({ "query": "harbor", "args": { "limit": 3 } })).await, "the answer");
    assert_eq!(calls(&memory), [json!(["recall", { "limit": 3, "query": "harbor", "cwd": "/work/current" }])]);
}

#[tokio::test]
async fn the_query_may_come_from_the_arguments_and_their_directory_outranks_the_threads() {
    let memory = Arc::new(FakeMemory::default());
    let service = service_with(&memory, None, "");
    ask(&service, json!({ "args": { "query": "harbor", "cwd": "/elsewhere" } })).await;
    assert_eq!(calls(&memory), [json!(["recall", { "query": "harbor", "cwd": "/elsewhere" }])]);
}

#[tokio::test]
async fn a_session_that_does_not_match_is_ingested_then_recalled_scoped_to_itself() {
    let memory = Arc::new(FakeMemory { results: Mutex::new(VecDeque::from(["found in memory".to_owned()])), ..FakeMemory::default() });
    let service = service_with(&memory, Some(live_session()), "");
    assert_eq!(ask(&service, json!({ "query": "harbor", "threadId": "sess_1" })).await, "found in memory");
    assert_eq!(
        calls(&memory),
        [
            json!(["memory", { "action": "ingest_session", "sessionId": "sess_1", "cwd": "/work/current", "messages": live_session().messages }]),
            json!(["recall", {
                "query": "harbor", "cwd": "/work/current", "currentSessionId": "sess_1", "sessionId": "sess_1", "currentSession": true,
                "projectScope": "all", "includeRaw": true, "includeArchived": true
            }]),
        ]
    );
}

#[tokio::test]
async fn an_empty_scoped_answer_falls_back_to_the_unscoped_recall() {
    let memory = Arc::new(FakeMemory::default());
    let service = service_with(&memory, Some(live_session()), "");
    assert_eq!(ask(&service, json!({ "query": "harbor" })).await, "(no results)");
    let seen = calls(&memory);
    assert_eq!(seen.len(), 3, "ingest, the scoped recall, the plain recall: {seen:?}");
    assert_eq!(seen[2], json!(["recall", { "query": "harbor", "cwd": "/work/current", "currentSessionId": "sess_1" }]));
}

#[tokio::test]
async fn the_callers_scope_and_raw_and_archive_choices_stand_in_the_scoped_recall() {
    let memory = Arc::new(FakeMemory { results: Mutex::new(VecDeque::from(["x".to_owned()])), ..FakeMemory::default() });
    let service = service_with(&memory, Some(live_session()), "");
    ask(&service, json!({ "query": "harbor", "args": { "projectScope": "proj-a", "includeRaw": false, "includeArchived": false } })).await;
    let scoped = &calls(&memory)[1][1];
    assert_eq!(
        (scoped["projectScope"].clone(), scoped["includeRaw"].clone(), scoped["includeArchived"].clone()),
        (json!("proj-a"), json!(false), json!(false))
    );
}

#[tokio::test]
async fn a_caller_can_skip_the_sessions_own_rows_and_the_ingest() {
    let memory = Arc::new(FakeMemory::default());
    let service = service_with(&memory, Some(live_session()), "");
    ask(&service, json!({ "query": "lighthouse", "args": { "currentSession": false } })).await;
    assert_eq!(calls(&memory).len(), 1, "no own-row answer and no ingest: one plain recall");
    let memory = Arc::new(FakeMemory::default());
    let service = service_with(&memory, Some(live_session()), "");
    ask(&service, json!({ "query": "harbor", "args": { "forceCycleOnEmpty": false } })).await;
    assert_eq!(calls(&memory).len(), 1, "no ingest when the cycle is not forced");
    assert_eq!(calls(&memory)[0][0], "recall");
}

#[tokio::test]
async fn a_session_with_no_messages_is_not_ingested() {
    let memory = Arc::new(FakeMemory::default());
    let service = service_with(&memory, Some(SessionData { id: "sess_2".into(), messages: Vec::new() }), "");
    ask(&service, json!({ "query": "harbor" })).await;
    assert_eq!(calls(&memory).len(), 1);
}

#[tokio::test]
async fn the_memory_control_call_passes_its_arguments_and_marks_the_thread() {
    let memory = Arc::new(FakeMemory::default());
    let service = service_with(&memory, None, "");
    let reply = service
        .call(CoreRequest {
            method: Method("memory/memoryControl"),
            params: json!({ "threadId": "sess_9", "args": { "action": "status" } }),
            op: None,
            ctx: CallContext::internal("test"),
        })
        .await
        .expect("answers");
    assert!(matches!(reply, Reply::Value(Value::String(text)) if text == "ingest_session: considered=1 inserted=1"));
    assert_eq!(calls(&memory), [json!(["memory", { "action": "status" }])]);
    assert_eq!(*memory.noted.lock().unwrap(), ["sess_9"]);
    let bare =
        service.call(CoreRequest { method: Method("memory/memoryControl"), params: json!({ "args": 0 }), op: None, ctx: CallContext::internal("test") }).await;
    assert!(bare.is_ok());
    assert_eq!(calls(&memory)[1], json!(["memory", {}]), "arguments that are not truthy are an empty object");
}

#[tokio::test]
async fn a_method_the_service_does_not_have_is_refused() {
    let service = service_with(&Arc::new(FakeMemory::default()), None, "");
    assert!(service.call(CoreRequest { method: Method("memory/other"), params: json!({}), op: None, ctx: CallContext::internal("test") }).await.is_err());
    assert_eq!(service.methods(), ["memory/memoryControl", "memory/recall"]);
}

struct NeverReady;

#[async_trait]
impl MemoryModule for NeverReady {
    async fn ready(&self) -> Result<(), String> {
        Err("initdb failed: the real reason".into())
    }
    async fn memory(&self, _: Value) -> String {
        unreachable!("never reached")
    }
    async fn recall(&self, _: Value, _: &tokio_util::sync::CancellationToken) -> String {
        unreachable!("never reached")
    }
}

#[tokio::test]
async fn a_memory_runtime_that_never_came_up_is_refused_with_the_proxys_text_not_its_own_error() {
    let service = MemoryService::new(Arc::new(NeverReady), Arc::new(Sessions { session: None, cwd: None, title: String::new() }));
    let Err(error) = service.call(request(json!({ "query": "harbor" }))).await else { panic!("a runtime that never came up refuses") };
    let error = error.to_string();
    assert!(error.contains("memory runtime did not become ready") && !error.contains("initdb"), "{error}");
}

#[tokio::test]
async fn a_cancelled_memory_control_call_is_cancelled_before_it_reaches_memory() {
    let memory = Arc::new(FakeMemory::default());
    let service = service_with(&memory, None, "");
    let cancelled = CallContext::internal("test");
    cancelled.cancel.cancel();
    let result =
        service.call(CoreRequest { method: Method("memory/memoryControl"), params: json!({ "args": { "action": "status" } }), op: None, ctx: cancelled }).await;
    assert!(result.is_err());
    assert!(calls(&memory).is_empty());
}
