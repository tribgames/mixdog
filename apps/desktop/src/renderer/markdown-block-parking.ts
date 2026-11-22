import { createContext } from 'react';
import { markdownWorkCounts } from './markdown-work-counts';

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

/** The blocks one element holds, and which of them are parked. */
export interface ParkedBlocks {
  subscribe(id: string, listener: () => void): () => void;
  parked(id: string): ParkedBlock | null;
  /** The blocks changed in the DOM. */
  sync(): void;
}

export interface BlockParking extends ParkedBlocks {
  /** The reply's `.markdown` element, and whether its blocks may park now.
   *  `growing`: the reply is still arriving or fading in, so its held
   *  blocks stay mounted. */
  attach(container: HTMLElement | null, enabled: boolean, growing?: boolean): void;
  /** Block `id` shows other content now, or left: the box measured for it is
   *  dropped, and those measured next to it, and what was kept for its code
   *  blocks (places `${id}/…`). */
  release(id: string): void;
  /** While the reply grows, block `id` stays mounted (the open block and the
   *  one before it). */
  hold(id: string, held: boolean): void;
  /** The blocks inside one block of this reply, each its own body (the
   *  stretches of lines of a code block): they park against the reply's
   *  scroller while the reply's own may, and while it grows the last two
   *  stay. `place` names their holder in the reply (`${body}/…`, null: no
   *  place is known): a holder that left the DOM with the block around it
   *  takes up, back at its place, what was parked of it, so it never returns
   *  whole. A body's new blocks drop what was kept for its places (release). */
  inner(place: string | null): InnerBlockParking;
}

export interface InnerBlockParking extends ParkedBlocks {
  /** The element holding the blocks (null: they do not park). */
  attach(container: HTMLElement | null): void;
  /** The holder left the DOM, from `place`. */
  leave(place: string | null): void;
}

/** Prop of a code block: its place in the reply (`inner`). */
export const PLACE_PROP = 'data-md-place';

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

/** The id of the block `element` is, mounted or parked. */
const blockId = (element: Element) => element.getAttribute(UNIT_ATTRIBUTE) ?? element.getAttribute(PARKED_ATTRIBUTE);

/** The block a code block's place is in (PLACE_PROP: `${block}/${index}`). */
const blockOf = (place: string) => place.slice(0, place.lastIndexOf('/'));

