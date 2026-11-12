//! The durable turn-snapshot index and the per-turn change records (Node
//! `turn-snapshot-store.mjs`), in Node's files under `<data>/turn-snapshots`: one JSON file per
//! session, named by the first 24 hex digits of the SHA-256 of the session id.
//!
//! - `<hash>.json`: the turns' Git baselines and the session scopes (the paths a session owns);
//! - `changes/<hash>.jsonl` (and the previous format's `changes/<hash>.json`): every retained turn's
//!   frozen change record, with its own patches ([`changes`]);
//! - `cleared/<hash>.json`: the "history deleted" marker.

use std::path::Path;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::Mutex;

use mixdog_rt::ChainGuard;
use mixdog_rt::KeyedChains;

use indexmap::IndexMap;
use mixdog_js::json_stringify;
use serde_json::Value;
use sha2::Digest;
use sha2::Sha256;

use super::patch::clean;
use super::patch::obj_f64;
use super::patch::obj_str;
use super::ports::ReviewDisk;
use super::review_diff::Obj;

const RECORD_VERSION: u64 = 1;
// Matches the shadow repository's own collection window: once the tree object is collected the
// record cannot restore anything anyway.
const RECORD_TTL_MS: f64 = 7.0 * 24.0 * 60.0 * 60.0 * 1000.0;
// Enough to cover the reviews a user can still act on; the newest turn wins.
const MAX_TURNS_PER_SESSION: usize = 8;
// A session normally stays in one Project, but cwd changes are valid: one cumulative baseline per
// repository root, without letting a long-lived session grow this record without bound.
const MAX_SESSION_SCOPES: usize = 8;
// A bounded directory: one file per session, oldest swept first.
const MAX_RECORD_FILES: usize = 512;

const CHANGES_VERSION: u64 = 1;
// Byte budget of one session's change records; the oldest turns go first.
const MAX_CHANGE_BYTES_PER_SESSION: usize = 32 * 1024 * 1024;
const MAX_CHANGE_RECORD_FILES: usize = 512;
const CHANGE_RECORD_TTL_MS: f64 = 30.0 * 24.0 * 60.0 * 60.0 * 1000.0;
const CHANGE_RECORDS_CACHE_SESSIONS: usize = 8;
const CHANGE_RECORDS_CACHE_BYTES: u64 = 64 * 1024 * 1024;

pub type Record = Obj;

mod changes;

pub use changes::SharedRecord;
#[cfg(test)]
pub(super) use changes::CHANGES_LOCK_WAIT;
use changes::ChangeCache;

fn root_key(value: &str) -> String {
    let trimmed = clean(value).trim_end_matches(['/', '\\']).to_owned();
    if cfg!(windows) { trimmed.to_lowercase() } else { trimmed }
}

pub(super) fn session_hash(session_id: &str) -> String {
    let digest = Sha256::digest(session_id.as_bytes());
    digest.iter().take(12).map(|b| format!("{b:02x}")).collect()
}

fn as_obj(value: &Value) -> Option<&Obj> {
    value.as_object()
}

fn obj_list(obj: &Obj, key: &str) -> Vec<Obj> {
    obj.get(key).and_then(Value::as_array).map(|a| a.iter().filter_map(|v| v.as_object().cloned()).collect()).unwrap_or_default()
}

#[derive(Clone)]
struct Scope {
    root: String,
    baseline_tree: String,
    tool_files: Vec<String>,
    baseline_files: IndexMap<String, Value>,
    updated_at: f64,
}

impl Scope {
    fn serialize(&self) -> Value {
        let mut o = Obj::new();
        o.insert("root".into(), Value::String(self.root.clone()));
        o.insert("baselineTree".into(), Value::String(self.baseline_tree.clone()));
        o.insert("toolFiles".into(), Value::Array(self.tool_files.iter().cloned().map(Value::String).collect()));
        o.insert("baselineFiles".into(), Value::Array(self.baseline_files.values().cloned().collect()));
        o.insert("updatedAt".into(), mixdog_js::json_number(self.updated_at));
        Value::Object(o)
    }
}

