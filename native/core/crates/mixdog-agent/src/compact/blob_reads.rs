//! The attachment store as the agent reads it: asynchronously.
//!
//! The protocol's [`Blobs`] is the synchronous reader that runs where file I/O is allowed (a lane
//! job, a migration thread). The agent never holds one: it hands the work that needs stored text
//! to a [`BlobReads`], which runs it where the store can be read and answers when it is done. No
//! caller of the agent waits on a thread for the store.

use std::sync::{Arc, Mutex, PoisonError};

use async_trait::async_trait;
use mixdog_core_api::CoreError;
use mixdog_protocol::message_class::user_text::{Blobs, ReadError};
use tokio_util::sync::CancellationToken;

tokio::task_local! {
    static TURN: CancellationToken;
}

/// Runs `work` as the turn whose token is `cancel`: a store or route read it makes waits under that token.
pub async fn within_turn<F: std::future::Future>(cancel: CancellationToken, work: F) -> F::Output {
    TURN.scope(cancel, work).await
}

/// The token of the turn the caller runs in. A task a turn spawns does not inherit it: scope that task with
/// [`within_turn`] where it is spawned. A read made outside any turn waits under a token nothing cancels, and says so.
pub fn turn_cancel() -> CancellationToken {
    TURN.try_with(CancellationToken::clone).unwrap_or_else(|_| {
        tracing::warn!("[lane-read] a store or route read ran outside any turn's scope: it waits under a token nothing cancels");
        CancellationToken::new()
    })
}

/// Why a read submitted to a lane did not run to an answer. None of these says anything about what is stored.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LaneFault {
    /// The turn was cancelled while the read waited for the lane.
    Cancelled,
    /// The lane's pool shut down.
    ShutDown,
    /// The lane has no healthy worker.
    NoHealthyWorker,
    /// The read was admitted but its result never came back.
    ResultLost,
    /// The lane refused the read for another reason.
    Refused,
}

impl LaneFault {
    /// The fault a lane wait ([`mixdog_core_base::support::on_lane_wait`]) reported.
    pub fn of(error: &CoreError) -> Self {
        match error {
            CoreError::Cancelled { .. } => Self::Cancelled,
            CoreError::Internal { incident_id } if incident_id.ends_with("lane-shut-down") => Self::ShutDown,
            CoreError::Internal { incident_id } if incident_id.ends_with("lane-wedged") => Self::NoHealthyWorker,
            CoreError::Internal { incident_id } if incident_id.ends_with("job-dropped") => Self::ResultLost,
            _ => Self::Refused,
        }
    }
}

impl std::fmt::Display for LaneFault {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            Self::Cancelled => "the turn was cancelled while it waited for the lane",
            Self::ShutDown => "the lane was shut down",
            Self::NoHealthyWorker => "the lane has no healthy worker",
            Self::ResultLost => "the lane job ended without an answer",
            Self::Refused => "the lane refused the job",
        })
    }
}

/// The store read never ran to an answer, for the reason it names.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct StoreUnavailable(pub LaneFault);

impl std::fmt::Display for StoreUnavailable {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "the attachment read did not run: {}", self.0)
    }
}

impl std::error::Error for StoreUnavailable {}

/// Work that reads stored attachment text.
pub type StoreWork = Box<dyn FnOnce(&dyn Blobs) + Send>;

#[async_trait]
pub trait BlobReads: Send + Sync {
    /// Runs `work` once, with the store open for reading, and resolves when it has run.
    /// Cancel-safe: dropping the future does not undo work already started.
    async fn read_with(&self, work: StoreWork) -> Result<(), StoreUnavailable>;
}

/// A store that holds nothing and notes whether it was asked: work that never asks is inline work.
struct InlineOnly(std::cell::Cell<bool>);

impl Blobs for InlineOnly {
    fn text_within(&self, _: &str, _: u64) -> Result<Option<String>, ReadError> {
        self.0.set(true);
        Err(ReadError::Other)
    }
}

/// [`with_blobs`] that submits nothing to the store's lane unless `work` reads a stored blob: the work runs first
/// where the caller is, against a store that notes a read, and only a work that asked runs again, for real, on the lane.
/// `work` is pure for that reason.
pub async fn with_blobs_if_read<R, F>(reads: &dyn BlobReads, work: F) -> Result<R, StoreUnavailable>
where
    R: Send + 'static,
    F: Fn(&dyn Blobs) -> R + Send + 'static,
{
    let inline = InlineOnly(std::cell::Cell::new(false));
    let result = work(&inline);
    if !inline.0.get() {
        return Ok(result);
    }
    with_blobs(reads, move |blobs| work(blobs)).await
}

/// [`BlobReads::read_with`] for work that has a result.
pub async fn with_blobs<R, F>(reads: &dyn BlobReads, work: F) -> Result<R, StoreUnavailable>
where
    R: Send + 'static,
    F: FnOnce(&dyn Blobs) -> R + Send + 'static,
{
    let slot = Arc::new(Mutex::new(None));
    let put = Arc::clone(&slot);
    reads
        .read_with(Box::new(move |blobs| {
            *put.lock().unwrap_or_else(PoisonError::into_inner) = Some(work(blobs));
        }))
        .await?;
    let result = slot.lock().unwrap_or_else(PoisonError::into_inner).take();
    result.ok_or(StoreUnavailable(LaneFault::ResultLost))
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Refusing;

    #[async_trait]
    impl BlobReads for Refusing {
        async fn read_with(&self, _: StoreWork) -> Result<(), StoreUnavailable> {
            Err(StoreUnavailable(LaneFault::ShutDown))
        }
    }

    #[tokio::test]
    async fn inline_work_submits_nothing_and_a_stored_read_does() {
        assert_eq!(with_blobs_if_read(&Refusing, |_| 7).await, Ok(7));
        let read = with_blobs_if_read(&Refusing, |blobs| blobs.text_within(&"a".repeat(64), 1).is_ok()).await;
        assert_eq!(read, Err(StoreUnavailable(LaneFault::ShutDown)));
    }
}

#[cfg(test)]
mod fault_tests {
    use super::*;

    #[test]
    fn each_lane_error_maps_to_its_own_fault_and_message() {
        let internal = |id: &str| CoreError::Internal { incident_id: id.into() };
        let cases = [
            (CoreError::Cancelled { by: "caller".into() }, LaneFault::Cancelled),
            (internal("io-interactive-lane-shut-down"), LaneFault::ShutDown),
            (internal("io-interactive-lane-wedged"), LaneFault::NoHealthyWorker),
            (internal("io-interactive-job-dropped"), LaneFault::ResultLost),
            (internal("something-else"), LaneFault::Refused),
        ];
        let mut texts = std::collections::HashSet::new();
        for (error, fault) in cases {
            assert_eq!(LaneFault::of(&error), fault);
            let text = StoreUnavailable(fault).to_string();
            assert!(!text.contains("store is unavailable"), "{text}");
            assert!(texts.insert(text), "each fault reads differently");
        }
    }
}
