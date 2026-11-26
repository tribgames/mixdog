//! Run producers: committing items, applying producer messages and draining steers.

use super::*;

fn steer_row_body(input: &SteerInput, stage: DrainStage, now_ms: i64) -> Option<Value> {
    let content = match &input.content {
        Value::Array(_) => mixdog_agent::message_row::content_from_value(&input.content).expect("a queued prompt's parts decode as a stored row's"),
        other => mixdog_core_api::domain::provider::Content::Text(other.as_str().unwrap_or_default().to_owned().into()),
    };
    let entry = mixdog_agent::env::SteerEntry {
        content,
        text: input.text.clone(),
        ids: input.queued_ids.iter().map(|id| id.as_str().to_owned()).collect(),
        submitted_at: input.submitted_at,
        message_id: input.message_id.clone(),
        originals_missing: input.originals_missing,
        transcript_meta: input.transcript_meta.clone(),
        mode: input.mode.clone(),
        execution: input.execution.clone(),
    };
    let merged = mixdog_agent::steer::normalize(&entry)?;
    let (message, _) = mixdog_agent::steer::inject(merged, stage, now_ms, || uuid::Uuid::new_v4().to_string());
    Some(mixdog_agent::message_row::row_of(&message))
}

impl SessionActor {
    /// Answers `tx` once everything accepted so far is on disk (`Ok`; a write a failed save held goes again with it), or
    /// once that write fails (`Err`).
    pub(super) fn when_writes_landed(&mut self, tx: oneshot::Sender<Result<(), RunError>>) {
        match self.outbox.last_id().filter(|through| self.outbox.unwritten_through(*through)) {
            None => {
                let _ = tx.send(Ok(()));
            }
            Some(through) => {
                // What a failed barrier held goes again only with a next write: the pump hands it now. A barrier would not
                // wait for it (a view-only entry behind held ones settles at once), so the waiter watches the records.
                self.retry_due |= self.outbox.has_unsaved() || self.outbox.awaits_retry();
                self.writes_landed.push((through, tx));
            }
        }
    }

    pub(super) fn on_producer(&mut self, msg: ProducerMsg) {
        match msg {
            ProducerMsg::EarlyResult { turn, row } => {
                if !self.active(&turn) {
                    return;
                }
                let commit = ItemCommit {
                    iid: mixdog_core_api::ids::ItemId::from("early-result".to_owned()),
                    role: Some("tool".into()),
                    model: true,
                    visible: true,
                    body: row,
                    prompt: None,
                };
                let Ok(Record::Item(record)) = self.item_record(&turn, commit, RowFacts { visible: true, prompt: None }, None) else { return };
                let Some(token) = self.run.as_ref().map(|run| run.token.clone()) else { return };
                let place = self.producers.reserve();
                let (deps, jobs, end) = (self.deps.clone(), self.jobs_tx.clone(), self.end_form(&record));
                let items = move |lane: &mixdog_rt::InLane<mixdog_rt::CpuInteractive>| (deps.transcript.items_as(lane, &record, end), record);
                // A live preview, bounded by its turn: a stopped turn's answer is an error, which still fills the place.
                mixdog_core_base::support::lane_job(self.deps.lanes.cpu, "early-result", &token, items, move |shown| {
                    let _ = jobs.send(JobDone::EarlyShown { place, turn, shown: shown.ok() });
                });
            }
            ProducerMsg::Commit { turn, mut item, ack } => {
                if !self.active(&turn) {
                    let _ = ack.send(Err(RunError::NotApplied));
                    return;
                }
                let place = self.producers.reserve();
                let body = std::mem::take(&mut item.body);
                self.with_facts(body, move |read| match read {
                    Ok((body, facts)) => JobDone::CommitFacts { place, turn, item: ItemCommit { body, ..item }, facts, ack },
                    Err(error) => JobDone::CommitUnread { place, turn, item, ack, error },
                });
            }
            other if self.producers.places.is_empty() => self.apply_producer(other),
            other => {
                let place = self.producers.reserve();
                self.producers.put(place, PreparedProducer::Message(Box::new(other)));
            }
        }
    }

    pub(super) fn apply_ready_producers(&mut self) {
        while self.outbox.producer_room() {
            match self.producers.pop() {
                Some(PreparedProducer::Message(msg)) => self.apply_producer(*msg),
                Some(PreparedProducer::Job(job)) => self.apply_job(*job),
                None => break,
            }
        }
    }

    pub(super) fn mark_committing(&mut self, turn: &TurnId, item: &ItemCommit) {
        if item.role.as_deref() != Some("assistant") || !self.active(turn) {
            return;
        }
        self.prompt_committed();
        let marker = self.run.as_mut().and_then(|run| {
            let marker = run
                .journal
                .written()
                .then(|| super::super::turn_draft::DraftWrite::Append { rid: run.turn.as_str().to_owned(), body: json!({ "committed": item.iid.as_str() }) });
            run.journal.message_committed();
            marker
        });
        if let Some(marker) = marker {
            self.accept_view_with(Change::Barrier, Vec::new(), vec![Effect::Draft(marker, None)]);
        }
    }

