//! `ingest_session` (`session-ingest-runtime.mjs` and `ingest/`): stores a live
//! transcript's conversation as recall entries, so a recall can find what was
//! said before a compaction dropped it from the live window.
//!
//! One call: pick the messages (the whole array is walked so a subset
//! re-ingest reproduces the references a full one would), give every row its
//! occurrence ordinal ([`ordinals`]), insert with `ON CONFLICT DO NOTHING`
//! under a source turn that continues past every stored row of the session,
//! then embed exactly the rows this call inserted and sweep the backlog in the
//! background. Calls for one session run one after another; different
//! sessions run in parallel.

pub mod embed_flush;
pub mod ordinals;

use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use mixdog_js::{js_trim, to_number, value_to_string};
use mixdog_rt::DurabilityIo;
use mixdog_rt::TaskClass;
use serde_json::Value;
use tokio::task::JoinHandle;
use tokio_util::sync::CancellationToken;

use crate::memory::clean::clean_memory_text;
use crate::memory::error::{MemoryError, Result};
use crate::memory::ingest::embed_flush::RawEmbedFlush;
use crate::memory::ingest::ordinals::{OrdinalStore, PriorMatcher, SessionState, identity_hash};
use crate::memory::ingest_shape::{
    normalize_ingest_role, session_message_content_for_ingest, should_exclude_ingest_message, stable_session_source_ref,
};
use crate::memory::pg::db::Db;
use crate::memory::project::resolve_project_scope;

const DEFAULT_LIMIT: f64 = 200.0;
const MAX_LIMIT: f64 = 5000.0;
const FLUSH_LIMIT: usize = 200;

/// The wall clock in ms; tests freeze it.
pub type NowMs = Arc<dyn Fn() -> i64 + Send + Sync>;

pub fn system_now() -> NowMs {
    Arc::new(|| chrono::Utc::now().timestamp_millis())
}

struct Inner {
    db: Db,
    flush: Arc<RawEmbedFlush>,
    session_cwd: Option<PathBuf>,
    now: NowMs,
    /// A session's ingests run in call order, as Node's promise chain.
    chains: mixdog_rt::KeyedGate,
    /// Ends every ingest waiting on `chains` or running under it ([`SessionIngest::close`]).
    cancel: CancellationToken,
    /// The lane the project marker files are read on.
    lane: DurabilityIo,
    ordinals: Mutex<OrdinalStore>,
    /// The tail of the background flush chain: every flush waits for the one
    /// before it, so bursts never run concurrent full-backlog scans.
    flush_tail: Mutex<Option<JoinHandle<()>>>,
}

#[derive(Clone)]
pub struct SessionIngest(Arc<Inner>);

/// A row chosen for storage.
struct Prepared {
    role: &'static str,
    raw_content: String,
    content: String,
    occurrence: u64,
    index: usize,
    untimestamped: bool,
}

/// `m.ts ?? m.timestamp`.
fn raw_ts(message: &Value) -> Option<&Value> {
    message.get("ts").filter(|v| !v.is_null()).or_else(|| message.get("timestamp"))
}

/// A usable original timestamp: a finite number or a non-blank string.
fn is_untimestamped(message: &Value) -> bool {
    match raw_ts(message) {
        Some(Value::Number(_)) => false,
        Some(Value::String(text)) => js_trim(text).is_empty(),
        _ => true,
    }
}

/// `parseTsToMs`: seconds or milliseconds as a number, or a date string; the
/// collection time when it cannot be read.
fn parse_ts_to_ms(value: Option<&Value>, fallback_ms: i64) -> i64 {
    match value {
        Some(Value::Number(n)) => {
            let n = n.as_f64().unwrap_or(0.0);
            (if n < 1e12 { n * 1000.0 } else { n }) as i64
        }
        Some(other) => {
            let parsed = mixdog_js::time::date_parse(&value_to_string(other));
            if parsed.is_finite() { parsed as i64 } else { fallback_ms }
        }
        None => fallback_ms,
    }
}

impl SessionIngest {
    /// `flush` is the database's one flusher (`MemoryStack::embed_flush`): Node shares its
    /// embedding cache state and prune clock per db handle.
    pub fn new(db: Db, flush: Arc<RawEmbedFlush>, session_cwd: Option<PathBuf>, now: NowMs, lane: DurabilityIo) -> Self {
        Self(Arc::new(Inner {
            flush,
            db,
            session_cwd,
            now,
            chains: mixdog_rt::KeyedGate::new(),
            cancel: CancellationToken::new(),
            lane,
            ordinals: Mutex::new(OrdinalStore::default()),
            flush_tail: Mutex::new(None),
        }))
    }

