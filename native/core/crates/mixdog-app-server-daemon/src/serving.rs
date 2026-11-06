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
use mixdog_rt::LaneToken;
use mixdog_rt::LaneTokens;
use mixdog_rt::TaskClass;
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
use crate::lifecycle::new_instance_id;
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
    _control: ControlServer,
}

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
            Arc::new(move || runtime.block_on(core.run_stop_steps()))
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

/// Binds both listeners, builds the one `Lifecycle` and starts serving the control socket and the
/// RPC listener. The lifecycle is `booting`; the caller sets it `serving` when startup is done.
pub async fn start(
    tokens: &LaneTokens,
    core: Arc<ComposedCore>,
    outgoing: Arc<mixdog_app_server::Outgoing>,
    given: StartIn,
) -> Result<Serving, ServingError> {
    let StartIn { runtime_root, exiter, update_text } = given;
    let running = Running::build(core.clone(), outgoing).map_err(ServingError::Limits)?;
    let sections = Arc::new(SectionFeedState::new(core.app_feed_core().clone()));
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
    let rpc = WebSocketListener::bind(
        SocketAddr::from((Ipv4Addr::LOCALHOST, 0)),
        running.hub.clone(),
        BearerAuth::new(&token),
        ListenerOrigin::Loopback,
    )
    .await?;

    let pid = std::process::id();
    let start_ms = blocking(tokens, move || OsProcessTable.query(u64::from(pid)))
        .await
        .and_then(|queried| queried)
        .map_err(ServingError::StartTime)?
        .map_or(0, |info| info.identity.start_ms);
    let version = env!("CARGO_PKG_VERSION");
    let instance_id = new_instance_id();
    let base = discovery::Discovery {
        pid,
        endpoints: discovery::Endpoints {
            session: discovery::SessionEndpoint { port: control.port(), token: token.clone() },
            model_proxy: None,
        },
        core: discovery::CoreSection {
            version: version.to_owned(),
            build: option_env!("MIXDOG_BUILD").unwrap_or("dev").to_owned(),
            instance_id: instance_id.clone(),
            process_start_time: start_ms.to_string(),
            state: discovery::CoreState::Booting,
            blocked: None,
            drain: None,
            rpc: None,
            control: discovery::Port { port: control.port() },
        },
    };
    let publication = Arc::new(DiscoveryPublication::new(root.clone(), base));
    let discovery = publication.clone();
    publication.set_rpc_port(rpc.local_addr().port());
    let lifecycle = Lifecycle::new(
        LifecycleConfig { instance_id, version: version.to_owned(), runtime_root: root },
        Ports {
            core: Arc::new(RuntimeCore::new(core_wiring(&core, &running, &sections, &release))),
            discovery: publication,
            exiter,
        },
    );
    let control = ControlServer::serve(
        control,
        ControlConfig {
            token,
            legacy: Legacy { pid, version: version.to_owned(), update_text },
        },
        lifecycle.clone(),
    )
    .map_err(ServingError::Control)?;
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
    Ok(Serving { lifecycle, sections, release, discovery, _control: control })
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
        fn exit(&self) {
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

    /// `start` against a temp runtime root: discovery is written and names both listeners, the
    /// control and RPC listeners answer (and refuse a wrong token), and a stop takes the lifecycle
    /// through the release procedure: barriers once, `last-exit.json`, discovery withdrawn, `Stopped`.
    #[tokio::test(flavor = "multi_thread")]
    async fn start_serves_both_listeners_and_a_stop_releases_once() {
        let dir = tempfile::tempdir().unwrap();
        let tokens = mixdog_rt::testing::tokens();
        let outgoing = mixdog_app_server::Outgoing::new();
        let core = Arc::new(
            crate::compose::compose(
                &tokens,
                ComposeConfig {
                    data_dir: dir.path().join("data"),
                    user_data_dir: dir.path().join("userdata"),
                    js_runtime: crate::js_runtime::fixture(dir.path()),
                    ort_library: mixdog_services::effort_judge::model::OrtRuntime::NoBinding,
                    host: outgoing.clone(),
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