//! `SessionActor`: the one owner of a thread's state (RL §5.1). Its loop is biased: the
//! control lane first, then durability acks, then lane-job results, then the approval
//! deadline, then producers (runs and sections), then the inbox. Handlers are bounded and
//! synchronous: validate against the projected state, append to the outbox, submit the
//! record encode to cpu-interactive, never await storage or a lane.

use std::sync::Arc;
use std::sync::atomic::Ordering::SeqCst;

use mixdog_agent::agent_tool::flow::seams::TurnOutcome;
use mixdog_agent::agent_tool::flow::seams::TurnStart;
use mixdog_tools::exec::WakeReason;
use mixdog_app_protocol::v2::thread::HistoryResetReason;
use mixdog_app_protocol::v2::thread::ItemNotificationParams;
use mixdog_app_protocol::v2::thread::PromptRestore;
use mixdog_app_protocol::v2::thread::StorageState;
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
use crate::goal::js::Goal;
use super::run::ModelContext;
use super::user_facts::RowFacts;
use super::user_facts::user_facts;
use super::run::RunPort;
use super::run::DrainStage;
use super::run::SteerInput;
use super::run::within_priority;
use super::completions;
use super::pending;
use super::seams::EncodedRecord;
use super::seams::Shown;
use super::seams::RunOutcome;
use super::seams::RunStart;
use super::state::Change;
use super::state::Display;
use super::state::Section;
use super::state::SessionState;
use super::view::SessionView;
use crate::approvals::ApprovalBook;
use crate::approvals::Lineage;
use crate::approvals::request_frame;
use crate::approvals::request_params;
use crate::approvals::resolved_frame;

/// The header key of the session's saved provider state (Node `session.providerState`).
const PROVIDER_STATE: &str = "providerState";

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

/// A request routed to the actor.
pub(crate) enum Inbox {
    /// `onGoalStatusChange`: the thread's visible Goal changed.
    GoalChanged(Option<Goal>),
    /// A completion as the session's listeners receive it (`{content, meta}`): shown as a live
    /// card when the card gates admit it.
    CompletionCard { content: String, meta: Value },
    /// `TaskNotifier`: a detached job of this thread finished.
    TaskNotification {
        surface: String,
        task_id: String,
        status: String,
        text: String,
        /// The thread was loaded when the job finished (Node's owner is the runtime's live
        /// session, `notification-bus.mjs:41`); one opened for the completion is never woken.
        live: bool,
    },
    Request {
        req: CoreRequest,
        tx: Waiter,
    },
    /// `thread/fork`: the base the new thread continues (acked end of this lineage) and the
    /// header it copies. The handle creates the thread through the directory.
    ForkPlan {
        tx: oneshot::Sender<Result<(Base, Header), CoreError>>,
    },
}

/// Results of lane jobs the actor submitted.
pub(crate) enum JobDone {
    Encoded {
        id: u64,
        generation: u64,
        result: Result<(EncodedRecord, Vec<Shown>, Vec<Note>), CoreError>,
    },
    PromptSession { session: Vec<String>, publish: bool },
    PromptPersisted(Vec<String>),
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
    GoalDecision(Option<crate::goal::Continuation>),
    /// The user prompt's archive of a finished Goal landed (its id, masked meanwhile).
    GoalArchived(String),
    /// `goalControl`'s answer for the request that asked.
    GoalControlled { op: Option<OpId>, tx: Waiter, result: Result<Value, crate::goal::GoalError> },
}

/// What the actor does first.
pub(crate) enum Init {
    /// A new thread: its `session` record, answered with `value` once durable.
    Create {
        session: Record,
        tx: Option<Waiter>,
        value: Value,
    },
    /// An opened log: interrupted runs and their approvals are recovered (P §5.2, §8.2).
    Open,
}

struct RunSlot {
    turn: TurnId,
    /// The id of the run's input row.
    input_item: mixdog_core_api::ids::ItemId,
    /// An automatic Goal turn (`promptSource === 'goal-continuation'`).
    automatic: bool,
    /// Tool results the turn committed (its tool cards).
    tool_calls: u64,
    cancel: mixdog_agent::cancel::Cancel,
    input: watch::Sender<InputState>,
    /// The run's input never became durable: no terminal record follows.
    start_failed: bool,
    /// The run's `onSensitiveValuesMarked` subscription (`ask-turn-state.mjs:104`).
    _marks: Box<dyn Send>,
}

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
    id: ThreadId,
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
    steer_marked: Vec<QueuedId>,
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
    /// The Goal a user prompt is archiving, masked from the lane until the archive lands.
    goal_suppressed: String,
    /// A continuation decision is on its way.
    goal_scheduled: bool,
    /// The Goal the lane last saw and the deadline warning it last delivered.
    goal_watch: super::goal_lane::GoalWatch,
    /// The last Goal runtime call: each waits for the one before.
    goal_tail: Option<tokio::task::JoinHandle<()>>,
    /// Answered once the deleted thread's turn ended.
    delete_closed: Option<oneshot::Sender<Result<(), &'static str>>>,
    /// The delete's go for the mark, awaited once `delete_closed` answered.
    delete_mark: Option<oneshot::Receiver<()>>,
    /// Answered at the mark's ack.
    delete_marked: Option<oneshot::Sender<Result<(), RunError>>>,
    generation: u64,
    pending: bool,
    indeterminate: bool,
    published_storage: StorageState,
    ch: ActorChannels,
    jobs_tx: mpsc::UnboundedSender<JobDone>,
    jobs_rx: mpsc::UnboundedReceiver<JobDone>,
    /// The tool-policy surface every run's authorize requests carry.
    surface: watch::Sender<Arc<SessionSurface>>,
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

