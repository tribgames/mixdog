//! What a session needs from packages that own the store format, the transcript projection,
//! the run loop and the feed. Each seam is lane-typed: a method that touches storage takes the
//! `InLane` proof of its lane, so it can only run inside a job of that lane (RL §13).
//!
//! Owners: [`ThreadStore`], [`SessionLog`] and [`RecordCodec`] are implemented by
//! `mixdog-store` (WP-STORE: reader, `LogWriter`, frame and record codec); [`Transcript`] by the
//! transcript projection; [`RunFactory`] by `mixdog-agent` (WP-AGENT); [`FeedFactory`] by
//! `core::feed` (WP-FEED).

use std::any::Any;
use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;

use mixdog_app_protocol::v2::thread::TurnInput;
use mixdog_core_api::CoreError;
use mixdog_core_api::Feed;
use mixdog_core_api::FeedView;
use mixdog_core_api::ids::FeedEpoch;
use mixdog_core_api::ids::FeedId;
use mixdog_core_api::ids::ThreadId;
use mixdog_core_api::ids::TurnId;
use mixdog_protocol::ThreadItem;
use mixdog_protocol::ThreadSummary;
use mixdog_protocol::TurnError;
use mixdog_rt::CancellationToken;
use mixdog_rt::CpuInteractive;
use mixdog_rt::DurabilityIo;
use mixdog_rt::InLane;
use mixdog_rt::InteractiveIo;
use mixdog_store::encode::Encoded;
use mixdog_store::schema::record::ApprovalRecord;
use mixdog_store::schema::record::Header;
use mixdog_store::schema::record::ItemRecord;
use mixdog_store::schema::record::ModelSwitchEntry;
use mixdog_store::schema::record::QueueRecord;
use mixdog_store::schema::record::Record;
use mixdog_store::schema::record::RunRecord;
use mixdog_store::sqlite::CompactionEntry;
use mixdog_tools::policy::SessionSurface;
use mixdog_agent::agent_tool::flow::seams::TurnResult;
use serde_json::Value;
use tokio::sync::watch;

use super::run::RunPort;

/// One record's log payload (FORMAT.md §5.1) and the blobs its body slot references, which
/// are published before the record's barrier (FORMAT.md §4.4).
#[derive(Clone, Debug)]
pub struct EncodedRecord(pub Encoded);

impl EncodedRecord {
    /// Bytes the record takes in the durability window: payload and out-of-line bodies.
    pub fn bytes(&self) -> usize {
        self.0.payload().len() + self.0.blobs().iter().map(|b| b.bytes.len()).sum::<usize>()
    }
}

/// A record handed to the log: the structured record (for the writer's checkpoint fold,
/// FORMAT.md §6.1) and its encoding.
#[derive(Clone, Debug)]
pub struct CommitRecord {
    pub record: Arc<Record>,
    pub encoded: EncodedRecord,
}

/// FORMAT.md §5.1 record encoding with the §4.2 body-slot rule. Runs on cpu-interactive.
pub trait RecordCodec: Send + Sync + 'static {
    /// Fails `itemTooLarge` for a body above `MAX_BLOB_BYTES`.
    fn encode(
        &self,
        lane: &InLane<CpuInteractive>,
        record: &Record,
    ) -> Result<EncodedRecord, CoreError>;
}

/// How a barrier failed (SM §8).
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum BarrierError {
    /// Rolled back to the acked end (`RollingBack → Clean`): nothing of the batch is applied.
    Failed { io_kind: Arc<str> },
    /// The rollback failed too (`PendingRollback`): the batch's outcome is unknown until a
    /// later commit or retry truncates it.
    Indeterminate { io_kind: Arc<str> },
}

/// The SM §8 `LogWriter` of one session, owned by its `DurabilityTask` alone (I1, SPEC R26).
/// The task moves it into each io-durability job and gets it back with the result, so one
/// batch is in flight per session and no lock guards it.
pub trait SessionLog: Send + 'static {
    /// One group commit: publish the batch's blobs, place a checkpoint first when one is due
    /// (FORMAT.md §6.1), append the frames, then the barrier (write + `sync_file` +
    /// `Ownership::revalidate`, SPEC R24). A writer in `PendingRollback` first retries its
    /// rollback and fails the batch `Indeterminate`, unwritten, if that fails again.
    /// Returns the ordinal of each record of `batch`, in order.
    fn commit(
        &mut self,
        lane: &InLane<DurabilityIo>,
        batch: &[CommitRecord],
    ) -> Result<Vec<u64>, BarrierError>;

    /// The user's "Retry storage" (SM §8): the `PendingRollback` truncation alone. A writer in
    /// `Clean` answers `Ok`.
    fn retry(&mut self, lane: &InLane<DurabilityIo>) -> Result<(), BarrierError>;
}

