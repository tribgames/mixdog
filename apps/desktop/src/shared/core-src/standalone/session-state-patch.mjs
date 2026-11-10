// Compact immutable session-state deltas shared by the runtime IPC hop and the
// daemon-to-view hop. `itemsAppend` is the protocol's historical field name;
// `from` may identify any first-changed index, so the payload is a suffix
// replacement rather than append-only.
//
// `itemsPrepend` (only with `{ prepend: true }`, for a view that announced
// `transcriptPrepend`) carries rows revealed ABOVE the previous list, an
// older-history page: the previous rows then start `values.length` rows in,
// and `itemsAppend.from` indexes the PREVIOUS list.
//
// `partialAppend` carries growth of the desktop-only `streamingPartial` (the
// unfinished streamed line) as just its new text: re-sending the whole line on
// every tick made a long unfinished line cost O(length²) on the wire. A
// decoder that predates it keeps its last partial, which the desktop join
// then ignores or shows behind — never wrong text.
import { createHash } from 'node:crypto';

/** The text `after` appends to `before` when both are the same unfinished
 *  line (same row, same offset, same row identity), else null: a retraction,
 *  another row or a new line travels as a full replacement. */
export function streamingPartialSuffix(before, after) {
  if (!before || !after || typeof before !== 'object' || typeof after !== 'object') return null;
  const { text: beforeText, ...beforeRest } = before;
  const { text: afterText, ...afterRest } = after;
  if (typeof beforeText !== 'string' || typeof afterText !== 'string') return null;
  if (afterText.length <= beforeText.length || !afterText.startsWith(beforeText)) return null;
  // id, from and the row identity: everything but the text stays put.
  if (JSON.stringify(beforeRest) !== JSON.stringify(afterRest)) return null;
  return afterText.slice(beforeText.length);
}

function appendStreamingPartial(state, suffix) {
  const held = state.streamingPartial;
  if (!held || typeof held !== 'object' || typeof held.text !== 'string' || typeof suffix !== 'string') return false;
  state.streamingPartial = { ...held, text: held.text + suffix };
  return true;
}

export function diffSessionState(previous, next, { prepend = false } = {}) {
  if (!previous || !next || typeof previous !== 'object' || typeof next !== 'object') return null;
  const set = {};
  const remove = [];
  let itemsAppend = null;
  let itemsPrepend = null;
  let partialAppend = null;
  for (const [key, value] of Object.entries(next)) {
    if (previous[key] === value) continue;
    if (key === 'streamingPartial') {
      const suffix = streamingPartialSuffix(previous[key], value);
      if (suffix !== null) {
        partialAppend = { text: suffix };
        continue;
      }
    }
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
  const patch = itemsPrepend ? { set, remove, itemsAppend, itemsPrepend } : { set, remove, itemsAppend };
  if (partialAppend) patch.partialAppend = partialAppend;
  return patch;
}

/** The patched state, or null when a `partialAppend` has no held line to grow
 *  (a broken chain the caller answers with a full resync, never lost text). */
export function applySessionStatePatch(previous, patch) {
  const base = previous && typeof previous === 'object' ? previous : {};
  if (!patch || typeof patch !== 'object') return base;
  const next = { ...base, ...(patch.set || {}) };
  if (Object.hasOwn(patch, 'partialAppend') && !appendStreamingPartial(next, patch.partialAppend?.text)) return null;
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
