//! The `trace` schema and the write path behind Node's `/admin/trace-record`
//! (`memory/lib/trace-store.mjs`, `trace-mode.mjs`, `http-router/admin-trace-routes.mjs`), over
//! the memory stack's pool. Node gives the trace its own pool whose `search_path` is
//! `trace, public`; here the memory pool is shared, so every trace statement runs on a connection
//! that sets that path first and `RESET`s it before the connection goes back to the pool.

use std::path::Path;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::PoisonError;
use std::time::Duration;

use bytes::BufMut;
use bytes::BytesMut;
use deadpool_postgres::Object;
use serde_json::Value;
use tokio::sync::Mutex as AsyncMutex;
use tokio_postgres::types::IsNull;
use tokio_postgres::types::ToSql;
use tokio_postgres::types::Type;
use tokio_postgres::types::to_sql_checked;

use super::rows::Column;
use super::rows::Event;
use super::rows::RowError;
use super::rows::TRACE_INSERT_MAX_ROWS;
use super::rows::TraceEventCells;
use super::rows::TraceEventRow;
use super::rows::collect_agent_rows;
use super::rows::insert_trace_events_sql;
use super::rows::llm_columns;
use super::rows::session_columns;
use super::rows::tool_columns;
use super::sql;
use crate::memory::error::MemoryError;
use crate::memory::error::Result;
use crate::memory::pg::db::Db;

const TRACE_ENABLE_MARKER: &str = ".trace-enabled";
const FLUSH_DELAY: Duration = Duration::from_millis(100);
const QUEUE_MAX_ROWS: usize = 500;
const FEED_EVERY: Duration = Duration::from_millis(5000);
const FEED_BATCH: usize = 500;
const QUEUE_MAX_PENDING_EVENTS: usize = 10_000;
const MAX_RETRIES: u32 = 3;
const DELETE_BATCH: i64 = 5000;
const RETENTION_EVERY: Duration = Duration::from_secs(12 * 60 * 60);
const BRIDGE_AND_AGENT_TABLES: [&str; 4] = ["agent_calls", "agent_llm", "bridge_calls", "bridge_llm"];
/// `SELECT pg_advisory_lock(...)` when the non-blocking try lost (`openTraceDatabase`).
const BLOCKING_LOCK: &str = "SELECT pg_advisory_lock(hashtext('mixdog.trace_bootstrap'))";
const LOCK_TIMEOUT: &str = "SET LOCAL lock_timeout = '30s'";

/// Marker file name beside the data directory's other files (`traceMarkerPath`).
pub fn trace_marker_name() -> &'static str {
    TRACE_ENABLE_MARKER
}

/// `traceEnabled(dataDir)`: `MIXDOG_TRACE` 1/true/on/yes is on, any other non-empty value off,
/// else whether the marker file exists (`marker_exists`, checked by the caller on a lane).
pub fn trace_enabled(env_value: Option<&str>, marker_exists: bool) -> bool {
    let configured = mixdog_js::js_to_lowercase(mixdog_js::js_trim(env_value.unwrap_or_default()));
    match configured.as_str() {
        "1" | "true" | "on" | "yes" => true,
        "" => marker_exists,
        _ => false,
    }
}

/// `MIXDOG_TRACE_RETENTION_DAYS`: unset/empty/invalid is 7; 0 keeps everything.
pub fn retention_days(env_value: Option<&str>) -> i64 {
    match env_value {
        None | Some("") => 7,
        Some(raw) => match mixdog_js::string_to_number(raw) {
            n if n.is_finite() && n >= 0.0 => n.floor() as i64,
            _ => 7,
        },
    }
}

/// Binds JSON text to a `json`/`jsonb` parameter exactly as given (Postgres parses it, as for a
/// string Node's `pg` sends).
#[derive(Debug)]
struct JsonText<'a>(&'a str);

