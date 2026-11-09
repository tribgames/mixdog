//! What a run needs from its host, as narrow traits. The session actor, the
//! feed, the store, the timer wheel and the compaction pipeline implement
//! these; the loop never reads a clock, draws randomness or waits on its own.

use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use mixdog_core_api::domain::approval::ApprovalAsk;
use mixdog_core_api::domain::provider::Content;
use mixdog_core_api::domain::provider::ModelRequest;
use mixdog_core_api::domain::provider::ProviderAdapter;
use mixdog_core_api::domain::provider::ProviderError;
use mixdog_core_api::domain::provider::ToolCall;
use mixdog_core_api::domain::provider::ProgressKind;
use mixdog_core_api::domain::provider::Usage;
use mixdog_core_api::domain::tool::ToolOutput;
use mixdog_core_api::domain::retry::RetryDecider;
use mixdog_core_api::domain::retry::RetryReason;
use mixdog_protocol::ApprovalResolution;
use mixdog_protocol::JsonValue;
use mixdog_protocol::ThreadId;
use mixdog_protocol::ToolCallId;
use tokio_util::sync::CancellationToken;

use crate::message::AgentMessage;
use crate::message::ToolKind;

pub trait Clock: Send + Sync {
    /// Epoch milliseconds.
    fn now_ms(&self) -> i64;
}

/// One draw in `0.0..=1.0` per call (a `Math.random()` value).
pub trait JitterSource: Send + Sync {
    fn draw(&self) -> f64;
}

/// The host's cancel-unaware delay (its timer wheel). The loop races every
/// wait against the run's token, so a wait never delays an abort.
#[async_trait]
pub trait RetryWait: Send + Sync {
    async fn wait(&self, delay: Duration);
}

// ---------------------------------------------------------------------------
// Steering
// ---------------------------------------------------------------------------

/// Where in a round a drain happens. The host scopes which queues a drain may
/// consume by stage.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum DrainStage {
    /// After a tool batch, before the next provider request.
    PreSend,
    /// The terminal check that precedes the stop hooks.
    Terminal,
}

impl DrainStage {
    pub fn label(self) -> &'static str {
        match self {
            Self::PreSend => "pre-send",
            Self::Terminal => "terminal",
        }
    }
}

/// Queue priority ceiling of a drain (`next` normally, `later` after a Sleep).
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Priority {
    Next,
    Later,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct DrainRequest {
    pub stage: DrainStage,
    pub max_priority: Priority,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum SteerMode {
    Prompt,
    TaskNotification,
}

/// One queued input entry the host hands to a drain. Only entries whose user
/// message is already durable are offered: memory never runs ahead of disk.
#[derive(Clone, PartialEq, Debug)]
pub struct SteerEntry {
    pub content: Content,
    pub text: Option<String>,
    pub ids: Vec<String>,
    pub submitted_at: Option<i64>,
    pub message_id: Option<String>,
    pub mode: SteerMode,
    pub execution: Option<JsonValue>,
}

#[async_trait]
pub trait SteerSource: Send + Sync {
    /// Takes the queued input for this boundary from the session actor, which
    /// owns the queue; the loop races the call against the run token.
    async fn drain(&self, request: DrainRequest) -> Vec<SteerEntry>;
}

/// Explicit skill selection for typed steering input, run before the next
/// provider snapshot.
#[async_trait]
pub trait SkillSelector: Send + Sync {
    async fn select(&self, content: &Content, transcript: &mut Vec<AgentMessage>);
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

/// How a notice is shown (`tone: 'warn'` in Node's stage payload; anything else is `info`).
#[derive(Clone, Copy, PartialEq, Eq, Debug, Default)]
pub enum Tone {
    #[default]
    Info,
    Warn,
}

impl Tone {
    /// The notice item's `level`.
    pub fn as_str(self) -> &'static str {
        match self {
            Tone::Info => "info",
            Tone::Warn => "warn",
        }
    }
}

#[derive(Clone, PartialEq, Debug)]
pub enum Stage {
    Connecting,
    Streaming,
    /// A provider ping or comment: informational only.
    WaitingOnProvider,
    Reconnecting {
        attempt: u32,
        max: u32,
        delay: Duration,
        reason: RetryReason,
    },
    /// The model changed for the rest of the turn.
    ModelFallback {
        model: String,
    },
    /// A display-only transcript notice (`onStageChange('notice', { tone, message })`).
    Notice {
        message: String,
        tone: Tone,
    },
    Compacting,
    ApprovalWait {
        waiting: bool,
    },
}

#[derive(Clone, PartialEq, Debug)]
pub struct SteerInjected {
    pub text: String,
    pub ids: Vec<String>,
    pub submitted_at: Option<i64>,
    pub injected_at: i64,
    pub stage: DrainStage,
    pub task_notification: bool,
    pub execution: Option<JsonValue>,
    pub message_id: String,
}

#[derive(Clone, PartialEq, Eq, Debug)]
pub enum CompactTrigger {
    Auto,
    Reactive,
    CacheExpired,
}

impl CompactTrigger {
    /// Node's `compactTrigger`.
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Auto => "auto",
            Self::Reactive => "reactive",
            Self::CacheExpired => "cache_expired",
        }
    }
}

