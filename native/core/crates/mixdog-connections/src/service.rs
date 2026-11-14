//! The connections service: every `connections/*` and `remoteHosts/*` method of the protocol, and the client notification
//! `host/window/closed`. It decodes the params at the boundary, applies the caller policy ([`crate::policy`]), calls the module
//! that does the work and encodes the answer; it holds what only the service knows: who subscribed to the connections feed (the
//! server windows that view a server's ports, the main window that is asked to sign in), which link each watcher follows, and
//! the time the host has been away.
//!
//! - A window the user closes detaches its link and is forgotten for the reopening at the next launch; one that closes because
//!   the app quits detaches too and stays remembered.
//! - When the host (the desktop) has been absent for [`HOST_ABSENT_GRACE_MS`], every link closes; the windows remembered are
//!   reopened when it comes back.
//! - Per link, while it is attached: the re-attach report, the notifier of the server's sessions, and the link's notices to the
//!   server window that views it.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, MutexGuard, PoisonError, Weak};
use std::time::Duration;

use async_trait::async_trait;
use mixdog_app_protocol::v2::connections::{
    ConnectionEndpoint, ConnectionIdParams, ConnectionNotice, ConnectionsIdParams, ConnectionsNoParams, ConnectionsNoticeParams,
    ConnectionsRenameParams, ConnectionsRestoreState, ConnectionsSignInParams, ConnectionsSubscribeParams,
    ConnectionsUnsubscribeParams,
    HostWindowCloseParams, HostWindowClosedParams, HostWindowFocusParams, HostWindowKind, HostWindowOpenParams, HostWindowOpenResult,
    PortForward, PortsDismissParams, PortsForwardParams, PortsStopParams, RemoteHost as RemoteHostView, RemoteHostPresenceParams,
    RemoteHostPresenceResult, RemoteHostRedeemParams, ServerPortsView, SshAskpass, SshCancelParams, SshAskpassReplyParams,
    SshCleanupParams, SshCleanupProgressParams, SshConfigHost, SshConnectParams, SshDiagnosticsRefParams, SshDiagnosticsText,
    SshInspectParams, SshOpenEphemeralParams, SshProgress, SshServerLoginCompleteParams, SshServerLoginFlow, SshServerLoginFlowParams,
    SshServerLoginProviderParams, SshServerLoginSaveKeyParams, SshServerLoginUpdatedParams, SshServerLogins, SshUpdateSettingsParams,
};
use mixdog_app_protocol::v2::feed::EmptyResult;
use mixdog_app_protocol::v2::host::PowerEvent;
use mixdog_app_protocol::v2::model_proxy::{ProxyAnswer, ProxyCall, ProxyEvent};
use mixdog_core_api::call::{Caller, WindowRole, WindowScope};
use mixdog_core_api::feed::Window;
use mixdog_core_api::host::{HostCapability, HostChannel, HostError};
use mixdog_core_api::ids::{ConnectionId, Method};
use mixdog_core_api::service::{Admit, DomainService};
use mixdog_core_api::{CallContext, ConnectionNotifier, CoreError, CoreRequest, Reply, Subscribe};
use mixdog_core_base::support::{decode, failed, wrong_method};
use mixdog_core_domains::domains::ai_admin::model_proxy::ProxyEvents;
use mixdog_core_domains::domains::ai_admin::model_proxy_service::ModelProxyService;
use mixdog_rt::TaskClass;
use mixdog_ssh::command::SshTarget;
use mixdog_ssh::connect_failure::ConnectError;
use mixdog_ssh::context::{AttemptContext, SshEnv};
use mixdog_ssh::diagnostics::diagnostics_key_for;
use mixdog_ssh::session::{Endpoint, Progress};
use serde::Serialize;
use serde_json::{json, Value};
use tokio::sync::{broadcast, watch};
use tokio::task::{AbortHandle, JoinHandle};
use tokio_util::sync::CancellationToken;

use crate::attempts::{ConnectionsPush, ServerLinks};
use crate::cleanup_ops::{Cleanup, CleanupProgressSink};
use crate::connect::{Connect, ServerWindows, EPHEMERAL_ID};
use crate::diagnostics_ops::{Asker, DiagnosticsOps};
use crate::host_list_ops::{HostLinks, HostList};
use crate::host_store::SshHostStore;
use crate::link::{LinkPool, LinkSpec, ServerLink};
use crate::link_machine::{LinkViewState, ModelLogin};
use crate::model_proxy_relay::{LocalModelProxy, ProxyEventSink};
use crate::notifier::{NotifyPrefs, NotifySink, NotifyTexts, ServerNotifier, WindowFocusSource};
use crate::policy;
use crate::port_forwards::PortError;
use crate::reattach::ReattachReport;
use crate::remote_hosts::{
    fetch_host_presence, parse_pair_code_input, parse_remote_host_link, redeem_pair_code, relay_http_origin, PairRedeemError,
    PresenceQuery, RedeemedPairCode, RemoteHost as StoredRemoteHost, RemoteHostStore,
};
use crate::restore::{attempt_context, Restore, RestoreLinks, RestoreWindows};
use crate::server_logins::{LoginError, ServerLogins};
use crate::view::{connection_link_view, ConnectionsFeed};
use crate::window_restore_store::WindowRestoreStore;

/// How long the host may be away before the links close: a desktop that restarts or reconnects finds its windows as they were.
pub const HOST_ABSENT_GRACE_MS: u64 = 30_000;

const DOMAIN: &str = "connections";
const WINDOW_CLOSED: &str = "host/window/closed";

const METHODS: &[&str] = &[
    "connections/subscribe",
    "connections/unsubscribe",
    "connections/ssh/list",
    "connections/ssh/rename",
    "connections/ssh/forget",
    "connections/ssh/open",
    "connections/ssh/configHosts",
    "connections/ssh/inspect",
    "connections/ssh/connect",
    "connections/ssh/cancel",
    "connections/ssh/askpassReply",
    "connections/ssh/cleanup",
    "connections/ssh/updateSettings",
    "connections/ssh/diagnosticsLog",
    "connections/ssh/diagnosticsCopy",
    "connections/ssh/serverLog",
    "connections/ssh/serverLogins",
    "connections/ssh/serverLoginBegin",
    "connections/ssh/serverLoginStatus",
    "connections/ssh/serverLoginComplete",
    "connections/ssh/serverLoginCancel",
    "connections/ssh/serverLoginSaveKey",
    "connections/ssh/serverLoginLogout",
    "connections/ssh/serverLoginRemoveCustom",
    "connections/ssh/openEphemeral",
    "connections/link/get",
    "connections/link/retry",
    "connections/link/retryNow",
    "connections/link/requestSignIn",
    "connections/ports/list",
    "connections/ports/forward",
    "connections/ports/stop",
    "connections/ports/dismiss",
    "connections/restore/get",
    "connections/restore/set",
    "connections/restore/progress",
    "connections/endpoint",
    "remoteHosts/list",
    "remoteHosts/redeemCode",
    "remoteHosts/rename",
    "remoteHosts/forget",
    "remoteHosts/presence",
    WINDOW_CLOSED,
];

