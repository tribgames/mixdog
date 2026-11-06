//! The real [`RunFactory`]: a session turn (`RunStart`) becomes a `mixdog-agent` run and its
//! outcome (`RunOutcome`).
//!
//! What a turn needs that only the host knows is gathered in [`RunParts::assemble`] (each field of
//! [`Assembled`] names its owner); everything that follows from the `RunStart` itself is built
//! here: the cancel signal, the turn review and its gate, the model context and its stored rows,
//! the commit sink, the steering queue, the observer, progress and live-turn publishing, and the
//! outcome.

use std::collections::HashMap;
use std::future::Future;
use std::pin::Pin;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use mixdog_agent::env::{
    Clock, Compactor, Reactions, ResultReuse, RouteFallback, RunEnv, RunEvent, RunObserver, SkillSelector, Stage, TailReminder, TextRetraction, Retracted, Ticket, ToolGate,
    ToolHooks, TranscriptSink, TurnGuards,
};
use mixdog_agent::message::AgentMessage;
use mixdog_agent::tools::{ToolEnv, ToolSet};
use mixdog_agent::{AgentError, Run, RunCarry, RunConfig};
use mixdog_core_api::domain::provider::{Content, ProviderAdapter, Role};
use mixdog_core_api::domain::retry::RetryDecider;
use mixdog_core_api::ids::{ItemId, ThreadId, TurnId};
use mixdog_protocol::{ItemMeta, MaybeBlob, ThreadItem, TurnError};
use mixdog_rt::TaskClass;
use mixdog_tools::policy::SessionSurface;
use serde_json::{json, Value};
use tokio::sync::{mpsc, watch};

use super::live_turn::LiveTurnPublisher;
use super::message_row::{message_of, row_of};
use super::progress::{ProgressPublisher, StreamKind};
use super::retry::{RandomJitter, TimerWait};
use super::steer::SteerQueue;
use crate::session::turn_snapshot::ReviewGate;
use crate::session::{ItemCommit, RunFactory, RunOutcome, RunPort, RunStart, StoredRows};

/// What a turn's host assembly reads from the turn.
pub struct AssembleInput<'a> {
    pub thread: &'a ThreadId,
    pub turn: &'a TurnId,
    /// The session header as acked at turn start.
    pub header: &'a mixdog_store::schema::record::Header,
    pub surface: Arc<SessionSurface>,
    pub port: &'a RunPort,
    /// The session's live tool surface (the gate reads it per call).
    pub surface_rx: tokio::sync::watch::Receiver<Arc<SessionSurface>>,
    /// The agent lane's admission lease of an agent-owned turn (`TurnRequest.slot`), held for the
    /// whole turn; `RunConfig.slot`.
    pub slot: Option<Arc<dyn mixdog_agent::env::Yielder>>,
    /// The trusted text a routine's skill is selected from (`AgentTurn.skill_selection`).
    pub skill_selection: Option<String>,
}

/// What the policy gate needs from the run it gates, which exists only after assembly.
pub struct GateContext {
    pub observer: Arc<dyn RunObserver>,
    pub cancel: tokio_util::sync::CancellationToken,
    pub guards: Arc<dyn TurnGuards>,
    pub approvals: Arc<dyn mixdog_core_api::domain::approval::ApprovalGate>,
}

/// Builds the turn's gate (PolicyGate) from the run's observer, token and guards.
pub type GateBuilder = Box<dyn FnOnce(GateContext) -> Arc<dyn ToolGate> + Send>;


