import { sanitizeForWire } from '../session-wire-values.mjs';

const SLOW_STORED_PROJECTION_MS = 250;

export function createStoredSessionReader({ readStoredSession, readStoredGoal, sessionOwner, log }) {
  function traceStoredProjectionRead({ sessionId, hit, ms, chars, items }) {
    // Shared parse waiters are cache hits; report only the parse itself.
    if (hit || ms < SLOW_STORED_PROJECTION_MS) return;
    log(`slow stored projection session=${sessionId} ${Math.round(ms)}ms` + ` chars=${chars} items=${items}`);
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
        goal = (await readStoredGoal(sessionId)) ?? null;
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

  return { storedSessionProjection, requestedMessageSlice };
}
