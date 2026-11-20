//! Provider-neutral model request, stream vocabulary, typed provider errors
//! and the adapter/codec traits (PW §2–§3, SPEC §4.9).
//!
//! One `ProviderAdapter::attempt` is one request attempt. Retrying lives once,
//! above the adapters, driven by [`super::retry`]. Nothing here takes or arms a
//! timer: a stream dies only by the facts listed on [`TransportFault`], a
//! missing terminal event, a provider error, or the consumer dropping it.

use std::collections::BTreeMap;
use std::sync::Arc;
use std::time::Duration;
use std::time::SystemTime;

use async_trait::async_trait;
use mixdog_protocol::JsonValue;

use super::keepalive::KeepaliveSchedule;
use super::keepalive::TransportKind;
use super::retry::RetryPolicy;
use super::tool::Freeform;
use mixdog_protocol::ProviderId;
use mixdog_protocol::ThreadId;
use mixdog_protocol::TurnId;

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
    /// `width` / `height`: the image's pixel size where the tool that produced it reports it (Node's `{ type: 'image', width, height, source }`
    /// block, which the context estimator prices by); `None` for an image whose size is not known.
    Base64 { data: String, mime_type: String, width: Option<u32>, height: Option<u32> },
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

/// A stored `{type: "text", attachmentRef}` part: a text body kept in the blob store. Node's
/// `textKind` rides here, because `"file"` wraps the body as `<file name="…">` when it is lowered
/// to request text (`attachmentTextForPart`).
#[derive(Clone, PartialEq, Eq, Debug, Default)]
pub struct TextAttachment {
    pub kind: Option<String>,
}

#[derive(Clone, PartialEq, Eq, Debug)]
pub enum ContentPart {
    Text(String, Option<serde_json::Map<String, serde_json::Value>>),
    Image(ImageSource),
    File {
        source: BinarySource,
        mime_type: String,
        filename: Option<String>,
        /// `Some` when the part is a stored text attachment (Node `type: "text"`), whose
        /// `source` is then always an `AttachmentRef`; `None` for any other file.
        text: Option<TextAttachment>,
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

/// `providerMetadata.accountRouting`: the roster account of `provider` that served a message.
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct AccountRouting {
    pub provider: String,
    pub account_id: String,
    /// The account the session stays bound to (`sessionAccountId`); `None` on a message read back where the
    /// stored routing named none.
    pub session_account_id: Option<String>,
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
    /// The tail reminder: a user message built for one request, always the
    /// last message, never stored in the history. Every wire sends it; how:
    /// - Anthropic (API key and OAuth): its own text block appended to the
    ///   last user message (a new user message when there is none), after
    ///   the last cache breakpoint; with turn-scoped reminders, a system
    ///   message with `clear_at` instead.
    /// - Antigravity: a separate last `{role:"user", parts:[{text}]}`.
    /// - OpenAI-compatible Responses: a separate last user `input_text`.
    /// - Every other wire: an ordinary last user message.
    TailReminder,
}

#[derive(Clone, PartialEq, Eq, Debug)]
pub struct ToolDefinition {
    pub name: String,
    pub description: String,
    pub input_schema: JsonValue,
    /// Sent with `defer_loading: true` where the wire supports deferred
    /// tools (Responses tool search); other wires ignore it.
    pub defer_loading: bool,
    /// The raw-text form of the tool (`freeformDescription`, `freeform`): a Responses route that
    /// takes custom tools (`openai`, `openai-oauth`) sends it as a `custom` tool under this grammar
    /// instead of a function; every other wire ignores it.
    pub freeform: Option<Freeform>,
}

/// A tool a provider left out of a request because it cannot accept the tool's input schema
/// (Node's `{ name, index, pointer, reason, message }` for `opts.onToolExcluded`). `message` is the
/// whole report line; `pointer` and `reason` are what the session tells the user and the model.
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct ToolExclusionReport {
    pub name: String,
    pub index: usize,
    pub pointer: String,
    pub reason: String,
    pub message: String,
}

/// Node `opts.onToolExcluded`: where an adapter reports the tools it leaves out of a request. The
/// agent loop sets it to record them for the session; with none set the adapter logs the message.
#[derive(Clone)]
pub struct ToolExclusionSink(pub Arc<dyn Fn(ToolExclusionReport) + Send + Sync>);

impl ToolExclusionSink {
    pub fn report(&self, report: ToolExclusionReport) {
        (self.0)(report);
    }
}

impl PartialEq for ToolExclusionSink {
    fn eq(&self, other: &Self) -> bool {
        Arc::ptr_eq(&self.0, &other.0)
    }
}

impl Eq for ToolExclusionSink {}

impl std::fmt::Debug for ToolExclusionSink {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("ToolExclusionSink")
    }
}

/// What the first-byte timeouts of one send have cost so far ([`SendIdentity::first_byte_timeouts`]).
#[derive(Clone, Copy, Default, PartialEq, Eq, Debug)]
pub struct FirstByteTimeouts {
    pub count: u32,
    pub waited_ms: u64,
}

/// Where the window of a phase came from. Provenance only: whoever the source, the one driver at the model-exchange transport
/// boundary enforces the installed deadline.
#[derive(Clone, Copy, PartialEq, Eq, Debug, Default)]
pub enum PhaseOwner {
    /// The enabled provider policy declared the window.
    Provider,
    /// The provider declared none (or its stream policy is switched off): the common fallback policy's window.
    #[default]
    Fallback,
}

/// A fact about an attempt's response, published when it is observed. Headers, raw bytes and a complete protocol payload are
/// distinct: only these move the phase; transport, metadata and keepalives never do.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Boundary {
    /// A real exchange begins (every attempt, an adapter-internal retry and a re-issue included): its connection is made.
    AttemptStarted,
    /// The transport has its connection (a pooled one checked out, or a new one dialled): the request goes out now and the
    /// provider's silence is timed from here. A transport that cannot tell leaves the attempt connecting until its head.
    Connected,
    /// The response head arrived: the first-payload wait starts.
    HeadReceived,
    /// The first whole protocol record decoded, whether or not it carries output: the first-output wait starts.
    FirstProtocolPayload,
    /// The first text, reasoning or tool-protocol output: the idle window starts.
    FirstSemanticOutput,
    /// The attempt failed (a retry's back-off belongs to the retry schedule, not to the response).
    AttemptFailed,
    /// The attempt's response ended cleanly: it has no deadline.
    AttemptEnded,
}

impl Boundary {
    pub const fn name(self) -> &'static str {
        match self {
            Self::AttemptStarted => "attempt-started",
            Self::Connected => "connected",
            Self::HeadReceived => "head-received",
            Self::FirstProtocolPayload => "first-protocol-payload",
            Self::FirstSemanticOutput => "first-semantic-output",
            Self::AttemptFailed => "attempt-failed",
            Self::AttemptEnded => "attempt-ended",
        }
    }

    pub fn from_name(name: &str) -> Option<Self> {
        [Self::AttemptStarted, Self::Connected, Self::HeadReceived, Self::FirstProtocolPayload, Self::FirstSemanticOutput, Self::AttemptFailed, Self::AttemptEnded]
            .into_iter()
            .find(|boundary| boundary.name() == name)
    }
}

static ATTEMPT_IDS: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
static SUBMISSION_IDS: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

/// A fresh submission id, unique over the process: the send loop's own marker of a new unit of provider work (a logical request, a
/// route's first work), apart from any attempt a provider makes.
pub fn next_submission_id() -> u64 {
    SUBMISSION_IDS.fetch_add(1, std::sync::atomic::Ordering::SeqCst) + 1
}

/// The boundary a `boundary` stage payload carries: (submission, attempt id, boundary).
pub fn decode_boundary(payload: &serde_json::Value) -> Option<(u64, u64, Boundary)> {
    Some((
        payload.get("submission")?.as_u64()?,
        payload.get("attempt")?.as_u64()?,
        Boundary::from_name(payload.get("boundary")?.as_str()?)?,
    ))
}

/// A display stage an adapter raised, with the payload Node's `onStageChange(stage, payload)` carried.
pub type RaisedStage = (&'static str, Option<serde_json::Value>);

/// A session's pinned wire route (Node `session.wireRoute`: `{ provider, model, wire }`).
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct WirePin {
    pub provider: String,
    pub model: String,
    /// `chat`, `responses`, `messages` or `gemini`.
    pub wire: String,
    /// The stored route when it is a reroute (Node `source: 'reroute'`): every send on it reports it back
    /// (`wireReroute`), and its first `loweredAssistantCount` assistant turns go without their wire-native replay.
    pub reroute: Option<JsonValue>,
}

impl WirePin {
    /// The pin a stored `wireRoute` names; `None` without provider, model and wire.
    pub fn from_route(route: &JsonValue) -> Option<Self> {
        let field = |key: &str| route.get(key).and_then(JsonValue::as_str).filter(|s| !s.is_empty()).map(str::to_owned);
        let reroute = (route.get("source").and_then(JsonValue::as_str) == Some("reroute")).then(|| route.clone());
        Some(Self { provider: field("provider")?, model: field("model")?, wire: field("wire")?, reroute })
    }

    /// `loweredAssistantCount` of a rerouted pin; 0 otherwise.
    pub fn lowered_assistants(&self) -> usize {
        self.reroute.as_ref().and_then(|r| r.get("loweredAssistantCount")).and_then(JsonValue::as_u64).unwrap_or(0) as usize
    }
}

/// A tool the provider runs itself.
#[derive(Clone, PartialEq, Eq, Debug)]
pub enum HostedTool {
    WebSearch(HostedWebSearch),
}

/// Native web search, filled by the caller already normalized for the
/// route's family (Node `nativeWebSearchTool`); codecs render it as:
/// - Responses (openai, xai): `{type: tool_type, search_context_size?,
///   filters?: {allowed_domains}, user_location?}`;
/// - Anthropic: `{type: "web_search_20250305", name: "web_search", max_uses,
///   allowed_domains?, user_location?}`;
/// - Gemini: `{googleSearch: {}}` when `tool_type` is `google_search` or
///   `google_search_retrieval`.
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct HostedWebSearch {
    /// `web_search`, `web_search_preview` (Responses) or `google_search`.
    pub tool_type: String,
    /// Lowercased hostnames; empty sends no filter.
    pub allowed_domains: Vec<String>,
    pub user_location: Option<UserLocation>,
    /// Anthropic `max_uses`, 1..=10.
    pub max_uses: Option<u32>,
    /// Responses `search_context_size` (`low` when the caller named none).
    pub context_size: Option<String>,
    /// Responses: also request `include: ["web_search_call.action.sources"]`.
    pub include_sources: bool,
}

/// `user_location` of type `approximate`; at least one field is set.
#[derive(Clone, PartialEq, Eq, Debug, Default)]
pub struct UserLocation {
    pub country: Option<String>,
    pub region: Option<String>,
    pub city: Option<String>,
    pub timezone: Option<String>,
}

/// Effort in the route's wire values: `initial_effort` goes in the request's
/// reasoning options; each entry of `updates` is a configuration update that
/// takes effect at that message index of [`ModelRequest::messages`].
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct EffortProjection {
    pub initial_effort: String,
    pub updates: BTreeMap<usize, String>,
}

/// A sampling temperature: finite and non-negative.
#[derive(Clone, Copy, Debug)]
pub struct Temperature(f64);

impl Temperature {
    /// `None` for a NaN, infinite or negative value.
    pub fn new(value: f64) -> Option<Self> {
        (value.is_finite() && value >= 0.0).then_some(Self(value))
    }
    pub fn get(self) -> f64 {
        self.0
    }
}

// Sound: the constructor excludes NaN.
impl PartialEq for Temperature {
    fn eq(&self, other: &Self) -> bool {
        self.0 == other.0
    }
}
impl Eq for Temperature {}

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
    /// The response ended without ending the turn (Responses
    /// `end_turn: false`): the loop continues the turn as for `pause_turn`.
    ContinueTurn,
    /// Provider value outside the shared set, carried verbatim.
    Other(String),
}

#[derive(Clone, PartialEq, Eq, Debug, Default)]
pub struct Usage {
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cache_read_tokens: u64,
    pub cache_write_tokens: u64,
    /// The part of `cache_write_tokens` written with the 1-hour TTL
    /// (Anthropic `cache_creation.ephemeral_1h_input_tokens`); 0 when the
    /// provider reports no split. The 5-minute part is the remainder.
    pub cache_write_1h_tokens: u64,
    /// The generation tokens the provider reported; `None` when it reported
    /// none (missing is not zero, an explicit 0 stays `Some(0)`).
    pub reasoning_tokens: Option<u64>,
    /// `reasoningTokensComplete === false`: an aggregate in which some calls reported reasoning
    /// and some did not, so `reasoning_tokens` is a reported subtotal. Stored inverted so that a
    /// decoded figure reads as complete by default; read it through [`Usage::reasoning_complete`].
    pub reasoning_incomplete: bool,
    /// The provider's usage object verbatim (ledger detail, service tier).
    pub raw: Option<JsonValue>,
    /// What the provider billed for the request, when it reports it (xAI
    /// `cost_in_usd_ticks`, OpenRouter `cost`); never computed from prices.
    pub cost: Option<UsdTicks>,
}

impl Usage {
    /// `reasoningUsage(usage).reasoningTokensComplete` for a usage that carries its figure:
    /// a figure is present and was not marked incomplete.
    pub fn reasoning_complete(&self) -> bool {
        self.reasoning_tokens.is_some() && !self.reasoning_incomplete
    }