/// Store-private result of open job J1 (catalog row, reverse scan, tail bytes).
pub struct HeadRead(pub Box<dyn Any + Send>);

/// Store-private result of open job J2 (window rows, open sets, checkpoint-state blob).
pub struct WindowRead(pub Box<dyn Any + Send>);

/// Today's `ingestSessionTurn` (`session-search-ingest.mjs:121`): the session-search copy of a
/// completed turn's transcript, after its terminal record is durable.
pub trait TurnIngest: Send + Sync + 'static {
    /// Fire-and-forget; never fails the caller. `messages` is the model context.
    fn ingest_turn(&self, id: &ThreadId, header: &Header, messages: Vec<Value>);
}

/// A session's stored metadata as today's `readStoredSessionMetadata` gives it
/// (`store-summary-reader.mjs:386`): each field is `x || null`.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct SessionMeta {
    /// `session.title || null`.
    pub title: Option<String>,
    /// `session.agent || null`.
    pub agent: Value,
    /// `session.ownerSessionId || session.parentSessionId || null`.
    pub owner_session_id: Value,
    /// `session.sourceType || null`.
    pub source_type: Value,
    /// `Number(session.lastUsedAt) || 0`: every completed turn moves it.
    pub last_used_at: f64,
    /// `knownSessionCwds`' list-row part: `cwd`, `workspace.cwd`, `workspace.projectPath`,
    /// each a non-empty string, once.
    pub cwds: Vec<String>,
}

/// `Number(value) || 0`.
pub(crate) fn last_used(value: Option<&Value>) -> f64 {
    let n = value.map_or(0.0, mixdog_js::to_number);
    if n.is_nan() { 0.0 } else { n }
}

impl SessionMeta {
    /// From the index: the raw title and the list row's `summary` JSON.
    pub fn of(title: Option<String>, summary: &str) -> Self {
        let row: Value = serde_json::from_str(summary).unwrap_or(Value::Null);
        let field = |key: &str| row.get(key).cloned().unwrap_or(Value::Null);
        Self {
            title: title.filter(|title| !title.is_empty()),
            agent: field("agent"),
            owner_session_id: field("ownerSessionId"),
            source_type: field("sourceType"),
            last_used_at: last_used(row.get("lastUsedAt")),
            cwds: super::delete::row_cwds(&row),
        }
    }
}

/// Today's `onSensitiveValuesMarked(sessionId, listener)` (`sensitive-values.mjs:87`).
pub trait SensitiveMarks: Send + Sync + 'static {
    /// Calls `listener` whenever `thread` gains a sensitive value, until the returned guard
    /// drops.
    fn on_marked(&self, thread: &ThreadId, listener: Box<dyn Fn() + Send + Sync>) -> Box<dyn Send>;
}

/// Today's `ingestSessionIntoMemory` (`memory-ingest.mjs:15`) when a session closes.
pub trait CloseIngest: Send + Sync + 'static {
    /// Best effort: never fails. `cwd` is the session's; `messages` its model context.
    fn ingest(&self, id: &ThreadId, cwd: &str, messages: Vec<Value>) -> futures::future::BoxFuture<'static, ()>;
}

/// Store-private state of a model-context read between its lane steps.
pub struct ContextRead(pub Box<dyn Any + Send>);

/// What a model-context cpu step leaves.
pub enum ContextStep {
    /// The read continues with another io step.
    More(ContextRead),
    /// The model context, oldest first: each row's item id and its 1.4.5 message object.
    Done(Vec<(mixdog_core_api::ids::ItemId, Value)>),
}

/// Store-private position where appends continue (open-for-append happens at the first write).
pub struct AppendPosition(pub Box<dyn Any + Send>);

