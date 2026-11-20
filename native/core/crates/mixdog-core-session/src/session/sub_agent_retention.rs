//! Retention of finished sub-agent sessions (Node `store/sweep/sub-agent-retention.mjs`, driven
//! by the 5-minute cycle of `manager/idle-cleanup.mjs`): the agent-only children (Worker,
//! Reviewer, ...) a Lead's agents spawn, each its own stored session. A tree (a top sub-agent
//! under a Lead with every sub-agent below it, joined by any owner or parent link) is archived
//! once each member has been idle 3 days and deleted once each has been idle 7; otherwise the
//! whole tree stays. (Node deleted after 30. A finished sub-agent's record serves only a look back at
//! what it did, and its scratch folder and tool results stay on disk for as long as it does.) Never a member: a root Lead, a task session, a bot home chat or a group
//! room's log or member session.
//!
//! The desktop's archive flag is the header's `archivedAt` here, which goes with a deleted
//! session, so Node's `forgotten` step after a delete has nothing to do.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use mixdog_core_api::CoreError;
use mixdog_core_api::ids::ThreadId;
use mixdog_rt::CancellationToken;
use mixdog_rt::TaskClass;
use mixdog_store::schema::record::Header;
use mixdog_store::sqlite::SqliteStore;
use serde_json::Map;
use serde_json::Value;
use serde_json::json;

use super::SessionDirectory;
use super::archive_trees::Mark;
use super::delete::is_session_id;
use super::thread_settings::ArchiveStamps;

const DAY_MS: f64 = 24.0 * 60.0 * 60.0 * 1000.0;
/// `SUB_AGENT_ARCHIVE_AFTER_MS`.
pub const ARCHIVE_AFTER_MS: f64 = 3.0 * DAY_MS;
/// The idle time after which a tree is deleted.
pub const DELETE_AFTER_MS: f64 = 7.0 * DAY_MS;
/// Node's `SUB_AGENT_DELETE_AFTER_MS`: what its recordings were made with.
pub const NODE_DELETE_AFTER_MS: f64 = 30.0 * DAY_MS;
/// `CLEANUP_INTERVAL_MS`, which is also the cycle's initial delay.
pub const SWEEP_INTERVAL: Duration = Duration::from_secs(5 * 60);

/// A sub-agent record that retention judges (`subAgentMember`).
#[derive(Clone, Debug, PartialEq)]
pub struct Member {
    pub id: String,
    /// The owner and parent links the record names, never itself (`agentParentIds`).
    pub parent_ids: Vec<String>,
    pub last_active: f64,
    /// The desktop's archive mark is set.
    pub archived: bool,
}

/// JS truthiness of a header value.
fn truthy(value: Option<&Value>) -> bool {
    match value {
        None | Some(Value::Null) => false,
        Some(Value::Bool(b)) => *b,
        Some(Value::Number(n)) => n.as_f64().is_some_and(|n| n != 0.0 && !n.is_nan()),
        Some(Value::String(s)) => !s.is_empty(),
        Some(_) => true,
    }
}

/// `String(value || '').trim()` for the string ids a record carries.
fn clean(value: Option<&Value>) -> String {
    value.and_then(Value::as_str).map(|s| mixdog_js::js_trim(s).to_owned()).unwrap_or_default()
}

/// `positive(value)`: `Number(value) > 0 ? Number(value) : 0`.
fn positive(value: Option<&Value>) -> f64 {
    let n = match value {
        Some(v @ (Value::Number(_) | Value::String(_) | Value::Bool(_))) => mixdog_js::to_number(v),
        _ => f64::NAN,
    };
    if n > 0.0 { n } else { 0.0 }
}

/// `subAgentActivityAt`: the last conversation turn (`lastUsedAt`; `updatedAt` also moves on
/// detach and resume bookkeeping) or the heartbeat, whichever is later.
pub fn activity_at(header: &Map<String, Value>) -> f64 {
    let turn = [positive(header.get("lastUsedAt")), positive(header.get("updatedAt")), positive(header.get("createdAt"))]
        .into_iter()
        .find(|n| *n > 0.0)
        .unwrap_or(0.0);
    turn.max(positive(header.get("lastHeartbeatAt")))
}

fn permanent(id: &str) -> bool {
    ["sess_home_", "sess_room_", "sess_rmem_"].iter().any(|prefix| id.starts_with(prefix))
}

