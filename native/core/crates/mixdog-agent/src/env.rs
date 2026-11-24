//! What a run needs from its host, as narrow traits. The session actor, the
//! feed, the store, the timer wheel and the compaction pipeline implement
//! these; the loop never reads a clock, draws randomness or waits on its own.

use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use mixdog_core_api::domain::approval::ApprovalAsk;
use mixdog_core_api::domain::provider::Content;
use mixdog_core_api::domain::provider::ModelRequest;
use mixdog_core_api::domain::provider::ProgressKind;
use mixdog_core_api::domain::provider::ProviderAdapter;
use mixdog_core_api::domain::provider::ProviderError;
use mixdog_core_api::domain::provider::ToolCall;
use mixdog_core_api::domain::provider::Usage;
use mixdog_core_api::domain::retry::RetryDecider;
use mixdog_core_api::domain::retry::RetryReason;
use mixdog_core_api::domain::tool::ToolOutput;
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
    /// How many of the entry's images go without their original (the core's own count; `originals_missing` of the
    /// message it becomes).
    pub originals_missing: u32,
    /// The entry's `transcriptMeta`, stored in the message's `meta.transcript`.
    pub transcript_meta: Option<JsonValue>,
    pub mode: SteerMode,
    pub execution: Option<JsonValue>,
}

#[async_trait]
pub trait SteerSource: Send + Sync {
    /// Takes the queued input for this boundary from the session actor, which
    /// owns the queue; the loop races the call against the run token.
    async fn drain(&self, request: DrainRequest) -> Vec<SteerEntry>;
}

/// Explicit skill selection (`prepareExplicitSkills`) for the turn's own prompt (`initial`) and for typed
/// steering input, run before the next provider snapshot. Answers the skills that loaded, in selection order.
#[async_trait]
pub trait SkillSelector: Send + Sync {
    async fn select(&self, content: &Content, initial: bool, transcript: &mut Vec<AgentMessage>) -> Vec<String>;

