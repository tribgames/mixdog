//! The daemon's durable queue of Lead turns waiting for their provider quota to reset, with the
//! Goal each quota failure suspended (`runtime/shared/quota-resume-store.mjs`).
//!
//! One process owns the file; every session runtime it hosts and the resume scheduler share this
//! one copy, and every change is written through before it becomes the state, so a restart finds
//! the queue as the last change left it. Each change is one job on the durability lane that
//! stages, writes and commits (Node's are synchronous): a cancel and a fire never interleave
//! inside one, and each entry carries a generation so a stale holder can neither fire nor defer
//! a replaced entry.
//!
//! Entry: `sessionId`, `turnKey`, `provider`, `model`, `resetAt` (when the scheduler next takes a
//! usage reading), `attempts`, `generation`, and the session's own route when the resume was
//! queued (`routeProvider`, `routeModel`): a fire on any other route is not the resume of this
//! failure. The global auto-resume setting is the config's (`quotaResume.autoResume`).

use std::panic::{AssertUnwindSafe, catch_unwind};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, PoisonError};

use mixdog_js::js_trim;
use mixdog_rt::{CancellationToken, DurabilityIo, InLane};
use mixdog_statefile::{Opts, read_content, write_json};
use serde_json::{Map, Number, Value, json};

use crate::support::on_lane;

pub const QUOTA_RESUME_FILE: &str = "quota-resume.json";
const FILE_VERSION: i64 = 1;
const MAX_SAFE: f64 = 9_007_199_254_740_991.0;

/// A change the store refused or could not write; the state is as it was before.
#[derive(Clone, PartialEq, Eq, Debug, thiserror::Error)]
pub enum QuotaError {
    /// Node's `TypeError`: the request lacks what an entry needs.
    #[error("{0}")]
    Type(String),
    #[error("{0}")]
    Io(String),
}

#[derive(Clone, PartialEq, Debug)]
pub struct Entry {
    pub session_id: String,
    pub turn_key: String,
    pub provider: String,
    pub model: String,
    /// A finite JS number, kept as the file or the caller gave it.
    pub reset_at: Number,
    pub attempts: u64,
    pub generation: u64,
    pub route_provider: String,
    pub route_model: String,
}

impl Entry {
    pub fn to_value(&self) -> Value {
        json!({
            "sessionId": self.session_id, "turnKey": self.turn_key, "provider": self.provider,
            "model": self.model, "resetAt": self.reset_at, "attempts": self.attempts,
            "generation": self.generation, "routeProvider": self.route_provider, "routeModel": self.route_model,
        })
    }

    /// The session snapshot's `quotaResume` value (`publicQuotaResume`).
    pub fn public(&self) -> Value {
        json!({
            "state": "waiting", "turnKey": self.turn_key, "provider": self.provider,
            "model": self.model, "resetAt": self.reset_at, "attempts": self.attempts,
        })
    }
}

/// The Goal one quota failure moved from active to usage_limited, the only Goal a resume may
/// revive.
#[derive(Clone, PartialEq, Debug)]
pub struct Suspension {
    pub session_id: String,
    pub turn_key: String,
    pub goal_id: String,
}

#[derive(Clone, Default)]
struct State {
    generation: i64,
    entries: Vec<Entry>,
    suspensions: Vec<Suspension>,
}

/// `text(value)`: a string, trimmed; anything else is empty.
fn text(value: Option<&Value>) -> String {
    value.and_then(Value::as_str).map(js_trim).unwrap_or_default().to_owned()
}

/// `Number.isSafeInteger`.
fn safe_integer(value: Option<&Value>) -> Option<i64> {
    let n = value?.as_f64()?;
    (value?.is_number() && n.fract() == 0.0 && n.abs() <= MAX_SAFE).then_some(n as i64)
}

fn string_or_empty(value: Option<&Value>) -> String {
    value.and_then(Value::as_str).unwrap_or_default().to_owned()
}

/// `normalizeEntry`.
fn normalize_entry(value: &Value) -> Option<Entry> {
    let get = |key: &str| value.get(key);
    let entry = Entry {
        session_id: text(get("sessionId")),
        turn_key: text(get("turnKey")),
        provider: text(get("provider")),
        model: string_or_empty(get("model")),
        reset_at: match get("resetAt") {
            Some(Value::Number(n)) => n.clone(),
            _ => return None,
        },
        attempts: safe_integer(get("attempts")).filter(|n| *n >= 0).unwrap_or(0) as u64,
        generation: u64::try_from(safe_integer(get("generation")).filter(|g| *g >= 1)?).ok()?,
        route_provider: string_or_empty(get("routeProvider")),
        route_model: string_or_empty(get("routeModel")),
    };
    (!entry.session_id.is_empty() && !entry.turn_key.is_empty() && !entry.provider.is_empty()).then_some(entry)
}

