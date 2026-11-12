//! The thread settings methods of the desktop and its remote peers: the sidebar's read cursor,
//! favorite, project move and archive (`markSessionRead`, `setSessionFavorite`,
//! `setSessionProject`, `setSessionArchived` of `session-host-lifecycle.ts` over
//! `desktop-session-metadata.ts`), and the session configure actions `setCwd`
//! (`session-ops.mjs`), `setEffort` (`route-tuning.mjs`) and `setToolMode` (`session-ops.mjs`).
//! The app-server hands them to this domain instead of the thread's actor. The desktop's
//! metadata map is the session's own header here (SPEC `desktop-session-metadata.json` row):
//! `readState`, `favoriteAt`, `archivedAt`.
//!
//! A request without a `threadId` is refused: the 1.4.5 daemon hosted one session and answered
//! such a call for it (`sessionId is required` otherwise), the core hosts many.

use std::collections::HashMap;
use std::collections::HashSet;
use std::sync::Arc;
use std::sync::Mutex;

use async_trait::async_trait;
use mixdog_app_protocol::v2::params::ThreadSetCwdParams;
use mixdog_app_protocol::v2::params::ThreadSetEffortParams;
use mixdog_app_protocol::v2::params::ThreadSetToolModeParams;
use mixdog_app_protocol::v2::thread::ThreadIdParams;
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
use mixdog_core_base::state::SectionFeedState;
use mixdog_core_base::support::FsFailure;
use mixdog_core_base::support::FsStep;
use mixdog_core_base::support::OpScopes;
use mixdog_core_base::support::decode;
use mixdog_core_base::support::failed;
use mixdog_core_base::support::invalid;
use mixdog_core_base::support::io_failure;
use mixdog_core_base::support::on_lane;
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
use super::delete::is_session_id;
use super::delete::sidebar_flag;
use super::sub_agent_retention::AgentOnlyIndex;
use super::sub_agent_retention::parent_ids;
use super::thread_state::SessionThreads;
use super::worktree::SessionWorkspaces;
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

const DOMAIN: &str = "thread";
/// `Number.MAX_SAFE_INTEGER`.
const MAX_SAFE: f64 = 9_007_199_254_740_991.0;
/// `markRead`'s bound on a read count.
const MAX_READ_COUNT: i64 = 10_000_000;

const SESSION_UNAVAILABLE: &str = "Session is not available.";
const PROJECT_MOVE_BUSY: &str = "The session is running a turn; wait for it to finish before moving it to another project.";
const PROJECT_MOVE_WORKTREE: &str =
    "The session works in a managed worktree; merge or remove the worktree before moving it to another project.";

/// The desktop host's refusals of a move to another project (`setSessionProject`), in its order:
/// a turn (or a compaction) running, then a managed worktree.
pub(crate) fn project_move_refusal(working: bool, worktree: bool) -> Option<&'static str> {
    if working {
        Some(PROJECT_MOVE_BUSY)
    } else if worktree {
        Some(PROJECT_MOVE_WORKTREE)
    } else {
        None
    }
}

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

/// The route half of `setEffort` (`route-tuning.mjs`), [`RouteService`]'s.
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

/// The desktop's auto-retention record (`sessionRetention.noteArchived`): an archive clears a
/// session's restore, a restore records it, which exempts it from auto-archive until it is used
/// again.
#[async_trait]
pub trait ArchiveRetention: Send + Sync {
    async fn note_archived(&self, session_id: &str, archived: bool) -> Result<(), String>;
    /// `sessionRetention.forget(id)`: a deleted session's restore is dropped.
    async fn forget(&self, session_id: &str) -> Result<(), String>;
}

/// `positive(value)` of `session-auto-retention.ts`: a finite number above zero, else none.
fn positive(value: Option<&Value>) -> Option<f64> {
    value.and_then(Value::as_f64).filter(|at| at.is_finite() && *at > 0.0)
}

