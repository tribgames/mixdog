//! The session store against the client library's scripted peer (`mixdog_app_server_client::mock`): the store opens a session
//! (`thread/start`, `thread/resume`), follows the feeds the peer sends (snapshot, deltas, sections, server requests, the app feed's
//! shell jobs), publishes a changed state once per tick and sends what the Node intake sent (submit, abort, restoreQueued, steer,
//! approvals, OAuth flows), and survives a reconnect with the subscription resumed. The states it publishes over the synthetic fold
//! feeds equal the ones the TypeScript session state publishes (`goldens/store-steps.json`, `recorders/record-store-steps.mjs`).

use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use mixdog_app_server_client::Clock;
use mixdog_app_server_client::connect;
use mixdog_app_server_client::mock::MockConn;
use mixdog_app_server_client::mock::MockNetwork;
use mixdog_session_view::connect::connect_options;
use mixdog_session_view::store::ConnectionState;
use mixdog_session_view::store::OAuthKind;
use mixdog_session_view::store::SessionStore;
use mixdog_session_view::store::StoreEvent;
use mixdog_session_view::store::StoreOptions;
use mixdog_session_view::store::TurnStart;
use serde_json::Value;
use serde_json::json;

const CLIENT_OPTIONS: &str = include_str!("../../../../../packages/protocol-client/conformance/options.json");

/// A clock whose ladder never waits: a reconnect is the peer's to answer.
struct ImmediateClock;

#[async_trait]
impl Clock for ImmediateClock {
    async fn sleep(&self, _ms: u64) {
        tokio::task::yield_now().await;
    }
    fn jitter(&self) -> f64 {
        0.0
    }
}

/// Lets everything already in flight in the client land (the peer's frames are folded by tasks of this runtime).
async fn settle() {
    for _ in 0..200 {
        tokio::task::yield_now().await;
    }
}

async fn request_of(conn: &MockConn) -> Value {
    serde_json::from_str(&conn.next_sent().await).expect("the client writes JSON")
}

fn reply(conn: &MockConn, request: &Value, result: Value) {
    conn.server_send(&json!({ "id": request["id"], "result": result }));
}

fn thread_summary(id: &str) -> Value {
    json!({ "id": id, "preview": "", "title": "T", "updatedAt": 1, "messageCount": 0, "cwd": "/w", "classification": {}, "projectPath": null })
}

fn subscription(id: &str, epoch: &str) -> Value {
    json!({ "id": format!("sub-{id}"), "mode": "snapshot", "epoch": epoch, "startSeq": 1 })
}

/// Accepts the client's connection and answers `initialize`.
async fn accept_ready(net: &MockNetwork) -> MockConn {
    let conn = net.accept().await;
    let init = request_of(&conn).await;
    assert_eq!(init["method"], "initialize");
    let options: Value = serde_json::from_str(CLIENT_OPTIONS).expect("options.json");
    let mut result = options["initializeResult"].clone();
    result["serverInstanceId"] = json!("s1");
    reply(&conn, &init, result);
    let initialized = request_of(&conn).await;
    assert_eq!(initialized["method"], "initialized");
    conn
}

/// A store connected to a scripted core, and the peer's side of it.
struct Rig {
    store: SessionStore,
    conn: MockConn,
    net: Arc<MockNetwork>,
    thread: String,
    seq: u64,
    app_seq: u64,
    /// What the store's opening sent: `thread/start` (none when resuming) and `thread/resume`.
    start: Option<Value>,
    resume: Value,
}

impl Rig {
    async fn open(options: StoreOptions, snapshot: Value) -> Self {
        let net = Arc::new(MockNetwork::default());
        let thread = snapshot["thread"]["id"].as_str().expect("a thread id").to_owned();
        let feed = SessionStore::new_feed();
        let mut connect_with = connect_options(net.clone(), &feed);
        connect_with.clock = Arc::new(ImmediateClock);
        let resuming = options.resume.is_some();
        let opening = tokio::spawn(async move {
            let client = connect(connect_with).await.expect("connected");
            SessionStore::open(Arc::new(client), feed, options).await
        });
        let conn = accept_ready(&net).await;
        let app = request_of(&conn).await;
        assert_eq!(app["method"], "app/subscribe");
        reply(&conn, &app, json!({ "subscription": subscription("app", "a1") }));
        let start = if resuming {
            None
        } else {
            let start = request_of(&conn).await;
            assert_eq!(start["method"], "thread/start");
            reply(&conn, &start, json!({ "thread": thread_summary(&thread) }));
            Some(start)
        };
        let resume = request_of(&conn).await;
        assert_eq!(resume["method"], "thread/resume");
        reply(&conn, &resume, json!({ "thread": thread_summary(&thread), "subscription": subscription(&thread, "e1") }));
        conn.server_send(&json!({ "method": "thread/snapshot", "params": snapshot, "feed": { "id": thread, "epoch": "e1", "seq": 1 } }));
        let store = opening.await.expect("the opening task").expect("the store opens");
        Self { store, conn, net, thread, seq: 1, app_seq: 0, start, resume }
    }

