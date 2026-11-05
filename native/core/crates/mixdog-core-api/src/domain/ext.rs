//! Call API of the office/PDF extension pool (RL §11). The dispatcher keeps
//! a FIFO per session, round-robin across sessions, a per-session in-flight
//! cap of ⌈W/2⌉ and a global pending cap (beyond it: `Overloaded`). Chunks
//! flow under a per-call byte window; consuming a chunk returns its credit.

use mixdog_protocol::JsonValue;
use mixdog_protocol::ThreadId;

use super::common::AbsPath;
use super::common::EventSource;

#[derive(Clone, PartialEq, Eq, Debug)]
pub struct ExtCall {
    /// Fairness key (per-session FIFO, round-robin).
    pub thread: ThreadId,
    pub method: String,
    pub params: JsonValue,
    /// Approved absolute paths the call may touch.
    pub paths: Vec<AbsPath>,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum ExtExit {
    Code(i32),
    Signal(i32),
    /// Ended by "Stop office worker".
    Stopped,
}

#[derive(Clone, PartialEq, Eq, Debug)]
pub enum ExtError {
    /// Global pending cap reached.
    Overloaded,
    Cancelled,
    /// The worker exited while serving the call.
    HostExited {
        exit: ExtExit,
    },
    /// No extension host on this machine (e.g. SSH server without Node).
    Unavailable {
        reason: String,
    },
    Failed {
        code: String,
        message: String,
    },
    UnknownWorker,
}

#[derive(Clone, PartialEq, Eq, Debug)]
pub enum ExtFrame {
    Chunk(Vec<u8>),
    /// Last frame.
    Done(Result<JsonValue, ExtError>),
}

#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug)]
pub struct ExtWorkerId(pub u32);

#[derive(Clone, PartialEq, Eq, Debug)]
pub enum ExtWorkerState {
    Idle,
    /// No timer reclaims a busy slot.
    Busy {
        call: u64,
        since_seq: u64,
    },
}

#[derive(Clone, PartialEq, Eq, Debug)]
pub struct ExtWorkerStatus {
    pub id: ExtWorkerId,
    pub state: ExtWorkerState,
}

pub trait ExtPool: Send + Sync {
    /// Queues the call. Dropping the returned stream sends `cancel`; the
    /// worker's slot stays occupied until it answers or exits.
    fn call(&self, call: ExtCall) -> Result<Box<dyn EventSource<ExtFrame>>, ExtError>;
    fn status(&self) -> Vec<ExtWorkerStatus>;
    /// Terminates the worker's job object; its call ends `HostExited{Stopped}`.
    fn stop_worker(&self, worker: ExtWorkerId) -> Result<(), ExtError>;
}
