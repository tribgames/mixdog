//! The feed over a scripted client: replies are queued per method, store changes and client events are sent by the test.

use std::collections::{HashMap, VecDeque};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use mixdog_app_server_client::api::{
    BlobRef, CallOptions, ClientError, ClientEvent, ConnectionStatus, FeedStamp, FoldStore, InitializeResponse, Json,
    ProtocolClient, ResumeWindow, SectionEntry, SectionName, ServerRequest, ServerRequestAnswer, StoreChange, ThreadFold,
    ThreadId, ThreadResumeResponse,
};
use mixdog_rt::CancellationToken;
use serde_json::json;
use tokio::sync::{Notify, broadcast};

use super::*;

enum Reply {
    Value(Json),
    Error(ClientError),
    /// Never answers.
    Never,
    /// Answers once the gate opens.
    Gate(Arc<Notify>, Json),
}

struct StubStore {
    threads: Mutex<HashMap<String, ThreadFold>>,
    sections: Mutex<HashMap<String, SectionEntry>>,
    changes: broadcast::Sender<StoreChange>,
}

impl FoldStore for StubStore {
    fn thread(&self, thread_id: &str) -> Option<ThreadFold> {
        self.threads.lock().unwrap().get(thread_id).cloned()
    }
    fn section(&self, section: SectionName, _key: Option<&str>) -> Option<SectionEntry> {
        self.sections.lock().unwrap().get(section.wire()).cloned()
    }
    fn sections(&self, _section: SectionName) -> Vec<SectionEntry> {
        Vec::new()
    }
    fn app_feed(&self) -> Option<FeedStamp> {
        None
    }
    fn subscribe(&self) -> broadcast::Receiver<StoreChange> {
        self.changes.subscribe()
    }
}

struct StubClient {
    store: Arc<StubStore>,
    events: broadcast::Sender<ClientEvent>,
    replies: Mutex<HashMap<String, VecDeque<Reply>>>,
    calls: Mutex<Vec<(String, Json)>>,
    held: Mutex<Vec<ServerRequest>>,
    answered: AtomicUsize,
}

#[async_trait]
impl ProtocolClient for StubClient {
    fn store(&self) -> Arc<dyn FoldStore> {
        self.store.clone()
    }
    fn server(&self) -> InitializeResponse {
        unreachable!("the feed never reads the initialize result")
    }
    fn status(&self) -> ConnectionStatus {
        ConnectionStatus::Ready { server_instance_id: "s".into() }
    }
    async fn call_raw(&self, method: &str, params: Json, _options: CallOptions) -> Result<Json, ClientError> {
        self.calls.lock().unwrap().push((method.to_owned(), params));
        let reply = self.replies.lock().unwrap().get_mut(method).and_then(VecDeque::pop_front);
        match reply {
            Some(Reply::Value(value)) => Ok(value),
            Some(Reply::Error(error)) => Err(error),
            Some(Reply::Gate(gate, value)) => {
                gate.notified().await;
                Ok(value)
            }
            Some(Reply::Never) => std::future::pending().await,
            None => Err(ClientError::ConnectionLost),
        }
    }
    async fn notify(&self, _method: &str, _params: Json) -> Result<(), ClientError> {
        Ok(())
    }
    async fn resume_thread(&self, _thread_id: &ThreadId, _window: ResumeWindow) -> Result<ThreadResumeResponse, ClientError> {
        Err(ClientError::ClientClosed)
    }
    async fn unsubscribe_thread(&self, _thread_id: &ThreadId) -> Result<(), ClientError> {
        Err(ClientError::ClientClosed)
    }
    async fn subscribe_app(&self) -> Result<(), ClientError> {
        Ok(())
    }
    fn pending_server_requests(&self) -> Vec<ServerRequest> {
        self.held.lock().unwrap().clone()
    }
    async fn respond(&self, _id: mixdog_app_server_client::api::RequestId, _answer: ServerRequestAnswer) -> Result<(), ClientError> {
        self.answered.fetch_add(1, Ordering::SeqCst);
        Ok(())
    }
    async fn read_blob(&self, _blob: &BlobRef) -> Result<Vec<u8>, ClientError> {
        Err(ClientError::ClientClosed)
    }
    async fn put_blob(&self, _bytes: &[u8], _media_type: &str) -> Result<BlobRef, ClientError> {
        Err(ClientError::ClientClosed)
    }
    fn events(&self) -> broadcast::Receiver<ClientEvent> {
        self.events.subscribe()
    }
    async fn close(&self) {}
}

