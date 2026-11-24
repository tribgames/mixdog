use super::*;
use mixdog_store::schema::record::WorkStopPhase;
use mixdog_store::schema::record::WorkStopRecord;
use mixdog_store::work_stops;

use super::super::control::BusyStop;
use super::super::control::RunStop;
use super::super::control::Takeover;
use super::super::stop::Handback;
use super::super::stop::OwedHandback;
use super::super::stop::Restore;
use super::super::stop::StopWait;

/// What the abort of a turn taken over by a message says: the text a tool call it cut short carries as its result.
const TAKEOVER_ABORT: &str = "runtime abort (reason=interrupt): the turn was ended to deliver the user's message";

impl SessionActor {
    /// The work of a start admitted now: `id` its stable identity, `qids` and `submissions` what it could be recreated through.
    /// A user's restorable prompt is handed back by a Stop before its run began; any other start is cancelled and consumed.
    pub(super) fn work_of(&self, id: String, qids: Vec<String>, submissions: Vec<String>, input: &TurnInput, wake: bool) -> WorkRef {
        let kickoff = input.options.as_ref().and_then(|options| options.kickoff) == Some(true);
        let handback = self
            .submitter
            .as_ref()
            .filter(|submitter| submitter.restorable && !wake && !kickoff)
            .map(|submitter| Handback { text: display_text(input), device: submitter.device.clone() });
        WorkRef { id, qids, submissions, handback }
    }

    /// Whether `identity` is terminal: latched by a Stop of this process, or folded from a durable Stop.
    pub(super) fn stopped_identity(&self, identity: &str) -> bool {
        self.stops.latched_identity(identity).is_some()
            || self.cell.stop_latches.latched(&self.id, identity)
            || work_stops::stopped(&self.projected.header, identity).is_some()
    }

    /// The Stop that froze `work` ([`Self::stop_of`]); work latched from outside the actor ([`super::super::control::StopLatches`])
    /// whose record has not reached the actor yet is frozen under its own record now, which that record's request then joins.
    pub(super) fn stop_or_latched(&mut self, work: &WorkRef) -> Option<String> {
        if let Some(sid) = self.stop_of(work) {
            return Some(sid);
        }
        if !work.identities().iter().any(|identity| self.cell.stop_latches.latched(&self.id, identity)) {
            return None;
        }
        let (sid, _) = self.record_stop(work, None, None, None, false);
        Some(sid)
    }

    /// The Stop that froze `work`, if one did.
    pub(super) fn stop_of(&self, work: &WorkRef) -> Option<String> {
        self.stops
            .latched(work)
            .or_else(|| work.identities().iter().find_map(|identity| work_stops::stopped(&self.projected.header, identity)).map(str::to_owned))
    }

    /// A queued entry nothing may take now: a copy of stopped work ([`Self::queued_frozen`]), or any entry other than the
    /// message of an accepted takeover while that message waits to start the next turn. Neither the drain nor a boundary of
    /// the turn being taken over takes one, so the message is the next turn's input and nothing starts ahead of it.
    pub(super) fn queued_stopped(&self, queued: &Queued) -> bool {
        self.queued_frozen(queued) || self.reserved_successor().is_some_and(|reserved| reserved != queued.qid)
    }

    /// The queue id of the message an accepted takeover reserved the next turn for, while it still waits in the queue. A
    /// message that left the queue without starting (removed, handed back, stopped) reserves nothing.
    pub(super) fn reserved_successor(&self) -> Option<String> {
        let takeover = self.cell.stop_latches.takeover(&self.id).filter(|takeover| takeover.successor.is_none())?;
        self.projected.queue.iter().any(|queued| queued.qid == takeover.message && !self.queued_frozen(queued)).then_some(takeover.message)
    }

    /// A queued copy of stopped work: by its queue id, or the submission it answers.
    fn queued_frozen(&self, queued: &Queued) -> bool {
        self.stopped_identity(&work_stops::queued(&queued.qid))
            || queued
                .entry
                .pointer("/options/clientSubmissionId")
                .and_then(Value::as_str)
                .filter(|id| !id.is_empty())
                .is_some_and(|id| self.stopped_identity(&work_stops::submission(id)))
    }