    fn apply_producer(&mut self, msg: ProducerMsg) {
        match msg {
            // In its place among the run's messages: what the run handed over before it is accepted by now.
            ProducerMsg::WritesLanded { ack } => self.when_writes_landed(ack),
            ProducerMsg::Section(Section::Context(context)) => self.on_context_section(context),
            // Node publishes a route value only when it changed (`local-session-runtime.mjs` `publishChanged`).
            ProducerMsg::Section(Section::TurnEffort(effort)) if effort == self.acked.route().turn_effort => {}
            // A read started before this publish may have seen the workspace it replaces: its answer is no longer the latest.
            ProducerMsg::Section(section @ Section::Workspace(_)) => {
                self.live_workspace_reads += 1;
                self.accept_view(Change::Section(section), Vec::new());
            }
            ProducerMsg::Section(section) => self.accept_view(Change::Section(section), Vec::new()),
            ProducerMsg::ItemStarted { turn, item } => {
                if !self.active(&turn) {
                    return;
                }
                if matches!(item, ThreadItem::ToolCall { .. }) {
                    self.visible_progress();
                    self.prompt_committed();
                }
                let note = Note::new(
                    "item/started",
                    &ItemNotificationParams { thread_id: self.id.clone(), turn_id: turn.clone(), item: item.clone(), room_view: None },
                );
                self.accept_view(Change::ItemStarted { turn, item }, vec![note]);
            }
            ProducerMsg::Delta { item, text, method, params } => {
                // Text or reasoning: visible output (`isVisibleStreamProgress`).
                self.visible_progress();
                self.stream_heartbeat();
                let now = self.deps.clock.now_ms();
                // Whitespace is not output (`onTextDelta` marks the prompt committed only for text that trims to something).
                if method == "item/agentMessage/delta" && !mixdog_js::js_trim(&text).is_empty() {
                    self.prompt_shown();
                }
                let mut figure = None;
                if let Some(run) = self.run.as_mut() {
                    match method {
                        "item/agentMessage/delta" => run.live.text(&text, now),
                        "item/reasoning/textDelta" => run.live.reasoning(&text, now),
                        _ => {}
                    }
                    // `onTextDelta` / `onReasoningDelta`: the text joins the call's live figure after it is appended.
                    if matches!(method, "item/agentMessage/delta" | "item/reasoning/textDelta") {
                        figure = run.live_call.text(&text, now);
                    }
                }
                let note = Note { method, params, positioned: None };
                self.accept_view(Change::Delta { item, text }, vec![note]);
                if let Some(figure) = figure {
                    self.patch_spinner([("liveCall", figure)]);
                }
            }
            ProducerMsg::Shown { turn, shown } => {
                if self.active(&turn) {
                    self.run_shown(turn, shown);
                }
            }
            ProducerMsg::EarlyResult { .. } | ProducerMsg::Commit { .. } => unreachable!("rows enter in their prepared place"),
            ProducerMsg::Draft { turn, body, ack } => {
                if !self.active(&turn) {
                    let _ = ack.send(Err(RunError::NotApplied));
                    return;
                }
                let marks = self.deps.sensitive.clone();
                let written = self.run.as_mut().and_then(|run| run.journal.chunk(&body, &*marks, &self.id));
                let Some((body, whole)) = written else {
                    let _ = ack.send(Ok(()));
                    return;
                };
                let rid = turn.as_str().to_owned();
                let write = if whole {
                    super::super::turn_draft::DraftWrite::Replace { rid, body }
                } else {
                    super::super::turn_draft::DraftWrite::Append { rid, body }
                };
                self.accept_view_with(Change::Barrier, Vec::new(), vec![Effect::Draft(write, Some(ack))]);
            }
            ProducerMsg::AppliedSkills { turn, names, ack } => {
                let input = self.run.as_ref().filter(|_| self.active(&turn)).and_then(|run| run.last_model.clone());
                let Some(input) = input else {
                    let _ = ack.send(Err(RunError::NotApplied));
                    return;
                };
                match Self::amend_transcript(&input, "appliedSkills", json!(names)) {
                    Some((record, amended)) => {
                        if let Some(run) = self.run.as_mut() {
                            run.last_model = Some(amended);
                        }
                        self.accept_record(record, Class::Normal, Display::None, Vec::new(), vec![Effect::ItemAck(ack)]);
                    }
                    None => drop(ack.send(Err(RunError::NotApplied))),
                }
            }
            ProducerMsg::ProviderState { turn, state, ack } => {
                if !self.active(&turn) {
                    let _ = ack.send(Err(RunError::NotApplied));
                    return;
                }
                let value = state.map(|state| serde_json::to_value(state).expect("provider state serializes"));
                match self.provider_state_change(value) {
                    Some(record) => self.accept_record(record, Class::Normal, Display::None, Vec::new(), vec![Effect::ItemAck(ack)]),
                    None => drop(ack.send(Ok(()))),
                }
            }
            ProducerMsg::GoalReminder { turn, preview, reply } => self.compaction_reminder_asked(turn, preview, reply),
            ProducerMsg::GoalReminderAcknowledged { revision } => self.compaction_reminder_acknowledged(revision),
            ProducerMsg::ProviderPressure { turn, messages, tools, reply } => {
                let books = self.active(&turn).then(|| self.deps.compaction.books(&self.id, &self.projected.header)).flatten();
                let _ = reply
                    .send(books.map(|books| super::super::usage_books::send_pressure(&self.projected.header, &messages, &tools, &books)).unwrap_or_default());
            }
            ProducerMsg::Header { turn, change, ack } => {
                if !self.active(&turn) {
                    let _ = ack.send(Err(RunError::NotApplied));
                    return;
                }
                let header = &self.projected.header;
                let set: serde_json::Map<String, Value> = change.set.into_iter().filter(|(key, value)| header.get(key) != Some(value)).collect();
                let unset: Vec<String> = change.unset.into_iter().filter(|key| header.contains_key(key)).collect();
                if set.is_empty() && unset.is_empty() {
                    drop(ack.send(Ok(())));
                    return;
                }
                let record = Record::Meta(MetaRecord { op: None, change: Slot::Inline(HeaderChange { set, unset, ..Default::default() }) });
                self.accept_record(record, Class::Normal, Display::None, Vec::new(), vec![Effect::ItemAck(ack)]);
            }
            ProducerMsg::Compacted { turn, compaction, header, ack } => {
                self.accept_compacted(turn, compaction, header, ack);
            }
            ProducerMsg::ContextRewound { turn, replacement, unchanged, ack } => {
                if !self.active(&turn) {
                    let _ = ack.send(Err(RunError::NotApplied));
                    return;
                }
                // The reset, the replacement and the count it leaves are one unit, as a compaction's are.
                self.outbox.begin_unit(false);
                if !unchanged {
                    self.transcript_rewritten = true;
                    // The provider continuation described the rows that left.
                    if let Some(reset) = self.provider_state_change(None) {
                        self.accept_record(reset, Class::Normal, Display::None, Vec::new(), Vec::new());
                    }
                }
                // Nothing leaves the transcript (`dropped_count: 0`, no identities) and no divider
                // is shown, live or restored (`silent`): only the model context restarts.
                let record = Record::Compacted(CompactedRecord {
                    cid: id(&new_id()),
                    summary_iid: None,
                    op: None,
                    at: Some(self.deps.clock.now_ms()),
                    dropped_count: Some(0),
                    dropped: None,
                    silent: Some(true),
                    replacement: Slot::Inline(replacement.into_iter().map(|(iid, body)| ReplacementEntry { iid: iid.as_str().to_owned(), body }).collect()),
                });
                self.accept_record(record, Class::Normal, Display::None, Vec::new(), vec![Effect::ItemAck(ack)]);
                self.outbox.end_unit();
            }
            ProducerMsg::PromptRewound { turn, item, ack } => {
                if !self.active(&turn) {
                    let _ = ack.send(Err(RunError::NotApplied));
                    return;
                }
                // The thread's own rewind (`rewind`), at the prompt's row: it, and every row after it, leave. A prompt that shows no
                // row (a kickoff) is the acked hidden one; the row before it is the newest shown row older than it.
                let window = &self.acked.window;
                let found = match window.iter().position(|row| row.item.id() == &item) {
                    Some(index) => window[index].ordinal,
                    None => self.acked.hidden_prompt.as_ref().filter(|(iid, _)| iid.as_str() == item.as_str()).map(|&(_, ordinal)| ordinal),
                };
                let Some(ordinal) = found else {
                    let _ = ack.send(Err(RunError::NotApplied));
                    return;
                };
                let cut = window.iter().position(|row| row.ordinal.is_some_and(|o| o >= ordinal));
                // A hidden prompt with no shown row after it takes no row from the screen: Node's store never held one, so its
                // rows are not replaced (no `structureRevision`).
                let note = cut.map(|cut| self.history_reset(HistoryResetReason::Rewind, self.before_rewind(cut)));
                let record = Record::Rewind(RewindRecord { to_ordinal: ordinal, reason: RewindReason::Rewind, op: None });
                self.transcript_rewritten = true;
                self.deps.side.forget(&self.id, crate::session::turn_ops::SideEnd::Transcript);
                let notes: Vec<Note> = note.into_iter().collect();
                // The provider continuation described the rows that left.
                match self.provider_state_change(None) {
                    None => self.accept_record(record, Class::Normal, Display::None, notes, vec![Effect::ItemAck(ack)]),
                    Some(reset) => {
                        self.accept_record(record, Class::Normal, Display::None, notes, Vec::new());
                        self.accept_record(reset, Class::Normal, Display::None, Vec::new(), vec![Effect::ItemAck(ack)]);
                    }
                }
            }
            ProducerMsg::TakeSteers { turn, request, reply } => {
                self.take_steers(turn, request, reply, std::collections::HashMap::new());
            }
            ProducerMsg::PeekSteers { turn, request, reply } => {
                self.peek_steers(turn, request, reply);
            }
            ProducerMsg::ConsumeSteers { turn, request, qids, now_ms, cancel, gate, reply } => {
                self.prepare_consume_steers(turn, request, qids, now_ms, cancel, gate, reply);
            }
            ProducerMsg::FinishConsumeSteers { turn, request, qids, now_ms, cancel, gate, prepared, reply } => {
                self.finish_consume_steers(turn, request, qids, now_ms, cancel, gate, prepared, reply);
            }
        }
    }

