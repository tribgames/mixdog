//! The turn operations the actor serves itself (`session/turn_ops.rs`): what reads the busy
//! state or the live rows only the actor owns.

use super::*;

/// The scheduler's answer channel for a fire (`ResumeHost::fire`).
type FireReply = oneshot::Sender<Result<super::super::quota_resume_scheduler::FireOutcome, String>>;

use super::super::quota_lane::failure_text as error_text;

#[derive(PartialEq, Eq)]
pub(super) enum RouteSwitchCompaction {
    NotNeeded,
    QuotaBlocked,
    Compact,
}

/// Node's `HOLD_REFUSAL` (`daemon-work-gate.mjs`): what a session call the work gate does not allow while it holds is refused with.
pub(super) const HOLD_REFUSAL: &str = "daemon is holding new work for an update install";

/// What a user who asked for a compaction that changed nothing is told.
const NOTHING_TO_COMPACT: &str = "Nothing to compact";

/// The reason a compaction asked while another owns the session is skipped with.
const COMPACTION_RUNNING: &str = "compact skipped: compaction in progress";

/// What a given-up idle clear's compaction is aborted with when the next compaction starts.
const CLEAR_SUPERSEDED: &str = "auto-clear given up: another compaction started";

/// A manual compaction's answer to its actor. A session closed, deleted or shut down under the compaction has no actor
/// left to take it: the compaction's result (Node returns it after the close) goes straight to the request waiting for it.
fn answer(jobs: &mpsc::UnboundedSender<JobDone>, job: JobDone) {
    let Err(mpsc::error::SendError(job)) = jobs.send(job) else { return };
    match job {
        JobDone::Replied { tx, result, .. } => drop(tx.send(result.map(Reply::Value))),
        JobDone::Compacted { tx, result, .. } => drop(tx.send(Ok(Reply::Value(result)))),
        _ => {}
    }
}

/// Reports a compaction's end to its actor, once: explicitly, or when the compaction's task ends without having (a panic, a drop).
struct CompactionEnding(Option<(mpsc::UnboundedSender<JobDone>, u64)>);

impl CompactionEnding {
    fn report(&mut self) {
        if let Some((jobs, id)) = self.0.take() {
            let _ = jobs.send(JobDone::CompactionEnded(id));
        }
    }
}

impl Drop for CompactionEnding {
    fn drop(&mut self) {
        self.report();
    }
}