/// One compaction divider of the restored window (`SqliteStore::dividers`, 1.4.5's
/// "Conversation compacted" row): shown before window row `before` (the window's length:
/// after every row), then the model-switch boundaries anchored on its replacement entries.
#[derive(Clone, Debug, PartialEq)]
pub struct WindowDivider {
    pub before: usize,
    /// The `compacted` frame's ordinal: a boundary on its summary names it.
    pub ordinal: u64,
    pub cid: String,
    pub at: Option<i64>,
    pub model_switches: Vec<ModelSwitchEntry>,
}

/// A decoded log: the state at its newest checkpoint plus the committed frames after it
/// (SPEC R28). The session folds `tail` onto the checkpoint state with the same fold it uses
/// for live records, so a reopened thread equals the thread before it was unloaded.
pub struct OpenedLog {
    /// Folded header at the checkpoint.
    pub header: Header,
    pub history_rev: u64,
    /// Ordinal of the first history row of the lineage (the target of `thread/clear`).
    pub lineage_start: u64,
    /// Runs `started` without a terminal phase, approvals `requested` and not resolved, and
    /// queue entries not dequeued, as of the checkpoint, with their records.
    pub runs: Vec<(u64, RunRecord)>,
    pub approvals: Vec<(u64, ApprovalRecord)>,
    pub queue: Vec<(u64, QueueRecord)>,
    /// The newest visible, non-superseded rows before the checkpoint, oldest first, bounded
    /// by the UI window (≤ 200 rows, ≤ 2 MiB bodies).
    pub window: Vec<(u64, ItemRecord)>,
    /// The compaction dividers among the window's rows, in display order.
    pub dividers: Vec<WindowDivider>,
    /// Rows older than `window` exist.
    pub has_older: bool,
    /// The prompt-history session part as of the checkpoint: the lineage's non-superseded
    /// `user` rows, newest first, deduped, at most 50 (`prompt_history`); read in J2.
    pub prompts: Vec<String>,
    /// The session's `log_id` and the ordinal its next record gets (fork bases).
    pub log_id: String,
    pub next_ordinal: u64,
    /// Committed frames after the checkpoint, in ordinal order.
    pub tail: Vec<(u64, Record)>,
    pub append: AppendPosition,
}

/// The thread store's open and create paths (FORMAT.md §6.3, SPEC R28).
pub trait ThreadStore: Send + Sync + 'static {
    /// J1. `threadNotFound` for an unknown id.
    fn read_head(&self, lane: &InLane<InteractiveIo>, id: &ThreadId)
    -> Result<HeadRead, CoreError>;

    /// J2.
    fn read_window(
        &self,
        lane: &InLane<InteractiveIo>,
        id: &ThreadId,
        head: &HeadRead,
    ) -> Result<WindowRead, CoreError>;

    /// Frame scan, CRC and record parse of both reads.
    fn decode(
        &self,
        lane: &InLane<CpuInteractive>,
        id: &ThreadId,
        head: HeadRead,
        window: WindowRead,
    ) -> Result<OpenedLog, CoreError>;

    /// The lineage's non-superseded `user` rows, oldest first: the whole transcript today's
    /// `recomputePromptHistory` scans (a thread's prompt-history session part).
    fn user_rows(
        &self,
        lane: &InLane<InteractiveIo>,
        id: &ThreadId,
    ) -> Result<Vec<ItemRecord>, CoreError>;

    /// The lineage's whole history, oldest first, as the transcript pages it (archived rows
    /// included): the session's whole stored conversation (`readSessionHistory`).
    fn history_rows(
        &self,
        lane: &InLane<InteractiveIo>,
        id: &ThreadId,
    ) -> Result<Vec<ItemRecord>, CoreError>;

    /// The live history row `iid` of the lineage with its ordinal, as the transcript reads it;
    /// `None` when no live row has that id.
    fn history_row(
        &self,
        lane: &InLane<InteractiveIo>,
        id: &ThreadId,
        iid: &str,
    ) -> Result<Option<(u64, ItemRecord)>, CoreError>;

    /// The live `compacted` frame of the lineage whose replacement holds the entry `iid` (a
    /// compaction summary has no history row), with its ordinal and `cid`: a `model_switch`
    /// anchor on it is `{iid, ordinal}`. The newest such frame; `None` when no live one
    /// holds it.
    fn compaction_entry(
        &self,
        lane: &InLane<InteractiveIo>,
        id: &ThreadId,
        iid: &str,
    ) -> Result<Option<CompactionEntry>, CoreError>;

    /// The io step of a model-context read (the lineage's model rows since its last
    /// compaction, as acked so far): `None` starts the read; a stale page restarts it.
    fn context_io(
        &self,
        lane: &InLane<InteractiveIo>,
        id: &ThreadId,
        read: Option<ContextRead>,
    ) -> Result<ContextRead, CoreError>;

    /// One index read of a session's metadata; `None` when the catalog does not list it.
    fn session_meta(&self, id: &ThreadId) -> futures::future::BoxFuture<'static, Result<Option<SessionMeta>, CoreError>>;

    /// After a delete mark is acked: the index takes every projection acked so far, then the
    /// fork-aware purge removes each deleted session no live lineage reads (files and index
    /// rows). The ids it removed.
    fn purge_deleted(&self) -> futures::future::BoxFuture<'static, Result<Vec<String>, CoreError>>;

    /// The cpu step of a model-context read.
    fn context_cpu(
        &self,
        lane: &InLane<CpuInteractive>,
        read: ContextRead,
    ) -> Result<ContextStep, CoreError>;

    /// Open for append under the writer claim (tmp sweep, torn-tail truncation, SM §8
    /// `Opening`), at the thread's first write.
    fn open_log(
        &self,
        lane: &InLane<DurabilityIo>,
        id: &ThreadId,
        at: AppendPosition,
    ) -> Result<Box<dyn SessionLog>, BarrierError>;

    /// A new session: publishes `log.000000` whose first frame is `session` (`publish_file`).
    /// Returns the writer and the session frame's ordinal.
    fn create_log(
        &self,
        lane: &InLane<DurabilityIo>,
        id: &ThreadId,
        session: &CommitRecord,
    ) -> Result<(Box<dyn SessionLog>, u64), BarrierError>;
}

