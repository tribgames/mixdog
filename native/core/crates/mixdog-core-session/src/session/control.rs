use std::collections::HashSet;
use std::collections::VecDeque;
use std::sync::Arc;
use std::sync::Mutex;

use arc_swap::ArcSwap;
use arc_swap::ArcSwapOption;
use mixdog_agent::cancel::Cancel;
use mixdog_core_api::CoreError;
use mixdog_core_api::ids::QueuedId;
use mixdog_core_api::ids::ThreadId;
use mixdog_core_api::ids::TurnId;
use mixdog_core_api::thread::Decision;
use mixdog_store::schema::record::Header;
use mixdog_tools::policy::SessionSurface;
use serde_json::Value;
use serde_json::json;
use tokio::sync::mpsc;
use tokio::sync::watch;

use mixdog_agent::agent_tool::flow::seams::TurnListener;

use mixdog_core_ports::ports::gate::LiveHeader;

use super::seams::RunOutcome;
use super::view::SessionView;

/// Messages of the actor's control lane, polled before everything else.
pub(crate) enum Ctl {
    /// A run's approval request. It rides the control lane (RL §6.2) so a producer lane the actor
    /// stopped reading, while the durability window is full, cannot hold it.
    Approval {
        turn: TurnId,
        ask: mixdog_core_api::domain::approval::ApprovalAsk,
        reply: tokio::sync::oneshot::Sender<mixdog_protocol::ApprovalResolution>,
    },
    /// The run's token is already cancelled; the actor resolves the run's own requests.
    Abort {
        turn: TurnId,
    },
    /// A run let go of its call `call_id`, which goes on in the background: the call's approvals, asked before or after,
    /// stay open past the run's end. A stop of the run still ends them, as it ends the call.
    Detach {
        call_id: String,
    },
    /// A call let go of ([`Ctl::Detach`]) ended, however it ended: its approvals still open are closed.
    Released {
        call_id: String,
    },
    /// A Stop with no published run: the actor stops whatever the session's busy span holds (a start, a settlement, a
    /// compaction) through its owner and says what it found.
    StopBusy(tokio::sync::oneshot::Sender<BusyStop>),
    /// A Stop of the published run `turn`: the actor decides the prompt's disposition (under the prompt's lock, against any output
    /// commit), aborts the run at once, appends the Stop's record and answers with the decision and the record's durable-only
    /// waiter. A run whose end is already in (parked or applied) is no longer stoppable: the actor answers what the busy span holds.
    StopRun {
        turn: TurnId,
        named: bool,
        restore_prompt: Option<bool>,
        canceller: String,
        unreadable: bool,
        reply: tokio::sync::oneshot::Sender<RunStop>,
    },
    /// A Stop while the scheduled compaction holds the session hands the newest editable queued prompt `qid` back to the canceller:
    /// the actor freezes that entry under a recorded Stop (it leaves the queue and never runs) and answers the hand-back's id (the
    /// reply carries it) and the Stop's durable-only waiter, or `None` when the entry is gone.
    StopQueued {
        qid: String,
        canceller: String,
        reply: tokio::sync::oneshot::Sender<Option<(Option<String>, super::stop::StopWait)>>,
    },
    /// A user Stop of exactly the work submitted under `submissions` (a room Stop of its exchange's member submissions): the
    /// actor freezes each and answers the durable-only waiters of their Stops.
    StopWork {
        submissions: Vec<String>,
        reply: tokio::sync::oneshot::Sender<Vec<super::stop::StopWait>>,
    },
    /// `turn/steer`: the queued prompt is prioritized (front of the queue, priority `now`, a drain kicked), and the
    /// entries pushed into the active run's steer queue are taken.
    Prioritize {
        queued: QueuedId,
    },
    /// A decision on a server request. `arbitrated`, when given, is answered once the actor took it (`true`: it resolved the
    /// request) or found the request resolved or resolving (`false`), or with why it is not a valid decision.
    Decide(Decision, Option<tokio::sync::oneshot::Sender<Result<bool, CoreError>>>),
    RunEnded {
        turn: TurnId,
        outcome: RunOutcome,
    },
    /// The user's "Retry storage" (SM §8 `PendingRollback`).
    RetryStorage,
    /// [`Self::RetryStorage`] for a caller that waits for it: answered at once while the log holds no write of unknown
    /// outcome, else by the retry's own answer.
    Reconcile(tokio::sync::oneshot::Sender<Result<(), CoreError>>),
    /// The values the actor holds now for these header keys (`null` for absent), as it projects them: what it judges a
    /// conditional header patch against, a change it accepted and has not saved yet included.
    Held(&'static [&'static str], tokio::sync::oneshot::Sender<serde_json::Map<String, serde_json::Value>>),
    /// A tool-policy input outside the thread changed (a setting, a connector policy).
    RefreshSurface,
    /// A client resumed the thread: what its queue holds from before a restart drains, as the desktop's resume drains the
    /// rows it restored (`restoreLeadSteeringFromDisk`, then the release hook, `session-api/lifecycle/resume.mjs:72`), and
    /// the idle clock starts over (`addSubscriber`'s `idleClock.refresh`).
    Resumed,
    /// A workspace change applied the session's cwd (`applyResolvedCwd`), `changed` when the
    /// folder moved: the code-graph warm follows.
    CwdApplied {
        changed: bool,
    },
    /// The last subscriber left: the thread goes back on the idle clock.
    Unsubscribed,
    /// The thread's tombstone landed (`closeSession`): no Goal continues it, and once its turn
    /// has ended it unloads (`_clearSessionRuntime`) even if it was never subscribed. Answered once the actor took it,
    /// so a write after the close finds either the live actor or none (it opens the thread again), never one ending.
    Closed(tokio::sync::oneshot::Sender<()>),
    /// Core shutdown: the actor stops and hands back its memory ingest.
    Shutdown(tokio::sync::oneshot::Sender<futures::future::BoxFuture<'static, ()>>),
    /// `thread/delete`'s close (`closeSession(id, reason)`): the thread takes no more work, its
    /// pending approvals are resolved, a running turn is aborted with `reason`; `closed`
    /// answers once the turn ended. With `idle`, a running turn or queued input refuses
    /// instead (`busy`, `queued`) and nothing changes. Then the header change `mark` carries is
    /// appended (the delete mark `{deleted: true}`, or an idle close's tombstone), `marked`
    /// answering at its ack, and the actor stops; a dropped `mark` stops it unmarked. A `guard` is rechecked here, on the actor, before anything is closed
    /// (`changed` refuses): Node hands `treeChanged` to the delete and asks it again inside
    /// the destructive step.
    Delete {
        abort: mixdog_agent::cancel::Abort,
        idle: bool,
        guard: Option<DeleteGuard>,
        closed: tokio::sync::oneshot::Sender<Result<(), &'static str>>,
        mark: tokio::sync::oneshot::Receiver<serde_json::Map<String, serde_json::Value>>,
        marked: tokio::sync::oneshot::Sender<Result<(), super::run::RunError>>,
    },
}

