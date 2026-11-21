//! The record a failed turn leaves on its last message, built from the run's failure
//! (`failedTurnCompletion`, `manager/ask-turn-failure.mjs:26-45`, over `turnFailureRecord`,
//! `session/turn-failure.mjs:15-49`): `meta.transcript.completion`, whatever the error was, a workspace
//! admission refusal included.
//!
//! The run's `TurnError` carries the message, and for a provider failure its provider, status and kind
//! (`provider_error`). The rest of what `turnFailureRecord` reads off the thrown error - its `code`,
//! `retryAfterMs`, `resetAt`, the account pool's `quotaExhausted` proof and a provider timeout's phase - rides in
//! `TurnError.data` under `providerFacts` ([`ProviderFacts`]), so the wire type keeps its schema. The provider is
//! named in a first-byte timeout from the turn's own route, never from the error (`turn-failure.mjs:44`).

use std::sync::LazyLock;

use mixdog_ai::service::error_text::Descriptor;
use mixdog_ai::service::error_text::ErrorView;
use mixdog_ai::service::error_text::PresentOptions;
use mixdog_ai::service::error_text::TimeoutPhase;
use mixdog_ai::service::error_text::present_error_text;
use mixdog_ai::service::error_text::provider_error_text;
use mixdog_ai::service::error_text::safe_error_details;
use mixdog_ai::service::error_text::sent_code;
use mixdog_core_api::domain::keepalive::TransportKind;
use mixdog_core_api::domain::provider::DeliveryState;
use mixdog_core_api::domain::provider::ProviderError;
use mixdog_core_api::domain::provider::StreamTimeoutPhase;
use mixdog_core_api::domain::provider::TransportFault;
use mixdog_js::JsRegex;
use mixdog_protocol::ProviderErrorDetail;
use mixdog_protocol::TurnError;
use serde::Deserialize;
use serde::Serialize;
use serde_json::Map;
use serde_json::Value;
use serde_json::json;

/// The turn's provider and model (`session.provider`, `session.model`).
pub(crate) struct Route<'a> {
    pub provider: &'a str,
    pub model: &'a str,
}

/// `error.quotaExhausted`: the account pool's proof that no account can serve the model.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QuotaProof {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reset_at: Option<u64>,
}

/// `error.timeoutPhase` of a provider timeout (`provider-timeout-phase.mjs`).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum TimeoutKind {
    Headers,
    FirstChunk,
    Idle,
    Auth,
}

/// A provider timeout's `timeoutPhase`, `waitedMs` and `attempts`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TimeoutFacts {
    pub phase: TimeoutKind,
    #[serde(default)]
    pub waited_ms: u64,
    #[serde(default)]
    pub attempts: u64,
}

/// The wire a keepalive probe went unanswered on ([`TransportFault::KeepaliveExpired`]).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum KeepaliveWire {
    Http1,
    Http2,
    WebSocket,
}

/// `error.transport` ([`TransportFault`]): what ended the link or stream, kept typed so the transcript row, the agent task's
/// text and the log read the same cause.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum FaultFacts {
    Connect {
        #[serde(default, rename = "osCode", skip_serializing_if = "Option::is_none")]
        os_code: Option<i32>,
    },
    Dns,
    Reset,
    Closed,
    Tls,
    H2GoAway {
        code: u32,
    },
    H2RstStream {
        code: u32,
    },
    WsClose {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        code: Option<u16>,
    },
    KeepaliveExpired {
        wire: KeepaliveWire,
    },
    TruncatedStream,
    Io {
        #[serde(default, rename = "osCode", skip_serializing_if = "Option::is_none")]
        os_code: Option<i32>,
    },
    TooManyEncodings,
    CorruptBody,
}

impl From<&TransportFault> for FaultFacts {
    fn from(fault: &TransportFault) -> Self {
        match *fault {
            TransportFault::Connect { os_code } => Self::Connect { os_code },
            TransportFault::Dns => Self::Dns,
            TransportFault::Reset => Self::Reset,
            TransportFault::Closed => Self::Closed,
            TransportFault::Tls => Self::Tls,
            TransportFault::H2GoAway { code } => Self::H2GoAway { code },
            TransportFault::H2RstStream { code } => Self::H2RstStream { code },
            TransportFault::WsClose { code } => Self::WsClose { code },
            TransportFault::KeepaliveExpired { transport } => Self::KeepaliveExpired {
                wire: match transport {
                    TransportKind::Http1 => KeepaliveWire::Http1,
                    TransportKind::Http2 => KeepaliveWire::Http2,
                    TransportKind::WebSocket => KeepaliveWire::WebSocket,
                },
            },
            TransportFault::TruncatedStream => Self::TruncatedStream,
            TransportFault::Io { os_code } => Self::Io { os_code },
            TransportFault::TooManyEncodings => Self::TooManyEncodings,
            TransportFault::CorruptBody => Self::CorruptBody,
        }
    }
}