/// One item a history row shows.
#[derive(Clone, Debug, PartialEq)]
pub enum Shown {
    /// A new item.
    Item(ThreadItem),
    /// Facts for an item an earlier row showed (a tool result for its call's `ToolCall`):
    /// merged into that item by [`merge_update`]; nothing when that item is not in view.
    Update(ThreadItem),
}

/// A `ToolCall` update keeps the call (name, input, meta) and takes the result's output and
/// every `ToolRun` fact the update sets; any other update replaces the item.
pub fn merge_update(existing: &ThreadItem, update: &ThreadItem) -> ThreadItem {
    match (existing, update) {
        (
            ThreadItem::ToolCall {
                id,
                name,
                input,
                output,
                run,
                meta,
            },
            ThreadItem::ToolCall {
                output: new_output,
                run: new_run,
                ..
            },
        ) => {
            let mut run = run.clone();
            overlay(&mut run.call_id, &new_run.call_id);
            overlay(&mut run.result, &new_run.result);
            overlay(&mut run.raw_result, &new_run.raw_result);
            overlay(&mut run.is_error, &new_run.is_error);
            overlay(&mut run.started_at, &new_run.started_at);
            overlay(&mut run.completed_at, &new_run.completed_at);
            overlay(&mut run.ui_diff, &new_run.ui_diff);
            overlay(&mut run.tool_meta, &new_run.tool_meta);
            overlay(&mut run.count, &new_run.count);
            overlay(&mut run.completed_count, &new_run.completed_count);
            overlay(&mut run.aggregate, &new_run.aggregate);
            ThreadItem::ToolCall {
                id: id.clone(),
                name: name.clone(),
                input: input.clone(),
                output: new_output.clone().or_else(|| output.clone()),
                run,
                meta: meta.clone(),
            }
        }
        _ => update.clone(),
    }
}

fn overlay<T: Clone>(slot: &mut Option<T>, value: &Option<T>) {
    if value.is_some() {
        slot.clone_from(value);
    }
}

