//! Status and workspace reads: setup UI, agent status, context display, head following and route moves.

use super::*;

impl SessionActor {
    /// The session store's `setup-ui` action (`set({ setupUiRequest: { id, at: Date.now() } })`):
    /// the request is thread state, so a snapshot carries it as a replay does, until it is
    /// settled or its claim window ends.
    pub(super) fn setup_ui_request(&mut self, id: String, window: std::time::Duration) {
        let request = mixdog_app_protocol::v2::thread::SetupUiRequest { id: id.clone(), at: self.deps.clock.now_ms() };
        self.accept_view(Change::Section(Section::SetupUiRequest(Some(request))), Vec::new());
        let jobs = self.jobs_tx.downgrade();
        tokio::spawn(async move {
            mixdog_rt::time::sleep(window).await;
            if let Some(jobs) = jobs.upgrade() {
                let _ = jobs.send(JobDone::SetupUiExpired(id));
            }
        });
    }

    /// The request `id` can no longer be claimed: the thread stops showing it, unless a newer
    /// request took its place.
    pub(super) fn setup_ui_settled(&mut self, id: &str) {
        if self.projected.sections.setup_ui_request.as_ref().is_some_and(|request| request.id == id) {
            self.accept_view(Change::Section(Section::SetupUiRequest(None)), Vec::new());
        }
    }

    /// The agent status is read again (the agent tool's `statusMayHaveChanged`). When the signal is `named`, a job of this
    /// thread added or finished (`emitSessionActivityChange(ownerSessionId)`), the idle clock also starts over (`refresh`):
    /// Node's clock hears no source that names no session. A closed thread has no runtime to tell.
    pub(super) fn agent_activity(&mut self, named: bool) {
        if self.tombstoned || self.cell.closed.load(SeqCst) {
            return;
        }
        if named && self.idle_evict_at.is_some() {
            self.arm_idle_evict();
        }
        self.read_agent_status(true);
    }

    /// The agents section's scope as the header now gives it, with the rows it holds: seated in the step that moves the
    /// header (load, a route move), so no state shows the thread without its scope or with the old one. `None` when it holds it.
    pub(super) fn agents_with_scope(&self) -> Option<mixdog_app_protocol::v2::thread::ThreadAgents> {
        let current = self.projected.sections.agents.clone().unwrap_or_default();
        let scope = super::super::agent_registry::status_rows::agent_scope(&self.id, &self.projected.header);
        (current.agent_scope.as_ref() != Some(&scope)).then(|| mixdog_app_protocol::v2::thread::ThreadAgents { agent_scope: Some(scope), ..current })
    }

    /// Reads the thread's agent status off the actor. `listener`: the read is the status
    /// listener's (`onAgentStatusChange`), which also schedules the Goal continuation; the
    /// load's first status pass (`runtimePulse`) only publishes.
    pub(super) fn read_agent_status(&self, listener: bool) {
        let (jobs, status, thread) = (self.jobs_tx.downgrade(), self.deps.agent_status.clone(), self.id.clone());
        tokio::spawn(async move {
            if !listener {
                mixdog_rt::time::sleep(STATUS_SETTLE).await;
            }
            let Some(jobs) = jobs.upgrade() else { return };
            let agents = status.status(&thread).await;
            let _ = jobs.send(JobDone::AgentStatus { agents, listener });
        });
    }

    /// The load's status pass also runs `syncContextStats` (local-session-runtime.mjs createRuntimePulse): the context status of
    /// the thread, read off the actor one settle beat later, fills the display fields.
    ///
    /// The pass reads the status from the header alone (`header_status`): the figures and the stored measurement of the last
    /// model call, as Codex restores its last token count on resume. Counting the transcript here read the whole conversation
    /// and its media at every open; the full count is read when a client asks (`thread/contextStatus`) and at each request.
    pub(super) fn read_context_display(&mut self) {
        let pass = self.next_status_pass();
        let (jobs, gauge, thread) = (self.jobs_tx.clone(), self.deps.context_status.clone(), self.id.clone());
        tokio::spawn(async move {
            mixdog_rt::time::sleep(STATUS_SETTLE).await;
            let status = gauge.header_status(thread).await.unwrap_or(Value::Null);
            let _ = jobs.send(JobDone::ContextStatus(pass, status));
        });
    }

    /// The number of a status pass about to start: results are ordered by it, not by arrival.
    pub(super) fn next_status_pass(&mut self) -> u64 {
        self.status_passes += 1;
        self.status_passes
    }

    /// Until the session folds a model call of its own, the status's `measurement` is the context reading, pending included; a pass
    /// older than one already applied changes nothing.
    pub(super) fn apply_measurement(&mut self, pass: u64, status: &Value) {
        if pass < self.status_applied {
            return;
        }
        self.status_applied = pass;
        if status.get("measurement").is_some_and(|m| self.stats.restore_measurement(m)) {
            self.publish_stats();
        }
    }

