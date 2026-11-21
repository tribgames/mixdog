import type { DesktopTranscriptHistoryPage, DesktopTranscriptHistoryRequest } from '../shared/contract';
import { historyPositionOf, setHistoryPositions } from '../../../../packages/protocol-client/src/rows.ts';
import { CORE_TRANSCRIPT_HISTORY_POSITION } from '../shared/contract-session';
import { joinTranscriptWindows } from './transcript-alignment';

export const TRANSCRIPT_HISTORY_PAGE_ITEMS = 512;
/** The most items a history window keeps around the reader. */
export const TRANSCRIPT_WINDOW_MAX_ITEMS = 2_048;
/** …and the most serialized characters (about bytes) they may total. */
export const TRANSCRIPT_WINDOW_MAX_CHARS = 16 * 1024 * 1024;
/** Byte budget of one historical-position page. */
const TRANSCRIPT_HISTORY_PAGE_BYTES = 1_000_000;

type HistoryItem = { readonly id?: unknown };

const itemChars = new WeakMap<object, number>();
function charsOf(item: unknown): number {
  if (!item || typeof item !== 'object') return String(item ?? '').length + 2;
  let chars = itemChars.get(item);
  if (chars === undefined) {
    chars = JSON.stringify(item)?.length ?? 4;
    itemChars.set(item, chars);
  }
  return chars;
}

/** A window of history rows the reader scrolled into, apart from the live
 *  tail: `hasOlder`/`hasNewer` say whether rows exist past either end. */
export interface TranscriptHistoryWindow<T> {
  items: readonly T[];
  hasOlder: boolean;
  hasNewer: boolean;
}

/** Whether `count` items of `chars` exceed the window's bounds. */
const overBounds = (count: number, chars: number) =>
  count > TRANSCRIPT_WINDOW_MAX_ITEMS || chars > TRANSCRIPT_WINDOW_MAX_CHARS;

function boundedRun(items: readonly unknown[], joint: number, prepend: boolean): { start: number; end: number } {
  let chars = items.reduce<number>((sum, item) => sum + charsOf(item), 0);
  let start = 0;
  let end = items.length;
  const over = () => overBounds(end - start, chars);
  if (prepend) {
    // The window's newest rows, keeping the row below the page.
    while (end > Math.min(items.length, joint + 1) && over()) chars -= charsOf(items[--end]);
    // Then the page's oldest rows, keeping the one nearest that row.
    while (start < joint - 1 && over()) chars -= charsOf(items[start++]);
    // Still over (that row alone is past the bound): it gives way to the
    // page, so paging always moves on.
    while (joint > 0 && end > joint && over()) chars -= charsOf(items[--end]);
  } else {
    // The window's oldest rows, keeping the row above the page.
    while (start < Math.max(0, joint - 1) && over()) chars -= charsOf(items[start++]);
    // Then the page's newest rows, keeping the one nearest that row.
    while (end > joint + 1 && over()) chars -= charsOf(items[--end]);
    // Still over: that row gives way to the page.
    while (end > joint && start < joint && over()) chars -= charsOf(items[start++]);
  }
  return { start, end };
}

/** `page` (older rows) lands above the window; while the window exceeds its
 *  bounds its newest rows go (then the page's oldest), and it says so. */
export function prependHistoryPage<T extends HistoryItem>(
  window: TranscriptHistoryWindow<T>,
  page: readonly T[],
  hasOlder: boolean
): TranscriptHistoryWindow<T> {
  const { items, joint } = joinTranscriptWindows(page, window.items);
  const { start, end } = boundedRun(items, joint, true);
  return {
    items: start > 0 || end < items.length ? items.slice(start, end) : items,
    hasOlder: hasOlder || start > 0,
    hasNewer: window.hasNewer || end < items.length,
  };
}

/** `page` (newer rows) lands below the window; while the window exceeds its
 *  bounds its oldest rows go (then the page's newest), and it says so. */
export function appendHistoryPage<T extends HistoryItem>(
  window: TranscriptHistoryWindow<T>,
  page: readonly T[],
  hasNewer: boolean
): TranscriptHistoryWindow<T> {
  const { items, joint } = joinTranscriptWindows(window.items, page);
  const { start, end } = boundedRun(items, joint, false);
  return {
    items: start > 0 || end < items.length ? items.slice(start, end) : items,
    hasOlder: window.hasOlder || start > 0,
    hasNewer: hasNewer || end < items.length,
  };
}

