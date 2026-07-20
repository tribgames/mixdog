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
import { getStoreDir } from '../runtime/agent/orchestrator/session/store/paths-heartbeat.mjs';

export function resolveResumeCwd(session, currentCwd) {
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
    getDesktopSession, setDesktopSession,
    setCloseRequested, getMemoryModPromise, setMemoryModPromise,
    setSessionNeedsCwdRefresh,
    hooks, hookCommonPayload, mgr, statusRoutes, channels, agentTool, mcpClient,
    warmupTimers, prewarmTimers,
    flushAllConfigSavesAsync,
    withTeardownDeadline, closePatchRuntimeIfLoaded,
    createCurrentSession, refreshRouteEffort,
    invalidateContextStatusCache, invalidatePreSessionToolSurface,
    applyResolvedCwd, resolveRoute, applyDeferredToolSurface, getStandaloneTools,
    pushTranscriptRebind,
    notificationListeners, remoteStateListeners, desktopSession,
  } = deps;
  const listLeadSessions = (options = {}) => mgr.listSessions({
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
      cwd: s.cwd || '',
      model: s.model,
      provider: s.provider,
      messageCount,
      preview,
      desktopSession: s.desktopSession || null,
    };
  }).filter(Boolean);
  return {
    async close(reason = 'cli-exit', options = {}) {
      const detach = options?.detach === true || options?.wait === false || options?.waitForExit === false;
      setCloseRequested(true);
      // Self-update now stages in the background and swaps on the next clean
      // launch (see staged-update.mjs) — nothing installs at shutdown. On a
      // real process exit we just drop this session's live-refcount pid file so
      // a pending swap on the next launch is no longer blocked by us.
      const isProcessExit = /exit|quit|shutdown|sighup|sigint|sigterm/.test(String(reason || '').toLowerCase());
      const onProcessExit = () => {
        if (!isProcessExit) return;
        try { unregisterLiveSession(); } catch { /* advisory refcount only */ }
      };
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
      for (const timerKey of ['statuslineUsageWarmupTimer', 'statuslineUsageRefreshTimer']) {
        if (warmupTimers[timerKey]) {
          clearTimeout(warmupTimers[timerKey]);
          warmupTimers[timerKey] = null;
        }
      }
      try { cancelBackgroundTasks({ reason, notify: false }); } catch {}
      const channelStop = channels.stop(reason, detach ? { waitForExit: false } : undefined);
      try { agentTool.closeAll(reason); } catch {}
      let mcpStop = null;
      try { mcpStop = mcpClient.disconnectAll?.(); } catch {}
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
        ok = mgr.closeSession(session.id, reason, { tombstone });
        setSession(null);
      }
      invalidateContextStatusCache();
      notificationListeners?.clear?.();
      remoteStateListeners?.clear?.();
      const shellJobsStop = globalThis.__mixdogShellJobsRuntimeLoaded === true
        ? import('../runtime/agent/orchestrator/tools/builtin/shell-jobs.mjs')
          .then((mod) => mod?.shutdownShellJobs?.(reason, { sync: !detach }))
          .catch(() => {})
        : null;
      const bashSessionsStop = globalThis.__mixdogBashSessionRuntimeLoaded === true
        ? import('../runtime/agent/orchestrator/tools/bash-session.mjs')
          .then((mod) => mod?.shutdownBashSessions?.(reason))
          .catch(() => {})
        : null;
      if (detach) {
        try { await withTeardownDeadline(channelStop, 300, false); } catch {}
        try { await withTeardownDeadline(shellJobsStop, 300, false); } catch {}
        try { await withTeardownDeadline(bashSessionsStop, 300, false); } catch {}
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
        withTeardownDeadline(bashSessionsStop, 1500, false),
      ]);
      onProcessExit();
      return ok;
    },
    abort(reason = 'cli-abort') {
      const session = getSession();
      if (!session?.id) return false;
      return mgr.abortSessionTurn(session.id, reason);
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
      const current = getSession();
      if (current?.id !== sessionId) return mgr.deleteSession(sessionId) === true;

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
      setSession(null);
      invalidateContextStatusCache();
      invalidatePreSessionToolSurface();
      await createCurrentSession();
      pushTranscriptRebind?.();
      return true;
    },
    async switchContext({ cwd, desktopSession: nextDesktopSession } = {}) {
      const session = getSession();
      if (session?.id) {
        const cleanupReason = 'desktop-context-switch';
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
        mgr.closeSession(session.id, cleanupReason, { tombstone });
        setSession(null);
      }
      setDesktopSession(nextDesktopSession && typeof nextDesktopSession === 'object'
        ? nextDesktopSession
        : null);
      await applyResolvedCwd(cwd, { markRefresh: false, waitForMcpReset: true });
      // Resuming a historical session temporarily routes the runtime through
      // that session's provider/model. A fresh desktop task or project must
      // return to the configured Lead route instead of inheriting the route
      // of whichever session happened to be open immediately beforehand.
      if (typeof setRoute === 'function' && typeof getConfig === 'function'
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
        const tombstone = !hasUserConversationMessage(session.messages)
          && !hasUserConversationMessage(session.liveTurnMessages);
        mgr.closeSession(session.id, 'cli-new', { tombstone });
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
    async resume(id) {
      const prev = getSession();
      const previousId = prev?.id || null;
      const previousMessages = prev?.messages || null;
      const previousLive = prev?.liveTurnMessages || null;
      // A context switch can deliberately clear the desktop marker for legacy
      // sessions. Fall back to the creation-time value only for callers that
      // do not supply mutable context bindings.
      const activeDesktopSession = typeof getDesktopSession === 'function'
        ? getDesktopSession()
        : desktopSession;
      const resumeOptions = activeDesktopSession && typeof activeDesktopSession === 'object'
        ? { desktopSession: activeDesktopSession }
        : undefined;
      const resumed = await mgr.resumeSession(id, toolSpecForMode(getMode()), resumeOptions);
      if (!resumed) return null;
      if (previousId && previousId !== resumed.id) {
        statusRoutes?.clearGatewaySessionRoute?.(previousId);
        const tombstone = !hasUserConversationMessage(previousMessages)
          && !hasUserConversationMessage(previousLive);
        mgr.closeSession(previousId, 'cli-resume', { tombstone });
      }
      setSession(resumed);
      applyResolvedCwd(resolveResumeCwd(resumed, getCurrentCwd()), { markRefresh: false });
      const route = getRoute();
      const resumeEffort = hasOwn(route, 'effort') ? route.effort : resumed.effort;
      setRoute(resolveRoute(getConfig(), { provider: resumed.provider, model: resumed.model, effort: resumeEffort }));
      await refreshRouteEffort();
      const session = getSession();
      session.effort = getRoute().effectiveEffort || null;
      session.cwd = getCurrentCwd();
      applyDeferredToolSurface(session, deferredSurfaceModeForLead(getMode()), getStandaloneTools(), { provider: getRoute().provider });
      invalidatePreSessionToolSurface();
      invalidateContextStatusCache();
      setSessionNeedsCwdRefresh(false);
      writeStatuslineRoute(statusRoutes, session, getRoute());
      // Session swapped to the resumed one: repoint the worker to the current
      // transcript instead of waiting for the next inbound steal.
      pushTranscriptRebind?.();
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