/// `isRootLeadSession`: a Lead may carry a self owner link, but it is not a child.
fn is_root_lead(doc: &Map<String, Value>, id: &str) -> bool {
    if clean(doc.get("agent")).to_lowercase() != "lead" {
        return false;
    }
    let parent = [doc.get("ownerSessionId"), doc.get("parentSessionId")]
        .into_iter()
        .map(clean)
        .find(|candidate| is_session_id(candidate))
        .unwrap_or_default();
    parent.is_empty() || parent == id
}

/// `agentParentIds`.
pub(crate) fn parent_ids(doc: &Map<String, Value>, id: &str) -> Vec<String> {
    let mut parents: Vec<String> = Vec::new();
    for parent in [clean(doc.get("ownerSessionId")), clean(doc.get("parentSessionId"))] {
        if !parent.is_empty() && parent != id && !parents.contains(&parent) {
            parents.push(parent);
        }
    }
    parents
}

/// `subAgentMember(id, doc)`: `None` for anything that is not a sub-agent record.
pub fn member(id: &str, header: &Header) -> Option<Member> {
    if permanent(id) || truthy(header.get("taskOrigin")) {
        return None;
    }
    let mut doc = header.clone();
    doc.insert("id".into(), json!(id));
    if is_root_lead(&doc, id) || mixdog_store::summary::session_visibility(&doc) != "agent-only" {
        return None;
    }
    Some(Member {
        id: id.to_owned(),
        parent_ids: parent_ids(&doc, id),
        last_active: activity_at(&doc),
        archived: positive(doc.get("archivedAt")) > 0.0,
    })
}

/// `subAgentTrees`: the members joined by any owner or parent link between them (a link to a
/// non-member joins nothing), each tree listing a top member (no member parent) first and its
/// members below in link order. Indices into `members`.
pub fn trees(members: &[Member]) -> Vec<Vec<usize>> {
    let by_id: HashMap<&str, usize> = members.iter().enumerate().map(|(at, m)| (m.id.as_str(), at)).collect();
    let mut links: Vec<Vec<usize>> = vec![Vec::new(); members.len()];
    let mut has_member_parent = vec![false; members.len()];
    for (at, member) in members.iter().enumerate() {
        for parent in member.parent_ids.iter().filter_map(|p| by_id.get(p.as_str()).copied()) {
            if !links[at].contains(&parent) {
                links[at].push(parent);
            }
            if !links[parent].contains(&at) {
                links[parent].push(at);
            }
            has_member_parent[at] = true;
        }
    }
    let mut seen = vec![false; members.len()];
    let mut out = Vec::new();
    let tops = (0..members.len()).filter(|at| !has_member_parent[*at]);
    for start in tops.chain(0..members.len()).collect::<Vec<_>>() {
        if seen[start] {
            continue;
        }
        seen[start] = true;
        let mut tree = vec![start];
        let mut cursor = 0;
        while cursor < tree.len() {
            for next in links[tree[cursor]].clone() {
                if !seen[next] {
                    seen[next] = true;
                    tree.push(next);
                }
            }
            cursor += 1;
        }
        out.push(tree);
    }
    out
}

/// What retention reads and does in the session runtime.
#[async_trait]
pub trait RetentionHost: Send + Sync {
    /// Every stored, undeleted agent-only session.
    async fn agent_only_ids(&self) -> Result<Vec<String>, CoreError>;
    /// The session's header, the live one of an open session; `None` when it is unknown or deleted.
    /// `Err` when the read never ran: that session is neither known nor deleted.
    async fn stored_header(&self, id: &str) -> Result<Option<Header>, CoreError>;
    /// Whether the session is open in this process (`_isSessionLive`).
    fn is_live(&self, id: &str) -> bool;
    /// Whether its archive state (resolved in `header`) may be acted on: not when it may hide a lost entry of the authority.
    fn trusted(&self, _id: &str, _header: &Header) -> bool {
        true
    }
    /// The desktop's automatic archive: this one session, no cascade.
    async fn archive(&self, id: &str) -> Result<(), CoreError>;
    /// `deleteSession(id, { isSessionLive: treeChanged })`: `true` once the session is gone.
    /// The session's own admission refuses (`false`) when it was opened or used since the pass
    /// read `activity`, or once `cancel` has fired; a delete already admitted runs to its end.
    /// `peers` are the tree's other members still stored, with the activity the pass read: none
    /// of them may have been opened or have moved either (`treeChanged`, asked again inside the
    /// destructive step).
    async fn delete(&self, id: &str, activity: f64, peers: &[(String, f64)], cancel: &CancellationToken) -> Result<bool, CoreError>;
    /// A pass ended (whatever its outcome): a host that keeps what it read may write it now.
    async fn pass_ended(&self) {}
}

