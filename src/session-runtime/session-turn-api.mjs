import { clean, tombstoneOnClose } from './session-text.mjs';
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
import { traceTurnTiming } from '../runtime/agent/orchestrator/agent-trace.mjs';
import { beginTurnSnapshot, cancelTurnSnapshot, completeTurnSnapshot } from '../runtime/shared/turn-snapshot.mjs';
import { isVisibleStreamProgress } from '../runtime/shared/stream-progress.mjs';
import { runAbortable, settleWithin, throwIfAborted } from '../runtime/shared/abort-race.mjs';

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
    getCodeGraphFirstTurnPrewarmDone, setCodeGraphFirstTurnPrewarmDone,
    getRemoteEnabled, getCloseRequested,
    getPendingSessionReset, setPendingSessionReset,
    getTranscriptWriter, getTwKey, getLastAppendedAssistant, setLastAppendedAssistant,
    scheduleCodeGraphPrewarm, scheduleToolRuntimeWarmup, scheduleSearchRuntimeWarmup, refreshSessionForCwdIfNeeded, createCurrentSession,
    ensureSessionTranscriptWriter, ensureRemoteTranscriptWriter, channelsEnabled, invokeChannelStart, channels,
    pushTranscriptRebind, flushPendingTranscriptRebind,
    hooks, hookCommonPayload, mgr, notifyFnForSession, bootProfile,
    scheduleProviderWarmup, scheduleProviderModelWarmup, invalidateContextStatusCache,
    agentTool, recreateCurrentSessionIfReady, invalidatePreSessionToolSurface,
    activeToolSurface, applyResolvedCwd, resolveCwdPath, agentStatusState, notificationListeners,
    awaitInitialMcpConnect, mcpTurnGraceMs = 0, awaitRoutePreparation,
    getReservedSessionId, sessionTitles, registerActiveTurnController,
    beginTurnSnapshotForTurn = beginTurnSnapshot,
    cancelTurnSnapshotForTurn = cancelTurnSnapshot,
    completeTurnSnapshotForTurn = completeTurnSnapshot,
    turnCleanupSettleMs = 2_000,
  } = deps;
  const enqueueRemoteAttachedPrompt = (prompt) => {
    const attachedSession = getSession();
    if (!attachedSession?.remoteAttached || !attachedSession.id) return false;
    try {
      // prompt may be a string or { content/text, id } so the submission id
      // survives spool fallback after a live-share ack miss.
      return Number(mgr.enqueueRemotePendingMessage?.(attachedSession.id, prompt)) > 0;
    } catch {
      return false;
    }
  };
  return {
    enqueueRemoteAttachedPrompt,
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
      // Remote-attach: this surface is a viewer on a session that another
      // live process owns. Never run a turn here — persist the prompt into
      // the shared pending spool; the owner's injection poller submits it as
      // a normal user turn and this surface refreshes from disk.
      const attachedSession = getSession();
      if (attachedSession?.remoteAttached) {
        // Carry the submission id into the spool: the owner reuses it for the
        // queue entry and the settled user row, so the submitting surface's
        // optimistic bubble is released instead of standing beside the
        // mirrored twin (user: 같은 세션에서 메세지가 두 개로 보인다).
        const submissionId = String(options.id || '').trim();
        const delivered = enqueueRemoteAttachedPrompt(
          submissionId ? { content: prompt, id: submissionId } : prompt,
        );
        return {
          // This branch is only a race-safe fallback for callers that reached
          // ask() before the live pipe was ready. Never manufacture an
          // assistant response: the owner's mirrored transcript is authoritative.
          result: { content: '', remoteAttached: true, delivered },
          session: attachedSession,
        };
      }
      // Historical-session resume publishes its transcript immediately while
      // provider/model metadata initializes in the background. Only the next
      // actual turn waits, guaranteeing that it cannot run on a stale route.
      const timingStartedAt = performance.now();
      const timingStartedAtEpoch = Date.now();
      const turnAbortController = new AbortController();
      const unregisterTurnAbort = typeof registerActiveTurnController === 'function'
        ? registerActiveTurnController(turnAbortController)
        : () => {};
      const turnSignal = turnAbortController.signal;
      const awaitTurn = (task) => runAbortable(turnSignal, task, 'Turn aborted');
      const submittedAt = Number(options.submittedAt);
      const hasSubmittedAt = Number.isFinite(submittedAt) && submittedAt > 0;
      let turnSnapshotSessionId = null;
      let turnSnapshotPromise = null;
      const startTurnSnapshot = (sessionId) => {
        const id = typeof sessionId === 'string' ? sessionId.trim() : '';
        if (!id || (turnSnapshotPromise && turnSnapshotSessionId === id)) return;
        turnSnapshotSessionId = id;
        // Capture immediately, but do not put Git on the first-token critical
        // path. Every actual tool execution joins this same promise below, so
        // shell/apply_patch cannot mutate the worktree before the baseline.
        turnSnapshotPromise = Promise.resolve()
          .then(() => beginTurnSnapshotForTurn(getCurrentCwd(), id))
          .catch(() => undefined);
      };
      const routeStartedAt = performance.now();
      startTurnSnapshot(getSession()?.id || getReservedSessionId?.());
      let routeWaitMs = 0;
      setActiveTurnCount(getActiveTurnCount() + 1);
      try { scheduleSearchRuntimeWarmup?.(0); } catch { /* search warmup is best-effort */ }
      let mcpWaitMs = 0;
      let providerStartedAt = 0;
      let turnTimingStatus = 'error';
      let turnTimingEmitted = false;
      // Heavy runtime warmup is one-shot and demand-driven: idle desktop panes
      // never spawn shell/token/shard helpers or a code-graph worker. More
      // importantly, do not start them until the provider has produced visible
      // text/reasoning/tool progress: transport headers and response-created
      // acknowledgements arrive earlier and would make PowerShell + graph
      // workers compete with the actual first-token critical path.
      const heavyRuntimeWarmupPending = typeof getCodeGraphFirstTurnPrewarmDone === 'function'
        && !getCodeGraphFirstTurnPrewarmDone();
      if (heavyRuntimeWarmupPending) {
        setCodeGraphFirstTurnPrewarmDone(true);
      }
      let heavyRuntimeWarmupArmed = false;
      const armHeavyRuntimeWarmup = (reason) => {
        if (!heavyRuntimeWarmupPending || heavyRuntimeWarmupArmed) return;
        heavyRuntimeWarmupArmed = true;
        scheduleToolRuntimeWarmup?.(0);
        scheduleCodeGraphPrewarm?.(0, reason);
      };
      const emitTurnTiming = (status) => {
        if (turnTimingEmitted) return;
        turnTimingEmitted = true;
        const now = performance.now();
        const row = {
          status,
          sessionId: String(getSession()?.id || turnSnapshotSessionId || ''),
          requestId: String(options.id || ''),
          ttftMs: now - timingStartedAt,
          endToEndTtftMs: hasSubmittedAt ? Math.max(0, Date.now() - submittedAt) : null,
          queueMs: hasSubmittedAt ? Math.max(0, timingStartedAtEpoch - submittedAt) : null,
          routeMs: routeWaitMs,
          preflightMs: (providerStartedAt || now) - timingStartedAt,
          mcpMs: mcpWaitMs,
          providerMs: providerStartedAt ? now - providerStartedAt : null,
        };
        try {
          process.emit('mixdog:turn-timing', row);
        } catch { /* timing telemetry must never affect a turn */ }
        // Durable sink: the process event only reaches an in-process listener
        // (the daemon log). The trace row is what session-bench aggregates.
        try {
          traceTurnTiming(row);
        } catch { /* timing telemetry must never affect a turn */ }
      };
      const awaitMcpGrace = async () => {
        const startedAt = performance.now();
        try {
          await awaitInitialMcpConnect?.(mcpTurnGraceMs);
        } finally {
          mcpWaitMs += performance.now() - startedAt;
        }
      };
      const startedAt = Date.now();
      try {
        await awaitTurn(() => awaitRoutePreparation?.());
        routeWaitMs = performance.now() - routeStartedAt;
        await awaitTurn(() => refreshSessionForCwdIfNeeded('cwd-change'));
        if (!getSession()?.id) {
          await awaitTurn(() => createCurrentSession('turn', { signal: turnSignal }));
        }
        throwIfAborted(turnSignal);
        // Main-session conversation persistence is independent of Remote:
        // Desktop and local TUI turns feed the same JSONL memory watcher.
        setLastAppendedAssistant('');
        const prevKey = getTwKey();
        ensureSessionTranscriptWriter?.();
        if (getTranscriptWriter()) {
          try { getTranscriptWriter().appendUser(prompt); }
          catch (error) { process.stderr.write(`mixdog: transcript-writer: appendUser failed: ${error?.message || error}\n`); }
        }
        // Remote outbound reuses that writer but alone owns channel discovery
        // and forwarding/rebind behavior.
        if (getRemoteEnabled()) {
          ensureRemoteTranscriptWriter();
          // Flush a rebind deferred before the session/writer existed ('acquired'
          // in lazy mode). One-shot: no-op unless a push was actually deferred.
          flushPendingTranscriptRebind?.();
          if (getTwKey() && getTwKey() !== prevKey && channelsEnabled() && !envFlag('MIXDOG_DISABLE_CHANNEL_START')) {
            void invokeChannelStart()
              .then(() => {
                if (!getRemoteEnabled() || getCloseRequested()) return undefined;
                // A turn may refresh the current owner's transcript, but it
                // must never acquire/override Remote implicitly.
                pushTranscriptRebind();
                return undefined;
              })
              .catch((error) => bootProfile('channels:turn-rebind-failed', { error: error?.message || String(error) }));
          }
        }
        const session0 = getSession();
        startTurnSnapshot(session0?.id);
        try { sessionTitles?.scheduleFirst(session0, prompt); } catch { /* title fallback stays the preview */ }
        // Turn-review boundary: start a fresh session+turn generation. Lead
        // worktree capture overlaps route/MCP/provider preparation. Worker
        // apply_patch diffs bind to this generation and cannot leak into the
        // next turn/session.
        if (session0.deferredInitialRefreshPending) {
          // FIRST TURN of a FRESH session (session-local gate, NOT the
          // process-wide firstTurnCompleted): an MCP server may have finished its
          // handshake BETWEEN session-create and this first send. Re-fold the
          // LIVE registry into the INITIAL provider-visible surface (sync,
          // in-place, idempotent). Native providers rebuild BP2 and pre-mark the
          // names announced; canonical providers extend their fixed active tool
          // snapshot without introducing manifest/reminder semantics. One-shot:
          // cleared before
          // the fold so a throw still never re-runs it, and a resumed session
          // (flag unset) skips straight to the late path below.
          session0.deferredInitialRefreshPending = false;
          // Give an in-flight INITIAL MCP connect only a short TTFT grace.
          // Slower servers remain available through the late-tool path.
          try { await awaitTurn(() => awaitMcpGrace()); }
          catch { /* gate must never break the turn */ }
          try { refreshInitialDeferredMcpSurface(session0, getMcpTools(session0.mcpScopeId)); }
          catch { /* first-turn MCP fold must never break the turn */ }
        } else {
          // AFTER FIRST TURN: fold in MCP tools whose servers finished their
          // handshake after this session was created, and announce the newly
          // available deferred tool names via ONE appended, persistent
          // system-reminder (append-only — never rewrites BP2 or touches the
          // active tool surface, so the prompt-cache prefix stays intact).
          // Context-switch gate: a desktop project switch (and any cwd change)
          // now starts its MCP reset in the background instead of blocking the
          // switch. When such a reconnect is still in flight, give it the same
          // short TTFT grace BEFORE folding the catalog so a slow reconnect
          // cannot hold the provider request. No reconnect in flight →
          // immediate no-op.
          try { await awaitTurn(() => awaitMcpGrace()); }
          catch { /* gate must never break the turn */ }
          try {
            reconcileDeferredMcpToolCatalog(session0, getMcpTools(session0.mcpScopeId), {
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
        try {
          agentTool?.upsertLeadSession?.(session0, {
            status: 'running',
            stage: 'running',
            turnStartedAt: new Date().toISOString(),
          });
        } catch { /* lead pool must never break the turn */ }
        // UserPromptSubmit: a hook FAILURE must not block the turn, but blocked===true MUST throw.
        let promptDispatch = null;
        try {
          promptDispatch = await awaitTurn(
            () => hooks.dispatch('UserPromptSubmit', hookCommonPayload({ session_id: session0.id, prompt })),
          );
        } catch {
          throwIfAborted(turnSignal);
          // Ordinary hook failure never blocks the turn.
        }
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
            beforeToolExecution: () => turnSnapshotPromise || Promise.resolve(),
            transcriptMeta: options.transcriptMeta,
            onTextDelta: options.onTextDelta,
            onTextReset: options.onTextReset,
            onReasoningDelta: options.onReasoningDelta,
            onAssistantText: (text) => {
              if (getTranscriptWriter()) {
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
            onAssistantToolCallObserved: options.onAssistantToolCallObserved,
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
            onProviderSendStarted: (...args) => {
              // This callback is emitted immediately before provider.send,
              // after session locking, history shaping and pre-send compact.
              // The old timestamp above mgr.askSession mislabeled all of that
              // Mixdog work as provider latency.
              if (!providerStartedAt) providerStartedAt = performance.now();
              return options.onProviderSendStarted?.(...args);
            },
            onToolPhaseStarted: options.onToolPhaseStarted,
            onToolPhaseCompleted: options.onToolPhaseCompleted,
            onStreamDelta: (...args) => {
              let value;
              try {
                value = options.onStreamDelta?.(...args);
              } finally {
                if (isVisibleStreamProgress(args[0])) {
                  turnTimingStatus = 'first-visible';
                  emitTurnTiming(turnTimingStatus);
                  armHeavyRuntimeWarmup('first-visible');
                }
              }
              return value;
            },
            drainSteering: options.drainSteering,
            onSteerMessage: options.onSteerMessage,
            notifyFn: notifyFnForSession(session0.id),
            signal: turnSignal,
          },
        );
        throwIfAborted(turnSignal);
        if (!turnTimingEmitted) turnTimingStatus = 'complete-no-delta';
        setSession(mgr.getSession(session0.id) || getSession());
        try { sessionTitles?.observeThird(getSession()); } catch { /* title refresh is best-effort */ }
        if (getTranscriptWriter()) {
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
          await awaitTurn(() => hooks.dispatch('Stop', hookCommonPayload({ session_id: session0.id })));
        } catch {
          throwIfAborted(turnSignal);
          // Ordinary Stop hook failure is best-effort.
        }
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
        emitTurnTiming(turnTimingStatus);
        armHeavyRuntimeWarmup('turn-settled');
        if (turnSignal.aborted) {
          try { cancelTurnSnapshotForTurn(turnSnapshotSessionId); } catch {}
          void Promise.resolve(turnSnapshotPromise).catch(() => {});
        } else {
          const snapshotCleanup = Promise.resolve(turnSnapshotPromise)
            .then(() => completeTurnSnapshotForTurn(turnSnapshotSessionId));
          snapshotCleanup.catch(() => {});
          try {
            await awaitTurn(() => settleWithin(snapshotCleanup, turnCleanupSettleMs));
          } catch { /* optional review cleanup never overrides turn settlement */ }
          if (turnSignal.aborted) {
            try { cancelTurnSnapshotForTurn(turnSnapshotSessionId); } catch {}
          }
        }
        try { unregisterTurnAbort?.(); } catch {}
        try {
          const lead = getSession() || session0;
          agentTool?.upsertLeadSession?.(lead, { status: 'idle', stage: 'idle' });
        } catch { /* lead pool must never break turn teardown */ }
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
    // Message-selector rewind: drop the chosen user prompt and everything
    // after it from the model history. Unlike clear() the session object is
    // kept (same id, same provider/model/cwd) — only the tail is undone.
    async rewindMessages(options = {}) {
      const session = getSession();
      if (!session?.id) return null;
      const result = await mgr.rewindSessionMessagesTo?.(session.id, options);
      if (!result) return null;
      setSession(mgr.getSession(session.id) || session);
      invalidateContextStatusCache();
      return result;
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
      if (session?.id) mgr.closeSession(session.id, 'cli-mode-switch', { tombstone: tombstoneOnClose(session) });
      await recreateCurrentSessionIfReady();
      return mode;
    },
    agentStatus() {
      return agentStatusState();
    },
    // Owner-side injection intake: foreign user messages persisted into the
    // shared spool by an attached surface. Engine pollers call this while
    // idle and run each returned text through the normal submit queue.
    async takeRemoteInjections() {
      const session = getSession();
      if (!session?.id || session.remoteAttached) return [];
      if (getActiveTurnCount() > 0) return [];
      try { return (await mgr.drainForeignUserInjections?.(session.id)) || []; } catch { return []; }
    },
    // Absolute path of the shared pending spool file. Live-share owners
    // fs.watch it for instant cross-surface input pickup; empty string when
    // the store is unavailable (callers fall back to the poll tick).
    pendingSpoolPath() {
      try { return mgr.pendingMessagesSpoolPath?.() || ''; } catch { return ''; }
    },
    // Interactive-presence beacon (engine share tick): mark the CURRENT
    // session as held open by this live surface — idle time included — so a
    // cross-open from another surface attaches as a viewer instead of
    // splitting ownership into two writers. No-op while THIS surface is the
    // viewer. Returns the held id so the caller can clear a previous
    // session's beacon after a switch.
    publishSessionPresence() {
      const session = getSession();
      if (!session?.id || session.remoteAttached) return null;
      try { mgr.publishSessionPresence?.(session.id); } catch { /* best-effort */ }
      return session.id;
    },
    clearSessionPresence(id) {
      const target = id || getSession()?.id;
      if (!target) return;
      try { mgr.deleteSessionPresence?.(target); } catch { /* best-effort */ }
    },
    // Live-owner liveness probe for the viewer self-heal tick: true when a
    // re-resume would no longer attach (owner pid dead or every liveness
    // signal stale) — i.e. nobody is draining this session's spool anymore.
    sessionOwnerGone(id) {
      const target = id || getSession()?.id;
      if (!target) return false;
      try { return mgr.isSessionOwnerGone?.(target) === true; } catch { return false; }
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
