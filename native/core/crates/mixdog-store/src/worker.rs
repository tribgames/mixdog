//! The worker index (FORMAT.md §8.2): the keys of a session header's `worker` map (the
//! 1.4.5 worker row of `agent-workers.json`, which also holds its reap tombstone and its
//! closed-by-owner marker) that the agent registry looks rows up by, and the session's own
//! `agentTag` and owner for the newest session per tag. Written by the catalog
//! upsert, the one writer of a session's header columns.

use serde_json::Map;
use serde_json::Value;

use crate::summary::truthy;

/// The indexed keys of a `worker` map, normalized as 1.4.5 `agent-tool` reads a worker row.
#[derive(Debug, Clone, PartialEq)]
pub struct WorkerKeys {
    /// The map as JSON.
    pub map: String,
    /// `clean(row.tag)`; empty for a row without a tag.
    pub tag: String,
    /// `clean(row.parentSessionId || row.ownerSessionId)` (`sessionMatchesContext`).
    pub owner: Option<String>,
    /// `positiveInt(row.clientHostPid)`.
    pub host_pid: Option<i64>,
}

impl WorkerKeys {
    /// `None` without a `worker` object, and for a Lead pool row (`agent` "lead"), which
    /// 1.4.5 `normalizeWorkerRows` hides from every reader.
    pub fn of(header: &Map<String, Value>) -> Option<WorkerKeys> {
        let row = header.get("worker")?.as_object()?;
        if clean(row.get("agent")).to_lowercase() == "lead" {
            return None;
        }
        Some(WorkerKeys {
            map: Value::Object(row.clone()).to_string(),
            tag: clean(row.get("tag")),
            owner: owner_of(row),
            host_pid: positive_int(row.get("clientHostPid")),
        })
    }
}

/// The session's own tag keys, as 1.4.5 `lastTagSession` reads the agent registry's
/// descriptor of a stored session (`agent-rehydrate.mjs` `storedAgentCandidate` and
/// `rehydratedDescriptor`): `agentTagOf` = `clean(agentTag)`, and the parent link that
/// `sessionMatchesContext` compares.
#[derive(Debug, Clone, PartialEq)]
pub struct TagKeys {
    pub tag: String,
    pub owner: String,
}

impl TagKeys {
    /// `None` unless the session is in the agent registry (agent-only, or a legacy
    /// `owner: agent` child, with a parent link that is a session id other than its own),
    /// has a tag, and is not a Lead pool session (`agent || sourceName` "lead").
    pub fn of(session: &str, header: &Map<String, Value>) -> Option<TagKeys> {
        let owner = owner_of(header).filter(|o| crate::summary::is_stored_session_id(o) && o != session)?;
        let agent_only = crate::summary::session_visibility(header) == "agent-only"
            || clean(header.get("owner")).to_lowercase() == "agent";
        let agent = header.get("agent");
        let agent = if truthy(agent) { agent } else { header.get("sourceName") };
        let tag = clean(header.get("agentTag"));
        (agent_only && !tag.is_empty() && clean(agent).to_lowercase() != "lead").then_some(TagKeys { tag, owner })
    }
}

/// `clean(x.parentSessionId || x.ownerSessionId)`, `None` when empty.
fn owner_of(row: &Map<String, Value>) -> Option<String> {
    let parent = row.get("parentSessionId");
    let owner = if truthy(parent) { parent } else { row.get("ownerSessionId") };
    Some(clean(owner)).filter(|o| !o.is_empty())
}

/// The newest session one owner ran under a tag (`lastTagSession`).
#[derive(Debug, Clone, PartialEq)]
pub struct TagSession {
    pub session: String,
    /// The session's JSON list row.
    pub summary: String,
}

/// 1.4.5 keeps the first session of its walk with the greatest `createdAt` (a missing one
/// is 0, here NULL, which sorts last). The walk is the agent registry's insertion order
/// (`agent-tree.mjs` `listSessions`, `registry.ids()`), which a boot fills by rehydration
/// from the stored listing, newest `updatedAt` first (`summary-cache.mjs`); its own ties
/// fall to the directory scan, for which id stands.
pub(crate) const NEWEST_TAG_SQL: &str = "SELECT id, summary FROM sessions
    WHERE agent_tag = ?1 AND agent_owner = ?2 AND deleted = 0 AND log_id <> ''
    ORDER BY created_at DESC, updated_at DESC, id LIMIT 1";

