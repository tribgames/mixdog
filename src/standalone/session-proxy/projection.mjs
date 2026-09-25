/**
 * session-proxy/projection.mjs — the synchronous state mirror one view holds:
 * the latest snapshot, its revision, which attachment + session id that
 * revision belongs to, and the listeners notified on every change. Bodies
 * (create/read/subscribe/submit results and stream frames) fold in through
 * applyBody; a body that cannot be applied at the current revision reports
 * false so the caller resyncs.
 */
import { applySessionStatePatch } from '../session-state-patch.mjs';

export function createProjection({ binding, log }) {
  let state = {};
  let revision = 0;
  let revisionAttachment = null;
  let revisionSessionId = '';
  let reservedOnly = false;
  const listeners = new Set();
  // Result body → the attachment that produced it, so a late result from a
  // replaced attachment never overwrites the current projection.
  const resultAttachments = new WeakMap();

  function emit() {
    for (const listener of [...listeners]) {
      try {
        listener();
      } catch (error) {
        log(`session listener threw: ${error?.message || error}`);
      }
    }
  }

  function markResult(result, attachment) {
    if (result && typeof result === 'object') resultAttachments.set(result, attachment);
  }

  function applyBody(body, sourceAttachment = resultAttachments.get(body) || binding.attachment) {
    if (binding.disposed || !body) return false;
    if (sourceAttachment !== binding.attachment) return true;
    if (Object.hasOwn(body, 'reservedOnly')) reservedOnly = body.reservedOnly === true;
    const incomingRevision = Number(body.revision);
    if (revisionAttachment !== sourceAttachment || revisionSessionId !== binding.sessionId) {
      if (body.full === undefined || body.full === null) return false;
      state = body.full;
      revision = Number.isFinite(incomingRevision) ? incomingRevision : 0;
      revisionAttachment = sourceAttachment;
      revisionSessionId = binding.sessionId;
      emit();
      return true;
    }
    if (Number.isFinite(incomingRevision) && incomingRevision < revision) return true;
    if (body.full !== undefined && body.full !== null) {
      state = body.full;
      revision = Number.isFinite(incomingRevision) ? incomingRevision : revision;
      emit();
      return true;
    }
    if (body.patch) {
      if (Number(body.revision) === revision && Number(body.baseRevision) === revision - 1) return true;
      if (Number(body.baseRevision) !== revision) return false;
      state = applySessionStatePatch(state, body.patch);
      revision = Number(body.revision) || revision;
      emit();
      return true;
    }
    if (Number.isFinite(Number(body.revision))) {
      revision = Number(body.revision);
      return true;
    }
    return false;
  }

  function baseRevisionFor(sourceAttachment = binding.attachment, targetSessionId = binding.sessionId) {
    return revisionAttachment === sourceAttachment && revisionSessionId === targetSessionId ? revision : null;
  }

  return {
    // The create result seeds the projection for the current binding.
    seed(created) {
      state = created?.full ?? {};
      revision = Number(created?.revision) || 0;
      revisionAttachment = binding.attachment;
      revisionSessionId = binding.sessionId;
      reservedOnly = created?.reservedOnly === true;
    },
    // A recovery starts from no owned revision: the next full snapshot wins.
    resetRevisionOwner() {
      revisionAttachment = null;
      revisionSessionId = '';
    },
    markResult,
    applyBody,
    baseRevisionFor,
    getState: () => state,
    get reservedOnly() {
      return reservedOnly;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    clearListeners: () => listeners.clear(),
  };
}
