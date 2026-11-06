//! The durable turn-snapshot index and the per-turn change records (Node
//! `turn-snapshot-store.mjs`), in Node's files under `<data>/turn-snapshots`: one JSON file per
//! session, named by the first 24 hex digits of the SHA-256 of the session id.
//!
//! - `<hash>.json`: the turns' Git baselines and the session scopes (the paths a session owns);
//! - `changes/<hash>.json`: every retained turn's frozen change record, with its own patches;
//! - `cleared/<hash>.json`: the "history deleted" marker.

use std::collections::HashMap;
use std::path::Path;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::Mutex;

use indexmap::IndexMap;
use mixdog_js::json_stringify;
use mixdog_js::locale_compare;
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

fn root_key(value: &str) -> String {
    let trimmed = clean(value).trim_end_matches(['/', '\\']).to_owned();
    if cfg!(windows) { trimmed.to_lowercase() } else { trimmed }
}

fn session_hash(session_id: &str) -> String {
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
    chains: Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>,
    sweep_done: Mutex<(bool, bool)>,
    cache: Mutex<ChangeCache>,
}

#[derive(Default)]
struct ChangeCache {
    order: Vec<String>,
    entries: HashMap<String, (String, u64, Arc<Vec<Record>>)>,
}

fn changes_file_ok(parsed: &Value, session_id: &str) -> Option<Obj> {
    let obj = parsed.as_object()?;
    if obj.get("version").and_then(Value::as_u64) != Some(CHANGES_VERSION) || obj.get("sessionId").and_then(Value::as_str) != Some(session_id) {
        return None;
    }
    if !obj.get("records").is_some_and(Value::is_array) {
        return None;
    }
    Some(obj.clone())
}

