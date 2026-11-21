//! The workspace `DomainService`: maps the `project/*`, `projectFs/*`, `fs/*`, `search/*`, `transfer/*` and `lsp/*` wire
//! methods to this crate's services. Every `root` is resolved through the project registry, which is also the
//! project-boundary table for relay origins.

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
use mixdog_core_api::feed::Window;
use mixdog_core_api::host::HostCapability;
use mixdog_core_api::host::HostChannel;
use mixdog_core_api::host::HostError;
use mixdog_core_api::ids::ConnectionId;
use mixdog_core_api::ids::Method;
use mixdog_core_api::service::Admit;
use mixdog_core_api::service::DomainService;
use mixdog_core_base::ops::{OpRecord as StoredOpRecord, OpState, PayloadDigest, op_record, replay_audience, set_op_row_outcome};
use serde_json::Value;
use serde_json::json;
use std::collections::HashMap;

use crate::catalog::Catalog;
use crate::catalog::OpRecord;
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
use crate::serverdownload::RemoteFileReader;
use crate::serverdownload::SERVER_DOWNLOAD_MAX_BYTES;
use crate::serverdownload::ServerDownloads;
use crate::textsearch::TextQuery;
use crate::transfer::Owner;
use crate::transfer::Transfers;
use crate::watcher::ChangeKind;
use crate::watcher::ChangeSink;
use crate::watcher::FolderWatcher;
use mixdog_store::state::OpRow;
use mixdog_store::state::OpRowState;

mod file_calls;
mod lsp_calls;
mod project_calls;
mod transfer_calls;
mod watch_calls;

/// Publishes file watches. Search checks freshness at the shared watcher root,
/// before events are batched for individual subscribers.
struct Router {
    fs: Mutex<HashMap<String, Arc<Publisher>>>,
}