/// An accepted takeover: the turn that ended, the message that took it over, and the turn reserved for that message. One
/// record, written in the actor's deciding step and read wherever the transition is read (the old turn's end, the queue's next
/// start, a boundary of the old turn, a later takeover or Stop).
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct Takeover {
    /// The operation that made it.
    pub op: String,
    /// The turn the takeover named. No other takeover is accepted for it.
    pub turn: TurnId,
    /// The queue id of the message that took it over: the next turn's input, and nothing else's.
    pub message: String,
    /// The submission that message answers (`clientSubmissionId`), which its turn's row carries.
    pub submission: Option<String>,
    /// The takeover asked the turn to stop: its abort was fired, and was the first on the run. It does not say how the turn
    /// ended (a run whose completion was already on its way ends completed); the turn's end row says that, with
    /// [`super::actor::MESSAGE_CAUSE`] when this abort is what ended it. False: the turn was already at its end, and no abort
    /// was fired.
    pub interrupted: bool,
    /// The turn the message started, once it did.
    pub successor: Option<TurnId>,
}

/// What the actor answers a Stop of the published run ([`Ctl::StopRun`]).
#[derive(Debug)]
pub(crate) enum RunStop {
    /// The run was stopped: the decision over its prompt, the waiter of the Stop's durable record, and the id of the hand-back the
    /// Stop owes (a reply carrying the restored text names it, as the notification does).
    Decided(super::stop::Decision, super::stop::StopWait, Option<String>),
    /// The named turn is not the one running.
    NotActive,
    /// The run had already ended: what the busy span held instead.
    Busy(BusyStop),
}

/// What a Stop found of the busy span when no run was published.
#[derive(Debug)]
pub(crate) enum BusyStop {
    /// Something was under way and its owner was told to stop; each waiter is a Stop record's durable-only answer (none when the
    /// Stop froze no work: a compaction, or a settlement with no completion queued for its wake).
    Stopped(Vec<super::stop::StopWait>),
    /// Nothing was under way.
    Idle,
    /// Something is under way that has no owner to cancel (the named stage).
    Unstoppable(&'static str),
}

/// What a retention delete re-asks under the thread's own admission: the thread must still be
/// as the pass read it (nobody attached, no run, nothing queued, `activity` unmoved), and the
/// sweep must not be shut down.
pub(crate) struct DeleteGuard {
    pub activity: f64,
    pub cancel: mixdog_rt::CancellationToken,
    /// The other members of the session's tree and the activity the sweep read for each
    /// (`treeChanged`): any that is open now, or whose stored activity differs, refuses.
    pub peers: Vec<(ThreadId, f64)>,
    /// The directory's open count when the peers' stored activity was read; an open since
    /// (which could have changed a peer and unloaded it again) refuses.
    pub opens: u64,
}

/// The admission word's closed bit.
pub(crate) const CLOSING: usize = 1 << (usize::BITS - 1);
/// The admission word's history bit: an attach was admitted at some time.
pub(crate) const ATTACHED: usize = 1 << (usize::BITS - 2);
/// The admission word's attach count.
const COUNT: usize = ATTACHED - 1;

/// A worker's turn waiting for its run to start.
pub(crate) struct AgentStart {
    pub turn: super::seams::AgentTurn,
    /// The model content of the turn's input row (`handoffContent`).
    pub content: serde_json::Value,
    /// Answered with the run's outcome when it ends.
    pub done: tokio::sync::oneshot::Sender<RunOutcome>,
}

/// A routine fire's turn waiting in the thread's queue, keyed by its submission id
/// (`routine_<uuid>`); the actor takes it when the entry becomes a run (`routine-home-turn.mjs`
/// `options`).
pub(crate) struct RoutineStart {
    /// The model content of the turn's input row.
    pub content: serde_json::Value,
    /// `transcriptMeta.routineTrigger`: the marker row the turn shows.
    pub trigger: Option<serde_json::Value>,
    /// `transcriptMeta.hop`: how deep in bot-descended turns the one that asked for this is.
    pub hop: Option<u32>,
    /// `transcriptMeta.botChain`: the bots that handed the message on, sender last.
    pub bot_chain: Vec<String>,
    /// `transcriptMeta.roomRow`: the room's newest user row the prompt shows (a member's turn).
    pub room_row: Option<String>,
    /// `transcriptMeta.sender`: who sent the message (`lead` for the `session` tool's send).
    pub sender: Option<&'static str>,
    /// `transcriptMeta.fromAgent`: the bot that wrote into another bot's chat.
    pub from_agent: Option<String>,
    /// The trusted text the turn's skills are selected from.
    pub skill_selection: Option<String>,
    /// The sender's own `transcriptMeta` (`sendTranscriptMeta`: `sender`, `fromAgent`), ahead of
    /// the hop and the bot chain on the queue entry and the input row.
    pub meta: serde_json::Map<String, serde_json::Value>,
    /// `onCommitted`: runs the moment the turn starts, before any tool can.
    pub on_start: Box<dyn FnOnce() + Send>,
    /// Answered with the run's outcome when it ends.
    pub done: tokio::sync::oneshot::Sender<RunOutcome>,
}

/// The active run as RT-C sees it.
pub(crate) struct ActiveRun {
    pub turn: TurnId,
    /// The run's signal: aborted with Node's reason text.
    pub cancel: Cancel,
    /// Queue entries marked steer, waiting for the run's next model-call boundary.
    pub steers: Mutex<VecDeque<QueuedId>>,
    /// The prompt that started the run: what a stop may hand back (`flags.activePromptRestore`).
    pub prompt: Arc<super::stop::PromptState>,
    pub unsaved_messages: std::sync::atomic::AtomicU64,
}

/// Whether a thread, or the control start that becomes it, has not ended. Every end (a close of the thread's cell, an abandoned
/// start) is a transition under its lock, and the config's adoption writes the thread's route under the same lock
/// ([`Self::while_live`]), so a write and an end are ordered: the write never reaches a thread that ended before it.
#[derive(Default)]
pub(crate) struct Liveness(Mutex<bool>);

impl Liveness {
    /// Runs `f` unless the thread ended; the thread does not end while `f` runs.
    pub fn while_live(&self, f: impl FnOnce()) {
        let ended = lock(&self.0);
        if !*ended {
            f();
        }
    }