    pub(super) fn record_stop(
        &mut self,
        work: &WorkRef,
        turn: Option<&TurnId>,
        row: Option<&str>,
        restore: Option<&Restore>,
        by_reply: bool,
    ) -> (String, StopWait) {
        self.record_stop_noting(work, turn, row, restore, by_reply, None)
    }

    /// [`Self::record_stop`] whose record also states `takeover`: the stopped turn was taken over, by which message.
    fn record_stop_noting(
        &mut self,
        work: &WorkRef,
        turn: Option<&TurnId>,
        row: Option<&str>,
        restore: Option<&Restore>,
        by_reply: bool,
        takeover: Option<Value>,
    ) -> (String, StopWait) {
        if let Some(sid) = self.stop_of(work) {
            return (sid.clone(), self.stops.join(&sid));
        }
        let sid = format!("stop-{}", new_id());
        self.stops.latch(work, &sid);
        #[cfg(any(test, feature = "test-support"))]
        self.ledger(format!("stop:frozen:{sid}:{}", work.identities().join(",")));
        let now = self.deps.clock.now_ms();
        let restore = restore.map(|restore| Restore { at: now, ..restore.clone() });
        if let Some(restore) = &restore {
            self.stops.owe(&sid, OwedHandback { restore: restore.clone(), rewound: row.is_none(), by_reply });
        }
        let mut body = work.stop_body(turn.map(TurnId::as_str), row, restore.as_ref());
        if let Some(takeover) = takeover {
            body["takeover"] = takeover;
        }
        let record = Record::WorkStop(WorkStopRecord { sid: id(&sid), phase: WorkStopPhase::Stopped, at: Some(now), body: Some(Slot::Inline(body)) });
        let (ack, durable) = oneshot::channel();
        self.accept_record(record, Class::Control, Display::None, Vec::new(), vec![Effect::MarkAck(ack)]);
        let (jobs, told) = (self.jobs_tx.clone(), sid.clone());
        tokio::spawn(async move {
            let result = durable.await.unwrap_or(Err(RunError::NotApplied));
            let _ = jobs.send(JobDone::StopDurable { sid: told, result });
        });
        let wait = self.stops.join(&sid);
        (sid, wait)
    }

    /// The Stop's record landed or failed: every request that joined it hears so. A failure says what happened: the cancellation
    /// fired here and stands, but the record that keeps the work from running after a restart is not saved.
    pub(super) fn stop_durable(&mut self, sid: &str, result: Result<(), RunError>) {
        #[cfg(any(test, feature = "test-support"))]
        self.ledger(format!("stop:{}:{sid}", if result.is_ok() { "durable" } else { "failed" }));
        let result = result.map_err(|_| {
            coded(
                "session",
                STOP_NOT_SAVED,
                format!(
                    "The stop was requested here, but it could not be saved ({}): protection against the stopped work running again after a restart is not confirmed.",
                    self.save_failure
                ),
            )
        });
        if result.is_ok() {
            self.release_protected_latches();
        }
        self.stops.done(sid, result);
    }

    /// The Stop's owed outcome is final (a cancelled outcome recorded, a hand-back rewound and offered): `work_stop{settled}`
    /// follows it, once. A Stop whose record was not saved writes nothing more.
    fn settle_stop(&mut self, sid: &str) {
        if self.stops.failed(sid) || !self.stops.settle(sid) {
            return;
        }
        #[cfg(any(test, feature = "test-support"))]
        self.ledger(format!("stop:settled:{sid}"));
        let record = Record::WorkStop(WorkStopRecord { sid: id(sid), phase: WorkStopPhase::Settled, at: Some(self.deps.clock.now_ms()), body: None });
        self.accept_record(record, Class::Control, Display::None, Vec::new(), Vec::new());
    }

    /// Stop `sid` progressed: it settles once nothing is owed. A cancelled disposition owes nothing past its record; a hand-back
    /// owes its rewind, and is offered at that point (in the reply, which its caller sends once the record is durable, or in the
    /// session state, published where the rewind is applied), as Node offered it.
    pub(super) fn advance_stop(&mut self, sid: &str) {
        match self.stops.owed(sid) {
            None => self.settle_stop(sid),
            Some(owed) if owed.rewound => {
                self.stops.unowe(sid);
                self.settle_stop(sid);
            }
            Some(_) => {}
        }
    }

    /// The hand-back Stop `sid` owes, if any: the id its reply carries with the restored text.
    pub(super) fn owed_restore_id(&self, sid: &str) -> Option<String> {
        self.stops.owed(sid).map(|owed| owed.restore.id())
    }

