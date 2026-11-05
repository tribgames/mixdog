//! The public, per-pool address space of core memory. Stored rows keep a
//! stable database key; callers address an entry by its 1-based position in
//! its pool plus the pool's revision, so a stale position (after a delete or
//! a move) is rejected instead of silently naming another entry. The
//! directory lives in `meta` under `memory.core.index.<pool>`.

use std::collections::{BTreeMap, BTreeSet};

use serde::{Deserialize, Serialize};
use tokio_postgres::Transaction;

use crate::memory::core::access::Pool;
use crate::memory::error::{MemoryError, Result};
use crate::memory::pg::db::Db;

const PREFIX: &str = "memory.core.index.";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct IndexState {
    pub revision: String,
    pub record_ids: Vec<i64>,
}

pub type Directory = BTreeMap<String, IndexState>;

/// A project pool keys as `null` or `"slug"`; an agent's own pool as `{"agent":"id"}`.
pub fn scope_key(project_id: Option<&str>, agent_id: Option<&str>) -> String {
    match agent_id {
        Some(agent) => serde_json::json!({ "agent": agent }).to_string(),
        None => serde_json::to_string(&project_id).unwrap_or_else(|_| "null".to_owned()),
    }
}

/// Brings the directory in line with the live entries and returns it. Retained
/// entries keep their positions; new ones append; a pool whose membership
/// changed gets a new revision.
pub async fn sync(db: &Db) -> Result<Directory> {
    let mut client = db.client().await?;
    let tx = client.transaction().await?;
    let directory = sync_in(&tx).await?;
    tx.commit().await?;
    Ok(directory)
}

pub async fn sync_in(tx: &Transaction<'_>) -> Result<Directory> {
    tx.execute("SELECT pg_advisory_xact_lock(hashtext($1))", &[&PREFIX]).await?;
    let records = tx
        .query(
            "SELECT id, project_id, agent_id FROM core_entries
              WHERE status IS NULL OR status = 'active' ORDER BY id ASC",
            &[],
        )
        .await?;
    let saved = tx.query("SELECT key, value FROM meta WHERE key LIKE $1", &[&format!("{PREFIX}%")]).await?;
    let mut previous: BTreeMap<String, IndexState> = BTreeMap::new();
    for row in &saved {
        let key: String = row.get(0);
        let value: serde_json::Value = row.get(1);
        let scope = key[PREFIX.len()..].to_owned();
        let ids: Vec<i64> = value
            .get("recordIds")
            .and_then(|ids| ids.as_array())
            .map(|ids| ids.iter().filter_map(serde_json::Value::as_i64).collect())
            .unwrap_or_default();
        let revision = value.get("revision").and_then(|r| r.as_str()).unwrap_or_default().to_owned();
        previous.insert(scope, IndexState { revision, record_ids: ids });
    }
    let mut groups: BTreeMap<String, Vec<i64>> = BTreeMap::new();
    for row in &records {
        let id: i64 = row.get(0);
        let project: Option<String> = row.get(1);
        let agent: Option<String> = row.get(2);
        groups.entry(scope_key(project.as_deref(), agent.as_deref())).or_default().push(id);
    }
    let keys: BTreeSet<String> = groups.keys().chain(previous.keys()).cloned().collect();
    let mut result = Directory::new();
    for key in keys {
        let current = groups.remove(&key).unwrap_or_default();
        let old = previous.get(&key);
        let old_ids = old.map(|state| state.record_ids.clone()).unwrap_or_default();
        let live: BTreeSet<i64> = current.iter().copied().collect();
        let mut seen = BTreeSet::new();
        let retained: Vec<i64> = old_ids.iter().copied().filter(|id| live.contains(id) && seen.insert(*id)).collect();
        let known: BTreeSet<i64> = retained.iter().copied().collect();
        let mut record_ids = retained;
        record_ids.extend(current.iter().copied().filter(|id| !known.contains(id)));
        let revision_missing = old.is_none_or(|state| state.revision.is_empty());
        let changed = revision_missing || old_ids != record_ids;
        let state = IndexState {
            revision: if changed { uuid::Uuid::new_v4().to_string() } else { old.map(|s| s.revision.clone()).unwrap_or_default() },
            record_ids,
        };
        if changed {
            tx.execute(
                "INSERT INTO meta(key, value) VALUES ($1, $2::jsonb)
                 ON CONFLICT(key) DO UPDATE SET value = EXCLUDED.value",
                &[&format!("{PREFIX}{key}"), &serde_json::to_value(&state)?],
            )
            .await?;
        }
        result.insert(key, state);
    }
    Ok(result)
}

/// The public position (1-based) and revision of stored entry `id`, when it is live.
pub fn address(directory: &Directory, pool: &Pool<'_>, id: i64) -> Option<(usize, String)> {
    let state = directory.get(&scope_key(pool.project_id, pool.agent_id))?;
    let index = state.record_ids.iter().position(|record| *record == id)?;
    Some((index + 1, state.revision.clone()))
}

/// The stored key behind a caller-supplied (`index`, `revision`) of `pool`.
pub async fn resolve(db: &Db, scope: Option<&str>, agent_id: Option<&str>, index: &serde_json::Value, revision: &serde_json::Value) -> Result<i64> {
    if scope == Some("*") && agent_id.is_none() {
        return Err(MemoryError::rejected("memory writes require one explicit project scope"));
    }
    let position = index_number(index).filter(|n| *n > 0).ok_or_else(|| MemoryError::rejected("memory index must be a positive integer"))?;
    let revision = match revision.as_str() {
        Some(text) if !text.is_empty() => text,
        _ => return Err(MemoryError::rejected("index_revision required; list memories before editing or deleting")),
    };
    let directory = sync(db).await?;
    let state = directory.get(&scope_key(scope, agent_id));
    let Some(state) = state.filter(|state| state.revision == revision) else {
        return Err(MemoryError::rejected("memory indices changed; list memories again before editing or deleting"));
    };
    let pool = Pool { project_id: scope, agent_id };
    usize::try_from(position)
        .ok()
        .and_then(|n| state.record_ids.get(n - 1))
        .copied()
        .ok_or_else(|| MemoryError::rejected(format!("no memory index={} in {}", display_number(index), pool.label())))
}

/// JS `Number(value)` restricted to what is a safe integer.
fn index_number(value: &serde_json::Value) -> Option<i64> {
    let number = match value {
        serde_json::Value::Number(n) => n.as_f64()?,
        serde_json::Value::String(s) => mixdog_js::string_to_number(s),
        serde_json::Value::Bool(b) => f64::from(u8::from(*b)),
        _ => return None,
    };
    (number.fract() == 0.0 && number.abs() <= 9_007_199_254_740_991.0).then_some(number as i64)
}

fn display_number(value: &serde_json::Value) -> String {
    match value {
        serde_json::Value::String(s) => s.clone(),
        other => other.to_string(),
    }
}

/// `"<pool> id=<position> index_revision=<revision>"` of a stored entry.
pub async fn public_identity(db: &Db, project_id: Option<&str>, agent_id: Option<&str>, id: i64) -> Result<String> {
    let directory = sync(db).await?;
    let pool = Pool { project_id, agent_id };
    let (position, revision) = address(&directory, &pool, id)
        .ok_or_else(|| MemoryError::rejected("memory changed before its index could be returned; list memories again"))?;
    Ok(format!("{} id={position} index_revision={revision}", pool.label()))
}