impl ToSql for JsonText<'_> {
    fn to_sql(&self, ty: &Type, out: &mut BytesMut) -> std::result::Result<IsNull, Box<dyn std::error::Error + Sync + Send>> {
        if *ty == Type::JSONB {
            out.put_u8(1);
        }
        out.put_slice(self.0.as_bytes());
        Ok(IsNull::No)
    }

    fn accepts(ty: &Type) -> bool {
        matches!(*ty, Type::JSON | Type::JSONB)
    }

    to_sql_checked!();
}

fn row_error(error: RowError) -> MemoryError {
    MemoryError::Runtime(format!("trace row: {}", error.0))
}

/// Runs `body` on a pooled connection whose `search_path` is `trace, public`, then restores the
/// pool's path. A connection that cannot be reset is dropped, never pooled.
async fn with_trace<T>(db: &Db, body: impl AsyncFnOnce(&Object) -> Result<T>) -> Result<T> {
    let client = db.client().await?;
    client.batch_execute(sql::SET_SEARCH_PATH).await?;
    let result = body(&client).await;
    if client.batch_execute("RESET search_path").await.is_err() {
        drop(Object::take(client));
    }
    result
}

// ---------------------------------------------------------------------------
// Schema bootstrap
// ---------------------------------------------------------------------------

async fn drift(client: &Object) {
    let run = async {
        for statement in sql::DRIFT {
            client.batch_execute(statement).await?;
        }
        Ok::<(), tokio_postgres::Error>(())
    };
    if let Err(error) = run.await {
        let _ = client.batch_execute("ROLLBACK").await;
        tracing::warn!(target: "trace-store", "schema-drift migrate skipped: {error}");
    }
}

async fn init(client: &Object) -> Result<()> {
    if !client.query(sql::LEGACY_TABLE_LOOKUP, &[]).await?.is_empty() {
        client.batch_execute(sql::DROP_LEGACY_TABLE).await?;
    }
    for statement in sql::INIT_TABLES {
        client.batch_execute(statement).await?;
    }
    drift(client).await;
    for statement in sql::INIT_INDEXES {
        client.batch_execute(statement).await?;
    }
    client.batch_execute(sql::ENSURE_PARTITIONS).await?;
    Ok(())
}

async fn init_agent_tables(client: &Object) -> Result<()> {
    drift(client).await;
    for statement in sql::AGENT_TABLES {
        client.batch_execute(statement).await?;
    }
    drift(client).await;
    Ok(())
}

async fn bootstrap(db: &Db) -> Result<()> {
    db.batch("CREATE SCHEMA IF NOT EXISTS trace").await?;
    with_trace(db, async |client| {
        let locked: bool = client.query_one(sql::TRY_LOCK, &[]).await?.get(0);
        if !locked {
            client.batch_execute("BEGIN").await?;
            let waited = async {
                client.batch_execute(LOCK_TIMEOUT).await?;
                client.batch_execute(BLOCKING_LOCK).await?;
                client.batch_execute("COMMIT").await
            }
            .await;
            if let Err(error) = waited {
                let _ = client.batch_execute("ROLLBACK").await;
                return Err(MemoryError::Runtime(format!(
                    "trace-store bootstrap advisory lock timed out (30s): {error}"
                )));
            }
        }
        let steps = async {
            let complete = client.query(sql::IS_BOOTSTRAP_COMPLETE, &[]).await.is_ok_and(|rows| !rows.is_empty());
            if complete {
                client.batch_execute(sql::ENSURE_PARTITIONS).await?;
            } else {
                init(client).await?;
            }
            init_agent_tables(client).await
        }
        .await;
        let unlocked = client.batch_execute(sql::UNLOCK).await;
        steps?;
        Ok(unlocked?)
    })
    .await
}