    /// The end's lock: set the guard to `true` when the end is taken.
    pub fn ending(&self) -> std::sync::MutexGuard<'_, bool> {
        lock(&self.0)
    }
}

pub(crate) struct ControlCell {
    pub thread: ThreadId,
    /// The thread's [`Liveness`]: a control start's own when the thread was created from it. Every close below ends it.
    pub liveness: Arc<Liveness>,
    pub run: ArcSwapOption<ActiveRun>,
    /// Queue entries that exist (projected).
    pub queued: ArcSwap<HashSet<String>>,
    /// The same entries in queue order with their stored form (projected): what the pending
    /// queue reads answer from.
    pub queue: ArcSwap<Vec<super::state::Queued>>,
    /// Approval ids that accept a decision.
    pub approvals: ArcSwap<HashSet<u64>>,
    /// The approval the session shows now (`state.toolApproval`), if any.
    pub shown_approval: ArcSwapOption<mixdog_core_api::domain::approval::ApprovalRequest>,
    /// Counts the changes of `shown_approval`; its receivers wake on each.
    pub shown_changed: tokio::sync::watch::Sender<u64>,
    /// What the session's open takeover holds (the secret fill's two locks read it).
    pub takeover: ArcSwap<super::secret_input::TakeoverHold>,
    /// The acked view (thread/read, resume results).
    pub view: ArcSwap<SessionView>,
    /// The acked header, republished when a header change is acked.
    pub header: ArcSwap<Header>,
    /// The session's tool-policy surface, as the actor publishes it.
    pub surface: watch::Receiver<Arc<SessionSurface>>,
    /// The running turn's progress, published by the run (`RunStart::progress`); the worker
    /// views and the registry read it here, never from a copy.
    pub progress: watch::Sender<mixdog_core_run::run_host::progress::RunProgress>,
    /// The running turn's working messages before they are committed (Node
    /// `session.liveTurnMessages`), published by the run (`RunStart::turn_messages`); empty
    /// between turns.
    pub turn_messages: watch::Sender<Arc<Vec<super::transcript::LiveRow>>>,
    /// Who observes this session's turns (`observeSessionTurns`), by subscription id; told
    /// when a turn starts and when it settles.
    pub turn_listeners: Mutex<Vec<(u64, Arc<dyn TurnListener>)>>,
    /// The worker turn the next `turn/start` of this thread runs (set by `SessionTurns` just
    /// before its start request; the actor takes it when it starts the run).
    pub agent_start: Mutex<Option<AgentStart>>,
    /// Routine turns queued on this thread and not started yet, by submission id.
    pub routine_starts: Mutex<std::collections::HashMap<String, RoutineStart>>,
    /// `session.turnHop` / `session.turnBotChain`: stamped when a turn starts, in memory only.
    pub turn_chain: super::delegation::TurnState,
    /// The session's "Allow for this session" grants: in memory, one set per loaded session.
    pub grants: Arc<mixdog_tools::policy::SessionGrants>,
    pub ctl_tx: mpsc::Sender<Ctl>,
    pub steer_cap: usize,
    /// The admission word: the feed subscribers attached now (the low bits), [`ATTACHED`] once an
    /// attach was ever admitted, and [`CLOSING`] once the thread is closed to attaches. Attach
    /// and close are transitions of this one word, and the history bit is set by the very
    /// compare-exchange that admits an attach, so no sequence of attaches and detaches returns
    /// the word to a value a closer observed before them (read it through
    /// [`ControlCell::admission`] and [`ControlCell::attached`]).
    pub subscribers: std::sync::atomic::AtomicUsize,
    /// Set (under the directory's shard lock) when the thread unloads; attaches then fail.
    pub closed: std::sync::atomic::AtomicBool,
    /// The runtime's `SessionEnd` fired at the core's exit, before its session was closed (`teardown.mjs` `close`:
    /// `dispatchSessionEnd` precedes `closeOwnSession`): the close work that follows fires none.
    pub session_ended: std::sync::atomic::AtomicBool,
    /// A turn runs, starts or settles (the actor's state after its last step): Node's ask lock
    /// is held (`tryAcquireSessionLock` refuses).
    pub turn_held: std::sync::atomic::AtomicBool,
    /// A Goal or quota-resume turn is about to start (a Goal entry being checked, a resume
    /// pending): Node's turn waiting for the ask lock (`sessionLockContended`).
    pub turn_pending: std::sync::atomic::AtomicBool,
    /// Node's `state.busy` (a turn runs or starts) and `state.commandBusy` (a compaction runs), as
    /// the actor last stepped: what the desktop host counts as the session working.
    pub ui_busy: std::sync::atomic::AtomicBool,
    pub compacting: std::sync::atomic::AtomicBool,
    /// The running manual compaction's signal (Node's session abort controller, which a compaction reads through
    /// `getSessionAbortSignal`): a close, a delete or a shutdown aborts it with their own text.
    pub compaction_cancel: Mutex<Option<mixdog_agent::cancel::Cancel>>,
    /// A compaction the model scheduled (`session action=compact`: Node's `pendingCompactSessionIds`): the actor
    /// runs it, once, when the next turn of this thread settles.
    pub pending_compact: std::sync::atomic::AtomicBool,
    /// The scheduled compaction holds the thread's turns back (`afterCompaction`), as the actor last stepped: a prompt
    /// submitted meanwhile is Node's ask waiting on the gate, which a stop still hands back to the composer.
    pub gated: std::sync::atomic::AtomicBool,
    /// In-core starts of this thread waiting out the core's hold on turn starts (`SessionHandle::deferring`): the idle clock does not
    /// unload the thread under them, whose callers left their start on this cell (`agent_start`, `routine_starts`).
    pub deferring: std::sync::atomic::AtomicUsize,
    /// What an archive preparation holding this thread checks at its commit: moved by every attach and by every step that moved
    /// what the preparation judged; held while a preparation holds the thread (the idle deadline leaves it loaded).
    pub retention: super::archive_trees::RetentionMark,
    /// Woken after every step of the thread's actor, so a test waits on the thread's state by its
    /// change (`eventually_on!`, and `SessionHandle::stepped` for the tests of other crates).
    #[cfg(any(test, feature = "test-support"))]
    pub stepped: tokio::sync::Notify,
    /// The records the actor accepted that the store has not acknowledged, after its last step.
    #[cfg(any(test, feature = "test-support"))]
    pub unacked: std::sync::atomic::AtomicUsize,
    /// The records handed to the store and not yet acknowledged or failed, after the actor's last step.
    #[cfg(any(test, feature = "test-support"))]
    pub handed: std::sync::atomic::AtomicUsize,
    /// The actor's `turn_busy()` after its last step: a turn runs, starts or is still settling.
    /// The next turn is refused or queued until it is false, which `run` being empty does not say.
    #[cfg(any(test, feature = "test-support"))]
    pub busy: std::sync::atomic::AtomicBool,
    /// The actor's `retry_blocked()` after its last step: what a quota resume's fire answers `Busy` for (the turn state, the
    /// quota settlement, a compaction, a completion wake or queued input).
    #[cfg(any(test, feature = "test-support"))]
    pub retry_blocked: std::sync::atomic::AtomicBool,
    /// The actor's pending continuation decision (`goal_scheduled`) after its last step.
    #[cfg(any(test, feature = "test-support"))]
    pub goal_pending: std::sync::atomic::AtomicBool,
    /// A test's mark of a turn in flight with no run (Node's `markSessionAskStart`, until `markSessionDone`): the
    /// session is not idle (`ui_busy`); `Inbox::AskEnded` clears it and runs what the turn's end runs for a prune.
    #[cfg(test)]
    pub ask_marked: std::sync::atomic::AtomicBool,
    /// How many times the actor has armed the prompt-history write timer (the window, or a backoff), counted in the step that arms
    /// it: a test that moves a paused clock waits on this first, so the timer is armed before the clock moves.
    #[cfg(any(test, feature = "test-support"))]
    pub prompt_timers: std::sync::atomic::AtomicU64,
    /// Where the thread's moved live facts republish its roster row (the directory's, bound once by the composition).
    pub live_rows: LiveRowsCell,
    /// The directory's [`StopLatches`], shared by every cell.
    pub stop_latches: Arc<StopLatches>,
    /// A test's hook at a run start's fences: `read` as its input row's facts are sent to be read, `check` once the start passed its Stop check (before the start gate), `gate` once
    /// the gate registered it (before the spawn); and at a takeover's, `takeover`, once it passed its checks (before its abort).
    /// Called on the actor's own step, so what it does lands exactly there.
    #[cfg(any(test, feature = "test-support"))]
    pub start_fences: Mutex<Option<StartFence>>,
    /// No open-time recovery is pending and every accepted record is released (durable or failed), after the last step.
    #[cfg(any(test, feature = "test-support"))]
    pub recovered: std::sync::atomic::AtomicBool,
    /// No draft file write is queued or running and none owed (a removal or sweep to try again), after the last step.
    #[cfg(any(test, feature = "test-support"))]
    pub drafts_settled: std::sync::atomic::AtomicBool,
    /// Every job the actor started has reported and its report was taken, after the last step.
    #[cfg(any(test, feature = "test-support"))]
    pub jobs_settled: std::sync::atomic::AtomicBool,
    /// How many times the scheduled compaction held work back (a request it parked, or a queue it
    /// kept from draining), counted in the step that held it: a test that shows nothing started
    /// waits on this, so the gate was consulted before it asserts.
    #[cfg(any(test, feature = "test-support"))]
    pub gate_holds: std::sync::atomic::AtomicU64,
    /// The queue drain passes finished, counted after the pass decided and registered any next start (or found none): a test that
    /// shows nothing started waits for a pass after the event it cares about.
    #[cfg(any(test, feature = "test-support"))]
    pub drain_passes: std::sync::atomic::AtomicU64,
    /// The Stop events in the order the actor took them: `stop:frozen:<sid>:<identities>`, `stop:durable:<sid>`,
    /// `stop:failed:<sid>`, `stop:settled:<sid>`, `stop:recovered:<sid>`, `start:stopped:<work>`, `run:admitted:<work>`.
    #[cfg(any(test, feature = "test-support"))]
    pub stop_ledger: Mutex<Vec<String>>,
    /// The numbers of the thread's prompt-history appends ([`super::prompt_history::AppendQueue::numbered_on`]): the
    /// replay barrier takes their accepted count as it arrives.
    #[cfg(any(test, feature = "test-support"))]
    pub prompt_marks: Arc<mixdog_rt::WriteMarks>,
    /// The numbers of the thread's durable records ([`super::outbox::Outbox::numbered_on`]): accepted as the actor takes a
    /// record into its outbox, written once the store synced and acked it, failed when it leaves uncommitted (its encode or
    /// its barrier failed, or the actor ended first). The replay barrier takes their accepted count as it arrives.
    #[cfg(any(test, feature = "test-support"))]
    pub record_marks: Arc<mixdog_rt::WriteMarks>,
}

