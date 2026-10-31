/**
 * The one idle-time maintenance schedule of a process (the daemon): periodic
 * housekeeping such as the worktree cleanup and the session auto-archive
 * registers here instead of keeping a timer of its own.
 *
 * One unref'd timer ticks every `tickMs`. A tick runs the due tasks one at a
 * time, each only when every registered idle probe reports idle right before
 * it; once a probe reports busy the tick stops and the remaining due tasks
 * wait for a later idle one (never dropped). Idleness here only picks a quiet
 * moment: a task must still guard its own work against activity that starts
 * while it runs (the worktree cleanup holds each folder's workspace admission).
 * A task is due `initialDelayMs` after it registered, then `intervalMs` after
 * its previous run started. A failing task is reported to `onError` and
 * rescheduled like a successful one. Shared through a global symbol, so
 * separately bundled copies of this file use the same schedule.
 */

const STATE_KEY = Symbol.for('mixdog.maintenanceSchedule.v1');
const DEFAULT_TICK_MS = 60_000;

function state() {
  globalThis[STATE_KEY] ??= { tasks: new Map(), probes: new Set(), timer: null, running: null };
  return globalThis[STATE_KEY];
}

/**
 * Register (or replace) the task `name`.
 * @param {string} name
 * @param {() => unknown|Promise<unknown>} run
 * @param {{ intervalMs: number, initialDelayMs?: number, onError?: (error: unknown) => void, now?: number }} options
 * @returns {() => void} Unregister.
 */
export function registerMaintenanceTask(
  name,
  run,
  { intervalMs, initialDelayMs = intervalMs, onError = null, now = Date.now() }
) {
  if (typeof name !== 'string' || !name) throw new TypeError('maintenance task name is required');
  if (typeof run !== 'function') throw new TypeError('maintenance task must be a function');
  if (!(intervalMs > 0)) throw new TypeError('maintenance task intervalMs must be positive');
  const task = { name, run, intervalMs, onError, dueAt: now + Math.max(0, initialDelayMs) };
  state().tasks.set(name, task);
  return () => {
    if (state().tasks.get(name) === task) state().tasks.delete(name);
  };
}

/**
 * Register an idle probe: `() => boolean|Promise<boolean>`, true while the
 * process is idle enough for maintenance. A probe that throws counts as busy.
 * @returns {() => void} Unregister.
 */
export function registerMaintenanceIdleProbe(probe) {
  if (typeof probe !== 'function') throw new TypeError('idle probe must be a function');
  state().probes.add(probe);
  return () => state().probes.delete(probe);
}

async function isIdle() {
  for (const probe of state().probes) {
    try {
      if ((await probe()) !== true) return false;
    } catch {
      return false;
    }
  }
  return true;
}

/**
 * One tick: when idle (or `force`), run each due task (every task with
 * `force`) in registration order. Concurrent calls share the tick under way.
 * @param {{ force?: boolean, now?: number }} [options]
 * @returns {Promise<{ ran: string[], busy: boolean }>}
 */
export function runMaintenanceTasks({ force = false, now = Date.now() } = {}) {
  const current = state();
  if (current.running) return current.running;
  const tick = (async () => {
    const due = [...current.tasks.values()].filter((task) => force || task.dueAt <= now);
    const ran = [];
    for (const task of due) {
      if (current.tasks.get(task.name) !== task) continue;
      // Asked before every task: work that began during an earlier task
      // defers the rest to a later idle tick.
      if (!force && !(await isIdle())) return { ran, busy: true };
      task.dueAt = now + task.intervalMs;
      try {
        await task.run();
      } catch (error) {
        task.onError?.(error);
      }
      ran.push(task.name);
    }
    return { ran, busy: false };
  })();
  current.running = tick.finally(() => {
    current.running = null;
  });
  return current.running;
}

/** Start ticking (idempotent). */
export function startMaintenanceSchedule({ tickMs = DEFAULT_TICK_MS } = {}) {
  const current = state();
  if (current.timer) return;
  current.timer = setInterval(() => void runMaintenanceTasks(), tickMs);
  current.timer.unref?.();
}

/** Stop ticking; registered tasks and probes stay. */
export function stopMaintenanceSchedule() {
  const current = state();
  if (current.timer) clearInterval(current.timer);
  current.timer = null;
}
