//! An ssh-attached desktop on the real serving path: the core learns the connection is ssh from the listener it arrived on (`core.sshRpc`
//! in the published discovery), so its leaving takes the remote grace, not the local 10 s. The test is handed nothing: the discovery is what
//! `serving::start` published, read by the production bootstrap parser, the endpoint is chosen by the production `RemoteSession`, and the fake
//! tunnel only passes TCP through to the ports of the `TunnelSpec` it is given.
//!
//! These run in real time (the core's grace timer is an OS thread, `lifecycle::grace::ThreadTimer`), so the windows are the real 10 s local grace
//! and the 30 minute remote default; the virtual-time cases are in `late_lifecycle` and `lifecycle::tests`.

use std::net::Ipv4Addr;
use std::path::Path;
use std::sync::Arc;
use std::sync::Mutex;
use std::time::Duration;

use async_trait::async_trait;
use futures::SinkExt as _;
use futures::StreamExt as _;
use tokio::net::TcpListener;
use tokio::net::TcpStream;
use tokio::sync::oneshot;
use tokio::sync::watch;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::tungstenite::client::IntoClientRequest as _;

use mixdog_ssh::bootstrap::BootstrapPhase;
use mixdog_ssh::bootstrap::RemoteReport;
use mixdog_ssh::bootstrap::parse_remote_discovery;
use mixdog_ssh::command::parse_ssh_target;
use mixdog_ssh::connect_failure::ConnectError;
use mixdog_ssh::context::ModelLogin;
use mixdog_ssh::session::RemoteSession;
use mixdog_ssh::session::RemoteSessionConfig;
use mixdog_ssh::session::Transport;
use mixdog_ssh::session::TunnelHandle;
use mixdog_ssh::tunnel::TunnelSpec;
use mixdog_ssh::tunnel::TunnelState;

use crate::compose::ComposeConfig;
use crate::lifecycle::Exiter;
use crate::serving::Serving;
use crate::serving::StartIn;
use crate::serving::start;

struct RecordedExit(Mutex<Option<oneshot::Sender<()>>>);

impl Exiter for RecordedExit {
    fn exit(&self, _: i32) {
        if let Some(done) = self.0.lock().unwrap().take() {
            let _ = done.send(());
        }
    }
}

/// The real composed core, serving, with its discovery on disk.
async fn serving_core(dir: &Path) -> (Serving, oneshot::Receiver<()>, std::path::PathBuf) {
    crate::compose_test_support::seed_default_model(&crate::compose_test_support::data_in(dir));
    let tokens = mixdog_rt::testing::tokens();
    let outgoing = mixdog_app_server::Outgoing::new();
    let core = Arc::new(
        crate::compose::compose(
            &tokens,
            ComposeConfig {
                rebuild: Default::default(),
                data_dir: crate::compose_test_support::data_in(dir),
                user_data_dir: dir.join("userdata"),
                runtime_root: dir.join("runtime"),
                js_runtime: crate::js_runtime::fixture(dir),
                ort_library: mixdog_services::effort_judge::model::OrtRuntime::NoBinding,
                outgoing: outgoing.clone(),
                ownership: Arc::new(mixdog_core_api::domain::mock::MockOwnership::default()),
                log: crate::daemon_log::DaemonLog::new(dir.join("daemon.log"), tokens.maintenance_io, mixdog_rt::CancellationToken::new()),
                stop: mixdog_rt::CancellationToken::new(),
                catalog_http: crate::compose_test_support::offline_http(),
                agent_presets: Vec::new(),
                acp_data_dir: None,
                pg_install: None,
            },
        )
        .await
        .unwrap(),
    );
    let (exited, exit) = oneshot::channel();
    let root = dir.join("runtime");
    let serving = start(
        &tokens,
        core,
        outgoing,
        StartIn { runtime_root: root.clone(), exiter: Arc::new(RecordedExit(Mutex::new(Some(exited)))), update_text: "Update.".into() },
    )
    .await
    .unwrap();
    serving.lifecycle.set_serving().unwrap();
    let writer = serving.discovery.clone();
    writer.flush();
    (serving, exit, root)
}

/// One `desktop` client of the core on `port`, initialized.
async fn attach(port: u16, token: &str) -> tokio_tungstenite::WebSocketStream<TcpStream> {
    let mut request = format!("ws://127.0.0.1:{port}/rpc").into_client_request().unwrap();
    request.headers_mut().insert("Authorization", format!("Bearer {token}").parse().unwrap());
    let stream = TcpStream::connect((Ipv4Addr::LOCALHOST, port)).await.unwrap();
    let (mut socket, _) = tokio_tungstenite::client_async(request, stream).await.unwrap();
    let initialize = serde_json::json!({"jsonrpc":"2.0","id":0,"method":"initialize","params":{
        "clientInfo":{"name":"test","version":env!("CARGO_PKG_VERSION"),"kind":"desktop"},"capabilities":{}}});
    socket.send(Message::text(initialize.to_string())).await.unwrap();
    loop {
        let frame = socket.next().await.expect("the connection stays open").unwrap();
        let Ok(text) = frame.to_text() else { continue };
        let Ok(value) = serde_json::from_str::<serde_json::Value>(text) else { continue };
        if value["id"] == 0 {
            assert!(value.get("result").is_some(), "initialized: {value}");
            return socket;
        }
    }
}

