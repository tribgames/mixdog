//! The session's lifetime races, each held at the effect with a barrier (no sleep decides who wins): a close while a replaced tunnel
//! is still being stopped, a close while the core's `/health` answer is outstanding, a close while the bootstrap is still running.
//! In every case the closed session keeps no tunnel, no endpoint and reports nothing after the close.

use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, PoisonError};
use std::time::Duration;

use async_trait::async_trait;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use tokio::sync::{watch, Notify};

use crate::bootstrap::{BootstrapPhase, RemoteDiscovery, RemoteReport};
use crate::command::parse_ssh_target;
use crate::connect_failure::ConnectError;
use crate::context::ModelLogin;
use crate::session::{RemoteSession, RemoteSessionConfig, SessionError, SessionPhase, Transport, TunnelHandle};
use crate::tunnel::{TunnelSpec, TunnelState};

const PID: u32 = 4242;
const INSTANCE: &str = "run-a";

/// A point two tasks meet at: the holder says it arrived, then waits to be let go.
#[derive(Default)]
struct Gate {
    arrived: Notify,
    release: Notify,
}

impl Gate {
    async fn hold(&self) {
        self.arrived.notify_one();
        self.release.notified().await;
    }
}

/// The core's `/health` on a loopback port; while `held`, each request waits at the gate before it is answered.
struct HealthServer {
    port: u16,
    held: Arc<AtomicBool>,
    gate: Arc<Gate>,
}