impl ChangeSink for Router {
    fn changed(&self, watch_id: &str, paths: Vec<String>, kind: ChangeKind) {
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
    /// The raw upload chunk the serving core advertises at `initialize` (`limits.maxBlobPutChunkBytes`), stated in the begin
    /// answer as a fact of the transfer. A sender takes the size from its connection's limits; this is for a UI that reads it here.
    pub upload_chunk_bytes: u64,
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

/// The links to the servers this PC is connected to, as far as a download to this PC needs them: the reader of one server's
/// files (`None` when no link to it is held).
pub trait RemoteFileReaders: Send + Sync {
    fn reader(&self, server_id: &str) -> Option<Arc<dyn RemoteFileReader>>;
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

/// What a page lease is asked again before every response: a one-file lease of a window lives while its desktop grant does and
/// names that file; a paired device's one-file lease (no desktop token) and a project lease stand on the check the caller passed
/// when the URL was made, as the window's page server authorized them.
struct DesktopPageAuthority {
    grants: Arc<crate::desktop_grants::DesktopGrantStore>,
}

#[async_trait]
impl crate::pageserver::PageAuthority for DesktopPageAuthority {
    async fn check(&self, scope: &crate::pageserver::lease::PageScope, absolute: &Path) -> Result<(), crate::pageserver::Refusal> {
        use crate::pageserver::Refusal;
        match scope {
            // A virtual page is the caller's own content (the visualize page): no grant or folder to check; a closed owner's
            // leases end through `projectFs/localPage/revokeOwner`.
            crate::pageserver::lease::PageScope::Project
            | crate::pageserver::lease::PageScope::File { grant_token: None }
            | crate::pageserver::lease::PageScope::Virtual { .. } => Ok(()),
            crate::pageserver::lease::PageScope::File { grant_token: Some(token) } => match self.grants.still_granted(token, absolute).await {
                Ok(true) => Ok(()),
                Ok(false) => Err(Refusal::Denied),
                Err(_) => Err(Refusal::Transient),
            },
        }
    }
}

pub struct WorkspaceService {
    me: OnceLock<Weak<WorkspaceService>>,
    feeds: Arc<dyn ScopedFeeds>,
    lanes: Lanes,
    catalog: Catalog,
    fs: Arc<ProjectFs>,
    paths: Claims<PathBuf>,
    transfers: Arc<Transfers>,
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
    /// The media leases of a paired device's streamable project-file previews (served by the relay media lane).
    project_leases: Arc<crate::media_lease::ProjectFileLeases>,
    /// The desktop's persisted one-file grants and the core's page server ([`Self::enable_desktop_files`]).
    desktop_grants: OnceLock<Arc<crate::desktop_grants::DesktopGrantStore>>,
    page_server: OnceLock<Arc<crate::pageserver::PageServer>>,
    /// The sweepers run once, whatever the number of calls to [WorkspaceService::spawn_idle_sweeper].
    sweepers: std::sync::Once,
    /// The user's Markdown default view, read when editor settings are (see [`Self::set_user_markdown_view`]).
    user_markdown_view: OnceLock<UserMarkdownView>,
    /// The task folder the host resolved (see [`Self::set_task_folder`]); unset: the default under the user data.
    task_folder: OnceLock<PathBuf>,
    /// Where a path inside a managed worktree is resolved to its owner Project (see [`ManagedProjects`]).
    managed: OnceLock<Arc<dyn ManagedProjects>>,
    releases: Arc<crate::release::FolderReleases>,
    upload_chunk_bytes: u64,
    /// "Download to this PC" of a server window's files (`transfer/serverDownload/*`); the bytes come through [`Self::set_remote_files`].
    server_downloads: Arc<ServerDownloads>,
    remote_files: OnceLock<Arc<dyn RemoteFileReaders>>,
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

/// Largest staged upload (`shared/server-files.ts`).
use crate::transfer::{UPLOAD_MAX_BYTES, unavailable};

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

/// The op scope of a mutating method (the method table's `mutation: op(Scope)`).
fn op_scope(method: &str) -> Option<&'static str> {
    Some(match method {
        "project/create" | "project/touch" | "project/update" | "project/delete" | "project/ensureDirectory" => "project",
        "projectFs/writeText"
        | "projectFs/writeTextBatch"
        | "projectFs/create"
        | "projectFs/rename"
        | "projectFs/move"
        | "projectFs/copy"
        | "projectFs/trash"
        | "projectFs/replaceText"
        | "projectFs/recovery"
        | "projectFs/backup/write"
        | "projectFs/backup/delete"
        | "projectFs/workspaceFile/write" => "projectFs",
        "transfer/beginWrite" | "transfer/commit" | "transfer/trash/entry" => "transfer",
        "lsp/request" => "lsp",
        _ => return None,
    })
}

/// Registry changes commit their op row inside their own store transaction.
fn commits_op_itself(method: &str) -> bool {
    matches!(method, "project/create" | "project/touch" | "project/update" | "project/delete")
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
        if req.method.as_str() == "projectFs/localPageUrl" {
            let leased = async { this.local_page_url(&req, this.page_server()?).await };
            return leased.await.map(Reply::Value).map_err(|e| this.map_error(&req, e));
        }
        if req.method.as_str() == "projectFs/captureSnapshot" {
            // The path is confined here; the window only renders it. A one-file grant names the granted file alone.
            let confined = async {
                let (root, rel) = this.file_target(&req, &req.params).await?;
                project_entry_path(&root, &rel)?;
                let granted = req.params.get("accessToken").is_some();
                Ok::<_, WsError>(json!({ "root": root.to_string_lossy(), "rel": rel, "grant": granted }))
            };
            let host_params = confined.await.map_err(|e| this.map_error(&req, e))?;
            return this.host_files("host/capture/fileSnapshot", host_params).await.map(Reply::Value);
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
            "projectFs/grant/describe",
            "projectFs/grant/redeem",
            "projectFs/localPage/revokeOwner",
            "projectFs/localPage/origin",
            "projectFs/localPage/assetType",
            "projectFs/localPage/virtual",
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
            "transfer/serverDownload/begin",
            "transfer/serverDownload/step",
            "transfer/serverDownload/finish",
            "transfer/serverDownload/abort",
            "transfer/serverDownload/check",
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

#[cfg(test)]
mod serverdownload_calls {
    use std::collections::HashMap;

    use base64::Engine;
    use mixdog_core_api::call::CallContext;
    use mixdog_core_api::domain::mock::MockProcessManager;
    use mixdog_core_api::mock::MockLimits;
    use mixdog_core_api::mock::MockScopedFeeds;

    use super::*;

    struct NoGit;

    #[async_trait]
    impl crate::zip::TrackedFiles for NoGit {
        async fn files(&self, _: &Path, _: &CancellationToken) -> Option<Vec<String>> {
            None
        }
        async fn ignored(&self, _: &Path, _: &CancellationToken) -> Option<u64> {
            None
        }
    }

    struct Server(Vec<u8>);

    #[async_trait]
    impl RemoteFileReader for Server {
        async fn stat(&self, _: &str, _: &str) -> WsResult<Value> {
            Ok(json!({ "size": self.0.len(), "mtimeMs": 1700.5 }))
        }
        async fn read_range(&self, _: &str, _: &str, offset: u64, length: u64) -> WsResult<Value> {
            let start = (offset as usize).min(self.0.len());
            let end = (start + length as usize).min(self.0.len());
            Ok(json!({
                "offset": offset,
                "size": self.0.len(),
                "mtimeMs": 1700.5,
                "data": base64::engine::general_purpose::STANDARD.encode(&self.0[start..end]),
            }))
        }
    }

    struct Links(HashMap<String, Vec<u8>>);

    impl RemoteFileReaders for Links {
        fn reader(&self, server_id: &str) -> Option<Arc<dyn RemoteFileReader>> {
            self.0.get(server_id).map(|bytes| Arc::new(Server(bytes.clone())) as Arc<dyn RemoteFileReader>)
        }
    }

    fn service(dir: &Path) -> Arc<WorkspaceService> {
        let tokens = mixdog_rt::testing::tokens();
        let (state, _) = mixdog_store::state::CoreState::open(tokens.sqlite_writer_thread, tokens.interactive_io, &dir.join("core.sqlite")).unwrap();
        WorkspaceService::new(Deps {
            lanes: Lanes {
                interactive: tokens.interactive_io,
                durability: tokens.durability_io,
                maintenance: tokens.maintenance_io,
                cpu_bulk: tokens.cpu_bulk,
            },
            feeds: Arc::new(MockScopedFeeds::new(MockLimits::default())),
            processes: Arc::new(MockProcessManager::default()),
            tracked: Arc::new(NoGit),
            state,
            recovery_dir: dir.join("recovery"),
            user_data_dir: dir.join("userData"),
            sources: Vec::new(),
            code_graph: None,
            turn_review: None,
            releases: crate::release::FolderReleases::new(),
            upload_chunk_bytes: mixdog_app_protocol::limits::Limits::default().max_blob_put_chunk_bytes,
        })
        .unwrap()
    }

    async fn call(service: &WorkspaceService, method: &'static str, params: Value) -> Result<Value, CoreError> {
        let ctx = CallContext::connection(ConnectionId(2), mixdog_protocol::Origin::Local, CancellationToken::new());
        match service.call(CoreRequest { method: Method(method), params, op: None, ctx }).await? {
            Reply::Value(value) => Ok(value),
            Reply::Subscribe(_) => panic!("unexpected subscribe"),
        }
    }

    fn begin_params(downloads: &Path, server: &str, rel: &str) -> Value {
        json!({ "serverId": server, "downloadsDir": downloads.to_string_lossy(), "root": "/srv", "rel": rel })
    }

    fn parts(dir: &Path) -> usize {
        std::fs::read_dir(dir).map_or(0, |rows| rows.filter(|row| row.as_ref().unwrap().file_name().to_string_lossy().ends_with(".part")).count())
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn the_task_folder_is_the_resolved_one_for_every_reader() {
        let dir = tempfile::tempdir().unwrap();
        let service = service(dir.path());
        let cancel = CancellationToken::new();
        let default = service.task_workspace(&cancel).await.unwrap();
        assert!(default.ends_with(Path::new("workspace").join("unclassified")));
        let migrated = dir.path().join("old-tasks");
        service.set_task_folder(migrated.clone());
        let resolved = service.task_workspace(&cancel).await.unwrap();
        assert!(resolved.ends_with("old-tasks") && migrated.is_dir());
        let answered = call(&service, "project/taskWorkspace", json!({})).await.unwrap();
        assert_eq!(answered, json!({ "path": resolved.to_string_lossy() }));
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_server_that_is_not_linked_is_not_connected() {
        let dir = tempfile::tempdir().unwrap();
        let service = service(dir.path());
        let downloads = dir.path().join("downloads");
        let refused = |error: CoreError| format!("{error:?}").contains("This SSH server is not connected");
        assert!(refused(call(&service, "transfer/serverDownload/begin", begin_params(&downloads, "s1", "a.txt")).await.unwrap_err()));
        service.set_remote_files(Arc::new(Links(HashMap::new())));
        assert!(refused(call(&service, "transfer/serverDownload/begin", begin_params(&downloads, "s1", "a.txt")).await.unwrap_err()));
        assert!(!downloads.exists());
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_download_runs_to_this_pcs_folder_under_a_free_name_and_may_then_be_opened() {
        let dir = tempfile::tempdir().unwrap();
        let service = service(dir.path());
        service.set_remote_files(Arc::new(Links(HashMap::from([("s1".to_owned(), b"0123456789".to_vec())]))));
        let downloads = dir.path().join("downloads");
        let mut paths = Vec::new();
        for _ in 0..2 {
            let begun = call(&service, "transfer/serverDownload/begin", begin_params(&downloads, "s1", "a/report.txt")).await.unwrap();
            assert_eq!((begun["name"].as_str(), begun["size"].as_u64()), (Some("report.txt"), Some(10)));
            let id = begun["downloadId"].as_str().unwrap().to_owned();
            let stepped = call(&service, "transfer/serverDownload/step", json!({ "downloadId": id })).await.unwrap();
            assert_eq!((stepped["received"].as_u64(), stepped["size"].as_u64(), stepped["done"].as_bool()), (Some(10), Some(10), Some(true)));
            let finished = call(&service, "transfer/serverDownload/finish", json!({ "downloadId": id })).await.unwrap();
            paths.push(finished["path"].as_str().unwrap().to_owned());
        }
        assert_eq!(paths[0], downloads.join("report.txt").to_string_lossy());
        assert_eq!(paths[1], downloads.join("report (2).txt").to_string_lossy());
        assert_eq!(std::fs::read(&paths[1]).unwrap(), b"0123456789");
        assert_eq!(parts(&downloads), 0);
        assert_eq!(call(&service, "transfer/serverDownload/check", json!({ "path": paths[0] })).await.unwrap(), json!(true));
        let other = downloads.join("other.txt").to_string_lossy().into_owned();
        assert_eq!(call(&service, "transfer/serverDownload/check", json!({ "path": other })).await.unwrap(), json!(false));
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn an_aborted_download_leaves_no_part_file() {
        let dir = tempfile::tempdir().unwrap();
        let service = service(dir.path());
        service.set_remote_files(Arc::new(Links(HashMap::from([("s1".to_owned(), b"abc".to_vec())]))));
        let downloads = dir.path().join("downloads");
        let begun = call(&service, "transfer/serverDownload/begin", begin_params(&downloads, "s1", "x.bin")).await.unwrap();
        let id = begun["downloadId"].as_str().unwrap();
        assert_eq!(parts(&downloads), 1);
        assert_eq!(call(&service, "transfer/serverDownload/abort", json!({ "downloadId": id })).await.unwrap(), json!(true));
        assert_eq!(call(&service, "transfer/serverDownload/abort", json!({ "downloadId": id })).await.unwrap(), json!(false));
        for _ in 0..100 {
            if parts(&downloads) == 0 {
                return;
            }
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
        panic!("the part file is still there");
    }
}

impl WorkspaceService {
    pub fn new(deps: Deps) -> WsResult<Arc<Self>> {
        Self::build(deps, Arc::new(Transfers::default()), crate::editorcfg::now_ms)
    }

    /// [`WorkspaceService::new`] with the editor backups on `backup_clock` (epoch milliseconds).
    pub fn with_backup_clock(deps: Deps, backup_clock: fn() -> i64) -> WsResult<Arc<Self>> {
        Self::build(deps, Arc::new(Transfers::default()), backup_clock)
    }

    fn build(deps: Deps, transfers: Arc<Transfers>, backup_clock: fn() -> i64) -> WsResult<Arc<Self>> {
        let router = Arc::new(Router { fs: Mutex::default() });
        let watcher = Arc::new(FolderWatcher::new(router.clone())?);
        let search = SearchSessions::new(deps.lanes, deps.feeds.clone(), watcher.clone());
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
            backups: Arc::new(crate::editorcfg::Backups::with_clock(&deps.user_data_dir, backup_clock)),
            user_data: deps.user_data_dir,
            state: deps.state,
            host: OnceLock::new(),
            phone_grants: OnceLock::new(),
            project_leases: crate::media_lease::ProjectFileLeases::new(deps.lanes),
            desktop_grants: OnceLock::new(),
            page_server: OnceLock::new(),
            sweepers: std::sync::Once::new(),
            user_markdown_view: OnceLock::new(),
            task_folder: OnceLock::new(),
            managed: OnceLock::new(),
            releases: deps.releases,
            upload_chunk_bytes: deps.upload_chunk_bytes,
            server_downloads: ServerDownloads::new(SERVER_DOWNLOAD_MAX_BYTES, deps.lanes),
            remote_files: OnceLock::new(),
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
        // The ends of the leases the relay media lane streams under, published at their deadlines (one scheduler per table): a stream
        // parked for room is released when its lease ends, not when the next tick or the next writable notification comes.
        let leases = self.transfers.clone();
        drop(mixdog_rt::spawn("download-lease-ends", mixdog_rt::TaskClass::Work, async move {
            #[cfg(feature = "replay-controls")]
            if let Some(clock) = crate::replay_controls::clock() {
                return leases.run_lease_ends(&*clock).await;
            }
            leases.run_lease_ends(&crate::transfer::TokioTimer).await;
        }));
        let projects = self.project_leases.clone();
        drop(mixdog_rt::spawn("project-lease-expiry", mixdog_rt::TaskClass::Work, async move {
            projects.run_expiry().await;
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
    pub fn catalog(&self) -> &Catalog {
        &self.catalog
    }

    /// Connects the host channel `projectFs/captureSnapshot` goes through; without one it answers
    /// `capabilityUnavailable`. Set once.
    pub fn set_host(&self, host: Arc<dyn HostChannel>) {
        let _ = self.host.set(host);
    }

    /// The folder tasks run in, when the host resolved one other than `<userData>/workspace/unclassified`
    /// (a migrated profile keeps its old one). `project/taskWorkspace` and the move of a session back to
    /// Tasks answer with it. Set once.
    pub fn set_task_folder(&self, folder: PathBuf) {
        let _ = self.task_folder.set(folder);
    }

    /// The task folder, created if missing, as its real path.
    pub async fn task_workspace(&self, cancel: &CancellationToken) -> WsResult<PathBuf> {
        let folder = self.task_folder.get().cloned().unwrap_or_else(|| crate::editorcfg::default_task_workspace(&self.user_data));
        run_fallible(self.lanes.durability, cancel, move || crate::editorcfg::task_workspace(&folder)).await
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

    /// Connects the links to the servers, the source of the files `transfer/serverDownload/begin` copies. Without it every
    /// begin answers that the server is not connected. Set once.
    pub fn set_remote_files(&self, readers: Arc<dyn RemoteFileReaders>) {
        let _ = self.remote_files.set(readers);
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
    pub fn set_phone_grants(&self, store: Arc<crate::grants::GrantStore>, credential_of: Arc<dyn Fn(ConnectionId) -> Option<String> + Send + Sync>) {
        // A device that unpairs loses its downloads in the same step as its grants, whether or not any connection of it is attached.
        let transfers = self.transfers.clone();
        let previews = self.project_leases.clone();
        store.on_unpaired(Arc::new(move |credential| {
            transfers.revoke_owner(&Owner::device(credential));
            previews.revoke_device(credential);
        }));
        // A conversation a publication lists again is a member again (Node's replaceable catalog).
        let transfers = self.transfers.clone();
        store.on_listed(Arc::new(move |sessions| transfers.relisted(sessions)));
        let _ = self.phone_grants.set(PhoneGrants { store, credential_of });
    }

    /// Turns on the desktop's file grants (`projectFs/grant/*`) and the page server (`projectFs/localPageUrl`,
    /// `projectFs/localPage/*`). The grants persist at `grants_file`, the page server keeps its port in `page_port_file`.
    /// Without this the four methods answer `unsupported`. Set once.
    pub fn enable_desktop_files(&self, grants_file: PathBuf, page_port_file: PathBuf) {
        let grants = crate::desktop_grants::DesktopGrantStore::new(grants_file, self.lanes);
        let authority = Arc::new(DesktopPageAuthority { grants: grants.clone() });
        let _ = self.desktop_grants.set(grants);
        let _ = self.page_server.set(crate::pageserver::PageServer::new(page_port_file, authority, self.lanes));
    }

    fn desktop_grants(&self) -> WsResult<&Arc<crate::desktop_grants::DesktopGrantStore>> {
        self.desktop_grants.get().ok_or_else(|| WsError::new(Reason::Unsupported, "Desktop file grants are not available."))
    }

    fn page_server(&self) -> WsResult<&Arc<crate::pageserver::PageServer>> {
        self.page_server.get().ok_or_else(|| WsError::new(Reason::Unsupported, "The local page server is not available."))
    }

    /// `projectFs/localPageUrl` through the core's page server. A call of a relay connection first passes the registered-project
    /// check of [`Self::root_of`] (or its own device grant), as every relay file call does; the lease is made from verified
    /// authority: a one-file grant leases that file alone, a root leases the project's pages.
    async fn local_page_url(&self, req: &CoreRequest, server: &Arc<crate::pageserver::PageServer>) -> WsResult<Value> {
        let params = &req.params;
        let (root, rel) = self.file_target(req, params).await?;
        project_entry_path(&root, &rel)?;
        // A paired device's token was redeemed from the phone table above: its lease is the one file, with no desktop grant to ask.
        let scope = match params.get("accessToken").and_then(Value::as_str) {
            Some(_) if req.ctx.origin == mixdog_protocol::Origin::Relay => crate::pageserver::lease::PageScope::File { grant_token: None },
            Some(token) => crate::pageserver::lease::PageScope::File { grant_token: Some(token.to_owned()) },
            None => crate::pageserver::lease::PageScope::Project,
        };
        let owner = params.get("ownerId").and_then(Value::as_str).map(str::to_owned);
        Ok(Value::String(server.lease_url(&root, &rel, scope, owner).await?))
    }

    /// The grant store and the paired device the request comes from.
    fn phone_grants_for(&self, req: &CoreRequest) -> WsResult<(Arc<crate::grants::GrantStore>, String, u64)> {
        let grants = self.phone_grants.get().ok_or_else(|| WsError::new(Reason::Unsupported, "Paired-device file grants are not available."))?;
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

    /// The media leases of paired devices' project-file previews, for the relay media lane to serve.
    pub fn project_leases(&self) -> Arc<crate::media_lease::ProjectFileLeases> {
        self.project_leases.clone()
    }

    /// The phone's file-download lease `media_id` names for `device`, as the relay media lane reads it (`resolveMedia`).
    pub fn download_file(&self, device: &str, media_id: &str) -> Option<crate::media_lease::DownloadFile> {
        crate::media_lease::download_file(&self.transfers, self.lanes, device, media_id)
    }

    /// A gallery file opened for one request of the relay media lane (`openAuthorizedFile(path, dirname(path))`).
    pub async fn open_gallery_file(&self, path: PathBuf, mime: String) -> Option<crate::media_lease::LeasedFile> {
        let within = path.parent()?.to_path_buf();
        crate::media_lease::open_within(self.lanes, path, within, mime).await
    }

    pub fn watcher(&self) -> Arc<FolderWatcher> {
        self.watcher.clone()
    }

    pub fn open_os_watches(&self) -> usize {
        self.watcher.open_watches()
    }

    /// A connection closed: its watches, searches and transfers end with it.
    pub fn connection_closed(&self, connection: &ConnectionId) {
        let owner = Owner::connection(connection.0).to_string();
        self.transfers.end_owner(&owner);
        self.read_windows.release_owner(&owner);
        if let Some(grants) = self.phone_grants.get() {
            grants.store.release(connection.0);
        }
        let watches: Vec<String> = self.watches.lock().expect("watches").iter().filter(|(_, w)| w.connection == owner).map(|(k, _)| k.clone()).collect();
        for id in watches {
            self.unwatch(&id);
        }
        let sessions: Vec<String> = self.search_owner.lock().expect("search owners").iter().filter(|(_, c)| **c == owner).map(|(k, _)| k.clone()).collect();
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

    /// An unpair ends what the device holds: what `connection` (one of the device's attached connections) owns, and the downloads
    /// of the credential it is attached under. A device with no connection attached ends through the grant store
    /// (see [`Self::set_phone_grants`]).
    pub fn revoke_device(&self, connection: &str) {
        let Ok(id) = connection.parse::<u64>() else { return };
        self.transfers.revoke_owner(&Owner::connection(id));
        if let Some(credential) =
            self.phone_grants.get().and_then(|grants| (grants.credential_of)(ConnectionId(id))).filter(|credential| !credential.is_empty())
        {
            self.transfers.revoke_owner(&Owner::device(&credential));
            self.project_leases.revoke_device(&credential);
        }
    }

    /// The relay handle closed (switched off, rotated, the core stopping): every phone download ends in that step, and a call in flight
    /// finds it revoked (Node's `fileDownloads.revokeAll` in the relay's `close`, `remote-relay.ts:653`).
    pub fn revoke_all_downloads(&self) {
        self.transfers.revoke_all();
        self.project_leases.revoke_all();
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
        let error = if req.params.get("nodeErrors") == Some(&Value::Bool(true)) && crate::pathguard::is_beyond_project(&error) {
            WsError::plain(error.message)
        } else {
            error
        };
        match error.reason {
            Reason::InvalidParams => CoreError::InvalidParams { path: "params".into(), expected: error.message.into() },
            Reason::PermissionDenied => CoreError::PermissionDenied { method: req.method.as_str().into(), origin: req.ctx.origin },
            Reason::PreconditionFailed { expected, actual } => CoreError::PreconditionFailed {
                precondition: Precondition::Content { expected: Some(Bytes::from(expected)), actual: Some(Bytes::from(actual)) },
            },
            Reason::Overloaded => CoreError::QueueFull { queue: "workspace".into() },
            Reason::Cancelled => CoreError::Cancelled { by: "caller".into() },
            Reason::Plain => CoreError::DomainError { domain: "workspace".into(), code: None, message: Some(error.message.clone().into()), detail: None },
            ref other => CoreError::DomainError {
                domain: "workspace".into(),
                code: Some(other.code().into()),
                message: Some(error.message.clone().into()),
                detail: None,
            },
        }
    }

    async fn root(&self, origin: mixdog_protocol::Origin, params: &Value) -> WsResult<PathBuf> {
        self.root_of(origin, params, "root").await
    }

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
            let token = token.as_str().ok_or_else(|| WsError::invalid("accessToken is invalid."))?;
            // A window's own call redeems the desktop's persisted grant; a paired device's token is the phone table's.
            if req.ctx.origin != mixdog_protocol::Origin::Relay
                && let Some(desktop) = self.desktop_grants.get()
            {
                let granted = desktop.redeem(token, s(params, "root")?, s(params, "rel")?).await?;
                return Ok((granted.root, granted.rel));
            }
            let (grants, credential, connection) = self.phone_grants_for(req)?;
            let granted = grants.redeem(&credential, connection, token, s(params, "root")?, s(params, "rel")?).await?;
            return Ok((granted.root, granted.rel));
        }
        Ok((self.root(req.ctx.origin, params).await?, s(params, "rel")?.to_owned()))
    }

    /// A preview reuses the original permission, not merely the path it resolved to.
    fn preview_authority(&self, req: &CoreRequest, root: &Path, rel: &str, device: &str) -> crate::media_lease::Authorize {
        let service = self.me.get().cloned().expect("workspace owns a weak self reference");
        let given = req.params.clone();
        let caller = req.ctx.caller.clone();
        let expected = (root.to_path_buf(), rel.to_owned());
        let device = device.to_owned();
        Arc::new(move || {
            let (service, given, caller, expected, device) = (service.clone(), given.clone(), caller.clone(), expected.clone(), device.clone());
            Box::pin(async move {
                let Some(service) = service.upgrade() else { return false };
                if let Some(token) = given.get("accessToken") {
                    let mixdog_core_api::call::Caller::Connection(connection) = caller else { return false };
                    let Some(grants) = service.phone_grants.get() else { return false };
                    if (grants.credential_of)(connection).as_deref() != Some(device.as_str()) {
                        return false;
                    }
                    let (Some(token), Ok(root), Ok(rel)) = (token.as_str(), s(&given, "root"), s(&given, "rel")) else { return false };
                    return grants.store.redeem(&device, connection.0, token, root, rel).await.is_ok_and(|granted| (granted.root, granted.rel) == expected);
                }
                service.root(mixdog_protocol::Origin::Relay, &given).await.is_ok_and(|root| root == expected.0)
            })
        })
    }

    /// A paired phone's file named by its path: a file this device holds a live one-file grant for, or an entry of a registered
    /// project confined to it. The refusals are `PROJECT_UNAVAILABLE` "Project is not available." for a folder that is no project
    /// and "Path is outside the project." (no code) for an entry beyond it. The answer is the file as admitted, and the caller
    /// acts on it in place of what the phone sent.
    pub async fn relay_file(&self, req: &CoreRequest, root: &str, rel: &str) -> Result<RelayTarget, CoreError> {
        self.relay_target(req, root, rel).await.map_err(|error| self.map_error(req, error))
    }

    /// A paired phone's range read of a visualize pane's file (`visualize_pane::range`): the tab's own panes decide what is
    /// servable, so no project registration or grant is asked.
    pub async fn visualize_pane_range(
        &self,
        req: &CoreRequest,
        scope: crate::visualize_pane::PaneScope,
        rel: String,
        offset: u64,
        length: u64,
    ) -> Result<Value, CoreError> {
        let length =
            if (1..=crate::preview::RANGE_MAX).contains(&length) { length } else { return Err(self.map_error(req, WsError::invalid("length is invalid."))) };
        run_fallible(self.lanes.interactive, &req.ctx.cancel, move || crate::visualize_pane::range(&scope, &rel, offset, length))
            .await
            .map_err(|error| self.map_error(req, error))
    }

    /// A private copy of an admitted file's bytes, made through its authorized handle (`visualize_pane::private_copy`).
    pub async fn relay_private_copy(&self, req: &CoreRequest, root: String, rel: String) -> Result<crate::visualize_pane::PrivateCopy, CoreError> {
        run_fallible(self.lanes.interactive, &req.ctx.cancel, move || crate::visualize_pane::private_copy(Path::new(&root), &rel))
            .await
            .map_err(|error| self.map_error(req, error))
    }

    /// A paired phone's metadata read of pane `index` (`visualize_pane::file`).
    pub async fn visualize_pane_file(&self, req: &CoreRequest, scope: crate::visualize_pane::PaneScope, index: usize) -> Result<Value, CoreError> {
        run_fallible(self.lanes.interactive, &req.ctx.cancel, move || crate::visualize_pane::file(&scope, index))
            .await
            .map_err(|error| self.map_error(req, error))
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
        match req.method.as_str() {
            "project/list" => self.handle_project_list().await,
            "project/read" => self.handle_project_read(req).await,
            "project/create" => self.handle_project_create(req, op).await,
            "project/touch" => self.handle_project_touch(req, op).await,
            "project/update" => self.handle_project_update(req, op).await,
            "project/delete" => self.handle_project_delete(req, op).await,
            "project/ensureDirectory" => self.handle_project_ensure_directory(req).await,
            "project/directory" => self.handle_project_directory(req).await,
            "projectFs/grant/describe" => self.handle_project_fs_grant_describe(req).await,
            "projectFs/grant/redeem" => self.handle_project_fs_grant_redeem(req).await,
            "projectFs/localPage/revokeOwner" => self.handle_project_fs_local_page_revoke_owner(req).await,
            "projectFs/localPage/origin" => self.handle_project_fs_local_page_origin().await,
            "projectFs/localPage/assetType" => self.handle_project_fs_local_page_asset_type(req).await,
            "projectFs/localPage/virtual" => self.handle_project_fs_local_page_virtual(req).await,
            "project/recoveryDirectory" => self.handle_project_recovery_directory(req).await,
            "projectFs/listDir" => self.handle_project_fs_list_dir(req).await,
            "projectFs/readText" => self.handle_project_fs_read_text(req).await,
            "projectFs/stat" => self.handle_project_fs_stat(req).await,
            "projectFs/entryPath" => self.handle_project_fs_entry_path(req).await,
            "projectFs/browseDirs" => self.handle_project_fs_browse_dirs(req).await,
            "projectFs/previewFile" => self.handle_project_fs_preview_file(req).await,
            "projectFs/previewRange" => self.handle_project_fs_preview_range(req).await,
            "projectFs/readLocal" => self.handle_project_fs_read_local(req).await,
            "projectFs/statLocal" => self.handle_project_fs_stat_local(req).await,
            "projectFs/writeText" => self.handle_project_fs_write_text(req).await,
            "projectFs/writeTextBatch" => self.handle_project_fs_write_text_batch(req).await,
            "projectFs/create" => self.handle_project_fs_create(req).await,
            "projectFs/rename" => self.handle_project_fs_rename(req).await,
            "projectFs/move" | "projectFs/copy" => self.handle_project_fs_move_or_copy(req).await,
            "projectFs/trash" => self.handle_project_fs_trash(req).await,
            "projectFs/searchText" => self.handle_project_fs_search_text(req).await,
            "projectFs/replaceText" => self.handle_project_fs_replace_text(req).await,
            "projectFs/recovery" => self.handle_project_fs_recovery(req).await,
            "fs/watch" => self.handle_fs_watch(req).await,
            "fs/unwatch" => self.handle_fs_unwatch(req).await,
            "search/start" => self.handle_search_start(req).await,
            "search/update" => self.handle_search_update(req).await,
            "search/stop" => self.handle_search_stop(req).await,
            "transfer/beginRead" => self.handle_transfer_begin_read(req).await,
            "transfer/beginZip" => self.handle_transfer_begin_zip(req).await,
            "transfer/readRange" => self.handle_transfer_read_range(req).await,
            "transfer/authorizeRead" => self.handle_transfer_authorize_read(req).await,
            "transfer/redeemGrant" => self.handle_transfer_redeem_grant(req).await,
            "transfer/finishRead" => self.handle_transfer_finish_read(req).await,
            "transfer/endRead" => self.handle_transfer_end_read(req).await,
            "transfer/beginWrite" if params.get("scope").is_some() => self.handle_transfer_begin_write_staged(req).await,
            "transfer/beginWrite" => self.handle_transfer_begin_write(req).await,
            "transfer/writeChunk" => self.handle_transfer_write_chunk(req).await,
            "transfer/commit" => self.handle_transfer_commit(req).await,
            "transfer/abort" => self.handle_transfer_abort(req).await,
            "transfer/serverDownload/begin" => self.handle_transfer_server_download_begin(req).await,
            "transfer/serverDownload/step" => self.handle_transfer_server_download_step(req).await,
            "transfer/serverDownload/finish" => self.handle_transfer_server_download_finish(req).await,
            "transfer/serverDownload/abort" => self.handle_transfer_server_download_abort(req).await,
            "transfer/serverDownload/check" => self.handle_transfer_server_download_check(req).await,
            "transfer/trash/info" => self.handle_transfer_trash_info(req).await,
            "transfer/grant/mint" => self.handle_transfer_grant_mint(req).await,
            "transfer/trash/entry" => self.handle_transfer_trash_entry(req).await,
            "projectFs/backup/read" => self.handle_project_fs_backup_read(req).await,
            "projectFs/backup/write" => self.handle_project_fs_backup_write(req).await,
            "projectFs/backup/delete" => self.handle_project_fs_backup_delete(req).await,
            "projectFs/workspaceFile/read" => self.handle_project_fs_workspace_file_read(req).await,
            "projectFs/workspaceFile/write" => self.handle_project_fs_workspace_file_write(req).await,
            "projectFs/readEditorSettings" => self.handle_project_fs_read_editor_settings(req).await,
            "project/taskWorkspace" => self.handle_project_task_workspace(req).await,
            "project/codeGraph" => self.handle_project_code_graph(req).await,
            "lsp/subscribe" => self.handle_lsp_subscribe(req).await,
            "lsp/unsubscribe" => self.handle_lsp_unsubscribe().await,
            "lsp/document" => self.handle_lsp_document(req).await,
            "lsp/request" => self.handle_lsp_request(req).await,
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
fn replay_recorded(found: OpRow, req: &CoreRequest, digest: &PayloadDigest, audience: &PayloadDigest) -> Result<Reply, CoreError> {
    let id = req.op.clone().expect("op present");
    if found.state == OpRowState::Fenced {
        return Err(CoreError::OpFenced { op_id: id });
    }
    if found.method != req.method.as_str() || found.payload_digest != digest.as_str() {
        return Err(CoreError::OpIdConflict { op_id: id });
    }
    let StoredOpRecord::Settled { audience: Some(owner), state, .. } = op_record(found)? else {
        return Err(CoreError::OpIdConflict { op_id: id });
    };
    if owner != *audience {
        return Err(CoreError::OpIdConflict { op_id: id });
    }
    match state {
        OpState::Applied { result, .. } => Ok(Reply::Value(result.unwrap_or_else(|| json!({})))),
        OpState::Rejected { error } => Err(error),
        OpState::ExternalPending { effect, target } | OpState::ExternalUnknown { effect, target } => {
            Err(CoreError::ExternalOutcomeUnknown { op_id: id, effect, target })
        }
    }
}

impl WorkspaceService {
    async fn with_op(self: &Arc<Self>, req: &CoreRequest, scope: &'static str, op_id: String) -> Result<Reply, CoreError> {
        let method = req.method.as_str();
        let digest = PayloadDigest::of_params(&req.params);
        let audience = replay_audience(&req.ctx);
        let state_error = |_| CoreError::Internal { incident_id: "workspace-op-store".into() };
        if let Some(found) = self.state.op(scope, &op_id).await.map_err(state_error)? {
            return replay_recorded(found, req, &digest, &audience);
        }
        let now = crate::catalog::now_ms();
        let mut record = OpRecord {
            scope: scope.to_owned(),
            op_id: op_id.clone(),
            audience,
            row: OpRow {
                method: method.to_owned(),
                payload_digest: digest.as_str().to_owned(),
                state: OpRowState::InProgress,
                outcome: None,
                created_at: now,
                completed_at: None,
            },
        };
        let own = commits_op_itself(method);
        if !own {
            let pending = OpState::ExternalPending { effect: method.into(), target: "".into() };
            set_op_row_outcome(&mut record.row, Some(&record.audience), &pending, now);
            let begin = record.clone();
            self.state.write(move |tx| tx.put_op(&begin.scope, &begin.op_id, &begin.row)).await.map_err(state_error)?;
        }
        let result = self.dispatch(req, own.then(|| record.clone())).await;
        if !(own && result.is_ok()) {
            let settled = match &result {
                Ok(Reply::Value(value)) => OpState::Applied { seq: None, result: Some(value.clone()) },
                Ok(Reply::Subscribe(_)) => OpState::Applied { seq: None, result: Some(json!({})) },
                Err(error) => OpState::Rejected {
                    error: CoreError::DomainError { domain: "workspace".into(), code: Some(error.reason.code().into()), message: None, detail: None },
                },
            };
            set_op_row_outcome(&mut record.row, Some(&record.audience), &settled, crate::catalog::now_ms());
            self.state.write(move |tx| tx.put_op(&record.scope, &record.op_id, &record.row)).await.map_err(state_error)?;
        }
        result.map_err(|e| self.map_error(req, e))
    }
}
