//! The turn operations the actor serves itself (`session/turn_ops.rs`): what reads the busy
//! state or the live rows only the actor owns.

use super::*;

/// The scheduler's answer channel for a fire (`ResumeHost::fire`).
type FireReply = oneshot::Sender<Result<super::super::quota_resume_scheduler::FireOutcome, String>>;

use super::super::quota_lane::failure_text as error_text;

impl SessionActor {
    /// Routes one of [`super::super::turn_ops::is_actor_method`].
    pub(super) fn turn_op(&mut self, req: CoreRequest, tx: Waiter) -> Result<(), (CoreError, Waiter)> {
        let done = match req.method.as_str() {
            "thread/pushNotice" => self.push_notice(&req),
            "thread/askSide" => {
                let params: mixdog_app_protocol::v2::params::ThreadAskSideParams = match parse(&req.params, "ThreadAskSideParams") {
                    Ok(params) => params,
                    Err(error) => return Err((error, tx)),
                };
                let (side, thread, jobs, op) = (self.deps.side.clone(), self.id.clone(), self.jobs_tx.clone(), req.op.clone());
                tokio::spawn(async move {
                    let result = super::super::turn_ops::ask_side_question(side.as_ref(), &thread, &params.question)
                        .await
                        .map(|text| json!({ "text": text }));
                    let _ = jobs.send(JobDone::Replied { op, tx, result });
                });
                return Ok(());
            }
            // `cancelSide(sessionId)`: the question of the named session, else this one.
            "thread/cancelSide" => {
                let params: mixdog_app_protocol::v2::params::ThreadCancelSideParams = match parse(&req.params, "ThreadCancelSideParams") {
                    Ok(params) => params,
                    Err(error) => return Err((error, tx)),
                };
                self.deps.side.cancel(params.target_thread_id.as_ref().unwrap_or(&self.id));
                Ok(Value::Null)
            }
            "thread/compact/start" => {
                let params: mixdog_app_protocol::v2::thread::ThreadCompactStartParams = match parse(&req.params, "ThreadCompactStartParams") {
                    Ok(params) => params,
                    Err(error) => return Err((error, tx)),
                };
                // `{afterTurn: true}`: the session tool's `compact` (`workspace-tools.mjs:268`) only marks
                // the thread; the turn's completion runs it.
                if params.options.as_ref().and_then(|options| options.get("afterTurn")) == Some(&Value::Bool(true)) {
                    self.pending_compact = true;
                    Ok(Value::Null)
                } else {
                    self.compact_start(req.op.clone(), tx, params.options);
                    return Ok(());
                }
            }
            "turn/retryFailed" => {
                let params: mixdog_app_protocol::v2::thread::TurnRetryFailedParams = match parse(&req.params, "TurnRetryFailedParams") {
                    Ok(params) => params,
                    Err(error) => return Err((error, tx)),
                };
                self.retry_failed(req.op.clone(), tx, params.turn_key);
                return Ok(());
            }
            "thread/clearSessionChangeHistory" => {
                self.clear_change_history(req.op.clone(), tx);
                return Ok(());
            }
            _ => Err(invalid("method", "a session-actor method")),
        };
        match done {
            Ok(value) => {
                self.effect_done(Effect::Reply { op: req.op, tx: Some(tx), value });
                Ok(())
            }
            Err(error) => {
                if let Some(op) = &req.op {
                    self.ops.failed(op, &error);
                }
                Err((error, tx))
            }
        }
    }

    /// A turn operation's answer from its job.
    pub(super) fn replied(&mut self, op: Option<OpId>, tx: Waiter, result: Result<Value, CoreError>) {
        match result {
            Ok(value) => self.effect_done(Effect::Reply { op, tx: Some(tx), value }),
            Err(error) => {
                if let Some(op) = &op {
                    self.ops.failed(op, &error);
                }
                let _ = tx.send(Err(error));
            }
        }
    }

