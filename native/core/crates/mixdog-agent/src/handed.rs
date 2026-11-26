//! A session's tool calls made by an agent that runs the turn outside the loop. Each call is a tool batch of one in
//! a run of the loop ([`Run::process_tool_batch`]), and calls the agent made together that change nothing are one
//! batch: what the loop does with a batch (its projection of `call_tool`
//! onto the target, the repeat guard, the gate and approval wait, the deadline, the hooks, the error kind, the
//! offload of a large result, the result cache and the after-batch hook) is done here by the loop itself. The run
//! sends no request: its transcript is the turn's handed calls, and what it would commit is given back to the caller.

use std::collections::HashMap;
use std::sync::Arc;
use std::sync::Mutex;
use std::time::Duration;

use async_trait::async_trait;
use mixdog_core_api::domain::approval::ApprovalAsk;
use mixdog_core_api::domain::approval::ApprovalGate;
use mixdog_core_api::domain::keepalive::KeepaliveSchedule;
use mixdog_core_api::domain::keepalive::TransportKind;
use mixdog_core_api::domain::provider::DeliveryState;
use mixdog_core_api::domain::provider::ErrorKind;
use mixdog_core_api::domain::provider::ErrorResponse;
use mixdog_core_api::domain::provider::Exposure;
use mixdog_core_api::domain::provider::ModelRequest;
use mixdog_core_api::domain::provider::ModelStream;
use mixdog_core_api::domain::provider::ProviderAdapter;
use mixdog_core_api::domain::provider::ProviderError;
use mixdog_core_api::domain::provider::StreamEvent;
use mixdog_core_api::domain::provider::ToolCall;
use mixdog_core_api::domain::provider::WireCodec;
use mixdog_core_api::domain::provider::WireDecoder;
use mixdog_core_api::domain::provider::WireRequest;
use mixdog_core_api::domain::retry::Decision;
use mixdog_core_api::domain::retry::JitterSamples;
use mixdog_core_api::domain::retry::RetryDecider;
use mixdog_core_api::domain::retry::RetryPolicy;
use mixdog_core_api::domain::retry::RetryState;
use mixdog_core_api::domain::retry::Verdict;
use mixdog_protocol::ApprovalResolution;
use mixdog_protocol::ProviderId;
use tokio_util::sync::CancellationToken;

use crate::env::Clock;
use crate::env::CommitError;
use crate::env::JitterSource;
use crate::env::McpCatalog;
use crate::env::ModelVision;
use crate::env::Reactions;
use crate::env::ResultReuse;
use crate::env::RetryWait;
use crate::env::Rewrite;
use crate::env::RunObserver;
use crate::env::Ticket;
use crate::env::ToolFailureLog;
use crate::env::ToolGate;
use crate::env::ToolHooks;
use crate::env::TranscriptSink;
use crate::env::TurnGuards;
use crate::env::Yielder;
use crate::limits::TurnLimits;
use crate::message::AgentMessage;
use crate::message::ToolKind;
use crate::offload::ArtifactStore;
use crate::offload::ImageCompactor;
use crate::run::Run;
use crate::run::RunCarry;
use crate::run::RunConfig;
use crate::tools::LiveCwd;
use crate::tools::RepeatGuards;
use crate::tools::ToolEnv;
use crate::tools::ToolSet;

/// What the calls of one turn run under: the turn's assembled parts.
pub struct HandedParts {
    pub tools: ToolSet,
    pub tool_env: ToolEnv,
    pub gate: Arc<dyn ToolGate>,
    pub hooks: Option<Arc<dyn ToolHooks>>,
    pub guards: Arc<dyn TurnGuards>,
    pub reuse: Option<Arc<dyn ResultReuse>>,
    pub clock: Arc<dyn Clock>,
    /// Hears the calls' stages (an approval wait among them) as the loop's observer hears them.
    pub observer: Arc<dyn RunObserver>,
    pub mcp: Option<Arc<dyn McpCatalog>>,
    pub live_cwd: Option<LiveCwd>,
    /// Where a large result is stored; without one it stays inline.
    pub artifacts: Option<Arc<dyn ArtifactStore>>,
    pub images: Option<Arc<dyn ImageCompactor>>,
    pub failures: Option<Arc<dyn ToolFailureLog>>,
    /// The session's repeat guards, as its record holds them.
    pub repeat: RepeatGuards,
    /// The turn's token.
    pub cancel: CancellationToken,
    /// The agent lane's admission lease of an agent-owned turn, which a call's wait on the user gives up as the loop's does.
    pub slot: Option<Arc<dyn Yielder>>,
    /// The approvals the turn's gate asks on where the gate holds its own (`PolicyGate` waits inside its judgement),
    /// made with [`JudgedAsks::over`]. `None` for a gate that asks on the calls' own approvals.
    pub asks: Option<Arc<JudgedAsks>>,
    /// Turn-wide caps (tool calls, rounds, wrap-up time) enforced across handed batches.
    pub limits: Option<TurnLimits>,
    /// Whether this turn runs a hidden/internal agent (exempt from user-facing completion reminders).
    pub hidden_agent: bool,
    /// Model vision capability for handed tool outputs (e.g. PDF page images vs OCR).
    pub vision: Option<Arc<dyn ModelVision>>,
    /// Reaction recognition and target resolution for handed reaction calls.
    pub reactions: Option<Arc<dyn Reactions>>,
}

/// The approvals a turn's calls are asked on. What a call that is only being judged would be asked is put to nobody:
/// it is noted, and asking about the call is its caller's.
pub struct JudgedAsks {
    inner: Arc<dyn ApprovalGate>,
    /// The calls being judged, by id, each with whether it would be asked about.
    judging: Arc<Mutex<HashMap<String, bool>>>,
}

impl JudgedAsks {
    pub fn over(inner: Arc<dyn ApprovalGate>) -> Arc<Self> {
        Arc::new(Self { inner, judging: Arc::default() })
    }

    /// `inner`, for the calls being judged with these.
    fn alongside(&self, inner: Arc<dyn ApprovalGate>) -> Arc<Self> {
        Arc::new(Self { inner, judging: self.judging.clone() })
    }

    fn judging(&self) -> std::sync::MutexGuard<'_, HashMap<String, bool>> {
        self.judging.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
    }
}

#[async_trait]
impl ApprovalGate for JudgedAsks {
    async fn request(&self, ask: ApprovalAsk) -> ApprovalResolution {
        let judged = ask.call_id.as_ref().and_then(|id| self.judging().get_mut(id.as_str()).map(|asked| *asked = true)).is_some();
        if judged {
            // Nobody was asked, so no decision is recorded: the gate ends its judgement as a stopped wait ends it.
            return ApprovalResolution::Cancelled { at: 0 };
        }
        self.inner.request(ask).await
    }

    async fn let_go(&self, call_id: &str) {
        self.inner.let_go(call_id).await;
    }

    async fn released(&self, call_id: &str) {
        self.inner.released(call_id).await;
    }
}

/// A call under judgement, for as long as it is judged.
struct Judging<'a>(&'a JudgedAsks, &'a str);

impl Judging<'_> {
    fn asked(&self) -> bool {
        self.0.judging().get(self.1).copied().unwrap_or(false)
    }
}

impl Drop for Judging<'_> {
    fn drop(&mut self) {
        self.0.judging().remove(self.1);
    }
}

/// What the session's permissions make of a call they judge and do not run.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Judged {
    /// Every part of the call would run as it is, with nobody asked.
    Allowed,
    /// The text a call of the session's tool would be refused with.
    Refused(String),
    /// The turn was stopped before the call was judged: nothing decided it.
    Cancelled,
    /// The session would ask the user about the call.
    Asks,
    /// The session would run the call only changed (a hook's rewrite): a call that is not run here cannot be changed,
    /// so it is not the session's to allow.
    Changed,
}

