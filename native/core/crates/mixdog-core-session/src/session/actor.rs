//! `SessionActor`: the one owner of a thread's state (RL §5.1). Its loop is biased: the
//! control lane first, then durability acks, then lane-job results, then the approval
//! deadline, then producers (runs and sections), then the inbox. Handlers are bounded and
//! synchronous: validate against the projected state, append to the outbox, submit the
//! record encode to cpu-interactive, never await storage or a lane.

use std::sync::Arc;
use std::sync::atomic::Ordering::SeqCst;
use std::time::Duration;

use mixdog_agent::agent_tool::flow::seams::TurnOutcome;
use mixdog_agent::agent_tool::flow::seams::TurnResult;
use mixdog_agent::agent_tool::flow::seams::TurnStart;
use mixdog_tools::exec::WakeReason;
use mixdog_app_protocol::v2::thread::HistoryResetReason;
use mixdog_app_protocol::v2::thread::ItemNotificationParams;
use mixdog_app_protocol::v2::thread::PromptRestore;
use mixdog_app_protocol::v2::thread::StorageState;
use mixdog_app_protocol::v2::thread::ThreadContext;
use mixdog_app_protocol::v2::thread::ThreadHistoryResetParams;
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
use mixdog_app_protocol::v2::thread::ThreadIdParams;
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
use mixdog_core_api::ids::ItemId;
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
use mixdog_store::schema::record::ApprovalPhase;
use mixdog_store::schema::record::ApprovalRecord;
use mixdog_store::schema::record::Base;
use mixdog_store::schema::record::CompactedDropped;
use mixdog_store::schema::record::CompactedRecord;
use mixdog_store::schema::record::ReplacementEntry;
use mixdog_store::schema::record::DequeueReason;
use mixdog_store::schema::record::Form;
use mixdog_store::schema::record::Header;
use mixdog_store::schema::record::HeaderChange;
use mixdog_store::schema::record::ItemRecord;
use mixdog_store::schema::record::Anchor;
use mixdog_store::schema::record::AmendRecord;
use mixdog_store::schema::record::MetaRecord;
use mixdog_store::schema::record::Refs;
use mixdog_store::schema::record::ModelSwitchEntry;
use mixdog_store::schema::record::ModelSwitchRecord;
use mixdog_store::schema::record::OpRef;
use mixdog_store::schema::record::QueueAction;
use mixdog_store::schema::record::QueueRecord;
use mixdog_store::schema::record::Record;
use mixdog_store::schema::record::RewindReason;
use mixdog_store::schema::record::RewindRecord;
use mixdog_store::schema::record::RunPhase;
use mixdog_store::schema::record::RunRecord;
use serde::Serialize;
use serde::de::DeserializeOwned;
use serde_json::Value;
use serde_json::json;
use tokio::sync::mpsc;
use tokio::sync::oneshot;
use tokio::sync::watch;
use mixdog_tools::policy::SessionSurface;

use super::SessionDeps;
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
use super::prompt_history;
use super::run::InputState;
use super::run::ItemCommit;
use super::run::ProducerMsg;
use super::run::RunError;
use super::run::RunShown;
use mixdog_core_goal::goal::js::Goal;
use super::run::ModelContext;
use super::user_facts::RowFacts;
use super::run::RunPort;
use super::run::DrainRequest;
use super::run::DrainStage;
use super::run::SteerInput;
use super::run::within_priority;
use super::completions;
use super::pending;
use mixdog_core_base::support::coded;
use super::stop::Facts as PromptFacts;
use super::stop::PromptState;
use super::seams::EncodedRecord;
use super::seams::Shown;
use super::seams::RunOutcome;
use super::seams::RunStart;
use super::state::Change;
use super::state::Display;
use super::state::Queued;
use mixdog_core_ports::ports::threads::Section;
use super::state::SessionState;
use super::view::SessionView;
use mixdog_core_base::approvals::ApprovalBook;
use mixdog_core_base::approvals::Lineage;
use mixdog_core_base::approvals::request_frame;
use mixdog_core_base::approvals::request_params;
use mixdog_core_base::approvals::resolved_frame;

mod compaction_reminder;
mod offload_prune;
#[cfg(test)]
pub(crate) use offload_prune::OFFLOAD_SCAN_BATCH;
mod turn_ops;

/// The header key of the session's saved provider state (Node `session.providerState`).
const PROVIDER_STATE: &str = "providerState";
/// What the desktop host throws when the runtime refuses a rename (`session-host-lifecycle.ts:228`).
const SESSION_NOT_AVAILABLE: &str = "Session is not available.";
/// What the desktop host throws for a title that is empty once normalized (`session-host-lifecycle.ts:226`).
const SESSION_TITLE_INVALID: &str = "Session title is invalid.";
/// What Node's IPC and remote methods threw for a title `sessionDisplayName` refuses (`ipc-validation.ts:1043`); with the
/// Node host gone the core is the first place a phone's rename is checked.
const TITLE_INVALID: &str = "title is invalid.";

/// How long a thread nobody ever watched may sit quiet before it unloads (`idleEvictMs` of
/// `session-service.mjs`: `MIXDOG_SESSION_IDLE_EVICT_MS`, default 5 minutes).
pub(super) const IDLE_EVICT: Duration = Duration::from_secs(5 * 60);
/// `STATUS_SETTLE_MS` (`session-status-scheduler.mjs:14`): the beat a status pass waits after its
/// first mark, here the load's.
pub(super) const STATUS_SETTLE: Duration = Duration::from_millis(16);
/// How long a route move waits for its new route's context status before it is accepted without it.
const ROUTE_STATUS_DEADLINE: Duration = Duration::from_secs(10);
/// The header keys that move the route's context window (`applyRouteContextWindow`).
const WINDOW_KEYS: [&str; 5] = ["provider", "model", "contextWindow", "compactBoundaryTokens", "autoCompactTokenLimit"];

