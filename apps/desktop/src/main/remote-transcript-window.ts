// A phone's own transcript window over the session's shared one. The host
// reads one daemon window per session for every view that shows it — a
// desktop pane's 32 rows / 1 MB when one shares the session, and at least 8
// rows of any size — so that window bounds nothing on a phone link. Each
// phone's copy is cut here, per delta encoder (one per phone and session):
//  - a first page (the encoder holds nothing, or nothing it holds is left) is
//    the newest rows whose phone copies fit REMOTE_TRANSCRIPT_TAIL_ITEMS rows
//    and REMOTE_TRANSCRIPT_TAIL_BYTES serialized bytes, and always its newest
//    row: an oversized tool row goes with its outputs cut to fit
//    (remote-transcript.ts), but a message row is sent whole, so one over the
//    budget alone makes a first page over it;
//  - later frames keep every row from the first one the phone holds, and
//    reveal rows above it only up to the window the phone asked for
//    (`prefetchSession`'s limit, requestPhoneTranscriptPage), within
//    DESKTOP_TRANSCRIPT_PAGE_BYTES per frame past the first revealed row;
//  - rows above the first page's first row are history (cut to their head);
//    the first page and every row after it are tail.
import {
  DESKTOP_TRANSCRIPT_PAGE_BYTES,
  REMOTE_TRANSCRIPT_TAIL_BYTES,
  REMOTE_TRANSCRIPT_TAIL_ITEMS,
} from './desktop-support';
import { remoteTranscriptRow, remoteTranscriptSnapshot } from './remote-transcript';
import type { SnapshotDeltaEncoder } from './state-delta';

interface PhoneWindow {
  /** The first row of the phone's first page: where its tail starts. */
  tailFirstId: unknown;
  /** Rows the phone asked to hold. */
  limit: number;
}
/** One window per phone and session: keyed by Node's delta encoder, or by the K1 phone's own per-thread key
 *  (remote-phone-transcript.ts). */
const phoneWindows = new WeakMap<object, PhoneWindow>();

const idOf = (item: unknown): unknown => (item && typeof item === 'object' ? (item as { id?: unknown }).id : undefined);

function indexOfId(items: readonly unknown[], id: unknown): number {
  if (id === undefined || id === null) return -1;
  return items.findIndex((item) => idOf(item) === id);
}

/** First index of the rows kept above `end`: at most `maxItems`, and past the
 *  first one no more serialized phone-copy bytes than `byteBudget`. */
function budgetedStart(
  items: readonly unknown[],
  end: number,
  maxItems: number,
  byteBudget: number,
  history: boolean
): number {
  let start = end;
  let bytes = 0;
  while (start > 0 && end - start < maxItems) {
    const next = remoteTranscriptRow(items[start - 1], history).bytes;
    if (start < end && bytes + next > byteBudget) break;
    bytes += next;
    start -= 1;
  }
  return start;
}

/** Rows one history page request may add to a phone's window, whatever limit
 *  it names (the daemon's per-answer bound). */
const PHONE_PAGE_MAX_ITEMS = 512;

/** The phone asked for a window of `limit` rows (a history page). */
export function requestPhoneTranscriptPage(key: object | undefined, limit: number): void {
  const window = key ? phoneWindows.get(key) : undefined;
  if (window && Number.isInteger(limit) && limit > window.limit) {
    window.limit = Math.min(limit, window.limit + PHONE_PAGE_MAX_ITEMS);
  }
}

/** Rows above the first one the phone holds (`held[0]`) that its window asks for and `items` would have to give: what a
 *  page still has to bring when `items` lacks them. 0 before a first page. */
export function phoneTranscriptWanted(key: object, items: readonly unknown[], held: readonly unknown[] | undefined): number {
  const window = phoneWindows.get(key);
  const start = window && held?.length ? indexOfId(items, idOf(held[0])) : -1;
  if (!window || start < 0) return 0;
  return Math.max(0, wantedAbove(window, items, start));
}

/** Rows above `start` the window asks for, at most one page. */
const wantedAbove = (window: PhoneWindow, items: readonly unknown[], start: number): number =>
  Math.min(window.limit - (items.length - start), PHONE_PAGE_MAX_ITEMS);

/** `snapshot` as one phone's window over it (`key`: one per phone and session), given the rows the phone `held` last: its
 *  window of rows, each as its phone copy (remoteTranscriptSnapshot), and `transcriptHasOlder` set when rows above the
 *  window are left out. */
export function phoneTranscriptView(key: object, snapshot: unknown, held: readonly unknown[] | undefined): unknown {
  const record = snapshot && typeof snapshot === 'object' ? (snapshot as Record<string, unknown>) : null;
  if (!record || !Array.isArray(record.items)) return remoteTranscriptSnapshot(snapshot);
  const items = record.items as unknown[];
  let window = phoneWindows.get(key);
  let start = window && Array.isArray(held) && held.length ? indexOfId(items, idOf(held[0])) : -1;
  let tailStart = window && start >= 0 ? indexOfId(items, window.tailFirstId) : -1;
  if (!window || start < 0 || tailStart < start) {
    start = budgetedStart(items, items.length, REMOTE_TRANSCRIPT_TAIL_ITEMS, REMOTE_TRANSCRIPT_TAIL_BYTES, false);
    tailStart = start;
    window = { tailFirstId: idOf(items[start]), limit: items.length - start };
    phoneWindows.set(key, window);
  } else {
    const wanted = wantedAbove(window, items, start);
    if (wanted > 0) start = budgetedStart(items, start, wanted, DESKTOP_TRANSCRIPT_PAGE_BYTES, true);
  }
  const windowed = start === 0 ? record : { ...record, items: items.slice(start), transcriptHasOlder: true };
  return remoteTranscriptSnapshot(windowed, tailStart - start);
}

/** The wire a phone's encoder sends for `snapshot`: its own window for a phone
 *  that pages (`transcriptPaging`), the whole window for an older build that
 *  cannot page from `transcriptHasOlder`. */
export function encodePhoneSessionState(encoder: SnapshotDeltaEncoder, snapshot: unknown, paging: boolean): unknown {
  const held = (encoder.resumePoint()?.held as { items?: unknown } | undefined)?.items;
  return encoder.encode(
    paging ? phoneTranscriptView(encoder, snapshot, Array.isArray(held) ? held : undefined) : remoteTranscriptSnapshot(snapshot)
  );
}
