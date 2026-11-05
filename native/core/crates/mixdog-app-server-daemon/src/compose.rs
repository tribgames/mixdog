//! The composition root: builds the [`CoreHandle`] the server serves (protocol.md §2.1).
//!
//! Every domain slot (`mixdog_core::domains::DOMAIN_NAMESPACES`) is filled before the core
//! exists. Real services register in [`domains`] as their crates land; a slot still without
//! one gets a [`MockDomain`] that echoes `{method, params}`, and the boot log names those
//! slots, so the wired/mock split is visible at every start. The thread directory, app feed,
//! op index, host media sink and lifecycle are the [`MockCore`] seams until the session core
//! (`mixdog-core::session`, `feed`, `ops`) lands.

use std::path::Path;
use std::path::PathBuf;
use std::sync::Arc;

use mixdog_core::feed::CoreScopedFeeds;
use mixdog_services::effort_judge::judge::EffortJudgeModel;
use mixdog_services::effort_judge::judge::JudgeOptions;
use mixdog_services::effort_judge::model::ModelConfig;
use mixdog_services::memory::embed::config::DEFAULT_MODEL_ID;
use mixdog_services::memory::embed::engine::EmbedConfig;
use mixdog_services::memory::embed::provider::EmbeddingProvider;
use mixdog_services::tool_state::StateTick;
use mixdog_core_api::domain::fs::FileService;
use mixdog_exthost::DEFAULT_PENDING_CAP;
use mixdog_exthost::DocumentService;
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
use mixdog_core_api::ids::ConnectionId;
use mixdog_protocol::Origin;
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
use mixdog_core::ops::CoreOpIndex;
use mixdog_core::ops::OpGate;
use mixdog_core::ops::StateOpStore;
use mixdog_core::ops::ThreadOpGates;
use mixdog_core_api::CallContext;
use mixdog_core_api::CoreError;
use mixdog_core_api::ids::ThreadId;
use mixdog_core_api::ops::OpScope;
use mixdog_store::sqlite::DbError;
use mixdog_store::state::CoreState;

use mixdog_core::domains::Domains;
use mixdog_core::domains::DomainsBuilder;
use mixdog_core::domains::DomainsError;
use mixdog_core::feed::CoreFeed;
use mixdog_core::feed::FeedLimits;
use mixdog_core::state::empty_view;
use mixdog_core_api::CoreHandle;
use mixdog_core_api::ids::FeedEpoch;
use mixdog_core_api::ids::FeedId;
use mixdog_rt::LaneTokens;
use crate::lifecycle::new_instance_id;
use mixdog_core_api::CoreState as LifecycleState;
use mixdog_core_api::DomainService;
use mixdog_core_api::FeedSource;
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

/// The namespaces the workspace service answers.
const WORKSPACE_NAMESPACES: [&str; 6] = ["fs", "lsp", "project", "projectFs", "search", "transfer"];

#[derive(Debug, thiserror::Error)]
pub enum ComposeError {
    #[error("starting the provider catalog: {0}")]
    Catalog(CatalogError),
    #[error("writing the skill launchers: {0}")]
    Launcher(std::io::Error),
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
    ops: CoreOpIndex,
    domains: Domains,
    mocked: Vec<&'static str>,
    exec: Exec,
    exec_events: std::sync::Mutex<Option<ExecEvents>>,
    ext_host: Option<Arc<ExtHostPool>>,
    file_service: Arc<dyn FileService>,
    models: Option<Models>,
    catalog: CatalogHost,
}

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
    pub embeddings: Arc<EmbeddingProvider>,
    pub effort_judge: Arc<EffortJudgeModel>,
}

/// Graph sessions the embedder keeps so concurrent embeds do not queue on one another.
const EMBED_SESSIONS: usize = 2;

