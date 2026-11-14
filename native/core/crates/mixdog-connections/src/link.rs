//! The link of this PC's core to one server's core: the ssh session (bootstrap and tunnel), the protocol client over the
//! tunnel, the state machine behind what the server window shows, the model proxy that runs the server's model calls with
//! this PC's logins, the server's feed and the Ports panel. [`LinkPool`] holds the links by connection id.
//!
//! The client redials a dropped socket by itself through [`SessionResolver`], which re-reads the server after a drop; the link
//! follows its status. A version refusal ends a client for good: the link is then stopped and the pool replaces it by a new
//! one when the user connects again. A stopped ssh session (changed host key, refused login) is replaced in place.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::Duration;

use async_trait::async_trait;
use mixdog_app_protocol::v2::connections::{ConnectionNotice, ServerPort};
use mixdog_app_server_client::api::{
    CallOptions, ClientError, ClientEvent, ClientInfo, ConnectOptions, ConnectionStatus, Connector, InitializeCapabilities,
    ProtocolClient, Target,
};
use mixdog_app_server_client::discovery::Endpoint as WsEndpoint;
use mixdog_app_server_client::ws::{EndpointResolver, WsConnector};
use mixdog_protocol::ConnectionKind;
use mixdog_rt::TaskClass;
use mixdog_ssh::bootstrap::ServerPayloads;
use mixdog_ssh::command::{FailureClass, SshError, SshTarget};
use mixdog_ssh::connect_failure::{failure_of, ConnectError};
use mixdog_ssh::context::{AttemptContext, ModelLogin as SshModelLogin, Platform, SshEnv};
use mixdog_ssh::install_wire::{BootstrapCode, RemoteBootstrapError};
use mixdog_ssh::session::{Endpoint, Progress, RemoteSession, RemoteSessionConfig, SessionError};
use serde_json::json;
use tokio::sync::{broadcast, watch};
use tokio::task::{AbortHandle, JoinHandle};

use crate::host_store::SshHostStore;
use crate::link_machine::{
    host_grace_ms, remote_client_grace_ms, LinkActions, LinkFailure, LinkMachine, LinkOptions, LinkState, LinkViewState, ModelLogin,
};
use crate::model_proxy_relay::{AllowedProviders, CallOutcome, LocalModelProxy, ModelProxyRelay, ProxyCallSettled};
use crate::port_forward_store::PortForwardStore;
use crate::port_forwards::{ContextSource, PortsSource, ServerPortForwards};
use crate::restore::attempt_context;
use crate::server_feed::ServerFeed;

/// How long a server's tunnel may take to accept its first connection.
pub const TUNNEL_READY_TIMEOUT: Duration = Duration::from_millis(90_000);
/// The environment variable that sets how long a server keeps an idle daemon for a client that went away.
const GRACE_ENV: &str = "MIXDOG_REMOTE_CLIENT_GRACE_MS";
const PORTS_UPDATED: &str = "system/ports/updated";
const PORTS_SUBSCRIBE: &str = "system/ports/subscribe";
const PORTS_UNSUBSCRIBE: &str = "system/ports/unsubscribe";
const NOTICE_CAPACITY: usize = 16;
const ATTACH_CAPACITY: usize = 16;

fn locked<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

/// Which saved server a link is to. Everything else it needs (folder, automatic reconnection, grace, model login) is the
/// host's settings in the attempt context.
#[derive(Clone, Debug)]
pub struct LinkSpec {
    pub id: String,
    pub name: String,
    pub target: SshTarget,
}

/// What the links read and write besides the network.
pub struct LinkStores {
    pub hosts: Arc<SshHostStore>,
    pub port_forwards: Arc<PortForwardStore>,
    /// The server runtimes this desktop uploads when a server has none that matches it.
    pub payloads: Arc<dyn ServerPayloads + Send>,
}

/// What a link reaches the outside through: the ssh session, the socket to the server's core and the port forwards.
pub(crate) trait LinkDialer: Send + Sync {
    fn session(&self, config: RemoteSessionConfig, context: AttemptContext) -> Arc<RemoteSession>;
    fn connector(&self, resolver: Arc<dyn EndpointResolver>) -> Arc<dyn Connector>;
    fn forwards(&self, host_id: &str, context: ContextSource, store: Arc<PortForwardStore>) -> ServerPortForwards;
}

/// This PC's OpenSSH and a WebSocket to the tunnel's local end.
struct SshDialer {
    env: SshEnv,
    payloads: Arc<dyn ServerPayloads + Send>,
}

