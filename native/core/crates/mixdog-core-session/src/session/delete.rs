use std::sync::Arc;
use std::sync::atomic::Ordering::SeqCst;

use async_trait::async_trait;
use futures::future::BoxFuture;
use mixdog_core_api::CoreError;
use mixdog_core_api::ids::ThreadId;

/// The reason `deleteSession` closes with.
pub const DELETE_REASON: &str = "desktop-session-delete";

/// One store purge hook (`registerSessionPurgeHook`), best effort; `cwds` are the working
/// folders the session is known to have used (`knownSessionCwds`). Node's hooks are
/// synchronous, so their effects have landed when the delete completes: the returned future
/// resolves once this hook's effect has (its lane job included).
pub trait PurgeHook: Send + Sync {
    fn purge(&self, session_id: &str, cwds: &[String]) -> BoxFuture<'static, ()>;
}

impl<F: Fn(&str, &[String]) -> BoxFuture<'static, ()> + Send + Sync> PurgeHook for F {
    fn purge(&self, session_id: &str, cwds: &[String]) -> BoxFuture<'static, ()> {
        self(session_id, cwds)
    }
}

/// The store purge hooks in the order a booted 1.4.5 daemon registers (and so runs) them
/// (`delete_goldens/purge_order.json`). The turn review's (`runtime-review-api.mjs:26`) is
/// `SessionDeps.turn_review`'s `forget_session`, run in its place between `connector_accounts`
/// and `worker_turns`. Node's `usageMetrics`, `browserSession` and `compactionCapture` hooks
/// have no Rust counterpart: Rust holds no such per-session state (decisions.md, "Session
/// delete purge hooks").
pub struct PurgeHooks {
    /// The hooks' read-only copy of the session log (`transcript_export`): where Node's store
    /// unlinks `<id>.log.jsonl`, before its hooks run.
    pub transcript_export: Arc<dyn PurgeHook>,
    /// `tool-result-offload.mjs:506` `clearOffloadSessionSync`.
    pub tool_result_offload: Arc<dyn PurgeHook>,
    /// `session-transcript-purge.mjs:20`: the conversation transcripts under `cwds` and their
    /// memory ingest offsets.
    pub transcripts: Arc<dyn PurgeHook>,
    /// `cache-warm.mjs:424`: `Warmer::purge_session`.
    pub cache_warm: Arc<dyn PurgeHook>,
    /// `read-cache.mjs:317`: the read snapshots in memory and `read-snapshots/<scope>.json`.
    pub read_cache: Arc<dyn PurgeHook>,
    /// `session-close.mjs:282` `closeProviderConnections(id, 'session-deleted')`.
    pub provider_connections: Arc<dyn PurgeHook>,
    /// `boot/providers.mjs:54` `forgetConversationConnectorAccounts`.
    pub connector_accounts: Arc<dyn PurgeHook>,
    /// `worker-turns.mjs:208`.
    pub worker_turns: Arc<dyn PurgeHook>,
    /// `agent-tool.mjs:347`: `registry.forgetDeletedSession`, its status scopes.
    pub agent_status: Arc<dyn PurgeHook>,
    /// After the hooks (`_deleteSession`): `deleteCompactionArchive`.
    pub compaction_archive: Arc<dyn PurgeHook>,
    /// After the hooks: `removeSessionScratchDir` (a locked file never fails the delete).
    pub scratch_dir: Arc<dyn PurgeHook>,
    /// Last, once the store's delete is done: the desktop's `forgetDeletedSession`
    /// `sessionRetention.forget(id)` (`session-host-lifecycle.ts:573`), which Node runs after the
    /// daemon answered the delete.
    pub retention: Arc<dyn PurgeHook>,
}

