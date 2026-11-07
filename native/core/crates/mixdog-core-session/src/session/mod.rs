//! Sessions: one `SessionActor` per loaded thread, its `DurabilityTask`, the C0 control plane
//! and the thread directory (RL §5–§7, P §5, §7.2, §8, SM §6–§8, SPEC R9–R12, R26–R28).
//!
//! ```text
//!  RT-C   SessionHandle ── RunControl ──▶ ControlCell (ArcSwap: active run, queued ids,
//!           │                                          pending approval ids)
//!           │ ctl lane (32) ───────────────┐
//!           │ inbox (256) ───────────┐     │
//!  RT-W     ▼                        ▼     ▼
//!         SessionActor   select!{biased; ctl, acks, encodes, approval deadline, producers, inbox}
//!           ├─ projected state (validates new work) and acked state (the view and the feed)
//!           ├─ Outbox: accept order; record encodes on cpu-interactive, handed to durability in
//!           │          order (reorder buffer), released (applied + published) in order at ack
//!           ├─ Run task (≤ 1) ── RunPort ──▶ producer lane
//!           └─ DurabilityTask ── sole owner of the SessionLog (I1) ── one io-durability job in flight
//! ```
//!
//! Every thread runs on its own actor, durability task, channels and feed; nothing global
//! serializes turns. The only shared resources are the lanes (bounded, typed) and the
//! directory's sharded map, whose shard locks guard O(1) work only.

mod actor;
mod agent_host;
pub mod agent_registry;
pub mod approval_surfaces;
mod attachments;
mod cards;
pub mod close;
mod completions;
mod control;
pub mod delete;
pub mod purge;
pub mod sub_agent_retention;
#[cfg(test)]
mod sub_agent_retention_tests;
#[cfg(test)]
mod thread_list_overlay_tests;
pub mod shell_jobs;
pub mod thread_list;
pub mod thread_context;
pub mod tool_events;
pub mod workspace_sight;
pub mod gateway_routes;
pub mod effort_prewarm;
mod directory;
pub mod goal_lane;
pub mod goal_reminder;
pub mod heartbeat_host;
pub mod thread_settings;
pub mod thread_switches;
mod live_rows;
mod durability;
mod frames;
mod handle;
mod message_reactions;
mod model_switch;
pub mod home_threads;
pub mod room_log;
pub mod import_sessions;
mod route_exclusions;
pub mod route_session;
pub mod agent_evidence;
pub mod agent_activity;
#[cfg(test)]
mod agent_activity_tests;
pub mod dispatch_sessions;
pub mod search_backfill;
pub mod secret_input;
pub mod setup_facts;
pub mod setup_ui;
pub mod run_stamps;
pub mod route_setup;
mod ops;
pub mod thread_ops;
mod outbox;
mod pending;
pub mod delivered;
pub mod pending_read;
#[cfg(test)]
mod pending_read_tests;
mod reads;
mod routine_turn;
pub mod room_member;
pub mod prompt_history;
pub mod session_title;
pub mod quota_lane;
#[cfg(test)]
mod quota_lane_tests;
pub mod quota_resume_host;
#[cfg(test)]
mod quota_resume_host_tests;
pub mod quota_resume_scheduler;
#[cfg(test)]
mod quota_resume_scheduler_tests;
pub mod run;
pub mod delegated_host;
pub mod handoff_questions;
pub mod runtime_hooks;
mod seams;
mod state;
mod store;
mod surface;
pub mod terminal_host;
mod transcript;
pub mod transcript_export;
pub mod turn_snapshot;
pub mod turn_snapshots;
#[cfg(test)]
mod turn_snapshots_tests;
pub mod user_text;
pub mod user_cwd;
pub mod user_facts;
pub mod agent_route;
pub mod route_cell;
pub mod session_options;
mod view;
pub mod worktree;
pub mod inheritance;
pub mod turn_ops;
#[cfg(test)]
mod turn_ops_tests;
pub mod composer_image;
pub mod staged_originals;
pub mod turn_actions;
#[cfg(test)]
mod turn_actions_tests;
#[cfg(test)]
mod agent_control_tests;

#[cfg(any(test, feature = "test-support"))]
pub mod testing;
#[cfg(test)]
mod tests;
#[cfg(test)]
mod goal_lane_tests;
#[cfg(test)]
mod assembly_tests;

use std::sync::Arc;

use mixdog_core_api::ServerRequestSink;
use mixdog_rt::CpuInteractive;
use mixdog_rt::DurabilityIo;
use mixdog_rt::InteractiveIo;