/** Whether at most one block follows `element` in its holder. */
function amongLastTwo(element: Element): boolean {
  let after = 0;
  for (let node = element.nextElementSibling; node; node = node.nextElementSibling) {
    if (blockId(node) !== null && ++after > 1) return false;
  }
  return true;
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

/** Whether the scroller's box tells distances (a hidden surface has none). */
const measuredView = (view: DOMRect) => view.height > 0 && view.width > 0;

/** Whether `rect` is within reach of the reader. */
function nearView(rect: DOMRect, view: DOMRect): boolean {
  const reach = view.height * REACH_VIEWPORTS;
  return measuredView(view) && rect.bottom > view.top - reach && rect.top < view.bottom + reach;
}

/** The parking of the blocks one element holds, against a given scroller.
 *  `beforePark`: a block is about to leave the DOM. `lastTwo`: while the
 *  holder grows its last two blocks stay, as well as those held by id. */
function createParking(beforePark?: (element: HTMLElement) => void, lastTwo = false) {
  const boxes = new Map<string, ParkedBlock>();
  /** By block: the boxes measured next to it. */
  const besideOf = new Map<string, Set<string>>();
  const listeners = new Map<string, () => void>();
  const observed = new Set<Element>();
  let container: HTMLElement | null = null;
  let scroller: HTMLElement | null = null;
  let observer: IntersectionObserver | null = null;
  /** The holder's own changes (its children, and their ids and visibility)
   *  since the last sync: a sync looks at those and their neighbours only. */
  let changes: MutationObserver | null = null;
  /** Its records delivered before the sync that reads them. */
  let delivered: MutationRecord[] = [];
  /** The next sync looks at every block (a new observer knows none). */
  let syncAll = true;
  let growing = false;
  /** Blocks that stay while the holder grows, by id. */
  const heldIds = new Set<string>();
  /** Blocks out of reach that stayed for that. */
  const stayed = new Map<string, Element>();
  const stays = (id: string, element: Element) => growing && (heldIds.has(id) || (lastTwo && amongLastTwo(element)));
  /** Blocks out of reach that stayed for a selection over them, and the ids of
   *  those returning for one. */
  const selected = new Set<Element>();
  const selectedIds = new Set<string>();
  /** The holder is out of the DOM; what is parked of it is kept for its return. */
  let away = false;
  let syncQueued = false;
  /** Blocks returning above the reader from a box of another basis: the box's height. */
  const returnedAbove = new Map<string, number>();

  const forget = (id: string) => {
    const box = boxes.get(id);
    if (!box) return false;
    boxes.delete(id);
    for (const near of box.beside) {
      const ids = besideOf.get(near);
      ids?.delete(id);
      if (ids?.size === 0) besideOf.delete(near);
    }
    return true;
  };

  const set = (id: string, box: ParkedBlock | null) => {
    const had = forget(id);
    if (box) {
      boxes.set(id, box);
      for (const near of box.beside) {
        const ids = besideOf.get(near) ?? new Set<string>();
        ids.add(id);
        besideOf.set(near, ids);
      }
    } else if (!had) return;
    listeners.get(id)?.();
  };

  /** A parked block is to return. Measured at another width or type size,
   *  above the reader: its real height is compared once it is back in the DOM
   *  (sync). */
  const noteAbove = (id: string, rect: DOMRect, view: DOMRect, basis: string) => {
    const box = boxes.get(id);
    if (measuredView(view) && box && box.basis !== basis && rect.bottom <= view.top) returnedAbove.set(id, box.height);
  };

  /** The selection, when it runs over blocks of the holder. */
  const selectionOver = () => {
    const selection = document.getSelection();
    const over = container && selection && !selection.isCollapsed && selection.containsNode(container, true);
    return over ? selection : null;
  };

  /** The parked blocks the selection runs over return, and those `near` the
   *  reader when it is given. A selection copies what is in the DOM. */
  const giveBack = (selection: Selection | null, near: boolean) => {
    if (!container || !scroller || (!selection && !near)) return;
    const view = scroller.getBoundingClientRect();
    const basis = basisOf(container);
    const returning: string[] = [];
    for (const element of container.children) {
      const id = element.getAttribute(PARKED_ATTRIBUTE);
      if (id === null) continue;
      const rect = element.getBoundingClientRect();
      const over = selection?.containsNode(element, true) ?? false;
      if (!over && !(near && nearView(rect, view))) continue;
      if (over) selectedIds.add(id);
      noteAbove(id, rect, view, basis);
      returning.push(id);
    }
    for (const id of returning) set(id, null);
  };

  /** The observer reports a block only when it crosses the reach: a block
   *  that stayed for a selection no longer over it is observed anew, which
   *  reports it again. */
  const releaseSelected = (selection: Selection | null) => {
    for (const element of selected) {
      if (element.isConnected && selection?.containsNode(element, true)) continue;
      selected.delete(element);
      if (!observer || !observed.has(element)) continue;
      observer.unobserve(element);
      observer.observe(element);
    }
  };

  const onSelection = () => {
    const selection = selectionOver();
    giveBack(selection, false);
    releaseSelected(selection);
  };

  const onEntries = (entries: IntersectionObserverEntry[]) => {
    if (!container || !scroller || !observer) return;
    const view = scroller.getBoundingClientRect();
    // A scroller without a box (a hidden surface) says nothing about distance:
    // nothing parks, and only the observer's word can return a box.
    const measured = measuredView(view);
    const near = (rect: DOMRect) => nearView(rect, view);
    const selection = selectionOver();
    const basis = basisOf(container);
    const returning: string[] = [];
    const parking: Array<[string, ParkedBlock, HTMLElement]> = [];
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
        noteAbove(parkedId, rect, view, basis);
        returning.push(parkedId);
        continue;
      }
      const id = element.getAttribute(UNIT_ATTRIBUTE);
      if (!id || !measured || entry.isIntersecting || near(rect)) continue;
      if (stays(id, element)) {
        stayed.set(id, element);
        continue;
      }
      if (selection?.containsNode(element, true)) {
        selected.add(element);
        continue;
      }
      if (element.contains(document.activeElement) || element.querySelector(HELD_CONTENT)) continue;
      const box = measureBlock(element, rect, basis);
      if (box) parking.push([id, box, element]);
    }
    for (const id of returning) set(id, null);
    for (const [id, box, element] of parking) {
      beforePark?.(element);
      set(id, box);
    }
  };

  const stop = () => {
    observer?.disconnect();
    observer = null;
    changes?.disconnect();
    changes = null;
    delivered = [];
    observed.clear();
    stayed.clear();
    selected.clear();
    selectedIds.clear();
    document.removeEventListener('selectionchange', onSelection);
  };

  /** A new observer on the holder's blocks: it reports every one of them. */
  const watch = () => {
    stop();
    if (!scroller) {
      for (const id of [...boxes.keys()]) set(id, null);
      return;
    }
    observer = new IntersectionObserver(onEntries, {
      root: scroller,
      rootMargin: `${REACH_VIEWPORTS * 100}% 0px`,
    });
    document.addEventListener('selectionchange', onSelection);
    if (container) {
      changes = new MutationObserver((records) => {
        delivered.push(...records);
        parking.sync();
      });
      changes.observe(container, {
        childList: true,
        subtree: true,
        attributeFilter: [UNIT_ATTRIBUTE, PARKED_ATTRIBUTE, 'hidden'],
      });
    }
    syncAll = true;
    parking.sync();
  };

  /** The holder's blocks a sync looks at: all of them, or those its changes
   *  since the last one touched and their neighbours. */
  const syncTargets = (holder: HTMLElement): Element[] => {
    const records = [...delivered, ...(changes?.takeRecords() ?? [])];
    delivered = [];
    if (syncAll) {
      syncAll = false;
      return [...holder.children];
    }
    const touched = new Set<Element>();
    const touch = (node: Node | null) => {
      if (node instanceof Element && node.parentElement === holder) touched.add(node);
    };
    for (const record of records) {
      if (record.type === 'childList' && record.target === holder) {
        for (const node of record.removedNodes) {
          if (!(node instanceof Element)) continue;
          observer?.unobserve(node);
          observed.delete(node);
        }
        for (const node of record.addedNodes) touch(node);
        touch(record.previousSibling);
        touch(record.nextSibling);
      } else if (record.type === 'attributes') touch(record.target);
    }
    // A block's neighbours are what its parked box was measured against.
    const targets = new Set<Element>();
    for (const element of touched) {
      targets.add(element);
      const previous = shownSibling(element, 'previousElementSibling');
      const next = shownSibling(element, 'nextElementSibling');
      if (previous) targets.add(previous);
      if (next) targets.add(next);
    }
    return [...targets];
  };

  const parking = {
    subscribe(id: string, listener: () => void) {
      listeners.set(id, listener);
      return () => {
        if (listeners.get(id) !== listener) return;
        listeners.delete(id);
        if (!away) forget(id);
      };
    },
    parked: (id: string) => boxes.get(id) ?? null,
    /** The element holding the blocks, and the scroller they park against
     *  (none: they do not park). */
    place(element: HTMLElement | null, nextScroller: HTMLElement | null, grows: boolean) {
      const settled = growing && !grows;
      growing = grows;
      away = false;
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
      container = element;
      scroller = nextScroller;
      watch();
      // A holder back in the DOM with what was parked of it shows in its
      // first frame what is near the reader or selected; the observer's
      // report comes a frame later.
      if (boxes.size > 0) giveBack(selectionOver(), true);
    },
    /** The holder left the DOM. What is parked of it stays, for its return
     *  (place). */
    leave() {
      stop();
      container = null;
      scroller = null;
      away = true;
    },
    /** Every block of the holder that can park does, wherever the reader is:
     *  the block around the holder is leaving the DOM, out of the reader's
     *  reach, before the observer reported them all. */
    parkAll() {
      if (!container || !observer) return;
      const basis = basisOf(container);
      const parking: Array<[string, ParkedBlock]> = [];
      for (const element of container.children) {
        const id = element.getAttribute(UNIT_ATTRIBUTE);
        if (id === null) continue;
        const box = measureBlock(element as HTMLElement, element.getBoundingClientRect(), basis);
        if (box) parking.push([id, box]);
      }
      for (const [id, box] of parking) set(id, box);
    },
    sync() {
      if (!observer || syncQueued) return;
      syncQueued = true;
      queueMicrotask(() => {
        syncQueued = false;
        if (!observer || !container) return;
        // Blocks that return for the reader or a selection are looked for
        // among all of them; a growing reply's sync has none.
        const changed = syncTargets(container);
        const targets = returnedAbove.size > 0 || selectedIds.size > 0 ? [...container.children] : changed;
        const displaced: string[] = [];
        let grown = 0;
        const neighbour = (element: Element, side: 'previousElementSibling' | 'nextElementSibling') => {
          const node = shownSibling(element, side);
          return node ? blockId(node) : undefined;
        };
        for (const element of targets) {
          if (unshown(element) || element.parentElement !== container) continue;
          const id = blockId(element);
          if (id === null) continue;
          const box = boxes.get(id);
          if (
            box &&
            (box.beside[0] !== neighbour(element, 'previousElementSibling') ||
              box.beside[1] !== neighbour(element, 'nextElementSibling'))
          ) {
            displaced.push(id);
          }
          const before = returnedAbove.get(element.getAttribute(UNIT_ATTRIBUTE) ?? '');
          if (before !== undefined) grown += element.getBoundingClientRect().height - before;
          if (selectedIds.delete(element.getAttribute(UNIT_ATTRIBUTE) ?? '')) selected.add(element);
          if (observed.has(element)) continue;
          observed.add(element);
          observer.observe(element);
        }
        markdownWorkCounts.parkingEntries += targets.length;
        returnedAbove.clear();
        noteGrownAbove(container.closest('.transcript-virtual-row'), grown);
        for (const id of displaced) set(id, null);
        // The observer reports a block only when it crosses the reach: one
        // that stayed and no longer has to is observed anew, which reports it
        // again.
        for (const [id, element] of stayed) {
          if (element.isConnected && stays(id, element)) continue;
          stayed.delete(id);
          if (!observed.has(element)) continue;
          observer.unobserve(element);
          observer.observe(element);
        }
        // A block that returned for a selection since gone.
        if (selected.size > 0) releaseSelected(selectionOver());
      });
    },
    release(id: string) {
      const near = besideOf.get(id);
      markdownWorkCounts.parkingEntries += 1 + (near?.size ?? 0);
      set(id, null);
      if (near) for (const other of [...near]) set(other, null);
    },
    hold(id: string, held: boolean) {
      if (held) heldIds.add(id);
      else if (heldIds.delete(id) && stayed.has(id)) parking.sync();
    },
  };
  return parking;
}

