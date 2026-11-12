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

    /// The rewrite a mark owes what the log stored before it (`redactSessionFiles`), with no batch to commit: what
    /// [`Self::commit`] runs before it appends. Nothing for a log that redacts nothing.
    fn redact(&mut self, _lane: &InLane<DurabilityIo>) {}
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
/// [`ThreadStore::copies_of`]: the sessions whose set names the session, the sessions whose set is unknown with the
/// ordinal each is projected to, and the first session the catalog holds as not readable (whether it names the
/// session is not known).
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct OffloadCopies {
    pub copies: Vec<String>,
    pub unknown: Vec<(String, i64)>,
    pub unreadable: Option<String>,
}

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
    /// The list row itself (`storedSessionRows()`' entry): its `messageCount`, `compactCount`,
    /// `cwd`, `desktopSession` and `workspace`.
    pub row: Value,
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
            row,
        }
    }
}

/// Today's `onSensitiveValuesMarked(sessionId, listener)` (`sensitive-values.mjs:87`).
pub trait SensitiveMarks: Send + Sync + 'static {
    /// Calls `listener` whenever `thread` gains a sensitive value, until the returned guard
    /// drops.
    fn on_marked(&self, thread: &ThreadId, listener: Box<dyn Fn() + Send + Sync>) -> Box<dyn Send>;

    /// `rememberSensitiveValues(sessionId, executionCalls)` (`loop/tool-phase.mjs:49`): the values the sensitive fills of
    /// `calls` (`{name, arguments}` objects, the execution view) carry are marked for `thread`, before any of the calls is
    /// committed or runs. True when the thread gained a value.
    fn remember(&self, thread: &ThreadId, calls: &[Value]) -> bool;

    /// Text of `from` went to `to` (a worker's turn reports to its owner): `from`'s values, now and later, are marked
    /// for `to` and on along `to`'s own carries (`SensitiveStore::carry`).
    fn carry(&self, _from: &ThreadId, _to: &ThreadId) {}

    /// The one listener told every thread that gained a value carried from another; `false` when one is set already.
    fn on_carried(&self, _listener: Box<dyn Fn(&ThreadId) + Send + Sync>) -> bool {
        false
    }

    /// `values` marked for `thread` again (a mark an earlier run journaled), carried as a new mark is.
    fn restore(&self, _thread: &ThreadId, _values: &[String]) -> bool {
        false
    }

    /// The journal the marks and carries are written to before they take effect; `false` when one is bound already.
    fn journal_with(&self, _journal: Arc<dyn mixdog_services::memory::sensitive::MarkJournal>) -> bool {
        false
    }

    /// `record` as the log stores it (`_messageForDisk`, `store/serialize.mjs:33`): every message body it carries (an item's
    /// body and prompt text, an amend's body, a compaction's replacement entries) through the sensitive projection
    /// (`redactSensitiveMessage`, `sensitive-projection.mjs:69`); `None` when it is stored as it is. A body the projection
    /// changes is held in full for the process, as Node's loaded session keeps it ([`Self::held`]).
    fn stored(&self, thread: &ThreadId, record: &Record) -> Option<Record>;

    /// The model rows of `thread` as the process's own copy has them (Node's `session.messages`, which the stored
    /// projection never touches): each row whose stored body was redacted gets back the body it was committed with.
    fn held(&self, thread: &ThreadId, rows: &mut [(mixdog_core_api::ids::ItemId, Value)]);

    /// `redactSensitiveMessages(sessionId, messages)` (`sensitive-projection.mjs:91`).
    fn redacted(&self, thread: &ThreadId, messages: &[Value]) -> Vec<Value>;

    /// How many marks `thread` has taken (0: none); it moves at every mark.
    fn version(&self, _thread: &ThreadId) -> u64 {
        0
    }

    /// `redactSensitiveText(sessionId, text)`.
    fn redact_text(&self, _thread: &ThreadId, text: &str) -> String {
        text.to_owned()
    }

    /// One pass over the records `thread` stored before its newest mark, oldest first (`redactSessionFiles`,
    /// `session-writers.mjs`): each as [`Self::stored`] stores it now, `None` when it stays as it is. A body it changes is
    /// held in full like a new one's; a body it keeps leaves the held copy as it is unless this pass took it.
    fn rewriter<'a>(&'a self, _thread: &ThreadId) -> Box<dyn FnMut(&Record) -> Option<Record> + 'a> {
        Box::new(|_| None)
    }
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
    /// The `session` record's `control`: the desktop's control session.
    pub control: bool,
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