impl Store {
    pub fn new(disk: Arc<dyn ReviewDisk>, data_dir: &Path) -> Self {
        Self {
            disk,
            root: data_dir.join("turn-snapshots"),
            chains: Mutex::new(HashMap::new()),
            sweep_done: Mutex::new((false, false)),
            cache: Mutex::new(ChangeCache::default()),
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

    fn changes_path(&self, session_id: &str) -> PathBuf {
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
    async fn chained(&self, key: &str) -> tokio::sync::OwnedMutexGuard<()> {
        let cell = {
            let mut chains = self.chains.lock().unwrap_or_else(|e| e.into_inner());
            chains.entry(key.to_owned()).or_default().clone()
        };
        cell.lock_owned().await
    }

    fn release_chain(&self, key: &str) {
        // A settled chain with nothing queued behind it holds no order to keep.
        let mut chains = self.chains.lock().unwrap_or_else(|e| e.into_inner());
        if chains.get(key).is_some_and(|cell| Arc::strong_count(cell) == 1) {
            chains.remove(key);
        }
    }

    /// Sessions with a write chain still held (tests).
    pub fn write_chain_count(&self) -> usize {
        self.chains.lock().unwrap_or_else(|e| e.into_inner()).len()
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
        let Ok(names) = self.disk.list(directory).await else { return };
        let now = self.disk.now_ms();
        let mut kept: Vec<(PathBuf, f64)> = Vec::new();
        for (name, stamp) in names {
            if !name.ends_with(".json") {
                continue;
            }
            let path = directory.join(&name);
            if now - stamp.mtime_ms > ttl_ms {
                let _ = self.disk.remove(&path).await;
                continue;
            }
            kept.push((path, stamp.mtime_ms));
        }
        kept.sort_by(|a, b| a.1.partial_cmp(&b.1).unwrap_or(std::cmp::Ordering::Equal));
        let excess = kept.len().saturating_sub(max_files);
        for (path, _) in kept.into_iter().take(excess) {
            let _ = self.disk.remove(&path).await;
        }
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
        self.release_chain(&key);
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
            self.release_chain(&id);
            result?;
        }
        let key = format!("changes:{id}");
        let guard = self.chained(&key).await;
        let records = self.read_changes_file(&id).await.map(|f| obj_list(&f, "records").len()).unwrap_or(0);
        let removed = self.disk.remove(&self.changes_path(&id)).await;
        self.cache.lock().unwrap_or_else(|e| e.into_inner()).forget(&id);
        drop(guard);
        self.release_chain(&key);
        removed?;
        Ok(records)
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
        self.release_chain(&id);
    }

    // ── Per-turn change records ──────────────────────────────────────────────

    async fn parse_changes_file(&self, session_id: &str) -> std::io::Result<Option<Obj>> {
        let Some(bytes) = self.disk.read(&self.changes_path(session_id)).await? else {
            return Err(std::io::Error::from(std::io::ErrorKind::NotFound));
        };
        let parsed: Value = serde_json::from_slice(&bytes).map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;
        Ok(changes_file_ok(&parsed, session_id))
    }

    async fn read_changes_file(&self, session_id: &str) -> Option<Obj> {
        self.parse_changes_file(session_id).await.ok().flatten()
    }

    async fn write_change_records(&self, session_id: &str, records: &[Record]) -> std::io::Result<()> {
        self.cache.lock().unwrap_or_else(|e| e.into_inner()).forget(session_id);
        self.disk.create_dir_all(&self.changes_root()).await?;
        let sweep = {
            let mut done = self.sweep_done.lock().unwrap_or_else(|e| e.into_inner());
            let first = !done.1;
            done.1 = true;
            first
        };
        if sweep {
            self.sweep_directory(&self.changes_root(), CHANGE_RECORD_TTL_MS, MAX_CHANGE_RECORD_FILES).await;
        }
        let mut payload = Obj::new();
        payload.insert("version".into(), Value::from(CHANGES_VERSION));
        payload.insert("sessionId".into(), Value::String(session_id.to_owned()));
        payload.insert("records".into(), Value::Array(records.iter().cloned().map(Value::Object).collect()));
        let result = self.write_json(&self.changes_path(session_id), &Value::Object(payload)).await;
        // A read between the drop above and the rename may have cached the old file.
        self.cache.lock().unwrap_or_else(|e| e.into_inner()).forget(session_id);
        result
    }

    /// Upsert one turn's frozen changes. Every file of the new freeze is `applied`; a file the
    /// user had already undone and that the new net diff no longer contains keeps its `reverted`
    /// entry, so Reapply survives a re-seal. The revision bumps only when the record actually
    /// changed. Resolves to the stored record.
    pub async fn upsert_turn_change_record(&self, session_id: &str, next: &Obj) -> std::io::Result<Option<Record>> {
        let id = clean(session_id).to_owned();
        let checkpoint_id = clean(obj_str(next, "checkpointId")).to_owned();
        if id.is_empty() || checkpoint_id.is_empty() {
            return Ok(None);
        }
        let key = format!("changes:{id}");
        let guard = self.chained(&key).await;
        let result = self.upsert_locked(&id, &checkpoint_id, next).await;
        drop(guard);
        self.release_chain(&key);
        result
    }

    async fn upsert_locked(&self, id: &str, checkpoint_id: &str, next: &Obj) -> std::io::Result<Option<Record>> {
        let mut records = self.read_changes_file(id).await.map(|f| obj_list(&f, "records")).unwrap_or_default();
        let index = records.iter().position(|r| r.get("checkpointId").and_then(Value::as_str) == Some(checkpoint_id));
        let prior = index.map(|i| records[i].clone());
        let mut files: Vec<Obj> = obj_list(next, "files")
            .into_iter()
            .map(|mut file| {
                file.insert("state".into(), Value::String("applied".into()));
                file
            })
            .collect();
        let present: Vec<String> = files.iter().map(|f| root_key(obj_str(f, "path"))).collect();
        for file in prior.as_ref().map(|p| obj_list(p, "files")).unwrap_or_default() {
            if obj_str(&file, "state") == "reverted" && !present.contains(&root_key(obj_str(&file, "path"))) {
                files.push(file);
            }
        }
        files.sort_by(|l, r| locale_compare(obj_str(l, "path"), obj_str(r, "path")));
        let kind = match clean(obj_str(next, "kind")) {
            "" => "git",
            other => other,
        };
        let mut candidate = Obj::new();
        candidate.insert("checkpointId".into(), Value::String(checkpoint_id.to_owned()));
        candidate.insert("kind".into(), Value::String(kind.to_owned()));
        candidate.insert("root".into(), Value::String(clean(obj_str(next, "root")).to_owned()));
        candidate.insert("agents".into(), Value::Array(next.get("agents").and_then(Value::as_array).cloned().unwrap_or_default()));
        // `own`: each file's patch is the session's own tool writes (first before to last after,
        // raw bytes) and its counts their summed deltas; an older record without it holds the net
        // worktree diff and counts.
        if !clean(obj_str(next, "counts")).is_empty() {
            candidate.insert("counts".into(), Value::String(clean(obj_str(next, "counts")).to_owned()));
        }
        candidate.insert("files".into(), Value::Array(files.into_iter().map(Value::Object).collect()));
        // View-only edits outside the root of a Git turn: never undone or replayed, listed only by
        // the session review.
        let outside = next.get("outside").and_then(Value::as_array).cloned().unwrap_or_default();
        if !outside.is_empty() {
            candidate.insert("outside".into(), Value::Array(outside));
        }
        if let Some(prior) = &prior {
            if change_content(prior) == change_content(&candidate) {
                return Ok(Some(prior.clone()));
            }
        }
        let now = self.disk.now_ms();
        let mut record = candidate;
        let prior_revision = prior.as_ref().map_or(0.0, |p| {
            let n = obj_f64(p, "revision");
            if n.is_nan() { 0.0 } else { n }
        });
        record.insert("revision".into(), mixdog_js::json_number(prior_revision + 1.0));
        let created = prior.as_ref().map_or(0.0, |p| {
            let n = obj_f64(p, "createdAt");
            if n.is_nan() { 0.0 } else { n }
        });
        record.insert("createdAt".into(), mixdog_js::json_number(if created != 0.0 { created } else { now }));
        record.insert("updatedAt".into(), mixdog_js::json_number(now));
        match index {
            Some(i) => records[i] = record,
            None => records.push(record),
        }
        bound_change_records(&mut records, checkpoint_id);
        self.write_change_records(id, &records).await?;
        // Any new turn record (Git or not) starts the history again.
        self.end_cleared_history(id).await;
        Ok(records.into_iter().find(|r| r.get("checkpointId").and_then(Value::as_str) == Some(checkpoint_id)))
    }

    /// Apply `mutate(record)` (returning the next files, or `None` for no change) and bump the
    /// revision. Serialized with every other write of the session.
    pub async fn update_turn_change_record(
        &self,
        session_id: &str,
        checkpoint_id: &str,
        mutate: impl FnOnce(&Record) -> Option<Vec<Obj>>,
    ) -> std::io::Result<Option<Record>> {
        let id = clean(session_id).to_owned();
        let key = clean(checkpoint_id).to_owned();
        if id.is_empty() || key.is_empty() {
            return Ok(None);
        }
        let chain_key = format!("changes:{id}");
        let guard = self.chained(&chain_key).await;
        let result = async {
            let mut records = self.read_changes_file(&id).await.map(|f| obj_list(&f, "records")).unwrap_or_default();
            let Some(index) = records.iter().position(|r| r.get("checkpointId").and_then(Value::as_str) == Some(key.as_str())) else {
                return Ok(None);
            };
            let Some(files) = mutate(&records[index]) else { return Ok(Some(records[index].clone())) };
            let record = &mut records[index];
            record.insert("files".into(), Value::Array(files.into_iter().map(Value::Object).collect()));
            let revision = {
                let n = obj_f64(record, "revision");
                if n.is_nan() { 0.0 } else { n }
            };
            record.insert("revision".into(), mixdog_js::json_number(revision + 1.0));
            record.insert("updatedAt".into(), mixdog_js::json_number(self.disk.now_ms()));
            let updated = record.clone();
            self.write_change_records(&id, &records).await?;
            Ok(Some(updated))
        }
        .await;
        drop(guard);
        self.release_chain(&chain_key);
        result
    }

    /// One turn's change record by its exact checkpoint id; never a fallback.
    pub async fn load_turn_change_record(&self, session_id: &str, checkpoint_id: &str) -> Option<Record> {
        let id = clean(session_id);
        let key = clean(checkpoint_id);
        if id.is_empty() || key.is_empty() {
            return None;
        }
        let records = self.load_turn_change_records(id).await;
        records.iter().find(|r| r.get("checkpointId").and_then(Value::as_str) == Some(key)).cloned()
    }

    /// Every retained turn's change record of a session, oldest first. Parsed records are cached
    /// while the file's mtime and size are unchanged.
    pub async fn load_turn_change_records(&self, session_id: &str) -> Arc<Vec<Record>> {
        let id = clean(session_id);
        if id.is_empty() {
            return Arc::new(Vec::new());
        }
        let stamp = match self.disk.stat(&self.changes_path(id)).await {
            Ok(Some(stamp)) => stamp,
            _ => {
                self.cache.lock().unwrap_or_else(|e| e.into_inner()).forget(id);
                return Arc::new(Vec::new());
            }
        };
        let signature = format!("{}:{}", mixdog_js::number_to_string(stamp.mtime_ms), stamp.size);
        if let Some(hit) = self.cache.lock().unwrap_or_else(|e| e.into_inner()).hit(id, &signature) {
            return hit;
        }
        let Ok(Some(file)) = self.parse_changes_file(id).await else {
            // A failed read is not remembered: the next call reads the file again.
            return Arc::new(Vec::new());
        };
        let mut records = obj_list(&file, "records");
        records.sort_by(|l, r| {
            let (a, b) = (obj_f64(l, "createdAt"), obj_f64(r, "createdAt"));
            let (a, b) = (if a.is_nan() { 0.0 } else { a }, if b.is_nan() { 0.0 } else { b });
            a.partial_cmp(&b).unwrap_or(std::cmp::Ordering::Equal)
        });
        let records = Arc::new(records);
        self.cache.lock().unwrap_or_else(|e| e.into_inner()).put(id, signature, stamp.size, records.clone());
        records
    }
}

impl ChangeCache {
    fn forget(&mut self, id: &str) {
        self.entries.remove(id);
        self.order.retain(|k| k != id);
    }

    fn hit(&mut self, id: &str, signature: &str) -> Option<Arc<Vec<Record>>> {
        let (sig, _, records) = self.entries.get(id)?;
        if sig != signature {
            self.forget(id);
            return None;
        }
        let records = records.clone();
        self.order.retain(|k| k != id);
        self.order.push(id.to_owned());
        Some(records)
    }

    fn put(&mut self, id: &str, signature: String, bytes: u64, records: Arc<Vec<Record>>) {
        self.forget(id);
        self.entries.insert(id.to_owned(), (signature, bytes, records));
        self.order.push(id.to_owned());
        // Least recently used first; bounded by session count and by the summed file bytes (the
        // newest entry always stays, however large).
        loop {
            let total: u64 = self.entries.values().map(|(_, b, _)| *b).sum();
            if self.order.len() > 1 && (self.order.len() > CHANGE_RECORDS_CACHE_SESSIONS || total > CHANGE_RECORDS_CACHE_BYTES) {
                let oldest = self.order.remove(0);
                self.entries.remove(&oldest);
            } else {
                break;
            }
        }
    }
}

fn change_content(record: &Obj) -> String {
    let get = |key: &str| record.get(key).cloned().unwrap_or(Value::Array(Vec::new()));
    let counts = match record.get("counts") {
        Some(v) if super::patch::is_truthy(v) => v.clone(),
        _ => Value::String(String::new()),
    };
    json_stringify(&Value::Array(vec![
        record.get("kind").cloned().unwrap_or(Value::Null),
        record.get("root").cloned().unwrap_or(Value::Null),
        counts,
        match record.get("agents") {
            Some(v) if super::patch::is_truthy(v) => v.clone(),
            _ => Value::Array(Vec::new()),
        },
        get("files"),
        get("outside"),
    ]))
}

fn weight(file: &Obj) -> usize {
    ["patch", "viewPatch"].iter().map(|key| file.get(*key).and_then(Value::as_str).map_or(0, str::len)).sum()
}

/// Evict the oldest turns until the session fits its byte budget; a turn that alone exceeds it
/// drops its largest patches (those files stop being revertable) instead of the whole record.
fn bound_change_records(records: &mut Vec<Record>, keep_checkpoint_id: &str) {
    let size_of = |record: &Record| json_stringify(&Value::Object(record.clone())).len();
    let mut sizes: Vec<usize> = records.iter().map(size_of).collect();
    let mut total: usize = sizes.iter().sum();
    let mut index = 0usize;
    while total > MAX_CHANGE_BYTES_PER_SESSION && index < records.len() {
        if records[index].get("checkpointId").and_then(Value::as_str) == Some(keep_checkpoint_id) {
            index += 1;
            continue;
        }
        total -= sizes[index];
        records.remove(index);
        sizes.remove(index);
    }
    if total <= MAX_CHANGE_BYTES_PER_SESSION {
        return;
    }
    let Some(kept) = records.iter_mut().find(|r| r.get("checkpointId").and_then(Value::as_str) == Some(keep_checkpoint_id)) else { return };
    // Replay patches and display patches share one budget, measured in UTF-8 bytes.
    let mut targets: Vec<(&'static str, usize, usize)> = Vec::new();
    for list in ["files", "outside"] {
        if let Some(files) = kept.get(list).and_then(Value::as_array) {
            for (i, file) in files.iter().enumerate() {
                if let Some(o) = file.as_object() {
                    let w = weight(o);
                    if w > 0 {
                        targets.push((list, i, w));
                    }
                }
            }
        }
    }
    targets.sort_by(|a, b| b.2.cmp(&a.2));
    for (list, i, w) in targets {
        if total <= MAX_CHANGE_BYTES_PER_SESSION {
            break;
        }
        total -= w;
        if let Some(file) = kept.get_mut(list).and_then(Value::as_array_mut).and_then(|a| a[i].as_object_mut()) {
            file.insert("patch".into(), Value::Null);
            file.shift_remove("patchEncoding");
            file.shift_remove("viewPatch");
            file.insert("revertable".into(), Value::Bool(false));
            file.insert("reason".into(), Value::String("change is too large to keep for undo".into()));
            file.insert("patchOmitted".into(), Value::Bool(true));
        }
    }
}