/// One finished call.
pub struct Handed {
    /// The call's tool message, as the loop commits one: its content, its kind, its card diff and its timing.
    pub message: AgentMessage,
    /// What the batch adds to the conversation beside the result: a loaded skill's instructions, the reminder of the
    /// user's after-batch hook.
    pub follow_ups: Vec<String>,
    pub failed: bool,
}

/// The messages the run commits: kept for the caller, who stores the turn's rows.
#[derive(Default)]
struct Kept(Mutex<Vec<AgentMessage>>);

#[async_trait]
impl TranscriptSink for Kept {
    async fn commit(&self, message: &AgentMessage) -> Result<Ticket, CommitError> {
        self.0.lock().unwrap_or_else(std::sync::PoisonError::into_inner).push(message.clone());
        Ok(Ticket(0))
    }
    fn replace(&self, _: &[AgentMessage], _: &Rewrite) {}
    fn message_id(&self) -> String {
        String::new()
    }
    async fn durable(&self, _: Ticket) {}
}

/// The run's provider: no model answers a turn an agent outside the loop runs, so nothing is ever sent.
struct NoModel {
    id: ProviderId,
    policy: RetryPolicy,
}

struct NoWire;

impl WireDecoder for NoWire {
    fn feed(&mut self, _: &[u8]) -> Result<Vec<StreamEvent>, ProviderError> {
        Err(unsent())
    }
    fn finish(&mut self) -> Result<Vec<StreamEvent>, ProviderError> {
        Err(unsent())
    }
    fn terminal_seen(&self) -> bool {
        false
    }
    fn exposure(&self) -> Exposure {
        Exposure::default()
    }
}

impl WireCodec for NoWire {
    fn transport(&self) -> TransportKind {
        TransportKind::Http1
    }
    fn encode(&self, _: &ModelRequest) -> Result<WireRequest, ProviderError> {
        Err(unsent())
    }
    fn decoder(&self, _: &ModelRequest) -> Box<dyn WireDecoder> {
        Box::new(NoWire)
    }
    fn classify(&self, _: &ErrorResponse) -> ProviderError {
        unsent()
    }
}

fn unsent() -> ProviderError {
    ProviderError::new(ErrorKind::InvalidRequest, DeliveryState::NotSent)
}

#[async_trait]
impl ProviderAdapter for NoModel {
    fn id(&self) -> &ProviderId {
        &self.id
    }
    fn codec(&self) -> &dyn WireCodec {
        &NoWire
    }
    fn retry_policy(&self) -> &RetryPolicy {
        &self.policy
    }
    fn keepalive(&self) -> &KeepaliveSchedule {
        &KeepaliveSchedule::SPEC
    }
    async fn attempt(&self, _: Arc<ModelRequest>) -> Result<Box<dyn ModelStream>, ProviderError> {
        Err(unsent())
    }
    fn release_send(&self, _: &str) {}
    // The protocol's tool result carries no document block.
    fn native_pdf(&self) -> bool {
        false
    }
}

/// The retry path's parts of a run that sends nothing.
struct Unsent;

impl JitterSource for Unsent {
    fn draw(&self) -> f64 {
        0.0
    }
}

#[async_trait]
impl RetryWait for Unsent {
    async fn wait(&self, _: Duration) {}
}

impl RetryDecider for Unsent {
    fn verdict(&self, error: &ProviderError, state: &RetryState, _: &RetryPolicy, _: JitterSamples) -> Decision {
        Decision { verdict: Verdict::Surface, next: state.after_failure(error.kind) }
    }
}

/// A run one call (or batch of calls) runs on, with the messages it commits and when its answer is due.
struct Lane {
    run: Run,
    kept: Arc<Kept>,
    answer_by: crate::tools::AnswerBy,
}

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
}

/// Removes active call ids from [`HandedCalls::active`] when their run finishes or is dropped.
struct ActiveGuard<'a> {
    active: &'a Mutex<HashMap<String, crate::tools::AnswerBy>>,
    ids: Vec<String>,
}

impl Drop for ActiveGuard<'_> {
    fn drop(&mut self) {
        let mut active = lock(self.active);
        for id in &self.ids {
            active.remove(id);
        }
    }
}

#[derive(Default)]
struct HandedLimitState {
    tool_calls_total: u64,
    tool_rounds: u64,
    turn_limit_noticed: bool,
}

/// The calls of one turn.
pub struct HandedCalls {
    /// A new run over the turn's parts, sharing the turn's repeat guards: each concurrent call runs on its own [`Lane`],
    /// so sibling calls and plan updates never serialize on one shared call mutex.
    fresh: Mutex<Box<dyn Fn(Arc<Mutex<RepeatGuards>>) -> Lane + Send>>,
    /// Active calls' `answer_by` cells, keyed by call id, so [`Self::let_go`] clears only the released call's deadline.
    active: Mutex<HashMap<String, crate::tools::AnswerBy>>,
    env: Arc<crate::tools::CallEnv>,
    asks: Arc<JudgedAsks>,
    /// Shared repeat guards mutated under one lock across concurrent lanes so updates never clobber each other.
    repeat: Arc<Mutex<RepeatGuards>>,
    slot: Option<Arc<dyn Yielder>>,
    guards: Arc<dyn TurnGuards>,
    hooks: Option<Arc<dyn ToolHooks>>,
    clock: Arc<dyn Clock>,
    limits: Option<TurnLimits>,
    hidden_agent: bool,
    limit_state: Mutex<HandedLimitState>,
}

impl HandedCalls {
    pub fn new(mut parts: HandedParts) -> Self {
        let asks = parts.asks.take().unwrap_or_else(|| JudgedAsks::over(parts.tool_env.approvals.clone()));
        parts.tool_env.approvals = asks.alongside(parts.tool_env.approvals.clone());
        let clock = parts.clock.clone();
        let guards = parts.guards.clone();
        let hooks = parts.hooks.clone();
        let slot = parts.slot.clone();
        let limits = parts.limits;
        let hidden_agent = parts.hidden_agent;
        let mut env = crate::one_shot::isolated(parts.clock, Arc::new(Unsent), Arc::new(Unsent), Arc::new(Unsent));
        env.observer = parts.observer;
        env.gate = parts.gate;
        env.guards = parts.guards;
        env.hooks = parts.hooks;
        env.reuse = parts.reuse;
        env.mcp = parts.mcp;
        env.artifacts = parts.artifacts;
        env.images = parts.images;
        env.failures = parts.failures;
        env.reactions = parts.reactions;
        let mut config = RunConfig::new(parts.tool_env.thread_id.clone(), parts.tool_env.turn_id.clone(), String::new());
        config.live_cwd = parts.live_cwd;
        config.slot = parts.slot;
        config.limits = limits;
        config.hidden_agent = hidden_agent;
        config.vision = parts.vision;
        let provider: Arc<dyn ProviderAdapter> = Arc::new(NoModel { id: ProviderId::from("outside"), policy: RetryPolicy::codex_default() });
        let (cancel, tools, tool_env) = (parts.cancel, parts.tools, parts.tool_env);
        let repeat = Arc::new(Mutex::new(parts.repeat));
        let fresh = move |shared_repeat: Arc<Mutex<RepeatGuards>>| {
            let kept = Arc::new(Kept::default());
            let mut env = env.clone();
            env.sink = kept.clone();
            let mut run = Run::new(env, cancel.clone(), provider.clone(), tools.clone(), tool_env.clone(), config.clone(), Vec::new(), RunCarry::default())
                .with_shared_repeat(shared_repeat);
            run.outside = true;
            Lane { answer_by: run.answer_by.clone(), run, kept }
        };
        let lane = fresh(Arc::clone(&repeat));
        let env = lane.run.call_env();
        Self {
            fresh: Mutex::new(Box::new(fresh)),
            active: Mutex::default(),
            env,
            asks,
            repeat,
            slot,
            guards,
            hooks,
            clock,
            limits,
            hidden_agent,
            limit_state: Mutex::default(),
        }
    }

