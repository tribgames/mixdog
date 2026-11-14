//! The dual-path `computer` backend: every command goes to the desktop's own computer host as one `host/computer/command`
//! request, the way Node's `computer-bridge/client.mjs` posted it to the loopback bridge, and the reply is shaped the way that
//! client shaped it (`result-canonical.mjs`, `error-recovery.mjs`, `pending-continuation.mjs`). It serves a desktop that still runs
//! the legacy Windows PowerShell host (`desktop.computerBackend = "desktopHost"`); the helper backend is the default.
//!
//! The host admits, queues, gates and runs the command (observation only, the foreground lane, the user's control of the desktop),
//! so none of that is repeated here. What the client did stays here: the tool contract (`validate`, `host_command`), the request
//! bound, the session id, the recovery of a refusal, the continuation of work the person paused, and the abort of the session when
//! the call is cancelled.

use std::sync::Arc;
use std::sync::atomic::AtomicBool;
use std::sync::atomic::Ordering;
use std::time::Duration;

use async_trait::async_trait;
use mixdog_core_api::CoreError;
use mixdog_core_api::HostCapability;
use mixdog_core_api::HostChannel;
use mixdog_core_api::HostError;
use mixdog_core_api::ids::Method;
use mixdog_core_api::domain::computer::ComputerBackend;
use mixdog_core_api::domain::computer::ComputerError;
use mixdog_core_api::domain::computer::ComputerRequest;
use mixdog_core_api::domain::computer::ComputerStatus;
use mixdog_core_api::domain::computer::DesktopIdentity;
use mixdog_core_api::domain::computer::DisplayId;
use mixdog_core_api::domain::computer::DisplayInfo;
use mixdog_core_api::domain::computer::InputOutcome;
use mixdog_core_api::domain::computer::ScreenInput;
use mixdog_core_api::domain::media::MediaFrameSource;
use mixdog_core_api::domain::tool::ImageData;
use mixdog_core_api::domain::tool::ToolPart;
use mixdog_js::js_trim;
use mixdog_js::to_number;
use mixdog_js::utf16_len;
use mixdog_js::value_to_string;
use crate::state::secrets::ComputerSecretHost;
use serde_json::Map;
use serde_json::Value;
use serde_json::json;
use tokio_util::sync::CancellationToken;

use super::computer_backend::HOST_READ_ACTIONS;
use super::computer_backend::ObserveOnly;
use super::computer_backend::REPORTED_CODE;
use super::computer_command::host_command;
use super::computer_command::text;
use super::computer_command::validate;
use super::computer_policy;
use super::computer_recovery::lead_code;
use super::computer_recovery::tool_error_recovery;
use super::computer_screen::Screen;

/// What the section reports as the backend serving the tool.
pub const BACKEND_NAME: &str = "desktopHost";

const METHOD: &str = "host/computer/command";
/// A host that does not know `host/computer/command` (JSON-RPC "method not found"): the desktop is not running the legacy host.
const METHOD_NOT_FOUND: i64 = -32601;
/// `REQUEST_TIMEOUT_MS`, `SESSION_ABORT_TIMEOUT_MS` of the client.
const REQUEST_TIMEOUT: Duration = Duration::from_millis(150_000);
const SESSION_ABORT_TIMEOUT: Duration = Duration::from_millis(15_000);
const MAX_REQUEST_BYTES: usize = 256 * 1024;
const MAX_TEXT_CHARS: usize = 1_000_000;
const MAX_IMAGE_CHARS: usize = 24 * 1024 * 1024;
/// `BRIDGE_UNAVAILABLE_MESSAGE` of the client.
const BRIDGE_UNAVAILABLE_MESSAGE: &str = "computer use is unavailable; open the Mixdog desktop app and enable Computer Use in settings";
/// The host commands `computerActionHas(name, 'replaySafe')` names: a call that ends without a reply may be asked again.
const REPLAY_SAFE: [&str; 11] =
    ["list_windows", "clipboard_read", "wait", "list_apps", "list_installed_apps", "list_history", "capture", "zoom", "verify", "diagnose", "wait_for_user"];
/// `COMPUTER_OBSERVATION_ACTIONS`: the tool actions that only read.
const OBSERVATION_ACTIONS: [&str; 5] = ["list", "diagnose", "capture", "verify", "wait_for_user"];
/// The refusals that happen before any input is dispatched and end in "capture the exact window again".
const RECAPTURE_CODES: [&str; 2] = ["stale_target", "stale_frame"];

/// The stored image bytes of a digest the host named in its reply (`imageBlob`), supplied by the core's blob store.
#[async_trait]
pub trait ComputerBlobs: Send + Sync {
    async fn read(&self, digest: &str) -> Result<Vec<u8>, ComputerError>;
}

/// One reply of the host, validated.
struct HostReply {
    text: String,
    image: Option<(String, Vec<u8>)>,
    is_error: bool,
}

/// What the host answered to one command.
enum Posted {
    Reply(HostReply),
    /// `{ ok: false, error }`: the host refused or failed the command; the text is its own.
    Refused(String),
}

fn reported(message: impl Into<String>) -> ComputerError {
    ComputerError::Failed { code: REPORTED_CODE.into(), message: message.into() }
}

/// What Node's client answers when no desktop publishes the bridge: an error result of its own, with no recovery.
fn bridge_unavailable() -> ComputerError {
    reported(format!("Error: {BRIDGE_UNAVAILABLE_MESSAGE}"))
}

fn host_error(message: &str) -> ComputerError {
    let code = lead_code(message);
    ComputerError::Failed { code: if code.is_empty() { "computer_failed".into() } else { code }, message: message.to_owned() }
}

/// `computerUncertainMutationResult`.
fn uncertain_mutation() -> ComputerError {
    reported("Error: computer command may have executed and was not replayed; inspect fresh state before retrying")
}

/// `computerMutationMayHaveExecuted`: a command that is not replay safe and does not say it only reads.
fn may_have_executed(command: &Map<String, Value>) -> bool {
    !REPLAY_SAFE.contains(&text(command, "action")) && command.get("read_only") != Some(&Value::Bool(true))
}

/// The tool contract's forwarding backend: no helper process of its own, one request per command to the desktop that serves the
/// computer host.
pub struct DesktopHostBackend {
    desktop: Arc<dyn HostChannel>,
    blobs: Arc<dyn ComputerBlobs>,
    session_id: String,
    observe_only: ObserveOnly,
    /// A command has been sent for this session.
    bound: AtomicBool,
    /// A typed secret's field may hold focus: no read leaves the host until the next action moves on.
    secret_focus: AtomicBool,
    /// The in-process half (phone input, displays, screen frames): the desktop host does not serve it.
    screen: Screen,
}

impl DesktopHostBackend {
    pub fn new(desktop: Arc<dyn HostChannel>, blobs: Arc<dyn ComputerBlobs>, session_id: impl Into<String>, observe_only: ObserveOnly) -> Self {
        Self { desktop, blobs, session_id: session_id.into(), observe_only, bound: AtomicBool::new(false), secret_focus: AtomicBool::new(false), screen: Screen::default() }
    }

    /// `applySecretFocusHold`: while a typed secret's field may hold focus a read is refused, and the next action (which moves on)
    /// lifts the hold; a lifecycle control leaves it as it is.
    fn hold_for_secret(&self, command: &Map<String, Value>) -> Result<(), ComputerError> {
        if !self.secret_focus.load(Ordering::SeqCst) {
            return Ok(());
        }
        let action = text(command, "action");
        if HOST_READ_ACTIONS.contains(&action) {
            return Err(reported("capture_withheld: a secret field may be focused; move focus (Tab or a click elsewhere) first"));
        }
        if !matches!(action, "execution_end" | "session_release" | "session_abort" | "turn_settle") {
            self.secret_focus.store(false, Ordering::SeqCst);
        }
        Ok(())
    }

