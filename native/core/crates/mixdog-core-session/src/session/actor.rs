// Transparent names for existing callback/record shapes; no ownership or ordering change.
type EncodedBundle = (EncodedRecord, Vec<Shown>, Option<Record>);
type ActorAgentCompletion = (Option<Arc<dyn Fn(&TurnResult) + Send + Sync>>, oneshot::Sender<RunOutcome>);
type DraftQueueEntry = (super::turn_draft::DraftWrite, Option<oneshot::Sender<Result<(), RunError>>>);

use std::sync::Arc;
use std::sync::atomic::Ordering::SeqCst;
use std::time::Duration;

use mixdog_agent::agent_tool::flow::seams::TurnOutcome;
use mixdog_agent::agent_tool::flow::seams::TurnResult;
use mixdog_agent::agent_tool::flow::seams::TurnStart;
use mixdog_app_protocol::v2::thread::HistoryResetReason;
use mixdog_app_protocol::v2::thread::ItemNotificationParams;
use mixdog_app_protocol::v2::thread::PromptRestore;
use mixdog_app_protocol::v2::thread::StorageState;
use mixdog_app_protocol::v2::thread::ThreadContext;
use mixdog_app_protocol::v2::thread::ThreadHistoryResetParams;
use mixdog_app_protocol::v2::thread::ThreadIdParams;
use mixdog_app_protocol::v2::thread::ThreadNameSetParams;
use mixdog_app_protocol::v2::thread::ThreadNameUpdatedParams;
use mixdog_app_protocol::v2::thread::ThreadOpParams;
use mixdog_app_protocol::v2::thread::ThreadQueueChangedParams;
use mixdog_app_protocol::v2::thread::ThreadQueueDeleteParams;
use mixdog_app_protocol::v2::thread::ThreadRewindParams;
use mixdog_app_protocol::v2::thread::ThreadSectionParams;
use mixdog_app_protocol::v2::thread::ThreadValueParams;
use mixdog_app_protocol::v2::thread::TurnInput;
use mixdog_app_protocol::v2::thread::TurnNotificationParams;
use mixdog_app_protocol::v2::thread::TurnStartParams;
use mixdog_core_api::CoreError;
use mixdog_core_api::Feed;
use mixdog_core_api::Reply;
use mixdog_core_api::call::Caller;
use mixdog_core_api::call::CoreRequest;
use mixdog_core_api::domain::approval::ApprovalAsk;
use mixdog_core_api::domain::approval::ApprovalId;
use mixdog_core_api::feed::FeedFrame;
use mixdog_core_api::ids::FeedEpoch;
use mixdog_core_api::ids::FeedId;
use mixdog_core_api::ids::OpId;
use mixdog_core_api::ids::QueuedId;
use mixdog_core_api::ids::ThreadId;
use mixdog_core_api::ids::TurnId;
use mixdog_core_api::server_request::PendingServerRequest;
use mixdog_protocol::ApprovalResolution;
use mixdog_protocol::PromptContent;
use mixdog_protocol::PromptPart;
use mixdog_protocol::ThreadItem;
use mixdog_protocol::Turn;
use mixdog_protocol::TurnError;
use mixdog_protocol::TurnStatus;
use mixdog_rt::CancellationToken;
use mixdog_rt::LaneToken;
use mixdog_rt::TaskClass;
use mixdog_store::schema::blob::Slot;
use mixdog_store::schema::bounded::Digest;
use mixdog_store::schema::bounded::Json;
use mixdog_store::schema::bounded::Text;
use mixdog_store::schema::record::AmendRecord;
use mixdog_store::schema::record::Anchor;
use mixdog_store::schema::record::ApprovalPhase;
use mixdog_store::schema::record::ApprovalRecord;
use mixdog_store::schema::record::CompactedDropped;
use mixdog_store::schema::record::CompactedRecord;
use mixdog_store::schema::record::DequeueReason;
use mixdog_store::schema::record::Form;
use mixdog_store::schema::record::Header;
use mixdog_store::schema::record::HeaderChange;
use mixdog_store::schema::record::ItemRecord;
use mixdog_store::schema::record::MetaRecord;
use mixdog_store::schema::record::ModelSwitchEntry;
use mixdog_store::schema::record::ModelSwitchRecord;
use mixdog_store::schema::record::OpRef;
use mixdog_store::schema::record::QueueAction;
use mixdog_store::schema::record::QueueRecord;
use mixdog_store::schema::record::Record;
use mixdog_store::schema::record::Refs;
use mixdog_store::schema::record::ReplacementEntry;
use mixdog_store::schema::record::RewindReason;
use mixdog_store::schema::record::RewindRecord;
use mixdog_store::schema::record::RunPhase;
use mixdog_store::schema::record::RunRecord;
use mixdog_tools::exec::WakeReason;
use mixdog_tools::policy::SessionSurface;
use serde::Serialize;
use serde::de::DeserializeOwned;
use serde_json::Value;
use serde_json::json;
use tokio::sync::mpsc;
use tokio::sync::oneshot;
use tokio::sync::watch;

use super::SessionDeps;
use super::StartHold;
use super::control::ActiveRun;
use super::control::ControlCell;
use super::control::Ctl;
use super::durability::FromDurability;
use super::durability::ToDurability;
use super::frames::Note;
use super::frames::frame;
use super::new_id;
use super::ops;
use super::ops::Admit;
use super::ops::OpTable;
use super::ops::Waiter;
use super::outbox::Class;
use super::outbox::Effect;
use super::outbox::Entry;
use super::outbox::Outbox;
use super::outbox::Ready;
use super::outbox::answers_a_client;
use super::prompt_history;
/// The notice a safety refusal ends a turn with (`completeTurn`, `turn.mjs`); the desktop translates it by this text.
const REFUSAL_NOTICE: &str = "The model refused to respond (safety refusal) — retry or rephrase your prompt.";

use super::completions;
use super::pending;
use super::run::DrainRequest;
use super::run::DrainStage;
use super::run::InputState;
use super::run::ItemCommit;
use super::run::ModelContext;
use super::run::Priority;
use super::run::ProducerMsg;
use super::run::RunError;
use super::run::RunPort;
use super::run::RunShown;
use super::run::SteerInput;
use super::run::within_priority;
use super::seams::EncodedRecord;
use super::seams::RunOutcome;
use super::seams::RunStart;
use super::seams::Shown;
use super::state::Change;
use super::state::Display;
use super::state::Queued;
use super::state::SessionState;
use super::state::priority_rank;
use super::stop::Facts as PromptFacts;
use super::stop::PromptState;
use super::stop::WorkRef;
use super::user_facts::RowFacts;
use super::view::SessionView;
use mixdog_core_base::approvals::ApprovalBook;
use mixdog_core_base::approvals::Lineage;
use mixdog_core_base::approvals::request_frame;
use mixdog_core_base::approvals::request_params;
use mixdog_core_base::approvals::resolved_frame;
use mixdog_core_base::support::coded;
use mixdog_core_goal::goal::js::Goal;
use mixdog_core_ports::ports::threads::Section;

mod compaction_reminder;
mod draft;
#[cfg(test)]
mod early_result_tests;
mod failure;
mod goal;
#[cfg(test)]
#[allow(clippy::disallowed_methods, clippy::disallowed_types, reason = "test setup")]
mod head_follow_tests;
mod lifecycle;
mod mutation;
mod offload_prune;
mod producer;
#[cfg(test)]
mod prompt_start_tests;
mod prompts;
mod queue;
mod recovery;
mod run_end;
#[cfg(test)]
mod show_rule_tests;
mod status;
#[cfg(test)]
mod step_publication_tests;
mod turn_ops;
mod work_stop;

/// The header key of the session's saved provider state (Node `session.providerState`).
const PROVIDER_STATE: &str = "providerState";
/// The notes of a streaming reply that change only an in-progress item's text: published without rebuilding the view
/// ([`SessionActor::publish_notes`]).
const STREAMING_DELTAS: [&str; 2] = ["item/agentMessage/delta", "item/reasoning/textDelta"];
/// How long, and over how many frames, a stream may run on the last view before it is rebuilt.
const VIEW_DEFER_MS: i64 = 250;
const VIEW_DEFER_FRAMES: usize = 256;
/// What the desktop host throws when the runtime refuses a rename (`session-host-lifecycle.ts:228`).
const SESSION_NOT_AVAILABLE: &str = "Session is not available.";
/// What the desktop host throws for a title that is empty once normalized (`session-host-lifecycle.ts:226`).
const SESSION_TITLE_INVALID: &str = "Session title is invalid.";
/// What Node's IPC and remote methods threw for a title `sessionDisplayName` refuses (`ipc-validation.ts:1043`); with the
/// Node host gone the core is the first place a phone's rename is checked.
const TITLE_INVALID: &str = "title is invalid.";

/// How long a thread nobody watches may sit quiet before it unloads (`idleEvictMs` of
/// `session-service.mjs`: `MIXDOG_SESSION_IDLE_EVICT_MS`, default 5 minutes): one nobody ever watched, or one its last
/// subscriber left (`retainedAt`).
pub(super) const IDLE_EVICT: Duration = Duration::from_secs(5 * 60);
/// The same for a worker (an agent task's session): nobody opens it again once its result is handed back, and a loaded thread
/// holds its window, feed ring and model context. Codex unloads a thread nobody follows after 60 s (`thread_unload_delay`).
pub(super) const WORKER_IDLE_EVICT: Duration = Duration::from_secs(60);
/// `STATUS_SETTLE_MS` (`session-status-scheduler.mjs:14`): the beat a status pass waits after its
/// first mark, here the load's.
pub(super) const STATUS_SETTLE: Duration = Duration::from_millis(16);
/// How long a route move waits for its new route's context status before it is accepted without it.
const ROUTE_STATUS_DEADLINE: Duration = Duration::from_secs(10);
/// The header keys that move the route's context window (`applyRouteContextWindow`).
const WINDOW_KEYS: [&str; 5] = ["provider", "model", "contextWindow", "compactBoundaryTokens", "autoCompactTokenLimit"];
/// The header keys the workflow section is read from ([`SessionState::workflow`]).
const WORKFLOW_KEYS: [&str; 4] = ["workflow", "orchestrationMode", "pendingWorkflowId", "pendingOrchestrationMode"];

/// A room log's row and its room view leave as one notification: the view rides on the row's `item/completed` as
/// `roomView`; a cleared view is `roomView: null`, distinct from an absent one (unchanged). A view with no row in its
/// pass stays its own notification.
fn fold_room_view(notes: &mut Vec<Note>) {
    let mut at = 0;
    while at < notes.len() {
        if notes[at].method != "thread/roomView/updated" {
            at += 1;
            continue;
        }
        let row = notes[..at].iter().rposition(|note| note.method == "item/completed");
        let value = serde_json::from_slice::<Value>(&notes[at].params).ok().and_then(|mut section| section.get_mut("value").map(Value::take));
        let item = row.and_then(|row| serde_json::from_slice::<Value>(&notes[row].params).ok().map(|item| (row, item)));
        let (Some(value), Some((row, mut item))) = (value, item) else {
            at += 1;
            continue;
        };
        item["roomView"] = value;
        notes[row] = Note::new("item/completed", &item);
        notes.remove(at);
    }
}

fn archives_rows(change: &Change, ordinal: Option<u64>) -> bool {
    if ordinal.is_none() {
        return false;
    }
    let Change::Record { record, .. } = change else { return false };
    let Record::Compacted(compacted) = &**record else { return false };
    compacted.dropped.is_some() || compacted.dropped_count != Some(0)
}

/// `item/completed` of an item a history row shows.
fn item_completed(thread: &ThreadId, row: &ItemRecord, item: &ThreadItem) -> Note {
    Note::new(
        "item/completed",
        &ItemNotificationParams {
            thread_id: thread.clone(),
            turn_id: TurnId::from(row.turn.as_ref().map_or("", |turn| turn.as_str())),
            item: item.clone(),
            room_view: None,
        },
    )
}

/// The execution of a queued completion whose copy shows no row of its own.
fn suppressed_execution(entry: &Value) -> Option<String> {
    if entry.get("suppressDisplay") != Some(&Value::Bool(true)) {
        return None;
    }
    entry.pointer("/execution/id").and_then(Value::as_str).filter(|id| !id.is_empty()).map(str::to_owned)
}

/// Which parts of the session's route state a record's header change moves.
struct HeaderMoves {
    window: bool,
    held: bool,
    todo: bool,
    cwd: bool,
    route: bool,
    choice: bool,
}

impl HeaderMoves {
    fn of(record: &Record, header: &mixdog_store::schema::record::Header) -> Self {
        let moved = |keys: &[&str]| match record {
            Record::Meta(MetaRecord { change: Slot::Inline(change), .. }) => keys.iter().any(|key| {
                change.set.get(*key).is_some_and(|value| header.get(*key) != Some(value))
                    || (change.unset.iter().any(|unset| unset.as_str() == *key) && header.contains_key(*key))
            }),
            _ => false,
        };
        let held = moved(&["pendingRoute"]);
        let cwd = moved(&["cwd"]);
        Self {
            window: moved(&WINDOW_KEYS),
            held,
            todo: moved(&["todo"]),
            cwd,
            route: moved(&["provider", "model", "effort", "autoEffort", "fast", "modelParameters", "selectedContextWindow"]) || cwd || held,
            choice: moved(&["contextPercent", "contextTokens"]),
        }
    }
}

/// A header change computed on the actor over a copy of the header as projected, awaiting its outside reads there.
pub type AwaitingHeaderUpdate =
    Box<dyn FnOnce(mixdog_store::schema::record::Header) -> futures::future::BoxFuture<'static, mixdog_store::schema::record::HeaderChange> + Send>;

/// Where a test's injected unwind of the actor happens.
#[cfg(any(test, feature = "test-support"))]
pub(crate) enum UnwindAt {
    /// As the actor takes the message.
    #[cfg_attr(
        not(test),
        allow(dead_code, reason = "used by this crate's unit tests; compiled for test-support so the hooks around it behave as in a test build")
    )]
    Now,
    /// As the actor takes the next `Ctl::Delete`, before it answers it.
    #[cfg_attr(
        not(test),
        allow(dead_code, reason = "used by this crate's unit tests; compiled for test-support so the hooks around it behave as in a test build")
    )]
    Delete,
}

/// Pairs a compaction pass's `compacted` record with its event, which arrive from separate tasks. A pass that changed
/// the context emits one record and one event, each stream in pass order, so the n-th record of a turn pairs with its
/// n-th event, counted apart per side. A record the encoder rejects is still counted and its pair marked `lost`. The
/// pairs end with the turn's run (`run_ended`).
struct CompactPairs {
    turn: TurnId,
    /// Records seen so far this turn, and events.
    records: u64,
    events: u64,
    /// Events that came first, by their number: the detail waits for its record's divider.
    details: std::collections::BTreeMap<u64, String>,
    /// Dividers that came first, by their record's number, shown without a detail: the event fills it in through a view
    /// change standing on the record's outbox entry, so the record's rejection takes the patch with it.
    dividers: std::collections::BTreeMap<u64, WaitingDivider>,
    /// Records rejected before their event came.
    lost: std::collections::BTreeSet<u64>,
}

struct WaitingDivider {
    cid: String,
    entry: u64,
    item: ThreadItem,
}

impl CompactPairs {
    fn of<'a>(slot: &'a mut Option<Self>, turn: &TurnId) -> &'a mut Self {
        if slot.as_ref().is_none_or(|pairs| pairs.turn != *turn) {
            *slot =
                Some(Self { turn: turn.clone(), records: 0, events: 0, details: Default::default(), dividers: Default::default(), lost: Default::default() });
        }
        slot.as_mut().expect("just set")
    }
}

/// What waits on a scheduled compaction: the requests asked meanwhile, in arrival order, and
/// whether the settled turn's Goal continues.
pub(super) struct AfterCompaction {
    waiting: Vec<Waiting>,
    goal_active: bool,
}

/// One thing the scheduled compaction holds: a request, or an admitted retry turn (Node's
/// `retryFailedTurn` enqueues it and its `runtime.ask` waits on the gate like any ask).
#[allow(clippy::large_enum_variant, reason = "Retain the existing queued request/retry ownership without adding a separate allocation for each retry")]
pub(super) enum Waiting {
    Request(CoreRequest, Waiter),
    /// The idle plan of a person's clear ([`Inbox::ForkPlan`]).
    Plan(oneshot::Sender<Result<ForkSource, CoreError>>),
    Retry(super::quota_lane::RetryTurn),
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct HistoryRevision {
    log_id: String,
    end: u64,
    revision: u64,
}

pub(crate) struct ForkSource {
    pub revision: HistoryRevision,
    pub header: Header,
    pub active_input: Option<mixdog_core_api::ids::ItemId>,
    /// The gate held this plan and holds the thread's turns for its clear ([`Waiting::Plan`]) until this is dropped.
    pub _hold: Option<ClearHold>,
}

/// A clear the gate released is under way: dropped when it ended, however it ended, an answer nobody read included.
pub(crate) struct ClearHold(mpsc::UnboundedSender<JobDone>);

impl Drop for ClearHold {
    fn drop(&mut self) {
        let _ = self.0.send(JobDone::ClearSettled);
    }
}

pub(crate) struct RewindPreview {
    pub revision: HistoryRevision,
    pub item: mixdog_core_api::ids::ItemId,
    pub text: String,
}

pub(super) fn history_conflict() -> CoreError {
    CoreError::PreconditionFailed {
        precondition: mixdog_core_api::error::Precondition::Revision {
            expected: "unchanged history".into(),
            actual: "history changed or has pending writes".into(),
        },
    }
}

/// The task that waits on a checkout's HEAD watch: ended (and the follow left) when dropped.
struct HeadTask(tokio::task::JoinHandle<()>);

impl Drop for HeadTask {
    fn drop(&mut self) {
        self.0.abort();
    }
}

/// What `shouldRunGoalContinuation` read for a Goal entry.
pub(crate) enum GoalCheck {
    /// A closeout: the runtime's Goal now (`refreshGoalState`).
    Status(Option<Goal>),
    /// A continuation: the runtime's decision now (`continuationDecision`).
    Decision(mixdog_core_goal::goal::Continuation),
}

/// A turn whose input row's facts are being read (`start_run_with`).
/// A turn start waiting for the failed turn's provenance (`failedTurnProvenance`, `ask-session.mjs:199`).
pub(crate) struct RetryWait {
    input: TurnInput,
    body: Value,
    op_ref: Option<OpRef>,
    reply: Option<Effect>,
    prompt: Option<String>,
    wake: bool,
    provenance: Option<Value>,
    prior: Option<super::quota_lane::Prior>,
    work: WorkRef,
}

/// What the actor does first.
#[allow(clippy::large_enum_variant, reason = "Preserve the session-create state and its record ownership without a new allocation at the actor boundary")]
pub(crate) enum Init {
    /// A new thread: its `session` record, answered with `value` once durable.
    Create {
        session: Record,
        tx: Option<Waiter>,
        value: Value,
        /// What the tool seed opened; kept once the `session` record is durable, abandoned if it fails.
        seed: Option<super::seams::SeededThread>,
        /// The settings counter followed from when the creation began (`CreateSpec::settings`).
        settings: Option<SettingsFollow>,
        /// A heir Node creates in memory whatever its save does (`inheritSession`): answered and held on a failed barrier.
        kept: bool,
    },
    /// An opened log: interrupted runs and their approvals are recovered (P §5.2, §8.2); the
    /// ops its scope fenced are refused from the start (P §9.4).
    /// `ready` is told once the recovery is saved (or failed): the opener returns the thread only then.
    Open { fenced: Vec<String>, ready: oneshot::Sender<()> },
}

/// How many committed receipts the actor keeps in memory (`SUBMISSION_ID_MEMORY`, `session-flow/queue.mjs`). A cache only:
/// a miss asks the store's submission index, which keeps every receipt for the thread's life.
const SUBMISSION_MEMORY: usize = 256;

/// A send admitted and not yet answered, shared with the task that hears its answer: the retries that joined it, then the
/// answer they and later retries get. `Settled(None)`: it failed or got no answer, so a later send is a new attempt.
enum PendingSubmission {
    Waiting(Vec<Waiter>),
    Settled(Option<Value>),
}

/// The receipts of the thread's client submissions (`clientSubmissionId`), by id: the answer each committed acceptance got
/// (`{kind:"started", turnId}` or `{kind:"queued", queuedId}`). Its authority is the first committed acceptance record,
/// which the store indexes; this is what the actor has seen of it, and the sends admitted but not yet answered.
#[derive(Default)]
struct Submissions {
    order: std::collections::VecDeque<String>,
    answers: std::collections::HashMap<String, Value>,
    /// The admitted sends whose answer is not known yet (their records are not durable): a retry joins one and hears what it
    /// hears, success or failure, never a speculative success.
    pending: std::collections::HashMap<String, Arc<std::sync::Mutex<PendingSubmission>>>,
}

/// The input row's `meta.transcript` as Node persists it (`persistedUserTranscriptMetadata`): its fields in that order, then
/// what the core adds (`clientSubmissionId`); `completionVerb` is the turn's (`beginTurn`) and is not persisted.
fn persisted_user_order(meta: &mut serde_json::Map<String, Value>) {
    const ORDER: [&str; 18] = [
        "messageId",
        "attemptId",
        "at",
        "modelId",
        "model",
        "provider",
        "agent",
        "sender",
        "device",
        "fromAgent",
        "hop",
        "botChain",
        "roomRow",
        "checkpointId",
        "submissionIds",
        "consumedExecutionIds",
        "attachments",
        "routineTrigger",
    ];
    meta.shift_remove("completionVerb");
    let mut ordered = serde_json::Map::new();
    for key in ORDER {
        if let Some(value) = meta.shift_remove(key) {
            ordered.insert(key.into(), value);
        }
    }
    ordered.append(meta);
    *meta = ordered;
}

/// The trimmed `clientSubmissionId` of a start, if it names one.
fn submission_id(input: &TurnInput) -> Option<&str> {
    input.options.as_ref().and_then(|options| options.client_submission_id.as_deref()).map(mixdog_js::js_trim).filter(|id| !id.is_empty())
}

/// The sender of a user prompt (`transcriptMeta.device`, `options.restorable`).
#[derive(Clone, Debug, PartialEq)]
struct Submitter {
    device: String,
    /// The composer may take the prompt back when the turn is stopped (Node's `options.restorable !== false`).
    restorable: bool,
}

/// A turn start (any: a client's, a queued one, a completion wake, a Goal turn) waiting for the previous turn's
/// records to land.
struct DeferredStart {
    input: TurnInput,
    body: Value,
    op_ref: Option<OpRef>,
    reply: Option<Effect>,
    prompt: Option<String>,
    wake: bool,
    /// The fresh save `awaitPreviousTurnDurable` makes for it is underway: one more failure refuses it.
    retried: bool,
    work: WorkRef,
}

struct RunSlot {
    turn: TurnId,
    /// The work this run executes (the inputs it claimed, those it took at a boundary included), which a Stop of the run freezes.
    work: WorkRef,
    /// Each entry the run took at a boundary, as its own unit of work: a targeted Stop freezes only the unit it targets.
    injected: Vec<WorkRef>,
    /// The Stop that froze this run's work: its outcome is settled once the run's close is accepted.
    stop: Option<String>,
    /// The run's draft as streamed, which its `draft` records hold redacted.
    journal: super::turn_draft::DraftJournal,
    /// The prompt the run started on: what a stop may hand back.
    prompt: Arc<PromptState>,
    /// The provider of the route the turn started with (`routeMeta.provider`): a route change
    /// during the turn does not move the notices its end raises.
    provider: String,
    /// That route as the turn's transcript meta states it (`createTranscriptRouteMetadata`: `modelId`, the display
    /// `model`, `provider`), which the live end of a failure spreads into its row (`routeMeta`, `turn.mjs:139`).
    route_meta: serde_json::Map<String, Value>,
    /// The pending Goal reminder's revision the turn carries.
    goal_reminder: Option<u64>,
    /// The prompt-settings notice revision the run carried.
    notice: super::prompt_notice::CarriedNotice,
    /// The id of the run's input row.
    input_item: mixdog_core_api::ids::ItemId,
    /// An automatic Goal turn (`promptSource === 'goal-continuation'`).
    automatic: bool,
    /// A completion wake. Node wakes only the session it has current, so a wake of any other
    /// thread has no Node counterpart holding the ask lock (see [`Actor::ask_lock_held`]).
    wake: bool,
    /// The run's input shows no row (a kickoff, a retained retry): Node pushes none, so no immediate flush publishes the
    /// turn's start (frame-batched-store.mjs `flushImmediate`); its busy spinner shows with the runtime's next change.
    hidden: bool,
    /// Tool results the turn committed (its tool cards).
    tool_calls: u64,
    cancel: mixdog_agent::cancel::Cancel,
    /// The token `cancel` wraps: what bounds the turn's own lane jobs.
    token: CancellationToken,
    input: watch::Sender<InputState>,
    /// The run's input never became durable: no terminal record follows.
    start_failed: bool,
    /// A worker's turn: told the run's final result, then its outcome.
    agent: Option<ActorAgentCompletion>,
    /// The host submissions steered into this run (`turnSettlements`, `steering.mjs:219`): each
    /// is answered with this run's outcome, as the turn it joined settles.
    joined: Vec<oneshot::Sender<RunOutcome>>,
    /// The run's `onSensitiveValuesMarked` subscription (`ask-turn-state.mjs:104`).
    _marks: Box<dyn Send>,
    /// The turn's last model row (`session.messages` ends with it): the input row until the run
    /// commits another. A failed turn's completion is written onto it.
    last_model: Option<ItemRecord>,
    /// When the run began (`askStartedAt`) and the input row's `meta.transcript` (`transcriptMeta`): what a
    /// failure record that no end item states is built from.
    started_at: i64,
    transcript: Value,
    /// What the turn's stream and cards counted, for the live end of a failure.
    live: super::live_end::LiveCounts,
    /// `completionVerb` (`pickDoneVerb(stats.turns)` at `beginTurn`).
    verb: &'static str,
    /// The spinner's `liveCall` (`turn-live-call.mjs`).
    live_call: super::live_call::LiveCall,
    /// The session's input and output tokens as the turn began (`turn.inputBaseline`, `turn.outputBaseline`).
    tokens_at_start: (u64, u64),
    /// The run's registration with the core's lifecycle ([`super::BusyHold::run`]), held for the run's life: a confirmed stop's abort
    /// cancels it.
    _core_abort: Box<dyn Send + Sync>,
}

/// What a failed turn's close reads of its run ([`SessionActor::close_failed`]).
struct FailedClose<'a> {
    error: &'a TurnError,
    /// The route the turn started with: the live end's route (`turn.routeMeta`, `turn.mjs:555`), which a route change during
    /// the turn does not move. The durable completion reads the session's route at the close instead (ailedTurnCompletion).
    start_provider: &'a str,
    route_meta: &'a serde_json::Map<String, Value>,
    /// The turn's last model row, which the completion is recorded on.
    last: Option<&'a ItemRecord>,
    started_at: i64,
    /// The input row's `meta.transcript` (`transcriptMeta`).
    transcript: &'a Value,
    live: &'a mut super::live_end::LiveCounts,
}

/// What a finished turn's close reads of its run ([`SessionActor::close_done`]).
struct DoneClose<'a> {
    /// A stop handed the prompt back to a composer: a cancelled turn then shows no end (`reclaimed`, `turn.mjs:610`).
    reclaimed: bool,
    /// `turnOutcome`: `done` or `cancelled`.
    status: &'static str,
    /// The turn's own `completionVerb`.
    verb: &'static str,
    /// `turn.askResult.content`: what the run's final result says.
    result: &'a str,
    /// The route the turn started with (`turn.routeMeta`).
    route_meta: &'a serde_json::Map<String, Value>,
    /// The turn's last model row: the final reply, whose completion names the turn's verb.
    last: Option<&'a ItemRecord>,
    started_at: i64,
    /// The input row's `meta.transcript` (`transcriptMeta`).
    transcript: &'a Value,
    live: &'a mut super::live_end::LiveCounts,
}

fn invalid(path: &str, expected: &str) -> CoreError {
    CoreError::InvalidParams { path: path.into(), expected: expected.into() }
}

fn parse<T: DeserializeOwned>(params: &Value, expected: &str) -> Result<T, CoreError> {
    serde_json::from_value(params.clone()).map_err(|_| invalid("params", expected))
}

fn text<const N: usize>(value: &str, path: &str) -> Result<Text<N>, CoreError> {
    Text::try_from(value).map_err(|_| invalid(path, "a shorter id"))
}

fn id(value: &str) -> Text<{ mixdog_store::schema::bounded::ID_MAX }> {
    Text::try_from(value).expect("core-made ids are short")
}

/// The code of a `turn/start` the core refuses without a turn or a queue entry (the empty prompt Node's `submitAsync` answers
/// `false`). A client reads it as "not accepted".
pub const SUBMIT_REFUSED: &str = "SUBMIT_REFUSED";

/// The code of a turn refused because the previous turn is not saved to disk (`TurnPersistenceError`,
/// `turn-durability.mjs:21`).
pub const TURN_NOT_DURABLE: &str = "ETURNNOTDURABLE";

/// The code of a start whose work a user Stop froze: a stopped start's waiter, and an owner's retry of a stopped submission.
pub const TURN_STOPPED: &str = "ETURNSTOPPED";

/// The code of a Stop whose cancellation fired here but whose record could not be saved.
pub const STOP_NOT_SAVED: &str = "ESTOPNOTSAVED";

/// `promptDisplayText` (`queue-helpers.mjs:89`), trimmed: the display text the options give when it is not blank, else the
/// prompt's text parts.
fn display_text(input: &TurnInput) -> String {
    let given = input.options.as_ref().and_then(|options| options.display_text.as_deref()).filter(|text| !mixdog_js::js_trim(text).is_empty());
    mixdog_js::js_trim(given.map_or_else(|| prompt_text(input), str::to_owned).as_str()).to_owned()
}