fn normalize_suspension(value: &Value) -> Option<Suspension> {
    let suspension = Suspension {
        session_id: text(value.get("sessionId")),
        turn_key: text(value.get("turnKey")),
        goal_id: text(value.get("goalId")),
    };
    (!suspension.session_id.is_empty() && !suspension.turn_key.is_empty() && !suspension.goal_id.is_empty()).then_some(suspension)
}

/// A JS `Map.set`: replaces in place, else appends.
fn set_entry(entries: &mut Vec<Entry>, entry: Entry) {
    match entries.iter_mut().find(|e| e.session_id == entry.session_id) {
        Some(slot) => *slot = entry,
        None => entries.push(entry),
    }
}

fn set_suspension(suspensions: &mut Vec<Suspension>, suspension: Suspension) {
    match suspensions.iter_mut().find(|s| s.session_id == suspension.session_id) {
        Some(slot) => *slot = suspension,
        None => suspensions.push(suspension),
    }
}

/// `load()` of a file's parsed document.
fn state_of(raw: Option<&Value>) -> State {
    let mut state = State::default();
    let list = |key: &str| raw.and_then(|r| r.get(key)).and_then(Value::as_array).cloned().unwrap_or_default();
    for value in list("entries") {
        if let Some(entry) = normalize_entry(&value) {
            set_entry(&mut state.entries, entry);
        }
    }
    for value in list("suspensions") {
        if let Some(suspension) = normalize_suspension(&value) {
            set_suspension(&mut state.suspensions, suspension);
        }
    }
    let held = safe_integer(raw.and_then(|r| r.get("generation"))).unwrap_or(0);
    state.generation = state.entries.iter().map(|e| e.generation as i64).fold(held, i64::max);
    state
}

fn document(state: &State) -> Value {
    let mut doc = Map::new();
    doc.insert("version".into(), json!(FILE_VERSION));
    doc.insert("generation".into(), json!(state.generation));
    doc.insert("entries".into(), Value::Array(state.entries.iter().map(Entry::to_value).collect()));
    doc.insert(
        "suspensions".into(),
        Value::Array(
            state
                .suspensions
                .iter()
                .map(|s| json!({ "sessionId": s.session_id, "turnKey": s.turn_key, "goalId": s.goal_id }))
                .collect(),
        ),
    );
    Value::Object(doc)
}

/// Reads the file as Node does: UTF-8 text, parsed. A missing or torn file is an empty queue (a
/// byte order mark is a syntax error here, as it is there); an unreadable one is not.
fn read_state(path: &Path) -> Result<State, QuotaError> {
    let content = read_content(path).map_err(|e| QuotaError::Io(e.to_string()))?;
    let raw = content.and_then(|bytes| mixdog_js::json_parse(&String::from_utf8_lossy(&bytes)).ok());
    Ok(state_of(raw.as_ref()))
}

type Listener = Arc<dyn Fn(Option<&str>) + Send + Sync>;

/// Dropping it stops the notifications.
pub struct Subscription {
    id: u64,
    inner: Arc<Inner>,
}

impl Drop for Subscription {
    fn drop(&mut self) {
        self.inner.listeners.lock().unwrap_or_else(PoisonError::into_inner).retain(|(id, _)| *id != self.id);
    }
}

/// What one change decided: the state to write (none: nothing changes), the answer, and who to
/// tell (`Some(None)`: every entry changed).
struct Staged<R> {
    next: Option<State>,
    value: R,
    notice: Option<Option<String>>,
    /// The one change memory may hold ahead of the disk (a Goal suspension): a failed write keeps
    /// it here, marked.
    keep_on_failure: bool,
}

impl<R> Staged<R> {
    fn unchanged(value: R) -> Self {
        Self { next: None, value, notice: None, keep_on_failure: false }
    }

    fn changed(next: State, value: R, notice: Option<String>) -> Self {
        Self { next: Some(next), value, notice: Some(notice), keep_on_failure: false }
    }
}

