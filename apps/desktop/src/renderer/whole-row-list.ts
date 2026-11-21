import { type RefObject, useLayoutEffect } from 'react';

/** Where a capped list ends so that its last visible row is whole: under the
 *  lowest row that fits within `cap` together with the list's end padding.
 *  Rows are top/bottom offsets in the list's padding box, in order. Null when
 *  the whole list fits; the cap itself when not even the first row does. */
export function wholeRowCut(
  rows: ReadonlyArray<{ top: number; bottom: number }>,
  cap: number,
  scrollHeight: number,
  paddingEnd: number
): number | null {
  if (scrollHeight <= cap) return null;
  let cut = 0;
  for (const row of rows) {
    if (row.bottom + paddingEnd > cap) break;
    cut = row.bottom + paddingEnd;
  }
  return cut > 0 ? cut : cap;
}

/** Ends a scrolling list whose stylesheet caps its height at whole rows
 *  (wholeRowCut, re-measured as it, its rows or the viewport resize), and marks it
 *  `data-more` while rows sit below the fold. The list must be its rows'
 *  offset parent. */
export function useWholeRowList(list: RefObject<HTMLElement | null>): void {
  useLayoutEffect(() => {
    const node = list.current;
    if (!node) return undefined;
    const mark = () => {
      node.toggleAttribute('data-more', node.scrollTop + node.clientHeight < node.scrollHeight - 1);
    };
    const measure = () => {
      // The stylesheet's cap is the room; the inline cut is redone from it.
      node.style.maxHeight = '';
      const rows = Array.from(node.children as HTMLCollectionOf<HTMLElement>, (row) => ({
        top: row.offsetTop,
        bottom: row.offsetTop + row.offsetHeight,
      }));
      const paddingEnd = Number.parseFloat(getComputedStyle(node).paddingBottom) || 0;
      const cut = wholeRowCut(rows, node.clientHeight, node.scrollHeight, paddingEnd);
      if (cut !== null) node.style.maxHeight = `${cut}px`;
      mark();
    };
    measure();
    // A frame later, not inside the observer's own callback: the cut resizes
    // the list it observes.
    let frame = 0;
    const schedule = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(measure);
    };
    const resize = new ResizeObserver(schedule);
    const observeRows = () => {
      resize.disconnect();
      resize.observe(node);
      for (const row of Array.from(node.children)) resize.observe(row);
    };
    observeRows();
    const rows = new MutationObserver(() => {
      observeRows();
      schedule();
    });
    rows.observe(node, { childList: true });
    node.addEventListener('scroll', mark, { passive: true });
    // The stylesheet's cap follows the viewport height (dvh), which the inline
    // cut hides from the list's own observer: a shorter window or an opening
    // keyboard re-cuts from the cap.
    const visual = window.visualViewport;
    window.addEventListener('resize', schedule);
    visual?.addEventListener('resize', schedule);
    return () => {
      cancelAnimationFrame(frame);
      resize.disconnect();
      rows.disconnect();
      node.removeEventListener('scroll', mark);
      window.removeEventListener('resize', schedule);
      visual?.removeEventListener('resize', schedule);
      node.style.maxHeight = '';
      node.removeAttribute('data-more');
    };
  }, [list]);
}