impl PurgeHooks {
    /// The hooks run before the turn review's. `stored`: the session has a stored record. The files of one never stored
    /// that lie where a stored session's export and compaction sidecars lie (`sessions/<id>.log.jsonl`, its
    /// `.compaction-archive.*`) are the earlier version's own record of it: the migration that recorded them removes them,
    /// only while they are the files it recorded, so the two hooks that remove those names do not run for it.
    fn before_review(&self, stored: bool) -> Vec<&Arc<dyn PurgeHook>> {
        let mut hooks = Vec::new();
        if stored {
            hooks.push(&self.transcript_export);
        }
        hooks.extend([&self.tool_result_offload, &self.transcripts, &self.cache_warm, &self.read_cache, &self.provider_connections, &self.connector_accounts]);
        hooks
    }

    /// The hooks run for a session never stored, in their order (the turn review's own forgetting, which is no hook, apart).
    pub fn unconverted_hooks(&self) -> Vec<&Arc<dyn PurgeHook>> {
        let mut hooks = self.before_review(false);
        hooks.extend(self.after_review(false));
        hooks
    }

    /// The hooks run after the turn review's; `stored` as in [`Self::before_review`].
    fn after_review(&self, stored: bool) -> Vec<&Arc<dyn PurgeHook>> {
        let mut hooks = vec![&self.worker_turns, &self.agent_status];
        if stored {
            hooks.push(&self.compaction_archive);
        }
        hooks.extend([&self.scratch_dir, &self.retention]);
        hooks
    }

    /// [`Self::run`] with `stored` given: a session of an earlier version that the migration removed without converting it
    /// (`false`) gets the same hooks in the same order, but for the two that remove the earlier version's own files of it
    /// ([`Self::before_review`]).
    async fn run_as(&self, review: &dyn mixdog_core_api::turn_review::TurnReviewApi, id: &str, cwds: &[String], stored: bool) {
        for hook in self.before_review(stored) {
            hook.purge(id, cwds).await;
        }
        review.forget_session(id);
        for hook in self.after_review(stored) {
            hook.purge(id, cwds).await;
        }
    }

    /// `_runSessionPurgeHooks(id, { cwds })`, then the archive and scratch removal, one after
    /// another; it returns once every hook's effect has landed.
    pub async fn run(&self, review: &dyn mixdog_core_api::turn_review::TurnReviewApi, id: &str, cwds: &[String]) {
        self.run_as(review, id, cwds, true).await;
    }
}

#[cfg(test)]
mod unconverted_purge_tests {
    use std::sync::Mutex;

    use super::*;

    /// The purge of a session removed unconverted runs every hook of a delete, the read cache's among them, in a delete's
    /// order, and leaves out the two hooks that remove files the migration removes itself.
    #[test]
    fn the_purge_of_an_unconverted_session_is_a_deletes_but_for_its_source_files() {
        let ran: Arc<Mutex<Vec<&'static str>>> = Arc::default();
        let hook = |name: &'static str| -> Arc<dyn PurgeHook> {
            let ran = ran.clone();
            Arc::new(move |_: &str, _: &[String]| -> BoxFuture<'static, ()> {
                ran.lock().unwrap().push(name);
                Box::pin(std::future::ready(()))
            })
        };
        let hooks = PurgeHooks {
            transcript_export: hook("transcriptExport"),
            tool_result_offload: hook("toolResultOffload"),
            transcripts: hook("transcripts"),
            cache_warm: hook("cacheWarm"),
            read_cache: hook("readCache"),
            provider_connections: hook("providerConnections"),
            connector_accounts: hook("connectorAccounts"),
            worker_turns: hook("workerTurns"),
            agent_status: hook("agentStatus"),
            compaction_archive: hook("compactionArchive"),
            scratch_dir: hook("scratchDir"),
            retention: hook("retention"),
        };
        let names = |stored: bool| {
            ran.lock().unwrap().clear();
            let all = if stored { hooks.before_review(true).into_iter().chain(hooks.after_review(true)).collect() } else { hooks.unconverted_hooks() };
            for hook in all {
                drop(hook.purge("sess_w", &[]));
            }
            ran.lock().unwrap().clone()
        };
        let deleted = names(true);
        assert_eq!(deleted.len(), 12, "a delete runs every hook: {deleted:?}");
        let unconverted = names(false);
        assert!(unconverted.contains(&"readCache") && unconverted.contains(&"transcripts") && unconverted.contains(&"scratchDir"));
        assert_eq!(unconverted, deleted.into_iter().filter(|name| !matches!(*name, "transcriptExport" | "compactionArchive")).collect::<Vec<_>>());
    }
}

