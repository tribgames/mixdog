//! Session change baselines (Node `session-baseline-store.mjs`): the FIRST observed state of every
//! file a session's tools wrote, per review owner. The session-wide review compares these with
//! the disk for every file a Git baseline tree does not cover.
//!
//! Layout under `<data>/turn-snapshots`:
//!   `baselines/<hash(session)>.json`        index: one entry per file key
//!   `baselines/<hash(session)>/<sha256>`    captured before-bytes (immutable)
//!   `review-owners/<hash(child)>.json`      worker → Lead review attribution
//!
//! Several processes share one index: every write runs under the index's file lock, re-reads the
//! index and replays this process's unwritten captures on top of it, so no process drops
//! another's entries (first seen wins). Captures, loads and clears pass one FIFO in call order.

use std::collections::HashMap;
use std::collections::VecDeque;
use std::future::Future;
use std::path::Path;
use std::path::PathBuf;
use std::pin::Pin;
use std::sync::Arc;
use std::sync::Mutex;

use indexmap::IndexMap;
use mixdog_core_api::turn_review::ReviewContent;
use mixdog_js::json_number;
use mixdog_js::json_stringify;
use mixdog_js::number_to_string;
use serde_json::Value;
use sha2::Digest;
use sha2::Sha256;

use super::patch::change_path_key;
use super::patch::clean;
use super::ports::BlockingFs;
use super::ports::ReadFs;
use super::ports::ReviewDisk;
use super::review_diff::Obj;
use super::session_review::Change;
use super::store::session_hash;
use super::store::sweep_dir;

const BASELINE_VERSION: u64 = 1;
/// Largest before-state kept as bytes: the review reads current files up to the same bound.
pub(super) const BASELINE_FILE_MAX_BYTES: usize = 1024 * 1024;
const MAX_BLOB_BYTES_PER_SESSION: u64 = 64 * 1024 * 1024;
const MAX_FILES_PER_SESSION: usize = 4096;
const MAX_RENAME_EVENTS: usize = MAX_FILES_PER_SESSION;
const MAX_BASELINE_SESSIONS: usize = 512;
const MAX_OWNER_RECORDS: usize = 4096;
const BASELINE_TTL_MS: f64 = 30.0 * 24.0 * 60.0 * 60.0 * 1000.0;
const SWEEP_INTERVAL_MS: f64 = 10.0 * 60.0 * 1000.0;
const ORPHAN_BLOB_GRACE_MS: f64 = 60.0 * 60.0 * 1000.0;
const STATE_CACHE_SESSIONS: usize = 16;
const ROW_CACHE_MAX_BYTES: usize = 16 * 1024 * 1024;

fn digest(bytes: &[u8]) -> String {
    Sha256::digest(bytes).iter().map(|b| format!("{b:02x}")).collect()
}

