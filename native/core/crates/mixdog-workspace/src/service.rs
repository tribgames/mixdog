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
use crate::pathguard::canonical_through_existing;
use crate::pathguard::project_entry_path;
use crate::recovery::Action;
use crate::recovery::RecoveryStore;
use crate::search::SearchSessions;
use crate::search::SessionConfig;
use crate::textsearch::TextQuery;
use crate::transfer::Owner;
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
            publisher: Publisher::create_ordered(self.feeds.as_ref(), &format!("lsp:{project}"), json!({})),
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
    /// The sweepers run once, whatever the number of calls to [WorkspaceService::spawn_idle_sweeper].
    sweepers: std::sync::Once,
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

    /// The worktree branch of Node's `projectRecoveryDirectory` (`session-host.ts`): for an absolute `path` that names no
    /// registered Project, the folder a recovery call works in when it lies in a managed worktree whose state is `ready`,
    /// `deleting` or `recovery` and whose Project is registered. `None` keeps the registry's refusal.
    async fn recovery_root(&self, path: &str) -> Option<PathBuf>;

    /// Node's `withWorktreeRecoveryStore` (`manager.mjs`), which every recovery call ran under: inside a managed worktree it
    /// records the journal store on the worktree and holds the repository lock through `run`; a restore needs a ready
    /// worktree. Elsewhere `run` runs as is.
    async fn recovery_store(
        &self,
        root: &Path,
        directory: &Path,
        action: RecoveryUse,
        run: std::pin::Pin<Box<dyn std::future::Future<Output = WsResult<Value>> + Send>>,
    ) -> WsResult<Value>;
}

/// What a recovery call does to a journal store, as Node's file host named it to the worktree manager.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RecoveryUse {
    Inspect,
    Restore,
    Discard,
}

/// Reads the user's Markdown default view.
type UserMarkdownView = Arc<dyn Fn() -> Option<String> + Send + Sync>;

fn s<'a>(params: &'a Value, key: &str) -> WsResult<&'a str> {
    params.get(key).and_then(Value::as_str).ok_or_else(|| WsError::invalid(format!("{key} is invalid.")))
}

/// Largest staged upload and its chunk size (`shared/server-files.ts`).
use crate::transfer::{UPLOAD_CHUNK_BYTES, UPLOAD_MAX_BYTES, unavailable};

/// A relay call's file as admitted (Node's `remoteFileTarget` answer): the registered project and the entry in it, or the
/// granted file's own folder and its name.
#[derive(Debug)]
pub struct RelayTarget {
    pub root: PathBuf,
    pub rel: String,
    pub absolute: PathBuf,
}

/// Node's plain `Error` for an entry beyond its folder (`projectEntryPathIn`), as the phone read it.
fn beyond_plain(error: WsError) -> WsError {
    if crate::pathguard::is_beyond_project(&error) { WsError::plain(error.message) } else { error }
}

fn opt_bool(params: &Value, key: &str) -> bool {
    params.get(key).and_then(Value::as_bool).unwrap_or(false)
}