    /// `drainPendingSteering` for a run's boundary. A queued Goal entry is delivered only while
    /// its Goal still wants it (`canDeliverSteeringEntry`); the check reads the Goal runtime, so
    /// the drain waits for it and comes back here with `checked` (a Goal entry's queue id -> due).
    pub(super) fn take_steers(
        &mut self,
        turn: TurnId,
        request: DrainRequest,
        reply: oneshot::Sender<Vec<SteerInput>>,
        checked: std::collections::HashMap<String, bool>,
    ) {
        if !self.active(&turn) || reply.is_closed() || self.run.as_ref().is_some_and(|run| run.token.is_cancelled()) {
            let _ = reply.send(Vec::new());
            return;
        }
        let max_priority = request.max_priority;
        // The Goal reads come before anything is taken: a drain that waits for them has claimed, raised and dequeued nothing, and
        // decides what it takes when it comes back. Only a terminal boundary takes a Goal entry (one is no notification, so the
        // rest it sits in never holds only notifications), and no steered or host prompt is one.
        if request.stage == DrainStage::Terminal && !self.route_held() {
            let unchecked: Vec<(String, Value)> = self
                .durable_rest(&self.drain_rest(&[], max_priority))
                .into_iter()
                .filter(|(qid, entry)| super::super::goal_lane::is_goal_entry(entry) && !checked.contains_key(qid.as_str()))
                .map(|(qid, entry)| (qid.as_str().to_owned(), entry))
                .collect();
            if !unchecked.is_empty() {
                self.check_steer_goals(turn, request, reply, checked, unchecked);
                return;
            }
        }
        let mut taken: Vec<QueuedId> = Vec::new();
        let mut dropped: Vec<QueuedId> = Vec::new();
        let mut out: Vec<SteerInput> = Vec::new();
        // The steered entries first, then the host's own queued prompts (`drainPendingSteering`, `session-flow/steering.mjs:204`):
        // every typed prompt within the drain's priority is its own input at every boundary, never merged.
        let host_prompts: Vec<QueuedId> = self
            .projected
            .queue
            .iter()
            .filter(|q| {
                !self.steer_marked.iter().any(|s| s.as_str() == q.qid)
                    && !completions::is_notification(&q.entry)
                    && !super::super::goal_lane::is_goal_entry(&q.entry)
                    && !pending::is_slash_entry(&q.entry)
            })
            .map(|q| QueuedId::from(q.qid.as_str()))
            .collect();
        // Every boundary takes the most urgent first, and of one priority the queue's order (a later promotion sits ahead of
        // an earlier one: `prioritizeQueued` puts it at the front; `dequeueQueueBatch`).
        let mut candidates: Vec<QueuedId> = self.steer_marked.iter().cloned().chain(host_prompts).collect();
        let position = |qid: &QueuedId| self.projected.queue.iter().position(|q| q.qid == qid.as_str());
        candidates.sort_by_key(|qid| (position(qid).map_or(u8::MAX, |at| priority_rank(&self.projected.queue[at].entry)), position(qid)));
        for qid in candidates {
            // Eligibility reads the accepted queue the order was chosen from: a promotion still being saved counts at both. An entry
            // whose enqueue is not durable yet waits. No boundary injects work a user Stop froze.
            let Some(entry) = self
                .projected
                .queue
                .iter()
                .find(|q| q.qid == qid.as_str() && within_priority(&q.entry, max_priority) && !self.queued_stopped(q))
                .filter(|q| self.acked.queue.iter().any(|acked| acked.qid == q.qid))
                .map(|q| q.entry.clone())
            else {
                continue;
            };
            let delivered = if super::super::goal_lane::is_goal_entry(&entry) { Ok(self.late_delivery(&entry)) } else { self.deliverable_entry(&entry) };
            let delivered = match delivered {
                Ok(delivered) => delivered,
                Err(why) => {
                    self.refuse_queued(qid.as_str(), &entry, &why);
                    self.steer_marked.retain(|marked| marked.as_str() != qid.as_str());
                    continue;
                }
            };
            // The start gate: the run claims the entry under the lock a latch from outside the actor takes; a latched one is
            // not injected.
            if !self.claim_steer(&turn, qid.as_str(), &entry) {
                continue;
            }
            // `raiseTurnHop(opts.session, merged.transcriptMeta)` (`steering.mjs:145`): a
            // bot's message at a higher hop makes the running turn bot-descended at that hop.
            self.cell.turn_chain.raise(pending::steered_meta(&entry));
            let entry = delivered;
            out.push(pending::steered(qid.clone(), &entry));
            taken.push(qid);
        }
        self.steer_marked.retain(|qid| !taken.contains(qid));
        self.sync_turn_chain();
        // `if (turn.session?.heldRoute) return out;` (`ask-turn-steering-drain.mjs:48`).
        if !self.route_held() {
            let rest = self.drain_rest(&taken, max_priority);
            // `stage === 'terminal' || pendingQueueHoldsOnlyNotifications(sessionId)`.
            let only_notifications = !rest.is_empty() && rest.iter().all(|q| completions::is_notification(&q.entry));
            if request.stage == DrainStage::Terminal || only_notifications {
                let durable = self.durable_rest(&rest);
                // A Goal entry its Goal no longer wants is dequeued and never delivered.
                let (deliver, gone): (Vec<_>, Vec<_>) =
                    durable.into_iter().partition(|(qid, entry)| !super::super::goal_lane::is_goal_entry(entry) || checked.get(qid.as_str()) == Some(&true));
                dropped.extend(gone.into_iter().map(|(qid, _)| qid));
                // A stale user entry is delivered under its late-delivery header (`hydratePendingMessages`).
                let mut refused: Vec<(QueuedId, Value, String)> = Vec::new();
                let deliver: Vec<(QueuedId, Value)> = deliver
                    .into_iter()
                    .filter_map(|(qid, entry)| {
                        if super::super::goal_lane::is_goal_entry(&entry) {
                            return Some((qid, entry));
                        }
                        match self.deliverable_entry(&entry) {
                            Ok(delivered) => Some((qid, delivered)),
                            Err(why) => {
                                refused.push((qid, entry, why));
                                None
                            }
                        }
                    })
                    .collect();
                for (qid, entry, why) in refused {
                    self.refuse_queued(qid.as_str(), &entry, &why);
                }
                let deliver: Vec<(QueuedId, Value)> = deliver.into_iter().filter(|(qid, entry)| self.claim_steer(&turn, qid.as_str(), entry)).collect();
                let groups = pending::groups(&deliver);
                // Nothing that carries content is released back to the queue.
                if !groups.is_empty() {
                    for meta in pending::group_metas(&deliver) {
                        self.cell.turn_chain.raise(Some(meta));
                    }
                    self.sync_turn_chain();
                    taken.extend(deliver.into_iter().map(|(qid, _)| qid));
                    out.extend(groups);
                }
            }
        }
        self.finish_steers(&taken, &dropped);
        let _ = reply.send(out);
    }

