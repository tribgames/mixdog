//! The heartbeat's state file (`heartbeat.json`, mixy-heartbeat.mjs `updateState`): the check's
//! watermark, the digest hash, the routines' report state, the proposals Mixy made and the
//! hidden sessions whose close did not land.
//!
//! The daemon owns the file, so it holds the state in memory with every change applied to it.
//! A change is queued, one drain applies the queue in order and publishes the state, and every
//! caller of a round resolves once that state is on disk (or rejects when the write failed: the
//! state then stays dirty and the next round writes it again). What a reader sees is the state
//! plus the changes queued and not yet applied.
//!
//! Node also flushes a dirty state synchronously from a process `exit` hook; here shutdown
//! awaits [`HeartbeatStore::flush`] instead (decisions.md, "Heartbeat state flush").

use std::sync::{Arc, Mutex, PoisonError};

use mixdog_js::{json_number, to_number_of};
use mixdog_rt::TaskClass;
use serde_json::{Map, Value, json};
use tokio::sync::oneshot;

use super::digest::quoted_text;
use crate::bots::state_json::StateJson;

pub const HOUR_MS: i64 = 60 * 60_000;
pub const SUGGESTION_TTL_MS: i64 = 72 * HOUR_MS;
pub const MAX_PENDING: usize = 5;
/// Each reviewed session's cursor and note, kept this long and at most this many.
pub const REVIEW_TTL_MS: i64 = 7 * 24 * HOUR_MS;
pub const MAX_REVIEWS: usize = 200;
/// Mixy's last delivered heartbeat message is cut to this.
pub const REPORT_LIMIT: usize = 1000;
const SUGGESTION_LIMIT: usize = 300;