fn locked<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

// ---------------------------------------------------------------------------------------------
// What the service reaches through
// ---------------------------------------------------------------------------------------------

/// The desktop host's windows (`host/window/*`).
#[async_trait]
pub trait WindowHost: Send + Sync {
    /// Opens (or focuses) the window of the server; the error is the text the dialog shows.
    async fn open(&self, connection_id: &str, name: &str) -> Result<(), String>;
    /// Closes the window of the server (nothing when it has none).
    async fn close(&self, connection_id: &str);
    /// Shows and focuses this PC's main window.
    async fn focus_main(&self);
}

fn host_failure(error: HostError) -> String {
    match error {
        HostError::Core(_) => "The desktop is not available to show this server.".to_owned(),
        HostError::Rpc { message, .. } => message,
    }
}

/// The windows of the host that claimed `host.windows` on the host channel.
pub struct HostChannelWindows {
    host: Arc<dyn HostChannel>,
}

impl HostChannelWindows {
    pub fn new(host: Arc<dyn HostChannel>) -> Self {
        Self { host }
    }
}

#[async_trait]
impl WindowHost for HostChannelWindows {
    async fn open(&self, connection_id: &str, name: &str) -> Result<(), String> {
        let params = serde_json::to_value(HostWindowOpenParams {
            connection_id: connection_id.to_owned(),
            kind: HostWindowKind::Ssh,
            name: name.to_owned(),
        })
        .map_err(|error| error.to_string())?;
        let answer = self.host.request(HostCapability::Windows, Method("host/window/open"), params).await.map_err(host_failure)?;
        match serde_json::from_value::<HostWindowOpenResult>(answer) {
            Ok(result) if result.opened => Ok(()),
            Ok(_) => Err("The server window could not be opened.".to_owned()),
            Err(error) => Err(error.to_string()),
        }
    }

    async fn close(&self, connection_id: &str) {
        let Ok(params) = serde_json::to_value(HostWindowCloseParams { connection_id: connection_id.to_owned() }) else { return };
        if let Err(error) = self.host.request(HostCapability::Windows, Method("host/window/close"), params).await {
            tracing::debug!("[connections] the window of {connection_id} could not be closed: {}", host_failure(error));
        }
    }

    async fn focus_main(&self) {
        let Ok(params) = serde_json::to_value(HostWindowFocusParams { connection_id: "local".to_owned(), session_id: None }) else { return };
        if let Err(error) = self.host.request(HostCapability::Windows, Method("host/window/focus"), params).await {
            tracing::debug!("[connections] the main window could not be focused: {}", host_failure(error));
        }
    }
}

/// Puts a server's window forward through the host, and remembers it for the reopening at the next launch (the server named by
/// `MIXDOG_SSH_TARGET` is never remembered). It is both the connect flow's [`ServerWindows`] and the reopening's [`RestoreWindows`].
pub struct ServerWindowOpener {
    windows: Arc<dyn WindowHost>,
    store: Arc<WindowRestoreStore>,
}

impl ServerWindowOpener {
    pub fn new(windows: Arc<dyn WindowHost>, store: Arc<WindowRestoreStore>) -> Self {
        Self { windows, store }
    }

    async fn show(&self, id: &str, name: &str) -> Result<(), String> {
        self.windows.open(id, name).await?;
        if id != EPHEMERAL_ID {
            if let Err(error) = self.store.remember(id).await {
                tracing::warn!("[connections] the server window could not be remembered: {error}");
            }
        }
        Ok(())
    }
}

#[async_trait]
impl ServerWindows for ServerWindowOpener {
    async fn open(&self, id: &str, name: &str) -> Result<(), String> {
        self.show(id, name).await
    }
}

#[async_trait]
impl RestoreWindows for ServerWindowOpener {
    async fn open(&self, connection_id: &str, name: &str) -> Result<(), String> {
        self.show(connection_id, name).await
    }
}

/// What the connect flow and the cleanup tell the connection that asked, as connection-scoped notifications
/// (`connections/ssh/askpass`, `connections/ssh/progress`).
pub struct NotifierPush(pub Arc<dyn ConnectionNotifier>);

impl ConnectionsPush for NotifierPush {
    fn askpass(&self, to: ConnectionId, question: SshAskpass) {
        send(self.0.as_ref(), to, "connections/ssh/askpass", &question);
    }

    fn progress(&self, to: ConnectionId, progress: SshProgress) {
        send(self.0.as_ref(), to, "connections/ssh/progress", &progress);
    }
}

fn send(notifier: &dyn ConnectionNotifier, to: ConnectionId, method: &'static str, params: &impl Serialize) {
    // A connection that is gone is not told.
    if let Ok(params) = serde_json::to_value(params) {
        drop(notifier.notify(to, Method(method), params));
    }
}

/// What a server link is to the service.
#[async_trait]
pub trait ServiceLink: Send + Sync {
    fn id(&self) -> &str;
    fn name(&self) -> &str;
    fn target(&self) -> &SshTarget;
    /// Which link object this is: a link the pool replaced is another one under the same id.
    fn identity(&self) -> usize;
    fn link_view(&self) -> LinkViewState;
    /// Skips the countdown of a waiting reconnect.
    fn retry_now(&self);
    /// The user connects again inside `context`.
    async fn reconnect(&self, context: AttemptContext) -> Result<(), ConnectError>;
    fn ports_view(&self) -> ServerPortsView;
    async fn forward(&self, remote_port: u16, local_port: Option<u16>) -> Result<PortForward, PortError>;
    async fn stop_forward(&self, remote_port: u16);
    fn dismiss_port(&self, port: u16);
    /// Where the server's core is reached through the tunnel; `None` until attached.
    fn endpoint(&self) -> Option<Endpoint>;
    /// A window starts or stops viewing the server's listening ports.
    async fn view_ports(&self, viewed: bool);
    fn notices(&self) -> broadcast::Receiver<ConnectionNotice>;
    /// Starts what follows this link while it is attached (the re-attach report and the notifier); dropped, it stops.
    fn watch(&self) -> Box<dyn Send + Sync>;
}

/// The links as the service uses them.
#[async_trait]
pub trait Links: Send + Sync {
    fn get(&self, id: &str) -> Option<Arc<dyn ServiceLink>>;
    fn list(&self) -> Vec<Arc<dyn ServiceLink>>;
    async fn open(&self, spec: LinkSpec, context: AttemptContext, progress: Option<Progress>) -> Result<(), ConnectError>;
    /// Detaches the link.
    async fn close(&self, id: &str);
    async fn close_all(&self);
    async fn power(&self, event: PowerEvent);
    /// Changes after every open and close that went through the handle.
    fn changes(&self) -> watch::Receiver<u64>;
    /// The ids of links that attached (the first time, or again).
    fn on_attach(&self) -> broadcast::Receiver<String>;
}

/// What the notifier of a server's sessions shows and decides with; one set serves every link.
pub struct LinkWatchers {
    pub sink: Arc<dyn NotifySink>,
    pub prefs: Arc<dyn NotifyPrefs>,
    pub focus: Arc<dyn WindowFocusSource>,
    pub texts: Arc<dyn NotifyTexts>,
}