/// What `deleteSession` does outside the session and its store. Node's
/// `agentTool.forgetLeadSession(id)` is part of the agent status purge (`AgentRegistry::forget_deleted_session`): a Lead's
/// pool row is the session's own `worker` header map, which the registry keeps past the session's header as it keeps a
/// deleted agent's row, so the purge removes it.
#[async_trait]
pub trait DeleteSeams: Send + Sync {
    /// `releaseSessionWork(id, reason)`: `cancelBackgroundTasks({ reason, notify: false,
    /// executionSessionId: id })` (this session's own tasks, not the sessions it delegated to),
    /// then `statusRoutes.clearGatewaySessionRoute(id)`; returns once both have landed, as
    /// Node's synchronous calls have. The shells the session owns are cancelled with them
    /// (`cancelOwnedShellProcesses`, `session-close.mjs:184`).
    async fn release_session_work(&self, session_id: &str, reason: &str);
    /// The close's tombstone write was acknowledged (`markSessionClosed`): the `[session-close]`
    /// line of `tool-events.log` from the session's stored `header` (`_logSessionCloseMetric`),
    /// its life measured to `closed_at_ms`, the instant the close landed. `reason` is the close
    /// reason (`desktop-session-delete`), not the abort text.
    fn session_closed(&self, session_id: &str, reason: &str, header: &mixdog_store::schema::record::Header, closed_at_ms: i64);
    /// The delete mark landed, so a list no longer shows the conversation: what ends with its presence in the catalog (a phone's
    /// downloads) ends now, before the purge, not when `thread/deleted` is published after it.
    fn tombstoned(&self, thread: &ThreadId);
    /// The close's tombstone landed: the MCP scope the session holds is released and its servers
    /// close (the runtime's teardown, `disconnectAll({ scopeId })`, `runtime-stops.mjs:24`). Not awaited.
    fn release_mcp_scope(&self, session_id: &str);
    /// Ends the session's external (ACP) agent process without closing the conversation or its MCP owner.
    fn release_agent_process(&self, _session_id: &str) {}
    /// Lets go of the session's external (ACP) agent process where its agent is idle, keeping what the session approved
    /// and holds so its next turn reopens it; an agent that is not idle keeps running.
    fn release_idle_agent_process(&self, _session_id: &str) {}
    /// The session's runtime unloaded while its external (ACP) agent process stays: the agent is not reopened before the
    /// session's next turn.
    fn agent_process_unloaded(&self, _session_id: &str) {}
    /// A turn of the session, one that can start sub-agents, began: the external (ACP) agents its sub-agents run on
    /// are made ready ahead.
    fn agent_turn_under_way(&self, _session_id: &str) {}
    /// Release resources of an unloaded runtime without closing the conversation.
    fn release_unloaded_runtime(&self, _session_id: &str) {}
    /// The loaded session rested (it stays loaded, watched and idle): what was kept only for its next turn goes, rebuilt
    /// from storage when that turn or a read asks for it.
    fn release_rested(&self, _session_id: &str) {}
    /// The session ended for good (a closing tombstone or a delete): what other owners keep for it goes.
    fn session_ended(&self, _session_id: &str) {}
    /// The session was deleted (after [Self::session_ended]), its runtime possibly still winding down: what a closed session
    /// still needs goes.
    fn session_deleted(&self, _session_id: &str) {}
    /// `forgetSessionSearch(id)`, not awaited.
    fn forget_session_search(&self, session_id: &str);
    /// `releaseDeletedWorktree(id)`: the worktree maintenance's `cleanupDeletedSession`, off the
    /// delete; never fails it.
    async fn release_deleted_worktree(&self, session_id: &str);
    /// `purgeAgentDefinition(agentId)` (`deleteSessionLocked`): the user's delete of a deleted bot's archived home chat takes the
    /// bot for good. A refusal fails the delete, as Node's awaited control call does.
    async fn purge_retired_agent(&self, _agent_id: &str) -> Result<(), String> {
        Ok(())
    }
    /// `thread/deleted` on the app feed.
    fn thread_deleted(&self, thread: &ThreadId);
    /// `getSession()?.id`: the session the runtime serving the idle delete has current. A daemon
    /// thread is never its runtime's current one, so there is none unless the embedder has one.
    fn current_session(&self) -> Option<String> {
        None
    }
    /// The idle delete's `isHostedBusy(id)`: whether a runtime hosting the session holds input
    /// for it. `None`: the caller gave no such guard (`unguarded`). A daemon thread is its own
    /// host, and its queued input is the `queued` check, so there is a guard and it is idle.
    fn hosted_busy(&self, _session_id: &str) -> Option<bool> {
        Some(false)
    }
}

