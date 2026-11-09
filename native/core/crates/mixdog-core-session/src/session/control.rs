//! The C0 control plane of a thread (RL §5.3, D-L1, SPEC R10–R12): what RT-C reads and
//! touches without the actor. The actor republishes the cell when the run, the queue or the
//! set of decidable approvals changes (from its projected state), and RT-C answers abort,
//! steer and decisions from it at once; the actor's control lane carries the follow-up.

use std::collections::HashSet;
use std::collections::VecDeque;
use std::sync::Arc;
use std::sync::Mutex;

use arc_swap::ArcSwap;
use arc_swap::ArcSwapOption;
use mixdog_core_api::CoreError;
use mixdog_core_api::ids::QueuedId;
use mixdog_core_api::ids::ThreadId;
use mixdog_core_api::ids::TurnId;
use mixdog_core_api::thread::Decision;
use mixdog_agent::cancel::Cancel;
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
    Abort { turn: TurnId },
    /// `turn/steer`: the queued prompt is prioritized (front of the queue, priority `now`, a drain kicked), and the
    /// entries pushed into the active run's steer queue are taken.
    Prioritize { queued: QueuedId },
    Decide(Decision),
    RunEnded { turn: TurnId, outcome: RunOutcome },
    /// The user's "Retry storage" (SM §8 `PendingRollback`).
    RetryStorage,
    /// A tool-policy input outside the thread changed (a setting, a connector policy).
    RefreshSurface,
    /// A workspace change applied the session's cwd (`applyResolvedCwd`), `changed` when the
    /// folder moved: the code-graph warm follows.
    CwdApplied { changed: bool },
    /// The last subscriber left: an idle thread unloads.
    Unsubscribed,
    /// The thread's tombstone landed (`closeSession`): no Goal continues it, and once its turn
    /// has ended it unloads (`_clearSessionRuntime`) even if it was never subscribed.
    Closed,
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
    /// 	ranscriptMeta.botChain: the bots that handed the message on, sender last.
    pub bot_chain: Vec<String>,
    /// 	ranscriptMeta.roomRow: the room's newest user row the prompt shows (a member's turn).
    pub room_row: Option<String>,
    /// The trusted text the turn's skills are selected from.
    pub skill_selection: Option<String>,
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
    pub turn_messages: watch::Sender<Arc<Vec<serde_json::Value>>>,
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
    /// Woken after every step of the thread's actor, so a test waits on the thread's state by its
    /// change (`tests::eventually_on`, and `SessionHandle::stepped` for the tests of other crates).
    #[cfg(any(test, feature = "test-support"))]
    pub stepped: tokio::sync::Notify,
    /// The actor's `turn_busy()` after its last step: a turn runs, starts or is still settling.
    /// The next turn is refused or queued until it is false, which `run` being empty does not say.
    #[cfg(any(test, feature = "test-support"))]
    pub busy: std::sync::atomic::AtomicBool,
}

impl ControlCell {
    /// The attaches counted now.
    pub fn attached(&self) -> usize {
        self.subscribers.load(std::sync::atomic::Ordering::SeqCst) & COUNT
    }

    /// Whether an attach was ever admitted: only then does the thread unload when none is left.
    pub fn ever_attached(&self) -> bool {
        self.subscribers.load(std::sync::atomic::Ordering::SeqCst) & ATTACHED != 0
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
        self.subscribers.try_update(SeqCst, SeqCst, |word| (word & CLOSING == 0).then_some((word + 1) | ATTACHED)).is_ok()
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

    /// The attach that [`Self::subscribing`] started ended (`ok`: the subscriber is attached).
    pub fn subscribed(&self, ok: bool) {
        if !ok {
            self.subscribers.fetch_sub(1, std::sync::atomic::Ordering::SeqCst);
        }
    }

    /// A subscriber detached; the last one asks the actor to unload when idle.
    pub fn unsubscribed(&self) {
        use std::sync::atomic::Ordering::SeqCst;
        let before = self.subscribers.try_update(SeqCst, SeqCst, |n| (n & COUNT > 0).then(|| n - 1));
        if before.is_ok_and(|word| word & COUNT == 1) {
            let _ = self.ctl_tx.try_send(Ctl::Unsubscribed);
        }
    }
}

impl ControlCell {
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
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// `isQueuedEntryEditable` (`queue-helpers.mjs`): a prompt the user typed, as opposed to a task notification, a
/// pending resume, a Goal entry or a meta entry.
pub(super) fn is_editable_entry(entry: &Value) -> bool {
    let mode = entry.get("mode").and_then(Value::as_str).unwrap_or("prompt");
    mode != super::completions::MODE
        && mode != "pending-resume"
        && !super::goal_lane::is_goal_entry(entry)
        && entry.get("isMeta") != Some(&Value::Bool(true))
}

/// The entries `prioritizeQueued` selects: `isQueuedEntryEditable(entry) && !isSlashQueuedEntry(entry)`.
pub(super) fn is_prioritizable_entry(entry: &Value) -> bool {
    is_editable_entry(entry) && !super::pending::is_slash_entry(entry)
}

impl ControlCell {
    fn not_active(&self, turn: Option<&TurnId>) -> CoreError {
        CoreError::TurnNotActive {
            thread_id: self.thread.clone(),
            turn_id: turn.cloned(),
        }
    }

