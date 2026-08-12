// Session runtime pool hosted by the machine-global daemon.
//
// One process owns every live session runtime; the terminal TUI and the desktop
// app attach as VIEWS over the transport. That inverts today's model (each
// client boots its own session runtime and the session store arbitrates ownership with
// generation counters + heartbeat vetoes): with a single writer, cross-client
// editing is just fan-out, and the split-brain guards can never trip against
// our own second client.
//
// The session runtime factory is injected by the daemon entry.
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import {
  SESSION_CONFIGURE_ACTION_SET,
  SESSION_READ_ACTION_SET,
} from './session-protocol.mjs';
import { diffSessionState } from './session-state-patch.mjs';
import {
  materializePromptSubmission,
  preparePromptSubmissionForProvider,
} from '../runtime/attachments/store.mjs';
import { hasActiveBackgroundTasks } from '../runtime/shared/background-tasks.mjs';

const MAX_CLONE_DEPTH = 24;
const requireDesktopService = createRequire(import.meta.url);

async function loadDesktopServiceModule(moduleUrl) {
  const parsed = new URL(moduleUrl);
  if (!parsed.pathname.toLowerCase().endsWith('.cjs')) {
    return import(moduleUrl);
  }
  // Node's CJS bridge ignores URL search parameters and otherwise returns the
  // previous install's cached exports after an in-place desktop update. Keep
  // already-instantiated adapters alive, but load this newly keyed artifact
  // from disk for the new desktop build.
  const modulePath = fileURLToPath(parsed);
  const resolved = requireDesktopService.resolve(modulePath);
  delete requireDesktopService.cache[resolved];
  return requireDesktopService(resolved);
}

