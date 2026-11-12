//! The per-turn change records (Node `turn-snapshot-store.mjs`, "Per-turn change records"), in the
//! files Node writes: `changes/<hash>.jsonl`, and the previous format's `changes/<hash>.json`, read
//! as it is until the first write migrates it.
//!
//! A `.jsonl` file is one JSON line of records (what a whole write produces) optionally followed by
//! delta lines, each starting on a new line: `{"put":record,"evict":[checkpointIds]}`, the turn's
//! record and the turns its upsert evicts. An upsert appends its one line instead of rewriting the
//! session's history; the file is rewritten whole only once its superseded bytes outgrow the live
//! ones. A line that does not parse (a torn tail, or damage in the middle) is skipped on purpose: it
//! costs that one upsert, where failing the read would hide every other turn too.
//!
//! Every writer of a session's file (this process's write chain, and Node or another core through
//! `changes/<hash>.lock`) is held off while a write reads the file's state and lands its line.

use std::collections::HashMap;
use std::io;
use std::path::Path;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::Mutex;

use indexmap::IndexMap;
use mixdog_js::json_stringify;
use mixdog_js::locale_compare;
use mixdog_js::number_to_string;
use serde_json::Value;
use serde_json::value::RawValue;

use super::super::patch::clean;
use super::super::patch::is_truthy;
use super::super::patch::obj_f64;
use super::super::patch::obj_str;
use super::super::ports::BlockingFs;
use super::super::ports::FileStamp;
use super::super::ports::ReadFs;
use super::super::review_diff::Obj;
use super::CHANGES_VERSION;
use super::CHANGE_RECORDS_CACHE_BYTES;
use super::CHANGE_RECORDS_CACHE_SESSIONS;
use super::CHANGE_RECORD_TTL_MS;
use super::MAX_CHANGE_BYTES_PER_SESSION;
use super::MAX_CHANGE_RECORD_FILES;
use super::Record;
use super::Store;
use super::obj_list;
use super::root_key;
use super::session_hash;

/// A stored record is shared, never copied, between the cache and its readers.
pub type SharedRecord = Arc<Record>;

/// Below this many superseded bytes the file is never rewritten.
const COMPACT_DEAD_FLOOR_BYTES: usize = 1024 * 1024;

#[derive(Clone)]
struct Entry {
    record: SharedRecord,
    /// The record's JSON bytes as they stand in the file.
    bytes: usize,
}

/// One session's parsed changes file.
#[derive(Clone, Default)]
pub(super) struct ChangeState {
    /// By checkpoint, in file order.
    records: IndexMap<String, Entry>,
    /// The summed JSON bytes of `records`.
    live: usize,
    /// Superseded bytes still in the file.
    dead: usize,
    /// Whether it came from the appendable file; the first write of any other state writes whole.
    stored: bool,
    /// The size of the file bytes this state describes.
    file_size: u64,
}

#[derive(Default)]
pub(super) struct ChangeCache {
    order: Vec<String>,
    entries: HashMap<String, (String, u64, Arc<ChangeState>)>,
}

impl ChangeCache {
    pub(super) fn forget(&mut self, id: &str) {
        self.entries.remove(id);
        self.order.retain(|k| k != id);
    }

    fn hit(&mut self, id: &str, signature: &str) -> Option<Arc<ChangeState>> {
        let (sig, _, state) = self.entries.get(id)?;
        if sig != signature {
            self.forget(id);
            return None;
        }
        let state = state.clone();
        self.order.retain(|k| k != id);
        self.order.push(id.to_owned());
        Some(state)
    }

