//! The judge's own executor, in the shape of Node's judge worker (`judge-worker.mjs`): one dedicated
//! thread at normal priority, started on first use, that loads the model, warms it up and runs every
//! judgment, one job at a time in the order they were sent. Nothing else runs on it, so history-sized
//! CPU work on the shared lanes can neither hold its thread nor fill its queue.
//!
//! The model lives on the thread ([`Seat`]) and never leaves it. A thread stops being the judge's
//! worker in four ways: its judgment outlives Node's watchdog ([`STUCK`]), a job panics, the judge
//! shuts down, or the model files are replaced. Each ends as Node's terminated worker does: the jobs
//! waiting on it answer "exited" at once, its running inference is stopped through the runtime's own
//! termination flag (ONNX Runtime's `RunOptions::terminate`, see [`Resident::stopper`]), and the next
//! job starts a new thread that loads its own model. The thread let go drops its model on itself and
//! ends once its job returns; nothing joins it, so it never holds the process's exit. Until it ends
//! it is counted against [`THREADS`].

use std::panic::AssertUnwindSafe;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc;
use std::sync::{Arc, Mutex, MutexGuard, PoisonError, Weak};
use std::time::Duration;

use mixdog_rt::{JudgeThread, ThreadToken};
use tokio::sync::oneshot;
use tokio_util::sync::CancellationToken;

use crate::effort_judge::error::JudgeError;
use crate::effort_judge::judge::Resident;
use crate::tool_state::StateTick;

/// Node's `STUCK_MS` (`judge-client.mjs:43` at `bb8c5e3b7`, armed as each judgment is sent at `:182`):
/// a judgment its thread has not answered this long after it started ends that thread's work.
pub(crate) const STUCK: Duration = Duration::from_secs(10);

/// Judge threads alive at most, counting the one taking jobs and every one let go whose job has not
/// returned yet.
///
/// Node's terminated worker is gone at once; a thread here ends only when its job returns. A stopped
/// inference returns at once, but work the terminate flag cannot reach (a model load, or a hang
/// outside the session's run) holds its thread, and the model on it, until it returns. While
/// [`THREADS`] such threads are alive no other starts: the load a judgment needs fails at once, so a
/// turn answers `warming` at once (`judge.rs` `ask`, its cold-wait arm) until one returns. Node cannot reach that
/// state, since its watchdog and its shutdown kill the worker whatever it is doing; this is the one
/// remaining difference from Node's judge (`fixtures/tools/effort-judge/NOTES.md`).
pub(crate) const THREADS: usize = 2;

const EXITED: &str = "the effort judge thread exited";

/// Ends the inference a model is running, from any thread.
pub(crate) type Stopper = Arc<dyn Fn() + Send + Sync>;

/// What the judge's thread owns: the model loaded on it.
pub(crate) struct Seat {
    pub(crate) model: Option<Arc<dyn Resident>>,
    /// Which thread this is; a model loaded here is the judge's while this thread takes jobs.
    pub(crate) generation: u64,
}

/// Arms the judge's deadlines: the core ticker in the product, a clock the test advances in tests.
pub(crate) trait Alarm: Send + Sync {
    fn after(&self, delay: Duration, ring: Box<dyn FnOnce() + Send>);

    /// Called by a ringing watchdog before it decides; a test holds it here to let runs end and
    /// start meanwhile.
    fn watchdog_rang(&self) {}
}

/// The core ticker. A ring is never disarmed: one for a wait that already ended does nothing.
pub(crate) struct TickerAlarm;

impl Alarm for TickerAlarm {
    fn after(&self, delay: Duration, ring: Box<dyn FnOnce() + Send>) {
        let _armed = mixdog_rt::ticker().register(std::time::Instant::now() + delay, ring);
    }
}

/// A deadline armed now on `alarm`: the future ends once `delay` has passed.
pub(crate) fn deadline(alarm: &dyn Alarm, delay: Duration) -> impl Future<Output = ()> + Send + 'static {
    let (tx, rx) = oneshot::channel();
    alarm.after(delay, Box::new(move || {
        let _ = tx.send(());
    }));
    async move {
        let _ = rx.await;
    }
}

/// A job as the thread runs it. When it panicked it hands back its answer, which the thread delivers
/// once it has let itself go, so a caller that reads it finds the next job going to a new thread.
struct Job {
    run: Box<dyn FnOnce(&mut Seat) -> Result<(), Deliver> + Send>,
    /// A judgment, under the watchdog; a model load is not (Node's has no watchdog for a load).
    watched: bool,
}

type Deliver = Box<dyn FnOnce() + Send>;

/// How a job ended, as its thread reports it.
enum Ran<R> {
    Done(R),
    Panicked(String),
}

