use std::collections::HashMap;
use std::collections::HashSet;
use std::sync::Arc;
use std::sync::Mutex;

use async_trait::async_trait;
use mixdog_app_protocol::v2::params::ThreadSetCwdParams;
use mixdog_app_protocol::v2::params::ThreadSetEffortParams;
use mixdog_app_protocol::v2::params::ThreadSetToolModeParams;
use mixdog_app_protocol::v2::thread::ThreadMetadataUpdateParams;
use mixdog_app_protocol::v2::thread::ThreadOpParams;
use mixdog_app_protocol::v2::thread::ThreadReadStateUpdateParams;
use mixdog_core_api::CoreError;
use mixdog_core_api::CoreRequest;
use mixdog_core_api::DomainService;
use mixdog_core_api::Reply;
use mixdog_core_api::call::CallContext;
use mixdog_core_api::ids::ConnectionId;
use mixdog_core_api::ids::Method;
use mixdog_core_api::ids::ThreadId;
use mixdog_core_api::service::Admit;
use mixdog_core_base::support::FsFailure;
use mixdog_core_base::support::FsStep;
use mixdog_core_base::support::OpScopes;
use mixdog_core_base::support::decode;
use mixdog_core_base::support::failed;
use mixdog_core_base::support::invalid;
use mixdog_core_base::support::io_failure;
use mixdog_core_base::support::on_lane_wait;
use mixdog_core_base::support::wrong_method;
use mixdog_core_domains::domains::ai_admin::route_service::RouteService;
use mixdog_core_ports::ports::threads::ThreadState;
use mixdog_rt::CancellationToken;
use mixdog_store::schema::record::Header;
use mixdog_store::session_text::is_session_preview_noise;
use mixdog_store::session_text::session_message_text;
use mixdog_workspace::service::WorkspaceService;
use serde_json::Map;
use serde_json::Value;
use serde_json::json;

use super::SessionDirectory;
use super::archive_trees::Adjacency;
use super::archive_trees::ArchiveTrees;
use super::delete::is_session_id;
use super::delete::sidebar_flag;
use super::thread_state::SessionThreads;
use super::worktree::SessionWorkspaces;
use super::worktree::SettledMoves;
use super::worktree::WorktreeMaintenance;
use super::worktree::scm_error;
use super::worktree::worktree_state::is_within;

pub const READ_STATE_UPDATE: &str = "thread/readState/update";
pub const METADATA_UPDATE: &str = "thread/metadata/update";
pub const ARCHIVE: &str = "thread/archive";
pub const UNARCHIVE: &str = "thread/unarchive";
pub const SET_CWD: &str = "thread/setCwd";
pub const SET_EFFORT: &str = "thread/setEffort";
pub const SET_TOOL_MODE: &str = "thread/setToolMode";
/// The methods the service answers.
pub const METHODS: &[&str] = &[READ_STATE_UPDATE, METADATA_UPDATE, ARCHIVE, UNARCHIVE, SET_CWD, SET_EFFORT, SET_TOOL_MODE];

const DOMAIN: &str = "thread";
/// `Number.MAX_SAFE_INTEGER`.
const MAX_SAFE: f64 = 9_007_199_254_740_991.0;
/// `markRead`'s bound on a read count.
const MAX_READ_COUNT: i64 = 10_000_000;

const SESSION_UNAVAILABLE: &str = "Session is not available.";

/// The record's Project move asked for while the session worked, carried out when it settles:
/// `{ projectPath, requestedAt }`, `projectPath` null for the task workspace.
pub const PENDING_PROJECT_MOVE: &str = "pendingProjectMove";
/// The record's pending move that could not be carried out: `{ projectPath, message, at }`, until the next move is asked for.
pub const PROJECT_MOVE_FAILED: &str = "projectMoveFailed";
const PROJECT_MOVE_KEYS: [&str; 2] = [PENDING_PROJECT_MOVE, PROJECT_MOVE_FAILED];

/// The published workspace as the thread's state holds it: the Project move is the record's at the moment the workspace is
/// published, whatever move the publisher read, so a read that started before the record changed never shows a move that
/// is gone. Outside a git repository the move is an object of its own.
pub(crate) fn with_project_move(workspace: Option<Value>, header: &Header) -> Option<Value> {
    let moving: Map<String, Value> = PROJECT_MOVE_KEYS.iter().filter_map(|key| header.get(*key).map(|value| ((*key).to_owned(), value.clone()))).collect();
    let mut shown = match workspace {
        Some(Value::Object(shown)) => shown,
        other if moving.is_empty() => return other,
        _ => Map::new(),
    };
    for key in PROJECT_MOVE_KEYS {
        shown.shift_remove(key);
    }
    shown.extend(moving);
    (!shown.is_empty()).then_some(Value::Object(shown))
}

#[cfg(test)]
#[path = "project_move_tests.rs"]
mod project_move_tests;