impl LinkDialer for SshDialer {
    fn session(&self, config: RemoteSessionConfig, context: AttemptContext) -> Arc<RemoteSession> {
        Arc::new(RemoteSession::over_ssh(config, self.env.clone(), context, self.payloads.clone()))
    }

    fn connector(&self, resolver: Arc<dyn EndpointResolver>) -> Arc<dyn Connector> {
        Arc::new(WsConnector::new(resolver))
    }

    fn forwards(&self, host_id: &str, context: ContextSource, store: Arc<PortForwardStore>) -> ServerPortForwards {
        ServerPortForwards::new(self.env.clone(), context, host_id, store)
    }
}

// ---------------------------------------------------------------------------------------------
// Failures
// ---------------------------------------------------------------------------------------------

/// The core refused this desktop's `initialize` for its version (the client's terminal `VersionRefused`): nothing a retry
/// changes, the session stops with the words the compatibility check gives.
pub fn version_refusal(error: &ClientError, display: &str) -> Option<ConnectError> {
    let ClientError::VersionRefused { reason, server_version, client_version } = error else { return None };
    let server = if server_version.is_empty() { "unknown" } else { server_version.as_str() };
    let client = if client_version.is_empty() { "unknown" } else { client_version.as_str() };
    let refusal = if reason == "clientOutdated" {
        RemoteBootstrapError::new(
            BootstrapCode::ClientOutdated,
            format!("This Mixdog ({client}) is older than the core on {display} ({server}). Update Mixdog on this PC."),
        )
    } else {
        RemoteBootstrapError::new(
            BootstrapCode::ProtocolMismatch,
            format!(
                "The Mixdog core on {display} ({server}) is incompatible with this desktop ({client}). \
                 Reconnect: Mixdog installs the version that matches this desktop on the server."
            ),
        )
    };
    Some(ConnectError::Bootstrap(refusal))
}

/// What a failed session or client open reports to the one who asked for the connection.
fn connect_error(error: SessionError) -> ConnectError {
    match error {
        SessionError::Connect(error) => error,
        SessionError::Cwd(message) => SshError::new(message, FailureClass::Terminal).into(),
        other => SshError::new(other.to_string(), FailureClass::Transient).into(),
    }
}

fn closed_error(name: &str) -> ConnectError {
    SshError::new(format!("The connection to {name} was closed."), FailureClass::Terminal).into()
}

/// What the server window shows of a failure that stopped the link: a refused host key or login can only be confirmed again
/// where servers are managed (Settings, Connection, in this PC's window).
fn describe_link_failure(error: &SessionError, target: &SshTarget, platform: Platform) -> LinkFailure {
    match error {
        SessionError::Connect(connect) => {
            let view = failure_of(connect, target, platform);
            LinkFailure { code: view.kind_name(), message: error.to_string(), settings_required: view.settings_required }
        }
        other => LinkFailure { code: "failed".to_owned(), message: other.to_string(), settings_required: false },
    }
}

/// This PC's model sign-in was refused (expired or revoked).
fn is_sign_in_failure(settled: &ProxyCallSettled) -> bool {
    settled.outcome == CallOutcome::Failed
        && settled.failure.as_ref().is_some_and(|failure| failure.reauth_required || failure.status == Some(401))
}

fn ssh_login(login: ModelLogin) -> Option<SshModelLogin> {
    (login == ModelLogin::Server).then_some(SshModelLogin::Server)
}

// ---------------------------------------------------------------------------------------------
// What the layers under the machine do
// ---------------------------------------------------------------------------------------------

/// The ssh half of a link: the current session (a stopped one is replaced, never mutated) and what it was opened with.
struct Bound {
    session: Arc<RemoteSession>,
    config: RemoteSessionConfig,
    /// The settings (identity file, ...) the connect attempt ran under; later reconnects run outside any attempt.
    context: AttemptContext,
}

struct Under {
    target: SshTarget,
    platform: Platform,
    dialer: Arc<dyn LinkDialer>,
    bound: Mutex<Bound>,
}

impl Under {
    fn session(&self) -> Arc<RemoteSession> {
        locked(&self.bound).session.clone()
    }

    fn model_login(&self) -> ModelLogin {
        if locked(&self.bound).config.model_login == Some(SshModelLogin::Server) { ModelLogin::Server } else { ModelLogin::Pc }
    }

