//! The two durable stores of the warmer, kept beside the session records and never in them:
//! `session/prompt-cache-touch-store.mjs` (per session, the last confirmed touch of its cached
//! prefix and the last successful warm use) and `session/prompt-cache-idle-gaps.mjs` (per
//! session, the idle gaps the planner learns from, and the open gap).
//!
//! State lives in memory and is read once when the store opens. Every change is written at once:
//! the snapshot is taken when the change is made and the writes run in order on the durability
//! lane, so a later change never lands before an earlier one. A failed write is reported through
//! `log`; the next change writes again.

use std::io;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};

use mixdog_rt::{DurabilityIo, LaneToken, TaskClass};
use mixdog_statefile::Opts;
use serde_json::{Map, Value, json};
use tokio::sync::{mpsc, oneshot};
use tokio_util::sync::CancellationToken;

use super::plan::Gap;
use crate::registry::warm::WarmUse;

pub type Log = Arc<dyn Fn(&str) + Send + Sync>;
pub type Now = Arc<dyn Fn() -> f64 + Send + Sync>;

enum Msg {
    Write(Value),
    Flush(oneshot::Sender<()>),
}

/// The serialized writer of one store's file.
struct Writer {
    tx: mpsc::UnboundedSender<Msg>,
}

impl Writer {
    fn spawn(path: PathBuf, io: DurabilityIo, log: Log, label: &'static str) -> Self {
        let (tx, mut rx) = mpsc::unbounded_channel::<Msg>();
        mixdog_rt::spawn("cache-warm-store", TaskClass::Work, async move {
            while let Some(msg) = rx.recv().await {
                match msg {
                    Msg::Flush(ack) => {
                        let _ = ack.send(());
                    }
                    Msg::Write(doc) => {
                        if let Err(error) = write(&io, &path, doc).await {
                            log(&format!("{label} write failed ({}): {error}", path.display()));
                        }
                    }
                }
            }
        });
        Self { tx }
    }

    fn write(&self, doc: Value) {
        let _ = self.tx.send(Msg::Write(doc));
    }

    async fn flush(&self, doc: Value) {
        let (ack, done) = oneshot::channel();
        let _ = self.tx.send(Msg::Write(doc));
        let _ = self.tx.send(Msg::Flush(ack));
        let _ = done.await;
    }
}

async fn write(io: &DurabilityIo, path: &Path, doc: Value) -> Result<(), String> {
    let path = path.to_path_buf();
    let opts = Opts { compact: true, ..Opts::default() };
    let job = io
        .submit(&CancellationToken::new(), move |lane| mixdog_statefile::write_json(lane, &path, &doc, &opts))
        .map_err(|e| e.to_string())?;
    job.await.map_err(|e| e.to_string())?.map(drop).map_err(|e| e.to_string())
}

/// `readJsonStateSync(path, { fallback: null })`.
async fn read(io: &DurabilityIo, path: &Path) -> io::Result<Option<Value>> {
    let path = path.to_path_buf();
    let job = io
        .submit(&CancellationToken::new(), move |lane| mixdog_statefile::read_json(lane, &path, None, &Opts::default()))
        .map_err(io::Error::other)?;
    job.await.map_err(io::Error::other)?
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

fn number(value: f64) -> Value {
    if value.fract() == 0.0 && value.abs() < 9_007_199_254_740_992.0 {
        json!(value as i64)
    } else {
        json!(value)
    }
}

fn num(value: Option<&Value>) -> f64 {
    let n = mixdog_js::to_number_of(value);
    if n.is_nan() { 0.0 } else { n }
}

fn entries<'a>(stored: Option<&'a Value>, key: &str) -> impl Iterator<Item = (&'a String, &'a Value)> {
    stored.and_then(|s| s.get(key)).and_then(Value::as_object).into_iter().flat_map(Map::iter)
}

// ---------------------------------------------------------------------------------------------
// The touch store
// ---------------------------------------------------------------------------------------------

/// The last confirmed touch of a session's cached prefix: when a call whose usage showed a read or
/// write on it was sent, the tier it wrote, the account that holds it and the prompt size.
#[derive(Clone, PartialEq, Debug)]
pub struct Touch {
    pub touch_at: f64,
    pub ttl_ms: f64,
    pub prompt_tokens: f64,
    pub account_id: Option<String>,
}