/** JSON-safe projection of a session snapshot. Functions, symbols, and
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

export function createSessionService({
  createSessionRuntime = null,
  sessionExists = null,
  readStoredSession = null,
  listSessions = null,
  getRemoteOwnerState = null,
  desktopRuntime = null,
  publishIntervalMs = 16,
  onFrame = () => {},
  log = () => {},
  onExternalClientsChanged = () => {},
  idleEvictMs = null,
  evictSweepMs = null,
  agentIdleEvictMs = null,
} = {}) {
  const createRuntime = createSessionRuntime;
  if (typeof createRuntime !== 'function') throw new Error('createSessionRuntime is required');
  // Revisions optimize deltas inside one daemon lifetime; sessionId + full
  // snapshots remain the durable contract. Start each daemon far above the
  // prior wall-clock epoch so a view reconnecting after replacement accepts
  // the new daemon's first full snapshot.
  const configuredRevisionEpoch = Number(process.env.MIXDOG_SESSION_REVISION_EPOCH);
  const revisionEpoch = Number.isSafeInteger(configuredRevisionEpoch)
    && configuredRevisionEpoch >= 0
    ? configuredRevisionEpoch
    : Math.floor(Date.now() * 1_000);

  // One daemon-owned execution entry per live session. Entries are never
  // addressed by clients; sessionId is the only identity outside this module.
  const sessions = new Set();
  const sessionsById = new Map();
  let busyEntries = 0;
  // Desktop adapters are keyed by their exact module URL so a dev preview and
  // installed build never share module state accidentally.
  const desktopServicesById = new Map();
  const desktopServicesByModule = new Map();
  const desktopServicePromises = new Map();
  let projectStorePromise = null;
  let closed = false;
  // A turn belongs to the DAEMON, not to whoever is watching it: closing the
  // desktop window or restarting the TUI must never interrupt work. An session runtime
  // whose last view left is RETAINED while it is busy and evicted only after it
  // has been idle and unwatched for this long. With a view release no longer
  // destroying anything, this sweep is the ONLY reclaim path besides shutdown.
  const IDLE_EVICT_MS = Number(idleEvictMs) > 0
    ? Number(idleEvictMs)
    : Math.max(60_000, Number(process.env.MIXDOG_SESSION_IDLE_EVICT_MS) || 2 * 60_000);
  const EVICT_SWEEP_MS = Number(evictSweepMs) > 0 ? Number(evictSweepMs) : 30_000;
  // Agent-hosted sessions (shard spread) are worker sessions: their transcript
  // is durable on disk and a same-tag follow-up re-materializes the runtime on
  // demand, so an idle+unwatched worker runtime returns its shard memory much
  // sooner than an interactive session a user may re-open any moment.
  const AGENT_IDLE_EVICT_MS = Math.min(
    IDLE_EVICT_MS,
    Number(agentIdleEvictMs) > 0
      ? Number(agentIdleEvictMs)
      : Math.max(5_000, Number(process.env.MIXDOG_AGENT_SESSION_IDLE_EVICT_MS) || 45_000),
  );
  let evictTimer = null;

  // ── Cross-client subscriptions ──────────────────────────────────────────────
  // An session runtime is shared by construction (terminal + desktop converge on one
  // session runtime per session), but each client process only refcounts the mirrors it
  // holds ITSELF. Without a daemon-side viewer set, the first client to quit
  // destroyed an session runtime the other one was still streaming — the turn cut out
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

  // ── Stored-session views ────────────────────────────────────────────────────
  // Parity with the codex/claude-code/opencode session models: a stored
  // session that is merely VISIBLE is served from disk; only execution
  // (submit/abort/approve/action/create) materializes a runtime. A client that
  // subscribed while the session was cold is remembered here and adopted by
  // the entry the moment one materializes, so its live frames start flowing
  // without a second subscribe round-trip.
  const pendingViewers = new Map(); // sessionId -> Set<clientToken>

  function trackPendingViewer(sessionId, ctx) {
    const token = subscriberToken(ctx);
    if (!token) return;
    let tokens = pendingViewers.get(sessionId);
    if (!tokens) pendingViewers.set(sessionId, tokens = new Set());
    tokens.add(token);
  }

  function dropPendingViewer(sessionId, ctx) {
    const token = subscriberToken(ctx);
    const tokens = pendingViewers.get(sessionId);
    if (!token || !tokens) return;
    tokens.delete(token);
    if (tokens.size === 0) pendingViewers.delete(sessionId);
  }

  function adoptPendingViewers(entry, sessionId) {
    const tokens = pendingViewers.get(String(sessionId || ''));
    if (!tokens) return;
    pendingViewers.delete(String(sessionId || ''));
    for (const token of tokens) addSubscriber(entry, { clientToken: token });
  }

  /** A client that deregistered (or whose process died) stops being a viewer.
   *  Its session runtimes are never destroyed here: work outlives the client that
   *  walked away, so an session runtime nobody watches goes back on the idle clock. */
  function releaseClient(clientToken) {
    const token = String(clientToken || '');
    if (!token) return { ok: true };
    for (const [pendingId, tokens] of [...pendingViewers]) {
      if (tokens.delete(token) && tokens.size === 0) pendingViewers.delete(pendingId);
    }
    for (const entry of sessions) {
      if (!entry.subscribers?.delete(token)) continue;
      if (entry.subscribers.size > 0) continue;
      if (entry.reservedOnly && !sessionBusy(entry)) {
        void destroy(entry, 'unclaimed session reservation', {
          keepBackgroundWork: true,
        });
        continue;
      }
      entry.retainedAt = Date.now();
      startEvictionSweep();
      log(`session ${currentSessionId(entry) || '(creating)'} unwatched (client ${token} gone) — retained`);
    }
    for (const service of desktopServicesById.values()) {
      service.subscribers.delete(token);
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

  function sessionBusy(entry) {
    const sessionId = currentSessionId(entry);
    // CC parity: detached views do not make their background commands
    // disposable. Keep the owner runtime (and daemon self-shutdown guard) live
    // until the task reaches a terminal state and its completion can be
    // delivered back into this session.
    if (sessionId && hasActiveBackgroundTasks({ callerSessionId: sessionId })) return true;
    if (typeof entry?.busy === 'boolean') return entry.busy;
    try {
      return updateEntryBusy(entry, entry.runtime.getState?.() || {});
    } catch {
      // An session runtime we cannot read is never assumed idle — losing a live turn is
      // far worse than holding an extra process for one sweep.
      return true;
    }
  }

  function liveBusyCount() {
    let count = 0;
    for (const entry of sessions) {
      if (sessionBusy(entry)) count += 1;
    }
    return count;
  }

  function startEvictionSweep() {
    if (evictTimer || closed) return;
    evictTimer = setInterval(() => {
      const now = Date.now();
      for (const entry of [...sessions]) {
        if (!entry.retainedAt) continue;
        // A client came back to it: watched session runtimes are never reclaimed.
        if (entry.subscribers?.size > 0) { entry.retainedAt = null; continue; }
        if (sessionBusy(entry)) { entry.retainedAt = now; continue; }
        if (now - entry.retainedAt < (entry.agentSession ? AGENT_IDLE_EVICT_MS : IDLE_EVICT_MS)) continue;
        void destroy(entry, 'idle and unwatched');
      }
      stopEvictionSweepIfIdle();
    }, EVICT_SWEEP_MS);
    evictTimer.unref?.();
  }

  function stopEvictionSweepIfIdle() {
    if (!evictTimer) return;
    for (const entry of sessions) {
      if (!entry.disposed && entry.retainedAt && (entry.subscribers?.size || 0) === 0) return;
    }
    clearInterval(evictTimer);
    evictTimer = null;
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
    const raw = entry.runtime.getState?.() ?? null;
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
      if (key === 'queued' && Array.isArray(value)) {
        const projected = value.map((item) => ({
          id: item?.id,
          submittedAt: item?.submittedAt,
          text: String(item?.displayText ?? item?.text ?? '').slice(0, 2_000),
          displayText: String(item?.displayText ?? item?.text ?? '').slice(0, 2_000),
          mode: item?.mode || 'prompt',
          priority: item?.priority || 'next',
          ...(Array.isArray(item?.images) && item.images.length ? { images: item.images } : {}),
        }));
        fields.set(key, { source: value, value: projected });
        out[key] = projected;
        continue;
      }
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

  /** Advance the session runtime's published revision one step. */
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
      patch: previous ? diffSessionState(previous, snapshot) : null,
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
    return String(entry?.runtime?.getState?.()?.sessionId || '');
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
      // Do not redirect an established address to a second session runtime. The load
      throw new Error(`duplicate session address: ${nextId}`);
    }
    sessionsById.set(nextId, entry);
    entry.indexedSessionId = nextId;
    return nextId;
  }

  /** Publish one durable session-addressed frame. The runtime pool is a daemon
   *  implementation detail and never enters the client contract. */
  function publishStep(entry, step) {
    const sessionId = currentSessionId(entry);
    if (!sessionId) return;
    // Session runtime revisions may predate the session address (a reservation becomes
    // a materialized session during newSession/resume). A session subscriber
    // has no copy of that session runtime-only base, so the first frame for each session
    // address must be FULL; only later frames may use session runtime revision deltas.
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

  function publish(entry) {
    if (closed || entry.disposed) return;
    try {
      if ((entry.subscribers?.size || 0) === 0) {
        // A headless turn still needs busy/index liveness, but no client can
        // consume a wire projection. Avoid cloning the growing transcript on
        // every token; the next subscriber receives a fresh full snapshot.
        const raw = entry.runtime.getState?.() || {};
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

  /** Session runtime events fire per streamed token. Publish immediately after an idle
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
    if (closed) throw new Error('session service is closed');
    const runtime = await createRuntime({
      sessionId: params.sessionId,
      cwd: params.cwd || process.cwd(),
      provider: params.provider,
      model: params.model,
      toolMode: params.toolMode || 'full',
      remote: params.remote === true,
      desktopSession: params.desktopSession ?? null,
      // Agent shard spread: a Lead spawning workers passes the resolved agent
      // session spec (built Lead-side) plus its own shard index so the pool
      // places the worker runtime on a DIFFERENT event loop.
      ...(params.agentSession && typeof params.agentSession === 'object'
        ? { agentSession: params.agentSession }
        : {}),
      ...(Number.isInteger(params.avoidShardIndex)
        ? { avoidShardIndex: params.avoidShardIndex }
        : {}),
    });
    const entry = {
      runtime, cwd: params.cwd || process.cwd(), timer: null, disposed: false,
      unsubscribe: null, subscribers: new Set(), reservedOnly: false, lastPublishedAt: 0,
      indexedSessionId: '', busy: null, headless: !subscriberToken(ctx), retainedAt: null,
      revision: revisionEpoch,
      agentSession: Boolean(params.agentSession && typeof params.agentSession === 'object'),
    };
    sessions.add(entry);
    try {
      const initialState = runtime.getState?.() || {};
      indexSessionEntry(entry, initialState.sessionId);
      updateEntryBusy(entry, initialState);
    } catch {
      updateEntryBusy(entry, { busy: true });
    }
    addSubscriber(entry, ctx);
    try {
      entry.unsubscribe = runtime.subscribe?.(() => schedulePublish(entry)) ?? null;
    } catch (err) {
      log(`session subscribe failed: ${err?.message || err}`);
    }
    return entry;
  }

  // ── Session-addressed calls ─────────────────────────────────────────────────
  // Views are RENDERERS: a desktop pane (or a TUI tab) must be able to hand the
  // service a prompt for any session it can see, without owning an session runtime for
  // it first. The daemon resolves the session to its session runtime — LOADING one when
  // nothing hosts it — so "that session is not live here" can never reject user
  // input (user: 채팅이 안 쳐짐).
  const sessionLoads = new Map(); // sessionId -> Promise<entry>

  async function loadSessionRuntime(sessionId, hints) {
    const entry = await createEntry({
      sessionId,
      cwd: hints.cwd,
      provider: hints.provider,
      model: hints.model,
      toolMode: hints.toolMode,
      desktopSession: hints.desktopSession ?? null,
      agentSession: hints.agentSession ?? null,
      ...(Number.isInteger(hints.avoidShardIndex)
        ? { avoidShardIndex: hints.avoidShardIndex }
        : {}),
    });
    // Nothing is watching this session runtime yet: it is the daemon's own load, so the
    // idle sweep must be able to reclaim it if no view ever attaches.
    entry.headless = true;
    let resumed = false;
    try {
      resumed = await entry.runtime.resume?.(sessionId, hints.resumeOptions || undefined) === true;
    } catch (err) {
      await destroy(entry, 'session load failed');
      throw err;
    }
    const state = entry.runtime.getState?.() || {};
    const loaded = String(state.sessionId || '');
    // Fork-on-resume names its origin; any other id is a failed load.
    const forkedFrom = String(state.sessionForkedFrom || '');
    if (!resumed || (loaded !== sessionId && forkedFrom !== sessionId)) {
      await destroy(entry, 'session load mismatch');
      throw new Error(`session ${sessionId} could not be resumed`);
    }
    // Publish/index the resumed identity before sessionLoads releases its
    // single-flight promise. A second pane arriving in the next microtask must
    // find this owner in O(1), not create a duplicate session runtime.
    advance(entry);
    adoptPendingViewers(entry, sessionId);
    retainUnwatched(entry, 'headless session load');
    log(`session ${sessionId} loaded on demand`);
    return entry;
  }

  /** The runtime hosting sessionId: the existing owner, or a fresh load. One
   *  load per session at a time — concurrent panes converge on one session runtime. */
  async function entryForSession(sessionId, hints = {}) {
    const owner = sessionOwner(sessionId);
    if (owner) return owner;
    const inFlight = sessionLoads.get(sessionId);
    if (inFlight) return inFlight;
    let loading;
    loading = (async () => {
      if (typeof sessionExists === 'function'
        && await sessionExists(sessionId) !== true) {
        // A session may have been created while the durable check was in
        // flight. Reuse that owner, but never materialize an unknown address
        // merely because a stale pane subscribed to it.
        const lateOwner = sessionOwner(sessionId);
        if (lateOwner) return lateOwner;
        throw new Error(`session ${sessionId} is not available`);
      }
      return loadSessionRuntime(sessionId, hints);
    })().finally(() => {
      if (sessionLoads.get(sessionId) === loading) sessionLoads.delete(sessionId);
    });
    sessionLoads.set(sessionId, loading);
    return loading;
  }

  /** Entry that is live now or already loading (e.g. a competing submit).
   *  Views never start a load themselves. */
  async function liveEntryForView(sessionId) {
    const owner = sessionOwner(sessionId);
    if (owner) return owner;
    const inFlight = sessionLoads.get(sessionId);
    if (!inFlight) return null;
    try {
      return await inFlight;
    } catch {
      // The failed load answers its own caller; a view falls through to disk.
      return null;
    }
  }

  async function storedSessionProjection(sessionId, hints) {
    if (typeof readStoredSession !== 'function') return null;
    const requested = Number(hints?.resumeOptions?.transcriptItemLimit);
    let snapshot = null;
    try {
      snapshot = await readStoredSession(sessionId, {
        transcriptItemLimit: Number.isFinite(requested) && requested > 0 ? requested : 512,
      });
    } catch (err) {
      log(`stored session projection failed session=${sessionId}: ${err?.message || err}`);
      return null;
    }
    if (!snapshot || typeof snapshot !== 'object') return null;
    return sanitizeForWire({
      ...snapshot,
      sessionId,
      queued: Array.isArray(snapshot.queued) ? snapshot.queued : [],
    });
  }

  /** Cold view body. Revision 0 sits below every live revision (epoch-based),
   *  so a projection racing a materialized frame can never roll a view back. */
  function projectionResult(sessionId, projection, extra = {}) {
    return {
      sessionId,
      reservedOnly: false,
      projection: true,
      ...extra,
      revision: 0,
      full: projection,
    };
  }

  async function runSessionAction({
    sessionId, action, args = [], open: openHints = {}, baseRevision = null,
  } = {}, allowedActions) {
    if (closed) throw new Error('session service is closed');
    const id = String(sessionId || '');
    if (!id) throw new TypeError('sessionId is required');
    const name = requireSessionAction(action, allowedActions);
    const entry = await entryForSession(id, openHints || {});
    const target = entry.runtime[name];
    if (typeof target !== 'function') throw new TypeError(`session action ${name} is unavailable`);
    const value = await target.apply(entry.runtime, Array.isArray(args) ? args : []);
    if (name === 'setCwd' && value) {
      try {
        const projects = await loadProjectStore();
        projects.touchProjectSelected?.(value);
      } catch (error) {
        log(`project recency update failed (non-fatal): ${error?.message || error}`);
      }
    }
    // Keep one compact record that the action reached the service without
    // serializing transcripts/catalogs into the daemon log.
    const valueSummary = value === null || value === undefined
      ? String(value)
      : typeof value === 'object'
        ? Array.isArray(value)
          ? `array(${value.length})`
          : `object${Array.isArray(value.items) ? ` items=${value.items.length}` : ''}`
        : String(value).replace(/\s+/g, ' ').slice(0, 160);
    log(`session action ${name} session=${id} result=${valueSummary}`);
    const step = advance(entry);
    if (step.changed) {
      publishStep(entry, step);
    }
    // Still unwatched: keep it on the retention clock exactly like a session runtime
    // released by its view, so an untouched load cannot leak past the idle window.
    retainUnwatched(entry);
    return {
      value: sanitizeForWire(value) ?? null,
      sessionId: String(entry.runtime.getState?.()?.sessionId || id),
      ...bodyForClient(step, Number.isInteger(baseRevision) ? baseRevision : null),
    };
  }

  async function listSessionCatalog(options = {}) {
    if (closed) throw new Error('session service is closed');
    if (typeof listSessions !== 'function') {
      throw new Error('session catalog is unavailable');
    }
    const sessions = await listSessions(options || {});
    const remoteOwner = typeof getRemoteOwnerState === 'function'
      ? await getRemoteOwnerState()
      : null;
    return {
      sessions: sanitizeForWire(Array.isArray(sessions) ? sessions : []),
      remoteOwner: sanitizeForWire(remoteOwner) ?? null,
    };
  }

  async function loadProjectStore() {
    if (typeof desktopRuntime?.loadProjects !== 'function') {
      throw new Error('project service is unavailable');
    }
    projectStorePromise ??= Promise.resolve(desktopRuntime.loadProjects()).catch((error) => {
      projectStorePromise = null;
      throw error;
    });
    return projectStorePromise;
  }

  function requiredProjectPath(path) {
    const value = String(path || '').trim();
    if (!value) throw new TypeError('project path is required');
    return value;
  }

  async function listProjectCatalog() {
    const projects = await loadProjectStore();
    return {
      projects: sanitizeForWire(projects.listProjects?.() || []),
    };
  }

  async function inspectProjectPath({ path } = {}) {
    const projects = await loadProjectStore();
    const resolved = projects.resolveProjectPath?.(requiredProjectPath(path)) || '';
    if (!resolved) throw new TypeError('project path is required');
    return {
      path: resolved,
      exists: projects.pathExists?.(resolved) === true,
      directory: projects.isDirectory?.(resolved) === true,
    };
  }

  async function addProjectEntry({ path } = {}) {
    const projects = await loadProjectStore();
    const project = projects.addProject?.(requiredProjectPath(path)) || null;
    if (!project) throw new Error('project could not be registered');
    return { project: sanitizeForWire(project) };
  }

  async function touchProjectEntry({ path } = {}) {
    const projects = await loadProjectStore();
    return {
      project: sanitizeForWire(projects.touchProjectSelected?.(requiredProjectPath(path)) || null),
    };
  }

  async function renameProjectEntry({ path, name = '' } = {}) {
    const projects = await loadProjectStore();
    const project = projects.renameProject?.(requiredProjectPath(path), String(name || '')) || null;
    if (!project) throw new Error('project is not registered');
    return { project: sanitizeForWire(project) };
  }

  async function removeProjectEntry({ path } = {}) {
    const projects = await loadProjectStore();
    return { removed: projects.removeProject?.(requiredProjectPath(path)) === true };
  }

  async function ensureProjectDirectory({ path } = {}) {
    const projects = await loadProjectStore();
    const resolved = projects.ensureDir?.(requiredProjectPath(path)) || '';
    if (!resolved) throw new Error('project directory could not be created');
    return { path: resolved };
  }

  function requireSessionAction(action, allowed) {
    const name = String(action || '');
    if (!allowed.has(name)) throw new TypeError(`session action ${name || '(empty)'} is unavailable`);
    return name;
  }

  async function configureSession(params = {}, ctx = null) {
    const revision = Math.max(0, Number(ctx?.revision) || 0);
    const action = revision < 1 && params?.action === 'setBackend'
      ? 'setChannelProvider'
      : params?.action;
    // Revision 0 desktop adapters routed some reads through configure because
    // their local read list lagged the session surface. A newer daemon accepts
    // those reads without weakening the current revision's finite lanes.
    if (revision < 1 && SESSION_READ_ACTION_SET.has(String(action || ''))) {
      return runSessionAction({ ...params, action }, SESSION_READ_ACTION_SET);
    }
    return runSessionAction({ ...params, action }, SESSION_CONFIGURE_ACTION_SET);
  }

  // ── Durable session protocol ───────────────────────────────────────────────
  // A connection is only a subscription. Session execution is accepted,
  // queued, and owned here; unsubscribe/client death never calls abort or
  // dispose. The client addresses a durable session id instead of a
  // client-owned session runtime handle.

  function sessionResult(
    entry,
    step,
    baseRevision = null,
    extra = {},
  ) {
    return {
      sessionId: currentSessionId(entry),
      reservedOnly: entry.reservedOnly === true,
      ...extra,
      ...bodyForClient(step, Number.isInteger(baseRevision) ? baseRevision : null),
    };
  }

  async function createSession(params = {}, ctx = null) {
    if (closed) throw new Error('session service is closed');
    const requestedId = String(params.sessionId || '').trim();
    if (requestedId) {
      if (!/^[A-Za-z0-9_-]+$/.test(requestedId)) throw new TypeError('sessionId is invalid');
      const owner = sessionOwner(requestedId);
      if (owner) {
        addSubscriber(owner, ctx);
        const step = advance(owner);
        return sessionResult(owner, step);
      }
    }
    const reservedSessionId = requestedId
      || `sess_daemon_${Date.now()}_${randomUUID().replaceAll('-', '')}`;
    const entry = await createEntry({ ...params, sessionId: reservedSessionId }, ctx);
    try {
      let sessionId = currentSessionId(entry);
      if (!sessionId) {
        sessionId = reservedSessionId;
        if (!/^[A-Za-z0-9_-]+$/.test(sessionId)) throw new TypeError('sessionId is invalid');
        const target = entry.runtime.reserveSession;
        if (typeof target !== 'function') {
          throw new TypeError('session action reserveSession is unavailable');
        }
        await target.call(entry.runtime, sessionId);
        entry.reservedOnly = true;
        sessionId = currentSessionId(entry);
      }
      if (!sessionId) throw new Error('session creation returned no sessionId');
      adoptPendingViewers(entry, sessionId);
      const step = advance(entry);
      if (step.changed) publishStep(entry, step);
      log(`session created session=${sessionId}`);
      retainUnwatched(entry, 'headless session create');
      return sessionResult(entry, step);
    } catch (error) {
      await destroy(entry, 'session creation failed', { keepBackgroundWork: true });
      throw error;
    }
  }

  async function readSession(params = {}, ctx = null) {
    const {
      sessionId, open: openHints = {}, baseRevision = null, baseSyncRevision = null,
    } = params;
    if (params.action != null) {
      void ctx;
      return runSessionAction(params, SESSION_READ_ACTION_SET);
    }
    const id = String(sessionId || '');
    if (!id) throw new TypeError('sessionId is required');
    const live = await liveEntryForView(id);
    if (live) {
      const step = advance(live);
      retainUnwatched(live, 'headless session read');
      return sessionResult(live, step, baseRevision);
    }
    if (typeof readStoredSession === 'function') {
      const projection = await storedSessionProjection(id, openHints);
      const lateOwner = sessionOwner(id);
      if (lateOwner) {
        const step = advance(lateOwner);
        retainUnwatched(lateOwner, 'headless session read');
        return sessionResult(lateOwner, step, baseRevision);
      }
      if (!projection) throw new Error(`session ${id} is not available`);
      return projectionResult(id, projection);
    }
    // Embedders without a store reader keep the legacy load-on-read seam.
    const entry = await entryForSession(id, openHints || {});
    const step = advance(entry);
    retainUnwatched(entry, 'headless session read');
    return sessionResult(entry, step, baseRevision);
  }

  async function subscribeSession(
    {
      sessionId, open: openHints = {}, baseRevision = null, baseSyncRevision = null,
    } = {},
    ctx = null,
  ) {
    const id = String(sessionId || '');
    if (!id) throw new TypeError('sessionId is required');
    const live = await liveEntryForView(id);
    if (live) {
      addSubscriber(live, ctx);
      const step = advance(live);
      return sessionResult(live, step, baseRevision, { subscribed: true });
    }
    if (typeof readStoredSession === 'function') {
      // Register BEFORE the disk read: a concurrent materialization adopts
      // pending viewers only after its runtime is indexed, so this order
      // guarantees either adoption or the live re-check below.
      trackPendingViewer(id, ctx);
      const projection = await storedSessionProjection(id, openHints);
      const lateOwner = sessionOwner(id);
      if (lateOwner) {
        dropPendingViewer(id, ctx);
        addSubscriber(lateOwner, ctx);
        const step = advance(lateOwner);
        return sessionResult(lateOwner, step, baseRevision, { subscribed: true });
      }
      if (!projection) {
        dropPendingViewer(id, ctx);
        throw new Error(`session ${id} is not available`);
      }
      return projectionResult(id, projection, { subscribed: true });
    }
    const entry = await entryForSession(id, openHints || {});
    addSubscriber(entry, ctx);
    const step = advance(entry);
    return sessionResult(entry, step, baseRevision, { subscribed: true });
  }

  async function unsubscribeSession({ sessionId } = {}, ctx = null) {
    const id = String(sessionId || '');
    if (!id) throw new TypeError('sessionId is required');
    dropPendingViewer(id, ctx);
    const owner = sessionOwner(id);
    if (!owner) return { sessionId: id, unsubscribed: true };
    const entry = owner;
    const token = subscriberToken(ctx);
    if (token) entry.subscribers?.delete(token);
    if ((entry.subscribers?.size || 0) === 0) {
      if (entry.reservedOnly && !sessionBusy(entry)) {
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
  } = {}) {
    const id = String(sessionId || '');
    if (!id) throw new TypeError('sessionId is required');
    const entry = await entryForSession(id, openHints || {});
    const target = entry.runtime.submitAsync;
    if (typeof target !== 'function') throw new TypeError('session runtime must implement submitAsync');
    const intake = await preparePromptSubmissionForProvider(
      materializePromptSubmission(prompt, options || {}),
      entry.runtime.provider || entry.runtime.session?.provider || '',
    );
    // Await intake only: submitAsync resolves once the prompt is represented by
    // the queue/user row, while provider execution remains daemon-owned and
    // detached.
    const accepted = await Promise.resolve(target.call(entry.runtime, intake.prompt, intake.options));
    const firstSubmit = accepted === true && entry.reservedOnly;
    if (accepted === true) {
      entry.reservedOnly = false;
    }
    const step = advance(entry);
    if (step.changed) publishStep(entry, step);
    retainUnwatched(entry, 'headless session submit');
    log(`session submit session=${id} accepted=${accepted === true}`);
    return sessionResult(
      entry,
      step,
      baseRevision,
      { accepted: accepted === true },
    );
  }

  async function abortSession({
    sessionId, open: openHints = {}, options = {},
    baseRevision = null,
  } = {}) {
    const id = String(sessionId || '');
    if (!id) throw new TypeError('sessionId is required');
    const entry = await entryForSession(id, openHints || {});
    const target = entry.runtime.abort;
    if (typeof target !== 'function') throw new TypeError('session action abort is unavailable');
    const rawResult = await target.call(entry.runtime, options || {});
    const abortResult = rawResult && typeof rawResult === 'object'
      ? rawResult
      : { aborted: rawResult === true };
    const step = advance(entry);
    if (step.changed) publishStep(entry, step);
    retainUnwatched(entry, 'headless session abort');
    return sessionResult(entry, step, baseRevision, abortResult);
  }

  async function approveSession({
    sessionId, approvalId, decision, open: openHints = {}, baseRevision = null,
  } = {}) {
    const id = String(sessionId || '');
    if (!id) throw new TypeError('sessionId is required');
    const entry = await entryForSession(id, openHints || {});
    const target = entry.runtime.resolveToolApproval;
    if (typeof target !== 'function') {
      throw new TypeError('session action resolveToolApproval is unavailable');
    }
    const approved = await target.call(entry.runtime, approvalId, decision);
    const step = advance(entry);
    if (step.changed) publishStep(entry, step);
    retainUnwatched(entry, 'headless session approval');
    return sessionResult(entry, step, baseRevision, { approved: approved === true });
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
    stopEvictionSweepIfIdle();
    if (entry.indexedSessionId && sessionsById.get(entry.indexedSessionId) === entry) {
      sessionsById.delete(entry.indexedSessionId);
    }
    if (entry.busy === true) busyEntries = Math.max(0, busyEntries - 1);
    entry.busy = false;
    try { await entry.runtime.dispose?.(reason, { keepBackgroundWork }); }
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

  // ── Desktop service adapter ────────────────────────────────────────────────
  // The adapter is a BUILD artifact supplied by the desktop install, but it is
  // instantiated here. Electron and its renderer only keep a transport view;
  // project/session/capability execution therefore shares this daemon process
  // with TUI sessions, channels, memory, MCP, and automation.
  function desktopEventKey(desktopId, message) {
    const kind = String(message?.kind || 'event');
    if (kind === 'session-state') {
      return `desktop-event:${desktopId}:${kind}:${String(message?.sessionId || '')}`;
    }
    // Service events are NOT one lane. Under one shared `desktop-event` key a
    // terminal flood clobbered LSP/folder events — and every other terminal —
    // whenever the stream backed up, because the backlog is latest-wins per
    // key. Name (and terminal id) keep each producer on its own key.
    if (kind === 'desktop-event') {
      const name = String(message?.name || '');
      const terminalId = name === 'terminal-data' ? String(message?.value?.id || '') : '';
      return `desktop-event:${desktopId}:${kind}:${name}${terminalId ? `:${terminalId}` : ''}`;
    }
    return `desktop-event:${desktopId}:${kind}`;
  }

  function publishDesktopEvent(desktopId, message) {
    const wire = sanitizeForWire(message);
    const service = desktopServicesById.get(desktopId);
    if (!wire || !service) return;
    onFrame({
      type: 'desktop-event',
      key: desktopEventKey(desktopId, wire),
      desktopId,
      message: wire,
    }, service.subscribers);
  }

  async function initializeDesktopService({ desktopId, moduleUrl, options = {} } = {}) {
    if (closed) throw new Error('session service is closed');
    const requestedId = String(desktopId || '').trim();
    if (!requestedId || !/^[A-Za-z0-9_-]+$/.test(requestedId)) {
      throw new TypeError('desktopId is invalid');
    }
    const requestedModule = String(moduleUrl || '').trim();
    let parsed;
    try { parsed = new URL(requestedModule); }
    catch { throw new TypeError('desktop service moduleUrl is invalid'); }
    if (parsed.protocol !== 'file:') {
      throw new TypeError('desktop service moduleUrl must be a file URL');
    }
    const existingByModule = desktopServicesByModule.get(requestedModule);
    if (existingByModule) return existingByModule;
    const existingById = desktopServicesById.get(requestedId);
    if (existingById) {
      if (existingById.moduleUrl !== requestedModule) {
        throw new Error(`desktopId ${requestedId} is already bound to another service module`);
      }
      return existingById;
    }
    const pending = desktopServicePromises.get(requestedModule);
    if (pending) return pending;
    const loading = (async () => {
      const loaded = await loadDesktopServiceModule(requestedModule);
      if (typeof loaded.createDesktopService !== 'function') {
        throw new TypeError('desktop service module has no createDesktopService export');
      }
      const instance = await loaded.createDesktopService({
        options: sanitizeForWire(options) || {},
        runtime: desktopRuntime,
        emit: (message) => publishDesktopEvent(requestedId, message),
        onClientCountChanged: () => {
          try { onExternalClientsChanged(); } catch {}
        },
      });
      if (!instance || typeof instance.invoke !== 'function'
        || typeof instance.control !== 'function') {
        throw new TypeError('desktop service adapter is invalid');
      }
      const record = {
        desktopId: requestedId,
        moduleUrl: requestedModule,
        instance,
        subscribers: new Set(),
      };
      desktopServicesById.set(requestedId, record);
      desktopServicesByModule.set(requestedModule, record);
      log(`desktop service loaded id=${requestedId} module=${requestedModule}`);
      return record;
    })();
    desktopServicePromises.set(requestedModule, loading);
    try {
      return await loading;
    } finally {
      if (desktopServicePromises.get(requestedModule) === loading) {
        desktopServicePromises.delete(requestedModule);
      }
    }
  }

  async function desktopInit(params = {}, ctx = null) {
    const service = await initializeDesktopService(params);
    const token = subscriberToken(ctx);
    if (token) service.subscribers.add(token);
    return { desktopId: service.desktopId };
  }

  function requireDesktopService(desktopId) {
    const id = String(desktopId || '');
    const service = desktopServicesById.get(id);
    if (!service) throw new Error('desktop service is not initialized');
    return service;
  }

  async function desktopInvoke({ desktopId, method, args = [] } = {}, ctx = null) {
    const service = requireDesktopService(desktopId);
    const token = subscriberToken(ctx);
    if (token) service.subscribers.add(token);
    const name = String(method || '');
    if (!name) throw new TypeError('desktop service method is required');
    return sanitizeForWire(await service.instance.invoke(name, Array.isArray(args) ? args : [])) ?? null;
  }

  async function desktopControl({ desktopId, message } = {}, ctx = null) {
    const service = requireDesktopService(desktopId);
    const token = subscriberToken(ctx);
    if (token) service.subscribers.add(token);
    await service.instance.control(sanitizeForWire(message) || {});
    return { ok: true };
  }

  async function desktopUnsubscribe({ desktopId } = {}, ctx = null) {
    const service = requireDesktopService(desktopId);
    const token = subscriberToken(ctx);
    if (token) service.subscribers.delete(token);
    return { ok: true, unsubscribed: true };
  }

  const routes = {
    'desktop.init': desktopInit,
    'desktop.invoke': desktopInvoke,
    'desktop.control': desktopControl,
    'desktop.unsubscribe': desktopUnsubscribe,
    'project.list': listProjectCatalog,
    'project.inspect': inspectProjectPath,
    'project.add': addProjectEntry,
    'project.touch': touchProjectEntry,
    'project.rename': renameProjectEntry,
    'project.remove': removeProjectEntry,
    'project.ensureDirectory': ensureProjectDirectory,
    'session.list': listSessionCatalog,
    'session.create': createSession,
    'session.read': readSession,
    'session.subscribe': subscribeSession,
    'session.unsubscribe': unsubscribeSession,
    'session.submit': submitSession,
    'session.abort': abortSession,
    'session.approve': approveSession,
    'session.configure': configureSession,
  };

  async function handleCall(name, args = {}, ctx = null) {
    const route = routes[String(name || '')];
    if (!route) throw new Error(`unknown session service call ${name}`);
    return route(args || {}, ctx);
  }

  async function stop(reason = 'service stop') {
    closed = true;
    if (evictTimer) { clearInterval(evictTimer); evictTimer = null; }
    const services = [...new Set(desktopServicesById.values())];
    desktopServicesById.clear();
    desktopServicesByModule.clear();
    desktopServicePromises.clear();
    for (const service of services) {
      if (!service?.instance?.dispose) continue;
      try { await service.instance.dispose(reason); }
      catch (error) { log(`desktop service dispose failed: ${error?.message || error}`); }
    }
    for (const entry of [...sessions]) {
      await destroy(entry, reason);
    }
  }

  return {
    handleCall, listSessionCatalog, createSession, readSession, subscribeSession, unsubscribeSession,
    submitSession, abortSession, approveSession,
    configureSession, stop, releaseClient,
    get size() { return sessions.size; },
    /** Live work the daemon must not abandon (self-shutdown guard). */
    get busyCount() { return liveBusyCount(); },
    get status() {
      const busy = liveBusyCount();
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
        busy,
        watched,
        retained,
        projected,
        pendingViewerSessions: pendingViewers.size,
        evictionSweepActive: evictTimer !== null,
      };
    },
    /** Phone clients hosted by daemon-owned desktop adapters. */
    get externalClientCount() {
      let total = 0;
      for (const service of desktopServicesById.values()) {
        const count = Number(service?.instance?.clientCount ?? 0);
        if (Number.isSafeInteger(count) && count > 0) total += count;
      }
      return total;
    },
  };
}
