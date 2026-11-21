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

  constructor(
    readonly sessionId: string,
    private readonly read: () => TranscriptHistoryRead | undefined,
    private readonly live: () => { items: readonly T[]; hasOlder: boolean },
    private readonly onChange: () => void
  ) {}

  dispose(): void {
    this.disposed = true;
  }

  /** Rows' positions as the daemon named them (spilled or archived rows):
   *  a page next to such a row is read where it is. Keyed by the row objects,
   *  so evicted rows take theirs with them. */
  private readonly positions = new WeakMap<object, string>();

  private request(row: T, older: boolean): DesktopTranscriptHistoryRequest {
    const position = historyPositionOf(row, older ? 'before' : 'after') ?? this.positions.get(row);
    return {
      ...(older ? { before: String(row.id) } : { after: String(row.id) }),
      limit: TRANSCRIPT_HISTORY_PAGE_ITEMS,
      byteBudget: TRANSCRIPT_HISTORY_PAGE_BYTES,
      ...(position ? { position } : {}),
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
  private async fetch(boundary: T, older: boolean): Promise<DesktopTranscriptHistoryPage | 'unsupported' | null> {
    const read = this.read();
    if (!read) return this.giveUp();
    const generation = this.generation;
    this.pending = true;
    try {
      const page = await read(this.sessionId, this.request(boundary, older));
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

  /** Older rows above the window (or the live tail). */
  async earlier(): Promise<TranscriptPagingOutcome> {
    if (this.pending || this.unsupported) return this.unsupported ? 'unsupported' : 'idle';
    const live = this.live();
    const base = this.window ?? { items: live.items, hasOlder: live.hasOlder, hasNewer: false };
    const row = base.items[0];
    const boundary = row?.id;
    if (!base.hasOlder || typeof boundary !== 'string' || !boundary) return 'idle';
    const page = await this.fetch(row, true);
    if (page === null || page === 'unsupported') return page ?? 'idle';
    if (page.reset) return this.toLive();
    const current = this.window ?? { items: this.live().items, hasOlder: true, hasNewer: false };
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
    this.window = prependHistoryPage(current, this.remember(page), page.hasOlder);
    this.onChange();
    return 'paged';
  }

  /** Newer rows below the window, held back by an earlier eviction. */
  async later(): Promise<TranscriptPagingOutcome> {
    const window = this.window;
    if (!window?.hasNewer || this.pending || this.unsupported) return 'idle';
    const row = window?.items.at(-1);
    const boundary = row?.id;
    if (!window || !row || typeof boundary !== 'string' || !boundary) return this.toLive();
    const page = await this.fetch(row, false);
    if (page === null || page === 'unsupported') return 'idle';
    if (page.reset) return this.toLive();
    if (this.window !== window) return 'idle';
    this.window = appendHistoryPage(window, this.remember(page), page.hasNewer);
    this.onChange();
    return 'paged';
  }

  /** The reader reached the bottom: newer rows page in, or — none held
   *  back — the live tail takes over again. */
  atBottom(): Promise<TranscriptPagingOutcome> {
    if (!this.window) return Promise.resolve('idle');
    return this.window.hasNewer ? this.later() : Promise.resolve(this.toLive());
  }

  /** Back to the live tail (jump to latest, reset): paging starts over. */
  toLive(): TranscriptPagingOutcome {
    // A read still on its way belongs to the window being left.
    this.generation += 1;
    if (this.window === null) return 'idle';
    this.window = null;
    this.onChange();
    return 'idle';
  }
}
/** Older items loaded per scroll-to-top when the host serves tail windows. */
export const TRANSCRIPT_TAIL_PAGE_ITEMS = 64;
/** History pages back to the session's first row: no item ceiling. */
const TRANSCRIPT_HISTORY_MAX_ITEMS = Number.POSITIVE_INFINITY;

/** Next window for a host that serves tail windows and says whether older
 * history exists (`transcriptHasOlder`). `pagedFrom` is the item count the
 * last page was asked from (-1 before any): until that page lands and the
 * count grows past it, the next page waits. The host bounds each page by
 * bytes, so a landed page can hold fewer than TRANSCRIPT_TAIL_PAGE_ITEMS. */
export function nextTranscriptTailLimit(
  itemCount: number,
  pagedFrom: number,
  hasOlder: boolean,
  maxItems: number = TRANSCRIPT_HISTORY_MAX_ITEMS
): number | null {
  const count = Math.max(0, Math.floor(Number(itemCount) || 0));
  if (!hasOlder || count <= pagedFrom || count >= maxItems) return null;
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
