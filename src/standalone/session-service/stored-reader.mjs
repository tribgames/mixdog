import { sanitizeForWire } from '../session-wire-values.mjs';
import { budgetStoredWindow } from './projection/transcript-window.mjs';

const SLOW_STORED_PROJECTION_MS = 250;
const PROJECTED_FILE_LIMIT = 256;

export function createStoredSessionReader({
  readStoredSession,
  readStoredGoal,
  statStoredSession = null,
  forgetStoredSession = null,
  sessionOwner,
  log,
}) {
  // `${sessionId}|${window}` -> { projectionStamp, fileStamp }: the settled
  // file identity each served projection was built from. The 1s cold-view
  // refresh asks again with the stamp it holds; while the files still carry
  // that identity nothing is read. The store's transcript cache cannot give
  // that guarantee once several 512-item views exceed its byte budget: it
  // evicts each one just before its next refresh.
  const projectedFiles = new Map();
  // The stored reader returns its cached projection object for unchanged
  // content and callers never mutate it, so identity keys the wire clone. The
  // 1s cold-view refresh otherwise re-sanitized the whole transcript per tick.
  // Keyed weakly: dropping the store's cache entry releases the clone too.
  const wireSnapshots = new WeakMap();
  function wireSnapshot(snapshot, window) {
    const budget = `${window?.byteBudget ?? ''}:${window?.pageBase ?? ''}`;
    let cached = wireSnapshots.get(snapshot);
    if (!cached || cached.budget !== budget) {
      const wire = cached?.wire ?? sanitizeForWire(snapshot);
      cached = { wire, budget, value: budgetStoredWindow(wire, window) };
      wireSnapshots.set(snapshot, cached);
    }
    return cached.value;
  }

  /** Drop every cold projection the store retains for this session. */
  function forgetStoredProjection(sessionId) {
    for (const key of [...projectedFiles.keys()]) {
      if (key.startsWith(`${sessionId}|`)) projectedFiles.delete(key);
    }
    if (typeof forgetStoredSession !== 'function') return;
    void Promise.resolve()
      .then(() => forgetStoredSession(sessionId))
      .catch((err) => log(`stored projection release failed session=${sessionId}: ${err?.message || err}`));
  }

  function traceStoredProjectionRead({ sessionId, hit, ms, chars, items }) {
    // Shared parse waiters are cache hits; report only the parse itself.
    if (hit || ms < SLOW_STORED_PROJECTION_MS) return;
    log(`slow stored projection session=${sessionId} ${Math.round(ms)}ms` + ` chars=${chars} items=${items}`);
  }

  const itemLimitFor = (hints, window) => {
    const requested = window ? window.limit : Number(hints?.resumeOptions?.transcriptItemLimit);
    return Number.isFinite(requested) && requested > 0 ? requested : 512;
  };
  const projectedKey = (sessionId, hints, window) =>
    `${sessionId}|${itemLimitFor(hints, window)}:${window?.byteBudget ?? ''}:${window?.pageBase ?? ''}`;

  async function fileStampOf(sessionId) {
    if (typeof statStoredSession !== 'function') return null;
    try {
      return (await statStoredSession(sessionId)) || null;
    } catch {
      return null;
    }
  }

  /** Whether the projection a caller holds (`projectionStamp`, read through
   *  this same window) is still what the files would produce: they carry the
   *  settled identity it was built from. */
  async function storedProjectionUnchanged(sessionId, hints, window, projectionStamp) {
    const key = projectedKey(sessionId, hints, window);
    const record = projectedFiles.get(key);
    if (!record || record.projectionStamp !== projectionStamp) return false;
    const fileStamp = await fileStampOf(sessionId);
    if (fileStamp === null || fileStamp !== record.fileStamp) {
      if (projectedFiles.get(key) === record) projectedFiles.delete(key);
      return false;
    }
    projectedFiles.delete(key);
    projectedFiles.set(key, record);
    return true;
  }

  /** `window` (from requestedTranscriptWindow) selects a paged tail; without
   *  one, the resume hint (default 512 items) keeps the legacy page. */
  async function storedSessionProjection(sessionId, hints, window = null) {
    if (typeof readStoredSession !== 'function') return null;
    const key = projectedKey(sessionId, hints, window);
    // stat -> read -> stat: the projection is attributed to a file identity
    // only when no write can have landed while it was read.
    const fileStamp = await fileStampOf(sessionId);
    let snapshot = null;
    try {
      snapshot = await readStoredSession(sessionId, {
        transcriptItemLimit: itemLimitFor(hints, window),
        trace: traceStoredProjectionRead,
      });
    } catch (err) {
      log(`stored session projection failed session=${sessionId}: ${err?.message || err}`);
      return null;
    }
    if (!snapshot || typeof snapshot !== 'object') return null;
    projectedFiles.delete(key);
    if (
      fileStamp !== null &&
      typeof snapshot.projectionStamp === 'string' &&
      snapshot.projectionStamp &&
      (await fileStampOf(sessionId)) === fileStamp
    ) {
      projectedFiles.set(key, { projectionStamp: snapshot.projectionStamp, fileStamp });
      if (projectedFiles.size > PROJECTED_FILE_LIMIT) projectedFiles.delete(projectedFiles.keys().next().value);
    }
    let goal;
    if (typeof readStoredGoal === 'function') {
      try {
        goal = (await readStoredGoal(sessionId)) ?? null;
      } catch (err) {
        log(`stored Goal projection failed session=${sessionId}: ${err?.message || err}`);
        goal = null;
      }
    }
    const wire = wireSnapshot(snapshot, window);
    return {
      ...wire,
      sessionId,
      ...(typeof readStoredGoal === 'function' ? { goal: sanitizeForWire(goal, 1) ?? null } : {}),
      queued: Array.isArray(snapshot.queued) ? wire.queued : [],
    };
  }

  async function requestedMessageSlice(params, sessionId) {
    if (!Number.isInteger(params?.messageStart)) return {};
    const start = Math.max(0, params.messageStart);
    // A live reader is authoritative. Its failure cannot be substituted with
    // disk state that may predate the most recent completed turn.
    const live = sessionOwner(sessionId);
    if (live && typeof live.runtime?.readModelMessages === 'function') {
      const result = await live.runtime.readModelMessages(start);
      if (!result || !Array.isArray(result.messages)) {
        throw new TypeError('live session transcript is invalid');
      }
      return {
        messageCount: Math.max(0, Number(result.messageCount) || result.messages.length),
        messages: sanitizeForWire(result.messages),
      };
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

  return {
    storedSessionProjection,
    storedProjectionUnchanged,
    requestedMessageSlice,
    forgetStoredSession: forgetStoredProjection,
  };
}
