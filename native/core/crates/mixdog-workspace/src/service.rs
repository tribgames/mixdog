//! The workspace `DomainService`: maps the `project/*`, `projectFs/*`, `fs/*`,
//! `search/*`, `transfer/*` and `lsp/*` wire methods to this crate's services.
//! Blocking file work runs on its lane (reads interactive, writes durability,
//! walks/searches/zips maintenance); mutations hold their path claims first.
//! Every `root` is resolved through the project registry, which is also the
//! project-boundary table for relay origins (DS-WS-9).

use std::path::Path;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::OnceLock;
use std::sync::Weak;
use tokio_util::sync::CancellationToken;

use async_trait::async_trait;
use bytes::Bytes;
use mixdog_core_api::call::CoreRequest;
use mixdog_core_api::call::Reply;
use mixdog_core_api::call::Subscribe;
use mixdog_core_api::error::CoreError;
use mixdog_core_api::error::Precondition;
use mixdog_core_api::feed::ScopedFeeds;
use mixdog_core_api::host::HostCapability;
use mixdog_core_api::host::HostChannel;
use mixdog_core_api::host::HostError;
use mixdog_core_api::feed::Window;
use mixdog_core_api::ids::ConnectionId;
use mixdog_core_api::ids::Method;
use mixdog_core_api::service::Admit;
use mixdog_core_api::service::DomainService;
use serde_json::Value;
use serde_json::json;
use std::collections::HashMap;

use crate::catalog::Catalog;
use crate::catalog::OpRecord;
use mixdog_store::state::OpRow;
use mixdog_store::state::OpRowState;
use crate::claims::Claims;
use crate::claims::path_claims;
use crate::error::Reason;
use crate::error::WsError;
use crate::error::WsResult;
use crate::feedpub::Publisher;
use crate::fsops;
use crate::fsops::BatchFile;
use crate::fsops::ProjectFs;
use crate::lanes::Lanes;
use crate::lanes::run_fallible;
use crate::lsp::DocumentInput;
use crate::lsp::LspManager;
use crate::lsp::LspSink;
use crate::pathguard::canonical;
use crate::pathguard::canonical_through_existing;
use crate::pathguard::lexical;
use crate::pathguard::project_entry_path;
use crate::recovery::Action;
use crate::recovery::RecoveryStore;
use crate::search::SearchSessions;
use crate::search::SessionConfig;
use crate::textsearch::TextQuery;
use crate::transfer::Transfers;
use crate::watcher::ChangeKind;
use crate::watcher::ChangeSink;
use crate::watcher::FolderWatcher;

/// Routes watcher batches: `fs:` watches publish `fs/changed`; `idx:` watches
/// mark a search index stale.
struct Router {
    fs: Mutex<HashMap<String, Arc<Publisher>>>,
    search: OnceLock<Weak<SearchSessions>>,
}

impl ChangeSink for Router {
    fn changed(&self, watch_id: &str, paths: Vec<String>, kind: ChangeKind) {
        if let Some(rest) = watch_id.strip_prefix("idx:") {
            let Some((session, root)) = rest.rsplit_once(':') else { return };
            if let (Some(search), Ok(root)) = (self.search.get().and_then(Weak::upgrade), root.parse()) {
                search.invalidate(session, root);
            }
            return;
        }
        let publisher = self.fs.lock().expect("fs watches").get(watch_id).cloned();
        if let Some(publisher) = publisher {
            publisher.publish("fs/changed", json!({ "watchId": watch_id, "changedPaths": paths, "kind": kind.as_str() }), None);
        }
    }
}

/// One project's feed `lsp:<root>`: its sections' revisions and the read model a late subscriber's
/// snapshot carries (`{section: {key: {revision, value}}}`).
struct LspProject {
    publisher: Publisher,
    revisions: HashMap<(&'static str, String), u64>,
    state: Value,
}

pub(crate) struct LspFeeds {
    feeds: Arc<dyn ScopedFeeds>,
    by_project: Mutex<HashMap<String, LspProject>>,
}

/// Node's `statusKey` (`renderer/editor-language-store.ts:135`) without the project, which the feed
/// already names: the language, and the file too when the server answered for one document.
fn lsp_status_key(event: &Value) -> String {
    let language = event["languageId"].as_str().unwrap_or_default();
    match event["relPath"].as_str().filter(|r| !r.is_empty()) {
        Some(rel) => format!("{language}\0{}", rel.replace('\\', "/").to_lowercase()),
        None => language.to_owned(),
    }
}

impl LspFeeds {
    pub(crate) fn new(feeds: Arc<dyn ScopedFeeds>) -> Self {
        Self { feeds, by_project: Mutex::default() }
    }

    /// The project's feed, as `lsp/subscribe` attaches to it (created on first use).
    pub(crate) fn source(&self, project: &str) -> Arc<dyn mixdog_core_api::feed::FeedSource> {
        self.with(project, |p| p.publisher.source())
    }

    fn with<R>(&self, project: &str, f: impl FnOnce(&mut LspProject) -> R) -> R {
        let mut projects = self.by_project.lock().expect("lsp feeds");
        let entry = projects.entry(project.to_owned()).or_insert_with(|| LspProject {
            publisher: Publisher::create(self.feeds.as_ref(), &format!("lsp:{project}"), json!({})),
            revisions: HashMap::new(),
            state: json!({}),
        });
        f(entry)
    }

    /// Publishes one section update and folds it into the read model. An empty diagnostics list
    /// is still published (it is what clears the document on the client) but leaves the model.
    fn publish(&self, project: &str, section: &'static str, key: String, method: &str, value: Value, clears: bool) {
        self.with(project, |p| {
            let revision = p.revisions.entry((section, key.clone())).or_insert(0);
            *revision += 1;
            let revision = *revision;
            let rows = p.state[section].as_object().cloned().unwrap_or_default();
            let mut rows = rows;
            if clears {
                rows.shift_remove(&key);
            } else {
                rows.insert(key.clone(), json!({ "revision": revision, "value": value.clone() }));
            }
            p.state[section] = Value::Object(rows);
            let state = p.state.clone();
            p.publisher.publish(method, json!({ "section": section, "key": key, "revision": revision, "value": value }), Some(state));
        });
    }
}

impl LspSink for LspFeeds {
    fn status(&self, event: Value) {
        let project = event["projectPath"].as_str().unwrap_or_default().to_owned();
        let key = lsp_status_key(&event);
        self.publish(&project, "lspStatus", key, "lsp/status/updated", event, false);
    }

    fn diagnostics(&self, event: Value) {
        let project = event["projectPath"].as_str().unwrap_or_default().to_owned();
        let uri = event["uri"].as_str().unwrap_or_default().to_owned();
        let clears = event["diagnostics"].as_array().is_none_or(Vec::is_empty);
        self.publish(&project, "lspDiagnostics", uri, "lsp/diagnostics/updated", event, clears);
    }
}

pub struct Deps {
    pub lanes: Lanes,
    pub feeds: Arc<dyn ScopedFeeds>,
    pub processes: Arc<dyn mixdog_core_api::domain::process::ProcessManager>,
    /// The SCM engine's file list for zips (WP-SCM implements it).
    pub tracked: Arc<dyn crate::zip::TrackedFiles>,
    /// The core state store: project rows and op records.
    pub state: mixdog_store::state::CoreState,
    /// Host-private recovery journals live here, outside every project.
    pub recovery_dir: PathBuf,
    /// The desktop profile folder: editor backups, User/settings.json, the task workspace.
    pub user_data_dir: PathBuf,
    /// Transfer sources other domains serve (`mediaAsset`, `attachment`, `export`).
    pub sources: Vec<Arc<dyn crate::transfer::TransferSource>>,
    /// The shared `code_graph` tool, adapted (`project/codeGraph`); `None` answers `unsupported`.
    pub code_graph: Option<Arc<dyn CodeGraph>>,
    /// The turn review (`noteTurnWorktreeChange`): told of every change the service makes itself.
    /// Watcher batches are not told, as in Node, where the native search watcher is `canonical`
    /// and turn review capture follows tool boundaries only. `None` tells no one.
    pub turn_review: Option<Arc<dyn mixdog_core_api::turn_review::TurnReviewApi>>,
    /// The one "a folder is going away" hook set: `project/delete` runs it, worktree removal runs
    /// the same set. The language servers register here.
    pub releases: Arc<crate::release::FolderReleases>,
}

/// The language servers rooted in a folder that goes away.
struct LspRelease(Arc<LspManager>);

#[async_trait::async_trait]
impl crate::release::FolderRelease for LspRelease {
    fn name(&self) -> &str {
        "language servers"
    }
    async fn release_under(&self, root: &Path) -> Result<(), String> {
        self.0.dispose_under(root).await;
        Ok(())
    }
}

/// `project/codeGraph` runs the agent tools' `code_graph` tool (one instance, one cache): `args`
/// is the tool's own JSON with `cwd` the project, and the answer is the tool's text.
#[async_trait::async_trait]
pub trait CodeGraph: Send + Sync + 'static {
    async fn query(&self, cwd: &Path, args: Value, cancel: &tokio_util::sync::CancellationToken) -> WsResult<String>;
}

