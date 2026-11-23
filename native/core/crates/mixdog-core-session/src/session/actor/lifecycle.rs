//! Actor lifecycle: delete, idle eviction, unload and the busy/quiet predicates they use.

use super::*;

impl SessionActor {
    /// `Ctl::Delete`: see its doc.
    pub(super) fn delete(
        &mut self,
        abort: &mixdog_agent::cancel::Abort,
        idle: bool,
        guard: Option<super::super::control::DeleteGuard>,
        closed: oneshot::Sender<Result<(), &'static str>>,
        mark: oneshot::Receiver<serde_json::Map<String, Value>>,
        marked: oneshot::Sender<Result<(), RunError>>,
    ) {
        #[cfg(any(test, feature = "test-support"))]
        if self.unwind_at_delete {
            panic!("the test's injected unwind at a delete");
        }
        // Another delete holds the thread: it is gone for this one.
        if self.deleting {
            let _ = closed.send(Err("missing"));
            return;
        }
        // A favorite marked while the idle delete awaited: the header is reread here, not the one judged earlier, and as
        // accepted: a favorite whose save is still owed is the user's all the same.
        if idle && super::super::delete::sidebar_flag(&self.projected.header, "favoriteAt") {
            let _ = closed.send(Err("favorite"));
            return;
        }
        // In `idleRefusal`'s order, before the guard: a turn that has not settled refuses as it does before the close, whichever
        // of its steps (a completion wake's start and settlement included, which the checks before the close do not see) the
        // close meets.
        if idle {
            let refusal = if self.turn_pending() {
                Some("turn-waiting")
            } else if self.turn_held() {
                Some("busy")
            } else if !self.projected.queue.is_empty() {
                Some("queued")
            } else {
                None
            };
            if let Some(refusal) = refusal {
                let _ = closed.send(Err(refusal));
                return;
            }
        }
        // A guarded delete reads the admission word first and closes it from exactly that value:
        // an attach after this point, even one that detaches again, refuses the close.
        let mut seen = None;
        if let Some(guard) = guard {
            let word = self.cell.admission();
            let moved = super::super::sub_agent_retention::activity_at(&self.cell.header.load()) != guard.activity;
            let peers_changed = self.ch.directory.upgrade().is_none_or(|directory| directory.peers_changed(&guard.peers, guard.opens));
            if word != 0
                || guard.cancel.is_cancelled()
                || moved
                || self.turn_busy()
                || !self.projected.queue.is_empty()
                || !self.projected.approvals.is_empty()
                || peers_changed
            {
                let _ = closed.send(Err("changed"));
                return;
            }
            seen = Some(word);
        }
        // The same word an attach transitions, so exactly one of the two wins.
        match seen {
            Some(word) if !self.cell.close_if_unchanged(word) => {
                let _ = closed.send(Err("changed"));
                return;
            }
            Some(_) => {}
            None => self.cell.close(),
        }
        self.deleting = true;
        self.cell.abort_compaction(abort);
        (self.delete_closed, self.delete_mark, self.delete_marked) = (Some(closed), Some(mark), Some(marked));
        if let Some(run) = &self.run {
            // The deleted session leaves the approvals list now, not when its turn ends.
            let turn = run.turn.clone();
            let at = self.deps.clock.now_ms();
            for aid in self.book.take_run(&turn) {
                // The run's token fires right below: it must see `interrupted`, not the cancel.
                let interrupted = ApprovalResolution::Interrupted { at };
                self.book.answer(aid, &interrupted);
                self.resolve(aid, &turn, interrupted);
            }
            if let Some(run) = &self.run {
                run.cancel.abort_with(abort);
            }
            return;
        }
        // A Project move being carried out ends first, as a turn does ([`Self::project_moved`]).
        if self.carrying() {
            return;
        }
        self.delete_turn_ended();
    }

    /// The deleted thread's turn ended (or it had none).
    pub(super) fn delete_turn_ended(&mut self) {
        if let Some(closed) = self.delete_closed.take() {
            let _ = closed.send(Ok(()));
        }
    }