    /// `combineReasoningUsage(self, other)`: the count is `None` only when neither side reported,
    /// and the result is complete only when both sides are.
    pub fn combine_reasoning(&mut self, other: &Usage) {
        let complete = self.reasoning_complete() && other.reasoning_complete();
        self.reasoning_tokens = match (self.reasoning_tokens, other.reasoning_tokens) {
            (None, None) => None,
            (a, b) => Some(a.unwrap_or(0) + b.unwrap_or(0)),
        };
        self.reasoning_incomplete = !complete;
    }
}

/// An amount in xAI's unit: 1 tick = 10⁻¹⁰ USD.
#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Debug, Default)]
pub struct UsdTicks(pub u64);

impl UsdTicks {
    pub const PER_USD: u64 = 10_000_000_000;

    /// From a USD amount (OpenRouter `cost`), rounded to the nearest tick;
    /// `None` for a NaN, infinite or negative amount.
    pub fn from_usd(usd: f64) -> Option<Self> {
        (usd.is_finite() && usd >= 0.0).then(|| Self((usd * Self::PER_USD as f64).round() as u64))
    }
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum ItemKind {
    Text,
    Reasoning,
    Tool,
}

/// What a decoder reports to Node's `onStreamDelta(kind)` beyond the text and reasoning deltas themselves: the
/// semantic progress of the stream (`markSessionStreamDelta`), which refreshes liveness and the heartbeat.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum ProgressKind {
    /// Any other semantic event (an item boundary): the default kind.
    Semantic,
    Reasoning,
    Text,
    Tool,
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

/// Where a WebSocket send failed (Node `wsFailurePhase`): before a socket was acquired (the acquire, the upgrade), or
/// after it (the frame send or the stream itself).
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum WsPhase {
    Handshake,
    Stream,
}

/// The image a preparation refused: its base64, and the SHA-256 (lower-case hex) of its bytes when they decoded, which is
/// the content address of a stored copy. The preparation has the bytes in hand, so the recovery decodes and hashes
/// nothing.
#[derive(Clone, PartialEq, Eq)]
pub struct FailingImage {
    pub data: Box<str>,
    pub sha256: Option<Box<str>>,
}

/// Length and hash only: the base64 is megabytes of a user's image, and an error is formatted into logs.
impl std::fmt::Debug for FailingImage {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("FailingImage").field("base64_len", &self.data.len()).field("sha256", &self.sha256).finish()
    }
}

/// The stream window a watchdog fired in (`TIMEOUT_PHASE`, `shared/provider-timeout-phase.mjs`).
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum StreamTimeoutPhase {
    /// The response head did not come in the first-byte window (`headers`).
    Headers,
    /// Before the first payload (`first-chunk`).
    FirstChunk,
    /// After a payload, no further progress (`idle`).
    Idle,
}

impl StreamTimeoutPhase {
    /// `isFirstByteTimeout`: a timeout before the model produced anything, headers or first chunk.
    pub fn is_first_byte(self) -> bool {
        matches!(self, Self::Headers | Self::FirstChunk)
    }
}

/// One attempt's event stream. Ends with `Ok(Completed)` or one `Err`.
/// Dropping it aborts the attempt.
/// A provider's first-response budget (`{ transportMs, semanticMs }`), both positive.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct FirstResponseBudget {
    pub transport_ms: i64,
    pub semantic_ms: i64,
}

/// The document capabilities of one route (`providerTakesNativePdf`, `provider.nativeDocuments`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct MediaSupport {
    pub native_pdf: bool,
    pub native_documents: Option<bool>,
}

/// How a logical send ended when it did not succeed.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum SendEnd {
    /// The last failure is the send's result (no retry follows).
    Surfaced,
    /// The user cancelled it.
    Cancelled,
}

/// What the caller knows of one send when it asks for a model's wire. What
/// the provider knows (its per-model overrides, the catalog's wire, the
/// roster's endpoints) is added by the adapter.
#[derive(Clone, PartialEq, Eq, Debug, Default)]
pub struct WireRouteContext {
    /// An agent/tool session, or a send carrying tools.
    pub agent: bool,
    /// A session that predates the wire table: the wire it started on.
    pub legacy: bool,
    /// The wire the session already pinned (`chat`, `responses`, `messages`, `gemini`).
    pub keep: Option<String>,
    /// Wires that must not be chosen (the one a send was just refused on).
    pub exclude: Vec<String>,
}

/// One model's wire and why it was chosen. `wire` is `chat`, `responses`,
/// `messages` or `gemini`; `source` is `pinned`, `override`, `catalog`,
/// `endpoints`, `family`, `default`, `legacy` or `unknown` (an unknown route
/// is never pinned by a session).
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct WireRoute {
    pub wire: String,
    pub source: String,
    /// `<provider>:<wire>`.
    pub profile_id: String,
}

/// One value of a picker parameter; a context option carries the window it selects.
#[derive(Clone, PartialEq, Eq, Debug, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ParameterValue {
    pub value: String,
    pub label: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub context_window: Option<u64>,
}

/// A declared effort ladder (`reasoningOptions`: `{ type: 'effort', values }`).
#[derive(Clone, PartialEq, Eq, Debug, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReasoningOption {
    #[serde(rename = "type")]
    pub kind: String,
    pub values: Vec<String>,
}

/// A custom provider's reasoning wire contract (`customReasoning`).
#[derive(Clone, PartialEq, Eq, Debug, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CustomReasoning {
    pub wire_format: String,
    /// Effort level → the value sent on the wire.
    pub wire_values: std::collections::BTreeMap<String, String>,
    pub replay: bool,
}

/// The ids a picker model is sent under on the wire: one id, or one per
/// effort level (`(level, wire id)`, in the provider's order).
#[derive(Clone, PartialEq, Eq, Debug, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum WireIds {
    One(String),
    Tiers(Vec<(String, String)>),
}

/// The catalog lookup's output row for a listed model, kept so a persisted roster row carries the keys no typed field
/// holds (the pricing provenance, the function-calling flag, an explicit `null` where the catalog knows the model).
/// It is derived from the record, so it takes no part in comparing records.
#[derive(Clone, Default, Debug)]
pub struct EnrichedRow(pub Option<serde_json::Map<String, JsonValue>>);

impl PartialEq for EnrichedRow {
    fn eq(&self, _: &Self) -> bool {
        true
    }
}

#[cfg(test)]
mod reasoning_usage_tests {
    use super::Usage;

    fn reported(n: Option<u64>) -> Usage {
        Usage { reasoning_tokens: n, ..Usage::default() }
    }

    /// `combineReasoningUsage` (`reasoning-usage.mjs`): the count is null only when neither side
    /// reported, and the aggregate is complete only when both sides are.
    #[test]
    fn a_mixed_aggregate_keeps_the_subtotal_and_is_incomplete() {
        let mut total = reported(Some(5));
        total.combine_reasoning(&reported(None));
        assert_eq!((total.reasoning_tokens, total.reasoning_complete()), (Some(5), false));
        // Incomplete stays incomplete however many complete calls follow.
        total.combine_reasoning(&reported(Some(2)));
        assert_eq!((total.reasoning_tokens, total.reasoning_complete()), (Some(7), false));
    }

    #[test]
    fn calls_that_all_reported_stay_complete_and_a_reported_zero_is_a_figure() {
        let mut total = reported(Some(0));
        assert!(total.reasoning_complete());
        total.combine_reasoning(&reported(Some(0)));
        assert_eq!((total.reasoning_tokens, total.reasoning_complete()), (Some(0), true));
        total.combine_reasoning(&reported(Some(3)));
        assert_eq!((total.reasoning_tokens, total.reasoning_complete()), (Some(3), true));
    }

    #[test]
    fn nothing_reported_on_either_side_is_no_figure_and_not_complete() {
        let mut total = reported(None);
        total.combine_reasoning(&reported(None));
        assert_eq!((total.reasoning_tokens, total.reasoning_complete()), (None, false));
        // A side already marked incomplete makes the result incomplete.
        let mut flagged = Usage { reasoning_incomplete: true, ..reported(Some(4)) };
        flagged.combine_reasoning(&reported(Some(1)));
        assert_eq!((flagged.reasoning_tokens, flagged.reasoning_complete()), (Some(5), false));
    }
}