fn stub(replies: Vec<(&str, Vec<Reply>)>) -> Arc<StubClient> {
    Arc::new(StubClient {
        store: Arc::new(StubStore {
            threads: Mutex::new(HashMap::new()),
            sections: Mutex::new(HashMap::new()),
            changes: broadcast::channel(64).0,
        }),
        events: broadcast::channel(64).0,
        replies: Mutex::new(replies.into_iter().map(|(method, list)| (method.to_owned(), list.into())).collect()),
        calls: Mutex::new(Vec::new()),
        held: Mutex::new(Vec::new()),
        answered: AtomicUsize::new(0),
    })
}

fn row(id: &str, title: &str, activity: i64) -> Json {
    json!({
        "id": id, "preview": "", "title": title, "updatedAt": activity, "messageCount": 1,
        "cwd": "/w", "classification": "chat", "projectPath": null
    })
}

fn notification(method: &str, params: Json) -> ClientEvent {
    ClientEvent::Notification(serde_json::from_value(json!({ "method": method, "params": params })).unwrap())
}

fn approval(id: &str, thread: &str, method: &str) -> ServerRequest {
    let mut params = json!({ "threadId": thread, "requestedAt": 5, "order": 1, "kind": "shell", "tool": "bash", "request": {} });
    if method == "item/tool/requestUserInput" {
        params = json!({ "threadId": thread, "requestedAt": 5, "order": 2, "questions": [] });
    }
    serde_json::from_value(json!({ "method": method, "id": id, "params": params })).unwrap()
}

fn ids(feed: &ServerFeed) -> Vec<String> {
    let sessions = feed.sessions();
    let ids = sessions.borrow().iter().map(|s| s.id.clone()).collect();
    ids
}

#[tokio::test]
async fn server_feed_sessions_fold() {
    let client = stub(vec![(
        "thread/list",
        vec![
            Reply::Value(json!({ "data": [row("a", "old", 10), row("b", "mid", 20)], "nextCursor": "c1" })),
            Reply::Value(json!({ "data": [row("c", "new", 30)] })),
        ],
    )]);
    let feed = ServerFeed::attach(client.clone());
    let mut sessions = feed.sessions();
    sessions.wait_for(|rows| rows.len() == 3).await.unwrap();
    assert_eq!(ids(&feed), ["c", "b", "a"]);
    // The second page asked with the first's cursor.
    let calls = client.calls.lock().unwrap().clone();
    assert_eq!(calls[1].1["cursor"], "c1");
    drop(calls);

    // A running row from the app feed replaces the listed one and moves it to the front.
    let mut running = row("a", "old", 40);
    running["working"] = json!(true);
    client.events.send(notification("thread/summary/updated", json!({ "thread": running }))).unwrap();
    sessions.wait_for(|rows| rows[0].id == "a" && rows[0].running).await.unwrap();
    // The whole row rides along for the readers of more than the lite fields.
    assert_eq!(sessions.borrow()[0].summary.working, Some(true));

    client.events.send(notification("thread/archived", json!({ "threadId": "b" }))).unwrap();
    sessions.wait_for(|rows| rows.iter().any(|r| r.id == "b" && r.archived)).await.unwrap();
    client.events.send(notification("thread/unarchived", json!({ "threadId": "b" }))).unwrap();
    sessions.wait_for(|rows| rows.iter().any(|r| r.id == "b" && !r.archived)).await.unwrap();

    client.events.send(notification("thread/deleted", json!({ "threadId": "c" }))).unwrap();
    sessions.wait_for(|rows| rows.len() == 2).await.unwrap();
    assert_eq!(ids(&feed), ["a", "b"]);
}