fn is_sha256(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

/// An index entry. `state` is `present` or `absent`; `status` is `captured`, `omitted-binary`,
/// `omitted-oversized` or `evicted`.
#[derive(Clone, Debug, PartialEq)]
pub(super) struct Entry {
    pub key: String,
    pub path: String,
    pub root: String,
    pub state: String,
    pub status: String,
    pub size: u64,
    pub sha256: Option<String>,
    pub blob: Option<String>,
    pub at: f64,
    pub touched: Option<f64>,
    /// Made by a capture in this process: `at` is written right after `root`, as Node's
    /// `baselineEntry` builds it. An entry read back from the index has `at` after the blob.
    pub fresh: bool,
}

impl Entry {
    fn latest(&self) -> f64 {
        self.touched.unwrap_or(self.at)
    }

    fn value(&self) -> Value {
        let mut o = Obj::new();
        o.insert("key".into(), self.key.clone().into());
        o.insert("path".into(), self.path.clone().into());
        o.insert("root".into(), self.root.clone().into());
        if self.fresh {
            o.insert("at".into(), json_number(self.at));
        }
        o.insert("state".into(), self.state.clone().into());
        o.insert("status".into(), self.status.clone().into());
        o.insert("size".into(), Value::from(self.size));
        if let Some(sha) = &self.sha256 {
            o.insert("sha256".into(), sha.clone().into());
        }
        if let Some(blob) = &self.blob {
            o.insert("blob".into(), blob.clone().into());
        }
        if !self.fresh {
            o.insert("at".into(), json_number(self.at));
        }
        if let Some(touched) = self.touched {
            o.insert("touched".into(), json_number(touched));
        }
        Value::Object(o)
    }
}

fn num(value: Option<&Value>) -> f64 {
    let n = mixdog_js::to_number_of(value);
    if n.is_nan() { 0.0 } else { n }
}

fn parsed_entry(value: &Value) -> Option<Entry> {
    let obj = value.as_object()?;
    let text = |k: &str| clean(obj.get(k).and_then(Value::as_str).unwrap_or("")).to_owned();
    let (key, path) = (text("key"), text("path"));
    let status = obj.get("status").and_then(Value::as_str).unwrap_or("");
    let state = obj.get("state").and_then(Value::as_str).unwrap_or("");
    if key.is_empty() || path.is_empty() || !["captured", "omitted-binary", "omitted-oversized", "evicted"].contains(&status) || !["present", "absent"].contains(&state) {
        return None;
    }
    let sha = obj.get("sha256").and_then(Value::as_str).filter(|s| is_sha256(s)).map(str::to_owned);
    let blob = obj.get("blob").and_then(Value::as_str).filter(|s| status == "captured" && is_sha256(s)).map(str::to_owned);
    let touched = num(obj.get("touched"));
    Some(Entry {
        key,
        path,
        root: text("root"),
        state: state.to_owned(),
        status: status.to_owned(),
        size: num(obj.get("size")) as u64,
        sha256: sha,
        blob,
        at: num(obj.get("at")),
        touched: (touched > 0.0).then_some(touched),
        fresh: false,
    })
}

#[derive(Clone, Debug, PartialEq)]
pub(super) struct Side {
    pub key: String,
    pub path: String,
    pub root: String,
}

#[derive(Clone, Debug)]
pub(super) struct Missing {
    pub key: String,
    pub path: String,
    pub root: String,
    pub at: Option<f64>,
}

#[derive(Clone, Debug)]
struct SideChange {
    source: Side,
    destination: Option<Side>,
    before: ReviewContent,
    replaced: bool,
    entry: Option<Entry>,
    redundant: bool,
}

#[derive(Clone, Debug)]
struct Op {
    id: u64,
    at: f64,
    changes: Vec<SideChange>,
}

/// `[at, key]` (created or deleted in place) or `[at, from, to]` (moved).
#[derive(Clone, Debug, PartialEq)]
struct Event {
    at: f64,
    key: String,
    to: Option<String>,
}

impl Event {
    fn id(&self) -> String {
        format!("{}\0{}{}", number_to_string(self.at), self.key, self.to.as_ref().map(|t| format!("\0{t}")).unwrap_or_default())
    }

    fn value(&self) -> Value {
        let mut a = vec![json_number(self.at), Value::from(self.key.clone())];
        if let Some(to) = &self.to {
            a.push(Value::from(to.clone()));
        }
        Value::Array(a)
    }

    fn parse(value: &Value) -> Option<Self> {
        let a = value.as_array()?;
        if !(a.len() == 2 || a.len() == 3) {
            return None;
        }
        let at = a[0].as_f64().filter(|n| n.is_finite())?;
        let strings: Option<Vec<&str>> = a[1..].iter().map(|v| v.as_str().filter(|s| !s.is_empty())).collect();
        let strings = strings?;
        Some(Self { at, key: strings[0].to_owned(), to: strings.get(1).map(|s| (*s).to_owned()) })
    }
}

#[derive(Clone, Default)]
struct Incomplete {
    flag: bool,
    at: f64,
}

impl Incomplete {
    fn mark(&mut self, at: f64) {
        self.flag = true;
        if at > self.at {
            self.at = at;
        }
    }
}

#[derive(Clone)]
struct State {
    session_id: String,
    inc: Incomplete,
    created_at: f64,
    cleared_at: f64,
    files: IndexMap<String, Entry>,
    missing: IndexMap<String, Missing>,
    base_renames: IndexMap<String, String>,
    folded_at: f64,
    events: Vec<Event>,
    renames: IndexMap<String, String>,
    signature: String,
    pending: Vec<Op>,
    writes: IndexMap<String, Vec<u8>>,
    held_redundant: HashMap<String, u64>,
}

impl State {
    fn empty(session_id: &str) -> Self {
        Self {
            session_id: session_id.to_owned(),
            inc: Incomplete::default(),
            created_at: 0.0,
            cleared_at: 0.0,
            files: IndexMap::new(),
            missing: IndexMap::new(),
            base_renames: IndexMap::new(),
            folded_at: 0.0,
            events: Vec::new(),
            renames: IndexMap::new(),
            signature: String::new(),
            pending: Vec::new(),
            writes: IndexMap::new(),
            held_redundant: HashMap::new(),
        }
    }

    fn has_baselines(&self) -> bool {
        !self.files.is_empty() || self.inc.flag
    }
}

/// Apply one rename event to `map` (renamed path → the path it came from).
fn fold_event(map: &mut IndexMap<String, String>, event: &Event, inc: &mut Incomplete) {
    let Some(to) = &event.to else {
        map.shift_remove(&event.key);
        return;
    };
    let origin = map.get(&event.key).cloned().unwrap_or_else(|| event.key.clone());
    map.shift_remove(&event.key);
    if &origin == to {
        map.shift_remove(to);
    } else if map.contains_key(to) || map.len() < MAX_FILES_PER_SESSION {
        map.insert(to.clone(), origin);
    } else {
        inc.mark(event.at);
    }
}

fn refold(state: &mut State) -> IndexMap<String, String> {
    let mut map = state.base_renames.clone();
    for event in &state.events {
        fold_event(&mut map, event, &mut state.inc);
    }
    map
}

fn compact_events(state: &mut State) {
    if state.events.len() <= MAX_RENAME_EVENTS {
        return;
    }
    let excess = state.events.len() - MAX_RENAME_EVENTS;
    let doomed: Vec<Event> = state.events.drain(..excess).collect();
    for event in doomed {
        fold_event(&mut state.base_renames, &event, &mut state.inc);
        state.folded_at = event.at;
    }
}

/// Place one capture's rename events where it was observed. Returns whether anything was placed.
fn place_rename_events(state: &mut State, at: f64, events: Vec<Event>) -> bool {
    if events.is_empty() {
        return false;
    }
    if at <= state.folded_at {
        state.inc.mark(at);
        for event in &events {
            fold_event(&mut state.base_renames, event, &mut state.inc);
        }
        state.renames = refold(state);
        return true;
    }
    let mut index = state.events.len();
    while index > 0 && state.events[index - 1].at > at {
        index -= 1;
    }
    let mut placed = std::collections::HashSet::new();
    let mut other = index;
    while other > 0 && state.events[other - 1].at == at {
        placed.insert(state.events[other - 1].id());
        other -= 1;
    }
    let fresh: Vec<Event> = if placed.is_empty() { events } else { events.into_iter().filter(|e| !placed.contains(&e.id())).collect() };
    if fresh.is_empty() {
        return false;
    }
    let appended = index == state.events.len();
    let tail = state.events.split_off(index);
    state.events.extend(fresh.iter().cloned());
    state.events.extend(tail);
    if appended {
        for event in &fresh {
            fold_event(&mut state.renames, event, &mut state.inc);
        }
    } else {
        state.renames = refold(state);
    }
    compact_events(state);
    true
}

struct Made {
    entry: Entry,
    bytes: Option<Vec<u8>>,
}

fn baseline_entry(side: &Side, before: &ReviewContent, at: f64) -> Made {
    let base = |state: &str, status: &str, size: u64| Entry {
        key: side.key.clone(),
        path: side.path.clone(),
        root: side.root.clone(),
        state: state.into(),
        status: status.into(),
        size,
        sha256: None,
        blob: None,
        at,
        touched: None,
        fresh: true,
    };
    match before {
        ReviewContent::Absent => Made { entry: base("absent", "captured", 0), bytes: None },
        ReviewContent::Omitted { size, reason } => {
            let status = if reason.as_deref() == Some("binary") { "omitted-binary" } else { "omitted-oversized" };
            Made { entry: base("present", status, *size), bytes: None }
        }
        ReviewContent::Bytes(bytes) => {
            let sha = digest(bytes);
            if bytes.len() > BASELINE_FILE_MAX_BYTES {
                let mut entry = base("present", "omitted-oversized", bytes.len() as u64);
                entry.sha256 = Some(sha);
                return Made { entry, bytes: None };
            }
            let mut entry = base("present", "captured", bytes.len() as u64);
            entry.sha256 = Some(sha.clone());
            entry.blob = Some(sha);
            Made { entry, bytes: Some(bytes.to_vec()) }
        }
    }
}

fn bound_captured_bytes(state: &mut State) {
    let mut captured: Vec<Entry> = state.files.values().filter(|e| e.blob.is_some()).cloned().collect();
    captured.sort_by(|a, b| a.at.partial_cmp(&b.at).unwrap_or(std::cmp::Ordering::Equal));
    let mut total: u64 = captured.iter().map(|e| e.size).sum();
    for entry in captured {
        if total <= MAX_BLOB_BYTES_PER_SESSION {
            break;
        }
        total -= entry.size;
        let mut next = entry.clone();
        next.blob = None;
        next.status = "evicted".into();
        state.files.insert(entry.key, next);
    }
}

fn enforce_bounds(state: &mut State) {
    if state.files.len() > MAX_FILES_PER_SESSION {
        let mut all: Vec<Entry> = state.files.values().cloned().collect();
        all.sort_by(|a, b| a.at.partial_cmp(&b.at).unwrap_or(std::cmp::Ordering::Equal));
        let newest: Vec<Entry> = all.into_iter().skip(MAX_FILES_PER_SESSION).collect();
        let mut latest = f64::NEG_INFINITY;
        for entry in &newest {
            state.files.shift_remove(&entry.key);
            latest = latest.max(entry.latest());
        }
        state.inc.mark(latest);
    }
    bound_captured_bytes(state);
}

struct Applied {
    writes: IndexMap<String, Vec<u8>>,
    op: Op,
}

fn touch(state: &mut State, at: f64, side: &Side, touched: &mut bool) {
    if let Some(existing) = state.files.get(&side.key)
        && at > existing.latest() {
            let mut next = existing.clone();
            next.touched = Some(at);
            state.files.insert(side.key.clone(), next);
            *touched = true;
        }
    if let Some(lost) = state.missing.get(&side.key)
        && at > lost.at.unwrap_or(0.0) {
            let mut next = lost.clone();
            next.at = Some(at);
            state.missing.insert(side.key.clone(), next);
            *touched = true;
        }
}

/// Fold one capture batch into the state. `None` when nothing changed, else the blobs to write
/// and the capture reduced to what can still become a baseline.
fn apply_capture(state: &mut State, op: &Op, blobs: Option<&IndexMap<String, Vec<u8>>>, next_id: &mut u64) -> Option<Applied> {
    let at = op.at;
    if at < state.cleared_at {
        return None;
    }
    let mut writes: IndexMap<String, Vec<u8>> = IndexMap::new();
    let mut dirty = false;
    if at == state.cleared_at {
        dirty = true;
        state.inc.mark(at);
    }
    let mut touched = false;
    let mut kept: Vec<SideChange> = Vec::new();
    let mut events: Vec<Event> = Vec::new();
    // `add`: first seen wins; returns the entry it stored.
    let add = |state: &mut State, side: &Side, make: &mut dyn FnMut(&mut State) -> Made, writes: &mut IndexMap<String, Vec<u8>>, dirty: &mut bool, touched: &mut bool| -> Option<Entry> {
        let existing = state.files.get(&side.key).cloned();
        if let Some(existing) = &existing
            && at.partial_cmp(&existing.at) != Some(std::cmp::Ordering::Less) {
                touch(state, at, side, touched);
                return None;
            }
        if existing.is_none() && state.files.len() >= MAX_FILES_PER_SESSION {
            *dirty |= !state.inc.flag || at > state.inc.at;
            state.inc.mark(at);
            return None;
        }
        let made = make(state);
        let latest = existing.as_ref().map_or(0.0, |e| e.touched.unwrap_or(0.0).max(e.at));
        let mut entry = made.entry;
        if latest > entry.at {
            entry.touched = Some(latest);
        }
        state.files.insert(side.key.clone(), entry.clone());
        if let (Some(bytes), Some(blob)) = (made.bytes, &entry.blob) {
            writes.insert(blob.clone(), bytes);
        }
        *dirty = true;
        Some(entry)
    };
    for change in &op.changes {
        if change.redundant {
            touch(state, at, &change.source, &mut touched);
        }
        let entry = if change.redundant {
            None
        } else {
            let change_ref = change;
            add(
                state,
                &change.source,
                &mut |state: &mut State| match &change_ref.entry {
                    None => baseline_entry(&change_ref.source, &change_ref.before, at),
                    Some(entry) => {
                        let bytes = entry.blob.as_ref().and_then(|b| blobs.and_then(|m| m.get(b))).cloned();
                        if entry.blob.is_none() || bytes.is_some() {
                            Made { entry: entry.clone(), bytes }
                        } else {
                            // Its unwritten bytes went to the byte budget.
                            state.inc.mark(at);
                            let mut rest = entry.clone();
                            rest.blob = None;
                            rest.status = "evicted".into();
                            Made { entry: rest, bytes: None }
                        }
                    }
                },
                &mut writes,
                &mut dirty,
                &mut touched,
            )
        };
        kept.push(SideChange {
            source: change.source.clone(),
            destination: change.destination.clone(),
            before: ReviewContent::Absent,
            replaced: change.replaced,
            redundant: entry.is_none(),
            entry,
        });
        if let Some(destination) = &change.destination {
            let dest = destination.clone();
            add(state, destination, &mut |_| baseline_entry(&dest, &ReviewContent::Absent, at), &mut writes, &mut dirty, &mut touched);
            events.push(Event { at, key: change.source.key.clone(), to: Some(destination.key.clone()) });
        } else if change.replaced {
            events.push(Event { at, key: change.source.key.clone(), to: None });
        }
    }
    for change in &op.changes {
        if !change.redundant || state.files.contains_key(&change.source.key) || state.missing.contains_key(&change.source.key) {
            continue;
        }
        let Side { key, path, root } = change.source.clone();
        if state.missing.len() < MAX_FILES_PER_SESSION {
            state.missing.insert(key.clone(), Missing { key, path, root, at: Some(at) });
        }
        state.inc.mark(at);
        dirty = true;
    }
    if place_rename_events(state, at, events) {
        dirty = true;
    }
    let id = *next_id;
    *next_id += 1;
    if !dirty {
        if (state.pending.is_empty() && !touched) || kept.is_empty() {
            return None;
        }
        let mut new_op = Op { id, at, changes: kept };
        let keys: Vec<String> = new_op.changes.iter().map(|c| c.source.key.clone()).collect();
        for key in keys {
            if let Some(prior_id) = state.held_redundant.get(&key).copied() {
                if prior_id == id {
                    new_op.changes.retain(|held| held.source.key != key);
                } else if let Some(index) = state.pending.iter().position(|p| p.id == prior_id) {
                    state.pending[index].changes.retain(|held| held.source.key != key);
                    if state.pending[index].changes.is_empty() {
                        state.pending.remove(index);
                    }
                }
            }
            state.held_redundant.insert(key, id);
        }
        return Some(Applied { writes, op: new_op });
    }
    if state.created_at == 0.0 {
        state.created_at = at;
    }
    Some(Applied { writes, op: Op { id, at, changes: kept } })
}

fn hold_capture(state: &mut State, applied: Option<Applied>) {
    let Some(applied) = applied else { return };
    let at = applied.op.at;
    state.pending.push(applied.op);
    for (blob, bytes) in applied.writes {
        state.writes.insert(blob, bytes);
    }
    enforce_bounds(state);
    let referenced: std::collections::HashSet<String> = state.files.values().filter_map(|e| e.blob.clone()).collect();
    let unreferenced: Vec<String> = state.writes.keys().filter(|b| !referenced.contains(*b)).cloned().collect();
    for blob in unreferenced {
        state.writes.shift_remove(&blob);
        state.inc.mark(at);
    }
}

/// `fresh` (the index on disk) with this process's unwritten captures of `prior` replayed on top.
fn rebased(mut fresh: State, prior: Option<&State>, next_id: &mut u64) -> State {
    if let Some(prior) = prior {
        for op in &prior.pending {
            let applied = apply_capture(&mut fresh, op, Some(&prior.writes), next_id);
            hold_capture(&mut fresh, applied);
        }
    }
    fresh
}

// ── Disk ────────────────────────────────────────────────────────────────────────

fn index_signature(fs: &dyn ReadFs, path: &Path) -> String {
    match fs.stat(path) {
        Ok(Some(stamp)) => format!("{}:{}", number_to_string(stamp.mtime_ms), stamp.size),
        _ => String::new(),
    }
}

/// The index on disk now, as a state carrying its signature.
fn read_state(fs: &dyn ReadFs, path: &Path, session_id: &str) -> State {
    let mut state = State::empty(session_id);
    state.signature = index_signature(fs, path);
    if state.signature.is_empty() {
        return state;
    }
    let bytes = match fs.read(path) {
        Ok(Some(bytes)) => bytes,
        Ok(None) => {
            state.signature.clear();
            return state;
        }
        Err(_) => {
            state.inc.flag = true;
            return state;
        }
    };
    let parsed: Option<Value> = serde_json::from_slice(&bytes).ok();
    let Some(parsed) = parsed.filter(|p| p.get("version").and_then(Value::as_u64) == Some(BASELINE_VERSION) && p.get("sessionId").and_then(Value::as_str) == Some(session_id)) else {
        state.inc.flag = true;
        return state;
    };
    state.inc.flag = parsed.get("incomplete") == Some(&Value::Bool(true));
    state.created_at = num(parsed.get("createdAt"));
    state.inc.at = num(parsed.get("incompleteAt"));
    state.cleared_at = num(parsed.get("clearedAt"));
    for value in parsed.get("files").and_then(Value::as_array).into_iter().flatten() {
        match parsed_entry(value) {
            Some(entry) => {
                state.files.insert(entry.key.clone(), entry);
            }
            None => state.inc.flag = true,
        }
    }
    for value in parsed.get("missing").and_then(Value::as_array).into_iter().flatten() {
        let text = |k: &str| clean(value.get(k).and_then(Value::as_str).unwrap_or("")).to_owned();
        let (key, path) = (text("key"), text("path"));
        let at = mixdog_js::to_number_of(value.get("at"));
        if !key.is_empty() && !path.is_empty() {
            state.missing.insert(key.clone(), Missing { key, path, root: text("root"), at: (at > 0.0).then_some(at) });
        } else {
            state.inc.flag = true;
        }
    }
    for pair in parsed.get("renames").and_then(Value::as_array).into_iter().flatten() {
        if let Some([Value::String(a), Value::String(b)]) = pair.as_array().map(Vec::as_slice) {
            state.base_renames.insert(a.clone(), b.clone());
        }
    }
    state.folded_at = num(parsed.get("foldedAt"));
    for value in parsed.get("events").and_then(Value::as_array).into_iter().flatten() {
        match Event::parse(value) {
            Some(event) => state.events.push(event),
            None => state.inc.flag = true,
        }
    }
    state.events.sort_by(|a, b| a.at.partial_cmp(&b.at).unwrap_or(std::cmp::Ordering::Equal));
    state.renames = refold(&mut state);
    compact_events(&mut state);
    state
}

fn write_index(fs: &dyn BlockingFs, path: &Path, state: &mut State, now: f64) -> std::io::Result<()> {
    let mut o = Obj::new();
    o.insert("version".into(), Value::from(BASELINE_VERSION));
    o.insert("sessionId".into(), state.session_id.clone().into());
    o.insert("createdAt".into(), json_number(state.created_at));
    o.insert("updatedAt".into(), json_number(now));
    if state.cleared_at != 0.0 {
        o.insert("clearedAt".into(), json_number(state.cleared_at));
    }
    if state.inc.flag {
        o.insert("incomplete".into(), Value::Bool(true));
    }
    if state.inc.at != 0.0 {
        o.insert("incompleteAt".into(), json_number(state.inc.at));
    }
    o.insert("files".into(), Value::Array(state.files.values().map(Entry::value).collect()));
    if !state.missing.is_empty() {
        let rows = state.missing.values().map(|m| {
            let mut r = Obj::new();
            r.insert("key".into(), m.key.clone().into());
            r.insert("path".into(), m.path.clone().into());
            r.insert("root".into(), m.root.clone().into());
            if let Some(at) = m.at {
                r.insert("at".into(), json_number(at));
            }
            Value::Object(r)
        });
        o.insert("missing".into(), Value::Array(rows.collect()));
    }
    o.insert("renames".into(), Value::Array(state.base_renames.iter().map(|(a, b)| Value::Array(vec![a.clone().into(), b.clone().into()])).collect()));
    if state.folded_at != 0.0 {
        o.insert("foldedAt".into(), json_number(state.folded_at));
    }
    o.insert("events".into(), Value::Array(state.events.iter().map(Event::value).collect()));
    fs.write_atomic(path, json_stringify(&Value::Object(o)).as_bytes(), false, true)?;
    state.signature = index_signature(fs, path);
    Ok(())
}

/// Carry what the index on disk holds from `state.cleared_at` on into the freshly cleared `state`.
fn keep_since_clear(state: &mut State, on_disk: &State) {
    let cleared_at = state.cleared_at;
    let mut cause = 0.0f64;
    for entry in on_disk.files.values() {
        let latest = entry.latest();
        if latest < cleared_at {
            continue;
        }
        if entry.at < cleared_at {
            state.missing.insert(entry.key.clone(), Missing { key: entry.key.clone(), path: entry.path.clone(), root: entry.root.clone(), at: Some(latest) });
            cause = cause.max(latest);
            continue;
        }
        state.files.insert(entry.key.clone(), entry.clone());
        if entry.at == cleared_at {
            cause = cause.max(cleared_at);
        }
    }
    for lost in on_disk.missing.values() {
        match lost.at {
            Some(at) if at >= cleared_at => {
                state.missing.insert(lost.key.clone(), lost.clone());
                cause = cause.max(at);
            }
            _ => {}
        }
    }
    if on_disk.inc.flag && on_disk.inc.at >= cleared_at {
        cause = cause.max(on_disk.inc.at);
    }
    if on_disk.folded_at >= cleared_at {
        cause = cause.max(on_disk.folded_at);
    }
    if state.files.is_empty() && state.missing.is_empty() && cause == 0.0 {
        return;
    }
    state.created_at = on_disk.created_at;
    state.events = on_disk.events.iter().filter(|e| e.at >= cleared_at).cloned().collect();
    state.renames = refold(state);
    if cause > 0.0 {
        state.inc.mark(cause);
    }
}

// ── The component ──────────────────────────────────────────────────────────────

type Job = Pin<Box<dyn Future<Output = ()> + Send>>;

/// A measured review row kept between polls.
#[derive(Clone)]
pub(super) struct CachedRow {
    pub sig: String,
    pub change: Option<Change>,
    pub stripped: bool,
}

#[derive(Default)]
struct RowCache {
    rows: IndexMap<String, (CachedRow, usize)>,
    bytes: usize,
}

impl RowCache {
    fn drop_row(&mut self, key: &str) {
        if let Some((_, bytes)) = self.rows.shift_remove(key) {
            self.bytes -= bytes;
        }
    }
}

fn row_bytes(row: &CachedRow) -> usize {
    256 + row.sig.len() + row.change.as_ref().map_or(0, |c| c.text.len() + c.reason.as_deref().map_or(0, str::len))
}

struct Shared {
    states: IndexMap<String, State>,
    owners: HashMap<String, String>,
    last_issue: f64,
    last_sweep: Option<f64>,
    next_id: u64,
    rows: RowCache,
    queue: VecDeque<Job>,
    running: bool,
}

pub(super) struct Baselines {
    core: Arc<Core>,
}

struct Core {
    disk: Arc<dyn ReviewDisk>,
    root: PathBuf,
    shared: Mutex<Shared>,
}

/// The session's baselines after every capture queued before the load.
pub(super) struct Loaded {
    pub created_at: f64,
    pub incomplete: bool,
    pub files: Vec<Entry>,
    pub missing: Vec<Missing>,
    pub renames: IndexMap<String, String>,
    pub unsaved: bool,
    unwritten: IndexMap<String, Vec<u8>>,
    session_id: String,
    core: Arc<Core>,
}

impl Loaded {
    pub fn cache_get(&self, unit: &str) -> Option<CachedRow> {
        let mut shared = self.core.lock();
        let key = format!("{}\0{unit}", self.session_id);
        let (row, bytes) = shared.rows.rows.shift_remove(&key)?;
        shared.rows.rows.insert(key, (row.clone(), bytes));
        Some(row)
    }

    pub fn cache_set(&self, unit: &str, row: CachedRow) {
        let mut shared = self.core.lock();
        let key = format!("{}\0{unit}", self.session_id);
        shared.rows.drop_row(&key);
        let bytes = row_bytes(&row);
        if bytes > ROW_CACHE_MAX_BYTES {
            return;
        }
        shared.rows.rows.insert(key, (row, bytes));
        shared.rows.bytes += bytes;
        while shared.rows.bytes > ROW_CACHE_MAX_BYTES {
            let Some(oldest) = shared.rows.rows.keys().next().cloned() else { break };
            shared.rows.drop_row(&oldest);
        }
    }

    /// The captured bytes of `entry`; a torn blob is damage and goes.
    pub async fn read_blob(&self, entry: &Entry) -> Option<Vec<u8>> {
        let blob = entry.blob.as_ref()?;
        if let Some(bytes) = self.unwritten.get(blob) {
            return Some(bytes.clone());
        }
        let path = self.core.blob_dir(&self.session_id).join(blob);
        let disk = self.core.disk.clone();
        let blob = blob.clone();
        let read_path = path.clone();
        let want = blob.clone();
        let bytes = run_read(&disk, move |fs| fs.read(&read_path).ok().flatten()).await.ok().flatten()?;
        if digest(&bytes) == want {
            return Some(bytes);
        }
        // A torn blob (an unflushed write cut by a crash). Blobs are published whole and never
        // replaced, so a mismatch is damage: drop it, or the create-only write of a later capture
        // of the same content would skip over it.
        let _ = run(&disk, None, move |fs| fs.remove(&path)).await;
        None
    }
}

/// Runs a read-only file job on the interactive read lane.
async fn run_read<R: Send + 'static>(disk: &Arc<dyn ReviewDisk>, job: impl FnOnce(&dyn ReadFs) -> R + Send + 'static) -> std::io::Result<R> {
    let slot: Arc<Mutex<Option<R>>> = Arc::new(Mutex::new(None));
    let put = slot.clone();
    disk.blocking_read(Box::new(move |fs| *put.lock().unwrap_or_else(|e| e.into_inner()) = Some(job(fs)))).await?;
    let taken = slot.lock().unwrap_or_else(|e| e.into_inner()).take();
    taken.ok_or_else(|| std::io::Error::other("file job did not run"))
}