    /// `appendSkillUpdateNotices(outgoing, cwd)`: the notices owed for the skills whose bodies `transcript` holds,
    /// one per skill whose state (current, changed, unavailable) differs from the last one told. Asked once a turn,
    /// before its first request.
    async fn update_notices(&self, _transcript: &[AgentMessage]) -> Vec<AgentMessage> {
        Vec::new()
    }
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
    /// The provider is about to put a request on the wire (its `onStageChange('requesting')`): the request clock of the
    /// turn's liveness starts here.
    Requesting,
    Streaming,
    /// A provider ping or comment: informational only.
    WaitingOnProvider,
    Reconnecting {
        attempt: u32,
        max: u32,
        delay: Duration,
        reason: RetryReason,
        /// The provider's `onStageChange('reconnecting', payload)` before the wait (`emitProviderRetryStage`), which
        /// the client's status shows; `None` for a re-send no provider ladder raised.
        payload: Option<serde_json::Value>,
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
    /// The provider's account pool moves on to the next account (`onStageChange('reconnecting', { message })`).
    AccountSwitching {
        message: String,
    },
    /// A fallback account became the provider's selected one (`onStageChange('account-changed', { provider,
    /// accountId, at })`).
    AccountChanged {
        provider: String,
        account_id: String,
        at: i64,
    },
    Compacting,
    /// The provider's note that the request is on the wire and the model is working on it (`MODEL_THINKING_STAGE`), raised after
    /// each attempt's `requesting`, for a provider whose `SendStages.model_thinking` is set.
    ModelThinking,
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
    /// The rewrite of a compaction pass, which the transcript shows as one. Any other (a repair, a route's replay
    /// strip, an image strip, an effort stamp) is Node's in-place splice of `state.messages`: no compaction boundary.
    pub compaction: bool,
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
    /// The usage convention of the adapter that produced this call's usage (`providerInputExcludesCache`).
    pub input_excludes_cache: bool,
    /// `sendTools`: the tools the request carried.
    pub send_tools: Arc<[mixdog_core_api::domain::provider::ToolDefinition]>,
    /// `reasoningUsage(usage)`: `None` when the provider reported none (missing is not zero).
    pub reasoning_tokens: Option<u64>,
    pub reasoning_tokens_complete: bool,
    /// `outgoing`: the transcript the request carried, which the provider's reading is aligned to
    /// (`recordProviderContextBaseline`).
    /// Shared with the send's pre-send check when the transcript did not move between them: a long transcript is not copied
    /// once per event per round.
    pub outgoing: Arc<[AgentMessage]>,
    /// `sendStartedAt`: when the request's send began (`lastProviderSendAt`).
    pub sent_at_ms: i64,
    /// The session's transcript-cache book as it stands after this call, when it changed: the owner persists it with the
    /// call's usage, before the run's next request depends on it.
    pub tail_book: Option<serde_json::Value>,
}

#[derive(Clone, PartialEq, Debug)]
#[allow(clippy::large_enum_variant, reason = "Keep the public event constructors and direct AgentMessage forwarding without an allocation per early result")]
pub enum RunEvent {
    Stage(Stage),
    TextDelta(String),
    ReasoningDelta(String),
    /// A progress update of the turn (`StreamEvent::ProgressDelta`): shown where its text is, no part of the reply's content.
    ProgressDelta(String),
    /// A cut attempt that kept no text (it showed progress, reasoning or blank text) settled for display only, as soon as
    /// the loop decides so and before any wait, replay or end of the send: closes its open segments and reasoning, none of
    /// it entering model history.
    AttemptDisplaySettled,
    /// Mid-turn assistant text surfaced before a tool card, or a kept answer.
    AssistantText {
        text: String,
        committed: bool,
    },
    ToolCalls {
        iteration: u32,
        calls: Vec<ToolCall>,
    },
    ToolResult {
        call_id: String,
        kind: ToolKind,
    },
    SteerInjected(SteerInjected),
    Usage {
        iteration: u32,
        usage: Usage,
        delta: UsageDelta,
    },
    ContextPressure {
        used_tokens: u64,
        trigger_tokens: u64,
        boundary_tokens: u64,
        /// The session's window (policy.contextWindow), when it states one.
        context_window: Option<u64>,
        will_compact: bool,
        /// The request about to go out, for the check's telemetry (`compactTelemetry`): its
        /// transcript, its tools, and whether a context-overflow retry is pending.
        /// Empty when the send compacts first (`will_compact`): only a check of a send that compacts nothing reads it.
        messages: Arc<[AgentMessage]>,
        tools: Vec<mixdog_core_api::domain::provider::ToolDefinition>,
        reactive: bool,
    },
    Compact(CompactEvent),
    /// A stage of a pre-send compaction pass, for the header's compaction telemetry.
    CompactPass(Box<CompactPass>),
    /// A [`StreamEvent::Progress`] of the provider stream: model progress that is no text or reasoning delta (a tool call's
    /// arguments or end, an item boundary), reported where Node's decoder calls `onStreamDelta(kind)`.
    ToolStream(ProgressKind),
    /// A [`StreamEvent::ItemStart`]: the provider opened a content block of this kind (Anthropic's `content_block_start`),
    /// Node's `onStreamItemStart`. A tool block's start ends the text segment shown before it (`settleSegmentBeforeToolCall`).
    ItemStart(mixdog_core_api::domain::provider::ItemKind),
    /// A [`StreamEvent::ChunkProgress`]: the chunk reports this one kind (`None`: transport only) and the stream's
    /// deltas report none of their own from here on.
    Chunk(Option<ProgressKind>),
    /// The response's bytes arrived (`onStreamDelta('transport')`): transport health only. Not a stage, not a keepalive and
    /// not progress, so it also leaves the chunk-based accounting of [`Self::Chunk`] alone.
    Transport,
    /// A boundary of an attempt's response, published when it was observed (`SendIdentity`'s attempt clock): the watchdog's
    /// progress record takes its phase from these and from nothing else. `attempt` is unique over the process, so the late event
    /// of a retired attempt never moves its successor.
    Boundary {
        submission: u64,
        attempt: u64,
        boundary: mixdog_core_api::domain::provider::Boundary,
    },
    /// The send loop began a unit of provider work (`submission`: a logical request, a route's first work, or one exchange with the
    /// provider, whether or not the provider goes through the driver): the run's record of the attempt it owned is no longer current.
    SubmissionStarted {
        id: u64,
    },
    /// The summary model's usage of a compaction pass (`accumulateCompactUsage`): one usage report of the turn,
    /// at the loop's next iteration index, with the reasoning figure `reasoningUsage(usage)` reads of it.
    CompactUsage {
        iteration: u32,
        usage: Usage,
        reasoning_tokens: Option<u64>,
        reasoning_tokens_complete: bool,
        input_excludes_cache: bool,
    },
    /// A call that ran settled (Node's early notice, `notifyEarlyResult`: `onToolResult` with `__earlyNotify`), the
    /// instant it does and in completion order, before its result commits in call order: the UI's live row and the
    /// interruption (which keeps what the stop left uncommitted) both read it. `Error` kind only for a thrown call.
    EarlyResult(AgentMessage),
    /// The audit of one assistant turn's tool batch (`recordToolBatch`, `tools/tool-batch-trace.mjs:16`, called from
    /// `loop/tool-phase.mjs:46` before `onToolCall`): what runs, so a bridged `call_tool` is recorded as its target. The host writes
    /// the `batch` trace row from it (`mixdog_trace::batch_record`) with a fresh batch id, and tags the batch's tool rows with it.
    ToolBatch(ToolBatch),
    /// The execution view of the same batch's calls, right after its audit and before any of them is committed or runs
    /// (`rememberSensitiveValues(sessionId, executionCalls)`, `loop/tool-phase.mjs:49`): the host marks the values a
    /// sensitive fill carries, so the stored copies of the transcript hold a marker for them from the assistant turn on.
    ExecutionCalls(Vec<ToolCall>),
    /// A cut stream that ended after complete tool calls goes on as a tool-call turn (`recoverPartialToolCalls`,
    /// `session/send-with-recovery.mjs:767`): Node's `partial_tool_recovery` trace row.
    PartialToolRecovery(PartialToolRecovery),
    /// The effort the turn in flight runs at (`currentTurnEffort`, `turn-effort.mjs`): the turn's
    /// own snapshot as the run starts (`None` without one), then each step the Auto judge marks.
    TurnEffort(Option<String>),
    /// `onProviderSendStarted` (`send-phase.mjs:183`): the loop sends the transcript, once per send whatever its retries.
    ProviderSendStarted,
    /// `onAssistantToolCallObserved` (`send-phase.mjs:140`): the provider streamed a complete tool call.
    ToolCallObserved(ToolCall),
    /// `onToolPhaseStarted` / `onToolPhaseCompleted` (`tool-phase.mjs:54`, `:95`): the batch's calls run once the
    /// assistant message that carries them is committed, and are all settled.
    ToolPhase(ToolPhase),
}

#[derive(Clone, PartialEq, Debug)]
pub enum ToolPhase {
    Started,
    Completed { iteration: u32, calls: usize, elapsed_ms: u64 },
}

/// What `recoverPartialToolCalls` traces (`traceLoop(state, 'partial_tool_recovery', ...)`).
#[derive(Clone, PartialEq, Debug)]
pub struct PartialToolRecovery {
    /// The round's iteration (`nextIteration`).
    pub iteration: u32,
    /// `toolCalls`: the complete calls the turn goes on with.
    pub tool_calls: usize,
    /// `droppedIncompleteInput`: a call's arguments were still streaming at the cut.
    pub dropped_incomplete_input: bool,
    /// `partialContentLen`: the cut response's text, in UTF-16 units.
    pub partial_content_len: usize,
}

/// One tool batch of the audit: the turn's iteration and the execution view of its calls, in call order.
#[derive(Clone, PartialEq, Debug)]
pub struct ToolBatch {
    pub iteration: u32,
    pub calls: Vec<ToolBatchCall>,
}

#[derive(Clone, PartialEq, Debug)]
pub struct ToolBatchCall {
    pub tool_call_id: String,
    pub tool_name: String,
    /// For the tools that take several targets in one call (read, grep, glob, git, code_graph): the length of each array
    /// input the call gave, in the tool's field order; `None` for every other tool.
    pub array_lengths: Option<Vec<(String, usize)>>,
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
    /// The provider repeats the request without streaming (Node `anthropic-streaming-fallback`).
    StreamingFallback,
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

