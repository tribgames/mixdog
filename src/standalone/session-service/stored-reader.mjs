import { sanitizeForWire } from '../session-wire-values.mjs';
import {
  clampStoredPage,
  clampStoredWindow,
  holdsTranscriptTail,
  TRANSCRIPT_RESPONSE_MAX_ITEMS,
} from './projection/transcript-window.mjs';

const SLOW_STORED_PROJECTION_MS = 250;
const PROJECTED_FILE_LIMIT = 256;

// Every window of a stored session is a slice of the store's one cached
// display history, so its rows are the same objects page after page: each
// is sanitized once (keyed weakly — dropping the store's cache entry
// releases the clones) and a page costs a slice, not a whole-window clone.
const wireItems = new WeakMap();
function wireItem(item) {
  if (!item || typeof item !== 'object') return sanitizeForWire(item, 2) ?? null;
  let wire = wireItems.get(item);
  if (wire === undefined) {
    wire = sanitizeForWire(item, 2) ?? null;
    wireItems.set(item, wire);
  }
  return wire;
}
// The store returns one object per unchanged window, so a repeated read
// reuses its wire clone (the 1s cold-view refresh would re-clone it).
const wireSnapshots = new WeakMap();
function wireSnapshot(snapshot) {
  let wire = wireSnapshots.get(snapshot);
  if (!wire) {
    // The slice's own proof fields stay here.
    const { items, heldProven: _heldProven, skippedFirstId: _skippedFirstId, ...fields } = snapshot;
    wire = sanitizeForWire(fields);
    if (Array.isArray(items)) wire = { ...wire, items: items.map(wireItem) };
    wireSnapshots.set(snapshot, wire);
  }
  return wire;
}

// A slice's stamp is `<history stamp>/<slice>` (storedHistorySlice); an
// answer cut from it is served as `<slice stamp>#<rows delivered>`.
const historyOf = (stamp) => {
  const window = stamp.includes('#') ? stamp.slice(0, stamp.lastIndexOf('#')) : stamp;
  return window.includes('/') ? window.slice(0, window.lastIndexOf('/')) : window;
};
const deliveredOf = (stamp) => (stamp.includes('#') ? Number(stamp.slice(stamp.lastIndexOf('#') + 1)) : -1);
/** The stamp an answer of `delivered` rows is served under. Every answer cut
 *  from one display history is a tail of it, so the rows a caller received
 *  are named by that history and their count, byte-budget cuts included.
 *  A request that pages nothing is answered under the caller's own stamp
 *  (unchanged) when the tail it received already covers this whole answer —
 *  a host that paged deeper than this window keeps its rows on a refresh;
 *  any answer that would reveal more is served. */
function servedStamp(stamp, window, baseProjectionStamp, delivered) {
  if (typeof stamp !== 'string' || !stamp.includes('/')) return stamp;
  const own = `${stamp}#${delivered}`;
  if (window?.paged || typeof baseProjectionStamp !== 'string') return own;
  const covers = historyOf(baseProjectionStamp) === historyOf(own) && deliveredOf(baseProjectionStamp) >= delivered;
  return covers ? baseProjectionStamp : own;
}

const itemLimitFor = (hints, window) => {
  const requested = window ? window.limit : Number(hints?.resumeOptions?.transcriptItemLimit);
  return Number.isFinite(requested) && requested > 0 ? requested : 512;
};
const projectedKey = (sessionId, hints, window) =>
  `${sessionId}|${itemLimitFor(hints, window)}:${window?.byteBudget ?? ''}:${window?.pageBase ?? ''}:${window?.paged ? 'p' : ''}`;

