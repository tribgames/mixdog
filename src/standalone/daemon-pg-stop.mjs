// The daemon's PostgreSQL stop inside its shutdown. The normal teardown stops
// PostgreSQL after every user of it has closed, letting durable writes still in
// flight commit first; a fallback timer stops it regardless just before the
// launcher's kill (PG_FORCED_STOP_AT_MS), because a daemon killed before
// `pg_ctl stop` leaves the daemonized postmaster running.
import { PG_FORCED_STOP_AT_MS } from './daemon-stop-budget.mjs';

const ADAPTER = '../runtime/memory/lib/pg/adapter.mjs';

/**
 * Arm at shutdown start. `finish()` is the ordered teardown step: it drains
 * durable writes until the fallback point, then stops. Idempotent: whichever
 * of finish/fallback comes first runs the one stop; the other joins it.
 */
export function createDaemonPgStop({
  log,
  stopTimeoutMs,
  forcedStopAtMs = PG_FORCED_STOP_AT_MS,
  loadAdapter = () => import(ADAPTER),
}) {
  const startedAt = Date.now();
  let stopping = null;
  // The drain budget is what remains until the fallback point once the adapter
  // has loaded, so a slow load never stretches the drain past that point.
  const drainBudget = () => Math.max(0, startedAt + forcedStopAtMs - Date.now());
  const run = (drain) => {
    stopping ??= loadAdapter()
      .then(({ shutdownOwnedPg }) => shutdownOwnedPg({ timeoutMs: stopTimeoutMs, drainMs: drain ? drainBudget() : 0 }))
      .then(
        (stopped) => {
          if (stopped) log('postgres stopped');
        },
        (e) => log(`postgres stop failed: ${e?.message || e}`)
      );
    return stopping;
  };
  const fallback = setTimeout(() => {
    if (stopping) return; // the ordered stop is draining; its bound is this same point
    log(`teardown still running ${forcedStopAtMs}ms into shutdown; stopping postgres before the launcher's kill`);
    void run(false);
  }, forcedStopAtMs);
  fallback.unref?.();
  return {
    finish() {
      clearTimeout(fallback);
      return run(true);
    },
  };
}