/// The registered Projects and the task workspace, as a Project move reads them.
#[async_trait]
pub trait ProjectFolders: Send + Sync {
    /// Every registered Project's path (`listProjectsStrict`).
    async fn projects(&self) -> Result<Vec<String>, String>;
    /// `registeredProject(path)`: the registered Project's path, or the rejection's text.
    async fn registered(&self, path: &str) -> Result<String, String>;
    /// `canonicalDirectory(path)`: its real path, which must be a folder.
    async fn canonical_directory(&self, path: &str) -> Result<String, String>;
    /// `taskWorkspace()`: the folder of sessions in no Project, created when missing.
    async fn task_workspace(&self) -> Result<String, String>;
    /// `touchProjectSelected(cwd)`: the Project at `cwd` becomes the most recently selected.
    async fn touch_selected(&self, cwd: &str) -> Result<(), String>;
}

/// The route half of `setEffort`, [`RouteService`]'s.
#[async_trait]
pub trait EffortTuning: Send + Sync {
    /// `setEffort(value, { sessionOnly })`: the live route afterwards, or the thrown text.
    async fn set_effort(&self, thread: &ThreadId, value: &str, session_only: bool) -> Result<Value, String>;
    /// The live route.
    fn route(&self, thread: &ThreadId) -> Value;
}

#[async_trait]
impl EffortTuning for RouteService {
    async fn set_effort(&self, thread: &ThreadId, value: &str, session_only: bool) -> Result<Value, String> {
        RouteService::set_effort(self, thread, &Value::String(value.to_owned()), session_only).await
    }

    fn route(&self, thread: &ThreadId) -> Value {
        Value::Object(self.writer.route(thread))
    }
}

/// The desktop's auto-retention record. A restore's exemption from auto-archive is recorded in the archive authority
/// now, in the restore's own transaction ([`mixdog_store::archive_state::ArchiveEntry::Restored`]); the record keeps `enabledAt` and the
/// restores an earlier version recorded, which a delete drops.
#[async_trait]
pub trait ArchiveRetention: Send + Sync {
    /// `sessionRetention.forget(id)`: a deleted session's restore is dropped.
    async fn forget(&self, session_id: &str) -> Result<(), String>;
}

/// A finite number above zero, else none.
fn positive(value: Option<&Value>) -> Option<f64> {
    value.and_then(Value::as_f64).filter(|at| at.is_finite() && *at > 0.0)
}

/// [`ArchiveRetention`] over `desktop.retentionState` (`{ enabledAt, restored: { [id]: ms } }`).
/// Each note is one config write, in the config's write transaction,
/// read-modify-write: the stored record is normalized (
/// `enabledAt` defaults to now, non-positive stamps are dropped), changed, and written only when
/// the change or a missing `enabledAt` asks for it.
pub struct ConfigArchiveRetention {
    config: mixdog_core_config::config::Config,
    now: Arc<dyn Fn() -> i64 + Send + Sync>,
}

impl ConfigArchiveRetention {
    pub fn new(config: mixdog_core_config::config::Config, now: Arc<dyn Fn() -> i64 + Send + Sync>) -> Self {
        Self { config, now }
    }

    /// `update(mutate)`: the normalized `restored` map is handed to `mutate`, which says whether it
    /// changed it; the record is written when it did or when the stored one has no `enabledAt`.
    async fn update(&self, mutate: impl FnOnce(&mut Map<String, Value>, i64) -> bool + Send + 'static) -> Result<(), String> {
        let now = (self.now)();
        self.config
            .update(move |doc| {
                let current = doc.get("desktop").and_then(|desktop| desktop.get("retentionState"));
                let stored_restored = current.and_then(|record| record.get("restored")).and_then(Value::as_object);
                let mut restored: Map<String, Value> =
                    stored_restored.into_iter().flatten().filter(|(_, at)| positive(Some(at)).is_some()).map(|(id, at)| (id.clone(), at.clone())).collect();
                let stored_enabled = current.and_then(|record| record.get("enabledAt")).filter(|at| positive(Some(at)).is_some()).cloned();
                let changed = mutate(&mut restored, now);
                if !changed && stored_enabled.is_some() {
                    return Ok(());
                }
                let record = json!({ "enabledAt": stored_enabled.unwrap_or_else(|| json!(now)), "restored": restored });
                let desktop = doc.entry("desktop").or_insert_with(|| Value::Object(Map::new()));
                let Some(desktop) = desktop.as_object_mut() else {
                    return Err(mixdog_core_config::config::ConfigError::InvalidParams { path: "desktop".into(), expected: "an object".into() });
                };
                desktop.insert("retentionState".into(), record);
                Ok(())
            })
            .await
            .map(drop)
            .map_err(|error| error.to_string())
    }
}

/// The pass state: when the feature first ran here, and the sessions
/// the user brought back from the archive, with when.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct RetentionRecord {
    pub enabled_at: f64,
    pub restored: HashMap<String, f64>,
}

