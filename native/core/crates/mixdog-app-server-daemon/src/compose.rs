//! The composition root: builds the [`CoreHandle`] the server serves (protocol.md §2.1).
//!
//! [`compose`] opens the state store, the feeds and the process-level services, hands them to
//! [`crate::compose_flip::real_core`] (the session directory, every domain service and the late cells),
//! and wraps what it returns in [`ComposedCore`]. A method no service claims is a start-up error
//! (`ComposeError::Unclaimed`), and a late cell left unbound is another (`ComposeError::Unbound`,
//! checked before the listener accepts): nothing answers in place of a service.

use std::path::Path;
use std::path::PathBuf;
use std::sync::Arc;

use mixdog_core_base::feed::CoreScopedFeeds;
use mixdog_services::effort_judge::judge::EffortJudgeModel;
use mixdog_services::effort_judge::judge::JudgeOptions;
use mixdog_services::effort_judge::JudgeTiming;
use mixdog_services::effort_judge::model::{ModelConfig, OrtRuntime};
use mixdog_services::memory::embed::config::DEFAULT_MODEL_ID;
use mixdog_services::memory::embed::engine::EmbedConfig;
use mixdog_services::memory::embed::provider::EmbeddingProvider;
use mixdog_services::tidy::process::Processes;
use mixdog_services::tool_state::StateTick;
use mixdog_core_api::domain::fs::FileService;
use mixdog_exthost::DEFAULT_PENDING_CAP;
use mixdog_workspace::localfs::LocalFileService;
use mixdog_exthost::ExtHostConfig;
use mixdog_exthost::ExtHostError;
use mixdog_exthost::ExtHostPool;
use mixdog_exthost::RenderBrowserConfig;
use mixdog_exthost::worker_count;
use mixdog_mcp::launcher::SkillRuntime;
use mixdog_tools::exec::SkillRuntime as ExecSkillRuntime;
use mixdog_core_api::domain::process::ProcessManager;
use mixdog_core_api::feed::ScopedFeeds;
use mixdog_spawn::LocalProcessManager;
use mixdog_spawn::ProcessConfig;

use crate::catalog::CatalogError;
use crate::catalog::CatalogHost;
use crate::catalog::build_catalog;
use crate::domain_seams::settings_effects::ConfiguredShell;
use crate::exec::Exec;
use crate::exec::build_exec;
use mixdog_core_base::ops::CoreOpIndex;
use mixdog_core_base::ops::OpGate;
use mixdog_core_base::ops::StateOpStore;
use mixdog_core_api::CoreError;
use mixdog_core_api::ops::OpScope;
use mixdog_store::sqlite::DbError;
use mixdog_store::state::CoreState;

use mixdog_core_domains::domains::DomainsError;
use mixdog_app_protocol::v2::host::CoreDrainParams;
use mixdog_core_base::feed::CoreFeed;
use mixdog_core_base::feed::FeedLimits;
use mixdog_core_base::state::empty_view;
use mixdog_core_api::CoreHandle;
use mixdog_core_api::ids::FeedEpoch;
use mixdog_core_api::ids::FeedId;
use mixdog_rt::LaneTokens;
use crate::lifecycle::new_instance_id;
use mixdog_core_api::CoreState as LifecycleState;
use mixdog_core_api::DomainService;
use mixdog_core_api::FeedSource;
use mixdog_app_protocol::limits::Limits;
use mixdog_app_server::HostMedia;
use mixdog_core_api::HostMediaSink;
use mixdog_core_api::OpIndex;
use mixdog_core_api::ThreadDirectory;
use tokio::sync::watch;

/// The app feed's ring (SPEC §3.1: 1 MiB for the app feed, 4 MiB per thread feed).
const APP_RING_BYTES: usize = 1 << 20;
/// `maxSnapshotBytes` (SPEC §3.1).
const MAX_SNAPSHOT_BYTES: usize = 3 << 20;

/// The non-thread op scopes (protocol §9.2); each has a gate over its rows in state/core.sqlite.
pub(crate) const OP_SCOPES: [&str; 22] = [
    "config", "account", "agent", "project", "media", "channel", "mcp", "skills", "plugins",
    "localProvider", "terminal", "git", "remoteAccess", "core", "workflow", "notify", "room", "thread",
    "update", "diagnostics", "feedback", "instructions",
];

