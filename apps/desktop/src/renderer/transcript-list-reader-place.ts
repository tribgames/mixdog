// Where the reader of a session is in a pane, kept apart from the rows that show it: the list that shows the session
// tells it as the reader moves and when it leaves, and the same list coming back on screen puts the reader back there
// before it is presented. A session entered anew follows its end and lets go of the place (`useSessionEntry`).
import { type MutableRefObject, useLayoutEffect, useRef, useSyncExternalStore } from 'react';
import { historyPositionOf } from '../../../../packages/protocol-client/src/rows.ts';
import { usePaneKey } from './pane-key-context';
import { useSurfaceActive } from './surface-activity';
import {
  coreScrollState,
  firstRowEndingAfter,
  logicalScrollOffset,
  type ReadingAnchor,
  type TranscriptVirtualizer,
  viewportSize,
} from './transcript-list-geometry';
import type { TranscriptRowModel } from './transcript-rows';

/** A reader off the end: the stored record the row at the top of its view shows, and where that row stood. A reader
 *  who follows the end has none. */
export interface ReaderPlace {
  /** The record's position in the session's history: the row's identity whatever rows are held. */
  readonly position: string;
  /** The row's key in the list that told the place. */
  readonly key?: string;
  /** The row's top from the viewport's scroll origin, in pixels: negative for a row that begins above the view, and
   *  then how far into the row the view begins. 'center': the row is put mid-view (a record opened from outside). */
  readonly top: number | 'center';
  /** The record the row under it shows: where the reader is put when the place's own record is no longer held. */
  readonly next?: string;
  /** The row's measured height and the viewport's width and height when the place was told: a list of another width
   *  or text size shows the row at another height, and the place is the row's top either way. */
  readonly size?: number;
  readonly viewport?: { readonly width: number; readonly height: number };
}

interface Kept {
  place: ReaderPlace;
  /** Told from outside the list that shows it (a list that left, a jump): the list that shows the session puts the
   *  reader there, and tells nothing of its own until it has. */
  pending: boolean;
}

/** By pane, then by session. An entry lives while its pane holds a tab of the session (`keepReaderPlaces`). */
const places = new Map<string, Map<string, Kept>>();
const listeners = new Set<() => void>();
let version = 0;
const changed = (): void => {
  version += 1;
  for (const listener of [...listeners]) listener();
};
const subscribe = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => void listeners.delete(listener);
};
const readVersion = (): number => version;

/** The sessions each pane holds a tab of, as last told (null until the panes told any): the generation of places a
 *  save must belong to. */
let tabsNow: ReadonlyMap<string, ReadonlySet<string>> | null = null;

const kept = (pane: string, session: string): Kept | undefined => places.get(pane)?.get(session);
function keep(pane: string, session: string, entry: Kept | null): void {
  // A surface outside the panes has no tab to come back to.
  if (!pane || !session) return;
  // A save for a place its pane let go (the tab was closed) arrives late: it is dropped.
  if (entry && tabsNow && !tabsNow.get(pane)?.has(session)) return;
  let ofPane = places.get(pane);
  if (!entry) {
    ofPane?.delete(session);
    if (ofPane?.size === 0) places.delete(pane);
    return;
  }
  if (!ofPane) {
    ofPane = new Map();
    places.set(pane, ofPane);
  }
  ofPane.set(session, entry);
}

/** Where the pane's reader of the session is; null for one who follows the end. */
export function readerPlace(pane: string, session: string): ReaderPlace | null {
  return kept(pane, session)?.place ?? null;
}

/** The place the list that shows the session has yet to put its reader at. */
export function pendingReaderPlace(pane: string, session: string): ReaderPlace | null {
  const entry = kept(pane, session);
  return entry?.pending ? entry.place : null;
}

/** Opens the pane's view of the session at a record: the rows around it are read if they are not held, and the reader
 *  is put on its row. */
export function openReaderPlace(pane: string, session: string, place: ReaderPlace): void {
  keep(pane, session, { place, pending: true });
  changed();
}

/** The record the place names is no longer in the history: the reader is at the end. */
export function voidReaderPlace(pane: string, session: string): void {
  if (!kept(pane, session)) return;
  keep(pane, session, null);
  changed();
}

/** The places kept are those of the sessions each pane holds a tab of; every other one is let go. */
export function keepReaderPlaces(tabs: ReadonlyMap<string, ReadonlySet<string>>): void {
  tabsNow = tabs;
  for (const [pane, ofPane] of places) {
    const sessions = tabs.get(pane);
    for (const session of [...ofPane.keys()]) if (!sessions?.has(session)) ofPane.delete(session);
    if (ofPane.size === 0) places.delete(pane);
  }
}

export function readerPlaceCount(): number {
  let count = 0;
  for (const ofPane of places.values()) count += ofPane.size;
  return count;
}

/** Whether a pane holds a tab of `session` (a reader may come back to it); null until the panes told their tabs. */
export function sessionHasTab(session: string): boolean | null {
  if (!tabsNow) return null;
  for (const sessions of tabsNow.values()) if (sessions.has(session)) return true;
  return false;
}

