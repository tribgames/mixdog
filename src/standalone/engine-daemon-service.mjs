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
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const MAX_CLONE_DEPTH = 24;
const requireDesktopBackend = createRequire(import.meta.url);

async function loadDesktopBackendModule(moduleUrl) {
  const parsed = new URL(moduleUrl);
  if (!parsed.pathname.toLowerCase().endsWith('.cjs')) {
    return import(moduleUrl);
  }
  // Node's CJS bridge ignores URL search parameters and otherwise returns the
  // previous install's cached exports after an in-place desktop update. Keep
  // already-instantiated adapters alive, but load this newly keyed artifact
  // from disk for the new desktop build.
  const modulePath = fileURLToPath(parsed);
  const resolved = requireDesktopBackend.resolve(modulePath);
  delete requireDesktopBackend.cache[resolved];
  return requireDesktopBackend(resolved);
}

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
  desktopRuntime = null,
  publishIntervalMs = 16,
  onFrame = () => {},
  log = () => {},
  onExternalClientsChanged = () => {},
  idleEvictMs = null,
  evictSweepMs = null,
} = {}) {
  if (typeof createEngine !== 'function') throw new Error('createEngine is required');
  // Revisions optimize deltas inside one daemon lifetime; sessionId + full
  // snapshots remain the durable contract. Start each daemon far above the
  // prior wall-clock epoch so an already-running legacy view (which compared
  // revisions across reconnects) still accepts the replacement daemon's first
  // full snapshot. New views explicitly reset their revision baseline on
  // attachment replacement and do not depend on this compatibility seed.
  const configuredRevisionEpoch = Number(process.env.MIXDOG_ENGINE_REVISION_EPOCH);
  const revisionEpoch = Number.isSafeInteger(configuredRevisionEpoch)
    && configuredRevisionEpoch >= 0
    ? configuredRevisionEpoch
    : Math.floor(Date.now() * 1_000);

  // One daemon-owned execution entry per live session. Entries are never
  // addressed by clients; sessionId is the only identity outside this module.
  const sessions = new Set();
  const sessionsById = new Map();
  let busyEntries = 0;
  // Desktop builds can overlap during an update (or while a dev preview is
  // open). Their adapters are build artifacts and therefore must not be
  // mistaken for one process-global implementation. Reuse an adapter only for
  // the same module URL; compatible builds otherwise coexist on the stable
  // daemon wire protocol.
  const desktopBackendsById = new Map();
  const desktopBackendsByModule = new Map();
  const desktopBackendPromises = new Map();
  let closed = false;
  // A turn belongs to the DAEMON, not to whoever is watching it: closing the
  // desktop window or restarting the TUI must never interrupt work. An engine
  // whose last view left is RETAINED while it is busy and evicted only after it
  // has been idle and unwatched for this long. With a view release no longer
  // destroying anything, this sweep is the ONLY reclaim path besides shutdown.
  const IDLE_EVICT_MS = Number(idleEvictMs) > 0
    ? Number(idleEvictMs)
    : Math.max(60_000, Number(process.env.MIXDOG_ENGINE_IDLE_EVICT_MS) || 2 * 60_000);
  const EVICT_SWEEP_MS = Number(evictSweepMs) > 0 ? Number(evictSweepMs) : 30_000;
  let evictTimer = null;

  // ── Cross-client subscriptions ──────────────────────────────────────────────
  // An engine is shared by construction (terminal + desktop converge on one
  // engine per session), but each client process only refcounts the mirrors it
  // holds ITSELF. Without a daemon-side viewer set, the first client to quit
  // destroyed an engine the other one was still streaming — the turn cut out
  // mid-answer and the surviving view stalled. Viewers are keyed by daemon
  // CLIENT token, so "the last view left" is a machine-wide fact.
  function subscriberToken(ctx) {
    return ctx && ctx.clientToken ? String(ctx.clientToken) : '';
  }

  function addSubscriber(entry, ctx) {
    const token = subscriberToken(ctx);
    if (!entry || !token) return entry;
    (entry.subscribers ??= new Set()).add(token);
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
    for (const entry of sessions) {
      if (!entry.subscribers?.delete(token)) continue;
      if (entry.subscribers.size > 0) continue;
      if (entry.reservedOnly && !engineBusy(entry)) {
        void destroy(entry, 'unclaimed session reservation', {
          keepBackgroundWork: true,
        });
        continue;
      }
      entry.retainedAt = Date.now();
      startEvictionSweep();
      log(`session ${currentSessionId(entry) || '(creating)'} unwatched (client ${token} gone) — retained`);
    }
    for (const backend of desktopBackendsById.values()) {
      backend.subscribers.delete(token);
    }
    return { ok: true };
  }

  function stateBusy(state) {
    return state?.busy === true || state?.commandBusy === true
      || (Array.isArray(state?.queued) && state.queued.length > 0);
  }

  function updateEntryBusy(entry, state) {
    const next = stateBusy(state);
    if (entry.busy === next) return next;
    if (entry.busy === true) busyEntries = Math.max(0, busyEntries - 1);
    if (next) busyEntries += 1;
    entry.busy = next;
    return next;
  }

  function engineBusy(entry) {
    if (typeof entry?.busy === 'boolean') return entry.busy;
    try {
      return updateEntryBusy(entry, entry.engine.getState?.() || {});
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
      for (const entry of [...sessions]) {
        if (!entry.retainedAt) continue;
        // A client came back to it: watched engines are never reclaimed.
        if (entry.subscribers?.size > 0) { entry.retainedAt = null; continue; }
        if (engineBusy(entry)) { entry.retainedAt = now; continue; }
        if (now - entry.retainedAt < IDLE_EVICT_MS) continue;
        void destroy(entry, 'idle and unwatched');
      }
    }, EVICT_SWEEP_MS);
    evictTimer.unref?.();
  }

  function retainUnwatched(entry, reason = 'headless session budget') {
    if (!entry || entry.disposed || (entry.subscribers?.size || 0) > 0) return;
    entry.headless = true;
    entry.retainedAt = Date.now();
    releaseProjection(entry);
    startEvictionSweep();
  }

  function releaseProjection(entry) {
    if (!entry) return;
    entry.snapshotSource = null;
    entry.snapshotCache = null;
    entry.fieldCache?.clear?.();
    entry.itemCache?.clear?.();
    entry.fieldCache = null;
    entry.itemCache = null;
    entry.publishedSnapshot = null;
    entry.publishedSessionId = '';
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
    indexSessionEntry(entry, snapshot?.sessionId);
    updateEntryBusy(entry, snapshot);
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

  function currentSessionId(entry) {
    return String(entry?.engine?.getState?.()?.sessionId || '');
  }

  function indexSessionEntry(entry, sessionId = currentSessionId(entry)) {
    const nextId = String(sessionId || '');
    const previousId = String(entry?.indexedSessionId || '');
    if (previousId && previousId !== nextId && sessionsById.get(previousId) === entry) {
      sessionsById.delete(previousId);
    }
    if (!entry || entry.disposed || !nextId) {
      if (entry) entry.indexedSessionId = '';
      return '';
    }
    const existing = sessionsById.get(nextId);
    if (existing && existing !== entry && !existing.disposed) {
      // Do not redirect an established address to a second engine. The load
      // coordinator normally makes this impossible; retaining the first owner
      // is the safest fallback if an embedder mutates a session id directly.
      entry.indexedSessionId = '';
      log(`duplicate session address refused session=${nextId}`);
      return nextId;
    }
    sessionsById.set(nextId, entry);
    entry.indexedSessionId = nextId;
    return nextId;
  }

  /** Publish one durable session-addressed frame. The engine pool is a daemon
   *  implementation detail and never enters the client contract. */
  function publishStep(entry, step) {
    const sessionId = currentSessionId(entry);
    if (!sessionId) return;
    // Engine revisions may predate the session address (a reservation becomes
    // a materialized session during newSession/resume). A session subscriber
    // has no copy of that engine-only base, so the first frame for each session
    // address must be FULL; only later frames may use engine revision deltas.
    const body = entry.publishedSessionId === sessionId
      ? frameBody(step)
      : { revision: step.revision, full: step.snapshot };
    entry.publishedSessionId = sessionId;
    entry.lastPublishedAt = Date.now();
    onFrame({
      type: 'session-state',
      key: `session-state:${sessionId}`,
      sessionId,
      ...body,
    }, entry.subscribers);
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
  let sharedSyncCache = null;
  let sharedSyncEpoch = -1;

  function syncSurfaceOf(entry, { refresh = false, refreshFromStorage = false } = {}) {
    // listSessions() reads the session STORE — a scan measured in hundreds of
    // milliseconds on a large store. Recomputing it on every call made each
    // round trip pay for it; only session-shaping calls need a fresh surface.
    if (!refresh && !refreshFromStorage && sharedSyncCache && sharedSyncEpoch === syncEpoch) {
      return sharedSyncCache;
    }
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
    sharedSyncCache = surface;
    sharedSyncEpoch = syncEpoch;
    return surface;
  }

  // The session LIST is process-global: every entry reads the same store. A
  // shape change made through ONE entry must therefore expire the cached
  // surface of every OTHER entry, or a pane keeps serving a list that predates
  // the session another view just created, renamed, or deleted.
  let syncEpoch = 0;
  function invalidateSyncSurfaces() {
    syncEpoch += 1;
    sharedSyncCache = null;
  }

  /** Entry that currently holds a session live. */
  function sessionOwner(sessionId) {
    const id = String(sessionId || '');
    if (!id) return null;
    const entry = sessionsById.get(id) || null;
    if (!entry || entry.disposed) {
      if (entry) sessionsById.delete(id);
      return null;
    }
    return entry;
  }

  // Calls that change WHICH sessions exist or which one is loaded. Only these
  // invalidate the cached sync surface (a store scan).
  const SESSION_SHAPING_METHODS = new Set([
    'resume', 'resumeSession', 'newSession', 'switchContext', 'deleteSession',
    'renameSessionTitle', 'setSessionArchived', 'prefetchSession',
  ]);

  // Engine LIFETIME belongs to the daemon: a view drives a session, it never
  // ends one. `subscribe` would also hand a wire client a callback it cannot
  // receive, and reservation is the daemon's own creation step.
  const FORBIDDEN_SESSION_METHODS = new Set(['dispose', 'subscribe', 'reserveSession']);

  function publish(entry) {
    if (closed || entry.disposed) return;
    try {
      if ((entry.subscribers?.size || 0) === 0) {
        // A headless turn still needs busy/index liveness, but no client can
        // consume a wire projection. Avoid cloning the growing transcript on
        // every token; the next subscriber receives a fresh full snapshot.
        const raw = entry.engine.getState?.() || {};
        indexSessionEntry(entry, raw.sessionId);
        updateEntryBusy(entry, raw);
        releaseProjection(entry);
        return;
      }
      // Identical state produces no frame at all; a changed one travels as a
      // DELTA against the revision every attached view already holds.
      const step = advance(entry);
      if (!step.changed) return;
      publishStep(entry, step);
    } catch (err) {
      log(`publish failed session=${currentSessionId(entry) || '(creating)'}: ${err?.message || err}`);
    }
  }

  /** Engine events fire per streamed token. Publish immediately after an idle
   *  interval, then coalesce the rest of the burst to one display-frame clock.
   *  This avoids charging every first token a fixed delay. */
  function schedulePublish(entry) {
    if (entry.timer || entry.disposed || closed) return;
    const elapsed = Date.now() - (entry.lastPublishedAt || 0);
    entry.timer = setTimeout(() => {
      entry.timer = null;
      publish(entry);
    }, Math.max(0, publishIntervalMs - elapsed));
    entry.timer.unref?.();
  }

  async function createEntry(params = {}, ctx = null) {
    if (closed) throw new Error('engine daemon service is closed');
    const engine = await createEngine({
      cwd: params.cwd || process.cwd(),
      provider: params.provider,
      model: params.model,
      toolMode: params.toolMode || 'full',
      remote: params.remote === true,
      desktopSession: params.desktopSession ?? null,
    });
    const entry = {
      engine, cwd: params.cwd || process.cwd(), timer: null, disposed: false,
      unsubscribe: null, subscribers: new Set(), reservedOnly: false, lastPublishedAt: 0,
      indexedSessionId: '', busy: null, headless: !subscriberToken(ctx), retainedAt: null,
      revision: revisionEpoch,
    };
    sessions.add(entry);
    try {
      const initialState = engine.getState?.() || {};
      indexSessionEntry(entry, initialState.sessionId);
      updateEntryBusy(entry, initialState);
    } catch {
      updateEntryBusy(entry, { busy: true });
    }
    addSubscriber(entry, ctx);
    try {
      entry.unsubscribe = engine.subscribe?.(() => schedulePublish(entry)) ?? null;
    } catch (err) {
      log(`session subscribe failed: ${err?.message || err}`);
    }
    return entry;
  }

  // ── Session-addressed calls ─────────────────────────────────────────────────
  // Views are RENDERERS: a desktop pane (or a TUI tab) must be able to hand the
  // backend a prompt for any session it can see, without owning an engine for
  // it first. The daemon resolves the session to its engine — LOADING one when
  // nothing hosts it — so "that session is not live here" can never reject user
  // input (user: 채팅이 안 쳐짐).
  const sessionLoads = new Map(); // sessionId -> Promise<entry>

  async function loadSessionEngine(sessionId, hints) {
    const entry = await createEntry({
      cwd: hints.cwd,
      provider: hints.provider,
      model: hints.model,
      toolMode: hints.toolMode,
      desktopSession: hints.desktopSession ?? null,
    });
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
    // Publish/index the resumed identity before sessionLoads releases its
    // single-flight promise. A second pane arriving in the next microtask must
    // find this owner in O(1), not create a duplicate engine.
    advance(entry);
    retainUnwatched(entry, 'headless session load');
    log(`session ${sessionId} loaded on demand`);
    return entry;
  }

  /** The engine hosting sessionId: the existing owner, or a fresh load. One
   *  load per session at a time — concurrent panes converge on one engine. */
  async function entryForSession(sessionId, hints = {}) {
    const owner = sessionOwner(sessionId);
    if (owner) return owner;
    const inFlight = sessionLoads.get(sessionId);
    if (inFlight) return inFlight;
    let loading;
    loading = loadSessionEngine(sessionId, hints).finally(() => {
      if (sessionLoads.get(sessionId) === loading) sessionLoads.delete(sessionId);
    });
    sessionLoads.set(sessionId, loading);
    return loading;
  }

  /** Apply one compatibility store method to whatever engine owns a SESSION. */
  function syncPayload(entry, baseSyncRevision, options = {}) {
    const known = Number.isInteger(baseSyncRevision) ? baseSyncRevision : null;
    if (!options.refresh && known === syncEpoch) return { syncRevision: syncEpoch };
    return {
      syncRevision: syncEpoch,
      sync: syncSurfaceOf(entry, options),
    };
  }

  async function sessionCall({
    sessionId, method, args = [], open: openHints = {}, baseRevision = null,
    baseSyncRevision = null,
  } = {}, ctx = null) {
    if (closed) throw new Error('engine daemon service is closed');
    const id = String(sessionId || '');
    if (!id) throw new TypeError('sessionId is required');
    const name = String(method || '');
    // `name in Object.prototype` blocks toString/valueOf/hasOwnProperty: they
    // are functions on every object but were never part of the engine contract.
    if (!name || name === 'constructor' || name.startsWith('__')
      || FORBIDDEN_SESSION_METHODS.has(name) || name in Object.prototype) {
      throw new TypeError(`engine method ${name} is unavailable`);
    }
    const entry = await entryForSession(id, openHints || {});
    const target = entry.engine[name];
    if (typeof target !== 'function') throw new TypeError(`engine method ${name} is unavailable`);
    const value = await target.apply(entry.engine, Array.isArray(args) ? args : []);
    const firstSubmit = name === 'submit' && value === true && entry.reservedOnly;
    if (firstSubmit) entry.reservedOnly = false;
    const shaping = SESSION_SHAPING_METHODS.has(name) || firstSubmit;
    if (shaping) invalidateSyncSurfaces();
    // Keep one compact record that the call reached the backend without
    // serializing transcripts/catalogs into the daemon log. A cold pane peek
    // previously wrote hundreds of KB synchronously on the request path.
    const valueSummary = value === null || value === undefined
      ? String(value)
      : typeof value === 'object'
        ? Array.isArray(value)
          ? `array(${value.length})`
          : `object${Array.isArray(value.items) ? ` items=${value.items.length}` : ''}`
        : String(value).replace(/\s+/g, ' ').slice(0, 160);
    log(`session call ${name} session=${id} result=${valueSummary}`);
    const step = advance(entry);
    if (step.changed) {
      publishStep(entry, step);
    }
    // Still unwatched: keep it on the retention clock exactly like an engine a
    // view released, so an untouched load cannot leak past the idle window.
    retainUnwatched(entry);
    return {
      value: sanitizeForWire(value) ?? null,
      sessionId: String(entry.engine.getState?.()?.sessionId || id),
      ...bodyForClient(step, Number.isInteger(baseRevision) ? baseRevision : null),
      ...syncPayload(entry, baseSyncRevision, { refresh: shaping }),
    };
  }

  // ── Durable session protocol ───────────────────────────────────────────────
  // A connection is only a subscription. Session execution is accepted,
  // queued, and owned here; unsubscribe/client death never calls abort or
  // dispose. The client addresses a durable session id instead of a
  // client-owned engine handle.

  function sessionResult(
    entry,
    step,
    baseRevision = null,
    baseSyncRevision = null,
    extra = {},
    syncOptions = {},
  ) {
    return {
      sessionId: currentSessionId(entry),
      reservedOnly: entry.reservedOnly === true,
      ...extra,
      ...bodyForClient(step, Number.isInteger(baseRevision) ? baseRevision : null),
      ...syncPayload(entry, baseSyncRevision, syncOptions),
    };
  }

  async function createSession(params = {}, ctx = null) {
    if (closed) throw new Error('engine daemon service is closed');
    const requestedId = String(params.sessionId || '').trim();
    if (requestedId) {
      if (!/^[A-Za-z0-9_-]+$/.test(requestedId)) throw new TypeError('sessionId is invalid');
      const owner = sessionOwner(requestedId);
      if (owner) {
        addSubscriber(owner, ctx);
        const step = advance(owner);
        return sessionResult(owner, step, null, params.baseSyncRevision);
      }
    }
    const entry = await createEntry(params, ctx);
    try {
      let sessionId = currentSessionId(entry);
      if (!sessionId) {
        sessionId = requestedId
          || `sess_daemon_${Date.now()}_${randomUUID().replaceAll('-', '')}`;
        if (!/^[A-Za-z0-9_-]+$/.test(sessionId)) throw new TypeError('sessionId is invalid');
        const target = entry.engine.reserveSession;
        if (typeof target !== 'function') {
          throw new TypeError('engine method reserveSession is unavailable');
        }
        await target.call(entry.engine, sessionId);
        entry.reservedOnly = true;
        sessionId = currentSessionId(entry);
      }
      if (!sessionId) throw new Error('session creation returned no sessionId');
      const step = advance(entry);
      if (step.changed) publishStep(entry, step);
      invalidateSyncSurfaces();
      log(`session created session=${sessionId}`);
      retainUnwatched(entry, 'headless session create');
      return sessionResult(entry, step, null, params.baseSyncRevision);
    } catch (error) {
      await destroy(entry, 'session creation failed', { keepBackgroundWork: true });
      throw error;
    }
  }

  async function readSession({
    sessionId, open: openHints = {}, baseRevision = null, baseSyncRevision = null,
  } = {}) {
    const id = String(sessionId || '');
    if (!id) throw new TypeError('sessionId is required');
    const entry = await entryForSession(id, openHints || {});
    const step = advance(entry);
    retainUnwatched(entry, 'headless session read');
    return sessionResult(entry, step, baseRevision, baseSyncRevision);
  }

  async function subscribeSession(
    {
      sessionId, open: openHints = {}, baseRevision = null, baseSyncRevision = null,
    } = {},
    ctx = null,
  ) {
    const id = String(sessionId || '');
    if (!id) throw new TypeError('sessionId is required');
    const entry = await entryForSession(id, openHints || {});
    addSubscriber(entry, ctx);
    const step = advance(entry);
    return sessionResult(entry, step, baseRevision, baseSyncRevision, { subscribed: true });
  }

  async function unsubscribeSession({ sessionId } = {}, ctx = null) {
    const id = String(sessionId || '');
    if (!id) throw new TypeError('sessionId is required');
    const owner = sessionOwner(id);
    if (!owner) return { sessionId: id, unsubscribed: true };
    const entry = owner;
    const token = subscriberToken(ctx);
    if (token) entry.subscribers?.delete(token);
    if ((entry.subscribers?.size || 0) === 0) {
      if (entry.reservedOnly && !engineBusy(entry)) {
        await destroy(entry, 'unclaimed session reservation', {
          keepBackgroundWork: true,
        });
        return { sessionId: id, unsubscribed: true };
      }
      entry.retainedAt = Date.now();
      releaseProjection(entry);
      startEvictionSweep();
    }
    log(`session unsubscribed session=${id}${token ? ` client=${token}` : ''}`);
    return { sessionId: id, unsubscribed: true };
  }

  async function submitSession({
    sessionId, prompt, options = {}, open: openHints = {}, baseRevision = null,
    baseSyncRevision = null,
  } = {}) {
    const id = String(sessionId || '');
    if (!id) throw new TypeError('sessionId is required');
    const entry = await entryForSession(id, openHints || {});
    const target = typeof entry.engine.submitAsync === 'function'
      ? entry.engine.submitAsync
      : entry.engine.submit;
    if (typeof target !== 'function') throw new TypeError('engine submit intake is unavailable');
    // Await intake only: submitAsync resolves once the prompt is represented by
    // the queue/user row, while provider execution remains daemon-owned and
    // detached. Legacy embedders with synchronous submit retain the fallback.
    const accepted = await Promise.resolve(target.call(entry.engine, prompt, options || {}));
    const firstSubmit = accepted === true && entry.reservedOnly;
    if (accepted === true) {
      entry.reservedOnly = false;
      // Only the first submit materializes a reserved session in the catalog.
      // Later turns update their own projection without rescanning the store.
      if (firstSubmit) invalidateSyncSurfaces();
    }
    const step = advance(entry);
    if (step.changed) publishStep(entry, step);
    retainUnwatched(entry, 'headless session submit');
    log(`session submit session=${id} accepted=${accepted === true}`);
    return sessionResult(
      entry,
      step,
      baseRevision,
      baseSyncRevision,
      { accepted: accepted === true },
      { refresh: firstSubmit },
    );
  }

  async function abortSession({
    sessionId, open: openHints = {}, options = {},
    baseRevision = null, baseSyncRevision = null,
  } = {}) {
    const id = String(sessionId || '');
    if (!id) throw new TypeError('sessionId is required');
    const entry = await entryForSession(id, openHints || {});
    const target = entry.engine.abort;
    if (typeof target !== 'function') throw new TypeError('engine method abort is unavailable');
    const rawResult = await target.call(entry.engine, options || {});
    const abortResult = rawResult && typeof rawResult === 'object'
      ? rawResult
      : { aborted: rawResult === true };
    const step = advance(entry);
    if (step.changed) publishStep(entry, step);
    retainUnwatched(entry, 'headless session abort');
    return sessionResult(entry, step, baseRevision, baseSyncRevision, abortResult);
  }

  async function approveSession({
    sessionId, approvalId, decision, open: openHints = {}, baseRevision = null,
    baseSyncRevision = null,
  } = {}) {
    const id = String(sessionId || '');
    if (!id) throw new TypeError('sessionId is required');
    const entry = await entryForSession(id, openHints || {});
    const target = entry.engine.resolveToolApproval;
    if (typeof target !== 'function') {
      throw new TypeError('engine method resolveToolApproval is unavailable');
    }
    const approved = await target.call(entry.engine, approvalId, decision);
    const step = advance(entry);
    if (step.changed) publishStep(entry, step);
    retainUnwatched(entry, 'headless session approval');
    return sessionResult(entry, step, baseRevision, baseSyncRevision, { approved: approved === true });
  }

  async function destroy(
    entry,
    reason,
    { keepBackgroundWork = false, announce = true } = {},
  ) {
    if (!entry || entry.disposed) return { ok: true };
    const sessionId = currentSessionId(entry);
    entry.disposed = true;
    releaseProjection(entry);
    if (entry.timer) { clearTimeout(entry.timer); entry.timer = null; }
    try { entry.unsubscribe?.(); } catch {}
    sessions.delete(entry);
    if (entry.indexedSessionId && sessionsById.get(entry.indexedSessionId) === entry) {
      sessionsById.delete(entry.indexedSessionId);
    }
    if (entry.busy === true) busyEntries = Math.max(0, busyEntries - 1);
    entry.busy = false;
    invalidateSyncSurfaces();
    try { await entry.engine.dispose?.(reason, { keepBackgroundWork }); }
    catch (err) { log(`session dispose failed session=${sessionId}: ${err?.message || err}`); }
    if (announce && sessionId) {
      onFrame({
        type: 'session-gone',
        key: `session-state:${sessionId}`,
        sessionId,
        reason,
      }, entry.subscribers);
    }
    log(`session disposed session=${sessionId || '(creating)'} (${reason})`);
    return { ok: true };
  }

  // ── Desktop backend adapter ────────────────────────────────────────────────
  // The adapter is a BUILD artifact supplied by the desktop install, but it is
  // instantiated here. Electron and its renderer only keep a transport view;
  // project/session/capability execution therefore shares this daemon process
  // with TUI sessions, channels, memory, MCP, and automation.
  function desktopEventKey(desktopId, message) {
    const kind = String(message?.kind || 'event');
    if (kind === 'session-state') {
      return `desktop-event:${desktopId}:${kind}:${String(message?.sessionId || '')}`;
    }
    // Backend events are NOT one lane. Under one shared `backend-event` key a
    // terminal flood clobbered LSP/folder events — and every other terminal —
    // whenever the stream backed up, because the backlog is latest-wins per
    // key. Name (and terminal id) keep each producer on its own key.
    if (kind === 'backend-event') {
      const name = String(message?.name || '');
      const terminalId = name === 'terminal-data' ? String(message?.value?.id || '') : '';
      return `desktop-event:${desktopId}:${kind}:${name}${terminalId ? `:${terminalId}` : ''}`;
    }
    return `desktop-event:${desktopId}:${kind}`;
  }

  function publishDesktopEvent(desktopId, message) {
    const wire = sanitizeForWire(message);
    const backend = desktopBackendsById.get(desktopId);
    if (!wire || !backend) return;
    onFrame({
      type: 'desktop-event',
      key: desktopEventKey(desktopId, wire),
      desktopId,
      message: wire,
    }, backend.subscribers);
  }

  async function initializeDesktopBackend({ desktopId, moduleUrl, options = {} } = {}) {
    if (closed) throw new Error('engine daemon service is closed');
    const requestedId = String(desktopId || '').trim();
    if (!requestedId || !/^[A-Za-z0-9_-]+$/.test(requestedId)) {
      throw new TypeError('desktopId is invalid');
    }
    const requestedModule = String(moduleUrl || '').trim();
    let parsed;
    try { parsed = new URL(requestedModule); }
    catch { throw new TypeError('desktop backend moduleUrl is invalid'); }
    if (parsed.protocol !== 'file:') {
      throw new TypeError('desktop backend moduleUrl must be a file URL');
    }
    const existingByModule = desktopBackendsByModule.get(requestedModule);
    if (existingByModule) return existingByModule;
    const existingById = desktopBackendsById.get(requestedId);
    if (existingById) {
      if (existingById.moduleUrl !== requestedModule) {
        throw new Error(`desktopId ${requestedId} is already bound to another backend module`);
      }
      return existingById;
    }
    const pending = desktopBackendPromises.get(requestedModule);
    if (pending) return pending;
    const loading = (async () => {
      const loaded = await loadDesktopBackendModule(requestedModule);
      if (typeof loaded.createDesktopBackend !== 'function') {
        throw new TypeError('desktop backend module has no createDesktopBackend export');
      }
      const instance = await loaded.createDesktopBackend({
        options: sanitizeForWire(options) || {},
        runtime: desktopRuntime,
        emit: (message) => publishDesktopEvent(requestedId, message),
        onClientCountChanged: () => {
          try { onExternalClientsChanged(); } catch {}
        },
      });
      if (!instance || typeof instance.invoke !== 'function'
        || typeof instance.control !== 'function') {
        throw new TypeError('desktop backend adapter is invalid');
      }
      const record = {
        desktopId: requestedId,
        moduleUrl: requestedModule,
        instance,
        subscribers: new Set(),
      };
      desktopBackendsById.set(requestedId, record);
      desktopBackendsByModule.set(requestedModule, record);
      log(`desktop backend loaded id=${requestedId} module=${requestedModule}`);
      return record;
    })();
    desktopBackendPromises.set(requestedModule, loading);
    try {
      return await loading;
    } finally {
      if (desktopBackendPromises.get(requestedModule) === loading) {
        desktopBackendPromises.delete(requestedModule);
      }
    }
  }

  async function desktopInit(params = {}, ctx = null) {
    const backend = await initializeDesktopBackend(params);
    const token = subscriberToken(ctx);
    if (token) backend.subscribers.add(token);
    return { desktopId: backend.desktopId };
  }

  function requireDesktopBackend(desktopId) {
    const id = String(desktopId || '');
    const backend = desktopBackendsById.get(id);
    if (!backend) throw new Error('desktop backend is not initialized');
    return backend;
  }

  async function desktopInvoke({ desktopId, method, args = [] } = {}, ctx = null) {
    const backend = requireDesktopBackend(desktopId);
    const token = subscriberToken(ctx);
    if (token) backend.subscribers.add(token);
    const name = String(method || '');
    if (!name) throw new TypeError('desktop backend method is required');
    return sanitizeForWire(await backend.instance.invoke(name, Array.isArray(args) ? args : [])) ?? null;
  }

  async function desktopControl({ desktopId, message } = {}, ctx = null) {
    const backend = requireDesktopBackend(desktopId);
    const token = subscriberToken(ctx);
    if (token) backend.subscribers.add(token);
    await backend.instance.control(sanitizeForWire(message) || {});
    return { ok: true };
  }

  async function desktopUnsubscribe({ desktopId } = {}, ctx = null) {
    const backend = requireDesktopBackend(desktopId);
    const token = subscriberToken(ctx);
    if (token) backend.subscribers.delete(token);
    return { ok: true, unsubscribed: true };
  }

  const routes = {
    'desktop.init': desktopInit,
    'desktop.invoke': desktopInvoke,
    'desktop.control': desktopControl,
    'desktop.unsubscribe': desktopUnsubscribe,
    'session.create': createSession,
    'session.read': readSession,
    'session.subscribe': subscribeSession,
    'session.unsubscribe': unsubscribeSession,
    'session.submit': submitSession,
    'session.abort': abortSession,
    'session.approve': approveSession,
    'session.invoke': sessionCall,
  };

  async function handleCall(name, args = {}, ctx = null) {
    const route = routes[String(name || '')];
    if (!route) throw new Error(`unknown engine daemon call ${name}`);
    return route(args || {}, ctx);
  }

  async function stop(reason = 'service stop') {
    closed = true;
    if (evictTimer) { clearInterval(evictTimer); evictTimer = null; }
    const backends = [...new Set(desktopBackendsById.values())];
    desktopBackendsById.clear();
    desktopBackendsByModule.clear();
    desktopBackendPromises.clear();
    for (const backend of backends) {
      if (!backend?.instance?.dispose) continue;
      try { await backend.instance.dispose(reason); }
      catch (error) { log(`desktop backend dispose failed: ${error?.message || error}`); }
    }
    for (const entry of [...sessions]) {
      await destroy(entry, reason);
    }
  }

  return {
    handleCall, createSession, readSession, subscribeSession, unsubscribeSession,
    submitSession, abortSession, approveSession,
    sessionCall, stop, releaseClient,
    get size() { return sessions.size; },
    /** Live work the daemon must not abandon (self-shutdown guard). */
    get busyCount() { return busyEntries; },
    get status() {
      let watched = 0;
      let retained = 0;
      let projected = 0;
      for (const entry of sessions) {
        if ((entry.subscribers?.size || 0) > 0) watched += 1;
        else if (entry.retainedAt) retained += 1;
        if (entry.snapshotCache || entry.publishedSnapshot) projected += 1;
      }
      return {
        live: sessions.size,
        busy: busyEntries,
        watched,
        retained,
        projected,
      };
    },
    /** Phone clients hosted by daemon-owned desktop adapters. */
    get externalClientCount() {
      let total = 0;
      for (const backend of desktopBackendsById.values()) {
        const count = Number(backend?.instance?.clientCount ?? 0);
        if (Number.isSafeInteger(count) && count > 0) total += count;
      }
      return total;
    },
  };
}
