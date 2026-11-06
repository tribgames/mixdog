//! The typed host command seam of the `browser`, `browser_devtools` and `visualize` tools and
//! the one mapping from a host answer to tool output. The in-app browser stays in Electron;
//! the core sends `host/browser/command` / `host/visualize/command` over the claimed host
//! connection and renders what comes back exactly as the loopback bridge client did.

use std::sync::Arc;

use async_trait::async_trait;
use base64::Engine;
use mixdog_core_api::CoreError;
use mixdog_core_api::HostCapability;
use mixdog_core_api::HostChannel;
use mixdog_core_api::HostError;
use mixdog_core_api::ids::Method;
use base64::engine::general_purpose::STANDARD;
use mixdog_core_api::domain::tool::ImageData;
use mixdog_core_api::domain::tool::ToolError;
use mixdog_core_api::domain::tool::ToolOutcome;
use mixdog_core_api::domain::tool::ToolOutput;
use mixdog_core_api::domain::tool::ToolPart;
use mixdog_protocol::JsonValue;
use mixdog_protocol::ThreadId;
use serde_json::Value;

use crate::orch::util::action_failed;
use crate::orch::util::unavailable;

/// The JSON-RPC code the host answers a failed command with.
pub const HOST_COMMAND_FAILED: i64 = -32000;
pub const MAX_TEXT_CHARS: usize = 250_000;
const MAX_IMAGE_BYTES: usize = 20 * 1024 * 1024;
pub const BROWSER_UNAVAILABLE: &str = "browser use is unavailable; open the Mixdog desktop app and enable Browser Use";

/// Why a host command produced no result.
#[derive(Clone, PartialEq, Debug)]
pub enum HostCommandError {
    /// No connection holds the host role (`capabilityUnavailable{desktopHost}`).
    NoHost,
    /// The host's JSON-RPC error. `message` is already redacted by the host; `data.timing` is
    /// diagnostics for logs, never model text.
    Rpc {
        code: i64,
        message: String,
        timing: Option<Value>,
    },
}

/// The typed `host/*` command channel for one thread: the server's outgoing router resolves the
/// thread's host claimant and keeps the JSON-RPC error intact.
#[async_trait]
pub trait HostCommands: Send + Sync {
    async fn browser(&self, thread: &ThreadId, action: &str, input: JsonValue) -> Result<JsonValue, HostCommandError>;
    /// `cwd` is the session's working directory (`options.cwd`), which the pane resolves files against.
    async fn visualize(&self, thread: &ThreadId, cwd: &str, action: &str, input: JsonValue) -> Result<JsonValue, HostCommandError>;
}

/// The real [`HostCommands`]: `host/browser/command` and `host/visualize/command` over the
/// host channel to the desktop that declared the matching capability.
pub struct ChannelHostCommands {
    channel: Arc<dyn HostChannel>,
}

impl ChannelHostCommands {
    pub fn new(channel: Arc<dyn HostChannel>) -> Arc<Self> {
        Arc::new(Self { channel })
    }

    async fn command(
        &self,
        capability: HostCapability,
        method: Method,
        params: Value,
    ) -> Result<JsonValue, HostCommandError> {
        match self.channel.request(capability, method, params).await {
            Ok(value) => Ok(value),
            Err(HostError::Rpc { code, message, data }) => Err(HostCommandError::Rpc {
                code,
                message,
                timing: data.and_then(|data| data.get("timing").cloned()),
            }),
            Err(HostError::Core(CoreError::CapabilityUnavailable { .. })) => {
                Err(HostCommandError::NoHost)
            }
            // Any other core failure reads as a failed command with the generic wording.
            Err(HostError::Core(_)) => Err(HostCommandError::Rpc {
                code: HOST_COMMAND_FAILED,
                message: String::new(),
                timing: None,
            }),
        }
    }
}

#[async_trait]
impl HostCommands for ChannelHostCommands {
    async fn browser(&self, thread: &ThreadId, action: &str, input: JsonValue) -> Result<JsonValue, HostCommandError> {
        let params = serde_json::json!({ "threadId": thread, "action": action, "input": input });
        self.command(HostCapability::Browser, Method("host/browser/command"), params).await
    }

    async fn visualize(&self, thread: &ThreadId, cwd: &str, action: &str, input: JsonValue) -> Result<JsonValue, HostCommandError> {
        let params = serde_json::json!({ "sessionId": thread, "cwd": cwd, "action": action, "input": input });
        self.command(HostCapability::Visualize, Method("host/visualize/command"), params).await
    }
}