/// Passes TCP through: each forward of the spec gets a loopback listener whose connections go to the forward's remote port.
struct PassThrough {
    ports: Vec<u16>,
    state: watch::Sender<TunnelState>,
}

impl PassThrough {
    async fn open(spec: TunnelSpec) -> Arc<Self> {
        let mut ports = Vec::new();
        for forward in spec.forwards {
            let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).await.unwrap();
            ports.push(listener.local_addr().unwrap().port());
            tokio::spawn(async move {
                while let Ok((mut near, _)) = listener.accept().await {
                    tokio::spawn(async move {
                        if let Ok(mut far) = TcpStream::connect((Ipv4Addr::LOCALHOST, forward.remote_port)).await {
                            let _ = tokio::io::copy_bidirectional(&mut near, &mut far).await;
                        }
                    });
                }
            });
        }
        let (state, _) = watch::channel(TunnelState::Up);
        Arc::new(Self { ports, state })
    }
}

#[async_trait]
impl TunnelHandle for PassThrough {
    fn local_port(&self) -> u16 {
        self.ports[0]
    }

    fn companion_port(&self) -> u16 {
        self.ports[1]
    }

    fn state(&self) -> watch::Receiver<TunnelState> {
        self.state.subscribe()
    }

    fn restart(&self) {}

    fn revive(&self) {}

    async fn stop(&self) {
        self.state.send_replace(TunnelState::Stopped { failure: None });
    }
}

/// The bootstrap of a server whose core already runs: the report is the published discovery as the production parser reads it.
struct PublishedDiscovery {
    daemon_json: String,
}

#[async_trait]
impl Transport for PublishedDiscovery {
    async fn bootstrap(&self, _: Option<ModelLogin>, _: bool, progress: &(dyn Fn(BootstrapPhase) + Sync)) -> Result<RemoteReport, ConnectError> {
        progress(BootstrapPhase::Check { detail: "test".to_owned() });
        Ok(RemoteReport {
            home: "/home/me".to_owned(),
            uid: 1000,
            runtime_root: "/home/me/.mixdog".to_owned(),
            version_dir: "/home/me/.mixdog/v".to_owned(),
            installed: true,
            discovery: Some(parse_remote_discovery(&self.daemon_json).expect("the published discovery parses")),
            healthy: true,
            core_current: true,
            started: false,
            replaced: None,
            gc_removed: Vec::new(),
        })
    }

    fn open_tunnel(&self, spec: TunnelSpec) -> Arc<dyn TunnelHandle> {
        // `open_tunnel` is synchronous; the pass-through binds on the running runtime.
        let (opened, wait) = std::sync::mpsc::channel();
        let handle = tokio::runtime::Handle::current();
        std::thread::spawn(move || {
            let _ = opened.send(handle.block_on(PassThrough::open(spec)));
        });
        wait.recv().unwrap()
    }
}

/// One request on an initialized socket and its response frame.
async fn call(socket: &mut tokio_tungstenite::WebSocketStream<TcpStream>, id: u64, method: &str, params: serde_json::Value) -> serde_json::Value {
    socket.send(Message::text(serde_json::json!({"jsonrpc":"2.0","id":id,"method":method,"params":params}).to_string())).await.unwrap();
    loop {
        let frame = socket.next().await.expect("the connection stays open").unwrap();
        let Ok(text) = frame.to_text() else { continue };
        let Ok(value) = serde_json::from_str::<serde_json::Value>(text) else { continue };
        if value["id"] == id {
            return value;
        }
    }
}

/// The remote grace this test configures for the core (read by the core when it arms the grace, `ClientGrace::after`): longer than the 10 s
/// local one and short enough to observe its end. The 1.4.5 default is 30 minutes.
const REMOTE_GRACE_MS: u64 = 16_000;

/// The recorded end is the no-clients shutdown. A Unix process session cannot rule out a descendant that left it, so the drain of a
/// managed process there ends unverified and the reason says so.
fn assert_no_clients_end(last: &serde_json::Value) {
    let reason = last["reason"].as_str().unwrap_or_else(|| panic!("{last}"));
    let unverified = cfg!(unix) && reason == "noClients (managed process drain coverage unverified)";
    assert!(reason == "noClients" || unverified, "the end was the no-clients shutdown, not a stop request: {reason}");
}

