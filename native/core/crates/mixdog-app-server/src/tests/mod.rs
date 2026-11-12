//! Server tests against the mock core.

mod actor;
mod admission;
mod approvals;
mod closing;
mod control;
mod dispatch;
mod errors;
mod handshake;
mod host;
mod inventory_rule;
mod lane_pushes;
mod model_proxy_wire;
mod phone_chat;
mod queues;
mod relay_answer;
mod routing;
mod sample;
mod session_transport;
mod settings_change_feed;
mod storm;
mod subscriptions;

use std::collections::BTreeSet;
use std::collections::HashMap;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::atomic::AtomicUsize;
use std::sync::atomic::Ordering;

use async_trait::async_trait;
use bytes::Bytes;
use mixdog_app_protocol::CLIENT_METHODS;
use mixdog_app_protocol::CLIENT_NOTIFICATIONS;
use mixdog_app_protocol::JsonRpcMessage;
use mixdog_app_protocol::limits::Limits;
use mixdog_app_protocol::v1::CapabilityState;
use mixdog_app_protocol::v1::ServerCapabilities;
use mixdog_core_api::CallContext;
use mixdog_core_api::ConnectionSink;
use mixdog_core_api::CoreError;
use mixdog_core_api::CoreHandle;
use mixdog_core_api::CoreRequest;
use mixdog_core_api::CoreState;
use mixdog_core_api::DomainService;
use mixdog_core_api::FeedSource;
use mixdog_core_api::HostMediaSink;
use mixdog_core_api::Lane;
use mixdog_core_api::OpIndex;
use mixdog_core_api::Reply;
use mixdog_core_api::ThreadDirectory;
use mixdog_core_api::ThreadHandle;
use mixdog_core_api::ids::ConnectionId;
use mixdog_core_api::ids::Method;
use mixdog_core_api::ids::SubscriptionId;
use mixdog_core_api::ids::ThreadId;
use mixdog_core_api::sink::LaneRecovery;
use mixdog_core_api::sink::LaneRelease;
use mixdog_core_api::sink::SinkClosed;
use mixdog_core_api::mock::MockConnection;
use mixdog_core_api::mock::MockCore;
use mixdog_core_api::mock::MockLimits;
use mixdog_core_api::service::Admit;
use mixdog_protocol::Origin;
use serde_json::Value;
use serde_json::json;
use tokio::sync::Semaphore;
use tokio::sync::watch;

use crate::AppServer;
use crate::ConnectionHandle;
use crate::Inbound;
use crate::Outgoing;
use crate::ServerConfig;
use crate::VersionOrder;

pub(crate) const VERSION: &str = "1.4.6";

/// A domain whose calls wait for permits, logging when they start and end.
pub(crate) struct GateDomain {
    pub(crate) methods: &'static [&'static str],
    pub(crate) log: Mutex<Vec<String>>,
    pub(crate) permits: Semaphore,
    /// Each call's hold on its reply (`CallContext::after_answer`), in call order.
    pub(crate) held: Mutex<Vec<mixdog_rt::CancellationToken>>,
}

impl GateDomain {
    pub(crate) fn log(&self) -> Vec<String> {
        self.log.lock().unwrap().clone()
    }
}

#[async_trait]
impl DomainService for GateDomain {
    fn methods(&self) -> &'static [&'static str] {
        self.methods
    }

    async fn call(&self, req: CoreRequest) -> Result<Reply, CoreError> {
        let tag = ["tabId", "opId"]
            .iter()
            .find_map(|key| req.params.get(*key).and_then(Value::as_str))
            .unwrap_or("")
            .to_owned();
        let tag = format!("{}:{tag}", req.method);
        self.held.lock().unwrap().push(req.ctx.after_answer.hold());
        self.log.lock().unwrap().push(format!("start {tag}"));
        self.permits.acquire().await.unwrap().forget();
        self.log.lock().unwrap().push(format!("end {tag}"));
        Ok(Reply::Value(json!({ "done": tag })))
    }

    fn notify(&self, _: Method, _: Value, _: ConnectionId) -> Admit {
        Admit::Accepted
    }
}

