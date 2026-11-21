//! Goal lane: goal calls, entries, warnings, closeout, continuation and quota settlement.

use super::*;

impl SessionActor {
    /// Runs a Goal runtime call after every earlier one of this thread (Node awaits each in
    /// turn order); its answer comes back as a job.
    pub(super) fn goal_call(&mut self, call: futures::future::BoxFuture<'static, JobDone>) {
        let jobs = self.jobs_tx.clone();
        let tail = self.goal_tail.take();
        self.goal_tail = Some(tokio::spawn(async move {
            if let Some(tail) = tail {
                let _ = tail.await;
            }
            let _ = jobs.send(call.await);
        }));
    }

    /// `publishGoal(raw)`: the lane changes only when the visible Goal does.
    pub(super) fn publish_goal(&mut self, raw: Option<Goal>) -> Option<Goal> {
        let goal = super::super::goal_lane::visible_goal(raw.as_ref(), &self.goal_suppressed);
        let value = goal.clone().map(Value::Object);
        if self.projected.sections.goal != value {
            self.accept_view(Change::Section(Section::Goal(value)), Vec::new());
        }
        goal
    }

    /// `refreshGoalState`: the lane reads the runtime's visible Goal.
    pub(super) fn refresh_goal(&mut self) {
        let (goals, thread) = (self.deps.goals.clone(), self.id.clone());
        self.goal_call(Box::pin(async move { JobDone::GoalSeen(goals.goal_status(&thread).await.ok()) }));
    }

