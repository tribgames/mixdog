/**
 * http-router/lifecycle-routes.mjs — routes that answer before the memory
 * runtime has initialized: client registration, boot-timestamp resets and
 * /health. Keyed by `METHOD /url` for the router's exact-match dispatch.
 */
import { readBody, sendJson, sendError } from '../http-wire.mjs';
import { isBootstrapComplete } from '../memory.mjs';

export function createLifecycleRoutes({
  getDb,
  bootMemoryCodeFingerprint,
  entryStats,
  cycleScheduler,
  getInitialized,
  setBootTimestamp,
  registerClient,
  deregisterClient,
  getDraining,
}) {
  const clientRoute = (register) => async (req, res) => {
    let body = {};
    try {
      body = await readBody(req);
    } catch {}
    const clientPid = Number(body?.clientPid);
    if (register) {
      const accepted = registerClient?.(clientPid);
      if (accepted === false) {
        sendJson(res, { ok: false, draining: true, error: 'memory worker draining' }, 503);
        return;
      }
    } else {
      deregisterClient?.(clientPid);
    }
    sendJson(res, { ok: true });
  };

  const health = async (_req, res) => {
    if (getDraining?.()) {
      sendJson(res, { status: 'draining' }, 503);
      return;
    }
    if (!getInitialized()) {
      sendJson(res, { status: 'starting' }, 503);
      return;
    }
    try {
      const db = getDb();
      const stats = await entryStats();
      const memory = process.memoryUsage();
      sendJson(res, {
        status: 'ok',
        worker_pid: process.pid,
        server_pid: Number(process.env.MIXDOG_SERVER_PID) || null,
        owner_lead_pid: Number(process.env.MIXDOG_OWNER_LEAD_PID) || null,
        code_fingerprint: bootMemoryCodeFingerprint,
        bootstrap: await isBootstrapComplete(db),
        entries: stats.total,
        roots: stats.roots,
        active_roots: stats.active_roots,
        archived_roots: stats.archived_roots,
        unchunked_leaves: stats.unchunked_leaves,
        cycle2_pending_roots: stats.cycle2_pending_roots,
        core_entries: stats.core_entries,
        core_embed_null: stats.core_embed_null,
        cycle_running: cycleScheduler.getCycleRunning(),
        cycle_health: cycleScheduler.getCycleHealth(),
        cycle_backlog: cycleScheduler.getCycleBacklogSnapshot(),
        memory: {
          rssBytes: memory.rss,
          heapTotalBytes: memory.heapTotal,
          heapUsedBytes: memory.heapUsed,
          externalBytes: memory.external,
          arrayBufferBytes: memory.arrayBuffers,
        },
      });
    } catch (e) {
      sendError(res, e.message);
    }
  };

  return {
    'POST /client/register': clientRoute(true),
    'POST /client/deregister': clientRoute(false),
    'POST /session-reset': (_req, res) => {
      const ts = Date.now();
      setBootTimestamp(ts);
      sendJson(res, { ok: true, bootTimestamp: ts });
    },
    'POST /rebind': (_req, res) => {
      setBootTimestamp(Date.now());
      sendJson(res, { ok: true });
    },
    'GET /health': health,
  };
}
