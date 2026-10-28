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

/** The digest a paged caller proves its held rows with: over their wire form,
 *  as the caller serializes them. */
export async function heldRowsDigester() {
  const [{ sanitizeForWire }, { transcriptItemsDigest }] = await Promise.all([
    import('../../../../standalone/session-wire-values.mjs'),
    import('../../../../standalone/session-state-patch.mjs'),
  ]);
  return (rows) => transcriptItemsDigest(rows.map((row) => sanitizeForWire(row, 2) ?? null));
}

/** The rows a page reveals never go below this many whatever their size, so
 *  paging always progresses (the caller's own floor). */
const PAGE_MIN_ROWS = 8;

/** The slice of a whole display history (windowStoredTranscript with
 *  `history`) one read receives (`request`):
 *  - `held` (`{ firstId, count, digest }`, the newest rows a paged caller
 *    holds): when the history's newest `held.count` rows are those rows (same
 *    first id and — unless `proven` — the same `digestOf` digest), only the
 *    rows above them: at most `maxRows` (and `limit - held.count`) within
 *    `byteBudget` (`rowBytes(index)`), never fewer than PAGE_MIN_ROWS, with
 *    `heldProven`. Unproven: a tail of at most `maxRows` rows instead
 *    (`heldProven: false`).
 *  - otherwise its newest `limit` rows but the newest `skip` (with
 *    `skippedFirstId`, the oldest skipped row) — or, without a finite limit
 *    (the legacy whole read), every restored row and none of the compaction
 *    archive.
 *  `windowStamp` names the slice within the history (the caller composes the
 *  projection stamp). Slicing only: whatever the depth, a slice carries only
 *  its own rows, and the history never leaves the thread that built it. */
export function storedHistorySlice(history, request = {}, { digestOf = null, rowBytes = null } = {}) {
  if (!history || typeof history !== 'object' || !Array.isArray(history.items)) return history;
  const { transcriptArchivedRows: archivedRows = 0, items, projectionStamp: _stamp, ...fields } = history;
  const sizeOf =
    typeof rowBytes === 'function' ? rowBytes : (index) => Buffer.byteLength(JSON.stringify(items[index] ?? null));
  if (request.cursor) return historyCursorSlice(fields, items, request.cursor, history.transcriptHasOlder, sizeOf);
  const itemLimit = Number(request.limit);
  if (!Number.isFinite(itemLimit)) {
    return {
      ...fields,
      windowStamp: 'whole',
      items: archivedRows > 0 ? items.slice(archivedRows) : items.slice(),
      transcriptHasOlder: false,
    };
  }
  const limit = Math.max(0, Math.floor(itemLimit));
  const held = request.held;
  if (held) {
    const maxRows = Math.max(1, Math.floor(Number(request.maxRows) || limit));
    const end = items.length - held.count;
    const holds =
      end >= 0 &&
      items[end]?.id === held.firstId &&
      (request.proven === true || (typeof digestOf === 'function' && digestOf(items.slice(end)) === held.digest));
    if (!holds) {
      // A fresh tail of one answer, within the same byte budget (and floor).
      const start = budgetedEdge(items.length, -1, items.length, Math.min(limit, maxRows), request.byteBudget, sizeOf);
      return {
        ...fields,
        windowStamp: `${items.length - start}`,
        items: items.slice(start),
        transcriptHasOlder: start > 0 || history.transcriptHasOlder === true,
        heldProven: false,
      };
    }
    const rows = Math.max(0, Math.min(maxRows, limit - held.count));
    const start = budgetedEdge(end, -1, items.length, rows, request.byteBudget, sizeOf);
    return {
      ...fields,
      windowStamp: `${items.length - start}@${held.count}`,
      items: items.slice(start, end),
      transcriptHasOlder: start > 0 || history.transcriptHasOlder === true,
      skippedFirstId: held.firstId,
      heldProven: true,
    };
  }
  const skipped = Math.max(0, Math.min(Math.floor(Number(request.skip) || 0), limit, items.length));
  const end = items.length - skipped;
  const start = Math.max(0, items.length - limit);
  return {
    ...fields,
    windowStamp: skipped ? `${limit}@${skipped}` : `${limit}`,
    items: items.slice(start, end),
    transcriptHasOlder: start > 0 || history.transcriptHasOlder === true,
    ...(skipped ? { skippedFirstId: items[end]?.id ?? null } : {}),
  };
}

/** The far edge of a run of at most `rows` rows within `byteBudget`
 *  (`sizeOf(index)`), never fewer than PAGE_MIN_ROWS whatever their size:
 *  older (`step` -1) ending just before index `from`, or newer (`step` +1)
 *  starting at it. */
function budgetedEdge(from, step, length, rows, byteBudget, sizeOf) {
  const budget = Number(byteBudget) > 0 ? Number(byteBudget) : null;
  const floor = Math.min(rows, PAGE_MIN_ROWS);
  let edge = from;
  let taken = 0;
  let bytes = 0;
  while (taken < rows) {
    const index = step < 0 ? edge - 1 : edge;
    if (index < 0 || index >= length) break;
    const next = budget ? sizeOf(index) : 0;
    if (budget && taken >= floor && bytes + next > budget) break;
    bytes += next;
    taken += 1;
    edge += step;
  }
  return edge;
}

/** The most rows one historical-position read carries, whatever it asks. */
export const CURSOR_PAGE_MAX_ROWS = 512;

/** A cursor's page size: 1 to CURSOR_PAGE_MAX_ROWS rows. */
export function cursorPageRows(maxRows) {
  return Math.min(CURSOR_PAGE_MAX_ROWS, Math.max(1, Math.floor(Number(maxRows) || 1)));
}

/** A historical-position read (`cursor`: `{ before | after, maxRows,
 *  byteBudget }`): the rows directly older than row `before`, or newer than
 *  row `after`, at most `maxRows` within `byteBudget` (PAGE_MIN_ROWS floor),
 *  with whether rows remain past them each way. Rows are located by their
 *  stable id, so a page stays valid while the history only grows; a row the
 *  history no longer holds (compaction, rewind, clear) answers
 *  `cursorMissing`. */
function historyCursorSlice(fields, items, cursor, olderBeyond, sizeOf) {
  const older = cursor.before != null;
  const id = older ? cursor.before : cursor.after;
  const at = items.findIndex((item) => item?.id === id);
  if (at < 0) return { ...fields, windowStamp: 'cursor', items: [], cursorMissing: true };
  const rows = cursorPageRows(cursor.maxRows);
  if (older) {
    const start = budgetedEdge(at, -1, items.length, rows, cursor.byteBudget, sizeOf);
    return {
      ...fields,
      windowStamp: 'cursor',
      items: items.slice(start, at),
      transcriptHasOlder: start > 0 || olderBeyond === true,
      transcriptHasNewer: true,
    };
  }
  const end = budgetedEdge(at + 1, 1, items.length, rows, cursor.byteBudget, sizeOf);
  return {
    ...fields,
    windowStamp: 'cursor',
    items: items.slice(at + 1, end),
    transcriptHasOlder: true,
    transcriptHasNewer: end < items.length,
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