/// `cleanupTraceWhenDisabled`: tracing is off, so a leftover `trace` schema is dropped.
async fn drop_when_disabled(db: &Db) -> Result<bool> {
    let present: bool = db.query(sql::TRACE_NAMESPACE_PRESENT, &[]).await?.first().is_some_and(|row| row.get(0));
    if present {
        db.batch(sql::DROP_TRACE_SCHEMA).await?;
    }
    Ok(present)
}

// ---------------------------------------------------------------------------
// Retention
// ---------------------------------------------------------------------------

fn drop_aged_partitions_sql(days: i64) -> String {
    sql::DROP_AGED_PARTITIONS.replace("{days}", &days.to_string())
}

fn prune_table_sql(table: &str) -> String {
    sql::PRUNE_TABLE_TEMPLATE.replace("{table}", table)
}

async fn prune_aged_rows(client: &Object, days: i64, now_ms: i64) {
    if days <= 0 {
        return;
    }
    let cutoff = now_ms - days * 86_400_000;
    let mut plans = vec![("trace_events", sql::PRUNE_TRACE_EVENTS.to_string())];
    plans.extend(BRIDGE_AND_AGENT_TABLES.iter().map(|table| (*table, prune_table_sql(table))));
    for (table, statement) in plans {
        let run = async {
            let prepared = client.prepare_typed(&statement, &[Type::INT8, Type::INT8]).await?;
            for _ in 0..10_000 {
                let deleted = client.execute(&prepared, &[&cutoff, &DELETE_BATCH]).await?;
                if deleted < DELETE_BATCH as u64 {
                    break;
                }
                tokio::task::yield_now().await;
            }
            Ok::<(), tokio_postgres::Error>(())
        };
        if let Err(error) = run.await {
            tracing::warn!(target: "trace-store", "aged-row delete skipped for {table}: {error}");
        }
    }
}

async fn run_retention(db: &Db, days: i64, now_ms: i64) {
    let outcome = with_trace(db, async |client| {
        client.batch_execute(sql::ENSURE_PARTITIONS).await?;
        if days > 0 {
            client.batch_execute(&drop_aged_partitions_sql(days)).await?;
        }
        prune_aged_rows(client, days, now_ms).await;
        Ok(())
    })
    .await;
    if let Err(error) = outcome {
        tracing::warn!(target: "trace-store", "retention failed: {error}");
    }
}

// ---------------------------------------------------------------------------
// Inserts
// ---------------------------------------------------------------------------

fn refs<'a>(params: &'a [Box<dyn ToSql + Sync + Send + 'a>]) -> Vec<&'a (dyn ToSql + Sync)> {
    params.iter().map(|p| &**p as &(dyn ToSql + Sync)).collect()
}

fn column_params(columns: &[Column]) -> Vec<Box<dyn ToSql + Sync + Send + '_>> {
    columns
        .iter()
        .map(|column| match column {
            Column::Text(v) => Box::new(v) as Box<dyn ToSql + Sync + Send + '_>,
            Column::Int(v) => Box::new(v) as Box<dyn ToSql + Sync + Send + '_>,
        })
        .collect()
}

/// `insertTraceEvents`: one multi-row INSERT.
async fn insert_trace_events(db: &Db, events: &[Event], now_ms: i64) -> Result<usize> {
    if events.is_empty() {
        return Ok(0);
    }
    let cells: Vec<TraceEventCells> = events
        .iter()
        .map(|ev| TraceEventRow::from_event(ev, now_ms).and_then(|row| row.cells()))
        .collect::<std::result::Result<_, _>>()
        .map_err(row_error)?;
    let mut params: Vec<Box<dyn ToSql + Sync + Send + '_>> = Vec::with_capacity(cells.len() * 20);
    for c in &cells {
        params.push(Box::new(c.ts));
        params.push(Box::new(&c.session_id));
        params.push(Box::new(c.iteration));
        params.push(Box::new(&c.kind));
        params.push(Box::new(&c.agent));
        params.push(Box::new(&c.model));
        params.push(Box::new(&c.tool_name));
        params.push(Box::new(c.tool_ms));
        params.push(Box::new(&c.result_kind));
        params.push(Box::new(&c.result_error_category));
        params.push(Box::new(&c.result_error_first_line));
        params.push(Box::new(c.input_tokens));
        params.push(Box::new(c.output_tokens));
        params.push(Box::new(c.cached_tokens));
        params.push(Box::new(c.cache_write_tokens));
        params.push(Box::new(c.duration_ms));
        params.push(Box::new(&c.error_message));
        params.push(Box::new(JsonText(&c.payload)));
        params.push(Box::new(c.parent_span_id));
        params.push(Box::new(c.entry_id));
    }
    let statement = insert_trace_events_sql(cells.len());
    db.execute(statement.as_str(), &refs(&params)).await?;
    Ok(cells.len())
}

