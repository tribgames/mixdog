//! The core-memory snapshot file (`core-memory.json`): the active curated
//! entries as plain data, rewritten after every mutation. A new session reads
//! it to inject standing memory without touching Postgres. Refreshes reserve a
//! revision before they query, and the write refuses to replace a newer
//! revision, so refreshes that finish out of order cannot roll the file back.

use mixdog_js::{js_trim, js_words};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::memory::core::index;
use crate::memory::core::access::Pool;
use crate::memory::error::Result;
use crate::memory::pg::db::Db;

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

/// The stored snapshot, or None when absent, unreadable or of another version.
pub async fn read(data_dir: &Path) -> Option<Snapshot> {
    let bytes = tokio::fs::read(file_path(data_dir)).await.ok()?;
    let snapshot: Snapshot = serde_json::from_slice(&bytes).ok()?;
    (snapshot.version == VERSION).then_some(snapshot)
}

/// Rebuilds the snapshot from Postgres and writes it unless a newer revision
/// is already on disk. Returns the revision now on disk and whether this
/// refresh wrote it.
pub async fn refresh(db: &Db, data_dir: &Path, reserved: &std::sync::atomic::AtomicU64) -> Result<(u64, bool)> {
    let on_disk = read(data_dir).await.map_or(0, |snapshot| snapshot.revision);
    let revision = reserve(reserved, on_disk);
    let directory = index::sync(db).await?;
    let rows = db
        .query(
            "SELECT id, summary, project_id, agent_id, updated_at FROM core_entries
              WHERE status IS NULL OR status = 'active' ORDER BY project_id NULLS FIRST, id ASC",
            &[],
        )
        .await?;
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
    write(data_dir, Snapshot { version: VERSION, revision, updated_at: super::store::now_ms(), curated }).await
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

async fn write(data_dir: &Path, snapshot: Snapshot) -> Result<(u64, bool)> {
    let path = file_path(data_dir);
    // A slower refresh may finish after a newer one: never overwrite it.
    if let Some(current) = read(data_dir).await
        && current.revision >= snapshot.revision {
            return Ok((current.revision, false));
        }
    tokio::fs::create_dir_all(data_dir).await?;
    let temp = data_dir.join(format!("{FILE_NAME}.{}.tmp", uuid::Uuid::new_v4().simple()));
    tokio::fs::write(&temp, serde_json::to_vec(&snapshot)?).await?;
    tokio::fs::rename(&temp, &path).await?;
    Ok((snapshot.revision, true))
}

/// What a new session injects: common entries, then those of the `project_id`
/// project, then the agent's own. The caller's byte budget cuts from the end.
#[derive(Debug, Clone, PartialEq)]
pub struct SessionPayload {
    pub project_id: Option<String>,
    pub revision: u64,
    pub user_lines: Vec<String>,
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
    }
}