#[derive(Clone, PartialEq, Eq, Debug)]
pub struct ToolCall {
    pub id: String,
    pub name: String,
    pub arguments: JsonValue,
    /// The provider's native call item type when it is not a plain function
    /// call (Responses `custom_tool_call`, `local_shell_call`, …), verbatim,
    /// so replay sends the call back as the same item type; `None` for a
    /// function call.
    pub native_type: Option<String>,
}
/// The account pool's stages (Node `onStageChange`).
#[derive(Clone, PartialEq, Eq, Debug)]
pub enum AccountStage {
    /// `'reconnecting', { message }`: the pool moves on to the next account.
    Switching { message: String },
    /// `'account-changed', { provider, accountId, at }`: a fallback became the selected account.
    Changed { provider: String, account_id: String, at: i64 },
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
    /// Proof recorded when a scoped cache hit delivered the complete cached body.
    pub scoped_cache_source: Option<ScopedCacheSource>,
    pub phase: Option<Phase>,
    pub thinking_blocks: Option<JsonValue>,
    pub assistant_blocks: Option<JsonValue>,
    pub native_tool_search: Option<JsonValue>,
    pub source: Option<MessageSource>,
    /// Assistant only (Node `turnReminder`): the tail reminder the request
    /// that produced this turn carried. A codec on the turn-scoped layout
    /// re-sends it right before this message as the system message
    /// `{role:"system", clear_at:"next_user_message", content:[{type:"text",
    /// text}]}`, and sends the current [`MessageSource::TailReminder`] in that
    /// same shape; every other codec ignores it. The `clear_at` messages
    /// themselves are never stored: they derive from this text alone.
    pub turn_reminder: Option<String>,
    /// Assistant only: the roster account that served this turn, as its stored `providerMetadata.accountRouting`
    /// names it. An account pool passes this message's replay state to that account alone.
    pub account_routing: Option<AccountRouting>,
    /// Assistant only: the roster row Node's `replayAccount` names, the stored `providerReplay.accountId`, else the
    /// message's own `providerAccountId`. An account pool reads it for a message without [`Self::account_routing`].
    pub replay_account: Option<String>,
    /// Assistant only: the stored `providerMetadata.gemini` (`{thoughtParts, textParts}`), which a Gemini-wire request
    /// replays for a turn that has no replay envelope of its own (`geminiThoughtPartsFromMetadata`).
    pub gemini_metadata: Option<JsonValue>,
    /// User and tool only (Node `meta.sentRequestTail`): the message a provider request ended with when a restart
    /// or cancel cut it. An Anthropic wire keeps later user text beside it as sibling blocks instead of folding it
    /// in, so the cached prefix that request wrote is sent unchanged.
    pub sent_request_tail: bool,
    /// The stable id of the stored row this message was read from, when it has one. Never part of any wire body: it lets an
    /// image in this message be named, and recovered, by the same id after a restart.
    pub message_id: Option<String>,
    /// The position each content part has in the stored message, when a projection left some out (the image choices of a
    /// session); empty when every part is at its stored position. Never part of any wire body: an image is named, and a choice
    /// addresses it, by where the transcript keeps it.
    pub stored_parts: Vec<u32>,
    provider_replay: Vec<ProviderReplay>,
}
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct ScopedCacheSource {
    pub call_id: String,
    pub body_sha256: String,
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
            scoped_cache_source: None,
            phase: None,
            thinking_blocks: None,
            assistant_blocks: None,
            native_tool_search: None,
            source: None,
            turn_reminder: None,
            account_routing: None,
            replay_account: None,
            gemini_metadata: None,
            sent_request_tail: false,
            message_id: None,
            stored_parts: Vec::new(),
            provider_replay: Vec::new(),
        }
    }

    /// The provider's recorded form of this message, which encoders copy into their bodies as it was recorded: every replay
    /// envelope's items (of every owner), the ordered blocks, the thinking blocks and the Gemini metadata, in that order. Image
    /// preparation reads it whole, so an image anywhere in it is prepared like an image of the content.
    pub fn recorded_form(&self) -> impl Iterator<Item = &JsonValue> {
        self.provider_replay.iter().map(|r| &r.items).chain(&self.assistant_blocks).chain(&self.thinking_blocks).chain(&self.gemini_metadata)
    }

    /// [`Self::recorded_form`], for writing the prepared images into it (the same pieces in the same order).
    pub fn recorded_form_mut(&mut self) -> impl Iterator<Item = &mut JsonValue> {
        self.provider_replay
            .iter_mut()
            .map(|r| &mut r.items)
            .chain(&mut self.assistant_blocks)
            .chain(&mut self.thinking_blocks)
            .chain(&mut self.gemini_metadata)
    }

    /// Leave the recorded form out: the message is then encoded from its content alone. A choice that changes the message's
    /// images does this, since the recorded form would carry the images it was recorded with.
    pub fn clear_recorded_form(&mut self) {
        self.provider_replay.clear();
        self.assistant_blocks = None;
        self.thinking_blocks = None;
        self.gemini_metadata = None;
    }

    pub fn push_replay(&mut self, replay: ProviderReplay) {
        self.provider_replay.push(replay);
    }

    /// Keeps only the envelopes `keep` accepts.
    pub fn retain_replay(&mut self, keep: impl FnMut(&ProviderReplay) -> bool) {
        self.provider_replay.retain(keep);
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

    /// Every envelope, for code that keeps or moves messages whole (storage,
    /// compaction). A request encoder reads [`Self::replay_for`] instead.
    pub fn provider_replay(&self) -> &[ProviderReplay] {
        &self.provider_replay
    }
}
/// The roster row an account pool sent an attempt on (`account`) and the row it attributed history and state without a
/// stamp to (`home`).
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct SentOn {
    pub account: String,
    pub home: String,
}
impl SentOn {
    /// An attempt on the provider's current row `row`, which is also the row unstamped history is attributed to.
    pub fn current(row: String) -> Self {
        Self { account: row.clone(), home: row }
    }
}
/// The identity of one provider send, shared by every attempt of it (Node mints an id per `send` call, e.g. Grok's
/// `x-grok-req-id` and Antigravity's `requestId`, and the retry loop inside it reuses it). The id is minted by the first
/// attempt that asks; the broker gives each send a fresh one. Clones share the cell. It is not part of a request's
/// content: two identities always compare equal.
#[derive(Clone, Default, Debug)]
pub struct SendIdentity {
    id: std::sync::Arc<std::sync::Mutex<Option<String>>>,
    /// The wire a gateway's latest attempt of this send went out on: the send's own route (Node keeps it per send,
    /// `wire-route.mjs` `sendOnRoute`), so concurrent sends of one model on different wires never share it.
    wire: std::sync::Arc<std::sync::Mutex<Option<&'static str>>>,
    /// The roster row an account pool sent this send's latest attempt on, and the row that attempt attributed unstamped
    /// history to: the re-issue after a spent ladder goes out on that row with that attribution, as Node's runs inside
    /// that row's send.
    account: std::sync::Arc<std::sync::Mutex<Option<SentOn>>>,
    /// The attempts of this send that began so far.
    attempts: std::sync::Arc<std::sync::atomic::AtomicU32>,
    /// The display stages the adapter raised from inside an attempt (`onStageChange`), in order, for the caller to take
    /// after the attempt.
    stages: std::sync::Arc<std::sync::Mutex<Vec<RaisedStage>>>,
    /// Whether this send raised its once-per-send `requesting` yet.
    requested: std::sync::Arc<std::sync::atomic::AtomicBool>,
    /// The phase clock of the send's current attempt ([`AttemptContext`]): shared by the send future and the adapter's stream,
    /// restarted by every attempt. It holds no deadline of the logical send.
    attempt: std::sync::Arc<std::sync::Mutex<AttemptContext>>,
    /// The submission the run's send loop is in now ([`Self::begin_submission`]); an attempt begun while it is current belongs to it.
    submission: std::sync::Arc<std::sync::atomic::AtomicU64>,
    /// One origin for the logical send, including credential recovery and attempts that never opened a stream.
    origin: std::sync::Arc<std::sync::OnceLock<mixdog_rt::Deadline>>,
    refreshed_accounts: std::sync::Arc<std::sync::Mutex<std::collections::HashSet<String>>>,
    xai_http_fallback: std::sync::Arc<std::sync::atomic::AtomicBool>,
    /// The boundaries of attempts published and not yet delivered: (submission, attempt id, boundary).
    boundaries: std::sync::Arc<std::sync::Mutex<Vec<(u64, u64, Boundary)>>>,
    /// The first-byte timeouts this send has met (a response head or first chunk that did not come in its window) and the
    /// time they waited: a provider with a first-byte policy widens its next window by them and stops retrying past its
    /// cap (`send.firstByteTimeouts` / `firstByteWaitedMs`, `antigravity-transport.mjs`; `firstByteTimeouts`,
    /// `openai-compat-retry-profile.mjs`).
    first_byte: std::sync::Arc<std::sync::Mutex<FirstByteTimeouts>>,
    /// Transport marks raised and not yet delivered (`onStreamDelta('transport')`): bytes of the response arrived. Not a
    /// stage, not a keepalive and not progress; delivered apart from the stage list ([`Self::deliver_stages`]).
    transports: std::sync::Arc<std::sync::atomic::AtomicU32>,
    /// The speed tier (`priority`, `fast`, `ultrafast`) of the request the send's current attempt dispatched, empty while none
    /// went out or it was standard speed. For display grouping only: it is not the pricing tier. The adapter states it at
    /// the moment it hands a request to the transport, never from encoding or a picker preference; the accounting clears it
    /// before each attempt and reads it after, so one attempt's request never labels another's.
    dispatched_tier: std::sync::Arc<std::sync::Mutex<String>>,
}
/// The phase an attempt's response is in. One deadline belongs to the current phase of the current attempt. Three clocks, each
/// measuring one thing: connecting (from the attempt's start), the provider's silence before its first output (every window of
/// the head, payload and first-output phases counts from the one instant the connection was had, so a head that came late
/// leaves the later phases no fresh allowance), and the idle silence between outputs (from the last output). Waiting for
/// capacity happens before an attempt begins and belongs to none of them, and local work the consumer reports
/// ([`SendIdentity::local_work`]) is taken off whichever clock runs.
#[derive(Clone, Copy, PartialEq, Eq, Debug, Default)]
pub enum AttemptPhase {
    /// The attempt began; its connection is being had (a pool checkout, a dial, TLS). No provider is waited on yet.
    Connect,
    /// Sent; the response head is awaited.
    Head,
    /// The head came; the first complete protocol payload is awaited (the adapter's full first-byte window again).
    Payload,
    /// A protocol payload came; the first semantic output (text, reasoning or tool protocol) is awaited.
    FirstOutput,
    /// Output has come; each next progress is awaited under the idle window.
    Idle,
    /// The provider's non-streaming recovery runs under its generation-total bound.
    Recovery,
    /// The attempt failed or was replaced: it has no deadline and its late events change nothing.
    #[default]
    Retired,
}
/// The windows a provider declares for the phases of one attempt; `None` leaves the common fallback policy's.
#[derive(Clone, Copy, PartialEq, Eq, Debug, Default)]
pub struct PhaseWindows {
    /// The response head.
    pub head: Option<std::time::Duration>,
    /// The first whole protocol payload after the head (the provider's first-byte policy; the head's window again where none).
    pub payload: Option<std::time::Duration>,
    /// The first semantic output after a payload.
    pub first_output: Option<std::time::Duration>,
    /// Each next semantic progress once output began.
    pub idle: Option<std::time::Duration>,
    /// The non-streaming recovery: its generation total, head and whole body together.
    pub recovery: Option<std::time::Duration>,
}
impl PhaseWindows {
    pub const FALLBACK_HEAD: std::time::Duration = std::time::Duration::from_secs(120);
    pub const FALLBACK_FIRST_OUTPUT: std::time::Duration = std::time::Duration::from_secs(600);
    pub const FALLBACK_IDLE: std::time::Duration = std::time::Duration::from_secs(300);
    pub const FALLBACK_RECOVERY: std::time::Duration = std::time::Duration::from_secs(285);

    /// The window of `phase` and whom it came from; `None` for a retired attempt, which has no deadline.
    pub fn window(&self, phase: AttemptPhase) -> Option<(std::time::Duration, PhaseOwner)> {
        let pick = |declared: Option<std::time::Duration>, fallback| declared.map_or((fallback, PhaseOwner::Fallback), |window| (window, PhaseOwner::Provider));
        Some(match phase {
            // Connecting is bounded by the head's window as a backstop; the transport's own connect timeout ends a dial first.
            AttemptPhase::Connect | AttemptPhase::Head => pick(self.head, Self::FALLBACK_HEAD),
            AttemptPhase::Payload => pick(self.payload.or(self.head), Self::FALLBACK_HEAD),
            AttemptPhase::FirstOutput => pick(self.first_output, Self::FALLBACK_FIRST_OUTPUT),
            AttemptPhase::Idle => pick(self.idle, Self::FALLBACK_IDLE),
            AttemptPhase::Recovery => pick(self.recovery, Self::FALLBACK_RECOVERY),
            AttemptPhase::Retired => return None,
        })
    }
}
/// One attempt's phase clock. It is authoritative: entering a phase installs, together and atomically, the phase, the time it
/// began, its resolved window, where the window came from and the deadline. A transition never clears a deadline for someone
/// else to arm: the only attempt without one is a retired one.
#[derive(Clone, Copy, Debug, Default)]
pub struct AttemptContext {
    /// Unique over the process: a late event of a retired attempt carries an id that is no longer the current one.
    pub id: u64,
    pub phase: AttemptPhase,
    pub source: PhaseOwner,
    /// When the current phase began.
    pub started: Option<mixdog_rt::Deadline>,
    /// The resolved window of the current phase.
    pub window: std::time::Duration,
    /// When the current phase expires; `None` only once the attempt retired.
    pub deadline: Option<mixdog_rt::Deadline>,
    /// The submission this attempt began in: its boundaries carry it, so a late event of an older submission is recognised.
    pub submission: u64,
    /// When the attempt began.
    pub attempt_started: Option<mixdog_rt::Deadline>,
    /// When the provider's silence began to count (the connection was had): every pre-output window counts from here.
    pub silence_from: Option<mixdog_rt::Deadline>,
    windows: PhaseWindows,
    /// The idle deadline is renewed by the response's bytes, not by output.
    byte_idle: bool,
}
impl AttemptContext {
    /// Enters `phase`: its start, window and deadline are installed now. A pre-output window (head, payload, first output)
    /// counts from the start of the provider's silence, not from the boundary that entered it.
    fn enter(&mut self, phase: AttemptPhase) {
        self.phase = phase;
        let now = mixdog_rt::Deadline::after(std::time::Duration::ZERO);
        // A byte-idle deadline ([`AttemptHandle::renew_idle`]) belongs to the bytes: output observed later moves the phase,
        // never that deadline.
        if self.byte_idle && phase == AttemptPhase::Idle {
            self.started = Some(now);
            return;
        }
        match self.windows.window(phase) {
            Some((window, source)) => {
                self.window = window;
                self.source = source;
                self.started = Some(now);
                self.deadline = Some(match (phase, self.silence_from) {
                    (AttemptPhase::Head | AttemptPhase::Payload | AttemptPhase::FirstOutput, Some(from)) => mixdog_rt::Deadline::from(from, window),
                    _ => mixdog_rt::Deadline::after(window),
                });
            }
            None => self.deadline = None,
        }
    }
}
/// A span of the consumer's own work ([`SendIdentity::local_work`]): dropped, it moves the attempt's running deadline, and the
/// start of its silence, later by the span's length. Nothing changes once a later attempt began or this one retired.
pub struct LocalWork {
    identity: SendIdentity,
    attempt: u64,
    since: mixdog_rt::Deadline,
}
impl Drop for LocalWork {
    fn drop(&mut self) {
        let spent = self.since.elapsed();
        if spent.is_zero() {
            return;
        }
        let mut ctx = self.identity.attempt.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        if ctx.id != self.attempt || ctx.phase == AttemptPhase::Retired {
            return;
        }
        ctx.deadline = ctx.deadline.map(|deadline| deadline.later_by(spent));
        ctx.silence_from = ctx.silence_from.map(|from| from.later_by(spent));
    }
}
/// The handle an adapter holds for the attempt it started: its events move that attempt only.
#[derive(Clone, Debug)]
pub struct AttemptHandle {
    identity: SendIdentity,
    id: u64,
}
impl AttemptHandle {
    pub fn id(&self) -> u64 {
        self.id
    }

    /// Publishes `boundary` for this attempt; nothing happens once a later attempt has begun or this one retired.
    pub fn observe(&self, boundary: Boundary) {
        self.identity.apply(Some(self.id), boundary);
    }

    /// A non-empty body chunk of this attempt arrived after its first payload: a provider whose idle window is a byte-idle limit
    /// restarts that window now, whatever the bytes decode to. It is no boundary, no output and no keepalive, and the phase does
    /// not move; before the first payload, after a later attempt began or once this one retired, nothing changes.
    pub fn renew_idle(&self) {
        self.identity.renew_idle(self.id);
    }

