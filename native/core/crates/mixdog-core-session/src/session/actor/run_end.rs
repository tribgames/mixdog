//! Run end: outcome handling, closing a turn as failed or done, and amending the last row.

use super::*;

impl SessionActor {
    /// `completeTurn`'s `observeThird`: a session whose title work is done reads nothing; any other reads its model
    /// context only up to its third exchange, once the session holds the turn this end completes.
    fn observe_third_title(&mut self) {
        let Some(titles) = self.deps.titles.clone() else { return };
        let Some(session) = titles.third_due(self.id.as_str(), &self.projected.header) else { return };
        #[cfg(any(test, feature = "test-support"))]
        self.ledger(format!("title:read:{}", self.id.as_str()));
        let (store, lanes, thread) = (self.deps.store.clone(), self.deps.lanes, self.id.clone());
        drop(mixdog_rt::spawn("session-title", mixdog_rt::TaskClass::Work, async move {
            let read =
                super::super::run::fold_context_until(&store, &lanes, &thread, 0, |held: &mut Vec<Value>, rows: Vec<(mixdog_core_api::ids::ItemId, Value)>| {
                    crate::session::session_title::gather_exchanges(held, rows.into_iter().map(|(_, body)| body))
                });
            match read.await {
                Ok(messages) => {
                    titles.turn_completed(crate::session::session_title::TitleSession { messages, ..session });
                }
                Err(error) => tracing::warn!(thread = %thread, "[session-title] the exchanges were not read: {error:?}"),
            }
        }));
    }

    /// The end [`Self::run_ended`] parked behind the save of the prompt row it hands back, once the pump made that row durable
    /// or failed it: taken in that same pass. Whether it was.
    pub(super) fn take_landed_end(&mut self) -> bool {
        let landed = self.producers.places.is_empty() && self.end_parked() && self.run.as_ref().is_some_and(|run| *run.input.borrow() != InputState::Pending);
        if landed && let Some((turn, outcome)) = self.ended_run.take() {
            self.run_ended(turn, outcome);
        }
        landed
    }

