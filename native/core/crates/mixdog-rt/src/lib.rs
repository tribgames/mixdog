//! Executors, lanes and lane tokens (RL §3, §7.1, §13; SPEC R47).
//!
//! Every async task is spawned through [`spawn`], which instruments its polls. Every job that
//! needs a dedicated thread pool is submitted through a zero-sized lane token
//! ([`tokens::LaneToken`]) and receives an [`InLane`] proof while it runs, so a function that
//! must run on a given lane takes `&InLane<ThatLane>` and calling it anywhere else is a compile
//! error. Dedicated OS threads (management listener, computer sessions, video encoders, SQLite
//! writers) start through a thread token ([`tokens::ThreadToken`]).
//!
//! The executors themselves sit behind [`Backend`]: WP-RT implements it (thread pools, OS
//! priorities, queue caps, histograms) and the composition root calls [`install`] once at boot,
//! which mints the only [`LaneTokens`] of the process. Tokens cannot be constructed elsewhere.

use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;
use std::sync::OnceLock;
use std::task::Context;
use std::task::Poll;
use std::time::Duration;
use std::time::Instant;

pub mod cancel;
pub mod exec;
pub mod gate;
pub mod lanes;
pub mod liveness;
pub mod node_log;
pub mod scoped;
pub mod serial;
pub mod ticker;
pub mod time;
pub mod tokens;
#[cfg(feature = "virtual-clock")]
pub mod virtual_clock;

/// A named core event a replay `wait`s for before it advances past real I/O (the replay clock's log; nothing on stderr).
/// Nothing without the `virtual-clock` feature.
#[inline]
pub fn replay_event(name: &str) {
    #[cfg(feature = "virtual-clock")]
    virtual_clock::logged(name);
    #[cfg(not(feature = "virtual-clock"))]
    let _ = name;
}

pub use cancel::CancelSource;
pub use cancel::CancelView;
pub use gate::Gate;
pub use gate::GateCancelled;
pub use gate::GateGuard;
pub use gate::KeyedGate;
pub use scoped::Scope;
pub use scoped::Scoped;
pub use serial::ChainGuard;
pub use serial::KeyedChains;
pub use serial::SerialChain;
pub use ticker::Ticker;
pub use ticker::TimerHandle;
pub use ticker::ticker;

pub use exec::job_progress;
pub use lanes::JobDropped;
pub use lanes::JobHandle;
pub use lanes::JobRun;
pub use lanes::LaneFull;
pub use lanes::LaneKind;
pub use lanes::LaneWedged;
pub use lanes::QueuedJob;
pub use lanes::SubmitWaitError;
pub use lanes::ThreadKind;
pub use liveness::Expired;
pub use liveness::Liveness;
pub use tokens::ComputerThread;
pub use tokens::ControlThread;
pub use tokens::CpuBulk;
pub use tokens::CpuInteractive;
pub use tokens::DurabilityIo;
pub use tokens::InLane;
pub use tokens::InteractiveIo;
pub use tokens::LaneToken;
pub use tokens::LaneTokens;
pub use tokens::MaintenanceIo;
pub use tokens::MediaThread;
pub use tokens::OnThread;
pub use tokens::PtyIo;
pub use tokens::SpawnIo;
pub use tokens::SqliteWriterThread;
pub use tokens::ThreadToken;
pub use tokio_util::sync::CancellationToken;

/// The two async executors (RL §3).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum TaskClass {
    /// RT-C: listener, connection reader/writer tasks, request decode, routing, directory
    /// lookups, control-cell operations, `ArcSwap` reads, admission counters. Never
    /// filesystem, SQLite, process spawn, encodes above 64 KiB, or an await on another class.
    Control,
    /// RT-W: session actors, runs, provider streams, MCP clients, tool orchestration,
    /// extension dispatcher, channels and scheduler, Postgres client.
    Work,
}

impl TaskClass {
    /// Poll bound checked by the instrumentation (RL §13): a longer poll fails a gate run.
    pub const fn poll_bound(self) -> Duration {
        match self {
            TaskClass::Control => Duration::from_millis(5),
            TaskClass::Work => Duration::from_millis(50),
        }
    }
}