struct PoolLink {
    link: Arc<ServerLink>,
    watchers: Arc<LinkWatchers>,
}

#[async_trait]
impl ServiceLink for PoolLink {
    fn id(&self) -> &str {
        self.link.id()
    }

    fn name(&self) -> &str {
        self.link.name()
    }

    fn target(&self) -> &SshTarget {
        self.link.target()
    }

    fn identity(&self) -> usize {
        Arc::as_ptr(&self.link) as usize
    }

    fn link_view(&self) -> LinkViewState {
        self.link.view().borrow().clone()
    }

    fn retry_now(&self) {
        self.link.retry_now();
    }

    async fn reconnect(&self, context: AttemptContext) -> Result<(), ConnectError> {
        self.link.reconnect(context).await
    }

    fn ports_view(&self) -> ServerPortsView {
        self.link.ports().list()
    }

    async fn forward(&self, remote_port: u16, local_port: Option<u16>) -> Result<PortForward, PortError> {
        self.link.ports().forward(remote_port, local_port).await
    }

    async fn stop_forward(&self, remote_port: u16) {
        self.link.ports().stop(remote_port).await;
    }

    fn dismiss_port(&self, port: u16) {
        self.link.ports().dismiss(port);
    }

    fn endpoint(&self) -> Option<Endpoint> {
        self.link.endpoint()
    }

    async fn view_ports(&self, viewed: bool) {
        if let Err(error) = self.link.view_ports(viewed).await {
            tracing::debug!("[connections] the ports of {} could not be {}: {error}", self.link.id(), if viewed { "subscribed" } else { "unsubscribed" });
        }
    }

    fn notices(&self) -> broadcast::Receiver<ConnectionNotice> {
        self.link.notices().subscribe()
    }

    fn watch(&self) -> Box<dyn Send + Sync> {
        let report = ReattachReport::attach(&self.link);
        let notifier = ServerNotifier::attach(
            &self.link,
            self.watchers.sink.clone(),
            self.watchers.prefs.clone(),
            self.watchers.focus.clone(),
            self.watchers.texts.clone(),
        );
        Box::new((report, notifier))
    }
}

/// The link pool as the connection modules and the service share it: every open and close announces itself ([`Links::changes`]),
/// so the connections feed and the per-link watchers follow, and the link a modules closes (a cancelled attempt, a cleanup) takes
/// its window with it.
pub struct PoolHandle {
    pool: LinkPool,
    windows: Arc<dyn WindowHost>,
    watchers: Arc<LinkWatchers>,
    changed: watch::Sender<u64>,
}

impl PoolHandle {
    pub fn new(pool: LinkPool, windows: Arc<dyn WindowHost>, watchers: LinkWatchers) -> Self {
        let (changed, _) = watch::channel(0);
        Self { pool, windows, watchers: Arc::new(watchers), changed }
    }

    /// The pool itself, for what is built over it (the connections feed, the server logins, the file reader).
    pub fn pool(&self) -> &LinkPool {
        &self.pool
    }

    fn announce(&self) {
        self.changed.send_modify(|count| *count += 1);
    }

    fn service_link(&self, link: Arc<ServerLink>) -> Arc<dyn ServiceLink> {
        Arc::new(PoolLink { link, watchers: self.watchers.clone() })
    }

    async fn open_link(&self, spec: LinkSpec, context: AttemptContext, progress: Option<Progress>) -> Result<(), ConnectError> {
        let opened = ServerLinks::open(&self.pool, spec, context, progress).await;
        self.announce();
        opened
    }
}

#[async_trait]
impl Links for PoolHandle {
    fn get(&self, id: &str) -> Option<Arc<dyn ServiceLink>> {
        self.pool.get(id).map(|link| self.service_link(link))
    }

    fn list(&self) -> Vec<Arc<dyn ServiceLink>> {
        self.pool.list().into_iter().map(|link| self.service_link(link)).collect()
    }

    async fn open(&self, spec: LinkSpec, context: AttemptContext, progress: Option<Progress>) -> Result<(), ConnectError> {
        self.open_link(spec, context, progress).await
    }

    async fn close(&self, id: &str) {
        self.pool.close(id).await;
        self.announce();
    }

    async fn close_all(&self) {
        self.pool.close_all().await;
        self.announce();
    }

    async fn power(&self, event: PowerEvent) {
        self.pool
            .power(match event {
                PowerEvent::Suspend => crate::link::LinkPower::Suspend,
                PowerEvent::Resume => crate::link::LinkPower::Resume,
            })
            .await;
    }

    fn changes(&self) -> watch::Receiver<u64> {
        self.changed.subscribe()
    }

    fn on_attach(&self) -> broadcast::Receiver<String> {
        self.pool.on_attach()
    }
}

/// What the connect flow and the cleanup open and close: a closed link's window goes with it.
#[async_trait]
impl ServerLinks for PoolHandle {
    fn is_open(&self, id: &str) -> bool {
        ServerLinks::is_open(&self.pool, id)
    }

    async fn open(&self, spec: LinkSpec, context: AttemptContext, progress: Option<Progress>) -> Result<(), ConnectError> {
        self.open_link(spec, context, progress).await
    }

    async fn close(&self, id: &str) {
        self.pool.close(id).await;
        self.windows.close(id).await;
        self.announce();
    }
}

#[async_trait]
impl HostLinks for PoolHandle {
    async fn apply_model_login(&self, id: &str, login: ModelLogin) -> Result<(), ConnectError> {
        HostLinks::apply_model_login(&self.pool, id, login).await
    }
}

/// The reopening's way to connect a link.
struct RestoreOpen(Arc<dyn Links>);

#[async_trait]
impl RestoreLinks for RestoreOpen {
    async fn open(&self, spec: LinkSpec, context: AttemptContext, progress: Option<Progress>) -> Result<(), ConnectError> {
        self.0.open(spec, context, progress).await
    }
}

/// This PC's own model-call service (`modelProxy/run`, on this PC's provider accounts) as what the server links run their server's
/// proxied calls with: the same admission (size, busy) and the same tracking as a `modelProxy/run`, so the app's close waits for
/// and aborts these calls too.
pub struct ServiceProxy(pub Arc<ModelProxyService>);

/// Gives the events of a running call to the link's relay.
struct Forward(Arc<dyn ProxyEventSink>);

impl ProxyEvents for Forward {
    fn emit(&self, event: ProxyEvent) {
        self.0.event(event);
    }
}

#[async_trait]
impl LocalModelProxy for ServiceProxy {
    async fn run(
        &self,
        call: ProxyCall,
        allowed_providers: Option<Vec<String>>,
        events: Arc<dyn ProxyEventSink>,
        cancel: CancellationToken,
    ) -> Result<ProxyAnswer, String> {
        // A call that failed is an answer the server reads; the service never fails to answer.
        let call = serde_json::to_value(call).map_err(|error| error.to_string())?;
        Ok(self.0.run_local(call, allowed_providers, Arc::new(Forward(events)), cancel).await)
    }
}

