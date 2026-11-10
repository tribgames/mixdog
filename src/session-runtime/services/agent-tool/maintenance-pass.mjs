// agent-tool/maintenance-pass.mjs
// The process-wide agent bookkeeping pass: restart-failure sweeps, stale and
// aged-out worker-row reaping and the tag-map reconciliation that loads
// session records. A daemon runs one agent tool per Lead session plus its
// canonical one; their status reads (a 2 s pulse each) stay in memory, and
// this one pass does the work for all of them.
//
// Nothing re-runs it on a clock in case something changed. It runs on events
// (an agent started or finished, the worker index or a session record
// changed, a session was deleted, a session holding a due row went idle),
// coalesced, and at the one moment time itself decides: the earliest deadline
// any task reports (a row aging out), on a single timer re-armed after every
// pass. A deadline that passed while the pass ran (after it began) belongs to
// no step that already looked, so the next pass starts at once; one due
// before the pass began was looked at by it, and what still stands there
// (a row held by live work) waits for the event that ends that work.
//
// A task returns its steps (one per status scope, say). Every step runs in a
// macrotask of its own, so a pass over many scopes never holds the loop for
// longer than its largest step, and a step that throws skips nothing else.

// Coalesces the events of a fanout (every worker of a spawn starting) into one pass.
export const MAINTENANCE_EVENT_DELAY_MS = 1_000;
// setTimeout's largest delay; a later deadline is re-armed when this fires.
const MAX_TIMER_MS = 2 ** 31 - 1;

const tasks = new Map(); // steps() -> nextDeadline(since) (ms, Infinity for none)
let deadlineTimer = null;
let eventTimer = null;
let running = null;
let again = false;
let lastPassStart = 0;

const nextTurn = () => new Promise((resolve) => setImmediate(resolve));

function report(error) {
  process.stderr.write(`[agent-tool] maintenance step failed: ${error?.message || error}\n`);
}

async function runPass() {
  for (const task of [...tasks.keys()]) {
    if (!tasks.has(task)) continue;
    let steps = [];
    try {
      steps = [...task()];
    } catch (error) {
      report(error);
      continue;
    }
    for (const step of steps) {
      await nextTurn();
      // An unregistered task (its tool was disposed) stops between steps.
      if (!tasks.has(task)) break;
      try {
        step();
      } catch (error) {
        report(error);
      }
    }
  }
}

/** Starts a pass over every registered task (one already running runs again
 *  once it ends); resolves when no pass is left to run. */
export function runAgentMaintenancePass() {
  if (eventTimer) {
    clearTimeout(eventTimer);
    eventTimer = null;
  }
  if (running) {
    again = true;
    return running;
  }
  running = (async () => {
    do {
      again = false;
      lastPassStart = Date.now();
      await runPass();
    } while (again);
  })().finally(() => {
    running = null;
    armDeadline();
  });
  return running;
}

// The single timer: the earliest deadline of every task after the last pass
// began. One already passed runs the next pass now.
function armDeadline() {
  if (deadlineTimer) clearTimeout(deadlineTimer);
  deadlineTimer = null;
  const since = lastPassStart;
  let next = Infinity;
  for (const nextDeadline of tasks.values()) {
    let due = Infinity;
    try {
      due = nextDeadline(since);
    } catch (error) {
      report(error);
    }
    if (due > since && due < next) next = due;
  }
  if (next === Infinity) return;
  const now = Date.now();
  if (next <= now) {
    void runAgentMaintenancePass();
    return;
  }
  deadlineTimer = setTimeout(
    () => {
      deadlineTimer = null;
      if (Date.now() >= next) void runAgentMaintenancePass();
      else armDeadline();
    },
    Math.min(next - now, MAX_TIMER_MS)
  );
  deadlineTimer.unref?.();
}

/** Resolves once the pass in progress, if any, has finished. */
export function agentMaintenanceSettled() {
  return running ?? Promise.resolve();
}

/** A relevant event (an agent started, finished or was cancelled): one pass
 *  soon, however many events arrive meanwhile. */
export function requestAgentMaintenance() {
  if (eventTimer || tasks.size === 0) return;
  eventTimer = setTimeout(runAgentMaintenancePass, MAINTENANCE_EVENT_DELAY_MS);
  eventTimer.unref?.();
}

/** `task()` is asked for its steps on every pass, and `nextDeadline(since)`
 *  for the next moment after `since` (when the last pass began) its work
 *  comes due by time alone, until the returned unregister is called. */
export function registerAgentMaintenance(task, nextDeadline = () => Infinity) {
  tasks.set(task, nextDeadline);
  let registered = true;
  return () => {
    if (!registered) return;
    registered = false;
    tasks.delete(task);
    if (tasks.size > 0) return;
    if (deadlineTimer) clearTimeout(deadlineTimer);
    deadlineTimer = null;
    if (eventTimer) clearTimeout(eventTimer);
    eventTimer = null;
  };
}
