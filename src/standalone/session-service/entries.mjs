/**
 * entries.mjs — lifecycle of one daemon-owned execution entry per live
 * session: creation around an injected runtime, on-demand load of a durable
 * session (single-flight per id), binding of retained external Agent
 * snapshots as view entries, and disposal. Entries are never addressed by
 * clients; sessionId is the only identity outside the service. The three
 * concerns live under ./entries/ and are wired here.
 */
import { createExternalViewBinding } from './entries/external-binding.mjs';
import { createEntryLifecycle } from './entries/lifecycle.mjs';
import { createSessionLoads } from './entries/session-loads.mjs';

/**
 * @param {object} deps
 * @param {(params: object) => Promise<object>} deps.createRuntime
 * @param {Set<object>} deps.sessions
 * @param {Map<string, object>} deps.sessionsById
 * @param {Map<string, Set<string>>} deps.pendingViewers
 * @param {Set<Promise<object>>} deps.pendingDisposals
 * @param {() => boolean} deps.isClosed
 */
export function createSessionEntries({
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
  projection: {
    advance,
    indexSessionEntry,
    schedulePublish,
    sessionOwner,
    externalEntryForView,
    publishExternalSessionState,
  },
  viewers: { subscriberToken, addSubscriber, adoptPendingViewers },
  retention: { updateEntryBusy, retainUnwatched, releaseProjection, stopEvictionSweepIfIdle },
}) {
  const lifecycle = createEntryLifecycle({
    createRuntime,
    revisionEpoch,
    sessions,
    sessionsById,
    pendingDisposals,
    desktopServices,
    onFrame,
    log,
    isClosed,
    indexSessionEntry,
    schedulePublish,
    subscriberToken,
    addSubscriber,
    updateEntryBusy,
    releaseProjection,
    stopEvictionSweepIfIdle,
  });
  const { bindExternalSessionView } = createExternalViewBinding({
    readExternalSessionState,
    pendingViewers,
    log,
    sessionOwner,
    externalEntryForView,
    publishExternalSessionState,
  });
  const loads = createSessionLoads({
    sessionExists,
    log,
    assertAvailable: lifecycle.assertAvailable,
    createEntry: lifecycle.createEntry,
    destroy: lifecycle.destroy,
    bindExternalSessionView,
    advance,
    sessionOwner,
    adoptPendingViewers,
    retainUnwatched,
  });

  return {
    assertAvailable: lifecycle.assertAvailable,
    createEntry: lifecycle.createEntry,
    getOrCreateSessionEntry: loads.getOrCreateSessionEntry,
    loadSessionRuntime: loads.loadSessionRuntime,
    bindExternalSessionView,
    entryForSession: loads.entryForSession,
    liveEntryForView: loads.liveEntryForView,
    destroy: lifecycle.destroy,
  };
}
