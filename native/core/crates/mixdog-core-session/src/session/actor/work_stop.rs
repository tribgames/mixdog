//! A user Stop is the terminal disposition of the work it stops (`session/stop.rs`): that work never runs again without a new
//! user action, and unrelated work that arrives later still runs.
//!
//! The order of one Stop: at its linearization point (the actor's step that takes it) the identities of the work it targets are
//! frozen and latched ([`super::super::stop::StopBook`]), so no stage of this process runs them again; execution is aborted at once
//! where there is any; the Stop's one record (`work_stop{stopped}`, carrying the whole target set and what is still owed) is
//! appended through the control reserve behind every record already accepted; its caller is answered success only once that record
//! is durable (`Effect::MarkAck`, which a failed barrier, a retained unit's rollback or a shutdown fails and never holds), else
//! with the storage failure; the owed outcome (the hand-back, or the cancelled outcome) is finished by the ordinary path and settled
//! by `work_stop{settled}`, or after a restart by [`SessionActor::recover_stops`]. Nothing here waits on a held input read or the
//! stopped run's end, and nothing holds the actor or the prompt's lock while the record is saved.

use super::*;
use mixdog_store::schema::record::WorkStopPhase;
use mixdog_store::schema::record::WorkStopRecord;
use mixdog_store::work_stops;

