//! Provider-neutral model request, stream vocabulary, typed provider errors
//! and the adapter/codec traits (PW §2–§3, SPEC §4.9).
//!
//! One `ProviderAdapter::attempt` is one request attempt. Retrying lives once,
//! above the adapters, driven by [`super::retry`]. Nothing here takes or arms a
//! timer: a stream dies only by the facts listed on [`TransportFault`], a
//! missing terminal event, a provider error, or the consumer dropping it.

use std::sync::Arc;
use std::time::Duration;
use std::time::SystemTime;

use async_trait::async_trait;
use mixdog_protocol::JsonValue;

use super::keepalive::KeepaliveSchedule;
use super::keepalive::TransportKind;
use super::retry::RetryPolicy;
use mixdog_protocol::ProviderId;

// ---------------------------------------------------------------------------
// Request
// ---------------------------------------------------------------------------

#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug)]
pub enum Role {
    System,
    User,
    Assistant,
    Tool,
    Developer,
}

/// Cache-breakpoint role of a system message (PW §5.1).
#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug)]
pub enum CacheTier {
    Tier3,
    Env,
}

#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug)]
pub enum Phase {
    Commentary,
    FinalAnswer,
}

#[derive(Clone, PartialEq, Eq, Debug)]
pub enum ImageSource {
    Base64 { data: String, mime_type: String },
    Url(String),
    FileId(String),
}

#[derive(Clone, PartialEq, Eq, Debug)]
pub enum BinarySource {
    Base64(String),
    AttachmentRef(String),
}

#[derive(Clone, PartialEq, Eq, Debug)]
pub enum DocumentSource {
    Base64 {
        media_type: String,
        data: String,
    },
    Text {
        media_type: Option<String>,
        data: String,
    },
    Content(JsonValue),
}

#[derive(Clone, PartialEq, Eq, Debug)]
pub enum ContentPart {
    Text(String),
    Image(ImageSource),
    File {
        source: BinarySource,
        mime_type: String,
        filename: Option<String>,
    },
    Document {
        source: DocumentSource,
        title: Option<String>,
    },
}

#[derive(Clone, PartialEq, Eq, Debug)]
pub enum Content {
    Text(String),
    Parts(Vec<ContentPart>),
}

#[derive(Clone, PartialEq, Eq, Debug)]
pub struct ToolCall {
    pub id: String,
    pub name: String,
    pub arguments: JsonValue,
}

/// A provider-opaque replay envelope. Only its owner reads it back.
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct ProviderReplay {
    pub owner: ProviderId,
    pub items: JsonValue,
}

/// Why a user message entered the history (affects folding into a preceding
/// tool result on Anthropic wires).
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum MessageSource {
    Steering,
    StreamCutRecovery,
}

#[derive(Clone, PartialEq, Eq, Debug)]
pub struct Message {
    pub role: Role,
    pub content: Content,
    pub cache_tier: Option<CacheTier>,
    /// Assistant only.
    pub tool_calls: Vec<ToolCall>,
    /// Tool only.
    pub tool_call_id: Option<String>,
    /// Tool only.
    pub is_error: bool,
    pub phase: Option<Phase>,
    pub thinking_blocks: Option<JsonValue>,
    pub assistant_blocks: Option<JsonValue>,
    pub native_tool_search: Option<JsonValue>,
    pub source: Option<MessageSource>,
    provider_replay: Vec<ProviderReplay>,
}

impl Message {
    pub fn new(role: Role, content: Content) -> Self {
        Self {
            role,
            content,
            cache_tier: None,
            tool_calls: Vec::new(),
            tool_call_id: None,
            is_error: false,
            phase: None,
            thinking_blocks: None,
            assistant_blocks: None,
            native_tool_search: None,
            source: None,
            provider_replay: Vec::new(),
        }
    }

    pub fn push_replay(&mut self, replay: ProviderReplay) {
        self.provider_replay.push(replay);
    }

    /// The only read access to replay envelopes: a provider never replays
    /// another provider's envelope.
    pub fn replay_for<'a>(
        &'a self,
        owner: &'a ProviderId,
    ) -> impl Iterator<Item = &'a ProviderReplay> + 'a {
        self.provider_replay
            .iter()
            .filter(move |r| &r.owner == owner)
    }
}

#[derive(Clone, PartialEq, Eq, Debug)]
pub struct ToolDefinition {
    pub name: String,
    pub description: String,
    pub input_schema: JsonValue,
}