    /// Opens the session again from scratch behind the same link; the stopped one is returned to be closed.
    fn replace_session(&self, context: Option<AttemptContext>, model_login: Option<ModelLogin>, force_restart: bool) -> Arc<RemoteSession> {
        let mut bound = locked(&self.bound);
        if let Some(login) = model_login {
            bound.config.model_login = ssh_login(login);
        }
        if let Some(context) = &context {
            if context.settings.is_some() {
                bound.context.settings.clone_from(&context.settings);
            }
        }
        let config = RemoteSessionConfig { progress: None, force_restart, ..bound.config.clone() };
        let session = self.dialer.session(config, context.unwrap_or_else(|| bound.context.clone()));
        std::mem::replace(&mut bound.session, session)
    }

    /// The user's own dial: bootstrap and tunnel now, so a failure reaches them; the client's next dial then finds the server
    /// attached.
    async fn dial_now(&self) -> Result<(), ConnectError> {
        self.session().connect().await.map(|_| ()).map_err(connect_error)
    }
}

#[async_trait]
impl LinkActions for Under {
    async fn probe(&self, timeout_ms: u64) -> Option<u64> {
        self.session().probe_health(Duration::from_millis(timeout_ms)).await
    }

    fn reset_tunnel(&self) {
        self.session().reset_tunnel();
    }

    fn revive_tunnel(&self) {
        self.session().revive_tunnel();
    }

    /// The client redials by itself on its own ladder; what is done here is the slow part, the ssh dial, so its next attempt
    /// finds the tunnel up.
    fn retry_service(&self) {
        let session = self.session();
        drop(mixdog_rt::spawn("link-retry-service", TaskClass::Control, async move {
            let _ = session.connect().await;
        }));
    }

    fn stopped_by(&self) -> Option<LinkFailure> {
        self.session().stopped_by().map(|error| describe_link_failure(&error, &self.target, self.platform))
    }

    fn hold(&self) {
        self.session().hold();
    }

    fn release(&self) {
        self.session().release();
    }
}

/// Every dial of the client goes through the current session, which re-reads the server (its core may be another one by
/// then); a cached attachment is used until the link says the connection dropped.
struct SessionResolver(Arc<Under>);

#[async_trait]
impl EndpointResolver for SessionResolver {
    async fn resolve(&self, _target: &Target) -> Result<WsEndpoint, String> {
        let session = self.0.session();
        let endpoint = match session.current_endpoint() {
            Some(endpoint) => endpoint,
            None => session.connect().await.map_err(|error| error.to_string())?,
        };
        let port = endpoint
            .url
            .rsplit_once(':')
            .and_then(|(_, rest)| rest.split('/').next())
            .and_then(|port| port.parse::<u16>().ok())
            .ok_or_else(|| format!("The tunnel endpoint {} has no port.", endpoint.url))?;
        Ok(WsEndpoint { port, token: endpoint.token })
    }
}

// ---------------------------------------------------------------------------------------------
// Following the client
// ---------------------------------------------------------------------------------------------

/// The list a `system/ports/updated` update carries; nothing for an update that is not a list.
fn listening_ports(params: Option<&serde_json::Value>) -> Option<Vec<ServerPort>> {
    let value = params?.get("value").filter(|value| value.is_array())?;
    serde_json::from_value(value.clone()).ok()
}

/// What the link does when its client's status changes or a ports list arrives.
struct Follower {
    id: String,
    display: String,
    under: Arc<Under>,
    machine: LinkMachine,
    client: Arc<dyn ProtocolClient>,
    forwards: ServerPortForwards,
    ports: watch::Sender<Vec<ServerPort>>,
    ports_viewed: Arc<AtomicBool>,
    attached: broadcast::Sender<String>,
}

impl Follower {
    /// The service is up (the first time, or again): the saved forwards run again and whoever follows the pool re-reads it.
    fn attached(&self) {
        self.machine.set_terminals_available(true);
        self.machine.service_restored();
        let forwards = self.forwards.clone();
        drop(mixdog_rt::spawn("link-forwards-restore", TaskClass::Control, async move { forwards.restore().await }));
        if self.ports_viewed.load(Ordering::SeqCst) {
            self.send_ports_view(PORTS_SUBSCRIBE);
        }
        // Nobody listening is no failure.
        let _ = self.attached.send(self.id.clone());
    }

