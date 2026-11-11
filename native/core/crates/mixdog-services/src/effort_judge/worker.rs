//! The judge's own executor, in the shape of Node's judge worker (`judge-worker.mjs`): one dedicated
//! thread at normal priority, started on first use, that loads the model, warms it up and runs every
//! judgment, one job at a time in the order they were sent. Nothing else runs on it, so history-sized
//! CPU work on the shared lanes can neither hold its thread nor fill its queue.
//!
//! The model lives on the thread ([`Seat`]) and never leaves it. Node's client terminates a worker
//! that has not answered a judgment for `STUCK_MS` and starts a fresh one on the next turn; a thread
//! cannot be terminated, so here it is given up instead: its waiters answer at once, the next job
//! starts a new thread that loads its own model, and the given-up ("lost") thread drops its model and
//! ends when its stuck job returns. One thread at most is lost: while one is, a second that stalls is
//! not replaced, and every job answers at once until one of them returns. A job that panics gives its
//! thread up the same way (Node's worker `error`/`exit`). Nothing ever joins the thread.

use std::panic::AssertUnwindSafe;
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::mpsc;
use std::sync::{Arc, Mutex, MutexGuard, PoisonError, Weak};
use std::time::Duration;

use mixdog_rt::{JudgeThread, ThreadToken};
use tokio::sync::oneshot;
use tokio_util::sync::CancellationToken;

use crate::effort_judge::error::JudgeError;
use crate::effort_judge::judge::Resident;
use crate::tool_state::StateTick;

/// Node's `STUCK_MS` (`judge-client.mjs:42`, armed at `:181`): a judgment its thread has not answered
/// this long after it was sent marks the thread stuck.
pub(crate) const STUCK: Duration = Duration::from_secs(10);

/// Jobs a thread's queue holds behind its running one. Node sends its worker the next judgment only
/// once the worker answered the previous one (`judge-client.mjs:27-33`, `:350-357`): at most one
/// judgment runs and one more, the next request, waits for it. The core keeps that order behind its
/// gate, so a job only waits here when its caller left the gate early (a step whose run was
/// cancelled); a job past that one is answered at once.
pub(crate) const QUEUE: usize = 1;

const EXITED: &str = "the effort judge thread exited";

/// What the judge's thread owns: the model loaded on it.
pub(crate) struct Seat {
    pub(crate) model: Option<Arc<dyn Resident>>,
    /// Which thread this is; a model loaded here is the judge's while this thread takes jobs.
    pub(crate) generation: u64,
}

/// Arms the watchdog's deadlines: the core ticker in the product, a clock the test advances in tests.
pub(crate) trait Alarm: Send + Sync {
    fn after(&self, delay: Duration, ring: Box<dyn FnOnce() + Send>);
}

/// The core ticker. A ring is never disarmed: one for a job that answered in time does nothing.
pub(crate) struct TickerAlarm;

impl Alarm for TickerAlarm {
    fn after(&self, delay: Duration, ring: Box<dyn FnOnce() + Send>) {
        let _armed = mixdog_rt::ticker().register(std::time::Instant::now() + delay, ring);
    }
}

/// A job as the thread runs it. When it panicked it hands back its answer, which the thread delivers
/// once it has given itself up, so a caller that reads it finds the next job going to a new thread.
type Job = Box<dyn FnOnce(&mut Seat) -> Result<(), Deliver> + Send>;
type Deliver = Box<dyn FnOnce() + Send>;

/// How a job ended, as its thread reports it.
enum Ran<R> {
    Done(R),
    Panicked(String),
    /// Its caller had given up before it came up: dropped, not run.
    Skipped,
}

/// Why a job has no answer.
enum Failure {
    /// The thread's queue is full.
    Busy,
    /// The thread was given up or ended before answering.
    Exited,
    Panicked(String),
    Skipped,
}

impl Failure {
    /// A panicking load is a load failure, as a throwing `load()` is Node's `load-error`.
    fn into_error(self, load: bool) -> JudgeError {
        match self {
            Self::Busy => JudgeError::Busy,
            Self::Exited => JudgeError::Worker(EXITED.to_owned()),
            Self::Panicked(message) if load => JudgeError::Load(message),
            Self::Panicked(message) => JudgeError::Worker(format!("the effort judge thread panicked: {message}")),
            Self::Skipped => JudgeError::Cancelled,
        }
    }
}

