/**
 * agent-tool/spawn-flow/deferred-spawn.mjs — a spawn that runs entirely
 * inside its job: prep under an internal deadline (a late-arriving prepared
 * session is torn down, never leaked as a colliding tag), the worker row
 * flip to running, and the cancellation checks around the turn.
 */
import { nonNegativeInt, clearAgentStatuslineRoute } from '../helpers.mjs';

export function createDeferredSpawn({
  mgr,
  forgetTerminalSession,
  pendingSpawnMeta,
  preparedSpawnMeta,
  mergeJobMeta,
  upsertWorkerSessionDeferred,
  notifyStatusChange = () => {},
  DEFAULT_SPAWN_PREP_TIMEOUT_MS,
  startJob,
  prepareSpawn,
  runSpawn,
}) {
  function closePreparedSpawn(prepared, reason = 'agent-task-cancel') {
    if (!prepared?.session?.id) return;
    try {
      Promise.resolve(mgr.closeSession(prepared.session.id, reason)).catch(() => {});
    } catch {}
    try {
      clearAgentStatuslineRoute(prepared.session.id);
    } catch {}
    forgetTerminalSession(prepared.tag, prepared.session.id);
  }

  // prepareSpawn (ensureProvider/prepareAgentSession) runs before runSpawn
  // installs its progress watchdog, so prep is guarded by an internal
  // env-backed cap rather than per-call timeout knobs on the agent tool
  // surface. If prep wins the race its result is used. If the timeout wins,
  // the prepareSpawn promise may still resolve later with a fully-built
  // session/tag/route — a cleanup tears that late prepared down, otherwise
  // the orphaned tag would collide on re-spawn.
  async function prepareWithDeadline(args, callerCwd, context, prepDeadlineMs) {
    const prepState = { timedOut: false };
    if (!(prepDeadlineMs > 0)) return prepareSpawn(args, callerCwd, context, prepState);
    let prepTimer = null;
    let timedOut = false;
    const prepPromise = prepareSpawn(args, callerCwd, context, prepState);
    prepPromise.then(
      (late) => {
        if (timedOut) closePreparedSpawn(late, 'agent-spawn-prep-timeout');
      },
      () => {}
    );
    const timeout = new Promise((_resolve, reject) => {
      prepTimer = setTimeout(() => {
        timedOut = true;
        prepState.timedOut = true;
        reject(new Error(`agent spawn prep timed out (${prepDeadlineMs}ms) before model request`));
      }, prepDeadlineMs);
      prepTimer.unref?.();
    });
    try {
      return await Promise.race([prepPromise, timeout]);
    } finally {
      if (prepTimer) clearTimeout(prepTimer);
    }
  }

  function startDeferredSpawnJob(args, callerCwd, context, notifyContext, extras = {}) {
    return startJob(
      'spawn',
      pendingSpawnMeta(args, extras),
      async (job, ownerNotifyContext) => {
        if (job?.status === 'cancelled') return null;
        const prepDeadlineMs =
          nonNegativeInt(args.spawnPrepTimeoutMs ?? args.prepTimeoutMs) ?? DEFAULT_SPAWN_PREP_TIMEOUT_MS;
        const prepared = await prepareWithDeadline(args, callerCwd, context, prepDeadlineMs);
        mergeJobMeta(job, preparedSpawnMeta(prepared, extras));
        upsertWorkerSessionDeferred(prepared.session, prepared.tag, {
          ...preparedSpawnMeta(prepared, extras),
          status: 'running',
          stage: 'running',
          task_id: job.taskId,
          startedAt: job.startedAt,
          turnStartedAt: new Date().toISOString(),
        });
        notifyStatusChange();
        if (job?.status === 'cancelled') {
          closePreparedSpawn(prepared);
          return null;
        }
        return await runSpawn(prepared, ownerNotifyContext, job);
      },
      notifyContext
    );
  }

  return { closePreparedSpawn, startDeferredSpawnJob };
}