impl Touch {
    fn valid(&self) -> bool {
        self.touch_at > 0.0 && self.ttl_ms > 0.0 && self.prompt_tokens > 0.0
    }

    fn json(&self) -> Value {
        let mut map = Map::new();
        map.insert("touchAt".into(), number(self.touch_at));
        map.insert("ttlMs".into(), number(self.ttl_ms));
        map.insert("promptTokens".into(), number(self.prompt_tokens));
        if let Some(id) = self.account_id.as_ref().filter(|id| !id.is_empty()) {
            map.insert("accountId".into(), json!(id));
        }
        Value::Object(map)
    }
}

/// `warmUseRecord`: a bare time (written before the identity was recorded) keeps its time and
/// matches no route.
fn warm_use_of(value: &Value) -> Option<WarmUse> {
    let record = if value.is_object() { value.clone() } else { json!({ "at": value }) };
    let at = num(record.get("at"));
    if at <= 0.0 {
        return None;
    }
    let text = |key: &str| match record.get(key) {
        None | Some(Value::Null | Value::Bool(false)) => String::new(),
        Some(Value::String(s)) => s.clone(),
        Some(other) => mixdog_js::value_to_string(other),
    };
    Some(WarmUse { at: at as u64, provider: text("provider"), model: text("model"), account_id: text("accountId") })
}

#[derive(Default)]
struct TouchState {
    touches: Vec<(String, Touch)>,
    uses: Vec<(String, WarmUse)>,
}

pub struct TouchStore {
    state: Mutex<TouchState>,
    writer: Writer,
    now: Now,
}

impl TouchStore {
    /// The store backed by `path`, with what the file holds. `now` is the wall clock that expires
    /// touches on write.
    pub async fn open(path: PathBuf, io: DurabilityIo, log: Log, now: Now) -> io::Result<Self> {
        let stored = read(&io, &path).await?;
        let mut state = TouchState::default();
        for (id, value) in entries(stored.as_ref(), "touches") {
            let touch = Touch {
                touch_at: num(value.get("touchAt")),
                ttl_ms: num(value.get("ttlMs")),
                prompt_tokens: num(value.get("promptTokens")),
                account_id: value.get("accountId").filter(|a| !a.is_null() && a.as_str() != Some("")).map(mixdog_js::value_to_string),
            };
            if value.is_object() && touch.valid() {
                state.touches.push((id.clone(), touch));
            }
        }
        for (id, value) in entries(stored.as_ref(), "warmUses") {
            if let Some(record) = warm_use_of(value) {
                state.uses.push((id.clone(), record));
            }
        }
        Ok(Self { state: Mutex::new(state), writer: Writer::spawn(path, io, log, "touch store"), now })
    }

    /// The document of the state now, expired touches dropped.
    fn snapshot(&self, state: &mut TouchState) -> Value {
        let now = (self.now)();
        state.touches.retain(|(_, t)| t.touch_at + t.ttl_ms > now);
        let touches: Map<String, Value> = state.touches.iter().map(|(id, t)| (id.clone(), t.json())).collect();
        let uses: Map<String, Value> = state
            .uses
            .iter()
            .map(|(id, u)| (id.clone(), json!({ "at": u.at, "provider": u.provider, "model": u.model, "accountId": u.account_id })))
            .collect();
        json!({ "version": 1, "touches": touches, "warmUses": uses })
    }

    fn changed(&self, mut state: MutexGuard<'_, TouchState>) {
        let doc = self.snapshot(&mut state);
        drop(state);
        self.writer.write(doc);
    }

    /// The session's last confirmed touch.
    pub fn get(&self, session_id: &str) -> Option<Touch> {
        lock(&self.state).touches.iter().find(|(id, _)| id == session_id).map(|(_, t)| t.clone())
    }

    /// The sessions holding a touch.
    pub fn ids(&self) -> Vec<String> {
        lock(&self.state).touches.iter().map(|(id, _)| id.clone()).collect()
    }

