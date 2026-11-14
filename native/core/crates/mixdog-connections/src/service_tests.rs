//! The connections service with fakes: the links, the desktop host's windows, the notifier, the ssh machine, the server logins and
//! the relay. The stores are real files in a temporary folder. No ssh runs and nothing is bound.

use std::collections::HashMap;
use std::future::Future;
use std::io;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, PoisonError};
use std::time::Duration;

use async_trait::async_trait;
use mixdog_app_protocol::v2::connections::{
    PortForwardStatus, SshAgentState, SshAgentStatus, SshHostKeyCheck, SshServerLoginFlowState, SshServerLogins,
};
use mixdog_core_api::mock::{MockLimits, MockScopedFeeds};
use mixdog_core_api::ScopedFeeds;
use mixdog_protocol::Origin;
use mixdog_ssh::askpass::AskpassPrompter;
use mixdog_ssh::cleanup::{CleanupProgress, CleanupReport};
use mixdog_ssh::command::{parse_ssh_target, SshError};
use mixdog_ssh::context::Platform;
use mixdog_ssh::diagnostics::Diagnostics;
use mixdog_ssh::host_key::{HostKeyInspection, ResolvedHost};
use tokio_util::sync::CancellationToken;

use super::*;
use crate::attempts::Attempts;
use crate::cleanup_ops::{CleanupDeps, ServerCleaner};
use crate::connect::{ConnectDeps, SshMachine};
use crate::diagnostics_ops::DiagnosticsMachine;
use crate::host_store::SshHostRecord;
use crate::link_machine::LinkState;
use crate::login::{LoginHelpers, StartedAskpass};
use crate::paths::ConnectionsPaths;
use crate::port_forwards::PortErrorCode;
use crate::view::{ssh_host_view, FeedLink, FeedLinks};

const TARGET: &str = "dev@build.example";
const HOST: ConnectionId = ConnectionId(1);
const MAIN: ConnectionId = ConnectionId(2);
const WINDOW: ConnectionId = ConnectionId(3);
const OTHER_WINDOW: ConnectionId = ConnectionId(4);
const DEVICE: &str = "0123456789abcdef0123456789abcdef";

fn locked<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

async fn within<T>(work: impl Future<Output = T>) -> T {
    mixdog_rt::time::timeout(Duration::from_secs(5), work).await.expect("timed out")
}

async fn settle() {
    for _ in 0..100 {
        tokio::task::yield_now().await;
    }
}

async fn advance(duration: Duration) {
    mixdog_rt::time::sleep(duration).await;
    settle().await;
}

fn io_lane() -> mixdog_rt::DurabilityIo {
    mixdog_rt::testing::tokens().durability_io
}

// ----- fakes: the links --------------------------------------------------------------------------------------------------

struct WatchGuard(Arc<AtomicUsize>);

impl Drop for WatchGuard {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::SeqCst);
    }
}

struct FakeLink {
    id: String,
    target: SshTarget,
    view: watch::Sender<LinkViewState>,
    ports: watch::Sender<ServerPortsView>,
    notices: broadcast::Sender<ConnectionNotice>,
    watching: Arc<AtomicUsize>,
    retried_now: AtomicUsize,
    reconnects: Mutex<Vec<AttemptContext>>,
    forwards: Mutex<Vec<(u16, Option<u16>)>>,
    stopped: Mutex<Vec<u16>>,
    dismissed: Mutex<Vec<u16>>,
    viewed: Mutex<Vec<bool>>,
}

impl FakeLink {
    fn new(id: &str) -> Arc<Self> {
        let state = LinkViewState {
            connection_id: id.to_owned(),
            state: LinkState::Connected,
            rtt_ms: Some(12),
            terminals_available: true,
            model_login: ModelLogin::Pc,
        };
        let ports = ServerPortsView { detected: None, scan_error: None, forwards: Vec::new(), suggested: vec![3000] };
        Arc::new(Self {
            id: id.to_owned(),
            target: parse_ssh_target(TARGET).expect("a target"),
            view: watch::channel(state).0,
            ports: watch::channel(ports).0,
            notices: broadcast::channel(8).0,
            watching: Arc::new(AtomicUsize::new(0)),
            retried_now: AtomicUsize::new(0),
            reconnects: Mutex::new(Vec::new()),
            forwards: Mutex::new(Vec::new()),
            stopped: Mutex::new(Vec::new()),
            dismissed: Mutex::new(Vec::new()),
            viewed: Mutex::new(Vec::new()),
        })
    }

    fn set_state(&self, state: LinkState) {
        self.view.send_modify(|view| view.state = state);
    }
}

#[async_trait]
impl ServiceLink for FakeLink {
    fn id(&self) -> &str {
        &self.id
    }

    fn name(&self) -> &str {
        "Build"
    }

    fn target(&self) -> &SshTarget {
        &self.target
    }

    fn identity(&self) -> usize {
        self as *const Self as usize
    }

    fn link_view(&self) -> LinkViewState {
        self.view.borrow().clone()
    }

    fn retry_now(&self) {
        self.retried_now.fetch_add(1, Ordering::SeqCst);
    }

    async fn reconnect(&self, context: AttemptContext) -> Result<(), ConnectError> {
        locked(&self.reconnects).push(context);
        Ok(())
    }

    fn ports_view(&self) -> ServerPortsView {
        self.ports.borrow().clone()
    }

    async fn forward(&self, remote_port: u16, local_port: Option<u16>) -> Result<PortForward, PortError> {
        locked(&self.forwards).push((remote_port, local_port));
        if remote_port == 1 {
            return Err(PortError { code: PortErrorCode::PortPrivileged, message: "Port 1 is privileged.".to_owned() });
        }
        Ok(PortForward { remote_port, local_port: local_port.unwrap_or(remote_port), status: PortForwardStatus::Active, message: None })
    }

    async fn stop_forward(&self, remote_port: u16) {
        locked(&self.stopped).push(remote_port);
    }

    fn dismiss_port(&self, port: u16) {
        locked(&self.dismissed).push(port);
    }

    fn endpoint(&self) -> Option<Endpoint> {
        Some(Endpoint {
            url: "ws://127.0.0.1:50001/rpc".to_owned(),
            token: "secret-token".to_owned(),
            server_instance_id: "run-a".to_owned(),
            pid: 4242,
            cwd: "/home/me".to_owned(),
            core_version: "1.2.3".to_owned(),
        })
    }

    async fn view_ports(&self, viewed: bool) {
        locked(&self.viewed).push(viewed);
    }

    fn notices(&self) -> broadcast::Receiver<ConnectionNotice> {
        self.notices.subscribe()
    }

    fn watch(&self) -> Box<dyn Send + Sync> {
        self.watching.fetch_add(1, Ordering::SeqCst);
        Box::new(WatchGuard(self.watching.clone()))
    }
}

impl FeedLink for FakeLink {
    fn link_view(&self) -> watch::Receiver<LinkViewState> {
        self.view.subscribe()
    }

    fn ports_view(&self) -> watch::Receiver<ServerPortsView> {
        self.ports.subscribe()
    }
}

struct FakeLinks {
    links: Mutex<Vec<Arc<FakeLink>>>,
    /// The ids opened, and the ids closed through either door.
    opened: Mutex<Vec<String>>,
    closed: Mutex<Vec<String>>,
    close_all: AtomicUsize,
    power: Mutex<Vec<PowerEvent>>,
    applied: Mutex<Vec<(String, ModelLogin)>>,
    changed: watch::Sender<u64>,
    attached: broadcast::Sender<String>,
}

impl FakeLinks {
    fn new() -> Arc<Self> {
        Arc::new(Self {
            links: Mutex::new(Vec::new()),
            opened: Mutex::new(Vec::new()),
            closed: Mutex::new(Vec::new()),
            close_all: AtomicUsize::new(0),
            power: Mutex::new(Vec::new()),
            applied: Mutex::new(Vec::new()),
            changed: watch::channel(0).0,
            attached: broadcast::channel(8).0,
        })
    }

