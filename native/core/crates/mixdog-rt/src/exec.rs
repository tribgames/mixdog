//! The executors behind [`Backend`] (RL §3, §7.1, §12.2, §13; SPEC R47).
//!
//! | Executor | Threads | Priority |
//! |---|---|---|
//! | RT-C (tokio) | 2 | above normal |
//! | RT-W (tokio) | cores − 2, min 2 | normal |
//! | cpu-interactive | max(2, cores/4), queue 8 | above normal |
//! | cpu-bulk | max(1, cores − 2 − k), queue 64 | below normal |
//! | io-interactive | 4, queue 16 | normal |
//! | io-durability | 4, queue 256 | normal |
//! | io-maintenance | 2, queue 256 | below normal |
//! | io-spawn | 2, queue 64 | normal |
//! | io-pty | one thread per job, 64 live per core | normal |
//! | control / computer / webrtc-media / sqlite-writer | one thread per token spawn | above / normal / below / normal |
//!
//! [`boot`] builds the executors, installs them and returns the process's tokens.

use std::collections::HashMap;
use std::fmt;
use std::io;
use std::sync::Arc;
use std::sync::atomic::AtomicU64;
use std::sync::atomic::Ordering::Relaxed;
use std::time::Duration;
use std::time::Instant;

use tokio::runtime::Builder;
use tokio::runtime::Handle;
use tokio::runtime::Runtime;
use tokio::sync::Notify;

use crate::AlreadyInstalled;
use crate::Backend;
use crate::LaneFull;
use crate::LaneKind;
use crate::LaneTokens;
use crate::QueuedJob;
use crate::TaskClass;
use crate::ThreadKind;

mod hist;
mod pool;
mod priority;
mod tasks;

pub use hist::HistSummary;
pub use pool::LaneSnapshot;
pub use pool::job_progress;
pub use priority::Priority;
pub use tasks::PollViolation;
pub use tasks::TaskSnapshot;

use pool::LaneExec;
use pool::apply_priority;
use tasks::TaskRegistry;

const LANES: [LaneKind; 7] = [
    LaneKind::CpuInteractive,
    LaneKind::CpuBulk,
    LaneKind::InteractiveIo,
    LaneKind::DurabilityIo,
    LaneKind::MaintenanceIo,
    LaneKind::SpawnIo,
    LaneKind::PtyIo,
];

const THREAD_KINDS: [ThreadKind; 4] = [
    ThreadKind::Control,
    ThreadKind::Computer,
    ThreadKind::WebrtcMedia,
    ThreadKind::SqliteWriter,
];

fn lane_index(kind: LaneKind) -> usize {
    match kind {
        LaneKind::CpuInteractive => 0,
        LaneKind::CpuBulk => 1,
        LaneKind::InteractiveIo => 2,
        LaneKind::DurabilityIo => 3,
        LaneKind::MaintenanceIo => 4,
        LaneKind::SpawnIo => 5,
        LaneKind::PtyIo => 6,
    }
}

fn thread_index(kind: ThreadKind) -> usize {
    match kind {
        ThreadKind::Control => 0,
        ThreadKind::Computer => 1,
        ThreadKind::WebrtcMedia => 2,
        ThreadKind::SqliteWriter => 3,
    }
}

/// OS priority of each pooled lane (RL §3).
const fn lane_priority(kind: LaneKind) -> Priority {
    match kind {
        LaneKind::CpuInteractive => Priority::AboveNormal,
        LaneKind::CpuBulk | LaneKind::MaintenanceIo => Priority::BelowNormal,
        LaneKind::InteractiveIo | LaneKind::DurabilityIo | LaneKind::SpawnIo | LaneKind::PtyIo => {
            Priority::Normal
        }
    }
}

