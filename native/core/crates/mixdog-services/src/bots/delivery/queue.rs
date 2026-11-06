//! The persisted per-home queue of rows posted into agent home threads (`routine-results.json`):
//! `createRoutineResultQueue` of agent-home-delivery.mjs. The file is the 1.4.5 file as it is:
//! `{ homes, omitted, delivered, rounds, watches, owned, wakes }`, each a map by home session id
//! (watches and owned by run id). Every change is one read-modify-write under the file lock, and
//! the document is handled as the JSON it is, so a write keeps Node's key order and shapes.

use std::collections::HashSet;
use std::fmt;
use std::sync::Arc;

use mixdog_js::json_number;
use serde_json::{Map, Value, json};

use super::rows::{HANDOFF_FILE_LIMIT, num_or_zero, str_of, truthy};
use crate::bots::state_json::StateJson;
use crate::scheduler::Clock;

/// Run ids already posted, kept per home so a replayed run never posts twice.
const DELIVERED_LEDGER: usize = 500;
/// A target's round-trip count left idle this long starts over.
const ROUND_TTL_MS: f64 = 30.0 * 24.0 * 60.0 * 60.0 * 1000.0;
/// `ROUTINE_LIMITS.homeQueueLimit`.
pub const HOME_QUEUE_LIMIT: usize = 200;

/// Per home: round-trip targets counted (least recently counted drop first), reporting turns
/// watched at once, and posted results owed a wake.
#[derive(Clone, Copy, Debug)]
pub struct QueueCaps {
    pub round_targets: usize,
    pub watches: usize,
    pub wake_run_ids: usize,
}

pub const QUEUE_CAPS: QueueCaps = QueueCaps { round_targets: 100, watches: 200, wake_run_ids: 100 };

/// The hand-off registry the watch store keeps in step with (delegated-approval-host.mjs
/// `noteHandoff` / `endHandoff`): a watch added starts its hand-off, a watch gone ends it, however
/// a write removed it.
pub trait Handoffs: Send + Sync {
    /// Chat `watch.homeSessionId` handed session `watch.taskSessionId` work under run `watch.runId`.
    fn note(&self, watch: &Value);
    /// The report watch `run_id` is gone: its hand-off ends for good.
    fn end(&self, run_id: &str);
}

/// Why a watch was not stored.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WatchError {
    /// `REPORT_WATCH_CAP`: the home already waits on `caps.watches` reports.
    Cap(String),
    Failed(String),
}

impl WatchError {
    /// The error's `code` in Node.
    pub fn code(&self) -> Option<&'static str> {
        matches!(self, Self::Cap(_)).then_some("REPORT_WATCH_CAP")
    }
}

impl fmt::Display for WatchError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Cap(message) | Self::Failed(message) => f.write_str(message),
        }
    }
}

type Section = Map<String, Value>;

/// The seven sections of the file, in the order the file keeps them.
#[derive(Clone, Default)]
struct Doc {
    homes: Section,
    omitted: Section,
    delivered: Section,
    /// Agent-initiated round trips per task session.
    rounds: Section,
    /// Reporting turns not yet queued, by submission id.
    watches: Section,
    /// The bot-sent turns that hold no watch, by submission id.
    owned: Section,
    /// Posted task results whose wake turn was not taken yet, per home.
    wakes: Section,
}

impl Doc {
    fn parts(raw: Option<Value>) -> Self {
        let mut raw = raw;
        let mut section = |key: &str| match raw.as_mut().and_then(|doc| doc.get_mut(key)) {
            Some(Value::Object(map)) => std::mem::take(map),
            _ => Map::new(),
        };
        Self {
            homes: section("homes"),
            omitted: section("omitted"),
            delivered: section("delivered"),
            rounds: section("rounds"),
            watches: section("watches"),
            owned: section("owned"),
            wakes: section("wakes"),
        }
    }

    fn into_value(self) -> Value {
        let mut out = Map::new();
        for (key, section) in [
            ("homes", self.homes),
            ("omitted", self.omitted),
            ("delivered", self.delivered),
            ("rounds", self.rounds),
            ("watches", self.watches),
            ("owned", self.owned),
            ("wakes", self.wakes),
        ] {
            out.insert(key.into(), Value::Object(section));
        }
        Value::Object(out)
    }

    /// `JSON.stringify(a) === JSON.stringify(b)`.
    fn same_as(&self, other: &Doc) -> bool {
        let (mine, theirs) = (self.clone().into_value().to_string(), other.clone().into_value().to_string());
        mine == theirs
    }
}

/// `doc.<section>[home] || []`.
fn list_of(section: &Section, home: &str) -> Vec<Value> {
    match section.get(home) {
        Some(Value::Array(list)) => list.clone(),
        _ => Vec::new(),
    }
}

