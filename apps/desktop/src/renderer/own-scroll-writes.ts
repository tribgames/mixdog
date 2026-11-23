/** A scroll written into a scroller from outside its own timeline: where it left the scroller, when, and whether a key
 *  the reader pressed made it (`reader`) or the app did on its own. */
export interface ToldScrollWrite {
  at: number;
  top: number;
  reader: boolean;
}

/** The last such write into each scroller, by scroller. */
const writes = new WeakMap<Element, ToldScrollWrite>();

function tellScrollWrites(target: Element, write: () => void, reader: boolean): void {
  const before: [Element, number][] = [];
  for (let element: Element | null = target; element; element = element.parentElement) {
    before.push([element, element.scrollTop]);
  }
  write();
  const at = Date.now();
  for (const [element, top] of before) {
    if (element.scrollTop !== top) writes.set(element, { at, top: Math.round(element.scrollTop), reader });
  }
}

/** Runs `write` (a `scrollTop` write, `scrollIntoView`, a `focus` that scrolls) on or inside `target`, and owns every
 *  scroller from `target` up that it moved: a transcript's follow takes that move as the app's, not its reader's. */
export function ownScrollWrites(target: Element, write: () => void): void {
  tellScrollWrites(target, write, false);
}

/** Focuses `element` (when there is one) with the scroll that brings it into view owned as the app's. */
export function ownedFocus(element: HTMLElement | null | undefined): void {
  if (element) ownScrollWrites(element, () => element.focus());
}

/** Focuses `element` (when there is one) for a key the reader pressed: the scroll that brings it into view is the
 *  reader's, as a scroll key's is, though the key never reaches the transcript (a card's own key handler took it). */
export function readerKeyFocus(element: HTMLElement | null | undefined): void {
  if (element) tellScrollWrites(element, () => element.focus(), true);
}

/** The last write told into `scroller` not yet taken, which it gives up. */
export function takeScrollWrite(scroller: Element): ToldScrollWrite | undefined {
  const write = writes.get(scroller);
  writes.delete(scroller);
  return write;
}
