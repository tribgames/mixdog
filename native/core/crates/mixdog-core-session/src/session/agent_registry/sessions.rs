//! The agent tool's session side (`Sessions`): the agent tree's handoff read, close and
//! descendants (1.4.5 `agent-tree.mjs`, `session-close.mjs`, `lifecycle-barriers.mjs`).

use std::sync::Arc;

use async_trait::async_trait;
use mixdog_agent::agent_tool::board::{CancelAll, CancelNotice, JobBoard};
use mixdog_agent::agent_tool::dispatch::{CloseParts, cancel_agent_tree, close_resolved, park_idle};
use mixdog_agent::agent_tool::error_text::{ErrorText, PlainErrorText};
use mixdog_agent::agent_tool::host::CloseOptions;
use mixdog_agent::agent_tool::host::Hide;
use mixdog_agent::agent_tool::host::MemberClose;
use mixdog_agent::agent_tool::host::MemberOutcome;
use mixdog_agent::agent_tool::host::OpenSession;
use mixdog_agent::agent_tool::host::Registry;
use mixdog_agent::agent_tool::host::Sessions;
use mixdog_agent::agent_tool::idle_release::IdleRelease;
use mixdog_agent::agent_tool::scope::Scope;
use mixdog_core_api::ThreadHandle;
use mixdog_core_api::ids::ThreadId;
use mixdog_tools::orch::agent::ClosedView;
use mixdog_tools::orch::agent::HideFailed;
use serde_json::Map;
use serde_json::Value;

use super::AgentRegistry;
use super::Row;
use crate::session::Clock;
use crate::session::SessionDirectory;
use crate::session::archive_trees::Mark;
use crate::session::close::Detached;
use crate::session::shell_jobs::OwnedShells;
use mixdog_core_ports::ports::threads::RunFence;
use mixdog_core_ports::ports::threads::ThreadState;
use mixdog_tools::fs::ReadState;

/// The statusline's per-agent route (`clearAgentStatuslineRoute`).
pub trait AgentStatusline: Send + Sync {
    fn clear(&self, session: &str);
}

pub struct AgentSessions {
    directory: Arc<SessionDirectory>,
    threads: Arc<dyn ThreadState>,
    registry: Arc<AgentRegistry>,
    statusline: Arc<dyn AgentStatusline>,
    clock: Arc<dyn Clock>,
    /// The shells a closing session owns.
    shells: Arc<dyn OwnedShells>,
    /// The one read state of the read, edit and apply_patch tools.
    read_state: Arc<ReadState>,
}

impl AgentSessions {
    pub fn new(
        directory: Arc<SessionDirectory>,
        threads: Arc<dyn ThreadState>,
        registry: Arc<AgentRegistry>,
        statusline: Arc<dyn AgentStatusline>,
        clock: Arc<dyn Clock>,
        shells: Arc<dyn OwnedShells>,
        read_state: Arc<ReadState>,
    ) -> Self {
        Self { directory, threads, registry, statusline, clock, shells, read_state }
    }
}

/// An assistant message with content: what `lastStoredAgentHandoff` takes as the handoff.
fn is_handoff(message: &Value) -> bool {
    message.get("role").and_then(Value::as_str) == Some("assistant")
        && match message.get("content") {
            Some(Value::String(text)) => !mixdog_js::js_trim(text).is_empty(),
            other => super::rows::truthy(other),
        }
}

/// `lastStoredAgentHandoff`: the header's `lastHandoff`, else the last assistant message
/// with content (a string as is, anything else as its JSON), else empty.
fn last_handoff(header: &Map<String, Value>, messages: &[Value]) -> String {
    if let Some(Value::String(handoff)) = header.get("lastHandoff") {
        return handoff.clone();
    }
    messages
        .iter()
        .rev()
        .find(|m| is_handoff(m))
        .map(|m| match &m["content"] {
            Value::String(text) => text.clone(),
            other => mixdog_js::json_stringify(other),
        })
        .unwrap_or_default()
}