/// The mock core, except that the namespaces in `gated` are served by [`GateDomain`]s.
///
/// Its thread directory puts the threads registered with [`TestCore::load`] and
/// [`TestCore::cold`] in front of the mock's, and counts how often the server opens threads
/// and how often a thread is actually loaded.
pub(crate) struct TestCore {
    pub(crate) mock: MockCore,
    pub(crate) gated: HashMap<&'static str, Arc<GateDomain>>,
    /// A real domain service served in place of the mock's for its methods ([`TestCore::serve`]).
    real: std::sync::OnceLock<Arc<dyn DomainService>>,
    threads: Mutex<Threads>,
    scoped: Mutex<HashMap<mixdog_core_api::ids::FeedId, Arc<dyn FeedSource>>>,
    opens: AtomicUsize,
    loads: AtomicUsize,
}

type Build = Box<dyn Fn() -> Arc<dyn ThreadHandle> + Send + Sync>;

#[derive(Default)]
struct Threads {
    loaded: HashMap<ThreadId, Arc<dyn ThreadHandle>>,
    cold: HashMap<ThreadId, Build>,
}

impl TestCore {
    /// `service` answers its methods from now on (once; the mock answers every other).
    pub(crate) fn serve(&self, service: Arc<dyn DomainService>) {
        assert!(self.real.set(service).is_ok(), "one real service per rig");
    }

    /// `feed` is the live scoped feed `id`, as its owner holds it.
    pub(crate) fn hold_scoped(&self, id: &str, feed: Arc<dyn FeedSource>) {
        crate::sharded::lock(&self.scoped).insert(mixdog_core_api::ids::FeedId::from(id), feed);
    }

    /// `handle` serves thread `id` from now on.
    pub(crate) fn load(&self, id: &str, handle: Arc<dyn ThreadHandle>) {
        crate::sharded::lock(&self.threads)
            .loaded
            .insert(ThreadId::from(id), handle);
    }

    /// Thread `id` is built by `build` on its first `open`, once however many callers race.
    pub(crate) fn cold(
        &self,
        id: &str,
        build: impl Fn() -> Arc<dyn ThreadHandle> + Send + Sync + 'static,
    ) {
        crate::sharded::lock(&self.threads)
            .cold
            .insert(ThreadId::from(id), Box::new(build));
    }

    /// `open` calls the server made.
    pub(crate) fn opens(&self) -> usize {
        self.opens.load(Ordering::Acquire)
    }

    /// Cold threads that were built.
    pub(crate) fn loads(&self) -> usize {
        self.loads.load(Ordering::Acquire)
    }
}

#[async_trait]
impl ThreadDirectory for TestCore {
    fn get(&self, id: &ThreadId) -> Option<Arc<dyn ThreadHandle>> {
        let loaded = crate::sharded::lock(&self.threads).loaded.get(id).cloned();
        loaded.or_else(|| self.mock.threads().get(id))
    }

    async fn open(
        &self,
        id: &ThreadId,
        ctx: &CallContext,
    ) -> Result<Arc<dyn ThreadHandle>, CoreError> {
        self.opens.fetch_add(1, Ordering::AcqRel);
        {
            let mut threads = crate::sharded::lock(&self.threads);
            if let Some(handle) = threads.loaded.get(id) {
                return Ok(Arc::clone(handle));
            }
            if let Some(build) = threads.cold.remove(id) {
                let handle = build();
                threads.loaded.insert(id.clone(), Arc::clone(&handle));
                self.loads.fetch_add(1, Ordering::AcqRel);
                return Ok(handle);
            }
        }
        self.mock.threads().open(id, ctx).await
    }

