//! The core-memory snapshot file (`core-memory.json`): the active curated
//! entries as plain data, rewritten after every mutation. A new session reads
//! it to inject standing memory without touching Postgres. Refreshes reserve a
//! revision before they query, and the write refuses to replace a newer
//! revision, so refreshes that finish out of order cannot roll the file back.

use mixdog_js::{js_trim, js_words, to_number_of, value_to_string};
use serde_json::Value;
use mixdog_rt::DurabilityIo;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::memory::core::index;
use crate::memory::core::access::Pool;
use crate::memory::error::Result;
use crate::memory::pg::db::Db;
use crate::model_install::fsio;

const VERSION: u32 = 1;
const FILE_NAME: &str = "core-memory.json";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotEntry {
    pub id: i64,
    pub index_revision: Option<String>,
    pub summary: String,
    pub project_id: Option<String>,
    pub agent_id: Option<String>,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub version: u32,
    pub revision: u64,
    pub updated_at: i64,
    pub curated: Vec<SnapshotEntry>,
}

fn file_path(data_dir: &Path) -> PathBuf {
    data_dir.join(FILE_NAME)
}

fn collapse_whitespace(text: &str) -> String {
    js_words(text).collect::<Vec<_>>().join(" ")
}

/// `finiteNumber(value)`: `Number(value)` when finite, else 0 (also for an absent value).
fn finite_number(value: Option<&Value>) -> f64 {
    let number = to_number_of(value);
    if number.is_finite() { number } else { 0.0 }
}

/// `a ?? b`: the first value that is neither absent nor null.
fn first_set<'a>(row: &'a Value, a: &str, b: &str) -> Option<&'a Value> {
    row.get(a).filter(|v| !v.is_null()).or_else(|| row.get(b).filter(|v| !v.is_null()))
}

/// `normalizeProjectId`: absent or null is None; otherwise `String(value).trim()`, None when empty.
fn optional_id(value: Option<&Value>) -> Option<String> {
    let text = js_trim(&value_to_string(value?)).to_owned();
    (!text.is_empty()).then_some(text)
}

/// `normalizeCuratedEntry`: a row with no text is skipped, every other missing or odd field takes
/// its default (id and time 0, no revision, project or agent). The snake-case spellings count.
fn normalized_entry(row: &Value) -> Option<SnapshotEntry> {
    // `String(value || '')`: a falsy value is the empty string.
    let falsy = |v: &Value| match v {
        Value::Null => true,
        Value::Bool(flag) => !flag,
        Value::Number(number) => number.as_f64().unwrap_or(f64::NAN).is_nan() || number.as_f64() == Some(0.0),
        Value::String(text) => text.is_empty(),
        _ => false,
    };
    let summary = row.get("summary").filter(|v| !falsy(v)).map_or_else(String::new, value_to_string);
    let summary = collapse_whitespace(&summary);
    if summary.is_empty() {
        return None;
    }
    Some(SnapshotEntry {
        id: finite_number(row.get("id")) as i64,
        index_revision: first_set(row, "indexRevision", "index_revision").map(value_to_string),
        summary,
        project_id: optional_id(first_set(row, "projectId", "project_id")),
        agent_id: optional_id(first_set(row, "agentId", "agent_id")),
        updated_at: finite_number(first_set(row, "updatedAt", "updated_at")) as i64,
    })
}

/// `readCoreMemoryFile`: the stored snapshot, or None when absent, unreadable, not JSON or of
/// another version. The file may have been edited by hand or written by an older product, so it
/// is read as tolerantly as Node reads it: missing or malformed fields take their defaults.
pub async fn read(lane: DurabilityIo, data_dir: &Path) -> Option<Snapshot> {
    let bytes = fsio::read(lane, &file_path(data_dir)).await.ok()?;
    let parsed: Value = serde_json::from_str(&String::from_utf8_lossy(&bytes)).ok()?;
    // `parsed?.version !== 1`: only the number 1 counts, not "1" or true.
    if parsed.get("version").and_then(Value::as_f64) != Some(f64::from(VERSION)) {
        return None;
    }
    Some(Snapshot {
        version: VERSION,
        revision: finite_number(parsed.get("revision")).max(0.0) as u64,
        updated_at: finite_number(parsed.get("updatedAt")).max(0.0) as i64,
        curated: parsed
            .get("curated")
            .and_then(Value::as_array)
            .map_or_else(Vec::new, |rows| rows.iter().filter_map(normalized_entry).collect()),
    })
}

/// The curated rows a refresh writes into the snapshot.
pub(crate) const CURATED_SQL: &str = "
      SELECT id, summary, project_id, agent_id, updated_at
      FROM core_entries
      WHERE status IS NULL OR status = 'active'
      ORDER BY project_id NULLS FIRST, id ASC
    ";

