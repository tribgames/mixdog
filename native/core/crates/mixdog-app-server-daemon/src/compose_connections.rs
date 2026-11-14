//! What the connections service is composed from in mixdogd (CORE-WIRE-G9): this PC's ssh environment (the OpenSSH tools, the
//! files, the diagnostics rings, the askpass helper and the server runtimes the desktop ships), the link pool over it, the adapters
//! the notifier of a server's sessions shows its toasts through, the window host over the claimed desktop, and every module
//! `mixdog-connections` serves `connections/*` and `remoteHosts/*` with.
//!
//! One call builds all of it ([`compose_connections`]); the daemon registers the returned service, hands it to the connection
//! owners (a closed connection cancels its connect attempts and stops viewing a server's ports) and runs [`Connections::stop_step`]
//! at quit. The desktop host's presence ([`PresenceWatch`]) drives the 30 s grace after which the links close and the reopening of the
//! windows that were remembered.

use std::collections::BTreeMap;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, PoisonError};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use async_trait::async_trait;
use mixdog_app_protocol::v2::connections::{WindowFocusEntry, WindowFocusValue};
use mixdog_app_protocol::v2::host::{HostNotificationShowParams, HostNotificationStatus, PowerEvent};
use mixdog_app_server::Outgoing;
use mixdog_connections::host_list_ops::HostList;
use mixdog_connections::attempts::Attempts;
use mixdog_connections::cleanup_ops::{Cleanup, CleanupDeps, EnvCleaner};
use mixdog_connections::connect::{Connect, ConnectDeps, EnvMachine};
use mixdog_connections::diagnostics_ops::{DiagnosticsOps, EnvDiagnostics};
use mixdog_connections::host_store::{SshHostRecord, SshHostStore};
use mixdog_connections::link::{LinkPool, LinkStores};
use mixdog_connections::login::EnvLoginHelpers;
use mixdog_connections::notifier::{AttachmentKind, NotifyPrefs, NotifySink, NotifyTexts, WindowFocusSource};
use mixdog_connections::paths::ConnectionsPaths;
use mixdog_connections::port_forward_store::PortForwardStore;
use mixdog_connections::remote_hosts::RemoteHostStore;
use mixdog_connections::restore::Restore;
use mixdog_connections::server_logins::{ServerLoginStores, ServerLogins};
use mixdog_connections::service::{
    ConnectionsDeps, ConnectionsService, HostChannelWindows, LinkWatchers, NotifierPush, PoolHandle, RelayClient, ServerWindowOpener,
    ServiceProxy, WindowHost, ssh_config_hosts,
};
use mixdog_connections::view::{ConnectionsFeed, ssh_host_view};
use mixdog_connections::window_restore_store::WindowRestoreStore;
use mixdog_core::run_host::process::HostInfo;
use mixdog_core::run_host::run_seams::EnvReader;
use mixdog_core_api::feed::ScopedFeeds;
use mixdog_core_api::host::{HostCapability, HostChannel};
use mixdog_core_api::ids::{ConnectionId, Method};
use mixdog_core_api::state::SectionChange;
use mixdog_core_api::ConnectionNotifier;
use mixdog_core_base::state::SectionFeedState;
use mixdog_core_config::config::Config;
use mixdog_core_domains::domains::ai_admin::model_proxy_service::ModelProxyService;
use mixdog_core_domains::domains::host::PowerSink;
use mixdog_core_domains::notify::audience::pc_view;
use mixdog_core_domains::notify::decision::PreferencesView;
use mixdog_core_domains::notify::engine::{ToastStyle, ToastStyleReader};
use mixdog_protocol::SectionName;
use mixdog_rt::{DurabilityIo, SpawnIo, TaskClass};
use mixdog_spawn::LocalProcessManager;
use mixdog_ssh::bootstrap::{ServerBinary, ServerIdentity, ServerPayloads, StagedPayloads};
use mixdog_ssh::context::{
    ConfigFiles, LaneFiles, Platform, PreparedSpawn, SshConfigFiles, SshEnv, SshSpawner, ToolOutput, ToolRunner,
};
use mixdog_ssh::diagnostics::Diagnostics;
use mixdog_ssh::install_wire::{RemoteBootstrapError, ServerPlatform, SERVER_MANIFEST_FILE};
use mixdog_ssh::mixdog_config::MixdogSshConfig;
use mixdog_ssh::resolved_config::ResolvedConfigs;
use mixdog_ssh::spawn::{ProcessSpawner, MAX_CAPTURE_BYTES};
use mixdog_workspace::service::{RemoteFileReaders, WorkspaceService};
use mixdog_workspace::RemoteFileReader;
use serde_json::json;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWriteExt};
use tokio::task::AbortHandle;