    /// `compact(options)` of the session ops: refused while a turn runs; else the host compacts
    /// (PreCompact behind its savings gate), a skipped result is the answer as it is, and any
    /// other runs PostCompact, re-marks the Goal reminder (`compaction`: the compaction dropped
    /// the Goal's tool results), re-arms the late tool announcements and answers the result.
    pub(super) fn compact_start(&mut self, op: Option<OpId>, tx: Waiter, options: Option<Value>) {
        if self.ui_busy() {
            return self.replied(op, tx, Ok(super::super::turn_ops::compact_in_turn()));
        }
        self.compactions += 1;
        let (trigger, require_reduction) = super::super::turn_ops::compact_trigger(options.as_ref());
        let recover = options.as_ref().and_then(|options| options.get("recoverAgent")) == Some(&Value::Bool(true));
        let (compaction, thread, jobs) = (self.deps.compaction.clone(), self.id.clone(), self.jobs_tx.clone());
        tokio::spawn(async move {
            let result = match compaction.compact(&thread, trigger, require_reduction).await {
                Ok(result) => result.unwrap_or(Value::Null),
                Err(error) => {
                    let _ = jobs.send(JobDone::CompactionEnded);
                    return drop(jobs.send(JobDone::Replied { op, tx, result: Err(error) }));
                }
            };
            if mixdog_core_goal::goal::js::truthy(result.get("skipped")) {
                let _ = jobs.send(JobDone::CompactionEnded);
                return drop(jobs.send(JobDone::Replied { op, tx, result: Ok(result) }));
            }
            compaction.post_compact(&thread, trigger).await;
            let _ = jobs.send(JobDone::Compacted { op, tx, result, recover });
        });
    }

    /// `retryBlocked()`: anything running, settling, closing or queued owns the session first.
    /// Node's flags map as: `disposed` and a closed `admission` to a deleted or unloaded thread,
    /// `settlement` to the quota settlement, `busy` to any turn state, `commandBusy` and
    /// `autoClearRunning` to a running compaction, `draining` to the completions still waiting
    /// for their own turns, `quotaResumePending` to a Goal resume in flight, `pending` to the
    /// queue (`decisions.md`, "turn/retryFailed").
    fn retry_blocked(&self) -> bool {
        self.deleting
            || self.cell.closed.load(SeqCst)
            || self.quota.settlement.settling()
            || self.turn_busy()
            || self.compactions > 0
            || !self.wake_tail.is_empty()
            || !self.projected.queue.is_empty()
    }

    fn failed_turn_items(&self) -> Vec<Value> {
        super::super::quota_lane::transcript_rows(self.acked.window.iter().map(|row| row.item.as_ref()))
    }

    /// `retryFailedTurn(sessionId, turnKey)` of the quota lane, first half: runs only while
    /// `turnKey` is still the latest failed turn and nothing is running, settling or queued;
    /// `false` when refused. `retainedRetryInput()` reads the model context, so the rest runs
    /// when that read is back.
    fn retry_failed(&mut self, op: Option<OpId>, tx: Waiter, key: String) {
        if key.is_empty()
            || self.retry_blocked()
            || super::super::quota_lane::latest_failed_turn_key(&self.failed_turn_items()) != key
            || self.retry_claim == format!("{}\0{key}", self.id.as_str())
        {
            return self.replied(op, tx, Ok(Value::Bool(false)));
        }
        let (check, jobs) = (self.resume_check(), self.jobs_tx.clone());
        tokio::spawn(async move {
            let basis = check.retry_basis().await;
            let _ = jobs.send(JobDone::RetryChecked { op, tx, key, retained: basis.retained, provenance: basis.provenance });
        });
    }

