//! The agents' view of the memory runtime (`MemoryRuntime`, `control('memoryControl', [args])`) over the
//! one `RuntimeMemoryControl` the rooms already use: the same `memory` op runner answers `list` and
//! `delete` for the agent memory API (`listAgentMemory`, `deleteAgentMemory`) and for the rooms.

use async_trait::async_trait;
use mixdog_core_rooms::rooms::memory_control::RuntimeMemoryControl;
use serde_json::Value;

use super::home_api::MemoryRuntime;

#[async_trait]
impl MemoryRuntime for RuntimeMemoryControl {
    /// The runner answers with text, failures included (`memoryControl` returns the reply string); a
    /// call that cannot be made at all does not exist here, so this is never an `Err`.
    async fn memory_control(&self, args: Value) -> Result<String, String> {
        Ok(self.call(args).await)
    }
}
