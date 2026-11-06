//! The composition root: builds the [`CoreHandle`] the server serves (protocol.md §2.1).
//!
//! Real services register in [`domains`] as their crates land, each claiming the exact
//! methods it lists; the table methods still unclaimed get one [`MockDomain`] that echoes
//! `{method, params}`, and the boot log counts those methods, so the wired/mock split is
//! visible at every start. The thread directory, app feed,
//! op index, host media sink and lifecycle are the [`MockCore`] seams until the session core
//! (`mixdog-core-session`, `mixdog-core-base::{feed, ops}`) lands.

use std::path::Path;
use std::path::PathBuf;
use std::sync::Arc;

use mixdog_core_base::feed::CoreScopedFeeds;
use mixdog_services::effort_judge::judge::EffortJudgeModel;
use mixdog_services::effort_judge::judge::JudgeOptions;
use mixdog_services::effort_judge::model::{ModelConfig, OrtRuntime};
use mixdog_services::memory::embed::config::DEFAULT_MODEL_ID;
use mixdog_services::memory::embed::engine::EmbedConfig;
use mixdog_services::memory::embed::provider::EmbeddingProvider;
use mixdog_services::tidy::process::Processes;
use mixdog_services::tool_state::StateTick;
use mixdog_core_api::domain::fs::FileService;
use mixdog_exthost::DEFAULT_PENDING_CAP;
use mixdog_exthost::BrowserService;
use mixdog_exthost::DocumentService;
use mixdog_exthost::VisualizeService;
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
use mixdog_scm::tracked::GixTrackedFiles;
use mixdog_spawn::LocalProcessManager;
use mixdog_spawn::ProcessConfig;
use mixdog_workspace::lanes::Lanes as WorkspaceLanes;
use mixdog_workspace::service::Deps as WorkspaceDeps;
use mixdog_workspace::service::WorkspaceService;

use crate::catalog::CatalogError;
use crate::catalog::CatalogHost;
use crate::catalog::build_catalog;
use crate::exec::Exec;
use crate::exec::ExecEvents;
use crate::exec::build_exec;
use async_trait::async_trait;
use mixdog_core_base::ops::CoreOpIndex;
use mixdog_core_base::ops::OpGate;
use mixdog_core_base::ops::StateOpStore;
use mixdog_core_base::ops::ThreadOpGates;
use mixdog_core_api::CallContext;
use mixdog_core_api::CoreError;
use mixdog_core_api::ids::ThreadId;
use mixdog_core_api::ops::OpScope;
use mixdog_store::sqlite::DbError;
use mixdog_store::state::CoreState;

use mixdog_core_domains::domains::Domains;
use mixdog_core_domains::domains::DomainsBuilder;
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
use mixdog_core_api::HostChannel;
use mixdog_core_api::HostMediaSink;
use mixdog_core_api::OpIndex;
use mixdog_core_api::ThreadDirectory;
use mixdog_core_api::mock::MockCore;
use mixdog_core_api::mock::MockDomain;
use mixdog_core_api::mock::MockLimits;
use tokio::sync::watch;

/// The app feed's ring (SPEC §3.1: 1 MiB for the app feed, 4 MiB per thread feed).
const APP_RING_BYTES: usize = 1 << 20;
/// `maxSnapshotBytes` (SPEC §3.1).
const MAX_SNAPSHOT_BYTES: usize = 3 << 20;

/// The non-thread op scopes (protocol §9.2); each has a gate over its rows in state/core.sqlite.
const OP_SCOPES: [&str; 14] = [
    "config", "account", "agent", "project", "media", "channel", "mcp", "skills", "plugins",
    "localProvider", "terminal", "git", "remoteAccess", "core",
];