    /// The backend the section reports.
    pub fn backend_name(&self) -> &'static str {
        BACKEND_NAME
    }

    /// One session-level command of the host (`session_abort`, `execution_end`, `session_release`, `turn_settle`): whether the host
    /// confirmed it (`sendComputerSessionControl`). Nothing is sent without a desktop serving the host or a session.
    pub async fn session_control(&self, action: &str, extra: Map<String, Value>, timeout: Duration) -> bool {
        let id = js_trim(&self.session_id);
        if id.is_empty() || !self.desktop.serves(HostCapability::Computer) {
            return false;
        }
        let mut command = Map::new();
        command.insert("action".into(), json!(action));
        command.insert("session_id".into(), json!(id));
        command.extend(extra);
        matches!(self.post(command, &CancellationToken::new(), timeout).await, Ok(Posted::Reply(_)))
    }

    /// One `host/computer/command` request and the host's answer, with the failures worded as the client worded them.
    /// `ComputerError::Cancelled` here only says the caller's token fired; the caller decides what that means.
    async fn post(&self, command: Map<String, Value>, cancel: &CancellationToken, timeout: Duration) -> Result<Posted, ComputerError> {
        let uncertain = may_have_executed(&command);
        let params = json!({ "sessionThreadId": self.session_id, "command": command });
        let timed_out = || if uncertain { uncertain_mutation() } else { reported("Error: computer bridge timed out") };
        let asked = tokio::time::timeout(timeout, self.desktop.request_scoped(HostCapability::Computer, Method(METHOD), params, cancel)).await;
        let Ok(answer) = asked else { return Err(timed_out()) };
        match answer {
            Ok(body) => self.read_body(&body, uncertain).await,
            Err(_) if cancel.is_cancelled() => Err(ComputerError::Cancelled),
            Err(HostError::Rpc { code: METHOD_NOT_FOUND, .. }) => Err(bridge_unavailable()),
            Err(HostError::Rpc { message, .. }) => Ok(Posted::Refused(message)),
            // The channel's own deadline for the computer capability is the client's request timeout.
            Err(HostError::Core(CoreError::CapabilityUnavailable { detail, .. })) if &*detail == "timedOut" => Err(timed_out()),
            Err(HostError::Core(_)) => Err(if uncertain { uncertain_mutation() } else { bridge_unavailable() }),
        }
    }

    /// The host's result object: its refusal, or its reply (`readComputerBridgeBody`, `validateComputerReply`).
    async fn read_body(&self, body: &Value, uncertain: bool) -> Result<Posted, ComputerError> {
        let Some(body) = body.as_object() else {
            return Err(reported(if uncertain {
                "Error: computer command may have executed but the bridge returned an invalid response; inspect fresh state before retrying"
            } else {
                "Error: computer bridge returned an invalid response"
            }));
        };
        if body.get("ok") != Some(&Value::Bool(true)) {
            let message = match body.get("error") {
                Some(Value::String(error)) if !error.is_empty() => error.clone(),
                _ => "computer bridge request failed".to_owned(),
            };
            return Ok(Posted::Refused(message));
        }
        let invalid = |what: &str| reported(format!("Error: computer bridge returned {what}; input may have executed and was not replayed"));
        let Some(Value::String(reply_text)) = body.get("text") else { return Err(invalid("invalid or oversized text")) };
        if utf16_len(reply_text) > MAX_TEXT_CHARS {
            return Err(invalid("invalid or oversized text"));
        }
        let image = match body.get("imageBlob") {
            None | Some(Value::Null) => None,
            Some(blob) => Some(self.read_image(blob).await.ok_or_else(|| invalid("an invalid or oversized image"))?),
        };
        Ok(Posted::Reply(HostReply {
            // `String(value.text || 'OK')`.
            text: if reply_text.is_empty() { "OK".into() } else { reply_text.clone() },
            image,
            is_error: body.get("isError") == Some(&Value::Bool(true)),
        }))
    }

    /// An `imageBlob` `{ digest, byteLength, mimeType }`: the stored bytes when they are the size and type it says, bounded as
    /// the client bounded a base64 image.
    async fn read_image(&self, blob: &Value) -> Option<(String, Vec<u8>)> {
        let mime = blob.get("mimeType")?.as_str().filter(|mime| matches!(*mime, "image/png" | "image/jpeg"))?;
        let digest = blob.get("digest")?.as_str().filter(|digest| !digest.is_empty())?;
        let length = usize::try_from(blob.get("byteLength")?.as_u64()?).ok()?;
        if length.div_ceil(3) * 4 > MAX_IMAGE_CHARS {
            return None;
        }
        let bytes = self.blobs.read(digest).await.ok()?;
        (bytes.len() == length).then(|| (mime.to_owned(), bytes))
    }

    /// `cancelledComputerResult`: the session is aborted on the host, and the call ends with what is known about its input.
    async fn aborted(&self, command: &Map<String, Value>) -> ComputerError {
        let confirmed = self.session_control("session_abort", Map::new(), SESSION_ABORT_TIMEOUT).await;
        let cleanup = if confirmed { "input state and session resources were released" } else { "host cleanup could not be confirmed" };
        let partial = if may_have_executed(command) { "; input may have partially executed; inspect fresh state before retrying" } else { "" };
        reported(format!("Error: computer command aborted; {cleanup}{partial}"))
    }

    /// A refusal of the host: for a stale target the exact window is captured again and returned with it (`refusalWithRecapture`),
    /// any other is the host's text with its code.
    async fn refused(&self, message: String, request: &ComputerRequest, cancel: &CancellationToken) -> ComputerError {
        let action = request.action.wire_name();
        let window = request.input.get("window_id").filter(|id| truthy(id)).map(value_to_string);
        if let Some(window) = window
            && !OBSERVATION_ACTIONS.contains(&action)
            && RECAPTURE_CODES.contains(&lead_code(&message).as_str())
        {
            let capture = ComputerRequest { action: mixdog_core_api::domain::computer::ComputerAction::Capture, input: json!({ "window_id": window.clone() }) };
            if let Ok(parts) = self.run(capture, cancel.clone()).await {
                let mut out = format!(
                    "Error: {message}\nRecovery: no input was sent; window {window} was captured again below. Act only on its fresh refs, OCR marks, or frame_id."
                );
                for part in parts {
                    if let ToolPart::Text(text) = part {
                        out.push('\n');
                        out.push_str(&text);
                    }
                }
                return reported(out);
            }
        }
        host_error(&message)
    }

    /// A read-only command of a pending wait (`pendingWorkReader`); `Err` is a connection that is lost or a reply that is refused.
    async fn read_only(&self, mut command: Map<String, Value>, cancel: &CancellationToken) -> Result<HostReply, ()> {
        if !js_trim(&self.session_id).is_empty() {
            command.insert("session_id".into(), json!(self.session_id));
        }
        let capture = text(&command, "action") == "capture";
        match self.post(command, cancel, REQUEST_TIMEOUT).await {
            Ok(Posted::Reply(reply)) => Ok(reply),
            // The capture of a session the person still holds: the work is still pending.
            Ok(Posted::Refused(message)) if capture && is_user_control_active(&message) => Ok(HostReply {
                text: json!({ "ok": false, "status": "paused", "code": PENDING_CODE }).to_string(),
                image: None,
                is_error: false,
            }),
            _ => Err(()),
        }
    }

    /// `continuePendingComputerWork`: the call stays pending while the person has the desktop; only read-only waits and captures are
    /// sent, and the original command is never sent again.
    async fn settle_pending(&self, initial: HostReply, command: &Map<String, Value>, cancel: &CancellationToken) -> Result<HostReply, ComputerError> {
        let interrupted = || async {
            self.session_control("session_abort", Map::new(), SESSION_ABORT_TIMEOUT).await;
            reported("Error: pending computer work was interrupted; no input was replayed. Inspect fresh state before continuing.")
        };
        let progress = payload(&initial.text);
        let finish = |text: Value| HostReply { text: text.to_string(), image: None, is_error: false };
        loop {
            if cancel.is_cancelled() {
                return Err(interrupted().await);
            }
            let waited = match self.read_only(command_of(&[("action", json!("wait_for_user")), ("timeout_ms", json!(60_000))]), cancel).await {
                Ok(reply) => payload(&reply.text),
                Err(()) if cancel.is_cancelled() => return Err(interrupted().await),
                Err(()) => return Ok(finish(read_failed(&progress))),
            };
            if cancel.is_cancelled() {
                return Err(interrupted().await);
            }
            let status = waited.get("status").and_then(Value::as_str);
            if status == Some("timeout") && waited.get("reason").and_then(Value::as_str) == Some("user_pause") {
                continue;
            }
            if status != Some("resumed") || waited.get("resumed") != Some(&Value::Bool(true)) {
                let reason = waited.get("reason").filter(|reason| truthy(reason)).cloned().unwrap_or(json!("resume_unconfirmed"));
                return Ok(finish(Value::Object(merged(
                    &progress,
                    [
                        ("ok", json!(false)),
                        ("status", json!(if status == Some("cancelled") { "cancelled" } else { "paused" })),
                        ("reason", reason),
                        ("input_replayed", json!(false)),
                        ("recovery", json!({ "next": "wait_for_user", "guidance": "Work has not completed. Resume was not confirmed; no input was replayed." })),
                    ],
                ))));
            }
            let completed = progress.get("total_steps").is_some_and(Value::is_number)
                && progress.get("completed_steps") == progress.get("total_steps")
                && progress.get("pending_work").and_then(|work| work.get("uncertain_step")).is_none();
            let mut resumed = progress.clone();
            resumed.shift_remove("code");
            resumed.shift_remove("error");
            let resumed = merged(&resumed, [("status", json!("resumed")), ("reason", json!("")), ("completed", json!(completed))]);
            let Some(target) = capture_target(command) else {
                return Ok(finish(Value::Object(merged(
                    &resumed,
                    [
                        ("fresh_capture_required", json!(true)),
                        ("verdict", json!({ "decision": "escalate", "recommended": "recapture" })),
                        (
                            "recovery",
                            json!({
                                "next": "capture",
                                "guidance": "User control ended. Capture the intended target, then continue remaining intent without replaying completed or uncertain input."
                            }),
                        ),
                    ],
                ))));
            };
            let mut read = command_of(&[("action", json!("capture"))]);
            read.extend(target);
            let captured = match self.read_only(read, cancel).await {
                Ok(reply) => reply,
                Err(()) if cancel.is_cancelled() => return Err(interrupted().await),
                Err(()) => return Ok(finish(read_failed(&progress))),
            };
            if is_pending(&captured.text) {
                continue;
            }
            let observation = payload(&captured.text);
            let fresh = observation.get("ok") == Some(&Value::Bool(true));
            let (decision, recommended, next, guidance) = if fresh {
                (
                    "verify_fresh_state",
                    "continue_pending_work",
                    "continue_pending_work",
                    "Continue the remaining intent from this fresh observation. Completed or uncertain input must not be replayed blindly.",
                )
            } else {
                (
                    "escalate",
                    "recapture",
                    "capture",
                    "User control ended, but fresh observation is unavailable. Capture the target before continuing; never replay completed or uncertain input blindly.",
                )
            };
            let body = merged(
                &resumed,
                [
                    ("ok", json!(fresh)),
                    ("observation", Value::Object(observation)),
                    ("input_replayed", json!(false)),
                    ("fresh_capture_required", json!(!fresh)),
                    ("verdict", json!({ "decision": decision, "recommended": recommended })),
                    ("recovery", json!({ "next": next, "guidance": guidance })),
                ],
            );
            return Ok(HostReply { text: Value::Object(body).to_string(), ..captured });
        }
    }
}