export type TranscriptHistoryRead = (
  sessionId: string,
  request: DesktopTranscriptHistoryRequest
) => Promise<DesktopTranscriptHistoryPage>;

/** What one paging step did: 'unsupported' — the host cannot read history
 *  by position, so the caller grows its window instead; 'moved' — the held
 *  rows lost their first under the page read, which was dropped: the caller
 *  reads the window again by growing it. */
export type TranscriptPagingOutcome = 'paged' | 'idle' | 'unsupported' | 'moved';

/**
 * One session's history window: null while the reader is on the live tail.
 * Scrolling up past the live rows reads older history by position (the row
 * at the window's top) into a window of its own, evicting the far end, and
 * back down by position from its bottom row; live rows never patch into it.
 * At the bottom with nothing newer held back, the reader returns to the live
 * tail (a fresh one) and paging starts over.
 */
export class TranscriptHistoryPager<T extends HistoryItem> {
  window: TranscriptHistoryWindow<T> | null = null;
  unsupported = false;
  private pending = false;
  private disposed = false;
  /** Bumped by toLive: a page read under an older one never applies. */
  private generation = 0;
  /** The rows held when the page read that 'moved' was asked: the window to read again is that many rows plus a page, not one
   *  grown from the rows held after the movement. */
  movedFrom = 0;
  /** Rows read by position above the live tail while the reader follows it (the tail window grows no further than the core's
   *  view): shown above the live rows for as long as those begin at `head`. */
  private above: { head: unknown; items: readonly T[]; hasOlder: boolean; cursor: string | undefined } | null = null;
  /** The core's continuation past each end of `window` (`olderCursor`, `newerCursor` of the page that brought that end): the
   *  next page of that direction starts there. An end whose rows were evicted has none, and is read from its row again. */
  private cursors: { older?: string; newer?: string } = {};
  private shownTail: {
    live: readonly T[];
    above: object;
    tail: { items: readonly T[]; hasOlder: boolean };
  } | null = null;

  constructor(
    readonly sessionId: string,
    private readonly read: () => TranscriptHistoryRead | undefined,
    private readonly live: () => { items: readonly T[]; hasOlder: boolean },
    private readonly onChange: () => void
  ) {}

  dispose(): void {
    this.disposed = true;
  }

  /** The live tail as shown: the rows read above it, then the live rows. */
  tail(): { items: readonly T[]; hasOlder: boolean } {
    const live = this.live();
    const above = this.above;
    if (!above || live.items[0]?.id !== above.head) return live;
    if (this.shownTail?.live !== live.items || this.shownTail.above !== above)
      this.shownTail = {
        live: live.items,
        above,
        tail: { items: [...above.items, ...live.items], hasOlder: above.hasOlder },
      };
    return this.shownTail.tail;
  }

  /** Rows' positions as the daemon named them (spilled or archived rows):
   *  a page next to such a row is read where it is. Keyed by the row objects,
   *  so evicted rows take theirs with them. */
  private readonly positions = new WeakMap<object, string>();

  /** A page next to `row`, or from `cursor` (the continuation the page before it named) when there is one. */
  private request(row: T, older: boolean, cursor: string | undefined): DesktopTranscriptHistoryRequest {
    const position = historyPositionOf(row, older ? 'before' : 'after') ?? this.positions.get(row);
    return {
      ...(older ? { before: String(row.id) } : { after: String(row.id) }),
      limit: TRANSCRIPT_HISTORY_PAGE_ITEMS,
      byteBudget: TRANSCRIPT_HISTORY_PAGE_BYTES,
      ...(cursor ? { cursor } : position ? { position } : {}),
    };
  }

  private remember(page: DesktopTranscriptHistoryPage): readonly T[] {
    const rows = page.items as unknown as readonly T[];
    rows.forEach((row, index) => {
      const edges = page.positionEdges?.[index];
      const position = page.positions?.[index];
      if (edges) setHistoryPositions(row, edges.before, edges.after);
      else if (position && CORE_TRANSCRIPT_HISTORY_POSITION.test(position))
        setHistoryPositions(row, position, position);
      else if (position) this.positions.set(row, position);
    });
    return rows;
  }

