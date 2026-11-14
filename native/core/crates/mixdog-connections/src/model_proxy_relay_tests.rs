//! The relay against the real client engine over the mock transport: the server side is scripted frame by frame.

use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use mixdog_app_protocol::v2::model_proxy::{
    ProxyAnswer, ProxyCall, ProxyDelivery, ProxyErrorKind, ProxyEvent, ProxyFailure, ProxyOutcome,
};
use mixdog_app_server_client::mock::{MockConn, MockNetwork};
use mixdog_app_server_client::{
    Clock, ConnectOptions, DEFAULT_LADDER, InitializeCapabilities, ProtocolClient, Target, connect,
};
use serde_json::{Value, json};
use tokio::sync::{mpsc, oneshot};
use tokio::task::JoinHandle;
use tokio_util::sync::CancellationToken;

use super::{AllowedProviders, LocalModelProxy, ModelProxyRelay, ProxyEventSink};

const OPTIONS: &str = include_str!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../../../packages/protocol-client/conformance/options.json"
));

struct PausedClock;

#[async_trait]
impl Clock for PausedClock {
    async fn sleep(&self, ms: u64) {
        mixdog_rt::time::sleep(std::time::Duration::from_millis(ms)).await;
    }
    fn jitter(&self) -> f64 {
        0.0
    }
}

/// One call the fake local core took up, and the way to answer it.
struct Started {
    call: ProxyCall,
    allowed: Option<Vec<String>>,
    events: Arc<dyn ProxyEventSink>,
    cancel: CancellationToken,
    answer: oneshot::Sender<Result<ProxyAnswer, String>>,
}

struct FakeLocal(mpsc::UnboundedSender<Started>);

#[async_trait]
impl LocalModelProxy for FakeLocal {
    async fn run(
        &self,
        call: ProxyCall,
        allowed: Option<Vec<String>>,
        events: Arc<dyn ProxyEventSink>,
        cancel: CancellationToken,
    ) -> Result<ProxyAnswer, String> {
        let (answer, wait) = oneshot::channel();
        let _ = self.0.send(Started { call, allowed, events, cancel, answer });
        wait.await.unwrap_or_else(|_| Err("never answered".into()))
    }
}

struct Rig {
    net: Arc<MockNetwork>,
    conn: MockConn,
    relay: Arc<ModelProxyRelay>,
    calls: mpsc::UnboundedReceiver<Started>,
    task: JoinHandle<()>,
}

async fn handshake(net: &MockNetwork, instance: &str) -> MockConn {
    let options: Value = serde_json::from_str(OPTIONS).unwrap();
    let conn = net.accept().await;
    let init: Value = serde_json::from_str(&conn.next_sent().await).unwrap();
    let mut result = options["initializeResult"].clone();
    result["serverInstanceId"] = json!(instance);
    conn.server_send(&json!({ "id": init["id"], "result": result }));
    conn.next_sent().await; // initialized
    conn
}

async fn rig(allowed: AllowedProviders) -> Rig {
    let options: Value = serde_json::from_str(OPTIONS).unwrap();
    let mut capabilities: InitializeCapabilities = serde_json::from_value(options["capabilities"].clone()).unwrap();
    capabilities.model_proxy = Some(true);
    let net = Arc::new(MockNetwork::default());
    let connecting = tokio::spawn(connect(ConnectOptions {
        target: Target { id: "server".into() },
        connector: net.clone(),
        client_info: serde_json::from_value(options["clientInfo"].clone()).unwrap(),
        capabilities,
        thread_reducer: None,
        clock: Arc::new(PausedClock),
        new_op_id: None,
        ladder: DEFAULT_LADDER,
    }));
    let conn = handshake(&net, "s1").await;
    let client: Arc<dyn ProtocolClient> = Arc::new(connecting.await.unwrap().unwrap());
    let (started, calls) = mpsc::unbounded_channel();
    let relay = ModelProxyRelay::new(client, Arc::new(FakeLocal(started)), allowed);
    let task = relay.serve();
    Rig { net, conn, relay, calls, task }
}

