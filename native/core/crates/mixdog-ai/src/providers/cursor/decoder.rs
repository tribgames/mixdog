//! The agent run's server side: Connect frames of `AgentServerMessage`.
//!
//! Text and thinking deltas become stream events; tool calls come from exec
//! messages (the model's MCP calls, or native reads/writes/shell redirected to
//! Mixdog tools). Everything the server asks of the client in between (request
//! context, blob reads and writes, refused interactions and execs) is answered
//! through [`CursorDecoder::take_outbound`]; the stream writes those messages
//! back on the open request body.
//!
//! A batch is a step's calls. The service sends an exec as soon as the model
//! wrote its call, lists how many tool requests the step makes, and then sends
//! nothing that ends the step until it has the results: the batch is handed over
//! by the frame with which the execs received for the step reach the listed
//! count. A step that was never listed is handed over at a quiet point instead
//! ([`CursorDecoder::quiet`]), which the stream reaches after [`QUIET`] with no
//! frame but heartbeats; an exec of that step that arrives later is the next
//! batch. Frames received behind the one that ended a batch wait in the decoder
//! for the attempt that follows its results, so which frame ends a batch never
//! depends on how the transport cut the frames into chunks.
//!
//! What lives how long. Per run: the frame reader, the frames waiting, the
//! executions (which exec was announced under which call id, and whether its
//! result was written back), the blobs and the context size. Per step: the
//! listed count and the execs received for it. Per batch: the calls being
//! collected, the call dedupe, the token count and what was shown; the calls
//! handed over live until their results are written back. Per attempt: the
//! request whose transcript answers an exec the service sends again.

use std::collections::HashMap;
use std::collections::HashSet;
use std::collections::VecDeque;
use std::sync::Arc;
use std::sync::LazyLock;

use mixdog_core_api::domain::provider::Content;
use mixdog_core_api::domain::provider::DeliveryState;
use mixdog_core_api::domain::provider::ErrorKind;
use mixdog_core_api::domain::provider::Exposure;
use mixdog_core_api::domain::provider::ItemKind;
use mixdog_core_api::domain::provider::Message;
use mixdog_core_api::domain::provider::ModelRequest;
use mixdog_core_api::domain::provider::ProgressKind;
use mixdog_core_api::domain::provider::ProviderError;
use mixdog_core_api::domain::provider::Role;
use mixdog_core_api::domain::provider::StopReason;
use mixdog_core_api::domain::provider::StreamEvent;
use mixdog_core_api::domain::provider::ToolCall;
use mixdog_core_api::domain::provider::TransportFault;
use mixdog_core_api::domain::provider::Usage;
use mixdog_core_api::domain::provider::WireDecoder;
use serde_json::Value;
use serde_json::json;

use super::answer;
use super::request::BlobStore;
use super::request::MAX_CONNECT_FRAME_BYTES;
use super::request::random_uuid;
use super::request::request_context;
use super::schema::ExecEcho;
use super::schema::ExecResult;
use super::schema::ExecServer;
use super::schema::InteractionUpdate;
use super::schema::McpToolDefinition;
use super::schema::QueryCase;
use super::schema::QueryReply;
use super::schema::ServerMessage;
use super::schema::TurnUsage;
use super::schema::UnavailableKind;
use super::schema::checkpoint_used_tokens;
use super::schema::decode_error_details;
use super::schema::decode_json_value;
use super::schema::exec_client_message;
use super::schema::exec_stream_close;
use super::schema::exec_throw;
use super::schema::interaction_response;
use super::schema::kv_client_message;
use crate::providers::connect::ConnectFailure;
use crate::providers::connect::frame::Frame;
use crate::providers::connect::frame::FrameReader;
use crate::providers::connect::provider_error;
use crate::providers::leak;
use crate::providers::leak::Dedupe;
use crate::providers::leak::LeakGuard;
use crate::providers::leak::Recovered;
use crate::retry::advice;

/// `REQUEST_TOO_LARGE_RE` (cursor-wire-transport.mjs:80): only explicit wording about the tool catalog or the request
/// payload being too large counts.
static REQUEST_TOO_LARGE: LazyLock<regex::Regex> = LazyLock::new(|| {
    regex::Regex::new(
        r"(?i)(?-u:\b)(?:tool\s+(?:catalog|definitions?|schemas?)|tools|payload|request(?:\s+body)?)(?-u:\b)[^.\n]{0,80}?(?-u:\b)(?:too\s+(?:large|big)|exceed(?:s|ed)?(?-u:\b)[^.\n]{0,30}?(?-u:\b)(?:size|limit|maximum))",
    )
    .expect("constant pattern")
});

/// `THROTTLE_CUE_RE`: rate or quota wording wins over the size match.
static THROTTLE_CUE: LazyLock<regex::Regex> =
    LazyLock::new(|| regex::Regex::new(r"(?i)too\s+many\s+requests|quota|rate[\s_-]*limit|throttl").expect("constant pattern"));

/// How long nothing but heartbeats arrives before the calls of a step the service did not list are handed over.
pub const QUIET: std::time::Duration = std::time::Duration::from_secs(1);
const RESULT_GONE: &str = "The result of this call is no longer held. Run the call again if it is still needed.";
const GREP_NEEDS_PATTERN: &str = "A search needs a pattern. To list the files a glob matches, use the mixdog MCP glob tool with {\"pattern\":\"<glob>\"}.";
const UNAVAILABLE: &str = "Tool not available in this environment. Use a Mixdog tool instead.";
const REJECT_REASON: &str = "This Cursor-side interaction is unavailable. Use the Mixdog tools instead.";
const BACKGROUND_SHELL_REASON: &str = "Cursor background shell is not supported. Use the mixdog MCP shell tool with {\"command\":\"...\"}; if it returns task_id, use the mixdog task tool with {\"action\":\"wait\",\"task_id\":\"<returned id>\"}. Use load_tool {\"names\":\"task\"} if task is not loaded.";
const BRIDGE_NAME_MAX_CHARS: usize = 256;
const BRIDGE_META_TOOLS: [&str; 3] = ["load_tool", "call_tool", "tool_search"];

/// Splits assistant text into answer and reasoning around `<think>`-style
/// tags, holding back a possible partial tag at the end of a delta.
#[derive(Default)]
struct ThinkFilter {
    buffer: String,
    reasoning: bool,
}

const TAG_NAMES: [&str; 5] = ["think", "thinking", "reasoning", "thought", "think_intent"];

/// `(length, closing)` of a think tag at the start of `s`.
fn match_tag(s: &str) -> Option<(usize, bool)> {
    let mut chars = s.char_indices().peekable();
    chars.next()?; // '<'
    let closing = matches!(chars.peek(), Some((_, '/')));
    if closing {
        chars.next();
    }
    let name_start = chars.peek().map_or(s.len(), |(i, _)| *i);
    let mut name_end = name_start;
    while let Some((i, c)) = chars.peek().copied() {
        if c.is_ascii_alphabetic() || c == '_' {
            name_end = i + c.len_utf8();
            chars.next();
        } else {
            break;
        }
    }
    let name = &s[name_start..name_end];
    if !TAG_NAMES.iter().any(|t| t.eq_ignore_ascii_case(name)) {
        return None;
    }
    while let Some((_, c)) = chars.peek().copied() {
        if c.is_whitespace() {
            chars.next();
        } else {
            break;
        }
    }
    match chars.next() {
        Some((i, '>')) => Some((i + 1, closing)),
        _ => None,
    }
}

fn is_partial_tag(s: &str) -> bool {
    let rest = s.strip_prefix('<').unwrap_or(s);
    let rest = rest.strip_prefix('/').unwrap_or(rest);
    rest.chars().all(|c| c.is_ascii_alphabetic() || c == '_')
}

impl ThinkFilter {
    /// `(content, reasoning)` of this delta.
    fn process(&mut self, delta: &str) -> (String, String) {
        let input = format!("{}{delta}", std::mem::take(&mut self.buffer));
        let (mut content, mut thought) = (String::new(), String::new());
        let mut cursor = 0;
        let mut at = 0;
        while let Some(rel) = input[at..].find('<') {
            let start = at + rel;
            if let Some((len, closing)) = match_tag(&input[start..]) {
                let segment = &input[cursor..start];
                if self.reasoning {
                    thought.push_str(segment);
                } else {
                    content.push_str(segment);
                }
                self.reasoning = !closing;
                cursor = start + len;
                at = cursor;
            } else {
                at = start + 1;
            }
        }
        let rest = &input[cursor..];
        let target = if self.reasoning { &mut thought } else { &mut content };
        match rest.rfind('<') {
            Some(partial) if rest[partial..].chars().count() < 18 && is_partial_tag(&rest[partial..]) => {
                target.push_str(&rest[..partial]);
                self.buffer = rest[partial..].to_owned();
            }
            _ => target.push_str(rest),
        }
        (content, thought)
    }

    fn flush(&mut self) -> (String, String) {
        let value = std::mem::take(&mut self.buffer);
        if self.reasoning { (String::new(), value) } else { (value, String::new()) }
    }
}

/// A tool call the server asked the client to execute.
#[derive(Debug, Clone)]
pub struct Pending {
    exec_key: String,
    pub tool_call_id: String,
    tool_name: String,
    arguments: Value,
    /// The exec it came from, which its result answers.
    pub exec: ExecServer,
}

/// An exec the run announced as a call.
struct Execution {
    /// The id its call was handed over under.
    call_id: String,
    /// Its result was written back on the run.
    answered: bool,
}

pub struct CursorDecoder {
    frames: FrameReader,
    /// Whole frames received behind the one that ended a batch, read by the attempt that follows it.
    waiting: VecDeque<Frame>,
    /// What the turn used, as the update that ended it said.
    turn_usage: Option<TurnUsage>,
    /// The output tokens the batches handed over before this one reported, which the turn's total holds again.
    reported_output: u64,
    /// How many tool requests the service listed for the step being read.
    listed: Option<u64>,
    /// The execs received for that step by key, those already answered among them; one sent again is the same exec.
    step_execs: HashSet<String>,
    /// Results were written back and frames that arrived before them may still be unread: the step they answer ends
    /// once those are read ([`Self::caught_up`]).
    resumed: bool,
    /// What the frame that ended the run with a failure says of it.
    refusal: Refusal,
    /// The run has shown something: text, reasoning, a call, or tokens of the model at work.
    spoke: bool,
    /// Every exec the run received, by key: one sent again is no new tool request of any step.
    seen: HashSet<String>,
    /// The frame being read is the service's heartbeat and nothing else.
    heartbeat_only: bool,
    /// A frame other than a heartbeat was read since this was last taken.
    stirred: bool,
    /// The request of the attempt now reading, whose transcript holds the results already written back.
    transcript: Option<Arc<ModelRequest>>,
    blobs: BlobStore,
    tools: Vec<McpToolDefinition>,
    cloud_rule: Option<String>,
    filter: ThinkFilter,
    saw_turn_ended: bool,
    saw_end: bool,
    /// True when the latest non-heartbeat/non-checkpoint/non-kv frame was `stepCompleted`.
    step_completed_is_latest: bool,
    /// True when visible text was the last output emitted (no subsequent tool call or thinking).
    last_output_was_text: bool,
    /// Tool call envelopes started via `toolCallStarted` and not yet closed by `toolCallCompleted`.
    open_tool_calls: HashSet<String>,
    /// Anonymous `toolCallStarted` updates (empty `call_id`) not yet closed.
    anonymous_open_tool_calls: usize,
    /// Monotonic counter advancing on every non-heartbeat/non-kv server frame and every non-kv client reply.
    progress_version: u64,
    /// Raw `ConversationStateStructure` bytes from the latest `conversationCheckpointUpdate`.
    latest_checkpoint: Option<Vec<u8>>,
    /// `progress_version` at which `latest_checkpoint` arrived.
    latest_checkpoint_progress_version: Option<u64>,
    /// Whether `saw_turn_ended` was already true when `latest_checkpoint` arrived.
    latest_checkpoint_terminal: bool,
    output_tokens: u64,
    context_tokens: Option<u64>,
    pending: Vec<Pending>,
    /// Every exec the run announced as a call, by its key.
    executions: HashMap<String, Execution>,
    /// The calls of the batch last handed over, which the run waits on.
    handed: Vec<Pending>,
    /// The server's heartbeat arrived since it was last taken.
    liveness: bool,
    outbound: Vec<Vec<u8>>,
    exposure: Exposure,
    reasoning_started: bool,
    text_started: bool,
    terminal: bool,
    /// The catalog model a pinned suffix id bills as, reported with the usage.
    pricing_model: Option<String>,
    /// The leaked tool-call guard over the answer text: Node's sink hands the chat consumer these deltas, whose guard
    /// (harmony syntax on) is built from the request's tool names.
    leak: LeakGuard,
    /// Calls recovered from text, dispatched with the turn's end after the announced ones.
    leaked: Vec<ToolCall>,
    /// One dispatch per call across the recovered and the announced path.
    dedupe: Dedupe,
}

fn drift_named(code: &str, message: &str) -> ProviderError {
    let mut error = ProviderError::new(ErrorKind::InvalidRequest, DeliveryState::Accepted);
    error.code = Some(code.to_owned());
    error.status = Some(400);
    error.message = message.to_owned();
    error
}

fn drift(message: &str) -> ProviderError {
    drift_named("protocol_drift", message)
}

/// The longest tail the read tool reads.
const READ_TAIL_MAX: u64 = 100_000;
const READ_TAIL_TOO_LONG: &str =
    "This window starts more than 100000 lines before the file's end, which is not read as one window. Read it by offset and limit from the file's start.";

/// How the service words a limit of the account, which no other conversation would pass.
static QUOTA_WORDING: LazyLock<regex::Regex> = LazyLock::new(|| {
    regex::Regex::new(r"(?i)quota|usage\s+limit|spend(?:ing)?\s+limit|billing|upgrade|out\s+of\s+(?:requests|credits)").expect("constant pattern")
});

