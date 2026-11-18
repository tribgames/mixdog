//! A model-proxy run answers on the socket its request arrived on, or not at all. The relay is driven by hand (its events are handed
//! to it one at a time, so the order is the test's) over the real client engine on the mock transport, and a gate stands at the effect:
//! between the relay's last look at its run and the client's send. The first socket ends and a second attaches while a send waits
//! at the gate, and the request id is reused on the second; what the second socket's wire sees is the assertion.

use std::sync::Arc;

use async_trait::async_trait;
use mixdog_app_protocol::v2::model_proxy::{ProxyAnswer, ProxyCall, ProxyEvent};
use mixdog_app_server_client::api::{
    BlobRef, CallOptions, ClientError, ClientEvent, ConnectionStatus, FoldStore, InitializeResponse, Json, ReplyAddress, ResumeWindow,
    ServerRequest, ServerRequestAnswer, ThreadId, ThreadResumeResponse,
};
use mixdog_app_server_client::mock::{MockConn, MockNetwork};
use mixdog_app_server_client::{AttachmentId, Clock, ConnectOptions, DEFAULT_LADDER, InitializeCapabilities, ProtocolClient, Target, connect};
use serde_json::{Value, json};
use tokio::sync::{broadcast, mpsc, oneshot, watch};
use tokio_util::sync::CancellationToken;

use super::{CallOutcome, LocalModelProxy, ModelProxyRelay, ProxyEventSink};

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

struct Started {
    events: Arc<dyn ProxyEventSink>,
    answer: oneshot::Sender<Result<ProxyAnswer, String>>,
}

struct FakeLocal(mpsc::UnboundedSender<Started>);

#[async_trait]
impl LocalModelProxy for FakeLocal {
    async fn run(
        &self,
        _call: ProxyCall,
        _allowed: Option<Vec<String>>,
        events: Arc<dyn ProxyEventSink>,
        _cancel: CancellationToken,
    ) -> Result<ProxyAnswer, String> {
        let (answer, wait) = oneshot::channel();
        let _ = self.0.send(Started { events, answer });
        wait.await.unwrap_or_else(|_| Err("never answered".into()))
    }
}

/// The real client, with a gate before every addressed send: closed, a send waits where the relay has already decided to make it.
struct Gated {
    inner: Arc<dyn ProtocolClient>,
    open: watch::Sender<bool>,
}

impl Gated {
    async fn pass(&self) {
        let mut open = self.open.subscribe();
        let _ = open.wait_for(|open| *open).await;
    }
}

#[async_trait]
impl ProtocolClient for Gated {
    fn store(&self) -> Arc<dyn FoldStore> {
        self.inner.store()
    }
    fn server(&self) -> InitializeResponse {
        self.inner.server()
    }
    fn status(&self) -> ConnectionStatus {
        self.inner.status()
    }
    async fn call_raw(&self, method: &str, params: Json, options: CallOptions) -> Result<Json, ClientError> {
        self.inner.call_raw(method, params, options).await
    }
    async fn notify(&self, method: &str, params: Json) -> Result<(), ClientError> {
        self.inner.notify(method, params).await
    }
    async fn notify_on(&self, attachment: AttachmentId, method: &str, params: Json) -> Result<(), ClientError> {
        self.pass().await;
        self.inner.notify_on(attachment, method, params).await
    }
    async fn resume_thread(&self, thread_id: &ThreadId, window: ResumeWindow) -> Result<ThreadResumeResponse, ClientError> {
        self.inner.resume_thread(thread_id, window).await
    }
    async fn unsubscribe_thread(&self, thread_id: &ThreadId) -> Result<(), ClientError> {
        self.inner.unsubscribe_thread(thread_id).await
    }
    async fn subscribe_app(&self) -> Result<(), ClientError> {
        self.inner.subscribe_app().await
    }
    fn pending_server_requests(&self) -> Vec<ServerRequest> {
        self.inner.pending_server_requests()
    }
    async fn respond(&self, address: ReplyAddress, answer: ServerRequestAnswer) -> Result<(), ClientError> {
        self.pass().await;
        self.inner.respond(address, answer).await
    }
    async fn read_blob(&self, blob: &BlobRef) -> Result<Vec<u8>, ClientError> {
        self.inner.read_blob(blob).await
    }
    async fn put_blob(&self, bytes: &[u8], media_type: &str) -> Result<BlobRef, ClientError> {
        self.inner.put_blob(bytes, media_type).await
    }
    fn events(&self) -> broadcast::Receiver<ClientEvent> {
        self.inner.events()
    }
    async fn close(&self) {
        self.inner.close().await;
    }
}

