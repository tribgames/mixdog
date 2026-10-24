/**
 * One run of an owned automation — a schedule or a webhook endpoint. The run
 * itself is a turn in the owner bot's home thread (routine-home-turn.mjs);
 * the bot's reply there is its result, so nothing is posted besides it. A run
 * whose owner bot does not exist (routine-owner.mjs) never fires: it is
 * skipped as paused, never run elsewhere. A second run of the same automation
 * while one is in flight is skipped (and recorded).
 *
 * Unattended runs (timed fires, received webhooks; not the app's or a chat's
 * "Run now") also back off after consecutive failures (ROUTINE_LIMITS).
 * Runs have no concurrency cap or deadline (user decision).
 *
 * Routine results from before routines ran in the bot's thread may still sit
 * on a routine's record (`result_delivery`): redeliverRoutine and the daemon's
 * recovery queue them into the owner's thread (agent-home-delivery.mjs),
 * never running the routine again.
 */
import { announceRoutineRun, deliverScheduleResult } from './agent-home-delivery.mjs';
import { ROUTINE_LIMITS, routineBackoffRemaining } from '../runtime/shared/routine-limits.mjs';
import { ROUTINE_OWNER_PROBLEMS, routineOwnerProblem } from './routine-owner.mjs';

const DELIVERY_RETRY_MS = 60_000;
const errorText = (error) => error?.message || String(error);
const defaultLog = (line) => process.stderr.write(`mixdog routines: ${line}\n`);

// `${kind}:${name}` of every run in flight in this process: timed fires,
// received webhooks and the app's "Run now" all come through here.
const activeRuns = new Set();

/**
 * Reserve `kind:name` against runs in this process for a rename. Null when a
 * run is in flight; otherwise a release function. The check and the reservation
 * are one synchronous step, and a run that finds the reservation is skipped as
 * an overlap (runOwnedAutomation), so none can start under the name meanwhile.
 * "Run now" takes the same reservation to hold the name from its read of the
 * row through its outcome stamps (runOwnedAutomation `reserved`).
 */
export function beginAutomationRename(kind, name, active = activeRuns) {
  const key = `${kind}:${name}`;
  if (active.has(key)) return null;
  active.add(key);
  return () => active.delete(key);
}

// The PG record of each kind, imported on first use.
const RECORDS = {
  schedule: () =>
    import('../runtime/channels/lib/schedules-db.mjs').then((db) => ({
      state: (name) => db.getSchedule(name),
      list: () => db.listSchedules(),
      recordDelivery: db.recordScheduleDelivery,
    })),
  webhook: () =>
    import('../runtime/channels/lib/webhooks-db.mjs').then((db) => ({
      state: (name) => db.loadEndpointConfig(name),
      list: () => db.listEndpoints(),
      recordDelivery: db.recordEndpointDelivery,
    })),
};
/** `deps` over the kind's PG record for whatever `deps` leaves out. */
async function withRecord(kind, deps) {
  if (deps.state && deps.list && deps.recordDelivery) return deps;
  const record = await RECORDS[kind]();
  return {
    ...deps,
    state: deps.state || record.state,
    list: deps.list || record.list,
    recordDelivery: deps.recordDelivery || record.recordDelivery,
  };
}

let retryArmed = false;
/** One timer for the whole host: re-queue every record's undelivered result. */
function armDeliveryRetry() {
  if (retryArmed) return;
  retryArmed = true;
  setTimeout(() => {
    retryArmed = false;
    recoverRoutineDeliveries().catch((error) => defaultLog(`delivery retry failed: ${errorText(error)}`));
  }, DELIVERY_RETRY_MS).unref?.();
}

/** Show `run`'s live-only row in the owner's home; a failure only logs. */
async function announceRun(announce, row, run, log) {
  try {
    await announce(row, run);
  } catch (error) {
    log(`${run.kind} "${row.name}": run row not shown: ${errorText(error)}`);
  }
}

/** Queue `item` for `row`'s owner; clear the record on success, mark it
 *  'failed' (and arm the retry) when the queue refuses it. */
async function queueResult(row, item, entry, { deliver, recordDelivery, onDeliveryFailed, announce, log }) {
  try {
    await deliver(row, item);
  } catch (error) {
    const message = errorText(error);
    log(`${item.kind} "${row.name}": result could not be queued (${message}); retrying later`);
    await recordDelivery(row.name, item.runId, { ...entry, state: 'failed', error: message }).catch((recordError) =>
      log(`${item.kind} "${row.name}": delivery failure not recorded: ${errorText(recordError)}`)
    );
    // The home's run row turns into "result not delivered" (retry: retryRoutineDelivery).
    await announceRun(announce, row, { ...item, state: 'undelivered' }, log);
    onDeliveryFailed();
    return false;
  }
  // A clear that fails leaves the record 'pending': the next recovery re-queues
  // it, which the queue's run-id key turns into a no-op.
  await recordDelivery(row.name, item.runId, null).catch((error) =>
    log(`${item.kind} "${row.name}": delivered result not cleared: ${errorText(error)}`)
  );
  return true;
}

/**
 * `row` is `{ name, ownerAgentId }`; `run({ signal })` resolves `{ sessionId,
 * result }` (`signal` is the caller's cancellation, if any). Resolves the
 * outcome, or `{ skipped: true, reason: 'owner' | 'overlap' | 'backoff' | 'paused' }`
 * (an owner skip also names `ownerProblem` and its `message`); a failed run
 * rejects. `reserved`: the caller already holds `kind:name` (beginAutomationRename)
 * and releases it itself, so this run neither checks for nor releases it.
 */