/// `promptDisplayText(..).trim()` is not blank (`submission.mjs:10`) as far as the prompt's texts go: it shows text
/// ([`display_text`]), or holds a text the intake moved into the store (a pasted text, `materializePromptSubmission`), which
/// Node's `promptContentText` reads back and the store never keeps empty (`saveBuffer`).
fn shows_text(input: &TurnInput) -> bool {
    let stored = match &input.prompt {
        PromptContent::Parts(parts) => parts
            .iter()
            .any(|part| matches!(part, PromptPart::Text { attachment_ref: Some(reference), .. } if super::prompt_submission::is_attachment_ref(reference))),
        PromptContent::Text(_) => false,
    };
    stored || !display_text(input).is_empty()
}

/// The prompt's text parts, as the user row shows them.
fn prompt_text(input: &TurnInput) -> String {
    match &input.prompt {
        PromptContent::Text(text) => text.clone(),
        PromptContent::Parts(parts) => parts
            .iter()
            .filter_map(|part| match part {
                PromptPart::Text { text: Some(text), attachment_ref: None, .. } => Some(text.as_str()),
                _ => None,
            })
            .collect(),
    }
}

/// One queue entry taken back to the composer: what `restoreQueued` reads of it.
#[derive(Clone, Debug, Default, PartialEq)]
pub(super) struct Taken {
    id: String,
    /// The prompt's text (`entry.text`).
    text: String,
    /// `entry.pastedImages` and `entry.pastedTexts` (the options' maps), as queued: references or inline.
    pasted_images: Option<Value>,
    pasted_texts: Option<Value>,
    /// The `file` parts of the prompt (`entry.content`), as queued.
    files: Vec<Value>,
}

impl Taken {
    pub(super) fn of(queued: &Queued) -> Self {
        // `entry.text` is `promptDisplayText(content, options)` (`entry-shape.mjs:17`): the display text when it is not blank, so
        // a composer's chip tokens come back though the intake turned the pasted texts they name into stored parts
        // (`materializePromptSubmission`); else the prompt's text.
        let shown = queued.entry.pointer("/options/displayText").and_then(Value::as_str).filter(|text| !mixdog_js::js_trim(text).is_empty());
        let text = match shown {
            Some(shown) => shown.to_owned(),
            None => serde_json::from_value::<PromptContent>(queued.entry["message"].clone())
                .map(|prompt| prompt_text(&TurnInput { prompt, options: None }))
                .unwrap_or_default(),
        };
        let files = queued.entry["message"].as_array().map(|parts| parts.iter().filter(|part| part["type"] == "file").cloned().collect()).unwrap_or_default();
        Self {
            id: queued.qid.clone(),
            text,
            pasted_images: queued.entry.pointer("/options/pastedImages").cloned(),
            pasted_texts: queued.entry.pointer("/options/pastedTexts").cloned(),
            files,
        }
    }
}

/// The prompt a hand-back returns to its composer (`thread/promptRestore`), named by the submissions it answers: the id a
/// composer recognises as its own (`wasSubmittedHere`). Every hand-back (a stop's, a queued prompt's, a refused one's) is built here.
fn prompt_restore(ids: Vec<String>, text: String, device: String, at: i64) -> PromptRestore {
    PromptRestore { id: format!("restore-{at}-{}", ids.join(",")), ids, text, device, at }
}

/// The submission each queue entry answers (`options.clientSubmissionId`, which the sender registered), else its queue id.
fn submissions_of(queued: &[Queued]) -> Vec<String> {
    queued
        .iter()
        .map(|entry| entry.entry.pointer("/options/clientSubmissionId").and_then(Value::as_str).filter(|id| !id.is_empty()).unwrap_or(&entry.qid).to_owned())
        .collect()
}

/// The entries `restoreQueued(_, selectedId)` takes: the one named, or every one without a name.
pub(super) fn restore_taken(queue: &[Queued], selected: Option<&str>) -> Vec<Queued> {
    queue.iter().filter(|queued| selected.is_none_or(|id| queued_is(&queued.qid, &queued.entry, id))).cloned().collect()
}

/// Whether `selected` names the queue entry: its own queue id, or the submission it answers. Node names an entry by its submission
/// (`makeQueueEntry`), and the queue rows a client holds are named so (`queueOf`, protocol-client session-state.ts), so the id a
/// composer hands back is either one.
pub(super) fn queued_is(qid: &str, entry: &Value, selected: &str) -> bool {
    qid == selected || entry.pointer("/options/clientSubmissionId").and_then(Value::as_str) == Some(selected)
}

/// JavaScript truthiness of a queued value (`if (buffer)`).
fn truthy(value: &Value) -> bool {
    match value {
        Value::Null | Value::Bool(false) => false,
        Value::String(text) => !text.is_empty(),
        Value::Number(number) => number.as_f64().is_some_and(|n| n != 0.0),
        _ => true,
    }
}

/// `mergePastedField`: the entries' maps in one, an entry's falsy value skipped; `null` when empty.
fn merged_pasted(taken: &[Taken], field: impl Fn(&Taken) -> Option<&Value>) -> Value {
    let mut out = serde_json::Map::new();
    for entry in taken {
        if let Some(Value::Object(map)) = field(entry) {
            for (key, buffer) in map {
                if truthy(buffer) {
                    out.insert(key.clone(), buffer.clone());
                }
            }
        }
    }
    if out.is_empty() { Value::Null } else { Value::Object(out) }
}

pub(super) fn restored_reply(taken: &[Taken], current_text: Option<&str>) -> Value {
    let present = |text: &&str| !mixdog_js::js_trim(text).is_empty();
    let queued_text = taken.iter().map(|entry| entry.text.as_str()).filter(present).collect::<Vec<_>>().join("\n");
    let combined = [queued_text.as_str(), current_text.unwrap_or("")].into_iter().filter(present).collect::<Vec<_>>().join("\n");
    let mut reply = json!({
        "count": taken.len(),
        "ids": taken.iter().map(|entry| entry.id.as_str()).filter(|id| !id.is_empty()).collect::<Vec<_>>(),
        "text": combined,
        "pastedImages": merged_pasted(taken, |entry| entry.pasted_images.as_ref()),
        "pastedTexts": merged_pasted(taken, |entry| entry.pasted_texts.as_ref()),
    });
    let files: Vec<Value> = taken.iter().flat_map(|entry| entry.files.iter().cloned()).collect();
    if !files.is_empty() {
        reply["content"] = Value::Array(files);
    }
    reply
}

// `fixtures/desktop/queue/restore-queued-twin.json`: Node's `restoreQueued` (`take-entries.mjs`), recorded by
// `record-restore-queued.mjs` over a queue, the blobs on disk and the composer's text. Each case is the
// queue as a Node entry; here it is the queue entry the core keeps (`message`, `options.pasted*`).

/// What a mutation appends.
struct Plan {
    kind: PlanKind,
    value: Value,
    /// Recompute the prompt session part after release (`Some(publish)`).
    after: Option<bool>,
    /// A user-submitted prompt for the persisted history.
    prompt: Option<String>,
}

#[allow(clippy::large_enum_variant, reason = "Retain the existing run-plan state by value without boxing each TurnInput")]
enum PlanKind {
    /// The input as the message is built from it, how many of its images went without their original, and the op.
    StartRun(TurnInput, u32, Option<OpRef>),
    /// Records with their class, display and accept-time notes, then view-only changes.
    Records(Vec<(Record, Class, Display, Vec<Note>)>, Vec<Change>),
}

/// The device and the composer's claim travel with a queue entry until it becomes a turn (`start_next_queued`).
fn with_submitter(entry: &mut Value, submitter: &Submitter) {
    if !submitter.device.is_empty() {
        entry["transcriptMeta"]["device"] = json!(submitter.device);
    }
    entry["restorable"] = json!(submitter.restorable);
}

/// `queue{dequeue, delivered}`.
fn dequeue(qid: &str) -> Record {
    Record::Queue(QueueRecord { qid: id(qid), action: QueueAction::Dequeue, reason: Some(DequeueReason::Delivered), op: None, entry: None })
}

fn turn_of(run: &RunRecord) -> Option<Turn> {
    let status = match run.phase {
        RunPhase::Started => TurnStatus::InProgress,
        RunPhase::Completed => TurnStatus::Completed,
        RunPhase::Failed => TurnStatus::Failed,
        RunPhase::Interrupted => TurnStatus::Interrupted,
        RunPhase::Attempt => return None,
    };
    let error = match &run.detail {
        Some(Slot::Inline(detail)) => serde_json::from_value::<TurnError>(detail.clone()).ok(),
        _ => None,
    };
    let started = run.phase == RunPhase::Started;
    Some(Turn {
        id: TurnId::from(run.rid.as_str()),
        status,
        started_at: run.at.filter(|_| started),
        completed_at: run.at.filter(|_| !started),
        error,
        stop_reason: None,
        termination_reason: None,
        items: None,
    })
}

fn goal_lane_status(goal: &Goal) -> &str {
    goal.get("status").and_then(Value::as_str).unwrap_or_default()
}

/// A thread's follow of the settings counter (`SettingsChanges`): the count already behind the thread when it began is not its
/// own (a Node session's router counts the announcements delivered after it exists).
pub(crate) struct SettingsFollow {
    changes: watch::Receiver<u64>,
    seen: u64,
    shown: watch::Sender<u64>,
}

impl SettingsFollow {
    /// Follows `changes` from now: what the counter holds is behind the thread.
    pub(crate) fn begin(feed: super::turn_ops::SettingsFeed) -> Self {
        let super::turn_ops::SettingsFeed { mut changes, shown } = feed;
        let seen = *changes.borrow_and_update();
        shown.send_replace(seen);
        Self { changes, seen, shown }
    }

    /// Reports the announcements read so far as shown: the thread's state that counts them is published.
    fn shown(&self) {
        self.shown.send_if_modified(|shown| std::mem::replace(shown, self.seen) != self.seen);
    }

    /// The announcements since the last one read, however many the counter moved while the thread was busy; None once the configuration is gone.
    async fn announced(&mut self) -> Option<u64> {
        self.changes.changed().await.ok()?;
        let count = *self.changes.borrow_and_update();
        let announced = count - self.seen;
        self.seen = count;
        Some(announced)
    }
}

/// The announcements the thread's counter holds beyond what it has read; never ready for a thread without one (or once the configuration is gone).
async fn settings_changed(follow: &mut Option<SettingsFollow>) -> Option<u64> {
    match follow {
        Some(follow) => follow.announced().await,
        None => std::future::pending().await,
    }
}

/// The header change `normalizeStaleCompactingStage` makes: a `compaction` whose `lastStage` is `compacting`, or
/// whose `inProgress` is `true`, with `lastStage: 'interrupted'`, `inProgress: false` and `lastCheckedAt: now`;
/// `None` for any other header.
pub(crate) fn stale_compacting_change(header: &mixdog_store::schema::record::Header, now: i64) -> Option<HeaderChange> {
    let compaction = header.get("compaction")?.as_object()?;
    if compaction.get("lastStage").and_then(Value::as_str) != Some("compacting") && compaction.get("inProgress") != Some(&Value::Bool(true)) {
        return None;
    }
    let mut next = compaction.clone();
    next.insert("lastStage".into(), json!("interrupted"));
    next.insert("inProgress".into(), json!(false));
    next.insert("lastCheckedAt".into(), json!(now));
    let mut set = serde_json::Map::new();
    set.insert("compaction".into(), Value::Object(next));
    Some(HeaderChange { set, unset: Vec::new() })
}

/// A request routed to the actor.
pub(crate) enum Inbox {
    /// `onGoalStatusChange`: the thread's visible Goal changed.
    GoalChanged(Option<Goal>),
    /// A completion as the session's listeners receive it (`{content, meta}`): shown as a live
    /// card when the card gates admit it.
    CompletionCard {
        content: String,
        meta: Value,
    },
    /// The setup tool's desktop request `id` (`notifySessionUi(.., { kind: 'setup-ui', id })`,
    /// taken by the session store's `setup-ui` action): the thread shows it as `setupUiRequest`
    /// until it is settled or `window` (its claim window) ends.
    SetupUiRequest {
        id: String,
        window: std::time::Duration,
    },
    /// The desktop request `id` can no longer be claimed (claimed, or ended unclaimed).
    SetupUiSettled {
        id: String,
    },
    /// `TaskNotifier`: a detached job of this thread finished.
    TaskNotification {
        surface: String,
        task_id: String,
        status: String,
        text: String,
        /// `Some(ORIGIN_CHANNEL)`: a channel notification, queued as an entry of its own
        /// (unique id, no execution) through this same path.
        origin: Option<&'static str>,
        /// The bot-chain hop of the turn that started the job (0: none): the entry carries it as `transcriptMeta.hop`.
        hop: u32,
        /// The thread was loaded when the job finished (Node's owner is the runtime's live
        /// session, `notification-bus.mjs:41`); one opened for the completion is never woken.
        live: bool,
        /// Answered once the queued entry is durable (Node's `settlePendingMessageWrites` after
        /// `enqueuePendingMessage`), or once the same entry, already queued, is.
        durable: Option<oneshot::Sender<Result<(), RunError>>>,
    },
    /// An agent status signal (`agent_activity.rs`): `named`, the job board's, a job of this thread was added or finished;
    /// otherwise one from a source that names no session.
    AgentActivity {
        named: bool,
    },
    /// A value marked in a session whose text this thread holds reached it (`SensitiveMarks::carry`): what the thread
    /// stored goes as for a mark of its own, whether a turn runs or not.
    SensitiveCarried,
    Request {
        req: CoreRequest,
        tx: Waiter,
    },
    /// A `thread/header/patch` its caller counts only once its own record is committed ([`SessionActor::stored_patch`]).
    /// The attempt goes beside the request, not in it: an operation's parameters are the same each time it is sent.
    StoredPatch {
        req: CoreRequest,
        tx: Waiter,
        attempt: mixdog_core_ports::ports::threads::Attempt,
    },
    /// The op store of this thread's scope (`ThreadOps`): the actor is the scope's only writer.
    Op {
        call: super::thread_ops::OpCall,
        tx: Waiter,
    },
    /// Answered once everything accepted so far is on disk, a write a failed save held going again with it (`Ok`), or
    /// once that write fails (`Err`): a fork copies durable history, so it first makes the one fresh save a turn start makes.
    WritesLanded {
        tx: oneshot::Sender<Result<(), RunError>>,
    },
    /// An acknowledged source for fork, or the idle history a clear must protect.
    ForkPlan {
        idle: bool,
        tx: oneshot::Sender<Result<ForkSource, CoreError>>,
    },
    RewindPreview {
        item: mixdog_core_api::ids::ItemId,
        tx: oneshot::Sender<Result<RewindPreview, CoreError>>,
    },
    /// The handle finished the outside reads/writes; decide against that same history.
    CheckedHistory {
        req: CoreRequest,
        revision: HistoryRevision,
        tx: Waiter,
    },
    /// The model rows of records not yet stored, in order (`session.messages` holds them in memory): a body by item id.
    UnsavedRows {
        tx: oneshot::Sender<Vec<(String, Value, bool)>>,
    },
    /// What `scheduleQuotaResume` reads of the session.
    QuotaFacts {
        tx: oneshot::Sender<super::quota_lane::ResumeCheck>,
    },
    /// `cancelQuotaResume`: the explicit cancel of the pending resume.
    QuotaCancelled {
        tx: oneshot::Sender<()>,
    },
    /// `subscribeQuotaResume`: the queued resume of this thread (or of every thread) changed.
    QuotaResumeChanged,
    /// `fireQuotaResume({ generation })`: the scheduler fires the queued resume of `generation`.
    QuotaResumeFire {
        generation: u64,
        tx: oneshot::Sender<Result<super::quota_resume_scheduler::FireOutcome, String>>,
    },
    /// `commitSessionCompaction`: a manual compaction's result, committed when no turn runs.
    /// `snapshot`: the model context (item ids) the compaction was planned on.
    CommitCompaction {
        snapshot: Vec<mixdog_core_api::ids::ItemId>,
        compaction: super::run::Compaction,
        header: Option<super::turn_ops::CompactionHeader>,
        tx: oneshot::Sender<Result<super::turn_ops::CompactionCommit, CoreError>>,
    },
    /// `pushNotice(text, tone)` of the hosted runtime with no `transcript` option: the polished
    /// text as a toast of the session. Answered once the toast is in the session's state.
    PushToast {
        text: String,
        tone: String,
        tx: oneshot::Sender<Result<(), CoreError>>,
    },
    /// `HeaderUpdates::update_header`: `update` computes a header change on the actor, from the
    /// header as projected, and the change is written as the next record; answered once durable.
    UpdateHeader {
        update: mixdog_core_ports::ports::threads::HeaderUpdate,
        tx: Waiter,
    },
    /// [`Inbox::UpdateHeader`] whose change awaits an outside read (a route change's skill listing): the actor awaits
    /// it with no other message handled, so every other writer queues behind it, as behind Node's one synchronous pass.
    /// The step must not call the same session's actor.
    UpdateHeaderAwaiting {
        update: AwaitingHeaderUpdate,
        tx: Waiter,
    },
    /// A test's injected unwind of the actor.
    #[cfg(any(test, feature = "test-support"))]
    #[cfg_attr(
        not(test),
        allow(dead_code, reason = "used by this crate's unit tests; compiled for test-support so the hooks around it behave as in a test build")
    )]
    Unwind(UnwindAt),
    /// The end of a test's marked turn (`ControlCell::ask_marked`; Node's `markSessionDone`): the mark is cleared and
    /// the prune the turn stopped runs, as a turn's end runs it (`run_ended`).
    #[cfg(test)]
    AskEnded,
    /// The idle deadline, come now: a test on the real clock does not wait out [`IDLE_EVICT`], and the session auto-retention
    /// pass lets go of a session it loaded only to read ([`super::SessionDirectory::release`]). The unload is decided
    /// as the deadline's is: a thread that is watched, working or busy stays.
    IdleDue,
    /// [`Inbox::IdleDue`] for a caller that waits for the decision: answered once the thread stays loaded or has left the
    /// directory (an archive of a tree lets go of what it opened before the next tree starts).
    IdleRelease(oneshot::Sender<()>),
}

/// A route move waiting for its new route's context status: applied, with those figures, when the read returns.
struct PendingMove {
    seq: u64,
    /// The status pass its read is ([`SessionActor::next_status_pass`]).
    pass: u64,
    apply: MoveApply,
}

/// What a pending route move writes once its figures are read.
enum MoveApply {
    /// A `thread/header/patch` request, handled as it would have been.
    Request { req: CoreRequest, tx: Waiter },
    /// The change an [`Inbox::UpdateHeaderAwaiting`] computed.
    Change { change: mixdog_store::schema::record::HeaderChange, tx: Waiter },
}

/// Whether `msg` writes the thread's header: such a message waits behind a pending route move.
fn writes_header(msg: &Inbox) -> bool {
    match msg {
        Inbox::UpdateHeader { .. } | Inbox::UpdateHeaderAwaiting { .. } | Inbox::StoredPatch { .. } => true,
        Inbox::Request { req, .. } => req.method.as_str() == "thread/header/patch",
        _ => false,
    }
}

/// The end of a continuation decision's task, sent however it ends: armed until the decision is returned, it reports a task that
/// failed, panicked or was dropped as no decision ([`JobDone::GoalDecision`]`(None)`), which clears the pending-decision state
/// (`goal_scheduled`) so the thread is not counted busy for a decision that will never come.
struct DecisionEnd(Option<mpsc::UnboundedSender<JobDone>>);

impl Drop for DecisionEnd {
    fn drop(&mut self) {
        if let Some(jobs) = self.0.take() {
            let _ = jobs.send(JobDone::GoalDecision(None));
        }
    }
}

/// Results of lane jobs the actor submitted.
#[allow(
    clippy::large_enum_variant,
    reason = "Keep the established actor completion message and encoded record by value; boxing changes the mailbox representation and allocates on every encoded result"
)]
pub(crate) enum JobDone {
    /// A clear whose plan the gate held has ended ([`ClearHold`]): turns may start again.
    ClearSettled,
    /// What the runs the process died in leave, by run id ([`SessionActor::recover`]).
    Recovered(Vec<(String, super::seams::CrashedRows)>),
    /// A send of submission `id` got its answer ([`Submissions::admit`]): `answer` when it succeeded, its receipt.
    SubmissionSettled {
        id: String,
        answer: Option<Value>,
    },
    /// The store's receipt of submission `id`, read for the send `req` ([`SessionActor::look_up_submission`]).
    SubmissionLooked {
        id: String,
        req: CoreRequest,
        tx: Waiter,
        found: Result<Option<Value>, CoreError>,
    },
    /// The journal's record of the operation of the stored patch `req`, read for it ([`SessionActor::look_up_stored`]).
    StoredLooked {
        req: CoreRequest,
        tx: Waiter,
        attempt: mixdog_core_ports::ports::threads::Attempt,
        found: Result<Option<super::seams::StoredOp>, CoreError>,
    },
    Encoded {
        id: u64,
        /// The encoding, the live items, and the record as the log stores it when that differs.
        result: Result<EncodedBundle, CoreError>,
    },
    /// The items of a call's early result row, and the row (`None`: the cpu lane could not run it).
    EarlyShown {
        place: u64,
        turn: TurnId,
        shown: Option<(Vec<Shown>, ItemRecord)>,
    },
    PromptSession {
        session: Vec<String>,
        publish: bool,
    },
    PromptPersisted(Vec<String>),
    /// The records whose rows a durable compaction took out of the context ([`SessionActor::mark_archived`]).
    Archived(Vec<u64>),
    /// The recovery's records are durable (or failed): requests are served again.
    RecoveryDone(Result<(), RunError>),
    /// A prompt-history append job ended: the list as the writer saw it, and the appends that did
    /// not land (the write failed, or the lane refused or dropped the job).
    PromptFlushed {
        list: Option<Vec<String>>,
        unwritten: Vec<String>,
    },
    /// A wait of the prompt-history appends ended.
    PromptRetryDue(u64),
    /// A toast's time ran out (pushToast's timer).
    ToastExpired(String),
    /// The debounce of the turn's usage writes ran out ([`USAGE_SAVE_DEBOUNCE`]).
    UsageSaveDue,
    /// A draft file write ran ([`SessionActor::draft_pump`]).
    DraftWritten {
        write: super::turn_draft::DraftWrite,
        result: Result<(), CoreError>,
        ack: Option<oneshot::Sender<Result<(), RunError>>>,
    },
    /// The end record of run `.0` is durable: its draft file goes.
    DraftEnded(String),
    /// [`DRAFT_RETRY`] passed: the draft removals and the sweep that failed run again.
    DraftRetryDue,
    ApprovalId {
        turn: TurnId,
        ask: ApprovalAsk,
        reply: oneshot::Sender<ApprovalResolution>,
        result: Result<ApprovalId, CoreError>,
        /// `approvalSurface` of the asking session: `None` for a top-level one.
        surface: Option<super::delegation::ApprovalSurface>,
    },
    /// The running turn's session gained a sensitive value.
    SensitiveMarked,
    /// A Goal runtime answer for the lane (`None`: the call failed, nothing is published).
    GoalSeen(Option<Option<Goal>>),
    /// `goalTurnSettled`'s Goal.
    GoalSettled(Option<Option<Goal>>),
    /// `goalContinuation`'s decision.
    GoalDecision(Option<mixdog_core_goal::goal::Continuation>),
    /// The user prompt's archive of a finished Goal landed (its id, masked meanwhile).
    GoalArchived(String),
    /// `shouldRunGoalContinuation`'s reads for a dequeued Goal entry (`None`: the call failed).
    GoalEntryChecked {
        entry: Value,
        seen: Option<GoalCheck>,
    },
    /// A drain's reads for the Goal entries it would take: the drain goes on with them.
    SteerGoalsChecked {
        turn: TurnId,
        request: DrainRequest,
        reply: oneshot::Sender<Vec<SteerInput>>,
        checked: std::collections::HashMap<String, bool>,
        seen: Vec<(String, Value, Option<GoalCheck>)>,
    },
    /// `goalControl`'s answer for the request that asked.
    GoalControlled {
        op: Option<OpId>,
        tx: Waiter,
        result: Result<Value, mixdog_core_goal::goal::GoalError>,
    },
    /// A run's committed row with its facts read.
    CommitFacts {
        place: u64,
        turn: TurnId,
        item: ItemCommit,
        facts: RowFacts,
        ack: oneshot::Sender<Result<(), RunError>>,
    },
    /// A run's row whose facts could never be read (the io lane cannot run the job): the run hears it was not applied.
    CommitUnread {
        place: u64,
        turn: TurnId,
        item: ItemCommit,
        ack: oneshot::Sender<Result<(), RunError>>,
        error: CoreError,
    },
    /// A starting turn's input row with its facts read.
    InputFacts(Box<InputStart>),
    /// A starting turn whose input row's facts could never be read: the turn does not start, and its waiter hears why.
    InputUnread {
        reply: Option<Effect>,
        error: CoreError,
    },
    /// The failed turn's provenance read for a plain retry start.
    RetryProvenance(Box<RetryWait>),
    /// A user Stop's record landed (`Ok`) or failed to be saved.
    StopDurable {
        sid: String,
        result: Result<(), RunError>,
    },
    /// The Goal the runtime shows, read for the pending reminder the starting turn carries.
    ReminderGoal(Box<InputStart>, Option<Goal>),
    /// The quota-failed turn has nothing a resume could replay.
    QuotaUnresumable(TurnId),
    /// `agentStatusState()` read on load or after a job of this thread changed; `listener`: the
    /// status listener's read (see `read_agent_status`).
    AgentStatus {
        agents: mixdog_app_protocol::v2::thread::ThreadAgents,
        listener: bool,
    },
    /// The context status the load's status pass read (`read_context_display`), `null` for none.
    /// `pass` numbers the status pass that read it ([`SessionActor::next_status_pass`]).
    ContextStatus(u64, Value),
    /// The new route's context status a pending route move `seq` read ([`SessionActor::start_route_move`]); `None` when the read
    /// failed or missed its deadline.
    RouteStatus {
        seq: u64,
        status: Option<Value>,
    },
    /// The session's live workspace (`read_live_workspace`).
    LiveWorkspace(u64, Option<Value>),
    /// The follow of the checkout's HEAD that `follow_head` number `seq` made (`None`: outside a git checkout, or no file watcher).
    HeadFollowing(u64, Option<mixdog_scm::head_watch::HeadFollow>),
    /// HEAD of the checkout follow `seq` holds was written outside the session (`git switch`, `git branch -m`, a detach).
    HeadMoved(u64),
    /// The idle deadline found the thread quiet; `working`: its background work still runs.
    IdleChecked {
        working: bool,
    },
    /// A turn operation's answer (`session/turn_ops.rs`) for the request that asked.
    Replied {
        op: Option<OpId>,
        tx: Waiter,
        result: Result<Value, CoreError>,
    },
    /// A manual compaction ran and its PostCompact hook did: the actor re-marks the Goal reminder.
    Compacted {
        op: Option<OpId>,
        tx: Waiter,
        result: Value,
        recover: bool,
    },
    /// A manual compaction ended (its answer follows).
    CompactionEnded,
    /// The compaction the session tool scheduled answered.
    ScheduledCompactionEnded,
    /// The idle auto-clear's check of the thread's context meter answered: whether the turn waiting to start is to be
    /// preceded by a compaction.
    IdleClearChecked(bool),
    /// The idle auto-clear's compaction ended (`None`) or was given up: the turn waiting to start goes on, and a skipped
    /// clear says why.
    IdleClearEnded(Option<String>),
    /// The claim window of the desktop request `id` ended.
    SetupUiExpired(String),
    /// `retainedRetryInput()` for a `turn/retryFailed` that passed its first gates.
    RetryChecked {
        op: Option<OpId>,
        tx: Waiter,
        key: String,
        retained: Option<super::quota_lane::Retained>,
        provenance: Option<Value>,
    },
    /// `retainedRetryInput()` for a scheduler fire that passed its first gates.
    QuotaFireChecked {
        generation: u64,
        tx: oneshot::Sender<Result<super::quota_resume_scheduler::FireOutcome, String>>,
        retained: Option<super::quota_lane::Retained>,
        provenance: Option<Value>,
    },
    /// `reactivateUsageLimitedGoal` of a Goal resume answered.
    Resumed(Box<ResumeDone>),
    /// The model context a manual compaction's commit reconciles with (`commitSessionCompaction`).
    CompactionRows(Box<CommitRows>),
    /// The Goal the runtime shows, read for a pre-send compaction's reminder.
    CompactionReminder(Box<compaction_reminder::ReminderRead>),
    /// A durable compaction's prune starts (`pruneCompactedOffloads`): told when done.
    PruneOffloads(oneshot::Sender<()>),
    /// The prune's old tool-result sidecars, listed: the actor decides and deletes; told when done.
    PruneListed(Vec<std::path::PathBuf>, oneshot::Sender<()>),
}

/// A manual compaction's result and the context read to reconcile it with.
pub(crate) struct CommitRows {
    snapshot: Vec<mixdog_core_api::ids::ItemId>,
    compaction: super::run::Compaction,
    header: Option<super::turn_ops::CompactionHeader>,
    /// `runs_begun` when the read started: a turn begun since owns the context.
    begun: u64,
    rows: Result<Vec<(mixdog_core_api::ids::ItemId, Value)>, CoreError>,
    tx: oneshot::Sender<Result<super::turn_ops::CompactionCommit, CoreError>>,
}

