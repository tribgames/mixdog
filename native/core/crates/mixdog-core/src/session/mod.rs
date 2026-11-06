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
mod completions;
mod control;
mod directory;
mod durability;
mod frames;
mod handle;
mod ops;
mod outbox;
mod pending;
pub mod prompt_history;
pub(crate) mod run;
mod seams;
mod state;
mod store;
mod surface;
mod transcript;
pub mod user_text;
pub mod user_cwd;
pub mod user_facts;
pub mod agent_route;
pub mod route_cell;
pub mod session_options;
mod view;
pub mod worktree;

#[cfg(test)]
mod testing;
#[cfg(test)]
mod tests;

use std::sync::Arc;

use mixdog_core_api::ServerRequestSink;
use mixdog_rt::CpuInteractive;
use mixdog_rt::DurabilityIo;
use mixdog_rt::InteractiveIo;

pub use self::directory::SessionDirectory;
pub use self::handle::SessionHandle;
pub use self::prompt_history::FilePromptHistory;
pub use self::prompt_history::PromptHistoryStore;
pub use self::run::ItemCommit;
pub use self::run::RunError;
pub use self::run::RunPort;
pub use self::run::SteerInput;
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
pub use self::seams::WindowRead;
pub use self::store::SessionSearchTurns;
pub use self::state::Section;
pub use self::store::CoreThreadFeeds;
pub use self::transcript::StoredRows;
pub use self::store::Projector;
pub use self::store::StoreCodec;
pub use self::store::StoreThreads;
pub use self::surface::HeaderToolSurfaces;
pub use self::surface::NoRouteExclusions;
pub use self::surface::RouteExclusions;
use crate::approvals::ApprovalIds;
use crate::approvals::Devices;

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
    pub attachments: Arc<dyn mixdog_protocol::message_class::user_text::Blobs + Send + Sync>,
    pub feeds: Arc<dyn FeedFactory>,
    pub server_requests: Arc<dyn ServerRequestSink>,
    pub approval_ids: Arc<dyn ApprovalIds>,
    pub devices: Arc<dyn Devices>,
    pub clock: Arc<dyn Clock>,
    pub lanes: SessionLanes,
    pub limits: SessionLimits,
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
