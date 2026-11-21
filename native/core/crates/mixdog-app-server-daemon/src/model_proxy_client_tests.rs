#![allow(clippy::disallowed_methods, reason = "test setup: the settings files and the workspace folder of the composed core")]

use std::sync::Arc;
use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use async_trait::async_trait;
use mixdog_ai::broker::ModelBroker;
use mixdog_ai::providers::anthropic::{AnthropicAdapter, AnthropicConfig, ApiKeySource, ModelCaps};
use mixdog_ai::transport::{BodyStream, Exchange, HttpResponse, HttpSend};
use mixdog_app_protocol::v2::model_proxy as w;
use mixdog_app_server_client::api::{Connector, Target, TransportEvent, TransportHalves, TransportReader, TransportWriter};
use mixdog_app_server_client::{ConnectOptions, InitializeCapabilities, ProtocolClient, connect};
use mixdog_connections::model_proxy_relay::{AllowedProviders, ModelProxyRelay};
use mixdog_connections::service::ServiceProxy;
use mixdog_core_api::domain::provider as p;
use mixdog_core_api::ids::{ConnectionId, Method};
use mixdog_core_api::{ConnectionNotifier, CoreError, HostCapability, HostChannel, HostError};
use mixdog_core_domains::domains::ai_admin::model_proxy::{ProviderConfigSource, ProviderLookup, ProxyRunner, QuotaProbe, WireRouter};
use mixdog_core_domains::domains::ai_admin::model_proxy_service::ModelProxyService;
use serde_json::{Value, json};

use crate::compose::{ComposeConfig, compose};
use crate::server::serve_in_process;

const PROVIDER: &str = "anthropic";
const MODEL: &str = "claude-x";
const ANSWERED: &str = "PROXY-PROMPT-ANSWERED";
const LOST: &str = "PROXY-PROMPT-LOST";
const UNATTACHED: &str = "PROXY-PROMPT-UNATTACHED";
const ANSWER: &str = "PROXIED-ANSWER";

// -- the PC: the real Anthropic adapter, its network captured ---------------------------------------------------------

/// The PC's provider endpoint: the prompt of the lost call is never answered (the PC leaves while it waits); every other
/// POST is answered with [`ANSWER`].
#[derive(Default)]
struct Wire {
    posts: Mutex<Vec<String>>,
    lost_posted: tokio::sync::Notify,
}

#[async_trait]
impl HttpSend for Wire {
    async fn send(&self, request: p::WireRequest, _: Exchange) -> Result<HttpResponse, p::ProviderError> {
        let body = String::from_utf8_lossy(&request.body).into_owned();
        self.posts.lock().unwrap().push(body.clone());
        if body.contains(LOST) {
            self.lost_posted.notify_one();
            std::future::pending::<()>().await;
        }
        Ok(HttpResponse { status: 200, headers: Vec::new(), body: Box::new(Once(Some(answer().into_bytes()))) })
    }
}

impl Wire {
    fn posted(&self, prompt: &str) -> bool {
        self.posts.lock().unwrap().iter().any(|body| body.contains(prompt))
    }
}

struct Once(Option<Vec<u8>>);

#[async_trait]
impl BodyStream for Once {
    async fn next(&mut self) -> Option<Result<bytes::Bytes, p::TransportFault>> {
        self.0.take().map(|b| Ok(b.into()))
    }
}

fn answer() -> String {
    let sse = |name: &str, data: Value| format!("event: {name}\ndata: {data}\n\n");
    let usage = json!({ "input_tokens": 5, "output_tokens": 1, "cache_read_input_tokens": 0, "cache_creation_input_tokens": 0 });
    [
        sse(
            "message_start",
            json!({ "type": "message_start", "message": { "id": "m", "type": "message", "role": "assistant", "model": MODEL, "content": [], "usage": usage } }),
        ),
        sse("content_block_start", json!({ "type": "content_block_start", "index": 0, "content_block": { "type": "text", "text": "" } })),
        sse("content_block_delta", json!({ "type": "content_block_delta", "index": 0, "delta": { "type": "text_delta", "text": ANSWER } })),
        sse("content_block_stop", json!({ "type": "content_block_stop", "index": 0 })),
        sse("message_delta", json!({ "type": "message_delta", "delta": { "stop_reason": "end_turn" }, "usage": { "output_tokens": 1 } })),
        sse("message_stop", json!({ "type": "message_stop" })),
    ]
    .concat()
}

struct Keys;

#[async_trait]
impl ApiKeySource for Keys {
    async fn key(&self) -> Result<String, p::ProviderError> {
        Ok("pc-key".into())
    }
    async fn reload(&self) -> Result<String, p::ProviderError> {
        Ok("pc-key".into())
    }
}