export async function runOwnedAutomation(kind, row, run, deps = {}) {
  if (!row?.name) throw new Error(`${kind} run: a ${kind} row is required`);
  const {
    recordSkip = async () => {},
    active = activeRuns,
    limits = ROUTINE_LIMITS,
    attended = false,
    reserved = false,
    signal = null,
    now = Date.now,
    ownerProblem = routineOwnerProblem,
    log = defaultLog,
  } = deps;
  const name = row.name;
  const key = `${kind}:${name}`;
  const skip = async (reason, extra = {}) => {
    await Promise.resolve()
      .then(() => recordSkip(name, new Date(now())))
      .catch((error) => log(`${kind} "${name}": skip record failed: ${errorText(error)}`));
    return { name, skipped: true, reason, sessionId: null, result: '', ...extra };
  };
  // The name is reserved before the owner check, so a rename can neither
  // complete while it waits nor leave this run to start under the old name.
  const overlap = !reserved && active.has(key);
  const holds = !reserved && !overlap;
  if (holds) active.add(key);
  try {
    // A routine runs only in its own bot's thread: without that bot it waits.
    const problem = await Promise.resolve()
      .then(() => ownerProblem(row.ownerAgentId))
      .catch(() => '');
    if (problem) {
      log(`${kind} "${name}": paused, ${ROUTINE_OWNER_PROBLEMS[problem]}`);
      return await skip('owner', { ownerProblem: problem, message: ROUTINE_OWNER_PROBLEMS[problem] });
    }
    if (overlap) return await skip('overlap');
    if (!attended) {
      const record = await withRecord(kind, deps);
      const state = await Promise.resolve()
        .then(() => record.state(name))
        .catch(() => null);
      // Switched off (by the user, or by the failure limit): the cron claim and
      // the webhook handler already refuse it, but a one-shot timer or a
      // dispatch that raced the pause must not run it either.
      if (state?.enabled === false) {
        log(`${kind} "${name}": skipped, switched off`);
        return await skip('paused');
      }
      const wait = routineBackoffRemaining(state, now(), limits);
      if (wait > 0) {
        log(`${kind} "${name}": skipped, backing off ${Math.ceil(wait / 1000)}s after failures in a row`);
        return await skip('backoff');
      }
    }
    return await run({ signal });
  } finally {
    if (holds) active.delete(key);
  }
}

/** Re-queue every result `row`'s record still holds, oldest first; resolves
 *  the errors of the ones the queue still refuses. Never reruns the routine. */
export async function redeliverRoutine(kind, row, deps = {}) {
  const {
    deliver = deliverScheduleResult,
    onDeliveryFailed = armDeliveryRetry,
    announce = announceRoutineRun,
    log = defaultLog,
  } = deps;
  const record = await withRecord(kind, deps);
  const entries = Object.entries(row?.resultDelivery || {}).sort(([, a], [, b]) =>
    String(a?.at).localeCompare(String(b?.at))
  );
  const errors = [];
  for (const [runId, entry] of entries) {
    const result = entry?.result || {};
    const item = {
      runId,
      kind,
      ok: result.ok === true,
      text: result.text || '',
      runSessionId: result.runSessionId,
      reason: result.reason,
      paused: result.paused,
    };
    await queueResult(row, item, entry, {
      ...record,
      deliver,
      announce,
      log,
      onDeliveryFailed: () => errors.push(runId),
    });
  }
  if (errors.length) onDeliveryFailed();
  return errors;
}

/** Daemon start (and the retry timer): re-queue every undelivered result of
 *  every schedule and webhook. Resolves how many runs still wait. Without a
 *  PostgreSQL cluster no routine exists, and none is started for this. */
export async function recoverRoutineDeliveries(depsByKind = null) {
  if (!depsByKind) {
    const [{ pgClusterExists }, { resolvePluginData }] = await Promise.all([
      import('../runtime/memory/lib/pg/adapter.mjs'),
      import('../runtime/shared/plugin-paths.mjs'),
    ]);
    if (!pgClusterExists(resolvePluginData())) return 0;
  }
  let waiting = 0;
  for (const kind of ['schedule', 'webhook']) {
    const deps = await withRecord(kind, depsByKind?.[kind] || {});
    for (const row of await deps.list()) {
      if (row?.resultDelivery && Object.keys(row.resultDelivery).length) {
        waiting += (await redeliverRoutine(kind, row, deps)).length;
      }
    }
  }
  return waiting;
}

/** The app's "retry" on one routine: rejects with the error when still refused. */
export async function retryRoutineDelivery(kind, name, deps = {}) {
  if (kind !== 'schedule' && kind !== 'webhook') throw new Error(`unknown routine kind "${kind}"`);
  const record = await withRecord(kind, deps);
  const row = await record.state(name);
  if (!row) throw new Error(`${kind} "${name}" does not exist`);
  const failed = await redeliverRoutine(kind, row, { ...deps, ...record });
  if (failed.length) {
    const latest = await record.state(name);
    const error = latest?.resultDelivery?.[failed.at(-1)]?.error;
    throw new Error(`"${name}": the result still could not be delivered${error ? ` (${error})` : ''}`);
  }
  return { name, delivered: Object.keys(row.resultDelivery || {}).length };
}