impl AgentSessions {
    /// `cancelAgentDescendants(parentSessionId, reason)` (`agent-cancel.mjs:152-170`): the parent
    /// refuses admission while it runs; the agent jobs it started are cancelled
    /// (`cancelBackgroundTasks({ surface: 'agent', callerSessionId })`, the owner told as the
    /// board's default says); then every child's tree is cancelled, together. Whether any child
    /// was there to cancel.
    pub async fn cancel_descendants(&self, parent: &str, reason: &str, board: &JobBoard) -> bool {
        let parent = mixdog_js::js_trim(parent).to_owned();
        let _cancelling = self.registry.begin_cancellation(std::slice::from_ref(&parent));
        board.cancel_all(&CancelAll {
            reason: reason.to_owned(),
            scope: Scope { caller_session_id: Some(parent.clone()), host_pid: None },
            ..CancelAll::default()
        });
        let children = self.registry.children_of(&parent);
        if children.is_empty() {
            return false;
        }
        for outcome in futures::future::join_all(children.iter().map(|child| cancel_agent_tree(self, board, child, reason, CloseOptions::default()))).await {
            if let Err(error) = outcome {
                tracing::warn!(parent, %error, "agent tree cancel failed");
            }
        }
        true
    }

    /// `closeAll(reason, { callerSessionId: owner, processExit })` (`close-flow/close-all.mjs:48-70`):
    /// every worker of `owner` is closed through the same close `agent close` runs, each failure
    /// kept (a worker that cannot close never stops the rest); then the owner's agent jobs still
    /// running are cancelled with `reason`; and unless `keep_rows` (a process exit leaves the rows
    /// for the next process) the owner's worker rows, and those of the sessions just closed, are
    /// purged, except a Lead's pool row and a row whose owner is still owed its restart failure.
    /// Node's unscoped form (no owner: every worker, the local tag maps reset) has no caller in
    /// the daemon and is not ported.
    pub async fn close_all(&self, owner: &str, reason: &str, keep_rows: bool, board: &JobBoard) -> Result<CloseAllReport, String> {
        let owner = mixdog_js::js_trim(owner).to_owned();
        if owner.is_empty() {
            return Err("agent close all: an owner session is required".into());
        }
        let scope = Scope { caller_session_id: Some(owner.clone()), host_pid: None };
        self.registry.refresh_tags_from_sessions(false, &scope).await;
        let mut report = CloseAllReport::default();
        let parts = CloseParts { registry: &*self.registry, sessions: self, tasks: board };
        for (tag, row) in self.registry.session_entries(false, &scope) {
            let id = mixdog_js::js_trim(row.get("id").and_then(Value::as_str).unwrap_or_default()).to_owned();
            match close_resolved(parts, &id, &id, &scope, None, keep_rows).await {
                Ok(view) => report.closed.push(view),
                Err(error) => report.failed.push((tag, PlainErrorText.present(&error))),
            }
        }
        for job in board.list_jobs(&scope) {
            if job.status != "running" {
                continue;
            }
            board.cancel(&job.task_id, reason, CancelNotice::Default);
            report.closed.push(ClosedView {
                closed: true,
                tag: job.meta.tag.clone(),
                session_id: job.meta.session_id.clone(),
                task_id: Some(job.task_id.clone()),
                ..ClosedView::default()
            });
        }
        if !keep_rows {
            let closed: std::collections::HashSet<String> = report.closed.iter().filter_map(|view| view.session_id.clone()).collect();
            self.registry.purge_owner_rows(&owner, &closed);
        }
        Ok(report)
    }

    /// What `__close_all` does for an owner (`daemon-agent-control.mjs:75-82`): `closeAll` with
    /// the process-exit scope, and only then `cancelAgentDescendants`, so a worker closed by the
    /// first is not cancelled a second time under it.
    pub async fn teardown_owner(&self, owner: &str, reason: &str, board: &JobBoard) {
        teardown_in_order(
            async {
                if let Err(error) = self.close_all(owner, reason, true, board).await {
                    tracing::warn!(owner, %error, "agent close all failed");
                }
            },
            self.cancel_descendants(owner, reason, board),
        )
        .await;
    }
}