/// What the server logins do for the service.
#[async_trait]
pub trait ServerLoginOps: Send + Sync {
    async fn list(&self, id: &str) -> Result<SshServerLogins, LoginError>;
    async fn begin(&self, id: &str, provider: &str) -> Result<SshServerLoginFlow, LoginError>;
    async fn status(&self, id: &str, flow_id: &str) -> Result<SshServerLoginFlow, LoginError>;
    async fn complete(&self, id: &str, flow_id: &str, redirect_url: &str) -> Result<SshServerLoginFlow, LoginError>;
    async fn cancel(&self, id: &str, flow_id: &str) -> Result<(), LoginError>;
    async fn save_key(&self, id: &str, provider: &str, key: &str) -> Result<(), LoginError>;
    async fn logout(&self, id: &str, provider: &str) -> Result<(), LoginError>;
    async fn remove_custom(&self, id: &str, provider: &str) -> Result<(), LoginError>;
    fn forget_host(&self, id: &str);
    /// Each flow that ended on this PC's side without the user finishing it, with the saved server's id.
    fn updates(&self) -> broadcast::Receiver<(String, SshServerLoginFlow)>;
    async fn dispose(&self);
}

#[async_trait]
impl ServerLoginOps for ServerLogins {
    async fn list(&self, id: &str) -> Result<SshServerLogins, LoginError> {
        ServerLogins::list(self, id).await
    }

    async fn begin(&self, id: &str, provider: &str) -> Result<SshServerLoginFlow, LoginError> {
        ServerLogins::begin(self, id, provider).await
    }

    async fn status(&self, id: &str, flow_id: &str) -> Result<SshServerLoginFlow, LoginError> {
        ServerLogins::status(self, id, flow_id).await
    }

    async fn complete(&self, id: &str, flow_id: &str, redirect_url: &str) -> Result<SshServerLoginFlow, LoginError> {
        ServerLogins::complete(self, id, flow_id, redirect_url).await
    }

    async fn cancel(&self, id: &str, flow_id: &str) -> Result<(), LoginError> {
        ServerLogins::cancel(self, id, flow_id).await
    }

    async fn save_key(&self, id: &str, provider: &str, key: &str) -> Result<(), LoginError> {
        ServerLogins::save_key(self, id, provider, key).await
    }

    async fn logout(&self, id: &str, provider: &str) -> Result<(), LoginError> {
        ServerLogins::logout(self, id, provider).await
    }

    async fn remove_custom(&self, id: &str, provider: &str) -> Result<(), LoginError> {
        ServerLogins::remove_custom(self, id, provider).await
    }

    fn forget_host(&self, id: &str) {
        ServerLogins::forget_host(self, id);
    }

    fn updates(&self) -> broadcast::Receiver<(String, SshServerLoginFlow)> {
        ServerLogins::updates(self)
    }

    async fn dispose(&self) {
        ServerLogins::dispose(self).await;
    }
}

/// The relay's side of "Connect to another PC".
#[async_trait]
pub trait RelayPairing: Send + Sync {
    /// Redeems the 6-digit code at the relay.
    async fn redeem(&self, relay_origin: &str, code: &str) -> Result<RedeemedPairCode, PairRedeemError>;
    /// Which of the hosts are connected to their relay right now; a host on a relay that cannot answer is absent.
    async fn presence(&self, hosts: &[PresenceQuery]) -> HashMap<String, bool>;
}

/// The relay over HTTP.
pub struct RelayClient;

#[async_trait]
impl RelayPairing for RelayClient {
    async fn redeem(&self, relay_origin: &str, code: &str) -> Result<RedeemedPairCode, PairRedeemError> {
        redeem_pair_code(relay_origin, code).await
    }

    async fn presence(&self, hosts: &[PresenceQuery]) -> HashMap<String, bool> {
        fetch_host_presence(hosts).await
    }
}

/// The Host aliases of this PC's `~/.ssh/config` (Include expanded), as `connections/ssh/configHosts` answers them.
pub fn ssh_config_hosts(env: &SshEnv) -> Vec<SshConfigHost> {
    mixdog_ssh::user_config::config_hosts(&env.home, env.files.as_ref())
        .hosts
        .into_iter()
        .map(|host| SshConfigHost { alias: host.alias, detail: host.detail })
        .collect()
}

// ---------------------------------------------------------------------------------------------
// The service
// ---------------------------------------------------------------------------------------------

/// Everything the service works over; each module is built once by the composition root over the same stores and pool.
pub struct ConnectionsDeps {
    pub hosts: Arc<SshHostStore>,
    pub remote_hosts: Arc<RemoteHostStore>,
    pub window_restore: Arc<WindowRestoreStore>,
    pub links: Arc<dyn Links>,
    pub connect: Arc<Connect>,
    pub cleanup: Arc<Cleanup>,
    pub diagnostics: Arc<DiagnosticsOps>,
    pub host_list: Arc<HostList>,
    pub logins: Arc<dyn ServerLoginOps>,
    pub restore: Arc<Restore>,
    pub feed: Arc<ConnectionsFeed>,
    pub windows: Arc<dyn WindowHost>,
    pub notifier: Arc<dyn ConnectionNotifier>,
    pub relay: Arc<dyn RelayPairing>,
    /// The relay's address when remote access is on.
    pub relay_url: Arc<dyn Fn() -> Option<String> + Send + Sync>,
    /// The Host aliases of this PC's ssh config.
    pub config_hosts: Arc<dyn Fn() -> Vec<SshConfigHost> + Send + Sync>,
    /// The version the connection announced in its `initialize` (`clientInfo.version`); the copied diagnostics print the asking
    /// window's own.
    pub client_version: Arc<dyn Fn(ConnectionId) -> Option<String> + Send + Sync>,
}

struct AbortOnDrop(AbortHandle);

impl Drop for AbortOnDrop {
    fn drop(&mut self) {
        self.0.abort();
    }
}

/// What follows one attached link.
struct Watched {
    identity: usize,
    _watch: Box<dyn Send + Sync>,
    _notices: AbortOnDrop,
}

#[derive(Default)]
struct State {
    /// The connections that subscribed to the feed: `None` is every key (the main window), `Some(id)` one server's.
    subscribers: HashMap<ConnectionId, Option<String>>,
    /// The connection that began the login of a server: where its updates go.
    login_callers: HashMap<String, ConnectionId>,
    watchers: HashMap<String, Watched>,
    host_present: bool,
    /// The windows remembered are reopened at the next presence: at the start, and after the links closed for an absent host.
    restore_due: bool,
    grace: Option<JoinHandle<()>>,
    tasks: Vec<JoinHandle<()>>,
}

struct Inner {
    deps: ConnectionsDeps,
    opener: Arc<ServerWindowOpener>,
    state: Mutex<State>,
}

pub struct ConnectionsService {
    inner: Arc<Inner>,
}

impl ConnectionsService {
    /// Starts the service and the tasks that follow the links and the logins. Must be called inside a tokio runtime.
    pub fn new(deps: ConnectionsDeps) -> Self {
        let opener = Arc::new(ServerWindowOpener::new(deps.windows.clone(), deps.window_restore.clone()));
        let state = State { restore_due: true, ..State::default() };
        let inner = Arc::new(Inner { deps, opener, state: Mutex::new(state) });
        let tasks = vec![spawn_links(&inner), spawn_login_updates(&inner)];
        locked(&inner.state).tasks = tasks;
        inner.sync_links();
        Self { inner }
    }