    async fn open_default() -> Self {
        Self::open(StoreOptions::default(), snapshot(&[hello()])).await
    }

    /// A thread feed notification, folded before this returns.
    async fn feed(&mut self, method: &str, params: Value) {
        self.seq += 1;
        self.conn.server_send(&json!({ "method": method, "params": params, "feed": { "id": self.thread, "epoch": "e1", "seq": self.seq } }));
        settle().await;
    }

    async fn app_section(&mut self, method: &str, section: &str, key: Option<&str>, revision: u64, value: Value) {
        self.app_seq += 1;
        self.conn.server_send(&json!({
            "method": method,
            "params": { "section": section, "key": key, "revision": revision, "value": value },
            "feed": { "id": "app", "epoch": "a1", "seq": self.app_seq },
        }));
        settle().await;
    }

    /// Runs `call` while answering the one request it sends with `result`; returns the call's value and that request.
    async fn answering<T>(&self, result: Value, call: impl std::future::Future<Output = T>) -> (T, Value) {
        let (value, request) = tokio::join!(call, async {
            let request = request_of(&self.conn).await;
            reply(&self.conn, &request, result);
            request
        });
        (value, request)
    }

    fn pending_events(events: &mut tokio::sync::broadcast::Receiver<StoreEvent>) -> Vec<StoreEvent> {
        let mut out = Vec::new();
        while let Ok(event) = events.try_recv() {
            out.push(event);
        }
        out
    }
}

fn hello() -> Value {
    json!({ "type": "agentMessage", "id": "a", "text": "hi", "meta": {} })
}

fn snapshot(items: &[Value]) -> Value {
    json!({ "thread": { "id": "lead" }, "items": items, "state": {}, "hasOlder": false })
}

#[tokio::test(flavor = "current_thread")]
async fn a_session_starts_with_the_options_and_attaches_its_feed() {
    let options = StoreOptions {
        provider: Some("anthropic".to_owned()),
        model: Some("m".to_owned()),
        tool_mode: Some("lead".to_owned()),
        worktree: Some(json!({ "mode": "default" })),
        cwd: Some("/w".to_owned()),
        ..StoreOptions::default()
    };
    let rig = Rig::open(options, snapshot(&[hello()])).await;
    let start = rig.start.as_ref().expect("a start");
    assert!(start["params"]["opId"].is_string());
    let mut params = start["params"].clone();
    params.as_object_mut().expect("params").remove("opId");
    assert_eq!(
        params,
        json!({
            "kind": "project",
            "projectPath": "/w",
            "draft": { "route": { "provider": "anthropic", "model": "m" }, "worktree": { "mode": "default" } },
            "session": { "toolProfile": "interactive", "toolMode": "lead" }
        })
    );
    assert_eq!(rig.resume["params"], json!({ "threadId": "lead", "window": { "lastItems": 512 } }));
    assert_eq!(rig.store.thread_id().as_deref(), Some("lead"));
    let state = rig.store.state();
    assert_eq!((state["sessionId"].clone(), state["items"][0]["text"].clone()), (json!("lead"), json!("hi")));
    assert!(!rig.store.is_remote_session());
}

#[tokio::test(flavor = "current_thread")]
async fn a_stored_session_is_resumed_without_a_start() {
    let options = StoreOptions { resume: Some("lead".to_owned()), remote: true, ..StoreOptions::default() };
    let rig = Rig::open(options, snapshot(&[hello()])).await;
    assert!(rig.start.is_none());
    assert_eq!(rig.resume["params"]["threadId"], "lead");
    assert!(rig.store.is_remote_session());
}