/// A value's identity in a JS `Set`: its JSON text, `undefined` apart.
fn identity(value: Option<&Value>) -> String {
    value.map_or_else(|| "\u{0}undefined".to_string(), Value::to_string)
}

fn count_of(value: Option<&Value>) -> f64 {
    num_or_zero(value)
}

fn json_num(value: f64) -> Value {
    json_number(value)
}

/// `Number.isInteger(value) && value > 0 ? value : 0`.
fn hop_of(value: Option<&Value>) -> f64 {
    match value.and_then(Value::as_f64) {
        Some(n) if n.fract() == 0.0 && n > 0.0 => n,
        _ => 0.0,
    }
}

/// `sendDepth({ hop, target })` (bot-hops.mjs): the hop of the turn that made a send.
pub fn send_depth(value: Option<&Value>) -> f64 {
    let hop = hop_of(value.and_then(|v| v.get("hop")));
    let target = value.and_then(|v| v.get("target")).and_then(Value::as_str);
    (hop - if target == Some("session") { 1.0 } else { 0.0 }).max(0.0)
}

// --- wake obligations ---

/// `homeId`'s wake obligations: posted task results not in a batch yet (`owed`), those past the
/// cap collapsed into one marker (`overflow`: `{ count, oldest, newest }`) the next batch takes
/// over, and batches (`{ id, runIds, overflow? }`) stored before their wake turn was submitted.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct WakeState {
    pub owed: Vec<Value>,
    pub batches: Vec<Value>,
    pub overflow: Option<Value>,
}

impl WakeState {
    pub fn owes_wake(&self) -> bool {
        !self.owed.is_empty() || !self.batches.is_empty() || self.overflow.is_some()
    }
}

fn wake_state(wakes: &Section, home: &str) -> WakeState {
    match wakes.get(home) {
        Some(Value::Array(owed)) => WakeState { owed: owed.clone(), ..WakeState::default() },
        raw => {
            let raw = raw.filter(|v| truthy(v));
            let owed = match raw.and_then(|r| r.get("owed")) {
                Some(Value::Array(owed)) => owed.clone(),
                _ => Vec::new(),
            };
            let batches = match raw.and_then(|r| r.get("batches")) {
                Some(Value::Array(batches)) => batches
                    .iter()
                    .filter(|batch| batch.get("id").is_some_and(Value::is_string) && batch.get("runIds").is_some_and(Value::is_array))
                    .cloned()
                    .collect(),
                _ => Vec::new(),
            };
            let overflow = raw.and_then(|r| r.get("overflow")).filter(|o| count_of(o.get("count")) > 0.0 && truthy(o)).cloned();
            WakeState { owed, batches, overflow }
        }
    }
}

fn with_wake_state(doc: &mut Doc, home: &str, state: WakeState) {
    if state.owes_wake() {
        let mut entry = Map::new();
        entry.insert("owed".into(), Value::Array(state.owed));
        entry.insert("batches".into(), Value::Array(state.batches));
        if let Some(overflow) = state.overflow {
            entry.insert("overflow".into(), overflow);
        }
        doc.wakes.insert(home.into(), Value::Object(entry));
    } else {
        doc.wakes.shift_remove(home);
    }
}

/// `own`'s per-target counts used within `ROUND_TTL_MS` of `now`, the `cap` most recently counted.
fn fresh_round_counts(own: Option<&Value>, now: f64, cap: usize) -> Section {
    let Some(Value::Object(own)) = own else { return Map::new() };
    let at = |count: &Value| count_of(count.get("at"));
    let mut kept: Vec<(&String, &Value)> = own.iter().filter(|(_, count)| count.is_object() && now - at(count) < ROUND_TTL_MS).collect();
    kept.sort_by(|(_, a), (_, b)| at(b).partial_cmp(&at(a)).unwrap_or(std::cmp::Ordering::Equal));
    kept.into_iter().take(cap).map(|(target, count)| (target.clone(), count.clone())).collect()
}

fn tidy_rounds(rounds: &Section, now: f64, cap: usize) -> Section {
    rounds
        .iter()
        .map(|(home, own)| (home.clone(), fresh_round_counts(Some(own), now, cap)))
        .filter(|(_, own)| !own.is_empty())
        .map(|(home, own)| (home, Value::Object(own)))
        .collect()
}

