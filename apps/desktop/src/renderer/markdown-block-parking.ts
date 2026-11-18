import { createContext } from 'react';

// A settled reply keeps in the DOM only the top-level blocks near its
// scroller's viewport. A block further away is parked: one empty box of the
// block's measured height and of the gaps it kept to its neighbours stands in
// its place, so the reply's geometry is unchanged while the block's elements
// are gone. The virtual list unmounts whole rows only; one long reply is a
// single row (a 150 KB reply held ~24k elements, ~150 MB, while any of it was
// in range, and behind every retained tab).
//
// A block is parked from its own layout, so nothing is estimated: a block that
// was never laid out stays mounted. A parked box stands for its block at the
// width and type size it was measured at; returned to the DOM under another,
// the block takes its real height again, and above the reader that growth is
// reported to the list (parkedBlockGrewAbove) so the content in view stays.

/** Attribute of a top-level block's element: the block's id. */
export const UNIT_ATTRIBUTE = 'data-md-unit';
export const PARKED_ATTRIBUTE = 'data-md-parked';

/** Content a block cannot be rebuilt around unseen: it loads after mount, or
 *  the reader changed its state. */
const HELD_CONTENT = 'img, video, audio, iframe, canvas, object, embed, details, .markdown-local-image';

/** How far beyond the viewport, in viewports, blocks stay mounted. */
const REACH_VIEWPORTS = 1;

export interface ParkedBlock {
  height: number;
  /** The gaps to the neighbours, as margins: next to a mounted block they
   *  collapse with its margin to the same gap. */
  before: number;
  after: number;
  /** Width and type of the reply when measured. */
  basis: string;
}

export interface BlockParking {
  subscribe(id: string, listener: () => void): () => void;
  parked(id: string): ParkedBlock | null;
  /** The reply's `.markdown` element, and whether its blocks may park now. */
  attach(container: HTMLElement | null, enabled: boolean): void;
  /** The reply's blocks changed in the DOM. */
  sync(): void;
  /** A body's blocks are other blocks now: the boxes measured for the former
   *  ones (ids `${body}:…`) are dropped. */
  release(body: string): void;
}

export const MarkdownBlockParkingContext = createContext<BlockParking | null>(null);

/** By row: how much taller the blocks that returned above the reader are than
 *  the boxes that stood for them. */
const grownAbove = new WeakMap<Element, number>();

/** This row's size is being measured: how much of its change is the growth of
 *  parked blocks that returned above the reader (0: none). That part moves
 *  the reader's offset; what grew below the reader in the same measurement
 *  does not. Read once. */
export function takeParkedGrowthAbove(row: Element | null | undefined): number {
  const grown = row ? grownAbove.get(row) : undefined;
  if (row === null || row === undefined || grown === undefined) return 0;
  grownAbove.delete(row);
  return grown;
}

function noteGrownAbove(row: Element | null, grown: number): void {
  if (!row || grown === 0) return;
  grownAbove.set(row, (grownAbove.get(row) ?? 0) + grown);
  // The row's size change is observed in the frame the blocks returned in.
  requestAnimationFrame(() => requestAnimationFrame(() => grownAbove.delete(row)));
}

function scrollerOf(element: HTMLElement): HTMLElement | null {
  for (let node = element.parentElement; node; node = node.parentElement) {
    const overflow = getComputedStyle(node).overflowY;
    if (overflow === 'auto' || overflow === 'scroll') return node;
  }
  return null;
}

function laidOutSibling(element: Element, side: 'previousElementSibling' | 'nextElementSibling'): Element | null {
  for (let node = element[side]; node; node = node[side]) {
    if (node.getClientRects().length > 0) return node;
  }
  return null;
}

/** Boxes whose margins meet their siblings' as the parked box's do. */
const BLOCK_DISPLAYS = new Set(['block', 'flow-root', 'list-item', 'flex', 'grid', 'table']);

function basisOf(container: HTMLElement): string {
  const style = getComputedStyle(container);
  return `${container.getBoundingClientRect().width}|${style.fontSize}|${style.lineHeight}|${style.fontFamily}`;
}

function measureBlock(element: HTMLElement, rect: DOMRect, basis: string): ParkedBlock | null {
  const style = getComputedStyle(element);
  if (!BLOCK_DISPLAYS.has(style.display)) return null;
  if (style.float !== 'none' || (style.position !== 'static' && style.position !== 'relative')) return null;
  // The reply's first and last block stay: a margin of theirs, or of a child
  // of theirs, may leave through the reply's own edge, where no gap shows it.
  // Between two siblings every margin that met is the gap between the boxes.
  const previous = laidOutSibling(element, 'previousElementSibling');
  const next = laidOutSibling(element, 'nextElementSibling');
  if (!previous || !next) return null;
  const before = rect.top - previous.getBoundingClientRect().bottom;
  const after = next.getBoundingClientRect().top - rect.bottom;
  if (before < 0 || after < 0 || rect.height <= 0) return null;
  return { height: rect.height, before, after, basis };
}