fn file_path_key(file: &Value) -> String {
    root_key(file.get("path").and_then(Value::as_str).unwrap_or(""))
}

/// Fold a turn's files into an existing scope: session-owned paths keep the baseline they first
/// recorded, and every tool-mutated path joins the owned set.
fn merge_scope_files(scope: &mut Scope, baseline_files: &[Value], tool_files: &[String]) {
    let owned: Vec<String> = scope.tool_files.iter().map(|p| root_key(p)).collect();
    for file in baseline_files {
        let key = file_path_key(file);
        if !owned.contains(&key) {
            scope.baseline_files.insert(key, file.clone());
        }
    }
    for file in tool_files {
        if !scope.tool_files.contains(file) {
            scope.tool_files.push(file.clone());
        }
    }
}

fn strings(value: Option<&Value>) -> Vec<String> {
    value
        .and_then(Value::as_array)
        .map(|a| a.iter().map(|v| clean(v.as_str().unwrap_or("")).to_owned()).filter(|s| !s.is_empty()).collect())
        .unwrap_or_default()
}

fn session_scopes(record: Option<&Obj>) -> Vec<Scope> {
    let mut scopes: Vec<Scope> = Vec::new();
    let mut add = |entry: &Obj| {
        let root = clean(obj_str(entry, "root"));
        let baseline_tree = clean(obj_str(entry, "baselineTree"));
        if root.is_empty() || baseline_tree.is_empty() {
            return;
        }
        let key = root_key(root);
        let files = strings(entry.get("toolFiles"));
        let baseline_files: Vec<Value> = entry.get("baselineFiles").and_then(Value::as_array).cloned().unwrap_or_default();
        let updated = {
            let n = obj_f64(entry, "updatedAt");
            if n.is_nan() { 0.0 } else { n }
        };
        if let Some(existing) = scopes.iter_mut().find(|s| root_key(&s.root) == key) {
            merge_scope_files(existing, &baseline_files, &files);
            existing.updated_at = existing.updated_at.max(updated);
            return;
        }
        let mut tool_files: Vec<String> = Vec::new();
        for f in files {
            if !tool_files.contains(&f) {
                tool_files.push(f);
            }
        }
        scopes.push(Scope {
            root: root.to_owned(),
            baseline_tree: baseline_tree.to_owned(),
            tool_files,
            baseline_files: baseline_files.iter().map(|f| (file_path_key(f), f.clone())).collect(),
            updated_at: updated,
        });
    };
    let stored = record.and_then(|r| r.get("sessionScopes")).and_then(Value::as_array).cloned().unwrap_or_default();
    if !stored.is_empty() {
        for scope in &stored {
            if let Some(o) = as_obj(scope) {
                add(o);
            }
        }
    } else {
        // Upgrade an existing v1 record lazily: its oldest retained turn is the earliest baseline
        // still available for this session and root.
        for turn in record.and_then(|r| r.get("turns")).and_then(Value::as_array).cloned().unwrap_or_default() {
            if let Some(o) = as_obj(&turn) {
                add(o);
            }
        }
    }
    scopes
}

/// The newest recorded turn's Git baseline (`loadTurnSnapshotRecord`) and the scopes.
pub struct Store {
    disk: Arc<dyn ReviewDisk>,
    root: PathBuf,
    chains: Arc<KeyedChains>,
    sweep_done: Mutex<(bool, bool)>,
    cache: Arc<Mutex<ChangeCache>>,
}