/// `insertAgentCalls`: agent_calls + agent_llm + the agent_sessions upsert in one transaction.
async fn insert_agent_calls(db: &Db, events: &[Event], now_ms: i64) -> Result<(usize, usize)> {
    if events.is_empty() {
        return Ok((0, 0));
    }
    let rows = collect_agent_rows(events, now_ms).map_err(row_error)?;
    let tool = tool_columns(&rows.tool_rows).map_err(row_error)?;
    let llm = llm_columns(&rows.llm_rows).map_err(row_error)?;
    let sessions = session_columns(&rows.sessions).map_err(row_error)?;
    with_trace(db, async |client| {
        client.batch_execute("BEGIN").await?;
        let run = async {
            if !rows.tool_rows.is_empty() {
                let params = column_params(&tool);
                client.execute(sql::INSERT_TOOL_ROWS, &refs(&params)).await?;
            }
            if !rows.llm_rows.is_empty() {
                let params = column_params(&llm);
                client.execute(sql::INSERT_LLM_ROWS, &refs(&params)).await?;
            }
            if !rows.sessions.is_empty() {
                let params = column_params(&sessions);
                client.execute(sql::UPSERT_SESSIONS, &refs(&params)).await?;
            }
            client.batch_execute("COMMIT").await
        }
        .await;
        if let Err(error) = run {
            let _ = client.batch_execute("ROLLBACK").await;
            return Err(error.into());
        }
        Ok(())
    })
    .await?;
    Ok((rows.tool_rows.len(), rows.llm_rows.len()))
}

// ---------------------------------------------------------------------------
// The write queue (100 ms / 500 rows / 10 000 pending, three tries)
// ---------------------------------------------------------------------------

struct Wrapper {
    events: Vec<Event>,
    attempts: u32,
}

#[derive(Default)]
struct Queue {
    pending: Vec<Wrapper>,
    timer_armed: bool,
}

fn pending_events(queue: &Queue) -> usize {
    queue.pending.iter().map(|w| w.events.len()).sum()
}

fn trim_pending(queue: &mut Queue) {
    let mut overflow = pending_events(queue).saturating_sub(QUEUE_MAX_PENDING_EVENTS);
    while overflow > 0 && !queue.pending.is_empty() {
        let oldest = &mut queue.pending[0];
        if oldest.events.len() <= overflow {
            overflow -= oldest.events.len();
            queue.pending.remove(0);
        } else {
            oldest.events.drain(..overflow);
            overflow = 0;
        }
    }
}

fn drop_written(wrappers: &mut Vec<Wrapper>, mut count: usize) {
    while count > 0 && !wrappers.is_empty() {
        if wrappers[0].events.len() <= count {
            count -= wrappers[0].events.len();
            wrappers.remove(0);
        } else {
            wrappers[0].events.drain(..count);
            count = 0;
        }
    }
}

/// Rows `appendAgentTrace` produced, waiting for the 5 s / 500-row batch Node's
/// `agent-trace-io.mjs` posts to `/admin/trace-record`.
#[derive(Default)]
struct Feed {
    rows: Vec<Event>,
    timer_armed: bool,
}

