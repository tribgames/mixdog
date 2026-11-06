//! `memory-cycle1.mjs` and `cycle1/cycle1-result.mjs`: one cycle1 run - the per-database
//! in-flight gate, the advisory lock, the coalesced request drain and the retry, around the plan,
//! row fetch, window packing and window processing of one pass.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use futures::future::BoxFuture;
use mixdog_js::{json_stringify, number_to_string};
use serde_json::{Map, Value, json};
use tokio::sync::Semaphore;
use tokio_util::sync::CancellationToken;

use super::quality::{Row, cycle1_source_budget, partition_cycle1_rows, InvalidChunk};
use crate::bots::delivery::env::RetryTimer;
use super::requests::{RetryRunner, RetryTimers, consume_cycle_requests, mark_cycle_request, resolve_coalesce_max_drains, resolve_coalesce_max_retries, spawn_work};
use super::rows::{MAX_PACKETS, PACKET_MAX_ROWS, PlanOptions, count_pending_rows, count_raw_unchunked_rows, fetch_cycle1_rows, group_rows_by_session, resolve_cycle1_plan};
use super::signature::make_cycle_request_signature;
use super::window::{Timing, WindowEnv, WindowResult, invalid_json, process_cycle1_window};
use super::{Cycle1Llm, CycleConfig, CycleEmbeddings, log};
use crate::memory::error::{MemoryError, Result};
use crate::memory::ingest::NowMs;
use crate::memory::pg::db::Db;

/// The embedding block a run reports; the flush runs after the run, so it is always deferred.
#[derive(Clone, Debug, PartialEq)]
pub struct EmbeddingDirty {
    pub deferred: bool,
    pub attempted: i64,
    pub succeeded: i64,
    pub failed: i64,
    pub failed_ids: Vec<i64>,
}

impl Default for EmbeddingDirty {
    fn default() -> Self {
        Self { deferred: true, attempted: 0, succeeded: 0, failed: 0, failed_ids: Vec::new() }
    }
}

/// What a cycle1 run reports.
#[derive(Clone, Debug, Default)]
pub struct Cycle1Result {
    pub processed: i64,
    pub chunks: i64,
    pub skipped: i64,
    pub sessions: i64,
    pub skipped_in_flight: bool,
    pub timed_out_waiting: bool,
    pub caller_deadline_ms: Option<f64>,
    pub coalesced_retry_noop: bool,
    pub pending_rows: Option<i64>,
    pub failed_row_ids: Vec<i64>,
    pub omitted_row_ids: Vec<i64>,
    pub prefiltered_row_ids: Vec<i64>,
    pub invalid_chunks: Vec<InvalidChunk>,
    pub quality: Map<String, Value>,
    pub timing: Map<String, Value>,
    pub embedding_dirty: EmbeddingDirty,
    pub coalesced_runs: Option<i64>,
    pub coalesced_requests: Option<f64>,
}

impl Cycle1Result {
    pub fn to_json(&self) -> Value {
        let mut out = Map::new();
        out.insert("processed".into(), json!(self.processed));
        out.insert("chunks".into(), json!(self.chunks));
        out.insert("skipped".into(), json!(self.skipped));
        out.insert("sessions".into(), json!(self.sessions));
        out.insert("skippedInFlight".into(), json!(self.skipped_in_flight));
        if self.timed_out_waiting {
            out.insert("timedOutWaiting".into(), json!(true));
            out.insert("callerDeadlineMs".into(), json!(self.caller_deadline_ms));
        }
        if self.coalesced_retry_noop {
            out.insert("coalescedRetryNoop".into(), json!(true));
        }
        out.insert("pendingRows".into(), json!(self.pending_rows));
        out.insert("failed_row_ids".into(), json!(self.failed_row_ids));
        out.insert("omitted_row_ids".into(), json!(self.omitted_row_ids));
        out.insert("prefiltered_row_ids".into(), json!(self.prefiltered_row_ids));
        out.insert("invalid_chunks".into(), invalid_json(&self.invalid_chunks));
        out.insert("quality".into(), Value::Object(self.quality.clone()));
        out.insert("timing".into(), Value::Object(self.timing.clone()));
        let dirty = &self.embedding_dirty;
        out.insert(
            "embedding_dirty".into(),
            json!({"deferred": dirty.deferred, "attempted": dirty.attempted, "succeeded": dirty.succeeded, "failed": dirty.failed, "failed_ids": dirty.failed_ids}),
        );
        if let Some(runs) = self.coalesced_runs {
            out.insert("coalescedRuns".into(), json!(runs));
            out.insert("coalescedRequests".into(), json!(self.coalesced_requests));
        }
        Value::Object(out)
    }