impl AgentSessions {
    /// The idle release (`createIdleRelease`, `close-flow/idle-release.mjs`, with `parkIdle` as its release): every open
    /// idle agent row has a deadline a period after its row's time, checked again whenever the worker rows may have
    /// changed; at its deadline the agent is parked, one agent at a time. Node arms a timer per row; this waits for the
    /// earliest deadline on the registry's clock. Ends once the sessions are gone.
    pub fn keep_idle_release(sessions: std::sync::Weak<Self>, board: JobBoard) -> impl std::future::Future<Output = ()> + Send + 'static {
        Self::idle_release(sessions, board)
    }

    async fn idle_release(sessions: std::sync::Weak<Self>, board: JobBoard) {
        // A deadline past the longest wait looks at the rows again.
        const LONGEST_WAIT_MS: f64 = 3_600_000.0;
        let Some(first) = sessions.upgrade() else { return };
        let (changed, clock) = (first.registry.rows_changed(), first.clock.clone());
        drop(first);
        let mut release = IdleRelease::default();
        loop {
            let rows_changed = changed.notified();
            tokio::pin!(rows_changed);
            rows_changed.as_mut().enable();
            let Some(this) = sessions.upgrade() else { return };
            let now = this.clock.now_ms() as f64;
            let idle = this.registry.idle_rows();
            // A parked agent that stopped being idle (a send resumed it) reads as parked no longer.
            for session in release.check(&idle.iter().map(|(session, row)| (session.clone(), row.at_ms)).collect(), now) {
                this.registry.set_parked(&session, false);
            }
            if let Some(session) = release.take_due(now) {
                if let Some(row) = idle.get(&session) {
                    let parts = CloseParts { registry: &*this.registry, sessions: &*this, tasks: &board };
                    let outcome = park_idle(parts, row).await;
                    let still_idle = this.registry.idle_rows().contains_key(&session);
                    release.settled(&session, &outcome, still_idle, this.clock.now_ms() as f64);
                }
                drop(this);
                // One at a time, a turn apart: a restart finds every old idle agent due at once.
                tokio::task::yield_now().await;
                continue;
            }
            drop(this);
            match release.next_due() {
                Some(at) => tokio::select! {
                    () = clock.until_ms(at.min(now + LONGEST_WAIT_MS).ceil() as i64) => {}
                    () = &mut rows_changed => {}
                },
                None => rows_changed.await,
            }
        }
    }
}

impl AgentSessions {
    /// `closeRuntime` of one session under an admission its caller holds: `Err` when the durable stamp cannot be
    /// written, as Node throws `agent session <id> could not be durably closed`.
    async fn close_stamped(&self, session_id: &str, reason: &str, options: CloseOptions) -> Result<bool, String> {
        let thread = ThreadId::from(session_id);
        let was_running = self.turn_in_flight(session_id);
        // `Ok(false)`: the record is already gone (deleted), which Node's close counts as closed
        // (`finishClose`, `outcome.absent`), so releasing the tag of a deleted session goes on to
        // forget the row and the tag can start a fresh session.
        if crate::session::close::write_detach(&*self.threads, &thread, reason, options.owner_close, self.clock.now_ms(), None).await.is_err() {
            return Err(format!("agent session {session_id} could not be durably closed"));
        }
        crate::session::close::stop_session_work(&self.directory, &*self.shells, &self.read_state, &thread, reason, "agent-close").await;
        // Only a close that stopped a running turn is a cancellation; closing a finished agent keeps its status.
        if was_running {
            self.registry.set_cancelled(session_id, true);
        }
        Ok(true)
    }

