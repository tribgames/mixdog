use std::collections::VecDeque;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use mixdog_ai::broker::{AttemptSink, ModelBroker, ModelProxyTransport, ProxyError, SendError};
use mixdog_ai::providers::anthropic::{AnthropicAdapter, AnthropicConfig, ApiKeySource, ModelCaps};
use mixdog_ai::service::model_proxy_inline::{AttachmentReader, ReadError};
use mixdog_ai::transport::{BodyStream, Exchange, HttpResponse, HttpSend};
use mixdog_app_protocol::v2::model_proxy as w;
use mixdog_app_server_client::mock::{MockConn, MockNetwork};
use mixdog_app_server_client::{Clock, ConnectOptions, DEFAULT_LADDER, InitializeCapabilities, ProtocolClient, Target, connect};
use mixdog_core_api::domain::cache_tail::{TailGateHandle, TailRefusal};
use mixdog_core_api::domain::provider as p;
use mixdog_core_api::ids::{ConnectionId, Method};
use mixdog_core_api::{ConnectionNotifier, CoreError, HostCapability, HostChannel, HostError};
use mixdog_core_domains::domains::ai_admin::model_proxy::{ProviderConfigSource, ProviderLookup, ProxyRunner, QuotaProbe, WireRouter, remote_send};
use mixdog_core_domains::domains::ai_admin::model_proxy_service::ModelProxyService;
use serde_json::{Value, json};
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

use super::{AllowedProviders, ModelProxyRelay};
use crate::service::ServiceProxy;

const OPTIONS: &str = include_str!(concat!(env!("CARGO_MANIFEST_DIR"), "/../../../../packages/protocol-client/conformance/options.json"));
const T0: i64 = 1_700_000_000_000;
const TTL: i64 = 300_000;

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

// -- the PC's provider: the real Anthropic adapter on a captured transport ---------------------

/// Answers each POST with the next scripted reply; counts the POSTs.
struct Wire {
    replies: Mutex<VecDeque<String>>,
    posts: Mutex<Vec<String>>,
}

#[async_trait]
impl HttpSend for Wire {
    async fn send(&self, request: p::WireRequest, _: Exchange) -> Result<HttpResponse, p::ProviderError> {
        self.posts.lock().unwrap().push(String::from_utf8_lossy(&request.body).into_owned());
        let body = self.replies.lock().unwrap().pop_front().expect("a scripted reply");
        Ok(HttpResponse { status: 200, headers: Vec::new(), body: Box::new(Once(Some(body.into_bytes()))) })
    }
}

struct Once(Option<Vec<u8>>);

#[async_trait]
impl BodyStream for Once {
    async fn next(&mut self) -> Option<Result<bytes::Bytes, p::TransportFault>> {
        self.0.take().map(|b| Ok(b.into()))
    }
}

struct Keys;

#[async_trait]
impl ApiKeySource for Keys {
    async fn key(&self) -> Result<String, p::ProviderError> {
        Ok("key-a".into())
    }
    async fn reload(&self) -> Result<String, p::ProviderError> {
        Ok("key-a".into())
    }
}

fn sse(name: &str, data: Value) -> String {
    format!("event: {name}\ndata: {data}\n\n")
}

/// A turn that read `read` tokens and wrote `created` five-minute tokens.
fn written(read: u64, created: u64) -> String {
    let usage = json!({ "input_tokens": 5, "output_tokens": 1, "cache_read_input_tokens": read, "cache_creation_input_tokens": created, "cache_creation": { "ephemeral_5m_input_tokens": created, "ephemeral_1h_input_tokens": 0 } });
    [
        sse("message_start", json!({ "type": "message_start", "message": { "id": "m", "type": "message", "role": "assistant", "model": "claude-x", "content": [], "usage": usage } })),
        sse("content_block_start", json!({ "type": "content_block_start", "index": 0, "content_block": { "type": "text", "text": "" } })),
        sse("content_block_delta", json!({ "type": "content_block_delta", "index": 0, "delta": { "type": "text_delta", "text": "ok" } })),
        sse("content_block_stop", json!({ "type": "content_block_stop", "index": 0 })),
        sse("message_delta", json!({ "type": "message_delta", "delta": { "stop_reason": "end_turn" }, "usage": { "output_tokens": 1 } })),
        sse("message_stop", json!({ "type": "message_stop" })),
    ]
    .concat()
}

struct One(Arc<AnthropicAdapter>);

#[async_trait]
impl ProviderLookup for One {
    async fn adapter(&self, name: &str) -> Option<Arc<dyn p::ProviderAdapter>> {
        (name == "anthropic").then(|| self.0.clone() as Arc<dyn p::ProviderAdapter>)
    }
}

