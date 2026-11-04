/**
 * agent-tool/worker-turns.mjs — the one owner of a worker session's turn
 * status. Every turn the worker runs (a send's or spawn's own, a follow-up
 * queued behind it, one the drain after a stopped turn starts) is reported by
 * the route that runs it: the canonical session runtime
 * (sessionSurface.observeSessionTurns) or the in-process manager's ask loop
 * (mgr.observeSessionTurns). At a turn's real start the owner stamps the row
 * `running` from that moment and arms the progress watchdog; when its ask
 * ends, or at its outcome on a route that reports no ask end, it stops that
 * watchdog; at its outcome it settles the row as a send's result reads
 * (settledWorkerStatus). Turns are keyed by their own id, so an earlier
 * turn's late settle never touches the next one.
 */
import { randomUUID } from 'node:crypto';
import { createProgressWatchdogRegistry } from '../agent-watchdog-registry.mjs';
import {
  isAgentProgressWatchdogAbortError,
  resolveAgentWatchdogPolicy,
} from '../../../runtime/agent/orchestrator/agent-runtime/agent-progress-watchdog.mjs';
import { saveSessionAsync } from '../../../runtime/agent/orchestrator/session/store.mjs';
import { registerSessionPurgeHook } from '../../../runtime/agent/orchestrator/session/store/session-observers.mjs';
import { abnormalEmptyFinishError } from './render.mjs';
import { settledWorkerStatus } from './worker-index/row-liveness.mjs';
import { workerStageForStatus } from './worker-rows.mjs';

// Mid-turn worker persistence cadence. The watchdog sweep runs every second;
// a transcript save is far more expensive than a bookkeeping stamp, so the
// in-progress snapshot lands on this slower clock.
const AGENT_PROGRESS_SAVE_MS = 2_000;

/** A settled turn's row status, as a send's result reads it: only a cancel of
 *  the turn's job reads cancelled; a watchdog stop of an unfinished turn is a
 *  stall; any other unfinished turn (a pane stop included) and an abnormal
 *  empty finish are errors. */
function settledTurnStatus({ status, result, abortCause }, agent, job = null) {
  if (job?.status === 'cancelled') return { finalStatus: 'cancelled', stalled: false };
  if (status !== 'done') return { finalStatus: 'error', stalled: isAgentProgressWatchdogAbortError(abortCause) };
  return { finalStatus: abnormalEmptyFinishError(result, agent) ? 'error' : 'idle', stalled: false };
}