/// `reactivateUsageLimitedGoal`'s answer with what the resume carries to settle it.
pub(crate) struct ResumeDone {
    op: Option<OpId>,
    tx: Waiter,
    key: String,
    goal_id: String,
    generation: Option<u64>,
    token: Arc<super::quota_lane::ResumeToken>,
    result: Result<Option<Goal>, mixdog_core_goal::goal::error::GoalError>,
}

pub(crate) struct InputStart {
    /// The work this start owns: a Stop that froze it while the row was read finishes it here, and it never runs.
    work: WorkRef,
    admitted_pick: Option<Value>,
    input: TurnInput,
    body: Value,
    facts: RowFacts,
    op_ref: Option<OpRef>,
    reply: Option<Effect>,
    prompt: Option<String>,
    wake: bool,
    agent: Option<super::control::AgentStart>,
    routine: Option<super::control::RoutineStart>,
}

impl Submissions {
    /// A committed receipt: the answer every later send of `id` gets. The first one stays.
    fn remember(&mut self, id: &str, answer: Value) {
        if self.answers.contains_key(id) {
            return;
        }
        self.answers.insert(id.to_owned(), answer);
        self.order.push_back(id.to_owned());
        while self.order.len() > SUBMISSION_MEMORY {
            if let Some(oldest) = self.order.pop_front() {
                self.answers.remove(&oldest);
            }
        }
    }

    /// A retry of a send still waiting for its answer joins it, or hears the answer it got. Gives the waiter back when no
    /// send of `id` is pending or the pending one failed (the retry is a new attempt).
    fn join(&mut self, id: &str, waiter: Waiter) -> Option<Waiter> {
        let Some(pending) = self.pending.get(id) else { return Some(waiter) };
        let mut pending = pending.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        match &mut *pending {
            PendingSubmission::Waiting(joined) => {
                joined.push(waiter);
                None
            }
            PendingSubmission::Settled(Some(answer)) => {
                let _ = waiter.send(Ok(Reply::Value(answer.clone())));
                None
            }
            PendingSubmission::Settled(None) => Some(waiter),
        }
    }

    /// Admits a send of `id`: the waiter its plan answers, which hands the answer to the original sender and every retry that
    /// joined meanwhile, then tells the actor (`JobDone::SubmissionSettled`), which keeps a success as the receipt.
    fn admit(&mut self, id: &str, original: Waiter, jobs: mpsc::WeakUnboundedSender<JobDone>) -> Waiter {
        let shared = Arc::new(std::sync::Mutex::new(PendingSubmission::Waiting(Vec::new())));
        self.pending.insert(id.to_owned(), shared.clone());
        let (wrapped, answered) = oneshot::channel::<Result<Reply, CoreError>>();
        let id = id.to_owned();
        tokio::spawn(async move {
            let answer = answered.await.ok();
            let value = match &answer {
                Some(Ok(Reply::Value(value))) => Some(value.clone()),
                _ => None,
            };
            let joined =
                match std::mem::replace(&mut *shared.lock().unwrap_or_else(std::sync::PoisonError::into_inner), PendingSubmission::Settled(value.clone())) {
                    PendingSubmission::Waiting(joined) => joined,
                    PendingSubmission::Settled(_) => Vec::new(),
                };
            for waiter in joined {
                let copy = match &answer {
                    Some(Ok(Reply::Value(value))) => Ok(Reply::Value(value.clone())),
                    Some(Err(error)) => Err(error.clone()),
                    // An answer of another kind, or none: the retry hears the drop, as the original does.
                    _ => continue,
                };
                let _ = waiter.send(copy);
            }
            if let Some(answer) = answer {
                let _ = original.send(answer);
            }
            if let Some(jobs) = jobs.upgrade() {
                let _ = jobs.send(JobDone::SubmissionSettled { id, answer: value });
            }
        });
        wrapped
    }

    /// The answer of a pending send is in: it is no longer pending, and a success is its receipt.
    fn settled(&mut self, id: &str, answer: Option<Value>) {
        self.pending.remove(id);
        if let Some(answer) = answer {
            self.remember(id, answer);
        }
    }
}

/// `pushToast`'s default `ttlMs` (`notice-surface.mjs:10`).
const TOAST_TTL: std::time::Duration = std::time::Duration::from_millis(3000);

/// `saveSession`'s debounce (`store.mjs`: "debounced (150 ms) unless `opts.immediate`").
const USAGE_SAVE_DEBOUNCE: std::time::Duration = std::time::Duration::from_millis(150);

/// How long a draft file whose removal failed first waits before it is removed again ([`SessionActor::draft_failed`]); each
/// round that still owes a write doubles the wait, up to [`DRAFT_RETRY_MAX`].
const DRAFT_RETRY: std::time::Duration = std::time::Duration::from_secs(2);

const DRAFT_RETRY_MAX: std::time::Duration = std::time::Duration::from_secs(300);

pub(crate) struct ActorChannels {
    pub ctl_rx: mpsc::Receiver<Ctl>,
    pub inbox_rx: mpsc::Receiver<Inbox>,
    pub prod_tx: mpsc::Sender<ProducerMsg>,
    pub prod_rx: mpsc::Receiver<ProducerMsg>,
    pub dur_tx: mpsc::Sender<ToDurability>,
    pub dur_rx: mpsc::Receiver<FromDurability>,
    /// The directory the thread unloads from.
    pub directory: std::sync::Weak<super::directory::DirInner>,
    /// This actor's part of a replay's settled signal.
    #[cfg(feature = "replay-settled")]
    pub settled: Option<Arc<super::replay_settled::Lane>>,
}

// Preparation may finish in any order. Only a ready prefix may affect the actor:
// even a draft marker must not overtake a commit whose attachment read is pending.
#[derive(Default)]
struct ProducerPlaces {
    front: u64,
    places: std::collections::VecDeque<Option<PreparedProducer>>,
}

enum PreparedProducer {
    Message(Box<ProducerMsg>),
    Job(Box<JobDone>),
}

impl ProducerPlaces {
    fn reserve(&mut self) -> u64 {
        let place = self.front + self.places.len() as u64;
        self.places.push_back(None);
        place
    }

    fn put(&mut self, place: u64, msg: PreparedProducer) {
        self.places[(place - self.front) as usize] = Some(msg);
    }

    fn pop(&mut self) -> Option<PreparedProducer> {
        let msg = self.places.front_mut()?.take()?;
        self.places.pop_front();
        self.front += 1;
        Some(msg)
    }
}

pub(crate) struct SessionActor {
    /// The directory slot the actor holds from its launch to its end. The first field, so it is released before anything else
    /// the actor holds is dropped, the create's reply among them: whoever learns the actor ended finds the slot gone.
    slot: Option<super::directory::SlotLease>,
    id: ThreadId,
    /// The create's seed until the thread's first record is acknowledged (`Init::Create`).
    seed: Option<super::seams::SeededThread>,
    /// A created thread whose `session` record has not settled yet: its failure ends the thread.
    uncreated: bool,
    /// A test's injected unwind waits for the next `Ctl::Delete` (`UnwindAt::Delete`).
    #[cfg(any(test, feature = "test-support"))]
    unwind_at_delete: bool,
    deps: Arc<SessionDeps>,
    cell: Arc<ControlCell>,
    feed: Arc<dyn Feed>,
    feed_id: FeedId,
    epoch: FeedEpoch,
    seq: u64,
    /// Frames published since the view was last built ([`Self::publish_notes`] defers the view across streaming deltas), and
    /// when it was built.
    deferred_frames: usize,
    view_built_ms: i64,
    /// Node's frame publication of this session's state, announced as `thread/frame` (`phone_frame.rs`).
    frames: super::phone_frame::Frames,
    lineage: Lineage,
    log_id: String,
    acked_end: u64,
    acked: SessionState,
    projected: SessionState,
    outbox: Outbox,
    /// Records released unsaved (a failed barrier) are handed again with the next records (`retry_due`).
    retry_due: bool,
    /// [`Inbox::WritesLanded`] waiters, each with the last entry accepted before it: answered once every record up to that
    /// entry is stored, or with the next failed barrier.
    writes_landed: Vec<(u64, oneshot::Sender<Result<(), RunError>>)>,
    /// The cause of the last failed barrier, which the next turn's refusal names.
    save_failure: Arc<str>,
    /// A turn asked while records are unsaved (`awaitPreviousTurnDurable`): it starts once they land, and is refused
    /// if their retry fails.
    deferred_start: Option<DeferredStart>,
    /// The idle auto-clear works on the start in `deferred_start`: its meter check or its compaction is under way, and no
    /// turn starts meanwhile ([`Self::starts_gated`]).
    idle_clearing: bool,
    /// Clears the gate released whose copy-and-clear is under way ([`Waiting::Plan`]): no turn starts meanwhile, so a prompt
    /// queued behind the clear runs after it ([`Inbox::ClearSettled`]).
    pub(super) clear_holds: usize,
    /// The idle auto-clear has run for the start about to be taken again: it is decided once, never twice for one start.
    idle_cleared: bool,
    /// The admitted start that already attempted a pre-switch compaction.
    pre_switch_compacted: Option<String>,
    /// Even the absence of a pending pick is frozen across the asynchronous start gates.
    admitted_pick: Option<(String, Option<Value>)>,
    /// The core's hold on new turn starts ([`SessionDeps::start_hold`]), read once where a start is decided: a client's
    /// `turn/start` ([`Self::turn_start`]) and a queue drain ([`Self::drain_gated`]). An in-core start waited it out before it
    /// was admitted (`SessionHandle::turn_start`).
    start_hold: watch::Receiver<StartHold>,
    /// The session's hold on the core while it is busy ([`Self::core_busy`], [`SessionDeps::core_work`]).
    core_busy_hold: Option<Box<dyn super::BusyHold>>,
    /// The outbox entry of the last closed turn's `turnCoverage` record: the turn is settled once it is gone.
    coverage: Option<u64>,
    book: ApprovalBook,
    ops: OpTable,
    run: Option<RunSlot>,
    /// `rt.codeGraphFirstTurnPrewarmDone`: the runtime's first turn armed the code-graph warm.
    first_turn_prewarm_done: bool,
    /// A room member's handed-off questions moved in the changes being published.
    room_questions_moved: bool,
    /// A room member's approvals resolved in the changes being published.
    room_approvals_resolved: Vec<String>,
    /// The running turn is that first turn and has not shown visible output yet.
    turn_prewarm_armed: bool,
    /// The live-workspace reads started; only the latest one's answer is published.
    live_workspace_reads: u64,
    /// The checkout whose HEAD the session follows (its header's `cwd`), the follows started, and the task that waits on the
    /// shared HEAD watch (ended with the session, or when its `cwd` moves).
    head_cwd: String,
    head_follows: u64,
    head_task: Option<HeadTask>,
    /// `stats.turns`: the turns this thread closed with an end (`publishTurnClose`), which `pickDoneVerb` reads.
    turns_closed: usize,
    /// state.stats (usage totals), folded from each model call's usage event.
    stats: super::stats::SessionStats,
    steer_marked: Vec<QueuedId>,
    /// The calls of the running turn whose wait for the person its abort ended, by call id, with what their card reads: the
    /// abort's `Error: <reason>`, which Node's question and approval waits settle with (`runAbortable`, ask-user-tool.mjs:249,
    /// before-hook.mjs:162) and its eager entry notices to the card (`notifyEarlyResult`, eager-dispatch/entry.mjs:39-44).
    abort_ended: std::collections::HashMap<String, String>,
    /// Opened from the store, not yet resumed: the first resume drains the restored queue.
    restored_queue: bool,
    /// The context display fields a running turn published, held for the turn's end ([`Self::on_context_section`]).
    held_display: Option<ThreadContext>,
    /// What a route move read for the header it is about to write ([`Self::route_status_read`]), taken by the step that accepts the
    /// move: the new route's status, or `None` when the read failed.
    route_status: Option<Option<(u64, Value)>>,
    /// The status passes started, and the newest pass whose result was applied: a result older than that is dropped, whatever its
    /// arrival order.
    status_passes: u64,
    status_applied: u64,
    /// The route move whose new figures are being read off the actor ([`Self::start_route_move`]).
    route_move: Option<PendingMove>,
    /// The header writes that arrived while a route move was pending, in order: they follow it, as Node's route writes queue behind
    /// the one in flight (`routeWrite`, routes-write.mjs:112,129).
    route_queue: std::collections::VecDeque<Inbox>,
    /// The count of route moves started, which names each pending one.
    route_moves: u64,
    /// Which completions showed a live card (Node's per-session execution dedup).
    cards: super::cards::CardGate,
    /// Executions the session's listener took: their queued copy is `suppressDisplay`.
    listened: std::collections::HashSet<String>,
    /// Executions whose queued copy a turn took in: its input row shows no row live.
    suppressed: std::collections::HashSet<String>,
    /// The work of the start being read (its provenance or its input row): what a Stop then freezes. A deferred start holds its
    /// own ([`DeferredStart::work`]).
    pending_work: Option<WorkRef>,
    /// The user Stops and the identities each froze ([`super::stop::StopBook`]).
    stops: super::stop::StopBook,
    /// A queue drain waited for [`Self::drain_gated`]: the pump runs it once starts are free.
    drain_held: bool,
    /// A delete closed the thread (`Ctl::Delete`): no run starts again.
    deleting: bool,
    /// The thread's tombstone landed (`Ctl::Closed`).
    tombstoned: bool,
    /// The closes not answered yet: each is answered once this session has left memory, or is known to stay
    /// ([`Self::answer_closes`]). Node's `closeSession` returns after `_clearSessionRuntime`, so a resume that follows it
    /// loads the session anew and never meets the closed runtime.
    closed_acks: Vec<oneshot::Sender<()>>,
    /// The Goal a user prompt is archiving, masked from the lane until the archive lands.
    goal_suppressed: String,
    /// A continuation decision is on its way.
    goal_scheduled: bool,
    /// The Goal the lane last saw and the deadline warning it last delivered.
    goal_watch: super::goal_lane::GoalWatch,
    /// A turn ended and its settlement (`turn_settled`) is not back yet: no turn starts.
    settling: bool,
    /// A worker's settling turn, and the host submissions steered into it: its outcome, told once
    /// the settlement is back.
    agent_done: Vec<(oneshot::Sender<RunOutcome>, RunOutcome)>,
    /// The last completed run's id, stop reason and termination reason (`ask-turn-commit.mjs`): its `turn/completed`
    /// carries the two, which the run record does not keep.
    completed_reasons: Option<(String, Option<String>, Option<String>)>,
    /// A turn's input row facts are being read: it starts next, no other turn does.
    starting: bool,
    /// Who sent the prompt the next run starts on: its device, and whether the composer may take it back. Set where the
    /// prompt is admitted (`turn/start`, a queued entry that starts), read when the run's input row is built.
    submitter: Option<Submitter>,
    /// `createSubmissionMemory`: the receipts of the thread's submissions by `clientSubmissionId`, so a retried send joins
    /// the original instead of posting the prompt twice; the store's submission index holds every receipt.
    submissions: Submissions,
    /// A send's receipt is being read from the store: the inbox waits, so what came after it is taken after it.
    submission_lookup: bool,
    /// The submission the store holds no receipt of, while its send is admitted ([`Self::mutation`] does not ask again).
    submission_looked: Option<String>,
    /// The mutation in hand is a stored patch's ([`Self::stored_patch`]): it is answered at its own record's barrier,
    /// and a precondition that does not hold is its failure, not a reply.
    storing: bool,
    /// A dequeued Goal entry waits on `shouldRunGoalContinuation`: no other turn starts.
    goal_checking: bool,
    /// The runs the process died in are being finalized (`recover`): requests wait for them, so the first read or turn
    /// sees the recovered conversation (Node recovers before the session is returned).
    recovering: bool,
    /// The opener waiting for the open-time recovery.
    opened: Option<oneshot::Sender<()>>,
    /// When a thread nobody watches, quiet since, is unloaded (Node's `idleEvictMs` deadline
    /// on the idle clock); `None` while it is not waiting for that.
    idle_evict_at: Option<tokio::time::Instant>,
    /// Loaded by an open (a read, a status pass, a carried mark), and no turn has run since: what a sidebar's read loads.
    only_read: bool,
    /// The releases waiting for the idle decision they asked for ([`Inbox::IdleRelease`]): answered once the thread stays, or has
    /// left the directory; dropped with the actor.
    idle_acks: Vec<oneshot::Sender<()>>,
    /// Lets the directory start close work only after the previous actor has disposed of its runtime.
    unload_stopped: Option<oneshot::Sender<()>>,
    /// What an archive preparation of this thread must not cross, as the last step left it ([`super::archive_trees::RetentionMark`]).
    retention_seen: Option<super::archive_trees::RetentionFacts>,
    /// A continuation was asked for while that check ran; it is decided once the check is back.
    goal_deferred: bool,
    /// The last Goal runtime call: each waits for the one before.
    goal_tail: Option<tokio::task::JoinHandle<()>>,
    /// The expiry timer of each toast in the queue (`toastTimers`), by toast id: `thread/clear` and the thread's close cancel them.
    toast_timers: std::collections::HashMap<String, tokio::task::AbortHandle>,
    /// The turn's usage books not yet written, and whether their debounced write is armed (Node's per-iteration
    /// `saveSession` is debounced, `store.mjs` `saveSession`; the turn's terminal save writes what is still waiting).
    usage_unsaved: Option<HeaderChange>,
    usage_save_armed: bool,
    /// The draft file writes not run yet, in order (one runs at a time, [`Self::draft_pump`]), with the producer's ack.
    draft_queue: std::collections::VecDeque<DraftQueueEntry>,
    draft_busy: bool,
    /// The draft write running is a run's own step (it has the producer's ack): no record is handed on until it lands.
    draft_busy_fenced: bool,
    producers: ProducerPlaces,
    /// The run's end, taken while rows it sent before it were still being prepared: it is applied
    /// ([`Self::run_ended`]) once they are accepted, as if it came after them.
    ended_run: Option<(TurnId, RunOutcome)>,
    /// Runs whose draft could neither be redacted nor removed: nothing more of them is written (`failClosed`,
    /// `turn-checkpoint.mjs:310`).
    draft_stopped: std::collections::HashSet<String>,
    /// Ended runs whose drafts wait for the held records (their end records among them) to land.
    drafts_after_save: Vec<String>,
    /// The drafts of ended runs still on disk, by run id: what each holds and the run's mark subscription, so a value marked
    /// before the file goes is taken out of it ([`JobDone::SensitiveMarked`]).
    ended_drafts: std::collections::HashMap<String, (super::turn_draft::DraftJournal, Box<dyn Send>)>,
    /// Drafts whose removal failed, by run id: removed again on the retry schedule until it succeeds.
    drafts_removing: std::collections::HashSet<String>,
    /// The open's sweep failed: it runs again on the retry schedule, keeping these runs' drafts.
    sweep_due: Option<Vec<String>>,
    /// While a draft write is owed: the wait before the next round ([`DRAFT_RETRY`] doubling up to [`DRAFT_RETRY_MAX`]).
    draft_backoff: Option<std::time::Duration>,
    /// The armed round of owed draft writes; aborted when the session ends.
    draft_retry: Option<tokio::task::JoinHandle<()>>,
    /// The session unloads once everything it accepted is on disk ([`Self::unload`]).
    unload_due: bool,
    /// Core shutdown stops the thread (`Ctl::Shutdown`).
    shutting_down: bool,
    /// Shutdown's write failed: nothing more is written ([`Self::exit_unwritten`]).
    exit_failed: Option<CoreError>,
    /// Callers released by this pump's entries ([`Effect::AfterPublish`]), told once its frames are published.
    after_publish: Vec<oneshot::Sender<Result<(), CoreError>>>,
    /// The callers waiting for the log's unknown outcome to be reconciled ([`Ctl::Reconcile`]), told by the retry's answer.
    reconciles: Vec<oneshot::Sender<Result<(), CoreError>>>,
    releasing: bool,
    replies_after_publish: Vec<(Waiter, Value)>,
    /// The surfaced tool calls running now (`createActiveToolTracker`'s `activeToolCalls`), by call id: category, count and start.
    active_calls: std::collections::BTreeMap<String, (&'static str, i64, i64)>,
    /// The early results whose card was not shown yet, by call id: each closes its card when the card is shown, unless the
    /// call's committed result was shown first. Emptied when the turn ends.
    early_results: std::collections::HashMap<String, (ItemRecord, ThreadItem)>,
    /// How many settings changes this thread announced (`setupChangeSeq`).
    setup_changes: u64,
    /// The prompt-history appends not on disk yet, and their write-behind and retry (`prompt-history-store.mjs`).
    prompt_appends: prompt_history::AppendQueue,
    /// Answered once the deleted thread's turn ended.
    delete_closed: Option<oneshot::Sender<Result<(), &'static str>>>,
    /// The delete's go for the mark with the header change to append, awaited once `delete_closed` answered.
    delete_mark: Option<oneshot::Receiver<serde_json::Map<String, Value>>>,
    /// Answered at the mark's ack.
    delete_marked: Option<oneshot::Sender<Result<(), RunError>>>,
    generation: u64,
    pending: bool,
    indeterminate: bool,
    save_risk: SaveRisk,
    published_storage: StorageState,
    /// A hidden input's start changed the runtime and no runtime note published it yet (`RunSlot::hidden`): a snapshot shows the
    /// runtime as last published, idle, as Node's store held it (a kickoff sets no busy until the turn's next runtime change).
    runtime_held: std::sync::atomic::AtomicBool,
    ch: ActorChannels,
    jobs_tx: mpsc::UnboundedSender<JobDone>,
    jobs_rx: mpsc::UnboundedReceiver<JobDone>,
    /// The tool-policy surface every run's authorize requests carry.
    surface: watch::Sender<Arc<SessionSurface>>,
    /// The quota-settlement guard and its store calls.
    quota: super::quota_lane::QuotaLane,
    /// `retryClaim`: the `<thread>\0<turnKey>` of the retry already admitted, so a late second
    /// click cannot enqueue another.
    retry_claim: String,
    /// `flags.quotaResumePending`: a quota resume revives the Goal and holds the next turn back.
    quota_pending: Option<Arc<super::quota_lane::ResumeToken>>,
    /// The generation of the queued resume this session last answered (fired, superseded or
    /// found unreplayable). Node cancels that entry synchronously; here the cancel lands on the
    /// quota lane after, so until then the entry is read as gone.
    quota_answered: Option<u64>,
    /// `state.commandBusy` / `flags.autoClearRunning`: compactions running.
    compactions: u32,
    /// `pendingCompactSessionIds` holds this session: the session tool scheduled a compaction for
    /// when the turn settles.
    compact_scheduled: bool,
    /// A user's `/compact` asked while a turn ran (`scheduleCompactForTurnEnd`): it runs once the session is idle, holds no
    /// command and shows nothing queued, after the turn and its queued follow-ups.
    manual_compact_due: bool,
    /// While a drain runs: the queue's ids in order as it started, and the entries it handed back so far
    /// ([`Self::hand_back_all`]).
    drain_handbacks: Option<(Vec<String>, Vec<super::state::Queued>)>,
    /// The scheduled compaction runs (`createCompactionGate`'s tail).
    after_compaction: Option<AfterCompaction>,
    /// The run's compaction divider and the pass's event, whichever came first.
    compact_pairs: Option<CompactPairs>,
    /// A retry the compaction held, released while another turn it held ran: it is the next turn
    /// (Node's retry ask waits on the ask lock behind that turn).
    pending_retry: Option<super::quota_lane::RetryTurn>,
    /// The next run's input row shows no bubble: it is already on screen (a retained retry's `suppressDisplay`), or it is
    /// for the model alone (a kickoff).
    retry_hidden: bool,
    /// The transcript was rewritten (a compaction, a rewind, a clear, a restarted context) since its lineage
    /// was named: the next turn names a new one (`mintTranscriptEpoch`, `turn-checkpoint.mjs`).
    transcript_rewritten: bool,
    /// The prefix guard of this actor incarnation, handed to each of its runs; it ends with the actor.
    prefix_guard: Arc<super::seams::PrefixGuardSlot>,
    /// A compaction's prune a running turn stopped: it runs once that turn has ended (`offload_prune`).
    prune_deferred: bool,
    /// `None`: not read yet; `Some(None)`: the failed turn has none.
    retry_provenance: Option<Option<Value>>,
    /// The failed message a retained retry resends (`retainedUserTurn`): the retry row keeps its id and carries its
    /// recorded completions. Taken by the next turn start like `retry_provenance`.
    retry_prior: Option<super::quota_lane::Prior>,
    /// Turns begun so far: a manual compaction's commit is refused when one began since its read.
    runs_begun: u64,
    /// A model call of the running turn already counted its own usage (`usageMetricsTurnIncremental`),
    /// so the turn's end adds no totals.
    usage_incremental: bool,
}

async fn guard_run(run: impl std::future::Future<Output = ()>, ctl: mpsc::Sender<Ctl>, turn: TurnId) {
    use futures::FutureExt;
    if let Err(panic) = std::panic::AssertUnwindSafe(run).catch_unwind().await {
        let what = panic
            .downcast_ref::<&str>()
            .map(|text| (*text).to_owned())
            .or_else(|| panic.downcast_ref::<String>().cloned())
            .unwrap_or_else(|| "a panic".to_owned());
        tracing::error!(turn = %turn.as_str(), "the turn's task panicked: {what}");
        let outcome = RunOutcome::Failed(TurnError { message: format!("the turn ended on an internal error: {what}"), data: json!({}), provider_error: None });
        let _ = ctl.send(Ctl::RunEnded { turn, outcome }).await;
    }
}

fn input_row(
    (iid, turn): (&mixdog_core_api::ids::ItemId, &TurnId),
    op: Option<OpRef>,
    body: Value,
    facts: RowFacts,
    input: &TurnInput,
    has_submitter: bool,
    hidden: bool,
) -> ItemRecord {
    let shown = display_text(input);
    let shown_blank = has_submitter && !facts.visible && facts.prompt.is_none() && !shown.is_empty();
    let listed = facts.visible || shown_blank;
    ItemRecord {
        iid: id(iid.as_str()),
        turn: Some(id(turn.as_str())),
        role: Some(Text::try_from("user").expect("short")),
        form: Form::Message,
        model: true,
        visible: listed && !hidden,
        archive: None,
        op,
        prompt: facts.prompt.or_else(|| shown_blank.then_some(shown)).filter(|_| !hidden).map(Slot::Inline),
        refs: Vec::new().try_into().expect("empty list fits"),
        body: Slot::Inline(body),
    }
}

fn prompt_state(input: &TurnInput, submitter: Option<&Submitter>, wake: bool) -> Arc<PromptState> {
    Arc::new(PromptState::new(PromptFacts {
        text: display_text(input),
        ids: input.options.as_ref().and_then(|options| options.client_submission_id.clone()).filter(|id| !id.is_empty()).into_iter().collect(),
        device: submitter.map(|submitter| submitter.device.clone()).unwrap_or_default(),
        restorable: submitter.is_some_and(|submitter| submitter.restorable) && !wake,
        committed: false,
        entry: json!({ "message": input.prompt, "options": input.options }),
        user_stopped: false,
        reclaim: None,
    }))
}

struct TurnTask {
    warm: super::turn_warm::WarmNote,
    hooks: Arc<dyn super::lifecycle_hooks::LifecycleHooks>,
    thread: ThreadId,
    header: mixdog_store::schema::record::Header,
    review: super::turn_snapshot::TurnSnapshot,
    cancel: mixdog_agent::cancel::Cancel,
    ctl: mpsc::Sender<Ctl>,
    turn: TurnId,
}

impl TurnTask {
    async fn run(
        self,
        admission: impl std::future::Future<Output = Result<Box<dyn Send>, mixdog_scm::error::ScmFailure>>,
        future: impl std::future::Future<Output = RunOutcome>,
    ) {
        let Self { warm, hooks, thread, header, review, cancel, ctl, turn } = self;
        let warm = warm.begin().await;
        let (outcome, admitted) = match admission.await {
            Ok(guard) => (future.await, Some(guard)),
            Err(mixdog_scm::error::ScmFailure::Cancelled) => (RunOutcome::Interrupted, None),
            Err(failure) => {
                let message = super::worktree::thrown_message(&failure);
                (RunOutcome::Failed(TurnError { message, data: json!({}), provider_error: None }), None)
            }
        };
        let failure = match &outcome {
            RunOutcome::Completed(_) => None,
            RunOutcome::Failed(error) => Some(mixdog_mcp::hooks::stop_failure_type(&error.message)),
            RunOutcome::Interrupted => Some("unknown"),
        };
        if let Some(error_type) = failure {
            tokio::spawn(async move { hooks.stop_failure(&thread, &header, error_type).await });
        }
        review.finish(&cancel).await;
        drop(warm);
        let _ = ctl.send(Ctl::RunEnded { turn, outcome }).await;
        drop(admitted);
    }
}

async fn sleep_until(deadline: Option<tokio::time::Instant>) {
    match deadline {
        Some(deadline) => mixdog_rt::time::sleep_until(deadline).await,
        None => std::future::pending().await,
    }
}

/// A delete's go for its mark; an error when the delete dropped it.
async fn mark_go(mark: &mut Option<oneshot::Receiver<serde_json::Map<String, Value>>>) -> Result<serde_json::Map<String, Value>, oneshot::error::RecvError> {
    match mark {
        Some(mark) => mark.await,
        None => std::future::pending().await,
    }
}

/// Evidence behind this session's standing save warning. Outbox entries can disappear when a request is refused
/// or a durability task is lost; neither event proves that a record was saved.
#[derive(Default)]
struct SaveRisk {
    /// Accepted records still owed a write, even if the outbox eventually loses them.
    retained: std::collections::BTreeSet<u64>,
    /// Attempted records whose outcome must be reconciled, including records no longer owed a retry.
    unknown: std::collections::BTreeSet<u64>,
}

impl SaveRisk {
    fn outstanding(&self) -> bool {
        !self.retained.is_empty() || !self.unknown.is_empty()
    }