    /// This PC goes to sleep or wakes up: the links pause, or are probed before anything is touched.
    pub fn power(&self, event: PowerEvent) {
        let inner = self.inner.clone();
        drop(mixdog_rt::spawn("connections-power", TaskClass::Control, async move { inner.deps.links.power(event).await }));
    }

    /// The desktop host is attached (`true`) or gone (`false`). Once it has been gone for [`HOST_ABSENT_GRACE_MS`] every link
    /// closes; when it is attached again the remembered windows are reopened if they were not still open.
    pub fn host_presence(&self, present: bool) {
        let inner = &self.inner;
        let mut state = locked(&inner.state);
        state.host_present = present;
        if present {
            if let Some(timer) = state.grace.take() {
                timer.abort();
            }
            let restore = std::mem::take(&mut state.restore_due);
            drop(state);
            if restore {
                inner.spawn_restore();
            }
        } else if state.grace.is_none() {
            let weak = Arc::downgrade(inner);
            state.grace = Some(mixdog_rt::spawn("connections-host-absent", TaskClass::Control, async move {
                mixdog_rt::time::sleep(Duration::from_millis(HOST_ABSENT_GRACE_MS)).await;
                if let Some(inner) = weak.upgrade() {
                    inner.host_gone().await;
                }
            }));
        }
    }

    /// A protocol connection closed: its connect attempts are cancelled and its questions answered with nothing, and it no longer
    /// views a server's ports.
    pub fn connection_closed(&self, connection: ConnectionId) {
        let inner = self.inner.clone();
        let scope = {
            let mut state = locked(&inner.state);
            state.login_callers.retain(|_, caller| *caller != connection);
            state.subscribers.remove(&connection)
        };
        if let Some(Some(id)) = scope {
            inner.sync_ports_view(&id);
        }
        drop(mixdog_rt::spawn("connections-caller-closed", TaskClass::Control, async move { inner.deps.connect.caller_closed(connection).await }));
    }

    /// The app is quitting: the tasks end, the logins are disposed and every link closes.
    pub async fn dispose(&self) {
        let (tasks, grace) = {
            let mut state = locked(&self.inner.state);
            (std::mem::take(&mut state.tasks), state.grace.take())
        };
        for task in tasks.into_iter().chain(grace) {
            task.abort();
        }
        self.inner.deps.logins.dispose().await;
        self.inner.deps.links.close_all().await;
        locked(&self.inner.state).watchers.clear();
    }
}

fn spawn_links(inner: &Arc<Inner>) -> JoinHandle<()> {
    let weak = Arc::downgrade(inner);
    let mut changes = inner.deps.links.changes();
    let mut attached = inner.deps.links.on_attach();
    mixdog_rt::spawn("connections-links", TaskClass::Control, async move {
        loop {
            tokio::select! {
                changed = changes.changed() => if changed.is_err() { return },
                id = attached.recv() => if matches!(id, Err(broadcast::error::RecvError::Closed)) { return },
            }
            let Some(inner) = weak.upgrade() else { return };
            inner.sync_links();
        }
    })
}

fn spawn_login_updates(inner: &Arc<Inner>) -> JoinHandle<()> {
    let weak = Arc::downgrade(inner);
    let mut updates = inner.deps.logins.updates();
    mixdog_rt::spawn("connections-login-updates", TaskClass::Control, async move {
        loop {
            match updates.recv().await {
                Ok((id, flow)) => {
                    let Some(inner) = weak.upgrade() else { return };
                    let caller = locked(&inner.state).login_callers.get(&id).copied();
                    if let Some(caller) = caller {
                        send(inner.deps.notifier.as_ref(), caller, "connections/ssh/serverLoginUpdated", &SshServerLoginUpdatedParams { id, flow });
                    }
                }
                Err(broadcast::error::RecvError::Lagged(_)) => {}
                Err(broadcast::error::RecvError::Closed) => return,
            }
        }
    })
}

fn spawn_notices(weak: Weak<Inner>, id: String, mut notices: broadcast::Receiver<ConnectionNotice>) -> AbortOnDrop {
    let task = mixdog_rt::spawn("connections-notices", TaskClass::Control, async move {
        loop {
            match notices.recv().await {
                Ok(notice) => {
                    let Some(inner) = weak.upgrade() else { return };
                    inner.send_notice(&id, notice);
                }
                Err(broadcast::error::RecvError::Lagged(_)) => {}
                Err(broadcast::error::RecvError::Closed) => return,
            }
        }
    });
    AbortOnDrop(task.abort_handle())
}

impl Inner {
    /// Brings the feed and the watchers in line with the links the pool holds: a watcher of a link that is gone or was replaced
    /// ends, a link without one gets it.
    fn sync_links(self: &Arc<Self>) {
        self.deps.feed.reconcile();
        let links = self.deps.links.list();
        let mut started = Vec::new();
        {
            let mut state = locked(&self.state);
            let live: HashMap<&str, usize> = links.iter().map(|link| (link.id(), link.identity())).collect();
            state.watchers.retain(|id, watched| live.get(id.as_str()) == Some(&watched.identity));
            for link in &links {
                if state.watchers.contains_key(link.id()) {
                    continue;
                }
                let watched = Watched {
                    identity: link.identity(),
                    _watch: link.watch(),
                    _notices: spawn_notices(Arc::downgrade(self), link.id().to_owned(), link.notices()),
                };
                state.watchers.insert(link.id().to_owned(), watched);
                started.push(link.id().to_owned());
            }
        }
        // A link that attached while a window already views its ports starts sampling them.
        for id in started.into_iter().filter(|id| self.ports_viewed(id)) {
            self.sync_ports_view(&id);
        }
    }

    fn notify(&self, to: ConnectionId, method: &'static str, params: &impl Serialize) {
        send(self.deps.notifier.as_ref(), to, method, params);
    }

    fn send_notice(&self, id: &str, notice: ConnectionNotice) {
        let viewers: Vec<ConnectionId> =
            locked(&self.state).subscribers.iter().filter(|(_, scope)| scope.as_deref() == Some(id)).map(|(viewer, _)| *viewer).collect();
        for viewer in viewers {
            self.notify(viewer, "connections/notice", &ConnectionsNoticeParams { connection_id: id.to_owned(), notice: notice.clone() });
        }
    }

    fn ports_viewed(&self, id: &str) -> bool {
        locked(&self.state).subscribers.values().any(|scope| scope.as_deref() == Some(id))
    }

    /// Whether any window views this server's ports now, told to the link (the server samples them only meanwhile).
    fn sync_ports_view(&self, id: &str) {
        let viewed = self.ports_viewed(id);
        if let Some(link) = self.deps.links.get(id) {
            drop(mixdog_rt::spawn("connections-ports-view", TaskClass::Control, async move { link.view_ports(viewed).await }));
        }
    }