fn build_models(tokens: &LaneTokens, data_dir: &Path, ort_library: PathBuf) -> Result<Models, ComposeError> {
    let tick = StateTick::default();
    let embeddings = Arc::new(EmbeddingProvider::with_tick(
        EmbedConfig {
            model_id: DEFAULT_MODEL_ID.into(),
            cache_dir: data_dir.join("models"),
            ort_library: ort_library.clone(),
            dtype: None,
            sessions: EMBED_SESSIONS,
            lane: tokens.cpu_bulk,
        },
        tick.clone(),
    ));
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

    /// The shared render browser for WP-TOOLS-WEB's `BrowserEndpoint`; `None` without a JS runtime.
    pub fn render_browser(&self) -> Option<mixdog_exthost::RenderBrowser> {
        self.ext_host.as_ref().map(|pool| pool.render_browser())
    }

    /// The provider catalog;`catalog().service().catalog()` is what `CatalogTraits::new` takes
    /// (one `CatalogTraits` per provider, built where the provider adapters are).
    pub fn catalog(&self) -> &CatalogHost {
        &self.catalog
    }

    /// The embedding and effort-judge models, when the ONNX Runtime library is known.
    pub fn models(&self) -> Option<&Models> {
        self.models.as_ref()
    }

    /// The core's stop step for the extension host: closes it and returns once every worker
    /// process has exited. Await it before the runtime drops.
    pub async fn close_ext_host(&self) {
        self.catalog.stop();
        if let Some(pool) = &self.ext_host {
            pool.close().await;
        }
    }

    /// The app feed, for the state publisher (`SectionFeedState::new`).
    pub fn app_feed_core(&self) -> &Arc<CoreFeed> {
        &self.app_feed
    }

    /// Slots served by a mock rather than a real crate.
    pub fn mocked_domains(&self) -> &[&'static str] {
        &self.mocked
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

    fn ops(&self) -> &dyn OpIndex {
        &self.ops
    }

    fn domain(&self, namespace: &str) -> Option<&dyn DomainService> {
        self.domains.get(namespace)
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
    origin_of: OriginOf,
    ext_host: Option<Arc<ExtHostPool>>,
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
        origin_of: seams.origin_of.clone(),
    })
    .map_err(ComposeError::Workspace)?;
    for namespace in WORKSPACE_NAMESPACES {
        builder.register(namespace, workspace.clone())?;
    }
    // Document previews run in the extension host; without a JS runtime the slot stays mocked.
    // Node caches converted documents under the desktop profile folder (`userDataPath` in
    // `desktop-operations.ts`), the runtime keeps its own subfolders there.
    if let Some(pool) = &seams.ext_host {
        let cache_root = seams.user_data_dir.to_string_lossy().into_owned();
        builder.register("document", Arc::new(DocumentService::new(pool.clone(), cache_root)))?;
    }
    Ok(())
}

fn domains(seams: &Seams) -> Result<(Domains, Vec<&'static str>), ComposeError> {
    let mut builder = DomainsBuilder::new();
    register_real(&mut builder, seams)?;
    let mocked = builder.unfilled();
    for slot in &mocked {
        builder.register(slot, Arc::new(MockDomain::default()))?;
    }
    Ok((builder.build()?, mocked))
}

/// The origin of a connection, for the workspace's project-boundary check (DS-WS-9).
pub type OriginOf = Arc<dyn Fn(&ConnectionId) -> Origin + Send + Sync>;

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
    /// `None` leaves model shells without skill launchers and the extension host unstarted.
    pub js_runtime: Option<JsRuntime>,
    /// The ONNX Runtime shared library (install layout); `None` leaves the embedding and
    /// effort-judge models unbuilt.
    pub ort_library: Option<PathBuf>,
    pub origin_of: OriginOf,
}