struct One(Arc<AnthropicAdapter>);

#[async_trait]
impl ProviderLookup for One {
    async fn adapter(&self, name: &str) -> Option<Arc<dyn p::ProviderAdapter>> {
        (name == PROVIDER).then(|| self.0.clone() as Arc<dyn p::ProviderAdapter>)
    }
}

struct Quota;

#[async_trait]
impl QuotaProbe for Quota {
    async fn usable(&self, _: &str, _: &str) -> Result<bool, String> {
        Ok(true)
    }
}

struct SingleWire;

#[async_trait]
impl WireRouter for SingleWire {
    async fn route(&self, _: &dyn p::ProviderAdapter, _: &str, _: w::ProxyRouteContext) -> Result<Option<w::ProxyWireRoute>, p::ProviderError> {
        Ok(None)
    }
}

/// The PC's providers as it advertises them: its Anthropic account, signed in.
struct Advertised;

#[async_trait]
impl ProviderConfigSource for Advertised {
    async fn public(&self) -> Result<(Vec<(String, w::ProxyProviderInfo)>, bool), String> {
        let info = w::ProxyProviderInfo {
            enabled: true,
            kind: None,
            name: None,
            hidden_models: None,
            auth_state: Some("present".into()),
            model_proxy: w::ProxyTraits::default(),
        };
        Ok((vec![(PROVIDER.to_owned(), info)], true))
    }
}

/// The PC's catalog source never reaches a network.
struct Offline;

#[async_trait]
impl HttpSend for Offline {
    async fn send(&self, _: p::WireRequest, _: Exchange) -> Result<HttpResponse, p::ProviderError> {
        Err(p::ProviderError::new(p::ErrorKind::Transient, p::DeliveryState::NotSent))
    }
}

/// The PC core's own host and connection seams: a proxied run uses neither.
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

/// The link from the PC to the server: the core's own in-process connection, which the test can cut (the PC leaves) and
/// which no reconnect then reopens.
struct Link {
    inner: Arc<dyn Connector>,
    cut: Arc<tokio::sync::Notify>,
    gone: Arc<AtomicBool>,
}

#[async_trait]
impl Connector for Link {
    async fn open(&self, target: &Target) -> Result<TransportHalves, String> {
        if self.gone.load(Ordering::SeqCst) {
            return Err("the PC is gone".into());
        }
        let halves = self.inner.open(target).await?;
        let writer = Arc::new(SharedWriter::new(halves.writer));
        Ok(TransportHalves { writer: Box::new(Writer(writer.clone())), reader: Box::new(Reader { inner: halves.reader, writer, cut: self.cut.clone() }) })
    }
}

/// Held across a send's await, and a close queued behind a send must run before a later send: tokio's mutex is first-in first-out,
/// utures::lock::Mutex is not, so a later send could overtake the simulated disconnect.
#[allow(clippy::disallowed_types, reason = "the test link needs the first-in first-out order of tokio's mutex across an await")]
type SharedWriter = tokio::sync::Mutex<Box<dyn TransportWriter>>;

struct Writer(Arc<SharedWriter>);

#[async_trait]
impl TransportWriter for Writer {
    async fn send(&mut self, text: String) -> Result<(), mixdog_app_server_client::api::TransportClosed> {
        self.0.lock().await.send(text).await
    }
    async fn close(&mut self, code: u16, reason: String) {
        self.0.lock().await.close(code, reason).await;
    }
}

struct Reader {
    inner: Box<dyn TransportReader>,
    writer: Arc<SharedWriter>,
    cut: Arc<tokio::sync::Notify>,
}

#[async_trait]
impl TransportReader for Reader {
    async fn recv(&mut self) -> TransportEvent {
        tokio::select! {
            () = self.cut.notified() => {
                // The socket closes under the PC: the server sees it go, and the PC reads its close.
                self.writer.lock().await.close(1001, "the PC left".into()).await;
                self.inner.recv().await
            }
            event = self.inner.recv() => event,
        }
    }
}

struct Pc {
    wire: Arc<Wire>,
    cut: Arc<tokio::sync::Notify>,
    gone: Arc<AtomicBool>,
    _relay: Arc<ModelProxyRelay>,
}

impl Pc {
    /// The PC leaves: its link closes and stays closed.
    fn leave(&self) {
        self.gone.store(true, Ordering::SeqCst);
        self.cut.notify_one();
    }
}

