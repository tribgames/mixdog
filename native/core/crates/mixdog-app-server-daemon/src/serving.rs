//! The server composition of `serve`: the real listeners, the one `Lifecycle` over the composed
//! core, and the discovery document that names them (LR §3, §5.3, §6.1).
//!
//! Order matters and is the reason for the pieces: discovery must name the control port and the
//! RPC port before the lifecycle publishes, and the control server needs the lifecycle, so the
//! control socket is bound first and starts accepting after the lifecycle exists.

use std::net::Ipv4Addr;
use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::OnceLock;

use mixdog_app_server_transport::websocket::BearerAuth;
use mixdog_app_server_transport::websocket::ListenError;
use mixdog_app_server_transport::websocket::ListenerOrigin;
use mixdog_app_server_transport::websocket::WebSocketListener;
use mixdog_core_base::state::SectionFeedState;
use mixdog_rt::Backend;
use mixdog_rt::LaneToken;
use mixdog_rt::LaneTokens;
use mixdog_rt::TaskClass;
use mixdog_rt::exec::Executors;
use tokio_util::sync::CancellationToken;

use crate::compose::ComposedCore;
use crate::compose::drain_feed;
use crate::control::ControlConfig;
use crate::control::ControlServer;
use crate::control::Legacy;
use crate::lifecycle::Exiter;
use crate::control::new_token;
use crate::control::ControlListener;
use crate::discovery;
use crate::lifecycle::CoreWiring;
use crate::lifecycle::DiscoveryPublication;
use crate::lifecycle::Lifecycle;
use crate::lifecycle::LifecycleConfig;
use crate::lifecycle::Ports;
use crate::lifecycle::RuntimeCore;
use crate::lifecycle::StallConfig;
use crate::lifecycle::StallMonitor;
use crate::lifecycle::StallReporter;
use crate::lifecycle::new_instance_id;
use crate::lifecycle::tokio_post;
use crate::server::Running;
use crate::verdict::OsProcessTable;
use crate::verdict::ProcessTable;

