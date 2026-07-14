import { clean } from './session-text.mjs';
import { envFlag } from './env.mjs';
import { normalizeToolMode } from './effort.mjs';
import {
  toolRow,
  toolSearchMatches,
  sortedNamesByMeasuredUsage,
  selectDeferredTools,
  reconcileDeferredMcpToolCatalog,
  refreshInitialDeferredMcpSurface,
} from './tool-catalog.mjs';
import { getMcpTools } from '../runtime/agent/orchestrator/mcp/client.mjs';

export function splitToolStatusCounts(rows) {
  const list = Array.isArray(rows) ? rows : [];
  const regular = list.filter((row) => row?.kind !== 'mcp' && row?.kind !== 'skill');
  const mcp = list.filter((row) => row?.kind === 'mcp');
  return {
    count: regular.length,
    activeCount: regular.filter((row) => row.active).length,
    mcpToolCount: mcp.length,
    activeMcpToolCount: mcp.filter((row) => row.active).length,
  };
}

// Turn execution (ask) + session-manage/tool-surface/agent surfaces. Extracted
// verbatim from the runtime API object; stateless helpers are imported directly
// and the runtime injects live getters/setters for the mutable session/mode/
// turn-counter/transcript-writer locals plus the closure callbacks.
export function createSessionTurnApi(deps) {
  const {
    getSession, setSession, getCurrentCwd, getMode, setMode,
    getActiveTurnCount, setActiveTurnCount, isFirstTurnCompleted, setFirstTurnCompleted,
    getCodeGraphFirstTurnPrewarmDone, setCodeGraphFirstTurnPrewarmDone, codeGraphPrewarmLazy,
    getRemoteEnabled, getCloseRequested,
    getPendingSessionReset, setPendingSessionReset,
    getTranscriptWriter, getTwKey, getLastAppendedAssistant, setLastAppendedAssistant,
    scheduleCodeGraphPrewarm, refreshSessionForCwdIfNeeded, createCurrentSession,
    ensureRemoteTranscriptWriter, channelsEnabled, invokeChannelStart, channels,
    pushTranscriptRebind, flushPendingTranscriptRebind,
    hooks, hookCommonPayload, mgr, notifyFnForSession, bootProfile,
    scheduleProviderWarmup, scheduleProviderModelWarmup, invalidateContextStatusCache,
    agentTool, recreateCurrentSessionIfReady, invalidatePreSessionToolSurface,
    activeToolSurface, applyResolvedCwd, resolveCwdPath, agentStatusState, notificationListeners,
    awaitInitialMcpConnect,
  } = deps;
  return {
    getTurnLiveness() {
      const sessionId = getSession()?.id;
      if (!sessionId || typeof mgr.getSessionProgressSnapshot !== 'function') return null;
      const snapshot = mgr.getSessionProgressSnapshot(sessionId);
      if (!snapshot) return null;
      return {
        stage: snapshot.stage,
        lastProgressAt: snapshot.lastProgressAt,
        toolStartedAt: snapshot.toolStartedAt,
        toolSelfDeadlineMs: snapshot.toolSelfDeadlineMs,
      };
    },
    async ask(prompt, options = {}) {
      setActiveTurnCount(getActiveTurnCount() + 1);
      // Lazy code-graph prewarm: kick off the build ONCE, on the first real
      // turn, so a likely code lookup hits a warm cache.
      if (codeGraphPrewarmLazy && !getCodeGraphFirstTurnPrewarmDone()) {
        setCodeGraphFirstTurnPrewarmDone(true);
        scheduleCodeGraphPrewarm(0, 'first-turn');
      }
      const startedAt = Date.now();
      try {
        await refreshSessionForCwdIfNeeded('cwd-change');
        if (!getSession()?.id) await createCurrentSession('turn');
        // Remote outbound: ensure a transcript writer bound to the current
        // session.id + cwd. Gated on remoteEnabled so non-remote sessions write nothing.
        if (getRemoteEnabled()) {
          setLastAppendedAssistant('');
          const prevKey = getTwKey();
          ensureRemoteTranscriptWriter();
          // Flush a rebind deferred before the session/writer existed ('acquired'
          // in lazy mode). One-shot: no-op unless a push was actually deferred.
          flushPendingTranscriptRebind?.();
          if (getTwKey() && getTwKey() !== prevKey && channelsEnabled() && !envFlag('MIXDOG_DISABLE_CHANNEL_START')) {
            void invokeChannelStart()
              .then(() => {
                if (!getRemoteEnabled() || getCloseRequested()) return undefined;
                return channels.execute('activate_channel_bridge', { active: true });
              })
              .catch((error) => bootProfile('channels:turn-rebind-failed', { error: error?.message || String(error) }));
          }
        }
        const session0 = getSession();
        if (session0.deferredInitialRefreshPending) {
          // FIRST TURN of a FRESH session (session-local gate, NOT the
          // process-wide firstTurnCompleted): an MCP server may have finished its
          // handshake BETWEEN session-create and this first send. Re-fold the
          // LIVE registry into the INITIAL deferred surface + BP1
          // <available-deferred-tools> manifest (sync, in-place, idempotent) and
          // pre-mark those names announced, so they ship in the initial manifest
          // instead of a late-tool <system-reminder>. One-shot: cleared before
          // the fold so a throw still never re-runs it, and a resumed session
          // (flag unset) skips straight to the late path below.
          session0.deferredInitialRefreshPending = false;
          // First-turn gate: give the in-flight INITIAL MCP connect a bounded
          // chance to finish so servers that connect within the startup budget
          // land in THIS request's tool surface. Bounded by the same budget —
          // UI/boot never blocks here; only this first ask waits, and only once.
          try { await awaitInitialMcpConnect?.(); }
          catch { /* gate must never break the turn */ }
          try { refreshInitialDeferredMcpSurface(session0, getMcpTools()); }
          catch { /* first-turn MCP fold must never break the turn */ }
        } else {
          // AFTER FIRST TURN: fold in MCP tools whose servers finished their
          // handshake after this session was created, and announce the newly
          // available deferred tool names via ONE appended, persistent
          // system-reminder (append-only — never rewrites BP1 or touches the
          // active tool surface, so the prompt-cache prefix stays intact).
          try {
            reconcileDeferredMcpToolCatalog(session0, getMcpTools(), {
              // Deliver the late-tool announcement through the pending-message
              // queue so it rides inside the next real user turn as a persisted
              // system-reminder (no synthetic user + '.' assistant pair).
              enqueue: (text) => (typeof mgr.enqueuePendingMessage === 'function'
                ? mgr.enqueuePendingMessage(session0.id, text) > 0
                : false),
            });
          }
          catch { /* MCP delta must never break the turn */ }
        }
        hooks.emit('turn:start', { sessionId: session0.id, prompt, cwd: getCurrentCwd() });
        // UserPromptSubmit: a hook FAILURE must not block the turn, but blocked===true MUST throw.
        let promptDispatch = null;
        try {
          promptDispatch = await hooks.dispatch('UserPromptSubmit', hookCommonPayload({ session_id: session0.id, prompt }));
        } catch { /* hook failure never blocks the turn */ }
        if (promptDispatch?.blocked === true) {
          throw new Error(`prompt blocked by hook: ${promptDispatch.reason || ''}`);
        }
        const hookContext = Array.isArray(promptDispatch?.additionalContext)
          ? promptDispatch.additionalContext.join('\n\n')
          : String(promptDispatch?.additionalContext || '');
        const turnContext = [options.context || '', hookContext]
          .map((part) => String(part || '').trim())
          .filter(Boolean)
          .join('\n\n');
        const result = await mgr.askSession(
          session0.id,
          prompt,
          turnContext || null,
          async (iter, calls) => {
            for (const call of calls || []) {
              hooks.emit('tool:planned', {
                sessionId: session0.id,
                name: call?.name || 'tool',
                callId: call?.id || null,
              });
              if (getRemoteEnabled() && getTranscriptWriter()) {
                try { getTranscriptWriter().appendToolUse(call?.name, call?.input ?? call?.arguments); }
                catch (error) { process.stderr.write(`mixdog: transcript-writer: onToolCall failed: ${error?.message || error}\n`); }
              }
            }
            if (typeof options.onToolCall === 'function') {
              return await options.onToolCall(iter, calls);
            }
            return undefined;
          },
          getCurrentCwd(),
          options.prefetch || null,
          {
            onTextDelta: options.onTextDelta,
            onReasoningDelta: options.onReasoningDelta,
            onAssistantText: (text) => {
              if (getRemoteEnabled() && getTranscriptWriter()) {
                try {
                  const value = typeof text === 'string' ? text : (text == null ? '' : String(text));
                  if (value.trim()) {
                    getTranscriptWriter().appendAssistant(value);
                    setLastAppendedAssistant(value);
                  }
                }
                catch (error) { process.stderr.write(`mixdog: transcript-writer: onAssistantText failed: ${error?.message || error}\n`); }
              }
              return options.onAssistantText?.(text);
            },
            onUsageDelta: options.onUsageDelta,
            onToolResult: (message) => {
              if (getRemoteEnabled() && getTranscriptWriter()) {
                try {
                  const tur = message?.toolUseResult;
                  if (tur && (tur.oldString != null || tur.newString != null)) {
                    getTranscriptWriter().appendToolResult({ oldString: tur.oldString ?? '', newString: tur.newString ?? '' });
                  }
                } catch (error) { process.stderr.write(`mixdog: transcript-writer: onToolResult failed: ${error?.message || error}\n`); }
              }
              return options.onToolResult?.(message);
            },
            onToolApproval: options.onToolApproval,
            onCompactEvent: options.onCompactEvent,
            onStageChange: options.onStageChange,
            onStreamDelta: options.onStreamDelta,
            drainSteering: options.drainSteering,
            onSteerMessage: options.onSteerMessage,
            notifyFn: notifyFnForSession(session0.id),
          },
        );
        setSession(mgr.getSession(session0.id) || getSession());
        if (getRemoteEnabled() && getTranscriptWriter()) {
          try {
            const finalText = result?.content != null ? String(result.content) : '';
            if (finalText.trim() && finalText !== getLastAppendedAssistant()) {
              getTranscriptWriter().appendAssistant(finalText);
              setLastAppendedAssistant(finalText);
            }
          } catch (error) {
            process.stderr.write(`mixdog: transcript-writer: final append failed: ${error?.message || error}\n`);
          }
        }
        hooks.emit('turn:end', { sessionId: session0.id, elapsedMs: Date.now() - startedAt });
        try {
          await hooks.dispatch('Stop', hookCommonPayload({ session_id: session0.id }));
        } catch { /* best-effort: Stop hook must never break the turn */ }
        return { result, session: getSession() };
      } catch (error) {
        hooks.emit('turn:error', { sessionId: getSession()?.id || null, elapsedMs: Date.now() - startedAt, error: error?.message || String(error) });
        try {
          const msg = String(error?.message || error || '').toLowerCase();
          const errorType = /rate.?limit|429|too many requests/.test(msg) ? 'rate_limit'
            : /overloaded|529/.test(msg) ? 'overloaded'
            : /authenticat|unauthorized|401|invalid.*api.?key/.test(msg) ? 'authentication_failed'
            : /server.?error|5\d\d|internal error/.test(msg) ? 'server_error'
            : 'unknown';
          void hooks.dispatch('StopFailure', hookCommonPayload({ session_id: getSession()?.id || null, error_type: errorType }));
        } catch { /* best-effort: StopFailure hook must never break teardown */ }
        throw error;
      } finally {
        setActiveTurnCount(Math.max(0, getActiveTurnCount() - 1));
        if (!isFirstTurnCompleted()) {
          setFirstTurnCompleted(true);
          scheduleProviderWarmup();
          scheduleProviderModelWarmup();
        }
      }
    },
    async clear(options = {}) {
      const session = getSession();
      if (!session?.id) return false;
      const cleared = await mgr.clearSessionMessages(session.id, options);
      if (!cleared) return false;
      setSession(typeof cleared === 'object' ? cleared : (mgr.getSession(session.id) || session));
      if (options.recoverAgent === true) {
        try { agentTool.recoverWorkers?.({ clientHostPid: getSession()?.clientHostPid || process.pid }); } catch {}
      }
      invalidateContextStatusCache();
      // clearSessionMessages swaps the live session object; the worker binding
      // + persisted status still reference the pre-clear transcript. Push the
      // current transcript so outbound forwarding repoints now, not on the next
      // inbound steal (best-effort, remote-gated inside pushTranscriptRebind).
      pushTranscriptRebind?.();
      return true;
    },
    // session_manage tool handoff: the engine polls this at turn end and, if
    // set, runs the same clear path the idle auto-clear uses. One-shot read.
    consumePendingSessionReset() {
      const pending = getPendingSessionReset();
      setPendingSessionReset(null);
      if (!pending) return null;
      const session = getSession();
      // Session changed since scheduling (resume / new session) — drop it.
      if (!session?.id || pending.sessionId !== session.id) return null;
      return pending.action;
    },
    async compact(options = {}) {
      const session = getSession();
      if (!session?.id) return null;
      if (getActiveTurnCount() > 0) {
        return { changed: false, reason: 'compact skipped: turn in progress' };
      }
      // Manual compact bypasses loop.mjs, so its PreCompact/PostCompact never
      // fire here — dispatch them explicitly via the session-property hooks.
      try { await session.preCompactHook?.({ trigger: 'manual' }); }
      catch { /* best-effort: PreCompact hook must never break manual compact */ }
      const result = await mgr.compactSessionMessages(session.id);
      try { await session.postCompactHook?.({ trigger: 'manual' }); }
      catch { /* best-effort: PostCompact hook must never break manual compact */ }
      setSession(mgr.getSession(session.id) || session);
      if (options.recoverAgent === true) {
        try { agentTool.recoverWorkers?.({ clientHostPid: getSession()?.clientHostPid || process.pid }); } catch {}
      }
      invalidateContextStatusCache();
      return result;
    },
    async setToolMode(nextMode) {
      const mode = normalizeToolMode(nextMode);
      setMode(mode);
      invalidatePreSessionToolSurface();
      const session = getSession();
      if (session?.id) mgr.closeSession(session.id, 'cli-mode-switch');
      await recreateCurrentSessionIfReady();
      return mode;
    },
    agentStatus() {
      return agentStatusState();
    },
    agentControl(args = {}) {
      const session = getSession();
      const callerSessionId = session?.id || null;
      return agentTool.execute(args, {
        callerCwd: getCurrentCwd(),
        invocationSource: 'user-command',
        callerSessionId,
        clientHostPid: session?.clientHostPid || process.pid,
        notifyFn: notifyFnForSession(callerSessionId),
      });
    },
    onNotification(listener) {
      if (typeof listener !== 'function') return () => {};
      notificationListeners.add(listener);
      return () => notificationListeners.delete(listener);
    },
    toolsStatus(query = '') {
      const surface = activeToolSurface();
      const catalog = Array.isArray(surface?.deferredToolCatalog)
        ? surface.deferredToolCatalog
        : (Array.isArray(surface?.tools) ? surface.tools : []);
      const activeNames = new Set([
        ...(surface?.tools || []).map((tool) => tool?.name).filter(Boolean),
        ...(surface?.deferredCallableTools || []),
      ]);
      const needle = clean(query).toLowerCase();
      const rows = catalog.map((tool) => toolRow(tool, activeNames)).filter((row) => row.name);
      const counts = splitToolStatusCounts(rows);
      const tools = needle
        ? rows.filter((row) => toolSearchMatches(row, needle))
        : rows;
      return {
        mode: getMode(),
        ...counts,
        tools,
        activeTools: sortedNamesByMeasuredUsage(activeNames),
        discoveredTools: sortedNamesByMeasuredUsage(surface?.deferredDiscoveredTools || []),
      };
    },
    selectTools(names) {
      const list = Array.isArray(names) ? names : String(names || '').split(/[,\s]+/);
      const result = selectDeferredTools(activeToolSurface(), list, getMode());
      return { ...result, status: this.toolsStatus() };
    },
    setCwd(path) {
      applyResolvedCwd(resolveCwdPath(path));
      return getCurrentCwd();
    },
  };
}