struct Owned {
    connection: String,
    publisher: Arc<Publisher>,
}

/// The paired devices' grants: the store and how a connection maps to its paired device.
struct PhoneGrants {
    store: Arc<crate::grants::GrantStore>,
    credential_of: Arc<dyn Fn(ConnectionId) -> Option<String> + Send + Sync>,
}

pub struct WorkspaceService {
    me: OnceLock<Weak<WorkspaceService>>,
    feeds: Arc<dyn ScopedFeeds>,
    lanes: Lanes,
    catalog: Catalog,
    fs: Arc<ProjectFs>,
    paths: Claims<PathBuf>,
    transfers: Arc<Transfers>,
    /// The file previews' media leases (`media-leases.ts`), served by the media lane through [`WorkspaceService::file_leases`].
    file_leases: Arc<crate::preview::FileLeases>,
    /// The text reads answered a window at a time, each held as the one read of its file ([`crate::readwindow`]).
    read_windows: crate::readwindow::ReadWindows,
    watcher: Arc<FolderWatcher>,
    router: Arc<Router>,
    watches: Mutex<HashMap<String, Owned>>,
    search: Arc<SearchSessions>,
    search_owner: Mutex<HashMap<String, String>>,
    lsp: Arc<LspManager>,
    lsp_feeds: Arc<LspFeeds>,
    sources: Vec<Arc<dyn crate::transfer::TransferSource>>,
    code_graph: Option<Arc<dyn CodeGraph>>,
    turn_review: Option<Arc<dyn mixdog_core_api::turn_review::TurnReviewApi>>,
    backups: Arc<crate::editorcfg::Backups>,
    user_data: PathBuf,
    tracked: Arc<dyn crate::zip::TrackedFiles>,
    state: mixdog_store::state::CoreState,
    /// The desktop host's channel, for the methods only an Electron window can answer.
    host: OnceLock<Arc<dyn HostChannel>>,
    phone_grants: OnceLock<PhoneGrants>,
    /// The user's Markdown default view, read when editor settings are (see [`Self::set_user_markdown_view`]).
    user_markdown_view: OnceLock<UserMarkdownView>,
    /// Where a path inside a managed worktree is resolved to its owner Project (see [`ManagedProjects`]).
    managed: OnceLock<Arc<dyn ManagedProjects>>,
    releases: Arc<crate::release::FolderReleases>,
}

/// Node's `resolveManagedWorktree`, which the worktree manager owns: the registered Project that owns the ready managed
/// worktree at (or below) a path, and the folder's real path.
#[async_trait::async_trait]
pub trait ManagedProjects: Send + Sync {
    async fn owner(&self, path: &str) -> Option<(String, String)>;
}

/// Reads the user's Markdown default view.
type UserMarkdownView = Arc<dyn Fn() -> Option<String> + Send + Sync>;

fn s<'a>(params: &'a Value, key: &str) -> WsResult<&'a str> {
    params.get(key).and_then(Value::as_str).ok_or_else(|| WsError::invalid(format!("{key} is invalid.")))
}

/// Largest staged upload and its chunk size (`shared/server-files.ts`).
use crate::transfer::{UPLOAD_CHUNK_BYTES, UPLOAD_MAX_BYTES};

fn opt_bool(params: &Value, key: &str) -> bool {
    params.get(key).and_then(Value::as_bool).unwrap_or(false)
}

fn text_query(options: &Value) -> WsResult<TextQuery> {
    let text = |k: &str| options.get(k).and_then(Value::as_str).unwrap_or_default().to_owned();
    let query = text("query");
    if query.is_empty() || query.len() > 1000 {
        return Err(WsError::invalid("Search query is invalid."));
    }
    Ok(TextQuery {
        query,
        regex: opt_bool(options, "regex"),
        match_case: opt_bool(options, "matchCase"),
        whole_word: opt_bool(options, "wholeWord"),
        include: text("include"),
        exclude: text("exclude"),
        max_results: options.get("maxResults").and_then(Value::as_u64).map(|n| n as usize),
    })
}

impl WorkspaceService {
    pub fn new(deps: Deps) -> WsResult<Arc<Self>> {
        let router = Arc::new(Router { fs: Mutex::default(), search: OnceLock::new() });
        let watcher = Arc::new(FolderWatcher::new(router.clone())?);
        let search = SearchSessions::new(deps.lanes, deps.feeds.clone(), watcher.clone());
        let _ = router.search.set(Arc::downgrade(&search));
        let lsp_feeds = Arc::new(LspFeeds::new(deps.feeds.clone()));
        let lsp = LspManager::new(deps.processes.clone(), lsp_feeds.clone(), deps.lanes.maintenance);
        deps.releases.add(Arc::new(LspRelease(lsp.clone())));
        let service = Arc::new(Self {
            me: OnceLock::new(),
            feeds: deps.feeds.clone(),
            lanes: deps.lanes,
            catalog: Catalog::new(deps.state.clone(), deps.lanes),
            fs: Arc::new(ProjectFs::new(Arc::new(RecoveryStore::new(deps.recovery_dir)))),
            paths: path_claims(),
            transfers: Arc::new(Transfers::default()),
            file_leases: Arc::default(),
            read_windows: crate::readwindow::ReadWindows::default(),
            watcher,
            router,
            watches: Mutex::default(),
            search,
            search_owner: Mutex::default(),
            lsp,
            lsp_feeds,
            sources: deps.sources,
            code_graph: deps.code_graph,
            turn_review: deps.turn_review,
            tracked: deps.tracked,
            backups: Arc::new(crate::editorcfg::Backups::new(&deps.user_data_dir)),
            user_data: deps.user_data_dir,
            state: deps.state,
            host: OnceLock::new(),
            phone_grants: OnceLock::new(),
            user_markdown_view: OnceLock::new(),
            managed: OnceLock::new(),
            releases: deps.releases,
        });
        let _ = service.me.set(Arc::downgrade(&service));
        Ok(service)
    }

    /// Starts the idle sweep of abandoned uploads on the daemon's runtime, the work of Node's
    /// per-upload `setTimeout(idleMs)`: it sleeps to the earliest idle deadline and sweeps then, so a
    /// partial file does not wait for the next upload call. Call once after construction.
    pub fn spawn_idle_sweeper(&self) {
        let (transfers, lanes) = (self.transfers.clone(), self.lanes);
        drop(mixdog_rt::spawn("upload-idle-sweep", mixdog_rt::TaskClass::Work, async move {
            let cancel = CancellationToken::new();
            loop {
                transfers.wait_idle_due(&crate::transfer::TokioTimer).await;
                let sweeping = transfers.clone();
                let _ = run_fallible(lanes.durability, &cancel, move || {
                    sweeping.sweep_idle();
                    Ok(())
                })
                .await;
            }
        }));
    }
    /// The media leases a file preview minted: the media lane resolves a `mediaAssetId` through them.
    pub fn file_leases(&self) -> Arc<crate::preview::FileLeases> {
        self.file_leases.clone()
    }
    pub fn catalog(&self) -> &Catalog {
        &self.catalog
    }

    /// Connects the host channel `projectFs/captureSnapshot` and `projectFs/localPageUrl` go
    /// through; without one they answer `capabilityUnavailable`. Set once.
    pub fn set_host(&self, host: Arc<dyn HostChannel>) {
        let _ = self.host.set(host);
    }

