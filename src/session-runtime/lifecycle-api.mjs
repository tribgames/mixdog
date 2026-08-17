import { cancelBackgroundTasks } from '../runtime/shared/background-tasks.mjs';
import { hasUserConversationMessage } from '../runtime/agent/orchestrator/session/manager/prompt-utils.mjs';
import { isAgentOwner } from '../runtime/agent/orchestrator/agent-owner.mjs';
import { writeStatuslineRoute } from './statusline-route.mjs';
import {
  sessionMessageText,
  isSessionPreviewNoise,
  cleanSessionPreview,
  clean,
  hasOwn,
} from './session-text.mjs';
import { toolSpecForMode, deferredSurfaceModeForLead } from './effort.mjs';
import { unregisterLiveSession } from '../runtime/shared/staged-update.mjs';
import {
  getStoreDir,
  listSessionHeartbeatMtimes,
} from '../runtime/agent/orchestrator/session/store/paths-heartbeat.mjs';
import { SessionClosedError } from '../runtime/agent/orchestrator/session/manager/session-errors.mjs';

function resolveResumeCwd(session, currentCwd) {
  const desktop = session?.desktopSession;
  if (desktop?.classification === 'project') {
    return clean(desktop.projectPath) || session?.cwd || currentCwd;
  }
  if (desktop?.classification === 'task') {
    // Desktop task sessions deliberately stay in the app-managed unclassified
    // workspace selected by the host, even if an old transcript recorded a
    // transient cwd. CLI/TUI sessions have no metadata and retain old behavior.
    return currentCwd;
  }
  return session?.cwd || currentCwd;
}