fn cursor_error_name(code: u32) -> Option<&'static str> {
    Some(match code {
        0 => "UNSPECIFIED",
        1 => "BAD_API_KEY",
        2 => "NOT_LOGGED_IN",
        3 => "INVALID_AUTH_ID",
        4 => "NOT_HIGH_ENOUGH_PERMISSIONS",
        5 => "BAD_MODEL_NAME",
        6 => "USER_NOT_FOUND",
        7 => "FREE_USER_RATE_LIMIT_EXCEEDED",
        8 => "PRO_USER_RATE_LIMIT_EXCEEDED",
        9 => "FREE_USER_USAGE_LIMIT",
        10 => "PRO_USER_USAGE_LIMIT",
        11 => "AUTH_TOKEN_NOT_FOUND",
        12 => "AUTH_TOKEN_EXPIRED",
        13 => "OPENAI",
        14 => "OPENAI_RATE_LIMIT_EXCEEDED",
        18 => "AGENT_REQUIRES_LOGIN",
        20 => "MAX_TOKENS",
        21 => "USER_ABORTED_REQUEST",
        22 => "GENERIC_RATE_LIMIT_EXCEEDED",
        23 => "PRO_USER_ONLY",
        25 => "TIMEOUT",
        28 => "GPT_4_VISION_PREVIEW_RATE_LIMIT",
        29 => "CUSTOM_MESSAGE",
        30 => "OUTDATED_CLIENT",
        31 => "CLAUDE_IMAGE_TOO_LARGE",
        33 => "FILE_NOT_FOUND",
        34 => "API_KEY_RATE_LIMIT",
        35 => "DEBOUNCED",
        36 => "BAD_REQUEST",
        37 => "REPOSITORY_SERVICE_REPOSITORY_IS_NOT_INITIALIZED",
        38 => "UNAUTHORIZED",
        39 => "NOT_FOUND",
        40 => "DEPRECATED",
        41 => "RESOURCE_EXHAUSTED",
        42 => "BAD_USER_API_KEY",
        43 => "CONVERSATION_TOO_LONG",
        44 => "USAGE_PRICING_REQUIRED",
        45 => "USAGE_PRICING_REQUIRED_CHANGEABLE",
        46 => "GITHUB_NO_USER_CREDENTIALS",
        47 => "GITHUB_USER_NO_ACCESS",
        48 => "GITHUB_APP_NO_ACCESS",
        49 => "GITHUB_MULTIPLE_OWNERS",
        50 => "RATE_LIMITED",
        51 => "RATE_LIMITED_CHANGEABLE",
        52 => "CUSTOM",
        53 => "HOOKS_BLOCKED",
        54 => "SUSPICIOUS_USAGE_BLOCKED",
        55 => "EXTENSION_HOST_TIMEOUT",
        56 => "NETWORK_ERROR",
        57 => "PROVIDER_ERROR",
        58 => "MODEL_BLOCKED",
        59 => "INTERNAL",
        60 => "MAX_MODE_REQUIRED",
        61 => "MODEL_NO_LONGER_SUPPORTED",
        62 => "PRICING_WARNING",
        63 => "SLOW_POOL",
        64 => "UNSUPPORTED_REGION",
        65 => "ACCOUNT_CLOSED",
        _ => return None,
    })
}

fn cursor_error_code_by_name(raw: &str) -> Option<u32> {
    let trimmed = raw.trim().strip_prefix("ERROR_").unwrap_or(raw.trim());
    (0..=65).find(|&code| cursor_error_name(code) == Some(trimmed))
}

fn cursor_error_status(code: u32) -> Option<u16> {
    Some(match code {
        1 | 2 | 3 | 11 | 12 | 18 | 38 | 42 | 65 => 401,
        4 | 23 | 46 | 47 | 48 | 49 | 54 | 58 | 64 => 403,
        5 | 6 | 33 | 39 | 61 => 404,
        20 | 43 => 413,
        7 | 8 | 9 | 10 | 14 | 22 | 28 | 34 | 35 | 41 | 44 | 45 | 50 | 51 => 429,
        _ => return None,
    })
}

fn is_plan_limit_code(code: u32) -> bool {
    matches!(code, 9 | 10 | 44 | 45)
}

fn is_retryable_cursor_code(code: u32) -> bool {
    matches!(code, 13 | 25 | 55 | 56 | 57 | 59 | 63)
}

#[derive(Debug, Clone, Default)]
struct StructuredError {
    code: Option<u32>,
    title: String,
    detail: String,
    is_retryable: Option<bool>,
}

impl StructuredError {
    fn readable_body(&self) -> Option<String> {
        let title = self.title.trim();
        let detail = self.detail.trim();
        match (title.is_empty(), detail.is_empty()) {
            (false, false) => Some(format!("{title}: {detail}")),
            (false, true) => Some(title.to_owned()),
            (true, false) => Some(detail.to_owned()),
            (true, true) => None,
        }
    }
}

fn is_cursor_error_details_type(kind: &str) -> bool {
    matches!(kind, "aiserver.v1.ErrorDetails" | "type.googleapis.com/aiserver.v1.ErrorDetails")
}

fn decode_structured_error_from_object(object: &serde_json::Map<String, Value>) -> Option<StructuredError> {
    use base64::Engine;
    let details = object.get("details")?.as_array()?;
    for entry in details {
        let Some(kind) = entry.get("type").and_then(Value::as_str) else { continue };
        if !is_cursor_error_details_type(kind) {
            continue;
        }
        if let Some(encoded) = entry.get("value").and_then(Value::as_str).filter(|s| !s.is_empty())
            && let Ok(bytes) = base64::engine::general_purpose::STANDARD_NO_PAD.decode(encoded.trim_end_matches('='))
            && let Ok(decoded) = decode_error_details(&bytes)
        {
            let (title, detail, is_retryable) = match decoded.details {
                Some(custom) => (custom.title, custom.detail, custom.is_retryable),
                None => (String::new(), String::new(), None),
            };
            let code = (decoded.error != 0).then_some(decoded.error);
            if code.is_some() || is_retryable.is_some() || !title.is_empty() || !detail.is_empty() {
                return Some(StructuredError { code, title, detail, is_retryable });
            }
        }
        if let Some(debug) = entry.get("debug").and_then(Value::as_object) {
            let code =
                debug.get("error").and_then(|v| v.as_u64().map(|n| n as u32).or_else(|| v.as_str().and_then(cursor_error_code_by_name))).filter(|&c| c != 0);
            let inner = debug.get("details").and_then(Value::as_object);
            let title = inner.and_then(|d| d.get("title")).and_then(Value::as_str).unwrap_or_default().to_owned();
            let detail = inner.and_then(|d| d.get("detail")).and_then(Value::as_str).unwrap_or_default().to_owned();
            let is_retryable = inner.and_then(|d| d.get("isRetryable").or_else(|| d.get("is_retryable"))).and_then(Value::as_bool);
            if code.is_some() || is_retryable.is_some() || !title.is_empty() || !detail.is_empty() {
                return Some(StructuredError { code, title, detail, is_retryable });
            }
        }
    }
    None
}

fn decode_structured_error(parsed: &Value) -> Option<StructuredError> {
    parsed.get("error").and_then(Value::as_object).and_then(decode_structured_error_from_object)
}

fn classify_error_object(
    object: &serde_json::Map<String, Value>,
    metadata: Option<&Value>,
    http_status: Option<u16>,
    headers: &[(String, String)],
    exposure: Exposure,
) -> ProviderError {
    let code = object.get("code").and_then(Value::as_str).filter(|c| !c.is_empty()).unwrap_or("error").to_ascii_lowercase();
    let detail = object.get("message").and_then(Value::as_str).filter(|m| !m.is_empty()).unwrap_or("request failed");
    let advice_text = |v: &Value| match v {
        Value::String(s) => Some(s.clone()),
        Value::Number(n) => Some(n.to_string()),
        Value::Array(items) => items.first().and_then(|i| i.as_str().map(str::to_owned)),
        _ => None,
    };
    let retry_after = object
        .get("retryAfter")
        .or_else(|| object.get("retry_after"))
        .or_else(|| metadata.and_then(|m| m.get("retry-after")))
        .or_else(|| metadata.and_then(|m| m.get("retryAfter")))
        .and_then(advice_text)
        .and_then(|text| advice::from_headers(&[("retry-after".to_owned(), text)], std::time::SystemTime::now()))
        .or_else(|| advice::from_headers(headers, std::time::SystemTime::now()));
    if let Some(structured) = decode_structured_error_from_object(object) {
        if let Some(err_code) = structured.code {
            let name = cursor_error_name(err_code).map(str::to_owned).unwrap_or_else(|| format!("ERROR_{err_code}"));
            let is_generic = matches!(detail.trim().to_ascii_lowercase().as_str(), "" | "error" | "unknown" | "unknown error" | "request failed");
            let body = structured.readable_body().unwrap_or_else(|| if is_generic { name.clone() } else { detail.to_owned() });
            let full_message = format!("Cursor {name}: {body}");
            let (kind, status, out_code, should_retry) = if err_code == 21 {
                (ErrorKind::InvalidRequest, 499, "canceled".to_owned(), Some(false))
            } else if let Some(status) = cursor_error_status(err_code) {
                let kind = match status {
                    401 => ErrorKind::Auth,
                    403 => ErrorKind::Permission,
                    413 => ErrorKind::RequestTooLarge,
                    429 if is_plan_limit_code(err_code) => ErrorKind::QuotaExhausted,
                    429 => ErrorKind::RateLimited,
                    _ => ErrorKind::InvalidRequest,
                };
                (kind, status, name, None)
            } else if structured.is_retryable == Some(true) || (structured.is_retryable.is_none() && is_retryable_cursor_code(err_code)) {
                (ErrorKind::Transient, 503, name, None)
            } else {
                (ErrorKind::InvalidRequest, 400, name, (structured.is_retryable == Some(false)).then_some(false))
            };
            let mut error = ProviderError::new(kind, DeliveryState::Accepted);
            error.code = Some(out_code);
            error.status = Some(status);
            error.retry_after = retry_after;
            error.should_retry = should_retry;
            error.message = full_message;
            error.exposure = exposure;
            return error;
        }
        let readable = structured.readable_body();
        let message = match readable {
            Some(body) => format!("Cursor {code}: {body}"),
            None => format!("Cursor {code}: {detail}"),
        };
        let status = crate::providers::connect::connect_code_status(&code).or(http_status);
        let mut error = provider_error(ConnectFailure { code, message, http_status: status, retry_after }, DeliveryState::Accepted);
        match structured.is_retryable {
            Some(true) => {
                error.kind = ErrorKind::Transient;
                error.status = Some(503);
                error.should_retry = None;
            }
            Some(false) => {
                error.kind = ErrorKind::InvalidRequest;
                error.should_retry = Some(false);
            }
            None => {}
        }
        error.exposure = exposure;
        return error;
    }
    let too_large = code == "resource_exhausted" && !THROTTLE_CUE.is_match(detail) && REQUEST_TOO_LARGE.is_match(detail);
    let status = if too_large { Some(413) } else { crate::providers::connect::connect_code_status(&code).or(http_status) };
    let mut error = provider_error(
        ConnectFailure {
            code: if too_large { String::new() } else { code.clone() },
            message: format!("Cursor {code}: {detail}"),
            http_status: status,
            retry_after,
        },
        DeliveryState::Accepted,
    );
    if too_large {
        error.code = Some("request_too_large".to_owned());
    }
    error.exposure = exposure;
    error
}

fn unwrap_error_body(body: &[u8]) -> &[u8] {
    if let [0 | crate::providers::connect::frame::END_STREAM, b0, b1, b2, b3, payload @ ..] = body {
        let length = u32::from_be_bytes([*b0, *b1, *b2, *b3]) as usize;
        if payload.len() == length {
            return payload;
        }
    }
    body
}

pub(crate) fn classify_http_error(response: &mixdog_core_api::domain::provider::ErrorResponse, exposure: Exposure) -> ProviderError {
    let payload = unwrap_error_body(&response.body);
    if let Ok(parsed) = serde_json::from_slice::<Value>(payload) {
        let error_obj = parsed
            .get("error")
            .and_then(Value::as_object)
            .or_else(|| parsed.as_object().filter(|obj| obj.contains_key("code") || obj.contains_key("message") || obj.contains_key("details")));
        if let Some(object) = error_obj {
            return classify_error_object(object, parsed.get("metadata"), response.status, &response.headers, exposure);
        }
    }
    let mut error = super::http_status_error(response.status.unwrap_or(0), &response.headers);
    error.exposure = exposure;
    error
}

/// What the frame that ended a run with a failure says of the failure, beyond its Connect code.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Refusal {
    /// A failure of the provider behind the service.
    pub provider: bool,
    /// The model id asked for is not one the service knows.
    pub model: bool,
    /// A limit of the account's plan.
    pub quota: bool,
    /// A bare `resource_exhausted` rejection without plan/quota details or a distinct structured error code.
    pub bare_resource_exhausted: bool,
}

impl Refusal {
    fn of(payload: &[u8]) -> Self {
        let parsed: Value = serde_json::from_slice(payload).unwrap_or_default();
        let code = parsed.pointer("/error/code").and_then(Value::as_str).unwrap_or_default().to_ascii_lowercase();
        let detail = parsed.pointer("/error/message").and_then(Value::as_str).unwrap_or_default();
        let structured = decode_structured_error(&parsed);
        let structured_code = structured.as_ref().and_then(|s| s.code);
        let provider = structured_code == Some(57);
        let model = structured_code == Some(5) || (code == "not_found" && detail.to_ascii_lowercase().contains("model"));
        let quota = structured_code.is_some_and(is_plan_limit_code)
            || QUOTA_WORDING.is_match(detail)
            || structured.as_ref().is_some_and(|s| QUOTA_WORDING.is_match(&s.title) || QUOTA_WORDING.is_match(&s.detail));
        let too_large = code == "resource_exhausted" && !THROTTLE_CUE.is_match(detail) && REQUEST_TOO_LARGE.is_match(detail);
        let non_retryable = structured.as_ref().is_some_and(|s| s.is_retryable == Some(false));
        let bare_resource_exhausted = !quota
            && !provider
            && !too_large
            && !non_retryable
            && ((code == "resource_exhausted" && structured_code.is_none_or(|c| c == 41)) || structured_code == Some(41));
        Self { provider, model, quota, bare_resource_exhausted }
    }
}