pub use self::attachments::SessionAttachmentLinks;
pub use self::directory::SessionDirectory;
pub use self::model_switch::record_model_switch;
pub use self::handle::SessionHandle;
pub use self::prompt_history::FilePromptHistory;
pub use self::prompt_history::Appended;
pub use self::prompt_history::PromptHistoryStore;
pub use self::run::ItemCommit;
pub use self::run::RunError;
pub use self::run::RunPort;
pub use self::run::SteerInput;
pub use self::run::UsageReport;
pub use self::seams::AgentTurn;
pub use self::seams::AppendPosition;
pub use self::seams::BarrierError;
pub use self::seams::CloseIngest;
pub use self::seams::SensitiveMarks;
pub use self::seams::SessionMeta;
pub use self::user_cwd::UserCwd;
pub use self::store::MemoryCloseIngest;
pub use self::seams::CommitRecord;
pub use self::seams::EncodedRecord;
pub use self::seams::EffortPrewarm;
pub use self::seams::FeedFactory;
pub use self::seams::HeadRead;
pub use self::seams::OpenedLog;
pub use self::seams::RecordCodec;
pub use self::seams::RunFactory;
pub use self::seams::RunOutcome;
pub use self::seams::RunStart;
pub use self::seams::SessionLog;
pub use self::seams::ThreadStore;
pub use self::seams::ToolSurfaceSource;
pub use self::seams::Transcript;
pub use self::seams::TurnIngest;
pub use self::seams::WindowDivider;
pub use self::seams::WindowRead;
pub use self::store::SessionSearchTurns;
pub mod thread_state;
pub use self::store::CoreThreadFeeds;
pub use self::transcript::StoredRows;
pub use self::store::Projector;
pub use self::store::StoreCodec;
pub use self::store::StoreThreads;
pub use self::route_exclusions::ExcludedTool;
pub use self::route_exclusions::SessionToolExclusions;
pub use self::route_exclusions::route_schema_family;
pub use self::surface::HeaderToolSurfaces;
pub use self::surface::NoRouteExclusions;
pub use self::surface::RouteExclusions;
use mixdog_core_base::approvals::ApprovalIds;
use mixdog_core_base::approvals::Devices;

/// Everything a session needs from the rest of the core. Built once by the composition root;
/// every thread shares the same `Arc`.
pub struct SessionDeps {
    pub store: Arc<dyn ThreadStore>,
    pub codec: Arc<dyn RecordCodec>,
    pub transcript: Arc<dyn Transcript>,
    pub prompts: Arc<dyn PromptHistoryStore>,
    pub runs: Arc<dyn RunFactory>,
    pub surfaces: Arc<dyn ToolSurfaceSource>,
    /// Released on user input or a deliverable notification, ending a passive `task wait` or
    /// shell hold of the thread as today.
    pub wakes: Arc<mixdog_tools::exec::WakeHub>,
    /// Called on create and open, where today's `session-lifecycle.mjs` calls
    /// `prewarmSessionAutoEffort`.
    pub effort: Arc<dyn EffortPrewarm>,
    /// The session-search copy, written once per completed turn.
    pub search: Arc<dyn TurnIngest>,
    /// The memory ingest when a thread unloads or the core shuts down.
    pub memory: Arc<dyn CloseIngest>,
    /// The sensitive values a running turn's session gains (its search rows are replaced).
    pub sensitive: Arc<dyn SensitiveMarks>,
    /// The cwd files under the data dir (`user-cwd.mjs`).
    pub user_cwd: UserCwd,
    /// The prompt-attachment store user text reads offloaded parts from.
    pub attachments: user_facts::AttachmentStore,
    /// The originals a composer staged ahead of a message: a turn submission claims the ones it
    /// names (`claimStagedOriginals`), and `thread/stageAttachmentOriginal` stages into it.
    pub staged_originals: Arc<staged_originals::StagedOriginals>,
    pub feeds: Arc<dyn FeedFactory>,
    pub server_requests: Arc<dyn ServerRequestSink>,
    pub approval_ids: Arc<dyn ApprovalIds>,
    pub devices: Arc<dyn Devices>,
    pub clock: Arc<dyn Clock>,
    /// Told of every turn start (today's `onSessionTurnStart`).
    pub turn_starts: Arc<dyn TurnStarts>,
    /// Told when a thread's actor starts and stops (the handed-off question copies follow it).
    pub runtime_hooks: Arc<dyn runtime_hooks::RuntimeHooks>,
    /// The read-only snapshots a settled turn made are removed (`turn_snapshots.rs`).
    pub snapshots: Arc<dyn turn_snapshots::TurnSnapshots>,
    /// The turn review: `thread/revertTurnReview` and `thread/revertTurnReviewFile` answer from it.
    pub turn_review: Arc<dyn mixdog_core_api::turn_review::TurnReviewApi>,
    /// The saved requests and the fork behind `thread/askSide` and `thread/cancelSide`.
    pub side: Arc<dyn turn_ops::SideQuestions>,
    /// The compaction engine and hooks behind `thread/compact/start`.
    pub compaction: Arc<dyn turn_ops::ManualCompaction>,
    /// The target route's compaction policy `thread/inheritancePreflight` measures a conversation on.
    pub inherit: Arc<dyn inheritance::InheritanceFit>,
    /// The route change the session applies: a clear takes its environment reset from it.
    pub route_change: Arc<dyn route_session::RouteChange>,
    /// What `thread/delete` does outside the session and its store.
    pub deletion: Arc<dyn delete::DeleteSeams>,
    /// The store purge hooks a delete runs, in 1.4.5's order.
    pub purge: delete::PurgeHooks,
    /// The Goal runtime the session's turns start, settle and continue.
    pub goals: Arc<dyn goal_lane::SessionGoals>,
    /// What a Goal continuation reads of the session: its todo list, and the background work it
    /// waits on (`goal-facade-api.mjs` `goalContinuation`). The cycles are the ones the turn
    /// guards begin at each genuine user prompt.
    pub todos: Arc<dyn mixdog_tools::state::todo::TodoStore>,
    pub work: Arc<dyn mixdog_core_run::run_host::guards::RunningWork>,
    /// The agent tool's status for a session, published as its `agents` section when a job of
    /// the session is added or finishes (`agent_activity.rs`).
    pub agent_status: Arc<dyn agent_activity::AgentStatus>,
    /// The agent-status sources this session's actor emits (an approval wait, a stored record).
    pub agent_signals: Arc<dyn agent_activity::AgentSignals>,
    pub cycles: Arc<mixdog_core_run::run_host::guards::UserCycles>,
    /// The quota-resume queue a quota-failed turn queues its resume on.
    pub quota: quota_lane::SessionQuota,
    pub lanes: SessionLanes,
    pub limits: SessionLimits,
}