/// Everything of a turn the host supplies. Owners are named where the real source is not in this
/// crate yet.
pub struct Assembled {
    /// The route's provider adapter, chosen by the registry (WP-AI-SVC) for the header's route
    /// (broker, wire route, credentials).
    pub provider: Arc<dyn ProviderAdapter>,
    /// The surface's tools (WP-TOOLS-ORCH / WP-MCP) and the call environment they share.
    pub tools: ToolSet,
    pub tool_env: ToolEnv,
    /// The policy gate (`PolicyGate`, WP-AGENT/WP-SANDBOX); the factory puts the review in front.
    pub gate: GateBuilder,
    /// The turn's final workspace, where the review baseline is taken.
    pub worktree: String,
    /// `RunConfig` from the route and settings: model, request options, limits, compaction,
    /// effort wiring, text-only handling, slot (the admission lease, `Held::run_yielded`),
    /// attachments. `thread_id`, `turn_id`, `signal` and `first_request_after` are set by the
    /// factory.
    pub config: RunConfig,
    pub clock: Arc<dyn Clock>,
    pub decider: Arc<dyn RetryDecider>,
    pub guards: Arc<dyn TurnGuards>,
    pub compactor: Option<Arc<dyn Compactor>>,
    pub route: Option<Arc<dyn RouteFallback>>,
    pub skills: Option<Arc<dyn SkillSelector>>,
    pub hooks: Option<Arc<dyn ToolHooks>>,
    pub reuse: Option<Arc<dyn ResultReuse>>,
    pub reactions: Option<Arc<dyn Reactions>>,
    /// Clears the session's react targets when the turn ends, however it ends.
    pub reaction_scope: Option<super::reactions::ReactionScope>,
    /// The run's stored bodies, empty: the factory registers the turn's context and commits in
    /// it; `reactions` reads its message facts from the same value.
    pub rows: Arc<StoredRows>,
    pub tail: Option<Arc<dyn TailReminder>>,
    pub step_judge: Option<Arc<dyn mixdog_agent::step_effort::StepEffortJudge>>,
    pub artifacts: Option<Arc<dyn mixdog_agent::offload::ArtifactStore>>,
    pub images: Option<Arc<dyn mixdog_agent::offload::ImageCompactor>>,
    /// The attachment blob reader, for the display facts of a user row (a pasted text's body).
    pub blobs: Arc<dyn mixdog_protocol::message_class::user_text::Blobs + Send + Sync>,
    /// The guard state that outlives one ask (the session record).
    pub carry: RunCarry,
}

#[async_trait]
pub trait RunParts: Send + Sync + 'static {
    /// The turn's host parts; a refusal fails the turn with its error.
    async fn assemble(&self, input: AssembleInput<'_>) -> Result<Assembled, TurnError>;
}

pub struct RunHostFactory {
    parts: Arc<dyn RunParts>,
}

impl RunHostFactory {
    pub fn new(parts: Arc<dyn RunParts>) -> Self {
        Self { parts }
    }
}

impl RunFactory for RunHostFactory {
    fn start(&self, run: RunStart) -> Pin<Box<dyn Future<Output = RunOutcome> + Send>> {
        let parts = self.parts.clone();
        Box::pin(drive(parts, run))
    }
}

fn new_item_id() -> ItemId {
    ItemId::from(format!("itm_{}", uuid::Uuid::new_v4().simple()))
}

fn failed(message: impl Into<String>, data: Value) -> RunOutcome {
    RunOutcome::Failed(TurnError { message: message.into(), data, provider_error: None })
}

// ---- the commit sink ---------------------------------------------------------------------------------

enum Job {
    Commit(u64, ItemCommit),
    Compact(u64, crate::session::run::Compaction),
}

/// `TranscriptSink` over the run's port: commits go to the actor in order on one task, and
/// `durable` waits for that task. `Ticket(0)` is the turn's input row, which the actor committed.
struct PortSink {
    jobs: mpsc::UnboundedSender<Job>,
    done: watch::Receiver<u64>,
    seq: AtomicU64,
    port: RunPort,
    rows: Arc<StoredRows>,
    live: LiveTurnPublisher,
    turn: Mutex<Vec<AgentMessage>>,
    /// The item the shown assistant text belongs to, until its message commits.
    streaming: Arc<Mutex<Option<ItemId>>>,
    iids: Mutex<HashMap<String, ItemId>>,
    clock: Arc<dyn Clock>,
    blobs: Arc<dyn mixdog_protocol::message_class::user_text::Blobs + Send + Sync>,
    /// A worker's turn hook (`onToolResult`): called with each tool result the turn gains.
    on_tool_result: Option<Arc<dyn Fn(&mixdog_agent::agent_tool::flow::seams::ToolResultMessage) + Send + Sync>>,
}

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
}

