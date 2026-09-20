// Session runtime pool hosted by the machine-global daemon.
//
// One process owns every live session runtime; the terminal TUI and the desktop
// app attach as VIEWS over the transport. That inverts today's model (each
// client boots its own session runtime and the session store arbitrates ownership with
// generation counters + heartbeat vetoes): with a single writer, cross-client
// editing is just fan-out, and the split-brain guards can never trip against
// our own second client.
//
// The session runtime factory is injected by the daemon entry. This file is
// the composition root: shared pool state, configuration, the sub-services
// (retention, viewers, projection, entries, session calls, agent tree,
// project catalog) and shutdown. See session-service/*.mjs.
import { SESSION_CONFIGURE_ACTION_SET, SESSION_READ_ACTION_SET } from './session-protocol.mjs';
import { DesktopServiceRegistry } from './desktop-service-registry.mjs';
import { createSessionServiceApi } from './session-service-api.mjs';
import { createAgentTree } from './session-service/agent-tree.mjs';
import { createProjectCatalog } from './session-service/project-catalog.mjs';
import { createSessionProjection } from './session-service/projection.mjs';
import { createStoredSessionReader } from './session-service/stored-reader.mjs';
import { createSessionRetention } from './session-service/retention.mjs';
import { createViewerRegistry } from './session-service/viewers.mjs';
import { createSessionEntries } from './session-service/entries.mjs';
import { createSessionCalls } from './session-service/session-calls.mjs';

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
  const revisionEpoch =
    Number.isSafeInteger(configuredRevisionEpoch) && configuredRevisionEpoch >= 0
      ? configuredRevisionEpoch
      : Math.floor(Date.now() * 1_000);

  // One daemon-owned execution entry per live session. Entries are never
  // addressed by clients; sessionId is the only identity outside this module.
  const sessions = new Set();
  const sessionsById = new Map();
  const pendingDisposals = new Set();
  const pendingViewers = new Map(); // sessionId -> Set<clientToken>
  const externalViewEntries = new Map(); // sessionId -> ordinary projected entry
  const desktopServices = new DesktopServiceRegistry({
    runtime: desktopRuntime,
    onFrame,
    log,
    onExternalClientsChanged,
    onReady: onDesktopReady,
  });
  let closed = false;
  let stopPromise = null;
  const isClosed = () => closed;
  // Idle-eviction and projection-reclaim budgets (see session-service/retention.mjs).
  const IDLE_EVICT_MS =
    Number(idleEvictMs) > 0
      ? Number(idleEvictMs)
      : Math.max(60_000, Number(process.env.MIXDOG_SESSION_IDLE_EVICT_MS) || 5 * 60_000);
  const EVICT_SWEEP_MS = Number(evictSweepMs) > 0 ? Number(evictSweepMs) : 30_000;
  const PROJECTION_IDLE_MS = Math.max(15_000, Number(process.env.MIXDOG_SESSION_PROJECTION_IDLE_MS) || 90_000);

  // Retention and viewers need `currentSessionId` (projection) and `destroy`
  // (entries), which are built after them; both are only called at runtime,
  // so the late thunks resolve once construction has finished.
  const retention = createSessionRetention({
    sessions,
    isClosed,
    idleEvictMs: IDLE_EVICT_MS,
    evictSweepMs: EVICT_SWEEP_MS,
    projectionIdleMs: PROJECTION_IDLE_MS,
    currentSessionId: (entry) => projection.currentSessionId(entry),
    destroy: (entry, reason, options) => entries.destroy(entry, reason, options),
  });
  const viewers = createViewerRegistry({
    sessions,
    pendingViewers,
    externalViewEntries,
    desktopServices,
    log,
    startEvictionSweep: retention.startEvictionSweep,
    sessionBusy: retention.sessionBusy,
    currentSessionId: (entry) => projection.currentSessionId(entry),
    destroy: (entry, reason, options) => entries.destroy(entry, reason, options),
  });
  // Wire projection + frame publication (see session-service/projection.mjs).
  const projection = createSessionProjection({
    sessionsById,
    externalViewEntries,
    pendingViewers,
    externalSessionActions: EXTERNAL_SESSION_ACTIONS,
    revisionEpoch,
    publishIntervalMs,
    invokeExternalSessionAction,
    onFrame,
    log,
    isClosed,
    addSubscriber: viewers.addSubscriber,
    adoptPendingViewers: viewers.adoptPendingViewers,
    updateEntryBusy: retention.updateEntryBusy,
    releaseProjection: retention.releaseProjection,
  });
  const unsubscribeExternalSessionStates =
    typeof subscribeExternalSessionStates === 'function'
      ? subscribeExternalSessionStates(projection.publishExternalSessionState)
      : () => {};
  const entries = createSessionEntries({
    createRuntime,
    sessionExists,
    readExternalSessionState,
    revisionEpoch,
    sessions,
    sessionsById,
    pendingViewers,
    pendingDisposals,
    desktopServices,
    onFrame,
    log,
    isClosed,
    projection,
    viewers,
    retention,
  });
  const storedReader = createStoredSessionReader({
    readStoredSession,
    readStoredGoal,
    sessionOwner: projection.sessionOwner,
    log,
  });
  const projectCatalog = createProjectCatalog({ desktopRuntime });
  const calls = createSessionCalls({
    isClosed,
    log,
    listSessions,
    getRemoteSessionState,
    readStoredSession,
    readStoredGoal,
    listStoredActiveGoalSessionIds,
    externalViewEntries,
    loadProjectStore: projectCatalog.loadProjectStore,
    hasAgentSession: (sessionId) => agentTree.hasAgentSession(sessionId),
    projection,
    viewers,
    retention,
    entries,
    storedReader,
  });
  const agentTree = createAgentTree({
    listSessions,
    readStoredSession,
    log,
    sessionOwner: projection.sessionOwner,
    stateBusy: retention.stateBusy,
    entryForSession: entries.entryForSession,
    retainUnwatched: retention.retainUnwatched,
    createSession: calls.createSession,
  });

  function stop(reason = 'service stop') {
    if (stopPromise) return stopPromise;
    closed = true;
    stopPromise = Promise.resolve().then(async () => {
      try {
        unsubscribeExternalSessionStates();
      } catch {}
      externalViewEntries.clear();
      pendingViewers.clear();
      agentTree.clear();
      retention.stopSweep();
      await desktopServices.dispose(reason);
      for (const entry of [...sessions]) await entries.destroy(entry, reason);
      // Retired entries have already left the address map, but their resource
      // release remains part of this service's shutdown barrier.
      await Promise.allSettled([...pendingDisposals]);
    });
    return stopPromise;
  }

  function getStatus() {
    const busy = retention.liveBusyCount();
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
      evictionSweepActive: retention.sweepActive(),
    };
  }

  return createSessionServiceApi({
    desktop: desktopServices,
    project: {
      list: projectCatalog.listProjectCatalog,
      inspect: projectCatalog.inspectProjectPath,
      add: projectCatalog.addProjectEntry,
      touch: projectCatalog.touchProjectEntry,
      rename: projectCatalog.renameProjectEntry,
      remove: projectCatalog.removeProjectEntry,
      ensureDirectory: projectCatalog.ensureProjectDirectory,
    },
    session: {
      list: calls.listSessionCatalog,
      create: calls.createSession,
      read: calls.readSession,
      subscribe: calls.subscribeSession,
      unsubscribe: calls.unsubscribeSession,
      submit: calls.submitSession,
      abort: calls.abortSession,
      approve: calls.approveSession,
      configure: calls.configureSession,
    },
    methods: {
      ...calls,
      stop,
      releaseClient: viewers.releaseClient,
      agentSurface: agentTree.agentSurface,
      agentManager: agentTree.agentManager,
      agentDescriptor: agentTree.agentDescriptor,
      rootOwnerSessionId: agentTree.rootOwnerSessionId,
      rehydrateAgentSessions: agentTree.rehydrateAgentSessions,
      cancelAgentTree: agentTree.cancelAgentTree,
      cancelAgentDescendants: agentTree.cancelAgentDescendants,
    },
    getSize: () => sessions.size,
    getBusyCount: retention.liveBusyCount,
    getStatus,
    getExternalClientCount: () => desktopServices.externalClientCount,
  });
}