struct Inner {
    path: PathBuf,
    /// The committed state; readers never wait for a write.
    state: Mutex<Arc<State>>,
    /// One change at a time.
    writing: Mutex<()>,
    unsaved: AtomicBool,
    listeners: Mutex<Vec<(u64, Listener)>>,
}

impl Inner {
    /// Tells the listeners of a committed change. Called while the change still holds `writing`,
    /// so the next change cannot commit before they have heard of this one: notifications come
    /// in commit order and a listener reading the store sees the state of its own change.
    fn notify(&self, session_id: Option<&str>) {
        let listeners: Vec<Listener> = self.listeners.lock().unwrap_or_else(PoisonError::into_inner).iter().map(|(_, l)| l.clone()).collect();
        for listener in listeners {
            // The change is already persisted; one failing listener must neither undo it nor
            // keep the others from hearing about it.
            let _ = catch_unwind(AssertUnwindSafe(|| listener(session_id)));
        }
    }

    fn current(&self) -> Arc<State> {
        self.state.lock().unwrap_or_else(PoisonError::into_inner).clone()
    }

    fn install(&self, state: State) {
        *self.state.lock().unwrap_or_else(PoisonError::into_inner) = Arc::new(state);
    }
}

pub struct QuotaResumeStore {
    inner: Arc<Inner>,
    lane: DurabilityIo,
    cancel: CancellationToken,
    next_listener: AtomicU64,
}

fn io(error: impl std::fmt::Debug) -> QuotaError {
    QuotaError::Io(format!("{error:?}"))
}

impl QuotaResumeStore {
    /// Opens the queue of `dir/quota-resume.json`.
    pub async fn open(dir: &Path, lane: DurabilityIo, cancel: CancellationToken) -> Result<Self, QuotaError> {
        let path = dir.join(QUOTA_RESUME_FILE);
        let read = path.clone();
        let state = on_lane(lane, &cancel, move |_| read_state(&read)).await.map_err(io)??;
        Ok(Self {
            inner: Arc::new(Inner {
                path,
                state: Mutex::new(Arc::new(state)),
                writing: Mutex::new(()),
                unsaved: AtomicBool::new(false),
                listeners: Mutex::default(),
            }),
            lane,
            cancel,
            next_listener: AtomicU64::new(0),
        })
    }

    /// `reloadQuotaResumeStore`: the state is read from the file again (a daemon restart).
    pub async fn reload(&self) -> Result<(), QuotaError> {
        let inner = self.inner.clone();
        on_lane(self.lane, &self.cancel, move |_| {
            let _writing = inner.writing.lock().unwrap_or_else(PoisonError::into_inner);
            let state = read_state(&inner.path)?;
            inner.install(state);
            inner.unsaved.store(false, Ordering::SeqCst);
            Ok(())
        })
        .await
        .map_err(io)?
    }

    /// Whether the store holds a Goal suspension its last write did not save.
    pub fn has_unsaved_suspension(&self) -> bool {
        self.inner.unsaved.load(Ordering::SeqCst)
    }

    /// Listener receives the changed session id, or `None` when every entry changed.
    pub fn subscribe(&self, listener: impl Fn(Option<&str>) + Send + Sync + 'static) -> Subscription {
        let id = self.next_listener.fetch_add(1, Ordering::SeqCst);
        self.inner.listeners.lock().unwrap_or_else(PoisonError::into_inner).push((id, Arc::new(listener)));
        Subscription { id, inner: self.inner.clone() }
    }

