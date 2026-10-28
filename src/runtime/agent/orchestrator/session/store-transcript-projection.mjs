/**
 * The parse/recovery/projection body of one stored transcript read: durable
 * turn-checkpoint recovery for interrupted turns, the read-only checkpoint
 * projection for a live turn, the cold context projection and the
 * pane-facing transcript shape.
 *
 * Kept apart from the cache/fingerprint policy in store-summary-reader.mjs
 * because this runs exactly once per distinct content and is the only part
 * that lazily enters the heavier reconnect-recovery boundary (dynamic imports
 * keep the cold summary path leaf-only).
 */
import { sessionContextMeasurement, contextMeasurementStats } from '../../../shared/context-measurement.mjs';
import { nextProjectionStamp } from './store-transcript-cache.mjs';
import { join } from 'node:path';
import { desktopSession, positiveNumber } from './store-summary-fields.mjs';
import { compactionArchiveRange, readCompactionArchivePage } from './compaction-archive.mjs';
import { dataDir } from './store-summary-locations.mjs';

/** The parse/recovery/projection body of a stored transcript read. Runs once
 *  per distinct content; its result is shared read-only through the cache. */
export async function projectStoredTranscript(sessionId, doc, options) {
  return windowStoredTranscript(sessionId, await prepareStoredTranscriptBase(sessionId, doc, options), options);
}

/** The window-independent half of a projection: recovery, the prepared
 *  session and its whole-transcript context gauge. Every transcript window of
 *  the same content is cut from one base (windowStoredTranscript), which
 *  never mutates it. */
export async function prepareStoredTranscriptBase(sessionId, doc, options) {
  let session = doc;
  if (!options.checkpointAbsent) {
    const { projectTurnCheckpointMessages, readTurnCheckpoint } = await import('./manager/turn-checkpoint.mjs');
    const projectCheckpoint = () => {
      const checkpoint = readTurnCheckpoint(sessionId);
      if (checkpoint) session = { ...session, messages: projectTurnCheckpointMessages(session, checkpoint) };
    };
    const { isSessionTurnLive, recoverSessionAfterProcessRestart } = await import(
      './manager/turn-checkpoint-recovery.mjs'
    );
    // A running turn is never recovered: project its checkpoint read-only.
    if (isSessionTurnLive(sessionId)) projectCheckpoint();
    else {
      session = recoverSessionAfterProcessRestart(sessionId) || session;
      // A closed session keeps its marker unrecovered.
      if (session?.activeTurnCheckpoint) projectCheckpoint();
    }
  }
  const { sessionContextSnapshotProjection } = await import('./transcript-restore/restore.mjs');
  let preparedContextProjection = null;
  try {
    const [{ prepareSessionProjection }, { createContextStatus }, { primeContextEstimates }] = await Promise.all([
      import('./manager.mjs'),
      import('../runtime-core/context-status.mjs'),
      import('./context-utils.mjs'),
    ]);
    const prepared = prepareSessionProjection(session, 'full');
    if (prepared) session = prepared;
    // The gauge below prices the whole cold transcript synchronously; meter
    // it (and the baseline signatures it will read) in event-loop slices
    // first so that pass reads the per-message memos. Same values, and the
    // memos stay with the message objects for a later resume of them.
    const gaugeMessages = Array.isArray(session.liveTurnMessages) ? session.liveTurnMessages : session.messages;
    await primeContextEstimates(gaugeMessages, session);
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
    session,
    messages,
    contextFields: preparedContextProjection
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
        },
  };
}

/** The window of a whole display history (windowStoredTranscript with
 *  `history`) a read with `itemLimit` receives: its newest `itemLimit` rows,
 *  or — without a finite limit, the legacy whole read — every restored row
 *  and none of the compaction archive. Slicing only: the history is built once
 *  per content and shared read-only. The stamp names the history and the
 *  limit, so an unchanged history keeps answering a held window unchanged. */
export function storedHistoryWindow(history, itemLimit) {
  if (!history || typeof history !== 'object' || !Array.isArray(history.items)) return history;
  const { transcriptArchivedRows: archivedRows = 0, items, ...fields } = history;
  if (!Number.isFinite(itemLimit)) {
    return {
      ...fields,
      projectionStamp: `${history.projectionStamp}/whole`,
      items: archivedRows > 0 ? items.slice(archivedRows) : items,
      transcriptHasOlder: false,
    };
  }
  const older = items.length > itemLimit;
  return {
    ...fields,
    projectionStamp: `${history.projectionStamp}/${itemLimit}`,
    items: older ? items.slice(-itemLimit) : items,
    transcriptHasOlder: older || history.transcriptHasOlder === true,
  };
}

/** One transcript window (`options.itemLimit`, default whole) of a base.
 *  `options.history`: the whole display history instead — every restored row
 *  after every row of the visible compaction archive, with
 *  `transcriptArchivedRows` naming how many lead it. Every window is a tail
 *  of it (storedHistoryWindow). */
export async function windowStoredTranscript(sessionId, base, options) {
  const { session, messages, contextFields } = base;
  const { restoreTranscriptItems } = await import('./transcript-restore/restore.mjs');
  const history = options.history === true;
  // Restoring one item past a finite limit proves whether older history exists
  // without projecting it; restore ids are message-positional, so the kept
  // tail is identical either way.
  const itemLimit = !history && Number.isFinite(options.itemLimit) ? options.itemLimit : Number.POSITIVE_INFINITY;
  const restored = restoreTranscriptItems(messages, { sessionId, itemLimit: itemLimit + 1 });
  let transcriptHasOlder = restored.length > itemLimit;
  let items = transcriptHasOlder ? restored.slice(-itemLimit) : restored;
  let archivedRows = 0;
  // A paged window continues past the first stored message into the
  // display-only compaction archive (newest segment first). A legacy whole
  // read never receives it.
  const archiveRange =
    history || (Number.isFinite(itemLimit) && !transcriptHasOlder) ? compactionArchiveRange(session) : null;
  if (archiveRange) {
    const archived = await readCompactionArchivePage(join(dataDir(), 'sessions'), sessionId, {
      ...archiveRange,
      limit: history ? Number.POSITIVE_INFINITY : itemLimit - restored.length,
    });
    if (archived.items.length) items = [...archived.items, ...restored];
    archivedRows = archived.items.length;
    transcriptHasOlder = archived.hasOlder;
  }
  return {
    sessionId,
    projectionStamp: nextProjectionStamp(),
    ...(options.includeMessages ? { messages } : {}),
    items,
    transcriptHasOlder,
    ...(history ? { transcriptArchivedRows: archivedRows } : {}),
    provider: session.provider || '',
    model: session.model || '',
    effort: session.effort || '',
    fast: session.fast === true,
    ...(session.autoEffort === false ? { autoEffort: false } : {}),
    modelParameters: session.modelParameters || {},
    cwd: session.cwd || '',
    desktopSession: desktopSession(session.desktopSession, session.cwd),
    workflow: session.workflow || null,
    ...contextFields,
  };
}