/// Whose rows a lookup returns: 1.4.5 `sessionMatchesContext` (the caller's owner session
/// when it has one, else its host process, else every row).
#[derive(Debug, Clone, PartialEq)]
pub enum WorkerScope {
    Owner(String),
    HostPid(i64),
    All,
}

/// One indexed session's worker row.
#[derive(Debug, Clone, PartialEq)]
pub struct WorkerRow {
    pub session: String,
    pub worker: Map<String, Value>,
    /// The session's JSON list row.
    pub summary: String,
}

/// One session as a load of the worker index reads it (FORMAT.md §8.2 worker index revision).
#[derive(Debug, Clone, PartialEq)]
pub struct IndexedSession {
    pub session: String,
    /// `created_at`: the worker rows' order is newest first (none last), then id.
    pub created_at: Option<f64>,
    /// The `worker` map, while the session is listed as a worker row.
    pub worker: Option<Map<String, Value>>,
    /// The `activity` (the agent-only sessions' order: newest first, then id) and the JSON list row, while the session is
    /// listed as an agent-only session.
    pub agent: Option<(f64, String)>,
}

/// A load of the worker index at one revision, read in one read transaction with it.
#[derive(Debug, Clone, PartialEq)]
pub struct WorkerIndexRead {
    pub revision: u64,
    /// `sessions` is every listed session (a first load, or a revision this index never had); otherwise the sessions written
    /// since the revision asked about, and those asked for by id, listed or not.
    pub full: bool,
    pub sessions: Vec<IndexedSession>,
}

/// The columns of an [`IndexedSession`]; the listing filters are the worker rows' and `AGENT_ONLY_SQL`'s.
macro_rules! indexed_sql {
    ($cond:literal) => {
        concat!(
            "SELECT id, created_at,
                CASE WHEN worker_tag IS NOT NULL AND deleted = 0 AND log_id <> '' THEN worker END,
                activity,
                CASE WHEN visibility = 'agent-only' AND deleted = 0 AND log_id <> '' THEN summary END
            FROM sessions WHERE ",
            $cond
        )
    };
}

/// Every listed session.
pub(crate) const INDEXED_ALL_SQL: &str =
    indexed_sql!("deleted = 0 AND log_id <> '' AND (worker_tag IS NOT NULL OR visibility = 'agent-only')");
/// The sessions written since a revision.
pub(crate) const INDEXED_SINCE_SQL: &str = indexed_sql!("worker_rev > ?1");
/// One session by id.
pub(crate) const INDEXED_ONE_SQL: &str = indexed_sql!("id = ?1");
/// The listed sessions deleted without their delete mark since a revision.
pub(crate) const REMOVED_SINCE_SQL: &str = "SELECT id FROM worker_removed WHERE rev > ?1";
pub(crate) const REVISION_SQL: &str = "SELECT rev FROM worker_revision";

/// `String(value ?? '').trim()`.
fn clean(v: Option<&Value>) -> String {
    match v {
        None | Some(Value::Null) => String::new(),
        Some(Value::String(s)) => mixdog_js::js_trim(s).to_owned(),
        Some(other) => mixdog_js::js_trim(&mixdog_js::value_to_string(other)).to_owned(),
    }
}

/// `positiveInt(value)`: `Math.floor(Number(value))` when finite and at least 1.
fn positive_int(v: Option<&Value>) -> Option<i64> {
    let n = mixdog_js::to_number(v?).floor();
    (n.is_finite() && n >= 1.0 && n <= i64::MAX as f64).then_some(n as i64)
}

/// The lookups, newest session first (`created_at`, then id). The row filter is the list
/// filter of a summary: not deleted, with a readable `session` frame.
macro_rules! rows_sql {
    ($cond:literal) => {
        concat!(
            "SELECT id, worker, summary FROM sessions WHERE ",
            $cond,
            " AND deleted = 0 AND log_id <> '' ORDER BY created_at DESC, id"
        )
    };
}

/// `[tag lookup][scope]`, scope in `Owner`, `HostPid`, `All` order.
pub(crate) const ROWS_SQL: [[&str; 3]; 2] = [
    [
        rows_sql!("worker_owner = ?1"),
        rows_sql!("worker_host_pid = ?1"),
        rows_sql!("worker_tag IS NOT NULL"),
    ],
    [
        rows_sql!("worker_tag = ?2 AND worker_owner = ?1"),
        rows_sql!("worker_tag = ?2 AND worker_host_pid = ?1"),
        rows_sql!("worker_tag = ?1"),
    ],
];
