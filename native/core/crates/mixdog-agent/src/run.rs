//! The run: send → tool calls → execute → send again, until a turn without
//! tool calls ends it. One `Run` is one ask; the session actor owns it, holds
//! its cancellation token, and reads the transcript back from the sink.
//!
//! Every await point is a cancel-safe wait raced against the run's token, so
//! an abort returns at the next poll: no timer, no graceful-interruption wait.

use std::sync::Arc;

use mixdog_core_api::domain::provider::Content;
use mixdog_core_api::domain::provider::ProviderAdapter;
use mixdog_core_api::domain::provider::ProviderError;
use mixdog_core_api::domain::provider::ProviderState;
use mixdog_core_api::domain::provider::RequestOptions;
use mixdog_core_api::domain::provider::Usage;
use mixdog_core_api::domain::retry::RetryClass;
use mixdog_core_api::domain::retry::RetryState;
use mixdog_protocol::ThreadId;
use mixdog_protocol::TurnId;
use tokio_util::sync::CancellationToken;

use crate::boundary::CompactSettings;
use crate::boundary::Baseline;
use crate::env::DrainRequest;
use crate::env::DrainStage;
use crate::env::Priority;
use crate::env::RunEnv;
use crate::env::RunEvent;
use crate::env::UsageDelta;
use crate::env::Ticket;
use crate::env::or_cancelled;
use crate::limits;
use crate::limits::TurnLimits;
use crate::message::AgentMessage;
use crate::no_tool::NoToolState;
use crate::response::ModelResponse;
use crate::response::Termination;
use crate::response::classify_termination;
use crate::steer;
use crate::tools::RepeatGuards;
use crate::tools::ToolEnv;
use crate::tools::ToolSet;

/// Per-ask settings the host resolves from config and the session route.
#[derive(Clone)]
pub struct RunConfig {
    pub thread_id: ThreadId,
    pub turn_id: TurnId,
    pub model: String,
    /// Base request options; the loop sets `iteration`, `tool_choice` and the
    /// one-shot output override per request.
    pub options: RequestOptions,
    /// Hidden roles may end with text-only or empty turns.
    pub hidden_agent: bool,
    pub agent_mode: bool,
    pub limits: Option<TurnLimits>,
    /// The first request of the turn must call a tool.
    pub forced_first_tool: bool,
    pub compact: Option<CompactSettings>,
    /// The higher `max_tokens` the route can offer after an output-limit stop.
    pub escalated_max_output_tokens: Option<u32>,
    /// Back-to-back provider continuations without a tool batch before the
    /// current text is accepted as final.
    pub continuation_no_tool_limit: u32,
    /// The user entry this ask starts from: the first model call waits for
    /// its durability ack (while selecting on the token), so memory never runs
    /// ahead of disk.
    pub first_request_after: Option<Ticket>,
    /// The route's provider needs the source of a read, not a receipt.
    pub read_body_required: bool,
    /// Mid-conversation effort: the route's inputs and the adapter that sets
    /// BuildInputs.effort from the projection of each request.
    pub effort: Option<crate::effort::EffortWiring>,
    /// Auto effort per tool-result step (needs an effort projection and a step judge).
    pub step_auto_effort: Option<crate::step_effort::StepAutoEffort>,
    /// The route's model takes no media input: each request is degraded and
    /// checked (`input-capabilities.mjs`).
    pub text_only: Option<crate::text_only::TextOnlyInput>,
    /// Resolves stored text-attachment references to their text in each request.
    pub attachments: Option<std::sync::Arc<dyn crate::attachments::AttachmentText>>,
    /// The admitted slot of an agent job: handed back around each provider request.
    pub slot: Option<std::sync::Arc<dyn crate::env::Yielder>>,
    /// The turn's signal with the reason its source aborted it with (see [`crate::cancel`]): the
    /// host builds it over the run's token (`Cancel::from_token`) and aborts through it. Without
    /// one, a cancelled wait reads as a bare `abort()`.
    pub signal: Option<crate::cancel::Cancel>,
    /// Node `opts.retry529`: `false` surfaces an overload (status 529) instead of retrying it, for a
    /// background call that falls back at once. The provider's own policy is kept otherwise.
    pub retry_529: bool,
    /// Called before each provider attempt of the turn: the host begins the request's set of
    /// provider-excluded tools there (`beginProviderToolExclusions`, `send-phase.mjs`). Whatever
    /// provider the attempt goes to (a route hop included) is covered, because the loop calls it.
    pub request_begin: Option<std::sync::Arc<dyn Fn() + Send + Sync>>,
}