fn all_providers() -> AllowedProviders {
    Arc::new(|| None)
}

async fn frame(conn: &MockConn) -> Value {
    serde_json::from_str(&conn.next_sent().await).unwrap()
}

async fn settle() {
    for _ in 0..50 {
        tokio::task::yield_now().await;
    }
}

fn execute(conn: &MockConn, id: Value) {
    conn.server_send(&json!({ "id": id, "method": "model/proxy/execute", "params": { "call": { "method": "providerConfig" } } }));
}

fn cancel(conn: &MockConn, request_id: Value) {
    conn.server_send(&json!({ "method": "model/proxy/cancel", "params": { "requestId": request_id } }));
}

fn beat(ids: Value) -> Value {
    json!({ "method": "model/proxy/heartbeat", "params": { "requestIds": ids } })
}

fn route() -> Result<ProxyAnswer, String> {
    Ok(ProxyAnswer::Route { route: None })
}

fn route_response(id: Value) -> Value {
    json!({ "id": id, "result": { "result": { "result": "route", "route": null } } })
}

fn failure(message: &str) -> ProxyFailure {
    ProxyFailure {
        outcome: ProxyOutcome::Provider,
        kind: ProxyErrorKind::RateLimited,
        code: None,
        status: Some(429),
        retry_after_ms: None,
        reset_at_ms: None,
        quota_scope: None,
        reauth_required: false,
        should_retry: None,
        text_emitted: false,
        tool_dispatched: false,
        tool_input_cut: false,
        delivery: ProxyDelivery::NotSent,
        transport: None,
        message: message.into(),
        partial_usage: None,
        partial_model: None,
        verification_url: None,
        rejected_tool: None,
        account_blocked: false,
        unsafe_to_retry: false,
        quota_limit: None,
        notices: Vec::new(),
    }
}

fn subset(frame: &Value, keys: &[&str]) -> Value {
    Value::Object(keys.iter().filter_map(|k| frame.get(*k).map(|v| ((*k).to_owned(), v.clone()))).collect())
}

#[tokio::test(flavor = "current_thread", start_paused = true)]
async fn heartbeat_first_beat_claims_and_one_beat_names_every_running_request() {
    let mut rig = rig(all_providers()).await;
    execute(&rig.conn, json!(7));
    assert_eq!(subset(&frame(&rig.conn).await, &["method", "params"]), beat(json!([7])), "the first beat is the claim");
    let first = rig.calls.recv().await.unwrap();
    execute(&rig.conn, json!("b"));
    assert_eq!(subset(&frame(&rig.conn).await, &["method", "params"]), beat(json!(["b"])));
    let second = rig.calls.recv().await.unwrap();

    assert_eq!(subset(&frame(&rig.conn).await, &["method", "params"]), beat(json!([7, "b"])), "five seconds on");
    assert_eq!(rig.relay.running(), 2);
    first.answer.send(route()).unwrap();
    assert_eq!(subset(&frame(&rig.conn).await, &["id", "result"]), route_response(json!(7)));
    assert_eq!(subset(&frame(&rig.conn).await, &["method", "params"]), beat(json!(["b"])));
    second.answer.send(route()).unwrap();
    assert_eq!(subset(&frame(&rig.conn).await, &["id", "result"]), route_response(json!("b")));
    settle().await;
    assert_eq!(rig.relay.running(), 0);
    mixdog_rt::time::sleep(std::time::Duration::from_secs(20)).await;
    assert_eq!(rig.conn.queued(), 0, "nothing running, nothing vouched for");
}

