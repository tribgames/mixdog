/**
 * The chat card's picture of each kept version: a card of an earlier version
 * keeps the picture its own turn ended on. File tabs keep it in the version
 * store (memory and the versions folder), inline tabs on their in-memory
 * history entry.
 */
import { MAX_VERSION_TURNS, type VisualizeVersionTurn } from '../../shared/visualize';
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

/** Record that `turn` ended on the tab's newest version, kept with the version
 *  (the version store; an inline tab's history entry) and in the tab's list,
 *  which the state carries to the cards of every window and device. */
export function keepVersionTurn(
  ctx: Pick<VisualizeServiceContext, 'versions'>,
  sessionId: string,
  tab: TabState,
  turn: VisualizeVersionTurn
): void {
  const n = tab.versions?.at(-1)?.n ?? 0;
  const listed = tab.versions?.find((candidate) => candidate.n === n);
  if (!n || !listed) return;
  const entry = tab.inlineHistory?.find((candidate) => candidate.n === n);
  if (entry)
    entry.turns = [...(entry.turns ?? []).filter((one) => one.since !== turn.since), turn].slice(-MAX_VERSION_TURNS);
  else if (tab.inline || !ctx.versions?.keepTurn(sessionId, tab.id, n, turn)) return;
  listed.turns = [...(listed.turns ?? []).filter((one) => one.since !== turn.since), turn].slice(-MAX_VERSION_TURNS);
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
