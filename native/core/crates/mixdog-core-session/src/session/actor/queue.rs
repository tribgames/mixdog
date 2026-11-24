//! The input queue: ordering, drain passes, wake batches, delivery and hand-back.

use super::*;

impl SessionActor {
    /// `prioritizeQueued` (`session-flow/queue.mjs`): the queued prompt goes to the front of the queue at
    /// priority `now`, then a drain is kicked (`kickDrain`: an idle thread starts it, a busy one takes it when
    /// its turn settles). An entry no longer queued is left alone.
    pub(super) fn prioritize(&mut self, qid: &QueuedId) {
        let Some(queued) = self.projected.queue.iter().find(|q| q.qid == qid.as_str() && super::super::control::is_prioritizable_entry(&q.entry)) else {
            return;
        };
        let mut entry = queued.entry.clone();
        entry["priority"] = json!("now");
        let record =
            Record::Queue(QueueRecord { qid: id(qid.as_str()), action: QueueAction::Prioritize, reason: None, op: None, entry: Some(Slot::Inline(entry)) });
        self.accept_record(record, Class::Control, Display::None, Vec::new(), Vec::new());
        self.start_next_queued();
    }

    /// The next queued entry becomes a run (P X9: busy → queued, follow-ups run in order).
    ///
    /// A completion no turn took is a wake of its own, oldest first, with the completion as the
    /// turn's input, never an empty user turn (`notification-bus.mjs:69-76` replays a wake
    /// suppressed while one was in flight; `ask-queue.mjs:87-101` runs each notification as its
    /// own turn). Without wakes, completions wait for the next turn to take them.
    pub(super) fn start_next_queued(&mut self) {
        // The outermost pass collects what it (and the passes a refusal runs inside it) hands back, against the queue's order
        // as it starts, and publishes it once ([`Self::hand_back_all`]).
        let outermost = self.drain_handbacks.is_none();
        if outermost {
            self.drain_handbacks = Some((self.projected.queue.iter().map(|q| q.qid.clone()).collect(), Vec::new()));
        }
        self.drain_pass();
        if outermost
            && let Some((order, mut handbacks)) = self.drain_handbacks.take()
            && !handbacks.is_empty()
        {
            handbacks.sort_by_key(|entry| order.iter().position(|qid| *qid == entry.qid));
            self.publish_handback(&handbacks);
        }
        // The pass decided and registered any next start: the fence a test waits on before it shows that nothing started.
        #[cfg(any(test, feature = "test-support"))]
        {
            self.cell.drain_passes.fetch_add(1, SeqCst);
            self.ledger("drain:decided".to_owned());
        }
    }