    /// A known local wait while there is no model response to supervise.
    fn local_wait(&self, _phase: Option<&'static str>) {}

    /// The request handed to the adapter, after the turn has resolved its route and per-send options.
    fn request_started(&self, _provider: &str, _request: &ModelRequest, _effort: Option<&str>) {}

    /// The provider send the calls issued now belong to; an eager call keeps it to tell its early result back under it.
    fn send_generation(&self) -> u64 {
        0
    }

    /// The early result of an eager call issued in send `generation`, which may settle after a later send began.
    fn early_result_of(&self, _generation: u64, message: AgentMessage) {
        self.event(RunEvent::EarlyResult(message));
    }

    /// [`Self::early_result_of`] for a run the batch does not take the result of (a read started as it streamed behind a
    /// change, which the batch runs again once the change is in): the call is told settled as any other, and `message`
    /// is not the result to keep for it.
    fn early_result_superseded(&self, generation: u64, message: AgentMessage) {
        self.early_result_of(generation, message);
    }

    /// The result to keep for the call `call_id` until its row is committed is the one of its last execution: `None`
    /// as that execution starts (what an earlier one told is taken back), its result when it ends; or, for a call the
    /// batch answers without the run the stream started for it, the batch's answer in place of what that run told. Told
    /// only for a call run again or so answered; it is no settlement to show.
    fn early_result_replaced(&self, _generation: u64, _call_id: &str, _result: Option<AgentMessage>) {}

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
    /// The attachment read the message's classification needs never ran, for the lane's reason: nothing
    /// was queued.
    StoreUnavailable(crate::compact::blob_reads::StoreUnavailable),
}

impl std::fmt::Display for CommitError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::StoreUnavailable(unavailable) => write!(f, "{unavailable}; the message was not committed"),
        }
    }
}

impl std::error::Error for CommitError {}

/// The session's committed history as its store holds it now, for a run whose transcript a rewrite it did not make retired
/// (the cache owner refused its request as stale): the run goes on from the stored history, never from its old copy.
#[async_trait]
pub trait StoredHistory: Send + Sync {
    /// Once every message the run committed has landed: the stored conversation (no system messages) and the generation of
    /// the history it is, read as one load. `Err`: the store could not be read.
    async fn reload(&self) -> Result<(Vec<AgentMessage>, u64), String>;
}

/// Where committed messages go. `commit` classifies the message (which may read the attachment
/// store) and queues it for durability; `durable` resolves when that message is on disk.
#[async_trait]
pub trait TranscriptSink: Send + Sync {
    /// Cancel-safe: the message is queued, and its ticket numbered, only after the classification.
    async fn commit(&self, message: &AgentMessage) -> Result<Ticket, CommitError>;

    /// The transcript was rewritten (compaction or repair); `messages` is the new
    /// model context and `rewrite` what the pass took out of it.
    fn replace(&self, messages: &[AgentMessage], rewrite: &Rewrite);

    /// How many times calls have left the session's model context, as the session counts them
    /// (`mixdog_protocol::tool_call_ids::distinct_id`); 0 for a sink with no session behind it.
    fn call_epoch(&self) -> u64 {
        0
    }

    /// Told before a [`Self::replace`] that takes calls out of the transcript: the run counts `epoch` such rewrites now,
    /// and the session keeps no lower count.
    fn calls_left(&self, _epoch: u64) {}

    /// A fresh stable id for a message that arrives without one.
    fn message_id(&self) -> String;

    /// `recordAppliedSkills`: the skills a durable user message's turn loaded are stamped on its stored row
    /// (`meta.transcript.appliedSkills`), where the live row, the persisted transcript and restore read them. A sink
    /// with no stored rows has nothing to stamp.
    async fn skills_applied(&self, _message: &AgentMessage, _names: &[String]) {}