/// Runs a file job on the durability lane, under the file lock of `lock` when given.
async fn run<R: Send + 'static>(disk: &Arc<dyn ReviewDisk>, lock: Option<&Path>, job: impl FnOnce(&dyn BlockingFs) -> R + Send + 'static) -> std::io::Result<R> {
    let slot: Arc<Mutex<Option<R>>> = Arc::new(Mutex::new(None));
    let put = slot.clone();
    disk.blocking(lock, Box::new(move |fs| *put.lock().unwrap_or_else(|e| e.into_inner()) = Some(job(fs)))).await?;
    let taken = slot.lock().unwrap_or_else(|e| e.into_inner()).take();
    taken.ok_or_else(|| std::io::Error::other("file job did not run"))
}

impl Core {
    fn lock(&self) -> std::sync::MutexGuard<'_, Shared> {
        self.shared.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn baselines_root(&self) -> PathBuf {
        self.root.join("baselines")
    }
    fn owners_root(&self) -> PathBuf {
        self.root.join("review-owners")
    }
    fn index_path(&self, session_id: &str) -> PathBuf {
        self.baselines_root().join(format!("{}.json", session_hash(session_id)))
    }
    fn blob_dir(&self, session_id: &str) -> PathBuf {
        self.baselines_root().join(session_hash(session_id))
    }
    fn owner_path(&self, session_id: &str) -> PathBuf {
        self.owners_root().join(format!("{}.json", session_hash(session_id)))
    }

