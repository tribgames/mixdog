//! The cycles' embedding work (`CycleEmbeddings`) over the database's one flusher: the roots a
//! cycle1 run leaves without a vector, one root right after its chunk commits, and the raw rows
//! while rows wait to be chunked.

use std::sync::Arc;

use async_trait::async_trait;
use tokio_util::sync::CancellationToken;

use super::{CycleEmbeddings, DirtyFlush};
use crate::memory::ingest::embed_flush::RawEmbedFlush;

/// [`CycleEmbeddings`] over `MemoryStack::embed_flush()`: the flush is shared with the reindex and
/// session ingest, so a cycle that asks while one runs joins it.
pub struct FlushEmbeddings(pub Arc<RawEmbedFlush>);

#[async_trait]
impl CycleEmbeddings for FlushEmbeddings {
    async fn flush_dirty(&self, cancel: &CancellationToken) -> Result<DirtyFlush, String> {
        let done = self.0.flush_roots(cancel).await.map_err(|e| e.to_string())?;
        Ok(DirtyFlush { attempted: done.attempted, succeeded: done.succeeded, failed: done.failed.len() })
    }

    async fn sync_root(&self, root_id: i64, cancel: &CancellationToken) -> Result<(), String> {
        self.0.sync_root(root_id, cancel).await.map(drop).map_err(|e| e.to_string())
    }

    async fn flush_raw(&self, limit: usize) -> Result<(usize, usize), String> {
        let done = self.0.flush(limit, None).await;
        Ok((done.attempted, done.embedded))
    }
}