use crate::compose::ComposeError;
use crate::compose_flip::StopStep;
use crate::connection_close::ConnectionOwner;

/// How often the desktop host's presence is looked at: far inside the 30 s grace the service waits before it closes the links.
const PRESENCE_POLL: Duration = Duration::from_secs(1);
/// How long an answer of `host/notification/status` is trusted before the next toast asks again.
const SUPPORT_TTL: Duration = Duration::from_secs(30);
const NOTIFICATION_STATUS: Method = Method("host/notification/status");
const NOTIFICATION_SHOW: Method = Method("host/notification/show");
/// The environment variables the desktop (or a developer) names the server runtimes and the askpass helper with.
const SERVER_CORES_ENV: &str = "MIXDOG_SERVER_CORES_DIR";
const ASKPASS_ENV: &str = "MIXDOG_ASKPASS_HELPER";
const RELAY_ENV: &str = "MIXDOG_RELAY_URL";

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |elapsed| elapsed.as_millis() as u64)
}

// ---------------------------------------------------------------------------------------------
// This PC's ssh environment
// ---------------------------------------------------------------------------------------------

/// Reads at most [`MAX_CAPTURE_BYTES`] of a stream and goes on to its end, so the child never blocks on a full pipe.
async fn read_capped(stream: Option<Box<dyn AsyncRead + Send + Unpin>>) -> Vec<u8> {
    let mut kept = Vec::new();
    let Some(mut stream) = stream else { return kept };
    let mut chunk = vec![0_u8; 64 * 1024];
    loop {
        match stream.read(&mut chunk).await {
            Ok(0) | Err(_) => return kept,
            Ok(count) => {
                if kept.len() < MAX_CAPTURE_BYTES {
                    kept.extend_from_slice(&chunk[..count]);
                }
            }
        }
    }
}

/// The short helpers of OpenSSH (`ssh -G`, `ssh-keygen`, `ssh-add`, `icacls`), started through the one process spawner.
pub struct SpawnedTools {
    spawner: Arc<dyn SshSpawner>,
}

impl SpawnedTools {
    pub fn new(spawner: Arc<dyn SshSpawner>) -> Self {
        Self { spawner }
    }
}

#[async_trait]
impl ToolRunner for SpawnedTools {
    async fn run(&self, command: &Path, args: &[String], timeout: Duration) -> io::Result<ToolOutput> {
        let mut child = self.spawner.spawn(&PreparedSpawn { command: command.to_path_buf(), args: args.to_vec(), env: None })?;
        // The helper reads nothing: its input ends at once.
        if let Some(mut stdin) = child.take_stdin() {
            let _ = stdin.shutdown().await;
        }
        let (stdout, stderr) = (child.take_stdout(), child.take_stderr());
        let finished = mixdog_rt::time::timeout(timeout, async {
            let (stdout, stderr) = futures::future::join(read_capped(stdout), read_capped(stderr)).await;
            let exit = child.wait().await;
            (stdout, stderr, exit)
        })
        .await;
        match finished {
            Ok((stdout, stderr, exit)) => Ok(ToolOutput {
                exit_code: exit?.code,
                stdout: String::from_utf8_lossy(&stdout).into_owned(),
                stderr: String::from_utf8_lossy(&stderr).into_owned(),
            }),
            Err(_) => {
                child.kill();
                Err(io::Error::new(io::ErrorKind::TimedOut, format!("{} did not finish in {} ms", command.display(), timeout.as_millis())))
            }
        }
    }
}

/// What `MixdogSshConfig::configure` is given before Mixdog's own config exists: it asks for no config file.
struct NoConfigFiles;

impl SshConfigFiles for NoConfigFiles {
    fn for_args(&self, _args: &[String]) -> Option<PathBuf> {
        None
    }