    /// The header change the delete asked for (FORMAT.md §5.1 `meta`: the delete mark
    /// `deleted: true`, or an idle close's tombstone), acked to `delete_marked`;
    /// `None`: the delete gave up, the thread stops unmarked.
    pub(super) fn mark_deleted(&mut self, go: Option<serde_json::Map<String, Value>>) {
        self.delete_mark = None;
        let Some(marked) = self.delete_marked.take() else { return };
        let Some(set) = go else {
            // It stops once what it accepted is on disk: what a failed write left is written first ([`Self::close_undone`]).
            self.retry_due |= self.outbox.awaits_retry();
            return;
        };
        let meta = Record::Meta(MetaRecord { op: None, change: Slot::Inline(HeaderChange { set, unset: Vec::new(), patch: Default::default() }) });
        self.accept_record(meta, Class::Control, Display::None, Vec::new(), vec![Effect::MarkAck(marked)]);
    }

    /// Unloads a closed thread once nothing is live: no run, no queued input, no pending approval. Any other thread stays
    /// loaded, its idle clock started over. The memory ingest fires without waiting (today's
    /// `void ingestSessionIntoMemory(session)` when the CLI closes a session).
    pub(super) fn try_unload(&mut self) {
        // Retained, as Node retains a session none ever watched or its last view left (`unsubscribeSession` sets
        // `retainedAt`): the idle deadline unloads it once it finds it quiet, unwatched and not busy ([`Self::on_idle_evict`]).
        if !self.tombstoned {
            self.arm_idle_evict();
            return;
        }
        if !self.quiet() {
            // A close waits for what this session is finishing by itself; a subscriber, queued input or a pending
            // approval may stay for good, and the close is answered with the session still loaded.
            if !self.finishing() {
                self.answer_closes();
            }
            return;
        }
        // A closed thread unloads at once (`_clearSessionRuntime`).
        self.unload();
    }

    /// Work besides what [`Self::quiet`] reads that keeps a thread nobody watches loaded (`busy.mjs` `sessionBusy`: the turn
    /// state, `commandBusy`): a turn about to start (a deferred start, a Goal entry checked, a quota resume), a Goal
    /// continuation being decided, a compaction running or holding the turns after it.
    fn session_busy(&self) -> bool {
        self.turn_busy() || self.goal_scheduled || self.compactions > 0 || self.compaction_held()
    }

    /// Node's `sessionTurnBusy` (`busy.mjs` `stateBusy`: `busy`, `commandBusy`, `queued`) as the core's lifecycle counts the session
    /// ([`SessionDeps::core_work`]): a turn runs, starts, settles or waits to start, a Goal continuation is decided or its entry
    /// checked, a compaction runs, or any input is queued (`queued.length > 0`: one waiting for the previous turn to land, for the
    /// scheduled compaction to end or for a quota resume, which keeps Node's daemon up until the resume). The one input not counted
    /// is what the core's own hold keeps queued once nothing but the hold keeps it from starting: under Node's hold a client's submit
    /// is refused and nothing queues, and counting it would hold the core the drain waits to see idle.
    pub(super) fn core_busy(&self) -> bool {
        self.turn_held()
            || self.goal_checking
            || self.goal_scheduled
            || self.compactions > 0
            || ((self.starts_gated() || self.core_hold() == StartHold::Open) && !self.projected.queue.is_empty())
    }

    /// The session's hold on the core follows [`Self::core_busy`], after every step.
    pub(super) fn hold_core_while_busy(&mut self) {
        if self.core_busy() {
            self.hold_core();
        } else {
            self.core_busy_hold = None;
        }
    }

    /// The session's hold on the core, taken now if the session held none.
    pub(super) fn hold_core(&mut self) -> &dyn super::super::BusyHold {
        let title = self.acked.header.get("title").and_then(Value::as_str).unwrap_or_default();
        &**self.core_busy_hold.get_or_insert_with(|| self.deps.core_work.busy(&self.id, title))
    }