struct Inner {
    db: Arc<Db>,
    queue: Mutex<Queue>,
    flushing: AsyncMutex<()>,
    feed: Mutex<Feed>,
    /// Rows arrive from any thread (RowSink::row), so tasks are spawned on the runtime that opened the store.
    handle: tokio::runtime::Handle,
}

/// Queues `events` for the trace_events insert and inserts their agent analytics in the background.
fn deliver(inner: &Arc<Inner>, events: Vec<Event>, now_ms: i64) {
    enqueue(inner, events.clone(), now_ms);
    let db = inner.db.clone();
    inner.handle.spawn(async move {
        if let Err(error) = insert_agent_calls(&db, &events, now_ms).await {
            tracing::warn!(target: "trace-store", "insertAgentCalls error: {error}");
        }
    });
}

/// `enqueueTraceEvents`.
fn enqueue(inner: &Arc<Inner>, events: Vec<Event>, now_ms: i64) {
    if events.is_empty() {
        return;
    }
    let (flush_now, arm) = {
        let mut queue = inner.queue.lock().unwrap_or_else(PoisonError::into_inner);
        queue.pending.push(Wrapper { events, attempts: 0 });
        trim_pending(&mut queue);
        if pending_events(&queue) >= QUEUE_MAX_ROWS {
            (true, false)
        } else {
            let arm = !queue.timer_armed;
            queue.timer_armed = true;
            (false, arm)
        }
    };
    if flush_now {
        spawn_flush(inner.clone(), now_ms, false);
    } else if arm {
        spawn_flush(inner.clone(), now_ms, true);
    }
}

/// Posts what the feed holds, in batches of at most 500 (the route's cap).
fn spawn_feed(inner: Arc<Inner>, now_ms: i64, delayed: bool) {
    let handle = inner.handle.clone();
    handle.spawn(async move {
        if delayed {
            tokio::time::sleep(FEED_EVERY).await;
        }
        let rows = {
            let mut feed = inner.feed.lock().unwrap_or_else(PoisonError::into_inner);
            feed.timer_armed = false;
            std::mem::take(&mut feed.rows)
        };
        for batch in rows.chunks(FEED_BATCH) {
            deliver(&inner, batch.to_vec(), now_ms);
        }
    });
}

impl mixdog_trace::RowSink for TraceStore {
    fn row(&self, row: &serde_json::Map<String, Value>, now_ms: i64) {
        let (now, arm) = {
            let mut feed = self.inner.feed.lock().unwrap_or_else(PoisonError::into_inner);
            feed.rows.push(Value::Object(row.clone()));
            if feed.rows.len() >= FEED_BATCH {
                (true, false)
            } else {
                let arm = !feed.timer_armed;
                feed.timer_armed = true;
                (false, arm)
            }
        };
        if now || arm {
            spawn_feed(self.inner.clone(), now_ms, arm);
        }
    }
}

/// The trace store of one data directory: open only when tracing is on.
#[derive(Clone)]
pub struct TraceStore {
    inner: Arc<Inner>,
    retention: Arc<Mutex<Option<tokio::task::JoinHandle<()>>>>,
}

/// The answer to one `/admin/trace-record` call.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RecordReply {
    /// `{ok:true, queued}`.
    Queued(usize),
    /// `{ok:true, queued:0, disabled:true}`.
    Disabled,
    /// `{ok:false, error}` with the HTTP status Node used.
    Rejected { status: u16, error: String },
}