/// The directory's binding of [`super::thread_edges::LiveRows`], shared by every cell.
pub(crate) type LiveRowsCell = Arc<std::sync::OnceLock<Arc<super::thread_edges::LiveRows>>>;

/// One thread's start gate: the identities a Stop from outside the actor latched, and the identities each run started (or took
/// at a boundary) is running, with that run's cancel.
#[derive(Default)]
struct Gate {
    latched: HashSet<String>,
    running: Vec<(TurnId, HashSet<String>, Cancel)>,
    /// The thread's last accepted takeover, until the turn its message started has ended.
    takeover: Option<Takeover>,
    /// The turn a Stop from outside the actor ([`ControlCell::interrupt`]) ended with its abort: the actor shows it stopping.
    stopping: Option<TurnId>,
    /// A test's failed-turn retry, which the next drain pass finds already pending.
    #[cfg(test)]
    retry: Option<super::quota_lane::RetryTurn>,
}

impl Gate {
    fn idle(&self) -> bool {
        self.latched.is_empty() && self.running.is_empty() && self.takeover.is_none()
    }
}

/// The per-thread synchronisation point between starting work and a Stop from outside the thread's actor (a room Stop's member
/// submissions), by thread, shared by every cell and every later load of the thread (the directory's).
///
/// Invariant, by construction (one lock per directory over every thread's gate): **latched ⇒ not started, or started ⇒ the
/// latch saw it.** A run's start ([`Self::begin`]) and a boundary's take of an entry ([`Self::claim`]) register the identities
/// they are about to run under the lock a latch takes; one that finds an identity latched does not run it. A latch
/// ([`Self::latch`]) that finds an identity registered as running aborts that run at once with the user's cancel.
///
/// A latched identity is released ([`Self::release`]) only once the thread's durable `work_stop` for it is acknowledged and
/// folded into the session's `stoppedWork` (which the actor and every later load read), or the thread is deleted
/// ([`Self::forget`]): it is never unprotected in between, and no timer or cap removes it.
#[derive(Default)]
pub(crate) struct StopLatches(Mutex<std::collections::HashMap<String, Gate>>);