// Session lifecycle surface: teardown (close/abort), resume/new, and the
// resumable-session listing. Extracted verbatim from the runtime API object;
// stateless helpers are imported directly and the runtime injects live
// getters/setters for the mutable session/route/cwd locals plus the closure
// callbacks and long-lived handles (managers, timers, channel/agent/mcp).
export function createLifecycleApi(deps) {
  const cancelBackgroundTasksForLifecycle = deps.cancelBackgroundTasks || cancelBackgroundTasks;
  const {
    getSession, setSession, getRoute, setRoute, getConfig, getMode, getCurrentCwd,
    getMcpScopeId,
    getDesktopSession, setDesktopSession,
    setCloseRequested, getMemoryModPromise, setMemoryModPromise,
    setSessionNeedsCwdRefresh,
    hooks, hookCommonPayload, mgr, statusRoutes, channels, agentTool, mcpClient,
    warmupTimers, prewarmTimers,
    flushAllConfigSavesAsync,
    withTeardownDeadline, closePatchRuntimeIfLoaded, stopSelfUpdateBootCheck,
    createCurrentSession, refreshRouteEffort,
    invalidateContextStatusCache, invalidatePreSessionToolSurface,
    applyResolvedCwd, resolveRoute, applyDeferredToolSurface, getStandaloneTools,
    beginRoutePreparation, clearRoutePreparation,
    pushTranscriptRebind, scheduleRemoteIntentRestore,
    notificationListeners, clearRuntimeNotifications, remoteStateListeners,
    disposeSessionTitles, abortActiveTurns, getReservedSessionId,
  } = deps;
  const closeSurfaceSession = (session, reason, options) => {
    if (!session?.id) return false;
    // A remote-attached session is only a viewer handle owned by this surface.
    // Closing it through the shared manager bumps the durable generation and
    // invalidates the real owner's in-flight turn. Viewer exits therefore
    // detach locally; only the process that owns the runtime may close it.
    if (session.remoteAttached === true) return true;
    return mgr.closeSession(session.id, reason, options);
  };
  const listLeadSessions = (options = {}) => {
    const heartbeatMtimes = listSessionHeartbeatMtimes();
    return mgr.listSessions({
      refreshFromStorage: options?.refreshFromStorage === true,
    }).map(s => {
    const owner = clean(s.owner || 'user').toLowerCase();
    if (owner && !['cli', 'user', 'mixdog', 'legacy'].includes(owner)) return null;
    const sourceType = clean(s.sourceType || '').toLowerCase();
    const sourceName = clean(s.sourceName || '').toLowerCase();
    const agent = clean(s.agent || '').toLowerCase();
    const leadish = agent === 'lead'
      || sourceType === 'lead'
      || (sourceType === 'cli')
      // Schedule runs are their own visible type: they surface in desktop
      // Recent / TUI resume next to lead sessions instead of hiding like
      // agent dispatches.
      || sourceType === 'schedule'
      // Webhook fires run as visible sessions too (user decision: no Lead
      // injection — the session row IS the notification).
      || sourceType === 'webhook'
      || (!sourceType && !sourceName && !isAgentOwner(owner));
    if (!leadish) return null;
    const rawPreview = s.preview || '';
    let preview = isSessionPreviewNoise(rawPreview) ? '' : cleanSessionPreview(rawPreview);
    let messageCount = Math.max(0, Number(s.messageCount) || 0);
    if (!preview && Array.isArray(s.messages)) {
      const msgs = s.messages || [];
      const userPreviews = msgs
        .filter(m => m && m.role === 'user')
        .map(m => sessionMessageText(m.content))
        .filter(text => !isSessionPreviewNoise(text))
        .map(text => cleanSessionPreview(text))
        .filter(Boolean);
      preview = userPreviews[0] || '';
      messageCount = msgs.filter(m => m && (m.role === 'user' || m.role === 'assistant')).length;
    }
    if (!preview && messageCount === 0) return null;
    return {
      id: s.id,
      updatedAt: s.updatedAt,
      // Conversation-activity timestamp for Recent ordering. Without this the
      // desktop falls back to updatedAt, which detach/resume bookkeeping
      // bumps — clicking a session reshuffled the sidebar (the row just left
      // jumped to the top).
      lastUsedAt: Number(s.lastUsedAt) || 0,
      cwd: s.cwd || '',
      model: s.model,
      provider: s.provider,
      messageCount,
      title: cleanSessionPreview(s.title || '', 100),
      preview,
      // Working indicator: the .hb sidecar ALONE is the liveness signal. Its
      // deletion at turn end IS the completion signal, so the persisted
      // lastHeartbeatAt JSON field (refreshed by the final save) must not be
      // folded in — it pinned desktop spinners on for the full 2-minute TTL
      // after a turn had already finished.
      heartbeatAt: Number(heartbeatMtimes.get(s.id)) || 0,
      desktopSession: s.desktopSession || null,
      // Automation origin: lets the desktop group schedule/webhook runner
      // sessions under the sidebar Automations section instead of Recent.
      sourceType: sourceType || null,
      sourceName: clean(s.sourceName || '') || null,
    };
    }).filter(Boolean);
  };
  // Persist a closing session's conversation into the memory DB. Sessions
  // that never compacted had NO session-sourced rows (ingest_session
  // previously ran only inside compaction), so recall could not reconstruct
  // the most recent conversations. Best-effort and deadline-capped: the row
  // inserts are fast and committed even if the bounded wait elapses during
  // the trailing embedding flush (the raw-embedding backlog sweep embeds
  // them later). Never loads the memory runtime just for this — a null
  // module promise means memory was never used this run, so skip.
  async function ingestSessionIntoMemory(session) {
    try {
      const messages = Array.isArray(session?.messages) ? session.messages : [];
      if (!session?.id || messages.length === 0) return;
      const modPromise = getMemoryModPromise();
      if (!modPromise) return;
      await withTeardownDeadline(
        Promise.resolve(modPromise)
          .then((mod) => (typeof mod?.handleToolCall === 'function'
            ? mod.handleToolCall('memory', {
              action: 'ingest_session',
              sessionId: session.id,
              cwd: session.cwd || getCurrentCwd(),
              messages,
            })
            : null))
          .catch(() => {}),
        2500,
        undefined,
      );
    } catch { /* best-effort: memory ingest must never break lifecycle paths */ }
  }
  return {
    async close(reason = 'cli-exit', options = {}) {
      const detach = options?.detach === true || options?.wait === false || options?.waitForExit === false;
      // Desktop multi-engine hosts dispose idle engines while other sessions
      // keep working in the SAME process. The background-work registries
      // (shared background tasks, shell jobs, bash sessions) are
      // process-global, so a non-exit dispose must leave them running instead
      // of reaping every session's jobs. CLI exit paths never set this.
      const keepBackgroundWork = options?.keepBackgroundWork === true;
      setCloseRequested(true);
      const closingTurnId = getSession()?.id || getReservedSessionId?.() || 'pending';
      try {
        abortActiveTurns?.(new SessionClosedError(
          closingTurnId,
          `runtime close (reason=${reason})`,
          reason,
        ));
      } catch {}
      try { stopSelfUpdateBootCheck?.(); } catch {}
      try { disposeSessionTitles?.(); } catch {}
      // Self-update now stages in the background and swaps on the next clean
      // launch (see staged-update.mjs) — nothing installs at shutdown. On a
      // real process exit we just drop this session's live-refcount pid file so
      // a pending swap on the next launch is no longer blocked by us.
      const isProcessExit = /exit|quit|shutdown|sighup|sigint|sigterm/.test(String(reason || '').toLowerCase());
      const onProcessExit = () => {
        if (!isProcessExit) return;
        try { unregisterLiveSession(); } catch { /* advisory refcount only */ }
      };
      // Background work (shell jobs, background tasks) belongs to the SESSION
      // that started it, but its registries are process-global. A non-exit
      // dispose — a daemon session projection release or an idle
      // eviction — must therefore reap ONLY this session's jobs; the
      // process-wide sweep is reserved for a real process exit. Without this
      // scope, disposing one engine force-killed another session's running
      // build, and because that sweep cancels with notify:false the owner
      // never received a completion (user report: 백그라운드 잡이 조용히 멈춤,
      // 알림도 안 옴). An unattributable non-exit dispose reaps nothing.
      const closingSessionId = String(getSession()?.id || '');
      const scopedTeardown = !isProcessExit;
      const teardownReapsWork = !keepBackgroundWork
        && (!scopedTeardown || Boolean(closingSessionId));
      // SessionEnd: bridge teardown to the standard hook bus. reason mapped to
      // standard values ('clear'/'exit' where applicable, else 'other'). Short
      // await guard so a slow hook cannot wedge teardown; best-effort.
      try {
        const rl = String(reason || '').toLowerCase();
        const endReason = /clear/.test(rl) ? 'clear'
          : /exit|quit|cli-exit|shutdown|sigint|sigterm/.test(rl) ? 'exit'
          : 'other';
        const session = getSession();
        if (session?.id) {
          await withTeardownDeadline(
            Promise.resolve(hooks.dispatch('SessionEnd', hookCommonPayload({ session_id: session.id, reason: endReason }))).catch(() => {}),
            300,
            undefined,
          );
        }
      } catch { /* best-effort: SessionEnd hook must never wedge teardown */ }
      // Ingest the final conversation BEFORE the memory runtime stop below is
      // kicked off, so the write happens against a live module/daemon.
      try { await ingestSessionIntoMemory(getSession()); } catch { /* best-effort */ }
      // Teardown stays async end-to-end across every writer sharing the config
      // lock. Never start a synchronous lock wait while an in-process async
      // holder still needs the event loop to finish and release it.
      try { await flushAllConfigSavesAsync(); } catch {}
      try { hooks.flushRules?.(); } catch {}
      if (prewarmTimers.channelStartTimer) {
        clearTimeout(prewarmTimers.channelStartTimer);
        prewarmTimers.channelStartTimer = null;
      }
      for (const timerKey of [
        'providerSetupWarmupTimer',
        'providerWarmupTimer',
        'providerModelWarmupTimer',
        'modelCatalogWarmupTimer',
      ]) {
        if (warmupTimers[timerKey]) {
          clearTimeout(warmupTimers[timerKey]);
          warmupTimers[timerKey] = null;
        }
      }
      if (prewarmTimers.codeGraphPrewarmTimer) {
        clearTimeout(prewarmTimers.codeGraphPrewarmTimer);
        prewarmTimers.codeGraphPrewarmTimer = null;
      }
      if (prewarmTimers.searchRuntimeWarmupTimer) {
        clearTimeout(prewarmTimers.searchRuntimeWarmupTimer);
        prewarmTimers.searchRuntimeWarmupTimer = null;
      }
      for (const timerKey of ['statuslineUsageWarmupTimer', 'statuslineUsageRefreshTimer']) {
        if (warmupTimers[timerKey]) {
          clearTimeout(warmupTimers[timerKey]);
          warmupTimers[timerKey] = null;
        }
      }
      try {
        // A scoped cancel ALWAYS notifies: a task that dies for a reason its
        // owner never asked for must still be reported.
        if (teardownReapsWork) {
          cancelBackgroundTasksForLifecycle(scopedTeardown
            ? { reason, notify: true, callerSessionId: closingSessionId }
            : { reason, notify: false });
        }
      } catch {}
      const channelStop = channels.stop(reason, {
        ...(detach ? { waitForExit: false } : {}),
        // Runtime teardown/restart is not an explicit Remote OFF. Preserve the
        // session-pinned intent so the resumed session can reclaim it.
        preserveRemoteIntent: true,
      });
      try { agentTool.closeAll(reason); } catch {}
      let mcpStop = null;
      try { mcpStop = mcpClient.disconnectAll?.({ scopeId: getMcpScopeId?.() }); } catch {}
      const openaiWsStop = isProcessExit && globalThis.__mixdogOpenaiWsRuntimeLoaded === true
        ? import('../runtime/agent/orchestrator/providers/openai-oauth-ws.mjs')
          .then((mod) => mod?.drainOpenaiWsPool?.(reason))
          .catch(() => {})
        : null;
      const patchStop = closePatchRuntimeIfLoaded(detach ? { waitForExit: false } : undefined);
      const memoryModPromise = getMemoryModPromise();
      const memoryStop = memoryModPromise
        ? memoryModPromise
          .then((mod) => (typeof mod?.stop === 'function' ? mod.stop() : null))
          .catch(() => {})
          .finally(() => {
            setMemoryModPromise(null);
          })
        : null;
      let ok = false;
      const session = getSession();
      if (session?.id) {
        statusRoutes?.clearGatewaySessionRoute?.(session.id);
        // Bug fix: runtime stop/exit (TUI Ctrl-C, process exit) previously
        // always tombstoned the current session, so a session you were
        // mid-conversation in vanished from the Resume list the instant you
        // quit and was hard-deleted by the 24h tombstone sweep. Only
        // tombstone truly-empty scratch sessions; non-empty sessions must
        // survive exit resumable.
        // liveTurnMessages holds the in-flight user prompt until turn
        // commit — an active first-turn ask has its user message there,
        // not yet in session.messages, so it must also be checked or a
        // first-turn exit could still burn a real session.
        const tombstone = !hasUserConversationMessage(session.messages)
          && !hasUserConversationMessage(session.liveTurnMessages);
        ok = closeSurfaceSession(session, reason, { tombstone });
        setSession(null);
      }
      invalidateContextStatusCache();
      if (typeof clearRuntimeNotifications === 'function') clearRuntimeNotifications();
      else notificationListeners?.clear?.();
      remoteStateListeners?.clear?.();
      const shellJobsStop = teardownReapsWork && globalThis.__mixdogShellJobsRuntimeLoaded === true
        ? import('../runtime/agent/orchestrator/tools/builtin/shell-jobs.mjs')
          .then((mod) => mod?.shutdownShellJobs?.(reason, {
            ...(scopedTeardown ? { scope: { ownerSessionId: closingSessionId } } : {}),
          }))
          .catch(() => {})
        : null;
      if (detach) {
        try { await withTeardownDeadline(channelStop, 300, false); } catch {}
        try { await withTeardownDeadline(shellJobsStop, 300, false); } catch {}
        try { await withTeardownDeadline(memoryStop, 1500, false); } catch {}
        for (const stop of [mcpStop, openaiWsStop, patchStop]) {
          Promise.resolve(stop).catch(() => {});
        }
        onProcessExit();
        return ok;
      }
      await Promise.allSettled([
        withTeardownDeadline(channelStop, 5500, false),
        withTeardownDeadline(mcpStop, 1500, false),
        withTeardownDeadline(openaiWsStop, 1500, false),
        withTeardownDeadline(patchStop, 1500, false),
        withTeardownDeadline(memoryStop, 5500, false),
        withTeardownDeadline(shellJobsStop, 1500, false),
      ]);
      onProcessExit();
      return ok;
    },
    abort(reason = 'cli-abort') {
      const session = getSession();
      const sessionId = session?.id || getReservedSessionId?.() || 'pending';
      const abortError = new SessionClosedError(
        sessionId,
        `runtime abort (reason=${reason})`,
        reason,
      );
      let outerAborted = false;
      try { outerAborted = abortActiveTurns?.(abortError) === true; } catch {}
      const managerAborted = session?.id
        ? mgr.abortSessionTurn(session.id, reason)
        : false;
      return outerAborted || managerAborted;
    },
    listSessions(options = {}) {
      return listLeadSessions(options);
    },
    // Desktop watcher hook: absolute path of the on-disk session store so the
    // host can fs.watch it and push sidebar updates instead of polling.
    sessionStoreDir() {
      try { return getStoreDir(); } catch { return null; }
    },
    async deleteSession(id) {
      const sessionId = clean(id);
      if (!sessionId || !/^[A-Za-z0-9_-]+$/.test(sessionId)) return false;
      const available = listLeadSessions({ refreshFromStorage: true })
        .some(row => row.id === sessionId);
      if (!available) return false;
      let ownedAgentSessionIds = [];
      try {
        const candidates = mgr.listOwnedAgentSessionIds?.(sessionId);
        if (Array.isArray(candidates)) {
          ownedAgentSessionIds = [...new Set(candidates
            .map(clean)
            .filter(childId => childId && childId !== sessionId && /^[A-Za-z0-9_-]+$/.test(childId)))];
        }
      } catch { /* parent deletion remains available if child enumeration fails */ }
      const current = getSession();
      if (current?.id !== sessionId) {
        const deleted = mgr.deleteSession(sessionId) === true;
        if (!deleted) return false;
        // The parent is already irreversibly gone, so child cleanup is
        // best-effort and idempotent. Any vetoed child becomes sweep-eligible
        // because its retained-parent proof disappeared with the parent.
        for (const childId of ownedAgentSessionIds) {
          try { mgr.deleteSession(childId); } catch {}
        }
        return true;
      }

      const cleanupReason = 'desktop-session-delete';
      try {
        cancelBackgroundTasksForLifecycle({
          reason: cleanupReason,
          notify: false,
          callerSessionId: sessionId,
        });
      } catch {}
      try { agentTool?.closeAll?.(cleanupReason); } catch {}
      statusRoutes?.clearGatewaySessionRoute?.(sessionId);
      // Active sessions retain a tombstone until the normal sweep. Unlinking
      // immediately would let a late provider/save continuation resurrect the
      // deleted conversation after the user has moved to its replacement.
      if (mgr.closeSession(sessionId, cleanupReason, { tombstone: true }) !== true) return false;
      // Active parent deletion uses the same durable tombstone boundary for
      // every linked child. Their files then mature with the parent instead of
      // disappearing while the parent task is still retained.
      for (const childId of ownedAgentSessionIds) {
        try { mgr.closeSession(childId, cleanupReason, { tombstone: true }); } catch {}
      }
      setSession(null);
      invalidateContextStatusCache();
      invalidatePreSessionToolSurface();
      await createCurrentSession();
      pushTranscriptRebind?.();
      return true;
    },
    async switchContext({ cwd, desktopSession: nextDesktopSession, forResume = false } = {}) {
      clearRoutePreparation?.();
      const session = getSession();
      if (session?.id) {
        const cleanupReason = 'desktop-context-switch';
        // Fire-and-forget: context switch is user-facing latency; the memory
        // runtime outlives the closed session so the write completes safely.
        void ingestSessionIntoMemory(session);
        try {
          cancelBackgroundTasksForLifecycle({
            reason: cleanupReason,
            notify: false,
            callerSessionId: session.id,
          });
        } catch {}
        try { agentTool?.closeAll?.(cleanupReason); } catch {}
        statusRoutes?.clearGatewaySessionRoute?.(session.id);
        const tombstone = !hasUserConversationMessage(session.messages)
          && !hasUserConversationMessage(session.liveTurnMessages);
        closeSurfaceSession(session, cleanupReason, { tombstone });
        setSession(null);
      }
      setDesktopSession(nextDesktopSession && typeof nextDesktopSession === 'object'
        ? nextDesktopSession
        : null);
      // Do NOT block the switch on the project MCP reconnect (observed 5s+ per
      // project entry on desktop). The reset still STARTS here synchronously
      // (generation bump + in-flight registration inside applyResolvedCwd), so
      // stale servers cannot be re-adopted, and the ask path gates boundedly on
      // the in-flight connect before the next turn's tool surface is built.
      await applyResolvedCwd(cwd, { markRefresh: false });
      // Resuming a historical session temporarily routes the runtime through
      // that session's provider/model. A fresh desktop task or project must
      // return to the configured Lead route instead of inheriting the route
      // of whichever session happened to be open immediately beforehand.
      if (!forResume && typeof setRoute === 'function' && typeof getConfig === 'function'
        && typeof resolveRoute === 'function') {
        setRoute(resolveRoute(getConfig(), {}));
        await refreshRouteEffort?.();
      }
      invalidateContextStatusCache();
      invalidatePreSessionToolSurface();
      return true;
    },
    async newSession() {
      const session = getSession();
      if (session?.id) {
        void ingestSessionIntoMemory(session);
        const tombstone = !hasUserConversationMessage(session.messages)
          && !hasUserConversationMessage(session.liveTurnMessages);
        closeSurfaceSession(session, 'cli-new', { tombstone });
        setSession(null);
      }
      invalidateContextStatusCache();
      await createCurrentSession();
      // New session.id => the worker's binding (and persisted status) now point
      // at the previous session's transcript. Push the current transcript so
      // outbound forwarding repoints immediately (best-effort, remote-gated).
      pushTranscriptRebind?.();
      return getSession().id;
    },
    prefetchSession(id) {
      return mgr.prefetchSession?.(id, toolSpecForMode(getMode())) === true;
    },
    async resume(id) {
      clearRoutePreparation?.();
      const prev = getSession();
      const previousId = prev?.id || null;
      const previousMessages = prev?.messages || null;
      const previousLive = prev?.liveTurnMessages || null;
      // A context switch can deliberately clear the desktop marker for legacy
      // sessions, so always read the live mutable context binding.
      const activeDesktopSession = getDesktopSession();
      const resumeOptions = {
        ...(activeDesktopSession && typeof activeDesktopSession === 'object'
          ? { desktopSession: activeDesktopSession }
          : {}),
        mcpScopeId: getMcpScopeId?.() || null,
      };
      const resumed = await mgr.resumeSession(id, toolSpecForMode(getMode()), resumeOptions);
      if (!resumed) return null;
      if (previousId && previousId !== resumed.id) {
        statusRoutes?.clearGatewaySessionRoute?.(previousId);
        void ingestSessionIntoMemory(prev);
        const tombstone = !hasUserConversationMessage(previousMessages)
          && !hasUserConversationMessage(previousLive);
        closeSurfaceSession(prev, 'cli-resume', { tombstone });
      }
      setSession(resumed);
      try {
        agentTool?.upsertLeadSession?.(resumed, { status: 'idle', stage: 'idle' });
      } catch { /* lead pool must never break resume */ }
      applyResolvedCwd(resolveResumeCwd(resumed, getCurrentCwd()), { markRefresh: false });
      // Cwd application is synchronous even though MCP reconnect may continue
      // in the background. Commit it before returning the resume transcript.
      resumed.cwd = getCurrentCwd();
      const route = getRoute();
      // The resumed session's OWN effort wins. resolveRoute always returns an
      // effort key, so this used to reinstate the effort of whichever session
      // happened to be open before — a schedule/webhook session opened with a
      // different effort than the one it actually ran with.
      const resumeEffort = resumed.effort || (hasOwn(route, 'effort') ? route.effort : undefined);
      const resumedRoute = resolveRoute(
        getConfig(),
        {
          provider: resumed.provider,
          model: resumed.model,
          effort: resumeEffort,
          fast: resumed.fast === true,
          modelParameters: resumed.modelParameters || {},
        },
      );
      setRoute(resumedRoute);
      const finishRoutePreparation = async () => {
        const preparedRoute = await refreshRouteEffort(null, resumedRoute);
        // Session or route changed while provider metadata was loading.
        if (!preparedRoute || getSession() !== resumed || getRoute() !== preparedRoute) return false;
        const activeSession = getSession();
        activeSession.effort = getRoute().effectiveEffort || null;
        activeSession.fast = getRoute().fast === true;
        activeSession.cwd = getCurrentCwd();
        applyDeferredToolSurface(
          activeSession,
          deferredSurfaceModeForLead(getMode()),
          getStandaloneTools(),
          { provider: getRoute().provider },
        );
        writeStatuslineRoute(statusRoutes, activeSession, getRoute());
        return true;
      };
      if (typeof beginRoutePreparation === 'function') {
        beginRoutePreparation(finishRoutePreparation);
      } else {
        await finishRoutePreparation();
      }
      invalidatePreSessionToolSurface();
      invalidateContextStatusCache();
      setSessionNeedsCwdRefresh(false);
      // Session swapped to the resumed one: repoint the worker to the current
      // transcript instead of waiting for the next inbound steal.
      pushTranscriptRebind?.();
      // Daemon-boot restore resumes the pinned session AFTER the runtime's
      // one-shot boot probe may have fired with no session (it returns without
      // re-arming). Re-check now that the session identity is final; the probe
      // self-guards (intent match, one-shot, remote already on), so this is a
      // no-op for every non-pinned resume. Without it the runtime stays
      // non-remote after a restart: tool_use rows are never mirrored and the
      // channel shows text without tool markers (user report).
      scheduleRemoteIntentRestore?.(0);
      return {
        id: resumed.id,
        messages: resumed.messages || [],
        cwd: getCurrentCwd(),
        provider: resumed.provider,
        model: resumed.model,
      };
    },
  };
}
