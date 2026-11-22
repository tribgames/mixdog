//! Start-up recovery of stale compaction and crashed runs.

use super::*;

impl SessionActor {
    /// `normalizeStaleCompactingStage` (`compaction-runner.mjs`): `compacting` is the transient stage written just
    /// before a compaction runs. A session opened with it (the process died, or only part of the pass was saved) is
    /// not compacting: the stage becomes `interrupted` so no surface shows a compaction that never ends. Terminal
    /// stages are the durable record of the last real outcome and stay.
    pub(super) fn normalize_stale_compacting(&mut self) {
        let Some(change) = stale_compacting_change(&self.acked.header, self.deps.clock.now_ms()) else { return };
        let meta = Record::Meta(MetaRecord { op: None, change: Slot::Inline(change) });
        self.accept_record(meta, Class::Control, Display::None, Vec::new(), Vec::new());
    }

    /// Open-time recovery: a run without a terminal record is interrupted, and so are its
    /// approvals (P §5.2, §8.2; Codex daemon recovery).
    pub(super) fn recover(&mut self) {
        let at = self.deps.clock.now_ms();
        let approvals: Vec<(String, String)> = self.acked.approvals.iter().map(|(aid, row)| (aid.clone(), row.rid.clone())).collect();
        for (aid, rid) in approvals {
            if let Ok(aid) = aid.parse() {
                self.resolve(ApprovalId(aid), &TurnId::from(rid), ApprovalResolution::Interrupted { at });
            }
        }
        let runs: Vec<(String, super::super::turn_draft::RunDraft)> = self.acked.runs.iter().map(|(rid, draft)| (rid.clone(), draft.clone())).collect();
        // A draft whose run ended (a kill between the end record and the draft's removal) goes.
        self.draft_push(super::super::turn_draft::DraftWrite::Sweep { open: runs.iter().map(|(rid, _)| rid.clone()).collect() }, None);
        if runs.is_empty() {
            return;
        }
        // What each run leaves is read from the model context (`replayCheckpoint`); no turn starts before it is
        // committed.
        self.recovering = true;
        let (store, lanes, thread, runs_host, jobs) = (self.deps.store.clone(), self.deps.lanes, self.id.clone(), self.deps.runs.clone(), self.jobs_tx.clone());
        drop(mixdog_rt::spawn("session-recover", TaskClass::Work, async move {
            let context = super::super::run::read_context(&store, &lanes, &thread).await;
            let mut ended = Vec::new();
            for (rid, draft) in runs {
                let context_tokens = draft.context_tokens;
                let crashed = match &context {
                    Ok(context) => {
                        let run = super::super::seams::CrashedRun {
                            context: context.clone(),
                            input: draft.input.clone().map(mixdog_core_api::ids::ItemId::from),
                            draft,
                        };
                        let host = runs_host.clone();
                        lanes.cpu.submit(&CancellationToken::new(), move |_| host.crashed(run)).ok()
                    }
                    Err(error) => {
                        tracing::error!("session {}: the crashed turn {rid} was not finalized, its model context is unreadable: {error:?}", thread.as_str());
                        None
                    }
                };
                // A recovery that could not run leaves the run open, its draft kept: the next open recovers it (Node sets an
                // unrecovered checkpoint aside, `setAsideUnrecoveredCheckpoint`).
                match crashed {
                    Some(job) => match job.await {
                        Ok(rows) => ended.push((rid, super::super::seams::CrashedRows { context_tokens, ..rows })),
                        Err(error) => {
                            tracing::error!("session {}: the crashed turn {rid} was not finalized, it stays for the next open: {error:?}", thread.as_str())
                        }
                    },
                    None => tracing::error!("session {}: the crashed turn {rid} was not finalized, it stays for the next open", thread.as_str()),
                }
            }
            let _ = jobs.send(JobDone::Recovered(ended));
        }));
    }

