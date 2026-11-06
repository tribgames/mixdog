//! What the assembly answers about a thread without a turn: the tools a request of it would send.

use mixdog_core_api::domain::provider::ToolDefinition;

use super::*;

impl HostRunParts {
    /// The definitions of the tools a request of `thread` sends on `surface`: the same set the
    /// turn's request carries (`request_parts`), so a caller pricing the request's tool schemas
    /// (`estimateRequestReserveTokens`) reads what the turn would send.
    pub(crate) async fn tool_definitions(&self, thread: &ThreadId, header: &Header, surface: &mixdog_tools::policy::SessionSurface) -> Result<Vec<ToolDefinition>, String> {
        let SessionTools { tools, builtins } = self.services.seams.tools(thread, header, surface).await?;
        Ok(ToolSet::with_builtins(tools, builtins).definitions())
    }
}