    /// The stopped run's close took its prompt row out (or it had none to take): the hand-back's rewind is done.
    pub(super) fn stop_rewound(&mut self, sid: &str) {
        if let Some(owed) = self.stops.owed_mut(sid) {
            owed.rewound = true;
        }
        self.advance_stop(sid);
    }

    /// The run's close handed nothing back after all (its output committed first): nothing is owed.
    pub(super) fn stop_unowed(&mut self, sid: &str) {
        self.stops.unowe(sid);
        self.advance_stop(sid);
    }

    /// A hand-back published in the session state for the device that sent the prompt (`promptRestore`), under the id and `at`
    /// its Stop's record stores (live, recovered or repeated: a composer applies it once).
    pub(super) fn show_restore(&mut self, restore: &Restore) {
        let restore = PromptRestore { id: restore.id(), ids: restore.ids.clone(), text: restore.text.clone(), device: restore.device.clone(), at: restore.at };
        self.accept_view(Change::Section(Section::PromptRestore(Some(restore))), Vec::new());
    }

    /// The stopped turn's prompt row `row` and everything after it leave the transcript and the model context (the thread's own
    /// rewind, as `PromptRewound` does). A row no longer live (rewound already) takes nothing: the rewind is done once.
    pub(super) fn rewind_row(&mut self, row: &str) {
        let window = &self.acked.window;
        let Some((index, ordinal)) = window.iter().position(|shown| shown.item.id().as_str() == row).and_then(|index| Some((index, window[index].ordinal?)))
        else {
            return;
        };
        let previous = index.checked_sub(1).map(|i| window[i].item.id().clone());
        let record = Record::Rewind(RewindRecord { to_ordinal: ordinal, reason: RewindReason::Rewind, op: None });
        self.transcript_rewritten = true;
        self.deps.side.forget(&self.id, crate::session::turn_ops::SideEnd::Transcript);
        let note = self.history_reset(HistoryResetReason::Rewind, previous);
        self.accept_record(record, Class::Normal, Display::None, vec![note], Vec::new());
        if let Some(reset) = self.provider_state_change(None) {
            self.accept_record(reset, Class::Normal, Display::None, Vec::new(), Vec::new());
        }
    }

    pub(super) fn stop_queued(&mut self, qid: &str, canceller: &str) -> Option<(Option<String>, StopWait)> {
        let queued = self.projected.queue.iter().find(|queued| queued.qid == qid && !self.queued_frozen(queued)).cloned()?;
        let submissions =
            queued.entry.pointer("/options/clientSubmissionId").and_then(Value::as_str).filter(|id| !id.is_empty()).map(str::to_owned).into_iter().collect();
        let device = queued.entry.pointer("/transcriptMeta/device").and_then(Value::as_str).filter(|device| !device.is_empty()).unwrap_or(canceller).to_owned();
        let work = WorkRef { id: qid.to_owned(), qids: vec![qid.to_owned()], submissions, handback: Some(Handback { text: Taken::of(&queued).text, device }) };
        let restore = work.restore();
        let (sid, wait) = self.record_stop(&work, None, None, restore.as_ref(), true);
        let id = self.owed_restore_id(&sid);
        self.advance_stop(&sid);
        Some((id, wait))
    }

    /// A start whose work a Stop froze before its run began: it never runs. Its prompt goes back to its composer (a user's restorable
    /// prompt) or it is cancelled and consumed; its waiter hears that it was stopped; the Stop settles; the queue behind it moves on.
    pub(super) fn finish_stopped_start(
        &mut self,
        #[cfg_attr(not(any(test, feature = "test-support")), allow(unused_variables))] work: WorkRef,
        reply: Option<Effect>,
        sid: &str,
    ) {
        #[cfg(any(test, feature = "test-support"))]
        self.ledger(format!("start:stopped:{}", work.id));
        self.submitter = None;
        self.retry_provenance = None;
        self.retry_prior = None;
        self.retry_hidden = false;
        // Its dequeue shows on its own: the start it waited to show with is not coming.
        self.outbox.unpair_pending();
        // A hand-back is offered in the session state for the device that sent the prompt; with nothing to rewind it is settled
        // then. A cancelled start is final now.
        if let Some(restore) = self.stops.owed(sid).filter(|owed| !owed.by_reply).map(|owed| owed.restore.clone()) {
            self.show_restore(&restore);
        }
        self.advance_stop(sid);
        self.refuse_start(reply, &coded("session", TURN_STOPPED, "The turn was stopped before it started."));
        self.start_next_queued();
    }

