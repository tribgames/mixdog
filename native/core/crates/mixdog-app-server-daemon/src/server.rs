//! The one server builder of the composed core, behind two transports: the daemon's real
//! listeners and the in-process pair of headless `mixdogd exec`. Both build [`Running`] through
//! [`Running::build`] and drive every accepted connection through [`drive`]; the only thing a
//! transport adds is where its connections come from.

use std::collections::VecDeque;
use std::sync::Arc;
use std::sync::atomic::AtomicBool;
use std::sync::atomic::Ordering;

use bytes::Bytes;
use mixdog_app_protocol::JsonRpcMessage;
use mixdog_app_protocol::limits::CloseCode;
use mixdog_app_protocol::limits::Limits;
use mixdog_app_protocol::limits::LimitsViolation;
use mixdog_app_protocol::v1::CapabilityState;
use mixdog_app_protocol::v1::ServerCapabilities;
use mixdog_app_server::AppServer;
use mixdog_app_server::Inbound;
use mixdog_app_server::Outgoing;
use mixdog_app_server::ServerConfig;
use mixdog_app_server::VersionOrder;
use mixdog_app_server::is_control;
use mixdog_app_server_client::api::Connector;
use mixdog_app_server_client::inprocess::FromClient;
use mixdog_app_server_client::inprocess::InProcessConnector;
use mixdog_app_server_client::inprocess::ServerEnd;
use mixdog_app_server_client::inprocess::ServerSender;
use mixdog_app_server_transport::AcceptedConnection;
use mixdog_app_server_transport::ConnectionHub;
use mixdog_app_server_transport::ConnectionOrigin;
use mixdog_app_server_transport::InboundFrames;
use mixdog_app_server_transport::Incoming;
use mixdog_app_server_transport::SocketClosed;
use mixdog_app_server_transport::SocketRead;
use mixdog_app_server_transport::SocketWrite;
use mixdog_app_server_transport::Transport;
use mixdog_core_api::call::WindowRole;
use mixdog_core_api::call::WindowScope;
use mixdog_rt::TaskClass;
use tokio::sync::mpsc;

use crate::compat;
use crate::compose::ComposedCore;
use crate::lifecycle::ReleaseBudgets;
use crate::lifecycle::new_instance_id;
use crate::lifecycle::supervise_async;

/// The server and its connection table over one composed core.
#[derive(Clone)]
pub struct Running {
    pub server: AppServer,
    pub hub: ConnectionHub,
    pub outgoing: Arc<Outgoing>,
}

/// `sink` that cannot panic into its caller: a failing log write never changes what a connection does.
fn contained(sink: Arc<dyn Fn(&str) + Send + Sync>) -> Arc<dyn Fn(&str) + Send + Sync> {
    Arc::new(move |line: &str| {
        let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| sink(line)));
    })
}

/// The window a connection's origin names, in the shape the core's calls carry.
fn window_scope_of(origin: &ConnectionOrigin) -> Option<WindowScope> {
    let id = origin.window_id()?;
    let role = match origin.window_role()? {
        mixdog_app_server_transport::WindowRole::Main => WindowRole::Main,
        mixdog_app_server_transport::WindowRole::Server { connection_id } => WindowRole::Server { connection_id: connection_id.clone() },
    };
    Some(WindowScope { id: Arc::from(id), role })
}

/// Installs the expander of `{"$blobRef"}` params for the process, over the blob store `blob/put` publishes to: the composition calls it
/// where it builds `BlobService`, before the server accepts a connection. One core serves a process; a second composition in the same
/// process (a test) keeps the first one's expander, as `param_refs::install` refuses a second.
pub(crate) fn install_param_refs(store: mixdog_store::blobs::BlobStore, tokens: &mixdog_rt::LaneTokens, limits: &Limits) {
    let _ = mixdog_app_server::param_refs::install(mixdog_core_domains::domains::blob::BlobParamRefs::new(store, tokens, limits));
}