#[tokio::test(flavor = "current_thread")]
async fn a_changed_state_is_published_once_per_tick() {
    let mut rig = Rig::open_default().await;
    // The snapshot the store opened with may still be in flight to its follower: that publication, if any, is this tick's.
    settle().await;
    rig.store.tick();
    assert!(!rig.store.tick(), "nothing changed since the state the store opened with");
    let mut events = rig.store.subscribe();
    for part in ["a", "b", "c"] {
        rig.feed("item/agentMessage/delta", json!({ "threadId": "lead", "turnId": "t", "itemId": "a", "delta": part })).await;
    }
    assert!(Rig::pending_events(&mut events).is_empty(), "nothing is published between frames");
    assert!(rig.store.tick());
    let published = Rig::pending_events(&mut events);
    assert_eq!(published.iter().filter(|event| matches!(event, StoreEvent::State(_))).count(), 1);
    assert!(!rig.store.tick());
}

#[tokio::test(flavor = "current_thread")]
async fn a_pending_approval_is_the_state_and_an_answer_goes_to_the_core() {
    let mut rig = Rig::open_default().await;
    let ask = json!({
        "method": "item/tool/requestApproval", "id": "r1",
        "params": { "threadId": "lead", "requestedAt": 1, "order": 1, "kind": "shell", "tool": "bash", "request": { "command": "ls" } },
    });
    rig.conn.server_send(&ask);
    settle().await;
    assert!(rig.store.tick());
    let state = rig.store.state();
    assert_eq!((state["toolApproval"]["id"].clone(), state["toolApprovalsWaiting"].clone()), (json!("r1"), json!(0)));
    let (answer, request) = rig.answering(json!({ "accepted": true }), rig.store.respond_approval("r1", true)).await;
    assert!(answer.expect("answered"));
    assert_eq!(request["method"], "thread/approval/answer");
    assert_eq!(request["params"]["threadId"], "lead");
    assert_eq!(request["params"]["approvalId"], "r1");
    assert_eq!(request["params"]["result"], json!({ "approved": true, "reason": "answered by user" }));
    // The core resolves the request; the card goes.
    rig.conn.server_send(&json!({
        "method": "serverRequest/resolved",
        "params": { "threadId": "lead", "requestId": "r1", "resolution": { "kind": "interrupted", "at": 1 } },
    }));
    settle().await;
    assert!(rig.store.tick());
    assert_eq!(rig.store.state()["toolApproval"], Value::Null);
    // A request that is no longer pending is not answered: nothing is sent.
    assert!(!rig.store.respond_approval("r1", false).await.expect("no request"));
    assert_eq!(rig.conn.queued(), 0);
    rig.feed("thread/frame", json!({ "threadId": "lead" })).await;
}

#[tokio::test(flavor = "current_thread")]
async fn a_submission_is_a_turn_input_with_a_submission_id() {
    let rig = Rig::open_default().await;
    let options = json!({ "displayText": "shown", "priority": "next", "mode": "prompt", "pastedTexts": { "t1": { "text": "x" } } });
    let (sent, request) = rig.answering(json!({ "kind": "queued", "queuedId": "q1" }), rig.store.submit(&json!("do it"), &options)).await;
    let submitted = sent.expect("sent").expect("accepted");
    assert_eq!(submitted.turn, TurnStart::Queued { queued_id: "q1".to_owned() });
    assert_eq!(request["method"], "turn/start");
    let input = &request["params"]["input"];
    assert_eq!(request["params"]["threadId"], "lead");
    assert_eq!(input["prompt"], "do it");
    assert_eq!(input["options"]["displayText"], "shown");
    assert_eq!(input["options"]["priority"], "next");
    assert_eq!(input["options"]["pastedTexts"], json!({ "t1": { "text": "x" } }));
    assert_eq!(input["options"]["clientSubmissionId"].as_str(), Some(submitted.submission_id.as_str()));
    assert!(input["options"].get("mode").is_none());
    // The caller's own id is kept, and a started turn is reported.
    let (sent, request) = rig.answering(json!({ "kind": "started", "turnId": "t9" }), rig.store.submit(&json!("again"), &json!({ "id": "mine" }))).await;
    assert_eq!(sent.expect("sent").expect("accepted").turn, TurnStart::Started { turn_id: "t9".to_owned() });
    assert_eq!(request["params"]["input"]["options"]["clientSubmissionId"], "mine");
    // A prompt with no words is not submitted.
    assert_eq!(rig.store.submit(&json!("  "), &json!({})).await.expect("no request"), None);
    assert_eq!(rig.conn.queued(), 0);
}