    pub(super) fn run_ended(&mut self, turn: TurnId, outcome: RunOutcome) {
        // The run's task is over: it runs nothing more a latch would have to abort.
        self.cell.stop_latches.end(&self.id, &turn);
        self.arm_rest();
        // The loop reads the control lane before the producer lane, so the end can overtake output the
        // run sent before it (a delta has no ack). Node's stream callback arms the warm
        // (`ask-callbacks.mjs:55`) synchronously, before the turn settles (`turn-settle.mjs`), so what the run
        // said is applied first. A row whose facts are being read is accepted before anything after it, the end included:
        // the end waits for it ([`Self::ended_run`]), so the close's entries are accepted behind the row's and the row is
        // applied to its own turn, never dropped as a late commit nor overtaken by the close's settle.
        while self.producers.places.len() < self.ch.prod_rx.max_capacity()
            && let Ok(msg) = self.ch.prod_rx.try_recv()
        {
            self.on_producer(msg);
        }
        if !self.producers.places.is_empty() && self.active(&turn) {
            #[cfg(any(test, feature = "test-support"))]
            self.ledger(format!("run:end-parked:{}", turn.as_str()));
            self.ended_run = Some((turn, outcome));
            return;
        }
        // A Stop that hands the prompt back takes the prompt's row out of the session, which only a durable row can be: a run that
        // ended before its input's save landed closes once that save lands (or fails, and the row is withdrawn), so the prompt the
        // composer gets back is never also left committed.
        if matches!(outcome, RunOutcome::Interrupted)
            && self.run.as_ref().is_some_and(|run| run.turn == turn && *run.input.borrow() == InputState::Pending && run.prompt.snapshot().reclaim.is_some())
        {
            self.ended_run = Some((turn, outcome));
            return;
        }
        let Some(mut slot) = self.run.take_if(|run| run.turn == turn) else {
            return;
        };
        self.deps.wakes.reset(&self.id);
        // A first title still waiting on the turn's output is released by its settling.
        slot.shown.send_replace(true);
        // The turn's terminal save writes the books still waiting, before its end.
        self.save_usage();
        self.cell.publish_run(None);
        // askSession's `_evictTerminalSessionRuntime`, once the turn has unwound.
        self.cell.progress.send_modify(|progress| progress.evict_terminal());
        // A stop that handed the prompt back (`reclaimInFlightPrompt`): it leaves the prompt history, another device's
        // composer is told, and the cancelled turn shows no end.
        let reclaimed = slot.prompt.take_reclaim().filter(|_| matches!(outcome, RunOutcome::Interrupted));
        // `settleStreamingTailAtClose` (`turn-stream.mjs`): the text the turn showed stays when it closes. Each live text of the
        // turn is settled as the turn's settles are (`Change::Settled`, decided at its show): a commit of it shown before it
        // owns the row, and one still pending, failed or never made leaves it to this one. Accepted before the turn's end
        // (whose fold drops the live items, and whose `turn/completed` clears a client's live text), so it is told first. A
        // stop that handed the prompt back takes the turn's rows with it (`reclaimInFlightPrompt`): nothing is settled then.
        // A text no record of the turn holds (the reply a failed turn streamed in part) is stored as a record of its
        // own that is no message: it reads the same live, in a snapshot, in any window and after a reload, and the
        // model's context holds none of it.
        let (settled, committed) = (std::mem::take(&mut self.settled_texts), std::mem::take(&mut self.committed_texts));
        if reclaimed.is_none() {
            let mut shown: Vec<ThreadItem> = self
                .projected
                .live
                .iter()
                .filter(|live| {
                    live.turn == turn
                        && matches!(&live.item, ThreadItem::AgentMessage { text: mixdog_protocol::MaybeBlob::Inline(text), .. } if !text.trim().is_empty())
                })
                .map(|live| live.item.clone())
                .collect();
            // The texts that settled before a tool call, were shown so, and that no commit followed.
            let uncommitted = settled.iter().filter(|id| !committed.contains(id));
            shown.extend(uncommitted.filter_map(|id| self.projected.window.iter().find(|row| row.item.id() == id)).map(|row| (*row.item).clone()));
            for item in shown {
                // A text whose commit was accepted is that record's: the settle shows it only if the record is never written.
                if committed.contains(item.id()) {
                    self.accept_view(Change::Settled { turn: turn.clone(), item }, Vec::new());
                } else if let ThreadItem::AgentMessage { id, text: mixdog_protocol::MaybeBlob::Inline(text), .. } = &item {
                    self.show_stored(Some(&turn), id.as_str(), json!({ "kind": "assistant", "id": id.as_str(), "text": text }));
                }
            }
        }
        if let Some(reclaim) = &reclaimed {
            let (sid, row) = (slot.stop.clone(), slot.input_item.clone());
            self.apply_reclaim(reclaim, sid.as_deref(), &row);
        }
        // The display fields the turn waited to publish (`on_context_section`), a stopped turn's too: Node's phone shows them set
        // once a stopped turn closed (every Stop case of the phone's Stop recordings ends on `displayContextWindow` =
        // `autoCompactTokenLimit` = `compactBoundaryTokens` = the window; `completeTurn`'s `syncContextStats`, turn.mjs:530,835).
        if let Some(held) = self.held_display.take() {
            self.accept_view(Change::Section(Section::Context(held)), Vec::new());
        }
        // `setActiveTurnCount(-1)`: the parked warmups re-check.
        self.turn_prewarm_armed = false;
        self.deps.code_graph_prewarm.wake();
        self.deps.code_graph_prewarm.turn_settled();
        // An ended turn has no working messages left (`liveTurnMessages` ends with the turn).
        self.cell.turn_messages.send_replace(Default::default());
        self.steer_marked.clear();
        self.abort_ended = Default::default();
        // Every row the turn took a queued copy into is committed by now: an id still held is of a row that never showed.
        self.suppressed.clear();
        // `settleTurn`'s `releaseWorkspace()`: every settled turn, whatever its outcome, starts
        // the removal of the snapshots it made, without waiting for it.
        if !matches!(outcome, RunOutcome::Completed(_)) {
            self.deps.snapshots.turn_aborted(&self.id);
        }
        self.deps.snapshots.turn_settled(&self.id);
        // `upsertLeadSession`: the workspace released, the lead's pool row goes idle; a worker's row takes the turn's end.
        self.deps.turn_starts.turn_settled(&self.id);
        // `completeTurn`'s `setSession(mgr.getSession(...))` (`turn-settle.mjs:38`) re-installs the session through
        // `adoptSession`, whose `syncSessionCompaction` drops the resolved buffer the pre-send checks wrote and
        // follows the saved settings: a completed turn only.
        if matches!(outcome, RunOutcome::Completed(_)) {
            self.sync_compaction();
        }
        {
            let provider = slot.provider.as_str();
            match &outcome {
                RunOutcome::Completed(_) => {
                    self.deps.notices.turn_completed(provider);
                    self.observe_third_title();
                }
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
            self.agent_done.push((done, outcome.clone()));
        }
        for done in slot.joined {
            self.agent_done.push((done, outcome.clone()));
        }
        for listener in self.cell.turn_listeners() {
            listener.turn_settled(settled.clone());
        }
        let at = self.deps.clock.now_ms();
        let resolution = match outcome {
            RunOutcome::Interrupted => ApprovalResolution::Interrupted { at },
            _ => ApprovalResolution::Cancelled { at },
        };
        // A call the run let go of goes on past it with its approvals, unless the run was stopped, which stopped the call too.
        let detached = &self.detached;
        let stopped = slot.token.is_cancelled();
        let stays =
            |ask: &mixdog_core_api::domain::approval::ApprovalAsk| !stopped && ask.call_id.as_ref().is_some_and(|call| detached.contains(call.as_str()));
        for aid in self.book.take_run_but(&turn, stays) {
            self.resolve(aid, &turn, resolution.clone());
        }
        // `onGoalTurnSettled` (`turnOutcome`): the Goal runtime closes the turn's clock segment
        // and reads its outcome.
        let (status, error) = match &outcome {
            RunOutcome::Completed(_) => ("done", None),
            RunOutcome::Interrupted => ("cancelled", None),
            RunOutcome::Failed(error) => ("failed", Some(error)),
        };
        let settle = super::super::goal_lane::settle_detail(status, error, slot.automatic, slot.tool_calls);
        // The next turn waits for the settlement, as Node's queue drains after `runTurn` returns.
        self.settling = true;
        self.settling_wake = slot.wake;
        match error {
            Some(error) => {
                // `transcriptMeta` carries the turn's `completionVerb` (`beginTurn`), which the failure's end and completion name.
                let mut transcript = slot.transcript.clone();
                transcript["completionVerb"] = json!(slot.verb);
                let failed = FailedClose {
                    refused: slot.start_failed,
                    error,
                    start_provider: &slot.provider,
                    route_meta: &slot.route_meta,
                    last: slot.last_model.as_ref(),
                    started_at: slot.started_at,
                    transcript: &transcript,
                    live: &mut slot.live,
                };
                self.close_failed(&turn, failed, settle);
            }
            None => {
                let ended = match &outcome {
                    RunOutcome::Completed(result) => Some(("done", result.content.as_str())),
                    RunOutcome::Interrupted => Some(("cancelled", "")),
                    RunOutcome::Failed(_) => None,
                };
                // `completeTurn`: a refusal is told to the user before the turn's end row.
                if matches!(&outcome, RunOutcome::Completed(result) if result.termination == Some(mixdog_agent::response::Termination::Refusal)) {
                    self.run_shown(turn.clone(), RunShown::Notice { text: REFUSAL_NOTICE.to_owned(), tone: mixdog_agent::env::Tone::Warn });
                }
                if let Some((status, result)) = ended {
                    let done = DoneClose {
                        reclaimed: reclaimed.is_some() || slot.start_failed,
                        interrupt_end: slot.interrupt_end.filter(|_| matches!(outcome, RunOutcome::Interrupted)),
                        status,
                        verb: slot.verb,
                        result,
                        route_meta: &slot.route_meta,
                        last: slot.last_model.as_ref(),
                        started_at: slot.started_at,
                        transcript: &slot.transcript,
                        live: &mut slot.live,
                    };
                    self.close_done(&turn, done);
                }
                self.settle_goal(settle);
            }
        }
        // `acknowledgePendingGoalReminder`: only an accepted turn clears the marker it carried.
        if let (RunOutcome::Completed(_), Some(revision)) = (&outcome, slot.goal_reminder)
            && let Some(change) = super::super::goal_reminder::acknowledge(&self.projected.header, revision, self.deps.clock.now_ms())
        {
            let meta = Record::Meta(MetaRecord { op: None, change: Slot::Inline(change) });
            self.accept_record(meta, Class::Normal, Display::None, Vec::new(), Vec::new());
        }
        // The reminders the turn carried (`ask-turn-settle.mjs:148-164`: deferred delta, workflow, settings, orchestration
        // mode, working folder, setup): only an accepted turn tells them; a failed or interrupted one leaves them
        // pending for the next turn.
        let carried = slot.notice.take();
        if matches!(outcome, RunOutcome::Completed(_))
            && let Some(change) = super::super::reminders::acknowledge(&self.projected.header, &carried, self.deps.clock.now_ms())
        {
            let meta = Record::Meta(MetaRecord { op: None, change: Slot::Inline(change) });
            self.accept_record(meta, Class::Normal, Display::None, Vec::new(), Vec::new());
        }
        if !slot.start_failed {
            if let RunOutcome::Completed(result) = &outcome {
                let termination = result.termination.map(|termination| match termination {
                    mixdog_agent::response::Termination::Refusal => "refusal",
                    mixdog_agent::response::Termination::Truncated => "truncated",
                    mixdog_agent::response::Termination::Empty => "empty",
                });
                self.completed_reasons = Some((turn.as_str().to_owned(), result.stop_reason.clone(), termination.map(str::to_owned)));
            }
            let (phase, detail) = match outcome {
                RunOutcome::Completed(_) => (RunPhase::Completed, None),
                RunOutcome::Interrupted => (RunPhase::Interrupted, None),
                // The record is read back, forked and restored, and its error is the one `turn/completed` carries: its
                // message is masked as the failure record's `errorDetails` is (`safeErrorDetails`, `turn-failure.mjs`).
                RunOutcome::Failed(mut error) => {
                    error.message = mixdog_ai::service::error_text::safe_error_details(&error.message);
                    (RunPhase::Failed, Some(Slot::Inline(serde_json::to_value(&error).expect("protocol types serialize"))))
                }
            };
            let completed = phase == RunPhase::Completed;
            let record = Record::Run(RunRecord { rid: id(turn.as_str()), phase, attribution: None, attempt: None, end: None, at: Some(at), op: None, detail });
            // The settle's stamps are accepted before the record that ends the turn: Node writes the session record before it
            // reports the turn finished, so a list read after `turn/completed` already shows the stamped activity.
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
                let meta = Record::Meta(MetaRecord { op: None, change: Slot::Inline(HeaderChange { set, ..Default::default() }) });
                self.coverage = Some(self.accept_record_entry(meta, Class::Control, Display::None, Vec::new(), Vec::new()));
            } else {
                // A cancelled or failed turn is finalized too: `session.turnCoverage = turnCheckpointToken`
                // (`ask-turn-failure.mjs:185`), and nothing else of the settle's stamps.
                let mut set = serde_json::Map::new();
                set.insert("turnCoverage".into(), json!(turn.as_str()));
                // A cancelled turn is finalized through the close snapshot (`finalizeCancelledTurn` ->
                // `prepareCloseSnapshot`, `ask-turn-failure.mjs:129`), which stamps the record's activity
                // (`ask-turn-state.mjs:256-257`): a Stopped thread's row has `activityAt` = `updatedAt`.
                if phase == RunPhase::Interrupted {
                    set.insert("updatedAt".into(), json!(at));
                    set.insert("lastUsedAt".into(), json!(at));
                }
                let meta = Record::Meta(MetaRecord { op: None, change: Slot::Inline(HeaderChange { set, ..Default::default() }) });
                self.coverage = Some(self.accept_record_entry(meta, Class::Control, Display::None, Vec::new(), Vec::new()));
            }
            // `clearTurnCheckpoint` once the terminal save landed: the draft goes with nothing left to recover. Until it goes,
            // a value marked meanwhile is taken out of it, as while the run streamed.
            if slot.journal.written() {
                let marks = std::mem::replace(&mut slot._marks, Box::new(()));
                self.ended_drafts.insert(turn.as_str().to_owned(), (std::mem::take(&mut slot.journal), marks));
            }
            let mut effects = Vec::new();
            if completed {
                effects.push(Effect::ItemAck(self.ingest_when_durable()));
            }
            self.accept_record(record, Class::Control, Display::None, Vec::new(), effects);
            self.remove_draft_when_durable(turn.as_str(), None);
        }
        // The stopped run's close (its end, the hand-back's rewind) is accepted: the Stop's owed outcome progresses behind it. A run
        // whose output committed before it ended hands nothing back after all.
        if let Some(sid) = slot.stop.take() {
            if reclaimed.is_some() {
                self.stop_rewound(&sid);
            } else {
                self.stop_unowed(&sid);
            }
        }
        if self.deleting {
            self.delete_turn_ended();
        }
        self.run_deferred_prune();
        // The queue moves on, and the thread may unload, once the settlement is back
        // (`JobDone::GoalSettled`).
    }