export function createBlockParking(): BlockParking {
  type Parking = ReturnType<typeof createParking>;
  /** The inner parkings attached, each with the element holding its blocks. */
  const inner = new Map<Parking, HTMLElement>();
  /** Those whose holder left the DOM, by its place. */
  const away = new Map<string, Parking>();
  /** Those places by the block they are in. */
  const awayIn = new Map<string, Set<string>>();
  // A block that leaves the DOM takes the holders in it along: all of theirs
  // is parked first, so that back in the DOM none of them is whole.
  const blocks = createParking((element) => {
    for (const [part, holder] of inner) if (element.contains(holder)) part.parkAll();
  });
  let scroller: HTMLElement | null = null;
  let growing = false;
  return {
    subscribe: blocks.subscribe,
    parked: blocks.parked,
    sync: blocks.sync,
    release(id) {
      blocks.release(id);
      for (const place of awayIn.get(id) ?? []) away.delete(place);
      awayIn.delete(id);
    },
    hold: blocks.hold,
    attach(element, enabled, grows = false) {
      // IntersectionObserver is missing only in test DOMs.
      const parks = enabled && typeof IntersectionObserver !== 'undefined';
      const row = parks && element ? element.closest('.transcript-virtual-row') : null;
      scroller = row && element ? scrollerOf(element) : null;
      growing = grows;
      blocks.place(element, scroller, growing);
      for (const [part, holder] of inner) part.place(holder, scroller, growing);
    },
    inner(place) {
      const part = (place !== null && away.get(place)) || createParking(undefined, true);
      /** Where the holder is away from. */
      let left = place;
      const back = () => {
        if (left !== null && away.get(left) === part) {
          away.delete(left);
          awayIn.get(blockOf(left))?.delete(left);
        }
        left = null;
      };
      return {
        subscribe: part.subscribe,
        parked: part.parked,
        sync: part.sync,
        attach(element) {
          back();
          if (element) inner.set(part, element);
          else inner.delete(part);
          part.place(element, element ? scroller : null, growing);
        },
        leave(from) {
          back();
          inner.delete(part);
          part.leave();
          left = from;
          if (from === null) return;
          away.set(from, part);
          const places = awayIn.get(blockOf(from)) ?? new Set<string>();
          places.add(from);
          awayIn.set(blockOf(from), places);
        },
      };
    },
  };
}