/// The executor implementation (WP-RT). Installed once per process with [`install`].
pub trait Backend: Send + Sync + 'static {
    /// Runtime handle of the async executor for `class`.
    fn handle(&self, class: TaskClass) -> tokio::runtime::Handle;
    /// One poll of an instrumented task finished after `elapsed`.
    fn record_poll(&self, task: &'static str, class: TaskClass, elapsed: Duration);
    /// Enqueues `job` on its lane (`job.lane()`). Never blocks: a full queue answers
    /// [`LaneFull`]. The lane thread calls [`QueuedJob::run`], which drops a cancelled job at
    /// dequeue (RL §7.1).
    fn submit(&self, job: QueuedJob) -> Result<(), LaneFull>;
    /// Called first on every thread started through a [`ThreadToken`]: sets the OS priority
    /// of `kind` and registers the thread with the instrumentation.
    fn enter_thread(&self, kind: ThreadKind);
    /// Notified (`notify_waiters`) every time `lane` frees a queue or thread slot; backs
    /// [`LaneToken::submit_wait`]. `None` (the default) means the backend never refuses a job
    /// for lack of room, or cannot signal it, so `submit_wait` answers [`LaneFull`] at once.
    fn capacity_notify(&self, _lane: LaneKind) -> Option<Arc<tokio::sync::Notify>> {
        None
    }
    /// `true` while `lane` has no healthy worker (every thread is stuck in a job past its
    /// lease). [`LaneToken::submit_wait`] answers [`LaneWedged`] instead of waiting, and the
    /// backend notifies `capacity_notify` when this changes. Default: never wedged.
    fn lane_wedged(&self, _lane: LaneKind) -> bool {
        false
    }
}

static BACKEND: OnceLock<Arc<dyn Backend>> = OnceLock::new();

/// The backend was already installed; tokens are minted exactly once per process.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct AlreadyInstalled;

impl std::fmt::Display for AlreadyInstalled {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("mixdog-rt backend already installed")
    }
}

impl std::error::Error for AlreadyInstalled {}

/// Installs the executors and mints the process's lane and thread tokens. The composition
/// root calls this once at boot and hands each token only to the modules that own that lane.
pub fn install(backend: Arc<dyn Backend>) -> Result<LaneTokens, AlreadyInstalled> {
    let tokens = install_backend(backend)?;
    // The product's backend comes from `exec::boot`; a backend installed here is a test's.
    #[cfg(feature = "test-support")]
    ticker::TEST_BACKEND.store(true, std::sync::atomic::Ordering::SeqCst);
    Ok(tokens)
}

/// [`install`] without marking the backend as a test's: `exec::boot`'s executors.
pub(crate) fn install_backend(backend: Arc<dyn Backend>) -> Result<LaneTokens, AlreadyInstalled> {
    BACKEND.set(backend).map_err(|_| AlreadyInstalled)?;
    Ok(LaneTokens::mint())
}

pub(crate) fn backend() -> &'static dyn Backend {
    match BACKEND.get() {
        Some(backend) => backend.as_ref(),
        None => panic!("mixdog-rt: spawn or submit before install"),
    }
}