impl PortSink {
    fn spawn(
        port: RunPort,
        rows: Arc<StoredRows>,
        live: LiveTurnPublisher,
        streaming: Arc<Mutex<Option<ItemId>>>,
        clock: Arc<dyn Clock>,
        blobs: Arc<dyn mixdog_protocol::message_class::user_text::Blobs + Send + Sync>,
        on_tool_result: Option<Arc<dyn Fn(&mixdog_agent::agent_tool::flow::seams::ToolResultMessage) + Send + Sync>>,
    ) -> Arc<Self> {
        let (jobs, mut queue) = mpsc::unbounded_channel::<Job>();
        let (done_tx, done) = watch::channel(0u64);
        let worker = port.clone();
        drop(mixdog_rt::spawn("run-commit", TaskClass::Work, async move {
            while let Some(job) = queue.recv().await {
                let n = match job {
                    Job::Commit(n, item) => {
                        let _ = worker.commit_item(item).await;
                        n
                    }
                    Job::Compact(n, compaction) => {
                        let _ = worker.compacted(compaction).await;
                        n
                    }
                };
                done_tx.send_replace(n);
            }
        }));
        Arc::new(Self { jobs, done, seq: AtomicU64::new(0), port, rows, live, turn: Mutex::new(Vec::new()), streaming, iids: Mutex::new(HashMap::new()), clock, blobs, on_tool_result })
    }

    /// The input row and the context before it: known ids, and the turn's first live message.
    fn seed(&self, input: &AgentMessage) {
        let mut turn = lock(&self.turn);
        turn.push(input.clone());
        self.live.publish(&turn, &*self.rows);
    }

    fn iid_of(&self, message: &AgentMessage) -> ItemId {
        match &message.message_id {
            Some(id) => lock(&self.iids).entry(id.clone()).or_insert_with(new_item_id).clone(),
            None => new_item_id(),
        }
    }

    /// Every queued commit is durable (or failed).
    async fn flush(&self) {
        let last = self.seq.load(Ordering::SeqCst);
        let mut done = self.done.clone();
        let _ = done.wait_for(|d| *d >= last).await;
    }
}

/// The compacted record's identities from the loop's report.
fn dropped_of(dropped: &mixdog_agent::env::Dropped) -> crate::session::run::Dropped {
    crate::session::run::Dropped { message_ids: dropped.message_ids.clone(), call_ids: dropped.call_ids.clone() }
}

#[async_trait]
impl TranscriptSink for PortSink {
    fn commit(&self, message: &AgentMessage) -> Ticket {
        let n = self.seq.fetch_add(1, Ordering::SeqCst) + 1;
        let mut row = row_of(message);
        // Node hides a row by what it is: a user row the transcript shows nothing for (a hook or
        // skill note, internal text) is not visible; a card or cancel line is written into its meta.
        // and the row that counts for prompt history carries its display text.
        let (visible, prompt) = if message.role() == Role::User {
            let mut text = mixdog_protocol::message_class::user_text::UserText::new(&*self.blobs);
            mixdog_protocol::message_class::row_facts(&mut row, &mut text).map_or((true, None), |facts| (facts.visible, facts.prompt))
        } else {
            (true, None)
        };
        self.rows.record(message, row.clone());
        if message.role() == Role::Tool {
            if let Some(hook) = &self.on_tool_result {
                hook(&mixdog_agent::agent_tool::flow::seams::ToolResultMessage { ui_diff: message.ui_diff.clone() });
            }
        }
        {
            let mut turn = lock(&self.turn);
            turn.push(message.clone());
            self.live.publish(&turn, &*self.rows);
        }
        let shown = if message.role() == Role::Assistant { lock(&self.streaming).take() } else { None };
        let role = match message.role() {
            Role::System => "system",
            Role::User => "user",
            Role::Assistant => "assistant",
            Role::Tool => "tool",
            Role::Developer => "developer",
        };
        let item = ItemCommit { iid: shown.unwrap_or_else(|| self.iid_of(message)), role: Some(role.to_owned()), model: true, visible, body: row, prompt };
        let _ = self.jobs.send(Job::Commit(n, item));
        Ticket(n)
    }

    fn replace(&self, messages: &[AgentMessage], rewrite: &mixdog_agent::env::Rewrite) {
        let n = self.seq.fetch_add(1, Ordering::SeqCst) + 1;
        let replacement = messages.iter().map(|m| (self.iid_of(m), row_of(m))).collect();
        let compaction = crate::session::run::Compaction { replacement, at: self.clock.now_ms(), dropped_count: rewrite.dropped_count, dropped: rewrite.dropped.as_ref().map(dropped_of) };
        let _ = self.jobs.send(Job::Compact(n, compaction));
    }

