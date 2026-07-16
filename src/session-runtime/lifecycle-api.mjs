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
  const {
    getSession, setSession, getRoute, setRoute, getConfig, getMode, getCurrentCwd,
    setCloseRequested, getMemoryModPromise, setMemoryModPromise,
    setSessionNeedsCwdRefresh,
    hooks, hookCommonPayload, mgr, statusRoutes, channels, agentTool, mcpClient,
    warmupTimers, prewarmTimers,
    flushConfigSave, flushBackendSave, flushOutputStyleSave,
    withTeardownDeadline, closePatchRuntimeIfLoaded,
    createCurrentSession, refreshRouteEffort,
    invalidateContextStatusCache, invalidatePreSessionToolSurface,
    applyResolvedCwd, resolveRoute, applyDeferredToolSurface, standaloneTools,
    pushTranscriptRebind,
    notificationListeners, remoteStateListeners, desktopSession,
  } = deps;
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
      // Persist any change that is still sitting in the debounce window so a
      // toggle made right before exit is not lost. Synchronous + best-effort:
      // teardown must continue even if the final write fails.
      try { flushConfigSave(); } catch {}
      try { flushBackendSave(); } catch {}
      try { flushOutputStyleSave(); } catch {}
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
          || (!sourceType && !sourceName && !isAgentOwner(owner));
        if (!leadish) return null;
        let preview = cleanSessionPreview(s.preview || '');
        let messageCount = Math.max(0, Number(s.messageCount) || 0);
        if (!preview && Array.isArray(s.messages)) {
          const msgs = s.messages || [];
          const userPreviews = msgs
            .filter(m => m && m.role === 'user')
            .map(m => cleanSessionPreview(sessionMessageText(m.content)))
            .filter(text => !isSessionPreviewNoise(text));
          preview = userPreviews[userPreviews.length - 1] || userPreviews[0] || '';
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
      const resumeOptions = desktopSession && typeof desktopSession === 'object'
        ? { desktopSession }
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
      applyDeferredToolSurface(session, deferredSurfaceModeForLead(getMode()), standaloneTools, { provider: getRoute().provider });
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