#[tokio::test(flavor = "current_thread")]
async fn esc_steer_and_restore_are_the_cores_requests() {
    let rig = Rig::open_default().await;
    let (aborted, request) = rig.answering(json!({ "cancelRequested": true, "aborted": true, "restoreText": "back" }), rig.store.abort(&json!({ "restorePrompt": false, "submissionId": " s1 " }))).await;
    assert_eq!(aborted.expect("aborted")["restoreText"], "back");
    assert_eq!((request["method"].clone(), request["params"].clone()), (json!("turn/interrupt"), json!({ "threadId": "lead", "restorePrompt": false, "submissionId": "s1" })));
    let (_, request) = rig.answering(json!({}), rig.store.abort(&json!({}))).await;
    assert_eq!(request["params"], json!({ "threadId": "lead" }));
    let (restored, request) = rig.answering(json!({ "count": 1, "text": "q" }), rig.store.restore_queued("", Some("q1"))).await;
    assert_eq!(restored.expect("restored")["count"], 1);
    assert_eq!(request["method"], "thread/queue/delete");
    assert_eq!(request["params"]["queuedId"], "q1");
    assert_eq!((request["params"]["restore"].clone(), request["params"]["currentText"].clone()), (json!(true), json!("")));
    let (_, request) = rig.answering(json!({ "accepted": true, "queuedId": "q2" }), rig.store.steer("q2")).await;
    assert_eq!((request["method"].clone(), request["params"].clone()), (json!("turn/steer"), json!({ "threadId": "lead", "queuedId": "q2" })));
}

#[tokio::test(flavor = "current_thread")]
async fn actions_are_routed_and_the_ones_without_a_router_row_have_their_targets() {
    let mut rig = Rig::open_default().await;
    let (_, request) = rig.answering(json!({}), rig.store.call("clear", &[])).await;
    assert_eq!((request["method"].clone(), request["params"]["threadId"].clone()), (json!("thread/clear"), json!("lead")));
    let (_, request) = rig.answering(json!({ "ok": true }), rig.store.call("touchProjectSelected", &[json!("/p")])).await;
    assert_eq!((request["method"].clone(), request["params"]["path"].clone()), (json!("project/touch"), json!("/p")));
    // toggleFast flips the session's fast mode.
    rig.feed("thread/route/updated", json!({ "threadId": "lead", "value": { "fast": true } })).await;
    assert!(rig.store.tick());
    let (_, request) = rig.answering(json!({}), rig.store.call("toggleFast", &[])).await;
    assert_eq!((request["method"].clone(), request["params"]["on"].clone()), (json!("fast/set"), json!(false)));
    // A section read answers from what the core published.
    rig.app_section("agent/list/updated", "agents", None, 1, json!([{ "id": "a" }])).await;
    assert_eq!(rig.store.call("listAgents", &[]).await.expect("agents"), json!([{ "id": "a" }]));
    rig.app_section("config/updated", "config", Some("onboarding"), 1, json!({ "completed": false })).await;
    assert!(!rig.store.onboarding_completed().await);
    assert!(rig.store.call("noSuchAction", &[]).await.is_err());
}

#[tokio::test(flavor = "current_thread")]
async fn events_tell_the_ui_open_requests_the_toasts_and_the_handed_back_prompt() {
    let mut rig = Rig::open_default().await;
    let mut events = rig.store.subscribe();
    rig.feed("thread/notification", json!({ "threadId": "lead", "content": "open", "meta": { "kind": "ui-open", "command": "/Settings" } })).await;
    rig.feed("thread/runtime/updated", json!({ "threadId": "lead", "value": { "toasts": [{ "id": "t1", "text": "hello", "tone": "info" }] } })).await;
    rig.feed("thread/promptRestore", json!({ "threadId": "lead", "value": { "id": "r1", "text": "back", "ids": [], "device": "d", "at": 1 } })).await;
    assert!(rig.store.tick());
    let heard = Rig::pending_events(&mut events);
    assert!(heard.contains(&StoreEvent::UiOpenRequest { command: "settings".to_owned(), seq: 1 }));
    assert!(heard.iter().any(|event| matches!(event, StoreEvent::Toast(toast) if toast["id"] == "t1")));
    assert!(heard.iter().any(|event| matches!(event, StoreEvent::PromptRestore(restore) if restore["id"] == "r1")));
    // Each is told once.
    rig.feed("thread/frame", json!({ "threadId": "lead" })).await;
    assert!(rig.store.tick());
    let again = Rig::pending_events(&mut events);
    assert!(!again.iter().any(|event| matches!(event, StoreEvent::Toast(_) | StoreEvent::PromptRestore(_))));
}

