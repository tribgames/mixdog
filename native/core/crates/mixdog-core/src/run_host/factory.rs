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
use mixdog_core_api::domain::provider::{Content, ProgressKind, ProviderAdapter, Role};
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
use super::watchdog::{StallSite, Watchdog, registration_id, stall_abort_ctx};
use mixdog_agent::agent_tool::progress::Snapshot;
use mixdog_agent::agent_tool::watchdog::{is_watchdog_abort, resolve_policy, AgentKind, Overrides};
use super::message_row::{message_of, row_of};
use mixdog_core_run::run_host::progress::ProgressPublisher;
use mixdog_core_run::run_host::progress::StreamKind;
use super::retry::{RandomJitter, TimerWait};
use super::steer::SteerQueue;
use super::quiet_watch::QuietWatch;
use super::tool_progress::{RunToolProgress, ToolHints};
use mixdog_core_session::session::turn_snapshot::ReviewGate;
use mixdog_core_session::session::failure_record::provider_turn_error;
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
    /// Where the turn's failed tool calls are recorded (`history/tool-failures.jsonl`).
    pub failures: Option<Arc<dyn mixdog_agent::env::ToolFailureLog>>,
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

    /// `refreshDeferredMcpToolCatalog(session)`: the thread's MCP catalog follows the live registry. Run by the
    /// loop at each request boundary and around each tool call; a host with no MCP catalog has nothing to refresh.
    async fn refresh_mcp(&self, _thread: &ThreadId) -> Result<(), TurnError> {
        Ok(())
    }

    /// `currentAgents()`: the agents the thread's Lead may delegate to now, for the turn's agent list reminder;
    /// `None` for a thread that gets none (an agent's own, a bot's).
    async fn current_agents(&self, _thread: &ThreadId, _header: &mixdog_store::schema::record::Header) -> Result<Option<Vec<super::turn_reminders::AgentEntry>>, TurnError> {
        Ok(None)
    }

    /// `orchestrationInstructions(mode)`: the text a carried orchestration mode notice ends with.
    async fn orchestration_instructions(&self, _mode: &str) -> Result<String, TurnError> {
        Err(TurnError { message: "this host has no orchestration instructions".to_owned(), data: json!({}), provider_error: None })
    }

    /// The thread's tools as its session holds them now (`session.tools`, after a refresh): the request boundary
    /// adopts their changed MCP definitions. A host with no MCP catalog keeps the run's set.
    async fn request_tools(&self, _thread: &ThreadId, _surface: &SessionSurface) -> Result<Option<ToolSet>, TurnError> {
        Ok(None)
    }

    /// `snapshotProviderRequestTools` over `tools` and the native tool searches (`nativeToolSearch`) of the
    /// transcript the request is built from; a host with no deferred catalog keeps `tools`.
    async fn request_snapshot(&self, _thread: &ThreadId, tools: Vec<mixdog_core_api::domain::provider::ToolDefinition>, _native: Vec<Value>) -> Result<Vec<mixdog_core_api::domain::provider::ToolDefinition>, TurnError> {
        Ok(tools)
    }

    /// `migrateToolExposureAtBoundary` over the transcript `rows` the request is built from: the system messages of
    /// the migrated thread, `None` when nothing migrated. A host with no deferred surface migrates nothing.
    async fn migrate_exposure(&self, _thread: &ThreadId, _rows: Vec<Value>) -> Result<Option<Vec<AgentMessage>>, TurnError> {
        Ok(None)
    }

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
    /// The map TurnLiveness writes: one entry per run, read by the pool, the thread list and the report host.
    liveness: Arc<mixdog_services::task_reports::runtime_state::RuntimeLiveness>,
    /// The registry the hosted web search reports its spend to (`registerNativeWebSearchUsageSink`): the one `SenderDeps.sinks` holds.
    search_usage: Arc<mixdog_tools::web::NativeSearchUsageSinks>,
}

impl RunHostFactory {
    pub fn new(
        liveness: Arc<mixdog_services::task_reports::runtime_state::RuntimeLiveness>,
        search_usage: Arc<mixdog_tools::web::NativeSearchUsageSinks>,
        parts: Arc<dyn RunParts>,
    ) -> Self {
        Self { parts, liveness, search_usage }
    }
}

impl RunFactory for RunHostFactory {
    fn start(&self, run: RunStart) -> Pin<Box<dyn Future<Output = RunOutcome> + Send>> {
        let (parts, liveness, search_usage) = (self.parts.clone(), self.liveness.clone(), self.search_usage.clone());
        Box::pin(drive(parts, liveness, search_usage, run))
    }
}

pub(super) use mixdog_core_session::session::run::new_item_id;

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
    /// `markAssistantMessageCommitted` empties it.
    observed: Arc<Mutex<Observed>>,
    iids: Mutex<HashMap<String, ItemId>>,
    clock: Arc<dyn Clock>,
    blobs: Arc<dyn mixdog_agent::compact::blob_reads::BlobReads>,
    /// A worker's turn hook (`onToolResult`): called with each tool result the turn gains.
    on_tool_result: Option<Arc<dyn Fn(&mixdog_agent::agent_tool::flow::seams::ToolResultMessage) + Send + Sync>>,
    /// What the turn's input row says of the turn, which its assistant rows repeat; `None` for an input row
    /// without transcript metadata.
    stamp: Option<TurnStamp>,
    /// The loop's counters, set by the host just before the turn's terminal reply commits
    /// (`appendAssistantTurnMessage` writes them on that message).
    terminal: Mutex<Option<(u32, u64)>>,
}

/// What `beginTurn` (`tui/session/turn.mjs`) gave the turn, as its assistant rows and its completion take it.
struct TurnStamp {
    /// `attemptId` and the route fields of the input row's `meta.transcript`
    /// (`persistedAssistantTranscriptMetadata`: the attempt and `transcriptRouteMetadataFields`).
    carried: serde_json::Map<String, Value>,
    /// `rawTranscriptMeta.at`, else the ask's start.
    started_at: i64,
    /// The turn's change-record key, which its completion names.
    checkpoint_id: Option<String>,
    /// `pickDoneVerb(stats.turns)`.
    verb: &'static str,
}

impl TurnStamp {
    fn of(input_body: &Value, verb: &'static str, asked_at: i64) -> Option<Self> {
        let transcript = input_body.pointer("/meta/transcript")?.as_object()?;
        let text = |key: &str| transcript.get(key).and_then(Value::as_str).filter(|value| !value.is_empty());
        let carried = ["attemptId", "modelId", "model", "provider", "agent"]
            .into_iter()
            .filter_map(|key| text(key).map(|value| (key.to_owned(), json!(value))))
            .collect();
        Some(Self {
            carried,
            started_at: transcript.get("at").and_then(Value::as_i64).filter(|at| *at != 0).unwrap_or(asked_at),
            checkpoint_id: text("checkpointId").map(str::to_owned),
            verb,
        })
    }
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
        observed: Arc<Mutex<Observed>>,
        clock: Arc<dyn Clock>,
        blobs: Arc<dyn mixdog_agent::compact::blob_reads::BlobReads>,
        on_tool_result: Option<Arc<dyn Fn(&mixdog_agent::agent_tool::flow::seams::ToolResultMessage) + Send + Sync>>,
        stamp: Option<TurnStamp>,
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
        Arc::new(Self { jobs, done, seq: AtomicU64::new(0), port, rows, live, turn: Mutex::new(Vec::new()), streaming, observed, iids: Mutex::new(HashMap::new()), clock, blobs, on_tool_result, stamp, terminal: Mutex::new(None) })
    }

    /// What Node's loop and turn commit write on an assistant row besides its content: its id, time and
    /// route (`attachAssistantTranscriptMetadata`, `persistedAssistantTranscriptMetadata`), the tool-call
    /// message's `createdAt`, and on the terminal reply the loop's counters and the turn's completion
    /// (`appendAssistantTurnMessage`, `attachAssistantTranscriptCompletion`).
    fn stamp_assistant(&self, row: &mut Value, message: &AgentMessage, terminal: Option<(u32, u64)>) {
        let Some(stamp) = &self.stamp else { return };
        let Some(object) = row.as_object_mut() else { return };
        let now = self.clock.now_ms();
        if !message.tool_calls().is_empty() {
            object.insert("createdAt".into(), json!(now));
        }
        if let Some((iterations, tool_calls_total)) = terminal {
            object.insert("iterations".into(), json!(iterations));
            object.insert("toolCallsTotal".into(), json!(tool_calls_total));
        }
        let meta = object.entry("meta").or_insert_with(|| json!({}));
        if !meta.is_object() {
            *meta = json!({});
        }
        let transcript = meta.as_object_mut().expect("meta is an object").entry("transcript").or_insert_with(|| json!({}));
        if !transcript.is_object() {
            *transcript = json!({});
        }
        let transcript = transcript.as_object_mut().expect("transcript is an object");
        transcript.entry("messageId").or_insert_with(|| json!(self.message_id()));
        transcript.entry("at").or_insert_with(|| json!(now));
        for (key, value) in &stamp.carried {
            transcript.entry(key.clone()).or_insert_with(|| value.clone());
        }
        if terminal.is_some() && !mixdog_js::js_trim(&message.text()).is_empty() {
            let mut completion = json!({ "status": "done", "verb": stamp.verb, "elapsedMs": (now - stamp.started_at).max(0) });
            if let Some(checkpoint) = &stamp.checkpoint_id {
                completion["checkpointId"] = json!(checkpoint);
            }
            transcript.entry("completion").or_insert(completion);
        }
        // Node's key order: the tool-call message opens with `role, createdAt` (`buildToolCallAssistantMessage`), the
        // terminal reply puts its `meta` right after `content` (`appendAssistantTurnMessage`).
        let lead: &[&str] = if !message.tool_calls().is_empty() {
            &["role", "createdAt"]
        } else if terminal.is_some() {
            &["role", "content", "meta"]
        } else {
            &[]
        };
        if !lead.is_empty() {
            let mut ordered = serde_json::Map::new();
            for key in lead {
                if let Some(value) = object.shift_remove(*key) {
                    ordered.insert((*key).into(), value);
                }
            }
            ordered.append(object);
            *object = ordered;
        }
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
        let mut row = row_of(message);
        if message.role() == Role::Assistant {
            let terminal = lock(&self.terminal).take();
            self.stamp_assistant(&mut row, message, terminal);
        }
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
            // The authoritative result is in the transcript now: an early notice of it is no longer pending
            // (`recordToolResult` deletes it).
            if let Some(id) = message.tool_call_id() {
                lock(&self.observed).results.retain(|early| early.tool_call_id() != Some(id));
            }
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
        if message.role() == Role::Assistant {
            let mut observed = lock(&self.observed);
            observed.text.clear();
            observed.reasoning.clear();
            observed.calls.clear();
            // The shown item is the message's item: a later rewrite of the context names it by this id.
            if let (Some(id), Some(iid)) = (&message.message_id, &shown) {
                lock(&self.iids).insert(id.clone(), iid.clone());
            }
        }
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
    Check(mixdog_core_session::session::run::SendCheck),
    Pass(Box<mixdog_agent::env::CompactPass>),
    ToolStream,
    CompactUsage(mixdog_core_session::session::CompactUsageReport),
    /// Answered once every report before it has reached the port.
    Barrier(tokio::sync::oneshot::Sender<()>),
    /// A hosted web search's spend, as `reportNativeWebSearchUsage` shapes it.
    SearchUsage(Value),
    /// A stage the client shows as its status, with its detail.
    Stage(String, Option<Value>),
}

/// What the interrupted request had produced that the transcript does not hold yet
/// (`createTurnInterruptionTracker`): the run's observer fills it, the sink empties it when an assistant message commits.
#[derive(Default)]
struct Observed {
    started: bool,
    text: String,
    reasoning: String,
    /// `markToolPhaseStarted`; a new send (`markProviderSendStarted`) puts it back.
    tools: bool,
    calls: Vec<mixdog_core_api::domain::provider::ToolCall>,
    /// Results that settled but were not committed in call order (`__earlyNotify`).
    results: Vec<AgentMessage>,
}