    pub(super) fn drain_pass(&mut self) {
        if self.turn_busy() || self.deleting {
            // A turn's end drains the queue itself; a Project move's end does not, so a drain asked for while one is carried
            // out (a reopened session's resume) is owed when it ends.
            self.drain_held |= self.carrying();
            return;
        }
        // Nothing is dequeued while starts are held: the drain goes on once they are not (an unsaved turn's records
        // are written again first).
        if self.drain_gated() {
            #[cfg(any(test, feature = "test-support"))]
            if !self.projected.queue.is_empty() {
                self.cell.gate_holds.fetch_add(1, SeqCst);
            }
            self.drain_held = true;
            self.retry_due |= self.outbox.has_unsaved();
            return;
        }
        #[cfg(test)]
        if let Some(retry) = self.cell.stop_latches.planted_retry(&self.id) {
            self.pending_retry = Some(retry);
        }
        // The message of an accepted takeover is the next turn: a failed turn's retry that was already pending follows it.
        if self.reserved_successor().is_none()
            && let Some(retry) = self.pending_retry.take()
        {
            return self.begin_retry(retry);
        }
        // A queued copy of work a user Stop froze is never taken (its Stop record removed it; one whose save failed is still
        // ineligible here).
        let Some(next) = self.next_queued() else {
            // Nothing is left for the model: a queued slash command is the post-turn command processor's (`steering.mjs`), which
            // runs in the composer that sent it, so it goes back there as a hand-back instead of waiting in the queue for good.
            // The session state holds one hand-back, so every command goes back in that one, none overwriting another.
            let commands: Vec<super::super::state::Queued> =
                self.projected.queue.iter().filter(|q| !self.queued_stopped(q) && pending::is_slash_entry(&q.entry)).cloned().collect();
            if !commands.is_empty() {
                self.hand_back_all(&commands);
            }
            // A user's `/compact` asked mid-turn runs now: the turn and every queued follow-up are done, no command holds the
            // session and its visible queue is empty (`scheduleCompactForTurnEnd`'s check). It runs as the command does
            // (`compactCommand`: `runtime.compact({ recoverAgent: true })`).
            if self.manual_compact_due && !self.ui_busy() && self.compactions == 0 && self.projected.queued_rows().is_empty() {
                self.manual_compact_due = false;
                // Nobody waits on the answer: the request was answered when it was scheduled.
                let (tx, _answered) = oneshot::channel();
                self.compact_start(None, tx, Some(json!({ "recoverAgent": true })), true);
            }
            return;
        };
        if completions::is_notification(&next.entry) {
            // A wake drains the queued completions of the selected priority as one batch in one turn (`drain.mjs` `presentBatch`,
            // `dequeueQueueBatch`), so one Stop ends them all.
            let batch = self.next_wake_batch(&next);
            self.start_completion(batch);
            return;
        }
        // A user prompt that cannot be delivered is handed back, never recorded as delivered; the next entry is tried.
        let goal = super::super::goal_lane::is_goal_entry(&next.entry);
        let delivered = if goal { Ok(next.entry.clone()) } else { self.deliverable_entry(&next.entry) };
        let entry = match delivered {
            Ok(entry) => entry,
            Err(why) => {
                self.refuse_queued(&next.qid, &next.entry, &why);
                return self.start_next_queued();
            }
        };
        let dequeued = self.accept_record_entry(dequeue(&next.qid), Class::Control, Display::None, Vec::new(), Vec::new());
        // An automatic Goal turn runs only if `shouldRunGoalContinuation` still agrees; a dropped
        // entry stays dropped (`drain.mjs`).
        if goal {
            self.check_goal_entry(next.entry);
            return;
        }
        let next = super::super::state::Queued { entry, ..next };
        let mut input = TurnInput {
            prompt: serde_json::from_value(next.entry["message"].clone()).unwrap_or(PromptContent::Text(String::new())),
            options: serde_json::from_value(next.entry["options"].clone()).ok(),
        };
        // The queued follow-up's own `context` (`drain.mjs` `turnOptionsForBatch`) rides its turn: the entry holds it beside the options.
        if let Some(context) = next.entry.get("context").and_then(Value::as_str) {
            input.options.get_or_insert_with(Default::default).context = Some(context.to_owned());
        }
        // The entry keeps the submission as it was sent; the message drops the originals its acceptance found missing.
        let originals_missing = super::super::staged_originals::drop_missing(&mut input, &super::super::staged_originals::missing_of(&next.entry));
        // A prompt a user queued is still the composer's to take back (`restorable`), from the device that sent it.
        self.submitter = next.entry.get("restorable").and_then(Value::as_bool).map(|restorable| Submitter {
            device: next.entry.pointer("/transcriptMeta/device").and_then(Value::as_str).unwrap_or_default().to_owned(),
            restorable,
        });
        // The drained entry's `transcriptMeta` starts the turn (`beginTurn`): a bot's message keeps its sender and chain when the
        // process that queued it (and its in-memory start) is gone.
        let mut body = self.deps.transcript.user_message(&input, originals_missing);
        if let Some(meta) = pending::steered_meta(&next.entry) {
            for key in ["sender", "fromAgent", "hop", "botChain", "roomRow"] {
                if let Some(value) = meta.get(key) {
                    body["meta"]["transcript"][key] = value.clone();
                }
            }
        }
        // The queue a client sees loses the prompt in the revision that shows its row and its turn (`presentBatch` and `runTurn`
        // in one chain, `drain.mjs`); the projected queue, which the session decides on, lost it now.
        self.outbox.pair(dequeued);
        // The entry's identity is its queue id, allocated when it was queued; it keeps the submission it answers.
        let submissions =
            next.entry.pointer("/options/clientSubmissionId").and_then(Value::as_str).filter(|id| !id.is_empty()).map(str::to_owned).into_iter().collect();
        let work = self.work_of(next.qid.clone(), vec![next.qid.clone()], submissions, &input, false);
        self.start_run_with(DeferredStart { input, body, op_ref: None, reply: None, prompt: None, wake: false, retried: false, work });
    }