    async fn request(&self, req: CoreRequest) -> Result<Reply, CoreError> {
        self.mock.threads().request(req).await
    }
}

impl CoreHandle for TestCore {
    fn threads(&self) -> &dyn ThreadDirectory {
        self
    }

    fn app_feed(&self) -> Arc<dyn FeedSource> {
        self.mock.app_feed()
    }

    fn scoped_feed(&self, id: &mixdog_core_api::ids::FeedId) -> Option<Arc<dyn FeedSource>> {
        crate::sharded::lock(&self.scoped).get(id).cloned()
    }

    fn ops(&self) -> &dyn OpIndex {
        self.mock.ops()
    }

    fn domain_for(&self, method: &str) -> Option<&dyn DomainService> {
        match self.gated.values().find(|gate| gate.methods.contains(&method)) {
            Some(gate) => Some(gate.as_ref()),
            None => match self.real.get().filter(|service| service.methods().contains(&method)) {
                Some(service) => Some(service.as_ref()),
                None => self.mock.domain_for(method),
            },
        }
    }

    fn host_media(&self) -> &dyn HostMediaSink {
        self.mock.host_media()
    }

    fn lifecycle(&self) -> watch::Receiver<CoreState> {
        self.mock.lifecycle()
    }

    fn connection_closed(&self, connection: mixdog_core_api::ids::ConnectionId) {
        self.mock.connection_closed(connection);
    }

    fn connection_opened(
        &self,
        connection: mixdog_core_api::ids::ConnectionId,
        origin: mixdog_protocol::Origin,
        device: &str,
        kind: mixdog_protocol::ConnectionKind,
    ) {
        self.mock.connection_opened(connection, origin, device, kind);
    }

    fn request_started(&self, method: &str, params: &serde_json::Value) -> mixdog_core_api::handle::RequestGuard {
        self.mock.request_started(method, params)
    }
}

pub(crate) fn config() -> ServerConfig {
    let available = || CapabilityState::Available;
    ServerConfig {
        user_agent: "mixdog-test".to_owned(),
        platform_family: "windows".to_owned(),
        platform_os: "windows".to_owned(),
        server_version: VERSION.to_owned(),
        server_build: "test".to_owned(),
        server_instance_id: "instance-1".to_owned(),
        defaults_separation: Default::default(),
        capabilities: ServerCapabilities {
            office: available(),
            js_skills: available(),
            browser: available(),
            computer: available(),
            voice: available(),
            remote: Default::default(),
        },
        native_push: Arc::new(|| false),
        limits: Limits::default(),
        version_gate: Arc::new(|client| match client.version.as_str() {
            VERSION => VersionOrder::Equal,
            "1.4.5" => VersionOrder::ClientOlder,
            _ => VersionOrder::ClientNewer,
        }),
    }
}

pub(crate) struct Rig {
    pub(crate) server: AppServer,
    pub(crate) core: Arc<TestCore>,
    pub(crate) outgoing: Arc<Outgoing>,
    /// The origins the transport would know: filled by `connect`, emptied by `forget`.
    origins: Arc<Mutex<std::collections::HashMap<ConnectionId, Origin>>>,
}

/// The requests and notifications of the table in `namespaces`. Leaked: the services list their
/// methods as `'static`.
fn namespace_methods(namespaces: &[&str]) -> &'static [&'static str] {
    let methods: Vec<&'static str> = CLIENT_METHODS
        .iter()
        .map(|spec| spec.method)
        .chain(CLIENT_NOTIFICATIONS.iter().map(|spec| spec.method))
        .filter(|method| method.split('/').next().is_some_and(|namespace| namespaces.contains(&namespace)))
        .collect();
    Box::leak(methods.into_boxed_slice())
}

/// Every method the table routes to a domain.
fn domain_methods() -> &'static [&'static str] {
    let namespaces: BTreeSet<&str> = CLIENT_METHODS
        .iter()
        .filter_map(|spec| spec.method.split('/').next())
        .filter(|namespace| !["thread", "turn"].contains(namespace))
        .collect();
    namespace_methods(&namespaces.into_iter().collect::<Vec<_>>())
}

