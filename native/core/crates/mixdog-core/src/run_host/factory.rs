//! The real [`RunFactory`]: a session turn (`RunStart`) becomes a `mixdog-agent` run and its
//! outcome (`RunOutcome`).
//!
//! What a turn needs that only the host knows is gathered in [`RunParts::assemble`] (each field of
//! [`Assembled`] names its owner); everything that follows from the `RunStart` itself is built
//! here: the cancel signal, the turn review and its gate, the model context and its stored rows,
//! the commit sink, the steering queue, the observer, progress and live-turn publishing, and the
//! outcome.

use std::collections::HashMap;
use super::failed_turn_rewind;
use std::future::Future;
use std::pin::Pin;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use mixdog_agent::env::{
    Clock, Compactor, Reactions, ResultReuse, RouteFallback, RunEnv, RunEvent, RunObserver, SkillSelector, Stage, TailReminder, TextRetraction, Retracted, Ticket, ToolGate,
    ToolHooks, TranscriptSink, TurnGuards,
};
use mixdog_agent::compact::blob_reads::with_blobs;
use mixdog_agent::env::CommitError;
use mixdog_agent::message::AgentMessage;
use mixdog_agent::tools::{ToolEnv, ToolSet};
use mixdog_agent::{AgentError, Run, RunCarry, RunConfig};
use mixdog_core_api::domain::provider::{Content, ProviderAdapter, Role};
use mixdog_core_api::domain::retry::RetryDecider;
use mixdog_core_api::ids::{ItemId, ThreadId, TurnId};
use mixdog_protocol::message_class::row_facts;
use mixdog_protocol::message_class::user_text::UserText;
use mixdog_protocol::{ItemMeta, MaybeBlob, ThreadItem, TurnError};
use mixdog_rt::TaskClass;
use mixdog_tools::policy::SessionSurface;
use serde_json::{json, Value};
use tokio::sync::{mpsc, watch};

use super::live_turn::LiveTurnPublisher;
use super::watchdog::Watchdog;
use mixdog_agent::agent_tool::watchdog::{is_watchdog_abort, resolve_policy, AgentKind, Overrides};
use super::message_row::{message_of, row_of};
use mixdog_core_run::run_host::progress::ProgressPublisher;
use mixdog_core_run::run_host::progress::StreamKind;
use super::retry::{RandomJitter, TimerWait};
use super::steer::SteerQueue;
use super::tool_progress::{RunToolProgress, ToolHints};
use mixdog_core_session::session::turn_snapshot::ReviewGate;
use mixdog_core_session::session::ItemCommit;
use mixdog_core_session::session::RunFactory;
use mixdog_core_session::session::RunOutcome;
use mixdog_core_session::session::RunPort;
use mixdog_core_session::session::RunStart;
use mixdog_core_session::session::StoredRows;

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
    /// The session's stored rows before the turn's input.
    pub prior: &'a [Value],
    /// The turn's prompt text, trimmed.
    pub request: &'a str,
    /// A runtime-injected turn (a completion notice, queued work), not a user's prompt.
    pub injected: bool,
    /// The worker turn's own completion hook (`AgentTurn.hooks.notify`): `assemble` puts it on the
    /// `ToolEnv`, so it reaches every tool call. `None` for a turn no job owns.
    pub notify: Option<mixdog_core_api::domain::tool::ToolNotify>,
    /// Where the run's tools report progress: `ToolEnv.progress` (the run's own sink, built by the
    /// factory over the session cell's progress value).
    pub progress: Arc<dyn mixdog_core_api::domain::tool::ProgressSink>,
}

/// What the policy gate needs from the run it gates, which exists only after assembly.
pub struct GateContext {
    pub observer: Arc<dyn RunObserver>,
    pub cancel: tokio_util::sync::CancellationToken,
    pub guards: Arc<dyn TurnGuards>,
    pub approvals: Arc<dyn mixdog_core_api::domain::approval::ApprovalGate>,
}

/// What the explicit skill selector needs from the run it serves, which exists only after assembly.
pub struct SkillContext {
    pub gate: Arc<dyn ToolGate>,
    pub env: ToolEnv,
    pub cancel: tokio_util::sync::CancellationToken,
}

/// Builds the turn's skill selector from the run's gate, environment and token.
pub type SkillsBuilder = Box<dyn FnOnce(SkillContext) -> Arc<dyn SkillSelector> + Send>;

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
    pub skills: Option<SkillsBuilder>,
    pub hooks: Option<Arc<dyn ToolHooks>>,
    pub reuse: Option<Arc<dyn ResultReuse>>,
    pub reactions: Option<Arc<dyn Reactions>>,
    /// Clears the session's react targets when the turn ends, however it ends.
    pub reaction_scope: Option<super::reactions::ReactionScope>,
    /// The run's stored bodies, empty: the factory registers the turn's context and commits in
    /// it; `reactions` reads its message facts from the same value.
    pub rows: Arc<StoredRows>,
    pub tail: Option<Arc<dyn TailReminder>>,
    pub side: Option<Arc<dyn mixdog_agent::env::SendTap>>,
    pub step_judge: Option<Arc<dyn mixdog_agent::step_effort::StepEffortJudge>>,
    pub artifacts: Option<Arc<dyn mixdog_agent::offload::ArtifactStore>>,
    pub images: Option<Arc<dyn mixdog_agent::offload::ImageCompactor>>,
    /// The attachment blob reader, for the display facts of a user row (a pasted text's body).
    pub blobs: Arc<dyn mixdog_agent::compact::blob_reads::BlobReads>,
    /// The guard state that outlives one ask (the session record).
    pub carry: RunCarry,
}