    /// Issue times: strictly increasing in this process.
    fn issue_time(&self) -> f64 {
        let now = self.disk.now_ms();
        let mut shared = self.lock();
        shared.last_issue = if now > shared.last_issue { now } else { shared.last_issue + 1.0 / 64.0 };
        shared.last_issue
    }

    fn take_id(&self) -> u64 {
        let mut shared = self.lock();
        shared.next_id += 1;
        shared.next_id
    }

    fn remember(&self, state: State) {
        let mut shared = self.lock();
        let key = state.session_id.clone();
        shared.states.shift_remove(&key);
        shared.states.insert(key.clone(), state);
        // Never forget unwritten captures: only settled states leave the cache.
        let evictable: Vec<String> = shared.states.iter().filter(|(k, s)| **k != key && s.pending.is_empty()).map(|(k, _)| k.clone()).collect();
        let mut over = shared.states.len().saturating_sub(STATE_CACHE_SESSIONS);
        for k in evictable {
            if over == 0 {
                break;
            }
            shared.states.shift_remove(&k);
            over -= 1;
        }
    }

    /// The session's index state: memory while the index on disk is the one it was read from,
    /// else re-read (another process wrote it).
    async fn state_for(&self, session_id: &str) -> State {
        let cached = self.lock().states.get(session_id).cloned();
        let path = self.index_path(session_id);
        let id = session_id.to_owned();
        let (p2, id2) = (path.clone(), id.clone());
        let signature = run_read(&self.disk, move |fs| index_signature(fs, &p2)).await.unwrap_or_default();
        if let Some(cached) = &cached
            && cached.signature == signature {
                self.remember(cached.clone());
                return cached.clone();
            }
        let fresh = run_read(&self.disk, move |fs| read_state(fs, &path, &id2)).await.unwrap_or_else(|_| {
            let mut s = State::empty(&id);
            s.inc.flag = true;
            s
        });
        let mut next_id = self.take_id();
        let state = rebased(fresh, cached.as_ref(), &mut next_id);
        self.remember(state.clone());
        state
    }

