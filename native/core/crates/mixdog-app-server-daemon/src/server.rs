//! The one server builder of the composed core, behind two transports: the daemon's real
//! listeners and the in-process pair of headless `mixdogd exec`. Both build [`Running`] through
//! [`Running::build`] and drive every accepted connection through [`drive`]; the only thing a
//! transport adds is where its connections come from.

use std::sync::Arc;
use std::sync::atomic::AtomicBool;
use std::sync::atomic::Ordering;

use bytes::Bytes;
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
use mixdog_app_server_client::api::Connector;
use mixdog_app_server_client::inprocess::FromClient;
use mixdog_app_server_client::inprocess::InProcessConnector;
use mixdog_app_server_client::inprocess::ServerEnd;
use mixdog_app_server_client::inprocess::ServerSender;
use mixdog_app_server_transport::AcceptedConnection;
use mixdog_app_server_transport::ConnectionHub;
use mixdog_app_server_transport::ConnectionOrigin;
use mixdog_app_server_transport::Incoming;
use mixdog_app_server_transport::SocketClosed;
use mixdog_app_server_transport::SocketRead;
use mixdog_app_server_transport::SocketWrite;
use mixdog_app_server_transport::Transport;
use mixdog_rt::TaskClass;
use tokio::sync::mpsc;

use crate::compat;
use crate::compose::ComposedCore;
use crate::lifecycle::new_instance_id;

/// The server and its connection table over one composed core.
#[derive(Clone)]
pub struct Running {
    pub server: AppServer,
    pub hub: ConnectionHub,
    pub outgoing: Arc<Outgoing>,
    core: Arc<ComposedCore>,
}

impl Running {
    /// `outgoing` is the router `core` was composed with as its host channel
    /// (`ComposeConfig::host`); the server registers its connections there.
    pub fn build(core: Arc<ComposedCore>, outgoing: Arc<Outgoing>) -> Result<Self, LimitsViolation> {
        let limits = Limits::default();
        let hub = ConnectionHub::new(limits.clone())?;
        let origins = hub.clone();
        let server = AppServer::new(
            core.clone(),
            outgoing.clone(),
            Arc::new(move |id| origins.origin_of(id)),
            server_config(limits),
        )?;
        Ok(Self { server, hub, outgoing, core })
    }

    /// Serves the connections `transport` accepts until it is closed, with the heartbeat running
    /// for them. The daemon's listeners come in through here.
    pub async fn serve_transport<T: Transport>(&self, mut transport: T) {
        let _heartbeat = self.hub.spawn_heartbeat();
        while let Some(accepted) = transport.accept().await {
            spawn_drive(self.server.clone(), accepted);
        }
    }
}

fn server_config(limits: Limits) -> ServerConfig {
    let version = env!("CARGO_PKG_VERSION");
    let server = compat::parse(version).expect("the workspace version is semver");
    ServerConfig {
        user_agent: format!("mixdogd/{version}"),
        platform_family: std::env::consts::FAMILY.to_owned(),
        platform_os: std::env::consts::OS.to_owned(),
        server_version: version.to_owned(),
        server_build: option_env!("MIXDOG_BUILD").unwrap_or("dev").to_owned(),
        server_instance_id: new_instance_id(),
        capabilities: ServerCapabilities {
            office: CapabilityState::Available,
            js_skills: CapabilityState::Available,
            browser: CapabilityState::Available,
            computer: CapabilityState::Available,
            voice: CapabilityState::Available,
        },
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

fn spawn_drive(server: AppServer, accepted: AcceptedConnection) {
    mixdog_rt::spawn("server.connection", TaskClass::Control, drive(server, accepted));
}

/// One connection's life: its requests go to the server in arrival order until it closes.
async fn drive(server: AppServer, accepted: AcceptedConnection) {
    let AcceptedConnection { id, mut inbound, sink, .. } = accepted;
    let handle = server.open(id, Arc::new(sink.clone()));
    while let Some(message) = inbound.recv().await {
        match handle.on_message(message) {
            Inbound::Continue => {}
            Inbound::Pause(resume) => resume.await,
            Inbound::Close(code) => {
                sink.close(code);
                break;
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

/// The ordered stop of the in-process server; the same procedure the daemon runs.
#[derive(Clone)]
pub struct Shutdown {
    hub: ConnectionHub,
    refusing: Arc<AtomicBool>,
    core: Arc<ComposedCore>,
}

impl Shutdown {
    /// Refuses new connections, closes the open ones with 1001, then runs
    /// [`ComposedCore::stop`]. Resolves once the core's stop steps are done.
    pub async fn run(&self) {
        self.refusing.store(true, Ordering::Release);
        self.hub.close_all();
        self.core.stop().await;
    }
}

/// Serves `core` to clients of this process: the connector opens in-process connections (scoped
/// as `Origin::Local`, see `ConnectionOrigin::InProcess`), and `Shutdown::run` stops the core.
pub fn serve_in_process(
    core: Arc<ComposedCore>,
    outgoing: Arc<Outgoing>,
) -> Result<(Arc<dyn Connector>, Shutdown), LimitsViolation> {
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

#[cfg(test)]
mod tests {
    use std::sync::Mutex;

    use mixdog_app_server_client::api::Target;
    use mixdog_app_server_client::api::TransportEvent;

    use super::*;
    use crate::compose::ComposeConfig;
    use crate::compose::compose;

    /// The core, composed over the router the server will use as its host channel.
    async fn core(dir: &std::path::Path) -> (Arc<ComposedCore>, Arc<Outgoing>) {
        let outgoing = Outgoing::new();
        let core = compose(
            &mixdog_rt::testing::tokens(),
            ComposeConfig {
                data_dir: dir.to_path_buf(),
                user_data_dir: dir.join("userdata"),
                js_runtime: crate::js_runtime::fixture(dir),
                ort_library: mixdog_services::effort_judge::model::OrtRuntime::NoBinding,
                host: outgoing.clone(),
            },
        )
        .await
        .unwrap();
        (Arc::new(core), outgoing)
    }

    async fn reply(halves: &mut mixdog_app_server_client::api::TransportHalves, id: u64) -> serde_json::Value {
        loop {
            let TransportEvent::Frame(text) = halves.reader.recv().await else { panic!("closed before reply {id}") };
            let frame: serde_json::Value = serde_json::from_str(&text).unwrap();
            if frame["id"] == id {
                return frame;
            }
        }
    }

    #[tokio::test]
    async fn a_client_initializes_and_starts_a_thread_over_the_pair() {
        let dir = tempfile::tempdir().unwrap();
        let (core, outgoing) = core(dir.path()).await;
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
    }

    #[tokio::test]
    async fn shutdown_stops_the_core_in_registration_order_and_refuses_new_clients() {
        let dir = tempfile::tempdir().unwrap();
        let (core, outgoing) = core(dir.path()).await;
        let order = Arc::new(Mutex::new(Vec::new()));
        for name in ["trace", "usage", "sessions"] {
            let order = order.clone();
            core.on_stop(name, async move { order.lock().unwrap().push(name) });
        }
        let (connector, shutdown) = serve_in_process(core, outgoing).unwrap();
        shutdown.run().await;
        assert_eq!(*order.lock().unwrap(), ["trace", "usage", "sessions"]);
        shutdown.run().await;
        assert_eq!(order.lock().unwrap().len(), 3, "a second stop runs nothing again");
        assert!(connector.open(&Target { id: "in-process".into() }).await.is_err());
    }
}