    /// Waits for the background flushes started so far (tests, shutdown).
    pub async fn settle(&self) {
        let tail = self.0.flush_tail.lock().expect("flush tail").take();
        if let Some(tail) = tail {
            let _ = tail.await;
        }
    }

    /// The `ingest_session` action: its reply text.
    pub async fn ingest_session(&self, args: &Value) -> Result<String> {
        let named = |key: &str| args.get(key).filter(|v| truthy(v)).map(value_to_string);
        let session_id = js_trim(
            &named("sessionId").or_else(|| named("session_id")).unwrap_or_else(|| format!("session-{}", (self.0.now)())),
        )
        .to_owned();
        self.0
            .chains
            .run(&session_id, &self.0.cancel, self.ingest_one(&session_id, args))
            .await
            .map_err(|_| MemoryError::Cancelled)?
    }

    /// Shutdown: ingests waiting for their session's turn, and the ones running, end cancelled.
    pub fn close(&self) {
        self.0.cancel.cancel();
    }

    async fn ingest_one(&self, session_id: &str, args: &Value) -> Result<String> {
        let inner = &self.0;
        let messages: &[Value] = args.get("messages").and_then(Value::as_array).map_or(&[], Vec::as_slice);
        let len = messages.len() as f64;
        let limit = if args.get("fullTranscript") == Some(&Value::Bool(true)) {
            len
        } else {
            let n = to_number(args.get("limit").unwrap_or(&Value::Null));
            (if n.is_nan() || n == 0.0 { DEFAULT_LIMIT } else { n }).clamp(1.0, MAX_LIMIT)
        };
        let start = (len - limit).max(0.0);
        let explicit_cwd = args.get("cwd").and_then(Value::as_str);
        let project_id = resolve_project_scope(inner.lane, explicit_cwd, inner.session_cwd.as_deref()).await?;

        let mut state = inner.ordinals.lock().expect("ordinal store").take(session_id);
        state.ensure_durable_loaded(&inner.db, session_id).await;
        let (prepared, considered) = assign_occurrences(session_id, messages, start, &mut state);
        let inserted = self.insert_prepared(session_id, messages, &prepared, project_id.as_deref()).await;
        // A failed insert leaves the durable map unsaved; the in-memory state stays, as it does in Node.
        if inserted.is_ok() {
            state.persist_durable(&inner.db, session_id).await;
        }
        inner.ordinals.lock().expect("ordinal store").put(session_id, state);
        let (count, ids) = inserted?;
        self.flush_after_ingest(ids, args.get("embedWait") == Some(&Value::Bool(false))).await;
        Ok(format!("ingest_session: considered={considered} inserted={count} session={session_id}"))
    }

    /// Inserts the rows. A re-ingested row keeps its turn and consumes none; the
    /// ids returned are exactly the rows this call inserted.
    async fn insert_prepared(
        &self,
        session_id: &str,
        messages: &[Value],
        prepared: &[Prepared],
        project_id: Option<&str>,
    ) -> Result<(usize, Vec<i64>)> {
        let client = self.0.db.client().await?;
        let mut turn: i32 = client
            .query_opt("SELECT COALESCE(MAX(source_turn), 0) FROM entries WHERE session_id = $1", &[&session_id])
            .await
            .ok()
            .flatten()
            .map_or(0, |row| row.get::<_, i32>(0))
            .max(0);
        let now = (self.0.now)();
        let (mut inserted, mut ids) = (0usize, Vec::new());
        for row in prepared {
            let message = &messages[row.index];
            let fallback = now - (messages.len() - row.index) as i64;
            let (ts_ms, time_source) =
                if row.untimestamped { (fallback, "collected") } else { (parse_ts_to_ms(raw_ts(message), now), "recorded") };
            let assigned = turn + 1;
            let source_ref = stable_session_source_ref(session_id, message, row.role, &row.content, row.occurrence as usize);
            let stored = client
                .query(
                    "INSERT INTO entries(ts, role, content, source_ref, session_id, source_turn, project_id, time_source)
                     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
                     ON CONFLICT DO NOTHING
                     RETURNING id",
                    &[&ts_ms, &row.role, &row.raw_content, &source_ref, &session_id, &assigned, &project_id, &time_source],
                )
                .await?;
            if let Some(first) = stored.first() {
                inserted += stored.len();
                ids.push(first.get::<_, i64>(0));
                turn += 1;
            }
        }
        Ok((inserted, ids))
    }