    fn send_ports_view(&self, method: &'static str) {
        let client = self.client.clone();
        drop(mixdog_rt::spawn("link-ports-view", TaskClass::Control, async move {
            let _ = client.call_raw(method, json!({}), CallOptions::default()).await;
        }));
    }

    fn status(&self, status: ConnectionStatus) {
        match status {
            ConnectionStatus::Ready { .. } => {
                tracing::debug!("[link] {} core link restored", self.id);
                self.attached();
            }
            ConnectionStatus::Reconnecting { .. } => {
                // The next dial re-reads the server (the core may be another one by then, or gone) instead of reusing the cached
                // token and port.
                self.under.session().invalidate();
                tracing::debug!("[link] {} core link lost", self.id);
                self.machine.service_lost();
            }
            ConnectionStatus::Closed { reason } => {
                let Some(refusal) = version_refusal(&reason, &self.display) else { return };
                let error = SessionError::Connect(refusal);
                self.under.session().fail(error.clone());
                self.machine.terminal(describe_link_failure(&error, &self.under.target, self.under.platform));
            }
        }
    }

    fn ports_updated(&self, params: Option<&serde_json::Value>) {
        if let Some(list) = listening_ports(params) {
            self.ports.send_replace(list);
        }
    }

    async fn run(self, mut events: broadcast::Receiver<ClientEvent>) {
        loop {
            match events.recv().await {
                Ok(ClientEvent::Status(status)) => self.status(status),
                Ok(ClientEvent::Notification(note)) if note.method == PORTS_UPDATED => self.ports_updated(note.params.as_ref()),
                Ok(_) => {}
                // Events missed in a burst: the status is what the link needs.
                Err(broadcast::error::RecvError::Lagged(_)) => self.status(self.client.status()),
                Err(broadcast::error::RecvError::Closed) => return,
            }
        }
    }
}

// ---------------------------------------------------------------------------------------------
// The link
// ---------------------------------------------------------------------------------------------

/// This PC's core attached to one server's core.
pub struct ServerLink {
    id: String,
    name: String,
    /// The saved servers: what a changed setting is read from when the link restarts.
    hosts: Arc<SshHostStore>,
    under: Arc<Under>,
    client: Arc<dyn ProtocolClient>,
    machine: LinkMachine,
    feed: ServerFeed,
    relay: Arc<ModelProxyRelay>,
    forwards: ServerPortForwards,
    notices: broadcast::Sender<ConnectionNotice>,
    ports: watch::Sender<Vec<ServerPort>>,
    ports_viewed: Arc<AtomicBool>,
    tasks: Mutex<Vec<JoinHandle<()>>>,
    closed: AtomicBool,
}

/// What a pool hands a link it opens.
struct OpenParts {
    dialer: Arc<dyn LinkDialer>,
    local: Arc<dyn LocalModelProxy>,
    hosts: Arc<SshHostStore>,
    port_store: Arc<PortForwardStore>,
    platform: Platform,
    grace_env: Option<String>,
    attached: broadcast::Sender<String>,
}

fn client_info() -> ClientInfo {
    ClientInfo {
        name: "mixdog-desktop-core".to_owned(),
        title: None,
        version: env!("CARGO_PKG_VERSION").to_owned(),
        kind: ConnectionKind::Desktop,
        build: None,
    }
}

/// An approval of the server's reaches this PC's windows even before one views its session, and the server may run its models
/// through this PC (it only does while its model login is this PC's; the relay takes nothing up otherwise).
fn capabilities() -> InitializeCapabilities {
    InitializeCapabilities { approvals_inbox: Some(true), model_proxy: Some(true), ..InitializeCapabilities::default() }
}