#[derive(Debug, thiserror::Error)]
pub enum ComposeError {
    #[error("opening the session catalog index: {0}")]
    CatalogIndex(String),
    #[error("resolving the OpenAI OAuth credential file: {0}")]
    AccountFile(String),
    #[error("starting the core folder watcher: {0}")]
    Watcher(String),
    #[error("starting the memory stack: {0}")]
    MemoryRuntime(String),
    #[error("starting the provider catalog: {0}")]
    Catalog(CatalogError),
    #[error("writing the skill launchers: {0}")]
    Launcher(std::io::Error),
    #[error("resolving the default shell: {0}")]
    Shell(std::io::Error),
    #[error("preparing the effort judge model: {0}")]
    EffortJudge(mixdog_services::model_install::InstallError),
    #[error("starting the extension host: {0}")]
    ExtHost(ExtHostError),
    /// Table methods no composed service claims: the core serves nothing in their place (no mock stands in for them).
    #[error("table methods no service claims: {methods:?}")]
    Unclaimed { methods: Vec<&'static str> },
    /// Opening the rooms at start (the interrupted-exchange recover).
    #[error("starting the rooms: {0}")]
    Rooms(String),
    // The failures of `compose_flip::real_core`, one per stage that can fail; each carries its own typed error.
    #[error("{0}")]
    Config(String),
    #[error("no home directory")]
    NoHome,
    #[error("reading the voice runtime manifest: {0}")]
    VoiceManifest(String),
    #[error("the {0} was bound twice")]
    AlreadyBound(&'static str),
    #[error("composing the domain services: {0}")]
    ComposeDomains(crate::compose_domains::ComposeDomainsError),
    #[error("starting the process services: {0}")]
    Process(std::io::Error),
    #[error("starting remote access: {0}")]
    Remote(String),
    #[error("reading the channels' webhook configuration: {0}")]
    Channels(String),
    #[error("settling the stale agent workers: {0}")]
    AgentRecover(String),
    #[error("loading the providers of the config: {0}")]
    Providers(String),
    #[error("opening the quota resume store: {0}")]
    QuotaResume(mixdog_core_base::quota_resume::QuotaError),
    #[error("opening the prompt-cache warm store: {0}")]
    WarmStore(std::io::Error),
    #[error("{0}")]
    SurfaceVariant(mixdog_core::run_host::agent_variants::VariantError),
    #[error("building the session directory: {0}")]
    TurnPath(mixdog_core::run_host::turn_path::TurnPathError),
    #[error("starting the workspace service: {0:?}")]
    Workspace(mixdog_workspace::error::WsError),
    #[error(transparent)]
    Domains(#[from] DomainsError),
    #[error("the {cell} was not bound before the server accepted connections")]
    Unbound { cell: &'static str },
    #[error("creating the state directory: {0}")]
    StateDir(std::io::Error),
    #[error("opening state/core.sqlite: {0:?}")]
    State(DbError),
    #[error("opening the op gate of `{scope}`: {error:?}")]
    OpGate { scope: &'static str, error: CoreError },
}

/// Startup check of the late cells: every one bound, or `ComposeError::Unbound` naming the first that
/// is not. Compose runs it once the directory and the seams that wait for it are bound;
/// `serving::start` runs it for the local dialer before the listener accepts.
pub fn verify_bound(cells: &[&dyn mixdog_core::run_host::late::Bound]) -> Result<(), ComposeError> {
    mixdog_core::run_host::late::require(cells).map_err(|unbound| ComposeError::Unbound { cell: unbound.cell })
}
/// Why the core is stopping, as Node words it; written once ([`ComposedCore::set_stop_reason`]).
#[derive(Default)]
pub struct StopReasonCell(std::sync::OnceLock<String>);

impl StopReasonCell {
    /// `None` only before the release (or a `stop`) has said why.
    pub fn get(&self) -> Option<&str> {
        self.0.get().map(String::as_str)
    }
}

pub struct ComposedCore {
    /// What the real composition built: the session directory, the domain services, the late cells and what the stop procedure holds.
    real: crate::compose_flip::Real,
    /// The core's state as the lifecycle publishes it (`serving::start` follows the lifecycle into it); the admission of a request reads it.
    state: watch::Sender<LifecycleState>,
    /// The real [HostMediaSink]; the browser view binds its stream targets here.
    host_media: Arc<HostMedia>,
    app_feed: Arc<CoreFeed>,
    /// The app feed's one section state, built here: `serving::start` takes it (a second one over the same feed would split the lifecycle's sections
    /// from the session deletion's notifications), and the real core's `SessionDeletion` holds it.
    sections: Arc<mixdog_core_base::state::SectionFeedState>,
    /// Every scoped feed a service created, found by id for `feed/subscribe`.
    feed_index: Arc<CoreScopedFeeds>,
    ops: CoreOpIndex,
    exec: Exec,
    ext_host: Arc<ExtHostPool>,
    file_service: Arc<dyn FileService>,
    catalog: CatalogHost,
    tidy_processes: Processes,
    /// The concrete manager behind `processes`/`tidy_processes` (it is `Clone`): the process and terminal services take it by value.
    local_processes: LocalProcessManager,
    /// The one shell registry and kill route of the process (exec.runtime).
    shell_control: Arc<mixdog_tools::exec::ShellControl>,
    stop_steps: StopSteps,
    final_barriers: std::sync::Mutex<Vec<(&'static str, crate::lifecycle::Hook)>>,
    /// The daemon log and the run token it holds: the stop procedure flushes the one, then cancels the other.
    log: crate::daemon_log::DaemonLog,
    stop: tokio_util::sync::CancellationToken,
    /// Node's text of why the core is stopping (`daemon.mjs:272` `shutdown(reason)`), set once by the release before its first step; the stop steps read it.
    stop_reason: Arc<StopReasonCell>,
    /// Replay-only: the service of `replay/storesSettled`.
    #[cfg(feature = "replay-controls")]
    stores_settled: crate::replay_stores_settled::StoresSettled,
}

type StopStep = std::pin::Pin<Box<dyn Future<Output = ()> + Send>>;

/// The ordered stop steps and the one run of them in progress. A stop that overlaps one in progress awaits that same run (Node's
/// `SessionHost.dispose` hands every caller the one `disposePromise`, `apps/desktop/src/main/session-host.ts:1209-1210`): it never
/// returns before the cleanup has ended, and nothing runs twice. Pinned by `tests::overlapping_stops_wait_for_the_same_cleanup_as_node_recorded`
/// (below, with the real core) and the desktop's `session-host-lifecycle-replay.test.mjs`. A call after a run has ended runs only the steps registered since.
#[derive(Default)]
pub(crate) struct StopSteps {
    steps: std::sync::Mutex<Vec<(&'static str, StopStep)>>,
    running: std::sync::Mutex<Option<futures::future::Shared<futures::future::BoxFuture<'static, ()>>>>,
}

impl StopSteps {
    pub(crate) fn push(&self, name: &'static str, step: StopStep) {
        self.steps.lock().unwrap_or_else(std::sync::PoisonError::into_inner).push((name, step));
    }

    pub(crate) async fn run(&self) {
        use futures::FutureExt;
        let run = {
            let mut running = self.running.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
            match running.as_ref() {
                Some(run) if run.peek().is_none() => run.clone(),
                _ => {
                    let steps = std::mem::take(&mut *self.steps.lock().unwrap_or_else(std::sync::PoisonError::into_inner));
                    let run = async move {
                        for (name, step) in steps {
                            tracing::debug!(step = name, "stopping");
                            step.await;
                        }
                    }
                    .boxed()
                    .shared();
                    *running = Some(run.clone());
                    run
                }
            }
        };
        run.await;
    }
}

#[allow(clippy::disallowed_methods, reason = "runs as a durability-lane job")]
pub(crate) async fn create_dir(tokens: &LaneTokens, path: PathBuf) -> std::io::Result<()> {
    use mixdog_rt::LaneToken;
    let job = tokens
        .durability_io
        .submit(&tokio_util::sync::CancellationToken::new(), move |_lane| std::fs::create_dir_all(path))
        .map_err(|_| std::io::Error::other("the durability lane is full"))?;
    job.await.map_err(std::io::Error::other)?
}

/// Node's `process.platform` of this host.
fn node_platform() -> &'static str {
    if cfg!(windows) {
        "win32"
    } else if cfg!(target_os = "macos") {
        "darwin"
    } else {
        "linux"
    }
}

/// The local models whose status the tool-modules section reports. One `StateTick` is shared, so
/// a change to either bumps the same counter the section publisher watches.
pub struct Models {
    pub tick: StateTick,
    /// Unbuilt only where onnxruntime ships no binding (`OrtRuntime::NoBinding`), as Node has none there.
    pub embeddings: Option<Arc<EmbeddingProvider>>,
    pub effort_judge: Arc<EffortJudgeModel>,
}

/// Graph sessions the embedder keeps so concurrent embeds do not queue on one another.
const EMBED_SESSIONS: usize = 2;

pub(crate) fn build_models(tokens: &LaneTokens, data_dir: &Path, ort_library: OrtRuntime) -> Result<Models, ComposeError> {
    let tick = StateTick::default();
    let embeddings = match &ort_library {
        OrtRuntime::Library(library) => Some(Arc::new(EmbeddingProvider::with_tick(
        EmbedConfig {
            model_id: DEFAULT_MODEL_ID.into(),
            cache_dir: data_dir.join("models"),
            ort_library: library.clone(),
            dtype: None,
            sessions: EMBED_SESSIONS,
            lane: tokens.cpu_bulk,
        },
        tick.clone(),
        ))),
        OrtRuntime::NoBinding => None,
    };
    let effort_judge = EffortJudgeModel::with_options(
        ModelConfig::in_data_dir(data_dir, ort_library),
        mixdog_services::effort_judge::JudgeLanes::of(tokens),
        // A step's judgment waits as a turn's: Node's step path calls `judgeTurn` too.
        JudgeOptions { tick: tick.clone(), manifest: None, progress: None, timing: JudgeTiming::from_env(&|name| std::env::var(name).ok()) },
    )
    .map_err(ComposeError::EffortJudge)?;
    Ok(Models { tick, embeddings, effort_judge })
}

/// What Node's process `exit` hooks write before the process ends (`flushGatewayUsageEventsSync` in `route-meta.mjs`, `flushDaemonLogsSync`
/// in `daemon.mjs`): the last gateway usage batch, then the queued log tail. The release procedure calls it on every path, a stuck step included.
pub(crate) async fn flush_at_exit(log: &crate::daemon_log::DaemonLog, usage: &mixdog_core_session::session::gateway_usage::GatewayUsage) {
    // `agent-trace-io.mjs` registers its `exit` hook (`_flushToolFailuresSync`) when it is first imported, ahead of the others.
    mixdog_core_run::run_host::failure_log::flush_all().await;
    usage.flush_final().await;
    log.flush().await;
}

impl ComposedCore {
    /// How this start's desktop defaults separation ended (the `initialize` reply's `defaultsSeparation`).
    pub fn defaults_separation(&self) -> mixdog_app_protocol::v1::DefaultsSeparation {
        self.real.defaults_separation.clone()
    }

    /// Whether the relay this core's leg is on delivers native pushes now: Node offered `nativePush` to a phone connection
    /// only then (`remote-relay.ts:525` `caps.relayNativePlatforms().length > 0`, `remote-relay-client-lifecycle.ts:150`).
    pub fn native_push_offered(&self) -> std::sync::Arc<dyn Fn() -> bool + Send + Sync> {
        let runtime = self.real.remote.runtime.clone();
        std::sync::Arc::new(move || !runtime.native_platforms().is_empty())
    }

    /// The host media router: bind a stream's target here, then host/browser/viewFrames pictures reach it.
    pub fn host_media_router(&self) -> &Arc<HostMedia> {
        &self.host_media
    }

    /// The shell/task runtime; Exec::wakes is the hub SessionDeps::wakes shares.
    pub fn exec(&self) -> &Exec {
        &self.exec
    }

    /// The one file service the tools and `WriteHost` share.
    pub fn file_service(&self) -> &Arc<dyn FileService> {
        &self.file_service
    }

    /// The shared render browser for WP-TOOLS-WEB's `BrowserEndpoint`.
    pub fn render_browser(&self) -> mixdog_exthost::RenderBrowser {
        self.ext_host.render_browser()
    }

    /// The provider catalog;`catalog().service().catalog()` is what `CatalogTraits::new` takes
    /// (one `CatalogTraits` per provider, built where the provider adapters are).
    pub fn catalog(&self) -> &CatalogHost {
        &self.catalog
    }

    /// The core's stop step for the extension host: closes it and returns once every worker
    /// process has exited. Await it before the runtime drops.
    pub async fn close_ext_host(&self) {
        self.catalog.stop();
        self.ext_host.close().await;
    }

    /// Registers a step of the ordered stop (trace and session-log flush, usage ledger, session
    /// directory shutdown, `GraphCache::drain`, ...). Steps run in registration order, after the
    /// extension host has closed.
    pub fn on_stop(&self, name: &'static str, step: impl Future<Output = ()> + Send + 'static) {
        self.stop_steps.push(name, Box::pin(step));
    }

    /// Registers a barrier the release procedure runs before it closes connections: a session
    /// actor Clean or reported storage_indeterminate (LR §5.3 step 1). Runs in registration order.
    pub fn on_final_barrier(&self, name: &'static str, barrier: crate::lifecycle::Hook) {
        self.final_barriers.lock().unwrap_or_else(std::sync::PoisonError::into_inner).push((name, barrier));
    }

    /// Runs every registered final barrier. Blocks: call it from the release thread only.
    pub fn run_final_barriers(&self) {
        let barriers = std::mem::take(&mut *self.final_barriers.lock().unwrap_or_else(std::sync::PoisonError::into_inner));
        for (name, barrier) in barriers {
            tracing::debug!(barrier = name, "final barrier");
            barrier();
        }
    }

    /// The extension host pool, for the lifecycle's release procedure.
    pub fn ext_host(&self) -> &Arc<ExtHostPool> {
        &self.ext_host
    }

    /// The one stop procedure of the core, in the order of the daemon's release (final barriers, the extension host, the stop steps): runs the
    /// registered final barriers, closes the extension host, then runs each registered step in order. Returns once all of it is
    /// done; a second call finds nothing left to run. (The release procedure runs the same three on its own threads under budgets, with the
    /// connections closed between the first two.)
    pub async fn stop(&self, reason: &str) {
        self.set_stop_reason(reason);
        self.run_final_barriers();
        self.close_ext_host().await;
        self.run_stop_steps().await;
    }

    /// A stop was requested: the new-task attempts in flight end now (`SessionDirectory::cut_new_tasks`), before the drain.
    pub fn cut_new_tasks(&self) {
        self.real.directory.cut_new_tasks();
    }

    /// Records Node's text of this stop (`daemon.mjs:272` `shutdown(reason)`) for the stop steps; the first one wins, so the release and a
    /// later `stop` agree on one reason.
    pub fn set_stop_reason(&self, reason: &str) {
        let _ = self.stop_reason.0.set(reason.to_owned());
        // The stop's entry is also where closing is requested (Node's `closeRequested` flag, set before its first step): the warm-ups
        // waiting on it end now, not in the late session-directory step, which a step over its budget would skip.
        self.real.close_requested.cancel();
    }

    /// The cell the stop steps read (`Real::session_shutdown_step`): it is filled by the time any step runs.
    pub fn stop_reason(&self) -> Arc<StopReasonCell> {
        self.stop_reason.clone()
    }

    /// The daemon log written out: the release procedure runs it right before the process ends, on every path, because a stuck step skips
    /// `run_stop_steps` and the lines queued by then would be lost.
    pub async fn flush_log(&self) {
        flush_at_exit(&self.log, &self.real.gateway_usage).await;
    }

    /// The registered stop steps alone, for the release procedure that closes the extension host
    /// at its own point (RuntimeCore::close_ext_host).
    pub async fn run_stop_steps(&self) {
        self.stop_steps.run().await;
        // Flushed after every other stop step, as Node does (daemon.mjs:411 awaits flushDaemonLogs after the discovery withdrawal and the
        // singleton release, just before the exit): Node flushes, it never closes a stream. Then the run token ends (the log's lane jobs hang
        // on it; Rust-only). A second call finds nothing to run and both are idempotent.
        flush_at_exit(&self.log, &self.real.gateway_usage).await;
        self.stop.cancel();
    }

    /// The one process manager and durability lane of Tidy, for `TidyTool::new` and
    /// `tool_modules::host::Parts.processes`.
    pub fn tidy_processes(&self) -> &Processes {
        &self.tidy_processes
    }

    /// Mixy's heartbeat on its timers; `serve` calls it once startup has finished.
    pub fn start_sub_agent_retention(&self) {
        self.real.start_sub_agent_retention();
    }

    pub fn start_heartbeat(&self) {
        self.real.start_heartbeat();
    }

    pub fn open_memory_in_background(&self) {
        self.real.open_memory_in_background();
    }

    /// The memory database handle, for the readiness test that makes a first use.
    #[cfg(test)]
    pub fn memory_db(&self) -> Arc<mixdog_services::memory::pg::db::Db> {
        self.real.memory.db()
    }

    /// The idle sweep's store (`Real::sweep_store`).
    pub fn sweep_store(&self, data_dir: &std::path::Path, stop: tokio_util::sync::CancellationToken) -> Arc<crate::sweep_store::DirectorySweepStore> {
        self.real.sweep_store(data_dir, stop)
    }

    /// The webhook event pipeline, which `serve` runs once startup has finished.
    pub fn event_pipeline(&self) -> &Arc<crate::event_pipeline::EventPipeline> {
        &self.real.event_pipeline
    }

    /// The cell `serving::start` binds the built `Lifecycle` into. Not `lifecycle()`: that is `CoreHandle::lifecycle` (the state watch), which a call through the `Arc` would pick.
    pub fn late_lifecycle(&self) -> &Arc<crate::late_lifecycle::LateLifecycle> {
        &self.real.late_lifecycle
    }

    /// Bind the terminal, screen, workspace, system and device owners once; a close before that is written to the daemon log.
    pub fn connection_owners(&self) -> &crate::connection_close::ConnectionOwnersCell {
        &self.real.connection_owners
    }

    /// The concrete `LocalProcessManager` (`ProcessFeeds`, `ProcessService`, `TerminalService`).
    pub fn local_processes(&self) -> &LocalProcessManager {
        &self.local_processes
    }

    /// The shell control: ShellJobsService::new takes it.
    pub fn shell_control(&self) -> &Arc<mixdog_tools::exec::ShellControl> {
        &self.shell_control
    }

    /// The same instance as OwnedShells, for SessionDeletion, AgentSessions, SessionClose
    /// and SessionContextSwitch.
    pub fn shells(&self) -> Arc<dyn mixdog_core_session::session::shell_jobs::OwnedShells> {
        self.shell_control.clone()
    }

    /// The app feed's one section state (see the field).
    pub fn sections(&self) -> &Arc<mixdog_core_base::state::SectionFeedState> {
        &self.sections
    }

    /// The app feed, for the state publisher (`SectionFeedState::new`).
    pub fn app_feed_core(&self) -> &Arc<CoreFeed> {
        &self.app_feed
    }

    pub fn set_state(&self, state: LifecycleState) {
        self.state.send_replace(state);
    }

    /// The dialer for a phone served by this core: `serving::start` binds it once the connection hub exists and verifies it before the listener accepts.
    pub fn local_dialer(&self) -> &Arc<crate::domain_seams::remote::LateDialer> {
        &self.real.local_dialer
    }

    /// The remote access runtime and the one device registry, for `serving::attach` (opens the relay) and the connection hooks.
    pub fn remote(&self) -> &crate::domain_seams::remote::BuiltRemote {
        &self.real.remote
    }

    /// The core's one state publisher, for what the serving stage publishes itself (`hostState.remoteViewing`).
    pub fn state_publisher(&self) -> &Arc<dyn mixdog_core_api::state::StatePublisher> {
        &self.real.publisher
    }
}

impl CoreHandle for ComposedCore {
    fn threads(&self) -> &dyn ThreadDirectory {
        self.real.directory.as_ref()
    }

    fn app_feed(&self) -> Arc<dyn FeedSource> {
        self.app_feed.clone()
    }

    fn scoped_feed(&self, id: &FeedId) -> Option<Arc<dyn FeedSource>> {
        self.feed_index.find(id)
    }

    fn ops(&self) -> &dyn OpIndex {
        &self.ops
    }

    fn domain_for(&self, method: &str) -> Option<&dyn DomainService> {
        #[cfg(feature = "replay-controls")]
        if method == mixdog_app_server::REPLAY_STORES_SETTLED {
            return Some(&self.stores_settled);
        }
        self.real.domains.get(method)
    }

    fn host_media(&self) -> &dyn HostMediaSink {
        self.host_media.as_ref()
    }

    fn lifecycle(&self) -> watch::Receiver<LifecycleState> {
        self.state.subscribe()
    }

    fn connection_closed(&self, connection: mixdog_core_api::ids::ConnectionId) {
        self.real.connection_owners.connection_closed(connection, &self.log);
        self.real.late_lifecycle.client_closed(connection);
    }

    fn connection_opened(
        &self,
        connection: mixdog_core_api::ids::ConnectionId,
        origin: mixdog_protocol::Origin,
        device: &str,
        kind: mixdog_protocol::ConnectionKind,
    ) {
        crate::domain_seams::remote::register_local(&self.real.remote.registry, connection, origin, device, kind);
        if let Err(said) = self.real.late_lifecycle.client_opened(connection, kind) {
            self.log.log(said);
        }
    }

    fn request_started(&self, method: &str, params: &serde_json::Value) -> mixdog_core_api::handle::RequestGuard {
        match self.real.late_lifecycle.get() {
            // A new task is host logic in Node: a stop request cuts it instead of waiting for it (`Lifecycle::begin_new_task`).
            Some(lifecycle) if method == "thread/start" && mixdog_core_session::session::new_task::starts_new_task(params) => {
                Box::new(lifecycle.begin_new_task())
            }
            Some(lifecycle) => Box::new(lifecycle.begin_call()),
            // A startup bug (the listener accepts only after the bind): said, not silently left out of the count.
            None => {
                self.log.log("a request was admitted before the lifecycle was bound; it is not counted");
                Box::new(())
            }
        }
    }
}

/// `CoreWiring.drain_feed`: the `core/drain` notification as the next frame of the app feed, so
/// every attached client gets it in order with the sections. `app` is the section state built over
/// [`ComposedCore::app_feed_core`], the feed's only producer.
pub fn drain_feed(app: Arc<mixdog_core_base::state::SectionFeedState>) -> Arc<dyn Fn(CoreDrainParams) + Send + Sync> {
    Arc::new(move |params| app.notify("core/drain", &params))
}

/// The bundled JavaScript runtime, from the install layout: what runs skill scripts and the
/// extension host (Node's `process.execPath` and package root).
pub struct JsRuntime {
    pub program: PathBuf,
    /// The package root holding `src/skill-script-entry.mjs` and `src/ext-host/worker.mjs`.
    pub package_root: PathBuf,
    /// The program is an Electron binary that needs node mode.
    pub electron: bool,
}

pub struct ComposeConfig {
    pub data_dir: PathBuf,
    /// The desktop profile folder (editor backups, `User/settings.json`).
    pub user_data_dir: PathBuf,
    pub js_runtime: JsRuntime,
    /// The ONNX Runtime shared library (install layout), or that the platform has no binding.
    pub ort_library: OrtRuntime,
    /// The server's connection table (`Outgoing`), built before the core. It is the host channel the browser, visualize and model-proxy services forward through, the
    /// claimed channel and desktop presence the secret fill and the terminal tool ask, the notifier of `modelProxy/run/event`, the sink of server requests.
    pub outgoing: Arc<mixdog_app_server::Outgoing>,
    /// The data-directory lock (`startup::Started.ownership`): every log writer revalidates it before it writes, and a failed check fences the core.
    pub ownership: Arc<dyn mixdog_core_api::domain::ownership::Ownership>,
    /// The one daemon log, built where the daemon starts (`serve`): the real core hands it to every writer (the quota resume timer, ...).
    pub log: crate::daemon_log::DaemonLog,
    /// The daemon's run token, the one `log` holds. The stop procedure cancels it after the last stop step.
    pub stop: tokio_util::sync::CancellationToken,
    /// The catalog's HTTP client (models.dev and LiteLLM fetches): the real one in the daemon (catalog::production_http), a client that cannot connect in tests.
    pub catalog_http: Arc<dyn mixdog_ai::transport::http::HttpSend>,
    /// Compiled for tests only (the daemon always runs the bundled runtime's download). What runs when the memory database is first used to bring the PostgreSQL runtime: None in the daemon (the bundled runtime's download, nsureRuntime), a held or failing install in a test.
    #[cfg(test)]
    pub pg_install: Option<mixdog_services::memory::boot::PgInstall>,
}

/// `process.env` as the services read it.
fn process_env() -> mixdog_core::run_host::run_seams::EnvReader {
    Arc::new(|name: &str| std::env::var(name).ok())
}

/// The extension host pool of this install: the core's, and the migration's office extractor (`boot`) start the same worker.
pub(crate) fn ext_host_config(js: &JsRuntime, data_dir: &Path, tokens: &LaneTokens) -> ExtHostConfig {
    ExtHostConfig {
        program: js.program.clone(),
        args: vec![js.package_root.join("src").join("ext-host").join("worker.mjs").into_os_string()],
        electron: js.electron,
        workers: worker_count(None, std::thread::available_parallelism().map_or(1, |n| n.get())),
        pending_cap: DEFAULT_PENDING_CAP,
        spawn_io: tokens.spawn_io,
        render_browser: RenderBrowserConfig { command: None, profile_root: data_dir.join("render-browser"), no_sandbox: false },
    }
}

pub async fn compose(tokens: &LaneTokens, config: ComposeConfig) -> Result<ComposedCore, ComposeError> {
    compose_interruptible(tokens, config, tokio_util::sync::CancellationToken::new()).await
}

/// [`compose`], whose slow waits (the PostgreSQL install and start) end when `interrupt` is cancelled: `serve` cancels it when a stop arrives meanwhile. A composition that
/// fails, interrupted or not, gives back what it had acquired before it returns the error (`Acquired`), so no PostgreSQL is left running.
pub async fn compose_interruptible(tokens: &LaneTokens, config: ComposeConfig, interrupt: tokio_util::sync::CancellationToken) -> Result<ComposedCore, ComposeError> {
    let ComposeConfig { data_dir, user_data_dir, js_runtime, ort_library, outgoing, ownership, log, stop, catalog_http, #[cfg(test)] pg_install } = config;
    let data_dir = data_dir.as_path();
    let state_dir = data_dir.join("state");
    create_dir(tokens, state_dir.clone()).await.map_err(ComposeError::StateDir)?;
    let (state, _) = CoreState::open(tokens.sqlite_writer_thread, tokens.interactive_io, &state_dir.join("core.sqlite"))
        .map_err(ComposeError::State)?;
    let feed_index = Arc::new(CoreScopedFeeds::new(
        FeedLimits { ring_bytes: APP_RING_BYTES, max_snapshot_bytes: MAX_SNAPSHOT_BYTES },
        tokens.cpu_interactive,
    ));
    let scoped_feeds: Arc<dyn ScopedFeeds> = feed_index.clone();
    let js = &js_runtime;
    let entry = js.package_root.join("src").join("skill-script-entry.mjs");
    let skill_runtime = ExecSkillRuntime {
        platform: node_platform().to_owned(),
        interpreter: js.program.to_string_lossy().into_owned(),
        entry: entry.to_string_lossy().into_owned(),
        electron: js.electron,
    };
    let skills = SkillRuntime::new(js.program.to_string_lossy(), entry.to_string_lossy(), js.electron);
    let skill_launcher_dir =
        skills.ensure_dir(tokens.durability_io, data_dir).await.map_err(ComposeError::Launcher)?;
    let ext_host = Arc::new(
        ExtHostPool::new(ext_host_config(js, data_dir, tokens)).map_err(ComposeError::ExtHost)?,
    );
    let local_processes = LocalProcessManager::new(tokens.spawn_io, ProcessConfig::default());
    let process_manager: Arc<dyn ProcessManager> = Arc::new(local_processes.clone());
    let tidy_processes = Processes::new(process_manager.clone(), tokens.durability_io);
    let file_service: Arc<dyn FileService> = Arc::new(LocalFileService::new());
    let models = build_models(tokens, data_dir, ort_library)?;
    // The listing sources are built from the full provider config; the config domain supplies it
    // when it lands, until then only the models.dev metadata is refreshed.
    let catalog = build_catalog(tokens, data_dir, Vec::new(), catalog_http).await.map_err(ComposeError::Catalog)?;
    let shell_path =
        crate::shell_name::resolve_program_current_on(tokens.interactive_io).await.map_err(ComposeError::Shell)?;
    // The one `ConfiguredShell`: every spawn reads it, and the flip hands `exec.configured_shell` to
    // `DaemonSettingsEffects::new` and sets the boot value from `config.shell` on it.
    let (exec, exec_events) = build_exec(
        tokens,
        data_dir,
        skill_launcher_dir,
        shell_path,
        Arc::new(ConfiguredShell::default()),
        skill_runtime,
        crate::exec::ExecHosts { ext_pool: ext_host.clone(), processes: local_processes.clone() },
    );
    let shell_control = Arc::new(mixdog_tools::exec::ShellControl::new(exec.runtime.clone(), process_manager.clone()));
    let id = FeedId::from("app");
    let epoch = FeedEpoch::from(new_instance_id());
    // The app feed is of the ordered class (`SectionFeed::ordered`).
    let app_feed = Arc::new(CoreFeed::new_ordered(
        id.clone(),
        epoch.clone(),
        empty_view(&id, &epoch),
        FeedLimits { ring_bytes: APP_RING_BYTES, max_snapshot_bytes: MAX_SNAPSHOT_BYTES },
        tokens.cpu_interactive,
    ));
    let mut gates = Vec::with_capacity(OP_SCOPES.len());
    for scope in OP_SCOPES {
        let store = Arc::new(StateOpStore::new(state.clone(), scope.into()));
        gates.push(
            OpGate::domain(OpScope::Domain(scope.into()), store)
                .await
                .map_err(|error| ComposeError::OpGate { scope, error })?,
        );
    }
    let thread_gates = Arc::new(crate::late_seams::LateThreadGates::default());
    let sections = Arc::new(mixdog_core_base::state::SectionFeedState::new(app_feed.clone()));
    let stop_reason: Arc<StopReasonCell> = Arc::default();
    let acquired = crate::acquired::Acquired::new(interrupt);
    let host_media = HostMedia::new(Limits::default().max_media_frame_bytes);
    let built = crate::compose_flip::Built {
        host_media: host_media.clone(),
        acquired: acquired.clone(),
        tokens: tokens.clone(),
        data_dir: data_dir.to_path_buf(),
        user_data_dir,
        package_root: js_runtime.package_root.clone(),
        js_runtime,
        #[cfg(test)]
        pg_install,
        env: process_env(),
        app_feed: app_feed.clone(),
        scoped_feeds,
        host: outgoing.clone(),
        claimed_host: outgoing.clone(),
        presence: outgoing.clone(),
        approval_presence: outgoing.clone(),
        client_epoch: outgoing.clone(),
        notifier: outgoing.clone(),
        server_requests: outgoing.clone(),
        ext_host: ext_host.clone(),
        process_manager,
        local_processes: local_processes.clone(),
        tidy_processes: tidy_processes.clone(),
        models,
        catalog: catalog.service().clone(),
        catalog_warmup: catalog.warmup().clone(),
        exec: exec.runtime.clone(),
        shell_control: shell_control.clone(),
        files: file_service.clone(),
        gates: OP_SCOPES.iter().copied().zip(gates.iter().cloned()).collect(),
        cancel: stop.clone(),
        log: log.clone(),
        wakes: exec.wakes.clone(),
        configured_shell: exec.configured_shell.clone(),
        core_state: state,
        ownership,
        thread_gates: thread_gates.clone(),
        sections: sections.clone(),
    };
    // Every late cell the composition owns is bound, or this fails (`ComposeError::Unbound`); a method no service claims fails it too (`Unclaimed`).
    let real = match crate::compose_flip::real_core(built).await {
        Ok(real) => real,
        Err(error) => {
            acquired.release().await;
            return Err(error);
        }
    };
    // The stop procedure's first steps, in this order: the quota resume timer ends before the directory it resumes sessions on shuts down, then the directory.
    let resume_timer = real.resume_timer.clone();
    // Node's boot coordinator (`daemon.mjs:1129`): Goal recovery, then `startQuotaResume`, once a client is ready.
    let coordinator = crate::boot_coordinator::BootCoordinator::new(
        Arc::new(crate::boot_coordinator::SessionBootSteps { recovery: real.goal_recovery.clone(), timer: resume_timer.clone() }),
        log.line_log(),
    );
    if outgoing.set_client_hook(Arc::new(crate::boot_coordinator::BootHook(coordinator))).is_err() {
        acquired.release().await;
        return Err(ComposeError::AlreadyBound("client hook"));
    }
    let shutdown = real.session_shutdown_step(stop_reason.clone());
    let later = real.runtime_stop_steps(stop_reason.clone());
    // The shell runtime's completions and strip changes (Node's `shellJobsPoller` and `notifySessionCompletion`) reach the directory and the sections.
    crate::exec_events::consume(
        exec_events,
        crate::exec_events::Targets {
            directory: real.directory.clone(),
            threads: Arc::new(mixdog_core_session::session::thread_state::SessionThreads::new(real.directory.clone())),
            publisher: real.publisher.clone(),
        },
        stop.clone(),
    );
    let core = ComposedCore {
        state: watch::Sender::new(LifecycleState::Serving),
        host_media,
        sections,
        app_feed,
        feed_index,
        ops: CoreOpIndex::new(gates, thread_gates),
        exec,
        ext_host,
        file_service,
        catalog,
        tidy_processes,
        local_processes,
        shell_control,
        stop_steps: StopSteps::default(),
        final_barriers: std::sync::Mutex::new(Vec::new()),
        #[cfg(feature = "replay-controls")]
        stores_settled: crate::replay_stores_settled::StoresSettled::new(real.directory.clone(), real.replay_writers.clone(), real.gateway_usage.clone(), real.ledgers.clone()),
        real,
        log,
        stop,
        stop_reason,
    };
    // Node's first step after the heartbeat (`daemon.mjs:302`): the relayed model calls are aborted and settle before anything they depend on stops.
    let (name, halt) = core.real.heartbeat_halt_step(); // stopHeartbeat?.(), the first act of Node's shutdown after its flags (daemon.mjs:285)
    core.on_stop(name, halt);
    let (name, close) = core.real.close_step();
    core.on_stop(name, close);
    let (name, ended) = core.real.heartbeat_ended_step(); // await heartbeatEnded right after the model proxy closed, before the session service stops (daemon.mjs:312)
    core.on_stop(name, ended);
    let timer = resume_timer.clone();
    core.on_stop("quota resume timer", async move { timer.stop().await });
    // The retention cycle reads and deletes sessions through the directory: it has ended before the directory shuts down.
    let (name, retention) = core.real.sub_agent_retention_step();
    core.on_stop(name, retention);
    core.on_stop("session directory shutdown", shutdown);
    for (name, step) in later {
        core.on_stop(name, step);
    }
    Ok(core)
}

#[cfg(test)]
mod review_restart_tests;
#[cfg(test)]
mod office_startup_tests;
#[cfg(test)]
mod session_project_tests;

#[cfg(test)]
mod tests {
    use super::*;

    /// The config every test composes with: a fresh `Outgoing` (no desktop connected), the mock ownership, the fixture JS runtime, and the data
    /// directory in the test's own `dir` (`compose_test_support::data_in`: the PostgreSQL runtime is installed into it). The test runs in a child
    /// process of its own (`compose_test_support::in_child`).
    pub(super) fn config(dir: &Path, log: crate::daemon_log::DaemonLog, stop: tokio_util::sync::CancellationToken) -> ComposeConfig {
        config_in(&crate::compose_test_support::data_in(dir), dir, log, stop)
    }

    /// [`config`] over a data directory of the caller's own (with the runtime installed in it).
    pub(super) fn config_in(data: &Path, dir: &Path, log: crate::daemon_log::DaemonLog, stop: tokio_util::sync::CancellationToken) -> ComposeConfig {
        ComposeConfig {
            data_dir: data.to_path_buf(),
            user_data_dir: dir.join("userdata"),
            js_runtime: crate::js_runtime::fixture(dir),
            ort_library: OrtRuntime::NoBinding,
            outgoing: mixdog_app_server::Outgoing::new(),
            ownership: Arc::new(mixdog_core_api::domain::mock::MockOwnership::default()),
            log,
            stop,
            catalog_http: crate::compose_test_support::offline_http(),
            #[cfg(test)]
            pg_install: None,
        }
    }

    /// A cell left unbound fails startup, naming it; once every cell is bound the check passes.
    #[test]
    fn startup_fails_when_a_late_cell_is_left_unbound() {
        use mixdog_core::run_host::late::Bound;
        struct Cell(&'static str, bool);
        impl Bound for Cell {
            fn cell(&self) -> &'static str {
                self.0
            }
            fn is_bound(&self) -> bool {
                self.1
            }
        }
        let bound = Cell("setup ui surface", true);
        let left = Cell("local dialer", false);
        let error = verify_bound(&[&bound, &left]).unwrap_err();
        assert!(matches!(error, ComposeError::Unbound { cell: "local dialer" }));
        assert_eq!(verify_bound(&[&bound, &left]).unwrap_err().to_string(), "the local dialer was not bound before the server accepted connections");
        assert!(verify_bound(&[&bound, &Cell("local dialer", true)]).is_ok());
    }
    /// The release procedure runs the final barriers in registration order, then (after the
    /// extension host has closed) the stop steps; neither runs twice.
    #[test]
    #[ignore = "integration: composes the real core, which needs a bundled Postgres runtime (MIXDOG_PG_RUNTIME); no network"]
    fn release_runs_the_barriers_then_the_stop_steps_once() {
        crate::compose_test_support::in_child(module_path!(), "release_runs_the_barriers_then_the_stop_steps_once", tokio::runtime::Builder::new_current_thread(), |dir| async move {
            let log = crate::daemon_log::DaemonLog::new(dir.join("daemon.log"), mixdog_rt::testing::tokens().maintenance_io, mixdog_rt::CancellationToken::new());
            let core = compose(&mixdog_rt::testing::tokens(), config(&dir, log, mixdog_rt::CancellationToken::new())).await.unwrap();
            let order = Arc::new(std::sync::Mutex::new(Vec::<&'static str>::new()));
            for name in ["first", "second"] {
                let order = order.clone();
                core.on_final_barrier(name, Arc::new(move || order.lock().unwrap().push(name)));
            }
            let steps = order.clone();
            core.on_stop("step", async move { steps.lock().unwrap().push("step") });
            // The release states the reason before its first step (`release_started`); the directory's and the channels' steps read it.
            core.set_stop_reason("test");
            core.run_final_barriers();
            core.run_stop_steps().await;
            core.run_final_barriers();
            core.run_stop_steps().await;
            assert_eq!(*order.lock().unwrap(), ["first", "second", "step"]);
        });
    }

    /// The recorded case "every overlapping host disposal waits for the same attachment cleanup" (`session-host-lifecycle-cases`, Node's
    /// memoised `SessionHost.dispose`, `apps/desktop/src/main/session-host.ts:1209`) through the real core's stop steps
    /// (`ComposedCore::run_stop_steps`: the steps the real composition registered, then the attachment cleanup held until released). The
    /// first stop runs as the release runs it (`supervise_async("stopSteps", ..)`, server.rs:248); a second stop made while the cleanup is
    /// held (one poll joins the run in progress) waits for that same cleanup, which runs once. The whole run has one bound, `BUDGET`.
    #[test]
    #[ignore = "integration: composes the real core, which needs a bundled Postgres runtime (MIXDOG_PG_RUNTIME); no network"]
    fn overlapping_stops_wait_for_the_same_cleanup_as_node_recorded() {
        crate::compose_test_support::in_child(module_path!(), "overlapping_stops_wait_for_the_same_cleanup_as_node_recorded", { let mut runtime = tokio::runtime::Builder::new_multi_thread(); runtime.worker_threads(2); runtime }, |dir| async move {
            use std::sync::atomic::{AtomicU64, Ordering};
            const BUDGET: std::time::Duration = std::time::Duration::from_secs(60);
            let text = mixdog_testkit::fixture!("../../fixtures/session-host-lifecycle-cases/golden.json");
            let golden = mixdog_testkit::exact::Exact::decode(&serde_json::from_str::<serde_json::Value>(text).expect("golden.json")).expect("exact");
            let observed = golden
                .get("cases")
                .as_array()
                .iter()
                .find(|case| case.get("case").as_str() == "every overlapping host disposal waits for the same attachment cleanup")
                .expect("the recorded case")
                .get("observed")
                .clone();
            let log = crate::daemon_log::DaemonLog::new(dir.join("daemon.log"), mixdog_rt::testing::tokens().maintenance_io, mixdog_rt::CancellationToken::new());
            let core = Arc::new(compose(&mixdog_rt::testing::tokens(), config(&dir, log, mixdog_rt::CancellationToken::new())).await.unwrap());
            let events = Arc::new(std::sync::Mutex::new(Vec::<&'static str>::new()));
            let closes = Arc::new(AtomicU64::new(0));
            let (entered_tx, entered) = tokio::sync::oneshot::channel::<()>();
            let (release, released) = tokio::sync::oneshot::channel::<()>();
            let (log_events, count) = (events.clone(), closes.clone());
            core.on_stop("attachment cleanup", async move {
                count.fetch_add(1, Ordering::SeqCst);
                log_events.lock().unwrap().push("cleanup entered");
                let _ = entered_tx.send(());
                let _ = released.await;
                log_events.lock().unwrap().push("cleanup returned");
            });
            core.set_stop_reason("test");
            let (first_core, log_events) = (core.clone(), events.clone());
            let first = tokio::spawn(async move {
                let end = crate::lifecycle::supervise_async("stopSteps", BUDGET, async move { first_core.run_stop_steps().await }).await;
                log_events.lock().unwrap().push("first dispose finished");
                end
            });
            tokio::time::timeout(BUDGET, entered).await.expect("the stop to start the attachment cleanup").expect("entered");
            let log_events = events.clone();
            let mut second = std::pin::pin!(async {
                core.run_stop_steps().await;
                log_events.lock().unwrap().push("second dispose finished");
            });
            // The one poll that joins the run in progress: the second stop is then held by the cleanup until it is released.
            assert!(futures::poll!(&mut second).is_pending(), "the second stop waits for the cleanup in progress");
            events.lock().unwrap().push("cleanup released");
            release.send(()).expect("the cleanup waits");
            tokio::time::timeout(BUDGET, async {
                assert_eq!(first.await.expect("the first stop"), crate::lifecycle::StepEnd::Finished, "the first stop ended within its budget");
                second.await;
            })
            .await
            .expect("both overlapping stops to finish");
            let rust = serde_json::json!({ "events": *events.lock().unwrap(), "closes": closes.load(Ordering::SeqCst) });
            assert_eq!(mixdog_testkit::exact::Exact::plain(&rust), observed);
        });
    }

    /// Closing is requested when the release begins, before any budgeted step: whether a later step runs over its budget (and so skips
    /// the stop steps, with the late session-directory step) cannot matter to the warm-ups waiting on the close.
    #[test]
    #[ignore = "integration: composes the real core, which needs a bundled Postgres runtime (MIXDOG_PG_RUNTIME); no network"]
    fn the_release_has_requested_closing_before_its_first_budgeted_step() {
        crate::compose_test_support::in_child(module_path!(), "the_release_has_requested_closing_before_its_first_budgeted_step", tokio::runtime::Builder::new_current_thread(), |dir| async move {
            use crate::lifecycle::testing::Recorder;
            use crate::lifecycle::{CorePort, DrainNotice, Lifecycle, LifecycleConfig, Ports, ReleaseBudgets, Running};
            use std::sync::atomic::{AtomicBool, Ordering};
            use std::time::Duration;

            /// The recorder, except that the release states its reason to the real core (as `serving.rs` wires `release_started`), and
            /// the first budgeted step (`finalBarriers`) notes whether closing was already requested when it started.
            struct Entry {
                core: Arc<ComposedCore>,
                inner: Arc<Recorder>,
                requested_at_first_step: Arc<AtomicBool>,
            }
            impl CorePort for Entry {
                fn drain_notice(&self, notice: &DrainNotice) {
                    self.inner.drain_notice(notice);
                }
                fn health(&self, stalled_ms: u64) {
                    self.inner.health(stalled_ms);
                }
                fn cancel_running(&self, running: &[Running]) {
                    self.inner.cancel_running(running);
                }
                fn cut_new_tasks(&self) {
                    self.inner.cut_new_tasks();
                }
                fn release_decision(&self, pid: u32) {
                    self.inner.release_decision(pid);
                }
                fn release_started(&self, reason: &str) {
                    self.core.set_stop_reason(reason);
                }
                fn final_barriers(&self) {
                    self.requested_at_first_step.store(self.core.real.close_requested.is_cancelled(), Ordering::SeqCst);
                    self.inner.final_barriers();
                }
                fn close_connections(&self) {
                    self.inner.close_connections();
                }
                fn close_ext_host(&self) {
                    self.inner.close_ext_host();
                }
                fn close_data_handles(&self) {
                    self.inner.close_data_handles();
                }
                fn flush_log(&self) {
                    self.inner.flush_log();
                }
            }

            let log = crate::daemon_log::DaemonLog::new(dir.join("daemon.log"), mixdog_rt::testing::tokens().maintenance_io, mixdog_rt::CancellationToken::new());
            let core = Arc::new(compose(&mixdog_rt::testing::tokens(), config(&dir, log, mixdog_rt::CancellationToken::new())).await.unwrap());
            assert!(!core.real.close_requested.is_cancelled());
            let requested_at_first_step = Arc::new(AtomicBool::new(false));
            let recorder = Arc::new(Recorder::default());
            let ample = Duration::from_secs(3600);
            let budgets = ReleaseBudgets { final_barriers: ample, close_connections: ample, close_ext_host: ample, record_exit: ample, withdraw_discovery: ample, close_data_handles: ample };
            let lifecycle = Lifecycle::with_budgets(
                LifecycleConfig { instance_id: "instance-1".into(), version: "1.4.6".into(), runtime_root: dir.clone() },
                Ports { core: Arc::new(Entry { core: core.clone(), inner: recorder.clone(), requested_at_first_step: requested_at_first_step.clone() }), discovery: recorder.clone(), exiter: recorder.clone() },
                budgets,
            );
            lifecycle.set_serving().unwrap();
            drop(lifecycle.connection(crate::lifecycle::ClientKind::Session));
            // wait_exit blocks the thread; the release runs on its own.
            tokio::task::spawn_blocking({
                let recorder = recorder.clone();
                move || recorder.wait_exit()
            })
            .await
            .unwrap();
            assert!(requested_at_first_step.load(Ordering::SeqCst), "closing was already requested when the first budgeted step started");
        });
    }

    /// The stop procedure writes the log out before the run token ends: a line a step logs is on disk when it returns.
    #[test]
    #[ignore = "integration: composes the real core, which needs a bundled Postgres runtime (MIXDOG_PG_RUNTIME); no network"]
    #[allow(clippy::disallowed_methods, reason = "reads the log file the test just had written")]
    fn the_stop_steps_flush_the_daemon_log_and_then_end_the_run_token() {
        crate::compose_test_support::in_child(module_path!(), "the_stop_steps_flush_the_daemon_log_and_then_end_the_run_token", tokio::runtime::Builder::new_current_thread(), |dir| async move {
            let stop = tokio_util::sync::CancellationToken::new();
            let log = crate::daemon_log::DaemonLog::new(dir.join("daemon.log"), mixdog_rt::testing::tokens().maintenance_io, stop.clone());
            log.enable_file_logging();
            let core = compose(&mixdog_rt::testing::tokens(), config(&dir, log.clone(), stop.clone())).await.unwrap();
            let writer = log.clone();
            core.on_stop("log a line", async move { writer.log("closing") });
            assert!(!stop.is_cancelled());
            core.set_stop_reason("test");
            core.run_stop_steps().await;
            assert!(stop.is_cancelled());
            let text = std::fs::read_to_string(dir.join("daemon.log")).unwrap();
            assert!(text.contains("[daemon] closing"), "{text}");
        });
    }

    /// Case 9 of Node's K1 recording `fixtures/github-cases`: `isBuiltinTool('github')`, read from the recording. The `github` tool a session
    /// gets from the composed registry (the core's pool, resolved for a session of the default tool spec as `session_tools::resolve` resolves
    /// it, held as `session_doc` holds it) is a built-in exactly when it is held as Node's built-in definition whole: an internal tool would be
    /// held projected, without its title. The rest of the case is replayed in mixdog-tools (`github::k1_replay`).
    #[test]
    #[ignore = "integration: composes the real core, which needs a bundled Postgres runtime (MIXDOG_PG_RUNTIME); no network"]
    #[allow(clippy::disallowed_methods, reason = "reads the recorded fixture")]
    fn the_github_tool_a_session_gets_is_nodes_builtin_one() {
        crate::compose_test_support::in_child(module_path!(), "the_github_tool_a_session_gets_is_nodes_builtin_one", tokio::runtime::Builder::new_current_thread(), |dir| async move {
            use mixdog_core::run_host::session_tools;
            let golden: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/../../fixtures/github-cases/golden.json")).unwrap()).unwrap();
            let case = &golden["cases"][9];
            assert_eq!(case["case"], "the agent tool is registered and returns the ordinary builtin text/error contract");
            let recorded = case["observed"]["isBuiltinTool"].as_bool().expect("isBuiltinTool is recorded as a boolean");
            let log = crate::daemon_log::DaemonLog::new(dir.join("daemon.log"), mixdog_rt::testing::tokens().maintenance_io, mixdog_rt::CancellationToken::new());
            let core = compose(&mixdog_rt::testing::tokens(), config(&dir, log, mixdog_rt::CancellationToken::new())).await.unwrap();
            let pool = core.real.tool_pool.clone();
            let request = session_tools::Resolve { tool_spec: None, model: "", skills_listed: false, agent_owned: false, schema_allowed: None, disallowed: &[] };
            let held = session_tools::resolve(&pool, Vec::new(), &request).iter().find(|tool| tool.spec().name == "github").map(|tool| session_tools::session_doc(&pool, tool));
            let node = mixdog_js::fixture_tools::definition("github").expect("Node's built-in github definition");
            assert_eq!(held.as_ref() == Some(&node), recorded, "isBuiltinTool('github'): the session holds {held:#?}");
            core.set_stop_reason("test");
            core.run_stop_steps().await;
        });
    }
}

/// Every scope the composition asks an op gate for must be in `OP_SCOPES`, or `compose` fails at startup with "the op gate of `<scope>` was not passed".
#[cfg(test)]
mod op_scope_tests {
    use super::OP_SCOPES;

    fn asked(source: &str) -> Vec<String> {
        let mut out = Vec::new();
        let mut rest = source;
        while let Some(at) = rest.find(".scopes(\"") {
            rest = &rest[at + ".scopes(\"".len()..];
            if let Some(end) = rest.find('"') {
                out.push(rest[..end].to_owned());
            }
        }
        out
    }

    #[test]
    fn every_scope_the_composition_asks_for_has_a_gate() {
        let sources = [
            mixdog_testkit::fixture!("src/compose_flip.rs"),
            include_str!("compose_domains.rs"),
            include_str!("compose_domains/rows.rs"),
            include_str!("compose_domains/local.rs"),
        ];
        let mut missing: Vec<String> = sources.iter().flat_map(|s| asked(s)).filter(|scope| !OP_SCOPES.contains(&scope.as_str())).collect();
        missing.sort();
        missing.dedup();
        assert!(missing.is_empty(), "scopes asked of an op gate but absent from OP_SCOPES: {missing:?}");
        for scope in crate::compose_domains::OP_SCOPES {
            assert!(OP_SCOPES.contains(&scope), "compose_domains::OP_SCOPES lists `{scope}`, absent from compose OP_SCOPES");
        }
    }
}
