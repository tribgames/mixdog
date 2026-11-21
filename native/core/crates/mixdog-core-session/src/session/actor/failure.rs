//! Storage failure handling: failing entries, holding or exiting the actor, and telling retained work.

use super::*;

impl SessionActor {
    /// A compaction record the encoder rejected leaves no divider: its pair, if its event has not come, is dropped with it.
    fn compact_record_failed(&mut self, cid: &str) {
        if let Some(pairs) = &mut self.compact_pairs
            && let Some(seq) = pairs.dividers.iter().find(|(_, waiting)| waiting.cid == cid).map(|(seq, _)| *seq)
        {
            pairs.dividers.remove(&seq);
            pairs.lost.insert(seq);
        }
    }

    pub(super) fn fail_entry(&mut self, entry: Entry, error: &CoreError) {
        if let Change::Record { record, .. } = &entry.change
            && let Record::Compacted(compacted) = &**record
        {
            self.compact_record_failed(compacted.cid.as_str());
        }
        #[cfg(any(test, feature = "test-support"))]
        if let Some(durable) = &entry.durable {
            self.outbox.note_failed(durable, format!("{error:?}"));
        }
        // A queued prompt whose record was not stored is removed and the sender hears a refusal (`drain-enqueue.mjs:64`, a
        // failed durable mirror), so a retry is a new submission: no receipt was kept for it.
        let mut refused = None;
        if let Change::Record { record, .. } = &entry.change
            && let Record::Queue(queue) = &**record
            && queue.action == QueueAction::Enqueue
        {
            refused = Some(coded("session", SUBMIT_REFUSED, "The message could not be saved, so it was not sent."));
        }
        let error = refused.as_ref().unwrap_or(error);
        for effect in entry.effects {
            match effect {
                effect @ (Effect::Reply { .. } | Effect::Kept { .. } | Effect::Stored { .. }) => {
                    let (op, tx) = match effect {
                        Effect::Reply { op, tx, .. } | Effect::Stored { op, tx, .. } => (op, tx),
                        Effect::Kept { tx, .. } => (None, tx),
                        _ => unreachable!("matched above"),
                    };
                    // A failed `session` record: the thread is not created, the seed is abandoned, and the thread ends here: the
                    // actor releases its own slot (the create's caller may be gone, cancelled) and stops once its outbox is empty.
                    self.seed = None;
                    if std::mem::take(&mut self.uncreated)
                        && let Some(directory) = self.ch.directory.upgrade()
                    {
                        directory.release(&self.id, &self.cell);
                    }
                    if let Some(op) = &op {
                        self.ops.failed(op, error);
                    }
                    if let Some(tx) = tx {
                        let _ = tx.send(Err(error.clone()));
                    }
                }
                Effect::InputDurable => {
                    if let Some(run) = &mut self.run {
                        run.start_failed = true;
                        run.input.send_replace(InputState::Failed);
                        run.cancel.abort_default();
                    }
                }
                Effect::ItemAck(tx) | Effect::MarkAck(tx) => {
                    let _ = tx.send(Err(RunError::NotApplied));
                }
                Effect::PublishApproval(request) => {
                    if let Some(aid) = mixdog_core_base::approvals::parse_id(&request.id) {
                        self.book.forget(aid);
                    }
                }
                Effect::Resolved(aid, _) => self.book.unresolve(aid),
                Effect::RecomputePrompts { .. } => {}
                // The failed turn's completion could not be recorded, so its end was not shown and its quota stops
                // unsettled: the Goal still settles, and the failure is reported, not skipped.
                Effect::TurnClosed { turn, settle } => {
                    tracing::error!("the failed turn {} was not recorded, so its end is not shown and its quota is not settled: {error:?}", turn.as_str());
                    self.settle_goal(settle);
                }
                // Its change was never shown: the waiter learns the failure that dropped it.
                Effect::AfterPublish(tx) => {
                    let _ = tx.send(Err(error.clone()));
                }
                Effect::Decided(_) => {}
                // The draft is what recovers the run when its records do not land: it is written still.
                Effect::Draft(write, ack) => self.draft_push(write, ack),
            }
        }
    }