    fn message_id(&self) -> String {
        format!("msg_{}", uuid::Uuid::new_v4().simple())
    }

    async fn durable(&self, ticket: Ticket) {
        if ticket.0 == 0 {
            let _ = self.port.input_durable().await;
            return;
        }
        let mut done = self.done.clone();
        let _ = done.wait_for(|d| *d >= ticket.0).await;
    }
}

// ---- the observer ------------------------------------------------------------------------------------

enum Shown {
    Section(crate::session::Section),
    Started(ThreadItem),
    Delta(ItemId, String),
    ReasoningDelta(ItemId, String),
    ReasoningDone(ItemId, String),
    Notice(String),
    Usage(crate::session::UsageReport),
    Compact(mixdog_agent::env::CompactEvent),
}

/// `RunObserver` over progress and the port: stage and stream marks feed the progress cell, shown
/// assistant text becomes `item/started` + `item/agentMessage/delta`.
struct PortObserver {
    progress: Arc<ProgressPublisher>,
    out: mpsc::UnboundedSender<Shown>,
    streaming: Arc<Mutex<Option<ItemId>>>,
    /// The Reasoning item the thinking text streams into, until the model moves on to text,
    /// tool calls or its usage report.
    reasoning: Mutex<Option<(ItemId, String)>>,
}

impl PortObserver {
    fn reasoning(&self, text: String) {
        let id = {
            let mut open = lock(&self.reasoning);
            match open.as_mut() {
                Some((id, all)) => {
                    all.push_str(&text);
                    id.clone()
                }
                None => {
                    let id = new_item_id();
                    *open = Some((id.clone(), text.clone()));
                    let item = ThreadItem::Reasoning { id: id.clone(), summary: Vec::new(), content: Vec::new(), meta: ItemMeta::default() };
                    let _ = self.out.send(Shown::Started(item));
                    id
                }
            }
        };
        let _ = self.out.send(Shown::ReasoningDelta(id, text));
    }

    /// The model moved on (text, tool calls, usage) or the run ended: the open Reasoning item is
    /// complete, with all its thinking text.
    fn end_reasoning(&self) {
        let done = lock(&self.reasoning).take();
        if let Some((id, text)) = done {
            let _ = self.out.send(Shown::ReasoningDone(id, text));
        }
    }
    fn text(&self, text: String) {
        let id = {
            let mut shown = lock(&self.streaming);
            match shown.as_ref() {
                Some(id) => id.clone(),
                None => {
                    let id = new_item_id();
                    *shown = Some(id.clone());
                    let item = ThreadItem::AgentMessage { id: id.clone(), text: MaybeBlob::Inline(String::new()), imported_tool_runs: Vec::new(), meta: ItemMeta::default() };
                    let _ = self.out.send(Shown::Started(item));
                    id
                }
            }
        };
        let _ = self.out.send(Shown::Delta(id, text));
    }
}

impl RunObserver for PortObserver {
    fn event(&self, event: RunEvent) {
        match event {
            RunEvent::Stage(Stage::Connecting) => self.progress.stage("connecting"),
            RunEvent::Stage(Stage::Streaming) => self.progress.stage("streaming"),
            RunEvent::Stage(Stage::WaitingOnProvider) => self.progress.stream_delta(StreamKind::Keepalive),
            RunEvent::Stage(Stage::ApprovalWait { waiting }) => self.progress.approval_wait(waiting),
            RunEvent::TextDelta(text) => {
                self.end_reasoning();
                self.progress.stream_delta(StreamKind::Text);
                self.text(text);
            }
            RunEvent::ReasoningDelta(text) => {
                self.progress.stream_delta(StreamKind::Reasoning);
                self.reasoning(text);
            }
            RunEvent::Stage(Stage::Notice { message }) => {
                let _ = self.out.send(Shown::Notice(message));
            }
            RunEvent::Usage { iteration, usage, delta } => {
                self.end_reasoning();
                let _ = self.out.send(Shown::Usage(crate::session::UsageReport::from_event(iteration, usage, delta)));
            }
            RunEvent::Compact(event) => {
                let _ = self.out.send(Shown::Compact(event));
            }
            // The context reading the footer shows (percent is the session's to derive).
            RunEvent::ContextPressure { used_tokens, .. } => {
                let context = mixdog_app_protocol::v2::thread::ThreadContext { context_tokens: i64::try_from(used_tokens).ok(), ..Default::default() };
                let _ = self.out.send(Shown::Section(crate::session::Section::Context(context)));
            }
            RunEvent::Stage(Stage::ModelFallback { model }) => {
                let route = mixdog_app_protocol::v2::thread::ThreadRoute { session_model: Some(model), ..Default::default() };
                let _ = self.out.send(Shown::Section(crate::session::Section::Route(route)));
            }
            RunEvent::ToolCalls { calls, .. } => {
                self.end_reasoning();
                self.progress.stage("tool_running");
                for call in &calls {
                    self.progress.tool_call(Some(&call.name));
                }
            }
            _ => {}
        }
    }

