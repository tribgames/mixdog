/**
 * src/tui/engine/session-api.mjs - part of the public engine session object.
 */
import { compactEventDetail, projectNameFromPath } from './labels.mjs';
import { toolErrorDisplay } from './tool-result-text.mjs';
import { isQueuedEntryEditable, promptDisplayText } from './queue-helpers.mjs';
import { createEngineApiB } from './session-api-ext.mjs';
import { buildDoctorReport } from '../app/doctor.mjs';
import { recomputePromptHistory } from './prompt-history.mjs';
import { buildMergedPromptHistory, loadPromptHistory } from '../prompt-history-store.mjs';

// Upper bound on how long a manual Esc abort may leave the store busy while the
// in-flight runtime.ask() unwinds. runtime.abort() normally rejects the pending
// ask within a tick; this is the belt-and-suspenders window before the bounded
// recovery timer hard-releases busy so Esc can never wedge input forever.
const MANUAL_ABORT_RECOVERY_MS = (() => {
  const v = Number(process.env.MIXDOG_MANUAL_ABORT_RECOVERY_MS);
  return Number.isFinite(v) && v > 0 ? v : 4000;
})();

export function createEngineApi(bag) {
  return { ...createEngineApiA(bag), ...createEngineApiB(bag) };
}

export function createEngineApiA(bag) {
  const {
    runtime, nextId, flags, pending, listeners, getState, set, pushItem, patchItem, replaceItems, settleStreamingTail, clearStreamingTail, pushNotice, autoClearState, agentStatusState, routeState, syncContextStats, denyAllToolApprovals, updateAgentJobCard, requeueEntriesFront, enqueue, autoClearBeforeSubmit, restoreQueued, resetStatsAndSyncContext, drain, flushDeferredExecutionPendingResumeKick, discardExecutionPendingResume,
  } = bag;
  return {
    getState: () => getState(),
    patchItem,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    submit: (text, options = {}) => {
      const t = promptDisplayText(text, options).trim();
      if (!t) return false;
      const mode = options.mode || 'prompt';
     // Prompt input queued while a turn is active keeps the
     // default `next` priority, so it is injected at the next tool/model
     // boundary. Explicit options.priority still wins.
     const priority = options.priority;
      const queueOptions = {
        ...options,
        mode,
        displayText: promptDisplayText(text, options),
        priority,
      };
      // A running clear (idle auto-clear or session_manage) sets commandBusy;
      // queue the prompt instead of dropping it — it drains after the clear.
      if (flags.autoClearRunning) {
        enqueue(text, queueOptions);
        return true;
      }
      // Any in-flight session command (clear/setModel/newSession/resume/...)
      // holds commandBusy. Previously the prompt was dropped here and only the
      // prompt-history side effect survived. Queue it instead: drain bails while
      // commandBusy, and the central release hook re-kicks drain once the
      // command settles, so the prompt runs afterwards rather than vanishing.
      if (getState().commandBusy) {
        enqueue(text, queueOptions);
        return true;
      }
      if (getState().busy) {
        enqueue(text, queueOptions);
        return true;
      }
      // If autoClearBeforeSubmit rejects (e.g. compaction timeout throws), the
      // prompt must still be queued — swallow the rejection so enqueue always
      // runs and the submit is never silently lost.
      void autoClearBeforeSubmit().catch(() => {}).then(() => enqueue(text, queueOptions));
      return true;
    },
    restoreQueued,
    setModel: async (m) => {
      if (getState().commandBusy) return false;
      set({ commandBusy: true });
      try {
        // Model changes apply to the NEXT session only (default setRoute
        // behavior) — never rewrite the live session's provider/model, which
        // would force a full prompt-cache rewrite mid-conversation.
        await runtime.setRoute({ model: m });
        set({ ...routeState(), stats: { ...getState().stats } });
        return true;
      } finally {
        set({ commandBusy: false });
      }
    },
    setEffort: async (value) => {
      if (getState().commandBusy) return false;
      set({ commandBusy: true });
      try {
        await runtime.setEffort(value);
        set({ ...routeState() });
        return runtime.effort || 'auto';
      } finally {
        set({ commandBusy: false });
      }
    },
    setFast: async (value) => {
      if (getState().commandBusy) return null;
      set({ commandBusy: true });
      try {
        const enabled = await runtime.setFast(value);
        set({ ...routeState() });
        return enabled;
      } finally {
        set({ commandBusy: false });
      }
    },
    toggleFast: async () => {
      if (getState().commandBusy) return null;
      set({ commandBusy: true });
      try {
        const enabled = await runtime.toggleFast();
        set({ ...routeState() });
        return enabled;
      } finally {
        set({ commandBusy: false });
      }
    },
    setToolMode: (m) => {
      void runtime.setToolMode(m)
        .then(() => {
          resetStatsAndSyncContext();
          set({ ...routeState(), toolMode: runtime.toolMode, stats: { ...getState().stats } });
        })
        .catch((error) => pushNotice(toolErrorDisplay(error, 'tool'), 'error'));
    },
    getAutoClear: () => autoClearState(),
    setAutoClear: (input = {}) => {
      const next = runtime.setAutoClear?.(input) || autoClearState();
      set({ autoClear: next });
      return next;
    },
    getUpdateSettings: () => runtime.getUpdateSettings?.() || null,
    setAutoUpdate: (enabled) => runtime.setAutoUpdate?.(enabled),
    checkForUpdate: (input = {}) => runtime.checkForUpdate?.(input),
    runUpdateNow: () => runtime.runUpdateNow?.(),
    getUpdateStatus: () => runtime.getUpdateStatus?.() || { phase: 'idle' },
    getProfile: () => runtime.getProfile?.() || { title: '', language: 'system', languages: [] },
    setProfile: (input = {}) => {
      const next = runtime.setProfile?.(input) || runtime.getProfile?.() || null;
      return next;
    },
    getCompactionSettings: () => {
      return runtime.getCompactionSettings?.() || {};
    },
    setCompactionSettings: async (input = {}) => {
      if (getState().commandBusy) return null;
      set({ commandBusy: true });
      try {
        const next = runtime.setCompactionSettings?.(input) || {};
        set({ ...routeState(), stats: { ...getState().stats } });
        // Context-stats recompute (transcript scan + per-message JSON
        // stringify) is the secondary hitch source on this toggle; defer it
        // off the key-handler tick so Ink repaints the setting change first.
        // Stats become eventually consistent on the next tick/repaint.
        setTimeout(() => {
          syncContextStats({ allowEstimated: true });
          set({ stats: { ...getState().stats } });
        }, 0);
        return next;
      } finally {
        set({ commandBusy: false });
      }
    },
    getMemorySettings: () => {
      return runtime.getMemorySettings?.() || { enabled: true };
    },
    setMemoryEnabled: async (enabled) => {
      if (getState().commandBusy) return null;
      set({ commandBusy: true });
      try {
        const next = await runtime.setMemoryEnabled?.(enabled);
        set({ ...routeState(), stats: { ...getState().stats } });
        // Deferred for the same reason as setCompactionSettings above: keep
        // the recompute off the key-handler tick so the toggle repaints
        // immediately; stats catch up right after.
        setTimeout(() => {
          syncContextStats({ allowEstimated: true });
          set({ stats: { ...getState().stats } });
        }, 0);
        return next;
      } finally {
        set({ commandBusy: false });
      }
    },
    getChannelSettings: (options = {}) => {
      return runtime.getChannelSettings?.(options) || {
        enabled: true,
        ...(options?.includeStatus === false ? {} : { status: runtime.getChannelWorkerStatus?.() }),
      };
    },
    setChannelsEnabled: async (enabled) => {
      if (getState().commandBusy) return null;
      set({ commandBusy: true });
      try {
        const next = await runtime.setChannelsEnabled?.(enabled);
        set({ ...routeState(), stats: { ...getState().stats } });
        return next;
      } finally {
        set({ commandBusy: false });
      }
    },
    agentControl: async (args = {}) => {
      if (getState().commandBusy) return null;
      set({ commandBusy: true });
      try {
        const result = await runtime.agentControl(args);
        const text = String(result ?? '').trim();
        const itemId = nextId();
        pushItem({
          kind: 'tool',
          id: itemId,
          name: 'agent',
          args,
          result: null,
          isError: false,
          expanded: false,
          count: 1,
          completedCount: 0,
          startedAt: Date.now(),
        });
        updateAgentJobCard(itemId, text, /^error:/i.test(text));
        set(agentStatusState({ force: true }));
        return result;
      } finally {
        set({ commandBusy: false });
      }
    },
    toolsStatus: (query = '') => {
      return runtime.toolsStatus?.(query) || { mode: getState().toolMode, count: 0, activeCount: 0, tools: [] };
    },
    selectTools: (names) => {
      const result = runtime.selectTools?.(names) || { added: [], already: [], blocked: [], missing: [] };
      const added = result.added?.length ? `added ${result.added.join(', ')}` : '';
      const already = result.already?.length ? `already ${result.already.join(', ')}` : '';
      const blocked = result.blocked?.length ? `blocked ${result.blocked.map((row) => row.name).join(', ')}` : '';
      const missing = result.missing?.length ? `missing ${result.missing.join(', ')}` : '';
      pushNotice(
        [added, already, blocked, missing].filter(Boolean).join(' - ') || 'no tool changes',
        result.blocked?.length || result.missing?.length ? 'warn' : 'info',
      );
      return result;
    },
    setCwd: (path, options = {}) => {
      const next = runtime.setCwd(path);
      // Republish up-arrow history for the NEW project: current session prompts
      // merged with the cwd-scoped persisted store for the new cwd.
      const sessionList = recomputePromptHistory(getState().items);
      set({ cwd: next, promptHistoryList: buildMergedPromptHistory(sessionList, loadPromptHistory(next)) });
      if (options?.notice !== false) {
        pushNotice(options?.message || `Project set: ${projectNameFromPath(next)}`, 'info');
      }
      return next;
    },
    getSystemShell: () => {
      return runtime.getSystemShell?.() || runtime.systemShell || { source: 'auto', command: '', effective: '' };
    },
    setSystemShell: (command) => {
      const next = runtime.setSystemShell?.(command) || { source: 'auto', command: '', effective: '' };
      set({ ...routeState(), systemShell: next });
      pushNotice(`system shell -> ${next.effective || 'auto'}`, 'info');
      return next;
    },
    mcpStatus: () => {
      return runtime.mcpStatus?.() || { servers: [], configuredCount: 0, connectedCount: 0, failedCount: 0 };
    },
    reconnectMcp: async () => {
      if (getState().commandBusy) return null;
      set({ commandBusy: true });
      try {
        const status = await runtime.reconnectMcp?.();
        resetStatsAndSyncContext();
        set({ ...routeState(), stats: { ...getState().stats } });
        pushNotice(
          `mcp reconnect: ${status?.connectedCount || 0}/${status?.configuredCount || 0} connected${status?.failedCount ? ` - ${status.failedCount} failed` : ''}`,
          status?.failedCount ? 'warn' : 'info',
        );
        return status;
      } finally {
        set({ commandBusy: false });
      }
    },
    addMcpServer: async (input) => {
      if (getState().commandBusy) return null;
      set({ commandBusy: true });
      try {
        const result = await runtime.addMcpServer?.(input);
        resetStatsAndSyncContext();
        set({ ...routeState(), stats: { ...getState().stats } });
        pushNotice(`mcp added: ${result?.name || input?.name || 'server'}`, 'info');
        return result;
      } finally {
        set({ commandBusy: false });
      }
    },
    removeMcpServer: async (name) => {
      if (getState().commandBusy) return null;
      set({ commandBusy: true });
      try {
        const status = await runtime.removeMcpServer?.(name);
        resetStatsAndSyncContext();
        set({ ...routeState(), stats: { ...getState().stats } });
        pushNotice(`mcp removed: ${name}`, 'info');
        return status;
      } finally {
        set({ commandBusy: false });
      }
    },
    setMcpServerEnabled: async (name, enabled) => {
      // No global commandBusy: the runtime adopts config synchronously and
      // serializes the heavy connect/close/recreate per server name, so rapid
      // re-toggles converge instead of being dropped. This awaits the
      // background chain purely to settle the picker on completion/failure.
      const status = await runtime.setMcpServerEnabled?.(name, enabled);
      // The context re-estimate is a full-transcript token count; defer it off
      // the interactive frame so it never runs inside the toggle key handler.
      setImmediate(() => {
        resetStatsAndSyncContext();
        set({ ...routeState(), stats: { ...getState().stats } });
      });
      // A connect failure resolves as a status object (not a throw), so inspect
      // this server's row before claiming success: enabling can fail on spawn/
      // handshake. Disabling never spawns, so it is always a success.
      const row = status?.servers?.find((s) => s.name === name);
      if (enabled && row && (row.status === 'failed' || row.error)) {
        pushNotice(`mcp enable failed: ${name}${row.error ? ` — ${row.error}` : ''}`, 'error');
      } else {
        pushNotice(`mcp ${enabled ? 'enabled' : 'disabled'}: ${name}`, 'info');
      }
      return status;
    },
    getDisabledSkills: () => runtime.getDisabledSkills?.() || { disabled: [] },
    setDisabledSkills: (disabled) => runtime.setDisabledSkills?.(disabled) || { disabled: [] },
    skillsStatus: () => {
      return runtime.skillsStatus?.() || { cwd: getState().cwd, count: 0, skills: [] };
    },
    skillContent: (name) => {
      return runtime.skillContent?.(name);
    },
    addSkill: async (input) => {
      if (getState().commandBusy) return null;
      set({ commandBusy: true });
      try {
        const result = await runtime.addSkill?.(input);
        resetStatsAndSyncContext();
        set({ ...routeState(), stats: { ...getState().stats } });
        pushNotice(`skill added: ${result?.skill?.name || input?.name || 'skill'}`, 'info');
        return result;
      } finally {
        set({ commandBusy: false });
      }
    },
    reloadSkills: async () => {
      if (getState().commandBusy) return null;
      set({ commandBusy: true });
      try {
        const status = await runtime.reloadSkills?.();
        resetStatsAndSyncContext();
        set({ ...routeState(), stats: { ...getState().stats } });
        pushNotice(`skills reload: ${status?.count || 0} available`, 'info');
        return status;
      } finally {
        set({ commandBusy: false });
      }
    },
    pluginsStatus: () => {
      return runtime.pluginsStatus?.() || { count: 0, plugins: [] };
    },
    reloadPlugins: async () => {
      if (getState().commandBusy) return null;
      set({ commandBusy: true });
      try {
        const status = await runtime.reloadPlugins?.();
        resetStatsAndSyncContext();
        set({ ...routeState(), stats: { ...getState().stats } });
        pushNotice(`plugins reload: ${status?.count || 0} detected`, 'info');
        return status;
      } finally {
        set({ commandBusy: false });
      }
    },
    addPlugin: async (source) => {
      if (getState().commandBusy) return null;
      set({ commandBusy: true });
      try {
        const result = await runtime.addPlugin?.(source);
        resetStatsAndSyncContext();
        set({ ...routeState(), stats: { ...getState().stats } });
        pushNotice(`plugin added: ${result?.plugin?.title || result?.plugin?.name || source}`, 'info');
        return result;
      } finally {
        set({ commandBusy: false });
      }
    },
    updatePlugin: async (plugin) => {
      if (getState().commandBusy) return null;
      set({ commandBusy: true });
      try {
        const result = await runtime.updatePlugin?.(plugin);
        resetStatsAndSyncContext();
        set({ ...routeState(), stats: { ...getState().stats } });
        pushNotice(`plugin updated: ${result?.plugin?.title || result?.plugin?.name || plugin?.name || plugin}`, 'info');
        return result;
      } finally {
        set({ commandBusy: false });
      }
    },
    removePlugin: async (plugin) => {
      if (getState().commandBusy) return null;
      set({ commandBusy: true });
      try {
        const result = await runtime.removePlugin?.(plugin);
        resetStatsAndSyncContext();
        set({ ...routeState(), stats: { ...getState().stats } });
        pushNotice(`plugin uninstalled: ${result?.plugin?.title || result?.plugin?.name || plugin?.name || plugin}`, 'info');
        return result;
      } finally {
        set({ commandBusy: false });
      }
    },
    enablePluginMcp: async (plugin) => {
      if (getState().commandBusy) return null;
      set({ commandBusy: true });
      try {
        const result = await runtime.enablePluginMcp?.(plugin);
        resetStatsAndSyncContext();
        set({ ...routeState(), stats: { ...getState().stats } });
        pushNotice(`plugin MCP enabled: ${result?.serverName || plugin?.name || 'plugin'}`, 'info');
        return result;
      } finally {
        set({ commandBusy: false });
      }
    },
    hooksStatus: () => {
      return runtime.hooksStatus?.() || { enabled: false, events: [], recent: [] };
    },
    contextStatus: () => {
      return runtime.contextStatus?.() || null;
    },
    addHookRule: (rule) => {
      const rules = runtime.addHookRule?.(rule) || [];
      pushNotice(`hook rule added (${rules.length} total)`, 'info');
      return rules;
    },
    setHookRuleEnabled: (index, enabled) => {
      const rules = runtime.setHookRuleEnabled?.(index, enabled) || [];
      pushNotice(`hook rule ${index + 1} ${enabled ? 'enabled' : 'disabled'}`, 'info');
      return rules;
    },
    deleteHookRule: (index) => {
      const rules = runtime.deleteHookRule?.(index) || [];
      pushNotice(`hook rule ${index + 1} deleted`, 'info');
      return rules;
    },
    memoryControl: async (args = {}, options = {}) => {
      if (getState().commandBusy) return null;
      set({ commandBusy: true });
      try {
        const result = await runtime.memoryControl(args);
        const text = String(result || '').trim() || '(empty memory result)';
        if (!options.silent) pushNotice(text, 'info');
        return result;
      } finally {
        set({ commandBusy: false });
      }
    },
    recall: async (query, args = {}) => {
      if (getState().commandBusy) return null;
      const startedAt = Date.now();
      set({ commandBusy: true, commandStatus: { active: true, verb: 'Recalling memory', startedAt, mode: 'recalling' } });
      try {
        const result = await runtime.recall(query, args);
        pushNotice(String(result || '').trim() || '(empty recall result)', 'info');
        return result;
      } finally {
        set({ commandBusy: false, commandStatus: null });
      }
    },
    runDoctor: async () => {
      if (getState().commandBusy) return null;
      const startedAt = Date.now();
      set({ commandBusy: true, commandStatus: { active: true, verb: 'Running diagnostics', startedAt, mode: 'doctor' } });
      try {
        // Yield one event-loop turn so Ink paints the running indicator before
        // the (mostly synchronous) health checks run — same pattern as compact.
        await new Promise((resolve) => setTimeout(resolve, 0));
        const report = await buildDoctorReport(runtime, getState);
        pushNotice(report, 'info');
        return report;
      } catch (e) {
        pushNotice(`doctor failed: ${e?.message || e}`, 'error');
        return null;
      } finally {
        set({ commandBusy: false, commandStatus: null });
      }
    },
    compact: async () => {
      if (getState().commandBusy) return null;
      if (getState().busy) {
        pushNotice('Compact skipped: turn in progress', 'info');
        return { changed: false, reason: 'compact skipped: turn in progress' };
      }
      const startedAt = Date.now();
      set({ commandBusy: true, commandStatus: { active: true, verb: 'Compacting conversation', startedAt, mode: 'compacting' } });
      try {
        // Give Ink one event-loop turn to paint the compacting spinner before
        // runtime.compact() starts synchronous session/transcript work (same
        // yield as the auto-clear path; without it /compact looks frozen with
        // no spinner until the compact already finished).
        await new Promise((resolve) => setTimeout(resolve, 0));
        const result = await runtime.compact({ recoverAgent: true });
        syncContextStats({ allowEstimated: true });
        set({ ...routeState(), stats: { ...getState().stats } });
        if (result) {
          if (!result.error && result.changed !== false) {
            set({ items: replaceItems([]) });
          }
          pushItem({
            kind: 'statusdone',
            id: nextId(),
            label: result.error ? 'Compact failed' : (result.changed === false ? 'Compact checked' : 'Compact complete'),
            detail: compactEventDetail({
              stage: 'manual',
              trigger: 'manual',
              status: result.error ? 'failed' : (result.changed === false ? 'no_change' : 'compacted'),
              compactType: result.compactType,
              beforeTokens: result.beforeTokens,
              afterTokens: result.afterTokens,
              beforeMessages: result.beforeMessages,
              afterMessages: result.afterMessages,
              semantic: result.semanticCompact,
              recallFastTrack: result.recallFastTrack,
              durationMs: Date.now() - startedAt,
              error: result.error,
            }),
          });
        } else {
          // null = session missing/closed: still surface a done row so
          // /compact never ends silently without a completion marker.
          pushItem({
            kind: 'statusdone',
            id: nextId(),
            label: 'Compact failed',
            detail: 'no active session',
          });
        }
        return result;
      } finally {
        set({ commandBusy: false, commandStatus: null });
      }
    },
    abort: () => {
      if (!getState().busy) return false;
      denyAllToolApprovals('interrupted by user');
      const restoreState = flags.activePromptRestore;
      // A queued steering prompt means the user already redirected the turn:
      // interrupting should just cancel the running turn and let the steering
      // prompt run next, NOT resurrect the in-flight prompt back into the draft.
      const hasPendingSteering = pending.some((entry) => isQueuedEntryEditable(entry));
      const canRestore = restoreState?.restorable && !hasPendingSteering;
      const restoreText = canRestore ? restoreState.text : '';
      const restorePastedImages = canRestore && restoreState?.pastedImages ? restoreState.pastedImages : null;
      const restorePastedTexts = canRestore && restoreState?.pastedTexts ? restoreState.pastedTexts : null;
      // When steering suppresses the restore, the interrupted prompt's pasted
      // images never get committed (onCommitted won't fire) nor re-installed into
      // the draft, so hand them back for cleanup to avoid a stale `[Image #id]`
      // lingering in the paste snapshot.
      const discardPastedImages = restoreState?.restorable && hasPendingSteering && restoreState?.pastedImages
        ? restoreState.pastedImages
        : null;
      const discardPastedTexts = restoreState?.restorable && hasPendingSteering && restoreState?.pastedTexts
        ? restoreState.pastedTexts
        : null;
      const requeueEntries = restoreState && !restoreState.committed && Array.isArray(restoreState.requeueEntries)
        ? restoreState.requeueEntries.filter(
          (entry) => entry?.abortDiscardOnAbort !== true && entry?.mode !== 'pending-resume',
        )
        : [];
      const aborted = runtime.abort('cli-react-abort');
      if (restoreState) {
        if (aborted !== false && Array.isArray(restoreState.discardExecutionPendingResumeKeys)) {
          discardExecutionPendingResume?.(restoreState.discardExecutionPendingResumeKeys);
        }
        if ((restoreText || requeueEntries.length > 0) && aborted !== false) {
          restoreState.reclaimed = true;
          const idSet = new Set((restoreState.submittedIds || []).filter((id) => id != null));
          const patch = { spinner: null, thinking: null, lastTurn: null };
          if (idSet.size > 0) {
            const items = getState().items.filter((item) => !idSet.has(item?.id));
            if (items.length !== getState().items.length) {
              patch.items = replaceItems(items);
            }
          }
          set(patch);
          if (requeueEntries.length > 0) requeueEntriesFront(requeueEntries);
        }
        restoreState.restorable = false;
        restoreState.requeueEntries = [];
        restoreState.discardExecutionPendingResumeKeys = [];
      }
      // ── Bounded manual-abort recovery ───────────────────────────────────
      // runtime.abort() above normally rejects the in-flight runtime.ask() so
      // the turn's own finally clears busy within a tick. If that unwind is
      // starved — e.g. a provider abort that never settles after a post-tool
      // fetch stall — busy would stay true until the far-larger turn watchdog
      // trips, wedging the TUI with dead input. Arm a short grace timer that
      // hard-releases busy exactly like the watchdog force-release, but ONLY
      // when this same turn is still the active owner (epoch unchanged) AND
      // still busy — so a normal cancellation that settles in time is never
      // masked and a newer turn's store is never corrupted.
      const abortEpoch = flags.leadTurnEpoch;
      const recoveryMs = Number(flags.manualAbortRecoveryMs) > 0
        ? Number(flags.manualAbortRecoveryMs)
        : MANUAL_ABORT_RECOVERY_MS;
      const recoveryTimer = setTimeout(() => {
        if (flags.disposed) return;
        if (!getState().busy) return;                    // normal abort settled
        if (flags.leadTurnEpoch !== abortEpoch) return;  // a newer turn owns the store
        const streamingTail = getState().streamingTail;
        if (streamingTail?.text?.trim()) {
          settleStreamingTail?.(streamingTail.id, {});
        } else {
          clearStreamingTail?.();
        }
        // Bump the epoch FIRST so the still-stuck turn's eventual finally becomes
        // a no-op for shared getState() writes and cannot corrupt the handoff.
        flags.leadTurnEpoch = (Number(flags.leadTurnEpoch) || 0) + 1;
        set({ busy: false, spinner: null, thinking: null, lastTurn: null });
        flags.activePromptRestore = null;
        // Abandon the drain loop that is still awaiting the stuck turn before
        // releasing the drain lock. Its eventual finally observes the stale
        // epoch and cannot clear a newer drain's ownership or continue work.
        flags.drainEpoch = (Number(flags.drainEpoch) || 0) + 1;
        if (flags.draining) flags.draining = false;
        pushNotice('Interrupt did not settle — input restored.', 'warn', { transcript: true });
        if (pending.length > 0 && typeof drain === 'function') void drain();
        // busy→false here bypasses the normal turn-end + drain-finally flushes,
        // so re-arm any deferred completion kick explicitly (idempotent).
        if (typeof flushDeferredExecutionPendingResumeKick === 'function') flushDeferredExecutionPendingResumeKick();
      }, recoveryMs);
      recoveryTimer.unref?.();
      return { aborted, restoreText, pastedImages: restorePastedImages, discardPastedImages, pastedTexts: restorePastedTexts, discardPastedTexts };
    },
  };
}
