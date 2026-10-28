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
const TRANSCRIPT_WINDOW_MIN_ITEMS = 8;
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
function tailWindowStart(items, { limit, byteBudget = null, pageBase = 0 }) {
  const held = Math.min(pageBase || 0, limit, items.length);
  return budgetedStart(items, items.length - held, limit - held, byteBudget, TRANSCRIPT_WINDOW_MIN_ITEMS);
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

/** The compaction-archive segments (`{ after, before }`) a resumed runtime
 *  holds none of, or null. */
function runtimeArchiveRange(state) {
  const range = state?.transcriptArchive;
  const after = Number(range?.after);
  const before = Number(range?.before);
  return Number.isInteger(after) && Number.isInteger(before) && before - 1 > after ? { after, before } : null;
}

/** The rows the runtime spilled out of memory above its first row
 *  (`transcriptSpilled`: `{ rows, epoch }`), published with the rows
 *  themselves and independent of the TUI's reading cursor; null when none. */
function spilledOf(state) {
  const spilled = spillStateOf(state);
  return spilled && spilled.rows > 0 ? spilled : null;
}

/** The published spill state, zero rows included (null: none published). */
function spillStateOf(state) {
  const spilled = state?.transcriptSpilled;
  const rows = Number(spilled?.rows);
  const epoch = Number(spilled?.epoch);
  return Number.isSafeInteger(rows) && rows >= 0 && Number.isSafeInteger(epoch) ? { rows, epoch } : null;
}

const sameSpill = (left, right) => left?.rows === right?.rows && left?.epoch === right?.epoch;

/** Whether spilled rows sit above the runtime's first row, readable through
 *  its spill accessor. A loaded head answers for itself. */
function spilledAbove(entry, state, view) {
  return !view.head.length && spilledOf(state) !== null && typeof entry.runtime?.readSpilledTranscript === 'function';
}

function resetLoadedHead(view) {
  view.head = [];
  view.headOlder = null;
  view.headSource = null;
  view.archiveHeld = 0;
  // Absolute index of the oldest spilled row the head holds (null: none).
  view.spillFrom = null;
}

/** Older rows a spilled head leaves above itself: more spilled rows, or the
 *  source above the first spilled row. */
function spilledHeadOlder(view, archive) {
  return view.spillFrom > 0 || (view.head.length > 0 && headSourceFor(view.head[0], archive) !== null);
}

/** The runtime spilled its oldest rows while the window showed them (its
 *  anchor among them): those rows join the head exactly as spilled, so the
 *  window keeps its rows and its place. False when the spill does not
 *  continue the rows this window last saw. */
function followSpilledAnchor(entry, view, wire) {
  const spilled = spilledOf(wire);
  const before = view.spilled;
  const read = entry.runtime?.readSpilledTranscript;
  if (!spilled || typeof read !== 'function' || view.start === null) return false;
  // Rows spilled when the window last looked: none, or a count in this epoch.
  if (before && before.epoch !== spilled.epoch) return false;
  const from = (before?.rows ?? 0) + view.start;
  if (from >= spilled.rows) return false;
  const page = read({ epoch: spilled.epoch, end: spilled.rows, limit: spilled.rows - from });
  if (!page || page.broken || page.start !== from || page.items[0]?.id !== view.anchorId) return false;
  view.head = view.head.concat(sanitizeForWire(page.items));
  if (view.headSource !== 'stored' && view.headSource !== 'archive') {
    view.spillFrom ??= from;
    view.headSource = 'spill';
    view.headOlder = spilledHeadOlder(view, runtimeArchiveRange(wire));
  }
  view.start = 0;
  return true;
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
      // Where the loaded head came from: 'spill' (the rows the runtime spilled
      // out of memory, exactly), 'stored' (durable history aligned by restore
      // ids) or 'archive' (compaction-archive pages).
      headSource: null,
      archiveHeld: 0,
      spillFrom: null,
      // The spilled rows (`{ rows, epoch }`) when the window last looked.
      spilled: null,
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
  const spill = spillStateOf(wire);
  // The spill store was reset or restored (another epoch, or no spill state):
  // spilled and older rows the window loaded name another page list, so it
  // restarts from the tail whether or not its anchor is still live.
  if (view.spilled && spill?.epoch !== view.spilled.epoch) start = null;
  if (start !== null && view.anchorId !== undefined && items[start]?.id !== view.anchorId) {
    const moved = items.findIndex((item) => item?.id === view.anchorId);
    if (moved < 0 && followSpilledAnchor(entry, view, wire)) {
      // The runtime spilled the rows the window starts with: they are head now.
      start = 0;
    } else {
      // The runtime rewrote its transcript before the anchor (compaction,
      // rewind, clear): follow the anchor, or restart from the tail.
      start = moved < 0 ? null : moved;
      resetLoadedHead(view);
    }
  }
  if (start !== null && start > items.length) start = null;
  if (start === null) {
    start = tailWindowStart(items, view);
    resetLoadedHead(view);
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
  view.spilled = spill;
  const older =
    start > 0 ||
    (view.headOlder ??
      headSourceFor(view.head[0] ?? items[0], runtimeArchiveRange(wire), spilledAbove(entry, wire, view)) !== null);
  const cache = view.cache;
  if (cache && cache.wire === wire && cache.start === start && cache.head === view.head && cache.older === older) {
    return cache.value;
  }
  let windowed = items;
  if (view.head.length) windowed = view.head.concat(items.slice(start));
  else if (start) windowed = items.slice(start);
  const value = { ...wire, items: windowed, transcriptHasOlder: older };
  view.cache = { wire, start, head: view.head, older, value };
  return value;
}

/** Where older rows above `first` come from: the rows the runtime spilled out
 *  of memory above it (`spilled`), then durable history aligned by restore
 *  ids (which continues into the compaction archive), or — once the runtime's
 *  rows are not restored ones (a live compaction archived them, or nothing was
 *  restored) — compaction-archive pages alone. */
function headSourceFor(first, archive, spilled = false) {
  if (spilled) return 'spill';
  const restoredId = RESTORED_ITEM_ID.test(String(first?.id ?? ''));
  if (restoredId && first?.archived !== true) return restoredAfterFirstMessage(first) || archive ? 'stored' : null;
  if (archive) return 'archive';
  // A compaction archived the first loaded restored row, but the runtime holds
  // no archive range: older rows still align through durable history.
  return restoredId && restoredAfterFirstMessage(first) ? 'stored' : null;
}

/** Whether a live row shows that a compaction rewrote this runtime's rows. */
function isCompactionMark(item) {
  return item?.archived === true || (item?.kind === 'statusdone' && item.status === 'compacted');
}

/** The runtime's compaction generation: it only grows, because every
 *  compaction adds a divider and archives rows. A loaded head is valid only
 *  for the generation it was loaded in. */
function compactionGeneration(items) {
  return items.reduce((count, item) => count + (isCompactionMark(item) ? 1 : 0), 0);
}

/** Where `first` sits in durable history, or -1. Restore ids are positional
 *  and only comparable while no compaction touched the live rows (or when
 *  `first` itself came from this durable history). Across a compaction the
 *  live `hist_…` ids and the durable `arch…`/renumbered ids describe
 *  different positions, so nothing but one verified stable identity aligns. */
function alignedHistoryIndex(history, first, live, fromHistory) {
  if (!first) return -1;
  if (fromHistory || !live.some(isCompactionMark)) return history.findIndex((item) => item?.id === first.id);
  const index = verifiedIdentityIndex(history, first, live);
  return index >= 0 && !prefixRepeatsLiveRow(history.slice(0, index), live) ? index : -1;
}

/** Whether a proposed older prefix holds a row whose stable identity (kind +
 *  `messageId`, or a tool call id) the live window already shows: joining it
 *  would show that row twice. */
function prefixRepeatsLiveRow(prefix, live) {
  const messages = new Set();
  const calls = new Set();
  for (const item of live) {
    if (item?.messageId) messages.add(`${item.kind}\0${item.messageId}`);
    for (const callId of toolCallIds(item)) calls.add(callId);
  }
  return prefix.some(
    (item) =>
      (item?.messageId && messages.has(`${item.kind}\0${item.messageId}`)) ||
      toolCallIds(item).some((callId) => calls.has(callId))
  );
}

/** The tool call ids a tool row carries (single card or aggregate). */
function toolCallIds(item) {
  const ids = Array.isArray(item?.callIds) ? item.callIds : [];
  return item?.callId ? [item.callId, ...ids] : ids;
}

/** The one durable row that is the copy of live row `first`, by stable
 *  identity only: same kind and `messageId` for message rows; for tool rows
 *  every call id of `first` is in the durable row, which holds no call the
 *  live window lacks (an archive aggregate merging a call that is not live
 *  would otherwise drop it). No identity, no match, or more than one match:
 *  -1 — nothing is guessed. */
function verifiedIdentityIndex(history, first, live) {
  const calls = toolCallIds(first);
  const liveCalls = new Set(live.flatMap(toolCallIds));
  const matches = [];
  history.forEach((item, index) => {
    if (item?.kind !== first.kind) return;
    if (calls.length) {
      const own = toolCallIds(item);
      if (calls.every((callId) => own.includes(callId)) && own.every((callId) => liveCalls.has(callId))) {
        matches.push(index);
      }
    } else if (first.kind !== 'tool' && first.messageId && item.messageId === first.messageId) {
      matches.push(index);
    }
  });
  return matches.length === 1 ? matches[0] : -1;
}

/** Load history OLDER than the runtime's first item when a grown window
 *  reaches past what the runtime holds (the runtime spilled its oldest rows
 *  out of memory; a resumed runtime restores only a bounded tail; a compaction
 *  moved earlier rows to the display-only archive). Spilled rows come first,
 *  exactly as spilled; then durable items align by their deterministic
 *  restore ids; archive pages continue below the archived rows already held.
 *  Returns whether durable history was read. */
export async function loadLiveTranscriptHead(entry, sessionId, readStoredSession) {
  const view = entry.transcriptView;
  if (!view || view.full || !view.paged || typeof readStoredSession !== 'function' || view.headOlder === false) {
    return false;
  }
  // Durable history continues the window only once it shows the runtime's
  // first item; a budgeted page may still be revealing runtime rows.
  if (view.start !== 0) return false;
  const state = entry.runtime?.getState?.();
  const runtimeItems = Array.isArray(state?.items) ? state.items : [];
  const missing = view.limit - runtimeItems.length - view.head.length;
  // The rows were spilled since the window last looked: its next snapshot
  // moves them into the head first, so spilled indices stay its own.
  if (!sameSpill(spillStateOf(state), view.spilled)) return false;
  const spilled = spilledOf(state);
  const first = view.head[0] ?? runtimeItems[0];
  const archive = runtimeArchiveRange(state);
  const spilling = view.headSource === 'spill' ? view.spillFrom > 0 : spilledAbove(entry, state, view);
  const source = spilling ? 'spill' : (view.headSource !== 'spill' && view.headSource) || headSourceFor(first, archive);
  if (missing <= 0 || !source) return false;
  const generation = compactionGeneration(runtimeItems);
  // Spilled rows are the runtime's own, joined exactly whatever compacted
  // since; a durable head is valid only for its generation.
  if (view.head.length && view.headSource !== 'spill' && view.headGeneration !== generation) {
    // A compaction since the head was loaded: keep the rows as they are, and
    // never join older rows across the generation.
    view.headOlder = false;
    return true;
  }
  const pageBudget = view.grow ? view.grow.byteBudget : null;
  const currentItems = () => entry.runtime?.getState?.()?.items;
  const stillCurrent = () =>
    entry.transcriptView === view &&
    (view.head[0] ?? currentItems()?.[0]) === first &&
    compactionGeneration(Array.isArray(currentItems()) ? currentItems() : []) === generation;
  if (source === 'spill') {
    // Synchronous: the rows read are exactly the ones above `first` now.
    const end = view.spillFrom ?? spilled.rows;
    const page = entry.runtime.readSpilledTranscript({ epoch: spilled.epoch, end, limit: missing });
    if (!page) return false;
    const rows = page.items;
    const from = budgetedStart(rows, rows.length, missing, pageBudget, TRANSCRIPT_WINDOW_MIN_ITEMS);
    view.head = sanitizeForWire(rows.slice(from)).concat(view.head);
    view.spillFrom = end - (rows.length - from);
    view.headSource = 'spill';
    // An unreadable page ends the history there: nothing above it joins
    // without a gap. Past the spilled rows, the first of them names the next
    // source.
    view.headOlder = page.broken && from === 0 ? false : spilledHeadOlder(view, archive);
    return false;
  }
  if (source === 'archive') {
    const page = await readStoredSession(sessionId, {
      compactionArchive: { ...archive, skip: view.archiveHeld || 0, limit: missing },
    });
    if (!stillCurrent()) return true;
    const rows = Array.isArray(page?.items) ? page.items : [];
    const from = budgetedStart(rows, rows.length, missing, pageBudget, TRANSCRIPT_WINDOW_MIN_ITEMS);
    view.head = sanitizeForWire(rows.slice(from)).concat(view.head);
    view.archiveHeld = (view.archiveHeld || 0) + rows.length - from;
    view.headSource = 'archive';
    view.headGeneration = generation;
    view.headOlder = from > 0 || page?.hasOlder === true;
    return true;
  }
  const stored = await readStoredSession(sessionId, { transcriptItemLimit: view.limit + runtimeItems.length });
  if (!stillCurrent()) return true;
  const history = Array.isArray(stored?.items) ? stored.items : [];
  // Only a head read from this durable history aligns by its ids; spilled
  // rows are live rows like the runtime's own.
  const overlap = alignedHistoryIndex(history, first, view.head.concat(runtimeItems), view.headSource === 'stored');
  if (overlap < 0) {
    view.headOlder = false;
    return true;
  }
  const from = budgetedStart(history, overlap, missing, pageBudget, TRANSCRIPT_WINDOW_MIN_ITEMS);
  view.head = sanitizeForWire(history.slice(from, overlap)).concat(view.head);
  view.headSource = 'stored';
  view.headGeneration = generation;
  view.headOlder = from > 0 || stored.transcriptHasOlder === true;
  return true;
}

/** A one-shot range must not grow or rebudget an attached desktop's window. */
export async function readTranscriptRange(entry, sessionId, readStoredSession, { offset, limit }) {
  if (
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > 100 ||
    !Number.isSafeInteger(offset + limit)
  )
    throw new TypeError('invalid transcript range');
  const requested = offset + limit;
  let snapshot;
  if (entry) {
    const state = entry.runtime.getState();
    const isolated = {
      runtime: { getState: () => state, readSpilledTranscript: entry.runtime.readSpilledTranscript },
    };
    requestLiveTranscriptWindow(isolated, { limit: requested, byteBudget: null, pageBase: 0 });
    snapshot = windowTranscriptSnapshot(isolated, state);
    isolated.transcriptView.paged = true;
    // One load reads one source (spilled rows, durable history, archive): keep
    // loading until the range is covered, history ends, or a load adds nothing.
    while (snapshot.items.length < requested && snapshot.transcriptHasOlder) {
      const held = snapshot.items.length;
      await loadLiveTranscriptHead(isolated, sessionId, readStoredSession);
      snapshot = windowTranscriptSnapshot(isolated, state);
      if (snapshot.items.length <= held) break;
    }
  } else {
    snapshot = await readStoredSession(sessionId, { transcriptItemLimit: requested });
  }
  if (!snapshot) throw new Error(`session ${sessionId} is not available`);
  const source = snapshot.items || [];
  if (offset >= source.length && snapshot.transcriptHasOlder) {
    throw new Error('session: requested history is not available in the retained projection');
  }
  const end = Math.max(0, source.length - offset);
  const start = Math.max(0, end - limit);
  return {
    sessionId,
    offset,
    items: sanitizeForWire(source.slice(start, end)),
    hasOlder: start > 0 || snapshot.transcriptHasOlder === true,
  };
}