fn panic_message(payload: &(dyn std::any::Any + Send)) -> String {
    payload
        .downcast_ref::<&str>()
        .map(|text| (*text).to_owned())
        .or_else(|| payload.downcast_ref::<String>().cloned())
        .unwrap_or_else(|| "panicked".to_owned())
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

/// One judge thread as the worker holds it. The thread ends once it is let go and its job returned,
/// or once every holder let go of this (the sender with it) while it waits for a job.
struct Live {
    generation: u64,
    jobs: Mutex<mpsc::Sender<Job>>,
    /// Fired when the thread is let go: its waiters answer "exited" without it.
    gone: CancellationToken,
    flight: Arc<Mutex<Flight>>,
}

/// The thread's run in flight. Its lock is the one runs start and end under, so a stop decided
/// under it reaches the run it was decided about and no other.
#[derive(Default)]
struct Flight {
    /// The number of the job running, while one runs.
    running: Option<u64>,
    /// The loaded model's [`Stopper`], set by the thread after each job.
    stop: Option<Stopper>,
}

impl Flight {
    fn stop_running(&self) {
        if self.running.is_some()
            && let Some(stop) = &self.stop
        {
            stop();
        }
    }
}

#[derive(Default)]
struct Threads {
    /// The thread taking jobs.
    current: Option<Arc<Live>>,
    /// Threads let go whose job has not returned.
    retiring: usize,
    generations: u64,
}

struct Shared {
    threads: Mutex<Threads>,
    tick: StateTick,
    alarm: Arc<dyn Alarm>,
}

impl Shared {
    /// Lets thread `generation` (any when `None`) go if it is the one taking jobs; counted until it
    /// ends. `answer` answers its waiters "exited" now (a panicking job answers its own waiter).
    fn retire(&self, generation: Option<u64>, answer: bool) {
        let Some(live) = self.detach(generation) else { return };
        if answer {
            live.gone.cancel();
        }
        lock(&live.flight).stop_running();
        self.tick.bump();
    }

    /// Node's watchdog for job `number` of thread `generation`: when that job is still the one in
    /// flight, the thread is let go and the run stopped, both under the lock runs end and start
    /// under, so a run that ended meanwhile, and the one after it, are left alone.
    fn watchdog(&self, generation: u64, flight: &Mutex<Flight>, number: u64) {
        self.alarm.watchdog_rang();
        let flight = lock(flight);
        if flight.running != Some(number) {
            return;
        }
        let Some(live) = self.detach(Some(generation)) else { return };
        live.gone.cancel();
        flight.stop_running();
        drop(flight);
        self.tick.bump();
    }

    /// Takes thread `generation` (any when `None`) from taking jobs, if it does; counted until it ends.
    fn detach(&self, generation: Option<u64>) -> Option<Arc<Live>> {
        let mut threads = lock(&self.threads);
        if !threads.current.as_ref().is_some_and(|live| generation.is_none_or(|g| g == live.generation)) {
            return None;
        }
        threads.retiring += 1;
        threads.current.take()
    }

    fn is_current(&self, generation: u64) -> bool {
        lock(&self.threads).current.as_ref().is_some_and(|live| live.generation == generation)
    }

    /// A thread let go has ended.
    fn exited(&self) {
        {
            let mut threads = lock(&self.threads);
            threads.retiring = threads.retiring.saturating_sub(1);
        }
        self.tick.bump();
    }
}

pub(crate) struct JudgeWorker {
    token: JudgeThread,
    shared: Arc<Shared>,
    /// Bumped by each [`Self::leave`]: a load answered across one belongs to no worker.
    left: AtomicU64,
}

impl JudgeWorker {
    pub(crate) fn new(token: JudgeThread, tick: StateTick, alarm: Arc<dyn Alarm>) -> Self {
        Self { token, shared: Arc::new(Shared { threads: Mutex::default(), tick, alarm }), left: AtomicU64::new(0) }
    }

    /// The thread taking jobs, if one runs.
    pub(crate) fn generation(&self) -> Option<u64> {
        lock(&self.shared.threads).current.as_ref().map(|live| live.generation)
    }

    /// How many [`Self::leave`] calls there have been.
    pub(crate) fn left(&self) -> u64 {
        self.left.load(Ordering::Acquire)
    }

    /// (thread taking jobs, threads let go that have not ended), for tests.
    #[cfg(test)]
    pub(crate) fn threads(&self) -> (Option<u64>, usize) {
        let threads = lock(&self.shared.threads);
        (threads.current.as_ref().map(|live| live.generation), threads.retiring)
    }

    /// Runs `job` (a model load) on the thread taking jobs, starting one when none runs. Answers the
    /// generation of the thread that ran it.
    pub(crate) async fn load<R, F>(&self, job: F) -> Result<(u64, R), JudgeError>
    where
        R: Send + 'static,
        F: FnOnce(&mut Seat) -> R + Send + 'static,
    {
        let live = self.taking()?;
        let generation = live.generation;
        match self.send(&live, false, job).await {
            Ok(out) => Ok((generation, out)),
            // A panicking load is a load failure, as a throwing `load()` is Node's `load-error`.
            Err(Some(message)) => Err(JudgeError::Load(message)),
            Err(None) => Err(JudgeError::Worker(EXITED.to_owned())),
        }
    }

    /// Runs `job` (a judgment) on thread `generation` while it still takes jobs, under the watchdog.
    pub(crate) async fn judge<R, F>(&self, generation: u64, job: F) -> Result<R, JudgeError>
    where
        R: Send + 'static,
        F: FnOnce(&mut Seat) -> R + Send + 'static,
    {
        let live = lock(&self.shared.threads).current.clone().filter(|live| live.generation == generation);
        let Some(live) = live else { return Err(JudgeError::Worker(EXITED.to_owned())) };
        self.send(&live, true, job).await.map_err(|panicked| match panicked {
            Some(message) => JudgeError::Worker(format!("the effort judge thread panicked: {message}")),
            None => JudgeError::Worker(EXITED.to_owned()),
        })
    }

    /// Node's `shutdownEffortJudge` (`judge-client.mjs:399`): the thread taking jobs is let go.
    pub(crate) fn leave(&self) {
        self.left.fetch_add(1, Ordering::AcqRel);
        self.shared.retire(None, true);
    }

    /// The thread taking jobs, started when none runs and fewer than [`THREADS`] are alive.
    fn taking(&self) -> Result<Arc<Live>, JudgeError> {
        let mut threads = lock(&self.shared.threads);
        if let Some(live) = &threads.current {
            return Ok(live.clone());
        }
        // At the bound the load fails at once; a turn answers it `warming` (see [`THREADS`]).
        if threads.retiring + 1 > THREADS {
            return Err(JudgeError::Worker(EXITED.to_owned()));
        }
        threads.generations += 1;
        let live = self.start(threads.generations)?;
        threads.current = Some(live.clone());
        Ok(live)
    }

    fn start(&self, generation: u64) -> Result<Arc<Live>, JudgeError> {
        let (tx, rx) = mpsc::channel::<Job>();
        let flight = Arc::new(Mutex::new(Flight::default()));
        let (shared, theirs) = (Arc::downgrade(&self.shared), flight.clone());
        self.token
            .spawn_thread("mixdog-effort-judge", move |_| run_thread(generation, &rx, &theirs, &shared))
            .map_err(|error| JudgeError::Worker(format!("effort judge thread: {error}")))?;
        Ok(Arc::new(Live { generation, jobs: Mutex::new(tx), gone: CancellationToken::new(), flight }))
    }

    /// Sends `job` to `live` and waits for its answer: `Err(Some(panic))` when it panicked, `Err(None)`
    /// when the thread was let go (or ended) first.
    async fn send<R, F>(&self, live: &Live, watched: bool, job: F) -> Result<R, Option<String>>
    where
        R: Send + 'static,
        F: FnOnce(&mut Seat) -> R + Send + 'static,
    {
        let (tx, rx) = oneshot::channel::<Ran<R>>();
        let run = Box::new(move |seat: &mut Seat| match std::panic::catch_unwind(AssertUnwindSafe(|| job(seat))) {
            Ok(out) => {
                drop(tx.send(Ran::Done(out)));
                Ok(())
            }
            Err(payload) => {
                let message = panic_message(payload.as_ref());
                Err(Box::new(move || drop(tx.send(Ran::Panicked(message)))) as Deliver)
            }
        });
        if lock(&live.jobs).send(Job { run, watched }).is_err() {
            return Err(None);
        }
        // A thread let go answers "exited" even when its stopped run has already reported back: Node's
        // terminated worker never answers.
        tokio::select! {
            biased;
            () = live.gone.cancelled() => Err(None),
            ran = rx => match ran {
                Ok(Ran::Done(out)) => Ok(out),
                Ok(Ran::Panicked(message)) => Err(Some(message)),
                Err(_) => Err(None),
            },
        }
    }
}

/// The thread's loop. The seat, and the model in it, end here, on this thread.
fn run_thread(generation: u64, jobs: &mpsc::Receiver<Job>, flight: &Arc<Mutex<Flight>>, shared: &Weak<Shared>) {
    let mut seat = Seat { model: None, generation };
    let mut number = 0;
    for job in jobs {
        number += 1;
        lock(flight).running = Some(number);
        if job.watched
            && let Some(owner) = shared.upgrade()
        {
            let (flight, shared) = (flight.clone(), shared.clone());
            owner.alarm.after(
                STUCK,
                Box::new(move || {
                    if let Some(shared) = shared.upgrade() {
                        shared.watchdog(generation, &flight, number);
                    }
                }),
            );
        }
        let ran = std::panic::catch_unwind(AssertUnwindSafe(|| (job.run)(&mut seat)));
        {
            let mut flight = lock(flight);
            flight.running = None;
            flight.stop = seat.model.as_ref().map(|model| model.stopper());
        }
        let Some(owner) = shared.upgrade() else { break };
        match ran {
            Ok(Ok(())) => {}
            failed => {
                owner.retire(Some(generation), false);
                if let Ok(Err(deliver)) = failed {
                    deliver();
                }
                break;
            }
        }
        if !owner.is_current(generation) {
            break;
        }
    }
    drop(seat);
    if let Some(shared) = shared.upgrade() {
        shared.exited();
    }
}
