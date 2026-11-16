//! The stall monitor (LR §5.4 Crash, SPEC R48). A dedicated OS thread posts a probe task onto the
//! async runtime and measures how long the previous probe has been waiting; with
//! [`StallReporter::watching_lanes`] it also reports pooled lanes whose workers are stuck past their
//! lease. A stall is reported, not acted on, until it has lasted [`END_AFTER`]: a runtime that has
//! answered nothing for that long (the old supervisor's freeze limit, `DAEMON_FREEZE_LIMIT_MS`) is
//! ended by this thread through the lifecycle's stalled-core exit (`Lifecycle::terminate`: the exit
//! record, discovery withdrawn, the process ends), because the core may have been started detached by a
//! launcher that has gone, and a hung core serves nothing and nobody else would end it. The time is
//! awake time: a gap between two looks (a system sleep) starts the count again. A launcher that owns its
//! core also asks the control status (`stalledMs`, answered by a thread of its own) and kills a core that
//! does not answer (`watchCore` in `packages/protocol-client/src/launch/ensure-core.mjs`).
//!
//! The line the file gets when a stall starts and ends names what the core was doing
//! ([`StallDescription`]): the calls that overlapped the stall (the slow ones, [`SlowSpans`], as Node's
//! `slowSpans.describe`) and the work in flight at the report (`createStallDescriber`).

#![allow(
    clippy::disallowed_methods,
    clippy::disallowed_types,
    reason = "diagnostics are appended by the monitor OS thread, which exists to survive a stalled runtime"
)]

use std::collections::HashMap;
use std::collections::VecDeque;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::PoisonError;
use std::sync::atomic::AtomicU64;
use std::sync::atomic::Ordering;
use std::sync::mpsc;
use std::thread::JoinHandle;
use std::time::Duration;
use std::time::Instant;
use std::time::SystemTime;
use std::time::UNIX_EPOCH;

use mixdog_rt::exec::Executors;

use super::handle::Lifecycle;
use super::ports::CorePort;
use crate::telemetry::WorkCounts;

/// How long the runtime may answer nothing before the monitor ends the process (`DAEMON_FREEZE_LIMIT_MS`).
pub const END_AFTER: Duration = Duration::from_secs(120);

/// A look this much later than the interval says the machine slept (or the thread was not scheduled): the count of a stall starts again.
const SLEEP_GAP: Duration = Duration::from_secs(5);

/// Spans shorter than this are not kept (`SPAN_RING_MIN_MS`).
const SPAN_RING_MIN_MS: f64 = 25.0;
/// Spans this long are logged as `[slow-op]` (`SPAN_SLOW_MS`).
const SPAN_SLOW_MS: f64 = 1000.0;
/// The ring's size (`SPAN_RING_CAPACITY`).
const SPAN_RING_CAPACITY: usize = 64;
/// How many overlapping spans a stall line names.
const SPANS_PER_LINE: usize = 3;

struct Span {
    label: String,
    start: f64,
    end: f64,
}

/// Node's `slowSpans`: the calls that took long, on one monotonic clock, kept in a bounded ring so a stall can name the ones
/// that overlapped it. Labels and durations only, never payloads.
pub struct SlowSpans {
    origin: Instant,
    ring: Mutex<VecDeque<Span>>,
    log: Arc<dyn Fn(&str) + Send + Sync>,
}

impl SlowSpans {
    /// `log` is the daemon log's line writer: a span of a second or more is said there as `[slow-op] <label> <ms>ms`.
    pub fn new(log: Arc<dyn Fn(&str) + Send + Sync>) -> Arc<Self> {
        Arc::new(Self { origin: Instant::now(), ring: Mutex::new(VecDeque::new()), log })
    }

    /// Milliseconds on the clock the spans are kept on.
    pub fn now_ms(&self) -> f64 {
        self.origin.elapsed().as_secs_f64() * 1000.0
    }

    /// The span of one call, `label` its name; it is complete when the guard drops.
    pub fn begin(self: &Arc<Self>, label: String) -> SpanGuard {
        SpanGuard { spans: Arc::clone(self), label, start: self.now_ms() }
    }

    fn complete(&self, label: String, start: f64) {
        let end = self.now_ms();
        self.record(label, start, end);
    }