impl Rig {
    pub(crate) fn new() -> Self {
        Self::gated(&[])
    }

    /// The mock core, except that every method of the namespaces in `gated` is served by a
    /// [`GateDomain`].
    pub(crate) fn gated(gated: &[&'static str]) -> Self {
        Self::routed(
            domain_methods(),
            gated.iter().map(|namespace| (*namespace, namespace_methods(&[*namespace]))).collect(),
        )
    }

    /// The mock serves `mock`; each `(name, methods)` of `gates` is a [`GateDomain`] serving
    /// exactly those methods, reached by `Rig::gate(name)`.
    pub(crate) fn routed(
        mock: &'static [&'static str],
        gates: Vec<(&'static str, &'static [&'static str])>,
    ) -> Self {
        Self::configured(mock, gates, config())
    }

    /// [`Rig::routed`] with a server configuration of the test's own.
    pub(crate) fn configured(
        mock: &'static [&'static str],
        gates: Vec<(&'static str, &'static [&'static str])>,
        config: ServerConfig,
    ) -> Self {
        mixdog_rt::testing::tokens();
        let core = Arc::new(TestCore {
            mock: MockCore::new(mock, MockLimits::default()),
            gated: gates
                .into_iter()
                .map(|(name, methods)| {
                    let gate = GateDomain {
                        methods,
                        log: Mutex::new(Vec::new()),
                        permits: Semaphore::new(0),
                        held: Mutex::new(Vec::new()),
                    };
                    (name, Arc::new(gate))
                })
                .collect(),
            real: std::sync::OnceLock::new(),
            threads: Mutex::default(),
            scoped: Mutex::default(),
            opens: AtomicUsize::new(0),
            loads: AtomicUsize::new(0),
        });
        let outgoing = Outgoing::new();
        let origins: Arc<Mutex<std::collections::HashMap<ConnectionId, Origin>>> = Arc::default();
        let known = origins.clone();
        let origin_of: crate::OriginOf =
            Arc::new(move |id| known.lock().unwrap().get(&id).copied());
        let server = AppServer::new(core.clone(), outgoing.clone(), origin_of, config).unwrap();
        Self {
            server,
            core,
            outgoing,
            origins,
        }
    }

    /// The transport loses track of connection `id` while its handle is still driven.
    pub(crate) fn forget(&self, id: u64) {
        self.origins.lock().unwrap().remove(&ConnectionId(id));
    }

    pub(crate) fn gate(&self, namespace: &str) -> &Arc<GateDomain> {
        &self.core.gated[namespace]
    }

    pub(crate) fn connect(&self, id: u64, origin: Origin) -> Client {
        let wire = Arc::new(MockConnection::new(
            ConnectionId(id),
            MockLimits::default(),
        ));
        self.origins.lock().unwrap().insert(ConnectionId(id), origin);
        let handle = self.server.open(ConnectionId(id), wire.clone());
        Client { handle, wire }
    }

    /// A connection whose writer runs `hook` just before it queues its first control frame,
    /// the initialize response: the window in which a session is latched but unanswered.
    pub(crate) fn connect_hooked(
        &self,
        id: u64,
        hook: impl FnOnce() + Send + 'static,
    ) -> Client {
        let wire = Arc::new(MockConnection::new(
            ConnectionId(id),
            MockLimits::default(),
        ));
        let sink = HookedSink {
            inner: wire.clone(),
            hook: Mutex::new(Some(Box::new(hook))),
        };
        self.origins.lock().unwrap().insert(ConnectionId(id), Origin::Local);
        let handle = self.server.open(ConnectionId(id), Arc::new(sink));
        Client { handle, wire }
    }

    /// A connection whose sink hands each control frame, with what `watch` saw at that instant, to the returned
    /// [`Arrivals`] just before it queues the frame.
    pub(crate) fn connect_watched<T: Send + 'static>(
        &self,
        id: u64,
        watch: impl Fn() -> T + Send + Sync + 'static,
    ) -> (Client, Arrivals<T>) {
        let wire = Arc::new(MockConnection::new(ConnectionId(id), MockLimits::default()));
        let (tx, rx) = tokio::sync::mpsc::unbounded_channel();
        let sink = WatchedSink {
            inner: wire.clone(),
            watch: Box::new(move |frame: &Bytes| {
                let body = serde_json::from_slice(frame).expect("a control frame is JSON");
                let _ = tx.send((body, watch()));
            }),
        };
        self.origins.lock().unwrap().insert(ConnectionId(id), Origin::Local);
        let handle = self.server.open(ConnectionId(id), Arc::new(sink));
        (Client { handle, wire }, Arrivals(rx))
    }

    /// A ready connection that names itself `device` (its `clientInfo.title`) and is a
    /// `kind` client.
    pub(crate) fn ready_as(&self, id: u64, device: &str, kind: &str) -> Client {
        let client = self.connect(id, Origin::Local);
        client.request(
            0,
            "initialize",
            json!({
                "clientInfo": { "name": "test", "title": device, "version": VERSION, "kind": kind },
                "capabilities": {},
            }),
        );
        let frames = client.drain();
        assert_eq!(frames.len(), 1, "initialize response only: {frames:?}");
        client
    }

    /// A connection that has completed `initialize` with `capabilities`.
    pub(crate) fn ready(&self, id: u64, capabilities: Value) -> Client {
        let client = self.connect(id, Origin::Local);
        client.initialize(VERSION, capabilities);
        let frames = client.drain();
        assert_eq!(frames.len(), 1, "initialize response only: {frames:?}");
        client
    }
}

type Hook = Box<dyn FnOnce() + Send>;

struct HookedSink {
    inner: Arc<MockConnection>,
    hook: Mutex<Option<Hook>>,
}

impl ConnectionSink for HookedSink {
    fn id(&self) -> ConnectionId {
        self.inner.id()
    }

    fn send_control(&self, frame: Bytes) -> Result<(), SinkClosed> {
        let hook = crate::sharded::lock(&self.hook).take();
        if let Some(hook) = hook {
            hook();
        }
        self.inner.send_control(frame)
    }

    fn send_control_release(&self, frame: Bytes, release: LaneRelease) -> Result<(), SinkClosed> {
        self.inner.send_control_release(frame, release)
    }

    fn open_lane(
        &self,
        sub: SubscriptionId,
        recovery: Arc<dyn LaneRecovery>,
    ) -> Result<(Arc<dyn Lane>, LaneRelease), SinkClosed> {
        self.inner.open_lane(sub, recovery)
    }
}

struct WatchedSink {
    inner: Arc<MockConnection>,
    watch: Box<dyn Fn(&Bytes) + Send + Sync>,
}

impl ConnectionSink for WatchedSink {
    fn id(&self) -> ConnectionId {
        self.inner.id()
    }

    fn send_control(&self, frame: Bytes) -> Result<(), SinkClosed> {
        (self.watch)(&frame);
        self.inner.send_control(frame)
    }

    fn send_control_release(&self, frame: Bytes, release: LaneRelease) -> Result<(), SinkClosed> {
        (self.watch)(&frame);
        self.inner.send_control_release(frame, release)
    }

    fn open_lane(
        &self,
        sub: SubscriptionId,
        recovery: Arc<dyn LaneRecovery>,
    ) -> Result<(Arc<dyn Lane>, LaneRelease), SinkClosed> {
        self.inner.open_lane(sub, recovery)
    }
}

/// The control frames of a [`Rig::connect_watched`] connection as its sink queues them, each with what the watch saw.
pub(crate) struct Arrivals<T>(tokio::sync::mpsc::UnboundedReceiver<(Value, T)>);

impl<T> Arrivals<T> {
    /// The next frame queued to the connection; `awaited` names it in the failure when none comes within `deadline`.
    pub(crate) async fn next(&mut self, deadline: std::time::Duration, awaited: &str) -> (Value, T) {
        mixdog_rt::time::timeout(deadline, self.0.recv())
            .await
            .unwrap_or_else(|_| panic!("no frame within {deadline:?}: awaited {awaited}"))
            .unwrap_or_else(|| panic!("the connection closed: awaited {awaited}"))
    }
}

#[derive(Debug)]
pub(crate) struct Wire {
    /// The subscription lane, `None` for the control lane.
    pub(crate) lane: Option<String>,
    pub(crate) body: Value,
}

pub(crate) struct Client {
    pub(crate) handle: ConnectionHandle,
    pub(crate) wire: Arc<MockConnection>,
}

impl Client {
    pub(crate) fn send(&self, message: Value) -> Inbound {
        let message: JsonRpcMessage = serde_json::from_value(message).unwrap();
        self.handle.on_message(message)
    }

    /// A frame as the client's text, read by the server's decoder (lone surrogate escapes and all).
    pub(crate) fn send_text(&self, frame: &str) -> Inbound {
        let mixdog_app_protocol::rpc::InboundText::Message(message) = mixdog_app_protocol::rpc::decode_inbound_text(frame, 1 << 20) else {
            panic!("not a message: {frame}");
        };
        self.handle.on_message(message)
    }

    pub(crate) fn request(&self, id: i64, method: &str, params: Value) -> Inbound {
        self.send(json!({ "id": id, "method": method, "params": params }))
    }

    pub(crate) fn initialize(&self, version: &str, capabilities: Value) -> Inbound {
        self.request(
            0,
            "initialize",
            json!({
                "clientInfo": { "name": "test", "version": version, "kind": "desktop" },
                "capabilities": capabilities,
            }),
        )
    }

    /// Everything the writer would send now, in socket order.
    pub(crate) fn drain(&self) -> Vec<Wire> {
        self.wire
            .drain()
            .into_iter()
            .map(|written| Wire {
                lane: written.lane.map(|sub| sub.to_string()),
                body: serde_json::from_slice(&written.frame).unwrap_or_else(|_| {
                    Value::String(String::from_utf8_lossy(&written.frame).into_owned())
                }),
            })
            .collect()
    }

    /// Waits (yielding to the spawned request tasks) until `count` frames arrived.
    pub(crate) async fn frames(&self, count: usize) -> Vec<Wire> {
        let mut frames = Vec::new();
        for _ in 0..5_000 {
            frames.extend(self.drain());
            if frames.len() >= count {
                break;
            }
            pause().await;
        }
        frames
    }

    /// Waits for the response of request `id`, returning its frame.
    pub(crate) async fn response(&self, id: i64) -> Value {
        let mut seen = Vec::new();
        for _ in 0..5_000 {
            for wire in self.drain() {
                if wire.body["id"] == json!(id) {
                    return wire.body;
                }
                seen.push(wire);
            }
            pause().await;
        }
        panic!("no response to {id}; saw {seen:?}");
    }
}

/// One step of waiting: other runtime workers run the request tasks on multi-thread tests, so
/// a bare yield may return before they have done anything.
async fn pause() {
    tokio::task::yield_now().await;
    mixdog_rt::time::sleep(std::time::Duration::from_millis(1)).await;
}

/// `error.data.reason` of an error frame.
pub(crate) fn reason(frame: &Value) -> &str {
    frame["error"]["data"]["reason"].as_str().unwrap_or_else(|| panic!("no error in {frame}"))
}

/// Lets spawned tasks run to their next await point.
pub(crate) async fn settle() {
    for _ in 0..200 {
        tokio::task::yield_now().await;
    }
}