#[async_trait]
pub trait RunParts: Send + Sync + 'static {
    /// The turn's host parts; a refusal fails the turn with its error.
    async fn assemble(&self, input: AssembleInput<'_>) -> Result<Assembled, TurnError>;

    /// `reconcileTurnSettings`: the header the turn is built from, once the thread's settings follow the
    /// live ones (`conversation`: the thread already holds one, so it keeps its prefix; `header` is what
    /// the turn started with).
    async fn reconcile_turn(&self, thread: &ThreadId, header: mixdog_store::schema::record::Header, conversation: bool) -> Result<mixdog_store::schema::record::Header, TurnError>;

    /// `getHiddenAgent(agent).stallCap.idleSeconds`: an internal agent's own idle budget, which
    /// the progress watchdog honours.
    fn stall_cap_idle_seconds(&self, _agent: Option<&str>) -> Option<i64> {
        None
    }

    /// `readAgentFirstResponseTimeoutMs(agent)`: the agent definition's own first-response
    /// deadline for the progress watchdog.
    async fn first_response_timeout_ms(&self, _agent: &str) -> Option<i64> {
        None
    }

    /// `armTurnShellReap` / `reapTurnShellJobs`: the progress watchdog stopped the turn, so the
    /// background shells it started at or after `since_ms` are stopped with it.
    fn reap_turn_shells(&self, _thread: &ThreadId, _since_ms: i64) {}

    /// `resetTurnShellReap`: a new turn owns the thread; nothing earlier is reported for it.
    fn reset_turn_shells(&self, _thread: &ThreadId) {}
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

pub(super) fn new_item_id() -> ItemId {
    ItemId::from(format!("itm_{}", uuid::Uuid::new_v4().simple()))
}

fn failed(message: impl Into<String>, data: Value) -> RunOutcome {
    RunOutcome::Failed(TurnError { message: message.into(), data, provider_error: None })
}

// ---- the commit sink ---------------------------------------------------------------------------------

enum Job {
    Commit(u64, ItemCommit),
    Compact(u64, mixdog_core_session::session::run::Compaction),
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
    blobs: Arc<dyn mixdog_agent::compact::blob_reads::BlobReads>,
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
        blobs: Arc<dyn mixdog_agent::compact::blob_reads::BlobReads>,
        on_tool_result: Option<Arc<dyn Fn(&mixdog_agent::agent_tool::flow::seams::ToolResultMessage) + Send + Sync>>,
    ) -> Arc<Self> {
        let (jobs, mut queue) = mpsc::unbounded_channel::<Job>();
        let (done_tx, done) = watch::channel(0u64);
        let worker = port.clone();
        drop(mixdog_rt::spawn("run-commit", TaskClass::Work, async move {
            while let Some(job) = queue.recv().await {
                let n = match job {
                    Job::Commit(n, item) => {
                        // Node logs a failed session save and goes on (`ask-turn-state.mjs:107`, `session-lifecycle.mjs:522`).
                        if let Err(error) = worker.commit_item(item).await {
                            tracing::warn!("[session] message save failed: {error:?}");
                        }
                        n
                    }
                    Job::Compact(n, compaction) => {
                        if let Err(error) = worker.compacted(compaction).await {
                            tracing::warn!("[session] compaction save failed: {error:?}");
                        }
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
fn dropped_of(dropped: &mixdog_agent::env::Dropped) -> mixdog_core_session::session::run::Dropped {
    mixdog_core_session::session::run::Dropped { message_ids: dropped.message_ids.clone(), call_ids: dropped.call_ids.clone() }
}

#[async_trait]
impl TranscriptSink for PortSink {
    async fn commit(&self, message: &AgentMessage) -> Result<Ticket, CommitError> {
        let row = row_of(message);
        // Node hides a row by what it is: a user row the transcript shows nothing for (a hook or
        // skill note, internal text) is not visible; a card or cancel line is written into its meta.
        // and the row that counts for prompt history carries its display text.
        let (row, visible, prompt) = if message.role() == Role::User {
            // The facts read the attachment store (paste line counts, offloaded prompt bodies): the
            // read runs on the store's lane and this task awaits its answer.
            let lane_row = row.clone();
            let read = with_blobs(&*self.blobs, move |blobs| {
                let mut classified = lane_row;
                let facts = row_facts(&mut classified, &mut UserText::new(blobs));
                (classified, facts)
            })
            .await;
            // A store that cannot run the read is an error of the commit: nothing is queued.
            let (row, facts) = read.map_err(|_| CommitError::StoreUnavailable)?;
            let (visible, prompt) = facts.map_or((true, None), |facts| (facts.visible, facts.prompt));
            (row, visible, prompt)
        } else {
            (row, true, None)
        };
        let n = self.seq.fetch_add(1, Ordering::SeqCst) + 1;
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
        Ok(Ticket(n))
    }

    fn replace(&self, messages: &[AgentMessage], rewrite: &mixdog_agent::env::Rewrite) {
        let n = self.seq.fetch_add(1, Ordering::SeqCst) + 1;
        let replacement = messages.iter().map(|m| (self.iid_of(m), row_of(m))).collect();
        let compaction = mixdog_core_session::session::run::Compaction { replacement, at: self.clock.now_ms(), dropped_count: rewrite.dropped_count, dropped: rewrite.dropped.as_ref().map(dropped_of) };
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
    Section(mixdog_core_ports::ports::threads::Section),
    Started(ThreadItem),
    Delta(ItemId, String),
    ReasoningDelta(ItemId, String),
    ReasoningDone(ItemId, String),
    Notice(String, mixdog_agent::env::Tone),
    Usage(mixdog_core_session::session::UsageReport),
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
            RunEvent::Stage(Stage::Notice { message, tone }) => {
                let _ = self.out.send(Shown::Notice(message, tone));
            }
            RunEvent::Usage { iteration, usage, delta } => {
                self.end_reasoning();
                let _ = self.out.send(Shown::Usage(mixdog_core_session::session::UsageReport::from_event(iteration, usage, delta)));
            }
            RunEvent::Compact(event) => {
                let _ = self.out.send(Shown::Compact(event));
            }
            // The context reading the footer shows (percent is the session's to derive).
            RunEvent::ContextPressure { used_tokens, .. } => {
                let context = mixdog_app_protocol::v2::thread::ThreadContext { context_tokens: i64::try_from(used_tokens).ok(), ..Default::default() };
                let _ = self.out.send(Shown::Section(mixdog_core_ports::ports::threads::Section::Context(context)));
            }
            RunEvent::Stage(Stage::ModelFallback { model }) => {
                let route = mixdog_app_protocol::v2::thread::ThreadRoute { session_model: Some(model), ..Default::default() };
                let _ = self.out.send(Shown::Section(mixdog_core_ports::ports::threads::Section::Route(route)));
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

/// `promptContentText(input.prompt).trim()`: a string, or the text parts joined by a newline.
fn prompt_text(body: &Value) -> String {
    match body.get("content") {
        Some(Value::String(text)) => text.trim().to_owned(),
        Some(Value::Array(parts)) => parts.iter().filter_map(|p| p.get("text").and_then(Value::as_str)).collect::<Vec<_>>().join("\n").trim().to_owned(),
        _ => String::new(),
    }
}
/// The request's system messages: the header's prompt fields, in Node's order and tiers (WP-PROMPT).
pub(crate) fn system_messages(header: &mixdog_store::schema::record::Header) -> Vec<AgentMessage> {
    mixdog_core_prompt::prompt::blocks::request_system_messages(header)
        .into_iter()
        .map(|wire| {
            let mut message = AgentMessage::user_content(Content::Text(String::new()));
            message.message = wire;
            message
        })
        .collect()
}

async fn drive(parts: Arc<dyn RunParts>, run: RunStart) -> RunOutcome {
    let RunStart { thread, turn, input_body, header, port, context, surface, progress, turn_messages, cancel, signal, review, agent_turn, unattended, skill_selection: routine_selection, input: submitted, input_item, .. } = run;
    let (slot, skill_selection, on_tool_result, notify) = match agent_turn {
        Some(turn) => {
            let hook = turn.hooks.notify;
            let notify = mixdog_core_api::domain::tool::ToolNotify(Arc::new(move |text, meta| hook(text, meta)));
            (turn.slot, turn.skill_selection, Some(turn.hooks.on_tool_result), Some(notify))
        }
        None => (None, routine_selection, None, None),
    };
    parts.reset_turn_shells(&thread);
    let hints = ToolHints::start(progress.subscribe(), port.clone());
    let watched = progress.subscribe();
    let tool_progress = RunToolProgress::new(progress.clone());
    let mut stored = match context.read().await {
        Ok(stored) => stored,
        Err(error) => return failed(format!("model context unreadable: {error:?}"), Value::Null),
    };
    let request = prompt_text(&input_body);
    // A failed-turn retry starts without the stale copy of its prompt (`prepareAskTurn`). The
    // context is restarted durably (the chained provider state re-baselines with it), at the rows
    // that remain and this run's input, so the next turn reads the prompt once.
    match failed_turn_rewind::rewound(&mut stored, submitted.options.as_ref(), &request) {
        Ok(true) => {
            let mut restart = stored.clone();
            restart.push((input_item.clone(), input_body.clone()));
            if port.context_rewound(restart).await.is_err() {
                return failed("the failed prompt could not be removed from the model context", Value::Null);
            }
        }
        Ok(false) => {}
        Err(text) => return failed(text, Value::Null),
    }
    let prior: Vec<Value> = stored.iter().map(|(_, body)| body.clone()).collect();
    let injected = input_body.pointer("/meta/source").is_some_and(Value::is_string);
    // Node's `await reconcileTurnSettings()` of the turn preparation: a gate that moved since the last turn
    // reaches this one through the header, before the request is assembled.
    let header = match parts.reconcile_turn(&thread, header, mixdog_core_session::session::thread_settings::has_conversation_messages(&prior)).await {
        Ok(header) => header,
        Err(error) => return RunOutcome::Failed(error),
    };
    let surface_now = surface.borrow().clone();
    let assembled = match parts.assemble(AssembleInput { thread: &thread, turn: &turn, header: &header, surface: surface_now, port: &port, surface_rx: surface.clone(), slot, skill_selection, prior: &prior, request: &request, injected, notify, progress: tool_progress }).await {
        Ok(assembled) => assembled,
        Err(error) => return RunOutcome::Failed(error),
    };
    let Assembled {
        provider, tools, tool_env, gate, worktree, mut config, clock, decider, guards, compactor, route, skills, hooks, reuse, reactions, reaction_scope: _reaction_scope, rows, tail, side, step_judge, artifacts, images, blobs, carry,
    } = assembled;
    // The turn's workspace is final: take the baseline in the background; no tool runs before it.
    review.start(&worktree);

    let input = match message_of(&input_body) {
        Ok(input) => input,
        Err(error) => return failed(format!("the turn's input row is not a model message: {error}"), input_body),
    };
    let live = LiveTurnPublisher::new(turn_messages);
    let streaming = Arc::new(Mutex::new(None));
    let sink = PortSink::spawn(port.clone(), rows.clone(), live, streaming.clone(), clock.clone(), blobs, on_tool_result);
    // The system messages are the header's prompt fields, in Node's order and tiers (WP-PROMPT).
    let mut messages = system_messages(&header);
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
    let asked_at = clock.now_ms();
    // The progress watchdog judges the model work from the ask on, and only a run no person is
    // attached to (Node arms it per worker turn once the ask has started).
    let watchdog = if unattended {
        let agent = header.get("agent").and_then(Value::as_str).filter(|name| !name.is_empty());
        let model = header.get("model").and_then(Value::as_str).unwrap_or_default();
        let budget = provider.first_response_budget(model, header.get("modelParameters").filter(|parameters| parameters.is_object()));
        // `agentWatchdogOverrides`: the agent definition's first-response deadline and the routed
        // model's first-response budget.
        let overrides = Overrides {
            first_transport_timeout_ms: match agent {
                Some(name) => parts.first_response_timeout_ms(name).await,
                None => None,
            },
            provider_first_byte_timeout_ms: budget.map(|b| b.transport_ms),
            provider_first_output_timeout_ms: budget.map(|b| b.semantic_ms),
            ..Overrides::default()
        };
        let kind = AgentKind { name: agent, hidden: config.hidden_agent, stall_cap_idle_seconds: parts.stall_cap_idle_seconds(agent) };
        let policy = resolve_policy(kind, overrides, &|name: &str| std::env::var(name).ok());
        let (reaper, reaped_thread) = (parts.clone(), thread.clone());
        Watchdog::arm(true, policy, signal.clone(), clock.clone(), move |now| watched.borrow().snapshot(now), move || reaper.reap_turn_shells(&reaped_thread, asked_at))
    } else {
        None
    };
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
                Shown::Notice(text, tone) => shown_port.notice(text, tone).await,
                Shown::Usage(report) => shown_port.usage(report).await,
                Shown::Compact(event) => shown_port.compact_event(event).await,
            };
        }
    }));
    let observer = Arc::new(PortObserver { progress: progress.clone(), out: shown_tx, streaming, reasoning: Mutex::new(None) });
    let closing = observer.clone();

    config.thread_id = thread.clone();
    config.turn_id = turn.clone();
    config.signal = Some(signal.clone());
    config.first_request_after = Some(Ticket(0));
    let gate: Arc<dyn ToolGate> = Arc::new(ReviewGate::new(review, gate(GateContext { observer: observer.clone(), cancel: cancel.clone(), guards: guards.clone(), approvals: Arc::new(port.clone()) })));
    let skills = skills.map(|build| build(SkillContext { gate: gate.clone(), env: tool_env.clone(), cancel: cancel.clone() }));
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
        side,
        step_judge,
        artifacts,
        images,
    };
    // Node's `_api_call_with_interrupt` spans `agentLoop`: an abort inside reads "during call".
    progress.model_loop(true);
    let result = Run::new(env, cancel.clone(), provider, tools, tool_env, config, messages, carry).run().await;
    progress.model_loop(false);
    // The model work is over: the watchdog, which judges only that, stops here.
    drop(watchdog);
    closing.end_reasoning();
    // No hint is published once the run's outcome is on its way: the run owns the runtime section.
    hints.finish().await;
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
                if let Err(error) = sink.commit(&message).await {
                    sink.flush().await;
                    sink.live.clear();
                    progress.error();
                    return failed(error.to_string(), Value::Null);
                }
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
            // The watchdog's abort is a stalled failure, not a user's interrupt: its sentence is
            // the error, and the partial output the sink just flushed goes to the owner.
            if signal.is_aborted() && is_watchdog_abort(&signal.reason()) {
                // The turn has unwound: sweep what it registered while stopping (`reapTurnShellJobs`).
                parts.reap_turn_shells(&thread, asked_at);
                progress.error();
                return failed(signal.reason(), Value::Null);
            }
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
    use mixdog_core_api::domain::mock::{MockApprovalGate, MockCodec, MockFileService, MockProcessManager, MockRetryDecider};
    use mixdog_core_api::domain::provider::{DeliveryState, ModelRequest, ModelStream, ProviderError, StopReason, StreamEvent, ToolCall, WireCodec};
    use mixdog_core_api::domain::retry::RetryPolicy;
    use mixdog_core_api::domain::tool::{SurfaceKind, Tool, ToolAnnotations, ToolContext, ToolIo, ToolOutcome, ToolOutput, ToolPart, ToolSpec};
    use mixdog_core_api::ids::{ConnectionId, Method, OpId};
    use mixdog_core_api::{CoreRequest, Reply, ThreadDirectory, ThreadHandle};
    use mixdog_protocol::{JsonValue, ProviderId};
    use mixdog_store::schema::blob::Slot;
    use mixdog_store::schema::record::Record;

    use super::*;
    use mixdog_core_session::session::testing::Rig;
    use mixdog_core_session::session::SessionDirectory;

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
        /// The next attempt is refused (a failed turn); it clears as it fires.
        fail_first: std::sync::atomic::AtomicBool,
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
            if self.fail_first.swap(false, std::sync::atomic::Ordering::SeqCst) {
                return Err(ProviderError::new(mixdog_core_api::domain::provider::ErrorKind::InvalidRequest, DeliveryState::NotSent));
            }
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

    #[async_trait]
    impl mixdog_agent::compact::blob_reads::BlobReads for NoBlobs {
        async fn read_with(&self, work: mixdog_agent::compact::blob_reads::StoreWork) -> Result<(), mixdog_agent::compact::blob_reads::StoreUnavailable> {
            work(self);
            Ok(())
        }
    }

    struct Parts {
        provider: Arc<Scripted>,
        workspace: std::path::PathBuf,
        /// Tools beside `echo`.
        more: Vec<Arc<dyn Tool>>,
        /// A key the settings reconcile adds to the header, and the headers the turns were assembled from.
        settle: Option<Arc<Settle>>,
    }

    struct Settle {
        add: (&'static str, Value),
        seen: Mutex<Vec<mixdog_store::schema::record::Header>>,
    }

    #[async_trait]
    impl RunParts for Parts {
        async fn reconcile_turn(&self, _: &ThreadId, mut header: mixdog_store::schema::record::Header, _: bool) -> Result<mixdog_store::schema::record::Header, TurnError> {
            if let Some(settle) = &self.settle {
                header.insert(settle.add.0.to_owned(), settle.add.1.clone());
            }
            Ok(header)
        }

        async fn assemble(&self, input: AssembleInput<'_>) -> Result<Assembled, TurnError> {
            if let Some(settle) = &self.settle {
                lock(&settle.seen).push(input.header.clone());
            }
            let spec = ToolSpec {
                name: "echo".into(),
                title: None,
                trigger: None,
                public: true,
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
                tools: ToolSet::new(std::iter::once(Arc::new(Echo(spec)) as Arc<dyn Tool>).chain(self.more.iter().cloned()).collect()),
                tool_env: ToolEnv {
                    thread_id: input.thread.clone(),
                    turn_id: input.turn.clone(),
                    cwd: mixdog_core_api::domain::common::AbsPath::new(self.workspace.clone()).unwrap(),
                    surface: SurfaceKind::Lead,
                    io: ToolIo { interactive: tokens.interactive_io, durability: tokens.durability_io, maintenance: tokens.maintenance_io },
                    approvals: Arc::new(MockApprovalGate::default()),
                    files: Arc::new(MockFileService::default()),
                    processes: Arc::new(MockProcessManager::default()),
                    progress: input.progress.clone(),
                    deadline_of: None,
                    notify: input.notify.clone(),
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
                side: None,
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
            fail_first: std::sync::atomic::AtomicBool::new(false),
        });
        let workspace = tempfile::tempdir().unwrap();
        let rig = Rig::new();
        let mut deps = rig.deps_parts(rig.store.clone());
        deps.runs = Arc::new(RunHostFactory::new(Arc::new(Parts { provider: provider.clone(), workspace: workspace.path().to_path_buf(), more: Vec::new(), settle: None })));
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
        // Woken by each step of the thread's actor, which acknowledges each row after the store holds
        // it; registered before the check so a step in between is not missed. No clock judges it.
        loop {
            let stepped = handle.stepped().notified();
            tokio::pin!(stepped);
            stepped.as_mut().enable();
            if roles().len() >= 4 {
                break;
            }
            stepped.await;
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

    /// A turn is assembled from the header the settings reconcile returns, not the one it started
    /// with: a gate that moved since the last turn reaches the request (`await reconcileTurnSettings()`).
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_turn_is_assembled_from_the_reconciled_header() {
        let provider = Arc::new(Scripted {
            id: ProviderId::from("scripted"),
            policy: RetryPolicy::codex_default(),
            keepalive: KeepaliveSchedule::SPEC,
            codec: MockCodec,
            script: Mutex::new(VecDeque::from([vec![StreamEvent::TextDelta("ok".into()), StreamEvent::Completed { stop: Some(StopReason::EndTurn), pricing_model: None, request_ms: None }]])),
            requests: Mutex::new(Vec::new()),
            fail_first: std::sync::atomic::AtomicBool::new(false),
        });
        let workspace = tempfile::tempdir().unwrap();
        let rig = Rig::new();
        let settle = Arc::new(Settle { add: ("featureDeniedTools", json!(["web_search"])), seen: Mutex::default() });
        let mut deps = rig.deps_parts(rig.store.clone());
        deps.runs = Arc::new(RunHostFactory::new(Arc::new(Parts { provider: provider.clone(), workspace: workspace.path().to_path_buf(), more: Vec::new(), settle: Some(settle.clone()) })));
        let directory = SessionDirectory::new(Arc::new(deps));
        let reply = directory.request(request("thread/start", json!({ "opId": "op-start", "kind": "task", "projectPath": "/ws" }), "op-start")).await.expect("thread/start");
        let Reply::Subscribe(subscribe) = reply else { panic!("thread/start subscribes") };
        let id = ThreadId::from(subscribe.result["thread"]["id"].as_str().expect("thread id"));
        let handle = directory.handle(&id).expect("loaded");
        handle.request(request("turn/start", json!({ "threadId": id, "opId": "op-1", "input": { "prompt": "go" } }), "op-1")).await.expect("turn/start");
        loop {
            let stepped = handle.stepped().notified();
            tokio::pin!(stepped);
            stepped.as_mut().enable();
            let answered = rig.store.records(&id).into_iter().any(|(_, record)| matches!(record, Record::Item(item) if matches!(&item.body, Slot::Inline(body) if body["role"] == "assistant")));
            if answered {
                break;
            }
            stepped.await;
        }
        let seen = lock(&settle.seen).clone();
        assert_eq!(seen.len(), 1);
        assert_eq!(seen[0]["featureDeniedTools"], json!(["web_search"]));
    }
    /// A failed turn's retry removes the stale copy of its prompt from the model context for good
    /// (`prepareAskTurn`): the retry's own request and the next turn's both carry the prompt once,
    /// while the transcript keeps every row it showed.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_retried_prompt_is_in_the_next_turns_model_context_once() {
        let done = |text: &str| vec![StreamEvent::TextDelta(text.into()), StreamEvent::Completed { stop: Some(StopReason::EndTurn), pricing_model: None, request_ms: None }];
        let provider = Arc::new(Scripted {
            id: ProviderId::from("scripted"),
            policy: RetryPolicy::codex_default(),
            keepalive: KeepaliveSchedule::SPEC,
            codec: MockCodec,
            script: Mutex::new(VecDeque::from([done("fixed"), done("welcome")])),
            requests: Mutex::new(Vec::new()),
            fail_first: std::sync::atomic::AtomicBool::new(true),
        });
        let workspace = tempfile::tempdir().unwrap();
        let rig = Rig::new();
        let mut deps = rig.deps_parts(rig.store.clone());
        deps.runs = Arc::new(RunHostFactory::new(Arc::new(Parts { provider: provider.clone(), workspace: workspace.path().to_path_buf(), more: Vec::new(), settle: None })));
        let directory = SessionDirectory::new(Arc::new(deps));
        let reply = directory.request(request("thread/start", json!({ "opId": "op-start", "kind": "task", "projectPath": "/ws" }), "op-start")).await.expect("thread/start");
        let Reply::Subscribe(subscribe) = reply else { panic!("thread/start subscribes") };
        let id = ThreadId::from(subscribe.result["thread"]["id"].as_str().expect("thread id"));
        let handle = directory.handle(&id).expect("loaded");
        let ended = || {
            rig.store
                .records(&id)
                .into_iter()
                .filter(|(_, record)| matches!(record, Record::Run(run) if matches!(run.phase, mixdog_store::schema::record::RunPhase::Completed | mixdog_store::schema::record::RunPhase::Failed)))
                .count()
        };
        let turn = |input: Value, op: &str, want: usize| {
            let (handle, op, thread) = (handle.clone(), op.to_owned(), id.clone());
            let ended = &ended;
            async move {
                let started = handle.request(request("turn/start", json!({ "threadId": thread, "opId": op, "input": input }), &op)).await.expect("turn/start");
                let Reply::Value(started) = started else { panic!("turn/start answers a value") };
                // The previous turn's run is over once its record is written, but its settlement
                // (the Goal runtime's `turn_settled`) is not: a prompt arriving in between is
                // queued behind it and starts when it is done, with the options it was sent with.
                // Node queues the same way (`drain.mjs` runs the queue only after `runTurn` returns),
                // so both answers are right; the first turn, on an idle thread, can only start.
                let kind = started["kind"].as_str().expect("turn/start names its answer");
                assert!(kind == "queued" && want > 1 || kind == "started", "turn {op}: {started}");
                // Woken by each step of the thread's actor, which is where a run's end is acknowledged
                // after its record is stored; registered before the check so a step in between is not
                // missed. The wait is not judged by the clock.
                loop {
                    let stepped = handle.stepped().notified();
                    tokio::pin!(stepped);
                    stepped.as_mut().enable();
                    if ended() >= want {
                        break;
                    }
                    stepped.await;
                }
            }
        };
        turn(json!({ "prompt": "fix it" }), "op-1", 1).await;
        assert!(lock(&provider.requests).is_empty(), "the first attempt was refused");
        turn(json!({ "prompt": "fix it", "options": { "retryFailedTurn": true } }), "op-2", 2).await;
        turn(json!({ "prompt": "thanks" }), "op-3", 3).await;

        let prompts_of = |request: &ModelRequest| request.messages.iter().filter(|m| m.role == Role::User && format!("{:?}", m.content).contains("fix it")).count();
        let requests = lock(&provider.requests).clone();
        assert_eq!(requests.len(), 2, "the retry and the next turn each asked once");
        assert_eq!(prompts_of(&requests[0]), 1, "the retry's request carries the prompt once");
        assert_eq!(prompts_of(&requests[1]), 1, "the next turn's request carries it once, not the failed copy and the retry's");
        assert_eq!(requests[1].messages.iter().map(|m| m.role).collect::<Vec<_>>(), [Role::User, Role::Assistant, Role::User]);
        let transcript_prompts = rig
            .store
            .records(&id)
            .into_iter()
            .filter(|(_, record)| matches!(record, Record::Item(item) if item.visible && matches!(&item.body, Slot::Inline(body) if body["content"] == "fix it")))
            .count();
        assert_eq!(transcript_prompts, 2, "the transcript keeps the failed prompt beside the retry's");
    }

    /// A tool that reports its output through `ctx.progress`, then waits to be released.
    struct Reporter {
        spec: ToolSpec,
        reported: Arc<tokio::sync::Notify>,
        release: Arc<tokio::sync::Notify>,
    }

    #[async_trait]
    impl Tool for Reporter {
        fn spec(&self) -> &ToolSpec {
            &self.spec
        }
        async fn call(&self, ctx: &ToolContext, _args: JsonValue) -> ToolOutcome {
            ctx.progress.progress(mixdog_core_api::domain::tool::ToolProgress::Output(b"compiling".to_vec()));
            self.reported.notify_one();
            self.release.notified().await;
            Ok(ToolOutput { parts: vec![ToolPart::Text("built".into())], ..ToolOutput::default() })
        }
    }

    /// A tool's progress reaches the thread's clients: the run's sink writes the cell's progress,
    /// the hint is published as the runtime section while the tool runs, and it is withdrawn when
    /// the turn moves on.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_running_tools_output_is_published_to_the_threads_clients_and_withdrawn_after() {
        let provider = Arc::new(Scripted {
            id: ProviderId::from("scripted"),
            policy: RetryPolicy::codex_default(),
            keepalive: KeepaliveSchedule::SPEC,
            codec: MockCodec,
            script: Mutex::new(VecDeque::from([
                vec![
                    StreamEvent::ToolCallDone(ToolCall { id: "c1".into(), name: "report".into(), arguments: json!({}), native_type: None }),
                    StreamEvent::Completed { stop: Some(StopReason::ToolUse), pricing_model: None, request_ms: None },
                ],
                vec![StreamEvent::TextDelta("ok".into()), StreamEvent::Completed { stop: Some(StopReason::EndTurn), pricing_model: None, request_ms: None }],
            ])),
            requests: Mutex::new(Vec::new()),
            fail_first: std::sync::atomic::AtomicBool::new(false),
        });
        let (reported, release) = (Arc::new(tokio::sync::Notify::new()), Arc::new(tokio::sync::Notify::new()));
        let reporter = Reporter {
            spec: ToolSpec {
                name: "report".into(),
                title: None,
                trigger: None,
                public: true,
                aliases: Vec::new(),
                description: "report".into(),
                input_schema: json!({ "type": "object" }),
                annotations: ToolAnnotations { read_only_hint: Some(true), idempotent_hint: Some(true), ..ToolAnnotations::default() },
                parallel_safe: true,
                exclusive_with: Vec::new(),
            },
            reported: reported.clone(),
            release: release.clone(),
        };
        let workspace = tempfile::tempdir().unwrap();
        let rig = Rig::new();
        let mut deps = rig.deps_parts(rig.store.clone());
        deps.runs = Arc::new(RunHostFactory::new(Arc::new(Parts { provider, workspace: workspace.path().to_path_buf(), more: vec![Arc::new(reporter)], settle: None })));
        let directory = SessionDirectory::new(Arc::new(deps));
        let reply = directory.request(request("thread/start", json!({ "opId": "op-start", "kind": "task", "projectPath": "/ws" }), "op-start")).await.expect("thread/start");
        let Reply::Subscribe(subscribe) = reply else { panic!("thread/start subscribes") };
        let id = ThreadId::from(subscribe.result["thread"]["id"].as_str().expect("thread id"));
        let handle = directory.handle(&id).expect("loaded");
        handle
            .request(request("turn/start", json!({ "threadId": id, "opId": "op-1", "input": { "prompt": "go" } }), "op-1"))
            .await
            .expect("turn/start");

        let hints = || -> Vec<Value> {
            rig.feeds
                .frames(id.as_str())
                .into_iter()
                .filter(|(_, method, _)| method == "thread/runtime/updated")
                .map(|(_, _, params)| params["value"]["progressHint"].clone())
                .collect()
        };
        tokio::time::timeout(Duration::from_secs(10), reported.notified()).await.expect("the tool ran");
        let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
        while !hints().contains(&json!({ "outputTail": "compiling" })) {
            assert!(tokio::time::Instant::now() < deadline, "the hint was not published: {:?}", hints());
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        release.notify_one();
        let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
        while hints().last() != Some(&Value::Null) {
            assert!(tokio::time::Instant::now() < deadline, "the hint was not withdrawn: {:?}", hints());
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    }

    // ---- the real assembly -------------------------------------------------------------------------

    struct OneProvider(Arc<Scripted>);

    #[async_trait]
    impl mixdog_ai::registry::providers::ProviderBuilder for OneProvider {
        async fn build(&self, _name: &str, _config: &Value) -> Result<Arc<dyn ProviderAdapter>, String> {
            Ok(self.0.clone())
        }
        async fn custom_key_ids(&self, _name: &str) -> Result<Vec<String>, String> {
            Ok(Vec::new())
        }
        fn available(&self, _name: &str) -> bool {
            true
        }
        async fn oauth_credentials_usable(&self, _name: &str) -> Result<bool, String> {
            Ok(true)
        }
    }

    struct Config;
    #[async_trait]
    impl super::super::host_seams::ConfigSeams for Config {
        fn hidden_agent(&self, _: Option<&str>) -> bool {
            false
        }
        fn run_settings(&self, _: &ThreadId, _: &mixdog_store::schema::record::Header) -> super::super::assemble::RunSettings {
            super::super::assemble::RunSettings {
                hidden_agent: false,
                agent_mode: false,
                limits: None,
                compact: None,
                escalated_max_output_tokens: None,
                read_body_required: false,
                effort: None,
                step_auto_effort: None,
                text_only: None,
                attachments: None,
                model_max_output_tokens: None,
            }
        }
        fn stored_instruction_files(&self) -> Option<Value> {
            None
        }
        fn response_language(&self) -> Option<(String, String)> {
            None
        }
    }

    struct NoMcp;
    impl super::super::session_tools::SessionMcp for NoMcp {
        fn tools(&self, _: &std::path::Path) -> Vec<Arc<dyn Tool>> {
            Vec::new()
        }
    }

    struct NoSkills;
    #[async_trait]
    impl super::super::session_tools::SkillsListed for NoSkills {
        async fn any_for(&self, _: &std::path::Path) -> Result<bool, String> {
            Ok(false)
        }
    }

    struct NoPostTool;
    #[async_trait]
    impl super::super::hooks::PostToolDispatch for NoPostTool {
        async fn post_tool(&self, _: &super::super::hooks::PostToolEvent) -> Option<JsonValue> {
            None
        }
        async fn post_failure(&self, _: &super::super::hooks::PostToolEvent) {}
        async fn post_batch(&self, _: &str, _: &str, _: usize) -> Option<super::super::hooks::BatchDecision> {
            None
        }
    }

    struct PoolResolver(Vec<Arc<dyn Tool>>);
    impl mixdog_tools::policy::ToolResolver for PoolResolver {
        fn resolve(&self, name: &str) -> Option<Arc<dyn Tool>> {
            self.0.iter().find(|t| t.spec().name == name).cloned()
        }
    }

    struct NoStamps;
    #[async_trait::async_trait]
    impl mixdog_core_ports::ports::run_stamps::RunStamps for NoStamps {
        async fn stamp_of(&self, _: &ThreadId) -> Option<Value> {
            None
        }
    }

    struct AllowNone;
    impl super::super::mcp_seams::AllowAllActions for AllowNone {
        fn allow_all_actions(&self) -> bool {
            false
        }
    }

    struct NoEvidence;
    #[async_trait]
    impl mixdog_core_agents::agents::AgentEvidence for NoEvidence {
        async fn home_greeted(&self, _: &str) -> bool {
            false
        }
        async fn home_chatted(&self, _: &str) -> bool {
            false
        }
        async fn mixy_owns_routines(&self) -> Result<bool, String> {
            Ok(false)
        }
    }
    struct NoLadder;
    #[async_trait]
    impl super::super::step_judge::LadderSources for NoLadder {
        fn cached_row(&self, _: &str, _: &str) -> Option<serde_json::Map<String, Value>> {
            None
        }
        async fn rejected(&self, _: &str, _: &str) -> Option<mixdog_ai::effort::RejectionEntry> {
            None
        }
        fn custom_config(&self, _: &str) -> Option<(mixdog_ai::providers::custom::Protocol, String)> {
            None
        }
        fn anthropic_levels(&self, _: &str) -> Vec<String> {
            Vec::new()
        }
    }

    struct Pricing;
    impl mixdog_ai::registry::accounting::UsagePricing for Pricing {
        fn price_usage(&self, args: &mixdog_ai::catalog::UsageArgs) -> mixdog_ai::catalog::PricedUsage {
            mixdog_ai::catalog::PricedUsage { input: args.input_tokens, cost_usd: None, rates: serde_json::Map::new() }
        }
    }

    #[derive(Default)]
    struct Ledger(Mutex<Vec<mixdog_ai::registry::accounting::UsageRow>>);
    #[async_trait]
    impl mixdog_ai::registry::accounting::UsageSink for Ledger {
        async fn record_queued(&self, row: mixdog_ai::registry::accounting::UsageRow) -> Result<(), String> {
            lock(&self.0).push(row);
            Ok(())
        }
    }

    struct NoSkillNames;
    #[async_trait]
    impl mixdog_mcp::skill_select::SkillNames for NoSkillNames {
        async fn names(&self, _: &std::path::Path) -> Result<std::collections::HashSet<String>, String> {
            Ok(Default::default())
        }
    }

    struct NoHopSessions;
    impl mixdog_core_run::run_host::hop_host::HopSessions for NoHopSessions {
        fn open(&self, _: &ThreadId) -> Option<Arc<dyn mixdog_core_run::run_host::hop_host::HopSession>> {
            None
        }
    }

    struct NoWiring;
    impl mixdog_core_run::run_host::hop_host::HopWiring for NoWiring {
        fn wiring(&self, _: &Value, _: &Arc<dyn ProviderAdapter>) -> (Option<mixdog_agent::effort::EffortWiring>, Option<mixdog_agent::text_only::TextOnlyInput>) {
            (None, None)
        }
    }

    struct NoBots;
    #[async_trait::async_trait]
    impl mixdog_core_run::run_host::route_chain::BotRoutes for NoBots {
        async fn bot_route(&self, _: &str) -> Result<Option<Option<Value>>, mixdog_core_run::run_host::route_chain::RouteReadUnavailable> {
            Ok(None)
        }
        async fn stored_bot_route(&self, _: &str) -> Result<Option<Value>, mixdog_core_run::run_host::route_chain::RouteReadUnavailable> {
            Ok(None)
        }
    }

    struct Offline;
    #[async_trait]
    impl mixdog_ai::transport::http::HttpSend for Offline {
        async fn send(
            &self,
            _: mixdog_core_api::domain::provider::WireRequest,
            _exchange: mixdog_ai::transport::Exchange,
        ) -> Result<mixdog_ai::transport::http::HttpResponse, ProviderError> {
            Err(ProviderError::new(
                mixdog_core_api::domain::provider::ErrorKind::Transient,
                DeliveryState::NotSent,
            ))
        }
    }

    struct NoMarks;
    impl super::super::settings::HeartbeatMarks for NoMarks {
        fn is_heartbeat(&self, _: &str) -> bool {
            false
        }
    }
    struct NoCeilings;
    impl super::super::settings::OutputCeilingSource for NoCeilings {
        fn ceilings(&self, _: &str, _: &str, _: &mixdog_store::schema::record::Header) -> super::super::settings::OutputCeilings {
            Default::default()
        }
    }
    struct AutoOff;
    impl super::super::settings::AutoEffortSource for AutoOff {
        fn mode_on(&self) -> bool {
            false
        }
        fn base_setting(&self) -> Option<Value> {
            None
        }
        fn steps_enabled(&self) -> bool {
            true
        }
    }
    struct NoAttachmentText;
    #[async_trait]
    impl mixdog_agent::attachments::AttachmentText for NoAttachmentText {
        async fn text_of(&self, _: &mixdog_core_api::domain::provider::ContentPart) -> Result<Option<String>, Box<ProviderError>> {
            Ok(None)
        }
    }
    fn named(name: &str) -> Arc<dyn Tool> {
        let spec = ToolSpec {
            name: name.into(),
            title: None,
            trigger: None,
            public: true,
            aliases: Vec::new(),
            description: name.into(),
            input_schema: json!({ "type": "object" }),
            annotations: ToolAnnotations { read_only_hint: Some(true), idempotent_hint: Some(true), ..ToolAnnotations::default() },
            parallel_safe: true,
            exclusive_with: Vec::new(),
        };
        Arc::new(Echo(spec))
    }

    /// The done-when turn: `TurnPath::new` over test implementations of the missing owner traits, a
    /// scripted provider behind the accounted registry, a tool call, the stored rows and the ledger row.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_turn_runs_through_the_turn_path() {
        let provider = Arc::new(Scripted {
            id: ProviderId::from("scripted"),
            policy: RetryPolicy::codex_default(),
            keepalive: KeepaliveSchedule::SPEC,
            codec: MockCodec,
            script: Mutex::new(VecDeque::from([
                vec![
                    StreamEvent::ToolCallDone(ToolCall { id: "c1".into(), name: "list".into(), arguments: json!({ "path": "." }), native_type: None }),
                    StreamEvent::Completed { stop: Some(StopReason::ToolUse), pricing_model: None, request_ms: None },
                ],
                vec![StreamEvent::TextDelta("listed".into()), StreamEvent::Completed { stop: Some(StopReason::EndTurn), pricing_model: None, request_ms: None }],
                // The side question's answer, then the answer after the saved request was forgotten.
                vec![StreamEvent::TextDelta(" it listed the path ".into()), StreamEvent::Completed { stop: Some(StopReason::EndTurn), pricing_model: None, request_ms: None }],
                vec![StreamEvent::TextDelta("rebuilt".into()), StreamEvent::Completed { stop: Some(StopReason::EndTurn), pricing_model: None, request_ms: None }],
            ])),
            requests: Mutex::new(Vec::new()),
            fail_first: std::sync::atomic::AtomicBool::new(false),
        });
        let workspace = tempfile::tempdir().unwrap();
        let rig = Rig::new();
        let tokens = mixdog_rt::testing::tokens();
        let ledger = Arc::new(Ledger::default());
        let sink: Arc<dyn mixdog_ai::registry::accounting::UsageSink> = ledger.clone();
        let accounting = mixdog_ai::registry::accounted::AccountingDeps::new(Arc::new(Pricing), Arc::new(move || Some(sink.clone())));
        let pool: Vec<Arc<dyn Tool>> = vec![named("list"), named("Skill")];
        let processes: Arc<dyn mixdog_core_api::domain::process::ProcessManager> = Arc::new(MockProcessManager::default());
        let clock: Arc<dyn Clock> = Arc::new(Fixed);
        let connectors: Arc<dyn mixdog_tools::policy::ConnectorPermissions> = mixdog_mcp::permissions::ConnectorPolicy::new(
            workspace.path().to_path_buf(),
            mixdog_mcp::permissions::PolicyIo { maintenance: tokens.maintenance_io, interactive: tokens.interactive_io, durability: tokens.durability_io },
        );
        let data = workspace.path().join("data");
        let judge = mixdog_services::effort_judge::judge::EffortJudgeModel::with_options(
            mixdog_services::effort_judge::model::ModelConfig::in_data_dir(&data, mixdog_services::effort_judge::model::OrtRuntime::Library(workspace.path().join("no-ort.dll"))),
            tokens.cpu_bulk,
            mixdog_services::effort_judge::judge::JudgeOptions { tick: Default::default(), manifest: None, progress: None },
        )
        .unwrap();
        let compaction = super::super::compaction_world::tests::services(workspace.path(), json!({}), Arc::default()).await;
        let hook_bus = mixdog_mcp::hook_bus::HookBus::new(data.clone(), tokens.maintenance_io, processes.clone(), None, None, None);
        let store = Arc::new(super::super::side_question_store::SideQuestionStore::new());
        let next = super::super::next_request_source::NextRequestSource::new();
        let (kept, side_store, side_next) = (store.clone(), store.clone(), next.clone());
        let parts = super::super::turn_path::TurnPathParts {
            tokens: tokens.clone(),
            clock: clock.clone(),
            paths: mixdog_store::paths::Paths { plugin_root: workspace.path().join("plugin"), data_dir: data },
            registry: Arc::new(mixdog_ai::registry::providers::ProviderRegistry::new(Arc::new(OneProvider(provider.clone()))).with_accounting(accounting)),
            effort_judge: judge,
            side: super::super::side_requests::SideRequests {
                store: kept,
                caching: Arc::new(|_, _| false),
                docs: compaction.docs.clone(),
                reader: compaction.reader.clone(),
                facts: compaction.attachment_facts.clone(),
                clock: clock.clone(),
            },
            next,
            files: Arc::new(MockFileService::default()),
            processes,
            policy: Arc::new(mixdog_tools::policy::ToolPolicy::new(Arc::new(mixdog_tools::policy::MemoryGrantStore::default()), connectors.clone())),
            connectors,
            resolver: Arc::new(PoolResolver(pool.clone())),
            unattended: crate::run_host::unattended::UnattendedRunRegistry::new(Arc::new(NoStamps)),
            exclusions: Arc::default(),
            agents: Arc::new(mixdog_core_agents::agents::AgentDefinitions::new(workspace.path().join("shipped"), workspace.path().join("agents"), tokens.interactive_io, mixdog_core_config::config::AgentRoutes::new(compaction.config.clone(), workspace.path()), Arc::new(NoEvidence), Arc::new(|| json!({})), workspace.path())),
            allow_all: Arc::new(AllowNone),
            hub: (mixdog_mcp::McpHub::new(mixdog_mcp::McpIo { spawn: tokens.spawn_io, durability: tokens.durability_io }, workspace.path().to_path_buf(), Default::default())),
            blobs: Arc::new(NoBlobs),
            tool_pool: pool,
            mcp: Arc::new(NoMcp),
            skills_listed: Arc::new(NoSkills),
            skill_names: Arc::new(NoSkillNames),
            ext_pool: Arc::new(mixdog_core_api::domain::mock::MockExtPool::new(4)),
            hook_bus,
            hook_common: Arc::new(|_| mixdog_mcp::hook_bus::HookCommon::default()),
            goals: Arc::new(rig.goals.clone()),
            todos: rig.todos.clone(),
            work: rig.work.clone(),
            cycles: Arc::default(),
            config: Arc::new(Config),
            settings: super::super::settings::SettingsSources { wiring: Arc::new(NoWiring), attachments: Arc::new(NoAttachmentText), heartbeats: Arc::new(NoMarks), ceilings: Arc::new(NoCeilings), auto_effort: Arc::new(AutoOff) },
            ladder: Arc::new(NoLadder),
            shells: None,
            deps: Box::new({
                let store = rig.store.clone();
                let rig_deps = rig.deps_parts(store);
                move |runs| {
                    let mut deps = rig_deps;
                    deps.runs = runs;
                    deps.side = Arc::new(super::super::side_question_store::SideQuestionService::new(side_store, side_next));
                    deps
                }
            }),
            compactors: Arc::new(super::super::compactors::SessionCompactors::new(Arc::new(super::super::compaction_world::ProcessCompactionWorld::new(compaction)), clock.clone())),
            hops: Box::new({
                let registry_dir = workspace.path().join("catalog");
                move |_directory, registry| {
                    let io = mixdog_ai::oauth::CredentialIo { read: tokens.interactive_io, write: tokens.durability_io };
                    let metadata = mixdog_ai::catalog::ModelsDevSource::new(Arc::new(Offline), registry_dir, io);
                    let catalog = futures::executor::block_on(mixdog_ai::catalog::CatalogService::cold_start(mixdog_ai::catalog::CatalogSnapshot::default(), Vec::new(), metadata));
                    mixdog_core_run::run_host::hop_host::HopFactory::new(
                        mixdog_core_run::run_host::hop_host::HopDeps {
                            registry: registry.clone(),
                            catalog: Arc::new(catalog),
                            config: Arc::new(serde_json::Map::new),
                            bots: Arc::new(NoBots),
                            errors: Arc::new(|e| e.message.clone()),
                            wiring: Arc::new(NoWiring),
                        },
                        Arc::new(NoHopSessions),
                    )
                }
            }),
        };
        let path = super::super::turn_path::TurnPath::new(parts).expect("turn path");
        path.registry.init_providers(&mixdog_ai::service::admin_route::ensure_provider_enabled(&serde_json::Map::new(), "scripted")).await.unwrap();
        let directory = path.directory.clone();
        // The settings host the composition binds: here one that leaves the thread's header as it is.
        struct AsIs(Arc<SessionDirectory>);
        #[async_trait]
        impl super::super::turn_settings::TurnSettings for AsIs {
            async fn reconcile(&self, thread: &ThreadId, _: bool) -> Result<mixdog_store::schema::record::Header, String> {
                mixdog_core_ports::ports::threads::ThreadState::header(&mixdog_core_session::session::thread_state::SessionThreads::new(self.0.clone()), thread).await.map_err(|error| format!("{error:?}"))
            }
        }
        assert!(path.turn_settings.bind(Arc::new(AsIs(directory.clone()))).is_ok());
        let reply = directory.request(request("thread/start", json!({ "opId": "op-start", "kind": "task", "projectPath": workspace.path() }), "op-start")).await.expect("thread/start");
        let Reply::Subscribe(subscribe) = reply else { panic!("thread/start subscribes") };
        let id = ThreadId::from(subscribe.result["thread"]["id"].as_str().expect("thread id"));
        let handle = directory.handle(&id).expect("loaded");
        handle
            .request(CoreRequest {
                method: Method("thread/header/patch"),
                params: json!({ "threadId": id, "set": { "provider": "scripted", "model": "m" } }),
                op: None,
                ctx: CallContext::internal("test"),
            })
            .await
            .expect("route");
        let started = handle.request(request("turn/start", json!({ "threadId": id, "opId": "op-1", "input": { "prompt": "go" } }), "op-1")).await.expect("turn/start");
        let Reply::Value(started) = started else { panic!("turn/start answers a value") };
        assert_eq!(started["kind"], "started");
        let roles = || -> Vec<String> {
            rig.store
                .records(&id)
                .into_iter()
                .filter_map(|(_, record)| match record {
                    Record::Item(item) => match item.body {
                        Slot::Inline(body) => body["role"].as_str().map(str::to_owned),
                        _ => None,
                    },
                    _ => None,
                })
                .collect()
        };
        let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
        while roles().len() < 4 || lock(&ledger.0).len() < 2 {
            assert!(tokio::time::Instant::now() < deadline, "the turn did not settle: {:?} ledger={}", roles(), lock(&ledger.0).len());
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        assert_eq!(roles(), ["user", "assistant", "tool", "assistant"]);
        let requests = lock(&provider.requests).clone();
        assert_eq!(requests.len(), 2);
        assert_eq!(requests[1].messages.iter().map(|m| m.role).collect::<Vec<_>>(), [Role::User, Role::Assistant, Role::Tool]);
        let rows = lock(&ledger.0).clone();
        assert!(rows.iter().all(|r| r.provider == "scripted" && r.model == "m" && r.session_id == id.as_str()), "{rows:?}");

        // `thread/askSide` end to end: the real service forks the request the loop saved, on a scope of
        // its own, and the answer comes back trimmed without entering the transcript.
        let asked = handle.request(request("thread/askSide", json!({ "opId": "op-side", "question": " what did it list? " }), "op-side")).await.expect("thread/askSide");
        let Reply::Value(asked) = asked else { panic!("thread/askSide answers a value") };
        assert_eq!(asked["text"], "it listed the path");
        let requests = lock(&provider.requests).clone();
        let fork = requests.last().expect("the fork's request");
        assert_eq!(requests.len(), 3);
        assert_eq!(fork.messages.iter().map(|m| m.role).collect::<Vec<_>>(), [Role::User, Role::Assistant, Role::Tool, Role::Assistant, Role::User], "the saved request, its reply, the question");
        assert!(fork.options.transport_scope.as_deref().is_some_and(|scope| scope.starts_with(&format!("{}#side:", id.as_str()))), "{:?}", fork.options.transport_scope);
        assert_eq!(roles(), ["user", "assistant", "tool", "assistant"], "the question never enters the transcript");
        assert_eq!(lock(&ledger.0).len(), 3, "the fork's usage row is the provider's own accounting row");

        // With no saved request (a restart, a forgotten one) the question forks the request the next turn
        // would send, rebuilt from the stored rows by the turn's own assembly.
        store.forget(&id);
        let rebuilt = handle.request(request("thread/askSide", json!({ "opId": "op-side-2", "question": "again?" }), "op-side-2")).await.expect("thread/askSide");
        let Reply::Value(rebuilt) = rebuilt else { panic!("thread/askSide answers a value") };
        assert_eq!(rebuilt["text"], "rebuilt");
        let requests = lock(&provider.requests).clone();
        let fork = requests.last().expect("the rebuilt fork");
        assert_eq!(fork.messages.iter().map(|m| m.role).collect::<Vec<_>>(), [Role::User, Role::Assistant, Role::Tool, Role::Assistant, Role::User]);
        assert_eq!((fork.model.as_str(), fork.options.session_id.as_deref()), ("m", Some(id.as_str())));
    }
}