    pub(super) fn stop_submissions(&mut self, submissions: &[String]) -> Vec<StopWait> {
        let mut waits = Vec::new();
        for id in submissions.iter().filter(|id| !id.is_empty()) {
            let owns = |work: &WorkRef| work.submissions.iter().any(|owned| owned == id);
            if self.run.as_ref().is_some_and(|run| owns(&run.work)) && !self.end_parked() {
                waits.push(self.stop_owned_by_run(id));
                continue;
            }
            if self.deferred_start.as_ref().is_some_and(|start| owns(&start.work)) {
                let start = self.deferred_start.take().expect("the deferred start");
                let (sid, wait) = self.record_stop(&start.work, None, None, None, false);
                waits.push(wait);
                self.finish_stopped_start(start.work, start.reply, &sid);
                continue;
            }
            if self.starting
                && let Some(work) = self.pending_work.clone().filter(|work| owns(work))
            {
                let (_, wait) = self.record_stop(&work, None, None, None, false);
                waits.push(wait);
                // Its late read finishes the cancellation ([`Self::start_run_read`]); its dequeue shows on its own.
                self.outbox.unpair_pending();
                continue;
            }
            let qids: Vec<String> = self
                .projected
                .queue
                .iter()
                .filter(|queued| queued.entry.pointer("/options/clientSubmissionId").and_then(Value::as_str) == Some(id.as_str()))
                .map(|queued| queued.qid.clone())
                .collect();
            let work = WorkRef { id: qids.first().cloned().unwrap_or_else(|| id.clone()), qids, submissions: vec![id.clone()], handback: None };
            let (sid, wait) = self.record_stop(&work, None, None, None, false);
            waits.push(wait);
            // Nothing of it runs: the cancelled outcome is final with the record.
            self.advance_stop(&sid);
        }
        // A repeat that joined an already durable Stop releases what that record protects (the latch it set just now).
        self.release_protected_latches();
        waits
    }

    fn stop_owned_by_run(&mut self, id: &str) -> StopWait {
        let run = self.run.as_ref().expect("a running turn");
        if run.injected.is_empty() {
            let (_, wait, _) = self.stop_active_run(Some(false), "", false);
            return wait;
        }
        let turn = run.turn.clone();
        let target = match run.injected.iter().find(|unit| unit.submissions.iter().any(|owned| owned == id)) {
            Some(unit) => unit.clone(),
            None => {
                // The base unit: the run's work less what it took at boundaries.
                let qids = run.work.qids.iter().filter(|qid| !run.injected.iter().any(|unit| unit.qids.contains(qid))).cloned().collect();
                let submissions =
                    run.work.submissions.iter().filter(|owned| !run.injected.iter().any(|unit| unit.submissions.contains(owned))).cloned().collect();
                WorkRef { id: run.work.id.clone(), qids, submissions, handback: None }
            }
        };
        let _ = self.cell.abort(&turn, &mixdog_agent::cancel::Abort::runtime_abort(self.id.as_str(), mixdog_agent::cancel::USER_CANCEL));
        let (sid, wait) = self.record_stop(&target, Some(&turn), None, None, false);
        if let Some(run) = self.run.as_mut() {
            run.stop.get_or_insert(sid);
        }
        wait
    }

    /// Running `turn` claims the entry `qid` it is about to take at a boundary in the start gate (its queue id and submission);
    /// false when a Stop from outside the actor latched it, or a takeover reserved it for the next turn: it is not injected.
    pub(super) fn claim_steer(&self, turn: &TurnId, qid: &str, entry: &Value) -> bool {
        if self.reserved_successor().as_deref() == Some(qid) {
            return false;
        }
        let mut identities = vec![work_stops::queued(qid)];
        if let Some(submission) = entry.pointer("/options/clientSubmissionId").and_then(Value::as_str).filter(|id| !id.is_empty()) {
            identities.push(work_stops::submission(submission));
        }
        self.cell.stop_latches.claim(&self.id, turn, &identities)
    }

