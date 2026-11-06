//! The compactor of a session, told to the side-question store when it rewrites the transcript (Node
//! `buildFreshContextResult`: `if (result.freshContext) retireCompactionFork(sessionId)`). A pass
//! that was skipped for finding no token reduction adopts nothing and retires nothing; a failed or
//! cancelled one leaves the transcript as it was.

use std::sync::Arc;

use async_trait::async_trait;
use mixdog_agent::env::{CompactError, CompactOutput, CompactRequest, Compactor};
use mixdog_agent::message::AgentMessage;
use mixdog_core_api::ids::ThreadId;

use super::compactors::CompactionWorld;

pub struct RetiringCompactor {
    inner: Arc<dyn Compactor>,
    world: Arc<dyn CompactionWorld>,
    thread: ThreadId,
}

impl RetiringCompactor {
    pub fn new(inner: Arc<dyn Compactor>, world: Arc<dyn CompactionWorld>, thread: ThreadId) -> Self {
        Self { inner, world, thread }
    }
}

#[async_trait]
impl Compactor for RetiringCompactor {
    fn estimate_tokens(&self, messages: &[AgentMessage]) -> u64 {
        self.inner.estimate_tokens(messages)
    }

    async fn reduces(&self, request: &CompactRequest<'_>) -> bool {
        self.inner.reduces(request).await
    }

    async fn compact(&self, request: CompactRequest<'_>) -> Result<CompactOutput, CompactError> {
        let output = self.inner.compact(request).await?;
        if !output.skipped {
            self.world.retire_fork(&self.thread);
        }
        Ok(output)
    }

    fn cache_expired(&self) -> bool {
        self.inner.cache_expired()
    }

    fn request_media(&self, messages: &[AgentMessage]) -> bool {
        self.inner.request_media(messages)
    }
}