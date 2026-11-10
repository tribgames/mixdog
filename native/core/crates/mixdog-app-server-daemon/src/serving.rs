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
use crate::lifecycle::CancelRegistry;
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
        cancel: Arc::new(CancelRegistry::default()),
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
    // The composed core answers admission from its own state; follow the lifecycle's.
    let mut state = lifecycle.state();
    let followed = core.clone();
    mixdog_rt::spawn("server.core-state", TaskClass::Control, async move {
        while state.changed().await.is_ok() {
            let current = state.borrow_and_update().clone();
            followed.set_state(current);
        }
    });
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

    /// Readiness does not wait for the PostgreSQL runtime (Node installs it inside the memory start, at the first memory use, `supervisor.mjs:484`; its ready
    /// signal, `daemon.mjs:852`, comes first): a fresh profile whose install is held at a gate composes, publishes `serving` and answers a request while the
    /// install has not been entered, and nothing is downloaded or initialised.
    #[tokio::test(flavor = "multi_thread")]
    async fn a_fresh_profile_serves_while_the_runtime_install_is_held() {
        let dir = tempfile::tempdir().unwrap();
        let data = dir.path().join("data");
        std::fs::create_dir_all(&data).unwrap();
        let (entered, mut entries) = tokio::sync::mpsc::unbounded_channel::<()>();
        let tokens = mixdog_rt::testing::tokens();
        let outgoing = mixdog_app_server::Outgoing::new();
        let composing = crate::compose::compose(
            &tokens,
            ComposeConfig {
                data_dir: data.clone(),
                user_data_dir: dir.path().join("userdata"),
                js_runtime: crate::js_runtime::fixture(dir.path()),
                ort_library: mixdog_services::effort_judge::model::OrtRuntime::NoBinding,
                outgoing: outgoing.clone(),
                ownership: Arc::new(mixdog_core_api::domain::mock::MockOwnership::default()),
                log: crate::daemon_log::DaemonLog::new(data.join("daemon.log"), tokens.maintenance_io, mixdog_rt::CancellationToken::new()),
                stop: mixdog_rt::CancellationToken::new(),
                catalog_http: crate::compose_test_support::offline_http(),
                pg_install: Some(Arc::new(move |cancel| {
                    entered.send(()).expect("the test listens");
                    Box::pin(async move {
                        cancel.cancelled().await;
                        Err(mixdog_services::memory::error::MemoryError::Runtime("held at the gate".to_owned()))
                    })
                })),
            },
        );
        // The gate is never opened, so a composition that waited for the install would not end: the one deadline turns that into this failure.
        let core = Arc::new(tokio::time::timeout(std::time::Duration::from_secs(20), composing).await.expect("the composition waited for the held runtime install").unwrap());
        core.open_memory_in_background();
        let (exited, exit) = oneshot::channel();
        let root = dir.path().join("runtime");
        let serving = start(&tokens, core, outgoing, StartIn { runtime_root: root.clone(), exiter: Arc::new(RecordedExit(Mutex::new(Some(exited)))), update_text: "Update.".into() })
            .await
            .unwrap();
        serving.lifecycle.set_serving().unwrap();
        let writer = serving.discovery.clone();
        tokio::task::spawn_blocking(move || writer.flush()).await.unwrap();
        let document: serde_json::Value = serde_json::from_slice(&tokio::fs::read(discovery::path(&root)).await.unwrap()).unwrap();
        assert_eq!(document["core"]["state"], "serving");
        let token = document["endpoints"]["session"]["token"].as_str().unwrap().to_owned();
        let control = u16::try_from(document["core"]["control"]["port"].as_u64().unwrap()).unwrap();
        let answered = reqwest::Client::new().get(format!("http://127.0.0.1:{control}/mgmt/status")).bearer_auth(&token).send().await.unwrap();
        assert_eq!(answered.status(), 200);
        assert!(entries.try_recv().is_err(), "the install was not entered before the first memory use");
        assert!(!data.join("runtime").exists() && !data.join("pgdata").exists(), "nothing was downloaded or initialised");
        serving.lifecycle.stop(StopMode::WhenIdle, StopReason::Quit, None).unwrap();
        exit.await.unwrap();
    }

    /// `start` against a temp runtime root: discovery is written and names both listeners, the
    /// control and RPC listeners answer (and refuse a wrong token), and a stop takes the lifecycle
    /// through the release procedure: barriers once, `last-exit.json`, discovery withdrawn, `Stopped`.
    #[tokio::test(flavor = "multi_thread")]
    #[ignore = "integration: composes the real core, which needs a bundled Postgres runtime (MIXDOG_PG_RUNTIME); no network"]
    async fn start_serves_both_listeners_and_a_stop_releases_once() {
        let _one = crate::compose_test_support::exclusive().await;
        let dir = tempfile::tempdir().unwrap();
        let tokens = mixdog_rt::testing::tokens();
        let outgoing = mixdog_app_server::Outgoing::new();
        let core = Arc::new(
            crate::compose::compose(
                &tokens,
                ComposeConfig {
                    data_dir: crate::compose_test_support::data_dir().to_path_buf(),
                    user_data_dir: dir.path().join("userdata"),
                    js_runtime: crate::js_runtime::fixture(dir.path()),
                    ort_library: mixdog_services::effort_judge::model::OrtRuntime::NoBinding,
                    outgoing: outgoing.clone(),
            ownership: Arc::new(mixdog_core_api::domain::mock::MockOwnership::default()),
                    log: crate::daemon_log::DaemonLog::new(dir.path().join("daemon.log"), tokens.maintenance_io, mixdog_rt::CancellationToken::new()),
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
        let root = dir.path().join("runtime");
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
    }
}