pub async fn compose(tokens: &LaneTokens, config: ComposeConfig) -> Result<ComposedCore, ComposeError> {
    let ComposeConfig { data_dir, user_data_dir, js_runtime, ort_library, origin_of } = config;
    let data_dir = data_dir.as_path();
    let state_dir = data_dir.join("state");
    create_dir(tokens, state_dir.clone()).await.map_err(ComposeError::StateDir)?;
    let (state, _) = CoreState::open(tokens.sqlite_writer_thread, tokens.interactive_io, &state_dir.join("core.sqlite"))
        .map_err(ComposeError::State)?;
    let scoped_feeds: Arc<dyn ScopedFeeds> = Arc::new(CoreScopedFeeds::new(
        FeedLimits { ring_bytes: APP_RING_BYTES, max_snapshot_bytes: MAX_SNAPSHOT_BYTES },
        tokens.cpu_interactive,
    ));
    let (skill_launcher_dir, skill_runtime, ext_host) = match &js_runtime {
        Some(js) => {
            let entry = js.package_root.join("src").join("skill-script-entry.mjs");
            let exec_skills = ExecSkillRuntime {
                platform: node_platform().to_owned(),
                interpreter: js.program.to_string_lossy().into_owned(),
                entry: entry.to_string_lossy().into_owned(),
                electron: js.electron,
            };
            let skills = SkillRuntime::new(js.program.to_string_lossy(), entry.to_string_lossy(), js.electron);
            let dir = skills.ensure_dir(tokens.durability_io, data_dir).await.map_err(ComposeError::Launcher)?;
            let pool = ExtHostPool::new(ExtHostConfig {
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
            .map_err(ComposeError::ExtHost)?;
            (Some(dir), Some(exec_skills), Some(Arc::new(pool)))
        }
        None => (None, None, None),
    };
    let (domains, mocked) = domains(&Seams {
        tokens: tokens.clone(),
        state: state.clone(),
        scoped_feeds,
        processes: Arc::new(LocalProcessManager::new(tokens.spawn_io, ProcessConfig::default())),
        recovery_dir: data_dir.join("recovery"),
        user_data_dir,
        origin_of,
        ext_host: ext_host.clone(),
    })?;
    let file_service: Arc<dyn FileService> = Arc::new(LocalFileService::new());
    let models = ort_library.map(|ort_library| build_models(tokens, data_dir, ort_library)).transpose()?;
    // The listing sources are built from the full provider config; the config domain supplies it
    // when it lands, until then only the models.dev metadata is refreshed.
    let catalog = build_catalog(tokens, data_dir, Vec::new()).await.map_err(ComposeError::Catalog)?;
    let (exec, exec_events) = build_exec(tokens, data_dir, skill_launcher_dir, skill_runtime);
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
        ops: CoreOpIndex::new(gates, Arc::new(NoThreadGates)),
        domains,
        mocked,
        exec,
        exec_events: std::sync::Mutex::new(Some(exec_events)),
        ext_host,
        file_service,
        models,
        catalog,
    })
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeSet;

    use mixdog_app_protocol::CLIENT_METHODS;
    use mixdog_app_protocol::CLIENT_NOTIFICATIONS;
    use mixdog_core::domains::CORE_NAMESPACES;
    use mixdog_core::domains::DOMAIN_NAMESPACES;
    use mixdog_core_api::CallContext;
    use mixdog_core_api::CoreRequest;
    use mixdog_core_api::Reply;
    use mixdog_core_api::ids::Method;
    use serde_json::json;

    use super::*;

    #[test]
    fn domain_slots_match_method_table() {
        let used: BTreeSet<&str> = CLIENT_METHODS
            .iter()
            .map(|spec| spec.method)
            .chain(CLIENT_NOTIFICATIONS.iter().map(|spec| spec.method))
            .filter_map(|method| method.split('/').next())
            .filter(|namespace| !CORE_NAMESPACES.contains(namespace))
            .collect();
        // `model/proxy/event` is a server→client notification listed with the client ones.
        let slots: BTreeSet<&str> = DOMAIN_NAMESPACES.iter().copied().collect();
        assert_eq!(
            used.difference(&slots).collect::<Vec<_>>(),
            Vec::<&&str>::new(),
            "method namespaces without a slot"
        );
        assert_eq!(
            slots.difference(&used).collect::<Vec<_>>(),
            Vec::<&&str>::new(),
            "slots without a method"
        );
    }

    #[tokio::test]
    async fn every_slot_answers() {
        let dir = tempfile::tempdir().unwrap();
        let core = compose(
            &mixdog_rt::testing::tokens(),
            ComposeConfig {
                data_dir: dir.path().to_path_buf(),
                user_data_dir: dir.path().join("userdata"),
                js_runtime: None,
                ort_library: None,
                origin_of: Arc::new(|_| Origin::Local),
            },
        )
        .await.unwrap();
        let mocked: Vec<&str> =
            DOMAIN_NAMESPACES.iter().copied().filter(|n| !WORKSPACE_NAMESPACES.contains(n)).collect();
        assert_eq!(core.mocked_domains(), mocked);
        for namespace in mocked {
            let service = core.domain(namespace).unwrap();
            let reply = service
                .call(CoreRequest {
                    method: Method("x/y"),
                    params: json!({ "n": namespace }),
                    op: None,
                    ctx: CallContext::internal("test"),
                })
                .await
                .unwrap();
            match reply {
                Reply::Value(value) => assert_eq!(value["params"]["n"], namespace),
                Reply::Subscribe(_) => panic!("mock domain subscribed"),
            }
        }
        for namespace in CORE_NAMESPACES {
            assert!(core.domain(namespace).is_none());
        }
    }
}
