//! The MCP sign-in and sign-out calls when the notice they post fails, or the session they address goes away during the
//! awaited action, through the real call path: the real [`McpService`] over a scripted MCP runtime, the real session directory,
//! actor, outbox and feed. Replays `fixtures/mcp-login-notice-failures`, recorded from Node's real call route, session action
//! calls, entry lifecycle and extensions API at b6f10295a (`record-mcp-login-notice-failures.mjs`): the reply or error, the
//! order of the events and the final state of each incarnation.
//!
//! The events compared are the ones both sides have: the runtime call, the notice shown, the teardown ending, a reopen and the
//! reply. Node's service announcements of a release (`released`, the `session-gone` frame, `dispose` starting) have no MCP-visible
//! counterpart in the core. A notice Node posted that showed nothing (the posting stub returned `false`/`null`, or threw: the
//! recorded `toasts` are empty) has Rust counterparts that show nothing too, so it is no event of the shown timeline.

use std::sync::Arc;
use std::sync::atomic::Ordering::SeqCst;
use std::task::Poll;
use std::time::Duration;

use async_trait::async_trait;
use mixdog_core_api::CoreError;
use mixdog_core_api::CoreRequest;
use mixdog_core_api::DomainService;
use mixdog_core_api::Reply;
use mixdog_core_api::ThreadHandle;
use mixdog_core_api::call::CallContext;
use mixdog_core_api::ids::ConnectionId;
use mixdog_core_api::ids::Method;
use mixdog_core_api::ids::OpId;
use mixdog_core_api::ids::ThreadId;
use mixdog_mcp::mcp_service::Incarnation;
use mixdog_mcp::mcp_service::McpService;
use mixdog_mcp::mcp_service::SessionToasts;
use mixdog_mcp::scripted;
use mixdog_mcp::scripted::Park;
use mixdog_mcp::scripted::Script;
use mixdog_rt::CancellationToken;
use serde_json::Value;
use serde_json::json;
use tokio::sync::Notify;

use super::SessionDirectory;
use super::testing::EventLog;
use super::testing::Rig;
use super::testing::lock;
use crate::eventually_on;
use super::tests::start_thread;

const METHODS: [&str; 2] = ["beginMcpOAuthLogin", "signOutMcpServer"];

fn golden() -> Value {
    serde_json::from_str(include_str!("../../../../fixtures/mcp-login-notice-failures/golden.json")).expect("fixture")
}

/// The recorded cases named `name`, `method`'s.
fn recorded(name: &str, method: &str) -> Value {
    golden()["cases"].as_array().expect("cases").iter().find(|case| case["name"] == name && case["method"] == method).unwrap_or_else(|| panic!("no recording of {name} / {method}")).clone()
}

/// What the runtime answered in the recording, from the flows the notice recording drove with it.
fn runtime_result(method: &str) -> Value {
    let flows: Value = serde_json::from_str(include_str!("../../../../fixtures/mcp-login-notices/golden.json")).expect("fixture");
    let name = if method == "beginMcpOAuthLogin" { "a start that waits for the browser" } else { "a sign-out" };
    flows["flows"].as_array().unwrap().iter().find(|flow| flow["name"] == name).unwrap()["runtime"]["result"].clone()
}

/// One event of a timeline (the recording's or the core's) as a line to compare. `None` for the events only one side has.
/// `literal`: whether an error's text is part of the line.
fn kind(event: &Value, literal: bool) -> Option<String> {
    if event.get("runtime").is_some() {
        return Some("runtime".to_owned());
    }
    if let Some(notice) = event.get("notice") {
        return Some(format!("notice {} {} {}", event["incarnation"].as_str().unwrap(), notice["text"].as_str().unwrap(), notice["tone"].as_str().unwrap()));
    }
    if event.get("teardown").is_some() || event.get("disposed").is_some() {
        return Some("teardown".to_owned());
    }
    if let Some(label) = event.get("created") {
        return Some(format!("created {}", label.as_str().unwrap()));
    }
    event.get("reply").map(|reply| match reply["error"].as_str() {
        Some(message) if literal => format!("error {message}"),
        Some(_) => "error".to_owned(),
        None => "ok".to_owned(),
    })
}

