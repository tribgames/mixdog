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

/// `providerMetadata.accountRouting`: the roster account of `provider` that served a message.
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct AccountRouting {
    pub provider: String,
    pub account_id: String,
    /// The account the session stays bound to (`sessionAccountId`); `None` on a message read back where the
    /// stored routing named none.
    pub session_account_id: Option<String>,
}

/// The account pool's stages (Node `onStageChange`).
#[derive(Clone, PartialEq, Eq, Debug)]
pub enum AccountStage {
    /// `'reconnecting', { message }`: the pool moves on to the next account.
    Switching { message: String },
    /// `'account-changed', { provider, accountId, at }`: a fallback became the selected account.
    Changed { provider: String, account_id: String, at: i64 },
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
    /// Assistant only: the stored `providerMetadata.gemini` (`{thoughtParts, textParts}`), which a Gemini-wire request
    /// replays for a turn that has no replay envelope of its own (`geminiThoughtPartsFromMetadata`).
    pub gemini_metadata: Option<JsonValue>,
    /// User and tool only (Node `meta.sentRequestTail`): the message a provider request ended with when a restart
    /// or cancel cut it. An Anthropic wire keeps later user text beside it as sibling blocks instead of folding it
    /// in, so the cached prefix that request wrote is sent unchanged.
    pub sent_request_tail: bool,
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
            turn_reminder: None,
            account_routing: None,
            gemini_metadata: None,
            sent_request_tail: false,
            provider_replay: Vec::new(),
        }
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
    /// The attempts of this send that began so far.
    attempts: std::sync::Arc<std::sync::atomic::AtomicU32>,
    /// The display stages the adapter raised from inside an attempt (`onStageChange`), in order, for the caller to take
    /// after the attempt.
    stages: std::sync::Arc<std::sync::Mutex<Vec<RaisedStage>>>,
    /// Whether this send raised its once-per-send `requesting` yet.
    requested: std::sync::Arc<std::sync::atomic::AtomicBool>,
}

/// A display stage an adapter raised, with the payload Node's `onStageChange(stage, payload)` carried.
pub type RaisedStage = (&'static str, Option<serde_json::Value>);

impl SendIdentity {
    /// Raises a display stage from inside an attempt.
    pub fn raise_stage(&self, stage: &'static str) {
        self.stages.lock().unwrap_or_else(std::sync::PoisonError::into_inner).push((stage, None));
    }

    /// Raises a display stage that carries a payload.
    pub fn raise_stage_with(&self, stage: &'static str, payload: serde_json::Value) {
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

    /// Runs `attempt`, handing each stage it raises to `deliver` right after the poll that raised it, so a stage is seen
    /// when the request goes out and not when the attempt (which may read the response's first output) ends.
    pub async fn deliver_stages<F: std::future::Future>(&self, attempt: F, mut deliver: impl FnMut(&'static str, Option<serde_json::Value>)) -> F::Output {
        let mut attempt = std::pin::pin!(attempt);
        std::future::poll_fn(|cx| {
            let polled = attempt.as_mut().poll(cx);
            for (stage, payload) in self.take_stages() {
                deliver(stage, payload);
            }
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
}

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
            Self::TextDelta(_) => Some("text"),
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
            if chunked && matches!(event, Self::TextDelta(_) | Self::ReasoningDelta(_)) {
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

impl TransportFault {
    /// The errno name Node gives the socket error of this fault (`error.code`): `ECONNRESET` for a reset,
    /// and for a connect or I/O failure the name of its OS error: `ECONNREFUSED`, `ETIMEDOUT` or `EPIPE`.
    /// The OS error is read through the platform's own mapping, so a Windows or a Unix number names the same code.
    pub fn errno_name(&self) -> Option<&'static str> {
        use std::io::ErrorKind as K;
        match self {
            Self::Reset => Some("ECONNRESET"),
            Self::Connect { os_code: Some(code) } | Self::Io { os_code: Some(code) } => match std::io::Error::from_raw_os_error(*code).kind() {
                K::ConnectionRefused => Some("ECONNREFUSED"),
                K::TimedOut => Some("ETIMEDOUT"),
                K::BrokenPipe => Some("EPIPE"),
                K::ConnectionReset => Some("ECONNRESET"),
                _ => None,
            },
            _ => None,
        }
    }
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
    /// The provider's own recovery of this send ran out with this failure (`markProviderRecoveryExhausted`: the
    /// non-streaming re-issue of a refused stream): the send ends exhausted, whatever the ladder's verdict.
    pub recovery_exhausted: bool,
    /// Anthropic `x-should-retry`.
    pub should_retry: Option<bool>,
    pub exposure: Exposure,
    pub delivery: DeliveryState,
    pub transport: Option<TransportFault>,
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
    /// Before the first payload (`first-chunk`).
    FirstChunk,
    /// After a payload, no further progress (`idle`).
    Idle,
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
            recovery_exhausted: false,
            should_retry: None,
            exposure: Exposure::default(),
            delivery,
            transport: None,
            message: String::new(),
            partial_usage: None,
            partial_model: None,
            partial_replay: None,
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
// `ProviderError` is the contract's flat classification record (PW §3), built once per failed
// attempt and read field by field; its size is fixed by the contract, and boxing it would put
// an allocation and an indirection into every implementer's signature for no gain.
#[allow(clippy::result_large_err)]
pub trait WireDecoder: Send {
    fn feed(&mut self, unit: &[u8]) -> Result<Vec<StreamEvent>, ProviderError>;
    /// End of body or connection close. If the terminal event was not seen,
    /// returns `TransportFault::TruncatedStream` (transient).
    fn finish(&mut self) -> Result<Vec<StreamEvent>, ProviderError>;
    fn terminal_seen(&self) -> bool;
    fn exposure(&self) -> Exposure;
}

/// Pure wire translation for one provider family: no I/O, no clock.
// See `WireDecoder`: the `ProviderError` size is fixed by the contract.
#[allow(clippy::result_large_err)]
pub trait WireCodec: Send + Sync {
    fn transport(&self) -> TransportKind;
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

/// One attempt's event stream. Ends with `Ok(Completed)` or one `Err`.
/// Dropping it aborts the attempt.
/// A provider's first-response budget (`{ transportMs, semanticMs }`), both positive.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct FirstResponseBudget {
    pub transport_ms: i64,
    pub semantic_ms: i64,
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

/// The document capabilities of one route (`providerTakesNativePdf`, `provider.nativeDocuments`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct MediaSupport {
    pub native_pdf: bool,
    pub native_documents: Option<bool>,
}

#[async_trait]
pub trait ProviderAdapter: Send + Sync {
    fn id(&self) -> &ProviderId;
    fn codec(&self) -> &dyn WireCodec;
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
    /// Exactly one attempt; never retries internally. Dropping the future
    /// aborts the attempt.
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
    /// That re-issue, called only when [`Self::recovers_spent`] holds: its stream, or its failure, after which the
    /// ladder's own failure surfaces.
    async fn recover_spent(&self, _request: Arc<ModelRequest>) -> Result<Box<dyn ModelStream>, ProviderError> {
        Err(ProviderError::new(ErrorKind::Unknown, DeliveryState::NotSent))
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

#[async_trait]
pub trait WireRouting: Send + Sync {
    /// `Ok(None)`: the gateway offers the model on no wire (not routable).
    async fn resolve_wire_route(
        &self,
        model: &str,
        context: &WireRouteContext,
    ) -> Result<Option<WireRoute>, ProviderError>;
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
