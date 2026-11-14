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
use mixdog_core_api::domain::tool::ToolErrorCode;
use mixdog_core_api::domain::tool::ToolOutcome;
use mixdog_core_api::domain::tool::ToolOutput;
use mixdog_core_api::domain::tool::ToolPart;
use mixdog_protocol::JsonValue;
use mixdog_protocol::ThreadId;
use serde_json::Value;

use mixdog_rt::CancellationToken;

use crate::orch::util::action_failed;
use crate::orch::util::cancelled;
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
    /// The caller's token fired while the command waited on the desktop.
    Cancelled,
}

/// The typed `host/*` command channel for one thread: the server's outgoing router resolves the
/// thread's host claimant and keeps the JSON-RPC error intact.
#[async_trait]
pub trait HostCommands: Send + Sync {
    /// Ends with `HostCommandError::Cancelled` when `cancel` fires first, abandoning the request.
    async fn browser(&self, thread: &ThreadId, action: &str, input: JsonValue, cancel: &CancellationToken) -> Result<JsonValue, HostCommandError>;
    /// `cwd` is the session's working directory (`options.cwd`), which the pane resolves files against.
    async fn visualize(&self, thread: &ThreadId, cwd: &str, action: &str, input: JsonValue, cancel: &CancellationToken) -> Result<JsonValue, HostCommandError>;
}

/// Where the `browser_timing` row of each `host/browser/command` goes (the run host's agent trace): the arguments of Node's
/// `browserTimingRow(context, bridgeMs, body, status)`. A sender is given one only while the trace writes these rows
/// (`MIXDOG_AGENT_TRACE_TIMING` / `_VERBOSE`); without it nothing is timed or built.
pub type BrowserTimingLog = Arc<dyn Fn(serde_json::Map<String, Value>) + Send + Sync>;

/// The clock of one `host/browser/command` for its `browser_timing` row, as Node's `requestBridge`
/// (`browser-bridge/client.mjs`) traces in its `finally` each request it sent, whatever came back. The core's browser tools,
/// handoff and saved-login commands ([`ChannelHostCommands`]) and the secret fill's requests are timed with it.
pub struct BrowserCommandClock {
    log: BrowserTimingLog,
    started: std::time::Instant,
}

impl BrowserCommandClock {
    /// Starts as the command is sent; `None`, and nothing timed, without a log.
    pub fn start(log: Option<&BrowserTimingLog>) -> Option<Self> {
        log.map(|log| Self { log: Arc::clone(log), started: std::time::Instant::now() })
    }

    /// The command `action` of `thread`, carrying `turn_id` when its input names one, ended with the channel's `answer`:
    /// its row goes to the log, unless no host held the role and nothing was sent.
    pub fn stop(self, thread: &ThreadId, action: &str, turn_id: Option<Value>, answer: Result<&JsonValue, &HostError>) {
        if let Some(args) = browser_timing_args(thread, action, turn_id, self.started.elapsed().as_secs_f64() * 1000.0, answer) {
            (self.log)(args);
        }
    }
}

/// The real [`HostCommands`]: `host/browser/command` and `host/visualize/command` over the
/// host channel to the desktop that declared the matching capability.
pub struct ChannelHostCommands {
    channel: Arc<dyn HostChannel>,
    timing: Option<BrowserTimingLog>,
}

impl ChannelHostCommands {
    pub fn new(channel: Arc<dyn HostChannel>) -> Arc<Self> {
        Arc::new(Self { channel, timing: None })
    }

    /// Also hands each browser command's `browser_timing` row to `timing` ([`BrowserCommandClock`]).
    pub fn with_timing(channel: Arc<dyn HostChannel>, timing: BrowserTimingLog) -> Arc<Self> {
        Arc::new(Self { channel, timing: Some(timing) })
    }

    async fn command(
        &self,
        capability: HostCapability,
        method: Method,
        params: Value,
        cancel: &CancellationToken,
    ) -> Result<JsonValue, HostCommandError> {
        host_answer(self.channel.request_scoped(capability, method, params, cancel).await, cancel)
    }
}