    fn add(&self, id: &str) -> Arc<FakeLink> {
        let link = FakeLink::new(id);
        locked(&self.links).push(link.clone());
        self.changed.send_modify(|count| *count += 1);
        link
    }

    fn link(&self, id: &str) -> Arc<FakeLink> {
        locked(&self.links).iter().find(|link| link.id == id).cloned().expect("a link")
    }

    fn remove(&self, id: &str) {
        locked(&self.links).retain(|link| link.id != id);
        locked(&self.closed).push(id.to_owned());
        self.changed.send_modify(|count| *count += 1);
    }

    fn has(&self, id: &str) -> bool {
        locked(&self.links).iter().any(|link| link.id == id)
    }
}

#[async_trait]
impl Links for FakeLinks {
    fn get(&self, id: &str) -> Option<Arc<dyn ServiceLink>> {
        locked(&self.links).iter().find(|link| link.id == id).map(|link| link.clone() as Arc<dyn ServiceLink>)
    }

    fn list(&self) -> Vec<Arc<dyn ServiceLink>> {
        locked(&self.links).iter().map(|link| link.clone() as Arc<dyn ServiceLink>).collect()
    }

    async fn open(&self, spec: LinkSpec, _context: AttemptContext, _progress: Option<Progress>) -> Result<(), ConnectError> {
        locked(&self.opened).push(spec.id.clone());
        if !self.has(&spec.id) {
            self.add(&spec.id);
        }
        Ok(())
    }

    async fn close(&self, id: &str) {
        self.remove(id);
    }

    async fn close_all(&self) {
        self.close_all.fetch_add(1, Ordering::SeqCst);
        let ids: Vec<String> = locked(&self.links).iter().map(|link| link.id.clone()).collect();
        for id in ids {
            self.remove(&id);
        }
    }

    async fn power(&self, event: PowerEvent) {
        locked(&self.power).push(event);
    }

    fn changes(&self) -> watch::Receiver<u64> {
        self.changed.subscribe()
    }

    fn on_attach(&self) -> broadcast::Receiver<String> {
        self.attached.subscribe()
    }
}

#[async_trait]
impl ServerLinks for FakeLinks {
    fn is_open(&self, id: &str) -> bool {
        self.has(id)
    }

    async fn open(&self, spec: LinkSpec, context: AttemptContext, progress: Option<Progress>) -> Result<(), ConnectError> {
        Links::open(self, spec, context, progress).await
    }

    async fn close(&self, id: &str) {
        self.remove(id);
    }
}

#[async_trait]
impl HostLinks for FakeLinks {
    async fn apply_model_login(&self, id: &str, login: ModelLogin) -> Result<(), ConnectError> {
        locked(&self.applied).push((id.to_owned(), login));
        Ok(())
    }
}

impl FeedLinks for FakeLinks {
    fn get(&self, id: &str) -> Option<Arc<dyn FeedLink>> {
        locked(&self.links).iter().find(|link| link.id == id).map(|link| link.clone() as Arc<dyn FeedLink>)
    }

    fn ids(&self) -> Vec<String> {
        locked(&self.links).iter().map(|link| link.id.clone()).collect()
    }

    fn on_attach(&self) -> broadcast::Receiver<String> {
        self.attached.subscribe()
    }
}

// ----- fakes: the host, the notifier, the machine -------------------------------------------------------------------------

#[derive(Default)]
struct FakeWindows {
    opened: Mutex<Vec<(String, String)>>,
    closed: Mutex<Vec<String>>,
    focused: AtomicUsize,
    refuse: AtomicBool,
}

#[async_trait]
impl WindowHost for FakeWindows {
    async fn open(&self, connection_id: &str, name: &str) -> Result<(), String> {
        if self.refuse.load(Ordering::SeqCst) {
            return Err("The window could not be made.".to_owned());
        }
        locked(&self.opened).push((connection_id.to_owned(), name.to_owned()));
        Ok(())
    }

    async fn close(&self, connection_id: &str) {
        locked(&self.closed).push(connection_id.to_owned());
    }

    async fn focus_main(&self) {
        self.focused.fetch_add(1, Ordering::SeqCst);
    }
}

#[derive(Default)]
struct FakeNotifier {
    sent: Mutex<Vec<(ConnectionId, &'static str, Value)>>,
}

impl FakeNotifier {
    fn of(&self, method: &str) -> Vec<(ConnectionId, Value)> {
        locked(&self.sent).iter().filter(|(_, sent, _)| *sent == method).map(|(to, _, params)| (*to, params.clone())).collect()
    }
}

impl ConnectionNotifier for FakeNotifier {
    fn notify(&self, to: ConnectionId, method: Method, params: Value) -> Result<(), CoreError> {
        locked(&self.sent).push((to, method.as_str(), params));
        Ok(())
    }
}

fn trusted() -> HostKeyInspection {
    HostKeyInspection { hops: Vec::new(), check: SshHostKeyCheck::Trusted { authority: None, hops: None }, pin: None, replace: None, summary: None }
}

struct FakeMachine {
    diagnostics: Arc<Diagnostics>,
}

#[async_trait]
impl SshMachine for FakeMachine {
    async fn inspect(&self, _target: &SshTarget) -> Result<HostKeyInspection, SshError> {
        Ok(trusted())
    }

    fn pin(&self, _inspection: &HostKeyInspection) -> Result<(), SshError> {
        Ok(())
    }

    async fn replace(&self, _inspection: &HostKeyInspection) -> Result<(), SshError> {
        Ok(())
    }

    fn platform(&self) -> Platform {
        Platform::Linux
    }

    fn diagnostics(&self) -> Arc<Diagnostics> {
        self.diagnostics.clone()
    }

    fn var(&self, _name: &str) -> Option<String> {
        None
    }
}

struct FakeLogin;

#[async_trait]
impl LoginHelpers for FakeLogin {
    async fn start_askpass(&self, _prompter: Arc<dyn AskpassPrompter>) -> io::Result<StartedAskpass> {
        Err(io::Error::other("no askpass in this test"))
    }

    async fn agent_status(&self) -> SshAgentStatus {
        SshAgentStatus { state: SshAgentState::Empty, command: None }
    }
}

struct FakeCleaner;

#[async_trait]
impl ServerCleaner for FakeCleaner {
    async fn remove(
        &self,
        _context: &AttemptContext,
        _target: &SshTarget,
        _remove_user_data: bool,
        progress: &(dyn Fn(CleanupProgress) + Sync),
    ) -> Result<CleanupReport, ConnectError> {
        progress(CleanupProgress::Connect);
        progress(CleanupProgress::Done);
        Ok(CleanupReport::default())
    }

    fn platform(&self) -> Platform {
        Platform::Linux
    }
}

struct FakeDiagnostics {
    diagnostics: Arc<Diagnostics>,
}

#[async_trait]
impl DiagnosticsMachine for FakeDiagnostics {
    async fn ssh_version(&self) -> String {
        "OpenSSH_9.9".to_owned()
    }

    async fn resolved_host(&self, _target: &SshTarget) -> Option<ResolvedHost> {
        None
    }

    async fn daemon_log(&self, _target: &SshTarget, _context: AttemptContext) -> Result<String, SshError> {
        Ok("started\nlistening".to_owned())
    }

    fn os(&self) -> String {
        "linux 6.1".to_owned()
    }

    fn diagnostics(&self) -> Arc<Diagnostics> {
        self.diagnostics.clone()
    }
}

fn flow(provider: &str) -> SshServerLoginFlow {
    SshServerLoginFlow {
        flow_id: "flow-1".to_owned(),
        provider: provider.to_owned(),
        state: SshServerLoginFlowState::Pending,
        url: None,
        error: None,
        forwarded: false,
        user_code: None,
        manual_code_supported: None,
        open_url: None,
    }
}

struct FakeLogins {
    calls: Mutex<Vec<String>>,
    updates: broadcast::Sender<(String, SshServerLoginFlow)>,
}

impl FakeLogins {
    fn note(&self, call: String) {
        locked(&self.calls).push(call);
    }