/// `doc` with `items` appended to `home`'s list, minus run ids it holds or posted; past `limit`
/// the oldest drop, counted under `omitted`. `None` when nothing changes.
fn appended_items(doc: &Doc, home: &str, items: &[Value], limit: usize, omitted_count: f64) -> Result<Option<Doc>, String> {
    let list = list_of(&doc.homes, home);
    let mut seen: HashSet<String> = list.iter().map(|row| identity(row.get("runId"))).collect();
    seen.extend(list_of(&doc.delivered, home).iter().map(|id| identity(Some(id))));
    let fresh: Vec<Value> = items.iter().filter(|item| seen.insert(identity(item.get("runId")))).cloned().collect();
    if fresh.is_empty() && omitted_count == 0.0 {
        return Ok(None);
    }
    let mut next = list;
    next.extend(fresh);
    let drop = next.len().saturating_sub(limit);
    let mut out = doc.clone();
    let count = drop as f64 + omitted_count;
    if count != 0.0 {
        let previous = doc.omitted.get(home);
        let id = match previous.and_then(|p| p.get("id")).filter(|id| truthy(id)) {
            Some(id) => id.clone(),
            None => {
                let first = next.first().ok_or("Cannot read properties of undefined (reading 'runId')")?;
                json!(format!("omit_{}", super::rows::js_str(first.get("runId"))))
            }
        };
        let total = count_of(previous.and_then(|p| p.get("count"))) + count;
        out.omitted.insert(home.into(), json!({ "id": id, "count": json_num(total) }));
    }
    out.homes.insert(home.into(), Value::Array(next.split_off(drop)));
    Ok(Some(out))
}

/// `doc.wakes` with the run ids `wake` owes `home`, at most `cap` per home: past it the oldest
/// owed collapse into the overflow marker. Stored batches never change.
fn owed_wakes(doc: &mut Doc, home: &str, wake: &[Value], cap: usize) -> usize {
    let state = wake_state(&doc.wakes, home);
    let batched: Vec<Value> = state.batches.iter().flat_map(|batch| batch["runIds"].as_array().cloned().unwrap_or_default()).collect();
    let mut known: HashSet<String> = state.owed.iter().chain(batched.iter()).map(|id| identity(Some(id))).collect();
    if let Some(overflow) = &state.overflow {
        known.extend(["oldest", "newest"].iter().filter_map(|key| overflow.get(key)).filter(|v| truthy(v)).map(|v| identity(Some(v))));
    }
    let added: Vec<Value> = wake.iter().filter(|id| !known.contains(&identity(Some(id)))).cloned().collect();
    if added.is_empty() {
        return 0;
    }
    let mut owed = state.owed.clone();
    owed.extend(added);
    let room = cap.saturating_sub(batched.len());
    let excess_len = owed.len().saturating_sub(room);
    let kept = owed.split_off(excess_len);
    let excess = owed;
    let overflow = if excess.is_empty() {
        state.overflow.clone()
    } else {
        let previous = state.overflow.as_ref();
        let oldest = previous.and_then(|p| p.get("oldest")).filter(|v| truthy(v)).cloned().unwrap_or_else(|| excess[0].clone());
        Some(json!({
            "count": json_num(count_of(previous.and_then(|p| p.get("count"))) + excess.len() as f64),
            "oldest": oldest,
            "newest": excess[excess.len() - 1],
        }))
    };
    with_wake_state(doc, home, WakeState { owed: kept, batches: state.batches, overflow });
    excess_len
}

/// `doc` with the posted `run_ids` of `home` dequeued into its posted ledger, and the posted
/// omission notice `omitted` (`{ id, count }`) retired.
fn with_dequeued(doc: &mut Doc, home: &str, run_ids: &[String], omitted: Option<&Value>) {
    let rest: Vec<Value> = list_of(&doc.homes, home)
        .into_iter()
        .filter(|row| !row.get("runId").and_then(Value::as_str).is_some_and(|id| run_ids.iter().any(|posted| posted == id)))
        .collect();
    if rest.is_empty() {
        doc.homes.shift_remove(home);
    } else {
        doc.homes.insert(home.into(), Value::Array(rest));
    }
    if !run_ids.is_empty() {
        let mut ledger = list_of(&doc.delivered, home);
        ledger.extend(run_ids.iter().map(|id| json!(id)));
        let from = ledger.len().saturating_sub(DELIVERED_LEDGER);
        doc.delivered.insert(home.into(), Value::Array(ledger.split_off(from)));
    }
    let current = doc.omitted.get(home).cloned();
    if let (Some(omitted), Some(current)) = (omitted.filter(|o| truthy(o)), current)
        && current.get("id") == omitted.get("id")
    {
        // More dropped while this pass posted: they get a notice of their own.
        let left = count_of(current.get("count")) - count_of(omitted.get("count"));
        if left > 0.0 {
            let id = format!("{}.{}", super::rows::js_str(current.get("id")), super::rows::js_str(omitted.get("count")));
            doc.omitted.insert(home.into(), json!({ "id": id, "count": json_num(left) }));
        } else {
            doc.omitted.shift_remove(home);
        }
    }
}