    /// Runs `call` as a batch of one: a `call_tool` as its target, any other call as itself.
    pub async fn call(&self, call: ToolCall) -> Handed {
        self.call_by(call, None).await
    }

    /// [`Self::call`] for an agent that must have the answer by `answer_by`: a tool that holds its answer for work to end
    /// ends the hold by then ([`mixdog_core_api::domain::tool::CallOptions::answer_by`]).
    pub async fn call_by(&self, call: ToolCall, answer_by: Option<std::time::Instant>) -> Handed {
        self.calls_by(std::slice::from_ref(&call), answer_by).await.pop().expect("an outcome for every call")
    }

    /// Runs `calls`, made together, in their order, each as [`Self::call`] runs one: each stretch of consecutive calls
    /// that change nothing as one batch, whose calls the loop runs at the same time, and each other call as a batch of
    /// its own once every call before it has ended. A refused or failed call does not stop the calls after it. The
    /// outcomes are in the calls' order; what a batch adds beside its results is given with its last call's.
    pub async fn calls(&self, calls: &[ToolCall]) -> Vec<Handed> {
        self.calls_by(calls, None).await
    }

    async fn calls_by(&self, calls: &[ToolCall], answer_by: Option<std::time::Instant>) -> Vec<Handed> {
        let mut lane = (*lock(&self.fresh))(Arc::clone(&self.repeat));
        *lock(&lane.answer_by) = answer_by;
        let ids: Vec<String> = calls.iter().map(|call| call.id.clone()).collect();
        {
            let mut active = lock(&self.active);
            for id in &ids {
                active.insert(id.clone(), lane.answer_by.clone());
            }
        }
        let _guard = ActiveGuard { active: &self.active, ids };
        let run = &mut lane.run;
        let (targets, _, _) = run.execution_view(calls);
        let cancelled =
            |id: &str| Handed { message: AgentMessage::tool_text(id, "Error: tool call cancelled", ToolKind::Error), follow_ups: Vec::new(), failed: true };
        let mut outcomes = Vec::with_capacity(calls.len());
        let mut stopped = false;
        let mut start = 0;
        while start < calls.len() {
            let unchanging = targets[start..].iter().take_while(|target| run.tools.read_only(&target.name)).count();
            let batch = &calls[start..start + unchanging.max(1)];
            start += batch.len();
            // The turn was stopped under an earlier batch, between two or before the first: nothing from here on runs.
            stopped |= self.env.cancel.is_cancelled();
            if stopped {
                outcomes.extend(batch.iter().map(|call| cancelled(&call.id)));
                continue;
            }
            let (allowed, reserved) = {
                let mut state = lock(&self.limit_state);
                let remaining = crate::limits::calls_allowed(self.limits.as_ref(), state.turn_limit_noticed, state.tool_calls_total, self.clock.now_ms());
                let reserve = (batch.len() as u64).min(remaining);
                state.tool_calls_total = state.tool_calls_total.saturating_add(reserve);
                (reserve, reserve)
            };
            // The batch reads its calls in the transcript they belong to, as the loop's batch reads its response's.
            run.messages.push(AgentMessage::assistant("", batch.to_vec()));
            let ended = run.process_tool_batch(batch, allowed).await;
            stopped = ended.is_err();
            let mut told = std::mem::take(&mut *lock(&lane.kept.0));
            let results: Vec<Option<AgentMessage>> =
                batch.iter().map(|call| told.iter().position(|message| message.tool_call_id() == Some(call.id.as_str())).map(|at| told.remove(at))).collect();
            let mut follow_ups: Vec<String> = told.iter().map(AgentMessage::text).collect();
            if stopped {
                let executed = (results.iter().filter(|result| result.is_some()).count() as u64).min(reserved);
                let unused = reserved.saturating_sub(executed);
                if unused > 0 {
                    let mut state = lock(&self.limit_state);
                    state.tool_calls_total = state.tool_calls_total.saturating_sub(unused);
                }
            } else {
                let limit_notice = {
                    let mut state = lock(&self.limit_state);
                    if reserved > 0 {
                        state.tool_rounds = state.tool_rounds.saturating_add(1);
                    }
                    if !state.turn_limit_noticed {
                        let notice = crate::limits::notice_if_reached(self.limits.as_ref(), state.tool_calls_total, state.tool_rounds, self.clock.now_ms());
                        if notice.is_some() {
                            state.turn_limit_noticed = true;
                        }
                        notice
                    } else {
                        None
                    }
                };
                if let Some(notice) = limit_notice {
                    follow_ups.push(notice.text());
                }
                self.guards.note_progress();
                let batch_results: Vec<AgentMessage> = results.iter().flatten().cloned().collect();
                if let Some(Some(stale)) = crate::env::or_cancelled(&self.env.cancel, self.guards.stale_reminder(batch, &batch_results)).await {
                    follow_ups.push(stale);
                }
            }
            for (index, (call, result)) in batch.iter().zip(results).enumerate() {
                let follow_ups = if index + 1 == batch.len() { std::mem::take(&mut follow_ups) } else { Vec::new() };
                outcomes.push(match result.filter(|_| !stopped) {
                    Some(message) => Handed { failed: message.tool_kind == Some(ToolKind::Error), follow_ups, message },
                    // The turn was stopped under the call.
                    None => cancelled(&call.id),
                });
            }
        }
        outcomes
    }

    /// The turn answered its call `call_id`, which runs now, before the call ended: the call goes on in the background past
    /// the turn on its own lane. Its tool, not started yet where it waits on the person, has no answer due any more
    /// ([`mixdog_core_api::domain::tool::CallOptions::answer_by`]); its approvals, open now or asked later, stay open for
    /// the person after the turn ends; and the turn's end does not wait for it. Its result is no longer the turn's.
    pub async fn let_go(&self, call_id: &str) {
        let answer_by = lock(&self.active).remove(call_id);
        if let Some(answer_by) = answer_by {
            *lock(&answer_by) = None;
        }
        self.asks.let_go(call_id).await;
    }

    /// The call `call_id` the turn let go of ended, however it ended (a cancel of its task included): what it still asks
    /// the person is closed.
    pub async fn released(&self, call_id: &str) {
        self.asks.released(call_id).await;
    }

    /// The session's answer to a call of its tool `name` that is not run here (an outside agent runs the same kind of
    /// work with a tool of its own): the surface, the PreToolUse hooks and the human gate a call of that tool meets
    /// before it runs, once for each of `arguments` (a call that touches several files is judged on every one). The
    /// first that is refused, would be asked about or would run changed decides the call. Nobody is asked here.
    pub async fn judge(&self, id: &str, name: &str, arguments: &[serde_json::Value]) -> Judged {
        let env = &self.env;
        let cwd = env.cwd_now();
        self.asks.judging().insert(id.to_owned(), false);
        let judging = Judging(&self.asks, id);
        for arguments in arguments {
            let judged = crate::tools::authorize(
                (id, name),
                arguments,
                cwd.as_path(),
                env.gate.as_ref(),
                env.tool_env.approvals.as_ref(),
                env.observer.as_ref(),
                env.guards.as_ref(),
            );
            let judged = crate::env::or_cancelled(&env.cancel, judged).await;
            if judging.asked() {
                return Judged::Asks;
            }
            match judged {
                None => return Judged::Cancelled,
                Some(Err(refusal)) => return Judged::Refused(refusal),
                Some(Ok(target)) if target.name != name || target.args != *arguments => return Judged::Changed,
                Some(Ok(_)) => {}
            }
        }
        Judged::Allowed
    }