    fn send(&self, ctl: Ctl) -> Result<(), CoreError> {
        self.ctl_tx.try_send(ctl).map_err(|error| match error {
            mpsc::error::TrySendError::Full(_) => CoreError::QueueFull {
                queue: "control".into(),
            },
            mpsc::error::TrySendError::Closed(_) => CoreError::ThreadClosing {
                thread_id: self.thread.clone(),
            },
        })
    }

    /// `turn/interrupt` → `{cancelRequested: true, turnId}` (R12): the user's stop
    /// (`abortRuntime`, `cli-abort`). The cancel is fired before this returns and a full control lane cannot
    /// refuse it; the run stops at its next poll and its `run{interrupted}` record follows through the control
    /// reserve.
    pub fn interrupt(&self, turn: &TurnId, restore_prompt: Option<bool>) -> Result<Value, CoreError> {
        // `abort.mjs`: a Stop that hands the prompt back is `user-cancel` (the runtime rewinds a turn that produced
        // nothing); one that does not names `user-cancel-keep-prompt`, so the prompt stays in the stored transcript.
        // A queued steering prompt means the user already redirected the turn: the stop names `interrupt`
        // (`abortGoalTurn`: `runtime.abort(hasPendingSteering ? 'interrupt' : reason)`).
        let steering = self.queue.load().iter().any(|queued| is_editable_entry(&queued.entry));
        let name = if steering {
            "interrupt"
        } else if restore_prompt == Some(false) {
            "user-cancel-keep-prompt"
        } else {
            mixdog_agent::cancel::CLI_ABORT
        };
        self.abort(turn, &mixdog_agent::cancel::Abort::runtime_abort(self.thread.as_str(), name))
    }

    /// Aborts the running `turn` with `reason`, Node's abort text (`closeSession`,
    /// `abortSessionTurn`, `abortRuntime`). The only error is a `turn` that is not the running one.
    pub fn abort(&self, turn: &TurnId, abort: &mixdog_agent::cancel::Abort) -> Result<Value, CoreError> {
        let run = self.run.load_full();
        let Some(run) = run.filter(|run| &run.turn == turn) else {
            return Err(self.not_active(Some(turn)));
        };
        // `abortRuntime` aborts synchronously, so the cancel fires first and cannot be refused. The actor's
        // `Ctl::Abort` only settles the turn's pending approvals early; a full lane drops it, and `run_ended`
        // settles whatever is left when the turn ends.
        run.cancel.abort_with(abort);
        let _ = self.ctl_tx.try_send(Ctl::Abort { turn: turn.clone() });
        Ok(json!({ "cancelRequested": true, "turnId": turn }))
    }

    /// `turn/steer{expectedTurnId, queuedId}` → `{accepted: true, queuedId}` (R10, R12). Node's
    /// `prioritizeQueued` (`queue.mjs`) goes by queue membership alone and has no turn precondition: a queued
    /// prompt moves to the front of the queue at priority `now` and a drain is kicked, whether or not a run
    /// matches `expected`; the actor does it (`Ctl::Prioritize`). A run that matches (`expected` when named,
    /// else any) also takes the entry at its next model-call boundary.
    pub fn steer(&self, expected: Option<&TurnId>, queued: QueuedId) -> Result<Value, CoreError> {
        if !self.queue.load().iter().any(|entry| entry.qid == queued.as_str() && is_prioritizable_entry(&entry.entry)) {
            return Err(CoreError::QueuedEntryNotFound {
                thread_id: self.thread.clone(),
                queued_id: queued,
            });
        }
        let run = self.run.load_full();
        if let Some(run) = run.filter(|run| expected.is_none_or(|expected| &run.turn == expected)) {
            let mut steers = lock(&run.steers);
            if !steers.contains(&queued) {
                if steers.len() >= self.steer_cap {
                    return Err(CoreError::QueueFull {
                        queue: "steer".into(),
                    });
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
        let decidable = mixdog_core_base::approvals::parse_id(&decision.request)
            .is_some_and(|aid| self.approvals.load().contains(&aid.0));
        if !decidable {
            return Ok(());
        }
        self.send(Ctl::Decide(decision))
    }

    pub fn publish_run(&self, run: Option<Arc<ActiveRun>>) {
        self.run.store(run);
    }
}

#[cfg(test)]
mod queue_tests {
    use super::*;

    /// `isQueuedEntryEditable` as Node's helper answered these entries (`fixtures/interrupt/queue-golden.json`,
    /// `record-queue.mjs`).
    #[test]
    fn a_queued_entry_is_steering_as_node_judges_it() {
        let golden: Value = serde_json::from_str(include_str!("../../../../fixtures/interrupt/queue-golden.json")).unwrap();
        for case in golden["cases"].as_array().unwrap() {
            assert_eq!(is_editable_entry(&case["entry"]), case["editable"] == true, "{}", case["entry"]);
        }
    }
}