    fn acked(&mut self, ordinals: &[(u64, u64)]) {
        for &(id, _) in ordinals {
            self.retained.remove(&id);
        }
        // The writer reconciles its pending rollback before it can append and acknowledge anything new.
        if !ordinals.is_empty() {
            self.unknown.clear();
        }
    }
}

#[cfg(test)]
mod save_risk_tests {
    use super::SaveRisk;

    #[test]
    fn clearing_the_outbox_does_not_cover_retained_records() {
        let mut risk = SaveRisk::default();
        risk.retained.insert(5);
        // The outbox can be discarded on handoff failure. Neither that nor an unrelated ack covers record 5.
        risk.acked(&[]);
        risk.acked(&[(6, 10)]);
        assert!(risk.outstanding());
        risk.acked(&[(5, 11)]);
        assert!(!risk.outstanding());
    }
}

impl SessionActor {
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        id: ThreadId,
        deps: Arc<SessionDeps>,
        cell: Arc<ControlCell>,
        feed: Arc<dyn Feed>,
        epoch: FeedEpoch,
        lineage: Lineage,
        log_id: String,
        acked_end: u64,
        state: SessionState,
        surface: watch::Sender<Arc<SessionSurface>>,
        ch: ActorChannels,
    ) -> Self {
        // The owner's start is stamped by the first session of the process (`PENDING_PROCESS_START_MS`).
        pending::owner_started_ms(deps.clock.now_ms());
        let (jobs_tx, jobs_rx) = mpsc::unbounded_channel();
        let goal_watch = super::goal_lane::GoalWatch::new(state.sections.goal.as_ref());
        let stats = super::stats::SessionStats::opened(state.header.get("usageReadout"));
        #[cfg(any(test, feature = "test-support"))]
        let (prompt_marks, record_marks) = (cell.prompt_marks.clone(), cell.record_marks.clone());
        Self {
            goal_watch,
            surface,
            feed_id: FeedId::from(id.as_str()),
            #[cfg(any(test, feature = "test-support"))]
            outbox: Outbox::numbered_on(deps.limits, record_marks),
            #[cfg(not(any(test, feature = "test-support")))]
            outbox: Outbox::new(deps.limits),
            slot: None,
            seed: None,
            uncreated: false,
            #[cfg(any(test, feature = "test-support"))]
            unwind_at_delete: false,
            id,
            cell,
            feed,
            deferred_frames: 0,
            view_built_ms: 0,
            epoch,
            seq: 0,
            frames: Default::default(),
            lineage,
            log_id,
            acked_end,
            projected: state.clone(),
            acked: state,
            retry_due: false,
            writes_landed: Vec::new(),
            save_failure: Arc::from(""),
            deferred_start: None,
            idle_clearing: false,
            clear_holds: 0,
            idle_cleared: false,
            pre_switch_compacted: None,
            admitted_pick: None,
            start_hold: deps.start_hold.clone(),
            core_busy_hold: None,
            coverage: None,
            book: ApprovalBook::default(),
            ops: OpTable::default(),
            run: None,
            first_turn_prewarm_done: false,
            room_questions_moved: false,
            room_approvals_resolved: Vec::new(),
            turn_prewarm_armed: false,
            live_workspace_reads: 0,
            head_cwd: String::new(),
            head_follows: 0,
            head_task: None,
            turns_closed: 0,
            stats,
            steer_marked: Vec::new(),
            abort_ended: Default::default(),
            restored_queue: false,
            held_display: None,
            route_status: None,
            status_passes: 0,
            status_applied: 0,
            route_move: None,
            route_queue: Default::default(),
            route_moves: 0,
            cards: Default::default(),
            listened: Default::default(),
            suppressed: Default::default(),
            pending_work: None,
            stops: Default::default(),
            drain_held: false,
            deleting: false,
            tombstoned: false,
            closed_acks: Vec::new(),
            goal_suppressed: String::new(),
            goal_scheduled: false,
            settling: false,
            agent_done: Vec::new(),
            completed_reasons: None,
            starting: false,
            submitter: None,
            submissions: Submissions::default(),
            submission_lookup: false,
            submission_looked: None,
            storing: false,
            goal_checking: false,
            recovering: false,
            opened: None,
            idle_evict_at: None,
            only_read: false,
            idle_acks: Vec::new(),
            unload_stopped: None,
            retention_seen: None,
            goal_deferred: false,
            goal_tail: None,
            toast_timers: std::collections::HashMap::new(),
            usage_unsaved: None,
            usage_save_armed: false,
            draft_queue: std::collections::VecDeque::new(),
            draft_busy: false,
            draft_busy_fenced: false,
            producers: ProducerPlaces::default(),
            ended_run: None,
            draft_stopped: std::collections::HashSet::new(),
            drafts_after_save: Vec::new(),
            ended_drafts: std::collections::HashMap::new(),
            drafts_removing: std::collections::HashSet::new(),
            sweep_due: None,
            draft_backoff: None,
            draft_retry: None,
            unload_due: false,
            shutting_down: false,
            exit_failed: None,
            after_publish: Vec::new(),
            reconciles: Vec::new(),
            releasing: false,
            replies_after_publish: Vec::new(),
            active_calls: std::collections::BTreeMap::new(),
            early_results: std::collections::HashMap::new(),
            setup_changes: 0,
            #[cfg(any(test, feature = "test-support"))]
            prompt_appends: prompt_history::AppendQueue::numbered_on(prompt_marks),
            #[cfg(not(any(test, feature = "test-support")))]
            prompt_appends: Default::default(),
            delete_closed: None,
            delete_mark: None,
            delete_marked: None,
            generation: 0,
            pending: false,
            indeterminate: false,
            save_risk: SaveRisk::default(),
            published_storage: StorageState::Ok,
            runtime_held: std::sync::atomic::AtomicBool::new(false),
            ch,
            jobs_tx,
            jobs_rx,
            quota: super::quota_lane::QuotaLane::new(&deps.quota),
            retry_claim: String::new(),
            quota_pending: None,
            quota_answered: None,
            compactions: 0,
            compact_scheduled: false,
            manual_compact_due: false,
            drain_handbacks: None,
            after_compaction: None,
            compact_pairs: None,
            pending_retry: None,
            retry_hidden: false,
            transcript_rewritten: false,
            prefix_guard: Arc::default(),
            prune_deferred: false,
            retry_provenance: None,
            retry_prior: None,
            runs_begun: 0,
            usage_incremental: false,
            deps,
        }
    }

    /// Takes the slot the actor holds until it ends ([`super::directory::SlotLease`]).
    pub(crate) fn hold(&mut self, slot: super::directory::SlotLease) {
        self.slot = Some(slot);
    }

    pub async fn run(mut self, init: Init) {
        let mut settings = self.boot(init);
        self.stepped();
        loop {
            let deadline = self.book.next_deadline();
            let producers_open = self.outbox.producer_room() && self.producers.places.len() < self.ch.prod_rx.max_capacity();
            let marking = self.delete_closed.is_none() && self.delete_mark.is_some();
            tokio::select! {
                biased;
                // First: a write announces before it answers, so a read sent after the answer sees the change counted.
                Some(announced) = settings_changed(&mut settings) => { self.stepping(); self.on_settings_changed(announced) }
                Some(ctl) = self.ch.ctl_rx.recv() => { self.stepping(); self.on_ctl(ctl) }
                go = mark_go(&mut self.delete_mark), if marking => { self.stepping(); self.mark_deleted(go.ok()) }
                Some(msg) = self.ch.dur_rx.recv() => { self.stepping(); self.on_durability(msg) }
                Some(done) = self.jobs_rx.recv() => {
                    self.stepping();
                    match done {
                        JobDone::PruneListed(candidates, told) => self.prune_listed(candidates, told).await,
                        done => self.on_job(done),
                    }
                }
                // The core's hold moved while a queue drain waits on it: the pump below drains once it is open (a release, a
                // cancelled drain).
                Ok(()) = self.start_hold.changed(), if self.drain_held => self.stepping(),
                _ = sleep_until(deadline), if deadline.is_some() => { self.stepping(); self.on_deadline() }
                _ = sleep_until(self.idle_evict_at), if self.idle_evict_at.is_some() => { self.stepping(); self.on_idle_evict() }
                _ = sleep_until(self.frames.due()), if self.frames.due().is_some() => {
                    self.stepping();
                    let flushed = self.frames.flush();
                    self.publish_frame(flushed);
                }
                Some(msg) = self.ch.prod_rx.recv(), if producers_open => { self.stepping(); self.on_producer(msg) }
                Some(msg) = self.ch.inbox_rx.recv(), if !self.recovering && !self.submission_lookup => { self.stepping(); self.take_inbox(msg).await }
                else => break,
            }
            self.apply_ready_producers();
            if self.producers.places.is_empty()
                && let Some((turn, outcome)) = self.ended_run.take()
            {
                self.run_ended(turn, outcome);
            }
            while self.route_move.is_none()
                && let Some(msg) = self.route_queue.pop_front()
            {
                self.take_inbox(msg).await;
            }
            self.pump();
            let flushed = if self.outbox.is_empty() { self.frames.chain_end() } else { None };
            self.publish_frame(flushed);
            if self.unload_due && self.outbox.is_empty() && self.save_risk.unknown.is_empty() {
                self.unload_due = false;
                if self.tombstoned {
                    self.try_unload();
                } else if self.idle_evict_at.is_none() || !self.idle_acks.is_empty() {
                    self.on_idle_evict();
                }
            }
            if !self.closed_acks.is_empty() && !self.unload_due {
                self.try_unload();
            }
            if let Some(follow) = &settings {
                follow.shown();
            }
            self.hold_core_while_busy();
            self.publish_flags();
            self.stepped();
            if self.cell.closed.load(SeqCst) && self.outbox.is_empty() && !self.unload_due && self.delete_closed.is_none() && self.delete_mark.is_none() {
                break;
            }
        }
        self.wind_down();
    }

    fn boot(&mut self, init: Init) -> Option<SettingsFollow> {
        let mut created_at = None;
        self.restored_queue = matches!(init, Init::Open { .. });
        match init {
            Init::Create { session, tx, value, seed, settings, kept } => {
                self.seed = seed;
                self.uncreated = true;
                created_at = settings;
                self.projected.status_pending = true;
                self.acked.status_pending = true;
                let reply = if kept { Effect::Kept { tx, value } } else { Effect::Reply { op: None, tx, value } };
                self.accept_record(session, Class::Normal, Display::None, Vec::new(), vec![reply]);
            }
            Init::Open { fenced, ready } => {
                self.only_read = true;
                for op in fenced {
                    self.ops.fence(&OpId::from(op)).expect("a loading actor has seen no op");
                }
                self.opened = Some(ready);
                self.normalize_stale_compacting();
                self.recover();
                if !self.recovering {
                    self.recovery_ended();
                }
            }
        }
        // The session is installed (created or resumed): `syncSessionCompaction` (`boot/infrastructure.mjs`).
        self.sync_compaction();
        self.seed_route_config();
        self.seed_todo();
        self.deps.runtime_hooks.started(&self.id);
        self.load_persisted_prompts();
        self.pump();
        // Nobody watches it until a client attaches (a worker, a headless run never does): it starts on the idle clock.
        self.arm_idle_evict();
        // `applyResolvedCwd` of the opened session's cwd (`resume.mjs:158`): unchanged.
        self.cwd_applied(false);
        if let Some(agents) = self.agents_with_scope() {
            self.accept_view(Change::Section(Section::Agents(agents)), Vec::new());
        }
        // The state starts with the resume this thread waits on (`getQuotaResume`, `context-state.mjs`).
        self.publish_quota_resume();
        self.read_agent_status(false);
        self.reconcile_offloads();
        self.read_context_display();
        self.read_live_workspace();
        self.follow_head();
        created_at.or_else(|| self.deps.compaction.settings_changes(&self.id).map(SettingsFollow::begin))
    }

    fn publish_flags(&mut self) {
        self.cell.turn_held.store(self.ask_lock_held(), SeqCst);
        self.cell.turn_pending.store(self.turn_pending(), SeqCst);
        self.cell.ui_busy.store(self.ui_busy(), SeqCst);
        self.cell.compacting.store(self.compactions > 0, SeqCst);
        self.cell.gated.store(self.compaction_held(), SeqCst);
        self.note_retention_facts();
        #[cfg(any(test, feature = "test-support"))]
        {
            self.cell.busy.store(self.turn_busy(), SeqCst);
            self.cell.retry_blocked.store(self.retry_blocked(), SeqCst);
            self.cell.goal_pending.store(self.goal_scheduled, SeqCst);
            self.cell.recovered.store(!self.recovering && self.outbox.is_empty(), SeqCst);
            self.cell
                .drafts_settled
                .store(self.draft_queue.is_empty() && !self.draft_busy && self.drafts_removing.is_empty() && self.sweep_due.is_none(), SeqCst);
            self.cell.unacked.store(self.outbox.unacked(), SeqCst);
            self.cell.handed.store(self.outbox.handed().len(), SeqCst);
            self.cell.stepped.notify_waiters();
        }
    }

    fn wind_down(mut self) {
        if let Some(retry) = self.draft_retry.take() {
            retry.abort();
        }
        if self.draft_backoff.is_some() {
            tracing::warn!("session {}: it ends owing draft file writes; the next open takes them", self.id.as_str());
        }
        self.cancel_toast_timers();
        self.deps.runtime_hooks.stopped(&self.id);
        self.deps.snapshots.runtime_stopped(&self.id);
        let usage = self.deps.gateway_usage.clone();
        tokio::spawn(async move { usage.settle().await });
        let stopped = self.unload_stopped.take();
        drop(self);
        if let Some(stopped) = stopped {
            let _ = stopped.send(());
        }
    }

    // ───────────── accept, encode, hand off, release ─────────────

    /// Applies `change` to the projected state and appends it to the outbox; a durable record
    /// goes to cpu-interactive for its encode.
    fn accept_record(&mut self, record: Record, class: Class, display: Display, notes: Vec<Note>, effects: Vec<Effect>) {
        self.accept_record_entry(record, class, display, notes, effects);
    }

    /// [`Self::accept_record`], answering the outbox entry the record took, for a view that stands on it
    /// ([`Self::accept_view_after`]).
    fn accept_record_entry(&mut self, record: Record, class: Class, display: Display, notes: Vec<Note>, effects: Vec<Effect>) -> u64 {
        let record = Arc::new(record);
        let shown = !matches!(display, Display::Suppressed);
        let moves = HeaderMoves::of(&record, &self.projected.header);
        let window_before = (self.projected.header.get("contextWindow").cloned(), self.projected.header.get("rawContextWindow").cloned());
        let change = Change::Record { record: record.clone(), display };
        self.projected.apply(&change, None);
        if moves.cwd {
            self.follow_head();
        }
        let entry = self.outbox.push(Some((record.clone(), class)), change, notes, effects);
        if self.outbox.has_unsaved() || self.outbox.awaits_retry() {
            self.retry_due = true;
        }
        self.submit_encode(entry, record, shown);
        self.follow_header_moves(entry, &moves, &window_before);
        entry
    }

    fn follow_header_moves(&mut self, entry: u64, moves: &HeaderMoves, window_before: &(Option<Value>, Option<Value>)) {
        let figures = match self.route_status.take().filter(|_| moves.window) {
            Some(Some((pass, status))) => {
                self.apply_measurement(pass, &status);
                Some(self.display_figures(&status))
            }
            Some(None) => Some(self.unread_figures(window_before)),
            None => None,
        };
        if moves.window || moves.held || moves.choice {
            let context = figures.clone().unwrap_or_default();
            self.accept_view_after(Some(entry), Change::Section(Section::Context(context)), Vec::new(), Vec::new());
        }
        if moves.route {
            let route = self.deps.compaction.route_config(&self.projected.header);
            self.accept_view_after(Some(entry), Change::Section(Section::Route(route)), Vec::new(), Vec::new());
        }
        if moves.window {
            if figures.is_none() {
                self.read_context_display();
            }
            if let Some(agents) = self.agents_with_scope() {
                self.accept_view_after(Some(entry), Change::Section(Section::Agents(agents)), Vec::new(), Vec::new());
            }
            self.read_agent_status(false);
        }
        if moves.todo {
            let todo = mixdog_core_ports::ports::todo_list::snapshot_of(&self.projected.header);
            if self.projected.sections.todo != todo {
                self.accept_view_after(Some(entry), Change::Section(Section::Todo(todo)), Vec::new(), Vec::new());
            }
        }
    }

    /// A header change the run's usage reports make, as one meta record; nothing when it changes nothing.
    fn accept_header(&mut self, change: Option<HeaderChange>) {
        // What waits for the debounce is older: it is written first, so this change is not overwritten by it.
        self.save_usage();
        if let Some(change) = change {
            let meta = Record::Meta(MetaRecord { op: None, change: Slot::Inline(change) });
            self.accept_record(meta, Class::Normal, Display::None, Vec::new(), Vec::new());
        }
    }

    fn defer_header(&mut self, change: Option<HeaderChange>) {
        let Some(change) = change else { return };
        let meta = Arc::new(Record::Meta(MetaRecord { op: None, change: Slot::Inline(change.clone()) }));
        self.projected.apply(&Change::Record { record: meta, display: Display::None }, None);
        let unsaved = self.usage_unsaved.get_or_insert_with(|| HeaderChange { set: Default::default(), unset: Vec::new() });
        for key in change.unset {
            unsaved.set.shift_remove(&key);
            if !unsaved.unset.contains(&key) {
                unsaved.unset.push(key);
            }
        }
        for (key, value) in change.set {
            unsaved.unset.retain(|unset| unset != &key);
            unsaved.set.insert(key, value);
        }
        self.publish_live_header();
        if !self.usage_save_armed {
            self.usage_save_armed = true;
            let jobs = self.jobs_tx.clone();
            let due = self.deps.clock.sleep(USAGE_SAVE_DEBOUNCE);
            drop(tokio::spawn(async move {
                due.await;
                let _ = jobs.send(JobDone::UsageSaveDue);
            }));
        }
    }

    /// Writes the usage books still waiting for their debounce.
    fn save_usage(&mut self) {
        self.usage_save_armed = false;
        if let Some(change) = self.usage_unsaved.take() {
            let meta = Record::Meta(MetaRecord { op: None, change: Slot::Inline(change) });
            self.accept_record(meta, Class::Normal, Display::None, Vec::new(), Vec::new());
        }
    }

    /// The live header: the stored one with the usage books still waiting for their write.
    fn publish_live_header(&self) {
        let mut header = self.acked.header.clone();
        if let Some(unsaved) = &self.usage_unsaved {
            for key in &unsaved.unset {
                header.shift_remove(key);
            }
            for (key, value) in &unsaved.set {
                header.insert(key.clone(), value.clone());
            }
        }
        self.cell.header.store(Arc::new(header));
    }

    /// A view-only change, released in order with the records around it.
    fn accept_view(&mut self, change: Change, notes: Vec<Note>) {
        self.accept_view_with(change, notes, Vec::new());
    }

    /// [`Self::accept_view`], with `effects` that run when the change is released.
    fn accept_view_with(&mut self, change: Change, notes: Vec<Note>, effects: Vec<Effect>) {
        self.accept_view_after(None, change, notes, effects);
    }

    /// [`Self::accept_view_with`] for a view that stands on the record `needs` accepted before it: it is released
    /// after that record and dropped, failed, with it when the record cannot be encoded.
    fn accept_view_after(&mut self, needs: Option<u64>, change: Change, notes: Vec<Note>, effects: Vec<Effect>) {
        self.projected.apply(&change, None);
        match needs {
            Some(needs) => self.outbox.push_after(needs, change, notes, effects),
            None => self.outbox.push(None, change, notes, effects),
        };
    }

    /// `shown`: whether the record's items show live (a suppressed row shows none).
    fn submit_encode(&mut self, entry: u64, record: Arc<Record>, shown: bool) {
        let deps = self.deps.clone();
        let jobs = self.jobs_tx.clone();
        let thread = self.id.clone();
        // The open turn's `completionVerb`, which its live rows carry.
        let verb = self.run.as_ref().map(|slot| slot.verb);
        // What recovery commits of a crashed turn shows as a reopened history shows it, not as a live turn.
        let live = !self.recovering;
        let turn = self.run.as_ref().map(|slot| slot.transcript.clone());
        let abort_ended = self.abort_ended.clone();
        let at = self.deps.clock.now_ms();
        // A reply the history does not stamp shows at the time its row first showed (`streamingTail.at`), else now.
        let reply_at = self.run.as_mut().and_then(|slot| slot.live.tail_at(at)).unwrap_or(at);
        // A full cpu lane is waited out: the record is a row of the thread, never dropped for a busy lane.
        let encode = move |lane: &mixdog_rt::InLane<mixdog_rt::CpuInteractive>| {
            // The log holds the record as the sensitive projection stores it; the live rows show it as committed.
            let stored = deps.sensitive.stored(&thread, &record);
            let result = deps.codec.encode(lane, stored.as_ref().unwrap_or(&record)).map(|encoded| {
                let Record::Item(row) = &*record else {
                    return (encoded, Vec::new());
                };
                if !shown {
                    return (encoded, Vec::new());
                }
                // The final reply's completion restores as a `done` end in history; live, the turn's close shows its
                // own end ([`Self::close_done`]), so this one is not shown. A sealed reply recovery commits has no close:
                // its end shows as history shows it.
                let shown: Vec<Shown> = deps
                    .transcript
                    .items(lane, row)
                    .into_iter()
                    // A row of no turn (an heir's carried conversation) has no close: its end shows as history shows it.
                    .filter(|shown| {
                        !live || row.turn.is_none() || !matches!(shown, Shown::Item(ThreadItem::TurnEnd { status: mixdog_protocol::TurnEndStatus::Done, .. }))
                    })
                    .map(|shown| {
                        if !live {
                            return shown;
                        }
                        let (attempt, raw) = match &row.body {
                            mixdog_store::schema::blob::Slot::Inline(body) => {
                                (body.pointer("/meta/transcript/attemptId").and_then(Value::as_str), body.get("content").and_then(Value::as_str))
                            }
                            _ => (None, None),
                        };
                        let live = |item| super::live_end::live_form(item, attempt, verb, turn.as_ref(), raw, reply_at);
                        match shown {
                            Shown::Item(item) => Shown::Item(live(item)),
                            Shown::Update(item) => Shown::Update(super::live_end::live_result(live(item), at, &abort_ended)),
                        }
                    })
                    .collect();
                (encoded, shown)
            });
            result.map(|(encoded, shown)| (encoded, shown, stored))
        };
        // Never cancelled: the record is the actor's to commit whatever becomes of its turn.
        mixdog_core_base::support::lane_job(self.deps.lanes.cpu, "record-encode", &CancellationToken::new(), encode, move |result| {
            let _ = jobs.send(JobDone::Encoded { id: entry, result: result.and_then(|encoded| encoded) });
        });
    }

    fn on_job(&mut self, done: JobDone) {
        let place = match &done {
            JobDone::EarlyShown { place, .. } | JobDone::CommitFacts { place, .. } | JobDone::CommitUnread { place, .. } => Some(*place),
            _ => None,
        };
        if let Some(place) = place {
            self.producers.put(place, PreparedProducer::Job(Box::new(done)));
            return;
        }
        self.apply_job(done);
    }

    fn apply_job(&mut self, done: JobDone) {
        match done {
            JobDone::Recovered(ended) => self.recovered(ended),
            JobDone::SubmissionSettled { id, answer } => self.submissions.settled(&id, answer),
            JobDone::SubmissionLooked { id, req, tx, found } => self.lookup_answered(id, req, tx, found),
            JobDone::StoredLooked { req, tx, attempt, found } => self.stored_looked(req, tx, attempt, found),
            // An encode is pure and its entry's id is never reused: a result whose entry a failed barrier dropped finds
            // none, and one whose entry was kept through a held barrier still lands.
            JobDone::Encoded { id, result } => self.encode_done(id, result),
            // A list computed off the actor can land after a mark that its rows predate: it takes the marks here.
            JobDone::PromptSession { session, publish } => {
                let session = self.redacted_session_prompts(&session);
                self.accept_view(Change::PromptSession { session, publish }, Vec::new())
            }
            JobDone::PromptPersisted(persisted) => {
                let persisted = self.redacted_prompts(&persisted);
                self.accept_view(Change::PromptPersisted(persisted), Vec::new())
            }
            JobDone::Archived(ordinals) => self.show_archived(ordinals),
            JobDone::PromptFlushed { list, unwritten } => {
                if let Some(list) = list {
                    let list = self.redacted_prompts(&list);
                    self.accept_view(Change::PromptPersisted(list), Vec::new());
                }
                let next = self.prompt_appends.flushed(unwritten);
                self.run_prompt_step(next);
            }
            // A write that went with an earlier header write disarmed it: nothing is waiting.
            JobDone::UsageSaveDue => {
                if self.usage_save_armed {
                    self.save_usage();
                }
            }
            JobDone::DraftWritten { write, result, ack } => {
                self.draft_busy = false;
                self.draft_busy_fenced = false;
                match &result {
                    Err(error) => self.draft_failed(&write, error),
                    Ok(()) => self.draft_settled(&write),
                }
                if let Some(ack) = ack {
                    let _ = ack.send(Ok(()));
                }
                self.draft_pump();
            }
            JobDone::DraftRetryDue => self.draft_retry(),
            JobDone::DraftEnded(rid) => {
                self.draft_stopped.remove(&rid);
                // A barrier passes records a failed save holds: the end record may still be unsaved, and the draft is
                // what a restart recovers it from, so it goes once the held records land.
                if self.outbox.has_unsaved() {
                    self.drafts_after_save.push(rid);
                } else {
                    self.ended_drafts.remove(&rid);
                    self.draft_push(super::turn_draft::DraftWrite::Remove { rid }, None);
                }
            }
            // A timer cancelled after it fired (its job already queued) finds no owner: its toast is gone.
            JobDone::ToastExpired(id) => {
                if self.toast_timers.remove(&id).is_some() {
                    let mut toasts = self.projected.sections.runtime.as_ref().map(|runtime| runtime.toasts.clone()).unwrap_or_default();
                    toasts.retain(|toast| toast.get("id").and_then(Value::as_str) != Some(id.as_str()));
                    self.accept_view(Change::Section(Section::Toasts(toasts)), Vec::new());
                }
            }
            JobDone::PromptRetryDue(epoch) => {
                if let Some(batch) = self.prompt_appends.due(epoch) {
                    self.flush_prompts(batch);
                }
            }
            JobDone::ApprovalId { turn, ask, reply, result, surface } => self.approval_id(turn, ask, reply, result, surface),
            // Today's `ingestSessionTurn(turn.session)` on a mark (`ask-turn-state.mjs:104`):
            // the search rows get a replacement under the new version, once what the turn
            // committed so far is durable.
            JobDone::SensitiveMarked => self.sensitive_marked(),
            JobDone::GoalSeen(Some(goal)) => {
                self.publish_goal(goal);
            }
            JobDone::GoalSettled(goal) => self.goal_turn_settled(goal),
            JobDone::GoalSeen(None) => {}
            JobDone::EarlyShown { turn, shown, .. } => {
                if let Some((shown, record)) = shown {
                    self.early_shown(&turn, &record, shown);
                }
            }
            JobDone::CommitFacts { turn, item, facts, ack, .. } => {
                self.mark_committing(&turn, &item);
                self.commit_with_facts(turn, item, facts, ack);
            }
            JobDone::RecoveryDone(done) => {
                if let Err(error) = done {
                    tracing::warn!("[session] the recovered turn of {} could not be saved: {error:?}", self.id.as_str());
                }
                self.recovery_ended();
            }
            JobDone::CommitUnread { turn, item, ack, error, .. } => {
                self.mark_committing(&turn, &item);
                tracing::warn!(thread = %self.id, "a run's row was not committed: its facts could not be read ({error:?})");
                let _ = ack.send(Err(RunError::NotApplied));
            }
            JobDone::InputUnread { reply, error } => self.input_unread(reply, error),
            JobDone::InputFacts(start) => {
                // `snapshotPendingGoalReminder` reads the Goal at request preparation, after the
                // earlier Goal calls of this thread.
                let (goals, thread) = (self.deps.goals.clone(), self.id.clone());
                self.goal_call(Box::pin(async move {
                    let goal = goals.stored_goal(&thread).await.ok().flatten();
                    JobDone::ReminderGoal(start, goal)
                }));
            }
            JobDone::ReminderGoal(start, goal) => {
                // The read is over: the start's work rides it from here.
                self.pending_work = None;
                self.start_run_read(*start, goal)
            }
            JobDone::StopDurable { sid, result } => self.stop_durable(&sid, result),
            JobDone::RetryProvenance(wait) => self.retry_provenance_read(wait),
            JobDone::Replied { op, tx, result } => self.replied(op, tx, result),
            JobDone::Compacted { op, tx, result, recover } => self.compacted(op, tx, result, recover),
            JobDone::CompactionEnded => {
                self.compactions = self.compactions.saturating_sub(1);
                if self.compactions == 0 {
                    self.end_command_status();
                    // What queued behind the command goes on (`drain.mjs`: the commandBusy release re-kicks the queue).
                    self.start_next_queued();
                }
                // A busy change (`updateEntryBusy`'s `onBusyChange`): the idle clock starts over.
                self.try_unload();
            }
            JobDone::ScheduledCompactionEnded => self.scheduled_compaction_ended(),
            JobDone::ClearSettled => {
                self.clear_holds = self.clear_holds.saturating_sub(1);
                if self.clear_holds == 0 && !self.deleting {
                    self.start_next_queued();
                }
            }
            JobDone::IdleClearChecked(due) => self.idle_clear_checked(due),
            JobDone::IdleClearEnded(skipped) => self.idle_clear_ended(skipped),
            JobDone::SetupUiExpired(id) => self.setup_ui_settled(&id),
            JobDone::RetryChecked { op, tx, key, retained, provenance } => self.retry_checked(op, tx, key, retained, provenance),
            JobDone::QuotaFireChecked { generation, tx, retained, provenance } => self.quota_fire_checked(generation, tx, retained, provenance),
            JobDone::Resumed(done) => self.resumed(*done),
            JobDone::CompactionRows(done) => self.compaction_rows(*done),
            JobDone::CompactionReminder(read) => self.compaction_reminder_read(*read),
            JobDone::PruneOffloads(told) => self.prune_offloads(told),
            JobDone::PruneListed(..) => unreachable!("the run loop awaits it"),
            JobDone::QuotaUnresumable(turn) => {
                let item = super::transcript::notice_item(&new_id(), turn.as_str(), super::quota_lane::UNRESUMABLE, "warn");
                self.show_live(turn, item, None);
            }
            JobDone::AgentStatus { agents, listener } => self.agent_status(agents, listener),
            JobDone::ContextStatus(pass, status) => self.context_display(pass, &status),
            JobDone::RouteStatus { seq, status } => self.route_status_read(seq, status),
            JobDone::LiveWorkspace(read, workspace) => {
                if read == self.live_workspace_reads && !self.tombstoned && !self.cell.closed.load(SeqCst) && self.projected.sections.workspace != workspace {
                    self.accept_view(Change::Section(Section::Workspace(workspace)), Vec::new());
                }
            }
            JobDone::HeadFollowing(seq, follow) => self.head_following(seq, follow),
            JobDone::HeadMoved(seq) => {
                if seq == self.head_follows {
                    self.read_live_workspace();
                }
            }
            JobDone::IdleChecked { working } => self.idle_checked(working),
            JobDone::GoalDecision(decision) => self.goal_decision(decision),
            JobDone::GoalEntryChecked { entry, seen } => self.goal_entry_checked(entry, seen),
            JobDone::SteerGoalsChecked { turn, request, reply, mut checked, seen } => {
                for (qid, entry, read) in seen {
                    let due = self.goal_due(&entry, read);
                    checked.insert(qid, due);
                }
                self.take_steers(turn, request, reply, checked);
            }
            JobDone::GoalControlled { op, tx, result } => self.goal_controlled(op, tx, result),
            JobDone::GoalArchived(id) => {
                // `settle`: the mask lifts and the lane shows the record as it now is.
                if self.goal_suppressed == id {
                    self.goal_suppressed.clear();
                }
                self.refresh_goal();
            }
        }
    }