impl FaultFacts {
    pub fn fault(self) -> TransportFault {
        match self {
            Self::Connect { os_code } => TransportFault::Connect { os_code },
            Self::Dns => TransportFault::Dns,
            Self::Reset => TransportFault::Reset,
            Self::Closed => TransportFault::Closed,
            Self::Tls => TransportFault::Tls,
            Self::H2GoAway { code } => TransportFault::H2GoAway { code },
            Self::H2RstStream { code } => TransportFault::H2RstStream { code },
            Self::WsClose { code } => TransportFault::WsClose { code },
            Self::KeepaliveExpired { wire } => TransportFault::KeepaliveExpired {
                transport: match wire {
                    KeepaliveWire::Http1 => TransportKind::Http1,
                    KeepaliveWire::Http2 => TransportKind::Http2,
                    KeepaliveWire::WebSocket => TransportKind::WebSocket,
                },
            },
            Self::TruncatedStream => TransportFault::TruncatedStream,
            Self::Io { os_code } => TransportFault::Io { os_code },
            Self::TooManyEncodings => TransportFault::TooManyEncodings,
            Self::CorruptBody => TransportFault::CorruptBody,
        }
    }
}

/// [`ProviderError::connection`]: the connection the request rode.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ConnectionFacts {
    pub id: u64,
    pub protocol: String,
}

/// [`ProviderError::partial_usage`]: what the stream had reported when it failed.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PartialUsage {
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cache_read_tokens: u64,
    pub cache_write_tokens: u64,
}

/// What `turnFailureRecord` reads off a provider error beyond [`ProviderErrorDetail`]'s provider, status and
/// kind. Every field is absent when the error had none.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderFacts {
    /// `error.code`, as sent.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub code: Option<String>,
    /// `error.retryAfterMs`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub retry_after_ms: Option<u64>,
    /// `error.resetAt`, epoch milliseconds.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reset_at: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub quota_exhausted: Option<QuotaProof>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub timeout: Option<TimeoutFacts>,
    /// `error.transport`: what ended the link or stream.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fault: Option<FaultFacts>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub connection: Option<ConnectionFacts>,
    /// The usage the stream reported before it failed.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub partial_usage: Option<PartialUsage>,
}

/// The key of [`ProviderFacts`] in `TurnError.data`.
const FACTS_KEY: &str = "providerFacts";

/// The key of a refused image request's blockers in `TurnError.data` and in the failure's `errorKind`.
const IMAGE_REFUSAL_KEY: &str = "imageRefusal";

/// The `providerFacts` of a `TurnError` are not facts this crate writes: only [`ProviderFacts::into_data`] puts them
/// there, so a value of another shape is a bug of whoever built the error, not an error without facts.
#[derive(Debug)]
pub struct MalformedFacts(serde_json::Error);

impl std::fmt::Display for MalformedFacts {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "the turn error's `{FACTS_KEY}` are malformed: {}", self.0)
    }
}

impl std::error::Error for MalformedFacts {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        Some(&self.0)
    }
}

impl ProviderFacts {
    /// The facts a failed turn's `TurnError` carries; none when it carries none (a plain failure, as Node's thrown
    /// `Error` without the fields).
    pub fn of(error: &TurnError) -> Result<Self, MalformedFacts> {
        match error.data.get(FACTS_KEY) {
            Some(facts) => serde_json::from_value(facts.clone()).map_err(MalformedFacts),
            None => Ok(Self::default()),
        }
    }

    /// `data` (null or an object of typed fields) with these facts added.
    pub fn into_data(self, data: Value) -> Value {
        let mut fields = match data {
            Value::Object(fields) => fields,
            _ => Map::new(),
        };
        fields.insert(FACTS_KEY.into(), serde_json::to_value(self).expect("provider facts serialize"));
        Value::Object(fields)
    }
}