use super::super::control::BusyStop;
use super::super::control::RunStop;
use super::super::stop::Handback;
use super::super::stop::OwedHandback;
use super::super::stop::Restore;
use super::super::stop::StopWait;

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
        self.stops.latched_identity(identity).is_some() || self.cell.stop_latches.latched(&self.id, identity) || work_stops::stopped(&self.projected.header, identity).is_some()
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
        self.stops.latched(work).or_else(|| work.identities().iter().find_map(|identity| work_stops::stopped(&self.projected.header, identity)).map(str::to_owned))
    }

    /// A queued copy of stopped work: by its queue id, or the submission it answers.
    pub(super) fn queued_stopped(&self, queued: &Queued) -> bool {
        self.stopped_identity(&work_stops::queued(&queued.qid))
            || queued.entry.pointer("/options/clientSubmissionId").and_then(Value::as_str).filter(|id| !id.is_empty()).is_some_and(|id| self.stopped_identity(&work_stops::submission(id)))
    }

    /// Freezes `work` under a Stop and appends its record, or joins the Stop that already froze it. Answers the Stop's id and its
    /// durable-only waiter.
    /// A hand-back (`restore`) is owed until its rewind is done and it was offered ([`super::super::stop::OwedHandback`]): `row`
    /// is the stopped run's input row its rewind takes out (none for work that never ran), `by_reply` whether the Stop's own
    /// reply carries it. The record stamps the restore's `at` (the Stop's time), from which its id is derived on every path.
    pub(super) fn record_stop(&mut self, work: &WorkRef, turn: Option<&TurnId>, row: Option<&str>, restore: Option<&Restore>, by_reply: bool) -> (String, StopWait) {
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
        let body = work.stop_body(turn.map(TurnId::as_str), row, restore.as_ref());
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
        let Some((index, ordinal)) = window.iter().position(|shown| shown.item.id().as_str() == row).and_then(|index| Some((index, window[index].ordinal?))) else {
            return;
        };
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

    /// A Stop while the scheduled compaction holds the session ([`Ctl::StopQueued`]): the newest editable queued prompt goes back to
    /// the canceller in the Stop's reply, and is frozen under the Stop, so it leaves the queue and never runs too. Answers the
    /// hand-back's id (which the reply carries) and the Stop's durable-only waiter. Nothing is rewound: the hand-back is offered
    /// by the reply and its Stop settles with its record.
    pub(super) fn stop_queued(&mut self, qid: &str, canceller: &str) -> Option<(Option<String>, StopWait)> {
        let queued = self.projected.queue.iter().find(|queued| queued.qid == qid && !self.queued_stopped(queued)).cloned()?;
        let submissions = queued.entry.pointer("/options/clientSubmissionId").and_then(Value::as_str).filter(|id| !id.is_empty()).map(str::to_owned).into_iter().collect();
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
    pub(super) fn finish_stopped_start(&mut self, work: WorkRef, reply: Option<Effect>, sid: &str) {
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

    /// A user Stop of exactly the work submitted under `submissions` ([`Ctl::StopWork`], a room's Stop of its exchange's member
    /// submissions): each is found by its identity wherever it is (running, a start deferred or being read, queued) and frozen
    /// under its own Stop record with a cancelled disposition, never a composer hand-back. A submission not here yet is frozen all
    /// the same (a tombstone): its later admission meets the terminal identity and never runs (`turn_start`'s check). A run is
    /// aborted only when it owns a targeted submission; unrelated queued work is untouched; a repeat joins the Stop that froze it.
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

    /// A targeted Stop of submission `id`, which the running turn owns (it started for it, or took it at a boundary).
    ///
    /// The targeted prompt is already in the run's model context and cannot be taken out of a model call in flight, so the only
    /// way it does not continue is that the run does not continue: the run is aborted at once with the user's cancel. That is the
    /// smallest correct effect on the rest of the run:
    /// The run owns units of work: the one it started for (its base: a prompt, a queued entry, a completion batch) and each entry
    /// it took at a boundary. Only the unit that carries `id` is ever frozen:
    /// - A run whose only unit is the one carrying `id` (nothing injected) is stopped as any user Stop stops a run
    ///   ([`Self::stop_active_run`], its whole work, which is that unit, frozen, cancelled, never a hand-back).
    /// - A run that owns anything else (any other unit: a completion batch's queue identities, another prompt) is aborted, and
    ///   only the targeted unit (its queue id and submission) is frozen under the Stop's record. The other units end as an
    ///   interruption ends them: what they already committed stays, they are not re-run (their queue copies were consumed when
    ///   the run took them, and an interrupted run is never requeued), and their identities stay non-terminal (no stopped mark,
    ///   no completion receipt), so their owners may still deliver or send them again: a targeted Stop never makes another
    ///   owner's work terminal.
    ///
    /// Either way the record does not wait for the run to end; the Stop settles after the run's close.
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
                let submissions = run.work.submissions.iter().filter(|owned| !run.injected.iter().any(|unit| unit.submissions.contains(owned))).cloned().collect();
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
    /// false when a Stop from outside the actor latched it: it is not injected.
    pub(super) fn claim_steer(&self, turn: &TurnId, qid: &str, entry: &Value) -> bool {
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

    /// A run whose end is in but parked behind a row being read ([`Self::run_ended`]): it is over, a Stop finds nothing to abort.
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

    /// Stops the running turn (a model call, tools, waits): the prompt's disposition is decided under its lock (an output commit
    /// lands wholly before or after), the run is aborted at once, and the run's owned work (the inputs it claimed, nothing queued
    /// beside it) is frozen with what the decision owes. The record does not wait for the run to end; its settlement follows the
    /// run's close.
    /// Answers the decision, the Stop's durable-only waiter and the id of the hand-back it owes (which a reply carrying the
    /// restored text names).
    pub(super) fn stop_active_run(&mut self, restore_prompt: Option<bool>, canceller: &str, unreadable: bool) -> (super::super::stop::Decision, StopWait, Option<String>) {
        let steering = self.projected.queue.iter().any(|queued| super::super::control::is_editable_entry(&queued.entry));
        let run = self.run.as_ref().expect("a running turn");
        let turn = run.turn.clone();
        let decision = run.prompt.decide_and_record(restore_prompt, canceller, steering, unreadable);
        let name = match decision.reason {
            super::super::stop::Reason::Interrupt => "interrupt",
            super::super::stop::Reason::KeepPrompt => "user-cancel-keep-prompt",
            super::super::stop::Reason::UserCancel => mixdog_agent::cancel::USER_CANCEL,
        };
        let _ = self.cell.abort(&turn, &mixdog_agent::cancel::Abort::runtime_abort(self.id.as_str(), name));
        let facts = run.prompt.snapshot();
        let restore = facts.reclaim.as_ref().map(|reclaim| Restore { text: reclaim.text.clone(), ids: reclaim.ids.clone(), device: reclaim.handoff.clone().unwrap_or_else(|| facts.device.clone()), at: 0 });
        let (work, row) = (run.work.clone(), run.input_item.as_str().to_owned());
        // The canceller's own prompt travels in this Stop's reply; another device's goes through the session state.
        let by_reply = !decision.restore_text.is_empty();
        let (sid, wait) = self.record_stop(&work, Some(&turn), Some(&row), restore.as_ref(), by_reply);
        let id = self.owed_restore_id(&sid);
        if let Some(run) = self.run.as_mut() {
            run.stop.get_or_insert(sid);
        }
        (decision, wait, id)
    }

    /// A Stop with no published run (`abortRuntime` over Node's whole `busy` span): it applies to exactly the work busy when the
    /// actor takes it.
    /// - A run the caller did not see published yet: stopped as [`Self::stop_active_run`] stops one, its prompt handed to its
    ///   device's composer when it may go back.
    /// - A start pending (deferred, or reading its provenance or its input row): its work is frozen. A deferred start finishes at once;
    ///   one being read finishes when its read comes back ([`Self::start_run_read`]), never running the model.
    /// - A compaction is aborted with the user's cancel.
    /// - A settlement (or an end parked behind a row being read): the completions queued now for the wake that would follow are
    ///   frozen and consumed; none queued, nothing is prohibited. The finished turn's outcome is not rewritten, and a completion
    ///   that arrives later is unrelated work that runs.
    ///
    /// Only the Goal check and a quota resume have no owner here to cancel.
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

    /// The Stops a restart found owed (`owedStops`), after the crashed runs were finalized: their work is terminal already (the fold
    /// removed its queue copies and keyed its identities), so what is left is the outcome, finished as the live path would have.
    /// A cancelled outcome is final with the Stop (a stopped run was closed interrupted by the crash recovery) and settles. A
    /// hand-back first takes the stopped turn's prompt row out of the transcript and the model context (a no-op when the live
    /// close already did), then is offered once more in the session state, under the id its record stores (the one the live path
    /// used), and settles: nothing waits for an acknowledgement.
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