impl ConfigArchiveRetention {
    /// `sessionRetention.load()`: the record, creating it (`enabledAt` = now) when it has none; read through the same
    /// normalization as every note.
    pub async fn load(&self) -> Result<RetentionRecord, String> {
        let now = (self.now)();
        // The record is written only when it has no `enabledAt` yet: a pass reads it for each session it acts on.
        let has_enabled = |config: &mixdog_core_config::config::Config| {
            positive(config.get("desktop.retentionState").as_ref().and_then(|record| record.get("enabledAt"))).is_some()
        };
        if !has_enabled(&self.config) {
            self.update(|_, _| false).await?;
        }
        let stored = self.config.get("desktop.retentionState");
        let restored = stored
            .as_ref()
            .and_then(|record| record.get("restored"))
            .and_then(Value::as_object)
            .into_iter()
            .flatten()
            .filter_map(|(id, at)| positive(Some(at)).map(|at| (id.clone(), at)))
            .collect();
        let enabled_at = stored.as_ref().and_then(|record| positive(record.get("enabledAt"))).unwrap_or(now as f64);
        Ok(RetentionRecord { enabled_at, restored })
    }
}

#[async_trait]
impl ArchiveRetention for ConfigArchiveRetention {
    async fn forget(&self, session_id: &str) -> Result<(), String> {
        let id = session_id.to_owned();
        self.update(move |restored, _| restored.shift_remove(&id).is_some()).await
    }
}

/// [`ProjectFolders`] over the Project catalog of the workspace service, which also names the
/// task workspace.
pub struct WorkspaceFolders {
    service: Arc<WorkspaceService>,
    lanes: super::SessionLanes,
}

impl WorkspaceFolders {
    pub fn new(service: Arc<WorkspaceService>, lanes: super::SessionLanes) -> Self {
        Self { service, lanes }
    }
}

fn text_of(path: &std::path::Path) -> String {
    path.to_string_lossy().into_owned()
}

#[async_trait]
impl ProjectFolders for WorkspaceFolders {
    async fn projects(&self) -> Result<Vec<String>, String> {
        let rows = self.service.catalog().list().await.map_err(|error| error.message)?;
        Ok(rows.into_iter().map(|row| row.path).collect())
    }

    async fn registered(&self, path: &str) -> Result<String, String> {
        let found = self.service.catalog().resolve(path).await.map_err(|error| error.message)?;
        Ok(text_of(&found))
    }

    async fn canonical_directory(&self, path: &str) -> Result<String, String> {
        let path = std::path::PathBuf::from(path);
        let job = move |lane: &mixdog_rt::InLane<mixdog_rt::InteractiveIo>| {
            let real = mixdog_workspace::pathguard::canonical(&path).map_err(|error| error.to_string())?;
            match mixdog_statefile::metadata(lane, &real) {
                Ok(meta) if meta.is_dir() => Ok(text_of(&real)),
                Ok(_) => Err("Session workspace is not a directory.".to_owned()),
                Err(error) => Err(error.to_string()),
            }
        };
        on_lane_wait(self.lanes.io, &CancellationToken::new(), job).await.map_err(|error| format!("{error:?}"))?
    }

    async fn task_workspace(&self) -> Result<String, String> {
        self.service.task_workspace(&CancellationToken::new()).await.map(|path| text_of(&path)).map_err(|error| error.message)
    }

    async fn touch_selected(&self, cwd: &str) -> Result<(), String> {
        self.service.catalog().touch(cwd, None).await.map(drop).map_err(|error| error.message)
    }
}

// ---- rules ------------------------------------------------------------------------------

/// `Number.isSafeInteger(value) ? value : undefined`.
fn safe_integer(value: Option<&Value>) -> Option<f64> {
    let n = value?.as_f64()?;
    (n.fract() == 0.0 && n.abs() <= MAX_SAFE).then_some(n)
}

/// `validEpoch`: a safe non-negative integer.
fn valid_epoch(value: Option<&Value>) -> Option<f64> {
    safe_integer(value).filter(|n| *n >= 0.0)
}

/// A whole JSON number as the desktop writes it.
fn whole(n: f64) -> Value {
    json!(n as u64)
}

fn number(cursor: &Map<String, Value>, key: &str) -> f64 {
    cursor.get(key).and_then(Value::as_f64).unwrap_or(0.0)
}

/// `settleReadCursor`: a cursor recorded under another compaction count restarts at 0 (keeping
/// its revision); one from before the epoch was recorded is stamped with the current one and,
/// in a compacted session, lowered to its message count once a real count can judge it. A row
/// without a `compactCount` settles nothing.
pub fn settle_read_cursor(cursor: Option<&Map<String, Value>>, compact_count: Option<&Value>, message_count: Option<&Value>) -> Option<Map<String, Value>> {
    let cursor = cursor?;
    let Some(epoch) = valid_epoch(compact_count) else { return Some(cursor.clone()) };
    if cursor.get("epoch").and_then(Value::as_f64) == Some(epoch) {
        return Some(cursor.clone());
    }
    let mut restarted = number(cursor, "messageCount");
    if cursor.contains_key("epoch") {
        restarted = 0.0;
    } else if epoch > 0.0 {
        let Some(count) = safe_integer(message_count).filter(|n| *n >= 1.0) else { return Some(cursor.clone()) };
        restarted = restarted.min(count);
    }
    let mut settled = cursor.clone();
    settled.insert("messageCount".into(), whole(restarted));
    settled.insert("epoch".into(), whole(epoch));
    Some(settled)
}