/// The host's answer to a command as the tools read it.
fn host_answer(answer: Result<JsonValue, HostError>, cancel: &CancellationToken) -> Result<JsonValue, HostCommandError> {
    match answer {
        Ok(value) => Ok(value),
        // The channel answers a cancel as `capabilityUnavailable{cancelled}`; the token says which it was.
        Err(HostError::Core(CoreError::CapabilityUnavailable { .. })) if cancel.is_cancelled() => Err(HostCommandError::Cancelled),
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

#[async_trait]
impl HostCommands for ChannelHostCommands {
    async fn browser(&self, thread: &ThreadId, action: &str, input: JsonValue, cancel: &CancellationToken) -> Result<JsonValue, HostCommandError> {
        let turn_id = self.timing.as_ref().and_then(|_| input.get("turn_id").cloned());
        let params = serde_json::json!({ "threadId": thread, "action": action, "input": input });
        let clock = BrowserCommandClock::start(self.timing.as_ref());
        let answer = self.channel.request_scoped(HostCapability::Browser, Method("host/browser/command"), params, cancel).await;
        if let Some(clock) = clock {
            clock.stop(thread, action, turn_id, answer.as_ref());
        }
        host_answer(answer, cancel)
    }

    async fn visualize(&self, thread: &ThreadId, cwd: &str, action: &str, input: JsonValue, cancel: &CancellationToken) -> Result<JsonValue, HostCommandError> {
        let params = serde_json::json!({ "sessionId": thread, "cwd": cwd, "action": action, "input": input });
        self.command(HostCapability::Visualize, Method("host/visualize/command"), params, cancel).await
    }
}

/// `requestBridge`'s `traceBrowserTiming(context, bridgeMs, body, status)` (`browser-bridge/client.mjs`) for one host
/// command: the context names the thread, the action and the turn the command carries; `body` is the bridge's reply as
/// far as the row reads it (`{ok: true, value: {timing}}` from a result, `{ok: false, timing}` from the host's error's
/// `data.timing`). A command that ended with no answer to read (cancelled, or its host closed or replaced after it was
/// sent) has no body and no `status`, as Node's fetch that failed. Every answer the desktop's bridge gives a command, a
/// refusal too, is HTTP 200 (`bridge-server.ts` `reply`), and that is the row's `http_status`. `None` when no host held
/// the role (`capabilityUnavailable{noClaimant}`): nothing was sent, as Node sent nothing without a bridge in discovery.
fn browser_timing_args(
    thread: &ThreadId,
    action: &str,
    turn_id: Option<Value>,
    elapsed_ms: f64,
    answer: Result<&JsonValue, &HostError>,
) -> Option<serde_json::Map<String, Value>> {
    let body = match answer {
        Ok(value) => Some(serde_json::json!({ "ok": true, "value": { "timing": value.get("timing") } })),
        Err(HostError::Rpc { data, .. }) => Some(serde_json::json!({ "ok": false, "timing": data.as_ref().and_then(|data| data.get("timing")) })),
        Err(HostError::Core(CoreError::CapabilityUnavailable { detail, .. })) if &**detail == mixdog_core_api::host::NO_CLAIMANT => return None,
        Err(HostError::Core(_)) => None,
    };
    let mut context = serde_json::Map::new();
    context.insert("sessionId".to_owned(), Value::String(thread.as_str().to_owned()));
    if let Some(turn_id) = turn_id {
        context.insert("turnId".to_owned(), turn_id);
    }
    context.insert("action".to_owned(), Value::String(action.to_owned()));
    let mut args = serde_json::Map::new();
    args.insert("context".to_owned(), Value::Object(context));
    args.insert("bridgeMs".to_owned(), serde_json::json!(elapsed_ms));
    if let Some(body) = body {
        args.insert("body".to_owned(), body);
        args.insert("status".to_owned(), serde_json::json!(200));
    }
    Some(args)
}

/// Model text of a host failure: the host's redacted message led by `Error: ` unless it already is,
/// as the bridge clients answer a refused command (`browser-bridge/client.mjs:537-541`
/// `message.startsWith('Error:') ? message : \`Error: ${message}\``, `visualize-bridge/client.mjs:37`
/// `toolError`); an empty message is the bridge's own wording. Without a host: the fixed
/// unavailable wording.
pub fn command_error(tool_unavailable: &str, error: HostCommandError) -> ToolError {
    match error {
        HostCommandError::Cancelled => cancelled(),
        HostCommandError::NoHost => unavailable("desktopHost", tool_unavailable),
        HostCommandError::Rpc { message, .. } => {
            let message = if mixdog_js::js_trim(&message).is_empty() { "browser bridge request failed".to_owned() } else { message };
            let text = if message.starts_with("Error:") { message.clone() } else { format!("Error: {message}") };
            ToolError::new(ToolErrorCode::Failed { reason: message }, text)
        }
    }
}

/// A command the caller's cancel ended, in Node's words (`browser-bridge/client.mjs` `settleFailure`,
/// `visualize-bridge/client.mjs`): `<tool> command cancelled`, and for a state-changing action
/// (`may_have_run`) that it may already have executed and was not replayed.
pub fn command_cancelled(tool: &str, may_have_run: bool) -> ToolError {
    let tail = if may_have_run { "; the action may have executed and was not replayed" } else { "" };
    ToolError::new(ToolErrorCode::Cancelled, format!("Error: {tool} command cancelled{tail}"))
}

fn bad(message: &str) -> ToolError {
    action_failed("browser", message)
}

/// `browserToolError(message)` (`browser-bridge/client.mjs:277`): the bridge's own refusal of a reply, `Error: ` led.
fn bridge_error(message: &str) -> ToolError {
    ToolError::new(ToolErrorCode::Failed { reason: message.to_owned() }, format!("Error: {message}"))
}

/// A successful `browser` result value as tool output: text (default `OK`), then the image.
pub fn browser_output(value: &Value) -> ToolOutcome {
    let empty = serde_json::Map::new();
    let value = value.as_object().unwrap_or(&empty);
    let text = value.get("text").and_then(Value::as_str).filter(|t| !t.is_empty()).unwrap_or("OK");
    if mixdog_js::utf16_len(text) > MAX_TEXT_CHARS {
        return Err(bridge_error("browser bridge returned oversized text"));
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
                return Err(bridge_error("browser bridge returned an invalid image"));
            };
            parts.push(ToolPart::Image { mime: mime.to_owned(), data: ImageData::Bytes(bytes), width: None, height: None });
        }
    }
    // An attached download (`result.file`): a PDF as a document, an image as an image, a text type as its text under the file name;
    // any other type stays named in the reply text only.
    if let Some(file) = value.get("file").and_then(Value::as_object) {
        let mime = file.get("mimeType").and_then(Value::as_str).unwrap_or_default();
        let name = file.get("name").and_then(Value::as_str).unwrap_or_default();
        let bytes = file.get("data").and_then(Value::as_str).and_then(|data| STANDARD.decode(data).ok());
        let Some(bytes) = bytes else {
            return Err(bridge_error("browser bridge returned an invalid file"));
        };
        let kind = mime.split(';').next().unwrap_or_default().trim().to_ascii_lowercase();
        if kind == "application/pdf" {
            parts.push(ToolPart::Document { mime: kind, data: bytes });
        } else if kind == "image/jpeg" || kind == "image/png" {
            if bytes.len() > MAX_IMAGE_BYTES {
                return Err(bridge_error("browser bridge returned an invalid image"));
            }
            parts.push(ToolPart::Image { mime: kind, data: ImageData::Bytes(bytes), width: None, height: None });
        } else if kind.starts_with("text/") || matches!(kind.as_str(), "application/json" | "application/xml" | "image/svg+xml") {
            parts.push(ToolPart::Text(format!("{name}\n{}", String::from_utf8_lossy(&bytes))));
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
            commands.browser(&thread, "open", json!({}), &CancellationToken::new()).await,
            Err(HostCommandError::NoHost)
        );
        assert_eq!(
            commands.visualize(&thread, "/w", "open", json!({}), &CancellationToken::new()).await,
            Err(HostCommandError::NoHost)
        );
    }

    #[tokio::test]
    async fn a_cancelled_caller_ends_the_command_as_cancelled_not_as_a_missing_host() {
        use mixdog_core_api::mock::MockHostChannel;

        let commands = ChannelHostCommands::new(Arc::new(MockHostChannel::default()));
        let cancel = CancellationToken::new();
        cancel.cancel();
        assert_eq!(commands.browser(&ThreadId::from("t1"), "open", json!({}), &cancel).await, Err(HostCommandError::Cancelled));
        assert_eq!(command_cancelled("browser", false).message_for_model, "Error: browser command cancelled");
        assert_eq!(
            command_cancelled("browser", true).message_for_model,
            "Error: browser command cancelled; the action may have executed and was not replayed"
        );
        assert_eq!(command_cancelled("visualize", false).message_for_model, "Error: visualize command cancelled");
    }

    /// `traceBrowserTiming` of each command `requestBridge` sent (its `finally`): the timing the desktop returned with a
    /// result or in its error's `data`, and the turn the command carries; a cancelled command, and one whose host closed
    /// after it went out, have no reply to read; without a host nothing was sent.
    #[tokio::test]
    async fn each_browser_command_hands_its_timing_to_the_trace() {
        use mixdog_core_api::mock::MockHostChannel;

        /// A host that closed before it answered (`capabilityUnavailable{claimantClosed}`).
        struct Closing;
        #[async_trait]
        impl HostChannel for Closing {
            async fn request(&self, _: HostCapability, _: Method, _: Value) -> Result<Value, HostError> {
                Err(HostError::Core(CoreError::CapabilityUnavailable { capability: "desktopHost".into(), detail: "claimantClosed".into() }))
            }
            fn notify(&self, _: HostCapability, _: Method, _: Value) -> Result<(), CoreError> {
                Ok(())
            }
        }

        let channel = Arc::new(MockHostChannel::default());
        let rows: Arc<std::sync::Mutex<Vec<serde_json::Map<String, Value>>>> = Arc::default();
        let log: BrowserTimingLog = {
            let rows = rows.clone();
            Arc::new(move |args| rows.lock().unwrap().push(args))
        };
        let commands = ChannelHostCommands::with_timing(channel.clone(), log.clone());
        let thread = ThreadId::from("t1");
        let live = CancellationToken::new();
        assert_eq!(commands.browser(&thread, "snapshot", json!({}), &live).await, Err(HostCommandError::NoHost));
        channel.claim(HostCapability::Browser);
        let method = Method("host/browser/command");
        channel.reply(method, json!({ "text": "Clicked", "timing": { "queueMs": 1, "commandMs": 9 } }));
        assert!(commands.browser(&thread, "click", json!({ "ref": "e1" }), &live).await.is_ok());
        channel.fail(method, HOST_COMMAND_FAILED, "Error: gone", Some(json!({ "timing": { "commandMs": 2 } })));
        assert!(commands.browser(&thread, "saved_login_admit", json!({ "turn_id": 7 }), &live).await.is_err());
        let cancelled = CancellationToken::new();
        cancelled.cancel();
        assert_eq!(commands.browser(&thread, "read", json!({}), &cancelled).await, Err(HostCommandError::Cancelled));
        let closing = ChannelHostCommands::with_timing(Arc::new(Closing), log);
        assert_eq!(closing.browser(&thread, "type", json!({ "ref": "e2" }), &live).await, Err(HostCommandError::NoHost));

        let seen: Vec<(Value, Option<Value>)> = rows
            .lock()
            .unwrap()
            .iter()
            .map(|row| {
                assert!(row["bridgeMs"].as_f64().is_some_and(|ms| ms >= 0.0), "{row:?}");
                assert_eq!(row.get("status").cloned(), row.get("body").map(|_| json!(200)), "an answered command is HTTP 200, one without an answer has no status");
                (row["context"].clone(), row.get("body").cloned())
            })
            .collect();
        assert_eq!(
            seen,
            [
                (
                    json!({ "sessionId": "t1", "action": "click" }),
                    Some(json!({ "ok": true, "value": { "timing": { "queueMs": 1, "commandMs": 9 } } })),
                ),
                (
                    json!({ "sessionId": "t1", "turnId": 7, "action": "saved_login_admit" }),
                    Some(json!({ "ok": false, "timing": { "commandMs": 2 } })),
                ),
                (json!({ "sessionId": "t1", "action": "read" }), None),
                (json!({ "sessionId": "t1", "action": "type" }), None),
            ]
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
