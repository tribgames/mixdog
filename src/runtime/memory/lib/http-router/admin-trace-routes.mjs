/**
 * http-router/admin-trace-routes.mjs — the /admin/trace-record surface: the
 * trace database opened lazily on the first record (and left null when tracing
 * is disabled for this data dir), the request validation and batch size cap,
 * the async batched enqueue, and the fire-and-forget agent-analytics insert.
 *
 * The database handle itself belongs to the server, which passes the
 * getTraceDb/setTraceDb accessors, so the exit drain is registered once.
 */
import { readBody, sendJson } from '../http-wire.mjs';
import { openTraceDatabase, insertAgentCalls, enqueueTraceEvents, registerTraceExitDrain } from '../trace-store.mjs';

export function createAdminTraceRoutes({ dataDir, log, getTraceDb, setTraceDb }) {
  // The trace DB opens lazily on the first record; null means tracing is
  // disabled for this data dir.
  const openTraceDb = async () => {
    const existing = getTraceDb();
    if (existing) return existing;
    const traceDb = await openTraceDatabase(dataDir);
    if (!traceDb) return null;
    setTraceDb(traceDb);
    registerTraceExitDrain(traceDb);
    return traceDb;
  };
  const traceRecord = async (req, res) => {
    let body;
    try {
      body = await readBody(req);
    } catch (e) {
      sendJson(res, { ok: false, error: e.message }, 400);
      return;
    }
    if (!Array.isArray(body?.events)) {
      sendJson(res, { ok: false, error: 'body.events must be an array' }, 400);
      return;
    }
    if (body.events.length > 500) {
      sendJson(res, { ok: false, error: 'too many events (max 500)' }, 413);
      return;
    }
    let traceDb;
    try {
      traceDb = await openTraceDb();
    } catch (e) {
      sendJson(res, { ok: false, error: `trace DB unavailable: ${e.message}` }, 503);
      return;
    }
    if (!traceDb) {
      sendJson(res, { ok: true, queued: 0, disabled: true });
      return;
    }
    try {
      // Enqueue for async batched flush (100ms / 500-row window).
      enqueueTraceEvents(traceDb, body.events);
      // Use `queued` — events are async; `inserted` would imply durability.
      sendJson(res, { ok: true, queued: body.events.length });
      // Fire-and-forget into focused agent analytic tables.
      insertAgentCalls(traceDb, body.events).catch((e) => log(`[trace] insertAgentCalls error: ${e?.message}\n`));
    } catch (e) {
      sendJson(res, { ok: false, error: e.message }, 500);
    }
  };

  return { 'POST /admin/trace-record': traceRecord };
}