/// `markRead`'s check: a session id and a whole count in `0..=10_000_000`.
pub fn read_cursor_valid(session_id: &str, count: i64) -> bool {
    is_session_id(session_id) && (0..=MAX_READ_COUNT).contains(&count)
}

/// What one `markRead` decides: the cursor to store (`None`: the stored one stands) and its
/// answer.
#[derive(Debug, PartialEq)]
pub struct ReadMark {
    pub store: Option<Map<String, Value>>,
    pub changed: bool,
}

/// `markRead(id, messageCount, consumedUnread, { compactCount, messageCount })` over the stored
/// cursor: the cursor advances to the count read (never past the session's own messages), a
/// completion-only read (`consumed_unread`) is recorded when the count did not move.
pub fn mark_read(stored: Option<&Map<String, Value>>, count: i64, consumed_unread: bool, compact_count: Option<&Value>, own_count: Option<&Value>) -> ReadMark {
    let current = settle_read_cursor(stored, compact_count, own_count);
    let settled = current.as_ref() != stored;
    let own = safe_integer(own_count).unwrap_or(0.0);
    let count = count as f64;
    let current_count = current.as_ref().map_or(0.0, |cursor| number(cursor, "messageCount"));
    let next = current_count.max(if own >= 1.0 { count.min(own) } else { count });
    if let Some(cursor) = &current
        && next == number(cursor, "messageCount")
        && !consumed_unread
    {
        return ReadMark { store: settled.then(|| cursor.clone()), changed: settled };
    }
    let epoch = match &current {
        Some(cursor) => cursor.get("epoch").cloned(),
        None => valid_epoch(compact_count).map(whole),
    };
    let revision = (current.as_ref().map_or(0.0, |cursor| number(cursor, "revision")) + 1.0).min(MAX_SAFE);
    let mut cursor = Map::new();
    cursor.insert("messageCount".into(), whole(next));
    cursor.insert("revision".into(), whole(revision));
    if let Some(epoch) = epoch {
        cursor.insert("epoch".into(), epoch);
    }
    ReadMark { store: Some(cursor), changed: true }
}

/// `normalizeToolMode`: `full`, `readonly` or `lead`; anything else is `full`.
pub fn normalize_tool_mode(mode: &str) -> &'static str {
    match mixdog_js::js_trim(mode).to_lowercase().as_str() {
        "readonly" => "readonly",
        "lead" => "lead",
        _ => "full",
    }
}

/// `toolSpecForMode`.
pub fn tool_spec_for_mode(mode: &str) -> Value {
    if mode == "readonly" { json!(["tools:readonly"]) } else { json!("full") }
}

/// `sessionHasConversationMessages`: a user, assistant or tool message with text (an assistant
/// counts without), a user message that is no preview noise.
pub fn has_conversation_messages(messages: &[Value]) -> bool {
    messages.iter().any(|message| {
        let role = message.get("role").and_then(Value::as_str).unwrap_or_default();
        if !matches!(role, "user" | "assistant" | "tool") {
            return false;
        }
        let text = session_message_text(message.get("content").unwrap_or(&Value::Null));
        let text = mixdog_js::js_trim(&text);
        if text.is_empty() && role != "assistant" {
            return false;
        }
        !(role == "user" && is_session_preview_noise(text))
    })
}

/// `projectIdentity`: separators unified, trailing slash and surrounding whitespace dropped,
/// case folded.
pub fn project_identity(path: Option<&str>) -> String {
    let trimmed = mixdog_js::js_trim(path.unwrap_or_default());
    let mut unified = String::with_capacity(trimmed.len());
    for ch in trimmed.chars() {
        let ch = if ch == '\\' { '/' } else { ch };
        if !(ch == '/' && unified.ends_with('/')) {
            unified.push(ch);
        }
    }
    if unified.ends_with('/') {
        unified.pop();
    }
    unified.to_lowercase()
}

/// `sessionProjectKey(row, projectKeys)`: the deepest registered Project containing the row's
/// workspace Project, Project, folder or workspace folder; '' for none.
pub fn session_project_key(row: &Value, project_keys: &[String]) -> String {
    let text = |value: Option<&Value>| value.and_then(Value::as_str).map(str::to_owned);
    let candidates: Vec<String> =
        [text(row.pointer("/workspace/projectPath")), text(row.get("projectPath")), text(row.get("cwd")), text(row.pointer("/workspace/cwd"))]
            .iter()
            .map(|path| project_identity(path.as_deref()))
            .filter(|key| !key.is_empty())
            .collect();
    let contains = |project: &str, path: &str| !project.is_empty() && (path == project || path.starts_with(&format!("{project}/")));
    let mut best = String::new();
    for key in project_keys {
        if key.len() > best.len() && candidates.iter().any(|candidate| contains(key, candidate)) {
            best = key.clone();
        }
    }
    best
}

