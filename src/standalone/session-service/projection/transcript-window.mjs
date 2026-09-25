// Transcript windows: a view that names `transcriptItemLimit` receives the
// recent tail of the transcript instead of the whole history, plus
// `transcriptHasOlder` so it knows to page. A view that names no limit is a
// legacy view and keeps receiving the whole transcript.
//
// A live entry holds ONE window shared by every attached view. Its first index
// is sticky while views stay attached, so appends still travel as small
// suffix patches against the windowed baseline; a larger request only grows
// it (older items first), and the last view leaving resets it.
import { sanitizeForWire } from '../../session-wire-values.mjs';

/** A byte budget may cut the tail below its item limit, never below this. */
export const TRANSCRIPT_WINDOW_MIN_ITEMS = 16;
const TRANSCRIPT_WINDOW_MAX_ITEMS = 8_192;
// Deterministic restore ids: hist_<sessionId>_<messageIndex>_<part>.
const RESTORED_ITEM_ID = /^hist_.+_(\d+)_\d+$/;

const serializedItemBytes = new WeakMap();
function itemBytes(item) {
  if (!item || typeof item !== 'object') return Buffer.byteLength(JSON.stringify(item ?? null));
  let bytes = serializedItemBytes.get(item);
  if (bytes === undefined) {
    bytes = Buffer.byteLength(JSON.stringify(item));
    serializedItemBytes.set(item, bytes);
  }
  return bytes;
}

/** The window a read/subscribe asked for, or null for a legacy view. */
export function requestedTranscriptWindow(params) {
  const limit = Number(params?.transcriptItemLimit);
  if (!Number.isInteger(limit) || limit < 1) return null;
  const budget = Number(params?.transcriptByteBudget);
  return {
    limit: Math.min(TRANSCRIPT_WINDOW_MAX_ITEMS, limit),
    byteBudget: Number.isInteger(budget) && budget > 0 ? budget : null,
  };
}

/** First index of the kept tail: at most `limit` items and, past the
 *  minimum, no more serialized item bytes than `byteBudget`. */
export function tailWindowStart(items, { limit, byteBudget = null }) {
  const floor = Math.min(limit, TRANSCRIPT_WINDOW_MIN_ITEMS);
  let start = items.length;
  let bytes = 0;
  while (start > 0 && items.length - start < limit) {
    const next = itemBytes(items[start - 1]);
    if (byteBudget && items.length - start >= floor && bytes + next > byteBudget) break;
    bytes += next;
    start -= 1;
  }
  return start;
}

/** A stored projection already holds at most `limit` items; the byte budget
 *  may cut it further. */
export function budgetStoredWindow(wire, byteBudget) {
  if (!byteBudget || !Array.isArray(wire?.items)) return wire;
  const start = tailWindowStart(wire.items, { limit: wire.items.length, byteBudget });
  return start === 0 ? wire : { ...wire, items: wire.items.slice(start), transcriptHasOlder: true };
}

/** A restored runtime transcript that starts after message 0 may have older
 *  durable history that the runtime never loaded. */
function restoredAfterFirstMessage(item) {
  const match = RESTORED_ITEM_ID.exec(String(item?.id ?? ''));
  return Boolean(match) && Number(match[1]) > 0;
}

/** Fold a read/subscribe request into a live entry's window. */
export function requestLiveTranscriptWindow(entry, request) {
  const view = entry.transcriptView;
  if (!request) {
    entry.transcriptView = { full: true };
    return;
  }
  if (view?.full) return;
  if (!view) {
    entry.transcriptView = {
      limit: request.limit,
      byteBudget: request.byteBudget,
      start: null,
      anchorId: undefined,
      grow: false,
      // The first window is the runtime's own tail (byte-budgeted); durable
      // history is read only once the reader pages past it.
      paged: false,
      head: [],
      headOlder: null,
      cache: null,
    };
    return;
  }
  if (request.limit > view.limit) {
    view.limit = request.limit;
    view.grow = true;
    view.paged = true;
  }
}

/** The entry's wire snapshot seen through its window. Identity-stable for an
 *  unchanged source and window, so revision steps still detect "unchanged". */
export function windowTranscriptSnapshot(entry, wire) {
  const view = entry.transcriptView;
  if (!view || view.full || !wire || !Array.isArray(wire.items)) return wire;
  const items = wire.items;
  let start = view.start;
  if (start !== null && view.anchorId !== undefined && items[start]?.id !== view.anchorId) {
    // The runtime rewrote its transcript before the anchor (compaction,
    // rewind, clear): follow the anchor, or restart from the tail.
    const moved = items.findIndex((item) => item?.id === view.anchorId);
    start = moved < 0 ? null : moved;
    view.head = [];
    view.headOlder = null;
  }
  if (start !== null && start > items.length) start = null;
  if (start === null) {
    start = tailWindowStart(items, view);
    view.head = [];
    view.headOlder = null;
  }
  if (view.grow) {
    view.grow = false;
    start = Math.min(start, Math.max(0, items.length - view.limit));
  }
  view.start = start;
  view.anchorId = items[start]?.id;
  const older = start > 0 || (view.headOlder ?? restoredAfterFirstMessage(view.head[0] ?? items[0]));
  const cache = view.cache;
  if (cache && cache.wire === wire && cache.start === start && cache.head === view.head && cache.older === older) {
    return cache.value;
  }
  const windowed = view.head.length ? view.head.concat(items.slice(start)) : start ? items.slice(start) : items;
  const value = { ...wire, items: windowed, transcriptHasOlder: older };
  view.cache = { wire, start, head: view.head, older, value };
  return value;
}

/** Load durable history OLDER than the runtime's first item when a grown
 *  window reaches past what the runtime holds (a resumed runtime restores
 *  only a bounded tail). Items align by their deterministic restore ids.
 *  Returns whether durable history was read. */
export async function loadLiveTranscriptHead(entry, sessionId, readStoredSession) {
  const view = entry.transcriptView;
  if (!view || view.full || !view.paged || typeof readStoredSession !== 'function' || view.headOlder === false) {
    return false;
  }
  const items = entry.runtime?.getState?.()?.items;
  const runtimeItems = Array.isArray(items) ? items : [];
  const missing = view.limit - runtimeItems.length - view.head.length;
  const first = view.head[0] ?? runtimeItems[0];
  if (missing <= 0 || !restoredAfterFirstMessage(first)) return false;
  const stored = await readStoredSession(sessionId, { transcriptItemLimit: view.limit + runtimeItems.length });
  if (entry.transcriptView !== view || (view.head[0] ?? entry.runtime?.getState?.()?.items?.[0]) !== first) {
    return true;
  }
  const history = Array.isArray(stored?.items) ? stored.items : [];
  const overlap = history.findIndex((item) => item?.id === first.id);
  if (overlap < 0) {
    view.headOlder = false;
    return true;
  }
  const from = Math.max(0, overlap - missing);
  view.head = sanitizeForWire(history.slice(from, overlap)).concat(view.head);
  view.headOlder = from > 0 || stored.transcriptHasOlder === true;
  return true;
}
