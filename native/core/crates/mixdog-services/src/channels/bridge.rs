//! The tools a `channel/call` can name. The core hosts the bridge's lifecycle tools
//! (`activate_channel_bridge`, `reload_config`, `rename_schedule`); a messaging backend's own
//! tools (reply, react, …) are not part of this runtime and answer as unknown, exactly as the
//! worker's dispatch does for any name it does not own.

use async_trait::async_trait;
use serde_json::Value;

use super::call::{ChannelCallHandler, ChannelClient};
use super::tools::ToolDispatch;

/// `ChannelCallHandler` over the lifecycle tool dispatch.
pub struct BridgeCalls {
    tools: ToolDispatch,
}

impl BridgeCalls {
    pub fn new(tools: ToolDispatch) -> Self {
        Self { tools }
    }
}

#[async_trait]
impl ChannelCallHandler for BridgeCalls {
    async fn call(&self, name: &str, args: &Value, _client: &ChannelClient) -> Result<Value, String> {
        Ok(self.tools.handle_tool_call(name, args).await)
    }
}