    fn put(&mut self, id: &str, signature: String, bytes: u64, state: Arc<ChangeState>) {
        self.forget(id);
        self.entries.insert(id.to_owned(), (signature, bytes, state));
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

/// Where one session's changes live, and the cache every read and write of it goes through.
#[derive(Clone)]
struct Ctx {
    id: String,
    jsonl: PathBuf,
    legacy: PathBuf,
    cache: Arc<Mutex<ChangeCache>>,
}

/// How long a writer waits for a session's `changes/<hash>.lock` (`timeoutMs: 30_000` of `changesExclusive`,
/// `turn-snapshot-store.mjs`); a write that cannot take it in that time fails and stores nothing.
pub(crate) const CHANGES_LOCK_WAIT: std::time::Duration = std::time::Duration::from_millis(30_000);

impl Ctx {
    fn cache(&self) -> std::sync::MutexGuard<'_, ChangeCache> {
        self.cache.lock().unwrap_or_else(|e| e.into_inner())
    }
}

type Raw = HashMap<String, Box<RawValue>>;

fn invalid(error: serde_json::Error) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, error)
}

fn record_of(text: &str) -> Option<(String, Obj)> {
    let Value::Object(record) = serde_json::from_str::<Value>(text).ok()? else { return None };
    let id = record.get("checkpointId")?.as_str()?.to_owned();
    Some((id, record))
}

fn record_bytes(record: &Obj) -> usize {
    json_stringify(&Value::Object(record.clone())).len()
}

/// The state a changes file holds. `None` when it is not a changes file of this session; an
/// unparsable one is an error.
fn parse_changes(bytes: &[u8], session_id: &str, stored: bool) -> io::Result<Option<ChangeState>> {
    let cut = bytes.iter().position(|b| *b == b'\n');
    let base: Raw = serde_json::from_slice(&bytes[..cut.unwrap_or(bytes.len())]).map_err(invalid)?;
    if base.get("version").and_then(|v| v.get().trim().parse::<u64>().ok()) != Some(CHANGES_VERSION) {
        return Ok(None);
    }
    if base.get("sessionId").and_then(|v| serde_json::from_str::<String>(v.get()).ok()).as_deref() != Some(session_id) {
        return Ok(None);
    }
    let Some(raws) = base.get("records").and_then(|v| serde_json::from_str::<Vec<Box<RawValue>>>(v.get()).ok()) else { return Ok(None) };
    let mut state = ChangeState { stored, file_size: bytes.len() as u64, ..ChangeState::default() };
    for raw in &raws {
        if let Some((id, record)) = record_of(raw.get()) {
            state.records.insert(id, Entry { record: Arc::new(record), bytes: raw.get().len() });
        }
    }
    state.live = state.records.values().map(|e| e.bytes).sum();
    let Some(cut) = cut else { return Ok(Some(state)) };
    for line in bytes[cut + 1..].split(|b| *b == b'\n') {
        if line.is_empty() {
            continue;
        }
        let Ok(item) = serde_json::from_slice::<Raw>(line) else { continue };
        let Some(put) = item.get("put") else { continue };
        let Some((id, record)) = record_of(put.get()) else { continue };
        let Some(evict) = item.get("evict").and_then(|v| serde_json::from_str::<Vec<Value>>(v.get()).ok()) else { continue };
        for gone in evict.iter().filter_map(Value::as_str) {
            if let Some(old) = state.records.shift_remove(gone) {
                state.live -= old.bytes;
                state.dead += old.bytes;
            }
        }
        if let Some(old) = state.records.get(&id) {
            state.live -= old.bytes;
            state.dead += old.bytes;
        }
        state.live += put.get().len();
        state.records.insert(id, Entry { record: Arc::new(record), bytes: put.get().len() });
    }
    Ok(Some(state))
}

fn signature(path: &Path, stamp: &FileStamp) -> String {
    format!("{}:{}:{}", path.display(), number_to_string(stamp.mtime_ms), stamp.size)
}

/// The session's cached changes state, or `None` when it has none readable. Valid while the
/// file's mtime and size are unchanged: the session review and every turn card read the same
/// multi-megabyte file and must not read and parse it each time.
fn load_state<F: ReadFs + ?Sized>(fs: &F, ctx: &Ctx) -> Option<Arc<ChangeState>> {
    let (path, stored, stamp) = match fs.stat(&ctx.jsonl) {
        Ok(Some(stamp)) => (&ctx.jsonl, true, stamp),
        _ => match fs.stat(&ctx.legacy) {
            Ok(Some(stamp)) => (&ctx.legacy, false, stamp),
            _ => {
                ctx.cache().forget(&ctx.id);
                return None;
            }
        },
    };
    let signature = signature(path, &stamp);
    if let Some(hit) = ctx.cache().hit(&ctx.id, &signature) {
        return Some(hit);
    }
    // A failed read is not remembered: the next call reads the file again.
    let bytes = fs.read(path).ok().flatten()?;
    let state = Arc::new(parse_changes(&bytes, &ctx.id, stored).ok().flatten()?);
    ctx.cache().put(&ctx.id, signature, stamp.size, state.clone());
    Some(state)
}

