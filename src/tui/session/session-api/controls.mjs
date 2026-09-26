/**
 * controls.mjs — the session object's control surface: Agent / task / Goal
 * control, tool selection, project cwd, prompt history and the system shell.
 */
import { projectNameFromPath } from '../labels.mjs';
import { recomputePromptHistory } from '../prompt-history.mjs';
import { appendPromptHistory, buildMergedPromptHistory, loadPromptHistory } from '../../prompt-history-store.mjs';
import { abortGoalTurn } from '../goal-turn-state.mjs';
import { goalStateSnapshot } from '../../../session-runtime/goal-state.mjs';
import { createApiHelpers } from './shared.mjs';

export function createSessionControlsApi(bag) {
  const {
    runtime,
    nextId,
    flags,
    getState,
    set,
    pushItem,
    pushNotice,
    agentStatusState,
    routeState,
    updateAgentJobCard,
    resetStatsAndSyncContext,
  } = bag;
  const { withCommandLock } = createApiHelpers({ getState, set, resetStatsAndSyncContext, routeState });

  const agentControlWithCard = withCommandLock(async (args) => {
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
  });

  return {
    agentControl: async (args = {}, options = {}) => {
      // Silent reads (desktop dock agent viewer) go straight to the runtime:
      // no transcript card, no commandBusy — mirrors memoryControl's silent
      // read path.
      if (options.silent === true) {
        return runtime.agentControl(args);
      }
      return agentControlWithCard(args);
    },
    // Background-task control (list/read/monitor/cancel) is a CONTROL surface,
    // not a conversation turn: the desktop stop button fires it WHILE a turn
    // runs, so it neither waits on commandBusy nor leaves a transcript card.
    // It must exist here because the daemon addresses actions on this surface.
    taskControl: (args = {}) => {
      return runtime.taskControl?.(args) ?? null;
    },
    goalControl: async (args = {}) => {
      const result = await runtime.goalControl?.(args);
      if (['pause', 'stop'].includes(result?.action)) {
        bag.cancelQueuedGoalContinuations?.();
        if (getState().busy) abortGoalTurn(runtime, flags, false);
      }
      set({ goal: goalStateSnapshot(runtime.goalStatus?.() || result?.goal || null) });
      return result;
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
        result.blocked?.length || result.missing?.length ? 'warn' : 'info'
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
    rememberPromptHistory: (value) => {
      const text = String(value || '').trim();
      if (!text) return false;
      const persisted = appendPromptHistory(getState().cwd, text);
      if (!persisted) return false;
      const sessionList = recomputePromptHistory(getState().items);
      set({ promptHistoryList: buildMergedPromptHistory(sessionList, persisted) });
      return true;
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
  };
}