struct Quota;
#[async_trait]
impl QuotaProbe for Quota {
    async fn usable(&self, _: &str, _: &str) -> Result<bool, String> {
        Ok(true)
    }
}

struct Wires;
#[async_trait]
impl WireRouter for Wires {
    async fn route(&self, _: &dyn p::ProviderAdapter, _: &str, _: w::ProxyRouteContext) -> Result<Option<w::ProxyWireRoute>, p::ProviderError> {
        Ok(None)
    }
}

struct Config;
#[async_trait]
impl ProviderConfigSource for Config {
    async fn public(&self) -> Result<(Vec<(String, w::ProxyProviderInfo)>, bool), String> {
        Ok((Vec::new(), true))
    }
}

/// The PC's catalog source never reaches the network.
struct Offline;

#[async_trait]
impl HttpSend for Offline {
    async fn send(&self, _: p::WireRequest, _: Exchange) -> Result<HttpResponse, p::ProviderError> {
        Err(p::ProviderError::new(p::ErrorKind::Transient, p::DeliveryState::NotSent))
    }
}

/// The PC core's host and connection seams: a run of the relay never uses them.
struct NoHost;

#[async_trait]
impl HostChannel for NoHost {
    async fn request(&self, _: HostCapability, _: Method, _: Value) -> Result<Value, HostError> {
        unreachable!("the PC's run asks no host")
    }
    fn notify(&self, _: HostCapability, _: Method, _: Value) -> Result<(), CoreError> {
        unreachable!("the PC's run notifies no host")
    }
}

impl ConnectionNotifier for NoHost {
    fn notify(&self, _: ConnectionId, _: Method, _: Value) -> Result<(), CoreError> {
        Ok(())
    }
}

async fn runner(adapter: Arc<AnthropicAdapter>) -> ProxyRunner {
    use mixdog_ai::catalog::{CatalogService, CatalogSnapshot, ModelsDevSource};
    let tokens = mixdog_rt::testing::tokens();
    let dir = tempfile::tempdir().unwrap();
    let io = mixdog_ai::oauth::CredentialIo { read: tokens.interactive_io, write: tokens.durability_io };
    let metadata = ModelsDevSource::new(Arc::new(Offline), dir.path().to_path_buf(), io);
    let catalog = Arc::new(CatalogService::cold_start(CatalogSnapshot::default(), Vec::new(), metadata).await);
    let broker = Arc::new(ModelBroker::new(Arc::new(mixdog_ai::admission::Admission::new()), Arc::new(mixdog_ai::retry::StandardRetryDecider)));
    ProxyRunner { providers: Arc::new(One(adapter)), broker, quota: Arc::new(Quota), wire: Arc::new(Wires), config: Arc::new(Config), catalog }
}

// -- the session's core: `model/proxy/execute` on the mock server link --------------------------

/// The session core's transport: frames to the PC's relay and back. With `vanish_on_ask` the server link goes the moment
/// the PC asks to judge a POST, before any verdict. With `hold`, the next thing the owner says takes that long to reach
/// the PC, while the owner's clock moves on by as much.
struct Link {
    conn: Arc<MockConn>,
    frames: tokio::sync::Mutex<mpsc::UnboundedReceiver<Value>>,
    ids: AtomicU64,
    vanish_on_ask: std::sync::atomic::AtomicBool,
    hold: Mutex<Option<(std::time::Duration, Arc<std::sync::atomic::AtomicI64>)>>,
}

impl Link {
    /// One frame of request `id`: an event for `events`, or its answer.
    fn read(&self, id: &Value, frame: Value, events: &mut (dyn FnMut(Value) + Send)) -> Option<Result<Value, ProxyError>> {
        if frame.get("method") == Some(&json!("model/proxy/event")) && &frame["params"]["requestId"] == id {
            if frame["params"]["event"]["type"] == "tailAsk" && self.vanish_on_ask.load(Ordering::SeqCst) {
                self.conn.server_close(1001, "the server went away");
                return Some(Err(ProxyError::Cancelled));
            }
            events(frame["params"]["event"].clone());
            return None;
        }
        if frame.get("id") != Some(id) {
            return None;
        }
        Some(match frame.get("result") {
            Some(result) => Ok(result["result"].clone()),
            None => Err(ProxyError::Remote(frame["error"]["data"].clone())),
        })
    }