    /// The latches of this thread that its folded `stoppedWork` now protects are released: the durable mark took over.
    pub(super) fn release_protected_latches(&self) {
        // The acknowledged state: only a record already durable protects an identity across a restart.
        let header = &self.acked.header;
        self.cell.stop_latches.release(&self.id, |identity| work_stops::stopped(header, identity).is_some());
    }

    /// A run whose end is in but parked behind a row being read, or behind the save of the prompt row it hands back
    /// ([`Self::run_ended`]): it is over, a Stop finds nothing to abort.
    pub(super) fn end_parked(&self) -> bool {
        matches!((&self.ended_run, &self.run), (Some((ended, _)), Some(run)) if *ended == run.turn)
    }

    /// The Stop of the published run `turn` ([`Ctl::StopRun`]).
    pub(super) fn stop_run(&mut self, turn: &TurnId, named: bool, restore_prompt: Option<bool>, canceller: &str, unreadable: bool) -> RunStop {
        let running = self.run.as_ref().is_some_and(|run| &run.turn == turn) && !self.end_parked();
        if running {
            let (decision, wait, sid) = self.stop_active_run(restore_prompt, canceller, unreadable);
            return RunStop::Decided(decision, wait, sid);
        }
        if named && self.run.as_ref().is_none_or(|run| &run.turn != turn) {
            return RunStop::NotActive;
        }
        RunStop::Busy(self.stop_busy())
    }

    pub(super) fn stop_active_run(
        &mut self,
        restore_prompt: Option<bool>,
        canceller: &str,
        unreadable: bool,
    ) -> (super::super::stop::Decision, StopWait, Option<String>) {
        let steering = self.projected.queue.iter().any(|queued| super::super::control::is_editable_entry(&queued.entry));
        let run = self.run.as_ref().expect("a running turn");
        let turn = run.turn.clone();
        let decision = run.prompt.decide_and_record(restore_prompt, canceller, steering, unreadable);
        let name = match decision.reason {
            super::super::stop::Reason::Interrupt => "interrupt",
            super::super::stop::Reason::KeepPrompt => "user-cancel-keep-prompt",
            super::super::stop::Reason::UserCancel => mixdog_agent::cancel::USER_CANCEL,
        };
        // The abort that ends the run decides how its end reads: a Stop behind another abort (a takeover, a room's Stop from
        // outside the actor) changes nothing of it. The prompt this Stop keeps, the turn's close keeps: the close follows the
        // decision in the reply, not what output it finds then.
        let mut abort = mixdog_agent::cancel::Abort::runtime_abort(self.id.as_str(), name);
        if decision.keeps_prompt {
            abort.reason = mixdog_agent::interrupt::AbortReason::UserCancelKeepPrompt;
        }
        let ends_run = self.cell.abort_first(&turn, &abort).unwrap_or(false);
        let _ = self.cell.ctl_tx.try_send(Ctl::Abort { turn: turn.clone() });
        let facts = run.prompt.snapshot();
        let restore = facts.reclaim.as_ref().map(|reclaim| Restore {
            text: reclaim.text.clone(),
            ids: reclaim.ids.clone(),
            device: reclaim.handoff.clone().unwrap_or_else(|| facts.device.clone()),
            at: 0,
        });
        let (work, row) = (run.work.clone(), run.input_item.as_str().to_owned());
        // The canceller's own prompt travels in this Stop's reply; another device's goes through the session state.
        let by_reply = !decision.restore_text.is_empty();
        let (sid, wait) = self.record_stop(&work, Some(&turn), Some(&row), restore.as_ref(), by_reply);
        let id = self.owed_restore_id(&sid);
        if let Some(run) = self.run.as_mut() {
            run.stop.get_or_insert(sid);
            if ends_run && decision.reason == super::super::stop::Reason::Interrupt {
                run.interrupt_end.get_or_insert(super::InterruptEnd::Stop);
            }
        }
        if ends_run {
            self.patch_spinner([("stopping", json!(true))]);
        }
        (decision, wait, id)
    }

    /// The spinner of the running `turn` reads stopping (`spinner.stopping`) when a Stop from outside the actor ended it
    /// ([`super::super::control::ControlCell::interrupt`]). A Stop the actor decides sets it itself; a takeover never does.
    /// The field stays through later patches of the spinner and goes with it at the turn's end.
    pub(super) fn show_stopping(&mut self, turn: &TurnId) {
        let running = self.run.as_ref().is_some_and(|run| &run.turn == turn) && !self.end_parked();
        if running && self.cell.stop_latches.stop_was_accepted(&self.id, turn) {
            self.patch_spinner([("stopping", json!(true))]);
        }
    }

