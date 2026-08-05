// Engine pool hosted by the machine-global engine daemon.
//
// One process owns every live session engine; the terminal TUI and the desktop
// app attach as VIEWS over the transport. That inverts today's model (each
// client boots its own engine and the session store arbitrates ownership with
// generation counters + heartbeat vetoes): with a single writer, cross-client
// editing is just fan-out, and the split-brain guards can never trip against
// our own second client.
//
// The engine factory is injected (`createEngine`) so the daemon entry supplies
// the real createEngineSession while tests supply a stub.
import { randomUUID } from 'node:crypto';

const MAX_CLONE_DEPTH = 24;

/** JSON-safe projection of an engine snapshot. Functions, symbols, and
 *  undefined never survive a transport hop; dropping them here (instead of at
 *  JSON.stringify time) keeps object identity stable for the receiver and
 *  makes cycles impossible rather than fatal. */
export function sanitizeForWire(value, depth = 0, seen = new WeakSet()) {
  if (value === null) return null;
  const type = typeof value;
  if (type === 'string' || type === 'boolean') return value;
  if (type === 'number') return Number.isFinite(value) ? value : null;
  if (type === 'bigint') return Number(value);
  if (type === 'undefined' || type === 'function' || type === 'symbol') return undefined;
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Error) return { name: value.name, message: value.message };
  if (type !== 'object') return undefined;
  if (depth >= MAX_CLONE_DEPTH) return undefined;
  if (seen.has(value)) return undefined;
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      const out = [];
      for (const entry of value) {
        const cloned = sanitizeForWire(entry, depth + 1, seen);
        out.push(cloned === undefined ? null : cloned);
      }
      return out;
    }
    if (value instanceof Map) {
      const out = {};
      for (const [key, entry] of value) {
        const cloned = sanitizeForWire(entry, depth + 1, seen);
        if (cloned !== undefined) out[String(key)] = cloned;
      }
      return out;
    }
    if (value instanceof Set) {
      const out = [];
      for (const entry of value) {
        const cloned = sanitizeForWire(entry, depth + 1, seen);
        if (cloned !== undefined) out.push(cloned);
      }
      return out;
    }
    const out = {};
    for (const [key, entry] of Object.entries(value)) {
      const cloned = sanitizeForWire(entry, depth + 1, seen);
      if (cloned !== undefined) out[key] = cloned;
    }
    return out;
  } finally {
    seen.delete(value);
  }
}