    fn peek_steers(&mut self, turn: TurnId, request: DrainRequest, reply: oneshot::Sender<Vec<SteerInput>>) {
        if !self.active(&turn) || reply.is_closed() || self.run.as_ref().is_some_and(|run| run.token.is_cancelled()) {
            let _ = reply.send(Vec::new());
            return;
        }
        let max_priority = request.max_priority;
        let mut taken: Vec<QueuedId> = Vec::new();
        let mut out: Vec<SteerInput> = Vec::new();
        let host_prompts: Vec<QueuedId> = self
            .projected
            .queue
            .iter()
            .filter(|q| {
                !self.steer_marked.iter().any(|s| s.as_str() == q.qid)
                    && !completions::is_notification(&q.entry)
                    && !super::super::goal_lane::is_goal_entry(&q.entry)
                    && !pending::is_slash_entry(&q.entry)
            })
            .map(|q| QueuedId::from(q.qid.as_str()))
            .collect();
        let mut candidates: Vec<QueuedId> = self.steer_marked.iter().cloned().chain(host_prompts).collect();
        let position = |qid: &QueuedId| self.projected.queue.iter().position(|q| q.qid == qid.as_str());
        candidates.sort_by_key(|qid| (position(qid).map_or(u8::MAX, |at| priority_rank(&self.projected.queue[at].entry)), position(qid)));
        for qid in candidates {
            let Some(entry) = self
                .projected
                .queue
                .iter()
                .find(|q| q.qid == qid.as_str() && within_priority(&q.entry, max_priority) && !self.queued_stopped(q))
                .filter(|q| self.acked.queue.iter().any(|acked| acked.qid == q.qid))
                .map(|q| q.entry.clone())
            else {
                continue;
            };
            let Ok(delivered) = (if super::super::goal_lane::is_goal_entry(&entry) { Ok(self.late_delivery(&entry)) } else { self.deliverable_entry(&entry) })
            else {
                continue;
            };
            if !self.can_claim_steer(qid.as_str(), &entry) {
                continue;
            }
            out.push(pending::steered(qid.clone(), &delivered));
            taken.push(qid);
        }
        if !self.route_held() {
            let rest = self.drain_rest(&taken, max_priority);
            let only_notifications = !rest.is_empty() && rest.iter().all(|q| completions::is_notification(&q.entry));
            if request.stage == DrainStage::Terminal || only_notifications {
                let deliver: Vec<(QueuedId, Value)> = self
                    .durable_rest(&rest)
                    .into_iter()
                    .filter_map(|(qid, entry)| {
                        if super::super::goal_lane::is_goal_entry(&entry) {
                            return None;
                        }
                        let delivered = self.deliverable_entry(&entry).ok()?;
                        self.can_claim_steer(qid.as_str(), &delivered).then_some((qid, delivered))
                    })
                    .collect();
                out.extend(pending::groups(&deliver));
            }
        }
        let _ = reply.send(out);
    }