impl WireDecoder for CursorDecoder {
    fn feed(&mut self, unit: &[u8]) -> Result<Vec<StreamEvent>, ProviderError> {
        let frames = self.frames.push(unit).map_err(|e| {
            let mut error = ProviderError::new(ErrorKind::Unknown, DeliveryState::Accepted);
            error.code = Some("protocol_error".to_owned());
            error.message = format!("Cursor frame exceeds {} bytes", e.max);
            error
        })?;
        self.waiting.extend(frames);
        // Bytes of a frame that is still arriving are no quiet stretch, whatever the frame turns out to be.
        self.stirred |= !unit.is_empty() && self.frames.buffered() > 0;
        let mut events = Vec::new();
        while !self.terminal {
            let Some(frame) = self.waiting.pop_front() else { break };
            if frame.is_compressed() {
                let mut error = ProviderError::new(ErrorKind::Unknown, DeliveryState::Accepted);
                error.code = Some("protocol_error".to_owned());
                error.message = "Cursor returned an unsupported compressed frame".to_owned();
                return Err(error);
            }
            if frame.flags & !crate::providers::connect::frame::END_STREAM != 0 {
                let mut error = ProviderError::new(ErrorKind::Unknown, DeliveryState::Accepted);
                error.code = Some("protocol_error".to_owned());
                error.message = format!("Cursor returned unsupported frame flags: {}", frame.flags);
                return Err(error);
            }
            if frame.is_end_stream() {
                let failure = if self.can_complete_on_cut() { None } else { self.end_stream_error(&frame.payload) };
                // An end frame that fails the run is read at the head of a feed: the events decoded before it reach the
                // caller first, and the next `feed` of nothing reads it ([`Self::has_waiting`]).
                if !events.is_empty() && (failure.is_some() || (self.pending.is_empty() && !self.saw_turn_ended && !self.can_finalize_without_turn_ended())) {
                    self.waiting.push_front(frame);
                    return Ok(events);
                }
                self.saw_end = true;
                if let Some(mut error) = failure {
                    self.refusal = Refusal::of(&frame.payload);
                    error.exposure = self.exposure;
                    return Err(error);
                }
                if !self.pending.is_empty() || self.saw_turn_ended || self.can_finalize_without_turn_ended() {
                    events.extend(self.finalize());
                    return Ok(events);
                }
                return Err(self.incomplete("Cursor stream ended before turnEnded"));
            }
            let announced = self.pending.len();
            self.heartbeat_only = false;
            self.message(&frame.payload, &mut events)?;
            self.stirred |= !self.heartbeat_only;
            // Each announced call is one chat chunk with `tool_calls` in Node's stream sink (`cursor-wire-stream-messages.mjs`).
            events.extend((announced..self.pending.len()).map(|_| StreamEvent::Progress(ProgressKind::Tool)));
            // Every tool request the service listed for the step has arrived: the step's calls are the batch, and the
            // service sends nothing more of the step before it has their results.
            if self.listed.is_some_and(|listed| self.step_execs.len() as u64 >= listed) {
                self.next_step();
                if !self.pending.is_empty() {
                    events.extend(self.finalize());
                }
            }
        }
        Ok(events)
    }

    fn finish(&mut self) -> Result<Vec<StreamEvent>, ProviderError> {
        if self.terminal {
            return Ok(Vec::new());
        }
        // A close after turnEnded or after the final text step lost only
        // trailing metadata (such as a repeat checkpoint), even if cut
        // partway through a trailing frame.
        if self.saw_turn_ended || self.can_finalize_without_turn_ended() {
            return Ok(self.finalize());
        }
        if self.frames.buffered() > 0 {
            return Err(self.incomplete("Cursor stream ended with a truncated frame"));
        }
        // Tool calls already announced stay actionable even if the transport
        // vanished.
        if !self.pending.is_empty() {
            return Ok(self.finalize());
        }
        if !self.saw_end {
            return Err(self.incomplete("Cursor stream closed before its end frame"));
        }
        Ok(self.finalize())
    }

    fn terminal_seen(&self) -> bool {
        self.terminal
    }

