/**
 * src/session-runtime/turn/turn-run.mjs - one user turn end to end: turn open (abort controller, timing, warmup arming), session
 * preparation (workspace provisioning, then the worktree review snapshot), the
 * askSession callback bridge, and the settlement that always runs. The phases
 * live under turn-run/.
 */
import { beginTurnSnapshot, completeTurnSnapshot } from '../../runtime/shared/turn-snapshot.mjs';
import { runWithCwdOverride } from '../../runtime/shared/user-cwd.mjs';
import { createTurnTranscript } from './turn-run/transcript.mjs';
import { createTurnTimingFactory } from './turn-run/turn-timing.mjs';
import { createSnapshotTrackerFactory } from './turn-run/snapshot-tracker.mjs';
import { createTurnOpener } from './turn-run/turn-open.mjs';
import { createTurnPreparation } from './turn-run/turn-prepare.mjs';
import { createAskCallbacks } from './turn-run/ask-callbacks.mjs';
import { registerNativeWebSearchUsageSink } from '../native-web-search-usage.mjs';
import { createTurnSettlement } from './turn-run/turn-settle.mjs';

export function createTurnRunner(deps) {
  const {
    getSession,
    getCurrentCwd,
    mgr,
    mcpTurnGraceMs = 0,
    mcpAgentGraceMs = 3_000,
    endComputerExecution = async () => false,
    deferComputerSessionRelease = () => false,
    beginTurnSnapshotForTurn = beginTurnSnapshot,
    completeTurnSnapshotForTurn = completeTurnSnapshot,
    turnCleanupSettleMs = 2_000,
    getConfig = () => null,
    currentAgents,
  } = deps;
  const transcript = createTurnTranscript(deps);
  const openTurn = createTurnOpener({
    ...deps,
    createTiming: createTurnTimingFactory({ ...deps, mcpTurnGraceMs, mcpAgentGraceMs }),
    createSnapshot: createSnapshotTrackerFactory({
      getCurrentCwd,
      beginTurnSnapshotForTurn,
      completeTurnSnapshotForTurn,
      turnCleanupSettleMs,
    }),
  });
  const { prepareSession, dispatchPromptSubmit } = createTurnPreparation({ ...deps, transcript, getConfig });
  const { askCallbacks, plannedToolCalls } = createAskCallbacks({ ...deps, transcript });
  const { completeTurn, reportTurnError, settleTurn } = createTurnSettlement({
    ...deps,
    transcript,
    endComputerExecution,
    deferComputerSessionRelease,
  });

  function getTurnLiveness() {
    const sessionId = getSession()?.id;
    if (!sessionId || typeof mgr.getSessionProgressSnapshot !== 'function') return null;
    const snapshot = mgr.getSessionProgressSnapshot(sessionId);
    if (!snapshot) return null;
    return { ...snapshot };
  }

  async function runTurn(prompt, options) {
    const turn = openTurn(options);
    try {
      const session0 = await prepareSession(turn, prompt, options);
      const turnContext = await dispatchPromptSubmit(turn, session0, prompt, options);
      const callbacks = askCallbacks(turn, session0, options);
      // Register only once askSession's session lock is held: the first
      // provider send of this turn. A turn queued behind another on the same
      // session id therefore never receives the running turn's search usage.
      let releaseWebSearchUsage = null;
      const providerSendStarted = callbacks.onProviderSendStarted;
      callbacks.onProviderSendStarted = (...args) => {
        releaseWebSearchUsage ??= registerNativeWebSearchUsageSink(session0.id, options.onNativeWebSearchUsage);
        return providerSendStarted(...args);
      };
      let result;
      try {
        result = await mgr.askSession(
          session0.id,
          prompt,
          turnContext || null,
          plannedToolCalls(session0, options),
          getCurrentCwd(),
          options.prefetch || null,
          // The agents enabled now (coding Leads), asked for each user turn
          // the ask prepares, for its agent list reminder
          // (manager/agent-listing-notice.mjs).
          { ...callbacks, agentsNow: currentAgents }
        );
      } finally {
        releaseWebSearchUsage?.();
      }
      return await completeTurn(turn, session0, result);
    } catch (error) {
      reportTurnError(turn, error);
      throw error;
    } finally {
      await settleTurn(turn);
    }
  }

  return {
    getTurnLiveness,
    ask: (prompt, options = {}) => runWithCwdOverride(getCurrentCwd(), () => runTurn(prompt, options)),
  };
}