    /// The result of a caller whose deadline passed while a run was in flight.
    pub fn timed_out(caller_deadline_ms: f64) -> Self {
        Self { skipped_in_flight: true, timed_out_waiting: true, caller_deadline_ms: Some(caller_deadline_ms), ..Self::default() }
    }
}

fn quality_of(pairs: &[(&str, i64)]) -> Map<String, Value> {
    pairs.iter().map(|(k, v)| ((*k).to_owned(), json!(v))).collect()
}

/// `emptyCycle1Result`.
fn empty_result(pending_rows: Option<i64>) -> Cycle1Result {
    Cycle1Result {
        pending_rows,
        quality: quality_of(&[
            ("rows_considered", 0),
            ("committed_members", 0),
            ("skipped_chunks", 0),
            ("omitted_rows", 0),
            ("failed_rows", 0),
            ("invalid_chunks", 0),
        ]),
        ..Cycle1Result::default()
    }
}

/// `cycle1SkipResult`.
fn skip_result(pending_rows: Option<i64>) -> Cycle1Result {
    Cycle1Result { skipped_in_flight: true, pending_rows, ..Cycle1Result::default() }
}

fn unique_ids(ids: impl IntoIterator<Item = i64>) -> Vec<i64> {
    let mut seen = std::collections::HashSet::new();
    ids.into_iter().filter(|id| seen.insert(*id)).collect()
}

fn sum_maps(a: &Map<String, Value>, b: &Map<String, Value>) -> Map<String, Value> {
    let mut out = Map::new();
    for key in a.keys().chain(b.keys()) {
        if out.contains_key(key) {
            continue;
        }
        let n = |m: &Map<String, Value>| m.get(key).and_then(Value::as_f64).unwrap_or(0.0);
        out.insert(key.clone(), mixdog_js::json_number(n(a) + n(b)));
    }
    out
}

/// `mergeCycle1Results`.
pub fn merge_cycle1_results(a: Cycle1Result, b: Cycle1Result) -> Cycle1Result {
    let embedding_dirty = EmbeddingDirty {
        deferred: a.embedding_dirty.deferred && b.embedding_dirty.deferred,
        attempted: a.embedding_dirty.attempted + b.embedding_dirty.attempted,
        succeeded: a.embedding_dirty.succeeded + b.embedding_dirty.succeeded,
        failed: a.embedding_dirty.failed + b.embedding_dirty.failed,
        failed_ids: a.embedding_dirty.failed_ids.iter().chain(&b.embedding_dirty.failed_ids).copied().collect(),
    };
    Cycle1Result {
        processed: a.processed + b.processed,
        chunks: a.chunks + b.chunks,
        skipped: a.skipped + b.skipped,
        sessions: a.sessions + b.sessions,
        skipped_in_flight: false,
        timing: sum_maps(&a.timing, &b.timing),
        quality: sum_maps(&a.quality, &b.quality),
        pending_rows: b.pending_rows.or(a.pending_rows),
        failed_row_ids: unique_ids(a.failed_row_ids.iter().chain(&b.failed_row_ids).copied()),
        omitted_row_ids: unique_ids(a.omitted_row_ids.iter().chain(&b.omitted_row_ids).copied()),
        prefiltered_row_ids: unique_ids(a.prefiltered_row_ids.iter().chain(&b.prefiltered_row_ids).copied()),
        invalid_chunks: a.invalid_chunks.iter().chain(&b.invalid_chunks).cloned().collect(),
        embedding_dirty,
        ..b
    }
}

