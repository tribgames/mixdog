//! What a transcript read says of itself: one line of the daemon log when it was slow, and its place in the stall record
//! while it runs. The line is written once the request has ended and the read's last lane job has. How the request
//! ended is the server's word alone (`AfterAnswer::answered`): `answered_ms` when its answer, a page or an error,
//! entered the caller's outgoing queue, `request_ended_ms` when it ended with none there (its connection gone, the
//! request dropped). A job that outlived its request is said apart, as `job_outlived_ms`.

use std::sync::Arc;
use std::sync::Mutex;
use std::sync::PoisonError;
use std::sync::Weak;
use std::sync::atomic::AtomicU8;
use std::sync::atomic::AtomicU64;
use std::sync::atomic::Ordering::Relaxed;
use std::time::Duration;
use std::time::Instant;

use mixdog_core_api::AnswerQueued;
use mixdog_core_api::CoreError;
use mixdog_rt::CancellationToken;

/// A read this long is said in the log (the daemon's `[slow-op]` threshold).
const SLOW: Duration = Duration::from_secs(1);

type Sink = Arc<dyn Fn(&str) + Send + Sync>;

static SINK: Mutex<Option<Sink>> = Mutex::new(None);
static RUNNING: Mutex<Vec<Weak<Inner>>> = Mutex::new(Vec::new());

/// The log the slow reads are said in, as `[slow-op] <method> thread=.. ..`.
pub fn log_to(sink: Sink) {
    *SINK.lock().unwrap_or_else(PoisonError::into_inner) = Some(sink);
}

/// The reads running now, each as its log line would say it so far.
pub fn running() -> Vec<String> {
    let reads: Vec<Arc<Inner>> = {
        let mut running = RUNNING.lock().unwrap_or_else(PoisonError::into_inner);
        running.retain(|read| read.strong_count() > 0);
        running.iter().filter_map(Weak::upgrade).collect()
    };
    reads.iter().map(|read| read.line()).collect()
}

/// Where a read is.
#[derive(Clone, Copy)]
pub(super) enum Stage {
    /// Off the lanes, until the index holds the writes acknowledged before the read and no rewrite holds the logs.
    Wait = 0,
    /// Admitted to a lane, not yet run.
    Queue = 1,
    /// In its interactive I/O job.
    Io = 2,
    /// In its CPU job.
    Cpu = 3,
    Done = 4,
}

const STAGES: [&str; 5] = ["wait", "queue", "io", "cpu", "done"];

struct Inner {
    method: &'static str,
    thread: String,
    shape: String,
    began: Instant,
    stage: AtomicU8,
    /// Microseconds after `began` at which `stage` was entered.
    since: AtomicU64,
    spent: [AtomicU64; 4],
    asked: AtomicU64,
    index_rows: AtomicU64,
    frames: AtomicU64,
    fetches: AtomicU64,
    restarts: AtomicU64,
    held: AtomicU64,
    rows: AtomicU64,
    /// Microseconds after `began` at which the read had its reply; 0 until then.
    worked: AtomicU64,
    /// Microseconds after `began` at which the request ended for its caller; 0 until then.
    answered: AtomicU64,
    /// The request ended with its answer in the caller's outgoing queue.
    queued: AtomicU8,
    /// The read's lane jobs running now.
    jobs: AtomicU64,
    /// A lane job was still running when the request ended.
    outlived: AtomicU8,
}

impl Inner {
    fn now(&self) -> u64 {
        self.began.elapsed().as_micros() as u64
    }

    fn line(&self) -> String {
        let (now, stage, since) = (self.now(), self.stage.load(Relaxed) as usize, self.since.load(Relaxed));
        let spent = |at: usize| (self.spent[at].load(Relaxed) + if at == stage { now.saturating_sub(since) } else { 0 }) / 1000;
        let worked = self.worked.load(Relaxed);
        let state =
            if worked > 0 { format!("work_ms={}", worked / 1000) } else { format!("stage={} stage_ms={}", STAGES[stage], now.saturating_sub(since) / 1000) };
        format!(
            "{} thread={} {} asked={} index_rows={} frames={} rows={} fetches={} restarts={} held={} wait_ms={} queue_ms={} io_ms={} cpu_ms={} {state}",
            self.method,
            self.thread,
            self.shape,
            self.asked.load(Relaxed),
            self.index_rows.load(Relaxed),
            self.frames.load(Relaxed),
            self.rows.load(Relaxed),
            self.fetches.load(Relaxed),
            self.restarts.load(Relaxed),
            self.held.load(Relaxed),
            spent(0),
            spent(1),
            spent(2),
            spent(3),
        )
    }
}

impl Drop for Inner {
    fn drop(&mut self) {
        let total = self.began.elapsed();
        if total < SLOW {
            return;
        }
        let sink = SINK.lock().unwrap_or_else(PoisonError::into_inner).clone();
        let Some(sink) = sink else { return };
        let answered = self.answered.load(Relaxed);
        let mut line = self.line();
        if answered > 0 {
            let name = if self.queued.load(Relaxed) > 0 { "answered_ms" } else { "request_ended_ms" };
            line.push_str(&format!(" {name}={}", answered / 1000));
        }
        if self.outlived.load(Relaxed) > 0 {
            line.push_str(&format!(" job_outlived_ms={}", (total.as_micros() as u64).saturating_sub(answered) / 1000));
        }
        sink(&format!("[slow-op] {line}"));
    }
}