export function createEngineDaemonService({
  createEngine,
  publishIntervalMs = 50,
  onFrame = () => {},
  log = () => {},
} = {}) {
  if (typeof createEngine !== 'function') throw new Error('createEngine is required');

  // engineId -> { engine, cwd, unsubscribe, timer, disposed }
  const engines = new Map();
  let closed = false;

  function record(engineId) {
    const entry = engines.get(engineId);
    if (!entry || entry.disposed) throw new Error(`unknown engine ${engineId}`);
    return entry;
  }

  function snapshotOf(entry) {
    return sanitizeForWire(entry.engine.getState?.() ?? null);
  }

  /** Engine that currently holds a session live. Two engines on one session id
   *  would be the very split-brain the daemon exists to remove, so a resume of
   *  an already-hosted session is answered with an ADOPTION pointer instead of
   *  a second load. */
  function sessionOwner(sessionId) {
    const id = String(sessionId || '');
    if (!id) return null;
    for (const entry of engines.values()) {
      if (entry.disposed) continue;
      if (String(entry.engine.getState?.()?.sessionId || '') === id) return entry.engineId;
    }
    return null;
  }

  // Methods whose first argument is a session id and whose effect is "make this
  // view show that session" — exactly the calls that must converge instead of
  // forking a second engine.
  const ADOPTABLE_METHODS = new Set(['resume', 'resumeSession', 'prefetchSession']);

  function publish(entry) {
    if (closed || entry.disposed) return;
    try {
      onFrame({
        type: 'engine-state',
        key: `engine-state:${entry.engineId}`,
        engineId: entry.engineId,
        snapshot: snapshotOf(entry),
      });
    } catch (err) {
      log(`publish failed engine=${entry.engineId}: ${err?.message || err}`);
    }
  }

  /** Engine events fire per streamed token. Coalescing them on a fixed cadence
   *  (the desktop lane interval) keeps a fast turn from saturating the socket
   *  while still feeling live in both clients. */
  function schedulePublish(entry) {
    if (entry.timer || entry.disposed || closed) return;
    entry.timer = setTimeout(() => {
      entry.timer = null;
      publish(entry);
    }, publishIntervalMs);
    entry.timer.unref?.();
  }

  async function open(params = {}) {
    if (closed) throw new Error('engine daemon service is closed');
    const engineId = randomUUID();
    const engine = await createEngine({
      cwd: params.cwd || process.cwd(),
      provider: params.provider,
      model: params.model,
      toolMode: params.toolMode || 'full',
      remote: params.remote === true,
      desktopSession: params.desktopSession ?? null,
    });
    const entry = { engineId, engine, cwd: params.cwd || process.cwd(), timer: null, disposed: false, unsubscribe: null };
    engines.set(engineId, entry);
    try {
      entry.unsubscribe = engine.subscribe?.(() => schedulePublish(entry)) ?? null;
    } catch (err) {
      log(`subscribe failed engine=${engineId}: ${err?.message || err}`);
    }
    log(`engine opened id=${engineId} cwd=${entry.cwd}`);
    // The opener gets the snapshot inline so its first getState() is never
    // empty; every other attached client learns about it from this frame.
    const snapshot = snapshotOf(entry);
    onFrame({ type: 'engine-state', key: `engine-state:${engineId}`, engineId, snapshot });
    return { engineId, snapshot };
  }

  async function call({ engineId, method, args = [] } = {}) {
    const entry = record(String(engineId || ''));
    const name = String(method || '');
    if (!name || name === 'constructor' || name.startsWith('__')) {
      throw new TypeError(`engine method ${name} is unavailable`);
    }
    if (ADOPTABLE_METHODS.has(name)) {
      const sessionId = String((Array.isArray(args) ? args[0] : '') || '');
      const owner = sessionOwner(sessionId);
      if (owner && owner !== entry.engineId) {
        log(`adopt session=${sessionId} view=${entry.engineId} -> engine=${owner}`);
        return { value: true, adoptEngineId: owner, sessionId };
      }
    }
    const target = entry.engine[name];
    if (typeof target !== 'function') throw new TypeError(`engine method ${name} is unavailable`);
    const value = await target.apply(entry.engine, Array.isArray(args) ? args : []);
    // A mutation is only useful to the other clients once they see it, and the
    // caller's own next getState() reads its local mirror — publish now rather
    // than waiting out the coalescing window.
    publish(entry);
    return { value: sanitizeForWire(value) ?? null };
  }

  async function dispose({ engineId, reason = 'client dispose', keepBackgroundWork = false } = {}) {
    const id = String(engineId || '');
    const entry = engines.get(id);
    if (!entry || entry.disposed) return { ok: true };
    entry.disposed = true;
    if (entry.timer) { clearTimeout(entry.timer); entry.timer = null; }
    try { entry.unsubscribe?.(); } catch {}
    engines.delete(id);
    try { await entry.engine.dispose?.(reason, { keepBackgroundWork }); }
    catch (err) { log(`engine dispose failed id=${id}: ${err?.message || err}`); }
    onFrame({ type: 'engine-gone', key: `engine-state:${id}`, engineId: id, reason });
    log(`engine disposed id=${id} (${reason})`);
    return { ok: true };
  }

  function list() {
    return {
      engines: [...engines.values()].map((entry) => ({
        engineId: entry.engineId,
        cwd: entry.cwd,
        sessionId: String(entry.engine.getState?.()?.sessionId || ''),
      })),
    };
  }

  function snapshot({ engineId } = {}) {
    return { snapshot: snapshotOf(record(String(engineId || ''))) };
  }

  const routes = {
    'engine.open': open,
    'engine.call': call,
    'engine.dispose': dispose,
    'engine.list': async () => list(),
    'engine.snapshot': async (args) => snapshot(args),
  };

  async function handleCall(name, args = {}) {
    const route = routes[String(name || '')];
    if (!route) throw new Error(`unknown engine daemon call ${name}`);
    return route(args || {});
  }

  async function stop(reason = 'service stop') {
    closed = true;
    for (const engineId of [...engines.keys()]) {
      await dispose({ engineId, reason, keepBackgroundWork: false });
    }
  }

  return { handleCall, open, call, dispose, list, snapshot, stop, get size() { return engines.size; } };
}