/// `agentDescendantIds(rows, rootId)`: the agent-only sessions under `root` at any depth,
/// following every owner and parent link a row names. `rows`: id and header.
pub fn agent_descendant_ids(rows: &[(String, Header)], root: &str) -> Vec<String> {
    Adjacency::of(rows).descendants(root)
}

// ---- the service -------------------------------------------------------------------------------

/// What [`ThreadSettings::new`] takes.
pub struct ThreadSettingsParts {
    pub directory: Arc<SessionDirectory>,
    pub workspaces: SessionWorkspaces,
    pub effort: Arc<dyn EffortTuning>,
    pub projects: Arc<dyn ProjectFolders>,
    /// The archive and restore of a session with its sub-agent sessions (shared with the session auto-retention).
    pub trees: Arc<ArchiveTrees>,
    pub ops: OpScopes,
    /// The surface generation (`invalidatePreSessionToolSurface`): a tool mode change and a workspace switch move it.
    pub surface: mixdog_core_base::surface::SurfaceGeneration,
    /// When a changed session row is on the app feed: a favorite change answers after it.
    pub rows: Arc<dyn super::thread_edges::RowsPublished>,
}

/// Where an archive or a restore hands its sessions: the session first, then its sub-agent sessions in the order found. A failure is the
/// hand-off's own; the archive stands.
#[async_trait]
pub trait ArchivedWorktrees: Send + Sync {
    async fn set_archived(&self, session_ids: &[String], archived: bool) -> Result<(), String>;
}

#[async_trait]
impl ArchivedWorktrees for WorktreeMaintenance {
    async fn set_archived(&self, session_ids: &[String], archived: bool) -> Result<(), String> {
        let ids: HashSet<String> = session_ids.iter().cloned().collect();
        self.set_archived_session_worktrees(&ids, archived, &CancellationToken::new()).await.map(drop).map_err(|error| format!("{error:?}"))
    }
}

#[derive(Default)]
pub struct ArchiveStamps(Mutex<i64>);

impl ArchiveStamps {
    /// The stamp an archive at `now` takes (`max(now, last + 1)`),
    /// taken and remembered in one step, so two archives at once never take the same one.
    pub fn take(&self, now: i64) -> i64 {
        let mut last = self.0.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        *last = now.max(*last + 1);
        *last
    }
}

pub struct ThreadSettings {
    parts: ThreadSettingsParts,
    threads: SessionThreads,
    moves: Arc<ProjectMoves>,
}

fn thread_of(id: Option<ThreadId>) -> Result<ThreadId, CoreError> {
    id.ok_or_else(|| invalid("threadId", "the thread to act on"))
}

fn port(error: mixdog_tools::orch::util::PortError) -> CoreError {
    failed(DOMAIN, format!("{error:?}"))
}

/// What the record keeps of a move that could not be carried out.
pub(crate) fn failure_text(error: &CoreError) -> String {
    match error {
        CoreError::DomainError { message: Some(message), .. } => message.to_string(),
        other => format!("{other:?}"),
    }
}

/// The Project moves of the sessions (`setSessionProject`, `setCwd`). A `setSessionProject` names its Project to the session's
/// actor, which alone decides what it means for the session, records it ([`PENDING_PROJECT_MOVE`]), begins it once the session
/// is settled and holds the session until it ended; it carries the move out here ([`SettledMoves`]).
struct ProjectMoves {
    me: std::sync::Weak<ProjectMoves>,
    directory: Arc<SessionDirectory>,
    workspaces: SessionWorkspaces,
    projects: Arc<dyn ProjectFolders>,
    surface: mixdog_core_base::surface::SurfaceGeneration,
}

impl SettledMoves for ProjectMoves {
    fn settled_move(&self, thread: &str, pending: Value) -> futures::future::BoxFuture<'static, Result<(), CoreError>> {
        let (me, thread) = (self.me.upgrade(), ThreadId::from(thread));
        Box::pin(async move {
            let me = me.ok_or_else(|| failed(DOMAIN, SESSION_UNAVAILABLE))?;
            me.carry(&thread, &pending).await
        })
    }
}

impl ThreadSettings {
    pub fn new(parts: ThreadSettingsParts) -> Self {
        let moves = Arc::new_cyclic(|me| ProjectMoves {
            me: me.clone(),
            directory: parts.directory.clone(),
            workspaces: parts.workspaces.clone(),
            projects: parts.projects.clone(),
            surface: parts.surface.clone(),
        });
        let settled: Arc<dyn SettledMoves> = moves.clone();
        parts.workspaces.set_settled_moves(Arc::downgrade(&settled));
        Self { threads: SessionThreads::new(parts.directory.clone()), parts, moves }
    }

    fn now(&self) -> i64 {
        self.parts.directory.deps().clock.now_ms()
    }