    /// A barrier failed. Node keeps the session in memory and saves it whole again (`turn-durability.mjs`): here a
    /// change a client asked for answers the failure and is not applied (RL §6.1), and every other record the barrier
    /// carried is released unsaved: its rows stay shown and the run goes on, and it is written again, before any
    /// later record, with the next record or turn. A turn that waited for it is refused.
    /// The units retained on a write rolled back cleanly (`retain`: a room post, an import) are kept in their place,
    /// unreleased: their requests hear the failure now and they go with the next write. A unit is failed or held whole.
    pub(super) fn hold_failed(&mut self, error: &CoreError, cause: Arc<str>, retain: bool) {
        for (_, tx) in self.writes_landed.drain(..) {
            let _ = tx.send(Err(RunError::NotApplied));
        }
        self.generation += 1;
        self.save_failure = cause;
        let retained: std::collections::HashSet<u64> = if retain { self.outbox.handed_retained().into_iter().collect() } else { Default::default() };
        for id in &retained {
            self.outbox.keep(*id);
        }
        self.tell_retained(&retained, error);
        let mut notes = Vec::new();
        let mut header_moved = false;
        let handed: Vec<u64> = self.outbox.handed();
        // A turn whose start was not saved does not run: no provider call is made while the session cannot be saved,
        // and its input row goes with it, as Node's ask is refused before it touches the session.
        let refused: Vec<String> = handed
            .iter()
            .filter_map(|id| self.outbox.get(*id))
            .filter(|entry| !entry.held && entry.effects.iter().any(|effect| matches!(effect, Effect::InputDurable)))
            .filter_map(|entry| match &entry.change {
                Change::Record { record, .. } => match &**record {
                    Record::Run(run) => Some(run.rid.as_str().to_owned()),
                    _ => None,
                },
                _ => None,
            })
            .collect();
        // A unit one of whose records is answered with the failure fails whole: none of it is written later behind its
        // caller's back (a manual compaction's replacement after its commit was refused).
        let asked: std::collections::HashSet<u64> = handed
            .iter()
            .filter(|id| {
                self.outbox.get(**id).is_some_and(|entry| {
                    !entry.held
                        && (answers_a_client(entry)
                            || entry.effects.iter().any(|effect| matches!(effect, Effect::InputDurable))
                            || matches!(&entry.change, Change::Record { record, .. } if matches!(&**record, Record::Item(row) if row.turn.as_ref().is_some_and(|turn| refused.iter().any(|rid| rid == turn.as_str())))))
                })
            })
            .filter_map(|id| self.outbox.unit_of(*id))
            .collect();
        for id in handed {
            if self.outbox.unit_of(id).is_some_and(|unit| asked.contains(&unit)) {
                let gone = self.outbox.remove(id).into_iter().chain(self.outbox.remove_needing(id));
                for entry in gone.collect::<Vec<_>>() {
                    self.fail_entry(entry, error);
                }
                continue;
            }
            if let Some((unshown, effects)) = self.outbox.hold(id) {
                // The replies of what is released unsaved are sent once its view is published, as the pump's are.
                self.releasing = true;
                match unshown {
                    Some(mut entry) => {
                        entry.effects = effects;
                        header_moved |= self.release(entry, None, &mut notes);
                    }
                    // Shown already (the show rule): it stays shown, and settles now as a held entry does.
                    None => {
                        for effect in effects {
                            self.effect_done(effect);
                        }
                    }
                }
                self.releasing = false;
            }
        }
        // A close's mark or a toast waiting behind the failed barrier was part of the save that threw in Node (`closeSession`
        // answers `false`, the notice posting rejects): its caller hears the failure.
        for id in self.outbox.waiting(|effect| matches!(effect, Effect::MarkAck(_) | Effect::AfterPublish(_))) {
            for entry in self.outbox.remove_unit(id) {
                let gone = entry.id;
                self.fail_entry(entry, error);
                for dependent in self.outbox.remove_needing(gone) {
                    self.fail_entry(dependent, error);
                }
            }
        }
        self.rebuild_projected();
        if !notes.is_empty() || header_moved {
            self.publish(notes);
        }
        // A turn waiting for the barrier that failed gets the one fresh save `awaitPreviousTurnDurable` makes.
        if let Some(start) = self.deferred_start.as_mut()
            && !start.retried
        {
            start.retried = true;
            self.retry_due = true;
        } else if let Some(start) = self.deferred_start.take() {
            self.submitter = None;
            // What waited behind the refused start drains once starts are free again.
            self.drain_held |= !self.projected.queue.is_empty();
            let refusal = coded(
                "session",
                TURN_NOT_DURABLE,
                format!("Session {}: the previous turn is not saved to disk, so the next turn cannot start ({})", self.id.as_str(), self.save_failure),
            );
            if let Some(Effect::Reply { op, tx, .. }) = start.reply {
                if let Some(op) = &op {
                    self.ops.failed(op, &refusal);
                }
                if let Some(tx) = tx {
                    let _ = tx.send(Err(refusal));
                }
            }
        }
    }