/// The recording's events as lines: its first `created` is the setup, its notices are dropped when `shown_only` and the recorded
/// toasts say none was shown.
fn recorded_kinds(case: &Value, literal: bool, hidden: &[&str]) -> Vec<String> {
    let mut created = 0;
    case["events"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|event| {
            if event.get("created").is_some() {
                created += 1;
                return created > 1;
            }
            !(event.get("notice").is_some() && hidden.contains(&event["incarnation"].as_str().unwrap()))
        })
        .filter_map(|event| kind(event, literal))
        .collect()
}

fn core_kinds(timeline: &EventLog, literal: bool) -> Vec<String> {
    lock(timeline).iter().filter_map(|event| kind(event, literal)).collect()
}

/// A session that posts a notice tells `queued` once the post has reached the session's inbox, whatever the thread scheduling.
struct Watched {
    directory: Arc<SessionDirectory>,
    queued: Arc<Notify>,
}

struct Posting {
    session: Arc<dyn Incarnation>,
    queued: Arc<Notify>,
}

impl SessionToasts for Watched {
    fn closed(&self) -> bool {
        self.directory.closed()
    }

    fn incarnation(&self, thread: &str) -> Option<Arc<dyn Incarnation>> {
        let session = self.directory.incarnation(thread)?;
        Some(Arc::new(Posting { session, queued: self.queued.clone() }))
    }
}

#[async_trait]
impl Incarnation for Posting {
    async fn toast(&self, text: &str, tone: &str) -> Result<(), String> {
        let post = self.session.toast(text, tone);
        tokio::pin!(post);
        // The first poll sends the toast to the inbox; it answers later.
        if let Poll::Ready(done) = futures::poll!(post.as_mut()) {
            return done;
        }
        self.queued.notify_one();
        post.await
    }

    fn disposed(&self) -> bool {
        self.session.disposed()
    }
}

struct World {
    rig: Rig,
    directory: Arc<SessionDirectory>,
    service: Arc<McpService>,
    timeline: EventLog,
    park: Arc<Park>,
    queued: Arc<Notify>,
    method: &'static str,
}

impl World {
    fn new(method: &'static str) -> Self {
        let rig = Rig::new();
        let timeline: EventLog = Arc::default();
        *lock(&rig.feeds.timeline) = Some(timeline.clone());
        *lock(&rig.closes.timeline) = Some(timeline.clone());
        let directory = Arc::new(SessionDirectory::new(rig.deps()));
        let script: Script = Arc::new(std::sync::Mutex::new(json!({ "result": runtime_result(method) })));
        let park = Arc::new(Park::default());
        let queued = Arc::new(Notify::new());
        let toasts = Arc::new(Watched { directory: directory.clone(), queued: queued.clone() });
        let service = Arc::new(scripted::service(script, timeline.clone(), Some(park.clone()), toasts));
        Self { rig, directory, service, timeline, park, queued, method }
    }

    /// The call `/mcp ...` makes on `thread`, answering `{result}` or `{error}` as the recording's envelope did.
    fn call(&self, thread: &ThreadId) -> tokio::task::JoinHandle<Value> {
        let (service, thread) = (self.service.clone(), thread.as_str().to_owned());
        let method: &'static str = Box::leak(format!("mcp/{}", self.method).into_boxed_str());
        tokio::spawn(async move {
            let params = json!({ "name": "linear", "threadId": thread });
            match service.call(CoreRequest { method: Method(method), params, op: None, ctx: CallContext::internal("test") }).await {
                Ok(Reply::Value(value)) => json!({ "result": value }),
                Err(CoreError::DomainError { message: Some(message), .. }) => json!({ "error": &*message }),
                other => panic!("unexpected outcome {other:?}"),
            }
        })
    }

    /// The reply of `call`, told to the timeline as the recording's `reply` event.
    async fn reply(&self, call: tokio::task::JoinHandle<Value>) -> Value {
        let reply = call.await.expect("the call ends");
        lock(&self.timeline).push(json!({ "reply": reply }));
        reply
    }