    fn lookup_answered(&mut self, id: String, req: CoreRequest, tx: Waiter, found: Result<Option<Value>, CoreError>) {
        self.submission_lookup = false;
        match found {
            Ok(Some(answer)) => {
                self.submissions.remember(&id, answer.clone());
                let _ = tx.send(Ok(Reply::Value(answer)));
            }
            Ok(None) => {
                self.submission_looked = Some(id);
                if let Err((error, tx)) = self.mutation(req, tx) {
                    let _ = tx.send(Err(error));
                }
                self.submission_looked = None;
            }
            Err(error) => {
                if let Some(op) = &req.op {
                    self.ops.failed(op, &error);
                }
                let _ = tx.send(Err(error));
            }
        }
    }

    fn encode_done(&mut self, id: u64, result: Result<EncodedBundle, CoreError>) {
        match result {
            Ok((encoded, shown, stored)) => {
                if let Some(entry) = self.outbox.get_mut(id)
                    && let Change::Record { display, .. } = &mut entry.change
                    && !shown.is_empty()
                {
                    *display = Display::Items(shown);
                }
                self.outbox.encoded(id, encoded, stored);
                if self.outbox.has_unsaved() || self.outbox.awaits_retry() {
                    self.retry_due = true;
                }
            }
            Err(error) => {
                for entry in self.outbox.remove_unit(id) {
                    let gone = entry.id;
                    self.fail_entry(entry, &error);
                    for dependent in self.outbox.remove_needing(gone) {
                        self.fail_entry(dependent, &error);
                    }
                }
                self.rebuild_projected();
            }
        }
    }

    fn sensitive_marked(&mut self) {
        self.redact_prompts();
        let marks = self.deps.sensitive.clone();
        let mut rewrites = Vec::new();
        for (rid, (journal, _)) in &mut self.ended_drafts {
            rewrites.push((rid.clone(), journal.reset(&*marks, &self.id)));
        }
        for (rid, body) in rewrites {
            self.outbox.drop_drafts(&rid);
            self.draft_push(super::turn_draft::DraftWrite::Replace { rid, body }, None);
        }
        if self.run.is_some() {
            let marks = self.deps.sensitive.clone();
            if let Some(run) = self.run.as_mut()
                && run.journal.written()
            {
                let body = run.journal.reset(&*marks, &self.id);
                let rid = run.turn.as_str().to_owned();
                self.outbox.drop_drafts(&rid);
                self.draft_push(super::turn_draft::DraftWrite::Replace { rid, body }, None);
            }
            let ack = self.ingest_when_durable();
            self.outbox.push(None, Change::Barrier, Vec::new(), vec![Effect::ItemAck(ack)]);
        }
    }

    fn goal_turn_settled(&mut self, goal: Option<Option<Goal>>) {
        self.settling = false;
        for (done, outcome) in std::mem::take(&mut self.agent_done) {
            let _ = done.send(outcome);
        }
        self.finish_quota_settlement(goal.clone().flatten().as_ref());
        let active = goal.and_then(|goal| self.publish_goal(goal)).is_some_and(|goal| goal_lane_status(&goal) == "active");
        if self.deleting {
            return;
        }
        if std::mem::take(&mut self.compact_scheduled) | self.cell.pending_compact.swap(false, SeqCst) {
            return self.run_scheduled_compaction(active);
        }
        self.start_next_queued();
        if active {
            self.schedule_goal_continuation();
        }
        self.try_unload();
    }

    fn input_unread(&mut self, reply: Option<Effect>, error: CoreError) {
        tracing::warn!(thread = %self.id, "a turn did not start: its input row's facts could not be read ({error:?})");
        self.starting = false;
        if let Some(work) = self.pending_work.take()
            && let Some(sid) = self.stop_or_latched(&work)
        {
            return self.finish_stopped_start(work, reply, &sid);
        }
        self.submitter = None;
        self.retry_provenance = None;
        self.retry_prior = None;
        self.refuse_start(reply, &error);
    }

    fn retry_provenance_read(&mut self, wait: Box<RetryWait>) {
        let RetryWait { input, body, op_ref, reply, prompt, wake, provenance, prior, work } = *wait;
        self.starting = false;
        self.pending_work = None;
        if self.deleting {
            self.refuse_start(reply, &CoreError::ThreadClosing { thread_id: self.id.clone() });
            return;
        }
        self.retry_provenance = Some(provenance);
        self.retry_prior = prior;
        self.start_run_with(DeferredStart { input, body, op_ref, reply, prompt, wake, retried: false, work });
    }

    // ───────────── the Goal lane ─────────────

    /// Hands encoded records to the durability task in order, releases what is ready, and
    /// publishes the released frames and the storage state.
    fn pump(&mut self) {
        if let Some(error) = self.exit_failed.clone()
            && !self.outbox.is_empty()
        {
            self.fail_all(error);
        }
        if !self.hand_off() {
            return;
        }
        let (notes, header_moved) = self.release_ready();
        self.publish_released(notes, header_moved);
        if !self.starts_gated() {
            if let Some(start) = self.deferred_start.take() {
                self.start_run_with(start);
            } else if !self.drain_gated() && std::mem::take(&mut self.drain_held) {
                self.start_next_queued();
            }
        }
    }

    /// `false` when the durability task is gone and every entry was failed.
    fn hand_off(&mut self) -> bool {
        let units = if self.draft_fenced() { Vec::new() } else { self.outbox.handoff(self.ch.dur_tx.capacity(), std::mem::take(&mut self.retry_due)) };
        for unit in units {
            let msg = ToDurability::Append { generation: self.generation, records: unit.records };
            if self.ch.dur_tx.try_send(msg).is_err() {
                self.indeterminate = true;
                tracing::error!(
                    session = self.id.as_str(),
                    generation = self.generation,
                    unsaved = self.outbox.unsaved_records().count(),
                    retained = ?self.save_risk.retained,
                    unknown = ?self.save_risk.unknown,
                    "durability task lost at handoff"
                );
                self.fail_all(CoreError::StorageIndeterminate { scope: "thread".into() });
                return false;
            }
        }
        true
    }

    fn release_ready(&mut self) -> (Vec<Note>, bool) {
        let mut notes = Vec::new();
        let mut header_moved = false;
        if !self.starting {
            self.outbox.unpair_pending();
        }
        self.releasing = true;
        while let Some(ready) = self.outbox.pop_ready() {
            match ready {
                Ready::Release(entry, ordinal) => header_moved |= self.release(entry, ordinal, &mut notes),
                Ready::Show(entry) => header_moved |= self.release(entry, None, &mut notes),
                Ready::Settle(entry, ordinal) => self.settle(entry, ordinal),
            }
        }
        self.releasing = false;
        if !self.writes_landed.is_empty() {
            let (landed, waiting): (Vec<_>, Vec<_>) =
                std::mem::take(&mut self.writes_landed).into_iter().partition(|(through, _)| !self.outbox.unwritten_through(*through));
            self.writes_landed = waiting;
            for (_, tx) in landed {
                let _ = tx.send(Ok(()));
            }
        }
        (notes, header_moved)
    }

    fn publish_released(&mut self, mut notes: Vec<Note>, header_moved: bool) {
        fold_room_view(&mut notes);
        let storage = self.storage();
        if storage != self.published_storage {
            self.published_storage = storage;
            notes.push(self.storage_note());
        }
        if !notes.is_empty() || header_moved {
            self.publish(notes);
        }
        for released in self.after_publish.drain(..) {
            let _ = released.send(Ok(()));
        }
        self.publish_cell();
        for (tx, value) in self.replies_after_publish.drain(..) {
            let _ = tx.send(Ok(Reply::Value(value)));
        }
    }

    /// An entry shown before it settled (or held by a failed barrier) settles: a record's rows get the ordinal it was written
    /// at, and the effects it still holds run (a held entry ran its own at the failure).
    fn settle(&mut self, entry: Entry, ordinal: Option<u64>) {
        self.saved(&entry, ordinal);
        // What [`Self::release`] does at a durable compaction's ordinal: the rows it took out of the context show it.
        if entry.shown && archives_rows(&entry.change, ordinal) {
            self.mark_archived();
        }
        for effect in entry.effects {
            self.effect_done(effect);
        }
    }

    /// A record released unsaved is durable now: its rows get the ordinal it was written at.
    fn saved(&mut self, entry: &Entry, ordinal: Option<u64>) {
        let Some(ordinal) = ordinal else { return };
        self.acked_end = self.acked_end.max(ordinal + 1);
        if let Change::Record { display: Display::Items(shown), .. } = &entry.change {
            for item in shown.iter().filter_map(|shown| match shown {
                Shown::Item(item) => Some(item),
                Shown::Update(_) => None,
            }) {
                for state in [&mut self.acked, &mut self.projected] {
                    if let Some(row) = state.window.iter_mut().find(|row| row.item.id() == item.id()) {
                        row.ordinal = Some(ordinal);
                    }
                }
            }
        }
    }

    fn storage(&self) -> StorageState {
        if self.indeterminate {
            StorageState::Indeterminate
        } else if self.pending {
            StorageState::DurabilityPending
        } else {
            StorageState::Ok
        }
    }

    /// Applies a released entry to the acked state; `true` when it changed the stored header. The view (`thread/read`, a
    /// snapshot's summary) is published then even when no note carries the change: Node's rows read the live session
    /// (`session-catalog.mjs`), as after a compaction that shows nothing live.
    fn release(&mut self, entry: Entry, ordinal: Option<u64>, notes: &mut Vec<Note>) -> bool {
        let title = self.acked.sections.title.clone();
        let prompts = self.acked.prompt_history.clone();
        let queue_rows = self.acked.queued_rows();
        let asked = |acked: &SessionState| acked.sections.approvals.as_ref().and_then(|approvals| approvals.handoff_questions.clone());
        let asked_before = asked(&self.acked);
        // A settled segment shows only when no row of its item is in view now (`Change::Settled`): its note is told then.
        if let Change::Settled { turn, item } = &entry.change
            && !self.acked.window.iter().any(|row| row.item.id() == item.id())
        {
            notes.push(Note::new(
                "item/completed",
                &ItemNotificationParams { thread_id: self.id.clone(), turn_id: turn.clone(), item: item.clone(), room_view: None },
            ));
        }
        self.acked.apply(&entry.change, ordinal);
        // A room member's handed-off questions moved: its room is published again once this view
        // is out (`noteMemberRows`).
        if asked(&self.acked) != asked_before && mixdog_core_base::rooms::ids::room_member_of_session(self.id.as_str()).is_some() {
            self.room_questions_moved = true;
        }
        // A room member's approval resolved: its room stops showing it once this view is out.
        if let Change::Record { record, .. } = &entry.change
            && let Record::Approval(approval) = &**record
            && approval.phase != ApprovalPhase::Requested
            && mixdog_core_base::rooms::ids::room_member_of_session(self.id.as_str()).is_some()
        {
            self.room_approvals_resolved.push(approval.aid.as_str().to_owned());
        }
        if let Some(ordinal) = ordinal {
            self.acked_end = self.acked_end.max(ordinal + 1);
        }
        if let Change::EarlyResult { row, update } = &entry.change {
            self.early_result(row, update.clone(), notes);
        }
        self.fold_shown_items(&entry.change, ordinal, notes);
        let header_moved = matches!(&entry.change, Change::Record { record, .. } if matches!(**record, Record::Meta(_) | Record::Session(_)));
        if header_moved {
            self.publish_live_header();
            self.refresh_surface();
            // `sessionRecords.onChange`: this session's stored record changed.
            self.deps.agent_signals.session_record(self.id.as_str());
        }
        notes.extend(entry.notes);
        self.tell_visible_items(&entry.change, notes);
        self.derived_notes(&entry.change, &title, &queue_rows, notes);
        // The list is replaced whole when an entry moves it: the same list is no change, with nothing compared.
        if !Arc::ptr_eq(&prompts, &self.acked.prompt_history)
            && let Some(change) = prompt_history::change(&prompts, &self.acked.prompt_history)
        {
            notes.push(Note::new("thread/promptHistory/updated", &ThreadSectionParams { thread_id: self.id.clone(), value: change }));
        }
        // A durable compaction that took rows out of the context: the rows in view show it, as a reopened window does.
        if archives_rows(&entry.change, ordinal) {
            self.mark_archived();
        }
        for effect in entry.effects {
            self.effect_done(effect);
        }
        header_moved
    }

    fn fold_shown_items(&mut self, change: &Change, ordinal: Option<u64>, notes: &mut Vec<Note>) {
        if let Change::Record { record, display } = change
            && let (Record::Item(row), Display::Items(shown)) = (&**record, display)
        {
            for shown in shown {
                match shown {
                    Shown::Item(item) => {
                        let folded = match item {
                            ThreadItem::ToolCall { run, .. } => {
                                run.call_id.as_ref().and_then(|call| self.early_results.remove(call)).and_then(|(_, update)| self.fold_early(&update))
                            }
                            _ => None,
                        };
                        self.track_active_tool(folded.as_ref().unwrap_or(item));
                        if let Some(ordinal) = ordinal
                            && let Some(projected) = self.projected.window.iter_mut().find(|projected| projected.item.id() == item.id())
                        {
                            projected.ordinal = Some(ordinal);
                        }
                    }
                    Shown::Update(update) => {
                        if let ThreadItem::ToolCall { run, .. } = update
                            && let Some(call) = &run.call_id
                        {
                            self.early_results.remove(call);
                        }
                        self.track_active_tool(update);
                        if let Some(merged) = self.acked.shown_for(update) {
                            notes.push(item_completed(&self.id, row, &merged));
                        }
                    }
                }
            }
        }
    }

    fn tell_visible_items(&self, change: &Change, notes: &mut Vec<Note>) {
        if let Change::Record { record, display: Display::Items(shown) } = change
            && let Record::Item(row) = &**record
            && row.visible
        {
            for shown in shown {
                let Shown::Item(item) = shown else { continue };
                let told = self.acked.window.iter().find(|held| held.item.id() == item.id()).map_or_else(|| item.clone(), |held| (*held.item).clone());
                notes.push(item_completed(&self.id, row, &told));
            }
        }
    }

    fn derived_notes(&self, change: &Change, title_before: &Option<String>, queue_before: &[Value], notes: &mut Vec<Note>) {
        let thread = &self.id;
        match change {
            Change::Record { record, .. } => match &**record {
                Record::Run(run) => {
                    if let Some(mut turn) = turn_of(run) {
                        if let Some((_, stop, termination)) =
                            self.completed_reasons.as_ref().filter(|(rid, ..)| run.phase == RunPhase::Completed && rid == run.rid.as_str())
                        {
                            turn.stop_reason = stop.clone();
                            turn.termination_reason = termination.clone();
                        }
                        let method = if run.phase == RunPhase::Started { "turn/started" } else { "turn/completed" };
                        notes.push(Note::new(method, &TurnNotificationParams { thread_id: thread.clone(), turn }));
                        // The runtime changes at both ends: busy with its spinner as the turn begins, idle as it ends. A hidden
                        // input's start is published with the runtime's next change (`RunSlot::hidden`).
                        let hidden_start =
                            run.phase == RunPhase::Started && self.run.as_ref().is_some_and(|slot| slot.hidden && slot.turn.as_str() == run.rid.as_str());
                        if hidden_start {
                            self.runtime_held.store(true, SeqCst);
                        } else {
                            notes.push(self.runtime_note());
                        }
                    }
                }
                // An entry edited where it stands changes no row of the queue, and a queued completion or notification is no row of it:
                // Node publishes `queued` only when it changes (`isQueuedEntryVisible`, `drain-enqueue.mjs`).
                Record::Queue(queue) if queue.action != QueueAction::Update && self.acked.queued_rows() != queue_before => {
                    notes.push(Note::new("thread/queue/changed", &ThreadQueueChangedParams { thread_id: thread.clone(), queued: self.acked.queued_rows() }));
                }
                Record::Approval(approval) if approval.phase != ApprovalPhase::Requested => {
                    notes.push(self.section_note(&Section::Approvals(self.acked.sections.approvals.clone().unwrap_or_default())));
                }
                Record::Meta(_) | Record::Session(_) => {
                    if let Record::Meta(meta) = &**record
                        && let mixdog_store::schema::blob::Slot::Inline(header) = &meta.change
                    {
                        // `toolMode` is runtime state (Node's `runtime.toolMode`), moved by `thread/setToolMode` in the header.
                        if header.set.contains_key("toolMode") {
                            notes.push(self.runtime_note());
                        }
                        if WORKFLOW_KEYS.iter().any(|key| header.set.contains_key(*key) || header.unset.iter().any(|unset| unset.as_str() == *key)) {
                            notes.push(self.workflow_note());
                        }
                    }
                    if self.acked.sections.title != *title_before
                        && let Some(title) = &self.acked.sections.title
                    {
                        notes.push(Note::new("thread/name/updated", &ThreadNameUpdatedParams { thread_id: thread.clone(), title: title.clone() }));
                    }
                }
                _ => {}
            },
            Change::Section(section) => notes.push(self.section_note(section)),
            _ => {}
        }
    }

    fn section_note(&self, section: &Section) -> Note {
        fn note<T: Serialize>(method: &'static str, thread: &ThreadId, value: T) -> Note {
            Note::new(method, &ThreadSectionParams { thread_id: thread.clone(), value })
        }
        let t = &self.id;
        match section {
            Section::Runtime(_)
            | Section::ProgressHint(_)
            | Section::Spinner(_)
            | Section::SpinnerQuiet(_)
            | Section::Command(_)
            | Section::Toasts(_)
            | Section::ActiveTools(_)
            | Section::SetupChanged(_) => self.runtime_note(),
            Section::Route(_) | Section::TurnEffort(_) => note("thread/route/updated", t, self.acked.route()),
            Section::Context(_) => note("thread/context/updated", t, self.acked.context()),
            Section::Todo(v) => note("thread/todo/updated", t, v),
            Section::Goal(Some(v)) => Note::new("thread/goal/updated", &ThreadValueParams { thread_id: t.clone(), value: v.clone() }),
            Section::Goal(None) => Note::new("thread/goal/cleared", &ThreadIdParams { thread_id: t.clone() }),
            Section::QuotaResume(v) => note("thread/quotaResume/updated", t, v),
            Section::Agents(v) => note("thread/agents/updated", t, v),
            Section::ShellJobs(v) => note("thread/shellJobs/updated", t, v),
            Section::Workspace(v) => note("thread/workspace/updated", t, v),
            Section::Approvals(v) => note("thread/approvals/updated", t, v),
            Section::PromptRestore(v) => note("thread/promptRestore", t, v),
            Section::ProviderAccount(v) => note("thread/providerAccount/changed", t, v),
            Section::Remote(v) => note("thread/remote/updated", t, v),
            Section::SetupUiRequest(v) => note("thread/setupUiRequest/updated", t, v),
            Section::RoomView(v) => note("thread/roomView/updated", t, v),
        }
    }

    /// The runtime section with the storage state as it is now, the held start still held (see [`Self::view`]).
    fn storage_note(&self) -> Note {
        let mut value = self.acked.runtime(self.storage());
        if self.runtime_held.load(SeqCst) {
            value.busy = false;
            value.spinner = None;
        }
        Note::new("thread/runtime/updated", &ThreadSectionParams { thread_id: self.id.clone(), value })
    }

    /// The workflow section as the header and a staged workflow's published meta give it ([`SessionState::workflow`]).
    fn workflow_note(&self) -> Note {
        Note::new("thread/workflow/updated", &ThreadSectionParams { thread_id: self.id.clone(), value: self.acked.workflow() })
    }

    fn runtime_note(&self) -> Note {
        self.runtime_held.store(false, SeqCst);
        Note::new("thread/runtime/updated", &ThreadSectionParams { thread_id: self.id.clone(), value: self.acked.runtime(self.storage()) })
    }

    fn effect_done(&mut self, effect: Effect) {
        match effect {
            // A stored receipt's entry is withdrawn by a failed barrier, never held: it comes here at its record's ordinal.
            Effect::Kept { tx, value } => self.effect_done(Effect::Reply { op: None, tx, value }),
            Effect::Stored { op, tx, value } => self.effect_done(Effect::Reply { op, tx, value }),
            Effect::Reply { op, tx, value } => {
                // The first reply of a created thread is its `session` record's: the thread exists.
                self.uncreated = false;
                if let Some(seed) = self.seed.take() {
                    seed.keep();
                }
                if let Some(op) = &op {
                    self.ops.applied(op, &value);
                }
                // A change released by the pump is answered once its view is published (`replies_after_publish`).
                match tx {
                    Some(tx) if self.releasing => self.replies_after_publish.push((tx, value)),
                    Some(tx) => {
                        let _ = tx.send(Ok(Reply::Value(value)));
                    }
                    None => {}
                }
            }
            Effect::InputDurable => {
                if let Some(run) = &self.run {
                    run.input.send_replace(InputState::Durable);
                }
            }
            Effect::ItemAck(tx) | Effect::MarkAck(tx) => {
                let _ = tx.send(Ok(()));
            }
            Effect::PublishApproval(request) => {
                self.deps.server_requests.publish(request);
                // `approveToolRequest` sets the spinner's `tool-approval` before `requestToolApproval` (turn.mjs:295-296): the
                // request's frame shows that mode, however the run's mark and this effect reached the actor.
                if self.run.is_some() && self.spinner().is_some_and(|spinner| spinner.get("mode").and_then(Value::as_str) != Some("tool-approval")) {
                    self.patch_spinner([("mode", json!("tool-approval"))]);
                }
                // `set({ toolApproval })` flushes immediately (`draft-store.mjs:69-71`).
                let mark = super::phone_frame::Mark { immediate: true, ..Default::default() };
                let flushed = self.frames.mark(mark, tokio::time::Instant::now());
                self.publish_frame(flushed);
            }
            Effect::Resolved(aid, resolution) => {
                self.book.resolved(aid, &resolution);
                self.deps.server_requests.resolved(&aid.request_id(), resolved_frame(&self.id, aid, &resolution));
            }
            Effect::RecomputePrompts { publish } => self.recompute_prompts(publish),
            // The failed end is in the acked window, where the settlement reads it; the Goal settles after.
            Effect::TurnClosed { turn, settle } => {
                self.begin_quota_settlement(&turn);
                self.settle_goal(settle);
            }
            Effect::AfterPublish(tx) => self.after_publish.push(tx),
            Effect::Decided(_) => {}
            Effect::Draft(write, ack) => self.draft_push(write, ack),
        }
    }

    fn rebuild_projected(&mut self) {
        let mut projected = self.acked.clone();
        for change in self.outbox.changes() {
            projected.apply(change, None);
        }
        self.projected = projected;
    }

    /// A step began (a replay's settled signal, `replay_settled.rs`).
    fn stepping(&self) {
        #[cfg(feature = "replay-settled")]
        if let Some(lane) = &self.ch.settled {
            lane.stepping();
        }
    }

    /// A step ended (a replay's settled signal): idle when it left nothing in flight, every record acknowledged by the store, every
    /// job reported (the actor holds the only strong sender left: a job waiting on the clock or a registration holds a weak one).
    fn stepped(&self) {
        #[cfg(feature = "replay-settled")]
        if let Some(lane) = &self.ch.settled {
            let left = if !self.outbox.is_empty() {
                Some("a record not yet acknowledged by its store")
            } else if self.jobs_tx.strong_count() > 1 {
                Some("a job in flight")
            } else if !self.jobs_rx.is_empty() {
                Some("a job's answer not yet taken")
            } else {
                None
            };
            lane.stepped(left);
        }
    }

    fn publish(&mut self, notes: Vec<Note>) {
        let now = tokio::time::Instant::now();
        let mut flushed = None;
        // `settleTurn` flushes after the turn's close was set (`publishTurnClose`, turn.mjs:605-664: the idle runtime among
        // it), so the runtime note the close put right behind the completion goes in the completion's frame, not in one of its own.
        let mut settling = false;
        for note in &notes {
            let Some(mut mark) = super::phone_frame::mark_of(note) else { continue };
            if settling && note.method != "thread/runtime/updated" {
                flushed = flushed.or(self.frames.flush());
            }
            let closes = settling;
            settling = std::mem::take(&mut mark.now);
            flushed = flushed.or(self.frames.mark(mark, now));
            if closes {
                flushed = flushed.or(self.frames.flush());
            }
        }
        if settling {
            flushed = flushed.or(self.frames.flush());
        }
        self.publish_notes(notes);
        self.publish_frame(flushed);
    }

    /// `thread/frame`: one of Node's publications of the session's state (`phone_frame.rs`). None once a delete closed the thread:
    /// Node's host dropped a deleted session's subscription and projection (`forgetDeletedSession`, `session-host-lifecycle.ts` at
    /// b6f10295a), so the turn the delete stopped published no further state to a phone.
    fn publish_frame(&mut self, flushed: Option<bool>) {
        let Some(structure_changed) = flushed else { return };
        if self.deleting {
            return;
        }
        let params = mixdog_app_protocol::v2::thread::ThreadFrameParams { thread_id: self.id.clone(), structure_changed };
        let note = Note::new("thread/frame", &params);
        self.publish_notes(vec![note]);
    }

    fn publish_notes(&mut self, mut notes: Vec<Note>) {
        // A deleted session leaves its viewers before its turn is stopped (`deleteSessionLocked`
        // drops the projection first): the stopped turn's rows reach no client.
        if self.deleting {
            notes.retain(|note| !(note.method.starts_with("item/") || note.method.starts_with("turn/")));
        }
        let start = self.seq + 1;
        let frames: Vec<FeedFrame> = notes
            .iter()
            .enumerate()
            .map(|(i, note)| {
                let seq = start + i as u64;
                FeedFrame { seq, bytes: frame(note, &self.feed_id, &self.epoch, seq) }
            })
            .collect();
        self.seq += frames.len() as u64;
        let now = self.deps.clock.now_ms();
        let streaming_only = !notes.is_empty() && notes.iter().all(|note| STREAMING_DELTAS.contains(&note.method));
        if streaming_only
            && self.feed.defers()
            && self.deferred_frames + frames.len() <= VIEW_DEFER_FRAMES
            && now.saturating_sub(self.view_built_ms) < VIEW_DEFER_MS
        {
            self.deferred_frames += frames.len();
            // The actor is the feed's only producer and assigns contiguous seqs.
            let _ = self.feed.publish_deferred(&frames);
        } else {
            let view = Arc::new(self.view());
            // The actor is the feed's only producer and assigns contiguous seqs.
            let _ = self.feed.publish(&frames, Some(view.clone()));
            self.cell.view.store(view);
            self.deferred_frames = 0;
            self.view_built_ms = now;
        }
        let resolved = std::mem::take(&mut self.room_approvals_resolved);
        let moved = std::mem::take(&mut self.room_questions_moved);
        if let Some(member) = mixdog_core_base::rooms::ids::room_member_of_session(self.id.as_str()) {
            for approval in &resolved {
                self.deps.room_members.approval_resolved(&member.room_id, approval);
            }
            if moved {
                self.deps.room_members.questions_moved(&member.room_id);
            }
        }
    }