/// `readSessionSidebarState()`'s flags for one session. The desktop's archived and favorite
/// marks are the session's own header fields here (`archivedAt`, `favoriteAt`: SPEC
/// `desktop-session-metadata.json` row, `thread/metadata/update`), set when positive as the
/// catalog reads `archivedAt`.
pub(crate) fn sidebar_flag(header: &mixdog_store::schema::record::Header, key: &str) -> bool {
    header.get(key).map_or(0.0, mixdog_js::to_number) > 0.0
}

/// The reason the idle delete closes with.
pub const AUTO_DELETE_REASON: &str = "desktop-auto-delete";

/// Whether the thread's turn holds what Node's ask lock is held for (`tryAcquireSessionLock`
/// refuses): a turn runs, starts or settles, other than a completion wake (Node wakes only its
/// current session, so no ask lock is held for one; `idle_refusal` still refuses it as `busy`).
fn ask_lock_held(directory: &super::directory::DirInner, thread: &ThreadId) -> bool {
    directory.loaded_handle(thread).is_some_and(|handle| handle.cell.turn_held.load(SeqCst))
}

/// What `idleRefusal` reads of the thread before its record: the live state of the session.
#[derive(Clone, Copy, Debug, Default)]
pub(crate) struct Live {
    /// The session is the one the runtime has current.
    pub current: bool,
    /// A turn is about to start (a turn waiting for the ask lock).
    pub turn_pending: bool,
    /// A turn runs, or one other than a completion wake starts or is not settled (a wake's start and settlement are refused by
    /// the close, on the actor).
    pub turn_running: bool,
    /// Input waits in the session's own queue.
    pub queued: bool,
    /// A runtime hosting the session holds input for it.
    pub hosted_busy: bool,
}

/// `idleRefusal`'s live checks, in Node's order.
pub(crate) fn live_refusal(live: &Live) -> Option<&'static str> {
    if live.current {
        Some("current")
    } else if live.turn_pending {
        Some("turn-waiting")
    } else if live.turn_running {
        Some("busy")
    } else if live.queued || live.hosted_busy {
        Some("queued")
    } else {
        None
    }
}

/// `idleRefusal` before the close, in Node's order: the session the runtime has current
/// (`current`), a turn about to start (`turn-waiting`), a running or settling turn or queued
/// input (`busy`, `queued`; the close asks the thread again), a session the catalog does not
/// list (`missing`), or one whose `lastUsedAt` moved since the caller looked (`changed`). Once
/// closed, nothing can move the thread, so the checks before the mark are the close's.
async fn idle_refusal(
    directory: &super::directory::DirInner,
    thread: &ThreadId,
    expected: &serde_json::Value,
) -> Result<Result<super::seams::SessionMeta, &'static str>, CoreError> {
    let deps = directory.deps();
    let handle = directory.loaded_handle(thread);
    let live = Live {
        current: deps.deletion.current_session().is_some_and(|current| current == thread.as_str()),
        turn_pending: handle.as_ref().is_some_and(|handle| handle.cell.turn_pending.load(SeqCst)),
        turn_running: handle.as_ref().is_some_and(|handle| handle.cell.run.load().is_some() || handle.cell.turn_held.load(SeqCst)),
        queued: handle.as_ref().is_some_and(|handle| !handle.cell.queued.load().is_empty()),
        hosted_busy: deps.deletion.hosted_busy(thread.as_str()) == Some(true),
    };
    if let Some(refusal) = live_refusal(&live) {
        return Ok(Err(refusal));
    }
    let Some(meta) = directory.deps().store.session_meta(thread).await? else {
        return Ok(Err("missing"));
    };
    if meta.last_used_at != super::seams::last_used(expected.get("lastUsedAt")) {
        return Ok(Err("changed"));
    }
    Ok(Ok(meta))
}