async fn serve_health() -> HealthServer {
    let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let held = Arc::new(AtomicBool::new(false));
    let gate = Arc::new(Gate::default());
    let (hold, wait) = (held.clone(), gate.clone());
    tokio::spawn(async move {
        loop {
            let Ok((mut stream, _)) = listener.accept().await else { return };
            let (hold, wait) = (hold.clone(), wait.clone());
            tokio::spawn(async move {
                let mut request = [0_u8; 1024];
                let _ = stream.read(&mut request).await;
                if hold.load(Ordering::SeqCst) {
                    wait.hold().await;
                }
                let body = format!(r#"{{"status":"ok","pid":{PID},"instanceId":"{INSTANCE}","busy":0}}"#);
                let reply = format!("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len());
                let _ = stream.write_all(reply.as_bytes()).await;
            });
        }
    });
    HealthServer { port, held, gate }
}

struct FakeTunnel {
    companion: u16,
    state: watch::Sender<TunnelState>,
    stops: AtomicUsize,
    /// While set, a stop waits here after it began: the tunnel is stopping, not yet stopped.
    stop_gate: Arc<Mutex<Option<Arc<Gate>>>>,
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
        let gate = self.stop_gate.lock().unwrap_or_else(PoisonError::into_inner).clone();
        if let Some(gate) = gate {
            gate.hold().await;
        }
        self.state.send_replace(TunnelState::Stopped { failure: None });
    }
}

struct FakeTransport {
    companion: u16,
    ssh_port: Mutex<u16>,
    bootstrap_gate: Mutex<Option<Arc<Gate>>>,
    stop_gate: Arc<Mutex<Option<Arc<Gate>>>>,
    opened: AtomicUsize,
    tunnels: Mutex<Vec<Arc<FakeTunnel>>>,
}

impl FakeTransport {
    fn new(companion: u16) -> Arc<Self> {
        Arc::new(Self {
            companion,
            ssh_port: Mutex::new(41_001),
            bootstrap_gate: Mutex::new(None),
            stop_gate: Arc::new(Mutex::new(None)),
            opened: AtomicUsize::new(0),
            tunnels: Mutex::new(Vec::new()),
        })
    }
}

fn report(ssh_port: u16) -> RemoteReport {
    RemoteReport {
        home: "/home/me".to_owned(),
        uid: 1000,
        runtime_root: "/home/me/.mixdog".to_owned(),
        version_dir: "/home/me/.mixdog/v".to_owned(),
        installed: true,
        discovery: Some(RemoteDiscovery {
            rpc_port: Some(ssh_port + 5_000),
            ssh_rpc_port: Some(ssh_port),
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
        _model_login: Option<ModelLogin>,
        _force_restart: bool,
        progress: &(dyn Fn(BootstrapPhase) + Sync),
    ) -> Result<RemoteReport, ConnectError> {
        let gate = self.bootstrap_gate.lock().unwrap_or_else(PoisonError::into_inner).clone();
        if let Some(gate) = gate {
            gate.hold().await;
        }
        progress(BootstrapPhase::Check { detail: "linux-x64".to_owned() });
        Ok(report(*self.ssh_port.lock().unwrap_or_else(PoisonError::into_inner)))
    }

    fn open_tunnel(&self, _spec: TunnelSpec) -> Arc<dyn TunnelHandle> {
        self.opened.fetch_add(1, Ordering::SeqCst);
        let tunnel = Arc::new(FakeTunnel {
            companion: self.companion,
            state: watch::channel(TunnelState::Up).0,
            stops: AtomicUsize::new(0),
            stop_gate: self.stop_gate.clone(),
        });
        self.tunnels.lock().unwrap_or_else(PoisonError::into_inner).push(tunnel.clone());
        tunnel
    }
}

type Phases = Arc<Mutex<Vec<SessionPhase>>>;

fn session(transport: &Arc<FakeTransport>) -> (Arc<RemoteSession>, Phases) {
    let phases: Phases = Arc::default();
    let record = phases.clone();
    let mut config = RemoteSessionConfig::new(parse_ssh_target("me@server").unwrap());
    config.tunnel_ready_timeout = Some(Duration::from_millis(500));
    config.progress = Some(Arc::new(move |phase| record.lock().unwrap_or_else(PoisonError::into_inner).push(phase)));
    (Arc::new(RemoteSession::new(config, transport.clone())), phases)
}

async fn yield_often() {
    for _ in 0..50 {
        tokio::task::yield_now().await;
    }
}

fn stops(transport: &FakeTransport, index: usize) -> usize {
    transport.tunnels.lock().unwrap_or_else(PoisonError::into_inner)[index].stops.load(Ordering::SeqCst)
}

#[tokio::test]
async fn a_close_during_the_stop_of_a_replaced_tunnel_leaves_no_replacement_and_no_endpoint() {
    let health = serve_health().await;
    let transport = FakeTransport::new(health.port);
    let (session, _) = session(&transport);
    session.connect().await.unwrap();
    assert_eq!(transport.opened.load(Ordering::SeqCst), 1);

    // The core moved to another port: the reconnect replaces the tunnel, and the stop of the old one is held.
    let stopping = Arc::new(Gate::default());
    *transport.stop_gate.lock().unwrap() = Some(stopping.clone());
    *transport.ssh_port.lock().unwrap() = 41_900;
    let reconnect = tokio::spawn({
        let session = session.clone();
        async move { session.connect().await }
    });
    stopping.arrived.notified().await;

    // The user closes while the old tunnel is still stopping: close joins that stop (it is not an empty slot to return from).
    let closing = tokio::spawn({
        let session = session.clone();
        async move { session.close().await }
    });
    yield_often().await;
    assert!(!closing.is_finished(), "close does not return while a tunnel it must reap is still stopping");
    assert_eq!(transport.opened.load(Ordering::SeqCst), 1, "no replacement was started");

    stopping.release.notify_one();
    closing.await.unwrap();
    assert_eq!(reconnect.await.unwrap(), Err(SessionError::Closed), "the reconnect lost to the close");
    assert_eq!(transport.opened.load(Ordering::SeqCst), 1, "the reconnect did not start a tunnel after the close");
    assert_eq!(stops(&transport, 0), 1, "the old tunnel was stopped once, by whoever got there first");
    assert_eq!(session.current_endpoint(), None);
    assert_eq!(session.connect().await, Err(SessionError::Closed), "a closed session stays closed");
}

#[tokio::test]
async fn a_close_while_the_health_answer_is_outstanding_publishes_no_endpoint_and_no_ready() {
    let health = serve_health().await;
    health.held.store(true, Ordering::SeqCst);
    let transport = FakeTransport::new(health.port);
    let (session, phases) = session(&transport);
    let connecting = tokio::spawn({
        let session = session.clone();
        async move { session.connect().await }
    });
    health.gate.arrived.notified().await;

    session.close().await;
    // The core now answers, correctly: the answer is the right pid and instance, and it is too late.
    health.gate.release.notify_one();
    assert_eq!(connecting.await.unwrap(), Err(SessionError::Closed));
    assert_eq!(session.current_endpoint(), None, "no endpoint, so no bearer, was published");
    assert!(!phases.lock().unwrap().contains(&SessionPhase::Ready), "no Ready after the close: {:?}", phases.lock().unwrap());
    assert_eq!(stops(&transport, 0), 1, "the tunnel the lost attempt installed was stopped by the close, once");
}

#[tokio::test]
async fn a_close_while_the_bootstrap_runs_starts_no_tunnel_and_reports_nothing_after_it() {
    let health = serve_health().await;
    let transport = FakeTransport::new(health.port);
    let running = Arc::new(Gate::default());
    *transport.bootstrap_gate.lock().unwrap() = Some(running.clone());
    let (session, phases) = session(&transport);
    let connecting = tokio::spawn({
        let session = session.clone();
        async move { session.connect().await }
    });
    running.arrived.notified().await;

    session.close().await;
    running.release.notify_one();
    assert_eq!(connecting.await.unwrap(), Err(SessionError::Closed));
    assert_eq!(transport.opened.load(Ordering::SeqCst), 0, "no tunnel was started for an attempt that lost");
    assert_eq!(*phases.lock().unwrap(), vec![SessionPhase::Connect], "nothing was reported after the close");
}

#[tokio::test]
async fn a_connect_that_waited_behind_another_gets_no_endpoint_after_a_close() {
    let health = serve_health().await;
    let transport = FakeTransport::new(health.port);
    let running = Arc::new(Gate::default());
    *transport.bootstrap_gate.lock().unwrap() = Some(running.clone());
    let (session, _) = session(&transport);
    let first = tokio::spawn({
        let session = session.clone();
        async move { session.connect().await }
    });
    running.arrived.notified().await;
    *transport.bootstrap_gate.lock().unwrap() = None;

    // A turn queued behind the first connect, held by the test: the waiting connect resumes only when the test lets it.
    let (taken, take) = tokio::sync::oneshot::channel();
    let (let_go, hold) = tokio::sync::oneshot::channel::<()>();
    let holder = tokio::spawn({
        let gate = session.gate.clone();
        async move {
            let _turn = gate.acquire().await;
            let _ = taken.send(());
            let _ = hold.await;
        }
    });
    yield_often().await;
    let waiting = tokio::spawn({
        let session = session.clone();
        async move { session.connect().await }
    });
    yield_often().await;

    running.release.notify_one();
    let endpoint = first.await.unwrap().unwrap();
    assert_eq!(endpoint.token, "secret-token");
    take.await.unwrap();
    // The session is closed while the coalesced result waits to be handed out.
    session.close().await;
    let_go.send(()).unwrap();
    holder.await.unwrap();
    assert_eq!(waiting.await.unwrap(), Err(SessionError::Closed), "the cached endpoint and token are not handed out after the close");
}

#[tokio::test]
async fn a_close_after_a_failure_joins_the_stop_of_the_failed_tunnel() {
    let health = serve_health().await;
    let transport = FakeTransport::new(health.port);
    let (session, _) = session(&transport);
    session.connect().await.unwrap();

    let stopping = Arc::new(Gate::default());
    *transport.stop_gate.lock().unwrap() = Some(stopping.clone());
    session.fail(SessionError::Closed);
    stopping.arrived.notified().await;

    let closing = tokio::spawn({
        let session = session.clone();
        async move { session.close().await }
    });
    yield_often().await;
    assert!(!closing.is_finished(), "close waits for the failed tunnel's stop");
    stopping.release.notify_one();
    closing.await.unwrap();
    assert_eq!(stops(&transport, 0), 1, "the failed tunnel was stopped once");
    assert_eq!(session.current_endpoint(), None);
}