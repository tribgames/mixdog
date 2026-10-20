/**
 * The chat card's picture of each kept version: a card of an earlier version
 * keeps the picture its own turn ended on. File tabs keep it in the version
 * store (memory and the versions folder), inline tabs on their in-memory
 * history entry.
 */
import type { VisualizeServiceContext } from './context';
import type { TabState } from './tab-state';

/** The version the tab draws now: a kept one it shows, else its newest (0
 *  without versions). */
export function shownVersionOf(tab: TabState): number {
  return tab.shown?.n ?? tab.versions?.at(-1)?.n ?? 0;
}

/** Record `thumbnail` as the tab's card picture of version `n`. */
export function keepVersionThumbnail(
  ctx: Pick<VisualizeServiceContext, 'versions'>,
  sessionId: string,
  tab: TabState,
  n: number,
  thumbnail: string
): void {
  tab.thumbnail = thumbnail;
  tab.thumbnailVersion = n;
  if (!n) return;
  const entry = tab.inlineHistory?.find((candidate) => candidate.n === n);
  if (entry) entry.thumbnail = thumbnail;
  else if (!tab.inline) ctx.versions?.keepThumbnail(sessionId, tab.id, n, thumbnail);
}

/** The kept card picture of the tab's version `n`; '' when none was taken. */
export function versionThumbnail(
  ctx: Pick<VisualizeServiceContext, 'versions'>,
  sessionId: string,
  tab: TabState,
  n: number
): string {
  if (tab.thumbnail && tab.thumbnailVersion === n) return tab.thumbnail;
  if (!n) return '';
  if (tab.inline) return tab.inlineHistory?.find((candidate) => candidate.n === n)?.thumbnail ?? '';
  return ctx.versions?.get(sessionId, tab.id, n)?.thumbnail ?? '';
}