impl StopLatches {
    /// Latches `identities` in `thread` (a Stop's linearization point). A run already running any of them is aborted now with the
    /// user's cancel; true when one was.
    pub fn latch(&self, thread: &ThreadId, identities: impl IntoIterator<Item = String>, abort: &mixdog_agent::cancel::Abort) -> bool {
        let mut gates = lock(&self.0);
        let gate = gates.entry(thread.as_str().to_owned()).or_default();
        let identities: Vec<String> = identities.into_iter().collect();
        gate.latched.extend(identities.iter().cloned());
        let mut aborted = false;
        for (_, running, cancel) in &gate.running {
            if identities.iter().any(|identity| running.contains(identity)) {
                cancel.abort_with(abort);
                aborted = true;
            }
        }
        aborted
    }

    pub fn latched(&self, thread: &ThreadId, identity: &str) -> bool {
        lock(&self.0).get(thread.as_str()).is_some_and(|gate| gate.latched.contains(identity))
    }

    /// Run `turn` is about to start the work `identities` under `cancel`: registered as running, or refused (false) when any of
    /// them is latched, in which case it never runs.
    pub fn begin(&self, thread: &ThreadId, turn: &TurnId, identities: &[String], cancel: &Cancel) -> bool {
        let mut gates = lock(&self.0);
        let gate = gates.entry(thread.as_str().to_owned()).or_default();
        if identities.iter().any(|identity| gate.latched.contains(identity)) {
            return false;
        }
        // The message of a takeover starts its turn: the reservation is met by this run.
        if let Some(takeover) = gate.takeover.as_mut().filter(|takeover| takeover.successor.is_none())
            && identities.contains(&mixdog_store::work_stops::queued(&takeover.message))
        {
            takeover.successor = Some(turn.clone());
        }
        gate.running.push((turn.clone(), identities.iter().cloned().collect(), cancel.clone()));
        true
    }

    /// Fires `abort` on a run's `cancel` under the lock every latch aborts under; true when it is the abort that ends the run
    /// (no other came first, from the actor or from outside it). The check and the abort are one step: what a caller records
    /// of the end it caused, it records only when this answers true.
    pub fn abort(&self, cancel: &Cancel, abort: &mixdog_agent::cancel::Abort) -> bool {
        let _gates = lock(&self.0);
        let first = !cancel.is_aborted();
        cancel.abort_with(abort);
        // A signal aborted from outside the session between the two (the core's exit) kept its own text.
        first && cancel.reason() == abort.message
    }

    /// A Stop from outside the actor ended `turn` of `thread` with its abort.
    pub fn stop_accepted(&self, thread: &ThreadId, turn: &TurnId) {
        lock(&self.0).entry(thread.as_str().to_owned()).or_default().stopping = Some(turn.clone());
    }

    /// Whether a Stop from outside the actor ended `turn` of `thread` ([`Self::stop_accepted`]).
    pub fn stop_was_accepted(&self, thread: &ThreadId, turn: &TurnId) -> bool {
        lock(&self.0).get(thread.as_str()).is_some_and(|gate| gate.stopping.as_ref() == Some(turn))
    }

