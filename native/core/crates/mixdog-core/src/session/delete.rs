//! `thread/delete`: deleting one session as 1.4.5's `deleteSession` does
//! (`lifecycle/session-switch/session-delete.mjs:56`, the session that is not the runtime's
//! current one; a daemon thread never is), with the store's hard-delete purge
//! (`store/session-delete.mjs` `_deleteSession`).
//!
//! The store's delete is the delete mark, a `meta` record the thread's own writer appends: a
//! fork reads its parent's logs, so the files stay until the store's fork-aware purge, run
//! after each delete, finds no live lineage reading them. A deleted session is not listed, not
//! openable and never deleted twice.

use std::sync::Arc;

use async_trait::async_trait;
use mixdog_core_api::CoreError;
use mixdog_core_api::ids::ThreadId;

/// The reason `deleteSession` closes with.
pub const DELETE_REASON: &str = "desktop-session-delete";

/// One store purge hook (`registerSessionPurgeHook`): synchronous, best effort; `cwds` are the
/// working folders the session is known to have used (`knownSessionCwds`).
pub trait PurgeHook: Send + Sync {
    fn purge(&self, session_id: &str, cwds: &[String]);
}

/// The store purge hooks in the order a booted 1.4.5 daemon registers (and so runs) them
/// (`delete_goldens/purge_order.json`). The turn review's (`runtime-review-api.mjs:26`) is
/// `SessionDeps.turn_review`'s `forget_session`, run in its place between `connector_accounts`
/// and `worker_turns`.
pub struct PurgeHooks {
    /// `tool-result-offload.mjs:506` `clearOffloadSessionSync`.
    pub tool_result_offload: Arc<dyn PurgeHook>,
    /// `usage-metrics.mjs:21` `dropMetricSeenState`.
    pub usage_metrics: Arc<dyn PurgeHook>,
    /// `runtime-liveness.mjs:65` `forgetBrowserSession`.
    pub browser_session: Arc<dyn PurgeHook>,
    /// `session-transcript-purge.mjs:20`: the conversation transcripts under `cwds` and their
    /// memory ingest offsets.
    pub transcripts: Arc<dyn PurgeHook>,
    /// `cache-warm.mjs:424`.
    pub cache_warm: Arc<dyn PurgeHook>,
    /// `read-cache.mjs:317`.
    pub read_cache: Arc<dyn PurgeHook>,
    /// `compaction-archive-capture.mjs:738`.
    pub compaction_capture: Arc<dyn PurgeHook>,
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
}

impl PurgeHooks {
    /// `_runSessionPurgeHooks(id, { cwds })`, then the archive and scratch removal. A hook that
    /// panics never breaks the delete or the hooks after it (Node's per-hook `try`).
    pub(crate) fn run(&self, review: &dyn mixdog_core_api::turn_review::TurnReviewApi, id: &str, cwds: &[String]) {
        let guarded = |hook: &dyn Fn()| {
            let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(hook));
        };
        for hook in [
            &self.tool_result_offload,
            &self.usage_metrics,
            &self.browser_session,
            &self.transcripts,
            &self.cache_warm,
            &self.read_cache,
            &self.compaction_capture,
            &self.provider_connections,
            &self.connector_accounts,
        ] {
            guarded(&|| hook.purge(id, cwds));
        }
        guarded(&|| review.forget_session(id));
        for hook in [&self.worker_turns, &self.agent_status, &self.compaction_archive, &self.scratch_dir] {
            guarded(&|| hook.purge(id, cwds));
        }
    }
}

/// What `deleteSession` does outside the session and its store.
#[async_trait]
pub trait DeleteSeams: Send + Sync {
    /// `agentTool.forgetLeadSession(id)`.
    fn forget_lead_session(&self, session_id: &str);
    /// `releaseSessionWork(id, reason)`: `cancelBackgroundTasks({ reason, notify: false,
    /// executionSessionId: id })` (this session's own tasks, not the sessions it delegated to),
    /// then `statusRoutes.clearGatewaySessionRoute(id)`.
    fn release_session_work(&self, session_id: &str, reason: &str);
    /// `forgetSessionSearch(id)`, not awaited.
    fn forget_session_search(&self, session_id: &str);
    /// `releaseDeletedWorktree(id)`: the worktree maintenance's `cleanupDeletedSession`, off the
    /// delete; never fails it.
    async fn release_deleted_worktree(&self, session_id: &str);
    /// `thread/deleted` on the app feed.
    fn thread_deleted(&self, thread: &ThreadId);
    /// `readSessionSidebarState()`: the desktop's archived and favorite session ids; `None`
    /// when it cannot be read.
    async fn sidebar_state(&self) -> Option<SidebarState>;
}

/// The desktop sidebar's flags (`session-sidebar-host.mjs`).
#[derive(Clone, Debug, Default)]
pub struct SidebarState {
    pub archived: std::collections::HashSet<String>,
    pub favorites: std::collections::HashSet<String>,
}

/// The reason the idle delete closes with.
pub const AUTO_DELETE_REASON: &str = "desktop-auto-delete";