    /// Records a confirmed touch.
    pub fn record(&self, session_id: &str, touch: Touch) {
        if session_id.is_empty() || !touch.valid() {
            return;
        }
        let mut state = lock(&self.state);
        let touch = Touch { account_id: touch.account_id.filter(|a| !a.is_empty()), ..touch };
        match state.touches.iter_mut().find(|(id, _)| id == session_id) {
            Some(slot) => slot.1 = touch,
            None => state.touches.push((session_id.to_owned(), touch)),
        }
        self.changed(state);
    }

    /// The session's cached prefix is gone (compaction, clear, close, miss).
    pub fn forget(&self, session_id: &str) {
        let mut state = lock(&self.state);
        let before = state.touches.len();
        state.touches.retain(|(id, _)| id != session_id);
        if state.touches.len() != before {
            self.changed(state);
        }
    }

    /// Every session's last successful warm use.
    pub fn warm_uses(&self) -> Vec<(String, WarmUse)> {
        lock(&self.state).uses.clone()
    }

    /// The session's last successful warm use.
    pub fn warm_use(&self, session_id: &str) -> Option<WarmUse> {
        lock(&self.state).uses.iter().find(|(id, _)| id == session_id).map(|(_, u)| u.clone())
    }

    /// A warm read the session's cache without writing at `at`, on the route and account of `use_`.
    pub fn record_warm_use(&self, session_id: &str, warm: WarmUse) {
        if session_id.is_empty() || warm.at == 0 {
            return;
        }
        let mut state = lock(&self.state);
        match state.uses.iter_mut().find(|(id, _)| id == session_id) {
            Some(slot) => slot.1 = warm,
            None => state.uses.push((session_id.to_owned(), warm)),
        }
        self.changed(state);
    }

    /// The session's own activity supersedes its warm use, or its cached conversation is gone.
    pub fn forget_warm_use(&self, session_id: &str) {
        let mut state = lock(&self.state);
        let before = state.uses.len();
        state.uses.retain(|(id, _)| id != session_id);
        if state.uses.len() != before {
            self.changed(state);
        }
    }

    /// Writes pending changes now.
    pub async fn flush(&self) {
        let doc = {
            let mut state = lock(&self.state);
            self.snapshot(&mut state)
        };
        self.writer.flush(doc).await;
    }
}

// ---------------------------------------------------------------------------------------------
// The idle-gap store
// ---------------------------------------------------------------------------------------------

#[derive(Default)]
struct Entry {
    /// When the session's open gap started, or 0.
    open: f64,
    gaps: Vec<Gap>,
}

/// How a gap store keeps what it learns.
#[derive(Clone, Copy)]
pub struct GapRules {
    /// How long gaps are kept.
    pub lookback_ms: f64,
    /// A gap reaching it is recorded as censored there.
    pub window_ms: f64,
    /// Shorter gaps are not kept: no refresh point lies inside them.
    pub min_ms: f64,
}

pub struct GapStore {
    sessions: Mutex<Vec<(String, Entry)>>,
    rules: GapRules,
    writer: Writer,
    now: Now,
}

impl GapStore {
    pub async fn open(path: PathBuf, io: DurabilityIo, rules: GapRules, log: Log, now: Now) -> io::Result<Self> {
        let stored = read(&io, &path).await?;
        let mut sessions = Vec::new();
        for (id, value) in entries(stored.as_ref(), "sessions") {
            let gaps: Vec<Gap> = value
                .get("gaps")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .filter(|g| num(g.get("at")) > 0.0 && num(g.get("ms")) > 0.0)
                .map(|g| Gap { at: num(g.get("at")), ms: num(g.get("ms")), censored: g.get("censored").is_some_and(truthy) })
                .collect();
            let open = num(value.get("open"));
            let open = if open > 0.0 { open } else { 0.0 };
            if !gaps.is_empty() || open != 0.0 {
                sessions.push((id.clone(), Entry { open, gaps }));
            }
        }
        Ok(Self { sessions: Mutex::new(sessions), rules, writer: Writer::spawn(path, io, log, "idle-gap store"), now })
    }