/// The answer a progress row `run_id` carries (`_progress_<turn id>`), `""` for any other row.
pub fn answer_key(run_id: &str) -> String {
    run_id.find("_progress_").map_or_else(String::new, |at| run_id[at..].to_string())
}

fn answer_key_of(value: Option<&Value>) -> String {
    match value {
        Some(found) if truthy(found) => answer_key(&mixdog_js::value_to_string(found)),
        _ => String::new(),
    }
}

/// Task report `item` for `home` and the `doc` it joins, so that a final report never repeats
/// progress update `progressRunId` that carried the same answer.
fn without_repeated_progress(doc: &Doc, home: &str, item: &Value, posted: bool) -> (Option<Doc>, Value) {
    let Some(progress_run_id) = item.get("progressRunId").filter(|v| truthy(v)) else { return (None, item.clone()) };
    let mut report = item.clone();
    if let Some(map) = report.as_object_mut() {
        map.shift_remove("progressRunId");
    }
    let key = answer_key_of(Some(progress_run_id));
    let delivered = list_of(&doc.delivered, home);
    if posted || delivered.iter().any(|run_id| answer_key_of(Some(run_id)) == key) {
        if let Some(map) = report.as_object_mut() {
            map.shift_remove("text");
            map.shift_remove("textChars");
            map.insert("text".into(), json!(""));
            map.insert("answerAbove".into(), json!(true));
        }
        return (None, report);
    }
    let queued = list_of(&doc.homes, home);
    if !queued.iter().any(|row| answer_key_of(row.get("runId")) == key) {
        return (None, report);
    }
    let mut out = doc.clone();
    out.homes.insert(home.into(), Value::Array(queued.into_iter().filter(|row| answer_key_of(row.get("runId")) != key).collect()));
    (Some(out), report)
}

/// Whether progress row `item` carries an answer `home` already holds or posted.
fn repeats_progress(doc: &Doc, home: &str, item: &Value) -> bool {
    let key = if str_of(item.get("status")) == "working" { answer_key_of(item.get("runId")) } else { String::new() };
    if key.is_empty() {
        return false;
    }
    let queued = list_of(&doc.homes, home);
    queued.iter().map(|row| row.get("runId")).chain(list_of(&doc.delivered, home).iter().map(Some).collect::<Vec<_>>()).any(|id| answer_key_of(id) == key)
}

fn sends_of(value: &Value) -> Vec<Value> {
    let mut sends: Vec<Value> = Vec::new();
    if let Some(id) = value.get("sendId").filter(|v| truthy(v)) {
        sends.push(id.clone());
    }
    if let Some(Value::Array(ids)) = value.get("sendIds") {
        sends.extend(ids.iter().filter(|v| truthy(v)).cloned());
    }
    sends
}

/// `doc` with task report `item` folded into the row of the same run id still queued for `home`:
/// it names every send and lists the files each produced. `None` when no such row is queued or
/// nothing changes.
fn with_folded_report(doc: &Doc, home: &str, item: &Value) -> Option<Doc> {
    let list = list_of(&doc.homes, home);
    let index = list.iter().position(|row| identity(row.get("runId")) == identity(item.get("runId")))?;
    if str_of(item.get("kind")) != "agent-task" {
        return None;
    }
    let row = &list[index];
    let row_sends = sends_of(row);
    let item_sends = sends_of(item);
    // The row's sends are the contributions already folded into it: a replay of one adds nothing.
    if !item_sends.is_empty() && item_sends.iter().all(|id| row_sends.contains(id)) {
        return None;
    }
    let mut send_ids: Vec<Value> = Vec::new();
    for id in row_sends.iter().chain(item_sends.iter()) {
        if !send_ids.contains(id) {
            send_ids.push(id.clone());
        }
    }
    let files_of = |value: &Value| value.get("files").and_then(Value::as_array).cloned().unwrap_or_default();
    let mut files = files_of(row);
    let mut paths: HashSet<String> = files.iter().map(|file| identity(file.get("path"))).collect();
    for file in files_of(item) {
        if paths.insert(identity(file.get("path"))) {
            let mut copy = file;
            if let Some(map) = copy.as_object_mut() {
                map.shift_remove("id");
            }
            files.push(copy);
        }
    }
    let omitted = count_of(row.get("omitted")) + count_of(item.get("omitted")) + files.len().saturating_sub(HANDOFF_FILE_LIMIT) as f64;
    let mut folded = row.clone();
    if let Some(map) = folded.as_object_mut() {
        if send_ids.len() > 1 {
            map.insert("sendIds".into(), Value::Array(send_ids));
        }
        if !files.is_empty() {
            files.truncate(HANDOFF_FILE_LIMIT);
            map.insert("files".into(), Value::Array(files));
        }
        if omitted > 0.0 {
            map.insert("omitted".into(), json_num(omitted));
        }
    }
    let (folded_text, row_text) = (folded.to_string(), row.to_string());
    if folded_text == row_text {
        return None;
    }
    let mut next = list;
    next[index] = folded;
    let mut out = doc.clone();
    out.homes.insert(home.into(), Value::Array(next));
    Some(out)
}