    /// The attempt's clock while it is still the current one and has not retired: what a driver reads to follow the deadline of
    /// the phase it waits in. `None` once a later attempt began or this one ended, whatever the old handle's holder still does.
    pub fn context(&self) -> Option<AttemptContext> {
        let ctx = self.identity.attempt_context();
        (ctx.id == self.id && ctx.phase != AttemptPhase::Retired).then_some(ctx)
    }

}
impl SendIdentity {
    /// The first-byte timeouts this send has met.
    pub fn first_byte_timeouts(&self) -> FirstByteTimeouts {
        *self.first_byte.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    /// An attempt of this send timed out in a first-byte window of `window_ms`: the totals with it counted.
    pub fn note_first_byte_timeout(&self, window_ms: u64) -> FirstByteTimeouts {
        let mut met = self.first_byte.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        met.count += 1;
        met.waited_ms += window_ms;
        *met
    }

    /// Raises a display stage from inside an attempt. `transport` is not a stage: it is the transport mark
    /// ([`Self::raise_transport`]) and never enters the stage list.
    pub fn raise_stage(&self, stage: &'static str) {
        if stage == "transport" {
            self.raise_transport();
            return;
        }
        self.stages.lock().unwrap_or_else(std::sync::PoisonError::into_inner).push((stage, None));
    }

    /// The response's bytes arrived (the head, a chunk): transport health for the run's watchdog, which moves it from its
    /// first-transport window to its first-output one. It is no semantic progress and no keepalive.
    pub fn raise_transport(&self) {
        self.transports.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    }

    /// A model exchange begins: the previous attempt retires and a fresh clock starts in the head wait (or, for the
    /// non-streaming `recovery`, in the generation total that covers head and body). The model-exchange driver is the only
    /// production caller: it enforces the deadline this installs.
    pub fn begin_attempt(&self, windows: PhaseWindows, recovery: bool) -> AttemptHandle {
        self.begin(windows, if recovery { AttemptPhase::Recovery } else { AttemptPhase::Head })
    }

    /// [`Self::begin_attempt`] over a transport that reports when it has its connection ([`Boundary::Connected`]): the attempt
    /// starts connecting, and the provider's silence is timed from the connection, not from the attempt's start.
    pub fn begin_connecting_attempt(&self, windows: PhaseWindows) -> AttemptHandle {
        self.begin(windows, AttemptPhase::Connect)
    }

    fn begin(&self, windows: PhaseWindows, first: AttemptPhase) -> AttemptHandle {
        let id = ATTEMPT_IDS.fetch_add(1, std::sync::atomic::Ordering::SeqCst) + 1;
        let submission = self.submission.load(std::sync::atomic::Ordering::SeqCst);
        let started = mixdog_rt::Deadline::after(std::time::Duration::ZERO);
        // Without a connection report the silence counts from the attempt's start.
        let silence_from = (first == AttemptPhase::Head).then_some(started);
        let mut ctx = AttemptContext { id, submission, windows, attempt_started: Some(started), silence_from, ..AttemptContext::default() };
        ctx.enter(first);
        *self.attempt.lock().unwrap_or_else(std::sync::PoisonError::into_inner) = ctx;
        self.publish(submission, id, Boundary::AttemptStarted);
        AttemptHandle { identity: self.clone(), id }
    }

    /// The send loop begins a unit of provider work (before `attempt`, a projected attempt or `recover_spent`, for every provider
    /// whether or not it goes through the driver): the attempts begun from now on belong to the returned submission, and those
    /// of an older one stay recognisable by theirs. The send's identity itself is not replaced.
    pub fn begin_submission(&self) -> u64 {
        self.elapsed();
        let id = next_submission_id();
        self.submission.store(id, std::sync::atomic::Ordering::SeqCst);
        id
    }

    pub fn elapsed(&self) -> std::time::Duration {
        self.origin.get_or_init(|| mixdog_rt::Deadline::after(std::time::Duration::ZERO)).elapsed()
    }

    /// Outer transport retries must not start the same account's credential-rejection ladder again.
    pub fn claim_refresh(&self, account: String) -> bool {
        self.refreshed_accounts.lock().unwrap_or_else(std::sync::PoisonError::into_inner).insert(account)
    }

    /// The xAI send switched from WebSocket to HTTP; retries stay on HTTP for this send.
    pub fn use_xai_http_fallback(&self) {
        self.xai_http_fallback.store(true, std::sync::atomic::Ordering::SeqCst);
    }

    pub fn xai_http_fallback(&self) -> bool {
        self.xai_http_fallback.load(std::sync::atomic::Ordering::SeqCst)
    }

    /// The current attempt's clock.
    pub fn attempt_context(&self) -> AttemptContext {
        *self.attempt.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    /// Publishes a boundary of the current attempt, as the send future observes it.
    pub fn observe(&self, boundary: Boundary) {
        self.apply(None, boundary);
    }

    /// The consumer of this send's response is doing work of its own (it holds the stream unread, e.g. to start a streamed tool
    /// call): until the guard drops, the current attempt's clock does not count that time as the provider's silence.
    pub fn local_work(&self) -> LocalWork {
        let ctx = self.attempt_context();
        LocalWork { identity: self.clone(), attempt: ctx.id, since: mixdog_rt::Deadline::after(std::time::Duration::ZERO) }
    }

    fn renew_idle(&self, id: u64) {
        let mut ctx = self.attempt.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        if ctx.id != id || !matches!(ctx.phase, AttemptPhase::FirstOutput | AttemptPhase::Idle) {
            return;
        }
        let Some(idle) = ctx.windows.idle else { return };
        ctx.window = idle;
        ctx.source = PhaseOwner::Provider;
        ctx.byte_idle = true;
        ctx.deadline = Some(mixdog_rt::Deadline::after(idle));
    }

    fn publish(&self, submission: u64, attempt: u64, boundary: Boundary) {
        mixdog_rt::node_log::provider_boundary(submission, attempt, boundary.name());
        self.boundaries.lock().unwrap_or_else(std::sync::PoisonError::into_inner).push((submission, attempt, boundary));
    }

    /// Moves the current attempt (or, with `only`, that attempt if it is still current) to the phase `boundary` enters, publishing
    /// each boundary it passes: a payload that carries output makes both transitions at once.
    fn apply(&self, only: Option<u64>, boundary: Boundary) {
        let mut ctx = self.attempt.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        if only.is_some_and(|id| id != ctx.id) || ctx.phase == AttemptPhase::Retired {
            return;
        }
        let (id, submission) = (ctx.id, ctx.submission);
        match boundary {
            Boundary::AttemptStarted => {}
            Boundary::AttemptFailed | Boundary::AttemptEnded => {
                ctx.phase = AttemptPhase::Retired;
                ctx.deadline = None;
                drop(ctx);
                self.publish(submission, id, boundary);
            }
            // Output after output renews the idle window and is no boundary.
            Boundary::FirstSemanticOutput if ctx.phase == AttemptPhase::Idle => ctx.enter(AttemptPhase::Idle),
            Boundary::Connected | Boundary::HeadReceived | Boundary::FirstProtocolPayload | Boundary::FirstSemanticOutput => {
                let steps = [
                    (AttemptPhase::Connect, Boundary::Connected, AttemptPhase::Head),
                    (AttemptPhase::Head, Boundary::HeadReceived, AttemptPhase::Payload),
                    (AttemptPhase::Payload, Boundary::FirstProtocolPayload, AttemptPhase::FirstOutput),
                    (AttemptPhase::FirstOutput, Boundary::FirstSemanticOutput, AttemptPhase::Idle),
                ];
                let mut passed = Vec::new();
                for (from, step, to) in steps {
                    if ctx.phase == from {
                        if from == AttemptPhase::Connect {
                            // The silence counts from the connection; a transport that never said when it had one is timed
                            // from the attempt's start, as connecting and the provider's silence cannot be told apart there.
                            ctx.silence_from = if boundary == Boundary::Connected { Some(mixdog_rt::Deadline::after(std::time::Duration::ZERO)) } else { ctx.attempt_started };
                        }
                        ctx.enter(to);
                        // An implicit pass of the connection is not reported as one: no transport said when it happened.
                        if step != Boundary::Connected || boundary == Boundary::Connected {
                            passed.push(step);
                        }
                    }
                    if step == boundary {
                        break;
                    }
                }
                drop(ctx);
                for step in passed {
                    self.publish(submission, id, step);
                }
            }
        }
    }

    /// Hands every published boundary to `deliver` as a `boundary` stage whose payload [`decode_boundary`] reads.
    pub fn take_boundaries(&self) -> Vec<(u64, Boundary)> {
        self.take_published().into_iter().map(|(_, attempt, boundary)| (attempt, boundary)).collect()
    }

    /// [Self::take_boundaries] with the submission each boundary's attempt began in.
    pub fn take_published(&self) -> Vec<(u64, u64, Boundary)> {
        std::mem::take(&mut *self.boundaries.lock().unwrap_or_else(std::sync::PoisonError::into_inner))
    }

    /// Whether a transport mark was raised since the last call.
    pub fn take_transport(&self) -> bool {
        self.transports.swap(0, std::sync::atomic::Ordering::SeqCst) > 0
    }

    /// Raises a display stage that carries a payload.
    pub fn raise_stage_with(&self, stage: &'static str, payload: serde_json::Value) {
        if stage == "transport" {
            self.raise_transport();
            return;
        }
        self.stages.lock().unwrap_or_else(std::sync::PoisonError::into_inner).push((stage, Some(payload)));
    }

    /// Raises `requesting` for a provider that raises it once before its whole retry ladder (Node raises it outside
    /// `withRetry`): the send's first attempt raises it, a retry does not; a re-issue ([`Self::reissue`]) raises it again.
    pub fn raise_requesting_once(&self) {
        if !self.requested.swap(true, std::sync::atomic::Ordering::SeqCst) {
            self.raise_stage("requesting");
        }
    }

    /// The send begins its ladder again (a stream re-issued after output, a credential reloaded and the send run anew):
    /// the once-per-ladder `requesting` is raised again by the next attempt.
    pub fn reissue(&self) {
        self.requested.store(false, std::sync::atomic::Ordering::SeqCst);
    }

    /// The stages raised inside the attempt that ended, in order.
    pub fn take_stages(&self) -> Vec<RaisedStage> {
        std::mem::take(&mut *self.stages.lock().unwrap_or_else(std::sync::PoisonError::into_inner))
    }

    /// Hands every stage and transport mark raised so far to `deliver`, in the order raised (the transport mark last).
    pub fn deliver_pending(&self, mut deliver: impl FnMut(&'static str, Option<serde_json::Value>)) {
        for (submission, attempt, boundary) in self.take_published() {
            deliver("boundary", Some(serde_json::json!({ "submission": submission, "attempt": attempt, "boundary": boundary.name() })));
        }
        for (stage, payload) in self.take_stages() {
            deliver(stage, payload);
        }
        if self.take_transport() {
            deliver("transport", None);
        }
    }

    /// Runs `attempt`, handing each stage it raises to `deliver` right after the poll that raised it, so a stage is seen
    /// when the request goes out and not when the attempt (which may read the response's first output) ends.
    pub async fn deliver_stages<F: std::future::Future>(&self, attempt: F, mut deliver: impl FnMut(&'static str, Option<serde_json::Value>)) -> F::Output {
        let mut attempt = std::pin::pin!(attempt);
        std::future::poll_fn(|cx| {
            let polled = attempt.as_mut().poll(cx);
            self.deliver_pending(&mut deliver);
            polled
        })
        .await
    }

    /// Marks an attempt of this send as begun and returns how many began before it: 0 for the send's first attempt,
    /// more for a retry.
    pub fn next_attempt(&self) -> u32 {
        self.attempts.fetch_add(1, std::sync::atomic::Ordering::SeqCst)
    }

    /// The send's attempts count from the first again: the adapter re-sends the request as a new request of its own (Node
    /// runs its request loop anew).
    pub fn restart_attempts(&self) {
        self.attempts.store(0, std::sync::atomic::Ordering::SeqCst);
    }

    /// A request carrying `tier` (empty: standard speed) is being handed to the transport for the current attempt.
    pub fn note_dispatched_speed_tier(&self, tier: &str) {
        tier.clone_into(&mut self.dispatched_tier.lock().unwrap_or_else(std::sync::PoisonError::into_inner));
    }

    /// The speed tier of the request the current attempt dispatched last; empty when none went out.
    pub fn dispatched_speed_tier(&self) -> String {
        self.dispatched_tier.lock().unwrap_or_else(std::sync::PoisonError::into_inner).clone()
    }

    /// The send's id, minted with `mint` by the first caller.
    pub fn get_or_mint(&self, mint: impl FnOnce() -> String) -> String {
        self.id.lock().unwrap_or_else(std::sync::PoisonError::into_inner).get_or_insert_with(mint).clone()
    }

    /// The send's id is minted anew by the next caller of [`Self::get_or_mint`]: a request the adapter makes of its own, as Node
    /// calls `send` again (Grok's version gate).
    pub fn remint(&self) {
        *self.id.lock().unwrap_or_else(std::sync::PoisonError::into_inner) = None;
    }

    /// Records the wire an attempt of this send went out on.
    pub fn set_wire(&self, wire: &'static str) {
        *self.wire.lock().unwrap_or_else(std::sync::PoisonError::into_inner) = Some(wire);
    }

    /// The wire the send's latest attempt went out on, once one did.
    pub fn wire(&self) -> Option<&'static str> {
        *self.wire.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    /// Records the roster row an attempt of this send went out on, and the row it attributed unstamped history to.
    pub fn set_account(&self, sent: SentOn) {
        *self.account.lock().unwrap_or_else(std::sync::PoisonError::into_inner) = Some(sent);
    }

    /// Where the send's latest attempt went out, once one did.
    pub fn account(&self) -> Option<SentOn> {
        self.account.lock().unwrap_or_else(std::sync::PoisonError::into_inner).clone()
    }
}
impl PartialEq for SendIdentity {
    fn eq(&self, _: &Self) -> bool {
        true
    }
}
impl Eq for SendIdentity {}
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
    /// `None` is the wire default (`auto`); `"auto"`, `"none"`, `"required"`,
    /// or a tool name, which forces that tool.
    pub tool_choice: Option<String>,
    pub verbosity: Option<String>,
    pub request_kind: Option<String>,
    pub iteration: u32,
    pub prompt_cache_key: Option<String>,
    /// Node `promptCacheScope`: `"shared"` keys the prompt cache on the
    /// request's prefix instead of its session (one-shot maintenance roles,
    /// session-less explorers). `None` keeps the session scope.
    pub prompt_cache_scope: Option<String>,
    /// Node `xaiResponsesCacheScope`: an explicit xAI cache routing scope
    /// (`session`, `prefix`, `none`, `off`, `omit`); `None` takes the default.
    pub xai_responses_cache_scope: Option<String>,
    /// Per-send public xAI API and Responses transport overrides. Grok OAuth ignores these.
    pub xai_api_mode: Option<String>,
    pub xai_responses_transport: Option<String>,
    pub model_parameters: Option<JsonValue>,
    /// The thread, context window and turn the request serves; `None` for a
    /// request outside any thread.
    pub thread: Option<RequestThread>,
    /// The session that spawned this one (a sub-agent's parent).
    pub parent_session_id: Option<String>,
    /// `None` sends the wire's default (or omits the field).
    pub parallel_tool_calls: Option<bool>,
    /// `None` sends no temperature.
    pub temperature: Option<Temperature>,
    /// The conversation's effort history for wires that replay it (Responses):
    /// the agent fills it, the adapter encodes it. `None` sends `effort` alone.
    pub effort_projection: Option<EffortProjection>,
    /// Provider-hosted tools sent ahead of the function tools (Node
    /// `opts.nativeTools`). Each codec renders the ones its wire hosts and
    /// skips the rest; empty sends none.
    pub hosted_tools: Vec<HostedTool>,
    /// Node `sharedCachePrefixCount`: this request forks an earlier one (a
    /// side question, a compaction summary) that re-sends its first `n`
    /// messages unchanged and appends a short suffix. The fork only reads the
    /// session's live prompt cache: Anthropic keeps a message breakpoint on
    /// the shared prefix and never continues a response thread; Gemini never
    /// creates or refreshes an explicit cache. `None` is an ordinary request.
    pub shared_cache_prefix_count: Option<usize>,
    /// Node `opts.providerState`: the session's saved provider-native state,
    /// filled by the agent from the session. A provider reads only its own key
    /// and reports a change on [`StreamEvent::ProviderState`].
    pub provider_state: Option<ProviderState>,
    /// The logical send this request is an attempt of: the same id on every attempt the loop's
    /// retry decider replays (`Retry`, `Fallback`), a new id for any other send. Node's
    /// `provider.send` retries internally and writes one ledger row with `attempts`; the accounting
    /// folds the attempts of one group into that row. The loop settles the group with
    /// [`ProviderAdapter::settle_send`] when the logical send ends without success.
    pub send_group: Option<String>,
    /// Node `opts.usageSessionId`: a request isolated under its own provider session id (a
    /// compaction's `:compact`) whose spend belongs to this session.
    pub usage_session_id: Option<String>,
    /// Node `opts.sourceType`: the ledger source of a request that is not a kind the provider is told (a title call is `session-title` while the provider sees a plain request). `request_kind` is the fallback.
    pub source_type: Option<String>,
    /// Node `opts.onToolExcluded`: where a tool the adapter leaves out of this request is reported.
    pub on_tool_excluded: Option<ToolExclusionSink>,
    /// Node `session.wireRoute`: the wire the session pinned for a provider and model. A gateway sends on it while
    /// it names the gateway and the request's model and the model is still offered there (`sendWireRoute`).
    pub wire_pin: Option<WirePin>,
    /// The send these options belong to, for the ids Node mints once per send.
    pub send_identity: SendIdentity,
    /// The owner of the session's transcript-cache book, asked to admit each attempt immediately before transport.
    /// `None`: no session owns this request's transcript.
    pub tail_gate: Option<super::cache_tail::TailGateHandle>,
    /// What the attempt is for, as the gate judges it.
    pub tail_purpose: super::cache_tail::Purpose,
    /// The book generation the request's transcript was prepared against: an attempt prepared before a rewrite of the
    /// history is refused. `None`: prepared now.
    pub tail_generation: Option<u64>,
    /// The leave a failed rewrite handed the caller that owned it, carried by the one request it was decided for.
    pub tail_unreduced: Option<super::cache_tail::Unreduced>,
}
/// The session's saved provider-native state (Node `session.providerState`).
#[derive(Clone, PartialEq, Eq, Debug, Default, serde::Serialize, serde::Deserialize)]
pub struct ProviderState {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub gemini: Option<GeminiCacheState>,
    /// Every other key of Node's `providerState` (OpenAI continuation slots,
    /// `xaiResponses`, `providerAccountId`, …), owned by their providers and
    /// kept verbatim so a round trip drops nothing.
    #[serde(flatten)]
    pub rest: serde_json::Map<String, serde_json::Value>,
}
impl ProviderState {
    /// The state as JSON, equal to `serde_json::to_value(self)`. Built from the fields, not serialised, because it
    /// cannot fail (strings, numbers and an already-JSON map) and a caller that carries it must not need a fallback.
    pub fn to_json(&self) -> serde_json::Value {
        let Self { gemini, rest } = self;
        let mut out = serde_json::Map::new();
        if let Some(gemini) = gemini {
            out.insert("gemini".to_owned(), gemini.to_json());
        }
        // The flattened keys come after `gemini`, as serde writes them.
        out.extend(rest.iter().map(|(key, value)| (key.clone(), value.clone())));
        serde_json::Value::Object(out)
    }
}
/// Node `providerState.gemini`, field for field (JSON keys are Node's).
#[derive(Clone, PartialEq, Eq, Debug, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GeminiCacheState {
    /// `cachedContents/<id>`.
    pub cache_name: String,
    /// Epoch ms.
    pub cache_created_at: u64,
    /// The request iteration that attached it.
    pub cache_created_at_iter: u32,
    /// Epoch ms.
    pub cache_expires_at: u64,
    pub cache_model: String,
    pub cache_token_size: u64,
    pub cache_prefix_content_count: usize,
    pub cache_prefix_hash: String,
    pub cache_credential_fingerprint: String,
}
impl GeminiCacheState {
    /// The state as JSON, equal to `serde_json::to_value(self)` (see [`ProviderState::to_json`]). The destructuring
    /// names every field: a field added without its key stops compiling here.
    pub fn to_json(&self) -> serde_json::Value {
        let Self {
            cache_name,
            cache_created_at,
            cache_created_at_iter,
            cache_expires_at,
            cache_model,
            cache_token_size,
            cache_prefix_content_count,
            cache_prefix_hash,
            cache_credential_fingerprint,
        } = self;
        let mut out = serde_json::Map::new();
        out.insert("cacheName".to_owned(), cache_name.clone().into());
        out.insert("cacheCreatedAt".to_owned(), (*cache_created_at).into());
        out.insert("cacheCreatedAtIter".to_owned(), (*cache_created_at_iter).into());
        out.insert("cacheExpiresAt".to_owned(), (*cache_expires_at).into());
        out.insert("cacheModel".to_owned(), cache_model.clone().into());
        out.insert("cacheTokenSize".to_owned(), (*cache_token_size).into());
        out.insert("cachePrefixContentCount".to_owned(), (*cache_prefix_content_count).into());
        out.insert("cachePrefixHash".to_owned(), cache_prefix_hash.clone().into());
        out.insert("cacheCredentialFingerprint".to_owned(), cache_credential_fingerprint.clone().into());
        serde_json::Value::Object(out)
    }
}
/// Thread identity of a request (Codex `thread-id`, `x-codex-window-id`,
/// `client_metadata`, `x-codex-turn-metadata`). The session id is
/// [`RequestOptions::session_id`].
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct RequestThread {
    pub id: ThreadId,
    /// The thread's context window: 0 until its first compaction, one more
    /// per compaction. The Codex window id is `<id>:<window>`.
    pub window: u64,
    /// The turn this request serves, which scopes `x-codex-turn-state`;
    /// `None` for a request outside a turn (prewarm).
    pub turn: Option<TurnId>,
    /// The turn's start (Node's `turnStartedAtUnixMs`), when the caller knows it; else the Codex metadata takes the
    /// stamp of the session id.
    pub turn_started_at_ms: Option<u64>,
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
impl ProgressKind {
    /// The kind's name in Node's `onStreamDelta(kind)`.
    pub fn name(self) -> &'static str {
        match self {
            Self::Semantic => "semantic",
            Self::Reasoning => "reasoning",
            Self::Text => "text",
            Self::Tool => "tool",
        }
    }

    /// `isVisibleStreamProgress`: text, reasoning and a tool are output the caller sees; any other kind (and a
    /// transport-only chunk, which reports none) is not.
    pub fn is_visible(self) -> bool {
        matches!(self, Self::Text | Self::Reasoning | Self::Tool)
    }
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
    /// A progress update of the turn: a note the model wrote between tool calls as a thinking block (Anthropic's
    /// `thinking.display: "updates"`, where reasoning itself streams no text). Shown live like text; it stays in its
    /// thinking block and is no part of the turn's content.
    ProgressDelta(String),
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
    /// Semantic progress of the stream at the point where Node's decoder calls `onStreamDelta(kind)` without a
    /// delta event of its own (a tool call's arguments or its end, an item boundary). Text and reasoning deltas
    /// are their own events and report their own kinds. Folds into nothing.
    Progress(ProgressKind),
    /// A wire chunk that reports one progress kind for everything it carries (Gemini's `geminiChunkProgressKind`;
    /// `None`: transport only). Emitted before the chunk's own events: the text and reasoning deltas that follow do not
    /// report a kind of their own. Folds into nothing.
    ChunkProgress(Option<ProgressKind>),
    /// The assistant text the provider returns for the turn when it is not what the deltas folded to (Node's
    /// result `content`: Gemini re-scans the final text for leaked tool calls after the deltas were relayed).
    /// Replaces the folded text.
    FinalContent(String),
    /// The tool calls the provider returns for the turn when they are not the ones it dispatched live (Node's result
    /// `toolCalls` after `dedupeToolCallList`: a text-leaked call that already ran is replaced by the native call
    /// that repeats it). Replaces the folded list; the calls that ran stay the `ToolCallDone` events.
    ReturnedCalls(Vec<ToolCall>),
    /// Anthropic extended-thinking blocks (Node `thinkingBlocks`), verbatim and ordered, for a turn that carries
    /// no provider replay (a turn with a text-leaked call has no exact block replay).
    ThinkingBlocks(JsonValue),
    /// The session's provider state changed during the request (Node writes
    /// `opts.providerState` back); the whole new state, to be persisted.
    ProviderState(ProviderState),
    /// A display-only transcript notice the adapter raised while preparing the request (Node
    /// `opts.onStageChange('notice', { tone, message })`: Gemini's dated model redirect). `warn` is tone `warn`;
    /// otherwise `info`. Folds into nothing.
    Notice { message: String, warn: bool },
    /// The model that answered when the adapter served the request as another one than the request named (Node
    /// `send` result `model`: Gemini's dated redirect). The usage ledger books the send under it and the turn's
    /// response reports it.
    ServedModel(String),
    /// Provider facts about the turn that the committed assistant message keeps (Node result `providerMetadata`, copied
    /// onto the turn by `assistantEchoFields`): Anthropic's `anthropicFallbacks`, which the usage ledger also reads to
    /// book the answer as substituted. The last one stands.
    ProviderMetadata(JsonValue),
    /// The id the provider gave the response (Node result `responseId`: OpenAI's HTTP/SSE Responses route), which the
    /// usage ledger books the send under. Folds into nothing else.
    ResponseId(String),
    /// The roster account that served the answer (Node `recordServingAccount`: the result's
    /// `providerMetadata.accountRouting`). The turn's assistant message stores it, and a later send of the
    /// same provider reads it to give each account only its own replay state.
    AccountRouting(AccountRouting),
    /// A notice of the account roster's walk (Node's pool `onStageChange('reconnecting' | 'account-changed')`),
    /// in the order Node raises it: a switch before the next account's request, a committed change after the
    /// answer. Folds into nothing.
    AccountStage(AccountStage),
    /// The gateway refused the model on the routed wire and the send went out once more on another one (Node
    /// `sendOnRoute`'s `wireReroute`): the session's new `wireRoute`, whole, as Node stores it. A session whose pin
    /// named this provider and model takes it. Folds into nothing.
    WireRerouted(JsonValue),
    /// The model began its output (Node's `firstOutputAt`, generation-window.mjs): raised once per attempt by a
    /// decoder whose Node stream stamps it, at the wire event Node stamps (an Anthropic content block opening, a
    /// Responses output item added, a compatible Chat stream's first visible delta). The accounting layer times the
    /// first-output wait from it (`ttftMs`). Folds into nothing.
    OutputStarted,
    /// Anthropic's summary of the turn's content blocks (Node result `hasThinkingContent` and `contentBlockTypes`):
    /// whether a thinking block streamed, and the delta types (plus `fallback`) in first-seen order. The session reads
    /// them for an empty final turn (`ask-turn-commit.mjs:65-66`); the message threads refuse to store a turn that
    /// fell back (`anthropic-message-threads.mjs:333`). Raised once, before the terminal event. Folds into the
    /// response's summary.
    ContentSummary { has_thinking: bool, block_types: Vec<String> },
    /// The wire's terminal event. Exactly one per completed attempt, last.
    /// `stop` is `None` when the wire named no stop reason (Node
    /// `stopReason: null`: a plain Responses or Gemini completion); a decoder
    /// never invents one from tool calls or a clean finish.
    Completed {
        stop: Option<StopReason>,
        /// The catalog model the request bills as when it differs from the
        /// one sent (Node `send` result `pricingModel`, Cursor pinned
        /// suffix ids); `None` otherwise.
        pricing_model: Option<String>,
        /// The request's wall time as the usage ledger measures it (Node
        /// `usageDurationMs`): from the accounted send's start to the moment
        /// its completed row was written, first-output wait included. Stamped
        /// by the accounting layer; decoders leave `None`, and a consumer
        /// without it falls back to its own clock.
        request_ms: Option<u64>,
    },
}
impl StreamEvent {
    /// The kind Node's `onStreamDelta(kind)` reports for this event: `text` and `reasoning` for their deltas,
    /// the stated kind for a [`StreamEvent::Progress`], nothing for any other event.
    pub fn progress_kind(&self) -> Option<&'static str> {
        match self {
            Self::TextDelta(_) | Self::ProgressDelta(_) => Some("text"),
            Self::ReasoningDelta(_) => Some("reasoning"),
            Self::Progress(kind) => Some(kind.name()),
            Self::ChunkProgress(kind) => kind.map(ProgressKind::name),
            _ => None,
        }
    }

    /// The kinds a run of events reports, in order: as [`StreamEvent::progress_kind`], except that once a stream has
    /// announced its chunks ([`StreamEvent::ChunkProgress`]) its deltas report nothing of their own.
    pub fn progress_kinds(events: &[StreamEvent]) -> Vec<&'static str> {
        let mut chunked = false;
        let mut kinds = Vec::new();
        for event in events {
            chunked |= matches!(event, Self::ChunkProgress(_));
            if chunked && matches!(event, Self::TextDelta(_) | Self::ReasoningDelta(_) | Self::ProgressDelta(_)) {
                continue;
            }
            kinds.extend(event.progress_kind());
        }
        kinds
    }
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
    /// The provider rejected an image in the request (unsupported format,
    /// size or count); the agent drops or downsizes images and resends.
    ImageRejected,
    /// The provider rejected replayed provider state (reasoning signature,
    /// encrypted content, previous response id); the agent resends without it.
    ReplayRejected,
    /// The provider rejected a tool definition's schema; the agent resends
    /// with the offending schema simplified or the tool removed.
    ToolSchemaRejected,
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
                    | Self::ImageRejected
                    | Self::ReplayRejected
                    | Self::ToolSchemaRejected
            )
    }
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
    /// The provider answered, and the client refuses the response: it names more content codings than the client takes.
    /// The connection is fine; the response is not.
    TooManyEncodings,
    /// The provider answered, and the compressed body does not decode (a corrupt or cut compressed stream).
    CorruptBody,
}
impl TransportFault {
    /// The code Node gives the error of this fault (`error.code`, or its `cause`'s): `ECONNRESET` for a reset,
    /// `UND_ERR_SOCKET` for a peer that closed (undici's `SocketError`: "other side closed"), `ENOTFOUND` for a failed lookup,
    /// and for a connect or I/O failure the name of its OS error: `ECONNREFUSED`, `ETIMEDOUT` or `EPIPE`.
    /// The OS error is read through the platform's own mapping, so a Windows or a Unix number names the same code.
    pub fn errno_name(&self) -> Option<&'static str> {
        use std::io::ErrorKind as K;
        match self {
            Self::Reset => Some("ECONNRESET"),
            Self::Closed => Some("UND_ERR_SOCKET"),
            Self::Dns => Some("ENOTFOUND"),
            // Node's `ERR_HTTP2_GOAWAY_SESSION` / `ERR_HTTP2_STREAM_ERROR`: the HTTP/2 codes of a connection or stream the peer ended.
            Self::H2GoAway { .. } => Some("ERR_HTTP2_GOAWAY_SESSION"),
            Self::H2RstStream { .. } => Some("ERR_HTTP2_STREAM_ERROR"),
            Self::Connect { os_code: Some(code) } | Self::Io { os_code: Some(code) } => match std::io::Error::from_raw_os_error(*code).kind() {
                K::ConnectionRefused => Some("ECONNREFUSED"),
                K::TimedOut => Some("ETIMEDOUT"),
                K::BrokenPipe => Some("EPIPE"),
                K::ConnectionReset => Some("ECONNRESET"),
                K::ConnectionAborted => Some("ECONNABORTED"),
                _ => None,
            },
            _ => None,
        }
    }
}
/// The connection a failed request rode: the negotiated protocol (`h2`, `http/1.1`) and the number the transport logged the
/// connection's end under, so a failure tells which requests shared a connection that ended.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct ConnectionInfo {
    pub id: u64,
    pub protocol: &'static str,
}
/// Classified once at the adapter boundary; downstream reads fields only. The record sits behind one box, so a `Result<_, ProviderError>`
/// is a pointer wide; its fields are read and written through `Deref` as if they were the error's own.
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct ProviderError(Box<ProviderErrorFields>);