/// Who the connection is, for its open and close lines: no token, only the origin and a window's own ids.
fn connection_kind(origin: &ConnectionOrigin) -> String {
    match origin {
        ConnectionOrigin::Loopback => "kind=loopback".to_owned(),
        ConnectionOrigin::SshTunnel => "kind=sshTunnel".to_owned(),
        ConnectionOrigin::Relay { .. } => "kind=relay".to_owned(),
        ConnectionOrigin::InProcess => "kind=inProcess".to_owned(),
        ConnectionOrigin::Window { window_id, tunnel, role } => {
            let role = match role {
                mixdog_app_server_transport::WindowRole::Main => "main".to_owned(),
                mixdog_app_server_transport::WindowRole::Server { connection_id } => format!("server:{connection_id}"),
            };
            format!("kind=window window={window_id} role={role}{}", if *tunnel { " tunnel=true" } else { "" })
        }
    }
}

/// Where a connection's decoded frames come from.
trait Frames {
    fn recv(&mut self) -> impl Future<Output = Option<JsonRpcMessage>> + Send;
}

impl Frames for InboundFrames {
    fn recv(&mut self) -> impl Future<Output = Option<JsonRpcMessage>> + Send {
        InboundFrames::recv(self)
    }
}

/// Data-plane frames kept while the reader is paused. Past it the reader stops reading until the
/// pause resolves (the transport's own queue then backpressures the peer).
const PAUSED_FRAMES: usize = 64;

/// Feeds frames to `on_message` in arrival order until the connection closes (`None`) or a
/// handler asks to close it (`Some(code)`).
///
/// A pause (`Inbound::Pause`, a domain's full input buffer) holds back data-plane frames only:
/// the reader keeps reading and hands control frames (`is_control`: C0 requests and answers to
/// server requests) to `on_message` at once, so a `turn/interrupt` or an approval never waits
/// behind a paused `process/input`. The held frames run, in order, when the pause resolves.
async fn pump(
    frames: &mut impl Frames,
    mut on_message: impl FnMut(JsonRpcMessage) -> Inbound,
    is_control: impl Fn(&JsonRpcMessage) -> bool,
) -> Option<CloseCode> {
    let mut held = VecDeque::new();
    loop {
        let message = match held.pop_front() {
            Some(message) => message,
            None => frames.recv().await?,
        };
        let mut resume = match on_message(message) {
            Inbound::Continue => continue,
            Inbound::Close(code) => return Some(code),
            Inbound::Pause(resume) => resume,
        };
        loop {
            let next = if held.len() < PAUSED_FRAMES {
                match futures::future::select(resume.as_mut(), std::pin::pin!(frames.recv())).await {
                    futures::future::Either::Left(((), _)) => break,
                    futures::future::Either::Right((next, _)) => next,
                }
            } else {
                resume.as_mut().await;
                break;
            };
            let message = next?;
            if !is_control(&message) {
                held.push_back(message);
            } else if let Inbound::Close(code) = on_message(message) {
                return Some(code);
            }
        }
    }
}

struct EndRead {
    from_client: mpsc::Receiver<FromClient>,
    closed: bool,
}

impl SocketRead for EndRead {
    async fn next(&mut self) -> Option<Incoming> {
        if self.closed {
            return None;
        }
        match self.from_client.recv().await? {
            FromClient::Frame(text) => Some(Incoming::Text(text)),
            FromClient::Closed { .. } => {
                self.closed = true;
                Some(Incoming::Close)
            }
        }
    }
}

struct EndWrite(ServerSender);

impl SocketWrite for EndWrite {
    async fn text(&mut self, frame: Bytes) -> Result<(), SocketClosed> {
        if self.0.send(String::from_utf8_lossy(&frame).into_owned()) { Ok(()) } else { Err(SocketClosed) }
    }

    /// A peer in the same process cannot be silently dead.
    async fn ping(&mut self) -> Result<(), SocketClosed> {
        Ok(())
    }

    async fn close(&mut self, code: CloseCode) -> Result<(), SocketClosed> {
        self.0.close(code.into(), "");
        Ok(())
    }
}

// The server's own minimal-params generator, over the same checked-in schema. Declared here, not inside `mod tests`, so the path
// resolves from src/ (a path inside an inline module goes through src/server/tests/, which does not exist).
#[cfg(test)]
#[path = "../../mixdog-app-server/src/tests/samples.rs"]
mod sample;

#[cfg(test)]
mod tests {
    use std::sync::Mutex;