    /// The actor accepted `takeover`: its message is the thread's next turn.
    pub fn reserve(&self, thread: &ThreadId, takeover: Takeover) {
        lock(&self.0).entry(thread.as_str().to_owned()).or_default().takeover = Some(takeover);
    }

    /// The thread's last accepted takeover.
    pub fn takeover(&self, thread: &ThreadId) -> Option<Takeover> {
        lock(&self.0).get(thread.as_str()).and_then(|gate| gate.takeover.clone())
    }

    /// Runs `at` while no run of `thread` is registered, under the lock every start takes: a start either came first (`None`,
    /// and `at` never runs) or comes after all `at` did. `at` only reads and signals; it takes no start gate.
    pub fn while_idle<R>(&self, thread: &ThreadId, at: impl FnOnce() -> Option<R>) -> Option<R> {
        let gates = lock(&self.0);
        if gates.get(thread.as_str()).is_some_and(|gate| !gate.running.is_empty()) {
            return None;
        }
        at()
    }

    /// Runs `at` while run `turn` of `thread` is registered, under the lock every start and every end takes: the run ended
    /// first (`None`, and `at` never runs), or neither it ends nor another starts before all `at` did. `at` only reads
    /// and signals.
    pub fn while_running<R>(&self, thread: &ThreadId, turn: &TurnId, at: impl FnOnce() -> R) -> Option<R> {
        let gates = lock(&self.0);
        gates.get(thread.as_str()).is_some_and(|gate| gate.running.iter().any(|(running, _, _)| running == turn)).then(at)
    }

    /// Running `turn` is about to take the entry of `identities` at a boundary: registered with the run, or refused (false) when
    /// any of them is latched, in which case the entry is not injected.
    pub fn claim(&self, thread: &ThreadId, turn: &TurnId, identities: &[String]) -> bool {
        let mut gates = lock(&self.0);
        let Some(gate) = gates.get_mut(thread.as_str()) else { return true };
        if identities.iter().any(|identity| gate.latched.contains(identity)) {
            return false;
        }
        if let Some((_, running, _)) = gate.running.iter_mut().find(|(running, _, _)| running == turn) {
            running.extend(identities.iter().cloned());
        }
        true
    }

    /// Run `turn` ended.
    pub fn end(&self, thread: &ThreadId, turn: &TurnId) {
        let mut gates = lock(&self.0);
        if let Some(gate) = gates.get_mut(thread.as_str()) {
            gate.running.retain(|(running, _, _)| running != turn);
            // The turn a takeover's message started is over: nothing reads that takeover again.
            gate.takeover.take_if(|takeover| takeover.successor.as_ref() == Some(turn));
            if gate.idle() {
                gates.remove(thread.as_str());
            }
        }
    }

    /// The latched identities of `thread` that `protected` says the durable record now protects are released.
    pub fn release(&self, thread: &ThreadId, protected: impl Fn(&str) -> bool) {
        let mut gates = lock(&self.0);
        if let Some(gate) = gates.get_mut(thread.as_str()) {
            gate.latched.retain(|identity| !protected(identity));
            if gate.idle() {
                gates.remove(thread.as_str());
            }
        }
    }

    /// `thread` was deleted: nothing of it can run again.
    pub fn forget(&self, thread: &ThreadId) {
        lock(&self.0).remove(thread.as_str());
    }

    #[cfg(test)]
    pub fn plant_retry(&self, thread: &ThreadId, retry: super::quota_lane::RetryTurn) {
        lock(&self.0).entry(thread.as_str().to_owned()).or_default().retry = Some(retry);
    }

    #[cfg(test)]
    pub fn planted_retry(&self, thread: &ThreadId) -> Option<super::quota_lane::RetryTurn> {
        lock(&self.0).get_mut(thread.as_str()).and_then(|gate| gate.retry.take())
    }

    #[cfg(test)]
    pub fn latched_count(&self, thread: &ThreadId) -> usize {
        lock(&self.0).get(thread.as_str()).map_or(0, |gate| gate.latched.len())
    }
}

impl ControlCell {
    #[cfg(any(test, feature = "test-support"))]
    pub fn start_fence(&self, at: &'static str) {
        let hook = lock(&self.start_fences).clone();
        if let Some(hook) = hook {
            hook(at);
        }
    }

    /// The live facts the roster lays over the thread's row moved (its turn, the approval it shows).
    pub fn live_changed(&self) {
        if let Some(rows) = self.live_rows.get() {
            rows.changed(&self.thread);
        }
    }

    /// The attaches counted now.
    pub fn attached(&self) -> usize {
        self.subscribers.load(std::sync::atomic::Ordering::SeqCst) & COUNT
    }

    /// The admission word as it stands (`0`: open, never attached).
    pub fn admission(&self) -> usize {
        self.subscribers.load(std::sync::atomic::Ordering::SeqCst)
    }

    /// An attach starts: admitted by one compare-exchange on the same word the closers
    /// transition, so it and a close (an unload, a retention delete) never both succeed: the
    /// attach is counted, and recorded in the history bit, only while the word is open, and a
    /// close takes the word only at a count of zero. False when closed.
    pub fn subscribing(&self) -> bool {
        use std::sync::atomic::Ordering::SeqCst;
        let admitted = self.subscribers.try_update(SeqCst, SeqCst, |word| (word & CLOSING == 0).then_some((word + 1) | ATTACHED)).is_ok();
        if admitted {
            // A window opening the session voids an archive prepared without it.
            self.retention.moved();
        }
        admitted
    }