/// `result.code` of a reply that says the person's intervention has paused the work.
const PENDING_CODE: &str = "computer_user_intervention_pending";

/// `payload(value)`: the object a reply's text carries, empty when it carries none.
fn payload(text: &str) -> Map<String, Value> {
    match serde_json::from_str::<Value>(text) {
        Ok(Value::Object(object)) => object,
        _ => Map::new(),
    }
}

/// `isPendingComputerWork`.
fn is_pending(text: &str) -> bool {
    let result = payload(text);
    result.get("status").and_then(Value::as_str) == Some("paused") && result.get("code").and_then(Value::as_str) == Some(PENDING_CODE)
}

/// `/^computer_user_control_active(?::|$)/`.
fn is_user_control_active(message: &str) -> bool {
    message.strip_prefix("computer_user_control_active").is_some_and(|rest| rest.is_empty() || rest.starts_with(':'))
}

/// `pendingCaptureTarget`: the exact window the original command named.
fn capture_target(command: &Map<String, Value>) -> Option<Map<String, Value>> {
    ["window_id", "app", "window"]
        .into_iter()
        .find(|key| command.get(*key).is_some_and(truthy))
        .map(|key| command_of(&[(key, command[key].clone())]))
}

fn command_of(fields: &[(&str, Value)]) -> Map<String, Value> {
    fields.iter().map(|(key, value)| ((*key).to_owned(), value.clone())).collect()
}

/// `{ ...base, ...fields }`: an existing key keeps its place.
fn merged<const N: usize>(base: &Map<String, Value>, fields: [(&str, Value); N]) -> Map<String, Value> {
    let mut out = base.clone();
    for (key, value) in fields {
        out.insert(key.to_owned(), value);
    }
    out
}

/// The reply of a continuation whose read failed.
fn read_failed(progress: &Map<String, Value>) -> Value {
    Value::Object(merged(
        progress,
        [
            ("ok", json!(false)),
            ("status", json!("paused")),
            ("code", json!("computer_pending_read_failed")),
            ("input_replayed", json!(false)),
            ("fresh_capture_required", json!(true)),
            (
                "recovery",
                json!({
                    "next": "wait_for_user",
                    "guidance": "Read-only continuation failed. Pending work is retained. Restore connection/control, then capture fresh state; never replay completed or uncertain input."
                }),
            ),
        ],
    ))
}

/// JavaScript truthiness of a parsed JSON value.
fn truthy(value: &Value) -> bool {
    match value {
        Value::Null | Value::Bool(false) => false,
        Value::Number(number) => number.as_f64().is_some_and(|n| n != 0.0 && !n.is_nan()),
        Value::String(text) => !text.is_empty(),
        _ => true,
    }
}

// ---- The reply as the model reads it (`result-canonical.mjs`) ----