    use mixdog_app_server_client::api::Target;
    use mixdog_app_server_client::api::TransportEvent;

    use super::*;
    use crate::compose::ComposeConfig;
    use crate::compose::compose;

    use super::sample;

    async fn reply(halves: &mut mixdog_app_server_client::api::TransportHalves, id: u64) -> serde_json::Value {
        loop {
            let TransportEvent::Frame(text) = halves.reader.recv().await else { panic!("closed before reply {id}") };
            let frame: serde_json::Value = serde_json::from_str(&text).unwrap();
            if frame["id"] == id {
                return frame;
            }
        }
    }

    /// A socket that never delivers a frame and takes every write: a peer that has gone silent.
    struct Silent;

    impl SocketRead for Silent {
        async fn next(&mut self) -> Option<Incoming> {
            std::future::pending().await
        }
    }

    impl SocketWrite for Silent {
        async fn text(&mut self, _: Bytes) -> Result<(), SocketClosed> {
            Ok(())
        }
        async fn ping(&mut self) -> Result<(), SocketClosed> {
            Ok(())
        }
        async fn close(&mut self, _: CloseCode) -> Result<(), SocketClosed> {
            Ok(())
        }
    }

    #[test]
    fn link_log_contained_sink_does_not_panic_into_its_caller() {
        let calls = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let seen = calls.clone();
        let sink = contained(Arc::new(move |_: &str| {
            seen.fetch_add(1, Ordering::SeqCst);
            panic!("the sink failed");
        }));
        sink("connection open id=1 kind=loopback");
        assert_eq!(calls.load(Ordering::SeqCst), 1, "the sink ran, and its panic stayed in it");
    }

    struct Source(mpsc::Receiver<JsonRpcMessage>);

    impl Frames for Source {
        async fn recv(&mut self) -> Option<JsonRpcMessage> {
            self.0.recv().await
        }
    }

    fn frame(method: &str) -> JsonRpcMessage {
        serde_json::from_value(serde_json::json!({ "method": method })).unwrap()
    }

    fn method_of(message: &JsonRpcMessage) -> String {
        match message {
            JsonRpcMessage::Notification(notification) => notification.method.clone(),
            other => panic!("unexpected {other:?}"),
        }
    }

    fn control(message: &JsonRpcMessage) -> bool {
        method_of(message).starts_with("ctl")
    }

    /// `data1` pauses the reader until `resume`. The paused clock only makes the failure a test
    /// failure instead of a hang: the timeout fires when nothing else can run.
    fn paused_pump(
        frames: mpsc::Receiver<JsonRpcMessage>,
        resume: tokio::sync::oneshot::Receiver<()>,
        seen: Arc<Mutex<Vec<String>>>,
        handled_control: tokio::sync::oneshot::Sender<()>,
    ) -> tokio::task::JoinHandle<Option<CloseCode>> {
        tokio::spawn(async move {
            let (mut resume, mut handled_control) = (Some(resume), Some(handled_control));
            pump(
                &mut Source(frames),
                move |message| {
                    let name = method_of(&message);
                    seen.lock().unwrap().push(name.clone());
                    match name.as_str() {
                        "data1" => {
                            let resume = resume.take().unwrap();
                            Inbound::Pause(Box::pin(async move {
                                let _ = resume.await;
                            }))
                        }
                        "ctl-close" => Inbound::Close(CloseCode::InvalidFrame),
                        "ctl" => {
                            if let Some(handled) = handled_control.take() {
                                let _ = handled.send(());
                            }
                            Inbound::Continue
                        }
                        _ => Inbound::Continue,
                    }
                },
                control,
            )
            .await
        })
    }