/// `RunObserver` over progress and the port: stage and stream marks feed the progress cell, shown
/// assistant text becomes `item/started` + `item/agentMessage/delta`.
struct PortObserver {
    observed: Arc<Mutex<Observed>>,
    progress: Arc<ProgressPublisher>,
    out: mpsc::UnboundedSender<Shown>,
    streaming: Arc<Mutex<Option<ItemId>>>,
    /// The Reasoning item the thinking text streams into, until the model moves on to text,
    /// tool calls or its usage report.
    reasoning: Mutex<Option<(ItemId, String)>>,
    /// The tools of the latest request (`result.lastSendTools`).
    last_send_tools: Mutex<Vec<mixdog_core_api::domain::provider::ToolDefinition>>,
    /// The stream announces its chunks (`RunEvent::Chunk`): its deltas report no kind of their own.
    chunked: std::sync::atomic::AtomicBool,
    /// The turn's live messages, which an early tool notice joins until its result commits.
    live: LiveTurnPublisher,
    rows: Arc<StoredRows>,
    /// The run's token: once it is cancelled the interruption's record is closed (Node finalizes the interrupted turn in the
    /// abort's own step, so a call that settles after the abort is closed as cancelled).
    cancel: tokio_util::sync::CancellationToken,
    /// The thread's model context, whose sensitive marks a tool batch's execution calls set.
    context: mixdog_core_session::session::run::ModelContext,
}

impl PortObserver {
    /// Resolves once every report sent so far has been handed to the port.
    fn barrier(&self) -> tokio::sync::oneshot::Receiver<()> {
        let (done, reached) = tokio::sync::oneshot::channel();
        let _ = self.out.send(Shown::Barrier(done));
        reached
    }