    fn generic(&self) -> Option<PathBuf> {
        None
    }
}

/// The server runtimes the desktop ships, read from `SshEnv::server_cores_dir` when an install first needs them (a desktop that ships
/// none reports `local-payload` on every attempt, as the earlier desktop did, and reads the folder again on the next one).
pub struct LocalPayloads {
    env: SshEnv,
    staged: std::sync::OnceLock<StagedPayloads<'static, mixdog_fsio::Unlaned>>,
    /// What [`ServerPayloads::identity`] answers while nothing is staged: it matches no server's build.
    absent: ServerIdentity,
}

impl LocalPayloads {
    pub fn new(env: SshEnv) -> Self {
        Self { env, staged: std::sync::OnceLock::new(), absent: ServerIdentity { version: String::new(), build: String::new() } }
    }

    fn staged(&self) -> Result<&StagedPayloads<'static, mixdog_fsio::Unlaned>, RemoteBootstrapError> {
        if let Some(staged) = self.staged.get() {
            return Ok(staged);
        }
        let opened = StagedPayloads::open(&mixdog_fsio::Unlaned, &self.env)?;
        Ok(self.staged.get_or_init(|| opened))
    }
}

impl ServerPayloads for LocalPayloads {
    fn identity(&self) -> &ServerIdentity {
        self.staged().map_or(&self.absent, ServerPayloads::identity)
    }

    fn binary(&self, platform: ServerPlatform) -> Result<ServerBinary, RemoteBootstrapError> {
        self.staged()?.binary(platform)
    }
}

/// `MIXDOG_ASKPASS_HELPER`, else the `mixdog-askpass` the build puts beside `mixdogd`; `None` where neither is a file.
fn askpass_helper(env: &dyn Fn(&str) -> Option<String>, exe_dir: Option<&Path>, files: &dyn ConfigFiles) -> Option<PathBuf> {
    let named = env(ASKPASS_ENV).filter(|value| !value.is_empty()).map(PathBuf::from);
    let beside = exe_dir.map(|dir| dir.join(if cfg!(windows) { "mixdog-askpass.exe" } else { "mixdog-askpass" }));
    named.into_iter().chain(beside).find(|path| files.is_file(path))
}

/// `MIXDOG_SERVER_CORES_DIR`, else the `server-cores` folder beside the core's own (`resources/server-cores` of the packaged app,
/// `.runtime/server-cores` of a source checkout) when it holds the release manifest.
fn server_cores_dir(env: &dyn Fn(&str) -> Option<String>, exe_dir: Option<&Path>, files: &dyn ConfigFiles) -> Option<PathBuf> {
    if let Some(named) = env(SERVER_CORES_ENV).filter(|value| !value.is_empty()) {
        return Some(PathBuf::from(named));
    }
    let staged = exe_dir?.parent()?.join("server-cores");
    files.is_file(&staged.join(SERVER_MANIFEST_FILE)).then_some(staged)
}

/// The machine the ssh code runs on, and the generated ssh configs it resolves targets into.
pub struct SshMachineParts {
    pub env: SshEnv,
    pub configs: Arc<ResolvedConfigs>,
}

/// This PC as the ssh code sees it: the process's environment, `home`, the OpenSSH tools through `processes`, Mixdog's own ssh
/// config in `data_dir` (the core's data folder), the askpass helper and the server runtimes the desktop ships.
pub async fn ssh_machine(home: PathBuf, data_dir: PathBuf, env: &(dyn Fn(&str) -> Option<String> + Send + Sync), processes: LocalProcessManager, spawn_io: SpawnIo) -> Result<SshMachineParts, ComposeError> {
    let spawner: Arc<dyn SshSpawner> = Arc::new(ProcessSpawner::new(Arc::new(processes), spawn_io));
    let files: Arc<dyn ConfigFiles + Send + Sync> = Arc::new(LaneFiles(&mixdog_fsio::Unlaned));
    let exe_dir = std::env::current_exe().ok().and_then(|exe| exe.parent().map(Path::to_path_buf));
    let mut vars: BTreeMap<String, String> = std::env::vars_os().filter_map(|(name, value)| Some((name.into_string().ok()?, value.into_string().ok()?))).collect();
    // Mixdog's own ssh files live in the data folder this core was composed over, whatever the process environment says.
    vars.insert("MIXDOG_DATA_DIR".to_owned(), data_dir.to_string_lossy().into_owned());
    let before = SshEnv {
        platform: Platform::current(),
        env: vars,
        home,
        askpass_helper: askpass_helper(env, exe_dir.as_deref(), files.as_ref()),
        server_cores_dir: server_cores_dir(env, exe_dir.as_deref(), files.as_ref()),
        files,
        config_files: Arc::new(NoConfigFiles),
        tools: Arc::new(SpawnedTools::new(spawner.clone())),
        spawner,
        diagnostics: Arc::new(Diagnostics::new()),
    };
    let config = MixdogSshConfig::configure(&before)
        .await
        .map_err(|error| ComposeError::Remote(format!("the ssh configuration folder could not be prepared: {error}")))?;
    let configs = ResolvedConfigs::new(config);
    Ok(SshMachineParts { env: SshEnv { config_files: configs.clone(), ..before }, configs })
}