    fn open(&self, call: Value) -> Value {
        let id = json!(self.ids.fetch_add(1, Ordering::SeqCst) + 100);
        self.conn.server_send(&json!({ "id": id, "method": "model/proxy/execute", "params": { "call": call } }));
        id
    }
}

#[async_trait]
impl ModelProxyTransport for Link {
    async fn execute(&self, call: Value, events: &mut (dyn FnMut(Value) + Send), _: &CancellationToken) -> Result<Value, ProxyError> {
        let mut frames = self.frames.lock().await;
        let id = self.open(call);
        loop {
            let frame = frames.recv().await.ok_or(ProxyError::Cancelled)?;
            if let Some(answer) = self.read(&id, frame, events) {
                return answer;
            }
        }
    }

    /// The owner's verdicts go to the PC as `model/proxy/tail`, stamped with the request's id, as the server's router sends them.
    async fn execute_duplex(
        &self,
        call: Value,
        events: &mut (dyn FnMut(Value) + Send),
        mut back: mpsc::UnboundedReceiver<Value>,
        _: &CancellationToken,
    ) -> Result<Value, ProxyError> {
        let mut frames = self.frames.lock().await;
        let id = self.open(call);
        loop {
            tokio::select! {
                biased;
                Some(mut said) = back.recv() => {
                    let held = self.hold.lock().unwrap().take();
                    if let Some((delay, owner_clock)) = held {
                        mixdog_rt::time::sleep(delay).await;
                        owner_clock.fetch_add(delay.as_millis() as i64, Ordering::SeqCst);
                    }
                    said["requestId"] = id.clone();
                    self.conn.server_send(&json!({ "method": "model/proxy/tail", "params": said }));
                }
                frame = frames.recv() => {
                    if let Some(answer) = self.read(&id, frame.ok_or(ProxyError::Cancelled)?, events) {
                        return answer;
                    }
                }
            }
        }
    }
}

struct NoStore;

#[async_trait]
impl AttachmentReader for NoStore {
    async fn read(&self, _: &str) -> Result<Vec<u8>, ReadError> {
        Err(ReadError::Permanent)
    }
}

#[derive(Default)]
struct Sink(Vec<p::StreamEvent>);

impl AttemptSink for Sink {
    fn event(&mut self, event: p::StreamEvent) {
        self.0.push(event);
    }
    fn discard(&mut self) {
        self.0.clear();
    }
    fn abandoned(&mut self, _: &p::Usage, _: Option<&str>) {}
}

struct Rig {
    link: Arc<Link>,
    wire: Arc<Wire>,
    clock: Arc<std::sync::atomic::AtomicI64>,
    gate: TailGateHandle,
    books: mixdog_ai::cache_tail::Books,
    session: String,
    relay: Arc<ModelProxyRelay>,
    _net: Arc<MockNetwork>,
}

async fn rig(name: &str) -> Rig {
    // The owner's session and its book, on the owner's clock.
    let clock = Arc::new(std::sync::atomic::AtomicI64::new(T0));
    let session = name.to_owned();
    let read = clock.clone();
    let books = mixdog_ai::cache_tail::Books::default();
    let gate = books.gate(
        &session,
        None,
        mixdog_ai::cache_tail::GateSettings {
            clock: Arc::new(move || read.load(Ordering::SeqCst)),
            auto_clear: Arc::new(|| true),
            sizing: 1,
            fresh: true,
            last_send_at: None,
        },
    );
    // The PC: its Anthropic account behind a captured transport, its core's model-call service, the relay on its link.
    let wire = Arc::new(Wire { replies: Mutex::default(), posts: Mutex::default() });
    let mut config = AnthropicConfig::new(Arc::new(|_: &str| Some(ModelCaps { max_output_tokens: Some(4096), ..ModelCaps::default() })));
    config.base_url = "http://anthropic.test".into();
    let adapter = Arc::new(AnthropicAdapter::api_key(config, wire.clone(), Arc::new(Keys), mixdog_rt::testing::tokens().cpu_bulk));
    let service = Arc::new(ModelProxyService::new(Arc::new(runner(adapter).await), Arc::new(NoHost), Arc::new(NoHost)));
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
    let conn = net.accept().await;
    let init: Value = serde_json::from_str(&conn.next_sent().await).unwrap();
    let mut result = options["initializeResult"].clone();
    result["serverInstanceId"] = json!("s1");
    conn.server_send(&json!({ "id": init["id"], "result": result }));
    conn.next_sent().await; // initialized
    let client: Arc<dyn ProtocolClient> = Arc::new(connecting.await.unwrap().unwrap());
    let allowed: AllowedProviders = Arc::new(|| None);
    let relay = ModelProxyRelay::new(client, Arc::new(ServiceProxy(service)), allowed);
    drop(relay.serve());
    // The server side of the link: every frame the PC writes, pumped to the owner's transport.
    let conn = Arc::new(conn);
    let (pump, frames) = mpsc::unbounded_channel();
    let reader = conn.clone();
    drop(tokio::spawn(async move {
        loop {
            let frame: Value = serde_json::from_str(&reader.next_sent().await).unwrap();
            if pump.send(frame).is_err() {
                return;
            }
        }
    }));
    let link =
        Arc::new(Link { conn, frames: tokio::sync::Mutex::new(frames), ids: AtomicU64::new(0), vanish_on_ask: Default::default(), hold: Mutex::default() });
    Rig { link, wire, clock, gate, books, session, relay, _net: net }
}

