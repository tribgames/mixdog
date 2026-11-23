mod drive;
mod forwarding;
mod history;
mod interrupt;
mod observer;
mod segments;
mod sink;

// Transparent callback/state names; existing ownership and call signatures are unchanged.
type ToolResultCallback = dyn Fn(&mixdog_agent::agent_tool::flow::seams::ToolResultMessage) + Send + Sync;
use super::failed_turn_rewind;
use super::live_turn::LiveTurnPublisher;
use super::message_row::{message_of, row_of};
use super::quiet_watch::QuietWatch;
use super::retry::{RandomJitter, TimerWait};
use super::steer::SteerQueue;
use super::tool_progress::{RunToolProgress, ToolHints};
use super::watchdog::{StallSite, Watchdog, registration_id, stall_abort_ctx};
use async_trait::async_trait;
use mixdog_agent::agent_tool::progress::Snapshot;
use mixdog_agent::agent_tool::watchdog::{AgentKind, Overrides, is_watchdog_abort, resolve_policy};
use mixdog_agent::compact::blob_reads::with_blobs_if_read;
use mixdog_agent::env::CommitError;
use mixdog_agent::env::{
    Clock, Compactor, Reactions, ResultReuse, Retracted, RouteFallback, RunEnv, RunEvent, RunObserver, SkillSelector, Stage, TailReminder, TextRetraction,
    Ticket, ToolGate, ToolHooks, TranscriptSink, TurnGuards,
};
use mixdog_agent::message::AgentMessage;
use mixdog_agent::tools::{ToolEnv, ToolSet};
use mixdog_agent::{AgentError, Run, RunCarry, RunConfig};
use mixdog_core_api::domain::provider::{Content, ProgressKind, ProviderAdapter, Role};
use mixdog_core_api::domain::retry::RetryDecider;
use mixdog_core_api::ids::{ItemId, ThreadId, TurnId};
use mixdog_core_run::run_host::progress::ProgressPublisher;
use mixdog_core_run::run_host::progress::StreamKind;
use mixdog_core_session::session::ItemCommit;
use mixdog_core_session::session::RunFactory;
use mixdog_core_session::session::RunOutcome;
use mixdog_core_session::session::RunPort;
use mixdog_core_session::session::RunStart;
use mixdog_core_session::session::StoredRows;
use mixdog_core_session::session::failure_record::provider_turn_error;
use mixdog_core_session::session::run::Queued;
use mixdog_core_session::session::run::RunError;
use mixdog_core_session::session::turn_snapshot::ReviewGate;
use mixdog_protocol::message_class::row_facts;
use mixdog_protocol::message_class::user_text::UserText;
use mixdog_protocol::{ItemMeta, MaybeBlob, ThreadItem, TurnError};
use mixdog_rt::TaskClass;
use mixdog_tools::policy::SessionSurface;
use serde_json::{Value, json};
use std::collections::HashMap;
use std::future::Future;
use std::pin::Pin;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use tokio::sync::{mpsc, watch};

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

pub(super) use mixdog_core_session::session::run::new_item_id;

fn failed(message: impl Into<String>, data: Value) -> RunOutcome {
    RunOutcome::Failed(TurnError { message: message.into(), data, provider_error: None })
}

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
}

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
    /// The generation of the history `prior` is, read with it.
    pub generation: u64,
    /// The turn's prompt text, trimmed.
    pub request: &'a str,
    /// A runtime-injected turn (a completion notice, queued work), not a user's prompt.
    pub injected: bool,
    pub cancel: &'a tokio_util::sync::CancellationToken,
    /// No person is attached to the turn ([`RunStart::unattended`]): a Stop hook's block does not continue it.
    pub unattended: bool,
    /// The worker turn's own completion hook (`AgentTurn.hooks.notify`): `assemble` puts it on the
    /// `ToolEnv`, so it reaches every tool call. `None` for a turn no job owns.
    pub notify: Option<mixdog_core_api::domain::tool::ToolNotify>,
    /// Where the run's tools report progress: `ToolEnv.progress` (the run's own sink, built by the
    /// factory over the session cell's progress value).
    pub progress: Arc<dyn mixdog_core_api::domain::tool::ProgressSink>,
}