    /// `evictable` (`retention.mjs`): unwatched with nothing live ([`Self::quiet`]) and not busy ([`Self::session_busy`]), with no
    /// in-core start waiting out the core's hold on it (`ControlCell::deferring`). The background work `sessionBusy` also counts is
    /// read apart, off the actor ([`Self::on_idle_evict`]).
    fn evictable(&self) -> bool {
        self.quiet() && !self.session_busy() && self.cell.deferring.load(SeqCst) == 0 && !self.cell.retention.held()
    }

    /// Work that ends by itself is still under way: a delete, a turn's settle, a start, a Goal check, the run, a Project move
    /// being carried out.
    pub(super) fn finishing(&self) -> bool {
        self.deleting || self.settling || self.starting || self.goal_checking || self.run.is_some() || self.carrying()
    }

    /// Answers the closes that wait ([`Ctl::Closed`]): the session has left memory, or it stays loaded.
    pub(super) fn answer_closes(&mut self) {
        for taken in self.closed_acks.drain(..) {
            // A close that stopped waiting dropped its end.
            let _ = taken.send(());
        }
    }

    /// Nothing is live: not deleting or settling, no run, no Project move being carried out, no queued input, no pending
    /// approval, no feed subscriber.
    pub(super) fn quiet(&self) -> bool {
        !(self.deleting
            || self.carrying()
            || self.settling
            || self.starting
            || self.goal_checking
            || self.cell.attached() != 0
            || self.run.is_some()
            || !self.projected.queue.is_empty()
            || !self.projected.approvals.is_empty())
    }

    /// `applyResolvedCwd`'s code-graph warm (`cwd-apply.mjs:85-90`): none in lazy mode before the
    /// runtime's first turn armed its own; otherwise at once for a changed folder, after the
    /// configured delay for the same one.
    pub(super) fn cwd_applied(&self, changed: bool) {
        // `CwdChanged` (`cwd-apply.mjs:91-100`): only a folder that really moved, unawaited (`void hooks.dispatch(..)`), and
        // `onCwdChanged` after it (the session's MCP scope reconciles for the new folder). The header carries the new `cwd`:
        // the move saved it before it applied.
        if changed {
            let (hooks, thread, header) = (self.deps.lifecycle.clone(), self.id.clone(), self.acked.header.clone());
            tokio::spawn(async move { hooks.cwd_changed(&thread, &header).await });
        }
        let prewarm = &self.deps.code_graph_prewarm;
        if prewarm.lazy() && !self.first_turn_prewarm_done {
            return;
        }
        if changed {
            prewarm.schedule(Some(std::time::Duration::ZERO), "cwd-change");
        } else {
            prewarm.schedule(None, "cwd");
        }
    }

    /// `turn.armHeavyRuntimeWarmup('first-visible')` on visible output (text, reasoning, a tool):
    /// the first turn's warm, once.
    pub(super) fn visible_progress(&mut self) {
        if std::mem::take(&mut self.turn_prewarm_armed) {
            self.deps.code_graph_prewarm.schedule(Some(std::time::Duration::ZERO), "first-visible");
        }
    }

    /// The idle clock of a thread nobody watches starts over; a watched one is off it (`retention.mjs` `unwatchedRetained`).
    pub(super) fn arm_idle_evict(&mut self) {
        // A thread an open loaded only to be read (a sidebar's prefetch), that no client ever attached to and that ran no turn,
        // unloads on the worker's delay too: nobody is looking at it, and a click attaches before it needs the longer one. A
        // thread that ran a turn keeps `idleEvictMs` whether or not anyone watches it.
        let unwatched = self.only_read && self.cell.admission() & super::super::control::ATTACHED == 0;
        let delay = if unwatched || super::super::close::is_worker(&self.acked.header) { WORKER_IDLE_EVICT } else { IDLE_EVICT };
        self.idle_evict_at = (self.cell.attached() == 0).then(|| tokio::time::Instant::now() + delay);
    }

    /// A turn ended or a client resumed the thread: it is looked at once the worker's idle delay has passed ([`Self::on_rest`]).
    pub(super) fn arm_rest(&mut self) {
        self.rest_at = Some(tokio::time::Instant::now() + WORKER_IDLE_EVICT);
    }