    fn preview_consume_steers(&self, request: DrainRequest, qids: &[QueuedId]) -> Vec<SteerInput> {
        let max_priority = request.max_priority;
        let matches_queued = |q: &super::super::state::Queued| {
            let sub = q.entry.pointer("/options/clientSubmissionId").and_then(Value::as_str).filter(|id| !id.is_empty());
            qids.iter().any(|wanted| wanted.as_str() == q.qid || sub == Some(wanted.as_str()))
        };
        let mut taken: Vec<QueuedId> = Vec::new();
        let mut out: Vec<SteerInput> = Vec::new();
        let host_prompts: Vec<QueuedId> = self
            .projected
            .queue
            .iter()
            .filter(|q| {
                matches_queued(q)
                    && !self.steer_marked.iter().any(|s| s.as_str() == q.qid)
                    && !completions::is_notification(&q.entry)
                    && !super::super::goal_lane::is_goal_entry(&q.entry)
                    && !pending::is_slash_entry(&q.entry)
            })
            .map(|q| QueuedId::from(q.qid.as_str()))
            .collect();
        let mut candidates: Vec<QueuedId> = self
            .steer_marked
            .iter()
            .filter(|qid| self.projected.queue.iter().find(|q| q.qid == qid.as_str()).is_some_and(matches_queued))
            .cloned()
            .chain(host_prompts)
            .collect();
        let position = |qid: &QueuedId| self.projected.queue.iter().position(|q| q.qid == qid.as_str());
        candidates.sort_by_key(|qid| (position(qid).map_or(u8::MAX, |at| priority_rank(&self.projected.queue[at].entry)), position(qid)));
        for qid in candidates {
            let Some(entry) = self
                .projected
                .queue
                .iter()
                .find(|q| q.qid == qid.as_str() && within_priority(&q.entry, max_priority) && !self.queued_stopped(q))
                .filter(|q| self.acked.queue.iter().any(|acked| acked.qid == q.qid))
                .map(|q| q.entry.clone())
            else {
                continue;
            };
            let Ok(delivered) = (if super::super::goal_lane::is_goal_entry(&entry) { Ok(self.late_delivery(&entry)) } else { self.deliverable_entry(&entry) })
            else {
                continue;
            };
            if !self.can_claim_steer(qid.as_str(), &entry) {
                continue;
            }
            out.push(pending::steered(qid.clone(), &delivered));
            taken.push(qid);
        }
        if !self.route_held() {
            let rest: Vec<_> = self.drain_rest(&taken, max_priority).into_iter().filter(|q| matches_queued(q)).collect();
            let only_notifications = !rest.is_empty() && rest.iter().all(|q| completions::is_notification(&q.entry));
            if request.stage == DrainStage::Terminal || only_notifications {
                let deliver: Vec<(QueuedId, Value)> = self
                    .durable_rest(&rest)
                    .into_iter()
                    .filter_map(|(qid, entry)| {
                        if super::super::goal_lane::is_goal_entry(&entry) {
                            return None;
                        }
                        let delivered = self.deliverable_entry(&entry).ok()?;
                        self.can_claim_steer(qid.as_str(), &delivered).then_some((qid, delivered))
                    })
                    .collect();
                out.extend(pending::groups(&deliver));
            }
        }
        out
    }

    #[allow(clippy::too_many_arguments)]
    fn prepare_consume_steers(
        &mut self,
        turn: TurnId,
        request: DrainRequest,
        qids: Vec<QueuedId>,
        now_ms: i64,
        cancel: CancellationToken,
        gate: Arc<super::super::run::SteerConsumeGate>,
        reply: oneshot::Sender<Result<(Vec<SteerInput>, Option<oneshot::Receiver<Result<(), RunError>>>), RunError>>,
    ) {
        if !self.active(&turn) || qids.is_empty() {
            let _ = reply.send(Ok((Vec::new(), None)));
            return;
        }
        if reply.is_closed() || cancel.is_cancelled() || !gate.is_pending() || self.run.as_ref().is_some_and(|run| run.token.is_cancelled()) {
            let _ = reply.send(Err(RunError::Cancelled));
            return;
        }
        let preview = self.preview_consume_steers(request, &qids);
        if preview.is_empty() {
            let _ = reply.send(Ok((Vec::new(), None)));
            return;
        }
        let work: Vec<(Vec<QueuedId>, Value, Option<String>)> = preview
            .into_iter()
            .filter_map(|input| {
                let body = steer_row_body(&input, request.stage, now_ms)?;
                let unseen_card = body
                    .pointer(CARD_ID)
                    .and_then(Value::as_str)
                    .filter(|card| !self.projected.window.iter().any(|row| row.item.id().as_str() == *card))
                    .map(str::to_owned);
                Some((input.queued_ids, body, unseen_card))
            })
            .collect();
        if work.is_empty() {
            self.finish_consume_steers(turn, request, qids, now_ms, cancel, gate, Ok(Vec::new()), reply);
            return;
        }
        let (store, records, thread, prod_tx) = (self.deps.attachments.clone(), self.deps.store.clone(), self.id.clone(), self.ch.prod_tx.clone());
        let job_cancel = cancel.clone();
        mixdog_core_base::support::lane_job(
            self.deps.lanes.io,
            "steer-facts",
            &job_cancel,
            move |lane| {
                work.into_iter()
                    .map(|(queued_ids, mut body, unseen_card)| {
                        let facts = store.facts(lane, &mut body);
                        if let Some(card) = unseen_card
                            && !matches!(records.history_row(lane, &thread, &card), Ok(Some(_)))
                            && let Some(transcript) = body.pointer_mut("/meta/transcript").and_then(Value::as_object_mut)
                        {
                            transcript.shift_remove("cardId");
                            transcript.insert("cardCut".into(), Value::Bool(true));
                        }
                        (queued_ids, body, facts)
                    })
                    .collect::<Vec<_>>()
            },
            move |read| {
                let msg = ProducerMsg::FinishConsumeSteers { turn, request, qids, now_ms, cancel, gate, prepared: read, reply };
                if let Err(tokio::sync::mpsc::error::TrySendError::Full(msg)) = prod_tx.try_send(msg) {
                    drop(mixdog_rt::spawn("session.consume-steers", mixdog_rt::TaskClass::Work, async move {
                        let _ = prod_tx.send(msg).await;
                    }));
                }
            },
        );
    }