#[tokio::test(flavor = "current_thread")]
async fn a_reconnect_resumes_the_session_and_shows_only_in_the_status() {
    let mut rig = Rig::open_default().await;
    let mut events = rig.store.subscribe();
    rig.feed("item/completed", json!({ "threadId": "lead", "turnId": "t", "item": { "type": "agentMessage", "id": "b", "text": "second", "meta": {} } })).await;
    assert!(rig.store.tick());
    rig.conn.server_close(1006, "gone");
    settle().await;
    // The ladder dials again; the subscriptions are restored with the folded position.
    let conn = accept_ready(&rig.net).await;
    let mut resumed = None;
    for _ in 0..2 {
        let request = request_of(&conn).await;
        match request["method"].as_str() {
            Some("thread/resume") => {
                assert_eq!(request["params"]["threadId"], "lead");
                assert!(request["params"]["resumeFrom"].is_object(), "the folded position is sent");
                reply(&conn, &request, json!({ "thread": thread_summary("lead"), "subscription": subscription("lead", "e2") }));
                resumed = Some(request);
            }
            Some("app/subscribe") => reply(&conn, &request, json!({ "subscription": subscription("app", "a2") })),
            other => panic!("unexpected request {other:?}"),
        }
    }
    assert!(resumed.is_some());
    conn.server_send(&json!({
        "method": "thread/snapshot",
        "params": { "thread": { "id": "lead" }, "items": [hello(), { "type": "agentMessage", "id": "b", "text": "second", "meta": {} }], "state": {}, "hasOlder": false },
        "feed": { "id": "lead", "epoch": "e2", "seq": 1 },
    }));
    settle().await;
    rig.store.tick();
    let heard = Rig::pending_events(&mut events);
    let statuses: Vec<&StoreEvent> = heard.iter().filter(|event| matches!(event, StoreEvent::ConnectionStatus(_))).collect();
    assert!(statuses.iter().any(|event| matches!(event, StoreEvent::ConnectionStatus(ConnectionState::Reconnecting { .. }))));
    assert!(matches!(statuses.last(), Some(StoreEvent::ConnectionStatus(ConnectionState::Ready))));
    assert_eq!(rig.store.state()["items"].as_array().map(Vec::len), Some(2));
}