fn panic_message(payload: &(dyn std::any::Any + Send)) -> String {
    payload
        .downcast_ref::<&str>()
        .map(|text| (*text).to_owned())
        .or_else(|| payload.downcast_ref::<String>().cloned())
        .unwrap_or_else(|| "panicked".to_owned())
}

/// What a thread and the worker both count.
#[derive(Default)]
struct Counters {
    /// Jobs sent and not finished, the running one included.
    pending: AtomicUsize,
    /// Jobs finished, in the order sent.
    finished: AtomicU64,
}

/// One judge thread as the worker holds it. The thread ends once every holder let go of this
/// (the sender with it) and its queue is drained.
struct Live {
    generation: u64,
    /// The queue and the number of jobs sent through it, together so the numbers follow the order.
    jobs: Mutex<(mpsc::Sender<Job>, u64)>,
    counters: Arc<Counters>,
    /// Fired when the thread's waiters are answered without it; a stalled thread gets a fresh one.
    gone: Mutex<CancellationToken>,
    /// Past the watchdog while another thread is lost: it takes no job until its job returns.
    stalled: AtomicBool,
}

impl Live {
    /// Queues `job` and answers its number; `bounded` refuses it when [`QUEUE`] jobs already wait.
    fn push(&self, job: Job, bounded: bool) -> Result<u64, Failure> {
        let mut jobs = self.jobs.lock().unwrap_or_else(PoisonError::into_inner);
        if bounded && self.counters.pending.load(Ordering::Acquire) > QUEUE {
            return Err(Failure::Busy);
        }
        self.counters.pending.fetch_add(1, Ordering::AcqRel);
        if jobs.0.send(job).is_err() {
            self.counters.pending.fetch_sub(1, Ordering::AcqRel);
            return Err(Failure::Exited);
        }
        jobs.1 += 1;
        Ok(jobs.1)
    }

    fn answer_waiters(&self, renew: bool) {
        let mut gone = self.gone.lock().unwrap_or_else(PoisonError::into_inner);
        gone.cancel();
        if renew {
            *gone = CancellationToken::new();
        }
    }
}

#[derive(Default)]
struct Threads {
    /// The thread taking jobs.
    current: Option<Arc<Live>>,
    /// The thread given up and still running its stuck job.
    lost: Option<u64>,
    generations: u64,
}

struct Shared {
    threads: Mutex<Threads>,
    tick: StateTick,
}

impl Shared {
    fn threads(&self) -> MutexGuard<'_, Threads> {
        self.threads.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// A judgment past the watchdog on `live`: given up when no other thread is lost, else stalled.
    fn stuck(&self, live: &Arc<Live>) {
        {
            let mut threads = self.threads();
            if !threads.current.as_ref().is_some_and(|current| Arc::ptr_eq(current, live)) {
                return;
            }
            if threads.lost.is_none() {
                threads.lost = Some(live.generation);
                threads.current = None;
                live.answer_waiters(false);
            } else if !live.stalled.swap(true, Ordering::AcqRel) {
                live.answer_waiters(true);
            } else {
                return;
            }
        }
        self.tick.bump();
    }

    /// A job of thread `generation` returned: a stalled thread takes jobs again.
    fn returned(&self, generation: u64) {
        let unstalled = {
            let threads = self.threads();
            threads.current.as_ref().is_some_and(|current| current.generation == generation && current.stalled.swap(false, Ordering::AcqRel))
        };
        if unstalled {
            self.tick.bump();
        }
    }

    /// Thread `generation` panicked: it is given up. The panicking job's waiter then reads the panic,
    /// and the jobs behind it answer "exited" as the thread ends and drops them.
    fn panicked(&self, generation: u64) {
        let left = {
            let mut threads = self.threads();
            if threads.current.as_ref().is_some_and(|current| current.generation == generation) { threads.current.take() } else { None }
        };
        if left.is_some() {
            self.tick.bump();
        }
    }