/// `lone`: the query held an unpaired surrogate escape on the wire (now U+FFFD).
fn text_query(options: &Value, lone: bool) -> WsResult<TextQuery> {
    let text = |k: &str| options.get(k).and_then(Value::as_str).unwrap_or_default().to_owned();
    let query = text("query");
    if query.is_empty() || query.len() > 1000 {
        return Err(WsError::invalid("Search query is invalid."));
    }
    Ok(TextQuery {
        lone,
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
        Self::build(deps, Arc::new(Transfers::default()))
    }

    /// A service over a transfer table whose clock a test moves (the whole download path then runs on that clock).
    #[cfg(test)]
    pub(crate) fn new_with_transfers(deps: Deps, transfers: Arc<Transfers>) -> WsResult<Arc<Self>> {
        Self::build(deps, transfers)
    }

    fn build(deps: Deps, transfers: Arc<Transfers>) -> WsResult<Arc<Self>> {
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
            transfers,
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
            sweepers: std::sync::Once::new(),
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
        self.sweepers.call_once(|| self.start_sweepers());
    }

    fn start_sweepers(&self) {
        let sweeping = self.transfers.clone();
        // Node's 15 s sweeper of grants and phone transfers: their handles close at its tick although no call comes. It ends with the
        // runtime at shutdown, like the other tasks of the daemon. A core built for the replay of the recording ticks on the replay's clock.
        drop(mixdog_rt::spawn("download-sweep", mixdog_rt::TaskClass::Work, async move {
            #[cfg(feature = "replay-controls")]
            if let Some(clock) = crate::replay_controls::clock() {
                return sweeping.run_download_sweeper(&*clock).await;
            }
            sweeping.run_download_sweeper(&crate::transfer::TokioTimer).await;
        }));
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

    /// `projectDirectory`: the managed worktree's folder, else the Project's real path. `owner` asks for the Project's real path even for
    /// a worktree (`startProjectTask`'s `canonicalDirectory(knownProject(path))`).
    async fn project_directory(&self, path: &str, owner: bool, cancel: &CancellationToken) -> WsResult<PathBuf> {
        let (project, worktree) = self.scope(path).await?;
        match worktree.filter(|_| !owner) {
            Some(folder) => Ok(folder),
            None => {
                let given = project.to_string_lossy().into_owned();
                run_fallible(self.lanes.interactive, cancel, move || crate::catalog::canonical_directory(&project, &given)).await
            }
        }
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
        // A device that unpairs loses its downloads in the same step as its grants, whether or not any connection of it is attached.
        let transfers = self.transfers.clone();
        store.on_unpaired(Arc::new(move |credential| transfers.revoke_owner(&Owner::device(credential))));
        // A conversation a publication lists again is a member again (Node's replaceable catalog).
        let transfers = self.transfers.clone();
        store.on_listed(Arc::new(move |sessions| transfers.relisted(sessions)));
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
        let owner = Owner::connection(connection.0).to_string();
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

    /// The host's catalog dropped a conversation, and this is told in the step that publishes the change (Node's `retainSessions`): the
    /// downloads on it end at once, a call of them in flight finds it removed, and a conversation no published catalog ever listed ends
    /// nothing (Node's `seenSessions`).
    pub fn session_removed(&self, session: &str) {
        if self.phone_grants.get().is_some_and(|grants| grants.store.has_seen(session)) {
            self.transfers.remove_session(session);
        }
    }

    /// An unpair ends what the device holds. `connection` is the number of one of the device's attached connections, which the unpair
    /// walks (`PairedDeviceCleanup::unpaired`): what the connection owns ends, and so do the downloads of the credential it is attached
    /// under. The downloads of a device with no connection attached end through the grant store, which is told the credential
    /// (see [`Self::set_phone_grants`]).
    pub fn revoke_device(&self, connection: &str) {
        let Ok(id) = connection.parse::<u64>() else { return };
        self.transfers.revoke_owner(&Owner::connection(id));
        if let Some(credential) = self.phone_grants.get().and_then(|grants| (grants.credential_of)(ConnectionId(id))).filter(|credential| !credential.is_empty()) {
            self.transfers.revoke_owner(&Owner::device(&credential));
        }
    }

    /// The relay handle closed (switched off, rotated, the core stopping): every phone download ends in that step, and a call in flight
    /// finds it revoked (Node's `fileDownloads.revokeAll` in the relay's `close`, `remote-relay.ts:653`).
    pub fn revoke_all_downloads(&self) {
        self.transfers.revoke_all();
    }

    /// Who a phone's download calls belong to: its paired credential (only a relay peer admitted under one has it), else (a local
    /// client) the connection (Node's `downloadRequester`).
    fn download_owner(&self, req: &CoreRequest) -> Owner {
        match (&req.ctx.caller, self.phone_grants.get()) {
            (mixdog_core_api::call::Caller::Connection(id), Some(grants)) => {
                (grants.credential_of)(*id).filter(|c| !c.is_empty()).map_or_else(|| Owner::connection(id.0), |credential| Owner::device(&credential))
            }
            _ => Self::owner(req),
        }
    }

    fn unwatch(&self, id: &str) {
        self.forget_watch(id);
        self.watcher.unwatch(id);
    }

    /// The watch's routing and feed, without the OS watch.
    fn forget_watch(&self, id: &str) {
        self.router.fs.lock().expect("fs watches").remove(id);
        if let Some(owned) = self.watches.lock().expect("watches").remove(id) {
            owned.publisher.close();
        }
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
    /// the registered projects and their ready managed worktrees, as Node's relay resolved every
    /// phone's project path through `SessionHost.projectDirectory` (DS 4.2: origin rules are data).
    async fn root_of(&self, origin: mixdog_protocol::Origin, params: &Value, key: &str) -> WsResult<PathBuf> {
        match origin {
            mixdog_protocol::Origin::Relay => self.scope(s(params, key)?).await.map(|(project, worktree)| worktree.unwrap_or(project)),
            mixdog_protocol::Origin::Local | mixdog_protocol::Origin::Ssh => crate::pathguard::absolute_local_path(s(params, key)?),
        }
    }

    /// `projectFs/recovery`'s folder (Node's `projectRecoveryDirectory` on the phone's path): a relay connection's registered
    /// Project, else the managed worktree folder [`ManagedProjects::recovery_root`] admits, else the registry's refusal.
    async fn recovery_root(&self, origin: mixdog_protocol::Origin, params: &Value) -> WsResult<PathBuf> {
        // Not `root`: Node's `projectRecoveryDirectory` tries the registered Project, then its own worktree rule (any of
        // three states, the folder spelled from the checkout's real parent), never `projectScope`.
        let refusal = match origin {
            mixdog_protocol::Origin::Relay => match self.catalog.resolve(s(params, "root")?).await {
                Ok(root) => return Ok(root),
                Err(refusal) => refusal,
            },
            mixdog_protocol::Origin::Local | mixdog_protocol::Origin::Ssh => return self.root(origin, params).await,
        };
        let admitted = match (self.managed.get(), params.get("root").and_then(Value::as_str)) {
            (Some(managed), Some(path)) => managed.recovery_root(path).await,
            _ => None,
        };
        admitted.ok_or(refusal)
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

    /// A paired phone's file named by its path (an editor backup, a document preview), held to what Node's host let a phone
    /// name (`remoteFileTarget`, `remote-file-preview.ts`): a file this device holds a live one-file grant for, or an entry of a
    /// registered project confined to it. The registered projects are the catalog's; the grants are this connection's device
    /// table in the grant store (`set_phone_grants`). A refusal is Node's answer for a file named without a token:
    /// `PROJECT_UNAVAILABLE` "Project is not available." for a folder that is no project, "Path is outside the project." (no code)
    /// for an entry beyond it. The token's own refusals stay with `projectFs/entryPath`, which redeems a token.
    ///
    /// The answer is the file as admitted, and it is what the caller acts on in place of what the phone sent: Node's callers
    /// used `target.root`, `target.rel` and `target.absolute`, never the phone's own spelling (a folder name that only trims
    /// to a project's is not that project).
    pub async fn relay_file(&self, req: &CoreRequest, root: &str, rel: &str) -> Result<RelayTarget, CoreError> {
        self.relay_target(req, root, rel).await.map_err(|error| self.map_error(req, error))
    }

    async fn relay_target(&self, req: &CoreRequest, root: &str, rel: &str) -> WsResult<RelayTarget> {
        if let (Some(grants), mixdog_core_api::call::Caller::Connection(id)) = (self.phone_grants.get(), &req.ctx.caller)
            && let Some(credential) = (grants.credential_of)(*id).filter(|credential| !credential.is_empty())
            && let Ok(base) = std::path::absolute(root)
        {
            let file = crate::pathguard::lexical(&base.join(rel));
            if grants.store.holds(&credential, id.0, &file).await? {
                // `located(root, rel, true)`: the granted file is re-resolved in its own folder on every call, so a name
                // swapped for a link out of that folder is refused.
                let folder = file.parent().map(Path::to_path_buf).unwrap_or_default();
                let name = file.file_name().map(|name| name.to_string_lossy().into_owned()).unwrap_or_default();
                let absolute = project_entry_path(&folder, &name).map_err(beyond_plain)?;
                return Ok(RelayTarget { root: folder, rel: name, absolute });
            }
        }
        let project = self.catalog.resolve(root).await?;
        let absolute = project_entry_path(&project, rel).map_err(beyond_plain)?;
        Ok(RelayTarget { root: project, rel: rel.to_owned(), absolute })
    }

    /// An editor backup of a relay connection: [`Self::relay_file`] for a file named by its absolute path alone. The
    /// deepest registered project that holds it names the project and the entry (Node's phone named them), else the file's
    /// own folder is the folder named. Other origins name any absolute path, as the desktop's own editor did. The answer is the
    /// path the backup is kept under: the admitted file's (Node's `editorFilePath`), the caller's own for another origin.
    async fn relay_backup(&self, req: &CoreRequest, source: String) -> WsResult<String> {
        if req.ctx.origin != mixdog_protocol::Origin::Relay {
            return Ok(source);
        }
        let projects: Vec<String> = self.catalog.list().await?.into_iter().map(|row| row.path).collect();
        let file = Path::new(&source);
        let (root, rel) = match crate::grants::owning_project(&projects, file) {
            Some((project, rel)) => (project.to_owned(), rel),
            None => (
                file.parent().map(|parent| parent.to_string_lossy().into_owned()).unwrap_or_default(),
                file.file_name().map(|name| name.to_string_lossy().into_owned()).unwrap_or_default(),
            ),
        };
        Ok(self.relay_target(req, &root, &rel).await?.absolute.to_string_lossy().into_owned())
    }

    fn owner(req: &CoreRequest) -> Owner {
        match &req.ctx.caller {
            mixdog_core_api::call::Caller::Connection(id) => Owner::connection(id.0),
            mixdog_core_api::call::Caller::Internal(name) => Owner::internal(name),
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
                // Node's `inspectProjectPath` (project-catalog.mjs:32): any path, registered or not (the TUI asks it about a folder before
                // adding it as a project), resolved by `resolveProjectPath` and probed.
                let path = crate::pathguard::project_path(s(params, "path")?).ok_or_else(|| WsError::invalid("project path is required"))?;
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
                let folder = self.project_directory(s(params, "path")?, opt_bool(params, "owner"), &cancel).await?;
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
                if params.get("paged").and_then(Value::as_bool) == Some(true) {
                    // The checks of the whole read, then the file held open as a transfer of this connection to page through.
                    let (owner, t) = (Self::owner(req), self.transfers.clone());
                    return value(run_fallible(self.lanes.interactive, &cancel, move || {
                        let (file, name, _) = fsops::local_file(&path)?;
                        let opened = t.begin_local_read(&owner, &file.to_string_lossy())?;
                        Ok(json!({ "name": name, "size": opened.size, "mimeType": opened.mime_type, "transferId": opened.transfer_id, "version": opened.version }))
                    })
                    .await?);
                }
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
                let lone = (Self::held_lone(req, "/content"), Self::held_lone(req, "/expectedContent"));
                let _claim = self.paths.acquire(Self::claim_keys(&root, &[&rel])?).await;
                let fs = self.fs.clone();
                let (note_root, note_rel) = (root.clone(), rel.clone());
                let mtime =
                    run_fallible(self.lanes.durability, &cancel, move || fs.write_text(&root, &rel, &content, &expected, encoding, lone)).await?;
                self.note_written(&note_root, &[&note_rel]);
                value(json!({ "mtimeMs": mtime }))
            }
            "projectFs/writeTextBatch" => {
                let root = self.root(req.ctx.origin, params).await?;
                let files = Self::batch_files(req, params)?;
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
                let query = text_query(params.get("options").unwrap_or(&Value::Null), Self::held_lone(req, "/options/query"))?;
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
                let query = text_query(options, Self::held_lone(req, "/options/query"))?;
                let replacement = s(params, "replacement")?.to_owned();
                // Every planned write holds the replacement; one that held a lone surrogate is refused (Node: project-files.ts:744).
                let content_lone = Self::held_lone(req, "/replacement");
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
                    .map(|w| BatchFile {
                        rel_path: w.rel_path.clone(),
                        content: w.content.clone(),
                        expected_content: w.expected_content.clone(),
                        content_lone,
                        expected_lone: false,
                    })
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
                let root = self.recovery_root(req.ctx.origin, params).await?;
                let action = Action::parse(s(params, "action")?, params.get("id").and_then(Value::as_str), params.get("revision").and_then(Value::as_str))?;
                let (mutating, store_use) = match action {
                    Action::List | Action::Inspect { .. } => (false, RecoveryUse::Inspect),
                    Action::Restore { .. } => (true, RecoveryUse::Restore),
                    Action::Discard { .. } => (true, RecoveryUse::Discard),
                };
                let _claim = if mutating { Some(self.paths.acquire(vec![root.clone()]).await) } else { None };
                let this2 = this.clone();
                let lane_root = root.clone();
                let (durability, interactive) = (self.lanes.durability, self.lanes.interactive);
                let task_cancel = cancel.clone();
                let run: std::pin::Pin<Box<dyn std::future::Future<Output = WsResult<Value>> + Send>> = Box::pin(async move {
                    let job = move || this2.fs.recovery.execute(&lane_root, action);
                    let response = if mutating {
                        run_fallible(durability, &task_cancel, job).await?
                    } else {
                        run_fallible(interactive, &task_cancel, job).await?
                    };
                    Ok(json!(response))
                });
                let response = match self.managed.get() {
                    Some(managed) => managed.recovery_store(&root, &self.fs.recovery.store_path(&root), store_use, run).await?,
                    None => run.await?,
                };
                if mutating {
                    // A restore or discard may touch any file of the project.
                    self.note_anything();
                }
                value(response)
            }
            "fs/watch" => {
                let id = s(params, "watchId")?.to_owned();
                // Any absolute path, as Node's `folderWatch` (`absoluteLocalPath`, then `fs.watch` of that resolved string,
                // desktop-operations.ts:185-213): the watch is of the path as resolved, not of its real path, so a junction
                // watched under two names is two watches that each report under their own name, and a failure is `fs.watch`'s own
                // (`ENOENT: no such file or directory, watch '<path>'`). Every touch of the file system is on the lane below.
                let Some(given) = params.get("path").and_then(Value::as_str) else { return Err(WsError::invalid("path must be a string.")) };
                let path = crate::pathguard::absolute_local_path(given)?;
                let recursive = opt_bool(params, "recursive");
                let publisher = Arc::new(Publisher::create_ordered(self.search_feeds(), &format!("fs:{id}"), json!({})));
                self.router.fs.lock().expect("fs watches").insert(id.clone(), publisher.clone());
                let (watcher, watch_id, watch_path) = (self.watcher.clone(), id.clone(), path.clone());
                let attached = run_fallible(self.lanes.interactive, &cancel, move || watcher.watch(&watch_id, &watch_path, recursive)).await;
                if let Err(error) = attached {
                    self.router.fs.lock().expect("fs watches").remove(&id);
                    return Err(error);
                }
                self.watches.lock().expect("watches").insert(id, Owned { connection: Self::owner(req).to_string(), publisher: publisher.clone() });
                Ok(Reply::Subscribe(Subscribe { result: json!({}), feed: publisher.source(), window: Window::Fixed, resume_from: None }))
            }
            "fs/unwatch" => {
                let id = s(params, "watchId")?;
                let owned = self.watches.lock().expect("watches").get(id).is_some_and(|w| w.connection == *Self::owner(req));
                if owned {
                    // Ending the OS watch closes its handle, which a path that does not answer can hold: on the lane, not here. The job is
                    // admitted before the watch's record goes, with a token no cancel reaches, so the OS watch never outlives its record:
                    // a lane that refuses it leaves the watch whole, and a request cancelled meanwhile does not drop it.
                    let (watcher, watch_id) = (self.watcher.clone(), id.to_owned());
                    let job = move |_: &mixdog_rt::InLane<mixdog_rt::InteractiveIo>| crate::lanes::counted(move || watcher.unwatch(&watch_id))();
                    let cleanup = mixdog_rt::LaneToken::submit(self.lanes.interactive, &CancellationToken::new(), job)?;
                    self.forget_watch(id);
                    let _ = cleanup.await;
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
                self.search_owner.lock().expect("search owners").insert(id, Self::owner(req).to_string());
                Ok(Reply::Subscribe(Subscribe { result: json!({}), feed: publisher.source(), window: Window::Fixed, resume_from: None }))
            }
            "search/update" => {
                self.search.update(s(params, "sessionId")?, s(params, "query")?.to_owned(), Self::held_lone(req, "/query"))?;
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
                let (owner, connection, t) = (self.download_owner(req), Self::owner(req), self.transfers.clone());
                let owners = [owner.as_str(), connection.as_str()];
                let version = params.get("version").and_then(Value::as_str).map(str::to_owned);
                let range = run_fallible(self.lanes.interactive, &cancel, {
                    let (owners, id) = (owners.map(str::to_owned), id.clone());
                    move || t.read_range(&[owners[0].as_str(), owners[1].as_str()], &id, offset, length, version.as_deref())
                })
                .await?;
                // The lane answered some time after the range took its last look: a revoke that landed since is never followed by bytes.
                if !self.transfers.holds(&owners, &id) {
                    return Err(WsError::expired());
                }
                value(json!(range))
            }
            "transfer/authorizeRead" => {
                // Node's `requiredFileDownloadRequest`, check for check and before anything is looked up: the core is the boundary, whoever
                // calls it, and each identifier is the trimmed text Node goes on with.
                let source = params.get("source").filter(|source| source.is_object()).ok_or_else(|| WsError::invalid("download source is invalid."))?;
                if !matches!(params.get("purpose").and_then(Value::as_str), Some("save" | "share" | "open")) {
                    return Err(WsError::invalid("download purpose is invalid."));
                }
                let session = crate::transfer::required_session_id(params.get("sessionId"))?;
                let requested = crate::transfer::DownloadRequest::of(source)?;
                let owner = self.download_owner(req);
                let mark = self.transfers.mark(&owner, &session);
                let t = self.transfers.clone();
                // Node's `sessionRow`: the conversation must be in the host's catalog now, whoever asks, and its project is the catalog's, never
                // the caller's.
                let grants = self.phone_grants.get().ok_or_else(|| WsError::new(Reason::Unsupported, "Paired-device downloads are not available."))?;
                let row = grants.store.session_row(&session).await?.ok_or_else(unavailable)?;
                // `projectRoot`: only a project conversation whose project is still a registered one has a root.
                let project = match (&row.project_path, row.project) {
                    (Some(given), true) => self.catalog.resolve(given).await.ok(),
                    _ => None,
                };
                let given = row.project_path.as_deref().map(PathBuf::from);
                let mut left_out = None;
                let opened = match requested {
                    crate::transfer::DownloadRequest::Project(rel) => {
                        let root = project.ok_or_else(|| WsError::new(Reason::Download("file-download:outside-project"), "The file is outside the conversation's project."))?;
                        run_fallible(self.lanes.interactive, &cancel, move || crate::transfer::open_project_download(&root, &rel, &|point| t.point(point))).await?
                    }
                    crate::transfer::DownloadRequest::Session(path) => {
                        let cwd = row.cwd.clone();
                        run_fallible(self.lanes.interactive, &cancel, move || {
                            crate::transfer::open_session_download(&path, &cwd, project.as_deref(), given.as_deref(), &|point| t.point(point))
                        })
                        .await?
                    }
                    crate::transfer::DownloadRequest::Media(asset) => {
                        // Node's `authorizeMediaAsset`: the conversation is in the catalog (above), the asset is the media store's.
                        let entry = grants.store.media(&asset).await?;
                        run_fallible(self.lanes.interactive, &cancel, move || crate::transfer::open_media_download(entry.as_ref(), &|point| t.point(point))).await?
                    }
                    crate::transfer::DownloadRequest::Link(href) => {
                        // Node's `authorizeLinkedFile`: the link decoded as the desktop decodes it, then opened as a path the conversation names.
                        let path = crate::transfer::link_path(&href).ok_or_else(|| WsError::new(Reason::Download("file-download:not-a-file"), "Only files on this PC can be downloaded."))?;
                        let cwd = row.cwd.clone();
                        run_fallible(self.lanes.interactive, &cancel, move || {
                            crate::transfer::open_session_download(&path, &cwd, project.as_deref(), given.as_deref(), &|point| t.point(point))
                        })
                        .await?
                    }
                    crate::transfer::DownloadRequest::Attachment(id) => {
                        // Node's `authorizeAttachment`: an id the conversation the core resolved names, staged by the attachment domain.
                        let source = self.sources.iter().find(|x| x.kind() == "attachment").ok_or_else(|| WsError::new(Reason::Unsupported, "Attachments are not available."))?;
                        let read = source.bytes(&json!({ "sessionId": session, "attachmentId": id }), &cancel).await.map_err(crate::transfer::source_refusal)?;
                        let (owner, session) = (owner.clone(), session.clone());
                        run_fallible(self.lanes.interactive, &cancel, move || t.stage(&owner, &session, &read.bytes, read.name, read.mime_type)).await?
                    }
                    crate::transfer::DownloadRequest::Folder(path) => {
                        // Node's `authorizeFolderZip`: the folder as the conversation names it, zipped as `zipFolder` zips it, staged.
                        let cwd = row.cwd.clone();
                        let (root, given) = (project.clone(), given.clone());
                        let folder = run_fallible(self.lanes.maintenance, &cancel, move || crate::transfer::phone_folder(&path, &cwd, root.as_deref(), given.as_deref())).await?;
                        let scan = crate::zip::scan_folder(self.tracked.as_ref(), self.lanes, &cancel, &folder, crate::transfer::ZIP_MAX_BYTES, crate::transfer::ZIP_MAX_FILES, None)
                            .await
                            .map_err(crate::transfer::phone_folder_refusal)?;
                        left_out = Some(crate::transfer::LeftOut { ignored: scan.ignored, secret: 0 });
                        let (t, owner, session) = (self.transfers.clone(), owner.clone(), session.clone());
                        run_fallible(self.lanes.cpu_bulk, &cancel, move || {
                            let (archive, name) = crate::transfer::folder_zip(&folder, &scan.files, &|point| t.point(point))?;
                            t.stage(&owner, &session, &archive, name, "application/zip".into())
                        })
                        .await?
                    }
                };
                let t = self.transfers.clone();
                let mut authorized = t.authorize(&owner, &session, mark, opened)?;
                authorized.left_out = left_out;
                value(json!(authorized))
            }
            "transfer/redeemGrant" => {
                let (owner, t, id) = (self.download_owner(req), self.transfers.clone(), crate::transfer::required_download_id(params.get("grantId"), "grant id")?);
                value(json!(run_fallible(self.lanes.interactive, &cancel, move || t.begin_grant(&owner, &id)).await?))
            }
            "transfer/finishRead" => {
                let (owner, t, id) = (self.download_owner(req), self.transfers.clone(), crate::transfer::required_download_id(params.get("transferId"), "transfer id")?);
                value(json!(run_fallible(self.lanes.interactive, &cancel, move || t.finish_read(&owner, &id)).await?))
            }
            "transfer/endRead" => {
                let (owner, connection, id) = (self.download_owner(req), Self::owner(req), s(params, "transferId")?);
                value(json!({ "ended": self.transfers.end_read(&[owner.as_str(), connection.as_str()], id) }))
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
                // `serverTrashInfo` is handed `projectDirectory` of a registered project (ipc-server-files.ts:132), whatever the
                // connection: a path that names none is the registry's refusal, and a relative one is read by the registry's rule.
                let root = self.project_directory(s(params, "path")?, false, &cancel).await?;
                value(run_fallible(self.lanes.interactive, &cancel, move || Ok(crate::servertrash::info(&root))).await?)
            }
            "transfer/grant/mint" => {
                // `resolveLocalPaths` / `attachmentOpen` of a paired device: the described path, with a one-file
                // grant when it lies outside every project (a conversation's attachment always gets one).
                let (grants, credential, connection) = self.phone_grants_for(req)?;
                if params.get("attachmentId").is_some() {
                    // `attachmentOpen` (remote-attachments.ts): the attachment this conversation names, staged as a named file in the
                    // PC's temp folder (`stageSessionAttachment`) and opened through a one-file grant of that conversation.
                    // Node's `requiredSessionId` first, then the attachment.
                    let session = crate::transfer::required_session_id(params.get("sessionId"))?;
                    let source = self.sources.iter().find(|x| x.kind() == "attachment").ok_or_else(|| WsError::new(Reason::Unsupported, "Attachments are not available."))?;
                    let read = source.bytes(params, &cancel).await.map_err(crate::transfer::source_refusal)?;
                    let id = s(params, "attachmentId")?.to_owned();
                    let (bytes, name) = (read.bytes, read.name);
                    let size = bytes.len();
                    let path = run_fallible(self.lanes.durability, &cancel, move || crate::transfer::stage_attachment(&id, &name, &bytes)).await?;
                    let token = grants.mint(&credential, connection, &path, &session).await?;
                    let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
                    let folder = path.parent().map(|dir| dir.to_string_lossy().into_owned()).unwrap_or_default();
                    return value(json!({ "absolutePath": path.to_string_lossy(), "name": name, "dir": false, "size": size,
                        "mimeType": read.mime_type, "projectPath": folder, "relPath": name, "accessToken": token }));
                }
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
                let (backups, source) = (self.backups.clone(), self.relay_backup(req, s(params, "sourcePath")?.to_owned()).await?);
                value(run_fallible(self.lanes.interactive, &cancel, move || backups.read(&source)).await?)
            }
            "projectFs/backup/write" => {
                let (backups, source) = (self.backups.clone(), self.relay_backup(req, s(params, "sourcePath")?.to_owned()).await?);
                let (content, expected) = (s(params, "content")?.to_owned(), s(params, "expectedContent")?.to_owned());
                let _claim = self.paths.acquire(vec![self.backups.path_of(&source)?]).await;
                value(run_fallible(self.lanes.durability, &cancel, move || backups.write(&source, &content, &expected)).await?)
            }
            "projectFs/backup/delete" => {
                let (backups, source) = (self.backups.clone(), self.relay_backup(req, s(params, "sourcePath")?.to_owned()).await?);
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
                value(self.lsp.document(project, &root, document).await?)
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
                        .await?,
                )
            }
            _ => Err(WsError::new(Reason::Unsupported, "This method is served by the desktop host.")),
        }
    }

    fn search_feeds(&self) -> &dyn ScopedFeeds {
        self.feeds.as_ref()
    }

    /// The files of a batch save, each marked where its content held a lone surrogate.
    fn batch_files(req: &CoreRequest, params: &Value) -> WsResult<Vec<BatchFile>> {
        params
            .get("files")
            .and_then(Value::as_array)
            .ok_or_else(|| WsError::invalid("files is invalid."))?
            .iter()
            .enumerate()
            .map(|(index, f)| {
                Ok(BatchFile {
                    rel_path: s(f, "relPath").or_else(|_| s(f, "rel"))?.to_owned(),
                    content: s(f, "content")?.to_owned(),
                    expected_content: s(f, "expectedContent")?.to_owned(),
                    content_lone: Self::held_lone(req, &format!("/files/{index}/content")),
                    expected_lone: Self::held_lone(req, &format!("/files/{index}/expectedContent")),
                })
            })
            .collect()
    }

    /// Whether the free-text param at `pointer` held an unpaired surrogate escape on the wire (now U+FFFD); the server refused
    /// every other place (mixdog-app-protocol `free_text`).
    fn held_lone(req: &CoreRequest, pointer: &str) -> bool {
        req.ctx.lone_surrogates.iter().any(|held| matches!(held, mixdog_js::LoneAt::Value(at) if at == pointer))
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
            "transfer/authorizeRead",
            "transfer/redeemGrant",
            "transfer/finishRead",
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