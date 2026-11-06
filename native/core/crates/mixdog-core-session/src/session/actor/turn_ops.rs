//! The turn operations the actor serves itself (`session/turn_ops.rs`): what reads the busy
//! state or the live rows only the actor owns.

use super::*;

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
                self.compact_start(req.op.clone(), tx, params.options);
                return Ok(());
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
    fn compact_start(&mut self, op: Option<OpId>, tx: Waiter, options: Option<Value>) {
        if self.ui_busy() {
            return self.replied(op, tx, Ok(super::super::turn_ops::compact_in_turn()));
        }
        let (trigger, require_reduction) = super::super::turn_ops::compact_trigger(options.as_ref());
        let recover = options.as_ref().and_then(|options| options.get("recoverAgent")) == Some(&Value::Bool(true));
        let (compaction, thread, jobs) = (self.deps.compaction.clone(), self.id.clone(), self.jobs_tx.clone());
        tokio::spawn(async move {
            let result = match compaction.compact(&thread, trigger, require_reduction).await {
                Ok(result) => result.unwrap_or(Value::Null),
                Err(error) => return drop(jobs.send(JobDone::Replied { op, tx, result: Err(error) })),
            };
            if mixdog_core_goal::goal::js::truthy(result.get("skipped")) {
                return drop(jobs.send(JobDone::Replied { op, tx, result: Ok(result) }));
            }
            compaction.post_compact(&thread, trigger).await;
            let _ = jobs.send(JobDone::Compacted { op, tx, result, recover });
        });
    }

    /// `retryBlocked()`: anything running, settling, closing or queued owns the session first.
    fn retry_blocked(&self) -> bool {
        self.deleting || self.quota.settlement.settling() || self.turn_busy() || !self.projected.queue.is_empty()
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
            let retained = check.retained_retry().await;
            let _ = jobs.send(JobDone::RetryChecked { op, tx, key, retained });
        });
    }

    /// The rest of `retryFailedTurn`: the claim, then the retry turn replays the failed prompt
    /// (or the continuation instruction when the turn produced output) and the resume entry
    /// it answered is finished.
    pub(super) fn retry_checked(&mut self, op: Option<OpId>, tx: Waiter, key: String, retained: bool) {
        let items = self.failed_turn_items();
        let goal_id = self.deps.quota.goals.suspended(self.id.as_str(), &key);
        let prompt = mixdog_core_goal::quota_settlement::failed_turn_retry_prompt(&items, &key);
        if self.retry_blocked()
            || super::super::quota_lane::latest_failed_turn_key(&items) != key
            || (!retained && prompt.is_none() && goal_id.is_empty())
        {
            return self.replied(op, tx, Ok(Value::Bool(false)));
        }
        let Some(prompt) = prompt.filter(|_| !retained && goal_id.is_empty()) else {
            let error = super::super::turn_ops::failure("A retry that resumes a suspended Goal or replays the retained failed message is not served by this daemon yet");
            return self.replied(op, tx, Err(error));
        };
        self.retry_claim = format!("{}\0{key}", self.id.as_str());
        let input = TurnInput {
            prompt: PromptContent::Text(prompt.clone()),
            options: Some(mixdog_protocol::thread::SubmitOptions {
                display_text: Some(prompt),
                retry_failed_turn: Some(true),
                ..Default::default()
            }),
        };
        self.start_run(input, None, None, None);
        let (goals, id) = (self.deps.quota.goals.clone(), self.id.as_str().to_owned());
        self.quota.call(async move {
            let _ = goals.cancel_entry(&id).await;
        });
        self.replied(op, tx, Ok(Value::Bool(true)));
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
}