    /// `retryFailedTurn(key)`'s entry: the retained failed message resent as stored (already on
    /// screen), else the prompt the failed turn replays.
    fn retry_turn(retained: Option<super::super::quota_lane::Retained>, prompt: Option<String>, provenance: Option<Value>) -> Result<Option<super::super::quota_lane::RetryTurn>, CoreError> {
        if let Some(retained) = retained {
            let prior = retained.prior();
            let prompt: PromptContent = serde_json::from_value(retained.content)
                .map_err(|_| super::super::turn_ops::failure("The failed message holds content this daemon cannot resend"))?;
            let options = mixdog_protocol::thread::SubmitOptions {
                retry_failed_turn: Some(true),
                retry_turn_id: Some(retained.message_id),
                retry_attempt_id: retained.attempt_id,
                ..Default::default()
            };
            return Ok(Some(super::super::quota_lane::RetryTurn { input: TurnInput { prompt, options: Some(options) }, hidden: true, provenance, prior: Some(prior) }));
        }
        Ok(prompt.map(|prompt| {
            let options = mixdog_protocol::thread::SubmitOptions {
                display_text: Some(prompt.clone()),
                retry_failed_turn: Some(true),
                ..Default::default()
            };
            super::super::quota_lane::RetryTurn { input: TurnInput { prompt: PromptContent::Text(prompt), options: Some(options) }, hidden: false, provenance, prior: None }
        }))
    }

    fn begin_retry(&mut self, retry: super::super::quota_lane::RetryTurn) {
        self.retry_hidden = retry.hidden;
        self.retry_provenance = Some(retry.provenance);
        self.retry_prior = retry.prior;
        self.start_run(retry.input, None, None, None);
    }

    /// The rest of `retryFailedTurn`: the claim, then either the retry turn starts at once (and
    /// the resume entry it answered is finished) or a suspended Goal is revived first.
    pub(super) fn retry_checked(&mut self, op: Option<OpId>, tx: Waiter, key: String, retained: Option<super::super::quota_lane::Retained>, provenance: Option<Value>) {
        let items = self.failed_turn_items();
        let goal_id = self.deps.quota.goals.suspended(self.id.as_str(), &key);
        let prompt = mixdog_core_goal::quota_settlement::failed_turn_retry_prompt(&items, &key);
        if self.retry_blocked()
            || super::super::quota_lane::latest_failed_turn_key(&items) != key
            || (retained.is_none() && prompt.is_none() && goal_id.is_empty())
        {
            return self.replied(op, tx, Ok(Value::Bool(false)));
        }
        let generation = self.deps.quota.goals.entry_generation(self.id.as_str());
        let retry = match Self::retry_turn(retained, prompt, provenance) {
            Ok(retry) => retry,
            Err(error) => return self.replied(op, tx, Err(error)),
        };
        self.retry_claim = format!("{}\0{key}", self.id.as_str());
        if !goal_id.is_empty() {
            return self.resume_goal(op, tx, key, goal_id, generation, retry);
        }
        if let Some(retry) = retry {
            self.begin_retry(retry);
        }
        self.finish_resume(&key, "", generation);
        self.replied(op, tx, Ok(Value::Bool(true)));
    }

    /// `finishResume(id, entry, goalId)`: the entry the resume answered goes, and the note of
    /// the Goal it revived.
    fn finish_resume(&mut self, key: &str, goal_id: &str, generation: Option<u64>) {
        if generation.is_some() {
            self.quota_answered = generation;
        }
        let (goals, id, key, goal_id) = (self.deps.quota.goals.clone(), self.id.as_str().to_owned(), key.to_owned(), goal_id.to_owned());
        self.quota.call(async move {
            if let Err(error) = goals.finish_resume(&id, &key, &goal_id, generation).await {
                tracing::warn!("a quota resume was not finished: {error:?}");
            }
        });
    }