/// Send options the adapters read (PW §2.1, §2.1a). Callbacks are replaced
/// by the [`StreamEvent`] stream; admission and account routing happen
/// before an attempt and are not adapter options.
#[derive(Clone, PartialEq, Eq, Debug, Default)]
pub struct RequestOptions {
    pub session_id: Option<String>,
    /// Connection pool key; `session_id` when absent.
    pub transport_scope: Option<String>,
    pub effort: Option<String>,
    pub model_max_output_tokens: Option<u32>,
    /// One-shot recovery override.
    pub max_output_tokens_override: Option<u32>,
    pub fast: bool,
    pub tool_choice: Option<String>,
    pub verbosity: Option<String>,
    pub request_kind: Option<String>,
    pub iteration: u32,
    pub prompt_cache_key: Option<String>,
    pub model_parameters: Option<JsonValue>,
}

#[derive(Clone, PartialEq, Eq, Debug)]
pub struct ModelRequest {
    pub model: String,
    pub messages: Vec<Message>,
    pub tools: Vec<ToolDefinition>,
    pub options: RequestOptions,
}

/// Bytes a codec produced for one attempt. The adapter adds credentials.
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct WireRequest {
    pub transport: TransportKind,
    pub method: String,
    pub url: String,
    pub headers: Vec<(String, String)>,
    pub body: Vec<u8>,
}

/// A non-success HTTP response or WS error, as received.
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct ErrorResponse {
    pub status: Option<u16>,
    pub headers: Vec<(String, String)>,
    pub body: Vec<u8>,
}

// ---------------------------------------------------------------------------
// Stream vocabulary (PW §2.3)
// ---------------------------------------------------------------------------

#[derive(Clone, PartialEq, Eq, Debug)]
pub enum StopReason {
    EndTurn,
    ToolUse,
    MaxTokens,
    StopSequence,
    ContentFilter,
    Refusal,
    /// Provider value outside the shared set, carried verbatim.
    Other(String),
}

#[derive(Clone, PartialEq, Eq, Debug, Default)]
pub struct Usage {
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cache_read_tokens: u64,
    pub cache_write_tokens: u64,
    pub reasoning_tokens: u64,
    /// The provider's usage object verbatim (ledger detail, service tier).
    pub raw: Option<JsonValue>,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum ItemKind {
    Text,
    Reasoning,
    Tool,
}

/// Deltas are hints; the folded result is the truth. Partial output of a dead
/// attempt is discarded by the consumer.
#[derive(Clone, PartialEq, Eq, Debug)]
pub enum StreamEvent {
    ItemStart {
        kind: ItemKind,
        phase: Option<Phase>,
    },
    TextDelta(String),
    ReasoningDelta(String),
    /// Opaque signature or encrypted reasoning kept for replay.
    ReasoningReplay(ProviderReplay),
    ToolCallStart {
        id: String,
        name: String,
    },
    ToolCallArgsDelta {
        id: String,
        delta: String,
    },
    ToolCallDone(ToolCall),
    Usage(Usage),
    Refusal(String),
    Citation(JsonValue),
    /// Provider-native block kept verbatim (Anthropic server tools).
    ServerToolBlock(JsonValue),
    /// Provider ping, SSE comment or keepalive event. Informational only:
    /// sets the display state `waitingOnProvider`; never progress, never death.
    ProviderKeepalive,
    /// The wire's terminal event. Exactly one per completed attempt, last.
    Completed {
        stop: StopReason,
    },
}

// ---------------------------------------------------------------------------
// Errors (PW §3)
// ---------------------------------------------------------------------------

#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug)]
pub enum ErrorKind {
    Overloaded,
    RateLimited,
    QuotaExhausted,
    Entitlement,
    Billing,
    Auth,
    Permission,
    ContextOverflow,
    RequestTooLarge,
    Policy,
    ServiceTierUnavailable,
    InvalidRequest,
    Transient,
    Unknown,
}

impl ErrorKind {
    pub const fn is_quota(self) -> bool {
        matches!(
            self,
            Self::QuotaExhausted | Self::Entitlement | Self::Billing
        )
    }
    pub const fn is_deterministic(self) -> bool {
        self.is_quota()
            || matches!(
                self,
                Self::Policy
                    | Self::Auth
                    | Self::Permission
                    | Self::ContextOverflow
                    | Self::RequestTooLarge
                    | Self::ServiceTierUnavailable
                    | Self::InvalidRequest
            )
    }
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum QuotaScope {
    Minute,
    Day,
    Plan,
}

/// What the stream had already exposed when it failed; set by the stream
/// state machine, never recomputed from text.
#[derive(Clone, Copy, PartialEq, Eq, Debug, Default)]
pub struct Exposure {
    pub text_emitted: bool,
    pub tool_dispatched: bool,
    pub tool_input_cut: bool,
}

/// How far the request got on the transport before the attempt failed.
/// Retry decisions and logs read it; it adds no user-visible text.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum DeliveryState {
    /// No request byte reached the socket.
    NotSent,
    /// The request was written; no response status arrived.
    Ambiguous,
    /// A response status (or WS acceptance of the request) arrived.
    Accepted,
}

/// The facts that end a link or stream (SPEC §4.9 cases 1–4).
#[derive(Clone, PartialEq, Eq, Debug)]
pub enum TransportFault {
    /// TCP connect failed (OS SYN retries exhausted, refused, unreachable).
    Connect {
        os_code: Option<i32>,
    },
    Dns,
    Reset,
    /// Peer closed (FIN) before the terminal event.
    Closed,
    Tls,
    H2GoAway {
        code: u32,
    },
    H2RstStream {
        code: u32,
    },
    WsClose {
        code: Option<u16>,
    },
    /// A keepalive probe went unanswered within its schedule.
    KeepaliveExpired {
        transport: TransportKind,
    },
    /// The body ended without the wire's terminal event.
    TruncatedStream,
    Io {
        os_code: Option<i32>,
    },
}

/// Classified once at the adapter boundary; downstream reads fields only.
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct ProviderError {
    pub kind: ErrorKind,
    /// Provider code verbatim (`CODE_KINDS` vocabulary).
    pub code: Option<String>,
    pub status: Option<u16>,
    pub retry_after: Option<Duration>,
    pub reset_at: Option<SystemTime>,
    pub quota_scope: Option<QuotaScope>,
    pub reauth_required: bool,
    /// Anthropic `x-should-retry`.
    pub should_retry: Option<bool>,
    pub exposure: Exposure,
    pub delivery: DeliveryState,
    pub transport: Option<TransportFault>,
    /// Provider message for logs; never matched.
    pub message: String,
}

impl ProviderError {
    pub fn new(kind: ErrorKind, delivery: DeliveryState) -> Self {
        Self {
            kind,
            code: None,
            status: None,
            retry_after: None,
            reset_at: None,
            quota_scope: None,
            reauth_required: false,
            should_retry: None,
            exposure: Exposure::default(),
            delivery,
            transport: None,
            message: String::new(),
        }
    }