#[tokio::test(flavor = "current_thread", start_paused = true)]
async fn cancel_maps_to_token_of_the_run_that_request_started() {
    let mut rig = rig(all_providers()).await;
    execute(&rig.conn, json!(7));
    execute(&rig.conn, json!("b"));
    let first = rig.calls.recv().await.unwrap();
    let second = rig.calls.recv().await.unwrap();

    cancel(&rig.conn, json!("b"));
    settle().await;
    assert!(second.cancel.is_cancelled());
    assert!(!first.cancel.is_cancelled());
    cancel(&rig.conn, json!("7"));
    settle().await;
    assert!(!first.cancel.is_cancelled(), "the id 7 and the id \"7\" are different requests");
    cancel(&rig.conn, json!(7));
    settle().await;
    assert!(first.cancel.is_cancelled());
}

#[tokio::test(flavor = "current_thread", start_paused = true)]
async fn a_cancel_of_a_request_the_pc_never_ran_or_that_is_over_is_dropped() {
    let mut rig = rig(all_providers()).await;
    cancel(&rig.conn, json!(99));
    execute(&rig.conn, json!(1));
    let started = rig.calls.recv().await.unwrap();
    settle().await;
    assert!(!started.cancel.is_cancelled());
    started.answer.send(route()).unwrap();
    for _ in 0..2 {
        frame(&rig.conn).await; // claim, answer
    }
    cancel(&rig.conn, json!(1));
    settle().await;
    assert!(!started.cancel.is_cancelled(), "a call that is over has nothing to stop");
}

#[tokio::test(flavor = "current_thread", start_paused = true)]
async fn every_run_carries_the_host_list_as_it_stands_at_that_call() {
    let list: Arc<Mutex<Option<Vec<String>>>> = Arc::new(Mutex::new(Some(vec!["anthropic".into()])));
    let read = list.clone();
    let mut rig = rig(Arc::new(move || read.lock().unwrap().clone())).await;
    let mut seen = Vec::new();
    for (id, next) in [(1, Some(vec![])), (2, None), (3, None)] {
        execute(&rig.conn, json!(id));
        let started = rig.calls.recv().await.unwrap();
        assert!(matches!(started.call, ProxyCall::ProviderConfig));
        seen.push(started.allowed);
        *list.lock().unwrap() = next;
    }
    assert_eq!(seen, [Some(vec!["anthropic".to_owned()]), Some(vec![]), None]);
}

#[tokio::test(flavor = "current_thread", start_paused = true)]
async fn events_go_back_by_request_id_ahead_of_the_answer() {
    let mut rig = rig(all_providers()).await;
    execute(&rig.conn, json!(3));
    frame(&rig.conn).await; // claim
    let started = rig.calls.recv().await.unwrap();
    started.events.event(ProxyEvent::TextDelta { text: "hi".into() });
    // An event the run wrote just before answering still comes first.
    started.events.event(ProxyEvent::TextDelta { text: "!".into() });
    started.answer.send(route()).unwrap();
    for text in ["hi", "!"] {
        let sent = frame(&rig.conn).await;
        assert_eq!(
            subset(&sent, &["method", "params"]),
            json!({ "method": "model/proxy/event", "params": { "requestId": 3, "event": { "type": "textDelta", "text": text } } })
        );
    }
    assert_eq!(subset(&frame(&rig.conn).await, &["id", "result"]), route_response(json!(3)));
}

#[tokio::test(flavor = "current_thread", start_paused = true)]
async fn a_failed_call_answers_as_the_error_of_the_request_with_the_failure_as_its_data() {
    let mut rig = rig(all_providers()).await;
    execute(&rig.conn, json!(4));
    execute(&rig.conn, json!(5));
    for _ in 0..2 {
        frame(&rig.conn).await; // claims
    }
    let first = rig.calls.recv().await.unwrap();
    let second = rig.calls.recv().await.unwrap();
    let failed = failure("slow down");
    first.answer.send(Ok(ProxyAnswer::Failed { failure: failed.clone() })).unwrap();
    second.answer.send(Err("the local core is gone".into())).unwrap();
    assert_eq!(
        subset(&frame(&rig.conn).await, &["id", "error"]),
        json!({ "id": 4, "error": { "code": -32000, "message": "slow down", "data": serde_json::to_value(&failed).unwrap() } })
    );
    assert_eq!(
        subset(&frame(&rig.conn).await, &["id", "error"]),
        json!({ "id": 5, "error": { "code": -32000, "message": "the local core is gone" } })
    );
}