    /// Resolves once the save of the message of `ticket` (and every one before it) has ended. A save that failed does not fail
    /// the running turn: Node gates only the next turn's open on durability (`turn-durability.mjs`). Cancel-safe.
    async fn durable(&self, ticket: Ticket);

    /// Resolves once the message of `ticket` (and every one before it) is in the owner's hands, ahead of anything the run
    /// reports after: shown, whether or not it is stored yet. A sink that hands nothing on apart from storing waits for that.
    async fn accepted(&self, ticket: Ticket) {
        self.durable(ticket).await;
    }

    /// Resolves once everything the run handed over so far has been stored or has failed: its rows and what the owner drafted
    /// from its events, the mark of a send about to leave (`RunEvent::ProviderSendStarted`) among it. The request leaves after
    /// it, so a process killed with that request on the wire recovers knowing the request was sent; a request that left
    /// first would be recovered as a turn still in its tool run. Cancel-safe. A sink with nothing stored has nothing to wait for.
    async fn drafted(&self) {}

    /// Whether the rewrite last given to [`Self::replace`] is in the store, answered once its save has ended: what is done
    /// on a rewritten history (the prompt folded for it) is done on a history the store holds. Cancel-safe. A sink with no
    /// store behind it, and a run that rewrote nothing, have nothing unstored.
    async fn replaced(&self) -> bool {
        true
    }
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
    /// The pass runs inside a turn (`activeTurn: true` of the pre-send compaction): a turn in
    /// progress gets the active-turn continuation. A manual or handoff pass between turns
    /// (`runHandoffCompaction`) passes none.
    pub active_turn: bool,
    /// Node `goalReminderText` (`latestUserPrefix`): the session's Goal and open todo snapshot the
    /// kept latest request carries; empty for none.
    pub latest_user_prefix: &'a str,
}

pub struct CompactOutput {
    pub messages: Vec<AgentMessage>,
    /// Summary-model usage, billed to the turn.
    pub usage: Option<Usage>,
    /// The usage convention of the adapter that sent the summary, which may not be the conversation's.
    pub input_excludes_cache: bool,
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
    /// The route that wrote the summary; `None` when no summary was written.
    pub summary_route: Option<SummaryRouteUsed>,
}

/// The route a pass's summary was written on (`pipeline.summaryRoute`, `freshContextResult.summaryProvider` and
/// `summaryModel`): not always the conversation's own, when a maintenance or lighter route took the summary.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SummaryRouteUsed {
    /// `session`, `maintenance` or `lighter`.
    pub step: &'static str,
    pub provider: String,
    pub model: String,
    /// The summary was a fork of the cached request (`pipeline.generated.mode === 'shared-prefix'`).
    pub forked: bool,
    /// Why the summary call stopped (`end_turn`, ...); `None` when the provider did not say.
    pub stop: Option<String>,
}

impl CompactOutput {
    /// The pass wrote a summary (`summaryTriggered`), whether or not its answer reported usage: its handoff is the
    /// session's (`session-local`), a summary-less pass's the rules'.
    pub fn summarized(&self) -> bool {
        self.summary_ms.is_some()
    }
}

#[derive(Debug)]
pub enum CompactError {
    /// The summary request itself overflowed the model window.
    Overflow(String),
    /// The pass was cancelled; the run ends as aborted, not as a failed compaction.
    Aborted,
    Failed(String),
    /// The summary failed on a route the plan resolved (Node's `error.compactRoute`): the failure
    /// names that route's provider and model, which need not be the conversation's.
    RouteFailed(String, CompactRoute),
}

/// The session's reading of a request the run has not measured itself (`resolveContextTokensWithSource` over
/// `session.contextPressureBaseline*`).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct SessionPressure {
    /// The pressure the provider's reading gives the request: the tokens it billed for the prefix it measured plus the
    /// estimated growth after it (`provider`), or the last actual reading of a transcript not re-anchored after a restart
    /// (`provider_resume`). `None`: the run's own estimate prices it.
    pub tokens: Option<u64>,
    /// `contextPressureUnanchoredAfterRestart`: the restored transcript was never measured, so its pressure arms no
    /// proactive pass until a provider send re-anchors it (`shouldCompactForSession`); a reactive retry, an expired cache
    /// and request media still do.
    pub unanchored: bool,
    /// `compaction.singleShotConsumed`: a reserve with no headroom already took its one proactive pass.
    pub single_shot_consumed: bool,
    /// The last actual prompt size no compaction has invalidated since (`providerReadingBelowTrigger`'s reading).
    pub reading: Option<u64>,
    /// `contextPressureBaselineMessageCount`: the transcript length the session's provider reading was anchored at.
    pub reading_count: Option<usize>,
}