impl SessionActor {
    /// Routes one of [`super::super::turn_ops::is_actor_method`].
    pub(super) fn turn_op(&mut self, req: CoreRequest, tx: Waiter) -> Result<(), (CoreError, Waiter)> {
        let done = match req.method.as_str() {
            "thread/pushNotice" => self.push_notice(&req),
            // rememberPromptHistory(text): the draft Esc cleared joins the cwd's persisted history, through the writer a submitted prompt uses
            // (the republish of the list is that writer's: PromptFlushed). true when there was a text to keep (Node answered whether the write
            // landed; the writer here retries a write that did not).
            "thread/rememberPromptHistory" => match super::super::tui_client_methods::remembered_prompt(&req.params) {
                Ok(Some(prompt)) => {
                    self.persist_prompt(prompt);
                    Ok(Value::Bool(true))
                }
                Ok(None) => Ok(Value::Bool(false)),
                Err(error) => Err(error),
            },
            "thread/askSide" => {
                let params: mixdog_app_protocol::v2::params::ThreadAskSideParams = match parse(&req.params, "ThreadAskSideParams") {
                    Ok(params) => params,
                    Err(error) => return Err((error, tx)),
                };
                let (side, thread, jobs, op) = (self.deps.side.clone(), self.id.clone(), self.jobs_tx.clone(), req.op.clone());
                // A cold transcript is compacted before the question only while nothing else runs on the session.
                let idle = !self.turn_busy() && !self.compacting();
                tokio::spawn(async move {
                    let result =
                        super::super::turn_ops::ask_side_question(side.as_ref(), &thread, &params.question, idle).await.map(|text| json!({ "text": text }));
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
                let requested = super::super::turn_ops::is_user_compaction(params.options.as_ref());
                // `{afterTurn: true}`: the session tool's `compact` (`workspace-tools.mjs:268`) only marks
                // the thread; the turn's completion runs it.
                if params.options.as_ref().and_then(|options| options.get("afterTurn")) == Some(&Value::Bool(true)) {
                    self.compact_scheduled = true;
                    Ok(Value::Null)
                } else if self.ui_busy() && requested {
                    Ok(self.schedule_compact_for_turn_end())
                } else {
                    self.compact_start(req.op.clone(), tx, params.options, requested);
                    return Ok(());
                }
            }
            // The session tool's `compact` (`pendingCompactSessionIds`): runs once the turn settles.
            "thread/compact/schedule" => {
                self.compact_scheduled = true;
                Ok(json!({}))
            }
            "turn/retryFailed" => {
                let params: mixdog_app_protocol::v2::thread::TurnRetryFailedParams = match parse(&req.params, "TurnRetryFailedParams") {
                    Ok(params) => params,
                    Err(error) => return Err((error, tx)),
                };
                // The core holds new turn starts (`hold{on}`): Node's work gate refuses a client's retry (`callRefusal`, which
                // `HOLD_ALLOWED_CALLS` lets only reads, stops and answers through; `routes.mjs:168-172`, 503), as it starts a model
                // turn at once. Once the drain commit dropped the hold, the retry is refused as admission refuses a start.
                match self.core_hold() {
                    StartHold::Held if matches!(req.ctx.caller, Caller::Connection(_)) => Err(mixdog_core_base::support::failed("session", HOLD_REFUSAL)),
                    StartHold::Closed(drain_reason) => Err(CoreError::ServerShuttingDown { drain_reason }),
                    _ => {
                        self.retry_failed(req.op.clone(), tx, params.turn_key);
                        return Ok(());
                    }
                }
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

    /// The compaction's number once it starts; `None` when it is refused (its answer is given). `requested`: a user's own
    /// compaction, told when it changed nothing.
    pub(super) fn compact_start(&mut self, op: Option<OpId>, tx: Waiter, options: Option<Value>, requested: bool) -> Option<u64> {
        if self.ui_busy() {
            self.replied(op, tx, Ok(super::super::turn_ops::compact_in_turn()));
            return None;
        }
        // A side question's compaction of an idle session is decided here, under the exclusion a turn's start takes: a turn
        // that started (or is starting, or queued) after the question looked, or another compaction, keeps the history.
        let idle_only = options.as_ref().and_then(|options| options.get("idleOnly")) == Some(&Value::Bool(true));
        if idle_only && (self.turn_busy() || self.compacting()) {
            self.replied(op, tx, Ok(super::super::turn_ops::compact_in_turn()));
            return None;
        }
        // One compaction at a time: a second ask (a double trigger, another device) would commit over a history the first
        // moved, and take the cancel a Stop, a close or a delete reaches the first by.
        if self.compacting() {
            self.replied(op, tx, Ok(json!({ "changed": false, "reason": COMPACTION_RUNNING })));
            return None;
        }
        // A given-up clear's compaction holds the cancel this one takes: it is aborted first, so none runs out of reach.
        if self.compactions > 0 {
            self.cell
                .abort_compaction(&mixdog_agent::cancel::Abort { message: CLEAR_SUPERSEDED.into(), reason: mixdog_agent::interrupt::AbortReason::Unnamed });
        }
        self.compactions += 1;
        self.compaction_seq += 1;
        let id = self.compaction_seq;
        let (trigger, require_reduction) = super::super::turn_ops::compact_trigger(options.as_ref());
        // `withCommandStatus` / `performAutoClear`: the command's status, its clock starting as the compaction begins.
        let (verb, mode) = if require_reduction { ("Auto-clearing idle conversation", "auto-clear") } else { ("Compacting conversation", "compacting") };
        let status = json!({ "active": true, "verb": verb, "startedAt": self.deps.clock.now_ms(), "mode": mode });
        self.accept_view(Change::Section(Section::Command(Some(status))), Vec::new());
        let recover = options.as_ref().and_then(|options| options.get("recoverAgent")) == Some(&Value::Bool(true));
        let (compaction, thread, jobs) = (self.deps.compaction.clone(), self.id.clone(), self.jobs_tx.clone());
        // The compaction is the busy session's running work, which a confirmed stop's abort cancels (Node's forced `shutdown` aborts every
        // busy session, not only its turn): its cancel is the token the core's lifecycle holds.
        let token = mixdog_rt::CancellationToken::new();
        let core_abort = self.hold_core().run(&token);
        let cancel = mixdog_agent::cancel::Cancel::from_token(&token);
        *self.cell.compaction_cancel.lock().unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(cancel.clone());
        tokio::spawn(async move {
            let _core_abort = core_abort;
            // However the task ends (a panic, a drop), the compaction's end is reported, so its command status cannot stay set.
            let mut ending = CompactionEnding(Some((jobs.clone(), id)));
            let result = match compaction.compact(&thread, trigger, require_reduction, &cancel).await {
                Ok(result) => result.unwrap_or(Value::Null),
                Err(error) => {
                    ending.report();
                    return answer(&jobs, JobDone::Replied { op, tx, result: Err(error) });
                }
            };
            if mixdog_core_goal::goal::js::truthy(result.get("skipped")) {
                ending.report();
                return answer(&jobs, JobDone::Replied { op, tx, result: Ok(result) });
            }
            compaction.post_compact(&thread, trigger).await;
            // The applied result ends the compaction after its commit (`compaction_rows`).
            ending.0 = None;
            answer(&jobs, JobDone::Compacted { id, op, tx, result, recover, requested });
        });
        Some(id)
    }

    /// `scheduleCompactForTurnEnd` (`session-api/commands.mjs`): a user's `/compact` while a turn runs is announced and runs once
    /// the turn and the queued follow-ups finish ([`Self::drain_pass`]); one schedule at a time, a repeat is told it already is.
    fn schedule_compact_for_turn_end(&mut self) -> Value {
        let text = if std::mem::replace(&mut self.manual_compact_due, true) {
            "Compact already scheduled for turn end"
        } else {
            "Compact scheduled: runs when the current turn finishes"
        };
        self.notice(None, text, "info");
        super::super::turn_ops::compact_scheduled_for_turn_end()
    }

    /// The command status ends: `commandBusy` and `commandStatus` leave the runtime section, once.
    pub(super) fn end_command_status(&mut self) {
        if self.projected.sections.runtime.as_ref().is_some_and(|runtime| runtime.command_busy) {
            self.accept_view(Change::Section(Section::Command(None)), Vec::new());
        }
    }

    /// Decide using the seated route, not the picker route; the run will adopt the held pick
    /// only after this pre-start gate releases.
    pub(super) fn route_switch_compaction(&self, pick: Option<&Value>) -> RouteSwitchCompaction {
        use mixdog_core_ports::ports::route::PRE_SWITCH_COMPACTION;
        let header = &self.acked.header;
        let Some(pick) = pick else { return RouteSwitchCompaction::NotNeeded };
        let provider = header.get("provider").and_then(Value::as_str).unwrap_or_default();
        let model = header.get("model").and_then(Value::as_str).unwrap_or_default();
        if pick.get(PRE_SWITCH_COMPACTION) != Some(&Value::Bool(true))
            || provider.is_empty()
            || model.is_empty()
            || (pick.get("provider") == header.get("provider") && pick.get("model") == header.get("model"))
            || !header.get("lastUsedAt").is_some_and(|stamp| mixdog_js::to_number(stamp) > 0.0)
        {
            return RouteSwitchCompaction::NotNeeded;
        }
        let quota = mixdog_core_goal::quota_settlement::latest_quota_failure(&self.failed_turn_items());
        let now = self.deps.clock.now_ms() as f64;
        if quota.is_some_and(|q| q.provider == provider && (q.model.is_empty() || q.model == model) && q.reset_at.is_none_or(|at| at > now)) {
            return RouteSwitchCompaction::QuotaBlocked;
        }
        let synced = self.deps.compaction.synced_compaction(header, false);
        let settings = synced.as_ref().or_else(|| header.get("compaction"));
        if settings.and_then(|settings| settings.get("onModelChange")) == Some(&Value::Bool(false)) || self.compacting() || self.compaction_blocked() {
            return RouteSwitchCompaction::NotNeeded;
        }
        RouteSwitchCompaction::Compact
    }

    pub(super) fn idle_gate(&self, input: &TurnInput, wake: bool) -> Option<(super::super::idle_auto_clear::IdleConfig, f64, f64)> {
        use super::super::idle_auto_clear::idle_config_of;
        use super::super::idle_auto_clear::idle_window_elapsed;
        use super::super::idle_auto_clear::session_activity_timestamp;
        let options = input.options.as_ref();
        if options.is_some_and(|options| options.kickoff == Some(true) || options.retry_failed_turn == Some(true) || options.retry_turn_id.is_some())
            || self.deleting
            || self.cell.closed.load(SeqCst)
        {
            return None;
        }
        if !wake {
            let submission = options.and_then(|options| options.client_submission_id.as_deref()).unwrap_or_default();
            let worker = self.cell.agent_start.lock().unwrap_or_else(|p| p.into_inner()).is_some();
            let routine = !submission.is_empty() && self.cell.routine_starts.lock().unwrap_or_else(|p| p.into_inner()).contains_key(submission);
            if worker || routine {
                return None;
            }
        }
        let config = self.deps.compaction.route_config(&self.acked.header).auto_clear.as_ref().and_then(idle_config_of)?;
        // A stamped turn is a conversation the model sees (the stamp is written when a turn settles); a thread with none has
        // nothing to clear.
        let header = &self.acked.header;
        let stamped = header.get("lastUsedAt").is_some_and(|stamp| mixdog_js::to_number(stamp) > 0.0);
        let session = json!({
            "lastUsedAt": header.get("lastUsedAt"),
            "updatedAt": header.get("updatedAt"),
            "messages": if stamped { json!([{ "role": "assistant" }]) } else { json!([]) },
        });
        let activity = session_activity_timestamp(&session, 0.0, self.deps.compaction.cache_warm_use_at(&self.id), &|_| None);
        let now = self.deps.clock.now_ms() as f64;
        idle_window_elapsed(&config, activity, now).then_some((config, activity, now))
    }

    /// The start waiting in `deferred_start` is checked against the context meter (`idleAutoClearDue`): a context below the
    /// minimum share of the compaction trigger is not worth a clear. No turn starts until the answer.
    pub(super) fn check_idle_clear(&mut self, gate: (super::super::idle_auto_clear::IdleConfig, f64, f64)) {
        use super::super::idle_auto_clear::context_status_of;
        use super::super::idle_auto_clear::idle_auto_clear_due;
        self.idle_clearing = true;
        let (config, activity, now) = gate;
        let (jobs, gauge, thread) = (self.jobs_tx.clone(), self.deps.context_status.clone(), self.id.clone());
        tokio::spawn(async move {
            let status = gauge.context_status(Some(thread), None).await.unwrap_or(Value::Null);
            let _ = jobs.send(JobDone::IdleClearChecked(idle_auto_clear_due(&config, activity, now, &context_status_of(&status))));
        });
    }

    /// The meter answered: a due thread is compacted before its turn starts, as `session.compact({ requireReduction: true })`
    /// does (trigger `auto_clear`); otherwise the turn goes on.
    pub(super) fn idle_clear_checked(&mut self, due: bool) {
        // A compaction already running (a manual one admitted while the meter was read) is the clear: `commandBusy` kept 1.4.5's
        // drain from reaching `autoClearBeforeSubmit` meanwhile, so two commands never own the status at once.
        if !due || self.compaction_blocked() || self.compacting() {
            self.idle_clearing = false;
            self.idle_cleared = true;
            return;
        }
        let (tx, rx) = oneshot::channel();
        self.after_compaction = Some(AfterCompaction { waiting: Vec::new(), goal_active: false });
        self.idle_clear_compaction = self.compact_start(None, tx, Some(json!({ "requireReduction": true })), false);
        let jobs = self.jobs_tx.clone();
        // `compactWithinTimeout`: the wait is bounded, not the compaction. One that outlasts it keeps running; its result is
        // applied only if no turn has begun by then (`compaction_rows`), and the turn does not wait for it.
        tokio::spawn(async move {
            let bound = Duration::from_millis(super::super::idle_auto_clear::AUTO_CLEAR_COMPACT_TIMEOUT_MS);
            let skipped = match mixdog_rt::time::timeout(bound, rx).await {
                Ok(Ok(Ok(_))) => None,
                Ok(Ok(Err(error))) => Some(error_text(&error)),
                Ok(Err(_)) => Some("compaction ended without an answer".to_owned()),
                Err(_) => Some(format!("compaction timed out after {}ms; auto-clear deferred to next idle", bound.as_millis())),
            };
            let _ = jobs.send(JobDone::IdleClearEnded(skipped));
        });
    }

    /// The idle auto-clear's compaction ended or was given up: a skipped clear says why (`auto-clear skipped: ...`), and the
    /// turn that waited goes on once what was asked meanwhile ran.
    pub(super) fn idle_clear_ended(&mut self, skipped: Option<String>) {
        self.idle_cleared = true;
        // Still running, its wait gave up: it holds nothing back from here, though a Stop, a close or a delete still reaches it.
        if let Some(id) = self.idle_clear_compaction.take() {
            self.given_up.push(id);
        }
        // `performAutoClear`'s `finally`: the wait that blocked the turn ended (the compaction did, or the wait gave up and a
        // slow compaction runs on), and the command's status ends with it.
        self.end_command_status();
        if let Some(reason) = skipped {
            let text = super::super::live_rows::polish_notice_text(&format!("auto-clear skipped: {reason}"));
            if !text.is_empty() {
                self.notice(None, &text, "error");
            }
        }
        self.scheduled_compaction_ended();
    }

    pub(super) fn run_scheduled_compaction(&mut self, goal_active: bool) {
        let (tx, rx) = oneshot::channel();
        self.after_compaction = Some(AfterCompaction { waiting: Vec::new(), goal_active });
        self.compact_start(None, tx, None, false);
        let jobs = self.jobs_tx.clone();
        tokio::spawn(async move {
            let _ = rx.await;
            let _ = jobs.send(JobDone::ScheduledCompactionEnded);
        });
    }

    /// The scheduled compaction ended: what waited on it runs, in arrival order, then the work
    /// the settled turn left.
    pub(super) fn scheduled_compaction_ended(&mut self) {
        self.idle_clearing = false;
        let Some(after) = self.after_compaction.take() else {
            return;
        };
        for waiting in after.waiting {
            match waiting {
                super::Waiting::Request(req, tx) => {
                    if let Err((error, tx)) = self.mutation(req, tx) {
                        let _ = tx.send(Err(error));
                    }
                }
                super::Waiting::Plan(tx) => {
                    // The clear goes on from here in its caller: turns wait for it, as they waited behind it at the gate.
                    let plan = if self.deleting { Err(CoreError::ThreadClosing { thread_id: self.id.clone() }) } else { self.held_plan() };
                    let _ = tx.send(plan);
                }
                super::Waiting::Retry(retry) if self.deleting => drop(retry),
                // A turn released ahead of it runs: the retry is the next turn.
                super::Waiting::Retry(retry) if self.turn_busy() => self.pending_retry = Some(retry),
                super::Waiting::Retry(retry) => self.begin_retry(retry),
            }
        }
        if self.deleting {
            return;
        }
        self.start_next_queued();
        if after.goal_active {
            self.schedule_goal_continuation();
        }
        self.try_unload();
    }

    pub(super) fn retry_blocked(&self) -> bool {
        self.deleting
            || self.cell.closed.load(SeqCst)
            || self.quota.settlement.settling()
            || self.turn_busy()
            || (self.compacting() && !self.compaction_held())
            || self.pending_retry.is_some()
            || self.after_compaction.as_ref().is_some_and(|after| after.waiting.iter().any(|w| matches!(w, super::Waiting::Retry(_))))
            || self.queue_holds_work()
    }

    fn failed_turn_items(&self) -> Vec<Value> {
        super::super::quota_lane::transcript_rows(self.acked.window.iter().map(|row| row.item.as_ref()))
    }

    /// The transcript ends on a turn that failed on provider quota, and no turn has begun since.
    pub(super) fn quota_stopped(&self) -> bool {
        mixdog_core_goal::quota_settlement::latest_quota_failure(&self.failed_turn_items()).is_some()
    }

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
    fn retry_turn(
        retained: Option<super::super::quota_lane::Retained>,
        prompt: Option<String>,
        provenance: Option<Value>,
    ) -> Result<Option<super::super::quota_lane::RetryTurn>, CoreError> {
        if let Some(retained) = retained {
            let prior = retained.prior();
            let cannot_resend = || super::super::turn_ops::failure("The failed message holds content this daemon cannot resend");
            let content = super::super::prompt_submission::deliverable(&retained.content).map_err(|_| cannot_resend())?;
            let prompt: PromptContent = serde_json::from_value(content).map_err(|_| cannot_resend())?;
            let options = mixdog_protocol::thread::SubmitOptions {
                retry_failed_turn: Some(true),
                retry_turn_id: Some(retained.message_id),
                retry_attempt_id: retained.attempt_id,
                ..Default::default()
            };
            return Ok(Some(super::super::quota_lane::RetryTurn {
                input: TurnInput { prompt, options: Some(options) },
                hidden: true,
                provenance,
                prior: Some(prior),
            }));
        }
        Ok(prompt.map(|prompt| {
            let options = mixdog_protocol::thread::SubmitOptions { display_text: Some(prompt.clone()), retry_failed_turn: Some(true), ..Default::default() };
            super::super::quota_lane::RetryTurn {
                input: TurnInput { prompt: PromptContent::Text(prompt), options: Some(options) },
                hidden: false,
                provenance,
                prior: None,
            }
        }))
    }

    /// The retry turn starts, unless the scheduled compaction holds the session: then it waits on
    /// the gate (`ask: afterCompaction(runner.ask)`), in arrival order with the requests it holds.
    pub(super) fn begin_retry(&mut self, retry: super::super::quota_lane::RetryTurn) {
        if let Some(after) = &mut self.after_compaction {
            after.waiting.push(super::Waiting::Retry(retry));
            #[cfg(any(test, feature = "test-support"))]
            self.cell.gate_holds.fetch_add(1, SeqCst);
            return;
        }
        self.retry_hidden = retry.hidden;
        self.retry_provenance = Some(retry.provenance);
        self.retry_prior = retry.prior;
        // A retry is no new acceptance: a hidden one runs the visible message again and shows no row, a visible one is a
        // fresh text prompt; neither records a missing original.
        self.start_run(retry.input, 0, None, None, None);
    }

    /// The rest of `retryFailedTurn`: the claim, then either the retry turn starts at once (and
    /// the resume entry it answered is finished) or a suspended Goal is revived first.
    pub(super) fn retry_checked(
        &mut self,
        op: Option<OpId>,
        tx: Waiter,
        key: String,
        retained: Option<super::super::quota_lane::Retained>,
        provenance: Option<Value>,
    ) {
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
            // `cancelQuotaResumeEntry` publishes as it removes the entry: the state stops showing it now, not when the
            // store write lands.
            self.publish_quota_resume();
        }
        let (goals, id, key, goal_id) = (self.deps.quota.goals.clone(), self.id.as_str().to_owned(), key.to_owned(), goal_id.to_owned());
        self.quota.call(async move {
            if let Err(error) = goals.finish_resume(&id, &key, &goal_id, generation).await {
                tracing::warn!("a quota resume was not finished: {error:?}");
            }
        });
    }

    pub(super) fn quota_cancel_now(&mut self) {
        self.quota.settlement.raise_epoch();
        if let Some(entry) = self.deps.quota.goals.entry(self.id.as_str()) {
            self.quota_answered = Some(entry.generation);
            self.publish_quota_resume();
        }
    }

    pub(super) fn supersede_quota_resume(&mut self) {
        self.quota_cancel_now();
        let (settlement, id) = (self.quota.settlement.clone(), self.id.as_str().to_owned());
        self.quota.call(async move {
            if let Err(error) = settlement.supersede(&id).await {
                tracing::warn!("a quota resume was superseded in memory but its entry was not removed: {error:?}");
            }
        });
    }

    /// The queued entry `fireQuotaResume` reads (`quotaResumeEntry(id)`): one this session already
    /// answered reads as gone, as Node's synchronous cancel leaves it.
    fn quota_entry(&self) -> Option<mixdog_core_base::quota_resume::Entry> {
        self.deps.quota.goals.entry(self.id.as_str()).filter(|entry| Some(entry.generation) != self.quota_answered)
    }

    /// `publishQuotaResume` (`quota-resume.mjs`): the state's `quotaResume` is the queued entry as it reads now, in
    /// `publicQuotaResume`'s shape ([`mixdog_core_base::quota_resume::Entry::public`]).
    pub(super) fn publish_quota_resume(&mut self) {
        let value = self.quota_entry().and_then(|entry| {
            let public = entry.public();
            match serde_json::from_value::<mixdog_protocol::QuotaResume>(public) {
                Ok(value) => Some(value),
                Err(error) => {
                    tracing::warn!(thread = self.id.as_str(), "the waiting quota resume is not published: {error}");
                    None
                }
            }
        });
        if self.projected.sections.quota_resume != value {
            self.accept_view(Change::Section(Section::QuotaResume(value)), Vec::new());
        }
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
    pub(super) fn quota_fire_checked(
        &mut self,
        generation: u64,
        tx: FireReply,
        retained: Option<super::super::quota_lane::Retained>,
        provenance: Option<Value>,
    ) {
        let step = self.fire_step(generation, retained.is_some());
        self.quota_fire_act(generation, step, retained, provenance, tx);
    }

    fn quota_fire_act(
        &mut self,
        generation: u64,
        step: super::super::quota_lane::FireStep,
        retained: Option<super::super::quota_lane::Retained>,
        provenance: Option<Value>,
        tx: FireReply,
    ) {
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
                self.notice(None, super::super::quota_lane::UNRESUMABLE, "warn");
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
    fn resume_goal(
        &mut self,
        op: Option<OpId>,
        tx: Waiter,
        key: String,
        goal_id: String,
        generation: Option<u64>,
        retry: Option<super::super::quota_lane::RetryTurn>,
    ) {
        let token = Arc::new(super::super::quota_lane::ResumeToken::default());
        let (settlement, goals, cell, id) = (self.quota.settlement.clone(), self.deps.quota.goals.clone(), self.cell.clone(), self.id.as_str().to_owned());
        let epoch = settlement.epoch();
        let current: Arc<dyn Fn() -> bool + Send + Sync> = {
            let (goals, key, id) = (goals.clone(), key.clone(), id.clone());
            Arc::new(move || {
                let view = cell.view.load();
                !cell.closed.load(SeqCst)
                    && settlement.epoch() == epoch
                    && super::super::quota_lane::latest_failed_turn_key(&super::super::quota_lane::transcript_rows(view.items.iter().map(|item| item.as_ref())))
                        == key
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
                self.notice(None, &format!("Goal resume failed: {}", error.message), "warn");
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
        // The resume no longer holds the turns, a busy change (`updateEntryBusy`'s `onBusyChange`): the idle clock starts over.
        if release {
            self.try_unload();
        }
    }
    /// The rest of a manual compaction once it ran. Only a history it changed re-marks the Goal reminder: one that moved
    /// (`TRANSCRIPT_MOVED_ERROR`) or found nothing left the conversation the reminder was marked for. One that failed or
    /// was stopped carries its `error`, and had something to compact.
    pub(super) fn compacted(&mut self, id: u64, op: Option<OpId>, tx: Waiter, result: Value, recover: bool, requested: bool) {
        if result.get("changed") == Some(&Value::Bool(true)) {
            self.context_compacted();
            self.mark_goal_reminder("compaction");
        } else if requested && result.get("error").is_none() {
            self.notice(None, NOTHING_TO_COMPACT, "info");
        }
        let (compaction, thread, jobs) = (self.deps.compaction.clone(), self.id.clone(), self.jobs_tx.clone());
        tokio::spawn(async move {
            let mut ending = CompactionEnding(Some((jobs.clone(), id)));
            compaction.rearm(&thread).await;
            if recover {
                compaction.recover_workers(&thread);
            }
            compaction.invalidate_context_status(&thread);
            ending.report();
            let _ = jobs.send(JobDone::Replied { op, tx, result: Ok(result) });
        });
    }

    fn push_notice(&mut self, req: &CoreRequest) -> Result<Value, CoreError> {
        let params: mixdog_app_protocol::v2::params::ThreadPushNoticeParams = parse(&req.params, "ThreadPushNoticeParams")?;
        let value = super::super::live_rows::polish_notice_text(&params.text);
        if value.is_empty() {
            return Ok(Value::Null);
        }
        let tone = params.level.as_deref().unwrap_or("info");
        Ok(self.notice(None, &value, tone).map_or(Value::Null, Value::String))
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
        // An external agent's session still holds the conversation the compaction replaced: the header stops naming it
        // in the commit, so the agent's next turn starts a session of its own on the compacted context.
        let agent_session = super::super::turn_ops::AGENT_SESSION;
        let leaves_agent = self.projected.header.contains_key(agent_session);
        let header: Option<super::super::run::DeferredHeader> = (header.is_some() || leaves_agent).then(|| {
            let appended = appended.clone();
            Box::new(move |current: &_| {
                let mut change = match header {
                    Some(header) => header(current, &appended),
                    None => mixdog_store::schema::record::HeaderChange::default(),
                };
                if leaves_agent {
                    change.set.shift_remove(agent_session);
                    change.unset.retain(|key| key != agent_session);
                    change.unset.push(agent_session.to_owned());
                }
                change
            }) as super::super::run::DeferredHeader
        });
        compaction.replacement.extend(appended);
        let jobs = self.jobs_tx.clone();
        // The compaction moves the reading (the header's reset, `lastContextTokens` 0): the status pass after it is the gauge's own
        // answer, read once the header is durable.
        let pass = self.next_status_pass();
        let (gauge, thread) = (self.deps.context_status.clone(), self.id.clone());
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
                    let status = gauge.context_status(Some(thread), None).await.unwrap_or(Value::Null);
                    let _ = jobs.send(JobDone::ContextStatus(pass, status));
                    Ok(CompactionCommit::Applied)
                }
                _ => Err(CoreError::Internal { incident_id: "compaction-commit".into() }),
            };
            let _ = tx.send(answer);
        });
    }
}