    fn set_subscriber(&self, connection: ConnectionId, scope: Option<Option<String>>) {
        let before = {
            let mut state = locked(&self.state);
            let before = match &scope {
                Some(scope) => state.subscribers.insert(connection, scope.clone()),
                None => state.subscribers.remove(&connection),
            };
            before.flatten()
        };
        for id in before.into_iter().chain(scope.flatten()) {
            self.sync_ports_view(&id);
        }
    }

    fn spawn_restore(self: &Arc<Self>) {
        let inner = self.clone();
        drop(mixdog_rt::spawn("connections-restore", TaskClass::Control, async move {
            let links: Arc<dyn RestoreLinks> = Arc::new(RestoreOpen(inner.deps.links.clone()));
            let windows: Arc<dyn RestoreWindows> = inner.opener.clone();
            if let Err(error) = inner.deps.restore.run(links, windows).await {
                tracing::warn!("[connections] the server windows could not be reopened: {error}");
            }
        }));
    }

    /// The host stayed away for the whole grace: nothing is left to show the links in.
    async fn host_gone(self: &Arc<Self>) {
        {
            let mut state = locked(&self.state);
            if state.host_present {
                return;
            }
            state.grace = None;
            state.restore_due = true;
        }
        self.deps.links.close_all().await;
    }

    fn window_closed(self: &Arc<Self>, params: HostWindowClosedParams) {
        let inner = self.clone();
        drop(mixdog_rt::spawn("connections-window-closed", TaskClass::Control, async move {
            inner.deps.links.close(&params.connection_id).await;
            // A window the user closed is not reopened at the next launch; one that closed because the app quits is.
            if params.by_user {
                if let Err(error) = inner.deps.window_restore.forget(&params.connection_id).await {
                    tracing::warn!("[connections] a closed server window could not be forgotten: {error}");
                }
            }
        }));
    }

    /// The context of the user's reconnect of a link: the saved settings, no askpass (what needs the user goes through the connect
    /// dialog), and the diagnostics ring of its target.
    fn reconnect_context(&self, link: &dyn ServiceLink) -> AttemptContext {
        match self.deps.hosts.get(link.id()) {
            Some(record) => attempt_context(&record),
            None => AttemptContext { diagnostics_key: Some(diagnostics_key_for(link.target())), ..AttemptContext::default() },
        }
    }

    /// A refused login or changed host key needs the user's connect attempt: this PC's main window is brought forward and told which
    /// server to sign in to.
    async fn request_sign_in(&self, link: &dyn ServiceLink) {
        let record = self.deps.hosts.get(link.id());
        let params = ConnectionsSignInParams {
            id: link.id().to_owned(),
            name: record.as_ref().map_or_else(|| link.name().to_owned(), |record| record.name.clone()),
            target: record.as_ref().map_or_else(|| link.target().display.clone(), |record| record.target.clone()),
        };
        self.deps.windows.focus_main().await;
        let mains: Vec<ConnectionId> =
            locked(&self.state).subscribers.iter().filter(|(_, scope)| scope.is_none()).map(|(main, _)| *main).collect();
        for main in mains {
            self.notify(main, "connections/signIn", &params);
        }
    }
}

// ---------------------------------------------------------------------------------------------
// The methods
// ---------------------------------------------------------------------------------------------

fn value<T: Serialize>(result: T) -> Result<Reply, CoreError> {
    serde_json::to_value(result).map(Reply::Value).map_err(|error| failed(DOMAIN, error.to_string()))
}

fn empty() -> Result<Reply, CoreError> {
    value(EmptyResult {})
}

fn refusal(req: &CoreRequest) -> CoreError {
    CoreError::PermissionDenied { method: req.method.as_str().into(), origin: req.ctx.origin }
}

/// The protocol connection a request came from; an internal producer has none and manages no servers.
fn caller_of(req: &CoreRequest) -> Result<ConnectionId, CoreError> {
    match &req.ctx.caller {
        Caller::Connection(id) => Ok(*id),
        Caller::Internal(_) => Err(refusal(req)),
    }
}

/// Who is asking about a server's log: this PC's main window (or the host) about any server, a server window about its own.
fn asker_of(ctx: &CallContext) -> Asker {
    match &ctx.window {
        Some(WindowScope { role: WindowRole::Server { connection_id }, .. }) if !ctx.host_claimant => Asker::Server(connection_id.clone()),
        _ => Asker::ThisPc,
    }
}

fn attempt_failure(error: impl std::fmt::Display) -> CoreError {
    failed(DOMAIN, error.to_string())
}

fn remote_host_view(host: &StoredRemoteHost, url: String) -> RemoteHostView {
    let millis = |at: &serde_json::Number| at.as_i64().or_else(|| at.as_f64().map(|ms| ms as i64)).unwrap_or(0);
    RemoteHostView {
        id: host.id.clone(),
        name: host.name.clone(),
        url,
        added_at: millis(&host.added_at),
        last_connected_at: host.last_connected_at.as_ref().map(millis),
        open: false,
        online: None,
    }
}

impl Inner {
    /// The link of a server the call names, for the methods only a window of that server may call.
    fn link_of(&self, id: &str) -> Result<Arc<dyn ServiceLink>, CoreError> {
        self.deps.links.get(id).ok_or_else(|| failed(DOMAIN, "window-closed: The server window is closed."))
    }

    fn allow(&self, req: &CoreRequest, connection_id: Option<&str>) -> Result<(), CoreError> {
        policy::authorize(&req.ctx, req.method.as_str(), connection_id)
    }

    fn cleanup_sink(&self, caller: ConnectionId, id: &str) -> CleanupProgressSink {
        let notifier = self.deps.notifier.clone();
        let id = id.to_owned();
        Arc::new(move |progress| send(notifier.as_ref(), caller, "connections/ssh/cleanupProgress", &SshCleanupProgressParams { id: id.clone(), progress }))
    }