impl RunConfig {
    pub fn new(thread_id: ThreadId, turn_id: TurnId, model: impl Into<String>) -> Self {
        Self {
            thread_id,
            turn_id,
            model: model.into(),
            options: RequestOptions::default(),
            hidden_agent: false,
            agent_mode: false,
            limits: None,
            forced_first_tool: false,
            compact: None,
            escalated_max_output_tokens: None,
            continuation_no_tool_limit: 8,
            first_request_after: None,
            read_body_required: false,
            effort: None,
            step_auto_effort: None,
            text_only: None,
            attachments: None,
            slot: None,
            signal: None,
            retry_529: true,
            request_begin: None,
        }
    }
}

/// Guard state that outlives one ask (it lives on the session record).
#[derive(Clone, Default, Debug)]
pub struct RunCarry {
    pub repeat: RepeatGuards,
}

impl RunCarry {
    /// The carry a session record holds.
    pub fn from_saved(saved: &serde_json::Map<String, serde_json::Value>) -> Self {
        Self { repeat: RepeatGuards::from_saved(saved) }
    }

    /// The record fields the carry is saved under.
    pub fn to_saved(&self) -> serde_json::Map<String, serde_json::Value> {
        self.repeat.to_saved()
    }
}

/// Retry state of the five rows, each advanced only by the decider.
pub(crate) struct RetryStates {
    request: RetryState,
    midstream: RetryState,
    transport: RetryState,
    connection: RetryState,
    recovery: RetryState,
}

impl RetryStates {
    pub(crate) fn new(model: &str) -> Self {
        Self {
            request: RetryState::new(RetryClass::Request, model),
            midstream: RetryState::new(RetryClass::Midstream, model),
            transport: RetryState::new(RetryClass::Transport, model),
            connection: RetryState::new(RetryClass::Connection, model),
            recovery: RetryState::new(RetryClass::Recovery, model),
        }
    }

    pub(crate) fn get(&self, class: RetryClass) -> &RetryState {
        match class {
            RetryClass::Request => &self.request,
            RetryClass::Midstream => &self.midstream,
            RetryClass::Transport => &self.transport,
            RetryClass::Connection => &self.connection,
            RetryClass::Recovery => &self.recovery,
        }
    }

    pub(crate) fn store(&mut self, state: RetryState) {
        match state.class() {
            RetryClass::Request => self.request = state,
            RetryClass::Midstream => self.midstream = state,
            RetryClass::Transport => self.transport = state,
            RetryClass::Connection => self.connection = state,
            RetryClass::Recovery => self.recovery = state,
        }
    }
}

#[derive(Debug)]
pub enum AgentError {
    /// The run's token was cancelled.
    Aborted,
    Provider(Box<ProviderError>),
    ContextOverflow(Box<ContextOverflow>),
    /// The compaction pipeline itself failed (not "the latest turn cannot fit").
    CompactFailed(Box<CompactFailure>),
    /// The model hop itself failed (a provider that is not there, a session closed during the
    /// hop); the text is the error as Node throws it.
    RouteFailed(String),
    /// The slot could not be taken back after a provider request: the cancel's own text.
    Admission(String),
    /// A message could not be committed to the transcript.
    Commit(crate::env::CommitError),
}

#[derive(Debug)]
pub struct ContextOverflow {
    pub stage: &'static str,
    pub provider: String,
    pub model: String,
    pub context_window: Option<u64>,
    pub budget_tokens: Option<u64>,
    pub reserve_tokens: Option<u64>,
    pub message_tokens_est: Option<u64>,
    pub cause: Option<String>,
}