/// `packCycle1Windows`: sessions packed into at most `max_packets` windows, one packet per
/// session in turn so a busy session cannot take every slot.
pub fn pack_cycle1_windows(rows_by_session: &[(String, Vec<Row>)], packet_size: f64, max_packets: f64, input_token_budget: f64) -> Result<Vec<Vec<Row>>> {
    let or = |n: f64, fallback: f64| if n == 0.0 || n.is_nan() { fallback } else { n };
    let size = (PACKET_MAX_ROWS as f64).min(1f64.max(or(packet_size, PACKET_MAX_ROWS as f64))) as usize;
    let cap = (MAX_PACKETS as f64).min(1f64.max(or(max_packets, MAX_PACKETS as f64))) as usize;
    let source_budget = cycle1_source_budget(input_token_budget)?;
    let mut sessions: Vec<Vec<Row>> = rows_by_session.iter().map(|(_, rows)| rows.iter().rev().cloned().collect()).collect();
    // The oldest selected session keeps a slot even when sessions outnumber the slots.
    if sessions.len() > cap {
        let last = sessions.last().cloned().expect("a session");
        sessions = if cap == 1 { vec![last] } else { sessions.into_iter().take(cap - 1).chain(std::iter::once(last)).collect() };
    }
    let mut packets: Vec<std::collections::VecDeque<Vec<Row>>> = sessions.iter().map(|rows| partition_cycle1_rows(rows, source_budget, size).into()).collect();
    let mut windows = Vec::new();
    while packets.iter().any(|p| !p.is_empty()) && windows.len() < cap {
        for session in &mut packets {
            if session.is_empty() || windows.len() >= cap {
                continue;
            }
            windows.extend(session.pop_front());
        }
    }
    Ok(windows)
}

/// The sum of the windows' tallies.
#[derive(Default)]
struct Totals {
    chunks: i64,
    members: i64,
    skipped: i64,
    rows_considered: usize,
    invalid: Vec<InvalidChunk>,
    failed: Vec<i64>,
    omitted: Vec<i64>,
    prefiltered: Vec<i64>,
    prefilter_marked: usize,
    prefilter_mark_failed: usize,
    omitted_marked: usize,
    omitted_deferred: usize,
    omitted_mark_failed: usize,
    timing: Timing,
}

fn aggregate(results: &[WindowResult]) -> Totals {
    let mut t = Totals::default();
    for r in results {
        t.chunks += r.committed_chunks;
        t.members += r.committed_members;
        t.skipped += r.skipped_chunks;
        t.rows_considered += r.rows_considered;
        t.invalid.extend(r.invalid_chunks.iter().cloned());
        t.failed.extend(&r.failed_row_ids);
        t.omitted.extend(&r.omitted_row_ids);
        t.prefiltered.extend(&r.prefiltered_row_ids);
        t.prefilter_marked += r.prefilter_marked;
        t.prefilter_mark_failed += r.prefilter_mark_failed;
        t.omitted_marked += r.omitted_marked;
        t.omitted_deferred += r.omitted_deferred;
        t.omitted_mark_failed += r.omitted_mark_failed;
        let (a, b) = (&mut t.timing, &r.timing);
        a.grouping_calls += b.grouping_calls;
        a.verification_calls += b.verification_calls;
        a.llm_ms += b.llm_ms;
        a.verification_ms += b.verification_ms;
        a.retries += b.retries;
        a.fragments += b.fragments;
        a.commit_ms += b.commit_ms;
    }
    t
}

