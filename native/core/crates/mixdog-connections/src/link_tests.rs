//! The link and its pool with fakes: the ssh transport (scripted bootstrap and tunnels, a loopback `/health`), the server's core
//! (the client library's mock transport, scripted frame by frame), this PC's core (a fake local model proxy) and the port forward
//! tunnels. No ssh runs and nothing but a loopback listener for `/health` is bound.

use std::future::Future;
use std::io;
use std::path::Path;
use std::sync::atomic::{AtomicU16, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, PoisonError};
use std::time::Duration;

use async_trait::async_trait;
use mixdog_app_protocol::v2::model_proxy::{ProxyAnswer, ProxyCall, ProxyDelivery, ProxyErrorKind, ProxyFailure, ProxyOutcome};
use mixdog_app_server_client::api::TransportHalves;
use mixdog_app_server_client::mock::{MockConn, MockNetwork};
use mixdog_rt::DurabilityIo;
use mixdog_ssh::bootstrap::{BootstrapPhase, RemoteDiscovery, RemoteReport};
use mixdog_ssh::command::parse_ssh_target;
use mixdog_ssh::session::{TunnelHandle, Transport};
use mixdog_ssh::tunnel::{TunnelSpec, TunnelState};
use serde_json::{json, Value};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

use super::*;
use crate::model_proxy_relay::ProxyEventSink;
use crate::paths::ConnectionsPaths;
use crate::port_forwards::{ForwardTunnel, LocalPorts, TunnelFactory};

const OPTIONS: &str = include_str!(concat!(env!("CARGO_MANIFEST_DIR"), "/../../../../packages/protocol-client/conformance/options.json"));
const PID: u32 = 4242;
const INSTANCE: &str = "run-a";

async fn within<T>(work: impl Future<Output = T>) -> T {
    mixdog_rt::time::timeout(Duration::from_secs(5), work).await.expect("timed out")
}

fn io_lane() -> DurabilityIo {
    mixdog_rt::testing::tokens().durability_io
}

// ----- the server's ssh side -------------------------------------------------------------------