    /// Closes the thread to attaches when nobody is attached: the unload's admission decision,
    /// atomic with [`Self::subscribing`]. False, nothing changed, when a subscriber is (being)
    /// attached or the thread is already closed.
    pub fn close_unattached(&self) -> bool {
        use std::sync::atomic::Ordering::SeqCst;
        let mut ended = self.liveness.ending();
        let taken = self.subscribers.try_update(SeqCst, SeqCst, |word| (word & (COUNT | CLOSING) == 0).then_some(CLOSING)).is_ok();
        if taken {
            *ended = true;
            self.closed.store(true, SeqCst);
        }
        taken
    }

    /// Closes the thread to attaches only if the word is still exactly `seen`, the word a
    /// closer read before it asked its other questions (a never-attached thread reads `0`):
    /// any attach since, even one already detached, changed the word and refuses the close.
    pub fn close_if_unchanged(&self, seen: usize) -> bool {
        use std::sync::atomic::Ordering::SeqCst;
        let mut ended = self.liveness.ending();
        let taken = seen & CLOSING == 0 && self.subscribers.compare_exchange(seen, CLOSING, SeqCst, SeqCst).is_ok();
        if taken {
            *ended = true;
            self.closed.store(true, SeqCst);
        }
        taken
    }

    /// Closes the thread whatever the attaches (a delete the user asked for, shutdown): later
    /// attaches fail; those already counted stay counted.
    pub fn close(&self) {
        use std::sync::atomic::Ordering::SeqCst;
        let mut ended = self.liveness.ending();
        *ended = true;
        self.subscribers.fetch_or(CLOSING, SeqCst);
        self.closed.store(true, SeqCst);
    }

    /// A close that failed is undone (`SessionActor::close_undone`): attaches are admitted again and the thread is live.
    pub fn reopen(&self) {
        use std::sync::atomic::Ordering::SeqCst;
        let mut ended = self.liveness.ending();
        *ended = false;
        self.subscribers.fetch_and(!CLOSING, SeqCst);
        self.closed.store(false, SeqCst);
    }

    /// The attach that [`Self::subscribing`] started ended (`ok`: the subscriber is attached).
    pub fn subscribed(&self, ok: bool) {
        if !ok {
            self.unsubscribed();
        }
    }

    /// A subscriber detached; the last one puts the thread back on the actor's idle clock.
    pub fn unsubscribed(&self) {
        use std::sync::atomic::Ordering::SeqCst;
        let before = self.subscribers.try_update(SeqCst, SeqCst, |n| (n & COUNT > 0).then(|| n - 1));
        if before.is_ok_and(|word| word & COUNT == 1) {
            self.deliver(Ctl::Unsubscribed);
        }
    }

    /// Hands the actor `ctl` although its control lane is full: a caller that cannot wait for room (a detach, a resume's reply)
    /// leaves the wait to a task, so a message that restarts the idle clock is never dropped.
    pub fn deliver(&self, ctl: Ctl) {
        if let Err(mpsc::error::TrySendError::Full(ctl)) = self.ctl_tx.try_send(ctl) {
            let lane = self.ctl_tx.clone();
            tokio::spawn(async move {
                let _ = lane.send(ctl).await;
            });
        }
    }
}

impl ControlCell {
    /// Stops the manual compaction in flight, if any, with `abort`'s text.
    pub fn abort_compaction(&self, abort: &mixdog_agent::cancel::Abort) {
        if let Some(cancel) = lock(&self.compaction_cancel).as_ref() {
            cancel.abort_with(abort);
        }
    }

    /// The observers at this moment; called outside the lock.
    pub fn turn_listeners(&self) -> Vec<Arc<dyn TurnListener>> {
        lock(&self.turn_listeners).iter().map(|(_, listener)| listener.clone()).collect()
    }
}

impl LiveHeader for ControlCell {
    fn header(&self) -> Arc<Header> {
        self.header.load_full()
    }
}

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// `isQueuedEntryEditable` (`queue-helpers.mjs`): a prompt the user typed, as opposed to a task notification, a
/// pending resume, a Goal entry or a meta entry.
pub(super) fn is_editable_entry(entry: &Value) -> bool {
    let mode = entry.get("mode").and_then(Value::as_str).unwrap_or("prompt");
    mode != super::completions::MODE && mode != "pending-resume" && !super::goal_lane::is_goal_entry(entry) && entry.get("isMeta") != Some(&Value::Bool(true))
}

/// The entries `prioritizeQueued` selects: `isQueuedEntryEditable(entry) && !isSlashQueuedEntry(entry)`.
pub(super) fn is_prioritizable_entry(entry: &Value) -> bool {
    is_editable_entry(entry) && !super::pending::is_slash_entry(entry)
}

impl ControlCell {
    fn not_active(&self, turn: Option<&TurnId>) -> CoreError {
        CoreError::TurnNotActive { thread_id: self.thread.clone(), turn_id: turn.cloned() }
    }

    fn send(&self, ctl: Ctl) -> Result<(), CoreError> {
        self.ctl_tx.try_send(ctl).map_err(|error| match error {
            mpsc::error::TrySendError::Full(_) => CoreError::QueueFull { queue: "control".into() },
            mpsc::error::TrySendError::Closed(_) => CoreError::ThreadClosing { thread_id: self.thread.clone() },
        })
    }

    /// `turn/interrupt` → `{cancelRequested: true, turnId}` (R12): the user's stop
    /// (`abortRuntime`, `user-cancel`). The cancel is fired before this returns and a full control lane cannot
    /// refuse it; the run stops at its next poll and its `run{interrupted}` record follows through the control
    /// reserve.
    pub fn interrupt(&self, turn: &TurnId, restore_prompt: Option<bool>) -> Result<Value, CoreError> {
        let steering = self.queue.load().iter().any(|queued| is_editable_entry(&queued.entry));
        let name = if steering {
            "interrupt"
        } else if restore_prompt == Some(false) {
            "user-cancel-keep-prompt"
        } else {
            mixdog_agent::cancel::USER_CANCEL
        };
        // Only the abort that ends the run is a stop the turn shows: one behind a takeover or another Stop changes nothing.
        if self.abort_first(turn, &mixdog_agent::cancel::Abort::runtime_abort(self.thread.as_str(), name))? {
            self.stop_latches.stop_accepted(&self.thread, turn);
        }
        let _ = self.ctl_tx.try_send(Ctl::Abort { turn: turn.clone() });
        Ok(json!({ "cancelRequested": true, "turnId": turn }))
    }

