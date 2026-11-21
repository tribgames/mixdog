//! The core hosts only the bridge's lifecycle tools (`activate_channel_bridge`, `reload_config`,
//! `rename_schedule`); any other name a `channel/call` names answers as unknown.

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