#[derive(Clone, Debug, PartialEq)]
pub struct Suggestion {
    pub key: String,
    pub text: String,
    pub at: i64,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Review {
    pub at: i64,
    pub head: String,
    pub note: String,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Report {
    pub at: i64,
    pub text: String,
}

#[derive(Clone, Debug, PartialEq, Default)]
pub struct HeartbeatState {
    /// The collection watermark (the last handled check) and the last check begun.
    pub last_beat_at: i64,
    pub last_attempt_at: i64,
    /// The user's latest accepted turn, and their latest operation inside the desktop app.
    pub last_user_input_at: i64,
    pub last_app_input_at: i64,
    /// Approvals waiting at the last handled check.
    pub approvals: u64,
    pub last_hash: String,
    /// Per `kind:name`: `{ at, paused }` of the last report.
    pub routines: Map<String, Value>,
    pub pending: Vec<Suggestion>,
    pub dismissed: Vec<String>,
    /// Hidden sessions whose close did not land; each tick closes them again.
    pub unreleased: Vec<String>,
    /// Per session: the newest item a review saw and its note, in insertion order.
    pub reviews: Vec<(String, Review)>,
    pub last_report: Option<Report>,
}

/// `Number(value) || 0`.
pub(super) fn millis(value: Option<&Value>) -> i64 {
    let number = to_number_of(value);
    if number.is_nan() { 0 } else { number as i64 }
}

fn strings(value: Option<&Value>, keep: impl Fn(&Value) -> Option<String>) -> Vec<String> {
    value.and_then(Value::as_array).map(|rows| rows.iter().filter_map(keep).collect()).unwrap_or_default()
}

impl HeartbeatState {
    /// `normalizeState`: whatever the file held, as a state.
    pub fn from_value(raw: &Value) -> Self {
        let value = raw.as_object().cloned().unwrap_or_default();
        let approvals = match value.get("approvals").and_then(Value::as_f64) {
            Some(n) if n.fract() == 0.0 && n > 0.0 => n as u64,
            _ => 0,
        };
        let pending = value
            .get("pending")
            .and_then(Value::as_array)
            .map(|rows| {
                rows.iter()
                    .filter_map(|entry| {
                        let key = entry.get("key")?.as_str()?.to_owned();
                        Some(Suggestion {
                            key,
                            text: entry.get("text").and_then(Value::as_str).unwrap_or_default().to_owned(),
                            at: millis(entry.get("at")),
                        })
                    })
                    .collect()
            })
            .unwrap_or_default();
        let reviews = value
            .get("reviews")
            .and_then(Value::as_object)
            .map(|rows| {
                rows.iter()
                    .filter_map(|(id, row)| {
                        let head = row.get("head")?.as_str().filter(|h| !h.is_empty())?;
                        let note = row.get("note")?.as_str()?;
                        Some((id.clone(), Review { at: millis(row.get("at")), head: head.to_owned(), note: note.to_owned() }))
                    })
                    .collect()
            })
            .unwrap_or_default();
        let last_report = value.get("lastReport").and_then(|report| {
            let text = report.get("text")?.as_str().filter(|t| !t.is_empty())?;
            Some(Report { at: millis(report.get("at")), text: text.to_owned() })
        });
        Self {
            last_beat_at: millis(value.get("lastBeatAt")),
            last_attempt_at: millis(value.get("lastAttemptAt")),
            last_user_input_at: millis(value.get("lastUserInputAt")),
            last_app_input_at: millis(value.get("lastAppInputAt")),
            approvals,
            last_hash: value.get("lastHash").and_then(Value::as_str).unwrap_or_default().to_owned(),
            routines: value.get("routines").and_then(Value::as_object).cloned().unwrap_or_default(),
            pending,
            dismissed: strings(value.get("dismissed"), |key| key.as_str().map(str::to_owned)),
            unreleased: strings(value.get("unreleased"), |id| id.as_str().map(str::to_owned)),
            reviews,
            last_report,
        }
    }

    /// The file's document, its keys in `normalizeState`'s order.
    pub fn to_value(&self) -> Value {
        let reviews: Map<String, Value> = self
            .reviews
            .iter()
            .map(|(id, row)| (id.clone(), json!({ "at": json_number(row.at as f64), "head": row.head, "note": row.note })))
            .collect();
        let pending: Vec<Value> = self
            .pending
            .iter()
            .map(|entry| json!({ "key": entry.key, "text": entry.text, "at": json_number(entry.at as f64) }))
            .collect();
        json!({
            "lastBeatAt": json_number(self.last_beat_at as f64),
            "lastAttemptAt": json_number(self.last_attempt_at as f64),
            "lastUserInputAt": json_number(self.last_user_input_at as f64),
            "lastAppInputAt": json_number(self.last_app_input_at as f64),
            "approvals": self.approvals,
            "lastHash": self.last_hash,
            "routines": Value::Object(self.routines.clone()),
            "pending": pending,
            "dismissed": self.dismissed,
            "unreleased": self.unreleased,
            "reviews": Value::Object(reviews),
            "lastReport": self.last_report.as_ref().map_or(Value::Null, |r| json!({ "at": json_number(r.at as f64), "text": r.text })),
        })
    }

    /// The proposals younger than the suggestion TTL.
    pub fn live_pending(&self, at: i64) -> Vec<Suggestion> {
        self.pending.iter().filter(|entry| at - entry.at < SUGGESTION_TTL_MS).cloned().collect()
    }

    fn prune_suggestions(&mut self, at: i64) {
        self.pending = self.live_pending(at);
    }

    /// Drops review cursors past the TTL, then keeps the newest `MAX_REVIEWS`.
    fn prune_reviews(&mut self, at: i64) {
        self.reviews.retain(|(_, row)| at - row.at < REVIEW_TTL_MS);
        // Stable, newest first, as `Array.prototype.sort` is.
        self.reviews.sort_by_key(|(_, row)| std::cmp::Reverse(row.at));
        self.reviews.truncate(MAX_REVIEWS);
    }

    fn set_review(&mut self, id: &str, row: Review) {
        match self.reviews.iter_mut().find(|(known, _)| known == id) {
            Some((_, slot)) => *slot = row,
            None => self.reviews.push((id.to_owned(), row)),
        }
    }
}

/// What a handled check records (`commit` in `beat`).
#[derive(Clone, Debug, PartialEq)]
pub struct Commit {
    pub at: i64,
    /// The whole digest is handled: watermark, hash, approvals and the review cursors advance.
    pub seen: bool,
    pub hash: String,
    pub approvals: u64,
    /// `(session id, head, note)` of each review to keep.
    pub cursors: Vec<(String, String, String)>,
    /// The message Mixy delivered; empty for none.
    pub report: String,
    /// Routines to close: a success, or gone.
    pub closed: Vec<String>,
    /// Routines reported: `(kind:name, paused)`.
    pub reported: Vec<(String, bool)>,
}

/// A change to the state. Each one is a function of the state and the values it captured, so a
/// reader can apply the queued ones to a copy.
#[derive(Clone, Debug, PartialEq)]
pub enum Change {
    /// Writes the state as it is (the flush of a dirty state).
    Settle,
    /// A turn the user sent (`noteUserTurn`).
    UserTurn { time: i64 },
    /// The user operated the desktop app (`noteUserInput`).
    AppInput { value: i64 },
    Arm { at: i64 },
    ClearWatermark,
    Attempt { at: i64 },
    KeepUnreleased { id: String },
    Released { ids: Vec<String> },
    /// `recordSuggestion`: `dismissed` declines the proposal for good.
    Suggest { key: String, text: String, dismissed: bool, at: i64 },
    Commit(Commit),
}

impl Change {
    /// Applies the change; the receipt is `Null` except for a suggestion's.
    pub fn apply(&self, state: &mut HeartbeatState) -> Value {
        match self {
            Change::Settle => {}
            Change::UserTurn { time } => state.last_user_input_at = state.last_user_input_at.max(*time),
            Change::AppInput { value } => state.last_app_input_at = state.last_app_input_at.max(*value),
            Change::Arm { at } => state.last_beat_at = *at,
            Change::ClearWatermark => state.last_beat_at = 0,
            Change::Attempt { at } => state.last_attempt_at = *at,
            Change::KeepUnreleased { id } => {
                state.unreleased.retain(|kept| kept != id);
                state.unreleased.push(id.clone());
            }
            Change::Released { ids } => state.unreleased.retain(|id| !ids.contains(id)),
            Change::Suggest { key, text, dismissed, at } => return suggest(state, key, text, *dismissed, *at),
            Change::Commit(commit) => commit_check(state, commit),
        }
        Value::Null
    }
}

fn suggest(state: &mut HeartbeatState, key: &str, text: &str, dismissed: bool, at: i64) -> Value {
    state.prune_suggestions(at);
    if dismissed {
        state.pending.retain(|entry| entry.key != key);
        if !state.dismissed.iter().any(|k| k == key) {
            state.dismissed.push(key.to_owned());
        }
        return json!({ "key": key, "dismissed": true, "note": "It is never offered again." });
    }
    if state.dismissed.iter().any(|k| k == key) {
        return json!({ "key": key, "recorded": false, "reason": "the user declined this proposal: never offer it again" });
    }
    if let Some(known) = state.pending.iter_mut().find(|entry| entry.key == key) {
        known.at = at;
        if !text.is_empty() {
            known.text = text.to_owned();
        }
        return json!({ "key": key, "recorded": true, "refreshed": true });
    }
    if state.pending.len() >= MAX_PENDING {
        return json!({
            "key": key,
            "recorded": false,
            "reason": format!("{MAX_PENDING} proposals already wait for the user: offer this one later"),
        });
    }
    state.pending.push(Suggestion { key: key.to_owned(), text: text.to_owned(), at });
    json!({ "key": key, "recorded": true })
}

fn commit_check(state: &mut HeartbeatState, commit: &Commit) {
    let at = commit.at;
    if commit.seen {
        state.last_beat_at = at;
        state.last_hash = commit.hash.clone();
        state.approvals = commit.approvals;
        for (id, head, note) in &commit.cursors {
            state.set_review(id, Review { at, head: head.clone(), note: note.clone() });
        }
    }
    if !commit.report.is_empty() {
        state.last_report = Some(Report { at, text: quoted_text(&commit.report, REPORT_LIMIT) });
    }
    for key in &commit.closed {
        state.routines.shift_remove(key);
    }
    for (key, paused) in &commit.reported {
        state.routines.insert(key.clone(), json!({ "at": json_number(at as f64), "paused": paused }));
    }
    state.prune_suggestions(at);
    state.prune_reviews(at);
}

/// The proposal text a `recordSuggestion` stores: one quoted line.
pub fn suggestion_line(text: &str) -> String {
    quoted_text(text, SUGGESTION_LIMIT)
}

struct Queued {
    change: Change,
    done: oneshot::Sender<Result<Value, String>>,
}

#[derive(Default)]
struct Inner {
    /// The file's content once loaded, with every applied change; dropped once all is on disk.
    state: Option<HeartbeatState>,
    pending: Vec<Queued>,
    /// `state` is not known to be on disk.
    dirty: bool,
    running: bool,
}

pub struct HeartbeatStore {
    file: StateJson,
    inner: Mutex<Inner>,
}

impl HeartbeatStore {
    pub fn new(file: StateJson) -> Arc<Self> {
        Arc::new(Self { file, inner: Mutex::new(Inner::default()) })
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Inner> {
        self.inner.lock().unwrap_or_else(PoisonError::into_inner)
    }

    async fn load_disk(&self) -> HeartbeatState {
        HeartbeatState::from_value(&self.file.peek_value().await.unwrap_or(Value::Null))
    }

    /// What this process sees: the state it holds (or the file, when it holds none) plus the
    /// changes it queued and has not yet applied.
    pub async fn state(&self) -> HeartbeatState {
        let (held, queued) = {
            let inner = self.lock();
            (inner.state.clone(), inner.pending.iter().map(|q| q.change.clone()).collect::<Vec<_>>())
        };
        let mut state = match held {
            Some(state) => state,
            None => self.load_disk().await,
        };
        for change in &queued {
            change.apply(&mut state);
        }
        state
    }

    /// Queues `change`; resolves with its receipt once the state holding it is on disk, and
    /// rejects when that write fails.
    pub fn update(self: &Arc<Self>, change: Change) -> impl std::future::Future<Output = Result<Value, String>> + Send + 'static {
        let (done, landed) = oneshot::channel();
        let start = {
            let mut inner = self.lock();
            inner.pending.push(Queued { change, done });
            !std::mem::replace(&mut inner.running, true)
        };
        if start {
            let store = Arc::clone(self);
            mixdog_rt::spawn("services.heartbeat.state", TaskClass::Work, async move { store.drain().await });
        }
        async move { landed.await.map_err(|_| "the heartbeat state writer stopped".to_owned())? }
    }

    /// The file's single writer. A round applies every change queued so far and publishes the
    /// state; changes queued meanwhile make the next round, so the last state wins and none is
    /// lost. A failed round does not end the drain while changes wait. The first round also
    /// retries a dirty state an earlier failure left.
    async fn drain(self: Arc<Self>) {
        let mut retry = true;
        loop {
            let (batch, load) = {
                let mut inner = self.lock();
                if inner.pending.is_empty() && !(retry && inner.dirty) {
                    inner.running = false;
                    if !inner.dirty {
                        inner.state = None;
                    }
                    return;
                }
                (std::mem::take(&mut inner.pending), inner.state.is_none())
            };
            retry = false;
            if load {
                let loaded = self.load_disk().await;
                self.lock().state.get_or_insert(loaded);
            }
            let (document, receipts) = {
                let mut inner = self.lock();
                let state = inner.state.as_mut().expect("loaded above");
                let receipts: Vec<Value> = batch.iter().map(|queued| queued.change.apply(state)).collect();
                let document = state.to_value();
                if !batch.is_empty() {
                    inner.dirty = true;
                }
                (document, receipts)
            };
            let written = self.file.write(document).await;
            if written.is_ok() {
                self.lock().dirty = false;
            }
            for (queued, receipt) in batch.into_iter().zip(receipts) {
                let _ = queued.done.send(written.clone().map(|()| receipt));
            }
        }
    }

    /// Resolves once the newest state is on disk, writing it now when no write is running (a
    /// retry after a failure); rejects when that fails. Daemon shutdown awaits this once the
    /// producers have stopped.
    pub async fn flush(self: &Arc<Self>) -> Result<(), String> {
        let unsettled = {
            let inner = self.lock();
            inner.dirty || !inner.pending.is_empty()
        };
        if unsettled { self.update(Change::Settle).await.map(drop) } else { Ok(()) }
    }
}