#[tokio::test(flavor = "current_thread", start_paused = true)]
async fn abandon_on_link_loss_stops_every_call_and_leaves_them_unanswered() {
    let mut rig = rig(all_providers()).await;
    execute(&rig.conn, json!(1));
    execute(&rig.conn, json!(2));
    for _ in 0..2 {
        frame(&rig.conn).await; // claims
    }
    let first = rig.calls.recv().await.unwrap();
    let second = rig.calls.recv().await.unwrap();

    rig.conn.server_close(1006, "gone");
    let conn = handshake(&rig.net, "s1").await;
    settle().await;
    assert!(first.cancel.is_cancelled() && second.cancel.is_cancelled());
    assert_eq!(rig.relay.running(), 0);
    first.answer.send(route()).unwrap();
    second.answer.send(Err("cancelled".into())).unwrap();
    mixdog_rt::time::sleep(std::time::Duration::from_secs(20)).await;
    assert_eq!(conn.queued(), 0, "no answer and no beat of an abandoned call");

    // The server's ids restart on the next link: the new call is its own run and is answered.
    execute(&conn, json!(1));
    frame(&conn).await; // claim
    rig.calls.recv().await.unwrap().answer.send(route()).unwrap();
    assert_eq!(subset(&frame(&conn).await, &["id", "result"]), route_response(json!(1)));
}

#[tokio::test(flavor = "current_thread", start_paused = true)]
async fn revoke_gives_up_the_calls_in_flight_and_takes_up_new_ones_again() {
    let mut rig = rig(all_providers()).await;
    execute(&rig.conn, json!(1));
    frame(&rig.conn).await; // claim
    let started = rig.calls.recv().await.unwrap();
    rig.relay.revoke();
    assert!(started.cancel.is_cancelled());
    assert_eq!(rig.relay.running(), 0);
    started.answer.send(route()).unwrap();
    mixdog_rt::time::sleep(std::time::Duration::from_secs(20)).await;
    assert_eq!(rig.conn.queued(), 0);

    execute(&rig.conn, json!(2));
    frame(&rig.conn).await; // claim
    rig.calls.recv().await.unwrap().answer.send(route()).unwrap();
    assert_eq!(subset(&frame(&rig.conn).await, &["id", "result"]), route_response(json!(2)));
}

#[tokio::test(flavor = "current_thread", start_paused = true)]
async fn a_server_on_its_own_logins_is_not_claimed() {
    let mut rig = rig(all_providers()).await;
    rig.relay.serving(false);
    execute(&rig.conn, json!(1));
    settle().await;
    assert_eq!(rig.conn.queued(), 0, "not even a claim");
    assert!(rig.calls.try_recv().is_err());
    assert_eq!(rig.relay.running(), 0);

    rig.relay.serving(true);
    execute(&rig.conn, json!(2));
    assert_eq!(subset(&frame(&rig.conn).await, &["method", "params"]), beat(json!([2])));
    rig.calls.recv().await.unwrap();
}

#[tokio::test(flavor = "current_thread", start_paused = true)]
async fn a_stopped_relay_abandons_its_calls_and_takes_up_nothing_more() {
    let mut rig = rig(all_providers()).await;
    execute(&rig.conn, json!(1));
    frame(&rig.conn).await; // claim
    let started = rig.calls.recv().await.unwrap();
    rig.task.abort();
    rig.relay.abandon_all();
    assert!(started.cancel.is_cancelled());
    execute(&rig.conn, json!(2));
    started.answer.send(route()).unwrap();
    mixdog_rt::time::sleep(std::time::Duration::from_secs(20)).await;
    assert_eq!(rig.conn.queued(), 0);
    assert!(rig.calls.try_recv().is_err());
}