    /// A watched thread stays loaded for as long as it is watched, off the idle clock, and its feed kept every frame of its last
    /// turns for a client to resume from. One found doing nothing lets them go: its subscribers have them, and a client that
    /// comes back from before them is served the view. One found working is looked at again.
    pub(super) fn on_rest(&mut self) {
        self.rest_at = None;
        if self.finishing() || self.session_busy() || !self.outbox.is_empty() {
            self.arm_rest();
        } else {
            self.feed.rest();
        }
    }

    /// The idle deadline came: a thread found working waits the whole delay again, one found watched waits for its last
    /// subscriber to leave. Working is also background work the thread started that still runs (`idle-clock.mjs` `working`:
    /// `hasActiveBackgroundTasks({ callerSessionId })`, any surface), read before the unload.
    pub(super) fn on_idle_evict(&mut self) {
        self.idle_evict_at = None;
        if !self.evictable() {
            // A release decides whether the thread is reclaimable now and never waits for work under way (a pending Goal
            // decision included): it stays, and its idle clock decides again later.
            self.arm_idle_evict();
            self.answer_idle();
            return;
        }
        let (jobs, work, thread) = (self.jobs_tx.clone(), self.deps.work.clone(), self.id.clone());
        tokio::spawn(async move {
            let working = work.has_active(thread.as_str(), "agent", false).await || work.has_active(thread.as_str(), "shell", false).await;
            let _ = jobs.send(JobDone::IdleChecked { working });
        });
    }

    /// The idle deadline's background-work read answered. A clock armed again meanwhile
    /// (the thread went quiet once more, a client resumed it) is the newer one.
    pub(super) fn idle_checked(&mut self, working: bool) {
        // A release waiting for this decision ([`Inbox::IdleRelease`]) takes it now: a clock the thread's own steps armed again
        // meanwhile (its open's Goal check, a busy change that ended) does not put it off; a thread no longer evictable stays.
        if self.idle_evict_at.is_some() && self.idle_acks.is_empty() {
            self.answer_idle();
            return;
        }
        if working || !self.evictable() {
            self.arm_idle_evict();
            self.answer_idle();
        } else {
            self.unload();
        }
    }

    /// The idle decision the waiting releases asked for is made: the thread stays, or it left the directory.
    pub(super) fn answer_idle(&mut self) {
        for ack in self.idle_acks.drain(..) {
            let _ = ack.send(());
        }
    }

    /// The close of a quiet session (`closeSession`'s teardown, the idle clock). It completes only once
    /// everything the session accepted is on disk: what a failed write left goes first, in accept order, and a write that
    /// fails meanwhile fails the close, the session staying open with all of it held ([`Self::on_durability`]), as Node keeps
    /// the runtime whose close barrier did not land (`session-close.mjs` `finishClose`). So an unloaded session leaves nothing
    /// to write behind a reopen.
    pub(super) fn unload(&mut self) {
        // The transcript-cache book leaves memory with the session: what it learned since its last write is committed
        // first, with everything else the session holds, so the next load judges by it.
        if let Some(book) = self.deps.cache_tail.unsaved(self.id.as_str()) {
            let mut set = serde_json::Map::new();
            set.insert("cacheTailBook".to_owned(), book);
            self.accept_header(Some(HeaderChange { set, unset: Vec::new(), patch: Default::default() }));
        }
        if !self.outbox.is_empty() {
            self.unload_due = true;
            self.retry_due |= self.outbox.awaits_retry();
            return;
        }
        // A refused room post can leave nothing to append, but its attempted write still needs reconciliation.
        if self.save_risk.outstanding() {
            if !self.save_risk.unknown.is_empty() && self.ch.dur_tx.try_send(ToDurability::Retry).is_ok() {
                self.unload_due = true;
            } else {
                self.answer_closes();
                self.answer_idle();
            }
            return;
        }
        let Some(directory) = self.ch.directory.upgrade() else {
            self.answer_closes();
            self.answer_idle();
            return;
        };
        // Left, or a subscriber came back and it stays: either way a close has its answer.
        if let Some(stopped) = directory.unload(&self.id, &self.cell, self.close_work("other")) {
            self.unload_stopped = Some(stopped);
            // The session's warm chain outlives it: from here each warm reads the request it repeats from what is stored.
            self.deps.warm.unloaded(&self.id);
            self.deps.deletion.release_unloaded_runtime(self.id.as_str());
            // A side question after the reload forks the next turn's request, not the old runtime's. An unload, as a close, keeps
            // the prompt-cache touch for the restart re-arm (`forgetSideQuestion(id, { cancel: true })`).
            self.deps.side.forget(&self.id, crate::session::turn_ops::SideEnd::Unload);
            // Its book is on disk (committed above): it is no longer open, released here while no other load of the thread
            // can have begun, and is read back from the header on the next use.
            self.deps.cache_tail.release(self.id.as_str());
        }
        self.answer_closes();
        self.answer_idle();
    }

