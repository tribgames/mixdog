//! `<data>/gateway-usage.local.jsonl`, the append-only event store of `route-meta.mjs`: events are
//! buffered and appended in batches (twenty, or half a second after the first), under the store's lock
//! file `<store>.lock`, which readers of the file share. A store that outgrew `COMPACT_MIN_BYTES` is cut
//! down to its newest `MAX_USAGE_EVENTS` lines in the background, and the legacy single-document
//! `gateway-usage.local.json` is migrated into the store by the first writer.

use std::collections::VecDeque;
use std::path::Path;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::MutexGuard;
use std::sync::atomic::AtomicBool;
use std::sync::atomic::Ordering;
use std::time::Duration;

use mixdog_ai::registry::accounting::UsagePricing;
use mixdog_js::js_trim;
use mixdog_rt::CancellationToken;
use mixdog_rt::DurabilityIo;
use mixdog_rt::InLane;
use mixdog_rt::LaneToken;
use mixdog_statefile::LockOpts;
use mixdog_statefile::Opts;
use serde_json::Map;
use serde_json::Value;
use tokio::sync::Notify;

use crate::session::Clock;
use super::event;
use super::event::RouteSection;

pub const STORE_FILE: &str = "gateway-usage.local.jsonl";
pub const LEGACY_FILE: &str = "gateway-usage.local.json";
const LEGACY_BACKUP_SUFFIX: &str = ".migrated.bak";
const COMPACT_MIN_BYTES: u64 = 8 * 1024 * 1024;
const MAX_USAGE_EVENTS: usize = 5000;
const FLUSH_BATCH: usize = 20;
const FLUSH_DELAY_MS: u64 = 500;
const COMPACT_DELAY_MS: u64 = 1000;

/// Cancels a scheduled job.
pub type Cancel = Box<dyn FnOnce() + Send>;

/// Runs a job after a delay (`setTimeout`).
pub trait Scheduler: Send + Sync {
    fn after(&self, delay_ms: u64, job: Box<dyn FnOnce() + Send>) -> Cancel;
}

/// [`Scheduler`] on the tokio timer; used inside the runtime.
pub struct TokioScheduler;

impl Scheduler for TokioScheduler {
    fn after(&self, delay_ms: u64, job: Box<dyn FnOnce() + Send>) -> Cancel {
        let task = tokio::spawn(async move {
            mixdog_rt::time::sleep(Duration::from_millis(delay_ms)).await;
            job();
        });
        Box::new(move || task.abort())
    }
}

#[derive(Default)]
struct State {
    section: RouteSection,
    /// The buffered events, each with its number in [`Inner::marks`].
    pending: Vec<(String, u64)>,
    flush_timer: Option<Cancel>,
    /// Taken batches not yet written, in order, with the numbers of their events.
    batches: VecDeque<(String, Vec<u64>)>,
    draining: bool,
    compact_timer: Option<Cancel>,
    compacting: bool,
}

struct Inner {
    store: PathBuf,
    lane: DurabilityIo,
    clock: Arc<dyn Clock>,
    pricing: Arc<dyn UsagePricing>,
    scheduler: Arc<dyn Scheduler>,
    state: Mutex<State>,
    migrated: AtomicBool,
    /// Woken when a drain or a compaction ends.
    idle: Notify,
    /// Every recorded event numbered, reported once the append that carries it ran.
    marks: mixdog_rt::WriteMarks,
}

/// The writer of the gateway usage store.
#[derive(Clone)]
pub struct GatewayUsage {
    inner: Arc<Inner>,
}

fn lock(state: &Mutex<State>) -> MutexGuard<'_, State> {
    state.lock().unwrap_or_else(|e| e.into_inner())
}

fn exists(lane: &InLane<DurabilityIo>, path: &Path) -> bool {
    mixdog_statefile::metadata(lane, path).is_ok()
}

/// `readJsonFile(file)`: `None` for a missing, unreadable or unparsable file.
fn read_json(path: &Path) -> Option<Value> {
    let bytes = mixdog_statefile::read_content(path).ok().flatten()?;
    mixdog_js::json_parse(&String::from_utf8_lossy(&bytes)).ok()
}