/// An op of a thread as its log holds it (P §9.2): the indexed row and the frame that carries it.
#[derive(Debug, Clone, PartialEq)]
pub struct StoredOp {
    pub method: String,
    pub digest: String,
    pub state: mixdog_store::schema::record::OpState,
    /// The ordinal of the carrying frame: the op's `seq`.
    pub seq: u64,
    /// The response result the mutation record stored (≤ 16 KiB).
    pub result: Option<Value>,
    /// An `op` record's detail: the rejection, or `{effect, target}`.
    pub detail: Option<Value>,
}

/// The thread store's open and create paths (FORMAT.md §6.3, SPEC R28).
pub trait ThreadStore: Send + Sync + 'static {
    /// J1. `threadNotFound` for an unknown id.
    fn read_head(&self, lane: &InLane<InteractiveIo>, id: &ThreadId)
    -> Result<HeadRead, CoreError>;

    /// A stored session's whole header (its folded record), read without opening the thread:
    /// `threadNotFound` for an unknown or deleted one.
    fn read_header(&self, lane: &InLane<InteractiveIo>, id: &ThreadId) -> Result<Header, CoreError>;

    /// The `log_id` of a session `read_header` found.
    fn read_log_id(&self, lane: &InLane<InteractiveIo>, id: &ThreadId) -> Result<String, CoreError>;

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
    /// included): the session's whole stored conversation (`readSessionHistory`), with the
    /// history revision it is read at (it moves on every rewind and clear).
    fn history_rows(
        &self,
        lane: &InLane<InteractiveIo>,
        id: &ThreadId,
    ) -> Result<(u64, Vec<ItemRecord>), CoreError>;

    /// P §9.2 thread-scope lookup: the stored record of op `op` of thread `id` (the index
    /// holds every barrier acked so far), `None` when the thread never recorded it.
    fn thread_op(&self, lane: &InLane<InteractiveIo>, id: &ThreadId, op: &str) -> Result<Option<StoredOp>, CoreError>;

    /// The ops of thread `id` that were fenced (P §9.4), read once when the thread loads.
    fn fenced_ops(&self, lane: &InLane<InteractiveIo>, id: &ThreadId) -> Result<Vec<String>, CoreError>;

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

    /// How many rows [`context_io`](Self::context_io) and [`context_cpu`](Self::context_cpu) would read: the length of the
    /// model context, answered without reading, decoding or returning a row.
    fn context_len(&self, lane: &InLane<InteractiveIo>, id: &ThreadId) -> Result<usize, CoreError>;

    /// [`context_io`](Self::context_io)'s first step for the rows from the `skip`th on only (as
    /// [`context_len`](Self::context_len) counts them): the read's later steps are the same, and its rows are the context's
    /// without its first `skip`, with no frame of those read.
    fn context_from_io(&self, lane: &InLane<InteractiveIo>, id: &ThreadId, skip: usize) -> Result<ContextRead, CoreError>;

    /// The newest `records` history rows with the history revision, oldest first, and whether older rows exist: what
    /// [`history_rows`](Self::history_rows) returns, cut to its tail. A store that cannot read less returns the whole history cut.
    fn history_window(
        &self,
        lane: &InLane<InteractiveIo>,
        id: &ThreadId,
        records: usize,
    ) -> Result<(u64, Vec<ItemRecord>, bool), CoreError> {
        let (rev, mut rows) = self.history_rows(lane, id)?;
        let older = rows.len() > records;
        rows.drain(..rows.len().saturating_sub(records));
        Ok((rev, rows, older))
    }

    /// One index read of a session's metadata; `None` when the catalog does not list it.
    fn session_meta(&self, id: &ThreadId) -> futures::future::BoxFuture<'static, Result<Option<SessionMeta>, CoreError>>;

    /// Resolves once the index holds every write acknowledged so far (the exact class: an error when it is behind past
    /// the bound, or when a write of `id` failed to go in). A store without an index holds its writes at once.
    fn indexed(&self, _id: &ThreadId) -> futures::future::BoxFuture<'static, Result<(), CoreError>> {
        Box::pin(async { Ok(()) })
    }

    /// The copies of `id`'s conversation the catalog lists: the sessions whose reference set names `id`
    /// (`mixdog_store::offload_sources`: an inheritance's heir, a clear's fork, the copies of those, a session
    /// migrated naming `id`'s sidecars), once the catalog holds every acked projection, without opening any session;
    /// and every other session whose set is unknown (its header holds none: an older build's), with the ordinal it is
    /// projected to, for the caller to scan; and the first session it could not read (whether that one names `id` is
    /// not known). An error when the catalog cannot answer, or a copy naming `id` is still being made
    /// (`offloadInheriting` by this boot).
    fn copies_of(&self, id: &ThreadId) -> futures::future::BoxFuture<'static, Result<OffloadCopies, CoreError>>;

    /// Stores what a scan of `session`'s transcript at `ordinal` names (the sessions whose sidecars it may name), for a
    /// session [`ThreadStore::copies_of`] answered as unknown.
    fn record_offload_scan(&self, session: &str, ordinal: i64, sources: Vec<String>) -> futures::future::BoxFuture<'static, Result<(), CoreError>>;

    /// After a delete mark is acked: the index takes every projection acked so far, then the
    /// fork-aware purge removes each deleted session no live lineage reads (files and index
    /// rows). The ids it removed.
    fn purge_deleted(&self) -> futures::future::BoxFuture<'static, Result<Vec<String>, CoreError>>;

    /// Resolves once no sensitive rewrite holds the reads: a read awaits it before it takes an io-interactive thread, so
    /// reads issued during a rewrite wait off the lane instead of filling it. Stores that never rewrite resolve at once.
    fn unheld(&self) -> futures::future::BoxFuture<'static, ()> {
        Box::pin(std::future::ready(()))
    }

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