/// One idle delete a test holds: its session, the `arrived` sender and the `go` receiver.
#[cfg(any(test, feature = "test-support"))]
type JudgedHold = (String, tokio::sync::oneshot::Sender<()>, tokio::sync::oneshot::Receiver<()>);

/// The idle deletes a test holds right after their archive judgment, by session: `arrived` is told, then `go` is awaited.
#[cfg(any(test, feature = "test-support"))]
pub(crate) static JUDGED_HOLDS: std::sync::Mutex<Vec<JudgedHold>> = std::sync::Mutex::new(Vec::new());

#[cfg(any(test, feature = "test-support"))]
async fn judged_hold(id: &str) {
    let held = {
        let mut holds = JUDGED_HOLDS.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        holds.iter().position(|(at, _, _)| at == id).map(|at| holds.remove(at))
    };
    if let Some((_, arrived, go)) = held {
        let _ = arrived.send(());
        let _ = go.await;
    }
}

/// `deleteSessionIfIdle(id, expected)`: the desktop's auto-delete of an archived session that
/// is still archived, not a favorite, idle and unchanged since the caller looked
/// (`expected.lastUsedAt`). Resolves `{deleted: true}` or `{deleted: false, reason}`; a refusal
/// deletes nothing.
pub(crate) async fn delete_session_if_idle(
    directory: &super::directory::DirInner,
    id: &str,
    expected: &serde_json::Value,
    cancel: &mixdog_rt::CancellationToken,
) -> Result<serde_json::Value, CoreError> {
    let refuse = |reason: &str| Ok(serde_json::json!({ "deleted": false, "reason": reason }));
    let id = mixdog_js::js_trim(id);
    // The service (`deleteIdleSession`): no target is `invalid`, and the turn gate closes the
    // thread to turn starts for the whole delete unless one is being admitted (or another idle
    // delete holds it): `turn-starting`.
    if id.is_empty() {
        return refuse("invalid");
    }
    let thread = ThreadId::from(id);
    let Some(_closed_to_starts) = directory.gate().fence(&thread) else {
        return refuse("turn-starting");
    };
    // The runtime (`deleteSessionIfIdle`).
    if !is_session_id(id) {
        return refuse("invalid");
    }
    let deps = directory.deps().clone();
    if deps.deletion.hosted_busy(id).is_none() {
        return refuse("unguarded");
    }
    if deps.deletion.current_session().is_some_and(|current| current == id) {
        return refuse("current");
    }
    // The ask lock a turn holds is taken before the archive and favorite flags are read.
    if ask_lock_held(directory, &thread) {
        return refuse("busy");
    }
    // A session that is not there has no archive mark.
    let Some(handle) = directory.delete_target(&thread).await? else {
        return refuse("not-archived");
    };
    let header = handle.cell.header.load_full();
    let archive = deps.archive.resolve(id, header.get("archivedAt"));
    if !archive.archived() {
        return refuse("not-archived");
    }
    // A header's stamp after the archive entries were lost may be a restore the user made: never deleted on it.
    if !archive.trusted() {
        return refuse("archive-state-lost");
    }
    if sidebar_flag(&header, "favoriteAt") {
        return refuse("favorite");
    }
    #[cfg(any(test, feature = "test-support"))]
    judged_hold(id).await;
    let meta = match idle_refusal(directory, &thread, expected).await? {
        Ok(meta) => meta,
        Err(reason) => return refuse(reason),
    };
    // Admitted against the entry judged above, held to the end of the delete: a restore committed since refuses it, and one
    // after it fails whole.
    let Some(_claim) = deps.archive.claim_delete(id, archive.entry) else {
        return refuse("changed");
    };
    let abort = mixdog_agent::cancel::Abort::close_session(id, AUTO_DELETE_REASON);
    // The session auto-retention's delete states what it judged (`ifIdle.activity`, beside `lastUsedAt`): the thread's own
    // admission asks again, atomically with a subscriber attaching, that nobody is or ever was attached, no turn runs or is queued,
    // no approval shows and the activity is the one judged, and that `cancel` (shutdown, or the options changed) has not fired.
    let guard = expected.get("activity").and_then(serde_json::Value::as_f64).map(|activity| super::control::DeleteGuard {
        activity,
        cancel: cancel.clone(),
        peers: Vec::new(),
        opens: 0,
    });
    // A close that could not be carried out (the thread is closing) landed nothing: `close-failed`.
    let hold = match directory.close_for_delete(&thread, &abort, true, guard).await {
        Ok(Ok(hold)) => hold,
        Ok(Err(refusal)) => return refuse(refusal),
        Err(CoreError::ThreadClosing { .. }) => return refuse("close-failed"),
        Err(error) => return Err(error),
    };
    let closed = Closed { reason: AUTO_DELETE_REASON, header: hold.header(), at_ms: deps.clock.now_ms() };
    if !remove(directory, &thread, meta.cwds, hold, closed).await {
        return refuse("delete-failed");
    }
    deps.deletion.release_session_work(id, AUTO_DELETE_REASON).await;
    directory.forget_deleted(&thread);
    after_delete(&deps, id);
    Ok(serde_json::json!({ "deleted": true }))
}