impl Rig {
    fn script(&self, body: String) {
        self.wire.replies.lock().unwrap().push_back(body);
    }

    /// The session's transcript: an old exchange carrying the payload, `turns` answered exchanges and a new question.
    fn request(&self, turns: usize) -> p::ModelRequest {
        let mut messages = vec![p::Message::new(p::Role::User, p::Content::Text("q-old".into()))];
        messages.push(p::Message::new(p::Role::Assistant, p::Content::Text("a-old".into())));
        for n in 0..turns {
            messages.push(p::Message::new(p::Role::User, p::Content::Text(format!("q{n}").into())));
            messages.push(p::Message::new(p::Role::Assistant, p::Content::Text(format!("a{n}").into())));
        }
        messages.push(p::Message::new(p::Role::User, p::Content::Text(format!("q{turns}").into())));
        let options = p::RequestOptions {
            session_id: Some(self.session.clone()),
            tail_gate: Some(self.gate.clone()),
            tail_generation: Some(self.gate.0.generation()),
            ..p::RequestOptions::default()
        };
        p::ModelRequest { model: "claude-x".into(), messages, tools: Vec::new(), options }
    }

    async fn send(&self, request: &p::ModelRequest) -> Result<u32, SendError> {
        remote_send(self.link.as_ref(), &NoStore, "anthropic", request, &mut Sink::default(), &CancellationToken::new()).await
    }

    fn posts(&self) -> usize {
        self.wire.posts.lock().unwrap().len()
    }
}

/// The owner's verdict for a refused send, with its offer.
fn refusal(sent: Result<u32, SendError>) -> TailRefusal {
    match sent {
        Err(SendError::Provider(error)) => error.tail_refusal.unwrap_or_else(|| panic!("a refusal, not {}", error.message)),
        Err(other) => panic!("a refused send, not {other:?}"),
        Ok(_) => panic!("a refused send, not a sent one"),
    }
}

/// A session on a borrowed Anthropic route sends normally: the first write and a live one each go out once the session's
/// own book admitted that POST, and each POST's usage comes back to its permit as the book's proof, on the PC's account
/// under an opaque name.
#[tokio::test(flavor = "current_thread", start_paused = true)]
async fn a_borrowed_session_sends_each_post_its_owner_admitted_and_learns_from_its_usage() {
    let rig = rig("borrowed").await;
    rig.script(written(0, 100));
    rig.send(&rig.request(0)).await.expect("the first write");
    rig.clock.fetch_add(60_000, Ordering::SeqCst);
    rig.script(written(100, 50));
    rig.send(&rig.request(1)).await.expect("a live write");
    assert_eq!(rig.posts(), 2, "each admitted POST reached the provider");
    let book = rig.books.book_json(&rig.session).expect("the owner's book");
    let receipts = book["receipts"].as_object().unwrap();
    assert_eq!(receipts.values().map(|held| held.as_object().unwrap().len()).sum::<usize>(), 2, "both writes proved the tail: {book}");
    assert!(receipts.keys().all(|route| route.starts_with("proxy:") && !route.contains("key-a")), "{book}");
}