/// The PC: its core's model-call service over its Anthropic account, and the relay on its link to the server.
async fn attach_pc(server: Arc<dyn Connector>, dir: &std::path::Path) -> Pc {
    use mixdog_ai::catalog::{CatalogService, CatalogSnapshot, ModelsDevSource};
    let tokens = mixdog_rt::testing::tokens();
    let wire = Arc::new(Wire::default());
    let mut config = AnthropicConfig::new(Arc::new(|_: &str| Some(ModelCaps { max_output_tokens: Some(4096), ..ModelCaps::default() })));
    config.base_url = "http://anthropic.pc.test".into();
    let adapter = Arc::new(AnthropicAdapter::api_key(config, wire.clone(), Arc::new(Keys), tokens.cpu_bulk));
    let io = mixdog_ai::oauth::CredentialIo { read: tokens.interactive_io, write: tokens.durability_io };
    let catalog =
        Arc::new(CatalogService::cold_start(CatalogSnapshot::default(), Vec::new(), ModelsDevSource::new(Arc::new(Offline), dir.to_path_buf(), io)).await);
    let broker = Arc::new(ModelBroker::new(Arc::new(mixdog_ai::admission::Admission::new()), Arc::new(mixdog_ai::retry::StandardRetryDecider)));
    let runner =
        ProxyRunner { providers: Arc::new(One(adapter)), broker, quota: Arc::new(Quota), wire: Arc::new(SingleWire), config: Arc::new(Advertised), catalog };
    let service = Arc::new(ModelProxyService::new(Arc::new(runner), Arc::new(NoHost), Arc::new(NoHost)));
    let (cut, gone) = (Arc::new(tokio::sync::Notify::new()), Arc::new(AtomicBool::new(false)));
    let link = Arc::new(Link { inner: server, cut: cut.clone(), gone: gone.clone() });
    let info = serde_json::from_value(json!({ "name": "pc", "version": env!("CARGO_PKG_VERSION"), "kind": "desktop" })).expect("the PC's client info");
    let options = ConnectOptions {
        capabilities: InitializeCapabilities { model_proxy: Some(true), ..InitializeCapabilities::default() },
        ..ConnectOptions::new(Target { id: "server".into() }, link, info)
    };
    let client: Arc<dyn ProtocolClient> = Arc::new(connect(options).await.expect("the PC connects to the server"));
    let allowed: AllowedProviders = Arc::new(|| None);
    let relay = ModelProxyRelay::new(client, Arc::new(ServiceProxy(service)), allowed);
    drop(relay.serve());
    Pc { wire, cut, gone, _relay: relay }
}

// -- the desktop on the server ---------------------------------------------------------------------------------------

struct Desktop {
    halves: TransportHalves,
    next: u64,
}

impl Desktop {
    async fn open(server: &Arc<dyn Connector>) -> Self {
        let halves = server.open(&Target { id: "in-process".into() }).await.expect("a connection");
        let mut desktop = Self { halves, next: 0 };
        desktop
            .call("initialize", json!({ "clientInfo": { "name": "desktop", "version": env!("CARGO_PKG_VERSION"), "kind": "desktop" }, "capabilities": {} }))
            .await;
        desktop
    }

    async fn call(&mut self, method: &str, params: Value) -> Value {
        self.next += 1;
        let id = self.next;
        self.halves.writer.send(json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params }).to_string()).await.expect("send");
        let answer = tokio::time::timeout(Duration::from_secs(120), async {
            loop {
                let TransportEvent::Frame(text) = self.halves.reader.recv().await else { panic!("the server closed before the reply to {method}") };
                let frame: Value = serde_json::from_str(&text).expect("a frame");
                if frame["id"] == id {
                    return frame;
                }
            }
        })
        .await
        .unwrap_or_else(|_| panic!("no reply to {method}"));
        assert!(answer.get("result").is_some(), "{method}: {answer}");
        answer["result"].clone()
    }

    fn op(&self) -> String {
        format!("01900000-0000-7000-8000-{:012}", self.next + 1)
    }

    async fn ask(&mut self, thread: &str, prompt: &str) {
        let op = self.op();
        let turn = self.call("turn/start", json!({ "opId": op, "threadId": thread, "input": { "prompt": prompt } })).await;
        assert!(matches!(turn["kind"].as_str(), Some("started" | "queued")), "{turn}");
    }

    /// The thread's items once they hold `text`.
    async fn until_shown(&mut self, thread: &str, text: &str) -> Value {
        let deadline = tokio::time::Instant::now() + Duration::from_secs(90);
        loop {
            let items = self.call("thread/items/list", json!({ "threadId": thread })).await;
            if items.to_string().contains(text) {
                return items;
            }
            assert!(tokio::time::Instant::now() < deadline, "the thread never showed {text:?}: {items}");
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
    }
}