/// What the close metric reads, as the close left it (`markSessionClosed`'s `existing` and
/// `closeTime`). It is logged once the delete mark is acknowledged, never before: a mark that
/// failed closed nothing.
struct Closed {
    reason: &'static str,
    header: Arc<mixdog_store::schema::record::Header>,
    at_ms: i64,
}

/// `mgr.deleteSession`: the delete mark, the close metric once it is acknowledged, the store's
/// purge of what no live lineage reads, then `_deleteSession`'s purge hooks and the app list's
/// `thread/deleted`. False when the mark was not applied (the close failed: the thread stays open with what it holds).
async fn remove(directory: &super::directory::DirInner, thread: &ThreadId, mut cwds: Vec<String>, hold: super::directory::DeleteHold, closed: Closed) -> bool {
    let deps = directory.deps().clone();
    if let Some(cwd) = hold.cwd().filter(|cwd| !cwd.is_empty() && !cwds.contains(cwd)) {
        cwds.push(cwd);
    }
    if !hold.mark(directory).await {
        return false;
    }
    removed(&deps, thread, &cwds, closed, true).await;
    true
}

/// What a delete does once the session is no longer listed, whichever delete it is. `stored`: the session has a stored
/// record, whose files the store purges; one never stored (a session of an earlier version the migration removed without
/// converting it) has none, and the migration removes its sources ([`PurgeHooks::unconverted_hooks`]).
async fn removed(deps: &super::SessionDeps, thread: &ThreadId, cwds: &[String], closed: Closed, stored: bool) {
    deps.deletion.tombstoned(thread);
    deps.deletion.session_closed(thread.as_str(), closed.reason, &closed.header, closed.at_ms);
    deps.deletion.release_mcp_scope(thread.as_str());
    deps.session_grants.forget(thread.as_str());
    deps.deletion.session_ended(thread.as_str());
    deps.deletion.session_deleted(thread.as_str());
    if stored {
        // A failed purge leaves the marked session's files for the next delete's purge or the
        // boot purge; the session is deleted either way.
        drop(deps.store.purge_deleted().await);
    }
    deps.purge.run_as(deps.turn_review.as_ref(), thread.as_str(), cwds, stored).await;
    // The deleted session's transcript-cache book is no longer open; its waiters wake and find it gone.
    deps.cache_tail.release(thread.as_str());
    deps.deletion.thread_deleted(thread);
}