/// A borrowed session whose tail expired on the owner's clock is compacted before the transcript is rewritten: the PC asks,
/// the owner refuses and offers the rewrite, nothing is posted; once the owner compacted, the rebuilt request is that base's
/// first write and goes out.
#[tokio::test(flavor = "current_thread", start_paused = true)]
async fn an_expired_tail_is_refused_before_the_pc_posts_and_the_rebuilt_request_goes_out() {
    use mixdog_core_api::domain::cache_tail::{Claimed, Cold, Resolution};
    let rig = rig("expired").await;
    rig.script(written(0, 100));
    rig.send(&rig.request(0)).await.expect("the first write");
    rig.clock.fetch_add(TTL + 1, Ordering::SeqCst);
    let TailRefusal::Rebuild(cold) = refusal(rig.send(&rig.request(1)).await) else { panic!("a rebuild") };
    assert_eq!(cold.cold, Cold::Expired);
    assert_eq!(rig.posts(), 1, "the expired transcript was never posted");
    // The owner's run compacts the history.
    let Claimed::Owner(lease) = rig.gate.claim(cold) else { panic!("the owner") };
    rig.gate.0.rebuilt();
    lease.resolve(Resolution::Compacted);
    let mut compacted = rig.request(0);
    compacted.messages = vec![
        p::Message::new(p::Role::User, p::Content::Text("summary of the earlier work".into())),
        p::Message::new(p::Role::User, p::Content::Text("q1".into())),
    ];
    rig.script(written(0, 40));
    rig.send(&compacted).await.expect("the compacted base's first write");
    assert_eq!(rig.posts(), 2);
    let last = rig.wire.posts.lock().unwrap().last().cloned().unwrap();
    assert!(last.contains("summary of the earlier work") && !last.contains("q-old"), "the rebuilt transcript went out: {last}");
}

/// A live verdict that reaches the PC after the entry it read can no longer be alive is never used: the PC settles it
/// unsent and asks again, the owner judges that POST at its clock now (expired: it offers the rewrite), and nothing of the
/// stale transcript reaches the provider.
#[tokio::test(flavor = "current_thread", start_paused = true)]
async fn a_live_verdict_that_lapsed_on_its_way_is_asked_again_and_never_posted() {
    use mixdog_core_api::domain::cache_tail::Cold;
    let rig = rig("lapsed").await;
    rig.script(written(0, 100));
    rig.send(&rig.request(0)).await.expect("the first write");
    // A second of the tail's lifetime is left when the owner judges; its verdict takes two to reach the PC.
    rig.clock.fetch_add(TTL - 1_000, Ordering::SeqCst);
    *rig.link.hold.lock().unwrap() = Some((std::time::Duration::from_secs(2), rig.clock.clone()));
    let TailRefusal::Rebuild(cold) = refusal(rig.send(&rig.request(1)).await) else { panic!("a rebuild") };
    assert_eq!(cold.cold, Cold::Expired, "judged again at the owner's clock after the lapse");
    assert_eq!(rig.posts(), 1, "the lapsed verdict posted nothing");
}

/// A request built before a rewrite of the session's history (its generation is behind the book's) is never posted.
#[tokio::test(flavor = "current_thread", start_paused = true)]
async fn a_request_prepared_before_a_rewrite_is_stale_and_never_posted() {
    let rig = rig("stale").await;
    let prepared = rig.request(0);
    rig.gate.0.rebuilt();
    assert_eq!(refusal(rig.send(&prepared).await), TailRefusal::Stale);
    assert_eq!(rig.posts(), 0);
}

/// The server link goes while the PC waits for the owner's verdict on a POST: nothing is posted unjudged, and the call is
/// abandoned on the PC.
#[tokio::test(flavor = "current_thread", start_paused = true)]
async fn an_owner_that_goes_away_while_the_pc_waits_for_its_verdict_leaves_the_post_unsent() {
    let rig = rig("vanished").await;
    let mut settled = rig.relay.settled();
    rig.link.vanish_on_ask.store(true, Ordering::SeqCst);
    rig.script(written(0, 100));
    assert!(rig.send(&rig.request(0)).await.is_err(), "the owner's end of the call is gone");
    let ended = settled.recv().await.expect("the call ends on the PC");
    assert_eq!(ended.outcome, crate::model_proxy_relay::CallOutcome::Abandoned);
    mixdog_rt::time::sleep(std::time::Duration::from_secs(1)).await;
    assert_eq!(rig.posts(), 0, "nothing was posted without the owner's verdict");
}

/// A prompt no session owns (no book) goes out as Node 1.4.5 sent it: a plain send, judged by nobody.
#[tokio::test(flavor = "current_thread", start_paused = true)]
async fn a_standalone_prompt_goes_out_unjudged() {
    let rig = rig("standalone").await;
    let mut request = rig.request(0);
    request.options.tail_gate = None;
    request.options.tail_generation = None;
    rig.script(written(0, 100));
    rig.send(&request).await.expect("sent");
    assert_eq!(rig.posts(), 1);
    assert!(rig.books.book_json(&rig.session).expect("the rig's book")["receipts"].as_object().unwrap().is_empty(), "no owner learned from it");
}