    /// A refused takeover's receipt, stored under its operation as an accepted one's is (there on the takeover's own record):
    /// a repeat of the operation reads it back, in this process or after a restart, and is never decided a second time.
    fn answer_refused(&mut self, req: &CoreRequest, op: OpId, receipt: Value, tx: Waiter) {
        use mixdog_store::schema::record::OpRecord;
        use mixdog_store::schema::record::OpState;
        match self.op_ref(req, Some(&receipt)) {
            Ok(Some(op_ref)) => {
                let record = Record::Op(OpRecord { op: op_ref, state: OpState::Applied, at: self.deps.clock.now_ms(), detail: None });
                self.accept_record(record, Class::Control, Display::None, Vec::new(), vec![Effect::Reply { op: Some(op), tx: Some(tx), value: receipt }]);
            }
            Ok(None) | Err(_) => {
                let error = invalid("opId", "the takeover's operation id");
                self.ops.failed(&op, &error);
                let _ = tx.send(Err(error));
            }
        }
    }

    /// `turn/takeover`: the queued message the request names takes over the running turn it names. Decided here, in one
    /// step of the thread's own task and before any side effect: the turn must be the one running, with no end and no stop of
    /// its own under way, and the message must still wait in the queue. Then the turn's abort is fired, and only if that abort
    /// is the one that ends the run is anything recorded: the turn's stop with the takeover it ends by, the message at the
    /// front of the queue, and the reservation of the next turn for it ([`Self::reserved_successor`]). Anything else is a
    /// refusal that names what became of the message and changed nothing.
    ///
    /// The answer is a receipt (`TurnTakeoverResponse`) under the request's operation id: a repeat gets the first one's, an
    /// accepted one once its records are durable.
    pub(super) fn take_over(&mut self, req: CoreRequest, tx: Waiter) {
        use mixdog_app_protocol::v2::thread::TakeoverMessage;
        use mixdog_app_protocol::v2::thread::TakeoverRefusal;
        use mixdog_app_protocol::v2::thread::TurnTakeoverParams;
        use mixdog_app_protocol::v2::thread::TurnTakeoverResponse;
        let Some(op) = req.op.clone() else {
            let _ = tx.send(Err(invalid("opId", "the takeover's operation id")));
            return;
        };
        let fail = |actor: &mut Self, error: CoreError, tx: Waiter| {
            actor.ops.failed(&op, &error);
            let _ = tx.send(Err(error));
        };
        let TurnTakeoverParams { turn_id, queued_id: named, .. } = match parse(&req.params, "TurnTakeoverParams") {
            Ok(params) => params,
            Err(error) => return fail(self, error, tx),
        };
        let turn = &turn_id;
        if self.deleting || self.shutting_down {
            return fail(self, CoreError::ThreadClosing { thread_id: self.id.clone() }, tx);
        }
        let canceller = match req.ctx.caller {
            Caller::Connection(connection) => self.deps.devices.describe(connection).device,
            Caller::Internal(_) => String::new(),
        };
        // One takeover per turn: once one is decided for the named turn, interrupted or not, no other message takes it.
        let taken = self.cell.stop_latches.takeover(&self.id).is_some_and(|takeover| &takeover.turn == turn);
        let message = self.projected.queue.iter().find(|queued| queued_is(&queued.qid, &queued.entry, named.as_str()) && !self.queued_frozen(queued)).cloned();
        let sendable = message.as_ref().filter(|queued| super::super::control::is_prioritizable_entry(&queued.entry));
        // A Stop that withdrew the message froze it under the id the request names (its queue id or its submission).
        let withdrawn = [work_stops::queued(named.as_str()), work_stops::submission(named.as_str())].iter().any(|identity| self.stopped_identity(identity));
        let named_runs = self.run.as_ref().is_some_and(|run| &run.turn == turn);
        // The fixed order of the refusals: the first that applies is the one named.
        let refusal = match self.run.as_ref() {
            None => Some(TakeoverRefusal::NoRunningTurn),
            Some(_) if self.compacting() || self.compaction_held() || self.core_hold() != StartHold::Open => Some(TakeoverRefusal::TurnNotTakeable),
            Some(_) if withdrawn => Some(TakeoverRefusal::StopClaimed),
            Some(_) if named_runs && taken => Some(TakeoverRefusal::TakenOver),
            Some(run) if named_runs && (run.stop.is_some() || run.interrupt_end.is_some() || run.cancel.is_aborted()) => Some(TakeoverRefusal::StopClaimed),
            Some(_) => match sendable {
                None => Some(TakeoverRefusal::TooLate),
                Some(_) if !named_runs => Some(TakeoverRefusal::TurnMismatch),
                Some(queued) if self.deliverable_entry(&queued.entry).is_err() => Some(TakeoverRefusal::MessageUndeliverable),
                Some(_) => None,
            },
        };
        let refused = |reason| {
            let message = if message.is_some() { TakeoverMessage::Queued } else { TakeoverMessage::Consumed };
            serde_json::to_value(TurnTakeoverResponse::Refused { turn_id: turn.clone(), queued_id: named.clone(), reason, message })
                .expect("a receipt serializes")
        };
        let (Some(queued), None) = (sendable, refusal) else {
            let receipt = refused(refusal.unwrap_or(TakeoverRefusal::TooLate));
            return self.answer_refused(&req, op.clone(), receipt, tx);
        };
        // A turn already at its end is not interrupted: the message only becomes the next turn's input.
        let interrupted = !self.end_parked();
        let run = self.run.as_ref().expect("the running turn");
        let facts = run.prompt.snapshot();
        let discards = super::super::stop::decide(&facts, Some(false), &canceller, true, false);
        let discard = |wanted: bool, pointer: &str| (interrupted && wanted).then(|| facts.entry.pointer(pointer).cloned().unwrap_or(Value::Null));
        let submission = queued.entry.pointer("/options/clientSubmissionId").and_then(Value::as_str).filter(|id| !id.is_empty()).map(str::to_owned);
        // The receipt states what is decided here (the abort is asked for, the message is the successor), and nothing of how
        // the turn's end reads: a run whose own completion is already on its way ends as it completed, and its end row says so.
        let receipt = serde_json::to_value(TurnTakeoverResponse::Accepted {
            turn_id: turn.clone(),
            queued_id: QueuedId::from(queued.qid.as_str()),
            submission_id: submission.clone(),
            interrupt_requested: interrupted,
            message: TakeoverMessage::Successor,
            discard_pasted_images: discard(discards.discard_images, "/options/pastedImages"),
            discard_pasted_texts: discard(discards.discard_texts, "/options/pastedTexts"),
        })
        .expect("a receipt serializes");
        let op_ref = match self.op_ref(&req, Some(&receipt)) {
            Ok(op_ref) => op_ref,
            Err(error) => return fail(self, error, tx),
        };
        if interrupted {
            #[cfg(any(test, feature = "test-support"))]
            self.cell.start_fence("takeover");
            // The one point that decides it: a Stop that fired first (a room's, from outside the actor) ends the run its own
            // way. The abort's text is the takeover's own: a tool call it cuts short reads that, not a Stop's cancellation.
            let abort = mixdog_agent::cancel::Abort {
                message: mixdog_agent::cancel::session_closed(self.id.as_str(), TAKEOVER_ABORT),
                reason: mixdog_agent::interrupt::AbortReason::from_name("interrupt"),
            };
            if !self.cell.abort_first(turn, &abort).unwrap_or(false) {
                let receipt = refused(TakeoverRefusal::StopClaimed);
                return self.answer_refused(&req, op.clone(), receipt, tx);
            }
            self.abort_requests(turn.clone());
        }
        let takeover = Takeover { op: op.as_str().to_owned(), turn: turn.clone(), message: queued.qid.clone(), submission, interrupted, successor: None };
        if interrupted {
            let run = self.run.as_ref().expect("the running turn");
            run.prompt.decide_and_record(Some(false), &canceller, true, false);
            let (work, row) = (run.work.clone(), run.input_item.as_str().to_owned());
            let note = json!({ "op": takeover.op, "message": takeover.message });
            let (sid, _) = self.record_stop_noting(&work, Some(turn), Some(&row), None, false, Some(note));
            if let Some(run) = self.run.as_mut() {
                run.stop.get_or_insert(sid);
                run.interrupt_end = Some(super::InterruptEnd::Message);
            }
        }
        self.cell.stop_latches.reserve(&self.id, takeover);
        // `prioritizeQueued`: the message goes to the front of the queue. The receipt rides this record, the takeover's last.
        let mut entry = queued.entry.clone();
        entry["priority"] = json!("now");
        let record =
            Record::Queue(QueueRecord { qid: id(&queued.qid), action: QueueAction::Prioritize, reason: None, op: op_ref, entry: Some(Slot::Inline(entry)) });
        self.accept_record(record, Class::Control, Display::None, Vec::new(), vec![Effect::Reply { op: Some(op), tx: Some(tx), value: receipt }]);
        if !interrupted {
            return;
        }
        // An Agent's turn ended by its user is the live parent signal for the agent jobs it started (`abortSession`).
        let mut header = (**self.cell.header.load()).clone();
        if !header.contains_key("id") {
            header.insert("id".into(), json!(self.id));
        }
        if mixdog_core_base::quota_resume::is_agent_only_session(&Value::Object(header)) {
            self.deps.agent_signals.agent_turn_aborted(self.id.as_str());
        }
    }