    /// The crashed runs end: what each left is committed, then its end (`recoverTurnCheckpoint`: the record names
    /// the turn it covers, is stamped as used, and drops the provider continuation, `turn-checkpoint.mjs:545-554`).
    pub(super) fn recovered(&mut self, ended: Vec<(String, super::super::seams::CrashedRows)>) {
        let at = self.deps.clock.now_ms();
        // The recovery is one unit, written whole or failed whole: a failed save shows nothing of it (the open is served the
        // log as it stands) and leaves the runs open, their drafts kept, for the next open, as an unreadable context does.
        let first = self.outbox.next_id();
        self.outbox.begin_unit(false);
        if let Some(reset) = self.provider_state_change(None) {
            self.accept_record(reset, Class::Control, Display::None, Vec::new(), Vec::new());
        }
        // A queued entry the crashed run already took (a steered row naming it) was delivered: its dequeue did not land
        // before the kill, and it goes now rather than run twice (`restoreLeadSteeringFromDisk`'s delivered submissions,
        // `steering.mjs:241`).
        let delivered: std::collections::HashSet<String> = ended
            .iter()
            .flat_map(|(_, left)| &left.rows)
            .filter(|item| item.role.as_deref() == Some("user"))
            .flat_map(|item| {
                let meta = item.body.get("meta");
                let ids =
                    |at: Option<&Value>| at.and_then(Value::as_array).into_iter().flatten().filter_map(Value::as_str).map(str::to_owned).collect::<Vec<_>>();
                let mut out = ids(meta.and_then(|m| m.get("submissionIds")));
                out.extend(ids(meta.and_then(|m| m.pointer("/transcript/submissionIds"))));
                out.extend(meta.and_then(|m| m.pointer("/transcript/checkpointId")).and_then(Value::as_str).map(str::to_owned));
                out
            })
            .collect();
        let taken: Vec<String> = self
            .projected
            .queue
            .iter()
            .filter(|q| {
                delivered.contains(&q.qid) || q.entry.pointer("/options/clientSubmissionId").and_then(Value::as_str).is_some_and(|id| delivered.contains(id))
            })
            .map(|q| q.qid.clone())
            .collect();
        for qid in taken {
            self.accept_record(dequeue(&qid), Class::Control, Display::None, Vec::new(), Vec::new());
        }
        for (rid, left) in ended {
            let turn = TurnId::from(rid.clone());
            for item in left.rows {
                let display = self.row_display(item.role.as_deref(), &item.body);
                match self.item_record(&turn, item, RowFacts { visible: true, prompt: None }, None) {
                    Ok(record) => self.accept_record(record, Class::Normal, display, Vec::new(), Vec::new()),
                    Err(error) => tracing::error!("session {}: a row of the crashed turn {rid} was not committed: {error:?}", self.id.as_str()),
                }
            }
            if let Some(replacement) = left.context {
                let record = Record::Compacted(CompactedRecord {
                    cid: id(&new_id()),
                    summary_iid: None,
                    op: None,
                    at: Some(at),
                    dropped_count: Some(0),
                    dropped: None,
                    silent: Some(true),
                    replacement: Slot::Inline(replacement.into_iter().map(|(iid, body)| ReplacementEntry { iid: iid.as_str().to_owned(), body }).collect()),
                });
                self.accept_record(record, Class::Normal, Display::None, Vec::new(), Vec::new());
            }
            let record = Record::Run(RunRecord {
                rid: id(&rid),
                phase: if left.sealed { RunPhase::Completed } else { RunPhase::Interrupted },
                attribution: None,
                attempt: None,
                at: Some(at),
                op: None,
                detail: None,
            });
            self.accept_record(record, Class::Control, Display::None, Vec::new(), Vec::new());
            let mut set = serde_json::Map::new();
            set.insert("turnCoverage".into(), json!(rid));
            set.insert("updatedAt".into(), json!(at));
            set.insert("lastUsedAt".into(), json!(at));
            if let Some(tokens) = left.context_tokens {
                set.insert("lastContextTokens".into(), json!(tokens));
            }
            let meta = Record::Meta(MetaRecord { op: None, change: Slot::Inline(HeaderChange { set, unset: Vec::new(), patch: Default::default() }) });
            let end = self.accept_record_entry(meta, Class::Control, Display::None, Vec::new(), Vec::new());
            self.remove_draft_when_durable(&rid, Some(end));
        }
        self.outbox.end_unit();
        // The recovery's records are durable (or failed) before the session is served: its last entry carries the ack, which a
        // failed save fails rather than holds (a held recovery would be served unsaved).
        let (ack, durable) = oneshot::channel();
        match self.outbox.last_durable_mut(first) {
            Some(entry) => {
                entry.effects.push(Effect::MarkAck(ack));
                let jobs = self.jobs_tx.clone();
                tokio::spawn(async move {
                    let done = durable.await.unwrap_or(Err(RunError::NotApplied));
                    let _ = jobs.send(JobDone::RecoveryDone(done));
                });
            }
            None => self.recovery_ended(),
        }
    }

    pub(super) fn recovery_ended(&mut self) {
        self.recovering = false;
        if let Some(ready) = self.opened.take() {
            // The crashed runs are finalized: an owed Stop outcome is finished, never its work run.
            self.recover_stops();
            let _ = ready.send(());
            // The end of `createLocalSessionRuntime` (`local-session-runtime.mjs`): the opened thread's lane reads its Goal,
            // and an active one continues once the thread is idle, with no client needed (Goal recovery's materialize).
            self.refresh_goal();
            self.schedule_goal_continuation();
        }
        self.receipts_due();
    }
}