/// `item/completed` of an item a history row shows.
fn item_completed(thread: &ThreadId, row: &ItemRecord, item: &ThreadItem) -> Note {
    Note::new(
        "item/completed",
        &ItemNotificationParams {
            thread_id: thread.clone(),
            turn_id: TurnId::from(row.turn.as_ref().map_or("", |turn| turn.as_str())),
            item: item.clone(),
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

/// A header change computed on the actor over a copy of the header as projected, awaiting its outside reads there.
pub type AwaitingHeaderUpdate =
    Box<dyn FnOnce(mixdog_store::schema::record::Header) -> futures::future::BoxFuture<'static, mixdog_store::schema::record::HeaderChange> + Send>;

/// A request routed to the actor.
pub(crate) enum Inbox {
    /// `onGoalStatusChange`: the thread's visible Goal changed.
    GoalChanged(Option<Goal>),
    /// A completion as the session's listeners receive it (`{content, meta}`): shown as a live
    /// card when the card gates admit it.
    CompletionCard { content: String, meta: Value },
    /// The setup tool's desktop request `id` (`notifySessionUi(.., { kind: 'setup-ui', id })`,
    /// taken by the session store's `setup-ui` action): the thread shows it as `setupUiRequest`
    /// until it is settled or `window` (its claim window) ends.
    SetupUiRequest { id: String, window: std::time::Duration },
    /// The desktop request `id` can no longer be claimed (claimed, or ended unclaimed).
    SetupUiSettled { id: String },
    /// `TaskNotifier`: a detached job of this thread finished.
    TaskNotification {
        surface: String,
        task_id: String,
        status: String,
        text: String,
        /// `Some(ORIGIN_CHANNEL)`: a channel notification, queued as an entry of its own
        /// (unique id, no execution) through this same path.
        origin: Option<&'static str>,
        /// The thread was loaded when the job finished (Node's owner is the runtime's live
        /// session, `notification-bus.mjs:41`); one opened for the completion is never woken.
        live: bool,
        /// Answered once the queued entry is durable (Node's `settlePendingMessageWrites` after
        /// `enqueuePendingMessage`), or once the same entry, already queued, is.
        durable: Option<oneshot::Sender<Result<(), RunError>>>,
    },
    /// The job board's activity signal: a job of this thread was added or finished
    /// (`agent_activity.rs`).
    AgentActivity,
    /// A value marked in a session whose text this thread holds reached it (`SensitiveMarks::carry`): what the thread
    /// stored goes as for a mark of its own, whether a turn runs or not.
    SensitiveCarried,
    Request {
        req: CoreRequest,
        tx: Waiter,
    },
    /// The op store of this thread's scope (`ThreadOps`): the actor is the scope's only writer.
    Op { call: super::thread_ops::OpCall, tx: Waiter },
    /// `thread/fork`: the base the new thread continues (acked end of this lineage) and the
    /// header it copies. The handle creates the thread through the directory.
    ForkPlan {
        tx: oneshot::Sender<Result<(Base, Header), CoreError>>,
    },
    /// What `scheduleQuotaResume` reads of the session.
    QuotaFacts { tx: oneshot::Sender<super::quota_lane::ResumeCheck> },
    /// `cancelQuotaResume`: the explicit cancel of the pending resume.
    QuotaCancelled { tx: oneshot::Sender<()> },
    /// `fireQuotaResume({ generation })`: the scheduler fires the queued resume of `generation`.
    QuotaResumeFire { generation: u64, tx: oneshot::Sender<Result<super::quota_resume_scheduler::FireOutcome, String>> },
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
    PushToast { text: String, tone: String, tx: oneshot::Sender<Result<(), CoreError>> },
    /// `HeaderUpdates::update_header`: `update` computes a header change on the actor, from the
    /// header as projected, and the change is written as the next record; answered once durable.
    UpdateHeader { update: mixdog_core_ports::ports::threads::HeaderUpdate, tx: Waiter },
    /// [`Inbox::UpdateHeader`] whose change awaits an outside read (a route change's skill listing): the actor awaits
    /// it with no other message handled, so every other writer queues behind it, as behind Node's one synchronous pass.
    /// The step must not call the same session's actor.
    UpdateHeaderAwaiting { update: AwaitingHeaderUpdate, tx: Waiter },
    /// A test's injected unwind of the actor.
    #[cfg(any(test, feature = "test-support"))]
    #[cfg_attr(not(test), allow(dead_code, reason = "used by this crate's unit tests; compiled for test-support so the hooks around it behave as in a test build"))]
    Unwind(UnwindAt),
    /// The end of a test's marked turn (`ControlCell::ask_marked`; Node's `markSessionDone`): the mark is cleared and
    /// the prune the turn stopped runs, as a turn's end runs it (`run_ended`).
    #[cfg(test)]
    AskEnded,
}

/// A route move waiting for its new route's context status: applied, with those figures, when the read returns.
struct PendingMove {
    seq: u64,
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
        Inbox::UpdateHeader { .. } | Inbox::UpdateHeaderAwaiting { .. } => true,
        Inbox::Request { req, .. } => req.method.as_str() == "thread/header/patch",
        _ => false,
    }
}

/// Where a test's injected unwind of the actor happens.
#[cfg(any(test, feature = "test-support"))]
pub(crate) enum UnwindAt {
    /// As the actor takes the message.
    #[cfg_attr(not(test), allow(dead_code, reason = "used by this crate's unit tests; compiled for test-support so the hooks around it behave as in a test build"))]
    Now,
    /// As the actor takes the next `Ctl::Delete`, before it answers it.
    #[cfg_attr(not(test), allow(dead_code, reason = "used by this crate's unit tests; compiled for test-support so the hooks around it behave as in a test build"))]
    Delete,
}

/// The recovered model context of a turn the process died in: the context's rows in order (kept and new), the new
/// rows to commit with their facts, and whether anything differs from what is stored.
#[derive(Default)]
pub(crate) struct Recovery {
    replacement: Vec<(ItemId, Value)>,
    new: Vec<(ItemCommit, RowFacts)>,
    changed: bool,
}

/// Results of lane jobs the actor submitted.
pub(crate) enum JobDone {
    Encoded {
        id: u64,
        generation: u64,
        /// The encoding, the live items and notes, and the record as the log stores it when that differs.
        result: Result<(EncodedRecord, Vec<Shown>, Vec<Note>, Option<Record>), CoreError>,
    },
    PromptSession { session: Vec<String>, publish: bool },
    PromptPersisted(Vec<String>),
    /// The open-time recovery of a turn the process died in has read and finalized the model context.
    Recovered { rid: String, result: Result<Recovery, String> },
    /// The recovery's records are durable (or failed): requests are served again.
    RecoveryDone(Result<(), RunError>),
    /// A prompt-history append job ended: the list as the writer saw it, and the appends that did
    /// not land (the write failed, or the lane refused or dropped the job).
    PromptFlushed { list: Option<Vec<String>>, unwritten: Vec<String> },
    /// A wait of the prompt-history appends ended.
    PromptRetryDue(u64),
    /// A toast's time ran out (pushToast's timer).
    ToastExpired(String),
    ApprovalId {
        turn: TurnId,
        ask: ApprovalAsk,
        reply: oneshot::Sender<ApprovalResolution>,
        result: Result<ApprovalId, CoreError>,
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
    GoalEntryChecked { entry: Value, seen: Option<GoalCheck> },
    /// A drain's reads for the Goal entries it would take: the drain goes on with them.
    SteerGoalsChecked {
        turn: TurnId,
        request: DrainRequest,
        reply: oneshot::Sender<Vec<SteerInput>>,
        checked: std::collections::HashMap<String, bool>,
        seen: Vec<(String, Value, Option<GoalCheck>)>,
    },
    /// `goalControl`'s answer for the request that asked.
    GoalControlled { op: Option<OpId>, tx: Waiter, result: Result<Value, mixdog_core_goal::goal::GoalError> },
    /// A run's committed row with its facts read.
    CommitFacts {
        turn: TurnId,
        item: ItemCommit,
        facts: RowFacts,
        ack: oneshot::Sender<Result<(), RunError>>,
    },
    /// A run's row whose facts could never be read (the io lane cannot run the job): the run hears it was not applied.
    CommitUnread { ack: oneshot::Sender<Result<(), RunError>>, error: CoreError },
    /// A starting turn's input row with its facts read.
    InputFacts(Box<InputStart>),
    /// A starting turn whose input row's facts could never be read: the turn does not start, and its waiter hears why.
    InputUnread { reply: Option<Effect>, error: CoreError },
    /// The failed turn's provenance read for a plain retry start.
    RetryProvenance(Box<RetryWait>),
    /// The Goal the runtime shows, read for the pending reminder the starting turn carries.
    ReminderGoal(Box<InputStart>, Option<Goal>),
    /// The quota-failed turn has nothing a resume could replay.
    QuotaUnresumable(TurnId),
    /// `agentStatusState()` read on load or after a job of this thread changed; `listener`: the
    /// status listener's read (see `read_agent_status`).
    AgentStatus { agents: mixdog_app_protocol::v2::thread::ThreadAgents, listener: bool },
    /// The context status the load's status pass read (`read_context_display`), `null` for none.
    ContextStatus(Value),
    /// The new route's context status a pending route move `seq` read ([`SessionActor::start_route_move`]); `None` when the read
    /// failed or missed its deadline.
    RouteStatus { seq: u64, status: Option<Value> },
    /// The session's live workspace (`read_live_workspace`).
    LiveWorkspace(u64, Option<Value>),
    /// The idle deadline found the thread quiet; `working`: its background work still runs.
    IdleChecked { working: bool },
    /// A turn operation's answer (`session/turn_ops.rs`) for the request that asked.
    Replied { op: Option<OpId>, tx: Waiter, result: Result<Value, CoreError> },
    /// A manual compaction ran and its PostCompact hook did: the actor re-marks the Goal reminder.
    Compacted { op: Option<OpId>, tx: Waiter, result: Value, recover: bool },
    /// A manual compaction ended (its answer follows).
    CompactionEnded,
    /// The claim window of the desktop request `id` ended.
    SetupUiExpired(String),
    /// `retainedRetryInput()` for a `turn/retryFailed` that passed its first gates.
    RetryChecked { op: Option<OpId>, tx: Waiter, key: String, retained: Option<super::quota_lane::Retained>, provenance: Option<Value> },
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
}

pub(crate) struct InputStart {
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

/// What the actor does first.
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
    },
    /// An opened log: interrupted runs and their approvals are recovered (P §5.2, §8.2); the
    /// ops its scope fenced are refused from the start (P §9.4).
    /// `ready` is told once the recovery is saved (or failed): the opener returns the thread only then.
    Open { fenced: Vec<String>, ready: oneshot::Sender<()> },
}

/// `SUBMISSION_ID_MEMORY` (`session-flow/queue.mjs`).
const SUBMISSION_MEMORY: usize = 256;

/// The submission ids the thread took and the answer each got, oldest first.
#[derive(Default)]
struct Submissions {
    order: std::collections::VecDeque<String>,
    answers: std::collections::HashMap<String, Value>,
    /// The submission whose start is reading its input row's facts (its answer is not known yet), and the retried sends of it
    /// that joined meanwhile: they hear the original's answer, as Node's memory took the id when the send was admitted.
    starting: Option<(String, Vec<Waiter>)>,
}

impl Submissions {
    fn remember(&mut self, id: &str, answer: Value) {
        if let Some((_, joined)) = self.starting.take_if(|(starting, _)| starting == id) {
            for waiter in joined {
                let _ = waiter.send(Ok(Reply::Value(answer.clone())));
            }
        }
        if self.answers.insert(id.to_owned(), answer).is_none() {
            self.order.push_back(id.to_owned());
        }
        while self.order.len() > SUBMISSION_MEMORY {
            if let Some(oldest) = self.order.pop_front() {
                self.answers.remove(&oldest);
            }
        }
    }

    fn forget(&mut self, id: &str) {
        if self.answers.remove(id).is_some() {
            self.order.retain(|kept| kept != id);
        }
    }

    /// A send of the starting submission: it waits for the original's answer. Gives the waiter back when none is starting.
    fn join(&mut self, id: &str, waiter: Waiter) -> Option<Waiter> {
        match &mut self.starting {
            Some((starting, joined)) if starting == id => {
                joined.push(waiter);
                None
            }
            _ => Some(waiter),
        }
    }

    /// The start never happened: the joined sends hear the drop, as the original's waiter does.
    fn unstarted(&mut self) {
        self.starting = None;
    }
}

/// The input row's `meta.transcript` as Node persists it (`persistedUserTranscriptMetadata`): its fields in that order, then
/// what the core adds (`clientSubmissionId`); `completionVerb` is the turn's (`beginTurn`) and is not persisted.
fn persisted_user_order(meta: &mut serde_json::Map<String, Value>) {
    const ORDER: [&str; 18] = [
        "messageId", "attemptId", "at", "modelId", "model", "provider", "agent", "sender", "device", "fromAgent", "hop", "botChain", "roomRow", "checkpointId",
        "submissionIds", "consumedExecutionIds", "attachments", "routineTrigger",
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

struct RunSlot {
    turn: TurnId,
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
    /// Tool results the turn committed (its tool cards).
    tool_calls: u64,
    cancel: mixdog_agent::cancel::Cancel,
    input: watch::Sender<InputState>,
    /// The run's input never became durable: no terminal record follows.
    start_failed: bool,
    /// A worker's turn: told the run's final result, then its outcome.
    agent: Option<(Option<Arc<dyn Fn(&TurnResult) + Send + Sync>>, oneshot::Sender<RunOutcome>)>,
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

/// `pushToast`'s default `ttlMs` (`notice-surface.mjs:10`).
const TOAST_TTL: std::time::Duration = std::time::Duration::from_millis(3000);

pub(crate) struct ActorChannels {
    pub ctl_rx: mpsc::Receiver<Ctl>,
    pub inbox_rx: mpsc::Receiver<Inbox>,
    pub prod_tx: mpsc::Sender<ProducerMsg>,
    pub prod_rx: mpsc::Receiver<ProducerMsg>,
    pub dur_tx: mpsc::Sender<ToDurability>,
    pub dur_rx: mpsc::Receiver<FromDurability>,
    /// The directory the thread unloads from.
    pub directory: std::sync::Weak<super::directory::DirInner>,
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
    lineage: Lineage,
    log_id: String,
    acked_end: u64,
    acked: SessionState,
    projected: SessionState,
    outbox: Outbox,
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
    /// `stats.turns`: the turns this thread closed with an end (`publishTurnClose`), which `pickDoneVerb` reads.
    turns_closed: usize,
    /// state.stats (usage totals), folded from each model call's usage event.
    stats: super::stats::SessionStats,
    steer_marked: Vec<QueuedId>,
    /// The context display fields a running turn published, held for the turn's end ([`Self::on_context_section`]).
    held_display: Option<ThreadContext>,
    /// What a route move read for the header it is about to write ([`Self::route_status_read`]), taken by the step that accepts the
    /// move: the new route's status, or `None` when the read failed.
    route_status: Option<Option<Value>>,
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
    /// Completions a wake drained that still wait for their own turns, oldest first.
    wake_tail: Vec<String>,
    /// A delete closed the thread (`Ctl::Delete`): no run starts again.
    deleting: bool,
    /// The thread's tombstone landed (`Ctl::Closed`).
    tombstoned: bool,
    /// The Goal a user prompt is archiving, masked from the lane until the archive lands.
    goal_suppressed: String,
    /// A continuation decision is on its way.
    goal_scheduled: bool,
    /// The Goal the lane last saw and the deadline warning it last delivered.
    goal_watch: super::goal_lane::GoalWatch,
    /// A turn ended and its settlement (`turn_settled`) is not back yet: no turn starts.
    settling: bool,
    /// A worker's settling turn: its outcome, told once the settlement is back.
    agent_done: Option<(oneshot::Sender<RunOutcome>, RunOutcome)>,
    /// A turn's input row facts are being read: it starts next, no other turn does.
    starting: bool,
    /// Who sent the prompt the next run starts on: its device, and whether the composer may take it back. Set where the
    /// prompt is admitted (`turn/start`, a queued entry that starts), read when the run's input row is built.
    submitter: Option<Submitter>,
    /// `createSubmissionMemory`: the answers of the last submissions by `clientSubmissionId`, so a retried send joins the
    /// original instead of posting the prompt twice. Memory only, as in Node.
    submissions: Submissions,
    /// A dequeued Goal entry waits on `shouldRunGoalContinuation`: no other turn starts.
    goal_checking: bool,
    /// The open-time recovery of an interrupted turn runs: requests wait for it, so the first read
    /// or turn sees the recovered conversation (Node recovers before the session is returned).
    recovering: bool,
    /// The opener waiting for the open-time recovery.
    opened: Option<oneshot::Sender<()>>,
    /// When a thread nobody ever watched, quiet since, is unloaded (Node's `idleEvictMs` deadline
    /// on the idle clock); `None` while it is not waiting for that.
    idle_evict_at: Option<tokio::time::Instant>,
    /// A continuation was asked for while that check ran; it is decided once the check is back.
    goal_deferred: bool,
    /// The last Goal runtime call: each waits for the one before.
    goal_tail: Option<tokio::task::JoinHandle<()>>,
    /// The expiry timer of each toast in the queue (`toastTimers`), by toast id: `thread/clear` and the thread's close cancel them.
    toast_timers: std::collections::HashMap<String, tokio::task::AbortHandle>,
    /// Callers released by this pump's entries ([`Effect::AfterPublish`]), told once its frames are published.
    after_publish: Vec<oneshot::Sender<Result<(), CoreError>>>,
    /// Whether [`Self::pump`] is releasing acked entries now, and the replies they released: sent once the pump has
    /// published its frames and the thread's view, so a caller that reads the thread as soon as it is answered (a reset,
    /// then the home's view; a route move's model and figures) sees what its request did. Records written as one unit are
    /// released in one pump, the answer with the records it follows.
    releasing: bool,
    replies_after_publish: Vec<(Waiter, Value)>,
    /// The surfaced tool calls running now (`createActiveToolTracker`'s `activeToolCalls`), by call id: category, count and start.
    active_calls: std::collections::BTreeMap<String, (&'static str, i64, i64)>,
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
    /// A closing thread asked the durability task to write the units kept from a failed write.
    flush_sent: bool,
    published_storage: StorageState,
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
    /// The next run's input row is already on screen (a retained retry's `suppressDisplay`).
    retry_hidden: bool,
    /// The transcript was rewritten (a compaction, a rewind, a clear, a restarted context) since its lineage
    /// was named: the next turn names a new one (`mintTranscriptEpoch`, `turn-checkpoint.mjs`).
    transcript_rewritten: bool,
    /// A compaction's prune a running turn stopped: it runs once that turn has ended (`offload_prune`).
    prune_deferred: bool,
    /// The failed turn's provenance a retry row carries as `meta.provenance` (`retryProvenance`,
    /// `ask-session.mjs:199`, `ask-turn-execute.mjs:27-34`); taken by the next turn start like `retry_hidden`.
    /// `None`: not read yet (a plain `turn/start` carrying the retry flags reads it first);
    /// `Some(None)`: the failed turn has none.
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

fn invalid(path: &str, expected: &str) -> CoreError {
    CoreError::InvalidParams {
        path: path.into(),
        expected: expected.into(),
    }
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

/// `promptDisplayText` (`queue-helpers.mjs:89`), trimmed: the display text the options give when it is not blank, else the
/// prompt's text parts.
fn display_text(input: &TurnInput) -> String {
    let given = input.options.as_ref().and_then(|options| options.display_text.as_deref()).filter(|text| !mixdog_js::js_trim(text).is_empty());
    mixdog_js::js_trim(given.map_or_else(|| prompt_text(input), str::to_owned).as_str()).to_owned()
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
        let text = serde_json::from_value::<PromptContent>(queued.entry["message"].clone())
            .map(|prompt| prompt_text(&TurnInput { prompt, options: None }))
            .unwrap_or_default();
        let files = queued.entry["message"]
            .as_array()
            .map(|parts| parts.iter().filter(|part| part["type"] == "file").cloned().collect())
            .unwrap_or_default();
        Self {
            id: queued.qid.clone(),
            text,
            pasted_images: queued.entry.pointer("/options/pastedImages").cloned(),
            pasted_texts: queued.entry.pointer("/options/pastedTexts").cloned(),
            files,
        }
    }
}

/// The entries `restoreQueued(_, selectedId)` takes: the one named, or every one without a name.
pub(super) fn restore_taken(queue: &[Queued], selected: Option<&str>) -> Vec<Queued> {
    queue.iter().filter(|queued| selected.is_none_or(|qid| queued.qid == qid)).cloned().collect()
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

/// `restoreQueued`'s reply (`take-entries.mjs`), before the attachments are read: the taken
/// entries' text joined with the composer's, each part only when it is not blank, the pasted maps
/// merged as queued, and the `file` parts as `content`. The handle reads the attachment references
/// into the maps and the parts (`restore_hydrate`), which is where `notice` comes from.
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
#[cfg(test)]
#[allow(clippy::disallowed_methods, clippy::disallowed_types, reason = "test setup")]
mod restored_reply_tests {
    use base64::Engine;
    use base64::engine::general_purpose::STANDARD;

    use super::super::restore_hydrate::hydrate;
    use super::super::user_facts::AttachmentStore;
    use super::*;

    fn queued(entry: &Value) -> Queued {
        let message = if entry.get("content").is_some() { entry["content"].clone() } else { entry["text"].clone() };
        let mut body = json!({ "message": message });
        let mut options = serde_json::Map::new();
        for key in ["pastedImages", "pastedTexts"] {
            if let Some(value) = entry.get(key) {
                options.insert(key.into(), value.clone());
            }
        }
        if !options.is_empty() {
            body["options"] = Value::Object(options);
        }
        Queued { qid: entry["id"].as_str().unwrap().to_owned(), entry: body, display: Value::Null }
    }

    #[tokio::test]
    async fn the_recorded_node_restores_are_reproduced() {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/desktop/queue/restore-queued-twin.json");
        let twin: Value = serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap();
        let dir = tempfile::tempdir().unwrap();
        for (reference, data) in twin["blobs"].as_object().unwrap() {
            let folder = dir.path().join("prompt-attachments/sha256").join(&reference[..2]);
            std::fs::create_dir_all(&folder).unwrap();
            std::fs::write(folder.join(reference), STANDARD.decode(data.as_str().unwrap()).unwrap()).unwrap();
        }
        let store = AttachmentStore(dir.path().to_path_buf());
        let tokens = mixdog_rt::testing::tokens();
        let cases = twin["cases"].as_array().unwrap();
        assert_eq!(cases.len(), 13);
        for case in cases {
            let name = case["name"].as_str().unwrap();
            let queue: Vec<Queued> = case["entries"].as_array().unwrap().iter().map(queued).collect();
            let selected = case["selectedId"].as_str().filter(|id| !id.is_empty());
            let current = case["currentText"].as_str().filter(|text| !text.is_empty());
            let taken: Vec<Taken> = restore_taken(&queue, selected).iter().map(Taken::of).collect();
            let reply = restored_reply(&taken, current);
            let store = store.clone();
            let hydrated = mixdog_core_base::support::on_lane(tokens.interactive_io, &CancellationToken::new(), move |lane| hydrate(&store, lane, reply))
                .await
                .unwrap()
                .unwrap();
            assert_eq!(hydrated, case["reply"], "{name}");
            let left: Vec<&str> = queue.iter().filter(|q| !taken.iter().any(|t| t.id == q.qid)).map(|q| q.qid.as_str()).collect();
            assert_eq!(json!(left), case["left"], "{name}: what stays queued");
        }
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
        let (jobs_tx, jobs_rx) = mpsc::unbounded_channel();
        let goal_watch = super::goal_lane::GoalWatch::new(state.sections.goal.as_ref());
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
            epoch,
            seq: 0,
            lineage,
            log_id,
            acked_end,
            projected: state.clone(),
            acked: state,
            book: ApprovalBook::default(),
            ops: OpTable::default(),
            run: None,
            first_turn_prewarm_done: false,
            room_questions_moved: false,
            room_approvals_resolved: Vec::new(),
            turn_prewarm_armed: false,
            live_workspace_reads: 0,
            turns_closed: 0,
            stats: Default::default(),
            steer_marked: Vec::new(),
            held_display: None,
            route_status: None,
            route_move: None,
            route_queue: Default::default(),
            route_moves: 0,
            cards: Default::default(),
            listened: Default::default(),
            suppressed: Default::default(),
            wake_tail: Vec::new(),
            deleting: false,
            tombstoned: false,
            goal_suppressed: String::new(),
            goal_scheduled: false,
            settling: false,
            agent_done: None,
            starting: false,
            submitter: None,
            submissions: Submissions::default(),
            goal_checking: false,
            recovering: false,
            opened: None,
            idle_evict_at: None,
            goal_deferred: false,
            goal_tail: None,
            toast_timers: std::collections::HashMap::new(),
            after_publish: Vec::new(),
            releasing: false,
            replies_after_publish: Vec::new(),
            active_calls: std::collections::BTreeMap::new(),
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
            flush_sent: false,
            published_storage: StorageState::Ok,
            ch,
            jobs_tx,
            jobs_rx,
            quota: super::quota_lane::QuotaLane::new(&deps.quota),
            retry_claim: String::new(),
            quota_pending: None,
            quota_answered: None,
            compactions: 0,
            retry_hidden: false,
            transcript_rewritten: false,
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
        let mut created_at = None;
        match init {
            Init::Create { session, tx, value, seed, settings } => {
                self.seed = seed;
                self.uncreated = true;
                created_at = settings;
                self.accept_record(
                    session,
                    Class::Normal,
                    Display::None,
                    Vec::new(),
                    vec![Effect::Reply {
                        op: None,
                        tx,
                        value,
                    }],
                );
            }
            Init::Open { fenced, ready } => {
                for op in fenced {
                    self.ops.fence(&OpId::from(op)).expect("a loading actor has seen no op");
                }
                self.opened = Some(ready);
                self.recover();
                if !self.recovering {
                    self.recovery_ended();
                }
            }
        }
        // The session is installed (created or resumed): `syncSessionCompaction` (`boot/infrastructure.mjs`).
        self.sync_compaction();
        self.seed_route_config();
        self.deps.runtime_hooks.started(&self.id);
        self.load_persisted_prompts();
        self.pump();
        // A thread opened for a caller that never attaches a feed (a worker, a headless run) has
        // no last unsubscribe to unload it: it starts on the idle clock.
        self.arm_idle_evict();
        // `applyResolvedCwd` of the opened session's cwd (`resume.mjs:158`): unchanged.
        self.cwd_applied(false);
        // The runtime's status pass is registered dirty and runs once at load, one settle beat
        // later (`session-status-scheduler.mjs` `register`), publishing the agent status it reads.
        // There is no periodic pass: Node dropped the 2 s pulse for change marks (858b0b2d2), and
        // the marks that move agent status are the status listener's signals.
        if let Some(agents) = self.agents_with_scope() {
            self.accept_view(Change::Section(Section::Agents(agents)), Vec::new());
        }
        self.read_agent_status(false);
        self.reconcile_offloads();
        self.read_context_display();
        self.read_live_workspace();
        let mut settings = created_at.or_else(|| self.deps.compaction.settings_changes(&self.id).map(SettingsFollow::begin));
        loop {
            let deadline = self.book.next_deadline();
            let producers_open = self.outbox.producer_room();
            let marking = self.delete_closed.is_none() && self.delete_mark.is_some();
            tokio::select! {
                biased;
                // First: a write announces before it answers, so a read sent after the answer sees the change counted.
                Some(announced) = settings_changed(&mut settings) => self.on_settings_changed(announced),
                Some(ctl) = self.ch.ctl_rx.recv() => self.on_ctl(ctl),
                go = mark_go(&mut self.delete_mark), if marking => self.mark_deleted(go.ok()),
                Some(msg) = self.ch.dur_rx.recv() => self.on_durability(msg),
                Some(done) = self.jobs_rx.recv() => match done {
                    JobDone::PruneListed(candidates, told) => self.prune_listed(candidates, told).await,
                    done => self.on_job(done),
                },
                _ = sleep_until(deadline), if deadline.is_some() => self.on_deadline(),
                _ = sleep_until(self.idle_evict_at), if self.idle_evict_at.is_some() => self.on_idle_evict(),
                Some(msg) = self.ch.prod_rx.recv(), if producers_open => self.on_producer(msg),
                Some(msg) = self.ch.inbox_rx.recv(), if !self.recovering => self.take_inbox(msg).await,
                else => break,
            }
            // The header writes a finished route move held, in order, until one of them starts the next move.
            while self.route_move.is_none()
                && let Some(msg) = self.route_queue.pop_front()
            {
                self.take_inbox(msg).await;
            }
            self.pump();
            if let Some(follow) = &settings {
                follow.shown();
            }
            self.cell.turn_held.store(self.ask_lock_held(), SeqCst);
            self.cell.turn_pending.store(self.turn_pending(), SeqCst);
            self.cell.ui_busy.store(self.ui_busy(), SeqCst);
            self.cell.compacting.store(self.compactions > 0, SeqCst);
            #[cfg(any(test, feature = "test-support"))]
            {
                self.cell.busy.store(self.turn_busy(), SeqCst);
                self.cell.unacked.store(self.outbox.unacked(), SeqCst);
                self.cell.stepped.notify_waiters();
            }
            // A closing thread writes the units kept from a failed write now (Node's exit drain writes what is queued), once
            // per failure: a write that fails again keeps them, and the thread with them.
            if self.cell.closed.load(SeqCst) && !self.flush_sent && self.outbox.has_retained() {
                self.flush_sent = self.ch.dur_tx.try_send(ToDurability::Flush { generation: self.generation }).is_ok();
            }
            // An unloaded thread stops once its accepted records are handed off; a deleted one
            // also waits for its turn to end and its mark.
            if self.cell.closed.load(SeqCst)
                && self.outbox.is_empty()
                && self.delete_closed.is_none()
                && self.delete_mark.is_none()
            {
                break;
            }
        }
        // `dispose` (`dispose.mjs:23`).
        self.cancel_toast_timers();
        self.deps.runtime_hooks.stopped(&self.id);
        self.deps.snapshots.runtime_stopped(&self.id);
        // `settlePersistence`: the close lands the buffered gateway usage events (and their compaction)
        // without holding the close.
        let usage = self.deps.gateway_usage.clone();
        tokio::spawn(async move { usage.settle().await });
    }

    /// `Ctl::Delete`: see its doc.
    fn delete(
        &mut self,
        abort: &mixdog_agent::cancel::Abort,
        idle: bool,
        guard: Option<super::control::DeleteGuard>,
        closed: oneshot::Sender<Result<(), &'static str>>,
        mark: oneshot::Receiver<serde_json::Map<String, Value>>,
        marked: oneshot::Sender<Result<(), RunError>>,
    ) {
        #[cfg(any(test, feature = "test-support"))]
        if self.unwind_at_delete {
            panic!("the test's injected unwind at a delete");
        }
        // Another delete holds the thread: it is gone for this one.
        if self.deleting {
            let _ = closed.send(Err("missing"));
            return;
        }
        // A guarded delete reads the admission word first and closes it from exactly that value:
        // an attach after this point, even one that detaches again, refuses the close.
        let mut seen = None;
        if let Some(guard) = guard {
            let word = self.cell.admission();
            let moved = super::sub_agent_retention::activity_at(&self.cell.header.load()) != guard.activity;
            let peers_changed = self.ch.directory.upgrade().is_none_or(|directory| directory.peers_changed(&guard.peers, guard.opens));
            if word != 0 || guard.cancel.is_cancelled() || moved || self.turn_busy() || !self.projected.queue.is_empty() || peers_changed {
                let _ = closed.send(Err("changed"));
                return;
            }
            seen = Some(word);
        }
        if idle {
            let refusal = if self.turn_pending() {
                Some("turn-waiting")
            } else if self.turn_held() {
                Some("busy")
            } else if !self.projected.queue.is_empty() {
                Some("queued")
            } else {
                None
            };
            if let Some(refusal) = refusal {
                let _ = closed.send(Err(refusal));
                return;
            }
        }
        // The same word an attach transitions, so exactly one of the two wins.
        match seen {
            Some(word) if !self.cell.close_if_unchanged(word) => {
                let _ = closed.send(Err("changed"));
                return;
            }
            Some(_) => {}
            None => self.cell.close(),
        }
        self.deleting = true;
        (self.delete_closed, self.delete_mark, self.delete_marked) = (Some(closed), Some(mark), Some(marked));
        if let Some(run) = &self.run {
            // The deleted session leaves the approvals list now, not when its turn ends.
            let turn = run.turn.clone();
            let at = self.deps.clock.now_ms();
            for aid in self.book.take_run(&turn) {
                // The run's token fires right below: it must see `interrupted`, not the cancel.
                let interrupted = ApprovalResolution::Interrupted { at };
                self.book.answer(aid, &interrupted);
                self.resolve(aid, &turn, interrupted);
            }
            if let Some(run) = &self.run {
                run.cancel.abort_with(abort);
            }
            return;
        }
        self.delete_turn_ended();
    }

    /// The deleted thread's turn ended (or it had none).
    fn delete_turn_ended(&mut self) {
        if let Some(closed) = self.delete_closed.take() {
            let _ = closed.send(Ok(()));
        }
    }

    /// The header change the delete asked for (FORMAT.md §5.1 `meta`: the delete mark
    /// `deleted: true`, or an idle close's tombstone), acked to `delete_marked`;
    /// `None`: the delete gave up, the thread stops unmarked.
    fn mark_deleted(&mut self, go: Option<serde_json::Map<String, Value>>) {
        self.delete_mark = None;
        let Some(marked) = self.delete_marked.take() else { return };
        let Some(set) = go else {
            return;
        };
        let meta = Record::Meta(MetaRecord { op: None, change: Slot::Inline(HeaderChange { set, unset: Vec::new() }) });
        self.accept_record(meta, Class::Control, Display::None, Vec::new(), vec![Effect::ItemAck(marked)]);
    }

    /// Unloads when the last subscriber has left and nothing is live: no run, no queued
    /// input, no pending approval. The memory ingest fires without waiting (today's
    /// `void ingestSessionIntoMemory(session)` when the CLI closes a session).
    fn try_unload(&mut self) {
        if !self.quiet() {
            return;
        }
        // Nobody ever attached: there is no last unsubscribe, so the idle clock decides; a
        // closed thread unloads at once (`_clearSessionRuntime`).
        if !self.cell.ever_attached() && !self.tombstoned {
            self.arm_idle_evict();
            return;
        }
        self.unload();
    }

    /// Nothing is live: not deleting or settling, no run, no queued input, no pending approval,
    /// no feed subscriber.
    fn quiet(&self) -> bool {
        !(self.deleting
            || self.settling
            || self.starting
            || self.goal_checking
            || self.cell.attached() != 0
            || self.run.is_some()
            || !self.projected.queue.is_empty()
            || !self.projected.approvals.is_empty())
    }

    /// `applyResolvedCwd`'s code-graph warm (`cwd-apply.mjs:85-90`): none in lazy mode before the
    /// runtime's first turn armed its own; otherwise at once for a changed folder, after the
    /// configured delay for the same one.
    fn cwd_applied(&self, changed: bool) {
        let prewarm = &self.deps.code_graph_prewarm;
        if prewarm.lazy() && !self.first_turn_prewarm_done {
            return;
        }
        if changed {
            prewarm.schedule(Some(std::time::Duration::ZERO), "cwd-change");
        } else {
            prewarm.schedule(None, "cwd");
        }
    }

    /// `turn.armHeavyRuntimeWarmup('first-visible')` on visible output (text, reasoning, a tool):
    /// the first turn's warm, once.
    fn visible_progress(&mut self) {
        if std::mem::take(&mut self.turn_prewarm_armed) {
            self.deps.code_graph_prewarm.schedule(Some(std::time::Duration::ZERO), "first-visible");
        }
    }

    /// The idle clock of a thread nobody watched starts over.
    fn arm_idle_evict(&mut self) {
        self.idle_evict_at = (!self.cell.ever_attached()).then(|| tokio::time::Instant::now() + IDLE_EVICT);
    }

    /// The idle deadline came: a thread found working waits the whole delay again. Working is
    /// also background work the thread started that still runs (`idle-clock.mjs` `working`:
    /// `hasActiveBackgroundTasks({ callerSessionId })`, any surface), read before the unload.
    fn on_idle_evict(&mut self) {
        self.idle_evict_at = None;
        if !self.quiet() {
            self.arm_idle_evict();
            return;
        }
        let (jobs, work, thread) = (self.jobs_tx.clone(), self.deps.work.clone(), self.id.clone());
        tokio::spawn(async move {
            let working = work.has_active(thread.as_str(), "agent", false, None).await || work.has_active(thread.as_str(), "shell", false, None).await;
            let _ = jobs.send(JobDone::IdleChecked { working });
        });
    }

    /// The idle deadline's background-work read answered. A clock armed again meanwhile (the
    /// thread went quiet once more) is the newer one.
    fn idle_checked(&mut self, working: bool) {
        if self.idle_evict_at.is_some() {
            return;
        }
        if working || !self.quiet() {
            self.arm_idle_evict();
        } else {
            self.unload();
        }
    }

    fn unload(&mut self) {
        let Some(directory) = self.ch.directory.upgrade() else {
            return;
        };
        directory.unload(&self.id, &self.cell, self.close_ingest());
    }

    /// Today's `ingestSessionIntoMemory(session)` over the model context, each message through the sensitive projection:
    /// the memory database is written to disk, so a sensitive value goes there as its marker. Node passes the loaded
    /// session's own messages (`memory-ingest.mjs:18`) and so writes the value itself into the memory database; fixed on
    /// both sides (`redactSensitiveMessages(session.id, messages)`).
    fn close_ingest(&self) -> futures::future::BoxFuture<'static, ()> {
        let context = ModelContext {
            store: self.deps.store.clone(),
            sensitive: self.deps.sensitive.clone(),
            lanes: self.deps.lanes,
            thread: self.id.clone(),
            input: mixdog_core_api::ids::ItemId::from(String::new()),
        };
        let memory = self.deps.memory.clone();
        let cwd = self.cwd();
        if super::session_options::memory_off(&self.projected.header) {
            return Box::pin(async {});
        }
        Box::pin(async move {
            let Ok(rows) = context.read().await else {
                return;
            };
            let messages: Vec<Value> = rows.into_iter().map(|(_, body)| body).collect();
            let messages = context.sensitive.redacted(&context.thread, &messages);
            memory.ingest(&context.thread, &cwd, messages).await;
        })
    }

    // ───────────── accept, encode, hand off, release ─────────────

    /// Applies `change` to the projected state and appends it to the outbox; a durable record
    /// goes to cpu-interactive for its encode.
    fn accept_record(
        &mut self,
        record: Record,
        class: Class,
        display: Display,
        notes: Vec<Note>,
        effects: Vec<Effect>,
    ) {
        self.accept_record_entry(record, class, display, notes, effects);
    }

    /// [`Self::accept_record`], answering the outbox entry the record took, for a view that stands on it
    /// ([`Self::accept_view_after`]).
    fn accept_record_entry(
        &mut self,
        record: Record,
        class: Class,
        display: Display,
        notes: Vec<Note>,
        effects: Vec<Effect>,
    ) -> u64 {
        let record = Arc::new(record);
        let shown = !matches!(display, Display::Suppressed);
        // The session's route moved (`provider`/`model` of the header): its state follows, as Node's route state does.
        let moved = |keys: &[&str]| match &*record {
            Record::Meta(MetaRecord { change: Slot::Inline(change), .. }) => keys
                .iter()
                .any(|key| change.set.get(*key).is_some_and(|value| self.projected.header.get(*key) != Some(value)) || (change.unset.iter().any(|unset| unset.as_str() == *key) && self.projected.header.contains_key(*key))),
            _ => false,
        };
        // A workspace transition moves the runtime's cwd (routeState's `cwd`); its workspace record the transition publishes.
        let window_moved = moved(&WINDOW_KEYS);
        // A pick held for the next turn is the runtime's route at once (the state's provider, model, effort and contextPercent).
        let held_moved = moved(&["pendingRoute"]);
        let route_moved = moved(&["provider", "model"]) || moved(&["cwd"]) || held_moved;
        let window_before = (self.projected.header.get("contextWindow").cloned(), self.projected.header.get("rawContextWindow").cloned());
        let change = Change::Record {
            record: record.clone(),
            display,
        };
        self.projected.apply(&change, None);
        let entry = self
            .outbox
            .push(Some((record.clone(), class)), change, notes, effects);
        self.submit_encode(entry, record, shown);
        // A route move read its new figures before this step (`syncContextStats` before `publishRoute`, routes-write.mjs:133-142):
        // they go out with it, ahead of the route, so no state shows the new model with the old figures.
        let figures = match self.route_status.take().filter(|_| window_moved) {
            Some(Some(status)) => Some(self.display_figures(&status)),
            Some(None) => Some(self.unread_figures(&window_before)),
            None => None,
        };
        if window_moved || held_moved {
            // The context section's settled figures follow the header (the seated window and limits, the held pick's percent); the
            // frame carries the whole section.
            let context = figures.clone().unwrap_or_default();
            self.accept_view_after(Some(entry), Change::Section(Section::Context(context)), Vec::new(), Vec::new());
        }
        if route_moved {
            // The route's own values (`autoClear` is the provider's) are read under the new provider; the frame carries the whole route.
            let route = self.deps.compaction.route_config(&self.projected.header);
            self.accept_view_after(Some(entry), Change::Section(Section::Route(route)), Vec::new(), Vec::new());
        }
        if window_moved {
            // A route change marks the status pass (`syncContextStats` of the next pulse) unless the move read it already; a seated
            // route makes the session the agent status's scope.
            if figures.is_none() {
                self.read_context_display();
            }
            if let Some(agents) = self.agents_with_scope() {
                self.accept_view_after(Some(entry), Change::Section(Section::Agents(agents)), Vec::new(), Vec::new());
            }
            self.read_agent_status(false);
        }
        entry
    }

    /// A header change the run's usage reports make, as one meta record; nothing when it changes nothing.
    fn accept_header(&mut self, change: Option<HeaderChange>) {
        if let Some(change) = change {
            let meta = Record::Meta(MetaRecord { op: None, change: Slot::Inline(change) });
            self.accept_record(meta, Class::Normal, Display::None, Vec::new(), Vec::new());
        }
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
        let generation = self.generation;
        let thread = self.id.clone();
        // The open turn's `completionVerb`, which its live rows carry.
        let verb = self.run.as_ref().map(|slot| slot.verb);
        let turn = self.run.as_ref().map(|slot| slot.transcript.clone());
        let at = self.deps.clock.now_ms();
        // A full cpu lane is waited out: the record is a row of the thread, never dropped for a busy lane.
        let encode = move |lane: &mixdog_rt::InLane<mixdog_rt::CpuInteractive>| {
            // The log holds the record as the sensitive projection stores it; the live rows show it as committed.
            let stored = deps.sensitive.stored(&thread, &record);
            let result = deps.codec.encode(lane, stored.as_ref().unwrap_or(&record)).map(|encoded| {
                let Record::Item(row) = &*record else {
                    return (encoded, Vec::new(), Vec::new());
                };
                if !shown {
                    return (encoded, Vec::new(), Vec::new());
                }
                // The final reply's completion restores as a `done` end in history; live, the turn's close shows its
                // own end ([`Self::close_done`]), so this one is not shown.
                let shown: Vec<Shown> = deps
                    .transcript
                    .items(lane, row)
                    .into_iter()
                    .filter(|shown| !matches!(shown, Shown::Item(ThreadItem::TurnEnd { status: mixdog_protocol::TurnEndStatus::Done, .. })))
                    .map(|shown| {
                        let (attempt, raw) = match &row.body {
                            mixdog_store::schema::blob::Slot::Inline(body) => (body.pointer("/meta/transcript/attemptId").and_then(Value::as_str), body.get("content").and_then(Value::as_str)),
                            _ => (None, None),
                        };
                        match shown {
                            Shown::Item(item) => Shown::Item(super::live_end::live_form(item, attempt, verb, turn.as_ref(), raw, at)),
                            Shown::Update(item) => Shown::Update(super::live_end::live_form(item, attempt, verb, turn.as_ref(), raw, at)),
                        }
                    })
                    .collect();
                // An update's frame carries the merged item: it is built at release.
                let notes = shown
                    .iter()
                    .filter_map(|shown| match shown {
                        Shown::Item(item) if row.visible => Some(item_completed(&thread, row, item)),
                        _ => None,
                    })
                    .collect();
                (encoded, shown, notes)
            });
            result.map(|(encoded, shown, notes)| (encoded, shown, notes, stored))
        };
        mixdog_core_base::support::lane_job(self.deps.lanes.cpu, "record-encode", encode, move |result| {
            let _ = jobs.send(JobDone::Encoded {
                id: entry,
                generation,
                result: result.and_then(|encoded| encoded),
            });
        });
    }

    fn on_job(&mut self, done: JobDone) {
        match done {
            JobDone::Encoded {
                id,
                generation,
                result,
            } => {
                if generation != self.generation {
                    return;
                }
                match result {
                    Ok((encoded, shown, notes, stored)) => {
                        if let Some(entry) = self.outbox.get_mut(id) {
                            if let Change::Record { display, .. } = &mut entry.change
                                && !shown.is_empty()
                            {
                                *display = Display::Items(shown);
                            }
                            entry.notes.extend(notes);
                        }
                        self.outbox.encoded(id, encoded, stored);
                    }
                    Err(error) => {
                        // The unit goes whole: none of a request's records is written without the rest.
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
            // A list computed off the actor can land after a mark that its rows predate: it takes the marks here.
            JobDone::PromptSession { session, publish } => {
                let session = self.redacted_session_prompts(&session);
                self.accept_view(Change::PromptSession { session, publish }, Vec::new())
            }
            JobDone::PromptPersisted(persisted) => {
                let persisted = self.redacted_prompts(&persisted);
                self.accept_view(Change::PromptPersisted(persisted), Vec::new())
            }
            JobDone::PromptFlushed { list, unwritten } => {
                if let Some(list) = list {
                    let list = self.redacted_prompts(&list);
                    self.accept_view(Change::PromptPersisted(list), Vec::new());
                }
                let next = self.prompt_appends.flushed(unwritten);
                self.run_prompt_step(next);
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
            JobDone::ApprovalId {
                turn,
                ask,
                reply,
                result,
            } => self.approval_id(turn, ask, reply, result),
            // Today's `ingestSessionTurn(turn.session)` on a mark (`ask-turn-state.mjs:104`):
            // the search rows get a replacement under the new version, once what the turn
            // committed so far is durable.
            JobDone::SensitiveMarked => {
                self.redact_prompts();
                if self.run.is_some() {
                    let ack = self.ingest_when_durable();
                    self.outbox.push(None, Change::Barrier, Vec::new(), vec![Effect::ItemAck(ack)]);
                }
            }
            JobDone::GoalSeen(Some(goal)) => {
                self.publish_goal(goal);
            }
            JobDone::GoalSettled(goal) => {
                // The turn is settled: queued work runs first, then an active Goal continues
                // once the thread is idle (`onGoalTurnSettled`).
                self.settling = false;
                if let Some((done, outcome)) = self.agent_done.take() {
                    let _ = done.send(outcome);
                }
                self.finish_quota_settlement(goal.clone().flatten().as_ref());
                let active = goal.and_then(|goal| self.publish_goal(goal)).is_some_and(|goal| goal_lane_status(&goal) == "active");
                if self.deleting {
                    return;
                }
                self.start_next_queued();
                if active {
                    self.schedule_goal_continuation();
                }
                self.try_unload();
            }
            JobDone::GoalSeen(None) => {}
            JobDone::CommitFacts { turn, item, facts, ack } => self.commit_with_facts(turn, item, facts, ack),
            JobDone::Recovered { rid, result } => self.recovered(rid, result),
            JobDone::RecoveryDone(done) => {
                if let Err(error) = done {
                    tracing::warn!("[session] the recovered turn of {} could not be saved: {error:?}", self.id.as_str());
                }
                self.recovery_ended();
            }
            JobDone::CommitUnread { ack, error } => {
                tracing::warn!(thread = %self.id, "a run's row was not committed: its facts could not be read ({error:?})");
                let _ = ack.send(Err(RunError::NotApplied));
            }
            JobDone::InputUnread { reply, error } => {
                tracing::warn!(thread = %self.id, "a turn did not start: its input row's facts could not be read ({error:?})");
                self.starting = false;
                self.submitter = None;
                self.retry_provenance = None;
                self.retry_prior = None;
                self.refuse_start(reply, &error);
            }
            JobDone::InputFacts(start) => {
                // `snapshotPendingGoalReminder` reads the Goal at request preparation, after the
                // earlier Goal calls of this thread.
                let (goals, thread) = (self.deps.goals.clone(), self.id.clone());
                self.goal_call(Box::pin(async move {
                    let goal = goals.stored_goal(&thread).await.ok().flatten();
                    JobDone::ReminderGoal(start, goal)
                }));
            }
            JobDone::ReminderGoal(start, goal) => self.start_run_read(*start, goal),
            JobDone::RetryProvenance(wait) => {
                let RetryWait { input, body, op_ref, reply, prompt, wake, provenance, prior } = *wait;
                self.starting = false;
                // A delete closed the thread meanwhile: the turn never starts, and its waiter hears so.
                if self.deleting {
                    self.refuse_start(reply, &CoreError::ThreadClosing { thread_id: self.id.clone() });
                    return;
                }
                self.retry_provenance = Some(provenance);
                self.retry_prior = prior;
                self.start_run_with(input, body, op_ref, reply, prompt, wake);
            }
            JobDone::Replied { op, tx, result } => self.replied(op, tx, result),
            JobDone::Compacted { op, tx, result, recover } => self.compacted(op, tx, result, recover),
            JobDone::CompactionEnded => self.compactions = self.compactions.saturating_sub(1),
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
            JobDone::ContextStatus(status) => self.context_display(&status),
            JobDone::RouteStatus { seq, status } => self.route_status_read(seq, status),
            JobDone::LiveWorkspace(read, workspace) => {
                if read == self.live_workspace_reads
                    && !self.tombstoned && !self.cell.closed.load(SeqCst) && self.projected.sections.workspace != workspace {
                    self.accept_view(Change::Section(Section::Workspace(workspace)), Vec::new());
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

    // ───────────── the Goal lane ─────────────

    /// Runs a Goal runtime call after every earlier one of this thread (Node awaits each in
    /// turn order); its answer comes back as a job.
    fn goal_call(&mut self, call: futures::future::BoxFuture<'static, JobDone>) {
        let jobs = self.jobs_tx.clone();
        let tail = self.goal_tail.take();
        self.goal_tail = Some(
            tokio::spawn(async move {
                if let Some(tail) = tail {
                    let _ = tail.await;
                }
                let _ = jobs.send(call.await);
            }),
        );
    }

    /// `publishGoal(raw)`: the lane changes only when the visible Goal does.
    fn publish_goal(&mut self, raw: Option<Goal>) -> Option<Goal> {
        let goal = super::goal_lane::visible_goal(raw.as_ref(), &self.goal_suppressed);
        let value = goal.clone().map(Value::Object);
        if self.projected.sections.goal != value {
            self.accept_view(Change::Section(Section::Goal(value)), Vec::new());
        }
        goal
    }

    /// `refreshGoalState`: the lane reads the runtime's visible Goal.
    fn refresh_goal(&mut self) {
        let (goals, thread) = (self.deps.goals.clone(), self.id.clone());
        self.goal_call(Box::pin(async move { JobDone::GoalSeen(goals.goal_status(&thread).await.ok()) }));
    }

    /// `cancelQueuedGoalContinuations({ keepCloseoutFor })`: the queued Goal entries leave the
    /// queue, except the closeout of `keep` (a Goal that reached its duration), which stays with
    /// that Goal's text now. How many went.
    fn cancel_goal_entries(&mut self, keep: Option<&Goal>) -> usize {
        let queued: Vec<(String, Value)> = self
            .projected
            .queue
            .iter()
            .filter(|q| super::goal_lane::is_goal_entry(&q.entry))
            .map(|q| (q.qid.clone(), q.entry.clone()))
            .collect();
        let mut removed = 0;
        for (qid, entry) in queued {
            if let Some(text) = super::goal_lane::kept_closeout_text(&entry, keep) {
                if entry.get("message").and_then(Value::as_str) != Some(text.as_str()) {
                    // `entry.content = goalDeadlineReached(..)`: the entry takes the text where
                    // it stands.
                    let mut entry = entry;
                    entry["message"] = Value::String(text);
                    let record = Record::Queue(QueueRecord {
                        qid: id(&qid),
                        action: QueueAction::Update,
                        reason: None,
                        op: None,
                        entry: Some(Slot::Inline(entry)),
                    });
                    self.accept_record(record, Class::Control, Display::None, Vec::new(), Vec::new());
                }
                continue;
            }
            self.accept_record(dequeue(&qid), Class::Control, Display::None, Vec::new(), Vec::new());
            removed += 1;
        }
        removed
    }

    /// A Goal entry joins the queue (`enqueue` of the Goal lane).
    fn enqueue_goal_entry(&mut self, entry: Value) {
        let record = Record::Queue(QueueRecord {
            qid: id(&new_id()),
            action: QueueAction::Enqueue,
            reason: None,
            op: None,
            entry: Some(Slot::Inline(entry)),
        });
        self.accept_record(record, Class::Normal, Display::None, Vec::new(), Vec::new());
    }

    /// `onGoalChanged`: the lane shows the new Goal, queued automatic work for the old one goes,
    /// the deadline notices are delivered, and an active Goal continues once the thread is idle.
    fn goal_changed(&mut self, raw: Option<Goal>) {
        let visible = super::goal_lane::visible_goal(raw.as_ref(), &self.goal_suppressed);
        // Deadline notices tell the model the time used now, so they read the unmasked record.
        let timed = visible.as_ref().and(raw.as_ref());
        let reached = self.goal_watch.observe(visible.as_ref());
        self.cancel_goal_entries(visible.as_ref());
        self.publish_goal(raw.clone());
        self.deliver_goal_warning(timed);
        if reached {
            self.deliver_goal_closeout(timed);
        }
        if visible.is_some_and(|goal| goal_lane_status(&goal) == "active") {
            self.schedule_goal_continuation();
        }
    }

    /// `deliverGoalDeadlineWarning`: behind a running turn the notice rides the queue as a
    /// prompt the loop attaches; an idle thread only marks the reminder.
    fn deliver_goal_warning(&mut self, timed: Option<&Goal>) {
        let Some(text) = self.goal_watch.warning(timed) else { return };
        let Some(goal) = timed else { return };
        if self.ui_busy() {
            let entry = super::goal_lane::warning_entry(&text, goal, self.deps.clock.now_ms());
            self.enqueue_goal_entry(entry);
        } else {
            self.mark_goal_reminder("deadline-soon");
        }
    }

    /// `markGoalReminder(reason)` (`goal-facade-api.mjs`): the session's pending Goal reminder
    /// (`markPendingGoalReminder`: one more revision, the next turn's tail carries it), then the
    /// next continuation carries the full rules again.
    fn mark_goal_reminder(&mut self, reason: &str) {
        let change = super::goal_reminder::mark(&self.projected.header, reason, self.deps.clock.now_ms());
        let meta = Record::Meta(MetaRecord { op: None, change: Slot::Inline(change) });
        self.accept_record(meta, Class::Normal, Display::None, Vec::new(), Vec::new());
        super::goal_lane::mark_goal_reminder(&*self.deps.goals, &self.id);
    }

    /// `deliverGoalCloseout`: the Goal reached its duration; the running turn closes it out.
    fn deliver_goal_closeout(&mut self, timed: Option<&Goal>) {
        if self.deleting || self.cell.closed.load(SeqCst) {
            return;
        }
        let Some(goal) = timed else { return };
        let busy = self.ui_busy();
        let queue: Vec<&Value> = self.projected.queue.iter().map(|q| &q.entry).collect();
        match super::goal_lane::closeout(goal, busy, &queue, self.deps.clock.now_ms()) {
            super::goal_lane::Closeout::Remind => self.mark_goal_reminder("deadline-reached"),
            super::goal_lane::Closeout::Enqueue(entry) => {
                self.enqueue_goal_entry(entry);
                self.start_next_queued();
            }
        }
    }

    /// `goalControl`: the answer, then what the session API does after a pause or stop (queued
    /// automatic work goes, the running turn is cancelled) and the lane reads the Goal again.
    fn goal_controlled(&mut self, op: Option<OpId>, tx: Waiter, result: Result<Value, mixdog_core_goal::goal::GoalError>) {
        let value = match result {
            Ok(value) => value,
            Err(error) => {
                let error = super::goal_lane::failure(&error);
                if let Some(op) = &op {
                    self.ops.failed(op, &error);
                }
                let _ = tx.send(Err(error));
                return;
            }
        };
        match value.get("action").and_then(Value::as_str) {
            Some("edit") => self.mark_goal_reminder("objective-updated"),
            Some("pause" | "stop") => {
                self.cancel_goal_entries(None);
                if let Some(run) = &self.run {
                    let _ = self.cell.abort(&run.turn, &mixdog_agent::cancel::Abort::abort_session_turn(self.id.as_str(), "user-cancel"));
                }
            }
            _ => {}
        }
        self.refresh_goal();
        self.effect_done(Effect::Reply { op, tx: Some(tx), value });
    }

    /// `scheduleGoalContinuation`: once the thread is idle with nothing queued, the runtime
    /// decides whether its Goal continues.
    fn schedule_goal_continuation(&mut self) {
        // Node's `setImmediate` runs after the drain's synchronous check of a dequeued Goal entry.
        if self.goal_checking {
            self.goal_deferred = true;
            return;
        }
        if self.goal_scheduled || !self.goal_idle() {
            return;
        }
        self.goal_scheduled = true;
        let (deps, thread) = (self.deps.clone(), self.id.clone());
        self.goal_call(Box::pin(async move {
            let input = super::goal_lane::continuation_input(&*deps.todos, &*deps.work, &deps.cycles, &thread).await;
            JobDone::GoalDecision(deps.goals.continuation(&thread, input).await.ok())
        }));
    }

    /// Idle with nothing queued: queued user work runs first, and a queued Goal entry already
    /// carries the next continuation.
    fn goal_idle(&self) -> bool {
        !self.turn_busy()
            && self.projected.queue.is_empty()
            && !self.deleting
            && !self.tombstoned
            && !self.cell.closed.load(SeqCst)
    }

    /// The continuation decision: an active Goal's prompt is queued as the next turn.
    fn goal_decision(&mut self, decision: Option<mixdog_core_goal::goal::Continuation>) {
        self.goal_scheduled = false;
        let Some(decision) = decision else { return };
        self.publish_goal(decision.goal.clone());
        let prompt = decision.prompt.as_deref().map(mixdog_js::js_trim).unwrap_or_default();
        if !decision.run || prompt.is_empty() || !self.goal_idle() {
            return;
        }
        let entry = super::goal_lane::continuation_entry(decision.prompt.as_deref().unwrap_or_default(), decision.goal.as_ref(), self.deps.clock.now_ms());
        self.enqueue_goal_entry(entry);
        self.start_next_queued();
    }

    /// `archiveCompletedGoalOnUserInput`: a genuine user prompt drops queued automatic work and
    /// retires a finished Goal, masked from the lane until the archive lands.
    fn archive_goal_on_user_input(&mut self) {
        let removed = self.cancel_goal_entries(None);
        let reached = self.projected.sections.goal.as_ref().and_then(|g| g.get("status")).and_then(Value::as_str) == Some("duration_reached");
        if removed > 0 && reached {
            self.mark_goal_reminder("deadline-reached");
        }
        let archived = super::goal_lane::archived_goal_id(self.projected.sections.goal.as_ref());
        if !archived.is_empty() {
            self.goal_suppressed = archived.clone();
            self.publish_goal(None);
        }
        let (goals, thread) = (self.deps.goals.clone(), self.id.clone());
        self.goal_call(Box::pin(async move {
            if let Err(error) = goals.archive_completed_on_user_input(&thread).await {
                tracing::warn!("the completed Goal was not archived on user input: {error:?}");
            }
            JobDone::GoalArchived(archived)
        }));
    }

    /// Hands encoded records to the durability task in order, releases what is ready, and
    /// publishes the released frames and the storage state.
    fn pump(&mut self) {
        for unit in self.outbox.handoff(self.ch.dur_tx.capacity()) {
            let msg = ToDurability::Append {
                generation: self.generation,
                retain: unit.retain,
                records: unit.records,
            };
            // Never more than the channel holds is handed off, so a refusal is a durability task that is gone.
            if self.ch.dur_tx.try_send(msg).is_err() {
                self.fail_all(CoreError::StorageIndeterminate {
                    scope: "thread".into(),
                });
                return;
            }
        }
        let mut notes = Vec::new();
        self.releasing = true;
        while let Some((entry, ordinal)) = self.outbox.pop_ready() {
            self.release(entry, ordinal, &mut notes);
        }
        self.releasing = false;
        let storage = self.storage();
        if storage != self.published_storage {
            self.published_storage = storage;
            notes.push(self.runtime_note());
        }
        if !notes.is_empty() {
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

    fn storage(&self) -> StorageState {
        if self.indeterminate {
            StorageState::Indeterminate
        } else if self.pending {
            StorageState::DurabilityPending
        } else {
            StorageState::Ok
        }
    }

    fn release(&mut self, entry: Entry, ordinal: Option<u64>, notes: &mut Vec<Note>) {
        let title = self.acked.sections.title.clone();
        let prompts = self.acked.prompt_history.clone();
        let queue_rows = self.acked.queued_rows();
        let asked = |acked: &SessionState| acked.sections.approvals.as_ref().and_then(|approvals| approvals.handoff_questions.clone());
        let asked_before = asked(&self.acked);
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
        if let Change::Record { record, display } = &entry.change
            && let (Record::Item(row), Display::Items(shown)) = (&**record, display)
        {
            for shown in shown {
                match shown {
                    Shown::Item(item) => {
                        self.track_active_tool(item);
                        if let Some(ordinal) = ordinal
                            && let Some(projected) = self
                                .projected
                                .window
                                .iter_mut()
                                .find(|projected| projected.item.id() == item.id())
                        {
                            projected.ordinal = Some(ordinal);
                        }
                    }
                    Shown::Update(update) => {
                        self.track_active_tool(update);
                        if let Some(merged) = self.acked.shown_for(update) {
                            notes.push(item_completed(&self.id, row, &merged));
                        }
                    }
                }
            }
        }
        if let Change::Record { record, .. } = &entry.change
            && matches!(**record, Record::Meta(_) | Record::Session(_))
        {
            self.cell.header.store(Arc::new(self.acked.header.clone()));
            self.refresh_surface();
            // `sessionRecords.onChange`: this session's stored record changed.
            self.deps.agent_signals.session_record(self.id.as_str());
        }
        notes.extend(entry.notes);
        self.derived_notes(&entry.change, &title, &queue_rows, notes);
        if let Some(change) = prompt_history::change(&prompts, &self.acked.prompt_history) {
            notes.push(Note::new(
                "thread/promptHistory/updated",
                &ThreadSectionParams {
                    thread_id: self.id.clone(),
                    value: change,
                },
            ));
        }
        for effect in entry.effects {
            self.effect_done(effect);
        }
    }

    fn derived_notes(
        &self,
        change: &Change,
        title_before: &Option<String>,
        queue_before: &[Value],
        notes: &mut Vec<Note>,
    ) {
        let thread = &self.id;
        match change {
            Change::Record { record, .. } => match &**record {
                Record::Run(run) => {
                    if let Some(turn) = turn_of(run) {
                        let method = if run.phase == RunPhase::Started {
                            "turn/started"
                        } else {
                            "turn/completed"
                        };
                        notes.push(Note::new(
                            method,
                            &TurnNotificationParams {
                                thread_id: thread.clone(),
                                turn,
                            },
                        ));
                        if run.phase != RunPhase::Started {
                            notes.push(self.runtime_note());
                        }
                    }
                }
                // An entry edited where it stands changes no row of the queue, and a queued completion or notification is no row of it:
                // Node publishes `queued` only when it changes (`isQueuedEntryVisible`, `drain-enqueue.mjs`).
                Record::Queue(queue) if queue.action != QueueAction::Update && self.acked.queued_rows() != queue_before => {
                    notes.push(Note::new(
                        "thread/queue/changed",
                        &ThreadQueueChangedParams {
                            thread_id: thread.clone(),
                            queued: self.acked.queued_rows(),
                        },
                    ));
                }
                Record::Approval(approval) if approval.phase != ApprovalPhase::Requested => {
                    notes.push(self.section_note(&Section::Approvals(
                        self.acked.sections.approvals.clone().unwrap_or_default(),
                    )));
                }
                Record::Meta(_) | Record::Session(_) => {
                    // `toolMode` is runtime state (Node's `runtime.toolMode`), moved by `thread/setToolMode` in the header.
                    if let Record::Meta(meta) = &**record
                        && let mixdog_store::schema::blob::Slot::Inline(header) = &meta.change
                        && header.set.contains_key("toolMode")
                    {
                        notes.push(self.runtime_note());
                    }
                    if self.acked.sections.title != *title_before
                        && let Some(title) = &self.acked.sections.title
                    {
                        notes.push(Note::new(
                            "thread/name/updated",
                            &ThreadNameUpdatedParams {
                                thread_id: thread.clone(),
                                title: title.clone(),
                            },
                        ));
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
            Note::new(
                method,
                &ThreadSectionParams {
                    thread_id: thread.clone(),
                    value,
                },
            )
        }
        let t = &self.id;
        match section {
            Section::Runtime(_) | Section::ProgressHint(_) | Section::SpinnerQuiet(_) | Section::Toasts(_) | Section::ActiveTools(_) | Section::SetupChanged(_) => self.runtime_note(),
            Section::Route(_) => note("thread/route/updated", t, self.acked.route()),
            Section::Context(_) => note("thread/context/updated", t, self.acked.context()),
            Section::Todo(v) => note("thread/todo/updated", t, v),
            Section::Goal(Some(v)) => Note::new(
                "thread/goal/updated",
                &ThreadValueParams {
                    thread_id: t.clone(),
                    value: v.clone(),
                },
            ),
            Section::Goal(None) => Note::new(
                "thread/goal/cleared",
                &ThreadIdParams {
                    thread_id: t.clone(),
                },
            ),
            Section::QuotaResume(v) => note("thread/quotaResume/updated", t, v),
            Section::Agents(v) => note("thread/agents/updated", t, v),
            Section::ShellJobs(v) => note("thread/shellJobs/updated", t, v),
            Section::Workflow(v) => note("thread/workflow/updated", t, v),
            Section::Workspace(v) => note("thread/workspace/updated", t, v),
            Section::Approvals(v) => note("thread/approvals/updated", t, v),
            Section::PromptRestore(v) => note("thread/promptRestore", t, v),
            Section::ProviderAccount(v) => note("thread/providerAccount/changed", t, v),
            Section::Remote(v) => note("thread/remote/updated", t, v),
            Section::SetupUiRequest(v) => note("thread/setupUiRequest/updated", t, v),
            Section::RoomView(v) => note("thread/roomView/updated", t, v),
        }
    }

    fn runtime_note(&self) -> Note {
        Note::new(
            "thread/runtime/updated",
            &ThreadSectionParams {
                thread_id: self.id.clone(),
                value: self.acked.runtime(self.storage()),
            },
        )
    }

    fn effect_done(&mut self, effect: Effect) {
        match effect {
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
            Effect::ItemAck(tx) => {
                let _ = tx.send(Ok(()));
            }
            Effect::PublishApproval(request) => {
                self.deps.server_requests.publish(request);
            }
            Effect::Resolved(aid, resolution) => {
                self.book.resolved(aid, &resolution);
                self.deps
                    .server_requests
                    .resolved(&aid.request_id(), resolved_frame(&self.id, aid, &resolution));
            }
            Effect::RecomputePrompts { publish } => self.recompute_prompts(publish),
            // The failed end is in the acked window, where the settlement reads it; the Goal settles after.
            Effect::TurnClosed { turn, settle } => {
                self.begin_quota_settlement(&turn);
                self.settle_goal(settle);
            }
            Effect::AfterPublish(tx) => self.after_publish.push(tx),
            Effect::Decided(_) => {}
        }
    }

    fn fail_entry(&mut self, entry: Entry, error: &CoreError) {
        #[cfg(any(test, feature = "test-support"))]
        if let Some(durable) = &entry.durable {
            self.outbox.note_failed(durable, format!("{error:?}"));
        }
        // A queued prompt whose record was not stored is removed and its id forgotten, and the sender hears a refusal
        // (`drain-enqueue.mjs:64`, a failed durable mirror), so a retry is a new submission.
        let mut refused = None;
        if let Change::Record { record, .. } = &entry.change
            && let Record::Queue(queue) = &**record
            && queue.action == QueueAction::Enqueue
        {
            if let Some(Slot::Inline(queued)) = &queue.entry
                && let Some(submission) = queued.pointer("/options/clientSubmissionId").and_then(Value::as_str)
            {
                self.submissions.forget(mixdog_js::js_trim(submission));
            }
            refused = Some(coded("session", SUBMIT_REFUSED, "The message could not be saved, so it was not sent."));
        }
        let error = refused.as_ref().unwrap_or(error);
        for effect in entry.effects {
            match effect {
                Effect::Reply { op, tx, .. } => {
                    // A failed `session` record: the thread is not created, the seed is abandoned, and the thread ends here: the
                    // actor releases its own slot (the create's caller may be gone, cancelled) and stops once its outbox is empty.
                    self.seed = None;
                    if std::mem::take(&mut self.uncreated) && let Some(directory) = self.ch.directory.upgrade() {
                        directory.release(&self.id, &self.cell);
                    }
                    if let Some(op) = &op {
                        self.ops.failed(op, error);
                    }
                    if let Some(tx) = tx {
                        let _ = tx.send(Err(error.clone()));
                    }
                }
                Effect::InputDurable => {
                    if let Some(run) = &mut self.run {
                        run.start_failed = true;
                        run.input.send_replace(InputState::Failed);
                        run.cancel.abort_default();
                    }
                }
                Effect::ItemAck(tx) => {
                    let _ = tx.send(Err(RunError::NotApplied));
                }
                Effect::PublishApproval(request) => {
                    if let Some(aid) = mixdog_core_base::approvals::parse_id(&request.id) {
                        self.book.forget(aid);
                    }
                }
                Effect::Resolved(aid, _) => self.book.unresolve(aid),
                Effect::RecomputePrompts { .. } => {}
                // The failed turn's completion could not be recorded, so its end was not shown and its quota stops
                // unsettled: the Goal still settles, and the failure is reported, not skipped.
                Effect::TurnClosed { turn, settle } => {
                    tracing::error!("the failed turn {} was not recorded, so its end is not shown and its quota is not settled: {error:?}", turn.as_str());
                    self.settle_goal(settle);
                }
                // Its change was never shown: the waiter learns the failure that dropped it.
                Effect::AfterPublish(tx) => {
                    let _ = tx.send(Err(error.clone()));
                }
                Effect::Decided(_) => {}
            }
        }
    }

    /// A barrier failed: nothing after the acked state is applied (RL §6.1). A conditional header patch behind the
    /// record that failed was decided against a header that never landed: its caller hears `conflict` with the header
    /// as it holds and computes it again, as Node's write accepted behind a failed one runs on what that one did.
    fn fail_all(&mut self, error: CoreError) {
        for (index, entry) in self.outbox.fail_all().into_iter().enumerate() {
            let decided = entry.effects.iter().find_map(|effect| match effect {
                Effect::Decided(keys) => Some(keys.clone()),
                _ => None,
            });
            match decided {
                Some(keys) if index > 0 => {
                    let current: serde_json::Map<String, Value> =
                        keys.into_iter().map(|key| (key.clone(), self.acked.header.get(&key).cloned().unwrap_or(Value::Null))).collect();
                    for effect in entry.effects {
                        if let Effect::Reply { tx: Some(tx), .. } = effect {
                            let _ = tx.send(Ok(Reply::Value(json!({ "conflict": current }))));
                        }
                    }
                }
                _ => self.fail_entry(entry, &error),
            }
        }
        self.generation += 1;
        self.projected = self.acked.clone();
    }

    /// A rolled-back write kept the units `retained` for the next write (as Node's recorder keeps a failed batch's bytes):
    /// their records stay queued, in order, and land with it; their requests hear the failure now, once. Everything else
    /// unreleased fails as in [`Self::fail_all`]. Nothing of a kept unit is shown until it lands.
    fn fail_all_but(&mut self, retained: Vec<u64>, error: CoreError) {
        let retained: std::collections::HashSet<u64> = retained.into_iter().collect();
        for entry in self.outbox.fail_all_but(&retained) {
            self.fail_entry(entry, &error);
        }
        let ids: Vec<u64> = retained.iter().copied().collect();
        for id in ids {
            let Some(entry) = self.outbox.get_mut(id) else { continue };
            let (told, kept): (Vec<Effect>, Vec<Effect>) =
                std::mem::take(&mut entry.effects).into_iter().partition(|effect| matches!(effect, Effect::Reply { .. }));
            entry.effects = kept;
            for effect in told {
                if let Effect::Reply { op, tx, .. } = effect {
                    if let Some(op) = &op {
                        self.ops.failed(op, &error);
                    }
                    if let Some(tx) = tx {
                        let _ = tx.send(Err(error.clone()));
                    }
                }
            }
        }
        self.generation += 1;
        self.flush_sent = false;
        self.rebuild_projected();
    }

    fn rebuild_projected(&mut self) {
        let mut projected = self.acked.clone();
        for change in self.outbox.changes() {
            projected.apply(change, None);
        }
        self.projected = projected;
    }

    fn publish(&mut self, notes: Vec<Note>) {
        let start = self.seq + 1;
        let frames: Vec<FeedFrame> = notes
            .iter()
            .enumerate()
            .map(|(i, note)| {
                let seq = start + i as u64;
                FeedFrame {
                    seq,
                    bytes: frame(note, &self.feed_id, &self.epoch, seq),
                }
            })
            .collect();
        self.seq += frames.len() as u64;
        let view = Arc::new(self.view());
        // The actor is the feed's only producer and assigns contiguous seqs.
        let _ = self.feed.publish(&frames, Some(view.clone()));
        self.cell.view.store(view);
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
        SessionView::build(
            self.feed_id.clone(),
            self.deps.transcript.summary(&self.id, &self.acked.header),
            &self.acked,
            self.storage(),
            None,
        )
    }

    /// The control cell follows the projected state.
    fn publish_cell(&self) {
        let queued: std::collections::HashSet<String> =
            self.projected.queue.iter().map(|q| q.qid.clone()).collect();
        if **self.cell.queued.load() != queued {
            self.cell.queued.store(Arc::new(queued));
        }
        if **self.cell.queue.load() != self.projected.queue {
            self.cell.queue.store(Arc::new(self.projected.queue.clone()));
        }
        let approvals: std::collections::HashSet<u64> =
            self.book.decidable().into_iter().map(|aid| aid.0).collect();
        if **self.cell.approvals.load() != approvals {
            self.cell.approvals.store(Arc::new(approvals));
            // `onSessionApprovalWaitChange`: the wait this session's turn holds changed.
            self.deps.agent_signals.approval_wait(self.id.as_str());
        }
        let takeover = super::secret_input::takeover_hold(self.book.open_asks());
        if **self.cell.takeover.load() != takeover {
            self.cell.takeover.store(Arc::new(takeover));
        }
        let shown = self.book.shown();
        if self.cell.shown_approval.load().as_ref().map(|request| request.id) != shown.map(|request| request.id) {
            self.cell.shown_approval.store(shown.cloned().map(Arc::new));
        }
    }

    // ───────────── durability ─────────────

    fn on_durability(&mut self, msg: FromDurability) {
        match msg {
            FromDurability::Acked {
                generation,
                ordinals,
            } => {
                if generation != self.generation {
                    return;
                }
                self.indeterminate = false;
                for (id, ordinal) in ordinals {
                    self.outbox.acked(id, ordinal);
                }
            }
            FromDurability::Failed { generation, error, retained } => {
                if generation != self.generation {
                    return;
                }
                self.deps.notices.save_failed();
                let error = match error {
                    super::seams::BarrierError::Failed { io_kind } => CoreError::BarrierFailed {
                        scope: "thread".into(),
                        io_kind,
                    },
                    super::seams::BarrierError::Indeterminate { .. } => {
                        self.indeterminate = true;
                        CoreError::StorageIndeterminate {
                            scope: "thread".into(),
                        }
                    }
                };
                if retained.is_empty() {
                    self.fail_all(error);
                } else {
                    self.fail_all_but(retained, error);
                }
            }
            FromDurability::Pending(pending) => self.pending = pending,
            FromDurability::Retried(result) => self.indeterminate = result.is_err(),
            FromDurability::Redacted => {}
        }
    }

    // ───────────── control lane ─────────────

    fn on_ctl(&mut self, ctl: Ctl) {
        match ctl {
            Ctl::Approval { turn, ask, reply } => {
                if !self.active(&turn) {
                    let _ = reply.send(ApprovalResolution::Cancelled {
                        at: self.deps.clock.now_ms(),
                    });
                    return;
                }
                // A session with no approval surface asks nobody (Node's headless runtime has
                // no `toolApprovalHook`).
                if super::session_options::approval_implicit(&self.acked.header) {
                    let _ = reply.send(ApprovalResolution::Unavailable {
                        at: self.deps.clock.now_ms(),
                    });
                    return;
                }
                // A tool asks only after the turn produced output (`approveToolRequest` commits the prompt).
                self.prompt_committed();
                self.request_approval(turn, ask, reply);
            }
            Ctl::Abort { turn } => {
                if self.run.as_ref().is_some_and(|run| run.turn == turn) {
                    let now = self.deps.clock.now_ms();
                    for aid in self.book.take_run(&turn) {
                        let interrupted = ApprovalResolution::Interrupted { at: now };
                        self.book.answer(aid, &interrupted);
                        self.resolve(aid, &turn, interrupted);
                    }
                }
            }
            Ctl::Prioritize { queued } => {
                self.prioritize(&queued);
                if let Some(active) = self.cell.run.load_full() {
                    let mut steers = active
                        .steers
                        .lock()
                        .unwrap_or_else(|poisoned| poisoned.into_inner());
                    for queued in steers.drain(..) {
                        if !self.steer_marked.contains(&queued) {
                            self.steer_marked.push(queued);
                        }
                    }
                }
            }
            Ctl::Decide(decision, arbitrated) => {
                let device = self.deps.devices.describe(decision.connection);
                let at = self.deps.clock.now_ms();
                let shown = self.cell.shown_approval.load_full();
                // A refused remote Allow is not taken: the approval stays pending and the answer is told it lost (a response, as a
                // late one, gets nothing).
                let refused =
                    super::approval_notification::refuses_remote_allow(decision.origin, shown.as_deref(), &decision.request, &decision.result);
                let outcome = match (!refused).then(|| self.book.validate(&decision.request, &decision.result, device, at)) {
                    Some(Ok(Some(accepted))) => {
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
                    (None, Err(error)) => self
                        .deps
                        .server_requests
                        .response_rejected(decision.connection, error),
                    (None, Ok(_)) => {}
                }
            }
            Ctl::RunEnded { turn, outcome } => self.run_ended(turn, outcome),
            Ctl::RetryStorage => {
                let _ = self.ch.dur_tx.try_send(ToDurability::Retry);
            }
            Ctl::RefreshSurface => self.refresh_surface(),
            Ctl::CwdApplied { changed } => self.cwd_applied(changed),
            Ctl::Unsubscribed => self.try_unload(),
            Ctl::Closed(taken) => {
                self.tombstoned = true;
                self.try_unload();
                let _ = taken.send(());
            }
            Ctl::Delete { abort, idle, guard, closed, mark, marked } => self.delete(&abort, idle, guard, closed, mark, marked),
            Ctl::Shutdown(done) => {
                self.cell.close();
                if let Some(run) = &self.run {
                    // Teardown's `quiesce('cli-exit')`.
                    run.cancel.abort_with(&mixdog_agent::cancel::Abort::runtime_close(self.id.as_str(), "cli-exit"));
                }
                let _ = done.send(self.close_ingest());
            }
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
            ApprovalResolution::Decided { device, .. } => {
                (ApprovalPhase::Decided, Text::try_from(device.as_str()).ok())
            }
            _ => (ApprovalPhase::Decided, None),
        };
        let record = Record::Approval(ApprovalRecord {
            aid: id(&aid.0.to_string()),
            rid: id(rid.as_str()),
            phase,
            by_client,
            at: self.deps.clock.now_ms(),
            op: None,
            body: Some(Slot::Inline(
                serde_json::to_value(&resolution).expect("protocol types serialize"),
            )),
        });
        self.accept_record(
            record,
            Class::Control,
            Display::None,
            Vec::new(),
            vec![Effect::Resolved(aid, resolution)],
        );
    }

    fn on_deadline(&mut self) {
        let now = tokio::time::Instant::now();
        let at = self.deps.clock.now_ms();
        for (aid, rid) in self.book.expired(now) {
            self.resolve(aid, &rid, ApprovalResolution::TimedOut { at });
        }
    }

    fn run_ended(&mut self, turn: TurnId, outcome: RunOutcome) {
        // The loop reads the control lane before the producer lane, so the end can overtake output the
        // run sent before it (a delta has no ack). Node's stream callback arms the warm
        // (`ask-callbacks.mjs:55`) synchronously, before the turn settles (`turn-settle.mjs`), so what the run
        // said is applied first.
        while let Ok(msg) = self.ch.prod_rx.try_recv() {
            self.on_producer(msg);
        }
        let Some(mut slot) = self.run.take_if(|run| run.turn == turn) else {
            return;
        };
        self.cell.publish_run(None);
        // A stop that handed the prompt back (`reclaimInFlightPrompt`): it leaves the prompt history, another device's
        // composer is told, and the cancelled turn shows no end.
        let reclaimed = slot.prompt.take_reclaim().filter(|_| matches!(outcome, RunOutcome::Interrupted));
        if let Some(reclaim) = &reclaimed {
            self.apply_reclaim(reclaim);
        }
        // The display fields the turn waited to publish (`on_context_section`): a cancelled turn drops them.
        if let Some(held) = self.held_display.take()
            && !matches!(outcome, RunOutcome::Interrupted)
        {
            self.accept_view(Change::Section(Section::Context(held)), Vec::new());
        }
        // `setActiveTurnCount(-1)`: the parked warmups re-check.
        self.turn_prewarm_armed = false;
        self.deps.code_graph_prewarm.wake();
        self.deps.code_graph_prewarm.turn_settled();
        // An ended turn has no working messages left (`liveTurnMessages` ends with the turn).
        self.cell.turn_messages.send_replace(Default::default());
        self.steer_marked.clear();
        // `settleTurn`'s `releaseWorkspace()`: every settled turn, whatever its outcome, starts
        // the removal of the snapshots it made, without waiting for it.
        self.deps.snapshots.turn_settled(&self.id);
        // `completeTurn`'s `setSession(mgr.getSession(...))` (`turn-settle.mjs:38`) re-installs the session through
        // `adoptSession`, whose `syncSessionCompaction` drops the resolved buffer the pre-send checks wrote and
        // follows the saved settings: a completed turn only.
        if matches!(outcome, RunOutcome::Completed(_)) {
            self.sync_compaction();
        }
        {
            let provider = slot.provider.as_str();
            match &outcome {
                RunOutcome::Completed(_) => self.deps.notices.turn_completed(provider),
                RunOutcome::Failed(error) => self.deps.notices.turn_failed(provider, error.provider_error.as_ref().map(|detail| detail.kind.as_str())),
                RunOutcome::Interrupted => {}
            }
        }
        // `onTurnSettled`: the run host's final result as it is, for a finished turn only.
        let settled = TurnOutcome {
            turn_id: turn.as_str().to_owned(),
            done: matches!(outcome, RunOutcome::Completed(_)),
            result: match &outcome {
                RunOutcome::Completed(result) => Some((**result).clone()),
                _ => None,
            },
            stalled: matches!(&outcome, RunOutcome::Failed(error) if mixdog_agent::agent_tool::watchdog::is_watchdog_abort(&error.message)),
        };
        // A worker's turn hears the final result first (`onTerminalResult`), then its outcome.
        // The outcome follows once the turn settled, as `askSession` returns after `runTurn`.
        if let Some((terminal, done)) = slot.agent {
            if let (Some(terminal), RunOutcome::Completed(result)) = (terminal, &outcome) {
                terminal(result);
            }
            self.agent_done = Some((done, outcome.clone()));
        }
        for listener in self.cell.turn_listeners() {
            listener.turn_settled(settled.clone());
        }
        let at = self.deps.clock.now_ms();
        let resolution = match outcome {
            RunOutcome::Interrupted => ApprovalResolution::Interrupted { at },
            _ => ApprovalResolution::Cancelled { at },
        };
        for aid in self.book.take_run(&turn) {
            self.resolve(aid, &turn, resolution.clone());
        }
        // `onGoalTurnSettled` (`turnOutcome`): the Goal runtime closes the turn's clock segment
        // and reads its outcome.
        let (status, error) = match &outcome {
            RunOutcome::Completed(_) => ("done", None),
            RunOutcome::Interrupted => ("cancelled", None),
            RunOutcome::Failed(error) => ("failed", Some(error)),
        };
        let settle = super::goal_lane::settle_detail(status, error, slot.automatic, slot.tool_calls);
        // The next turn waits for the settlement, as Node's queue drains after `runTurn` returns.
        self.settling = true;
        match error {
            Some(error) => {
                // `transcriptMeta` carries the turn's `completionVerb` (`beginTurn`), which the failure's end and completion name.
                let mut transcript = slot.transcript.clone();
                transcript["completionVerb"] = json!(slot.verb);
                let failed = FailedClose { error, start_provider: &slot.provider, route_meta: &slot.route_meta, last: slot.last_model.as_ref(), started_at: slot.started_at, transcript: &transcript, live: &mut slot.live };
                self.close_failed(&turn, failed, settle);
            }
            None => {
                let ended = match &outcome {
                    RunOutcome::Completed(result) => Some(("done", result.content.as_str())),
                    RunOutcome::Interrupted => Some(("cancelled", "")),
                    RunOutcome::Failed(_) => None,
                };
                if let Some((status, result)) = ended {
                    let done = DoneClose { reclaimed: reclaimed.is_some(), status, verb: slot.verb, result, route_meta: &slot.route_meta, last: slot.last_model.as_ref(), started_at: slot.started_at, transcript: &slot.transcript, live: &mut slot.live };
                    self.close_done(&turn, done);
                }
                self.settle_goal(settle);
            }
        }
        // `acknowledgePendingGoalReminder`: only an accepted turn clears the marker it carried.
        if let (RunOutcome::Completed(_), Some(revision)) = (&outcome, slot.goal_reminder)
            && let Some(change) = super::goal_reminder::acknowledge(&self.projected.header, revision, self.deps.clock.now_ms())
        {
            let meta = Record::Meta(MetaRecord { op: None, change: Slot::Inline(change) });
            self.accept_record(meta, Class::Normal, Display::None, Vec::new(), Vec::new());
        }
        // The reminders the turn carried (`ask-turn-settle.mjs:148-164`: deferred delta, workflow, settings, orchestration
        // mode, working folder, setup): only an accepted turn tells them; a failed or interrupted one leaves them
        // pending for the next turn.
        let carried = slot.notice.take();
        if matches!(outcome, RunOutcome::Completed(_))
            && let Some(change) = super::reminders::acknowledge(&self.projected.header, &carried, self.deps.clock.now_ms())
        {
            let meta = Record::Meta(MetaRecord { op: None, change: Slot::Inline(change) });
            self.accept_record(meta, Class::Normal, Display::None, Vec::new(), Vec::new());
        }
        if !slot.start_failed {
            let (phase, detail) = match outcome {
                RunOutcome::Completed(_) => (RunPhase::Completed, None),
                RunOutcome::Interrupted => (RunPhase::Interrupted, None),
                RunOutcome::Failed(error) => (
                    RunPhase::Failed,
                    Some(Slot::Inline(
                        serde_json::to_value(&error).expect("protocol types serialize"),
                    )),
                ),
            };
            let completed = phase == RunPhase::Completed;
            let record = Record::Run(RunRecord {
                rid: id(turn.as_str()),
                phase,
                attribution: None,
                attempt: None,
                at: Some(at),
                op: None,
                detail,
            });
            let mut effects = Vec::new();
            if completed {
                effects.push(Effect::ItemAck(self.ingest_when_durable()));
            }
            self.accept_record(record, Class::Control, Display::None, Vec::new(), effects);
            if completed {
                // `ask-turn-settle.mjs:132-139`: the completed turn stamps the record's activity,
                // and from this turn on an owner close of the session is recorded on it
                // (`resumableAfterReap`).
                let mut set = serde_json::Map::new();
                set.insert("updatedAt".into(), json!(at));
                set.insert("lastUsedAt".into(), json!(at));
                set.insert("closeProvenance".into(), json!(1));
                set.insert("lastTurnCompletedAt".into(), json!(at));
                // `session.turnCoverage = turnToken` (`ask-turn-settle.mjs`). The loop's last iteration and
                // the session's tool-call total are written by each model call (`persistIterationMetrics`).
                set.insert("turnCoverage".into(), json!(turn.as_str()));
                let meta = Record::Meta(MetaRecord { op: None, change: Slot::Inline(HeaderChange { set, unset: Vec::new() }) });
                self.accept_record(meta, Class::Control, Display::None, Vec::new(), Vec::new());
            } else {
                // A cancelled or failed turn is finalized too: `session.turnCoverage = turnCheckpointToken`
                // (`ask-turn-failure.mjs:185`), and nothing else of the settle's stamps.
                let mut set = serde_json::Map::new();
                set.insert("turnCoverage".into(), json!(turn.as_str()));
                let meta = Record::Meta(MetaRecord { op: None, change: Slot::Inline(HeaderChange { set, unset: Vec::new() }) });
                self.accept_record(meta, Class::Control, Display::None, Vec::new(), Vec::new());
            }
        }
        if self.deleting {
            self.delete_turn_ended();
        }
        self.run_deferred_prune();
        // A compaction the model scheduled (`takePendingCompact`, `turn-settle.mjs`) runs once the turn is over; the
        // answer has no reader.
        if self.cell.pending_compact.swap(false, SeqCst) {
            let (tx, _) = oneshot::channel();
            self.compact_start(None, tx, None);
        }
        // The queue moves on, and the thread may unload, once the settlement is back
        // (`JobDone::GoalSettled`).
    }

    /// What `hasResumeInput` and `scheduleQuotaResume` read of the session now; the transcript
    /// is the shown one (rows show once durable).
    fn resume_check(&self) -> super::quota_lane::ResumeCheck {
        let route = |key: &str| self.projected.header.get(key).and_then(Value::as_str).unwrap_or_default().to_owned();
        super::quota_lane::ResumeCheck {
            session_id: self.id.as_str().to_owned(),
            items: super::quota_lane::transcript_rows(self.acked.window.iter().map(|row| row.item.as_ref())),
            context: ModelContext {
                store: self.deps.store.clone(),
                sensitive: self.deps.sensitive.clone(),
                lanes: self.deps.lanes,
                thread: self.id.clone(),
                input: mixdog_core_api::ids::ItemId::from(String::new()),
            },
            goal_id: self.projected.sections.goal.as_ref().and_then(|goal| goal.get("id")).and_then(Value::as_str).unwrap_or_default().to_owned(),
            quota: self.deps.quota.goals.clone(),
            route_provider: route("provider"),
            route_model: route("model"),
        }
    }

    /// `attachFailedTurnCompletion(session.messages, completion)` (`ask-turn-failure.mjs:176-177`,
    /// `ask-turn-settle.mjs:85-96`): a failed turn's end is recorded on the last message of the conversation, its
    /// tool result, last reply or the prompt itself, as `meta.transcript.completion` (an amend of that row's body), so
    /// a retry finds the failed turn's identity and provenance (`failedTurnMessage`, `cache-warm.mjs:508-527`).
    /// Not for a system message. The outbox entry of the amend, for what must stand on it being durable.
    fn amend_last_with(&mut self, last: &ItemRecord, completion: Value) -> Option<u64> {
        let Slot::Inline(body) = &last.body else { return None };
        if body.get("role").and_then(Value::as_str) == Some("system") {
            return None;
        }
        let mut next = body.clone();
        let message = next.as_object_mut()?;
        let meta = message.entry("meta").or_insert_with(|| json!({}));
        if !meta.is_object() {
            *meta = json!({});
        }
        let transcript = meta.as_object_mut().expect("meta is an object").entry("transcript").or_insert_with(|| json!({}));
        if !transcript.is_object() {
            *transcript = json!({});
        }
        transcript.as_object_mut().expect("transcript is an object").insert("completion".into(), completion);
        let record = Record::Amend(AmendRecord { iid: last.iid.clone(), op: None, refs: last.refs.clone(), body: Slot::Inline(next) });
        Some(self.accept_record_entry(record, Class::Normal, Display::None, Vec::new(), Vec::new()))
    }

    /// A failed turn's close (`failTurn`, `publishTurnClose`, `settleTurn`): the completion is recorded on the last
    /// message (`attachFailedTurnCompletion`, `ask-turn-settle.mjs:84`), the turn's end is shown live, built from
    /// what the run showed (`turnDoneItem`, `turn.mjs:573`), then `beginQuotaSettlement` reads that end, then the
    /// Goal settles (`turn.mjs:644-688`). The end stands on the amend: both settlements run when the end is released,
    /// which is after the amend is durable, and if the amend cannot be recorded the end goes with it (see
    /// [`Self::fail_entry`]). A failure record that cannot be built (a typed `MalformedFacts`) shows
    /// no end and settles no quota; the Goal still settles.
    fn close_failed(&mut self, turn: &TurnId, failed: FailedClose<'_>, settle: Value) {
        self.clear_active_tools();
        let now = self.deps.clock.now_ms();
        failed.live.close(now);
        self.turns_closed += 1;
        self.publish_stats();
        // `session.provider || raw.provider`, `session.model || raw.modelId` (`failedTurnCompletion`).
        let header = |key: &str| self.projected.header.get(key).and_then(Value::as_str).filter(|s| !s.is_empty()).map(str::to_owned);
        let raw = |key: &str| failed.transcript.get(key).and_then(Value::as_str).filter(|s| !s.is_empty()).map(str::to_owned);
        let provider = header("provider").or_else(|| raw("provider")).unwrap_or_default();
        let model = header("model").or_else(|| raw("modelId")).unwrap_or_default();
        let facts = super::failure_record::Facts {
            raw: failed.transcript,
            started_at: failed.started_at,
            now,
            attempt_id: new_id(),
            route: super::failure_record::Route { provider: &provider, model: &model },
        };
        // The live end is built on the route the turn started with, the durable completion on the session's route now:
        // a quota stop names `route.provider`/`route.model` (`routeMeta.model` is the display name of the model id).
        let model_name = failed.route_meta.get("model").and_then(Value::as_str).unwrap_or_default();
        let live_route = super::failure_record::Route { provider: failed.start_provider, model: model_name };
        let records = (super::failure_record::failure_record(failed.error, &live_route), super::failure_record::failure_record(failed.error, &facts.route));
        let (live_record, record) = match records {
            (Ok(live), Ok(record)) => (live, record),
            (Err(malformed), _) | (_, Err(malformed)) => {
                tracing::error!("the failed turn {} shows no end and settles no quota: {malformed}", turn.as_str());
                return self.settle_goal(settle);
            }
        };
        // `failTurn` (`turn.mjs:570`): the failure's text is a toast of the transcript's owner, besides the end.
        let detail = live_record.get("detail").and_then(Value::as_str).map(super::live_rows::polish_notice_text).unwrap_or_default();
        self.push_toast(&detail, "error", Some("transcript"), Vec::new());
        let row = super::live_end::live_end_row(failed.live, &facts, failed.route_meta, "failed", None, &live_record, &new_id());
        let end = super::transcript::live_end(row, turn.as_str());
        let amend = failed.last.and_then(|last| self.amend_last_with(last, super::failure_record::failed_completion(&record, &facts)));
        self.show_live_then(turn.clone(), end, None, amend, vec![Effect::TurnClosed { turn: turn.clone(), settle }]);
    }
    /// What a stop that handed the prompt back changes besides the turn's rows (`reclaimInFlightPrompt`): the text leaves
    /// the prompt history, and when another device cancelled, the device that sent the prompt gets it through
    /// `thread/promptRestore` (the canceller's reply never carries it).
    fn apply_reclaim(&mut self, reclaim: &super::stop::Reclaim) {
        self.accept_view(Change::PromptWithout(reclaim.text.clone()), Vec::new());
        // The prompt's row, and every row after it, leave the transcript (`reclaimInFlightPrompt` removes the turn's prompt),
        // by the thread's own rewind as `PromptRewound` does.
        let window = &self.acked.window;
        if let Some((index, ordinal)) = window.iter().rposition(|row| row.prompt.as_deref().map(str::trim) == Some(reclaim.text.as_str())).and_then(|index| Some((index, window[index].ordinal?))) {
            let previous = index.checked_sub(1).map(|i| window[i].item.id().clone());
            let record = Record::Rewind(RewindRecord { to_ordinal: ordinal, reason: RewindReason::Rewind, op: None });
            self.transcript_rewritten = true;
            self.deps.side.forget(&self.id, false);
            let note = self.history_reset(HistoryResetReason::Rewind, previous);
            self.accept_record(record, Class::Normal, Display::None, vec![note], Vec::new());
            if let Some(reset) = self.provider_state_change(None) {
                self.accept_record(reset, Class::Normal, Display::None, Vec::new(), Vec::new());
            }
        }
        if let Some(device) = &reclaim.handoff {
            let at = self.deps.clock.now_ms();
            let restore = PromptRestore { id: format!("restore-{at}-{}", reclaim.ids.join(",")), ids: reclaim.ids.clone(), text: reclaim.text.clone(), device: device.clone(), at };
            self.accept_view(Change::Section(Section::PromptRestore(Some(restore))), Vec::new());
        }
    }

    /// A finished or stopped turn's close (`publishTurnClose`): the turn's end is shown live, built from what the run
    /// showed (`turnDoneItem`, `turn.mjs:573`), unless a turn that finished normally did nothing (`isNoOpTurn`). The
    /// final reply's commit shows no end of its own ([`Self::submit_encode`]): history restores one from the reply's
    /// completion, which the live end replaces here. A `done` end takes the verb its reply's completion records
    /// (`pickDoneVerb`, stamped when the reply committed), else the turn's own; a `cancelled` end has no reply.
    /// `reclaimed` (the stopped turn's prompt handed back to the composer, `abort.mjs:65`) suppresses the end, as in Node.
    fn close_done(&mut self, turn: &TurnId, done: DoneClose<'_>) {
        self.clear_active_tools();
        let now = self.deps.clock.now_ms();
        done.live.close(now);
        let finished = done.status == "done";
        if finished && done.live.is_no_op(done.result) {
            return;
        }
        self.turns_closed += 1;
        self.publish_stats();
        if done.reclaimed {
            return;
        }
        let reply = done.last.filter(|_| finished).and_then(|last| {
            let Slot::Inline(body) = &last.body else { return None };
            if body.get("role").and_then(Value::as_str) != Some("assistant") {
                return None;
            }
            let completion = body.pointer("/meta/transcript/completion")?;
            Some((last.iid.as_str().to_owned(), completion.get("verb").and_then(Value::as_str).map(str::to_owned)))
        });
        let mut raw = done.transcript.clone();
        raw["completionVerb"] = json!(reply.as_ref().and_then(|(_, verb)| verb.as_deref()).unwrap_or(done.verb));
        let facts = super::failure_record::Facts {
            raw: &raw,
            started_at: done.started_at,
            now,
            attempt_id: new_id(),
            route: super::failure_record::Route { provider: "", model: "" },
        };
        let row = super::live_end::live_end_row(done.live, &facts, done.route_meta, done.status, reply.as_ref().map(|(id, _)| id.as_str()), &serde_json::Map::new(), &new_id());
        self.show_live(turn.clone(), super::transcript::live_end(row, turn.as_str()), None);
    }

    /// `onGoalTurnSettled` (`turnOutcome`): the Goal runtime closes the turn's clock segment and reads its
    /// outcome; the next queued entry waits for the answer.
    fn settle_goal(&mut self, settle: Value) {
        let (goals, thread) = (self.deps.goals.clone(), self.id.clone());
        self.goal_call(Box::pin(async move { JobDone::GoalSettled(goals.turn_settled(&thread, settle).await.ok()) }));
    }

    /// `beginQuotaSettlement` at the close of a turn that failed on quota (`turn.failed &&
    /// turn.quota`: its failed turn end, the latest, carries the quota stop), run when that end is
    /// released (`Effect::TurnClosed`): the settlement window opens, and with a known reset and the
    /// setting on the resume is queued, or the session hears that nothing can be resumed.
    fn begin_quota_settlement(&mut self, turn: &TurnId) {
        let ours = self.acked.window.iter().rev().find_map(|row| match row.item.as_ref() {
            ThreadItem::TurnEnd { status, quota, meta, .. } => {
                Some(*status == mixdog_protocol::TurnEndStatus::Failed && quota.is_some() && meta.turn_id.as_ref() == Some(turn))
            }
            _ => None,
        });
        if ours != Some(true) {
            return;
        }
        // `goalBefore`: the Goal as the turn left it, before its settlement.
        self.quota.before = Some(self.projected.sections.goal.as_ref().and_then(|goal| goal.as_object().cloned()));
        let check = self.resume_check();
        let (settlement, auto_resume) = (self.quota.settlement.clone(), (self.deps.quota.auto_resume)());
        let (jobs, turn) = (self.jobs_tx.clone(), turn.clone());
        self.quota.call(async move {
            let context = check.resume_context(auto_resume).await;
            let begun = settlement.begin(&check.session_id, &check.items, &context).await;
            if matches!(begun, Ok(mixdog_core_goal::quota_settlement::Begin::NotResumable)) {
                let _ = jobs.send(JobDone::QuotaUnresumable(turn));
            }
        });
    }

    /// `finishQuotaSettlement` once the Goal settled: the Goal the failure suspended is
    /// recorded, unless a superseding cancel landed since the turn closed.
    fn finish_quota_settlement(&mut self, settled: Option<&Goal>) {
        let Some(before) = self.quota.before.take() else {
            return;
        };
        let goal_id = if self.deleting { String::new() } else { mixdog_core_goal::goal::quota::suspended_goal_id(before.as_ref(), settled) };
        let settlement = self.quota.settlement.clone();
        self.quota.call(async move {
            if let Err(error) = settlement.finish_goal(&goal_id).await {
                tracing::warn!("the Goal's quota settlement was not finished: {error:?}");
            }
        });
    }

    /// Today's `terminalSave.then(() => ingestSessionTurn(session))`: once the completed turn's
    /// terminal record is durable, its model context goes to the session-search copy. A failed
    /// save ingests nothing.
    fn ingest_when_durable(&self) -> oneshot::Sender<Result<(), RunError>> {
        let (tx, rx) = oneshot::channel();
        let context = ModelContext {
            store: self.deps.store.clone(),
            sensitive: self.deps.sensitive.clone(),
            lanes: self.deps.lanes,
            thread: self.id.clone(),
            input: mixdog_core_api::ids::ItemId::from(String::new()),
        };
        let header = self.projected.header.clone();
        let search = self.deps.search.clone();
        tokio::spawn(async move {
            if !matches!(rx.await, Ok(Ok(()))) {
                return;
            }
            if let Ok(rows) = context.read().await {
                let messages = rows.into_iter().map(|(_, body)| body).collect();
                search.ingest_turn(&context.thread, &header, messages);
            }
        });
        tx
    }

    /// `prioritizeQueued` (`session-flow/queue.mjs`): the queued prompt goes to the front of the queue at
    /// priority `now`, then a drain is kicked (`kickDrain`: an idle thread starts it, a busy one takes it when
    /// its turn settles). An entry no longer queued is left alone.
    fn prioritize(&mut self, qid: &QueuedId) {
        let Some(queued) = self
            .projected
            .queue
            .iter()
            .find(|q| q.qid == qid.as_str() && super::control::is_prioritizable_entry(&q.entry))
        else {
            return;
        };
        let mut entry = queued.entry.clone();
        entry["priority"] = json!("now");
        let record = Record::Queue(QueueRecord {
            qid: id(qid.as_str()),
            action: QueueAction::Prioritize,
            reason: None,
            op: None,
            entry: Some(Slot::Inline(entry)),
        });
        self.accept_record(record, Class::Control, Display::None, Vec::new(), Vec::new());
        self.start_next_queued();
    }

    /// The next queued entry becomes a run (P X9: busy → queued, follow-ups run in order).
    ///
    /// A completion no turn took is a wake of its own, oldest first, with the completion as the
    /// turn's input, never an empty user turn (`notification-bus.mjs:69-76` replays a wake
    /// suppressed while one was in flight; `ask-queue.mjs:87-101` runs each notification as its
    /// own turn). Without wakes, completions wait for the next turn to take them.
    fn start_next_queued(&mut self) {
        if self.turn_busy() || self.deleting {
            return;
        }
        // The wake's remaining completions run first, each its own turn (`ask-queue.mjs` `tail`).
        while !self.wake_tail.is_empty() {
            let qid = self.wake_tail.remove(0);
            if let Some(next) = self.projected.queue.iter().find(|q| q.qid == qid).cloned() {
                self.start_completion(next);
                return;
            }
        }
        let wake = self.completion_wake();
        let Some(next) = self
            .projected
            .queue
            .iter()
            .find(|q| wake || completions::is_channel(&q.entry) || !completions::is_notification(&q.entry))
            .cloned()
        else {
            return;
        };
        if completions::is_notification(&next.entry) {
            // A wake drains every queued completion: the oldest runs now, the rest follow as
            // turns of their own, so no boundary of this chain takes them.
            self.wake_tail = self
                .projected
                .queue
                .iter()
                .filter(|q| completions::is_notification(&q.entry) && q.qid != next.qid && (wake || completions::is_channel(&q.entry)))
                .map(|q| q.qid.clone())
                .collect();
            self.start_completion(next);
            return;
        }
        self.accept_record(
            dequeue(&next.qid),
            Class::Control,
            Display::None,
            Vec::new(),
            Vec::new(),
        );
        // An automatic Goal turn runs only if `shouldRunGoalContinuation` still agrees; a dropped
        // entry stays dropped (`drain.mjs`).
        if super::goal_lane::is_goal_entry(&next.entry) {
            self.check_goal_entry(next.entry);
            return;
        }
        let input = TurnInput {
            prompt: serde_json::from_value(next.entry["message"].clone())
                .unwrap_or(PromptContent::Text(String::new())),
            options: serde_json::from_value(next.entry["options"].clone()).ok(),
        };
        // A prompt a user queued is still the composer's to take back (`restorable`), from the device that sent it.
        self.submitter = next.entry.get("restorable").and_then(Value::as_bool).map(|restorable| Submitter {
            device: next.entry.pointer("/transcriptMeta/device").and_then(Value::as_str).unwrap_or_default().to_owned(),
            restorable,
        });
        self.start_run(input, None, None, None);
    }

    /// A queued completion as a turn's input row, stored as a task notification.
    fn start_completion(&mut self, next: super::state::Queued) {
        self.accept_record(
            dequeue(&next.qid),
            Class::Control,
            Display::None,
            Vec::new(),
            Vec::new(),
        );
        let input = TurnInput {
            prompt: PromptContent::Text(completions::text(&next.entry)),
            options: None,
        };
        if let Some(execution) = suppressed_execution(&next.entry) {
            self.suppressed.insert(execution);
        }
        self.start_run_with(input, completions::input_row(&next.entry), None, None, None, true);
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

    /// A turn runs, is starting or is settling: what Node's ask lock is held for.
    fn turn_held(&self) -> bool {
        self.run.is_some() || self.starting || self.settling
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

    /// `shouldRunGoalContinuation(entry)` for a dequeued Goal entry: a closeout reads the
    /// runtime's Goal, a continuation the runtime's decision; the answer comes back as a job.
    fn check_goal_entry(&mut self, entry: Value) {
        if self.deleting || self.cell.closed.load(SeqCst) {
            return;
        }
        self.goal_checking = true;
        let (deps, thread) = (self.deps.clone(), self.id.clone());
        let closeout = super::goal_lane::is_closeout(&entry);
        self.goal_call(Box::pin(async move {
            let seen = if closeout {
                deps.goals.goal_status(&thread).await.ok().map(GoalCheck::Status)
            } else {
                let input = super::goal_lane::continuation_input(&*deps.todos, &*deps.work, &deps.cycles, &thread).await;
                deps.goals.continuation(&thread, input).await.ok().map(GoalCheck::Decision)
            };
            JobDone::GoalEntryChecked { entry, seen }
        }));
    }

    /// The check is back: the lane shows the Goal it read; the entry runs as an automatic Goal
    /// turn, or is dropped and the queue moves on.
    fn goal_entry_checked(&mut self, entry: Value, seen: Option<GoalCheck>) {
        self.goal_checking = false;
        let deferred = std::mem::take(&mut self.goal_deferred);
        if self.deleting || self.cell.closed.load(SeqCst) {
            return;
        }
        let run = match seen {
            None => false,
            Some(GoalCheck::Status(raw)) => {
                let goal = self.publish_goal(raw);
                super::goal_lane::closeout_still_due(&entry, goal.as_ref())
            }
            Some(GoalCheck::Decision(decision)) => {
                self.publish_goal(decision.goal.clone());
                super::goal_lane::continuation_still_due(&entry, &decision)
            }
        };
        if run {
            // Its prompt is runtime-synthetic, shown as no user row.
            let input = TurnInput { prompt: PromptContent::Text(completions::text(&entry)), options: None };
            self.start_run_with(input, super::goal_lane::input_row(&entry), None, None, None, false);
            return;
        }
        self.start_next_queued();
        if deferred {
            self.schedule_goal_continuation();
        }
        self.try_unload();
    }

    fn active(&self, turn: &TurnId) -> bool {
        self.run.as_ref().is_some_and(|run| &run.turn == turn)
    }

    /// `syncSessionCompaction(session, config)` (`session-compaction-sync.mjs`) at every installation of the session
    /// (`adoptSession`): when it is created or resumed, and when a turn completes (`run_ended`). The header's
    /// `compaction` follows the saved compaction settings. The later syncs (config reload, settings save) are
    /// header updates the config-change follower sends (`run_host::compaction_follow`).
    fn sync_compaction(&mut self) {
        if let Some(synced) = self.deps.compaction.synced_compaction(&self.projected.header, true) {
            let mut set = serde_json::Map::new();
            set.insert("compaction".into(), synced);
            self.accept_header(Some(mixdog_store::schema::record::HeaderChange { set, unset: Vec::new() }));
        }
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

    /// `clearActiveToolSummary`: the turn ended, no call is running.
    fn clear_active_tools(&mut self) {
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
    /// `autoCompactTokenLimit`, `compactBoundaryTokens`) wait for the turn's end: Node's `syncContextDisplayFields` runs with the
    /// context measurement a turn that was not cancelled makes, so a cancelled turn leaves them at their initial 0.
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

    fn on_producer(&mut self, msg: ProducerMsg) {
        match msg {
            ProducerMsg::Section(Section::Context(context)) => self.on_context_section(context),
            ProducerMsg::Section(section) => self.accept_view(Change::Section(section), Vec::new()),
            ProducerMsg::ItemStarted { turn, item } => {
                if !self.active(&turn) {
                    return;
                }
                if matches!(item, ThreadItem::ToolCall { .. }) {
                    self.visible_progress();
                    self.prompt_committed();
                }
                let note = Note::new(
                    "item/started",
                    &ItemNotificationParams {
                        thread_id: self.id.clone(),
                        turn_id: turn.clone(),
                        item: item.clone(),
                    },
                );
                self.accept_view(Change::ItemStarted { turn, item }, vec![note]);
            }
            ProducerMsg::Delta { item, text, method, params } => {
                // Text or reasoning: visible output (`isVisibleStreamProgress`).
                self.visible_progress();
                self.stream_heartbeat();
                let now = self.deps.clock.now_ms();
                // Whitespace is not output (`onTextDelta` marks the prompt committed only for text that trims to something).
                if method == "item/agentMessage/delta" && !mixdog_js::js_trim(&text).is_empty() {
                    self.prompt_committed();
                }
                if let Some(run) = self.run.as_mut() {
                    match method {
                        "item/agentMessage/delta" => run.live.text(&text, now),
                        "item/reasoning/textDelta" => run.live.reasoning(&text, now),
                        _ => {}
                    }
                }
                let note = Note { method, params };
                self.accept_view(Change::Delta { item, text }, vec![note]);
            }
            ProducerMsg::Shown { turn, shown } => {
                if self.active(&turn) {
                    self.run_shown(turn, shown);
                }
            }
            ProducerMsg::Commit { turn, mut item, ack } => {
                if !self.active(&turn) {
                    let _ = ack.send(Err(RunError::NotApplied));
                    return;
                }
                // The model's reply is output (`completeTurn`, `settleSegmentBeforeToolCall`).
                if item.role.as_deref() == Some("assistant") {
                    self.prompt_committed();
                }
                // The row's facts read the prompt-attachment store first (an io-lane job).
                let body = std::mem::take(&mut item.body);
                self.with_facts(body, move |read| match read {
                    Ok((body, facts)) => JobDone::CommitFacts { turn, item: ItemCommit { body, ..item }, facts, ack },
                    Err(error) => JobDone::CommitUnread { ack, error },
                });
            }
            ProducerMsg::ProviderState { turn, state, ack } => {
                if !self.active(&turn) {
                    let _ = ack.send(Err(RunError::NotApplied));
                    return;
                }
                let value = state.map(|state| {
                    serde_json::to_value(state).expect("provider state serializes")
                });
                match self.provider_state_change(value) {
                    Some(record) => self.accept_record(
                        record,
                        Class::Normal,
                        Display::None,
                        Vec::new(),
                        vec![Effect::ItemAck(ack)],
                    ),
                    None => drop(ack.send(Ok(()))),
                }
            }
            ProducerMsg::GoalReminder { turn, preview, reply } => self.compaction_reminder_asked(turn, preview, reply),
            ProducerMsg::GoalReminderAcknowledged { revision } => self.compaction_reminder_acknowledged(revision),
            ProducerMsg::Header { turn, change, ack } => {
                if !self.active(&turn) {
                    let _ = ack.send(Err(RunError::NotApplied));
                    return;
                }
                let header = &self.projected.header;
                let set: serde_json::Map<String, Value> = change.set.into_iter().filter(|(key, value)| header.get(key) != Some(value)).collect();
                let unset: Vec<String> = change.unset.into_iter().filter(|key| header.contains_key(key)).collect();
                if set.is_empty() && unset.is_empty() {
                    drop(ack.send(Ok(())));
                    return;
                }
                let record = Record::Meta(MetaRecord { op: None, change: Slot::Inline(HeaderChange { set, unset }) });
                self.accept_record(record, Class::Normal, Display::None, Vec::new(), vec![Effect::ItemAck(ack)]);
            }
            ProducerMsg::Compacted {
                turn,
                compaction,
                header,
                ack,
            } => {
                // An empty turn id is no turn: a manual compaction's commit (`commit_compaction`).
                if !turn.as_str().is_empty() && !self.active(&turn) {
                    let _ = ack.send(Err(RunError::NotApplied));
                    return;
                }
                self.transcript_rewritten = true;
                // A compaction that changed the context drops the provider continuation
                // (`compaction-runner.mjs:701`).
                if let Some(reset) = self.provider_state_change(None) {
                    self.accept_record(reset, Class::Normal, Display::None, Vec::new(), Vec::new());
                }
                // A caller that states the header (the manual compaction's `compactionRecord`) writes it with
                // the compaction, `compactCount` included (`compaction-runner.mjs:505`). The pre-send pass states
                // none: its count is the telemetry's (`rememberCompactTelemetry`, `compact-policy.mjs:877`), written
                // once by the pass's own `pass_change`.
                let cid = new_id();
                // The divider shows live where the compaction happened (`compactionDivider`).
                let divider = super::transcript::divider_item(&cid, Some(compaction.at));
                let note = Note::new(
                    "item/completed",
                    &ItemNotificationParams { thread_id: self.id.clone(), turn_id: turn.clone(), item: divider.clone() },
                );
                let record = Record::Compacted(CompactedRecord {
                    cid: id(&cid),
                    summary_iid: None,
                    op: None,
                    at: Some(compaction.at),
                    dropped_count: Some(compaction.dropped_count),
                    dropped: compaction.dropped.map(|d| CompactedDropped {
                        message_ids: d.message_ids,
                        call_ids: d.call_ids,
                    }),
                    silent: None,
                    replacement: Slot::Inline(
                        compaction
                            .replacement
                            .into_iter()
                            .map(|(iid, body)| ReplacementEntry {
                                iid: iid.as_str().to_owned(),
                                body,
                            })
                            .collect(),
                    ),
                });
                // The header is computed after the replacement is in, as Node stamps `committedAt` after the transcript and
                // provider-state mutations (`compaction-runner.mjs:695-749`); its record follows the compaction's, and the
                // caller's ack rides the last record, so the header is durable when the commit answers.
                let (compaction_ack, header_ack) = if header.is_some() { (Vec::new(), vec![Effect::ItemAck(ack)]) } else { (vec![Effect::ItemAck(ack)], Vec::new()) };
                self.accept_record(record, Class::Normal, Display::Items(vec![Shown::Item(divider)]), vec![note], compaction_ack);
                if let Some(header) = header {
                    let change = header(&self.projected.header);
                    self.accept_record(Record::Meta(MetaRecord { op: None, change: Slot::Inline(change) }), Class::Normal, Display::None, Vec::new(), header_ack);
                }
            }
            ProducerMsg::ContextRewound { turn, replacement, ack } => {
                if !self.active(&turn) {
                    let _ = ack.send(Err(RunError::NotApplied));
                    return;
                }
                self.transcript_rewritten = true;
                // The provider continuation described the rows that left.
                if let Some(reset) = self.provider_state_change(None) {
                    self.accept_record(reset, Class::Normal, Display::None, Vec::new(), Vec::new());
                }
                // Nothing leaves the transcript (`dropped_count: 0`, no identities) and no divider
                // is shown, live or restored (`silent`): only the model context restarts.
                let record = Record::Compacted(CompactedRecord {
                    cid: id(&new_id()),
                    summary_iid: None,
                    op: None,
                    at: Some(self.deps.clock.now_ms()),
                    dropped_count: Some(0),
                    dropped: None,
                    silent: Some(true),
                    replacement: Slot::Inline(
                        replacement.into_iter().map(|(iid, body)| ReplacementEntry { iid: iid.as_str().to_owned(), body }).collect(),
                    ),
                });
                self.accept_record(record, Class::Normal, Display::None, Vec::new(), vec![Effect::ItemAck(ack)]);
            }
            ProducerMsg::PromptRewound { turn, item, ack } => {
                if !self.active(&turn) {
                    let _ = ack.send(Err(RunError::NotApplied));
                    return;
                }
                // The thread's own rewind (`rewind`), at the prompt's row: it, and every row after it, leave.
                let window = &self.acked.window;
                let Some(index) = window.iter().position(|row| row.item.id() == &item) else {
                    let _ = ack.send(Err(RunError::NotApplied));
                    return;
                };
                let Some(ordinal) = window[index].ordinal else {
                    let _ = ack.send(Err(RunError::NotApplied));
                    return;
                };
                let previous = index.checked_sub(1).map(|i| window[i].item.id().clone());
                let record = Record::Rewind(RewindRecord { to_ordinal: ordinal, reason: RewindReason::Rewind, op: None });
                self.transcript_rewritten = true;
                self.deps.side.forget(&self.id, false);
                let note = self.history_reset(HistoryResetReason::Rewind, previous);
                // The provider continuation described the rows that left.
                match self.provider_state_change(None) {
                    None => self.accept_record(record, Class::Normal, Display::None, vec![note], vec![Effect::ItemAck(ack)]),
                    Some(reset) => {
                        self.accept_record(record, Class::Normal, Display::None, vec![note], Vec::new());
                        self.accept_record(reset, Class::Normal, Display::None, Vec::new(), vec![Effect::ItemAck(ack)]);
                    }
                }
            }
            ProducerMsg::TakeSteers { turn, request, reply } => {
                self.take_steers(turn, request, reply, std::collections::HashMap::new());
            }
        }
    }

    /// `drainPendingSteering` for a run's boundary. A queued Goal entry is delivered only while
    /// its Goal still wants it (`canDeliverSteeringEntry`); the check reads the Goal runtime, so
    /// the drain waits for it and comes back here with `checked` (a Goal entry's queue id -> due).
    fn take_steers(
        &mut self,
        turn: TurnId,
        request: DrainRequest,
        reply: oneshot::Sender<Vec<SteerInput>>,
        checked: std::collections::HashMap<String, bool>,
    ) {
        if !self.active(&turn) {
            let _ = reply.send(Vec::new());
            return;
        }
        let max_priority = request.max_priority;
        let mut taken: Vec<QueuedId> = Vec::new();
        let mut dropped: Vec<QueuedId> = Vec::new();
        let mut out: Vec<SteerInput> = Vec::new();
        for qid in &self.steer_marked {
            if let Some(q) = self.acked.queue.iter().find(|q| {
                q.qid == qid.as_str() && within_priority(&q.entry, max_priority)
            }) {
                taken.push(qid.clone());
                // `raiseTurnHop(opts.session, merged.transcriptMeta)` (`steering.mjs:145`): a
                // bot's message at a higher hop makes the running turn bot-descended at that hop.
                self.cell.turn_chain.raise(pending::steered_meta(&q.entry));
                out.push(pending::steered(qid.clone(), &q.entry));
            }
        }
        self.steer_marked.retain(|qid| !taken.contains(qid));
        self.sync_turn_chain();
        // `if (turn.session?.heldRoute) return out;` (`ask-turn-steering-drain.mjs:48`).
        if !self.route_held() {
            // The rest of the queue: not steered, not claimed by a wake, within the
            // drain's priority (entries beyond it wait for the turn to end).
            let rest: Vec<&super::state::Queued> = self
                .projected
                .queue
                .iter()
                .filter(|q| {
                    !taken.iter().any(|t| t.as_str() == q.qid)
                        && !self.steer_marked.iter().any(|s| s.as_str() == q.qid)
                        && !self.wake_tail.contains(&q.qid)
                        && within_priority(&q.entry, max_priority)
                })
                .collect();
            // `stage === 'terminal' || pendingQueueHoldsOnlyNotifications(sessionId)`.
            let only_notifications = !rest.is_empty()
                && rest.iter().all(|q| completions::is_notification(&q.entry));
            if request.stage == DrainStage::Terminal || only_notifications {
                // Durable entries only: memory never runs ahead of disk.
                let durable: Vec<(QueuedId, Value)> = rest
                    .iter()
                    .filter_map(|q| {
                        self.acked.queue.iter().find(|a| a.qid == q.qid).map(|a| {
                            (QueuedId::from(a.qid.as_str()), a.entry.clone())
                        })
                    })
                    .collect();
                let unchecked: Vec<(String, Value)> = durable
                    .iter()
                    .filter(|(qid, entry)| super::goal_lane::is_goal_entry(entry) && !checked.contains_key(qid.as_str()))
                    .map(|(qid, entry)| (qid.as_str().to_owned(), entry.clone()))
                    .collect();
                if !unchecked.is_empty() {
                    self.check_steer_goals(turn, request, reply, checked, unchecked);
                    return;
                }
                // A Goal entry its Goal no longer wants is dequeued and never delivered.
                let (deliver, gone): (Vec<_>, Vec<_>) = durable
                    .into_iter()
                    .partition(|(qid, entry)| !super::goal_lane::is_goal_entry(entry) || checked.get(qid.as_str()) == Some(&true));
                dropped.extend(gone.into_iter().map(|(qid, _)| qid));
                let groups = pending::groups(&deliver);
                // Nothing that carries content is released back to the queue.
                if !groups.is_empty() {
                    for meta in pending::group_metas(&deliver) {
                        self.cell.turn_chain.raise(Some(meta));
                    }
                    self.sync_turn_chain();
                    taken.extend(deliver.into_iter().map(|(qid, _)| qid));
                    out.extend(groups);
                }
            }
        }
        for qid in &taken {
            // A completion the listener already showed comes back as the turn's row
            // with no row of its own (`suppressDisplay`); so does a notice the Goal lane queued
            // for the model alone, which has no execution to name: its queue id stands for it.
            if let Some(q) = self.acked.queue.iter().find(|q| q.qid == qid.as_str()) {
                if let Some(execution) = suppressed_execution(&q.entry) {
                    self.suppressed.insert(execution);
                } else if q.entry.get("suppressDisplay") == Some(&Value::Bool(true)) {
                    self.suppressed.insert(qid.as_str().to_owned());
                }
            }
        }
        for qid in taken.iter().chain(&dropped) {
            self.accept_record(
                dequeue(qid.as_str()),
                Class::Control,
                Display::None,
                Vec::new(),
                Vec::new(),
            );
        }
        let _ = reply.send(out);
    }

    /// `canDeliverSteeringEntry`'s reads for the Goal entries a drain would take: the runtime's
    /// answer for each, then the drain goes on.
    fn check_steer_goals(
        &mut self,
        turn: TurnId,
        request: DrainRequest,
        reply: oneshot::Sender<Vec<SteerInput>>,
        checked: std::collections::HashMap<String, bool>,
        entries: Vec<(String, Value)>,
    ) {
        let (deps, thread) = (self.deps.clone(), self.id.clone());
        self.goal_call(Box::pin(async move {
            let mut seen = Vec::new();
            for (qid, entry) in entries {
                let read = if super::goal_lane::is_closeout(&entry) {
                    deps.goals.goal_status(&thread).await.ok().map(GoalCheck::Status)
                } else {
                    let input = super::goal_lane::continuation_input(&*deps.todos, &*deps.work, &deps.cycles, &thread).await;
                    deps.goals.continuation(&thread, input).await.ok().map(GoalCheck::Decision)
                };
                seen.push((qid, entry, read));
            }
            JobDone::SteerGoalsChecked { turn, request, reply, checked, seen }
        }));
    }

    /// The runtime's answer for a Goal entry: whether it is still due (`shouldRunGoalContinuation`).
    /// The lane shows the Goal it read.
    fn goal_due(&mut self, entry: &Value, seen: Option<GoalCheck>) -> bool {
        match seen {
            None => false,
            Some(GoalCheck::Status(raw)) => {
                let goal = self.publish_goal(raw);
                super::goal_lane::closeout_still_due(entry, goal.as_ref())
            }
            Some(GoalCheck::Decision(decision)) => {
                self.publish_goal(decision.goal.clone());
                super::goal_lane::continuation_still_due(entry, &decision)
            }
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
        let jobs = self.jobs_tx.clone();
        let expiring = id.clone();
        let timer = tokio::spawn(async move {
            mixdog_rt::time::sleep(TOAST_TTL).await;
            let _ = jobs.send(JobDone::ToastExpired(expiring));
        });
        self.toast_timers.insert(id, timer.abort_handle());
    }

    /// `clearToastTimers` (`notice-surface.mjs:125`): no toast in the queue expires after this.
    fn cancel_toast_timers(&mut self) {
        for (_, timer) in self.toast_timers.drain() {
            timer.abort();
        }
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
            RunShown::Usage(report) => {
                if let Some(run) = self.run.as_mut() {
                    run.live.usage(report.usage.output_tokens);
                }
                let now = self.deps.clock.now_ms();
                let usage = super::live_rows::usage_delta(self.id.as_str(), &report, now);
                // `applyTurnUsageDelta`: the same event moves the session's stats (`applyUsageDelta`, `syncContextStats`).
                self.stats.fold(&usage);
                // `onUsageDelta`: the call's metrics and the provider's reading go to the header.
                self.usage_incremental = true;
                let books = self.deps.compaction.books(&self.id, &self.projected.header);
                let change = super::usage_books::usage_change(&self.projected.header, &usage, &report.outgoing, &report.send_tools, books.as_ref(), report.sent_at_ms as f64, now as f64);
                self.accept_header(change);
                let note = Note::new(
                    "thread/tokenUsage/updated",
                    &mixdog_app_protocol::v2::thread::TokenUsageUpdatedParams { thread_id: self.id.clone(), usage },
                );
                self.accept_view(Change::Barrier, vec![note]);
                self.publish_stats();
            }
            RunShown::Check(check) => {
                if let Some(books) = self.deps.compaction.books(&self.id, &self.projected.header) {
                    let change = super::usage_books::check_change(&self.projected.header, &check, &books, self.deps.clock.now_ms() as f64);
                    self.accept_header(change);
                }
            }
            RunShown::Settled(settled) => {
                let books = self.deps.compaction.books(&self.id, &self.projected.header);
                let now = self.deps.clock.now_ms();
                let change = super::usage_books::settled_change(&self.projected.header, &settled, self.usage_incremental, books.as_ref(), now as f64);
                self.accept_header(change);
                // `recordStandaloneStatusTelemetry`: the gateway usage event of the completed ask.
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
            RunShown::SearchUsage(usage) => {
                let note = Note::new("thread/tokenUsage/updated", &mixdog_app_protocol::v2::thread::TokenUsageUpdatedParams { thread_id: self.id.clone(), usage });
                self.accept_view(Change::Barrier, vec![note]);
            }
            RunShown::Stage { stage, detail } => {
                let note = Note::new("thread/stage/updated", &mixdog_app_protocol::v2::thread::ThreadStageUpdatedParams { thread_id: self.id.clone(), stage, detail });
                self.accept_view(Change::Barrier, vec![note]);
            }
            RunShown::ToolStream => self.stream_heartbeat(),
            RunShown::CompactUsage(report) => {
                let now = self.deps.clock.now_ms();
                let usage = super::live_rows::compact_usage_delta(self.id.as_str(), &report, now);
                // `persistIterationMetrics` marks the turn's usage incremental, as for any call.
                self.usage_incremental = true;
                let change = super::usage_books::compact_usage_change(&self.projected.header, &usage, now as f64);
                self.accept_header(change);
                let mut usage = usage;
                usage["usageMetricsTurnId"] = self.projected.header.get("usageMetricsTurnId").cloned().unwrap_or(json!(0));
                usage["usageMetricsEpoch"] = self.projected.header.get("usageMetricsEpoch").cloned().unwrap_or(json!(0));
                let note = Note::new("thread/tokenUsage/updated", &mixdog_app_protocol::v2::thread::TokenUsageUpdatedParams { thread_id: self.id.clone(), usage });
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
                let item = super::transcript::compact_marker_item(&new_id(), turn.as_str(), label, &detail);
                // A pass that changed the context marks where the turn began: the rows above it
                // are what the compaction took (`archiveItemsForCompaction`).
                let before = super::live_rows::compact_changed(&event).then(|| self.run.as_ref().map(|run| run.input_item.clone())).flatten();
                self.show_live(turn, item, before);
            }
        }
    }

    /// A live-only row of the run, before the row `before` when it is in view, else last.
    fn show_live(&mut self, turn: TurnId, item: ThreadItem, before: Option<mixdog_core_api::ids::ItemId>) {
        self.show_live_then(turn, item, before, None, Vec::new());
    }

    /// [`Self::show_live`], with `effects` that run when the row is released (shown to the feed, and in
    /// the acked state). `needs`: the record the row stands on ([`Self::accept_view_after`]).
    fn show_live_then(&mut self, turn: TurnId, item: ThreadItem, before: Option<mixdog_core_api::ids::ItemId>, needs: Option<u64>, effects: Vec<Effect>) {
        let note = Note::new("item/completed", &ItemNotificationParams { thread_id: self.id.clone(), turn_id: turn, item: item.clone() });
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
    fn item_record(
        &self,
        turn: &TurnId,
        mut item: ItemCommit,
        facts: RowFacts,
        op: Option<OpRef>,
    ) -> Result<Record, CoreError> {
        let (visible, prompt) = (item.visible && facts.visible, item.prompt.take().or(facts.prompt));
        Ok(Record::Item(ItemRecord {
            iid: text(item.iid.as_str(), "itemId")?,
            turn: Some(text(turn.as_str(), "turnId")?),
            role: item
                .role
                .as_deref()
                .map(|role| text(role, "role"))
                .transpose()?,
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

    /// The id comes from the durable allocator off the actor; the request continues in
    /// [`Self::approval_id`].
    fn request_approval(
        &mut self,
        turn: TurnId,
        ask: ApprovalAsk,
        reply: oneshot::Sender<ApprovalResolution>,
    ) {
        let ids = self.deps.approval_ids.clone();
        let jobs = self.jobs_tx.clone();
        tokio::spawn(async move {
            let result = ids.next().await;
            let _ = jobs.send(JobDone::ApprovalId {
                turn,
                ask,
                reply,
                result,
            });
        });
    }

    /// An allocator failure fails the ask like a cancelled one: no request was shown.
    fn approval_id(
        &mut self,
        turn: TurnId,
        ask: ApprovalAsk,
        reply: oneshot::Sender<ApprovalResolution>,
        result: Result<ApprovalId, CoreError>,
    ) {
        let aid = match result {
            Ok(aid) if self.active(&turn) => aid,
            _ => {
                let _ = reply.send(ApprovalResolution::Cancelled {
                    at: self.deps.clock.now_ms(),
                });
                return;
            }
        };
        let request =
            ApprovalBook::request(aid, &self.id, &self.lineage, ask, self.deps.clock.now_ms());
        let params = request_params(&request, &turn);
        let method = request.ask.kind.method();
        let pending = PendingServerRequest {
            id: aid.request_id(),
            method,
            thread: self.id.clone(),
            surface: self.lineage.surface.clone(),
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
            body: Some(Slot::Inline(
                json!({ "method": method.as_str(), "params": params }),
            )),
        });
        self.book.insert(request, turn, Some(reply));
        self.accept_record(
            record,
            Class::Control,
            Display::None,
            Vec::new(),
            vec![Effect::PublishApproval(pending)],
        );
    }

    // ───────────── inbox ─────────────

    fn on_inbox(&mut self, msg: Inbox) {
        match msg {
            Inbox::GoalChanged(goal) => self.goal_changed(goal),
            Inbox::CompletionCard { content, meta } => self.completion_card(&content, &meta),
            Inbox::SetupUiRequest { id, window } => self.setup_ui_request(id, window),
            Inbox::SetupUiSettled { id } => self.setup_ui_settled(&id),
            Inbox::TaskNotification {
                surface,
                task_id,
                status,
                text,
                origin,
                live,
                durable,
            } => self.task_notification(&surface, task_id, status, text, origin, live, durable),
            Inbox::AgentActivity => self.agent_activity(),
            Inbox::SensitiveCarried => {
                self.redact_prompts();
                // The log now (a queued batch rewrites it before it appends anyway); the search rows once what is
                // queued is durable. A running turn's own listener does the same; the second pass finds nothing.
                let _ = self.ch.dur_tx.try_send(ToDurability::Redact);
                let ack = self.ingest_when_durable();
                self.outbox.push(None, Change::Barrier, Vec::new(), vec![Effect::ItemAck(ack)]);
            }
            Inbox::ForkPlan { tx } => {
                let plan = text(&self.log_id, "logId").map(|log_id| {
                    (
                        Base {
                            session: id(self.id.as_str()),
                            log_id,
                            end_ordinal_exclusive: self.acked_end,
                        },
                        self.acked.header.clone(),
                    )
                });
                let _ = tx.send(plan);
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
            Inbox::Request { req, tx } => {
                let tx = match &req.op {
                    Some(op) => {
                        let digest = ops::digest(&req.params);
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

    /// `Inbox::UpdateHeader`: the change is computed here, from a copy of the header as projected
    /// (the actor is the header's only writer), and written as one `meta` record, answered once
    /// durable. A change that sets and unsets nothing writes nothing. `update` is synchronous and
    /// pure by contract (`HeaderUpdates`); a panic in it fails only this caller and writes nothing,
    /// and the actor goes on.
    fn update_header(&mut self, update: mixdog_core_ports::ports::threads::HeaderUpdate, tx: Waiter) {
        if !self.outbox.has_room(Class::Normal) {
            let _ = tx.send(Err(CoreError::WindowFull { thread_id: self.id.clone() }));
            return;
        }
        let header = self.projected.header.clone();
        let Ok(change) = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| update(&header))) else {
            let _ = tx.send(Err(CoreError::Internal { incident_id: "header-update-panicked".into() }));
            return;
        };
        self.write_header_change(change, tx);
    }

    /// `Inbox::UpdateHeaderAwaiting`: as [`Self::update_header`], over a step that awaits its outside reads here.
    async fn update_header_awaiting(&mut self, update: AwaitingHeaderUpdate, tx: Waiter) {
        use futures::FutureExt;
        if !self.outbox.has_room(Class::Normal) {
            let _ = tx.send(Err(CoreError::WindowFull { thread_id: self.id.clone() }));
            return;
        }
        let header = self.projected.header.clone();
        let Ok(change) = std::panic::AssertUnwindSafe(update(header)).catch_unwind().await else {
            let _ = tx.send(Err(CoreError::Internal { incident_id: "header-update-panicked".into() }));
            return;
        };
        // `updateSessionRoute`: a route move is written once its new figures are read ([`Self::start_route_move`]).
        let unset: Vec<&str> = change.unset.iter().map(String::as_str).collect();
        if self.run.is_none()
            && let Some(next) = self.window_move_of(Some(&change.set), &unset)
        {
            self.start_route_move(MoveApply::Change { change, tx }, next);
            return;
        }
        self.write_header_change(change, tx);
    }

    fn write_header_change(&mut self, change: mixdog_store::schema::record::HeaderChange, tx: Waiter) {
        if change.set.is_empty() && change.unset.is_empty() {
            let _ = tx.send(Ok(Reply::Value(json!({}))));
            return;
        }
        let record = Record::Meta(MetaRecord { op: None, change: Slot::Inline(change) });
        let plan = Plan {
            kind: PlanKind::Records(vec![(record, Class::Normal, Display::None, Vec::new())], Vec::new()),
            value: json!({}),
            after: None,
            prompt: None,
        };
        self.apply_plan(plan, None, tx);
    }

    /// The thread scope's op store (P §9.2): `Await` answers once a running execution of the op
    /// has settled; `Record` appends an `op` record (rejection, fence, external state), answered
    /// once durable.
    fn op_call(&mut self, call: super::thread_ops::OpCall, tx: Waiter) {
        use super::thread_ops::OpCall;
        match call {
            OpCall::Await(op) => {
                if let Some(tx) = self.ops.wait_for(&op, tx) {
                    let _ = tx.send(Ok(Reply::Value(Value::Null)));
                }
            }
            OpCall::Record { op, state, detail } => {
                if !self.outbox.has_room(Class::Normal) {
                    let _ = tx.send(Err(CoreError::WindowFull { thread_id: self.id.clone() }));
                    return;
                }
                if state == mixdog_store::schema::record::OpState::Fenced
                    && let Err(error) = self.ops.fence(&OpId::from(op.id.as_str().to_owned()))
                {
                    let _ = tx.send(Err(error));
                    return;
                }
                let record = Record::Op(mixdog_store::schema::record::OpRecord {
                    op,
                    state,
                    at: self.deps.clock.now_ms(),
                    detail: detail.map(Slot::Inline),
                });
                let plan = Plan {
                    kind: PlanKind::Records(vec![(record, Class::Normal, Display::None, Vec::new())], Vec::new()),
                    value: json!({}),
                    after: None,
                    prompt: None,
                };
                self.apply_plan(plan, None, tx);
            }
        }
    }

    fn op_ref(&self, req: &CoreRequest, result: Option<&Value>) -> Result<Option<OpRef>, CoreError> {
        let Some(op) = &req.op else {
            return Ok(None);
        };
        Ok(Some(OpRef {
            id: text(op.as_str(), "opId")?,
            method: text(req.method.as_str(), "method")?,
            digest: Digest::try_from(ops::digest(&req.params)).expect("digest is well formed"),
            result: result.and_then(|value| Json::try_from(value.clone()).ok()),
        }))
    }

    /// C2 mutations of a thread (P §7.2): each answers once its records are durable.
    fn mutation(&mut self, req: CoreRequest, tx: Waiter) -> Result<(), (CoreError, Waiter)> {
        let fail = |error: CoreError, tx: Waiter, ops: &mut OpTable| {
            if let Some(op) = &req.op {
                ops.failed(op, &error);
            }
            Err((error, tx))
        };
        if !self.outbox.has_room(Class::Normal) {
            let error = CoreError::WindowFull {
                thread_id: self.id.clone(),
            };
            return fail(error, tx, &mut self.ops);
        }
        // The `/goal` route (`goalControl`): the Goal runtime answers; no record of its own.
        if matches!(req.method.as_str(), "thread/goal/set" | "thread/goal/clear" | "thread/goal/control") {
            let request = match super::goal_lane::control_request(req.method.as_str(), &req.params) {
                Ok(request) => request,
                Err(error) => return fail(error, tx, &mut self.ops),
            };
            let (goals, thread, op) = (self.deps.goals.clone(), self.id.clone(), req.op.clone());
            self.goal_call(Box::pin(async move {
                let result = goals.goal_control(&thread, request).await;
                JobDone::GoalControlled { op, tx, result }
            }));
            return Ok(());
        }
        if super::turn_ops::is_actor_method(req.method.as_str()) {
            return self.turn_op(req, tx);
        }
        // A conditional header patch (`expect`): the read-modify-write of a caller that computed
        // its change from the header, decided here against the header as projected.
        if req.method.as_str() == "thread/header/patch" {
            if let Some(current) = self.header_conflict(&req.params) {
                let _ = tx.send(Ok(Reply::Value(json!({ "conflict": current }))));
                return Ok(());
            }
            // A save issued for an ownership generation (`saveSessionAsync(session, { expectedGeneration })`): dropped
            // when the header it would land on is past that generation (`_dropsAgainst`, `store.mjs:149-153`).
            let expected = req.params.get("expectedGeneration").and_then(Value::as_f64);
            if super::close::drops_against(&self.projected.header, expected) {
                let _ = tx.send(Ok(Reply::Value(json!({ "dropped": true }))));
                return Ok(());
            }
        }
        // `restoreQueued` of an entry that is not queued (it started, or was taken) answers
        // `count: 0` and the composer's own text, not an error.
        if req.method.as_str() == "thread/queue/delete" {
            if let Some(reply) = self.restore_miss(&req) {
                let _ = tx.send(Ok(Reply::Value(reply)));
                return Ok(());
            }
        }
        // A retried submission joins the original (`drain-enqueue.mjs:37`): an idempotent success, not a second prompt.
        if req.method.as_str() == "turn/start"
            && let Ok(params) = parse::<TurnStartParams>(&req.params, "TurnStartParams")
            && display_text(&params.input) != ""
            && let Some(answer) = submission_id(&params.input).and_then(|id| self.submissions.answers.get(id))
        {
            let _ = tx.send(Ok(Reply::Value(answer.clone())));
            return Ok(());
        }
        let tx = if req.method.as_str() == "turn/start"
            && let Ok(params) = parse::<TurnStartParams>(&req.params, "TurnStartParams")
            && display_text(&params.input) != ""
            && let Some(id) = submission_id(&params.input)
        {
            match self.submissions.join(id, tx) {
                Some(tx) => tx,
                None => return Ok(()),
            }
        } else {
            tx
        };
        let result = match req.method.as_str() {
            "turn/start" => self.turn_start(&req),
            "thread/queue/delete" => self.queue_delete(&req),
            "thread/rewind" => self.rewind(&req),
            "thread/clear" => self.clear(&req),
            "thread/name/set" => self.name_set(&req),
            "thread/header/patch" => self.header_patch(&req),
            "thread/boundary/record" => self.boundary_record(&req),
            "thread/reactions/apply" => self.reactions_apply(&req),
            "thread/roomRows/commit" => self.room_rows_commit(&req),
            _ => Err(invalid("method", "a session-actor method")),
        };
        match result {
            Ok(plan) => {
                // The plan's records are one unit, written together. Rows stored as a conversation (an inheritance, a room
                // post, an import) are kept for the next write when theirs fails, as Node's recorder keeps them.
                self.outbox.begin_unit(req.method.as_str() == "thread/roomRows/commit");
                self.apply_plan(plan, req.op.clone(), tx);
                if req.method.as_str() == "thread/header/patch" {
                    let mut keys: Vec<String> = req.params.get("expect").and_then(Value::as_object).map(|expect| expect.keys().cloned().collect()).unwrap_or_default();
                    if req.params.get("expectedGeneration").and_then(Value::as_f64).is_some() {
                        keys.extend(["generation".to_owned(), "closed".to_owned()]);
                    }
                    if !keys.is_empty()
                        && let Some(entry) = self.outbox.last_mut()
                    {
                        entry.effects.push(Effect::Decided(keys));
                    }
                }
                self.outbox.end_unit();
                Ok(())
            }
            Err(error) => fail(error, tx, &mut self.ops),
        }
    }

    fn apply_plan(&mut self, plan: Plan, op: Option<OpId>, tx: Waiter) {
        let reply = Effect::Reply {
            op,
            tx: Some(tx),
            value: plan.value,
        };
        match plan.kind {
            PlanKind::StartRun(input, op_ref) => {
                self.start_run(input, op_ref, Some(reply), plan.prompt);
            }
            PlanKind::Records(records, extra) => {
                let last = records.len().saturating_sub(1);
                let mut reply = Some(reply);
                for (index, (record, class, display, notes)) in records.into_iter().enumerate() {
                    let mut effects = Vec::new();
                    if index == last {
                        effects.extend(reply.take());
                        effects.extend(
                            plan.after.map(|publish| Effect::RecomputePrompts { publish }),
                        );
                    }
                    self.accept_record(record, class, display, notes, effects);
                }
                for change in extra {
                    self.accept_view(change, Vec::new());
                }
                if let Some(prompt) = plan.prompt {
                    self.persist_prompt(prompt);
                }
            }
        }
    }

    fn turn_start(&mut self, req: &CoreRequest) -> Result<Plan, CoreError> {
        let params: TurnStartParams = parse(&req.params, "TurnStartParams")?;
        let user_prompt = matches!(req.ctx.caller, Caller::Connection(_))
            .then(|| display_text(&params.input));
        if user_prompt.is_some() && params.input.options.as_ref().is_some_and(|o| o.context.is_some() || o.attachment_sizes.is_some()) {
            return Err(invalid("input.options", "context and attachmentSizes are host-only options"));
        }
        // `submission` (`submission.mjs:10`): a prompt that shows nothing is not a submission. Node answers `false`
        // before the session is touched; the wire answers a refusal with this code.
        if user_prompt.is_some() && display_text(&params.input).is_empty() {
            return Err(coded("session", SUBMIT_REFUSED, "The message is empty."));
        }
        // A deleted bot's chat is kept to read, never to talk to (`submitToSession` asks `sessionMetadata.isRetired`: the
        // retirement stamp, `retiredAt` here).
        if self.projected.header.get("retiredAt").and_then(Value::as_f64).is_some_and(|at| at > 0.0) {
            return Err(coded("session", SUBMIT_REFUSED, "This bot was deleted."));
        }
        // The device that sent a user prompt rides it (`transcriptMeta.device`, stamped by the host in Node).
        let submitter = match req.ctx.caller {
            Caller::Connection(connection) => Some(Submitter {
                device: self.deps.devices.describe(connection).device,
                restorable: params.input.options.as_ref().and_then(|options| options.kickoff) != Some(true),
            }),
            _ => None,
        };
        if user_prompt.is_some() {
            // `cancelQuotaResumeOnUserInput`: new user input supersedes the stopped turn.
            self.quota_cancel_now();
            let (settlement, id) = (self.quota.settlement.clone(), self.id.as_str().to_owned());
            self.quota.call(async move {
                if let Err(error) = settlement.cancel_on_user_input(&id).await {
                    tracing::warn!("a quota resume was cancelled in memory but its entry was not removed: {error:?}");
                }
            });
            self.archive_goal_on_user_input();
        }
        // A turn starting or still settling holds the next one back: it is queued and starts after.
        if !self.turn_busy() {
            let value = json!({ "kind": "started" });
            let op_ref = self.op_ref(req, None)?;
            self.submitter = submitter;
            if let Some(submission) = submission_id(&params.input) {
                self.submissions.starting = Some((submission.to_owned(), Vec::new()));
            }
            return Ok(Plan {
                kind: PlanKind::StartRun(params.input, op_ref),
                value,
                after: None,
                prompt: user_prompt,
            });
        }
        let qid = new_id();
        let value = json!({ "kind": "queued", "queuedId": qid });
        if let Some(submission) = submission_id(&params.input) {
            self.submissions.remember(submission, value.clone());
        }
        let mut entry = json!({
            "message": params.input.prompt,
            "enqueuedAt": self.deps.clock.now_ms(),
        });
        if let Some(options) = &params.input.options {
            // The entry's priority is its own top-level field, as Node's queue entries carry it
            // (`within_priority`); the options keep the rest.
            let mut options = options.clone();
            if let Some(priority) = options.priority.take() {
                entry["priority"] = serde_json::to_value(priority).expect("protocol types serialize");
            }
            // Likewise the follow-up's `context` (`entry-shape.mjs:32`); the queued turn runs
            // without it (`queuedTurnInput` re-applies no caller context).
            if let Some(context) = options.context.take() {
                entry["context"] = Value::String(context);
            }
            entry["options"] = serde_json::to_value(&options).expect("protocol types serialize");
        }
        // `defaultQueuePriority` (`queue-helpers.mjs:28`): a user prompt that names none queues at `next`.
        if entry.get("priority").is_none() {
            entry["priority"] = json!("next");
        }
        // The entry's `transcriptMeta` (`pending-messages`; read by `mergeSteeringMetadata`,
        // `steering.mjs:62`): the hop and bot chain a host submitter gave this submission. Only a
        // host submission has them (`SubmitOptions` refuses `hop`), registered under its id.
        let host_meta = params.input.options.as_ref().and_then(|o| o.client_submission_id.as_deref()).and_then(|submission| {
            let starts = self.cell.routine_starts.lock().unwrap_or_else(|p| p.into_inner());
            let start = starts.get(submission)?;
            let mut meta = serde_json::Map::new();
            if let Some(hop) = start.hop {
                meta.insert("hop".into(), json!(hop));
            }
            if !start.bot_chain.is_empty() {
                meta.insert("botChain".into(), json!(start.bot_chain));
            }
            (!meta.is_empty()).then_some(Value::Object(meta))
        });
        if let Some(meta) = host_meta {
            entry["transcriptMeta"] = meta;
        }
        // The device and the composer's claim travel with the entry until it becomes a turn (`start_next_queued`).
        if let Some(submitter) = &submitter {
            if !submitter.device.is_empty() {
                entry["transcriptMeta"]["device"] = json!(submitter.device);
            }
            entry["restorable"] = json!(submitter.restorable);
        }
        let record = Record::Queue(QueueRecord {
            qid: id(&qid),
            action: QueueAction::Enqueue,
            reason: None,
            op: self.op_ref(req, Some(&value))?,
            entry: Some(Slot::Inline(entry.clone())),
        });
        let display = Display::Queued(self.deps.transcript.queued(&qid, &entry));
        // New input ends the running turn's passive `task wait` / shell hold, as today.
        self.deps.wakes.interrupt(&self.id, WakeReason::UserMessage, None);
        Ok(Plan {
            kind: PlanKind::Records(vec![(record, Class::Normal, display, Vec::new())], Vec::new()),
            value,
            after: None,
            prompt: user_prompt,
        })
    }

    /// The `restoreQueued` reply of a hand-back whose entry is not in the queue; `None` for any
    /// other request (a malformed one fails in [`Self::queue_delete`]).
    fn restore_miss(&self, req: &CoreRequest) -> Option<Value> {
        let params: ThreadQueueDeleteParams = parse(&req.params, "ThreadQueueDeleteParams").ok()?;
        let taken = restore_taken(&self.projected.queue, params.queued_id.as_ref().map(QueuedId::as_str));
        (params.restore && taken.is_empty()).then(|| restored_reply(&[], params.current_text.as_deref()))
    }

    fn queue_delete(&mut self, req: &CoreRequest) -> Result<Plan, CoreError> {
        let params: ThreadQueueDeleteParams = parse(&req.params, "ThreadQueueDeleteParams")?;
        // A hand-back without an id takes every queued entry back, as `restoreQueued('', '')` does; a delete
        // names its entry.
        let wanted = match (&params.queued_id, params.restore) {
            (Some(qid), _) => Some(qid.as_str()),
            (None, true) => None,
            (None, false) => return Err(invalid("queuedId", "a queued entry id")),
        };
        let queued = restore_taken(&self.projected.queue, wanted);
        if queued.is_empty() {
            let queued_id = params.queued_id.clone().ok_or_else(|| invalid("queuedId", "a queued entry id"))?;
            return Err(CoreError::QueuedEntryNotFound { thread_id: self.id.clone(), queued_id });
        }
        let taken: Vec<Taken> = queued.iter().map(Taken::of).collect();
        // A hand-back answers Node's `restoreQueued` reply; a plain delete answers `{}`.
        let value = if params.restore { restored_reply(&taken, params.current_text.as_deref()) } else { json!({}) };
        let mut records = Vec::new();
        for (index, entry) in queued.iter().enumerate() {
            // The op's result rides the first record only.
            let op = if index == 0 { self.op_ref(req, Some(&value))? } else { None };
            let record = Record::Queue(QueueRecord {
                qid: id(&entry.qid),
                action: QueueAction::Dequeue,
                reason: Some(DequeueReason::Cancelled),
                op,
                entry: None,
            });
            records.push((record, Class::Normal, Display::None, Vec::new()));
        }
        let mut extra = Vec::new();
        if params.restore {
            let device = match req.ctx.caller {
                Caller::Connection(connection) => self.deps.devices.describe(connection).device,
                Caller::Internal(name) => name.to_owned(),
            };
            let present = |text: &&String| !mixdog_js::js_trim(text).is_empty();
            let text = taken.iter().map(|entry| &entry.text).filter(present).cloned().collect::<Vec<_>>().join("\n");
            extra.push(Change::Section(Section::PromptRestore(Some(PromptRestore {
                id: queued[0].qid.clone(),
                ids: queued.iter().map(|entry| entry.qid.clone()).collect(),
                text,
                device,
                at: self.deps.clock.now_ms(),
            }))));
            extra.extend(taken.into_iter().map(|entry| Change::PromptWithout(entry.text)));
        }
        Ok(Plan {
            kind: PlanKind::Records(records, extra),
            value,
            after: None,
            prompt: None,
        })
    }

    fn history_reset(&self, reason: HistoryResetReason, from: Option<mixdog_core_api::ids::ItemId>) -> Note {
        Note::new(
            "thread/historyReset",
            &ThreadHistoryResetParams {
                thread_id: self.id.clone(),
                reason,
                // A rewind target is inside the window, so the rows older than the window
                // stay; a clear starts an empty lineage.
                has_older: reason == HistoryResetReason::Rewind && self.acked.has_older,
                from_item_id: from,
            },
        )
    }

    /// One `meta` record setting the keys of `set` that differ from the header, or `None` when all agree.
    fn header_set_change(&self, set: serde_json::Map<String, Value>) -> Option<Record> {
        let set: serde_json::Map<String, Value> = set.into_iter().filter(|(key, value)| self.projected.header.get(key) != Some(value)).collect();
        (!set.is_empty()).then(|| Record::Meta(MetaRecord { op: None, change: Slot::Inline(HeaderChange { set, unset: Vec::new() }) }))
    }

    /// `stampTurnHop` / `raiseTurnHop` set `session.turnHop` and `session.turnBotChain`, which the session's
    /// next save writes: the turn's hop and bot chain, as the in-memory turn state holds them now.
    fn sync_turn_chain(&mut self) {
        let mut set = serde_json::Map::new();
        set.insert("turnHop".into(), json!(self.cell.turn_chain.hop()));
        set.insert("turnBotChain".into(), json!(self.cell.turn_chain.bots()));
        if let Some(record) = self.header_set_change(set) {
            self.accept_record(record, Class::Normal, Display::None, Vec::new(), Vec::new());
        }
    }

    /// Today's `rewindToItem`: the target is a user row; it and everything after it leave the
    /// lineage, and its text goes back to the composer (and out of the Up-arrow list).
    /// The `meta` record that makes the header's `providerState` `state` (`None` deletes the
    /// key), or `None` when it already is.
    fn provider_state_change(&self, state: Option<Value>) -> Option<Record> {
        if self.projected.header.get(PROVIDER_STATE) == state.as_ref() {
            return None;
        }
        let mut change = HeaderChange {
            set: serde_json::Map::new(),
            unset: Vec::new(),
        };
        match state {
            Some(state) => {
                change.set.insert(PROVIDER_STATE.into(), state);
            }
            None => change.unset.push(PROVIDER_STATE.into()),
        }
        Some(Record::Meta(MetaRecord {
            op: None,
            change: Slot::Inline(change),
        }))
    }

    fn rewind(&mut self, req: &CoreRequest) -> Result<Plan, CoreError> {
        let params: ThreadRewindParams = parse(&req.params, "ThreadRewindParams")?;
        // Idle-only, as today: a live turn must be interrupted first.
        if self.run.is_some() {
            return Err(CoreError::PreconditionFailed {
                precondition: mixdog_core_api::error::Precondition::Revision {
                    expected: "idle".into(),
                    actual: "running".into(),
                },
            });
        }
        let not_found = || CoreError::ItemNotFound {
            thread_id: self.id.clone(),
            item_id: params.item_id.clone(),
        };
        let window = &self.acked.window;
        // The client holds the displayed id (a user row shows its submission id); Node resolves it first (`rewind.mjs:19`).
        let index = super::transcript::position_of_id(window.iter().map(|row| row.item.as_ref()), params.item_id.as_str()).ok_or_else(not_found)?;
        let target = &window[index];
        let (Some(ordinal), Some(text)) = (target.ordinal, target.prompt.clone()) else {
            return Err(not_found());
        };
        let previous = index.checked_sub(1).map(|i| window[i].item.id().clone());
        // `messages`: the model-history messages dropped (`rewindSessionMessagesTo`'s `removed`), beside the rows (`rewind.mjs`).
        let messages: u32 = window.iter().skip(index).map(|row| row.messages).sum();
        let value = json!({ "text": text, "removed": window.len() - index, "messages": messages });
        let record = Record::Rewind(RewindRecord {
            to_ordinal: ordinal,
            reason: RewindReason::Rewind,
            op: self.op_ref(req, Some(&value))?,
        });
        self.transcript_rewritten = true;
        // The saved request carried the truncated transcript (`session-crud.mjs:475`).
        self.deps.side.forget(&self.id, false);
        let note = self.history_reset(HistoryResetReason::Rewind, previous);
        let mut records = vec![(record, Class::Normal, Display::None, vec![note])];
        // The provider continuation is keyed on the truncated prefix (`session-crud.mjs:473`).
        if let Some(reset) = self.provider_state_change(None) {
            records.push((reset, Class::Normal, Display::None, Vec::new()));
        }
        Ok(Plan {
            kind: PlanKind::Records(records, vec![Change::PromptWithout(text)]),
            value,
            after: Some(false),
            prompt: None,
        })
    }

    fn clear(&mut self, req: &CoreRequest) -> Result<Plan, CoreError> {
        let _: ThreadOpParams = parse(&req.params, "ThreadOpParams")?;
        let value = json!({});
        let to_ordinal = self.acked.lineage_start;
        let record = Record::Rewind(RewindRecord {
            to_ordinal,
            reason: RewindReason::Clear,
            op: self.op_ref(req, Some(&value))?,
        });
        self.transcript_rewritten = true;
        // The saved request carried the cleared transcript (`session-crud.mjs:345`).
        self.deps.side.forget(&self.id, false);
        let note = self.history_reset(HistoryResetReason::Clear, None);
        let mut records = vec![(record, Class::Normal, Display::None, vec![note])];
        // A cleared session starts without provider state (`session-crud.mjs:137`), and with its
        // environment reset (`resetSessionBp3Environment`), in one header change.
        let mut change = self.deps.route_change.environment_reset(&self.projected.header);
        if self.projected.header.contains_key(PROVIDER_STATE) {
            change.set.shift_remove(PROVIDER_STATE);
            if !change.unset.iter().any(|key| key == PROVIDER_STATE) {
                change.unset.push(PROVIDER_STATE.into());
            }
        }
        if !change.set.is_empty() || !change.unset.is_empty() {
            let reset = Record::Meta(MetaRecord { op: None, change: Slot::Inline(change) });
            records.push((reset, Class::Normal, Display::None, Vec::new()));
        }
        // `supersedeQuotaResume`: a cleared session's wait goes.
        self.quota_cancel_now();
        let (settlement, id) = (self.quota.settlement.clone(), self.id.as_str().to_owned());
        self.quota.call(async move {
            if let Err(error) = settlement.supersede(&id).await {
                tracing::warn!("a quota resume was superseded in memory but its entry was not removed: {error:?}");
            }
        });
        // A cleared session starts with no toasts (`emptySessionPatch`), and none of the old ones expires (`beginTuiReset`, `session-reset.mjs:50`).
        self.cancel_toast_timers();
        Ok(Plan {
            kind: PlanKind::Records(records, vec![Change::Section(Section::Toasts(Vec::new())), Change::Section(Section::ActiveTools(None))]),
            value,
            after: Some(true),
            prompt: None,
        })
    }

    fn name_set(&mut self, req: &CoreRequest) -> Result<Plan, CoreError> {
        let params: ThreadNameSetParams = parse(&req.params, "ThreadNameSetParams")?;
        // `updateSessionManualTitle` (`session-crud.mjs:103-115`) writes nothing and answers `false` for a closed session, a
        // title that is empty once normalized, and the title the user already gave; the desktop host turns that `false` into
        // `Session is not available.` (`session-host-lifecycle.ts:228`), the text the window shows.
        let refuse = |text: &str| CoreError::DomainError { domain: "thread".into(), code: None, message: Some(text.into()), detail: None };
        // The checks in the order Node ran them: `sessionDisplayName` (IPC / remote method), then the host's, then the runtime's.
        let shown = mixdog_js::js_trim(&params.title);
        if shown.is_empty() || shown.encode_utf16().count() > 1_024 || shown.chars().any(|c| c <= '\u{1f}' || c == '\u{7f}') {
            return Err(refuse(TITLE_INVALID));
        }
        let title = super::session_title::normalize_title(&params.title);
        if title.is_empty() {
            return Err(refuse(SESSION_TITLE_INVALID));
        }
        let header = &self.projected.header;
        let user_titled = header.get("title").and_then(Value::as_str) == Some(title.as_str())
            && header.get("titleLocked") == Some(&Value::Bool(true))
            && header.get("titleSource").and_then(Value::as_str) == Some("user");
        if header.get("closed") == Some(&Value::Bool(true)) || user_titled {
            return Err(refuse(SESSION_NOT_AVAILABLE));
        }
        let value = json!({});
        let mut set = serde_json::Map::new();
        set.insert("title".into(), Value::String(title));
        // A name the user gave, with the keys Node's `updateSessionManualTitle` writes (`session-crud.mjs`):
        // no generated, model or retired-home title replaces it.
        set.insert("titleLocked".into(), Value::Bool(true));
        set.insert("titleSource".into(), Value::String("user".to_owned()));
        set.insert("titleUpdatedAt".into(), json!(self.deps.clock.now_ms()));
        let record = Record::Meta(MetaRecord {
            op: self.op_ref(req, Some(&value))?,
            change: Slot::Inline(HeaderChange {
                set,
                unset: Vec::new(),
            }),
        });
        Ok(Plan {
            kind: PlanKind::Records(
                vec![(record, Class::Normal, Display::None, Vec::new())],
                Vec::new(),
            ),
            value,
            after: None,
            prompt: None,
        })
    }

    /// The projected values of the keys a patch expects (`expect`: key to the value it was
    /// computed from, `null` for absent) when any of them has moved; `None` when the patch
    /// stands. A patch without `expect` always stands.
    fn header_conflict(&self, params: &Value) -> Option<Value> {
        let expect = params.get("expect")?.as_object()?;
        let current: serde_json::Map<String, Value> = expect
            .keys()
            .map(|key| (key.clone(), self.projected.header.get(key).cloned().unwrap_or(Value::Null)))
            .collect();
        (current != *expect).then_some(Value::Object(current))
    }

    /// `thread/header/patch {set, unset}`: the core's own header writes (held routes, worker
    /// rows), one `meta` record answered once durable. Internal callers only: a connection
    /// never writes header keys directly.
    fn header_patch(&mut self, req: &CoreRequest) -> Result<Plan, CoreError> {
        if matches!(req.ctx.caller, Caller::Connection(_)) {
            return Err(invalid("method", "an internal method"));
        }
        let set = match req.params.get("set") {
            None | Some(Value::Null) => serde_json::Map::new(),
            Some(Value::Object(set)) => set.clone(),
            Some(_) => return Err(invalid("set", "an object of header keys")),
        };
        let unset: Vec<String> = match req.params.get("unset") {
            None | Some(Value::Null) => Vec::new(),
            Some(value) => serde_json::from_value(value.clone())
                .map_err(|_| invalid("unset", "a list of header keys"))?,
        };
        let value = json!({});
        let record = Record::Meta(MetaRecord {
            op: self.op_ref(req, Some(&value))?,
            change: Slot::Inline(HeaderChange { set, unset }),
        });
        Ok(Plan {
            kind: PlanKind::Records(
                vec![(record, Class::Normal, Display::None, Vec::new())],
                Vec::new(),
            ),
            value,
            after: None,
            prompt: None,
        })
    }

    /// `thread/boundary/record {anchor, entry, turn?, item?}`: a display-only model-switch
    /// boundary on an already stored row (option (a): no stored row is rewritten), answered once
    /// durable. `item` is the row it shows after the anchor's (`live_model_switch`). Internal
    /// callers only.
    fn boundary_record(&mut self, req: &CoreRequest) -> Result<Plan, CoreError> {
        if matches!(req.ctx.caller, Caller::Connection(_)) {
            return Err(invalid("method", "an internal method"));
        }
        let anchor: Anchor = req
            .params
            .get("anchor")
            .and_then(|anchor| serde_json::from_value(anchor.clone()).ok())
            .ok_or_else(|| invalid("anchor", "{iid, ordinal} of a stored row"))?;
        if anchor.ordinal >= self.acked_end {
            return Err(invalid("anchor", "a row stored before the boundary"));
        }
        let entry: ModelSwitchEntry = req
            .params
            .get("entry")
            .and_then(|entry| serde_json::from_value(entry.clone()).ok())
            .ok_or_else(|| invalid("entry", "{provider, modelId, at}"))?;
        let item = match req.params.get("item") {
            None | Some(Value::Null) => None,
            Some(item) => Some(
                serde_json::from_value::<ThreadItem>(item.clone()).map_err(|_| invalid("item", "a thread item"))?,
            ),
        };
        let turn = TurnId::from(req.params.get("turn").and_then(Value::as_str).unwrap_or_default());
        let notes = item
            .iter()
            .map(|item| {
                Note::new(
                    "item/completed",
                    &ItemNotificationParams { thread_id: self.id.clone(), turn_id: turn.clone(), item: item.clone() },
                )
            })
            .collect();
        let display = match item {
            Some(item) => Display::Items(vec![Shown::Item(item)]),
            None => Display::None,
        };
        let value = json!({});
        let record =
            Record::ModelSwitch(ModelSwitchRecord { anchor, op: self.op_ref(req, Some(&value))?, entry: Slot::Inline(entry) });
        Ok(Plan {
            kind: PlanKind::Records(vec![(record, Class::Normal, display, notes)], Vec::new()),
            value,
            after: None,
            prompt: None,
        })
    }

    /// `thread/reactions/apply {iid, refs, body, turn, items}`: a bot's reaction stored on a
    /// user message, as an amend of that row's body (`meta.transcript.reactions`); `items` are the
    /// row's items re-shown with it, merged into the view and published as `item/completed`.
    /// Internal callers only (the handle's `thread/reactions/set` computes the body).
    fn reactions_apply(&mut self, req: &CoreRequest) -> Result<Plan, CoreError> {
        if matches!(req.ctx.caller, Caller::Connection(_)) {
            return Err(invalid("method", "an internal method"));
        }
        let field = |name: &str| req.params.get(name).cloned().unwrap_or(Value::Null);
        let iid = text(req.params.get("iid").and_then(Value::as_str).unwrap_or_default(), "iid")?;
        let refs: Refs = serde_json::from_value(field("refs")).map_err(|_| invalid("refs", "the row's blob digests"))?;
        let body = field("body");
        if !body.is_object() {
            return Err(invalid("body", "the amended message"));
        }
        let items: Vec<ThreadItem> =
            serde_json::from_value(field("items")).map_err(|_| invalid("items", "the row's thread items"))?;
        let turn = TurnId::from(req.params.get("turn").and_then(Value::as_str).unwrap_or_default());
        let notes = items
            .iter()
            .map(|item| {
                Note::new(
                    "item/completed",
                    &ItemNotificationParams { thread_id: self.id.clone(), turn_id: turn.clone(), item: item.clone() },
                )
            })
            .collect();
        let display = Display::Items(items.into_iter().map(Shown::Update).collect());
        let value = json!({});
        let record = Record::Amend(AmendRecord { iid, op: self.op_ref(req, Some(&value))?, refs, body: Slot::Inline(body) });
        Ok(Plan {
            kind: PlanKind::Records(vec![(record, Class::Normal, display, notes)], Vec::new()),
            value,
            after: None,
            prompt: None,
        })
    }

    /// `thread/roomRows/commit {messages}`: a room post's new rows (the handle's
    /// `thread/roomRows/append` drops the ones already held), each a model row of no turn shown
    /// live as it lands, then `updatedAt`; answers `{added}` once durable. Internal callers
    /// only.
    fn room_rows_commit(&mut self, req: &CoreRequest) -> Result<Plan, CoreError> {
        if matches!(req.ctx.caller, Caller::Connection(_)) {
            return Err(invalid("method", "an internal method"));
        }
        // Each row as the handle read its facts: `{body, visible, prompt}`.
        let rows = req.params.get("rows").and_then(Value::as_array).cloned().unwrap_or_default();
        let mut records = Vec::with_capacity(rows.len() + 1);
        for mut row in rows {
            let body = row.get_mut("body").map(Value::take).unwrap_or(Value::Null);
            let role = body.get("role").and_then(Value::as_str).map(|role| text(role, "role")).transpose()?;
            let prompt = row.get("prompt").and_then(Value::as_str).map(|prompt| Slot::Inline(prompt.to_owned()));
            let row = ItemRecord {
                iid: text(&new_id(), "itemId")?,
                turn: None,
                role,
                form: Form::Message,
                model: true,
                visible: row.get("visible") != Some(&Value::Bool(false)),
                archive: None,
                op: None,
                prompt,
                refs: Vec::new().try_into().expect("empty list fits"),
                body: Slot::Inline(body),
            };
            records.push((Record::Item(row), Class::Normal, Display::None, Vec::new()));
        }
        let value = json!({ "added": records.len() });
        // Header keys stored with the rows (an inheritance's `inheritedFromSessionId` and title: Node saves them with the
        // carried messages in one save).
        let mut set = match req.params.get("set") {
            Some(Value::Object(set)) => set.clone(),
            _ => serde_json::Map::new(),
        };
        set.insert("updatedAt".into(), json!(self.deps.clock.now_ms()));
        // And the keys the same save drops (an inheritance's copy-in-progress marks: the heir stops inheriting with the
        // write that gives it the rows).
        let unset: Vec<String> = match req.params.get("unset") {
            None | Some(Value::Null) => Vec::new(),
            Some(value) => serde_json::from_value(value.clone()).map_err(|_| invalid("unset", "a list of header keys"))?,
        };
        let meta = Record::Meta(MetaRecord { op: None, change: Slot::Inline(HeaderChange { set, unset }) });
        records.push((meta, Class::Normal, Display::None, Vec::new()));
        // A row's prompt joins the prompt history as it is applied.
        Ok(Plan { kind: PlanKind::Records(records, Vec::new()), value, after: None, prompt: None })
    }

    /// The session store's `setup-ui` action (`set({ setupUiRequest: { id, at: Date.now() } })`):
    /// the request is thread state, so a snapshot carries it as a replay does, until it is
    /// settled or its claim window ends.
    fn setup_ui_request(&mut self, id: String, window: std::time::Duration) {
        let request = mixdog_app_protocol::v2::thread::SetupUiRequest { id: id.clone(), at: self.deps.clock.now_ms() };
        self.accept_view(Change::Section(Section::SetupUiRequest(Some(request))), Vec::new());
        let jobs = self.jobs_tx.clone();
        tokio::spawn(async move {
            mixdog_rt::time::sleep(window).await;
            let _ = jobs.send(JobDone::SetupUiExpired(id));
        });
    }

    /// The request `id` can no longer be claimed: the thread stops showing it, unless a newer
    /// request took its place.
    fn setup_ui_settled(&mut self, id: &str) {
        if self.projected.sections.setup_ui_request.as_ref().is_some_and(|request| request.id == id) {
            self.accept_view(Change::Section(Section::SetupUiRequest(None)), Vec::new());
        }
    }

    /// A job of this thread was added or finished (`emitSessionActivityChange(ownerSessionId)`).
    /// The idle clock starts over (`refresh`), and the agent status is read again (the agent
    /// tool's `statusMayHaveChanged`). A closed thread has no runtime to tell.
    fn agent_activity(&mut self) {
        if self.tombstoned || self.cell.closed.load(SeqCst) {
            return;
        }
        if self.idle_evict_at.is_some() {
            self.arm_idle_evict();
        }
        self.read_agent_status(true);
    }

    /// The agents section's scope as the header now gives it, with the rows it holds: seated in the step that moves the
    /// header (load, a route move), so no state shows the thread without its scope or with the old one. `None` when it holds it.
    fn agents_with_scope(&self) -> Option<mixdog_app_protocol::v2::thread::ThreadAgents> {
        let current = self.projected.sections.agents.clone().unwrap_or_default();
        let scope = super::agent_registry::status_rows::agent_scope(&self.id, &self.projected.header);
        (current.agent_scope.as_ref() != Some(&scope)).then(|| mixdog_app_protocol::v2::thread::ThreadAgents { agent_scope: Some(scope), ..current })
    }

    /// Reads the thread's agent status off the actor. `listener`: the read is the status
    /// listener's (`onAgentStatusChange`), which also schedules the Goal continuation; the
    /// load's first status pass (`runtimePulse`) only publishes.
    fn read_agent_status(&self, listener: bool) {
        let (jobs, status, thread) = (self.jobs_tx.clone(), self.deps.agent_status.clone(), self.id.clone());
        tokio::spawn(async move {
            if !listener {
                mixdog_rt::time::sleep(STATUS_SETTLE).await;
            }
            let agents = status.status(&thread).await;
            let _ = jobs.send(JobDone::AgentStatus { agents, listener });
        });
    }

    /// The load's status pass also runs `syncContextStats` (local-session-runtime.mjs createRuntimePulse): the context status of
    /// the thread, read off the actor one settle beat later, fills the display fields.
    fn read_context_display(&self) {
        let (jobs, gauge, thread) = (self.jobs_tx.clone(), self.deps.context_status.clone(), self.id.clone());
        tokio::spawn(async move {
            mixdog_rt::time::sleep(STATUS_SETTLE).await;
            let status = gauge.context_status(Some(thread), None).await.unwrap_or(Value::Null);
            let _ = jobs.send(JobDone::ContextStatus(status));
        });
    }

    /// The workspace `routeState` publishes (`getLiveWorkspace`), read off the actor: at load and whenever the header's `cwd`,
    /// `workspace` or `desktopSession` moved.
    fn read_live_workspace(&mut self) {
        self.live_workspace_reads += 1;
        let (jobs, live, thread, read) = (self.jobs_tx.clone(), self.deps.live_workspace.clone(), self.id.clone(), self.live_workspace_reads);
        tokio::spawn(async move {
            let workspace = live.live(thread.as_str()).await;
            let _ = jobs.send(JobDone::LiveWorkspace(read, workspace));
        });
    }

    /// `syncContextDisplayFields(status)` (context-state.mjs:116-136): the window the status shows, the compaction boundary and
    /// the auto-compact trigger (`compaction.triggerTokens || compaction.autoCompactTokenLimit || session.autoCompactTokenLimit`),
    /// each only once known (> 0).
    fn context_display(&mut self, status: &Value) {
        if self.tombstoned || self.cell.closed.load(SeqCst) || !status.is_object() {
            return;
        }
        let context = self.display_figures(status);
        if context != ThreadContext::default() {
            self.on_context_section(context);
        }
    }

    /// The display fields `syncContextDisplayFields` takes from `status`, each only once known (> 0).
    fn display_figures(&self, status: &Value) -> ThreadContext {
        let positive = |value: Option<&Value>| value.and_then(Value::as_f64).filter(|n| n.is_finite() && *n > 0.0).map(|n| n as i64);
        let compaction = status.get("compaction");
        ThreadContext {
            display_context_window: positive(status.get("contextWindow")),
            compact_boundary_tokens: positive(compaction.and_then(|c| c.get("boundaryTokens"))),
            auto_compact_token_limit: positive(compaction.and_then(|c| c.get("triggerTokens")))
                .or_else(|| positive(compaction.and_then(|c| c.get("autoCompactTokenLimit"))))
                .or_else(|| positive(self.projected.header.get("autoCompactTokenLimit"))),
            ..Default::default()
        }
    }

    /// The header a `thread/header/patch` leaves when it moves the session's route window (`updateSessionRoute`); `None` for any
    /// other request, and while a turn runs (its display fields wait for the turn's end, [`Self::on_context_section`]).
    fn window_move_header(&self, req: &CoreRequest) -> Option<Header> {
        if req.method.as_str() != "thread/header/patch" || matches!(req.ctx.caller, Caller::Connection(_)) || self.run.is_some() {
            return None;
        }
        let set = req.params.get("set").and_then(Value::as_object);
        let unset: Vec<&str> = req.params.get("unset").and_then(Value::as_array).map(|keys| keys.iter().filter_map(Value::as_str).collect()).unwrap_or_default();
        self.window_move_of(set, &unset)
    }

    /// The header `set`/`unset` leave when they move the route window; `None` when they do not.
    fn window_move_of(&self, set: Option<&serde_json::Map<String, Value>>, unset: &[&str]) -> Option<Header> {
        let header = &self.projected.header;
        let moves = WINDOW_KEYS.iter().any(|key| {
            set.and_then(|set| set.get(*key)).is_some_and(|value| header.get(*key) != Some(value)) || (unset.contains(key) && header.contains_key(*key))
        });
        if !moves {
            return None;
        }
        let mut next = header.clone();
        for key in unset {
            next.shift_remove(*key);
        }
        for (key, value) in set.into_iter().flatten() {
            next.insert(key.clone(), value.clone());
        }
        Some(next)
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

    /// A route move as a pending step: the new route's context status is read off the actor for the header the move writes, and the
    /// actor goes on serving (a cancel, a read, a turn: in Node the read is awaited by `setRoute` alone, routes-write.mjs:168, and a
    /// turn started meanwhile runs on the route the runtime holds, set-route.mjs:272,300-311). When the read returns, the move is
    /// accepted with its figures in one step ([`Self::accept_record_entry`]) and answered after it.
    fn start_route_move(&mut self, apply: MoveApply, header: Header) {
        self.route_moves += 1;
        let (seq, jobs, gauge, thread) = (self.route_moves, self.jobs_tx.clone(), self.deps.context_status.clone(), self.id.clone());
        tokio::spawn(async move {
            let status = match mixdog_rt::time::timeout(ROUTE_STATUS_DEADLINE,gauge.context_status_for(thread.clone(), header)).await {
                Ok(Ok(status)) if status.is_object() => Some(status),
                Ok(Ok(_)) => None,
                Ok(Err(error)) => {
                    tracing::warn!(thread = %thread, "the route move's context status failed: {error:?}");
                    None
                }
                Err(_) => {
                    tracing::warn!(thread = %thread, "the route move's context status missed its {}s deadline", ROUTE_STATUS_DEADLINE.as_secs());
                    None
                }
            };
            let _ = jobs.send(JobDone::RouteStatus { seq, status });
        });
        self.route_move = Some(PendingMove { seq, apply });
    }

    /// The pending route move `seq` read its figures (`None`: the read failed): the move is written now, with them.
    fn route_status_read(&mut self, seq: u64, status: Option<Value>) {
        let Some(pending) = self.route_move.take_if(|pending| pending.seq == seq) else { return };
        self.route_status = Some(status);
        match pending.apply {
            MoveApply::Request { req, tx } => self.on_inbox(Inbox::Request { req, tx }),
            MoveApply::Change { change, tx } => self.write_header_change(change, tx),
        }
        self.route_status = None;
    }

    /// The display figures of a route move whose status read failed, as Node's `syncContextStats` leaves them when the runtime has no
    /// status (context-state.mjs:137-142: no patch) and `publishRoute` publishes `routeState()`: the figures held for an unchanged
    /// window, 0 for a moved one (context-state.mjs:100-113). Nothing is read again for it.
    fn unread_figures(&self, before: &(Option<Value>, Option<Value>)) -> ThreadContext {
        let header = &self.projected.header;
        if (header.get("contextWindow").cloned(), header.get("rawContextWindow").cloned()) == *before {
            return ThreadContext::default();
        }
        ThreadContext { display_context_window: Some(0), compact_boundary_tokens: Some(0), auto_compact_token_limit: Some(0), ..Default::default() }
    }

    /// `set({ ...agentStatusState() })` publishes the lists only when they changed. A thread
    /// that never published them shows Node's initial empty lists (`initial-state.mjs:55`), so
    /// empty lists are no change. The status listener then calls `scheduleGoalContinuation()`.
    fn agent_status(&mut self, agents: mixdog_app_protocol::v2::thread::ThreadAgents, listener: bool) {
        if self.tombstoned || self.cell.closed.load(SeqCst) {
            return;
        }
        // The scope is the header's (seated with it); a read that could not see the thread's handle keeps it.
        let mut agents = agents;
        if agents.agent_scope.is_none() {
            agents.agent_scope = Some(super::agent_registry::status_rows::agent_scope(&self.id, &self.projected.header));
        }
        if self.projected.sections.agents.clone().unwrap_or_default() != agents {
            self.accept_view(Change::Section(Section::Agents(agents)), Vec::new());
        }
        if listener {
            self.schedule_goal_continuation();
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
        let Some(delivery) = super::transcript::agent_response(&completion, &id, previous.as_ref(), self.deps.clock.now_ms())
        else {
            return;
        };
        let (super::transcript::Delivery::Push(card) | super::transcript::Delivery::Patch(card)) = delivery;
        let note = Note::new(
            "item/completed",
            &ItemNotificationParams { thread_id: self.id.clone(), turn_id: TurnId::from(""), item: card.clone() },
        );
        self.accept_view(Change::Card(card), vec![note]);
    }

    /// A detached job's completion joins the queue as today's completion entry
    /// (`enqueuePendingMessage`) and ends the running turn's passive wait; the turn takes it at
    /// its next model-call boundary ([`RunPort::take_steers`]). An idle thread is woken: the
    /// completion starts a turn (`createCompletionWakeScheduler`, `notification-bus.mjs:80-96`),
    /// unless the thread was opened only for it (Node wakes only the live session).
    #[allow(clippy::too_many_arguments)]
    fn task_notification(
        &mut self,
        surface: &str,
        task_id: String,
        status: String,
        text: String,
        origin: Option<&'static str>,
        live: bool,
        durable: Option<oneshot::Sender<Result<(), RunError>>>,
    ) {
        // A closing or closed owner never queues a completion (`notification-bus.mjs` `notifySessionCompletion`: `if
        // (!open) return handled`): the close cancels the session's shells, and their completions must not enqueue
        // model work for it.
        if origin.is_none() && (self.deleting || self.tombstoned || self.cell.closed.load(SeqCst) || self.acked.header.get("closed") == Some(&Value::Bool(true))) {
            if let Some(durable) = durable {
                let _ = durable.send(Err(RunError::NotApplied));
            }
            return;
        }
        let now = self.deps.clock.now_ms();
        let built = match origin {
            None => completions::entry(surface, &task_id, &status, &text, now),
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
        // The same completion queued twice is one entry (`pendingIdStillQueued`); its waiter hears when that one is durable.
        if self.projected.queue.iter().any(|q| q.qid == qid) {
            if durable.is_some() {
                self.outbox.push(None, Change::Barrier, Vec::new(), acks(durable));
            }
            return;
        }
        let record = Record::Queue(QueueRecord {
            qid: id(&qid),
            action: QueueAction::Enqueue,
            reason: None,
            op: None,
            entry: Some(Slot::Inline(entry)),
        });
        self.accept_record(record, Class::Normal, Display::None, Vec::new(), acks(durable));
        self.deps
            .wakes
            .interrupt(&self.id, WakeReason::Notification, Some(task_id).filter(|id| !id.is_empty()));
        if live && self.run.is_none() {
            self.start_next_queued();
        }
    }

    // ───────────── runs ─────────────

    /// The run's input row and `run{started}` (appended after it, so it is durable only after
    /// its input, FORMAT.md §5.2), then the run task.
    fn start_run(
        &mut self,
        input: TurnInput,
        op_ref: Option<OpRef>,
        reply: Option<Effect>,
        prompt: Option<String>,
    ) {
        let body = self.deps.transcript.user_message(&input);
        self.start_run_with(input, body, op_ref, reply, prompt, false);
    }

    /// Whether a completion may wake this idle thread: the session did not turn
    /// `autoWakeCompletions` off (`infrastructure.mjs:154`, default on at
    /// `runtime-core.mjs:31`) and its owner is not closing (`notification-bus.mjs:27-31`).
    fn completion_wake(&self) -> bool {
        !self.cell.closed.load(SeqCst)
            && self.acked.header.get(super::session_options::AUTO_WAKE_COMPLETIONS) != Some(&Value::Bool(false))
    }

    /// [`Self::start_run`] over an input row already built. `wake`: a completion wake, which
    /// continues the turn that launched the worker (`ask('', {continueTurn: true})`).
    fn start_run_with(
        &mut self,
        input: TurnInput,
        mut body: Value,
        op_ref: Option<OpRef>,
        reply: Option<Effect>,
        prompt: Option<String>,
        wake: bool,
    ) {
        // A plain `turn/start` carrying the retry flags: the failed turn's provenance is read first
        // (`failedTurnProvenance(preSession.messages, input)`, `ask-session.mjs:199`), as the lane's retries
        // read it before they begin; the row is stamped with it like theirs.
        if self.retry_provenance.is_none()
            && let Some(options) = input.options.as_ref()
            && (options.retry_failed_turn == Some(true) || options.retry_turn_id.is_some())
        {
            let retry_turn_id = options.retry_turn_id.clone().filter(|id| !id.is_empty());
            let context = ModelContext {
                store: self.deps.store.clone(),
                sensitive: self.deps.sensitive.clone(),
                lanes: self.deps.lanes,
                thread: self.id.clone(),
                input: mixdog_core_api::ids::ItemId::from(String::new()),
            };
            let jobs = self.jobs_tx.clone();
            self.starting = true;
            tokio::spawn(async move {
                let messages: Vec<Value> = context.read().await.map(|rows| rows.into_iter().map(|(_, m)| m).collect()).unwrap_or_default();
                let provenance = super::quota_lane::failed_provenance(&messages, retry_turn_id.as_deref());
                // `retainedFailedTurnInput(session.messages, retryTurnId)`: the failed user message the retry names.
                let prior = super::quota_lane::retained_retry_input(&messages).filter(|retained| Some(retained.message_id.as_str()) == retry_turn_id.as_deref()).map(|retained| retained.prior());
                let _ = jobs.send(JobDone::RetryProvenance(Box::new(RetryWait { input, body, op_ref, reply, prompt, wake, provenance, prior })));
            });
            return;
        }
        // A worker's turn (`SessionTurns`): its input row carries the handoff content and the
        // submission it answers, as `askSession` stamps them (`askTurns.started` submissionIds).
        let agent = if wake { None } else { self.cell.agent_start.lock().unwrap_or_else(|p| p.into_inner()).take() };
        if let Some(agent) = &agent {
            body["content"] = agent.content.clone();
            let submission = &agent.turn.hooks.submission_id;
            if !submission.is_empty() {
                body["meta"]["transcript"]["submissionIds"] = json!([submission]);
            }
        }
        // A routine fire's queued turn (`routine-home-turn.mjs`): its input row carries the
        // fire's content, the submission and the marker row's trigger; it starts "committed".
        let routine = if wake {
            None
        } else {
            let submission = input.options.as_ref().and_then(|options| options.client_submission_id.clone()).unwrap_or_default();
            let found = self.cell.routine_starts.lock().unwrap_or_else(|p| p.into_inner()).remove(&submission);
            if let Some(routine) = found {
                body["content"] = routine.content.clone();
                body["meta"]["transcript"]["submissionIds"] = json!([submission]);
                if let Some(trigger) = &routine.trigger {
                    body["meta"]["transcript"]["routineTrigger"] = trigger.clone();
                }
                if let Some(hop) = routine.hop {
                    body["meta"]["transcript"]["hop"] = json!(hop);
                }
                // `persistedUserTranscriptMetadata` (`transcript-metadata.mjs:105`): the bots that
                // handed this message on.
                if !routine.bot_chain.is_empty() {
                    body["meta"]["transcript"]["botChain"] = json!(routine.bot_chain);
                }
                if let Some(room_row) = &routine.room_row {
                    body["meta"]["transcript"]["roomRow"] = json!(room_row);
                }
                Some(routine)
            } else {
                None
            }
        };
        // `stampTurnHop(session, transcriptMeta)` (`ask-turn-execute.mjs:171`): the turn takes the
        // hop and bot chain of the submission that starts it; a wake carries none.
        self.cell.turn_chain.stamp(body.pointer("/meta/transcript"));
        // The input row's facts read the prompt-attachment store first; no other turn starts
        // meanwhile.
        self.starting = true;
        self.runs_begun += 1;
        self.with_facts(body, move |read| match read {
            Ok((body, facts)) => JobDone::InputFacts(Box::new(InputStart { input, body, facts, op_ref, reply, prompt, wake, agent, routine })),
            Err(error) => JobDone::InputUnread { reply, error },
        });
    }

    /// A turn that does not start: its waiter hears why (never a dropped reply), and the sends that joined it hear the drop.
    fn refuse_start(&mut self, reply: Option<Effect>, error: &CoreError) {
        self.submissions.unstarted();
        if let Some(Effect::Reply { op, tx, .. }) = reply {
            if let Some(op) = &op {
                self.ops.failed(op, error);
            }
            if let Some(tx) = tx {
                let _ = tx.send(Err(error.clone()));
            }
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
        let InputStart { input, mut body, facts, op_ref, reply, prompt, wake, agent, routine } = start;
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
        // `bumpUsageMetricsTurnId` (`whileTurnDispatched`): the turn's usage counts under a new id.
        self.usage_incremental = false;
        self.accept_header(super::usage_books::turn_started(&self.projected.header));
        let turn = TurnId::from(new_id());
        let mut op_ref = op_ref;
        let value = json!({ "kind": "started", "turnId": turn });
        if let Some(submission) = submission_id(&input) {
            self.submissions.remember(submission, value.clone());
        }
        if let Some(op) = &mut op_ref {
            op.result = Json::try_from(value.clone()).ok();
        }
        let input_iid = mixdog_core_api::ids::ItemId::from(new_id());
        // The first submitted row is the turn's checkpoint; a wake submits none. Its key rides
        // the row's transcript metadata so the change record maps back to it (`stampCheckpoint`).
        let checkpoint = if wake { "" } else { input_iid.as_str() };
        if !checkpoint.is_empty()
            && let Some(meta) = body.pointer_mut("/meta/transcript").and_then(Value::as_object_mut)
        {
            meta.insert("checkpointId".into(), Value::String(checkpoint.to_owned()));
        }
        // `beginTurn` (`tui/session/turn.mjs`) stamps the turn's start, a fresh attempt id and the session's route
        // plus its workflow's name (`createTranscriptRouteMetadata`); `persistedUserTranscriptMetadata` keeps them
        // on the input row, and what the submission already states stays.
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
            // The submission this row answers: a client matches its pending bubble to the stored row by it (the desktop's
            // `pendingPromptTranscriptItems`, conversation-prompt-items.ts), as Node's row id is the submission id.
            if let Some(submission) = submission_id(&input) {
                meta.entry("clientSubmissionId").or_insert_with(|| json!(submission));
            }
            // The device that sent the prompt rides its row (`transcriptMeta.device`).
            if let Some(submitter) = submitter.as_ref().filter(|submitter| !submitter.device.is_empty()) {
                meta.entry("device").or_insert_with(|| json!(submitter.device));
            }
            meta.entry("attemptId").or_insert_with(|| json!(new_id()));
            // `beginTurn` stamps the verb the turn will complete with on the same metadata the runtime persists.
            meta.entry("completionVerb").or_insert_with(|| json!(super::live_end::done_verb(self.turns_closed)));
            for (key, value) in route {
                meta.entry(key).or_insert(value);
            }
            if !route_agent.is_empty() {
                meta.entry("agent").or_insert_with(|| json!(route_agent));
            }
            persisted_user_order(meta);
        }
        self.sync_turn_chain();
        // `mintTranscriptEpoch` (`transcript-durability.mjs`): a transcript lineage is named when the first turn
        // saves, and again when a history rewrite makes the next turn open on a transcript that is not an
        // extension of the saved one.
        let named = self.projected.header.get("transcriptEpoch").and_then(Value::as_str).is_some();
        if !named || self.transcript_rewritten {
            self.transcript_rewritten = false;
            let mut set = serde_json::Map::new();
            set.insert("transcriptEpoch".into(), json!(new_id()));
            let meta = Record::Meta(MetaRecord { op: None, change: Slot::Inline(HeaderChange { set, unset: Vec::new() }) });
            self.accept_record(meta, Class::Normal, Display::None, Vec::new(), Vec::new());
        }
        let review = super::turn_snapshot::TurnSnapshot::new(self.deps.turn_review.clone(), self.id.as_str(), checkpoint, wake);
        // The retried turn's provenance rides its rebuilt row, so a retry of this retry reads it back.
        if let Some(Some(provenance)) = self.retry_provenance.take() {
            body["meta"]["provenance"] = provenance;
        }
        // The retained message keeps its id (`messageId: previousTranscript.messageId`), and its recorded completions ride
        // the row (`retainedUserTurn`), so the failure a retry replaces is still in the history.
        if let Some(prior) = self.retry_prior.take() {
            body["meta"]["transcript"]["messageId"] = json!(prior.message_id);
            body["meta"]["transcript"]["previousCompletions"] = Value::Array(prior.completions);
            // The message is resent as it is: its reminders ride it (`drive` reads them back, `turn_reminders::resubmit`).
            for (key, value) in prior.reminders {
                body["meta"][key.as_str()] = value;
            }
        }
        let input_body = body.clone();
        let hidden = std::mem::take(&mut self.retry_hidden);
        let input_display = if hidden { Display::None } else { self.row_display(Some("user"), &input_body) };
        // A user's prompt of blank text and a display text shows as that display text (`promptDisplayText` is the row's text,
        // drain.mjs `renderBatchItems`), though the model's content reads blank.
        let shown = display_text(&input);
        let shown_blank = submitter.is_some() && !facts.visible && facts.prompt.is_none() && !shown.is_empty();
        let input_row = ItemRecord {
            iid: id(input_iid.as_str()),
            turn: Some(id(turn.as_str())),
            role: Some(Text::try_from("user").expect("short")),
            form: Form::Message,
            model: true,
            visible: (facts.visible || shown_blank) && !hidden,
            archive: None,
            op: op_ref,
            prompt: facts.prompt.or_else(|| shown_blank.then_some(shown)).map(Slot::Inline),
            refs: Vec::new().try_into().expect("empty list fits"),
            body: Slot::Inline(body),
        };
        let last_model = Some(input_row.clone());
        self.accept_record(Record::Item(input_row), Class::Normal, input_display, Vec::new(), Vec::new());
        self.deps.turn_starts.turn_started(&self.id);
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
        if let Some(Effect::Reply { op, tx, .. }) = reply {
            effects.push(Effect::Reply { op, tx, value });
        }
        let token = CancellationToken::new();
        let cancel = mixdog_agent::cancel::Cancel::from_token(&token);
        let (input_tx, input_rx) = watch::channel(InputState::Pending);
        let jobs = self.jobs_tx.clone();
        let marks = self.deps.sensitive.on_marked(
            &self.id,
            Box::new(move || {
                let _ = jobs.send(JobDone::SensitiveMarked);
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
        // What a stop may hand back of this prompt (`promptRestoreFor`): only a user's, from the device that sent it.
        let prompt_state = Arc::new(PromptState::new(PromptFacts {
            text: display_text(&input),
            ids: input.options.as_ref().and_then(|options| options.client_submission_id.clone()).filter(|id| !id.is_empty()).into_iter().collect(),
            device: submitter.as_ref().map(|submitter| submitter.device.clone()).unwrap_or_default(),
            restorable: submitter.as_ref().is_some_and(|submitter| submitter.restorable) && !wake,
            committed: false,
            entry: json!({ "message": input.prompt, "options": input.options }),
            reclaim: None,
        }));
        self.run = Some(RunSlot {
            prompt: prompt_state.clone(),
            turn: turn.clone(),
            provider: self.acked.header.get("provider").and_then(Value::as_str).unwrap_or_default().to_owned(),
            route_meta: super::live_end::route_meta(self.acked.header.get("provider").and_then(Value::as_str).unwrap_or_default(), self.acked.header.get("model").and_then(Value::as_str).unwrap_or_default()),
            input_item: input_iid.clone(),
            automatic: super::goal_lane::automatic(&input_body),
            wake,
            tool_calls: 0,
            cancel: cancel.clone(),
            input: input_tx,
            start_failed: false,
            goal_reminder: goal_reminder.as_ref().map(|reminder| reminder.revision),
            notice: notice.clone(),
            agent,
            _marks: marks,
            last_model,
            started_at: self.deps.clock.now_ms(),
            transcript: input_body.pointer("/meta/transcript").cloned().unwrap_or(Value::Null),
            live: Default::default(),
            verb: super::live_end::done_verb(self.turns_closed),
        });
        // `onGoalTurnStarted`: the turn takes the Goal's open clock segment.
        let (goals, thread) = (self.deps.goals.clone(), self.id.clone());
        self.goal_call(Box::pin(async move { JobDone::GoalSeen(goals.turn_started(&thread).await.ok()) }));
        // `heavyRuntimeWarmupArm()` (`turn-open.mjs:22`): the runtime's first turn arms the warm;
        // `setActiveTurnCount(+1)` wakes the parked warmups.
        self.turn_prewarm_armed = !std::mem::replace(&mut self.first_turn_prewarm_done, true);
        self.deps.code_graph_prewarm.wake();
        self.cell.publish_run(Some(Arc::new(ActiveRun {
            turn: turn.clone(),
            cancel: cancel.clone(),
            steers: Default::default(),
            prompt: prompt_state,
        })));
        self.accept_record(started, Class::Control, Display::None, Vec::new(), effects);
        // `onTurnStart`: the turn's id, start and the submissions it carries.
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
        // `noteTurnForCacheWarm` (`ask-session.mjs:313`) runs in the run's task, below.
        let warm = super::turn_warm::WarmNote {
            port: self.deps.warm.clone(),
            thread: self.id.clone(),
            input: super::turn_warm::warm_input(input.options.as_ref(), &input_body),
            ready: input_rx.clone(),
            context: ModelContext {
                store: self.deps.store.clone(),
                sensitive: self.deps.sensitive.clone(),
                lanes: self.deps.lanes,
                thread: self.id.clone(),
                input: input_iid.clone(),
            },
            cancel: token.clone(),
        };
        let port = RunPort {
            thread: self.id.clone(),
            turn: turn.clone(),
            tx: self.ch.prod_tx.clone(),
            input: input_rx,
            cancel: token.clone(),
            ctl: self.cell.ctl_tx.clone(),
            provider: self
                .acked
                .header
                .get(PROVIDER_STATE)
                .and_then(|state| serde_json::from_value(state.clone()).ok()),
            meters: self.deps.compaction.clone(),
            meters_provider: {
                let cell = self.cell.clone();
                Arc::new(move || cell.header.load().get("provider").and_then(Value::as_str).unwrap_or_default().to_owned())
            },
        };
        // A session takes moved settings gates at its next turn start (today's
        // `stageToolAvailability`).
        self.refresh_surface();
        // `admitTurnWorkspace` follows the session's live cwd, the one its header carries.
        let admission = {
            let (admission, thread, token) = (self.deps.turn_admission.clone(), self.id.clone(), token.clone());
            let cell = self.cell.clone();
            let cwd: super::worktree::Cwd =
                Arc::new(move || cell.header.load().get("cwd").and_then(Value::as_str).unwrap_or_default().to_owned());
            async move { admission.admit(thread.as_str(), cwd, &token).await }
        };
        let future = self.deps.runs.start(RunStart {
            agent_turn,
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
            header: self.acked.header.clone(),
            port,
            context: ModelContext {
                store: self.deps.store.clone(),
                sensitive: self.deps.sensitive.clone(),
                lanes: self.deps.lanes,
                thread: self.id.clone(),
                input: input_iid.clone(),
            },
            surface: self.surface.subscribe(),
            progress: self.cell.progress.clone(),
            turn_messages: self.cell.turn_messages.clone(),
            cancel: token,
            signal: cancel.clone(),
            review: review.clone(),
        });
        let ctl = self.cell.ctl_tx.clone();
        mixdog_rt::spawn("session-run", TaskClass::Work, async move {
            // Ended with the run, before it reports settled (`endCacheWarmTurn`, `ask-session.mjs:353,386`).
            let warm = warm.begin().await;
            // The turn is admitted to its workspace before its loop runs: no checkout it reads
            // changes under it until it settles. An abort while it waits ends it unrun; a failed
            // admission fails it with the refusal's text.
            let (outcome, admitted) = match admission.await {
                Ok(guard) => (future.await, Some(guard)),
                Err(mixdog_scm::error::ScmFailure::Cancelled) => (RunOutcome::Interrupted, None),
                Err(failure) => {
                    let message = super::worktree::thrown_message(&failure);
                    (RunOutcome::Failed(TurnError { message, data: json!({}), provider_error: None }), None)
                }
            };
            // The turn's review is sealed before the turn reports settled.
            review.finish(&cancel).await;
            drop(warm);
            let _ = ctl.send(Ctl::RunEnded { turn, outcome }).await;
            // `releaseWorkspace()` of `settleTurn`.
            drop(admitted);
        });
    }

    /// Open-time recovery: a run without a terminal record is interrupted, and so are its
    /// approvals (P §5.2, §8.2; Codex daemon recovery).
    fn recover(&mut self) {
        let at = self.deps.clock.now_ms();
        let approvals: Vec<(String, String)> = self
            .acked
            .approvals
            .iter()
            .map(|(aid, row)| (aid.clone(), row.rid.clone()))
            .collect();
        for (aid, rid) in approvals {
            if let Ok(aid) = aid.parse() {
                self.resolve(
                    ApprovalId(aid),
                    &TurnId::from(rid),
                    ApprovalResolution::Interrupted { at },
                );
            }
        }
        let runs: Vec<String> = self.acked.runs.keys().cloned().collect();
        // Recovering an interrupted turn drops the provider continuation
        // (`turn-checkpoint.mjs:554`).
        if !runs.is_empty()
            && let Some(reset) = self.provider_state_change(None)
        {
            self.accept_record(reset, Class::Control, Display::None, Vec::new(), Vec::new());
        }
        // The last run is the turn the process died in.
        let died_in = runs.last().cloned();
        for rid in runs {
            let record = Record::Run(RunRecord {
                rid: id(&rid),
                phase: RunPhase::Interrupted,
                attribution: None,
                attempt: None,
                at: Some(at),
                op: None,
                detail: None,
            });
            self.accept_record(record, Class::Control, Display::None, Vec::new(), Vec::new());
        }
        if let Some(rid) = died_in {
            self.recover_interrupted_turn(rid);
        }
    }

    /// Node's reconnect recovery (`_recoverTurnCheckpointDurably`, `turn-checkpoint-recovery.mjs:113-131`): the turn
    /// the process died in is finalized as `finalizeInterruptedTurn` with `process-crash` leaves it (every unanswered
    /// call closed as cancelled, the restart line, `sentRequestTail` on the row the request ended with) and saved
    /// durably before the session is served, so the first read shows it. Requests wait meanwhile.
    fn recover_interrupted_turn(&mut self, rid: String) {
        self.recovering = true;
        let (store, lanes, thread, attachments, jobs) =
            (self.deps.store.clone(), self.deps.lanes, self.id.clone(), self.deps.attachments.clone(), self.jobs_tx.clone());
        tokio::spawn(async move {
            let result = async {
                let rows = super::run::read_context(&store, &lanes, &thread).await.map_err(|error| format!("{error:?}"))?;
                let bodies: Vec<Value> = rows.iter().map(|(_, body)| body.clone()).collect();
                let recovered = mixdog_agent::interrupt::recover_after_restart(&bodies)?;
                let token = CancellationToken::new();
                lanes
                    .io
                    .submit(&token, move |lane| {
                        let mut out = Recovery::default();
                        for row in recovered {
                            match row {
                                mixdog_agent::interrupt::RecoveredRow::Kept { index, body } => {
                                    out.changed |= body != rows[index].1;
                                    out.replacement.push((rows[index].0.clone(), body));
                                }
                                mixdog_agent::interrupt::RecoveredRow::New { role, mut body } => {
                                    out.changed = true;
                                    let facts = attachments.facts(lane, &mut body);
                                    let iid = super::run::new_item_id();
                                    out.replacement.push((iid.clone(), body.clone()));
                                    out.new.push((ItemCommit { iid, role: Some(role.to_owned()), model: true, visible: role != "user", body, prompt: None }, facts));
                                }
                            }
                        }
                        out
                    })
                    .map_err(|error| format!("{error:?}"))?
                    .await
                    .map_err(|_| "the recovery job was dropped".to_owned())
            }
            .await;
            let _ = jobs.send(JobDone::Recovered { rid, result });
        });
    }

    fn recovery_ended(&mut self) {
        self.recovering = false;
        if let Some(ready) = self.opened.take() {
            let _ = ready.send(());
        }
    }

    fn recovered(&mut self, rid: String, result: Result<Recovery, String>) {
        let recovery = match result {
            Ok(recovery) => recovery,
            Err(error) => {
                // Nothing was written: the stored rows stay as the process left them.
                tracing::warn!("[session] the interrupted turn of {} could not be recovered: {error}", self.id.as_str());
                self.recovery_ended();
                return;
            }
        };
        let turn = TurnId::from(rid);
        let mut records = Vec::new();
        if recovery.changed {
            for (item, facts) in recovery.new {
                let display = self.row_display(item.role.as_deref(), &item.body);
                match self.item_record(&turn, item, facts, None) {
                    Ok(record) => records.push((record, display)),
                    Err(error) => {
                        tracing::warn!("[session] the interrupted turn of {} could not be recovered: {error:?}", self.id.as_str());
                        self.recovery_ended();
                        return;
                    }
                }
            }
            // The model context restarts on the recovered rows (silent: nothing leaves the transcript).
            records.push((
                Record::Compacted(CompactedRecord {
                    cid: id(&new_id()),
                    summary_iid: None,
                    op: None,
                    at: Some(self.deps.clock.now_ms()),
                    dropped_count: Some(0),
                    dropped: None,
                    silent: Some(true),
                    replacement: Slot::Inline(
                        recovery.replacement.into_iter().map(|(iid, body)| ReplacementEntry { iid: iid.as_str().to_owned(), body }).collect(),
                    ),
                }),
                Display::None,
            ));
            self.transcript_rewritten = true;
        }
        let Some(last) = records.len().checked_sub(1) else {
            self.recovery_ended();
            return;
        };
        let (ack, durable) = oneshot::channel();
        let jobs = self.jobs_tx.clone();
        tokio::spawn(async move {
            let done = durable.await.unwrap_or(Err(RunError::NotApplied));
            let _ = jobs.send(JobDone::RecoveryDone(done));
        });
        let mut ack = Some(ack);
        for (index, (record, display)) in records.into_iter().enumerate() {
            let effects = if index == last { vec![Effect::ItemAck(ack.take().expect("one ack"))] } else { Vec::new() };
            self.accept_record(record, Class::Normal, display, Vec::new(), effects);
        }
    }

    // ───────────── prompt history ─────────────

    fn cwd(&self) -> String {
        self.acked
            .header
            .get("cwd")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned()
    }

    fn load_persisted_prompts(&mut self) {
        let prompts = self.deps.prompts.clone();
        let jobs = self.jobs_tx.clone();
        let cwd = self.cwd();
        mixdog_core_base::support::lane_job(self.deps.lanes.io, "prompt-history-load", move |lane| prompts.load(lane, &cwd), move |loaded| match loaded {
            Ok(list) => drop(jobs.send(JobDone::PromptPersisted(list))),
            Err(error) => tracing::warn!("the persisted prompt history was not read: {error:?}"),
        });
    }

    /// `appendPromptHistory(cwd, text)` for a user-submitted prompt, off the actor.
    fn persist_prompt(&mut self, prompt: String) {
        if prompt_history::key(&prompt).is_empty() {
            return;
        }
        let next = self.prompt_appends.push(prompt);
        self.run_prompt_step(next);
    }

    fn run_prompt_step(&mut self, next: prompt_history::Next) {
        match next {
            prompt_history::Next::Idle => {}
            prompt_history::Next::Flush(batch) => self.flush_prompts(batch),
            prompt_history::Next::Wait { epoch, delay } => {
                #[cfg(any(test, feature = "test-support"))]
                self.cell.prompt_timers.fetch_add(1, SeqCst);
                let jobs = self.jobs_tx.clone();
                // The wait starts as it is armed, as Node's `setTimeout` does, not when the task first runs.
                let due = mixdog_rt::time::sleep(delay);
                drop(tokio::spawn(async move {
                    due.await;
                    let _ = jobs.send(JobDone::PromptRetryDue(epoch));
                }));
            }
        }
    }

    /// Appends `batch` (oldest first) to the persisted history, stopping at the first that does not
    /// land. What did not land comes back to the queue, which retries it on Node's backoff: a prompt
    /// is not lost because the lane refused the job or the write failed. A job that never ran
    /// (`JobDropped`) wrote nothing, so retrying it duplicates nothing.
    fn flush_prompts(&mut self, batch: Vec<String>) {
        let (prompts, jobs, cwd, lanes) = (self.deps.prompts.clone(), self.jobs_tx.clone(), self.cwd(), self.deps.lanes);
        let (marks, thread) = (self.deps.sensitive.clone(), self.id.clone());
        drop(mixdog_rt::spawn("prompt-history-append", TaskClass::Work, async move {
            let kept = batch.clone();
            let submitted = lanes.durability.submit_wait(&CancellationToken::new(), move |lane| {
                let mut list = None;
                for (at, text) in batch.iter().enumerate() {
                    // A value the thread marked sensitive is stored as the marker, as in its log.
                    let done = prompts.append(lane, &cwd, &marks.redact_text(&thread, text));
                    list = Some(done.list);
                    if !done.written {
                        return (list, batch[at..].to_vec());
                    }
                }
                (list, Vec::new())
            })
            .await;
            let (list, unwritten) = match submitted {
                Ok(job) => job.await.unwrap_or((None, kept)),
                Err(_) => (None, kept),
            };
            let _ = jobs.send(JobDone::PromptFlushed { list, unwritten });
        }));
    }

    /// A mark: the cwd's persisted prompt history keeps the marked values as the marker, entries written before included.
    /// The lists the thread holds go the same way, so the history a client is sent after the mark carries the marker only.
    /// A prompt list with this thread's marks applied.
    fn redacted_prompts(&self, list: &[String]) -> Vec<String> {
        list.iter().map(|text| self.deps.sensitive.redact_text(&self.id, text)).collect()
    }

    /// The session's prompt list (newest first) with the marks applied; oldest first into `recompute`, so two entries the
    /// marker made equal keep the newer one.
    fn redacted_session_prompts(&self, list: &[String]) -> Vec<String> {
        prompt_history::recompute(&self.redacted_prompts(list).into_iter().rev().collect::<Vec<_>>())
    }

    fn redact_prompts(&mut self) {
        let (prompts, cwd, marks, thread) = (self.deps.prompts.clone(), self.cwd(), self.deps.sensitive.clone(), self.id.clone());
        let session = self.redacted_session_prompts(&self.acked.prompt_session);
        let persisted = self.redacted_prompts(&self.acked.prompt_persisted);
        if session != self.acked.prompt_session {
            self.accept_view(Change::PromptSession { session, publish: true }, Vec::new());
        }
        if persisted != self.acked.prompt_persisted {
            self.accept_view(Change::PromptPersisted(persisted), Vec::new());
        }
        // The mark's rewrite of the persisted history waits out a full lane; it is not lost to one.
        mixdog_core_base::support::lane_job(
            self.deps.lanes.durability,
            "prompt-history-redact",
            move |lane| prompts.redact(lane, &cwd, &|text| marks.redact_text(&thread, text)),
            |done| {
                if let Err(error) = done {
                    tracing::warn!("the persisted prompt history was not rewritten for a mark: {error:?}");
                }
            },
        );
    }

    /// The session part over the remaining lineage after a history mutation.
    fn recompute_prompts(&mut self, publish: bool) {
        let deps = self.deps.clone();
        let jobs = self.jobs_tx.clone();
        let thread = self.id.clone();
        mixdog_core_base::support::lane_job(
            self.deps.lanes.io,
            "prompt-history-recompute",
            move |lane| {
                let rows = deps.store.user_rows(lane, &thread).ok()?;
                let texts: Vec<String> = rows.iter().filter_map(|row| row.prompt_text().map(str::to_owned)).collect();
                Some(prompt_history::recompute(&texts))
            },
            move |read| match read {
                Ok(Some(session)) => drop(jobs.send(JobDone::PromptSession { session, publish })),
                Ok(None) => {}
                Err(error) => tracing::warn!("the session's prompt history was not recomputed: {error:?}"),
            },
        );
    }
}

/// What a mutation appends.
struct Plan {
    kind: PlanKind,
    value: Value,
    /// Recompute the prompt session part after release (`Some(publish)`).
    after: Option<bool>,
    /// A user-submitted prompt for the persisted history.
    prompt: Option<String>,
}

enum PlanKind {
    StartRun(TurnInput, Option<OpRef>),
    /// Records with their class, display and accept-time notes, then view-only changes.
    Records(Vec<(Record, Class, Display, Vec<Note>)>, Vec<Change>),
}

/// `queue{dequeue, delivered}`.
fn dequeue(qid: &str) -> Record {
    Record::Queue(QueueRecord {
        qid: id(qid),
        action: QueueAction::Dequeue,
        reason: Some(DequeueReason::Delivered),
        op: None,
        entry: None,
    })
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

async fn sleep_until(deadline: Option<tokio::time::Instant>) {
    match deadline {
        Some(deadline) => mixdog_rt::time::sleep_until(deadline).await,
        None => std::future::pending().await,
    }
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

/// A delete's go for its mark; an error when the delete dropped it.
async fn mark_go(mark: &mut Option<oneshot::Receiver<serde_json::Map<String, Value>>>) -> Result<serde_json::Map<String, Value>, oneshot::error::RecvError> {
    match mark {
        Some(mark) => mark.await,
        None => std::future::pending().await,
    }
}