/// The members among the stored agent-only sessions.
pub async fn members_of(host: &dyn RetentionHost) -> Result<Vec<Member>, CoreError> {
    let mut members = Vec::new();
    for id in host.agent_only_ids().await? {
        // An unread record fails the pass: a tree judged without one of its members could be
        // archived or deleted whole while that member is still in use.
        if let Some(header) = host.stored_header(&id).await?
            && let Some(mut found) = member(&id, &header)
        {
            // A state that may hide a lost entry (a restore the user made) is of unknown age: its tree is left alone.
            if !host.trusted(&id, &header) {
                found.last_active = f64::NAN;
            }
            members.push(found);
        }
    }
    Ok(members)
}

/// The ids one pass archived and deleted.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Applied {
    pub archived: Vec<String>,
    pub deleted: Vec<String>,
}

/// Whether any member of `tree` runs here or has been active since the pass read it (a member
/// that cannot be read counts as changed); members already deleted are not judged.
async fn tree_changed(host: &dyn RetentionHost, members: &[Member], tree: &[usize], deleted: &[String]) -> bool {
    for &at in tree {
        let member = &members[at];
        if deleted.contains(&member.id) {
            continue;
        }
        if host.is_live(&member.id) {
            return true;
        }
        let stored = match host.stored_header(&member.id).await {
            Ok(stored) => stored.map(|header| activity_at(&header)),
            // Unreadable counts as changed, as the doc says.
            Err(_) => return true,
        };
        if stored != Some(member.last_active) {
            return true;
        }
    }
    false
}

/// `applySubAgentRetention`: archives or deletes each idle tree at `now` (epoch ms). A tree
/// with a member running here, or one whose stored activity moved since the pass read it, is
/// left alone, as is a tree with a member of unknown age. A failed archive or delete keeps its
/// session; the next pass decides again.
pub async fn apply(host: &dyn RetentionHost, members: &[Member], now: f64, cancel: &CancellationToken) -> Applied {
    apply_after(host, members, now, DELETE_AFTER_MS, cancel).await
}

/// [`apply`] with the idle time after which a tree is deleted given: [`DELETE_AFTER_MS`] in production,
/// [`NODE_DELETE_AFTER_MS`] where Node's recordings are replayed.
pub async fn apply_after(host: &dyn RetentionHost, members: &[Member], now: f64, delete_after_ms: f64, cancel: &CancellationToken) -> Applied {
    let mut applied = Applied::default();
    for tree in trees(members) {
        // After shutdown nothing new is admitted; what was admitted has finished.
        if cancel.is_cancelled() {
            break;
        }
        if !tree.iter().all(|&at| members[at].last_active.is_finite() && members[at].last_active > 0.0) {
            continue;
        }
        let idle = now - tree.iter().map(|&at| members[at].last_active).fold(f64::MIN, f64::max);
        let expired = idle >= delete_after_ms;
        if !expired && idle < ARCHIVE_AFTER_MS {
            continue;
        }
        if tree_changed(host, members, &tree, &applied.deleted).await {
            continue;
        }
        if expired {
            for &at in tree.iter().rev() {
                // Asked again right before each unlink: an earlier delete may have taken time.
                if cancel.is_cancelled() {
                    return applied;
                }
                if tree_changed(host, members, &tree, &applied.deleted).await {
                    continue;
                }
                // The rest of the tree as the pass read it: each member's id and activity.
                let peers: Vec<(String, f64)> = tree
                    .iter()
                    .map(|&other| &members[other])
                    .filter(|other| other.id != members[at].id && !applied.deleted.contains(&other.id))
                    .map(|other| (other.id.clone(), other.last_active))
                    .collect();
                if matches!(host.delete(&members[at].id, members[at].last_active, &peers, cancel).await, Ok(true)) {
                    applied.deleted.push(members[at].id.clone());
                }
            }
            continue;
        }
        for &at in &tree {
            if cancel.is_cancelled() {
                return applied;
            }
            if !members[at].archived && host.archive(&members[at].id).await.is_ok() {
                applied.archived.push(members[at].id.clone());
            }
        }
    }
    applied
}