/// Whether `update` is for the item `existing`. A tool card is keyed by its provider call id (`run.callId`, Node's
/// `pendingToolCalls` key); every other item by its id.
pub fn updates(existing: &ThreadItem, update: &ThreadItem) -> bool {
    match (existing, update) {
        (ThreadItem::ToolCall { run: held, .. }, ThreadItem::ToolCall { run: new, .. }) => new.call_id.is_some() && held.call_id == new.call_id,
        _ => existing.id() == update.id(),
    }
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
            overlay(&mut run.live, &new_run.live);
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

    /// The items of `items` that are rows (no result updates), each with the byte length of the
    /// display row it stands for: what a history page's byte budget counts (Node measures
    /// `JSON.stringify` of the transcript row).
    fn rows(&self, lane: &InLane<CpuInteractive>, record: &ItemRecord) -> Vec<(ThreadItem, usize)>;

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

/// The tool fields of a new Lead thread's header: Node's `createSession` tool surface
/// (`resolveSessionToolSurface`: `tools`, `toolSpec`, `disallowedTools`) followed by
/// `seedToolSurface` (`applyDeferredToolSurface`: the deferred catalog and the callable names).
/// `thread/start` writes the returned header as the thread's first record. Fails when the
/// session's tools cannot be resolved (the skills of its folder cannot be read).
#[async_trait::async_trait]
pub trait NewThreadTools: Send + Sync + 'static {
    async fn seed(&self, thread: &ThreadId, header: &Header) -> Result<Header, String>;

    /// [`seed`](Self::seed) for the desktop's control thread (`thread/start{kind:"control"}`), which
    /// Node runs as the separate `ensureControlSession` runtime: a thread that is seeded like any other
    /// unless its owner says otherwise.
    async fn seed_control(&self, thread: &ThreadId, header: &Header) -> Result<Header, String> {
        self.seed(thread, header).await
    }

    /// `thread` was seeded and then not created (`thread/start` failed in between): whatever the
    /// seed opened for it is released. Called once per such thread, never for a created one.
    fn abandon(&self, _thread: &ThreadId) {}
}

/// A thread whose tools are being seeded, and whatever the seed opened for it. Dropped before
/// [`keep`](Self::keep) (the seed failed, the create was refused, the request was cancelled before the
/// thread existed, or the thread's first record failed), it abandons the thread. The thread's actor
/// owns it from the moment the thread is published, so a caller that goes away after that cannot
/// release the scope of a thread that is created; the actor keeps it once the first record is
/// durable, and from then on the thread's close or delete releases the scope.
pub(crate) struct SeededThread {
    tools: std::sync::Arc<dyn NewThreadTools>,
    id: ThreadId,
    created: bool,
}

impl SeededThread {
    pub(crate) fn new(tools: std::sync::Arc<dyn NewThreadTools>, id: ThreadId) -> Self {
        Self { tools, id, created: false }
    }

    /// The thread was created: its close or delete releases what the seed opened.
    pub(crate) fn keep(mut self) {
        self.created = true;
    }
}

impl Drop for SeededThread {
    fn drop(&mut self) {
        if !self.created {
            self.tools.abandon(&self.id);
        }
    }
}

