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
  idleEvictMs = null,
  evictSweepMs = null,
} = {}) {
  if (typeof createEngine !== 'function') throw new Error('createEngine is required');

  // engineId -> { engine, cwd, unsubscribe, timer, disposed }
  const engines = new Map();
  let closed = false;
  // A turn belongs to the DAEMON, not to whoever is watching it: closing the
  // desktop window or restarting the TUI must never interrupt work. An engine
  // whose last view left is RETAINED while it is busy and evicted only after it
  // has been idle and unwatched for this long. With a view release no longer
  // destroying anything, this sweep is the ONLY reclaim path besides shutdown.
  const IDLE_EVICT_MS = Number(idleEvictMs) > 0
    ? Number(idleEvictMs)
    : Math.max(60_000, Number(process.env.MIXDOG_ENGINE_IDLE_EVICT_MS) || 15 * 60_000);
  const EVICT_SWEEP_MS = Number(evictSweepMs) > 0 ? Number(evictSweepMs) : 30_000;
  let evictTimer = null;

  function record(engineId) {
    const entry = engines.get(engineId);
    if (!entry || entry.disposed) throw new Error(`unknown engine ${engineId}`);
    // Any touch means a view is back on this engine.
    entry.retainedAt = null;
    // …and a watched engine is no longer the daemon's own headless load.
    entry.headless = false;
    return entry;
  }

  // ── Cross-client viewers ────────────────────────────────────────────────────
  // An engine is shared by construction (terminal + desktop converge on one
  // engine per session), but each client process only refcounts the mirrors it
  // holds ITSELF. Without a daemon-side viewer set, the first client to quit
  // destroyed an engine the other one was still streaming — the turn cut out
  // mid-answer and the surviving view stalled. Viewers are keyed by daemon
  // CLIENT token, so "the last view left" is a machine-wide fact.
  function viewerToken(ctx) {
    return ctx && ctx.clientToken ? String(ctx.clientToken) : '';
  }

  function addViewer(entry, ctx) {
    const token = viewerToken(ctx);
    if (!entry || !token) return entry;
    (entry.viewers ??= new Set()).add(token);
    entry.retainedAt = null;
    entry.headless = false;
    return entry;
  }

  /** A client that deregistered (or whose process died) stops being a viewer.
   *  Its engines are never destroyed here: work outlives the client that
   *  walked away, so an engine nobody watches goes back on the idle clock. */
  function releaseClient(clientToken) {
    const token = String(clientToken || '');
    if (!token) return { ok: true };
    for (const entry of engines.values()) {
      if (!entry.viewers?.delete(token)) continue;
      if (entry.viewers.size > 0) continue;
      entry.retainedAt = Date.now();
      startEvictionSweep();
      log(`engine ${entry.engineId} unwatched (client ${token} gone) — retained`);
    }
    return { ok: true };
  }

  /** Entry lookup that does NOT count as a view touch (session routing reads
   *  it while deciding whether the engine is still unwatched). */
  function entryById(engineId) {
    const entry = engines.get(String(engineId || ''));
    if (!entry || entry.disposed) throw new Error(`unknown engine ${engineId}`);
    return entry;
  }

  function engineBusy(entry) {
    try {
      const state = entry.engine.getState?.() || {};
      return state.busy === true || state.commandBusy === true
        || (Array.isArray(state.queued) && state.queued.length > 0);
    } catch {
      // An engine we cannot read is never assumed idle — losing a live turn is
      // far worse than holding an extra process for one sweep.
      return true;
    }
  }

  function startEvictionSweep() {
    if (evictTimer || closed) return;
    evictTimer = setInterval(() => {
      const now = Date.now();
      for (const entry of [...engines.values()]) {
        if (!entry.retainedAt) continue;
        // A client came back to it: watched engines are never reclaimed.
        if (entry.viewers?.size > 0) { entry.retainedAt = null; continue; }
        if (engineBusy(entry)) { entry.retainedAt = now; continue; }
        if (now - entry.retainedAt < IDLE_EVICT_MS) continue;
        void destroy(entry, 'idle and unwatched');
      }
    }, EVICT_SWEEP_MS);
    evictTimer.unref?.();
  }

  function snapshotOf(entry) {
    const raw = entry.engine.getState?.() ?? null;
    // Store states are immutable snapshots (every mutation makes a new object),
    // so identity is a sound cache key. Without this the whole transcript was
    // re-sanitized on every call AND every published frame.
    if (raw && entry.snapshotSource === raw) return entry.snapshotCache;
    const cloned = projectState(entry, raw);
    entry.snapshotSource = raw;
    entry.snapshotCache = cloned;
    return cloned;
  }

  /** Per-FIELD sanitize cache. Transcript items are immutable once settled, so
   *  reusing their wire clones keeps object identity stable — which is what
   *  makes the frame delta below a reference comparison instead of a deep diff.
   */
  function projectState(entry, raw) {
    if (!raw || typeof raw !== 'object') return sanitizeForWire(raw);
    const fields = entry.fieldCache ??= new Map();
    const items = entry.itemCache ??= new Map();
    const out = {};
    for (const [key, value] of Object.entries(raw)) {
      if (key === 'items' && Array.isArray(value)) {
        const nextItems = new Map();
        out.items = value.map((item) => {
          const cached = items.get(item);
          if (cached !== undefined) { nextItems.set(item, cached); return cached; }
          const cloned = sanitizeForWire(item);
          nextItems.set(item, cloned);
          return cloned;
        });
        entry.itemCache = nextItems;
        continue;
      }
      const cached = fields.get(key);
      if (cached && cached.source === value) { out[key] = cached.value; continue; }
      const cloned = sanitizeForWire(value);
      if (cloned === undefined) continue;
      fields.set(key, { source: value, value: cloned });
      out[key] = cloned;
    }
    return out;
  }

  /** Frame delta. A streaming turn appends to `items` and touches a couple of
   *  scalars; sending the whole snapshot each time cost ~1MB per frame on a
   *  2k-item transcript. Null means "no cheap delta — send the full state". */
  function diffSnapshots(previous, next) {
    if (!previous || !next || typeof previous !== 'object' || typeof next !== 'object') return null;
    const set = {};
    const remove = [];
    let itemsAppend = null;
    for (const [key, value] of Object.entries(next)) {
      if (previous[key] === value) continue;
      if (key === 'items' && Array.isArray(value) && Array.isArray(previous.items)
        && value.length >= previous.items.length
        && previous.items.every((item, index) => item === value[index])) {
        if (value.length > previous.items.length) {
          itemsAppend = { from: previous.items.length, values: value.slice(previous.items.length) };
        }
        continue;
      }
      set[key] = value;
    }
    for (const key of Object.keys(previous)) {
      if (!(key in next)) remove.push(key);
    }
    return { set, remove, itemsAppend };
  }

  /** Advance the engine's published revision one step. */
  function advance(entry) {
    const snapshot = snapshotOf(entry);
    const previous = entry.publishedSnapshot;
    const previousRevision = entry.revision || 0;
    if (snapshot === previous) {
      return { changed: false, snapshot, revision: previousRevision, previousRevision, patch: null };
    }
    entry.publishedSnapshot = snapshot;
    entry.revision = previousRevision + 1;
    return {
      changed: true,
      snapshot,
      revision: entry.revision,
      previousRevision,
      patch: previous ? diffSnapshots(previous, snapshot) : null,
    };
  }

  /** Broadcast body: every attached view is, by construction, at the previous
   *  revision — one that is not resyncs itself off the revision gap. */
  function frameBody(step) {
    return step.patch
      ? { revision: step.revision, baseRevision: step.previousRevision, patch: step.patch }
      : { revision: step.revision, full: step.snapshot };
  }

  /** Response body for the CALLER, which announced the revision it holds. */
  function bodyForClient(step, baseRevision) {
    if (!step.changed && baseRevision === step.revision) return { revision: step.revision };
    if (step.patch && baseRevision === step.previousRevision) return frameBody(step);
    return { revision: step.revision, full: step.snapshot };
  }

  /** Values the store returns SYNCHRONOUSLY in-process. A view cannot await
   *  them (EngineHost does `engine.listSessions().flatMap(...)` inline), so
   *  they ride every open/call response and the view answers from its mirror. */
  function syncSurfaceOf(entry, { refresh = false, refreshFromStorage = false } = {}) {
    // listSessions() reads the session STORE — a scan measured in hundreds of
    // milliseconds on a large store. Recomputing it on every call made each
    // round trip pay for it; only session-shaping calls need a fresh surface.
    if (!refresh && !refreshFromStorage && entry.syncCache) return entry.syncCache;
    const surface = {};
    try {
      const sessions = entry.engine.listSessions?.(
        refreshFromStorage ? { refreshFromStorage: true } : undefined,
      );
      if (Array.isArray(sessions)) surface.sessions = sanitizeForWire(sessions);
    } catch { /* a store read must never fail a call */ }
    try {
      const dir = entry.engine.sessionStoreDir?.();
      if (typeof dir === 'string') surface.sessionStoreDir = dir;
    } catch { /* optional */ }
    entry.syncCache = surface;
    return surface;
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

  // Calls that change WHICH sessions exist or which one is loaded. Only these
  // invalidate the cached sync surface (a store scan).
  const SESSION_SHAPING_METHODS = new Set([
    'resume', 'resumeSession', 'newSession', 'switchContext', 'deleteSession',
    'renameSessionTitle', 'setSessionArchived', 'prefetchSession', 'submit',
  ]);

  function publish(entry) {
    if (closed || entry.disposed) return;
    try {
      // Identical state produces no frame at all; a changed one travels as a
      // DELTA against the revision every attached view already holds.
      const step = advance(entry);
      if (!step.changed) return;
      onFrame({
        type: 'engine-state',
        key: `engine-state:${entry.engineId}`,
        engineId: entry.engineId,
        ...frameBody(step),
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

  async function open(params = {}, ctx = null) {
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
    const entry = {
      engineId, engine, cwd: params.cwd || process.cwd(), timer: null, disposed: false,
      unsubscribe: null, viewers: new Set(),
    };
    engines.set(engineId, entry);
    addViewer(entry, ctx);
    try {
      entry.unsubscribe = engine.subscribe?.(() => schedulePublish(entry)) ?? null;
    } catch (err) {
      log(`subscribe failed engine=${engineId}: ${err?.message || err}`);
    }
    log(`engine opened id=${engineId} cwd=${entry.cwd}`);
    // The opener gets the snapshot inline so its first getState() is never
    // empty; every other attached client learns about it from this frame.
    const step = advance(entry);
    onFrame({
      type: 'engine-state', key: `engine-state:${engineId}`, engineId, ...frameBody(step),
    });
    return {
      engineId, snapshot: step.snapshot, revision: step.revision, sync: syncSurfaceOf(entry),
    };
  }

  async function call({ engineId, method, args = [], baseRevision = null } = {}, ctx = null) {
    const entry = record(String(engineId || ''));
    addViewer(entry, ctx);
    const name = String(method || '');
    if (!name || name === 'constructor' || name.startsWith('__')) {
      throw new TypeError(`engine method ${name} is unavailable`);
    }
    if (ADOPTABLE_METHODS.has(name)) {
      const sessionId = String((Array.isArray(args) ? args[0] : '') || '');
      // A daemon-side load of this same session may be mid-resume. Adoption
      // has to wait it out, otherwise this view would load a SECOND engine on
      // the session the daemon exists to keep single-writer.
      const loading = sessionLoads.get(sessionId);
      if (loading) { try { await loading; } catch { /* the loader reports it */ } }
      const owner = sessionOwner(sessionId);
      if (owner && owner !== entry.engineId) {
        log(`adopt session=${sessionId} view=${entry.engineId} -> engine=${owner}`);
        // The caller is a viewer of the ADOPTED engine from this moment on —
        // its snapshot read follows, but the claim must not depend on it.
        try { addViewer(entryById(owner), ctx); } catch { /* raced a dispose */ }
        return { value: true, adoptEngineId: owner, sessionId };
      }
    }
    const target = entry.engine[name];
    if (typeof target !== 'function') throw new TypeError(`engine method ${name} is unavailable`);
    const value = await target.apply(entry.engine, Array.isArray(args) ? args : []);
    // A mutation reaches the OTHER views through the broadcast below rather
    // than waiting out the coalescing window; the caller gets the same step on
    // its response, so its own getState() is consistent the moment this returns.
    // The post-call snapshot rides the RESPONSE as well: an in-process store
    // is consistent the instant a method returns, and callers rely on it
    // (EngineHost verifies engine.getState().sessionId right after resume()).
    // Waiting for the async frame made that read stale and looked like a
    // resume mismatch.
    const step = advance(entry);
    if (step.changed) {
      onFrame({
        type: 'engine-state', key: `engine-state:${entry.engineId}`,
        engineId: entry.engineId, ...frameBody(step),
      });
    }
    return {
      value: sanitizeForWire(value) ?? null,
      ...bodyForClient(step, Number.isInteger(baseRevision) ? baseRevision : null),
      // Session-shaping calls (resume/new/switch) change the sync surface the
      // view answers from, so refresh it on the same response.
      sync: syncSurfaceOf(entry, {
        refresh: SESSION_SHAPING_METHODS.has(name),
        refreshFromStorage: name === 'listSessions' || name === 'refreshSessions',
      }),
    };
  }

  // ── Session-addressed calls ─────────────────────────────────────────────────
  // Views are RENDERERS: a desktop pane (or a TUI tab) must be able to hand the
  // backend a prompt for any session it can see, without owning an engine for
  // it first. The daemon resolves the session to its engine — LOADING one when
  // nothing hosts it — so "that session is not live here" can never reject user
  // input (user: 채팅이 안 쳐짐).
  const sessionLoads = new Map(); // sessionId -> Promise<entry>

  async function loadSessionEngine(sessionId, hints) {
    const opened = await open({
      cwd: hints.cwd,
      provider: hints.provider,
      model: hints.model,
      toolMode: hints.toolMode,
      desktopSession: hints.desktopSession ?? null,
    });
    const entry = entryById(opened.engineId);
    // Nothing is watching this engine yet: it is the daemon's own load, so the
    // idle sweep must be able to reclaim it if no view ever attaches.
    entry.headless = true;
    let resumed = false;
    try {
      resumed = await entry.engine.resume?.(sessionId, hints.resumeOptions || undefined) === true;
    } catch (err) {
      await destroy(entry, 'session load failed');
      throw err;
    }
    const state = entry.engine.getState?.() || {};
    const loaded = String(state.sessionId || '');
    // Fork-on-resume names its origin; any other id is a failed load.
    const forkedFrom = String(state.sessionForkedFrom || '');
    if (!resumed || (loaded !== sessionId && forkedFrom !== sessionId)) {
      await destroy(entry, 'session load mismatch');
      throw new Error(`session ${sessionId} could not be resumed`);
    }
    log(`session ${sessionId} loaded on demand as engine ${entry.engineId}`);
    return entry;
  }

  /** The engine hosting sessionId: the existing owner, or a fresh load. One
   *  load per session at a time — concurrent panes converge on one engine. */
  async function entryForSession(sessionId, hints = {}) {
    const owner = sessionOwner(sessionId);
    if (owner) return entryById(owner);
    const inFlight = sessionLoads.get(sessionId);
    if (inFlight) return inFlight;
    let loading;
    loading = loadSessionEngine(sessionId, hints).finally(() => {
      if (sessionLoads.get(sessionId) === loading) sessionLoads.delete(sessionId);
    });
    sessionLoads.set(sessionId, loading);
    return loading;
  }

  /** Apply one engine method to whatever engine owns a SESSION. */
  async function sessionCall({
    sessionId, method, args = [], open: openHints = {}, baseRevision = null,
  } = {}) {
    if (closed) throw new Error('engine daemon service is closed');
    const id = String(sessionId || '');
    if (!id) throw new TypeError('sessionId is required');
    const name = String(method || '');
    if (!name || name === 'constructor' || name.startsWith('__')) {
      throw new TypeError(`engine method ${name} is unavailable`);
    }
    const entry = await entryForSession(id, openHints || {});
    const target = entry.engine[name];
    if (typeof target !== 'function') throw new TypeError(`engine method ${name} is unavailable`);
    const value = await target.apply(entry.engine, Array.isArray(args) ? args : []);
    // One line per session-addressed request: this is the ONLY record that a
    // pane's prompt reached the backend, and its accepted verdict.
    log(`session call ${name} session=${id} engine=${entry.engineId} value=${JSON.stringify(value ?? null)}`);
    const step = advance(entry);
    if (step.changed) {
      onFrame({
        type: 'engine-state', key: `engine-state:${entry.engineId}`,
        engineId: entry.engineId, ...frameBody(step),
      });
    }
    // Still unwatched: keep it on the retention clock exactly like an engine a
    // view released, so an untouched load cannot leak past the idle window.
    if (entry.headless) {
      entry.retainedAt = Date.now();
      startEvictionSweep();
    }
    return {
      value: sanitizeForWire(value) ?? null,
      engineId: entry.engineId,
      sessionId: String(entry.engine.getState?.()?.sessionId || id),
      ...bodyForClient(step, Number.isInteger(baseRevision) ? baseRevision : null),
      sync: syncSurfaceOf(entry, { refresh: SESSION_SHAPING_METHODS.has(name) }),
    };
  }

  async function destroy(entry, reason, { keepBackgroundWork = false } = {}) {
    if (!entry || entry.disposed) return { ok: true };
    const id = entry.engineId;
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

  /** A view letting go of an engine. This NEVER ends a session: the engine
   *  belongs to the DAEMON, not to whoever was watching it, so closing a
   *  terminal or a window is not an instruction to destroy anything (an
   *  opencode-style server-owned session — clients address sessions, they do
   *  not own handles). The only destroyers left are the idle sweep and daemon
   *  shutdown. The single exception is an EMPTY placeholder — no session, no
   *  work, nothing to preserve — which would otherwise pile up per closed pane. */
  async function dispose({ engineId, reason = 'client dispose', keepBackgroundWork = false } = {}, ctx = null) {
    const id = String(engineId || '');
    const entry = engines.get(id);
    if (!entry || entry.disposed) return { ok: true };
    const token = viewerToken(ctx);
    if (token) entry.viewers?.delete(token);
    // Watched by another client (terminal + desktop on one session): nothing
    // about this engine changes.
    if (entry.viewers?.size > 0) {
      log(`engine retained id=${id} (${reason}) — ${entry.viewers.size} other view(s) still attached`);
      return { ok: true, retained: true, viewers: entry.viewers.size };
    }
    let empty = false;
    try {
      empty = !String(entry.engine.getState?.()?.sessionId || '') && !engineBusy(entry);
    } catch { empty = false; }
    if (empty && keepBackgroundWork !== true) {
      return destroy(entry, `${reason} (empty placeholder)`);
    }
    // Unwatched but real: it goes on the idle clock, never under the knife.
    entry.retainedAt = Date.now();
    startEvictionSweep();
    log(`engine retained id=${id} (${reason}) — unwatched, on the idle clock`);
    return { ok: true, retained: true };
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

  function snapshot({ engineId } = {}, ctx = null) {
    const entry = record(String(engineId || ''));
    addViewer(entry, ctx);
    const step = advance(entry);
    return { snapshot: step.snapshot, revision: step.revision, sync: syncSurfaceOf(entry) };
  }

  const routes = {
    'engine.open': open,
    'engine.call': call,
    'engine.session': sessionCall,
    'engine.dispose': dispose,
    'engine.list': async () => list(),
    'engine.snapshot': async (args, ctx) => snapshot(args, ctx),
  };

  async function handleCall(name, args = {}, ctx = null) {
    const route = routes[String(name || '')];
    if (!route) throw new Error(`unknown engine daemon call ${name}`);
    return route(args || {}, ctx);
  }

  async function stop(reason = 'service stop') {
    closed = true;
    if (evictTimer) { clearInterval(evictTimer); evictTimer = null; }
    for (const engineId of [...engines.keys()]) {
      await destroy(engines.get(engineId), reason);
    }
  }

  return {
    handleCall, open, call, sessionCall, dispose, list, snapshot, stop, releaseClient,
    get size() { return engines.size; },
    /** Live work the daemon must not abandon (self-shutdown guard). */
    get busyCount() { return [...engines.values()].filter((entry) => engineBusy(entry)).length; },
  };
}