/// One pass: the members, then their retention.
pub async fn sweep(host: &dyn RetentionHost, now: f64, cancel: &CancellationToken) -> Result<Applied, CoreError> {
    let members = members_of(host).await?;
    Ok(apply(host, &members, now, cancel).await)
}

/// The wall clock in epoch milliseconds (`Date.now()`).
pub fn now_ms() -> f64 {
    mixdog_rt::wall_clock!().duration_since(std::time::UNIX_EPOCH).map_or(0.0,|d| d.as_millis() as f64)
}

/// Runs a pass every [`SWEEP_INTERVAL`], the first one an interval after the start, until
/// `cancel`, judging idleness at `now` (epoch ms; [`now_ms`] in production). A failed pass is
/// reported to `on_error`; the next one runs on schedule. A pass under way when `cancel` fires
/// admits nothing more and finishes what it admitted; the returned task ends after that, so
/// awaiting it is the end of retention.
pub fn start(
    host: Arc<dyn RetentionHost>,
    now: Arc<dyn Fn() -> f64 + Send + Sync>,
    on_error: Arc<dyn Fn(&str) + Send + Sync>,
    cancel: CancellationToken,
) -> tokio::task::JoinHandle<()> {
    mixdog_rt::spawn("sub-agent.retention", TaskClass::Work, async move {
        let mut timer = mixdog_rt::time::interval_at(tokio::time::Instant::now() + SWEEP_INTERVAL, SWEEP_INTERVAL);
        loop {
            tokio::select! {
                () = cancel.cancelled() => return,
                _ = timer.tick() => {}
            }
            match sweep(host.as_ref(), now(), &cancel).await {
                Ok(applied) => {
                    if !applied.archived.is_empty() || !applied.deleted.is_empty() {
                        tracing::debug!(archived = ?applied.archived, deleted = ?applied.deleted, "sub-agent retention");
                    }
                }
                Err(error) => on_error(&format!("sub-agent retention error: {error}")),
            }
            host.pass_ended().await;
        }
    })
}

/// The stored agent-only sessions, by id.
#[async_trait]
pub trait AgentOnlyIndex: Send + Sync {
    async fn agent_only_ids(&self) -> Result<Vec<String>, CoreError>;
    /// Each one's id and the row the tree links are read from (its owner, parent and visibility): what
    /// [`Adjacency`](super::archive_trees::Adjacency) is built over, one read for every root.
    async fn agent_only_rows(&self) -> Result<Vec<(String, Header)>, CoreError>;
}

#[async_trait]
impl AgentOnlyIndex for SqliteStore {
    async fn agent_only_ids(&self) -> Result<Vec<String>, CoreError> {
        Ok(self.agent_only_rows().await?.into_iter().map(|(id, _)| id).collect())
    }

    async fn agent_only_rows(&self) -> Result<Vec<(String, Header)>, CoreError> {
        let rows = self.agent_only_sessions().await.map_err(|e| internal("agent-only", &e))?;
        Ok(rows
            .iter()
            .filter_map(|row| match serde_json::from_str::<Value>(row).ok()? {
                Value::Object(row) => Some((row.get("id")?.as_str()?.to_owned(), row)),
                _ => None,
            })
            .collect())
    }
}

fn internal(step: &str, error: &dyn std::fmt::Display) -> CoreError {
    CoreError::Internal { incident_id: format!("sub-agent-retention-{step}: {error}").into() }
}

