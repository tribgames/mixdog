import { createContext } from 'react';

// A reply keeps in the DOM only the top-level blocks near its scroller's
// viewport. A block further away is parked: one empty box of the block's
// measured height and of the gaps it kept to its neighbours stands in its
// place, so the reply's geometry is unchanged while the block's elements are
// gone. The virtual list unmounts whole rows only; one long reply is a single
// row (a 150 KB reply held ~24k elements, ~150 MB, while any of it was in
// range, and behind every retained tab).
//
// A reply still arriving parks too, or the whole of it stays mounted until it
// ends (a 100k-character reply peaked 130 MB above its settled size, and the
// renderer keeps what a peak committed). Only its last body and the block
// before it stay: that body is parsed again as text arrives, and each parse
// would return what had parked of them.
//
// A box holds the gaps to its two neighbours as they were, so it stands only
// while those are the blocks next to it and unchanged: it is dropped when one
// of them changes (release) and when another element stands next to it (sync).
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
  /** The blocks those gaps were measured to. */
  beside: readonly [string, string];
  /** Width and type of the reply when measured. */
  basis: string;
}

export interface BlockParking {
  subscribe(id: string, listener: () => void): () => void;
  parked(id: string): ParkedBlock | null;
  /** The reply's `.markdown` element, and whether its blocks may park now.
   *  `growing`: the reply is still arriving or fading in, so the blocks of
   *  its last body stay mounted. */
  attach(container: HTMLElement | null, enabled: boolean, growing?: boolean): void;
  /** The reply's elements changed in the DOM. */
  sync(): void;
  /** A body's blocks are other blocks now: the boxes measured for the former
   *  ones (ids `${body}:…`) are dropped, and those measured next to one of
   *  them. */
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

/** A child of the reply that takes no box: a body whose parse is still to land. */
const unshown = (element: Element) => (element as HTMLElement).hidden;

function shownSibling(element: Element, side: 'previousElementSibling' | 'nextElementSibling'): Element | null {
  for (let node = element[side]; node; node = node[side]) {
    if (!unshown(node)) return node;
  }
  return null;
}

/** Boxes whose margins meet their siblings' as the parked box's do. */
const BLOCK_DISPLAYS = new Set(['block', 'flow-root', 'list-item', 'flex', 'grid', 'table']);

function basisOf(container: HTMLElement): string {
  const style = getComputedStyle(container);
  return `${container.getBoundingClientRect().width}|${style.fontSize}|${style.lineHeight}|${style.fontFamily}`;
}

/** A block id is its body's id and the block's place in it (MarkdownAstBody). */
const bodyOf = (id: string) => id.slice(0, id.lastIndexOf(':'));

/** The id of the block `element` is, mounted or parked. */
const blockId = (element: Element) => element.getAttribute(UNIT_ATTRIBUTE) ?? element.getAttribute(PARKED_ATTRIBUTE);

/** The body the reply's last block belongs to. */
function lastBodyOf(container: HTMLElement): string | null {
  for (let node = container.lastElementChild; node; node = node.previousElementSibling) {
    const id = blockId(node);
    if (id !== null) return bodyOf(id);
  }
  return null;
}

/** Whether the block `element` is of `body`, or the one right before it. */
function atBody(element: Element, body: string | null): boolean {
  if (body === null) return false;
  for (let node: Element | null = element; node; node = node.nextElementSibling) {
    const id = blockId(node);
    if (id === null) continue;
    if (bodyOf(id) === body) return true;
    if (node !== element) return false;
  }
  return false;
}

function measureBlock(element: HTMLElement, rect: DOMRect, basis: string): ParkedBlock | null {
  const style = getComputedStyle(element);
  if (!BLOCK_DISPLAYS.has(style.display)) return null;
  if (style.float !== 'none' || (style.position !== 'static' && style.position !== 'relative')) return null;
  // The reply's first and last block stay: a margin of theirs, or of a child
  // of theirs, may leave through the reply's own edge, where no gap shows it.
  // Between two siblings every margin that met is the gap between the boxes.
  const previous = shownSibling(element, 'previousElementSibling');
  const next = shownSibling(element, 'nextElementSibling');
  if (!previous || !next) return null;
  // A neighbour that is no block changes unseen: a gap to it cannot be held.
  const above = blockId(previous);
  const below = blockId(next);
  if (above === null || below === null) return null;
  // Nor to a block without height (an empty heading, which has no box at all
  // while the reply streams): the margins around it meet through it, so the
  // gap is not one between this block and it.
  const aboveRect = previous.getBoundingClientRect();
  const belowRect = next.getBoundingClientRect();
  if (aboveRect.height <= 0 || belowRect.height <= 0) return null;
  const before = rect.top - aboveRect.bottom;
  const after = belowRect.top - rect.bottom;
  if (before < 0 || after < 0 || rect.height <= 0) return null;
  return { height: rect.height, before, after, beside: [above, below], basis };
}

export function createBlockParking(): BlockParking {
  const boxes = new Map<string, ParkedBlock>();
  const listeners = new Map<string, () => void>();
  const observed = new Set<Element>();
  let container: HTMLElement | null = null;
  let scroller: HTMLElement | null = null;
  let observer: IntersectionObserver | null = null;
  let growing = false;
  /** Blocks out of reach that stayed for being in the last body of a growing reply. */
  const held = new Set<Element>();
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
    const unsettled = growing ? lastBodyOf(container) : null;
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
      if (atBody(element, unsettled)) {
        held.add(element);
        continue;
      }
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
    held.clear();
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
    attach(element, enabled, grows = false) {
      // IntersectionObserver is missing only in test DOMs.
      const parks = enabled && typeof IntersectionObserver !== 'undefined';
      const row = parks && element ? element.closest('.transcript-virtual-row') : null;
      const nextScroller = row && element ? scrollerOf(element) : null;
      const settled = growing && !grows;
      growing = grows;
      // The observer reports a block only when it crosses the reach. Once the
      // reply is final, a new observer reports every block again: the ones
      // that stayed for what was still to change may park.
      if (
        element === container &&
        nextScroller === scroller &&
        Boolean(observer) === Boolean(nextScroller) &&
        !settled
      ) {
        return;
      }
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
        const shown = [...container.children].filter((element) => !unshown(element));
        const ids = shown.map(blockId);
        const displaced: string[] = [];
        let grown = 0;
        shown.forEach((element, index) => {
          const id = ids[index];
          if (id === null) return;
          const box = boxes.get(id);
          if (box && (box.beside[0] !== ids[index - 1] || box.beside[1] !== ids[index + 1])) displaced.push(id);
          const before = returnedAbove.get(element.getAttribute(UNIT_ATTRIBUTE) ?? '');
          if (before !== undefined) grown += element.getBoundingClientRect().height - before;
          if (observed.has(element)) return;
          observed.add(element);
          observer?.observe(element);
        });
        returnedAbove.clear();
        noteGrownAbove(container.closest('.transcript-virtual-row'), grown);
        for (const id of displaced) set(id, null);
        // The observer reports a block only when it crosses the reach: a held
        // block no longer at the last body is observed anew, which reports it
        // again.
        const unsettled = held.size > 0 && growing ? lastBodyOf(container) : null;
        for (const element of held) {
          if (element.isConnected && atBody(element, unsettled)) continue;
          held.delete(element);
          if (!observed.has(element)) continue;
          observer.unobserve(element);
          observer.observe(element);
        }
      });
    },
    release(body) {
      const own = (id: string) => id.startsWith(`${body}:`);
      for (const [id, box] of [...boxes]) if (own(id) || box.beside.some(own)) set(id, null);
    },
  };
  return parking;
}