/// `ensureUsageStoreMigrated`, once per process: the legacy JSON document becomes the JSONL store (when
/// there is none yet), and is renamed to a backup. A failure is retried by the next call.
fn ensure_migrated(lane: &InLane<DurabilityIo>, inner: &Inner) {
    if inner.migrated.load(Ordering::Acquire) {
        return;
    }
    let store = &inner.store;
    let legacy = store.with_file_name(LEGACY_FILE);
    if exists(lane, &legacy) {
        let moved = mixdog_statefile::with_lock(lane, store, &LockOpts::default(), || -> std::io::Result<()> {
            if !exists(lane, &legacy) {
                return Ok(());
            }
            if !exists(lane, store) {
                let raw = read_json(&legacy);
                let events = raw.as_ref().and_then(|raw| raw.get("events")).and_then(Value::as_array).map_or(&[][..], Vec::as_slice);
                let kept = &events[events.len().saturating_sub(MAX_USAGE_EVENTS)..];
                let text: String = kept.iter().map(|event| format!("{}\n", mixdog_js::json_stringify(event))).collect();
                mixdog_statefile::write_file(lane, store, text.as_bytes(), &Opts::default()).map_err(|e| std::io::Error::other(e.to_string()))?;
            }
            let name = legacy.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
            let mut backup = legacy.with_file_name(format!("{name}{LEGACY_BACKUP_SUFFIX}"));
            if exists(lane, &backup) {
                backup = legacy.with_file_name(format!("{name}.{}{LEGACY_BACKUP_SUFFIX}", inner.clock.now_ms()));
            }
            mixdog_statefile::rename_with_retry(lane, &legacy, &backup)
        });
        if !matches!(moved, Ok(Ok(()))) {
            return;
        }
    }
    inner.migrated.store(true, Ordering::Release);
}

/// One batch appended under the lock; whether the store may now need compacting.
fn append_batch(lane: &InLane<DurabilityIo>, inner: &Inner, data: &str) -> Result<bool, String> {
    ensure_migrated(lane, inner);
    let store = &inner.store;
    let appended = mixdog_statefile::with_lock(lane, store, &LockOpts::default(), || -> std::io::Result<()> {
        if let Some(dir) = store.parent() {
            mixdog_statefile::create_dir_all(lane, dir)?;
        }
        mixdog_statefile::append_file(lane, store, data.as_bytes())
    });
    match appended {
        Ok(Ok(())) => Ok(mixdog_statefile::metadata(lane, store).is_ok_and(|meta| meta.len() >= COMPACT_MIN_BYTES)),
        Ok(Err(error)) => Err(error.to_string()),
        Err(error) => Err(error.to_string()),
    }
}

/// `runUsageCompaction`: the newest `MAX_USAGE_EVENTS` lines stay once the store holds over half as many
/// again. Best effort.
fn compact(lane: &InLane<DurabilityIo>, store: &Path) {
    let _ = mixdog_statefile::with_lock(lane, store, &LockOpts::default(), || -> std::io::Result<()> {
        let bytes = mixdog_statefile::read_content(store)?.unwrap_or_default();
        let text = String::from_utf8_lossy(&bytes);
        let lines: Vec<&str> = text.split('\n').filter(|line| !js_trim(line).is_empty()).collect();
        if lines.len() <= MAX_USAGE_EVENTS * 3 / 2 {
            return Ok(());
        }
        let kept = format!("{}\n", lines[lines.len() - MAX_USAGE_EVENTS..].join("\n"));
        mixdog_statefile::write_file(lane, store, kept.as_bytes(), &Opts::default()).map_err(|e| std::io::Error::other(e.to_string()))?;
        Ok(())
    });
}

impl GatewayUsage {
    pub fn new(data_dir: &Path, lane: DurabilityIo, clock: Arc<dyn Clock>, pricing: Arc<dyn UsagePricing>, scheduler: Arc<dyn Scheduler>) -> Self {
        let inner = Inner {
            store: data_dir.join(STORE_FILE),
            lane,
            clock,
            pricing,
            scheduler,
            state: Mutex::new(State::default()),
            migrated: AtomicBool::new(false),
            idle: Notify::new(),
            marks: mixdog_rt::WriteMarks::new("the gateway usage events"),
        };
        Self { inner: Arc::new(inner) }
    }

    pub fn store_path(&self) -> &Path {
        &self.inner.store
    }

    /// Runs `read` over the route section of this process (`routeSectionKey` / `routeSectionStartedAt` of
    /// `route-meta.mjs`): the one section the summaries and the footer's route spend (`buildGatewayLimits`) share.
    pub fn with_route_section<R>(&self, read: impl FnOnce(&mut RouteSection) -> R) -> R {
        read(&mut lock(&self.inner.state).section)
    }

    /// `summarizeGatewayUsage(..)` merged with `extra`, then `recordGatewayUsageEvent(..)`: the event is
    /// buffered; the twentieth flushes at once, the first schedules the flush.
    pub fn record(&self, route: &Value, provider_out: &Value, compact: &Value, duration_ms: Option<f64>, extra: Map<String, Value>) {
        let inner = &self.inner;
        let now = inner.clock.now_ms();
        let mut state = lock(&inner.state);
        let mut summary = event::summarize(&mut state.section, &*inner.pricing, route, provider_out, compact, duration_ms, now);
        summary.extend(extra);
        let line = mixdog_js::json_stringify(&event::event_of(&Value::Object(summary), now));
        state.pending.push((line, inner.marks.accept()));
        if state.pending.len() >= FLUSH_BATCH {
            self.flush_locked(&mut state);
        } else if state.flush_timer.is_none() {
            let this = self.clone();
            state.flush_timer = Some(inner.scheduler.after(FLUSH_DELAY_MS, Box::new(move || this.flush())));
        }
    }

