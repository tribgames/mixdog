//! The turn-draft write queue: push, pump, failure, retry and settle.

use super::*;

impl SessionActor {
    /// Queues a draft file write; they run one at a time, in order, on the durability lane.
    pub(super) fn draft_push(&mut self, write: super::super::turn_draft::DraftWrite, ack: Option<oneshot::Sender<Result<(), RunError>>>) {
        use super::super::turn_draft::DraftWrite;
        if let DraftWrite::Append { rid, .. } | DraftWrite::Replace { rid, .. } = &write
            && self.draft_stopped.contains(rid)
        {
            if let Some(ack) = ack {
                let _ = ack.send(Ok(()));
            }
            return;
        }
        self.draft_queue.push_back((write, ack));
        self.draft_pump();
    }

    /// A run's own draft step is written or waits to be: the records accepted after it are not handed on yet.
    pub(super) fn draft_fenced(&self) -> bool {
        self.draft_busy_fenced || self.draft_queue.iter().any(|(_, ack)| ack.is_some())
    }

    pub(super) fn draft_pump(&mut self) {
        if self.draft_busy {
            return;
        }
        let Some((write, ack)) = self.draft_queue.pop_front() else { return };
        self.draft_busy = true;
        self.draft_busy_fenced = ack.is_some();
        let (store, thread, jobs) = (self.deps.store.clone(), self.id.clone(), self.jobs_tx.clone());
        let job = std::sync::Arc::new(std::sync::Mutex::new(Some((write.clone(), ack))));
        let taken = job.clone();
        let submitted = self.deps.lanes.durability.submit(&CancellationToken::new(), move |lane| {
            if let Some((write, ack)) = taken.lock().unwrap_or_else(std::sync::PoisonError::into_inner).take() {
                let result = store.draft_write(lane, &thread, &write);
                let _ = jobs.send(JobDone::DraftWritten { write, result, ack });
            }
        });
        if submitted.is_err()
            && let Some((write, ack)) = job.lock().unwrap_or_else(std::sync::PoisonError::into_inner).take()
        {
            let error = CoreError::Internal { incident_id: "session-draft-lane-refused".into() };
            let _ = self.jobs_tx.send(JobDone::DraftWritten { write, result: Err(error), ack });
        }
    }

    /// A draft write failed. A redaction that could not be written removes the draft (`failClosed`); a removal that fails
    /// after it stops the run's drafts. An append that failed leaves the draft as it was (the next whole write repairs it).
    ///
    /// The draft rule: a draft file is owned until its clear bytes are provably gone (a redaction or a removal of it
    /// succeeded): by its run while it streams, by `ended_drafts` (with the run's mark subscription, so a value marked
    /// meanwhile is redacted out of it) while its run's records wait to land, then by its removal. A removal that fails,
    /// a redaction's fallback included, stays owed in `drafts_removing` and runs again until it succeeds, first after
    /// [`DRAFT_RETRY`], each round after twice the wait of the one before, up to [`DRAFT_RETRY_MAX`]; a failed sweep at open
    /// likewise. Only the first failure, the wait reaching its ceiling and the success are logged. A session that ends first
    /// stops trying and leaves the file itself as the record the next open acts on: `recover` sweeps the drafts of runs that
    /// ended, and recovers, then removes, those of runs left open.
    pub(super) fn draft_failed(&mut self, write: &super::super::turn_draft::DraftWrite, error: &CoreError) {
        use super::super::turn_draft::DraftWrite;
        match write {
            DraftWrite::Remove { rid } => {
                self.drafts_removing.insert(rid.clone());
            }
            DraftWrite::Sweep { open } => self.sweep_due = Some(open.clone()),
            DraftWrite::Append { .. } | DraftWrite::Replace { .. } => {
                tracing::error!("session {}: a draft write failed: {error:?}", self.id.as_str());
            }
        }
        if matches!(write, DraftWrite::Remove { .. } | DraftWrite::Sweep { .. }) {
            if self.draft_backoff.is_none() {
                tracing::error!("session {}: a draft file could not be removed ({error:?}); it is tried again until it is", self.id.as_str());
                self.draft_backoff = Some(DRAFT_RETRY);
            }
            self.arm_draft_retry();
        }
        match write {
            DraftWrite::Replace { rid, .. } => {
                // Before anything queued after it: the file holding the unredacted value goes first.
                // A draft ack is best effort: a dropped write answers it as a written one does, never as a closed run.
                for (queued, ack) in std::mem::take(&mut self.draft_queue) {
                    if matches!(&queued, DraftWrite::Append { rid: r, .. } | DraftWrite::Replace { rid: r, .. } if r == rid) {
                        if let Some(ack) = ack {
                            let _ = ack.send(Ok(()));
                        }
                    } else {
                        self.draft_queue.push_back((queued, ack));
                    }
                }
                self.draft_queue.push_front((DraftWrite::Remove { rid: rid.clone() }, None));
                // And nothing the run drafted before the mark is written after it.
                self.outbox.drop_drafts(rid);
                if let Some(run) = self.run.as_mut().filter(|run| run.turn.as_str() == rid) {
                    run.journal.lost();
                }
                // An ended run's draft is not written again once removed.
                self.ended_drafts.remove(rid);
            }
            DraftWrite::Remove { rid } if self.run.as_ref().is_some_and(|run| run.turn.as_str() == rid) => {
                self.draft_stopped.insert(rid.clone());
            }
            DraftWrite::Append { rid, .. } => {
                // The steps drafted after it continue a file that lacks it: the next step writes the draft whole instead.
                if let Some(run) = self.run.as_mut().filter(|run| run.turn.as_str() == rid) {
                    run.journal.lost();
                    self.outbox.drop_drafts(rid);
                }
            }
            DraftWrite::Remove { .. } | DraftWrite::Sweep { .. } => {}
        }
    }