    fn record(&self, label: String, start: f64, end: f64) {
        let ms = end - start;
        if ms >= SPAN_SLOW_MS {
            (self.log)(&format!("[slow-op] {label} {}ms", ms.round()));
        }
        if ms >= SPAN_RING_MIN_MS {
            let mut ring = self.ring.lock().unwrap_or_else(PoisonError::into_inner);
            ring.push_back(Span { label, start, end });
            if ring.len() > SPAN_RING_CAPACITY {
                ring.pop_front();
            }
        }
    }

    /// `spans: <label> <ms>ms; ...` for the completed spans that overlapped `[from, to]`, the longest overlap first (empty for none).
    pub fn describe(&self, from: f64, to: f64) -> String {
        let ring = self.ring.lock().unwrap_or_else(PoisonError::into_inner);
        let mut rows: Vec<(f64, &Span)> = ring.iter().map(|span| (span.end.min(to) - span.start.max(from), span)).filter(|(overlap, _)| *overlap > 0.0).collect();
        rows.sort_by(|a, b| b.0.total_cmp(&a.0).then(b.1.end.total_cmp(&a.1.end)));
        if rows.is_empty() {
            return String::new();
        }
        let named: Vec<String> = rows.iter().take(SPANS_PER_LINE).map(|(_, span)| format!("{} {}ms", span.label, (span.end - span.start).round())).collect();
        format!("spans: {}", named.join("; "))
    }
}

/// One call's span, completed on drop.
pub struct SpanGuard {
    spans: Arc<SlowSpans>,
    label: String,
    start: f64,
}

impl Drop for SpanGuard {
    fn drop(&mut self) {
        self.spans.complete(std::mem::take(&mut self.label), self.start);
    }
}

/// What a stall line says about the core: the work in flight and the calls that overlapped the stall.
#[derive(Clone)]
pub struct StallDescription {
    pub work: Arc<dyn Fn() -> WorkCounts + Send + Sync>,
    pub spans: Arc<SlowSpans>,
}

impl StallDescription {
    /// `createStallDescriber`: the overlapping spans, then `in-flight: activeCalls=.. queuedCalls=.. busySessions=.. busyMemoryAgents=..`.
    fn describe(&self, stalled_ms: u64) -> String {
        let to = self.spans.now_ms();
        let mut parts = Vec::new();
        let overlapping = self.spans.describe(to - Duration::from_millis(stalled_ms).as_secs_f64() * 1000.0, to);
        if !overlapping.is_empty() {
            parts.push(overlapping);
        }
        let work = (self.work)();
        parts.push(format!(
            "in-flight: activeCalls={} queuedCalls={} busySessions={} busyMemoryAgents={}",
            work.active_calls, work.queued_calls, work.busy_sessions, work.busy_memory_agents
        ));
        parts.join(" | ")
    }
}

/// Runs a closure on the async runtime the monitor watches.
pub type Post = Arc<dyn Fn(Box<dyn FnOnce() + Send>) + Send + Sync>;

/// A [`Post`] that spawns onto `handle`.
pub fn tokio_post(handle: tokio::runtime::Handle) -> Post {
    Arc::new(move |job| {
        handle.spawn(async move { job() });
    })
}

#[derive(Debug, Clone, Copy)]
pub struct StallConfig {
    /// How often a probe is posted and the wait measured.
    pub interval: Duration,
    /// A probe waiting this long counts as a stall worth reporting.
    pub report_after: Duration,
}

impl Default for StallConfig {
    fn default() -> Self {
        Self { interval: Duration::from_secs(1), report_after: Duration::from_secs(2) }
    }
}

/// Where a measurement goes: `core/health` on the feed and the diagnostics file.
pub struct StallReporter {
    core: Arc<dyn CorePort>,
    diagnostics: PathBuf,
    peak_ms: Mutex<u64>,
    lanes: Option<Arc<Executors>>,
    /// Wedged-worker count last reported per lane name.
    lane_wedged: Mutex<HashMap<&'static str, usize>>,
    describing: Option<StallDescription>,
    /// A stall this long ends the process (`None`: it is only reported).
    end_after: Option<Duration>,
}

impl StallReporter {
    pub fn new(core: Arc<dyn CorePort>, diagnostics: PathBuf) -> Self {
        Self { core, diagnostics, peak_ms: Mutex::new(0), lanes: None, lane_wedged: Mutex::new(HashMap::new()), describing: None, end_after: Some(END_AFTER) }
    }

    /// The stall lines name the overlapping calls and the work in flight.
    pub fn describing(mut self, description: StallDescription) -> Self {
        self.describing = Some(description);
        self
    }