    /// One report of model progress of `kind` (`markSessionStreamDelta`).
    fn model_progress(&self, kind: ProgressKind) {
        self.progress.stream_delta(match kind {
            ProgressKind::Semantic => StreamKind::Semantic,
            ProgressKind::Reasoning => StreamKind::Reasoning,
            ProgressKind::Text => StreamKind::Text,
            ProgressKind::Tool => StreamKind::Tool,
        });
        let _ = self.out.send(Shown::ToolStream);
    }

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
            RunEvent::Stage(Stage::Connecting) => {
                lock(&self.observed).tools = false;
                self.progress.stage("connecting");
            }
            RunEvent::Stage(Stage::Streaming) => self.progress.stage("streaming"),
            RunEvent::Stage(Stage::WaitingOnProvider) => self.progress.stream_delta(StreamKind::Keepalive),
            RunEvent::Stage(Stage::ApprovalWait { waiting }) => self.progress.approval_wait(waiting),
            RunEvent::TextDelta(text) => {
                self.end_reasoning();
                if !self.chunked.load(std::sync::atomic::Ordering::Relaxed) {
                    self.progress.stream_delta(StreamKind::Text);
                }
                if !text.is_empty() {
                    let mut observed = lock(&self.observed);
                    observed.started = true;
                    observed.text.push_str(&text);
                }
                self.text(text);
            }
            RunEvent::ReasoningDelta(text) => {
                if !self.chunked.load(std::sync::atomic::Ordering::Relaxed) {
                    self.progress.stream_delta(StreamKind::Reasoning);
                }
                if !text.is_empty() {
                    let mut observed = lock(&self.observed);
                    observed.started = true;
                    observed.reasoning.push_str(&text);
                }
                self.reasoning(text);
            }
            RunEvent::Stage(Stage::Notice { message, tone }) => {
                let _ = self.out.send(Shown::Notice(message, tone));
            }
            RunEvent::Usage { iteration, usage, delta } => {
                self.end_reasoning();
                *lock(&self.last_send_tools) = delta.send_tools.clone();
                let _ = self.out.send(Shown::Usage(mixdog_core_session::session::UsageReport::from_event(iteration, usage, delta)));
            }
            RunEvent::Compact(event) => {
                let _ = self.out.send(Shown::Compact(event));
            }
            RunEvent::CompactPass(pass) => {
                let _ = self.out.send(Shown::Pass(pass));
            }
            RunEvent::CompactUsage { iteration, usage, reasoning_tokens, reasoning_tokens_complete } => {
                let _ = self.out.send(Shown::CompactUsage(mixdog_core_session::session::CompactUsageReport { iteration, usage, reasoning_tokens, reasoning_tokens_complete }));
            }
            RunEvent::ToolStream(kind) => self.model_progress(kind),
            RunEvent::Chunk(kind) => {
                self.chunked.store(true, std::sync::atomic::Ordering::Relaxed);
                if let Some(kind) = kind {
                    self.model_progress(kind);
                }
            }
            // Node's syncContextDisplayFields (context-state.mjs:116): the window the status shows and the compaction trigger, once known (> 0).
            // A send that compacts nothing also records its check (`compactTelemetry(ctx, 'pre_send_check')`).
            RunEvent::ContextPressure { will_compact, trigger_tokens, boundary_tokens, context_window, messages, tools, reactive, .. } => {
                let positive = |tokens: u64| i64::try_from(tokens).ok().filter(|tokens| *tokens > 0);
                let window = context_window.and_then(positive);
                let context = mixdog_app_protocol::v2::thread::ThreadContext { context_window: window, display_context_window: window, auto_compact_token_limit: positive(trigger_tokens), compact_boundary_tokens: positive(boundary_tokens), ..Default::default() };
                let _ = self.out.send(Shown::Section(mixdog_core_ports::ports::threads::Section::Context(context)));
                if !will_compact {
                    let _ = self.out.send(Shown::Check(mixdog_core_session::session::run::SendCheck { messages, tools, reactive }));
                }
            }
            // The context section is the route's window choice (`runtime.contextPercent`, exact `contextTokens` only for a
            // non-default window), never the usage reading: usage reaches clients as `thread/tokenUsage/updated`.
            // `applyStageChange('account-changed')`: the selection change is thread state, never a transcript item.
            // The pool's `onStageChange('reconnecting', { message })` before it retries on the next account: the
            // client's status (`applyStageChange`: the spinner's mode and verb), never a transcript notice.
            RunEvent::Stage(Stage::AccountSwitching { message }) => {
                let _ = self.out.send(Shown::Stage("reconnecting".to_owned(), Some(serde_json::json!({ "message": message }))));
            }
            RunEvent::Stage(Stage::AccountChanged { provider, account_id, at }) => {
                let change = mixdog_app_protocol::v2::thread::ProviderAccountChange { provider, account_id, at };
                let _ = self.out.send(Shown::Section(mixdog_core_ports::ports::threads::Section::ProviderAccount(change)));
            }
            RunEvent::Stage(Stage::ModelFallback { model }) => {
                let route = mixdog_app_protocol::v2::thread::ThreadRoute { session_model: Some(model), ..Default::default() };
                let _ = self.out.send(Shown::Section(mixdog_core_ports::ports::threads::Section::Route(route)));
            }
            // On the loop's own task, before the assistant turn carrying the calls is committed (its encode reads the marks).
            RunEvent::ExecutionCalls(calls) => {
                let calls: Vec<Value> = calls.iter().map(|call| json!({ "id": call.id, "name": call.name, "arguments": call.arguments })).collect();
                self.context.remember_sensitive(&calls);
            }
            RunEvent::ToolCalls { calls, .. } => {
                {
                    let mut observed = lock(&self.observed);
                    observed.started = true;
                    observed.tools = true;
                    observed.calls.extend(calls.iter().cloned());
                }
                self.end_reasoning();
                self.progress.stage("tool_running");
                for call in &calls {
                    self.progress.tool_call(Some(&call.name));
                }
            }
            // Node's early notice, `recordToolResult`: the interruption keeps it, and the card completes now in the
            // live turn rows, in completion order, until the call-order result commits.
            RunEvent::EarlyResult(message) => {
                if let Some(id) = message.tool_call_id() {
                    self.live.early(id, mixdog_agent::compact::execution_tail::MessageRows::row(&*self.rows, &message));
                }
                if !self.cancel.is_cancelled() {
                    let mut observed = lock(&self.observed);
                    observed.started = true;
                    observed.results.push(message);
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

/// The run's failure log with each failed call's arguments through the thread's sensitive projection and its result text
/// with the thread's values replaced: the log is a file (`history/tool-failures.jsonl`), so a failed sensitive fill's
/// value goes there as its marker, also where the tool's error repeats it. Node summarizes the arguments as they are
/// (`agent-trace-format.mjs:526`, `summarizeToolArgs`) and takes the error line from the result text as it is, and so
/// writes the value to disk: fixed on both sides (`redactSensitiveToolCall(sessionId, { arguments: toolArgs })`,
/// `redactSensitiveText(sessionId, resultText)`, `node-fix-sensitive-side-writes.patch`).
struct SensitiveFailures {
    inner: Arc<dyn mixdog_agent::env::ToolFailureLog>,
    context: mixdog_core_session::session::run::ModelContext,
}

impl mixdog_agent::env::ToolFailureLog for SensitiveFailures {
    fn failed(&self, mut call: mixdog_agent::env::FailedCall) {
        call.tool_args = self.context.redact_arguments(&call.tool_args);
        call.result_text = self.context.redact_text(&call.result_text);
        self.inner.failed(call);
    }

    fn stall_abort(&self, ctx: serde_json::Map<String, Value>) {
        self.inner.stall_abort(ctx);
    }
}

// ---- the turn ----------------------------------------------------------------------------------------

/// `finalizeCancelledTurn` (`ask-turn-failure.mjs`): the transcript of a stopped turn as `finalizeInterruptedTurn`
/// leaves it for the stop's reason: the partial reply, every unanswered call closed as cancelled, the interruption
/// line, and `sentRequestTail` on the message the request ended with; a user cancel that produced nothing hands the
/// prompt back (it leaves the context), a kept prompt or a non-user stop keeps it. The new rows are committed and the
/// model context restarts on the finalized transcript, which also drops the provider's continuation.
async fn close_cancelled(
    port: &RunPort,
    sink: &PortSink,
    rows: &StoredRows,
    history: &[(ItemId, AgentMessage)],
    input_item: &ItemId,
    input_text: &str,
    observed: &Mutex<Observed>,
    reason: mixdog_agent::interrupt::AbortReason,
) {
    use mixdog_agent::compact::execution_tail::MessageRows as _;
    use mixdog_agent::interrupt::{finalize_interrupted_turn, Interrupted, Phase};
    let seen = std::mem::take(&mut *lock(observed));
    let mut known: Vec<(ItemId, AgentMessage)> = history.to_vec();
    for (index, message) in lock(&sink.turn).iter().enumerate() {
        known.push((if index == 0 { input_item.clone() } else { sink.iid_of(message) }, message.clone()));
    }
    let finalized = finalize_interrupted_turn(Interrupted {
        transcript: known.iter().map(|(_, message)| message.clone()).collect(),
        current_user_text: input_text.to_owned(),
        response_started: seen.started,
        partial_assistant: seen.text,
        partial_reasoning: seen.reasoning,
        observed_tool_calls: seen.calls,
        observed_tool_results: seen.results,
        phase: if seen.tools { Phase::Tools } else { Phase::Streaming },
        reason,
    });
    // A user cancel that produced nothing hands the prompt back: the rewind record at its row.
    if !finalized.user_turn_preserved {
        if let Err(error) = port.prompt_rewound(input_item.clone()).await {
            tracing::warn!("[session] rewound prompt save failed: {error:?}");
        }
        return;
    }
    let mut replacement: Vec<(ItemId, Value)> = Vec::new();
    for (index, message) in finalized.transcript.iter().enumerate() {
        let mut body;
        let iid;
        if let Some((known_iid, _)) = known.get(index).filter(|(_, was)| was == message) {
            iid = known_iid.clone();
            body = rows.row(message);
        } else {
            // The shown reply is the item of the partial text it ends as.
            iid = if message.role() == Role::Assistant { lock(&sink.streaming).take().unwrap_or_else(new_item_id) } else { new_item_id() };
            body = row_of(message);
            rows.record(message, body.clone());
            let role = match message.role() {
                Role::Assistant => "assistant",
                Role::Tool => "tool",
                _ => "user",
            };
            let item = ItemCommit { iid: iid.clone(), role: Some(role.to_owned()), model: true, visible: message.role() != Role::User, body: body.clone(), prompt: None };
            if let Err(error) = port.commit_item(item).await {
                tracing::warn!("[session] interrupted turn row save failed: {error:?}");
            }
        }
        if finalized.sent_request_tail == Some(index) && let Some(object) = body.as_object_mut() {
            let meta = object.entry("meta").or_insert_with(|| json!({}));
            if let Some(meta) = meta.as_object_mut() {
                meta.insert("sentRequestTail".into(), Value::Bool(true));
            }
        }
        replacement.push((iid, body));
    }
    if let Err(error) = port.context_rewound(replacement).await {
        tracing::warn!("[session] interrupted turn context save failed: {error:?}");
    }
}

/// `promptContentText(input.prompt).trim()`: a string, or the text parts joined by a newline.
fn prompt_text(body: &Value) -> String {
    match body.get("content") {
        Some(Value::String(text)) => text.trim().to_owned(),
        Some(Value::Array(parts)) => parts.iter().filter_map(|p| p.get("text").and_then(Value::as_str)).collect::<Vec<_>>().join("\n").trim().to_owned(),
        _ => String::new(),
    }
}
/// The run's [`McpCatalog`]: the parts' refresh for this thread. A refresh that fails is logged; like Node's
/// (`catch` around the reconcile in `foldMcpSurface`), it never breaks the turn.
struct ThreadMcp {
    parts: Arc<dyn RunParts>,
    thread: ThreadId,
    surface: tokio::sync::watch::Receiver<Arc<SessionSurface>>,
}

#[async_trait]
impl mixdog_agent::env::McpCatalog for ThreadMcp {
    async fn refresh(&self) {
        if let Err(error) = self.parts.refresh_mcp(&self.thread).await {
            tracing::warn!("[mcp] catalog refresh failed: {error:?}");
        }
    }

    async fn tools(&self) -> Result<Option<ToolSet>, String> {
        let surface = self.surface.borrow().clone();
        self.parts.request_tools(&self.thread, &surface).await.map_err(|error| error.message)
    }

    async fn snapshot(&self, tools: Vec<mixdog_core_api::domain::provider::ToolDefinition>, messages: &[AgentMessage]) -> Result<Vec<mixdog_core_api::domain::provider::ToolDefinition>, String> {
        self.parts.request_snapshot(&self.thread, tools, native_searches(messages)).await.map_err(|error| error.message)
    }

    async fn migrate(&self, messages: &[AgentMessage]) -> Result<Option<Vec<AgentMessage>>, String> {
        let rows = messages.iter().map(super::message_row::row_of).collect();
        self.parts.migrate_exposure(&self.thread, rows).await.map_err(|error| error.message)
    }
}

/// The native tool-search records of a transcript, which the request boundary's tool snapshot reads its references from.
pub(crate) fn native_searches(messages: &[AgentMessage]) -> Vec<Value> {
    messages.iter().filter_map(|m| m.message.native_tool_search.clone()).collect()
}

/// `session.messages`: the system blocks the session's requests lead with, then its stored conversation rows.
pub(crate) fn session_messages(header: &mixdog_store::schema::record::Header, rows: &[Value]) -> Result<Vec<AgentMessage>, String> {
    let mut messages = system_messages(header);
    for row in rows {
        messages.push(super::message_row::message_of(row)?);
    }
    Ok(messages)
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

async fn drive(
    parts: Arc<dyn RunParts>,
    liveness: Arc<mixdog_services::task_reports::runtime_state::RuntimeLiveness>,
    search_usage: Arc<mixdog_tools::web::NativeSearchUsageSinks>,
    run: RunStart,
) -> RunOutcome {
    let RunStart { thread, turn, input_body, header, port, context, surface, progress, turn_messages, cancel, signal, review, agent_turn, unattended, verb, skill_selection: routine_selection, input: submitted, input_item, goal_reminder, notice: carried_notice, .. } = run;
    // whileTurnDispatched and the runtime entry (`runtime-state.mjs`): the run is live from here to the end of the drive.
    let _live = super::turn_liveness::TurnLiveness::begin(&liveness, &thread, Value::Object(header.clone()), progress.subscribe(), cancel.clone());
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
    let quiet_changes = progress.subscribe();
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
    // `refreshSessionBp3Environment` (`ask-turn-execute.mjs`): the first turn of a session whose prompt has not
    // taken its `# Session` block yet adds it, and the session records that it did.
    let mut header = header;
    if header.get("sessionStartMetaInjected") != Some(&Value::Bool(true)) && !mixdog_core_session::session::route_session::has_user_conversation(&prior) {
        let patch = super::prompt_session::refresh_environment(&header, &mixdog_core_prompt::prompt::blocks::SystemBlocks::from_header(&header));
        for key in &patch.change.unset {
            header.shift_remove(key);
        }
        for (key, value) in &patch.change.set {
            header.insert(key.clone(), value.clone());
        }
        if port.save_header(patch.change).await.is_err() {
            return failed("the session's prompt could not be saved", Value::Null);
        }
    }
    let surface_now = surface.borrow().clone();
    let assembled = match parts.assemble(AssembleInput { thread: &thread, turn: &turn, header: &header, surface: surface_now, port: &port, surface_rx: surface.clone(), slot, skill_selection, prior: &prior, request: &request, injected, notify, progress: tool_progress }).await {
        Ok(assembled) => assembled,
        Err(error) => return RunOutcome::Failed(error),
    };
    let Assembled {
        provider, tools, tool_env, gate, worktree, mut config, clock, decider, guards, compactor, route, skills, hooks, reuse, reactions, reaction_scope: _reaction_scope, rows, tail, side, step_judge, artifacts, images, failures, blobs, carry,
    } = assembled;
    let failures = failures.map(|inner| Arc::new(SensitiveFailures { inner, context: context.clone() }) as Arc<dyn mixdog_agent::env::ToolFailureLog>);
    // `backfillFallbackSessionTitle` (`precommitUserTurn`, `ask-turn-execute.mjs`): a titleless session is named
    // from the earliest human turn of its history, else this turn's prompt (an injected turn never names it),
    // before the first save.
    let prompt = (!injected).then(|| json!({ "role": "user", "content": input_body.get("content").cloned().unwrap_or(Value::Null) }));
    if let Some(change) = mixdog_core_session::session::session_title::fallback_title_change(&header, &prior, prompt.as_ref(), clock.now_ms())
        && port.save_header(change).await.is_err()
    {
        return failed("the session's title could not be saved", Value::Null);
    }
    // The turn's tools publish each edit's card diff to the same review (`registerEditToolUiDiff`).
    let mut tool_env = tool_env;
    tool_env.review = Some(review.api());
    // The turn's workspace is final: take the baseline in the background; no tool runs before it.
    review.start(&worktree);

    // `buildUserTurn` (`ask-turn-prepare.mjs:147-246`): the reminders staged on the conversation (a workflow or an
    // orchestration mode switch, moved settings, a changed agent list or working folder, a prepared worktree, a
    // deferred-tool delta, the Goal) and the ones this prompt earns (the current time, a delegated agent's todo start)
    // ride this turn once, as the user message's reminder suffix. The message is kept as it was sent (the context the
    // next turns replay, and a retry resubmits), and the actor acknowledges the revisions when the turn is accepted
    // (`ask-turn-settle.mjs:148-164`); a failed turn leaves them pending.
    let mut input_body = input_body;
    let current_agents = match parts.current_agents(&thread, &header).await {
        Ok(agents) => agents,
        Err(error) => return RunOutcome::Failed(error),
    };
    // A retried failed turn resends its own message as it is (`retainedUserTurn`, `ask-turn-execute.mjs:38-69`): it
    // keeps the reminders it was built with, learns the agents changed since, and acknowledges its settings notice only.
    let (carried, revisions) = if super::turn_reminders::is_retained(&input_body) {
        match super::turn_reminders::resubmit(&input_body, &header, &prior, current_agents.as_deref()) {
            Ok(resent) => resent,
            Err(text) => return failed(text, input_body),
        }
    } else {
        let mode_instructions = match super::turn_reminders::carried_mode(&header) {
            Some(mode) => match parts.orchestration_instructions(&mode).await {
                Ok(text) => Some(text),
                Err(error) => return RunOutcome::Failed(error),
            },
            None => None,
        };
        // `promptContentText(prompt)`: a stored text attachment is read from the store; one that cannot be read fails the turn.
        let prompt_content = input_body.get("content").cloned().unwrap_or(Value::Null);
        let prompt_text = match with_blobs(&*blobs, move |store| super::turn_reminders::prompt_content_text(&prompt_content, store)).await {
            Ok(Ok(text)) => text,
            Ok(Err(text)) => return failed(text, input_body),
            Err(error) => return failed(error.to_string(), input_body),
        };
        let facts = super::turn_reminders::Facts {
            header: &header,
            prior: &prior,
            prompt_text: &prompt_text,
            genuine: !injected,
            current_agents: current_agents.as_deref(),
            mode_instructions: mode_instructions.as_deref(),
            goal: goal_reminder.as_ref().map(|reminder| reminder.content.as_str()),
            hidden_agent: config.hidden_agent,
            now_ms: clock.now_ms() as f64,
        };
        let reminders = match super::turn_reminders::build(&facts) {
            Ok(reminders) => reminders,
            Err(text) => return failed(text, input_body),
        };
        let Some(carried) = reminders.carry(&input_body) else {
            return failed("the turn's input row cannot carry the turn's reminders".to_owned(), input_body);
        };
        (carried, reminders.revisions)
    };
    if carried != input_body {
        let mut sent = stored.clone();
        sent.push((input_item.clone(), carried.clone()));
        if port.context_rewound(sent).await.is_err() {
            return failed("the turn's reminders could not be saved with the turn's input", Value::Null);
        }
        input_body = carried;
    }
    carried_notice.carry(revisions);
    let input = match message_of(&input_body) {
        Ok(input) => input,
        Err(error) => return failed(format!("the turn's input row is not a model message: {error}"), input_body),
    };
    let live = LiveTurnPublisher::new(turn_messages);
    let streaming = Arc::new(Mutex::new(None));
    let stamp = TurnStamp::of(&input_body, verb, clock.now_ms());
    let observed = Arc::new(Mutex::new(Observed::default()));
    let sink = PortSink::spawn(port.clone(), rows.clone(), live.clone(), streaming.clone(), observed.clone(), clock.clone(), blobs, on_tool_result, stamp);
    // The system messages are the header's prompt fields, in Node's order and tiers (WP-PROMPT).
    let mut messages = system_messages(&header);
    // The context before the input row with the item each message is, for the rewrite a cancelled turn ends with.
    let mut history: Vec<(ItemId, AgentMessage)> = Vec::new();
    for (iid, body) in stored {
        // A stored row the codec cannot read fails the turn: dropping it would change the context.
        let message = match message_of(&body) {
            Ok(message) => message,
            Err(error) => return failed(format!("the model context holds a row this build cannot read: {error}"), body),
        };
        if let Some(id) = &message.message_id {
            lock(&sink.iids).insert(id.clone(), iid.clone());
        }
        history.push((iid, message.clone()));
        rows.record(&message, body);
        messages.push(message);
    }
    let input_text = input.text();
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
        // The worker-turn registry's stop (`abortOnTimeout`, `agent-watchdog-registry.mjs:30-33`): the reap is armed, then the stop is
        // recorded with what the sweep judged, then the abort.
        let (stall_log, stall_agent, site) = (failures.clone(), agent.map(str::to_owned), StallSite::Registry { registration_id: registration_id() });
        let anchor_ts = clock.now_ms();
        Watchdog::arm(true, policy, signal.clone(), clock.clone(), move |now| watched.borrow().snapshot(now), move |snapshot: &Snapshot, message: &str, now: i64| {
            reaper.reap_turn_shells(&reaped_thread, asked_at);
            if let Some(log) = stall_log {
                log.stall_abort(stall_abort_ctx(reaped_thread.as_str(), stall_agent.as_deref(), &site, &policy, anchor_ts, snapshot, message, now));
            }
        })
    } else {
        None
    };
    // The quiet-time cue of a turn a person watches (`startQuietWatch` in the lead turn, `turn.mjs:781`), against the lead's warn point.
    let quiet_watch = (!unattended).then(|| {
        let warn_ms = mixdog_agent::agent_tool::watchdog::stall_warn_ms(AgentKind { name: Some("lead"), ..AgentKind::default() }, &|name: &str| std::env::var(name).ok());
        QuietWatch::start(quiet_changes, port.clone(), clock.clone(), Arc::new(TimerWait), warn_ms as f64)
    });
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
                Shown::Check(check) => shown_port.send_check(check).await,
                Shown::SearchUsage(delta) => shown_port.search_usage(delta).await,
                Shown::Stage(stage, detail) => shown_port.stage(stage, detail).await,
                Shown::Pass(pass) => shown_port.compact_pass(pass).await,
                Shown::ToolStream => shown_port.tool_stream().await,
                Shown::CompactUsage(report) => shown_port.compact_usage(report).await,
                Shown::Barrier(done) => {
                    let _ = done.send(());
                    Ok(())
                }
            };
        }
    }));
    // `registerNativeWebSearchUsageSink(session.id, options.onNativeWebSearchUsage)` (`turn-run.mjs`): from the first send to the
    // ask's end the newest entry of this thread's session hears every search the turn runs, in the order the other reports reach the port.
    let search_tx = shown_tx.clone();
    let hears_search = search_usage.register(thread.as_str(), Arc::new(move |delta| {
        let _ = search_tx.send(Shown::SearchUsage(delta));
    }));
    let observer = Arc::new(PortObserver { observed: observed.clone(), progress: progress.clone(), out: shown_tx, streaming, reasoning: Mutex::new(None), last_send_tools: Mutex::new(Vec::new()), chunked: std::sync::atomic::AtomicBool::new(false), live: live.clone(), rows: rows.clone(), cancel: cancel.clone(), context: context.clone() });
    let closing = observer.clone();

    config.thread_id = thread.clone();
    config.turn_id = turn.clone();
    config.signal = Some(signal.clone());
    config.first_request_after = Some(Ticket(0));
    let gate: Arc<dyn ToolGate> = Arc::new(ReviewGate::new(review, gate(GateContext { observer: observer.clone(), cancel: cancel.clone(), guards: guards.clone(), approvals: Arc::new(port.clone()) })));
    let skills = skills.map(|build| build(SkillContext { gate: gate.clone(), env: tool_env.clone(), cancel: cancel.clone() }));
    // `prepareExplicitSkills` before the first request of a turn whose input is a prompt (no `promptSource`, not a
    // retry): the loaded skills' rows follow the input row, which records their names (`recordAppliedSkills`).
    let retry = submitted.options.as_ref().and_then(|options| options.retry_turn_id.as_deref()).is_some_and(|id| !id.is_empty());
    if let Some(selector) = skills.as_ref().filter(|_| !injected && !retry)
        && let Some(content) = messages.last().map(|input| input.message.content.clone())
    {
        let mut selected = Vec::new();
        let applied = selector.select(&content, &mut selected).await;
        if !applied.is_empty() && port.applied_skills(applied).await.is_err() {
            return failed("the turn's applied skills could not be saved", Value::Null);
        }
        for message in selected {
            if let Err(error) = sink.commit(&message).await {
                return failed(error.to_string(), Value::Null);
            }
            messages.push(message);
        }
    }
    let guard_state = guards.clone();
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
        compactor: compactor.map(|inner| Arc::new(super::goal_reminder_compactor::GoalReminderCompactor::new(inner, port.clone())) as Arc<dyn Compactor>),
        route,
        skills,
        hooks,
        reuse,
        reactions,
        tail,
        mcp: Some(Arc::new(ThreadMcp { parts: parts.clone(), thread: thread.clone(), surface: surface.clone() })),
        side,
        step_judge,
        artifacts,
        images,
        failures,
    };
    // Node's `_api_call_with_interrupt` spans `agentLoop`: an abort inside reads "during call".
    progress.model_loop(true);
    let provider_id = provider.id().as_str().to_owned();
    let result = Run::new(env, cancel.clone(), provider, tools, tool_env, config, messages, carry).run().await;
    progress.model_loop(false);
    // `releaseWebSearchUsage?.()` after `askSession`.
    drop(hears_search);
    // The model work is over: the watchdog, which judges only that, stops here.
    drop(watchdog);
    closing.end_reasoning();
    // No hint is published once the run's outcome is on its way: the run owns the runtime section.
    hints.finish().await;
    if let Some(quiet_watch) = quiet_watch {
        quiet_watch.finish().await;
    }
    // The guard state that outlives one ask lives on the session record (`session.todoCheck`, `session._repeat*`).
    // A cancelled run's token has fired, but Node saves after the abort (`finalizeCancelledTurn`).
    let end_port = if cancel.is_cancelled() { port.closing() } else { port.clone() };
    {
        let carry = match &result {
            Ok(output) => &output.carry,
            Err(failure) => &failure.carry,
        };
        let mut set = carry.to_saved();
        if let Some(check) = guard_state.saved() {
            set.insert("todoCheck".into(), check);
        }
        let _ = end_port.save_header(mixdog_store::schema::record::HeaderChange { set, unset: Vec::new() }).await;
    }
    match result {
        Ok(output) => {
            // The loop ends on the terminal answer without committing it (Node's turn commit does):
            // history keeps only the terminal segment.
            let mut terminal = output.response.clone();
            if let Some(segment) = &output.response.history_content {
                terminal.content.clone_from(segment);
            }
            let mut transcript = output.transcript.clone();
            if let Some(mut message) = mixdog_agent::response::intermediate_message(&terminal) {
                message.message_id = Some(sink.message_id());
                message.turn_reminder.clone_from(&output.last_reminder);
                *lock(&sink.terminal) = Some((output.iterations, output.tool_calls_total));
                if let Err(error) = sink.commit(&message).await {
                    sink.flush().await;
                    sink.live.clear();
                    progress.error();
                    return failed(error.to_string(), Value::Null);
                }
                transcript.push(message);
            }
            sink.flush().await;
            // `settleAskTurn`: the ask's usage and transcript reach the header once every call's report
            // has (the port's lane keeps their order).
            let _ = closing.barrier().await;
            let settled = mixdog_core_session::session::run::Settled {
                transcript,
                usage: output.usage.clone(),
                last_turn_usage: output.last_turn_usage.clone(),
                tool_calls_total: output.tool_calls_total,
                send_tools: lock(&closing.last_send_tools).clone(),
                response_model: output.response.model.clone(),
                asked_at_ms: asked_at,
            };
            let _ = port.settled(settled).await;
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
                close_cancelled(&end_port, &sink, &rows, &history, &input_item, &input_text, &observed, signal.close_reason()).await;
                return RunOutcome::Interrupted;
            }
            progress.error();
            let data = if failure.carried_report.is_empty() { Value::Null } else { json!({ "carriedReport": failure.carried_report }) };
            // A provider's refusal keeps what `turnFailureRecord` reads off it: kind, status, code, retry advice and
            // reset (`provider_turn_error`); any other failure is its message.
            if let AgentError::Provider(error) = &failure.error {
                return RunOutcome::Failed(provider_turn_error(error, &provider_id, data));
            }
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
    use mixdog_core_session::session::testing::{Rig, eventually_on_awaiting};
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
        fn on_wire_left(&mut self, _left: std::sync::Arc<dyn Fn() + Send + Sync>) {}
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
        provider: Arc<dyn ProviderAdapter>,
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
                    review: None,
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
                failures: None,
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
        deps.runs = Arc::new(RunHostFactory::new(mixdog_services::task_reports::runtime_state::RuntimeLiveness::new(), mixdog_tools::web::NativeSearchUsageSinks::new(), Arc::new(Parts { provider: provider.clone(), workspace: workspace.path().to_path_buf(), more: Vec::new(), settle: None })));
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
        // Woken by each step of the thread's actor, which acknowledges each row after the store holds it.
        eventually_on_awaiting(|| "the four-role transcript (user, assistant, tool, assistant) in the store".to_owned(), &[handle.stepped()], || (roles().len() >= 4).then_some(())).await;
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

    /// A provider's notice (the Gemini redirect) goes the whole way a client reads it: the stream event, the loop's
    /// stage notice, the run host's shown event, the session's live row and the frame the thread's feed publishes (the
    /// feed desktop and phone both follow). The message and tone are the Node recording's, and the row is the one the
    /// real TUI/desktop notice surface made of it.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_providers_notice_reaches_the_threads_clients_as_the_row_node_showed() {
        let text = mixdog_testkit::fixture!("../../fixtures/wire-anthropic-gemini/gemini.json");
        let recorded: Value = serde_json::from_str(&text).expect("the Gemini recording");
        let send = &recorded["scenarios"].as_array().unwrap().iter().find(|s| s["id"] == "pro25.boundary-at").expect("the redirect scenario")["sends"][0];
        let (notice, row) = (&send["notices"][0], &send["noticeRows"][0]);
        let provider = Arc::new(Scripted {
            id: ProviderId::from("scripted"),
            policy: RetryPolicy::codex_default(),
            keepalive: KeepaliveSchedule::SPEC,
            codec: MockCodec,
            script: Mutex::new(VecDeque::from([vec![
                StreamEvent::Notice { message: notice["message"].as_str().unwrap().to_owned(), warn: notice["tone"] == "warn" },
                StreamEvent::TextDelta("hello".into()),
                StreamEvent::Completed { stop: Some(StopReason::EndTurn), pricing_model: None, request_ms: None },
            ]])),
            requests: Mutex::new(Vec::new()),
            fail_first: std::sync::atomic::AtomicBool::new(false),
        });
        let workspace = tempfile::tempdir().unwrap();
        let rig = Rig::new();
        let mut deps = rig.deps_parts(rig.store.clone());
        deps.runs = Arc::new(RunHostFactory::new(mixdog_services::task_reports::runtime_state::RuntimeLiveness::new(), mixdog_tools::web::NativeSearchUsageSinks::new(), Arc::new(Parts { provider: provider.clone(), workspace: workspace.path().to_path_buf(), more: Vec::new(), settle: None })));
        let directory = SessionDirectory::new(Arc::new(deps));
        let reply = directory.request(request("thread/start", json!({ "opId": "op-start", "kind": "task", "projectPath": "/ws" }), "op-start")).await.expect("thread/start");
        let Reply::Subscribe(subscribe) = reply else { panic!("thread/start subscribes") };
        let id = ThreadId::from(subscribe.result["thread"]["id"].as_str().expect("thread id"));
        let handle = directory.handle(&id).expect("loaded");
        handle.request(request("turn/start", json!({ "threadId": id, "opId": "op-1", "input": { "prompt": "go" } }), "op-1")).await.expect("turn/start");
        // Woken by each step of the thread's actor; the frame is searched for before waiting.
        let shown = mixdog_rt::time::timeout(std::time::Duration::from_secs(30), async { loop {
            let stepped = handle.stepped().notified();
            tokio::pin!(stepped);
            stepped.as_mut().enable();
            let found = rig.feeds.frames(id.as_str()).into_iter().find_map(|(_, _, params)| {
                let text = row["text"].as_str().unwrap();
                // The row's text and tone sit in the item's `meta`; its `kind` is on the item that holds them.
                let mut stack = vec![(params, Value::Null)];
                while let Some((value, kind)) = stack.pop() {
                    match value {
                        Value::Object(mut map) if map.get("text").and_then(Value::as_str) == Some(text) => {
                            map.entry("kind").or_insert(kind);
                            return Some(Value::Object(map));
                        }
                        Value::Object(map) => {
                            let kind = map.get("kind").cloned().unwrap_or(kind);
                            stack.extend(map.into_iter().map(|(_, v)| (v, kind.clone())));
                        }
                        Value::Array(all) => stack.extend(all.into_iter().map(|v| (v, kind.clone()))),
                        _ => {}
                    }
                }
                None
            });
            if let Some(found) = found {
                break found;
            }
            stepped.await;
        } })
        .await
        .expect("the thread's feed never published the provider's notice within 30 s");
        assert_eq!((shown["kind"].clone(), shown["text"].clone(), shown["tone"].clone()), (row["kind"].clone(), row["text"].clone(), row["tone"].clone()), "{shown}");
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
        deps.runs = Arc::new(RunHostFactory::new(mixdog_services::task_reports::runtime_state::RuntimeLiveness::new(), mixdog_tools::web::NativeSearchUsageSinks::new(), Arc::new(Parts { provider: provider.clone(), workspace: workspace.path().to_path_buf(), more: Vec::new(), settle: Some(settle.clone()) })));
        let directory = SessionDirectory::new(Arc::new(deps));
        let reply = directory.request(request("thread/start", json!({ "opId": "op-start", "kind": "task", "projectPath": "/ws" }), "op-start")).await.expect("thread/start");
        let Reply::Subscribe(subscribe) = reply else { panic!("thread/start subscribes") };
        let id = ThreadId::from(subscribe.result["thread"]["id"].as_str().expect("thread id"));
        let handle = directory.handle(&id).expect("loaded");
        handle.request(request("turn/start", json!({ "threadId": id, "opId": "op-1", "input": { "prompt": "go" } }), "op-1")).await.expect("turn/start");
        eventually_on_awaiting(|| "the assistant's answer in the store".to_owned(), &[handle.stepped()], || {
            let answered = rig.store.records(&id).into_iter().any(|(_, record)| matches!(record, Record::Item(item) if matches!(&item.body, Slot::Inline(body) if body["role"] == "assistant")));
            answered.then_some(())
        })
        .await;
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
        deps.runs = Arc::new(RunHostFactory::new(mixdog_services::task_reports::runtime_state::RuntimeLiveness::new(), mixdog_tools::web::NativeSearchUsageSinks::new(), Arc::new(Parts { provider: provider.clone(), workspace: workspace.path().to_path_buf(), more: Vec::new(), settle: None })));
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
                // Woken by each step of the thread's actor, which is where a run's end is acknowledged after its record is stored.
                eventually_on_awaiting(|| format!("the end record of run {want} in the store (turn {op})"), &[handle.stepped()], || (ended() >= want).then_some(())).await;
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

    /// A conversation whose settings moved since its prompt: the notice staged on its header reaches the model with the
    /// next turn that is accepted, once (`ask-turn-prepare.mjs:204`, `ask-turn-settle.mjs:155-156`; the notice, the
    /// carrying message and the settled header are `fixtures/prompt-notice-turn`, the first case). A turn the provider
    /// refuses acknowledges nothing, so the notice stays pending and the turn after it carries it; the turn after that
    /// carries nothing new.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_staged_settings_notice_reaches_the_model_once_and_a_failed_turn_leaves_it_pending() {
        let twin: Value = serde_json::from_str(include_str!("../../../../fixtures/prompt-notice-turn/twin.json")).unwrap();
        let case = &twin["cases"][0];
        let done = |text: &str| vec![StreamEvent::TextDelta(text.into()), StreamEvent::Completed { stop: Some(StopReason::EndTurn), pricing_model: None, request_ms: None }];
        let provider = Arc::new(Scripted {
            id: ProviderId::from("scripted"),
            policy: RetryPolicy::codex_default(),
            keepalive: KeepaliveSchedule::SPEC,
            codec: MockCodec,
            script: Mutex::new(VecDeque::from([done("two"), done("three")])),
            requests: Mutex::new(Vec::new()),
            fail_first: std::sync::atomic::AtomicBool::new(true),
        });
        let workspace = tempfile::tempdir().unwrap();
        let rig = Rig::new();
        let mut deps = rig.deps_parts(rig.store.clone());
        deps.runs = Arc::new(RunHostFactory::new(mixdog_services::task_reports::runtime_state::RuntimeLiveness::new(), mixdog_tools::web::NativeSearchUsageSinks::new(), Arc::new(Parts { provider: provider.clone(), workspace: workspace.path().to_path_buf(), more: Vec::new(), settle: None })));
        let directory = SessionDirectory::new(Arc::new(deps));
        let reply = directory.request(request("thread/start", json!({ "opId": "op-start", "kind": "task", "projectPath": "/ws" }), "op-start")).await.expect("thread/start");
        let Reply::Subscribe(subscribe) = reply else { panic!("thread/start subscribes") };
        let id = ThreadId::from(subscribe.result["thread"]["id"].as_str().expect("thread id"));
        let handle = directory.handle(&id).expect("loaded");
        // The settings moved: what `stage_prompt_settings_notice` leaves on the header at a turn start.
        let threads = mixdog_core_session::session::thread_state::SessionThreads::new(Arc::new(directory));
        use mixdog_core_ports::ports::threads::ThreadState;
        // The same turn also carries a workflow switch, a prepared worktree's report and a deferred-tool delta, staged as
        // Node leaves them (`fixtures/turn-reminders`).
        let reminders: Value = serde_json::from_str(mixdog_testkit::fixture!("../../fixtures/turn-reminders/twin.json")).unwrap();
        let session_of = |name: &str| reminders["cases"].as_array().unwrap().iter().find(|case| case["name"] == name).unwrap()["session"].clone();
        let (switched, setup, delta) = (session_of("workflow-carried-by-prompt"), session_of("setup-notice"), session_of("deferred-delta-removals-only"));
        let staged: serde_json::Map<String, Value> = [
            ("promptSettings".to_owned(), case["startRecord"].clone()),
            ("promptSettingsNotice".to_owned(), case["pending"].clone()),
            ("promptSettingsNoticeRevision".to_owned(), case["pending"]["revision"].clone()),
            ("workflowSwitch".to_owned(), switched["workflowSwitch"].clone()),
            ("pendingSetupNotice".to_owned(), setup["pendingSetupNotice"].clone()),
            ("pendingDeferredToolDelta".to_owned(), delta["pendingDeferredToolDelta"].clone()),
            ("deferredToolDeltaRevision".to_owned(), delta["deferredToolDeltaRevision"].clone()),
            ("deferredMcpToolNames".to_owned(), delta["deferredMcpToolNames"].clone()),
        ]
        .into_iter()
        .collect();
        threads.patch_header(&id, staged, Vec::new()).await.expect("staged");

        let ended = || {
            rig.store
                .records(&id)
                .into_iter()
                .filter(|(_, record)| matches!(record, Record::Run(run) if matches!(run.phase, mixdog_store::schema::record::RunPhase::Completed | mixdog_store::schema::record::RunPhase::Failed)))
                .count()
        };
        let turn = |prompt: &str, op: &str, want: usize| {
            let (handle, op, thread, prompt) = (handle.clone(), op.to_owned(), id.clone(), prompt.to_owned());
            let ended = &ended;
            async move {
                // The settle writes the acknowledgement of what the turn carried, then the run's end record, then the
                // turn's coverage stamp (`actor.rs` settle; Node: `commitAskTurn` acknowledges, `ask-turn-settle.mjs:148-164`,
                // before the turn is published). The header a client reads follows only once each is acked, and the store
                // already holds the end record before that, so the end record alone does not say the header is settled:
                // the coverage stamp, the last of them, does.
                let covered = || handle.header_snapshot().get("turnCoverage").cloned();
                let before = covered();
                handle.request(request("turn/start", json!({ "threadId": thread, "opId": op, "input": { "prompt": prompt } }), &op)).await.expect("turn/start");
                eventually_on_awaiting(|| format!("the end record of run {want} and the changed turnCoverage stamp (turn {op})"), &[handle.stepped()], || (ended() >= want && covered() != before).then_some(())).await;
            }
        };
        let header = || async { threads.header(&id).await.expect("header") };

        turn("one", "op-1", 1).await;
        assert!(lock(&provider.requests).is_empty(), "the first attempt was refused");
        let after_failure = header().await;
        assert_eq!(after_failure["promptSettingsNotice"], case["failed"]["notice"], "a failed turn acknowledges nothing");
        for key in ["workflowSwitch", "pendingSetupNotice", "pendingDeferredToolDelta"] {
            assert!(after_failure.get(key).is_some(), "a failed turn leaves {key} pending");
        }

        turn("two", "op-2", 2).await;
        let settled = header().await;
        let after = &case["after"];
        assert!(settled.get("promptSettingsNotice").is_none(), "the accepted turn acknowledged the notice");
        for key in ["workflowSwitch", "pendingSetupNotice", "pendingDeferredToolDelta"] {
            assert!(settled.get(key).is_none(), "the accepted turn acknowledged {key}");
        }
        assert_eq!(settled["promptSettingsTold"], after["told"]);
        assert_eq!(settled["promptSettingsNoticeRevision"], after["revision"]);

        turn("three", "op-3", 3).await;
        let requests = lock(&provider.requests).clone();
        assert_eq!(requests.len(), 2);
        // The turn's own message is the last one of its request.
        let last = |request: &ModelRequest| format!("{:?}", request.messages.last().expect("a message").content);
        assert!(last(&requests[0]).contains("Core memory was updated"), "the accepted turn's request carries the notice");
        assert!(last(&requests[0]).contains("two"));
        for marker in ["# Workflow Changed", "# Worktree Prepared", "<deferred_tools_delta>"] {
            assert!(last(&requests[0]).contains(marker), "the accepted turn's request carries {marker}");
            assert!(!last(&requests[1]).contains(marker), "the next turn does not carry {marker} again");
        }
        assert!(!last(&requests[1]).contains("Core memory was updated"), "the next turn carries nothing new");
        assert!(header().await.get("promptSettingsNotice").is_none());
    }
    /// A provider that refuses every attempt with `error`.
    struct Refusing {
        id: ProviderId,
        policy: RetryPolicy,
        keepalive: KeepaliveSchedule,
        codec: MockCodec,
        error: ProviderError,
    }

    #[async_trait]
    impl ProviderAdapter for Refusing {
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
        async fn attempt(&self, _: Arc<ModelRequest>) -> Result<Box<dyn ModelStream>, ProviderError> {
            Err(self.error.clone())
        }
    }

    /// A production failed turn: the provider refuses on exhausted quota and names the reset. The run ends with the
    /// facts Node's `turnFailureRecord` reads off that error (`fixtures/turn-failure`, the first case), the row's
    /// completion stores them, the turn end is shown, and the quota settlement that reads it queues the auto-resume at
    /// Node's reset. Nothing here waits on a clock: the store tells when the entry is queued.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_quota_failed_run_stores_nodes_failure_record_and_queues_the_resume_at_its_reset() {
        let gold: Value = serde_json::from_str(include_str!("../../../../fixtures/turn-failure/golden.json")).unwrap();
        let case = &gold["cases"][0];
        assert_eq!(case["name"], "quota with a provider-named reset");
        let reset = gold["resetAt"].as_u64().expect("the recorded reset");
        let mut refusal = ProviderError::new(mixdog_core_api::domain::provider::ErrorKind::QuotaExhausted, DeliveryState::Accepted);
        refusal.status = Some(429);
        refusal.code = case["fields"]["code"].as_str().map(str::to_owned);
        refusal.message = case["message"].as_str().unwrap().to_owned();
        refusal.reset_at = Some(std::time::UNIX_EPOCH + Duration::from_millis(reset));
        let provider = Arc::new(Refusing { id: ProviderId::from("anthropic-oauth"), policy: RetryPolicy::codex_default(), keepalive: KeepaliveSchedule::SPEC, codec: MockCodec, error: refusal });
        let workspace = tempfile::tempdir().unwrap();
        let rig = Rig::new();
        let woke = Arc::new(tokio::sync::Notify::new());
        let _subscription = {
            let woke = woke.clone();
            rig.quota.subscribe(move |_| woke.notify_one())
        };
        let mut deps = rig.deps_parts(rig.store.clone());
        deps.runs = Arc::new(RunHostFactory::new(mixdog_services::task_reports::runtime_state::RuntimeLiveness::new(), mixdog_tools::web::NativeSearchUsageSinks::new(), Arc::new(Parts { provider, workspace: workspace.path().to_path_buf(), more: Vec::new(), settle: None })));
        let directory = SessionDirectory::new(Arc::new(deps));
        let reply = directory.request(request("thread/start", json!({ "opId": "op-start", "kind": "task", "projectPath": "/ws" }), "op-start")).await.expect("thread/start");
        let Reply::Subscribe(subscribe) = reply else { panic!("thread/start subscribes") };
        let id = ThreadId::from(subscribe.result["thread"]["id"].as_str().expect("thread id"));
        let handle = directory.handle(&id).expect("loaded");
        // A session has the route it runs on (Node requires a provider and a model), which the quota stop names and
        // the resume entry requires.
        let route = case["route"].clone();
        let patch = json!({ "threadId": id, "set": { "provider": route["provider"], "model": route["model"] }, "unset": [] });
        handle.request(CoreRequest { method: Method("thread/header/patch"), params: patch, op: None, ctx: CallContext::internal("test") }).await.expect("route");
        handle.request(request("turn/start", json!({ "threadId": id, "opId": "op-1", "input": { "prompt": "go" } }), "op-1")).await.expect("turn/start");
        let entry = eventually_on_awaiting(|| "the quota entry for the failed run's thread".to_owned(), &[&*woke], || rig.quota.entry(id.as_str())).await;
        assert_eq!(entry.to_value()["resetAt"].as_f64(), Some(reset as f64), "the resume waits for the reset the provider named");

        let completion = rig
            .store
            .records(&id)
            .into_iter()
            .find_map(|(_, record)| match record {
                Record::Amend(amend) => match amend.body {
                    Slot::Inline(body) => body.pointer("/meta/transcript/completion").cloned(),
                    _ => None,
                },
                _ => None,
            })
            .expect("the failed turn's row records its end");
        assert_eq!(completion["status"], "failed");
        assert_eq!(completion["errorKind"], case["errorKind"]);
        assert_eq!(completion["detail"], case["detail"]);
        assert_eq!(completion["errorDetails"], case["errorDetails"]);
        assert_eq!(completion["quota"]["resetAt"], case["quota"]["resetAt"]);
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
        deps.runs = Arc::new(RunHostFactory::new(mixdog_services::task_reports::runtime_state::RuntimeLiveness::new(), mixdog_tools::web::NativeSearchUsageSinks::new(), Arc::new(Parts { provider, workspace: workspace.path().to_path_buf(), more: vec![Arc::new(reporter)], settle: None })));
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
        mixdog_core_session::session::testing::awaiting(|| "the report tool to be called".to_owned(), reported.notified()).await;
        eventually_on_awaiting(|| "the tool-output hint with outputTail \"compiling\" published to the thread's clients".to_owned(), &[&rig.feeds.published], || hints().contains(&json!({ "outputTail": "compiling" })).then_some(())).await;
        release.notify_one();
        eventually_on_awaiting(|| "the tool-output hint withdrawn (a null hint published last) after the tool ends".to_owned(), &[&rig.feeds.published], || (hints().last() == Some(&Value::Null)).then_some(())).await;
    }

    /// A tool that spends like a hosted web search: it reports its delta to the usage registry under the asking thread.
    struct Searcher {
        spec: ToolSpec,
        sinks: Arc<mixdog_tools::web::NativeSearchUsageSinks>,
        delta: Value,
    }

    #[async_trait]
    impl Tool for Searcher {
        fn spec(&self) -> &ToolSpec {
            &self.spec
        }
        async fn call(&self, ctx: &ToolContext, _args: JsonValue) -> ToolOutcome {
            self.sinks.report(Some(ctx.thread_id.as_str()), || self.delta.clone());
            Ok(ToolOutput { parts: vec![ToolPart::Text("searched".into())], ..ToolOutput::default() })
        }
    }

    /// `registerNativeWebSearchUsageSink` (`turn-run.mjs`): a search a turn's tool runs reaches the thread's clients as
    /// `thread/tokenUsage/updated` with the search's own delta (recorded from Node, `mixdog-cli/tests/record_search_usage.mjs`).
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_search_a_turns_tool_runs_is_heard_by_the_thread() {
        let golden: Value = serde_json::from_str(include_str!("../../../mixdog-cli/tests/goldens/exec_search_usage.json")).unwrap();
        let delta = golden["search"][0].clone();
        let provider = Arc::new(Scripted {
            id: ProviderId::from("scripted"),
            policy: RetryPolicy::codex_default(),
            keepalive: KeepaliveSchedule::SPEC,
            codec: MockCodec,
            script: Mutex::new(VecDeque::from([
                vec![
                    StreamEvent::ToolCallDone(ToolCall { id: "c1".into(), name: "search".into(), arguments: json!({}), native_type: None }),
                    StreamEvent::Completed { stop: Some(StopReason::ToolUse), pricing_model: None, request_ms: None },
                ],
                vec![StreamEvent::TextDelta("ok".into()), StreamEvent::Completed { stop: Some(StopReason::EndTurn), pricing_model: None, request_ms: None }],
            ])),
            requests: Mutex::new(Vec::new()),
            fail_first: std::sync::atomic::AtomicBool::new(false),
        });
        let sinks = mixdog_tools::web::NativeSearchUsageSinks::new();
        let searcher = Searcher {
            spec: ToolSpec {
                name: "search".into(),
                title: None,
                trigger: None,
                public: true,
                aliases: Vec::new(),
                description: "search".into(),
                input_schema: json!({ "type": "object" }),
                annotations: ToolAnnotations { read_only_hint: Some(true), idempotent_hint: Some(true), ..ToolAnnotations::default() },
                parallel_safe: true,
                exclusive_with: Vec::new(),
            },
            sinks: sinks.clone(),
            delta: delta.clone(),
        };
        let workspace = tempfile::tempdir().unwrap();
        let rig = Rig::new();
        let mut deps = rig.deps_parts(rig.store.clone());
        deps.runs = Arc::new(RunHostFactory::new(mixdog_services::task_reports::runtime_state::RuntimeLiveness::new(), sinks, Arc::new(Parts { provider, workspace: workspace.path().to_path_buf(), more: vec![Arc::new(searcher)], settle: None })));
        let directory = SessionDirectory::new(Arc::new(deps));
        let reply = directory.request(request("thread/start", json!({ "opId": "op-start", "kind": "task", "projectPath": "/ws" }), "op-start")).await.expect("thread/start");
        let Reply::Subscribe(subscribe) = reply else { panic!("thread/start subscribes") };
        let id = ThreadId::from(subscribe.result["thread"]["id"].as_str().expect("thread id"));
        let handle = directory.handle(&id).expect("loaded");
        handle.request(request("turn/start", json!({ "threadId": id, "opId": "op-1", "input": { "prompt": "go" } }), "op-1")).await.expect("turn/start");

        let heard = || -> Vec<Value> {
            rig.feeds.frames(id.as_str()).into_iter().filter(|(_, method, _)| method == "thread/tokenUsage/updated").map(|(_, _, params)| params["usage"].clone()).collect()
        };
        // Woken by each step of the thread's actor.
        eventually_on_awaiting(|| "the thread/tokenUsage/updated frame carrying the usage delta".to_owned(), &[handle.stepped()], || heard().contains(&delta).then_some(())).await;
        assert_eq!(heard().iter().filter(|usage| **usage == delta).count(), 1);
    }

    /// The account pool's two notices reach the thread once each, as status and as thread state (Node
    /// `applyStageChange`), never as transcript rows: on a direct run and on one whose provider answers through the
    /// model proxy's wire.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn the_pools_switching_and_changed_notices_reach_the_thread_once_each() {
        use mixdog_core_api::domain::provider::AccountStage;
        use mixdog_core_domains::domains::ai_admin::model_proxy as proxy;
        let switching = "Quota exhausted — switching to the next account";
        let events = vec![
            StreamEvent::AccountStage(AccountStage::Switching { message: switching.into() }),
            StreamEvent::TextDelta("ok".into()),
            StreamEvent::AccountStage(AccountStage::Changed { provider: "custom-x".into(), account_id: "k2".into(), at: 7 }),
            StreamEvent::Completed { stop: Some(StopReason::EndTurn), pricing_model: None, request_ms: None },
        ];
        let crossed: Vec<StreamEvent> = events
            .iter()
            .map(|event| {
                let wire = serde_json::to_value(proxy::event_out(event)).unwrap();
                match proxy::event_in(serde_json::from_value(wire).unwrap()).unwrap() {
                    proxy::Incoming::Event(event) => event,
                    other => panic!("{other:?}"),
                }
            })
            .collect();
        for (how, script) in [("direct", events.clone()), ("model proxy", crossed)] {
            let provider = Arc::new(Scripted {
                id: ProviderId::from("custom-x"),
                policy: RetryPolicy::codex_default(),
                keepalive: KeepaliveSchedule::SPEC,
                codec: MockCodec,
                script: Mutex::new(VecDeque::from([script])),
                requests: Mutex::new(Vec::new()),
                fail_first: std::sync::atomic::AtomicBool::new(false),
            });
            let workspace = tempfile::tempdir().unwrap();
            let rig = Rig::new();
            let mut deps = rig.deps_parts(rig.store.clone());
            deps.runs = Arc::new(RunHostFactory::new(mixdog_services::task_reports::runtime_state::RuntimeLiveness::new(), mixdog_tools::web::NativeSearchUsageSinks::new(), Arc::new(Parts { provider, workspace: workspace.path().to_path_buf(), more: Vec::new(), settle: None })));
            let directory = SessionDirectory::new(Arc::new(deps));
            let reply = directory.request(request("thread/start", json!({ "opId": "op-start", "kind": "task", "projectPath": "/ws" }), "op-start")).await.expect("thread/start");
            let Reply::Subscribe(subscribe) = reply else { panic!("thread/start subscribes") };
            let id = ThreadId::from(subscribe.result["thread"]["id"].as_str().expect("thread id"));
            let handle = directory.handle(&id).expect("loaded");
            handle.request(request("turn/start", json!({ "threadId": id, "opId": "op-1", "input": { "prompt": "go" } }), "op-1")).await.expect("turn/start");
            let frames = |method: &str| -> Vec<Value> { rig.feeds.frames(id.as_str()).into_iter().filter(|(_, m, _)| m == method).map(|(_, _, params)| params).collect() };
            eventually_on_awaiting(|| format!("{how}: the turn's end"), &[handle.stepped()], || (!frames("turn/completed").is_empty()).then_some(())).await;
            let stages = frames("thread/stage/updated");
            assert_eq!(stages, [json!({ "threadId": id, "stage": "reconnecting", "detail": { "message": switching } })], "{how}: the switching status, once");
            let changed: Vec<Value> = frames("thread/providerAccount/changed").into_iter().filter(|p| p.to_string().contains("\"k2\"")).collect();
            assert_eq!(changed.len(), 1, "{how}: the account change, once: {changed:?}");
            let rows = serde_json::to_string(&rig.feeds.frames(id.as_str()).into_iter().filter(|(_, m, _)| m.starts_with("item/")).collect::<Vec<_>>()).unwrap();
            assert!(!rows.contains(switching), "{how}: the switching message is not a transcript row");
        }
    }

    // ---- the real assembly -------------------------------------------------------------------------

    struct OneProvider(Arc<dyn ProviderAdapter>);

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
        fn synced_compaction(&self, _: &mixdog_store::schema::record::Header, _: bool) -> Option<Value> {
            None
        }
        fn route_config(&self, _: &mixdog_store::schema::record::Header) -> mixdog_app_protocol::v2::thread::ThreadRoute {
            Default::default()
        }
        fn settings_changes(&self, _: &mixdog_core_api::ids::ThreadId) -> Option<mixdog_core_session::session::turn_ops::SettingsFeed> {
            None
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
        fn tools(&self, _: Option<&str>, _: &std::path::Path) -> Vec<Arc<dyn Tool>> {
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


    struct PoolResolver(Vec<Arc<dyn Tool>>);
    impl mixdog_tools::policy::ToolResolver for PoolResolver {
        fn resolve(&self, _scope: Option<&str>, name: &str) -> Option<Arc<dyn Tool>> {
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
    struct Ledger(Mutex<Vec<mixdog_ai::registry::accounting::UsageRow>>, tokio::sync::Notify);
    #[async_trait]
    impl mixdog_ai::registry::accounting::UsageSink for Ledger {
        async fn record_queued(&self, row: mixdog_ai::registry::accounting::UsageRow) -> Result<(), String> {
            lock(&self.0).push(row);
            self.1.notify_waiters();
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

    /// Every thread is open for a hop; a hop never runs here (the scripted provider never fails), so the session's writes refuse.
    struct OpenHopSessions;
    impl mixdog_core_run::run_host::hop_host::HopSessions for OpenHopSessions {
        fn open(&self, _: &ThreadId) -> Option<Arc<dyn mixdog_core_run::run_host::hop_host::HopSession>> {
            Some(Arc::new(NoHopWrites))
        }
    }
    struct NoHopWrites;
    #[async_trait]
    impl mixdog_core_run::run_host::hop_host::HopSession for NoHopWrites {
        fn header(&self) -> Option<Arc<mixdog_store::schema::record::Header>> {
            None
        }
        async fn write_hop(&self, _: mixdog_core_ports::ports::domain_sessions::Obj, _: &mixdog_core_run::run_host::route_fallback::HopWrite) -> Result<Option<mixdog_store::schema::record::Header>, mixdog_tools::orch::util::PortError> {
            unreachable!("no hop in this test")
        }
        async fn write_wire_pin(&self, _: Value) -> Result<(), mixdog_tools::orch::util::PortError> {
            unreachable!("no hop in this test")
        }
        async fn rebuild_tool_surface(&self, _: &str) -> Result<(), mixdog_tools::orch::util::PortError> {
            unreachable!("no hop in this test")
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

    /// Notes every thread the assembly asks where its approvals go.
    #[derive(Default)]
    struct AskedFor(Mutex<Vec<String>>);
    impl crate::run_host::run_approvals::RunApprovals for AskedFor {
        fn gate_for(&self, thread: &ThreadId, own: Arc<dyn mixdog_core_api::domain::approval::ApprovalGate>) -> Arc<dyn mixdog_core_api::domain::approval::ApprovalGate> {
            lock(&self.0).push(thread.as_str().to_owned());
            own
        }
    }

    /// The composition of a turn: TurnPath::new over test implementations of the missing owner traits and the scripted
    /// provider behind the accounted registry.
    struct World {
        workspace: tempfile::TempDir,
        rig: Rig,
        ledger: Arc<Ledger>,
        asked: Arc<AskedFor>,
        store: Arc<super::super::side_question_store::SideQuestionStore>,
        next: Arc<super::super::next_request_source::NextRequestSource>,
        path: super::super::turn_path::TurnPath,
        directory: Arc<SessionDirectory>,
        /// The live settings a turn start brings the thread to ([`LiveSettings`]).
        settings: Arc<Mutex<serde_json::Map<String, Value>>>,
    }

    async fn turn_world(provider: Arc<dyn ProviderAdapter>) -> World {
        turn_world_with(provider, vec![named("list"), named("Skill")], Arc::new(MockFileService::default()), false).await
    }

    /// [`turn_world`] over the tools `pool` and the file service `files` its tools read and write through; with
    /// `header_surfaces` the tool surface of a thread is the one its header names (`HeaderToolSurfaces`), not the rig's empty one.
    async fn turn_world_with(provider: Arc<dyn ProviderAdapter>, pool: Vec<Arc<dyn Tool>>, files: Arc<dyn mixdog_core_api::domain::fs::FileService>, header_surfaces: bool) -> World {
        let workspace = tempfile::tempdir().unwrap();
        let rig = Rig::new();
        let tokens = mixdog_rt::testing::tokens();
        let ledger = Arc::new(Ledger::default());
        let sink: Arc<dyn mixdog_ai::registry::accounting::UsageSink> = ledger.clone();
        let accounting = mixdog_ai::registry::accounted::AccountingDeps::new(Arc::new(Pricing), Arc::new(move || Some(sink.clone())));
        let processes: Arc<dyn mixdog_core_api::domain::process::ProcessManager> = Arc::new(MockProcessManager::default());
        let clock: Arc<dyn Clock> = Arc::new(Fixed);
        let connectors: Arc<dyn mixdog_tools::policy::ConnectorPermissions> = mixdog_mcp::permissions::ConnectorPolicy::new(
            workspace.path().to_path_buf(),
            mixdog_mcp::permissions::PolicyIo { maintenance: tokens.maintenance_io, interactive: tokens.interactive_io, durability: tokens.durability_io },
        );
        let data = workspace.path().join("data");
        let judge = mixdog_services::effort_judge::judge::EffortJudgeModel::with_options(
            mixdog_services::effort_judge::model::ModelConfig::in_data_dir(&data, mixdog_services::effort_judge::model::OrtRuntime::Library(workspace.path().join("no-ort.dll"))),
            mixdog_services::effort_judge::JudgeLanes::of(&tokens),
            mixdog_services::effort_judge::judge::JudgeOptions::default(),
        )
        .unwrap();
        let compaction = super::super::compaction_world::tests::services(workspace.path(), json!({}), Arc::default()).await;
        let hook_bus = mixdog_mcp::hook_bus::HookBus::new(data.clone(), tokens.maintenance_io, processes.clone(), None, None, None);
        let store = Arc::new(super::super::side_question_store::SideQuestionStore::new());
        let next = super::super::next_request_source::NextRequestSource::new();
        let (kept, side_store, side_next) = (store.clone(), store.clone(), next.clone());
        let liveness = mixdog_services::task_reports::runtime_state::RuntimeLiveness::new();
        let asked = Arc::new(AskedFor::default());
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
            next: next.clone(),
            files,
            processes,
            policy: Arc::new(mixdog_tools::policy::ToolPolicy::new(Arc::new(mixdog_tools::policy::MemoryGrantStore::default()), connectors.clone())),
            connectors,
            resolver: Arc::new(PoolResolver(pool.clone())),
            unattended: crate::run_host::unattended::UnattendedRunRegistry::new(Arc::new(NoStamps)),
            approvals: asked.clone(),
            exclusions: Arc::default(),
            agents: Arc::new(mixdog_core_agents::agents::AgentDefinitions::new(workspace.path().join("shipped"), workspace.path().join("agents"), tokens.interactive_io, mixdog_core_config::config::AgentRoutes::new(compaction.config.clone(), workspace.path()), Arc::new(NoEvidence), Arc::new(|| json!({})), workspace.path())),
            allow_all: Arc::new(AllowNone),
            hub: (mixdog_mcp::McpHub::new(mixdog_mcp::McpIo { spawn: tokens.spawn_io, durability: tokens.durability_io, cpu: tokens.cpu_bulk }, workspace.path().to_path_buf(), Default::default())),
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
            liveness,
            search_usage: mixdog_tools::web::NativeSearchUsageSinks::new(),
            deps: Box::new({
                let store = rig.store.clone();
                let rig_deps = rig.deps_parts(store);
                move |runs| {
                    let mut deps = rig_deps;
                    deps.runs = runs;
                    deps.side = Arc::new(super::super::side_question_store::SideQuestionService::new(side_store, side_next));
                    if header_surfaces {
                        deps.surfaces = Arc::new(mixdog_core_session::session::HeaderToolSurfaces::new(Arc::new(mixdog_core_session::session::NoRouteExclusions)));
                    }
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
                        Arc::new(OpenHopSessions),
                    )
                }
            }),
        };
        let path = super::super::turn_path::TurnPath::new(parts).expect("turn path");
        // No provider is registered ahead: as after a restart, the turn's first request readies the thread's provider.
        assert!(path.registry.get("scripted").await.is_none());
        let directory = path.directory.clone();
        // The settings host the composition binds: here one whose live settings are one key, `responseLanguage`, that a
        // turn start writes into the header when it moved (`settings`, empty: nothing moved).
        let settings = Arc::new(Mutex::new(serde_json::Map::new()));
        assert!(path.turn_settings.bind(Arc::new(LiveSettings(directory.clone(), settings.clone()))).is_ok());
        World { workspace, rig, ledger, asked, store, next, path, directory, settings }
    }

    /// The test settings host: a turn start brings the header to `.1`, the settings as they stand now.
    struct LiveSettings(Arc<SessionDirectory>, Arc<Mutex<serde_json::Map<String, Value>>>);

    impl LiveSettings {
        fn threads(&self) -> mixdog_core_session::session::thread_state::SessionThreads {
            mixdog_core_session::session::thread_state::SessionThreads::new(self.0.clone())
        }
    }

    #[async_trait]
    impl super::super::turn_settings::TurnSettings for LiveSettings {
        async fn reconcile(&self, thread: &ThreadId, _: bool) -> Result<mixdog_store::schema::record::Header, String> {
            use mixdog_core_ports::ports::threads::ThreadState;
            let set = lock(&self.1).clone();
            if !set.is_empty() {
                self.threads().patch_header(thread, set, Vec::new()).await.map_err(|error| format!("{error:?}"))?;
            }
            self.threads().header(thread).await.map_err(|error| format!("{error:?}"))
        }
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
        let World { workspace, rig, ledger, asked, store, directory, .. } = turn_world(provider.clone()).await;
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
        eventually_on_awaiting(|| "the four-role transcript in the store and two usage rows in the ledger".to_owned(), &[&rig.store.committed, &ledger.1], || (roles().len() >= 4 && lock(&ledger.0).len() >= 2).then_some(())).await;
        assert_eq!(roles(), ["user", "assistant", "tool", "assistant"]);
        // The turn's two approval entry points (the policy gate and the tool environment a nested call is judged with) both went through the composition's choice.
        assert_eq!(*lock(&asked.0), [id.as_str(), id.as_str()]);
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

    /// A provider that hands each request it is asked to send to `sent` and answers with a text. Its codec is Grok's, so
    /// the body of a request is what a Grok turn puts on the wire.
    struct Handing {
        id: ProviderId,
        policy: RetryPolicy,
        keepalive: KeepaliveSchedule,
        codec: Arc<dyn WireCodec>,
        sent: tokio::sync::mpsc::UnboundedSender<Arc<ModelRequest>>,
    }

    #[async_trait]
    impl ProviderAdapter for Handing {
        fn id(&self) -> &ProviderId {
            &self.id
        }
        fn codec(&self) -> &dyn WireCodec {
            &*self.codec
        }
        fn retry_policy(&self) -> &RetryPolicy {
            &self.policy
        }
        fn keepalive(&self) -> &KeepaliveSchedule {
            &self.keepalive
        }
        async fn attempt(&self, request: Arc<ModelRequest>) -> Result<Box<dyn ModelStream>, ProviderError> {
            self.sent.send(request).expect("the test is listening");
            Ok(Box::new(Steps(
                VecDeque::from([StreamEvent::TextDelta("ok".into()), StreamEvent::Completed { stop: Some(StopReason::EndTurn), pricing_model: None, request_ms: None }]),
            )))
        }
    }

    /// The surface host of the daemon reduced to what a `tools/toolsStatus` call touches: the mode, and the reconcile,
    /// which brings an empty thread to the current settings by writing its header.
    struct Reconciling(Arc<SessionDirectory>);

    #[async_trait]
    impl mixdog_core_ports::ports::tools_status::SurfaceHost for Reconciling {
        fn mode(&self, _: Option<&mixdog_store::schema::record::Header>) -> String {
            "lead".into()
        }
        async fn preview(&self) -> Result<mixdog_tools::orch::status::StatusSurface, mixdog_core_api::CoreError> {
            Ok(mixdog_tools::orch::status::StatusSurface::default())
        }
        async fn reconcile_empty(&self, thread: &ThreadId) -> Result<(), mixdog_core_api::CoreError> {
            use mixdog_core_ports::ports::threads::ThreadState;
            let set = json!({ "settingsReconciledAt": 1 }).as_object().unwrap().clone();
            mixdog_core_session::session::thread_state::SessionThreads::new(self.0.clone())
                .patch_header(thread, set, Vec::new())
                .await
                .map_err(|_| mixdog_core_api::CoreError::ThreadNotFound { thread_id: thread.clone() })
        }
    }

    /// The production `tools/toolsStatus` service over the world's threads and its request source.
    fn tools_status(world: &World) -> mixdog_tools::orch::status::ToolsService {
        let threads = Arc::new(mixdog_core_session::session::thread_state::SessionThreads::new(world.directory.clone()));
        let surface = mixdog_core_ports::ports::tools_status::SessionToolStatus::new(threads, Arc::new(Reconciling(world.directory.clone()))).with_snapshots(world.next.clone());
        mixdog_tools::orch::status::ToolsService::new(Arc::new(surface))
    }

    async fn snapshot_call(service: &mixdog_tools::orch::status::ToolsService, thread: &ThreadId, message: &str) -> Value {
        use mixdog_core_api::DomainService;
        let call = CoreRequest { method: Method("tools/toolsStatus"), params: json!({ "threadId": thread, "snapshot": true, "snapshotUserMessage": message }), op: None, ctx: CallContext::internal("test") };
        let Ok(Reply::Value(status)) = service.call(call).await else { panic!("tools/toolsStatus answers a value") };
        status
    }

    async fn started_thread(world: &World, header: Value) -> (ThreadId, Arc<mixdog_core_session::session::SessionHandle>) {
        let reply = world.directory.request(request("thread/start", json!({ "opId": "op-start", "kind": "task", "projectPath": world.workspace.path() }), "op-start")).await.expect("thread/start");
        let Reply::Subscribe(subscribe) = reply else { panic!("thread/start subscribes") };
        let id = ThreadId::from(subscribe.result["thread"]["id"].as_str().expect("thread id"));
        let handle = world.directory.handle(&id).expect("loaded");
        handle
            .request(CoreRequest { method: Method("thread/header/patch"), params: json!({ "threadId": id, "set": header }), op: None, ctx: CallContext::internal("test") })
            .await
            .expect("route");
        (id, handle)
    }

    fn handing() -> (Arc<Handing>, tokio::sync::mpsc::UnboundedReceiver<Arc<ModelRequest>>) {
        let (sent, heard) = tokio::sync::mpsc::unbounded_channel();
        let provider = Arc::new(Handing { id: ProviderId::from("scripted"), policy: RetryPolicy::codex_default(), keepalive: KeepaliveSchedule::SPEC, codec: mixdog_ai::providers::grok::codec("1.0.70"), sent });
        (provider, heard)
    }

    /// The snapshot taken now, and the request the thread's next turn (`op`, prompt `go`) then hands the provider,
    /// encoded the same way.
    async fn snapshot_then_turn(
        world: &World,
        provider: &Arc<Handing>,
        heard: &mut tokio::sync::mpsc::UnboundedReceiver<Arc<ModelRequest>>,
        id: &ThreadId,
        handle: &Arc<mixdog_core_session::session::SessionHandle>,
        op: &str,
    ) -> (Value, Value) {
        let status = snapshot_call(&tools_status(world), id, "go").await;
        let started = handle.request(request("turn/start", json!({ "threadId": id, "opId": op, "input": { "prompt": "go" } }), op)).await.expect("turn/start");
        let Reply::Value(started) = started else { panic!("turn/start answers a value") };
        assert_eq!(started["kind"], "started", "{op}");
        let sent = mixdog_rt::time::timeout(Duration::from_secs(30), heard.recv())
            .await
            .unwrap_or_else(|_| panic!("timed out after 30000 ms awaiting the request turn {op} hands the provider"))
            .expect("the provider is alive");
        let handed = super::super::request_snapshot::snapshot(&handle.live_header().header(), &**provider, &sent).expect("the sent request encodes");
        (status["requestSnapshot"].clone(), handed)
    }

    /// Waits until `count` runs of the thread have completed in the store and the last turn's settlement is over: the
    /// coverage stamp is written before the Goal settlement comes back (`JobDone::GoalSettled`), and a turn started
    /// while the actor is still busy settling is queued. `covered_before` is the stamp before the turn started.
    async fn settled_turns(world: &World, id: &ThreadId, handle: &Arc<mixdog_core_session::session::SessionHandle>, count: usize, covered_before: Option<Value>) {
        let done = || world.rig.store.records(id).into_iter().filter(|(_, record)| matches!(record, Record::Run(run) if run.phase == mixdog_store::schema::record::RunPhase::Completed)).count();
        let covered = || handle.header_snapshot().get("turnCoverage").cloned();
        eventually_on_awaiting(
            || format!("{count} completed runs of {}, the changed turnCoverage stamp and an idle actor", id.as_str()),
            &[&world.rig.store.committed, handle.stepped()],
            || (done() >= count && covered() != covered_before && !handle.turn_busy()).then_some(()),
        )
        .await;
    }

    /// A thread with history: the snapshot is `nextMainRequest`'s, the stored header and transcript as they are with the
    /// asked user message after them, so for a thread whose settings did not move since (and a model whose rules give no
    /// tail reminder) it is the request the next turn sends. Taking it stores nothing.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn the_snapshot_of_a_thread_with_history_is_its_next_request() {
        let (provider, mut heard) = handing();
        let world = turn_world(provider.clone()).await;
        let (id, handle) = started_thread(&world, json!({ "provider": "scripted", "model": "m" })).await;
        let covered_before = handle.header_snapshot().get("turnCoverage").cloned();
        let started = handle.request(request("turn/start", json!({ "threadId": id, "opId": "op-1", "input": { "prompt": "go" } }), "op-1")).await.expect("turn/start");
        assert!(matches!(started, Reply::Value(_)), "turn/start answers a value");
        mixdog_rt::time::timeout(Duration::from_secs(30), heard.recv()).await.unwrap_or_else(|_| panic!("timed out after 30000 ms awaiting the first turn's request")).expect("the provider is alive");
        settled_turns(&world, &id, &handle, 1, covered_before).await;
        let before = stored_state(&world, &id, &handle);
        let first = snapshot_call(&tools_status(&world), &id, "go").await;
        assert_eq!(stored_state(&world, &id, &handle), before, "the snapshot call wrote to the stored thread");
        let (snapshot, handed) = snapshot_then_turn(&world, &provider, &mut heard, &id, &handle, "op-2").await;
        assert!(snapshot.is_object(), "a thread with a conversation has a request");
        assert_eq!(first["requestSnapshot"], snapshot, "two snapshots of the same thread differ");
        assert_eq!(snapshot, handed, "the snapshot is not the request the next turn handed the provider");
    }

    /// The whole of what is stored for a thread and its session directory, as Debug text: every record of the store (header,
    /// transcript items, ends), the live header, the accounting rows, and every file under the workspace with its bytes.
    fn stored_state(world: &World, id: &ThreadId, handle: &Arc<mixdog_core_session::session::SessionHandle>) -> String {
        fn files(dir: &std::path::Path, out: &mut Vec<String>) {
            let mut entries: Vec<_> = std::fs::read_dir(dir).unwrap().map(|e| e.unwrap().path()).collect();
            entries.sort();
            for path in entries {
                if path.is_dir() {
                    files(&path, out);
                } else {
                    out.push(format!("{}={:?}", path.display(), std::fs::read(&path).unwrap()));
                }
            }
        }
        let mut on_disk = Vec::new();
        files(world.workspace.path(), &mut on_disk);
        format!("{:#?}\n{:#?}\n{:#?}\n{:#?}", world.rig.store.records(id), handle.live_header().header(), lock(&world.ledger.0), on_disk)
    }

    // An inline module's path is resolved from `src/run_host/factory/tests/`.
    #[path = "../../../../../mixdog-ai/src/providers/grok/fixture_manifest.rs"]
    mod tests_manifest;

    #[path = "../explicit_skills_node_cases.rs"]
    mod explicit_skills_node_cases;

    #[path = "../skill_wire_node_cases.rs"]
    mod skill_wire_node_cases;

    #[path = "../completion_node_cases.rs"]
    mod completion_node_cases;

    #[path = "../live_cwd_node_cases.rs"]
    mod live_cwd_node_cases;

    #[path = "../../offload_prune_turn_tests.rs"]
    mod offload_prune_turn_tests;

    /// Node's `nextMainRequest` over the cases `snapshot_effects/record.mjs` recorded (no user conversation, a transcript,
    /// each again after a new ignored directory and after the skill catalog was invalidated): it is null without a user
    /// conversation, otherwise the stored transcript as it is (its iteration 1), and it writes, lists and probes nothing.
    /// The core's snapshot request for a thread without a conversation and for one whose transcript is the recorded one
    /// (a turn `hi` answered `ok`): null where Node's is, the same conversation messages where Node has them, and the
    /// thread's stored state untouched by the call. The core's snapshot path holds no prompt composition, probe or skill
    /// catalog to touch (`HostRunParts::snapshot_request` builds from the header and the rows).
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn the_snapshot_answers_where_nodes_next_main_request_answers() {
        let repo_root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../..");
        let set = repo_root.join("native/core/fixtures/request-snapshot-effects");
        tests_manifest::verify_dir(&repo_root, &set, "native/core/crates/mixdog-core/src/run_host/snapshot_effects/record.mjs");
        let node: Value = serde_json::from_slice(&std::fs::read(set.join("node-recorded.json")).unwrap()).unwrap();
        let (provider, mut heard) = handing();
        let world = turn_world(provider.clone()).await;
        let (empty, empty_handle) = started_thread(&world, json!({ "provider": "scripted", "model": "m" })).await;
        let (talked, talked_handle) = started_thread(&world, json!({ "provider": "scripted", "model": "m" })).await;
        let covered_before = talked_handle.header_snapshot().get("turnCoverage").cloned();
        let started = talked_handle.request(request("turn/start", json!({ "threadId": talked, "opId": "op-1", "input": { "prompt": "hi" } }), "op-1")).await.expect("turn/start");
        assert!(matches!(started, Reply::Value(_)), "turn/start answers a value");
        mixdog_rt::time::timeout(Duration::from_secs(30), heard.recv()).await.unwrap_or_else(|_| panic!("timed out after 30000 ms awaiting the turn's request")).expect("the provider is alive");
        settled_turns(&world, &talked, &talked_handle, 1, covered_before).await;
        let (directory, parts) = world.next.bound().expect("bound");
        let directory = directory.upgrade().expect("directory");
        for case in node["cases"].as_array().unwrap() {
            let name = case["name"].as_str().unwrap();
            assert_eq!((case["fsCalls"].clone(), case["gitRequested"].clone()), (json!([]), json!([])), "{name}: Node's call did something");
            let (id, handle) = if case["request"].is_null() { (&empty, &empty_handle) } else { (&talked, &talked_handle) };
            let before = stored_state(&world, id, handle);
            let status = snapshot_call(&tools_status(&world), id, "").await;
            assert_eq!(stored_state(&world, id, handle), before, "{name}: the snapshot call wrote to the stored thread");
            let prior = directory.model_context(id).read().await.expect("rows");
            let built = parts.snapshot_request(id, &handle.live_header().header(), &handle.surface().borrow().clone(), prior, None).await;
            match (&case["request"], built) {
                (Value::Null, None) => assert_eq!(status["requestSnapshot"], Value::Null, "{name}"),
                (request, Some((_, built))) if !request.is_null() => {
                    let conversation = |messages: Vec<(String, String)>| messages.into_iter().filter(|(role, _)| role != "system").collect::<Vec<_>>();
                    let nodes = request["messages"].as_array().unwrap().iter().map(|m| (m["role"].as_str().unwrap().to_owned(), m["content"].as_str().unwrap().to_owned())).collect();
                    let text = |content: &mixdog_core_api::domain::provider::Content| match content {
                        mixdog_core_api::domain::provider::Content::Text(text) => text.clone(),
                        mixdog_core_api::domain::provider::Content::Parts(parts) => parts
                            .iter()
                            .filter_map(|part| match part {
                                mixdog_core_api::domain::provider::ContentPart::Text(text, _) => Some(text.as_str()),
                                _ => None,
                            })
                            .collect(),
                    };
                    let cores = built.messages.iter().map(|m| (format!("{:?}", m.role).to_lowercase(), text(&m.content))).collect();
                    assert_eq!(conversation(cores), conversation(nodes), "{name}: the conversation of the request");
                    assert_eq!(request["iteration"], json!(built.options.iteration), "{name}: the iteration");
                    assert!(status["requestSnapshot"].is_object(), "{name}");
                }
                (request, built) => panic!("{name}: Node {request}, the core {:?}", built.map(|(_, r)| r.messages.len())),
            }
        }
    }

    /// `nextMainRequest` is null for a session with no user conversation (`side-question.mjs:67`), so is the snapshot:
    /// nothing is composed for it, and the thread's whole stored state (records, live header, accounting, files) is the
    /// same after the call as before it.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_thread_with_no_conversation_has_no_snapshot_and_the_call_stores_nothing() {
        let (provider, _heard) = handing();
        let world = turn_world(provider).await;
        let (id, handle) = started_thread(&world, json!({ "provider": "scripted", "model": "m" })).await;
        let before = stored_state(&world, &id, &handle);
        let status = snapshot_call(&tools_status(&world), &id, "go").await;
        assert_eq!(status["requestSnapshot"], Value::Null, "Node's nextMainRequest is null without a user conversation");
        assert_eq!(stored_state(&world, &id, &handle), before, "the snapshot call wrote to the stored thread");
    }

    #[path = "../../restart_prefix_tests.rs"]
    mod restart_prefix;

    #[path = "../../session_message_sanitize_replay.rs"]
    mod session_message_sanitize_replay;
}