/// [`RetentionHost`] over the session directory.
pub struct DirectoryRetention {
    directory: Arc<SessionDirectory>,
    index: Arc<dyn AgentOnlyIndex>,
    /// The host's archive stamps: Node's automatic archive is the host's own archive of that one session
    /// (`archiveSessionAlone`, `session-host.ts:983` via `session-sidebar-actions.ts:41`), stamped `Math.max(Date.now(), lastArchiveStamp + 1)`
    /// from the same `lastArchiveStamp` as an explicit one (`desktop-session-metadata.ts:142`).
    stamps: Arc<ArchiveStamps>,
    /// The record each pass read last ([`KEPT_FIELDS`] of it), by id, with the index's stamp of it ([`record_stamp`]): a record
    /// whose stamp has not moved since is not opened again. Opening a stored record reads its log's head and tail (about 2 MB
    /// here), and a pass reads every agent-only session, a thousand of them every five minutes.
    read: std::sync::Mutex<HashMap<String, (String, Header)>>,
    /// The index stamps of the current pass, taken with its id listing.
    current: std::sync::Mutex<HashMap<String, String>>,
    /// The archive entry each session's state was judged from in the current pass ([RetentionHost::trusted] is asked as each
    /// member is read): its delete is admitted against it.
    judged: std::sync::Mutex<HashMap<String, Option<mixdog_store::archive_state::ArchiveEntry>>>,
    /// Where `read` is kept between starts ([`Self::persisted`]): without it the first pass after each start opened every
    /// stored agent-only record again (1,119 of them here, about 1.5 GB read five minutes after the start).
    persist: Option<mixdog_store::state::CoreState>,
    /// `read` was taken from the file (or there was none to take).
    loaded: std::sync::atomic::AtomicBool,
    /// `read` moved since it was last written.
    dirty: std::sync::atomic::AtomicBool,
}

/// The `meta` key of `state/core.sqlite` the kept records are written under, and the version of what it holds (another
/// version is not read).
const KEPT_META_KEY: &str = "sub-agent-retention-kept";
const KEPT_FILE_VERSION: u64 = 1;

impl DirectoryRetention {
    pub fn new(directory: Arc<SessionDirectory>, index: Arc<dyn AgentOnlyIndex>, stamps: Arc<ArchiveStamps>) -> Self {
        Self {
            directory,
            index,
            stamps,
            read: std::sync::Mutex::default(),
            current: std::sync::Mutex::default(),
            judged: std::sync::Mutex::default(),
            persist: None,
            loaded: std::sync::atomic::AtomicBool::new(false),
            dirty: std::sync::atomic::AtomicBool::new(false),
        }
    }

    /// Keeps what the passes read in `state` (written after a pass that read anything new), so the first pass after a start
    /// reads only the records whose index stamp moved meanwhile. It is a cache: a missing, unreadable or foreign value is read
    /// as empty, and a record's stamp is still checked against the index before its kept fields count.
    pub fn persisted(mut self, state: mixdog_store::state::CoreState) -> Self {
        self.persist = Some(state);
        self
    }

    async fn load_kept(&self) {
        if self.loaded.swap(true, std::sync::atomic::Ordering::SeqCst) {
            return;
        }
        let Some(state) = &self.persist else { return };
        let Ok(Some(text)) = state.meta(KEPT_META_KEY).await else { return };
        let Ok(Value::Object(file)) = serde_json::from_str::<Value>(&text) else { return };
        if file.get("version").and_then(Value::as_u64) != Some(KEPT_FILE_VERSION) {
            return;
        }
        let Some(Value::Object(entries)) = file.get("entries") else { return };
        let mut read = self.read.lock().unwrap_or_else(|p| p.into_inner());
        for (id, entry) in entries {
            if let (Some(stamp), Some(Value::Object(header))) = (entry.get("stamp").and_then(Value::as_str), entry.get("header")) {
                read.entry(id.clone()).or_insert_with(|| (stamp.to_owned(), kept(header)));
            }
        }
    }

    async fn write_kept(&self) {
        let Some(state) = &self.persist else { return };
        if !self.dirty.swap(false, std::sync::atomic::Ordering::SeqCst) {
            return;
        }
        let entries: Map<String, Value> = self
            .read
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .iter()
            .map(|(id, (stamp, header))| (id.clone(), json!({ "stamp": stamp, "header": header })))
            .collect();
        let text = json!({ "version": KEPT_FILE_VERSION, "entries": entries }).to_string();
        if state.write(move |tx| tx.put_meta(KEPT_META_KEY, &text)).await.is_err() {
            // Owed to the next pass.
            self.dirty.store(true, std::sync::atomic::Ordering::SeqCst);
        }
    }
}

/// The header fields a pass reads ([`member`], [`activity_at`], the archive resolution): what [`DirectoryRetention`] keeps of a
/// record between passes. A whole stored header is about 2 MB (it carries the session's context); a thousand of them kept were
/// 1.87 GB resident.
const KEPT_FIELDS: [&str; 13] = [
    "id",
    "taskOrigin",
    "agent",
    "owner",
    "ownerSessionId",
    "parentSessionId",
    "visibility",
    "sessionVisibility",
    "archivedAt",
    "lastUsedAt",
    "updatedAt",
    "createdAt",
    "lastHeartbeatAt",
];