#[tokio::test(flavor = "current_thread")]
async fn a_sign_in_flow_is_tracked_and_a_pending_one_is_cancelled_when_the_store_is_disposed() {
    let rig = Rig::open_default().await;
    let pending = json!({ "flowId": "oauth_1", "provider": "p", "url": "http://x", "state": "pending", "manualCodeSupported": true });
    let (begun, request) = rig.answering(pending, rig.store.begin_oauth(OAuthKind::Provider, "openai", &json!({ "openBrowser": true }))).await;
    assert_eq!(begun.expect("begun")["flowId"], "oauth_1");
    assert_eq!(request["method"], "account/beginOAuthProviderLogin");
    assert_eq!((request["params"]["providerId"].clone(), request["params"]["options"].clone()), (json!("openai"), json!({ "openBrowser": true })));
    let (_, request) = rig.answering(json!({ "flowId": "oauth_1", "state": "pending" }), rig.store.oauth_status(OAuthKind::Provider, "oauth_1")).await;
    assert_eq!((request["method"].clone(), request["params"]["flowId"].clone()), (json!("account/getOAuthProviderLoginStatus"), json!("oauth_1")));
    // A flow that is no longer pending ends the wait at once.
    let (done, _) = rig.answering(json!({ "flowId": "oauth_2", "state": "complete" }), rig.store.wait_oauth(OAuthKind::Mcp, "oauth_2", Duration::from_millis(1))).await;
    assert_eq!(done.expect("waited")["state"], "complete");
    let (_, request) = rig.answering(json!({ "flowId": "oauth_3", "state": "pending" }), rig.store.begin_oauth(OAuthKind::Mcp, "srv", &json!({ "openBrowser": true }))).await;
    assert_eq!(request["method"], "mcp/beginMcpOAuthLogin");
    // Disposal cancels both pending flows, stops following the session and closes the connection.
    let mut sent = Vec::new();
    let (finished, ()) = tokio::join!(rig.store.dispose("test"), async {
        loop {
            let request = request_of(&rig.conn).await;
            let method = request["method"].as_str().unwrap_or_default().to_owned();
            reply(&rig.conn, &request, json!({ "flowId": request["params"]["flowId"], "state": "cancelled" }));
            let last = method == "thread/unsubscribe";
            sent.push((method, request["params"]["flowId"].clone()));
            if last {
                break;
            }
        }
    });
    assert!(finished);
    let cancelled: Vec<&Value> = sent.iter().filter(|(method, _)| method.ends_with("OAuthLogin") || method.ends_with("OAuthProviderLogin")).map(|(_, flow)| flow).collect();
    assert_eq!(cancelled.len(), 2);
    assert_eq!(sent.last().map(|(method, _)| method.as_str()), Some("thread/unsubscribe"));
    settle().await;
    assert_eq!(rig.conn.client_close(), Some(1000));
    // A second disposal is a no-op.
    assert!(rig.store.dispose("again").await);
}

#[tokio::test(flavor = "current_thread")]
async fn a_staged_update_is_told_once_as_the_notice_of_its_version() {
    let mut rig = Rig::open_default().await;
    let mut events = rig.store.subscribe();
    let ready = json!({ "key": "update-ready", "code": "update-ready", "params": { "version": "1.5.0" } });
    rig.app_section("notice/updated", "notice", Some("update-ready"), 1, ready.clone()).await;
    // Another notice code is not this UI's.
    rig.app_section("notice/updated", "notice", Some("other"), 1, json!({ "key": "other", "code": "other", "params": {} })).await;
    rig.app_section("notice/updated", "notice", Some("update-ready"), 2, ready).await;
    let notices: Vec<StoreEvent> = Rig::pending_events(&mut events).into_iter().filter(|event| matches!(event, StoreEvent::Notice { .. })).collect();
    assert_eq!(notices, vec![StoreEvent::Notice { text: "mixdog v1.5.0 ready \u{2014} restart to apply.".to_owned(), level: "info".to_owned() }]);
}

#[tokio::test(flavor = "current_thread")]
async fn a_session_list_reads_every_page_or_the_one_asked_for() {
    let rig = Rig::open_default().await;
    let options = json!({ "limit": 2, "cwd": "/w" });
    let (listed, pages) = tokio::join!(rig.store.call("listSessions", std::slice::from_ref(&options)), async {
        let first = request_of(&rig.conn).await;
        reply(&rig.conn, &first, json!({ "data": [{ "id": "a" }, { "id": "b" }], "nextCursor": "c2" }));
        let second = request_of(&rig.conn).await;
        reply(&rig.conn, &second, json!({ "data": [{ "id": "c" }] }));
        (first, second)
    });
    assert_eq!(listed.expect("listed"), json!([{ "id": "a" }, { "id": "b" }, { "id": "c" }]));
    assert_eq!((pages.0["method"].clone(), pages.0["params"].get("cursor").cloned()), (json!("thread/list"), None));
    assert_eq!((pages.1["params"]["cursor"].clone(), pages.1["params"]["cwd"].clone()), (json!("c2"), json!("/w")));
    let (one, request) = rig
        .answering(json!({ "data": [{ "id": "x" }], "nextCursor": "more" }), rig.store.call("listSessions", &[json!({ "page": { "limit": 1, "cursor": "k" } })]))
        .await;
    assert_eq!(one.expect("one page"), json!([{ "id": "x" }]));
    assert_eq!((request["params"]["limit"].clone(), request["params"]["cursor"].clone()), (json!(1), json!("k")));
    assert_eq!(rig.conn.queued(), 0);
}