/// A core's `/health` on a loopback port.
async fn serve_health() -> u16 {
    let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let body = format!(r#"{{"status":"ok","pid":{PID},"instanceId":"{INSTANCE}","busy":0}}"#);
    tokio::spawn(async move {
        loop {
            let Ok((mut stream, _)) = listener.accept().await else { return };
            let body = body.clone();
            tokio::spawn(async move {
                let mut request = [0_u8; 1024];
                let _ = stream.read(&mut request).await;
                let reply = format!("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len());
                let _ = stream.write_all(reply.as_bytes()).await;
            });
        }
    });
    port
}

struct FakeTunnel {
    companion: u16,
    state: watch::Sender<TunnelState>,
    stops: AtomicUsize,
}

#[async_trait]
impl TunnelHandle for FakeTunnel {
    fn local_port(&self) -> u16 {
        50_001
    }

    fn companion_port(&self) -> u16 {
        self.companion
    }

    fn state(&self) -> watch::Receiver<TunnelState> {
        self.state.subscribe()
    }

    fn restart(&self) {}

    fn revive(&self) {}

    async fn stop(&self) {
        self.stops.fetch_add(1, Ordering::SeqCst);
        self.state.send_replace(TunnelState::Stopped { failure: None });
    }
}

struct FakeTransport {
    companion: u16,
    bootstraps: AtomicUsize,
    logins: Mutex<Vec<Option<SshModelLogin>>>,
    forces: Mutex<Vec<bool>>,
    tunnels: Mutex<Vec<Arc<FakeTunnel>>>,
}

fn report() -> RemoteReport {
    RemoteReport {
        home: "/home/me".to_owned(),
        uid: 1000,
        runtime_root: "/home/me/.mixdog".to_owned(),
        version_dir: "/home/me/.mixdog/v".to_owned(),
        installed: true,
        discovery: Some(RemoteDiscovery {
            rpc_port: Some(41_001),
            control_port: 41_002,
            token: "secret-token".to_owned(),
            pid: PID,
            instance_id: INSTANCE.to_owned(),
            process_start_time: "t".to_owned(),
            state: "serving".to_owned(),
            version: "1.2.3".to_owned(),
            build: "b".to_owned(),
        }),
        healthy: true,
        core_current: true,
        started: false,
        replaced: None,
        gc_removed: Vec::new(),
    }
}

#[async_trait]
impl Transport for FakeTransport {
    async fn bootstrap(
        &self,
        model_login: Option<SshModelLogin>,
        force_restart: bool,
        _progress: &(dyn Fn(BootstrapPhase) + Sync),
    ) -> Result<RemoteReport, ConnectError> {
        self.bootstraps.fetch_add(1, Ordering::SeqCst);
        self.logins.lock().unwrap_or_else(PoisonError::into_inner).push(model_login);
        self.forces.lock().unwrap_or_else(PoisonError::into_inner).push(force_restart);
        tokio::task::yield_now().await;
        Ok(report())
    }

    fn open_tunnel(&self, _spec: TunnelSpec) -> Arc<dyn TunnelHandle> {
        let tunnel = Arc::new(FakeTunnel { companion: self.companion, state: watch::channel(TunnelState::Up).0, stops: AtomicUsize::new(0) });
        self.tunnels.lock().unwrap_or_else(PoisonError::into_inner).push(tunnel.clone());
        tunnel
    }
}

// ----- the Ports panel's forwards --------------------------------------------------------------

struct ForwardFake {
    state: watch::Sender<TunnelState>,
}

#[async_trait]
impl ForwardTunnel for ForwardFake {
    fn local_port(&self) -> u16 {
        50_100
    }

    fn state(&self) -> watch::Receiver<TunnelState> {
        self.state.subscribe()
    }

    fn revive(&self) {}

    async fn stop(&self) {
        self.state.send_replace(TunnelState::Stopped { failure: None });
    }
}

#[derive(Default)]
struct ForwardTunnels(Mutex<Vec<Arc<ForwardFake>>>);

impl TunnelFactory for ForwardTunnels {
    fn start(&self, _local: u16, _remote: u16) -> Arc<dyn ForwardTunnel> {
        let tunnel = Arc::new(ForwardFake { state: watch::channel(TunnelState::Up).0 });
        self.0.lock().unwrap_or_else(PoisonError::into_inner).push(tunnel.clone());
        tunnel
    }
}

struct FreePorts(AtomicU16);

#[async_trait]
impl LocalPorts for FreePorts {
    async fn is_free(&self, _port: u16) -> bool {
        true
    }

    fn free_port(&self) -> io::Result<u16> {
        Ok(self.0.fetch_add(1, Ordering::SeqCst))
    }
}

// ----- the dialer ------------------------------------------------------------------------------

/// Asks the resolver for the endpoint at every open, as the WebSocket connector does, then opens the scripted server.
struct Resolving {
    resolver: Arc<dyn EndpointResolver>,
    net: Arc<MockNetwork>,
    seen: Arc<Mutex<Vec<WsEndpoint>>>,
}

#[async_trait]
impl Connector for Resolving {
    async fn open(&self, target: &Target) -> Result<TransportHalves, String> {
        let endpoint = self.resolver.resolve(target).await?;
        self.seen.lock().unwrap_or_else(PoisonError::into_inner).push(endpoint);
        self.net.open(target).await
    }
}

struct FakeDialer {
    transport: Arc<FakeTransport>,
    net: Arc<MockNetwork>,
    seen: Arc<Mutex<Vec<WsEndpoint>>>,
    forwards: Arc<ForwardTunnels>,
}

impl LinkDialer for FakeDialer {
    fn session(&self, config: RemoteSessionConfig, _context: AttemptContext) -> Arc<RemoteSession> {
        Arc::new(RemoteSession::new(config, self.transport.clone()))
    }

    fn connector(&self, resolver: Arc<dyn EndpointResolver>) -> Arc<dyn Connector> {
        Arc::new(Resolving { resolver, net: self.net.clone(), seen: self.seen.clone() })
    }

    fn forwards(&self, host_id: &str, _context: ContextSource, store: Arc<PortForwardStore>) -> ServerPortForwards {
        ServerPortForwards::with_parts(host_id.to_owned(), store, self.forwards.clone(), Arc::new(FreePorts(AtomicU16::new(50_200))), Duration::from_millis(200))
    }
}

// ----- this PC's core --------------------------------------------------------------------------

/// A call that runs until the server gives it up.
struct FakeLocal(mpsc::UnboundedSender<()>);

#[async_trait]
impl LocalModelProxy for FakeLocal {
    async fn run(
        &self,
        _call: ProxyCall,
        _allowed: Option<Vec<String>>,
        _events: Arc<dyn ProxyEventSink>,
        cancel: CancellationToken,
    ) -> Result<ProxyAnswer, String> {
        let _ = self.0.send(());
        cancel.cancelled().await;
        Err("stopped".to_owned())
    }
}

struct Rig {
    pool: LinkPool,
    transport: Arc<FakeTransport>,
    net: Arc<MockNetwork>,
    seen: Arc<Mutex<Vec<WsEndpoint>>>,
    forwards: Arc<ForwardTunnels>,
    local_calls: mpsc::UnboundedReceiver<()>,
    _dir: tempfile::TempDir,
}

async fn rig() -> Rig {
    let dir = tempfile::tempdir().unwrap();
    let paths = ConnectionsPaths::new(Path::new(dir.path()));
    let hosts = Arc::new(SshHostStore::load(&paths, io_lane()).await);
    let store = Arc::new(PortForwardStore::new(&paths, io_lane()));
    let transport = Arc::new(FakeTransport {
        companion: serve_health().await,
        bootstraps: AtomicUsize::new(0),
        logins: Mutex::new(Vec::new()),
        forces: Mutex::new(Vec::new()),
        tunnels: Mutex::new(Vec::new()),
    });
    let net = Arc::new(MockNetwork::default());
    let seen = Arc::new(Mutex::new(Vec::new()));
    let forwards = Arc::new(ForwardTunnels::default());
    let dialer = Arc::new(FakeDialer { transport: transport.clone(), net: net.clone(), seen: seen.clone(), forwards: forwards.clone() });
    let (started, local_calls) = mpsc::unbounded_channel();
    let pool = LinkPool::with_dialer(dialer, Platform::Linux, None, hosts, store, Arc::new(FakeLocal(started)));
    Rig { pool, transport, net, seen, forwards, local_calls, _dir: dir }
}

fn spec() -> LinkSpec {
    LinkSpec { id: "box".to_owned(), name: "Box".to_owned(), target: parse_ssh_target("me@server").unwrap() }
}

/// The server's side of `initialize`: the request's params, and the open connection.
async fn handshake(net: &MockNetwork, instance: &str) -> (MockConn, Value) {
    let options: Value = serde_json::from_str(OPTIONS).unwrap();
    let conn = within(net.accept()).await;
    let init: Value = serde_json::from_str(&within(conn.next_sent()).await).unwrap();
    let mut result = options["initializeResult"].clone();
    result["serverInstanceId"] = json!(instance);
    conn.server_send(&json!({ "id": init["id"], "result": result }));
    within(conn.next_sent()).await; // initialized
    (conn, init["params"].clone())
}

async fn open_link(rig: &Rig) -> (Arc<ServerLink>, MockConn, Value) {
    let (link, (conn, params)) = within(async { tokio::join!(rig.pool.open(spec(), AttemptContext::default(), None), handshake(&rig.net, "s1")) }).await;
    (link.unwrap(), conn, params)
}

async fn view_until(link: &ServerLink, wanted: impl Fn(&LinkState) -> bool) {
    let mut view = link.view();
    within(async {
        loop {
            let reached = wanted(&view.borrow().state);
            if reached {
                return;
            }
            view.changed().await.unwrap();
        }
    })
    .await;
}

fn count(counter: &AtomicUsize) -> usize {
    counter.load(Ordering::SeqCst)
}

/// The next frame the client sent that is a call or notification of `method`.
async fn frame_of(conn: &MockConn, method: &str) -> Value {
    within(async {
        loop {
            let frame: Value = serde_json::from_str(&conn.next_sent().await).unwrap();
            if frame["method"] == method {
                return frame;
            }
        }
    })
    .await
}

// ----- cases -----------------------------------------------------------------------------------

#[tokio::test]
async fn a_link_opens_names_the_desktop_core_and_reports_its_view() {
    let rig = rig().await;
    let mut attached = rig.pool.on_attach();
    let (link, _conn, init) = open_link(&rig).await;
    assert_eq!(init["clientInfo"]["name"], "mixdog-desktop-core");
    assert_eq!(init["clientInfo"]["kind"], "desktop");
    assert_eq!(init["clientInfo"]["version"], env!("CARGO_PKG_VERSION"));
    assert_eq!(init["capabilities"]["approvalsInbox"], true);
    assert_eq!(init["capabilities"]["modelProxy"], true);
    assert_eq!((link.id(), link.name(), link.target().display.as_str()), ("box", "Box", "me@server"));
    assert_eq!(link.view().borrow().state, LinkState::Connected);
    assert_eq!(link.view().borrow().model_login, ModelLogin::Pc);
    assert_eq!(within(attached.recv()).await.unwrap(), "box");
    let endpoint = link.endpoint().unwrap();
    assert_eq!((endpoint.url.as_str(), endpoint.token.as_str(), endpoint.cwd.as_str()), ("ws://127.0.0.1:50001/rpc", "secret-token", "/home/me"));
    assert!(Arc::ptr_eq(&rig.pool.get("box").unwrap(), &link));
    assert_eq!(rig.pool.list().len(), 1);
}

#[tokio::test]
async fn open_dedupes() {
    let rig = rig().await;
    let (first, second, _) = within(async {
        tokio::join!(
            rig.pool.open(spec(), AttemptContext::default(), None),
            rig.pool.open(spec(), AttemptContext::default(), None),
            handshake(&rig.net, "s1")
        )
    })
    .await;
    let (first, second) = (first.unwrap(), second.unwrap());
    assert!(Arc::ptr_eq(&first, &second));
    assert_eq!(count(&rig.transport.bootstraps), 1);
    // An attached link is handed back as it is.
    assert!(Arc::ptr_eq(&rig.pool.open(spec(), AttemptContext::default(), None).await.unwrap(), &first));
    assert_eq!((count(&rig.transport.bootstraps), rig.pool.list().len(), rig.net.opened()), (1, 1, 1));
}

#[test]
fn version_refusal_codes() {
    let refused = |reason: &str| ClientError::VersionRefused { reason: reason.to_owned(), server_version: "2.0.0".to_owned(), client_version: String::new() };
    let Some(ConnectError::Bootstrap(outdated)) = version_refusal(&refused("clientOutdated"), "me@server") else { panic!("not a refusal") };
    assert_eq!(outdated.code, "client-outdated");
    assert_eq!(outdated.message, "This Mixdog (unknown) is older than the core on me@server (2.0.0). Update Mixdog on this PC.");
    let Some(ConnectError::Bootstrap(mismatch)) = version_refusal(&refused("serverOutdated"), "me@server") else { panic!("not a refusal") };
    assert_eq!(mismatch.code, "protocol-mismatch");
    assert!(mismatch.message.starts_with("The Mixdog core on me@server (2.0.0) is incompatible with this desktop (unknown)."), "{}", mismatch.message);
    assert!(outdated.is_terminal() && mismatch.is_terminal());
    assert!(version_refusal(&ClientError::ConnectionLost, "me@server").is_none());
}

#[tokio::test]
async fn a_version_refusal_at_open_stops_the_link_with_its_code_and_lets_go_of_the_tunnel() {
    for (reason, code) in [("clientOutdated", "client-outdated"), ("serverOutdated", "protocol-mismatch")] {
        let rig = rig().await;
        let refusing = async {
            let conn = within(rig.net.accept()).await;
            let init: Value = serde_json::from_str(&within(conn.next_sent()).await).unwrap();
            conn.server_send(&json!({ "id": init["id"], "error": { "code": -32600, "message": "v", "data": { "reason": reason, "serverVersion": "2.0.0", "clientVersion": "1.4.6" } } }));
            conn.server_close(4002, "version");
        };
        let (opened, ()) = within(async { tokio::join!(rig.pool.open(spec(), AttemptContext::default(), None), refusing) }).await;
        let Err(ConnectError::Bootstrap(error)) = opened else { panic!("expected a bootstrap refusal") };
        assert_eq!(error.code, code);
        assert!(rig.pool.get("box").is_none());
        assert_eq!(rig.transport.tunnels.lock().unwrap()[0].stops.load(Ordering::SeqCst), 1);
    }
}

#[tokio::test]
async fn a_dropped_connection_shows_reconnecting_and_attaches_again_through_a_re_read_server() {
    let rig = rig().await;
    let mut attached = rig.pool.on_attach();
    let (link, conn, _) = open_link(&rig).await;
    within(attached.recv()).await.unwrap();
    assert_eq!(count(&rig.transport.bootstraps), 1);
    conn.server_close(1006, "gone");
    view_until(&link, |state| matches!(state, LinkState::Reconnecting { attempt: 1, .. })).await;
    let (_again, params) = handshake(&rig.net, "s2").await;
    assert_eq!(params["clientInfo"]["name"], "mixdog-desktop-core");
    view_until(&link, |state| *state == LinkState::Connected).await;
    assert_eq!(within(attached.recv()).await.unwrap(), "box");
    // The second dial re-read the server and used the tunnel's local end with the core's token.
    assert_eq!(count(&rig.transport.bootstraps), 2);
    let seen = rig.seen.lock().unwrap().clone();
    assert_eq!(seen, vec![WsEndpoint { port: 50_001, token: "secret-token".to_owned() }; 2]);
}

#[tokio::test]
async fn model_login_switch_revokes() {
    let mut rig = rig().await;
    let (link, conn, _) = open_link(&rig).await;
    let mut calls = link.model_calls();
    conn.server_send(&json!({ "id": "r1", "method": "model/proxy/execute", "params": { "call": { "method": "providerConfig" } } }));
    within(rig.local_calls.recv()).await.unwrap();
    assert_eq!(link.relay.running(), 1);
    // The claim: this PC took the request up.
    assert_eq!(frame_of(&conn, "model/proxy/heartbeat").await["params"]["requestIds"], json!(["r1"]));

    link.apply_model_login(ModelLogin::Server).await.unwrap();

    let settled = within(calls.recv()).await.unwrap();
    assert_eq!(settled.outcome, CallOutcome::Abandoned);
    assert_eq!(link.relay.running(), 0);
    assert_eq!(link.model_login(), ModelLogin::Server);
    assert_eq!(link.view().borrow().model_login, ModelLogin::Server);
    // The new session stops the older daemon even while it is busy, and starts it in the new mode.
    assert_eq!(rig.transport.logins.lock().unwrap().clone(), vec![None, Some(SshModelLogin::Server)]);
    assert_eq!(rig.transport.forces.lock().unwrap().clone(), vec![false, true]);
    assert_eq!(rig.transport.tunnels.lock().unwrap()[0].stops.load(Ordering::SeqCst), 1);
    // A server on its own logins takes nothing of this PC's.
    conn.server_send(&json!({ "id": "r2", "method": "model/proxy/execute", "params": { "call": { "method": "providerConfig" } } }));
    for _ in 0..50 {
        tokio::task::yield_now().await;
    }
    assert_eq!(link.relay.running(), 0);
    assert!(rig.local_calls.try_recv().is_err());
    // Saying the login it already has is nothing to do.
    link.apply_model_login(ModelLogin::Server).await.unwrap();
    assert_eq!(count(&rig.transport.bootstraps), 2);
}

#[tokio::test]
async fn close_stops_tunnel_and_forwards() {
    let rig = rig().await;
    let (link, conn, _) = open_link(&rig).await;
    let forwarded = within(link.ports().forward(8080, None)).await.unwrap();
    assert_eq!(forwarded.remote_port, 8080);
    assert_eq!(rig.forwards.0.lock().unwrap().len(), 1);

    rig.pool.close("box").await;

    assert!(rig.pool.get("box").is_none());
    assert_eq!(rig.transport.tunnels.lock().unwrap()[0].stops.load(Ordering::SeqCst), 1);
    assert!(matches!(*rig.forwards.0.lock().unwrap()[0].state.borrow(), TunnelState::Stopped { .. }));
    assert_eq!(conn.client_close(), Some(1000));
    assert!(link.ports().forward(8081, None).await.is_err(), "a closed window refuses new forwards");
    // Closing again, or an unknown id, is nothing to do.
    rig.pool.close("box").await;
    rig.pool.close("other").await;
    assert_eq!(rig.transport.tunnels.lock().unwrap()[0].stops.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn a_close_while_opening_cancels_the_attempt() {
    let rig = rig().await;
    let closing = async {
        // The attempt is waiting for the server to answer `initialize`.
        let _conn = within(rig.net.accept()).await;
        rig.pool.close("box").await;
    };
    let (opened, ()) = within(async { tokio::join!(rig.pool.open(spec(), AttemptContext::default(), None), closing) }).await;
    let Err(ConnectError::Ssh(error)) = opened else { panic!("expected the closed error") };
    assert_eq!(error.message, "The connection to Box was closed.");
    assert!(rig.pool.get("box").is_none());
}

#[tokio::test]
async fn a_failed_ssh_dial_is_reported_as_it_is_and_nothing_stays_open() {
    let rig = rig().await;
    // Nothing answers /health through the tunnel: a transient failure of the dial itself.
    let silent = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
    let silent_port = silent.local_addr().unwrap().port();
    drop(silent);
    let lonely = Arc::new(FakeTransport {
        companion: silent_port,
        bootstraps: AtomicUsize::new(0),
        logins: Mutex::new(Vec::new()),
        forces: Mutex::new(Vec::new()),
        tunnels: Mutex::new(Vec::new()),
    });
    let dialer = Arc::new(FakeDialer { transport: lonely.clone(), net: rig.net.clone(), seen: rig.seen.clone(), forwards: rig.forwards.clone() });
    let paths = ConnectionsPaths::new(rig._dir.path());
    let hosts = Arc::new(SshHostStore::load(&paths, io_lane()).await);
    let pool = LinkPool::with_dialer(dialer, Platform::Linux, None, hosts, Arc::new(PortForwardStore::new(&paths, io_lane())), Arc::new(FakeLocal(mpsc::unbounded_channel().0)));
    let Err(ConnectError::Ssh(error)) = within(pool.open(spec(), AttemptContext::default(), None)).await else { panic!("expected an ssh failure") };
    assert!(error.message.contains("does not answer through the ssh tunnel"), "{}", error.message);
    assert!(pool.list().is_empty());
    assert_eq!(rig.net.opened(), 0);
    assert_eq!(lonely.tunnels.lock().unwrap()[0].stops.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn power_pauses_and_wakes_every_link() {
    let rig = rig().await;
    let (link, _conn, _) = open_link(&rig).await;
    rig.pool.power(LinkPower::Suspend).await;
    assert_eq!(link.view().borrow().state, LinkState::Paused);
    rig.pool.power(LinkPower::Resume).await;
    assert_eq!(link.view().borrow().state, LinkState::Connected);
    assert!(link.view().borrow().rtt_ms.is_some(), "the wake probed the link");
}

#[test]
fn a_failure_that_stops_the_link_is_described_for_the_window() {
    let target = parse_ssh_target("me@server").unwrap();
    let host_key = SessionError::Connect(SshError::new("Host key verification failed.", FailureClass::Terminal).into());
    let failure = describe_link_failure(&host_key, &target, Platform::Linux);
    assert_eq!((failure.code.as_str(), failure.settings_required), ("host-key-changed", true));
    assert_eq!(failure.message, "Host key verification failed.");
    let closed = describe_link_failure(&SessionError::Closed, &target, Platform::Linux);
    assert_eq!((closed.code.as_str(), closed.settings_required), ("failed", false));
}

#[test]
fn the_ports_feed_update_is_a_list_or_nothing() {
    let update = json!({ "section": "ports", "revision": 3, "value": [{ "port": 3000, "addresses": ["127.0.0.1"], "process": "node", "pid": 7 }] });
    let listed = listening_ports(Some(&update)).unwrap();
    assert_eq!((listed.len(), listed[0].port, listed[0].pid), (1, 3000, Some(7)));
    assert!(listening_ports(Some(&json!({ "section": "ports", "revision": 4, "removed": true }))).is_none());
    assert!(listening_ports(Some(&json!({ "value": { "port": 1 } }))).is_none());
    assert!(listening_ports(None).is_none());
}

#[test]
fn a_model_call_failure_is_a_sign_in_one_only_when_this_pcs_login_was_refused() {
    let failure = |change: &dyn Fn(&mut ProxyFailure)| {
        let mut failure = ProxyFailure {
            outcome: ProxyOutcome::Provider,
            kind: ProxyErrorKind::Auth,
            code: None,
            status: None,
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
            message: "no".into(),
            partial_usage: None,
            partial_model: None,
            verification_url: None,
            rejected_tool: None,
            account_blocked: false,
            unsafe_to_retry: false,
            quota_limit: None,
            notices: Vec::new(),
        };
        change(&mut failure);
        ProxyCallSettled { provider: "openai".to_owned(), outcome: CallOutcome::Failed, failure: Some(failure) }
    };
    assert!(is_sign_in_failure(&failure(&|failure| failure.reauth_required = true)));
    assert!(is_sign_in_failure(&failure(&|failure| failure.status = Some(401))));
    assert!(!is_sign_in_failure(&failure(&|failure| failure.status = Some(500))));
    let answered = ProxyCallSettled { provider: "openai".to_owned(), outcome: CallOutcome::Answered, failure: None };
    assert!(!is_sign_in_failure(&answered));
}