    /// The call, parked in the middle of the runtime action.
    async fn parked(&self, thread: &ThreadId) -> tokio::task::JoinHandle<Value> {
        let call = self.call(thread);
        self.park.entered.notified().await;
        call
    }

    /// The toasts `instance`-th incarnation of the thread showed, in order, as `(text, tone)`.
    fn shown(&self, thread: &ThreadId, instance: usize) -> Vec<(String, String)> {
        let histories = self.rig.feeds.histories(thread.as_str());
        let mut seen = Vec::new();
        let mut shown = Vec::new();
        for (_, frame) in &histories[instance] {
            if frame["method"] != "thread/runtime/updated" {
                continue;
            }
            for toast in frame["params"]["value"]["toasts"].as_array().into_iter().flatten() {
                if !seen.contains(&toast["id"]) {
                    seen.push(toast["id"].clone());
                    shown.push((toast["text"].as_str().unwrap().to_owned(), toast["tone"].as_str().unwrap().to_owned()));
                }
            }
        }
        shown
    }
}

fn recorded_toasts(case: &Value, incarnation: usize) -> Vec<(String, String)> {
    case["state"]["incarnations"][incarnation]["toasts"]
        .as_array()
        .unwrap()
        .iter()
        .map(|toast| (toast["text"].as_str().unwrap().to_owned(), toast["tone"].as_str().unwrap().to_owned()))
        .collect()
}

/// The last subscriber of an idle thread leaves and its idle delay passes: it unloads and its close work (the memory ingest)
/// starts.
async fn unload(handle: &super::SessionHandle) {
    assert!(handle.cell.subscribing());
    handle.cell.subscribed(true);
    super::tests::left_idle(handle).await;
}

/// The recording's envelope: `{result: {value, sessionId}}` or `{error}`; the core answers the value.
fn recorded_reply(case: &Value) -> Value {
    recorded_reply_of(&case["envelope"])
}

/// A posting Node's surface ignored (the stub returned `false` or `null`) is, in the core, a post to a session no runtime hosts:
/// accepted, shown to no one, the reply as it was.
#[tokio::test(start_paused = true)]
async fn a_post_that_shows_nothing_keeps_the_reply() {
    for method in METHODS {
        for name in ["a notice posting that returns false", "a notice posting that returns null"] {
            let case = recorded(name, method);
            let world = World::new(method);
            let cold = ThreadId::from("cold");
            let call = world.parked(&cold).await;
            world.park.go.notify_one();
            let reply = world.reply(call).await;
            assert_eq!(reply, recorded_reply(&case), "{name} / {method}: reply");
            assert_eq!(core_kinds(&world.timeline, true), recorded_kinds(&case, true, &["A"]), "{name} / {method}: events");
            assert!(recorded_toasts(&case, 0).is_empty());
        }
    }
}

