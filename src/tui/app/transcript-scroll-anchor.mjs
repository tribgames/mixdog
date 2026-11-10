/**
 * transcript-scroll-anchor.mjs — pure scroll math shared by the manual-scroll
 * engine: the reading anchor a bottom-relative scroll target resolves to in
 * the last published geometry, and the bottom-snap band.
 */
import { transcriptRowAt, upperBound } from './transcript-window.mjs';

/**
 * The transcript item + row offset that sits at the top of a viewport scrolled
 * `target` rows up from the tail, per the published geometry (prefixRows are
 * cumulative row starts, one per item plus the total). Null when the geometry
 * has no items or the resolved item carries no id.
 * @returns {{ id: unknown, offset: number } | null}
 */
export function readingAnchorAt(geom, target) {
  const prefixRows = geom?.prefixRows;
  if (!prefixRows || prefixRows.length <= 1) return null;
  const total = Math.max(0, Number(geom.totalRows) || 0);
  const view = Math.max(1, Number(geom.viewRows) || 1);
  const scroll = Math.max(0, Number(target) || 0);
  const row = Math.max(0, Math.min(total, total - scroll - view));
  let index = upperBound(prefixRows, row) - 1;
  index = Math.max(0, Math.min(prefixRows.length - 2, index));
  const item = geom.items?.[index];
  if (item?.id == null) return null;
  return { id: item.id, offset: Math.max(0, row - transcriptRowAt(prefixRows, index)) };
}

/**
 * Bottom snap band. While a stream is appending rows, the reading-anchor
 * effect keeps RAISING the bottom-relative target between wheel events, so a
 * 3-row wheel notch could chase the bottom forever and never reach the exact
 * 0 that re-engages auto-follow. A downward scroll that lands within this
 * band is an unambiguous "go back to the tail" intent. One notch (3 rows) was
 * too tight — fast output adds more rows than that between two wheel events
 * (user: 스크롤이 너무 자주 풀린다) — so the band scales with the viewport
 * (0.20 of it, 3..12 rows), mirroring the desktop hook's REATTACH_THRESHOLD_PX.
 */
export function bottomSnapRows(viewRows) {
  const rows = Math.max(1, Number(viewRows) || 1);
  return Math.max(3, Math.min(12, Math.ceil(rows * 0.2)));
}