    /// Stages `change` against the committed state, writes what it returns, and only then makes
    /// it the state: memory never holds what the disk does not (a failed write leaves both as
    /// they were, and the caller sees the error).
    async fn change<R: Send + 'static>(
        &self,
        change: impl FnOnce(&State) -> Result<Staged<R>, QuotaError> + Send + 'static,
    ) -> Result<R, QuotaError> {
        let inner = self.inner.clone();
        on_lane(self.lane, &self.cancel, move |lane: &InLane<DurabilityIo>| {
            let _writing = inner.writing.lock().unwrap_or_else(PoisonError::into_inner);
            let staged = change(&inner.current())?;
            if let Some(next) = staged.next {
                let opts = Opts { fsync_dir: true, ..Opts::default() };
                if let Err(error) = write_json(lane, &inner.path, &document(&next), &opts) {
                    if staged.keep_on_failure {
                        inner.install(next);
                        inner.unsaved.store(true, Ordering::SeqCst);
                    }
                    return Err(QuotaError::Io(error.to_string()));
                }
                inner.install(next);
                inner.unsaved.store(false, Ordering::SeqCst);
            }
            if let Some(notice) = staged.notice {
                inner.notify(notice.as_deref());
            }
            Ok(staged.value)
        })
        .await
        .map_err(io)?
    }

    pub fn entry(&self, session_id: &str) -> Option<Entry> {
        let id = js_trim(session_id);
        self.inner.current().entries.iter().find(|e| e.session_id == id).cloned()
    }

    pub fn list(&self) -> Vec<Entry> {
        self.inner.current().entries.clone()
    }

    /// `rekeyQuotaResumeTurn`: a proven legacy execution and its Goal move together; old fires
    /// are invalidated.
    pub async fn rekey_turn(&self, session_id: &str, from: &str, to: &str) -> Result<bool, QuotaError> {
        let (id, from, to) = (js_trim(session_id).to_owned(), js_trim(from).to_owned(), js_trim(to).to_owned());
        self.change(move |current| {
            if id.is_empty() || from.is_empty() || to.is_empty() || from == to {
                return Ok(Staged::unchanged(false));
            }
            let entry = current.entries.iter().find(|e| e.session_id == id);
            let suspension = current.suspensions.iter().find(|s| s.session_id == id);
            let move_entry = entry.is_some_and(|e| e.turn_key == from);
            let move_goal = suspension.is_some_and(|s| s.turn_key == from);
            if !move_entry && !move_goal {
                return Ok(Staged::unchanged(false));
            }
            let mut next = current.clone();
            next.generation += i64::from(move_entry);
            if let Some(entry) = entry.filter(|_| move_entry) {
                let mut moved = entry.clone();
                moved.turn_key = to.clone();
                moved.generation = next.generation as u64;
                set_entry(&mut next.entries, moved);
            }
            if let Some(suspension) = suspension.filter(|_| move_goal) {
                let mut moved = suspension.clone();
                moved.turn_key = to.clone();
                set_suspension(&mut next.suspensions, moved);
            }
            Ok(Staged::changed(next, true, Some(id.clone())))
        })
        .await
    }

    /// `scheduleQuotaResumeEntry`: queues (or replaces) the session's resume under a fresh
    /// generation. `request`: `sessionId`, `turnKey`, `provider`, `model`, `resetAt`,
    /// `routeProvider`, `routeModel`.
    pub async fn schedule(&self, request: &Value) -> Result<Entry, QuotaError> {
        let mut request = request.clone();
        self.change(move |current| {
            if let Some(map) = request.as_object_mut() {
                map.insert("attempts".into(), json!(0));
                map.insert("generation".into(), json!(current.generation + 1));
            }
            let entry = normalize_entry(&request)
                .ok_or_else(|| QuotaError::Type("quota resume needs a session, turn, provider and reset time".into()))?;
            let mut next = current.clone();
            next.generation = entry.generation as i64;
            set_entry(&mut next.entries, entry.clone());
            let id = entry.session_id.clone();
            Ok(Staged::changed(next, entry, Some(id)))
        })
        .await
    }

    /// `cancelQuotaResumeEntry`: removes the session's entry; with `generation`, only that exact
    /// entry.
    pub async fn cancel(&self, session_id: &str, generation: Option<u64>) -> Result<bool, QuotaError> {
        let id = js_trim(session_id).to_owned();
        self.change(move |current| {
            let Some(at) = current.entries.iter().position(|e| e.session_id == id) else { return Ok(Staged::unchanged(false)) };
            if generation.is_some_and(|g| current.entries[at].generation != g) {
                return Ok(Staged::unchanged(false));
            }
            let mut next = current.clone();
            let removed = next.entries.remove(at);
            Ok(Staged::changed(next, true, Some(removed.session_id)))
        })
        .await
    }

    /// `deferQuotaResumeEntry`: moves the exact entry to a later reading, keeping its generation.
    /// `to` is `{ resetAt, attempts }` (an absent `attempts` resets the count).
    pub async fn defer(&self, session_id: &str, generation: Option<u64>, to: &Value) -> Result<Option<Entry>, QuotaError> {
        let id = js_trim(session_id).to_owned();
        let to = to.clone();
        self.change(move |current| {
            let Some(entry) = current.entries.iter().find(|e| e.session_id == id) else { return Ok(Staged::unchanged(None)) };
            if generation != Some(entry.generation) {
                return Ok(Staged::unchanged(None));
            }
            let mut value = entry.to_value();
            for key in ["resetAt", "attempts"] {
                match to.get(key) {
                    Some(v) => value[key] = v.clone(),
                    None => {
                        value.as_object_mut().expect("an entry is an object").shift_remove(key);
                    }
                }
            }
            let deferred = normalize_entry(&value).ok_or_else(|| QuotaError::Type("quota resume deferral needs a reset time".into()))?;
            let mut next = current.clone();
            set_entry(&mut next.entries, deferred.clone());
            let id = deferred.session_id.clone();
            Ok(Staged::changed(next, Some(deferred), Some(id)))
        })
        .await
    }

    /// `cancelAllQuotaResumeEntries`: how many entries were dropped.
    pub async fn cancel_all(&self) -> Result<usize, QuotaError> {
        self.change(|current| {
            let count = current.entries.len();
            if count == 0 {
                return Ok(Staged::unchanged(0));
            }
            let mut next = current.clone();
            next.entries.clear();
            Ok(Staged::changed(next, count, None))
        })
        .await
    }

    /// `noteQuotaSuspendedGoal`: records the Goal this quota failure suspended (replacing any
    /// earlier note). It is recovery state with no other copy, so a failed write keeps it here,
    /// marked, and the next successful write carries it to the disk.
    pub async fn note_suspended_goal(&self, session_id: &str, turn_key: &str, goal_id: &str) -> Result<bool, QuotaError> {
        let Some(suspension) = normalize_suspension(&json!({ "sessionId": session_id, "turnKey": turn_key, "goalId": goal_id })) else {
            return Ok(false);
        };
        self.change(move |current| {
            let mut next = current.clone();
            set_suspension(&mut next.suspensions, suspension);
            Ok(Staged { next: Some(next), value: true, notice: None, keep_on_failure: true })
        })
        .await
    }

    /// `quotaSuspendedGoal`: the Goal the failure `turn_key` suspended, or empty.
    pub fn suspended_goal(&self, session_id: &str, turn_key: &str) -> String {
        let (id, turn) = (js_trim(session_id), js_trim(turn_key));
        let current = self.inner.current();
        current
            .suspensions
            .iter()
            .find(|s| s.session_id == id && s.turn_key == turn)
            .map(|s| s.goal_id.clone())
            .unwrap_or_default()
    }

    pub async fn forget_suspended_goal(&self, session_id: &str) -> Result<bool, QuotaError> {
        let id = js_trim(session_id).to_owned();
        self.change(move |current| {
            let mut next = current.clone();
            next.suspensions.retain(|s| s.session_id != id);
            if next.suspensions.len() == current.suspensions.len() {
                return Ok(Staged::unchanged(false));
            }
            Ok(Staged { next: Some(next), value: true, notice: None, keep_on_failure: false })
        })
        .await
    }
}