    /// A cancel of the quota resume (`cancelFor`, `cancelQuotaResume`: new user input, a clear, the explicit
    /// cancel) takes effect at once, in memory, as Node's synchronous cancel does: the settlement's epoch
    /// rises (a Goal resume that checks it is no longer current) and the queued entry reads as answered
    /// (`quota_entry`), so a fire that comes before the store write lands, or after it failed, finds nothing
    /// and no auto-resume runs. The store write follows and a failure of it is logged.
    pub(super) fn quota_cancel_now(&mut self) {
        self.quota.settlement.raise_epoch();
        if let Some(entry) = self.deps.quota.goals.entry(self.id.as_str()) {
            self.quota_answered = Some(entry.generation);
        }
    }

    /// The queued entry `fireQuotaResume` reads (`quotaResumeEntry(id)`): one this session already
    /// answered reads as gone, as Node's synchronous cancel leaves it.
    fn quota_entry(&self) -> Option<mixdog_core_base::quota_resume::Entry> {
        self.deps.quota.goals.entry(self.id.as_str()).filter(|entry| Some(entry.generation) != self.quota_answered)
    }

    /// `fireQuotaResume`'s decision over the session as it is now.
    fn fire_step(&self, generation: u64, retained: bool) -> super::super::quota_lane::FireStep {
        let entry = self.quota_entry();
        let items = self.failed_turn_items();
        let (goals, id) = (&self.deps.quota.goals, self.id.as_str());
        let suspended = |key: &str| goals.suspended(id, key);
        let claimed = |key: &str| self.retry_claim == format!("{id}\0{key}");
        let facts = super::super::quota_lane::FireFacts {
            entry: entry.as_ref().map(|entry| (entry.turn_key.as_str(), entry.generation)),
            blocked: self.retry_blocked(),
            items: &items,
            retained,
            suspended: &suspended,
            claimed: &claimed,
        };
        super::super::quota_lane::fire_step(generation, &facts)
    }

    /// `fireQuotaResume({ generation })`, first half: the answers Node gives before it looks at
    /// the retained failed message (no current entry, busy, superseded). That message lives in
    /// the model context, so everything else is decided again once it is read.
    pub(super) fn quota_fire(&mut self, generation: u64, tx: FireReply) {
        use super::super::quota_lane::FireStep;
        let current = self.quota_entry().is_some_and(|entry| entry.generation == generation);
        let step = self.fire_step(generation, true);
        if !current || matches!(step, FireStep::Busy | FireStep::Superseded) {
            return self.quota_fire_act(generation, step, None, None, tx);
        }
        let (check, jobs) = (self.resume_check(), self.jobs_tx.clone());
        tokio::spawn(async move {
            let basis = check.retry_basis().await;
            let _ = jobs.send(JobDone::QuotaFireChecked { generation, tx, retained: basis.retained, provenance: basis.provenance });
        });
    }

    /// The rest of `fireQuotaResume`, synchronous from the generation check to the admitted retry
    /// (no cancellation lands between them), as in Node.
    pub(super) fn quota_fire_checked(&mut self, generation: u64, tx: FireReply, retained: Option<super::super::quota_lane::Retained>, provenance: Option<Value>) {
        let step = self.fire_step(generation, retained.is_some());
        self.quota_fire_act(generation, step, retained, provenance, tx);
    }