// ---------------------------------------------------------------------------------------------
// The notifier of a server's sessions
// ---------------------------------------------------------------------------------------------

/// Toasts of a server window, shown by the desktop host this PC's own toasts are shown by (`host/notification/show`), with the sound
/// and volume of this PC's own, so a server's toast sounds like any other.
pub struct HostToasts {
    host: Arc<dyn HostChannel>,
    style: ToastStyleReader,
    /// When the host last said whether it can show toasts, and what it said (true until it has said).
    supported: Arc<Mutex<(Option<std::time::Instant>, bool)>>,
}

impl HostToasts {
    pub fn new(host: Arc<dyn HostChannel>, style: ToastStyleReader) -> Self {
        Self { host, style, supported: Arc::new(Mutex::new((None, true))) }
    }
}

impl NotifySink for HostToasts {
    /// The last answer of the host (`notificationStatus.supported`), asked again off this call when it is older than [`SUPPORT_TTL`]: a
    /// host that cannot be asked cannot show a toast either.
    fn supported(&self) -> bool {
        let mut known = self.supported.lock().unwrap_or_else(PoisonError::into_inner);
        let stale = known.0.is_none_or(|at| at.elapsed() >= SUPPORT_TTL);
        if stale {
            // Claimed now, so a burst of toasts asks once.
            known.0 = Some(std::time::Instant::now());
            let (host, cell) = (self.host.clone(), self.supported.clone());
            drop(mixdog_rt::spawn("connections-notify-status", TaskClass::Control, async move {
                let answer = host.request(HostCapability::Notifications, NOTIFICATION_STATUS, json!({})).await;
                let supported = answer.ok().and_then(|value| serde_json::from_value::<HostNotificationStatus>(value).ok()).is_some_and(|status| status.supported);
                cell.lock().unwrap_or_else(PoisonError::into_inner).1 = supported;
            }));
        }
        known.1
    }

    fn show(&self, mut params: HostNotificationShowParams) -> Result<(), String> {
        // A toast carries this PC's sound only where the notifier asked for one (a session's final answer).
        let style = (self.style)();
        if params.sound.is_some() {
            params.sound = style.sound;
            params.volume = Some(style.volume);
        } else {
            params.sound = None;
            params.volume = None;
        }
        let params = serde_json::to_value(params).map_err(|error| error.to_string())?;
        self.host.notify(HostCapability::Notifications, NOTIFICATION_SHOW, params).map_err(|error| error.to_string())
    }

    /// The toasts still showing for a server's connection are closed (its notifier ended).
    fn close(&self, connection_id: &str) {
        let _ = self.host.notify(HostCapability::Notifications, Method("host/notification/close"), json!({ "connectionId": connection_id }));
    }
}

/// This PC's notification preferences: the config the `notify` domain reads for this PC (`Audience::pc`).
pub struct PcPreferences(pub Config);

impl NotifyPrefs for PcPreferences {
    fn view(&self) -> Result<PreferencesView, String> {
        Ok(pc_view(&self.0))
    }
}

/// What the desktop host last reported in `host/state/set` key `windowFocus`, read where the host state is kept.
pub struct HostWindowFocus {
    read: Arc<dyn Fn() -> Option<WindowFocusValue> + Send + Sync>,
}