#[tokio::test]
async fn server_feed_edge_outranks_the_listing_it_overlaps() {
    let gate = Arc::new(Notify::new());
    let client = stub(vec![(
        "thread/list",
        vec![Reply::Gate(gate.clone(), json!({ "data": [row("a", "listed", 10), row("b", "gone", 5)] }))],
    )]);
    let feed = ServerFeed::attach(client.clone());
    client.events.send(notification("thread/summary/updated", json!({ "thread": row("a", "edge", 10) }))).unwrap();
    client.events.send(notification("thread/deleted", json!({ "threadId": "b" }))).unwrap();
    client.events.send(notification("thread/started", json!({ "thread": row("n", "started", 50) }))).unwrap();
    // The events are folded before the listing arrives: let the feed's task take them.
    for _ in 0..50 {
        tokio::task::yield_now().await;
    }
    gate.notify_one();
    let mut sessions = feed.sessions();
    sessions.wait_for(|rows| rows.len() == 2).await.unwrap();
    let rows = sessions.borrow().clone();
    assert_eq!((rows[0].id.as_str(), rows[0].title.as_str()), ("n", "started"));
    assert_eq!((rows[1].id.as_str(), rows[1].title.as_str()), ("a", "edge"));
}

#[tokio::test]
async fn server_feed_relisting_after_reconnect_is_heard_unchanged() {
    let listing = || Reply::Value(json!({ "data": [row("a", "same", 10)] }));
    let client = stub(vec![("thread/list", vec![listing(), listing()])]);
    let feed = ServerFeed::attach(client.clone());
    let mut sessions = feed.sessions();
    sessions.wait_for(|rows| rows.len() == 1).await.unwrap();
    drop(sessions.borrow_and_update());
    client.events.send(ClientEvent::Status(ConnectionStatus::Reconnecting { attempt: 1 })).unwrap();
    client.events.send(ClientEvent::Status(ConnectionStatus::Ready { server_instance_id: "s".into() })).unwrap();
    // The read after the reconnect is published although it equals the list already held.
    sessions.changed().await.unwrap();
    assert_eq!(ids(&feed), ["a"]);
}

#[tokio::test]
async fn server_feed_state_change_order() {
    let client = stub(vec![("thread/list", vec![Reply::Value(json!({ "data": [] }))])]);
    let feed = ServerFeed::attach(client.clone());
    let mut states = feed.session_states();
    let fold = |state: Json| ThreadFold {
        feed: serde_json::from_value(json!({ "id": "thread:t1", "epoch": "e", "seq": 1 })).unwrap(),
        state,
    };
    let set = |state: Json| {
        client.store.threads.lock().unwrap().insert("t1".into(), fold(state));
        client.store.changes.send(StoreChange::Thread { thread_id: "t1".into() }).unwrap();
    };
    set(json!({ "busy": true, "turnStartedAt": 1000 }));
    let first = states.recv().await.unwrap();
    set(json!({ "busy": true, "turnStartedAt": 1000, "items": [1] }));
    let second = states.recv().await.unwrap();
    set(json!({ "busy": false }));
    let third = states.recv().await.unwrap();
    client.events.send(notification("thread/deleted", json!({ "threadId": "t1" }))).unwrap();
    let fourth = states.recv().await.unwrap();

    assert_eq!((first.state, first.started_at), (SessionRunState::Running, Some(1000)));
    assert_eq!(second.state, SessionRunState::Running);
    assert_eq!(second.snapshot["items"], json!([1]));
    // The idle change still names the turn that just ended.
    assert_eq!((third.state, third.started_at), (SessionRunState::Idle, Some(1000)));
    assert_eq!((fourth.state, fourth.session_id.as_str(), fourth.snapshot), (SessionRunState::Gone, "t1", Json::Null));
}