    fn view(&self) -> SessionView {
        let mut view = SessionView::build(
            self.feed_id.clone(),
            self.deps.transcript.summary(&self.id, &super::archive_trees::resolved_header(&self.deps.archive, self.id.as_str(), &self.acked.header)),
            &self.acked,
            self.storage(),
            None,
        );
        if self.runtime_held.load(SeqCst)
            && let Some(runtime) = view.state.runtime.as_mut()
        {
            runtime.busy = false;
            runtime.spinner = None;
        }
        view
    }

    /// The control cell follows the projected state.
    fn publish_cell(&self) {
        let queued: std::collections::HashSet<String> = self.projected.queue.iter().map(|q| q.qid.clone()).collect();
        if **self.cell.queued.load() != queued {
            self.cell.queued.store(Arc::new(queued));
        }
        if **self.cell.queue.load() != self.projected.queue {
            self.cell.queue.store(Arc::new(self.projected.queue.clone()));
        }
        let approvals: std::collections::HashSet<u64> = self.book.decidable().into_iter().map(|aid| aid.0).collect();
        if **self.cell.approvals.load() != approvals {
            self.cell.approvals.store(Arc::new(approvals));
            // `onSessionApprovalWaitChange`: the wait this session's turn holds changed.
            self.deps.agent_signals.approval_wait(self.id.as_str());
        }
        let takeover = super::secret_input::takeover_hold(self.book.open_requests());
        if **self.cell.takeover.load() != takeover {
            self.cell.takeover.store(Arc::new(takeover));
        }
        let shown = self.book.shown();
        if self.cell.shown_approval.load().as_ref().map(|request| request.id) != shown.map(|request| request.id) {
            self.cell.shown_approval.store(shown.cloned().map(Arc::new));
            self.cell.live_changed();
            // `runtime.subscribe`: a state change its watchers read (a send's approval wait).
            self.cell.shown_changed.send_modify(|seq| *seq += 1);
        }
    }

    // ───────────── durability ─────────────

    fn settle_save_notice(&self, was_outstanding: bool) {
        if was_outstanding && !self.save_risk.outstanding() {
            tracing::info!(session = self.id.as_str(), "the conversation save failure is resolved: the session's warning is withdrawn");
            self.deps.notices.save_resolved(self.id.as_str());
        }
    }

    fn on_durability(&mut self, msg: FromDurability) {
        match msg {
            FromDurability::Acked { generation, ordinals } => self.durability_acked(generation, ordinals),
            FromDurability::Failed { generation, entries, error } => self.durability_failed(generation, entries, error),
            FromDurability::Pending(pending) => self.pending = pending,
            FromDurability::Retried(result) => self.durability_retried(result),
            FromDurability::Redacted => {}
        }
    }

    fn durability_acked(&mut self, generation: u64, ordinals: Vec<(u64, u64)>) {
        if generation != self.generation {
            return;
        }
        self.indeterminate = false;
        let owed = self.save_risk.outstanding();
        self.save_risk.acked(&ordinals);
        for &(id, ordinal) in &ordinals {
            self.outbox.acked(id, ordinal);
        }
        if owed {
            tracing::info!(
                session = self.id.as_str(),
                generation,
                records = ordinals.len(),
                ?ordinals,
                unsaved = self.save_risk.retained.len(),
                "a commit was acknowledged while earlier records were unsaved"
            );
        }
        if !self.outbox.has_unsaved() {
            for rid in std::mem::take(&mut self.drafts_after_save) {
                self.ended_drafts.remove(&rid);
                self.draft_push(super::turn_draft::DraftWrite::Remove { rid }, None);
            }
        }
        self.settle_save_notice(owed);
    }

    fn durability_failed(&mut self, generation: u64, entries: Vec<u64>, error: super::seams::BarrierError) {
        if generation != self.generation {
            return;
        }
        let (units, kinds) = self.outbox.batch_summary(&entries);
        let (outcome, stage, said) = match &error {
            super::seams::BarrierError::Failed { io_kind, cause } => ("not_applied", io_kind.clone(), cause.clone()),
            super::seams::BarrierError::Indeterminate { io_kind, cause } => ("unknown", io_kind.clone(), cause.clone()),
        };
        tracing::warn!(
            session = self.id.as_str(),
            generation,
            ?units,
            ?entries,
            records = kinds.len(),
            ?kinds,
            stage = &*stage,
            outcome,
            cause = &*said,
            "a commit failed"
        );
        let retain = matches!(error, super::seams::BarrierError::Failed { .. });
        if !retain {
            self.save_risk.unknown.extend(self.outbox.attempted_conversation(&entries));
        }
        let (error, cause) = match error {
            super::seams::BarrierError::Failed { io_kind, cause } => (CoreError::BarrierFailed { scope: "thread".into(), io_kind }, cause),
            super::seams::BarrierError::Indeterminate { cause, .. } => {
                self.indeterminate = true;
                (CoreError::StorageIndeterminate { scope: "thread".into() }, cause)
            }
        };
        if self.cell.closed.load(SeqCst) && !self.close_undone() {
            self.exit_unwritten(error, &cause);
            return;
        }
        if std::mem::take(&mut self.unload_due) {
            tracing::warn!("session {}: its close failed on a write; it stays open with its unwritten records held", self.id.as_str());
            self.answer_idle();
        }
        self.answer_closes();
        self.hold_failed(&error, cause, retain);
        self.save_risk.retained.extend(self.outbox.unsaved_conversation());
        tracing::warn!(
            session = self.id.as_str(),
            generation,
            unsaved = self.outbox.unsaved_records().count(),
            unknown = self.save_risk.unknown.len(),
            "records left unsaved by the failed commit"
        );
        if self.save_risk.outstanding() {
            self.deps.notices.save_failed(self.id.as_str());
        }
    }

    fn durability_retried(&mut self, result: Result<(), super::seams::BarrierError>) {
        self.indeterminate = result.is_err();
        for told in self.reconciles.drain(..) {
            let _ = told.send(result.as_ref().map(|_| ()).map_err(|_| CoreError::StorageIndeterminate { scope: "thread".into() }));
        }
        match &result {
            Ok(()) => {
                let owed = self.save_risk.outstanding();
                tracing::info!(
                    session = self.id.as_str(),
                    reconciled = ?self.save_risk.unknown,
                    unsaved = self.save_risk.retained.len(),
                    "the log's unknown outcome was reconciled"
                );
                self.save_risk.unknown.clear();
                self.settle_save_notice(owed);
            }
            Err(error) => {
                tracing::warn!(session = self.id.as_str(), ?error, "the log's unknown outcome could not be reconciled");
                if self.outbox.is_empty() && std::mem::take(&mut self.unload_due) {
                    if self.cell.closed.load(SeqCst) {
                        self.close_undone();
                    }
                    self.answer_closes();
                    self.answer_idle();
                }
            }
        }
    }

    // ───────────── control lane ─────────────

    fn on_ctl(&mut self, ctl: Ctl) {
        match ctl {
            Ctl::Approval { turn, ask, reply } => {
                if !self.active(&turn) {
                    let _ = reply.send(ApprovalResolution::Cancelled { at: self.deps.clock.now_ms() });
                    return;
                }
                // A session with no approval surface asks nobody (Node's headless runtime has
                // no `toolApprovalHook`).
                if super::session_options::approval_implicit(&self.acked.header) {
                    let _ = reply.send(ApprovalResolution::Unavailable { at: self.deps.clock.now_ms() });
                    return;
                }
                // A tool asks only after the turn produced output (`approveToolRequest` commits the prompt).
                self.prompt_committed();
                self.request_approval(turn, ask, reply);
            }
            Ctl::Abort { turn } => self.abort_requests(turn),
            Ctl::StopBusy(reply) => {
                let _ = reply.send(self.stop_busy());
            }
            Ctl::StopRun { turn, named, restore_prompt, canceller, unreadable, reply } => {
                let _ = reply.send(self.stop_run(&turn, named, restore_prompt, &canceller, unreadable));
            }
            Ctl::StopQueued { qid, canceller, reply } => {
                let _ = reply.send(self.stop_queued(&qid, &canceller));
            }
            Ctl::StopWork { submissions, reply } => {
                let _ = reply.send(self.stop_submissions(&submissions));
            }
            // What an earlier process left queued runs at the first resume: the restore alone starts no turn
            // (`restoreLeadSteeringFromDisk`, `steering.mjs:291`), the resume's release drains it once (`resume.mjs:72`).
            // A resume also drains the rows the thread holds queued now.
            Ctl::Resumed => {
                // The view coming restarts the idle clock (`addSubscriber`'s `onViewersChange`, `idleClock.refresh`): an unload the
                // deadline decided before the client's attach is counted is void ([`Self::idle_checked`]).
                self.arm_idle_evict();
                let restored = std::mem::take(&mut self.restored_queue);
                if restored || !self.projected.queued_rows().is_empty() {
                    self.start_next_queued();
                }
                // The session boundary of the resume (`rearmGoalContinuationOnSessionBoundaries`): the continuation queued before it
                // is dropped, the Goal is read again and its continuation decided once the boundary has settled.
                self.cancel_goal_entries(None);
                self.refresh_goal();
                self.schedule_goal_continuation();
            }
            Ctl::Prioritize { queued } => {
                self.prioritize(&queued);
                if let Some(active) = self.cell.run.load_full() {
                    let mut steers = active.steers.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
                    for queued in steers.drain(..) {
                        if !self.steer_marked.contains(&queued) {
                            self.steer_marked.push(queued);
                        }
                    }
                }
            }
            Ctl::Decide(decision, arbitrated) => self.decided(decision, arbitrated),
            Ctl::RunEnded { turn, outcome } => self.run_ended(turn, outcome),
            Ctl::RetryStorage => {
                let _ = self.ch.dur_tx.try_send(ToDurability::Retry);
            }
            Ctl::Held(keys, told) => {
                let held = keys.iter().map(|key| ((*key).to_owned(), self.projected.header.get(*key).cloned().unwrap_or(Value::Null))).collect();
                let _ = told.send(held);
            }
            Ctl::Reconcile(told) => {
                if !self.indeterminate && self.save_risk.unknown.is_empty() {
                    let _ = told.send(Ok(()));
                } else if self.ch.dur_tx.try_send(ToDurability::Retry).is_ok() {
                    self.reconciles.push(told);
                } else {
                    let _ = told.send(Err(CoreError::StorageIndeterminate { scope: "thread".into() }));
                }
            }
            Ctl::RefreshSurface => self.refresh_surface(),
            Ctl::CwdApplied { changed } => self.cwd_applied(changed),
            Ctl::Unsubscribed => self.try_unload(),
            Ctl::Closed(taken) => {
                self.tombstoned = true;
                self.closed_acks.push(taken);
                self.try_unload();
            }
            Ctl::Delete { abort, idle, guard, closed, mark, marked } => self.delete(&abort, idle, guard, closed, mark, marked),
            Ctl::Shutdown(done) => {
                self.cell.close();
                self.cell.abort_compaction(&mixdog_agent::cancel::Abort::runtime_close(self.id.as_str(), "cli-exit"));
                // Node's exit drain: what a failed write left is written once more, in accept order.
                self.shutting_down = true;
                self.retry_due |= self.outbox.awaits_retry();
                if let Some(run) = &self.run {
                    // Teardown's `quiesce('cli-exit')`.
                    run.cancel.abort_with(&mixdog_agent::cancel::Abort::runtime_close(self.id.as_str(), "cli-exit"));
                }
                let _ = done.send(self.close_work("exit"));
            }
        }
    }

    fn abort_requests(&mut self, turn: TurnId) {
        if let Some(text) = self.run.as_ref().filter(|run| run.turn == turn).map(|run| format!("Error: {}", run.cancel.reason())) {
            for call in self.book.open_asks().filter_map(|ask| ask.call_id.as_ref()) {
                self.abort_ended.insert(call.as_str().to_owned(), text.clone());
            }
            let now = self.deps.clock.now_ms();
            for aid in self.book.take_run(&turn) {
                let interrupted = ApprovalResolution::Interrupted { at: now };
                self.book.answer(aid, &interrupted);
                self.resolve(aid, &turn, interrupted);
            }
        }
    }

    fn decided(&mut self, decision: mixdog_core_api::thread::Decision, arbitrated: Option<oneshot::Sender<Result<bool, CoreError>>>) {
        let device = self.deps.devices.describe(decision.connection);
        let at = self.deps.clock.now_ms();
        let shown = self.cell.shown_approval.load_full();
        let refused = super::approval_notification::refuses_remote_allow(decision.origin, shown.as_deref(), &decision.request, &decision.result);
        let outcome = match (!refused).then(|| self.book.validate(&decision.request, &decision.result, device, at, decision.origin)) {
            Some(Ok(Some(mut accepted))) => {
                mixdog_core_base::approvals::word_as_the_persons(&mut accepted.resolution);
                self.resolve(accepted.aid, &accepted.rid, accepted.resolution);
                Ok(true)
            }
            None | Some(Ok(None)) => Ok(false),
            Some(Err(error)) => Err(error),
        };
        match (arbitrated, outcome) {
            (Some(arbitrated), outcome) => {
                let _ = arbitrated.send(outcome);
            }
            (None, Err(error)) => self.deps.server_requests.response_rejected(decision.connection, error),
            (None, Ok(_)) => {}
        }
    }

    /// Re-derives the tool-policy surface from the acked header; runs see the new value on
    /// their next authorize.
    fn refresh_surface(&self) {
        let next = self.deps.surfaces.surface(&self.id, &self.acked.header);
        self.surface.send_if_modified(|current| {
            let changed = **current != next;
            if changed {
                *current = Arc::new(next);
            }
            changed
        });
    }

    /// Persists a resolution through the control reserve; applied at its ack.
    fn resolve(&mut self, aid: ApprovalId, rid: &TurnId, resolution: ApprovalResolution) {
        let (phase, by_client) = match &resolution {
            ApprovalResolution::TimedOut { .. } => (ApprovalPhase::Expired, None),
            ApprovalResolution::Decided { device, .. } => (ApprovalPhase::Decided, Text::try_from(device.as_str()).ok()),
            _ => (ApprovalPhase::Decided, None),
        };
        let record = Record::Approval(ApprovalRecord {
            aid: id(&aid.0.to_string()),
            rid: id(rid.as_str()),
            phase,
            by_client,
            at: self.deps.clock.now_ms(),
            op: None,
            body: Some(Slot::Inline(serde_json::to_value(&resolution).expect("protocol types serialize"))),
        });
        self.accept_record(record, Class::Control, Display::None, Vec::new(), vec![Effect::Resolved(aid, resolution)]);
    }

    fn on_deadline(&mut self) {
        let now = tokio::time::Instant::now();
        let at = self.deps.clock.now_ms();
        for (aid, rid) in self.book.expired(now) {
            self.resolve(aid, &rid, ApprovalResolution::TimedOut { at });
        }
    }

    /// A route saved while a turn runs is held for the next turn (`pendingRoute`, written
    /// with Node's `session.heldRoute`).
    fn route_held(&self) -> bool {
        self.acked.header.get("pendingRoute").is_some_and(Value::is_object)
    }

    // ───────────── producers ─────────────

    /// A row's facts (`user_facts`) read the prompt-attachment store: an interactive-io lane job whose answer comes back
    /// as `done(Ok((body, facts)))`. A full lane is waited out, never refused: the row (a reply, a turn's input) is not lost
    /// to a busy lane; `done(Err)` names the lane when the job can never run.
    fn with_facts(&self, body: Value, done: impl FnOnce(Result<(Value, RowFacts), CoreError>) -> JobDone + Send + 'static) {
        let (store, jobs) = (self.deps.attachments.clone(), self.jobs_tx.clone());
        mixdog_core_base::support::lane_job(
            self.deps.lanes.io,
            "row-facts",
            // Never cancelled: the row (a reply, a turn's input) must reach the actor, not be lost to a cancel.
            &CancellationToken::new(),
            move |lane| {
                let mut body = body;
                let facts = store.facts(lane, &mut body);
                (body, facts)
            },
            move |read| drop(jobs.send(done(read))),
        );
    }

    /// A run's committed row, its facts read.
    fn commit_with_facts(&mut self, turn: TurnId, item: ItemCommit, facts: RowFacts, ack: oneshot::Sender<Result<(), RunError>>) {
        if !self.active(&turn) {
            let _ = ack.send(Err(RunError::NotApplied));
            return;
        }
        let display = self.row_display(item.role.as_deref(), &item.body);
        // A provider batch of tool calls opens its cards as the assistant row that holds them is committed
        // (`openToolCalls`): the live end counts the ones Node would give a card.
        if item.role.as_deref() == Some("assistant")
            && let Some(calls) = item.body.get("toolCalls").and_then(Value::as_array)
        {
            let now = self.deps.clock.now_ms();
            if let Some(run) = self.run.as_mut() {
                run.live.tool_batch(calls, self.deps.builtin_skills.as_ref(), now);
            }
        }
        if item.role.as_deref() == Some("tool")
            && let Some(run) = self.run.as_mut()
        {
            run.tool_calls += 1;
        }
        // Node's catalog row counts this row once the turn settles (`ActiveRun::unsaved_messages`).
        if item.model
            && matches!(item.role.as_deref(), Some("user" | "assistant"))
            && let Some(active) = self.cell.run.load().as_ref()
        {
            active.unsaved_messages.fetch_add(1, SeqCst);
        }
        match self.item_record(&turn, item, facts, None) {
            Ok(record) => {
                if let (Record::Item(row), Some(run)) = (&record, self.run.as_mut())
                    && row.model
                {
                    run.last_model = Some(row.clone());
                }
                self.accept_record(record, Class::Normal, display, Vec::new(), vec![Effect::ItemAck(ack)]);
            }
            Err(_) => {
                let _ = ack.send(Err(RunError::NotApplied));
            }
        }
    }

    /// A turn runs, is starting (its input row's facts being read), is settling, or a dequeued
    /// Goal entry is being checked.
    fn turn_busy(&self) -> bool {
        self.turn_held() || self.turn_pending()
    }

    fn starts_gated(&self) -> bool {
        self.turn_unsettled() || self.compaction_held() || self.idle_clearing || self.clear_holds > 0
    }

    fn drain_gated(&self) -> bool {
        // A manual compaction holds the queue too (`commandBusy`, `drain.mjs` `mayStartDrain`); a turn already admitted goes on.
        self.starts_gated() || self.compactions > 0 || self.core_hold() != StartHold::Open
    }

    /// The core's hold on new turn starts as it reads now.
    fn core_hold(&self) -> StartHold {
        *self.start_hold.borrow()
    }

    /// A turn runs, is starting or is settling: what Node's ask lock is held for.
    fn turn_held(&self) -> bool {
        self.run.is_some() || self.starting || self.settling || self.deferred_start.is_some()
    }

    /// What Node's ask lock is held for: [`Self::turn_held`] but for a completion wake, which Node
    /// runs only for its current session (`notification-bus.mjs:50`); the idle delete still
    /// refuses such a run as `busy` from the run itself.
    fn ask_lock_held(&self) -> bool {
        self.run.as_ref().is_some_and(|run| !run.wake) || self.starting || self.settling
    }

    /// A turn is about to start (a dequeued Goal entry is checked, a quota resume is pending):
    /// Node's turn waiting for the ask lock.
    fn turn_pending(&self) -> bool {
        self.goal_checking || self.quota_pending.is_some()
    }

    /// Node's `state.busy`: set when `runTurn` begins, cleared when the turn closes, before its
    /// Goal settlement (`publishTurnClose`).
    fn ui_busy(&self) -> bool {
        self.run.is_some() || self.starting || self.ask_marked()
    }

    #[cfg(test)]
    fn ask_marked(&self) -> bool {
        self.cell.ask_marked.load(SeqCst)
    }

    #[cfg(not(test))]
    fn ask_marked(&self) -> bool {
        false
    }

    fn active(&self, turn: &TurnId) -> bool {
        self.run.as_ref().is_some_and(|run| &run.turn == turn)
    }

    fn sync_compaction(&mut self) {
        let mut set = serde_json::Map::new();
        if let Some(synced) = self.deps.compaction.synced_compaction(&self.projected.header, true) {
            set.insert("compaction".into(), synced);
        }
        // A resumed session re-derives its cache policy from the saved auto-clear (`_resumeClaimedSession`'s
        // `refreshSessionProviderCacheOpts`); a completed turn's install finds it already current.
        if let Some(opts) = self.deps.compaction.synced_cache_opts(&self.projected.header) {
            set.insert("providerCacheOpts".into(), opts);
        }
        if !set.is_empty() {
            self.accept_header(Some(mixdog_store::schema::record::HeaderChange { set, unset: Vec::new() }));
        }
    }

    /// A call's result exists (`onToolResult` of Node's `__earlyNotify`): its card closes now, before its row is committed in
    /// call order. It goes out in order with what the turn showed before it, and is resolved at its show ([`Self::early_result`]).
    fn early_shown(&mut self, turn: &TurnId, row: &ItemRecord, shown: Vec<Shown>) {
        if !self.active(turn) {
            return;
        }
        let at = self.deps.clock.now_ms();
        let verb = self.run.as_ref().map(|slot| slot.verb);
        let transcript = self.run.as_ref().map(|slot| slot.transcript.clone());
        for update in shown.into_iter().filter_map(|shown| match shown {
            Shown::Update(update) => Some(update),
            Shown::Item(_) => None,
        }) {
            let update = super::live_end::live_result(super::live_end::live_form(update, None, verb, transcript.as_ref(), None, at), at, &self.abort_ended);
            self.outbox.push(None, Change::EarlyResult { row: Box::new(row.clone()), update }, Vec::new(), Vec::new());
        }
    }

    fn early_result(&mut self, row: &ItemRecord, update: ThreadItem, notes: &mut Vec<Note>) {
        let ThreadItem::ToolCall { run, .. } = &update else { return };
        let Some(call) = run.call_id.clone() else { return };
        if self.acked.shown_for(&update).is_none() {
            self.early_results.insert(call, (row.clone(), update));
            return;
        }
        if let Some(closed) = self.fold_early(&update) {
            notes.push(item_completed(&self.id, row, &closed));
            self.track_active_tool(&closed);
        }
    }

    /// Folds an early result into its shown card when the card has no result yet: the closed card, now in the acked state.
    /// Nothing when the card is not shown or already has its result (the committed one is final).
    fn fold_early(&mut self, update: &ThreadItem) -> Option<ThreadItem> {
        let card = self.acked.shown_for(update)?;
        if !matches!(&*card, ThreadItem::ToolCall { run, .. } if run.result.is_none()) {
            return None;
        }
        let closed = super::seams::merge_update(&card, update);
        self.acked.apply(&Change::Card(closed.clone()), None);
        Some(closed)
    }

    /// `markToolCallActive` / `markToolCallDone` (active-tool-summary.mjs) from the shown tool rows: a live call with no result yet is
    /// running; its result ends it. Only the surfaced categories (Shell, Web Research, Agent: `classifyToolCategory`) are tracked, each call by
    /// its work units (`aggregateToolCategoryEntries`: a search of three queries counts three).
    fn track_active_tool(&mut self, item: &ThreadItem) {
        let ThreadItem::ToolCall { name, input, run, .. } = item else { return };
        let (Some(call_id), Some(true)) = (run.call_id.as_deref(), run.live) else { return };
        if run.result.is_none() {
            // `openToolCard`: the category and its work-unit count (`activeCount`) decide what is tracked.
            let Some((category, count)) = mixdog_protocol::tool_units::surfaced_tool_units(name, input) else { return };
            self.active_calls.insert(call_id.to_owned(), (category, count, self.deps.clock.now_ms()));
            self.publish_active_tools();
        } else if self.active_calls.remove(call_id).is_some() {
            self.publish_active_tools();
        }
    }

    /// `recomputeActiveToolSummary`: `count:startedAt` of Shell, Web Research and Agent in that order, and the per-tool counts; published
    /// when the summary differs from the held one.
    fn publish_active_tools(&mut self) {
        const SURFACED: [(&str, &str); 3] = [("Shell", "shell"), ("Web Research", "web_search"), ("Agent", "agent")];
        let mut totals = [(0_i64, 0_i64); 3];
        for (category, count, started) in self.active_calls.values() {
            let Some(at) = SURFACED.iter().position(|(surfaced, _)| surfaced == category) else { continue };
            totals[at].0 += (*count).max(1);
            if *started > 0 && (totals[at].1 == 0 || *started < totals[at].1) {
                totals[at].1 = *started;
            }
        }
        let next = totals
            .iter()
            .any(|(count, _)| *count > 0)
            .then(|| totals.iter().map(|(count, started)| format!("{count}:{started}")).collect::<Vec<_>>().join(":"));
        if next == self.projected.sections.runtime.as_ref().and_then(|runtime| runtime.active_tool_summary.clone()) {
            return;
        }
        let active = next.map(|summary| {
            let mut tools = serde_json::Map::new();
            for ((_, key), (count, started)) in SURFACED.iter().zip(totals) {
                if count > 0 {
                    tools.insert((*key).to_owned(), json!({ "count": count, "startedAt": started }));
                }
            }
            (summary, Value::Object(tools))
        });
        self.accept_view(Change::Section(Section::ActiveTools(active)), Vec::new());
    }

    /// `clearActiveToolSummary`: the turn ended, no call is running (and no early result waits for its card).
    fn clear_active_tools(&mut self) {
        self.early_results.clear();
        let held = self.projected.sections.runtime.as_ref().is_some_and(|runtime| runtime.active_tool_summary.is_some() || runtime.active_tools.is_some());
        if self.active_calls.is_empty() && !held {
            return;
        }
        self.active_calls.clear();
        if held {
            self.accept_view(Change::Section(Section::ActiveTools(None)), Vec::new());
        }
    }

    /// A settings change this runtime applied (`announceSettingsChange`): the surfaces re-read, and `setupChanged` counts it
    /// (notification-router.mjs: `{ action, seq, at }`); the route section follows the saved configuration.
    fn on_settings_changed(&mut self, announced: u64) {
        // Node's router counts every delivery (setupChangeSeq += 1): announcements that reached this thread together count one each.
        // Node delivers them to a session's listener, which exists from its creation: a task's from `client.create`, the control's
        // from the first control call (`ensureControlSession`, session-host-transport.ts:235), seated route or not - as this thread.
        for _ in 0..announced {
            self.setup_changes += 1;
            let change = json!({ "action": "settings_changed", "seq": self.setup_changes, "at": self.deps.clock.now_ms() });
            self.accept_view(Change::Section(Section::SetupChanged(change)), Vec::new());
        }
        self.sync_route_config();
    }

    /// The installed session's state holds the configured route values from its start (`createInitialSessionState` takes `baseRouteState()`):
    /// they are seeded into the state, not published, so a feed that attaches reads them in its snapshot and no frame announces them.
    fn seed_route_config(&mut self) {
        let change = Change::Section(Section::Route(self.deps.compaction.route_config(&self.projected.header)));
        self.projected.apply(&change, None);
        self.acked.apply(&change, None);
    }

    /// The installed session's state holds its stored list from its start (`todo: todoSnapshot(session)`,
    /// store-transcript-projection.mjs:312): seeded like the route values, no frame announces it.
    fn seed_todo(&mut self) {
        let todo = mixdog_core_ports::ports::todo_list::snapshot_of(&self.projected.header);
        if todo.is_some() {
            let change = Change::Section(Section::Todo(todo));
            self.projected.apply(&change, None);
            self.acked.apply(&change, None);
        }
    }

    /// The route section's configured values (`autoClear`, `systemShell`, `webSearchRoute` of `baseRouteState`), published when the
    /// saved configuration states something other than the section holds. Read at each announced settings change: the stored settings
    /// the route values come from are the ones settingsChanged compares.
    fn sync_route_config(&mut self) {
        let route = self.deps.compaction.route_config(&self.projected.header);
        let held = self.projected.sections.route.clone().unwrap_or_default();
        if route.auto_clear != held.auto_clear || route.system_shell != held.system_shell || route.web_search_route != held.web_search_route {
            self.accept_view(Change::Section(Section::Route(route)), Vec::new());
        }
    }

    /// A context section a producer published. While a turn runs, the display fields (`displayContextWindow`,
    /// `autoCompactTokenLimit`, `compactBoundaryTokens`) wait for the turn's end, as Node's `syncContextDisplayFields` runs when
    /// the turn settles (turn.mjs:530), a stopped one included.
    fn on_context_section(&mut self, mut context: ThreadContext) {
        if self.run.is_some() {
            let held = self.held_display.get_or_insert_with(Default::default);
            held.display_context_window = context.display_context_window.take().or(held.display_context_window);
            held.auto_compact_token_limit = context.auto_compact_token_limit.take().or(held.auto_compact_token_limit);
            held.compact_boundary_tokens = context.compact_boundary_tokens.take().or(held.compact_boundary_tokens);
            if context == ThreadContext::default() {
                return;
            }
        }
        self.accept_view(Change::Section(Section::Context(context)), Vec::new());
    }

    /// The disk-side heartbeat of `markSessionStreamDelta` (`runtime-liveness.mjs`, `HEARTBEAT_THROTTLE_MS`): a
    /// semantic model event of a live run refreshes `lastHeartbeatAt` once the stored one is over a minute old.
    fn stream_heartbeat(&mut self) {
        if self.run.is_none() {
            return;
        }
        let change = super::usage_books::stream_heartbeat(&self.projected.header, self.deps.clock.now_ms() as f64);
        self.accept_header(change);
    }

    /// The run produced output: its prompt is no longer the user's to take back (`commitPromptRestore`).
    fn prompt_committed(&self) {
        if let Some(run) = &self.run {
            run.prompt.commit();
        }
    }