/// Options of one `add`.
#[derive(Clone, Default)]
pub struct AddOptions {
    /// Run ids whose watches are dropped in the same write.
    pub unwatch: Vec<String>,
    /// The thread holds the progress update a final report names.
    pub progress_posted: bool,
    /// `(runId, turnId)`: watch `runId` reported turn `turnId` as progress.
    pub progressed: Option<(String, String)>,
}

/// The persisted queue at one file.
pub struct RoutineResultQueue {
    state: StateJson,
    limit: usize,
    caps: QueueCaps,
    clock: Arc<dyn Clock>,
    handoffs: Arc<dyn Handoffs>,
}

impl RoutineResultQueue {
    pub fn new(state: StateJson, limit: usize, caps: QueueCaps, clock: Arc<dyn Clock>, handoffs: Arc<dyn Handoffs>) -> Self {
        Self { state, limit, caps, clock, handoffs }
    }

    pub fn watch_cap(&self) -> usize {
        self.caps.watches
    }

    fn now_ms(&self) -> f64 {
        self.clock.now().timestamp_millis() as f64
    }

    /// A damaged queue file is kept aside and its last good copy restored; it never blocks
    /// delivery. I/O errors still fail.
    async fn read(&self) -> Result<Doc, String> {
        Ok(Doc::parts(self.state.read_state().await?))
    }