/// Spawns `fut` on the executor of `class`, instrumented under `name` (RL §13).
pub fn spawn<F>(name: &'static str, class: TaskClass, fut: F) -> tokio::task::JoinHandle<F::Output>
where
    F: Future + Send + 'static,
    F::Output: Send + 'static,
{
    let spawned = backend().handle(class).spawn(Instrumented {
        name,
        class,
        inner: Box::pin(fut),
    });
    // Row 14 of the replay's clock: the task is queued while its spawner still counts.
    #[cfg(feature = "virtual-clock")]
    virtual_clock::pause::point(|| format!("spawned {name}"));
    spawned
}

struct Instrumented<F> {
    name: &'static str,
    class: TaskClass,
    inner: Pin<Box<F>>,
}

impl<F: Future> Future for Instrumented<F> {
    type Output = F::Output;

    fn poll(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<F::Output> {
        let this = self.get_mut();
        let started = Instant::now();
        let out = this.inner.as_mut().poll(cx);
        // Rows 2 and 3 of the replay's clock: what the poll woke is queued while its runtime is busy.
        #[cfg(feature = "virtual-clock")]
        virtual_clock::pause::point(|| format!("polled {}", this.name));
        backend().record_poll(this.name, this.class, started.elapsed());
        out
    }
}

/// Test executors for packages that develop against mocks.
#[cfg(feature = "test-support")]
pub mod testing {
    use super::*;

    thread_local! {
        static REFUSE: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
    }

    /// While alive, every job submitted from THIS thread to [`InlineBackend`] is refused
    /// (`LaneFull`), as a lane with no healthy worker refuses it; other threads and tests are
    /// unaffected. Use it on a current-thread runtime, where the code under test submits from the
    /// test thread.
    #[must_use]
    pub struct RefuseJobs(());

    /// Starts refusing jobs submitted from this thread, until the guard is dropped.
    pub fn refuse_jobs_on_this_thread() -> RefuseJobs {
        REFUSE.set(true);
        RefuseJobs(())
    }

    impl Drop for RefuseJobs {
        fn drop(&mut self) {
            REFUSE.set(false);
        }
    }

    /// Runs lane jobs inline on the submitting thread (deterministic), spawns tasks on the
    /// ambient tokio runtime, and starts dedicated threads without priorities.
    pub struct InlineBackend;

    impl Backend for InlineBackend {
        fn handle(&self, _class: TaskClass) -> tokio::runtime::Handle {
            // A file watcher's own thread has no ambient runtime; its tasks run on a shared one.
            tokio::runtime::Handle::try_current().unwrap_or_else(|_| {
                static OFF_THREAD: OnceLock<tokio::runtime::Runtime> = OnceLock::new();
                OFF_THREAD
                    .get_or_init(|| {
                        tokio::runtime::Builder::new_multi_thread()
                            .worker_threads(1)
                            .enable_all()
                            .build()
                            .expect("the test runtime for threads without one")
                    })
                    .handle()
                    .clone()
            })
        }

        fn record_poll(&self, _task: &'static str, _class: TaskClass, _elapsed: Duration) {}

        fn submit(&self, job: QueuedJob) -> Result<(), LaneFull> {
            if REFUSE.get() {
                return Err(LaneFull { lane: job.lane() });
            }
            job.run();
            Ok(())
        }

        fn enter_thread(&self, _kind: ThreadKind) {}
    }

    /// The tokens of the test process: the first call passes [`InlineBackend`] to [`install`],
    /// later calls return copies of the tokens it minted. Panics when another backend was
    /// installed first.
    pub fn tokens() -> LaneTokens {
        static TOKENS: OnceLock<LaneTokens> = OnceLock::new();
        *TOKENS.get_or_init(|| {
            install(Arc::new(InlineBackend)).expect("a non-test backend is installed")
        })
    }

    /// The recorded cases of chunk `index` when a replay of `recorded` cases is split into chunks of `per`.
    /// Panics on a chunk that holds no case: a test registered past the recording.
    pub fn chunk_range(recorded: usize, index: usize, per: usize) -> std::ops::Range<usize> {
        let start = index * per;
        assert!(start < recorded, "chunk {index} holds no recorded case ({recorded} recorded, {per} per chunk)");
        start..recorded.min(start + per)
    }

    /// Fails unless the chunks a [`replay_chunks!`](crate::replay_chunks) list registered are exactly the chunks the
    /// recording has: a recorded case no test runs, a test with no case, or a chunk registered twice.
    pub fn assert_chunks_registered(registered: &[usize], recorded: usize, per: usize) {
        let mut registered = registered.to_vec();
        registered.sort_unstable();
        assert_eq!(registered, (0..recorded.div_ceil(per)).collect::<Vec<_>>(), "the registered chunks of {recorded} recorded cases");
    }
}

/// Splits a recorded replay into tests nextest runs in parallel. `replay_chunks!(REGISTERED, #[tokio::test] async run;
/// [name_00 = 0, name_01 = 1])` emits `async fn name_00() { run(0).await }` per entry (without `async`, a plain call)
/// and `REGISTERED`, the chunk indices of the very tests it emitted, for the family's guard
/// ([`testing::assert_chunks_registered`]).
#[cfg(feature = "test-support")]
#[macro_export]
macro_rules! replay_chunks {
    ($registered:ident, #[$attr:meta] async $run:path; [$($test:ident = $chunk:literal),* $(,)?]) => {
        const $registered: &[usize] = &[$($chunk),*];
        $(
            #[$attr]
            async fn $test() {
                $run($chunk).await
            }
        )*
    };
    ($registered:ident, #[$attr:meta] $run:path; [$($test:ident = $chunk:literal),* $(,)?]) => {
        const $registered: &[usize] = &[$($chunk),*];
        $(
            #[$attr]
            fn $test() {
                $run($chunk)
            }
        )*
    };
}