fn summary_line(window_count: usize, t: &Totals) -> String {
    format!(
        "[cycle1] windows={window_count} rows={} chunks={} members={} skipped_chunks={} omitted={} prefiltered={} prefilter_marked={} prefilter_mark_failed={} omitted_deferred={} omitted_marked={} omitted_mark_failed={} failed_rows={} invalid_chunks={}\n",
        t.rows_considered,
        t.chunks,
        t.members,
        t.skipped,
        t.omitted.len(),
        t.prefiltered.len(),
        t.prefilter_marked,
        t.prefilter_mark_failed,
        t.omitted_deferred,
        t.omitted_marked,
        t.omitted_mark_failed,
        t.failed.len(),
        t.invalid.len(),
    )
}

fn build_result(t: Totals, window_count: usize, pending_at_start: Option<i64>, fetch_ms: i64, total_ms: i64) -> Cycle1Result {
    let tm = &t.timing;
    let quality = quality_of(&[
        ("rows_considered", t.rows_considered as i64),
        ("committed_members", t.members),
        ("skipped_chunks", t.skipped),
        ("omitted_rows", t.omitted.len() as i64),
        ("prefiltered_rows", t.prefiltered.len() as i64),
        ("prefilter_marked_rows", t.prefilter_marked as i64),
        ("prefilter_mark_failed_rows", t.prefilter_mark_failed as i64),
        ("omitted_deferred_rows", t.omitted_deferred as i64),
        ("omitted_marked_rows", t.omitted_marked as i64),
        ("omitted_mark_failed_rows", t.omitted_mark_failed as i64),
        ("failed_rows", t.failed.len() as i64),
        ("invalid_chunks", t.invalid.len() as i64),
        ("grouping_calls", tm.grouping_calls),
        ("verification_calls", tm.verification_calls),
        ("raw_fallback_rows", t.rows_considered as i64 - t.members),
    ]);
    let timing = quality_of(&[
        ("groupingCalls", tm.grouping_calls),
        ("verificationCalls", tm.verification_calls),
        ("llmMs", tm.llm_ms),
        ("verificationMs", tm.verification_ms),
        ("retries", tm.retries),
        ("fragments", tm.fragments),
        ("commitMs", tm.commit_ms),
        ("fetchMs", fetch_ms),
        ("totalMs", total_ms),
    ]);
    Cycle1Result {
        processed: t.members,
        chunks: t.chunks,
        skipped: t.skipped,
        sessions: window_count as i64,
        pending_rows: pending_at_start,
        failed_row_ids: t.failed,
        omitted_row_ids: t.omitted,
        prefiltered_row_ids: t.prefiltered,
        invalid_chunks: t.invalid,
        quality,
        timing,
        ..Cycle1Result::default()
    }
}

/// What a caller hands one run (`options` of `runCycle1`).
#[derive(Clone, Default)]
pub struct Cycle1Options {
    pub cancel: CancellationToken,
    pub coalesced_retry: bool,
    pub retry_attempt: u32,
    pub plan: PlanOptions,
    /// Called with a coalesced retry's result; a scheduled run records its outcome through it.
    pub on_coalesced_success: Option<CoalescedSuccess>,
}

/// The callback a scheduled run hands to a coalesced retry.
pub type CoalescedSuccess = Arc<dyn Fn(Cycle1Result) -> BoxFuture<'static, std::result::Result<(), String>> + Send + Sync>;

const ADVISORY_KEY: &str = "mixdog.cycle1";

/// A cycle1 run over one database.
pub struct Cycle1Runner {
    pub(crate) db: Db,
    pub(crate) llm: Arc<dyn Cycle1Llm>,
    pub(crate) embeddings: Arc<dyn CycleEmbeddings>,
    pub(crate) config: Arc<dyn CycleConfig>,
    pub(crate) now: NowMs,
    pub(crate) retries: Arc<RetryTimers>,
    running: Mutex<bool>,
    logged_at: Mutex<HashMap<&'static str, i64>>,
}