    /// Write the state's unwritten captures under the index lock, onto the index as it is now.
    async fn persist_state(&self, session_id: &str, state: State) -> std::io::Result<State> {
        let index = self.index_path(session_id);
        let dir = self.blob_dir(session_id);
        let id = session_id.to_owned();
        let now = self.disk.now_ms();
        let mut next_id = self.take_id();
        let lock = index.clone();
        let (state, rebuilt) = run(&self.disk, Some(&lock), move |fs| -> std::io::Result<(State, bool)> {
            let mut current = state;
            let mut rebuilt = false;
            if current.signature != index_signature(fs, &index) {
                let fresh = read_state(fs, &index, &id);
                current = rebased(fresh, Some(&current), &mut next_id);
                rebuilt = true;
            }
            if current.pending.is_empty() {
                return Ok((current, rebuilt));
            }
            enforce_bounds(&mut current);
            fs.create_private_dir_all(&dir)?;
            let kept: std::collections::HashSet<String> = current.files.values().filter_map(|e| e.blob.clone()).collect();
            // Content-addressed and immutable: an existing blob already holds these bytes.
            for (blob, bytes) in &current.writes {
                if kept.contains(blob) {
                    fs.write_atomic(&dir.join(blob), bytes, true, false)?;
                }
            }
            write_index(fs, &index, &mut current, now)?;
            current.pending.clear();
            current.writes.clear();
            current.held_redundant.clear();
            // Under the lock no other writer has a blob on the way.
            for (name, _, _) in fs.list(&dir).unwrap_or_default() {
                if is_sha256(&name) && !kept.contains(&name) {
                    let _ = fs.remove(&dir.join(&name));
                }
            }
            Ok((current, rebuilt))
        })
        .await??;
        let _ = rebuilt;
        self.remember(state.clone());
        Ok(state)
    }