    /// Connects where the user's Markdown default view is stored (the config key `desktop.editor.markdownDefaultView`;
    /// `projectFs/readEditorSettings` puts it in the user scope, where Node reads `mixdog.markdown.defaultView` from the
    /// user settings file). Without it only the settings file is read. Set once.
    pub fn set_user_markdown_view(&self, read: Arc<dyn Fn() -> Option<String> + Send + Sync>) {
        let _ = self.user_markdown_view.set(read);
    }

    /// Connects the worktree manager's resolution of a managed worktree path to its owner Project. Without it only a
    /// registered Project's own path is accepted. Set once.
    pub fn set_managed_projects(&self, managed: Arc<dyn ManagedProjects>) {
        let _ = self.managed.set(managed);
    }

    /// Node's `projectScope`: the registered Project a path names, or the owner of the managed worktree it names (with
    /// that worktree's folder). Any other path is the registry's refusal.
    async fn scope(&self, path: &str) -> WsResult<(PathBuf, Option<PathBuf>)> {
        let refusal = match self.catalog.resolve(path).await {
            Ok(project) => return Ok((project, None)),
            Err(refusal) => refusal,
        };
        let owned = match self.managed.get() {
            Some(managed) => managed.owner(path).await,
            None => None,
        };
        owned.map(|(project, folder)| (PathBuf::from(project), Some(PathBuf::from(folder)))).ok_or(refusal)
    }

    /// Connects the paired devices' one-file grants (`transfer/grant/mint` and the `granted` read source): the
    /// store, and the credential a relay connection is paired as. Without it both answer `unsupported`. Set once.
    pub fn set_phone_grants(
        &self,
        store: Arc<crate::grants::GrantStore>,
        credential_of: Arc<dyn Fn(ConnectionId) -> Option<String> + Send + Sync>,
    ) {
        let _ = self.phone_grants.set(PhoneGrants { store, credential_of });
    }

    /// The grant store and the paired device the request comes from.
    fn phone_grants_for(&self, req: &CoreRequest) -> WsResult<(Arc<crate::grants::GrantStore>, String, u64)> {
        let grants = self
            .phone_grants
            .get()
            .ok_or_else(|| WsError::new(Reason::Unsupported, "Paired-device file grants are not available."))?;
        let (credential, connection) = match &req.ctx.caller {
            mixdog_core_api::call::Caller::Connection(id) => ((grants.credential_of)(*id), id.0),
            mixdog_core_api::call::Caller::Internal(_) => (None, 0),
        };
        let credential = credential.filter(|id| !id.is_empty()).ok_or_else(|| WsError::denied("This connection is not a paired device."))?;
        Ok((grants.store.clone(), credential, connection))
    }

    /// One `host/*` request to the desktop's file capability, its failure mapped to the coded
    /// domain error every host-forwarded method answers with.
    async fn host_files(&self, method: &'static str, params: Value) -> Result<Value, CoreError> {
        let Some(host) = self.host.get() else {
            return Err(CoreError::CapabilityUnavailable { capability: "desktopHost".into(), detail: "noClaimant".into() });
        };
        match host.request(HostCapability::Files, Method(method), params).await {
            Ok(value) => Ok(value),
            Err(HostError::Core(error)) => Err(error),
            Err(HostError::Rpc { message, .. }) => Err(CoreError::DomainError {
                domain: "workspace".into(),
                code: Some("HOST_COMMAND_FAILED".into()),
                message: Some(message.into()),
                detail: None,
            }),
        }
    }

    pub fn open_os_watches(&self) -> usize {
        self.watcher.open_watches()
    }

    /// A connection closed: its watches, searches and transfers end with it.
    pub fn connection_closed(&self, connection: &ConnectionId) {
        let owner = connection.to_string();
        self.transfers.end_owner(&owner);
        if let Some(grants) = self.phone_grants.get() {
            grants.store.release(connection.0);
        }
        let watches: Vec<String> =
            self.watches.lock().expect("watches").iter().filter(|(_, w)| w.connection == owner).map(|(k, _)| k.clone()).collect();
        for id in watches {
            self.unwatch(&id);
        }
        let sessions: Vec<String> =
            self.search_owner.lock().expect("search owners").iter().filter(|(_, c)| **c == owner).map(|(k, _)| k.clone()).collect();
        for id in sessions {
            self.search_owner.lock().expect("search owners").remove(&id);
            self.search.stop(&id);
        }
    }

    pub fn revoke_device(&self, device: &str) {
        self.transfers.end_owner(device);
    }

    fn unwatch(&self, id: &str) {
        self.router.fs.lock().expect("fs watches").remove(id);
        if let Some(owned) = self.watches.lock().expect("watches").remove(id) {
            owned.publisher.close();
        }
        self.watcher.unwatch(id);
    }

    fn map_error(&self, req: &CoreRequest, error: WsError) -> CoreError {
        // The phone's adapter asks for `nodeErrors`: an entry beyond the project is Node's plain `Error` there (a code-less `domainError`);
        // every other caller keeps the permission refusal.
        let error = if req.params.get("nodeErrors") == Some(&Value::Bool(true)) && crate::pathguard::is_beyond_project(&error) { WsError::plain(error.message) } else { error };
        match error.reason {
            Reason::InvalidParams => CoreError::InvalidParams { path: "params".into(), expected: error.message.into() },
            Reason::PermissionDenied => {
                CoreError::PermissionDenied { method: req.method.as_str().into(), origin: req.ctx.origin }
            }
            Reason::PreconditionFailed { expected, actual } => CoreError::PreconditionFailed {
                precondition: Precondition::Content { expected: Some(Bytes::from(expected)), actual: Some(Bytes::from(actual)) },
            },
            Reason::Overloaded => CoreError::QueueFull { queue: "workspace".into() },
            Reason::Cancelled => CoreError::Cancelled { by: "caller".into() },
            Reason::Plain => CoreError::DomainError { domain: "workspace".into(), code: None, message: Some(error.message.clone().into()), detail: None },
            ref other => CoreError::DomainError { domain: "workspace".into(), code: Some(other.code().into()), message: Some(error.message.clone().into()), detail: None },
        }
    }

    async fn root(&self, origin: mixdog_protocol::Origin, params: &Value) -> WsResult<PathBuf> {
        self.root_of(origin, params, "root").await
    }

    /// The folder a request works in. A local or SSH connection names any absolute folder (Node's
    /// `…In` operations take a root the window already resolved); a relay connection is held to
    /// the registered projects (DS 4.2: origin rules are data).
    async fn root_of(&self, origin: mixdog_protocol::Origin, params: &Value, key: &str) -> WsResult<PathBuf> {
        match origin {
            mixdog_protocol::Origin::Relay => self.catalog.resolve(s(params, key)?).await,
            mixdog_protocol::Origin::Local | mixdog_protocol::Origin::Ssh => crate::pathguard::absolute_local_path(s(params, key)?),
        }
    }

    /// Files this service itself changed, as absolute paths (Node's cache invalidation of a tool
    /// write: `noteTurnWorktreeChange(paths)`).
    fn note_written<S: AsRef<str>>(&self, root: &Path, rels: &[S]) {
        if let Some(review) = &self.turn_review {
            let paths: Vec<String> = rels.iter().map(|r| crate::pathguard::lexical(&root.join(r.as_ref())).to_string_lossy().into_owned()).collect();
            review.note_change(Some(&paths));
        }
    }

    /// A change that names no file: anything may have changed (`noteTurnWorktreeChange(null)`).
    fn note_anything(&self) {
        if let Some(review) = &self.turn_review {
            review.note_change(None);
        }
    }

    /// Lexical paths and their resolved aliases: a queued operation must not be
    /// redirected by a link changed while it waited.
    fn claim_keys(root: &Path, rels: &[&str]) -> WsResult<Vec<PathBuf>> {
        let mut keys = Vec::new();
        for rel in rels {
            let path = project_entry_path(root, rel)?;
            keys.push(canonical_through_existing(&path)?);
            keys.push(path);
        }
        Ok(keys)
    }