    fn calls(&self) -> Vec<String> {
        locked(&self.calls).clone()
    }
}

#[async_trait]
impl ServerLoginOps for FakeLogins {
    async fn list(&self, id: &str) -> Result<SshServerLogins, LoginError> {
        self.note(format!("list {id}"));
        if id == "nobody" {
            return Err(LoginError("This SSH server is no longer saved.".to_owned()));
        }
        Ok(SshServerLogins { connected: true, model_login: None, busy_sessions: None, providers: None, keychain: None })
    }

    async fn begin(&self, id: &str, provider: &str) -> Result<SshServerLoginFlow, LoginError> {
        self.note(format!("begin {id} {provider}"));
        Ok(flow(provider))
    }

    async fn status(&self, id: &str, flow_id: &str) -> Result<SshServerLoginFlow, LoginError> {
        self.note(format!("status {id} {flow_id}"));
        Ok(flow("openai"))
    }

    async fn complete(&self, id: &str, flow_id: &str, redirect_url: &str) -> Result<SshServerLoginFlow, LoginError> {
        self.note(format!("complete {id} {flow_id} {redirect_url}"));
        Ok(flow("openai"))
    }

    async fn cancel(&self, id: &str, flow_id: &str) -> Result<(), LoginError> {
        self.note(format!("cancel {id} {flow_id}"));
        Ok(())
    }

    async fn save_key(&self, id: &str, provider: &str, key: &str) -> Result<(), LoginError> {
        self.note(format!("save_key {id} {provider} {}", key.len()));
        Ok(())
    }

    async fn logout(&self, id: &str, provider: &str) -> Result<(), LoginError> {
        self.note(format!("logout {id} {provider}"));
        Ok(())
    }

    async fn remove_custom(&self, id: &str, provider: &str) -> Result<(), LoginError> {
        self.note(format!("remove_custom {id} {provider}"));
        Ok(())
    }

    fn forget_host(&self, id: &str) {
        self.note(format!("forget_host {id}"));
    }

    fn updates(&self) -> broadcast::Receiver<(String, SshServerLoginFlow)> {
        self.updates.subscribe()
    }

    async fn dispose(&self) {
        self.note("dispose".to_owned());
    }
}

#[derive(Default)]
struct FakeRelay {
    redeemed: Mutex<Vec<(String, String)>>,
}

#[async_trait]
impl RelayPairing for FakeRelay {
    async fn redeem(&self, relay_origin: &str, code: &str) -> Result<RedeemedPairCode, PairRedeemError> {
        locked(&self.redeemed).push((relay_origin.to_owned(), code.to_owned()));
        if code == "000000" {
            return Err(PairRedeemError::WrongOrExpired);
        }
        Ok(RedeemedPairCode { device_id: DEVICE.to_owned(), name: "Studio PC".to_owned(), ticket: "tkt".to_owned() })
    }

