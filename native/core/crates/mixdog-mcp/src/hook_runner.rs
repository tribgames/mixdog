//! The `mcp_tool` hook handler: runs the configured tool on the same connected servers the
//! session uses, under the handler's timeout, and cancels the call when the hook gives up so it
//! never keeps holding an admission slot.

use mixdog_core_api::domain::tool::ToolPart;
use serde_json::Value;
use tokio_util::sync::CancellationToken;

pub use crate::hook_bus::output::HandlerRun;
use crate::hook_bus::output::handler_timeout;
use crate::hook_bus::output::limit_text;
use crate::hooks::HookHandler;
use crate::hub::McpHub;
use crate::naming::PROVIDER_TOOL_NAME_MAX;
use crate::naming::qualified_tool_name;

/// The tool name the handler targets: `tool` as written, or the provider-safe name of
/// `server` + `tool` the server's tool was registered under.
fn target_name(handler: &Value) -> String {
    let text = |key: &str| handler.get(key).and_then(Value::as_str).map(str::trim).unwrap_or_default().to_owned();
    let (server, tool) = (text("server"), text("tool"));
    if !server.is_empty() && !tool.is_empty() && !tool.starts_with("mcp__") {
        qualified_tool_name(&server, &tool, PROVIDER_TOOL_NAME_MAX)
    } else {
        tool
    }
}

/// Runs one `mcp_tool` handler with the hook `payload` as the tool's arguments. `cancel` is the
/// hook run's own cancellation.
pub async fn run_mcp_tool_handler(
    hub: &McpHub,
    handler: &HookHandler,
    payload: Value,
    event: &str,
    cancel: &CancellationToken,
) -> HandlerRun {
    let name = target_name(&handler.raw);
    if name.is_empty() {
        return HandlerRun::failed("mcp_tool handler missing tool name".to_owned(), false);
    }
    let timeout = handler_timeout(&handler.raw, event);
    let Some((server, entry)) = hub.resolve(&name) else {
        let server = name.strip_prefix("mcp__").and_then(|r| r.split("__").next()).unwrap_or_default();
        return HandlerRun::failed(format!("MCP server \"{server}\" not connected"), false);
    };
    // Losing the race to the timeout cancels the call itself, not just the wait for it.
    let call_cancel = cancel.child_token();
    let owner = format!("hook:{name}");
    let call = server.call_tool(&owner, &entry.tool, payload, &call_cancel, None);
    let outcome = tokio::select! {
        () = cancel.cancelled() => {
            call_cancel.cancel();
            return HandlerRun::failed("aborted".to_owned(), false);
        }
        outcome = tokio::time::timeout(timeout, call) => outcome,
    };
    match outcome {
        Err(_) => {
            call_cancel.cancel();
            HandlerRun::failed(format!("mcp_tool hook timed out: {name}"), true)
        }
        Ok(Err(error)) => {
            let message = error.to_string();
            let timed_out = message.to_ascii_lowercase().contains("timed out");
            HandlerRun::failed(message, timed_out)
        }
        Ok(Ok(output)) => {
            let text: Vec<&str> =
                output.parts.iter().filter_map(|p| if let ToolPart::Text(t) = p { Some(t.as_str()) } else { None }).collect();
            HandlerRun { exit_code: 0, stdout: limit_text(text.join("\n")), ..HandlerRun::default() }
        }
    }
}