/// The sub-agent retention's delete ([`delete_session`]) of a session of an earlier version that was never stored,
/// `header` being the record it was judged by: every step of that delete from the release of the session's work on, in
/// its order. The steps before it act on the stored record and the open thread, and there is neither: the session is
/// listed nowhere and nothing can open it.
pub(crate) async fn delete_unconverted(directory: &super::directory::DirInner, id: &str, header: &mixdog_store::schema::record::Header) {
    let thread = ThreadId::from(id);
    let deps = directory.deps().clone();
    let cwds = row_cwds(&serde_json::Value::Object(header.clone()));
    let closed = Closed { reason: DELETE_REASON, header: Arc::new(header.clone()), at_ms: deps.clock.now_ms() };
    deps.deletion.release_session_work(id, DELETE_REASON).await;
    removed(&deps, &thread, &cwds, closed, false).await;
    directory.forget_deleted(&thread);
    after_delete(&deps, id);
}

/// `void forgetSessionSearch(id); void releaseDeletedWorktree(id)`, then
/// `supersedeQuotaResume(id)`: the deleted session's resume and Goal note go (its actor, and
/// with it its settlement, is gone).
fn after_delete(deps: &super::SessionDeps, id: &str) {
    // `invalidatePreSessionToolSurface()` after the session is gone (`session-delete.mjs`).
    deps.surface.bump();
    deps.deletion.forget_session_search(id);
    let deletion = deps.deletion.clone();
    let owned = id.to_owned();
    drop(mixdog_rt::spawn("session-delete-worktree", mixdog_rt::TaskClass::Work, async move {
        deletion.release_deleted_worktree(&owned).await;
    }));
    let quota = deps.quota.goals.clone();
    let owned = id.to_owned();
    drop(mixdog_rt::spawn("session-delete-quota", mixdog_rt::TaskClass::Work, async move {
        let _ = quota.cancel(&owned).await;
    }));
}

/// `knownSessionCwds`' list-row part: `cwd`, `workspace.cwd`, `workspace.projectPath`, each a
/// non-empty string, once.
pub(crate) fn row_cwds(row: &serde_json::Value) -> Vec<String> {
    let mut cwds: Vec<String> = Vec::new();
    for value in [row.get("cwd"), row.pointer("/workspace/cwd"), row.pointer("/workspace/projectPath")] {
        if let Some(cwd) = value.and_then(serde_json::Value::as_str).filter(|cwd| !cwd.is_empty())
            && !cwds.iter().any(|seen| seen == cwd)
        {
            cwds.push(cwd.to_owned());
        }
    }
    let recorded = row.get(super::transcript_writer::TRANSCRIPT_CWDS).and_then(serde_json::Value::as_array);
    for cwd in recorded.into_iter().flatten().filter_map(serde_json::Value::as_str).filter(|cwd| !cwd.is_empty()) {
        if !cwds.iter().any(|seen| seen == cwd) {
            cwds.push(cwd.to_owned());
        }
    }
    cwds
}

