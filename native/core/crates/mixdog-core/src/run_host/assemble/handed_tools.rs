//! A session's tools as an agent that runs its turns outside Mixdog's loop is listed them: the
//! definitions a request of the session would send. A call of one runs in the turn that made it
//! ([`crate::run_host::factory::OutsideTurn::calls`]).

use mixdog_core_api::domain::provider::ToolDefinition;

use super::*;
use crate::run_host::next_request_source::NextRequestSource;

pub struct HandedTools {
    next: Arc<NextRequestSource>,
}

fn closed(thread: &ThreadId) -> String {
    format!("session {} is not running", thread.as_str())
}

impl HandedTools {
    /// `next` is the turn path's own source (bound to the directory and the assembly).
    pub fn new(next: Arc<NextRequestSource>) -> Self {
        Self { next }
    }

    /// The tool definitions a request of `thread` would send now, on its live header and surface. A session whose
    /// provider has no deferred loading of its own is a bridge session: its directly defined tools, `load_tool` and
    /// `call_tool`.
    pub async fn definitions(&self, thread: &ThreadId) -> Result<Vec<ToolDefinition>, String> {
        let (directory, parts) = self.next.bound().ok_or_else(|| closed(thread))?;
        let handle = directory.upgrade().and_then(|directory| directory.handle(thread)).ok_or_else(|| closed(thread))?;
        let header = handle.live_header().header();
        let surface = handle.surface().borrow().clone();
        parts.tool_definitions(thread, &header, &surface).await
    }
}