    /// The folder and name an editor call works on. With an `accessToken` (a paired device's one-file grant) `root` and
    /// `rel` are Node's `projectPath` and `relPath`, redeemed to the granted file (`remoteFileTarget`); without one, a root
    /// by the connection's origin and `rel`.
    async fn file_target(&self, req: &CoreRequest, params: &Value) -> WsResult<(PathBuf, String)> {
        if let Some(token) = params.get("accessToken") {
            let (grants, credential, connection) = self.phone_grants_for(req)?;
            let token = token.as_str().ok_or_else(|| WsError::invalid("accessToken is invalid."))?;
            let granted = grants.redeem(&credential, connection, token, s(params, "root")?, s(params, "rel")?).await?;
            return Ok((granted.root, granted.rel));
        }
        Ok((self.root(req.ctx.origin, params).await?, s(params, "rel")?.to_owned()))
    }

    fn owner(req: &CoreRequest) -> String {
        match &req.ctx.caller {
            mixdog_core_api::call::Caller::Connection(id) => id.to_string(),
            mixdog_core_api::call::Caller::Internal(name) => (*name).to_owned(),
        }
    }

    async fn dispatch(self: &Arc<Self>, req: &CoreRequest, op: Option<OpRecord>) -> WsResult<Reply> {
        let params = &req.params;
        let cancel = req.ctx.cancel.clone();
        let this = self.clone();
        let value = |v: Value| Ok(Reply::Value(v));
        match req.method.as_str() {
            "project/list" => {
                let projects: Vec<Value> = self.catalog.list().await?.iter().map(crate::catalog::project_json).collect();
                value(json!({ "projects": projects }))
            }
            "project/read" => {
                let path = self.catalog.resolve(s(params, "path")?).await?;
                let probe = path.clone();
                let (exists, directory) = run_fallible(self.lanes.interactive, &cancel, move || {
                    #[allow(clippy::disallowed_methods, reason = "lane job")]
                    Ok((probe.exists(), probe.is_dir()))
                })
                .await?;
                value(json!({ "path": path.to_string_lossy(), "exists": exists, "directory": directory }))
            }
            "project/create" => value(json!({ "project": self.catalog.add(s(params, "path")?, &cancel, op).await? })),
            "project/touch" => {
                // Node's `touchProject` takes the registered Project (`knownProject`: a managed worktree names its owner).
                let (project, _) = self.scope(s(params, "path")?).await?;
                value(json!({ "project": self.catalog.touch(&project.to_string_lossy(), op).await? }))
            }
            "project/update" => {
                let alias = params.get("alias").and_then(Value::as_str).unwrap_or_default();
                value(json!({ "project": self.catalog.rename(s(params, "path")?, alias, op).await? }))
            }
            "project/delete" => {
                // What holds the removed folder open is released with it (DS §4.1: Node's
                // `lspDisposeUnder` / `termDisposeUnder`); a hook that fails is named in the answer.
                let path = s(params, "path")?;
                let mut removed = self.catalog.remove(path, op).await?;
                let failures = self.releases.release_under(Path::new(path)).await;
                if !failures.is_empty() {
                    removed["releaseFailures"] =
                        failures.iter().map(|f| json!({ "name": f.name, "error": f.error })).collect();
                }
                value(removed)
            }
            "project/ensureDirectory" => {
                let path = self.catalog.ensure_directory(s(params, "path")?, &cancel).await?;
                value(json!({ "path": path.to_string_lossy() }))
            }
            "project/directory" => {
                // `projectDirectory`: the managed worktree's folder, else the Project's real path. `owner` asks for the
                // Project's real path even for a worktree (`startProjectTask`'s `canonicalDirectory(knownProject(path))`).
                let (project, worktree) = self.scope(s(params, "path")?).await?;
                let folder = match worktree.filter(|_| !opt_bool(params, "owner")) {
                    Some(folder) => folder,
                    None => {
                        let given = project.to_string_lossy().into_owned();
                        run_fallible(self.lanes.interactive, &cancel, move || crate::catalog::canonical_directory(&project, &given)).await?
                    }
                };
                value(json!({ "path": folder.to_string_lossy() }))
            }
            "project/recoveryDirectory" => {
                let root = self.catalog.resolve(s(params, "path")?).await?;
                value(json!({ "path": self.fs.recovery.store_path(&root).to_string_lossy() }))
            }            "projectFs/listDir" => {
                let (root, rel) = (self.root(req.ctx.origin, params).await?, s(params, "rel")?.to_owned());
                let items = run_fallible(self.lanes.interactive, &cancel, move || fsops::list_dir(&root, &rel)).await?;
                value(json!(items))
            }
            "projectFs/readText" => {
                // A connection carries at most 512 KiB per answer, a file up to 10 MiB: the reader asks for the text a window at a time
                // (code points, so no character is split) and joins the pieces. The first window reads the file once; `readId` names that
                // read, and the windows after it are served from it (readwindow.rs), so the pieces are one version of the file.
                let max = req.params.get("maxChars").and_then(Value::as_u64).map(|max| max as usize);
                if let (Some(max), Some(id)) = (max, req.params.get("readId").and_then(Value::as_str)) {
                    let from = req.params.get("fromChar").and_then(Value::as_u64).unwrap_or(0) as usize;
                    return value(self.read_windows.next(&Self::owner(req), id, from, max)?);
                }
                let (root, rel) = self.file_target(req, params).await?;
                let authorized = opt_bool(params, "authorized");
                let file = run_fallible(self.lanes.interactive, &cancel, move || {
                    if authorized { fsops::read_text_authorized(&root, &rel) } else { fsops::read_text(&root, &rel) }
                })
                .await?;
                let answer = json!(file);
                value(match max {
                    Some(max) => self.read_windows.begin(&Self::owner(req), answer, max),
                    None => answer,
                })
            }
            "projectFs/stat" => {
                let (root, rel) = self.file_target(req, params).await?;
                value(json!(run_fallible(self.lanes.interactive, &cancel, move || fsops::stat(&root, &rel)).await?))
            }
            "projectFs/entryPath" => {
                let (root, rel) = self.file_target(req, params).await?;
                value(json!({ "path": project_entry_path(&root, &rel)?.to_string_lossy() }))
            }
            "projectFs/browseDirs" => {
                let path = s(params, "path")?.to_owned();
                let include_hidden = params.get("includeHidden").and_then(Value::as_bool);
                value(run_fallible(self.lanes.interactive, &cancel, move || crate::browse::browse_dirs(&path, include_hidden)).await?)
            }
            "projectFs/previewFile" => {
                let (root, rel) = self.file_target(req, params).await?;
                let leases = self.file_leases.clone();
                value(run_fallible(self.lanes.interactive, &cancel, move || crate::preview::preview_file(&leases, &root, &rel)).await?)
            }
            "projectFs/previewRange" => {
                let (root, rel) = self.file_target(req, params).await?;
                let offset = params.get("offset").and_then(Value::as_u64).ok_or_else(|| WsError::invalid("offset is invalid."))?;
                let length = params.get("length").and_then(Value::as_u64).filter(|n| (1..=crate::preview::RANGE_MAX).contains(n)).ok_or_else(|| WsError::invalid("length is invalid."))?;
                value(run_fallible(self.lanes.interactive, &cancel, move || crate::preview::preview_range(&root, &rel, offset, length)).await?)
            }
            "projectFs/readLocal" => {
                let path = s(params, "path")?.to_owned();
                value(json!(run_fallible(self.lanes.interactive, &cancel, move || fsops::read_local(&path)).await?))
            }
            "projectFs/statLocal" => {
                let paths: Vec<String> = params
                    .get("paths")
                    .and_then(Value::as_array)
                    .ok_or_else(|| WsError::invalid("paths is invalid."))?
                    .iter()
                    .filter_map(|p| p.as_str().map(str::to_owned))
                    .collect();
                let entries = run_fallible(self.lanes.interactive, &cancel, move || {
                    Ok(paths.iter().map(|p| fsops::stat_local(p).map(|e| json!(e)).unwrap_or_else(|e| json!({ "error": e.message }))).collect::<Vec<_>>())
                })
                .await?;
                value(json!(entries))
            }
            "projectFs/writeText" => {
                let (root, rel) = self.file_target(req, params).await?;
                let (content, expected) = (s(params, "content")?.to_owned(), s(params, "expectedContent")?.to_owned());
                let encoding = params.get("encoding").and_then(Value::as_str).map(fsops::parse_encoding).transpose()?;
                let _claim = self.paths.acquire(Self::claim_keys(&root, &[&rel])?).await;
                let fs = self.fs.clone();
                let (note_root, note_rel) = (root.clone(), rel.clone());
                let mtime = run_fallible(self.lanes.durability, &cancel, move || fs.write_text(&root, &rel, &content, &expected, encoding)).await?;
                self.note_written(&note_root, &[&note_rel]);
                value(json!({ "mtimeMs": mtime }))
            }
            "projectFs/writeTextBatch" => {
                let root = self.root(req.ctx.origin, params).await?;
                let files = Self::batch_files(params)?;
                let rels: Vec<&str> = files.iter().map(|f| f.rel_path.as_str()).collect();
                let _claim = self.paths.acquire(Self::claim_keys(&root, &rels)?).await;
                let fs = self.fs.clone();
                let (note_root, note_rels) = (root.clone(), files.iter().map(|f| f.rel_path.clone()).collect::<Vec<_>>());
                run_fallible(self.lanes.durability, &cancel, move || fs.write_batch(&root, &files, true)).await?;
                self.note_written(&note_root, &note_rels);
                value(json!({}))
            }
            "projectFs/create" => {
                let root = self.root(req.ctx.origin, params).await?;
                let (dir, name, directory) = (s(params, "relDir")?.to_owned(), s(params, "name")?.to_owned(), opt_bool(params, "directory"));
                // Node names the segments invalid before it joins and claims the path.
                fsops::entry_segments(&name)?;
                let target = PathBuf::from(&dir).join(name.replace('\\', "/"));
                let _claim = self.paths.acquire(Self::claim_keys(&root, &[&target.to_string_lossy()])?).await;
                let note_root = root.clone();
                run_fallible(self.lanes.durability, &cancel, move || fsops::create_entry(&root, &dir, &name, directory)).await?;
                self.note_written(&note_root, &[&target.to_string_lossy()]);
                value(json!({}))
            }
            "projectFs/rename" => {
                let root = self.root(req.ctx.origin, params).await?;
                let (rel, new_name) = (s(params, "rel")?.to_owned(), s(params, "newName")?.to_owned());
                let destination = fsops::rename_destination_rel(&rel, &new_name)?;
                let _claim = self.paths.acquire(Self::claim_keys(&root, &[&rel, &destination])?).await;
                let (note_root, note_rel) = (root.clone(), rel.clone());
                run_fallible(self.lanes.durability, &cancel, move || fsops::rename_entry(&root, &rel, &new_name)).await?;
                self.note_written(&note_root, &[&note_rel, &destination]);
                value(json!({}))
            }
            "projectFs/move" | "projectFs/copy" => {
                let root = self.root(req.ctx.origin, params).await?;
                let (rel, target) = (s(params, "rel")?.to_owned(), s(params, "targetDirRel")?.to_owned());
                let _claim = self.paths.acquire(Self::claim_keys(&root, &[&rel, &target])?).await;
                let note_root = root.clone();
                let leaf = |rel: &str| rel.rsplit('/').next().unwrap_or_default().to_owned();
                if req.method.as_str() == "projectFs/move" {
                    let (from, to) = (rel.clone(), format!("{}/{}", target, leaf(&rel)));
                    run_fallible(self.lanes.durability, &cancel, move || fsops::move_entry(&root, &rel, &target)).await?;
                    self.note_written(&note_root, &[&from, &to]);
                    value(json!({}))
                } else {
                    let dir = target.clone();
                    let name = run_fallible(self.lanes.durability, &cancel, move || fsops::copy_entry(&root, &rel, &target)).await?;
                    self.note_written(&note_root, &[&format!("{dir}/{name}")]);
                    value(json!({ "name": name }))
                }
            }
            "projectFs/trash" => {
                let root = self.root(req.ctx.origin, params).await?;
                let rel = s(params, "rel")?;
                let target = project_entry_path(&root, rel)?;
                if target == crate::pathguard::lexical(&root) {
                    return Err(WsError::invalid("Cannot trash the project root."));
                }
                let _claim = self.paths.acquire(Self::claim_keys(&root, &[rel])?).await;
                let moved = target.clone();
                run_fallible(self.lanes.durability, &cancel, move || {
                    trash::delete(&moved).map_err(|e| WsError::new(Reason::Io, e.to_string()))
                })
                .await?;
                self.note_written(&root, &[rel]);
                value(json!({}))
            }
            "projectFs/searchText" => {
                let root = self.root(req.ctx.origin, params).await?;
                let query = text_query(params.get("options").unwrap_or(&Value::Null))?;
                let token = cancel.clone();
                let found = run_fallible(self.lanes.maintenance, &cancel, move || {
                    crate::textsearch::search(&root, &query, &|| token.is_cancelled())
                })
                .await?;
                value(json!(found))
            }
            "projectFs/replaceText" => {
                let root = self.root(req.ctx.origin, params).await?;
                let options = params.get("options").unwrap_or(&Value::Null);
                let query = text_query(options)?;
                let replacement = s(params, "replacement")?.to_owned();
                // An empty list names no file, as in Node: every matching file is replaced.
                let rel_paths: Option<Vec<String>> = params
                    .get("relPaths")
                    .and_then(Value::as_array)
                    .map(|a| a.iter().filter_map(|p| p.as_str().map(str::to_owned)).collect::<Vec<_>>())
                    .filter(|paths| !paths.is_empty());
                let token = cancel.clone();
                let plan_root = root.clone();
                let plan = run_fallible(self.lanes.maintenance, &cancel, move || {
                    crate::textsearch::plan_replace(&plan_root, &query, &replacement, rel_paths.as_deref(), &|| token.is_cancelled())
                })
                .await?;
                if plan.writes.is_empty() {
                    return value(json!({ "filesChanged": 0, "replacements": 0, "paths": [] }));
                }
                let files: Vec<BatchFile> = plan
                    .writes
                    .iter()
                    .map(|w| BatchFile { rel_path: w.rel_path.clone(), content: w.content.clone(), expected_content: w.expected_content.clone() })
                    .collect();
                let rels: Vec<&str> = files.iter().map(|f| f.rel_path.as_str()).collect();
                let _claim = self.paths.acquire(Self::claim_keys(&root, &rels)?).await;
                let paths: Vec<String> = files.iter().map(|f| f.rel_path.clone()).collect();
                let fs = self.fs.clone();
                let note_root = root.clone();
                run_fallible(self.lanes.durability, &cancel, move || fs.write_batch(&root, &files, true)).await?;
                self.note_written(&note_root, &paths);
                value(json!({ "filesChanged": paths.len(), "replacements": plan.replacements, "paths": paths }))
            }
            "projectFs/recovery" => {
                let root = self.root(req.ctx.origin, params).await?;
                let action = Action::parse(s(params, "action")?, params.get("id").and_then(Value::as_str), params.get("revision").and_then(Value::as_str))?;
                let mutating = !matches!(action, Action::List | Action::Inspect { .. });
                let _claim = if mutating { Some(self.paths.acquire(vec![root.clone()]).await) } else { None };
                let this2 = this.clone();
                let lane_root = root;
                let response = if mutating {
                    let done = run_fallible(self.lanes.durability, &cancel, move || this2.fs.recovery.execute(&lane_root, action)).await?;
                    // A restore or discard may touch any file of the project.
                    self.note_anything();
                    done
                } else {
                    run_fallible(self.lanes.interactive, &cancel, move || this2.fs.recovery.execute(&lane_root, action)).await?
                };
                value(json!(response))
            }
            "fs/watch" => {
                let id = s(params, "watchId")?.to_owned();
                // Any absolute path, as Node's `folderWatch` (`absoluteLocalPath`, then `fs.watch`): a path
                // that does not exist fails with the text `fs.watch` gives.
                let wanted = lexical(Path::new(s(params, "path")?));
                let path = match canonical(&wanted) {
                    Ok(path) => path,
                    Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                        return Err(WsError::new(Reason::Io, format!("ENOENT: no such file or directory, watch '{}'", wanted.display())));
                    }
                    Err(error) => return Err(WsError::new(Reason::Io, format!("Cannot watch {}: {error}", wanted.display()))),
                };
                let recursive = opt_bool(params, "recursive");
                let publisher = Arc::new(Publisher::create(self.search_feeds(), &format!("fs:{id}"), json!({})));
                self.router.fs.lock().expect("fs watches").insert(id.clone(), publisher.clone());
                let (watcher, watch_id, watch_path) = (self.watcher.clone(), id.clone(), path.clone());
                let attached = run_fallible(self.lanes.interactive, &cancel, move || watcher.watch(&watch_id, &watch_path, recursive)).await;
                if let Err(error) = attached {
                    self.router.fs.lock().expect("fs watches").remove(&id);
                    return Err(error);
                }
                self.watches.lock().expect("watches").insert(id, Owned { connection: Self::owner(req), publisher: publisher.clone() });
                Ok(Reply::Subscribe(Subscribe { result: json!({}), feed: publisher.source(), window: Window::Fixed, resume_from: None }))
            }
            "fs/unwatch" => {
                let id = s(params, "watchId")?;
                let owned = self.watches.lock().expect("watches").get(id).is_some_and(|w| w.connection == Self::owner(req));
                if owned {
                    self.unwatch(id);
                }
                value(json!({}))
            }
            "search/start" => {
                let id = s(params, "sessionId")?.to_owned();
                let roots = params
                    .get("roots")
                    .and_then(Value::as_array)
                    .filter(|r| !r.is_empty() && r.len() <= 16)
                    .ok_or_else(|| WsError::invalid("roots is invalid."))?
                    .iter()
                    .map(|r| r.as_str().unwrap_or_default())
                    .collect::<Vec<_>>();
                let mut resolved = Vec::new();
                for root in roots {
                    resolved.push(self.catalog.resolve(root).await?);
                }
                let roots = resolved;
                let config = SessionConfig {
                    roots,
                    limit: params.get("limit").and_then(Value::as_u64).map(|n| n as usize),
                    include_ignored: opt_bool(params, "includeIgnored"),
                    include_directories: opt_bool(params, "includeDirectories"),
                    consumer: params.get("consumer").and_then(Value::as_str).map(str::to_owned),
                    scan_cap: None,
                    beyond_budget: None,
                };
                let publisher = self.search.start(&id, config)?;
                self.search_owner.lock().expect("search owners").insert(id, Self::owner(req));
                Ok(Reply::Subscribe(Subscribe { result: json!({}), feed: publisher.source(), window: Window::Fixed, resume_from: None }))
            }
            "search/update" => {
                self.search.update(s(params, "sessionId")?, s(params, "query")?.to_owned())?;
                value(json!({}))
            }
            "search/stop" => {
                let id = s(params, "sessionId")?;
                self.search_owner.lock().expect("search owners").remove(id);
                self.search.stop(id);
                value(json!({}))
            }
            "transfer/beginRead" => {
                let source = params.get("source").ok_or_else(|| WsError::invalid("source is invalid."))?;
                let owner = Self::owner(req);
                let t = self.transfers.clone();
                let opened = match source.get("kind").and_then(Value::as_str) {
                    Some("file") => {
                        let root = self.root(req.ctx.origin, source).await?;
                        let rel = s(source, "rel")?.to_owned();
                        run_fallible(self.lanes.interactive, &cancel, move || t.begin_project_read(&owner, &root, &rel)).await?
                    }
                    Some("granted") => {
                        let (grants, credential, connection) = self.phone_grants_for(req)?;
                        let granted = grants
                            .redeem(&credential, connection, s(source, "accessToken")?, s(source, "projectPath")?, s(source, "relPath")?)
                            .await?;
                        let (root, rel) = (granted.root, granted.rel);
                        run_fallible(self.lanes.interactive, &cancel, move || t.begin_project_read(&owner, &root, &rel)).await?
                    }
                    Some("localFile") => {
                        // An absolute path is the desktop's and an SSH window's; a paired device reads outside its
                        // projects only through a grant (`granted`).
                        if matches!(req.ctx.origin, mixdog_protocol::Origin::Relay) {
                            return Err(WsError::denied("A paired device reads local files through a granted-file permission."));
                        }
                        let path = s(source, "path")?.to_owned();
                        run_fallible(self.lanes.interactive, &cancel, move || t.begin_local_read(&owner, &path)).await?
                    }
                    Some(kind) => match self.sources.iter().find(|x| x.kind() == kind) {
                        Some(found) => {
                            let file = found.open(source, &cancel).await?;
                            self.transfers.begin_source(&owner, file)?
                        }
                        None => return Err(WsError::new(Reason::Unsupported, "This transfer source is served by another domain.")),
                    },
                    None => return Err(WsError::invalid("source.kind is invalid.")),
                };
                value(json!({ "transferId": opened.transfer_id, "size": opened.size, "mimeType": opened.mime_type,
                    "entry": { "name": opened.name, "version": opened.version, "rangeMaxBytes": opened.range_max_bytes } }))
            }
            "transfer/beginZip" => {
                let root = self.root(req.ctx.origin, params).await?;
                let (rel, owner) = (s(params, "rel")?.to_owned(), Self::owner(req));
                let opened = self.transfers.begin_zip(&owner, self.tracked.as_ref(), self.lanes, &cancel, &root, &rel).await?;
                value(json!({ "transferId": opened.transfer_id, "size": opened.size, "mimeType": opened.mime_type,
                    "entry": { "name": opened.name, "version": opened.version, "rangeMaxBytes": opened.range_max_bytes } }))
            }
            "transfer/readRange" => {
                let offset = params.get("offset").and_then(Value::as_u64).ok_or_else(|| WsError::invalid("offset is invalid."))?;
                let length = params.get("length").and_then(Value::as_u64).ok_or_else(|| WsError::invalid("length is invalid."))?;
                // `serverFileReadRange(root, rel, offset, length)` names the file and opens no transfer.
                if params.get("transferId").is_none() {
                    if length == 0 {
                        return Err(WsError::invalid("length is invalid."));
                    }
                    let (root, rel) = (self.root(req.ctx.origin, params).await?, s(params, "rel")?.to_owned());
                    return value(run_fallible(self.lanes.interactive, &cancel, move || crate::transfer::read_path_range(&root, &rel, offset, length)).await?);
                }
                let id = s(params, "transferId")?.to_owned();
                let (owner, t) = (Self::owner(req), self.transfers.clone());
                let range = run_fallible(self.lanes.interactive, &cancel, move || t.read_range(&owner, &id, offset, length)).await?;
                value(json!(range))
            }
            "transfer/endRead" => {
                value(json!({ "ended": self.transfers.end_read(&Self::owner(req), s(params, "transferId")?) }))
            }
            "transfer/beginWrite" if params.get("scope").is_some() => {
                // `serverUploadBegin(name, size, scope)`: staged under the data dir, named at commit.
                let scope = s(params, "scope")?.trim();
                if scope.is_empty()
                    || scope.len() > 128
                    || scope == "."
                    || scope == ".."
                    || !scope.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
                {
                    return Err(WsError::invalid("The upload scope is invalid."));
                }
                let size = params
                    .get("size")
                    .and_then(Value::as_u64)
                    .filter(|size| (1..=UPLOAD_MAX_BYTES).contains(size))
                    .ok_or_else(|| WsError::invalid("size is invalid."))?;
                let dir = self.user_data.join("attachments").join(scope);
                let (owner, name, t) = (Self::owner(req), s(params, "name")?.to_owned(), self.transfers.clone());
                let id = run_fallible(self.lanes.durability, &cancel, move || t.begin_staged(&owner, &dir, &name, size)).await?;
                value(json!({ "transferId": id, "uploadId": id, "chunkBytes": UPLOAD_CHUNK_BYTES, "maxBytes": UPLOAD_MAX_BYTES }))
            }
            "transfer/beginWrite" => {
                let root = self.root(req.ctx.origin, params).await?;
                let rel = s(params, "rel")?.to_owned();
                let size = params.get("size").and_then(Value::as_u64).ok_or_else(|| WsError::invalid("size is invalid."))?;
                let (owner, t) = (Self::owner(req), self.transfers.clone());
                let _claim = self.paths.acquire(Self::claim_keys(&root, &[&rel])?).await;
                let id = run_fallible(self.lanes.durability, &cancel, move || t.begin_write(&owner, &root, &rel, size)).await?;
                value(json!({ "transferId": id }))
            }
            "transfer/writeChunk" => {
                let id = s(params, "transferId")?.to_owned();
                // Validated in `Transfers::write_chunk`, in Node's order and with its sentences.
                let offset = params.get("offset").and_then(Value::as_u64);
                let encoded = params.get("bytesB64").and_then(Value::as_str).unwrap_or_default().to_owned();
                let (owner, t) = (Self::owner(req), self.transfers.clone());
                let received = run_fallible(self.lanes.durability, &cancel, move || t.write_chunk(&owner, &id, offset, &encoded)).await?;
                value(json!({ "received": received }))
            }
            "transfer/commit" => {
                let id = s(params, "transferId")?.to_owned();
                let (owner, t) = (Self::owner(req), self.transfers.clone());
                let (size, path) = run_fallible(self.lanes.durability, &cancel, move || t.commit(&owner, &id)).await?;
                self.note_anything();
                let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
                value(json!({ "size": size, "absolutePath": path.to_string_lossy(), "name": name, "dir": false }))
            }
            "transfer/abort" => value(json!({ "aborted": self.transfers.abort(&Self::owner(req), s(params, "transferId")?) })),
            "transfer/trash/info" => {
                let root = crate::pathguard::absolute_local_path(s(params, "path")?)?;
                value(run_fallible(self.lanes.interactive, &cancel, move || Ok(crate::servertrash::info(&root))).await?)
            }
            "transfer/grant/mint" => {
                // `resolveLocalPaths` / `attachmentOpen` of a paired device: the described path, with a one-file
                // grant when it lies outside every project (a conversation's attachment always gets one).
                let (grants, credential, connection) = self.phone_grants_for(req)?;
                let path = s(params, "path")?.to_owned();
                let session = params.get("sessionId").and_then(Value::as_str).unwrap_or_default().to_owned();
                let entry = run_fallible(self.lanes.interactive, &cancel, move || fsops::stat_local(&path)).await?;
                let mut row = json!(entry);
                if !entry.dir {
                    let absolute = PathBuf::from(&entry.absolute_path);
                    let projects: Vec<String> = self.catalog.list().await?.into_iter().map(|project| project.path).collect();
                    let owner = if session.is_empty() { crate::grants::owning_project(&projects, &absolute) } else { None };
                    match owner {
                        Some((project, relative)) => {
                            row["projectPath"] = json!(project);
                            row["relPath"] = json!(relative);
                        }
                        None => {
                            row["projectPath"] = json!(absolute.parent().map(|dir| dir.to_string_lossy().into_owned()).unwrap_or_default());
                            row["relPath"] = json!(absolute.file_name().map(|name| name.to_string_lossy().into_owned()).unwrap_or_default());
                            row["accessToken"] = json!(grants.mint(&credential, connection, &absolute, &session).await?);
                        }
                    }
                }
                value(row)
            }
            "transfer/trash/entry" => {
                // Root and entry as `server-file-operations.ts` takes them; `path` is the root.
                let root = self.catalog.resolve(s(params, "path")?).await?;
                let rel = params.get("rel").and_then(Value::as_str).unwrap_or_default().to_owned();
                let permanent = opt_bool(params, "permanent");
                let _claim = self.paths.acquire(Self::claim_keys(&root, &[&rel])?).await;
                let (note_root, note_rel) = (root.clone(), rel.clone());
                let outcome = run_fallible(self.lanes.durability, &cancel, move || crate::servertrash::entry(&root, &rel, permanent)).await?;
                self.note_written(&note_root, &[&note_rel]);
                value(outcome)
            }
            "projectFs/backup/read" => {
                let (backups, source) = (self.backups.clone(), s(params, "sourcePath")?.to_owned());
                value(run_fallible(self.lanes.interactive, &cancel, move || backups.read(&source)).await?)
            }
            "projectFs/backup/write" => {
                let (backups, source) = (self.backups.clone(), s(params, "sourcePath")?.to_owned());
                let (content, expected) = (s(params, "content")?.to_owned(), s(params, "expectedContent")?.to_owned());
                let _claim = self.paths.acquire(vec![self.backups.path_of(&source)?]).await;
                value(run_fallible(self.lanes.durability, &cancel, move || backups.write(&source, &content, &expected)).await?)
            }
            "projectFs/backup/delete" => {
                let (backups, source) = (self.backups.clone(), s(params, "sourcePath")?.to_owned());
                let _claim = self.paths.acquire(vec![self.backups.path_of(&source)?]).await;
                run_fallible(self.lanes.durability, &cancel, move || backups.delete(&source)).await?;
                value(json!({}))
            }
            "projectFs/workspaceFile/read" => {
                let file = PathBuf::from(s(params, "workspaceFile")?);
                value(run_fallible(self.lanes.interactive, &cancel, move || crate::editorcfg::read_workspace_file(&file)).await?)
            }
            "projectFs/workspaceFile/write" => {
                let file = PathBuf::from(s(params, "workspaceFile")?);
                let folders = params.get("folders").cloned().unwrap_or(Value::Null);
                let _claim = self.paths.acquire(vec![file.clone()]).await;
                value(run_fallible(self.lanes.durability, &cancel, move || crate::editorcfg::write_workspace_file(&file, &folders)).await?)
            }
            "projectFs/readEditorSettings" => {
                let root = self.root(req.ctx.origin, params).await?;
                let rel = s(params, "rel")?.to_owned();
                let workspace = params.get("workspaceFile").and_then(Value::as_str).map(PathBuf::from);
                let user_data = self.user_data.clone();
                let markdown_view = self.user_markdown_view.get().and_then(|read| read());
                value(
                    run_fallible(self.lanes.interactive, &cancel, move || {
                        crate::editorcfg::read_editor_settings(&user_data, &root, &rel, workspace.as_deref(), markdown_view)
                    })
                    .await?,
                )
            }
            "project/taskWorkspace" => {
                let user_data = self.user_data.clone();
                let path = run_fallible(self.lanes.durability, &cancel, move || crate::editorcfg::task_workspace(&user_data)).await?;
                value(json!({ "path": path.to_string_lossy() }))
            }
            "project/codeGraph" => {
                let mode = s(params, "mode")?;
                let query = s(params, "query")?.trim();
                // Node's `codeGraphQueryIn`: the same checks, arguments and text.
                let symbols = mode == "symbols";
                if !matches!(mode, "find_symbol" | "references" | "symbols") {
                    return Err(WsError::invalid("mode is invalid."));
                }
                if query.is_empty() || query.encode_utf16().count() > if symbols { 1_024 } else { 256 } {
                    return Err(WsError::invalid(if symbols { "File path is invalid." } else { "Symbol is invalid." }));
                }
                let args = if symbols {
                    json!({ "mode": mode, "files": query, "limit": 200 })
                } else {
                    json!({ "mode": mode, "symbols": query, "limit": 20 })
                };
                let root = self.root_of(req.ctx.origin, params, "path").await?;
                let graph = self.code_graph.as_ref().ok_or_else(|| WsError::new(Reason::Unsupported, "The code graph is not available."))?;
                value(Value::String(graph.query(&root, args, &cancel).await?))
            }
            "lsp/subscribe" => {
                // The feed is named by the project string `lsp/document` was given, which is what the
                // events carry as `projectPath`.
                let feed = self.lsp_feeds.source(s(params, "root")?);
                Ok(Reply::Subscribe(Subscribe { result: json!({}), feed, window: Window::Fixed, resume_from: None }))
            }
            // The subscription itself is the server's; the feed outlives it (servers keep running).
            "lsp/unsubscribe" => value(json!({})),
            "lsp/document" => {
                // `projectPath` names the project the events carry; `root` is the folder the host
                // resolved for it (a worktree may differ), as Node's `lspDocument(projectPath, root, input)`.
                let project = s(params, "projectPath")?;
                let root = self.root(req.ctx.origin, params).await?;
                let document = DocumentInput::from_value(params.get("document").unwrap_or(&Value::Null))?;
                value(self.lsp.document(project, &root, document).await)
            }
            "lsp/request" => {
                let project = s(params, "projectPath")?;
                let root = self.root(req.ctx.origin, params).await?;
                let r = params.get("request").unwrap_or(&Value::Null);
                value(
                    self.lsp
                        .request(
                            project,
                            &root,
                            s(r, "relPath")?,
                            s(r, "languageId")?,
                            s(r, "method")?,
                            r.get("params").unwrap_or(&Value::Null),
                        )
                        .await,
                )
            }
            _ => Err(WsError::new(Reason::Unsupported, "This method is served by the desktop host.")),
        }
    }

    fn search_feeds(&self) -> &dyn ScopedFeeds {
        self.feeds.as_ref()
    }

    fn batch_files(params: &Value) -> WsResult<Vec<BatchFile>> {
        params
            .get("files")
            .and_then(Value::as_array)
            .ok_or_else(|| WsError::invalid("files is invalid."))?
            .iter()
            .map(|f| {
                Ok(BatchFile {
                    rel_path: s(f, "relPath").or_else(|_| s(f, "rel"))?.to_owned(),
                    content: s(f, "content")?.to_owned(),
                    expected_content: s(f, "expectedContent")?.to_owned(),
                })
            })
            .collect()
    }
}