    /// What a close does to a thread's work ([`crate::session::close::stop_session_work`]), for one turn of it: decided
    /// at the thread's start gate while `turn` is still the run registered there, so the shells cancelled and the
    /// queued input dropped are the ones that turn left, and the abort names that turn. `false`: the turn had ended,
    /// and nothing of the thread was touched.
    async fn stop_turn_work(&self, thread: &ThreadId, turn: &mixdog_core_api::ids::TurnId, reason: &str) -> bool {
        let Some(handle) = self.directory.handle(thread) else { return false };
        let queued = handle.cell.stop_latches.while_running(thread, turn, || {
            self.shells.cancel_owned(thread);
            handle.cell.queued.load().iter().cloned().collect::<Vec<String>>()
        });
        let Some(queued) = queued else { return false };
        // Before the abort: an aborted turn that settled first would start the next queued entry.
        for queued_id in queued {
            let op = format!("agent-cancel:{queued_id}:drop");
            let request = mixdog_core_api::CoreRequest {
                method: mixdog_core_api::ids::Method("thread/queue/delete"),
                params: serde_json::json!({ "threadId": thread, "opId": op, "queuedId": queued_id, "restore": false }),
                op: Some(mixdog_core_api::ids::OpId::from(op)),
                ctx: mixdog_core_api::call::CallContext::internal("agent-cancel"),
            };
            if let Err(error) = handle.request(request).await {
                tracing::warn!(thread = %thread, "a queued entry was not dropped at a job's cancel: {error:?}");
            }
        }
        handle.cell.abort(turn, &mixdog_agent::cancel::Abort::close_session(thread.as_str(), reason)).is_ok()
    }
}

/// An agent session as the cleanup lists it.
pub(super) fn open_session(session: &Row) -> OpenSession {
    OpenSession {
        id: mixdog_agent::agent_tool::scope::clean(session.get("id")),
        tag: super::rows::agent_tag_of(session),
        agent: mixdog_agent::agent_tool::scope::clean(session.get("agent")),
        owner: super::rows::owner_of(session),
        status: mixdog_agent::agent_tool::scope::clean(session.get("status")),
    }
}

/// The two steps of `__close_all` in Node's order: the workers close first, the descendants are
/// cancelled once that has settled.
async fn teardown_in_order(close_all: impl std::future::Future<Output = ()>, cancel_descendants: impl std::future::Future<Output = bool>) -> bool {
    close_all.await;
    cancel_descendants.await
}

/// What `closeAll` closed and what it could not.
#[derive(Default)]
pub struct CloseAllReport {
    pub closed: Vec<ClosedView>,
    /// `(tag, error)` of each worker whose close failed.
    pub failed: Vec<(String, String)>,
}

/// The directory's `OwnerTeardown` over the agent sessions and the job board: a session's
/// teardown on a process exit (`SessionDirectory::set_owner_teardown`).
pub struct AgentOwnerTeardown {
    pub sessions: Arc<AgentSessions>,
    pub board: JobBoard,
}

#[async_trait]
impl crate::session::directory::OwnerTeardown for AgentOwnerTeardown {
    async fn teardown(&self, owner: &ThreadId, reason: &str) {
        self.sessions.teardown_owner(owner.as_str(), reason, &self.board).await;
    }
}
#[async_trait]
impl Sessions for AgentSessions {
    /// Stored agent sessions open on demand, so there is nothing to load ahead: the registry's
    /// refresh that follows rereads the index (`rehydrateAgentSessions` then
    /// `refreshTagsFromSessions({scanSessions: true})`).
    async fn rehydrate_agent_sessions(&self) -> bool {
        true
    }

    async fn read_session_handoff(&self, session_id: &str) -> Option<String> {
        if session_id.is_empty() {
            return None;
        }
        let thread = ThreadId::from(session_id);
        let header = self.threads.header(&thread).await.ok()?;
        if header.get("lastHandoff").is_some_and(Value::is_string) {
            return Some(last_handoff(&header, &[]));
        }
        let messages = self.directory.model_context(&thread).read_tail_until(is_handoff).await.ok()?;
        Some(last_handoff(&header, &messages))
    }

    fn redact_text(&self, session_id: &str, text: String) -> String {
        self.directory.deps().sensitive.redact_text(&ThreadId::from(session_id), &text)
    }