/// The `TurnError` of a run that ended on `error` from `provider`: the wire detail (provider, status,
/// kind, delivery) and the facts `turnFailureRecord` reads off the same error. `data` is the error's other
/// typed fields (null when it has none).
pub fn provider_turn_error(error: &ProviderError, provider: &str, data: Value) -> TurnError {
    let descriptor = Descriptor::of(error);
    let facts = ProviderFacts {
        code: Some(sent_code(error)).filter(|code| !code.is_empty()),
        retry_after_ms: descriptor.retry_after_ms,
        reset_at: descriptor.reset_at,
        quota_exhausted: None,
        timeout: error.timeout_phase.map(|phase| TimeoutFacts {
            phase: match phase {
                StreamTimeoutPhase::Headers => TimeoutKind::Headers,
                StreamTimeoutPhase::FirstChunk => TimeoutKind::FirstChunk,
                StreamTimeoutPhase::Idle => TimeoutKind::Idle,
            },
            waited_ms: 0,
            attempts: 0,
        }),
        fault: error.transport.as_ref().map(FaultFacts::from),
        connection: error.connection.map(|c| ConnectionFacts { id: c.id, protocol: c.protocol.to_owned() }),
        partial_usage: error.partial_usage.as_deref().map(|u| PartialUsage {
            input_tokens: u.input_tokens,
            output_tokens: u.output_tokens,
            cache_read_tokens: u.cache_read_tokens,
            cache_write_tokens: u.cache_write_tokens,
        }),
    };
    let delivery = match error.delivery {
        DeliveryState::NotSent | DeliveryState::NotProcessed => mixdog_protocol::DeliveryState::NotSent,
        DeliveryState::Ambiguous => mixdog_protocol::DeliveryState::Ambiguous,
        DeliveryState::Accepted => mixdog_protocol::DeliveryState::Accepted,
    };
    let mut data = facts.into_data(data);
    // A refused image request keeps its blockers, with the ids the local fixes take, beside the facts: `failure_record` hands
    // them to the interface in `errorKind`.
    if let Some(refusal) = error.image_refusal.as_deref() {
        data[IMAGE_REFUSAL_KEY] = super::image_recovery::refusal_json(refusal);
    }
    TurnError {
        // An adapter's transport error has no text of its own: the wire error says what the kind, the delivery and the fault say.
        message: provider_error_text(error, "turn"),
        data,
        provider_error: Some(ProviderErrorDetail { provider: provider.to_owned(), status: error.status, kind: descriptor.kind, delivery: Some(delivery) }),
    }
}

/// `providerDisplayName` (`shared/provider-display-name.mjs`): a known provider id's display name, any other id as
/// itself.
fn provider_display_name(provider: &str) -> String {
    let name = match provider.to_lowercase().as_str() {
        "openai-oauth" => "OpenAI OAuth",
        "anthropic-oauth" => "Anthropic OAuth",
        "grok-oauth" => "Grok OAuth",
        "muse-code-oauth" => "Muse Code",
        "command-code-oauth" => "Command Code",
        "mimo-oauth" => "MiMo",
        "cursor-oauth" => "Cursor OAuth",
        "devin-oauth" => "Devin",
        "antigravity-oauth" => "Antigravity OAuth",
        "openai" | "openai-api" => "OpenAI API",
        "anthropic" | "anthropic-api" => "Anthropic API",
        "gemini" | "gemini-api" => "Gemini API",
        "xai" | "xai-api" => "xAI API",
        "deepseek" | "deepseek-api" => "DeepSeek API",
        "opencode-go-oauth" => "OpenCode Go OAuth",
        "openrouter" => "OpenRouter",
        "mixdog-local" => "Local Provider",
        "default" => "Default",
        _ => provider,
    };
    name.to_owned()
}

/// `toolErrorDisplay`'s no-prefix cases (`tool-result-text.mjs:121-128`).
static SPECIAL: LazyLock<JsRegex> = LazyLock::new(|| {
    JsRegex::new_static(
        r"^(?:Search failed|Fetch failed|No first response|No progress|Cancelled|The .+ went stale|(?:Web search agent|Agent|Tool|Request) (?:stopped|was cancelled))",
        "i",
    )
});
static ERROR_COLON: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r"^error\s*:", "i"));
static STRIP: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r"^Error:\s*", "i"));
/// `LEGACY_BILLING_MESSAGE_RE` and `LEGACY_QUOTA_MESSAGE_RE` (`provider-error-kind.mjs`): the wordings `legacyQuotaWording`
/// reads a usage limit from.
static LEGACY_BILLING: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r"\binsufficient_quota\b|exceeded your (?:current )?quota", "i"));
static LEGACY_QUOTA: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r"\bquota_exceeded\b|\busage_limit_reached\b|hit your usage limit", "i"));