impl std::ops::Deref for ProviderError {
    type Target = ProviderErrorFields;

    fn deref(&self) -> &ProviderErrorFields {
        &self.0
    }
}

impl std::ops::DerefMut for ProviderError {
    fn deref_mut(&mut self) -> &mut ProviderErrorFields {
        &mut self.0
    }
}

/// The fields of a [`ProviderError`].
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct ProviderErrorFields {
    pub kind: ErrorKind,
    /// Provider code verbatim (`CODE_KINDS` vocabulary).
    pub code: Option<String>,
    pub status: Option<u16>,
    pub retry_after: Option<Duration>,
    pub reset_at: Option<SystemTime>,
    pub quota_scope: Option<QuotaScope>,
    pub reauth_required: bool,
    /// The provider's own recovery of this send ran out with this failure (`markProviderRecoveryExhausted`: the
    /// non-streaming re-issue of a refused stream): the send ends exhausted, whatever the ladder's verdict.
    pub recovery_exhausted: bool,
    /// The provider's verdict that recovery of this send is over, with no re-issue of any shape (`providerRecoveryTerminal`,
    /// `markProviderRecoveryExhausted(..., { terminal: true })`): a first-byte timeout past the policy's retries. It ends the
    /// send before the non-streaming fallback that an ordinary exhaustion still gets once (`canFallbackNonStreaming`).
    pub recovery_terminal: bool,
    /// Anthropic `x-should-retry`.
    pub should_retry: Option<bool>,
    pub exposure: Exposure,
    pub delivery: DeliveryState,
    pub transport: Option<TransportFault>,
    /// The connection the failed request rode, where the transport knows it.
    pub connection: Option<ConnectionInfo>,
    /// Provider message for logs; matched only by the agent's image-strip
    /// recovery (`isImageProcessingError` reads the same text).
    pub message: String,
    /// The usage the stream reported before it failed (its last
    /// `StreamEvent::Usage`, or the usage the failing frame carried). Set on
    /// every error that ends a stream after usage was reported; the ledger
    /// records it as-is and never infers usage. A cancelled attempt (the
    /// stream dropped) records the last `StreamEvent::Usage` its consumer saw.
    /// Boxed to keep `Result<_, ProviderError>` small.
    pub partial_usage: Option<Box<Usage>>,
    /// The model that reported `partial_usage` (Node `partialModel`), when
    /// the stream named one; `None` means the send's own model. Set by the
    /// adapter where Node stamps `partialModel`.
    pub partial_model: Option<Box<str>>,
    /// The replay envelope of the items a cut stream had finished (Node `partialProviderReplay`), when the wire keeps
    /// one: the response builder folds it into the failed attempt's partial.
    pub partial_replay: Option<Box<ProviderReplay>>,
    /// The signed thinking blocks a cut stream had finished (Node `partialThinkingBlocks`), verbatim and in block
    /// order. Independent of `partial_replay`: a turn that cannot build an exact replay (a call recovered from its
    /// text has no content block) still has thinking its continuation must send back ahead of the call.
    pub partial_thinking_blocks: Vec<JsonValue>,
    /// The calls a response cut by its length or a content filter held (Node `partialToolCalls` of the
    /// `ProviderIncompleteError`): none was dispatched or will run, and the turn fails with this error.
    pub partial_tool_calls: Vec<ToolCall>,
    /// A page the user must open to unblock the account (Antigravity
    /// `VALIDATION_REQUIRED`: the `google.rpc.Help` link, else
    /// `metadata.validation_url`, else `metadata.validation_link`). Read from
    /// the error's structured details, never from `message`.
    /// Boxed to keep `Result<_, ProviderError>` small.
    pub verification_url: Option<Box<str>>,
    /// `ToolSchemaRejected`: the request tool whose schema the provider
    /// rejected, as named in the request's [`ToolDefinition::name`]; read from
    /// the error's structured fields, never from `message`. `None` when the
    /// provider did not name one.
    pub rejected_tool: Option<Box<str>>,
    /// The account itself is blocked, not the request or the model (Node
    /// `accountBlocked`; Antigravity `VALIDATION_REQUIRED` / 403): account
    /// rotation cools the whole account and rotates even when
    /// `unsafe_to_retry` is set.
    pub account_blocked: bool,
    /// Display-only notices (message, `warn`) the adapter raised before the request failed, in the shape of
    /// [`StreamEvent::Notice`]: Node's `onStageChange('notice', …)` fires before the request is built, so a
    /// request that fails still shows them. Never matched or retried on.
    pub notices: Vec<(String, bool)>,
    /// Re-sending this request is unsafe (Node `unsafeToRetry`) for a reason
    /// [`Exposure`] does not record, e.g. reasoning already streamed; set by
    /// the sender that knows it, never inferred downstream.
    pub unsafe_to_retry: bool,
    /// A timer the call armed itself ended it (`AbortSignal.timeout`, `createTimeoutSignal`, or a bare
    /// `controller.abort()` on a `setTimeout`): Node tells these from a connection failure by the error's name, which
    /// this error does not carry.
    pub timed_out: bool,
    /// The server's id of the limit the refusal named (Node `quotaLimit`), as
    /// sent; empty ids are `None`. Boxed to keep `Result<_, ProviderError>`
    /// small.
    pub quota_limit: Option<Box<str>>,
    /// The wire's finish reason of a turn that ended on one other than a clean stop (Node `finishReason` of a
    /// `ProviderIncompleteError`), as sent; `None` for every other failure.
    pub finish_reason: Option<Box<str>>,
    /// The window a stream watchdog of the call ended it in (Node `timeoutPhase`); `None` for every other failure.
    pub timeout_phase: Option<StreamTimeoutPhase>,
    /// The failure came from a WebSocket send, and where (Node `wsFailurePhase`); the loop keeps such a failure
    /// when a retry follows it, since an outage that ends later surfaces that one.
    pub ws_phase: Option<WsPhase>,
    /// The one image a local preparation refused (Node `failingImageData` of `AnthropicImagePreparationError`): the
    /// image-strip recovery removes exactly that image. Never part of the message. Boxed to keep `Result<_, ProviderError>`
    /// small.
    pub failing_image: Option<Box<FailingImage>>,
    /// The session's cache owner refused this attempt before it was sent; nothing reached the wire.
    pub tail_refusal: Option<super::cache_tail::TailRefusal>,
    /// Every image blocker of a request that left nothing on the wire (its origins, reasons and the local actions that
    /// work). Typed outside accounting and retry: no row is written for it and no recovery re-sends it. Boxed to keep
    /// `Result<_, ProviderError>` small.
    pub image_refusal: Option<Box<mixdog_image_egress::NotSent>>,
    /// A ladder that ran elsewhere (the PC's, in the model-proxy client mode) ended this overload by naming the model to
    /// send again with; the loop's own decider takes that verdict as it stands.
    pub fallback_model: Option<Box<str>>,
}
impl ProviderError {
    /// A request whose images were not all carried: nothing was sent, and the message names every blocker.
    pub fn images_not_sent(refusal: mixdog_image_egress::NotSent) -> Self {
        let mut err = Self::new(ErrorKind::InvalidRequest, DeliveryState::NotSent);
        err.message = refusal.message();
        err.image_refusal = Some(Box::new(refusal));
        err
    }