impl ServerLink {
    async fn open(parts: &OpenParts, spec: LinkSpec, context: AttemptContext, progress: Option<Progress>) -> Result<Arc<Self>, ConnectError> {
        let settings = context.settings.clone().unwrap_or_default();
        let login = if settings.model_login == Some(SshModelLogin::Server) { ModelLogin::Server } else { ModelLogin::Pc };
        let own_grace = host_grace_ms(settings.grace_minutes.map(f64::from));
        let grace_ms = own_grace.unwrap_or_else(|| remote_client_grace_ms(parts.grace_env.as_deref()));
        let config = RemoteSessionConfig {
            model_login: ssh_login(login),
            grace_ms: own_grace,
            remote_cwd: settings.remote_cwd.clone(),
            tunnel_ready_timeout: Some(TUNNEL_READY_TIMEOUT),
            progress,
            force_restart: context.force_restart,
            ..RemoteSessionConfig::new(spec.target.clone())
        };
        let retained = AttemptContext { askpass: None, force_restart: false, ..context.clone() };
        let session = parts.dialer.session(config.clone(), context);
        let under = Arc::new(Under {
            target: spec.target.clone(),
            platform: parts.platform,
            dialer: parts.dialer.clone(),
            bound: Mutex::new(Bound { session: session.clone(), config, context: retained }),
        });
        // The dial the user waits for: its failure is the ssh failure itself, not what a client would make of it.
        if let Err(error) = under.dial_now().await {
            session.close().await;
            return Err(error);
        }
        let display = spec.target.display.trim().to_owned();
        let options = ConnectOptions {
            capabilities: capabilities(),
            ..ConnectOptions::new(
                Target { id: spec.id.clone() },
                parts.dialer.connector(Arc::new(SessionResolver(under.clone()))),
                client_info(),
            )
        };
        let client: Arc<dyn ProtocolClient> = match mixdog_app_server_client::connect(options).await {
            Ok(client) => Arc::new(client),
            Err(error) => {
                session.close().await;
                return Err(version_refusal(&error, &display).unwrap_or_else(|| {
                    SshError::new(format!("The Mixdog core on {display} did not accept this desktop: {error}"), FailureClass::Transient).into()
                }));
            }
        };
        Ok(Self::assemble(parts, spec, under, client, login, grace_ms, settings.auto_reconnect != Some(false)))
    }

    fn assemble(
        parts: &OpenParts,
        spec: LinkSpec,
        under: Arc<Under>,
        client: Arc<dyn ProtocolClient>,
        login: ModelLogin,
        grace_ms: u64,
        auto_reconnect: bool,
    ) -> Arc<Self> {
        let LinkSpec { id, name, target } = spec;
        let machine = LinkMachine::new(LinkOptions {
            connection_id: id.clone(),
            actions: under.clone(),
            grace_ms,
            auto_reconnect,
            model_login: login,
        });
        let context_source: ContextSource = {
            let under = under.clone();
            Arc::new(move || (under.target.clone(), Some(locked(&under.bound).context.clone())))
        };
        let forwards = parts.dialer.forwards(&id, context_source, parts.port_store.clone());
        let allowed: AllowedProviders = {
            let hosts = parts.hosts.clone();
            let id = id.clone();
            Arc::new(move || hosts.allowed_providers(&id))
        };
        let relay = ModelProxyRelay::new(client.clone(), parts.local.clone(), allowed);
        relay.serving(login == ModelLogin::Pc);
        let (notices, _) = broadcast::channel(NOTICE_CAPACITY);
        let (ports, _) = watch::channel(Vec::new());
        let ports_viewed = Arc::new(AtomicBool::new(false));
        let follower = Follower {
            id: id.clone(),
            display: target.display.trim().to_owned(),
            under: under.clone(),
            machine: machine.clone(),
            client: client.clone(),
            forwards: forwards.clone(),
            ports: ports.clone(),
            ports_viewed: ports_viewed.clone(),
            attached: parts.attached.clone(),
        };
        // Subscribed before the status is read, so no change after it is missed.
        let events = client.events();
        let mut tasks = vec![relay.serve()];
        let mut settled = relay.settled();
        let sign_in = notices.clone();
        tasks.push(mixdog_rt::spawn("link-sign-in", TaskClass::Control, async move {
            loop {
                match settled.recv().await {
                    Ok(call) if is_sign_in_failure(&call) => {
                        // The server's turn ran on this PC's sign-in: say which one failed.
                        let _ = sign_in.send(ConnectionNotice::ModelSignIn { provider: call.provider });
                    }
                    Ok(_) | Err(broadcast::error::RecvError::Lagged(_)) => {}
                    Err(broadcast::error::RecvError::Closed) => return,
                }
            }
        }));
        let status = client.status();
        machine.start();
        if matches!(status, ConnectionStatus::Ready { .. }) {
            follower.attached();
        } else {
            follower.status(status);
        }
        tasks.push(mixdog_rt::spawn("link-follow", TaskClass::Control, follower.run(events)));
        let feed = ServerFeed::attach(client.clone());
        let link = Arc::new(Self {
            id,
            name,
            hosts: parts.hosts.clone(),
            under,
            client,
            machine,
            feed,
            relay,
            forwards,
            notices,
            ports,
            ports_viewed,
            tasks: Mutex::new(tasks),
            closed: AtomicBool::new(false),
        });
        link.forwards.follow(&*link);
        link
    }

