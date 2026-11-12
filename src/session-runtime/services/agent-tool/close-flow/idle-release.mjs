// Idle release: an agent idle with its result delivered is parked (its runtime
// released, the agent kept open and listed) after IDLE_RELEASE_MS without a
// send. One timer per idle agent, armed when its row is seen idle and cleared
// when it stops being idle: nothing runs while no agent is idle. A release that
// did not happen (a busy session, a result not delivered yet) is tried again
// one period later.
import { isOpenIdleRow } from '../job-views/agent-list.mjs';
import { clean } from '../helpers.mjs';
import { workerRowTime } from '../worker-rows.mjs';

export const IDLE_RELEASE_MS = 420_000;
const nextTurn = () => new Promise((resolve) => setImmediate(resolve));

/** `release(row)` resolves `{ state }` (close-flow parkIdle). */
export function createIdleRelease({ registry, release }) {
  const timers = new Map(); // sessionId -> timer
  const parked = new Set(); // idle agents whose runtime is already released
  let queue = Promise.resolve();
  let disposed = false;

  const idleRows = () => {
    const rows = new Map();
    for (const row of registry.readWorkerRows({})) {
      if (clean(row.sessionId) && isOpenIdleRow(row)) rows.set(row.sessionId, row);
    }
    return rows;
  };

  function arm(row, delay) {
    if (disposed) return;
    const timer = setTimeout(() => {
      timers.delete(row.sessionId);
      // One at a time, a turn apart: a restart finds every old idle agent due at once.
      queue = queue.then(() => releaseDue(row.sessionId)).then(nextTurn, nextTurn);
    }, delay);
    timer.unref?.();
    timers.set(row.sessionId, timer);
  }

  async function releaseDue(sessionId) {
    // A release queued before the disposal neither runs nor arms a retry.
    if (disposed) return;
    const row = idleRows().get(sessionId);
    if (!row || timers.has(sessionId)) return;
    let state = 'failed';
    try {
      ({ state } = await release(row));
    } catch {
      /* tried again below */
    }
    if (disposed) return;
    if (state === 'parked') parked.add(sessionId);
    else if (state !== 'gone' && idleRows().has(sessionId) && !timers.has(sessionId)) arm(row, IDLE_RELEASE_MS);
  }

  /** Called when the worker rows may have changed. */
  function check() {
    if (disposed) return;
    const idle = idleRows();
    for (const [sessionId, timer] of timers) {
      if (idle.has(sessionId)) continue;
      clearTimeout(timer);
      timers.delete(sessionId);
    }
    // A parked agent that stops being idle (a send resumed it) can be parked again later.
    for (const sessionId of parked) if (!idle.has(sessionId)) parked.delete(sessionId);
    for (const [sessionId, row] of idle) {
      if (timers.has(sessionId) || parked.has(sessionId)) continue;
      arm(row, Math.max(0, IDLE_RELEASE_MS - (Date.now() - workerRowTime(row))));
    }
  }

  function dispose() {
    disposed = true;
    for (const timer of timers.values()) clearTimeout(timer);
    timers.clear();
    parked.clear();
  }

  return { check, dispose };
}