#[derive(Debug, thiserror::Error)]
pub enum ComposeError {
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
    #[error("starting the workspace service: {0:?}")]
    Workspace(mixdog_workspace::error::WsError),
    #[error(transparent)]
    Domains(#[from] DomainsError),
    #[error("creating the state directory: {0}")]
    StateDir(std::io::Error),
    #[error("opening state/core.sqlite: {0:?}")]
    State(DbError),
    #[error("opening the op gate of `{scope}`: {error:?}")]
    OpGate { scope: &'static str, error: CoreError },
}

/// Thread directory is still the mock's (empty), so no thread has an op gate; the session core
/// supplies the real ones.
struct NoThreadGates;

#[async_trait]
impl ThreadOpGates for NoThreadGates {
    async fn gate(&self, thread: &ThreadId, _ctx: &CallContext) -> Result<OpGate, CoreError> {
    Err(CoreError::ThreadNotFound { thread_id: thread.clone() })
    }
}

pub struct ComposedCore {
    base: MockCore,
    app_feed: Arc<CoreFeed>,
    /// Every scoped feed a service created, found by id for `feed/subscribe`.
    feed_index: Arc<CoreScopedFeeds>,
    ops: CoreOpIndex,
    domains: Domains,
    mocked: &'static [&'static str],
    exec: Exec,
    exec_events: std::sync::Mutex<Option<ExecEvents>>,
    ext_host: Arc<ExtHostPool>,
    file_service: Arc<dyn FileService>,
    models: Models,
    catalog: CatalogHost,
    tidy_processes: Processes,
    stop_steps: std::sync::Mutex<Vec<(&'static str, StopStep)>>,
}

type StopStep = std::pin::Pin<Box<dyn Future<Output = ()> + Send>>;

#[allow(clippy::disallowed_methods, reason = "runs as a durability-lane job")]
async fn create_dir(tokens: &LaneTokens, path: PathBuf) -> std::io::Result<()> {
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

fn build_models(tokens: &LaneTokens, data_dir: &Path, ort_library: OrtRuntime) -> Result<Models, ComposeError> {
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
        tokens.cpu_bulk,
        JudgeOptions { tick: tick.clone(), manifest: None, progress: None },
    )
    .map_err(ComposeError::EffortJudge)?;
    Ok(Models { tick, embeddings, effort_judge })
}

impl ComposedCore {
    /// The shell/task runtime; Exec::wakes is the hub SessionDeps::wakes shares.
    pub fn exec(&self) -> &Exec {
        &self.exec
    }

    /// The receiving ends of the runtime's event channels, handed once to the session directory
    /// (completions) and the section publisher (strips).
    pub fn take_exec_events(&self) -> Option<ExecEvents> {
        self.exec_events.lock().unwrap_or_else(|e| e.into_inner()).take()
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

    /// The embedding and effort-judge models.
    pub fn models(&self) -> &Models {
        &self.models
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
        self.stop_steps.lock().unwrap_or_else(std::sync::PoisonError::into_inner).push((name, Box::pin(step)));
    }

    /// The one stop procedure of the core, for the daemon and the in-process server alike: closes
    /// the extension host, then runs each registered step in order. Returns once all of it is
    /// done; a second call finds nothing left to run.
    pub async fn stop(&self) {
        self.close_ext_host().await;
        let steps = std::mem::take(&mut *self.stop_steps.lock().unwrap_or_else(std::sync::PoisonError::into_inner));
        for (name, step) in steps {
            tracing::debug!(step = name, "stopping");
            step.await;
        }
    }

    /// The one process manager and durability lane of Tidy, for `TidyTool::new` and
    /// `tool_modules::host::Parts.processes`.
    pub fn tidy_processes(&self) -> &Processes {
        &self.tidy_processes
    }

    /// The app feed, for the state publisher (`SectionFeedState::new`).
    pub fn app_feed_core(&self) -> &Arc<CoreFeed> {
        &self.app_feed
    }

    /// Methods served by a mock rather than a real crate.
    pub fn mocked_domains(&self) -> &[&'static str] {
        self.mocked
    }

    pub fn set_state(&self, state: LifecycleState) {
        self.base.set_state(state);
    }
}

impl CoreHandle for ComposedCore {
    fn threads(&self) -> &dyn ThreadDirectory {
        self.base.threads()
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
        self.domains.get(method)
    }

    fn host_media(&self) -> &dyn HostMediaSink {
        self.base.host_media()
    }

    fn lifecycle(&self) -> watch::Receiver<LifecycleState> {
        self.base.lifecycle()
    }
}

/// What the real services are built from.
struct Seams {
    tokens: LaneTokens,
    state: CoreState,
    scoped_feeds: Arc<dyn ScopedFeeds>,
    processes: Arc<dyn ProcessManager>,
    recovery_dir: PathBuf,
    user_data_dir: PathBuf,
    ext_host: Arc<ExtHostPool>,
    host: Arc<dyn HostChannel>,
}

/// `CoreWiring.drain_feed`: the `core/drain` notification as the next frame of the app feed, so
/// every attached client gets it in order with the sections. `app` is the section state built over
/// [`ComposedCore::app_feed_core`], the feed's only producer.
pub fn drain_feed(app: Arc<mixdog_core_base::state::SectionFeedState>) -> Arc<dyn Fn(CoreDrainParams) + Send + Sync> {
    Arc::new(move |params| app.notify("core/drain", &params))
}

/// Registers the real service of every slot that has one, then returns the slots left over.
fn register_real(builder: &mut DomainsBuilder, seams: &Seams) -> Result<(), ComposeError> {
    let tokens = &seams.tokens;
    let workspace: Arc<dyn DomainService> = WorkspaceService::new(WorkspaceDeps {
        lanes: WorkspaceLanes {
            interactive: tokens.interactive_io,
            durability: tokens.durability_io,
            maintenance: tokens.maintenance_io,
            cpu_bulk: tokens.cpu_bulk,
        },
        feeds: seams.scoped_feeds.clone(),
        processes: seams.processes.clone(),
        tracked: Arc::new(GixTrackedFiles::new(tokens.maintenance_io)),
        state: seams.state.clone(),
        recovery_dir: seams.recovery_dir.clone(),
        user_data_dir: seams.user_data_dir.clone(),
        // mediaAsset, attachment and export register here as their domains land.
        sources: Vec::new(),
        // The adapter over the shared `CodeGraphTool` lands with the composed tool runtime.
        code_graph: None,
        // The one shared `TurnReviewApi` is handed in by the composition that builds it.
        turn_review: None,
    })
    .map_err(ComposeError::Workspace)?;
    builder.register(workspace)?;
    // Document previews run in the extension host. Node caches converted documents under the
    // desktop profile folder (`userDataPath` in `desktop-operations.ts`), the runtime keeps its
    // own subfolders there.
    let cache_root = seams.user_data_dir.to_string_lossy().into_owned();
    builder.register(Arc::new(DocumentService::new(seams.ext_host.clone(), cache_root)))?;
    // Browser and visualize commands are the desktop host's: the core forwards them over the
    // host channel and the host claims the capability.
    builder.register(Arc::new(BrowserService::new(seams.host.clone())))?;
    builder.register(Arc::new(VisualizeService::new(seams.host.clone())))?;
    Ok(())
}

fn domains(seams: &Seams) -> Result<(Domains, &'static [&'static str]), ComposeError> {
    let mut builder = DomainsBuilder::new();
    register_real(&mut builder, seams)?;
    // Leaked once at start: a service lists its methods as `'static`.
    let mocked: &'static [&'static str] = Box::leak(builder.unclaimed().into_boxed_slice());
    builder.register(Arc::new(MockDomain::serving(mocked)))?;
    Ok((builder.build(), mocked))
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
    /// The server's host channel (`Outgoing`), built before the core: what the browser and
    /// visualize domains forward their commands through.
    pub host: Arc<dyn HostChannel>,
}

pub async fn compose(tokens: &LaneTokens, config: ComposeConfig) -> Result<ComposedCore, ComposeError> {
    let ComposeConfig { data_dir, user_data_dir, js_runtime, ort_library, host } = config;
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
        ExtHostPool::new(ExtHostConfig {
            program: js.program.clone(),
            args: vec![js.package_root.join("src").join("ext-host").join("worker.mjs").into_os_string()],
            electron: js.electron,
            workers: worker_count(None, std::thread::available_parallelism().map_or(1, |n| n.get())),
            pending_cap: DEFAULT_PENDING_CAP,
            spawn_io: tokens.spawn_io,
            render_browser: RenderBrowserConfig {
                command: None,
                profile_root: data_dir.join("render-browser"),
                no_sandbox: false,
            },
        })
        .map_err(ComposeError::ExtHost)?,
    );
    let process_manager: Arc<dyn ProcessManager> =
        Arc::new(LocalProcessManager::new(tokens.spawn_io, ProcessConfig::default()));
    let tidy_processes = Processes::new(process_manager.clone(), tokens.durability_io);
    let (domains, mocked) = domains(&Seams {
        tokens: tokens.clone(),
        state: state.clone(),
        scoped_feeds,
        processes: process_manager,
        recovery_dir: data_dir.join("recovery"),
        user_data_dir,
        ext_host: ext_host.clone(),
        host,
    })?;
    let file_service: Arc<dyn FileService> = Arc::new(LocalFileService::new());
    let models = build_models(tokens, data_dir, ort_library)?;
    // The listing sources are built from the full provider config; the config domain supplies it
    // when it lands, until then only the models.dev metadata is refreshed.
    let catalog = build_catalog(tokens, data_dir, Vec::new()).await.map_err(ComposeError::Catalog)?;
    let shell_path =
        crate::shell_name::resolve_program_current_on(tokens.interactive_io).await.map_err(ComposeError::Shell)?;
    let (exec, exec_events) = build_exec(tokens, data_dir, skill_launcher_dir, shell_path, skill_runtime, ext_host.clone());
    let id = FeedId::from("app");
    let epoch = FeedEpoch::from(new_instance_id());
    let app_feed = Arc::new(CoreFeed::new(
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
    Ok(ComposedCore {
        base: MockCore::new(&[], MockLimits::default()),
        app_feed,
        feed_index,
        ops: CoreOpIndex::new(gates, Arc::new(NoThreadGates)),
        domains,
        mocked,
        exec,
        exec_events: std::sync::Mutex::new(Some(exec_events)),
        ext_host,
        file_service,
        models,
        catalog,
        tidy_processes,
        stop_steps: std::sync::Mutex::new(Vec::new()),
    })
}

#[cfg(test)]
mod tests {
    use mixdog_app_protocol::CLIENT_METHODS;
    use mixdog_app_protocol::CLIENT_NOTIFICATIONS;
    use mixdog_core_domains::domains::CORE_NAMESPACES;
    use mixdog_core_api::CallContext;
    use mixdog_core_api::CoreRequest;
    use mixdog_core_api::Reply;
    use mixdog_core_api::HostCapability;
    use mixdog_core_api::ids::Method;
    use mixdog_core_api::mock::MockHostChannel;
    use serde_json::json;

    use super::*;

    /// The desktop commands reach the host channel the server was built with, through the real
    /// services (not the echo mock), each addressed by its own capability.
    #[tokio::test]
    async fn browser_and_visualize_commands_go_to_the_hosts_channel() {
        let dir = tempfile::tempdir().unwrap();
        let host = Arc::new(MockHostChannel::default());
        host.claim(HostCapability::Browser);
        host.claim(HostCapability::Visualize);
        host.reply(Method("host/browser/command"), json!({ "from": "browser" }));
        host.reply(Method("host/visualize/command"), json!({ "from": "visualize" }));
        let core = compose(
            &mixdog_rt::testing::tokens(),
            ComposeConfig {
                data_dir: dir.path().to_path_buf(),
                user_data_dir: dir.path().join("userdata"),
                js_runtime: crate::js_runtime::fixture(dir.path()),
                ort_library: OrtRuntime::NoBinding,
                host: host.clone(),
            },
        )
        .await
        .unwrap();
        assert!(!core.mocked_domains().contains(&"browser/command"));
        assert!(!core.mocked_domains().contains(&"visualize/command"));

        let call = |method: &'static str, params| CoreRequest {
            method: Method(method),
            params,
            op: None,
            ctx: CallContext::internal("test"),
        };
        let browser = core.domain_for("browser/command").unwrap();
        let Reply::Value(value) = browser.call(call("browser/command", json!({ "action": "hide" }))).await.unwrap() else {
            panic!("a value reply")
        };
        assert_eq!(value, json!({ "from": "browser" }));
        let visualize = core.domain_for("visualize/command").unwrap();
        let params = json!({ "action": "close", "input": { "sessionId": "s", "tabId": "t" } });
        let Reply::Value(value) = visualize.call(call("visualize/command", params)).await.unwrap() else {
            panic!("a value reply")
        };
        assert_eq!(value, json!({ "from": "visualize" }));
        let sent = host.sent();
        assert_eq!(sent.len(), 2);
        assert_eq!((sent[0].0, sent[0].1.as_str()), (HostCapability::Browser, "host/browser/command"));
        assert_eq!((sent[1].0, sent[1].1.as_str()), (HostCapability::Visualize, "host/visualize/command"));
    }

    #[tokio::test]
    async fn every_domain_method_has_a_service() {
        let dir = tempfile::tempdir().unwrap();
        let core = compose(
            &mixdog_rt::testing::tokens(),
            ComposeConfig {
                data_dir: dir.path().to_path_buf(),
                user_data_dir: dir.path().join("userdata"),
                js_runtime: crate::js_runtime::fixture(dir.path()),
                ort_library: OrtRuntime::NoBinding,
                host: Arc::new(MockHostChannel::default()),
            },
        )
        .await.unwrap();
        let table = CLIENT_METHODS
            .iter()
            .map(|spec| spec.method)
            .chain(CLIENT_NOTIFICATIONS.iter().map(|spec| spec.method));
        for method in table {
            let namespace = method.split('/').next().unwrap();
            let service = core.domain_for(method);
            if CORE_NAMESPACES.contains(&namespace) {
                assert!(service.is_none(), "{method} is served by the core itself");
                continue;
            }
            let service = service.unwrap_or_else(|| panic!("{method} has no service"));
            if !core.mocked_domains().contains(&method) {
                continue;
            }
            let reply = service
                .call(CoreRequest {
                    method: Method(method),
                    params: json!({ "n": method }),
                    op: None,
                    ctx: CallContext::internal("test"),
                })
                .await
                .unwrap();
            match reply {
                Reply::Value(value) => assert_eq!(value["params"]["n"], method),
                Reply::Subscribe(_) => panic!("mock domain subscribed"),
            }
        }
    }
}