    /// `closeSession(id, reason, {tombstone: false, ownerClose})`: the durable stamp first
    /// (`bumpSessionGenerationAttempt`: `generation`, `updatedAt`, `detachedReason`, and `ownerClosedAt` on an
    /// owner close), then the running turn is cancelled and the queued input dropped. The
    /// session stays open and resumable. A tombstoning close is not served here.
    async fn close_session(&self, session_id: &str, reason: &str, options: CloseOptions) -> bool {
        self.try_close_session(session_id, reason, options).await.unwrap_or(false)
    }

    /// The stamp is the session's own writer's, made only while `turn_id` is the turn it runs: a session whose turn
    /// ended, or that runs another, is answered `false` with nothing written. The stop that follows is that turn's too
    /// ([`AgentSessions::stop_turn_work`]), so a turn that started on the session meanwhile keeps all of its work.
    async fn close_turn(&self, session_id: &str, turn_id: &str, reason: &str) -> bool {
        if session_id.is_empty() || turn_id.is_empty() {
            return false;
        }
        let (thread, turn) = (ThreadId::from(session_id), mixdog_core_api::ids::TurnId::from(turn_id.to_owned()));
        let at = RunFence::Turn(turn.clone());
        match crate::session::close::write_detach(&*self.threads, &thread, reason, false, self.clock.now_ms(), Some(&at)).await {
            Ok(Detached::Stamped) => {}
            Ok(Detached::Absent | Detached::Moved) => return false,
            Err(error) => {
                tracing::warn!(session = session_id, ?error, "a cancelled job's turn could not be durably closed");
                return false;
            }
        }
        // `cancelAgentTree` (`agent-cancel.mjs:111-114`): nothing is spawned or sent under the session while its turn stops.
        let mut covered = self.registry.descendants(session_id);
        covered.push(session_id.to_owned());
        let _cancelling = self.registry.begin_cancellation(&covered);
        // Only a close that stopped the running turn is a cancellation.
        if self.stop_turn_work(&thread, &turn, reason).await {
            self.registry.set_cancelled(session_id, true);
        }
        true
    }

    /// `closeRuntime`: `Err` when the durable stamp cannot be written, as Node throws
    /// `agent session <id> could not be durably closed`.
    async fn try_close_session(&self, session_id: &str, reason: &str, options: CloseOptions) -> Result<bool, String> {
        if options.tombstone || session_id.is_empty() {
            return Ok(false);
        }
        // `cancelAgentTree` (`agent-cancel.mjs:111-114`): the session and its descendants refuse
        // admission (a spawn or send under them) until the close has ended.
        let mut covered = self.registry.descendants(session_id);
        covered.push(session_id.to_owned());
        let _cancelling = self.registry.begin_cancellation(&covered);
        self.close_stamped(session_id, reason, options).await
    }

    /// The tree's admission guard stops a spawn or a send under it, not a turn started on the member's own session, so
    /// the member's work is stopped at its start gate and only while the registry, which counts each turn started on a
    /// worker, still names the turn the close was decided at. A turn that started while the stamp was written keeps
    /// running, with its input: the stamp then reads as a close the session was resumed after.
    async fn close_member(&self, session_id: &str, reason: &str, options: CloseOptions, member: MemberClose) -> Result<MemberOutcome, String> {
        if options.tombstone || session_id.is_empty() {
            return Ok(MemberOutcome::Nothing);
        }
        let at_turn = || self.registry.turn_mark(session_id) == member.turn;
        if self.turn_in_flight(session_id) || !at_turn() {
            return Ok(MemberOutcome::Moved);
        }
        let thread = ThreadId::from(session_id);
        // The stamp is the session's own writer's, made only while it runs nothing: a session that took up work first
        // is answered `Moved` with nothing written.
        let stamped = if member.stamped {
            false
        } else {
            match crate::session::close::write_detach(&*self.threads, &thread, reason, options.owner_close, self.clock.now_ms(), Some(&RunFence::Idle)).await {
                Ok(Detached::Stamped) => true,
                Ok(Detached::Absent) => false,
                Ok(Detached::Moved) => return Ok(MemberOutcome::Moved),
                Err(_) => return Err(format!("agent session {session_id} could not be durably closed")),
            }
        };
        let stopped = crate::session::close::stop_idle_work(&self.directory, &*self.shells, &self.read_state, &thread, reason, at_turn);
        Ok(match (stopped, stamped) {
            (true, _) => MemberOutcome::Closed,
            // A turn started after the stamp landed: a close the session was resumed after.
            (false, true) => MemberOutcome::Resumed,
            (false, false) => MemberOutcome::Moved,
        })
    }