#[test]
#[ignore = "integration: composes the real core, which needs a bundled Postgres runtime (MIXDOG_PG_RUNTIME); no network; about 45 s of real time"]
#[allow(clippy::disallowed_methods, reason = "test: the grace is the core's launch setting, which the host passes through the environment")]
fn an_ssh_attached_session_survives_the_disconnect_and_the_core_ends_itself_only_after_the_remote_grace() {
    // SAFETY: each composed test runs in its own process (nextest); this is set before the child, which inherits it, starts.
    unsafe { std::env::set_var("MIXDOG_REMOTE_CLIENT_GRACE_MS", REMOTE_GRACE_MS.to_string()) };
    crate::compose_test_support::in_child(
        module_path!(),
        "an_ssh_attached_session_survives_the_disconnect_and_the_core_ends_itself_only_after_the_remote_grace",
        tokio::runtime::Builder::new_multi_thread(),
        |dir| async move {
            let (serving, mut exit, root) = serving_core(&dir).await;
            let daemon_json = tokio::fs::read_to_string(crate::discovery::path(&root)).await.unwrap();
            let target = parse_ssh_target("me@server.example").unwrap();
            let session = RemoteSession::new(RemoteSessionConfig::new(target), Arc::new(PublishedDiscovery { daemon_json }));
            let port = |url: &str| url.rsplit(':').next().unwrap().trim_end_matches("/rpc").parse::<u16>().unwrap();
            let marker = "ssh-continuity-marker";

            // Socket A: create a session and write something identifiable into it.
            let first = session.connect().await.unwrap();
            let mut socket = attach(port(&first.url), &first.token).await;
            assert_eq!(serving.lifecycle.status().clients, 1, "the ssh-attached desktop is counted");
            let started = call(&mut socket, 1, "thread/start", serde_json::json!({"opId":"op-start","kind":"task"})).await;
            let thread = started["result"]["thread"]["id"].as_str().unwrap_or_else(|| panic!("{started}")).to_owned();
            let named = call(&mut socket, 2, "thread/name/set", serde_json::json!({"threadId": thread, "opId": "op-name", "title": marker})).await;
            assert!(named.get("result").is_some(), "{named}");
            drop(socket);

            // Past the local grace (10 s), inside the remote one: the core is still there, the same one, with the same session.
            tokio::time::sleep(Duration::from_secs(12)).await;
            assert!(exit.try_recv().is_err(), "the core outlives its last ssh client by more than the local grace");
            assert_eq!(serving.lifecycle.status().clients, 0);

            // Socket B: the production selection again (a new attachment, the same core), initialized afresh; the session is read, not recreated.
            let second = session.connect().await.unwrap();
            assert_eq!(second.server_instance_id, first.server_instance_id, "a reconnect inside the window finds the same core");
            let mut socket = attach(port(&second.url), &second.token).await;
            assert_eq!(serving.lifecycle.status().clients, 1);
            let read = call(&mut socket, 1, "thread/read", serde_json::json!({"threadId": thread})).await;
            assert!(read.get("result").is_some(), "the session of the first socket is there: {read}");
            assert!(read["result"].to_string().contains(marker), "its saved content is there: {read}");

            // Past the deadline the first disconnect had armed: the reconnect cancelled it, so nothing ends the core while B is attached.
            tokio::time::sleep(Duration::from_secs(12)).await;
            assert!(exit.try_recv().is_err(), "an attached client keeps the core up past the deadline of the earlier disconnect");
            drop(socket);

            // The last disconnect starts the grace again, in full: not over before the window, over after it, by the core's own decision.
            tokio::time::sleep(Duration::from_secs(12)).await;
            assert!(exit.try_recv().is_err(), "no early exit inside the remote grace");
            tokio::time::timeout(Duration::from_secs(20), &mut exit).await.expect("the core ends itself once the remote grace is over").unwrap();
            let last: serde_json::Value = serde_json::from_slice(&mixdog_fsio::read(&mixdog_fsio::Unlaned, root.join("last-exit.json")).unwrap()).unwrap();
            assert_no_clients_end(&last);
        },
    );
}
#[test]
#[ignore = "integration: composes the real core, which needs a bundled Postgres runtime (MIXDOG_PG_RUNTIME); no network; about 12 s of real time"]
fn an_ordinary_loopback_desktop_leaving_ends_the_core_on_the_local_grace() {
    crate::compose_test_support::in_child(
        module_path!(),
        "an_ordinary_loopback_desktop_leaving_ends_the_core_on_the_local_grace",
        tokio::runtime::Builder::new_multi_thread(),
        |dir| async move {
            let (serving, exit, root) = serving_core(&dir).await;
            let document: serde_json::Value =
                serde_json::from_slice(&mixdog_fsio::read(&mixdog_fsio::Unlaned, crate::discovery::path(&root)).unwrap()).unwrap();
            let token = document["endpoints"]["session"]["token"].as_str().unwrap().to_owned();
            let rpc = u16::try_from(document["core"]["rpc"]["port"].as_u64().unwrap()).unwrap();
            let socket = attach(rpc, &token).await;
            assert_eq!(serving.lifecycle.status().clients, 1);
            drop(socket);
            mixdog_rt::time::timeout(Duration::from_secs(20), exit).await.expect("the local grace is 10 s").unwrap();
            let last: serde_json::Value = serde_json::from_slice(&mixdog_fsio::read(&mixdog_fsio::Unlaned, root.join("last-exit.json")).unwrap()).unwrap();
            assert_no_clients_end(&last);
        },
    );
}