/// `header` narrowed to [`KEPT_FIELDS`].
fn kept(header: &Header) -> Header {
    KEPT_FIELDS.iter().filter_map(|key| header.get(*key).map(|value| ((*key).to_owned(), value.clone()))).collect()
}

/// What moves whenever a stored record does: its last write, size and file time as the index projected them. Empty when
/// the row carries none of them, which never matches, so such a record is always read.
fn record_stamp(row: &Header) -> String {
    let part = |key: &str| row.get(key).map(Value::to_string).unwrap_or_default();
    let stamp = [part("updatedAt"), part("storageSize"), part("storageMtimeMs")];
    if stamp.iter().all(String::is_empty) { String::new() } else { stamp.join("|") }
}

#[async_trait]
impl RetentionHost for DirectoryRetention {
    async fn agent_only_ids(&self) -> Result<Vec<String>, CoreError> {
        self.load_kept().await;
        let rows = self.index.agent_only_rows().await?;
        let stamps: HashMap<String, String> = rows.iter().map(|(id, row)| (id.clone(), record_stamp(row))).collect();
        // A record no longer listed is not kept for a pass that will not ask for it.
        self.read.lock().unwrap_or_else(|p| p.into_inner()).retain(|id, _| stamps.contains_key(id));
        *self.current.lock().unwrap_or_else(|p| p.into_inner()) = stamps;
        Ok(rows.into_iter().map(|(id, _)| id).collect())
    }

    /// The header with its archive mark as the archive authority resolves it. A record that is not loaded and whose index
    /// stamp has not moved since the last pass read it is answered from that read; the archive mark is resolved anew.
    async fn stored_header(&self, id: &str) -> Result<Option<Header>, CoreError> {
        let thread = ThreadId::from(id);
        let stamp = self.current.lock().unwrap_or_else(|p| p.into_inner()).get(id).cloned().filter(|stamp| !stamp.is_empty());
        let loaded = self.directory.handle(&thread).is_some();
        if !loaded
            && let Some(stamp) = &stamp
            && let Some((held, header)) = self.read.lock().unwrap_or_else(|p| p.into_inner()).get(id)
            && held == stamp
        {
            return Ok(Some(self.directory.archive_resolved(id, header)));
        }
        // Only the fields a pass reads are answered (and kept), so a fresh read and a kept one answer alike.
        let header = self.directory.try_stored_header(&thread).await?.map(|header| kept(&header));
        if let (false, Some(stamp), Some(header)) = (loaded, stamp, header.as_ref()) {
            self.read.lock().unwrap_or_else(|p| p.into_inner()).insert(id.to_owned(), (stamp, header.clone()));
            self.dirty.store(true, std::sync::atomic::Ordering::SeqCst);
        }
        Ok(header.map(|header| self.directory.archive_resolved(id, &header)))
    }

    fn trusted(&self, id: &str, header: &Header) -> bool {
        let state = self.directory.archive_state(id, header);
        self.judged.lock().unwrap_or_else(|p| p.into_inner()).insert(id.to_owned(), state.entry);
        state.trusted()
    }

    fn is_live(&self, id: &str) -> bool {
        self.directory.handle(&ThreadId::from(id)).is_some()
    }

    async fn archive(&self, id: &str) -> Result<(), CoreError> {
        let Some(header) = self.directory.try_stored_header(&ThreadId::from(id)).await? else { return Ok(()) };
        let (stamps, now) = (self.stamps.clone(), self.directory.deps().clock.now_ms());
        self.directory.mark_archived(id, &header, Mark::Automatic(Box::new(move || stamps.take(now) as f64))).await.map(drop)
    }

    async fn delete(&self, id: &str, activity: f64, peers: &[(String, f64)], cancel: &CancellationToken) -> Result<bool, CoreError> {
        // A session whose archive state this pass did not read is not deleted on it.
        let Some(judged) = self.judged.lock().unwrap_or_else(|p| p.into_inner()).get(id).copied() else { return Ok(false) };
        self.directory.delete_stored_judged(id, activity, peers, cancel, judged).await
    }

    async fn pass_ended(&self) {
        self.write_kept().await;
    }
}