    /// `cancelQueuedGoalContinuations({ keepCloseoutFor })`: the queued Goal entries leave the
    /// queue, except the closeout of `keep` (a Goal that reached its duration), which stays with
    /// that Goal's text now. How many went.
    pub(super) fn cancel_goal_entries(&mut self, keep: Option<&Goal>) -> usize {
        let queued: Vec<(String, Value)> =
            self.projected.queue.iter().filter(|q| super::super::goal_lane::is_goal_entry(&q.entry)).map(|q| (q.qid.clone(), q.entry.clone())).collect();
        let mut removed = 0;
        for (qid, entry) in queued {
            if let Some(text) = super::super::goal_lane::kept_closeout_text(&entry, keep) {
                if entry.get("message").and_then(Value::as_str) != Some(text.as_str()) {
                    // `entry.content = goalDeadlineReached(..)`: the entry takes the text where
                    // it stands.
                    let mut entry = entry;
                    entry["message"] = Value::String(text);
                    let record =
                        Record::Queue(QueueRecord { qid: id(&qid), action: QueueAction::Update, reason: None, op: None, entry: Some(Slot::Inline(entry)) });
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
        let record = Record::Queue(QueueRecord { qid: id(&new_id()), action: QueueAction::Enqueue, reason: None, op: None, entry: Some(Slot::Inline(entry)) });
        self.accept_record(record, Class::Normal, Display::None, Vec::new(), Vec::new());
    }

    /// `onGoalChanged`: the lane shows the new Goal, queued automatic work for the old one goes,
    /// the deadline notices are delivered, and an active Goal continues once the thread is idle.
    pub(super) fn goal_changed(&mut self, raw: Option<Goal>) {
        let visible = super::super::goal_lane::visible_goal(raw.as_ref(), &self.goal_suppressed);
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
            let entry = super::super::goal_lane::warning_entry(&text, goal, self.deps.clock.now_ms());
            self.enqueue_goal_entry(entry);
        } else {
            self.mark_goal_reminder("deadline-soon");
        }
    }

    /// `markGoalReminder(reason)` (`goal-facade-api.mjs`): the session's pending Goal reminder
    /// (`markPendingGoalReminder`: one more revision, the next turn's tail carries it), then the
    /// next continuation carries the full rules again.
    pub(super) fn mark_goal_reminder(&mut self, reason: &str) {
        let change = super::super::goal_reminder::mark(&self.projected.header, reason, self.deps.clock.now_ms());
        let meta = Record::Meta(MetaRecord { op: None, change: Slot::Inline(change) });
        self.accept_record(meta, Class::Normal, Display::None, Vec::new(), Vec::new());
        super::super::goal_lane::mark_goal_reminder(&*self.deps.goals, &self.id);
    }

    /// `deliverGoalCloseout`: the Goal reached its duration; the running turn closes it out.
    fn deliver_goal_closeout(&mut self, timed: Option<&Goal>) {
        if self.deleting || self.cell.closed.load(SeqCst) {
            return;
        }
        let Some(goal) = timed else { return };
        let busy = self.ui_busy();
        let queue: Vec<&Value> = self.projected.queue.iter().map(|q| &q.entry).collect();
        match super::super::goal_lane::closeout(goal, busy, &queue, self.deps.clock.now_ms()) {
            super::super::goal_lane::Closeout::Remind => self.mark_goal_reminder("deadline-reached"),
            super::super::goal_lane::Closeout::Enqueue(entry) => {
                self.enqueue_goal_entry(entry);
                self.start_next_queued();
            }
        }
    }

    /// `goalControl`: the answer, then what the session API does after a pause or stop (queued
    /// automatic work goes, the running turn is cancelled) and the lane reads the Goal again.
    pub(super) fn goal_controlled(&mut self, op: Option<OpId>, tx: Waiter, result: Result<Value, mixdog_core_goal::goal::GoalError>) {
        let value = match result {
            Ok(value) => value,
            Err(error) => {
                let error = super::super::goal_lane::failure(&error);
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
    pub(super) fn schedule_goal_continuation(&mut self) {
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
        let end = DecisionEnd(Some(self.jobs_tx.clone()));
        self.goal_call(Box::pin(async move {
            let mut end = end;
            #[cfg(any(test, feature = "test-support"))]
            if let Some(fault) = super::super::goal_lane::decision_hold(thread.as_str()).await {
                match fault {
                    super::super::goal_lane::DecisionFault::Fail => {
                        end.0 = None;
                        return JobDone::GoalDecision(None);
                    }
                    super::super::goal_lane::DecisionFault::Panic => panic!("the test's injected panic in a continuation decision"),
                }
            }
            let input = super::super::goal_lane::continuation_input(&*deps.todos, &*deps.work, &thread).await;
            let decision = deps.goals.continuation(&thread, input).await.ok();
            end.0 = None;
            JobDone::GoalDecision(decision)
        }));
    }

    /// Idle with nothing queued: queued user work runs first, and a queued Goal entry already
    /// carries the next continuation.
    fn goal_idle(&self) -> bool {
        !self.turn_busy() && self.projected.queue.is_empty() && !self.deleting && !self.tombstoned && !self.cell.closed.load(SeqCst)
    }

    /// The continuation decision: an active Goal's prompt is queued as the next turn. A decision that queues none is no busy
    /// change (Node decides inside `scheduleGoalContinuation`'s `setImmediate`): the idle clock is left as it is.
    pub(super) fn goal_decision(&mut self, decision: Option<mixdog_core_goal::goal::Continuation>) {
        self.goal_scheduled = false;
        let Some(decision) = decision else { return };
        self.publish_goal(decision.goal.clone());
        let prompt = decision.prompt.as_deref().map(mixdog_js::js_trim).unwrap_or_default();
        if !decision.run || prompt.is_empty() || !self.goal_idle() {
            return;
        }
        let entry =
            super::super::goal_lane::continuation_entry(decision.prompt.as_deref().unwrap_or_default(), decision.goal.as_ref(), self.deps.clock.now_ms());
        self.enqueue_goal_entry(entry);
        self.start_next_queued();
    }

    /// `archiveCompletedGoalOnUserInput`: a genuine user prompt drops queued automatic work and
    /// retires a finished Goal, masked from the lane until the archive lands.
    pub(super) fn archive_goal_on_user_input(&mut self) {
        let removed = self.cancel_goal_entries(None);
        let reached = self.projected.sections.goal.as_ref().and_then(|g| g.get("status")).and_then(Value::as_str) == Some("duration_reached");
        if removed > 0 && reached {
            self.mark_goal_reminder("deadline-reached");
        }
        let archived = super::super::goal_lane::archived_goal_id(self.projected.sections.goal.as_ref());
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

    /// `shouldRunGoalContinuation(entry)` for a dequeued Goal entry: a closeout reads the
    /// runtime's Goal, a continuation the runtime's decision; the answer comes back as a job.
    pub(super) fn check_goal_entry(&mut self, entry: Value) {
        if self.deleting || self.cell.closed.load(SeqCst) {
            return;
        }
        self.goal_checking = true;
        let (deps, thread) = (self.deps.clone(), self.id.clone());
        let closeout = super::super::goal_lane::is_closeout(&entry);
        // The check is the busy session's running work, which a confirmed stop's abort cancels (Node's forced `shutdown` aborts every
        // busy session): an aborted check reads as none, and its entry is dropped.
        let token = mixdog_rt::CancellationToken::new();
        let core_abort = self.hold_core().run(&token);
        self.goal_call(Box::pin(async move {
            let _core_abort = core_abort;
            let check = async {
                if closeout {
                    deps.goals.goal_status(&thread).await.ok().map(GoalCheck::Status)
                } else {
                    let input = super::super::goal_lane::continuation_input(&*deps.todos, &*deps.work, &thread).await;
                    deps.goals.continuation(&thread, input).await.ok().map(GoalCheck::Decision)
                }
            };
            let seen = tokio::select! {
                () = token.cancelled() => None,
                seen = check => seen,
            };
            JobDone::GoalEntryChecked { entry, seen }
        }));
    }

    /// The check is back: the lane shows the Goal it read; the entry runs as an automatic Goal
    /// turn, or is dropped and the queue moves on.
    pub(super) fn goal_entry_checked(&mut self, entry: Value, seen: Option<GoalCheck>) {
        self.goal_checking = false;
        let deferred = std::mem::take(&mut self.goal_deferred);
        if self.deleting || self.cell.closed.load(SeqCst) {
            return;
        }
        let run = match seen {
            None => false,
            Some(GoalCheck::Status(raw)) => {
                let goal = self.publish_goal(raw);
                super::super::goal_lane::closeout_still_due(&entry, goal.as_ref())
            }
            Some(GoalCheck::Decision(decision)) => {
                self.publish_goal(decision.goal.clone());
                super::super::goal_lane::continuation_still_due(&entry, &decision)
            }
        };
        if run {
            // Its prompt is runtime-synthetic, shown as no user row.
            let input = TurnInput { prompt: PromptContent::Text(completions::text(&entry)), options: None };
            let work = WorkRef { id: new_id(), ..Default::default() };
            self.start_run_with(DeferredStart {
                input,
                body: super::super::goal_lane::input_row(&entry),
                op_ref: None,
                reply: None,
                prompt: None,
                wake: false,
                retried: false,
                work,
            });
            return;
        }
        self.start_next_queued();
        if deferred {
            self.schedule_goal_continuation();
        }
        self.try_unload();
    }

    /// `canDeliverSteeringEntry`'s reads for the Goal entries a drain would take: the runtime's
    /// answer for each, then the drain goes on.
    pub(super) fn check_steer_goals(
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
                let read = if super::super::goal_lane::is_closeout(&entry) {
                    deps.goals.goal_status(&thread).await.ok().map(GoalCheck::Status)
                } else {
                    let input = super::super::goal_lane::continuation_input(&*deps.todos, &*deps.work, &thread).await;
                    deps.goals.continuation(&thread, input).await.ok().map(GoalCheck::Decision)
                };
                seen.push((qid, entry, read));
            }
            JobDone::SteerGoalsChecked { turn, request, reply, checked, seen }
        }));
    }

    /// The runtime's answer for a Goal entry: whether it is still due (`shouldRunGoalContinuation`).
    /// The lane shows the Goal it read.
    pub(super) fn goal_due(&mut self, entry: &Value, seen: Option<GoalCheck>) -> bool {
        match seen {
            None => false,
            Some(GoalCheck::Status(raw)) => {
                let goal = self.publish_goal(raw);
                super::super::goal_lane::closeout_still_due(entry, goal.as_ref())
            }
            Some(GoalCheck::Decision(decision)) => {
                self.publish_goal(decision.goal.clone());
                super::super::goal_lane::continuation_still_due(entry, &decision)
            }
        }
    }

    /// `onGoalTurnSettled` (`turnOutcome`): the Goal runtime closes the turn's clock segment and reads its
    /// outcome; the next queued entry waits for the answer.
    pub(super) fn settle_goal(&mut self, settle: Value) {
        let (goals, thread) = (self.deps.goals.clone(), self.id.clone());
        self.goal_call(Box::pin(async move { JobDone::GoalSettled(goals.turn_settled(&thread, settle).await.ok()) }));
    }

    /// `beginQuotaSettlement` at the close of a turn that failed on quota (`turn.failed &&
    /// turn.quota`: its failed turn end, the latest, carries the quota stop), run when that end is
    /// released (`Effect::TurnClosed`): the settlement window opens, and with a known reset and the
    /// setting on the resume is queued, or the session hears that nothing can be resumed.
    pub(super) fn begin_quota_settlement(&mut self, turn: &TurnId) {
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
    pub(super) fn finish_quota_settlement(&mut self, settled: Option<&Goal>) {
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
}