    /// An attempt the session's cache owner refused before transport.
    pub fn tail_refused(refusal: super::cache_tail::TailRefusal) -> Self {
        let mut err = Self::new(ErrorKind::InvalidRequest, DeliveryState::NotSent);
        err.message = match refusal {
            super::cache_tail::TailRefusal::Rebuild(_) => "the transcript's prompt cache must be rebuilt before this request".to_owned(),
            super::cache_tail::TailRefusal::Skip(super::cache_tail::Cold::Expired) => "the transcript's prompt cache expired".to_owned(),
            super::cache_tail::TailRefusal::Skip(super::cache_tail::Cold::Unproven) => "no reusable transcript cache was confirmed".to_owned(),
            super::cache_tail::TailRefusal::Wait(_) => "the transcript is being compacted".to_owned(),
            super::cache_tail::TailRefusal::Stale => "the transcript was rewritten after this request was prepared".to_owned(),
            super::cache_tail::TailRefusal::Unjudged => {
                "The session that owns this transcript could not be reached to check its prompt cache, so the request was not sent.".to_owned()
            }
        };
        err.tail_refusal = Some(refusal);
        err
    }

    pub fn new(kind: ErrorKind, delivery: DeliveryState) -> Self {
        Self(Box::new(ProviderErrorFields {
            kind,
            code: None,
            status: None,
            retry_after: None,
            reset_at: None,
            quota_scope: None,
            reauth_required: false,
            recovery_exhausted: false,
            recovery_terminal: false,
            should_retry: None,
            exposure: Exposure::default(),
            delivery,
            transport: None,
            connection: None,
            message: String::new(),
            partial_usage: None,
            partial_model: None,
            partial_replay: None,
            partial_thinking_blocks: Vec::new(),
            partial_tool_calls: Vec::new(),
            verification_url: None,
            rejected_tool: None,
            account_blocked: false,
            unsafe_to_retry: false,
            timed_out: false,
            quota_limit: None,
            ws_phase: None,
            failing_image: None,
            notices: Vec::new(),
            finish_reason: None,
            timeout_phase: None,
            tail_refusal: None,
            image_refusal: None,
            fallback_model: None,
        }))
    }