    fn can_retract(&self) -> bool {
        false
    }

    fn retract_text(&self, _retraction: TextRetraction) -> Retracted {
        Retracted::Refused
    }
}

// ---- the turn ----------------------------------------------------------------------------------------

async fn drive(parts: Arc<dyn RunParts>, run: RunStart) -> RunOutcome {
    let RunStart { thread, turn, input_body, header, port, context, surface, progress, turn_messages, cancel, signal, review, agent_turn, .. } = run;
    let (slot, skill_selection, on_tool_result) = match agent_turn {
        Some(turn) => (turn.slot, turn.skill_selection, Some(turn.hooks.on_tool_result)),
        None => (None, None, None),
    };
    let surface_now = surface.borrow().clone();
    let assembled = match parts.assemble(AssembleInput { thread: &thread, turn: &turn, header: &header, surface: surface_now, port: &port, surface_rx: surface.clone(), slot, skill_selection }).await {
        Ok(assembled) => assembled,
        Err(error) => return RunOutcome::Failed(error),
    };
    let Assembled {
        provider, tools, tool_env, gate, worktree, mut config, clock, decider, guards, compactor, route, skills, hooks, reuse, reactions, reaction_scope: _reaction_scope, rows, tail, step_judge, artifacts, images, blobs, carry,
    } = assembled;
    // The turn's workspace is final: take the baseline in the background; no tool runs before it.
    review.start(&worktree);

    let stored = match context.read().await {
        Ok(stored) => stored,
        Err(error) => return failed(format!("model context unreadable: {error:?}"), Value::Null),
    };
    let input = match message_of(&input_body) {
        Ok(input) => input,
        Err(error) => return failed(format!("the turn's input row is not a model message: {error}"), input_body),
    };
    let live = LiveTurnPublisher::new(turn_messages);
    let streaming = Arc::new(Mutex::new(None));
    let sink = PortSink::spawn(port.clone(), rows.clone(), live, streaming.clone(), clock.clone(), blobs, on_tool_result);
    // The system messages are the header's prompt fields, in Node's order and tiers (WP-PROMPT).
    let mut messages: Vec<AgentMessage> = crate::prompt::blocks::request_system_messages(&header)
        .into_iter()
        .map(|wire| {
            let mut message = AgentMessage::user_content(Content::Text(String::new()));
            message.message = wire;
            message
        })
        .collect();
    for (iid, body) in stored {
        // A stored row the codec cannot read fails the turn: dropping it would change the context.
        let message = match message_of(&body) {
            Ok(message) => message,
            Err(error) => return failed(format!("the model context holds a row this build cannot read: {error}"), body),
        };
        if let Some(id) = &message.message_id {
            lock(&sink.iids).insert(id.clone(), iid);
        }
        rows.record(&message, body);
        messages.push(message);
    }
    rows.record(&input, input_body);
    sink.seed(&input);
    messages.push(input);

    let progress = Arc::new(ProgressPublisher::new(progress, clock.clone()));
    progress.ask_start();
    let (shown_tx, mut shown_rx) = mpsc::unbounded_channel::<Shown>();
    let shown_port = port.clone();
    drop(mixdog_rt::spawn("run-shown", TaskClass::Work, async move {
        while let Some(shown) = shown_rx.recv().await {
            let _ = match shown {
                Shown::Section(section) => shown_port.section(section).await,
                Shown::Started(item) => shown_port.item_started(item).await,
                Shown::Delta(id, text) => shown_port.delta(id, text).await,
                Shown::ReasoningDelta(id, text) => shown_port.reasoning_delta(id, text).await,
                Shown::ReasoningDone(id, text) => shown_port.reasoning_completed(id, text).await,
                Shown::Notice(text) => shown_port.notice(text).await,
                Shown::Usage(report) => shown_port.usage(report).await,
                Shown::Compact(event) => shown_port.compact_event(event).await,
            };
        }
    }));
    let observer = Arc::new(PortObserver { progress: progress.clone(), out: shown_tx, streaming, reasoning: Mutex::new(None) });
    let closing = observer.clone();

    config.thread_id = thread.clone();
    config.turn_id = turn.clone();
    config.signal = Some(signal);
    config.first_request_after = Some(Ticket(0));
    let gate: Arc<dyn ToolGate> = Arc::new(ReviewGate::new(review, gate(GateContext { observer: observer.clone(), cancel: cancel.clone(), guards: guards.clone(), approvals: Arc::new(port.clone()) })));
    let env = RunEnv {
        clock,
        jitter: Arc::new(RandomJitter),
        waiter: Arc::new(TimerWait),
        decider,
        steer: Arc::new(SteerQueue::new(port.clone())),
        observer,
        sink: sink.clone(),
        gate,
        guards,
        compactor,
        route,
        skills,
        hooks,
        reuse,
        reactions,
        tail,
        step_judge,
        artifacts,
        images,
    };
    let result = Run::new(env, cancel.clone(), provider, tools, tool_env, config, messages, carry).run().await;
    closing.end_reasoning();
    match result {
        Ok(output) => {
            // The loop ends on the terminal answer without committing it (Node's turn commit does):
            // history keeps only the terminal segment.
            let mut terminal = output.response.clone();
            if let Some(segment) = &output.response.history_content {
                terminal.content.clone_from(segment);
            }
            if let Some(mut message) = mixdog_agent::response::intermediate_message(&terminal) {
                message.message_id = Some(sink.message_id());
                sink.commit(&message);
            }
            sink.flush().await;
            sink.live.clear();
            progress.done(output.response.content.trim().is_empty());
            if let Some(state) = output.provider_state.clone() {
                let _ = port.save_provider_state(Some(state)).await;
            }
            RunOutcome::Completed(Box::new(mixdog_agent::agent_tool::flow::seams::TurnResult {
                content: output.response.content.clone(),
                report_content: output.response.report_content.clone(),
                termination: output.termination,
                iterations: output.iterations,
                tool_calls_total: output.tool_calls_total,
                stop_reason: output.response.stop.as_ref().map(|s| format!("{s:?}")),
            }))
        }
        Err(failure) => {
            sink.flush().await;
            sink.live.clear();
            if matches!(failure.error, AgentError::Aborted) || cancel.is_cancelled() {
                progress.cancelling();
                return RunOutcome::Interrupted;
            }
            progress.error();
            let data = if failure.carried_report.is_empty() { Value::Null } else { json!({ "carriedReport": failure.carried_report }) };
            failed(failure.error.to_string(), data)
        }
    }
}

