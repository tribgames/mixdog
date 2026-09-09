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
import {
  SESSION_CONFIGURE_ACTION_SET,
  SESSION_READ_ACTION_SET,
} from './session-protocol.mjs';
import { DesktopServiceRegistry } from './desktop-service-registry.mjs';
import { createSessionServiceApi } from './session-service-api.mjs';
import { sanitizeForWire } from './session-wire-values.mjs';
import { createAgentTree, SESSION_ID_PATTERN } from './session-service/agent-tree.mjs';
import { createProjectCatalog } from './session-service/project-catalog.mjs';
import { createSessionProjection } from './session-service/projection.mjs';
import {
  materializePromptSubmission,
  preparePromptSubmissionForProvider,
} from '../runtime/attachments/store.mjs';
import {
  cancelBackgroundTasks,
  hasActiveBackgroundTasks,
} from '../runtime/shared/background-tasks.mjs';

const EXTERNAL_SESSION_ACTIONS = new Set([
  ...SESSION_READ_ACTION_SET,
  ...SESSION_CONFIGURE_ACTION_SET,
  'submitAsync',
  'abort',
  'resolveToolApproval',
]);

export { sanitizeForWire } from './session-wire-values.mjs';

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
  // snapshots remain the durable contract. Seed the shared projection clock
  // above the prior wall-clock epoch so a reconnect accepts the new daemon.
  const configuredRevisionEpoch = Number(process.env.MIXDOG_SESSION_REVISION_EPOCH);
  const revisionEpoch = Number.isSafeInteger(configuredRevisionEpoch)
    && configuredRevisionEpoch >= 0
    ? configuredRevisionEpoch
    : Math.floor(Date.now() * 1_000);

  // One daemon-owned execution entry per live session. Entries are never
  // addressed by clients; sessionId is the only identity outside this module.
  const sessions = new Set();
  const sessionsById = new Map();
  const desktopServices = new DesktopServiceRegistry({
    runtime: desktopRuntime,
    onFrame,
    log,
    onExternalClientsChanged,
    onReady: onDesktopReady,
  });
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
    desktopServices.releaseClient(token);
    return { ok: true };
  }

  function stateBusy(state) {
    return state?.busy === true || state?.commandBusy === true
      || (Array.isArray(state?.queued) && state.queued.length > 0);
  }

  function updateEntryBusy(entry, state) {
    const next = stateBusy(state);
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

  // Wire projection + frame publication (see session-service/projection.mjs).
  // Function declarations above reference these only from inside bodies that
  // run after construction, so the late destructure is safe.
  const {
    advance,
    currentSessionId,
    indexSessionEntry,
    publishStep,
    externalEntryForView,
    publishExternalSessionState,
    bodyForClient,
    projectionResult,
    sessionOwner,
    schedulePublish,
  } = createSessionProjection({
    sessionsById,
    externalViewEntries,
    pendingViewers,
    externalSessionActions: EXTERNAL_SESSION_ACTIONS,
    revisionEpoch,
    publishIntervalMs,
    invokeExternalSessionAction,
    onFrame,
    log,
    isClosed: () => closed,
    addSubscriber,
    adoptPendingViewers,
    updateEntryBusy,
    releaseProjection,
  });

  const unsubscribeExternalSessionStates =
    typeof subscribeExternalSessionStates === 'function'
      ? subscribeExternalSessionStates(publishExternalSessionState)
      : () => {};

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

  const {
    loadProjectStore,
    listProjectCatalog,
    inspectProjectPath,
    addProjectEntry,
    touchProjectEntry,
    renameProjectEntry,
    removeProjectEntry,
    ensureProjectDirectory,
  } = createProjectCatalog({ desktopRuntime });

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
      // Allocate the snapshot's revision before an optional history read can
      // yield to a newer live publication. Matching content keeps the caller's
      // baseline and carries no body.
      const result = projectionResult(id, projection, {
        baseRevision,
        baseProjectionStamp,
        allowUnchanged: !Number.isInteger(params.messageStart),
      });
      return { ...result, ...await requestedMessageSlice(params, id) };
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
      return { ...projectionResult(id, projection), subscribed: true };
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
    const abortsAgentTurn = agentTree.hasAgentSession(id)
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

  const agentTree = createAgentTree({
    listSessions,
    readStoredSession,
    log,
    sessionOwner,
    stateBusy,
    entryForSession,
    retainUnwatched,
    createSession,
  });
  const {
    agentDescriptor,
    rootOwnerSessionId,
    rehydrateAgentSessions,
    cancelAgentTree,
    cancelAgentDescendants,
    agentSurface,
    agentManager,
  } = agentTree;

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
    entry.busy = false;
    // Publish before asynchronous disposal: a newly resumed incarnation must
    // never receive a delayed teardown belonging to this old runtime.
    if (sessionId) desktopServices.notifySessionRuntimeReleased(sessionId, reason);
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

  async function stop(reason = 'service stop') {
    closed = true;
    try { unsubscribeExternalSessionStates(); } catch {}
    externalViewEntries.clear();
    agentTree.clear();
    if (evictTimer) { clearInterval(evictTimer); evictTimer = null; }
    await desktopServices.dispose(reason);
    for (const entry of [...sessions]) {
      await destroy(entry, reason);
    }
  }

  return createSessionServiceApi({
    desktop: desktopServices,
    project: {
      list: listProjectCatalog,
      inspect: inspectProjectPath,
      add: addProjectEntry,
      touch: touchProjectEntry,
      rename: renameProjectEntry,
      remove: removeProjectEntry,
      ensureDirectory: ensureProjectDirectory,
    },
    session: {
      list: listSessionCatalog,
      create: createSession,
      read: readSession,
      subscribe: subscribeSession,
      unsubscribe: unsubscribeSession,
      submit: submitSession,
      abort: abortSession,
      approve: approveSession,
      configure: configureSession,
    },
    methods: {
      listSessionCatalog,
      createSession,
      readSession,
      subscribeSession,
      unsubscribeSession,
      submitSession,
      materializeSession,
      recoverActiveGoals,
      abortSession,
      approveSession,
      configureSession,
      stop,
      releaseClient,
      agentSurface,
      agentManager,
      agentDescriptor,
      rootOwnerSessionId,
      rehydrateAgentSessions,
      cancelAgentTree,
      cancelAgentDescendants,
    },
    getSize: () => sessions.size,
    getBusyCount: liveBusyCount,
    getStatus: () => {
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
    getExternalClientCount: () => desktopServices.externalClientCount,
  });
}