    #[allow(clippy::too_many_arguments)]
    fn finish_consume_steers(
        &mut self,
        turn: TurnId,
        request: DrainRequest,
        qids: Vec<QueuedId>,
        now_ms: i64,
        cancel: CancellationToken,
        gate: Arc<super::super::run::SteerConsumeGate>,
        prepared: Result<Vec<(Vec<QueuedId>, Value, RowFacts)>, CoreError>,
        reply: oneshot::Sender<Result<(Vec<SteerInput>, Option<oneshot::Receiver<Result<(), RunError>>>), RunError>>,
    ) {
        if !self.active(&turn) || qids.is_empty() {
            let _ = reply.send(Ok((Vec::new(), None)));
            return;
        }
        let cancelled = || reply.is_closed() || cancel.is_cancelled() || self.run.as_ref().is_some_and(|run| run.token.is_cancelled());
        if cancelled() || !gate.is_pending() {
            let _ = reply.send(Err(RunError::Cancelled));
            return;
        }
        let mut prepared: std::collections::HashMap<Vec<QueuedId>, (Value, RowFacts)> = match prepared {
            Ok(rows) => rows.into_iter().map(|(ids, body, facts)| (ids, (body, facts))).collect(),
            Err(error) => {
                tracing::warn!(thread = %self.id, "steered rows were not committed: facts could not be read ({error:?})");
                let _ = reply.send(Err(RunError::NotApplied));
                return;
            }
        };
        // Cross the commit point atomically after re-checking cancellation right before mutating state or outbox:
        // checking both before and after `try_commit` ensures a concurrent cancel cannot race past `PENDING`.
        if cancelled() || !gate.try_commit() || cancelled() {
            let _ = reply.send(Err(RunError::Cancelled));
            return;
        }
        let max_priority = request.max_priority;
        let matches_queued = |q: &super::super::state::Queued| {
            let sub = q.entry.pointer("/options/clientSubmissionId").and_then(Value::as_str).filter(|id| !id.is_empty());
            qids.iter().any(|wanted| wanted.as_str() == q.qid || sub == Some(wanted.as_str()))
        };
        let mut taken: Vec<QueuedId> = Vec::new();
        let mut out: Vec<SteerInput> = Vec::new();
        let host_prompts: Vec<QueuedId> = self
            .projected
            .queue
            .iter()
            .filter(|q| {
                matches_queued(q)
                    && !self.steer_marked.iter().any(|s| s.as_str() == q.qid)
                    && !completions::is_notification(&q.entry)
                    && !super::super::goal_lane::is_goal_entry(&q.entry)
                    && !pending::is_slash_entry(&q.entry)
            })
            .map(|q| QueuedId::from(q.qid.as_str()))
            .collect();
        let mut candidates: Vec<QueuedId> = self
            .steer_marked
            .iter()
            .filter(|qid| self.projected.queue.iter().find(|q| q.qid == qid.as_str()).is_some_and(matches_queued))
            .cloned()
            .chain(host_prompts)
            .collect();
        let position = |qid: &QueuedId| self.projected.queue.iter().position(|q| q.qid == qid.as_str());
        candidates.sort_by_key(|qid| (position(qid).map_or(u8::MAX, |at| priority_rank(&self.projected.queue[at].entry)), position(qid)));
        for qid in candidates {
            let Some(entry) = self
                .projected
                .queue
                .iter()
                .find(|q| q.qid == qid.as_str() && within_priority(&q.entry, max_priority) && !self.queued_stopped(q))
                .filter(|q| self.acked.queue.iter().any(|acked| acked.qid == q.qid))
                .map(|q| q.entry.clone())
            else {
                continue;
            };
            let delivered = if super::super::goal_lane::is_goal_entry(&entry) { Ok(self.late_delivery(&entry)) } else { self.deliverable_entry(&entry) };
            let delivered = match delivered {
                Ok(delivered) => delivered,
                Err(why) => {
                    self.refuse_queued(qid.as_str(), &entry, &why);
                    self.steer_marked.retain(|marked| marked.as_str() != qid.as_str());
                    continue;
                }
            };
            let steered = pending::steered(qid.clone(), &delivered);
            if !prepared.contains_key(&steered.queued_ids) && steer_row_body(&steered, request.stage, now_ms).is_some() {
                continue;
            }
            if !self.claim_steer(&turn, qid.as_str(), &entry) {
                continue;
            }
            self.cell.turn_chain.raise(pending::steered_meta(&entry));
            out.push(steered);
            taken.push(qid);
        }
        self.steer_marked.retain(|qid| !taken.contains(qid));
        self.sync_turn_chain();
        if !self.route_held() {
            let rest: Vec<_> = self.drain_rest(&taken, max_priority).into_iter().filter(|q| matches_queued(q)).collect();
            let only_notifications = !rest.is_empty() && rest.iter().all(|q| completions::is_notification(&q.entry));
            if request.stage == DrainStage::Terminal || only_notifications {
                let durable = self.durable_rest(&rest);
                let mut refused: Vec<(QueuedId, Value, String)> = Vec::new();
                let deliver: Vec<(QueuedId, Value)> = durable
                    .into_iter()
                    .filter_map(|(qid, entry)| {
                        if super::super::goal_lane::is_goal_entry(&entry) {
                            return None;
                        }
                        match self.deliverable_entry(&entry) {
                            Ok(delivered) => Some((qid, delivered)),
                            Err(why) => {
                                refused.push((qid, entry, why));
                                None
                            }
                        }
                    })
                    .collect();
                for (qid, entry, why) in refused {
                    self.refuse_queued(qid.as_str(), &entry, &why);
                }
                let deliver: Vec<(QueuedId, Value)> = deliver
                    .into_iter()
                    .filter(|(qid, entry)| {
                        let single = pending::groups(std::slice::from_ref(&(qid.clone(), entry.clone())));
                        single.iter().all(|input| prepared.contains_key(&input.queued_ids) || steer_row_body(input, request.stage, now_ms).is_none())
                            && self.claim_steer(&turn, qid.as_str(), entry)
                    })
                    .collect();
                let groups = pending::groups(&deliver);
                if !groups.is_empty() {
                    for meta in pending::group_metas(&deliver) {
                        self.cell.turn_chain.raise(Some(meta));
                    }
                    self.sync_turn_chain();
                    taken.extend(deliver.into_iter().map(|(qid, _)| qid));
                    out.extend(groups);
                }
            }
        }
        if taken.is_empty() {
            let _ = reply.send(Ok((Vec::new(), None)));
            return;
        }
        // Commit all dequeue records and their transcript rows in one atomic outbox unit so a crash
        // can never leave a submission dequeued without its transcript row.
        let first = self.outbox.next_id();
        self.outbox.begin_unit(false);
        self.finish_steers(&taken, &[]);
        for input in &out {
            let Some((body, facts)) = prepared.remove(&input.queued_ids) else {
                continue;
            };
            let item =
                ItemCommit { iid: mixdog_core_api::ids::ItemId::from(new_id()), role: Some("user".to_owned()), model: true, visible: true, body, prompt: None };
            let display = self.row_display(item.role.as_deref(), &item.body);
            if let Some(active) = self.cell.run.load().as_ref() {
                active.unsaved_messages.fetch_add(1, SeqCst);
            }
            if let Ok(record) = self.item_record(&turn, item, facts, None) {
                if let (Record::Item(row), Some(run)) = (&record, self.run.as_mut())
                    && row.model
                {
                    run.last_model = Some(row.clone());
                }
                self.accept_record(record, Class::Normal, display, Vec::new(), Vec::new());
            }
        }
        let (ack_tx, ack_rx) = oneshot::channel();
        let durable = if let Some(entry) = self.outbox.last_durable_mut(first) {
            // Use `MarkAck` (a client-answering durability effect) so recoverable journal write failures
            // roll back the unit and return `Err(RunError::NotApplied)` instead of releasing `Ok(())`.
            entry.effects.push(Effect::MarkAck(ack_tx));
            Some(ack_rx)
        } else {
            None
        };
        self.outbox.end_unit();
        let _ = reply.send(Ok((out, durable)));
    }

