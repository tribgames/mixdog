/**
 * session-proxy/projection.mjs — the synchronous state mirror one view holds:
 * the latest snapshot, its revision, which attachment + session id that
 * revision belongs to, and the listeners notified on every change. Bodies
 * (create/read/subscribe/submit results and stream frames) fold in through
 * applyBody; a body that cannot be applied at the current revision reports
 * false so the caller resyncs.
 */
import { applySessionStatePatch } from '../session-state-patch.mjs';

// Desktop-only live fields: `streamingPartial` is the unfinished streamed
// line the desktop paints ahead of the line-gated tail. This terminal view
// keeps the line-gated text, so it never holds the field nor re-renders for it.
const DESKTOP_ONLY_FIELDS = ['streamingPartial'];

function terminalState(full) {
  if (!full || typeof full !== 'object' || !DESKTOP_ONLY_FIELDS.some((key) => Object.hasOwn(full, key))) return full;
  const next = { ...full };
  for (const key of DESKTOP_ONLY_FIELDS) delete next[key];
  return next;
}

/** The patch without desktop-only fields, or null when nothing else moved. */
function terminalPatch(patch) {
  const set = patch.set && typeof patch.set === 'object' ? patch.set : {};
  const remove = Array.isArray(patch.remove) ? patch.remove : [];
  if (!patch.partialAppend && !DESKTOP_ONLY_FIELDS.some((key) => Object.hasOwn(set, key) || remove.includes(key))) {
    return patch;
  }
  const nextSet = { ...set };
  for (const key of DESKTOP_ONLY_FIELDS) delete nextSet[key];
  const nextRemove = remove.filter((key) => !DESKTOP_ONLY_FIELDS.includes(key));
  if (Object.keys(nextSet).length === 0 && nextRemove.length === 0 && !patch.itemsAppend && !patch.itemsPrepend) {
    return null;
  }
  const { partialAppend: _desktopOnly, ...rest } = patch;
  return { ...rest, set: nextSet, remove: nextRemove };
}

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
      state = terminalState(body.full);
      revision = Number.isFinite(incomingRevision) ? incomingRevision : 0;
      revisionAttachment = sourceAttachment;
      revisionSessionId = binding.sessionId;
      emit();
      return true;
    }
    if (Number.isFinite(incomingRevision) && incomingRevision < revision) return true;
    if (body.full !== undefined && body.full !== null) {
      state = terminalState(body.full);
      revision = Number.isFinite(incomingRevision) ? incomingRevision : revision;
      emit();
      return true;
    }
    if (body.patch) {
      if (Number(body.revision) === revision && Number(body.baseRevision) === revision - 1) return true;
      if (Number(body.baseRevision) !== revision) return false;
      const patch = terminalPatch(body.patch);
      // Only a desktop-only field moved: the terminal view advances silently.
      if (!patch) {
        revision = Number(body.revision) || revision;
        return true;
      }
      const patched = applySessionStatePatch(state, patch);
      if (!patched) return false;
      revision = Number(body.revision) || revision;
      state = patched;
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
      state = terminalState(created?.full ?? {});
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