#[cfg(test)]
mod tests {
    use std::collections::VecDeque;
    use std::sync::atomic::AtomicI64;
    use std::time::Duration;

    use mixdog_agent::env::{AllowAll, NoGuards};
    use mixdog_core_api::call::CallContext;
    use mixdog_core_api::domain::keepalive::KeepaliveSchedule;
    use mixdog_core_api::domain::mock::{MockApprovalGate, MockCodec, MockFileService, MockProcessManager, MockProgress, MockRetryDecider};
    use mixdog_core_api::domain::provider::{DeliveryState, ModelRequest, ModelStream, ProviderError, StopReason, StreamEvent, ToolCall, WireCodec};
    use mixdog_core_api::domain::retry::RetryPolicy;
    use mixdog_core_api::domain::tool::{SurfaceKind, Tool, ToolAnnotations, ToolContext, ToolIo, ToolOutcome, ToolOutput, ToolPart, ToolSpec};
    use mixdog_core_api::ids::{ConnectionId, Method, OpId};
    use mixdog_core_api::{CoreRequest, Reply, ThreadDirectory, ThreadHandle};
    use mixdog_protocol::{JsonValue, ProviderId};
    use mixdog_store::schema::blob::Slot;
    use mixdog_store::schema::record::Record;

    use super::*;
    use crate::session::testing::Rig;
    use crate::session::SessionDirectory;