struct Rig {
    net: Arc<MockNetwork>,
    first: MockConn,
    relay: Arc<ModelProxyRelay>,
    gate: Arc<Gated>,
    events: broadcast::Receiver<ClientEvent>,
    calls: mpsc::UnboundedReceiver<Started>,
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

async fn rig() -> Rig {
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
    let first = handshake(&net, "s1").await;
    let client: Arc<dyn ProtocolClient> = Arc::new(connecting.await.unwrap().unwrap());
    let events = client.events();
    let gate = Arc::new(Gated { inner: client, open: watch::channel(true).0 });
    let (started, calls) = mpsc::unbounded_channel();
    // Not `serve()`: the relay is handed each event by the test, so what it has seen when a send is released is the test's choice.
    let relay = ModelProxyRelay::new(gate.clone(), Arc::new(FakeLocal(started)), Arc::new(|| None));
    Rig { net, first, relay, gate, events, calls }
}

async fn settle() {
    for _ in 0..80 {
        tokio::task::yield_now().await;
    }
}

fn execute(conn: &MockConn, id: u64) {
    conn.server_send(&json!({ "id": id, "method": "model/proxy/execute", "params": { "call": { "method": "providerConfig" } } }));
}

async fn frame(conn: &MockConn) -> Value {
    serde_json::from_str(&conn.next_sent().await).unwrap()
}

fn method_of(frame: &Value) -> Option<&str> {
    frame.get("method").and_then(Value::as_str)
}

/// The next `model/proxy/execute` the client decoded, with the address it got.
async fn next_request(events: &mut broadcast::Receiver<ClientEvent>) -> (ServerRequest, ReplyAddress) {
    loop {
        if let ClientEvent::ServerRequest(request, address) = events.recv().await.unwrap() {
            return (request, address);
        }
    }
}

/// Socket one ends and socket two attaches (the same server, the same forward), as the engine sees it.
async fn replace_socket(rig: &mut Rig) -> MockConn {
    rig.first.server_close(1006, "gone");
    let second = handshake(&rig.net, "s1").await;
    settle().await;
    second
}

#[tokio::test(flavor = "current_thread", start_paused = true)]
async fn an_answer_held_after_the_liveness_check_never_reaches_a_socket_that_reuses_its_request_id() {
    let mut rig = rig().await;
    let mut settled = rig.relay.settled();
    execute(&rig.first, 7);
    let (request, address_a) = next_request(&mut rig.events).await;
    // Only the request reaches the relay: the status of the socket ending does not, before the held send is released.
    let ServerRequest::ModelProxyExecute { params, .. } = request else { panic!("a model proxy request") };
    rig.relay.execute(address_a.clone(), params).await;
    assert_eq!(method_of(&frame(&rig.first).await), Some("model/proxy/heartbeat"), "the claim, on the socket it arrived on");
    let run_a = rig.calls.recv().await.unwrap();

    // The relay has looked at its run and decided to answer; the send waits at the gate.
    rig.gate.open.send_replace(false);
    run_a.answer.send(Ok(ProxyAnswer::Route { route: None })).unwrap();
    settle().await;
    assert_eq!(rig.relay.running(), 1, "the answer is held, the run is not over");

    let second = replace_socket(&mut rig).await;
    execute(&second, 7); // the server's ids restart on the new socket: the same id
    let (request, address_b) = next_request(&mut rig.events).await;
    assert_ne!(address_a.attachment, address_b.attachment, "the new socket has its own attachment");
    assert_eq!(address_a.request_id, address_b.request_id);
    let ServerRequest::ModelProxyExecute { params, .. } = request else { panic!("a model proxy request") };
    rig.gate.open.send_replace(true);
    rig.relay.execute(address_b.clone(), params).await;
    settle().await;
    assert_eq!(method_of(&frame(&second).await), Some("model/proxy/heartbeat"), "the second socket's own claim, and nothing before it");
    let run_b = rig.calls.recv().await.unwrap();

    // The first socket's answer is released: refused at the writer, so the second socket sees none of it.
    settle().await;
    assert_eq!(second.queued(), 0, "no frame of the first socket's run on the second socket");
    let event = settled.recv().await.unwrap();
    assert_eq!(event.outcome, CallOutcome::Abandoned, "the first socket's run ends as abandoned, not answered");
    assert_eq!(rig.relay.running(), 1, "the second socket's request is still pending");

    run_b.answer.send(Ok(ProxyAnswer::Route { route: None })).unwrap();
    let answer = frame(&second).await;
    assert_eq!((answer["id"].clone(), answer.get("result").is_some()), (json!(7), true), "the second socket's answer is sent once");
    let event = settled.recv().await.unwrap();
    assert_eq!(event.outcome, CallOutcome::Answered);
    settle().await;
    assert_eq!(second.queued(), 0);
    assert!(settled.try_recv().is_err(), "each run settled once");
}

#[tokio::test(flavor = "current_thread", start_paused = true)]
async fn a_stream_item_held_after_the_liveness_check_never_reaches_a_socket_that_reuses_its_request_id() {
    let mut rig = rig().await;
    let mut settled = rig.relay.settled();
    execute(&rig.first, 7);
    let (request, address_a) = next_request(&mut rig.events).await;
    let ServerRequest::ModelProxyExecute { params, .. } = request else { panic!("a model proxy request") };
    rig.relay.execute(address_a.clone(), params).await;
    frame(&rig.first).await; // claim
    let run_a = rig.calls.recv().await.unwrap();

    rig.gate.open.send_replace(false);
    run_a.events.event(ProxyEvent::TextDelta { text: "from the first socket".into() });
    settle().await;

    let second = replace_socket(&mut rig).await;
    execute(&second, 7);
    let (request, address_b) = next_request(&mut rig.events).await;
    let ServerRequest::ModelProxyExecute { params, .. } = request else { panic!("a model proxy request") };
    rig.gate.open.send_replace(true);
    rig.relay.execute(address_b, params).await;
    settle().await;
    assert_eq!(method_of(&frame(&second).await), Some("model/proxy/heartbeat"));
    let run_b = rig.calls.recv().await.unwrap();
    settle().await;
    assert_eq!(second.queued(), 0, "the first socket's event was refused, not delivered to the second");
    assert_eq!(settled.recv().await.unwrap().outcome, CallOutcome::Abandoned);
    assert_eq!(rig.relay.running(), 1);

    run_b.events.event(ProxyEvent::TextDelta { text: "from the second".into() });
    let event = frame(&second).await;
    assert_eq!(event["params"]["event"]["text"], "from the second");
    run_b.answer.send(Ok(ProxyAnswer::Route { route: None })).unwrap();
    assert_eq!(frame(&second).await["id"], json!(7));
    assert_eq!(settled.recv().await.unwrap().outcome, CallOutcome::Answered);
}

#[tokio::test(flavor = "current_thread", start_paused = true)]
async fn a_request_decoded_on_the_old_socket_and_handled_after_the_new_one_attached_is_never_started_or_answered() {
    let mut rig = rig().await;
    let mut settled = rig.relay.settled();
    execute(&rig.first, 7);
    // Decoded on the first socket (its address is taken here), handled only after the second attached.
    let (stale, address_a) = next_request(&mut rig.events).await;
    let second = replace_socket(&mut rig).await;
    execute(&second, 7);
    let (fresh, address_b) = next_request(&mut rig.events).await;
    let ServerRequest::ModelProxyExecute { params: stale_params, .. } = stale else { panic!("a model proxy request") };
    let ServerRequest::ModelProxyExecute { params: fresh_params, .. } = fresh else { panic!("a model proxy request") };

    rig.relay.execute(address_a, stale_params).await;
    settle().await;
    assert_eq!(second.queued(), 0, "the stale request's claim is not sent to the second socket");
    assert!(rig.calls.try_recv().is_err(), "the stale request is not started on the local core");
    assert_eq!(settled.recv().await.unwrap().outcome, CallOutcome::Abandoned);

    rig.relay.execute(address_b, fresh_params).await;
    assert_eq!(method_of(&frame(&second).await), Some("model/proxy/heartbeat"));
    rig.calls.recv().await.unwrap().answer.send(Ok(ProxyAnswer::Route { route: None })).unwrap();
    assert_eq!(frame(&second).await["id"], json!(7));
    assert_eq!(settled.recv().await.unwrap().outcome, CallOutcome::Answered);
    assert_eq!(rig.relay.running(), 0);
}