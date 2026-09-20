/**
 * http-router/admin-routes.mjs — the /admin/* surface: entry and curated
 * core-memory listing/mutation, backfill, purge, trace recording and
 * shutdown. Every route runs after the runtime-ready gate.
 */
import { readBody, sendJson, normalizeCoreProjectId } from '../http-wire.mjs';
import { listCore, addCore, deleteCore } from '../core-memory-store.mjs';
import { openTraceDatabase, insertAgentCalls, enqueueTraceEvents, registerTraceExitDrain } from '../trace-store.mjs';

// One admin route: any thrown error becomes `{ ok:false, error }` 500.
const guarded = (handle) => async (req, res) => {
  try {
    await handle(req, res);
  } catch (e) {
    sendJson(res, { ok: false, error: e.message }, 500);
  }
};

export function createAdminRoutes({
  getDb,
  dataDir,
  log,
  handleMemoryAction,
  stop,
  getTraceDb,
  setTraceDb,
  refreshCoreMemoryFile,
}) {
  // Explicit curated mutations republish the session-injection snapshot.
  async function republishCoreSnapshot(reason) {
    if (typeof refreshCoreMemoryFile !== 'function') return;
    try {
      await refreshCoreMemoryFile(reason);
    } catch {}
  }

  const activeEntries = guarded(async (_req, res) => {
    const db = getDb();
    const { rows } = await db.query(`
          SELECT id, element, category, summary, score, last_seen_at
          FROM entries
          WHERE is_root = 1 AND status = 'active'
          ORDER BY score DESC
        `);
    sendJson(res, { ok: true, items: rows });
  });

  const listCoreEntries = guarded(async (_req, res) => {
    const rows = await listCore(dataDir, '*');
    sendJson(res, { ok: true, items: rows });
  });

  const addCoreEntry = guarded(async (req, res) => {
    const body = await readBody(req);
    const projectId = normalizeCoreProjectId(body.project_id);
    const entry = await addCore(dataDir, body, projectId);
    await republishCoreSnapshot('admin-core-add');
    sendJson(res, { ok: true, item: entry });
  });

  const deleteCoreEntry = guarded(async (req, res) => {
    const body = await readBody(req);
    const removed = await deleteCore(dataDir, body.id);
    await republishCoreSnapshot('admin-core-delete');
    sendJson(res, { ok: true, item: removed });
  });

  const addEntry = guarded(async (req, res) => {
    const body = await readBody(req);
    const result = await handleMemoryAction({
      action: 'manage',
      op: 'add',
      element: body.element,
      summary: body.summary,
      category: body.category,
      cwd: body.cwd,
    });
    if (result.isError) {
      sendJson(res, { ok: false, error: result.text }, 400);
      return;
    }
    const idMatch = String(result.text || '').match(/id=(\d+)/);
    const newId = idMatch ? Number(idMatch[1]) : null;
    sendJson(res, { ok: true, id: newId, text: result.text });
  });

  const backfill = async (req, res) => {
    let body;
    try {
      body = await readBody(req);
    } catch (e) {
      sendJson(res, { ok: false, error: e.message }, Number(e?.statusCode) || 500);
      return;
    }
    try {
      const result = await handleMemoryAction({
        action: 'backfill',
        window: body.window,
        scope: body.scope,
        limit: body.limit,
      });
      if (result.isError) {
        // 'backfill already in progress' → 409, other failures → 500
        const status = result.text === 'backfill already in progress' ? 409 : 500;
        sendJson(res, { ok: false, error: result.text }, status);
        return;
      }
      sendJson(res, { ok: true, text: result.text });
    } catch (e) {
      sendJson(res, { ok: false, error: e.message }, 500);
    }
  };

  const purge = guarded(async (req, res) => {
    const db = getDb();
    const body = await readBody(req);
    if (body?.confirm !== 'DELETE ALL MEMORY') {
      sendJson(res, { ok: false, error: 'confirm must be exactly "DELETE ALL MEMORY"' }, 400);
      return;
    }
    const { rows: countRows } = await db.query(`SELECT COUNT(*) AS c FROM entries`);
    const preCount = Number(countRows[0].c);
    const { rows: coreCountRows } = await db.query(`SELECT COUNT(*) AS c FROM core_entries`);
    const coreCount = Number(coreCountRows[0].c);
    await db.transaction(async (tx) => {
      await tx.query(`DELETE FROM entries`);
    });
    sendJson(res, { ok: true, deleted: preCount, core_preserved: coreCount });
  });

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

  const shutdown = (_req, res) => {
    sendJson(res, { shutting_down: true }, 202);
    setImmediate(() => {
      const watchdog = setTimeout(() => {
        log('[shutdown] watchdog fired — forcing exit after 8s\n');
        process.exit(1);
      }, 8000);
      watchdog.unref?.();
      stop()
        .then(() => {
          clearTimeout(watchdog);
          process.exit(0);
        })
        .catch((e) => {
          log(`[shutdown] error ${e.message}\n`);
          clearTimeout(watchdog);
          process.exit(1);
        });
    });
  };

  return {
    'GET /admin/entries/active': activeEntries,
    'GET /admin/core/entries': listCoreEntries,
    'POST /admin/core/entries': addCoreEntry,
    'POST /admin/core/entries/delete': deleteCoreEntry,
    'POST /admin/entries/add': addEntry,
    'POST /admin/backfill': backfill,
    'POST /admin/purge': purge,
    'POST /admin/trace-record': traceRecord,
    'POST /admin/shutdown': shutdown,
  };
}