impl HostWindowFocus {
    pub fn new(read: Arc<dyn Fn() -> Option<WindowFocusValue> + Send + Sync>) -> Self {
        Self { read }
    }

    /// Over the app feed's sections: the `windowFocus` value of the host state.
    pub fn over_sections(sections: Arc<SectionFeedState>) -> Self {
        Self::new(Arc::new(move || match sections.current(SectionName::HostState, Some("windowFocus"))?.1 {
            SectionChange::Set(bytes) => serde_json::from_slice(&bytes).ok(),
            SectionChange::Stub { .. } | SectionChange::Removed => None,
        }))
    }

    fn window(&self, connection_id: &str) -> Option<WindowFocusEntry> {
        (self.read)()?.windows.into_iter().find(|window| window.connection_id == connection_id)
    }
}

impl WindowFocusSource for HostWindowFocus {
    fn is_foreground(&self, connection_id: &str) -> bool {
        self.window(connection_id).is_some_and(|window| window.visible && window.focused)
    }

    fn session_on_screen(&self, connection_id: &str, session_id: &str) -> bool {
        self.window(connection_id).is_some_and(|window| window.visible && window.focused && window.session_ids.iter().any(|id| id == session_id))
    }
}

/// The fixed texts of a server's notifications. The core has no UI language of its own: these are the English words, which the
/// desktop's host puts in this PC's language where it shows the toast (`host/notification/show`).
pub struct EnglishTexts;

impl NotifyTexts for EnglishTexts {
    fn approval_waiting(&self) -> String {
        "A tool is waiting for your approval.".to_owned()
    }

    fn turn_failed(&self) -> String {
        "The turn stopped with an error.".to_owned()
    }

    fn lost_title(&self) -> String {
        "Connection to {{name}} lost".to_owned()
    }

    fn lost_reconnecting(&self) -> String {
        "Mixdog is reconnecting automatically.".to_owned()
    }

    fn lost_stopped(&self) -> String {
        "Open the server window to reconnect.".to_owned()
    }

    fn restored_title(&self) -> String {
        "Reconnected to {{name}}".to_owned()
    }

    fn restored_body(&self) -> String {
        "The server window is working again.".to_owned()
    }

    fn attachment_label(&self, kind: AttachmentKind) -> String {
        match kind {
            AttachmentKind::Image => "Image",
            AttachmentKind::Video => "Video",
            AttachmentKind::File => "File",
        }
        .to_owned()
    }
}

// ---------------------------------------------------------------------------------------------
// The desktop host's presence, files of a server
// ---------------------------------------------------------------------------------------------

/// Turns the samples of "a desktop serves windows" into the changes the service is told of.
#[derive(Default)]
pub struct PresenceWatch {
    last: bool,
}

impl PresenceWatch {
    /// `Some(present)` when the sample differs from the one before; nothing at the first sample of an absent host.
    pub fn sample(&mut self, present: bool) -> Option<bool> {
        (std::mem::replace(&mut self.last, present) != present).then_some(present)
    }
}

/// Where `host/power` reaches the connections service, which is composed after the domain services that take the power sink: the
/// links pause when this PC sleeps and are probed when it wakes.
#[derive(Default)]
pub struct LateConnectionsPower(std::sync::OnceLock<Arc<ConnectionsService>>);

impl LateConnectionsPower {
    /// Binds the service once it exists; a second bind is refused.
    pub fn bind(&self, service: Arc<ConnectionsService>) -> Result<(), Arc<ConnectionsService>> {
        self.0.set(service)
    }
}

impl PowerSink for LateConnectionsPower {
    fn power(&self, event: PowerEvent) {
        if let Some(service) = self.0.get() {
            service.power(event);
        }
    }
}

/// Every sink `host/power` goes to, in order.
pub struct PowerSinks(pub Vec<Arc<dyn PowerSink>>);

impl PowerSink for PowerSinks {
    fn power(&self, event: PowerEvent) {
        for sink in &self.0 {
            sink.power(event);
        }
    }
}

/// The files of the servers this PC is connected to, for "download to this PC".
struct PoolFiles(LinkPool);

impl RemoteFileReaders for PoolFiles {
    fn reader(&self, server_id: &str) -> Option<Arc<dyn RemoteFileReader>> {
        self.0.reader(server_id)
    }
}