    pub fn id(&self) -> &str {
        &self.id
    }

    pub fn name(&self) -> &str {
        &self.name
    }

    /// The ssh destination.
    pub fn target(&self) -> &SshTarget {
        &self.under.target
    }

    /// The protocol client of this PC's core to the server's: every request for the server is a call on it.
    pub fn client(&self) -> Arc<dyn ProtocolClient> {
        self.client.clone()
    }

    /// The tunnel's endpoint of the server's core as the session last attached it; `None` until attached and after the connection
    /// dropped (the next dial re-reads the server).
    pub fn endpoint(&self) -> Option<Endpoint> {
        self.under.session().current_endpoint()
    }

    /// What the server window shows about this link, current at every read.
    pub fn view(&self) -> watch::Receiver<LinkViewState> {
        self.machine.view()
    }

    /// What the core tells the server window (the re-attach report writes its notices here too).
    pub fn notices(&self) -> &broadcast::Sender<ConnectionNotice> {
        &self.notices
    }

    /// Every model call of the server that ended on this PC: answered, failed or abandoned.
    pub fn model_calls(&self) -> broadcast::Receiver<ProxyCallSettled> {
        self.relay.settled()
    }

    pub fn feed(&self) -> &ServerFeed {
        &self.feed
    }

    pub fn ports(&self) -> &ServerPortForwards {
        &self.forwards
    }

    /// Whose provider logins the server's models run on now.
    pub fn model_login(&self) -> ModelLogin {
        self.under.model_login()
    }

    /// A terminal failure stopped the ssh side: only a reconnect brings it back.
    pub fn stopped(&self) -> bool {
        self.under.session().stopped_by().is_some()
    }

    /// The client ended for good (a refused version): only a new link can attach.
    fn client_ended(&self) -> bool {
        matches!(self.client.status(), ConnectionStatus::Closed { .. })
    }

    /// A window views (or stops viewing) the server's listening ports: the server samples them only meanwhile.
    pub async fn view_ports(&self, viewed: bool) -> Result<(), ClientError> {
        self.ports_viewed.store(viewed, Ordering::SeqCst);
        if !matches!(self.client.status(), ConnectionStatus::Ready { .. }) {
            // Subscribed on the next attach.
            return Ok(());
        }
        let method = if viewed { PORTS_SUBSCRIBE } else { PORTS_UNSUBSCRIBE };
        self.client.call_raw(method, json!({}), CallOptions::default()).await.map(|_| ())
    }

    /// The user's own dial (inside their context, so a failure reaches them). A client that is still attached after it has no
    /// drop to report, so the link is restored here; otherwise the client's own redial reports it.
    async fn redial(&self) -> Result<(), ConnectError> {
        self.under.dial_now().await?;
        if matches!(self.client.status(), ConnectionStatus::Ready { .. }) {
            self.machine.service_restored();
        }
        Ok(())
    }

    /// The saved model login changed while attached: the server's daemon restarts in that mode (its running turns stop, the user
    /// confirmed it) and the client attaches to it again. Proxy work of the old mode ends here: none of it reads or answers
    /// anything of this PC's after the switch. The restart dials under the server's settings as saved now (a key file or folder
    /// changed together with the login applies to it), in batch mode like any automatic reconnect.
    pub async fn apply_model_login(&self, login: ModelLogin) -> Result<(), ConnectError> {
        if self.closed.load(Ordering::SeqCst) || self.model_login() == login {
            return Ok(());
        }
        self.relay.revoke();
        self.relay.serving(login == ModelLogin::Pc);
        self.machine.set_model_login(login);
        let context = self.hosts.get(&self.id).map(|record| {
            let mut context = attempt_context(&record);
            // A server whose settings were all cleared replaces the earlier ones with none.
            context.settings.get_or_insert_with(Default::default);
            context
        });
        let stopped = self.under.replace_session(context, Some(login), true);
        stopped.close().await;
        self.machine.reopening();
        self.redial().await
    }