    /// Write the state's unwritten captures. A refusal keeps them in memory for the next capture
    /// or load to retry.
    async fn flush(self: &Arc<Self>, session_id: &str, state: State) -> State {
        if state.pending.is_empty() {
            return state;
        }
        let current = match self.persist_state(session_id, state.clone()).await {
            Ok(current) => current,
            Err(_) => self.lock().states.get(session_id).cloned().unwrap_or(state),
        };
        let core = self.clone();
        mixdog_rt::spawn("turn_review.baselines_sweep", mixdog_rt::TaskClass::Work, async move { core.sweep_store().await });
        current
    }

    async fn capture_into(self: &Arc<Self>, session_id: &str, op: &Op) {
        let mut state = self.state_for(session_id).await;
        let mut next_id = self.take_id();
        let applied = apply_capture(&mut state, op, None, &mut next_id);
        hold_capture(&mut state, applied);
        self.remember(state.clone());
        // Captures the disk refused before are retried with this one.
        self.flush(session_id, state).await;
    }

    async fn sweep_store(&self) {
        let now = self.disk.now_ms();
        {
            let mut shared = self.lock();
            if shared.last_sweep.is_some_and(|at| now - at < SWEEP_INTERVAL_MS) {
                return;
            }
            shared.last_sweep = Some(now);
        }
        sweep_dir(self.disk.as_ref(), &self.baselines_root(), BASELINE_TTL_MS, MAX_BASELINE_SESSIONS).await;
        sweep_dir(self.disk.as_ref(), &self.owners_root(), BASELINE_TTL_MS, MAX_OWNER_RECORDS).await;
        // A blob directory without an index is pruned once old: its first index write may still be
        // on the way.
        let root = self.baselines_root();
        let _ = run(&self.disk, None, move |fs| {
            let names = fs.list(&root).unwrap_or_default();
            let indexes: std::collections::HashSet<&str> = names.iter().filter(|(_, file, _)| *file).map(|(n, _, _)| n.as_str()).collect();
            for (name, _, dir) in &names {
                if !dir || indexes.contains(format!("{name}.json").as_str()) {
                    continue;
                }
                if let Ok(Some(stamp)) = fs.stat(&root.join(name)) {
                    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0.0, |d| d.as_millis() as f64);
                    if now - stamp.mtime_ms > ORPHAN_BLOB_GRACE_MS {
                        let _ = fs.remove_tree(&root.join(name));
                    }
                }
            }
        })
        .await;
    }

    async fn read_owner(&self, session_id: &str) -> String {
        let path = self.owner_path(session_id);
        let id = session_id.to_owned();
        run_read(&self.disk, move |fs| {
            let parsed: Value = serde_json::from_slice(&fs.read(&path).ok().flatten()?).ok()?;
            let ok = parsed.get("version").and_then(Value::as_u64) == Some(BASELINE_VERSION) && parsed.get("sessionId").and_then(Value::as_str) == Some(id.as_str());
            ok.then(|| clean(parsed.get("ownerSessionId").and_then(Value::as_str).unwrap_or("")).to_owned())
        })
        .await
        .ok()
        .flatten()
        .unwrap_or_default()
    }

    /// Load a session's durable attribution into memory (once per process).
    async fn prime_owner(&self, session_id: &str) {
        if self.lock().owners.contains_key(session_id) {
            return;
        }
        let owner = self.read_owner(session_id).await;
        self.lock().owners.entry(session_id.to_owned()).or_insert(owner);
    }

    /// The session itself, then each Lead it is attributed to.
    async fn review_owner_chain(&self, session_id: &str, hint: &str) -> Vec<String> {
        let mut ids = vec![session_id.to_owned()];
        let mut next = clean(hint).to_owned();
        if next.is_empty() {
            self.prime_owner(session_id).await;
            next = self.lock().owners.get(session_id).cloned().unwrap_or_default();
        }
        while !next.is_empty() && !ids.contains(&next) {
            ids.push(next.clone());
            self.prime_owner(&next).await;
            next = self.lock().owners.get(&next).cloned().unwrap_or_default();
        }
        ids
    }

    fn submit(self: &Arc<Self>, job: Job) {
        let start = {
            let mut shared = self.lock();
            shared.queue.push_back(job);
            !std::mem::replace(&mut shared.running, true)
        };
        if start {
            let core = self.clone();
            mixdog_rt::spawn("turn_review.baselines", mixdog_rt::TaskClass::Work, async move {
                loop {
                    let next = {
                        let mut shared = core.lock();
                        match shared.queue.pop_front() {
                            Some(job) => job,
                            None => {
                                shared.running = false;
                                return;
                            }
                        }
                    };
                    next.await;
                }
            });
        }
    }
}