    fn quota_fire_act(&mut self, generation: u64, step: super::super::quota_lane::FireStep, retained: Option<super::super::quota_lane::Retained>, provenance: Option<Value>, tx: FireReply) {
        use super::super::quota_lane::FireStep;
        use super::super::quota_resume_scheduler::FireOutcome;
        let (turn_key, goal_id) = match step {
            FireStep::Stale => return drop(tx.send(Ok(FireOutcome::Stale))),
            FireStep::Busy => return drop(tx.send(Ok(FireOutcome::Busy))),
            FireStep::Superseded => {
                self.finish_resume("", "", Some(generation));
                return drop(tx.send(Ok(FireOutcome::Superseded)));
            }
            FireStep::Unreplayable => {
                let item = super::super::transcript::idle_notice_item(&new_id(), super::super::quota_lane::UNRESUMABLE, "warn");
                self.show_live(TurnId::from(""), item, None);
                self.finish_resume("", "", Some(generation));
                return drop(tx.send(Ok(FireOutcome::Unreplayable)));
            }
            FireStep::ResumeGoal { turn_key, goal_id } => (turn_key, goal_id),
            FireStep::Retry { turn_key } => (turn_key, String::new()),
        };
        let prompt = mixdog_core_goal::quota_settlement::failed_turn_retry_prompt(&self.failed_turn_items(), &turn_key);
        let retry = match Self::retry_turn(retained, prompt, provenance) {
            Ok(retry) => retry,
            Err(error) => return drop(tx.send(Err(error_text(&error)))),
        };
        self.retry_claim = format!("{}\0{turn_key}", self.id.as_str());
        if goal_id.is_empty() {
            if let Some(retry) = retry {
                self.begin_retry(retry);
            }
            self.finish_resume(&turn_key, "", Some(generation));
            return drop(tx.send(Ok(FireOutcome::Fired)));
        }
        // `resumeGoal(...).then((accepted) => (accepted ? 'fired' : 'rejected'))`; its failure is
        // the rejection the fire raises.
        let (answer_tx, answer) = oneshot::channel();
        self.resume_goal(None, answer_tx, turn_key, goal_id, Some(generation), retry);
        tokio::spawn(async move {
            let outcome = match answer.await {
                Ok(Ok(Reply::Value(Value::Bool(true)))) => Ok(FireOutcome::Fired),
                Ok(Ok(_)) => Ok(FireOutcome::Rejected),
                Ok(Err(error)) => Err(error_text(&error)),
                Err(_) => Err("the session closed".to_owned()),
            };
            let _ = tx.send(outcome);
        });
    }

    /// `resumeGoal`: the Goal runtime revives the suspended Goal through the lane's admission;
    /// the retry is let through only while the failed turn is still the latest, unsuperseded
    /// and its queued resume (by generation) is the one answered.
    fn resume_goal(&mut self, op: Option<OpId>, tx: Waiter, key: String, goal_id: String, generation: Option<u64>, retry: Option<super::super::quota_lane::RetryTurn>) {
        let token = Arc::new(super::super::quota_lane::ResumeToken::default());
        let (settlement, goals, cell, id) = (self.quota.settlement.clone(), self.deps.quota.goals.clone(), self.cell.clone(), self.id.as_str().to_owned());
        let epoch = settlement.epoch();
        let current: Arc<dyn Fn() -> bool + Send + Sync> = {
            let (goals, key, id) = (goals.clone(), key.clone(), id.clone());
            Arc::new(move || {
                let view = cell.view.load();
                !cell.closed.load(SeqCst)
                    && settlement.epoch() == epoch
                    && super::super::quota_lane::latest_failed_turn_key(&super::super::quota_lane::transcript_rows(view.items.iter().map(|item| item.as_ref()))) == key
                    && goals.entry_generation(&id) == generation
            })
        };
        let admission = mixdog_core_goal::goal::Admission {
            is_current: Some({
                let current = current.clone();
                Box::new(move || Ok(current()))
            }),
            accept: Some({
                let (current, token) = (current, token.clone());
                Box::new(move || {
                    if !current() {
                        return Ok(false);
                    }
                    *token.admitted.lock().unwrap_or_else(|p| p.into_inner()) = Some(retry.clone());
                    Ok(true)
                })
            }),
        };
        self.quota_pending = Some(token.clone());
        let jobs = self.jobs_tx.clone();
        tokio::spawn(async move {
            let result = goals.resume(&id, &goal_id, admission).await;
            let _ = jobs.send(JobDone::Resumed(Box::new(ResumeDone { op, tx, key, goal_id, generation, token, result })));
        });
    }