/// The route a new Lead thread begins on. Node's session takes it from the runtime's route
/// (`rt.route`, `session-options.mjs`): the default the config resolves to (`resolveRoute(config, {})`,
/// `boot/config.mjs`), or the new task's draft pick, which the desktop applies as
/// `setRoute(pick, { applyToCurrentSession: true, keepMainModel: false })` before the first
/// prompt (`session-host-lifecycle.ts` `configureDraft`). The route is therefore settled before the
/// session's first record is composed, and the record then carries it.
///
/// `thread/start` adopts the route under the id the thread will have, composes the thread from it
/// ([`NewThreadTools`]), and seats it on the created thread's header.
#[async_trait::async_trait]
pub trait NewThreadRoute: Send + Sync + 'static {
    /// Makes `draft` (else the default route) the live route of `thread`, which does not exist yet.
    /// Answers the live route the thread then has (the record's create-only route keys are made
    /// from it, `new_route::create_keys`). Fails with the text of the refusal; the thread is then
    /// not created.
    async fn adopt(&self, thread: &ThreadId, draft: Option<&serde_json::Map<String, Value>>) -> Result<serde_json::Map<String, Value>, String>;

    /// [`adopt`](Self::adopt) for the desktop's control session, which is created before any model is chosen
    /// (`ensureControlSession`; only a turn needs a model, `resolveMissingRouteModelForFirstTurn`): the live route is
    /// readied when it has a model and answered as it is when it has none.
    async fn adopt_control(&self, thread: &ThreadId) -> Result<serde_json::Map<String, Value>, String>;

    /// The created, still empty `thread` takes its live route onto its header.
    async fn seat(&self, thread: &ThreadId) -> Result<(), String>;
}

/// The new task's draft workflow and orchestration mode (`configureDraft`, session-host-lifecycle.ts:765-778): the host calls
/// `invokeSession(sessionId, 'setWorkflow', [workflowId])` and `invokeSession(sessionId, 'setOrchestrationMode', [mode])` with no
/// options, which are `thread/setWorkflow` and `thread/setOrchestrationMode` of the new thread as a client calls them.
#[async_trait::async_trait]
pub trait DraftSettings: Send + Sync + 'static {
    async fn set_workflow(&self, thread: &ThreadId, workflow_id: &str) -> Result<(), mixdog_core_api::CoreError>;
    async fn set_orchestration_mode(&self, thread: &ThreadId, mode: &str) -> Result<(), mixdog_core_api::CoreError>;
}

/// The folder task threads run in: Node's `SessionHost.taskWorkspace()` (`session-host.ts`), which creates
/// `<userData>/workspace/unclassified` when missing and answers it as `realpath` prints it. A `thread/start` of
/// `kind: task` without a project begins there, as Node's `resolveSessionWorkspace()` and the control session's
/// `ensureControlSession` (`session-host-transport.ts`) create their sessions with `cwd: await taskWorkspace()`.
#[async_trait::async_trait]
pub trait TaskWorkspace: Send + Sync + 'static {
    async fn path(&self) -> Result<String, String>;
}

/// The agent definitions already own that folder (`AgentDefinitions::task_workspace`, the port of `taskWorkspace()`).
#[async_trait::async_trait]
impl TaskWorkspace for mixdog_core_agents::agents::AgentDefinitions {
    async fn path(&self) -> Result<String, String> {
        self.task_workspace().await.map_err(|error| error.to_string())
    }
}

/// What a `thread/start` and a `thread/fork` of the desktop need of the project side, which the directory cannot build
/// itself (the workspace transitions need the directory). Bound late by the composition.
#[async_trait::async_trait]
pub trait NewThreadPlace: Send + Sync + 'static {
    /// Every registered Project's path (`listProjectsStrict`).
    async fn projects(&self) -> Result<Vec<String>, String>;
    /// `createNewTask`'s worktree step, before the first prompt (`session-host-lifecycle.ts:847-897`): the created
    /// `thread` enters the draft's `worktree` (`{branch?, create?, confirmLarge?, fromDefault?}`) through the workspace
    /// service. `input` is the start's `initialInput` (its prompt titles the worktree, its submission id keys it).
    async fn enter_worktree(
        &self,
        thread: &ThreadId,
        worktree: &Value,
        input: Option<&Value>,
        cancel: &CancellationToken,
    ) -> Result<(), CoreError>;
}

/// `refreshEmptySessionToolPolicy()` (`tool-policy-refresh.mjs`): an empty, idle Lead thread's tool surface and prompt are
/// composed again from the settings as they stand now, after `invalidatePreSessionToolSurface()`. `true` is
/// `appliedToCurrentSession`; `false` is a thread with a turn in flight or a conversation (`admitsRefresh`), or one whose record
/// has no prompt identity (an older record: rebuilding would guess away custom instructions).
#[async_trait::async_trait]
pub trait EmptyToolSurface: Send + Sync + 'static {
    async fn refresh_empty(&self, thread: &ThreadId) -> Result<bool, String>;
}