    fn finish_steers(&mut self, taken: &[QueuedId], dropped: &[QueuedId]) {
        for qid in taken {
            // A completion the listener already showed comes back as the turn's row
            // with no row of its own (`suppressDisplay`); so does a notice the Goal lane queued
            // for the model alone, which has no execution to name: its queue id stands for it.
            if let Some(q) = self.acked.queue.iter().find(|q| q.qid == qid.as_str()) {
                // A host submission steered in settles with this turn (`turnSettlements.set(epoch, ...)`,
                // `steering.mjs:219`).
                let submission = q.entry.pointer("/options/clientSubmissionId").and_then(Value::as_str).unwrap_or_default();
                // Whatever a boundary injects (a prompt, a completion, a Goal notice) is the running turn's own work from here: its
                // identities join the run's, so a Stop of the run, or a targeted Stop of one of them, finds it.
                if let Some(run) = self.run.as_mut() {
                    run.work.qids.push(qid.as_str().to_owned());
                    if !submission.is_empty() && !run.work.submissions.iter().any(|owned| owned == submission) {
                        run.work.submissions.push(submission.to_owned());
                    }
                    let submissions = Some(submission.to_owned()).filter(|id| !id.is_empty()).into_iter().collect();
                    run.injected.push(WorkRef { id: qid.as_str().to_owned(), qids: vec![qid.as_str().to_owned()], submissions, handback: None });
                }
                let joined = self.cell.routine_starts.lock().unwrap_or_else(|p| p.into_inner()).remove(submission);
                if let (Some(start), Some(run)) = (joined, self.run.as_mut()) {
                    (start.on_start)();
                    run.joined.push(start.done);
                }
                if let Some(execution) = suppressed_execution(&q.entry) {
                    self.suppressed.insert(execution);
                } else if q.entry.get("suppressDisplay") == Some(&Value::Bool(true)) {
                    self.suppressed.insert(qid.as_str().to_owned());
                }
            }
        }
        for qid in taken.iter().chain(dropped) {
            self.accept_record(dequeue(qid.as_str()), Class::Control, Display::None, Vec::new(), Vec::new());
        }
        // A user message the drain left queued (beyond its priority) is still unanswered: a `task wait` must not start.
        let user_pending = self.projected.queue.iter().any(|q| {
            !taken.iter().chain(dropped).any(|t| t.as_str() == q.qid)
                && !completions::is_notification(&q.entry)
                && !super::super::goal_lane::is_goal_entry(&q.entry)
                && !pending::is_slash_entry(&q.entry)
        });
        // Likewise a notification due now (a `later` channel notice is not due before the turn ends).
        let notice_pending = self
            .projected
            .queue
            .iter()
            .any(|q| {
                !taken.iter().chain(dropped).any(|t| t.as_str() == q.qid) && completions::is_notification(&q.entry) && within_priority(&q.entry, Priority::Next)
            })
            .then_some(None);
        self.deps.wakes.boundary(&self.id, user_pending, notice_pending);
    }