/// `canonicalComputerResultText`: the reply text with the call's own action and mode, the act steps in the tool's names, the host's
/// diagnostics left out, elements and OCR text one line each and a recovery for a failure that names a code.
fn canonical_text(reply: &str, action: &str, input: &Value) -> String {
    let operation = input.get("operation");
    if action == "clipboard" && input.get("operation").and_then(Value::as_str) == Some("read") {
        return reply.to_owned();
    }
    let Ok(Value::Object(mut value)) = serde_json::from_str::<Value>(reply) else { return reply.to_owned() };
    if !value.get("action").is_some_and(Value::is_string) {
        return reply.to_owned();
    }
    value.insert("action".into(), json!(action));
    let set = |value: &mut Map<String, Value>, key: &str, found: Option<Value>| match found {
        Some(found) => {
            value.insert(key.into(), found);
        }
        None => {
            value.shift_remove(key);
        }
    };
    match action {
        "list" => set(&mut value, "kind", input.get("kind").cloned()),
        "capture" => {
            let mode = input.get("mode").filter(|mode| truthy(mode)).cloned().unwrap_or(json!("state"));
            value.insert("mode".into(), mode);
        }
        "window" | "clipboard" => set(&mut value, "operation", operation.cloned()),
        _ => {}
    }
    if action == "act" {
        canonicalize_act(&mut value, input);
    }
    if value.get("capture_after").is_some_and(truthy) && !value.contains_key("observation") {
        let after = value.shift_remove("capture_after").unwrap_or(Value::Null);
        value.insert("observation".into(), after);
    }
    let mut value = Value::Object(value);
    drop_host_diagnostics(&mut value);
    if let Value::Object(fields) = &mut value {
        render_observation_lines(fields);
        if let Some(Value::Object(observation)) = fields.get_mut("observation") {
            render_observation_lines(observation);
        }
        if fields.get("ok") == Some(&Value::Bool(false))
            && !fields.contains_key("recovery")
            && let Some(found) = result_recovery(fields, action, input)
        {
            fields.insert("recovery".into(), json!({ "code": found.0, "next": found.1, "guidance": found.2 }));
        }
    }
    value.to_string()
}

fn canonicalize_act(value: &mut Map<String, Value>, input: &Value) {
    const STATUSES: [&str; 5] = ["succeeded", "failed", "skipped", "pending", "uncertain"];
    for (to, from) in [("completed_actions", "completed_steps"), ("total_actions", "total_steps")] {
        match value.get(from).cloned() {
            Some(found) => {
                value.insert(to.into(), found);
            }
            None => {
                value.shift_remove(to);
            }
        }
    }
    let steps = value.get("steps").cloned();
    let step = |index: usize, row: &Value| {
        let mut normalized = row.as_object().cloned().unwrap_or_default();
        let named = input.get("actions").and_then(|actions| actions.get(index)).and_then(|row| row.get("type")).filter(|kind| truthy(kind));
        // `type || action`: the step's own action, whatever it is, when the call named none.
        match named.or_else(|| normalized.get("action")).cloned() {
            Some(kind) => {
                normalized.insert("type".into(), kind);
            }
            None => {
                normalized.shift_remove("type");
            }
        }
        if !normalized.get("status").and_then(Value::as_str).is_some_and(|status| STATUSES.contains(&status)) {
            let status = if normalized.get("ok") == Some(&Value::Bool(false)) { "failed" } else { "succeeded" };
            normalized.insert("status".into(), json!(status));
        }
        normalized.shift_remove("action");
        normalized.shift_remove("ok");
        Value::Object(normalized)
    };
    let actions = match &steps {
        Some(Value::Array(rows)) => Some(Value::Array(rows.iter().enumerate().map(|(index, row)| step(index, row)).collect())),
        other => other.clone(),
    };
    match actions {
        Some(actions) => {
            value.insert("actions".into(), actions);
        }
        None => {
            value.shift_remove("actions");
        }
    }
    // A single-window act reports the same transition on the act and its step.
    if let Some(transition) = value.get("window_transition").map(Value::to_string)
        && let Some(Value::Array(rows)) = value.get_mut("actions")
    {
        for row in rows.iter_mut().filter_map(Value::as_object_mut) {
            if row.get("window_transition").map(Value::to_string).as_deref() == Some(transition.as_str()) {
                row.shift_remove("window_transition");
            }
        }
    }
    for key in ["completed_steps", "total_steps", "steps"] {
        value.shift_remove(key);
    }
}

/// Host diagnostics stay in the host's run record; the model acts on none of them.
fn drop_host_diagnostics(value: &mut Value) {
    match value {
        Value::Array(items) => items.iter_mut().for_each(drop_host_diagnostics),
        Value::Object(fields) => {
            for field in ["timings_ms", "capture_attempts"] {
                fields.shift_remove(field);
            }
            fields.values_mut().for_each(drop_host_diagnostics);
        }
        _ => {}
    }
}

const DERIVED_GEOMETRY_FIELDS: [&str; 8] = ["x", "y", "width", "height", "center_x", "center_y", "center", "screen_bounds"];

fn quoted_text(value: &str) -> String {
    serde_json::to_string(value).unwrap_or_default()
}

/// `bareText`: a token without whitespace or quotes stays bare.
fn bare_text(value: &str) -> String {
    if !value.is_empty() && !value.chars().any(|c| c.is_whitespace() || c == '\u{feff}' || c == '"') { value.to_owned() } else { quoted_text(value) }
}

fn is_unset(field: Option<&Value>) -> bool {
    match field {
        None | Some(Value::Null) | Some(Value::Bool(false)) => true,
        Some(Value::String(text)) => text.is_empty(),
        Some(Value::Array(items)) => items.is_empty(),
        _ => false,
    }
}

/// `boundsText`: `@x,y,width,height` for four finite numbers.
fn bounds_text(edges: &[Option<&Value>]) -> Option<String> {
    let numbers: Vec<String> = edges.iter().map(|edge| edge.filter(|edge| edge.is_number()).map(value_to_string)).collect::<Option<_>>()?;
    (numbers.len() == 4).then(|| format!("@{}", numbers.join(",")))
}

fn extra_field_texts(rest: &Map<String, Value>) -> Vec<String> {
    rest.iter()
        .filter(|(key, field)| !DERIVED_GEOMETRY_FIELDS.contains(&key.as_str()) && !is_unset(Some(field)))
        .map(|(key, field)| match field {
            Value::String(text) => format!("{key}={}", bare_text(text)),
            other => format!("{key}={other}"),
        })
        .collect()
}

