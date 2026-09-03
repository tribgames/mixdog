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
import {
  cancelBackgroundTasks,
  hasActiveBackgroundTasks,
} from '../runtime/shared/background-tasks.mjs';

const MAX_CLONE_DEPTH = 24;
const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]+$/;
const requireDesktopService = createRequire(import.meta.url);
const EXTERNAL_SESSION_ACTIONS = new Set([
  ...SESSION_READ_ACTION_SET,
  ...SESSION_CONFIGURE_ACTION_SET,
  'submitAsync',
  'abort',
  'resolveToolApproval',
]);

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
  readStoredGoal = null,
  listStoredActiveGoalSessionIds = null,
  subscribeExternalSessionStates = null,
  invokeExternalSessionAction = null,
  readExternalSessionState = null,
  listSessions = null,
  getRemoteSessionState = null,
  desktopRuntime = null,
  publishIntervalMs = 16,
  onFrame = () => {},
  log = () => {},
  onExternalClientsChanged = () => {},
  onDesktopReady = () => {},
  idleEvictMs = null,
  evictSweepMs = null,
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
  // Agent children are catalog metadata over ordinary daemon-owned sessions.
  // Their transcript/execution state remains exclusively in `sessionsById`;
  // this index carries only the Parent–Child relationship and public Agent
  // routing fields needed before/after a turn.
  const agentSessions = new Map();
  const agentChildren = new Map();
  const agentCancelRuns = new Map();
  let agentRehydrated = false;
  let agentRehydratePromise = null;
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
    : Math.max(60_000, Number(process.env.MIXDOG_SESSION_IDLE_EVICT_MS) || 5 * 60_000);
  const EVICT_SWEEP_MS = Number(evictSweepMs) > 0 ? Number(evictSweepMs) : 30_000;
  // The wire projection (snapshotCache / itemCache / fieldCache /
  // publishedSnapshot) is a SECOND full copy of the transcript, held per
  // WATCHED session. Merely leaving a tab open used to pin that copy for the
  // daemon's lifetime — with several open sessions it dominated resident
  // memory. An idle watched session now drops its projection and rebuilds it
  // as one full frame on the next change. The runtime, its workers and any
  // background work are untouched: this is a cache reclaim, not an eviction.
  const PROJECTION_IDLE_MS = Math.max(
    15_000,
    Number(process.env.MIXDOG_SESSION_PROJECTION_IDLE_MS) || 90_000,
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
    // A watched session carries a reclaimable projection, so the sweep has to
    // run even when nothing is retained/unwatched.
    startEvictionSweep();
    return entry;
  }

  // ── Stored-session views ────────────────────────────────────────────────────
  // Standard stored-session model: a stored
  // session that is merely VISIBLE is served from disk; only execution
  // (submit/abort/approve/action/create) materializes a runtime. A client that
  // subscribed while the session was cold is remembered here and adopted by
  // the entry the moment one materializes, so its live frames start flowing
  // without a second subscribe round-trip.
  const pendingViewers = new Map(); // sessionId -> Set<clientToken>
  const externalViewEntries = new Map(); // sessionId -> ordinary projected entry

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
    for (const [sessionId, entry] of [...externalViewEntries]) {
      entry.subscribers?.delete(token);
      if ((entry.subscribers?.size || 0) === 0) externalViewEntries.delete(sessionId);
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
    // Detached views do not make their background commands
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
        // A client came back to it: watched session RUNTIMES are never
        // reclaimed. Their projection still is — an idle watched session keeps
        // the runtime and drops only the wire clone of its transcript, which
        // the next publish rebuilds as a full frame.
        if (entry.subscribers?.size > 0) {
          entry.retainedAt = null;
          if (!sessionBusy(entry) && now - (entry.lastPublishedAt || 0) >= PROJECTION_IDLE_MS) {
            releaseProjection(entry);
          }
          continue;
        }
        if (!entry.retainedAt) continue;
        if (sessionBusy(entry)) { entry.retainedAt = now; continue; }
        if (now - entry.retainedAt < IDLE_EVICT_MS) continue;
        // Eviction is a MEMORY reclaim, never a user teardown: the runtime's
        // agent workers and background jobs are daemon-owned work that must
        // survive the owner's idle eviction (observed: switching desktop tabs
        // evicted the Lead after 2 minutes and its teardown closed every idle
        // worker with reap time left — and cancelled running ones).
        void destroy(entry, 'idle and unwatched', { keepBackgroundWork: true });
      }
      stopEvictionSweepIfIdle();
    }, EVICT_SWEEP_MS);
    evictTimer.unref?.();
  }

  function stopEvictionSweepIfIdle() {
    if (!evictTimer) return;
    for (const entry of sessions) {
      if (entry.disposed) continue;
      const watchers = entry.subscribers?.size || 0;
      if (entry.retainedAt && watchers === 0) return;
      // A watched session holding a projection still has memory to reclaim.
      if (watchers > 0 && (entry.snapshotCache || entry.publishedSnapshot)) return;
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
    // Runtime-worker IPC has already produced a wire-safe graph. Reusing it
    // removes the daemon's second full transcript clone; in-process runtimes
    // keep the sanitizer boundary below.
    const cloned = entry.runtime?.isWireSafe === true ? raw : projectState(entry, raw);
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
    const projectedSessionId = String(snapshot?.sessionId || '');
    const addressedSessionId = String(entry.addressedSessionId || '');
    if (addressedSessionId
      && projectedSessionId
      && projectedSessionId !== addressedSessionId) {
      throw new Error(
        `session ${addressedSessionId} changed its durable address to ${projectedSessionId}`,
      );
    }
    if (!addressedSessionId && projectedSessionId) {
      entry.addressedSessionId = projectedSessionId;
    }
    indexSessionEntry(entry, projectedSessionId);
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
    // External agent projections use the same frame machinery but are not a
    // daemon execution owner. Keeping them out of sessionsById lets a later
    // ordinary session materialization adopt the viewers and take authority.
    if (entry.externalView === true) return nextId;
    const existing = sessionsById.get(nextId);
    if (existing && existing !== entry && !existing.disposed) {
      // Do not redirect an established address to a second session runtime. The load
      throw new Error(`duplicate session address: ${nextId}`);
    }
    const external = externalViewEntries.get(nextId);
    if (external) {
      externalViewEntries.delete(nextId);
      for (const token of external.subscribers || []) {
        addSubscriber(entry, { clientToken: token });
      }
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

  function externalEntryForView(sessionId) {
    return externalViewEntries.get(String(sessionId || '')) || null;
  }

  function publishExternalSessionState(update) {
    const sessionId = String(update?.sessionId || '');
    const snapshot = update?.snapshot;
    if (!sessionId || !snapshot || typeof snapshot !== 'object') return;
    // A daemon-owned runtime is the canonical owner if this address was
    // materialized. External agent projection frames can arrive one tick late
    // after that promotion and must not overwrite it.
    if (sessionOwner(sessionId)) return;
    let entry = externalViewEntries.get(sessionId);
    if (!entry) {
      if (!pendingViewers.has(sessionId)) return;
      let state = { ...snapshot, sessionId };
      const runtime = {
        isWireSafe: true,
        externalAction: typeof invokeExternalSessionAction === 'function',
        getState: () => state,
        setState: (next) => { state = next; },
      };
      Object.defineProperties(runtime, {
        id: { get: () => sessionId },
        provider: { get: () => String(state.provider || '') },
        model: { get: () => String(state.model || '') },
        session: {
          get: () => ({
            id: sessionId,
            provider: String(state.provider || ''),
            model: String(state.model || ''),
          }),
        },
      });
      if (typeof invokeExternalSessionAction === 'function') {
        for (const name of EXTERNAL_SESSION_ACTIONS) {
          runtime[name] = (...args) => invokeExternalSessionAction(sessionId, name, args);
        }
      }
      entry = {
        runtime,
        subscribers: new Set(),
        disposed: false,
        timer: null,
        lastPublishedAt: 0,
        publishedSessionId: '',
        indexedSessionId: '',
        addressedSessionId: sessionId,
        revision: revisionEpoch,
        busy: null,
        externalView: true,
      };
      externalViewEntries.set(sessionId, entry);
      adoptPendingViewers(entry, sessionId);
    } else {
      entry.runtime.setState({ ...snapshot, sessionId });
    }
    const step = advance(entry);
    if (step.changed) publishStep(entry, step);
  }

  const unsubscribeExternalSessionStates =
    typeof subscribeExternalSessionStates === 'function'
      ? subscribeExternalSessionStates(publishExternalSessionState)
      : () => {};

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
      effort: params.effort,
      fast: params.fast,
      modelParameters: params.modelParameters,
      toolMode: params.toolMode || 'full',
      remote: params.remote === true,
      desktopSession: params.desktopSession ?? null,
      sessionProfile: params.sessionProfile ?? null,
    });
    const entry = {
      runtime, cwd: params.cwd || process.cwd(), timer: null, disposed: false,
      unsubscribe: null, subscribers: new Set(), reservedOnly: false, lastPublishedAt: 0,
      indexedSessionId: '', addressedSessionId: '', busy: null,
      headless: !subscriberToken(ctx), retainedAt: null,
      revision: revisionEpoch,
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

  /** Bind a retained external Agent snapshot into the ordinary view entry
   *  without materializing a daemon runtime. publishExternalSessionState
   *  adopts pending viewers so a completed turn is visible immediately. */
  async function bindExternalSessionView(sessionId) {
    const id = String(sessionId || '');
    if (!id) return null;
    const owner = sessionOwner(id);
    if (owner) return owner;
    const existing = externalEntryForView(id);
    if (existing) return existing;
    if (typeof readExternalSessionState !== 'function') return null;

    // Register the address before the retained-snapshot read. Even a
    // synchronous reader crosses an `await` boundary, so a newer external
    // frame can otherwise arrive in that microtask, find no pending viewer,
    // and be dropped before the stale retained snapshot is bound.
    const placeholder = new Set();
    const ownsPlaceholder = !pendingViewers.has(id);
    if (ownsPlaceholder) pendingViewers.set(id, placeholder);
    const clearPlaceholder = () => {
      if (ownsPlaceholder
        && pendingViewers.get(id) === placeholder
        && placeholder.size === 0) {
        pendingViewers.delete(id);
      }
    };

    let snapshot = null;
    try {
      snapshot = await readExternalSessionState(id);
    } catch (error) {
      log(`external session state read failed session=${id}: ${error?.message || error}`);
      const raced = sessionOwner(id) || externalEntryForView(id);
      clearPlaceholder();
      return raced;
    }
    const raced = sessionOwner(id) || externalEntryForView(id);
    if (raced) {
      clearPlaceholder();
      return raced;
    }
    if (!snapshot || typeof snapshot !== 'object') {
      clearPlaceholder();
      return null;
    }
    publishExternalSessionState({ sessionId: id, snapshot });
    const bound = sessionOwner(id) || externalEntryForView(id);
    if (!bound) clearPlaceholder();
    return bound;
  }

  /** The runtime hosting sessionId: the existing owner, or a fresh load. One
   *  load per session at a time — concurrent panes converge on one session runtime. */
  async function entryForSession(sessionId, hints = {}) {
    const owner = sessionOwner(sessionId);
    if (owner) return owner;
    const external = await bindExternalSessionView(sessionId);
    if (external?.runtime?.externalAction === true) return external;
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

  /** Entry that is live NOW. Views never start a load themselves, and they
   *  never wait for one either: an in-flight load (daemon-boot remote restore,
   *  a competing submit) can take runtime-boot time, and awaiting it blanked
   *  the pane for exactly that session while every other session rendered
   *  instantly from its disk projection (user report). The caller falls
   *  through to the projection path, which registers a pending viewer /
   *  re-checks the owner, so the completed load still adopts the view and
   *  promotes it to live frames. */
  function liveEntryForView(sessionId) {
    return sessionOwner(sessionId) || null;
  }

  // A cold read that misses its cache is the one place a pane open pays real
  // CPU on this thread; anything past the threshold is worth a log line so a
  // slow open can be attributed instead of guessed at.
  const SLOW_STORED_PROJECTION_MS = 250;
  function traceStoredProjectionRead({ sessionId, hit, ms, chars, items }) {
    // A waiter that shared an in-flight parse reports as a hit; the parse
    // itself is the line worth having.
    if (hit || ms < SLOW_STORED_PROJECTION_MS) return;
    log(`slow stored projection session=${sessionId} ${Math.round(ms)}ms`
      + ` chars=${chars} items=${items}`);
  }

  async function storedSessionProjection(sessionId, hints) {
    if (typeof readStoredSession !== 'function') return null;
    const requested = Number(hints?.resumeOptions?.transcriptItemLimit);
    let snapshot = null;
    try {
      snapshot = await readStoredSession(sessionId, {
        transcriptItemLimit: Number.isFinite(requested) && requested > 0 ? requested : 512,
        trace: traceStoredProjectionRead,
      });
    } catch (err) {
      log(`stored session projection failed session=${sessionId}: ${err?.message || err}`);
      return null;
    }
    if (!snapshot || typeof snapshot !== 'object') return null;
    let goal;
    if (typeof readStoredGoal === 'function') {
      try {
        goal = await readStoredGoal(sessionId) ?? null;
      } catch (err) {
        log(`stored Goal projection failed session=${sessionId}: ${err?.message || err}`);
        goal = null;
      }
    }
    return sanitizeForWire({
      ...snapshot,
      sessionId,
      ...(typeof readStoredGoal === 'function' ? { goal } : {}),
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
      ...(typeof projection?.projectionStamp === 'string'
        ? { projectionStamp: projection.projectionStamp }
        : {}),
      full: projection,
    };
  }

  async function requestedMessageSlice(params, sessionId) {
    if (!Number.isInteger(params?.messageStart)) return {};
    const start = Math.max(0, params.messageStart);
    // Live sessions answer from the runtime (read-your-writes): the worker's
    // debounced disk save can lag a just-finished turn, and a disk read here
    // returned a transcript WITHOUT the final assistant message — remote
    // agent waiters then handed off an empty result for completed work.
    const live = sessionOwner(sessionId);
    if (live && typeof live.runtime?.readModelMessages === 'function') {
      try {
        const result = await live.runtime.readModelMessages(start);
        if (result && Array.isArray(result.messages)) {
          return {
            messageCount: Math.max(0, Number(result.messageCount) || result.messages.length),
            messages: sanitizeForWire(result.messages),
          };
        }
      } catch { /* cold fallback below */ }
    }
    if (typeof readStoredSession !== 'function') {
      throw new Error('session transcript reader is unavailable');
    }
    const stored = await readStoredSession(sessionId, { includeMessages: true });
    const messages = Array.isArray(stored?.messages) ? stored.messages : [];
    return {
      messageCount: messages.length,
      messages: sanitizeForWire(start > 0 ? messages.slice(start) : messages),
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
    const sessions = await listSessions({
      ...(options || {}),
      // Agent-only records are an internal ancestry/reuse source, never part
      // of the ordinary session catalog returned over the public transport.
      includeAgentOnly: false,
    });
    const remoteSession = typeof getRemoteSessionState === 'function'
      ? await getRemoteSessionState()
      : null;
    return {
      sessions: sanitizeForWire(Array.isArray(sessions) ? sessions : []),
      remoteSession: sanitizeForWire(remoteSession) ?? null,
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
    const action = params?.action;
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
      baseProjectionStamp = null,
    } = params;
    if (params.action != null) {
      void ctx;
      return runSessionAction(params, SESSION_READ_ACTION_SET);
    }
    const id = String(sessionId || '');
    if (!id) throw new TypeError('sessionId is required');
    const live = await liveEntryForView(id)
      || externalEntryForView(id)
      || await bindExternalSessionView(id);
    if (live) {
      const step = advance(live);
      retainUnwatched(live, 'headless session read');
      return sessionResult(live, step, baseRevision, await requestedMessageSlice(
        params,
        id,
      ));
    }
    if (typeof readStoredSession === 'function') {
      const projection = await storedSessionProjection(id, openHints);
      const lateOwner = sessionOwner(id) || externalEntryForView(id);
      if (lateOwner) {
        const step = advance(lateOwner);
        retainUnwatched(lateOwner, 'headless session read');
        return sessionResult(lateOwner, step, baseRevision, await requestedMessageSlice(
          params,
          id,
        ));
      }
      if (!projection) throw new Error(`session ${id} is not available`);
      // A visible cold pane re-reads on a clock. When the reader hands back
      // the very projection the caller already holds, the answer carries no
      // body: the caller keeps its snapshot and nothing crosses the wire.
      if (typeof baseProjectionStamp === 'string' && baseProjectionStamp
        && projection.projectionStamp === baseProjectionStamp
        && !Number.isInteger(params.messageStart)) {
        return {
          sessionId: id,
          reservedOnly: false,
          projection: true,
          revision: 0,
          projectionStamp: projection.projectionStamp,
          unchanged: true,
        };
      }
      return projectionResult(id, projection, await requestedMessageSlice(params, id));
    }
    // Embedders without a store reader keep the legacy load-on-read seam.
    const entry = await entryForSession(id, openHints || {});
    const step = advance(entry);
    retainUnwatched(entry, 'headless session read');
    return sessionResult(entry, step, baseRevision, await requestedMessageSlice(
      params,
      id,
    ));
  }

  async function subscribeSession(
    {
      sessionId, open: openHints = {}, baseRevision = null, baseSyncRevision = null,
    } = {},
    ctx = null,
  ) {
    const id = String(sessionId || '');
    if (!id) throw new TypeError('sessionId is required');
    const live = await liveEntryForView(id)
      || externalEntryForView(id)
      || await bindExternalSessionView(id);
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
      const lateOwner = sessionOwner(id) || externalEntryForView(id);
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
    if (!owner) {
      const external = externalEntryForView(id);
      if (external) {
        const token = subscriberToken(ctx);
        if (token) external.subscribers?.delete(token);
        if ((external.subscribers?.size || 0) === 0) externalViewEntries.delete(id);
      }
      return { sessionId: id, unsubscribed: true };
    }
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
    const submissionOptions = entry.runtime.externalAction === true
      ? {
          ...intake.options,
          transcriptMeta: {
            ...(intake.options?.transcriptMeta && typeof intake.options.transcriptMeta === 'object'
              ? intake.options.transcriptMeta
              : {}),
            sender: 'user',
          },
        }
      : intake.options;
    const accepted = await Promise.resolve(target.call(entry.runtime, intake.prompt, submissionOptions));
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

  async function materializeSession(sessionId, openHints = {}) {
    const id = String(sessionId || '');
    if (!id) throw new TypeError('sessionId is required');
    const entry = await entryForSession(id, openHints || {});
    retainUnwatched(entry, 'daemon session owner');
    return entry.runtime;
  }

  async function recoverActiveGoals() {
    if (typeof listStoredActiveGoalSessionIds !== 'function') {
      return { found: 0, resumed: 0, skipped: 0, failed: 0 };
    }
    let listed;
    try {
      listed = await listStoredActiveGoalSessionIds();
    } catch (err) {
      log(`active Goal discovery failed: ${err?.message || err}`);
      return { found: 0, resumed: 0, skipped: 0, failed: 1 };
    }
    const sessionIds = [...new Set(Array.isArray(listed) ? listed : [])]
      .map((sessionId) => String(sessionId || ''))
      .filter((sessionId) => SESSION_ID_PATTERN.test(sessionId));
    let resumed = 0;
    let skipped = 0;
    let failed = 0;
    for (const sessionId of sessionIds) {
      try {
        if (typeof readStoredGoal === 'function') {
          const goal = await readStoredGoal(sessionId);
          if (goal?.status !== 'active') {
            skipped += 1;
            continue;
          }
        }
        await materializeSession(sessionId);
        resumed += 1;
      } catch (err) {
        failed += 1;
        log(`active Goal recovery failed session=${sessionId}: ${err?.message || err}`);
      }
    }
    return { found: sessionIds.length, resumed, skipped, failed };
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
    const state = entry.runtime.getState?.() || {};
    const parentId = String(state.parentSessionId || state.ownerSessionId || '').trim();
    const isLegacyAgentChild = String(state.owner || '').trim().toLowerCase() === 'agent'
      && String(state.agent || '').trim().toLowerCase() !== 'lead'
      && parentId
      && parentId !== id;
    const abortsAgentTurn = agentSessions.has(id)
      || String(state.visibility || '').trim().toLowerCase() === 'agent-only'
      || isLegacyAgentChild;
    let rawResult;
    try {
      rawResult = target.call(entry.runtime, options || {});
    } finally {
      // Lead cancellation must leave delegated work alive. An Agent cancelling
      // its own turn, however, is the live parent signal for Agent work nested
      // under that turn; task cancellation reaches the child's own controller
      // without enumerating durable sessions.
      if (abortsAgentTurn) {
        cancelBackgroundTasks({
          surface: 'agent',
          callerSessionId: id,
          reason: 'parent Agent turn aborted',
        });
      }
    }
    rawResult = await rawResult;
    const abortResult = rawResult && typeof rawResult === 'object'
      ? rawResult
      : { aborted: rawResult === true };
    const step = advance(entry);
    if (step.changed) publishStep(entry, step);
    retainUnwatched(entry, 'headless session abort');
    return sessionResult(entry, step, baseRevision, abortResult);
  }

  function linkAgentDescriptor(descriptor) {
    const sessionId = String(descriptor?.id || '').trim();
    const parentSessionId = String(descriptor?.parentSessionId || '').trim();
    if (!sessionId || !parentSessionId) {
      throw new TypeError('agent child requires session and parent ids');
    }
    const previous = agentSessions.get(sessionId);
    if (previous?.parentSessionId && previous.parentSessionId !== parentSessionId) {
      agentChildren.get(previous.parentSessionId)?.delete(sessionId);
    }
    const linked = {
      ...(previous || {}),
      ...descriptor,
      id: sessionId,
      parentSessionId,
      ownerSessionId: String(
        descriptor.ownerSessionId
        || previous?.ownerSessionId
        || agentSessions.get(parentSessionId)?.ownerSessionId
        || parentSessionId,
      ),
      owner: 'agent',
      visibility: 'agent-only',
      closed: descriptor.closed === true,
    };
    agentSessions.set(sessionId, linked);
    let children = agentChildren.get(parentSessionId);
    if (!children) agentChildren.set(parentSessionId, children = new Set());
    children.add(sessionId);
    return linked;
  }

  function validLinkedSessionId(value, ownId = '') {
    const id = String(value || '').trim();
    return SESSION_ID_PATTERN.test(id) && id !== ownId ? id : '';
  }

  function storedAgentCandidate(row) {
    const id = String(row?.id || '').trim();
    if (!SESSION_ID_PATTERN.test(id)) return null;
    const parentSessionId = validLinkedSessionId(
      row?.parentSessionId || row?.ownerSessionId,
      id,
    );
    if (!parentSessionId) return null;
    const declaredVisibility = String(
      row?.visibility || row?.sessionVisibility || '',
    ).trim().toLowerCase() === 'agent-only';
    const legacyAgentChild = String(row?.owner || '').trim().toLowerCase() === 'agent';
    if (!declaredVisibility && !legacyAgentChild) return null;
    return { row, id, parentSessionId };
  }

  function lastStoredAgentHandoff(row) {
    if (typeof row?.lastHandoff === 'string') return row.lastHandoff;
    const messages = Array.isArray(row?.messages) ? row.messages : [];
    const assistant = [...messages].reverse().find((message) => (
      message?.role === 'assistant'
      && (typeof message.content === 'string' ? message.content.trim() : message.content)
    ));
    if (!assistant) return '';
    return typeof assistant.content === 'string'
      ? assistant.content
      : JSON.stringify(assistant.content);
  }

  /** Rebuild the Agent-only routing layer from lightweight durable summaries
   *  after daemon replacement. Transcripts remain store/runtime owned and are
   *  loaded by exact canonical session id only when a caller needs one. */
  async function rehydrateAgentSessions() {
    if (agentRehydrated) return agentSessions.size;
    if (agentRehydratePromise) return agentRehydratePromise;
    if (typeof listSessions !== 'function') {
      agentRehydrated = true;
      return agentSessions.size;
    }
    let loading;
    loading = (async () => {
      const stored = await listSessions({
        includeAgentOnly: true,
        summaryOnly: true,
        refreshFromStorage: false,
      });
      let candidates = (Array.isArray(stored) ? stored : [])
        .map(storedAgentCandidate)
        .filter(Boolean);
      if (typeof readStoredSession === 'function') {
        candidates = await Promise.all(candidates.map(async (candidate) => {
          if (candidate.row?.parentSessionId) return candidate;
          try {
            const metadata = await readStoredSession(candidate.id, { metadataOnly: true });
            return storedAgentCandidate({
              ...candidate.row,
              ...(metadata && typeof metadata === 'object' ? metadata : {}),
              id: candidate.id,
            }) || candidate;
          } catch (error) {
            log(`agent metadata migration failed session=${candidate.id}: ${error?.message || error}`);
            return candidate;
          }
        }));
      }
      const byId = new Map(candidates.map((candidate) => [candidate.id, candidate]));
      const roots = new Map();
      const resolveRoot = (candidate, seen = new Set()) => {
        if (!candidate || seen.has(candidate.id)) return candidate?.parentSessionId || '';
        if (roots.has(candidate.id)) return roots.get(candidate.id);
        seen.add(candidate.id);
        const explicitOwner = validLinkedSessionId(candidate.row?.ownerSessionId, candidate.id);
        if (explicitOwner && explicitOwner !== candidate.parentSessionId) {
          roots.set(candidate.id, explicitOwner);
          return explicitOwner;
        }
        const parent = byId.get(candidate.parentSessionId);
        const root = parent ? resolveRoot(parent, seen) : (explicitOwner || candidate.parentSessionId);
        roots.set(candidate.id, root);
        return root;
      };
      for (const candidate of candidates) {
        // A child created while the summary load was in flight is newer than
        // the stored row and must never be rolled back by rehydration.
        if (agentSessions.has(candidate.id)) continue;
        const row = candidate.row;
        linkAgentDescriptor({
          id: candidate.id,
          parentSessionId: candidate.parentSessionId,
          ownerSessionId: resolveRoot(candidate),
          owner: 'agent',
          visibility: 'agent-only',
          agent: row.agent || row.sourceName || 'worker',
          agentTag: row.agentTag || row.tag || null,
          cwd: row.cwd || process.cwd(),
          provider: row.provider || null,
          model: row.model || null,
          presetName: row.presetName || row.preset || row.profileId || null,
          effort: row.effort || null,
          fast: row.fast === true,
          modelParameters: row.modelParameters || null,
          taskType: row.taskType || null,
          maxLoopIterations: row.maxLoopIterations,
          permission: row.permission || null,
          permissionMode: row.permissionMode || null,
          toolPermission: row.toolPermission || null,
          schemaAllowedTools: Array.isArray(row.schemaAllowedTools)
            ? row.schemaAllowedTools
            : null,
          sourceType: row.sourceType || 'agent',
          sourceName: row.sourceName || row.agent || 'agent',
          clientHostPid: row.clientHostPid || null,
          createdAt: row.createdAt || null,
          updatedAt: row.updatedAt || row.lastUsedAt || null,
          status: row.closed === true ? 'closed' : (row.status || 'idle'),
          stage: row.closed === true ? 'closed' : (row.stage || row.status || 'idle'),
          messageCount: Number(row.messageCount)
            || (Array.isArray(row.messages) ? row.messages.length : 0),
          lastHandoff: lastStoredAgentHandoff(row),
          closed: row.closed === true,
        });
      }
      agentRehydrated = true;
      return agentSessions.size;
    })().finally(() => {
      if (agentRehydratePromise === loading) agentRehydratePromise = null;
    });
    agentRehydratePromise = loading;
    return loading;
  }

  function agentDescriptor(sessionId) {
    const id = String(sessionId || '').trim();
    const descriptor = agentSessions.get(id);
    if (!descriptor) return null;
    const owner = sessionOwner(id);
    const state = owner?.runtime?.getState?.() || {};
    const status = descriptor.closed
      ? (descriptor.status || 'closed')
      : stateBusy(state)
        ? 'running'
        : (descriptor.status || 'idle');
    return {
      ...descriptor,
      status,
      stage: status,
      messageCount: Array.isArray(state.items) && state.items.length > 0
        ? state.items.length
        : Math.max(0, Number(descriptor.messageCount) || 0),
      updatedAt: descriptor.updatedAt || Date.now(),
    };
  }

  function rootOwnerSessionId(sessionId) {
    const id = String(sessionId || '').trim();
    return agentSessions.get(id)?.ownerSessionId || id || null;
  }

  async function createAgentChild({ spec = {}, prompt = '', tag = null } = {}) {
    await rehydrateAgentSessions();
    const parentSessionId = String(spec.parentSessionId || '').trim();
    if (!parentSessionId) throw new TypeError('agent child parentSessionId is required');
    const ownerSessionId = String(
      spec.ownerSessionId
      || agentSessions.get(parentSessionId)?.ownerSessionId
      || parentSessionId,
    );
    const preset = spec.preset && typeof spec.preset === 'object' ? spec.preset : {};
    const provider = String(preset.provider || spec.provider || '').trim();
    const model = String(preset.model || spec.model || '').trim();
    if (!provider || !model) throw new Error('agent child route is incomplete');
    const sessionProfile = {
      owner: 'agent',
      agent: String(spec.agent || 'worker'),
      parentSessionId,
      ownerSessionId,
      visibility: 'agent-only',
      agentTag: String(spec.agentTag || tag || '').trim() || null,
      taskType: spec.taskType || null,
      maxLoopIterations: spec.maxLoopIterations,
      permission: spec.permission || null,
      permissionMode: spec.permissionMode || null,
      schemaAllowedTools: Array.isArray(spec.schemaAllowedTools)
        ? spec.schemaAllowedTools
        : null,
      sourceType: spec.sourceType || 'agent',
      sourceName: spec.sourceName || spec.agent || 'agent',
      clientHostPid: spec.clientHostPid || null,
    };
    const created = await createSession({
      cwd: spec.cwd || process.cwd(),
      provider,
      model,
      effort: preset.effort,
      fast: preset.fast === true,
      modelParameters: preset.modelParameters,
      toolMode: 'full',
      sessionProfile,
    });
    const descriptor = linkAgentDescriptor({
      id: created.sessionId,
      ...sessionProfile,
      cwd: spec.cwd || process.cwd(),
      provider,
      model,
      presetName: preset.id || preset.name || null,
      effort: preset.effort || null,
      fast: preset.fast === true,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      status: 'idle',
      stage: 'idle',
    });
    void prompt;
    return { session: descriptor, effectiveCwd: descriptor.cwd };
  }

  async function runAgentTurn({
    session,
    prompt,
    context = null,
    onToolResult,
    onTerminalResult,
  } = {}) {
    await rehydrateAgentSessions();
    const sessionId = String(session?.id || session || '').trim();
    const descriptor = agentSessions.get(sessionId);
    if (!descriptor || descriptor.closed) {
      throw new Error(`agent session ${sessionId || '(empty)'} is closed`);
    }
    const entry = await entryForSession(sessionId, {
      cwd: descriptor.cwd,
      provider: descriptor.provider,
      model: descriptor.model,
      toolMode: 'full',
    });
    const target = entry.runtime.submitAndWait;
    if (typeof target !== 'function') {
      throw new TypeError('session runtime must implement submitAndWait');
    }
    descriptor.status = 'running';
    descriptor.stage = 'running';
    descriptor.updatedAt = Date.now();
    try {
      const options = {
        id: `agent-turn-${randomUUID()}`,
        mode: 'prompt',
        priority: 'next',
        context,
        transcriptMeta: { sender: 'lead' },
        ...(entry.runtime.isWireSafe === true || typeof onToolResult !== 'function'
          ? {}
          : { onToolResult }),
      };
      const detail = await target.call(entry.runtime, String(prompt || ''), options);
      if (detail?.status === 'failed') {
        throw new Error(String(detail.error || 'agent session turn failed'));
      }
      if (detail?.status === 'cancelled') {
        throw new Error('agent session turn cancelled');
      }
      const result = detail?.result || { content: '' };
      descriptor.status = 'idle';
      descriptor.stage = 'idle';
      descriptor.lastHandoff = typeof result?.content === 'string' ? result.content : '';
      try { onTerminalResult?.(result); } catch {}
      return result;
    } catch (error) {
      descriptor.status = /cancel/i.test(String(error?.message || '')) ? 'cancelled' : 'error';
      descriptor.stage = descriptor.status;
      throw error;
    } finally {
      descriptor.updatedAt = Date.now();
      retainUnwatched(entry, 'agent child idle');
    }
  }

  function cancelAgentTree(sessionId, reason = 'agent session cancelled') {
    const id = String(sessionId || '').trim();
    if (!id) return Promise.resolve(false);
    const active = agentCancelRuns.get(id);
    if (active) return active;
    let run;
    run = (async () => {
      await rehydrateAgentSessions();
      cancelBackgroundTasks({
        surface: 'agent',
        callerSessionId: id,
        reason,
      });
      const children = [...(agentChildren.get(id) || [])];
      await Promise.all(children.map((childId) => cancelAgentTree(childId, reason)));
      const descriptor = agentSessions.get(id);
      if (!descriptor) return children.length > 0;
      if (descriptor.closed) return true;
      let entry = sessionOwner(id);
      if (!entry) {
        try {
          entry = await entryForSession(id, {
            cwd: descriptor.cwd,
            provider: descriptor.provider,
            model: descriptor.model,
            toolMode: 'full',
          });
        } catch (error) {
          log(`agent cancel load failed session=${id}: ${error?.message || error}`);
        }
      }
      const closeCanonical = entry?.runtime?.closeCanonicalSession;
      if (typeof closeCanonical !== 'function') {
        throw new TypeError('session runtime must implement closeCanonicalSession');
      }
      const closed = await closeCanonical.call(entry.runtime, reason);
      if (closed !== true) throw new Error(`agent session ${id} could not be durably closed`);
      descriptor.closed = true;
      descriptor.status = 'closed';
      descriptor.stage = 'closed';
      descriptor.updatedAt = Date.now();
      return true;
    })().finally(() => {
      if (agentCancelRuns.get(id) === run) agentCancelRuns.delete(id);
    });
    agentCancelRuns.set(id, run);
    return run;
  }

  async function cancelAgentDescendants(parentSessionId, reason = 'parent session cancelled') {
    await rehydrateAgentSessions();
    const parentId = String(parentSessionId || '');
    cancelBackgroundTasks({
      surface: 'agent',
      callerSessionId: parentId,
      reason,
    });
    const children = [...(agentChildren.get(parentId) || [])];
    if (!children.length) return false;
    await Promise.all(children.map((childId) => cancelAgentTree(childId, reason)));
    return true;
  }

  function agentDescendantSessionIds(parentSessionId) {
    const descendants = [];
    const seen = new Set();
    const visit = (parentId) => {
      for (const childId of agentChildren.get(String(parentId || '')) || []) {
        if (seen.has(childId)) continue;
        seen.add(childId);
        descendants.push(childId);
        visit(childId);
      }
    };
    visit(parentSessionId);
    return descendants;
  }

  const agentSurface = Object.freeze({
    canonical: true,
    canRun: (session) => Boolean(agentSessions.get(String(session?.id || ''))),
    createChild: createAgentChild,
    runTurn: runAgentTurn,
  });

  const agentManager = Object.freeze({
    rehydrateAgentSessions,
    descendantSessionIds: agentDescendantSessionIds,
    getSession: (sessionId) => agentDescriptor(sessionId),
    listSessions: ({ includeClosed = false } = {}) => [...agentSessions.keys()]
      .map(agentDescriptor)
      .filter((session) => session && (includeClosed || session.closed !== true)),
    getSessionRuntime: (sessionId) => {
      const session = agentDescriptor(sessionId);
      return session ? { stage: session.stage || session.status || 'idle' } : null;
    },
    async readSessionHandoff(sessionId) {
      const id = String(sessionId || '').trim();
      const descriptor = agentSessions.get(id);
      if (!descriptor) return '';
      if (typeof descriptor.lastHandoff === 'string' && descriptor.lastHandoff.trim()) {
        return descriptor.lastHandoff;
      }
      if (typeof readStoredSession !== 'function') return '';
      const stored = await readStoredSession(id, { includeMessages: true });
      const handoff = lastStoredAgentHandoff(stored);
      if (handoff) descriptor.lastHandoff = handoff;
      return handoff;
    },
    async closeSession(sessionId, reason = 'agent session closed') {
      await rehydrateAgentSessions();
      return cancelAgentTree(sessionId, reason);
    },
    unloadSessionRuntime: () => false,
    hideSessionFromList: () => false,
  });

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

  function desktopReady({ desktopId } = {}, ctx = null) {
    const service = requireDesktopService(desktopId);
    const token = subscriberToken(ctx);
    if (token) service.subscribers.add(token);
    onDesktopReady({ desktopId: service.desktopId, clientToken: token || null });
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
    'desktop.ready': desktopReady,
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
    try { unsubscribeExternalSessionStates(); } catch {}
    externalViewEntries.clear();
    agentSessions.clear();
    agentChildren.clear();
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
    submitSession, materializeSession, recoverActiveGoals, abortSession, approveSession,
    configureSession, stop, releaseClient,
    agentSurface, agentManager, agentDescriptor, rootOwnerSessionId, rehydrateAgentSessions,
    cancelAgentTree, cancelAgentDescendants,
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