/// One change handed to [`Baselines::capture`].
pub(super) struct CaptureChange {
    pub path: String,
    pub root: String,
    pub before: ReviewContent,
    pub new_path: String,
    pub replaced: bool,
}

impl Baselines {
    pub fn new(disk: Arc<dyn ReviewDisk>, data_dir: &Path) -> Self {
        Self {
            core: Arc::new(Core {
                disk,
                root: data_dir.join("turn-snapshots"),
                shared: Mutex::new(Shared {
                    states: IndexMap::new(),
                    owners: HashMap::new(),
                    last_issue: 0.0,
                    last_sweep: None,
                    next_id: 0,
                    rows: RowCache::default(),
                    queue: VecDeque::new(),
                    running: false,
                }),
            }),
        }
    }

    /// Record the first-seen state of each changed path in the baselines of the session and of
    /// every Lead it is attributed to (`owner`: the Lead a bound worker tracker names).
    pub fn capture(&self, session_id: &str, changes: Vec<CaptureChange>, owner: &str) {
        let id = clean(session_id).to_owned();
        let mut prepared = Vec::new();
        for change in changes {
            let path = clean(&change.path).to_owned();
            if path.is_empty() {
                continue;
            }
            let root = clean(&change.root).to_owned();
            let new_path = clean(&change.new_path).to_owned();
            prepared.push(SideChange {
                source: Side { key: change_path_key(&path), path, root: root.clone() },
                destination: (!new_path.is_empty()).then(|| Side { key: change_path_key(&new_path), path: new_path, root }),
                before: change.before,
                replaced: change.replaced,
                entry: None,
                redundant: false,
            });
        }
        if id.is_empty() || prepared.is_empty() {
            return;
        }
        let core = self.core.clone();
        // Queued now, in call order: an owner lookup never lets a later capture overtake this one.
        let op = Op { id: core.take_id(), at: core.issue_time(), changes: prepared };
        let hint = owner.to_owned();
        self.core.submit(Box::pin({
            let core = core.clone();
            async move {
                let targets = core.review_owner_chain(&id, &hint).await;
                for target in targets {
                    core.capture_into(&target, &op).await;
                }
            }
        }));
    }