    /// The session, loaded: `threadNotFound` for one that does not exist.
    async fn open(&self, thread: &ThreadId) -> Result<Arc<super::SessionHandle>, CoreError> {
        self.parts.directory.open_handle(thread, &CallContext::internal("thread-settings")).await
    }

    /// One read-modify-write of header keys, decided against the header as it is when the
    /// patch lands: `decide` answers the keys to set and unset, or `None` to leave them.
    async fn update_header<T>(
        &self,
        thread: &ThreadId,
        keys: &[&str],
        mut decide: impl FnMut(&Header) -> (T, Option<(Map<String, Value>, Vec<String>)>),
    ) -> Result<T, CoreError> {
        loop {
            let header = self.threads.header(thread).await.map_err(port)?;
            let (answer, patch) = decide(&header);
            let Some((set, unset)) = patch else { return Ok(answer) };
            let expect: Map<String, Value> = keys.iter().map(|key| ((*key).to_owned(), header.get(*key).cloned().unwrap_or(Value::Null))).collect();
            if self.threads.patch_header_if(thread, expect, set, unset).await.map_err(port)?.is_none() {
                return Ok(answer);
            }
        }
    }

    /// `markSessionRead(id, messageCount, consumedUnread)`: whether the cursor changed.
    async fn mark_read(&self, params: ThreadReadStateUpdateParams) -> Result<Value, CoreError> {
        let thread = params.thread_id;
        if !read_cursor_valid(thread.as_str(), params.message_count) {
            return Err(failed(DOMAIN, "Session read cursor is invalid."));
        }
        // The session's own numbering, so a cursor of an earlier compaction restarts first.
        let row = self.parts.directory.session_meta(&thread).await?.map(|meta| meta.row).unwrap_or(Value::Null);
        let consumed = params.consumed_unread == Some(true);
        let changed = self
            .update_header(&thread, &["readState"], |header| {
                let stored = header.get("readState").and_then(Value::as_object);
                let mark = mark_read(stored, params.message_count, consumed, row.get("compactCount"), row.get("messageCount"));
                let patch = mark.store.map(|cursor| (Map::from_iter([("readState".to_owned(), Value::Object(cursor))]), Vec::new()));
                (mark.changed, patch)
            })
            .await?;
        Ok(Value::Bool(changed))
    }

    /// `setSessionFavorite(id, favorite)`.
    /// A change is answered once the session's row is on the app feed; no change publishes nothing.
    async fn set_favorite(&self, thread: &ThreadId, favorite: bool) -> Result<(), CoreError> {
        let now = self.now();
        let changed = self
            .update_header(thread, &["favoriteAt"], |header| {
                let patch = (favorite != sidebar_flag(header, "favoriteAt")).then(|| {
                    if favorite { (Map::from_iter([("favoriteAt".to_owned(), json!(now))]), Vec::new()) } else { (Map::new(), vec!["favoriteAt".to_owned()]) }
                });
                (patch.is_some(), patch)
            })
            .await?;
        if changed {
            self.parts.rows.published().await;
        }
        Ok(())
    }

    /// `setSessionProject(id, projectPath)`.
    async fn set_project(&self, thread: &ThreadId, project_path: &str) -> Result<(), CoreError> {
        self.moves.request(thread, project_path).await
    }

    /// `setSessionArchived(id, archived)`: the session with its sub-agent sessions, one change of the archive authority
    /// ([`ArchiveTrees::set_manual`]). Whether the session's own state changed.
    async fn set_archived(&self, thread: &ThreadId, archived: bool) -> Result<bool, CoreError> {
        self.parts.trees.set_manual(thread, archived).await
    }

    /// `setCwd(path)`: `resolveCwdPath` from the session's folder, then the Project switch with
    /// the desktop classification by membership; a Project selected becomes the most recent.
    /// The session's folder afterwards.
    async fn set_cwd(&self, thread: &ThreadId, path: &str, cancel: &CancellationToken) -> Result<Value, CoreError> {
        self.moves.move_to(thread, path, cancel, false, None).await
    }

    /// The Lead's own `session set-project` call: the calling turn
    /// is tolerated, the folder keeps any classification it was picked with (no membership test), and no Project becomes the
    /// most recent (that is the client's `setCwd` action). The session's folder afterwards.
    pub async fn set_caller_cwd(&self, thread: &ThreadId, path: &str) -> Result<String, CoreError> {
        let cwd = self.moves.move_to(thread, path, &CancellationToken::new(), true, None).await?;
        Ok(cwd.as_str().map(str::to_owned).unwrap_or_default())
    }
}