/// The op scope of a mutating method (the method table's `mutation: op(Scope)`).
fn op_scope(method: &str) -> Option<&'static str> {
    Some(match method {
        "project/create" | "project/touch" | "project/update" | "project/delete" | "project/ensureDirectory" => "project",
        "projectFs/writeText" | "projectFs/writeTextBatch" | "projectFs/create" | "projectFs/rename" | "projectFs/move"
        | "projectFs/copy" | "projectFs/trash" | "projectFs/replaceText" | "projectFs/recovery" | "projectFs/backup/write"
        | "projectFs/backup/delete" | "projectFs/workspaceFile/write" => "projectFs",
        "transfer/beginWrite" | "transfer/commit" | "transfer/trash/entry" => "transfer",
        "lsp/request" => "lsp",
        _ => return None,
    })
}

/// Registry changes commit their op row inside their own store transaction.
fn commits_op_itself(method: &str) -> bool {
    matches!(method, "project/create" | "project/touch" | "project/update" | "project/delete")
}

impl WorkspaceService {
    /// Runs a mutation under its op record: a repeated id answers from the record, a
    /// different payload under the same id conflicts, and the record is written before the
    /// effect (inProgress) and completed after it (applied or rejected). Registry changes
    /// write the record in the same transaction as the change.
    async fn with_op(self: &Arc<Self>, req: &CoreRequest, scope: &'static str, op_id: String) -> Result<Reply, CoreError> {
        let method = req.method.as_str();
        let digest = crate::recovery::hex_digest(format!("{method}\n{}", req.params).as_bytes());
        let state_error = |_| CoreError::Internal { incident_id: "workspace-op-store".into() };
        if let Some(found) = self.state.op(scope, &op_id).await.map_err(state_error)? {
            let id = req.op.clone().expect("op present");
            if found.payload_digest != digest {
                return Err(CoreError::OpIdConflict { op_id: id });
            }
            return match (found.state, found.outcome) {
                (OpRowState::Applied, outcome) => {
                    Ok(Reply::Value(outcome.and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_else(|| json!({}))))
                }
                (OpRowState::Rejected, code) => Err(CoreError::DomainError {
                    domain: "workspace".into(),
                    code: Some(code.unwrap_or_else(|| "rejected".into()).into()),
                    message: None,
                    detail: None,
                }),
                _ => Err(CoreError::ExternalOutcomeUnknown { op_id: id, effect: method.into(), target: "".into() }),
            };
        }
        let record = OpRecord {
            scope: scope.to_owned(),
            op_id: op_id.clone(),
            row: OpRow {
                method: method.to_owned(),
                payload_digest: digest,
                state: OpRowState::InProgress,
                outcome: None,
                created_at: crate::catalog::now_ms(),
                completed_at: None,
            },
        };
        let own = commits_op_itself(method);
        if !own {
            let begin = record.clone();
            self.state.write(move |tx| tx.put_op(&begin.scope, &begin.op_id, &begin.row)).await.map_err(state_error)?;
        }
        let result = self.dispatch(req, own.then(|| record.clone())).await;
        let settled = match &result {
            Ok(Reply::Value(value)) => (OpRowState::Applied, value.to_string()),
            Ok(Reply::Subscribe(_)) => (OpRowState::Applied, "{}".to_owned()),
            Err(error) => (OpRowState::Rejected, error.reason.code().to_owned()),
        };
        if !(own && result.is_ok()) {
            let mut done = record;
            done.row.state = settled.0;
            done.row.outcome = Some(settled.1);
            done.row.completed_at = Some(crate::catalog::now_ms());
            self.state.write(move |tx| tx.put_op(&done.scope, &done.op_id, &done.row)).await.map_err(state_error)?;
        }
        result.map_err(|e| self.map_error(req, e))
    }
}