    /// The user connects again. A stopped link opens its ssh session anew (inside the caller's context, so the attempt may
    /// prompt); one that is only down is retried at once; a live one is left alone.
    pub async fn reconnect(&self, context: AttemptContext) -> Result<(), ConnectError> {
        if self.closed.load(Ordering::SeqCst) {
            return Ok(());
        }
        if !self.stopped() {
            // Only an outage needs the user's retry (a live link, or a sleeping PC, is left alone).
            let state = self.machine.view().borrow().state.clone();
            if !matches!(state, LinkState::Reconnecting { .. } | LinkState::Lost { .. }) {
                return Ok(());
            }
            self.machine.retry();
            return self.redial().await;
        }
        let force_restart = context.force_restart;
        let stopped = self.under.replace_session(Some(context), None, force_restart);
        stopped.close().await;
        self.machine.reopening();
        self.redial().await
    }

    /// The user skips the countdown of a waiting reconnect: its attempt runs now. Nothing happens when none is waiting.
    pub fn retry_now(&self) {
        self.machine.retry_now();
    }

    /// This PC goes to sleep: not a failure, nothing is attempted.
    pub fn suspend(&self) {
        self.machine.suspend();
    }

    /// This PC woke up: the link is probed before anything is touched.
    pub async fn resume(&self) {
        self.machine.resume().await;
    }

    /// Detach: the client and tunnel and the forwards close; the server's daemon keeps running. Idempotent.
    pub async fn close(&self) {
        if self.closed.swap(true, Ordering::SeqCst) {
            return;
        }
        for task in locked(&self.tasks).drain(..) {
            task.abort();
        }
        self.machine.dispose();
        self.relay.abandon_all();
        self.forwards.close_all().await;
        self.client.close().await;
        self.under.session().close().await;
    }
}

impl PortsSource for ServerLink {
    fn ports(&self) -> watch::Receiver<Vec<ServerPort>> {
        self.ports.subscribe()
    }
}

#[async_trait]
impl LinkActions for ServerLink {
    async fn probe(&self, timeout_ms: u64) -> Option<u64> {
        self.under.probe(timeout_ms).await
    }

    fn reset_tunnel(&self) {
        self.under.reset_tunnel();
    }

    fn revive_tunnel(&self) {
        self.under.revive_tunnel();
    }

    fn retry_service(&self) {
        self.under.retry_service();
    }

    fn stopped_by(&self) -> Option<LinkFailure> {
        self.under.stopped_by()
    }

    fn hold(&self) {
        self.under.hold();
    }

    fn release(&self) {
        self.under.release();
    }
}

// ---------------------------------------------------------------------------------------------
// The pool
// ---------------------------------------------------------------------------------------------

/// This PC going to sleep or waking up.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LinkPower {
    Suspend,
    Resume,
}

type Opened = Option<Result<Arc<ServerLink>, ConnectError>>;

/// An attempt to attach, shared by everyone who asks for the same connection while it runs.
struct Flight {
    token: u64,
    result: watch::Receiver<Opened>,
    task: AbortHandle,
}

#[derive(Default)]
struct PoolState {
    /// In the order they attached.
    links: Vec<Arc<ServerLink>>,
    opening: HashMap<String, Flight>,
    next_token: u64,
}

struct PoolInner {
    parts: OpenParts,
    state: Mutex<PoolState>,
}

/// The attached server links, keyed by connection id.
#[derive(Clone)]
pub struct LinkPool {
    inner: Arc<PoolInner>,
}

impl LinkPool {
    pub fn new(env: SshEnv, stores: LinkStores, local_proxy: Arc<dyn LocalModelProxy>) -> Self {
        let dialer = Arc::new(SshDialer { env: env.clone(), payloads: stores.payloads });
        Self::with_dialer(dialer, env.platform, env.env.get(GRACE_ENV).cloned(), stores.hosts, stores.port_forwards, local_proxy)
    }

    pub(crate) fn with_dialer(
        dialer: Arc<dyn LinkDialer>,
        platform: Platform,
        grace_env: Option<String>,
        hosts: Arc<SshHostStore>,
        port_store: Arc<PortForwardStore>,
        local: Arc<dyn LocalModelProxy>,
    ) -> Self {
        let (attached, _) = broadcast::channel(ATTACH_CAPACITY);
        let parts = OpenParts { dialer, local, hosts, port_store, platform, grace_env, attached };
        Self { inner: Arc::new(PoolInner { parts, state: Mutex::new(PoolState::default()) }) }
    }

    /// The connection ids whose link attached (the first time or again): the sections of a server window follow them.
    pub fn on_attach(&self) -> broadcast::Receiver<String> {
        self.inner.parts.attached.subscribe()
    }

    pub fn get(&self, id: &str) -> Option<Arc<ServerLink>> {
        locked(&self.inner.state).links.iter().find(|link| link.id == id).cloned()
    }

