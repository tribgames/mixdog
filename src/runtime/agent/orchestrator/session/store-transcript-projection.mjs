/**
 * The parse/recovery/projection body of one stored transcript read: durable
 * turn-checkpoint recovery for interrupted turns, the read-only checkpoint
 * projection for a live foreign owner, the cold context projection and the
 * pane-facing transcript shape.
 *
 * Kept apart from the cache/fingerprint policy in store-summary-reader.mjs
 * because this runs exactly once per distinct content and is the only part
 * that lazily enters the heavier reconnect-recovery boundary (dynamic imports
 * preserved verbatim so the cold summary path stays leaf-only).
 */
import { sessionContextMeasurement, contextMeasurementStats } from '../../../../ui/context-measurement.mjs';
import { nextProjectionStamp } from './store-transcript-cache.mjs';
import { cleanValue, desktopSession, positiveNumber } from './store-summary-fields.mjs';

/** The parse/recovery/projection body of a stored transcript read. Runs once
 *  per distinct content; its result is shared read-only through the cache. */
export async function projectStoredTranscript(sessionId, doc, options) {
  let session = doc;
  const owner = cleanValue(session.owner).toLowerCase();
  const agent = cleanValue(session.agent).toLowerCase();
  const liveDetachedAgent =
    session.closed === true &&
    (owner === 'agent' || (agent && agent !== 'lead')) &&
    Boolean(cleanValue(session.ownerSessionId || session.parentSessionId));
  if (!options.checkpointAbsent) {
    const { projectTurnCheckpointMessages, readTurnCheckpoint } = await import('./manager/turn-checkpoint.mjs');
    if (liveDetachedAgent) {
      const checkpoint = readTurnCheckpoint(sessionId);
      if (checkpoint) {
        session = {
          ...session,
          messages: projectTurnCheckpointMessages(session, checkpoint),
        };
      }
    } else {
      const { recoverSessionAfterProcessRestart } = await import('./manager.mjs');
      session = recoverSessionAfterProcessRestart(sessionId) || session;
      // A live foreign owner is intentionally not recovered/mutated.
      // Project its durable working checkpoint read-only so the cold pane
      // never repaints the stale pre-compaction session.messages while it
      // waits for the owner's live-share frame.
      if (session?.activeTurnCheckpoint) {
        const checkpoint = readTurnCheckpoint(sessionId);
        if (checkpoint) {
          session = {
            ...session,
            messages: projectTurnCheckpointMessages(session, checkpoint),
          };
        }
      }
    }
  }
  const { restoreTranscriptItems, sessionContextSnapshotProjection } = await import(
    '../../../../tui/session/session-api-ext.mjs'
  );
  let preparedContextProjection = null;
  try {
    const [{ prepareSessionProjection }, { createContextStatus }] = await Promise.all([
      import('./manager.mjs'),
      import('../../../../session-runtime/context-status.mjs'),
    ]);
    const prepared = prepareSessionProjection(session, 'full');
    if (prepared) session = prepared;
    const { contextStatus } = createContextStatus({
      getSession: () => session,
      getRoute: () => ({
        provider: session.provider || '',
        model: session.model || '',
        contextWindow: session.contextWindow || null,
      }),
      getCurrentCwd: () => session.cwd || '',
      getMode: () => 'full',
    });
    preparedContextProjection = sessionContextSnapshotProjection(session, contextStatus());
  } catch {
    // Cold context projection is presentation-only. The transcript and
    // legacy estimator below remain available if provider/tool prep fails.
  }
  const messages = Array.isArray(session.messages) ? session.messages : [];
  const hasConversationActivity = messages.some((message) => message?.role === 'user');
  const measuredStats = contextMeasurementStats({
    measurement: sessionContextMeasurement(session, hasConversationActivity),
  });
  const contextWindow = positiveNumber(session.contextWindow);
  const rawContextWindow = positiveNumber(session.rawContextWindow, contextWindow);
  const displayContextWindow = positiveNumber(session.compactBoundaryTokens, contextWindow);
  const rawAutoCompactTokenLimit = positiveNumber(session.autoCompactTokenLimit);
  const autoCompactTokenLimit =
    rawAutoCompactTokenLimit && (!displayContextWindow || rawAutoCompactTokenLimit < displayContextWindow)
      ? rawAutoCompactTokenLimit
      : 0;
  return {
    sessionId,
    projectionStamp: nextProjectionStamp(),
    ...(options.includeMessages ? { messages } : {}),
    items: restoreTranscriptItems(messages, {
      sessionId,
      itemLimit: options.itemLimit,
    }),
    provider: session.provider || '',
    model: session.model || '',
    effort: session.effort || '',
    fast: session.fast === true,
    modelParameters: session.modelParameters || {},
    cwd: session.cwd || '',
    desktopSession: desktopSession(session.desktopSession, session.cwd),
    workflow: session.workflow || null,
    ...(preparedContextProjection
      ? {
          ...preparedContextProjection,
          preparedContextProjection: true,
        }
      : {
          stats: measuredStats,
          contextWindow: contextWindow || null,
          rawContextWindow: rawContextWindow || null,
          displayContextWindow: displayContextWindow || null,
          autoCompactTokenLimit: autoCompactTokenLimit || null,
        }),
    // Desktop must not ask its unrelated active engine to recover/peek an
    // externally owned child: that runtime can only return the detached
    // Task row and masks this checkpoint projection.
    readOnlyDetachedAgent: liveDetachedAgent,
  };
}