    /// The message, moved out of the error.
    pub fn into_message(self) -> String {
        self.0.message
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
// `ProviderError` is the contract's flat classification record (PW §3), built once per failed
// attempt and read field by field; its size is fixed by the contract, and boxing it would put
// an allocation and an indirection into every implementer's signature for no gain.
#[allow(clippy::result_large_err)]
pub trait WireDecoder: Send {
    /// Retain usage decoded before the transport (rather than the provider) ended the response.
    fn attach_observed_usage(&self, _error: &mut ProviderError) {}
    fn feed(&mut self, unit: &[u8]) -> Result<Vec<StreamEvent>, ProviderError>;
    /// End of body or connection close. If the terminal event was not seen,
    /// returns `TransportFault::TruncatedStream` (transient).
    fn finish(&mut self) -> Result<Vec<StreamEvent>, ProviderError>;
    fn terminal_seen(&self) -> bool;
    fn exposure(&self) -> Exposure;
    /// A whole protocol record (an SSE `data:` event) has been decoded, whether or not it carried output: the "first chunk" of
    /// a stream whose first-payload window the caller times. A comment, a ping or the bytes of an unfinished record are not
    /// one. Decoders whose consumer does not time a first payload leave it `false`.
    fn payload_seen(&self) -> bool {
        false
    }
}
/// Pure wire translation for one provider family: no I/O, no clock.
// See `WireDecoder`: the `ProviderError` size is fixed by the contract.
#[allow(clippy::result_large_err)]
pub trait WireCodec: Send + Sync {
    fn transport(&self) -> TransportKind;
    /// The wire branch `request` is encoded onto, which decides what images it may carry. A codec that has not declared one is
    /// the unknown branch: it takes no image.
    fn image_branch(&self, request: &ModelRequest) -> mixdog_image_egress::route::WireBranch {
        let _ = request;
        mixdog_image_egress::route::WireBranch::Unknown
    }
    fn encode(&self, request: &ModelRequest) -> Result<WireRequest, ProviderError>;
    /// The decoder for one response to `request`. Provider state flows through
    /// it: a codec whose route continues a conversation reads
    /// `request.options.provider_state` and reports the updated state as
    /// `StreamEvent::ProviderState`; a codec that needs nothing from the
    /// request ignores it.
    fn decoder(&self, request: &ModelRequest) -> Box<dyn WireDecoder>;
    /// The single classification point for a failed response.
    fn classify(&self, response: &ErrorResponse) -> ProviderError;
}
#[async_trait]
pub trait ModelStream: Send {
    async fn next(&mut self) -> Option<Result<StreamEvent, ProviderError>>;
    fn delivery(&self) -> DeliveryState;
    /// Given once by the consumer, before the stream is polled. A stream whose `next` goes on to await something else once
    /// the send's wire has delivered its terminal event (the usage ledger writing the completed row, the key pool binding
    /// the serving key) calls `left` inside that `next`, before the await: from then on a pending `next` is not a wait for
    /// the wire. Required, with no default, so that every stream decides: a wrapper hands `left` to the stream it wraps,
    /// a stream that produces attempts to each attempt's stream as it is created, and only a leaf whose `next` awaits
    /// nothing after the wire's terminal event ignores it.
    fn on_wire_left(&mut self, left: Arc<dyn Fn() + Send + Sync>);
}
#[async_trait]
pub trait ProviderAdapter: Send + Sync {
    fn id(&self) -> &ProviderId;
    fn codec(&self) -> &dyn WireCodec;

    /// Local quota evidence for a new, unsent request. `Some(true)` proves at least one account can
    /// serve the model, `Some(false)` proves all applicable accounts exhausted, and `None` is unknown.
    /// This must not prepare a send, refresh auth, or probe the wire.
    async fn quota_eligibility(&self, _model: &str) -> Option<bool> {
        None
    }
    fn retry_policy(&self) -> &RetryPolicy;
    /// The retry policy of a send to `model`: a provider that reaches some models through another engine (Vertex AI's
    /// open models over Chat Completions) retries those as that engine does. The provider's own by default; a wrapper
    /// forwards its inner provider's.
    fn retry_policy_for(&self, _model: &str) -> &RetryPolicy {
        self.retry_policy()
    }
    /// [`Self::retry_policy_for`] of one send: a provider whose route is known only per send (a gateway, by the wire
    /// the send's attempts went out on, [`SendIdentity::wire`]) reads it from `request`. By default the model's.
    fn retry_policy_of(&self, request: &ModelRequest) -> &RetryPolicy {
        self.retry_policy_for(&request.model)
    }
    /// Called once before a send's first attempt, so a provider whose route is known only by resolving it can record
    /// it on the send ([`SendIdentity::set_wire`]) before the stages ahead of the first attempt are read. Nothing by
    /// default; a wrapper forwards.
    async fn prepare_send(&self, _request: &ModelRequest) {}
    /// [`Self::send_stages`] of one send (see [`Self::retry_policy_of`]).
    fn send_stages_of(&self, request: &ModelRequest) -> SendStages {
        self.send_stages(&request.model)
    }
    /// [`Self::retry_line`] of one send (see [`Self::retry_policy_of`]).
    fn retry_line_of(&self, request: &ModelRequest) -> Option<RetryLine> {
        self.retry_line(&request.model)
    }
    fn keepalive(&self) -> &KeepaliveSchedule;
    /// One provider send. A provider-owned recovery (such as Responses WS)
    /// marks a surfaced failure `should_retry: Some(false)` so callers never
    /// multiply its budget. Dropping the future aborts the send.
    async fn attempt(
        &self,
        request: Arc<ModelRequest>,
    ) -> Result<Box<dyn ModelStream>, ProviderError>;
    /// The provider's model listing. Every product adapter returns `Some`;
    /// the default `None` only keeps this addition non-breaking for adapters
    /// that have not implemented it yet.
    fn models(&self) -> Option<&dyn ModelListing> {
        None
    }
    /// The wire each model is reached on, for a gateway that serves several
    /// (`resolveWireRoute`); `None` for a single-wire provider.
    fn wire_routing(&self) -> Option<&dyn WireRouting> {
        None
    }
    /// The logical send `group` ended without a success: its last failure surfaces, or the user
    /// cancelled it. Called by the loop once per group, before any other send; a provider that
    /// accounts sends writes what the group held back. Nothing to do by default.
    async fn settle_send(&self, _group: &str, _end: SendEnd) {}
    /// The logical send `group` is over for good, however it ended (answer, error, cancel, the caller's future
    /// dropped, a panic): let go what it holds that other sends wait for. Synchronous, so a drop outside any
    /// runtime can call it. Required: a wrapper must forward it; a stateless adapter writes an explicit no-op.
    fn release_send(&self, group: &str);
    /// The session was deleted (`__mixdogCloseProviderConnectionsForSession(id,
    /// 'session-deleted')`): its connections and per-session transport state go. Nothing to do
    /// for a provider that keeps none.
    fn release_session(&self, _session_id: &str) {}
    /// An agent loop is entered (`resetAccountProbePacing`): the user asks for a current answer, so a quota the
    /// account pool recorded as exhausted is re-measured rather than refused from the old reading. Called once per
    /// loop entry, never per provider round. Nothing to do for a provider with no account roster.
    fn begin_loop(&self) {}
    /// A forked request's transport scope is disposed (`disposeTransportScope`:
    /// `__mixdogCloseProviderConnectionsForSession(scope, 'transport_scope_disposed')`): the scope's
    /// connections and transport state go. By default as [`Self::release_session`].
    fn release_transport_scope(&self, scope: &str) {
        self.release_session(scope);
    }
    /// `provider.nativePdf !== false` (`providerTakesNativePdf`): the provider takes a PDF as a
    /// native document block. Each adapter class declares it; one that declares nothing takes it.
    fn native_pdf(&self) -> bool {
        true
    }
    /// `provider.nativeDocuments`: `Some(false)` means the provider takes no document block of any
    /// kind, so every document variant is lowered to text. Unset by default.
    fn native_documents(&self) -> Option<bool> {
        None
    }
    /// `instance.constructor.inputExcludesCache` where the instance's class is not told by its registered name: a
    /// custom provider on the anthropic protocol is an `AnthropicProvider` subclass (`custom-provider.mjs:162`) and
    /// inherits `true`. `None` leaves the answer to the name (`accounted::input_excludes_cache`).
    fn input_excludes_cache(&self) -> Option<bool> {
        None
    }
    /// What the route `request` goes to takes as a document: Node asks the engine that sends it (a gateway's Messages
    /// engine declares its own `nativePdf` / `nativeDocuments`, apart from the provider's flags for its Chat and
    /// Responses wires). The provider's own flags by default; a wrapper forwards its inner provider's.
    async fn media_support(&self, _request: &ModelRequest) -> MediaSupport {
        MediaSupport { native_pdf: self.native_pdf(), native_documents: self.native_documents() }
    }
    /// Whether the route `request` goes to takes an image at all. A model without vision gets the fixed omitted text for a
    /// stored image and its blob is never read (Node's `degradeMediaParts` lowers the part, not the file), so a blob that is
    /// gone reads "omitted" like any other. True by default.
    async fn takes_vision(&self, _request: &ModelRequest) -> bool {
        true
    }
    /// The facts of the route `request` actually takes, from which its image-input policy is resolved: the wire branch
    /// (a wrapper reports the one inside it), the resolved deployment and whether it reads images. A route that declares
    /// none takes no image: the provider's name and its codec are not evidence of support.
    ///
    /// By default the branch is the one the adapter's codec declares for the request ([`WireCodec::image_branch`]; a codec that
    /// declares none is the unknown route, which takes no image) and vision is [`Self::takes_vision`]. An adapter that picks
    /// its wire per request (a gateway, a multi-wire provider, a local runtime) answers for the wire it picked.
    async fn image_route(&self, request: &ModelRequest) -> mixdog_image_egress::route::RouteFacts {
        let vision = if self.takes_vision(request).await { mixdog_image_egress::route::Vision::Yes } else { mixdog_image_egress::route::Vision::No };
        mixdog_image_egress::route::RouteFacts::declared(self.id().as_str(), &request.model, self.codec().image_branch(request), vision)
    }
    /// `provider.firstResponseBudget(model, { modelParameters })`: the longest one send to `model`
    /// may wait for its response headers and its first output, which the progress watchdog's
    /// first-response deadlines are floored above. `None` keeps the watchdog's default window. An
    /// adapter that has a window of its own (a model proxy reporting one, a priority tier with a
    /// longer first chunk) declares it here.
    fn first_response_budget(&self, _model: &str, _parameters: Option<&JsonValue>) -> Option<FirstResponseBudget> {
        None
    }
    /// `typeof provider.sendCacheWarm === 'function'`: the provider's cache-warm mode, or `None`
    /// for one that has none. A wrapper forwards its inner provider's.
    fn cache_warm(&self) -> Option<&dyn super::cache_warm::CacheWarmSend> {
        None
    }
    /// The display stages a send to `model` raises around its attempts (Node `onStageChange`): by default only the
    /// retry ladder's `reconnecting` ([`SendStages::default`]); a wrapper forwards its inner provider's.
    fn send_stages(&self, _model: &str) -> SendStages {
        SendStages::default()
    }
    /// The line the provider's ladder writes to stderr before each retry of a send to `model` (`<tag> retry attempt <n>
    /// after <message>`, with the wait for most ladders); `None` for a provider that writes none. A wrapper forwards
    /// its inner provider's.
    fn retry_line(&self, _model: &str) -> Option<RetryLine> {
        None
    }
    /// Whether the provider re-issues a send to `model` whose stream ladder ran out on `failure` (Gemini's
    /// `_recoverGeminiNonStreaming`: once, without streaming). False by default; a wrapper forwards its inner
    /// provider's.
    fn recovers_spent(&self, _model: &str, _failure: &ProviderError) -> bool {
        false
    }
    /// That re-issue, called only when [`Self::recovers_spent`] or [`Self::recovers_cut`] holds: its stream, or its
    /// failure. After a spent ladder the ladder's failure surfaces unless the re-issue marks its refusal
    /// [`ProviderError::recovery_terminal`]. After a cut stream the re-issue's own failure surfaces.
    async fn recover_spent(&self, _request: Arc<ModelRequest>) -> Result<Box<dyn ModelStream>, ProviderError> {
        Err(ProviderError::new(ErrorKind::Unknown, DeliveryState::NotSent))
    }
    /// Whether the provider answers a stream of a send to `model` that died on `failure` with its re-issue
    /// ([`Self::recover_spent`]) at once, in place of another attempt of the stream (the Anthropic routes'
    /// `decideStreamError`, anthropic-midstream-recovery.mjs: shown text or thinking is withdrawn and the request
    /// repeated without streaming; a stall that showed nothing is repeated without streaming too).
    /// `failure.exposure.text_emitted` states whether text or reasoning of the dead stream reached the caller, who
    /// withdraws it before the re-issue. False by default; a wrapper forwards its inner provider's.
    fn recovers_cut(&self, _model: &str, _failure: &ProviderError) -> bool {
        false
    }
    /// The line the provider writes to stderr once its re-issue of a send to `model` that failed on `failure` answered
    /// (`[<provider>] stream failed (<cause>); recovered via non-streaming request`); `None` for a provider that writes
    /// none. A wrapper forwards its inner provider's.
    fn recovery_line(&self, _model: &str, _failure: &ProviderError) -> Option<String> {
        None
    }
}
/// The line a provider's retry ladder writes to stderr before a retry ([`ProviderAdapter::retry_line`]).
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct RetryLine {
    /// The line's tag, brackets included (`[gemini]`, `[xai:responses]`).
    pub tag: String,
    /// The wait follows the message (`retryDelayLabel`: `, delay <ms>ms`, and ` (retry-after)` when the server advised
    /// it): the Anthropic API's and the OpenAI-compatible ladders (anthropic-api-transport.mjs:203,
    /// compat-request-policy.mjs:9), not Gemini's (`geminiRetryLogger`, gemini.mjs:243).
    pub delay: bool,
    /// How the line words the attempt and the cause.
    pub style: RetryLineStyle,
}
/// The wording of a [`RetryLine`].
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum RetryLineStyle {
    /// `<tag> retry attempt <n> after <message>[<wait>]`.
    Attempt,
    /// `<tag> retry attempt <n>/<max> after <status, else code, else message>, backoff <ms>ms[ (retry-after)]`: the
    /// Anthropic OAuth ladder (anthropic-oauth-request.mjs:146).
    OfMax,
    /// `<tag> retry <n> after <message>`: the Antigravity ladder (antigravity-transport.mjs:179).
    Plain,
    /// The Anthropic API route: a refused request is worded as [`RetryLineStyle::Attempt`], a stream that was
    /// re-issued after it opened as the mid-stream ladder words it (`<tag> truncated stream — retry <n>/<max>`,
    /// anthropic-midstream-recovery.mjs:262), whose stage counts retries, not attempts.
    AnthropicApi,
}
/// The display stages a provider's send raises around its attempts ([`ProviderAdapter::send_stages`]).
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct SendStages {
    /// `requesting` stages raised once, before the first attempt (Gemini's `_doSend`: the request built, the cache
    /// settled).
    pub preparing: u32,
    /// A `requesting` stage before every attempt (Gemini's attempt `run`).
    pub each_attempt: bool,
    /// A `requesting` stage before the re-issue of a spent send ([`ProviderAdapter::recover_spent`]).
    pub before_recovery: bool,
    /// The `reconnecting` stage before each retry wait of the provider's own ladder (`emitProviderRetryStage`,
    /// retry-executor.mjs:346, from each ladder's `onRetry`). On by default: every Node provider ladder raises it but
    /// the two that pass no `onRetry` (Vertex AI's Gemini models, vertex-ai.mjs:382; Devin, which has no ladder of
    /// its own, devin.mjs).
    pub reconnecting: bool,
    /// The ladder is chosen by whether the attempt's response opened (its headers arrived and were accepted), and each
    /// stream attempt opens under a fresh connection ladder (`runGeminiStreamAttempts`' `connected()`); otherwise by
    /// whether the attempt produced an event.
    pub ladder_by_connection: bool,
    /// The provider's note that the request is on the wire, raised after each attempt's request is sent
    /// (`MODEL_THINKING_STAGE`, antigravity-transport.mjs:236), which the run's liveness reads.
    pub model_thinking: bool,
}
impl Default for SendStages {
    fn default() -> Self {
        Self { preparing: 0, each_attempt: false, before_recovery: false, reconnecting: true, ladder_by_connection: false, model_thinking: false }
    }
}
#[async_trait]
pub trait WireRouting: Send + Sync {
    /// `Ok(None)`: the gateway offers the model on no wire (not routable).
    async fn resolve_wire_route(
        &self,
        model: &str,
        context: &WireRouteContext,
    ) -> Result<Option<WireRoute>, ProviderError>;
}
/// A selectable non-effort, non-fast model parameter (`modelParameterOptions`).
#[derive(Clone, PartialEq, Eq, Debug, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ParameterOption {
    pub id: String,
    pub label: String,
    pub kind: String,
    pub options: Vec<ParameterValue>,
}
/// A service tier the provider's catalog offers (`serviceTiers`).
#[derive(Clone, PartialEq, Eq, Debug, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServiceTier {
    pub id: String,
    pub name: String,
    pub description: String,
}
/// What the model picker shows beyond limits and capabilities. The adapter
/// fills it from its own listing, as the Node adapters do; the metadata
/// catalog never does. A custom provider's display name override is
/// `ModelRecord::display_name`, and "out of the picker" is `ModelRecord::hidden`.
#[derive(Clone, PartialEq, Eq, Debug, Default, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct PickerFields {
    /// `YYYY-MM-DD`, from a dated id or the source.
    pub release_date: Option<String>,
    /// `None` when the catalog does not say, which is not an empty list.
    pub access_programs: Option<Vec<String>>,
    pub model_parameter_options: Vec<ParameterOption>,
    /// Each variant's route parameters, keyed by route name.
    pub parameter_variants: Vec<std::collections::BTreeMap<String, String>>,
    pub fast_efforts: Vec<String>,
    pub service_tiers: Vec<ServiceTier>,
    pub additional_speed_tiers: Vec<String>,
    pub reasoning_options: Vec<ReasoningOption>,
    pub custom_reasoning: Option<CustomReasoning>,
    /// How the id is classed in the listing (`dated`, `version`, `family`).
    pub tier: Option<String>,
    /// The newest of its family, as the adapter's second pass marks it.
    pub latest: bool,
    pub description: Option<String>,
    /// The service tier the catalog selects when the route names none (Codex).
    pub default_service_tier: Option<String>,
    /// The default variant's route parameters minus `effort` and `fast` (Cursor).
    pub default_model_parameters: std::collections::BTreeMap<String, String>,
    /// Whether the default variant is the fast one (Cursor).
    pub default_fast: bool,
    pub supports_max_mode: bool,
}
/// One model as the provider lists it, before catalog enrichment (pricing
/// and capability metadata from LiteLLM/models.dev are merged by the
/// catalog, PW §9). Capabilities the provider does not state are `None`.
#[derive(Clone, PartialEq, Debug)]
#[non_exhaustive]
pub struct ModelRecord {
    /// The picker's row fields.
    pub picker: PickerFields,
    pub id: String,
    pub display_name: Option<String>,
    /// The row's `name` where the adapter sets one (Node sets `name: id` for
    /// the compat family, Grok, custom providers and OpenAI WS). It is the
    /// fallback label (`display || name`) and the metadata lookup's
    /// display-name fallback, so `enrich_listed` reads it; the catalog shows
    /// it when no display name is known.
    pub name: Option<String>,
    /// The custom provider's own name for itself, as its row states it.
    pub provider_name: Option<String>,
    /// A custom model the user added by hand, not one discovery listed.
    pub manual: bool,
    /// Whether the model takes a reasoning-effort change mid-conversation, where
    /// the provider's catalog says (Codex `supports_reasoning_effort_updates`);
    /// `None` when it does not, and the version rule then decides.
    pub supports_reasoning_effort_updates: Option<bool>,
    /// Whether the model takes reasoning summaries, where the provider's catalog says
    /// (Codex `supports_reasoning_summaries === true`); `None` when the row states nothing.
    pub supports_reasoning_summaries: Option<bool>,
    /// `thinkingTypes.adaptive`: the row declares whether the model takes adaptive thinking.
    pub thinking_adaptive: Option<bool>,
    /// `thinkingTypes.enabled`: the row declares whether the model takes a manual thinking budget.
    pub thinking_enabled: Option<bool>,
    /// The row states its effort ladder (`Array.isArray(reasoningOptions)`), possibly empty:
    /// an empty stated ladder means the model takes no effort, a row that states none
    /// describes nothing.
    pub efforts_stated: bool,
    /// Whether the model caches prompts: the listing's own word, else the
    /// catalog's (`enrich_listed`).
    pub supports_prompt_caching: Option<bool>,
    pub context_window: Option<u64>,
    /// The largest window the model can be served with, where the listing
    /// states one above the served `context_window` (`maxContextWindow`).
    pub max_context_window: Option<u64>,
    /// The capacity a managed local runtime has allocated, which bounds any
    /// selected window (`runtimeContextWindow`).
    pub runtime_context_window: Option<u64>,
    pub max_output_tokens: Option<u64>,
    /// The listing's own prices, USD per million tokens (`inputCostPerM` …),
    /// left out when not finite. They describe the row; the ledger prices a
    /// request from the catalog lookup, which never reads them.
    pub input_cost_per_m: Option<f64>,
    pub output_cost_per_m: Option<f64>,
    pub cache_read_cost_per_m: Option<f64>,
    pub cache_write_cost_per_m: Option<f64>,
    pub supports_reasoning: Option<bool>,
    /// Reasoning effort levels the model accepts, in the provider's order.
    pub reasoning_levels: Vec<String>,
    /// One of `reasoning_levels`.
    pub default_reasoning_level: Option<String>,
    pub supports_images: Option<bool>,
    /// Listed by the provider but not offered in pickers (Codex `visibility: hide`).
    pub hidden: bool,
    /// The kind of model the listing states (`chat`, `embedding`, …); the
    /// sanitizer drops non-chat modes. `None` when the listing says nothing.
    pub mode: Option<String>,
    /// When the provider created the model (epoch seconds, as listed); picks
    /// the newest of several dated snapshots of one model.
    pub created: Option<i64>,
    /// The model a routing alias resolves to (OpenRouter `~vendor/model`),
    /// used to look up capabilities.
    pub alias_target: Option<String>,
    /// The body field a reasoning model returns its thinking under and expects
    /// replayed (`reasoning_content`), as the listing or the catalog states it.
    pub reasoning_content_field: Option<String>,
    /// The family token the adapter's own normalizer states (`_normalizeAnthropicModel`: `sonnet`).
    pub family: Option<String>,
    /// The wire id(s) the picker id is sent under; kept in the catalog cache
    /// so a send resolves the picker id after a restart, before any listing.
    pub wire: Option<WireIds>,
    /// The provider's record verbatim (service tiers, upgrade notes, …).
    pub raw: Option<JsonValue>,
    /// What the catalog lookup made of this row (`enrichModels`), for the roster row a provider persists.
    pub enriched: EnrichedRow,
}
impl ModelRecord {
    pub fn new(id: impl Into<String>) -> Self {
        Self {
            picker: PickerFields::default(),
            id: id.into(),
            display_name: None,
            name: None,
            provider_name: None,
            manual: false,
            supports_reasoning_effort_updates: None,
            supports_reasoning_summaries: None,
            thinking_adaptive: None,
            thinking_enabled: None,
            efforts_stated: false,
            supports_prompt_caching: None,
            context_window: None,
            max_context_window: None,
            runtime_context_window: None,
            max_output_tokens: None,
            input_cost_per_m: None,
            output_cost_per_m: None,
            cache_read_cost_per_m: None,
            cache_write_cost_per_m: None,
            supports_reasoning: None,
            reasoning_levels: Vec::new(),
            default_reasoning_level: None,
            supports_images: None,
            hidden: false,
            mode: None,
            created: None,
            alias_target: None,
            reasoning_content_field: None,
            family: None,
            wire: None,
            raw: None,
            enriched: EnrichedRow::default(),
        }
    }
}
/// A provider's model list (PW §9): its native list endpoint, or the
/// provider's own static list where it has none (Vertex).
#[async_trait]
pub trait ModelListing: Send + Sync {
    /// One fetch: no retry, no cache, no fallback list. Refresh and caching
    /// belong to the catalog; a failure is a typed error, never an empty list.
    async fn list_models(&self) -> Result<Vec<ModelRecord>, ProviderError>;