    pub fn list(&self) -> Vec<Arc<ServerLink>> {
        locked(&self.inner.state).links.clone()
    }

    /// Connects (bootstrap, tunnel, attach) when needed. One attempt runs per id, shared by everyone who asks while it runs; a
    /// link that is attached is returned as it is, and a stopped one is opened again behind the same id inside this caller's
    /// context.
    pub async fn open(&self, spec: LinkSpec, context: AttemptContext, progress: Option<Progress>) -> Result<Arc<ServerLink>, ConnectError> {
        if let Some(link) = self.get(&spec.id) {
            if !link.stopped() {
                return Ok(link);
            }
            if !link.client_ended() {
                link.reconnect(context).await?;
                return Ok(link);
            }
            // The client of a link that was refused for its version cannot attach again: a new link takes its place.
            self.remove(&spec.id).await;
        }
        let name = spec.name.clone();
        let mut result = {
            let mut state = locked(&self.inner.state);
            let joined = state.opening.get(&spec.id).map(|flight| flight.result.clone());
            match joined {
                Some(result) => result,
                None => {
                    state.next_token += 1;
                    let token = state.next_token;
                    let (tx, rx) = watch::channel(None);
                    let id = spec.id.clone();
                    let pool = self.clone();
                    // The attempt is registered before it can finish (it takes this lock to settle).
                    let task = mixdog_rt::spawn("link-open", TaskClass::Control, async move {
                        let opened = pool.attach(spec, context, progress, token).await;
                        tx.send_replace(Some(opened));
                    });
                    state.opening.insert(id, Flight { token, result: rx.clone(), task: task.abort_handle() });
                    rx
                }
            }
        };
        // A cancelled attempt (a close) drops its sender without an answer.
        match result.wait_for(Option::is_some).await {
            Ok(opened) => opened.clone().unwrap_or_else(|| Err(closed_error(&name))),
            Err(_) => Err(closed_error(&name)),
        }
    }

    /// The attempt itself: a link that attached after its connection was closed meanwhile is closed again.
    async fn attach(&self, spec: LinkSpec, context: AttemptContext, progress: Option<Progress>, token: u64) -> Result<Arc<ServerLink>, ConnectError> {
        let name = spec.name.clone();
        let id = spec.id.clone();
        let opened = ServerLink::open(&self.inner.parts, spec, context, progress).await;
        let current = {
            let mut state = locked(&self.inner.state);
            let current = state.opening.get(&id).is_some_and(|flight| flight.token == token);
            if current {
                state.opening.remove(&id);
                if let Ok(link) = &opened {
                    state.links.push(link.clone());
                }
            }
            current
        };
        match opened {
            Ok(link) if !current => {
                link.close().await;
                Err(closed_error(&name))
            }
            other => other,
        }
    }

    async fn remove(&self, id: &str) -> Option<Arc<ServerLink>> {
        let (link, flight) = {
            let mut state = locked(&self.inner.state);
            let at = state.links.iter().position(|link| link.id == id);
            (at.map(|at| state.links.remove(at)), state.opening.remove(id))
        };
        if let Some(flight) = flight {
            flight.task.abort();
        }
        if let Some(link) = &link {
            link.close().await;
        }
        link
    }

    /// Detaches: the tunnel and forwards close, the server's daemon keeps running; an attempt in flight is cancelled.
    pub async fn close(&self, id: &str) {
        self.remove(id).await;
    }

    pub async fn close_all(&self) {
        let ids: Vec<String> = {
            let state = locked(&self.inner.state);
            state.links.iter().map(|link| link.id.clone()).chain(state.opening.keys().cloned()).collect()
        };
        for id in ids {
            self.remove(&id).await;
        }
    }

    /// This PC goes to sleep or wakes up: every link pauses, or is probed before anything is touched.
    pub async fn power(&self, event: LinkPower) {
        let links = self.list();
        match event {
            LinkPower::Suspend => links.iter().for_each(|link| link.suspend()),
            LinkPower::Resume => {
                let wakes: Vec<JoinHandle<()>> = links
                    .into_iter()
                    .map(|link| mixdog_rt::spawn("link-resume", TaskClass::Control, async move { link.resume().await }))
                    .collect();
                for wake in wakes {
                    let _ = wake.await;
                }
            }
        }
    }
}

#[cfg(test)]
#[path = "link_tests.rs"]
mod tests;