/// A toast the session dropped for a record it could not store rejects the call with that cause; the action's effect stands.
/// Node's counterpart is the posting that throws: the call rejects with the throw, the action ran, nothing is shown.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_toast_the_store_drops_rejects_the_call_with_its_cause() {
    for method in METHODS {
        let case = recorded("a notice posting that throws", method);
        let world = World::new(method);
        let handle = start_thread(&world.directory).await;
        let call = world.parked(&handle.id).await;

        // An earlier record is held at the store, unacknowledged and bound to fail.
        let (arrived, go) = (Arc::new(Notify::new()), std::sync::mpsc::channel());
        *lock(&world.rig.store.commit_gate) = Some((arrived.clone(), go.1));
        let renamed = {
            let (handle, id) = (handle.clone(), handle.id.clone());
            tokio::spawn(async move {
                let rename = CoreRequest {
                    method: Method("thread/name/set"),
                    params: json!({ "threadId": id, "opId": "op-name", "title": "renamed" }),
                    op: Some(OpId::from("op-name")),
                    ctx: CallContext::connection(ConnectionId(1), mixdog_protocol::Origin::Local, CancellationToken::new()),
                };
                handle.request(rename).await
            })
        };
        arrived.notified().await;

        // The action ends and its notice is queued behind that record, taken by the actor.
        world.park.go.notify_one();
        world.queued.notified().await;
        let (tx, taken) = tokio::sync::oneshot::channel();
        handle.inbox.send(super::actor::Inbox::QuotaFacts { tx }).await.expect("the actor takes the inbox");
        taken.await.expect("the actor answers");

        world.rig.store.fail_next.store(true, SeqCst);
        go.0.send(()).expect("the commit waits");
        let cause = renamed.await.expect("joined").expect_err("the record was not stored").to_string();
        let reply = world.reply(call).await;

        assert_eq!(reply, json!({ "error": cause }), "{method}: the call carries the cause's message");
        assert_eq!(core_kinds(&world.timeline, false), recorded_kinds(&case, false, &["A"]), "{method}: events");
        assert_eq!(world.shown(&handle.id, 0), recorded_toasts(&case, 0), "{method}: nothing is shown");
        assert!(!handle.cell.closed.load(SeqCst), "{method}: the session lives");
        assert_eq!(world.directory.loaded_ids().len(), case["state"]["service"]["sessions"].as_u64().unwrap() as usize);
    }
}

/// The session unloaded during the action: its notice still goes to that runtime, then the call answers `session runtime is
/// disposed`, though the thread stays loadable.
#[tokio::test(start_paused = true)]
async fn a_session_unloaded_during_the_action_is_disposed_after_its_notice() {
    for method in METHODS {
        let case = recorded("the session disposed during the action", method);
        let world = World::new(method);
        let handle = start_thread(&world.directory).await;
        let call = world.parked(&handle.id).await;

        unload(&handle).await;
        eventually_on!(&[world.directory.left()], || world.directory.handle(&handle.id).is_none().then_some(())).await;
        world.rig.closes.ended.notified().await;
        world.park.go.notify_one();
        let reply = world.reply(call).await;

        assert_eq!(reply, recorded_reply(&case), "{method}: reply");
        assert_eq!(core_kinds(&world.timeline, true), recorded_kinds(&case, true, &["A"]), "{method}: events");
        assert!(world.shown(&handle.id, 0).is_empty(), "{method}: a runtime that ended shows its notice to no one (Node holds it in the disposed state)");
        let state = &case["state"]["incarnations"][0];
        assert_eq!(handle.cell.closed.load(SeqCst), state["entryDisposed"].as_bool().unwrap(), "{method}: disposed");
        assert_eq!(world.directory.loaded_ids().len(), case["state"]["service"]["sessions"].as_u64().unwrap() as usize);
    }
}

/// The service closes during the action, or before the call: the first posts its notice and answers `session service is
/// closed`, the second answers it alone, with no runtime call and no notice.
#[tokio::test(start_paused = true)]
async fn a_closed_service_answers_after_the_notice_or_alone() {
    for method in METHODS {
        let during = recorded("the service closed during the action", method);
        let world = World::new(method);
        let handle = start_thread(&world.directory).await;
        let call = world.parked(&handle.id).await;
        world.directory.begin_close();
        world.park.go.notify_one();
        let reply = world.reply(call).await;
        assert_eq!(reply, recorded_reply(&during), "{method}: reply during");
        assert_eq!(core_kinds(&world.timeline, true), recorded_kinds(&during, true, &[]), "{method}: events during");
        assert_eq!(world.shown(&handle.id, 0), recorded_toasts(&during, 0));
        assert_eq!(handle.cell.closed.load(SeqCst), during["state"]["incarnations"][0]["entryDisposed"].as_bool().unwrap());
        assert_eq!(world.directory.loaded_ids().len(), during["state"]["service"]["sessions"].as_u64().unwrap() as usize);

        let before = recorded("the service closed before the call starts", method);
        let world = World::new(method);
        let handle = start_thread(&world.directory).await;
        world.directory.begin_close();
        let reply = world.reply(world.call(&handle.id)).await;
        assert_eq!(reply, recorded_reply(&before), "{method}: reply before");
        assert_eq!(core_kinds(&world.timeline, true), recorded_kinds(&before, true, &[]), "{method}: events before");
        assert_eq!(world.shown(&handle.id, 0), recorded_toasts(&before, 0));
        assert_eq!(world.directory.loaded_ids().len(), before["state"]["service"]["sessions"].as_u64().unwrap() as usize);
    }
}

