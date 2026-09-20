// HTTP request router.
//
// Owns the memory service's HTTP surface. The loopback Host/Origin policy is
// applied once, before every route, so DNS rebinding cannot exfiltrate even
// read-only admin/core-memory responses; then exact `METHOD /url` dispatch
// in three stages: lifecycle routes that answer before the runtime is
// initialized (http-router/lifecycle-routes), the runtime-ready gate, the
// admin / session-start / tool-call routes, the /mcp bridge, and the
// POST-only ingest tail. Live DB handle, data dir, the cycle scheduler,
// lifecycle getters, trace-DB slot, and the action/tool handlers are
// injected so the facade keeps ownership of `db`, `_traceDb`,
// `_bootTimestamp`, and the init/stop lifecycle.

import { sendJson, isLocalOrigin } from './http-wire.mjs';
import { createLifecycleRoutes } from './http-router/lifecycle-routes.mjs';
import { createAdminRoutes } from './http-router/admin-routes.mjs';
import { createSessionRoutes } from './http-router/session-routes.mjs';
import { createToolRoutes } from './http-router/tool-routes.mjs';
import { createMcpRoute } from './http-router/mcp-route.mjs';
import { createIngestHandler } from './http-router/ingest-routes.mjs';

export function createHttpRouter(deps) {
  const { touchDaemonIdleTimer, getInitialized, getInitPromise } = deps;
  const lifecycle = createLifecycleRoutes(deps);
  const session = createSessionRoutes(deps);
  const ready = {
    ...createAdminRoutes(deps),
    ...session.routes,
    ...createToolRoutes(deps),
  };
  const mcp = createMcpRoute(deps);
  const ingest = createIngestHandler(deps);

  async function awaitRuntimeReadyForHttp(res) {
    if (getInitialized()) return true;
    const initPromise = getInitPromise();
    if (!initPromise) {
      sendJson(res, { error: 'memory runtime is starting' }, 503);
      return false;
    }
    try {
      await initPromise;
      return true;
    } catch (e) {
      sendJson(res, { error: `memory runtime failed: ${e?.message || e}` }, 503);
      return false;
    }
  }

  const requestHandler = async (req, res) => {
    if (!isLocalOrigin(req)) {
      sendJson(res, { ok: false, error: 'forbidden: non-local request' }, 403);
      return;
    }
    touchDaemonIdleTimer?.(`${req.method || 'HTTP'} ${req.url || '/'}`);
    const key = `${req.method} ${req.url}`;
    const early = lifecycle[key];
    if (early) {
      await early(req, res);
      return;
    }
    if (!(await awaitRuntimeReadyForHttp(res))) return;
    const route = ready[key];
    if (route) {
      await route(req, res);
      return;
    }
    if (req.url === '/mcp') {
      await mcp.handle(req, res);
      return;
    }
    await ingest(req, res);
  };

  return {
    requestHandler,
    buildSessionCoreMemoryPayload: session.buildSessionCoreMemoryPayload,
    createHttpMcpServer: mcp.createHttpMcpServer,
  };
}