    /// The workspace `routeState` publishes (`getLiveWorkspace`), read off the actor: at load and whenever the header's `cwd`,
    /// `workspace` or `desktopSession` moved.
    pub(super) fn read_live_workspace(&mut self) {
        self.live_workspace_reads += 1;
        let (jobs, live, thread, read) = (self.jobs_tx.clone(), self.deps.live_workspace.clone(), self.id.clone(), self.live_workspace_reads);
        tokio::spawn(async move {
            let workspace = live.live(thread.as_str()).await;
            let _ = jobs.send(JobDone::LiveWorkspace(read, workspace));
        });
    }

    /// Follows the HEAD of the checkout the header's `cwd` lies in (`createGitHeadWatcher`, `local-session-runtime.mjs` headWatch):
    /// the sessions of one repository share one watch, and a HEAD written outside the session (`git switch`, a branch rename, a
    /// detach) reads the live workspace again, so the branch shows within a frame. Called at load and when `cwd` moved.
    pub(super) fn follow_head(&mut self) {
        let cwd = self.projected.header.get("cwd").and_then(Value::as_str).unwrap_or_default().to_owned();
        if cwd == self.head_cwd {
            return;
        }
        self.head_follows += 1;
        self.head_task = None;
        self.head_cwd = cwd.clone();
        if cwd.is_empty() {
            return;
        }
        let (done, seq) = (self.jobs_tx.clone(), self.head_follows);
        mixdog_core_base::support::lane_job(
            self.deps.lanes.io,
            "head-follow",
            // Never cancelled: a superseded follow is discarded by its sequence number when it answers.
            &CancellationToken::new(),
            move |_| mixdog_scm::head_watch::HeadWatchers::shared().follow(std::path::Path::new(&cwd)),
            move |followed| drop(done.send(JobDone::HeadFollowing(seq, followed.ok().flatten()))),
        );
    }

    /// The follow `seq` is made: the live workspace of the (new) `cwd` is read now, which also covers a HEAD that moved before the
    /// watch was set, and each later write of HEAD is read when it comes. A `cwd` outside any checkout is read once and followed by
    /// nothing.
    pub(super) fn head_following(&mut self, seq: u64, follow: Option<mixdog_scm::head_watch::HeadFollow>) {
        if seq != self.head_follows || self.tombstoned || self.cell.closed.load(SeqCst) {
            return;
        }
        if let Some(mut follow) = follow {
            let jobs = self.jobs_tx.clone();
            self.head_task = Some(HeadTask(tokio::spawn(async move {
                while follow.moved().await {
                    if jobs.send(JobDone::HeadMoved(seq)).is_err() {
                        return;
                    }
                }
            })));
        }
        self.read_live_workspace();
    }

    /// `syncContextDisplayFields(status)` (context-state.mjs:116-136): the window the status shows, the compaction boundary and
    /// the auto-compact trigger (`compaction.triggerTokens || compaction.autoCompactTokenLimit || session.autoCompactTokenLimit`),
    /// each only once known (> 0).
    pub(super) fn context_display(&mut self, pass: u64, status: &Value) {
        if self.tombstoned || self.cell.closed.load(SeqCst) || !status.is_object() || pass < self.status_applied {
            return;
        }
        // The reading is part of the restored state: it shows without waiting for the next model response.
        self.apply_measurement(pass, status);
        let context = self.display_figures(status);
        if context != ThreadContext::default() {
            self.on_context_section(context);
        }
    }

    /// The display fields `syncContextDisplayFields` takes from `status`, each only once known (> 0).
    pub(super) fn display_figures(&self, status: &Value) -> ThreadContext {
        let positive = |value: Option<&Value>| value.and_then(Value::as_f64).filter(|n| n.is_finite() && *n > 0.0).map(|n| n as i64);
        let compaction = status.get("compaction");
        ThreadContext {
            display_context_window: positive(status.get("contextWindow")),
            compact_boundary_tokens: positive(compaction.and_then(|c| c.get("boundaryTokens"))),
            auto_compact_token_limit: positive(compaction.and_then(|c| c.get("triggerTokens")))
                .or_else(|| positive(compaction.and_then(|c| c.get("autoCompactTokenLimit"))))
                .or_else(|| positive(self.projected.header.get("autoCompactTokenLimit"))),
            ..Default::default()
        }
    }

    /// The header a `thread/header/patch` leaves when it moves the session's route window (`updateSessionRoute`); `None` for any
    /// other request, and while a turn runs (its display fields wait for the turn's end, [`Self::on_context_section`]).
    pub(super) fn window_move_header(&self, req: &CoreRequest) -> Option<Header> {
        if req.method.as_str() != "thread/header/patch" || matches!(req.ctx.caller, Caller::Connection(_)) || self.run.is_some() {
            return None;
        }
        let set = req.params.get("set").and_then(Value::as_object);
        let unset: Vec<&str> =
            req.params.get("unset").and_then(Value::as_array).map(|keys| keys.iter().filter_map(Value::as_str).collect()).unwrap_or_default();
        self.window_move_of(set, &unset)
    }