#[derive(Debug)]
pub struct CompactFailure {
    pub stage: &'static str,
    pub provider: String,
    pub model: String,
    pub cause: String,
}

fn unknown_or<T: std::fmt::Display>(value: Option<T>) -> String {
    value.map_or_else(|| "unknown".to_owned(), |v| v.to_string())
}

fn target(provider: &str, model: &str) -> String {
    let joined = [provider, model]
        .iter()
        .filter(|part| !part.is_empty())
        .copied()
        .collect::<Vec<_>>()
        .join("/");
    if joined.is_empty() {
        "target model".to_owned()
    } else {
        joined
    }
}

impl std::fmt::Display for AgentError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Aborted => f.write_str("agent loop aborted"),
            Self::Provider(error) => f.write_str(&error.message),
            Self::RouteFailed(message) | Self::Admission(message) => f.write_str(message),
            Self::Commit(error) => write!(f, "{error}"),
            Self::ContextOverflow(o) => write!(
                f,
                "agent context overflow ({}, stage={}): latest turn cannot fit target context budget={} reserve={} contextWindow={} messageTokensEst={}{}",
                target(&o.provider, &o.model),
                o.stage,
                unknown_or(o.budget_tokens),
                unknown_or(o.reserve_tokens),
                unknown_or(o.context_window),
                unknown_or(o.message_tokens_est),
                o.cause.as_ref().map(|c| format!(": {c}")).unwrap_or_default(),
            ),
            Self::CompactFailed(c) => write!(
                f,
                "agent compact failed ({}, stage={}){}",
                target(&c.provider, &c.model),
                c.stage,
                if c.cause.is_empty() {
                    String::new()
                } else {
                    format!(": {}", c.cause)
                },
            ),
        }
    }
}

impl std::error::Error for AgentError {}

/// A run that ended with an error: the transcript as it stands and every
/// answer the turn went on past, for whoever reports the failure.
#[derive(Debug)]
pub struct RunFailure {
    pub error: AgentError,
    pub carried_report: String,
    pub transcript: Vec<AgentMessage>,
    pub carry: RunCarry,
}

/// The ask result: the terminal response plus the loop's aggregate usage.
#[derive(Debug)]
pub struct RunOutput {
    pub response: ModelResponse,
    /// Aggregate over every provider request of the ask.
    pub usage: Usage,
    pub last_turn_usage: Usage,
    pub first_turn_usage: Usage,
    pub iterations: u32,
    pub tool_calls_total: u64,
    pub termination: Option<Termination>,
    pub reaction_completed: bool,
    pub provider_continuations: u32,
    pub transcript: Vec<AgentMessage>,
    pub carry: RunCarry,
    /// Set when a provider changed the session's state during the run; the host
    /// saves it with `RunPort::save_provider_state` (an empty state clears it).
    /// A failed run saves none: Node persists state from a delivered result only.
    pub provider_state: Option<ProviderState>,
    /// `routeUsageSegments`: the turn's usage per model when the route switched mid-turn.
    pub usage_segments: Vec<crate::env::UsageSegment>,
}