    fn descendant_session_ids(&self, session_id: &str) -> Vec<String> {
        self.registry.descendants(session_id)
    }

    fn child_session_ids(&self, session_id: &str) -> Vec<String> {
        self.registry.children_of(session_id)
    }

    /// The signal listener holds them: neither a held session's records nor its row writes reach every loaded thread.
    fn hold_publication(&self, ids: &[String]) -> Box<dyn Send> {
        self.directory.deps().agent_signals.hold(ids)
    }

    /// The worker-map writes made under the hold are header records of their own: they land, and are owed to it, first.
    async fn publish_held(&self, hold: Box<dyn Send>) {
        if let Err(error) = self.registry.rows_settled().await {
            tracing::warn!(%error, "[agent] a worker row of the cleanup is not saved yet");
        }
        drop(hold);
    }

    fn begin_cancellation(&self, ids: &[String]) -> Box<dyn Send> {
        Box::new(self.registry.begin_cancellation(ids))
    }

    /// Each hide is the archive authority's own decision, made in its commit: against the release the registry holds
    /// of the session then, or, for a leftover, against the turn the session runs then. A turn that starts on the
    /// session ends both and then asks the same authority to bring it back
    /// ([`crate::session::archive_trees::restore_at_turn_start`]), as a send's reveal does, so a session that was
    /// taken up again is left listed whichever came first.
    async fn hide_sessions(&self, hides: &[Hide]) -> Vec<HideFailed> {
        let mut failed = Vec::new();
        for Hide { session_id: id, released_at } in hides.iter().filter(|hide| !hide.session_id.is_empty()) {
            // An archived session keeps its stamp; one that is gone has nothing to hide.
            let Ok(header) = self.threads.header(&ThreadId::from(id.as_str())).await else { continue };
            let now = self.clock.now_ms() as f64;
            let still: Box<dyn Fn() -> bool + Send> = match released_at.clone() {
                Some(release) => {
                    let (registry, session) = (self.registry.clone(), id.clone());
                    Box::new(move || registry.released_stamp(&session).as_deref() == Some(release.as_str()))
                }
                None => {
                    let (directory, session) = (self.directory.clone(), id.clone());
                    Box::new(move || !super::LiveSessions::running(&*directory, &session))
                }
            };
            if let Err(error) = self.directory.mark_archived(id, &header, Mark::While { stamp: Box::new(move || now), still }).await {
                tracing::warn!(session = %id, ?error, "a closed agent's session stays listed");
                failed.push(HideFailed { session_id: id.clone(), reason: format!("could not save the hidden sessions: {error:?}") });
            }
        }
        failed
    }

    /// Read as a listing reads the session, without opening it: a cleanup asks this of every closed agent of the caller.
    async fn is_hidden(&self, session_id: &str) -> bool {
        self.directory
            .listed_fields(&ThreadId::from(session_id), &["archivedAt"])
            .await
            .is_some_and(|header| self.directory.archive_state(session_id, &header).archived())
    }

    /// `sessionGone` (`agent-tree.mjs`) over `storedSessionAbsent`: gone only when the index lists the session no longer
    /// and its record reads as absent. A loaded session is there, and so is one whose record could not be read.
    async fn session_gone(&self, session_id: &str) -> bool {
        !session_id.is_empty() && !self.registry.knows_session(session_id) && self.directory.stored_presence(&ThreadId::from(session_id)).await == Some(false)
    }

