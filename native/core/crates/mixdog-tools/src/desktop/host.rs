//! The typed host command seam of the `browser`, `browser_devtools` and `visualize` tools and
//! the one mapping from a host answer to tool output. The in-app browser stays in Electron;
//! the core sends `host/browser/command` / `host/visualize/command` over the claimed host
//! connection and renders what comes back exactly as the loopback bridge client did.

use std::sync::Arc;

use async_trait::async_trait;
use mixdog_core_api::CoreError;
use mixdog_core_api::HostCapability;
use mixdog_core_api::HostChannel;
use mixdog_core_api::HostError;
use mixdog_browser_engine::reply::reply::ReplyImage;
use mixdog_core_api::ids::Method;
use mixdog_core_api::domain::tool::ToolError;
use mixdog_core_api::domain::tool::ToolErrorCode;
use mixdog_core_api::domain::tool::ToolOutcome;
use mixdog_core_api::domain::tool::ToolOutput;
use mixdog_core_api::domain::tool::ToolPart;
use mixdog_protocol::JsonValue;
use mixdog_protocol::ThreadId;
use serde_json::Value;

use mixdog_rt::CancellationToken;
use mixdog_rt::Scope;
use mixdog_rt::Scoped;

use crate::orch::util::action_failed;
use crate::orch::util::cancelled;
use crate::orch::util::unavailable;

/// The JSON-RPC code the host answers a failed command with.
pub const HOST_COMMAND_FAILED: i64 = -32000;
pub const MAX_TEXT_CHARS: usize = 250_000;
const VISUALIZE_TIMED_OUT: &str = "visualize bridge timed out";
const VISUALIZE_CONNECTION_LOST: &str = "the desktop host connection was lost during the visualize command; it may not have completed";
const BROWSER_CONNECTION_LOST: &str = "browser bridge connection failed after command dispatch; the action may have executed and was not replayed";
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

/// A browser tool reply. A local engine can carry its screenshot separately
/// from the JSON metadata; forwarded commands keep their original wire reply.
pub struct BrowserToolReply {
    pub value: JsonValue,
    pub screenshot: Option<ReplyImage>,
}

impl From<JsonValue> for BrowserToolReply {
    fn from(value: JsonValue) -> Self {
        Self { value, screenshot: None }
    }
}

/// The typed `host/*` command channel for one thread: the server's outgoing router resolves the
/// thread's host claimant and keeps the JSON-RPC error intact.
#[async_trait]
pub trait HostCommands: Send + Sync {
    /// Ends with `HostCommandError::Cancelled` when `cancel` fires first, abandoning the request.
    async fn browser(&self, thread: &ThreadId, action: &str, input: JsonValue, cancel: &CancellationToken) -> Result<JsonValue, HostCommandError>;
    async fn browser_for_tool(&self, thread: &ThreadId, action: &str, input: JsonValue, cancel: &CancellationToken) -> Result<BrowserToolReply, HostCommandError> {
        self.browser(thread, action, input, cancel).await.map(Into::into)
    }
    /// `cwd` is the session's working directory (`options.cwd`), which the pane resolves files against.
    async fn visualize(&self, thread: &ThreadId, cwd: &str, action: &str, input: JsonValue, cancel: &CancellationToken) -> Result<JsonValue, HostCommandError>;
}

/// Where the `browser_timing` row of each `host/browser/command` goes (the run host's agent trace): the arguments of Node's
/// `browserTimingRow(context, bridgeMs, body, status)`. A sender is given one only while the trace writes these rows
/// (`MIXDOG_AGENT_TRACE_TIMING` / `_VERBOSE`); without it nothing is timed or built.
pub type BrowserTimingLog = Arc<dyn Fn(serde_json::Map<String, Value>) + Send + Sync>;