/// The provider and model of the summary route a compaction failed on.
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct CompactRoute {
    pub provider: String,
    pub model: String,
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

    /// The session's own reading of the request about to go out (`messages`, `tools`), for a send the run has not measured:
    /// the pressure its provider reading gives the request, and whether its transcript is unanchored after a restart. The
    /// default holds neither.
    async fn session_pressure(&self, messages: &[AgentMessage], tools: &[mixdog_core_api::domain::provider::ToolDefinition]) -> SessionPressure {
        let _ = (messages, tools);
        SessionPressure::default()
    }

    /// Whether compacting to `budget_tokens` would shrink the transcript.
    async fn reduces(&self, request: &CompactRequest<'_>) -> bool;

    /// Cancel-safe: dropping the future abandons the pass.
    async fn compact(&self, request: CompactRequest<'_>) -> Result<CompactOutput, CompactError>;

    /// Effects of adopting a compacted transcript, never of proposing one.
    async fn adopted(&self, _messages: &[AgentMessage]) {}

    /// `preflightAttachments`: the transcript with the attachments that would crowd the model
    /// window carried by reference from this send on; `None` when nothing must be. Asked before
    /// every send, whether or not automatic compaction is on.
    async fn preflight_attachments(&self, messages: &[AgentMessage]) -> Option<crate::compact::fresh::Preflight> {
        let _ = messages;
        None
    }

    /// Whether tool-result media alone would make the next request too large.
    fn request_media(&self, messages: &[AgentMessage]) -> bool {
        let _ = messages;
        false
    }

    /// This compactor for the route the run moved to mid-turn: sized by its compaction settings, with its summary
    /// resolver and saved-request fork following its provider and model. `None` when nothing in it follows the route.
    /// The transcript seams are the ones the session wired.
    fn resized(&self, seated: &SeatedRoute) -> Option<Arc<dyn Compactor>> {
        let _ = seated;
        None
    }
}

/// The route a run moved to (`advanceAgentRoute`): the session header as the hop wrote it, and the compaction settings
/// resolved from it.
pub struct SeatedRoute {
    pub header: serde_json::Map<String, JsonValue>,
    pub settings: crate::boundary::CompactSettings,
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
    pub request: RouteSwitchRequest,
    /// The new route's effort projection inputs and consuming adapter, if it
    /// takes mid-conversation updates.
    pub effort: Option<crate::effort::EffortWiring>,
    /// The new route's text-only input handling, if its model takes no media.
    pub text_only: Option<crate::text_only::TextOnlyInput>,
}

/// Request and boundary settings rebuilt from the seated destination, not the departing route.
#[derive(Default)]
pub struct RouteSwitchRequest {
    pub options: mixdog_core_api::domain::provider::RequestOptions,
    pub compact: Option<crate::boundary::CompactSettings>,
    /// The session header as the hop wrote it: what the compaction side reads the seated provider and model from.
    pub header: serde_json::Map<String, JsonValue>,
    /// The destination's output ceiling for an escalated retry (`RunConfig::escalated_max_output_tokens`).
    pub escalated_max_output_tokens: Option<u32>,
    /// The session's cache-tail gate sized for the destination's compaction settings, as the run holds them once the
    /// hop applied them. The book it judges on is the session's own: only the sizing key moves.
    pub tail_gate: Option<TailGateFor>,
    /// The session's system messages as the hop left its prompt. They replace the run's, so the destination's first
    /// request leads with the text written for its tool surface, the same text the next turn builds from the session.
    /// `None`: the run keeps its own.
    pub system: Option<Vec<crate::message::AgentMessage>>,
}

/// The session's cache-tail gate for the compaction settings a request is judged under.
pub type TailGateFor = Arc<dyn Fn(Option<&crate::boundary::CompactSettings>) -> mixdog_core_api::domain::cache_tail::TailGateHandle + Send + Sync>;

/// `seesImages` of `pdfReadModes` (`tool-exec/dispatch.mjs`): whether a route's model sees images, asked for each tool
/// call with the route the run stands on. Owner: the host, over the provider registry and the catalog.
pub trait ModelVision: Send + Sync {
    fn sees_images(&self, provider: &str, model: &str) -> bool;
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

    async fn run_yielded_reporting(
        &self,
        task: futures::future::BoxFuture<'_, bool>,
        cancel: Option<&crate::cancel::Cancel>,
        _waiting: &(dyn Fn() + Send + Sync),
    ) -> Result<(), String> {
        self.run_yielded(task, cancel).await
    }
}

/// What the loop does with a failure no retry covers (Node `advanceAgentRoute`'s three ends).
#[allow(clippy::large_enum_variant, reason = "Keep the public route-switch decision and its structured route metadata by value without boxing the API")]
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

    /// Asked before every request the run has not sent yet (a turn's first, a tool follow-up, a replayed round): a session
    /// a quota diverted from its configured primary may now be better served by another route of its configured order
    /// (back to a higher one that recovered, on to a lower one when the current is out). `Some` is the route the host
    /// already wrote to the session; the loop seats it as it seats a hop. `None`: stay. Never asked while a request is in
    /// flight, and a request already sent is not interrupted or replayed by it. `Err` is a switch that failed after the
    /// session was written: the run ends with it, as with a failed hop ([`RouteDecision::Fail`]).
    async fn reconsider(&self, last_usage: Option<&Usage>) -> Result<Option<RouteSwitch>, String> {
        let _ = last_usage;
        Ok(None)
    }

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
    /// The folder the call runs in (`prepared.cwd`), read once when the call is prepared: the policy judges the call, the tool
    /// runs it and PostToolUse reports it all against this one folder, never the session's folder read again. `None` for a
    /// call made outside a run (the turn's folder is used then).
    pub cwd: Option<std::path::PathBuf>,
    pub connector_account: Option<mixdog_core_api::domain::tool::ConnectorAccountBinding>,
}

impl GateCall {
    pub fn new(name: impl Into<String>, args: JsonValue) -> Self {
        Self { name: name.into(), args, schema_name: None, cwd: None, connector_account: None }
    }

    /// The call with the folder it was prepared in.
    pub fn at(mut self, cwd: &std::path::Path) -> Self {
        self.cwd = Some(cwd.to_path_buf());
        self
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

    /// Brings the policies a call is judged by up to date with what was saved since, before [`Self::pre_dispatch_deny`] reads them
    /// (Node reads them stat-checked at each judgement, `cachedRead`): a connector switched back on mid-turn admits the next call.
    async fn refresh_policy(&self, call: &GateCall) {
        let _ = call;
    }

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
    fn apply_approval(&self, call: &GateCall, decision: &mixdog_protocol::ToolApprovalDecision) -> GateCall {
        let _ = decision;
        call.clone()
    }
}

/// PostToolUse, PostToolUseFailure and PostToolBatch hooks. Best-effort: a
/// hook never breaks the loop. `call_id` is the model's id of the call
/// (`executeOpts.toolCallId`, `call.id`), as [`ToolGate::check_call`] gets it.
#[async_trait]
pub trait ToolHooks: Send + Sync {
    /// May override the model-visible text of a successful call.
    async fn after_tool(&self, call_id: &str, call: &GateCall, result: &str) -> Option<String> {
        let _ = (call_id, call, result);
        None
    }
    async fn after_failure(&self, call_id: &str, call: &GateCall, result: &str) {
        let _ = (call_id, call, result);
    }
    /// The whole batch resolved: `Some(reason)` blocks continuation and
    /// injects the reason as a system note before the next model call.
    async fn after_batch(&self, tool_count: usize) -> Option<String> {
        let _ = tool_count;
        None
    }
    /// Stop: the model ended its turn. `stop_hook_active` is `true` on every continuation a Stop
    /// block already made in this turn. The default lets the turn end.
    async fn on_stop(&self, stop_hook_active: bool) -> StopVerdict {
        let _ = stop_hook_active;
        StopVerdict::Proceed
    }
    /// What the loop made of the [`on_stop`](Self::on_stop) verdict just given: `true` when the turn goes on, `false`
    /// when it ends (a `Continue` the loop could not honour included: the continuation cap, an ending that cannot go on).
    fn stop_settled(&self, continued: bool) {
        let _ = continued;
    }
}

/// What the Stop hooks decided for a turn the model ended.
#[derive(Clone, PartialEq, Eq, Debug)]
pub enum StopVerdict {
    /// The turn ends.
    Proceed,
    /// A hook blocked the stop with this reason: the turn goes on with it as a note to the model.
    Continue(String),
    /// A block that is not honoured (no reason, or a session nobody is attending); the text is the
    /// warning shown.
    Ignored(String),
}

/// A cached tool result that still describes the world (the tool layer owns
/// validity). `first_tool_use_id` names the call that first delivered the body.
pub struct Reused {
    pub content: String,
    pub first_tool_use_id: String,
    pub kind: ReuseKind,
    pub explicit_success: bool,
}

#[derive(Clone, Copy)]
pub enum ReuseKind {
    Read,
    Scoped,
}

/// A write ticket captures the inputs and freshness evidence at actual execution,
/// not when a speculative cache lookup happens.
#[async_trait]
pub trait ReuseWrite: Send + Sync {
    async fn store(self: Box<Self>, content: &str, output: &ToolOutput);
}

/// Async because freshness reads the file system (a metadata stat per path argument), which a host
/// runs as a lane job, not on the runtime thread.
#[async_trait]
pub trait ResultReuse: Send + Sync {
    /// Scheduling hint only: check memory, never inspect the filesystem or return a body.
    async fn has_candidate(&self, _call: &ToolCall, _cwd: &std::path::Path) -> bool {
        false
    }
    async fn lookup(&self, call: &ToolCall, cwd: &std::path::Path, touch: bool) -> Option<Reused>;
    async fn prepare(&self, _call: &ToolCall, _cwd: &std::path::Path) -> Option<Box<dyn ReuseWrite>> {
        None
    }
    /// Keeps cache reads and fills fenced until the mutation has settled and
    /// its affected rows have been invalidated.
    fn mutation_guard(&self) -> Option<Box<dyn Send + Sync>> {
        None
    }
    /// A call ran: mutations and failures invalidate what they may have touched.
    async fn after_call(&self, _name: &str, _args: &serde_json::Value, _cwd: &std::path::Path, _failed: bool) {}
    /// Compaction replaced the transcript, so the tool results it held are no longer in context: a new read epoch
    /// (`resetReadStateAfterCompaction`).
    fn after_compaction(&self) {}
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

    /// The prompt fold a compaction owes, taken with it: the session's prompt rebuilt from current sources (the settings
    /// its dropped notices told, the tools opened since), for the request that follows the compaction and writes the
    /// conversation anew anyway. The system messages of the session's prompt as it stands after the fold, moved or not;
    /// `None` when the session's prompt is never rebuilt.
    async fn fold_compacted(&self) -> Result<Option<Vec<crate::message::AgentMessage>>, String> {
        Ok(None)
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
    /// The model was sent the brief's start reminder (the todo list was asked for once this cycle).
    fn note_creation_told(&self) {}
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

/// The connector account a call is bound to: the name is reusable, the id is not.
/// `label` is what the approval card shows.
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct BoundAccount {
    pub name: String,
    pub id: String,
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
    /// The tools the user's settings switch off right now, from the in-memory config (no machine probe, no I/O). The surface's
    /// `featureDeniedTools` is the header's, which moves only at a turn start; the gate refuses a call from this list too
    /// (`settingDisabledTool`). A session with no live source switches nothing off.
    fn live_setting_denied(&self) -> Vec<String> {
        Vec::new()
    }
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
    /// The turn's folder, for a call that carries none of its own.
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
            approvals: WaitingApprovals { inner: parts.approvals, observer: parts.observer, guards: parts.guards },
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
        surface.live_feature_denied = Some(self.session.live_setting_denied());
        surface
    }
}

#[async_trait]
impl mixdog_tools::policy::pipeline::AccountResolver for PolicyGate {
    async fn resolve_account(&self, name: &str, args: &JsonValue) -> Result<Option<mixdog_tools::policy::pipeline::CallAccount>, String> {
        self.session
            .account(&GateCall::new(name, args.clone()))
            .await?
            .map(|account| {
                if account.name.is_empty() || account.id.is_empty() {
                    return Err("The connector account has no stable identity.".to_owned());
                }
                Ok(mixdog_tools::policy::pipeline::CallAccount {
                    binding: mixdog_core_api::domain::tool::ConnectorAccountBinding { name: account.name, id: account.id },
                    label: account.label,
                })
            })
            .transpose()
    }
}

#[async_trait]
impl ToolGate for PolicyGate {
    async fn check_call(&self, call_id: &str, call: &GateCall) -> GateDecision {
        let facts = self.session.facts().await;
        let mut surface = self.session.surface();
        surface.live_feature_denied = Some(self.session.live_setting_denied());
        let call_id = ToolCallId::from(call_id);
        let authorized = self
            .policy
            .authorize_with_accounts(
                mixdog_tools::policy::AuthorizeRequest {
                    call_id: &call_id,
                    thread_id: &self.thread_id,
                    name: &call.name,
                    args: call.args.clone(),
                    cwd: call.cwd.as_deref().unwrap_or(&self.cwd),
                    facts: &facts,
                    surface: &surface,
                    schema_name: call.schema_name.as_deref(),
                    settings: self.session.settings(),
                    account: None,
                    session_grants: &self.grants,
                    tools: self.tools.as_ref(),
                    approvals: &self.approvals,
                    cancel: &self.cancel,
                },
                self,
            )
            .await;
        match authorized {
            Err(error) => GateDecision::Deny(error.message_for_model),
            Ok((authorized, connector_account)) => {
                if authorized.allow_not_saved {
                    self.approvals.observer.event(RunEvent::Stage(Stage::Notice { message: ALLOW_NOT_SAVED_NOTICE.to_owned(), tone: Tone::Warn }));
                }
                let args = authorized.args;
                if authorized.name == call.name && args == call.args && connector_account.is_none() {
                    GateDecision::Allow
                } else {
                    let mut rewritten = GateCall::new(authorized.name, args);
                    rewritten.connector_account = connector_account;
                    GateDecision::Rewrite(rewritten)
                }
            }
        }
    }

    async fn refresh_policy(&self, call: &GateCall) {
        let schema = call.schema_name.as_deref().unwrap_or(&call.name);
        self.connectors.refresh(&self.session.connector_agent_id(), Some(schema)).await;
    }

    fn pre_dispatch_deny(&self, call: &GateCall) -> Option<String> {
        // Judged under the schema name, as `preDispatchDenyForSession` does.
        let schema = call.schema_name.as_deref().unwrap_or(&call.name);
        self.surface_for(schema).refusal_for_call(&call.name, call.schema_name.as_deref(), &call.args).map(|error| error.message_for_model)
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

    /// [`begin`](Self::begin) with the request the loop holds: a tap that keeps it shares it instead of copying it. The
    /// request is the one sent, its tail reminder included ([`crate::send::kept_messages`] are the ones before it).
    fn begin_shared(&self, request: &std::sync::Arc<ModelRequest>) -> Box<dyn SendTicket> {
        self.begin(request)
    }

    /// The run moved to another provider (a model fallback): the sends that follow are on `provider`, named
    /// `provider_name` in the session's header. A request already captured keeps the route it was sent on.
    fn route_changed(&self, provider_name: &str, provider: &Arc<dyn ProviderAdapter>) {
        let _ = (provider_name, provider);
    }
}

/// One captured send, ended exactly once.
pub trait SendTicket: Send + Sync {
    /// The send proceeded with `response`.
    fn settle(self: Box<Self>, response: &crate::response::ModelResponse);
    /// The send failed or was handed to another round: the request before it is put back.
    fn discard(self: Box<Self>);
}

/// One executed call that failed, as the fields of Node's `traceAgentToolFailure` call site
/// (`session/tool-batch/finalize.mjs` `traceCompleted`): `result_text` is the text the transcript
/// holds after the batch's offload and image compaction.
#[derive(Clone, Debug, PartialEq)]
pub struct FailedCall {
    pub iteration: u32,
    pub tool_name: String,
    /// `getToolKind(name)`: `skill`, `builtin`, `mcp` or `internal`.
    pub tool_kind: &'static str,
    /// Dispatch to settle, in ms (Node's `toolEndedAt - toolStartedAt`).
    pub tool_ms: i64,
    pub tool_args: serde_json::Value,
    pub model: String,
    pub result_text: String,
}

/// One executed call as the fields of Node's `traceAgentTool` call site (`session/tool-batch/finalize.mjs:226`, `traceCompleted`):
/// `result` is the result the transcript holds after the batch's offload and image compaction (a text as a string, a structured
/// result as its parts, images left out). Cache hits carry only call identity and timing, not arguments or a result body.
#[derive(Clone, Debug, PartialEq)]
pub struct TracedCall {
    pub iteration: u32,
    pub tool_call_id: String,
    pub tool_name: String,
    pub tool_kind: &'static str,
    pub tool_ms: i64,
    pub tool_args: serde_json::Value,
    pub model: String,
    pub result_kind: &'static str,
    pub result: serde_json::Value,
    /// The text a failure row is cut from (`toolTraceText(result)`).
    pub result_text: String,
    pub timing: Option<crate::message::ToolTiming>,
    /// Every run of the call as (started, completed) epoch ms, in run order (`executionIntervals`).
    pub execution_intervals: Vec<(i64, i64)>,
    /// What the tool reported about its result (Node's `resultTelemetry`: a listing's `integrity`).
    pub result_telemetry: Option<serde_json::Value>,
    /// What the tool reported about its local search (Node's `localSearchTelemetry`).
    pub local_search: Option<serde_json::Value>,
}

pub struct CrossTurnReceipt<'a> {
    pub iteration: u32,
    pub tool: &'a str,
    pub occurrence: u32,
    pub first_iteration: u32,
    pub total: u32,
}

/// One completed send as the fields of Node's `traceProviderSend` call (`session/loop/send-phase.mjs` `settleSendResult`):
/// where the iteration's time went before and during the provider round trip. The spans are those of the round that settled
/// the send: a replay Node's loop runs as a new round starts the iteration and the send again.
#[derive(Clone, Debug, PartialEq)]
pub struct ProviderSend {
    /// The iteration the send completed (`state.iterations` once it settled).
    pub iteration: u32,
    /// From the send's start to its settlement (`Date.now() - sent.sendStartedAt`).
    pub send_ms: i64,
    /// From the iteration's start to the send's (`sendStartedAt - round.iterT0`).
    pub pre_send_ms: i64,
    /// From the run's last tool batch's end to the send's start; `None` before the run's first batch.
    pub tool_resume_ms: Option<i64>,
    /// The transcript's length when the send settled (`messages.length`).
    pub message_count: usize,
}

/// A completed request's usage, as `traceAgentUsage` reports it: the `usage_raw` row of the agent trace, which the memory
/// service's trace stats read each model call from.
#[derive(Clone, Debug)]
pub struct RequestUsage {
    /// The iteration the send completed.
    pub iteration: u32,
    pub provider: String,
    /// The model that answered (the response's, else the run's).
    pub model: String,
    /// The model the run asked for.
    pub requested_model: String,
    /// `opts.sourceType`: the kind of request, when it is not a plain turn.
    pub source_type: Option<String>,
    pub usage: Usage,
}

/// The host's tool log: the agent trace's `batch` and `tool` rows (`agent-trace.jsonl`) and the failure log
/// (`tool-failures.jsonl`). Called in call order, before a call's result is cached or committed. Never blocks and never fails
/// the run.
pub trait ToolFailureLog: Send + Sync {
    fn failed(&self, call: FailedCall);
    /// `recordToolBatch(sessionId, executionCalls, iteration)` (`loop/tool-phase.mjs:46`): the batch's row; the batch's calls are
    /// traced with its id. A host without the trace writes nothing.
    fn batch(&self, _batch: &ToolBatch) {}
    /// `traceAgentTool(...)` of one executed call: its `tool` row (and `tool_slow` row) and, for an error call, its failure row.
    /// A host without the trace logs only the failure.
    fn tool(&self, call: TracedCall) {
        if call.result_kind == "error" {
            let TracedCall { iteration, tool_name, tool_kind, tool_ms, tool_args, model, result_text, .. } = call;
            self.failed(FailedCall { iteration, tool_name, tool_kind, tool_ms, tool_args, model, result_text });
        }
    }
    /// A validated cross-turn receipt, not another delivery of the cached body.
    fn cross_turn_receipt(&self, _receipt: CrossTurnReceipt<'_>) {}
    /// `recordAgentWatchdogAbort(ctx)`: the progress watchdog stopped the run's turn (`mixdog_trace::watchdog_abort_records`
    /// has the fields of `ctx`); the `stall_abort` rows join the same log.
    fn stall_abort(&self, ctx: serde_json::Map<String, serde_json::Value>);
    /// `traceCacheBreak(record)`: a send changed what the provider's prompt cache holds (`mixdog_trace::cache_break_payload`
    /// has the fields of `record`); the `cache_break` row joins the trace and its line goes to stderr.
    fn cache_break(&self, _record: serde_json::Map<String, serde_json::Value>) {}
    /// `traceProviderSend(...)`: a completed send's `loop` row (`traceAgentLoop`), which the host writes only under
    /// `MIXDOG_AGENT_TRACE_VERBOSE` / `_TIMING`. A host without the trace writes nothing.
    fn provider_send(&self, _send: ProviderSend) {}
    /// `traceAgentUsage(...)`: a completed request's `usage_raw` row. A host without the trace writes nothing.
    fn request_usage(&self, _usage: RequestUsage) {}
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
    /// Where a failed call is recorded (without one nothing is).
    pub failures: Option<Arc<dyn ToolFailureLog>>,
}

/// Awaits `fut`, or returns `None` when the run's token is cancelled first.
pub async fn or_cancelled<F: std::future::Future>(cancel: &CancellationToken, fut: F) -> Option<F::Output> {
    mixdog_rt::Scope::new().cancel(cancel).run(fut).await.done()
}