    /// A barrier failed: nothing after the acked state is applied (RL §6.1). A conditional header patch behind the
    /// record that failed was decided against a header that never landed: its caller hears `conflict` with the header
    /// as it holds and computes it again, as Node's write accepted behind a failed one runs on what that one did.
    pub(super) fn fail_all(&mut self, error: CoreError) {
        for (index, entry) in self.outbox.fail_all().into_iter().enumerate() {
            let decided = entry.effects.iter().find_map(|effect| match effect {
                Effect::Decided(keys) => Some(keys.clone()),
                _ => None,
            });
            match decided {
                Some(keys) if index > 0 => {
                    let current: serde_json::Map<String, Value> =
                        keys.into_iter().map(|key| (key.clone(), self.acked.header.get(&key).cloned().unwrap_or(Value::Null))).collect();
                    for effect in entry.effects {
                        if let Effect::Reply { tx: Some(tx), .. } = effect {
                            let _ = tx.send(Ok(Reply::Value(json!({ "conflict": current }))));
                        }
                    }
                }
                _ => self.fail_entry(entry, &error),
            }
        }
        self.generation += 1;
        self.projected = self.acked.clone();
    }

    /// A write failed while the thread is closed. The close rule (Node's `finishClose`: a close whose barrier did not land
    /// leaves the runtime intact and answers `false`): a close that has not completed is undone. A delete still waiting for
    /// its turn or its mark stays closed and holds what failed for its mark's write, which carries it first; any other close
    /// (a delete whose mark failed, one that gave up) reopens the thread while it is still the directory's, and the session
    /// stays open with everything unwritten held in accept order. False: the directory let the thread go (its shutdown, or a
    /// create that failed), so there is no session left to keep it in ([`Self::exit_unwritten`]).
    pub(super) fn close_undone(&mut self) -> bool {
        if self.delete_closed.is_some() || self.delete_mark.is_some() {
            return true;
        }
        let Some(directory) = self.ch.directory.upgrade() else { return false };
        if !directory.reopen(&self.id, &self.cell) {
            return false;
        }
        tracing::warn!("session {}: its close failed on a write; it stays open with its unwritten records held", self.id.as_str());
        self.deleting = false;
        self.arm_idle_evict();
        true
    }

    /// Shutdown's write failed (Node's exit drain: `[session-store] drain save failed`, after which the process exits): what
    /// is not on disk goes with the process, and nothing more is written, so the log keeps a prefix of what was accepted. A
    /// run whose end did not land keeps its draft, which the next open recovers, as Node's turn checkpoint is kept when
    /// its close fails.
    pub(super) fn exit_unwritten(&mut self, error: CoreError, cause: &str) {
        let unwritten = self.outbox.unsaved_records().count();
        if self.shutting_down {
            mixdog_rt::node_stderr!("[session-store] drain save failed: {cause}");
        }
        tracing::error!("session {}: it ends with {unwritten} records not written ({error:?})", self.id.as_str());
        self.exit_failed = Some(error.clone());
        self.fail_all(error);
    }

    /// The requests of the kept units hear the failure now, once.
    fn tell_retained(&mut self, retained: &std::collections::HashSet<u64>, error: &CoreError) {
        for id in retained.iter().copied() {
            let Some(entry) = self.outbox.get_mut(id) else { continue };
            let (told, kept): (Vec<Effect>, Vec<Effect>) =
                std::mem::take(&mut entry.effects).into_iter().partition(|effect| matches!(effect, Effect::Reply { .. } | Effect::Kept { .. }));
            entry.effects = kept;
            for effect in told {
                // Node keeps what a change of its own did in memory when the save fails: that reply is the answer, not the failure.
                if let Effect::Kept { tx, value } = effect {
                    self.effect_done(Effect::Reply { op: None, tx, value });
                } else if let Effect::Reply { op, tx, .. } = effect {
                    if let Some(op) = &op {
                        self.ops.failed(op, error);
                    }
                    if let Some(tx) = tx {
                        let _ = tx.send(Err(error.clone()));
                    }
                }
            }
        }
    }
}