    pub fn transport(fault: TransportFault, delivery: DeliveryState) -> Self {
        let mut err = Self::new(ErrorKind::Transient, delivery);
        err.transport = Some(fault);
        err
    }
}

// ---------------------------------------------------------------------------
// Traits
// ---------------------------------------------------------------------------

/// Incremental decoder for one attempt. Fed transport units in arrival
/// order: body chunks for HTTP, one message per call for WebSocket.
pub trait WireDecoder: Send {
    fn feed(&mut self, unit: &[u8]) -> Result<Vec<StreamEvent>, ProviderError>;
    /// End of body or connection close. If the terminal event was not seen,
    /// returns `TransportFault::TruncatedStream` (transient).
    fn finish(&mut self) -> Result<Vec<StreamEvent>, ProviderError>;
    fn terminal_seen(&self) -> bool;
    fn exposure(&self) -> Exposure;
}

/// Pure wire translation for one provider family: no I/O, no clock.
pub trait WireCodec: Send + Sync {
    fn transport(&self) -> TransportKind;
    fn encode(&self, request: &ModelRequest) -> Result<WireRequest, ProviderError>;
    fn decoder(&self) -> Box<dyn WireDecoder>;
    /// The single classification point for a failed response.
    fn classify(&self, response: &ErrorResponse) -> ProviderError;
}

/// One attempt's event stream. Ends with `Ok(Completed)` or one `Err`.
/// Dropping it aborts the attempt.
#[async_trait]
pub trait ModelStream: Send {
    async fn next(&mut self) -> Option<Result<StreamEvent, ProviderError>>;
    fn delivery(&self) -> DeliveryState;
}

#[async_trait]
pub trait ProviderAdapter: Send + Sync {
    fn id(&self) -> &ProviderId;
    fn codec(&self) -> &dyn WireCodec;
    fn retry_policy(&self) -> &RetryPolicy;
    fn keepalive(&self) -> &KeepaliveSchedule;
    /// Exactly one attempt; never retries internally. Dropping the future
    /// aborts the attempt.
    async fn attempt(
        &self,
        request: Arc<ModelRequest>,
    ) -> Result<Box<dyn ModelStream>, ProviderError>;
}
