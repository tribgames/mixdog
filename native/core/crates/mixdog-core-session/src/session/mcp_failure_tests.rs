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
use super::tests::start_thread;
use crate::eventually_on;

const METHODS: [&str; 2] = ["beginMcpOAuthLogin", "signOutMcpServer"];

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

/// The last subscriber of an idle thread leaves and its idle delay passes: it unloads and its close work (the memory ingest)
/// starts.
async fn unload(handle: &super::SessionHandle) {
    assert!(handle.cell.subscribing());
    handle.cell.subscribed(true);
    super::tests::left_idle(handle).await;
}

const BEGIN_RESULT: &str = r#"{"flowId":"mcp_oauth_1","state":"pending","url":"https://auth.example/authorize?state=abc"}"#;
const SIGN_OUT_RESULT: &str = r#"{"servers":[{"name":"linear","status":"connected"}],"revoked":true}"#;

/// What the scripted MCP runtime answers `method`.
fn runtime_result(method: &str) -> Value {
    serde_json::from_str(if method == "beginMcpOAuthLogin" { BEGIN_RESULT } else { SIGN_OUT_RESULT }).unwrap()
}

/// The notice a call posts to the session once its action ran.
fn notice_of(method: &str) -> (&'static str, &'static str) {
    if method == "beginMcpOAuthLogin" { ("mcp sign-in started: linear", "info") } else { ("mcp signed out: linear", "info") }
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

    /// The call `/mcp ...` makes on `thread`: `{result}` or `{error}`.
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

    async fn reply(&self, call: tokio::task::JoinHandle<Value>) -> Value {
        call.await.expect("the call ends")
    }

    /// The call, parked in the middle of the runtime action.
    async fn parked(&self, thread: &ThreadId) -> tokio::task::JoinHandle<Value> {
        let call = self.call(thread);
        self.park.entered.notified().await;
        call
    }

    /// Whether the scripted runtime was called.
    fn runtime_called(&self) -> bool {
        lock(&self.timeline).iter().any(|event| event.get("runtime").is_some())
    }

    /// The toasts the `instance`-th incarnation of the thread showed, in order, as `(text, tone)`.
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

fn notice(method: &str) -> Vec<(String, String)> {
    let (text, tone) = notice_of(method);
    vec![(text.to_owned(), tone.to_owned())]
}

/// The daemon's shutdown closes the service: a call answers that and nothing else.
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

/// A notice posted to a session no runtime hosts shows to no one, and the call still answers the runtime's result.
#[tokio::test(start_paused = true)]
async fn a_post_to_a_session_nobody_hosts_keeps_the_reply() {
    for method in METHODS {
        let world = World::new(method);
        let cold = ThreadId::from("cold");
        let call = world.parked(&cold).await;
        world.park.go.notify_one();
        let reply = world.reply(call).await;
        assert_eq!(reply, json!({ "result": runtime_result(method) }), "{method}");
    }
}

/// A toast the session dropped for a record it could not store rejects the call with that cause; the action's effect stands.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_toast_the_store_drops_rejects_the_call_with_its_cause() {
    for method in METHODS {
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
        assert!(world.runtime_called(), "{method}: the action ran");
        assert!(world.shown(&handle.id, 0).is_empty(), "{method}: nothing is shown");
        assert!(!handle.cell.closed.load(SeqCst), "{method}: the session lives");
        assert_eq!(world.directory.loaded_ids().len(), 1);
    }
}

/// The session unloaded during the action: the call answers `session runtime is disposed`, though the thread stays loadable.
#[tokio::test(start_paused = true)]
async fn a_session_unloaded_during_the_action_is_disposed_after_its_notice() {
    for method in METHODS {
        let world = World::new(method);
        let handle = start_thread(&world.directory).await;
        let call = world.parked(&handle.id).await;

        unload(&handle).await;
        eventually_on!(&[world.directory.left()], || world.directory.handle(&handle.id).is_none().then_some(())).await;
        world.rig.closes.ended.notified().await;
        world.park.go.notify_one();
        let reply = world.reply(call).await;

        assert_eq!(reply, json!({ "error": "session runtime is disposed" }), "{method}");
        assert!(world.shown(&handle.id, 0).is_empty(), "{method}: a runtime that ended shows its notice to no one");
        assert!(handle.cell.closed.load(SeqCst), "{method}: the runtime is disposed");
        assert!(world.directory.loaded_ids().is_empty(), "{method}: no session is left loaded");
    }
}

/// The service closes during the action: the notice is posted and the call answers `session service is closed`. Closed before the
/// call, it answers that alone: no runtime call, no notice.
#[tokio::test(start_paused = true)]
async fn a_closed_service_answers_after_the_notice_or_alone() {
    for method in METHODS {
        let world = World::new(method);
        let handle = start_thread(&world.directory).await;
        let call = world.parked(&handle.id).await;
        world.directory.begin_close();
        world.park.go.notify_one();
        let reply = world.reply(call).await;
        assert_eq!(reply, json!({ "error": "session service is closed" }), "{method}: during");
        assert_eq!(world.shown(&handle.id, 0), notice(method), "{method}: the notice was posted");
        assert!(!handle.cell.closed.load(SeqCst), "{method}: the session is not disposed");

        let world = World::new(method);
        let handle = start_thread(&world.directory).await;
        world.directory.begin_close();
        let reply = world.reply(world.call(&handle.id)).await;
        assert_eq!(reply, json!({ "error": "session service is closed" }), "{method}: before");
        assert!(!world.runtime_called(), "{method}: the runtime is not called");
        assert!(world.shown(&handle.id, 0).is_empty(), "{method}: no notice");
    }
}

/// A thread reopened while its previous runtime still closes: the new runtime is created only after that teardown ends, the old
/// call answers `session runtime is disposed`, and the new call's notice shows on the new runtime alone.
#[tokio::test(start_paused = true)]
async fn a_reopen_waits_for_the_previous_runtimes_teardown() {
    for method in METHODS {
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
        assert_eq!(old, json!({ "error": "session runtime is disposed" }), "{method}: the old call");
        tokio::time::advance(Duration::from_secs(9)).await;
        assert!(futures::poll!(reopen.as_mut()).is_pending(), "{method}: still closing");
        assert!(world.directory.handle(&handle.id).is_none(), "{method}: no new runtime yet");

        tokio::time::advance(Duration::from_secs(1)).await;
        let reopened = reopen.await.expect("the thread opens again");
        assert!(!Arc::ptr_eq(&reopened.cell, &handle.cell));

        let second = world.parked(&reopened.id).await;
        world.park.go.notify_one();
        let new = world.reply(second).await;
        assert_eq!(new, json!({ "result": runtime_result(method) }), "{method}: the new call");

        assert!(world.shown(&handle.id, 0).is_empty(), "{method}: the old runtime shows nothing");
        assert_eq!(world.shown(&handle.id, 1), notice(method), "{method}: the new notice");
        assert!(handle.cell.closed.load(SeqCst));
        assert!(!reopened.cell.closed.load(SeqCst));
    }
}