    fn arm_draft_retry(&mut self) {
        if self.draft_retry.is_some() {
            return;
        }
        let jobs = self.jobs_tx.clone();
        let due = self.deps.clock.sleep(self.draft_backoff.unwrap_or(DRAFT_RETRY));
        self.draft_retry = Some(tokio::spawn(async move {
            due.await;
            let _ = jobs.send(JobDone::DraftRetryDue);
        }));
    }

    /// The owed draft removals run again, each staying owed until it succeeds; the sweep keeps, besides the runs open at
    /// open, every draft this session still owns: the live run's and the ended runs' kept for their records. The next round
    /// waits twice as long.
    pub(super) fn draft_retry(&mut self) {
        self.draft_retry = None;
        if let Some(wait) = self.draft_backoff {
            let next = (wait * 2).min(DRAFT_RETRY_MAX);
            if next == DRAFT_RETRY_MAX && wait < DRAFT_RETRY_MAX {
                tracing::warn!("session {}: a draft file still cannot be removed; it is tried again every {}s", self.id.as_str(), next.as_secs());
            }
            self.draft_backoff = Some(next);
        }
        let mut removing: Vec<String> = self.drafts_removing.iter().cloned().collect();
        removing.sort();
        for rid in removing {
            self.draft_push(super::super::turn_draft::DraftWrite::Remove { rid }, None);
        }
        if let Some(mut open) = self.sweep_due.clone() {
            open.extend(self.run.as_ref().map(|run| run.turn.as_str().to_owned()));
            open.extend(self.ended_drafts.keys().cloned());
            open.sort();
            open.dedup();
            self.draft_push(super::super::turn_draft::DraftWrite::Sweep { open }, None);
        }
    }

    /// A removal or sweep succeeded: what it owed is settled, and once nothing is owed the schedule ends.
    pub(super) fn draft_settled(&mut self, write: &super::super::turn_draft::DraftWrite) {
        use super::super::turn_draft::DraftWrite;
        match write {
            DraftWrite::Remove { rid } => {
                self.drafts_removing.remove(rid);
            }
            DraftWrite::Sweep { .. } => self.sweep_due = None,
            DraftWrite::Append { .. } | DraftWrite::Replace { .. } => return,
        }
        if self.draft_backoff.is_some() && self.drafts_removing.is_empty() && self.sweep_due.is_none() {
            tracing::info!("session {}: the draft files owed removal are removed", self.id.as_str());
            self.draft_backoff = None;
            if let Some(retry) = self.draft_retry.take() {
                retry.abort();
            }
        }
    }

    /// Once everything queued so far is durable (the run's end record among it), run `rid`'s draft file goes. `needs`: the
    /// record whose failure keeps the draft (it goes with that record's).
    pub(super) fn remove_draft_when_durable(&mut self, rid: &str, needs: Option<u64>) {
        let (tx, rx) = oneshot::channel();
        let (jobs, rid) = (self.jobs_tx.clone(), rid.to_owned());
        tokio::spawn(async move {
            if matches!(rx.await, Ok(Ok(()))) {
                let _ = jobs.send(JobDone::DraftEnded(rid));
            }
        });
        match needs {
            Some(needs) => self.outbox.push_after(needs, Change::Barrier, Vec::new(), vec![Effect::ItemAck(tx)]),
            None => self.outbox.push(None, Change::Barrier, Vec::new(), vec![Effect::ItemAck(tx)]),
        };
    }
}