    /// The header `set`/`unset` leave when they move the route window; `None` when they do not.
    pub(super) fn window_move_of(&self, set: Option<&serde_json::Map<String, Value>>, unset: &[&str]) -> Option<Header> {
        let header = &self.projected.header;
        let moves = WINDOW_KEYS.iter().any(|key| {
            set.and_then(|set| set.get(*key)).is_some_and(|value| header.get(*key) != Some(value)) || (unset.contains(key) && header.contains_key(*key))
        });
        if !moves {
            return None;
        }
        let mut next = header.clone();
        for key in unset {
            next.shift_remove(*key);
        }
        for (key, value) in set.into_iter().flatten() {
            next.insert(key.clone(), value.clone());
        }
        Some(next)
    }

    /// A route move as a pending step: the new route's context status is read off the actor for the header the move writes, and the
    /// actor goes on serving (a cancel, a read, a turn: in Node the read is awaited by `setRoute` alone, routes-write.mjs:168, and a
    /// turn started meanwhile runs on the route the runtime holds, set-route.mjs:272,300-311). When the read returns, the move is
    /// accepted with its figures in one step ([`Self::accept_record_entry`]) and answered after it.
    pub(super) fn start_route_move(&mut self, apply: MoveApply, header: Header) {
        self.route_moves += 1;
        let pass = self.next_status_pass();
        let (seq, jobs, gauge, thread) = (self.route_moves, self.jobs_tx.clone(), self.deps.context_status.clone(), self.id.clone());
        tokio::spawn(async move {
            let status = match mixdog_rt::time::timeout(ROUTE_STATUS_DEADLINE, gauge.context_status_for(thread.clone(), header)).await {
                Ok(Ok(status)) if status.is_object() => Some(status),
                Ok(Ok(_)) => None,
                Ok(Err(error)) => {
                    tracing::warn!(thread = %thread, "the route move's context status failed: {error:?}");
                    None
                }
                Err(_) => {
                    tracing::warn!(thread = %thread, "the route move's context status missed its {}s deadline", ROUTE_STATUS_DEADLINE.as_secs());
                    None
                }
            };
            let _ = jobs.send(JobDone::RouteStatus { seq, status });
        });
        self.route_move = Some(PendingMove { seq, pass, apply });
    }

    /// The pending route move `seq` read its figures (`None`: the read failed): the move is written now, with them.
    pub(super) fn route_status_read(&mut self, seq: u64, status: Option<Value>) {
        let Some(pending) = self.route_move.take_if(|pending| pending.seq == seq) else { return };
        self.route_status = Some(status.map(|status| (pending.pass, status)));
        match pending.apply {
            MoveApply::Request { req, tx } => self.on_inbox(Inbox::Request { req, tx }),
            MoveApply::Change { change, tx } => self.write_header_change(change, tx),
        }
        self.route_status = None;
    }

    /// The display figures of a route move whose status read failed, as Node's `syncContextStats` leaves them when the runtime has no
    /// status (context-state.mjs:137-142: no patch) and `publishRoute` publishes `routeState()`: the figures held for an unchanged
    /// window, 0 for a moved one (context-state.mjs:100-113). Nothing is read again for it.
    pub(super) fn unread_figures(&self, before: &(Option<Value>, Option<Value>)) -> ThreadContext {
        let header = &self.projected.header;
        if (header.get("contextWindow").cloned(), header.get("rawContextWindow").cloned()) == *before {
            return ThreadContext::default();
        }
        ThreadContext { display_context_window: Some(0), compact_boundary_tokens: Some(0), auto_compact_token_limit: Some(0), ..Default::default() }
    }

    /// `set({ ...agentStatusState() })` publishes the lists only when they changed. A thread
    /// that never published them shows Node's initial empty lists (`initial-state.mjs:55`), so
    /// empty lists are no change. The status listener then calls `scheduleGoalContinuation()`.
    pub(super) fn agent_status(&mut self, agents: mixdog_app_protocol::v2::thread::ThreadAgents, listener: bool) {
        if self.tombstoned || self.cell.closed.load(SeqCst) {
            return;
        }
        // Before a created thread's first pass its status scope is not noted (agent-tool.mjs `noteStatusScope`, by the pass's `getStatus`):
        // a signal finds no scope whose answer changed and tells no listener (`statusMayHaveChanged`, :287-313).
        if listener && self.projected.status_pending {
            return;
        }
        if !listener {
            self.projected.status_pending = false;
            self.acked.status_pending = false;
        }
        // The scope is the header's (seated with it); a read that could not see the thread's handle keeps it.
        let mut agents = agents;
        if agents.agent_scope.is_none() {
            agents.agent_scope = Some(super::super::agent_registry::status_rows::agent_scope(&self.id, &self.projected.header));
        }
        if self.projected.sections.agents.clone().unwrap_or_default() != agents {
            self.accept_view(Change::Section(Section::Agents(agents)), Vec::new());
        }
        if listener {
            self.schedule_goal_continuation();
        }
    }
}