impl TraceStore {
    /// `openTraceDatabase`: `None` when tracing is off (any leftover `trace` schema is dropped).
    /// `now_ms` is the owner's clock; the retention pass repeats every 12 hours from here.
    pub async fn open(
        db: Arc<Db>,
        enabled: bool,
        retention_days: i64,
        now_ms: i64,
    ) -> Result<Option<Self>> {
        if !enabled {
            if drop_when_disabled(&db).await? {
                tracing::info!(target: "trace-store", "disabled; removed existing trace diagnostics");
            }
            return Ok(None);
        }
        bootstrap(&db).await?;
        let store = Self {
            inner: Arc::new(Inner { db: db.clone(), queue: Mutex::new(Queue::default()), flushing: AsyncMutex::new(()), feed: Mutex::new(Feed::default()), handle: tokio::runtime::Handle::current() }),
            retention: Arc::new(Mutex::new(None)),
        };
        let task_db = db;
        let handle = tokio::spawn(async move {
            let mut now = now_ms;
            loop {
                run_retention(&task_db, retention_days, now).await;
                tokio::time::sleep(RETENTION_EVERY).await;
                now += i64::try_from(RETENTION_EVERY.as_millis()).unwrap_or(i64::MAX);
            }
        });
        *store.retention.lock().unwrap_or_else(PoisonError::into_inner) = Some(handle);
        Ok(Some(store))
    }

    /// `enqueueTraceEvents`: returns at once; the flush runs within 100 ms or at 500 events.
    pub fn enqueue(&self, events: Vec<Event>, now_ms: i64) {
        enqueue(&self.inner, events, now_ms);
    }

    /// The exit drain: what is still queued is written once, without retries.
    pub async fn drain(&self, now_ms: i64) {
        let _guard = self.inner.flushing.lock().await;
        let events: Vec<Event> = {
            let mut queue = self.inner.queue.lock().unwrap_or_else(PoisonError::into_inner);
            std::mem::take(&mut queue.pending).into_iter().flat_map(|w| w.events).collect()
        };
        for chunk in events.chunks(TRACE_INSERT_MAX_ROWS) {
            if let Err(error) = insert_trace_events(&self.inner.db, chunk, now_ms).await {
                tracing::warn!(target: "trace-store", "drain failed: {error}");
                return;
            }
        }
    }

    /// `closeTraceDatabase` (the queue part): stop the retention pass and drain.
    pub async fn close(&self, now_ms: i64) {
        if let Some(handle) = self.retention.lock().unwrap_or_else(PoisonError::into_inner).take() {
            handle.abort();
        }
        self.drain(now_ms).await;
    }

    /// The body of `POST /admin/trace-record` (HTTP is gone in the single-process core): the same
    /// checks and replies, the trace rows queued, the agent analytics inserted in the background.
    pub fn record(store: Option<&Self>, body: &Value, now_ms: i64) -> RecordReply {
        let Some(events) = body.get("events").and_then(Value::as_array) else {
            return RecordReply::Rejected { status: 400, error: "body.events must be an array".into() };
        };
        if events.len() > 500 {
            return RecordReply::Rejected { status: 413, error: "too many events (max 500)".into() };
        }
        let Some(store) = store else { return RecordReply::Disabled };
        let events: Vec<Event> = events.clone();
        let queued = events.len();
        deliver(&store.inner, events, now_ms);
        RecordReply::Queued(queued)
    }
}

