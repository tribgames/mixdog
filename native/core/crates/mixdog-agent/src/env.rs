//! What a run needs from its host, as narrow traits. The session actor, the
//! feed, the store, the timer wheel and the compaction pipeline implement
//! these; the loop never reads a clock, draws randomness or waits on its own.

use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use mixdog_core_api::domain::approval::ApprovalAsk;
use mixdog_core_api::domain::provider::Content;
use mixdog_core_api::domain::provider::ProviderAdapter;
use mixdog_core_api::domain::provider::ProviderError;
use mixdog_core_api::domain::provider::ToolCall;
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
    Notice {
        message: String,
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

/// What a compaction took out of the model context: the stable ids of the
/// messages whose text left and the tool calls that left.
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct Dropped {
    pub message_ids: Vec<String>,
    pub call_ids: Vec<String>,
}

#[derive(Clone, PartialEq, Debug)]
pub struct CompactEvent {
    /// Node's `droppedMessages`: messages that left the context; 0 when nothing visible was removed.
    pub dropped_count: u64,
    /// `None` when nothing identifiable was dropped.
    pub dropped: Option<Dropped>,
    pub trigger: CompactTrigger,
    pub changed: bool,
    pub failed: bool,
    pub before_messages: usize,
    pub after_messages: usize,
    pub pressure_tokens: u64,
    pub trigger_tokens: u64,
    pub boundary_tokens: u64,
    pub target_budget_tokens: u64,
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
    Usage { iteration: u32, usage: Usage },
    ContextPressure {
        used_tokens: u64,
        trigger_tokens: u64,
        boundary_tokens: u64,
        will_compact: bool,
    },
    Compact(CompactEvent),
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

/// Where committed messages go. `commit` queues a message for durability and
/// returns at once; `durable` resolves when that message is on disk.
#[async_trait]
pub trait TranscriptSink: Send + Sync {
    fn commit(&self, message: &AgentMessage) -> Ticket;

    /// The transcript was rewritten (compaction); `messages` is the new
    /// model context.
    fn replace(&self, messages: &[AgentMessage]);

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
    /// Local token estimate of a transcript.
    fn estimate_tokens(&self, messages: &[AgentMessage]) -> u64;

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

#[async_trait]
pub trait RouteFallback: Send + Sync {
    async fn advance(&self, error: &ProviderError) -> Option<RouteSwitch>;
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

pub trait ResultReuse: Send + Sync {
    fn lookup(&self, call: &ToolCall, touch: bool) -> Option<Reused>;
    /// Records the body a successful read-only call delivered. `output` is the
    /// tool's own result with `parts` and `follow_up_messages` emptied (the
    /// model-visible body is `content`): its `meta` and flags are what the
    /// tool layer reads, e.g. `code_graph::dependency_roots(output)`.
    fn store(&self, call: &ToolCall, content: &str, tool_use_id: &str, output: &ToolOutput);
    /// A call ran: mutations and failures invalidate what they may have touched.
    fn after_call(&self, call: &ToolCall, failed: bool);
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

/// Todo / goal reminders around the end of a turn. State lives with the
/// session (a user cycle spans several turns).
#[async_trait]
pub trait TurnGuards: Send + Sync {
    /// A tool batch ran: the last reminder produced progress.
    fn note_progress(&self);
    /// The turn now waits on the user (approval denied).
    fn note_user_wait(&self);
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

/// What the policy-backed gate reads from the owning session, per call.
pub trait GateSession: Send + Sync {
    /// Who is acting (agent, bot, run kind, life mark).
    fn facts(&self) -> mixdog_tools::policy::SessionFacts;
    /// The session's tool surface (allowlist, denied tools, read-only, workflow, route
    /// exclusions); the per-tool connector flags are set by the gate.
    fn surface(&self) -> mixdog_tools::policy::SessionSurface;
    /// The developer options the policy reads ("Allow all actions").
    fn settings(&self) -> mixdog_tools::policy::PolicySettings;
    /// The connector account the call is bound to; the approval card names it.
    fn account(&self, call: &GateCall) -> Option<String>;
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
        let facts = self.session.facts();
        surface.connector_disabled = self.connectors.disabled(&facts.connector_agent_id, name);
        surface.project_disabled = self.connectors.project_disabled(&self.thread_id, name);
        surface
    }
}

#[async_trait]
impl ToolGate for PolicyGate {
    async fn check_call(&self, call_id: &str, call: &GateCall) -> GateDecision {
        let facts = self.session.facts();
        let surface = self.session.surface();
        let account = self.session.account(call);
        let call_id = ToolCallId::from(call_id);
        let authorized = self
            .policy
            .authorize(mixdog_tools::policy::AuthorizeRequest {
                call_id: &call_id,
                thread_id: &self.thread_id,
                name: &call.name,
                args: call.args.clone(),
                cwd: &self.cwd,
                facts: &facts,
                surface: &surface,
                schema_name: call.schema_name.as_deref(),
                settings: self.session.settings(),
                account: account.as_deref(),
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
                    }));
                }
                if authorized.name == call.name && authorized.args == call.args {
                    GateDecision::Allow
                } else {
                    GateDecision::Rewrite(GateCall::new(authorized.name, authorized.args))
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
    tokio::select! {
        biased;
        _ = cancel.cancelled() => None,
        out = fut => Some(out),
    }
}