    /// The closing runtime's own work (`close(reason)`, `lifecycle/teardown.mjs:185-195`): `dispatchSessionEnd`, waited for no
    /// longer than `withTeardownDeadline`'s 300 ms (a slower hook goes on by itself), then the memory ingest. `reason` is the
    /// payload's (`sessionEndReason`): `exit` for the core's shutdown (`cli-exit`), `other` for an unload; a worker session ends none at the exit. A session its
    /// close tombstoned or deleted has none left to end: `closeCanonicalSession` drops it before the runtime closes
    /// (`if (!session?.id) return`). Nor has one the core's exit already ended (`ExitClose`, which fires `SessionEnd` before it
    /// closes the session, as `close(reason)` dispatches it before `closeOwnSession`).
    pub(super) fn close_work(&self, reason: &'static str) -> futures::future::BoxFuture<'static, ()> {
        let ingest = self.close_ingest();
        // A worker session is not the runtime's own: the exit's `agentTool.closeAll` detaches it and no `SessionEnd` is
        // dispatched for it (`teardown.mjs:185-187` dispatches the runtime's own session's).
        let worker_at_exit = reason == "exit" && super::super::close::is_worker(&self.acked.header);
        if self.tombstoned || self.deleting || self.cell.session_ended.load(SeqCst) || worker_at_exit {
            return ingest;
        }
        let (hooks, thread, header) = (self.deps.lifecycle.clone(), self.id.clone(), self.acked.header.clone());
        Box::pin(async move {
            let ended = tokio::spawn(async move { hooks.session_end(&thread, &header, reason).await });
            let _ = mixdog_rt::time::timeout(super::super::lifecycle_hooks::SESSION_END_WAIT, ended).await;
            ingest.await;
        })
    }

    /// Today's `ingestSessionIntoMemory(session)` over the model context, each message through the sensitive projection:
    /// the memory database is written to disk, so a sensitive value goes there as its marker. Node passes the loaded
    /// session's own messages (`memory-ingest.mjs:18`) and so writes the value itself into the memory database; fixed on
    /// both sides (`redactSensitiveMessages(session.id, messages)`).
    fn close_ingest(&self) -> futures::future::BoxFuture<'static, ()> {
        let context = ModelContext {
            store: self.deps.store.clone(),
            sensitive: self.deps.sensitive.clone(),
            lanes: self.deps.lanes,
            thread: self.id.clone(),
            input: mixdog_core_api::ids::ItemId::from(String::new()),
        };
        let memory = self.deps.memory.clone();
        let cwd = self.cwd();
        if super::super::session_options::memory_ingest_off(&self.projected.header) {
            return Box::pin(async {});
        }
        Box::pin(async move {
            let Ok(rows) = context.read().await else {
                return;
            };
            let messages: Vec<Value> = rows.into_iter().map(|(_, body)| body).collect();
            let messages = context.sensitive.redacted(&context.thread, &messages);
            memory.ingest(&context.thread, &cwd, messages).await;
        })
    }
}