#[async_trait]
impl DomainService for WorkspaceService {
    async fn call(&self, req: CoreRequest) -> Result<Reply, CoreError> {
        // `dispatch` needs `Arc<Self>` for lane closures; services are always held in an Arc.
        let this = self.me.get().and_then(Weak::upgrade).ok_or(CoreError::ConnectionClosed)?;
        // The OS trash is the window's (Node's `trashItem` host request): the path is confined here, the window moves it.
        if req.method.as_str() == "projectFs/trash" && opt_bool(&req.params, "viaHost") {
            let confined = async {
                let root = this.root(req.ctx.origin, &req.params).await?;
                let target = project_entry_path(&root, s(&req.params, "rel")?)?;
                Ok::<_, WsError>(json!({ "path": target.to_string_lossy() }))
            };
            let host_params = confined.await.map_err(|e| this.map_error(&req, e))?;
            return this.host_files("host/files/trashItem", host_params).await.map(|_| Reply::Value(json!({})));
        }
        if let (Some(scope), Some(op)) = (op_scope(req.method.as_str()), req.op.as_ref()) {
            return this.with_op(&req, scope, op.to_string()).await;
        }
        let host_method = match req.method.as_str() {
            "projectFs/captureSnapshot" => Some("host/capture/fileSnapshot"),
            "projectFs/localPageUrl" => Some("host/localPage/url"),
            _ => None,
        };
        if let Some(host_method) = host_method {
            // The path is confined here; the window only renders it. A one-file grant names the granted file alone.
            let confined = async {
                let (root, rel) = this.file_target(&req, &req.params).await?;
                project_entry_path(&root, &rel)?;
                let granted = req.params.get("accessToken").is_some();
                Ok::<_, WsError>(if host_method == "host/capture/fileSnapshot" {
                    json!({ "root": root.to_string_lossy(), "rel": rel, "grant": granted })
                } else {
                    json!({ "root": root.to_string_lossy(), "rel": rel, "scope": if granted { "file" } else { "project" } })
                })
            };
            let host_params = confined.await.map_err(|e| this.map_error(&req, e))?;
            return this.host_files(host_method, host_params).await.map(Reply::Value);
        }
        this.dispatch(&req, None).await.map_err(|e| this.map_error(&req, e))
    }