    /// `attachFailedTurnCompletion(session.messages, completion)` (`ask-turn-failure.mjs:176-177`,
    /// `ask-turn-settle.mjs:85-96`): a failed turn's end is recorded on the last message of the conversation, its
    /// tool result, last reply or the prompt itself, as `meta.transcript.completion` (an amend of that row's body), so
    /// a retry finds the failed turn's identity and provenance (`failedTurnMessage`, `cache-warm.mjs:508-527`).
    /// Not for a system message.
    fn amend_last_with(&mut self, last: &ItemRecord, completion: Value) {
        if let Some((record, _)) = Self::amend_transcript(last, "completion", completion) {
            self.accept_record(record, Class::Normal, Display::None, Vec::new(), Vec::new());
        }
    }

    /// The amend that sets `meta.transcript.<key>` on row `last`, and the amended row. `None` for a system message
    /// or a body not held inline.
    pub(super) fn amend_transcript(last: &ItemRecord, key: &str, value: Value) -> Option<(Record, ItemRecord)> {
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
        transcript.as_object_mut().expect("transcript is an object").insert(key.into(), value);
        let amended = ItemRecord { body: Slot::Inline(next.clone()), ..last.clone() };
        let record = Record::Amend(AmendRecord { iid: last.iid.clone(), op: None, refs: last.refs.clone(), body: Slot::Inline(next) });
        Some((record, amended))
    }