    /// The core, composed over the router the server will use as its host channel.
    async fn core(dir: &std::path::Path, data: &std::path::Path) -> (Arc<ComposedCore>, Arc<Outgoing>) {
        let outgoing = Outgoing::new();
        let core = compose(
            &mixdog_rt::testing::tokens(),
            ComposeConfig {
                rebuild: Default::default(),
                data_dir: data.to_path_buf(),
                user_data_dir: dir.join("userdata"),
                runtime_root: dir.join("runtime"),
                js_runtime: crate::js_runtime::fixture(dir),
                ort_library: mixdog_services::effort_judge::model::OrtRuntime::NoBinding,
                outgoing: outgoing.clone(),
                ownership: Arc::new(mixdog_core_api::domain::mock::MockOwnership::default()),
                log: crate::daemon_log::DaemonLog::new(
                    dir.join("daemon.log"),
                    mixdog_rt::testing::tokens().maintenance_io,
                    mixdog_rt::CancellationToken::new(),
                ),
                stop: mixdog_rt::CancellationToken::new(),
                catalog_http: crate::compose_test_support::offline_http(),
                pg_install: None,
            },
        )
        .await
        .unwrap();
        (Arc::new(core), outgoing)
    }
    #[test]
    #[ignore = "integration: composes the real core, which needs a bundled Postgres runtime (MIXDOG_PG_RUNTIME); no network"]
    fn a_client_initializes_and_starts_a_thread_over_the_pair() {
        crate::compose_test_support::in_child(
            module_path!(),
            "a_client_initializes_and_starts_a_thread_over_the_pair",
            {
                let mut runtime = tokio::runtime::Builder::new_multi_thread();
                runtime.worker_threads(2);
                runtime
            },
            |dir| async move {
                let data = crate::compose_test_support::data_in(&dir);
                crate::compose_test_support::seed_default_model(&data);
                let (core, outgoing) = core(&dir, &data).await;
                let (connector, shutdown) = serve_in_process(core, outgoing).unwrap();
                let mut halves = connector.open(&Target { id: "in-process".into() }).await.unwrap();
                let initialize = serde_json::json!({"jsonrpc":"2.0","id":0,"method":"initialize","params":{
                "clientInfo":{"name":"test","version":env!("CARGO_PKG_VERSION"),"kind":"cli"},"capabilities":{}}});
                halves.writer.send(initialize.to_string()).await.unwrap();
                let initialized = reply(&mut halves, 0).await;
                assert!(initialized.get("result").is_some(), "{initialized}");
                let start = serde_json::json!({"jsonrpc":"2.0","id":1,"method":"thread/start","params":{"opId":"op-1","kind":"task"}});
                halves.writer.send(start.to_string()).await.unwrap();
                let started = reply(&mut halves, 1).await;
                assert!(started.get("result").is_some(), "{started}");
                shutdown.run().await;
            },
        );
    }
    /// `compose` refuses to start while a domain method of the table is unclaimed, but the `thread` and `turn` namespaces are not claimed by
    /// domains: the server, the session directory and the session actor answer them, and nothing at startup checks that every row of the
    /// table reaches one of those handlers. Each row is sent over the wire to a loaded thread; a row no handler takes comes back as
    /// `methodNotFound`, as `capabilityUnavailable` "unclaimed", or as the session layer's `invalidParams` on `method` (its fallthrough arms).
    #[test]
    #[ignore = "integration: composes the real core, which needs a bundled Postgres runtime (MIXDOG_PG_RUNTIME); no network"]
    fn every_thread_and_turn_method_of_the_table_reaches_a_handler() {
        crate::compose_test_support::in_child(
            module_path!(),
            "every_thread_and_turn_method_of_the_table_reaches_a_handler",
            {
                let mut runtime = tokio::runtime::Builder::new_multi_thread();
                runtime.worker_threads(2);
                runtime
            },
            |dir| async move {
                let data = crate::compose_test_support::data_in(&dir);
                crate::compose_test_support::seed_default_model(&data);
                let (core, outgoing) = core(&dir, &data).await;
                let (connector, shutdown) = serve_in_process(core, outgoing).unwrap();
                let mut halves = connector.open(&Target { id: "in-process".into() }).await.unwrap();
                let initialize = serde_json::json!({"jsonrpc":"2.0","id":0,"method":"initialize","params":{
                "clientInfo":{"name":"test","version":env!("CARGO_PKG_VERSION"),"kind":"cli"},"capabilities":{}}});
                halves.writer.send(initialize.to_string()).await.unwrap();
                assert!(reply(&mut halves, 0).await.get("result").is_some());
                let start = serde_json::json!({"jsonrpc":"2.0","id":1,"method":"thread/start","params":{"opId":"op-1","kind":"task"}});
                halves.writer.send(start.to_string()).await.unwrap();
                let started = reply(&mut halves, 1).await;
                let thread = started["result"]["thread"]["id"].as_str().unwrap_or_else(|| panic!("{started}")).to_owned();

                // The thread's own delete goes last, so every other row meets a live thread.
                let methods = || {
                    mixdog_app_protocol::CLIENT_METHODS
                        .iter()
                        .filter(|spec| matches!(spec.method.split('/').next(), Some("thread" | "turn")) && spec.method != "thread/start")
                };
                let ordered = methods().filter(|spec| spec.method != "thread/delete").chain(methods().filter(|spec| spec.method == "thread/delete"));
                let samples = sample::Samples::new();
                let mut unserved = Vec::new();
                for (id, spec) in (2u64..).zip(ordered) {
                    // The schema's minimal valid params, so the server's decode passes and the request reaches the handler; the thread and op id are this
                    // test's. `threadId` is optional on some rows, and a request that names none is not addressed to a loaded thread.
                    let mut params = samples.params(spec.method);
                    params["threadId"] = serde_json::json!(thread);
                    if params.get("opId").is_some() {
                        params["opId"] = serde_json::json!(format!("op-{id}"));
                    }
                    let request = serde_json::json!({"jsonrpc":"2.0","id":id,"method":spec.method,"params":params});
                    halves.writer.send(request.to_string()).await.unwrap();
                    let answer = reply(&mut halves, id).await;
                    let data = &answer["error"]["data"];
                    let refused = answer["error"]["code"] == -32601
                        || (data["reason"] == "capabilityUnavailable" && data["detail"] == "unclaimed")
                        || (data["reason"] == "invalidParams" && data["path"] == "method");
                    if refused {
                        unserved.push(format!("{}: {answer}", spec.method));
                    }
                }
                shutdown.run().await;
                assert!(unserved.is_empty(), "table methods no handler serves: {unserved:#?}");
            },
        );
    }
    #[test]
    fn a_close_line_names_the_reason_the_connection_ended_with() {
        let lived = std::time::Duration::from_millis(1500);
        let line = |code| close_line(7, "kind=loopback", code, lived, 3);
        assert_eq!(line(None), "connection close id=7 kind=loopback reason=peerClosed code=none openMs=1500 subscriptionsDropped=3");
        for (code, reason, number) in [
            (CloseCode::SlowConsumer, "slowConsumer", 4000),
            (CloseCode::PeerUnresponsive, "pingDeadline", 4001),
            (CloseCode::GoingAway, "shutdown", 1001),
            (CloseCode::FrameTooBig, "protocolError", 1009),
            (CloseCode::InvalidFrame, "protocolError", 1007),
        ] {
            let said = line(Some(code));
            assert!(said.contains(&format!("reason={reason} code={number} ")), "{said}");
        }
        let window = ConnectionOrigin::Window {
            window_id: "w1".into(),
            tunnel: false,
            role: mixdog_app_server_transport::WindowRole::Server { connection_id: "c9".into() },
        };
        assert_eq!(connection_kind(&window), "kind=window window=w1 role=server:c9");
    }
    #[tokio::test]
    async fn a_close_line_of_a_silent_peer_says_ping_deadline() {
        let _tokens = mixdog_rt::testing::tokens();
        let hub = ConnectionHub::new(Limits::default()).unwrap();
        let mut accepted = hub.attach(ConnectionOrigin::Loopback, Silent, Silent).unwrap();
        // A ping after one silent tick, the deadline two ticks later, the socket abandoned one tick after that.
        for _ in 0..8 {
            hub.heartbeat_tick();
            for _ in 0..4 {
                tokio::task::yield_now().await;
            }
        }
        assert!(accepted.inbound.recv().await.is_none());
        let line = close_line(accepted.id.0, &connection_kind(&accepted.origin), accepted.sink.close_code(), std::time::Duration::ZERO, 0);
        assert!(line.contains("reason=pingDeadline code=4001"), "{line}");
    }
    #[tokio::test(start_paused = true)]
    async fn a_control_frame_is_handled_while_the_reader_is_paused() {
        let (frames, inbound) = mpsc::channel(8);
        let (resume, resumed) = tokio::sync::oneshot::channel();
        let (handled, handled_rx) = tokio::sync::oneshot::channel();
        let seen = Arc::new(Mutex::new(Vec::new()));
        let pumped = paused_pump(inbound, resumed, seen.clone(), handled);
        for name in ["data1", "data2", "ctl"] {
            frames.send(frame(name)).await.unwrap();
        }
        mixdog_rt::time::timeout(std::time::Duration::from_secs(60), handled_rx).await.expect("the control frame waited behind the paused reader").unwrap();
        assert_eq!(*seen.lock().unwrap(), ["data1", "ctl"], "the data frame is held, the control frame is not");
        resume.send(()).unwrap();
        drop(frames);
        assert_eq!(pumped.await.unwrap(), None);
        assert_eq!(*seen.lock().unwrap(), ["data1", "ctl", "data2"], "held frames run in order after the pause");
    }
    #[tokio::test(start_paused = true)]
    async fn a_close_from_a_control_frame_ends_a_paused_reader() {
        let (frames, inbound) = mpsc::channel(8);
        let (resume, resumed) = tokio::sync::oneshot::channel();
        let (handled, _handled_rx) = tokio::sync::oneshot::channel();
        let pumped = paused_pump(inbound, resumed, Arc::new(Mutex::new(Vec::new())), handled);
        for name in ["data1", "ctl-close"] {
            frames.send(frame(name)).await.unwrap();
        }
        let code = mixdog_rt::time::timeout(std::time::Duration::from_secs(60), pumped).await.expect("the close waited behind the paused reader").unwrap();
        assert_eq!(code, Some(CloseCode::InvalidFrame));
        drop(resume);
    }
    /// The wedged stop step blocks on a future nobody resolves and its budget is zero, so it is over
    /// budget the moment it starts; `run_with` still returns.
    #[test]
    #[ignore = "integration: composes the real core, which needs a bundled Postgres runtime (MIXDOG_PG_RUNTIME); no network"]
    fn a_wedged_stop_step_does_not_hold_the_headless_shutdown() {
        crate::compose_test_support::in_child(
            module_path!(),
            "a_wedged_stop_step_does_not_hold_the_headless_shutdown",
            tokio::runtime::Builder::new_multi_thread(),
            |dir| async move {
                let (core, outgoing) = core(&dir, &crate::compose_test_support::data_in(&dir)).await;
                core.on_stop("wedged", std::future::pending());
                let (_connector, shutdown) = serve_in_process(core, outgoing).unwrap();
                let budgets = ReleaseBudgets { close_data_handles: std::time::Duration::ZERO, ..ReleaseBudgets::default() };
                crate::compose_test_support::on_current_thread(async move { shutdown.run_with(budgets).await }).await;
            },
        );
    }
    #[test]
    #[ignore = "integration: composes the real core, which needs a bundled Postgres runtime (MIXDOG_PG_RUNTIME); no network"]
    fn shutdown_stops_the_core_in_registration_order_and_refuses_new_clients() {
        crate::compose_test_support::in_child(
            module_path!(),
            "shutdown_stops_the_core_in_registration_order_and_refuses_new_clients",
            tokio::runtime::Builder::new_multi_thread(),
            |dir| async move {
                let (core, outgoing) = core(&dir, &crate::compose_test_support::data_in(&dir)).await;
                let order = Arc::new(Mutex::new(Vec::new()));
                for name in ["trace", "usage", "sessions"] {
                    let order = order.clone();
                    core.on_stop(name, async move { order.lock().unwrap().push(name) });
                }
                let (connector, shutdown) = serve_in_process(core, outgoing).unwrap();
                // The CLI awaits the shutdown on its current-thread runtime.
                let shutdown = crate::compose_test_support::on_current_thread(async move {
                    shutdown.run().await;
                    shutdown
                })
                .await;
                assert_eq!(*order.lock().unwrap(), ["trace", "usage", "sessions"]);
                crate::compose_test_support::on_current_thread(async move { shutdown.run().await }).await;
                assert_eq!(order.lock().unwrap().len(), 3, "a second stop runs nothing again");
                assert!(connector.open(&Target { id: "in-process".into() }).await.is_err());
            },
        );
    }
}