#[derive(Debug, thiserror::Error)]
pub enum ServingError {
    #[error("the connection limits are invalid: {}", .0.0)]
    Limits(mixdog_app_protocol::limits::LimitsViolation),
    #[error("the runtime directory: {0}")]
    RuntimeRoot(#[source] std::io::Error),
    #[error("the control listener: {0}")]
    Control(#[source] std::io::Error),
    #[error("the RPC listener: {0}")]
    Rpc(#[from] ListenError),
    #[error("reading this process's start time: {0}")]
    StartTime(#[source] std::io::Error),
    #[error("the {0} was already bound")]
    Bound(&'static str),
    #[error("{0}")]
    Unbound(crate::compose::ComposeError),
}

/// The user's `release{pid}` decision on an undecidable prior owner. Only the startup exclusion
/// (the verdict gate) can leave the lifecycle `blocked`, so only it binds this; a decision that
/// arrives while it is unbound has no gate to reach and is logged.
#[derive(Default)]
pub struct ReleaseSlot(OnceLock<Arc<dyn Fn(u32) + Send + Sync>>);

impl ReleaseSlot {
    pub fn bind(&self, decision: Arc<dyn Fn(u32) + Send + Sync>) {
        if self.0.set(decision).is_err() {
            tracing::error!("the release decision was bound twice");
        }
    }

    fn decide(&self, pid: u32) {
        match self.0.get() {
            Some(decision) => decision(pid),
            None => tracing::error!(pid, "a release decision arrived with no verdict gate to take it"),
        }
    }
}

/// What `serve` keeps alive for the life of the process.
pub struct Serving {
    pub lifecycle: Arc<Lifecycle>,
    /// The app feed's section publisher, the one producer of the feed.
    pub sections: Arc<SectionFeedState>,
    pub release: Arc<ReleaseSlot>,
    /// The discovery writer: lush blocks until what was published is on disk.
    pub discovery: Arc<DiscoveryPublication>,
    core_port: Arc<LateCorePort>,
    runtime_root: PathBuf,
    _control: ControlServer,
}

impl Serving {
    /// Starts the stall monitor over `executors` (LR §5.4): it probes RT-W with a posted task and watches every pooled lane for workers stuck past their lease, and
    /// reports both to the core's `health` / `lane_health` and to `stall.jsonl` beside `daemon.json`. It reports and never acts; dropping it stops the watch.
    pub fn watch_stalls(&self, executors: Arc<Executors>) -> StallMonitor {
        let work = executors.handle(TaskClass::Work);
        let reporter = StallReporter::new(self.core_port.clone(), self.runtime_root.join(STALL_FILE)).watching_lanes(executors);
        StallMonitor::spawn(StallConfig::default(), tokio_post(work), self.lifecycle.clone(), reporter)
    }
}

/// The stall monitor's diagnostics file, in the runtime root.
const STALL_FILE: &str = "stall.jsonl";

/// A blocking call as a durability-lane job.
async fn blocking<T: Send + 'static>(tokens: &LaneTokens, f: impl FnOnce() -> T + Send + 'static) -> std::io::Result<T> {
    let job = tokens
        .durability_io
        .submit(&CancellationToken::new(), move |_lane| f())
        .map_err(|_| std::io::Error::other("the durability lane is full"))?;
    job.await.map_err(std::io::Error::other)
}

/// The lifecycle's wiring over the composed core and the server's connection table. The final
/// barriers and the stop steps are what the core registered (`ComposedCore::on_final_barrier`,
/// `on_stop`); both run on the release thread, which is not a runtime worker.
fn core_wiring(
    core: &Arc<ComposedCore>,
    running: &Running,
    sections: &Arc<SectionFeedState>,
    release: &Arc<ReleaseSlot>,
) -> CoreWiring {
    let runtime = tokio::runtime::Handle::current();
    CoreWiring {
        state: sections.clone(),
        connections: Arc::new(running.hub.clone()),
        ext_host: core.ext_host().clone(),
        runtime: runtime.clone(),
        // The tokens of the running work the sessions and the shells registered through the late cell.
        cancel: core.late_lifecycle().cancels().clone(),
        cut_new_tasks: {
            let core = core.clone();
            Arc::new(move || core.cut_new_tasks())
        },
        final_barriers: {
            let core = core.clone();
            Arc::new(move || core.run_final_barriers())
        },
        release_decision: {
            let release = release.clone();
            Arc::new(move |pid| release.decide(pid))
        },
        close_data_handles: {
            let core = core.clone();
            let runtime = runtime.clone();
            Arc::new(move || runtime.block_on(core.run_stop_steps()))
        },
        release_started: {
            let core = core.clone();
            Arc::new(move |reason| core.set_stop_reason(reason))
        },
        flush_log: {
            let core = core.clone();
            Arc::new(move || runtime.block_on(core.flush_log()))
        },
        drain_feed: drain_feed(sections.clone()),
    }
}

/// What start is given by its caller: where the runtime root is, how the process ends, and the
/// text a 1.4.5 client is shown. Production fills them from the real paths, the process exit and
/// the copy; a test fills them with a temp dir and a recording exit.
pub struct StartIn {
    /// The directory holding daemon.json and last-exit.json (discovery::runtime_root).
    pub runtime_root: PathBuf,
    pub exiter: Arc<dyn Exiter>,
    pub update_text: String,
}

/// The lifecycle's `CorePort` while the core is not yet composed (LR §3 steps 2 to 5 run before composition: the control listener must answer a blocked verdict
/// while nothing else exists). Nothing is running, open or queued yet, so every step has nothing to do until `attach` binds the core's port; the user's
/// `release{pid}` decision goes to the verdict gate, which is bound from the start.
struct LateCorePort {
    release: Arc<ReleaseSlot>,
    core: OnceLock<RuntimeCore>,
}

impl crate::lifecycle::CorePort for LateCorePort {
    fn drain_notice(&self, notice: &crate::lifecycle::DrainNotice) {
        if let Some(core) = self.core.get() {
            core.drain_notice(notice);
        }
    }

    fn serving(&self) {
        if let Some(core) = self.core.get() {
            core.serving();
        }
    }

    fn health(&self, stalled_ms: u64) {
        if let Some(core) = self.core.get() {
            core.health(stalled_ms);
        }
    }

    fn lane_health(&self, lane: &str, wedged: usize) {
        if let Some(core) = self.core.get() {
            core.lane_health(lane, wedged);
        }
    }

    fn cancel_running(&self, running: &[crate::lifecycle::Running]) {
        if let Some(core) = self.core.get() {
            core.cancel_running(running);
        }
    }

    fn cut_new_tasks(&self) {
        if let Some(core) = self.core.get() {
            core.cut_new_tasks();
        }
    }

    fn release_decision(&self, pid: u32) {
        self.release.decide(pid);
    }

    fn release_started(&self, reason: &str) {
        if let Some(core) = self.core.get() {
            core.release_started(reason);
        }
    }

    fn final_barriers(&self) {
        if let Some(core) = self.core.get() {
            core.final_barriers();
        }
    }

    fn close_connections(&self) {
        if let Some(core) = self.core.get() {
            core.close_connections();
        }
    }

    fn close_ext_host(&self) {
        if let Some(core) = self.core.get() {
            core.close_ext_host();
        }
    }

    fn close_data_handles(&self) {
        if let Some(core) = self.core.get() {
            core.close_data_handles();
        }
    }

    fn flush_log(&self) {
        if let Some(core) = self.core.get() {
            core.flush_log();
        }
    }
}

/// What `begin` has started: the control listener, serving, and the one `Lifecycle` in `booting`, with the discovery document naming the control endpoint only.
pub struct Booting {
    pub lifecycle: Arc<Lifecycle>,
    pub release: Arc<ReleaseSlot>,
    pub discovery: Arc<DiscoveryPublication>,
    core_port: Arc<LateCorePort>,
    runtime_root: PathBuf,
    token: String,
    control: ControlServer,
}

/// LR §3 step 2: binds the control listener, builds the one `Lifecycle` and starts serving the control socket. The lifecycle is `booting`; the verdict, the barrier and the
/// migration (`startup::start`) run next, and `attach` opens the RPC listener once the core is composed.
pub async fn begin(tokens: &LaneTokens, given: StartIn) -> Result<Booting, ServingError> {
    let StartIn { runtime_root, exiter, update_text } = given;
    let release = Arc::new(ReleaseSlot::default());

    let root = runtime_root;
    blocking(tokens, {
        let root = root.clone();
        move || discovery::ensure_private_root(&root)
    })
    .await
    .and_then(|made| made)
    .map_err(ServingError::RuntimeRoot)?;
    let token = new_token();
    let control = blocking(tokens, ControlListener::bind).await.and_then(|bound| bound).map_err(ServingError::Control)?;

    let pid = std::process::id();
    let start_ms = blocking(tokens, move || OsProcessTable.query(u64::from(pid)))
        .await
        .and_then(|queried| queried)
        .map_err(ServingError::StartTime)?
        .map_or(0, |info| info.identity.start_ms);
    let version = env!("CARGO_PKG_VERSION");
    let instance_id = new_instance_id();
    let build = option_env!("MIXDOG_BUILD").unwrap_or("dev");
    let base = discovery::Discovery {
        pid,
        endpoints: discovery::Endpoints {
            session: discovery::SessionEndpoint { port: control.port(), token: token.clone() },
            model_proxy: None,
        },
        core: discovery::CoreSection {
            version: version.to_owned(),
            build: build.to_owned(),
            instance_id: instance_id.clone(),
            process_start_time: start_ms.to_string(),
            state: discovery::CoreState::Booting,
            blocked: None,
            drain: None,
            rpc: None,
            control: discovery::Port { port: control.port() },
        },
    };
    // The publication is built before the lifecycle that owns it, so its failure path reaches the lifecycle through this cell.
    let leave: Arc<OnceLock<std::sync::Weak<Lifecycle>>> = Arc::new(OnceLock::new());
    let on_fatal = {
        let leave = leave.clone();
        Box::new(move |error: &std::io::Error| {
            tracing::error!(%error, "discovery cannot be published: leaving with the fatal boot code");
            if let Some(lifecycle) = leave.get().and_then(std::sync::Weak::upgrade) {
                lifecycle.fail_boot();
            }
        })
    };
    let publication = Arc::new(DiscoveryPublication::new(root.clone(), base, on_fatal));
    let discovery = publication.clone();
    let core_port = Arc::new(LateCorePort { release: release.clone(), core: OnceLock::new() });
    let lifecycle = Lifecycle::new(
        LifecycleConfig { instance_id: instance_id.clone(), version: version.to_owned(), runtime_root: root.clone() },
        Ports { core: core_port.clone(), discovery: publication, exiter },
    );
    leave.set(Arc::downgrade(&lifecycle)).unwrap_or_else(|_| unreachable!("the cell is set once, here"));
    let control = ControlServer::serve(
        control,
        ControlConfig {
            token: token.clone(),
            legacy: Legacy {
                pid,
                version: version.to_owned(),
                instance_id,
                build: build.to_owned(),
                update_text,
            },
        },
        lifecycle.clone(),
    )
    .map_err(ServingError::Control)?;
    Ok(Booting { lifecycle, release, discovery, core_port, runtime_root: root, token, control })
}

/// LR §3 step 6: the core is composed, so its lifecycle port is bound, the cells only the server can bind are bound and verified, and the RPC listener opens. The
/// discovery document names the RPC port from here on; the caller sets the lifecycle `serving`.
pub async fn attach(
    booting: Booting,
    core: Arc<ComposedCore>,
    outgoing: Arc<mixdog_app_server::Outgoing>,
) -> Result<Serving, ServingError> {
    let Booting { lifecycle, release, discovery, core_port, runtime_root, token, control } = booting;
    let running = Running::build(core.clone(), outgoing).map_err(ServingError::Limits)?;
    // The local dialer of a phone served by this core: the connection hub and the hand-off to the server's drive loop exist only now.
    {
        let server = running.server.clone();
        core.local_dialer()
            .bind(
                running.hub.clone(),
                Arc::new(move |accepted| crate::server::spawn_drive(server.clone(), accepted)),
                core.remote().registry.clone(),
            )
            .map_err(ServingError::Bound)?;
    }
    let sections = core.sections().clone();
    let rpc = WebSocketListener::bind(
        SocketAddr::from((Ipv4Addr::LOCALHOST, 0)),
        running.hub.clone(),
        BearerAuth::new(&token),
        ListenerOrigin::Loopback,
    )
    .await?;
    discovery.set_rpc_port(rpc.local_addr().port());
    core_port.core.set(RuntimeCore::new(core_wiring(&core, &running, &sections, &release))).map_err(|_| ServingError::Bound("runtime core"))?;
    // Bound before the listener accepts (the spawn of `server.rpc` below): a request admitted earlier would not be counted.
    core.late_lifecycle().bind(lifecycle.clone()).expect("serving::attach binds the lifecycle once");
    // Before the listener accepts: the cells only `serve` can bind are bound (`compose` verified every other one).
    let cells: [&dyn mixdog_core::run_host::late::Bound; 3] = [&**core.local_dialer(), core.connection_owners(), &**core.late_lifecycle()];
    crate::compose::verify_bound(&cells).map_err(ServingError::Unbound)?;
    mixdog_rt::spawn("server.rpc", TaskClass::Control, async move { running.serve_transport(rpc).await });
    // The composed core answers admission from its own state, and the sessions wait out the lifecycle's hold on turn starts (LR §5.1),
    // from the hold it has now (a `ctl hold` while booting) on: one follower keeps both at the lifecycle's.
    let followed = core.clone();
    mixdog_rt::spawn("server.core-state", TaskClass::Control, core.late_lifecycle().follow(&lifecycle, move |state| followed.set_state(state)));
    // The relay opens last (DS 7.2 "relay starts at core boot"): the listener, the lifecycle and the dialer are bound, so a phone that gets through at once finds a serving core.
    let runtime = core.remote().runtime.clone();
    core.on_stop("remote access", async move { runtime.close().await });
    crate::domain_seams::remote::start_remote(core.remote(), core.state_publisher().clone()).await;
    Ok(Serving { lifecycle, sections, release, discovery, core_port, runtime_root, _control: control })
}

/// `begin`, then `attach`: the whole of serving for a caller whose core is composed already (the tests).
pub async fn start(
    tokens: &LaneTokens,
    core: Arc<ComposedCore>,
    outgoing: Arc<mixdog_app_server::Outgoing>,
    given: StartIn,
) -> Result<Serving, ServingError> {
    attach(begin(tokens, given).await?, core, outgoing).await
}

#[cfg(test)]
#[allow(clippy::disallowed_methods, reason = "test fixture reads files and flushes the writer directly")]
mod tests {
    use std::sync::atomic::AtomicUsize;
    use std::sync::atomic::Ordering;
    use std::sync::Mutex;

    use mixdog_core_api::CoreState;
    use tokio::io::AsyncReadExt;
    use tokio::io::AsyncWriteExt;
    use tokio::net::TcpStream;
    use tokio::sync::oneshot;

    use super::*;
    use crate::compose::ComposeConfig;
    use crate::lifecycle::StopMode;
    use crate::lifecycle::StopReason;

    struct RecordedExit(Mutex<Option<oneshot::Sender<()>>>);

    impl Exiter for RecordedExit {
        fn exit(&self, _: i32) {
            if let Some(done) = self.0.lock().unwrap().take() {
                let _ = done.send(());
            }
        }
    }

    async fn upgrade(port: u16, authorization: Option<&str>) -> String {
        let mut stream = TcpStream::connect((Ipv4Addr::LOCALHOST, port)).await.unwrap();
        let auth = authorization.map(|token| format!("Authorization: Bearer {token}\r\n")).unwrap_or_default();
        let request = format!(
            "GET /rpc HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n{auth}\r\n"
        );
        stream.write_all(request.as_bytes()).await.unwrap();
        let mut buffer = [0u8; 256];
        let read = stream.read(&mut buffer).await.unwrap();
        String::from_utf8_lossy(&buffer[..read]).lines().next().unwrap_or_default().to_owned()
    }

    /// A desktop compares `/health` with the `daemon.json` it read: both must name the same run and build.
    #[tokio::test(flavor = "multi_thread")]
    async fn health_and_daemon_json_name_the_same_run_and_build() {
        let dir = tempfile::tempdir().unwrap();
        let tokens = mixdog_rt::testing::tokens();
        let (exited, _exit) = oneshot::channel();
        let root = dir.path().join("runtime");
        let booting = begin(
            &tokens,
            StartIn {
                runtime_root: root.clone(),
                exiter: Arc::new(RecordedExit(Mutex::new(Some(exited)))),
                update_text: "Update.".into(),
            },
        )
        .await
        .unwrap();
        booting.lifecycle.set_serving().unwrap();
        let writer = booting.discovery.clone();
        tokio::task::spawn_blocking(move || writer.flush()).await.unwrap();

        let document: serde_json::Value =
            serde_json::from_slice(&tokio::fs::read(discovery::path(&root)).await.unwrap()).unwrap();
        let control = document["core"]["control"]["port"].as_u64().unwrap();
        let health: serde_json::Value = reqwest::get(format!("http://127.0.0.1:{control}/health"))
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        assert_eq!(health["pid"], document["pid"]);
        assert_eq!(health["version"], document["core"]["version"]);
        assert_eq!(health["instanceId"], document["core"]["instanceId"]);
        assert_eq!(health["build"], document["core"]["build"]);
        assert!(!health["instanceId"].as_str().unwrap().is_empty());
        assert!(health.get("buildHash").is_none());
    }

    /// Node's recorded answers to the first memory requests while its opening cannot complete (`record-memory-first-request.mjs`).
    fn first_requests_scenario(name: &str) -> serde_json::Value {
        let golden: serde_json::Value = serde_json::from_str(include_str!("../../../fixtures/memory-first-request/golden.json")).unwrap();
        golden["scenarios"].as_array().unwrap().iter().find(|scenario| scenario["name"] == name).cloned().unwrap_or_else(|| panic!("no recorded scenario {name}"))
    }

    /// The core's method and params for a recorded Node action: Node's `session.configure` action is the core's method (`recall`'s `[query, options]` are
    /// `query` and `args`, `memoryControl`'s `[args]` is `args`).
    fn method_of(request: &serde_json::Value) -> (&'static str, serde_json::Value) {
        let args = request["args"].as_array().unwrap();
        match request["action"].as_str().unwrap() {
            "recall" => ("memory/recall", serde_json::json!({ "query": args[0], "args": args[1] })),
            "memoryControl" => ("memory/memoryControl", serde_json::json!({ "args": args[0] })),
            other => panic!("unrecorded action {other}"),
        }
    }

    /// What Node's client reads of an answer: the body (`{ error }` for a refused action). Its HTTP status belongs to Node's `/call`, which the core does not
    /// serve (it answers 426, `control/tests.rs`); the core's client gets a JSON-RPC frame over `/rpc` (see [`rpc_call`]).
    fn node_body(answer: &serde_json::Value) -> serde_json::Value {
        answer["body"].clone()
    }

    /// One recorded request through the dispatch a client's request takes (`domain_for`, then the wire error `error_data`), as the body Node's client reads.
    async fn replay(core: &crate::compose::ComposedCore, request: &serde_json::Value) -> serde_json::Value {
        use mixdog_core_api::handle::CoreHandle as _;
        use mixdog_core_api::ids::Method;
        use mixdog_core_api::{CallContext, CoreRequest};
        let (method, params) = method_of(request);
        let service = core.domain_for(method).expect("the method is served");
        match service.call(CoreRequest { method: Method(method), params, op: None, ctx: CallContext::internal("test") }).await {
            Err(error) => match mixdog_app_server::error_data(&error) {
                mixdog_app_protocol::ErrorData::DomainError { domain, message: Some(message), .. } if domain == "memory" => serde_json::json!({ "error": message }),
                other => serde_json::json!({ "unexpected error": format!("{other:?}") }),
            },
            Ok(mixdog_core_api::Reply::Value(value)) => serde_json::json!({ "unexpected value": value }),
            Ok(_) => serde_json::json!({ "unexpected": "a subscription" }),
        }
    }

    /// One request as a client of the core sends it: a WebSocket to the serving `/rpc` with the session token, `initialize`, then the request. Returns the
    /// upgrade's HTTP status and the request's response frame as received.
    async fn rpc_call(port: u16, token: &str, method: &str, params: serde_json::Value) -> (u16, serde_json::Value) {
        use futures::{SinkExt as _, StreamExt as _};
        use tokio_tungstenite::tungstenite::client::IntoClientRequest as _;
        use tokio_tungstenite::tungstenite::Message;
        let mut request = format!("ws://127.0.0.1:{port}/rpc").into_client_request().unwrap();
        request.headers_mut().insert("Authorization", format!("Bearer {token}").parse().unwrap());
        let stream = TcpStream::connect((Ipv4Addr::LOCALHOST, port)).await.unwrap();
        async fn answer<S>(socket: &mut S, id: u64) -> serde_json::Value
        where
            S: futures::Stream<Item = Result<Message, tokio_tungstenite::tungstenite::Error>> + Unpin,
        {
            loop {
                let frame = socket.next().await.expect("the connection stays open").unwrap();
                let Ok(text) = frame.to_text() else { continue };
                let Ok(value) = serde_json::from_str::<serde_json::Value>(text) else { continue };
                if value["id"] == id {
                    return value;
                }
            }
        }
        let (mut socket, upgrade) = tokio_tungstenite::client_async(request, stream).await.unwrap();
        let initialize = serde_json::json!({"jsonrpc":"2.0","id":0,"method":"initialize","params":{
            "clientInfo":{"name":"test","version":env!("CARGO_PKG_VERSION"),"kind":"cli"},"capabilities":{}}});
        socket.send(Message::text(initialize.to_string())).await.unwrap();
        assert!(answer(&mut socket, 0).await.get("result").is_some(), "initialized");
        socket.send(Message::text(serde_json::json!({"jsonrpc":"2.0","id":1,"method":method,"params":params}).to_string())).await.unwrap();
        let frame = answer(&mut socket, 1).await;
        let _ = socket.close(None).await;
        (upgrade.status().as_u16(), frame)
    }

    /// A fresh profile whose runtime install fails (its folder `<data>/runtime` is a regular file, so the real installer fails at its first step and nothing
    /// reaches a network): the first memory requests get Node's recorded answers for the same profile.
    #[tokio::test(flavor = "multi_thread")]
    async fn the_first_memory_requests_after_a_failed_install_answer_as_node() {
        use mixdog_core_session::session::testing::awaiting_for;
        const LIMIT: std::time::Duration = std::time::Duration::from_secs(20);
        let dir = tempfile::tempdir().unwrap();
        let data = dir.path().join("data");
        std::fs::create_dir_all(&data).unwrap();
        std::fs::write(data.join("runtime"), "not a folder").unwrap();
        let tokens = mixdog_rt::testing::tokens();
        let outgoing = mixdog_app_server::Outgoing::new();
        let composing = crate::compose::compose(
            &tokens,
            ComposeConfig {
                data_dir: data.clone(),
                user_data_dir: dir.path().join("userdata"),
                runtime_root: dir.path().join("runtime"),
                js_runtime: crate::js_runtime::fixture(dir.path()),
                ort_library: mixdog_services::effort_judge::model::OrtRuntime::NoBinding,
                outgoing: outgoing.clone(),
                ownership: Arc::new(mixdog_core_api::domain::mock::MockOwnership::default()),
                log: crate::daemon_log::DaemonLog::new(data.join("daemon.log"), tokens.maintenance_io, mixdog_rt::CancellationToken::new()),
                stop: mixdog_rt::CancellationToken::new(),
                catalog_http: crate::compose_test_support::offline_http(),
                pg_install: None,
            },
        );
        let core = Arc::new(awaiting_for(LIMIT, || "the composition".into(), composing).await.unwrap());
        let scenario = first_requests_scenario("recall then memoryControl when the runtime install fails");
        let requests = scenario["requests"].as_array().unwrap();
        let mut answers = Vec::new();
        for request in requests {
            answers.push(awaiting_for(LIMIT, || format!("the request {}", request["action"]), replay(&core, request)).await);
        }
        awaiting_for(LIMIT, || "the core's stop".into(), core.stop("test")).await;
        assert_eq!(answers, requests.iter().map(|request| node_body(&request["answer"])).collect::<Vec<_>>(), "the answers are Node's");
        assert!(!data.join("pgdata").exists(), "a failed install initialises nothing");
    }

    /// Readiness does not wait for the PostgreSQL runtime (Node installs it inside the memory start, at the first memory use, `supervisor.mjs:484`; its ready
    /// signal, `daemon.mjs:852`, comes first). A fresh profile whose install is held at a gate composes, publishes `serving` and answers `/mgmt/status` with the
    /// install not entered; the first database use then enters it and waits there while `/mgmt/status` still answers, and when the install ends the use gets its
    /// outcome (Node's first memory call waits on the one `initPromise` and fails with the install's error, `http-router.mjs:34-46`). Nothing is downloaded or
    /// initialised.
    #[tokio::test(flavor = "multi_thread")]
    async fn a_fresh_profile_serves_while_the_runtime_install_is_held() {
        use futures::FutureExt as _;
        use mixdog_core_session::session::testing::awaiting_for;
        const LIMIT: std::time::Duration = std::time::Duration::from_secs(20);
        let dir = tempfile::tempdir().unwrap();
        let data = dir.path().join("data");
        std::fs::create_dir_all(&data).unwrap();
        let (entered, mut entries) = tokio::sync::mpsc::unbounded_channel::<()>();
        let (release, gate) = oneshot::channel::<()>();
        let gate = Arc::new(tokio::sync::Mutex::new(Some(gate)));
        let tokens = mixdog_rt::testing::tokens();
        let outgoing = mixdog_app_server::Outgoing::new();
        let composing = crate::compose::compose(
            &tokens,
            ComposeConfig {
                data_dir: data.clone(),
                user_data_dir: dir.path().join("userdata"),
                runtime_root: dir.path().join("runtime"),
                js_runtime: crate::js_runtime::fixture(dir.path()),
                ort_library: mixdog_services::effort_judge::model::OrtRuntime::NoBinding,
                outgoing: outgoing.clone(),
                ownership: Arc::new(mixdog_core_api::domain::mock::MockOwnership::default()),
                log: crate::daemon_log::DaemonLog::new(data.join("daemon.log"), tokens.maintenance_io, mixdog_rt::CancellationToken::new()),
                stop: mixdog_rt::CancellationToken::new(),
                catalog_http: crate::compose_test_support::offline_http(),
                pg_install: Some(Arc::new(move |_cancel| {
                    entered.send(()).expect("the test listens");
                    let gate = gate.clone();
                    Box::pin(async move {
                        // The first install waits at the gate; a later one (the next request's new opening) fails as the first did.
                        let held = gate.lock().await.take();
                        if let Some(gate) = held {
                            let _ = gate.await;
                        }
                        Err(mixdog_services::memory::error::MemoryError::Runtime("held at the gate".to_owned()))
                    })
                })),
            },
        );
        // The gate is not open, so a composition that waited for the install would not end: the one deadline turns that into this failure.
        let core = Arc::new(awaiting_for(LIMIT, || "the composition, which must not wait for the held runtime install".into(), composing).await.unwrap());
        core.open_memory_in_background();
        let (exited, exit) = oneshot::channel();
        let root = dir.path().join("runtime");
        let serving = awaiting_for(
            LIMIT,
            || "the start of serving".into(),
            start(&tokens, core.clone(), outgoing, StartIn { runtime_root: root.clone(), exiter: Arc::new(RecordedExit(Mutex::new(Some(exited)))), update_text: "Update.".into() }),
        )
        .await
        .unwrap();
        let checks = std::panic::AssertUnwindSafe(async {
            serving.lifecycle.set_serving().unwrap();
            let writer = serving.discovery.clone();
            awaiting_for(LIMIT, || "the discovery flush".into(), tokio::task::spawn_blocking(move || writer.flush())).await.unwrap();
            let document: serde_json::Value = serde_json::from_slice(&tokio::fs::read(discovery::path(&root)).await.unwrap()).unwrap();
            assert_eq!(document["core"]["state"], "serving");
            let token = document["endpoints"]["session"]["token"].as_str().unwrap().to_owned();
            let control = u16::try_from(document["core"]["control"]["port"].as_u64().unwrap()).unwrap();
            let rpc = u16::try_from(document["core"]["rpc"]["port"].as_u64().unwrap()).unwrap();
            let status = || async {
                let request = reqwest::Client::new().get(format!("http://127.0.0.1:{control}/mgmt/status")).bearer_auth(&token).send();
                awaiting_for(LIMIT, || "the /mgmt/status answer".into(), request).await.unwrap().status()
            };
            assert_eq!(status().await, 200);
            assert!(entries.try_recv().is_err(), "the install was not entered before the first memory use");
            assert!(!data.join("runtime").exists() && !data.join("pgdata").exists(), "nothing was downloaded or initialised");

            // The first memory request enters the install and waits at the gate; the daemon keeps answering. Node's recording of the same requests while
            // its opening cannot complete is what the answers must equal.
            let scenario = first_requests_scenario("recall then memoryControl while the spawn lock is held by another live process");
            let requests = scenario["requests"].as_array().unwrap().clone();
            // The first request goes as a client sends it, over the serving `/rpc`.
            let (method, params) = method_of(&requests[0]);
            let rpc_token = token.clone();
            let mut params = params;
            params["opId"] = serde_json::json!("op-1");
            let using = tokio::spawn(async move { rpc_call(rpc, &rpc_token, method, params).await });
            awaiting_for(LIMIT, || "the first request to enter the install".into(), entries.recv()).await.expect("announced");
            assert!(!using.is_finished(), "the request waits for the install");
            assert_eq!(status().await, 200, "the daemon answers while the request waits");
            release.send(()).expect("the install waits at the gate");
            let (upgraded, frame) = awaiting_for(LIMIT, || "the first request to end with the install".into(), using).await.unwrap();
            println!("the client received: upgrade {upgraded}, frame {frame}");
            assert_eq!(upgraded, 101, "the client's connection is the WebSocket upgrade");
            assert_eq!(frame["id"], 1);
            assert!(frame.get("result").is_none(), "{frame}");
            let mut answers = vec![serde_json::json!({ "error": frame["error"]["data"]["message"] })];
            for request in &requests[1..] {
                answers.push(awaiting_for(LIMIT, || format!("the request {}", request["action"]), replay(&core, request)).await);
            }
            assert_eq!(answers, requests.iter().map(|request| node_body(&request["answer"])).collect::<Vec<_>>(), "the answers are Node's");
            // The database's own error is the install's outcome; the client sees the runtime proxy's text above.
            let db = core.memory_db();
            let outcome = awaiting_for(LIMIT, || "a database use".into(), db.client()).await.err().map(|error| error.message());
            assert_eq!(outcome.as_deref(), Some("postgres runtime: held at the gate"), "the use gets the install's outcome");
            assert!(!data.join("pgdata").exists(), "a failed install initialises nothing");
        })
        .catch_unwind()
        .await;
        // Every path ends the core: the stop and the exit wait run whether or not an assertion failed.
        serving.lifecycle.stop(StopMode::WhenIdle, StopReason::Quit, None).unwrap();
        awaiting_for(LIMIT, || "the core to exit after the stop".into(), exit).await.unwrap();
        if let Err(panic) = checks {
            std::panic::resume_unwind(panic);
        }
    }

    /// `start` against a temp runtime root: discovery is written and names both listeners, the
    /// control and RPC listeners answer (and refuse a wrong token), and a stop takes the lifecycle
    /// through the release procedure: barriers once, `last-exit.json`, discovery withdrawn, `Stopped`.
    #[test]
    #[ignore = "integration: composes the real core, which needs a bundled Postgres runtime (MIXDOG_PG_RUNTIME); no network"]
    fn start_serves_both_listeners_and_a_stop_releases_once() {
        crate::compose_test_support::in_child(module_path!(), "start_serves_both_listeners_and_a_stop_releases_once", tokio::runtime::Builder::new_multi_thread(), |dir| async move {
            let tokens = mixdog_rt::testing::tokens();
            let outgoing = mixdog_app_server::Outgoing::new();
            let core = Arc::new(
                crate::compose::compose(
                    &tokens,
                    ComposeConfig {
                        data_dir: crate::compose_test_support::data_in(&dir),
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
                .unwrap(),
            );
            let barriers = Arc::new(AtomicUsize::new(0));
            let counted = barriers.clone();
            core.on_final_barrier("count", Arc::new(move || {
                counted.fetch_add(1, Ordering::SeqCst);
            }));
            let (exited, exit) = oneshot::channel();
            let root = dir.join("runtime");
            let serving = start(
                &tokens,
                core,
                outgoing,
                StartIn {
                    runtime_root: root.clone(),
                    exiter: Arc::new(RecordedExit(Mutex::new(Some(exited)))),
                    update_text: "Update.".into(),
                },
            )
            .await
            .unwrap();
            serving.lifecycle.set_serving().unwrap();
            let writer = serving.discovery.clone();
            tokio::task::spawn_blocking(move || writer.flush()).await.unwrap();

            let document: serde_json::Value =
                serde_json::from_slice(&tokio::fs::read(discovery::path(&root)).await.unwrap()).unwrap();
            assert_eq!(document["core"]["state"], "serving");
            let token = document["endpoints"]["session"]["token"].as_str().unwrap().to_owned();
            let control = u16::try_from(document["core"]["control"]["port"].as_u64().unwrap()).unwrap();
            let rpc = u16::try_from(document["core"]["rpc"]["port"].as_u64().unwrap()).unwrap();

            let client = reqwest::Client::new();
            let status = format!("http://127.0.0.1:{control}/mgmt/status");
            let answered = client.get(&status).bearer_auth(&token).send().await.unwrap();
            assert_eq!(answered.status(), 200);
            assert_eq!(client.get(&status).bearer_auth("wrong").send().await.unwrap().status(), 401);
            assert!(upgrade(rpc, Some(&token)).await.contains("101"));
            assert!(upgrade(rpc, Some("wrong")).await.contains("401"));

            serving.lifecycle.stop(StopMode::WhenIdle, StopReason::Quit, None).unwrap();
            exit.await.unwrap();
            assert!(matches!(*serving.lifecycle.state().borrow(), CoreState::Stopped));
            assert_eq!(barriers.load(Ordering::SeqCst), 1);
            assert!(tokio::fs::try_exists(root.join("last-exit.json")).await.unwrap());
            assert!(!tokio::fs::try_exists(discovery::path(&root)).await.unwrap());
        });
    }
}