/// `idleRefusal` before the close: a running turn or queued input (`busy`, `queued`; the
/// close asks the thread again), a session the catalog does not list (`missing`), or one
/// whose `lastUsedAt` moved since the caller looked (`changed`). A daemon thread is never the
/// runtime's current one and has no ask lock apart from its turn, so `current` and
/// `turn-waiting` never apply; once closed, nothing can move it, so the checks before the
/// mark are the close's.
async fn idle_refusal(
    directory: &super::directory::DirInner,
    thread: &ThreadId,
    expected: &serde_json::Value,
) -> Result<Result<super::seams::SessionMeta, &'static str>, CoreError> {
    if let Some(handle) = directory.loaded_handle(thread) {
        if handle.cell.run.load().is_some() {
            return Ok(Err("busy"));
        }
        if !handle.cell.queued.load().is_empty() {
            return Ok(Err("queued"));
        }
    }
    let Some(meta) = directory.deps().store.session_meta(thread).await? else {
        return Ok(Err("missing"));
    };
    if meta.last_used_at != super::seams::last_used(expected.get("lastUsedAt")) {
        return Ok(Err("changed"));
    }
    Ok(Ok(meta))
}

/// `deleteSessionIfIdle(id, expected)`: the desktop's auto-delete of an archived session that
/// is still archived, not a favorite, idle and unchanged since the caller looked
/// (`expected.lastUsedAt`). Resolves `{deleted: true}` or `{deleted: false, reason}`; a refusal
/// deletes nothing.
pub(crate) async fn delete_session_if_idle(
    directory: &super::directory::DirInner,
    id: &str,
    expected: &serde_json::Value,
) -> Result<serde_json::Value, CoreError> {
    let refuse = |reason: &str| Ok(serde_json::json!({ "deleted": false, "reason": reason }));
    let id = mixdog_js::js_trim(id);
    if !is_session_id(id) {
        return refuse("invalid");
    }
    let thread = ThreadId::from(id);
    let deps = directory.deps().clone();
    let Some(sidebar) = deps.deletion.sidebar_state().await.filter(|s| s.archived.contains(id)) else {
        return refuse("not-archived");
    };
    if sidebar.favorites.contains(id) {
        return refuse("favorite");
    }
    let meta = match idle_refusal(directory, &thread, expected).await? {
        Ok(meta) => meta,
        Err(reason) => return refuse(reason),
    };
    let reason = mixdog_agent::cancel::close_session_reason(id, AUTO_DELETE_REASON);
    let hold = match directory.close_for_delete(&thread, &reason, true).await? {
        Ok(hold) => hold,
        Err(refusal) => return refuse(refusal),
    };
    if !remove(directory, &thread, meta.cwds, hold).await {
        return refuse("delete-failed");
    }
    deps.deletion.forget_lead_session(id);
    deps.deletion.release_session_work(id, AUTO_DELETE_REASON);
    after_delete(&deps, id);
    Ok(serde_json::json!({ "deleted": true }))
}

/// `mgr.deleteSession`: the delete mark, the store's purge of what no live lineage reads, then
/// `_deleteSession`'s purge hooks and the app list's `thread/deleted`. False when the mark
/// was not applied (the thread stays, unloaded).
async fn remove(
    directory: &super::directory::DirInner,
    thread: &ThreadId,
    mut cwds: Vec<String>,
    hold: super::directory::DeleteHold,
) -> bool {
    let deps = directory.deps().clone();
    if let Some(cwd) = hold.cwd().filter(|cwd| !cwd.is_empty() && !cwds.contains(cwd)) {
        cwds.push(cwd);
    }
    if !hold.mark(directory).await {
        return false;
    }
    // A failed purge leaves the marked session's files for the next delete's purge or the
    // boot purge; the session is deleted either way.
    drop(deps.store.purge_deleted().await);
    deps.purge.run(deps.turn_review.as_ref(), thread.as_str(), &cwds);
    deps.deletion.thread_deleted(thread);
    true
}

/// `void forgetSessionSearch(id); void releaseDeletedWorktree(id)`.
fn after_delete(deps: &super::SessionDeps, id: &str) {
    deps.deletion.forget_session_search(id);
    let deletion = deps.deletion.clone();
    let owned = id.to_owned();
    drop(mixdog_rt::spawn("session-delete-worktree", mixdog_rt::TaskClass::Work, async move {
        deletion.release_deleted_worktree(&owned).await;
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
    cwds
}

/// `SESSION_ID_PATTERN`: `/^[A-Za-z0-9_-]+$/`.
pub fn is_session_id(id: &str) -> bool {
    !id.is_empty() && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

/// `deleteSession(id)`: false when nothing was deleted.
pub(crate) async fn delete_session(directory: &super::directory::DirInner, id: &str) -> Result<bool, CoreError> {
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
    let reason = mixdog_agent::cancel::close_session_reason(id, DELETE_REASON);
    let Ok(hold) = directory.close_for_delete(&thread, &reason, false).await? else {
        return Ok(false);
    };
    deps.deletion.forget_lead_session(id);
    deps.deletion.release_session_work(id, DELETE_REASON);
    if !remove(directory, &thread, meta.cwds, hold).await {
        return Ok(false);
    }
    after_delete(&deps, id);
    Ok(true)
}