    /// The entry the drain takes next: the most urgent, the earliest of its priority (`dequeueQueueBatch`). A slash command is the
    /// command dispatcher's, never the model's (`dequeueModelBatch`); a queued copy of work a user Stop froze is never taken (its
    /// Stop record removed it; one whose save failed is still ineligible here); a completion waits for a wake the session allows.
    fn next_queued(&self) -> Option<super::super::state::Queued> {
        let wake = self.completion_wake();
        self.projected
            .queue
            .iter()
            .filter(|q| !self.queued_stopped(q) && !pending::is_slash_entry(&q.entry))
            .filter(|q| wake || completions::is_channel(&q.entry) || !completions::is_notification(&q.entry))
            .min_by_key(|q| priority_rank(&q.entry))
            .cloned()
    }

    /// The queued completions the wake of `next` (a notification the drain selected) takes as one batch: each of its priority
    /// (`dequeueQueueBatch` takes one priority bucket; a less urgent notice waits for the work ahead of it).
    fn next_wake_batch(&self, next: &super::super::state::Queued) -> Vec<super::super::state::Queued> {
        let (wake, rank) = (self.completion_wake(), priority_rank(&next.entry));
        self.projected
            .queue
            .iter()
            .filter(|q| {
                completions::is_notification(&q.entry)
                    && priority_rank(&q.entry) == rank
                    && (wake || completions::is_channel(&q.entry))
                    && !self.queued_stopped(q)
            })
            .cloned()
            .collect()
    }

    /// The batch of the completion wake the drain would start next, empty when it would start none (it takes a prompt next,
    /// or nothing).
    pub(super) fn impending_wake_batch(&self) -> Vec<super::super::state::Queued> {
        match self.next_queued() {
            Some(next) if completions::is_notification(&next.entry) => self.next_wake_batch(&next),
            _ => Vec::new(),
        }
    }

    /// The queued completions as one turn's input row, stored as a task notification ([`completions::batch_row`]).
    fn start_completion(&mut self, batch: Vec<super::super::state::Queued>) {
        let mut paired = false;
        for next in &batch {
            let dequeued = self.accept_record_entry(dequeue(&next.qid), Class::Control, Display::None, Vec::new(), Vec::new());
            if !std::mem::replace(&mut paired, true) {
                self.outbox.pair(dequeued);
            }
        }
        // A channel notice that is no completion is a user injection too (`isStaleUserInjection`).
        let entries: Vec<Value> = batch.iter().map(|next| self.late_delivery(&next.entry)).collect();
        for entry in &entries {
            if let Some(execution) = suppressed_execution(entry) {
                self.suppressed.insert(execution);
            }
        }
        let row = completions::batch_row(&entries);
        let input = TurnInput { prompt: PromptContent::Text(row["content"].as_str().unwrap_or_default().to_owned()), options: None };
        // The batch is one work: named by its first completion, and recreatable through every original completion queue id.
        let qids: Vec<String> = batch.iter().map(|next| next.qid.clone()).collect();
        let work = WorkRef { id: qids.first().cloned().unwrap_or_else(new_id), qids, submissions: Vec::new(), handback: None };
        self.start_run_with(DeferredStart { input, body: row, op_ref: None, reply: None, prompt: None, wake: true, retried: false, work });
    }

    /// The queued entry as it is delivered: one that waited more than thirty minutes since before this process owned
    /// sessions carries Node's late-delivery header (`hydratePendingMessages`, `pending-messages.mjs`).
    pub(super) fn late_delivery(&self, entry: &Value) -> Value {
        let now = self.deps.clock.now_ms();
        pending::late_delivery(entry, now, pending::owner_started_ms(now))
    }