/// One stage of a pre-send compaction pass, with the request it ran for: what the header's
/// compaction telemetry records of it (`compactTelemetry` of `compactBeforeSend`).
#[derive(Clone, PartialEq, Debug)]
pub struct CompactPass {
    /// The transcript about to go out, as the pass found it, and the request's tools.
    pub request: Vec<AgentMessage>,
    pub tools: Vec<mixdog_core_api::domain::provider::ToolDefinition>,
    /// A context-overflow retry was pending when the pass was decided.
    pub reactive: bool,
    pub trigger: CompactTrigger,
    pub stage: PassStage,
}

#[derive(Clone, PartialEq, Debug)]
pub enum PassStage {
    /// The compaction stage began.
    Started,
    /// The pass ended without a compaction having been adopted or refused: `changed` says whether
    /// the transcript changed, `after` is the transcript now, `after_tokens` its gauge figure.
    Done { changed: bool, handoff_source: &'static str, after_tokens: u64, duration_ms: u64, after: Vec<AgentMessage> },
    /// The pass found no token reduction (`freshContextResult.skipped`).
    Skipped,
    /// The pass failed with `message`.
    Failed { message: String, duration_ms: u64 },
}

/// What a compaction took out of the model context: the stable ids of the
/// messages whose text left and the tool calls that left.
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct Dropped {
    pub message_ids: Vec<String>,
    pub call_ids: Vec<String>,
}

/// What a transcript rewrite took out of the model context (Node `droppedMessages` and
/// `droppedIdentities`); empty for a repair or a pass that dropped nothing shown.
#[derive(Clone, PartialEq, Eq, Debug, Default)]
pub struct Rewrite {
    pub dropped_count: u64,
    pub dropped: Option<Dropped>,
}

/// Node's event `status`: `compacted`, `no_change` (shown as checked), `skipped`, `failed`.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum CompactStatus {
    Compacted,
    NoChange,
    Skipped,
    Failed,
}

impl CompactStatus {
    /// `applyCompactEvent`'s `compactChanged`.
    pub fn changed(self) -> bool {
        self == Self::Compacted
    }
}

#[derive(Clone, PartialEq, Debug)]
pub struct CompactEvent {
    /// Node's `droppedMessages`: messages that left the context; 0 when nothing visible was removed.
    pub dropped_count: u64,
    /// `None` when nothing identifiable was dropped.
    pub dropped: Option<Dropped>,
    pub trigger: CompactTrigger,
    pub status: CompactStatus,
    /// Node `beforeTokens`: the provider's last measured context, else the pass's pressure
    /// (`compactDisplayBeforeTokens`).
    pub before_tokens: u64,
    /// Node `durationMs`: the pass, from the start of the compaction stage to its end.
    pub duration_ms: u64,
    /// Node `afterTokens`: the context estimate after the pass, on the pre-compact gauge's scale; a
    /// failed pass reports the pressure it started from.
    pub after_tokens: u64,
    pub before_messages: usize,
    pub after_messages: usize,
    pub pressure_tokens: u64,
    pub trigger_tokens: u64,
    pub boundary_tokens: u64,
    pub target_budget_tokens: u64,
}

/// What Node's `usageDeltaEvent` carries about one model call beyond the token counts.
#[derive(Clone, PartialEq, Debug)]
pub struct UsageDelta {
    /// `response.model || model`: the model that answered.
    pub model: String,
    /// The model the request named.
    pub requested_model: String,
    /// `deltaToolCalls`: the tool calls the response dispatched.
    pub delta_tool_calls: u64,
    /// `requestMs`: the send, from before the first attempt to the end of the response (retries and
    /// the wait for the first token included).
    pub request_ms: u64,
    /// `deltaPrompt`: the call's prompt tokens (cache included).
    pub delta_prompt: u64,
    /// `sendTools`: the tools the request carried.
    pub send_tools: Vec<mixdog_core_api::domain::provider::ToolDefinition>,
    /// `reasoningUsage(usage)`: `None` when the provider reported none (missing is not zero).
    pub reasoning_tokens: Option<u64>,
    pub reasoning_tokens_complete: bool,
    /// `outgoing`: the transcript the request carried, which the provider's reading is aligned to
    /// (`recordProviderContextBaseline`).
    pub outgoing: Vec<AgentMessage>,
    /// `sendStartedAt`: when the request's send began (`lastProviderSendAt`).
    pub sent_at_ms: i64,
}