impl Cycle1Runner {
    pub fn new(db: Db, llm: Arc<dyn Cycle1Llm>, embeddings: Arc<dyn CycleEmbeddings>, config: Arc<dyn CycleConfig>, now: NowMs, timer: Arc<dyn RetryTimer>) -> Arc<Self> {
        Arc::new(Self { db, llm, embeddings, config, now, retries: RetryTimers::new(timer), running: Mutex::new(false), logged_at: Mutex::default() })
    }

    pub fn db(&self) -> &Db {
        &self.db
    }

    pub fn retries(&self) -> &Arc<RetryTimers> {
        &self.retries
    }

    /// `getInFlightCycle1(db)`.
    pub fn is_running(&self) -> bool {
        *self.running.lock().expect("cycle1 gate")
    }

    fn set_running(&self, running: bool) {
        *self.running.lock().expect("cycle1 gate") = running;
    }

    fn log_throttled(&self, key: &'static str, message: &str) {
        let now = (self.now)();
        let mut at = self.logged_at.lock().expect("cycle1 log times");
        if now - at.get(key).copied().unwrap_or(0) < 60_000 {
            return;
        }
        at.insert(key, now);
        log(message);
    }

    async fn skip(&self) -> Cycle1Result {
        skip_result(count_pending_rows(&self.db, (self.now)()).await)
    }

    fn signature(config: &Value, options: &Cycle1Options) -> String {
        let mut extra = Map::new();
        if let Some(preset) = options.plan.preset.as_ref().filter(|p| !p.is_null()) {
            extra.insert("preset".into(), preset.clone());
        }
        if let Some(n) = options.plan.concurrency {
            extra.insert("concurrency".into(), mixdog_js::json_number(n));
        }
        if let Some(n) = options.plan.max_concurrent {
            extra.insert("maxConcurrent".into(), mixdog_js::json_number(n));
        }
        make_cycle_request_signature(&["cycle1".into(), config.clone(), Value::Object(extra)])
    }

    fn schedule_retry(self: &Arc<Self>, config: &Value, options: &Cycle1Options, signature: &str) {
        let (runner, config_owned) = (Arc::clone(self), config.clone());
        let next = Cycle1Options {
            cancel: CancellationToken::new(),
            coalesced_retry: true,
            retry_attempt: options.retry_attempt + 1,
            ..options.clone()
        };
        let job: RetryRunner = Box::new(move || {
            Box::pin(async move { runner.run_cycle1(config_owned, next).await.map(|_| ()).map_err(|e| e.message()) })
        });
        if let Err(error) = self.retries.schedule("cycle1", signature, config, job) {
            log(&format!("[cycle1] retry not scheduled: {}\n", error.message()));
        }
    }