#[async_trait]
pub trait RunParts: Send + Sync + 'static {
    /// The turn's host parts; a refusal fails the turn with its error.
    async fn assemble(&self, input: AssembleInput<'_>) -> Result<Assembled, TurnError>;

    /// `reconcileTurnSettings`: the header the turn is built from, once the thread's settings follow the
    /// live ones (`conversation`: the thread already holds one, so it keeps its prefix; `header` is what
    /// the turn started with).
    async fn reconcile_turn(
        &self,
        thread: &ThreadId,
        header: mixdog_store::schema::record::Header,
        conversation: bool,
    ) -> Result<mixdog_store::schema::record::Header, TurnError>;

    /// `refreshDeferredMcpToolCatalog(session)`: the thread's MCP catalog follows the live registry. Run by the
    /// loop at each request boundary and around each tool call; a host with no MCP catalog has nothing to refresh.
    async fn refresh_mcp(&self, _thread: &ThreadId) -> Result<(), TurnError> {
        Ok(())
    }

    /// The prompt fold a compaction of the running turn owes: the thread's system messages once its prompt is rebuilt
    /// from current sources, for the request that follows. `None` for a thread whose prompt is never rebuilt.
    async fn fold_compacted(&self, _thread: &ThreadId) -> Result<Option<Vec<AgentMessage>>, TurnError> {
        Ok(None)
    }

    /// `currentAgents()`: the agents the thread's Lead may delegate to now, for the turn's agent list reminder;
    /// `None` for a thread that gets none (an agent's own, a bot's).
    async fn current_agents(
        &self,
        _thread: &ThreadId,
        _header: &mixdog_store::schema::record::Header,
    ) -> Result<Option<Vec<super::turn_reminders::AgentEntry>>, TurnError> {
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
    async fn request_snapshot(
        &self,
        _thread: &ThreadId,
        tools: Vec<mixdog_core_api::domain::provider::ToolDefinition>,
        _native: Vec<Value>,
    ) -> Result<Vec<mixdog_core_api::domain::provider::ToolDefinition>, TurnError> {
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

    /// `recordAppliedSkills`: the skills a turn's prompt loaded, stamped on the thread's durable row `item`. A host
    /// with no session store has nothing to stamp.
    async fn record_applied_skills(&self, _thread: &ThreadId, _item: &ItemId, _names: &[String]) -> Result<(), TurnError> {
        Ok(())
    }
}

impl RunFactory for RunHostFactory {
    fn start(&self, run: RunStart) -> Pin<Box<dyn Future<Output = RunOutcome> + Send>> {
        let (parts, liveness, search_usage) = (self.parts.clone(), self.liveness.clone(), self.search_usage.clone());
        let before_loop = BeforeLoop {
            port: run.port.clone(),
            input_item: run.input_item.clone(),
            input_body: run.input_body.clone(),
            cancel: run.cancel.clone(),
            signal: run.signal.clone(),
            asked: Arc::default(),
        };
        let cancel = run.cancel.clone();
        // The turn's future is large: it is built and boxed here, so no copy of it is made on the stack of the thread that polls it.
        let turn: Pin<Box<dyn Future<Output = RunOutcome> + Send>> = Box::pin(drive_turn(parts, liveness, search_usage, run, before_loop.asked.clone()));
        Box::pin(async move {
            // Its token is the one every store and route read the turn makes waits under.
            let outcome = mixdog_agent::compact::blob_reads::within_turn(cancel, turn).await;
            before_loop.settle(outcome).await
        })
    }

    fn crashed(&self, run: mixdog_core_session::session::CrashedRun) -> mixdog_core_session::session::CrashedRows {
        crashed_rows(run)
    }
}

use self::drive::*;
use self::forwarding::*;
use self::history::*;
pub(crate) use self::history::{native_searches, session_messages, system_messages};
use self::interrupt::*;
use self::observer::*;
pub(crate) use self::segments::Segments;
use self::segments::*;
use self::sink::*;

#[cfg(test)]
mod tests;