// ---------------------------------------------------------------------------------------------
// The composition
// ---------------------------------------------------------------------------------------------

/// What the composition reads from the daemon.
pub struct ConnectionsInputs {
    /// The user's home folder (`~/.ssh`).
    pub home: PathBuf,
    /// The core's data folder: Mixdog's own ssh config and known_hosts live in its `ssh` folder.
    pub data_dir: PathBuf,
    /// The desktop's profile folder: the saved servers, the reopening list and the saved computers live in it.
    pub user_data_dir: PathBuf,
    pub env: EnvReader,
    pub config: Config,
    pub processes: LocalProcessManager,
    pub spawn_io: SpawnIo,
    pub durability_io: DurabilityIo,
    pub host: Arc<dyn HostChannel>,
    /// The connection table: the version a connection announced in its `initialize`.
    pub outgoing: Arc<Outgoing>,
    pub notifier: Arc<dyn ConnectionNotifier>,
    pub scoped_feeds: Arc<dyn ScopedFeeds>,
    pub sections: Arc<SectionFeedState>,
    /// The service `modelProxy/run` is: the server links run their server's proxied model calls through it.
    pub model_proxy: Arc<ModelProxyService>,
    /// Where the servers' files are read for a download to this PC.
    pub workspace: Arc<WorkspaceService>,
}

/// The composed connections service and what follows the desktop host's presence.
pub struct Connections {
    service: Arc<ConnectionsService>,
    presence: AbortHandle,
}

impl Connections {
    /// The service to register (`connections/*`, `remoteHosts/*`, `host/window/closed`) and to hand to the connection owners.
    pub fn service(&self) -> &Arc<ConnectionsService> {
        &self.service
    }

    /// The stop step: the presence watch ends, the logins on servers are disposed and every link closes.
    pub fn stop_step(&self) -> StopStep {
        let (service, presence) = (self.service.clone(), self.presence.clone());
        ("connections", Box::pin(async move {
            presence.abort();
            service.dispose().await;
        }))
    }
}

impl ConnectionOwner for ConnectionsService {
    /// The connect attempts of the connection are cancelled, its questions answered with nothing and its view of a server's ports ends.
    fn connection_closed(&self, connection: ConnectionId) {
        ConnectionsService::connection_closed(self, connection);
    }
}

