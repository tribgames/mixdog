// Time budget of an in-tree daemon's stop, shared by the launcher that waits
// for it (desktop quit) and the daemon that has to finish inside it.

/** How long a launcher waits for an in-tree daemon to exit after asking it to
 *  stop. Past this the launcher exits and the daemon dies with its process
 *  tree — on Windows without any exit hook. A healthy daemon stop (PostgreSQL
 *  included) measures ~0.6 s; the rest is room for a slow teardown to finish
 *  its writes. The desktop window is hidden before this wait begins. */
export const IN_TREE_DAEMON_STOP_GRACE_MS = 5_000;

/** `pg_ctl stop` spawn + signal delivery. Once signalled, the postmaster
 *  finishes its shutdown on its own even if the daemon is then killed. */
const PG_STOP_SIGNAL_MARGIN_MS = 800;

/** Fallback point (from shutdown start) at which the daemon stops PostgreSQL
 *  even while earlier teardown steps still run: just before the launcher's
 *  kill, so a slow-but-healthy teardown keeps its writes until then. */
export const PG_FORCED_STOP_AT_MS = IN_TREE_DAEMON_STOP_GRACE_MS - PG_STOP_SIGNAL_MARGIN_MS;