    /// A failed turn's close (`failTurn`, `publishTurnClose`, `settleTurn`): the completion is recorded on the last
    /// message (`attachFailedTurnCompletion`, `ask-turn-settle.mjs:84`), the turn's end is stored as a record of the
    /// turn, built from what the run showed (`turnDoneItem`, `turn.mjs:573`), then `beginQuotaSettlement` reads that
    /// end, then the Goal settles (`turn.mjs:644-688`). Both settlements run when the end is released; if its record
    /// cannot be written, no end is shown and only the Goal settles (see [`Self::fail_entry`]). A failure record that
    /// cannot be built (a typed `MalformedFacts`) shows no end and settles no quota; the Goal still settles.
    pub(super) fn close_failed(&mut self, turn: &TurnId, failed: FailedClose<'_>, settle: Value) {
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
        let facts = super::super::failure_record::Facts {
            raw: failed.transcript,
            started_at: failed.started_at,
            now,
            attempt_id: new_id(),
            route: super::super::failure_record::Route { provider: &provider, model: &model },
        };
        // The live end is built on the route the turn started with, the durable completion on the session's route now:
        // a quota stop names `route.provider`/`route.model` (`routeMeta.model` is the display name of the model id).
        let model_name = failed.route_meta.get("model").and_then(Value::as_str).unwrap_or_default();
        let live_route = super::super::failure_record::Route { provider: failed.start_provider, model: model_name };
        let records =
            (super::super::failure_record::failure_record(failed.error, &live_route), super::super::failure_record::failure_record(failed.error, &facts.route));
        let (live_record, record) = match records {
            (Ok(live), Ok(record)) => (live, record),
            (Err(malformed), _) | (_, Err(malformed)) => {
                tracing::error!("the failed turn {} shows no end and settles no quota: {malformed}", turn.as_str());
                return self.settle_goal(settle);
            }
        };
        super::super::failure_record::log_failure("ask-error", self.id.as_str(), turn.as_str(), failed.error, &facts.route);
        // `failTurn` (`turn.mjs:570`): the failure's text is a toast of the transcript's owner, besides the end.
        let detail = live_record.get("detail").and_then(Value::as_str).map(super::super::live_rows::polish_notice_text).unwrap_or_default();
        self.push_toast(&detail, "error", Some("transcript"), Vec::new());
        // A refused start left nothing of the turn in the log: it stores no end, and settles no quota on one.
        if failed.refused {
            return self.settle_goal(settle);
        }
        let row = super::super::live_end::live_end_row(failed.live, &facts, failed.route_meta, "failed", None, &live_record, &new_id());
        // The completion on the last message is what a retry reads; the turn's end is the record written here. The two
        // are one unit: an end is stored only with the completion it stands on.
        self.outbox.begin_unit(false);
        if let Some(last) = failed.last {
            self.amend_last_with(last, super::super::failure_record::failed_completion(&record, &facts));
        }
        let stored = self.store_end(turn, row, vec![Effect::TurnClosed { turn: turn.clone(), settle }]);
        self.outbox.end_unit();
        if let Err(effects) = stored {
            // No end is shown, so no quota settles on it: the Goal still settles, as when the end's record fails.
            for effect in effects {
                if let Effect::TurnClosed { settle, .. } = effect {
                    self.settle_goal(settle);
                }
            }
        }
    }

