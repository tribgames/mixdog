//! Tests of the remote session. No ssh is started and no server is dialed: the transport is a fake whose tunnels are
//! scripted, and the "core" behind the companion port is a loopback listener answering `/health`.

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, PoisonError};
use std::time::Duration;

use async_trait::async_trait;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use tokio::sync::watch;

use crate::bootstrap::{BootstrapPhase, RemoteDiscovery, RemoteReport};
use crate::command::{parse_ssh_target, FailureClass, SshError};
use crate::connect_failure::ConnectError;
use crate::context::ModelLogin;
use crate::session::{
    dechunk, http_body, read_health, resolve_remote_cwd, Endpoint, RemoteSession, RemoteSessionConfig, SessionError, SessionPhase, Transport,
    TunnelHandle,
};
use crate::tunnel::{TunnelSpec, TunnelState};

const PID: u32 = 4242;
const INSTANCE: &str = "run-a";

/// A core's `/health` on a loopback port; the body can be swapped while it runs.
struct HealthServer {
    port: u16,
    body: Arc<Mutex<String>>,
}

fn health_body(pid: u32, instance: &str, busy: u32) -> String {
    format!(r#"{{"status":"ok","pid":{pid},"instanceId":"{instance}","busy":{busy}}}"#)
}

async fn serve_health(body: String) -> HealthServer {
    let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let body = Arc::new(Mutex::new(body));
    let answers = body.clone();
    tokio::spawn(async move {
        loop {
            let Ok((mut stream, _)) = listener.accept().await else { return };
            let text = answers.lock().unwrap_or_else(PoisonError::into_inner).clone();
            tokio::spawn(async move {
                let mut request = [0_u8; 1024];
                let _ = stream.read(&mut request).await;
                let reply = format!("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{text}", text.len());
                let _ = stream.write_all(reply.as_bytes()).await;
            });
        }
    });
    HealthServer { port, body }
}

impl HealthServer {
    fn answer(&self, body: String) {
        *self.body.lock().unwrap_or_else(PoisonError::into_inner) = body;
    }
}

struct FakeTunnel {
    companion: u16,
    state: watch::Sender<TunnelState>,
    restarts: AtomicUsize,
    revives: AtomicUsize,
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

    fn restart(&self) {
        self.restarts.fetch_add(1, Ordering::SeqCst);
    }

    fn revive(&self) {
        self.revives.fetch_add(1, Ordering::SeqCst);
    }

    async fn stop(&self) {
        self.stops.fetch_add(1, Ordering::SeqCst);
        self.state.send_replace(TunnelState::Stopped { failure: None });
    }
}

struct FakeTransport {
    companion: u16,
    initial: TunnelState,
    rpc_port: Mutex<u16>,
    bootstraps: AtomicUsize,
    forces: Mutex<Vec<bool>>,
    logins: Mutex<Vec<Option<ModelLogin>>>,
    failure: Mutex<Option<ConnectError>>,
    tunnels: Mutex<Vec<Arc<FakeTunnel>>>,
    specs: Mutex<Vec<TunnelSpec>>,
}

impl FakeTransport {
    fn new(companion: u16) -> Arc<Self> {
        Self::starting(companion, TunnelState::Up)
    }

    fn starting(companion: u16, initial: TunnelState) -> Arc<Self> {
        Arc::new(Self {
            companion,
            initial,
            rpc_port: Mutex::new(41_001),
            bootstraps: AtomicUsize::new(0),
            forces: Mutex::new(Vec::new()),
            logins: Mutex::new(Vec::new()),
            failure: Mutex::new(None),
            tunnels: Mutex::new(Vec::new()),
            specs: Mutex::new(Vec::new()),
        })
    }

    fn tunnel(&self, index: usize) -> Arc<FakeTunnel> {
        self.tunnels.lock().unwrap_or_else(PoisonError::into_inner)[index].clone()
    }
}

fn report(rpc_port: u16) -> RemoteReport {
    RemoteReport {
        home: "/home/me".to_owned(),
        uid: 1000,
        runtime_root: "/home/me/.mixdog".to_owned(),
        version_dir: "/home/me/.mixdog/v".to_owned(),
        installed: true,
        discovery: Some(RemoteDiscovery {
            rpc_port: Some(rpc_port),
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
        model_login: Option<ModelLogin>,
        force_restart: bool,
        progress: &(dyn Fn(BootstrapPhase) + Sync),
    ) -> Result<RemoteReport, ConnectError> {
        self.bootstraps.fetch_add(1, Ordering::SeqCst);
        self.forces.lock().unwrap_or_else(PoisonError::into_inner).push(force_restart);
        self.logins.lock().unwrap_or_else(PoisonError::into_inner).push(model_login);
        tokio::task::yield_now().await;
        progress(BootstrapPhase::Check { detail: "linux-x64".to_owned() });
        if let Some(failure) = self.failure.lock().unwrap_or_else(PoisonError::into_inner).clone() {
            return Err(failure);
        }
        Ok(report(*self.rpc_port.lock().unwrap_or_else(PoisonError::into_inner)))
    }

    fn open_tunnel(&self, spec: TunnelSpec) -> Arc<dyn TunnelHandle> {
        let (state, _) = watch::channel(self.initial.clone());
        let tunnel = Arc::new(FakeTunnel {
            companion: self.companion,
            state,
            restarts: AtomicUsize::new(0),
            revives: AtomicUsize::new(0),
            stops: AtomicUsize::new(0),
        });
        self.specs.lock().unwrap_or_else(PoisonError::into_inner).push(spec);
        self.tunnels.lock().unwrap_or_else(PoisonError::into_inner).push(tunnel.clone());
        tunnel
    }
}

fn session_with(transport: &Arc<FakeTransport>, change: impl FnOnce(&mut RemoteSessionConfig)) -> RemoteSession {
    let mut config = RemoteSessionConfig::new(parse_ssh_target("me@server").unwrap());
    config.tunnel_ready_timeout = Some(Duration::from_millis(200));
    change(&mut config);
    RemoteSession::new(config, transport.clone())
}

fn session(transport: &Arc<FakeTransport>) -> RemoteSession {
    session_with(transport, |_| {})
}

fn count(counter: &AtomicUsize) -> usize {
    counter.load(Ordering::SeqCst)
}

#[tokio::test]
async fn a_matching_core_yields_the_endpoint_with_its_token_and_the_resolved_folder() {
    let core = serve_health(health_body(PID, INSTANCE, 0)).await;
    let transport = FakeTransport::new(core.port);
    let session = session_with(&transport, |config| config.remote_cwd = Some("~/work/../proj".to_owned()));
    let endpoint = session.connect().await.unwrap();
    assert_eq!(
        endpoint,
        Endpoint {
            url: "ws://127.0.0.1:50001/rpc".to_owned(),
            token: "secret-token".to_owned(),
            server_instance_id: INSTANCE.to_owned(),
            pid: PID,
            cwd: "/home/me/proj".to_owned(),
            core_version: "1.2.3".to_owned(),
        }
    );
    assert_eq!(session.current_endpoint(), Some(endpoint));
    let specs = transport.specs.lock().unwrap_or_else(PoisonError::into_inner);
    let remotes: Vec<u16> = specs[0].forwards.iter().map(|forward| forward.remote_port).collect();
    assert_eq!(remotes, vec![41_001, 41_002]);
}

#[tokio::test]
async fn identity_mismatch_refused() {
    for (pid, instance) in [(PID + 1, INSTANCE), (PID, "run-b")] {
        let core = serve_health(health_body(pid, instance, 0)).await;
        let transport = FakeTransport::new(core.port);
        let session = session(&transport);
        let error = session.connect().await.unwrap_err();
        assert!(error.is_terminal(), "{error}");
        assert!(error.to_string().contains("Another process answered through the ssh tunnel to me@server"), "{error}");
        assert_eq!(session.current_endpoint(), None);
        // The session stopped for good: nothing is dialed again, the same words come back, the tunnel is let go.
        assert_eq!(session.connect().await.unwrap_err(), error);
        assert_eq!(count(&transport.bootstraps), 1);
        assert_eq!(session.stopped_by(), Some(error));
    }
}

#[tokio::test]
async fn a_core_that_does_not_answer_is_a_transient_failure_and_the_session_stays_usable() {
    let silent = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
    let transport = FakeTransport::new(silent.local_addr().unwrap().port());
    drop(silent);
    let session = session(&transport);
    let error = session.connect().await.unwrap_err();
    assert!(!error.is_terminal());
    assert!(error.to_string().contains("does not answer through the ssh tunnel"), "{error}");
    assert_eq!(session.stopped_by(), None);
    assert!(session.connect().await.is_err());
    assert_eq!(count(&transport.bootstraps), 2);
}

#[tokio::test]
async fn hold_release() {
    let core = serve_health(health_body(PID, INSTANCE, 0)).await;
    let transport = FakeTransport::new(core.port);
    let session = session(&transport);
    session.hold();
    assert_eq!(session.connect().await.unwrap_err(), SessionError::ReconnectOff);
    assert_eq!(count(&transport.bootstraps), 0);
    session.release();
    assert!(session.connect().await.is_ok());
    assert_eq!(count(&transport.bootstraps), 1);
}

#[tokio::test]
async fn reset_and_revive() {
    let core = serve_health(health_body(PID, INSTANCE, 0)).await;
    let transport = FakeTransport::new(core.port);
    let session = session(&transport);
    // Nothing to reset before a tunnel exists.
    session.reset_tunnel();
    session.revive_tunnel();
    session.connect().await.unwrap();
    let tunnel = transport.tunnel(0);
    assert_eq!((count(&tunnel.restarts), count(&tunnel.revives)), (0, 0));
    session.reset_tunnel();
    session.revive_tunnel();
    session.revive_tunnel();
    assert_eq!((count(&tunnel.restarts), count(&tunnel.revives)), (1, 2));
}

#[tokio::test]
async fn probe_and_busy_read_the_attached_core_and_refuse_another_answer() {
    let core = serve_health(health_body(PID, INSTANCE, 3)).await;
    let transport = FakeTransport::new(core.port);
    let session = session(&transport);
    assert_eq!(session.busy_sessions().await, None);
    assert_eq!(session.probe_health(Duration::from_millis(500)).await, None);
    session.connect().await.unwrap();
    assert_eq!(session.busy_sessions().await, Some(3));
    assert!(session.probe_health(Duration::from_millis(500)).await.is_some());
    core.answer(health_body(PID, "run-b", 3));
    assert_eq!(session.busy_sessions().await, None);
    assert_eq!(session.probe_health(Duration::from_millis(500)).await, None);
    session.invalidate();
    core.answer(health_body(PID, INSTANCE, 1));
    assert_eq!(session.busy_sessions().await, None);
}

#[tokio::test]
async fn a_reconnect_of_the_same_core_reuses_its_tunnel() {
    let core = serve_health(health_body(PID, INSTANCE, 0)).await;
    let transport = FakeTransport::new(core.port);
    let session = session(&transport);
    session.connect().await.unwrap();
    session.invalidate();
    assert_eq!(session.current_endpoint(), None);
    session.connect().await.unwrap();
    assert_eq!(transport.tunnels.lock().unwrap_or_else(PoisonError::into_inner).len(), 1);
    assert_eq!(count(&transport.tunnel(0).stops), 0);
}

#[tokio::test]
async fn a_core_that_moved_gets_a_new_tunnel_and_the_old_one_is_stopped() {
    let core = serve_health(health_body(PID, INSTANCE, 0)).await;
    let transport = FakeTransport::new(core.port);
    let session = session(&transport);
    session.connect().await.unwrap();
    *transport.rpc_port.lock().unwrap_or_else(PoisonError::into_inner) = 41_900;
    session.connect().await.unwrap();
    assert_eq!(transport.tunnels.lock().unwrap_or_else(PoisonError::into_inner).len(), 2);
    assert_eq!(count(&transport.tunnel(0).stops), 1);
}

#[tokio::test]
async fn a_stopped_tunnel_of_the_same_core_is_started_again() {
    let core = serve_health(health_body(PID, INSTANCE, 0)).await;
    let transport = FakeTransport::new(core.port);
    let session = session(&transport);
    session.connect().await.unwrap();
    let tunnel = transport.tunnel(0);
    tunnel.state.send_replace(TunnelState::Stopped { failure: None });
    let bring_up = tunnel.clone();
    let watcher = tokio::spawn(async move {
        while count(&bring_up.revives) == 0 {
            tokio::task::yield_now().await;
        }
        bring_up.state.send_replace(TunnelState::Up);
    });
    session.connect().await.unwrap();
    watcher.await.unwrap();
    assert_eq!(count(&tunnel.revives), 1);
}

#[tokio::test]
async fn a_tunnel_that_never_comes_up_times_out_and_a_terminal_tunnel_failure_stops_the_session() {
    let transport = FakeTransport::starting(1, TunnelState::Starting);
    let session = session_with(&transport, |config| config.tunnel_ready_timeout = Some(Duration::from_millis(30)));
    let error = session.connect().await.unwrap_err();
    assert!(error.to_string().contains("is not ready after 30 ms"), "{error}");
    assert!(!error.is_terminal());
    assert_eq!(session.stopped_by(), None);

    let refused = SshError::new("Host key verification failed.", FailureClass::Terminal);
    transport.tunnel(0).state.send_replace(TunnelState::Stopped { failure: Some(refused.clone()) });
    let error = session.connect().await.unwrap_err();
    assert_eq!(error, SessionError::from(refused));
    assert_eq!(session.connect().await.unwrap_err(), error);
    assert_eq!(count(&transport.bootstraps), 2);
}

#[tokio::test]
async fn a_terminal_bootstrap_failure_stops_the_session_and_keeps_the_words() {
    let transport = FakeTransport::new(1);
    let refused = SshError::new("Permission denied (publickey).", FailureClass::Terminal);
    *transport.failure.lock().unwrap_or_else(PoisonError::into_inner) = Some(refused.clone().into());
    let session = session(&transport);
    let error = session.connect().await.unwrap_err();
    assert_eq!(error, SessionError::from(refused));
    assert!(session.connect().await.is_err());
    assert_eq!(count(&transport.bootstraps), 1);

    let transient = FakeTransport::new(1);
    *transient.failure.lock().unwrap_or_else(PoisonError::into_inner) = Some(SshError::new("Connection timed out", FailureClass::Transient).into());
    let session = self::session(&transient);
    assert!(session.connect().await.is_err());
    assert!(session.connect().await.is_err());
    assert_eq!(count(&transient.bootstraps), 2);
}

#[tokio::test]
async fn fail_stops_for_good_and_close_detaches_leaving_the_core() {
    let core = serve_health(health_body(PID, INSTANCE, 0)).await;
    let transport = FakeTransport::new(core.port);
    let session = session(&transport);
    session.connect().await.unwrap();
    let mismatch = SessionError::from(SshError::new("protocol mismatch", FailureClass::Terminal));
    session.fail(mismatch.clone());
    session.fail(SessionError::Closed);
    assert_eq!(session.current_endpoint(), None);
    assert_eq!(session.connect().await.unwrap_err(), mismatch);
    assert_eq!(session.stopped_by(), Some(mismatch));

    let transport = FakeTransport::new(core.port);
    let session = self::session(&transport);
    session.connect().await.unwrap();
    session.close().await;
    assert_eq!(count(&transport.tunnel(0).stops), 1);
    assert_eq!(session.current_endpoint(), None);
    assert_eq!(session.connect().await.unwrap_err(), SessionError::Closed);
}

#[tokio::test]
async fn connects_that_overlap_share_one_bootstrap_and_the_confirmation_covers_the_first_only() {
    let core = serve_health(health_body(PID, INSTANCE, 0)).await;
    let transport = FakeTransport::new(core.port);
    let session = session_with(&transport, |config| {
        config.force_restart = true;
        config.model_login = Some(ModelLogin::Server);
    });
    let (first, second) = tokio::join!(session.connect(), session.connect());
    assert_eq!(first.unwrap(), second.unwrap());
    assert_eq!(count(&transport.bootstraps), 1);
    session.invalidate();
    session.connect().await.unwrap();
    assert_eq!(*transport.forces.lock().unwrap_or_else(PoisonError::into_inner), vec![true, false]);
    assert_eq!(*transport.logins.lock().unwrap_or_else(PoisonError::into_inner), vec![Some(ModelLogin::Server); 2]);
}

#[tokio::test]
async fn progress_reports_connect_check_start_start_ready() {
    let core = serve_health(health_body(PID, INSTANCE, 0)).await;
    let transport = FakeTransport::new(core.port);
    let seen = Arc::new(Mutex::new(Vec::new()));
    let sink = seen.clone();
    let session = session_with(&transport, |config| {
        config.progress = Some(Arc::new(move |phase| sink.lock().unwrap_or_else(PoisonError::into_inner).push(phase)));
    });
    session.connect().await.unwrap();
    assert_eq!(
        *seen.lock().unwrap_or_else(PoisonError::into_inner),
        vec![SessionPhase::Connect, SessionPhase::Check { detail: "linux-x64".to_owned() }, SessionPhase::Start, SessionPhase::Ready]
    );
}

#[test]
fn the_remote_folder_resolves_against_the_home_and_must_be_absolute() {
    let home = "/home/me";
    assert_eq!(resolve_remote_cwd(None, home).unwrap(), home);
    assert_eq!(resolve_remote_cwd(Some(""), home).unwrap(), home);
    assert_eq!(resolve_remote_cwd(Some("~"), home).unwrap(), home);
    assert_eq!(resolve_remote_cwd(Some("~/a/./b/"), home).unwrap(), "/home/me/a/b");
    assert_eq!(resolve_remote_cwd(Some("/srv//app/../x"), home).unwrap(), "/srv/x");
    assert!(resolve_remote_cwd(Some("relative/dir"), home).unwrap_err().to_string().contains("absolute server path"));
    assert!(resolve_remote_cwd(Some("/a\u{7}b"), home).unwrap_err().to_string().contains("control characters"));
}

#[tokio::test]
async fn health_is_read_from_plain_and_chunked_answers_and_refused_when_not_ok_or_late() {
    let core = serve_health(r#"{"status":"ok","pid":"7","instanceId":"","busy":-2}"#.to_owned()).await;
    let health = read_health(core.port, Duration::from_millis(500)).await.unwrap();
    assert_eq!((health.pid, health.busy, health.instance_id), (7, 0, None));
    core.answer(r#"{"status":"starting","pid":7}"#.to_owned());
    assert_eq!(read_health(core.port, Duration::from_millis(500)).await, None);
    core.answer("not json".to_owned());
    assert_eq!(read_health(core.port, Duration::from_millis(500)).await, None);

    let raw = b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n5\r\nhello\r\n6;x=1\r\n world\r\n0\r\n\r\n";
    assert_eq!(http_body(raw).unwrap(), b"hello world");
    assert_eq!(dechunk(b"5\r\nhel"), None);
    assert_eq!(http_body(b"HTTP/1.1 200 OK\r\n"), None);

    let stalled = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
    let port = stalled.local_addr().unwrap().port();
    let hold = tokio::spawn(async move {
        let (_stream, _) = stalled.accept().await.unwrap();
        mixdog_rt::time::sleep(Duration::from_secs(5)).await;
    });
    assert_eq!(read_health(port, Duration::from_millis(50)).await, None);
    hold.abort();
}