    /// A stall of `limit` ends the process; `None` leaves a stall reported only.
    pub fn ending_after(mut self, limit: Option<Duration>) -> Self {
        self.end_after = limit;
        self
    }

    /// `stalled_ms == 0` means the runtime answered. The file gets one line when a stall
    /// starts and one when it ends.
    fn report(&self, stalled_ms: u64) {
        let mut peak = self.peak_ms.lock().unwrap_or_else(PoisonError::into_inner);
        let event = match (*peak, stalled_ms) {
            (0, 0) => None,
            (0, _) => Some("stalled"),
            (_, 0) => Some("recovered"),
            _ => None,
        };
        let line_ms = if stalled_ms == 0 { *peak } else { stalled_ms };
        *peak = if stalled_ms == 0 { 0 } else { (*peak).max(stalled_ms) };
        drop(peak);
        self.core.health(stalled_ms);
        if let Some(event) = event {
            self.append(event, line_ms);
        }
    }

    /// Also watches the pooled lanes of `executors` (F1): a lane whose workers are stuck past
    /// their lease is reported like a runtime stall.
    pub fn watching_lanes(mut self, executors: Arc<Executors>) -> Self {
        self.lanes = Some(executors);
        self
    }

    /// One file line and one error log whenever a lane's wedged-worker count changes.
    fn report_lanes(&self) {
        let Some(executors) = &self.lanes else { return };
        let mut seen = self.lane_wedged.lock().unwrap_or_else(PoisonError::into_inner);
        for lane in executors.diagnostics().lanes {
            let name = lane.kind.name();
            if seen.insert(name, lane.wedged).unwrap_or(0) == lane.wedged {
                continue;
            }
            let event = if lane.wedged == 0 { "laneRecovered" } else { "laneWedged" };
            if lane.wedged > 0 {
                tracing::error!(lane = name, wedged = lane.wedged, threads = lane.threads, "lane workers are stuck past their lease");
            }
            self.core.lane_health(name, lane.wedged);
            self.write_line(&format!("\"event\":\"{event}\",\"lane\":\"{name}\",\"wedged\":{},\"threads\":{}", lane.wedged, lane.threads));
        }
    }

    fn append(&self, event: &str, stalled_ms: u64) {
        let detail = self.describing.as_ref().map(|description| format!(",\"detail\":{}", serde_json::Value::String(description.describe(stalled_ms))));
        self.write_line(&format!("\"event\":\"{event}\",\"stalledMs\":{stalled_ms}{}", detail.unwrap_or_default()));
    }

    /// The runtime has answered nothing for `stalled_ms`, as long as the limit: the line says so and the lifecycle's stalled-core exit ends
    /// the process (it touches nothing the runtime owns: it records the exit, withdraws discovery and exits).
    fn end(&self, lifecycle: &Lifecycle, stalled_ms: u64) {
        tracing::error!(stalled_ms, "the runtime answered nothing for the stall limit: ending the process");
        self.append("ending", stalled_ms);
        let token = lifecycle.status().terminate_token.clone();
        if let Err(error) = lifecycle.terminate(&token, || {}) {
            tracing::error!(%error, "the stalled core could not be ended");
        }
    }

    fn write_line(&self, fields: &str) {
        use std::io::Write;
        let at_ms = SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_millis());
        let line = format!("{{{fields},\"atMs\":{at_ms}}}\n");
        let written = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&self.diagnostics)
            .and_then(|mut file| file.write_all(line.as_bytes()));
        if let Err(error) = written {
            tracing::error!(%error, "stall diagnostics were not written");
        }
    }
}

pub struct StallMonitor {
    stop: Option<mpsc::Sender<()>>,
    thread: Option<JoinHandle<()>>,
}

impl StallMonitor {
    pub fn spawn(
        config: StallConfig,
        post: Post,
        lifecycle: Arc<Lifecycle>,
        reporter: StallReporter,
    ) -> Self {
        let (stop, wake) = mpsc::channel::<()>();
        let thread = std::thread::Builder::new()
            .name("mixdog-stall-monitor".into())
            .spawn(move || watch(config, post, &lifecycle, &reporter, &wake))
            .expect("the OS refused the stall monitor thread");
        Self { stop: Some(stop), thread: Some(thread) }
    }
}