/// The cache-warm gate's pause check (`quotaResumeEntry(sessionId)` is truthy): a session with a
/// queued quota resume is not warmed. The store's own `entry`, no second reader.
impl mixdog_ai::warmer::gate::QuotaResumes for QuotaResumeStore {
    fn paused(&self, session_id: &str) -> bool {
        self.entry(session_id).is_some()
    }
}

/// `isAgentOnlySession`: whether a session record belongs to a delegated agent child (declared
/// agent-only visibility, or a legacy non-Lead agent-owned child with a distinct parent). Such a
/// session never owns a quota resume: the Lead decides retries.
pub fn is_agent_only_session(session: &Value) -> bool {
    let Some(map) = session.as_object() else { return false };
    let lower = |key: &str| js_trim(map.get(key).and_then(Value::as_str).unwrap_or_default()).to_lowercase();
    if lower("visibility") == "agent-only" {
        return true;
    }
    // `text(session.parentSessionId || session.ownerSessionId)`: the first truthy one, then trimmed.
    let truthy = |value: Option<&Value>| match value {
        None | Some(Value::Null | Value::Bool(false)) => false,
        Some(Value::String(s)) => !s.is_empty(),
        Some(Value::Number(n)) => n.as_f64().is_some_and(|n| n != 0.0),
        Some(_) => true,
    };
    let parent = if truthy(map.get("parentSessionId")) { map.get("parentSessionId") } else { map.get("ownerSessionId") };
    let parent = text(parent);
    lower("owner") == "agent" && lower("agent") != "lead" && !parent.is_empty() && parent != text(map.get("id"))
}