impl ProjectMoves {
    /// `setSessionProject(id, projectPath)`: a registered Project's folder, or '' for the task workspace. Only the Project is
    /// resolved here; it is handed to the session's actor with the registered Projects, and the actor decides in its own
    /// order what it asks of the session as it is then: nothing where the session already is (a pending move is dropped), a
    /// move at once for a settled session (the answer is the move's), a pending move for a working one (a later one replaces
    /// it), carried out when it settles, the turn running keeping its folder. A session in a managed worktree returns to the
    /// project folder first, the worktree kept.
    async fn request(&self, thread: &ThreadId, project_path: &str) -> Result<(), CoreError> {
        let projects = &self.projects;
        if self.directory.session_meta(thread).await?.is_none() {
            return Err(failed(DOMAIN, SESSION_UNAVAILABLE));
        }
        let target = if mixdog_js::js_trim(project_path).is_empty() {
            None
        } else {
            Some(projects.registered(project_path).await.map_err(|message| failed(DOMAIN, message))?)
        };
        let registered = projects.projects().await.map_err(|message| failed(DOMAIN, message))?;
        let projects = registered.iter().map(|path| project_identity(Some(path))).collect();
        let handle = self.directory.open_handle(thread, &CallContext::internal("thread-settings")).await?;
        let (tx, answer) = tokio::sync::oneshot::channel();
        let asked = super::actor::Inbox::ProjectMove { target, projects, tx };
        handle.inbox.send(asked).await.map_err(|_| CoreError::ThreadClosing { thread_id: thread.clone() })?;
        answer.await.map_err(|_| CoreError::ThreadClosing { thread_id: thread.clone() })?.map(drop)
    }

    /// The pending move `pending` carried out: its Project (a null path: the task workspace) becomes the session's folder,
    /// out of its managed worktree first, and the write of that folder takes `pending` off the record.
    async fn carry(&self, thread: &ThreadId, pending: &Value) -> Result<(), CoreError> {
        let projects = &self.projects;
        let target = pending.get("projectPath").and_then(Value::as_str);
        let cwd = match target {
            Some(target) => match projects.registered(target).await {
                Ok(registered) => projects.canonical_directory(&registered).await,
                Err(message) => Err(message),
            },
            None => projects.task_workspace().await,
        }
        .map_err(|message| failed(DOMAIN, message))?;
        self.move_to(thread, &cwd, &CancellationToken::new(), false, Some(pending)).await.map(drop)
    }

    /// `pending`: the recorded move this carries out. A session in a managed worktree returns to the project folder first, as
    /// the `git` tool's `return` does (the worktree kept), in the same transition as the switch
    /// ([`SessionWorkspaces::move_to_project`]).
    async fn move_to(&self, thread: &ThreadId, path: &str, cancel: &CancellationToken, own_turn: bool, pending: Option<&Value>) -> Result<Value, CoreError> {
        let handle = self.directory.open_handle(thread, &CallContext::internal("thread-settings")).await?;
        let header = handle.cell.header.load_full();
        let raw = mixdog_js::js_trim(path);
        if raw.is_empty() {
            return Err(failed(DOMAIN, "session: path is required for action=set-project"));
        }
        let base = match header.get("cwd").and_then(Value::as_str).filter(|cwd| !cwd.is_empty()) {
            Some(cwd) => cwd.to_owned(),
            None => std::env::current_dir().map(|dir| text_of(&dir)).unwrap_or_default(),
        };
        let resolved = mixdog_agent::agent_tool::scope::resolve_path(&base, raw);
        let target = std::path::PathBuf::from(&resolved);
        let stat =
            on_lane_wait(self.directory.deps().lanes.io, cancel, move |lane| mixdog_statefile::metadata(lane, &target).map(|meta| meta.is_dir())).await?;
        match stat {
            Ok(true) => {}
            Ok(false) => return Err(failed(DOMAIN, format!("cwd: not a directory: {resolved}"))),
            Err(error) => {
                return Err(io_failure(DOMAIN, &FsFailure { error, step: FsStep::Stat(std::path::PathBuf::from(&resolved)) }));
            }
        }
        // `persistProjectSelection` with `classifyByMembership`: outside every registered Project
        // a session is a task again. A session without a desktop record keeps having none.
        let desktop = match header.get("desktopSession") {
            Some(Value::Object(_)) => {
                let member = own_turn || {
                    let projects = self.projects.projects().await.map_err(|message| failed(DOMAIN, message))?;
                    projects.iter().any(|project| is_within(project, &resolved))
                };
                Some(if member {
                    json!({ "classification": "project", "projectPath": resolved })
                } else {
                    json!({ "classification": "task", "projectPath": null })
                })
            }
            _ => None,
        };
        let switched = match pending {
            Some(pending) => self.workspaces.move_to_project(thread.as_str(), &resolved, desktop, pending.clone(), cancel).await,
            None => self.workspaces.switch_project(thread.as_str(), &resolved, desktop, own_turn, cancel).await,
        };
        // The switch ends in invalidating the caches (the context cache and the pre-session
        // tool surface), whether the folder changed or the transition was undone.
        self.surface.bump();
        let cwd = switched.map_err(scm_error)?;
        if !own_turn && let Err(error) = self.projects.touch_selected(&cwd).await {
            tracing::warn!("project recency update failed (non-fatal): {error}");
        }
        Ok(Value::String(cwd))
    }
}