export function createStoredSessionReader({
  readStoredSession,
  readStoredGoal,
  statStoredSession = null,
  forgetStoredSession = null,
  releaseStoredSession = null,
  readQuotaResume = null,
  sessionOwner,
  log,
}) {
  /** The cold session's queued quota resume (snapshot shape) or null. */
  const quotaResumeOf = (sessionId) => {
    if (typeof readQuotaResume !== 'function') return null;
    try {
      return readQuotaResume(sessionId) ?? null;
    } catch (err) {
      log(`stored quota resume projection failed session=${sessionId}: ${err?.message || err}`);
      return null;
    }
  };
  // The resume is projected beside the transcript, so its identity is part
  // of the stamp a cold view is served by: a scheduled, deferred or cleared
  // resume refreshes the view even while the transcript files are unchanged.
  const quotaResumeStamp = (sessionId) => {
    const resume = quotaResumeOf(sessionId);
    return resume ? `${resume.turnKey}:${resume.resetAt}:${resume.attempts}` : '';
  };
  // `${sessionId}|${window}` -> { projectionStamp, fileStamp }: the settled
  // file identity each served projection was built from. The 1s cold-view
  // refresh asks again with the stamp it holds; while the files still carry
  // that identity nothing is read. The store's transcript cache cannot give
  // that guarantee once several 512-item views exceed its byte budget: it
  // evicts each one just before its next refresh.
  const projectedFiles = new Map();
  /** Projections that carry only the page above their caller's proven rows
   *  (storedPageOnly). */
  const pageOnly = new WeakSet();

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

  /** Its last view left. The file-identity records stay (a revisit holding
   *  the same projection is answered by stat alone) and the store keeps the
   *  projection within its idle budget. */
  function releaseStoredProjection(sessionId) {
    if (typeof releaseStoredSession !== 'function') return;
    void Promise.resolve()
      .then(() => releaseStoredSession(sessionId))
      .catch((err) => log(`stored projection idle release failed session=${sessionId}: ${err?.message || err}`));
  }

  function traceStoredProjectionRead({ sessionId, hit, ms, chars, items, timing = {} }) {
    // Shared parse waiters are cache hits; report only the parse itself.
    if (hit || ms < SLOW_STORED_PROJECTION_MS) return;
    const phases = Object.entries(timing)
      .map(([name, value]) => `${name}=${typeof value === 'number' ? `${Math.round(value)}ms` : value}`)
      .join(' ');
    log(
      `slow stored projection session=${sessionId} ${Math.round(ms)}ms` +
        ` chars=${chars} items=${items}${phases ? ` ${phases}` : ''}`
    );
  }

  async function fileStampOf(sessionId) {
    if (typeof statStoredSession !== 'function') return null;
    let stamp;
    try {
      stamp = (await statStoredSession(sessionId)) || null;
    } catch {
      return null;
    }
    if (stamp === null) return null;
    const resume = quotaResumeStamp(sessionId);
    return resume ? `${stamp}|quota-resume:${resume}` : stamp;
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
   *  one, the resume hint (default 512 items) keeps the legacy page. A window
   *  answers within clampStoredWindow's bounds, above the rows `held`
   *  (requestedHeldTranscript) when the caller proves it holds them. */
  async function storedSessionProjection(sessionId, hints, window = null, held = null, baseProjectionStamp = null) {
    if (typeof readStoredSession !== 'function') return null;
    const key = projectedKey(sessionId, hints, window);
    // stat -> read -> stat: the projection is attributed to a file identity
    // only when no write can have landed while it was read.
    const fileStamp = await fileStampOf(sessionId);
    const read = async (options) => {
      try {
        const value = await readStoredSession(sessionId, { trace: traceStoredProjectionRead, ...options });
        return value && typeof value === 'object' ? value : null;
      } catch (err) {
        log(`stored session projection failed session=${sessionId}: ${err?.message || err}`);
        return undefined;
      }
    };
    const limit = itemLimitFor(hints, window);
    const pagedHeld = window?.paged ? held : null;
    // A paged caller's held rows are proven where the history is (by the
    // history stamp they were served under, or their digest), at any depth:
    // only the page above them crosses, never the rows held. Unproven, a
    // fresh tail of at most one answer's rows.
    const snapshot = await read({
      transcriptItemLimit: window?.paged && !pagedHeld ? Math.min(limit, TRANSCRIPT_RESPONSE_MAX_ITEMS) : limit,
      ...(pagedHeld
        ? {
            transcriptHeld: pagedHeld,
            transcriptBaseHistory: typeof baseProjectionStamp === 'string' ? historyOf(baseProjectionStamp) : null,
            transcriptPage: { maxRows: TRANSCRIPT_RESPONSE_MAX_ITEMS, byteBudget: window.byteBudget },
          }
        : {}),
      paging: Boolean(pagedHeld),
    });
    if (!snapshot) return null;
    const whole = wireSnapshot(snapshot);
    let paged = Boolean(pagedHeld) && snapshot.heldProven === true;
    let wire;
    if (pagedHeld && snapshot.heldProven === undefined && Array.isArray(whole.items)) {
      // A reader that predates held rows answers the window itself: they are
      // proven against it here, by digest.
      const proven = holdsTranscriptTail(whole.items, pagedHeld);
      wire = clampStoredWindow(whole, window, proven ? pagedHeld.count : 0);
      if (proven) {
        wire = { ...wire, items: wire.items.slice(0, wire.items.length - pagedHeld.count) };
        paged = true;
      }
    } else {
      wire = paged ? clampStoredPage(whole, window, pagedHeld.count) : clampStoredWindow(whole, window, 0);
    }
    const heldRows = paged ? pagedHeld.count : 0;
    const delivered = (Array.isArray(wire.items) ? wire.items.length : 0) + heldRows;
    const projectionStamp = servedStamp(snapshot.projectionStamp, window, baseProjectionStamp, delivered);
    projectedFiles.delete(key);
    if (
      fileStamp !== null &&
      typeof projectionStamp === 'string' &&
      projectionStamp &&
      (await fileStampOf(sessionId)) === fileStamp
    ) {
      projectedFiles.set(key, { projectionStamp, fileStamp });
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
    const projection = {
      ...wire,
      ...(typeof projectionStamp === 'string' ? { projectionStamp } : {}),
      sessionId,
      ...(typeof readStoredGoal === 'function' ? { goal: sanitizeForWire(goal, 1) ?? null } : {}),
      ...(typeof readQuotaResume === 'function'
        ? { quotaResume: sanitizeForWire(quotaResumeOf(sessionId)) ?? null }
        : {}),
      queued: Array.isArray(snapshot.queued) ? wire.queued : [],
    };
    if (paged) pageOnly.add(projection);
    return projection;
  }

  /** Whether `projection` carries only the rows above its caller's proven
   *  ones (the page itself), not those rows. */
  const storedPageOnly = (projection) => Boolean(projection) && pageOnly.has(projection);

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
    storedPageOnly,
    requestedMessageSlice,
    forgetStoredSession: forgetStoredProjection,
    releaseStoredSession: releaseStoredProjection,
  };
}