    /// Thread `generation` ended. When it was the lost one, a thread stalled behind it is given up now.
    fn exited(&self, generation: u64) {
        let promoted = {
            let mut threads = self.threads();
            if threads.lost != Some(generation) {
                return;
            }
            threads.lost = None;
            let stalled = threads.current.as_ref().is_some_and(|current| current.stalled.load(Ordering::Acquire));
            if stalled {
                let live = threads.current.take();
                threads.lost = live.as_ref().map(|live| live.generation);
                live
            } else {
                None
            }
        };
        if let Some(live) = promoted {
            live.answer_waiters(false);
        }
        self.tick.bump();
    }
}

pub(crate) struct JudgeWorker {
    token: JudgeThread,
    alarm: Arc<dyn Alarm>,
    shared: Arc<Shared>,
}

impl JudgeWorker {
    pub(crate) fn new(token: JudgeThread, tick: StateTick, alarm: Arc<dyn Alarm>) -> Self {
        Self { token, alarm, shared: Arc::new(Shared { threads: Mutex::default(), tick }) }
    }

    /// The thread taking jobs, if one runs and is not stalled.
    pub(crate) fn generation(&self) -> Option<u64> {
        let threads = self.shared.threads();
        threads.current.as_ref().filter(|live| !live.stalled.load(Ordering::Acquire)).map(|live| live.generation)
    }

    /// (current, stalled, lost) thread generations, for tests.
    #[cfg(test)]
    pub(crate) fn threads(&self) -> (Option<u64>, bool, Option<u64>) {
        let threads = self.shared.threads();
        let current = threads.current.as_ref();
        (current.map(|live| live.generation), current.is_some_and(|live| live.stalled.load(Ordering::Acquire)), threads.lost)
    }

    /// Runs `job` (a model load) on the thread taking jobs, starting one when none runs. No watchdog:
    /// Node's has none for a load either.
    pub(crate) async fn load<R, F>(&self, job: F) -> Result<R, JudgeError>
    where
        R: Send + 'static,
        F: FnOnce(&mut Seat) -> R + Send + 'static,
    {
        let live = self.taking()?;
        self.send(live, &CancellationToken::new(), false, job).await.map_err(|failure| failure.into_error(true))
    }

    /// Runs `job` (a judgment) on thread `generation` while it still takes jobs, under the watchdog.
    /// A job whose `caller` has fired by the time it comes up is dropped, not run (Node's `abandoned`);
    /// the wait itself ends only with the answer or the thread's loss, as Node sends the next request
    /// only once the worker answered.
    pub(crate) async fn judge<R, F>(&self, generation: u64, caller: &CancellationToken, job: F) -> Result<R, JudgeError>
    where
        R: Send + 'static,
        F: FnOnce(&mut Seat) -> R + Send + 'static,
    {
        let live = self.shared.threads().current.clone().filter(|live| live.generation == generation && !live.stalled.load(Ordering::Acquire));
        let Some(live) = live else { return Err(JudgeError::Worker(EXITED.to_owned())) };
        self.send(live, caller, true, job).await.map_err(|failure| failure.into_error(false))
    }

    /// Queues `job` on the thread taking jobs without waiting for it; nothing when none runs.
    pub(crate) fn post(&self, job: impl FnOnce(&mut Seat) + Send + 'static) {
        let live = self.shared.threads().current.clone();
        if let Some(live) = live {
            let _ = live.push(
                Box::new(move |seat| {
                    job(seat);
                    Ok(())
                }),
                false,
            );
        }
    }

    /// Node's `shutdownEffortJudge`: the thread is let go. Its waiters answer "exited" now; it drops its
    /// model and ends after its running job, and nothing waits for it. Until then it counts as lost.
    pub(crate) fn leave(&self) {
        let left = {
            let mut threads = self.shared.threads();
            let left = threads.current.take();
            if threads.lost.is_none() {
                threads.lost = left.as_ref().map(|live| live.generation);
            }
            left
        };
        if let Some(live) = left {
            live.answer_waiters(false);
            self.shared.tick.bump();
        }
    }

