/**
 * src/session-runtime/turn/turn-run.mjs - one user turn end to end: viewer
 * forwarding, turn open (abort controller, timing, worktree snapshot, warmup
 * arming), session preparation, the askSession callback bridge, and the
 * settlement that always runs. The phases live under turn-run/.
 */
import { beginTurnSnapshot, cancelTurnSnapshot, completeTurnSnapshot } from '../../runtime/shared/turn-snapshot.mjs';
import { runWithCwdOverride } from '../../runtime/shared/user-cwd.mjs';
import { createTurnTranscript } from './turn-run/transcript.mjs';
import { createTurnTimingFactory } from './turn-run/turn-timing.mjs';
import { createSnapshotTrackerFactory } from './turn-run/snapshot-tracker.mjs';
import { createTurnOpener } from './turn-run/turn-open.mjs';
import { createTurnPreparation } from './turn-run/turn-prepare.mjs';
import { createAskCallbacks } from './turn-run/ask-callbacks.mjs';
import { createTurnSettlement } from './turn-run/turn-settle.mjs';

export function createTurnRunner(deps) {
  const {
    getSession,
    getCurrentCwd,
    mgr,
    mcpTurnGraceMs = 0,
    endComputerExecution = async () => false,
    deferComputerSessionRelease = () => false,
    beginTurnSnapshotForTurn = beginTurnSnapshot,
    cancelTurnSnapshotForTurn = cancelTurnSnapshot,
    completeTurnSnapshotForTurn = completeTurnSnapshot,
    turnCleanupSettleMs = 2_000,
    getConfig = () => null,
  } = deps;
  const transcript = createTurnTranscript(deps);
  const openTurn = createTurnOpener({
    ...deps,
    createTiming: createTurnTimingFactory({ ...deps, mcpTurnGraceMs }),
    createSnapshot: createSnapshotTrackerFactory({
      getCurrentCwd,
      beginTurnSnapshotForTurn,
      cancelTurnSnapshotForTurn,
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

  function getTurnLiveness() {
    const sessionId = getSession()?.id;
    if (!sessionId || typeof mgr.getSessionProgressSnapshot !== 'function') return null;
    const snapshot = mgr.getSessionProgressSnapshot(sessionId);
    if (!snapshot) return null;
    return { ...snapshot };
  }

  // Remote-attach: this surface is a viewer on a session that another live
  // process owns. Never run a turn here — persist the prompt into the shared
  // pending spool; the owner's injection poller submits it as a normal user
  // turn and this surface refreshes from disk.
  function forwardAttachedPrompt(attachedSession, prompt, options) {
    // Carry the submission id into the spool: the owner reuses it for the
    // queue entry and the settled user row, so the submitting surface's
    // optimistic bubble is reconciled with the mirrored row.
    const submissionId = String(options.id || '').trim();
    const delivered = enqueueRemoteAttachedPrompt(submissionId ? { content: prompt, id: submissionId } : prompt);
    return {
      // This branch is only a race-safe fallback for callers that reached
      // ask() before the live pipe was ready. Never manufacture an
      // assistant response: the owner's mirrored transcript is authoritative.
      result: { content: '', remoteAttached: true, delivered },
      session: attachedSession,
    };
  }

  async function runTurn(prompt, options) {
    const attachedSession = getSession();
    if (attachedSession?.remoteAttached) return forwardAttachedPrompt(attachedSession, prompt, options);
    const turn = openTurn(options);
    try {
      const session0 = await prepareSession(turn, prompt);
      const turnContext = await dispatchPromptSubmit(turn, session0, prompt, options);
      const result = await mgr.askSession(
        session0.id,
        prompt,
        turnContext || null,
        plannedToolCalls(session0, options),
        getCurrentCwd(),
        options.prefetch || null,
        askCallbacks(turn, session0, options)
      );
      return await completeTurn(turn, session0, result);
    } catch (error) {
      reportTurnError(turn, error);
      throw error;
    } finally {
      await settleTurn(turn);
    }
  }

  return {
    enqueueRemoteAttachedPrompt,
    getTurnLiveness,
    ask: (prompt, options = {}) => runWithCwdOverride(getCurrentCwd(), () => runTurn(prompt, options)),
  };
}