    /// The queue a drain leaves past what it took (`taken`): not steered, not claimed by a wake, within the drain's priority
    /// (entries beyond it wait for the turn to end), most urgent first.
    fn drain_rest(&self, taken: &[QueuedId], max_priority: Priority) -> Vec<&super::super::state::Queued> {
        let mut rest: Vec<&super::super::state::Queued> = self
            .projected
            .queue
            .iter()
            .filter(|q| {
                !taken.iter().any(|t| t.as_str() == q.qid)
                    && !self.steer_marked.iter().any(|s| s.as_str() == q.qid)
                    && within_priority(&q.entry, max_priority)
                    && !self.queued_stopped(q)
                    && !pending::is_slash_entry(&q.entry)
            })
            .collect();
        rest.sort_by_key(|q| priority_rank(&q.entry));
        rest
    }

    /// The durable entries of `rest`, as the acknowledged queue holds them: memory never runs ahead of disk.
    fn durable_rest(&self, rest: &[&super::super::state::Queued]) -> Vec<(QueuedId, Value)> {
        rest.iter().filter_map(|q| self.acked.queue.iter().find(|a| a.qid == q.qid).map(|a| (QueuedId::from(a.qid.as_str()), a.entry.clone()))).collect()
    }

    fn accept_compacted(
        &mut self,
        turn: TurnId,
        compaction: super::super::run::Compaction,
        header: Option<super::super::run::DeferredHeader>,
        ack: oneshot::Sender<Result<(), RunError>>,
    ) {
        // An empty turn id is no turn: a manual compaction's commit (`commit_compaction`).
        if !turn.as_str().is_empty() && !self.active(&turn) {
            let _ = ack.send(Err(RunError::NotApplied));
            return;
        }
        self.transcript_rewritten = true;
        // The reset, the replacement and the header are one unit: a manual commit refused for a failed save leaves
        // none of them to be written later.
        self.outbox.begin_unit(false);
        // A compaction that changed the context drops the provider continuation
        // (`compaction-runner.mjs:701`).
        if let Some(reset) = self.provider_state_change(None) {
            self.accept_record(reset, Class::Normal, Display::None, Vec::new(), Vec::new());
        }
        // A caller that states the header (the manual compaction's `compactionRecord`) writes it with
        // the compaction, `compactCount` included (`compaction-runner.mjs:505`). The pre-send pass states
        // none: its count is the telemetry's (`rememberCompactTelemetry`, `compact-policy.mjs:877`), written
        // once by the pass's own `pass_change`.
        let cid = new_id();
        // An agent-mode session compacts silently: no divider, live or in its archive (`divider = !isAgentModeSession`,
        // `compaction-archive-capture.mjs:798`; `ask-turn-loop-options.mjs:202`). A compaction the session tool
        // scheduled runs after the turn with no host listening (`session.compact()`, `compaction-gate.mjs`): it shows
        // nothing live either.
        let silent = self.agent_mode();
        let shown_live = !silent && !(turn.as_str().is_empty() && self.after_compaction.is_some());
        // The divider shows live where the compaction happened (`compactionDivider`), as it reads from its record:
        // the divider alone.
        let divider = super::super::transcript::divider_item(&cid, Some(compaction.at));
        let note =
            Note::new("item/completed", &ItemNotificationParams { thread_id: self.id.clone(), turn_id: turn.clone(), item: divider.clone(), room_view: None });
        let record = Record::Compacted(CompactedRecord {
            cid: id(&cid),
            summary_iid: None,
            op: None,
            at: Some(compaction.at),
            dropped_count: Some(compaction.dropped_count),
            dropped: compaction.dropped.map(|d| CompactedDropped { message_ids: d.message_ids, call_ids: d.call_ids }),
            silent: silent.then_some(true),
            replacement: Slot::Inline(compaction.replacement.into_iter().map(|(iid, body)| ReplacementEntry { iid: iid.as_str().to_owned(), body }).collect()),
        });
        // The header is computed after the replacement is in, as Node stamps `committedAt` after the transcript and
        // provider-state mutations (`compaction-runner.mjs:695-749`); its record follows the compaction's, and the
        // caller's ack rides the last record, so the header is durable when the commit answers.
        // A turn's compaction states no header of its own, and owes its session's rebuilt prompt a fold: marked in
        // the compaction's unit, so the rewritten history is never stored without it, and cleared by the fold the
        // run takes next. A turn that ends or a process that stops in between leaves it to the next turn start.
        let header = header.or_else(|| {
            let folds = self.projected.header.get("promptIdentity").is_some_and(Value::is_object);
            folds.then(|| -> super::super::run::DeferredHeader {
                Box::new(|_| HeaderChange { set: [("compactionFoldPending".to_owned(), Value::Bool(true))].into_iter().collect(), ..Default::default() })
            })
        });
        // A manual compaction's commit awaits its save (`commitCompaction`): a failed save fails it, as a close's mark.
        let ack = if turn.as_str().is_empty() { Effect::MarkAck(ack) } else { Effect::ItemAck(ack) };
        let (compaction_ack, header_ack) = if header.is_some() { (Vec::new(), vec![ack]) } else { (vec![ack], Vec::new()) };
        let (display, notes) = if shown_live { (Display::Items(vec![Shown::Item(divider)]), vec![note]) } else { (Display::None, Vec::new()) };
        self.accept_record(record, Class::Normal, display, notes, compaction_ack);
        if let Some(header) = header {
            let change = header(&self.projected.header);
            self.accept_record(Record::Meta(MetaRecord { op: None, change: Slot::Inline(change) }), Class::Normal, Display::None, Vec::new(), header_ack);
        }
        self.outbox.end_unit();
    }
}