impl Running {
    /// `outgoing` is the router `core` was composed with as its host channel
    /// (`ComposeConfig::host`); the server registers its connections there.
    pub fn build(core: Arc<ComposedCore>, outgoing: Arc<Outgoing>) -> Result<Self, LimitsViolation> {
        // The limits the core was composed with, not a second construction of them.
        let limits = core.limits().clone();
        let hub = ConnectionHub::new(limits.clone())?;
        let origins = hub.clone();
        let server = AppServer::new(
            core.clone(),
            outgoing.clone(),
            Arc::new(move |id| origins.origin_of(id)),
            ServerConfig { native_push: core.native_push_offered(), ..server_config(limits, core.defaults_separation()) },
        )?;
        // One contained sink for every connection line, served or not: recording never reaches the connection that is recorded.
        let sink = contained(core.log_line_sink());
        server.set_connection_log(sink.clone()).unwrap_or_else(|_| unreachable!("a server built a line above has no connection log yet"));
        // Sockets that never reach `drive` (refused, abandoned, handshake failed) leave their line through the same sink.
        hub.set_log(sink).unwrap_or_else(|_| unreachable!("a hub built a line above has no log yet"));
        let windows = hub.clone();
        server
            .set_window_of(Arc::new(move |id| windows.connection_origin(id).as_ref().and_then(window_scope_of)))
            .unwrap_or_else(|_| unreachable!("a server built a line above has no window source yet"));
        Ok(Self { server, hub, outgoing })
    }