/// A turn of any origin started on a thread (`session-activity-signal.mjs`
/// `onSessionTurnStart`): the worker index clears the owner's release mark.
pub trait TurnStarts: Send + Sync {
    fn turn_started(&self, thread: &mixdog_core_api::ids::ThreadId);
}

/// [`TurnStarts`] bound after the sessions exist: the agent registry reads the session
/// directory, which is built over the deps that carry this. Unbound, a turn start tells no one.
#[derive(Default)]
pub struct LateTurnStarts(std::sync::OnceLock<Arc<dyn TurnStarts>>);

impl LateTurnStarts {
    /// Binds the listener; a second bind is refused.
    pub fn bind(&self, listener: Arc<dyn TurnStarts>) -> Result<(), Arc<dyn TurnStarts>> {
        self.0.set(listener)
    }
}

impl TurnStarts for LateTurnStarts {
    fn turn_started(&self, thread: &mixdog_core_api::ids::ThreadId) {
        if let Some(listener) = self.0.get() {
            listener.turn_started(thread);
        }
    }
}

/// The lane tokens sessions use (RL §3, §13): open reads, encodes and decodes, durability.
#[derive(Clone, Copy, Debug)]
pub struct SessionLanes {
    pub cpu: CpuInteractive,
    pub io: InteractiveIo,
    pub durability: DurabilityIo,
}

/// Wall-clock milliseconds since the Unix epoch, for record and resolution timestamps.
pub trait Clock: Send + Sync + 'static {
    fn now_ms(&self) -> i64;
}

pub struct SystemClock;

impl Clock for SystemClock {
    fn now_ms(&self) -> i64 {
        let since = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default();
        i64::try_from(since.as_millis()).unwrap_or(i64::MAX)
    }
}

/// Per-thread bounds (RL §5.1, §6.2, §12.2; FORMAT.md §3.3).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct SessionLimits {
    /// Actor inbox (C2 and C1 requests that need the actor).
    pub inbox: usize,
    /// Actor control lane (abort, steer, decisions, run ends).
    pub control_lane: usize,
    /// Steer entries waiting for the run's next model-call boundary.
    pub steer_queue: usize,
    /// Producer lane (runs and internal section producers).
    pub producer_lane: usize,
    /// Normal durability window: unacked records and their encoded bytes.
    pub window_records: usize,
    pub window_bytes: usize,
    /// Control reserve on top of the normal window: run status, approvals, steer entries.
    pub reserve_records: usize,
    pub reserve_bytes: usize,
    /// Most encoded bytes in one group commit (`DURABILITY_WINDOW_BYTES`).
    pub batch_bytes: usize,
    /// Released-in-order backlog behind an unacked record before producers are paused.
    pub outbox_entries: usize,
    /// UI window kept in the view (RL §5.5): newest visible items.
    pub view_items: usize,
}

impl Default for SessionLimits {
    fn default() -> Self {
        Self {
            inbox: 256,
            control_lane: 32,
            steer_queue: 16,
            producer_lane: 64,
            window_records: 64,
            window_bytes: 4 << 20,
            reserve_records: 16,
            reserve_bytes: 256 << 10,
            batch_bytes: mixdog_store::schema::frame::DURABILITY_WINDOW_BYTES as usize,
            outbox_entries: 1024,
            view_items: 200,
        }
    }
}

/// A fresh 128-bit feed epoch (P §6.1), lowercase hex.
fn new_epoch() -> mixdog_core_api::ids::FeedEpoch {
    mixdog_core_api::ids::FeedEpoch::from(uuid::Uuid::new_v4().simple().to_string())
}

/// A fresh time-ordered id (turns, queue entries, items created by the core).
fn new_id() -> String {
    uuid::Uuid::now_v7().to_string()
}