/// The daemon's shutdown is what closes the service (`stop()` sets `closed` first).
#[tokio::test(start_paused = true)]
async fn the_shutdown_closes_the_service_for_the_calls() {
    for method in METHODS {
        let world = World::new(method);
        let handle = start_thread(&world.directory).await;
        assert!(!world.directory.is_closed());
        world.directory.shutdown_for("daemon shutdown").await;
        assert!(world.directory.is_closed());
        let reply = world.reply(world.call(&handle.id)).await;
        assert_eq!(reply, json!({ "error": "session service is closed" }), "{method}");
    }
}

/// A thread reopened while its previous runtime still closes: the new runtime is created only after that teardown ends, the old
/// call answers `session runtime is disposed` after the old runtime's notice, and each incarnation keeps its own toast.
#[tokio::test(start_paused = true)]
async fn a_reopen_waits_for_the_previous_runtimes_teardown() {
    for method in METHODS {
        let case = recorded("the session reopened while the previous teardown is pending", method);
        let world = World::new(method);
        *lock(&world.rig.closes.delay) = Duration::from_secs(10);
        let handle = start_thread(&world.directory).await;
        let first = world.parked(&handle.id).await;

        unload(&handle).await;
        eventually_on!(&[world.directory.left()], || world.directory.handle(&handle.id).is_none().then_some(())).await;
        let ctx = CallContext::connection(ConnectionId(1), mixdog_protocol::Origin::Local, CancellationToken::new());
        let mut reopen = Box::pin(world.directory.open_handle(&handle.id, &ctx));
        assert!(futures::poll!(reopen.as_mut()).is_pending(), "{method}: the reopen waits for the teardown");

        world.park.go.notify_one();
        let old = world.reply(first).await;
        assert_eq!(old, recorded_reply_of(&case["envelope"]["oldIncarnation"]), "{method}: the old call");
        tokio::time::advance(Duration::from_secs(9)).await;
        assert!(futures::poll!(reopen.as_mut()).is_pending(), "{method}: still closing");
        assert!(world.directory.handle(&handle.id).is_none(), "{method}: no new runtime yet");

        tokio::time::advance(Duration::from_secs(1)).await;
        let reopened = reopen.await.expect("the thread opens again");
        lock(&world.timeline).push(json!({ "created": "B" }));
        assert!(!Arc::ptr_eq(&reopened.cell, &handle.cell));

        let second = world.parked(&reopened.id).await;
        world.park.go.notify_one();
        let new = world.reply(second).await;
        assert_eq!(new, recorded_reply_of(&case["envelope"]["newIncarnation"]), "{method}: the new call");

        assert_eq!(core_kinds(&world.timeline, true), recorded_kinds(&case, true, &["A"]), "{method}: events");
        assert!(world.shown(&handle.id, 0).is_empty(), "{method}: the old runtime shows nothing");
        assert_eq!(world.shown(&handle.id, 1), recorded_toasts(&case, 1), "{method}: the new toast");
        assert_eq!(handle.cell.closed.load(SeqCst), case["state"]["incarnations"][0]["entryDisposed"].as_bool().unwrap());
        assert_eq!(reopened.cell.closed.load(SeqCst), case["state"]["incarnations"][1]["entryDisposed"].as_bool().unwrap());
        assert_eq!(world.directory.loaded_ids().len(), case["state"]["service"]["sessions"].as_u64().unwrap() as usize);
    }
}

fn recorded_reply_of(envelope: &Value) -> Value {
    match envelope["body"]["error"].as_str() {
        Some(error) => json!({ "error": error }),
        None => json!({ "result": envelope["body"]["result"]["value"] }),
    }
}