    /// `runCycle1`.
    pub fn run_cycle1(self: Arc<Self>, config: Value, options: Cycle1Options) -> BoxFuture<'static, Result<Cycle1Result>> {
        Box::pin(async move {
            let cancel = options.cancel.clone();
            if cancel.is_cancelled() {
                return Err(MemoryError::Cancelled);
            }
            let (retried, attempt) = (options.coalesced_retry, options.retry_attempt);
            let max_retries = resolve_coalesce_max_retries(&config, 3.0) as u32;
            let signature = Self::signature(&config, &options);
            let now = || (self.now)();
            if self.is_running() {
                if !retried {
                    mark_cycle_request(&self.db, "cycle1", "in-flight", &signature, now()).await;
                }
                if !retried || attempt < max_retries {
                    self.schedule_retry(&config, &options, &signature);
                }
                self.log_throttled("in-flight", "[cycle1] skipped: already in flight for this db\n");
                return Ok(self.skip().await);
            }
            let client = self.db.client().await?;
            let locked = client.query_one("SELECT pg_try_advisory_lock(hashtext($1)) AS got", &[&ADVISORY_KEY]).await;
            let got = match locked {
                Ok(row) => row.get::<_, bool>("got"),
                Err(error) => {
                    drop(client);
                    if cancel.is_cancelled() {
                        return Err(MemoryError::Cancelled);
                    }
                    log(&format!("[cycle1] advisory lock query failed: {error}\n"));
                    if !retried {
                        mark_cycle_request(&self.db, "cycle1", "lock-error", &signature, now()).await;
                    }
                    return Ok(self.skip().await);
                }
            };
            if !got {
                drop(client);
                if !retried {
                    mark_cycle_request(&self.db, "cycle1", "advisory-lock", &signature, now()).await;
                }
                if !retried || attempt < max_retries {
                    self.schedule_retry(&config, &options, &signature);
                }
                self.log_throttled("advisory-lock", "[cycle1] skipped: advisory lock held by another worker\n");
                return Ok(self.skip().await);
            }
            self.set_running(true);
            let outcome = self.locked_run(&config, &options, &signature, max_retries).await;
            self.set_running(false);
            // A lock that cannot be proven released takes its connection out of the pool.
            let released = client.query_one("SELECT pg_advisory_unlock(hashtext($1)) AS unlocked", &[&ADVISORY_KEY]).await;
            if !released.is_ok_and(|row| row.get::<_, bool>("unlocked")) {
                drop(deadpool_postgres::Object::take(client));
            }
            outcome
        })
    }

    async fn locked_run(self: &Arc<Self>, config: &Value, options: &Cycle1Options, signature: &str, max_retries: u32) -> Result<Cycle1Result> {
        let (retried, attempt, cancel) = (options.coalesced_retry, options.retry_attempt, &options.cancel);
        let (mut runs, mut requests) = (0i64, 0f64);
        if retried {
            let pending = consume_cycle_requests(&self.db, "cycle1", signature, (self.now)()).await?;
            if pending <= 0.0 {
                let skip = self.skip().await;
                return Ok(Cycle1Result { skipped_in_flight: false, coalesced_retry_noop: true, ..skip });
            }
            runs += 1;
            requests += pending;
            log(&format!("[cycle1] retrying coalesced requests={}\n", number_to_string(pending)));
        }
        let mut result = match self.run_once(config, options).await {
            Ok(result) => result,
            Err(error) => {
                if retried {
                    mark_cycle_request(&self.db, "cycle1", "retry-error", signature, (self.now)()).await;
                    if attempt < max_retries {
                        self.schedule_retry(config, options, signature);
                    }
                }
                return Err(error);
            }
        };
        let max_drains = resolve_coalesce_max_drains(config, 1.0) as u32;
        let mut loops = 0;
        while loops < max_drains {
            if cancel.is_cancelled() {
                return Err(MemoryError::Cancelled);
            }
            let pending = consume_cycle_requests(&self.db, "cycle1", signature, (self.now)()).await?;
            if pending <= 0.0 {
                break;
            }
            loops += 1;
            runs += 1;
            requests += pending;
            log(&format!("[cycle1] draining coalesced requests={}\n", number_to_string(pending)));
            match self.run_once(config, options).await {
                Ok(next) => result = merge_cycle1_results(result, next),
                Err(error) => {
                    mark_cycle_request(&self.db, "cycle1", "drain-error", signature, (self.now)()).await;
                    if !retried || attempt < max_retries {
                        self.schedule_retry(config, options, signature);
                    }
                    return Err(error);
                }
            }
        }
        if runs > 0 {
            result.coalesced_runs = Some(runs);
            result.coalesced_requests = Some(requests);
        }
        if retried
            && !result.coalesced_retry_noop
            && let Some(callback) = &options.on_coalesced_success
            && let Err(error) = callback(result.clone()).await
        {
            log(&format!("[cycle1] coalesced success callback failed: {error}\n"));
        }
        Ok(result)
    }

    fn flush_after(&self, cancel: &CancellationToken, quick_exit: bool) {
        let (embeddings, cancel) = (Arc::clone(&self.embeddings), cancel.clone());
        spawn_work("memory-cycle-embed-flush", async move {
            match embeddings.flush_dirty(&cancel).await {
                Ok(d) if !quick_exit && d.attempted > 0 => {
                    log(&format!("[cycle1] embedding flush attempted={} ok={} failed={}\n", d.attempted, d.succeeded, d.failed));
                }
                Ok(_) => {}
                Err(error) if quick_exit => log(&format!("[cycle1] quick-exit embedding flush failed: {error}\n")),
                Err(error) => log(&format!("[cycle1] embedding flush failed: {error}\n")),
            }
        });
    }

    /// `_runCycle1Impl`.
    async fn run_once(self: &Arc<Self>, config: &Value, options: &Cycle1Options) -> Result<Cycle1Result> {
        let cancel = &options.cancel;
        let aborted = || if cancel.is_cancelled() { Err(MemoryError::Cancelled) } else { Ok(()) };
        let started_at = (self.now)();
        aborted()?;
        let pending = count_pending_rows(&self.db, (self.now)()).await;
        let raw = count_raw_unchunked_rows(&self.db).await;
        aborted()?;
        let plan = resolve_cycle1_plan(config, &options.plan, self.config.maintenance_preset());
        let fetch_started = (self.now)();
        let rows_desc = fetch_cycle1_rows(&self.db, &plan, (self.now)()).await?;
        let fetch_ms = (self.now)() - fetch_started;
        aborted()?;
        // Rows whose session is still active are not due yet (fetch_cycle1_rows).
        let bypass = raw.is_some_and(|r| r as f64 >= plan.min_batch) && pending.is_some_and(|p| (p as f64) < plan.min_batch);
        let too_few = pending.is_some_and(|p| (p as f64) < plan.min_batch) && !bypass;
        if too_few || rows_desc.is_empty() {
            let show = |n: Option<i64>| n.map_or("na".to_owned(), |n| n.to_string());
            log(&format!("[cycle1] quick-exit pending={} eligible={} due={} min_batch={}\n", show(raw), show(pending), rows_desc.len(), number_to_string(plan.min_batch)));
            aborted()?;
            self.flush_after(cancel, true);
            return Ok(empty_result(pending));
        }
        let by_session = group_rows_by_session(rows_desc, plan.session_cap as usize, cancel)?;
        let windows = pack_cycle1_windows(&by_session, plan.window_size, plan.max_packets, plan.input_token_budget)?;
        let gate = Semaphore::new((windows.len().max(1) as f64).min(plan.concurrency) as usize);
        let env = WindowEnv { db: self.db.clone(), llm: Arc::clone(&self.llm), embeddings: Arc::clone(&self.embeddings), now: Arc::clone(&self.now) };
        let settled = futures::future::join_all(windows.iter().enumerate().map(|(idx, rows)| {
            let (gate, env, plan) = (&gate, &env, &plan);
            async move {
                let _slot = gate.acquire().await.map_err(|_| MemoryError::Cancelled)?;
                if cancel.is_cancelled() {
                    return Err(MemoryError::Cancelled);
                }
                process_cycle1_window(env, rows, idx, plan, cancel).await
            }
        }))
        .await;
        let mut results = Vec::new();
        for outcome in settled {
            results.push(outcome?);
        }
        aborted()?;
        let totals = aggregate(&results);
        log(&summary_line(windows.len(), &totals));
        // Embedding is fire and forget; the sidecar persist does not wait for it.
        aborted()?;
        self.flush_after(cancel, false);
        Ok(build_result(totals, windows.len(), pending, fetch_ms, (self.now)() - started_at))
    }
}

/// `json_stringify` of a result, for logs and tests.
pub fn result_text(result: &Cycle1Result) -> String {
    json_stringify(&result.to_json())
}