    /// The thread taking jobs, started when none runs; none while the current one stalls.
    fn taking(&self) -> Result<Arc<Live>, JudgeError> {
        let mut threads = self.shared.threads();
        if let Some(live) = &threads.current {
            return if live.stalled.load(Ordering::Acquire) { Err(JudgeError::Worker(EXITED.to_owned())) } else { Ok(live.clone()) };
        }
        threads.generations += 1;
        let live = self.start(threads.generations)?;
        threads.current = Some(live.clone());
        Ok(live)
    }

    fn start(&self, generation: u64) -> Result<Arc<Live>, JudgeError> {
        let (tx, rx) = mpsc::channel::<Job>();
        let counters = Arc::new(Counters::default());
        let (shared, counted) = (Arc::downgrade(&self.shared), counters.clone());
        self.token
            .spawn_thread("mixdog-effort-judge", move |_| run_thread(generation, &rx, &counted, &shared))
            .map_err(|error| JudgeError::Worker(format!("effort judge thread: {error}")))?;
        Ok(Arc::new(Live {
            generation,
            jobs: Mutex::new((tx, 0)),
            counters,
            gone: Mutex::new(CancellationToken::new()),
            stalled: AtomicBool::new(false),
        }))
    }

    async fn send<R, F>(&self, live: Arc<Live>, caller: &CancellationToken, watched: bool, job: F) -> Result<R, Failure>
    where
        R: Send + 'static,
        F: FnOnce(&mut Seat) -> R + Send + 'static,
    {
        let gone = live.gone.lock().unwrap_or_else(PoisonError::into_inner).clone();
        let (tx, rx) = oneshot::channel::<Ran<R>>();
        let skip = caller.clone();
        let job: Job = Box::new(move |seat| {
            if skip.is_cancelled() || tx.is_closed() {
                drop(tx.send(Ran::Skipped));
                return Ok(());
            }
            match std::panic::catch_unwind(AssertUnwindSafe(|| job(seat))) {
                Ok(out) => {
                    drop(tx.send(Ran::Done(out)));
                    Ok(())
                }
                Err(payload) => {
                    let message = panic_message(payload.as_ref());
                    Err(Box::new(move || drop(tx.send(Ran::Panicked(message)))))
                }
            }
        });
        let number = live.push(job, true)?;
        if watched {
            let (watched, shared, counters) = (Arc::downgrade(&live), Arc::downgrade(&self.shared), live.counters.clone());
            self.alarm.after(
                STUCK,
                Box::new(move || {
                    if counters.finished.load(Ordering::Acquire) >= number {
                        return;
                    }
                    if let (Some(live), Some(shared)) = (watched.upgrade(), shared.upgrade()) {
                        shared.stuck(&live);
                    }
                }),
            );
        }
        tokio::select! {
            biased;
            ran = rx => match ran {
                Ok(Ran::Done(out)) => Ok(out),
                Ok(Ran::Panicked(message)) => Err(Failure::Panicked(message)),
                Ok(Ran::Skipped) => Err(Failure::Skipped),
                Err(_) => Err(Failure::Exited),
            },
            () = gone.cancelled() => Err(Failure::Exited),
        }
    }
}

/// The thread's loop. The seat, and the model in it, end here, on this thread.
fn run_thread(generation: u64, jobs: &mpsc::Receiver<Job>, counters: &Counters, shared: &Weak<Shared>) {
    let mut seat = Seat { model: None, generation };
    for job in jobs {
        let ran = std::panic::catch_unwind(AssertUnwindSafe(|| job(&mut seat)));
        counters.finished.fetch_add(1, Ordering::AcqRel);
        counters.pending.fetch_sub(1, Ordering::AcqRel);
        match ran {
            Ok(Ok(())) => {
                if let Some(shared) = shared.upgrade() {
                    shared.returned(generation);
                }
            }
            failed => {
                if let Some(shared) = shared.upgrade() {
                    shared.panicked(generation);
                }
                if let Ok(Err(deliver)) = failed {
                    deliver();
                }
                break;
            }
        }
    }
    drop(seat);
    if let Some(shared) = shared.upgrade() {
        shared.exited(generation);
    }
}