    pub(super) fn stop_busy(&mut self) -> BusyStop {
        let mut waits = Vec::new();
        let mut stopped = false;
        if self.run.is_some() && !self.end_parked() {
            let facts = self.run.as_ref().map(|run| run.prompt.snapshot()).unwrap_or_default();
            let handback = facts.restorable && !facts.device.is_empty();
            let canceller = if handback { "stop-before-start" } else { "" };
            let (_, wait, _) = self.stop_active_run(if handback { None } else { Some(false) }, canceller, false);
            return BusyStop::Stopped(vec![wait]);
        }
        if let Some(start) = self.deferred_start.take() {
            let restore = start.work.restore();
            let (sid, wait) = self.record_stop(&start.work, None, None, restore.as_ref(), false);
            waits.push(wait);
            self.finish_stopped_start(start.work, start.reply, &sid);
            stopped = true;
        } else if self.starting
            && let Some(work) = self.pending_work.clone()
        {
            let restore = work.restore();
            let (_, wait) = self.record_stop(&work, None, None, restore.as_ref(), false);
            waits.push(wait);
            // The start shows no more: its dequeue goes out on its own, so the Stop's record is not held behind it.
            self.outbox.unpair_pending();
            stopped = true;
        }
        if self.compactions > 0 || self.compaction_held() {
            let abort = mixdog_agent::cancel::Abort::runtime_abort(self.id.as_str(), mixdog_agent::cancel::USER_CANCEL);
            self.cell.abort_compaction(&abort);
            stopped = true;
        }
        if self.settling || self.end_parked() {
            // Exactly the batch the drain would start: a notice of another priority, or one behind a prompt, is not that wake's.
            let batch = self.impending_wake_batch();
            if !batch.is_empty() {
                let qids: Vec<String> = batch.iter().map(|queued| queued.qid.clone()).collect();
                let work = WorkRef { id: qids[0].clone(), qids, submissions: Vec::new(), handback: None };
                let (sid, wait) = self.record_stop(&work, None, None, None, false);
                waits.push(wait);
                // Nothing of it ran: the cancelled outcome is its consumption, final with the record.
                self.advance_stop(&sid);
            }
            stopped = true;
        }
        match (stopped, self.goal_checking, self.quota_pending.is_some()) {
            (true, _, _) => BusyStop::Stopped(waits),
            (false, true, _) => BusyStop::Unstoppable("goal check"),
            (false, false, true) => BusyStop::Unstoppable("quota resume"),
            (false, false, false) => BusyStop::Idle,
        }
    }

    pub(super) fn recover_stops(&mut self) {
        for (sid, body) in work_stops::owed(&self.acked.header) {
            #[cfg(any(test, feature = "test-support"))]
            self.ledger(format!("stop:recovered:{sid}"));
            if let Some(restore) = super::super::stop::owed_restore(&body) {
                if let Some(row) = super::super::stop::owed_row(&body) {
                    self.rewind_row(&row);
                }
                self.accept_view(Change::PromptWithout(restore.text.clone()), Vec::new());
                self.show_restore(&restore);
            }
            self.advance_stop(&sid);
        }
    }

    #[cfg(any(test, feature = "test-support"))]
    pub(super) fn ledger(&self, event: String) {
        self.cell.stop_ledger.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).push(event);
    }
}