/// `errText(error)` of an `Error`: its message, else its name.
fn error_text(error: &TurnError) -> &str {
    if error.message.is_empty() { "Error" } else { &error.message }
}

fn legacy_quota_kind(message: &str) -> Option<&'static str> {
    if LEGACY_BILLING.is_match(message) {
        Some("billing")
    } else if LEGACY_QUOTA.is_match(message) {
        Some("quota_exhausted")
    } else {
        None
    }
}

/// The quota stop of a failure: the pool's proof names its provider, model and reset; the route and the error's own reset fill what it leaves out.
fn quota_record(proof: Option<&QuotaProof>, reset_at: Option<u64>, route: &Route<'_>) -> Value {
    let named = |own: Option<&String>, route: &str| own.filter(|name| !name.is_empty()).map_or_else(|| route.to_owned(), Clone::clone);
    json!({
        "provider": named(proof.and_then(|p| p.provider.as_ref()), route.provider),
        "model": named(proof.and_then(|p| p.model.as_ref()), route.model),
        "resetAt": proof.and_then(|p| p.reset_at).or(reset_at),
    })
}

fn timeout_phase(phase: TimeoutKind) -> TimeoutPhase {
    match phase {
        TimeoutKind::Headers => TimeoutPhase::Headers,
        TimeoutKind::FirstChunk => TimeoutPhase::FirstChunk,
        TimeoutKind::Idle => TimeoutPhase::Idle,
        TimeoutKind::Auth => TimeoutPhase::Auth,
    }
}

fn presented_delivery(delivery: mixdog_protocol::DeliveryState) -> DeliveryState {
    match delivery {
        mixdog_protocol::DeliveryState::NotSent => DeliveryState::NotSent,
        mixdog_protocol::DeliveryState::Ambiguous => DeliveryState::Ambiguous,
        mixdog_protocol::DeliveryState::Accepted => DeliveryState::Accepted,
    }
}

/// `{ errorKind, quota, detail, errorDetails }` of `turnFailureRecord(error, route)`.
pub(crate) fn failure_record(error: &TurnError, route: &Route<'_>) -> Result<Map<String, Value>, MalformedFacts> {
    let facts = ProviderFacts::of(error)?;
    let proof = facts.quota_exhausted.as_ref();
    let provider = error.provider_error.as_ref();
    // `providerErrorKind`: the pool's proof decides first (`provider-error-kind.mjs:674`).
    let mut kind = if proof.is_some() { "quota_exhausted" } else { provider.map_or("unknown", |p| p.kind.as_str()) };
    let status = provider.and_then(|p| p.status).map_or(0, u32::from);
    let code = facts.code.as_deref().map(|code| code.trim().to_lowercase()).unwrap_or_default();
    let retry_after_ms = facts.retry_after_ms.filter(|ms| *ms > 0);
    // `legacyQuotaWording` (presentation only): a fully untyped error (no status, code or retry advice) may still read
    // as a usage limit from unambiguous wording, e.g. a persisted failure's text.
    if kind == "unknown" && status == 0 && code.is_empty() && retry_after_ms.is_none() {
        kind = legacy_quota_kind(&error.message).unwrap_or(kind);
    }
    // `resetAtOf` (`provider-error-kind.mjs:601-609`): the error's own, else the proof's.
    let reset_at = facts.reset_at.filter(|at| *at > 0).or_else(|| proof.and_then(|p| p.reset_at).filter(|at| *at > 0));
    let mut out = Map::new();
    out.insert("providerKind".into(), json!(kind));
    let mut error_kind = json!({ "kind": kind, "code": code, "status": status, "retryAfterMs": retry_after_ms, "resetAt": reset_at });
    if let Some(refusal) = error.data.get(IMAGE_REFUSAL_KEY) {
        error_kind[IMAGE_REFUSAL_KEY] = refusal.clone();
    }
    out.insert("errorKind".into(), error_kind);
    // `turnFailureRecord`: a quota stop is the pool's proof, or an exhausted quota with the reset the provider named.
    if proof.is_some() || (kind == "quota_exhausted" && reset_at.is_some()) {
        out.insert("quota".into(), quota_record(proof, reset_at, route));
    }
    let descriptor =
        (provider.is_some() || proof.is_some()).then(|| Descriptor { kind: kind.to_owned(), code: code.clone(), status, retry_after_ms, reset_at });
    let timeout = facts.timeout;
    let view = ErrorView {
        is_object: true,
        message: error.message.clone(),
        name: "Error".into(),
        code: facts.code.clone().unwrap_or_default(),
        status,
        retry_after_ms: retry_after_ms.unwrap_or(0),
        descriptor,
        timeout_phase: timeout.map(|t| timeout_phase(t.phase)),
        waited_ms: timeout.map_or(0, |t| t.waited_ms),
        attempts: timeout.map_or(0, |t| t.attempts),
        fault: facts.fault.map(FaultFacts::fault),
        delivery: provider.and_then(|p| p.delivery).map(presented_delivery),
        ..ErrorView::default()
    };
    // The provider is named from the turn's own route, never from the error (`turn-failure.mjs:44`).
    let provider_label = (!route.provider.is_empty()).then(|| provider_display_name(route.provider));
    let options = PresentOptions { surface: "turn".into(), max: None, provider_label };
    let text = present_error_text(&view, &options);
    let shown = if SPECIAL.is_match(&text) || ERROR_COLON.is_match(&text) { text } else { format!("Error: {text}") };
    let detail = STRIP.replace_all_with(&shown, |_| String::new());
    // A failure with no message of its own has the derived sentence as its details, not its name.
    let details = if error.message.is_empty() { safe_error_details(&detail) } else { safe_error_details(error_text(error)) };
    out.insert("detail".into(), json!(detail));
    out.insert("errorDetails".into(), json!(details));
    Ok(out)
}