    /// What a stop that handed the prompt back changes besides the turn's rows (`reclaimInFlightPrompt`): the text leaves
    /// the prompt history, and when another device cancelled, the device that sent the prompt gets it through
    /// `thread/promptRestore` (the canceller's reply never carries it).
    /// `sid`: the Stop that owes the hand-back; `row`: the stopped turn's input row.
    fn apply_reclaim(&mut self, reclaim: &super::super::stop::Reclaim, sid: Option<&str>, row: &mixdog_core_api::ids::ItemId) {
        if reclaim.text.is_empty() {
            return;
        }
        self.accept_view(Change::PromptWithout(reclaim.text.clone()), Vec::new());
        // The prompt's row, and every row after it, leave the transcript (`reclaimInFlightPrompt` removes the turn's prompt),
        // by the thread's own rewind as `PromptRewound` does, at the turn's own input row (a crash recovery finishes the same one).
        self.rewind_row(row.as_str());
        // Another device's prompt is published in the session state for it, under the id and `at` its Stop's record stores.
        if let Some(device) = &reclaim.handoff {
            match sid.and_then(|sid| self.stops.owed(sid)).map(|owed| owed.restore.clone()) {
                Some(restore) => self.show_restore(&restore),
                None => {
                    let restore = prompt_restore(reclaim.ids.clone(), reclaim.text.clone(), device.clone(), self.deps.clock.now_ms());
                    self.accept_view(Change::Section(Section::PromptRestore(Some(restore))), Vec::new());
                }
            }
        }
    }