impl ThreadSettings {
    /// `setEffort(value, { sessionOnly })`: the live route afterwards.
    async fn set_effort(&self, thread: &ThreadId, value: &str, options: Option<&Value>) -> Result<Value, CoreError> {
        let handle = self.open(thread).await?;
        let session_only = options.and_then(|options| options.get("sessionOnly")) == Some(&Value::Bool(true));
        let done = self.parts.effort.set_effort(thread, value, session_only).await.map_err(|message| failed(DOMAIN, message))?;
        // `runtime.effort` is route state (`effectiveEffort || effort`): the route section carries the live route's value.
        let route = self.parts.effort.route(thread);
        let effort = route.get("effort").and_then(Value::as_str).filter(|effort| !effort.is_empty()).map(str::to_owned);
        let effort_auto = mixdog_ai::effort::EffortAuto::read_explicit_value(&route).map(mixdog_ai::effort::EffortAuto::as_bool);
        let effort_options = route.get("effortOptions").and_then(Value::as_array).cloned();
        handle
            .set_section(mixdog_core_ports::ports::threads::Section::Route(mixdog_app_protocol::v2::thread::ThreadRoute {
                effort,
                effort_auto,
                effort_options,
                ..Default::default()
            }))
            .await?;
        Ok(done)
    }

    async fn set_tool_mode(&self, thread: &ThreadId, mode: &str) -> Result<Value, CoreError> {
        let mode = normalize_tool_mode(mode);
        let handle = self.open(thread).await?;
        let mut frozen = handle.cell.run.load().is_some();
        if !frozen {
            let messages = mixdog_core_ports::ports::memory_source::ThreadMessages::messages(&self.threads, thread).await.map_err(port)?;
            frozen = has_conversation_messages(&messages);
        }
        let spec = tool_spec_for_mode(mode);
        self.update_header(thread, &["toolMode", "toolSpec"], |header| {
            let mut set = Map::new();
            if header.get("toolMode") != Some(&json!(mode)) {
                set.insert("toolMode".to_owned(), json!(mode));
            }
            if !frozen && header.get("toolSpec") != Some(&spec) {
                set.insert("toolSpec".to_owned(), spec.clone());
            }
            ((), (!set.is_empty()).then_some((set, Vec::new())))
        })
        .await?;
        // The mode change ends in moving the pre-session tool surface.
        self.parts.surface.bump();
        Ok(json!(mode))
    }
}

#[async_trait]
impl DomainService for ThreadSettings {
    fn methods(&self) -> &'static [&'static str] {
        METHODS
    }

    async fn call(&self, req: CoreRequest) -> Result<Reply, CoreError> {
        let ops = &self.parts.ops;
        let done = || async { Ok(json!({})) };
        // An admitted change completes even when its caller leaves.
        let own = CancellationToken::new();
        match req.method.as_str() {
            READ_STATE_UPDATE => {
                let params: ThreadReadStateUpdateParams = decode(&req)?;
                ops.run(&req, None, || self.mark_read(params), || async { Ok(Value::Bool(true)) }).await
            }
            METADATA_UPDATE => {
                let params: ThreadMetadataUpdateParams = decode(&req)?;
                let run = || async {
                    if let Some(favorite) = params.favorite {
                        self.set_favorite(&params.thread_id, favorite).await?;
                    }
                    if let Some(project) = &params.project_path {
                        self.set_project(&params.thread_id, project).await?;
                    }
                    Ok(json!({}))
                };
                ops.run(&req, None, run, done).await
            }
            ARCHIVE | UNARCHIVE => {
                let params: ThreadOpParams = decode(&req)?;
                let archived = req.method.as_str() == ARCHIVE;
                ops.run(&req, None, || async { self.set_archived(&params.thread_id, archived).await.map(|_| json!({})) }, done).await
            }
            SET_CWD => {
                let params: ThreadSetCwdParams = decode(&req)?;
                let thread = thread_of(params.thread_id)?;
                let reproduce = || async {
                    let header = self.parts.directory.try_stored_header(&thread).await?.unwrap_or_default();
                    Ok(header.get("cwd").cloned().unwrap_or(Value::Null))
                };
                ops.run(&req, None, || self.set_cwd(&thread, &params.path, &own), reproduce).await
            }
            SET_EFFORT => {
                let params: ThreadSetEffortParams = decode(&req)?;
                let thread = thread_of(params.thread_id)?;
                let reproduce = || async { Ok(self.parts.effort.route(&thread)) };
                ops.run(&req, None, || self.set_effort(&thread, &params.value, params.options.as_ref()), reproduce).await
            }
            SET_TOOL_MODE => {
                let params: ThreadSetToolModeParams = decode(&req)?;
                let thread = thread_of(params.thread_id)?;
                let mode = normalize_tool_mode(&params.mode);
                ops.run(&req, None, || self.set_tool_mode(&thread, &params.mode), || async { Ok(json!(mode)) }).await
            }
            other => Err(wrong_method("thread settings", other)),
        }
    }

    fn notify(&self, _: Method, _: Value, _: ConnectionId) -> Admit {
        Admit::Accepted
    }
}