/// Longest a job may hold a thread of a pooled lane without reporting [`job_progress`] before
/// the lane's watchdog counts that thread wedged (F1). It is the longest legitimate stretch
/// of one indivisible step, not a job length: loops over items report progress per item, so a
/// long walk never trips it. This is not the service bound `S` of RL §12.2 (a p99 gate over
/// healthy jobs); a wedged thread only costs a replacement thread, and the lane refuses work
/// only when 2x its threads are wedged at once. Derivations (job sites in the Rust tree):
/// - cpu-interactive 5 s: `S` is 40 ms (§12.2); the longest job is a history-page row
///   projection bounded by the page (`mixdog-core-session session/reads.rs:105`).
/// - io-interactive 10 s: `S` is 25 ms; jobs are single file reads and one catalog parse
///   (`run_host/process.rs:186`, `daemon catalog.rs:83`, `ai catalog/rosters.rs:136`); the
///   lease exists to catch a read on a dead network drive.
/// - io-durability 30 s: a write waits for the statefile lock at most 2 s
///   (`mixdog-statefile lock.rs:38,471-497`), then writes and fsyncs one document or one
///   group-commit batch (`session/durability.rs`, at most `batch_bytes`); fsync on stalled
///   storage is the hang this catches. 15x the lock wait. Multi-file jobs report progress.
/// - io-spawn 30 s: one process creation plus job-object setup (`mixdog-spawn manager.rs`
///   `launch_process`), milliseconds; headroom for a first-run virus scan.
/// - cpu-bulk and io-maintenance 10 min: jobs here are loops that report progress (repo
///   walks, blob census per shard); the longest unreported step is one recursive delete of a
///   session scratch or tool-result tree (`session/purge.rs` `remove_all`), assumed at most
///   minutes. Embedding and compaction bodies do not report progress yet (open).
const fn lane_lease(kind: LaneKind) -> Duration {
    match kind {
        LaneKind::CpuInteractive => Duration::from_secs(5),
        LaneKind::InteractiveIo => Duration::from_secs(10),
        LaneKind::DurabilityIo | LaneKind::SpawnIo => Duration::from_secs(30),
        LaneKind::CpuBulk | LaneKind::MaintenanceIo => Duration::from_secs(600),
        // Thread-per-job lane: jobs own their thread for the life of the PTY, no lease.
        LaneKind::PtyIo => Duration::MAX,
    }
}

/// OS priority of each dedicated-thread kind: the management listener answers while the async
/// runtimes stall (above normal); video encoders yield to everything (below normal).
const fn thread_priority(kind: ThreadKind) -> Priority {
    match kind {
        ThreadKind::Control => Priority::AboveNormal,
        ThreadKind::Computer | ThreadKind::SqliteWriter => Priority::Normal,
        ThreadKind::WebrtcMedia => Priority::BelowNormal,
    }
}

const CONTROL_PRIORITY: Priority = Priority::AboveNormal;
const WORK_PRIORITY: Priority = Priority::Normal;

/// Size of one pooled lane.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct PoolParams {
    /// Worker threads, all started at boot.
    pub threads: usize,
    /// Queue capacity: a full queue answers `LaneFull` at once.
    pub queue: usize,
}

/// Executor sizes. [`RtConfig::for_cores`] gives the RL §3 table for a machine.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct RtConfig {
    pub control_threads: usize,
    pub work_threads: usize,
    pub cpu_interactive: PoolParams,
    pub cpu_bulk: PoolParams,
    pub interactive_io: PoolParams,
    pub durability_io: PoolParams,
    pub maintenance_io: PoolParams,
    pub spawn_io: PoolParams,
    /// Concurrent PTY or piped-child reader jobs (`limits.maxProcesses`, DS §6.4).
    pub pty_max_live: usize,
}

impl RtConfig {
    pub fn for_cores(cores: usize) -> Self {
        let cores = cores.max(1);
        let interactive_cpu = (cores / 4).max(2);
        Self {
            control_threads: 2,
            work_threads: cores.saturating_sub(2).max(2),
            cpu_interactive: PoolParams {
                threads: interactive_cpu,
                queue: 8,
            },
            cpu_bulk: PoolParams {
                threads: cores.saturating_sub(2 + interactive_cpu).max(1),
                queue: 64,
            },
            interactive_io: PoolParams {
                threads: 4,
                queue: 16,
            },
            durability_io: PoolParams {
                threads: 4,
                queue: 256,
            },
            maintenance_io: PoolParams {
                threads: 2,
                queue: 256,
            },
            spawn_io: PoolParams {
                threads: 2,
                queue: 64,
            },
            pty_max_live: 64 * cores,
        }
    }