export function createBlockParking(): BlockParking {
  const boxes = new Map<string, ParkedBlock>();
  const listeners = new Map<string, () => void>();
  const observed = new Set<Element>();
  let container: HTMLElement | null = null;
  let scroller: HTMLElement | null = null;
  let observer: IntersectionObserver | null = null;
  let syncQueued = false;
  /** Blocks returning above the reader from a box of another basis: the box's height. */
  const returnedAbove = new Map<string, number>();

  const set = (id: string, box: ParkedBlock | null) => {
    if (box) boxes.set(id, box);
    else if (!boxes.delete(id)) return;
    listeners.get(id)?.();
  };

  const onEntries = (entries: IntersectionObserverEntry[]) => {
    if (!container || !scroller || !observer) return;
    const view = scroller.getBoundingClientRect();
    // A scroller without a box (a hidden surface) says nothing about distance:
    // nothing parks, and only the observer's word can return a box.
    const measured = view.height > 0 && view.width > 0;
    const reach = view.height * REACH_VIEWPORTS;
    const near = (rect: DOMRect) => measured && rect.bottom > view.top - reach && rect.top < view.bottom + reach;
    const selection = document.getSelection();
    const selecting = selection !== null && !selection.isCollapsed;
    const basis = basisOf(container);
    const returning: string[] = [];
    const parking: Array<[string, ParkedBlock]> = [];
    // The observer reports a box only when it crosses the reach. One it counts
    // within reach (a box touching the edge, or a geometry that moved since
    // its frame) is never reported again while it comes into view, so that
    // word returns it whatever the box's rect says now; a block parks only
    // when the observer and its rect both put it out of reach. Each target's
    // latest entry is its state.
    const latest = new Map<Element, IntersectionObserverEntry>();
    for (const entry of entries) latest.set(entry.target, entry);
    // Every block is measured before any of them changes.
    for (const [target, entry] of latest) {
      const element = target as HTMLElement;
      if (!element.isConnected || element.parentElement !== container) {
        observer.unobserve(element);
        observed.delete(element);
        continue;
      }
      const rect = element.getBoundingClientRect();
      const parkedId = element.getAttribute(PARKED_ATTRIBUTE);
      if (parkedId !== null) {
        if (!entry.isIntersecting && !near(rect)) continue;
        const box = boxes.get(parkedId);
        // Measured at another width or type size, above the reader: its real
        // height is compared once it is back in the DOM (sync).
        if (measured && box && box.basis !== basis && rect.bottom <= view.top) returnedAbove.set(parkedId, box.height);
        returning.push(parkedId);
        continue;
      }
      const id = element.getAttribute(UNIT_ATTRIBUTE);
      if (!id || !measured || entry.isIntersecting || near(rect)) continue;
      if (selecting && selection.containsNode(element, true)) continue;
      if (element.contains(document.activeElement) || element.querySelector(HELD_CONTENT)) continue;
      const box = measureBlock(element, rect, basis);
      if (box) parking.push([id, box]);
    }
    for (const id of returning) set(id, null);
    for (const [id, box] of parking) set(id, box);
  };

  const stop = () => {
    observer?.disconnect();
    observer = null;
    observed.clear();
  };

  const parking: BlockParking = {
    subscribe(id, listener) {
      listeners.set(id, listener);
      return () => {
        if (listeners.get(id) !== listener) return;
        listeners.delete(id);
        boxes.delete(id);
      };
    },
    parked: (id) => boxes.get(id) ?? null,
    attach(element, enabled) {
      // IntersectionObserver is missing only in test DOMs.
      const parks = enabled && typeof IntersectionObserver !== 'undefined';
      const row = parks && element ? element.closest('.transcript-virtual-row') : null;
      const nextScroller = row && element ? scrollerOf(element) : null;
      if (element === container && nextScroller === scroller && Boolean(observer) === Boolean(nextScroller)) return;
      stop();
      container = element;
      scroller = nextScroller;
      if (!scroller) {
        for (const id of [...boxes.keys()]) set(id, null);
        return;
      }
      observer = new IntersectionObserver(onEntries, {
        root: scroller,
        rootMargin: `${REACH_VIEWPORTS * 100}% 0px`,
      });
      parking.sync();
    },
    sync() {
      if (!observer || syncQueued) return;
      syncQueued = true;
      queueMicrotask(() => {
        syncQueued = false;
        if (!observer || !container) return;
        for (const element of observed) {
          if (element.isConnected) continue;
          observer.unobserve(element);
          observed.delete(element);
        }
        const blocks = container.querySelectorAll(`:scope > [${UNIT_ATTRIBUTE}], :scope > [${PARKED_ATTRIBUTE}]`);
        let grown = 0;
        for (const element of blocks) {
          const before = returnedAbove.get(element.getAttribute(UNIT_ATTRIBUTE) ?? '');
          if (before !== undefined) grown += element.getBoundingClientRect().height - before;
          if (observed.has(element)) continue;
          observed.add(element);
          observer.observe(element);
        }
        returnedAbove.clear();
        noteGrownAbove(container.closest('.transcript-virtual-row'), grown);
      });
    },
    release(body) {
      for (const id of [...boxes.keys()]) if (id.startsWith(`${body}:`)) set(id, null);
    },
  };
  return parking;
}