    /// The Goal resume answered: a revived Goal finishes the resume and lets its retry (or the
    /// Goal's own continuation) run; a refusal frees the claim; a failure shows its notice.
    pub(super) fn resumed(&mut self, done: ResumeDone) {
        let ResumeDone { op, tx, key, goal_id, generation, token, result } = done;
        let admitted = token.admitted.lock().unwrap_or_else(|p| p.into_inner()).take();
        let (accepted, answer, release) = match &result {
            Ok(goal) => (goal.as_ref().is_some_and(|goal| mixdog_core_goal::goal::js::string(goal, "status") == "active") && admitted.is_some(), Ok(()), true),
            Err(error) => {
                let item = super::super::transcript::idle_notice_item(&new_id(), &format!("Goal resume failed: {}", error.message), "warn");
                self.show_live(TurnId::from(""), item, None);
                (false, Err(super::super::turn_ops::failure(&error.message)), !error.rollback_failed)
            }
        };
        if accepted {
            self.finish_resume(&key, &goal_id, generation);
        } else {
            self.retry_claim.clear();
        }
        // A rolled-back failure that could not restore the Goal keeps the session held.
        if release {
            self.quota_pending = None;
            match admitted.filter(|_| accepted) {
                Some(Some(retry)) => self.begin_retry(retry),
                Some(None) => self.schedule_goal_continuation(),
                None => self.start_next_queued(),
            }
        }
        self.replied(op, tx, answer.map(|()| Value::Bool(accepted)));
    }
    /// The rest of a manual compaction once its Goal reminder is marked.
    pub(super) fn compacted(&mut self, op: Option<OpId>, tx: Waiter, result: Value, recover: bool) {
        self.mark_goal_reminder("compaction");
        let (compaction, thread, jobs) = (self.deps.compaction.clone(), self.id.clone(), self.jobs_tx.clone());
        tokio::spawn(async move {
            compaction.rearm(&thread).await;
            if recover {
                compaction.recover_workers(&thread);
            }
            compaction.invalidate_context_status(&thread);
            let _ = jobs.send(JobDone::CompactionEnded);
            let _ = jobs.send(JobDone::Replied { op, tx, result: Ok(result) });
        });
    }

    /// `pushNotice(text, tone)` of the hosted runtime (`session-service.mjs`
    /// `pushLiveSessionNotice`, `notice-surface.mjs`): the polished text shows as a muted
    /// transcript notice row of no turn; the answer is the row's id, `null` for a text that
    /// polishes to nothing.
    fn push_notice(&mut self, req: &CoreRequest) -> Result<Value, CoreError> {
        let params: mixdog_app_protocol::v2::params::ThreadPushNoticeParams = parse(&req.params, "ThreadPushNoticeParams")?;
        let value = super::super::live_rows::polish_notice_text(&params.text);
        if value.is_empty() {
            return Ok(Value::Null);
        }
        let row_id = new_id();
        let tone = params.level.as_deref().unwrap_or("info");
        let item = super::super::transcript::idle_notice_item(&row_id, &value, tone);
        self.show_live(TurnId::from(""), item, None);
        Ok(json!(row_id))
    }

    /// `clearSessionChangeHistory` (`integrations.mjs`): refused while the session runs a turn,
    /// else the turn review deletes the session's retained change history; the answer is
    /// `{turns}`.
    fn clear_change_history(&mut self, op: Option<OpId>, tx: Waiter) {
        if self.ui_busy() {
            let error = super::super::turn_ops::failure("Change history cannot be deleted while this session is running a turn");
            return self.replied(op, tx, Err(error));
        }
        let (review, thread, jobs) = (self.deps.turn_review.clone(), self.id.clone(), self.jobs_tx.clone());
        tokio::spawn(async move {
            let result = match review.clear_change_history(thread.as_str()).await {
                Ok(reply) => Ok(Value::Object(reply)),
                Err(error) => Err(super::super::turn_ops::failure(&error.message)),
            };
            let _ = jobs.send(JobDone::Replied { op, tx, result });
        });
    }