/// [`ArchiveRetention`] over the record Node kept in `session-auto-retention.json`, which the
/// profile import moved to `desktop.retentionState` (`{ enabledAt, restored: { [id]: ms } }`).
/// Each note is one config write, in the config's write transaction, as Node's
/// `updateJsonAtomic` read-modify-write: the stored record is normalized (`normalizeRecord`:
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
                let mut restored: Map<String, Value> = stored_restored
                    .into_iter()
                    .flatten()
                    .filter(|(_, at)| positive(Some(at)).is_some())
                    .map(|(id, at)| (id.clone(), at.clone()))
                    .collect();
                let stored_enabled =
                    current.and_then(|record| record.get("enabledAt")).filter(|at| positive(Some(at)).is_some()).cloned();
                let changed = mutate(&mut restored, now);
                if !changed && stored_enabled.is_some() {
                    return Ok(());
                }
                let record = json!({ "enabledAt": stored_enabled.unwrap_or_else(|| json!(now)), "restored": restored });
                let desktop = doc.entry("desktop").or_insert_with(|| Value::Object(Map::new()));
                let Some(desktop) = desktop.as_object_mut() else {
                    return Err(mixdog_core_config::config::ConfigError::InvalidParams {
                        path: "desktop".into(),
                        expected: "an object".into(),
                    });
                };
                desktop.insert("retentionState".into(), record);
                Ok(())
            })
            .await
            .map(drop)
            .map_err(|error| error.to_string())
    }
}

#[async_trait]
impl ArchiveRetention for ConfigArchiveRetention {
    async fn note_archived(&self, session_id: &str, archived: bool) -> Result<(), String> {
        let id = session_id.to_owned();
        // An archive clears a restore; a restore records it, which exempts the session from
        // auto-archive until it is used again.
        self.update(move |restored, now| {
            if archived {
                restored.shift_remove(&id).is_some()
            } else {
                restored.insert(id, json!(now));
                true
            }
        })
        .await
    }

    async fn forget(&self, session_id: &str) -> Result<(), String> {
        let id = session_id.to_owned();
        self.update(move |restored, _| restored.shift_remove(&id).is_some()).await
    }
}

/// [`ProjectFolders`] over the Project catalog of the workspace service; `user_data` holds the
/// task workspace (`workspace/unclassified`).
pub struct WorkspaceFolders {
    service: Arc<WorkspaceService>,
    user_data: std::path::PathBuf,
    lanes: super::SessionLanes,
}

impl WorkspaceFolders {
    pub fn new(service: Arc<WorkspaceService>, user_data: std::path::PathBuf, lanes: super::SessionLanes) -> Self {
        Self { service, user_data, lanes }
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
        on_lane(self.lanes.io, &CancellationToken::new(), job).await.map_err(|error| format!("{error:?}"))?
    }

    async fn task_workspace(&self) -> Result<String, String> {
        let user_data = self.user_data.clone();
        let job = move |_: &mixdog_rt::InLane<mixdog_rt::DurabilityIo>| {
            mixdog_workspace::editorcfg::task_workspace(&user_data).map(|path| text_of(&path)).map_err(|error| error.message)
        };
        on_lane(self.lanes.durability, &CancellationToken::new(), job).await.map_err(|error| format!("{error:?}"))?
    }

    async fn touch_selected(&self, cwd: &str) -> Result<(), String> {
        self.service.catalog().touch(cwd, None).await.map(drop).map_err(|error| error.message)
    }
}

// ---- Node's rules ------------------------------------------------------------------------------

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
    let candidates: Vec<String> = [
        text(row.pointer("/workspace/projectPath")),
        text(row.get("projectPath")),
        text(row.get("cwd")),
        text(row.pointer("/workspace/cwd")),
    ]
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
    let root = mixdog_js::js_trim(root);
    let mut children: HashMap<String, Vec<String>> = HashMap::new();
    for (id, header) in rows {
        let id = mixdog_js::js_trim(id);
        let mut doc = header.clone();
        doc.insert("id".into(), json!(id));
        if id.is_empty() || mixdog_store::summary::session_visibility(&doc) != "agent-only" {
            continue;
        }
        for parent in parent_ids(&doc, id) {
            children.entry(parent).or_default().push(id.to_owned());
        }
    }
    let mut found: Vec<String> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();
    let mut queue = vec![root.to_owned()];
    while let Some(next) = queue.pop() {
        for child in children.get(&next).into_iter().flatten() {
            if child == root || seen.contains(child) {
                continue;
            }
            seen.insert(child.clone());
            found.push(child.clone());
            queue.push(child.clone());
        }
    }
    found
}

// ---- the service -------------------------------------------------------------------------------