#[tokio::test]
async fn server_feed_approval_observed_not_answered() {
    let client = stub(vec![("thread/list", vec![Reply::Value(json!({ "data": [] }))])]);
    let feed = ServerFeed::attach(client.clone());
    let mut approvals = feed.pending_approvals();

    let tool = approval("a1", "t1", "item/tool/requestApproval");
    let question = approval("q1", "t2", "item/tool/requestUserInput");
    client.held.lock().unwrap().push(tool.clone());
    client.events.send(ClientEvent::ServerRequest(tool)).unwrap();
    approvals.wait_for(|rows| rows.len() == 1).await.unwrap();
    client.held.lock().unwrap().push(question.clone());
    client.events.send(ClientEvent::ServerRequest(question)).unwrap();
    approvals.wait_for(|rows| rows.len() == 2).await.unwrap();
    let rows = approvals.borrow().clone();
    assert_eq!((rows[0].session_id.as_str(), rows[0].kind), ("t1", ApprovalKind::Tool));
    assert_eq!((rows[1].session_id.as_str(), rows[1].kind), ("t2", ApprovalKind::Question));

    client.held.lock().unwrap().retain(|r| r.id() != &RequestId::String("a1".into()));
    let done = serde_json::from_value(json!({ "threadId": "t1", "requestId": "a1", "resolution": { "kind": "timedOut", "at": 9 } })).unwrap();
    client.events.send(ClientEvent::ServerRequestResolved(done)).unwrap();
    approvals.wait_for(|rows| rows.len() == 1).await.unwrap();
    assert_eq!(approvals.borrow()[0].request_id, RequestId::String("q1".into()));
    assert_eq!(client.answered.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn server_feed_final_answer_read() {
    let client = stub(vec![
        ("thread/list", vec![Reply::Value(json!({ "data": [] }))]),
        (
            "thread/finalAnswer/read",
            vec![
                Reply::Value(json!({ "id": "d1", "at": 2000, "status": "done", "text": "hello" })),
                Reply::Value(Json::Null),
                Reply::Value(json!({ "id": 7, "at": 2100, "status": "cancelled", "text": "" })),
                Reply::Value(json!({ "id": 8, "at": 2200, "status": "done", "text": "", "reacted": true })),
                Reply::Error(ClientError::ProtocolViolation("session s9 is not available".into())),
                Reply::Never,
            ],
        ),
    ]);
    let feed = ServerFeed::attach(client.clone());
    let never = CancellationToken::new();

    let answer = feed.read_final_answer("t1", 1500, &never).await.unwrap();
    assert_eq!((answer.id, answer.at, answer.status, answer.text.as_str()), (json!("d1"), 2000, FinalAnswerStatus::Done, "hello"));
    let sent = client.calls.lock().unwrap().iter().find(|(m, _)| m == "thread/finalAnswer/read").cloned().unwrap();
    assert_eq!(sent.1, json!({ "threadId": "t1", "startedAt": 1500 }));

    assert_eq!(feed.read_final_answer("t1", 1500, &never).await, None);
    assert_eq!(feed.read_final_answer("t1", 1500, &never).await.unwrap().status, FinalAnswerStatus::Cancelled);
    assert!(feed.read_final_answer("t1", 1500, &never).await.unwrap().reacted);

    let failed = feed.read_final_answer_result("s9", 1, &never).await.unwrap_err();
    assert!(is_session_missing(&failed));
    assert!(!is_session_missing(&ClientError::ConnectionLost));

    // A read that is cancelled while it waits gives no answer.
    let cancel = CancellationToken::new();
    cancel.cancel();
    assert_eq!(feed.read_final_answer("t1", 1, &cancel).await, None);
}

#[tokio::test]
async fn server_feed_agent_pool_from_section_and_list() {
    let pool_row = |tag: &str| json!({ "tag": tag, "sessionId": format!("s-{tag}"), "ownerSessionId": "lead", "status": "running", "stage": "turn" });
    let client = stub(vec![
        ("thread/list", vec![Reply::Value(json!({ "data": [] }))]),
        ("agent/pool/list", vec![Reply::Value(json!([pool_row("w1")]))]),
    ]);
    let feed = ServerFeed::attach(client.clone());
    let mut pool = feed.agent_pool();
    // No section yet: the list method answers.
    pool.wait_for(|rows| rows.len() == 1).await.unwrap();
    assert_eq!(pool.borrow()[0].session_id, "s-w1");
    assert_eq!(pool.borrow()[0].owner_session_id.as_deref(), Some("lead"));

    // An inline section replaces it.
    client.store.sections.lock().unwrap().insert(
        "agentPool".into(),
        SectionEntry { section: SectionName::AgentPool, key: None, revision: 1, value: json!([pool_row("w2"), pool_row("w3")]) },
    );
    client.store.changes.send(StoreChange::Section { section: SectionName::AgentPool, key: None }).unwrap();
    pool.wait_for(|rows| rows.len() == 2).await.unwrap();
    assert_eq!(pool.borrow()[1].tag, "w3");
}