    async fn call_method(self: &Arc<Self>, req: CoreRequest) -> Result<Reply, CoreError> {
        let deps = &self.deps;
        match req.method.as_str() {
            "connections/subscribe" => {
                let params: ConnectionsSubscribeParams = decode(&req)?;
                let scope = policy::subscription_scope(&req.ctx, req.method.as_str(), params.connection_id.as_deref())?;
                let caller = caller_of(&req)?;
                self.set_subscriber(caller, Some(scope.clone()));
                Ok(Reply::Subscribe(Subscribe { result: json!({}), feed: deps.feed.source(scope.as_deref()), window: Window::Fixed, resume_from: None }))
            }
            "connections/unsubscribe" => {
                let _params: ConnectionsUnsubscribeParams = decode(&req)?;
                self.allow(&req, None)?;
                self.set_subscriber(caller_of(&req)?, None);
                empty()
            }
            "connections/ssh/list" => {
                let _params: ConnectionsNoParams = decode(&req)?;
                self.allow(&req, None)?;
                value(deps.host_list.list())
            }
            "connections/ssh/rename" => {
                let params: ConnectionsRenameParams = decode(&req)?;
                self.allow(&req, None)?;
                deps.host_list.rename(&params.id, &params.name).await.map_err(attempt_failure)?;
                empty()
            }
            "connections/ssh/forget" => {
                let params: ConnectionsIdParams = decode(&req)?;
                self.allow(&req, None)?;
                deps.host_list.forget(&params.id).await.map_err(attempt_failure)?;
                deps.logins.forget_host(&params.id);
                empty()
            }
            "connections/ssh/open" => {
                let params: ConnectionsIdParams = decode(&req)?;
                self.allow(&req, None)?;
                value(deps.connect.open(&params.id).await.map_err(attempt_failure)?)
            }
            "connections/ssh/configHosts" => {
                let _params: ConnectionsNoParams = decode(&req)?;
                self.allow(&req, None)?;
                value((deps.config_hosts)())
            }
            "connections/ssh/inspect" => {
                let params: SshInspectParams = decode(&req)?;
                self.allow(&req, None)?;
                value(deps.connect.inspect(caller_of(&req)?, &params.target).await.map_err(attempt_failure)?)
            }
            "connections/ssh/connect" => {
                let params: SshConnectParams = decode(&req)?;
                self.allow(&req, None)?;
                let attempt_id = params.request.attempt_id.clone();
                value(deps.connect.connect(caller_of(&req)?, &attempt_id, params.request).await.map_err(attempt_failure)?)
            }
            "connections/ssh/cancel" => {
                let params: SshCancelParams = decode(&req)?;
                self.allow(&req, None)?;
                deps.connect.cancel(caller_of(&req)?, &params.attempt_id).await;
                empty()
            }
            "connections/ssh/askpassReply" => {
                let params: SshAskpassReplyParams = decode(&req)?;
                self.allow(&req, None)?;
                deps.connect.askpass_reply(caller_of(&req)?, &params.attempt_id, &params.request_id, params.secret);
                empty()
            }
            "connections/ssh/cleanup" => {
                let params: SshCleanupParams = decode(&req)?;
                self.allow(&req, None)?;
                let caller = caller_of(&req)?;
                let sink = self.cleanup_sink(caller, &params.id);
                value(deps.cleanup.cleanup(caller, &params.id, params.request, sink).await.map_err(attempt_failure)?)
            }
            "connections/ssh/updateSettings" => {
                let params: SshUpdateSettingsParams = decode(&req)?;
                self.allow(&req, None)?;
                let settings = serde_json::to_value(&params.settings).map_err(attempt_failure)?;
                value(deps.host_list.update_settings(&params.id, &settings).await.map_err(attempt_failure)?)
            }
            "connections/ssh/diagnosticsLog" => {
                let params: SshDiagnosticsRefParams = decode(&req)?;
                self.allow(&req, None)?;
                value(deps.diagnostics.log(&asker_of(&req.ctx), &params.reference).map_err(attempt_failure)?)
            }
            "connections/ssh/diagnosticsCopy" => {
                let params: SshDiagnosticsRefParams = decode(&req)?;
                self.allow(&req, None)?;
                let version = (deps.client_version)(caller_of(&req)?).unwrap_or_default();
                let text = deps.diagnostics.copy(&asker_of(&req.ctx), &params.reference, &version).await.map_err(attempt_failure)?;
                value(SshDiagnosticsText { text })
            }
            "connections/ssh/serverLog" => {
                let params: SshDiagnosticsRefParams = decode(&req)?;
                self.allow(&req, None)?;
                value(deps.diagnostics.server_log(&asker_of(&req.ctx), &params.reference).await.map_err(attempt_failure)?)
            }
            "connections/ssh/serverLogins" => {
                let params: ConnectionsIdParams = decode(&req)?;
                self.allow(&req, None)?;
                value(deps.logins.list(&params.id).await.map_err(attempt_failure)?)
            }
            "connections/ssh/serverLoginBegin" => {
                let params: SshServerLoginProviderParams = decode(&req)?;
                self.allow(&req, None)?;
                // The login's later updates (its link went, its model login changed) go to the window that began it.
                locked(&self.state).login_callers.insert(params.id.clone(), caller_of(&req)?);
                value(deps.logins.begin(&params.id, &params.provider).await.map_err(attempt_failure)?)
            }
            "connections/ssh/serverLoginStatus" => {
                let params: SshServerLoginFlowParams = decode(&req)?;
                self.allow(&req, None)?;
                value(deps.logins.status(&params.id, &params.flow_id).await.map_err(attempt_failure)?)
            }
            "connections/ssh/serverLoginComplete" => {
                let params: SshServerLoginCompleteParams = decode(&req)?;
                self.allow(&req, None)?;
                value(deps.logins.complete(&params.id, &params.flow_id, &params.redirect_url).await.map_err(attempt_failure)?)
            }
            "connections/ssh/serverLoginCancel" => {
                let params: SshServerLoginFlowParams = decode(&req)?;
                self.allow(&req, None)?;
                deps.logins.cancel(&params.id, &params.flow_id).await.map_err(attempt_failure)?;
                empty()
            }
            "connections/ssh/serverLoginSaveKey" => {
                let params: SshServerLoginSaveKeyParams = decode(&req)?;
                self.allow(&req, None)?;
                deps.logins.save_key(&params.id, &params.provider, &params.key).await.map_err(attempt_failure)?;
                value(deps.logins.list(&params.id).await.map_err(attempt_failure)?)
            }
            "connections/ssh/serverLoginLogout" => {
                let params: SshServerLoginProviderParams = decode(&req)?;
                self.allow(&req, None)?;
                deps.logins.logout(&params.id, &params.provider).await.map_err(attempt_failure)?;
                value(deps.logins.list(&params.id).await.map_err(attempt_failure)?)
            }
            "connections/ssh/serverLoginRemoveCustom" => {
                let params: SshServerLoginProviderParams = decode(&req)?;
                self.allow(&req, None)?;
                deps.logins.remove_custom(&params.id, &params.provider).await.map_err(attempt_failure)?;
                value(deps.logins.list(&params.id).await.map_err(attempt_failure)?)
            }
            "connections/ssh/openEphemeral" => {
                let params: SshOpenEphemeralParams = decode(&req)?;
                self.allow(&req, None)?;
                value(deps.connect.open_ephemeral(&params.target, &params.name).await.map_err(attempt_failure)?)
            }
            "connections/link/get" => {
                let params: ConnectionIdParams = decode(&req)?;
                self.allow(&req, Some(&params.connection_id))?;
                value(deps.links.get(&params.connection_id).map(|link| connection_link_view(&link.link_view())))
            }
            "connections/link/retry" => {
                let params: ConnectionIdParams = decode(&req)?;
                self.allow(&req, Some(&params.connection_id))?;
                self.retry(&params.connection_id).await;
                empty()
            }
            "connections/link/retryNow" => {
                let params: ConnectionIdParams = decode(&req)?;
                self.allow(&req, Some(&params.connection_id))?;
                // Only skips a pending countdown; a lost link goes through Reconnect.
                if let Some(link) = deps.links.get(&params.connection_id) {
                    link.retry_now();
                }
                empty()
            }
            "connections/link/requestSignIn" => {
                let params: ConnectionIdParams = decode(&req)?;
                self.allow(&req, Some(&params.connection_id))?;
                let link = self.link_of(&params.connection_id)?;
                self.request_sign_in(link.as_ref()).await;
                empty()
            }
            "connections/ports/list" => {
                let params: ConnectionIdParams = decode(&req)?;
                self.allow(&req, Some(&params.connection_id))?;
                value(match deps.links.get(&params.connection_id) {
                    Some(link) => link.ports_view(),
                    None => ServerPortsView { detected: None, scan_error: None, forwards: Vec::new(), suggested: Vec::new() },
                })
            }
            "connections/ports/forward" => {
                let params: PortsForwardParams = decode(&req)?;
                self.allow(&req, Some(&params.connection_id))?;
                let link = self.link_of(&params.connection_id)?;
                value(link.forward(params.remote_port, params.local_port).await.map_err(attempt_failure)?)
            }
            "connections/ports/stop" => {
                let params: PortsStopParams = decode(&req)?;
                self.allow(&req, Some(&params.connection_id))?;
                self.link_of(&params.connection_id)?.stop_forward(params.remote_port).await;
                empty()
            }
            "connections/ports/dismiss" => {
                let params: PortsDismissParams = decode(&req)?;
                self.allow(&req, Some(&params.connection_id))?;
                self.link_of(&params.connection_id)?.dismiss_port(params.port);
                empty()
            }
            "connections/restore/get" => {
                let _params: ConnectionsNoParams = decode(&req)?;
                self.allow(&req, None)?;
                value(ConnectionsRestoreState { enabled: deps.window_restore.enabled().await.map_err(attempt_failure)? })
            }
            "connections/restore/set" => {
                let params: ConnectionsRestoreState = decode(&req)?;
                self.allow(&req, None)?;
                deps.window_restore.set_enabled(params.enabled).await.map_err(attempt_failure)?;
                deps.feed.refresh_restore().await;
                empty()
            }
            "connections/restore/progress" => {
                let _params: ConnectionsNoParams = decode(&req)?;
                self.allow(&req, None)?;
                value(deps.restore.progress().borrow().clone())
            }
            "connections/endpoint" => {
                let params: ConnectionIdParams = decode(&req)?;
                self.allow(&req, Some(&params.connection_id))?;
                let endpoint = deps
                    .links
                    .get(&params.connection_id)
                    .and_then(|link| link.endpoint())
                    .ok_or_else(|| failed(DOMAIN, "The server connection is not attached."))?;
                value(ConnectionEndpoint { url: endpoint.url, token: endpoint.token, server_instance_id: endpoint.server_instance_id })
            }
            method if method.starts_with("remoteHosts/") => self.remote_hosts(&req).await,
            other => Err(wrong_method(DOMAIN, other)),
        }
    }