    /// The session's repeat guards after the turn's calls that ended, as its record keeps them.
    pub fn repeat_saved(&self) -> serde_json::Map<String, serde_json::Value> {
        lock(&self.repeat).to_saved()
    }

    /// The worker admission lease for this turn, if owned by a worker lane.
    pub fn slot(&self) -> Option<Arc<dyn Yielder>> {
        self.slot.clone()
    }

    pub fn guards(&self) -> &Arc<dyn TurnGuards> {
        &self.guards
    }

    pub fn hooks(&self) -> Option<&Arc<dyn ToolHooks>> {
        self.hooks.as_ref()
    }

    pub fn turn_limit_noticed(&self) -> bool {
        lock(&self.limit_state).turn_limit_noticed
    }

    pub fn hidden_agent(&self) -> bool {
        self.hidden_agent
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;
    use std::time::Duration;

    use mixdog_core_api::domain::common::AbsPath;
    use mixdog_core_api::domain::mock::MockApprovalGate;
    use mixdog_core_api::domain::mock::MockFileService;
    use mixdog_core_api::domain::mock::MockProcessManager;
    use mixdog_core_api::domain::mock::MockProgress;
    use mixdog_core_api::domain::tool::CallProjection;
    use mixdog_core_api::domain::tool::SurfaceKind;
    use mixdog_core_api::domain::tool::Tool;
    use mixdog_core_api::domain::tool::ToolContext;
    use mixdog_core_api::domain::tool::ToolIo;
    use mixdog_core_api::domain::tool::ToolOutcome;
    use mixdog_core_api::domain::tool::ToolOutput;
    use mixdog_core_api::domain::tool::ToolPart;
    use mixdog_core_api::domain::tool::ToolSpec;
    use mixdog_core_api::ids::ThreadId;
    use mixdog_core_api::ids::TurnId;
    use serde_json::Value;
    use serde_json::json;

    use super::*;
    use crate::env::GateCall;
    use crate::env::GateDecision;

    /// What the pipeline did, in order: the gate's judgements, the tool's runs with what each was told, the hooks' reports.
    type Seen = Arc<Mutex<Vec<String>>>;

    struct Fixed;
    impl Clock for Fixed {
        fn now_ms(&self) -> i64 {
            0
        }
    }

    fn spec(name: &str) -> ToolSpec {
        ToolSpec {
            name: name.into(),
            title: None,
            trigger: None,
            public: true,
            aliases: Vec::new(),
            description: String::new(),
            input_schema: json!({ "type": "object" }),
            annotations: Default::default(),
            parallel_safe: true,
            exclusive_with: Vec::new(),
        }
    }

    /// The deferred tool a `call_tool` stands for: its result carries a card diff.
    struct Target(ToolSpec, Seen);

    #[async_trait::async_trait]
    impl Tool for Target {
        fn spec(&self) -> &ToolSpec {
            &self.0
        }
        async fn call(&self, ctx: &ToolContext, _: Value) -> ToolOutcome {
            let told = (ctx.deadline.is_some(), ctx.review.is_some(), ctx.options.outside_context, ctx.options.answer_by.is_some());
            self.1.lock().unwrap().push(format!("run {} {told:?}", self.0.name));
            Ok(ToolOutput { parts: vec![ToolPart::Text("done".into())], meta: Some(json!({ "uiDiff": "@@ -1 +1 @@" })), ..ToolOutput::default() })
        }
    }

    struct CallTool(ToolSpec);

    impl CallProjection for CallTool {
        fn project(&self, _: &ThreadId, arguments: &Value) -> Result<(String, Value), String> {
            Ok((arguments["name"].as_str().unwrap_or_default().to_owned(), arguments["arguments"].clone()))
        }
    }

    #[async_trait::async_trait]
    impl Tool for CallTool {
        fn spec(&self) -> &ToolSpec {
            &self.0
        }
        fn projection(&self) -> Option<&dyn CallProjection> {
            Some(self)
        }
        async fn call(&self, _: &ToolContext, _: Value) -> ToolOutcome {
            panic!("a projected call runs its target, never the projecting tool")
        }
    }

    struct Witness(Seen);

    #[async_trait::async_trait]
    impl ToolGate for Witness {
        async fn check_call(&self, _: &str, call: &GateCall) -> GateDecision {
            self.0.lock().unwrap().push(format!("judge {}", call.name));
            GateDecision::Allow
        }
    }

    #[async_trait::async_trait]
    impl ToolHooks for Witness {
        async fn after_tool(&self, _: &str, call: &GateCall, _: &str) -> Option<String> {
            self.0.lock().unwrap().push(format!("report {}", call.name));
            None
        }
        async fn after_batch(&self, tool_count: usize) -> Option<String> {
            self.0.lock().unwrap().push(format!("batch of {tool_count}"));
            Some("the user's after-batch word".to_owned())
        }
    }

    /// A tool that answers its failure as text, as the skill and MCP tools do.
    struct Refuses(ToolSpec);

    #[async_trait::async_trait]
    impl Tool for Refuses {
        fn spec(&self) -> &ToolSpec {
            &self.0
        }
        async fn call(&self, _: &ToolContext, _: Value) -> ToolOutcome {
            Ok(ToolOutput { parts: vec![ToolPart::Text("Error: no such skill".into())], ..ToolOutput::default() })
        }
    }

    fn calls_of(seen: &Seen) -> HandedCalls {
        calls_with(seen, Arc::new(Witness(seen.clone())), Arc::new(MockApprovalGate::default()))
    }

    fn calls_with(seen: &Seen, gate: Arc<dyn ToolGate>, approvals: Arc<MockApprovalGate>) -> HandedCalls {
        calls_under(seen, gate, approvals, CancellationToken::new())
    }

    /// [`calls_with`], for a turn whose token is `cancel`.
    fn calls_under(seen: &Seen, gate: Arc<dyn ToolGate>, approvals: Arc<dyn ApprovalGate>, cancel: CancellationToken) -> HandedCalls {
        let tokens = mixdog_rt::testing::tokens();
        HandedCalls::new(HandedParts {
            tools: ToolSet::new(vec![Arc::new(CallTool(spec("call_tool"))), Arc::new(Target(spec("edit"), seen.clone())), Arc::new(Refuses(spec("Skill")))]),
            tool_env: ToolEnv {
                thread_id: ThreadId::from("t"),
                turn_id: TurnId::from("r"),
                cwd: AbsPath::new(std::env::temp_dir()).unwrap(),
                surface: SurfaceKind::Lead,
                io: ToolIo { interactive: tokens.interactive_io, durability: tokens.durability_io, maintenance: tokens.maintenance_io },
                approvals,
                files: Arc::new(MockFileService::default()),
                processes: Arc::new(MockProcessManager::default()),
                progress: Arc::new(MockProgress::default()),
                deadline_of: Some(Arc::new(|_: &ToolSpec| Some(Duration::from_secs(60)))),
                notify: None,
                review: None,
            },
            gate,
            hooks: Some(Arc::new(Witness(seen.clone()))),
            guards: Arc::new(crate::env::NoGuards),
            reuse: None,
            clock: Arc::new(Fixed),
            observer: Arc::new(crate::env::NullObserver),
            mcp: None,
            live_cwd: None,
            artifacts: None,
            images: None,
            failures: None,
            repeat: RepeatGuards::default(),
            cancel,
            slot: None,
            asks: None,
            limits: None,
            hidden_agent: false,
            vision: None,
            reactions: None,
        })
    }

    /// A handed `call_tool` is the loop's: its target is judged once, run once with the loop's deadline and no claim that
    /// the caller reads the session's rows, and reported once; the projecting tool is none of the three. The result is the
    /// loop's tool message, card diff included.
    #[tokio::test]
    async fn a_handed_call_tool_runs_its_target_once_as_the_loop_runs_it() {
        let seen: Seen = Arc::default();
        let calls = calls_of(&seen);
        let call =
            ToolCall { id: "c1".into(), name: "call_tool".into(), arguments: json!({ "name": "edit", "arguments": { "path": "a.txt" } }), native_type: None };

        let handed = calls.call(call).await;

        assert_eq!(*seen.lock().unwrap(), ["judge edit", "run edit (true, false, true, false)", "report edit", "batch of 1"]);
        assert!(!handed.failed);
        assert_eq!(handed.message.text(), "done");
        assert_eq!(handed.message.ui_diff.as_deref(), Some("@@ -1 +1 @@"));
        assert_eq!(handed.message.tool_call_id(), Some("c1"));
    }

    /// Judges a call by the file it names: `secret…` is refused, `ask…` asked about, `moved…` run on another file, and
    /// any other allowed.
    struct ByFile(Seen);

    #[async_trait::async_trait]
    impl ToolGate for ByFile {
        async fn check_call(&self, call_id: &str, call: &GateCall) -> GateDecision {
            let file = call.args["file_path"].as_str().unwrap_or_default().to_owned();
            self.0.lock().unwrap().push(format!("judge {file}"));
            if file.starts_with("secret") {
                return GateDecision::Deny(format!("Error: {file} is off limits"));
            }
            if file.starts_with("moved") {
                return GateDecision::Rewrite(GateCall::new(call.name.clone(), json!({ "file_path": "elsewhere.txt" })));
            }
            if !file.starts_with("ask") {
                return GateDecision::Allow;
            }
            let ask = ApprovalAsk {
                kind: mixdog_core_api::domain::approval::ApprovalKind::Tool,
                call_id: Some(mixdog_protocol::ToolCallId::from(call_id.to_owned())),
                tool: Some(call.name.clone()),
                action_kind: None,
                reason: None,
                payload: json!({}),
                remember: Vec::new(),
                expires_after: None,
            };
            GateDecision::Ask(Box::new(crate::env::GateAsk { reason: "needs a person".into(), ask, call: None }))
        }
    }

    /// A call that is only judged meets the session's gate as a call of that tool does, and nothing of it runs: no tool,
    /// no hook's report, no batch. The gate's refusal is the judgement's.
    #[tokio::test]
    async fn a_judged_call_meets_the_gate_and_runs_nothing() {
        let seen: Seen = Arc::default();
        let calls = calls_with(&seen, Arc::new(ByFile(seen.clone())), Arc::default());
        assert_eq!(calls.judge("c1", "edit", &[json!({ "file_path": "a.txt" })]).await, Judged::Allowed);
        assert_eq!(*seen.lock().unwrap(), ["judge a.txt"]);
        assert_eq!(calls.judge("c2", "edit", &[json!({ "file_path": "secret.txt" })]).await, Judged::Refused("Error: secret.txt is off limits".to_owned()));
        assert_eq!(*seen.lock().unwrap(), ["judge a.txt", "judge secret.txt"], "a refused call ran nothing");
    }

    /// A call that touches several files is judged on every one of them: the first that is refused or would be asked
    /// about decides the call, whatever the files before it were judged.
    #[tokio::test]
    async fn a_judged_call_is_decided_by_every_file_it_touches() {
        let seen: Seen = Arc::default();
        let calls = calls_with(&seen, Arc::new(ByFile(seen.clone())), Arc::default());
        let files = |names: &[&str]| names.iter().map(|name| json!({ "file_path": name })).collect::<Vec<_>>();
        assert_eq!(calls.judge("c1", "edit", &files(&["a.txt", "b.txt"])).await, Judged::Allowed);
        assert_eq!(calls.judge("c2", "edit", &files(&["a.txt", "secret.txt", "ask.txt"])).await, Judged::Refused("Error: secret.txt is off limits".to_owned()));
        assert_eq!(calls.judge("c3", "edit", &files(&["a.txt", "ask.txt", "secret.txt"])).await, Judged::Asks);
        assert_eq!(*seen.lock().unwrap(), ["judge a.txt", "judge b.txt", "judge a.txt", "judge secret.txt", "judge a.txt", "judge ask.txt"]);
    }

    /// What the gate would ask about a judged call is put to nobody, and is the judgement's; the same ask about a call
    /// the session runs still reaches its approvals.
    #[tokio::test]
    async fn a_judged_call_the_gate_would_ask_about_asks_nobody() {
        let seen: Seen = Arc::default();
        let approvals = Arc::new(MockApprovalGate::default());
        let calls = calls_with(&seen, Arc::new(ByFile(seen.clone())), approvals.clone());
        assert_eq!(calls.judge("c1", "edit", &[json!({ "file_path": "ask.txt" })]).await, Judged::Asks);
        assert!(approvals.asks.lock().unwrap().is_empty(), "nobody was asked");

        let call = ToolCall { id: "c1".into(), name: "edit".into(), arguments: json!({ "file_path": "ask.txt" }), native_type: None };
        calls.call(call).await;
        assert_eq!(approvals.asks.lock().unwrap().len(), 1, "a call the session runs is asked about");
    }

    /// The agent's own call cannot be changed: one the session would run only rewritten is not the session's to allow.
    #[tokio::test]
    async fn a_judged_call_the_gate_would_rewrite_is_not_allowed() {
        let seen: Seen = Arc::default();
        let calls = calls_with(&seen, Arc::new(ByFile(seen.clone())), Arc::default());
        assert_eq!(calls.judge("c1", "edit", &[json!({ "file_path": "a.txt" }), json!({ "file_path": "moved.txt" })]).await, Judged::Changed);
    }

    /// A handed call ends as a batch of the loop ends: a result that reads as an error is an error call, and the user's
    /// after-batch hook runs, its word given back beside the result.
    #[tokio::test]
    async fn a_handed_call_is_finished_by_the_loops_after_batch_step() {
        let seen: Seen = Arc::default();
        let calls = calls_of(&seen);

        let handed = calls.call(ToolCall { id: "c1".into(), name: "Skill".into(), arguments: json!({ "name": "none" }), native_type: None }).await;

        assert!(handed.failed, "a tool that answers `Error: …` is a failed call");
        assert_eq!((handed.message.tool_kind, handed.message.message.is_error), (Some(ToolKind::Error), true));
        assert_eq!(handed.follow_ups, ["<system-reminder>\nthe user's after-batch word\n</system-reminder>"]);
        assert!(seen.lock().unwrap().contains(&"batch of 1".to_owned()));
    }

    /// Refuses every call on the session's surface, noting the file it names, and stops the turn as it refuses.
    struct StopsTheTurn(Seen, CancellationToken);

    #[async_trait::async_trait]
    impl ToolGate for StopsTheTurn {
        async fn check_call(&self, _: &str, _: &GateCall) -> GateDecision {
            GateDecision::Allow
        }
        fn pre_dispatch_deny(&self, call: &GateCall) -> Option<String> {
            self.0.lock().unwrap().push(format!("judge {}", call.args["file_path"].as_str().unwrap_or_default()));
            self.1.cancel();
            Some("Error: off this surface".to_owned())
        }
    }

    /// Two edits handed together are two batches. The turn is stopped while the first is refused, which its batch answers
    /// without a run: the second is never judged, started or reported, and its outcome is the cancellation.
    #[tokio::test]
    async fn a_call_handed_behind_a_stop_of_the_turn_is_cancelled_unjudged() {
        let seen: Seen = Arc::default();
        let cancel = CancellationToken::new();
        let calls = calls_under(&seen, Arc::new(StopsTheTurn(seen.clone(), cancel.clone())), Arc::new(MockApprovalGate::default()), cancel);
        let edit = |id: &str, file: &str| ToolCall { id: id.into(), name: "edit".into(), arguments: json!({ "file_path": file }), native_type: None };

        let handed = calls.calls(&[edit("c1", "a.txt"), edit("c2", "b.txt")]).await;

        assert_eq!(*seen.lock().unwrap(), ["judge a.txt", "batch of 1"]);
        assert_eq!(handed[0].message.text(), "Error: off this surface");
        assert_eq!(handed[1].message.text(), "Error: tool call cancelled");
        assert!(handed[1].failed);
    }

    /// The session's approvals: every ask waits for a person who never answers, and what the turn lets go of is noted.
    #[derive(Default)]
    struct Unanswered {
        asked: tokio::sync::Notify,
        let_go: Mutex<Vec<String>>,
    }

    #[async_trait::async_trait]
    impl ApprovalGate for Unanswered {
        async fn request(&self, _: ApprovalAsk) -> ApprovalResolution {
            self.asked.notify_one();
            std::future::pending().await
        }
        async fn let_go(&self, call_id: &str) {
            self.let_go.lock().unwrap().push(call_id.to_owned());
        }
    }

    /// A call still waiting on the person when the turn lets go of it is let go of at the session's approvals, and the
    /// turn's end reads the repeat guards while the call still holds the turn's run.
    #[tokio::test]
    async fn a_call_the_turn_lets_go_of_holds_neither_its_approvals_nor_the_turns_end() {
        let seen: Seen = Arc::default();
        let approvals = Arc::new(Unanswered::default());
        let calls = calls_under(&seen, Arc::new(ByFile(seen.clone())), approvals.clone(), CancellationToken::new());
        let call = ToolCall { id: "c1".into(), name: "edit".into(), arguments: json!({ "file_path": "ask.txt" }), native_type: None };
        let turn = async {
            approvals.asked.notified().await;
            calls.let_go("c1").await;
            assert_eq!(*approvals.let_go.lock().unwrap(), ["c1"]);
            assert_eq!(calls.repeat_saved(), RepeatGuards::default().to_saved());
        };
        tokio::select! {
            _ = calls.call(call) => panic!("the call ended without an answer"),
            () = turn => {}
        }
    }

    /// The session's approvals: each ask is noted and approved once the test says so, and what ends is noted.
    #[derive(Default)]
    struct ApprovedLater {
        asked: tokio::sync::Notify,
        approve: tokio::sync::Notify,
        released: Mutex<Vec<String>>,
    }

    #[async_trait::async_trait]
    impl ApprovalGate for ApprovedLater {
        async fn request(&self, _: ApprovalAsk) -> ApprovalResolution {
            self.asked.notify_one();
            self.approve.notified().await;
            let decision = mixdog_protocol::ToolApprovalDecision {
                approved: true,
                reason: None,
                answers: None,
                reply: None,
                response: None,
                edited_args: None,
                remember: None,
                scope: None,
            };
            ApprovalResolution::Decided { decision, device: "desk".into(), connection_kind: mixdog_protocol::ConnectionKind::Desktop, at: 0 }
        }
        async fn released(&self, call_id: &str) {
            self.released.lock().unwrap().push(call_id.to_owned());
        }
    }

    /// A call the turn lets go of while it waits on the person holds nothing the turn's later calls need: the next call
    /// runs at once beside it. Approved afterwards, its tool starts with no answer due, as nobody waits for one; the next
    /// call's tool still has its own. Its end reaches the session's approvals.
    #[tokio::test]
    async fn a_call_the_turn_lets_go_of_runs_beside_its_next_call_and_starts_with_no_answer_due() {
        let seen: Seen = Arc::default();
        let approvals = Arc::new(ApprovedLater::default());
        let calls = calls_under(&seen, Arc::new(ByFile(seen.clone())), approvals.clone(), CancellationToken::new());
        let edit = |id: &str, file: &str| ToolCall { id: id.into(), name: "edit".into(), arguments: json!({ "file_path": file }), native_type: None };
        let due = Some(std::time::Instant::now() + Duration::from_secs(60));
        let mut first = Box::pin(calls.call_by(edit("c1", "ask.txt"), due));
        tokio::select! {
            _ = &mut first => panic!("the call ended before it was approved"),
            () = approvals.asked.notified() => {}
        }
        calls.let_go("c1").await;

        let next =
            tokio::time::timeout(Duration::from_secs(5), calls.call_by(edit("c2", "a.txt"), due)).await.expect("the next call waited for the one let go of");
        assert_eq!(next.message.tool_call_id(), Some("c2"));
        approvals.approve.notify_one();
        let first = first.await;
        assert_eq!((first.message.tool_call_id(), first.message.text()), (Some("c1"), "done".to_owned()));
        let runs: Vec<String> = seen.lock().unwrap().iter().filter(|line| line.starts_with("run ")).cloned().collect();
        assert_eq!(runs, ["run edit (true, false, true, true)", "run edit (true, false, true, false)"]);
        calls.released("c1").await;
        assert_eq!(*approvals.released.lock().unwrap(), ["c1"]);
    }

    /// Cancelling the turn's token while `judge` is awaiting authorization returns `Judged::Cancelled` rather than
    /// `Judged::Refused`.
    #[tokio::test]
    async fn judge_returns_cancelled_when_token_cancels() {
        struct HangingGate(tokio::sync::Notify);
        #[async_trait::async_trait]
        impl ToolGate for HangingGate {
            async fn check_call(&self, _: &str, _: &GateCall) -> GateDecision {
                self.0.notify_one();
                std::future::pending().await
            }
        }
        let seen: Seen = Arc::default();
        let cancel = CancellationToken::new();
        let gate = Arc::new(HangingGate(tokio::sync::Notify::new()));
        let calls = calls_under(&seen, gate.clone(), Arc::new(MockApprovalGate::default()), cancel.clone());
        let args = [json!({ "file_path": "a.txt" })];
        let judging = calls.judge("c1", "edit", &args);
        let stop = async {
            gate.0.notified().await;
            cancel.cancel();
        };
        let (result, ()) = tokio::join!(judging, stop);
        assert_eq!(result, Judged::Cancelled);
    }

    /// Concurrent `call_by` calls run in parallel on separate lanes, and `let_go` clears `answer_by` only for the
    /// released call without blocking or altering siblings.
    #[tokio::test]
    async fn concurrent_calls_do_not_serialize_and_let_go_clears_only_released_call() {
        struct GateTool {
            spec: ToolSpec,
            entered: Arc<tokio::sync::Notify>,
            release: Arc<tokio::sync::Notify>,
            seen: Seen,
        }
        #[async_trait::async_trait]
        impl Tool for GateTool {
            fn spec(&self) -> &ToolSpec {
                &self.spec
            }
            async fn call(&self, ctx: &ToolContext, args: Value) -> ToolOutcome {
                let tag = args["tag"].as_str().unwrap_or_default().to_owned();
                if tag == "first" {
                    self.entered.notify_one();
                    self.release.notified().await;
                }
                self.seen.lock().unwrap().push(format!("{tag}:{}", ctx.options.answer_by.is_some()));
                Ok(ToolOutput { parts: vec![ToolPart::Text(format!("ok:{tag}"))], ..ToolOutput::default() })
            }
        }

        let seen: Seen = Arc::default();
        let entered = Arc::new(tokio::sync::Notify::new());
        let release = Arc::new(tokio::sync::Notify::new());
        let tokens = mixdog_rt::testing::tokens();
        let calls = HandedCalls::new(HandedParts {
            tools: ToolSet::new(vec![Arc::new(GateTool { spec: spec("work"), entered: entered.clone(), release: release.clone(), seen: seen.clone() })]),
            tool_env: ToolEnv {
                thread_id: ThreadId::from("t"),
                turn_id: TurnId::from("r"),
                cwd: AbsPath::new(std::env::temp_dir()).unwrap(),
                surface: SurfaceKind::Lead,
                io: ToolIo { interactive: tokens.interactive_io, durability: tokens.durability_io, maintenance: tokens.maintenance_io },
                approvals: Arc::new(MockApprovalGate::default()),
                files: Arc::new(MockFileService::default()),
                processes: Arc::new(MockProcessManager::default()),
                progress: Arc::new(MockProgress::default()),
                deadline_of: Some(Arc::new(|_: &ToolSpec| Some(Duration::from_secs(60)))),
                notify: None,
                review: None,
            },
            gate: Arc::new(Witness(seen.clone())),
            hooks: None,
            guards: Arc::new(crate::env::NoGuards),
            reuse: None,
            clock: Arc::new(Fixed),
            observer: Arc::new(crate::env::NullObserver),
            mcp: None,
            live_cwd: None,
            artifacts: None,
            images: None,
            failures: None,
            repeat: RepeatGuards::default(),
            cancel: CancellationToken::new(),
            slot: None,
            asks: None,
            limits: None,
            hidden_agent: false,
            vision: None,
            reactions: None,
        });

        let due = Some(std::time::Instant::now() + Duration::from_secs(60));
        let first_call = ToolCall { id: "c1".into(), name: "work".into(), arguments: json!({ "tag": "first" }), native_type: None };
        let second_call = ToolCall { id: "c2".into(), name: "work".into(), arguments: json!({ "tag": "second" }), native_type: None };

        let mut first = Box::pin(calls.call_by(first_call, due));
        tokio::select! {
            _ = &mut first => panic!("first finished before release"),
            () = entered.notified() => {}
        }

        // Second call completes while first is still inside its tool implementation.
        let second =
            tokio::time::timeout(Duration::from_secs(5), calls.call_by(second_call, due)).await.expect("sibling call must not wait on first call's lane");
        assert_eq!(second.message.text(), "ok:second");

        // Releasing first does not disturb anything else and lets first finish cleanly.
        calls.let_go("c1").await;
        release.notify_one();
        let first = tokio::time::timeout(Duration::from_secs(5), first).await.expect("first completes");
        assert_eq!(first.message.text(), "ok:first");
        let recorded = seen.lock().unwrap().clone();
        assert!(recorded.iter().any(|s| s == "second:true"), "{recorded:?}");
        assert!(recorded.iter().any(|s| s == "first:true"), "{recorded:?}");
    }

    /// Concurrent failing calls share one locked `RepeatGuards`, so a slow call finishing after a fast sibling has
    /// tripped its repeat guard never clobbers the sibling's recorded failures.
    #[tokio::test]
    async fn concurrent_calls_do_not_clobber_repeat_guards() {
        struct FailingGateTool {
            spec: ToolSpec,
            entered: Arc<tokio::sync::Notify>,
            release: Arc<tokio::sync::Notify>,
        }
        #[async_trait::async_trait]
        impl Tool for FailingGateTool {
            fn spec(&self) -> &ToolSpec {
                &self.spec
            }
            async fn call(&self, _: &ToolContext, args: Value) -> ToolOutcome {
                if args["tag"] == "slow" {
                    self.entered.notify_one();
                    self.release.notified().await;
                }
                Ok(ToolOutput { parts: vec![ToolPart::Text("Error: boom".into())], ..ToolOutput::default() })
            }
        }

        let entered = Arc::new(tokio::sync::Notify::new());
        let release = Arc::new(tokio::sync::Notify::new());
        let tokens = mixdog_rt::testing::tokens();
        let calls = HandedCalls::new(HandedParts {
            tools: ToolSet::new(vec![Arc::new(FailingGateTool { spec: spec("flaky"), entered: entered.clone(), release: release.clone() })]),
            tool_env: ToolEnv {
                thread_id: ThreadId::from("t"),
                turn_id: TurnId::from("r"),
                cwd: AbsPath::new(std::env::temp_dir()).unwrap(),
                surface: SurfaceKind::Lead,
                io: ToolIo { interactive: tokens.interactive_io, durability: tokens.durability_io, maintenance: tokens.maintenance_io },
                approvals: Arc::new(MockApprovalGate::default()),
                files: Arc::new(MockFileService::default()),
                processes: Arc::new(MockProcessManager::default()),
                progress: Arc::new(MockProgress::default()),
                deadline_of: Some(Arc::new(|_: &ToolSpec| Some(Duration::from_secs(60)))),
                notify: None,
                review: None,
            },
            gate: Arc::new(Witness(Arc::default())),
            hooks: None,
            guards: Arc::new(crate::env::NoGuards),
            reuse: None,
            clock: Arc::new(Fixed),
            observer: Arc::new(crate::env::NullObserver),
            mcp: None,
            live_cwd: None,
            artifacts: None,
            images: None,
            failures: None,
            repeat: RepeatGuards::default(),
            cancel: CancellationToken::new(),
            slot: None,
            asks: None,
            limits: None,
            hidden_agent: false,
            vision: None,
            reactions: None,
        });

        let slow_call = ToolCall { id: "s1".into(), name: "flaky".into(), arguments: json!({ "tag": "slow" }), native_type: None };
        let fast_call = |id: &str| ToolCall { id: id.into(), name: "flaky".into(), arguments: json!({ "tag": "fast" }), native_type: None };

        let mut slow = Box::pin(calls.call(slow_call));
        tokio::select! {
            _ = &mut slow => panic!("slow finished before release"),
            () = entered.notified() => {}
        }

        // Fast call fails twice while slow is in flight, building up `_repeatFailHistory`.
        assert!(calls.call(fast_call("f1")).await.failed);
        assert!(calls.call(fast_call("f2")).await.failed);

        // Slow finishes with a distinct failure afterwards: it must append to the shared RepeatGuards
        // rather than overwriting them with its pre-flight snapshot (which would erase f1 and f2).
        release.notify_one();
        let slow_outcome = slow.await;
        assert!(slow_outcome.failed);

        let saved = calls.repeat_saved();
        let history = saved.get("_repeatFailHistory").and_then(Value::as_array).expect("repeat fail history saved");
        assert_eq!(history.len(), 3, "concurrent slow completion must preserve fast failures in _repeatFailHistory: {saved:?}");
        let fast_entries = history.iter().filter(|entry| entry.as_str().is_some_and(|s| s.contains("fast"))).count();
        let slow_entries = history.iter().filter(|entry| entry.as_str().is_some_and(|s| s.contains("slow"))).count();
        assert_eq!((fast_entries, slow_entries), (2, 1), "both fast and slow failures must be retained: {history:?}");
    }

    /// Two concurrent calls with `max_tool_calls: Some(1)` reserve slots atomically before execution so at most one
    /// executes and the second is immediately refused with `[turn-limit]`.
    #[tokio::test]
    async fn concurrent_turn_limits_never_exceed_max_tool_calls() {
        struct BlockingOk {
            spec: ToolSpec,
            entered: Arc<tokio::sync::Notify>,
            release: Arc<tokio::sync::Notify>,
            executed: Arc<std::sync::atomic::AtomicUsize>,
        }
        #[async_trait]
        impl Tool for BlockingOk {
            fn spec(&self) -> &ToolSpec {
                &self.spec
            }
            async fn call(&self, _: &ToolContext, args: Value) -> ToolOutcome {
                self.executed.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                if args.get("block") == Some(&json!(true)) {
                    self.entered.notify_one();
                    self.release.notified().await;
                }
                Ok(ToolOutput { parts: vec![ToolPart::Text("ok".into())], ..ToolOutput::default() })
            }
        }

        let entered = Arc::new(tokio::sync::Notify::new());
        let release = Arc::new(tokio::sync::Notify::new());
        let executed = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let seen: Seen = Arc::default();
        let tokens = mixdog_rt::testing::tokens();
        let calls = HandedCalls::new(HandedParts {
            tools: ToolSet::new(vec![Arc::new(BlockingOk {
                spec: spec("edit"),
                entered: entered.clone(),
                release: release.clone(),
                executed: executed.clone(),
            })]),
            tool_env: ToolEnv {
                thread_id: ThreadId::from("t"),
                turn_id: TurnId::from("r"),
                cwd: AbsPath::new(std::env::temp_dir()).unwrap(),
                surface: SurfaceKind::Lead,
                io: ToolIo { interactive: tokens.interactive_io, durability: tokens.durability_io, maintenance: tokens.maintenance_io },
                approvals: Arc::new(MockApprovalGate::default()),
                files: Arc::new(MockFileService::default()),
                processes: Arc::new(MockProcessManager::default()),
                progress: Arc::new(MockProgress::default()),
                deadline_of: Some(Arc::new(|_: &ToolSpec| Some(Duration::from_secs(60)))),
                notify: None,
                review: None,
            },
            gate: Arc::new(Witness(seen)),
            hooks: None,
            guards: Arc::new(crate::env::NoGuards),
            reuse: None,
            clock: Arc::new(Fixed),
            observer: Arc::new(crate::env::NullObserver),
            mcp: None,
            live_cwd: None,
            artifacts: None,
            images: None,
            failures: None,
            repeat: RepeatGuards::default(),
            cancel: CancellationToken::new(),
            slot: None,
            asks: None,
            limits: Some(TurnLimits { max_tool_calls: Some(1), ..TurnLimits::default() }),
            hidden_agent: false,
            vision: None,
            reactions: None,
        });

        let mut first = Box::pin(calls.call(ToolCall { id: "c1".into(), name: "edit".into(), arguments: json!({ "block": true }), native_type: None }));
        tokio::select! {
            _ = &mut first => panic!("first call finished before release"),
            () = entered.notified() => {}
        }

        // While first is in flight and holding the single allowed slot, second must be refused immediately.
        let second = calls.call(ToolCall { id: "c2".into(), name: "edit".into(), arguments: json!({ "block": false }), native_type: None }).await;
        assert!(second.failed, "second concurrent call must be refused");
        assert!(second.message.text().contains("[turn-limit]"), "{}", second.message.text());
        assert_eq!(executed.load(std::sync::atomic::Ordering::SeqCst), 1, "at most one call may execute");

        release.notify_one();
        let first_outcome = first.await;
        assert!(!first_outcome.failed);
        assert_eq!(executed.load(std::sync::atomic::Ordering::SeqCst), 1, "still only one execution total");
    }

    /// `TurnLimits` caps handed calls across batches, emits the one-time turn-limit notice, and refuses later calls.
    #[tokio::test]
    async fn turn_limits_cap_handed_calls_and_emit_one_time_notice() {
        let seen: Seen = Arc::default();
        let tokens = mixdog_rt::testing::tokens();
        let calls = HandedCalls::new(HandedParts {
            tools: ToolSet::new(vec![Arc::new(Target(spec("edit"), seen.clone()))]),
            tool_env: ToolEnv {
                thread_id: ThreadId::from("t"),
                turn_id: TurnId::from("r"),
                cwd: AbsPath::new(std::env::temp_dir()).unwrap(),
                surface: SurfaceKind::Lead,
                io: ToolIo { interactive: tokens.interactive_io, durability: tokens.durability_io, maintenance: tokens.maintenance_io },
                approvals: Arc::new(MockApprovalGate::default()),
                files: Arc::new(MockFileService::default()),
                processes: Arc::new(MockProcessManager::default()),
                progress: Arc::new(MockProgress::default()),
                deadline_of: Some(Arc::new(|_: &ToolSpec| Some(Duration::from_secs(60)))),
                notify: None,
                review: None,
            },
            gate: Arc::new(Witness(seen.clone())),
            hooks: None,
            guards: Arc::new(crate::env::NoGuards),
            reuse: None,
            clock: Arc::new(Fixed),
            observer: Arc::new(crate::env::NullObserver),
            mcp: None,
            live_cwd: None,
            artifacts: None,
            images: None,
            failures: None,
            repeat: RepeatGuards::default(),
            cancel: CancellationToken::new(),
            slot: None,
            asks: None,
            limits: Some(TurnLimits { max_tool_calls: Some(1), ..TurnLimits::default() }),
            hidden_agent: false,
            vision: None,
            reactions: None,
        });

        let first = calls.call(ToolCall { id: "c1".into(), name: "edit".into(), arguments: json!({ "path": "a" }), native_type: None }).await;
        assert!(!first.failed);
        assert!(calls.turn_limit_noticed());
        assert!(first.follow_ups.iter().any(|text| text.contains("tool-call or time limit")), "{:?}", first.follow_ups);

        let second = calls.call(ToolCall { id: "c2".into(), name: "edit".into(), arguments: json!({ "path": "b" }), native_type: None }).await;
        assert!(second.failed);
        assert!(second.message.text().contains("[turn-limit]"), "{}", second.message.text());
        assert!(second.follow_ups.is_empty(), "turn-limit notice is emitted once: {:?}", second.follow_ups);
    }

    /// Handed batches notify `TurnGuards::note_progress` and attach any returned `stale_reminder` to `follow_ups`.
    #[tokio::test]
    async fn mid_turn_todo_guard_attaches_stale_reminder_and_notes_progress() {
        struct StaleGuard(Arc<std::sync::atomic::AtomicUsize>);
        #[async_trait::async_trait]
        impl TurnGuards for StaleGuard {
            fn note_progress(&self) {
                self.0.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            }
            fn note_user_wait(&self) {}
            fn saved(&self) -> Option<serde_json::Value> {
                None
            }
            async fn stale_reminder(&self, _: &[ToolCall], _: &[AgentMessage]) -> Option<String> {
                Some("[mixdog-runtime] update your todo list".into())
            }
            async fn completion_reminder(&self, _: bool) -> Option<String> {
                None
            }
        }

        let progressed = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let seen: Seen = Arc::default();
        let tokens = mixdog_rt::testing::tokens();
        let calls = HandedCalls::new(HandedParts {
            tools: ToolSet::new(vec![Arc::new(Target(spec("edit"), seen.clone()))]),
            tool_env: ToolEnv {
                thread_id: ThreadId::from("t"),
                turn_id: TurnId::from("r"),
                cwd: AbsPath::new(std::env::temp_dir()).unwrap(),
                surface: SurfaceKind::Lead,
                io: ToolIo { interactive: tokens.interactive_io, durability: tokens.durability_io, maintenance: tokens.maintenance_io },
                approvals: Arc::new(MockApprovalGate::default()),
                files: Arc::new(MockFileService::default()),
                processes: Arc::new(MockProcessManager::default()),
                progress: Arc::new(MockProgress::default()),
                deadline_of: Some(Arc::new(|_: &ToolSpec| Some(Duration::from_secs(60)))),
                notify: None,
                review: None,
            },
            gate: Arc::new(Witness(seen.clone())),
            hooks: None,
            guards: Arc::new(StaleGuard(progressed.clone())),
            reuse: None,
            clock: Arc::new(Fixed),
            observer: Arc::new(crate::env::NullObserver),
            mcp: None,
            live_cwd: None,
            artifacts: None,
            images: None,
            failures: None,
            repeat: RepeatGuards::default(),
            cancel: CancellationToken::new(),
            slot: None,
            asks: None,
            limits: None,
            hidden_agent: false,
            vision: None,
            reactions: None,
        });

        let handed = calls.call(ToolCall { id: "c1".into(), name: "edit".into(), arguments: json!({ "path": "a" }), native_type: None }).await;
        assert_eq!(progressed.load(std::sync::atomic::Ordering::SeqCst), 1);
        assert!(handed.follow_ups.iter().any(|text| text.contains("update your todo list")), "{:?}", handed.follow_ups);
    }
}