pub struct Run {
    pub(crate) env: RunEnv,
    pub(crate) cancel: CancellationToken,
    pub(crate) provider: Arc<dyn ProviderAdapter>,
    pub(crate) tools: ToolSet,
    pub(crate) tool_env: ToolEnv,
    pub(crate) config: RunConfig,
    pub(crate) model: String,
    pub(crate) messages: Vec<AgentMessage>,
    pub(crate) iterations: u32,
    pub(crate) tool_calls_total: u64,
    pub(crate) turn_limit_noticed: bool,
    pub(crate) turn_limit_ended: bool,
    pub(crate) last_usage: Option<Usage>,
    pub(crate) first_turn_usage: Option<Usage>,
    pub(crate) response: Option<ModelResponse>,
    pub(crate) last_streamed_chars: usize,
    pub(crate) context_overflow_retry_used: bool,
    pub(crate) reactive_overflow_retry_pending: bool,
    pub(crate) retry: RetryStates,
    pub(crate) max_output_override: Option<u32>,
    pub(crate) tool_batch_just_completed: bool,
    pub(crate) last_batch_later: bool,
    pub(crate) pending_skill_prompts: Vec<Content>,
    pub(crate) baseline: Option<Baseline>,
    /// The request the latest send settled on, and when its send began (`requestStartedAt`).
    pub(crate) last_request: Option<Arc<mixdog_core_api::domain::provider::ModelRequest>>,
    pub(crate) request_started_ms: i64,
    /// The logical send in flight (`RequestOptions.send_group`); settled when it ends unsuccessfully.
    pub(crate) send_group: Option<crate::send::SendGroup>,
    /// The send's capture, opened by its first attempt and ended by the send.
    pub(crate) side_ticket: Option<Box<dyn crate::env::SendTicket>>,
    /// The provider's last measured context footprint (`session.lastContextTokens`).
    pub(crate) context: crate::boundary::ContextReading,
    pub(crate) no_tool: NoToolState,
    pub(crate) carry: RunCarry,
    pub(crate) quiet_compact_retry_used: bool,
    pub(crate) cross_turn: crate::batch::CrossTurn,
    pub(crate) eager: std::collections::HashMap<String, tokio::task::JoinHandle<crate::tools::Executed>>,
    pub(crate) eager_sigs: std::collections::HashSet<String>,
    /// The tail reminder the request in flight carries.
    pub(crate) last_reminder: Option<String>,
    /// Tools the provider rejected the schema of: name → why a call is refused.
    pub(crate) dropped_tools: std::collections::HashMap<String, String>,
    /// The latest turn's images are left out of every request until a send
    /// succeeds.
    pub(crate) image_strip_active: bool,
    pub(crate) image_strip_used: bool,
    pub(crate) replay_repair_used: bool,
    pub(crate) tool_schema_drop_used: bool,
    pub(crate) step_effort: Option<crate::step_effort::PendingStep>,
    pub(crate) auto_effort_steps: u32,
    /// A one-shot call: messages go to the wire as given, with no synthetic-row
    /// envelope (a provider-level send, not a loop request).
    pub(crate) unprojected: bool,
    /// The session's provider state as the run last saw it: the host's value at
    /// the start (`config.options.provider_state`), then each report of a provider.
    pub(crate) provider_state: Option<ProviderState>,
    pub(crate) provider_state_changed: bool,
}

/// ``reasoningUsage(usage)``: the generation tokens the provider reported, ``None`` when it reported
/// none (missing is not zero), and whether the figure is complete. A reported count wins; otherwise
/// the provider's raw usage is searched under the names providers use.
pub(crate) fn reasoning_usage(usage: &Usage) -> (Option<u64>, bool) {
    let count = |v: &mixdog_protocol::JsonValue| v.as_u64().or_else(|| v.as_f64().filter(|f| *f >= 0.0 && f.fract() == 0.0).map(|f| f as u64));
    let found = if usage.reasoning_tokens.is_some() {
        usage.reasoning_tokens
    } else {
        usage.raw.as_ref().and_then(|raw| {
            [
                &["output_tokens_details", "reasoning_tokens"][..],
                &["output_tokens_details", "thinking_tokens"],
                &["completion_tokens_details", "reasoning_tokens"],
                &["completion_tokens_details", "thinking_tokens"],
                &["thinking_tokens"],
                &["thinkingTokens"],
                &["thoughtsTokenCount"],
                &["thoughts_token_count"],
            ]
            .iter()
            .find_map(|path| path.iter().try_fold(raw, |v, key| v.get(*key)).and_then(count))
        })
    };
    // A carried figure keeps its completeness (`reasoningTokensComplete !== false`); one found in
    // the raw usage is complete.
    (found, found.is_some() && !(usage.reasoning_tokens.is_some() && usage.reasoning_incomplete))
}

pub(crate) fn add_usage(total: Option<Usage>, next: &Usage) -> Usage {
    let Some(mut total) = total else {
        return next.clone();
    };
    total.input_tokens += next.input_tokens;
    total.output_tokens += next.output_tokens;
    total.cache_read_tokens += next.cache_read_tokens;
    total.cache_write_tokens += next.cache_write_tokens;
    total.cache_write_1h_tokens += next.cache_write_1h_tokens;
    total.combine_reasoning(next);
    total.raw = next.raw.clone().or(total.raw);
    total
}