  /** Positional reads stop for good (an older host, a rejected read): a
   *  window held goes too, so the live tail and window growth take over in
   *  both directions. */
  private giveUp(): 'unsupported' {
    this.unsupported = true;
    this.toLive();
    return 'unsupported';
  }

  /** The page, or null when it no longer applies: disposed, or the window
   *  was reset (toLive) while it was on its way. */
  private async fetch(
    boundary: T,
    older: boolean,
    cursor: string | undefined
  ): Promise<DesktopTranscriptHistoryPage | 'unsupported' | null> {
    const read = this.read();
    if (!read) return this.giveUp();
    const generation = this.generation;
    this.pending = true;
    try {
      const page = await read(this.sessionId, this.request(boundary, older, cursor));
      if (this.disposed || generation !== this.generation) return null;
      return page?.unsupported ? this.giveUp() : page;
    } catch {
      // A host without the method rejects it: grow the window instead.
      if (this.disposed || generation !== this.generation) return null;
      return this.giveUp();
    } finally {
      this.pending = false;
    }
  }

  /** Older rows above the window (or the live tail). `aboveLive`: the reader follows the live tail, which the rows join from above
   *  instead of becoming a window of their own (live rows keep landing below them). */
  async earlier(aboveLive = false): Promise<TranscriptPagingOutcome> {
    if (this.pending || this.unsupported) return this.unsupported ? 'unsupported' : 'idle';
    const base = this.window ?? { ...this.tail(), hasNewer: false };
    const row = base.items[0];
    const boundary = row?.id;
    if (!base.hasOlder || typeof boundary !== 'string' || !boundary) return 'idle';
    const cursor = this.window ? this.cursors.older : this.aboveShown()?.cursor;
    const page = await this.fetch(row, true, cursor);
    if (page === null || page === 'unsupported') return page ?? 'idle';
    if (page.reset) return this.toLive();
    const current = this.window ?? { items: this.tail().items, hasOlder: true, hasNewer: false };
    // The held rows lost their first while the page was on its way: the page no longer fits, and the window the request was made for
    // is read again from the live tail. Rows that landed after the newest leave the page's boundary in place: it goes on top of the
    // rows on screen as they are, as Node's pager placed it (re-reading the window replaced every row the reader was looking at).
    const position = historyPositionOf(row) ?? this.positions.get(row);
    const first = current.items[0];
    if (
      first?.id !== boundary ||
      (position !== undefined && position !== (historyPositionOf(first) ?? this.positions.get(first)))
    ) {
      this.movedFrom = base.items.length;
      this.toLive();
      return 'moved';
    }
    const rows = this.remember(page);
    const hasOlder = goesOn(page.hasOlder, rows, page.olderCursor, cursor);
    if (aboveLive && !this.window) {
      const live = this.live().items;
      const above = current.items.slice(0, current.items.length - live.length);
      this.above = { head: live[0]?.id, items: [...rows, ...above], hasOlder, cursor: page.olderCursor };
    } else {
      const next = prependHistoryPage(current, rows, hasOlder);
      this.cursors = {
        // The page's oldest row leads the window (or the page held none, and only its continuation moved).
        ...(next.items[0] === (rows[0] ?? current.items[0]) && page.olderCursor ? { older: page.olderCursor } : {}),
        ...(this.window && next.items.at(-1) === current.items.at(-1) && this.cursors.newer
          ? { newer: this.cursors.newer }
          : {}),
      };
      this.window = next;
    }
    this.onChange();
    return 'paged';
  }

  /** The rows read above the live tail, while the live rows still begin where they did. */
  private aboveShown() {
    return this.above && this.live().items[0]?.id === this.above.head ? this.above : null;
  }