    struct Steps(VecDeque<StreamEvent>);

    #[async_trait]
    impl ModelStream for Steps {
        async fn next(&mut self) -> Option<Result<StreamEvent, ProviderError>> {
            self.0.pop_front().map(Ok)
        }
        fn delivery(&self) -> DeliveryState {
            DeliveryState::Accepted
        }
    }

    struct Scripted {
        id: ProviderId,
        policy: RetryPolicy,
        keepalive: KeepaliveSchedule,
        codec: MockCodec,
        script: Mutex<VecDeque<Vec<StreamEvent>>>,
        requests: Mutex<Vec<Arc<ModelRequest>>>,
    }

    #[async_trait]
    impl ProviderAdapter for Scripted {
        fn id(&self) -> &ProviderId {
            &self.id
        }
        fn codec(&self) -> &dyn WireCodec {
            &self.codec
        }
        fn retry_policy(&self) -> &RetryPolicy {
            &self.policy
        }
        fn keepalive(&self) -> &KeepaliveSchedule {
            &self.keepalive
        }
        async fn attempt(&self, request: Arc<ModelRequest>) -> Result<Box<dyn ModelStream>, ProviderError> {
            lock(&self.requests).push(request);
            let steps = lock(&self.script).pop_front().expect("provider script exhausted");
            Ok(Box::new(Steps(steps.into())))
        }
    }

    struct Echo(ToolSpec);

    #[async_trait]
    impl Tool for Echo {
        fn spec(&self) -> &ToolSpec {
            &self.0
        }
        async fn call(&self, _ctx: &ToolContext, args: JsonValue) -> ToolOutcome {
            Ok(ToolOutput { parts: vec![ToolPart::Text(format!("echo:{args}"))], ..ToolOutput::default() })
        }
    }

    struct Fixed;
    impl Clock for Fixed {
        fn now_ms(&self) -> i64 {
            1_700_000_000_000
        }
    }

    struct NoBlobs;
    impl mixdog_protocol::message_class::user_text::Blobs for NoBlobs {
        fn text_within(&self, _: &str, _: u64) -> Result<Option<String>, mixdog_protocol::message_class::user_text::ReadError> {
            Ok(None)
        }
    }

    struct Parts {
        provider: Arc<Scripted>,
        workspace: std::path::PathBuf,
    }

    #[async_trait]
    impl RunParts for Parts {
        async fn assemble(&self, input: AssembleInput<'_>) -> Result<Assembled, TurnError> {
            let spec = ToolSpec {
                name: "echo".into(),
                aliases: Vec::new(),
                description: "echo".into(),
                input_schema: json!({ "type": "object" }),
                annotations: ToolAnnotations { read_only_hint: Some(true), idempotent_hint: Some(true), ..ToolAnnotations::default() },
                parallel_safe: true,
                exclusive_with: Vec::new(),
            };
            let tokens = mixdog_rt::testing::tokens();
            Ok(Assembled {
                provider: self.provider.clone(),
                tools: ToolSet::new(vec![Arc::new(Echo(spec))]),
                tool_env: ToolEnv {
                    thread_id: input.thread.clone(),
                    turn_id: input.turn.clone(),
                    cwd: mixdog_core_api::domain::common::AbsPath::new(self.workspace.clone()).unwrap(),
                    surface: SurfaceKind::Lead,
                    io: ToolIo { interactive: tokens.interactive_io, durability: tokens.durability_io, maintenance: tokens.maintenance_io },
                    approvals: Arc::new(MockApprovalGate::default()),
                    files: Arc::new(MockFileService::default()),
                    processes: Arc::new(MockProcessManager::default()),
                    progress: Arc::new(MockProgress::default()),
                    deadline_of: None,
                },
                gate: Box::new(|_| Arc::new(AllowAll)),
                worktree: self.workspace.to_string_lossy().into_owned(),
                config: RunConfig::new(input.thread.clone(), input.turn.clone(), "m"),
                clock: Arc::new(Fixed),
                decider: Arc::new(MockRetryDecider),
                guards: Arc::new(NoGuards),
                compactor: None,
                route: None,
                skills: None,
                hooks: None,
                reuse: None,
                reactions: None,
                reaction_scope: None,
                rows: Arc::default(),
                tail: None,
                step_judge: None,
                artifacts: None,
                images: None,
                blobs: Arc::new(NoBlobs),
                carry: RunCarry::default(),
            })
        }
    }