    fn snapshot(&self, sessions: &mut Vec<(String, Entry)>) -> Value {
        let since = (self.now)() - self.rules.lookback_ms;
        for (_, entry) in sessions.iter_mut() {
            entry.gaps.retain(|g| g.at >= since);
            if entry.open != 0.0 && entry.open < since {
                entry.open = 0.0;
            }
        }
        sessions.retain(|(_, e)| !e.gaps.is_empty() || e.open != 0.0);
        let out: Map<String, Value> = sessions
            .iter()
            .map(|(id, entry)| {
                let mut map = Map::new();
                if entry.open != 0.0 {
                    map.insert("open".into(), number(entry.open));
                }
                let gaps = entry
                    .gaps
                    .iter()
                    .map(|g| {
                        let mut gap = Map::new();
                        gap.insert("at".into(), number(g.at));
                        gap.insert("ms".into(), number(g.ms));
                        if g.censored {
                            gap.insert("censored".into(), Value::Bool(true));
                        }
                        Value::Object(gap)
                    })
                    .collect();
                map.insert("gaps".into(), Value::Array(gaps));
                (id.clone(), Value::Object(map))
            })
            .collect();
        json!({ "version": 1, "sessions": out })
    }

    fn changed(&self, mut sessions: MutexGuard<'_, Vec<(String, Entry)>>) {
        let doc = self.snapshot(&mut sessions);
        drop(sessions);
        self.writer.write(doc);
    }

    /// The session went idle: its last real request used the cache at `at`.
    pub fn open_gap(&self, session_id: &str, at: f64) {
        if session_id.is_empty() || at.is_nan() || at <= 0.0 {
            return;
        }
        let mut sessions = lock(&self.sessions);
        match sessions.iter_mut().find(|(id, _)| id == session_id) {
            Some((_, entry)) => entry.open = at,
            None => sessions.push((session_id.to_owned(), Entry { open: at, gaps: Vec::new() })),
        }
        self.changed(sessions);
    }

    /// A real request arrived at `at`: the open gap closes as a return, or as censored at the
    /// window when it outlasted it. The kept gap, or `None` (none open, or too short to keep).
    pub fn close(&self, session_id: &str, at: f64) -> Option<Gap> {
        let mut sessions = lock(&self.sessions);
        let (_, entry) = sessions.iter_mut().find(|(id, _)| id == session_id).filter(|(_, e)| e.open != 0.0)?;
        let start = entry.open;
        entry.open = 0.0;
        let ms = at - start;
        let gap = if ms >= self.rules.window_ms {
            Some(Gap { at: start, ms: self.rules.window_ms, censored: true })
        } else if ms > self.rules.min_ms {
            Some(Gap { at: start, ms, censored: false })
        } else {
            None
        };
        entry.gaps.extend(gap);
        self.changed(sessions);
        gap
    }

    /// The session's kept gaps of the lookback, oldest first.
    pub fn gaps(&self, session_id: &str) -> Vec<Gap> {
        let since = (self.now)() - self.rules.lookback_ms;
        lock(&self.sessions)
            .iter()
            .find(|(id, _)| id == session_id)
            .map(|(_, e)| e.gaps.iter().filter(|g| g.at >= since).copied().collect())
            .unwrap_or_default()
    }

    /// When the session's open gap started, or 0.
    pub fn open_at(&self, session_id: &str) -> f64 {
        lock(&self.sessions).iter().find(|(id, _)| id == session_id).map_or(0.0, |(_, e)| e.open)
    }

    /// The session is gone: drop everything it learned.
    pub fn forget(&self, session_id: &str) {
        let mut sessions = lock(&self.sessions);
        let before = sessions.len();
        sessions.retain(|(id, _)| id != session_id);
        if sessions.len() != before {
            self.changed(sessions);
        }
    }

    /// Writes pending changes now.
    pub async fn flush(&self) {
        let doc = {
            let mut sessions = lock(&self.sessions);
            self.snapshot(&mut sessions)
        };
        self.writer.flush(doc).await;
    }
}

fn truthy(value: &Value) -> bool {
    match value {
        Value::Null | Value::Bool(false) => false,
        Value::String(s) => !s.is_empty(),
        Value::Number(n) => n.as_f64().is_some_and(|n| n != 0.0),
        _ => true,
    }
}