/// `SESSION_ID_PATTERN`: `/^[A-Za-z0-9_-]+$/`.
pub fn is_session_id(id: &str) -> bool {
    !id.is_empty() && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

/// `thread/delete {threadId, ifIdle?}`: `deleteSession` (`true` once the session is gone,
/// `false` when nothing was deleted), or with `ifIdle` the desktop's `deleteSessionIfIdle`
/// (`{deleted, reason?}`). Served by the thread's handle and, for a thread that cannot be opened
/// (none, or deleted), by the directory: Node answers `false` there too.
pub(crate) async fn serve(
    directory: &super::directory::DirInner,
    params: &serde_json::Value,
    cancel: &mixdog_rt::CancellationToken,
) -> Result<mixdog_core_api::Reply, CoreError> {
    let params: mixdog_app_protocol::v2::thread::ThreadDeleteParams =
        serde_json::from_value(params.clone()).map_err(|_| CoreError::InvalidParams { path: "params".into(), expected: "ThreadDeleteParams".into() })?;
    let id = params.thread_id.as_str();
    Ok(mixdog_core_api::Reply::Value(match &params.if_idle {
        Some(expected) => delete_session_if_idle(directory, id, expected, cancel).await?,
        None => serde_json::Value::Bool(client_delete(directory, id).await?),
    }))
}

/// `isHistoricalAutomaticClosure(session)` (`historical-session-closure.mjs`): a named session an automatic close
/// (`idle-sweep`, `terminal-reap`) tombstoned.
pub fn is_historical_automatic_closure(header: &serde_json::Map<String, serde_json::Value>) -> bool {
    let text = |key: &str| header.get(key).and_then(serde_json::Value::as_str);
    text("owner").is_some_and(|owner| !owner.is_empty())
        && (header.get("closed") == Some(&serde_json::Value::Bool(true)) || text("status") == Some("closed"))
        && matches!(text("closedReason"), Some("idle-sweep" | "terminal-reap"))
}

async fn client_delete(directory: &super::directory::DirInner, id: &str) -> Result<bool, CoreError> {
    let trimmed = mixdog_js::js_trim(id);
    if !is_session_id(trimmed) {
        return Ok(false);
    }
    let thread = ThreadId::from(trimmed);
    let Some(header) = directory.stored_header(&thread).await else {
        return Ok(false);
    };
    // A deleted bot's archived chat deleted again: the bot goes for good too (`deleteSessionLocked`).
    if let Some(agent) = mixdog_core_base::rooms::ids::agent_id_of_home_session(trimmed)
        && header.get("retiredAt").and_then(serde_json::Value::as_f64).is_some_and(|at| at > 0.0)
    {
        directory.deps().deletion.purge_retired_agent(&agent).await.map_err(|message| mixdog_core_base::support::failed("agents", message))?;
    }
    if header.get("closed") == Some(&serde_json::Value::Bool(true)) && !is_historical_automatic_closure(&header) {
        return Ok(false);
    }
    let Some(outer) = directory.outer() else {
        return Ok(false);
    };
    let threads = super::thread_state::SessionThreads::new(Arc::new(outer));
    match super::close::write_detach(&threads, &thread, DELETE_REASON, false, directory.deps().clock.now_ms(), None).await {
        Ok(super::close::Detached::Stamped) => {}
        Ok(_) | Err(_) => return Ok(false),
    }
    delete_session(directory, trimmed, None).await
}

/// `deleteSession(id)`: false when nothing was deleted. A guarded (automatic) delete carries the archive entry it judged, and is
/// admitted against it before anything closes, held to its end.
pub(crate) async fn delete_session(
    directory: &super::directory::DirInner,
    id: &str,
    guarded: Option<(super::control::DeleteGuard, Option<mixdog_store::archive_state::ArchiveEntry>)>,
) -> Result<bool, CoreError> {
    let id = mixdog_js::js_trim(id);
    if !is_session_id(id) {
        return Ok(false);
    }
    let thread = ThreadId::from(id);
    let deps = directory.deps().clone();
    // `isAvailableSession`: the catalog lists it (a deleted session is not listed).
    let Some(meta) = deps.store.session_meta(&thread).await? else {
        return Ok(false);
    };
    // `mgr.closeSession(id, reason)`: the running turn stops before anything else goes.
    let (guard, _claim) = match guarded {
        Some((guard, judged)) => match deps.archive.claim_delete(id, judged) {
            Some(claim) => (Some(guard), Some(claim)),
            None => return Ok(false),
        },
        None => (None, None),
    };
    let abort = mixdog_agent::cancel::Abort::close_session(id, DELETE_REASON);
    let Ok(hold) = directory.close_for_delete(&thread, &abort, false, guard).await? else {
        return Ok(false);
    };
    let closed = Closed { reason: DELETE_REASON, header: hold.header(), at_ms: deps.clock.now_ms() };
    deps.deletion.release_session_work(id, DELETE_REASON).await;
    if !remove(directory, &thread, meta.cwds, hold, closed).await {
        return Ok(false);
    }
    // The session is gone: nothing of it can run again, so its Stop latches go with it.
    directory.forget_deleted(&thread);
    after_delete(&deps, id);
    Ok(true)
}