/// The real [`HostCommands`]: `host/browser/command` and `host/visualize/command` over the
/// host channel to the desktop that declared the matching capability.
pub struct ChannelHostCommands {
    channel: Arc<dyn HostChannel>,
    timing: Option<BrowserTimingLog>,
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

/// A command whose host connection closed or lapsed after the request went out ([`mixdog_core_api::host::lost_after_dispatch`]) is a
/// failed command, not a missing desktop; no claimant, an unlisted method and the like never sent it and stay unavailable.
fn visualize_answer(answer: Result<JsonValue, HostError>, cancel: &CancellationToken) -> Result<JsonValue, HostCommandError> {
    match &answer {
        Err(HostError::Core(CoreError::CapabilityUnavailable { detail, .. })) if !cancel.is_cancelled() && mixdog_core_api::host::lost_after_dispatch(detail) => {
            Err(HostCommandError::Rpc { code: HOST_COMMAND_FAILED, message: VISUALIZE_CONNECTION_LOST.to_owned(), timing: None })
        }
        _ => host_answer(answer, cancel),
    }
}

/// `executeBrowserTool`'s failure after a dispatch (`browser-bridge/client.mjs:514-527`): an observation reads as the missing
/// desktop (it can be asked again); a state-changing action that may already have run says so and is not replayed.
pub(super) fn browser_connection_lost(action: &str) -> HostCommandError {
    if super::browser::OBSERVATION_ACTIONS.contains(&action) {
        return HostCommandError::NoHost;
    }
    HostCommandError::Rpc { code: HOST_COMMAND_FAILED, message: BROWSER_CONNECTION_LOST.to_owned(), timing: None }
}

/// A browser command whose host connection closed or lapsed after the request went out; the same rule as [`visualize_answer`].
fn browser_answer(answer: Result<JsonValue, HostError>, cancel: &CancellationToken, action: &str) -> Result<JsonValue, HostCommandError> {
    match &answer {
        Err(HostError::Core(CoreError::CapabilityUnavailable { detail, .. })) if !cancel.is_cancelled() && mixdog_core_api::host::lost_after_dispatch(detail) => {
            Err(browser_connection_lost(action))
        }
        _ => host_answer(answer, cancel),
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

/// [`command_error`] of a `visualize` command: a refusal without a message is `visualize bridge request failed (HTTP N)`
/// (`visualize-bridge/client.mjs`); every answer the desktop gives a command is HTTP 200.
pub fn visualize_command_error(tool_unavailable: &str, error: HostCommandError) -> ToolError {
    match error {
        HostCommandError::Rpc { message, timing, .. } if mixdog_js::js_trim(&message).is_empty() => {
            command_error(tool_unavailable, HostCommandError::Rpc { code: HOST_COMMAND_FAILED, message: "visualize bridge request failed (HTTP 200)".to_owned(), timing })
        }
        error => command_error(tool_unavailable, error),
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
pub(super) fn bridge_error(message: &str) -> ToolError {
    ToolError::new(ToolErrorCode::Failed { reason: message.to_owned() }, format!("Error: {message}"))
}

/// A successful `browser` result value as tool output: text (default `OK`), then the image.
#[allow(clippy::result_large_err, reason = "Keep the canonical structured tool error and existing call contract by value without an extra boxing allocation")]
pub fn browser_output(value: &Value) -> ToolOutcome {
    render_browser_output(value, None)
}

#[allow(clippy::result_large_err, reason = "Keep the canonical structured tool error by value")]
pub(super) fn render_browser_output(value: &Value, screenshot: Option<ReplyImage>) -> ToolOutcome {
    let empty = serde_json::Map::new();
    let value = value.as_object().unwrap_or(&empty);
    let mut text = value.get("text").and_then(Value::as_str).filter(|t| !t.is_empty()).unwrap_or("OK").to_owned();
    if mixdog_js::utf16_len(&text) > MAX_TEXT_CHARS {
        return Err(bridge_error("browser bridge returned oversized text"));
    }
    // The image and the attached download (`result.file`) become the parts their kind is (`browser_media`); a download that stays
    // on disk takes the reply's "Attached" sentence back, so `text` is settled before it leads the parts.
    let mut media = Vec::new();
    if let Some(screenshot) = screenshot {
        media.extend(super::browser_media::screenshot_part(screenshot)?);
    } else if let Some(image) = value.get("image").and_then(Value::as_object) {
        media.extend(super::browser_media::image_part(image)?);
    }
    if let Some(file) = value.get("file").and_then(Value::as_object) {
        super::browser_media::file_parts(file, &mut text, &mut media)?;
    }
    let mut parts = vec![ToolPart::Text(text.clone())];
    parts.extend(media);
    let output = ToolOutput { parts, ..ToolOutput::default() };
    // An inconclusive outcome is a failure carrying its output, as the bridge flagged it.
    if value.get("outcome").and_then(Value::as_str) == Some("blocked") {
        let mut error = bad(&text);
        error.partial = Some(Box::new(output));
        return Err(error);
    }
    Ok(output)
}

#[cfg(test)]
mod tests {
    use mixdog_core_api::domain::tool::ToolErrorCode;
    use serde_json::json;

    use super::*;

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

    /// A host that took the request and never answers; it keeps what it was sent.
    #[derive(Default)]
    struct Silent {
        sent: std::sync::Mutex<Vec<Value>>,
    }

    #[async_trait]
    impl HostChannel for Silent {
        async fn request(&self, _: HostCapability, _: Method, params: Value) -> Result<Value, HostError> {
            self.sent.lock().unwrap().push(params);
            std::future::pending().await
        }
        fn notify(&self, _: HostCapability, _: Method, _: Value) -> Result<(), CoreError> {
            Ok(())
        }
    }

    #[tokio::test(start_paused = true)]
    async fn an_open_sends_its_call_id_beside_the_session_and_no_other_action_does() {
        let silent = Arc::new(Silent::default());
        let commands = ChannelHostCommands::new(silent.clone());
        let thread = ThreadId::from("t1");
        let cancel = CancellationToken::new();
        let _ = commands.visualize(&thread, "/w", "open", json!({"targets": ["a.md"], "callId": "call_9"}), &cancel).await;
        let _ = commands.visualize(&thread, "/w", "close", json!({"callId": "call_9"}), &cancel).await;
        let sent = silent.sent.lock().unwrap().clone();
        assert_eq!(sent[0], json!({"sessionId": "t1", "cwd": "/w", "action": "open", "input": {"targets": ["a.md"]}, "callId": "call_9"}));
        assert!(sent[1].get("callId").is_none());
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
        // A typing command whose host closed after it went out may have run: not the missing desktop (`client.mjs:514-527`).
        assert_eq!(
            closing.browser(&thread, "type", json!({ "ref": "e2" }), &live).await,
            Err(HostCommandError::Rpc { code: HOST_COMMAND_FAILED, message: BROWSER_CONNECTION_LOST.to_owned(), timing: None })
        );

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

    /// A host that closes while a visualize command waits is a lost connection, not "the desktop app must be running".
    #[tokio::test]
    async fn visualize_connection_lost_mid_command_is_not_the_unavailable_wording() {
        struct Closing(&'static str);
        #[async_trait]
        impl HostChannel for Closing {
            async fn request(&self, _: HostCapability, _: Method, _: Value) -> Result<Value, HostError> {
                Err(HostError::Core(CoreError::CapabilityUnavailable { capability: "desktopHost".into(), detail: self.0.into() }))
            }
            fn notify(&self, _: HostCapability, _: Method, _: Value) -> Result<(), CoreError> {
                Ok(())
            }
        }
        let thread = ThreadId::from("t1");
        let live = CancellationToken::new();
        let lost = ChannelHostCommands::new(Arc::new(Closing("claimantClosed"))).visualize(&thread, "/w", "open", json!({}), &live).await.unwrap_err();
        let text = command_error("visualize is unavailable; the Mixdog desktop app must be running", lost).message_for_model;
        assert!(text.starts_with("Error: the desktop host connection was lost"), "{text}");
        let none = ChannelHostCommands::new(Arc::new(Closing("noClaimant"))).visualize(&thread, "/w", "open", json!({}), &live).await;
        assert_eq!(none, Err(HostCommandError::NoHost));
    }

    /// `client.mjs:514-527`: a host lost after a state-changing command went out says it may have run and was not replayed;
    /// an observation (or no host at all) is the unavailable wording.
    #[tokio::test]
    async fn browser_connection_lost_mid_command_says_a_mutation_may_have_run() {
        struct Closing(&'static str);
        #[async_trait]
        impl HostChannel for Closing {
            async fn request(&self, _: HostCapability, _: Method, _: Value) -> Result<Value, HostError> {
                Err(HostError::Core(CoreError::CapabilityUnavailable { capability: "desktopHost".into(), detail: self.0.into() }))
            }
            fn notify(&self, _: HostCapability, _: Method, _: Value) -> Result<(), CoreError> {
                Ok(())
            }
        }
        let thread = ThreadId::from("t1");
        let live = CancellationToken::new();
        let lost = ChannelHostCommands::new(Arc::new(Closing("claimantClosed")));
        let click = lost.browser(&thread, "click", json!({}), &live).await.unwrap_err();
        assert_eq!(
            command_error(BROWSER_UNAVAILABLE, click).message_for_model,
            "Error: browser bridge connection failed after command dispatch; the action may have executed and was not replayed"
        );
        assert_eq!(lost.browser(&thread, "snapshot", json!({}), &live).await, Err(HostCommandError::NoHost));
        // Known to be before any dispatch: no claimant, a method the claimant does not serve.
        for detail in ["noClaimant", "unsupportedMethod", "claimantChanged"] {
            let never_sent = ChannelHostCommands::new(Arc::new(Closing(detail)));
            assert_eq!(never_sent.browser(&thread, "click", json!({}), &live).await, Err(HostCommandError::NoHost), "{detail}");
            assert_eq!(never_sent.visualize(&thread, "/w", "open", json!({}), &live).await, Err(HostCommandError::NoHost), "{detail}");
        }
        // A wait that timed out after the frame went out is a loss too.
        let timed_out = ChannelHostCommands::new(Arc::new(Closing("timedOut")));
        assert!(matches!(timed_out.browser(&thread, "click", json!({}), &live).await, Err(HostCommandError::Rpc { .. })));
    }

    #[test]
    fn a_visualize_refusal_without_a_message_names_the_visualize_bridge() {
        let empty = HostCommandError::Rpc { code: HOST_COMMAND_FAILED, message: String::new(), timing: None };
        assert_eq!(visualize_command_error("x", empty).message_for_model, "Error: visualize bridge request failed (HTTP 200)");
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

    #[tokio::test(start_paused = true)]
    async fn a_visualize_command_that_is_not_answered_times_out_after_30_seconds_and_60_for_export_and_act() {
        use std::time::Duration;

        let silent = Arc::new(Silent::default());
        let commands = ChannelHostCommands::new(silent.clone());
        let thread = ThreadId::from("t1");
        let live = CancellationToken::new();
        for (action, seconds) in [("check", 30), ("export", 60), ("act", 60)] {
            let started = tokio::time::Instant::now();
            let answer = commands.visualize(&thread, "/w", action, json!({}), &live).await;
            assert_eq!(started.elapsed(), Duration::from_secs(seconds), "{action}");
            let error = command_error("unavailable", answer.unwrap_err());
            assert_eq!(error.message_for_model, "Error: visualize bridge timed out", "{action}");
        }
    }


    /// The model reads the host's `-32000` message, led by `Error:` once; its timing never reaches the model and an
    /// empty message reads as a failed bridge request.
    #[test]
    fn a_host_failure_reads_as_its_message_led_by_error_and_carries_no_timing() {
        let timing = Some(json!({ "totalMs": 812, "stages": { "dispatch": 3, "settle": 790 } }));
        for (message, want) in [
            ("browser action \"click\" ref e5 is not in the latest snapshot", "Error: browser action \"click\" ref e5 is not in the latest snapshot"),
            ("Error: navigation timed out", "Error: navigation timed out"),
            ("", "Error: browser bridge request failed"),
        ] {
            let rpc = HostCommandError::Rpc { code: -32000, message: message.to_owned(), timing: timing.clone() };
            let error = command_error(BROWSER_UNAVAILABLE, rpc);
            assert_eq!(error.message_for_model, want);
            assert!(error.partial.is_none());
        }
    }
}


/// How long a `visualize` command may take: 30 s, and 60 s for the export and act actions that render or drive a page.
const VISUALIZE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(30);
const VISUALIZE_LONG_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(60);
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
impl ChannelHostCommands {
    pub fn new(channel: Arc<dyn HostChannel>) -> Arc<Self> {
        Arc::new(Self { channel, timing: None })
    }

    /// Also hands each browser command's `browser_timing` row to `timing` ([`BrowserCommandClock`]).
    pub fn with_timing(channel: Arc<dyn HostChannel>, timing: BrowserTimingLog) -> Arc<Self> {
        Arc::new(Self { channel, timing: Some(timing) })
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
        browser_answer(answer, cancel, action)
    }

    async fn visualize(&self, thread: &ThreadId, cwd: &str, action: &str, mut input: JsonValue, cancel: &CancellationToken) -> Result<JsonValue, HostCommandError> {
        // An open's tool call id (`input.callId`, set by the tool) is a field of the request, beside `sessionId`, not of the input.
        let call_id = if action == "open" { input.as_object_mut().and_then(|input| input.shift_remove("callId")) } else { None };
        let mut params = serde_json::json!({ "sessionId": thread, "cwd": cwd, "action": action, "input": input });
        if let (Some(call_id), Some(params)) = (call_id, params.as_object_mut()) {
            params.insert("callId".to_owned(), call_id);
        }
        let budget = if action == "export" || action == "act" { VISUALIZE_LONG_TIMEOUT } else { VISUALIZE_TIMEOUT };
        let request = self.channel.request(HostCapability::Visualize, Method("host/visualize/command"), params);
        // The command is abandoned when the time is up, as when the caller cancels.
        match Scope::new().cancel(cancel).within(budget).run(request).await {
            Scoped::Done(answer) => visualize_answer(answer, cancel),
            Scoped::DeadlineExceeded => Err(HostCommandError::Rpc { code: HOST_COMMAND_FAILED, message: VISUALIZE_TIMED_OUT.to_owned(), timing: None }),
            Scoped::Cancelled => Err(HostCommandError::Cancelled),
        }
    }
}