  /** Newer rows below the window, held back by an earlier eviction. */
  async later(): Promise<TranscriptPagingOutcome> {
    const window = this.window;
    if (!window?.hasNewer || this.pending || this.unsupported) return 'idle';
    const row = window?.items.at(-1);
    const boundary = row?.id;
    if (!window || !row || typeof boundary !== 'string' || !boundary) return this.toLive();
    const cursor = this.cursors.newer;
    const page = await this.fetch(row, false, cursor);
    if (page === null || page === 'unsupported') return 'idle';
    if (page.reset) return this.toLive();
    if (this.window !== window) return 'idle';
    const rows = this.remember(page);
    const next = appendHistoryPage(window, rows, goesOn(page.hasNewer, rows, page.newerCursor, cursor));
    this.cursors = {
      ...(next.items[0] === window.items[0] && this.cursors.older ? { older: this.cursors.older } : {}),
      ...(next.items.at(-1) === (rows.at(-1) ?? window.items.at(-1)) && page.newerCursor
        ? { newer: page.newerCursor }
        : {}),
    };
    this.window = next;
    this.onChange();
    return 'paged';
  }

  /** The reader reached the bottom: newer rows page in, or — none held
   *  back — the live tail takes over again. */
  atBottom(): Promise<TranscriptPagingOutcome> {
    if (!this.window) return Promise.resolve('idle');
    return this.window.hasNewer ? this.later() : Promise.resolve(this.toLive());
  }

  /** The live tail became another window (a history reset): what was read by position around the old one, and a page still
   *  on its way, are not this one's. Tells nobody: the caller is rendering the new window. */
  forget(): void {
    this.generation += 1;
    this.window = null;
    this.above = null;
    this.cursors = {};
  }

  /** Back to the live tail (jump to latest, reset): paging starts over. */
  toLive(): TranscriptPagingOutcome {
    // A read still on its way belongs to the window being left.
    this.generation += 1;
    if (this.window === null && this.above === null) return 'idle';
    this.window = null;
    this.above = null;
    this.cursors = {};
    this.onChange();
    return 'idle';
  }
}

/** Whether history goes on past a page in the direction read: the host says so, and the next read has somewhere new to start,
 *  a row the page brought or a continuation other than the one this page was read from. A page of items that fold to no row
 *  (reasoning) moves only the continuation; with neither, asking again would read the same page. */
function goesOn(more: boolean, rows: readonly unknown[], next: string | undefined, from: string | undefined): boolean {
  return more && (rows.length > 0 || (next !== undefined && next !== from));
}
/** Older items loaded per scroll-to-top when the host serves tail windows. */
export const TRANSCRIPT_TAIL_PAGE_ITEMS = 64;
/** History pages back to the session's first row: no item ceiling. */
const TRANSCRIPT_HISTORY_MAX_ITEMS = Number.POSITIVE_INFINITY;

/** Next window for a host that serves tail windows and says whether older
 * history exists (`transcriptHasOlder`): a page past the rows held. Whether a
 * page may be asked at all is the caller's (use-transcript-history.ts: one
 * request per window start). */
export function nextTranscriptTailLimit(
  itemCount: number,
  hasOlder: boolean,
  maxItems: number = TRANSCRIPT_HISTORY_MAX_ITEMS
): number | null {
  const count = Math.max(0, Math.floor(Number(itemCount) || 0));
  if (!hasOlder || count >= maxItems) return null;
  return Math.min(maxItems, count + TRANSCRIPT_TAIL_PAGE_ITEMS);
}

/** Next durable transcript window requested when the reader reaches the top.
 * Short sessions are already complete; long sessions grow one page at a time
 * and remain bounded even under repeated scroll events. This count-based rule
 * serves hosts that predate `transcriptHasOlder`. */
export function nextTranscriptHistoryLimit(
  itemCount: number,
  currentLimit: number,
  {
    pageItems = TRANSCRIPT_HISTORY_PAGE_ITEMS,
    maxItems = TRANSCRIPT_HISTORY_MAX_ITEMS,
  }: { pageItems?: number; maxItems?: number } = {}
): number | null {
  const count = Math.max(0, Math.floor(Number(itemCount) || 0));
  const page = Math.max(1, Math.floor(Number(pageItems) || TRANSCRIPT_HISTORY_PAGE_ITEMS));
  const maximum = Math.max(page, Math.floor(Number(maxItems) || TRANSCRIPT_HISTORY_MAX_ITEMS));
  const retained = Math.max(page, Math.floor(Number(currentLimit) || page), count);
  // A successful read can be acknowledged before its larger page arrives.
  // Do not issue the next page until that requested window is actually full.
  if (count < Math.max(page, Number(currentLimit) || page) || retained >= maximum) return null;
  return Math.min(maximum, retained + page);
}