/// The server's settings: no provider of its own; the model the PC serves is in its catalog cache.
fn seed(data: &std::path::Path) {
    std::fs::write(data.join("mixdog-config.json"), json!({ "agent": {} }).to_string()).expect("the settings file");
    let snapshot = json!({ "generation": 1, "models": { PROVIDER: [{
        "id": MODEL, "provider": PROVIDER, "displayName": null, "rates": {}, "vision": "unknown", "functionCalling": "unknown",
        "reasoning": "unknown", "fastMode": "unknown", "reasoningEfforts": [], "source": "native", "manual": true,
    }] } });
    std::fs::create_dir_all(data.join("catalogs")).expect("the catalog directory");
    std::fs::write(data.join("catalogs").join("snapshot.json"), snapshot.to_string()).expect("the catalog cache");
}

#[test]
#[ignore = "integration: composes the real core, which needs a bundled Postgres runtime (MIXDOG_PG_RUNTIME); no network"]
fn a_client_mode_server_runs_its_turns_on_the_pc_and_fails_them_without_one() {
    // SAFETY: each composed test runs in its own process (nextest); this is set before the child, which inherits it, starts.
    unsafe { std::env::set_var("MIXDOG_MODEL_PROXY", "client") };
    let mut runtime = tokio::runtime::Builder::new_multi_thread();
    runtime.worker_threads(2);
    crate::compose_test_support::in_child(
        module_path!(),
        "a_client_mode_server_runs_its_turns_on_the_pc_and_fails_them_without_one",
        runtime,
        |dir| async move {
            let data = crate::compose_test_support::data_in(&dir);
            seed(&data);
            let ws = dir.join("ws");
            std::fs::create_dir_all(&ws).expect("the workspace");
            let pc_dir = dir.join("pc");
            std::fs::create_dir_all(&pc_dir).expect("the PC's folder");
            let tokens = mixdog_rt::testing::tokens();
            let outgoing = mixdog_app_server::Outgoing::new();
            let core = compose(
                &tokens,
                ComposeConfig {
                    rebuild: Default::default(),
                    data_dir: data.clone(),
                    user_data_dir: dir.join("userdata"),
                    runtime_root: dir.join("runtime"),
                    js_runtime: crate::js_runtime::fixture(&dir),
                    ort_library: mixdog_services::effort_judge::model::OrtRuntime::NoBinding,
                    outgoing: outgoing.clone(),
                    ownership: Arc::new(mixdog_core_api::domain::mock::MockOwnership::default()),
                    log: crate::daemon_log::DaemonLog::new(dir.join("daemon.log"), tokens.maintenance_io, mixdog_rt::CancellationToken::new()),
                    stop: mixdog_rt::CancellationToken::new(),
                    catalog_http: crate::compose_test_support::offline_http(),
                    pg_install: None,
                },
            )
            .await
            .expect("the composed core");
            let (server, shutdown) = serve_in_process(Arc::new(core), outgoing).expect("the in-process server");
            let pc = attach_pc(server.clone(), &pc_dir).await;
            let mut desktop = Desktop::open(&server).await;
            let op = desktop.op();
            let started = desktop
                .call(
                    "thread/start",
                    json!({ "opId": op, "kind": "project", "projectPath": ws, "draft": { "route": { "provider": PROVIDER, "model": MODEL } } }),
                )
                .await;
            let thread = started["thread"]["id"].as_str().expect("thread id").to_owned();
            let op = desktop.op();
            desktop.call("route/set", json!({ "opId": op, "threadId": thread, "route": { "provider": PROVIDER, "model": MODEL, "applyToCurrentSession": true, "keepMainModel": false } })).await;

            // Answered through the PC: its account's request carried the prompt, and the session shows the PC's answer.
            desktop.ask(&thread, ANSWERED).await;
            desktop.until_shown(&thread, ANSWER).await;
            assert!(pc.wire.posted(ANSWERED), "the PC's provider was sent the session's request");

            // The PC leaves while its provider works on the call: the turn ends on Node's words for it.
            desktop.ask(&thread, LOST).await;
            tokio::time::timeout(Duration::from_secs(60), pc.wire.lost_posted.notified()).await.expect("the PC posted the call");
            pc.leave();
            desktop.until_shown(&thread, "model proxy unavailable: the desktop client disconnected").await;

            // No PC is attached: nothing is sent, and the turn says why.
            desktop.ask(&thread, UNATTACHED).await;
            desktop.until_shown(&thread, "model proxy unavailable: no desktop client is connected to run model calls").await;
            assert!(!pc.wire.posted(UNATTACHED), "no PC was there to send it");
            shutdown.run().await;
        },
    );
}
