//! Zero-sized capability tokens (RL §13 "lane-typed handles"; SPEC R47).
//!
//! A token is the only way to put work on a lane or start a dedicated thread. Tokens are
//! minted once by [`crate::install`] and handed by the composition root only to the owning
//! modules (session open path, `DurabilityTask`, maintenance jobs, store writers, …).
//!
//! While a job runs it receives an [`InLane`] proof for its lane; a dedicated thread receives
//! an [`OnThread`] proof. Proofs are neither `Send` nor `Sync` and only exist as borrowed
//! closure arguments, so lane-bound functions (`fn read_tail(lane: &InLane<InteractiveIo>, …)`)
//! cannot be called from an async task or from another lane.

use std::marker::PhantomData;

use tokio::sync::oneshot;
use tokio_util::sync::CancellationToken;

use crate::lanes::JobHandle;
use crate::lanes::LaneFull;
use crate::lanes::LaneKind;
use crate::lanes::QueuedJob;
use crate::lanes::ThreadKind;

mod sealed {
    pub trait Sealed {}
}

/// Proof that the current code runs inside a job of lane `L`.
#[derive(Debug)]
pub struct InLane<L> {
    _lane: PhantomData<(L, *const ())>,
}

impl<L> InLane<L> {
    fn new() -> Self {
        Self { _lane: PhantomData }
    }
}

/// Proof that the current code runs on a dedicated thread of kind `T`.
#[derive(Debug)]
pub struct OnThread<T> {
    _thread: PhantomData<(T, *const ())>,
}

impl<T> OnThread<T> {
    fn new() -> Self {
        Self {
            _thread: PhantomData,
        }
    }
}

/// A pooled lane. Implemented only by the tokens of this module.
pub trait LaneToken: sealed::Sealed + Copy + Send + Sync + 'static {
    const KIND: LaneKind;

    /// Enqueues `job`. Never blocks: a full queue answers [`LaneFull`] at once. A job whose
    /// `cancel` token is cancelled before dequeue is dropped and its handle resolves
    /// `Err(JobDropped)`.
    fn submit<R, F>(self, cancel: &CancellationToken, job: F) -> Result<JobHandle<R>, LaneFull>
    where
        F: FnOnce(&InLane<Self>) -> R + Send + 'static,
        R: Send + 'static,
    {
        let (tx, rx) = oneshot::channel();
        let run = Box::new(move || {
            let proof = InLane::<Self>::new();
            let _ = tx.send(job(&proof));
        });
        crate::backend().submit(QueuedJob::new(Self::KIND, cancel.clone(), run))?;
        Ok(JobHandle::new(rx))
    }
}

/// A dedicated-thread executor. Implemented only by the tokens of this module.
pub trait ThreadToken: sealed::Sealed + Copy + Send + Sync + 'static {
    const KIND: ThreadKind;

    /// Starts a named OS thread with the priority of [`Self::KIND`].
    fn spawn_thread<T, F>(self, name: &str, body: F) -> std::io::Result<std::thread::JoinHandle<T>>
    where
        F: FnOnce(&OnThread<Self>) -> T + Send + 'static,
        T: Send + 'static,
    {
        std::thread::Builder::new()
            .name(name.to_owned())
            .spawn(move || {
                crate::backend().enter_thread(Self::KIND);
                body(&OnThread::<Self>::new())
            })
    }
}

macro_rules! lane_token {
    ($(#[$doc:meta])* $name:ident => $kind:ident) => {
        $(#[$doc])*
        #[derive(Clone, Copy, Debug)]
        pub struct $name {
            _private: (),
        }

        impl $name {
            pub(crate) const fn mint() -> Self {
                Self { _private: () }
            }
        }

        impl sealed::Sealed for $name {}

        impl LaneToken for $name {
            const KIND: LaneKind = LaneKind::$kind;
        }
    };
}

macro_rules! thread_token {
    ($(#[$doc:meta])* $name:ident => $kind:ident) => {
        $(#[$doc])*
        #[derive(Clone, Copy, Debug)]
        pub struct $name {
            _private: (),
        }

        impl $name {
            pub(crate) const fn mint() -> Self {
                Self { _private: () }
            }
        }

        impl sealed::Sealed for $name {}

        impl ThreadToken for $name {
            const KIND: ThreadKind = ThreadKind::$kind;
        }
    };
}

lane_token!(
    /// cpu-interactive: bounded encodes and decodes on interactive paths.
    CpuInteractive => CpuInteractive
);
lane_token!(
    /// cpu-bulk: history-sized or unbounded CPU work.
    CpuBulk => CpuBulk
);
lane_token!(
    /// io-interactive: byte-bounded read jobs only (RL §7.2).
    InteractiveIo => InteractiveIo
);
lane_token!(
    /// io-durability: writes and fsync; held by `DurabilityTask` and the settings writer.
    DurabilityIo => DurabilityIo
);
lane_token!(
    /// io-maintenance: scans, inspection, backups, GC.
    MaintenanceIo => MaintenanceIo
);
lane_token!(
    /// io-spawn: process creation.
    SpawnIo => SpawnIo
);
lane_token!(
    /// io-pty: PTY I/O.
    PtyIo => PtyIo
);
thread_token!(
    /// The management listener thread.
    ControlThread => Control
);
thread_token!(
    /// Computer-use session threads.
    ComputerThread => Computer
);
thread_token!(
    /// WebRTC video encoder threads.
    MediaThread => WebrtcMedia
);
thread_token!(
    /// SQLite writer threads (one per database).
    SqliteWriterThread => SqliteWriter
);

/// Every token of the process, minted once by [`crate::install`].
#[derive(Clone, Copy, Debug)]
#[non_exhaustive]
pub struct LaneTokens {
    pub cpu_interactive: CpuInteractive,
    pub cpu_bulk: CpuBulk,
    pub interactive_io: InteractiveIo,
    pub durability_io: DurabilityIo,
    pub maintenance_io: MaintenanceIo,
    pub spawn_io: SpawnIo,
    pub pty_io: PtyIo,
    pub control_thread: ControlThread,
    pub computer_thread: ComputerThread,
    pub media_thread: MediaThread,
    pub sqlite_writer_thread: SqliteWriterThread,
}

impl LaneTokens {
    pub(crate) const fn mint() -> Self {
        Self {
            cpu_interactive: CpuInteractive::mint(),
            cpu_bulk: CpuBulk::mint(),
            interactive_io: InteractiveIo::mint(),
            durability_io: DurabilityIo::mint(),
            maintenance_io: MaintenanceIo::mint(),
            spawn_io: SpawnIo::mint(),
            pty_io: PtyIo::mint(),
            control_thread: ControlThread::mint(),
            computer_thread: ComputerThread::mint(),
            media_thread: MediaThread::mint(),
            sqlite_writer_thread: SqliteWriterThread::mint(),
        }
    }
}
