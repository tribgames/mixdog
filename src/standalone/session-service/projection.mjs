/**
 * src/standalone/session-service/projection.mjs - wire projection and frame
 * publication for daemon-owned session entries: identity-cached snapshots,
 * revision steps with deltas, session-address indexing, and external (agent)
 * session views. Each concern lives under ./projection/; this file wires them.
 */
import { createSessionAddressIndex } from './projection/address-index.mjs';
import { createExternalViews } from './projection/external-views.mjs';
import { createFramePublisher } from './projection/frames.mjs';
import { bodyForClient, createRevisionSteps } from './projection/revisions.mjs';

export function createSessionProjection({
  sessionsById,
  externalViewEntries,
  pendingViewers,
  externalSessionActions,
  revisionEpoch,
  publishIntervalMs,
  invokeExternalSessionAction = null,
  onFrame,
  log,
  isClosed,
  addSubscriber,
  adoptPendingViewers,
  updateEntryBusy,
  releaseProjection,
}) {
  const index = createSessionAddressIndex({ sessionsById, externalViewEntries, addSubscriber });
  const { advance, projectionResult } = createRevisionSteps({ revisionEpoch, index, updateEntryBusy });
  const frames = createFramePublisher({
    index,
    advance,
    onFrame,
    log,
    isClosed,
    publishIntervalMs,
    updateEntryBusy,
    releaseProjection,
  });
  const externalViews = createExternalViews({
    externalViewEntries,
    pendingViewers,
    externalSessionActions,
    revisionEpoch,
    invokeExternalSessionAction,
    isClosed,
    adoptPendingViewers,
    index,
    advance,
    publishStep: frames.publishStep,
  });

  return {
    advance,
    projectionResult,
    currentSessionId: index.currentSessionId,
    indexSessionEntry: index.indexSessionEntry,
    publishStep: frames.publishStep,
    externalEntryForView: externalViews.externalEntryForView,
    publishExternalSessionState: externalViews.publishExternalSessionState,
    bodyForClient,
    sessionOwner: index.sessionOwner,
    schedulePublish: frames.schedulePublish,
  };
}