    /// One fetch, with the identity of the credential it was made with and whether the rows are the provider's seed roster
    /// (shown when the fetch failed or listed nothing; what the provider did not state is never stored, and never replaces
    /// a roster already kept). A listing that keys its roster by a credential must return the identity of the credential its
    /// request carried. This default has no such handle, so it brackets the fetch with two samples and refuses an answer
    /// whose account moved meanwhile: the rows are never attributed to a credential that may not have asked for them.
    async fn list_roster(&self) -> Result<ListedRoster, ProviderError> {
        let before = self.roster_identity().await;
        let rows = self.list_models().await?;
        let identity = self.roster_identity().await;
        if before != identity {
            let mut error = ProviderError::new(ErrorKind::Transient, DeliveryState::Accepted);
            error.message = "the signed-in account changed while the model list was being fetched".to_owned();
            return Err(error);
        }
        Ok(ListedRoster { rows, provenance: Provenance::Fetched, identity })
    }

    /// Who the listing is for now: the roster a catalog keeps on disk is that identity's alone. A provider whose listing
    /// does not depend on a credential states none (and keeps no roster).
    async fn roster_identity(&self) -> RosterIdentity {
        RosterIdentity::default()
    }

    /// The roster the catalog decided to show for this listing (its own fetch, a roster kept from an earlier one, or the
    /// seed), so a reader that answers from the listing's own rows describes exactly what the picker shows.
    fn show_roster(&self, _rows: &[ModelRecord]) {}
}

/// What produced this roster, and (for a proxy) whether it is authoritative.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Provenance {
    Fetched,
    Seed,
    Proxied { complete: bool },
}

/// One fetch of a roster: its rows, whether the provider stated them, and whose credential asked.
#[derive(Clone, Debug)]
pub struct ListedRoster {
    pub rows: Vec<ModelRecord>,
    pub provenance: Provenance,
    pub identity: RosterIdentity,
}

/// What a saved roster belongs to (`RosterIdentity`): the credential's account (an opaque fingerprint), the endpoint it
/// was listed from (base URL, region, auth mode: the same account lists another roster elsewhere), and the client version
/// the listing was requested for (the backend lists only what that version unlocks; it makes a roster stale, not another's).
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct RosterIdentity {
    pub account: Option<String>,
    pub endpoint: Option<String>,
    pub client_version: Option<String>,
}