fn element_line(element: &Value) -> Value {
    let Value::Object(fields) = element else { return element.clone() };
    const NAMED: [&str; 11] = ["mark", "ref", "role", "name", "value", "state", "source", "enabled", "has_keyboard_focus", "bounds", "actions"];
    let field = |key: &str| fields.get(key);
    let rest: Map<String, Value> = fields.iter().filter(|(key, _)| !NAMED.contains(&key.as_str())).map(|(key, value)| (key.clone(), value.clone())).collect();
    let shown = |key: &str| field(key).map(value_to_string).unwrap_or_default();
    let mut parts: Vec<Option<String>> = vec![
        (!is_unset(field("mark"))).then(|| format!("#{}", shown("mark"))),
        (!is_unset(field("ref"))).then(|| format!("[{}]", shown("ref"))),
        Some(bare_text(&field("role").filter(|role| truthy(role)).map(value_to_string).unwrap_or_else(|| "Unknown".into()))),
        Some(quoted_text(&field("name").filter(|name| !name.is_null()).map(value_to_string).unwrap_or_default())),
        (!is_unset(field("value"))).then(|| format!("value={}", quoted_text(&shown("value")))),
        (!is_unset(field("state")) && field("state") != field("source")).then(|| format!("state={}", bare_text(&shown("state")))),
        (!is_unset(field("source")) && field("source") != Some(&json!("uia"))).then(|| format!("source={}", bare_text(&shown("source")))),
        (field("enabled") == Some(&Value::Bool(false))).then(|| "disabled".to_owned()),
        (field("has_keyboard_focus") == Some(&Value::Bool(true))).then(|| "focused".to_owned()),
    ];
    parts.push(match field("bounds") {
        Some(Value::Array(edges)) => bounds_text(&edges.iter().map(Some).collect::<Vec<_>>()),
        _ => bounds_text(&[rest.get("x"), rest.get("y"), rest.get("width"), rest.get("height")]),
    });
    parts.push(match field("actions") {
        Some(Value::Array(actions)) if !actions.is_empty() => Some(value_to_string(&Value::Array(actions.clone()))),
        _ => None,
    });
    let mut line: Vec<String> = parts.into_iter().flatten().filter(|part| !part.is_empty()).collect();
    line.extend(extra_field_texts(&rest));
    Value::String(line.join(" "))
}

fn ocr_text_line(row: &Value) -> Value {
    let Value::Object(fields) = row else { return row.clone() };
    const NAMED: [&str; 7] = ["mark", "text", "line", "x", "y", "width", "height"];
    let field = |key: &str| fields.get(key);
    let rest: Map<String, Value> = fields.iter().filter(|(key, _)| !NAMED.contains(&key.as_str())).map(|(key, value)| (key.clone(), value.clone())).collect();
    let shown = |key: &str| field(key).map(value_to_string).unwrap_or_default();
    let mut line: Vec<String> = [
        (!is_unset(field("mark"))).then(|| format!("#{}", shown("mark"))),
        Some(quoted_text(&field("text").filter(|text| !text.is_null()).map(value_to_string).unwrap_or_default())),
        bounds_text(&[field("x"), field("y"), field("width"), field("height")]),
        (!is_unset(field("line"))).then(|| format!("line={}", shown("line"))),
    ]
    .into_iter()
    .flatten()
    .filter(|part| !part.is_empty())
    .collect();
    line.extend(extra_field_texts(&rest));
    Value::String(line.join(" "))
}

/// `renderObservationLines`: elements and OCR text reach the model one line each.
fn render_observation_lines(frame: &mut Map<String, Value>) {
    if let Some(Value::Array(elements)) = frame.get_mut("elements") {
        *elements = elements.iter().map(element_line).collect();
    }
    if let Some(delta) = frame.get_mut("elements_delta") {
        if let Value::Object(delta) = delta
            && let Some(Value::Array(added)) = delta.get_mut("added")
        {
            *added = added.iter().map(element_line).collect();
        }
        if delta.is_object() || delta.is_array() {
            // The delta already says what changed; the host's count summary repeats it.
            frame.shift_remove("changes");
        }
    }
    if let Some(Value::Object(ocr)) = frame.get_mut("ocr") {
        for key in ["lines", "words"] {
            if let Some(Value::Array(rows)) = ocr.get_mut(key) {
                *rows = rows.iter().map(ocr_text_line).collect();
            }
        }
    }
}

/// `computerResultRecovery`: the recovery of an `ok:false` reply that names its code.
fn result_recovery(result: &Map<String, Value>, action: &str, input: &Value) -> Option<(String, &'static str, String)> {
    let code = result.get("code").filter(|code| truthy(code)).map(value_to_string).unwrap_or_default();
    let flag = |key: &str| result.get(key) == Some(&Value::Bool(true));
    let label = || {
        let named = |key: &str| input.get(key).filter(|value| truthy(value)).map(value_to_string);
        match (named("window_id"), named("app")) {
            (Some(id), _) => format!("window {id}"),
            (None, Some(app)) => format!("app \"{app}\""),
            _ => "the exact target window".to_owned(),
        }
    };
    let found = match code.as_str() {
        "observation_unavailable" => Some(("capture", format!("The action and its observation have separate outcomes. Preserve completed steps and inspect {} with a fresh capture. Do not repeat input merely because the final observation failed.", label()))),
        "background_unsupported" if result.get("delivery_accepted") == Some(&Value::Bool(false)) && !flag("input_may_have_executed") => Some(("select_delivery", "This action was refused before input delivery. Choose a supported semantic action or explicit foreground delivery only within the user-approved scope. Keep the selected app/browser session. Reuse an observation only while it is still valid; do not assume earlier steps in a sequence were also unexecuted.".to_owned())),
        "user_input_active" if flag("yielded") => {
            let resume = if result.get("resume_mode").and_then(Value::as_str) == Some("manual") {
                "Automatic resume is off, so it waits until the user presses Resume on the overlay."
            } else {
                "It continues by itself once the user has been idle for the idle-resume interval."
            };
            Some(("wait_for_user", format!("Computer Use yielded to the user's input for this agent only; other agents continue. {resume} Neither retry now nor give up: call wait_for_user. After status \"resumed\", capture {} again before any input. Never replay the interrupted input, which may have been partly delivered. After \"timeout\" or \"cancelled\" no input is authorized.", label())))
        }
        _ => None,
    };
    if let Some((next, guidance)) = found {
        return Some((code, next, guidance));
    }
    // The remaining categories are the code's own: the same table that words a failed call's recovery (a timeout of a
    // read-only action reads the call's action).
    let recovery = tool_error_recovery(&format!("{}:", code.to_lowercase()), &json!({ "action": action, "input": input }))?;
    Some((recovery.code, recovery.next, recovery.guidance))
}

/// `canonicalComputerResultIsError`.
fn canonical_is_error(reply: &str, action: &str, input: &Value) -> bool {
    if action == "clipboard" && input.get("operation").and_then(Value::as_str) == Some("read") {
        return false;
    }
    let value = payload(reply);
    value.get("action").and_then(Value::as_str) == Some(action) && value.get("ok") == Some(&Value::Bool(false))
}

/// `computerImageDimensions`: the frame's real size, from the text's `width` and `height` (or its `observation`'s).
fn image_dimensions(reply: &str) -> Option<(u32, u32)> {
    let value: Value = serde_json::from_str(reply).ok()?;
    let size = |frame: Option<&Value>| {
        let frame = frame?;
        let (width, height) = (to_number(frame.get("width")?), to_number(frame.get("height")?));
        (width > 0.0 && height > 0.0 && width.is_finite() && height.is_finite()).then_some((width as u32, height as u32))
    };
    size(Some(&value)).or_else(|| size(value.get("observation")))
}

/// `computerToolResult`: the reply as the tool's parts, or the error result it is.
fn tool_result(reply: HostReply, action: &str, input: &Value) -> Result<Vec<ToolPart>, ComputerError> {
    let text = canonical_text(&reply.text, action, input);
    if reply.is_error || canonical_is_error(&text, action, input) {
        return Err(reported(text));
    }
    let size = image_dimensions(&text);
    let mut parts = vec![ToolPart::Text(text)];
    if let Some((mime, bytes)) = reply.image {
        parts.push(ToolPart::Image { mime, data: ImageData::Bytes(bytes), width: size.map(|s| s.0), height: size.map(|s| s.1) });
    }
    Ok(parts)
}

