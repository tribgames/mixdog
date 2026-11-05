//! The durable registry of managed worktrees: `<dataDir>/worktrees-v1/registry.json`, one record
//! per worktree keyed by its slug. Writes are atomic (temp file, then rename) and keep the
//! replaced version as `registry.json.bak`. A damaged registry never blocks worktree work: its
//! bytes are kept aside as `registry.json.corrupt-<ts>`, the last good copy is restored when
//! there is one, and otherwise the registry starts empty (worktree folders on disk are never
//! touched by that). One process owns the data dir, so the file needs no cross-process lock.
//!
//! Everything here is blocking file I/O: call it on the maintenance lane.

use std::collections::BTreeMap;
use std::path::Path;
use std::path::PathBuf;

use serde::Deserialize;
use serde::Serialize;
use serde_json::Map;
use serde_json::Value;

use crate::error::ScmFailure;

pub const STORE_DIR: &str = "worktrees-v1";
const VERSION: u64 = 1;

/// One registry entry. Fields the engine does not interpret are kept and written back.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeRecord {
    pub id: String,
    pub repo_common_dir: String,
    pub project_path: String,
    pub path: String,
    #[serde(default)]
    pub branch: Option<String>,
    #[serde(default)]
    pub base_commit: Option<String>,
    pub created_at: i64,
    #[serde(default)]
    pub owner_session_id: Option<String>,
    /// `creating`, `ready`, `deleting` or `recovery`.
    pub state: String,
    #[serde(default)]
    pub merge_target: Option<String>,
    #[serde(default)]
    pub shared_session_ids: Vec<String>,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

#[derive(Serialize, Deserialize)]
struct Document {
    version: u64,
    entries: BTreeMap<String, WorktreeRecord>,
}

pub struct Registry {
    path: PathBuf,
}

impl Registry {
    pub fn new(data_dir: &Path) -> Self {
        Self {
            path: data_dir.join(STORE_DIR).join("registry.json"),
        }
    }

    fn parse(bytes: &[u8]) -> Option<Document> {
        serde_json::from_slice::<Document>(bytes).ok()
    }

    fn backup(&self) -> PathBuf {
        self.path.with_extension("json.bak")
    }

    /// Every record; a damaged registry is set aside and the last good copy restored.
    pub fn read(&self) -> Result<BTreeMap<String, WorktreeRecord>, ScmFailure> {
        let bytes = match std::fs::read(&self.path) {
            Ok(bytes) => bytes,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(BTreeMap::new()),
            Err(error) => return Err(error.into()),
        };
        if let Some(doc) = Self::parse(&bytes) {
            return Ok(doc.entries);
        }
        let stamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_or(0, |d| d.as_millis());
        let aside = self.path.with_extension(format!("json.corrupt-{stamp}"));
        std::fs::rename(&self.path, aside)?;
        match std::fs::read(self.backup()).ok().and_then(|bytes| Self::parse(&bytes)) {
            Some(doc) => {
                self.write(&doc.entries)?;
                Ok(doc.entries)
            }
            None => Ok(BTreeMap::new()),
        }
    }

    fn write(&self, entries: &BTreeMap<String, WorktreeRecord>) -> Result<(), ScmFailure> {
        let dir = self.path.parent().ok_or_else(|| ScmFailure::invalid("dataDir", "a directory"))?;
        std::fs::create_dir_all(dir)?;
        let doc = Document {
            version: VERSION,
            entries: entries.clone(),
        };
        let bytes = serde_json::to_vec_pretty(&doc).map_err(|error| ScmFailure::git(error.to_string()))?;
        let temp = self.path.with_extension(format!("json.tmp-{}", std::process::id()));
        {
            use std::io::Write;
            let mut file = std::fs::File::create(&temp)?;
            file.write_all(&bytes)?;
            file.sync_all()?;
        }
        if self.path.exists() {
            let _ = std::fs::copy(&self.path, self.backup());
        }
        std::fs::rename(&temp, &self.path)?;
        Ok(())
    }

    pub fn get(&self, id: &str) -> Result<Option<WorktreeRecord>, ScmFailure> {
        Ok(self.read()?.remove(id))
    }

    pub fn put(&self, record: WorktreeRecord) -> Result<(), ScmFailure> {
        let mut entries = self.read()?;
        entries.insert(record.id.clone(), record);
        self.write(&entries)
    }

    /// Inserts a new record; `false` when the id is already taken.
    pub fn insert(&self, record: WorktreeRecord) -> Result<bool, ScmFailure> {
        let mut entries = self.read()?;
        if entries.contains_key(&record.id) {
            return Ok(false);
        }
        entries.insert(record.id.clone(), record);
        self.write(&entries)?;
        Ok(true)
    }

    pub fn delete(&self, id: &str) -> Result<(), ScmFailure> {
        let mut entries = self.read()?;
        if entries.remove(id).is_some() {
            self.write(&entries)?;
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn record(id: &str) -> WorktreeRecord {
        WorktreeRecord {
            id: id.into(),
            repo_common_dir: "/r/.git".into(),
            project_path: "/r".into(),
            path: format!("/w/{id}"),
            branch: Some(id.into()),
            base_commit: None,
            created_at: 1,
            owner_session_id: None,
            state: "ready".into(),
            merge_target: None,
            shared_session_ids: Vec::new(),
            extra: Map::new(),
        }
    }

    #[test]
    fn records_round_trip_with_unknown_fields_and_survive_damage() {
        let dir = tempfile::tempdir().unwrap();
        let registry = Registry::new(dir.path());
        let mut first = record("one");
        first.extra.insert("projectSubdir".into(), Value::String("pkg".into()));
        registry.put(first.clone()).unwrap();
        registry.put(record("two")).unwrap();
        assert_eq!(registry.get("one").unwrap(), Some(first));
        assert!(!registry.insert(record("two")).unwrap());
        // A truncated file is set aside and the last good copy restored.
        std::fs::write(dir.path().join(STORE_DIR).join("registry.json"), b"{\"version\":1,\"entr").unwrap();
        let restored = registry.read().unwrap();
        assert_eq!(restored.len(), 1, "the backup holds the state before the last write");
        registry.delete("one").unwrap();
        assert!(registry.get("one").unwrap().is_none());
    }
}