/// Oldest-first sweep of one record directory (`sweepDirectory`).
pub(super) async fn sweep_dir(disk: &dyn ReviewDisk, directory: &Path, ttl_ms: f64, max_files: usize) {
    let Ok(names) = disk.list(directory).await else { return };
    let now = disk.now_ms();
    let mut kept: Vec<(PathBuf, f64)> = Vec::new();
    for (name, stamp) in names {
        if !name.ends_with(".json") && !name.ends_with(".jsonl") {
            continue;
        }
        let path = directory.join(&name);
        if now - stamp.mtime_ms > ttl_ms {
            let _ = disk.remove(&path).await;
            continue;
        }
        kept.push((path, stamp.mtime_ms));
    }
    kept.sort_by(|a, b| a.1.partial_cmp(&b.1).unwrap_or(std::cmp::Ordering::Equal));
    let excess = kept.len().saturating_sub(max_files);
    for (path, _) in kept.into_iter().take(excess) {
        let _ = disk.remove(&path).await;
    }
}

impl Store {
    pub fn new(disk: Arc<dyn ReviewDisk>, data_dir: &Path) -> Self {
        Self {
            disk,
            root: data_dir.join("turn-snapshots"),
            chains: KeyedChains::new(),
            sweep_done: Mutex::new((false, false)),
            cache: Arc::new(Mutex::new(ChangeCache::default())),
        }
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    fn record_path(&self, session_id: &str) -> PathBuf {
        self.root.join(format!("{}.json", session_hash(session_id)))
    }

    fn changes_root(&self) -> PathBuf {
        self.root.join("changes")
    }

    // The appendable format lives in its own `.jsonl` file. The previous version parsed
    // `<hash>.json` as one JSON document, so it must never find appended lines there: after a
    // downgrade it sees no history (and writes its own file beside ours) instead of misreading and
    // overwriting what it cannot parse.
    fn changes_path(&self, session_id: &str) -> PathBuf {
        self.changes_root().join(format!("{}.jsonl", session_hash(session_id)))
    }

    /// The previous format's file, read as it is until the first write migrates it.
    fn legacy_changes_path(&self, session_id: &str) -> PathBuf {
        self.changes_root().join(format!("{}.json", session_hash(session_id)))
    }

    fn cleared_root(&self) -> PathBuf {
        self.root.join("cleared")
    }

    fn cleared_path(&self, session_id: &str) -> PathBuf {
        self.cleared_root().join(format!("{}.json", session_hash(session_id)))
    }

    fn legacy_summary_path(&self, session_id: &str) -> PathBuf {
        self.root.join("review-summaries").join(format!("{}.json", session_hash(session_id)))
    }

    /// Per-key write chain: two writes of one key never race their own file.
    async fn chained(&self, key: &str) -> ChainGuard {
        self.chains.acquire(key).await
    }

    /// Sessions with a write chain still held (tests).
    pub fn write_chain_count(&self) -> usize {
        self.chains.busy_keys()
    }

    async fn read_json(&self, path: &Path) -> Option<Value> {
        let bytes = self.disk.read(path).await.ok().flatten()?;
        serde_json::from_slice(&bytes).ok()
    }

    async fn read_record_file(&self, path: &Path) -> Option<Obj> {
        let parsed = self.read_json(path).await?;
        let obj = parsed.as_object()?;
        if obj.get("version").and_then(Value::as_u64) != Some(RECORD_VERSION) {
            return None;
        }
        if !obj.get("turns").is_some_and(Value::is_array) {
            return None;
        }
        Some(obj.clone())
    }

    /// Oldest-first sweep of one record directory so a long-lived install cannot accumulate
    /// records.
    pub async fn sweep_directory(&self, directory: &Path, ttl_ms: f64, max_files: usize) {
        sweep_dir(self.disk.as_ref(), directory, ttl_ms, max_files).await;
    }

    async fn sweep_records(&self) {
        {
            let mut done = self.sweep_done.lock().unwrap_or_else(|e| e.into_inner());
            if done.0 {
                return;
            }
            done.0 = true;
        }
        self.sweep_directory(&self.root, RECORD_TTL_MS, MAX_RECORD_FILES).await;
    }

    async fn write_json(&self, path: &Path, payload: &Value) -> std::io::Result<()> {
        self.disk.write_atomic(path, json_stringify(payload).into_bytes()).await
    }

    /// Fold one turn into a session's record. `generation` identifies the turn, so re-recording the
    /// same turn updates it in place rather than appending.
    pub async fn save_turn_snapshot_record(&self, session_id: &str, turn: &Obj) -> bool {
        let id = clean(session_id).to_owned();
        let baseline_tree = clean(obj_str(turn, "baselineTree")).to_owned();
        let root = clean(obj_str(turn, "root")).to_owned();
        if id.is_empty() || baseline_tree.is_empty() || root.is_empty() {
            return false;
        }
        let key = id.clone();
        let _guard = self.chained(&key).await;
        let saved = self.save_locked(&id, turn, &baseline_tree, &root).await.is_ok();
        drop(_guard);
        saved
    }

    async fn save_locked(&self, id: &str, turn: &Obj, baseline_tree: &str, root: &str) -> std::io::Result<()> {
        self.disk.create_dir_all(&self.root).await?;
        self.sweep_records().await;
        let path = self.record_path(id);
        let existing = self.read_record_file(&path).await;
        let generation = {
            let n = obj_f64(turn, "generation");
            if n.is_nan() { 0.0 } else { n }
        };
        let mut turns: Vec<Obj> = obj_list(existing.as_ref().unwrap_or(&Obj::new()), "turns")
            .into_iter()
            .filter(|entry| obj_f64(entry, "generation") != generation)
            .collect();
        let tool_files: Vec<String> = {
            let mut out: Vec<String> = Vec::new();
            for f in strings(turn.get("toolFiles")) {
                if !out.contains(&f) {
                    out.push(f);
                }
            }
            out
        };
        let baseline_files: Vec<Value> = turn.get("baselineFiles").and_then(Value::as_array).cloned().unwrap_or_default();
        let updated_at = self.disk.now_ms();
        let mut next_turn = Obj::new();
        next_turn.insert("generation".into(), mixdog_js::json_number(generation));
        next_turn.insert("checkpointId".into(), Value::String(clean(obj_str(turn, "checkpointId")).to_owned()));
        next_turn.insert("root".into(), Value::String(root.to_owned()));
        next_turn.insert("baselineTree".into(), Value::String(baseline_tree.to_owned()));
        next_turn.insert("baselineFiles".into(), Value::Array(baseline_files.clone()));
        // Relative, forward-slashed paths this session's own tools mutated.
        next_turn.insert("toolFiles".into(), Value::Array(tool_files.iter().cloned().map(Value::String).collect()));
        next_turn.insert("sealed".into(), Value::Bool(turn.get("sealed") == Some(&Value::Bool(true))));
        next_turn.insert("updatedAt".into(), mixdog_js::json_number(updated_at));
        turns.push(next_turn);
        turns.sort_by(|l, r| {
            let (a, b) = (obj_f64(l, "generation"), obj_f64(r, "generation"));
            let (a, b) = (if a.is_nan() { 0.0 } else { a }, if b.is_nan() { 0.0 } else { b });
            a.partial_cmp(&b).unwrap_or(std::cmp::Ordering::Equal)
        });
        let mut scopes = session_scopes(existing.as_ref());
        match scopes.iter_mut().find(|s| root_key(&s.root) == root_key(root)) {
            Some(scope) => {
                merge_scope_files(scope, &baseline_files, &tool_files);
                scope.updated_at = updated_at;
            }
            None => scopes.push(Scope {
                root: root.to_owned(),
                baseline_tree: baseline_tree.to_owned(),
                tool_files: tool_files.clone(),
                baseline_files: baseline_files.iter().map(|f| (file_path_key(f), f.clone())).collect(),
                updated_at,
            }),
        }
        scopes.sort_by(|l, r| l.updated_at.partial_cmp(&r.updated_at).unwrap_or(std::cmp::Ordering::Equal));
        let kept_scopes: Vec<Value> = scopes.iter().skip(scopes.len().saturating_sub(MAX_SESSION_SCOPES)).map(Scope::serialize).collect();
        let kept_turns: Vec<Value> = turns.iter().skip(turns.len().saturating_sub(MAX_TURNS_PER_SESSION)).cloned().map(Value::Object).collect();
        let mut payload = Obj::new();
        payload.insert("version".into(), Value::from(RECORD_VERSION));
        payload.insert("sessionId".into(), Value::String(id.to_owned()));
        payload.insert("turns".into(), Value::Array(kept_turns));
        payload.insert("sessionScopes".into(), Value::Array(kept_scopes));
        self.write_json(&path, &Value::Object(payload)).await?;
        self.end_cleared_history(id).await;
        Ok(())
    }

    /// The newest recorded turn that actually owns files. A turn that mutated nothing has nothing
    /// to revert, and returning it would hide the completed turn behind it.
    pub async fn load_turn_snapshot_record(&self, session_id: &str) -> Option<Obj> {
        let id = clean(session_id);
        if id.is_empty() {
            return None;
        }
        let record = self.read_record_file(&self.record_path(id)).await?;
        let turns = obj_list(&record, "turns");
        turns
            .into_iter()
            .rev()
            .find(|turn| !obj_str(turn, "baselineTree").is_empty() && !obj_str(turn, "root").is_empty() && turn.get("toolFiles").and_then(Value::as_array).is_some_and(|a| !a.is_empty()))
    }

    /// Earliest retained baseline plus every path attributed to this session, grouped by
    /// repository root.
    pub async fn load_session_snapshot_records(&self, session_id: &str) -> Vec<Value> {
        let id = clean(session_id);
        if id.is_empty() {
            return Vec::new();
        }
        let Some(record) = self.read_record_file(&self.record_path(id)).await else { return Vec::new() };
        session_scopes(Some(&record)).iter().map(Scope::serialize).collect()
    }

    /// Permanently delete one session's retained change history: its turn baselines and session
    /// scopes, and every per-turn change record. The cleared marker keeps the session review
    /// answering an authoritative empty set. Resolves to the number of turn change records
    /// deleted.
    pub async fn clear_session_change_history(&self, session_id: &str) -> std::io::Result<usize> {
        let id = clean(session_id).to_owned();
        if id.is_empty() {
            return Ok(0);
        }
        {
            let _guard = self.chained(&id).await;
            // The marker lands before the records go: a failure in between leaves the session
            // answering empty, never resurrecting what was asked gone.
            let result: std::io::Result<()> = async {
                self.disk.create_dir_all(&self.cleared_root()).await?;
                let mut marker = Obj::new();
                marker.insert("version".into(), Value::from(RECORD_VERSION));
                marker.insert("sessionId".into(), Value::String(id.clone()));
                marker.insert("clearedAt".into(), mixdog_js::json_number(self.disk.now_ms()));
                self.write_json(&self.cleared_path(&id), &Value::Object(marker)).await?;
                self.disk.remove(&self.legacy_summary_path(&id)).await?;
                self.disk.remove(&self.record_path(&id)).await
            }
            .await;
            drop(_guard);
            result?;
        }
        let key = format!("changes:{id}");
        let guard = self.chained(&key).await;
        let removed = self.clear_change_records(&id).await;
        drop(guard);
        removed
    }

    async fn end_cleared_history(&self, session_id: &str) {
        let _ = self.disk.remove(&self.cleared_path(session_id)).await;
    }

    /// The session's history was deleted and no turn has been recorded since.
    pub async fn session_change_history_cleared(&self, session_id: &str) -> bool {
        let id = clean(session_id);
        if id.is_empty() {
            return false;
        }
        self.read_json(&self.cleared_path(id)).await.and_then(|v| v.get("sessionId").and_then(Value::as_str).map(|s| s == id)).unwrap_or(false)
    }

    /// The session itself was deleted: its history marker goes with it.
    pub async fn forget_session_change_history_marker(&self, session_id: &str) {
        let id = clean(session_id).to_owned();
        if id.is_empty() {
            return;
        }
        let guard = self.chained(&id).await;
        let _ = self.disk.remove(&self.cleared_path(&id)).await;
        drop(guard);
    }
}