/// The prompt's text parts, as the user row shows them.
fn prompt_text(input: &TurnInput) -> String {
    match &input.prompt {
        PromptContent::Text(text) => text.clone(),
        PromptContent::Parts(parts) => parts
            .iter()
            .filter_map(|part| match part {
                PromptPart::Text { text } => Some(text.as_str()),
                _ => None,
            })
            .collect(),
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
        Self {
            goal_watch,
            surface,
            feed_id: FeedId::from(id.as_str()),
            outbox: Outbox::new(deps.limits),
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
            steer_marked: Vec::new(),
            cards: Default::default(),
            listened: Default::default(),
            suppressed: Default::default(),
            wake_tail: Vec::new(),
            deleting: false,
            goal_suppressed: String::new(),
            goal_scheduled: false,
            goal_tail: None,
            delete_closed: None,
            delete_mark: None,
            delete_marked: None,
            generation: 0,
            pending: false,
            indeterminate: false,
            published_storage: StorageState::Ok,
            ch,
            jobs_tx,
            jobs_rx,
            deps,
        }
    }

    pub async fn run(mut self, init: Init) {
        match init {
            Init::Create { session, tx, value } => {
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
            Init::Open => self.recover(),
        }
        self.load_persisted_prompts();
        self.pump();
        loop {
            let deadline = self.book.next_deadline();
            let producers_open = self.outbox.producer_room();
            let marking = self.delete_closed.is_none() && self.delete_mark.is_some();
            tokio::select! {
                biased;
                Some(ctl) = self.ch.ctl_rx.recv() => self.on_ctl(ctl),
                go = mark_go(&mut self.delete_mark), if marking => self.mark_deleted(go.is_ok()),
                Some(msg) = self.ch.dur_rx.recv() => self.on_durability(msg),
                Some(done) = self.jobs_rx.recv() => self.on_job(done),
                _ = sleep_until(deadline), if deadline.is_some() => self.on_deadline(),
                Some(msg) = self.ch.prod_rx.recv(), if producers_open => self.on_producer(msg),
                Some(msg) = self.ch.inbox_rx.recv() => self.on_inbox(msg),
                else => break,
            }
            self.pump();
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
    }

    /// `Ctl::Delete`: see its doc.
    fn delete(
        &mut self,
        reason: &str,
        idle: bool,
        closed: oneshot::Sender<Result<(), &'static str>>,
        mark: oneshot::Receiver<()>,
        marked: oneshot::Sender<Result<(), RunError>>,
    ) {
        // Another delete holds the thread: it is gone for this one.
        if self.deleting {
            let _ = closed.send(Err("missing"));
            return;
        }
        if idle {
            let refusal = if self.run.is_some() {
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
        self.cell.closed.store(true, SeqCst);
        self.deleting = true;
        (self.delete_closed, self.delete_mark, self.delete_marked) = (Some(closed), Some(mark), Some(marked));
        if let Some(run) = &self.run {
            // The deleted session leaves the approvals list now, not when its turn ends.
            let turn = run.turn.clone();
            let at = self.deps.clock.now_ms();
            for aid in self.book.take_run(&turn) {
                self.resolve(aid, &turn, ApprovalResolution::Interrupted { at });
            }
            if let Some(run) = &self.run {
                run.cancel.abort(reason);
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

    /// The delete mark (FORMAT.md §5.1 `meta`, `deleted: true`), acked to `delete_marked`;
    /// `false`: the delete gave up, the thread stops unmarked.
    fn mark_deleted(&mut self, go: bool) {
        self.delete_mark = None;
        let Some(marked) = self.delete_marked.take() else { return };
        if !go {
            return;
        }
        let mut set = serde_json::Map::new();
        set.insert(mixdog_store::summary::DELETED.into(), json!(true));
        let meta = Record::Meta(MetaRecord { op: None, change: Slot::Inline(HeaderChange { set, unset: Vec::new() }) });
        self.accept_record(meta, Class::Control, Display::None, Vec::new(), vec![Effect::ItemAck(marked)]);
    }

    /// Unloads when the last subscriber has left and nothing is live: no run, no queued
    /// input, no pending approval. The memory ingest fires without waiting (today's
    /// `void ingestSessionIntoMemory(session)` when the CLI closes a session).
    fn try_unload(&mut self) {
        let cell = &self.cell;
        if !cell.ever_subscribed.load(SeqCst)
            || self.deleting
            || cell.subscribers.load(SeqCst) != 0
            || self.run.is_some()
            || !self.projected.queue.is_empty()
            || !self.projected.approvals.is_empty()
        {
            return;
        }
        let Some(directory) = self.ch.directory.upgrade() else {
            return;
        };
        if directory.unload(&self.id, &self.cell) {
            tokio::spawn(self.close_ingest());
        }
    }

    /// Today's `ingestSessionIntoMemory(session)` over the model context.
    fn close_ingest(&self) -> futures::future::BoxFuture<'static, ()> {
        let context = ModelContext {
            store: self.deps.store.clone(),
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
            let messages = rows.into_iter().map(|(_, body)| body).collect();
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
        let record = Arc::new(record);
        let shown = !matches!(display, Display::Suppressed);
        let change = Change::Record {
            record: record.clone(),
            display,
        };
        self.projected.apply(&change, None);
        let entry = self
            .outbox
            .push(Some((record.clone(), class)), change, notes, effects);
        self.submit_encode(entry, record, shown);
    }

    /// A view-only change, released in order with the records around it.
    fn accept_view(&mut self, change: Change, notes: Vec<Note>) {
        self.projected.apply(&change, None);
        self.outbox.push(None, change, notes, Vec::new());
    }

    /// `shown`: whether the record's items show live (a suppressed row shows none).
    fn submit_encode(&mut self, entry: u64, record: Arc<Record>, shown: bool) {
        let deps = self.deps.clone();
        let jobs = self.jobs_tx.clone();
        let generation = self.generation;
        let thread = self.id.clone();
        let submitted = self.deps.lanes.cpu.submit(&CancellationToken::new(), move |lane| {
            let result = deps.codec.encode(lane, &record).map(|encoded| {
                let Record::Item(row) = &*record else {
                    return (encoded, Vec::new(), Vec::new());
                };
                if !shown {
                    return (encoded, Vec::new(), Vec::new());
                }
                let shown = deps.transcript.items(lane, row);
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
            let _ = jobs.send(JobDone::Encoded {
                id: entry,
                generation,
                result,
            });
        });
        if let Err(full) = submitted {
            let _ = self.jobs_tx.send(JobDone::Encoded {
                id: entry,
                generation,
                result: Err(full.into()),
            });
        }
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
                    Ok((encoded, shown, notes)) => {
                        if let Some(entry) = self.outbox.get_mut(id) {
                            if let Change::Record { display, .. } = &mut entry.change
                                && !shown.is_empty()
                            {
                                *display = Display::Items(shown);
                            }
                            entry.notes.extend(notes);
                        }
                        self.outbox.encoded(id, encoded);
                    }
                    Err(error) => {
                        if let Some(entry) = self.outbox.remove(id) {
                            self.fail_entry(entry, &error);
                        }
                        self.rebuild_projected();
                    }
                }
            }
            JobDone::PromptSession { session, publish } => {
                self.accept_view(Change::PromptSession { session, publish }, Vec::new())
            }
            JobDone::PromptPersisted(persisted) => {
                self.accept_view(Change::PromptPersisted(persisted), Vec::new())
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
                if self.run.is_some() {
                    let ack = self.ingest_when_durable();
                    self.outbox.push(None, Change::Barrier, Vec::new(), vec![Effect::ItemAck(ack)]);
                }
            }
            JobDone::GoalSeen(Some(goal)) => {
                self.publish_goal(goal);
            }
            JobDone::GoalSettled(Some(goal)) => {
                // `onGoalTurnSettled`: an active Goal continues once the thread is idle.
                if self.publish_goal(goal).is_some_and(|goal| goal_lane_status(&goal) == "active") {
                    self.schedule_goal_continuation();
                }
            }
            JobDone::GoalSeen(None) | JobDone::GoalSettled(None) => {}
            JobDone::GoalDecision(decision) => self.goal_decision(decision),
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
        let (mut removed, mut renewed) = (0, Vec::new());
        for (qid, entry) in queued {
            if let Some(text) = super::goal_lane::kept_closeout_text(&entry, keep) {
                if entry.get("message").and_then(Value::as_str) != Some(text.as_str()) {
                    // The queue holds no in-place edit of an entry: the closeout is queued again
                    // with the new text.
                    let mut entry = entry;
                    entry["message"] = Value::String(text);
                    renewed.push(entry);
                    self.accept_record(dequeue(&qid), Class::Control, Display::None, Vec::new(), Vec::new());
                }
                continue;
            }
            self.accept_record(dequeue(&qid), Class::Control, Display::None, Vec::new(), Vec::new());
            removed += 1;
        }
        for entry in renewed {
            self.enqueue_goal_entry(entry);
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
        if self.run.is_some() {
            let entry = super::goal_lane::warning_entry(&text, goal, self.deps.clock.now_ms());
            self.enqueue_goal_entry(entry);
        } else {
            super::goal_lane::mark_goal_reminder(&*self.deps.goals, &self.id);
        }
    }

    /// `deliverGoalCloseout`: the Goal reached its duration; the running turn closes it out.
    fn deliver_goal_closeout(&mut self, timed: Option<&Goal>) {
        if self.deleting || self.cell.closed.load(SeqCst) {
            return;
        }
        let Some(goal) = timed else { return };
        let busy = self.run.is_some();
        let queue: Vec<&Value> = self.projected.queue.iter().map(|q| &q.entry).collect();
        match super::goal_lane::closeout(goal, busy, &queue, self.deps.clock.now_ms()) {
            super::goal_lane::Closeout::Remind => super::goal_lane::mark_goal_reminder(&*self.deps.goals, &self.id),
            super::goal_lane::Closeout::Enqueue(entry) => {
                self.enqueue_goal_entry(entry);
                self.start_next_queued();
            }
        }
    }

    /// `goalControl`: the answer, then what the session API does after a pause or stop (queued
    /// automatic work goes, the running turn is cancelled) and the lane reads the Goal again.
    fn goal_controlled(&mut self, op: Option<OpId>, tx: Waiter, result: Result<Value, crate::goal::GoalError>) {
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
            Some("edit") => super::goal_lane::mark_goal_reminder(&*self.deps.goals, &self.id),
            Some("pause" | "stop") => {
                self.cancel_goal_entries(None);
                if let Some(run) = &self.run {
                    let reason = mixdog_agent::cancel::abort_session_turn_reason(self.id.as_str(), "user-cancel");
                    let _ = self.cell.abort(&run.turn, &reason);
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
        self.run.is_none() && self.projected.queue.is_empty() && !self.deleting && !self.cell.closed.load(SeqCst)
    }

    /// The continuation decision: an active Goal's prompt is queued as the next turn.
    fn goal_decision(&mut self, decision: Option<crate::goal::Continuation>) {
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
            super::goal_lane::mark_goal_reminder(&*self.deps.goals, &self.id);
        }
        let archived = super::goal_lane::archived_goal_id(self.projected.sections.goal.as_ref());
        if !archived.is_empty() {
            self.goal_suppressed = archived.clone();
            self.publish_goal(None);
        }
        let (goals, thread) = (self.deps.goals.clone(), self.id.clone());
        self.goal_call(Box::pin(async move {
            let _ = goals.archive_completed_on_user_input(&thread).await;
            JobDone::GoalArchived(archived)
        }));
    }

    /// Hands encoded records to the durability task in order, releases what is ready, and
    /// publishes the released frames and the storage state.
    fn pump(&mut self) {
        for (id, record, bytes) in self.outbox.handoff() {
            let msg = ToDurability::Append {
                id,
                generation: self.generation,
                record,
                bytes,
            };
            // The window bounds unacked records below the channel's capacity.
            if self.ch.dur_tx.try_send(msg).is_err() {
                self.fail_all(CoreError::StorageIndeterminate {
                    scope: "thread".into(),
                });
                return;
            }
        }
        let mut notes = Vec::new();
        while let Some((entry, ordinal)) = self.outbox.pop_ready() {
            self.release(entry, ordinal, &mut notes);
        }
        let storage = self.storage();
        if storage != self.published_storage {
            self.published_storage = storage;
            notes.push(self.runtime_note());
        }
        if !notes.is_empty() {
            self.publish(notes);
        }
        self.publish_cell();
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
        let queue_len = self.acked.queue.len();
        self.acked.apply(&entry.change, ordinal);
        if let Some(ordinal) = ordinal {
            self.acked_end = self.acked_end.max(ordinal + 1);
        }
        if let Change::Record { record, display } = &entry.change
            && let (Record::Item(row), Display::Items(shown)) = (&**record, display)
        {
            for shown in shown {
                match shown {
                    Shown::Item(item) => {
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
                        if let Some(merged) = self.acked.shown(update.id()) {
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
        }
        notes.extend(entry.notes);
        self.derived_notes(&entry.change, &title, queue_len, notes);
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
        queue_before: usize,
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
                Record::Queue(_) => {
                    let _ = queue_before;
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
            Section::Runtime(_) => self.runtime_note(),
            Section::Route(v) => note("thread/route/updated", t, v),
            Section::Context(v) => note("thread/context/updated", t, v),
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
                if let Some(op) = &op {
                    self.ops.applied(op, &value);
                }
                if let Some(tx) = tx {
                    let _ = tx.send(Ok(Reply::Value(value)));
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
        }
    }

    fn fail_entry(&mut self, entry: Entry, error: &CoreError) {
        for effect in entry.effects {
            match effect {
                Effect::Reply { op, tx, .. } => {
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
                    if let Some(aid) = crate::approvals::parse_id(&request.id) {
                        self.book.forget(aid);
                    }
                }
                Effect::Resolved(aid, _) => self.book.unresolve(aid),
                Effect::RecomputePrompts { .. } => {}
            }
        }
    }

    /// A barrier failed: nothing after the acked state is applied (RL §6.1).
    fn fail_all(&mut self, error: CoreError) {
        for entry in self.outbox.fail_all() {
            self.fail_entry(entry, &error);
        }
        self.generation += 1;
        self.projected = self.acked.clone();
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
        let approvals: std::collections::HashSet<u64> =
            self.book.decidable().into_iter().map(|aid| aid.0).collect();
        if **self.cell.approvals.load() != approvals {
            self.cell.approvals.store(Arc::new(approvals));
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
            FromDurability::Failed { generation, error } => {
                if generation != self.generation {
                    return;
                }
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
                self.fail_all(error);
            }
            FromDurability::Pending(pending) => self.pending = pending,
            FromDurability::Retried(result) => self.indeterminate = result.is_err(),
        }
    }

    // ───────────── control lane ─────────────

    fn on_ctl(&mut self, ctl: Ctl) {
        match ctl {
            Ctl::Abort { turn } => {
                if self.run.as_ref().is_some_and(|run| run.turn == turn) {
                    let now = self.deps.clock.now_ms();
                    for aid in self.book.take_run(&turn) {
                        self.resolve(aid, &turn, ApprovalResolution::Interrupted { at: now });
                    }
                }
            }
            Ctl::Steer => {
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
            Ctl::Decide(decision) => {
                let device = self.deps.devices.describe(decision.connection);
                let at = self.deps.clock.now_ms();
                match self
                    .book
                    .validate(&decision.request, &decision.result, device, at)
                {
                    Ok(Some(accepted)) => {
                        self.resolve(accepted.aid, &accepted.rid, accepted.resolution)
                    }
                    Ok(None) => {}
                    Err(error) => self
                        .deps
                        .server_requests
                        .response_rejected(decision.connection, error),
                }
            }
            Ctl::RunEnded { turn, outcome } => self.run_ended(turn, outcome),
            Ctl::RetryStorage => {
                let _ = self.ch.dur_tx.try_send(ToDurability::Retry);
            }
            Ctl::RefreshSurface => self.refresh_surface(),
            Ctl::Unsubscribed => self.try_unload(),
            Ctl::Delete { reason, idle, closed, mark, marked } => self.delete(&reason, idle, closed, mark, marked),
            Ctl::Shutdown(done) => {
                self.cell.closed.store(true, SeqCst);
                if let Some(run) = &self.run {
                    // Teardown's `quiesce('cli-exit')`.
                    run.cancel.abort(&mixdog_agent::cancel::session_closed(self.id.as_str(), "runtime close (reason=cli-exit)"));
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
        let Some(slot) = self.run.take_if(|run| run.turn == turn) else {
            return;
        };
        self.cell.publish_run(None);
        // An ended turn has no working messages left (`liveTurnMessages` ends with the turn).
        self.cell.turn_messages.send_replace(Default::default());
        self.steer_marked.clear();
        // `onTurnSettled`: the run host's final result as it is, for a finished turn only.
        let settled = TurnOutcome {
            turn_id: turn.as_str().to_owned(),
            done: matches!(outcome, RunOutcome::Completed(_)),
            result: match &outcome {
                RunOutcome::Completed(result) => Some((**result).clone()),
                _ => None,
            },
        };
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
        let detail = super::goal_lane::settle_detail(status, error, slot.automatic, slot.tool_calls);
        let (goals, thread) = (self.deps.goals.clone(), self.id.clone());
        self.goal_call(Box::pin(async move { JobDone::GoalSettled(goals.turn_settled(&thread, detail).await.ok()) }));
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
                let meta = Record::Meta(MetaRecord { op: None, change: Slot::Inline(HeaderChange { set, unset: Vec::new() }) });
                self.accept_record(meta, Class::Control, Display::None, Vec::new(), Vec::new());
            }
        }
        if self.deleting {
            self.delete_turn_ended();
            return;
        }
        self.start_next_queued();
        self.try_unload();
    }

    /// Today's `terminalSave.then(() => ingestSessionTurn(session))`: once the completed turn's
    /// terminal record is durable, its model context goes to the session-search copy. A failed
    /// save ingests nothing.
    fn ingest_when_durable(&self) -> oneshot::Sender<Result<(), RunError>> {
        let (tx, rx) = oneshot::channel();
        let context = ModelContext {
            store: self.deps.store.clone(),
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

    /// The next queued entry becomes a run (P X9: busy → queued, follow-ups run in order).
    ///
    /// A completion no turn took is a wake of its own, oldest first, with the completion as the
    /// turn's input, never an empty user turn (`notification-bus.mjs:69-76` replays a wake
    /// suppressed while one was in flight; `ask-queue.mjs:87-101` runs each notification as its
    /// own turn). Without wakes, completions wait for the next turn to take them.
    fn start_next_queued(&mut self) {
        if self.run.is_some() || self.deleting {
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
            .find(|q| wake || !completions::is_notification(&q.entry))
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
                .filter(|q| completions::is_notification(&q.entry) && q.qid != next.qid)
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
        // An automatic Goal turn: its prompt is runtime-synthetic, shown as no user row.
        if super::goal_lane::is_goal_entry(&next.entry) {
            let input = TurnInput { prompt: PromptContent::Text(completions::text(&next.entry)), options: None };
            self.start_run_with(input, super::goal_lane::input_row(&next.entry), None, None, None, false);
            return;
        }
        let input = TurnInput {
            prompt: serde_json::from_value(next.entry["message"].clone())
                .unwrap_or(PromptContent::Text(String::new())),
            options: serde_json::from_value(next.entry["options"].clone()).ok(),
        };
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

    fn active(&self, turn: &TurnId) -> bool {
        self.run.as_ref().is_some_and(|run| &run.turn == turn)
    }

    fn on_producer(&mut self, msg: ProducerMsg) {
        match msg {
            ProducerMsg::Section(section) => self.accept_view(Change::Section(section), Vec::new()),
            ProducerMsg::ItemStarted { turn, item } => {
                if !self.active(&turn) {
                    return;
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
                let note = Note { method, params };
                self.accept_view(Change::Delta { item, text }, vec![note]);
            }
            ProducerMsg::Shown { turn, shown } => {
                if self.active(&turn) {
                    self.run_shown(turn, shown);
                }
            }
            ProducerMsg::Commit { turn, item, ack } => {
                if !self.active(&turn) {
                    let _ = ack.send(Err(RunError::NotApplied));
                    return;
                }
                let display = self.row_display(item.role.as_deref(), &item.body);
                if item.role.as_deref() == Some("tool")
                    && let Some(run) = self.run.as_mut()
                {
                    run.tool_calls += 1;
                }
                match self.item_record(&turn, item, None) {
                    Ok(record) => self.accept_record(
                        record,
                        Class::Normal,
                        display,
                        Vec::new(),
                        vec![Effect::ItemAck(ack)],
                    ),
                    Err(_) => {
                        let _ = ack.send(Err(RunError::NotApplied));
                    }
                }
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
            ProducerMsg::Compacted {
                turn,
                compaction,
                ack,
            } => {
                if !self.active(&turn) {
                    let _ = ack.send(Err(RunError::NotApplied));
                    return;
                }
                // A compaction that changed the context drops the provider continuation
                // (`compaction-runner.mjs:701`).
                if let Some(reset) = self.provider_state_change(None) {
                    self.accept_record(reset, Class::Normal, Display::None, Vec::new(), Vec::new());
                }
                let record = Record::Compacted(CompactedRecord {
                    cid: id(&new_id()),
                    summary_iid: None,
                    op: None,
                    at: Some(compaction.at),
                    dropped_count: Some(compaction.dropped_count),
                    dropped: compaction.dropped.map(|d| CompactedDropped {
                        message_ids: d.message_ids,
                        call_ids: d.call_ids,
                    }),
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
                self.accept_record(
                    record,
                    Class::Normal,
                    Display::None,
                    Vec::new(),
                    vec![Effect::ItemAck(ack)],
                );
            }
            ProducerMsg::Approval { turn, ask, reply } => {
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
                self.request_approval(turn, ask, reply);
            }
            ProducerMsg::TakeSteers {
                turn,
                request,
                reply,
            } => {
                if !self.active(&turn) {
                    let _ = reply.send(Vec::new());
                    return;
                }
                let max_priority = request.max_priority;
                let mut taken: Vec<QueuedId> = Vec::new();
                let mut out: Vec<SteerInput> = Vec::new();
                for qid in &self.steer_marked {
                    if let Some(q) = self.acked.queue.iter().find(|q| {
                        q.qid == qid.as_str() && within_priority(&q.entry, max_priority)
                    }) {
                        taken.push(qid.clone());
                        out.push(pending::steered(qid.clone(), &q.entry));
                    }
                }
                self.steer_marked.retain(|qid| !taken.contains(qid));
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
                        let groups = pending::groups(&durable);
                        // Nothing that carries content is released back to the queue.
                        if !groups.is_empty() {
                            taken.extend(durable.into_iter().map(|(qid, _)| qid));
                            out.extend(groups);
                        }
                    }
                }
                for qid in &taken {
                    // A completion the listener already showed comes back as the turn's row
                    // with no row of its own (`suppressDisplay`).
                    if let Some(q) = self.acked.queue.iter().find(|q| q.qid == qid.as_str())
                        && let Some(execution) = suppressed_execution(&q.entry)
                    {
                        self.suppressed.insert(execution);
                    }
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
        }
    }

    /// A run's live-only line or notification (`RunPort::notice`, `usage`, `compact_event`).
    fn run_shown(&mut self, turn: TurnId, shown: RunShown) {
        match shown {
            RunShown::Notice(text) => {
                let text = super::live_rows::polish_notice_text(&text);
                if text.is_empty() {
                    return;
                }
                let item = super::transcript::notice_item(&new_id(), turn.as_str(), &text, "info");
                self.show_live(turn, item, None);
            }
            RunShown::Usage { iteration, usage } => {
                let usage = super::live_rows::usage_delta(self.id.as_str(), iteration, &usage, self.deps.clock.now_ms());
                let note = Note::new(
                    "thread/tokenUsage/updated",
                    &mixdog_app_protocol::v2::thread::TokenUsageUpdatedParams { thread_id: self.id.clone(), usage },
                );
                self.accept_view(Change::Barrier, vec![note]);
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
        let note = Note::new("item/completed", &ItemNotificationParams { thread_id: self.id.clone(), turn_id: turn, item: item.clone() });
        self.accept_view(Change::Shown { item, before }, vec![note]);
    }

    /// The live display of a user row: the row of a completion the listener showed is durable
    /// but shows no row of its own.
    fn row_display(&mut self, role: Option<&str>, body: &Value) -> Display {
        let execution = (role == Some("user")).then(|| body.pointer("/meta/execution/id").and_then(Value::as_str)).flatten();
        match execution {
            Some(execution) if self.suppressed.remove(execution) => Display::Suppressed,
            _ => Display::None,
        }
    }

    /// A row's facts from the classification migration writes.
    fn user_facts(&self, body: &mut Value) -> RowFacts {
        user_facts(body, self.deps.attachments.as_ref())
    }

    fn item_record(
        &self,
        turn: &TurnId,
        mut item: ItemCommit,
        op: Option<OpRef>,
    ) -> Result<Record, CoreError> {
        let facts = self.user_facts(&mut item.body);
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
            Inbox::TaskNotification {
                surface,
                task_id,
                status,
                text,
                live,
            } => self.task_notification(&surface, task_id, status, text, live),
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
                self.apply_plan(plan, req.op.clone(), tx);
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
            .then(|| prompt_text(&params.input));
        if user_prompt.is_some() {
            self.archive_goal_on_user_input();
        }
        if self.run.is_none() {
            let value = json!({ "kind": "started" });
            let op_ref = self.op_ref(req, None)?;
            return Ok(Plan {
                kind: PlanKind::StartRun(params.input, op_ref),
                value,
                after: None,
                prompt: user_prompt,
            });
        }
        let qid = new_id();
        let value = json!({ "kind": "queued", "queuedId": qid });
        let mut entry = json!({
            "message": params.input.prompt,
            "enqueuedAt": self.deps.clock.now_ms(),
        });
        if let Some(options) = &params.input.options {
            entry["options"] = serde_json::to_value(options).expect("protocol types serialize");
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

    fn queue_delete(&mut self, req: &CoreRequest) -> Result<Plan, CoreError> {
        let params: ThreadQueueDeleteParams = parse(&req.params, "ThreadQueueDeleteParams")?;
        let qid = params
            .queued_id
            .clone()
            .ok_or_else(|| invalid("queuedId", "a queued entry id"))?;
        let Some(queued) = self.projected.queue.iter().find(|q| q.qid == qid.as_str()).cloned()
        else {
            return Err(CoreError::QueuedEntryNotFound {
                thread_id: self.id.clone(),
                queued_id: qid,
            });
        };
        let value = json!({});
        let record = Record::Queue(QueueRecord {
            qid: id(&queued.qid),
            action: QueueAction::Dequeue,
            reason: Some(DequeueReason::Cancelled),
            op: self.op_ref(req, Some(&value))?,
            entry: None,
        });
        let mut extra = Vec::new();
        if params.restore {
            let text: String = serde_json::from_value::<PromptContent>(queued.entry["message"].clone())
                .map(|prompt| prompt_text(&TurnInput { prompt, options: None }))
                .unwrap_or_default();
            let device = match req.ctx.caller {
                Caller::Connection(connection) => self.deps.devices.describe(connection).device,
                Caller::Internal(name) => name.to_owned(),
            };
            extra.push(Change::Section(Section::PromptRestore(Some(PromptRestore {
                id: queued.qid.clone(),
                ids: vec![queued.qid.clone()],
                text: text.clone(),
                device,
                at: self.deps.clock.now_ms(),
            }))));
            extra.push(Change::PromptWithout(text));
        }
        Ok(Plan {
            kind: PlanKind::Records(vec![(record, Class::Normal, Display::None, Vec::new())], extra),
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
        let index = window
            .iter()
            .position(|row| row.item.id() == &params.item_id)
            .ok_or_else(not_found)?;
        let target = &window[index];
        let (Some(ordinal), Some(text)) = (target.ordinal, target.prompt.clone()) else {
            return Err(not_found());
        };
        let previous = index.checked_sub(1).map(|i| window[i].item.id().clone());
        let value = json!({ "text": text, "removed": window.len() - index });
        let record = Record::Rewind(RewindRecord {
            to_ordinal: ordinal,
            reason: RewindReason::Rewind,
            op: self.op_ref(req, Some(&value))?,
        });
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
        let note = self.history_reset(HistoryResetReason::Clear, None);
        let mut records = vec![(record, Class::Normal, Display::None, vec![note])];
        // A cleared session starts without provider state (`session-crud.mjs:137`), and with its
        // environment reset (`resetSessionBp3Environment`), in one header change.
        let mut change = crate::run_host::route_change::environment_reset(&self.projected.header);
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
        Ok(Plan {
            kind: PlanKind::Records(records, Vec::new()),
            value,
            after: Some(true),
            prompt: None,
        })
    }

    fn name_set(&mut self, req: &CoreRequest) -> Result<Plan, CoreError> {
        let params: ThreadNameSetParams = parse(&req.params, "ThreadNameSetParams")?;
        let value = json!({});
        let mut set = serde_json::Map::new();
        set.insert("title".into(), Value::String(params.title));
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
        let messages = req.params.get("messages").and_then(Value::as_array).cloned().unwrap_or_default();
        let mut records = Vec::with_capacity(messages.len() + 1);
        for mut body in messages {
            let role = body.get("role").and_then(Value::as_str).map(|role| text(role, "role")).transpose()?;
            let facts = self.user_facts(&mut body);
            let row = ItemRecord {
                iid: text(&new_id(), "itemId")?,
                turn: None,
                role,
                form: Form::Message,
                model: true,
                visible: facts.visible,
                archive: None,
                op: None,
                prompt: facts.prompt.map(Slot::Inline),
                refs: Vec::new().try_into().expect("empty list fits"),
                body: Slot::Inline(body),
            };
            records.push((Record::Item(row), Class::Normal, Display::None, Vec::new()));
        }
        let value = json!({ "added": records.len() });
        let mut set = serde_json::Map::new();
        set.insert("updatedAt".into(), json!(self.deps.clock.now_ms()));
        let meta = Record::Meta(MetaRecord { op: None, change: Slot::Inline(HeaderChange { set, unset: Vec::new() }) });
        records.push((meta, Class::Normal, Display::None, Vec::new()));
        // A row's prompt joins the prompt history as it is applied.
        Ok(Plan { kind: PlanKind::Records(records, Vec::new()), value, after: None, prompt: None })
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
    fn task_notification(&mut self, surface: &str, task_id: String, status: String, text: String, live: bool) {
        let Some((qid, mut entry)) =
            completions::entry(surface, &task_id, &status, &text, self.deps.clock.now_ms())
        else {
            return;
        };
        // Queued by the listener that showed it (`execution-delivery.mjs` `suppressDisplay`).
        if self.listened.remove(&task_id) {
            entry["suppressDisplay"] = Value::Bool(true);
        }
        // The same completion queued twice is one entry (`pendingIdStillQueued`).
        if self.projected.queue.iter().any(|q| q.qid == qid) {
            return;
        }
        let record = Record::Queue(QueueRecord {
            qid: id(&qid),
            action: QueueAction::Enqueue,
            reason: None,
            op: None,
            entry: Some(Slot::Inline(entry)),
        });
        self.accept_record(record, Class::Normal, Display::None, Vec::new(), Vec::new());
        self.deps
            .wakes
            .interrupt(&self.id, WakeReason::Notification, Some(task_id));
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
        let turn = TurnId::from(new_id());
        let facts = self.user_facts(&mut body);
        let mut op_ref = op_ref;
        let value = json!({ "kind": "started", "turnId": turn });
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
        let review = super::turn_snapshot::TurnSnapshot::new(self.deps.turn_review.clone(), self.id.as_str(), checkpoint, wake);
        let input_body = body.clone();
        let input_display = self.row_display(Some("user"), &input_body);
        let item = Record::Item(ItemRecord {
            iid: id(input_iid.as_str()),
            turn: Some(id(turn.as_str())),
            role: Some(Text::try_from("user").expect("short")),
            form: Form::Message,
            model: true,
            visible: facts.visible,
            archive: None,
            op: op_ref,
            prompt: facts.prompt.map(Slot::Inline),
            refs: Vec::new().try_into().expect("empty list fits"),
            body: Slot::Inline(body),
        });
        self.accept_record(item, Class::Normal, input_display, Vec::new(), Vec::new());
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
        self.run = Some(RunSlot {
            turn: turn.clone(),
            input_item: input_iid.clone(),
            automatic: super::goal_lane::automatic(&input_body),
            tool_calls: 0,
            cancel: cancel.clone(),
            input: input_tx,
            start_failed: false,
            _marks: marks,
        });
        // `onGoalTurnStarted`: the turn takes the Goal's open clock segment.
        let (goals, thread) = (self.deps.goals.clone(), self.id.clone());
        self.goal_call(Box::pin(async move { JobDone::GoalSeen(goals.turn_started(&thread).await.ok()) }));
        self.cell.publish_run(Some(Arc::new(ActiveRun {
            turn: turn.clone(),
            cancel: cancel.clone(),
            steers: Default::default(),
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
        let port = RunPort {
            thread: self.id.clone(),
            turn: turn.clone(),
            tx: self.ch.prod_tx.clone(),
            input: input_rx,
            provider: self
                .acked
                .header
                .get(PROVIDER_STATE)
                .and_then(|state| serde_json::from_value(state.clone()).ok()),
        };
        // A session takes moved settings gates at its next turn start (today's
        // `stageToolAvailability`).
        self.refresh_surface();
        let future = self.deps.runs.start(RunStart {
            thread: self.id.clone(),
            turn: turn.clone(),
            input,
            input_item: input_iid.clone(),
            input_body,
            header: self.acked.header.clone(),
            port,
            context: ModelContext {
                store: self.deps.store.clone(),
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
            let outcome = future.await;
            // The turn's review is sealed before the turn reports settled.
            review.finish(cancel.is_aborted()).await;
            let _ = ctl.send(Ctl::RunEnded { turn, outcome }).await;
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
        let _ = self.deps.lanes.io.submit(&CancellationToken::new(), move |lane| {
            let _ = jobs.send(JobDone::PromptPersisted(prompts.load(lane, &cwd)));
        });
    }

    /// `appendPromptHistory(cwd, text)` for a user-submitted prompt, off the actor.
    fn persist_prompt(&mut self, prompt: String) {
        if prompt_history::key(&prompt).is_empty() {
            return;
        }
        let prompts = self.deps.prompts.clone();
        let jobs = self.jobs_tx.clone();
        let cwd = self.cwd();
        let _ = self.deps.lanes.durability.submit(&CancellationToken::new(), move |lane| {
            let _ = jobs.send(JobDone::PromptPersisted(prompts.append(lane, &cwd, &prompt)));
        });
    }

    /// The session part over the remaining lineage after a history mutation.
    fn recompute_prompts(&mut self, publish: bool) {
        let deps = self.deps.clone();
        let jobs = self.jobs_tx.clone();
        let thread = self.id.clone();
        let _ = self.deps.lanes.io.submit(&CancellationToken::new(), move |lane| {
            let Ok(rows) = deps.store.user_rows(lane, &thread) else {
                return;
            };
            let texts: Vec<String> = rows.iter().filter_map(|row| row.prompt_text().map(str::to_owned)).collect();
            let session = prompt_history::recompute(&texts);
            let _ = jobs.send(JobDone::PromptSession { session, publish });
        });
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
        Some(deadline) => tokio::time::sleep_until(deadline).await,
        None => std::future::pending().await,
    }
}

/// A delete's go for its mark; an error when the delete dropped it.
async fn mark_go(mark: &mut Option<oneshot::Receiver<()>>) -> Result<(), oneshot::error::RecvError> {
    match mark {
        Some(mark) => mark.await,
        None => std::future::pending().await,
    }
}