impl Run {
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        env: RunEnv,
        cancel: CancellationToken,
        provider: Arc<dyn ProviderAdapter>,
        tools: ToolSet,
        tool_env: ToolEnv,
        config: RunConfig,
        messages: Vec<AgentMessage>,
        carry: RunCarry,
    ) -> Self {
        let model = config.model.clone();
        let retry = RetryStates::new(&model);
        let provider_state = config.options.provider_state.clone();
        let context = crate::boundary::ContextReading {
            tokens: config.compact.as_ref().and_then(|c| c.last_context_tokens),
            stale_after_compact: false,
        };
        Self {
            provider_state,
            provider_state_changed: false,
            env,
            cancel,
            provider,
            tools,
            tool_env,
            model,
            messages,
            config,
            iterations: 0,
            tool_calls_total: 0,
            turn_limit_noticed: false,
            turn_limit_ended: false,
            last_usage: None,
            first_turn_usage: None,
            response: None,
            last_streamed_chars: 0,
            context_overflow_retry_used: false,
            reactive_overflow_retry_pending: false,
            retry,
            max_output_override: None,
            tool_batch_just_completed: false,
            last_batch_later: false,
            pending_skill_prompts: Vec::new(),
            context,
            baseline: None,
            last_request: None,
            request_started_ms: 0,
            send_group: None,
            side_ticket: None,
            no_tool: NoToolState::default(),
            carry,
            quiet_compact_retry_used: false,
            cross_turn: crate::batch::CrossTurn::default(),
            eager: std::collections::HashMap::new(),
            eager_sigs: std::collections::HashSet::new(),
            last_reminder: None,
            dropped_tools: std::collections::HashMap::new(),
            image_strip_active: false,
            image_strip_used: false,
            replay_repair_used: false,
            tool_schema_drop_used: false,
            step_effort: None,
            auto_effort_steps: 0,
            unprojected: false,
        }
    }

    /// Sets the effort judge after construction (tests; hosts set RunEnv).
    pub fn set_step_judge(&mut self, judge: Arc<dyn crate::step_effort::StepEffortJudge>) {
        self.env.step_judge = Some(judge);
    }

    /// Sets the artifact store after construction (tests; hosts set `RunEnv`).
    pub fn set_artifact_store(&mut self, store: Arc<dyn crate::offload::ArtifactStore>) {
        self.env.artifacts = Some(store);
    }

    pub(crate) fn emit(&self, event: RunEvent) {
        self.env.observer.event(event);
    }

    pub(crate) fn throw_if_aborted(&self) -> Result<(), AgentError> {
        if self.cancel.is_cancelled() {
            Err(AgentError::Aborted)
        } else {
            Ok(())
        }
    }

    /// Appends to the model context and queues the message for durability.
    pub(crate) async fn push(&mut self, message: AgentMessage) -> Result<Ticket, AgentError> {
        let ticket = self.env.sink.commit(&message).await.map_err(AgentError::Commit)?;
        self.messages.push(message);
        Ok(ticket)
    }

    /// Takes the host's queued input for this boundary and appends it to the
    /// transcript. Returns whether anything was injected.
    pub(crate) async fn drain_steering(
        &mut self,
        stage: DrainStage,
        max_priority: Priority,
    ) -> Result<bool, AgentError> {
        let merged = self.take_steering(stage, max_priority).await?;
        if merged.is_empty() {
            return Ok(false);
        }
        self.inject_steering(merged, stage).await?;
        Ok(true)
    }

    /// The normalized entries a drain yields; nothing is appended yet, so the
    /// terminal boundary can commit the ended answer first.
    pub(crate) async fn take_steering(
        &self,
        stage: DrainStage,
        max_priority: Priority,
    ) -> Result<Vec<steer::Merged>, AgentError> {
        let drained = or_cancelled(
            &self.cancel,
            self.env.steer.drain(DrainRequest {
                stage,
                max_priority,
            }),
        )
        .await
        .ok_or(AgentError::Aborted)?;
        Ok(drained.iter().filter_map(steer::normalize).collect())
    }

    pub(crate) async fn inject_steering(&mut self, merged: Vec<steer::Merged>, stage: DrainStage) -> Result<(), AgentError> {
        for entry in merged {
            let now = self.env.clock.now_ms();
            let sink = Arc::clone(&self.env.sink);
            let prompt = (!entry.task_notification).then(|| entry.content.clone());
            let (message, event) = steer::inject(entry, stage, now, move || sink.message_id());
            self.push(message).await?;
            if let Some(content) = prompt {
                self.pending_skill_prompts.push(content);
            }
            self.emit(RunEvent::SteerInjected(event));
        }
        // Input taken into the turn at any boundary is new work to answer.
        self.no_tool.note_new_input();
        Ok(())
    }

    /// The loop. Completion, cancellation and terminal failures end it.
    pub async fn run(mut self) -> Result<RunOutput, RunFailure> {
        match self.drive().await {
            Ok(()) => Ok(self.finish()),
            Err(error) => Err(RunFailure {
                error,
                carried_report: self.no_tool.ended_report(),
                transcript: self.messages,
                carry: self.carry,
            }),
        }
    }

    async fn drive(&mut self) -> Result<(), AgentError> {
        loop {
            self.begin_iteration().await?;
            let response = match self.send_provider_request().await? {
                crate::send::SendResult::RetryRound => continue,
                crate::send::SendResult::Proceed(response) => *response,
            };
            self.settle_send(&response)?;
            // A turn without client tool calls is not automatically the final
            // answer: each case owns a bounded recovery ladder.
            if response.tool_calls.is_empty() {
                match self.resolve_no_tool(response).await? {
                    crate::no_tool::Outcome::Continue => continue,
                    crate::no_tool::Outcome::Break(response) => {
                        self.response = Some(*response);
                        return Ok(());
                    }
                }
            }
            self.run_tool_phase(response).await?;
            // A capped turn that kept calling tools after it was told to reply
            // ends here with no reply, keeping the answers it went past.
            if self.turn_limit_ended {
                let response = self.response.take().unwrap_or_default();
                let ended = ModelResponse {
                    content: String::new(),
                    tool_calls: Vec::new(),
                    ..response
                };
                self.response = Some(self.no_tool.finalize(ended));
                return Ok(());
            }
        }
    }

    /// Opens an iteration: steering after a tool batch, explicit skill
    /// selection, the request boundary and the per-request options.
    async fn begin_iteration(&mut self) -> Result<(), AgentError> {
        self.throw_if_aborted()?;
        if let Some(ticket) = self.config.first_request_after.take() {
            self.until_durable(ticket).await?;
        }
        // Queued entries attach after tool results and before the
        // continuation, not on arbitrary non-tool continuations.
        if self.tool_batch_just_completed {
            let priority = if self.last_batch_later {
                Priority::Later
            } else {
                Priority::Next
            };
            self.drain_steering(DrainStage::PreSend, priority).await?;
            self.tool_batch_just_completed = false;
            self.last_batch_later = false;
        }
        if let Some(skills) = self.env.skills.clone() {
            for content in std::mem::take(&mut self.pending_skill_prompts) {
                skills.select(&content, &mut self.messages).await;
            }
        } else {
            self.pending_skill_prompts.clear();
        }
        self.prepare_request_boundary().await?;
        self.apply_step_effort().await?;
        self.options_for_next_request();
        Ok(())
    }

    fn options_for_next_request(&mut self) {
        let next = self.iterations + 1;
        let options = &mut self.config.options;
        options.iteration = next;
        options.tool_choice = if self.config.forced_first_tool && self.tool_calls_total == 0 {
            Some("required".to_owned())
        } else if self.turn_limit_noticed {
            // A capped turn told to reply may only answer.
            Some("none".to_owned())
        } else {
            None
        };
    }

    /// Folds a completed send into the state: usage, baselines, budgets.
    fn settle_send(&mut self, response: &ModelResponse) -> Result<(), AgentError> {
        self.context_overflow_retry_used = false;
        self.iterations += 1;
        let had_usage = self.last_usage.is_some();
        self.last_usage = Some(add_usage(self.last_usage.take(), &response.usage));
        if !had_usage {
            self.first_turn_usage = self.last_usage.clone();
        }
        self.record_baseline(&response.usage);
        self.context.measure(&response.usage);
        // A provider that returned despite an abort must not have its output
        // processed.
        self.throw_if_aborted()?;
        let (reasoning_tokens, reasoning_tokens_complete) = reasoning_usage(&response.usage);
        let delta = UsageDelta {
            model: if response.model.is_empty() { self.model.clone() } else { response.model.clone() },
            requested_model: self.model.clone(),
            delta_tool_calls: response.tool_calls.len() as u64,
            // The ledger's duration when the send was accounted; else the loop's own clock.
            request_ms: response.request_ms.unwrap_or_else(|| (self.env.clock.now_ms() - self.request_started_ms).max(0) as u64),
            delta_prompt: response.usage.input_tokens,
            send_tools: self.last_request.as_ref().map(|r| r.tools.clone()).unwrap_or_default(),
            reasoning_tokens,
            reasoning_tokens_complete,
        };
        self.emit(RunEvent::Usage {
            iteration: self.iterations,
            usage: response.usage.clone(),
            delta,
        });
        self.response = Some(response.clone());
        Ok(())
    }

    fn finish(self) -> RunOutput {
        let reaction_answers = self.reaction_answers_latest();
        let report_stands = self.no_tool.report_stands();
        let response = self.response.unwrap_or_default();
        let last_turn_usage = response.usage.clone();
        let usage = self.last_usage.unwrap_or_else(|| last_turn_usage.clone());
        let first_turn_usage = self.first_turn_usage.clone().unwrap_or_else(|| last_turn_usage.clone());
        let usage_segments = self
            .env
            .route
            .as_ref()
            .map(|route| route.usage_segments(&usage, (&self.provider.id().to_string(), &self.model)))
            .unwrap_or_default();
        let mut termination = classify_termination(&response, self.config.hidden_agent);
        // A reaction-only turn is a successful completion, never an empty
        // finish; so is an empty end after a kept answer only todo bookkeeping
        // followed.
        let mut reaction_completed = false;
        if termination == Some(Termination::Empty) {
            if reaction_answers {
                reaction_completed = true;
                termination = None;
            } else if report_stands {
                termination = None;
            }
        }
        RunOutput {
            reaction_completed,
            termination,
            usage,
            last_turn_usage,
            first_turn_usage,
            iterations: self.iterations,
            tool_calls_total: self.tool_calls_total,
            provider_continuations: self.no_tool.provider_continuations(),
            transcript: self.messages,
            carry: self.carry,
            provider_state: self.provider_state_changed.then_some(self.provider_state).flatten(),
            usage_segments,
            response,
        }
    }

    pub(crate) fn turn_limits(&self) -> Option<&TurnLimits> {
        self.config.limits.as_ref()
    }

    /// Settles the caps after a tool batch: `overrun` (the batch came after
    /// the turn was told to reply) ends the turn; otherwise a reached cap
    /// tells the model once to reply.
    pub(crate) async fn settle_turn_limits(&mut self, overrun: bool) -> Result<(), AgentError> {
        if overrun {
            self.turn_limit_ended = true;
            return Ok(());
        }
        if self.turn_limit_noticed {
            return Ok(());
        }
        let now = self.env.clock.now_ms();
        let notice = limits::notice_if_reached(
            self.turn_limits(),
            self.tool_calls_total,
            u64::from(self.iterations),
            now,
        );
        if let Some(notice) = notice {
            self.turn_limit_noticed = true;
            self.push(notice).await?;
        }
        Ok(())
    }

    pub(crate) async fn until_durable(&self, ticket: Ticket) -> Result<(), AgentError> {
        or_cancelled(&self.cancel, self.env.sink.durable(ticket))
            .await
            .ok_or(AgentError::Aborted)
    }
}
