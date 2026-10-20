/**
 * Each tab's chat-card picture: at most one in-flight job per tab, stopped
 * as soon as the tab's view changes. While an agent turn runs none is taken:
 * its end takes one per tab it opened, off screen, on the final version
 * (`takeAtTurnEnd`), and each picture is kept per version.
 */
import { visualizeThumbnail } from '../../shared/visualize';
import { ACTIVATE_SETTLE_MS, type VisualizeServiceContext } from './context';
import { shownLayout, type TabState, view } from './tab-state';
import { keepVersionThumbnail, shownVersionOf } from './version-thumbnails';

/** How long a turn's end waits for its cards' pictures; a card whose picture
 *  is not ready by then shows its kind placeholder. */
export const TURN_END_THUMBNAIL_MS = 1500;

const pngThumbnail = (png: Buffer | null | undefined): string =>
  png?.length ? visualizeThumbnail(`data:image/png;base64,${png.toString('base64')}`) : '';

export function createThumbnails(
  ctx: Pick<
    VisualizeServiceContext,
    'deps' | 'sessions' | 'delay' | 'pendingReloads' | 'publish' | 'holds' | 'versions'
  >
) {
  /** The in-flight chat-card picture of each tab: at most one per tab. */
  const thumbnailJobs = new WeakMap<TabState, { revision: number; controller: AbortController }>();
  const cancel = (tab: TabState): void => {
    thumbnailJobs.get(tab)?.controller.abort();
    thumbnailJobs.delete(tab);
  };

  /** Take the tab's chat-card picture once the shown page had time to
   *  settle. One job per tab: a new job, a newer revision or a closed tab
   *  aborts the old one (the taker sees its signal between capture rounds).
   *  Tracked by `settled()`. */
  const refresh = (sessionId: string, tab: TabState): void => {
    const take = ctx.deps.thumbnail;
    // A running turn (or its end, which takes its own) is never captured.
    if (!take || tab.url || ctx.holds.has(sessionId)) return;
    cancel(tab);
    const revision = tab.revision;
    const job = { revision, controller: new AbortController() };
    thumbnailJobs.set(tab, job);
    const { signal } = job.controller;
    const current = () =>
      !signal.aborted && ctx.sessions.get(sessionId)?.tabs.includes(tab) === true && tab.revision === revision;
    const run = (async () => {
      await ctx.delay(ACTIVATE_SETTLE_MS);
      if (!current()) return;
      const png = await take(sessionId, view(tab), tab.shown ? tab.shown.targets : tab.targets, signal);
      const thumbnail = pngThumbnail(png);
      const n = shownVersionOf(tab);
      if (!thumbnail || !current() || (thumbnail === tab.thumbnail && tab.thumbnailVersion === n)) return;
      keepVersionThumbnail(ctx, sessionId, tab, n, thumbnail);
      ctx.publish(sessionId);
    })()
      .catch((error: unknown) => {
        console.warn('visualize thumbnail failed:', (error as Error).message);
      })
      .finally(() => {
        if (thumbnailJobs.get(tab) === job) thumbnailJobs.delete(tab);
      });
    ctx.pendingReloads.add(run);
    void run.then(() => ctx.pendingReloads.delete(run));
  };

  /** A turn ended: each tab it opened gets its card picture of the version
   *  it ends on, drawn off screen (the panel still shows what it showed
   *  before the turn), all within TURN_END_THUMBNAIL_MS. A tab whose picture
   *  of that version exists keeps it; one that cannot be drawn (audio,
   *  video, a visible password field, a failure, too slow) has none, and its
   *  card shows the kind placeholder. Publishes nothing. */
  const takeAtTurnEnd = async (sessionId: string, tabs: readonly TabState[]): Promise<void> => {
    const take = ctx.deps.thumbnailOffscreen;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TURN_END_THUMBNAIL_MS);
    const timedOut = new Promise<null>((resolve) =>
      controller.signal.addEventListener('abort', () => resolve(null), { once: true })
    );
    try {
      await Promise.all(
        tabs.map(async (tab) => {
          if (tab.url) return;
          const n = shownVersionOf(tab);
          // (Without kept versions the number does not tell what changed.)
          if (n && !tab.historyFull && tab.thumbnail && tab.thumbnailVersion === n) return;
          cancel(tab);
          const files = shownLayout(tab, tab.shown?.targets ?? [], tab.targets).map((file) => file.path);
          const taken = take?.(sessionId, view(tab), files, controller.signal).catch((error: unknown) => {
            if (!controller.signal.aborted) console.warn('visualize card picture failed:', (error as Error).message);
            return null;
          });
          const png = taken ? await Promise.race([taken, timedOut]) : null;
          if (controller.signal.aborted && !png && taken) {
            console.warn(`visualize card picture of tab ${tab.id} was not ready within ${TURN_END_THUMBNAIL_MS} ms`);
          }
          const thumbnail = pngThumbnail(png);
          if (thumbnail) keepVersionThumbnail(ctx, sessionId, tab, n, thumbnail);
          else {
            // Never the picture of an earlier version on this one's card.
            tab.thumbnail = undefined;
            tab.thumbnailVersion = undefined;
          }
        })
      );
    } finally {
      clearTimeout(timer);
      controller.abort();
    }
  };

  return {
    cancel,
    refresh,
    takeAtTurnEnd,
    /** The tab's view changes: a newer revision, and its old picture stops now,
     *  not at the next publish (snapshot I/O may come first). */
    invalidate(tab: TabState): void {
      tab.revision += 1;
      cancel(tab);
    },
    /** A tab that was not on screen when its picture was due (another tab
     *  opened right after it) gets it once it is shown; never a second job
     *  while one for its revision is still running. */
    whenMissing(sessionId: string, tab: TabState): void {
      if (tab.thumbnail || thumbnailJobs.get(tab)?.revision === tab.revision) return;
      refresh(sessionId, tab);
    },
    /** Stop the picture of every tab of the session whose revision moved on. */
    cancelStale(sessionId: string): void {
      for (const tab of ctx.sessions.get(sessionId)?.tabs ?? []) {
        const job = thumbnailJobs.get(tab);
        if (job && job.revision !== tab.revision) cancel(tab);
      }
    },
  };
}

export type Thumbnails = ReturnType<typeof createThumbnails>;