    /// Serves the connections `transport` accepts until it is closed, with the heartbeat running
    /// for them. The daemon's listeners come in through here.
    pub async fn serve_transport<T: Transport>(&self, transport: T) {
        let _heartbeat = self.hub.spawn_heartbeat();
        self.accept_loop(transport).await;
    }

    /// The daemon's two listeners (the ordinary loopback one and the ssh one) over one hub: one heartbeat for both accept loops.
    pub async fn serve_transports<A: Transport, B: Transport>(&self, first: A, second: B) {
        let _heartbeat = self.hub.spawn_heartbeat();
        tokio::join!(self.accept_loop(first), self.accept_loop(second));
    }

    async fn accept_loop<T: Transport>(&self, mut transport: T) {
        while let Some(accepted) = transport.accept().await {
            spawn_drive(self.server.clone(), accepted);
        }
    }
}
pub(crate) fn server_config(limits: Limits, defaults_separation: mixdog_app_protocol::v1::DefaultsSeparation) -> ServerConfig {
    let version = env!("CARGO_PKG_VERSION");
    let server = compat::parse(version).expect("the workspace version is semver");
    ServerConfig {
        user_agent: format!("mixdogd/{version}"),
        platform_family: std::env::consts::FAMILY.to_owned(),
        platform_os: std::env::consts::OS.to_owned(),
        server_version: version.to_owned(),
        server_build: crate::server_ensure::running_build().to_owned(),
        server_instance_id: new_instance_id(),
        defaults_separation,
        capabilities: ServerCapabilities {
            office: CapabilityState::Available,
            js_skills: CapabilityState::Available,
            browser: CapabilityState::Available,
            computer: CapabilityState::Available,
            voice: CapabilityState::Available,
            // Each `initialize` answers it again with the relay's native push offer of that moment (`ServerConfig::native_push`).
            remote: mixdog_app_protocol::remote_flags::remote_capabilities(false),
            // The server holds a window-scoped connection to the window method table and echoes its id (`connection.window`).
            window_scope: 1,
        },
        native_push: Arc::new(|| false),
        limits,
        version_gate: Arc::new(move |client| match compat::parse(&client.version) {
            Ok(client) => match compat::order(&client, &server) {
                compat::Order::Equal => VersionOrder::Equal,
                compat::Order::ClientNewer => VersionOrder::ClientNewer,
                compat::Order::ClientOlder => VersionOrder::ClientOlder,
            },
            Err(_) => VersionOrder::ClientOlder,
        }),
    }
}
pub(crate) fn spawn_drive(server: AppServer, accepted: AcceptedConnection) {
    mixdog_rt::spawn("server.connection", TaskClass::Control, drive(server, accepted));
}
/// One connection's life: its requests go to the server in arrival order until it closes.
async fn drive(server: AppServer, accepted: AcceptedConnection) {
    let AcceptedConnection { id, origin, authenticated_relay_credential, mut inbound, sink } = accepted;
    let opened = std::time::Instant::now();
    let kind = connection_kind(&origin);
    server.log_connection(&format!("connection open id={} {kind}", id.0));
    let principal = authenticated_relay_credential.map(Arc::<str>::from);
    let handle = server.open_with_replay_principal(id, Arc::new(sink.clone()), principal);
    if let Some(code) = pump(&mut inbound, |message| handle.on_message(message), is_control).await {
        sink.close(code);
    }
    server.log_connection(&close_line(id.0, &kind, sink.close_code(), opened.elapsed(), handle.subscription_count()));
}
/// `code` is the one this side closed with (`ConnectionWriter::close_code`), `None` when the peer closed first or the socket failed.
fn close_line(id: u64, kind: &str, code: Option<CloseCode>, lived: std::time::Duration, subscriptions_dropped: usize) -> String {
    let reason = match code {
        None => "peerClosed",
        Some(CloseCode::Normal) => "normal",
        Some(CloseCode::GoingAway) => "shutdown",
        Some(CloseCode::SlowConsumer) => "slowConsumer",
        Some(CloseCode::PeerUnresponsive) => "pingDeadline",
        Some(CloseCode::VersionRefused) => "versionRefused",
        Some(CloseCode::UnsupportedData | CloseCode::InvalidFrame | CloseCode::PolicyViolation | CloseCode::FrameTooBig) => "protocolError",
    };
    let code = code.map_or_else(|| "none".to_owned(), |code| code.code().to_string());
    format!("connection close id={id} {kind} reason={reason} code={code} openMs={} subscriptionsDropped={subscriptions_dropped}", lived.as_millis())
}
/// The ordered stop of the in-process server; the same procedure the daemon runs.
#[derive(Clone)]
pub struct Shutdown {
    hub: ConnectionHub,
    refusing: Arc<AtomicBool>,
    core: Arc<ComposedCore>,
}
impl Shutdown {
    /// Refuses new connections, closes the open ones with 1001, then runs the stop of
    /// [`ComposedCore::stop`] as the daemon's release does: the extension host close and the
    /// registered stop steps, each under its release budget. Resolves once both are done or over
    /// budget (the step is then named in the log and abandoned).
    pub async fn run(&self) {
        self.run_with(ReleaseBudgets::default()).await;
    }