impl Drop for StallMonitor {
    fn drop(&mut self) {
        drop(self.stop.take());
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

fn watch(
    config: StallConfig,
    post: Post,
    lifecycle: &Lifecycle,
    reporter: &StallReporter,
    wake: &mpsc::Receiver<()>,
) {
    let origin = Instant::now();
    // Milliseconds since `origin` plus one at which the outstanding probe was posted; 0 = none.
    let outstanding = Arc::new(AtomicU64::new(0));
    let mut looked = Instant::now();
    loop {
        if !matches!(wake.recv_timeout(config.interval), Err(mpsc::RecvTimeoutError::Timeout)) {
            return;
        }
        let gap = looked.elapsed();
        looked = Instant::now();
        let now = u64::try_from(origin.elapsed().as_millis()).unwrap_or(u64::MAX);
        if gap > config.interval + SLEEP_GAP {
            // The machine slept, or this thread was not scheduled: what looks like a long wait is not the runtime's. Only a
            // probe still waiting restarts its count (it clears the mark when it runs); with none waiting nothing is marked, or
            // the mark would be a wait that no probe ever answers.
            let _ = outstanding.try_update(Ordering::AcqRel, Ordering::Acquire, |posted| (posted != 0).then_some(now + 1));
        }
        let posted = outstanding.load(Ordering::Acquire);
        let waited = if posted == 0 {
            outstanding.store(now + 1, Ordering::Release);
            let answered = Arc::clone(&outstanding);
            post(Box::new(move || answered.store(0, Ordering::Release)));
            0
        } else {
            now.saturating_sub(posted - 1)
        };
        let stalled = if u128::from(waited) >= config.report_after.as_millis() { waited } else { 0 };
        lifecycle.set_stalled_ms(stalled);
        reporter.report(stalled);
        reporter.report_lanes();
        if reporter.end_after.is_some_and(|limit| u128::from(stalled) >= limit.as_millis()) {
            reporter.end(lifecycle, stalled);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::super::testing::fixture;
    use super::*;

    fn spans() -> (Arc<SlowSpans>, Arc<Mutex<Vec<String>>>) {
        let lines = Arc::new(Mutex::new(Vec::new()));
        let sink = Arc::clone(&lines);
        (SlowSpans::new(Arc::new(move |line| sink.lock().unwrap().push(line.to_owned()))), lines)
    }

    #[test]
    fn spans_under_the_floor_are_not_kept_and_slow_ones_are_logged() {
        let (spans, lines) = spans();
        spans.record("quick".into(), 0.0, 24.0);
        assert_eq!(spans.describe(0.0, 100.0), "");
        spans.record("session.read#abcd1234:getTurnChanges".into(), 0.0, 480.0);
        assert!(lines.lock().unwrap().is_empty());
        spans.record("thread/start".into(), 0.0, 1500.4);
        assert_eq!(*lines.lock().unwrap(), ["[slow-op] thread/start 1500ms"]);
    }

    #[test]
    fn a_stall_names_the_three_longest_overlapping_spans() {
        let (spans, _) = spans();
        spans.record("a".into(), 0.0, 100.0);
        spans.record("b".into(), 50.0, 400.0);
        spans.record("c".into(), 90.0, 300.0);
        spans.record("d".into(), 300.0, 330.0);
        spans.record("late".into(), 900.0, 1000.0);
        assert_eq!(spans.describe(80.0, 500.0), "spans: b 350ms; c 210ms; d 30ms");
        assert_eq!(spans.describe(600.0, 700.0), "", "a window nothing overlapped names no span");
    }

    #[test]
    fn the_ring_keeps_the_newest_sixty_four() {
        let (spans, _) = spans();
        for n in 0..70 {
            spans.record(format!("s{n}"), f64::from(n) * 100.0, f64::from(n) * 100.0 + 50.0);
        }
        assert_eq!(spans.ring.lock().unwrap().len(), SPAN_RING_CAPACITY);
        assert!(spans.describe(0.0, 600.0).is_empty(), "the oldest were dropped");
        assert!(spans.describe(6900.0, 7000.0).starts_with("spans: s69 50ms"));
    }

    fn reporter_with(fx: &super::super::testing::Fixture, work: WorkCounts) -> (StallReporter, PathBuf, Arc<SlowSpans>) {
        let (spans, _) = spans();
        let path = fx.runtime_root.path().join("stall.jsonl");
        let reporter = StallReporter::new(fx.recorder.clone(), path.clone()).describing(StallDescription { work: Arc::new(move || work), spans: Arc::clone(&spans) });
        (reporter, path, spans)
    }

    #[test]
    fn the_stall_line_carries_the_in_flight_work() {
        let fx = fixture();
        let (reporter, path, _) = reporter_with(&fx, WorkCounts { active_calls: 2, queued_calls: 1, busy_sessions: 1, busy_memory_agents: 0 });
        reporter.report(2500);
        reporter.report(0);
        let text = std::fs::read_to_string(path).unwrap();
        let lines: Vec<serde_json::Value> = text.lines().map(|line| serde_json::from_str(line).unwrap()).collect();
        assert_eq!(lines.len(), 2);
        assert_eq!((lines[0]["event"].as_str(), lines[0]["stalledMs"].as_u64()), (Some("stalled"), Some(2500)));
        assert_eq!(lines[0]["detail"], "in-flight: activeCalls=2 queuedCalls=1 busySessions=1 busyMemoryAgents=0");
        assert_eq!(lines[1]["event"], "recovered");
    }

    #[test]
    fn the_stall_line_names_the_overlapping_spans_before_the_work() {
        let fx = fixture();
        let (reporter, path, spans) = reporter_with(&fx, WorkCounts::default());
        let now = spans.now_ms();
        spans.record("session.read#abcd1234:getTurnChanges".into(), now - 400.0, now - 5.0);
        reporter.report(1000);
        let line: serde_json::Value = serde_json::from_str(std::fs::read_to_string(path).unwrap().lines().next().unwrap()).unwrap();
        assert_eq!(
            line["detail"],
            "spans: session.read#abcd1234:getTurnChanges 395ms | in-flight: activeCalls=0 queuedCalls=0 busySessions=0 busyMemoryAgents=0"
        );
    }

    /// A runtime that answers nothing (the probe is never run) for the limit ends the process through the lifecycle's stalled-core exit.
    #[test]
    fn a_runtime_that_answers_nothing_for_the_limit_ends_the_process() {
        let fx = fixture();
        let (reporter, path, _) = reporter_with(&fx, WorkCounts::default());
        let _monitor = StallMonitor::spawn(
            StallConfig { interval: Duration::from_millis(20), report_after: Duration::from_millis(40) },
            Arc::new(|_job| {}),
            Arc::clone(&fx.lifecycle),
            reporter.ending_after(Some(Duration::from_millis(200))),
        );
        let deadline = Instant::now() + Duration::from_secs(10);
        while !fx.recorder.has_exited() && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(10));
        }
        assert_eq!(fx.recorder.exit_code(), Some(0));
        assert!(std::fs::read_to_string(path).unwrap().contains("\"event\":\"ending\""));
    }

    #[test]
    fn a_stall_below_the_limit_is_reported_and_not_acted_on() {
        let fx = fixture();
        let _monitor = StallMonitor::spawn(
            StallConfig { interval: Duration::from_millis(20), report_after: Duration::from_millis(40) },
            Arc::new(|_job| {}),
            Arc::clone(&fx.lifecycle),
            StallReporter::new(fx.recorder.clone(), fx.runtime_root.path().join("stall.jsonl")),
        );
        std::thread::sleep(Duration::from_millis(300));
        assert!(fx.lifecycle.stalled_ms() >= 40, "the stall is reported");
        assert!(!fx.recorder.has_exited(), "the default limit is two minutes");
    }

    /// A gap between two looks (here: the first post holds the monitor thread past the sleep gap) while the runtime answers every
    /// probe marks no wait: the answering runtime is neither reported stalled nor ended.
    #[test]
    fn a_gap_while_the_runtime_answers_is_no_stall() {
        let fx = fixture();
        let first = Arc::new(std::sync::atomic::AtomicBool::new(true));
        let _monitor = StallMonitor::spawn(
            StallConfig { interval: Duration::from_millis(20), report_after: Duration::from_millis(40) },
            Arc::new(move |job: Box<dyn FnOnce() + Send>| {
                job();
                if first.swap(false, Ordering::AcqRel) {
                    std::thread::sleep(SLEEP_GAP + Duration::from_millis(100));
                }
            }),
            Arc::clone(&fx.lifecycle),
            StallReporter::new(fx.recorder.clone(), fx.runtime_root.path().join("stall.jsonl")).ending_after(Some(Duration::from_millis(200))),
        );
        std::thread::sleep(SLEEP_GAP + Duration::from_millis(700));
        assert_eq!(fx.lifecycle.stalled_ms(), 0, "the runtime answered every probe");
        assert!(!fx.recorder.has_exited(), "an answering runtime is not ended");
    }
}