/// The one daemon-log line of a failed turn (Node 1.4.5's `[ask-error]`, `logAskError`): the session, the turn, the provider and
/// the typed cause of the failure; the message is the error's, else the sentence derived from its kind, delivery and fault.
pub(crate) fn failure_log_line(tag: &str, session: &str, turn: &str, error: &TurnError, route: &Route<'_>) -> String {
    let facts = ProviderFacts::of(error).unwrap_or_default();
    let provider = error.provider_error.as_ref();
    let delivery = match provider.and_then(|p| p.delivery) {
        Some(mixdog_protocol::DeliveryState::NotSent) => "not_sent",
        Some(mixdog_protocol::DeliveryState::Ambiguous) => "ambiguous",
        Some(mixdog_protocol::DeliveryState::Accepted) => "accepted",
        None => "-",
    };
    let msg: String = safe_error_details(&failure_text(error, route)).chars().take(300).collect();
    let mut line = format!(
        "[{tag}] session={session} turn={turn} provider={} kind={} code={} delivery={delivery} fault={}",
        provider.map_or(route.provider, |p| p.provider.as_str()),
        provider.map_or("unknown", |p| p.kind.as_str()),
        facts.code.as_deref().filter(|code| !code.is_empty()).unwrap_or("-"),
        facts.fault.map_or_else(|| "-".to_owned(), |fault| format!("{:?}", fault.fault())),
    );
    if let Some(connection) = &facts.connection {
        line.push_str(&format!(" connection={}/{}", connection.protocol, connection.id));
    }
    line.push_str(&format!(" msg={}", json!(msg)));
    line
}

/// The text of a failure: its message, else the sentence its kind, delivery and fault derive (the record's `detail`).
pub(crate) fn failure_text(error: &TurnError, route: &Route<'_>) -> String {
    if !error.message.is_empty() {
        return error.message.clone();
    }
    failure_record(error, route).ok().and_then(|record| record.get("detail").and_then(Value::as_str).map(str::to_owned)).unwrap_or_default()
}

/// Writes [`failure_log_line`] to the daemon log (`process.stderr.write`, the shard host's mirror into `daemon.log`): `ask-error`
/// for a failed turn, `agent-task-error` for a failed agent task.
pub(crate) fn log_failure(tag: &str, session: &str, turn: &str, error: &TurnError, route: &Route<'_>) {
    mixdog_rt::node_stderr!("{}", failure_log_line(tag, session, turn, error, route));
}

/// What `failedTurnCompletion` adds to the turn's own facts. `raw` is the turn's `meta.transcript`
/// (`transcriptMeta`): its `attemptId`, `at`, `completionVerb`, `checkpointId` and route fields.
pub(crate) struct Facts<'a> {
    pub raw: &'a Value,
    /// `askStartedAt`: when the run began, the start when `raw` has no `at`.
    pub started_at: i64,
    pub now: i64,
    pub attempt_id: String,
    pub route: Route<'a>,
}