fn created_at(record: &Obj) -> f64 {
    let n = obj_f64(record, "createdAt");
    if n.is_nan() { 0.0 } else { n }
}

fn change_content(record: &Obj) -> String {
    let get = |key: &str| record.get(key).cloned().unwrap_or(Value::Array(Vec::new()));
    let counts = match record.get("counts") {
        Some(v) if is_truthy(v) => v.clone(),
        _ => Value::String(String::new()),
    };
    json_stringify(&Value::Array(vec![
        record.get("kind").cloned().unwrap_or(Value::Null),
        record.get("root").cloned().unwrap_or(Value::Null),
        counts,
        match record.get("agents") {
            Some(v) if is_truthy(v) => v.clone(),
            _ => Value::Array(Vec::new()),
        },
        get("files"),
        get("outside"),
    ]))
}

fn weight(file: &Obj) -> usize {
    ["patch", "viewPatch"].iter().map(|key| file.get(*key).and_then(Value::as_str).map_or(0, str::len)).sum()
}

/// What it takes to store `record` (replacing `prior_bytes` of its checkpoint's earlier record)
/// within the session's byte budget: the oldest other turns to evict until it fits; a turn that
/// alone exceeds the budget drops its largest patches (those files stop being revertable) instead
/// of the whole record.
fn bound_change_record(state: &ChangeState, mut record: Obj, prior_bytes: usize) -> (Obj, Vec<(String, usize)>) {
    let keep = obj_str(&record, "checkpointId").to_owned();
    let mut total = (state.live + record_bytes(&record)).saturating_sub(prior_bytes);
    let mut evict = Vec::new();
    for (id, entry) in &state.records {
        if total <= MAX_CHANGE_BYTES_PER_SESSION {
            break;
        }
        if *id == keep {
            continue;
        }
        total -= entry.bytes;
        evict.push((id.clone(), entry.bytes));
    }
    if total <= MAX_CHANGE_BYTES_PER_SESSION {
        return (record, evict);
    }
    // Replay patches and display patches share one budget, measured in UTF-8 bytes.
    let mut targets: Vec<(&'static str, usize, usize)> = Vec::new();
    for list in ["files", "outside"] {
        if let Some(files) = record.get(list).and_then(Value::as_array) {
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
    targets.sort_by_key(|t| std::cmp::Reverse(t.2));
    for (list, i, w) in targets {
        if total <= MAX_CHANGE_BYTES_PER_SESSION {
            break;
        }
        total -= w;
        if let Some(file) = record.get_mut(list).and_then(Value::as_array_mut).and_then(|a| a[i].as_object_mut()) {
            file.insert("patch".into(), Value::Null);
            file.shift_remove("patchEncoding");
            file.shift_remove("viewPatch");
            file.insert("revertable".into(), Value::Bool(false));
            file.insert("reason".into(), Value::String("change is too large to keep for undo".into()));
            file.insert("patchOmitted".into(), Value::Bool(true));
        }
    }
    (record, evict)
}

/// The whole file: one line of every record.
fn whole_file(session_id: &str, records: &IndexMap<String, Entry>) -> String {
    let mut text = format!("{{\"version\":{CHANGES_VERSION},\"sessionId\":{},\"records\":[", json_stringify(&Value::String(session_id.to_owned())));
    for (i, entry) in records.values().enumerate() {
        if i > 0 {
            text.push(',');
        }
        text.push_str(&json_stringify(&Value::Object((*entry.record).clone())));
    }
    text.push_str("]}");
    text
}

/// Store one turn's `record` (replacing `prior_bytes` of its checkpoint's earlier one) and evict
/// `evict`: appended to the file, or the file rewritten when it holds no valid state yet or its
/// dead bytes outgrew the live ones. The cached state follows the file, so the next read parses
/// nothing. The caller holds the session's cross-process lock.
fn store_change_record(fs: &dyn BlockingFs, ctx: &Ctx, state: &ChangeState, record: Obj, prior_bytes: usize, evict: Vec<(String, usize)>) -> io::Result<SharedRecord> {
    let id = obj_str(&record, "checkpointId").to_owned();
    let line = json_stringify(&Value::Object(record.clone()));
    let evicted_bytes: usize = evict.iter().map(|(_, size)| size).sum();
    let live = state.live.saturating_sub(prior_bytes + evicted_bytes) + line.len();
    let dead = state.dead + prior_bytes + evicted_bytes;
    let stored: SharedRecord = Arc::new(record);
    let mut records = state.records.clone();
    for (gone, _) in &evict {
        records.shift_remove(gone);
    }
    records.insert(id, Entry { record: stored.clone(), bytes: line.len() });
    ctx.cache().forget(&ctx.id);
    if !state.stored || dead > (live / 2).max(COMPACT_DEAD_FLOOR_BYTES) {
        fs.write_atomic(&ctx.jsonl, whole_file(&ctx.id, &records).as_bytes(), false, true)?;
        // The previous format's file is superseded; leaving it would let a downgrade resurrect an
        // old history and a later upgrade never read it again.
        fs.remove(&ctx.legacy)?;
        return Ok(stored);
    }
    // One line, one write: the record and its evictions become visible together or (a torn last
    // line is skipped on read) not at all. The line is read back, and an upsert that cannot show
    // its whole line in the file fails (and cuts it away) instead of reporting success.
    let ids = Value::Array(evict.iter().map(|(gone, _)| Value::String(gone.clone())).collect());
    let text = format!("\n{{\"put\":{line},\"evict\":{}}}", json_stringify(&ids));
    let done = fs.append_verified(&ctx.jsonl, text.as_bytes())?;
    // Cache what was written only if the file is exactly the one read plus these bytes: any other
    // writer in between changes the size, and then the next read parses the file instead.
    if done.prior_size == state.file_size && done.stamp.size == state.file_size + text.len() as u64 {
        let next = ChangeState { records, live, dead, stored: true, file_size: done.stamp.size };
        ctx.cache().put(&ctx.id, signature(&ctx.jsonl, &done.stamp), done.stamp.size, Arc::new(next));
    }
    Ok(stored)
}

/// The record the next freeze of a turn stores: every file `applied`; a file the user had already
/// undone and that the new net diff no longer contains keeps its `reverted` entry, so Reapply
/// survives a re-seal.
fn candidate_of(prior: Option<&Obj>, checkpoint_id: &str, next: &Obj) -> Obj {
    let mut files: Vec<Obj> = obj_list(next, "files")
        .into_iter()
        .map(|mut file| {
            file.insert("state".into(), Value::String("applied".into()));
            file
        })
        .collect();
    let present: Vec<String> = files.iter().map(|f| root_key(obj_str(f, "path"))).collect();
    for file in prior.map(|p| obj_list(p, "files")).unwrap_or_default() {
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
    candidate
}

fn number(record: &Obj, key: &str) -> f64 {
    let n = obj_f64(record, key);
    if n.is_nan() { 0.0 } else { n }
}

fn upsert_sync(fs: &dyn BlockingFs, ctx: &Ctx, checkpoint_id: &str, next: &Obj, now: f64) -> io::Result<(Record, bool)> {
    let state = load_state(fs, ctx).unwrap_or_default();
    let prior = state.records.get(checkpoint_id);
    let candidate = candidate_of(prior.map(|e| &*e.record), checkpoint_id, next);
    if let Some(prior) = prior
        && change_content(&prior.record) == change_content(&candidate)
    {
        return Ok(((*prior.record).clone(), false));
    }
    let mut record = candidate;
    let prior_record = prior.map(|e| &*e.record);
    record.insert("revision".into(), mixdog_js::json_number(prior_record.map_or(0.0, |p| number(p, "revision")) + 1.0));
    let created = prior_record.map_or(0.0, |p| number(p, "createdAt"));
    record.insert("createdAt".into(), mixdog_js::json_number(if created != 0.0 { created } else { now }));
    record.insert("updatedAt".into(), mixdog_js::json_number(now));
    let prior_bytes = prior.map_or(0, |e| e.bytes);
    let (record, evict) = bound_change_record(&state, record, prior_bytes);
    let stored = store_change_record(fs, ctx, &state, record, prior_bytes, evict)?;
    Ok(((*stored).clone(), true))
}

fn update_sync(fs: &dyn BlockingFs, ctx: &Ctx, checkpoint_id: &str, mutate: impl FnOnce(&Record) -> Option<Vec<Obj>>, now: f64) -> io::Result<Option<Record>> {
    let Some(state) = load_state(fs, ctx) else { return Ok(None) };
    let Some(prior) = state.records.get(checkpoint_id) else { return Ok(None) };
    let Some(files) = mutate(&prior.record) else { return Ok(Some((*prior.record).clone())) };
    let mut record = (*prior.record).clone();
    record.insert("files".into(), Value::Array(files.into_iter().map(Value::Object).collect()));
    record.insert("revision".into(), mixdog_js::json_number(number(&record, "revision") + 1.0));
    record.insert("updatedAt".into(), mixdog_js::json_number(now));
    let stored = store_change_record(fs, ctx, &state, record, prior.bytes, Vec::new())?;
    Ok(Some((*stored).clone()))
}

fn clear_sync(fs: &dyn BlockingFs, ctx: &Ctx) -> io::Result<usize> {
    let count = load_state(fs, ctx).map_or(0, |state| state.records.len());
    let removed = fs.remove(&ctx.jsonl).and_then(|()| fs.remove(&ctx.legacy));
    ctx.cache().forget(&ctx.id);
    removed?;
    Ok(count)
}

impl Store {
    fn changes_ctx(&self, id: &str) -> Ctx {
        Ctx { id: id.to_owned(), jsonl: self.changes_path(id), legacy: self.legacy_changes_path(id), cache: self.cache.clone() }
    }

    async fn read_job<R: Send + 'static>(&self, job: impl FnOnce(&dyn ReadFs) -> R + Send + 'static) -> io::Result<R> {
        let slot: Arc<Mutex<Option<R>>> = Arc::new(Mutex::new(None));
        let put = slot.clone();
        self.disk.blocking_read(Box::new(move |fs| *put.lock().unwrap_or_else(|e| e.into_inner()) = Some(job(fs)))).await?;
        let taken = slot.lock().unwrap_or_else(|e| e.into_inner()).take();
        taken.ok_or_else(|| io::Error::other("file job did not run"))
    }

    /// Runs `job` with every other writer of the session's changes files held off: the file lock
    /// `changes/<hash>.lock`, the one Node takes.
    async fn locked_job<R: Send + 'static>(&self, id: &str, job: impl FnOnce(&dyn BlockingFs) -> R + Send + 'static) -> io::Result<R> {
        let slot: Arc<Mutex<Option<R>>> = Arc::new(Mutex::new(None));
        let put = slot.clone();
        let lock = self.changes_root().join(session_hash(id));
        self.disk.blocking(Some((&lock, CHANGES_LOCK_WAIT)), Box::new(move |fs| *put.lock().unwrap_or_else(|e| e.into_inner()) = Some(job(fs)))).await?;
        let taken = slot.lock().unwrap_or_else(|e| e.into_inner()).take();
        taken.ok_or_else(|| io::Error::other("file job did not run"))
    }

    async fn prepare_changes_dir(&self) -> io::Result<()> {
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
        Ok(())
    }

    /// Delete one session's change records (both formats); the number of turns they held.
    pub(super) async fn clear_change_records(&self, id: &str) -> io::Result<usize> {
        self.disk.create_dir_all(&self.changes_root()).await?;
        let ctx = self.changes_ctx(id);
        self.locked_job(id, move |fs| clear_sync(fs, &ctx)).await?
    }

    /// Upsert one turn's frozen changes. Every file of the new freeze is `applied`; a file the
    /// user had already undone and that the new net diff no longer contains keeps its `reverted`
    /// entry, so Reapply survives a re-seal. The revision bumps only when the record actually
    /// changed. Resolves to the stored record.
    pub async fn upsert_turn_change_record(&self, session_id: &str, next: &Obj) -> io::Result<Option<Record>> {
        let id = clean(session_id).to_owned();
        let checkpoint_id = clean(obj_str(next, "checkpointId")).to_owned();
        if id.is_empty() || checkpoint_id.is_empty() {
            return Ok(None);
        }
        let guard = self.chained(&format!("changes:{id}")).await;
        let result = async {
            self.prepare_changes_dir().await?;
            let (ctx, next, now) = (self.changes_ctx(&id), next.clone(), self.disk.now_ms());
            let (stored, wrote) = self.locked_job(&id, move |fs| upsert_sync(fs, &ctx, &checkpoint_id, &next, now)).await??;
            if wrote {
                // Any new turn record (Git or not) starts the history again.
                self.end_cleared_history(&id).await;
            }
            Ok(Some(stored))
        }
        .await;
        drop(guard);
        result
    }

    /// Apply `mutate(record)` (returning the next files, or `None` for no change) and bump the
    /// revision. Serialized with every other write of the session.
    pub async fn update_turn_change_record(
        &self,
        session_id: &str,
        checkpoint_id: &str,
        mutate: impl FnOnce(&Record) -> Option<Vec<Obj>> + Send + 'static,
    ) -> io::Result<Option<Record>> {
        let id = clean(session_id).to_owned();
        let key = clean(checkpoint_id).to_owned();
        if id.is_empty() || key.is_empty() {
            return Ok(None);
        }
        let guard = self.chained(&format!("changes:{id}")).await;
        let result = async {
            self.prepare_changes_dir().await?;
            let (ctx, now) = (self.changes_ctx(&id), self.disk.now_ms());
            self.locked_job(&id, move |fs| update_sync(fs, &ctx, &key, mutate, now)).await?
        }
        .await;
        drop(guard);
        result
    }

    async fn change_state(&self, id: &str) -> Option<Arc<ChangeState>> {
        let ctx = self.changes_ctx(id);
        self.read_job(move |fs| load_state(fs, &ctx)).await.ok().flatten()
    }

    /// One turn's change record by its exact checkpoint id; never a fallback.
    pub async fn load_turn_change_record(&self, session_id: &str, checkpoint_id: &str) -> Option<Record> {
        let id = clean(session_id);
        let key = clean(checkpoint_id);
        if id.is_empty() || key.is_empty() {
            return None;
        }
        self.change_state(id).await?.records.get(key).map(|e| (*e.record).clone())
    }

    /// Every retained turn's change record of a session, oldest first.
    pub async fn load_turn_change_records(&self, session_id: &str) -> Arc<Vec<SharedRecord>> {
        let id = clean(session_id);
        if id.is_empty() {
            return Arc::new(Vec::new());
        }
        let mut records: Vec<SharedRecord> = self.change_state(id).await.map(|s| s.records.values().map(|e| e.record.clone()).collect()).unwrap_or_default();
        records.sort_by(|l, r| created_at(l).partial_cmp(&created_at(r)).unwrap_or(std::cmp::Ordering::Equal));
        Arc::new(records)
    }

    /// The records as the one document of the previous format (file order).
    #[cfg(test)]
    pub(in crate::turn_review) async fn changes_document(&self, session_id: &str) -> Option<String> {
        let state = self.change_state(clean(session_id)).await?;
        Some(whole_file(clean(session_id), &state.records))
    }

    /// How many turn records the session retains; parses nothing once cached.
    pub async fn count_turn_change_records(&self, session_id: &str) -> usize {
        let id = clean(session_id);
        if id.is_empty() {
            return 0;
        }
        self.change_state(id).await.map_or(0, |s| s.records.len())
    }
}