    /// `pushToast` (`notice-surface.mjs`): a transient notice of the session, shown in the runtime section's `toasts` for `TOAST_TTL` and then removed. Empty text is no toast.
    /// `effects` run when the toast's change is released; for an empty text, at once.
    fn push_toast(&mut self, text: &str, tone: &str, owner: Option<&str>, effects: Vec<Effect>) {
        let text = mixdog_js::js_trim(text);
        if text.is_empty() {
            for effect in effects {
                self.effect_done(effect);
            }
            return;
        }
        let id = new_id();
        let mut toast = json!({ "id": id, "text": text, "tone": tone });
        if let Some(owner) = owner {
            toast["owner"] = json!(owner);
        }
        let mut toasts = self.projected.sections.runtime.as_ref().map(|runtime| runtime.toasts.clone()).unwrap_or_default();
        toasts.push(toast);
        self.accept_view_with(Change::Section(Section::Toasts(toasts)), Vec::new(), effects);
        // Weak while it waits on the clock: the actor holds the channel open, and a timer is no job in flight.
        let jobs = self.jobs_tx.downgrade();
        let expiring = id.clone();
        let timer = tokio::spawn(async move {
            mixdog_rt::time::sleep(TOAST_TTL).await;
            if let Some(jobs) = jobs.upgrade() {
                let _ = jobs.send(JobDone::ToastExpired(expiring));
            }
        });
        self.toast_timers.insert(id, timer.abort_handle());
    }

    /// `clearToastTimers` (`notice-surface.mjs:125`): no toast in the queue expires after this.
    fn cancel_toast_timers(&mut self) {
        for (_, timer) in self.toast_timers.drain() {
            timer.abort();
        }
    }

    /// The spinner the runtime section shows, if any.
    fn spinner(&self) -> Option<&Value> {
        self.projected.sections.runtime.as_ref().and_then(|runtime| runtime.spinner.as_ref())
    }

    /// `set({ spinner: { ...spinner, ...fields } })`: nothing while no spinner is shown.
    fn patch_spinner<const N: usize>(&mut self, fields: [(&str, Value); N]) {
        if self.spinner().is_none() {
            return;
        }
        let fields = fields.into_iter().map(|(key, value)| (key.to_owned(), value)).collect();
        self.accept_view(Change::Section(Section::Spinner(fields)), Vec::new());
    }

    /// The stats section: the totals as they stand, with the turns the session closed (set({ stats })).
    fn publish_stats(&mut self) {
        let context = mixdog_app_protocol::v2::thread::ThreadContext { stats: Some(self.stats.json(self.turns_closed)), ..Default::default() };
        self.accept_view(Change::Section(Section::Context(context)), Vec::new());
    }

    /// A run's live-only line or notification (`RunPort::notice`, `usage`, `compact_event`).
    fn run_shown(&mut self, turn: TurnId, shown: RunShown) {
        match shown {
            RunShown::Notice { text, tone } => {
                let text = super::live_rows::polish_notice_text(&text);
                if text.is_empty() {
                    return;
                }
                let item = super::transcript::notice_item(&new_id(), turn.as_str(), &text, tone.as_str());
                self.show_live(turn, item, None);
            }
            RunShown::Reasoning(item) => self.show_live(turn, item, None),
            RunShown::TextSettled(item) => {
                // The streamed text as it stands: the live item the deltas built (none when nothing streamed into it). Whether
                // it shows is decided at its show (`Change::Settled`): the run hands its rows and its shown events on apart, so
                // its reply's commit may be ahead of it, and then that commit's row, or its failure, decides.
                if let Some(text) = self.projected.live.iter().find(|live| live.item.id() == &item).map(|live| live.item.clone()) {
                    self.accept_view(Change::Settled { turn, item: text }, Vec::new());
                }
            }
            RunShown::Usage(report) => self.shown_usage(report),
            RunShown::Call(mark) => self.shown_call(mark),
            RunShown::Check(check) => {
                if let Some(books) = self.deps.compaction.books(&self.id, &self.projected.header) {
                    let change = super::usage_books::check_change(&self.projected.header, &check, &books, self.deps.clock.now_ms() as f64);
                    self.defer_header(change);
                }
            }
            RunShown::Settled(settled) => self.shown_settled(settled),
            RunShown::SearchUsage(usage) => {
                let note =
                    Note::new("thread/tokenUsage/updated", &mixdog_app_protocol::v2::thread::TokenUsageUpdatedParams { thread_id: self.id.clone(), usage });
                self.accept_view(Change::Barrier, vec![note]);
            }
            RunShown::Stage { stage, detail } => {
                // The retained spinner takes the stage; the event stays for its readers (the CLI's exec feed).
                if let Some(fields) = super::spinner::stage_fields(self.spinner(), &stage, detail.as_ref(), self.deps.clock.now_ms()) {
                    self.patch_spinner(fields);
                }
                let note =
                    Note::new("thread/stage/updated", &mixdog_app_protocol::v2::thread::ThreadStageUpdatedParams { thread_id: self.id.clone(), stage, detail });
                self.accept_view(Change::Barrier, vec![note]);
            }
            RunShown::ModelRequest { request_index, phase, tool_calls } => {
                let params = mixdog_app_protocol::v2::thread::ModelRequestUpdatedParams {
                    thread_id: self.id.clone(),
                    turn_id: turn.clone(),
                    request_id: format!("model_request_{request_index}"),
                    request_index,
                    phase,
                    duration_ms: None,
                    usage: None,
                    tool_calls,
                };
                self.accept_view(Change::Barrier, vec![Note::new("thread/modelRequest/updated", &params)]);
            }
            RunShown::ToolBatch { request_index, phase, iteration, calls, duration_ms } => {
                let params = mixdog_app_protocol::v2::thread::ToolBatchUpdatedParams {
                    thread_id: self.id.clone(),
                    turn_id: turn.clone(),
                    batch_id: format!("tool_batch_{request_index}"),
                    phase,
                    iteration,
                    calls,
                    duration_ms,
                };
                self.accept_view(Change::Barrier, vec![Note::new("thread/toolBatch/updated", &params)]);
            }
            RunShown::ToolStream => self.stream_heartbeat(),
            RunShown::CompactUsage(report) => {
                let now = self.deps.clock.now_ms();
                let usage = super::live_rows::compact_usage_delta(self.id.as_str(), &report, now);
                // `persistIterationMetrics` marks the turn's usage incremental, as for any call.
                self.usage_incremental = true;
                let change = super::usage_books::compact_usage_change(&self.projected.header, report.input_excludes_cache, &usage, now as f64);
                self.accept_header(change);
                let mut usage = usage;
                usage["usageMetricsTurnId"] = self.projected.header.get("usageMetricsTurnId").cloned().unwrap_or(json!(0));
                usage["usageMetricsEpoch"] = self.projected.header.get("usageMetricsEpoch").cloned().unwrap_or(json!(0));
                let note =
                    Note::new("thread/tokenUsage/updated", &mixdog_app_protocol::v2::thread::TokenUsageUpdatedParams { thread_id: self.id.clone(), usage });
                self.accept_view(Change::Barrier, vec![note]);
            }
            RunShown::Pass(pass) => {
                if let Some(books) = self.deps.compaction.books(&self.id, &self.projected.header) {
                    let change = super::usage_books::pass_change(&self.projected.header, &pass, &books, self.deps.clock.now_ms() as f64);
                    self.accept_header(change);
                }
            }
            RunShown::Compact(event) => {
                let label = super::live_rows::compact_event_label(&event);
                let detail = super::live_rows::compact_event_detail(&event);
                // A pass that changed the context writes the compaction record, whose divider is the one row it shows.
                if super::live_rows::compact_changed(&event) && !self.agent_mode() {
                    let found = {
                        let pairs = CompactPairs::of(&mut self.compact_pairs, &turn);
                        let seq = pairs.events;
                        pairs.events += 1;
                        if pairs.lost.remove(&seq) {
                            // Its record was rejected: the divider it would have filled is gone.
                            None
                        } else if let Some(waiting) = pairs.dividers.remove(&seq) {
                            Some(waiting)
                        } else {
                            pairs.details.insert(seq, detail.clone());
                            None
                        }
                    };
                    if let Some(WaitingDivider { entry, mut item, .. }) = found {
                        super::view::meta_mut(&mut item).detail = Some(detail.clone());
                        let note = Note::new(
                            "item/completed",
                            &ItemNotificationParams { thread_id: self.id.clone(), turn_id: turn, item: item.clone(), room_view: None },
                        );
                        // Stands on the record's entry: if the encoder rejects the record, the patch goes with it.
                        self.accept_view_after(Some(entry), Change::Detail { item: item.id().clone(), detail }, vec![note], Vec::new());
                    }
                    return;
                }
                let item = super::transcript::compact_marker_item(&new_id(), turn.as_str(), label, &detail);
                // A pass that changed the context marks where the turn began: the rows above it
                // are what the compaction took (`archiveItemsForCompaction`).
                let before = super::live_rows::compact_changed(&event).then(|| self.run.as_ref().map(|run| run.input_item.clone())).flatten();
                self.show_live(turn, item, before);
            }
        }
    }

    fn shown_usage(&mut self, report: super::run::UsageReport) {
        if let Some(run) = self.run.as_mut() {
            run.live.usage(report.usage.output_tokens);
        }
        let now = self.deps.clock.now_ms();
        let usage = super::live_rows::usage_delta(self.id.as_str(), &report, now);
        self.stats.fold(&usage);
        self.usage_incremental = true;
        let books = self.deps.compaction.books(&self.id, &self.projected.header);
        let pressure_usage = mixdog_agent::compact::pressure::with_prompt_cache_evidence(&self.projected.header, &usage, &report.usage);
        let change = super::usage_books::usage_change(
            &self.projected.header,
            report.input_excludes_cache,
            &pressure_usage,
            &report.outgoing,
            &report.send_tools,
            books.as_ref(),
            (report.sent_at_ms as f64, now as f64),
        );
        let change = super::usage_books::with_tail_book(change, report.tail_book.as_ref());
        if let (Some(run), Some(reading)) = (self.run.as_mut(), change.as_ref().and_then(|change| change.set.get("lastContextTokens"))) {
            if reading.is_null() {
                run.journal.context(None);
            } else if let Some(tokens) = reading.as_u64() {
                run.journal.context(Some(tokens));
            }
        }
        self.defer_header(change);
        let usage: serde_json::Map<String, Value> =
            usage.as_object().into_iter().flatten().filter(|(key, _)| *key != "sendTools").map(|(key, value)| (key.clone(), value.clone())).collect();
        let note = Note::new(
            "thread/tokenUsage/updated",
            &mixdog_app_protocol::v2::thread::TokenUsageUpdatedParams { thread_id: self.id.clone(), usage: Value::Object(usage) },
        );
        self.accept_view(Change::Barrier, vec![note]);
        self.publish_stats();
        let Some(run) = self.run.as_mut() else { return };
        let had = run.live_call.next();
        let (input, output) = self.stats.tokens();
        let (input, output) = (input.saturating_sub(run.tokens_at_start.0), output.saturating_sub(run.tokens_at_start.1));
        if had {
            self.patch_spinner([("liveCall", Value::Null)]);
        }
        self.patch_spinner([("inputTokens", json!(input)), ("outputTokens", json!(output))]);
    }

    fn shown_settled(&mut self, settled: super::run::Settled) {
        let books = self.deps.compaction.books(&self.id, &self.projected.header);
        let now = self.deps.clock.now_ms();
        let change = super::usage_books::settled_change(&self.projected.header, &settled, self.usage_incremental, books.as_ref(), now as f64);
        self.accept_header(change);
        let (estimated_tokens, turn_effort) = super::usage_books::gateway_facts(&self.projected.header, &settled, books.as_ref());
        self.deps.gateway_usage.record_ask(&super::gateway_usage::Ask {
            header: &self.projected.header,
            usage: &settled.usage,
            response_model: &settled.response_model,
            tool_calls_total: settled.tool_calls_total,
            message_count: settled.transcript.len(),
            estimated_tokens,
            turn_effort,
            duration_ms: (now - settled.asked_at_ms) as f64,
            transport_timing: None,
        });
    }

    fn shown_call(&mut self, mark: super::run::CallMark) {
        match mark {
            super::run::CallMark::Streaming => {
                let thinking = self.spinner().and_then(|spinner| spinner.get("thinking")).and_then(Value::as_bool) == Some(true);
                let mode = if thinking { "thinking" } else { "responding" };
                if self.spinner().and_then(|spinner| spinner.get("mode")).and_then(Value::as_str) != Some(mode) {
                    self.patch_spinner([("mode", json!(mode))]);
                }
            }
            super::run::CallMark::ToolCall => {
                if self.run.as_mut().is_some_and(|run| run.live_call.withdraw()) {
                    self.patch_spinner([("liveCall", Value::Null)]);
                }
                self.patch_spinner([("mode", json!("tool-use"))]);
            }
            super::run::CallMark::TaskWait(waiting) => {
                let mode = self.spinner().and_then(|spinner| spinner.get("mode")).and_then(Value::as_str);
                if waiting && mode != Some("task-wait") {
                    self.patch_spinner([("mode", json!("task-wait"))]);
                } else if !waiting && mode == Some("task-wait") {
                    self.patch_spinner([("mode", json!("tool-use"))]);
                }
            }
            super::run::CallMark::ToolApproval => {
                if self.spinner().and_then(|spinner| spinner.get("mode")).and_then(Value::as_str) != Some("tool-approval") {
                    self.patch_spinner([("mode", json!("tool-approval"))]);
                }
            }
            super::run::CallMark::ToolPhaseCompleted => {
                let mode = self.spinner().and_then(|spinner| spinner.get("mode")).and_then(Value::as_str);
                if mode.is_some_and(|mode| mode != "requesting") {
                    self.patch_spinner([("mode", json!("requesting"))]);
                }
            }
        }
    }

    /// An agent-mode session compacts silently (`isAgentModeSession`).
    fn agent_mode(&self) -> bool {
        let mut header = self.acked.header.clone();
        header.entry("id").or_insert_with(|| Value::String(self.id.as_str().to_owned()));
        mixdog_store::agent_mode::session_mode_of(&header) == "agent"
    }

    /// A live-only row of the run, before the row `before` when it is in view, else last.
    fn show_live(&mut self, turn: TurnId, item: ThreadItem, before: Option<mixdog_core_api::ids::ItemId>) {
        self.show_live_then(turn, item, before, None, Vec::new());
    }

    /// [`Self::show_live`], with `effects` that run when the row is released (shown to the feed, and in
    /// the acked state). `needs`: the record the row stands on ([`Self::accept_view_after`]).
    fn show_live_then(&mut self, turn: TurnId, item: ThreadItem, before: Option<mixdog_core_api::ids::ItemId>, needs: Option<u64>, effects: Vec<Effect>) {
        let note = Note::new("item/completed", &ItemNotificationParams { thread_id: self.id.clone(), turn_id: turn, item: item.clone(), room_view: None });
        self.accept_view_after(needs, Change::Shown { item, before }, vec![note], effects);
    }

    /// The live display of a user row: the row of a completion the listener showed is durable
    /// but shows no row of its own.
    fn row_display(&mut self, role: Option<&str>, body: &Value) -> Display {
        if role != Some("user") {
            return Display::None;
        }
        if let Some(execution) = body.pointer("/meta/execution/id").and_then(Value::as_str)
            && self.suppressed.remove(execution)
        {
            return Display::Suppressed;
        }
        // The queue ids a steered row took in: it shows nothing when every one was queued for the
        // model alone.
        let ids: Vec<&str> = body.pointer("/meta/submissionIds").and_then(Value::as_array).into_iter().flatten().filter_map(Value::as_str).collect();
        let hidden = ids.iter().filter(|id| self.suppressed.remove(**id)).count();
        if !ids.is_empty() && hidden == ids.len() { Display::Suppressed } else { Display::None }
    }

    /// The row of a run's commit. `facts`: the classification migration writes too, read from the
    /// body ([`Self::with_facts`]).
    fn item_record(&self, turn: &TurnId, mut item: ItemCommit, facts: RowFacts, op: Option<OpRef>) -> Result<Record, CoreError> {
        let (visible, prompt) = (item.visible && facts.visible, item.prompt.take().or(facts.prompt));
        Ok(Record::Item(ItemRecord {
            iid: text(item.iid.as_str(), "itemId")?,
            turn: Some(text(turn.as_str(), "turnId")?),
            role: item.role.as_deref().map(|role| text(role, "role")).transpose()?,
            form: Form::Message,
            model: item.model,
            visible,
            archive: None,
            op,
            prompt: prompt.map(Slot::Inline),
            refs: Vec::new().try_into().expect("empty list fits"),
            body: Slot::Inline(item.body),
        }))
    }

    /// The id comes from the durable allocator off the actor, and a sub-agent's surface (`approvalSurface`, read by the
    /// queue's `delegationSurface`) from its record and the agents' names; the request continues in [`Self::approval_id`].
    /// Only a request of a delegated kind looks its surface up: a question's card never carries one, so it does not wait on it.
    fn request_approval(&mut self, turn: TurnId, ask: ApprovalAsk, reply: oneshot::Sender<ApprovalResolution>) {
        let ids = self.deps.approval_ids.clone();
        let jobs = self.jobs_tx.clone();
        let lookup = super::room_approval::is_delegated(&ask).then(|| (self.ch.directory.clone(), self.deps.agent_names.clone(), self.id.clone()));
        tokio::spawn(async move {
            let result = ids.next().await;
            let lookup = lookup.and_then(|(directory, names, thread)| Some((directory.upgrade()?.outer()?, names, thread)));
            let surface = match lookup {
                Some((directory, names, thread)) => super::delegation::approval_surface(thread.as_str(), &directory, &*names).await,
                None => None,
            };
            let _ = jobs.send(JobDone::ApprovalId { turn, ask, reply, result, surface });
        });
    }

    /// An allocator failure fails the ask like a cancelled one: no request was shown.
    fn approval_id(
        &mut self,
        turn: TurnId,
        ask: ApprovalAsk,
        reply: oneshot::Sender<ApprovalResolution>,
        result: Result<ApprovalId, CoreError>,
        surface: Option<super::delegation::ApprovalSurface>,
    ) {
        let aid = match result {
            Ok(aid) if self.active(&turn) => aid,
            _ => {
                let _ = reply.send(ApprovalResolution::Cancelled { at: self.deps.clock.now_ms() });
                return;
            }
        };
        // A sub-agent's request is shown where Node's `approvalSurface` puts it, the delegation's root (its own surface, a room
        // seat's log), however many of the ancestors between are loaded: `lineage` reaches only the loaded parents.
        let lineage = match &surface {
            Some(root) => Lineage {
                surface: super::delegation::room_log_surface(&root.session_id).unwrap_or_else(|| ThreadId::from(root.session_id.as_str())),
                chain: self.lineage.chain.clone(),
            },
            None => self.lineage.clone(),
        };
        let request = ApprovalBook::request(aid, &self.id, &lineage, ask, self.deps.clock.now_ms());
        let mut params = request_params(&request, &turn);
        // Node's card of the request (`state.toolApproval`, `normalizeToolApprovalRequest` of the hook request:
        // `room_approval.rs` `tool_approval`), which the phone shows as Node's did.
        params["card"] = super::room_approval::tool_approval(&request);
        params["card"]["id"] = json!(super::room_approval::card_id(&request.id.0.to_string()));
        if let Some(surface) = &surface {
            super::room_approval::delegate_card(&mut params["card"], surface);
        }
        let method = request.ask.kind.method();
        let pending = PendingServerRequest {
            id: aid.request_id(),
            method,
            thread: self.id.clone(),
            surface: lineage.surface.clone(),
            order: aid.0,
            frame: request_frame(&request, params.clone()),
        };
        let record = Record::Approval(ApprovalRecord {
            aid: id(&aid.0.to_string()),
            rid: id(turn.as_str()),
            phase: ApprovalPhase::Requested,
            by_client: None,
            at: self.deps.clock.now_ms(),
            op: None,
            body: Some(Slot::Inline(json!({ "method": method.as_str(), "params": params }))),
        });
        self.book.insert(request, turn, Some(reply));
        self.accept_record(record, Class::Control, Display::None, Vec::new(), vec![Effect::PublishApproval(pending)]);
    }

    // ───────────── inbox ─────────────

    fn on_inbox(&mut self, msg: Inbox) {
        match msg {
            Inbox::GoalChanged(goal) => self.goal_changed(goal),
            Inbox::CompletionCard { content, meta } => self.completion_card(&content, &meta),
            Inbox::SetupUiRequest { id, window } => self.setup_ui_request(id, window),
            Inbox::SetupUiSettled { id } => self.setup_ui_settled(&id),
            Inbox::TaskNotification { surface, task_id, status, text, origin, hop, live, durable } => {
                self.task_notification(&surface, task_id, status, text, origin, hop, live, durable)
            }
            Inbox::AgentActivity { named } => self.agent_activity(named),
            Inbox::SensitiveCarried => {
                self.redact_prompts();
                // The log now (a queued batch rewrites it before it appends anyway); the search rows once what is
                // queued is durable. A running turn's own listener does the same; the second pass finds nothing.
                let _ = self.ch.dur_tx.try_send(ToDurability::Redact);
                let ack = self.ingest_when_durable();
                self.outbox.push(None, Change::Barrier, Vec::new(), vec![Effect::ItemAck(ack)]);
            }
            Inbox::WritesLanded { tx } => match self.outbox.last_id().filter(|through| self.outbox.unwritten_through(*through)) {
                None => {
                    let _ = tx.send(Ok(()));
                }
                Some(through) => {
                    // What a failed barrier held goes again only with a next write: the pump hands it now. A barrier would not
                    // wait for it (a view-only entry behind held ones settles at once), so the waiter watches the records.
                    self.retry_due |= self.outbox.has_unsaved() || self.outbox.awaits_retry();
                    self.writes_landed.push((through, tx));
                }
            },
            Inbox::ForkPlan { idle, tx } => {
                // A person's clear (the idle plan) waits out the scheduled compaction, as Node's `afterCompaction(clear)`
                // does: its copy is then of the conversation the compaction left.
                if idle && let Some(after) = &mut self.after_compaction {
                    after.waiting.push(Waiting::Plan(tx));
                    #[cfg(any(test, feature = "test-support"))]
                    self.cell.gate_holds.fetch_add(1, SeqCst);
                } else {
                    let _ = tx.send(self.fork_plan(idle));
                }
            }
            Inbox::RewindPreview { item, tx } => {
                let _ = tx.send(self.rewind_preview(&item));
            }
            Inbox::CheckedHistory { req, revision, tx } => {
                let checked = self.history_revision(true).and_then(|actual| if actual == revision { Ok(()) } else { Err(history_conflict()) });
                match checked {
                    Ok(()) => self.on_inbox(Inbox::Request { req, tx }),
                    Err(error) => {
                        let _ = tx.send(Err(error));
                    }
                }
            }
            Inbox::UnsavedRows { tx } => {
                let rows = self
                    .outbox
                    .unsaved_records()
                    .filter_map(|record| match &**record {
                        Record::Item(item) if item.form == Form::Message && item.model => Some((item.iid.as_str(), &item.body, false)),
                        Record::Amend(amend) => Some((amend.iid.as_str(), &amend.body, true)),
                        _ => None,
                    })
                    .filter_map(|(iid, body, amend)| match body {
                        Slot::Inline(body) => Some((iid.to_owned(), body.clone(), amend)),
                        Slot::Blob(_) => None,
                    })
                    .collect();
                let _ = tx.send(rows);
            }
            Inbox::CommitCompaction { snapshot, compaction, header, tx } => self.commit_compaction(snapshot, compaction, header, tx),
            Inbox::PushToast { text, tone, tx } => {
                // The caller is told when the toast is published, not when it is queued: an earlier unacknowledged record holds it back.
                self.push_toast(&super::live_rows::polish_notice_text(&text), &tone, None, vec![Effect::AfterPublish(tx)]);
            }
            Inbox::QuotaFacts { tx } => {
                let _ = tx.send(self.resume_check());
            }
            Inbox::QuotaCancelled { tx } => {
                self.quota_cancel_now();
                let (settlement, id) = (self.quota.settlement.clone(), self.id.as_str().to_owned());
                self.quota.call(async move {
                    if let Err(error) = settlement.cancel_resume(&id).await {
                        tracing::warn!("a quota resume was cancelled in memory but its entry was not removed: {error:?}");
                    }
                    let _ = tx.send(());
                });
            }
            Inbox::QuotaResumeChanged => self.publish_quota_resume(),
            Inbox::QuotaResumeFire { generation, tx } => self.quota_fire(generation, tx),
            Inbox::Op { call, tx } => self.op_call(call, tx),
            Inbox::UpdateHeader { update, tx } => self.update_header(update, tx),
            // Awaited by the run loop, which handles it before this match.
            Inbox::UpdateHeaderAwaiting { .. } => unreachable!("the run loop awaits it"),
            #[cfg(any(test, feature = "test-support"))]
            Inbox::Unwind(UnwindAt::Now) => panic!("the test's injected unwind"),
            #[cfg(any(test, feature = "test-support"))]
            Inbox::Unwind(UnwindAt::Delete) => self.unwind_at_delete = true,
            #[cfg(test)]
            Inbox::AskEnded => {
                self.cell.ask_marked.store(false, SeqCst);
                self.run_deferred_prune();
            }
            Inbox::IdleDue => self.on_idle_evict(),
            Inbox::IdleRelease(ack) => {
                self.idle_acks.push(ack);
                self.on_idle_evict();
            }
            Inbox::StoredPatch { req, tx, attempt } => self.stored_patch(req, tx, attempt),
            Inbox::Request { req, tx } => {
                let tx = match &req.op {
                    Some(op) => {
                        let digest = ops::replay_key(&req);
                        match self.ops.admit(op, &digest, tx) {
                            Admit::New(tx) => tx,
                            Admit::Handled => return,
                        }
                    }
                    None => tx,
                };
                if let Err((error, tx)) = self.mutation(req, tx) {
                    let _ = tx.send(Err(error));
                }
            }
        }
    }

    /// A message from the inbox. While a route move is pending, a header write waits behind it; a `thread/header/patch` that moves
    /// the route window becomes the next pending move.
    async fn take_inbox(&mut self, msg: Inbox) {
        if self.route_move.is_some() && writes_header(&msg) {
            self.route_queue.push_back(msg);
            return;
        }
        match msg {
            Inbox::UpdateHeaderAwaiting { update, tx } => self.update_header_awaiting(update, tx).await,
            Inbox::Request { req, tx } => match self.window_move_header(&req) {
                Some(header) => self.start_route_move(MoveApply::Request { req, tx }, header),
                None => self.on_inbox(Inbox::Request { req, tx }),
            },
            msg => self.on_inbox(msg),
        }
    }

    /// `pushAsyncAgentResponse` behind Node's card gates (`execution-delivery.mjs`): the
    /// completion's live card, a new item or the last inbound agent card extended. The card is
    /// view state: no record, so a reopen shows the completion where its turn took it in.
    fn completion_card(&mut self, content: &str, meta: &Value) {
        let Some(card) = self.cards.admit(content, meta) else { return };
        // The listener queues this completion's model copy itself, with no row of its own
        // (`suppressDisplay`): its card (or the earlier one it would duplicate) stands for it.
        if let Some(execution) = meta.get("execution_id").and_then(Value::as_str).filter(|e| !e.is_empty()) {
            self.listened.insert(execution.to_owned());
        }
        if !card {
            return;
        }
        let previous = match self.projected.live.last() {
            Some(live) => Some(live.item.clone()),
            None => self.projected.window.back().map(|row| (*row.item).clone()),
        };
        let completion = super::transcript::Completion { content, meta };
        let id = new_id();
        let Some(delivery) = super::transcript::agent_response(&completion, &id, previous.as_ref(), self.deps.clock.now_ms()) else {
            return;
        };
        let (super::transcript::Delivery::Push(card) | super::transcript::Delivery::Patch(card)) = delivery;
        let note =
            Note::new("item/completed", &ItemNotificationParams { thread_id: self.id.clone(), turn_id: TurnId::from(""), item: card.clone(), room_view: None });
        self.accept_view(Change::Card(card), vec![note]);
    }

    #[allow(clippy::too_many_arguments)]
    fn task_notification(
        &mut self,
        surface: &str,
        task_id: String,
        status: String,
        text: String,
        origin: Option<&'static str>,
        hop: u32,
        live: bool,
        durable: Option<oneshot::Sender<Result<(), RunError>>>,
    ) {
        // A closing or closed owner never queues a completion (`notification-bus.mjs` `notifySessionCompletion`: `if
        // (!open) return handled`): the close cancels the session's shells, and their completions must not enqueue
        // model work for it.
        if origin.is_none()
            && (self.deleting || self.tombstoned || self.cell.closed.load(SeqCst) || self.acked.header.get("closed") == Some(&Value::Bool(true)))
        {
            if let Some(durable) = durable {
                let _ = durable.send(Err(RunError::NotApplied));
            }
            return;
        }
        let now = self.deps.clock.now_ms();
        let built = match origin {
            None => completions::entry(surface, &task_id, &status, &text, now, hop),
            Some(_) => completions::channel_entry(&text, now).map(|entry| (new_id(), entry)),
        };
        let Some((qid, mut entry)) = built else {
            if let Some(durable) = durable {
                let _ = durable.send(Err(RunError::NotApplied));
            }
            return;
        };
        let acks = |durable: Option<oneshot::Sender<Result<(), RunError>>>| durable.map(Effect::ItemAck).into_iter().collect::<Vec<_>>();
        // Queued by the listener that showed it (`execution-delivery.mjs` `suppressDisplay`).
        if self.listened.remove(&task_id) {
            entry["suppressDisplay"] = Value::Bool(true);
        }
        // A receipt can be projected by a result released unsaved. A durable marker must
        // follow that result: unlike a view barrier it cannot pass held records, and its
        // MarkAck fails rather than reporting an unsaved receipt as consumed.
        if mixdog_store::completion_receipts::contains(&self.projected.header, &qid) {
            if let Some(durable) = durable {
                let marker = Record::Meta(MetaRecord { op: None, change: Slot::Inline(HeaderChange { set: Default::default(), unset: Vec::new() }) });
                self.accept_record(marker, Class::Control, Display::None, Vec::new(), vec![Effect::MarkAck(durable)]);
            }
            return;
        }
        // A completion a user Stop froze is consumed whatever its record's save did: delivered again, it is never queued. Its
        // owner hears no consumption this process could not save.
        if self.stops.latched_identity(&mixdog_store::work_stops::queued(&qid)).is_some() {
            if let Some(durable) = durable {
                let _ = durable.send(Err(RunError::NotApplied));
            }
            return;
        }
        // The same completion queued twice is one entry; its waiter follows that enqueue.
        if self.projected.queue.iter().any(|q| q.qid == qid) {
            if durable.is_some() {
                self.outbox.push(None, Change::Barrier, Vec::new(), acks(durable));
            }
            return;
        }
        let due_now = within_priority(&entry, Priority::Next);
        let record = Record::Queue(QueueRecord { qid: id(&qid), action: QueueAction::Enqueue, reason: None, op: None, entry: Some(Slot::Inline(entry)) });
        self.accept_record(record, Class::Normal, Display::None, Vec::new(), acks(durable));
        // A `later` notice is not due for delivery while the turn runs, so it wakes no wait.
        if due_now {
            self.deps.wakes.interrupt(&self.id, WakeReason::Notification, Some(task_id).filter(|id| !id.is_empty()));
        }
        if live && self.run.is_none() {
            self.start_next_queued();
        }
    }