/// The display projection of history rows and queue entries (P §5.3). Runs on cpu-interactive
/// for live records and for the window of an open, so both paths show the same item.
pub trait Transcript: Send + Sync + 'static {
    /// The items a history row shows, in order (today's per-message rows: an assistant reply,
    /// its tool calls, its turn end, its status rows); empty for a row without one. Ids are
    /// stable per record, so a reopened thread shows the same items.
    fn items(&self, lane: &InLane<CpuInteractive>, record: &ItemRecord) -> Vec<Shown>;

    /// The `queued` row of a queue entry (`thread/queue/changed`).
    fn queued(&self, qid: &str, entry: &Value) -> Value;

    /// The history-row body of a user prompt (the model message the run reads back).
    fn user_message(&self, input: &TurnInput) -> Value;

    /// The thread's list row as the snapshot's `thread` field carries it.
    fn summary(&self, id: &ThreadId, header: &Header) -> ThreadSummary;
}

/// The session's tool-policy surface (`mixdog_tools::policy::SessionSurface`) derived from its
/// header (`schemaAllowedTools`, `disallowedTools`, `toolSpec`, scope and owner) and the live
/// settings, agent and project policy (today's `stageToolAvailability`,
/// `preDispatchDenyForSession`). The per-tool `connector_disabled` / `project_disabled` flags
/// depend on the called tool: the tool executor sets them per call.
pub trait ToolSurfaceSource: Send + Sync + 'static {
    fn surface(&self, thread: &ThreadId, header: &Header) -> SessionSurface;
}

/// Today's `prewarmSessionAutoEffort(session, provider)`: starts the effort judge's model load
/// when a session is created or opened, so its first judged turn does not wait for it.
/// Fire-and-forget and infallible; the judge applies its own skip rules (Auto effort off, the
/// session's `autoEffort: false`, a route it cannot judge) to the header.
pub trait EffortPrewarm: Send + Sync + 'static {
    fn prewarm(&self, thread: &ThreadId, header: &Header);
}

/// What the actor hands a new run.
pub struct RunStart {
    pub thread: ThreadId,
    pub turn: TurnId,
    pub input: TurnInput,
    /// The input row the actor committed for `input`: its item id and `item.body`.
    pub input_item: mixdog_core_api::ids::ItemId,
    pub input_body: Value,
    /// The session header (route, agent, effort, tool spec) as acked at turn start.
    pub header: Header,
    pub port: RunPort,
    /// The model context before the input row (today's `session.messages` at ask start).
    pub context: super::run::ModelContext,
    /// The session's current tool-policy surface: every `ToolPolicy::authorize` request of the
    /// run carries `borrow()` of it. Re-derived at turn start, on header changes and on
    /// `SessionHandle::refresh_surface`.
    pub surface: watch::Receiver<Arc<SessionSurface>>,
    /// The session cell's progress channel: the run publishes its markers into it
    /// (`run_host::progress::ProgressPublisher`); the worker views read the cell.
    pub progress: watch::Sender<crate::run_host::progress::RunProgress>,
    /// The session cell's working-messages channel: the run publishes the turn's messages
    /// before they are committed (`session.liveTurnMessages`); the route side reads the cell.
    pub turn_messages: watch::Sender<Arc<Vec<Value>>>,
    /// Cancelled by `turn/interrupt` (RL §5.2): every await of the run selects on it.
    pub cancel: CancellationToken,
    /// The same cancellation with the reason it was aborted for (Node's abort texts): the
    /// run's `RunConfig.signal`.
    pub signal: mixdog_agent::cancel::Cancel,
    /// The turn's review: the run calls `start` once its workspace is final and installs
    /// [`super::turn_snapshot::ReviewGate`] so no tool executes before the baseline; the actor
    /// seals it at settle.
    pub review: super::turn_snapshot::TurnSnapshot,
}

#[derive(Clone, Debug, PartialEq)]
pub enum RunOutcome {
    /// The run finished; the final result the loop produced (content, the report, how it ended,
    /// iterations, tool-call total, stop reason).
    Completed(Box<TurnResult>),
    Failed(TurnError),
    /// Stopped by its token.
    Interrupted,
}

/// The run loop (RL §5.2): owned by the actor, reports only to it.
pub trait RunFactory: Send + Sync + 'static {
    fn start(&self, run: RunStart) -> Pin<Box<dyn Future<Output = RunOutcome> + Send>>;
}

/// The thread feed of one actor instance (`feed.id = threadId`, a fresh epoch per load).
pub trait FeedFactory: Send + Sync + 'static {
    fn thread_feed(
        &self,
        id: FeedId,
        epoch: FeedEpoch,
        view: Arc<dyn FeedView>,
    ) -> Arc<dyn Feed>;
}