    async fn run_with(&self, budgets: ReleaseBudgets) {
        self.refusing.store(true, Ordering::Release);
        self.hub.close_all();
        // The in-process server has no daemon stop path in Node (`daemon.mjs` is the process); its reason is its own.
        self.core.set_stop_reason("in-process shutdown");
        let core = self.core.clone();
        supervise_async("closeExtHost", budgets.close_ext_host, async move { core.close_ext_host().await }).await;
        let core = self.core.clone();
        supervise_async("stopSteps", budgets.close_data_handles, async move { core.run_stop_steps().await }).await;
    }
}
/// Serves `core` to clients of this process: the connector opens in-process connections (scoped
/// as `Origin::Local`, see `ConnectionOrigin::InProcess`), and `Shutdown::run` stops the core.
pub fn serve_in_process(core: Arc<ComposedCore>, outgoing: Arc<Outgoing>) -> Result<(Arc<dyn Connector>, Shutdown), LimitsViolation> {
    let running = Running::build(core.clone(), outgoing)?;
    let refusing = Arc::new(AtomicBool::new(false));
    let accept = {
        let (running, refusing) = (running.clone(), refusing.clone());
        move |end: ServerEnd| -> Result<(), String> {
            if refusing.load(Ordering::Acquire) {
                return Err("the core is shutting down".to_owned());
            }
            let ServerEnd { from_client, sender } = end;
            let accepted = running
                .hub
                .attach(ConnectionOrigin::InProcess, EndRead { from_client, closed: false }, EndWrite(sender))
                .map_err(|_| "too many connections".to_owned())?;
            spawn_drive(running.server.clone(), accepted);
            Ok(())
        }
    };
    let connector: Arc<dyn Connector> = Arc::new(InProcessConnector::new(Arc::new(accept)));
    Ok((connector, Shutdown { hub: running.hub, refusing, core }))
}