    async fn presence(&self, hosts: &[PresenceQuery]) -> HashMap<String, bool> {
        // The first host is online, the others offline.
        hosts.iter().enumerate().map(|(at, host)| (host.id.clone(), at == 0)).collect()
    }
}

// ----- the rig ------------------------------------------------------------------------------------------------------------

struct Rig {
    service: ConnectionsService,
    hosts: Arc<SshHostStore>,
    remote_hosts: Arc<RemoteHostStore>,
    window_restore: Arc<WindowRestoreStore>,
    links: Arc<FakeLinks>,
    windows: Arc<FakeWindows>,
    notifier: Arc<FakeNotifier>,
    logins: Arc<FakeLogins>,
    relay: Arc<FakeRelay>,
    _dir: tempfile::TempDir,
}

async fn rig() -> Rig {
    let dir = tempfile::tempdir().expect("a folder");
    let paths = ConnectionsPaths::new(dir.path());
    let hosts = Arc::new(SshHostStore::load(&paths, io_lane()).await);
    let remote_hosts = Arc::new(RemoteHostStore::load(&paths, io_lane()).await);
    let window_restore = Arc::new(WindowRestoreStore::new(&paths, io_lane()));
    let links = FakeLinks::new();
    let windows = Arc::new(FakeWindows::default());
    let notifier = Arc::new(FakeNotifier::default());
    let diagnostics = Arc::new(Diagnostics::new());
    let login: Arc<dyn LoginHelpers> = Arc::new(FakeLogin);
    let opener = Arc::new(ServerWindowOpener::new(windows.clone(), window_restore.clone()));
    let attempts = Attempts::new(links.clone(), Arc::new(NotifierPush(notifier.clone())));
    let connect = Arc::new(Connect::new(ConnectDeps {
        attempts: attempts.clone(),
        machine: Arc::new(FakeMachine { diagnostics: diagnostics.clone() }),
        login: login.clone(),
        hosts: hosts.clone(),
        windows: opener,
        view: Arc::new(|record| ssh_host_view(record, true)),
        clock: Arc::new(|| 1_000),
    }));
    let cleanup = Arc::new(Cleanup::new(CleanupDeps { hosts: hosts.clone(), attempts, cleaner: Arc::new(FakeCleaner), login }));
    let diagnostics_ops = Arc::new(DiagnosticsOps::new(hosts.clone(), Arc::new(FakeDiagnostics { diagnostics })));
    let host_list = Arc::new(HostList::new(hosts.clone(), links.clone()));
    let logins = Arc::new(FakeLogins { calls: Mutex::new(Vec::new()), updates: broadcast::channel(8).0 });
    let restore = Arc::new(Restore::new(window_restore.clone(), hosts.clone()));
    let feeds: Arc<dyn ScopedFeeds> = Arc::new(MockScopedFeeds::new(MockLimits::default()));
    let feed = Arc::new(ConnectionsFeed::start(feeds, links.clone(), hosts.clone(), window_restore.clone(), &restore));
    let relay = Arc::new(FakeRelay::default());
    let service = ConnectionsService::new(ConnectionsDeps {
        hosts: hosts.clone(),
        remote_hosts: remote_hosts.clone(),
        window_restore: window_restore.clone(),
        links: links.clone(),
        connect,
        cleanup,
        diagnostics: diagnostics_ops,
        host_list,
        logins: logins.clone(),
        restore,
        feed,
        windows: windows.clone(),
        notifier: notifier.clone(),
        relay: relay.clone(),
        relay_url: Arc::new(|| Some("wss://relay.example/ws".to_owned())),
        config_hosts: Arc::new(|| vec![SshConfigHost { alias: "build".to_owned(), detail: TARGET.to_owned() }]),
        client_version: Arc::new(|connection| (connection == MAIN).then(|| "9.9.9".to_owned())),
    });
    Rig { service, hosts, remote_hosts, window_restore, links, windows, notifier, logins, relay, _dir: dir }
}

async fn save_box(rig: &Rig) -> SshHostRecord {
    let record = rig.hosts.ensure_for_target(TARGET, "Build").expect("a target");
    rig.hosts.save(SshHostRecord { id: "box".to_owned(), ..record }).await.expect("saved")
}

// ----- callers and calls --------------------------------------------------------------------------------------------------

fn host_ctx() -> CallContext {
    let mut ctx = CallContext::connection(HOST, Origin::Local, CancellationToken::new());
    ctx.host_claimant = true;
    ctx
}

fn main_ctx() -> CallContext {
    CallContext::connection(MAIN, Origin::Local, CancellationToken::new())
        .with_window(Some(WindowScope { id: "main".into(), role: WindowRole::Main }))
}

fn server_ctx(connection: ConnectionId, server: &str) -> CallContext {
    CallContext::connection(connection, Origin::Local, CancellationToken::new())
        .with_window(Some(WindowScope { id: format!("window-{server}").into(), role: WindowRole::Server { connection_id: server.to_owned() } }))
}

fn bystander_ctx() -> CallContext {
    CallContext::connection(ConnectionId(9), Origin::Local, CancellationToken::new())
}

async fn reply(rig: &Rig, method: &'static str, params: Value, ctx: CallContext) -> Result<Reply, CoreError> {
    within(rig.service.call(CoreRequest { method: Method(method), params, op: None, ctx })).await
}

async fn call(rig: &Rig, method: &'static str, params: Value, ctx: CallContext) -> Result<Value, CoreError> {
    match reply(rig, method, params, ctx).await? {
        Reply::Value(value) => Ok(value),
        Reply::Subscribe(_) => panic!("{method} subscribed"),
    }
}

fn message_of(error: &CoreError) -> String {
    match error {
        CoreError::DomainError { message: Some(message), .. } => message.to_string(),
        other => panic!("expected a failure with a message, got {other:?}"),
    }
}

fn denied(result: Result<Value, CoreError>) -> bool {
    matches!(result, Err(CoreError::PermissionDenied { .. }))
}

// ----- the table ----------------------------------------------------------------------------------------------------------

#[test]
fn methods_are_the_policy_table_and_the_window_notification() {
    let mut served: Vec<&str> = METHODS.to_vec();
    served.sort_unstable();
    let mut expected: Vec<&str> = policy::methods().chain([WINDOW_CLOSED]).collect();
    expected.sort_unstable();
    assert_eq!(served, expected);
}

/// The params and the caller of each method; a method that needs state made by an earlier one is listed after it.
fn sweep() -> Vec<(&'static str, Value, CallContext)> {
    vec![
        ("connections/subscribe", json!({}), main_ctx()),
        ("connections/unsubscribe", json!({ "subscriptionId": "c2-1" }), main_ctx()),
        ("connections/ssh/list", json!({}), main_ctx()),
        ("connections/ssh/rename", json!({ "id": "box", "name": "Builder" }), main_ctx()),
        ("connections/ssh/open", json!({ "id": "box" }), main_ctx()),
        ("connections/ssh/configHosts", json!({}), main_ctx()),
        ("connections/ssh/inspect", json!({ "target": TARGET }), main_ctx()),
        ("connections/ssh/askpassReply", json!({ "attemptId": "none", "requestId": "none", "secret": null }), main_ctx()),
        ("connections/ssh/cancel", json!({ "attemptId": "none" }), main_ctx()),
        ("connections/ssh/updateSettings", json!({ "id": "box", "settings": { "graceMinutes": 45 } }), main_ctx()),
        ("connections/ssh/diagnosticsLog", json!({ "ref": "box" }), main_ctx()),
        ("connections/ssh/diagnosticsCopy", json!({ "ref": "box" }), main_ctx()),
        ("connections/ssh/serverLog", json!({ "ref": "box" }), main_ctx()),
        ("connections/ssh/serverLogins", json!({ "id": "box" }), main_ctx()),
        ("connections/ssh/serverLoginBegin", json!({ "id": "box", "provider": "openai" }), main_ctx()),
        ("connections/ssh/serverLoginStatus", json!({ "id": "box", "flowId": "flow-1" }), main_ctx()),
        ("connections/ssh/serverLoginComplete", json!({ "id": "box", "flowId": "flow-1", "redirectUrl": "http://localhost/cb" }), main_ctx()),
        ("connections/ssh/serverLoginCancel", json!({ "id": "box", "flowId": "flow-1" }), main_ctx()),
        ("connections/ssh/serverLoginSaveKey", json!({ "id": "box", "provider": "openai", "key": "k" }), main_ctx()),
        ("connections/ssh/serverLoginLogout", json!({ "id": "box", "provider": "openai" }), main_ctx()),
        ("connections/ssh/serverLoginRemoveCustom", json!({ "id": "box", "provider": "custom" }), main_ctx()),
        ("connections/ssh/openEphemeral", json!({ "target": TARGET, "name": "Env" }), host_ctx()),
        ("connections/link/get", json!({ "connectionId": "box" }), main_ctx()),
        ("connections/link/retry", json!({ "connectionId": "box" }), main_ctx()),
        ("connections/link/retryNow", json!({ "connectionId": "box" }), main_ctx()),
        ("connections/link/requestSignIn", json!({ "connectionId": "box" }), server_ctx(WINDOW, "box")),
        ("connections/ports/list", json!({ "connectionId": "box" }), server_ctx(WINDOW, "box")),
        ("connections/ports/forward", json!({ "connectionId": "box", "remotePort": 3000, "localPort": null }), server_ctx(WINDOW, "box")),
        ("connections/ports/stop", json!({ "connectionId": "box", "remotePort": 3000 }), server_ctx(WINDOW, "box")),
        ("connections/ports/dismiss", json!({ "connectionId": "box", "port": 3000 }), server_ctx(WINDOW, "box")),
        ("connections/restore/get", json!({}), main_ctx()),
        ("connections/restore/set", json!({ "enabled": false }), main_ctx()),
        ("connections/restore/progress", json!({}), main_ctx()),
        ("connections/endpoint", json!({ "connectionId": "box" }), host_ctx()),
        ("remoteHosts/list", json!({}), main_ctx()),
        ("remoteHosts/redeemCode", json!({ "code": "123456" }), host_ctx()),
        ("remoteHosts/presence", json!({ "ids": [] }), host_ctx()),
        ("connections/ssh/cleanup", json!({ "id": "box", "request": { "operationId": "op-1", "removeUserData": false, "forget": false } }), main_ctx()),
        ("connections/ssh/forget", json!({ "id": "box" }), main_ctx()),
    ]
}

#[tokio::test]
async fn every_method_routes_to_its_module() {
    let rig = rig().await;
    save_box(&rig).await;
    rig.links.add("box");
    let mut served = Vec::new();
    for (method, params, ctx) in sweep() {
        let outcome = reply(&rig, method, params, ctx).await;
        assert!(outcome.is_ok(), "{method} failed: {:?}", outcome.err());
        served.push(method);
    }
    // The saved host of the remote list: rename and forget go through its own methods.
    let saved = call(&rig, "remoteHosts/list", json!({}), main_ctx()).await.expect("listed");
    let id = saved[0]["id"].as_str().expect("an id").to_owned();
    call(&rig, "remoteHosts/rename", json!({ "id": id, "name": "Studio" }), host_ctx()).await.expect("renamed");
    call(&rig, "remoteHosts/touch", json!({ "id": id }), host_ctx()).await.expect("touched");
    call(&rig, "remoteHosts/forget", json!({ "id": id }), host_ctx()).await.expect("forgotten");
    served.extend(["remoteHosts/rename", "remoteHosts/touch", "remoteHosts/forget"]);
    // connect needs the attempt inspect opened.
    let inspected = call(&rig, "connections/ssh/inspect", json!({ "target": TARGET }), main_ctx()).await.expect("inspected");
    let attempt = inspected["attemptId"].as_str().expect("an attempt").to_owned();
    call(&rig, "connections/ssh/connect", json!({ "attemptId": attempt, "request": { "attemptId": attempt } }), main_ctx())
        .await
        .expect("connected");
    served.push("connections/ssh/connect");
    // Each method of the table, and the notification, is covered by this walk.
    for method in METHODS.iter().filter(|method| **method != WINDOW_CLOSED) {
        assert!(served.contains(method), "{method} is not covered");
    }
    assert_eq!(rig.service.methods(), METHODS);
}

#[tokio::test]
async fn a_method_of_another_namespace_is_refused() {
    let rig = rig().await;
    let result = call(&rig, "terminal/input", json!({}), host_ctx()).await;
    assert!(matches!(result, Err(CoreError::InvalidParams { .. })), "{result:?}");
}

#[tokio::test]
async fn callers_are_held_to_the_table() {
    let rig = rig().await;
    save_box(&rig).await;
    rig.links.add("box");
    // A connection that is neither a window nor the host manages nothing.
    assert!(denied(call(&rig, "connections/ssh/list", json!({}), bystander_ctx()).await));
    // A server window does not manage servers, and sees only its own.
    assert!(denied(call(&rig, "connections/ssh/list", json!({}), server_ctx(WINDOW, "box")).await));
    assert!(denied(call(&rig, "connections/link/get", json!({ "connectionId": "other" }), server_ctx(WINDOW, "box")).await));
    // The Ports panel is a server window's; this PC's main window has none.
    assert!(denied(call(&rig, "connections/ports/forward", json!({ "connectionId": "box", "remotePort": 3000 }), main_ctx()).await));
    assert!(denied(call(&rig, "connections/ports/forward", json!({ "connectionId": "box", "remotePort": 3000 }), server_ctx(OTHER_WINDOW, "other")).await));
    // The endpoint and the remote PCs' changes are the host's.
    assert!(denied(call(&rig, "connections/endpoint", json!({ "connectionId": "box" }), main_ctx()).await));
    assert!(denied(call(&rig, "remoteHosts/redeemCode", json!({ "code": "123456" }), main_ctx()).await));
    // An internal producer has no connection to bind an attempt to.
    let internal = CallContext::internal("test");
    assert!(denied(call(&rig, "connections/ssh/inspect", json!({ "target": TARGET }), internal).await));
    // The list itself is the main window's, and the host may ask too.
    assert!(call(&rig, "remoteHosts/list", json!({}), main_ctx()).await.is_ok());
    assert!(call(&rig, "remoteHosts/list", json!({}), host_ctx()).await.is_ok());
}

// ----- the feed and the ports view ----------------------------------------------------------------------------------------

#[tokio::test]
async fn a_subscription_is_limited_to_the_scope_the_caller_may_have() {
    let rig = rig().await;
    rig.links.add("box");
    let main = reply(&rig, "connections/subscribe", json!({}), main_ctx()).await.expect("subscribed");
    let Reply::Subscribe(main) = main else { panic!("a subscription") };
    assert_eq!(main.window, Window::Fixed);
    // A server window that names no connection gets its own; naming another is refused.
    let own = reply(&rig, "connections/subscribe", json!({}), server_ctx(WINDOW, "box")).await.expect("own");
    assert!(matches!(own, Reply::Subscribe(_)));
    let other = reply(&rig, "connections/subscribe", json!({ "connectionId": "other" }), server_ctx(WINDOW, "box")).await;
    assert!(matches!(other, Err(CoreError::PermissionDenied { .. })));
    assert!(matches!(reply(&rig, "connections/subscribe", json!({}), bystander_ctx()).await, Err(CoreError::PermissionDenied { .. })));
}

#[tokio::test]
async fn the_ports_of_a_server_are_sampled_while_a_window_views_them() {
    let rig = rig().await;
    let link = rig.links.add("box");
    settle().await;
    reply(&rig, "connections/subscribe", json!({}), server_ctx(WINDOW, "box")).await.expect("subscribed");
    settle().await;
    assert_eq!(*locked(&link.viewed), vec![true]);
    // A second window of the same server keeps it viewed; the last one to go stops it.
    reply(&rig, "connections/subscribe", json!({ "connectionId": "box" }), server_ctx(OTHER_WINDOW, "box")).await.expect("subscribed");
    call(&rig, "connections/unsubscribe", json!({ "subscriptionId": "c3-1" }), server_ctx(WINDOW, "box")).await.expect("unsubscribed");
    settle().await;
    assert_eq!(locked(&link.viewed).last(), Some(&true));
    rig.service.connection_closed(OTHER_WINDOW);
    settle().await;
    assert_eq!(locked(&link.viewed).last(), Some(&false));
    // The main window's subscription views no server's ports.
    reply(&rig, "connections/subscribe", json!({}), main_ctx()).await.expect("subscribed");
    settle().await;
    assert_eq!(locked(&link.viewed).last(), Some(&false));
}

#[tokio::test]
async fn a_link_that_attaches_while_its_ports_are_viewed_starts_sampling() {
    let rig = rig().await;
    reply(&rig, "connections/subscribe", json!({}), server_ctx(WINDOW, "box")).await.expect("subscribed");
    let link = rig.links.add("box");
    settle().await;
    assert_eq!(*locked(&link.viewed), vec![true]);
}

// ----- the saved servers ---------------------------------------------------------------------------------------------------

#[tokio::test]
async fn saved_servers_are_listed_renamed_updated_and_forgotten() {
    let rig = rig().await;
    save_box(&rig).await;
    rig.links.add("box");
    let listed = call(&rig, "connections/ssh/list", json!({}), main_ctx()).await.expect("listed");
    assert_eq!((listed[0]["id"].clone(), listed[0]["open"].clone()), (json!("box"), json!(true)));

    call(&rig, "connections/ssh/rename", json!({ "id": "box", "name": "Builder" }), main_ctx()).await.expect("renamed");
    assert_eq!(rig.hosts.get("box").map(|record| record.name), Some("Builder".to_owned()));

    // The settings are validated where they are saved; a changed model login restarts the attached server behind the answer.
    let updated = call(&rig, "connections/ssh/updateSettings", json!({ "id": "box", "settings": { "modelLogin": "server", "graceMinutes": 45 } }), main_ctx())
        .await
        .expect("updated");
    assert_eq!(updated["settings"]["graceMinutes"], json!(45));
    settle().await;
    assert_eq!(*locked(&rig.links.applied), vec![("box".to_owned(), ModelLogin::Server)]);
    let refused = call(&rig, "connections/ssh/updateSettings", json!({ "id": "box", "settings": { "graceMinutes": 0 } }), main_ctx()).await;
    assert!(message_of(&refused.expect_err("refused")).contains("minutes"));

    call(&rig, "connections/ssh/forget", json!({ "id": "box" }), main_ctx()).await.expect("forgotten");
    assert!(rig.hosts.get("box").is_none());
    assert_eq!(rig.logins.calls().last().map(String::as_str), Some("forget_host box"));
    let refused = call(&rig, "connections/ssh/rename", json!({ "id": "", "name": "x" }), main_ctx()).await;
    assert!(message_of(&refused.expect_err("refused")).contains("non-empty"));
}

#[tokio::test]
async fn the_ssh_config_aliases_are_listed() {
    let rig = rig().await;
    let hosts = call(&rig, "connections/ssh/configHosts", json!({}), main_ctx()).await.expect("listed");
    assert_eq!(hosts, json!([{ "alias": "build", "detail": TARGET }]));
}

#[tokio::test]
async fn a_params_value_of_the_wrong_shape_is_refused_at_the_boundary() {
    let rig = rig().await;
    let result = call(&rig, "connections/ssh/rename", json!({ "id": 5 }), main_ctx()).await;
    assert!(matches!(result, Err(CoreError::InvalidParams { .. })), "{result:?}");
}

// ----- connecting ----------------------------------------------------------------------------------------------------------

#[tokio::test]
async fn connecting_opens_the_window_and_remembers_it_and_a_cancel_withdraws_an_attempt() {
    let rig = rig().await;
    let inspected = call(&rig, "connections/ssh/inspect", json!({ "target": TARGET }), main_ctx()).await.expect("inspected");
    assert_eq!(inspected["check"]["status"], json!("trusted"));
    let attempt = inspected["attemptId"].as_str().expect("an attempt").to_owned();

    // Another connection cannot use the attempt.
    let stolen = call(&rig, "connections/ssh/connect", json!({ "attemptId": attempt, "request": { "attemptId": attempt } }), host_ctx()).await;
    assert!(message_of(&stolen.expect_err("refused")).contains("no longer active"));

    let connected = call(&rig, "connections/ssh/connect", json!({ "attemptId": attempt, "request": { "attemptId": attempt } }), main_ctx())
        .await
        .expect("connected");
    assert_eq!(connected["ok"], json!(true));
    let id = connected["host"]["id"].as_str().expect("an id").to_owned();
    assert_eq!(locked(&rig.windows.opened).iter().map(|(opened, _)| opened.clone()).collect::<Vec<_>>(), vec![id.clone()]);
    assert_eq!(rig.window_restore.list().await.expect("listed"), vec![id.clone()]);
    assert!(rig.hosts.get(&id).is_some());

    // A window that cannot be made is a failed result, not an error.
    rig.windows.refuse.store(true, Ordering::SeqCst);
    let again = call(&rig, "connections/ssh/open", json!({ "id": id }), main_ctx()).await.expect("answered");
    assert_eq!(again["ok"], json!(false));

    let second = call(&rig, "connections/ssh/inspect", json!({ "target": TARGET }), main_ctx()).await.expect("inspected");
    let second = second["attemptId"].as_str().expect("an attempt").to_owned();
    call(&rig, "connections/ssh/cancel", json!({ "attemptId": second }), main_ctx()).await.expect("cancelled");
    let gone = call(&rig, "connections/ssh/connect", json!({ "attemptId": second, "request": { "attemptId": second } }), main_ctx()).await;
    assert!(message_of(&gone.expect_err("refused")).contains("no longer active"));
}

#[tokio::test]
async fn a_server_that_is_not_connected_is_not_opened_from_the_list() {
    let rig = rig().await;
    save_box(&rig).await;
    let result = call(&rig, "connections/ssh/open", json!({ "id": "box" }), main_ctx()).await;
    assert!(message_of(&result.expect_err("refused")).contains("not connected"));
}

#[tokio::test]
async fn the_environment_server_opens_a_window_that_is_not_remembered() {
    let rig = rig().await;
    let result = call(&rig, "connections/ssh/openEphemeral", json!({ "target": TARGET, "name": "Env" }), host_ctx()).await.expect("opened");
    assert_eq!(result["ok"], json!(true));
    assert_eq!(*locked(&rig.windows.opened), vec![(EPHEMERAL_ID.to_owned(), "Env".to_owned())]);
    assert!(rig.window_restore.list().await.expect("listed").is_empty());
    assert!(rig.hosts.list().is_empty());
}

#[tokio::test]
async fn a_closed_connection_cancels_its_attempts() {
    let rig = rig().await;
    let inspected = call(&rig, "connections/ssh/inspect", json!({ "target": TARGET }), main_ctx()).await.expect("inspected");
    let attempt = inspected["attemptId"].as_str().expect("an attempt").to_owned();
    rig.service.connection_closed(MAIN);
    settle().await;
    let gone = call(&rig, "connections/ssh/connect", json!({ "attemptId": attempt, "request": { "attemptId": attempt } }), main_ctx()).await;
    assert!(message_of(&gone.expect_err("refused")).contains("no longer active"));
}

#[tokio::test]
async fn the_cleanup_reports_its_progress_to_the_caller_and_closes_the_window_first() {
    let rig = rig().await;
    save_box(&rig).await;
    rig.links.add("box");
    let result = call(
        &rig,
        "connections/ssh/cleanup",
        json!({ "id": "box", "request": { "operationId": "op-1", "removeUserData": true, "forget": true } }),
        main_ctx(),
    )
    .await
    .expect("cleaned");
    assert_eq!(result["ok"], json!(true));
    assert!(rig.hosts.get("box").is_none());
    assert!(!rig.links.has("box"));
    let progress = rig.notifier.of("connections/ssh/cleanupProgress");
    let phases: Vec<(ConnectionId, Value, Value)> = progress.iter().map(|(to, params)| (*to, params["id"].clone(), params["phase"].clone())).collect();
    assert_eq!(phases, vec![(MAIN, json!("box"), json!("connect")), (MAIN, json!("box"), json!("done"))]);
    assert_eq!(progress[0].1["operationId"], json!("op-1"));
    let refused = call(&rig, "connections/ssh/cleanup", json!({ "id": "box", "request": { "operationId": "", "removeUserData": false, "forget": false } }), main_ctx()).await;
    assert!(message_of(&refused.expect_err("refused")).contains("operationId"));
}

// ----- diagnostics ---------------------------------------------------------------------------------------------------------

#[tokio::test]
async fn diagnostics_answer_this_pc_for_any_server_and_a_server_window_for_its_own() {
    let rig = rig().await;
    save_box(&rig).await;
    let log = call(&rig, "connections/ssh/diagnosticsLog", json!({ "ref": "box" }), main_ctx()).await.expect("log");
    assert!(log["lines"].is_array());
    // The server window asks about its own server; naming another one is answered with its own, never another's.
    let own = call(&rig, "connections/ssh/serverLog", json!({ "ref": "anything" }), server_ctx(WINDOW, "box")).await.expect("own");
    assert_eq!(own["ok"], json!(true));
    assert!(own["text"].as_str().expect("text").contains("listening"));
    let unsaved = call(&rig, "connections/ssh/serverLog", json!({ "ref": "x" }), server_ctx(OTHER_WINDOW, "other")).await;
    assert!(message_of(&unsaved.expect_err("refused")).contains("no SSH server log"));
    // The copied text names the version the asking connection announced.
    let copy = call(&rig, "connections/ssh/diagnosticsCopy", json!({ "ref": "box" }), main_ctx()).await.expect("copy");
    assert!(copy["text"].as_str().expect("text").contains("9.9.9"));
}

// ----- the logins on a server ----------------------------------------------------------------------------------------------

#[tokio::test]
async fn the_server_logins_route_and_their_updates_reach_the_window_that_began_them() {
    let rig = rig().await;
    call(&rig, "connections/ssh/serverLoginBegin", json!({ "id": "box", "provider": "openai" }), main_ctx()).await.expect("begun");
    call(&rig, "connections/ssh/serverLoginStatus", json!({ "id": "box", "flowId": "flow-1" }), main_ctx()).await.expect("status");
    call(&rig, "connections/ssh/serverLoginComplete", json!({ "id": "box", "flowId": "flow-1", "redirectUrl": "http://localhost/cb" }), main_ctx())
        .await
        .expect("completed");
    let cancelled = call(&rig, "connections/ssh/serverLoginCancel", json!({ "id": "box", "flowId": "flow-1" }), main_ctx()).await.expect("cancelled");
    assert_eq!(cancelled, json!({}));
    // Saving, logging out and removing answer the list the dialog shows.
    for (method, params) in [
        ("connections/ssh/serverLoginSaveKey", json!({ "id": "box", "provider": "openai", "key": "sk-1" })),
        ("connections/ssh/serverLoginLogout", json!({ "id": "box", "provider": "openai" })),
        ("connections/ssh/serverLoginRemoveCustom", json!({ "id": "box", "provider": "custom" })),
    ] {
        let answer = call(&rig, method, params, main_ctx()).await.expect("answered");
        assert_eq!(answer["connected"], json!(true), "{method}");
    }
    assert_eq!(
        rig.logins.calls(),
        vec![
            "begin box openai",
            "status box flow-1",
            "complete box flow-1 http://localhost/cb",
            "cancel box flow-1",
            "save_key box openai 4",
            "list box",
            "logout box openai",
            "list box",
            "remove_custom box custom",
            "list box",
        ]
    );
    let refused = call(&rig, "connections/ssh/serverLogins", json!({ "id": "nobody" }), main_ctx()).await;
    assert!(message_of(&refused.expect_err("refused")).contains("no longer saved"));

    // A login that ended on this PC's side is told to the window that began it.
    drop(rig.logins.updates.send(("box".to_owned(), flow("openai"))));
    settle().await;
    let updated = rig.notifier.of("connections/ssh/serverLoginUpdated");
    assert_eq!(updated.len(), 1);
    assert_eq!((updated[0].0, updated[0].1["id"].clone(), updated[0].1["flow"]["flowId"].clone()), (MAIN, json!("box"), json!("flow-1")));
    // A window that is gone is not told.
    rig.service.connection_closed(MAIN);
    drop(rig.logins.updates.send(("box".to_owned(), flow("openai"))));
    settle().await;
    assert_eq!(rig.notifier.of("connections/ssh/serverLoginUpdated").len(), 1);
}

// ----- the link of a server window -----------------------------------------------------------------------------------------

#[tokio::test]
async fn the_link_state_is_answered_and_a_missing_link_is_null() {
    let rig = rig().await;
    rig.links.add("box");
    let view = call(&rig, "connections/link/get", json!({ "connectionId": "box" }), server_ctx(WINDOW, "box")).await.expect("view");
    assert_eq!((view["connectionId"].clone(), view["state"]["status"].clone()), (json!("box"), json!("connected")));
    let none = call(&rig, "connections/link/get", json!({ "connectionId": "gone" }), main_ctx()).await.expect("answered");
    assert_eq!(none, Value::Null);
}

#[tokio::test]
async fn retry_dials_again_in_batch_mode_under_the_saved_settings() {
    let rig = rig().await;
    save_box(&rig).await;
    rig.hosts.update_settings("box", &json!({ "identityFile": "/keys/id" })).await.expect("saved");
    let link = rig.links.add("box");
    link.set_state(LinkState::Lost { terminal: false, code: "network".into(), message: "down".into(), settings_required: false });
    call(&rig, "connections/link/retry", json!({ "connectionId": "box" }), server_ctx(WINDOW, "box")).await.expect("retried");
    let contexts = locked(&link.reconnects).clone();
    assert_eq!(contexts.len(), 1);
    assert!(contexts[0].askpass.is_none());
    assert_eq!(contexts[0].settings.as_ref().and_then(|settings| settings.identity_file.as_deref()), Some("/keys/id"));
    assert_eq!(rig.windows.focused.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn a_link_that_needs_the_user_asks_this_pcs_window_to_sign_in() {
    let rig = rig().await;
    save_box(&rig).await;
    let link = rig.links.add("box");
    link.set_state(LinkState::Lost { terminal: true, code: "auth".into(), message: "refused".into(), settings_required: true });
    // This PC's main window listens for it with its feed subscription.
    reply(&rig, "connections/subscribe", json!({}), main_ctx()).await.expect("subscribed");
    call(&rig, "connections/link/retry", json!({ "connectionId": "box" }), server_ctx(WINDOW, "box")).await.expect("retried");
    assert!(locked(&link.reconnects).is_empty());
    assert_eq!(rig.windows.focused.load(Ordering::SeqCst), 1);
    let asked = rig.notifier.of("connections/signIn");
    assert_eq!(asked.len(), 1);
    assert_eq!((asked[0].0, asked[0].1["id"].clone(), asked[0].1["name"].clone()), (MAIN, json!("box"), json!("Build")));
    assert!(asked[0].1["target"].as_str().expect("a target").contains("build.example"));
    // The window may also ask outright.
    call(&rig, "connections/link/requestSignIn", json!({ "connectionId": "box" }), server_ctx(WINDOW, "box")).await.expect("asked");
    assert_eq!(rig.notifier.of("connections/signIn").len(), 2);
    let missing = call(&rig, "connections/link/requestSignIn", json!({ "connectionId": "gone" }), server_ctx(OTHER_WINDOW, "gone")).await;
    assert!(message_of(&missing.expect_err("refused")).contains("window-closed"));
}

#[tokio::test]
async fn retry_now_skips_the_countdown_of_the_servers_link() {
    let rig = rig().await;
    let link = rig.links.add("box");
    call(&rig, "connections/link/retryNow", json!({ "connectionId": "box" }), server_ctx(WINDOW, "box")).await.expect("skipped");
    assert_eq!(link.retried_now.load(Ordering::SeqCst), 1);
    // A server without a link has nothing waiting.
    call(&rig, "connections/link/retryNow", json!({ "connectionId": "gone" }), main_ctx()).await.expect("answered");
}

#[tokio::test]
async fn the_ports_panel_lists_forwards_stops_and_dismisses() {
    let rig = rig().await;
    let link = rig.links.add("box");
    let ctx = || server_ctx(WINDOW, "box");
    let view = call(&rig, "connections/ports/list", json!({ "connectionId": "box" }), ctx()).await.expect("listed");
    assert_eq!(view["suggested"], json!([3000]));
    let forwarded = call(&rig, "connections/ports/forward", json!({ "connectionId": "box", "remotePort": 8080, "localPort": 9000 }), ctx()).await.expect("forwarded");
    assert_eq!((forwarded["remotePort"].clone(), forwarded["localPort"].clone(), forwarded["status"].clone()), (json!(8080), json!(9000), json!("active")));
    // A refusal leads with its code.
    let refused = call(&rig, "connections/ports/forward", json!({ "connectionId": "box", "remotePort": 1 }), ctx()).await;
    assert!(message_of(&refused.expect_err("refused")).starts_with("port-privileged"));
    call(&rig, "connections/ports/stop", json!({ "connectionId": "box", "remotePort": 8080 }), ctx()).await.expect("stopped");
    call(&rig, "connections/ports/dismiss", json!({ "connectionId": "box", "port": 3000 }), ctx()).await.expect("dismissed");
    assert_eq!(*locked(&link.forwards), vec![(8080, Some(9000)), (1, None)]);
    assert_eq!((locked(&link.stopped).clone(), locked(&link.dismissed).clone()), (vec![8080], vec![3000]));
    // A window whose link is gone is told so, and its panel is empty.
    rig.links.remove("box");
    let gone = call(&rig, "connections/ports/forward", json!({ "connectionId": "box", "remotePort": 8080 }), ctx()).await;
    assert!(message_of(&gone.expect_err("refused")).starts_with("window-closed"));
    let empty = call(&rig, "connections/ports/list", json!({ "connectionId": "box" }), ctx()).await.expect("listed");
    assert_eq!(empty["forwards"], json!([]));
}

#[tokio::test]
async fn the_endpoint_of_an_attached_server_is_the_hosts() {
    let rig = rig().await;
    rig.links.add("box");
    let endpoint = call(&rig, "connections/endpoint", json!({ "connectionId": "box" }), host_ctx()).await.expect("endpoint");
    assert_eq!(endpoint, json!({ "url": "ws://127.0.0.1:50001/rpc", "token": "secret-token", "serverInstanceId": "run-a" }));
    let missing = call(&rig, "connections/endpoint", json!({ "connectionId": "gone" }), host_ctx()).await;
    assert!(message_of(&missing.expect_err("refused")).contains("not attached"));
}

// ----- reopening the windows -----------------------------------------------------------------------------------------------

#[tokio::test]
async fn the_reopen_setting_and_its_progress_are_answered() {
    let rig = rig().await;
    let state = call(&rig, "connections/restore/get", json!({}), main_ctx()).await.expect("state");
    assert_eq!(state, json!({ "enabled": true }));
    call(&rig, "connections/restore/set", json!({ "enabled": false }), main_ctx()).await.expect("set");
    assert_eq!(call(&rig, "connections/restore/get", json!({}), main_ctx()).await.expect("state"), json!({ "enabled": false }));
    assert_eq!(call(&rig, "connections/restore/progress", json!({}), main_ctx()).await.expect("progress"), json!([]));
}

#[tokio::test]
async fn window_closed_by_user_forgets() {
    let rig = rig().await;
    save_box(&rig).await;
    rig.links.add("box");
    rig.window_restore.remember("box").await.expect("remembered");
    let admit = rig.service.notify(Method(WINDOW_CLOSED), json!({ "connectionId": "box", "byUser": true }), HOST);
    assert!(matches!(admit, Admit::Accepted));
    settle().await;
    assert!(!rig.links.has("box"));
    assert!(rig.window_restore.list().await.expect("listed").is_empty());
}

#[tokio::test]
async fn window_closed_by_quit_detaches_the_link_and_stays_remembered() {
    let rig = rig().await;
    save_box(&rig).await;
    rig.links.add("box");
    rig.window_restore.remember("box").await.expect("remembered");
    rig.service.notify(Method(WINDOW_CLOSED), json!({ "connectionId": "box", "byUser": false }), HOST);
    settle().await;
    assert!(!rig.links.has("box"));
    assert_eq!(rig.window_restore.list().await.expect("listed"), vec!["box".to_owned()]);
    // A malformed notification changes nothing.
    rig.service.notify(Method(WINDOW_CLOSED), json!({ "connectionId": 4 }), HOST);
    settle().await;
}

#[tokio::test]
async fn the_first_presence_of_the_host_reopens_the_remembered_windows() {
    let rig = rig().await;
    save_box(&rig).await;
    rig.window_restore.remember("box").await.expect("remembered");
    rig.service.host_presence(true);
    settle().await;
    assert_eq!(*locked(&rig.links.opened), vec!["box".to_owned()]);
    assert_eq!(*locked(&rig.windows.opened), vec![("box".to_owned(), "Build".to_owned())]);
    // The same host attaching again with its windows still open reopens nothing.
    rig.service.host_presence(false);
    rig.service.host_presence(true);
    settle().await;
    assert_eq!(locked(&rig.links.opened).len(), 1);
}

#[tokio::test(start_paused = true)]
async fn host_absent_grace_closes_links() {
    let rig = rig().await;
    save_box(&rig).await;
    rig.window_restore.remember("box").await.expect("remembered");
    rig.service.host_presence(true);
    settle().await;
    assert!(rig.links.has("box"));
    rig.service.host_presence(false);
    advance(Duration::from_millis(HOST_ABSENT_GRACE_MS - 1_000)).await;
    assert!(rig.links.has("box"), "the links wait out the grace");
    advance(Duration::from_millis(2_000)).await;
    assert!(!rig.links.has("box"));
    assert_eq!(rig.links.close_all.load(Ordering::SeqCst), 1);
    // The windows are remembered, and come back with the host.
    rig.service.host_presence(true);
    settle().await;
    assert!(rig.links.has("box"));
    assert_eq!(locked(&rig.links.opened).len(), 2);
}

#[tokio::test(start_paused = true)]
async fn a_host_that_returns_within_the_grace_keeps_its_links() {
    let rig = rig().await;
    rig.links.add("box");
    rig.service.host_presence(true);
    settle().await;
    rig.service.host_presence(false);
    advance(Duration::from_millis(10_000)).await;
    rig.service.host_presence(true);
    advance(Duration::from_millis(2 * HOST_ABSENT_GRACE_MS)).await;
    assert!(rig.links.has("box"));
    assert_eq!(rig.links.close_all.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn power_events_reach_the_links() {
    let rig = rig().await;
    rig.service.power(PowerEvent::Suspend);
    rig.service.power(PowerEvent::Resume);
    settle().await;
    assert_eq!(*locked(&rig.links.power), vec![PowerEvent::Suspend, PowerEvent::Resume]);
}

#[tokio::test]
async fn dispose_closes_every_link_and_the_logins() {
    let rig = rig().await;
    rig.links.add("box");
    within(rig.service.dispose()).await;
    assert!(!rig.links.has("box"));
    assert_eq!(rig.logins.calls(), vec!["dispose"]);
}

// ----- what follows a link ------------------------------------------------------------------------------------------------

#[tokio::test]
async fn each_attached_link_is_followed_until_it_closes_or_is_replaced() {
    let rig = rig().await;
    let link = rig.links.add("box");
    settle().await;
    assert_eq!(link.watching.load(Ordering::SeqCst), 1);
    // Another change of the pool leaves the watcher alone.
    rig.links.add("other");
    settle().await;
    assert_eq!(link.watching.load(Ordering::SeqCst), 1);
    rig.links.remove("box");
    settle().await;
    assert_eq!(link.watching.load(Ordering::SeqCst), 0);
    // The pool replaced the link: the new one is followed and the old one let go.
    let first = rig.links.link("other");
    rig.links.remove("other");
    let second = rig.links.add("other");
    settle().await;
    assert_eq!((first.watching.load(Ordering::SeqCst), second.watching.load(Ordering::SeqCst)), (0, 1));
}

#[tokio::test]
async fn a_notice_of_a_link_reaches_the_windows_that_view_it() {
    let rig = rig().await;
    let link = rig.links.add("box");
    reply(&rig, "connections/subscribe", json!({}), server_ctx(WINDOW, "box")).await.expect("subscribed");
    reply(&rig, "connections/subscribe", json!({}), main_ctx()).await.expect("subscribed");
    settle().await;
    drop(link.notices.send(ConnectionNotice::ModelSignIn { provider: "openai".to_owned() }));
    settle().await;
    let notices = rig.notifier.of("connections/notice");
    assert_eq!(notices.len(), 1);
    assert_eq!(
        (notices[0].0, notices[0].1.clone()),
        (WINDOW, json!({ "connectionId": "box", "notice": { "kind": "model-sign-in", "provider": "openai" } }))
    );
}

// ----- "Connect to another PC" ---------------------------------------------------------------------------------------------

#[tokio::test]
async fn a_code_saves_the_host_and_answers_the_address_the_window_loads() {
    let rig = rig().await;
    let host = call(&rig, "remoteHosts/redeemCode", json!({ "code": "123456" }), host_ctx()).await.expect("redeemed");
    assert_eq!(*locked(&rig.relay.redeemed), vec![("https://relay.example".to_owned(), "123456".to_owned())]);
    assert_eq!((host["name"].clone(), host["open"].clone()), (json!("Studio PC"), json!(true)));
    // The one-time ticket rides this answer's address only; what is saved has none.
    assert!(host["url"].as_str().expect("an address").ends_with("#pair=tkt"));
    let saved = rig.remote_hosts.list();
    assert_eq!(saved.len(), 1);
    assert!(!saved[0].url.contains('#'));
    assert!(saved[0].url.contains(DEVICE));

    let wrong = call(&rig, "remoteHosts/redeemCode", json!({ "code": "000000" }), host_ctx()).await;
    assert!(!message_of(&wrong.expect_err("refused")).is_empty());
    let malformed = call(&rig, "remoteHosts/redeemCode", json!({ "code": "12" }), host_ctx()).await;
    assert!(message_of(&malformed.expect_err("refused")).contains("6-digit"));
}

#[tokio::test]
async fn saved_hosts_are_listed_renamed_forgotten_and_asked_about() {
    let rig = rig().await;
    call(&rig, "remoteHosts/redeemCode", json!({ "code": "123456" }), host_ctx()).await.expect("redeemed");
    let listed = call(&rig, "remoteHosts/list", json!({}), host_ctx()).await.expect("listed");
    let id = listed[0]["id"].as_str().expect("an id").to_owned();
    assert_eq!((listed[0]["open"].clone(), listed[0]["online"].clone()), (json!(false), Value::Null));

    let renamed = call(&rig, "remoteHosts/rename", json!({ "id": id, "name": "Studio" }), host_ctx()).await.expect("renamed");
    assert_eq!(renamed["name"], json!("Studio"));
    let missing = call(&rig, "remoteHosts/rename", json!({ "id": "nope", "name": "x" }), host_ctx()).await;
    assert!(message_of(&missing.expect_err("refused")).contains("not saved"));

    // Only saved hosts are asked about, and only the ones the relay reports are online.
    let presence = call(&rig, "remoteHosts/presence", json!({ "ids": ["nope", id] }), host_ctx()).await.expect("presence");
    assert_eq!(presence, json!({ "online": [id] }));

    // A window for the saved PC finished loading: its last-connected time is set; an id that is no longer saved changes nothing.
    assert_eq!(rig.remote_hosts.get(&id).expect("saved").last_connected_at, None);
    call(&rig, "remoteHosts/touch", json!({ "id": id }), host_ctx()).await.expect("touched");
    assert!(rig.remote_hosts.get(&id).expect("saved").last_connected_at.is_some());
    call(&rig, "remoteHosts/touch", json!({ "id": "nope" }), host_ctx()).await.expect("an unknown id is not an error");
    let refused = call(&rig, "remoteHosts/touch", json!({ "id": id }), main_ctx()).await;
    assert!(refused.is_err(), "only the host touches");

    call(&rig, "remoteHosts/forget", json!({ "id": id }), host_ctx()).await.expect("forgotten");
    assert!(rig.remote_hosts.list().is_empty());
}