/// Rebuilds the snapshot from Postgres and writes it unless a newer revision
/// is already on disk. Returns the revision now on disk and whether this
/// refresh wrote it.
pub async fn refresh(lane: DurabilityIo, db: &Db, data_dir: &Path, reserved: &std::sync::atomic::AtomicU64) -> Result<(u64, bool)> {
    let on_disk = read(lane, data_dir).await.map_or(0, |snapshot| snapshot.revision);
    let revision = reserve(reserved, on_disk);
    let directory = index::sync(db).await?;
    #[cfg(test)]
    index::observe(CURATED_SQL, None, false);
    let rows = db.query(CURATED_SQL, &[]).await?;
    let mut curated = Vec::new();
    for row in &rows {
        let id: i64 = row.get(0);
        let summary = collapse_whitespace(&row.get::<_, String>(1));
        if summary.is_empty() {
            continue;
        }
        let project_id: Option<String> = row.get(2);
        let agent_id: Option<String> = row.get(3);
        let address = index::address(
            &directory,
            &Pool { project_id: project_id.as_deref(), agent_id: agent_id.as_deref() },
            id,
        );
        curated.push(SnapshotEntry {
            id: address.as_ref().map_or(0, |(position, _)| *position as i64),
            index_revision: address.map(|(_, revision)| revision),
            summary,
            project_id: project_id.map(|p| js_trim(&p).to_owned()).filter(|p| !p.is_empty()),
            agent_id: agent_id.map(|a| js_trim(&a).to_owned()).filter(|a| !a.is_empty()),
            updated_at: row.get(4),
        });
    }
    write(lane, data_dir, Snapshot { version: VERSION, revision, updated_at: super::store::now_ms(), curated }).await
}

fn reserve(reserved: &std::sync::atomic::AtomicU64, on_disk: u64) -> u64 {
    use std::sync::atomic::Ordering;
    let mut current = reserved.load(Ordering::Acquire);
    loop {
        let next = current.max(on_disk) + 1;
        match reserved.compare_exchange(current, next, Ordering::AcqRel, Ordering::Acquire) {
            Ok(_) => return next,
            Err(seen) => current = seen,
        }
    }
}

/// `writeCoreMemoryFileSnapshot(dataDir, { curated }, { revision })`: writes the curated rows (normalised as a read
/// normalises them; a row without text is dropped) at `revision`, or at a newly reserved one when None, unless the
/// file already holds that revision or a newer one. Returns the revision on disk afterwards and whether it is the
/// requested one (Node's `written`, which is also true when the file already held exactly that revision).
pub async fn write_snapshot(
    lane: DurabilityIo,
    data_dir: &Path,
    curated: &[Value],
    revision: Option<u64>,
    reserved: &std::sync::atomic::AtomicU64,
) -> Result<(u64, bool)> {
    let revision = match revision {
        Some(revision) => revision.max(1),
        None => reserve(reserved, read(lane, data_dir).await.map_or(0, |snapshot| snapshot.revision)),
    };
    let curated = curated.iter().filter_map(normalized_entry).collect();
    write(lane, data_dir, Snapshot { version: VERSION, revision, updated_at: super::store::now_ms(), curated }).await
}

async fn write(lane: DurabilityIo, data_dir: &Path, snapshot: Snapshot) -> Result<(u64, bool)> {
    let path = file_path(data_dir);
    // A slower refresh may finish after a newer one: never overwrite it.
    if let Some(current) = read(lane, data_dir).await
        && current.revision >= snapshot.revision {
            return Ok((current.revision, current.revision == snapshot.revision));
        }
    fsio::create_dir_all(lane, data_dir).await?;
    let temp = data_dir.join(format!("{FILE_NAME}.{}.tmp", uuid::Uuid::new_v4().simple()));
    // `writeJsonAtomicAsync(..., { compact: true })`: compact JSON and a final newline.
    let mut bytes = serde_json::to_vec(&snapshot)?;
    bytes.push(b'\n');
    fsio::write(lane, &temp, bytes).await?;
    fsio::rename(lane, &temp, &path).await?;
    Ok((snapshot.revision, true))
}

/// What a new session injects: common entries, then those of the `project_id`
/// project, then the agent's own. The caller's byte budget cuts from the end.
#[derive(Debug, Clone, PartialEq)]
pub struct SessionPayload {
    pub project_id: Option<String>,
    pub revision: u64,
    pub user_lines: Vec<String>,
    /// Always empty (`core-memory-file.mjs:156`): generated records stay searchable and are never injected.
    pub db_lines: Vec<String>,
}

pub fn session_payload(snapshot: &Snapshot, project_id: Option<&str>, agent_id: &str) -> SessionPayload {
    let agent = Some(js_trim(agent_id)).filter(|a| !a.is_empty());
    let rank = |entry: &SnapshotEntry| -> Option<u8> {
        if let Some(own) = entry.agent_id.as_deref() {
            return (agent == Some(own)).then_some(2);
        }
        match entry.project_id.as_deref() {
            None => Some(0),
            Some(project) => (Some(project) == project_id).then_some(1),
        }
    };
    let mut picked: Vec<(u8, &SnapshotEntry)> =
        snapshot.curated.iter().filter_map(|entry| rank(entry).map(|rank| (rank, entry))).collect();
    picked.sort_by_key(|(rank, entry)| (*rank, entry.id));
    SessionPayload {
        project_id: project_id.map(str::to_owned),
        revision: snapshot.revision,
        user_lines: picked.into_iter().map(|(_, entry)| entry.summary.clone()).collect(),
        db_lines: Vec::new(),
    }
}