#[derive(Clone, PartialEq, Debug)]
pub enum RunEvent {
    Stage(Stage),
    TextDelta(String),
    ReasoningDelta(String),
    /// Mid-turn assistant text surfaced before a tool card, or a kept answer.
    AssistantText { text: String, committed: bool },
    ToolCalls { iteration: u32, calls: Vec<ToolCall> },
    ToolResult { call_id: String, kind: ToolKind },
    SteerInjected(SteerInjected),
    Usage { iteration: u32, usage: Usage, delta: UsageDelta },
    ContextPressure {
        used_tokens: u64,
        trigger_tokens: u64,
        boundary_tokens: u64,
        /// The session's window (policy.contextWindow), when it states one.
        context_window: Option<u64>,
        will_compact: bool,
        /// The request about to go out, for the check's telemetry (`compactTelemetry`): its
        /// transcript, its tools, and whether a context-overflow retry is pending.
        messages: Vec<AgentMessage>,
        tools: Vec<mixdog_core_api::domain::provider::ToolDefinition>,
        reactive: bool,
    },
    Compact(CompactEvent),
    /// A stage of a pre-send compaction pass, for the header's compaction telemetry.
    CompactPass(Box<CompactPass>),
    /// A [`StreamEvent::Progress`] of the provider stream: model progress that is no text or reasoning delta (a tool call's
    /// arguments or end, an item boundary), reported where Node's decoder calls `onStreamDelta(kind)`.
    ToolStream(ProgressKind),
    /// A [`StreamEvent::ChunkProgress`]: the chunk reports this one kind (`None`: transport only) and the stream's
    /// deltas report none of their own from here on.
    Chunk(Option<ProgressKind>),
    /// The summary model's usage of a compaction pass (`accumulateCompactUsage`): one usage report of the turn,
    /// at the loop's next iteration index, with the reasoning figure `reasoningUsage(usage)` reads of it.
    CompactUsage { iteration: u32, usage: Usage, reasoning_tokens: Option<u64>, reasoning_tokens_complete: bool },
    /// A call that ran settled (Node's early notice, `notifyEarlyResult`: `onToolResult` with `__earlyNotify`), the
    /// instant it does and in completion order, before its result commits in call order: the UI's live row and the
    /// interruption (which keeps what the stop left uncommitted) both read it. `Error` kind only for a thrown call.
    EarlyResult(AgentMessage),
}

#[derive(Clone, PartialEq, Debug)]
pub struct TextRetraction {
    pub chars: usize,
    pub reasoning: bool,
    pub reason: RetractReason,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum RetractReason {
    OutputLimitEscalation,
    TransportRetraction,
}

/// What the owner of the shown text did with a retraction request.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Retracted {
    Withdrawn,
    /// The owner could not withdraw the text.
    Refused,
}

/// The run's view for clients (feed), non-blocking.
pub trait RunObserver: Send + Sync {
    fn event(&self, event: RunEvent);

    /// Whether the owner offers any way to withdraw shown text. Without one, a
    /// stream cut mid-text is kept as shown and resumed, not replayed.
    fn can_retract(&self) -> bool;

    /// Withdraws `chars` of already shown text before a replay. Text the
    /// owner cannot withdraw would be shown twice.
    fn retract_text(&self, retraction: TextRetraction) -> Retracted;
}

// ---------------------------------------------------------------------------
// Transcript
// ---------------------------------------------------------------------------

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct Ticket(pub u64);

/// A message could not be committed.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CommitError {
    /// The attachment store could not run the read the message's classification needs: nothing
    /// was queued.
    StoreUnavailable,
}

impl std::fmt::Display for CommitError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::StoreUnavailable => f.write_str("the attachment store is unavailable; the message was not committed"),
        }
    }
}

impl std::error::Error for CommitError {}

/// Where committed messages go. `commit` classifies the message (which may read the attachment
/// store) and queues it for durability; `durable` resolves when that message is on disk.
#[async_trait]
pub trait TranscriptSink: Send + Sync {
    /// Cancel-safe: the message is queued, and its ticket numbered, only after the classification.
    async fn commit(&self, message: &AgentMessage) -> Result<Ticket, CommitError>;

    /// The transcript was rewritten (compaction or repair); `messages` is the new
    /// model context and `rewrite` what the pass took out of it.
    fn replace(&self, messages: &[AgentMessage], rewrite: &Rewrite);

    /// A fresh stable id for a message that arrives without one.
    fn message_id(&self) -> String;

    /// Cancel-safe.
    async fn durable(&self, ticket: Ticket);
}

// ---------------------------------------------------------------------------
// Compaction
// ---------------------------------------------------------------------------

pub struct CompactRequest<'a> {
    pub messages: &'a [AgentMessage],
    pub budget_tokens: u64,
    pub trigger: CompactTrigger,
    /// An automatic pass never replaces the transcript with an equal-sized or
    /// larger one.
    pub require_reduction: bool,
    /// The provider refused the request as too long: the latest request's
    /// attachments now travel by reference.
    pub reference_latest_attachments: bool,
}

pub struct CompactOutput {
    pub messages: Vec<AgentMessage>,
    /// Summary-model usage, billed to the turn.
    pub usage: Option<Usage>,
    /// Messages taken out of the context whose rows the transcript shows (0 when
    /// none of what left is shown, or the pass changed nothing).
    pub dropped_count: u64,
    /// The ids of what left; `Some` exactly when `dropped_count`'s rows are shown.
    pub dropped: Option<Dropped>,
    /// The pass found no token reduction (`freshContextResult.skipped`): nothing is adopted and no
    /// marker is shown.
    pub skipped: bool,
    /// Whole milliseconds the pipeline took (`diagnostics.pipeline.totalMs` of `runFreshContextCompact`): the
    /// summary decision, the summary itself and the rebuild, not the media preparation before them nor the
    /// dropped-row summary after.
    pub pipeline_ms: f64,
    /// Whole milliseconds the summary request took (`pipeline.generated.durationMs`); none when no summary was written.
    pub summary_ms: Option<f64>,
}