/// Builds the link pool and every module over it, starts the service, and gives the workspace the readers of the servers' files.
pub async fn compose_connections(inputs: ConnectionsInputs) -> Result<Connections, ComposeError> {
    let ConnectionsInputs { home, data_dir, user_data_dir, env, config, processes, spawn_io, durability_io, host, outgoing, notifier, scoped_feeds, sections, model_proxy, workspace } = inputs;
    let machine = ssh_machine(home, data_dir, &*env, processes, spawn_io).await?;
    let (ssh_env, configs) = (machine.env, machine.configs);
    let payloads: Arc<LocalPayloads> = Arc::new(LocalPayloads::new(ssh_env.clone()));

    let paths = ConnectionsPaths::new(user_data_dir.clone());
    let hosts = Arc::new(SshHostStore::load(&paths, durability_io).await);
    let remote_hosts = Arc::new(RemoteHostStore::load(&paths, durability_io).await);
    let window_restore = Arc::new(WindowRestoreStore::new(&paths, durability_io));
    let port_forwards = Arc::new(PortForwardStore::new(&paths, durability_io));

    // The windows go through the host that claimed them; the pool's links announce every open and close, and the connection's links
    // are the ones a closed window takes along.
    let windows: Arc<dyn WindowHost> = Arc::new(HostChannelWindows::new(host.clone()));
    let link_pool = LinkPool::new(
        ssh_env.clone(),
        LinkStores { hosts: hosts.clone(), port_forwards, payloads: payloads.clone(), host: host.clone() },
        Arc::new(ServiceProxy(model_proxy)),
    );
    let style: ToastStyleReader = {
        let config = config.clone();
        Arc::new(move || ToastStyle::for_volume(config.desktop_settings().notification_volume))
    };
    let watchers = LinkWatchers {
        sink: Arc::new(HostToasts::new(host.clone(), style)),
        prefs: Arc::new(PcPreferences(config)),
        focus: Arc::new(HostWindowFocus::over_sections(sections)),
        texts: Arc::new(EnglishTexts),
    };
    let pool = Arc::new(PoolHandle::new(link_pool, windows.clone(), watchers));
    workspace.set_remote_files(Arc::new(PoolFiles(pool.pool().clone())));

    let ssh_env = Arc::new(ssh_env);
    let login = Arc::new(EnvLoginHelpers::new(ssh_env.clone(), durability_io, user_data_dir, Arc::new(mixdog_ssh::context::ClaimedResources::default())));
    let opener = Arc::new(ServerWindowOpener::new(windows.clone(), window_restore.clone()));
    let attempts = Attempts::new(pool.clone(), Arc::new(NotifierPush(notifier.clone())));
    let view_pool = pool.pool().clone();
    let connect = Arc::new(Connect::new(ConnectDeps {
        attempts: attempts.clone(),
        machine: Arc::new(EnvMachine { env: ssh_env.clone(), configs }),
        login: login.clone(),
        hosts: hosts.clone(),
        windows: opener,
        view: Arc::new(move |record: &SshHostRecord| ssh_host_view(record, view_pool.get(&record.id).is_some())),
        clock: Arc::new(now_ms),
    }));
    let cleanup = Arc::new(Cleanup::new(CleanupDeps {
        hosts: hosts.clone(),
        attempts,
        cleaner: Arc::new(EnvCleaner { env: ssh_env.clone(), payloads }),
        login,
    }));
    let os_release = HostInfo::current().map(|info| info.os_release).unwrap_or_default();
    let diagnostics = Arc::new(DiagnosticsOps::new(hosts.clone(), Arc::new(EnvDiagnostics { env: ssh_env.clone(), os_release })));
    let host_list = Arc::new(HostList::new(hosts.clone(), pool.clone()));
    let logins = Arc::new(ServerLogins::new(pool.pool().clone(), ServerLoginStores { hosts: hosts.clone() }, (*ssh_env).clone()));
    let restore = Arc::new(Restore::new(window_restore.clone(), hosts.clone()));
    let feed = Arc::new(ConnectionsFeed::start(scoped_feeds, Arc::new(pool.pool().clone()), hosts.clone(), window_restore.clone(), &restore));

    let (relay_env, version_of, hosts_env) = (env.clone(), outgoing, ssh_env.clone());
    let service = Arc::new(ConnectionsService::new(ConnectionsDeps {
        hosts,
        remote_hosts,
        window_restore,
        links: pool,
        connect,
        cleanup,
        diagnostics,
        host_list,
        logins,
        restore,
        feed,
        windows,
        notifier,
        relay: Arc::new(RelayClient),
        relay_url: Arc::new(move || crate::domain_seams::remote::resolve_relay_url(relay_env(RELAY_ENV).as_deref()).ok().flatten()),
        config_hosts: Arc::new(move || ssh_config_hosts(&hosts_env)),
        client_version: Arc::new(move |connection| version_of.client_version(connection)),
        // The pair-code errors in the desktop's UI language: the catalogs are not read by the core yet (deferred-g95.md), so the English text.
        translate: Arc::new(|text| text.to_owned()),
    }));
    let presence = watch_presence(service.clone(), host);
    Ok(Connections { service, presence })
}

/// Tells the service when a desktop that serves windows attaches or goes: it closes the links after the grace, and reopens the
/// windows remembered when the desktop is back.
fn watch_presence(service: Arc<ConnectionsService>, host: Arc<dyn HostChannel>) -> AbortHandle {
    mixdog_rt::spawn("connections-host-presence", TaskClass::Control, presence_loop(service, host)).abort_handle()
}

/// Has no end of its own: the stop step aborts it.
async fn presence_loop(service: Arc<ConnectionsService>, host: Arc<dyn HostChannel>) {
    let mut watch = PresenceWatch::default();
    loop {
        if let Some(present) = watch.sample(host.serves(HostCapability::Windows)) {
            service.host_presence(present);
        }
        // Not a timer the replay's clock waits for.
        mixdog_rt::time::sleep_unrefed(PRESENCE_POLL).await;
    }
}

#[cfg(test)]
#[path = "compose_connections_tests.rs"]
mod tests;