    /// Embeds this call's rows (awaited, so a recall that follows sees them in
    /// its dense leg unless the caller opts out) and sweeps the backlog in the
    /// background. The flush runs to completion or failure; nothing waits on a
    /// clock, and a model that is absent leaves the rows to the text lanes.
    async fn flush_after_ingest(&self, ids: Vec<i64>, defer_own: bool) {
        if !ids.is_empty() {
            let this = self.clone();
            if defer_own {
                // A clear or manual compaction is about to summarise these rows away.
                self.enqueue_flush(async move {
                    this.0.flush.flush(FLUSH_LIMIT, Some(&ids)).await;
                });
            } else {
                // Its own task, so a cancelled caller never leaves a claim transaction open.
                let own = mixdog_rt::spawn("services.memory.ingest-embed", TaskClass::Work, async move {
                    this.0.flush.flush(FLUSH_LIMIT, Some(&ids)).await
                });
                if let Ok(outcome) = own.await
                    && outcome.attempted > 0
                {
                    tracing::debug!(attempted = outcome.attempted, embedded = outcome.embedded, "[embed] post-ingest raw flush (own)");
                }
            }
        }
        let this = self.clone();
        self.enqueue_flush(async move {
            let outcome = this.0.flush.flush(FLUSH_LIMIT, None).await;
            if outcome.attempted > 0 {
                tracing::debug!(attempted = outcome.attempted, embedded = outcome.embedded, "[embed] post-ingest raw flush (backlog)");
            }
        });
    }

    fn enqueue_flush(&self, work: impl std::future::Future<Output = ()> + Send + 'static) {
        let mut tail = self.0.flush_tail.lock().expect("flush tail");
        let previous = tail.take();
        *tail = Some(mixdog_rt::spawn("services.memory.ingest-flush", TaskClass::Work, async move {
            if let Some(previous) = previous {
                let _ = previous.await;
            }
            work.await;
        }));
    }
}

fn truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(flag) => *flag,
        Value::String(text) => !text.is_empty(),
        Value::Number(n) => n.as_f64().is_some_and(|n| n != 0.0),
        _ => true,
    }
}

/// Walks the whole array and returns the rows at or past `start` with their
/// occurrence ordinals: a row matched in the previous ordered snapshot reuses
/// that occurrence; a first-seen row takes the next free one, lifted to the
/// durable high-water only in a warm call.
fn assign_occurrences(session_id: &str, messages: &[Value], start: f64, state: &mut SessionState) -> (Vec<Prepared>, usize) {
    let warm = state.seeded;
    let mut matcher = PriorMatcher::new(&state.snapshot);
    let mut snapshot = Vec::new();
    let mut prepared = Vec::new();
    let mut considered = 0;
    for (index, message) in messages.iter().enumerate() {
        if !(message.is_object() || message.is_array()) {
            continue;
        }
        let Some(role) = normalize_ingest_role(message.get("role")) else { continue };
        if should_exclude_ingest_message(message) {
            continue;
        }
        let raw_content = session_message_content_for_ingest(message);
        if js_trim(&raw_content).is_empty() {
            continue;
        }
        // The cleaned form is the identity; a row that cleans to nothing keeps its full text.
        let cleaned = clean_memory_text(&raw_content);
        let content = if cleaned.is_empty() { raw_content.clone() } else { cleaned };
        let key = format!("{role}\u{0}{content}");
        let untimestamped = is_untimestamped(message);
        let hash = untimestamped.then(|| identity_hash(&key));
        let snapshot_key = stable_session_source_ref(session_id, message, role, &content, 0);
        let occurrence = match matcher.take(&snapshot_key) {
            Some(prior) => state.reuse(&key, prior),
            None => {
                let floor = match (&hash, warm) {
                    (Some(hash), true) => state.durable.get(hash).copied().unwrap_or(0),
                    _ => 0,
                };
                state.assign(&key, floor)
            }
        };
        if let (Some(hash), true) = (&hash, occurrence >= 1) {
            // A duplicate untimestamped identity raises its durable next-ordinal; never lowers it.
            if occurrence + 1 > state.durable.get(hash).copied().unwrap_or(0) {
                state.durable.insert(hash.clone(), occurrence + 1);
                state.dirty = true;
            }
        }
        snapshot.push((snapshot_key, occurrence));
        if index as f64 >= start {
            considered += 1;
            prepared.push(Prepared { role, raw_content, content, occurrence, index, untimestamped });
        }
    }
    state.snapshot = snapshot;
    state.seeded = true;
    (prepared, considered)
}