/// A handed-off secret is typed through the desktop host's router as a helper command (`computerSecretInput`): the `find` of its
/// bound window and the `type` of the secret, the host admitting them (observation only, the lane, the person's control).
#[async_trait]
impl ComputerSecretHost for DesktopHostBackend {
    async fn execute(&self, mut command: Map<String, Value>) -> Result<Map<String, Value>, String> {
        let message = |error: ComputerError| match error {
            ComputerError::Failed { message, .. } => message,
            ComputerError::Unavailable { reason } | ComputerError::InvalidInput { reason } => reason,
            ComputerError::Denied => "denied".to_owned(),
            ComputerError::Cancelled => "cancelled".to_owned(),
        };
        if !self.desktop.serves(HostCapability::Computer) {
            return Err(message(bridge_unavailable()));
        }
        self.hold_for_secret(&command).map_err(message)?;
        if !js_trim(&self.session_id).is_empty() {
            command.insert("session_id".into(), json!(self.session_id));
        }
        self.bound.store(true, Ordering::SeqCst);
        match self.post(command, &CancellationToken::new(), REQUEST_TIMEOUT).await {
            Ok(Posted::Reply(reply)) if reply.is_error => Err(reply.text),
            Ok(Posted::Reply(reply)) => Ok(payload(&reply.text)),
            Ok(Posted::Refused(refusal)) => Err(refusal),
            Err(error) => Err(message(error)),
        }
    }

    fn arm_focus(&self) {
        self.secret_focus.store(true, Ordering::SeqCst);
    }
}

#[async_trait]
impl ComputerBackend for DesktopHostBackend {
    async fn run(&self, request: ComputerRequest, cancel: CancellationToken) -> Result<Vec<ToolPart>, ComputerError> {
        // Node's client reads the bridge's discovery before it validates or dispatches anything.
        if !self.desktop.serves(HostCapability::Computer) {
            return Err(bridge_unavailable());
        }
        let Some(input) = request.input.as_object() else {
            return Err(ComputerError::InvalidInput { reason: format!("Computer Use action \"{}\" input must be an object", request.action.wire_name()) });
        };
        validate(request.action, input).map_err(|reason| ComputerError::InvalidInput { reason })?;
        let mut command = host_command(request.action, input)?;
        if !js_trim(&self.session_id).is_empty() {
            command.insert("session_id".into(), json!(self.session_id));
        }
        if Value::Object(command.clone()).to_string().len() > MAX_REQUEST_BYTES {
            return Err(reported("Error: computer request exceeds byte limit; no input was dispatched"));
        }
        self.hold_for_secret(&command)?;
        self.bound.store(true, Ordering::SeqCst);
        let posted = self.post(command.clone(), &cancel, REQUEST_TIMEOUT).await;
        // A call cancelled while its request was out ends as aborted, whatever came back (`readComputerBridgeBody`).
        if cancel.is_cancelled() {
            return Err(self.aborted(&command).await);
        }
        let posted = posted?;
        let action = request.action.wire_name();
        match posted {
            Posted::Refused(message) => Err(self.refused(message, &request, &cancel).await),
            Posted::Reply(reply) => {
                let reply = if is_pending(&reply.text) { self.settle_pending(reply, &command, &cancel).await? } else { reply };
                tool_result(reply, action, &request.input)
            }
        }
    }

    fn inject(&self, input: ScreenInput) -> Result<InputOutcome, ComputerError> {
        computer_policy::admit_screen_input((self.observe_only)())?;
        self.screen.inject(input)
    }

    fn release_input(&self) -> Result<u32, ComputerError> {
        self.screen.release()
    }

    fn input_desktop(&self) -> Option<DesktopIdentity> {
        self.screen.input_desktop()
    }

    fn displays(&self) -> Result<Vec<DisplayInfo>, ComputerError> {
        self.screen.displays()
    }

    fn screen_source(&self, display: DisplayId) -> Result<Box<dyn MediaFrameSource>, ComputerError> {
        self.screen.source(display)
    }

    fn status(&self) -> ComputerStatus {
        ComputerStatus { active: self.bound.load(Ordering::SeqCst), observe_only: (self.observe_only)(), controller: None }
    }
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;
    use std::collections::VecDeque;
    use std::sync::Mutex;

    use mixdog_core_api::domain::computer::ComputerAction;

    use super::*;