/// `_flushQueue`: one flush at a time; failed events are retried by the follow-up flush.
async fn flush(inner: &Arc<Inner>, now_ms: i64) {
    let guard = inner.flushing.lock().await;
    let mut wrappers = std::mem::take(&mut inner.queue.lock().unwrap_or_else(PoisonError::into_inner).pending);
    if wrappers.is_empty() {
        return;
    }
    let all: Vec<Event> = wrappers.iter().flat_map(|w| w.events.iter().cloned()).collect();
    let mut written = 0;
    let mut failure = None;
    for chunk in all.chunks(TRACE_INSERT_MAX_ROWS) {
        match insert_trace_events(&inner.db, chunk, now_ms).await {
            Ok(count) => written += count,
            Err(error) => {
                failure = Some(error);
                break;
            }
        }
    }
    if let Some(error) = failure {
        drop_written(&mut wrappers, written);
        for w in &mut wrappers {
            w.attempts += 1;
        }
        let (keep, dropped): (Vec<Wrapper>, Vec<Wrapper>) = wrappers.into_iter().partition(|w| w.attempts < MAX_RETRIES);
        if !dropped.is_empty() {
            let lost: usize = dropped.iter().map(|w| w.events.len()).sum();
            tracing::warn!(target: "trace-store", "dropped {lost} events after {MAX_RETRIES} retries: {error}");
        }
        let mut queue = inner.queue.lock().unwrap_or_else(PoisonError::into_inner);
        let mut restored = keep;
        restored.append(&mut queue.pending);
        queue.pending = restored;
        trim_pending(&mut queue);
        tracing::warn!(target: "trace-store", "flush error: {error}");
    }
    drop(guard);
    let rearm = {
        let mut queue = inner.queue.lock().unwrap_or_else(PoisonError::into_inner);
        let rearm = !queue.pending.is_empty() && !queue.timer_armed;
        if rearm {
            queue.timer_armed = true;
        }
        rearm
    };
    if rearm {
        spawn_flush(inner.clone(), now_ms, true);
    }
}

/// Runs a flush as a task, after the 100 ms window when delayed (that task owns the armed timer).
/// A plain function, so `flush` can schedule its own follow-up without a recursive future type.
fn spawn_flush(inner: Arc<Inner>, now_ms: i64, delayed: bool) {
    let handle = inner.handle.clone();
    handle.spawn(async move {
        if delayed {
            tokio::time::sleep(FLUSH_DELAY).await;
            inner.queue.lock().unwrap_or_else(PoisonError::into_inner).timer_armed = false;
        }
        flush(&inner, now_ms).await;
    });
}

#[cfg(test)]
/// The statements Node's bootstrap sends, in its order, for the first-boot
/// path (`isBootstrapComplete` false, no legacy table).
pub fn first_boot_statements() -> Vec<String> {
    let mut out = vec![
        sql::SET_SEARCH_PATH.to_string(),
        sql::TRY_LOCK.to_string(),
        sql::IS_BOOTSTRAP_COMPLETE.to_string(),
        sql::LEGACY_TABLE_LOOKUP.to_string(),
    ];
    out.extend(sql::INIT_TABLES.iter().map(|s| (*s).to_string()));
    out.extend(sql::DRIFT.iter().map(|s| (*s).to_string()));
    out.extend(sql::INIT_INDEXES.iter().map(|s| (*s).to_string()));
    out.push(sql::ENSURE_PARTITIONS.to_string());
    out.extend(sql::DRIFT.iter().map(|s| (*s).to_string()));
    out.extend(sql::AGENT_TABLES.iter().map(|s| (*s).to_string()));
    out.extend(sql::DRIFT.iter().map(|s| (*s).to_string()));
    out.push(sql::UNLOCK.to_string());
    out
}

#[cfg(test)]
/// The retention statements in Node's order for `days` at `now_ms`.
pub fn retention_statements(days: i64, now_ms: i64) -> Vec<(String, Vec<i64>)> {
    let cutoff = now_ms - days * 86_400_000;
    let mut out = vec![
        (sql::SET_SEARCH_PATH.to_string(), vec![]),
        (sql::ENSURE_PARTITIONS.to_string(), vec![]),
        (drop_aged_partitions_sql(days), vec![]),
        (sql::PRUNE_TRACE_EVENTS.to_string(), vec![cutoff, DELETE_BATCH]),
    ];
    out.extend(BRIDGE_AND_AGENT_TABLES.iter().map(|t| (prune_table_sql(t), vec![cutoff, DELETE_BATCH])));
    out
}

/// Marker path helper for callers that check the file: `<data_dir>/.trace-enabled`.
pub fn trace_marker_path(data_dir: &Path) -> std::path::PathBuf {
    data_dir.join(TRACE_ENABLE_MARKER)
}