    // ───────────── runs ─────────────

    /// The run's input row and `run{started}` (appended after it, so it is durable only after
    /// its input, FORMAT.md §5.2), then the run task.
    fn start_run(&mut self, input: TurnInput, originals_missing: u32, op_ref: Option<OpRef>, reply: Option<Effect>, prompt: Option<String>) {
        let body = self.deps.transcript.user_message(&input, originals_missing);
        // A direct start's identity is allocated here, at its admission, not when its input row is read.
        let submissions = submission_id(&input).map(str::to_owned).into_iter().collect();
        let work = self.work_of(new_id(), Vec::new(), submissions, &input, false);
        self.start_run_with(DeferredStart { input, body, op_ref, reply, prompt, wake: false, retried: false, work });
    }

    /// `awaitPreviousTurnDurable` (`ask-turn-open.mjs:41`), which every ask passes: the previous turn's records
    /// (through its `turnCoverage`) have not all landed, or the crashed runs are still being finalized.
    fn turn_unsettled(&self) -> bool {
        self.outbox.has_unsaved() || self.recovering || self.coverage.is_some_and(|id| self.outbox.contains(id))
    }

    /// The scheduled compaction runs (`afterCompaction`): what holds an ask back as a queued prompt.
    fn compaction_held(&self) -> bool {
        self.after_compaction.is_some()
    }

    /// Whether a completion may wake this idle thread: the session did not turn
    /// `autoWakeCompletions` off (`infrastructure.mjs:154`, default on at
    /// `runtime-core.mjs:31`) and its owner is not closing (`notification-bus.mjs:27-31`).
    fn completion_wake(&self) -> bool {
        !self.cell.closed.load(SeqCst) && self.acked.header.get(super::session_options::AUTO_WAKE_COMPLETIONS) != Some(&Value::Bool(false))
    }

    /// [`Self::start_run`] over an input row already built. `wake`: a completion wake, which
    /// continues the turn that launched the worker (`ask('', {continueTurn: true})`).
    fn start_run_with(&mut self, start: DeferredStart) {
        let DeferredStart { input, mut body, op_ref, reply, prompt, wake, retried: _, work } = start;
        // A turn ran: the thread keeps `idleEvictMs` from here on (`arm_idle_evict`).
        self.only_read = false;
        // Work a user Stop froze never runs, whichever stage resumes it (a deferred start released, a provenance read back): it
        // finishes its disposition instead.
        if let Some(sid) = self.stop_or_latched(&work) {
            return self.finish_stopped_start(work, reply, &sid);
        }
        if self.admitted_pick.as_ref().is_none_or(|(id, _)| id != &work.id) {
            self.admitted_pick = Some((work.id.clone(), self.acked.header.get("pendingRoute").cloned()));
        }
        // A kickoff (a runtime's own turn) reaches the model only: no user bubble (`submission.mjs:17-20`, `suppressDisplay`), however
        // it starts (a submit, or a Stop's requeue drained from the queue).
        if input.options.as_ref().and_then(|options| options.kickoff) == Some(true) {
            self.retry_hidden = true;
        }
        // Every turn waits here for the previous turn to land: records a failed barrier left unsaved are written again
        // first (the fresh save), and the turn starts once they land and is refused if they do not.
        if self.starts_gated() {
            let unsaved = self.outbox.has_unsaved();
            self.retry_due = unsaved;
            self.deferred_start = Some(DeferredStart { input, body, op_ref, reply, prompt, wake, retried: unsaved, work });
            return;
        }
        // Compact before a held Desktop pick takes effect, using the still-seated route.
        // Reuse the scheduled-compaction gate, so no other turn or second idle clear can
        // start on the old route while the summary is in flight.
        let cleared = std::mem::take(&mut self.idle_cleared);
        let pre_switch_compacted = self.pre_switch_compacted.as_ref() == Some(&work.id);
        use turn_ops::RouteSwitchCompaction;
        let pick = self.admitted_pick.as_ref().and_then(|(_, pick)| pick.as_ref());
        let switch = if cleared || pre_switch_compacted { RouteSwitchCompaction::NotNeeded } else { self.route_switch_compaction(pick) };
        if switch == RouteSwitchCompaction::Compact {
            self.pre_switch_compacted = Some(work.id.clone());
            self.deferred_start = Some(DeferredStart { input, body, op_ref, reply, prompt, wake, retried: false, work });
            self.run_scheduled_compaction(false);
            return;
        }
        // An idle clear here would still ask on the quota-blocked route the pick is escaping.
        if !cleared
            && !pre_switch_compacted
            && switch != RouteSwitchCompaction::QuotaBlocked
            && let Some(gate) = self.idle_gate(&input, wake)
        {
            self.deferred_start = Some(DeferredStart { input, body, op_ref, reply, prompt, wake, retried: false, work });
            self.check_idle_clear(gate);
            return;
        }
        if self.retry_provenance.is_none()
            && let Some(options) = input.options.as_ref()
            && (options.retry_failed_turn == Some(true) || options.retry_turn_id.is_some())
        {
            let retry_turn_id = options.retry_turn_id.clone().filter(|id| !id.is_empty());
            self.read_retry_provenance(DeferredStart { input, body, op_ref, reply, prompt, wake, retried: false, work }, retry_turn_id);
            return;
        }
        // A worker's turn (`SessionTurns`): its input row carries the handoff content and the
        // submission it answers, as `askSession` stamps them (`askTurns.started` submissionIds).
        let agent = self.claim_agent(wake, &mut body);
        // A routine fire's queued turn (`routine-home-turn.mjs`): its input row carries the
        // fire's content, the submission and the marker row's trigger; it starts "committed".
        let routine = self.claim_routine(wake, &input, &mut body);
        // `stampTurnHop(session, transcriptMeta)` (`ask-turn-execute.mjs:171`): the turn takes the
        // hop and bot chain of the submission that starts it; a wake carries none.
        self.cell.turn_chain.stamp(body.pointer("/meta/transcript"));
        // The input row's facts read the prompt-attachment store first; no other turn starts
        // meanwhile.
        self.pre_switch_compacted = None;
        let admitted_pick = self.admitted_pick.take().and_then(|(_, pick)| pick);
        self.starting = true;
        self.runs_begun += 1;
        self.pending_work = Some(work.clone());
        self.with_facts(body, move |read| match read {
            Ok((body, facts)) => {
                JobDone::InputFacts(Box::new(InputStart { work, admitted_pick, input, body, facts, op_ref, reply, prompt, wake, agent, routine }))
            }
            Err(error) => JobDone::InputUnread { reply, error },
        });
    }

    fn read_retry_provenance(&mut self, start: DeferredStart, retry_turn_id: Option<String>) {
        let DeferredStart { input, body, op_ref, reply, prompt, wake, retried: _, work } = start;
        let context = ModelContext {
            store: self.deps.store.clone(),
            sensitive: self.deps.sensitive.clone(),
            lanes: self.deps.lanes,
            thread: self.id.clone(),
            input: mixdog_core_api::ids::ItemId::from(String::new()),
        };
        let jobs = self.jobs_tx.clone();
        self.starting = true;
        self.pending_work = Some(work.clone());
        tokio::spawn(async move {
            let messages: Vec<Value> = context.read().await.map(|rows| rows.into_iter().map(|(_, m)| m).collect()).unwrap_or_default();
            let provenance = super::quota_lane::failed_provenance(&messages, retry_turn_id.as_deref());
            let prior = super::quota_lane::retained_retry_input(&messages)
                .filter(|retained| Some(retained.message_id.as_str()) == retry_turn_id.as_deref())
                .map(|retained| retained.prior());
            let _ = jobs.send(JobDone::RetryProvenance(Box::new(RetryWait { input, body, op_ref, reply, prompt, wake, provenance, prior, work })));
        });
    }

    fn claim_agent(&self, wake: bool, body: &mut Value) -> Option<super::control::AgentStart> {
        if wake {
            return None;
        }
        let agent = self.cell.agent_start.lock().unwrap_or_else(|p| p.into_inner()).take()?;
        body["content"] = agent.content.clone();
        let submission = &agent.turn.hooks.submission_id;
        if !submission.is_empty() {
            body["meta"]["transcript"]["submissionIds"] = json!([submission]);
        }
        Some(agent)
    }

    fn claim_routine(&self, wake: bool, input: &TurnInput, body: &mut Value) -> Option<super::control::RoutineStart> {
        if wake {
            return None;
        }
        let submission = input.options.as_ref().and_then(|options| options.client_submission_id.clone()).unwrap_or_default();
        let routine = self.cell.routine_starts.lock().unwrap_or_else(|p| p.into_inner()).remove(&submission)?;
        body["content"] = routine.content.clone();
        body["meta"]["transcript"]["submissionIds"] = json!([submission]);
        if let Some(trigger) = &routine.trigger {
            body["meta"]["transcript"]["routineTrigger"] = trigger.clone();
        }
        for (key, value) in &routine.meta {
            body["meta"]["transcript"][key] = value.clone();
        }
        if let Some(sender) = routine.sender {
            body["meta"]["transcript"]["sender"] = json!(sender);
        }
        if let Some(agent) = &routine.from_agent {
            body["meta"]["transcript"]["fromAgent"] = json!(agent);
        }
        if let Some(hop) = routine.hop {
            body["meta"]["transcript"]["hop"] = json!(hop);
        }
        if !routine.bot_chain.is_empty() {
            body["meta"]["transcript"]["botChain"] = json!(routine.bot_chain);
        }
        if let Some(room_row) = &routine.room_row {
            body["meta"]["transcript"]["roomRow"] = json!(room_row);
        }
        Some(routine)
    }

    /// A turn that does not start: its waiter hears why (never a dropped reply), and the sends that joined it hear the drop.
    /// The start's end is a busy change (`updateEntryBusy`'s `onBusyChange`): the idle clock starts over.
    fn refuse_start(&mut self, reply: Option<Effect>, error: &CoreError) {
        if let Some(Effect::Reply { op, tx, .. }) = reply {
            if let Some(op) = &op {
                self.ops.failed(op, error);
            }
            if let Some(tx) = tx {
                let _ = tx.send(Err(error.clone()));
            }
        }
        self.try_unload();
    }

    fn stamp_input_meta(&self, body: &mut Value, input: &TurnInput, submitter: Option<&Submitter>) {
        let route = super::live_end::route_meta(
            self.acked.header.get("provider").and_then(Value::as_str).unwrap_or_default(),
            self.acked.header.get("model").and_then(Value::as_str).unwrap_or_default(),
        );
        let workflow = self.acked.header.get("workflow");
        let route_agent = ["name", "id"]
            .into_iter()
            .find_map(|key| workflow.and_then(|w| w.get(key)).and_then(Value::as_str).filter(|name| !name.is_empty()))
            .map(|name| mixdog_js::js_trim(name).to_owned())
            .unwrap_or_default();
        if let Some(meta) = body.pointer_mut("/meta/transcript").and_then(Value::as_object_mut) {
            meta.entry("at").or_insert_with(|| json!(self.deps.clock.now_ms()));
            if let Some(submission) = submission_id(input) {
                meta.entry("clientSubmissionId").or_insert_with(|| json!(submission));
            }
            if let Some(submitter) = submitter.filter(|submitter| !submitter.device.is_empty()) {
                meta.entry("device").or_insert_with(|| json!(submitter.device));
            }
            meta.entry("attemptId").or_insert_with(|| json!(new_id()));
            for (key, value) in route {
                meta.entry(key).or_insert(value);
            }
            if !route_agent.is_empty() {
                meta.entry("agent").or_insert_with(|| json!(route_agent));
            }
            persisted_user_order(meta);
        }
    }

    fn mint_transcript_epoch(&mut self) {
        let named = self.projected.header.get("transcriptEpoch").and_then(Value::as_str).is_some();
        if !named || self.transcript_rewritten {
            self.transcript_rewritten = false;
            let mut set = serde_json::Map::new();
            set.insert("transcriptEpoch".into(), json!(new_id()));
            let meta = Record::Meta(MetaRecord { op: None, change: Slot::Inline(HeaderChange { set, unset: Vec::new() }) });
            self.accept_record(meta, Class::Normal, Display::None, Vec::new(), Vec::new());
        }
    }

    fn record_goal_reminder(&mut self, shown: Option<Goal>) -> Option<super::goal_reminder::GoalReminder> {
        let (goal_reminder, change) = super::goal_reminder::snapshot(
            &self.projected.header,
            shown,
            &mixdog_core_ports::ports::todo_list::list_of(&self.projected.header),
            self.deps.clock.now_ms(),
        );
        if !change.set.is_empty() || !change.unset.is_empty() {
            let meta = Record::Meta(MetaRecord { op: None, change: Slot::Inline(change) });
            self.accept_record(meta, Class::Normal, Display::None, Vec::new(), Vec::new());
        }
        goal_reminder
    }

    fn stamp_retry(&mut self, body: &mut Value) {
        if let Some(Some(provenance)) = self.retry_provenance.take() {
            body["meta"]["provenance"] = provenance;
        }
        if let Some(prior) = self.retry_prior.take() {
            body["meta"]["transcript"]["messageId"] = json!(prior.message_id);
            body["meta"]["transcript"]["previousCompletions"] = Value::Array(prior.completions);
            for (key, value) in prior.reminders {
                body["meta"][key.as_str()] = value;
            }
        }
    }

    fn announce_turn_start(&mut self, turn: &TurnId, input_body: &Value, prompt: Option<String>) {
        if let Some(run) = self.run.as_mut() {
            let body = run.journal.open();
            let rid = run.turn.as_str().to_owned();
            self.draft_push(super::turn_draft::DraftWrite::Append { rid, body }, None);
        }
        let submission_ids: Vec<String> = input_body
            .pointer("/meta/transcript/submissionIds")
            .and_then(Value::as_array)
            .map(|ids| ids.iter().filter_map(Value::as_str).filter(|id| !id.is_empty()).map(str::to_owned).collect())
            .unwrap_or_default();
        let start = TurnStart { turn_id: turn.as_str().to_owned(), started_at_ms: self.deps.clock.now_ms(), submission_ids };
        for listener in self.cell.turn_listeners() {
            listener.turn_started(start.clone());
        }
        if let Some(prompt) = prompt {
            self.persist_prompt(prompt);
        }
    }

    /// [`Self::start_run_with`] once the input row's facts are read.
    fn start_run_read(&mut self, start: InputStart, shown: Option<Goal>) {
        self.starting = false;
        let submitter = self.submitter.take();
        // A delete closed the thread meanwhile: the turn never starts, and its waiter hears so.
        if self.deleting {
            self.refuse_start(start.reply, &CoreError::ThreadClosing { thread_id: self.id.clone() });
            return;
        }
        // A Stop froze this start while its row was read: the late read finishes the cancellation and never runs the model.
        if let Some(sid) = self.stop_or_latched(&start.work) {
            return self.finish_stopped_start(start.work, start.reply, &sid);
        }
        #[cfg(any(test, feature = "test-support"))]
        self.cell.start_fence("check");
        // The start gate (`StopLatches`): the run's work is registered as running under the lock a latch from outside the actor
        // takes, so a latch either came first (the start is refused here and never runs) or sees this run and aborts it through
        // the run's own cancel, created here and handed to the run below. Nothing between this point and the spawn yields.
        let turn = TurnId::from(new_id());
        let token = CancellationToken::new();
        let cancel = mixdog_agent::cancel::Cancel::from_token(&token);
        if !self.cell.stop_latches.begin(&self.id, &turn, &start.work.identities(), &cancel) {
            let sid = self.stop_or_latched(&start.work).expect("a latched start is frozen");
            return self.finish_stopped_start(start.work, start.reply, &sid);
        }
        #[cfg(any(test, feature = "test-support"))]
        self.cell.start_fence("gate");
        let InputStart { work, admitted_pick, input, mut body, facts, op_ref, reply, prompt, wake, agent, routine } = start;
        let goal_reminder = self.record_goal_reminder(shown);
        // `bumpUsageMetricsTurnId` (`whileTurnDispatched`): the turn's usage counts under a new id.
        self.usage_incremental = false;
        let mut op_ref = op_ref;
        let value = json!({ "kind": "started", "turnId": turn });
        if let Some(op) = &mut op_ref {
            op.result = Json::try_from(value.clone()).ok();
        }
        let input_iid = mixdog_core_api::ids::ItemId::from(new_id());
        // The first submitted row is the turn's checkpoint; a wake submits none. Its key rides
        // the row's transcript metadata so the change record maps back to it (`stampCheckpoint`).
        // Every client reads the record by the submission id its prompt row carries; a start that names none has the item id as its row id.
        let checkpoint = if wake { "" } else { submission_id(&input).unwrap_or(input_iid.as_str()) };
        if !checkpoint.is_empty()
            && let Some(meta) = body.pointer_mut("/meta/transcript").and_then(Value::as_object_mut)
        {
            meta.insert("checkpointId".into(), Value::String(checkpoint.to_owned()));
        }
        self.stamp_input_meta(&mut body, &input, submitter.as_ref());
        self.sync_turn_chain();
        self.mint_transcript_epoch();
        let review = super::turn_snapshot::TurnSnapshot::new(self.deps.turn_review.clone(), self.id.as_str(), checkpoint, wake);
        self.stamp_retry(&mut body);
        let input_body = body.clone();
        let hidden = std::mem::take(&mut self.retry_hidden);
        let prompt = if hidden { None } else { prompt };
        let answer = match reply {
            Some(Effect::Reply { op, tx, .. }) => Some(Effect::Reply { op, tx, value }),
            _ => None,
        };
        let (row_effects, answer): (Vec<Effect>, _) = if hidden { (answer.into_iter().collect(), None) } else { (Vec::new(), answer) };
        let input_display = if hidden { Display::None } else { self.row_display(Some("user"), &input_body) };
        let input_row = input_row((&input_iid, &turn), op_ref, body, facts, &input, submitter.is_some(), hidden);
        let last_model = Some(input_row.clone());
        // `applyTurnContextMeta`: the turn starts with the window figures the live provider's rows give the model now.
        let window = self.deps.route_change.turn_window(&self.projected.header);
        if !window.set.is_empty() || !window.unset.is_empty() {
            self.accept_header(Some(window));
        }
        // The input row and the turn's start are one unit, so one revision shows both (`drain.mjs` `presentBatch` then `runTurn`'s
        // `set({ busy, spinner })`, one flush): a client never holds the accepted prompt's row with the session idle. The start
        // shows once durable (its waiter hears a failure), so the row shows with it, and a refused start withdraws both.
        self.outbox.begin_unit(false);
        self.accept_record(Record::Item(input_row), Class::Normal, input_display, Vec::new(), row_effects);
        // `startUsageMetricsTurn` goes out with the turn's first save (the user message's), not the debounce: a process
        // killed before that save keeps neither.
        self.accept_header(super::usage_books::turn_started(&self.projected.header));
        let started = Record::Run(RunRecord {
            rid: id(turn.as_str()),
            phase: RunPhase::Started,
            attribution: None,
            attempt: None,
            at: Some(self.deps.clock.now_ms()),
            op: None,
            detail: None,
        });
        let mut effects = vec![Effect::InputDurable];
        effects.extend(answer);
        let (input_tx, input_rx) = watch::channel(InputState::Pending);
        // A registration for the turn's life, not a job in flight.
        let jobs = self.jobs_tx.downgrade();
        let marks = self.deps.sensitive.on_marked(
            &self.id,
            Box::new(move || {
                if let Some(jobs) = jobs.upgrade() {
                    let _ = jobs.send(JobDone::SensitiveMarked);
                }
            }),
        );
        let caller_watchdog = agent.as_ref().is_some_and(|start| start.turn.caller_watchdog);
        let (agent_turn, agent) = match agent {
            Some(start) => (Some(start.turn.clone()), Some((start.turn.hooks.on_terminal_result.clone(), start.done))),
            None => (None, None),
        };
        let notice = super::prompt_notice::CarriedNotice::default();
        let mut skill_selection = None;
        let agent = match routine {
            Some(routine) => {
                skill_selection = routine.skill_selection;
                (routine.on_start)();
                Some((None, routine.done))
            }
            None => agent,
        };
        let unattended = (agent.is_some() && !caller_watchdog) || super::goal_lane::automatic(&input_body);
        let prompt_state = prompt_state(&input, submitter.as_ref(), wake);
        // The run is the busy session's running work, which a confirmed stop's abort cancels.
        let core_abort = self.hold_core().run(&token);
        #[cfg(any(test, feature = "test-support"))]
        self.ledger(format!("run:admitted:{}", work.id));
        self.deps.wakes.reset(&self.id);
        self.run = Some(RunSlot {
            journal: Default::default(),
            prompt: prompt_state.clone(),
            turn: turn.clone(),
            work,
            injected: Vec::new(),
            stop: None,
            provider: self.acked.header.get("provider").and_then(Value::as_str).unwrap_or_default().to_owned(),
            route_meta: super::live_end::route_meta(
                self.acked.header.get("provider").and_then(Value::as_str).unwrap_or_default(),
                self.acked.header.get("model").and_then(Value::as_str).unwrap_or_default(),
            ),
            input_item: input_iid.clone(),
            automatic: super::goal_lane::automatic(&input_body),
            wake,
            hidden,
            tool_calls: 0,
            cancel: cancel.clone(),
            token: token.clone(),
            input: input_tx,
            start_failed: false,
            goal_reminder: goal_reminder.as_ref().map(|reminder| reminder.revision),
            notice: notice.clone(),
            agent,
            joined: Vec::new(),
            _marks: marks,
            last_model,
            started_at: self.deps.clock.now_ms(),
            transcript: input_body.pointer("/meta/transcript").cloned().unwrap_or(Value::Null),
            live: Default::default(),
            verb: super::live_end::done_verb(self.turns_closed),
            live_call: Default::default(),
            tokens_at_start: self.stats.tokens(),
            _core_abort: core_abort,
        });
        // `onGoalTurnStarted`: the turn takes the Goal's open clock segment.
        let (goals, thread) = (self.deps.goals.clone(), self.id.clone());
        self.goal_call(Box::pin(async move { JobDone::GoalSeen(goals.turn_started(&thread).await.ok()) }));
        // `heavyRuntimeWarmupArm()` (`turn-open.mjs:22`): the runtime's first turn arms the warm;
        // `setActiveTurnCount(+1)` wakes the parked warmups.
        self.turn_prewarm_armed = !std::mem::replace(&mut self.first_turn_prewarm_done, true);
        self.deps.code_graph_prewarm.wake();
        // `beginBrowserTurn`: the browser host keeps the session's pages out of reclaim while the turn is live.
        self.deps.snapshots.turn_begun(&self.id);
        self.cell.publish_run(Some(Arc::new(ActiveRun {
            turn: turn.clone(),
            cancel: cancel.clone(),
            steers: Default::default(),
            prompt: prompt_state,
            unsaved_messages: Default::default(),
        })));
        // Told once the run reads as running: whoever finds the turn counted on its row finds it running, so no
        // listing takes the row for the settled outcome of a turn that has only begun.
        self.deps.turn_starts.turn_started(&self.id, &turn);
        // After both: a close's hide of this session is conditional on the run and the release that just changed.
        super::archive_trees::restore_at_turn_start(&self.deps, &self.id, &self.projected.header);
        let started = self.accept_record_entry(started, Class::Control, Display::None, Vec::new(), effects);
        self.outbox.end_unit();
        self.outbox.pair_with(started);
        self.announce_turn_start(&turn, &input_body, prompt);
        // `noteTurnForCacheWarm` (`ask-session.mjs:313`) runs in the run's task, below.
        let model_context = ModelContext {
            store: self.deps.store.clone(),
            sensitive: self.deps.sensitive.clone(),
            lanes: self.deps.lanes,
            thread: self.id.clone(),
            input: input_iid.clone(),
        };
        let warm = super::turn_warm::WarmNote {
            port: self.deps.warm.clone(),
            thread: self.id.clone(),
            input: super::turn_warm::warm_input(input.options.as_ref(), &input_body),
            ready: input_rx.clone(),
            context: model_context.clone(),
            cancel: token.clone(),
        };
        // The run's handle for a replay's settled signal, given to the port before the run is spawned (its tools' waits count on it).
        #[cfg(feature = "replay-settled")]
        let replay_run = mixdog_ai::transport::replay_bytes::Run::default();
        let port = RunPort {
            thread: self.id.clone(),
            turn: turn.clone(),
            tx: self.ch.prod_tx.clone(),
            input: input_rx,
            cancel: token.clone(),
            ctl: self.cell.ctl_tx.clone(),
            provider: self.acked.header.get(PROVIDER_STATE).and_then(|state| serde_json::from_value(state.clone()).ok()),
            meters: self.deps.compaction.clone(),
            meters_provider: {
                let cell = self.cell.clone();
                Arc::new(move || cell.header.load().get("provider").and_then(Value::as_str).unwrap_or_default().to_owned())
            },
            #[cfg(feature = "replay-settled")]
            replay_run: replay_run.clone(),
        };
        // A session takes moved settings gates at its next turn start (today's
        // `stageToolAvailability`).
        self.refresh_surface();
        // `admitTurnWorkspace` follows the session's live cwd, the one its header carries. The admitted turn then passes the
        // workspace gate (`prepareTurnWorkspace`) with its submission id and `promptContentText(prompt)`; `turn/start` carries
        // no `confirmLarge`.
        let admission = {
            let (admission, thread, token) = (self.deps.turn_admission.clone(), self.id.clone(), token.clone());
            let cell = self.cell.clone();
            let cwd: super::worktree::Cwd = Arc::new(move || cell.header.load().get("cwd").and_then(Value::as_str).unwrap_or_default().to_owned());
            let start = super::worktree::TurnStart {
                submission_id: submission_id(&input).unwrap_or_default().to_owned(),
                prompt: super::pending::content_text(input_body.get("content").unwrap_or(&Value::Null)),
                confirm_large: false,
            };
            async move {
                let admitted = admission.admit(thread.as_str(), cwd, &token).await?;
                admission.prepare(thread.as_str(), start, &token).await?;
                Ok::<_, mixdog_scm::error::ScmFailure>(admitted)
            }
        };
        let mut run_header = self.acked.header.clone();
        match admitted_pick {
            Some(pick) => {
                run_header.insert("pendingRoute".into(), pick);
            }
            None => {
                run_header.shift_remove("pendingRoute");
            }
        }
        let future = self.deps.runs.start(RunStart {
            prefix_guard: self.prefix_guard.clone(),
            cache_tail: self.deps.cache_tail.clone(),
            agent_turn,
            lifecycle: self.deps.lifecycle.clone(),
            skill_selection,
            goal_reminder,
            notice,
            unattended,
            verb: super::live_end::done_verb(self.turns_closed),
            thread: self.id.clone(),
            turn: turn.clone(),
            input,
            input_item: input_iid.clone(),
            input_body,
            header: run_header,
            port,
            context: model_context,
            surface: self.surface.subscribe(),
            progress: self.cell.progress.clone(),
            turn_messages: self.cell.turn_messages.clone(),
            cancel: token,
            signal: cancel.clone(),
            review: review.clone(),
            transcripts: self.deps.transcripts.clone(),
        });
        let ctl = self.cell.ctl_tx.clone();
        // A run whose task panics still ends: without its `RunEnded` the thread keeps a started run no task drives, and every
        // later prompt waits in the queue behind it.
        let (panic_ctl, panic_turn) = (ctl.clone(), turn.clone());
        let task = TurnTask {
            warm,
            hooks: self.deps.lifecycle.clone(),
            thread: self.id.clone(),
            header: self.acked.header.clone(),
            review,
            cancel: cancel.clone(),
            ctl,
            turn,
        };
        let run = guard_run(task.run(admission, future), panic_ctl, panic_turn);
        // A replay's settled signal counts the turn busy until it ends, except while it waits on the model or the user.
        #[cfg(feature = "replay-settled")]
        let run = mixdog_ai::transport::replay_bytes::in_run_as(replay_run, run);
        mixdog_rt::spawn("session-run", TaskClass::Work, run);
    }

    // ───────────── prompt history ─────────────

    fn cwd(&self) -> String {
        self.acked.header.get("cwd").and_then(Value::as_str).unwrap_or_default().to_owned()
    }
}