    /// The table for this machine's available parallelism.
    pub fn detect() -> Self {
        Self::for_cores(
            std::thread::available_parallelism()
                .map(usize::from)
                .unwrap_or(1),
        )
    }
}

/// A started executor set. Implements [`Backend`]; install it with [`boot`] or
/// [`crate::install`], and keep the `Arc` to read [`Executors::diagnostics`].
pub struct Executors {
    control: Handle,
    work: Handle,
    control_runtime: Option<Runtime>,
    work_runtime: Option<Runtime>,
    lanes: Vec<LaneExec>,
    tasks: TaskRegistry,
    threads_entered: [AtomicU64; 4],
    priority_failures: Arc<AtomicU64>,
}

impl Executors {
    pub fn start(config: RtConfig) -> io::Result<Self> {
        let priority_failures = Arc::new(AtomicU64::new(0));
        let control_runtime = runtime(
            "mixdog-rt-c",
            config.control_threads,
            CONTROL_PRIORITY,
            &priority_failures,
        )?;
        let work_runtime = runtime(
            "mixdog-rt-w",
            config.work_threads,
            WORK_PRIORITY,
            &priority_failures,
        )?;
        let pooled = |kind: LaneKind, params: PoolParams| {
            LaneExec::pooled(
                kind,
                lane_priority(kind),
                params.threads,
                params.queue,
                lane_lease(kind),
                &priority_failures,
            )
        };
        let lanes = vec![
            pooled(LaneKind::CpuInteractive, config.cpu_interactive)?,
            pooled(LaneKind::CpuBulk, config.cpu_bulk)?,
            pooled(LaneKind::InteractiveIo, config.interactive_io)?,
            pooled(LaneKind::DurabilityIo, config.durability_io)?,
            pooled(LaneKind::MaintenanceIo, config.maintenance_io)?,
            pooled(LaneKind::SpawnIo, config.spawn_io)?,
            LaneExec::per_job(
                LaneKind::PtyIo,
                lane_priority(LaneKind::PtyIo),
                config.pty_max_live,
                &priority_failures,
            )?,
        ];
        debug_assert!(LANES.iter().all(|k| lanes[lane_index(*k)].kind() == *k));
        Ok(Self {
            control: control_runtime.handle().clone(),
            work: work_runtime.handle().clone(),
            control_runtime: Some(control_runtime),
            work_runtime: Some(work_runtime),
            lanes,
            tasks: TaskRegistry::new(),
            threads_entered: std::array::from_fn(|_| AtomicU64::new(0)),
            priority_failures,
        })
    }

    /// Histograms and counters for the diagnostics method (kept in release builds).
    pub fn diagnostics(&self) -> Diagnostics {
        let (_, poll_violations) = self.tasks.violations();
        Diagnostics {
            tasks: self.tasks.snapshot(),
            lanes: self.lanes.iter().map(LaneExec::snapshot).collect(),
            threads_entered: THREAD_KINDS
                .iter()
                .map(|kind| ThreadSnapshot {
                    kind: *kind,
                    entered: self.threads_entered[thread_index(*kind)].load(Relaxed),
                })
                .collect(),
            priority_failures: self.priority_failures.load(Relaxed),
            poll_violations,
        }
    }

    /// One lease pass over every pooled lane at `now`, as each lane's watchdog thread does on
    /// its own tick. Gate runs and tests call it with a future `now` to expire leases without
    /// waiting.
    pub fn sweep_leases(&self, now: Instant) {
        for lane in &self.lanes {
            lane.sweep(now);
        }
    }

    /// The gate check of RL §13: fails when any task polled longer than its class bound (RT-C
    /// 5 ms, RT-W 50 ms) since the executors started. Bench and debug gate runs call this at
    /// the end of a run.
    pub fn check_poll_bounds(&self) -> Result<(), GateFailure> {
        let (violations, total) = self.tasks.violations();
        if total == 0 {
            return Ok(());
        }
        Err(GateFailure { violations, total })
    }
}

impl Drop for Executors {
    fn drop(&mut self) {
        // A runtime must not be dropped from inside an async context; background shutdown
        // is safe from anywhere.
        if let Some(runtime) = self.control_runtime.take() {
            runtime.shutdown_background();
        }
        if let Some(runtime) = self.work_runtime.take() {
            runtime.shutdown_background();
        }
    }
}