/// What [`ThreadSettings::new`] takes.
pub struct ThreadSettingsParts {
    pub directory: Arc<SessionDirectory>,
    pub workspaces: SessionWorkspaces,
    pub effort: Arc<dyn EffortTuning>,
    pub projects: Arc<dyn ProjectFolders>,
    /// The stored agent-only sessions: an archive takes a session's sub-agent sessions along.
    pub agent_only: Arc<dyn AgentOnlyIndex>,
    pub worktrees: Arc<dyn ArchivedWorktrees>,
    pub retention: Arc<dyn ArchiveRetention>,
    /// The app feed: `thread/archived`, `thread/unarchived`.
    pub app: Arc<SectionFeedState>,
    pub ops: OpScopes,
    /// The surface generation (`invalidatePreSessionToolSurface`): a tool mode change and a workspace switch move it.
    pub surface: mixdog_core_base::surface::SurfaceGeneration,
    /// The core's one archive stamp counter, shared with the rooms' archive (`DirectorySessions`).
    pub archive_stamps: Arc<ArchiveStamps>,
}

/// Where an archive or a restore hands its sessions (Node's `setArchivedSessionWorktrees` hand-off of
/// `session-host-lifecycle.ts`): the session first, then its sub-agent sessions in the order found. A failure is the
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

/// `DesktopSessionMetadata.lastArchiveStamp` (`desktop-session-metadata.ts:49,142-143`): the last archive stamp handed out, so two
/// archives never share one even inside one millisecond. Node's host has one metadata instance, which both its own archive and the
/// rooms' (`session-host-lifecycle.ts:356`) use; the core has one of these for both. Like Node's it starts at 0 with the process and
/// is not seeded from stored stamps.
#[derive(Default)]
pub struct ArchiveStamps(Mutex<i64>);

impl ArchiveStamps {
    /// `const stamp = Math.max(now, lastArchiveStamp + 1); this.lastArchiveStamp = stamp`: the stamp an archive at `now` takes,
    /// taken and remembered in one step as Node's two statements are, so two archives at once never take the same one.
    pub fn take(&self, now: i64) -> i64 {
        let mut last = self.0.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        *last = now.max(*last + 1);
        *last
    }
}

pub struct ThreadSettings {
    parts: ThreadSettingsParts,
    threads: SessionThreads,
}

fn thread_of(id: Option<ThreadId>) -> Result<ThreadId, CoreError> {
    id.ok_or_else(|| invalid("threadId", "the thread to act on"))
}

fn port(error: mixdog_tools::orch::util::PortError) -> CoreError {
    failed(DOMAIN, format!("{error:?}"))
}

fn not_found(error: &CoreError) -> bool {
    matches!(error, CoreError::ThreadNotFound { .. })
}