    /// Read-modify-write under the file lock (`mutator` returns the next document, or none to
    /// keep the file); every write also retires stale and surplus round counts. The watches a
    /// write added or removed start or end their hand-offs.
    async fn update<R: Send + 'static>(&self, mutator: impl FnOnce(Doc, f64) -> Result<(Option<Doc>, R), String> + Send + 'static) -> Result<R, String> {
        let now = self.now_ms();
        let cap = self.caps.round_targets;
        let (before, after, result) = self
            .state
            .update(move |raw| {
                let doc = Doc::parts(raw);
                let before = doc.watches.clone();
                let (next, result) = mutator(doc, now)?;
                let after = next.as_ref().map(|next| next.watches.clone());
                let stored = next.map(|mut next| {
                    next.rounds = tidy_rounds(&next.rounds, now, cap);
                    next.into_value()
                });
                Ok((stored, (before.clone(), after.unwrap_or(before), result)))
            })
            .await?;
        for run_id in before.keys() {
            if !after.contains_key(run_id) {
                self.handoffs.end(run_id);
            }
        }
        for (run_id, watch) in &after {
            if !before.contains_key(run_id) {
                self.handoffs.note(watch);
            }
        }
        Ok(result)
    }

    /// Homes with queued rows, a dropped-rows notice or a wake owed.
    pub async fn pending_homes(&self) -> Result<Vec<String>, String> {
        let doc = self.read().await?;
        let mut homes: Vec<String> = Vec::new();
        let mut push = |id: &String| {
            if !homes.contains(id) {
                homes.push(id.clone());
            }
        };
        for (id, list) in &doc.homes {
            if list.as_array().is_some_and(|l| !l.is_empty()) {
                push(id);
            }
        }
        doc.omitted.keys().for_each(&mut push);
        for id in doc.wakes.keys() {
            if wake_state(&doc.wakes, id).owes_wake() {
                push(id);
            }
        }
        Ok(homes)
    }

    /// `home`'s wake obligations.
    pub async fn wakes(&self, home: &str) -> Result<WakeState, String> {
        Ok(wake_state(&self.read().await?.wakes, home))
    }

    /// Stores the owed results (and overflow marker) of `home` as one new batch under a fresh wake
    /// id, before its wake is submitted; `None` when none are owed.
    pub async fn batch_wake(&self, home: &str) -> Result<Option<Value>, String> {
        let home = home.to_string();
        self.update(move |mut doc, _| {
            let state = wake_state(&doc.wakes, &home);
            if state.owed.is_empty() && state.overflow.is_none() {
                return Ok((None, None));
            }
            let mut batch = Map::new();
            batch.insert("id".into(), json!(format!("awake_{}", uuid::Uuid::new_v4())));
            batch.insert("runIds".into(), Value::Array(state.owed));
            if let Some(overflow) = state.overflow {
                batch.insert("overflow".into(), overflow);
            }
            let batch = Value::Object(batch);
            with_wake_state(&mut doc, &home, WakeState { owed: Vec::new(), batches: [state.batches, vec![batch.clone()]].concat(), overflow: None });
            Ok((Some(doc), Some(batch)))
        })
        .await
    }

    /// The wake of batch `batch_id` was taken (or is moot): it is owed no more.
    pub async fn woke(&self, home: &str, batch_id: &str) -> Result<(), String> {
        let (home, batch_id) = (home.to_string(), batch_id.to_string());
        self.update(move |mut doc, _| {
            let mut state = wake_state(&doc.wakes, &home);
            let before = state.batches.len();
            state.batches.retain(|batch| str_of(batch.get("id")) != batch_id);
            if state.batches.len() == before {
                return Ok((None, ()));
            }
            with_wake_state(&mut doc, &home, state);
            Ok((Some(doc), ()))
        })
        .await
    }

    /// Batch `batch_id`'s relay turn did not finish: it is owed again under a fresh wake id (the
    /// old one names the failed turn), as try `tries`, not before `not_before`. The new batch;
    /// `None` when it is gone.
    pub async fn rewake(&self, home: &str, batch_id: &str, tries: u64, not_before: i64) -> Result<Option<Value>, String> {
        let (home, batch_id) = (home.to_string(), batch_id.to_string());
        self.update(move |mut doc, _| {
            let mut state = wake_state(&doc.wakes, &home);
            let Some(index) = state.batches.iter().position(|batch| str_of(batch.get("id")) == batch_id) else { return Ok((None, None)) };
            // The new try's turn is its own: it follows no earlier turn.
            let mut next = state.batches[index].as_object().cloned().unwrap_or_default();
            next.shift_remove("follows");
            next.insert("id".into(), json!(format!("awake_{}", uuid::Uuid::new_v4())));
            next.insert("tries".into(), json!(tries));
            next.insert("notBefore".into(), json!(not_before));
            let next = Value::Object(next);
            state.batches[index] = next.clone();
            with_wake_state(&mut doc, &home, state);
            Ok((Some(doc), Some(next)))
        })
        .await
    }

    /// Stores `fields` on batch `batch_id` (same wake id).
    pub async fn mark_batch(&self, home: &str, batch_id: &str, fields: Map<String, Value>) -> Result<(), String> {
        let (home, batch_id) = (home.to_string(), batch_id.to_string());
        self.update(move |mut doc, _| {
            let mut state = wake_state(&doc.wakes, &home);
            let Some(batch) = state.batches.iter_mut().find(|batch| str_of(batch.get("id")) == batch_id) else { return Ok((None, ())) };
            if let Some(map) = batch.as_object_mut() {
                map.extend(fields);
            }
            with_wake_state(&mut doc, &home, state);
            Ok((Some(doc), ()))
        })
        .await
    }

    /// Drops every wake obligation of `home` (its owner is gone).
    pub async fn drop_wakes(&self, home: &str) -> Result<(), String> {
        let home = home.to_string();
        self.update(move |mut doc, _| {
            if !doc.wakes.get(&home).is_some_and(truthy) {
                return Ok((None, ()));
            }
            with_wake_state(&mut doc, &home, WakeState::default());
            Ok((Some(doc), ()))
        })
        .await
    }

    /// Every home the rounds, wakes, posted ledger or watches name.
    pub async fn bookkept_homes(&self) -> Result<Vec<String>, String> {
        let doc = self.read().await?;
        let mut homes: Vec<String> = Vec::new();
        let named = doc.rounds.keys().chain(doc.wakes.keys()).chain(doc.delivered.keys()).cloned();
        let watched = doc.watches.values().filter_map(|watch| watch.get("homeSessionId").and_then(Value::as_str).map(String::from));
        for id in named.chain(watched) {
            if !id.is_empty() && !homes.contains(&id) {
                homes.push(id);
            }
        }
        Ok(homes)
    }

    /// Retires the rounds, wakes, posted ledger and watches of the `gone` homes (and, as every
    /// write does, stale round counts).
    pub async fn prune(&self, gone: Vec<String>) -> Result<(), String> {
        let cap = self.caps.round_targets;
        self.update(move |doc, now| {
            let kept = |part: &Section| -> Section { part.iter().filter(|(home, _)| !gone.contains(home)).map(|(k, v)| (k.clone(), v.clone())).collect() };
            let mut next = doc.clone();
            next.rounds = tidy_rounds(&kept(&doc.rounds), now, cap);
            next.wakes = kept(&doc.wakes);
            next.delivered = kept(&doc.delivered);
            next.watches = doc
                .watches
                .iter()
                .filter(|(_, watch)| !watch.get("homeSessionId").and_then(Value::as_str).is_some_and(|home| gone.iter().any(|g| g == home)))
                .map(|(k, v)| (k.clone(), v.clone()))
                .collect();
            Ok(if next.same_as(&doc) { (None, ()) } else { (Some(next), ()) })
        })
        .await
    }

    /// The queued items of `home`.
    pub async fn items(&self, home: &str) -> Result<Vec<Value>, String> {
        Ok(list_of(&self.read().await?.homes, home))
    }

    /// `{ id, count }` of the results dropped for `home`; `None` when none.
    pub async fn omitted(&self, home: &str) -> Result<Option<Value>, String> {
        Ok(self.read().await?.omitted.get(home).filter(|o| truthy(o)).cloned())
    }

    /// Queues `item` for `home`; `options.unwatch` drops those watches in the same write, also
    /// when the item was queued or posted before (a task report of a row still queued folds into
    /// it).
    pub async fn add(&self, home: &str, item: Value, options: AddOptions) -> Result<(), String> {
        let home = home.to_string();
        let (limit, round_targets) = (self.limit, self.caps.round_targets);
        self.update(move |stored, now| {
            let (replaced, item) = without_repeated_progress(&stored, &home, &item, options.progress_posted);
            let doc_changed = replaced.is_some();
            let doc = replaced.unwrap_or_else(|| stored.clone());
            // An answer's update or end that open sends converging on it each report: queued once
            // (folded into the queued end), never reposted.
            let folded = with_folded_report(&doc, &home, &item);
            let next: Option<Doc> = if repeats_progress(&doc, &home, &item) {
                None
            } else if let Some(folded) = folded {
                Some(folded)
            } else if item.get("roundTrip") != Some(&Value::Bool(true)) {
                appended_items(&doc, &home, std::slice::from_ref(&item), limit, 0.0)?
            } else {
                // A task turn's end counts one round trip, once per run id, per home and target:
                // the user's next message in that home starts over (`reset_rounds`), and so does a
                // count idle past `ROUND_TTL_MS`. Only a send made in a bot-descended turn counts.
                let own = fresh_round_counts(doc.rounds.get(&home), now, round_targets);
                let counts = send_depth(Some(&item)) > 0.0;
                let target = super::rows::js_str(item.get("taskSessionId"));
                let round = if counts { count_of(own.get(&target).and_then(|c| c.get("n"))) + 1.0 } else { 0.0 };
                let mut counted_item = item.clone();
                if let Some(map) = counted_item.as_object_mut() {
                    map.insert("round".into(), json_num(round));
                }
                let mut next = appended_items(&doc, &home, &[counted_item], limit, 0.0)?;
                if let (Some(next), true) = (next.as_mut(), counts) {
                    let mut counted = own;
                    counted.insert(target, json!({ "n": json_num(round), "at": json_num(now) }));
                    next.rounds.insert(home.clone(), Value::Object(counted));
                }
                next
            };
            let base_changed = next.is_some() || doc_changed;
            let mut base = next.unwrap_or(doc);
            let mut watches_changed = false;
            if let Some((run_id, turn_id)) = options.progressed.as_ref().filter(|(_, turn)| !turn.is_empty())
                && let Some(marked) = base.watches.get(run_id).filter(|w| truthy(w)).cloned()
                && marked.get("progressed").and_then(Value::as_str) != Some(turn_id.as_str())
            {
                let mut updated = marked;
                if let Some(map) = updated.as_object_mut() {
                    map.insert("progressed".into(), json!(turn_id));
                }
                base.watches.insert(run_id.clone(), updated);
                watches_changed = true;
            }
            for run_id in &options.unwatch {
                if base.watches.get(run_id).is_some_and(truthy) {
                    base.watches.shift_remove(run_id);
                    watches_changed = true;
                }
            }
            Ok(if base_changed || watches_changed { (Some(base), ()) } else { (None, ()) })
        })
        .await
    }

    /// Keeps `watch` (`{ runId, agentId, homeSessionId, taskSessionId, title, target? }`) until its
    /// report is queued, dropping the watches `drop` in the same write. Refused when its home
    /// already keeps `caps.watches`.
    pub async fn watch(&self, watch: Value, drop: Vec<String>) -> Result<(), WatchError> {
        let cap = self.caps.watches;
        let outcome = self
            .update(move |mut doc, _| {
                for run_id in &drop {
                    doc.watches.shift_remove(run_id);
                }
                let home = watch.get("homeSessionId");
                let run_id = watch.get("runId");
                let own = doc.watches.values().filter(|kept| truthy(kept) && kept.get("homeSessionId") == home && kept.get("runId") != run_id).count();
                if own >= cap {
                    return Ok((None, Some(format!("{} already waits on {own} session reports", super::rows::js_str(home)))));
                }
                doc.watches.insert(identity_key(run_id), watch);
                Ok((Some(doc), None))
            })
            .await
            .map_err(WatchError::Failed)?;
        outcome.map_or(Ok(()), |message| Err(WatchError::Cap(message)))
    }

    /// Every stored watch, oldest first; each is a live hand-off (after a restart, this read
    /// brings them back).
    pub async fn watches(&self) -> Result<Vec<Value>, String> {
        let watches: Vec<Value> = self.read().await?.watches.values().cloned().collect();
        for watch in &watches {
            self.handoffs.note(if truthy(watch) { watch } else { &Value::Null });
        }
        Ok(watches)
    }

    /// The watch of `run_id` follows the turn submitted as `submission_id`.
    pub async fn follow_watch(&self, run_id: &str, submission_id: &str) -> Result<(), String> {
        let (run_id, submission_id) = (run_id.to_string(), submission_id.to_string());
        self.update(move |mut doc, _| {
            let Some(watch) = doc.watches.get(&run_id).filter(|w| truthy(w)).cloned() else { return Ok((None, ())) };
            if watch.get("follows").and_then(Value::as_str) == Some(submission_id.as_str()) {
                return Ok((None, ()));
            }
            let mut followed = watch;
            if let Some(map) = followed.as_object_mut() {
                map.insert("follows".into(), json!(submission_id));
            }
            doc.watches.insert(run_id, followed);
            Ok((Some(doc), ()))
        })
        .await
    }

    /// Drops the watch of `run_id` (its turn was never taken).
    pub async fn unwatch(&self, run_id: &str) -> Result<(), String> {
        let run_id = run_id.to_string();
        self.update(move |mut doc, _| {
            if !doc.watches.get(&run_id).is_some_and(truthy) {
                return Ok((None, ()));
            }
            doc.watches.shift_remove(&run_id);
            Ok((Some(doc), ()))
        })
        .await
    }

    /// Keeps `work` (`{ runId, agentId, taskSessionId, owner, at }`): a bot-sent turn that reports
    /// nothing, until its work ends. It is no watch.
    pub async fn own(&self, work: Value) -> Result<(), String> {
        self.update(move |mut doc, _| {
            doc.owned.insert(identity_key(work.get("runId")), work);
            Ok((Some(doc), ()))
        })
        .await
    }

    /// Every stored record of bot-sent work that reports nothing, oldest first.
    pub async fn owned(&self) -> Result<Vec<Value>, String> {
        Ok(self.read().await?.owned.values().cloned().collect())
    }

    /// Drops the records of `run_ids` (their work ended), in one write.
    pub async fn disown(&self, run_ids: Vec<String>) -> Result<(), String> {
        self.update(move |mut doc, _| {
            if !run_ids.iter().any(|run_id| doc.owned.get(run_id).is_some_and(truthy)) {
                return Ok((None, ()));
            }
            for run_id in &run_ids {
                doc.owned.shift_remove(run_id);
            }
            Ok((Some(doc), ()))
        })
        .await
    }

    /// The user spoke in `home`: its round trips count from zero again.
    pub async fn reset_rounds(&self, home: &str) -> Result<(), String> {
        let home = home.to_string();
        self.update(move |mut doc, _| {
            if !doc.rounds.get(&home).is_some_and(truthy) {
                return Ok((None, ()));
            }
            doc.rounds.shift_remove(&home);
            Ok((Some(doc), ()))
        })
        .await
    }

    /// Hands every queued item (and omission) of `from` to `to`.
    pub async fn move_home(&self, from: &str, to: &str) -> Result<(), String> {
        let (from, to) = (from.to_string(), to.to_string());
        let limit = self.limit;
        self.update(move |doc, _| {
            let items = list_of(&doc.homes, &from);
            let dropped = count_of(doc.omitted.get(&from).and_then(|o| o.get("count")));
            let mut next = appended_items(&doc, &to, &items, limit, dropped)?.unwrap_or(doc);
            next.homes.shift_remove(&from);
            next.omitted.shift_remove(&from);
            Ok((Some(next), ()))
        })
        .await
    }

    /// Dequeues the posted `run_ids` (and the posted omission notice `omitted`); those in `wake`
    /// stay owed a wake in the same write, at most `caps.wake_run_ids` run ids per home: past it
    /// the oldest owed collapse into the overflow marker the next batch takes over. The number
    /// collapsed.
    pub async fn remove(&self, home: &str, run_ids: Vec<String>, omitted: Option<Value>, wake: Vec<String>) -> Result<usize, String> {
        let home = home.to_string();
        let cap = self.caps.wake_run_ids;
        self.update(move |mut doc, _| {
            let wake: Vec<Value> = wake.into_iter().map(Value::from).collect();
            let overflowed = owed_wakes(&mut doc, &home, &wake, cap);
            with_dequeued(&mut doc, &home, &run_ids, omitted.as_ref());
            Ok((Some(doc), overflowed))
        })
        .await
    }
}

/// A map key from a run id (`watches[runId]`): JS keys a property by `String(runId)`.
fn identity_key(run_id: Option<&Value>) -> String {
    super::rows::js_str(run_id)
}