    fn exposure(&self) -> Exposure {
        self.exposure
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A pinned suffix id's catalog model rides the terminal event, not the usage.
    #[test]
    fn the_pricing_model_rides_the_completed_event() {
        let mut decoder = CursorDecoder::new(BlobStore::default(), Vec::new(), None).with_pricing_model(Some("zen-3".to_owned()));
        let events = decoder.finalize();
        assert!(matches!(
            events.last(),
            Some(StreamEvent::Completed { pricing_model: Some(model), .. }) if model == "zen-3"
        ));
        assert!(events.iter().all(|e| !matches!(e, StreamEvent::Usage(u) if u.raw.as_ref().is_some_and(|r| r.get("pricingModel").is_some()))));
    }

    fn frame_of(build: impl FnOnce(&mut crate::providers::connect::pb::Writer)) -> Vec<u8> {
        let mut message = crate::providers::connect::pb::Writer::new();
        build(&mut message);
        crate::providers::connect::frame::encode(&message.finish(), 0)
    }

    /// Exec `n`, a `lookup` of `argument` under the parent call `call`.
    fn exec_under(n: u64, call: &str, argument: &str) -> Vec<u8> {
        exec_of(n, "lookup", call, argument)
    }

    /// Exec `n`, a call of the MCP tool `tool`.
    fn exec_of(n: u64, tool: &str, call: &str, argument: &str) -> Vec<u8> {
        use crate::providers::connect::pb::Writer;
        frame_of(|m| {
            let mut entry = Writer::new();
            entry.string(1, "key");
            entry.bytes(2, &super::super::schema::encode_json_value(&json!(argument)));
            let mut mcp = Writer::new();
            mcp.string(1, tool);
            mcp.message(2, entry);
            mcp.string(3, call);
            mcp.string(5, tool);
            let mut exec = Writer::new();
            exec.varint(1, n);
            exec.message(11, mcp);
            exec.string(15, &format!("exec-{n}"));
            m.message(2, exec);
        })
    }

    fn mcp_call(n: u64, argument: &str) -> Vec<u8> {
        exec_under(n, &format!("call-{n}"), argument)
    }

    fn update(field: u32, body: impl FnOnce(&mut crate::providers::connect::pb::Writer)) -> Vec<u8> {
        use crate::providers::connect::pb::Writer;
        frame_of(|m| {
            let mut inner = Writer::new();
            body(&mut inner);
            let mut update = Writer::new();
            update.message(field, inner);
            m.message(1, update);
        })
    }

    fn lookup_decoder() -> CursorDecoder {
        let tool = McpToolDefinition {
            name: "lookup".into(),
            description: String::new(),
            input_schema: json!({"type": "object"}),
            provider_identifier: "mixdog".into(),
        };
        CursorDecoder::new(BlobStore::default(), vec![tool], None)
    }

    /// A request whose transcript holds the result `stored <id>` of each call in `ids`.
    fn answered(ids: &[&str]) -> Arc<ModelRequest> {
        let results = ids.iter().map(|id| {
            let mut result = Message::new(Role::Tool, Content::Text(format!("stored {id}").into()));
            result.tool_call_id = Some((*id).to_owned());
            result
        });
        Arc::new(ModelRequest { model: "m".into(), messages: results.collect(), tools: Vec::new(), options: Default::default() })
    }

    /// The calls among `events`; an id the decoder minted reads `fresh`.
    fn calls_of(events: &[StreamEvent]) -> Vec<(String, Value)> {
        let own = |id: &str| if id.starts_with("call-") { id.to_owned() } else { "fresh".to_owned() };
        events.iter().filter_map(|e| if let StreamEvent::ToolCallDone(call) = e { Some((own(&call.id), call.arguments.clone())) } else { None }).collect()
    }

    /// Every way the test cuts `frames` into chunks: one chunk, a chunk per frame, chunks of a few fixed sizes down to
    /// one byte, and (for a short stream) every cut in two.
    fn cuts(frames: &[Vec<u8>]) -> Vec<Vec<Vec<u8>>> {
        let whole: Vec<u8> = frames.concat();
        let mut all = vec![vec![whole.clone()], frames.to_vec()];
        all.extend([1, 2, 3, 7, 64, 4096].map(|size| whole.chunks(size).map(<[u8]>::to_vec).collect()));
        if whole.len() < 2_000 {
            all.extend((1..whole.len()).map(|at| vec![whole[..at].to_vec(), whole[at..].to_vec()]));
        }
        all
    }

    /// What a run handed over: its batches in order, how many of them the quiet point ended, and how many messages the
    /// decoder wrote back on its own.
    #[derive(Debug, PartialEq)]
    struct Handed {
        batches: Vec<Vec<(String, Value)>>,
        at_quiet: usize,
        written: usize,
    }

    /// Reads `stretches` in order, each a stretch of chunks with a quiet point behind it; every batch is followed by its
    /// results being written back and the run going on.
    fn handed(stretches: &[Vec<Vec<u8>>]) -> Handed {
        let mut decoder = lookup_decoder();
        decoder.attend(answered(&["call-1", "call-2", "call-3"]));
        let mut out = Handed { batches: Vec::new(), at_quiet: 0, written: 0 };
        let go_on = |decoder: &mut CursorDecoder, mut events: Vec<StreamEvent>, out: &mut Handed| {
            while decoder.terminal_seen() {
                out.batches.push(calls_of(&events));
                decoder.resume();
                events = decoder.feed(&[]).expect("decodes");
            }
            decoder.caught_up();
            assert!(calls_of(&events).is_empty(), "a call outside a batch");
            out.written += decoder.take_outbound().len();
        };
        for stretch in stretches {
            for piece in stretch {
                let events = decoder.feed(piece).expect("decodes");
                go_on(&mut decoder, events, &mut out);
            }
            let events = decoder.quiet();
            out.at_quiet += usize::from(decoder.terminal_seen());
            go_on(&mut decoder, events, &mut out);
        }
        assert!(decoder.pending.is_empty() && !decoder.has_waiting(), "a call or a frame is still held back");
        out
    }

    /// The tool requests listed for a step.
    fn listing(count: u64) -> Vec<u8> {
        update(27, |l| l.varint(1, count))
    }

    fn call(id: &str, key: &str) -> (String, Value) {
        (id.to_owned(), json!({"key": key}))
    }

    /// A step's calls are one batch, handed over by the frame with which the execs received reach the count the service
    /// listed, for every cut of the same frames: the listing first, between the execs (as the service sends it for
    /// parallel calls) or after them, with a checkpoint, text or a heartbeat anywhere, an exec this side answers itself
    /// counted, a second exec under one parent call given an id of its own, and the next step's frames in the same
    /// chunk left for the next batch. No such batch waits for a quiet point.
    #[test]
    fn a_listed_step_is_one_batch_for_every_cut_of_the_same_frames() {
        let checkpoint = frame_of(|m| m.bytes(3, &[]));
        let heartbeat = update(13, |_| {});
        let text = update(1, |t| t.string(1, "Looking it up."));
        let long = "x".repeat(20_000);
        // An exec no tool serves: it is answered here, and is one of the step's requests.
        let unserved = frame_of(|m| {
            let mut exec = crate::providers::connect::pb::Writer::new();
            exec.varint(1, 9);
            exec.message(99, crate::providers::connect::pb::Writer::new());
            m.message(2, exec);
        });
        let three = vec![vec![call("call-1", "a"), call("call-2", "b"), call("call-3", "c")]];
        let sequences: Vec<(Vec<Vec<u8>>, Vec<Vec<(String, Value)>>, usize)> = vec![
            (vec![mcp_call(1, "a"), mcp_call(2, "b"), listing(3), mcp_call(3, "c")], three.clone(), 0),
            (
                vec![text.clone(), mcp_call(1, "a"), heartbeat.clone(), mcp_call(2, "b"), listing(3), checkpoint.clone(), mcp_call(3, "c"), checkpoint.clone()],
                three.clone(),
                0,
            ),
            (vec![listing(3), mcp_call(1, "a"), mcp_call(2, "b"), mcp_call(3, "c")], three.clone(), 0),
            (vec![mcp_call(1, "a"), mcp_call(2, "b"), mcp_call(3, "c"), heartbeat, listing(3)], three, 0),
            (vec![listing(1), checkpoint.clone(), mcp_call(1, "a")], vec![vec![call("call-1", "a")]], 0),
            (vec![listing(1), text, mcp_call(1, &long), checkpoint.clone()], vec![vec![call("call-1", &long)]], 0),
            (vec![listing(1), mcp_call(1, "a"), checkpoint, listing(1), mcp_call(2, "b")], vec![vec![call("call-1", "a")], vec![call("call-2", "b")]], 0),
            (vec![listing(2), exec_under(1, "call-1", "a"), exec_under(2, "call-1", "b")], vec![vec![call("call-1", "a"), call("fresh", "b")]], 0),
            (vec![unserved.clone(), listing(2), mcp_call(1, "a")], vec![vec![call("call-1", "a")]], 2),
            (vec![listing(1), unserved, listing(1), mcp_call(1, "a")], vec![vec![call("call-1", "a")]], 2),
        ];
        for (index, (frames, batches, written)) in sequences.iter().enumerate() {
            for pieces in cuts(frames) {
                let cut = pieces.len();
                assert_eq!(handed(&[pieces]), Handed { batches: batches.clone(), at_quiet: 0, written: *written }, "sequence {index} cut into {cut} chunks");
            }
        }
    }

    /// A step the service did not list is handed over at the quiet point, and an exec of it that arrives later is the
    /// next batch; a listing that arrives later counts the execs already answered. The batches are the same for every
    /// cut of the frames between the same quiet points.
    #[test]
    fn an_unlisted_step_is_handed_over_at_the_quiet_point() {
        let heartbeat = update(13, |_| {});
        let one = |n: u64, key: &str| vec![call(&format!("call-{n}"), key)];
        let sequences: Vec<(Vec<Vec<Vec<u8>>>, Vec<Vec<(String, Value)>>, usize)> = vec![
            (vec![vec![mcp_call(1, "a")]], vec![one(1, "a")], 1),
            (vec![vec![mcp_call(1, "a"), heartbeat.clone(), mcp_call(2, "b")]], vec![vec![call("call-1", "a"), call("call-2", "b")]], 1),
            (vec![vec![mcp_call(1, "a")], vec![heartbeat.clone(), mcp_call(2, "b")]], vec![one(1, "a"), one(2, "b")], 2),
            // The first call's result was written back: a listing behind it is another step's, and counts what follows.
            (vec![vec![mcp_call(1, "a")], vec![mcp_call(2, "b"), listing(2)]], vec![one(1, "a"), one(2, "b")], 2),
            (
                vec![vec![mcp_call(1, "a")], vec![listing(2), mcp_call(2, "b"), heartbeat.clone(), mcp_call(3, "c")]],
                vec![one(1, "a"), vec![call("call-2", "b"), call("call-3", "c")]],
                1,
            ),
            (
                vec![vec![listing(3), mcp_call(1, "a"), heartbeat, mcp_call(2, "b")], vec![listing(1), mcp_call(3, "c")]],
                vec![vec![call("call-1", "a"), call("call-2", "b")], one(3, "c")],
                1,
            ),
        ];
        for (index, (stretches, batches, at_quiet)) in sequences.iter().enumerate() {
            let styles: Vec<Vec<Vec<Vec<u8>>>> = stretches.iter().map(|frames| cuts(frames)).collect();
            for style in 0..8 {
                let cut: Vec<Vec<Vec<u8>>> = styles.iter().map(|of_stretch| of_stretch[style].clone()).collect();
                assert_eq!(handed(&cut), Handed { batches: batches.clone(), at_quiet: *at_quiet, written: 0 }, "sequence {index}, cut style {style}");
            }
        }
        let mut decoder = lookup_decoder();
        decoder.feed(&mcp_call(1, "a")).expect("decodes");
        assert!(decoder.take_stir() && decoder.awaits_quiet(), "the call starts the quiet stretch");
        decoder.feed(&update(13, |_| {})).expect("decodes");
        assert!(!decoder.take_stir(), "a heartbeat does not start it over");
        decoder.feed(&frame_of(|m| m.bytes(3, &[]))).expect("decodes");
        assert!(decoder.take_stir(), "any other frame does");
        // A frame that takes its time: every piece of it is the service still sending, whole frame or not.
        let slow = mcp_call(2, &"x".repeat(4_000));
        for piece in slow.chunks(1_000) {
            assert!(decoder.feed(piece).expect("decodes").iter().all(|e| !matches!(e, StreamEvent::ToolCallDone(_))));
            assert!(decoder.take_stir(), "bytes of an unfinished frame start the quiet stretch over");
        }
        assert_eq!(calls_of(&decoder.quiet()).len(), 2, "the two calls are one batch");
    }

    /// A step's count and its execs end with the step, however it was handed over. A step listed for more execs than
    /// arrived, or not listed at all, is handed over at the quiet point; once its results are written back the next
    /// step's listing counts the next step's execs only, and that step is one batch with no wait. A listing that
    /// arrived before the results were written was the handed-over step's and still counts its execs.
    #[test]
    fn a_step_handed_over_at_the_quiet_point_leaves_no_count_to_the_next() {
        let first: [(&str, Vec<Vec<u8>>, usize); 2] =
            [("listed for more than arrived", vec![listing(3), mcp_call(1, "a"), mcp_call(2, "b")], 2), ("not listed", vec![mcp_call(1, "a")], 1)];
        for (step, frames, expected) in first {
            let mut decoder = lookup_decoder();
            decoder.attend(answered(&["call-1", "call-2"]));
            assert!(calls_of(&decoder.feed(&frames.concat()).expect("decodes")).is_empty(), "{step}: waits for the quiet point");
            assert_eq!(calls_of(&decoder.quiet()).len(), expected, "{step}");
            decoder.resume();
            assert!(decoder.feed(&[]).expect("decodes").is_empty());
            decoder.caught_up();
            let next = decoder.feed(&[listing(2), mcp_call(7, "g")].concat()).expect("decodes");
            assert!(calls_of(&next).is_empty() && !decoder.terminal_seen(), "{step}: the next step's first exec is not its batch");
            let next = decoder.feed(&mcp_call(8, "h")).expect("decodes");
            assert_eq!(calls_of(&next), vec![call("call-7", "g"), call("call-8", "h")], "{step}: the next step is one batch");
            assert!(decoder.terminal_seen(), "{step}: handed over with its last exec, at no quiet point");
        }

        let mut decoder = lookup_decoder();
        decoder.attend(answered(&["call-1", "call-2"]));
        decoder.feed(&[mcp_call(1, "a"), mcp_call(2, "b")].concat()).expect("decodes");
        assert_eq!(calls_of(&decoder.quiet()).len(), 2);
        // The listing and the step's third exec arrive while the two calls run.
        assert!(decoder.feed(&[listing(3), mcp_call(3, "c")].concat()).expect("decodes").is_empty(), "frames behind a batch wait");
        decoder.resume();
        assert_eq!(calls_of(&decoder.feed(&[]).expect("decodes")), vec![call("call-3", "c")], "the late listing counted the two execs handed over");
        assert!(decoder.terminal_seen());
    }

    /// The context size a batch reports is the run's latest checkpoint size: a batch that received no checkpoint of
    /// its own reports the one an earlier batch was given, and a run that has had none reports none.
    #[test]
    fn a_batch_without_a_checkpoint_reports_the_runs_latest_size() {
        let size_of = |events: &[StreamEvent]| {
            let usage = events.iter().find_map(|e| if let StreamEvent::Usage(usage) = e { Some(usage.clone()) } else { None }).expect("usage");
            usage.raw.expect("raw")["context_tokens"].clone()
        };
        let checkpoint = frame_of(|m| {
            let mut details = crate::providers::connect::pb::Writer::new();
            details.varint(1, 8_000);
            let mut state = crate::providers::connect::pb::Writer::new();
            state.message(5, details);
            m.message(3, state);
        });
        let mut decoder = lookup_decoder();
        let before = decoder.feed(&[listing(1), mcp_call(1, "a")].concat()).expect("decodes");
        assert_eq!(size_of(&before), Value::Null, "no checkpoint yet");
        decoder.resume();
        let first = decoder.feed(&[checkpoint, listing(1), mcp_call(2, "b")].concat()).expect("decodes");
        assert_eq!(size_of(&first), json!(8_000));
        decoder.resume();
        let second = decoder.feed(&[listing(1), mcp_call(3, "c")].concat()).expect("decodes");
        assert_eq!(size_of(&second), json!(8_000), "the size of the step before, not none");
    }

    /// An exec sent again is the exec it was, whether a call was recorded for it or this side answered it (a tool that
    /// does not exist): the step's count is not reached by it.
    #[test]
    fn an_exec_sent_again_is_counted_once() {
        let mut decoder = lookup_decoder();
        let unknown = exec_of(9, "no_such_tool", "call-9", "z");
        let events = decoder.feed(&[listing(2), unknown.clone(), unknown].concat()).expect("decodes");
        assert!(calls_of(&events).is_empty());
        assert_eq!(decoder.take_outbound().len(), 2, "each is answered");
        let events = decoder.feed(&mcp_call(1, "a")).expect("decodes");
        assert_eq!(calls_of(&events), vec![call("call-1", "a")]);
        assert!(decoder.terminal_seen(), "the second exec of the two listed ends the step, with no quiet point");
    }

    /// The end frame's detail names a failure of the provider behind the service, readable or encoded.
    #[test]
    fn an_end_frame_can_name_the_providers_own_failure() {
        use base64::Engine;
        let mut detail = crate::providers::connect::pb::Writer::new();
        detail.varint(1, 57);
        let encoded = base64::engine::general_purpose::STANDARD.encode(detail.finish());
        let readable = json!({"error": {"code": "unavailable", "message": "Error", "details": [{"type": "aiserver.v1.ErrorDetails", "debug": {"error": "ERROR_PROVIDER_ERROR"}}]}});
        let bare = json!({"error": {"code": "unavailable", "message": "Error", "details": [{"type": "aiserver.v1.ErrorDetails", "value": encoded}]}});
        let other = json!({"error": {"code": "resource_exhausted", "message": "Error", "details": [{"type": "aiserver.v1.ErrorDetails", "debug": {"error": "ERROR_RATE_LIMITED"}}]}});
        for (payload, named) in [(readable, true), (bare, true), (other, false)] {
            let mut decoder = lookup_decoder();
            let end = crate::providers::connect::frame::encode(payload.to_string().as_bytes(), crate::providers::connect::frame::END_STREAM);
            decoder.feed(&end).expect_err("the run failed");
            assert_eq!((decoder.refusal().provider, decoder.silent()), (named, true), "{payload}");
        }
        // The same code in a detail of another type says nothing of the service's failure.
        let foreign = json!({"error": {"code": "unavailable", "message": "Error", "details": [{"type": "google.rpc.RetryInfo", "debug": {"error": "ERROR_PROVIDER_ERROR"}}]}});
        assert!(!Refusal::of(foreign.to_string().as_bytes()).provider);
        // A model the service does not know, and a limit of the account, by code or by wording.
        let says = |code: &str, message: &str, named: &str| {
            Refusal::of(
                json!({"error": {"code": code, "message": message, "details": [{"type": "aiserver.v1.ErrorDetails", "debug": {"error": named}}]}})
                    .to_string()
                    .as_bytes(),
            )
        };
        assert!(says("not_found", "Error", "ERROR_BAD_MODEL_NAME").model && says("not_found", "Model x was not found", "ERROR_NOT_FOUND").model);
        assert!(!says("not_found", "Conversation not found", "ERROR_NOT_FOUND").model, "a not-found of something else");
        assert!(
            says("resource_exhausted", "Error", "ERROR_PRO_USER_USAGE_LIMIT").quota
                && says("resource_exhausted", "You have hit your usage limit", "ERROR_RESOURCE_EXHAUSTED").quota
        );
        assert!(!says("resource_exhausted", "Error", "ERROR_RESOURCE_EXHAUSTED").quota, "a bare throttle");

        // Text shown with no token counted, in a batch before the one that fails, is something shown.
        let mut decoder = lookup_decoder();
        decoder.feed(&[update(1, |t| t.string(1, "working on it")), listing(1), mcp_call(1, "a")].concat()).expect("decodes");
        decoder.resume();
        assert!(!decoder.silent());
    }

    /// A run that fails in the chunk that carried its text hands that text out first, and the failure that says it was shown
    /// follows it.
    #[test]
    fn a_failing_end_frame_follows_the_text_of_its_chunk() {
        let mut decoder = lookup_decoder();
        let end =
            crate::providers::connect::frame::encode(br#"{"error":{"code":"unavailable","message":"Error"}}"#, crate::providers::connect::frame::END_STREAM);
        let shown = decoder.feed(&[update(1, |t| t.string(1, "working on it")), end].concat()).expect("the text before the end frame");
        assert!(shown.contains(&StreamEvent::TextDelta("working on it".into())));
        assert!(decoder.has_waiting(), "the end frame is read next");
        let failure = decoder.feed(&[]).expect_err("the run failed");
        assert!(failure.exposure.text_emitted && failure.message.contains("unavailable"), "{}", failure.message);
    }

    /// An exec the service sends again after its result was written back is answered at once and never handed over
    /// twice: with the result the transcript holds, and with a failure when the transcript no longer holds it.
    #[test]
    fn an_exec_sent_again_is_always_answered() {
        for (kept, expected) in [(true, "stored call-1"), (false, RESULT_GONE)] {
            let mut decoder = lookup_decoder();
            decoder.attend(answered(if kept { &["call-1"][..] } else { &[][..] }));
            let first = decoder.feed(&[listing(1), mcp_call(1, "a")].concat()).expect("decodes");
            assert_eq!(calls_of(&first), vec![call("call-1", "a")]);
            assert!(decoder.feed(&mcp_call(1, "a")).expect("decodes").is_empty(), "frames behind a batch wait");
            assert!(decoder.take_outbound().is_empty(), "an exec still running is answered when it ends");
            decoder.resume();
            let again = decoder.feed(&mcp_call(1, "a")).expect("decodes");
            assert!(calls_of(&again).is_empty() && !decoder.awaits_quiet(), "kept {kept}: not a call again");
            let written = decoder.take_outbound();
            assert_eq!(written.len(), 2, "kept {kept}: each exec sent again is answered");
            assert!(written.iter().all(|message| String::from_utf8_lossy(message).contains(expected)), "kept {kept}");
        }
    }

    /// The fields of `bytes` as `(number, bytes, value)`.
    fn fields(bytes: &[u8]) -> Vec<(u32, Vec<u8>, u64)> {
        let mut reader = crate::providers::connect::pb::Reader::new(bytes);
        std::iter::from_fn(|| reader.next_field().ok().flatten()).map(|(n, v)| (n, v.bytes().to_vec(), v.as_u64())).collect()
    }

    /// The first field at `path` of field numbers inside `bytes`.
    fn at(bytes: &[u8], path: &[u32]) -> Option<(Vec<u8>, u64)> {
        let (last, parents) = path.split_last()?;
        let mut current = bytes.to_vec();
        for wanted in parents {
            current = fields(&current).into_iter().find(|(n, _, _)| n == wanted)?.1;
        }
        fields(&current).into_iter().find(|(n, _, _)| n == last).map(|(_, bytes, value)| (bytes, value))
    }

    /// A native exec whose case `field` holds `args`.
    fn native(n: u64, field: u32, args: impl FnOnce(&mut crate::providers::connect::pb::Writer)) -> Vec<u8> {
        frame_of(|m| {
            let mut body = crate::providers::connect::pb::Writer::new();
            args(&mut body);
            let mut exec = crate::providers::connect::pb::Writer::new();
            exec.varint(1, n);
            exec.message(field, body);
            exec.string(15, &format!("exec-{n}"));
            m.message(2, exec);
        })
    }

    fn native_decoder() -> CursorDecoder {
        let tool = |name: &str| McpToolDefinition {
            name: name.into(),
            description: String::new(),
            input_schema: json!({"type": "object"}),
            provider_identifier: "mixdog".into(),
        };
        CursorDecoder::new(BlobStore::default(), vec![tool("grep"), tool("read")], None)
    }

    /// The update that ends the turn says what the turn used: the step that ends it reports the input, the cache split
    /// and the reasoning count, and of the output what the batches before it had not yet reported.
    #[test]
    fn the_turn_reports_what_the_turn_ended_update_says_it_used() {
        let usage_of =
            |events: &[StreamEvent]| events.iter().find_map(|e| if let StreamEvent::Usage(usage) = e { Some(usage.clone()) } else { None }).expect("usage");
        let mut decoder = lookup_decoder();
        let first = decoder.feed(&[update(8, |t| t.varint(1, 5)), listing(1), mcp_call(1, "a")].concat()).expect("decodes");
        let streamed = usage_of(&first);
        assert_eq!((streamed.input_tokens, streamed.output_tokens), (0, 5));
        assert_eq!(streamed.raw.as_ref().and_then(|raw| raw.get("input_tokens_known")), Some(&json!(false)));
        decoder.resume();
        let ended = frame_of(|m| {
            let mut turn = crate::providers::connect::pb::Writer::new();
            for (field, count) in [(1, 100), (2, 9), (3, 40), (4, 6), (5, 3)] {
                turn.varint(field, count);
            }
            let mut update = crate::providers::connect::pb::Writer::new();
            update.message(14, turn);
            m.message(1, update);
        });
        let end = crate::providers::connect::frame::encode(b"{}", crate::providers::connect::frame::END_STREAM);
        let last = decoder.feed(&[update(8, |t| t.varint(1, 4)), ended, end].concat()).expect("decodes");
        let turn = usage_of(&last);
        assert_eq!((turn.input_tokens, turn.output_tokens, turn.cache_read_tokens, turn.cache_write_tokens, turn.reasoning_tokens), (100, 4, 40, 6, Some(3)));
        assert_eq!(turn.raw.as_ref().and_then(|raw| raw.get("input_tokens_known")), Some(&json!(true)));
    }

    /// What this side answers on its own: a throw is followed by the close of its exec's stream; a hosted search or
    /// fetch and the interactions of a person are refused; a query of an unknown kind, which has no answer, ends the
    /// turn; a search with a glob and no pattern is refused with where to go instead.
    #[test]
    fn the_execs_and_queries_answered_here() {
        let mut decoder = native_decoder();
        // The state of the client's MCP servers is the tools this side offers, under the server they are offered as,
        // so the model's step is not spent on a failure; it is a tool request of its step like any other.
        assert!(decoder.feed(&[listing(1), native(6, 36, |_| {})].concat()).expect("decodes").is_empty());
        let state = decoder.take_outbound();
        assert_eq!(state.len(), 1);
        let server = at(&state[0], &[2, 36, 1, 1]).map(|(bytes, _)| bytes).expect("a server");
        assert_eq!(at(&server, &[2]).map(|(bytes, _)| bytes), Some(b"mixdog".to_vec()));
        assert_eq!(at(&server, &[7]).map(|(bytes, _)| bytes), Some(b"connected".to_vec()));
        assert!(at(&server, &[5, 1]).is_some(), "its tools");
        assert_eq!(decoder.listed, None, "the step's one request is in");

        decoder.feed(&native(7, 99, |_| {})).expect("decodes");
        let thrown = decoder.take_outbound();
        assert_eq!(thrown.len(), 2);
        assert!(at(&thrown[0], &[5, 2]).is_some(), "the throw");
        assert_eq!(at(&thrown[1], &[5, 1, 1]).map(|(_, id)| id), Some(7), "then the close of exec 7");

        let query = |id: u64, kind: u32| {
            frame_of(|m| {
                let mut query = crate::providers::connect::pb::Writer::new();
                query.varint(1, id);
                query.message(kind, crate::providers::connect::pb::Writer::new());
                m.message(7, query);
            })
        };
        for kind in [2, 5, 6, 9, 4] {
            decoder.feed(&query(3, kind)).expect("decodes");
            let answered = decoder.take_outbound();
            assert_eq!(answered.len(), 1);
            assert!(at(&answered[0], &[6, kind, 1]).is_none() && at(&answered[0], &[6, kind, 2]).is_some(), "query {kind} refused");
        }
        let unknown = decoder.feed(&query(4, 31)).expect_err("a query that cannot be answered ends the turn");
        assert_eq!(unknown.code.as_deref(), Some("protocol_drift"));
        assert!(decoder.take_outbound().is_empty());

        // A window that starts further before the file's end than the read tool reads is answered here, as no window.
        decoder
            .feed(&native(9, 7, |a| {
                a.string(1, "a.txt");
                a.varint(4, (-200_000_i64) as u64);
            }))
            .expect("decodes");
        let no_window = decoder.take_outbound();
        assert_eq!(no_window.len(), 1);
        assert!(at(&no_window[0], &[2, 7, 3]).is_some(), "the read's failure");
        assert!(decoder.pending.is_empty());

        decoder.feed(&native(8, 5, |a| a.string(3, "*.rs"))).expect("decodes");
        let refused = decoder.take_outbound();
        assert!(String::from_utf8_lossy(&at(&refused[0], &[2, 5, 2]).expect("the search's error").0).contains("needs a pattern"));
        assert!(!decoder.awaits_quiet(), "no call was made of it");
    }

    /// A native search skips what the request's offset says, and a native read with a negative offset reads from the
    /// file's end.
    #[test]
    fn an_offset_reaches_the_tool_that_serves_the_exec() {
        let mut decoder = native_decoder();
        let grep = native(1, 5, |a| {
            a.string(1, "fox");
            a.varint(16, 20);
        });
        let read = native(2, 7, |a| {
            a.string(1, "a.txt");
            a.varint(4, (-30i64) as u64);
            a.varint(5, 10);
        });
        let events = decoder.feed(&[listing(2), grep, read].concat()).expect("decodes");
        let arguments: Vec<Value> =
            events.iter().filter_map(|e| if let StreamEvent::ToolCallDone(call) = e { Some(call.arguments.clone()) } else { None }).collect();
        assert_eq!(arguments[0].get("offset"), Some(&json!(20)));
        // The tail is read whole (the read tool lets a tail override a limit); the answer keeps the ten rows asked for.
        assert_eq!((arguments[1].get("tail"), arguments[1].get("offset"), arguments[1].get("limit")), (Some(&json!(30)), None, None));
    }

    /// A call recovered from the text of one batch says nothing about the next: a later exec of the same tool with the
    /// same arguments is a call of its own.
    #[test]
    fn a_recovered_call_of_one_batch_does_not_hide_a_call_of_the_next() {
        let mut decoder = lookup_decoder().with_known_tools(["lookup".to_owned()].into());
        let leaked = r#"<invoke name="lookup"><parameter name="key">a</parameter></invoke>"#;
        let mut first = decoder.feed(&update(1, |t| t.string(1, leaked))).expect("decodes");
        first.extend(decoder.feed(&[listing(1), mcp_call(1, "b")].concat()).expect("decodes"));
        assert_eq!(first.iter().filter(|e| matches!(e, StreamEvent::ToolCallDone(_))).count(), 2, "{first:?}");
        decoder.resume();
        let second = decoder.feed(&[listing(1), mcp_call(2, "a")].concat()).expect("decodes");
        assert_eq!(calls_of(&second), vec![call("call-2", "a")]);
    }

    /// Token deltas with nothing to show are the model working; the service's heartbeat is liveness and no event.
    #[test]
    fn a_token_delta_is_progress_and_a_heartbeat_is_only_liveness() {
        let mut decoder = lookup_decoder();
        let events = decoder.feed(&update(8, |t| t.varint(1, 12))).unwrap();
        assert_eq!(events, vec![StreamEvent::Progress(ProgressKind::Semantic)]);
        assert!(!decoder.take_liveness());
        assert_eq!(decoder.feed(&update(13, |_| {})).unwrap(), Vec::new());
        assert!(decoder.take_liveness());
        assert!(!decoder.take_liveness(), "taken once");
    }

    #[test]
    fn think_tags_split_reasoning_from_content() {
        let mut f = ThinkFilter::default();
        assert_eq!(f.process("a<think>b</think>c"), ("ac".into(), "b".into()));
    }

    #[test]
    fn partial_tag_is_held_until_it_completes() {
        let mut f = ThinkFilter::default();
        assert_eq!(f.process("hi <thi"), ("hi ".into(), String::new()));
        assert_eq!(f.process("nk>x"), (String::new(), "x".into()));
        assert_eq!(f.flush(), (String::new(), String::new()));
    }

    #[test]
    fn non_tag_angle_brackets_pass_through() {
        let mut f = ThinkFilter::default();
        assert_eq!(f.process("a < b <c> d"), ("a < b <c> d".into(), String::new()));
    }

    #[test]
    fn tag_names_match_case_insensitively_with_space() {
        let mut f = ThinkFilter::default();
        assert_eq!(f.process("<THINKING >z</Thinking>"), (String::new(), "z".into()));
    }

    fn exec_abort_frame(id: u64) -> Vec<u8> {
        use crate::providers::connect::pb::Writer;
        frame_of(|m| {
            let mut abort = Writer::new();
            abort.varint(1, id);
            let mut ctrl = Writer::new();
            ctrl.message(1, abort);
            m.message(5, ctrl);
        })
    }

    fn encode_error_details_b64(code: u32, title: &str, detail: &str, is_retryable: Option<bool>) -> String {
        use crate::providers::connect::pb::Writer;
        use base64::Engine;
        let mut custom = Writer::new();
        if !title.is_empty() {
            custom.string(1, title);
        }
        if !detail.is_empty() {
            custom.string(2, detail);
        }
        if let Some(retryable) = is_retryable {
            custom.varint(4, u64::from(retryable));
        }
        let mut err = Writer::new();
        if code != 0 {
            err.varint(1, u64::from(code));
        }
        if !title.is_empty() || !detail.is_empty() || is_retryable.is_some() {
            err.message(2, custom);
        }
        base64::engine::general_purpose::STANDARD.encode(err.finish())
    }

    fn end_stream_with_details(outer_code: &str, outer_msg: &str, type_url: &str, value_b64: &str) -> Vec<u8> {
        let body = json!({
            "error": {
                "code": outer_code,
                "message": outer_msg,
                "details": [{ "type": type_url, "value": value_b64 }]
            }
        });
        crate::providers::connect::frame::encode(body.to_string().as_bytes(), crate::providers::connect::frame::END_STREAM)
    }

    #[test]
    fn exec_abort_drops_matching_pending_exec_without_failing() {
        // Aborting one of two pending execs drops only the aborted one.
        let mut decoder = lookup_decoder();
        assert!(decoder.feed(&[mcp_call(1, "a"), mcp_call(2, "b"), exec_abort_frame(1)].concat()).is_ok());
        // Aborting an unknown id is a clean no-op.
        assert!(decoder.feed(&exec_abort_frame(999)).is_ok());
        let events = decoder.quiet();
        assert_eq!(calls_of(&events), vec![call("call-2", "b")]);

        // Aborting the only pending exec lets the turn finish with text cleanly.
        let mut decoder = lookup_decoder();
        let mut events = decoder
            .feed(
                &[
                    mcp_call(7, "a"),
                    exec_abort_frame(7),
                    update(1, |t| t.string(1, "recovered")),
                    update(14, |_| {}),
                    crate::providers::connect::frame::encode(b"{}", crate::providers::connect::frame::END_STREAM),
                ]
                .concat(),
            )
            .expect("abort does not fail the stream");
        events.extend(decoder.finish().expect("clean finish"));
        assert!(calls_of(&events).is_empty());
        let text: String = events.iter().filter_map(|e| if let StreamEvent::TextDelta(t) = e { Some(t.as_str()) } else { None }).collect();
        assert_eq!(text, "recovered");
        assert!(events.iter().any(|e| matches!(e, StreamEvent::Completed { stop: Some(StopReason::Other(s)), .. } if s == "stop")));
    }

    #[test]
    fn structured_error_details_maps_codes_retryability_and_messages() {
        let feed_err = |frame: Vec<u8>| {
            let mut decoder = lookup_decoder();
            decoder.feed(&frame).expect_err("expected structured error")
        };

        // USER_ABORTED_REQUEST (21) -> canceled, non-retryable 499.
        let err = feed_err(end_stream_with_details(
            "aborted",
            "Error",
            "aiserver.v1.ErrorDetails",
            &encode_error_details_b64(21, "Canceled", "User canceled request", None),
        ));
        assert_eq!(err.status, Some(499));
        assert_eq!(err.code.as_deref(), Some("canceled"));
        assert_eq!(err.should_retry, Some(false));
        assert!(err.message.contains("Canceled: User canceled request"), "{}", err.message);

        // Auth (1, 12), Permission (4), NotFound (5), TooLarge (20, 43), Quota (10), RateLimit (50).
        let cases = [
            (1, "aiserver.v1.ErrorDetails", 401, ErrorKind::Auth),
            (12, "type.googleapis.com/aiserver.v1.ErrorDetails", 401, ErrorKind::Auth),
            (4, "aiserver.v1.ErrorDetails", 403, ErrorKind::Permission),
            (5, "aiserver.v1.ErrorDetails", 404, ErrorKind::InvalidRequest),
            (20, "aiserver.v1.ErrorDetails", 413, ErrorKind::RequestTooLarge),
            (43, "aiserver.v1.ErrorDetails", 413, ErrorKind::RequestTooLarge),
            (10, "aiserver.v1.ErrorDetails", 429, ErrorKind::QuotaExhausted),
            (50, "aiserver.v1.ErrorDetails", 429, ErrorKind::RateLimited),
        ];
        for (code, type_url, status, kind) in cases {
            let err = feed_err(end_stream_with_details("resource_exhausted", "Error", type_url, &encode_error_details_b64(code, "Title", "Body", None)));
            assert_eq!(err.status, Some(status), "code {code}");
            assert_eq!(err.kind, kind, "code {code}");
            assert!(err.message.contains("Title: Body"), "code {code}: {}", err.message);
        }

        // Retryable codes under outer resource_exhausted become transient 503, not 429.
        for code in [13, 25, 55, 56, 57, 59, 63] {
            let err = feed_err(end_stream_with_details(
                "resource_exhausted",
                "Error",
                "aiserver.v1.ErrorDetails",
                &encode_error_details_b64(code, "Transient", "Try again", None),
            ));
            assert_eq!(err.status, Some(503), "code {code}");
            assert_eq!(err.kind, ErrorKind::Transient, "code {code}");
            assert_eq!(err.should_retry, None, "code {code}");
        }

        // Explicit is_retryable=false overrides retryable code to non-retryable 400.
        let err = feed_err(end_stream_with_details(
            "resource_exhausted",
            "Error",
            "aiserver.v1.ErrorDetails",
            &encode_error_details_b64(57, "Provider", "Permanent failure", Some(false)),
        ));
        assert_eq!(err.status, Some(400));
        assert_eq!(err.kind, ErrorKind::InvalidRequest);
        assert_eq!(err.should_retry, Some(false));

        // Explicit is_retryable=true upgrades non-retryable code to transient 503.
        let err = feed_err(end_stream_with_details(
            "resource_exhausted",
            "Error",
            "aiserver.v1.ErrorDetails",
            &encode_error_details_b64(0, "Busy", "Retry shortly", Some(true)),
        ));
        assert_eq!(err.status, Some(503));
        assert_eq!(err.kind, ErrorKind::Transient);

        // JSON debug isRetryable flag and details title/detail.
        let debug_body = json!({
            "error": {
                "code": "resource_exhausted",
                "message": "Error",
                "details": [{
                    "type": "aiserver.v1.ErrorDetails",
                    "debug": {
                        "error": "ERROR_PROVIDER_ERROR",
                        "details": { "title": "Upstream", "detail": "Overloaded", "isRetryable": true }
                    }
                }]
            }
        });
        let err = feed_err(crate::providers::connect::frame::encode(debug_body.to_string().as_bytes(), crate::providers::connect::frame::END_STREAM));
        assert_eq!(err.status, Some(503));
        assert_eq!(err.kind, ErrorKind::Transient);
        assert!(err.message.contains("Upstream: Overloaded"), "{}", err.message);
    }

    #[test]
    fn unspecified_structured_error_code_zero_preserves_outer_connect_status_and_refusal() {
        let feed_err = |frame: Vec<u8>| {
            let mut decoder = lookup_decoder();
            let err = decoder.feed(&frame).expect_err("expected structured error");
            (err, decoder.refusal())
        };

        // Omitted field 1 (proto3 default 0 = ERROR_UNSPECIFIED) preserves outer Connect status
        // and retryability while keeping readable_body().
        let b64 = encode_error_details_b64(0, "Notice", "Server detail", None);
        for (outer_code, expected_status, expected_kind, expect_bare_429) in [
            ("unauthenticated", 401, ErrorKind::Auth, false),
            ("unavailable", 503, ErrorKind::Transient, false),
            ("resource_exhausted", 429, ErrorKind::RateLimited, true),
        ] {
            let (err, refusal) = feed_err(end_stream_with_details(outer_code, "Error", "aiserver.v1.ErrorDetails", &b64));
            assert_eq!(err.status, Some(expected_status), "outer={outer_code}");
            assert_eq!(err.kind, expected_kind, "outer={outer_code}");
            assert_eq!(err.should_retry, None, "outer={outer_code}");
            assert!(err.message.contains("Notice: Server detail"), "outer={outer_code}: {}", err.message);
            assert_eq!(refusal.bare_resource_exhausted, expect_bare_429, "outer={outer_code}");
        }

        // JSON debug with 0 or "ERROR_UNSPECIFIED" likewise preserves outer status and applies
        // readable_body() and isRetryable.
        for raw_err in [json!(0), json!("ERROR_UNSPECIFIED")] {
            let payload = json!({
                "error": {
                    "code": "unauthenticated",
                    "message": "Error",
                    "details": [{
                        "type": "aiserver.v1.ErrorDetails",
                        "debug": {
                            "error": raw_err,
                            "details": { "title": "Session", "detail": "Token expired" }
                        }
                    }]
                }
            });
            let (err, _) = feed_err(crate::providers::connect::frame::encode(payload.to_string().as_bytes(), crate::providers::connect::frame::END_STREAM));
            assert_eq!(err.status, Some(401), "raw_err={raw_err}");
            assert_eq!(err.kind, ErrorKind::Auth, "raw_err={raw_err}");
            assert_eq!(err.should_retry, None, "raw_err={raw_err}");
            assert!(err.message.contains("Session: Token expired"), "{}", err.message);
        }

        // Non-2xx HTTP error with omitted field 1 also preserves outer status and detail.
        let body = json!({
            "code": "unavailable",
            "message": "Error",
            "details": [{ "type": "aiserver.v1.ErrorDetails", "value": b64 }]
        });
        let http_err = classify_http_error(
            &mixdog_core_api::domain::provider::ErrorResponse { status: Some(503), headers: vec![], body: body.to_string().into_bytes() },
            Exposure::default(),
        );
        assert_eq!(http_err.status, Some(503));
        assert_eq!(http_err.kind, ErrorKind::Transient);
        assert!(http_err.message.contains("Notice: Server detail"), "{}", http_err.message);
    }

    #[test]
    fn stream_completes_after_final_text_step_and_after_turn_ended_truncation() {
        let text = |s: &str| update(1, |t| t.string(1, s));
        let step_completed = update(17, |_| {});
        let turn_ended = update(14, |_| {});
        let heartbeat = update(13, |_| {});
        let checkpoint = frame_of(|m| m.bytes(3, b"cp"));
        let kv_get = frame_of(|m| {
            let mut get = crate::providers::connect::pb::Writer::new();
            get.bytes(1, b"missing");
            let mut kv = crate::providers::connect::pb::Writer::new();
            kv.varint(1, 1);
            kv.message(2, get);
            m.message(4, kv);
        });
        let truncated = &checkpoint[..checkpoint.len() - 1];
        let clean_end = crate::providers::connect::frame::encode(b"{}", crate::providers::connect::frame::END_STREAM);

        // 1. textDelta + stepCompleted + EOF completes cleanly.
        let mut decoder = lookup_decoder();
        let mut events = decoder.feed(&[text("done"), step_completed.clone()].concat()).expect("decodes");
        events.extend(decoder.finish().expect("final text step completes on EOF"));
        assert!(events.iter().any(|e| matches!(e, StreamEvent::Completed { stop: Some(StopReason::Other(s)), .. } if s == "stop")));

        // 2. textDelta + stepCompleted + checkpoint + heartbeat + kv + truncated frame + EOF completes cleanly.
        let mut decoder = lookup_decoder();
        let mut bytes = [text("done"), step_completed.clone(), checkpoint.clone(), heartbeat, kv_get].concat();
        bytes.extend_from_slice(truncated);
        let mut events = decoder.feed(&bytes).expect("decodes");
        events.extend(decoder.finish().expect("trailing metadata truncation completes"));
        assert!(events.iter().any(|e| matches!(e, StreamEvent::Completed { .. })));

        // 3. textDelta + stepCompleted + clean END_STREAM without turnEnded completes cleanly.
        let mut decoder = lookup_decoder();
        let events = decoder.feed(&[text("done"), step_completed.clone(), clean_end].concat()).expect("completes on END_STREAM");
        assert!(events.iter().any(|e| matches!(e, StreamEvent::Completed { .. })));

        // 4. textDelta after stepCompleted clears step_completed_is_latest -> EOF is incomplete_stream.
        let mut decoder = lookup_decoder();
        decoder.feed(&[text("a"), step_completed.clone(), text("b")].concat()).expect("decodes");
        let err = decoder.finish().expect_err("not final step");
        assert_eq!(err.code.as_deref(), Some("incomplete_stream"));

        // 5. toolCallStarted + toolCallCompleted + stepCompleted -> last output was not text -> incomplete_stream.
        let mut decoder = lookup_decoder();
        let tc_start = update(2, |tc| tc.string(1, "tc-1"));
        let tc_done = update(3, |tc| tc.string(1, "tc-1"));
        let mut bytes = [text("hi"), tc_start.clone(), tc_done, step_completed.clone()].concat();
        bytes.extend_from_slice(truncated);
        decoder.feed(&bytes).expect("decodes");
        let err = decoder.finish().expect_err("tool call step is not final text step");
        assert_eq!(err.code.as_deref(), Some("incomplete_stream"));

        // 6. Open toolCallStarted + textDelta + stepCompleted -> open tool call blocks early completion.
        let mut decoder = lookup_decoder();
        let mut bytes = [tc_start, text("hi"), step_completed].concat();
        bytes.extend_from_slice(truncated);
        decoder.feed(&bytes).expect("decodes");
        let err = decoder.finish().expect_err("open tool call blocks completion");
        assert_eq!(err.code.as_deref(), Some("incomplete_stream"));

        // 7. textDelta + turnEnded + truncated trailing repeat checkpoint -> completes cleanly.
        let mut decoder = lookup_decoder();
        let mut bytes = [text("finished"), turn_ended].concat();
        bytes.extend_from_slice(truncated);
        let mut events = decoder.feed(&bytes).expect("decodes");
        events.extend(decoder.finish().expect("turnEnded tolerates trailing truncated frame"));
        let out: String = events.iter().filter_map(|e| if let StreamEvent::TextDelta(t) = e { Some(t.as_str()) } else { None }).collect();
        assert_eq!(out, "finished");
        assert!(events.iter().any(|e| matches!(e, StreamEvent::Completed { .. })));
    }

    #[test]
    fn cut_and_end_stream_error_tolerance_require_turn_ended_and_terminal_checkpoint() {
        let text = |s: &str| update(1, |t| t.string(1, s));
        let step_completed = update(17, |_| {});
        let turn_ended = update(14, |_| {});
        let checkpoint = frame_of(|m| m.bytes(3, b"cp"));
        let err_end = crate::providers::connect::frame::encode(
            br#"{"error":{"code":"unavailable","message":"post-turn disconnect"}}"#,
            crate::providers::connect::frame::END_STREAM,
        );

        // 1. turnEnded + terminal checkpoint: can_complete_on_cut is true and trailing END_STREAM error completes cleanly.
        let mut decoder = lookup_decoder();
        let events = decoder
            .feed(&[text("done"), turn_ended.clone(), checkpoint.clone(), err_end.clone()].concat())
            .expect("END_STREAM error after terminal checkpoint completes cleanly");
        let out: String = events.iter().filter_map(|e| if let StreamEvent::TextDelta(t) = e { Some(t.as_str()) } else { None }).collect();
        assert_eq!(out, "done");
        assert!(events.iter().any(|e| matches!(e, StreamEvent::Completed { .. })));

        // 2. turnEnded WITHOUT terminal checkpoint: can_complete_on_cut is false and END_STREAM error fails.
        let mut decoder = lookup_decoder();
        let first = decoder.feed(&[text("done"), turn_ended].concat()).expect("decodes");
        assert!(!first.is_empty());
        assert!(!decoder.can_complete_on_cut());
        let err = decoder.feed(&err_end).expect_err("END_STREAM error without terminal checkpoint must fail");
        assert_eq!(err.code.as_deref(), Some("unavailable"));

        // 3. stepCompleted + checkpoint WITHOUT turnEnded: can_complete_on_cut is false and END_STREAM error fails.
        let mut decoder = lookup_decoder();
        decoder.feed(&[text("done"), step_completed, checkpoint].concat()).expect("decodes");
        assert!(!decoder.can_complete_on_cut());
        let err = decoder.feed(&err_end).expect_err("END_STREAM error after stepCompleted without turnEnded must fail");
        assert_eq!(err.code.as_deref(), Some("unavailable"));
    }
}

impl CursorDecoder {
    /// Recover tool calls leaked into the answer text, naming only these tools (the request's).
    pub fn with_known_tools(mut self, names: HashSet<String>) -> Self {
        self.leak = LeakGuard::new(names, true);
        self
    }

    /// What the guard let through and recovered: visible text first, then the calls (each reports `tool`).
    fn relay_leak(&mut self, (text, calls): (String, Vec<Recovered>), events: &mut Vec<StreamEvent>) {
        self.emit_text(text, events);
        for recovered in calls {
            self.leaked.push(leak::openai_call(recovered));
            events.push(StreamEvent::Progress(ProgressKind::Tool));
        }
    }

    pub fn with_pricing_model(mut self, pricing_model: Option<String>) -> Self {
        self.pricing_model = pricing_model;
        self
    }

    pub fn new(blobs: BlobStore, tools: Vec<McpToolDefinition>, cloud_rule: Option<String>) -> Self {
        Self {
            frames: FrameReader::new(MAX_CONNECT_FRAME_BYTES),
            waiting: VecDeque::new(),
            turn_usage: None,
            reported_output: 0,
            listed: None,
            step_execs: Default::default(),
            resumed: false,
            refusal: Refusal::default(),
            spoke: false,
            seen: Default::default(),
            heartbeat_only: false,
            stirred: false,
            transcript: None,
            blobs,
            tools,
            cloud_rule,
            filter: ThinkFilter::default(),
            saw_turn_ended: false,
            saw_end: false,
            step_completed_is_latest: false,
            last_output_was_text: false,
            open_tool_calls: HashSet::new(),
            anonymous_open_tool_calls: 0,
            progress_version: 0,
            latest_checkpoint: None,
            latest_checkpoint_progress_version: None,
            latest_checkpoint_terminal: false,
            output_tokens: 0,
            context_tokens: None,
            pending: Vec::new(),
            executions: HashMap::new(),
            handed: Vec::new(),
            liveness: false,
            outbound: Vec::new(),
            exposure: Exposure::default(),
            reasoning_started: false,
            text_started: false,
            terminal: false,
            pricing_model: None,
            leak: LeakGuard::new(HashSet::new(), true),
            leaked: Vec::new(),
            dedupe: Dedupe::default(),
        }
    }

    /// `AgentClientMessage` bytes the stream must write back, in order.
    pub fn take_outbound(&mut self) -> Vec<Vec<u8>> {
        std::mem::take(&mut self.outbound)
    }

    fn text(&mut self, content: String, reasoning: String, events: &mut Vec<StreamEvent>) {
        if !reasoning.is_empty() {
            self.reasoning(reasoning, events);
        }
        if self.leak.enabled() {
            let scanned = self.leak.push(&content, false);
            self.relay_leak(scanned, events);
        } else {
            self.emit_text(content, events);
        }
    }

    fn emit_text(&mut self, content: String, events: &mut Vec<StreamEvent>) {
        if !content.is_empty() {
            if !self.text_started {
                self.text_started = true;
                events.push(StreamEvent::ItemStart { kind: ItemKind::Text, phase: None });
            }
            self.exposure.text_emitted = true;
            self.last_output_was_text = true;
            events.push(StreamEvent::TextDelta(content));
        }
    }

    fn reasoning(&mut self, text: String, events: &mut Vec<StreamEvent>) {
        if !self.reasoning_started {
            self.reasoning_started = true;
            events.push(StreamEvent::ItemStart { kind: ItemKind::Reasoning, phase: None });
        }
        self.last_output_was_text = false;
        events.push(StreamEvent::ReasoningDelta(text));
    }

    fn interaction(&mut self, update: InteractionUpdate, events: &mut Vec<StreamEvent>) {
        let before = events.len();
        let heartbeat_only_update = update.is_heartbeat_only();
        if !heartbeat_only_update {
            self.progress_version += 1;
        }
        if update.step_completed
            && update.text_delta.is_none()
            && update.thinking_delta.is_none()
            && update.tool_call_started.is_none()
            && update.tool_call_completed.is_none()
            && !update.tool_call_partial
            && !update.turn_ended
        {
            self.step_completed_is_latest = true;
        } else if !heartbeat_only_update {
            self.step_completed_is_latest = false;
        }
        if let Some(call_id) = update.tool_call_started {
            if call_id.is_empty() {
                self.anonymous_open_tool_calls += 1;
            } else {
                self.open_tool_calls.insert(call_id);
            }
            self.last_output_was_text = false;
        }
        if let Some(call_id) = update.tool_call_completed {
            if call_id.is_empty() {
                self.anonymous_open_tool_calls = self.anonymous_open_tool_calls.saturating_sub(1);
            } else {
                self.open_tool_calls.remove(&call_id);
            }
            self.last_output_was_text = false;
        }
        if update.tool_call_partial {
            self.last_output_was_text = false;
        }
        if let Some(delta) = update.text_delta.filter(|t| !t.is_empty()) {
            let (content, reasoning) = self.filter.process(&delta);
            self.text(content, reasoning, events);
        }
        if let Some(thinking) = update.thinking_delta.filter(|t| !t.is_empty()) {
            self.reasoning(thinking, events);
        }
        if update.turn_ended {
            self.saw_turn_ended = true;
        }
        if update.turn_ended || update.step_completed {
            self.next_step();
        }
        self.turn_usage = update.usage.or(self.turn_usage);
        if let Some(listed) = update.listed {
            self.listed = Some(listed);
        }
        self.heartbeat_only = heartbeat_only_update && events.len() == before;
        // Tokens generated with no text to show are the model working (a long think streams only them).
        if update.token_delta > 0 && events.len() == before {
            events.push(StreamEvent::Progress(ProgressKind::Semantic));
        }
        self.liveness |= update.heartbeat;
        self.spoke |= events.len() > before || update.token_delta > 0;
        self.output_tokens += update.token_delta.max(0) as u64;
    }

    fn can_finalize_without_turn_ended(&self) -> bool {
        self.step_completed_is_latest
            && self.last_output_was_text
            && self.pending.is_empty()
            && self.open_tool_calls.is_empty()
            && self.anonymous_open_tool_calls == 0
    }

    /// True once `turnEnded` and its terminal checkpoint have both arrived,
    /// so a trailing transport fault or `END_STREAM` error should finalize cleanly
    /// instead of failing or resuming.
    pub fn can_complete_on_cut(&self) -> bool {
        !self.terminal && self.saw_turn_ended && self.latest_checkpoint_terminal
    }

    /// True once a Connect `END_STREAM` frame was decoded for this wire stream.
    pub fn saw_end_stream(&self) -> bool {
        self.saw_end
    }

    /// Latest checkpoint bytes when the checkpoint covers every frame and client
    /// reply processed so far and predates `turnEnded`.
    pub fn fresh_checkpoint(&self) -> Option<&[u8]> {
        if !self.latest_checkpoint_terminal && self.pending.is_empty() && self.latest_checkpoint_progress_version == Some(self.progress_version) {
            self.latest_checkpoint.as_deref()
        } else {
            None
        }
    }

    /// Resets per-connection framing state before reopening the stream on a
    /// checkpoint resume, preserving emitted block state, blob store, and
    /// checkpoint freshness so an immediate cut without progress still sees the
    /// same checkpoint for `noProgressResumes` accounting.
    pub fn prepare_checkpoint_resume(&mut self) {
        self.frames = FrameReader::new(MAX_CONNECT_FRAME_BYTES);
        self.waiting.clear();
        self.saw_end = false;
        self.saw_turn_ended = false;
        self.latest_checkpoint_terminal = false;
        self.step_completed_is_latest = false;
        self.terminal = false;
        self.refusal = Refusal::default();
        self.outbound.clear();
    }

    fn push_side_effect(&mut self, msg: Vec<u8>) {
        self.progress_version += 1;
        self.outbound.push(msg);
    }

    fn extend_side_effects(&mut self, messages: impl IntoIterator<Item = Vec<u8>>) {
        self.progress_version += 1;
        self.outbound.extend(messages);
    }

    fn try_handle_parked_frame(&mut self, frame: &Frame) -> Result<bool, ProviderError> {
        if frame.is_compressed() || frame.flags != 0 {
            return Ok(false);
        }
        let Ok(message) = ServerMessage::decode(&frame.payload) else {
            return Ok(false);
        };
        if message.interaction.is_none()
            && message.exec.is_none()
            && message.checkpoint.is_none()
            && message.exec_abort.is_none()
            && message.query.is_none()
            && message.unknown.is_empty()
            && let Some(kv) = message.kv
        {
            self.kv(kv)?;
            return Ok(true);
        }
        if message.kv.is_none()
            && message.exec.is_none()
            && message.checkpoint.is_none()
            && message.exec_abort.is_none()
            && message.query.is_none()
            && message.unknown.is_empty()
            && message.interaction.as_ref().is_some_and(InteractionUpdate::is_heartbeat_only)
        {
            self.liveness = true;
            return Ok(true);
        }
        Ok(false)
    }

    /// Total bytes buffered in the frame reader and unread waiting queue.
    pub fn buffered_bytes(&self) -> usize {
        self.frames.buffered() + self.waiting.iter().map(|frame| frame.payload.len() + 5).sum::<usize>()
    }

    /// Services any pure KV or heartbeat frames already queued in `waiting`
    /// while preserving all other frames in order.
    pub fn drain_parked_waiting(&mut self) -> Result<(), ProviderError> {
        let queued = std::mem::take(&mut self.waiting);
        for frame in queued {
            if !self.try_handle_parked_frame(&frame)? {
                self.waiting.push_back(frame);
            }
        }
        Ok(())
    }

    /// Feeds incoming bytes while the run is parked: pure KV (`getBlob` /
    /// `setBlob`) and heartbeat frames are handled immediately, while all other
    /// frames remain queued in order for resumption.
    pub fn park_feed(&mut self, bytes: &[u8]) -> Result<(), ProviderError> {
        let frames = self.frames.push(bytes).map_err(|e| {
            let mut error = ProviderError::new(ErrorKind::Unknown, DeliveryState::Accepted);
            error.code = Some("protocol_error".to_owned());
            error.message = format!("Cursor frame exceeds {} bytes", e.max);
            error
        })?;
        for frame in frames {
            if !self.try_handle_parked_frame(&frame)? {
                self.waiting.push_back(frame);
            }
        }
        Ok(())
    }

    /// The server's heartbeat arrived since the last call: the run is alive, which is no progress of the model.
    pub fn take_liveness(&mut self) -> bool {
        std::mem::take(&mut self.liveness)
    }

    /// The calls the run waits on, handed over with the last batch.
    pub fn handed(&self) -> &[Pending] {
        &self.handed
    }

    /// A frame received behind the one that ended the batch is still to be read: `feed` of nothing reads it.
    pub fn has_waiting(&self) -> bool {
        !self.waiting.is_empty()
    }

    /// `request` is the attempt now reading the run.
    pub fn attend(&mut self, request: Arc<ModelRequest>) {
        self.transcript = Some(request);
    }

    /// No attempt reads the run: the transcript it held is let go.
    pub fn leave(&mut self) {
        self.transcript = None;
    }

    /// The run goes on after its results were written back: the next batch or the turn's end is a new attempt's.
    pub fn resume(&mut self) {
        for call in self.handed.drain(..) {
            if let Some(execution) = self.executions.get_mut(&call.exec_key) {
                execution.answered = true;
            }
        }
        // Writing tool results back advances the turn past any prior checkpoint.
        self.progress_version += 1;
        // A step whose count was reached is over already; one handed over at the quiet point is still counted.
        self.resumed = self.listed.is_some() || !self.step_execs.is_empty();
        self.next_batch();
    }

    /// Every frame that arrived before the results were written back has been read. The step they answer is over,
    /// however it was handed over: the model writes its next step only with them, so a listing that arrives from here
    /// on counts the execs that follow it. One that arrived before them was that step's, and counted its execs.
    pub fn caught_up(&mut self) {
        if std::mem::take(&mut self.resumed) {
            self.next_step();
        }
    }

    /// The run has shown nothing yet, in this batch or any before it.
    pub fn silent(&self) -> bool {
        !self.spoke
    }

    /// What the frame that ended the run with a failure said of it.
    pub fn refusal(&self) -> Refusal {
        self.refusal
    }

    /// Calls were announced for a step the service has not listed, or not yet in full: a quiet point hands them over.
    pub fn awaits_quiet(&self) -> bool {
        !self.terminal && !self.pending.is_empty()
    }

    /// A frame other than the service's heartbeat was read since the last call: a quiet stretch starts over.
    pub fn take_stir(&mut self) -> bool {
        std::mem::take(&mut self.stirred)
    }

    /// The quiet point ([`QUIET`] with no frame but heartbeats): the calls announced so far are the batch. The step
    /// goes on until its results are written back, so an exec of it that arrives later is the next batch, and a
    /// listing that arrives before those results counts the execs already handed over.
    pub fn quiet(&mut self) -> Vec<StreamEvent> {
        if self.awaits_quiet() { self.finalize() } else { Vec::new() }
    }

    /// The result of the call handed over as `call_id`: the one in the transcript of the attempt now reading, and a
    /// failure when the transcript no longer holds it, so the service never waits on an exec it sent again.
    fn result_of(&self, call_id: &str) -> Message {
        let kept = self.transcript.as_ref().and_then(|request| {
            let messages = crate::providers::own_call_ids::own_call_ids(&request.messages);
            messages.iter().rev().find(|m| m.role == Role::Tool && m.tool_call_id.as_deref() == Some(call_id)).cloned()
        });
        kept.unwrap_or_else(|| {
            let mut gone = Message::new(Role::Tool, Content::Text(RESULT_GONE.to_owned().into()));
            gone.is_error = true;
            gone
        })
    }

    /// The step's tool requests are all in: what follows is another step's.
    fn next_step(&mut self) {
        self.listed = None;
        self.step_execs.clear();
    }

    fn next_batch(&mut self) {
        self.terminal = false;
        self.saw_turn_ended = false;
        self.latest_checkpoint_terminal = false;
        self.saw_end = false;
        self.step_completed_is_latest = false;
        self.last_output_was_text = false;
        self.open_tool_calls.clear();
        self.anonymous_open_tool_calls = 0;
        self.output_tokens = 0;
        self.exposure = Exposure::default();
        self.reasoning_started = false;
        self.text_started = false;
        self.leaked.clear();
        self.dedupe = Dedupe::default();
    }

    fn reply_exec(&mut self, exec: &ExecServer, result: ExecResult, echo: ExecEcho) {
        self.push_side_effect(exec_client_message(exec.id, &exec.exec_id, &result, &echo));
    }

    fn unavailable(&mut self, exec: &ExecServer, kind: UnavailableKind, reason: &str, echo: ExecEcho) {
        self.reply_exec(exec, ExecResult::Unavailable(kind, reason.to_owned()), echo);
    }

    fn tool_named(&self, names: &[&str]) -> Option<&McpToolDefinition> {
        self.tools.iter().find(|t| names.contains(&t.name.as_str()))
    }

    fn announce(&mut self, exec: &ExecServer, mut pending: Pending) {
        let key = if exec.exec_id.is_empty() { exec.id.to_string() } else { exec.exec_id.clone() };
        if let Some(known) = self.executions.get(&key) {
            // The service asks again for an exec whose result it was given (`previous.completedResult`): the same result
            // answers it. One still running is answered when it ends.
            if known.answered {
                let result = self.result_of(&known.call_id);
                self.extend_side_effects(answer::answer(exec, &result));
            }
            return;
        }
        // A parent call can issue distinct executions, in one batch or over several; each needs its own id.
        if self.executions.values().any(|known| known.call_id == pending.tool_call_id) {
            pending.tool_call_id = random_uuid();
        }
        self.spoke = true;
        self.last_output_was_text = false;
        self.executions.insert(key.clone(), Execution { call_id: pending.tool_call_id.clone(), answered: false });
        pending.exec_key = key;
        self.pending.push(pending);
    }

    fn abort_exec(&mut self, abort_id: u64) {
        let mut aborted_keys = Vec::new();
        self.pending.retain(|pending| {
            if pending.exec.id == abort_id {
                aborted_keys.push(pending.exec_key.clone());
                false
            } else {
                true
            }
        });
        for key in aborted_keys {
            self.executions.remove(&key);
        }
    }

    fn mcp_exec(&mut self, exec: &ExecServer) {
        let Some(args) = &exec.mcp else { return };
        let requested = if args.tool_name.is_empty() { args.name.clone() } else { args.tool_name.clone() };
        let direct = self.tool_named(&[requested.as_str()]).map(|t| t.name.clone());
        let mut tool = direct.clone().or_else(|| (!requested.is_empty()).then(|| self.tool_named(&["call_tool"]).map(|t| t.name.clone())).flatten());
        let Some(first) = tool.clone() else {
            let shown = if requested.is_empty() { "unknown" } else { &requested };
            self.reply_exec(exec, ExecResult::McpError(format!("Tool not available: {shown}")), ExecEcho::default());
            return;
        };
        let mut decoded = serde_json::Map::new();
        for (key, bytes) in &args.args {
            let value = decode_json_value(bytes).unwrap_or_else(|_| Value::String(String::from_utf8_lossy(bytes).into_owned()));
            decoded.insert(key.clone(), value);
        }
        let mut arguments = Value::Object(decoded.clone());
        if requested == "call_tool"
            && direct.is_some()
            && decoded.len() == 2
            && let (Some(Value::String(name)), Some(Value::Object(inner))) = (decoded.get("name"), decoded.get("arguments"))
            && !name.is_empty()
            && name.chars().count() <= BRIDGE_NAME_MAX_CHARS
            && !BRIDGE_META_TOOLS.contains(&name.to_ascii_lowercase().as_str())
            && let Some(target) = self.tool_named(&[name.as_str()]).map(|t| t.name.clone())
        {
            tool = Some(target);
            arguments = Value::Object(inner.clone());
        }
        let name = tool.unwrap_or(first);
        let arguments = if direct.is_some() { arguments } else { json!({ "name": requested, "arguments": arguments }) };
        let id = if args.tool_call_id.is_empty() { random_uuid() } else { args.tool_call_id.clone() };
        self.announce(exec, Pending { exec_key: String::new(), tool_call_id: id, tool_name: name, arguments, exec: exec.clone() });
    }

    fn schema_arg(tool: &McpToolDefinition, candidates: &[&str], fallback: &str) -> String {
        let props = tool.input_schema.get("properties").and_then(Value::as_object);
        candidates.iter().find(|c| props.is_some_and(|p| p.contains_key(**c))).unwrap_or(&fallback).to_string()
    }

    /// A native exec a Mixdog tool serves: `Some(true)` redirected,
    /// `Some(false)` answered with an error, `None` not served.
    fn native_redirect(&mut self, exec: &ExecServer) -> Option<bool> {
        let (tool, args, id) = if let Some(a) = &exec.read {
            self.tool_named(&["read"])?;
            if a.offset.unsigned_abs() > READ_TAIL_MAX && a.offset < 0 {
                self.unavailable(
                    exec,
                    UnavailableKind::PathError { field: 7, error_field: 3 },
                    READ_TAIL_TOO_LONG,
                    ExecEcho { path: a.path.clone(), ..ExecEcho::default() },
                );
                return Some(false);
            }
            let tool = self.tool_named(&["read"])?;
            let mut args = serde_json::Map::new();
            args.insert(Self::schema_arg(tool, &["file_path", "filePath", "path"], "file_path"), json!(a.path));
            // A negative offset counts from the file's end: the read tool reads that tail whole, and the answer keeps
            // the rows asked for of it.
            if a.offset < 0 {
                args.insert("tail".into(), json!(a.offset.unsigned_abs()));
            } else {
                if a.offset != 0 {
                    args.insert("offset".into(), json!(a.offset));
                }
                if a.limit != 0 {
                    args.insert("limit".into(), json!(a.limit));
                }
            }
            (tool.name.clone(), Value::Object(args), a.tool_call_id.clone())
        } else if let Some(a) = &exec.write {
            let tool = self.tool_named(&["edit"])?;
            let text = if a.file_bytes.is_empty() {
                a.file_text.clone()
            } else if let Ok(text) = String::from_utf8(a.file_bytes.clone()) {
                text
            } else {
                self.push_side_effect(exec_client_message(
                    exec.id,
                    &exec.exec_id,
                    &ExecResult::Unavailable(
                        UnavailableKind::PathError { field: 3, error_field: 5 },
                        "Native Write fileBytes must be valid UTF-8; no file was written".to_owned(),
                    ),
                    &ExecEcho { path: a.path.clone(), ..ExecEcho::default() },
                ));
                return Some(false);
            };
            let mut args = serde_json::Map::new();
            args.insert(Self::schema_arg(tool, &["file_path", "filePath", "path"], "file_path"), json!(a.path));
            args.insert("old_string".into(), json!(""));
            args.insert("new_string".into(), json!(text));
            (tool.name.clone(), Value::Object(args), a.tool_call_id.clone())
        } else if let Some(a) = &exec.fetch {
            let tool = self.tool_named(&["web_fetch", "webfetch", "fetch"])?;
            (tool.name.clone(), json!({ "url": a.url }), a.tool_call_id.clone())
        } else if let Some(a) = exec.shell.as_ref().or(exec.shell_stream.as_ref()) {
            let tool = self.tool_named(&["shell", "bash"])?;
            let mut args = serde_json::Map::new();
            args.insert("command".into(), json!(a.command));
            if a.timeout != 0 {
                args.insert("timeout_ms".into(), json!(a.timeout));
            }
            (tool.name.clone(), Value::Object(args), a.tool_call_id.clone())
        } else if let Some(a) = &exec.ls {
            let tool = self.tool_named(&["glob"])?;
            (tool.name.clone(), json!({ "pattern": "*", "path": a.path }), a.tool_call_id.clone())
        } else if let Some(a) = &exec.grep {
            self.tool_named(&["grep"])?;
            // No pattern and a glob is a search for files, which a content search would answer with every line of them.
            if a.pattern.is_empty() && !a.glob.is_empty() {
                self.unavailable(exec, UnavailableKind::Error { field: 5, error_field: 2 }, GREP_NEEDS_PATTERN, ExecEcho::default());
                return Some(false);
            }
            let tool = self.tool_named(&["grep"])?;
            let mut args = serde_json::Map::new();
            args.insert("pattern".into(), json!(if a.pattern.is_empty() { "." } else { &a.pattern }));
            if a.offset > 0 {
                args.insert("offset".into(), json!(a.offset));
            }
            if !a.path.is_empty() {
                args.insert("path".into(), json!(a.path));
            }
            if !a.glob.is_empty() {
                args.insert("glob".into(), json!(a.glob));
            }
            let mode = match a.output_mode.as_str() {
                "files_with_matches" => "files",
                "" => "content",
                other => other,
            };
            args.insert("mode".into(), json!(mode));
            args.insert("context".into(), json!(0));
            if a.head_limit > 0 {
                args.insert("limit".into(), json!(a.head_limit));
            }
            (tool.name.clone(), Value::Object(args), a.tool_call_id.clone())
        } else {
            return None;
        };
        let tool_call_id = if id.is_empty() { random_uuid() } else { id };
        self.announce(exec, Pending { exec_key: String::new(), tool_call_id, tool_name: tool, arguments: args, exec: exec.clone() });
        Some(true)
    }

    /// Answers an exec no tool serves with its unavailable result.
    fn reject_exec(&mut self, exec: &ExecServer) {
        use UnavailableKind as K;
        let path = |p: &str| ExecEcho { path: p.to_owned(), ..ExecEcho::default() };
        if let Some(a) = &exec.read {
            self.unavailable(exec, K::Path { field: 7 }, UNAVAILABLE, path(&a.path));
        } else if let Some(a) = &exec.write {
            self.unavailable(exec, K::Path { field: 3 }, UNAVAILABLE, path(&a.path));
        } else if let Some(a) = &exec.delete {
            self.unavailable(exec, K::Path { field: 4 }, UNAVAILABLE, path(&a.path));
        } else if let Some(a) = &exec.ls {
            self.unavailable(exec, K::Path { field: 8 }, UNAVAILABLE, path(&a.path));
        } else if exec.grep.is_some() {
            self.unavailable(exec, K::Error { field: 5, error_field: 2 }, UNAVAILABLE, ExecEcho::default());
        } else if let Some(a) = &exec.fetch {
            self.unavailable(exec, K::PathError { field: 20, error_field: 2 }, UNAVAILABLE, path(&a.url));
        } else if let Some(a) = exec.shell.as_ref().or(exec.shell_stream.as_ref()) {
            self.unavailable(
                exec,
                K::Shell { field: 2 },
                UNAVAILABLE,
                ExecEcho { command: a.command.clone(), working_directory: a.working_directory.clone(), ..ExecEcho::default() },
            );
        } else if let Some(a) = &exec.background_shell {
            self.unavailable(
                exec,
                K::Shell { field: 16 },
                BACKGROUND_SHELL_REASON,
                ExecEcho { command: a.command.clone(), working_directory: a.working_directory.clone(), ..ExecEcho::default() },
            );
        } else if exec.write_shell_stdin {
            self.unavailable(exec, K::Error { field: 23, error_field: 2 }, UNAVAILABLE, ExecEcho::default());
        } else if exec.diagnostics {
            self.unavailable(exec, K::Empty { field: 9 }, "", ExecEcho::default());
        } else {
            // A throw ends the exec's stream on this side too: the close follows it.
            self.push_side_effect(exec_throw(exec.id, "Unsupported Cursor native exec. Use a Mixdog tool instead."));
            self.push_side_effect(exec_stream_close(exec.id));
        }
    }

    fn exec(&mut self, exec: ExecServer) {
        if exec.request_context {
            let context = request_context(&self.tools, self.cloud_rule.as_deref());
            self.reply_exec(&exec, ExecResult::RequestContext(context), ExecEcho::default());
            return;
        }
        // A tool request of the step, whether a Mixdog tool serves it or it is answered here; one sent again is not
        // another request.
        let key = if exec.exec_id.is_empty() { exec.id.to_string() } else { exec.exec_id.clone() };
        if self.seen.insert(key.clone()) {
            self.step_execs.insert(key);
        }
        if let Some(asked) = &exec.mcp_state {
            let state = ExecResult::McpState { tools: self.tools.clone(), asked: asked.clone() };
            self.reply_exec(&exec, state, ExecEcho::default());
            return;
        }
        if exec.mcp.is_some() {
            self.mcp_exec(&exec);
        } else {
            match self.native_redirect(&exec) {
                Some(_) => {}
                None => self.reject_exec(&exec),
            }
        }
    }

    fn kv(&mut self, kv: super::schema::KvServer) -> Result<(), ProviderError> {
        if let Some(id) = kv.get_blob {
            let data = self.blobs.get(&id).map(<[u8]>::to_vec);
            self.outbound.push(kv_client_message(kv.id, Some(data.as_deref())));
        } else if let Some((id, data)) = kv.set_blob {
            self.blobs.put(&id, data)?;
            self.outbound.push(kv_client_message(kv.id, None));
        }
        Ok(())
    }

    fn query(&mut self, id: u64, case: QueryCase) -> Result<(), ProviderError> {
        let (reply, reason) = match case {
            // A hosted search or fetch would run on the service, past the permissions, the prompts and the transcript of
            // this side: it is refused, and the model has the tools it was given.
            QueryCase::WebSearch => (QueryReply::Rejected { field: 2 }, REJECT_REASON),
            QueryCase::ExaSearch => (QueryReply::Rejected { field: 5 }, REJECT_REASON),
            QueryCase::ExaFetch => (QueryReply::Rejected { field: 6 }, REJECT_REASON),
            QueryCase::WebFetch => (QueryReply::Rejected { field: 9 }, REJECT_REASON),
            QueryCase::SwitchMode => (QueryReply::Rejected { field: 4 }, REJECT_REASON),
            QueryCase::AskQuestion => (QueryReply::AskQuestion, REJECT_REASON),
            QueryCase::CreatePlan => (QueryReply::CreatePlan, REJECT_REASON),
            QueryCase::SetupVm => (QueryReply::SetupVmAck, ""),
            // The wire has no refusal for a kind this side does not know, and the service waits on a query for good
            // while its heartbeats keep the run alive: the turn ends here.
            QueryCase::Unknown(field) => return Err(drift(&format!("Unsupported Cursor interaction query: field_{field}"))),
        };
        self.push_side_effect(interaction_response(id, reply, reason));
        Ok(())
    }

    fn message(&mut self, bytes: &[u8], events: &mut Vec<StreamEvent>) -> Result<(), ProviderError> {
        let message = ServerMessage::decode(bytes).map_err(|e| {
            let mut error = ProviderError::new(ErrorKind::Unknown, DeliveryState::Accepted);
            error.code = Some("protocol_error".to_owned());
            error.message = format!("Cursor protobuf: {e}");
            error
        })?;
        if let Some(update) = message.interaction {
            self.interaction(update, events);
        } else if let Some(kv) = message.kv {
            self.kv(kv)?;
        } else if let Some(checkpoint) = message.checkpoint {
            // The run's latest size: a batch that receives no checkpoint of its own reports the one before it, a step
            // old, so a turn that has shown a size never shows none.
            self.progress_version += 1;
            self.context_tokens = checkpoint_used_tokens(&checkpoint).or(self.context_tokens);
            self.latest_checkpoint = Some(checkpoint);
            self.latest_checkpoint_progress_version = Some(self.progress_version);
            self.latest_checkpoint_terminal = self.saw_turn_ended;
        } else if let Some(exec) = message.exec {
            self.progress_version += 1;
            self.step_completed_is_latest = false;
            self.exec(exec);
        } else if let Some(query) = message.query {
            self.progress_version += 1;
            self.step_completed_is_latest = false;
            self.query(query.id, query.case)?;
        } else if let Some(abort_id) = message.exec_abort {
            self.progress_version += 1;
            self.step_completed_is_latest = false;
            self.abort_exec(abort_id);
        } else if let Some(field) = message.unknown.first() {
            return Err(drift(&format!("Unsupported Cursor server message field {field}")));
        }
        Ok(())
    }

    fn end_stream_error(&self, payload: &[u8]) -> Option<ProviderError> {
        let parsed: Value = match serde_json::from_slice(payload) {
            Ok(v) => v,
            Err(_) => {
                let mut error = ProviderError::new(ErrorKind::Unknown, DeliveryState::Accepted);
                error.code = Some("protocol_error".to_owned());
                error.message = "Cursor returned an invalid end-stream frame".to_owned();
                return Some(error);
            }
        };
        let object = parsed.get("error")?.as_object()?;
        Some(classify_error_object(object, parsed.get("metadata"), None, &[], self.exposure))
    }

    /// The events of a finished run.
    fn finalize(&mut self) -> Vec<StreamEvent> {
        self.terminal = true;
        let mut events = Vec::new();
        let (content, reasoning) = self.filter.flush();
        self.text(content, reasoning, &mut events);
        // The stream ended: nothing is held back any more.
        let tail = self.leak.flush();
        self.relay_leak(tail, &mut events);
        let pending = std::mem::take(&mut self.pending);
        self.handed = pending.clone();
        let tool_use = !pending.is_empty();
        let mut announced = Vec::new();
        // The recovered calls run at the turn's end, ahead of the announced ones (`drainLeakedCalls`, then the
        // consumer's settlement).
        for call in self.leaked.clone() {
            if self.dedupe.should_dispatch(&call.name, &call.arguments, &call.id) {
                self.exposure.tool_dispatched = true;
                events.push(StreamEvent::ToolCallDone(call));
            }
        }
        for call in pending {
            events.push(StreamEvent::ItemStart { kind: ItemKind::Tool, phase: None });
            events.push(StreamEvent::ToolCallStart { id: call.tool_call_id.clone(), name: call.tool_name.clone() });
            self.exposure.tool_dispatched = true;
            let done = ToolCall { id: call.tool_call_id, name: call.tool_name, arguments: call.arguments, native_type: None };
            announced.push(done.clone());
            if self.dedupe.should_dispatch(&done.name, &done.arguments, &done.id) {
                events.push(StreamEvent::ToolCallDone(done));
            }
        }
        // The list the turn returns, `dedupeToolCallList([...native, ...leaked])`.
        if !self.leaked.is_empty() {
            let all = announced.into_iter().chain(std::mem::take(&mut self.leaked)).collect();
            events.push(StreamEvent::ReturnedCalls(leak::dedupe_list(all)));
        }
        // The update that ends the turn says what the whole turn used; the batches before it reported the output
        // counted as it streamed, which that total holds again, and nothing of the input side (a checkpoint's
        // occupancy is the context size, not a request's prompt).
        let turn = self.turn_usage.take();
        let output_tokens = match turn {
            Some(turn) => turn.output.saturating_sub(self.reported_output),
            None => self.output_tokens,
        };
        self.reported_output = if turn.is_some() { 0 } else { self.reported_output + output_tokens };
        events.push(StreamEvent::Usage(Usage {
            cost: None,
            input_tokens: turn.map_or(0, |turn| turn.input),
            output_tokens,
            cache_read_tokens: turn.map_or(0, |turn| turn.cache_read),
            cache_write_tokens: turn.map_or(0, |turn| turn.cache_write),
            cache_write_1h_tokens: 0,
            reasoning_tokens: turn.and_then(|turn| turn.reasoning),
            reasoning_incomplete: false,
            raw: Some(json!({
                "completion_tokens": output_tokens,
                "input_tokens_known": turn.is_some(),
                // The counts are of the whole turn, every model call of it: no one prompt's size.
                "input_tokens_scope": turn.map(|_| "turn"),
                "cache_tokens_known": turn.is_some(),
                "context_tokens": self.context_tokens,
            })),
        }));
        events.push(StreamEvent::Completed {
            pricing_model: self.pricing_model.clone(),
            request_ms: None,
            // Node's cursor result names the plain end `'stop'`, as the chat decoders do.
            stop: Some(if tool_use { StopReason::ToolUse } else { StopReason::Other("stop".to_owned()) }),
        });
        events
    }

    fn incomplete(&self, message: &str) -> ProviderError {
        let mut error = ProviderError::transport(TransportFault::TruncatedStream, DeliveryState::Accepted);
        error.code = Some("incomplete_stream".to_owned());
        error.message = message.to_owned();
        error.exposure = self.exposure;
        error
    }
}