/** The conversation of a pane comes to show `session`: it enters it at its end, so the place a list of the session left
 *  in the pane is let go in the render that enters it, before anything below reads it. */
export function useSessionEntry(session: string): void {
  const pane = usePaneKey();
  const entered = useRef<string | null>(null);
  if (entered.current === session) return;
  entered.current = session;
  keep(pane, session, null);
}

/** Re-renders the caller when a place is opened or voided from outside its list. */
export function useReaderPlaceVersion(): number {
  return useSyncExternalStore(subscribe, readVersion, readVersion);
}

function itemsOf(row: TranscriptRowModel) {
  if ('items' in row) return row.items;
  return 'item' in row && row.item ? [row.item] : [];
}

/** The stored record `row` shows first. */
function rowPosition(row: TranscriptRowModel | undefined): string | undefined {
  if (!row) return undefined;
  for (const item of itemsOf(row)) {
    const position = historyPositionOf(item);
    if (position !== undefined) return position;
  }
  return undefined;
}

/** Whether `row` shows the record at `position`. */
function rowShowsPosition(row: TranscriptRowModel, position: string): boolean {
  return itemsOf(row).some(
    (item) => historyPositionOf(item) === position || historyPositionOf(item, 'after') === position
  );
}

/** The row of `rows` the place names: by its key when that row still shows the record, else by the record, else the
 *  row of the record under it. */
export function rowOfPlace(rows: readonly TranscriptRowModel[], place: ReaderPlace): number {
  if (place.key !== undefined) {
    const byKey = rows.findIndex((row) => row.key === place.key);
    if (byKey >= 0 && rowShowsPosition(rows[byKey] as TranscriptRowModel, place.position)) return byKey;
  }
  const own = rows.findIndex((row) => rowShowsPosition(row, place.position));
  if (own >= 0 || place.next === undefined) return own;
  const next = place.next;
  return rows.findIndex((row) => rowShowsPosition(row, next));
}

/** The rows in a reader's view, by index, for each mounted list's viewport. */
const views = new WeakMap<Element, () => { from: number; to: number } | null>();

/** The first and last rows in the reader's view of the list in `viewport`, from where it is scrolled to now (the rows
 *  it draws follow a frame later). */
export function readerRows(viewport: Element): { from: number; to: number } | null {
  return views.get(viewport)?.() ?? null;
}

/** The row each list put its reader on, by the list's virtualizer: the place names that row's top. */
const placedRows = new WeakMap<object, unknown>();

/** The list of `instance` put its reader on the row `key`. */
export function noteReaderPlaced(instance: object, key: unknown): void {
  placedRows.set(instance, key);
}

/** Whether `item` is the row the list put its reader on and still crosses the top of the view at `top`: its size
 *  settling (a body that was not ready when the reader was put there) then moves what is under it, never its top.
 *  Once the reader has moved off the row it is a row like any other. */
export function holdsReaderTop(
  instance: object,
  item: { key: unknown; start: number; end: number },
  top: number
): boolean {
  if (placedRows.get(instance) !== item.key) return false;
  if (item.start <= top && item.end > top) return true;
  placedRows.delete(instance);
  return false;
}

type AnchorHold = MutableRefObject<(ReadingAnchor & { start: number | null }) | null>;

/** The list's part in its reader's place. It tells the place as the reader scrolls and when the list leaves the
 *  screen, read from the viewport as it stands (a scroll no event has reported yet included). A place it is handed
 *  (`pendingReaderPlace`) it resolves through the reading anchor, the one mechanism that holds a row still while the
 *  rows above it take their sizes (transcript-list-reading-anchor.ts): no other scroll write is made for it. */