    enum Answer {
        Reply(Value),
        Rpc(i64, &'static str),
        Unavailable(&'static str),
        Hang,
    }

    struct FakeHost {
        serving: bool,
        script: Mutex<VecDeque<Answer>>,
        seen: Mutex<Vec<Value>>,
    }

    impl FakeHost {
        fn new(answers: Vec<Answer>) -> Arc<Self> {
            Arc::new(Self { serving: true, script: Mutex::new(answers.into()), seen: Mutex::default() })
        }

        fn commands(&self) -> Vec<Value> {
            self.seen.lock().unwrap().clone()
        }
    }

    #[async_trait]
    impl HostChannel for FakeHost {
        async fn request(&self, capability: HostCapability, method: Method, params: Value) -> Result<Value, HostError> {
            assert_eq!((capability, method.as_str()), (HostCapability::Computer, METHOD));
            self.seen.lock().unwrap().push(params);
            let answer = self.script.lock().unwrap().pop_front();
            match answer {
                Some(Answer::Reply(value)) => Ok(value),
                Some(Answer::Rpc(code, message)) => Err(HostError::Rpc { code, message: message.into(), data: None }),
                Some(Answer::Unavailable(detail)) => {
                    Err(HostError::Core(CoreError::CapabilityUnavailable { capability: "desktopHost".into(), detail: detail.into() }))
                }
                Some(Answer::Hang) => std::future::pending().await,
                None => Err(HostError::Core(CoreError::CapabilityUnavailable { capability: "desktopHost".into(), detail: "noClaimant".into() })),
            }
        }

        fn serves(&self, _: HostCapability) -> bool {
            self.serving
        }

        fn notify(&self, _: HostCapability, _: Method, _: Value) -> Result<(), CoreError> {
            unreachable!("a computer command is a request")
        }
    }

    struct Blobs(HashMap<String, Vec<u8>>);

    #[async_trait]
    impl ComputerBlobs for Blobs {
        async fn read(&self, digest: &str) -> Result<Vec<u8>, ComputerError> {
            self.0.get(digest).cloned().ok_or(ComputerError::Unavailable { reason: "no blob".into() })
        }
    }

    fn backend(host: &Arc<FakeHost>) -> DesktopHostBackend {
        let blobs = Blobs(HashMap::from([("d1".to_owned(), vec![1, 2, 3])]));
        DesktopHostBackend::new(host.clone(), Arc::new(blobs), "thread-1", Arc::new(|| false))
    }

    fn ok(text: &str) -> Answer {
        Answer::Reply(json!({ "ok": true, "text": text }))
    }

    fn capture() -> ComputerRequest {
        ComputerRequest { action: ComputerAction::Capture, input: json!({ "window_id": "hwnd:0x2" }) }
    }

    fn failure(error: ComputerError) -> (String, String) {
        match error {
            ComputerError::Failed { code, message } => (code, message),
            other => panic!("{other:?}"),
        }
    }

    #[tokio::test]
    async fn a_reply_is_the_canonical_text_and_its_image_read_from_the_blob_store() {
        let text = json!({
            "ok": true, "action": "snapshot", "width": 640, "height": 480, "timings_ms": { "x": 1 },
            "elements": [{ "mark": 3, "ref": "e1", "role": "Button", "name": "Save", "bounds": [1, 2, 30, 40], "actions": ["click"] }]
        })
        .to_string();
        let host = FakeHost::new(vec![Answer::Reply(json!({
            "ok": true, "text": text, "imageBlob": { "digest": "d1", "byteLength": 3, "mimeType": "image/png" }
        }))]);
        let parts = backend(&host).run(capture(), CancellationToken::new()).await.unwrap();
        let ToolPart::Text(shown) = &parts[0] else { panic!("text first") };
        let shown: Value = serde_json::from_str(shown).unwrap();
        assert_eq!(shown["action"], "capture");
        assert_eq!(shown["mode"], "state");
        assert!(shown.get("timings_ms").is_none());
        assert_eq!(shown["elements"][0], "#3 [e1] Button \"Save\" @1,2,30,40 click");
        assert_eq!(parts[1], ToolPart::Image { mime: "image/png".into(), data: ImageData::Bytes(vec![1, 2, 3]), width: Some(640), height: Some(480) });
        // The request is the bridge command and names the session both ways.
        let sent = &host.commands()[0];
        assert_eq!(sent["sessionThreadId"], "thread-1");
        assert_eq!((sent["command"]["action"].clone(), sent["command"]["session_id"].clone()), (json!("capture"), json!("thread-1")));
        assert_eq!(sent["command"]["window_id"], "hwnd:0x2");
    }

    #[tokio::test]
    async fn an_image_that_is_not_what_the_reply_says_is_refused() {
        for blob in [
            json!({ "digest": "d1", "byteLength": 4, "mimeType": "image/png" }),
            json!({ "digest": "d1", "byteLength": 3, "mimeType": "image/gif" }),
            json!({ "digest": "missing", "byteLength": 3, "mimeType": "image/png" }),
        ] {
            let host = FakeHost::new(vec![Answer::Reply(json!({ "ok": true, "text": "OK", "imageBlob": blob }))]);
            let (code, message) = failure(backend(&host).run(capture(), CancellationToken::new()).await.unwrap_err());
            assert_eq!(code, REPORTED_CODE);
            assert!(message.starts_with("Error: computer bridge returned an invalid or oversized image"));
        }
    }

    #[tokio::test]
    async fn an_error_reply_and_a_failed_payload_are_error_results() {
        let host = FakeHost::new(vec![Answer::Reply(json!({ "ok": true, "text": "boom", "isError": true }))]);
        let (code, message) = failure(backend(&host).run(capture(), CancellationToken::new()).await.unwrap_err());
        assert_eq!((code.as_str(), message.as_str()), (REPORTED_CODE, "boom"));
        let failed = json!({ "ok": false, "action": "capture", "code": "pixel_unavailable" }).to_string();
        let host = FakeHost::new(vec![ok(&failed)]);
        let (_, message) = failure(backend(&host).run(capture(), CancellationToken::new()).await.unwrap_err());
        let message: Value = serde_json::from_str(&message).unwrap();
        assert_eq!(message["recovery"]["next"], "capture");
    }

    #[tokio::test]
    async fn a_refusal_keeps_the_hosts_text_and_its_code() {
        let host = FakeHost::new(vec![Answer::Reply(json!({ "ok": false, "error": "computer_user_takeover: the user has the desktop" }))]);
        let (code, message) = failure(backend(&host).run(capture(), CancellationToken::new()).await.unwrap_err());
        assert_eq!((code.as_str(), message.as_str()), ("computer_user_takeover", "computer_user_takeover: the user has the desktop"));
    }

    #[tokio::test]
    async fn a_stale_target_is_captured_again_with_the_refusal() {
        let host = FakeHost::new(vec![Answer::Reply(json!({ "ok": false, "error": "stale_target: moved" })), ok("fresh")]);
        let act = ComputerRequest { action: ComputerAction::Window, input: json!({ "window_id": "hwnd:0x2", "operation": "focus" }) };
        let (code, message) = failure(backend(&host).run(act, CancellationToken::new()).await.unwrap_err());
        assert_eq!(code, REPORTED_CODE);
        assert!(message.starts_with("Error: stale_target: moved\nRecovery: no input was sent; window hwnd:0x2 was captured again below."));
        assert!(message.ends_with("\nfresh"));
        assert_eq!(host.commands()[1]["command"]["action"], "capture");
    }

    #[tokio::test]
    async fn a_host_that_does_not_know_the_method_makes_computer_unavailable() {
        let host = FakeHost::new(vec![Answer::Rpc(METHOD_NOT_FOUND, "method not found")]);
        let (code, message) = failure(backend(&host).run(capture(), CancellationToken::new()).await.unwrap_err());
        assert_eq!((code.as_str(), message.as_str()), (REPORTED_CODE, "Error: computer use is unavailable; open the Mixdog desktop app and enable Computer Use in settings"));
        // Another JSON-RPC error is the host's own failure text.
        let host = FakeHost::new(vec![Answer::Rpc(-32000, "capture_failed: no display")]);
        let (code, message) = failure(backend(&host).run(capture(), CancellationToken::new()).await.unwrap_err());
        assert_eq!((code.as_str(), message.as_str()), ("capture_failed", "capture_failed: no display"));
    }

    #[tokio::test]
    async fn no_claimant_is_unavailable_and_sends_nothing() {
        let host = Arc::new(FakeHost { serving: false, script: Mutex::default(), seen: Mutex::default() });
        let (_, message) = failure(backend(&host).run(capture(), CancellationToken::new()).await.unwrap_err());
        assert!(message.contains("computer use is unavailable"));
        assert!(host.commands().is_empty());
        // A claimant that closes before it answers: a read is unavailable, an input may have executed.
        let host = FakeHost::new(vec![]);
        let (_, message) = failure(backend(&host).run(capture(), CancellationToken::new()).await.unwrap_err());
        assert!(message.contains("computer use is unavailable"));
        let host = FakeHost::new(vec![]);
        let click = ComputerRequest { action: ComputerAction::Window, input: json!({ "window_id": "hwnd:0x2", "operation": "focus" }) };
        let (_, message) = failure(backend(&host).run(click, CancellationToken::new()).await.unwrap_err());
        assert!(message.contains("may have executed and was not replayed"));
    }

    #[tokio::test]
    async fn the_channels_deadline_is_the_clients_timeout() {
        let host = FakeHost::new(vec![Answer::Unavailable("timedOut")]);
        let (_, message) = failure(backend(&host).run(capture(), CancellationToken::new()).await.unwrap_err());
        assert_eq!(message, "Error: computer bridge timed out");
        let host = FakeHost::new(vec![Answer::Unavailable("timedOut")]);
        let focus = ComputerRequest { action: ComputerAction::Window, input: json!({ "window_id": "hwnd:0x2", "operation": "focus" }) };
        let (_, message) = failure(backend(&host).run(focus, CancellationToken::new()).await.unwrap_err());
        assert!(message.contains("may have executed and was not replayed"));
    }

    #[tokio::test]
    async fn an_input_that_breaks_the_contract_is_refused_before_the_host_is_asked() {
        let host = FakeHost::new(vec![]);
        let bad = ComputerRequest { action: ComputerAction::Act, input: json!({ "window_id": "hwnd:0x2" }) };
        assert!(matches!(backend(&host).run(bad, CancellationToken::new()).await, Err(ComputerError::InvalidInput { .. })));
        assert!(host.commands().is_empty());
    }

    /// A secret typed through the dual path is a helper command the host answers; once its field may hold focus a read is refused,
    /// and the next input lifts the hold.
    #[tokio::test]
    async fn a_secret_is_typed_through_the_host_and_holds_the_reads() {
        let host = FakeHost::new(vec![ok(r#"{"found":true}"#), ok(r#"{"typed":true}"#), ok("{}")]);
        let backend = backend(&host);
        let found = ComputerSecretHost::execute(&backend, command_of(&[("action", json!("find"))])).await.unwrap();
        assert_eq!(found["found"], json!(true));
        backend.arm_focus();
        assert!(ComputerSecretHost::execute(&backend, command_of(&[("action", json!("find"))])).await.unwrap_err().starts_with("capture_withheld"));
        let typed = ComputerSecretHost::execute(&backend, command_of(&[("action", json!("type")), ("text", json!("x"))])).await.unwrap();
        assert_eq!(typed["typed"], json!(true));
        assert!(ComputerSecretHost::execute(&backend, command_of(&[("action", json!("find"))])).await.is_ok(), "the hold was lifted by the input");
        assert_eq!(host.commands().iter().map(|command| command["command"]["session_id"].clone()).collect::<Vec<_>>(), vec![json!("thread-1"); 3]);
    }

    #[tokio::test]
    async fn a_cancelled_call_abandons_the_request_and_aborts_the_session() {
        let host = FakeHost::new(vec![Answer::Hang, ok("OK")]);
        let cancel = CancellationToken::new();
        let stop = cancel.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(20)).await;
            stop.cancel();
        });
        let click = ComputerRequest { action: ComputerAction::Window, input: json!({ "window_id": "hwnd:0x2", "operation": "focus" }) };
        let (code, message) = failure(backend(&host).run(click, cancel).await.unwrap_err());
        assert_eq!(code, REPORTED_CODE);
        assert_eq!(
            message,
            "Error: computer command aborted; input state and session resources were released; input may have partially executed; inspect fresh state before retrying"
        );
        let abort = &host.commands()[1]["command"];
        assert_eq!((abort["action"].clone(), abort["session_id"].clone()), (json!("session_abort"), json!("thread-1")));
    }

    #[tokio::test]
    async fn a_pause_by_the_person_is_waited_out_and_ends_with_a_fresh_capture() {
        let paused = json!({ "ok": false, "status": "paused", "code": PENDING_CODE, "completed_steps": 1, "total_steps": 2 }).to_string();
        let resumed = json!({ "status": "resumed", "resumed": true }).to_string();
        let fresh = json!({ "ok": true, "action": "capture" }).to_string();
        let host = FakeHost::new(vec![ok(&paused), ok(&resumed), ok(&fresh)]);
        let parts = backend(&host).run(capture(), CancellationToken::new()).await.unwrap();
        let ToolPart::Text(shown) = &parts[0] else { panic!("text") };
        let shown: Value = serde_json::from_str(shown).unwrap();
        assert_eq!((shown["status"].clone(), shown["ok"].clone(), shown["input_replayed"].clone()), (json!("resumed"), json!(true), json!(false)));
        assert_eq!(shown["observation"]["ok"], true);
        // Only reads were sent after the original command.
        let sent: Vec<Value> = host.commands().iter().map(|c| c["command"]["action"].clone()).collect();
        assert_eq!(sent, [json!("capture"), json!("wait_for_user"), json!("capture")]);
        assert_eq!(host.commands()[1]["command"]["timeout_ms"], 60_000);
    }

    #[tokio::test]
    async fn a_resume_that_is_not_confirmed_ends_the_wait_without_replaying_input() {
        let paused = json!({ "ok": false, "status": "paused", "code": PENDING_CODE }).to_string();
        let host = FakeHost::new(vec![ok(&paused), ok(&json!({ "status": "cancelled", "reason": "stopped" }).to_string())]);
        let parts = backend(&host).run(capture(), CancellationToken::new()).await.unwrap();
        let ToolPart::Text(shown) = &parts[0] else { panic!("text") };
        let shown: Value = serde_json::from_str(shown).unwrap();
        assert_eq!((shown["status"].clone(), shown["reason"].clone(), shown["input_replayed"].clone()), (json!("cancelled"), json!("stopped"), json!(false)));
    }

    #[test]
    fn the_act_steps_read_in_the_tools_names() {
        let reply = json!({
            "ok": true, "action": "sequence", "completed_steps": 2, "total_steps": 2,
            "window_transition": { "to": "w2" },
            "steps": [
                { "action": "click", "ok": true, "window_transition": { "to": "w2" } },
                { "action": "type_text", "ok": false, "status": "weird" }
            ],
            "capture_after": { "ok": true, "capture_attempts": 2 }
        })
        .to_string();
        let input = json!({ "window_id": "w", "actions": [{ "type": "left_click" }, {}] });
        let shown: Value = serde_json::from_str(&canonical_text(&reply, "act", &input)).unwrap();
        assert_eq!(shown["action"], "act");
        assert_eq!((shown["completed_actions"].clone(), shown["total_actions"].clone()), (json!(2), json!(2)));
        assert_eq!(shown["actions"][0], json!({ "type": "left_click", "status": "succeeded" }));
        assert_eq!(shown["actions"][1], json!({ "type": "type_text", "status": "failed" }));
        assert_eq!(shown["observation"], json!({ "ok": true }));
        for gone in ["steps", "completed_steps", "total_steps", "capture_after"] {
            assert!(shown.get(gone).is_none(), "{gone}");
        }
    }

    #[test]
    fn text_that_is_not_a_result_and_a_clipboard_read_stay_as_they_are() {
        let input = json!({ "operation": "read" });
        assert_eq!(canonical_text("plain", "list", &json!({})), "plain");
        assert_eq!(canonical_text("{\"action\":\"x\",\"ok\":false}", "clipboard", &input), "{\"action\":\"x\",\"ok\":false}");
        assert!(!canonical_is_error("{\"action\":\"clipboard\",\"ok\":false}", "clipboard", &input));
        assert!(canonical_is_error("{\"action\":\"list\",\"ok\":false}", "list", &json!({})));
        assert_eq!(canonical_text("{\"x\":1}", "list", &json!({})), "{\"x\":1}");
    }

    #[test]
    fn ocr_lines_and_the_delta_summary_are_rendered() {
        let reply = json!({
            "action": "capture", "ok": true,
            "ocr": { "lines": [{ "mark": 1, "text": "Hello world", "x": 1, "y": 2, "width": 3, "height": 4, "line": 2 }] },
            "elements_delta": { "added": [{ "role": "Edit", "name": "", "source": "ocr", "state": "ocr", "enabled": false }] },
            "changes": { "added": 1 }
        })
        .to_string();
        let shown: Value = serde_json::from_str(&canonical_text(&reply, "capture", &json!({ "mode": "zoom" }))).unwrap();
        assert_eq!(shown["mode"], "zoom");
        assert_eq!(shown["ocr"]["lines"][0], "#1 \"Hello world\" @1,2,3,4 line=2");
        assert_eq!(shown["elements_delta"]["added"][0], "Edit \"\" source=ocr disabled");
        assert!(shown.get("changes").is_none());
    }

    #[test]
    fn only_reads_may_be_asked_again() {
        let command = |action: &str| command_of(&[("action", json!(action))]);
        assert!(!may_have_executed(&command("capture")));
        assert!(may_have_executed(&command("sequence")));
        let mut read_only = command("sequence");
        read_only.insert("read_only".into(), json!(true));
        assert!(!may_have_executed(&read_only));
    }
}