    fn methods(&self) -> &'static [&'static str] {
        &[
            "project/list",
            "project/read",
            "project/create",
            "project/touch",
            "project/update",
            "project/delete",
            "project/ensureDirectory",
            "project/directory",
            "project/recoveryDirectory",
            "project/taskWorkspace",
            "project/codeGraph",
            "projectFs/listDir",
            "projectFs/readText",
            "projectFs/stat",
            "projectFs/entryPath",
            "projectFs/previewFile",
            "projectFs/previewRange",
            "projectFs/readLocal",
            "projectFs/statLocal",
            "projectFs/browseDirs",
            "projectFs/captureSnapshot",
            "projectFs/localPageUrl",
            "projectFs/writeText",
            "projectFs/writeTextBatch",
            "projectFs/create",
            "projectFs/rename",
            "projectFs/move",
            "projectFs/copy",
            "projectFs/trash",
            "projectFs/searchText",
            "projectFs/replaceText",
            "projectFs/recovery",
            "projectFs/backup/read",
            "projectFs/backup/write",
            "projectFs/backup/delete",
            "projectFs/workspaceFile/read",
            "projectFs/workspaceFile/write",
            "projectFs/readEditorSettings",
            "fs/watch",
            "fs/unwatch",
            "search/start",
            "search/update",
            "search/stop",
            "transfer/beginRead",
            "transfer/beginZip",
            "transfer/readRange",
            "transfer/endRead",
            "transfer/beginWrite",
            "transfer/writeChunk",
            "transfer/commit",
            "transfer/abort",
            "transfer/trash/info",
            "transfer/trash/entry",
            "transfer/grant/mint",
            "lsp/subscribe",
            "lsp/unsubscribe",
            "lsp/document",
            "lsp/request",
        ]
    }

    fn notify(&self, _method: Method, _params: Value, _from: ConnectionId) -> Admit {
        Admit::Accepted
    }
}