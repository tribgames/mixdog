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

/// The session's own tag keys, as 1.4.5 `lastTagSession` reads a session record:
/// `agentTagOf(session)` = `clean(agentTag)` and the owner of `sessionMatchesContext`.
#[derive(Debug, Clone, PartialEq)]
pub struct TagKeys {
    pub tag: String,
    pub owner: Option<String>,
}

impl TagKeys {
    /// `None` without a tag, and for a Lead pool session (`isLeadPoolAgent(session.agent)`).
    pub fn of(header: &Map<String, Value>) -> Option<TagKeys> {
        let tag = clean(header.get("agentTag"));
        if tag.is_empty() || clean(header.get("agent")).to_lowercase() == "lead" {
            return None;
        }
        Some(TagKeys { tag, owner: owner_of(header) })
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

/// Newest `created_at` first (1.4.5 compares `createdAt`), then id.
pub(crate) const NEWEST_TAG_SQL: &str = "SELECT id, summary FROM sessions
    WHERE agent_tag = ?1 AND agent_owner = ?2 AND deleted = 0 AND log_id <> ''
    ORDER BY created_at DESC, id LIMIT 1";

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