    /// `commitSessionCompaction` of a manual compaction: refused (`Moved`, the compaction is not
    /// applied) while a turn runs or starts, or the thread closes; else the model context is read
    /// to reconcile the result with.
    pub(super) fn commit_compaction(
        &mut self,
        snapshot: Vec<mixdog_core_api::ids::ItemId>,
        compaction: super::super::run::Compaction,
        header: Option<super::super::turn_ops::CompactionHeader>,
        tx: oneshot::Sender<Result<super::super::turn_ops::CompactionCommit, CoreError>>,
    ) {
        use super::super::turn_ops::CompactionCommit;
        if self.compaction_blocked() {
            return drop(tx.send(Ok(CompactionCommit::Moved)));
        }
        let context = ModelContext {
            store: self.deps.store.clone(),
            sensitive: self.deps.sensitive.clone(),
            lanes: self.deps.lanes,
            thread: self.id.clone(),
            input: mixdog_core_api::ids::ItemId::from(String::new()),
        };
        let (jobs, begun) = (self.jobs_tx.clone(), self.runs_begun);
        tokio::spawn(async move {
            let rows = context.read().await;
            let _ = jobs.send(JobDone::CompactionRows(Box::new(CommitRows { snapshot, compaction, header, begun, rows, tx })));
        });
    }

    /// `isSessionCompactionBlocked`: a turn's provider or tool work runs now, or the thread is going.
    pub(super) fn compaction_blocked(&self) -> bool {
        self.deleting || self.cell.closed.load(SeqCst) || self.ui_busy()
    }

    /// The context is read: the result is applied when the context still starts with the snapshot
    /// it was planned on, no turn began meanwhile and none runs; the rows a finished turn appended
    /// meanwhile follow the compacted ones, in order (`appendedSinceSnapshot`). Anything else
    /// leaves the conversation as it is (`Moved`).
    pub(super) fn compaction_rows(&mut self, done: CommitRows) {
        use super::super::turn_ops::CompactionCommit;
        let CommitRows { snapshot, mut compaction, header, begun, rows, tx } = done;
        let rows = match rows {
            Ok(rows) => rows,
            Err(error) => return drop(tx.send(Err(error))),
        };
        let extends = rows.len() >= snapshot.len() && rows.iter().zip(&snapshot).all(|((iid, _), planned)| iid == planned);
        if self.compaction_blocked() || self.runs_begun != begun || !extends {
            return drop(tx.send(Ok(CompactionCommit::Moved)));
        }
        let appended: Vec<_> = rows.into_iter().skip(snapshot.len()).collect();
        // The header the commit carries is computed here, where the rows a finished turn appended
        // meanwhile are known (withAppendedMessages), from the header as it stands.
        // The actor computes it itself once the compaction is applied (`ProducerMsg::Compacted`).
        let header: Option<super::super::run::DeferredHeader> = header.map(|header| {
            let appended = appended.clone();
            Box::new(move |current: &_| header(current, &appended)) as super::super::run::DeferredHeader
        });
        compaction.replacement.extend(appended);
        let jobs = self.jobs_tx.clone();
        let (ack, durable) = oneshot::channel();
        // No turn: the divider is shown live with no turn id, as a card outside a turn is.
        self.on_producer(ProducerMsg::Compacted { turn: TurnId::from(""), compaction, header, ack });
        tokio::spawn(async move {
            let answer = match durable.await {
                Ok(Ok(())) => {
                    // `pruneCompactedOffloads(session)` on the actor (`prune_offloads`); the commit answers after it.
                    let (told, pruned) = oneshot::channel();
                    if jobs.send(JobDone::PruneOffloads(told)).is_ok() {
                        let _ = pruned.await;
                    }
                    Ok(CompactionCommit::Applied)
                }
                _ => Err(CoreError::Internal { incident_id: "compaction-commit".into() }),
            };
            let _ = tx.send(answer);
        });
    }
}