    fn request(method: &'static str, params: Value, op: &str) -> CoreRequest {
        CoreRequest {
            method: Method(method),
            params,
            op: Some(OpId::from(op)),
            ctx: CallContext::connection(ConnectionId(1), mixdog_protocol::Origin::Local, mixdog_rt::CancellationToken::new()),
        }
    }

    /// One real turn: the session actor starts it, the factory builds the run, the loop asks the
    /// scripted provider, the tool runs behind the review gate, and the rows settle in the store.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_turn_runs_from_the_factory_through_the_loop_and_a_tool_to_settle() {
        let provider = Arc::new(Scripted {
            id: ProviderId::from("scripted"),
            policy: RetryPolicy::codex_default(),
            keepalive: KeepaliveSchedule::SPEC,
            codec: MockCodec,
            script: Mutex::new(VecDeque::from([
                vec![
                    StreamEvent::TextDelta("looking".into()),
                    StreamEvent::ToolCallDone(ToolCall { id: "c1".into(), name: "echo".into(), arguments: json!({ "a": 1 }), native_type: None }),
                    StreamEvent::Completed { stop: Some(StopReason::ToolUse), pricing_model: None, request_ms: None },
                ],
                vec![StreamEvent::TextDelta("all done".into()), StreamEvent::Completed { stop: Some(StopReason::EndTurn), pricing_model: None, request_ms: None }],
            ])),
            requests: Mutex::new(Vec::new()),
        });
        let workspace = tempfile::tempdir().unwrap();
        let rig = Rig::new();
        let mut deps = rig.deps_parts(rig.store.clone());
        deps.runs = Arc::new(RunHostFactory::new(Arc::new(Parts { provider: provider.clone(), workspace: workspace.path().to_path_buf() })));
        let directory = SessionDirectory::new(Arc::new(deps));
        let reply = directory.request(request("thread/start", json!({ "opId": "op-start", "kind": "task", "projectPath": "/ws" }), "op-start")).await.expect("thread/start");
        let Reply::Subscribe(subscribe) = reply else { panic!("thread/start subscribes") };
        let id = ThreadId::from(subscribe.result["thread"]["id"].as_str().expect("thread id"));
        let handle = directory.handle(&id).expect("loaded");
        let started = handle
            .request(request("turn/start", json!({ "threadId": id, "opId": "op-1", "input": { "prompt": "go" } }), "op-1"))
            .await
            .expect("turn/start");
        let Reply::Value(started) = started else { panic!("turn/start answers a value") };
        assert_eq!(started["kind"], "started");

        let roles = || -> Vec<(String, Value)> {
            rig.store
                .records(&id)
                .into_iter()
                .filter_map(|(_, record)| match record {
                    Record::Item(item) => match item.body {
                        Slot::Inline(body) => Some((body["role"].as_str().unwrap_or_default().to_owned(), body)),
                        _ => None,
                    },
                    _ => None,
                })
                .collect()
        };
        let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
        while roles().len() < 4 {
            assert!(tokio::time::Instant::now() < deadline, "the turn did not settle: requests={} {:?}", lock(&provider.requests).len(), roles().iter().map(|r| r.0.clone()).collect::<Vec<_>>());
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        let rows = roles();
        assert_eq!(rows.iter().map(|(role, _)| role.as_str()).collect::<Vec<_>>(), ["user", "assistant", "tool", "assistant"]);
        assert_eq!(rows[1].1["content"], "looking");
        assert_eq!(rows[1].1["toolCalls"][0]["name"], "echo");
        assert_eq!(rows[2].1["toolCallId"], "c1");
        assert_eq!(rows[2].1["content"], "echo:{\"a\":1}");
        assert_eq!(rows[3].1["content"], "all done");
        let requests = lock(&provider.requests).clone();
        assert_eq!(requests.len(), 2);
        let second: Vec<_> = requests[1].messages.iter().map(|m| m.role).collect();
        assert_eq!(second, [Role::User, Role::Assistant, Role::Tool]);
        let _ = AtomicI64::new(0);
    }
}