//! The real [`NextMainRequest`]: the request a thread's next turn would send (Node `nextMainRequest`),
//! rebuilt by the turn's own assembly ([`HostRunParts::next_request`]) over the thread's live header,
//! tool surface and stored rows.
//!
//! The assembly belongs to the directory that owns the sessions, and the directory's dependencies (this
//! source is among them, through `SideQuestionService`) are built before it: the source is created empty
//! and [`build_directory`](super::boot::build_directory) binds it once, as it binds the seams.

use std::sync::{Arc, OnceLock, Weak};

use async_trait::async_trait;
use mixdog_core_api::ids::ThreadId;
use mixdog_core_session::session::SessionDirectory;

use super::assemble::HostRunParts;
use super::side_question_store::{NextMainRequest, SideMaterial};

#[derive(Default)]
pub struct NextRequestSource {
    bound: OnceLock<(Weak<SessionDirectory>, Arc<HostRunParts>)>,
}

impl NextRequestSource {
    pub fn new() -> Arc<Self> {
        Arc::default()
    }

    /// The directory and the assembly it was bound to, for the other sources that read the same
    /// thread views ([`super::inheritance_fit`]).
    pub(crate) fn bound(&self) -> Option<&(Weak<SessionDirectory>, Arc<HostRunParts>)> {
        self.bound.get()
    }

    /// Bound exactly once, by the composition of the turn path.
    pub(crate) fn bind(&self, directory: Weak<SessionDirectory>, parts: Arc<HostRunParts>) {
        let _ = self.bound.set((directory, parts));
    }
}

#[async_trait]
impl NextMainRequest for NextRequestSource {
    async fn next(&self, thread: &ThreadId) -> Option<SideMaterial> {
        let (directory, parts) = self.bound.get()?;
        let directory = directory.upgrade()?;
        let handle = directory.handle(thread)?;
        let header = handle.live_header().header();
        let surface = handle.surface().borrow().clone();
        let prior = directory.model_context(thread).read().await.ok()?;
        let (provider, request) = parts.next_request(thread, &header, &surface, prior, handle.thread_window()).await?;
        Some(SideMaterial { request, provider })
    }
}