export function useReaderPlace({
  sessionKey,
  viewport,
  rowsRef,
  virtualizerRef,
  scrollInset,
  deviation,
  anchorHold,
  restoreReadingAnchor,
  flushDeferredResizes,
}: {
  sessionKey: string;
  viewport: { readonly current: HTMLDivElement | null };
  rowsRef: MutableRefObject<readonly TranscriptRowModel[]>;
  virtualizerRef: MutableRefObject<TranscriptVirtualizer>;
  scrollInset: MutableRefObject<number>;
  /** Rows shifted under a held touch scroll: the logical offset carries them. */
  deviation: { amount(): number };
  anchorHold: AnchorHold;
  restoreReadingAnchor: (landing?: boolean) => void;
  /** Lands the sizes the list holds back for rows above the reader while a scroll goes on. */
  flushDeferredResizes: () => void;
}) {
  const pane = usePaneKey();
  const active = useSurfaceActive();
  useReaderPlaceVersion();
  // A list mounted in the commit that mounts its viewport runs its effects before the viewport's ref is set: the
  // render after it sees the element.
  const element = viewport.current;
  // biome-ignore lint/correctness/useExhaustiveDependencies: the list's own state is read through refs at the time of each event
  useLayoutEffect(() => {
    if (!active || !element) return undefined;
    const reading = (): number =>
      element.isConnected ? element.scrollTop + deviation.amount() : logicalScrollOffset(virtualizerRef.current);
    /** The rows whose boxes the view crosses, from the sizes the list holds. */
    const inView = (): { from: number; to: number; top: number } | null => {
      const instance = virtualizerRef.current;
      const measurements = instance.measurementsCache;
      const count = Math.min(rowsRef.current.length, measurements.length);
      if (count === 0) return null;
      const top = reading();
      const visibleTop = top - scrollInset.current;
      const low = firstRowEndingAfter(measurements, count, visibleTop);
      const bottom = visibleTop + viewportSize(instance);
      let to = low;
      while (to + 1 < count && (measurements[to + 1]?.start ?? 0) < bottom) to += 1;
      return { from: low, to, top };
    };
    /** undefined: the list has nothing to tell of (no row is laid out). */
    const capture = (): ReaderPlace | null | undefined => {
      const instance = virtualizerRef.current;
      if (instance.options.anchorTo === 'end') return null;
      const view = inView();
      if (!view) return undefined;
      const rows = rowsRef.current;
      // The first row in view that shows a stored record; rows no record holds yet are passed over, downward first.
      let at = -1;
      for (let index = view.from; index < rows.length && at < 0; index += 1) if (rowPosition(rows[index])) at = index;
      for (let index = view.from - 1; index >= 0 && at < 0; index -= 1) if (rowPosition(rows[index])) at = index;
      const row = rows[at];
      const position = rowPosition(row);
      if (!row || position === undefined) return undefined;
      let next: string | undefined;
      for (let index = at + 1; index < rows.length && next === undefined; index += 1) {
        const under = rowPosition(rows[index]);
        if (under !== position) next = under;
      }
      const measured = instance.measurementsCache[at];
      return {
        position,
        key: String(row.key),
        top: (measured?.start ?? 0) - view.top,
        ...(next !== undefined ? { next } : {}),
        size: measured?.size ?? 0,
        viewport: { width: element.clientWidth, height: viewportSize(instance) },
      };
    };
    const tell = (pending: boolean): void => {
      // A place handed to the list is the reader's until the list has put it there.
      if (kept(pane, sessionKey)?.pending) return;
      const place = capture();
      if (place === undefined) return;
      keep(pane, sessionKey, place ? { place, pending } : null);
    };
    const onScroll = (): void => tell(false);
    element.addEventListener('scroll', onScroll, { passive: true });
    views.set(element, inView);
    return () => {
      element.removeEventListener('scroll', onScroll);
      views.delete(element);
      // A size held back for a row above the reader lands before the frame that shows the row (the list's own pump,
      // each frame). A list that leaves in the task of the reader's last scroll has no such frame: the sizes land
      // here, as that frame would have landed them, so the place told is of the rows as they are.
      // The list learns of the scroll first: what a landing size moves is the view as it stands.
      if (element.isConnected) coreScrollState(virtualizerRef.current).scrollOffset = reading();
      flushDeferredResizes();
      tell(true);
    };
  }, [active, element, pane, sessionKey]);
  // The render that will resolve a handed place computes its range at the offset the commit writes, so the rows
  // mounted are the reader's and none at the list's start mount first.
  const handed = active ? pendingReaderPlace(pane, sessionKey) : null;
  if (handed && virtualizerRef.current.options.anchorTo !== 'end') {
    const instance = virtualizerRef.current;
    const index = rowOfPlace(rowsRef.current, handed);
    if (index >= 0) {
      instance.getTotalSize();
      const measured = instance.measurementsCache[index];
      const top =
        handed.top === 'center' ? Math.max(0, (viewportSize(instance) - (measured?.size ?? 0)) / 2) : handed.top;
      if (measured) coreScrollState(instance).scrollOffset = Math.max(0, measured.start - top);
    }
  }
  // Every commit: a handed place resolves in the first one whose rows show its record, off the end.
  useLayoutEffect(() => {
    if (!active) return;
    const place = pendingReaderPlace(pane, sessionKey);
    if (!place) return;
    const instance = virtualizerRef.current;
    if (instance.options.anchorTo === 'end') return;
    const rows = rowsRef.current;
    const index = rowOfPlace(rows, place);
    const row = rows[index];
    if (!row) return;
    instance.getTotalSize();
    const size = instance.measurementsCache[index]?.size ?? 0;
    const top = place.top === 'center' ? Math.max(0, (viewportSize(instance) - size) / 2) : place.top;
    // The row's own box, once it is mounted: a row that begins above the view and is taller or shorter than the size
    // held for it would otherwise be corrected from its lower edge, and its top is what the place names.
    const node = [...(element?.querySelectorAll<HTMLElement>('.transcript-virtual-row') ?? [])].find(
      (candidate) => candidate.dataset.timelineKey === String(row.key)
    );
    const box = node ? Math.round(node.getBoundingClientRect().height) : 0;
    if (node && box > 0 && box !== size) instance.resizeItem(index, box);
    anchorHold.current = { key: row.key, offset: top, index, start: null };
    restoreReadingAnchor(true);
    if (node) noteReaderPlaced(instance, row.key);
    // Placed once its row is: until then the commit that mounts the row resolves the place again.
    keep(pane, sessionKey, { place: { ...place, key: String(row.key), top }, pending: node === undefined });
  });
}
