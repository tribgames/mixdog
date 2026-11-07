//! The attachment store as the agent reads it: asynchronously.
//!
//! The protocol's [`Blobs`] is the synchronous reader that runs where file I/O is allowed (a lane
//! job, a migration thread). The agent never holds one: it hands the work that needs stored text
//! to a [`BlobReads`], which runs it where the store can be read and answers when it is done. No
//! caller of the agent waits on a thread for the store.

use std::sync::{Arc, Mutex, PoisonError};

use async_trait::async_trait;
use mixdog_protocol::message_class::user_text::Blobs;

/// The store could not run the work: its lane refused the job or dropped it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct StoreUnavailable;

impl std::fmt::Display for StoreUnavailable {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("the attachment store is unavailable")
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
    result.ok_or(StoreUnavailable)
}
