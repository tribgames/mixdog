//! The durable registry of managed worktrees: `<dataDir>/worktrees-v1/registry.json`, one record
//! per worktree keyed by its slug. Writes are atomic (temp file, then rename) and keep the
//! replaced version as `registry.json.bak`. A damaged registry never blocks worktree work: its
//! bytes are kept aside as `registry.json.corrupt-<ts>`, the last good copy is restored when
//! there is one, and otherwise the registry starts empty (worktree folders on disk are never
//! touched by that). One process owns the data dir, so the file needs no cross-process lock.
//!
//! Everything here is blocking file I/O: call it on the maintenance lane.

#![allow(clippy::disallowed_methods, clippy::disallowed_types, reason = "every blocking std::fs call in this module is the body of a lane job")]

use indexmap::IndexMap;
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
    entries: IndexMap<String, WorktreeRecord>,
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
        // A branch a phone sent cut inside an emoji is stored by Node with half of it: U+FFFD here.
        serde_json::from_slice::<Document>(&mixdog_js::json_well_formed(bytes)).ok()
    }

    fn backup(&self) -> PathBuf {
        self.path.with_extension("json.bak")
    }

    /// Every record in the order they were added, as Node's object keeps them (the lists show
    /// that order); a damaged registry is set aside and the last good copy restored.
    pub fn read(&self) -> Result<IndexMap<String, WorktreeRecord>, ScmFailure> {
        let bytes = match std::fs::read(&self.path) {
            Ok(bytes) => bytes,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(IndexMap::new()),
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
            None => Ok(IndexMap::new()),
        }
    }

    fn write(&self, entries: &IndexMap<String, WorktreeRecord>) -> Result<(), ScmFailure> {
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
        Ok(self.read()?.shift_remove(id))
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
        if entries.shift_remove(id).is_some() {
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
        registry.put(record("abc")).unwrap();
        assert_eq!(registry.get("one").unwrap(), Some(first));
        assert_eq!(registry.read().unwrap().keys().map(String::as_str).collect::<Vec<_>>(), ["one", "abc"]);
        assert!(!registry.insert(record("abc")).unwrap());
        // A truncated file is set aside and the last good copy restored.
        std::fs::write(dir.path().join(STORE_DIR).join("registry.json"), b"{\"version\":1,\"entr").unwrap();
        let restored = registry.read().unwrap();
        assert_eq!(restored.len(), 1, "the backup holds the state before the last write");
        registry.delete("one").unwrap();
        assert!(registry.get("one").unwrap().is_none());
    }

    /// Node's registry holding a branch cut inside an emoji (`native/core/fixtures/lone-surrogate-files`,
    /// record-lone-surrogate-files.mjs): the core reads every record and field Node's `JSON.parse` reads (the half emoji as
    /// U+FFFD), and the next write keeps them.
    #[test]
    fn a_registry_node_wrote_with_half_an_emoji_is_read_whole_and_kept_by_the_next_write() {
        let set = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/lone-surrogate-files");
        let cases: Value = serde_json::from_slice(&std::fs::read(set.join("cases.json")).unwrap()).unwrap();
        let case = cases.as_array().unwrap().iter().find(|c| c["name"] == "worktree-registry").unwrap();
        let file = case["file"].as_str().unwrap();
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join(STORE_DIR)).unwrap();
        std::fs::copy(set.join("worktree-registry/before").join(file), dir.path().join(file)).unwrap();
        let expected: Document = serde_json::from_value(case["nodeRead"].clone()).unwrap();
        let registry = Registry::new(dir.path());
        assert_eq!(registry.read().unwrap(), expected.entries);
        let second: WorktreeRecord = serde_json::from_value(case["op"]["insert"].clone()).unwrap();
        assert!(registry.insert(second.clone()).unwrap());
        let mut after = expected.entries;
        after.insert(second.id.clone(), second);
        let written = Registry::parse(&std::fs::read(dir.path().join(file)).unwrap()).unwrap();
        assert_eq!(written.entries, after);
        assert_eq!(written.entries.keys().collect::<Vec<_>>(), after.keys().collect::<Vec<_>>());
    }
}