/// Kept by the request (`CallContext::after_answer`) until it ends: its drop is that moment in the read's line, with
/// what the server said of the answer by then.
pub(super) struct Answered(ReadTrace, AnswerQueued);

impl Drop for Answered {
    fn drop(&mut self) {
        let Some(read) = &self.0.0 else { return };
        read.queued.store(u8::from(self.1.get()), Relaxed);
        read.answered.store(read.now().max(1), Relaxed);
        read.outlived.store(u8::from(read.jobs.load(Relaxed) > 0), Relaxed);
    }
}

/// One lane job of a read, from its start to its end.
pub(super) struct Running(ReadTrace);

impl Drop for Running {
    fn drop(&mut self) {
        if let Some(read) = &self.0.0 {
            read.jobs.fetch_sub(1, Relaxed);
        }
    }
}

/// One read's trace, shared with its lane jobs; an untraced read's does nothing.
#[derive(Clone, Default)]
pub struct ReadTrace(Option<Arc<Inner>>);

impl ReadTrace {
    /// `shape`: what was asked, as `key=value` words (never a value of the conversation).
    pub(super) fn begin(method: &'static str, thread: &str, shape: String) -> Self {
        let inner = Arc::new(Inner {
            method,
            thread: thread.to_owned(),
            shape,
            began: Instant::now(),
            stage: AtomicU8::new(Stage::Wait as u8),
            since: AtomicU64::new(0),
            spent: Default::default(),
            asked: AtomicU64::new(0),
            index_rows: AtomicU64::new(0),
            frames: AtomicU64::new(0),
            fetches: AtomicU64::new(0),
            restarts: AtomicU64::new(0),
            held: AtomicU64::new(0),
            rows: AtomicU64::new(0),
            worked: AtomicU64::new(0),
            answered: AtomicU64::new(0),
            queued: AtomicU8::new(0),
            jobs: AtomicU64::new(0),
            outlived: AtomicU8::new(0),
        });
        let mut running = RUNNING.lock().unwrap_or_else(PoisonError::into_inner);
        running.retain(|read| read.strong_count() > 0);
        running.push(Arc::downgrade(&inner));
        Self(Some(inner))
    }

    /// `queued`: the request's [`AfterAnswer::queued`](mixdog_core_api::AfterAnswer::queued).
    pub(super) fn answered(&self, queued: AnswerQueued) -> Answered {
        Answered(self.clone(), queued)
    }

    pub(super) fn job(&self) -> Running {
        if let Some(read) = &self.0 {
            read.jobs.fetch_add(1, Relaxed);
        }
        Running(self.clone())
    }

    pub(super) fn enter(&self, stage: Stage) {
        let Some(read) = &self.0 else { return };
        let now = read.now();
        let (left, since) = (read.stage.swap(stage as u8, Relaxed) as usize, read.since.swap(now, Relaxed));
        if let Some(spent) = read.spent.get(left) {
            spent.fetch_add(now.saturating_sub(since), Relaxed);
        }
    }

    fn add(&self, counter: impl Fn(&Inner) -> &AtomicU64, n: usize) {
        if let Some(read) = &self.0 {
            counter(read).fetch_add(n as u64, Relaxed);
        }
    }

    /// One more stored page was asked for, of `records` records.
    pub(super) fn fetch(&self, records: usize) {
        self.add(|read| &read.fetches, 1);
        if let Some(read) = &self.0 {
            read.asked.fetch_max(records as u64, Relaxed);
        }
    }

    pub fn index_rows(&self, n: usize) {
        self.add(|read| &read.index_rows, n);
    }

    pub fn frame(&self) {
        self.add(|read| &read.frames, 1);
    }

    /// The history moved under the read: it starts again.
    pub fn restart(&self) {
        self.add(|read| &read.restarts, 1);
    }

    /// The job would have had to wait: it gave its worker back and the read waits off the lane.
    pub(super) fn held(&self) {
        self.add(|read| &read.held, 1);
    }

    /// The read has its reply, of `rows` rows.
    pub(super) fn worked(&self, rows: usize) {
        self.enter(Stage::Done);
        if let Some(read) = &self.0 {
            read.rows.store(rows as u64, Relaxed);
            read.worked.store(read.now().max(1), Relaxed);
        }
    }
}

/// What a read's lane job takes with it: the caller's cancellation (its request's, which its connection's close cancels)
/// and the read's trace.
#[derive(Clone)]
pub struct ReadCtl {
    pub cancel: CancellationToken,
    pub trace: ReadTrace,
}

impl ReadCtl {
    pub fn untraced(cancel: CancellationToken) -> Self {
        Self { cancel, trace: ReadTrace::default() }
    }

    pub fn check(&self) -> Result<(), CoreError> {
        super::seams::check_turn_read_cancel(&self.cancel)
    }

    /// Before each record read from the log: the job is advancing, and stops here once its caller is gone.
    pub fn record(&self) -> Result<(), CoreError> {
        mixdog_rt::job_progress();
        self.trace.frame();
        self.check()
    }
}