    /// Attribute a worker session's edits to the Lead that launched it. Durable.
    pub fn record_review_owner(&self, child_session_id: &str, owner_session_id: &str) {
        let child = clean(child_session_id).to_owned();
        let owner = clean(owner_session_id).to_owned();
        if child.is_empty() || owner.is_empty() || child == owner {
            return;
        }
        {
            let mut shared = self.core.lock();
            if shared.owners.get(&child) == Some(&owner) {
                return;
            }
            shared.owners.insert(child.clone(), owner.clone());
        }
        let core = self.core.clone();
        self.core.submit(Box::pin(async move {
            let path = core.owner_path(&child);
            let dir = core.owners_root();
            let mut o = Obj::new();
            o.insert("version".into(), Value::from(BASELINE_VERSION));
            o.insert("sessionId".into(), child.into());
            o.insert("ownerSessionId".into(), owner.into());
            o.insert("at".into(), json_number(core.disk.now_ms()));
            let text = json_stringify(&Value::Object(o));
            let _ = run(&core.disk, None, move |fs| {
                fs.create_private_dir_all(&dir)?;
                fs.write_atomic(&path, text.as_bytes(), false, true)
            })
            .await;
        }));
    }

    /// The session's baselines after every capture queued so far, or `None` when it never
    /// recorded one.
    pub async fn load(&self, session_id: &str) -> Option<Loaded> {
        let id = clean(session_id).to_owned();
        if id.is_empty() {
            return None;
        }
        let (tx, rx) = tokio::sync::oneshot::channel();
        let core = self.core.clone();
        self.core.submit(Box::pin(async move {
            let state = core.state_for(&id).await;
            let state = core.flush(&id, state).await;
            let loaded = state.has_baselines().then(|| Loaded {
                created_at: state.created_at,
                incomplete: state.inc.flag,
                files: state.files.values().cloned().collect(),
                missing: state.missing.values().filter(|m| !state.files.contains_key(&m.key)).cloned().collect(),
                renames: state.renames.clone(),
                unsaved: !state.pending.is_empty(),
                // Bytes of captures the disk refused are still measured from memory.
                unwritten: state.writes.clone(),
                session_id: id.clone(),
                core: core.clone(),
            });
            let _ = tx.send(loaded);
        }));
        rx.await.ok().flatten()
    }

    /// Delete the session's baselines (Delete history): later edits start fresh. Every capture
    /// issued before it is dropped; one issued after it is kept.
    pub async fn clear(&self, session_id: &str) {
        let id = clean(session_id).to_owned();
        if id.is_empty() {
            return;
        }
        // Taken at the call: a capture issued after it is never older than it.
        let cleared_at = self.core.issue_time();
        let (tx, rx) = tokio::sync::oneshot::channel();
        let core = self.core.clone();
        self.core.submit(Box::pin(async move {
            core.clear_now(&id, cleared_at).await;
            let _ = tx.send(());
        }));
        let _ = rx.await;
    }

    /// The session was deleted: its baselines and its attribution go with it.
    pub async fn forget(&self, session_id: &str) {
        let id = clean(session_id).to_owned();
        if id.is_empty() {
            return;
        }
        self.clear(&id).await;
        self.core.lock().owners.remove(&id);
        let (tx, rx) = tokio::sync::oneshot::channel();
        let core = self.core.clone();
        self.core.submit(Box::pin(async move {
            let path = core.owner_path(&id);
            let _ = run(&core.disk, None, move |fs| fs.remove(&path)).await;
            let _ = tx.send(());
        }));
        let _ = rx.await;
    }

    /// Wait for every capture, load and clear issued so far (tests).
    #[cfg(test)]
    pub async fn settle(&self) {
        let (tx, rx) = tokio::sync::oneshot::channel();
        self.core.submit(Box::pin(async move {
            let _ = tx.send(());
        }));
        let _ = rx.await;
    }
}

impl Core {
    async fn clear_now(self: &Arc<Self>, id: &str, cleared_at: f64) {
        let mut cleared = State::empty(id);
        cleared.cleared_at = cleared_at;
        let index = self.index_path(id);
        let dir = self.blob_dir(id);
        let root = self.baselines_root();
        let now = self.disk.now_ms();
        let p2 = index.clone();
        // Memory first: even when the disk refuses the clear, this process never reviews the old
        // baselines again, and its next write replaces the old index.
        cleared.signature = run_read(&self.disk, move |fs| index_signature(fs, &p2)).await.unwrap_or_default();
        self.remember(cleared.clone());
        {
            let mut shared = self.lock();
            let prefix = format!("{id}\0");
            let doomed: Vec<String> = shared.rows.rows.keys().filter(|k| k.starts_with(&prefix)).cloned().collect();
            for key in doomed {
                shared.rows.drop_row(&key);
            }
        }
        let session = id.to_owned();
        let lock = index.clone();
        let landed = run(&self.disk, Some(&lock), move |fs| -> std::io::Result<State> {
            fs.create_private_dir_all(&root)?;
            let on_disk = read_state(fs, &index, &session);
            // A later clear already landed: nothing here predates it.
            if on_disk.cleared_at >= cleared_at {
                return Ok(on_disk);
            }
            let mut cleared = cleared;
            keep_since_clear(&mut cleared, &on_disk);
            // A tombstone index, not a deletion: its epoch tells other processes which of their
            // unwritten captures predate the clear.
            write_index(fs, &index, &mut cleared, now)?;
            let kept: std::collections::HashSet<String> = cleared.files.values().filter_map(|e| e.blob.clone()).collect();
            for (name, _, _) in fs.list(&dir).unwrap_or_default() {
                if !kept.contains(&name) {
                    fs.remove_tree(&dir.join(&name))?;
                }
            }
            Ok(cleared)
        })
        .await;
        if let Ok(Ok(state)) = landed {
            self.remember(state);
        }
    }
}