#[derive(Debug)]
pub enum CompactError {
    /// The summary request itself overflowed the model window.
    Overflow(String),
    /// The pass was cancelled; the run ends as aborted, not as a failed compaction.
    Aborted,
    Failed(String),
}

/// The compaction pipeline (rules and summary). The loop owns when it runs and
/// what adopting its result resets; the pipeline owns what the new transcript
/// contains.
#[async_trait]
pub trait Compactor: Send + Sync {
    /// Local token estimate of a transcript. [`Self::prepare`] runs first on the messages measured.
    fn estimate_tokens(&self, messages: &[AgentMessage]) -> u64;

    /// Reads what the estimates and triggers on `messages` need from the attachment store; awaited
    /// before `estimate_tokens` and `request_media` are asked about new messages.
    async fn prepare(&self, messages: &[AgentMessage]) {
        let _ = messages;
    }

    /// Whether compacting to `budget_tokens` would shrink the transcript.
    async fn reduces(&self, request: &CompactRequest<'_>) -> bool;

    /// Cancel-safe: dropping the future abandons the pass.
    async fn compact(&self, request: CompactRequest<'_>) -> Result<CompactOutput, CompactError>;

    /// Whether the agent session's cache tail expired before this request: a
    /// cold send would rewrite the whole transcript, so compacting first
    /// makes that write the compacted one.
    fn cache_expired(&self) -> bool {
        false
    }

    /// Whether tool-result media alone would make the next request too large.
    fn request_media(&self, messages: &[AgentMessage]) -> bool {
        let _ = messages;
        false
    }
}

// ---------------------------------------------------------------------------
// Routing, tools, guards
// ---------------------------------------------------------------------------

/// The next model of the session's fallback chain, taken after a provider
/// error survived every retry.
pub struct RouteSwitch {
    pub provider: Arc<dyn ProviderAdapter>,
    pub model: String,
    /// The muted transcript line announcing the hop.
    pub notice: String,
    /// The new route's effort projection inputs and consuming adapter, if it
    /// takes mid-conversation updates.
    pub effort: Option<crate::effort::EffortWiring>,
    /// The new route's text-only input handling, if its model takes no media.
    pub text_only: Option<crate::text_only::TextOnlyInput>,
}

/// The agent lane's slot, as the loop uses it (`runYielded`): a provider request is I/O, so the
/// slot goes back to the pool while it is in flight and is taken again before the loop goes on.
#[async_trait]
pub trait Yielder: Send + Sync {
    /// Runs `task` with the slot handed back. `task` answers whether the request succeeded: a
    /// failed one leaves the slot suspended until the next successful call or the release, so the
    /// failure reaches the caller even when every slot is busy. `Err` is the cancelled
    /// re-acquisition's reason.
    async fn run_yielded(&self, task: futures::future::BoxFuture<'_, bool>, cancel: Option<&crate::cancel::Cancel>) -> Result<(), String>;
}

/// What the loop does with a failure no retry covers (Node `advanceAgentRoute`'s three ends).
pub enum RouteDecision {
    /// The request goes to the next model.
    Switch(RouteSwitch),
    /// The error surfaces. After a chain that ran out it carries every model tried
    /// (`annotateEndedChain`): its message has the "every model failed" text appended.
    Surface(Box<ChainSurface>),
    /// The hop itself failed and its error replaces the provider's, as a throw does in Node
    /// (a provider that is not there, a session closed during the hop).
    Fail(String),
}

/// The error to surface and, after a hop, what the chain tried.
#[derive(Clone, PartialEq, Debug)]
pub struct ChainSurface {
    pub error: ProviderError,
    /// `routeFallbackAttempts`; empty when the error is unchanged.
    pub attempts: Vec<JsonValue>,
    /// `routeFallbackStoppedBefore`: the next route when the chain stopped before it.
    pub stopped_before: Option<JsonValue>,
}

/// One model's own share of the turn, priced at its own rates.
#[derive(Clone, PartialEq, Debug)]
pub struct UsageSegment {
    pub provider: String,
    pub model: String,
    pub usage: Usage,
}

#[async_trait]
pub trait RouteFallback: Send + Sync {
    /// `advanceAgentRoute`: after a provider error survived every retry, the next model of the
    /// session's chain, the error to surface, or the failure of the hop itself. `last_usage` is
    /// the turn's running usage total, booked against the model being left.
    async fn advance(&self, error: ProviderError, last_usage: Option<&Usage>) -> RouteDecision;

    /// `routeUsageSegments` at the end of the turn: the turn's usage split per model when the
    /// route switched mid-turn (empty when it did not). `current` is the model the turn ended on.
    fn usage_segments(&self, total: &Usage, current: (&str, &str)) -> Vec<UsageSegment>;
}

/// A tool call as the policy sees it.
#[derive(Clone, PartialEq, Debug)]
pub struct GateCall {
    pub name: String,
    pub args: JsonValue,
    /// The name the call has in the schema when routing renamed it (`web_fetch` sent to
    /// `local_fetch` or `image_fetch` keeps `web_fetch`): the surface (allowlist, denied tools,
    /// connectors, read-only) judges the call under this name, not the transport's.
    pub schema_name: Option<String>,
}

impl GateCall {
    pub fn new(name: impl Into<String>, args: JsonValue) -> Self {
        Self { name: name.into(), args, schema_name: None }
    }
}

/// The pre-execution policy of one call: surface denial, PreToolUse hooks and
/// human gate, all folded into one typed answer by the host.
#[derive(Clone, PartialEq, Debug)]
pub enum GateDecision {
    Allow,
    /// Allow with a hook's rewrite of the call.
    Rewrite(GateCall),
    /// The model-visible denial text.
    Deny(String),
    Ask(Box<GateAsk>),
}

#[derive(Clone, PartialEq, Debug)]
pub struct GateAsk {
    /// Why approval is asked, as the card and the denial text show it.
    pub reason: String,
    pub ask: ApprovalAsk,
    /// The call after any hook rewrite, if the hook rewrote it.
    pub call: Option<GateCall>,
}

#[async_trait]
pub trait ToolGate: Send + Sync {
    /// The answer for one call. `call_id` is the provider's id, which hooks and the approval
    /// card carry.
    async fn check_call(&self, call_id: &str, call: &GateCall) -> GateDecision;

    /// The session-surface denial of a call (schema allowlist, read-only
    /// surface, disabled feature), judged before any dedup stub or cached
    /// result can answer the call: they must not bypass the current surface.
    fn pre_dispatch_deny(&self, call: &GateCall) -> Option<String> {
        let _ = call;
        None
    }

    /// The last refusal a call meets, after its hooks and approval and before the tool runs
    /// (`prepareDeferredToolCallThrough`): a deferred tool the session may not run in its tool mode.
    fn deferred_call_denial(&self, call: &GateCall) -> Option<String> {
        let _ = call;
        None
    }

    /// An approved ask may carry the user's edit of the call.
    fn apply_approval(
        &self,
        call: &GateCall,
        decision: &mixdog_protocol::ToolApprovalDecision,
    ) -> GateCall {
        let _ = decision;
        call.clone()
    }
}

/// PostToolUse, PostToolUseFailure and PostToolBatch hooks. Best-effort: a
/// hook never breaks the loop.
#[async_trait]
pub trait ToolHooks: Send + Sync {
    /// May override the model-visible text of a successful call.
    async fn after_tool(&self, call: &GateCall, result: &str) -> Option<String> {
        let _ = (call, result);
        None
    }
    async fn after_failure(&self, call: &GateCall, result: &str) {
        let _ = (call, result);
    }
    /// The whole batch resolved: `Some(reason)` blocks continuation and
    /// injects the reason as a system note before the next model call.
    async fn after_batch(&self, tool_count: usize) -> Option<String> {
        let _ = tool_count;
        None
    }
}

/// A cached tool result that still describes the world (the tool layer owns
/// validity). `first_tool_use_id` names the call that first delivered the body.
pub struct Reused {
    pub content: String,
    pub first_tool_use_id: String,
}

/// Async because freshness reads the file system (a metadata stat per path argument), which a host
/// runs as a lane job, not on the runtime thread.
#[async_trait]
pub trait ResultReuse: Send + Sync {
    async fn lookup(&self, call: &ToolCall, touch: bool) -> Option<Reused>;
    /// Records the body a successful read-only call delivered. `output` is the
    /// tool's own result with `parts` and `follow_up_messages` emptied (the
    /// model-visible body is `content`): its `meta` and flags are what the
    /// tool layer reads, e.g. `code_graph::dependency_roots(output)`.
    async fn store(&self, call: &ToolCall, content: &str, tool_use_id: &str, output: &ToolOutput);
    /// A call ran: mutations and failures invalidate what they may have touched.
    async fn after_call(&self, call: &ToolCall, failed: bool);
}

/// What a successful react call hit.
pub struct ReactionTarget {
    pub message_id: String,
    /// The reaction landed in a group room's log, not the worker's own.
    pub room: bool,
}

pub trait Reactions: Send + Sync {
    fn is_reaction_call(&self, call: &ToolCall) -> bool;
    /// Consumed: `None` when the call recorded no target.
    fn take_target(&self, call_id: &str) -> Option<ReactionTarget>;
    /// Real user input a reaction can answer (reminders and notices are not).
    fn is_reactable(&self, message: &AgentMessage) -> bool;
    /// The newest room-log row a room member's prompt shows.
    fn room_row(&self, message: &AgentMessage) -> Option<String>;
}

/// The per-request tail reminder text for the session's route, if any rule
/// matches. It is appended to the request only and never stored as a message.
pub trait TailReminder: Send + Sync {
    fn text(&self, model: &str) -> Option<String>;
}

/// The run's session MCP catalog (Node `refreshDeferredMcpToolCatalog(session)`): the connected names,
/// the late pool and the pending deferred-tools delta follow the live MCP registry. The loop runs it
/// where Node does: at every request boundary, at the start of every tool call, and again for an MCP
/// tool call once its gate has passed.
#[async_trait]
pub trait McpCatalog: Send + Sync {
    async fn refresh(&self);

    /// The run's tools as the session holds them now, rebuilt after a refresh (Node's `session.tools`, whose
    /// active MCP entries `reconcileDeferredMcpToolCatalog` re-links to the live server tool): the request
    /// boundary adopts their changed MCP definitions. `None`: the host keeps the run's set. A failure fails the request.
    async fn tools(&self) -> Result<Option<crate::tools::ToolSet>, String> {
        Ok(None)
    }

    /// `snapshotProviderRequestTools`: the candidate request tools (the session's, in order) as the session's
    /// deferred state makes them available, the catalog tools its native tool search discovered added marked
    /// `defer_loading`. `messages`: the transcript the request is built from.
    async fn snapshot(
        &self,
        tools: Vec<mixdog_core_api::domain::provider::ToolDefinition>,
        _messages: &[crate::message::AgentMessage],
    ) -> Result<Vec<mixdog_core_api::domain::provider::ToolDefinition>, String> {
        Ok(tools)
    }

    /// `migrateToolExposureAtBoundary(session, messages)`: a session persisted for another tool exposure than its
    /// provider's is migrated, unless a tool call of `messages` (the transcript the request is built from) waits for
    /// its result. The new system messages when it migrated; `None` when it did not.
    async fn migrate(&self, _messages: &[crate::message::AgentMessage]) -> Result<Option<Vec<crate::message::AgentMessage>>, String> {
        Ok(None)
    }
}

/// Todo / goal reminders around the end of a turn. State lives with the
/// session (a user cycle spans several turns).
#[async_trait]
pub trait TurnGuards: Send + Sync {
    /// A tool batch ran: the last reminder produced progress.
    fn note_progress(&self);
    /// The turn now waits on the user (approval denied).
    fn note_user_wait(&self);
    /// The cycle state `session.todoCheck` holds now, once it exists.
    fn saved(&self) -> Option<serde_json::Value>;
    /// The hidden stale-list reminder to append after a batch, if any. Reads
    /// the todo list and goal from the session actor.
    async fn stale_reminder(&self, calls: &[ToolCall], results: &[AgentMessage]) -> Option<String>;
    /// The reminder to send before the turn may end, if any.
    async fn completion_reminder(&self, turn_limited: bool) -> Option<String>;
}

/// No todo or goal tracking.
pub struct NoGuards;

#[async_trait]
impl TurnGuards for NoGuards {
    fn note_progress(&self) {}
    fn note_user_wait(&self) {}
    fn saved(&self) -> Option<serde_json::Value> {
        None
    }
    async fn stale_reminder(&self, _calls: &[ToolCall], _results: &[AgentMessage]) -> Option<String> {
        None
    }
    async fn completion_reminder(&self, _turn_limited: bool) -> Option<String> {
        None
    }
}

/// Allows every call.
pub struct AllowAll;

#[async_trait]
impl ToolGate for AllowAll {
    async fn check_call(&self, _call_id: &str, _call: &GateCall) -> GateDecision {
        GateDecision::Allow
    }
}

/// The renderer translates this exact text (`ALLOW_NOT_SAVED_NOTICE` in Node's before-hook).
pub const ALLOW_NOT_SAVED_NOTICE: &str = "Allowed this once. The setting could not be saved.";

/// The connector account a call is bound to (`resolveMcpToolAccount`): `name` is unique and binds
/// the call (`args.account`); `label` is what the approval card shows.
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct BoundAccount {
    pub name: String,
    pub label: String,
}

/// What the policy-backed gate reads from the owning session, per call.
#[async_trait]
pub trait GateSession: Send + Sync {
    /// Who is acting (agent, bot, run kind, life mark).
    /// Async because the acting bot is decided by a fresh read of the agent definition on every
    /// call (`gate.mjs:131`).
    async fn facts(&self) -> mixdog_tools::policy::SessionFacts;
    /// `connectorPolicyAgentOf`: the one fact the pre-dispatch refusal needs, from the header alone.
    fn connector_agent_id(&self) -> String;
    /// The session's tool surface (allowlist, denied tools, read-only, workflow, route
    /// exclusions); the per-tool connector flags are set by the gate.
    fn surface(&self) -> mixdog_tools::policy::SessionSurface;
    /// The developer options the policy reads ("Allow all actions").
    fn settings(&self) -> mixdog_tools::policy::PolicySettings;
    /// The connector account the call is bound to: the one `args.account` names, else the one used
    /// last. `Ok(None)` for a call bound to no account. `Err` is the refusal (usable accounts
    /// listed), which the model sees as the call's result before any hook or card.
    async fn account(&self, call: &GateCall) -> Result<Option<BoundAccount>, String>;
}

/// `{ ...args, account }`: a connector call carries the account it was approved for.
fn with_account(args: &JsonValue, account: &str) -> JsonValue {
    let mut map = args.as_object().cloned().unwrap_or_default();
    map.insert("account".to_owned(), JsonValue::String(account.to_owned()));
    JsonValue::Object(map)
}

/// `ApprovalGate` seen from the loop: while the person decides the run is waiting on them
/// (`Stage::ApprovalWait`), and a "no" (or a timeout) lets the turn end waiting on them.
struct WaitingApprovals {
    inner: Arc<dyn mixdog_core_api::domain::approval::ApprovalGate>,
    observer: Arc<dyn RunObserver>,
    guards: Arc<dyn TurnGuards>,
}

/// Ends the wait stage even when the asking future is dropped.
struct WaitEnd(Arc<dyn RunObserver>);

impl Drop for WaitEnd {
    fn drop(&mut self) {
        self.0.event(RunEvent::Stage(Stage::ApprovalWait { waiting: false }));
    }
}

#[async_trait]
impl mixdog_core_api::domain::approval::ApprovalGate for WaitingApprovals {
    async fn request(&self, ask: ApprovalAsk) -> ApprovalResolution {
        self.observer.event(RunEvent::Stage(Stage::ApprovalWait { waiting: true }));
        let _end = WaitEnd(Arc::clone(&self.observer));
        let resolution = self.inner.request(ask).await;
        let approved = matches!(&resolution, ApprovalResolution::Decided { decision, .. } if decision.approved);
        if !approved {
            self.guards.note_user_wait();
        }
        resolution
    }
}

/// The production `ToolGate`: Node's `preDispatchDenyForSession` and `applyBeforeToolHook`
/// (surface refusal, PreToolUse hook, human gate, approval, connector ask) behind one answer,
/// by `mixdog_tools::policy::ToolPolicy::authorize`. The approval is awaited inside the gate
/// (through the run's `ApprovalGate`), so it never answers `GateDecision::Ask`.
pub struct PolicyGate {
    policy: Arc<mixdog_tools::policy::ToolPolicy>,
    connectors: Arc<dyn mixdog_tools::policy::ConnectorPermissions>,
    session: Arc<dyn GateSession>,
    tools: Arc<dyn mixdog_tools::policy::ToolResolver>,
    grants: Arc<mixdog_tools::policy::SessionGrants>,
    approvals: WaitingApprovals,
    thread_id: ThreadId,
    cwd: std::path::PathBuf,
    cancel: CancellationToken,
}

/// Everything [`PolicyGate::new`] needs; `connectors` is the one `policy` was built with.
pub struct PolicyGateParts {
    pub policy: Arc<mixdog_tools::policy::ToolPolicy>,
    pub connectors: Arc<dyn mixdog_tools::policy::ConnectorPermissions>,
    pub session: Arc<dyn GateSession>,
    pub tools: Arc<dyn mixdog_tools::policy::ToolResolver>,
    /// "Allow for this session" grants; one per session.
    pub grants: Arc<mixdog_tools::policy::SessionGrants>,
    /// The run's approval entry point (the session actor's).
    pub approvals: Arc<dyn mixdog_core_api::domain::approval::ApprovalGate>,
    pub observer: Arc<dyn RunObserver>,
    pub guards: Arc<dyn TurnGuards>,
    pub thread_id: ThreadId,
    pub cwd: std::path::PathBuf,
    /// The run's token: a cancelled run ends a pending approval.
    pub cancel: CancellationToken,
}

impl PolicyGate {
    pub fn new(parts: PolicyGateParts) -> Self {
        Self {
            policy: parts.policy,
            connectors: parts.connectors,
            session: parts.session,
            tools: parts.tools,
            grants: parts.grants,
            approvals: WaitingApprovals {
                inner: parts.approvals,
                observer: parts.observer,
                guards: parts.guards,
            },
            thread_id: parts.thread_id,
            cwd: parts.cwd,
            cancel: parts.cancel,
        }
    }

    /// The session surface with the flags that depend on the called tool.
    fn surface_for(&self, name: &str) -> mixdog_tools::policy::SessionSurface {
        let mut surface = self.session.surface();
        surface.connector_disabled = self.connectors.disabled(&self.session.connector_agent_id(), name);
        surface.project_disabled = self.connectors.project_disabled(&self.thread_id, name);
        surface
    }
}

#[async_trait]
impl ToolGate for PolicyGate {
    async fn check_call(&self, call_id: &str, call: &GateCall) -> GateDecision {
        let facts = self.session.facts().await;
        let surface = self.session.surface();
        // A connector call is bound to its account before any hook or card sees it, so an
        // approval approves that account, whatever is used last meanwhile (`tool-exec.mjs`).
        let bound = match self.session.account(call).await {
            Ok(bound) => bound.filter(|account| !account.name.is_empty()),
            Err(message) => return GateDecision::Deny(format!("Error: {message}")),
        };
        let account = bound.as_ref().map(|account| account.label.as_str()).filter(|label| !label.is_empty());
        let args = match &bound {
            Some(bound) => with_account(&call.args, &bound.name),
            None => call.args.clone(),
        };
        let call_id = ToolCallId::from(call_id);
        let authorized = self
            .policy
            .authorize(mixdog_tools::policy::AuthorizeRequest {
                call_id: &call_id,
                thread_id: &self.thread_id,
                name: &call.name,
                args,
                cwd: &self.cwd,
                facts: &facts,
                surface: &surface,
                schema_name: call.schema_name.as_deref(),
                settings: self.session.settings(),
                account,
                session_grants: &self.grants,
                tools: self.tools.as_ref(),
                approvals: &self.approvals,
                cancel: &self.cancel,
            })
            .await;
        match authorized {
            Err(error) => GateDecision::Deny(error.message_for_model),
            Ok(authorized) => {
                if authorized.allow_not_saved {
                    self.approvals.observer.event(RunEvent::Stage(Stage::Notice {
                        message: ALLOW_NOT_SAVED_NOTICE.to_owned(),
                        tone: Tone::Warn,
                    }));
                }
                // A hook's rewrite of the same tool keeps the bound account.
                let args = match &bound {
                    Some(bound) if authorized.name == call.name => with_account(&authorized.args, &bound.name),
                    _ => authorized.args,
                };
                if authorized.name == call.name && args == call.args {
                    GateDecision::Allow
                } else {
                    GateDecision::Rewrite(GateCall::new(authorized.name, args))
                }
            }
        }
    }

    fn pre_dispatch_deny(&self, call: &GateCall) -> Option<String> {
        // Judged under the schema name, as `preDispatchDenyForSession` does.
        let schema = call.schema_name.as_deref().unwrap_or(&call.name);
        self.surface_for(schema)
            .refusal_for_call(&call.name, call.schema_name.as_deref(), &call.args)
            .map(|error| error.message_for_model)
    }

    fn deferred_call_denial(&self, call: &GateCall) -> Option<String> {
        let surface = self.session.surface();
        let annotations = self.tools.resolve(surface.mcp_scope.as_deref(), &call.name).map(|tool| tool.spec().annotations.clone()).unwrap_or_default();
        surface.deferred_call_refusal(&call.name, &annotations)
    }
}

pub struct NullObserver;

impl RunObserver for NullObserver {
    fn event(&self, _event: RunEvent) {}
    fn can_retract(&self) -> bool {
        false
    }
    fn retract_text(&self, _retraction: TextRetraction) -> Retracted {
        Retracted::Refused
    }
}

/// The host's record of the request a logical send is sending (Node `captureSideQuestionRequest`): the
/// request a `/btw` side question and a compaction summary fork.
pub trait SendTap: Send + Sync {
    /// The send starts with `request`: its first attempt's request, before any retry.
    fn begin(&self, request: &ModelRequest) -> Box<dyn SendTicket>;
}

/// One captured send, ended exactly once.
pub trait SendTicket: Send + Sync {
    /// The send proceeded with `response`.
    fn settle(self: Box<Self>, response: &crate::response::ModelResponse);
    /// The send failed or was handed to another round: the request before it is put back.
    fn discard(self: Box<Self>);
}

/// Everything a run borrows from its host.
#[derive(Clone)]
pub struct RunEnv {
    pub clock: Arc<dyn Clock>,
    pub jitter: Arc<dyn JitterSource>,
    pub waiter: Arc<dyn RetryWait>,
    pub decider: Arc<dyn RetryDecider>,
    pub steer: Arc<dyn SteerSource>,
    pub observer: Arc<dyn RunObserver>,
    pub sink: Arc<dyn TranscriptSink>,
    pub gate: Arc<dyn ToolGate>,
    pub guards: Arc<dyn TurnGuards>,
    pub compactor: Option<Arc<dyn Compactor>>,
    pub route: Option<Arc<dyn RouteFallback>>,
    pub skills: Option<Arc<dyn SkillSelector>>,
    pub hooks: Option<Arc<dyn ToolHooks>>,
    pub reuse: Option<Arc<dyn ResultReuse>>,
    pub reactions: Option<Arc<dyn Reactions>>,
    pub tail: Option<Arc<dyn TailReminder>>,
    /// The session's MCP catalog, refreshed at the request boundary and around every tool call.
    pub mcp: Option<Arc<dyn McpCatalog>>,
    /// Records the request a logical send is sending (captureSideQuestionRequest).
    pub side: Option<Arc<dyn SendTap>>,
    pub step_judge: Option<Arc<dyn crate::step_effort::StepEffortJudge>>,
    /// Where oversized tool results are stored (without one they stay inline).
    pub artifacts: Option<Arc<dyn crate::offload::ArtifactStore>>,
    pub images: Option<Arc<dyn crate::offload::ImageCompactor>>,
}

/// Awaits `fut`, or returns `None` when the run's token is cancelled first.
pub async fn or_cancelled<F: std::future::Future>(
    cancel: &CancellationToken,
    fut: F,
) -> Option<F::Output> {
    mixdog_rt::Scope::new().cancel(cancel).run(fut).await.done()
}