impl Facts<'_> {
    /// A text field of the turn's `meta.transcript`, when it has one.
    pub(crate) fn text(&self, key: &str) -> Option<&str> {
        self.raw.get(key).and_then(Value::as_str).filter(|s| !s.is_empty())
    }

    /// The turn's `attemptId`: its own, else the fresh one (`raw.attemptId || randomUUID()`).
    pub(crate) fn attempt(&self) -> &str {
        self.text("attemptId").unwrap_or(&self.attempt_id)
    }

    /// The turn's `completionVerb`; `Thought` when it has none (`failedTurnCompletion`).
    pub(crate) fn verb(&self) -> &str {
        self.text("completionVerb").unwrap_or("Thought")
    }

    /// When the turn began: `raw.at`, else `askStartedAt`.
    pub(crate) fn started(&self) -> i64 {
        self.raw.get("at").and_then(Value::as_f64).filter(|at| *at != 0.0 && at.is_finite()).map_or(self.started_at, |at| at as i64)
    }
}

/// `failedTurnCompletion({ session, err, transcriptMeta, askStartedAt })`, keys in Node's order, over the
/// `turnFailureRecord` of the same error.
pub(crate) fn failed_completion(record: &Map<String, Value>, facts: &Facts<'_>) -> Value {
    let text = |key: &str| facts.text(key);
    let started = facts.started();
    let mut done = Map::new();
    done.insert("status".into(), json!("failed"));
    done.insert("attemptId".into(), json!(facts.attempt()));
    done.insert("at".into(), json!(started));
    done.insert("verb".into(), json!(facts.verb()));
    done.insert("elapsedMs".into(), json!((facts.now - started).max(0)));
    if let Some(checkpoint) = text("checkpointId") {
        done.insert("checkpointId".into(), json!(checkpoint));
    }
    for key in ["modelId", "model", "provider", "agent"] {
        if let Some(value) = text(key) {
            done.insert(key.into(), json!(value));
        }
    }
    for key in ["detail", "errorDetails", "errorKind", "quota"] {
        if let Some(value) = record.get(key).filter(|v| !v.as_str().is_some_and(str::is_empty)) {
            done.insert(key.into(), value.clone());
        }
    }
    Value::Object(done)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `providerKind` is the classified kind; an untyped error's usage-limit or billing wording reads as that kind
    /// (`legacyQuotaWording`), but never an error with a status, a code or retry advice.
    #[test]
    fn an_untyped_error_reads_a_usage_limit_from_its_wording() {
        let route = Route { provider: "p", model: "m" };
        let kind_of = |message: &str| {
            let error = TurnError { message: message.into(), data: Value::Null, provider_error: None };
            let record = failure_record(&error, &route).unwrap();
            (record["providerKind"].clone(), record["errorKind"]["kind"].clone())
        };
        assert_eq!(kind_of("You hit your usage limit."), (json!("quota_exhausted"), json!("quota_exhausted")));
        assert_eq!(kind_of("You exceeded your current quota"), (json!("billing"), json!("billing")));
        assert_eq!(kind_of("boom"), (json!("unknown"), json!("unknown")));
        let data = ProviderFacts { code: Some("x".into()), ..ProviderFacts::default() }.into_data(Value::Null);
        let typed = TurnError { message: "You hit your usage limit.".into(), data, provider_error: None };
        assert_eq!(failure_record(&typed, &route).unwrap()["providerKind"], json!("unknown"));
    }

    #[test]
    fn a_first_byte_timeout_names_the_turns_provider() {
        let timeout = TimeoutFacts { phase: TimeoutKind::FirstChunk, waited_ms: 30_000, attempts: 2 };
        let data = ProviderFacts { timeout: Some(timeout), ..ProviderFacts::default() }.into_data(Value::Null);
        let error = TurnError { message: "first byte timed out after 30000ms".into(), data, provider_error: None };
        let detail = |provider: &str| failure_record(&error, &Route { provider, model: "m" }).unwrap()["detail"].clone();
        assert_eq!(detail("anthropic-oauth"), json!("Model still thinking: no output in 30s; Anthropic OAuth sent nothing yet; attempts: 2."));
        assert_eq!(detail("my-gateway"), json!("Model still thinking: no output in 30s; my-gateway sent nothing yet; attempts: 2."));
        assert_eq!(detail(""), json!("Model still thinking: no output in 30s; the provider sent nothing yet; attempts: 2."));
    }

    #[test]
    fn the_run_hosts_provider_error_carries_what_the_record_reads() {
        use mixdog_core_api::domain::provider::ErrorKind;

        let mut refusal = ProviderError::new(ErrorKind::RateLimited, DeliveryState::Accepted);
        refusal.status = Some(429);
        refusal.code = Some("Rate_Limit_Exceeded".into());
        refusal.retry_after = Some(std::time::Duration::from_millis(4000));
        refusal.reset_at = Some(std::time::UNIX_EPOCH + std::time::Duration::from_millis(1_900_000_000_000));
        refusal.message = "Rate limit reached".into();
        let error = provider_turn_error(&refusal, "anthropic-oauth", json!({ "carriedReport": "kept" }));
        assert_eq!(error.data["carriedReport"], "kept", "the error's other typed fields stay");
        assert_eq!(
            ProviderFacts::of(&error).unwrap(),
            ProviderFacts {
                code: Some("Rate_Limit_Exceeded".into()),
                retry_after_ms: Some(4000),
                reset_at: Some(1_900_000_000_000),
                ..ProviderFacts::default()
            }
        );
        let detail = error.provider_error.as_ref().unwrap();
        assert_eq!(
            (detail.provider.as_str(), detail.status, detail.kind.as_str(), detail.delivery),
            ("anthropic-oauth", Some(429), "rate_limited", Some(mixdog_protocol::DeliveryState::Accepted))
        );
        let record = failure_record(&error, &Route { provider: "anthropic-oauth", model: "m" }).unwrap();
        assert_eq!(
            record["errorKind"],
            json!({ "kind": "rate_limited", "code": "rate_limit_exceeded", "status": 429, "retryAfterMs": 4000, "resetAt": 1_900_000_000_000_u64 })
        );
        assert!(!record.contains_key("quota"), "a rate limit is no quota stop");
    }

    #[test]
    fn a_refused_image_request_hands_its_blockers_and_their_ids_to_the_interface() {
        use mixdog_image_egress::NotSent;
        use mixdog_image_egress::Origin;
        use mixdog_image_egress::Reason;
        use mixdog_image_egress::Refusal;
        use mixdog_image_egress::Role;

        let origin = Origin {
            session: "s".into(),
            branch: String::new(),
            message_id: "row-7".into(),
            role: Role::User,
            tool_call_id: None,
            // Message 0 of the request, part 2 of the stored message: the part is what a later choice is saved under.
            part_path: vec![0, 2],
            display_name: "scan.heic".into(),
            turn: 3,
            tool_label: None,
        };
        let mut not_sent = NotSent::new(vec![Refusal::new(origin, Reason::NoVision)]);
        not_sent.offer_new_context(1);
        let refusal = ProviderError::images_not_sent(not_sent);
        let error = provider_turn_error(&refusal, "my-gateway", Value::Null);
        let record = failure_record(&error, &Route { provider: "my-gateway", model: "m" }).unwrap();
        let shown = &record["errorKind"]["imageRefusal"];
        assert_eq!(shown["blockers"][0]["messageId"], "row-7");
        assert_eq!(shown["blockers"][0]["part"], 2);
        assert_eq!(shown["blockers"][0]["name"], "scan.heic");
        assert_eq!(shown["blockers"][0]["actions"], json!(["replace", "continueWithout"]));
        assert_eq!(shown["newContextOffered"], true);
        assert!(shown["message"].as_str().unwrap().starts_with("Nothing was sent."), "{shown}");
        let plain = provider_turn_error(&ProviderError::new(mixdog_core_api::domain::provider::ErrorKind::Unknown, DeliveryState::NotSent), "p", Value::Null);
        assert!(
            failure_record(&plain, &Route { provider: "p", model: "m" }).unwrap()["errorKind"].get("imageRefusal").is_none(),
            "an ordinary failure carries none"
        );
    }

    /// The incident: an accepted stream cut by a connection-level error has an empty message. The failed turn's transcript row
    /// says what was lost, the typed cause rides the error to the row, the text and the log line, and the partial usage and
    /// the connection are kept.
    #[test]
    fn a_cut_stream_without_a_message_keeps_its_cause_to_the_row_and_the_log() {
        use mixdog_core_api::domain::provider::ConnectionInfo;
        use mixdog_core_api::domain::provider::Usage;

        let route = Route { provider: "anthropic-oauth", model: "m" };
        for (fault, code, sentence) in [
            (TransportFault::Reset, "ECONNRESET", "Connection to the provider was lost (ECONNRESET)."),
            (TransportFault::Closed, "UND_ERR_SOCKET", "Connection to the provider was lost (UND_ERR_SOCKET)."),
            (TransportFault::H2GoAway { code: 11 }, "ERR_HTTP2_GOAWAY_SESSION", "Connection to the provider was lost (ERR_HTTP2_GOAWAY_SESSION)."),
        ] {
            let mut cut = ProviderError::transport(fault.clone(), DeliveryState::Accepted);
            cut.connection = Some(ConnectionInfo { id: 7, protocol: "h2" });
            cut.partial_usage = Some(Box::new(Usage { input_tokens: 10, output_tokens: 3, ..Usage::default() }));
            assert!(cut.message.is_empty());
            let error = provider_turn_error(&cut, "anthropic-oauth", Value::Null);
            assert_eq!(error.message, sentence);
            let facts = ProviderFacts::of(&error).unwrap();
            assert_eq!(facts.fault.map(FaultFacts::fault), Some(fault.clone()));
            assert_eq!(facts.connection, Some(ConnectionFacts { id: 7, protocol: "h2".into() }));
            assert_eq!(facts.partial_usage, Some(PartialUsage { input_tokens: 10, output_tokens: 3, ..PartialUsage::default() }));
            assert_eq!(error.provider_error.as_ref().unwrap().delivery, Some(mixdog_protocol::DeliveryState::Accepted));
            // The row reads the same whether the message was filled in or an older writer left it empty.
            for message in [error.message.clone(), String::new()] {
                let row = failure_record(&TurnError { message, ..error.clone() }, &route).unwrap();
                assert_eq!(row["detail"], json!(sentence));
                assert_eq!(row["errorDetails"], json!(sentence));
                assert_eq!(row["errorKind"]["code"], json!(code.to_lowercase()));
            }
            let line = failure_log_line("ask-error", "s1", "t1", &error, &route);
            assert_eq!(
                line,
                format!(
                    "[ask-error] session=s1 turn=t1 provider=anthropic-oauth kind=transient code={code} delivery=accepted fault={fault:?} connection=h2/7 msg={}",
                    json!(sentence)
                )
            );
        }
    }

    /// A failure with neither message nor fault reads from its kind and delivery.
    #[test]
    fn an_empty_failure_reads_from_its_kind_and_delivery() {
        use mixdog_core_api::domain::provider::ErrorKind;

        let error = provider_turn_error(&ProviderError::new(ErrorKind::Overloaded, DeliveryState::NotSent), "p", Value::Null);
        assert_eq!(error.message, "The provider request failed (overloaded, before the request was sent).");
    }

    /// A `providerFacts` value this crate did not write is a typed error, not an error without facts; an error with
    /// none carries none.
    #[test]
    fn malformed_facts_are_a_typed_error_and_absent_facts_are_none() {
        let route = Route { provider: "p", model: "m" };
        let plain = TurnError { message: "boom".into(), data: Value::Null, provider_error: None };
        assert_eq!(ProviderFacts::of(&plain).unwrap(), ProviderFacts::default());
        let torn = TurnError { message: "boom".into(), data: json!({ "providerFacts": { "resetAt": "soon" } }), provider_error: None };
        assert!(matches!(ProviderFacts::of(&torn), Err(MalformedFacts(_))));
        assert!(failure_record(&torn, &route).is_err());
    }

    #[test]
    fn the_completion_takes_the_turns_identity_and_the_failure() {
        let error = TurnError { message: "boom".into(), data: json!({}), provider_error: None };
        let raw = json!({ "attemptId": "a1", "at": 100, "checkpointId": "c1", "provider": "p", "modelId": "m" });
        let facts = Facts { raw: &raw, started_at: 5, now: 160, attempt_id: "fresh".into(), route: Route { provider: "p", model: "m" } };
        assert_eq!(
            failed_completion(&failure_record(&error, &facts.route).unwrap(), &facts),
            json!({
                "status": "failed", "attemptId": "a1", "at": 100, "verb": "Thought", "elapsedMs": 60, "checkpointId": "c1",
                "modelId": "m", "provider": "p", "detail": "boom", "errorDetails": "boom",
                "errorKind": { "kind": "unknown", "code": "", "status": 0, "retryAfterMs": null, "resetAt": null },
            })
        );
        let bare = Facts { raw: &Value::Null, started_at: 5, now: 4, attempt_id: "fresh".into(), route: Route { provider: "p", model: "m" } };
        let done = failed_completion(&failure_record(&error, &bare.route).unwrap(), &bare);
        assert_eq!((done["attemptId"].clone(), done["at"].clone(), done["elapsedMs"].clone()), (json!("fresh"), json!(5), json!(0)));
    }
}