/// Model text of a host failure: the host's redacted message as it stands (the `Error:` lead-in
/// is the pipeline's marker), or the fixed unavailable wording without a host.
pub fn command_error(tool_unavailable: &str, error: HostCommandError) -> ToolError {
    match error {
        HostCommandError::NoHost => unavailable("desktopHost", tool_unavailable),
        HostCommandError::Rpc { message, .. } => {
            let message = if mixdog_js::js_trim(&message).is_empty() {
                "browser bridge request failed".to_owned()
            } else {
                message.strip_prefix("Error:").map(|m| mixdog_js::js_trim_start(m).to_owned()).unwrap_or(message)
            };
            action_failed("browser", message)
        }
    }
}

fn bad(message: &str) -> ToolError {
    action_failed("browser", message)
}

/// A successful `browser` result value as tool output: text (default `OK`), then the image.
pub fn browser_output(value: &Value) -> ToolOutcome {
    let empty = serde_json::Map::new();
    let value = value.as_object().unwrap_or(&empty);
    let text = value.get("text").and_then(Value::as_str).filter(|t| !t.is_empty()).unwrap_or("OK");
    if mixdog_js::utf16_len(text) > MAX_TEXT_CHARS {
        return Err(bad("browser bridge returned oversized text"));
    }
    let mut parts = vec![ToolPart::Text(text.to_owned())];
    if let Some(image) = value.get("image").and_then(Value::as_object) {
        let mime = image.get("mimeType").and_then(Value::as_str).unwrap_or_default();
        let data = image.get("data").and_then(Value::as_str).unwrap_or_default();
        if !data.is_empty() && !mime.is_empty() {
            let bytes = (mime == "image/jpeg" || mime == "image/png")
                .then(|| STANDARD.decode(data).ok())
                .flatten()
                .filter(|b| b.len() <= MAX_IMAGE_BYTES);
            let Some(bytes) = bytes else {
                return Err(bad("browser bridge returned an invalid image"));
            };
            parts.push(ToolPart::Image { mime: mime.to_owned(), data: ImageData::Bytes(bytes) });
        }
    }
    let output = ToolOutput { parts, ..ToolOutput::default() };
    // An inconclusive outcome is a failure carrying its output, as the bridge flagged it.
    if value.get("outcome").and_then(Value::as_str) == Some("blocked") {
        let mut error = bad(text);
        error.partial = Some(output);
        return Err(error);
    }
    Ok(output)
}

#[cfg(test)]
mod tests {
    use mixdog_core_api::domain::tool::ToolErrorCode;
    use serde_json::json;

    use super::*;

    /// Golden: the failure a model saw from `{ok:false, error, timing}` over HTTP is the same
    /// text from the host's `-32000` error, whose `data.timing` never reaches the model.
    #[test]
    fn host_failure_reads_as_the_bridge_error_did() {
        let golden: Vec<Value> =
            serde_json::from_str(include_str!("golden/host_error.json")).expect("golden");
        for case in golden {
            let rpc = HostCommandError::Rpc {
                code: case["code"].as_i64().unwrap(),
                message: case["message"].as_str().unwrap().to_owned(),
                timing: case["data"].get("timing").cloned(),
            };
            let error = command_error(BROWSER_UNAVAILABLE, rpc);
            assert_eq!(error.message_for_model, case["model_text"].as_str().unwrap(), "{}", case["name"]);
            assert!(error.partial.is_none());
        }
    }

    #[tokio::test]
    async fn commands_ride_the_host_channel_and_map_its_errors() {
        use mixdog_core_api::mock::MockHostChannel;

        let channel = Arc::new(MockHostChannel::default());
        let commands = ChannelHostCommands::new(channel.clone());
        let thread = ThreadId::from("t1");
        assert_eq!(
            commands.browser(&thread, "open", json!({})).await,
            Err(HostCommandError::NoHost)
        );
        assert_eq!(
            commands.visualize(&thread, "/w", "open", json!({})).await,
            Err(HostCommandError::NoHost)
        );
    }

    #[test]
    fn missing_host_is_the_unavailable_wording() {
        let error = command_error(BROWSER_UNAVAILABLE, HostCommandError::NoHost);
        assert_eq!(error.message_for_model, BROWSER_UNAVAILABLE);
        assert!(matches!(error.code, ToolErrorCode::Unavailable { .. }));
    }

    #[test]
    fn success_text_defaults_to_ok_and_blocked_is_a_failure() {
        let out = browser_output(&json!({})).unwrap();
        assert_eq!(out.parts, vec![ToolPart::Text("OK".into())]);
        let err = browser_output(&json!({"text":"held","outcome":"blocked"})).unwrap_err();
        assert_eq!(err.message_for_model, "held");
        assert!(err.partial.is_some());
    }
}