export function createWorkerTurns({
  mgr,
  sessionSurface = null,
  upsertWorkerSessionDeferred,
  tagForSession,
  agentWatchdogOverrides,
  notifyStatusChange = () => {},
}) {
  // Idle-progress watchdogs (shared sweep timer) live in agent-watchdog-registry.mjs.
  const progressWatchdogs = createProgressWatchdogRegistry({ mgr });
  // sessionId -> { session, current, claims, started, unobserve }
  const owners = new Map();

  // In-turn progress stamp: the row keeps its live message count and
  // updatedAt from each change the watchdog sweep observes, so a long turn
  // never looks frozen on its start stamp.
  const progressStamper = (session, tag) => {
    let lastSavedAt = 0;
    return (progress = {}) => {
      const messages = Number(progress?.messages) || 0;
      upsertWorkerSessionDeferred(session, tag, {
        status: 'running',
        stage: workerStageForStatus('running', progress.stage),
        ...(messages > 0 ? { messages } : {}),
      });
      // The canonical runtime owns persistence; this session is only its descriptor.
      if (sessionSurface?.canonical === true) return;
      // Mid-turn durability: a pane opened on a running worker reads its
      // in-progress transcript. Throttled; the sweep runs every second.
      const now = Date.now();
      if (now - lastSavedAt < AGENT_PROGRESS_SAVE_MS) return;
      lastSavedAt = now;
      try {
        Promise.resolve(saveSessionAsync(session)).catch(() => {});
      } catch {
        /* progress persistence is best-effort */
      }
    };
  };

  function watchdogPolicyFor(session) {
    const agent = session.agent || null;
    return resolveAgentWatchdogPolicy(
      agent,
      agentWatchdogOverrides({
        agent,
        provider: session.provider,
        model: session.model,
        ...(session.modelParameters ? { modelParameters: session.modelParameters } : {}),
      })
    );
  }

  const sessionOf = (sessionId, owner) => mgr.getSession?.(sessionId) || owner.session;

  function settleRow(sessionId, owner, finalStatus, stalled, job) {
    upsertWorkerSessionDeferred(sessionOf(sessionId, owner), tagForSession(sessionId), {
      ...settledWorkerStatus(finalStatus, stalled, job),
      finishedAt: new Date().toISOString(),
    });
    notifyStatusChange();
  }

  function turnStarted(sessionId, owner, { turnId, startedAt, submissionIds = [] }) {
    // A turn that starts over a current one supersedes it (a replaced
    // runtime's turn unwinding stale): that one's settle is no longer ours.
    owner.current?.watchdog?.stop();
    owner.started += 1;
    const claimId = submissionIds.find((id) => owner.claims.has(id));
    const job = claimId ? owner.claims.get(claimId) : null;
    if (claimId) owner.claims.delete(claimId);
    const session = sessionOf(sessionId, owner);
    const tag = tagForSession(sessionId);
    upsertWorkerSessionDeferred(session, tag, {
      status: 'running',
      stage: 'running',
      // The turn's own task: a restart that ends this turn reports it by id.
      task_id: job?.taskId || null,
      turnStartedAt: new Date(startedAt).toISOString(),
    });
    owner.current = {
      turnId,
      job,
      watchdog: progressWatchdogs.start(sessionId, watchdogPolicyFor(session), session.agent || null, {
        onProgress: progressStamper(session, tag),
      }),
    };
    notifyStatusChange();
  }

  // The turn's model work is over: the progress watchdog, which judges only
  // that, stops here. The row still settles on the turn's real outcome,
  // its cleanup's failure included, when the settlement arrives.
  function turnAskEnded(owner, { turnId }) {
    const turn = owner.current;
    if (!turn || turn.turnId !== turnId) return;
    turn.watchdog?.stop();
    turn.watchdog = null;
  }

  function turnSettled(sessionId, owner, outcome) {
    const turn = owner.current;
    if (!turn || turn.turnId !== outcome.turnId) return;
    owner.current = null;
    turn.watchdog?.stop();
    const { finalStatus, stalled } = settledTurnStatus(outcome, sessionOf(sessionId, owner).agent, turn.job);
    settleRow(sessionId, owner, finalStatus, stalled, turn.job);
  }

  /** Observe `session`'s turns through the route that runs them; null when
   *  that route reports none. */
  function observe(session) {
    const sessionId = session?.id;
    if (!sessionId) return null;
    const existing = owners.get(sessionId);
    if (existing) return existing;
    const canonical = typeof sessionSurface?.runTurn === 'function' && sessionSurface.canRun?.(session) !== false;
    const source = canonical ? sessionSurface : mgr;
    if (typeof source?.observeSessionTurns !== 'function') return null;
    const owner = { session, current: null, claims: new Map(), started: 0, unobserve: null };
    owners.set(sessionId, owner);
    owner.unobserve = source.observeSessionTurns(sessionId, {
      onTurnStart: (turn) => turnStarted(sessionId, owner, turn),
      onTurnAskEnded: (event) => turnAskEnded(owner, event),
      onTurnSettled: (outcome) => turnSettled(sessionId, owner, outcome),
    });
    return owner;
  }

  /** The turn `job` submits on `session`: its submission id, which the route
   *  reports on that turn's start (the turn then carries the job), and
   *  `release(finalStatus)` for the dispatch's end. A dispatch that started
   *  no turn at all (it failed before one opened) settles the row itself. */
  function claim(session, job) {
    const submissionId = `agent-turn-${randomUUID()}`;
    const owner = observe(session);
    if (!owner) return { submissionId, release() {} };
    const startedBefore = owner.started;
    owner.claims.set(submissionId, job);
    return {
      submissionId,
      release(finalStatus) {
        if (!owner.claims.delete(submissionId)) return;
        if (owner.current || owner.started !== startedBefore) return;
        settleRow(session.id, owner, finalStatus, false, job);
      },
    };
  }

  function forget(sessionId) {
    const owner = owners.get(sessionId);
    if (!owner) return;
    owners.delete(sessionId);
    owner.unobserve?.();
    owner.current?.watchdog?.stop();
  }

  // A deleted session runs no further turn.
  const stopPurgeHook = registerSessionPurgeHook(forget);

  return {
    observe,
    claim,
    dispose() {
      stopPurgeHook();
      for (const sessionId of [...owners.keys()]) forget(sessionId);
    },
  };
}
