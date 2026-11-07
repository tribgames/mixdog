//! The parts of a loaded session's runtime state (`runtime.getState()`) the agent tree reads
//! (`agent-tree.mjs` `agentDescriptor`, `enqueueTurn`; `retention/busy.mjs` `stateBusy`): the
//! acked view's runtime section, its composer queue rows and its items.

use mixdog_core_api::ids::ThreadId;

use super::SessionDirectory;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct RuntimeFacts {
    /// `state.busy`.
    pub busy: bool,
    /// `state.commandBusy`: a compaction runs.
    pub command_busy: bool,
    /// `state.queued.length`: the prompts the composer shows (a queued completion is runtime
    /// input, not one).
    pub queued: usize,
    /// `state.items.length`.
    pub items: usize,
}

impl RuntimeFacts {
    /// `stateBusy(state)`.
    pub fn state_busy(&self) -> bool {
        self.busy || self.command_busy || self.queued > 0
    }
}

impl SessionDirectory {
    /// The loaded session's runtime state as last acked; `None` for a thread this process does
    /// not host.
    pub fn runtime_facts(&self, id: &ThreadId) -> Option<RuntimeFacts> {
        let handle = self.handle(id)?;
        let view = handle.cell.view.load();
        let runtime = view.state.runtime.as_ref();
        Some(RuntimeFacts {
            busy: runtime.is_some_and(|r| r.busy),
            command_busy: runtime.is_some_and(|r| r.command_busy),
            queued: view.state.queued.as_ref().map_or(0, Vec::len),
            items: view.items.len(),
        })
    }
}