impl ThreadSettings {
    pub fn new(parts: ThreadSettingsParts) -> Self {
        Self { threads: SessionThreads::new(parts.directory.clone()), parts }
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
            let expect: Map<String, Value> =
                keys.iter().map(|key| ((*key).to_owned(), header.get(*key).cloned().unwrap_or(Value::Null))).collect();
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
    async fn set_favorite(&self, thread: &ThreadId, favorite: bool) -> Result<(), CoreError> {
        let now = self.now();
        self.update_header(thread, &["favoriteAt"], |header| {
            let patch = (favorite != sidebar_flag(header, "favoriteAt")).then(|| {
                if favorite {
                    (Map::from_iter([("favoriteAt".to_owned(), json!(now))]), Vec::new())
                } else {
                    (Map::new(), vec!["favoriteAt".to_owned()])
                }
            });
            ((), patch)
        })
        .await
    }

    /// `setSessionProject(id, projectPath)`: a registered Project's folder, or '' for the task
    /// workspace; a session already in that Project stays put.
    async fn set_project(&self, thread: &ThreadId, project_path: &str, cancel: &CancellationToken) -> Result<(), CoreError> {
        let projects = &self.parts.projects;
        let row = match self.parts.directory.session_meta(thread).await? {
            Some(meta) => meta.row,
            None => return Err(failed(DOMAIN, SESSION_UNAVAILABLE)),
        };
        let target = if mixdog_js::js_trim(project_path).is_empty() {
            None
        } else {
            Some(projects.registered(project_path).await.map_err(|message| failed(DOMAIN, message))?)
        };
        let registered = projects.projects().await.map_err(|message| failed(DOMAIN, message))?;
        let keys: Vec<String> = registered.iter().map(|path| project_identity(Some(path))).collect();
        let key = session_project_key(&json!({
            "projectPath": row.pointer("/desktopSession/projectPath"),
            "cwd": row.get("cwd"),
            "workspace": row.get("workspace"),
        }), &keys);
        let current = registered.iter().find(|path| project_identity(Some(path)) == key);
        if project_identity(current.map(String::as_str)) == project_identity(target.as_deref()) {
            return Ok(());
        }
        // `row.leadWorking || live?.busy || live?.commandBusy`: the thread's own turn in flight
        // (the list row's `working`), a turn running or starting or a compaction running as the
        // actor steps, or the runtime state a host published as busy.
        let working = self.parts.directory.handle(thread).is_some_and(|handle| {
            handle.cell.run.load().is_some() || handle.cell.ui_busy.load(std::sync::atomic::Ordering::SeqCst) || handle.cell.compacting.load(std::sync::atomic::Ordering::SeqCst)
        }) || self.parts.directory.runtime_facts(thread).is_some_and(|facts| facts.busy || facts.command_busy);
        let worktree = row.pointer("/workspace/worktreeId").and_then(Value::as_str).is_some_and(|id| !id.is_empty());
        if let Some(refusal) = project_move_refusal(working, worktree) {
            return Err(failed(DOMAIN, refusal));
        }
        let cwd = match &target {
            Some(target) => projects.canonical_directory(target).await,
            None => projects.task_workspace().await,
        }
        .map_err(|message| failed(DOMAIN, message))?;
        self.set_cwd(thread, &cwd, cancel).await.map(drop)
    }

    /// The agent-only sessions under `root`, from the stored records.
    async fn descendants(&self, root: &ThreadId) -> Result<Vec<String>, CoreError> {
        let mut rows = Vec::new();
        for id in self.parts.agent_only.agent_only_ids().await? {
            if let Some(header) = self.parts.directory.try_stored_header(&ThreadId::from(id.as_str())).await? {
                rows.push((id, header));
            }
        }
        Ok(agent_descendant_ids(&rows, root.as_str()))
    }

    /// `setSessionArchived(id, archived)`: the session with its sub-agent sessions. An archive
    /// stamps the ones not archived yet with the session's own stamp; a restore brings back
    /// exactly the ones carrying it. Whether the session's own state changed.
    async fn set_archived(&self, thread: &ThreadId, archived: bool) -> Result<bool, CoreError> {
        self.open(thread).await?;
        let descendants = self.descendants(thread).await?;
        let now = self.now();
        // Taken only when the session is really archived now (Node returns before its stamp for one already archived), and once:
        // a patch that lost its race and is decided again keeps the stamp it took.
        let mut taken = None;
        let stamp = self
            .update_header(thread, &["archivedAt"], |header| {
                if archived == sidebar_flag(header, "archivedAt") {
                    return (None, None);
                }
                if archived {
                    let stamp = json!(*taken.get_or_insert_with(|| self.parts.archive_stamps.take(now)));
                    (Some(stamp.clone()), Some((Map::from_iter([("archivedAt".to_owned(), stamp)]), Vec::new())))
                } else {
                    (header.get("archivedAt").cloned(), Some((Map::new(), vec!["archivedAt".to_owned()])))
                }
            })
            .await?;
        let Some(stamp) = stamp else { return Ok(false) };
        for id in &descendants {
            let child = ThreadId::from(id.as_str());
            let moved = self
                .update_header(&child, &["archivedAt"], |header| {
                    let patch = if archived {
                        (!sidebar_flag(header, "archivedAt")).then(|| (Map::from_iter([("archivedAt".to_owned(), stamp.clone())]), Vec::new()))
                    } else {
                        (header.get("archivedAt") == Some(&stamp)).then(|| (Map::new(), vec!["archivedAt".to_owned()]))
                    };
                    ((), patch)
                })
                .await;
            // A sub-agent session deleted meanwhile has nothing left to mark.
            if let Err(error) = moved
                && !not_found(&error)
            {
                return Err(error);
            }
        }
        if let Err(error) = self.parts.retention.note_archived(thread.as_str(), archived).await {
            tracing::warn!("[mixdog-session] Could not record the archive change of {thread}: {error}");
        }
        // Their managed worktrees follow (autoCleanup decides): off the reply path, never failing
        // the archive itself.
        let worktrees = self.parts.worktrees.clone();
        let ids: Vec<String> = std::iter::once(thread.as_str().to_owned()).chain(descendants).collect();
        let shown = thread.clone();
        tokio::spawn(async move {
            if let Err(error) = worktrees.set_archived(&ids, archived).await {
                tracing::warn!("[mixdog-session] Could not update the worktrees of {shown}: {error}");
            }
        });
        let method = if archived { "thread/archived" } else { "thread/unarchived" };
        self.parts.app.notify(method, &ThreadIdParams { thread_id: thread.clone() });
        Ok(true)
    }

    /// `setCwd(path)`: `resolveCwdPath` from the session's folder, then the Project switch with
    /// the desktop classification by membership; a Project selected becomes the most recent.
    /// The session's folder afterwards.
    async fn set_cwd(&self, thread: &ThreadId, path: &str, cancel: &CancellationToken) -> Result<Value, CoreError> {
        let handle = self.open(thread).await?;
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
        let stat = on_lane(self.parts.directory.deps().lanes.io, cancel, move |lane| mixdog_statefile::metadata(lane, &target).map(|meta| meta.is_dir())).await?;
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
                let projects = self.parts.projects.projects().await.map_err(|message| failed(DOMAIN, message))?;
                let member = projects.iter().any(|project| is_within(project, &resolved));
                Some(if member {
                    json!({ "classification": "project", "projectPath": resolved })
                } else {
                    json!({ "classification": "task", "projectPath": null })
                })
            }
            _ => None,
        };
        let switched = self.parts.workspaces.switch_project(thread.as_str(), &resolved, desktop, cancel).await;
        // `transition-steps.mjs:229`: the switch ends in `invalidateCaches()` (the context cache and the pre-session
        // tool surface), whether the folder changed or the transition was undone.
        self.parts.surface.bump();
        let cwd = switched.map_err(scm_error)?;
        if let Err(error) = self.parts.projects.touch_selected(&cwd).await {
            tracing::warn!("project recency update failed (non-fatal): {error}");
        }
        Ok(Value::String(cwd))
    }

    /// `setEffort(value, { sessionOnly })`: the live route afterwards.
    async fn set_effort(&self, thread: &ThreadId, value: &str, options: Option<&Value>) -> Result<Value, CoreError> {
        let handle = self.open(thread).await?;
        let session_only = options.and_then(|options| options.get("sessionOnly")) == Some(&Value::Bool(true));
        let done = self.parts.effort.set_effort(thread, value, session_only).await.map_err(|message| failed(DOMAIN, message))?;
        // `runtime.effort` is route state (`effectiveEffort || effort`): the route section carries the live route's value.
        let route = self.parts.effort.route(thread);
        let effort = route.get("effort").and_then(Value::as_str).filter(|effort| !effort.is_empty()).map(str::to_owned);
        let effort_options = route.get("effortOptions").and_then(Value::as_array).cloned();
        handle
            .set_section(mixdog_core_ports::ports::threads::Section::Route(mixdog_app_protocol::v2::thread::ThreadRoute { effort, effort_options, ..Default::default() }))
            .await?;
        Ok(done)
    }

    /// `setToolMode(mode)`: the normalized mode, which the thread keeps (`toolMode`, Node's
    /// `rt.mode`, read by the tool status). An empty, idle session also takes the mode's tool
    /// spec (`refreshEmptySessionToolPolicy`); a conversation keeps its tool surface.
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
        // `session-ops.mjs:117-120`: the mode change ends in `refreshEmptySessionToolPolicy`, which first moves the
        // pre-session tool surface.
        self.parts.surface.bump();
        Ok(json!(mode))
    }
}

#[async_trait]
impl DomainService for ThreadSettings {
    fn methods(&self) -> &'static [&'static str] {
        &[READ_STATE_UPDATE, METADATA_UPDATE, ARCHIVE, UNARCHIVE, SET_CWD, SET_EFFORT, SET_TOOL_MODE]
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
                        self.set_project(&params.thread_id, project, &own).await?;
                    }
                    Ok(json!({}))
                };
                ops.run(&req, None, run, done).await
            }
            ARCHIVE | UNARCHIVE => {
                let params: ThreadOpParams = decode(&req)?;
                let archived = req.method.as_str() == ARCHIVE;
                let run = || async { self.set_archived(&params.thread_id, archived).await.map(|_| json!({})) };
                ops.run(&req, None, run, done).await
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

#[cfg(test)]
#[path = "thread_settings_tests.rs"]
mod tests;