    /// `takePendingUsageBatch`: the pending events as one append, the timer cleared.
    fn take_pending(state: &mut State) -> Option<(String, Vec<u64>)> {
        if let Some(cancel) = state.flush_timer.take() {
            cancel();
        }
        if state.pending.is_empty() {
            return None;
        }
        let (events, marks): (Vec<String>, Vec<u64>) = std::mem::take(&mut state.pending).into_iter().unzip();
        Some((format!("\n{}\n", events.join("\n")), marks))
    }

    fn flush_locked(&self, state: &mut State) {
        if let Some(data) = Self::take_pending(state) {
            state.batches.push_back(data);
        }
        if !state.draining && !state.batches.is_empty() {
            state.draining = true;
            tokio::spawn(drain(self.inner.clone()));
        }
    }

    /// `flushGatewayUsageEvents`: hands the pending events to the writer.
    pub fn flush(&self) {
        let mut state = lock(&self.inner.state);
        self.flush_locked(&mut state);
    }

    async fn idle_when(&self, done: impl Fn(&State) -> bool) {
        loop {
            let notified = self.inner.idle.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();
            if done(&lock(&self.inner.state)) {
                return;
            }
            notified.await;
        }
    }

    /// The last batch, written before the process ends (`flushGatewayUsageEventsSync`): resolves once the
    /// pending events and every batch before them are on disk.
    pub async fn flush_final(&self) {
        self.flush();
        self.idle_when(|state| !state.draining && state.batches.is_empty()).await;
    }

    /// `settleGatewayUsageWrites`: every recorded event written, and the compaction those writes scheduled
    /// run now instead of on its timer.
    pub async fn settle(&self) {
        self.flush_final().await;
        self.compact_scheduled_now().await;
    }

    /// The events' numbers: a barrier takes `accepted()` when it arrives, calls [`Self::flush`], waits for `reached` of
    /// it, then [`Self::compact_scheduled_now`].
    pub fn marks(&self) -> &mixdog_rt::WriteMarks {
        &self.inner.marks
    }

    /// The compaction the written appends scheduled runs now instead of on its timer, and one already running ends.
    pub async fn compact_scheduled_now(&self) {
        let scheduled = lock(&self.inner.state).compact_timer.take();
        if let Some(cancel) = scheduled {
            cancel();
            if begin_compaction(&self.inner) {
                run_compaction(self.inner.clone()).await;
            }
        }
        self.idle_when(|state| !state.compacting).await;
    }
}

async fn drain(inner: Arc<Inner>) {
    loop {
        let batch = {
            let mut state = lock(&inner.state);
            let batch = state.batches.pop_front();
            if batch.is_none() {
                state.draining = false;
            }
            batch
        };
        let Some((data, marks)) = batch else {
            inner.idle.notify_waiters();
            return;
        };
        let job = {
            let inner = inner.clone();
            move |lane: &InLane<DurabilityIo>| append_batch(lane, &inner, &data)
        };
        let written = match inner.lane.submit_wait(&CancellationToken::new(), job).await {
            Ok(handle) => handle.await.map_err(|error| error.to_string()).and_then(|result| result),
            Err(error) => Err(error.to_string()),
        };
        match written {
            Ok(large) => {
                marks.iter().for_each(|&mark| inner.marks.written(mark));
                maybe_schedule_compaction(&inner, large);
            }
            // Local telemetry never affects the routed call, but a lost batch is reported.
            Err(error) => {
                marks.iter().for_each(|&mark| inner.marks.failed(mark, &error));
                eprint!("[statusline] gateway usage events not saved: {error}\n");
            }
        }
    }
}

/// `maybeScheduleCompaction`: one compaction waits on its timer at a time.
fn maybe_schedule_compaction(inner: &Arc<Inner>, large: bool) {
    if !large {
        return;
    }
    let mut state = lock(&inner.state);
    if state.compact_timer.is_some() {
        return;
    }
    let this = inner.clone();
    state.compact_timer = Some(inner.scheduler.after(
        COMPACT_DELAY_MS,
        Box::new(move || {
            lock(&this.state).compact_timer = None;
            if begin_compaction(&this) {
                tokio::spawn(run_compaction(this));
            }
        }),
    ));
}

/// `compactRunning ??= ...`: whether this call starts the compaction (none is running).
fn begin_compaction(inner: &Inner) -> bool {
    let mut state = lock(&inner.state);
    !std::mem::replace(&mut state.compacting, true)
}

/// `runUsageCompaction`.
async fn run_compaction(inner: Arc<Inner>) {
    let store = inner.store.clone();
    if let Ok(handle) = inner.lane.submit_wait(&CancellationToken::new(), move |lane| compact(lane, &store)).await {
        let _ = handle.await;
    }
    lock(&inner.state).compacting = false;
    inner.idle.notify_waiters();
}