    /// A finished or stopped turn's close (`publishTurnClose`): the turn's end is stored as a record of the turn, built
    /// from what the run showed (`turnDoneItem`, `turn.mjs:573`), unless a turn that finished normally did nothing
    /// (`isNoOpTurn`). No message of the turn shows an end of its own, live or read back
    /// ([`Self::submit_encode`]): this record is the turn's one end. A `done` end takes the verb its reply's completion records
    /// (`pickDoneVerb`, stamped when the reply committed), else the turn's own; a `cancelled` end has no reply.
    /// `reclaimed` (the stopped turn's prompt handed back to the composer, `abort.mjs:65`) suppresses the end, as in Node.
    pub(super) fn close_done(&mut self, turn: &TurnId, done: DoneClose<'_>) {
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
        let facts = super::super::failure_record::Facts {
            raw: &raw,
            started_at: done.started_at,
            now,
            attempt_id: new_id(),
            route: super::super::failure_record::Route { provider: "", model: "" },
        };
        let mut row = super::super::live_end::live_end_row(
            done.live,
            &facts,
            done.route_meta,
            done.status,
            reply.as_ref().map(|(id, _)| id.as_str()),
            &serde_json::Map::new(),
            &new_id(),
        );
        // A turn the user's message took over says so on its end, live and read back alike, whatever its input row shows.
        if done.interrupt_end == Some(InterruptEnd::Message) {
            row.insert("cause".into(), json!(MESSAGE_CAUSE));
        }
        let _ = self.store_end(turn, row, Vec::new());
    }

    /// Today's `terminalSave.then(() => ingestSessionTurn(session))`: once the completed turn's
    /// terminal record is durable, its model context goes to the session-search copy. A failed
    /// save ingests nothing.
    pub(super) fn ingest_when_durable(&self) -> oneshot::Sender<Result<(), RunError>> {
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
                search.ingest_turn(&context.thread, &header, super::super::search_backfill::search_messages(rows));
            }
        });
        tx
    }

    /// What `hasResumeInput` and `scheduleQuotaResume` read of the session now; the transcript
    /// is the shown one (rows show once durable).
    pub(super) fn resume_check(&self) -> super::super::quota_lane::ResumeCheck {
        let route = |key: &str| self.projected.header.get(key).and_then(Value::as_str).unwrap_or_default().to_owned();
        super::super::quota_lane::ResumeCheck {
            session_id: self.id.as_str().to_owned(),
            items: super::super::quota_lane::transcript_rows(self.acked.window.iter().map(|row| row.item.as_ref())),
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
}
