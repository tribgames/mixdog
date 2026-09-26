// Compact immutable session-state deltas shared by the runtime IPC hop and the
// daemon-to-view hop. `itemsAppend` is the protocol's historical field name;
// `from` may identify any first-changed index, so the payload is a suffix
// replacement rather than append-only.
//
// `itemsPrepend` (only with `{ prepend: true }`, for a view that announced
// `transcriptPrepend`) carries rows revealed ABOVE the previous list, an
// older-history page: the previous rows then start `values.length` rows in,
// and `itemsAppend.from` indexes the PREVIOUS list.
import { createHash } from 'node:crypto';

export function diffSessionState(previous, next, { prepend = false } = {}) {
  if (!previous || !next || typeof previous !== 'object' || typeof next !== 'object') return null;
  const set = {};
  const remove = [];
  let itemsAppend = null;
  let itemsPrepend = null;
  for (const [key, value] of Object.entries(next)) {
    if (previous[key] === value) continue;
    if (key === 'items' && Array.isArray(value) && Array.isArray(previous.items)) {
      let head = 0;
      if (prepend && previous.items.length > 0 && value[0] !== previous.items[0]) {
        head = Math.max(0, value.indexOf(previous.items[0]));
      }
      const sharedLength = Math.min(previous.items.length, value.length - head);
      let from = 0;
      while (from < sharedLength && previous.items[from] === value[head + from]) from += 1;
      if (head > 0) itemsPrepend = { values: value.slice(0, head) };
      if (from !== previous.items.length || head + from !== value.length) {
        itemsAppend = { from, values: value.slice(head + from) };
      }
      continue;
    }
    set[key] = value;
  }
  for (const key of Object.keys(previous)) {
    if (!(key in next)) remove.push(key);
  }
  return itemsPrepend ? { set, remove, itemsAppend, itemsPrepend } : { set, remove, itemsAppend };
}

export function applySessionStatePatch(previous, patch) {
  const base = previous && typeof previous === 'object' ? previous : {};
  if (!patch || typeof patch !== 'object') return base;
  const next = { ...base, ...(patch.set || {}) };
  if (patch.itemsAppend || patch.itemsPrepend) {
    const items = Array.isArray(base.items) ? base.items : [];
    const head = Array.isArray(patch.itemsPrepend?.values) ? patch.itemsPrepend.values : [];
    const from = patch.itemsAppend
      ? Math.max(0, Math.min(items.length, Math.floor(Number(patch.itemsAppend.from) || 0)))
      : items.length;
    const tail = Array.isArray(patch.itemsAppend?.values) ? patch.itemsAppend.values : [];
    next.items = head.concat(items.slice(0, from), tail);
  }
  for (const key of patch.remove || []) delete next[key];
  return next;
}

/** Content identity of a run of transcript items, as each side of the wire
 *  serializes them: a paged read proves with it that the rows a view holds
 *  are exactly the daemon's, without sending them back. */
export function transcriptItemsDigest(items) {
  const hash = createHash('sha256');
  for (const item of items) {
    hash.update(JSON.stringify(item ?? null) ?? 'null');
    hash.update('\n');
  }
  return hash.digest('base64url');
}