    fn turn_in_flight(&self, session_id: &str) -> bool {
        super::LiveSessions::running(&*self.directory, session_id)
    }

    /// `parkSession` (`agent-tree.mjs`): an agent that is known and not closed is parked once no runtime of it is left.
    /// Node releases a runtime that is neither busy nor watched there and then, reaping the background work the session
    /// runs (`keepBackgroundWork: false`). Here a quiet session nobody watches leaves memory by the session's own idle
    /// clock ([`IDLE_EVICT`](crate::session::actor)), which keeps a session whose background work still runs: while the
    /// session is loaded this answers `false`, and the idle release asks again one period later.
    async fn park_session(&self, session_id: &str) -> bool {
        let Some(session) = self.registry.session_of(session_id) else { return false };
        if session.get("closed") == Some(&Value::Bool(true)) || self.directory.handle(&ThreadId::from(session_id)).is_some() {
            return false;
        }
        self.registry.set_parked(session_id, true);
        true
    }

    fn open_sessions(&self) -> Vec<OpenSession> {
        self.registry.open_sessions().iter().map(open_session).collect()
    }

    async fn reveal_session(&self, session_id: &str) {
        if session_id.is_empty() {
            return;
        }
        // The session is used again: the release a close's hide belongs to ends here, before the reveal, so a hide
        // of that close that is asked for after it finds the release gone.
        self.registry.clear_released(session_id);
        // Still hidden on a failed write: the next send tries again.
        if let Ok(header) = self.threads.header(&ThreadId::from(session_id)).await {
            let _ = self.directory.mark_archived(session_id, &header, Mark::Restore).await;
        }
    }

    fn clear_statusline_route(&self, session_id: &str) {
        if !session_id.is_empty() {
            self.statusline.clear(session_id);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// `lastStoredAgentHandoff`.
    #[test]
    fn the_handoff_is_the_saved_one_else_the_last_assistant_message() {
        let saved = serde_json::from_value(json!({ "lastHandoff": "" })).unwrap();
        assert_eq!(last_handoff(&saved, &[json!({ "role": "assistant", "content": "x" })]), "");
        let none = Map::new();
        let messages = [
            json!({ "role": "assistant", "content": "first" }),
            json!({ "role": "assistant", "content": [{ "type": "text", "text": "parts" }] }),
            json!({ "role": "assistant", "content": "  " }),
            json!({ "role": "user", "content": "later" }),
        ];
        assert_eq!(last_handoff(&none, &messages), r#"[{"type":"text","text":"parts"}]"#);
        assert_eq!(last_handoff(&none, &messages[..1]), "first");
        assert_eq!(last_handoff(&none, &[]), "");
    }

    /// `__close_all` (`daemon-agent-control.mjs:75-82`): the workers close first, the descendants
    /// are cancelled after that has settled.
    #[tokio::test]
    async fn a_teardown_closes_the_workers_before_it_cancels_the_descendants() {
        let log = std::sync::Mutex::new(Vec::new());
        let (started, close_started) = tokio::sync::oneshot::channel();
        let (finish, finish_close) = tokio::sync::oneshot::channel::<()>();
        let mut teardown = std::pin::pin!(teardown_in_order(
            async {
                started.send(()).unwrap();
                finish_close.await.unwrap();
                log.lock().unwrap().push("close_all");
            },
            async {
                log.lock().unwrap().push("cancel_descendants");
                true
            },
        ));
        // The close has begun and is held: a teardown running both at once would have logged the cancel by now.
        assert!(futures::poll!(teardown.as_mut()).is_pending());
        crate::session::testing::awaiting(|| "the close to begin".to_owned(), close_started).await.unwrap();
        assert!(log.lock().unwrap().is_empty(), "the descendants wait for the close");
        finish.send(()).unwrap();
        assert!(crate::session::testing::awaiting(|| "the teardown to end once the close has".to_owned(), teardown).await);
        assert_eq!(*log.lock().unwrap(), ["close_all", "cancel_descendants"]);
    }
}
