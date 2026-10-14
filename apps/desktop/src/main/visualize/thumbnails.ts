/**
 * Each tab's chat-card picture: at most one in-flight job per tab, stopped
 * as soon as the tab's view changes.
 */
import { visualizeThumbnail } from '../../shared/visualize';
import { ACTIVATE_SETTLE_MS, type VisualizeServiceContext } from './context';
import { type TabState, view } from './tab-state';

export function createThumbnails(
  ctx: Pick<VisualizeServiceContext, 'deps' | 'sessions' | 'delay' | 'pendingReloads' | 'publish'>
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
    if (!take || tab.url) return;
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
      const thumbnail = png?.length ? visualizeThumbnail(`data:image/png;base64,${png.toString('base64')}`) : '';
      if (!thumbnail || !current() || thumbnail === tab.thumbnail) return;
      tab.thumbnail = thumbnail;
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

  return {
    cancel,
    refresh,
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