/// What a room member's thread tells the room it sits in. Each call carries the room id and comes
/// after the thread's view carries the change.
pub trait RoomMemberEvents: Send + Sync + 'static {
    /// `noteMemberRows` (`agent-rooms.ts:424-433`): the handed-off questions the member holds
    /// moved (its approvals section's `handoffQuestions`), so the room is published again.
    fn questions_moved(&self, room_id: &str);
    /// The member's approval `approval_id` resolved: answered by a client on the room log (where
    /// a member's requests are shown, P §8.3) or anywhere else, or ended otherwise. The room stops
    /// showing it at once, as `scheduler.approve` does after its answer (`state.approval = null;
    /// deps.republish`, `agent-room-scheduler.ts:285-286`).
    fn approval_resolved(&self, room_id: &str, approval_id: &str);
}

/// `_refreshResumedTools(session, sessionId, preset)` of `resumeSession` (`session-lifecycle.mjs:598-620`):
/// a stored thread opened for use takes the tool surface its stored fields resolve to now
/// (`toolSpec`, `tools`, the agent exposure). `None`: nothing to write, or the surface could not be
/// resolved (the stored one stays, the cause logged).
#[async_trait::async_trait]
pub trait ResumedTools: Send + Sync + 'static {
    async fn refreshed(&self, thread: &ThreadId, header: &Header) -> Option<mixdog_store::schema::record::HeaderChange>;
}

/// Today's `prewarmSessionAutoEffort(session, provider)`: starts the effort judge's model load
/// when a session is created or opened, so its first judged turn does not wait for it.
/// Fire-and-forget and infallible; the judge applies its own skip rules (Auto effort off, the
/// session's `autoEffort: false`, a route it cannot judge) to the header.
pub trait EffortPrewarm: Send + Sync + 'static {
    fn prewarm(&self, thread: &ThreadId, header: &Header);
}

/// What a worker's turn carries into its run (`TurnRequest` of the agent tool's flow): set only
/// for a turn a job owns or a follow-up it sends. The session itself calls
/// `hooks.on_terminal_result` with the run's final result (before the turn settles); the run
/// calls `hooks.on_tool_result` per tool result and `hooks.notify` for the worker's own tool
/// completions.
#[derive(Clone)]
pub struct AgentTurn {
    pub kind: mixdog_agent::agent_tool::flow::seams::TurnKind,
    pub hooks: mixdog_agent::agent_tool::flow::seams::TurnHooks,
    /// The job's admitted slot, handed back during provider requests (`RunConfig.slot`).
    pub slot: Option<Arc<dyn mixdog_agent::env::Yielder>>,
    /// `ask`'s `context` option.
    pub context: Option<Value>,
    /// The trusted text a routine's skill is selected from.
    pub skill_selection: Option<String>,
    /// The caller runs the turn's progress watchdog (an agent dispatch, Node's
    /// `startDispatchWatchdog` around `askSession`): the run arms none of its own.
    pub caller_watchdog: bool,
}

/// What the actor hands a new run.
pub struct RunStart {
    /// `Some` for a worker's turn started by `agent_registry::SessionTurns`.
    pub agent_turn: Option<AgentTurn>,
    /// A routine fire's trusted skill-selection text (`options.skillSelection`).
    pub skill_selection: Option<String>,
    /// `snapshotPendingGoalReminder`: the Goal's state the turn's tail block carries (after the
    /// deferred tool delta, before the todo start reminder); the actor acknowledges it when the
    /// turn is accepted.
    pub goal_reminder: Option<super::goal_reminder::GoalReminder>,
    /// Where the run records the prompt-settings notice it carried (`snapshotPendingPromptSettingsNotice`, read after
    /// the turn's settings were reconciled); the actor acknowledges it when the turn is accepted.
    pub notice: super::prompt_notice::CarriedNotice,
    /// No person is attached to the turn: a worker's turn, a routine fire (schedule, webhook,
    /// room) or an automatic Goal turn. The progress watchdog stops only such a turn.
    pub unattended: bool,
    /// `pickDoneVerb(stats.turns)` for the turn (`beginTurn`): the one count of closed turns the session keeps.
    pub verb: &'static str,
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
    pub progress: watch::Sender<mixdog_core_run::run_host::progress::RunProgress>,
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
