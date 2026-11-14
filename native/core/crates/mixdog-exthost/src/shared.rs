//! Types shared by the dispatcher (`pool`), the worker I/O tasks (`process`) and the stream a
//! caller holds (`stream`).

use std::sync::Arc;
use std::sync::Mutex;
use std::sync::OnceLock;
use std::sync::atomic::AtomicU64;

use bytes::Bytes;
use mixdog_core_api::domain::ext::ExtCall;
use mixdog_core_api::domain::ext::ExtFrame;
use tokio::sync::mpsc::UnboundedSender;
use tokio::sync::oneshot;

use crate::process::Proc;

/// Where the worker's reader delivers one call's frames.
pub(crate) struct CallOut {
    pub(crate) frames: UnboundedSender<ExtFrame>,
    /// Chunk bytes delivered and not yet taken by the consumer. The reader checks it against the
    /// call window; the consumer subtracts what it takes.
    pub(crate) outstanding: Arc<AtomicU64>,
}

/// The consumer's route back to the worker running its call: set when the call is dispatched,
/// used to return window credit.
pub(crate) type CreditRoute = Arc<OnceLock<UnboundedSender<Bytes>>>;

/// The call a worker is running, shared by the dispatcher (which sets it) and the worker's reader
/// (which resolves it). One call at a time, so the lock is never contended.
#[derive(Default)]
pub(crate) struct Slot(Mutex<Option<(u32, Arc<CallOut>)>>);

impl Slot {
    pub(crate) fn set(&self, call: u32, out: Arc<CallOut>) {
        *self.0.lock().unwrap_or_else(|e| e.into_inner()) = Some((call, out));
    }

    pub(crate) fn current(&self, call: u32) -> Option<Arc<CallOut>> {
        match &*self.0.lock().unwrap_or_else(|e| e.into_inner()) {
            Some((id, out)) if *id == call => Some(out.clone()),
            _ => None,
        }
    }

    pub(crate) fn take(&self, call: u32) -> Option<Arc<CallOut>> {
        let mut slot = self.0.lock().unwrap_or_else(|e| e.into_inner());
        match &*slot {
            Some((id, _)) if *id == call => slot.take().map(|(_, out)| out),
            _ => None,
        }
    }

    pub(crate) fn take_any(&self) -> Option<Arc<CallOut>> {
        self.0
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .take()
            .map(|(_, out)| out)
    }
}

/// A call waiting in the dispatcher.
pub(crate) struct Queued {
    pub(crate) call: ExtCall,
    pub(crate) out: Arc<CallOut>,
    pub(crate) route: CreditRoute,
}

/// Everything the dispatcher reacts to.
pub(crate) enum Event {
    Enqueue { id: u32, queued: Queued },
    /// The consumer dropped its stream.
    Dropped(u32),
    Spawned { worker: u32, result: Result<Proc, String> },
    Ready(u32),
    Finished { worker: u32, call: u32, pin: bool },
    Exited(u32),
    Stop(u32),
    /// The grace after a cancel for `call` on `worker` has passed.
    CancelGrace { worker: u32, call: u32 },
    Shutdown(Option<oneshot::Sender<()>>),
    /// The grace the close gave every worker to leave on its `BYE` has passed.
    CloseGrace,
}
