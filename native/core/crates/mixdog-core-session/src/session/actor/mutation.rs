//! Client mutations: header writes, op calls, turn start planning, queue delete, rewind, clear, name, boundary and room rows.

use super::*;

impl SessionActor {
    /// `Inbox::UpdateHeader`: the change is computed here, from a copy of the header as projected
    /// (the actor is the header's only writer), and written as one `meta` record, answered once
    /// durable. A change that sets and unsets nothing writes nothing. `update` is synchronous and
    /// pure by contract (`HeaderUpdates`); a panic in it fails only this caller and writes nothing,
    /// and the actor goes on.
    pub(super) fn update_header(&mut self, update: mixdog_core_ports::ports::threads::HeaderUpdate, tx: Waiter) {
        if !self.outbox.has_room(Class::Normal) {
            let _ = tx.send(Err(CoreError::WindowFull { thread_id: self.id.clone() }));
            return;
        }
        let header = self.projected.header.clone();
        let Ok(change) = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| update(&header))) else {
            let _ = tx.send(Err(CoreError::Internal { incident_id: "header-update-panicked".into() }));
            return;
        };
        self.write_header_change(change, tx);
    }

    /// `Inbox::UpdateHeaderAwaiting`: as [`Self::update_header`], over a step that awaits its outside reads here.
    pub(super) async fn update_header_awaiting(&mut self, update: AwaitingHeaderUpdate, tx: Waiter) {
        use futures::FutureExt;
        if !self.outbox.has_room(Class::Normal) {
            let _ = tx.send(Err(CoreError::WindowFull { thread_id: self.id.clone() }));
            return;
        }
        let header = self.projected.header.clone();
        let Ok(change) = std::panic::AssertUnwindSafe(update(header)).catch_unwind().await else {
            let _ = tx.send(Err(CoreError::Internal { incident_id: "header-update-panicked".into() }));
            return;
        };
        // `updateSessionRoute`: a route move is written once its new figures are read ([`Self::start_route_move`]).
        let unset: Vec<&str> = change.unset.iter().map(String::as_str).collect();
        if self.run.is_none()
            && let Some(next) = self.window_move_of(Some(&change.set), &unset)
        {
            self.start_route_move(MoveApply::Change { change, tx }, next);
            return;
        }
        self.write_header_change(change, tx);
    }

    pub(super) fn write_header_change(&mut self, change: mixdog_store::schema::record::HeaderChange, tx: Waiter) {
        if change.set.is_empty() && change.unset.is_empty() {
            let _ = tx.send(Ok(Reply::Value(json!({}))));
            return;
        }
        let record = Record::Meta(MetaRecord { op: None, change: Slot::Inline(change) });
        let plan =
            Plan { kind: PlanKind::Records(vec![(record, Class::Normal, Display::None, Vec::new())], Vec::new()), value: json!({}), after: None, prompt: None };
        self.apply_plan(plan, None, tx);
    }

    /// The thread scope's op store (P §9.2): `Await` answers once a running execution of the op
    /// has settled; `Record` appends an `op` record (rejection, fence, external state), answered
    /// once durable.
    pub(super) fn op_call(&mut self, call: super::super::thread_ops::OpCall, tx: Waiter) {
        use super::super::thread_ops::OpCall;
        match call {
            OpCall::Await(op) => {
                if let Some(tx) = self.ops.wait_for(&op, tx) {
                    let _ = tx.send(Ok(Reply::Value(Value::Null)));
                }
            }
            OpCall::Record { op, state, detail } => {
                if !self.outbox.has_room(Class::Normal) {
                    let _ = tx.send(Err(CoreError::WindowFull { thread_id: self.id.clone() }));
                    return;
                }
                if state == mixdog_store::schema::record::OpState::Fenced
                    && let Err(error) = self.ops.fence(&OpId::from(op.id.as_str().to_owned()))
                {
                    let _ = tx.send(Err(error));
                    return;
                }
                let record =
                    Record::Op(mixdog_store::schema::record::OpRecord { op: *op, state, at: self.deps.clock.now_ms(), detail: detail.map(Slot::Inline) });
                let plan = Plan {
                    kind: PlanKind::Records(vec![(record, Class::Normal, Display::None, Vec::new())], Vec::new()),
                    value: json!({}),
                    after: None,
                    prompt: None,
                };
                self.apply_plan(plan, None, tx);
            }
        }
    }

    pub(super) fn op_ref(&self, req: &CoreRequest, result: Option<&Value>) -> Result<Option<OpRef>, CoreError> {
        let Some(op) = &req.op else {
            return Ok(None);
        };
        Ok(Some(OpRef {
            id: text(op.as_str(), "opId")?,
            method: text(req.method.as_str(), "method")?,
            digest: Digest::try_from(ops::digest(&req.params)).expect("digest is well formed"),
            audience: Some(Digest::try_from(mixdog_core_base::ops::replay_audience(&req.ctx).as_str().to_owned()).expect("audience digest is well formed")),
            result: result.and_then(|value| Json::try_from(value.clone()).ok()),
        }))
    }

    /// C2 mutations of a thread (P §7.2): each answers once its records are durable.
    pub(super) fn mutation(&mut self, req: CoreRequest, tx: Waiter) -> Result<(), (CoreError, Waiter)> {
        let fail = |error: CoreError, tx: Waiter, ops: &mut OpTable| {
            if let Some(op) = &req.op {
                ops.failed(op, &error);
            }
            Err((error, tx))
        };
        if !self.outbox.has_room(Class::Normal) {
            let error = CoreError::WindowFull { thread_id: self.id.clone() };
            return fail(error, tx, &mut self.ops);
        }
        // `afterCompaction`: a clear, rewind or compaction waits for the scheduled compaction. A turn
        // is admitted at once (`submitToSession` answers `true`) and queued; its ask waits on the gate.
        if let Some(after) = &mut self.after_compaction
            && matches!(req.method.as_str(), "thread/clear" | "thread/rewind" | "thread/compact/start")
        {
            after.waiting.push(Waiting::Request(req, tx));
            #[cfg(any(test, feature = "test-support"))]
            self.cell.gate_holds.fetch_add(1, SeqCst);
            return Ok(());
        }
        // The `/goal` route (`goalControl`): the Goal runtime answers; no record of its own.
        if matches!(req.method.as_str(), "thread/goal/set" | "thread/goal/clear" | "thread/goal/control") {
            let request = match super::super::goal_lane::control_request(req.method.as_str(), &req.params) {
                Ok(request) => request,
                Err(error) => return fail(error, tx, &mut self.ops),
            };
            let (goals, thread, op) = (self.deps.goals.clone(), self.id.clone(), req.op.clone());
            self.goal_call(Box::pin(async move {
                let result = goals.goal_control(&thread, request).await;
                JobDone::GoalControlled { op, tx, result }
            }));
            return Ok(());
        }
        // `thread/roomView/set {roomView}`: the room runner's activity with no row of its own (a speaker starts, the supervisor
        // is choosing, an approval comes or goes, a turn ends with no row). It takes its turn in this queue, behind the room's
        // earlier posts, so a view can never be published ahead of a row it follows.
        if req.method.as_str() == "thread/roomView/set" {
            let changed =
                if matches!(req.ctx.caller, Caller::Connection(_)) { Err(invalid("method", "an internal method")) } else { self.room_view_change(&req.params) };
            return match changed {
                Ok(change) => {
                    if let Some(change) = change {
                        self.accept_view(change, Vec::new());
                    }
                    let _ = tx.send(Ok(Reply::Value(json!({}))));
                    Ok(())
                }
                Err(error) => fail(error, tx, &mut self.ops),
            };
        }
        if super::super::turn_ops::is_actor_method(req.method.as_str()) {
            return self.turn_op(req, tx);
        }
        // A conditional header patch (`expect`): the read-modify-write of a caller that computed
        // its change from the header, decided here against the header as projected.
        if req.method.as_str() == "thread/header/patch" {
            if let Some(current) = self.header_conflict(&req.params) {
                let _ = tx.send(Ok(Reply::Value(json!({ "conflict": current }))));
                return Ok(());
            }
            // A save issued for an ownership generation (`saveSessionAsync(session, { expectedGeneration })`): dropped
            // when the header it would land on is past that generation (`_dropsAgainst`, `store.mjs:149-153`).
            let expected = req.params.get("expectedGeneration").and_then(Value::as_f64);
            if super::super::close::drops_against(&self.projected.header, expected) {
                let _ = tx.send(Ok(Reply::Value(json!({ "dropped": true }))));
                return Ok(());
            }
        }
        // `restoreQueued` of an entry that is not queued (it started, or was taken) answers
        // `count: 0` and the composer's own text, not an error.
        if req.method.as_str() == "thread/queue/delete"
            && let Some(reply) = self.restore_miss(&req)
        {
            let _ = tx.send(Ok(Reply::Value(reply)));
            return Ok(());
        }
        // A retried submission joins the original (`drain-enqueue.mjs:37`): an idempotent success, not a second prompt. Its
        // receipt is the first committed acceptance of the id: the actor's own, a pending send's answer (joined, success or
        // failure), else the store's index, read before anything after it is taken in.
        let tx = if req.method.as_str() == "turn/start"
            && let Ok(params) = parse::<TurnStartParams>(&req.params, "TurnStartParams")
            && shows_text(&params.input)
            && let Some(id) = submission_id(&params.input).map(str::to_owned)
        {
            if let Some(answer) = self.submissions.answers.get(&id).cloned() {
                let _ = tx.send(Ok(Reply::Value(answer)));
                return Ok(());
            }
            let Some(tx) = self.submissions.join(&id, tx) else { return Ok(()) };
            if self.submission_looked.as_deref() != Some(id.as_str()) {
                self.look_up_submission(id, req, tx);
                return Ok(());
            }
            self.submissions.admit(&id, tx, self.jobs_tx.downgrade())
        } else {
            tx
        };
        let result = match req.method.as_str() {
            "turn/start" => self.turn_start(&req),
            "thread/queue/delete" => self.queue_delete(&req),
            "thread/rewind" => self.rewind(&req),
            "thread/clear" => self.clear(&req),
            "thread/name/set" => self.name_set(&req),
            "thread/header/patch" => self.header_patch(&req),
            "thread/boundary/record" => self.boundary_record(&req),
            "thread/reactions/apply" => self.reactions_apply(&req),
            "thread/roomRows/commit" => self.room_rows_commit(&req),
            _ => Err(invalid("method", "a session-actor method")),
        };
        // Node's own header changes and `inheritFrom`'s carried rows (`target.messages.push`) mutate the session in memory and
        // never refuse on a failed save; a client's change answers the failure. The rows of a room post or an import are kept
        // by the store for the next write, and their request hears the failure. A lifecycle
        // write (a close's tombstone, a generation bump) is Node's durable lifecycle barrier (`session-close.mjs:138`), whose failure its caller hears.
        let lifecycle = req.params.get("set").and_then(Value::as_object).is_some_and(|set| set.contains_key("closed") || set.contains_key("generation"));
        let kept = req.op.is_none()
            && !lifecycle
            && !matches!(req.ctx.caller, Caller::Connection(_))
            // The removal of a refused carry's own mark hears its failure and is tried again: a held one would leave the heir marked
            // (the mark is this core's, Node has none) until some later write.
            && req.ctx.caller != Caller::Internal("inheritance-unmark")
            && (req.method.as_str() == "thread/header/patch" || (req.method.as_str() == "thread/roomRows/commit" && req.ctx.caller == Caller::Internal("inheritance")));
        match result {
            Ok(plan) => {
                // The plan's records are one unit, written together. Rows stored as a conversation (an inheritance, a room
                // post, an import) are kept for the next write when theirs fails, as Node's recorder keeps them.
                self.outbox.begin_unit(req.method.as_str() == "thread/roomRows/commit" && !kept);
                self.apply_plan_kept(plan, req.op.clone(), tx, kept);
                if req.method.as_str() == "thread/header/patch" {
                    let mut keys: Vec<String> =
                        req.params.get("expect").and_then(Value::as_object).map(|expect| expect.keys().cloned().collect()).unwrap_or_default();
                    if req.params.get("expectedGeneration").and_then(Value::as_f64).is_some() {
                        keys.extend(["generation".to_owned(), "closed".to_owned()]);
                    }
                    if !keys.is_empty()
                        && let Some(entry) = self.outbox.last_mut()
                    {
                        entry.effects.push(Effect::Decided(keys));
                    }
                }
                self.outbox.end_unit();
                Ok(())
            }
            Err(error) => fail(error, tx, &mut self.ops),
        }
    }

    fn apply_plan(&mut self, plan: Plan, op: Option<OpId>, tx: Waiter) {
        self.apply_plan_kept(plan, op, tx, false);
    }

    fn apply_plan_kept(&mut self, plan: Plan, op: Option<OpId>, tx: Waiter, kept: bool) {
        let reply = if kept { Effect::Kept { tx: Some(tx), value: plan.value } } else { Effect::Reply { op, tx: Some(tx), value: plan.value } };
        match plan.kind {
            PlanKind::StartRun(input, originals_missing, op_ref) => {
                self.start_run(input, originals_missing, op_ref, Some(reply), plan.prompt);
            }
            PlanKind::Records(records, extra) => {
                let last = records.len().saturating_sub(1);
                let mut reply = Some(reply);
                for (index, (record, class, display, notes)) in records.into_iter().enumerate() {
                    let mut effects = Vec::new();
                    if index == last {
                        effects.extend(reply.take());
                        effects.extend(plan.after.map(|publish| Effect::RecomputePrompts { publish }));
                    }
                    self.accept_record(record, class, display, notes, effects);
                }
                for change in extra {
                    self.accept_view(change, Vec::new());
                }
                if let Some(prompt) = plan.prompt {
                    self.persist_prompt(prompt);
                }
            }
        }
    }

    pub(super) fn turn_start(&mut self, req: &CoreRequest) -> Result<Plan, CoreError> {
        let mut params: TurnStartParams = parse(&req.params, "TurnStartParams")?;
        mixdog_app_protocol::boundary::validate::normalize::turn_input(&mut params.input);
        // An owner's retry of a submission a user Stop froze is not a new user action: it never runs that work again.
        if let Some(submission) = submission_id(&params.input)
            && self.stopped_identity(&mixdog_store::work_stops::submission(submission))
        {
            return Err(coded("session", TURN_STOPPED, "This message was stopped; send it again to run it."));
        }
        let user_prompt = matches!(req.ctx.caller, Caller::Connection(_)).then(|| display_text(&params.input));
        if user_prompt.is_some() && params.input.options.as_ref().is_some_and(|o| o.context.is_some() || o.attachment_sizes.is_some()) {
            return Err(invalid("input.options", "context and attachmentSizes are host-only options"));
        }
        // `submission` (`submission.mjs:10`): a prompt that shows nothing is not a submission. Node answers `false`
        // before the session is touched; the wire answers a refusal with this code.
        if user_prompt.is_some() && !shows_text(&params.input) {
            return Err(coded("session", SUBMIT_REFUSED, "The message is empty."));
        }
        // A deleted bot's chat is kept to read, never to talk to (`submitToSession` asks `sessionMetadata.isRetired`: the
        // retirement stamp, `retiredAt` here).
        if self.projected.header.get("retiredAt").and_then(Value::as_f64).is_some_and(|at| at > 0.0) {
            return Err(coded("session", SUBMIT_REFUSED, "This bot was deleted."));
        }
        // The core holds new turn starts (`hold{on}`): Node's work gate refuses a client's send (`callRefusal`: `HOLD_ALLOWED_CALLS` lets
        // only reads, stops and answers through; `routes.mjs:168-172`, 503), so nothing is queued under a hold. An in-core start waited
        // the hold out before it was admitted (`SessionHandle::turn_start`, Node's `daemonWorkGate.deferring`), so one the hold
        // reached since starts, as Node's admitted start counts as running work. Once the drain commit dropped the hold, a start is
        // refused as admission refuses one.
        match self.core_hold() {
            StartHold::Closed(drain_reason) => return Err(CoreError::ServerShuttingDown { drain_reason }),
            StartHold::Held if matches!(req.ctx.caller, Caller::Connection(_)) => {
                return Err(mixdog_core_base::support::failed("session", turn_ops::HOLD_REFUSAL));
            }
            StartHold::Held | StartHold::Open => {}
        }
        // The device that sent a user prompt rides it (`transcriptMeta.device`, stamped by the host in Node).
        let submitter = match req.ctx.caller {
            Caller::Connection(connection) => Some(Submitter {
                device: self.deps.devices.describe(connection).device,
                restorable: params.input.options.as_ref().and_then(|options| options.kickoff) != Some(true),
            }),
            _ => None,
        };
        if user_prompt.is_some() {
            // `cancelQuotaResumeOnUserInput`: new user input supersedes the stopped turn.
            self.quota_cancel_now();
            let (settlement, id) = (self.quota.settlement.clone(), self.id.as_str().to_owned());
            self.quota.call(async move {
                if let Err(error) = settlement.cancel_on_user_input(&id).await {
                    tracing::warn!("a quota resume was cancelled in memory but its entry was not removed: {error:?}");
                }
            });
            self.archive_goal_on_user_input();
        }
        // A turn starting or still settling, or the scheduled compaction's gate, holds the
        // next one back: it is queued and starts after. A previous turn that is not saved yet holds it too, but as a
        // start that waits for the save ([`Self::start_run_with`]), not as a queued prompt.
        // The originals the acceptance found missing (`SessionHandle::turn_start`): a message built now drops them; a queued
        // entry keeps the submission as it was sent and records them beside it.
        let missing = super::super::staged_originals::missing_of(&req.params);
        if !self.turn_busy() && !self.compaction_held() && self.compactions == 0 && self.clear_holds == 0 {
            let value = json!({ "kind": "started" });
            let op_ref = self.op_ref(req, None)?;
            self.submitter = submitter;
            let originals_missing = super::super::staged_originals::drop_missing(&mut params.input, &missing);
            return Ok(Plan { kind: PlanKind::StartRun(params.input, originals_missing, op_ref), value, after: None, prompt: user_prompt });
        }
        let qid = new_id();
        let value = json!({ "kind": "queued", "queuedId": qid });
        let mut entry = self.queue_entry(&params.input);
        // The entry's `transcriptMeta` (`pending-messages`; read by `mergeSteeringMetadata`,
        // `steering.mjs:62`): the hop and bot chain a host submitter gave this submission. Only a
        // host submission has them (`SubmitOptions` refuses `hop`), registered under its id.
        let host_meta = params.input.options.as_ref().and_then(|o| o.client_submission_id.as_deref()).and_then(|submission| {
            let starts = self.cell.routine_starts.lock().unwrap_or_else(|p| p.into_inner());
            let start = starts.get(submission)?;
            let mut meta = start.meta.clone();
            if let Some(sender) = start.sender {
                meta.entry("sender").or_insert_with(|| json!(sender));
            }
            if let Some(agent) = &start.from_agent {
                meta.entry("fromAgent").or_insert_with(|| json!(agent));
            }
            if let Some(hop) = start.hop {
                meta.insert("hop".into(), json!(hop));
            }
            if !start.bot_chain.is_empty() {
                meta.insert("botChain".into(), json!(start.bot_chain));
            }
            (!meta.is_empty()).then_some(Value::Object(meta))
        });
        if let Some(meta) = host_meta {
            entry["transcriptMeta"] = meta;
        }
        super::super::staged_originals::record_missing(&mut entry, &missing);
        if let Some(submitter) = &submitter {
            with_submitter(&mut entry, submitter);
        }
        let record = Record::Queue(QueueRecord {
            qid: id(&qid),
            action: QueueAction::Enqueue,
            reason: None,
            op: self.op_ref(req, Some(&value))?,
            entry: Some(Slot::Inline(entry.clone())),
        });
        let display = Display::Queued(self.deps.transcript.queued(&qid, &entry));
        let records = vec![(record, Class::Normal, display, Vec::new())];
        // New input ends the running turn's passive `task wait` / shell hold, as today.
        self.deps.wakes.interrupt(&self.id, WakeReason::UserMessage, None);
        Ok(Plan { kind: PlanKind::Records(records, Vec::new()), value, after: None, prompt: user_prompt })
    }

    /// A submission as the queue entry it waits as (`entry-shape.mjs`), before what its submitter adds.
    fn queue_entry(&self, input: &TurnInput) -> Value {
        let mut entry = json!({
            "message": input.prompt,
            "enqueuedAt": self.deps.clock.now_ms(),
        });
        if let Some(options) = &input.options {
            // The entry's priority is its own top-level field, as Node's queue entries carry it
            // (`within_priority`); the options keep the rest.
            let mut options = options.clone();
            if let Some(priority) = options.priority.take() {
                entry["priority"] = serde_json::to_value(priority).expect("protocol types serialize");
            }
            // Likewise the follow-up's `context` (`entry-shape.mjs:32`); the drain gives it back to the turn it starts.
            if let Some(context) = options.context.take() {
                entry["context"] = Value::String(context);
            }
            entry["options"] = serde_json::to_value(&options).expect("protocol types serialize");
        }
        // `defaultQueuePriority` (`queue-helpers.mjs:28`): a user prompt that names none queues at `next`.
        if entry.get("priority").is_none() {
            entry["priority"] = json!("next");
        }
        entry
    }

    /// The `restoreQueued` reply of a hand-back whose entry is not in the queue; `None` for any
    /// other request (a malformed one fails in [`Self::queue_delete`]).
    fn restore_miss(&self, req: &CoreRequest) -> Option<Value> {
        let params: ThreadQueueDeleteParams = parse(&req.params, "ThreadQueueDeleteParams").ok()?;
        let taken = restore_taken(&self.projected.queue, params.queued_id.as_ref().map(QueuedId::as_str));
        (params.restore && taken.is_empty()).then(|| restored_reply(&[], params.current_text.as_deref()))
    }

    fn queue_delete(&mut self, req: &CoreRequest) -> Result<Plan, CoreError> {
        let params: ThreadQueueDeleteParams = parse(&req.params, "ThreadQueueDeleteParams")?;
        // A hand-back without an id takes every queued entry back, as `restoreQueued('', '')` does; a delete
        // names its entry.
        let wanted = match (&params.queued_id, params.restore) {
            (Some(qid), _) => Some(qid.as_str()),
            (None, true) => None,
            (None, false) => return Err(invalid("queuedId", "a queued entry id")),
        };
        let queued = restore_taken(&self.projected.queue, wanted);
        if queued.is_empty() {
            let queued_id = params.queued_id.clone().ok_or_else(|| invalid("queuedId", "a queued entry id"))?;
            return Err(CoreError::QueuedEntryNotFound { thread_id: self.id.clone(), queued_id });
        }
        let taken: Vec<Taken> = queued.iter().map(Taken::of).collect();
        // A hand-back answers Node's `restoreQueued` reply; a plain delete answers `{}`.
        let value = if params.restore { restored_reply(&taken, params.current_text.as_deref()) } else { json!({}) };
        let mut records = Vec::new();
        for (index, entry) in queued.iter().enumerate() {
            // The op's result rides the first record only.
            let op = if index == 0 { self.op_ref(req, Some(&value))? } else { None };
            let record =
                Record::Queue(QueueRecord { qid: id(&entry.qid), action: QueueAction::Dequeue, reason: Some(DequeueReason::Cancelled), op, entry: None });
            records.push((record, Class::Normal, Display::None, Vec::new()));
        }
        let mut extra = Vec::new();
        if params.restore {
            let device = match req.ctx.caller {
                Caller::Connection(connection) => self.deps.devices.describe(connection).device,
                Caller::Internal(name) => name.to_owned(),
            };
            let present = |text: &&String| !mixdog_js::js_trim(text).is_empty();
            let text = taken.iter().map(|entry| &entry.text).filter(present).cloned().collect::<Vec<_>>().join("\n");
            extra.push(Change::Section(Section::PromptRestore(Some(prompt_restore(submissions_of(&queued), text, device, self.deps.clock.now_ms())))));
            extra.extend(taken.into_iter().map(|entry| Change::PromptWithout(entry.text)));
        }
        Ok(Plan { kind: PlanKind::Records(records, extra), value, after: None, prompt: None })
    }

    pub(super) fn history_reset(&self, reason: HistoryResetReason, from: Option<mixdog_core_api::ids::ItemId>) -> Note {
        Note::new(
            "thread/historyReset",
            &ThreadHistoryResetParams {
                thread_id: self.id.clone(),
                reason,
                // A rewind target is inside the window, so the rows older than the window
                // stay; a clear starts an empty lineage.
                has_older: reason == HistoryResetReason::Rewind && self.acked.has_older,
                from_item_id: from,
            },
        )
    }

    /// One `meta` record setting the keys of `set` that differ from the header, or `None` when all agree.
    fn header_set_change(&self, set: serde_json::Map<String, Value>) -> Option<Record> {
        let set: serde_json::Map<String, Value> = set.into_iter().filter(|(key, value)| self.projected.header.get(key) != Some(value)).collect();
        (!set.is_empty()).then(|| Record::Meta(MetaRecord { op: None, change: Slot::Inline(HeaderChange { set, unset: Vec::new() }) }))
    }

    /// `stampTurnHop` / `raiseTurnHop` set `session.turnHop` and `session.turnBotChain`, which the session's
    /// next save writes: the turn's hop and bot chain, as the in-memory turn state holds them now.
    pub(super) fn sync_turn_chain(&mut self) {
        let mut set = serde_json::Map::new();
        set.insert("turnHop".into(), json!(self.cell.turn_chain.hop()));
        set.insert("turnBotChain".into(), json!(self.cell.turn_chain.bots()));
        if let Some(record) = self.header_set_change(set) {
            self.accept_record(record, Class::Normal, Display::None, Vec::new(), Vec::new());
        }
    }

    /// Today's `rewindToItem`: the target is a user row; it and everything after it leave the
    /// lineage, and its text goes back to the composer (and out of the Up-arrow list).
    /// The `meta` record that makes the header's `providerState` `state` (`None` deletes the
    /// key), or `None` when it already is.
    pub(super) fn provider_state_change(&self, state: Option<Value>) -> Option<Record> {
        if self.projected.header.get(PROVIDER_STATE) == state.as_ref() {
            return None;
        }
        let mut change = HeaderChange { set: serde_json::Map::new(), unset: Vec::new() };
        match state {
            Some(state) => {
                change.set.insert(PROVIDER_STATE.into(), state);
            }
            None => change.unset.push(PROVIDER_STATE.into()),
        }
        Some(Record::Meta(MetaRecord { op: None, change: Slot::Inline(change) }))
    }

    /// What [`Inbox::ForkPlan`] answers.
    pub(super) fn fork_plan(&self, idle: bool) -> Result<ForkSource, CoreError> {
        self.history_revision(idle).map(|revision| ForkSource {
            revision,
            header: self.acked.header.clone(),
            active_input: self.run.as_ref().map(|run| run.input_item.clone()),
            _hold: None,
        })
    }

    /// The idle plan of a clear the gate held, answered at its release: no turn starts until its hold is dropped.
    pub(super) fn held_plan(&mut self) -> Result<ForkSource, CoreError> {
        let plan = self.fork_plan(true)?;
        self.clear_holds += 1;
        Ok(ForkSource { _hold: Some(ClearHold(self.jobs_tx.clone())), ..plan })
    }

    pub(super) fn history_revision(&self, idle: bool) -> Result<HistoryRevision, CoreError> {
        if idle && (self.run.is_some() || self.starting) {
            return Err(CoreError::PreconditionFailed {
                precondition: mixdog_core_api::error::Precondition::Revision { expected: "idle".into(), actual: "running".into() },
            });
        }
        if self.after_compaction.is_some()
            || (self.run.is_none() && !self.acked.runs.is_empty())
            || self.outbox.records().any(|record| matches!(record, Record::Item(_) | Record::Amend(_) | Record::Rewind(_) | Record::Compacted(_)))
        {
            return Err(history_conflict());
        }
        Ok(HistoryRevision { log_id: self.log_id.clone(), end: self.acked_end, revision: self.acked.history_rev })
    }

    fn rewind_target(&self, item: &mixdog_core_api::ids::ItemId) -> Result<(usize, u64, String), CoreError> {
        let not_found = || CoreError::ItemNotFound { thread_id: self.id.clone(), item_id: item.clone() };
        let window = &self.acked.window;
        // The client holds the displayed id (a user row shows its submission id); Node resolves it first (`rewind.mjs:19`).
        let index = super::super::transcript::position_of_id(window.iter().map(|row| row.item.as_ref()), item.as_str()).ok_or_else(not_found)?;
        let target = &window[index];
        let (Some(ordinal), Some(text)) = (target.ordinal, target.prompt.clone()) else {
            return Err(not_found());
        };
        Ok((index, ordinal, text))
    }

    pub(super) fn rewind_preview(&self, item: &mixdog_core_api::ids::ItemId) -> Result<RewindPreview, CoreError> {
        let revision = self.history_revision(true)?;
        let (index, _, text) = self.rewind_target(item)?;
        Ok(RewindPreview { revision, item: self.acked.window[index].item.id().clone(), text })
    }

    pub(super) fn before_rewind(&self, cut: usize) -> Option<mixdog_core_api::ids::ItemId> {
        let previous = self.acked.window.get(cut.checked_sub(1)?)?;
        Some(match previous.item.as_ref() {
            ThreadItem::UserMessage { client_submission_id: Some(id), .. } if !id.is_empty() => mixdog_core_api::ids::ItemId::from(id.as_str()),
            item => item.id().clone(),
        })
    }

    pub(super) fn rewind(&mut self, req: &CoreRequest) -> Result<Plan, CoreError> {
        let params: ThreadRewindParams = parse(&req.params, "ThreadRewindParams")?;
        self.history_revision(true)?;
        let (index, ordinal, text) = self.rewind_target(&params.item_id)?;
        let window = &self.acked.window;
        let cut = window.iter().position(|row| row.ordinal.is_some_and(|o| o >= ordinal)).unwrap_or(index);
        let previous = self.before_rewind(cut);
        // `messages`: the model-history messages dropped (`rewindSessionMessagesTo`'s `removed`), beside the rows (`rewind.mjs`).
        let messages: u32 = window.iter().skip(cut).map(|row| row.messages).sum();
        let value = json!({ "text": text, "removed": window.len() - cut, "messages": messages });
        let record = Record::Rewind(RewindRecord { to_ordinal: ordinal, reason: RewindReason::Rewind, op: self.op_ref(req, Some(&value))? });
        self.transcript_rewritten = true;
        // The saved request carried the truncated transcript (`session-crud.mjs:475`).
        self.deps.side.forget(&self.id, false);
        let note = self.history_reset(HistoryResetReason::Rewind, previous);
        let mut records = vec![(record, Class::Normal, Display::None, vec![note])];
        // The provider continuation is keyed on the truncated prefix (`session-crud.mjs:473`).
        if let Some(reset) = self.provider_state_change(None) {
            records.push((reset, Class::Normal, Display::None, Vec::new()));
        }
        Ok(Plan { kind: PlanKind::Records(records, vec![Change::PromptWithout(text)]), value, after: Some(false), prompt: None })
    }

    pub(super) fn clear(&mut self, req: &CoreRequest) -> Result<Plan, CoreError> {
        let _: ThreadOpParams = parse(&req.params, "ThreadOpParams")?;
        let value = json!({});
        let to_ordinal = self.acked.lineage_start;
        let record = Record::Rewind(RewindRecord { to_ordinal, reason: RewindReason::Clear, op: self.op_ref(req, Some(&value))? });
        self.transcript_rewritten = true;
        // The saved request carried the cleared transcript (`session-crud.mjs:345`).
        self.deps.side.forget(&self.id, false);
        let note = self.history_reset(HistoryResetReason::Clear, None);
        let mut records = vec![(record, Class::Normal, Display::None, vec![note])];
        // A cleared session starts without provider state (`session-crud.mjs:137`), and with its
        // environment reset (`resetSessionBp3Environment`), in one header change.
        let mut change = self.deps.route_change.environment_reset(&self.projected.header);
        if self.projected.header.contains_key(PROVIDER_STATE) {
            change.set.shift_remove(PROVIDER_STATE);
            if !change.unset.iter().any(|key| key == PROVIDER_STATE) {
                change.unset.push(PROVIDER_STATE.into());
            }
        }
        // The clear's own facts (`clearSessionMessages`, `session-crud.mjs`): its stage and when it happened. The
        // session-life mark reads `lastClearAt` (`sessionLifeMark`), so what was granted to the cleared conversation
        // ends with it.
        let now = self.deps.clock.now_ms();
        let mut compaction =
            change.set.get("compaction").or_else(|| self.projected.header.get("compaction")).and_then(Value::as_object).cloned().unwrap_or_default();
        compaction.insert("lastStage".into(), json!("auto_clear"));
        compaction.insert("lastCheckedAt".into(), json!(now));
        compaction.insert("lastClearAt".into(), json!(now));
        compaction.insert("lastClearCompactError".into(), Value::Null);
        change.set.insert("compaction".into(), Value::Object(compaction));
        change.unset.retain(|key| key != "compaction");
        let reset = Record::Meta(MetaRecord { op: None, change: Slot::Inline(change) });
        records.push((reset, Class::Normal, Display::None, Vec::new()));
        // `supersedeQuotaResume`: a cleared session's wait goes.
        self.quota_cancel_now();
        let (settlement, id) = (self.quota.settlement.clone(), self.id.as_str().to_owned());
        self.quota.call(async move {
            if let Err(error) = settlement.supersede(&id).await {
                tracing::warn!("a quota resume was superseded in memory but its entry was not removed: {error:?}");
            }
        });
        // A cleared session starts with no toasts (`emptySessionPatch`), and none of the old ones expires (`beginTuiReset`, `session-reset.mjs:50`).
        self.cancel_toast_timers();
        Ok(Plan {
            kind: PlanKind::Records(records, vec![Change::Section(Section::Toasts(Vec::new())), Change::Section(Section::ActiveTools(None))]),
            value,
            after: Some(true),
            prompt: None,
        })
    }

    fn name_set(&mut self, req: &CoreRequest) -> Result<Plan, CoreError> {
        let params: ThreadNameSetParams = parse(&req.params, "ThreadNameSetParams")?;
        // `updateSessionManualTitle` (`session-crud.mjs:103-115`) writes nothing and answers `false` for a closed session, a
        // title that is empty once normalized, and the title the user already gave; the desktop host turns that `false` into
        // `Session is not available.` (`session-host-lifecycle.ts:228`), the text the window shows.
        let refuse = |text: &str| mixdog_core_base::support::failed("thread", text);
        // The checks in the order Node ran them: `sessionDisplayName` (IPC / remote method), then the host's, then the runtime's.
        let shown = mixdog_js::js_trim(&params.title);
        if shown.is_empty() || shown.encode_utf16().count() > 1_024 || shown.chars().any(|c| c <= '\u{1f}' || c == '\u{7f}') {
            return Err(refuse(TITLE_INVALID));
        }
        let title = super::super::session_title::normalize_title(&params.title);
        if title.is_empty() {
            return Err(refuse(SESSION_TITLE_INVALID));
        }
        let header = &self.projected.header;
        let user_titled = header.get("title").and_then(Value::as_str) == Some(title.as_str())
            && header.get("titleLocked") == Some(&Value::Bool(true))
            && header.get("titleSource").and_then(Value::as_str) == Some("user");
        if header.get("closed") == Some(&Value::Bool(true)) || user_titled {
            return Err(refuse(SESSION_NOT_AVAILABLE));
        }
        let value = json!({});
        let mut set = serde_json::Map::new();
        set.insert("title".into(), Value::String(title));
        // A name the user gave, with the keys Node's `updateSessionManualTitle` writes (`session-crud.mjs`):
        // no generated, model or retired-home title replaces it.
        set.insert("titleLocked".into(), Value::Bool(true));
        set.insert("titleSource".into(), Value::String("user".to_owned()));
        set.insert("titleUpdatedAt".into(), json!(self.deps.clock.now_ms()));
        let record = Record::Meta(MetaRecord { op: self.op_ref(req, Some(&value))?, change: Slot::Inline(HeaderChange { set, unset: Vec::new() }) });
        Ok(Plan { kind: PlanKind::Records(vec![(record, Class::Normal, Display::None, Vec::new())], Vec::new()), value, after: None, prompt: None })
    }

    /// After every step: what an archive preparation of this thread judged (its activity, favorite and tree links, its turn,
    /// queue and approvals) moved, so a preparation holding it is void ([`super::super::archive_trees::RetentionMark::moved`]).
    pub(super) fn note_retention_facts(&mut self) {
        let header = self.cell.header.load();
        let facts = super::super::archive_trees::RetentionFacts {
            activity: super::super::sub_agent_retention::activity_at(&header),
            favorite: header.get("favoriteAt").cloned(),
            owner: header.get("ownerSessionId").cloned(),
            parent: header.get("parentSessionId").cloned(),
            busy: self.turn_busy() || self.turn_pending() || self.compactions > 0,
            queued: !self.projected.queue.is_empty(),
            approvals: !self.projected.approvals.is_empty(),
        };
        // The first step only records them: the thread's open or create answers after it, so no preparation held it before.
        if let Some(seen) = self.retention_seen.replace(facts.clone())
            && seen != facts
        {
            self.cell.retention.moved();
        }
    }

    /// The projected values of the keys a patch expects (`expect`: key to the value it was
    /// computed from, `null` for absent) when any of them has moved; `None` when the patch
    /// stands. A patch without `expect` always stands.
    fn header_conflict(&self, params: &Value) -> Option<Value> {
        let expect = params.get("expect")?.as_object()?;
        let current: serde_json::Map<String, Value> =
            expect.keys().map(|key| (key.clone(), self.projected.header.get(key).cloned().unwrap_or(Value::Null))).collect();
        (current != *expect).then_some(Value::Object(current))
    }

    /// `thread/header/patch {set, unset}`: the core's own header writes (held routes, worker
    /// rows), one `meta` record answered once durable. Internal callers only: a connection
    /// never writes header keys directly.
    pub(super) fn header_patch(&mut self, req: &CoreRequest) -> Result<Plan, CoreError> {
        if matches!(req.ctx.caller, Caller::Connection(_)) {
            return Err(invalid("method", "an internal method"));
        }
        let set = match req.params.get("set") {
            None | Some(Value::Null) => serde_json::Map::new(),
            Some(Value::Object(set)) => set.clone(),
            Some(_) => return Err(invalid("set", "an object of header keys")),
        };
        let unset: Vec<String> = match req.params.get("unset") {
            None | Some(Value::Null) => Vec::new(),
            Some(value) => serde_json::from_value(value.clone()).map_err(|_| invalid("unset", "a list of header keys"))?,
        };
        let value = json!({});
        let record = Record::Meta(MetaRecord { op: self.op_ref(req, Some(&value))?, change: Slot::Inline(HeaderChange { set, unset }) });
        Ok(Plan { kind: PlanKind::Records(vec![(record, Class::Normal, Display::None, Vec::new())], Vec::new()), value, after: None, prompt: None })
    }

    /// `thread/boundary/record {anchor, entry, turn?, item?}`: a display-only model-switch
    /// boundary on an already stored row (option (a): no stored row is rewritten), answered once
    /// durable. `item` is the row it shows after the anchor's (`live_model_switch`). Internal
    /// callers only.
    fn boundary_record(&mut self, req: &CoreRequest) -> Result<Plan, CoreError> {
        if matches!(req.ctx.caller, Caller::Connection(_)) {
            return Err(invalid("method", "an internal method"));
        }
        let anchor: Anchor = req
            .params
            .get("anchor")
            .and_then(|anchor| serde_json::from_value(anchor.clone()).ok())
            .ok_or_else(|| invalid("anchor", "{iid, ordinal} of a stored row"))?;
        if anchor.ordinal >= self.acked_end {
            return Err(invalid("anchor", "a row stored before the boundary"));
        }
        let entry: ModelSwitchEntry =
            req.params.get("entry").and_then(|entry| serde_json::from_value(entry.clone()).ok()).ok_or_else(|| invalid("entry", "{provider, modelId, at}"))?;
        let item = match req.params.get("item") {
            None | Some(Value::Null) => None,
            Some(item) => Some(serde_json::from_value::<ThreadItem>(item.clone()).map_err(|_| invalid("item", "a thread item"))?),
        };
        let turn = TurnId::from(req.params.get("turn").and_then(Value::as_str).unwrap_or_default());
        let notes = item
            .iter()
            .map(|item| {
                Note::new("item/completed", &ItemNotificationParams { thread_id: self.id.clone(), turn_id: turn.clone(), item: item.clone(), room_view: None })
            })
            .collect();
        let display = match item {
            Some(item) => Display::Items(vec![Shown::Item(item)]),
            None => Display::None,
        };
        let value = json!({});
        let record = Record::ModelSwitch(ModelSwitchRecord { anchor, op: self.op_ref(req, Some(&value))?, entry: Slot::Inline(entry) });
        Ok(Plan { kind: PlanKind::Records(vec![(record, Class::Normal, display, notes)], Vec::new()), value, after: None, prompt: None })
    }

    /// `thread/reactions/apply {iid, refs, body, turn, items}`: a bot's reaction stored on a
    /// user message, as an amend of that row's body (`meta.transcript.reactions`); `items` are the
    /// row's items re-shown with it, merged into the view and published as `item/completed`.
    /// Internal callers only (the handle's `thread/reactions/set` computes the body).
    fn reactions_apply(&mut self, req: &CoreRequest) -> Result<Plan, CoreError> {
        if matches!(req.ctx.caller, Caller::Connection(_)) {
            return Err(invalid("method", "an internal method"));
        }
        let field = |name: &str| req.params.get(name).cloned().unwrap_or(Value::Null);
        let iid = text(req.params.get("iid").and_then(Value::as_str).unwrap_or_default(), "iid")?;
        let refs: Refs = serde_json::from_value(field("refs")).map_err(|_| invalid("refs", "the row's blob digests"))?;
        let body = field("body");
        if !body.is_object() {
            return Err(invalid("body", "the amended message"));
        }
        let items: Vec<ThreadItem> = serde_json::from_value(field("items")).map_err(|_| invalid("items", "the row's thread items"))?;
        let turn = TurnId::from(req.params.get("turn").and_then(Value::as_str).unwrap_or_default());
        let notes = items
            .iter()
            .map(|item| {
                Note::new("item/completed", &ItemNotificationParams { thread_id: self.id.clone(), turn_id: turn.clone(), item: item.clone(), room_view: None })
            })
            .collect();
        let display = Display::Items(items.into_iter().map(Shown::Update).collect());
        let value = json!({});
        let record = Record::Amend(AmendRecord { iid, op: self.op_ref(req, Some(&value))?, refs, body: Slot::Inline(body) });
        Ok(Plan { kind: PlanKind::Records(vec![(record, Class::Normal, display, notes)], Vec::new()), value, after: None, prompt: None })
    }

    /// `thread/roomRows/commit {messages}`: a room post's new rows (the handle's
    /// `thread/roomRows/append` drops the ones already held), each a model row of no turn shown
    /// live as it lands, then `updatedAt`; answers `{added}` once durable. Internal callers
    /// only.
    fn room_rows_commit(&mut self, req: &CoreRequest) -> Result<Plan, CoreError> {
        if matches!(req.ctx.caller, Caller::Connection(_)) {
            return Err(invalid("method", "an internal method"));
        }
        // Each row as the handle read its facts: `{body, visible, prompt}`.
        let rows = req.params.get("rows").and_then(Value::as_array).cloned().unwrap_or_default();
        let mut records = Vec::with_capacity(rows.len() + 1);
        for mut row in rows {
            let body = row.get_mut("body").map(Value::take).unwrap_or(Value::Null);
            let role = body.get("role").and_then(Value::as_str).map(|role| text(role, "role")).transpose()?;
            let prompt = row.get("prompt").and_then(Value::as_str).map(|prompt| Slot::Inline(prompt.to_owned()));
            let row = ItemRecord {
                iid: text(&new_id(), "itemId")?,
                turn: None,
                role,
                form: Form::Message,
                model: true,
                visible: row.get("visible") != Some(&Value::Bool(false)),
                archive: None,
                op: None,
                prompt,
                refs: Vec::new().try_into().expect("empty list fits"),
                body: Slot::Inline(body),
            };
            records.push((Record::Item(row), Class::Normal, Display::None, Vec::new()));
        }
        let value = json!({ "added": records.len() });
        // Header keys stored with the rows (an inheritance's `inheritedFromSessionId` and title: Node saves them with the
        // carried messages in one save).
        let mut set = match req.params.get("set") {
            Some(Value::Object(set)) => set.clone(),
            _ => serde_json::Map::new(),
        };
        set.insert("updatedAt".into(), json!(self.deps.clock.now_ms()));
        // And the keys the same save drops (an inheritance's copy-in-progress marks: the heir stops inheriting with the
        // write that gives it the rows).
        let unset: Vec<String> = match req.params.get("unset") {
            None | Some(Value::Null) => Vec::new(),
            Some(value) => serde_json::from_value(value.clone()).map_err(|_| invalid("unset", "a list of header keys"))?,
        };
        let meta = Record::Meta(MetaRecord { op: None, change: Slot::Inline(HeaderChange { set, unset }) });
        records.push((meta, Class::Normal, Display::None, Vec::new()));
        // The room's activity as it stands with these rows rides the same plan: released behind the last of them, so the
        // pass publishes them as one revision (`fold_room_view`).
        let view = self.room_view_change(&req.params)?;
        // A row's prompt joins the prompt history as it is applied.
        Ok(Plan { kind: PlanKind::Records(records, view.into_iter().collect()), value, after: None, prompt: None })
    }

    /// The change a `roomView` param asks of the thread's room view (`null` clears it): none when the param is absent or the
    /// view already stands.
    fn room_view_change(&self, params: &Value) -> Result<Option<Change>, CoreError> {
        let Some(view) = params.get("roomView") else { return Ok(None) };
        let view: Option<mixdog_app_protocol::v2::thread::ThreadRoomView> =
            serde_json::from_value(view.clone()).map_err(|_| invalid("roomView", "a room view or null"))?;
        Ok((self.projected.sections.room_view != view).then_some(Change::Section(Section::RoomView(view))))
    }
}