    /// [`Self::late_delivery`] with the prompt held to the one rule for what a model message may carry
    /// ([`super::super::prompt_submission::deliverable`]): every delivery of a queue entry, restored or fresh, passes here.
    pub(super) fn deliverable_entry(&self, entry: &Value) -> Result<Value, String> {
        let mut entry = self.late_delivery(entry);
        if let Some(message) = entry.get("message") {
            entry["message"] = super::super::prompt_submission::deliverable(message)?;
        }
        Ok(entry)
    }

    /// A queued prompt that cannot be delivered leaves the queue as cancelled, not delivered, and goes back to its
    /// composer as a hand-back does (`PromptRestore`).
    pub(super) fn refuse_queued(&mut self, qid: &str, entry: &Value, why: &str) {
        tracing::warn!(thread = %self.id, queued = qid, "a queued prompt was handed back undelivered: {why}");
        self.hand_back_all(&[super::super::state::Queued { qid: qid.to_owned(), entry: entry.clone(), display: Value::Null }]);
    }

    /// The queued entries leave the queue as cancelled, not delivered, and return to their composer in one hand-back
    /// (`PromptRestore`, as `restoreQueued` returns several): the session state holds one, so a hand-back per entry would leave
    /// only the last recoverable by a composer that had not rendered the others. Inside a drain the entries are collected
    /// ([`Self::start_next_queued`]) and every one the drain hands back, refused prompts and slash commands alike, goes out
    /// in one hand-back at its end, in queue order.
    ///
    /// Two limits stand, as the single slot and the composers' own bookkeeping leave them (lifting either needs a list of
    /// hand-backs or a composer's acknowledgment, a protocol change):
    /// - A hand-back of a later drain (or turn boundary) replaces this one in the slot, even when a composer has not
    ///   rendered it yet.
    /// - The hand-back names every entry's submission, so each composer that sent one of them takes it whole: two devices
    ///   each get every text in it (nothing is lost, but each sees the other's).
    pub(super) fn hand_back_all(&mut self, queued: &[super::super::state::Queued]) {
        for entry in queued {
            let record =
                Record::Queue(QueueRecord { qid: id(&entry.qid), action: QueueAction::Dequeue, reason: Some(DequeueReason::Cancelled), op: None, entry: None });
            self.accept_record(record, Class::Control, Display::None, Vec::new(), Vec::new());
        }
        if let Some((_, collected)) = self.drain_handbacks.as_mut() {
            collected.extend(queued.iter().cloned());
            return;
        }
        self.publish_handback(queued);
    }

    /// The one `PromptRestore` of `queued`: their submissions, and their texts in the order given.
    fn publish_handback(&mut self, queued: &[super::super::state::Queued]) {
        let present = |text: &String| !mixdog_js::js_trim(text).is_empty();
        let text = queued.iter().map(|entry| Taken::of(entry).text).filter(present).collect::<Vec<_>>().join("\n");
        let device = queued
            .iter()
            .find_map(|entry| entry.entry.pointer("/transcriptMeta/device").and_then(Value::as_str).filter(|device| !device.is_empty()))
            .unwrap_or_default()
            .to_owned();
        let restore = prompt_restore(submissions_of(queued), text, device, self.deps.clock.now_ms());
        self.accept_view(Change::Section(Section::PromptRestore(Some(restore))), Vec::new());
    }

    /// The send `req` of submission `id`, which the actor has no receipt of: the store's submission index is read (once it
    /// holds every barrier acked so far) before the inbox is taken again, and the send answered from it or admitted.
    pub(super) fn look_up_submission(&mut self, id: String, req: CoreRequest, tx: Waiter) {
        self.submission_lookup = Some(req.params.clone());
        let (store, thread, jobs) = (self.deps.store.clone(), self.id.clone(), self.jobs_tx.clone());
        let lookup = id.clone();
        mixdog_core_base::support::lane_job(
            self.deps.lanes.io,
            "submission-receipt",
            // Never cancelled: the send waits on this answer, and the actor holds its inbox until it comes.
            &CancellationToken::new(),
            move |lane| store.submission(lane, &thread, &lookup),
            move |found| {
                let _ = jobs.send(JobDone::SubmissionLooked { id, req, tx, found: found.and_then(|found| found) });
            },
        );
    }
}
