// Transcript windows: a view that names `transcriptItemLimit` receives the
// recent tail of the transcript instead of the whole history, plus
// `transcriptHasOlder` so it knows to page. A view that names no limit is a
// legacy view and keeps receiving the whole transcript.
//
// A live entry holds ONE window shared by every attached view. Its first index
// is sticky while views stay attached, so appends still travel as small
// suffix patches against the windowed baseline; a larger request only grows
// it (older items first), and the last view leaving resets it.
import { transcriptItemsDigest } from '../../session-state-patch.mjs';
import { sanitizeForWire } from '../../session-wire-values.mjs';

/** A byte budget may cut a first tail window, or the rows an older-history
 *  page reveals, below the item limit but never below this many rows
 *  whatever their size: a window always shows something and paging always
 *  progresses. A viewport the rows do not fill pages further on its own. */
export const TRANSCRIPT_WINDOW_MIN_ITEMS = 8;
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

/** The window a read/subscribe asked for, or null for a legacy view.
 *  `transcriptPageBase` names how many newest items the reader already holds:
 *  the byte budget then bounds only the older rows revealed above them. */
export function requestedTranscriptWindow(params) {
  const limit = Number(params?.transcriptItemLimit);
  if (!Number.isInteger(limit) || limit < 1) return null;
  const budget = Number(params?.transcriptByteBudget);
  const pageBase = Number(params?.transcriptPageBase);
  const cappedLimit = Math.min(TRANSCRIPT_WINDOW_MAX_ITEMS, limit);
  return {
    limit: cappedLimit,
    byteBudget: Number.isInteger(budget) && budget > 0 ? budget : null,
    pageBase: Number.isInteger(pageBase) && pageBase > 0 ? Math.min(pageBase, cappedLimit) : 0,
  };
}

/** The rows a paged read says its caller already holds — `transcriptHeld`
 *  `{ firstId, count, digest }` from a view that announced transcriptPrepend
 *  — or null. */
export function requestedHeldTranscript(params) {
  const held = params?.transcriptHeld;
  if (params?.transcriptPrepend !== true || !held || typeof held !== 'object') return null;
  const count = Number(held.count);
  if (held.firstId == null || !Number.isInteger(count) || count < 1 || typeof held.digest !== 'string') return null;
  return { firstId: held.firstId, count, digest: held.digest };
}

/** A FULL answer to a paged read, reduced to what the caller lacks: the rows
 *  above the ones it holds, the identity of its first held row, and every
 *  other field. Only when the window's tail is exactly those held rows (same
 *  first id, count and content digest); otherwise the full answer stands. */
export function transcriptPageBody(result, held) {
  const snapshot = result?.full;
  if (!held || !snapshot || !Array.isArray(snapshot.items)) return result;
  const items = snapshot.items;
  const start = items.length - held.count;
  if (start < 0 || items[start]?.id !== held.firstId) return result;
  if (transcriptItemsDigest(start ? items.slice(start) : items) !== held.digest) return result;
  const { full: _full, ...body } = result;
  const { items: _items, ...state } = snapshot;
  return {
    ...body,
    page: { firstHeldId: held.firstId, heldCount: held.count, items: items.slice(0, start), state },
  };
}

/** First index of the rows kept above `end`: at most `maxItems` of them and,
 *  past `minItems`, no more serialized bytes than `byteBudget`. */
function budgetedStart(items, end, maxItems, byteBudget, minItems) {
  const floor = Math.min(maxItems, minItems);
  let start = end;
  let bytes = 0;
  while (start > 0 && end - start < maxItems) {
    const next = itemBytes(items[start - 1]);
    if (byteBudget && end - start >= floor && bytes + next > byteBudget) break;
    bytes += next;
    start -= 1;
  }
  return start;
}

/** First index of the kept tail: at most `limit` items. A first window spends
 *  `byteBudget` on the whole tail; a page keeps the `pageBase` newest items
 *  the reader holds and spends it on the rows revealed above them. Neither
 *  goes below TRANSCRIPT_WINDOW_MIN_ITEMS. */
export function tailWindowStart(items, { limit, byteBudget = null, pageBase = 0 }) {
  const held = Math.min(pageBase || 0, limit, items.length);
  if (held > 0) {
    return budgetedStart(items, items.length - held, limit - held, byteBudget, TRANSCRIPT_WINDOW_MIN_ITEMS);
  }
  return budgetedStart(items, items.length, limit, byteBudget, TRANSCRIPT_WINDOW_MIN_ITEMS);
}

/** A stored projection already holds at most `window.limit` items; the byte
 *  budget may cut it further. */
export function budgetStoredWindow(wire, window) {
  if (!window?.byteBudget || !Array.isArray(wire?.items)) return wire;
  const start = tailWindowStart(wire.items, {
    limit: wire.items.length,
    byteBudget: window.byteBudget,
    pageBase: window.pageBase,
  });
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
      pageBase: request.pageBase,
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
    // The page's own budget bounds the rows it reveals.
    view.grow = { byteBudget: request.byteBudget };
    view.paged = true;
  }
}

/** A caller is about to receive the window whole (it holds no baseline the
 *  next step can patch): the next snapshot re-applies the byte budget. */
export function rebudgetTranscriptWindow(entry) {
  if (entry.transcriptView && !entry.transcriptView.full) entry.transcriptView.rebudget = true;
}

/** A daemon runtime taking over an external view's subscribers takes over
 *  the window they were served too (its position restarts from the tail). */
export function inheritTranscriptWindow(entry, view) {
  if (!view) return;
  requestLiveTranscriptWindow(
    entry,
    view.full ? null : { limit: view.limit, byteBudget: view.byteBudget, pageBase: view.pageBase || 0 }
  );
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
  // The sticky start lets appends travel as suffix patches, so an unpaged
  // tail grows past its byte budget while views stay attached (a worker
  // watched from its first rows reached 40 rows / 10 MB). Whenever the window
  // goes out whole — a caller without a usable baseline, or the first publish
  // after the projection was released — cut it back to a fresh tail first.
  if ((view.rebudget || !entry.publishedSnapshot) && !view.paged && view.byteBudget) {
    start = Math.max(start, tailWindowStart(items, { limit: view.limit, byteBudget: view.byteBudget }));
  }
  view.rebudget = false;
  if (view.grow) {
    // Reveal the rows above the current window: up to the grown limit, and
    // within the page's byte budget past TRANSCRIPT_WINDOW_MIN_ITEMS.
    const held = view.head.length + items.length - start;
    start = budgetedStart(items, start, view.limit - held, view.grow.byteBudget, TRANSCRIPT_WINDOW_MIN_ITEMS);
    view.grow = false;
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
  // Durable history continues the window only once it shows the runtime's
  // first item; a budgeted page may still be revealing runtime rows.
  if (view.start !== 0) return false;
  const items = entry.runtime?.getState?.()?.items;
  const runtimeItems = Array.isArray(items) ? items : [];
  const missing = view.limit - runtimeItems.length - view.head.length;
  const first = view.head[0] ?? runtimeItems[0];
  if (missing <= 0 || !restoredAfterFirstMessage(first)) return false;
  const pageBudget = view.grow ? view.grow.byteBudget : null;
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
  const from = budgetedStart(history, overlap, missing, pageBudget, TRANSCRIPT_WINDOW_MIN_ITEMS);
  view.head = sanitizeForWire(history.slice(from, overlap)).concat(view.head);
  view.headOlder = from > 0 || stored.transcriptHasOlder === true;
  return true;
}