    /// Aborts the running `turn` with `reason`, Node's abort text (`closeSession`,
    /// `abortSessionTurn`, `abortRuntime`). The only error is a `turn` that is not the running one.
    pub fn abort(&self, turn: &TurnId, abort: &mixdog_agent::cancel::Abort) -> Result<Value, CoreError> {
        self.abort_first(turn, abort)?;
        // The actor's `Ctl::Abort` only settles the turn's pending approvals early; a full lane drops it, and `run_ended`
        // settles whatever is left when the turn ends.
        let _ = self.ctl_tx.try_send(Ctl::Abort { turn: turn.clone() });
        Ok(json!({ "cancelRequested": true, "turnId": turn }))
    }

    /// [`Self::abort`] that says whether it is the abort that ends the run ([`StopLatches::abort`]): `abortRuntime` aborts
    /// synchronously, so the cancel fires here and cannot be refused, but only the first abort decides how the end reads.
    pub fn abort_first(&self, turn: &TurnId, abort: &mixdog_agent::cancel::Abort) -> Result<bool, CoreError> {
        let run = self.run.load_full();
        let Some(run) = run.filter(|run| &run.turn == turn) else {
            return Err(self.not_active(Some(turn)));
        };
        Ok(self.stop_latches.abort(&run.cancel, abort))
    }

    /// `turn/steer{expectedTurnId, queuedId}` → `{accepted: true, queuedId}` (R10, R12). Node's
    /// `prioritizeQueued` (`queue.mjs`) goes by queue membership alone and has no turn precondition: a queued
    /// prompt moves to the front of the queue at priority `now` and a drain is kicked, whether or not a run
    /// matches `expected`; the actor does it (`Ctl::Prioritize`). A run that matches (`expected` when named,
    /// else any) also takes the entry at its next model-call boundary.
    pub fn steer(&self, expected: Option<&TurnId>, queued: QueuedId) -> Result<Value, CoreError> {
        // The entry is named by its queue id or by the submission it answers (`queued_is`); what follows works by the queue id.
        let found = self
            .queue
            .load()
            .iter()
            .find(|entry| super::actor::queued_is(&entry.qid, &entry.entry, queued.as_str()) && is_prioritizable_entry(&entry.entry))
            .map(|entry| QueuedId::from(entry.qid.as_str()));
        let Some(queued) = found else {
            return Err(CoreError::QueuedEntryNotFound { thread_id: self.thread.clone(), queued_id: queued });
        };
        let run = self.run.load_full();
        if let Some(run) = run.filter(|run| expected.is_none_or(|expected| &run.turn == expected)) {
            let mut steers = lock(&run.steers);
            if !steers.contains(&queued) {
                if steers.len() >= self.steer_cap {
                    return Err(CoreError::QueueFull { queue: "steer".into() });
                }
                steers.push_back(queued.clone());
            }
        }
        self.send(Ctl::Prioritize { queued: queued.clone() })?;
        Ok(json!({ "accepted": true, "queuedId": queued }))
    }

    /// A server-request response. A request that is not decidable (unknown, resolved or
    /// resolving) is a no-op: its `serverRequest/resolved` reaches every connection anyway.
    pub fn decide(&self, decision: Decision) -> Result<(), CoreError> {
        let decidable = mixdog_core_base::approvals::parse_id(&decision.request).is_some_and(|aid| self.approvals.load().contains(&aid.0));
        if !decidable {
            return Ok(());
        }
        self.send(Ctl::Decide(decision, None))
    }

    /// A decision whose caller is told whether it won (Node's `resolveToolApprovalForSession`: the answer serialized per session,
    /// `result.approved === true` for the one that resolved the request, `session-host-lifecycle.ts:1086-1102`): `true` once the
    /// actor resolved the request with it, `false` when the request is not decidable or another decision took it first.
    pub async fn decide_arbitrated(&self, decision: Decision) -> Result<bool, CoreError> {
        let decidable = mixdog_core_base::approvals::parse_id(&decision.request).is_some_and(|aid| self.approvals.load().contains(&aid.0));
        if !decidable {
            return Ok(false);
        }
        let (arbitrated, outcome) = tokio::sync::oneshot::channel();
        self.send(Ctl::Decide(decision, Some(arbitrated)))?;
        outcome.await.map_err(|_| CoreError::ThreadClosing { thread_id: self.thread.clone() })?
    }

    pub fn publish_run(&self, run: Option<Arc<ActiveRun>>) {
        self.run.store(run);
        self.live_changed();
    }
}

/// A fence a test arms on the actor's own step: told the step's name.
#[cfg(any(test, feature = "test-support"))]
type StartFence = Arc<dyn Fn(&'static str) + Send + Sync>;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn what_is_done_while_idle_is_done_only_while_no_run_is_registered() {
        let latches = StopLatches::default();
        let (thread, turn) = (ThreadId::from("t"), TurnId::from("r"));
        assert_eq!(latches.while_idle(&thread, || Some(1)), Some(1));

        let token = mixdog_rt::CancellationToken::new();
        assert!(latches.begin(&thread, &turn, &[], &Cancel::from_token(&token)));
        let mut ran = false;
        assert_eq!(latches.while_idle(&thread, || Some(ran = true)), None, "a run started first");
        assert!(!ran, "nothing is done to a thread a run started on");
        assert_eq!(latches.while_idle(&ThreadId::from("other"), || Some(1)), Some(1), "another thread's run holds nothing back");

        latches.end(&thread, &turn);
        assert_eq!(latches.while_idle(&thread, || Some(1)), Some(1));
    }
}