impl Backend for Executors {
    fn handle(&self, class: TaskClass) -> Handle {
        match class {
            TaskClass::Control => self.control.clone(),
            TaskClass::Work => self.work.clone(),
        }
    }

    fn record_poll(&self, task: &'static str, class: TaskClass, elapsed: Duration) {
        self.tasks.observe(task, class, elapsed);
    }

    fn submit(&self, job: QueuedJob) -> Result<(), LaneFull> {
        self.lanes[lane_index(job.lane())].submit(job)
    }

    fn enter_thread(&self, kind: ThreadKind) {
        self.threads_entered[thread_index(kind)].fetch_add(1, Relaxed);
        apply_priority(thread_priority(kind), &self.priority_failures);
    }

    fn capacity_notify(&self, lane: LaneKind) -> Option<Arc<Notify>> {
        Some(self.lanes[lane_index(lane)].freed())
    }

    fn lane_wedged(&self, lane: LaneKind) -> bool {
        self.lanes[lane_index(lane)].is_wedged()
    }
}

fn runtime(
    name: &str,
    threads: usize,
    priority: Priority,
    failures: &Arc<AtomicU64>,
) -> io::Result<Runtime> {
    let failures = failures.clone();
    Builder::new_multi_thread()
        .worker_threads(threads)
        .thread_name(name)
        .enable_all()
        .on_thread_start(move || apply_priority(priority, &failures))
        .build()
}

/// Everything the diagnostics method reports about the executors.
#[derive(Clone, Debug)]
pub struct Diagnostics {
    pub tasks: Vec<TaskSnapshot>,
    pub lanes: Vec<LaneSnapshot>,
    pub threads_entered: Vec<ThreadSnapshot>,
    /// Threads whose OS priority could not be applied.
    pub priority_failures: u64,
    /// Polls over their class bound since start.
    pub poll_violations: u64,
}

/// Threads started through a thread token, per kind.
#[derive(Clone, Copy, Debug)]
pub struct ThreadSnapshot {
    pub kind: ThreadKind,
    pub entered: u64,
}

/// A gate run observed polls over their class bound.
#[derive(Clone, Debug)]
pub struct GateFailure {
    /// The first recorded violations (the log is capped).
    pub violations: Vec<PollViolation>,
    pub total: u64,
}

impl fmt::Display for GateFailure {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{} poll(s) over their class bound:", self.total)?;
        let mut by_task: HashMap<(&str, &str), (u64, Duration)> = HashMap::new();
        for v in &self.violations {
            let class = match v.class {
                TaskClass::Control => "RT-C",
                TaskClass::Work => "RT-W",
            };
            let entry = by_task.entry((v.task, class)).or_default();
            entry.0 += 1;
            entry.1 = entry.1.max(v.elapsed);
        }
        let mut rows: Vec<_> = by_task.into_iter().collect();
        rows.sort();
        for ((task, class), (count, worst)) in rows {
            write!(f, " {task} [{class}] x{count} worst {worst:?};")?;
        }
        Ok(())
    }
}

impl std::error::Error for GateFailure {}

/// [`boot`] failed.
#[derive(Debug)]
pub enum BootError {
    /// A runtime or lane thread could not start.
    Start(io::Error),
    AlreadyInstalled(AlreadyInstalled),
}

impl fmt::Display for BootError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            BootError::Start(e) => write!(f, "mixdog-rt executors failed to start: {e}"),
            BootError::AlreadyInstalled(e) => e.fmt(f),
        }
    }
}

impl std::error::Error for BootError {}

/// Starts the executors, installs them as the process backend and returns the process's tokens
/// together with the handle for diagnostics.
pub fn boot(config: RtConfig) -> Result<(Arc<Executors>, LaneTokens), BootError> {
    let executors = Arc::new(Executors::start(config).map_err(BootError::Start)?);
    let tokens = crate::install(executors.clone()).map_err(BootError::AlreadyInstalled)?;
    #[cfg(feature = "test-support")]
    crate::ticker::PRODUCTION_EXECUTORS.store(true, std::sync::atomic::Ordering::SeqCst);
    Ok((executors, tokens))
}
