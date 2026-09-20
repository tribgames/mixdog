import fs from 'node:fs';

const BACKLOG_WARN_COOLDOWN_MS = 10 * 60_000;
const BACKLOG_WARN_FAILURES = 5;

// Cycle health ledger: per-cycle success/failure counters, the "running"
// marker and the backlog snapshot, mirrored to the run-state file that the
// statusline and /health read.
export function createCycleHealthLedger({ cycleStateFile, log }) {
  const health = {
    cycle1: { last_success_at: 0, last_error_at: 0, last_error: null, consecutive_failures: 0 },
    cycle2: { last_success_at: 0, last_error_at: 0, last_error: null, consecutive_failures: 0 },
  };
  let running = null; // { cycle, started_at, pid }
  let backlog = { unchunked: 0, cycle2_pending: 0, at: 0 };
  let lastWarnAt = 0;

  function write() {
    try {
      fs.writeFileSync(cycleStateFile, JSON.stringify({ running, backlog, cycles: health, updatedAt: Date.now() }));
    } catch {
      /* best-effort; statusline just shows nothing */
    }
  }

  function warn(msg) {
    const now = Date.now();
    if (now - lastWarnAt < BACKLOG_WARN_COOLDOWN_MS) return;
    lastWarnAt = now;
    log(`[cycle-health] WARN ${msg}\n`);
  }

  function markRunning(cycle) {
    // pid lets the statusline drop a phantom "running" marker as soon as
    // this daemon dies mid-cycle, instead of waiting out the stale guard.
    running = { cycle, started_at: Date.now(), pid: process.pid };
    write();
  }

  function markDone(cycle, ok, err = null) {
    const h = health[cycle];
    if (h) {
      const now = Date.now();
      if (ok) {
        h.last_success_at = now;
        h.consecutive_failures = 0;
        h.last_error = null;
      } else {
        h.last_error_at = now;
        h.consecutive_failures += 1;
        h.last_error = String(err || 'unknown').slice(0, 200);
      }
      if (!ok && h.consecutive_failures >= BACKLOG_WARN_FAILURES) {
        warn(`${cycle} failing repeatedly (consecutive=${h.consecutive_failures}, last="${h.last_error}")`);
      }
    }
    if (running?.cycle === cycle) running = null;
    write();
  }

  // Drop the running marker only while it still belongs to this cycle.
  function clearRunning(cycle) {
    if (running?.cycle !== cycle) return;
    running = null;
    write();
  }

  function setBacklog(snapshot) {
    backlog = snapshot;
    write();
  }

  // Restart hydration: without it a restart re-inits last_success_at=0 and the
  // state file reports 0 until the next run.
  function hydrateSuccess(last) {
    if (last?.cycle1 > 0 && !health.cycle1.last_success_at) health.cycle1.last_success_at = last.cycle1;
    if (last?.cycle2 > 0 && !health.cycle2.last_success_at) health.cycle2.last_success_at = last.cycle2;
    write();
  }

  return {
    health,
    getRunning: () => running,
    getBacklog: () => backlog,
    write,
    warn,
    markRunning,
    markDone,
    clearRunning,
    setBacklog,
    hydrateSuccess,
    resetRunning: () => {
      running = null;
    },
  };
}