    /// The user's Reconnect: a link that needs the user (a refused login, a changed host key) goes through the connect dialog of
    /// the main window; any other is dialed again, and the outcome shows in the link's state, not as an error of the button.
    async fn retry(&self, id: &str) {
        let Some(link) = self.deps.links.get(id) else { return };
        let needs_user = matches!(link.link_view().state, crate::link_machine::LinkState::Lost { settings_required: true, .. });
        if needs_user {
            self.request_sign_in(link.as_ref()).await;
            return;
        }
        if let Err(error) = link.reconnect(self.reconnect_context(link.as_ref())).await {
            tracing::debug!("[connections] the reconnect of {id} failed: {error}");
        }
    }

    async fn remote_hosts(&self, req: &CoreRequest) -> Result<Reply, CoreError> {
        let deps = &self.deps;
        self.allow(req, None)?;
        match req.method.as_str() {
            "remoteHosts/list" => {
                let _params: ConnectionsNoParams = decode(req)?;
                value(deps.remote_hosts.list().iter().map(|host| remote_host_view(host, host.url.clone())).collect::<Vec<_>>())
            }
            "remoteHosts/redeemCode" => {
                let params: RemoteHostRedeemParams = decode(req)?;
                let code = parse_pair_code_input(&params.code).ok_or_else(|| failed(DOMAIN, "Enter the 6-digit code shown on your PC."))?;
                let relay_url = (deps.relay_url)().ok_or_else(|| failed(DOMAIN, "Remote access is turned off on this PC."))?;
                let origin = relay_http_origin(&relay_url).map_err(attempt_failure)?;
                let redeemed = deps.relay.redeem(&origin, &code).await.map_err(|error| failed(DOMAIN, error.message(&|text: &str| text.to_owned())))?;
                let link = parse_remote_host_link(&format!("{origin}/d/{}/", redeemed.device_id))
                    .ok_or_else(|| failed(DOMAIN, "Codes are not available on this connection server yet. Use the QR code."))?;
                let saved = deps.remote_hosts.add(&link, &redeemed.name).await.map_err(attempt_failure)?;
                // The one-time ticket rides the fragment, which is never sent to the relay with the page request: the window loads
                // this address and the page drops the ticket once it has used it. The saved address has none.
                let mut view = remote_host_view(&saved, format!("{}#pair={}", saved.url, redeemed.ticket));
                view.open = true;
                value(view)
            }
            "remoteHosts/rename" => {
                let params: ConnectionsRenameParams = decode(req)?;
                deps.remote_hosts.rename(&params.id, &params.name).await.map_err(attempt_failure)?;
                let saved = deps.remote_hosts.get(&params.id).ok_or_else(|| failed(DOMAIN, "This computer is not saved."))?;
                value(remote_host_view(&saved, saved.url.clone()))
            }
            "remoteHosts/forget" => {
                let params: ConnectionsIdParams = decode(req)?;
                deps.remote_hosts.forget(&params.id).await.map_err(attempt_failure)?;
                empty()
            }
            "remoteHosts/presence" => {
                let params: RemoteHostPresenceParams = decode(req)?;
                let queries: Vec<PresenceQuery> = params
                    .ids
                    .iter()
                    .filter_map(|id| deps.remote_hosts.get(id))
                    .map(|host| PresenceQuery { id: host.id, url: host.url })
                    .collect();
                let reported = deps.relay.presence(&queries).await;
                let online = params.ids.into_iter().filter(|id| reported.get(id) == Some(&true)).collect();
                value(RemoteHostPresenceResult { online })
            }
            other => Err(wrong_method(DOMAIN, other)),
        }
    }
}

#[async_trait]
impl DomainService for ConnectionsService {
    fn methods(&self) -> &'static [&'static str] {
        METHODS
    }

    async fn call(&self, req: CoreRequest) -> Result<Reply, CoreError> {
        self.inner.call_method(req).await
    }

    fn notify(&self, method: Method, params: Value, _from: ConnectionId) -> Admit {
        if method.as_str() == WINDOW_CLOSED {
            match serde_json::from_value::<HostWindowClosedParams>(params) {
                Ok(closed) => self.inner.window_closed(closed),
                Err(error) => tracing::warn!("[connections] a malformed {WINDOW_CLOSED} was ignored: {error}"),
            }
        }
        Admit::Accepted
    }
}

#[cfg(test)]
#[path = "service_tests.rs"]
mod tests;
