/**
 * File tabs follow their files: each pane file is watched, a change reloads
 * the tab once writes go quiet (re-resolved inside cwd, snapshotted, published
 * as an in-place update), and an older load never overwrites a newer one.
 */
import type { VisualizeServiceContext } from './context';
import { type FileTarget, realCwdOf, type TabState } from './tab-state';
import { isFileMissing, OutsideWorkingDirectoryError, resolveVisualizeTarget } from './targets';
import { heldTurn } from './turn-hold';

/** A file reloads once its writes have gone quiet this long. */
const RELOAD_DEBOUNCE_MS = 1200;
/** A tab whose files are gone looks for them again this often: the watch may
 *  have died with the folder, so it cannot be relied on to report their return. */
const MISSING_RETRY_MS = 2000;

/** A load started at `stamp` may commit to `tab` only when no load started
 *  later already did: `loadedStamp` only ever grows. */
export const loadIsCurrent = (tab: TabState, stamp: number): boolean => stamp > (tab.loadedStamp ?? 0);

export function createReloads(
  ctx: Pick<
    VisualizeServiceContext,
    | 'deps'
    | 'sessions'
    | 'pendingReloads'
    | 'nextLoadStamp'
    | 'tabVersions'
    | 'publish'
    | 'thumbnails'
    | 'leases'
    | 'panes'
    | 'tabs'
    | 'holds'
  >
) {
  const { deps, sessions, pendingReloads } = ctx;
  const reloadSettlers = new WeakMap<TabState, () => void>();

  const cancelScheduledReload = (tab: TabState): void => {
    if (tab.reloadTimer) clearTimeout(tab.reloadTimer);
    tab.reloadTimer = null;
    if (tab.retryTimer) clearTimeout(tab.retryTimer);
    tab.retryTimer = null;
    reloadSettlers.get(tab)?.();
    reloadSettlers.delete(tab);
  };

  const reload = async (sessionId: string, tab: TabState, versionLabel?: string): Promise<void> => {
    const state = sessions.get(sessionId);
    if (!state?.tabs.includes(tab)) return;
    // A kept version is on screen: live reloads wait for "Back to live".
    if (tab.shown) {
      tab.pendingReload = true;
      // What a restore would overwrite may have changed with the files.
      const shown = tab.shown;
      const restoreAssets = await ctx.tabVersions.restoreAssetsOf(sessionId, tab, shown.n);
      if (tab.shown === shown && restoreAssets.join('\0') !== shown.restoreAssets.join('\0')) {
        shown.restoreAssets = restoreAssets;
        ctx.publish(sessionId);
      }
      return;
    }
    // Everything below is resolved against this cwd; a reopen in another cwd,
    // or a reload started later, that commits first makes this result stale.
    const cwd = tab.cwd;
    const stamp = ctx.nextLoadStamp();
    const superseded = () => tab.cwd !== cwd || !loadIsCurrent(tab, stamp);
    try {
      // Re-resolve from the original request every time: a parent folder
      // swapped for a link must not carry the tab outside cwd.
      const targets = (await Promise.all(
        tab.targets.map((target) => resolveVisualizeTarget(cwd, target.target))
      )) as FileTarget[];
      const realCwd = await realCwdOf(cwd);
      const panes = await ctx.panes.preparePanes(targets, cwd, realCwd);
      if (!state.tabs.includes(tab) || superseded()) return;
      const moved = targets.some((target, index) => target.path !== tab.targets[index]?.path);
      // The files are back: a watch that died with their folder is armed again.
      const rearm = moved || tab.missing === true;
      tab.missing = false;
      tab.loadedStamp = stamp;
      tab.realCwd = realCwd;
      tab.targets = targets;
      tab.panes = panes;
      ctx.leases.claimLeases(tab, panes);
      tab.problems = [];
      ctx.thumbnails.invalidate(tab);
      if (rearm) {
        for (const stop of tab.unwatch) stop();
        watchTab(sessionId, tab);
      }
      await ctx.tabVersions.recordVersion(sessionId, tab, versionLabel);
      // A content update happens in place: no reveal, no activation.
      ctx.publish(sessionId, undefined, tab.id);
      ctx.thumbnails.refresh(sessionId, tab);
    } catch (error) {
      // A newer open or reload already decided what the tab shows.
      if (superseded()) return;
      if (error instanceof OutsideWorkingDirectoryError) {
        // Fail closed: the tab stops showing anything from that path.
        console.warn('visualize tab closed:', error.message);
        ctx.tabs.closeTab(sessionId, tab.id);
        return;
      }
      // A file caught mid-write keeps its last view; the next change event
      // retries. A file that is gone is shown as removed and looked for again
      // until it returns, whether or not its watch still reports.
      // A gone file warns once, not on every look while it stays gone.
      if (!(isFileMissing(error) && tab.missing)) console.warn('visualize reload failed:', (error as Error).message);
      if (isFileMissing(error)) {
        if (!tab.missing) {
          tab.missing = true;
          ctx.publish(sessionId);
        }
        if (tab.retryTimer) clearTimeout(tab.retryTimer);
        tab.retryTimer = setTimeout(() => {
          tab.retryTimer = null;
          if (state.tabs.includes(tab)) scheduleReload(sessionId, tab);
        }, deps.reloadDebounceMs ?? MISSING_RETRY_MS);
        tab.retryTimer.unref?.();
      }
    }
  };

  const scheduleReload = (sessionId: string, tab: TabState): void => {
    cancelScheduledReload(tab);
    // An agent turn is editing: the tab is marked now and reloads once
    // when the turn ends (turn-hold.ts), not after every write.
    const hold = heldTurn(ctx, sessionId);
    if (hold) {
      if (hold.reloads.has(tab)) return;
      hold.reloads.add(tab);
      ctx.publish(sessionId, undefined, tab.id);
      return;
    }
    let settle = () => {};
    const done = new Promise<void>((resolve) => {
      settle = resolve;
    });
    pendingReloads.add(done);
    void done.then(() => pendingReloads.delete(done));
    reloadSettlers.set(tab, settle);
    tab.reloadTimer = setTimeout(() => {
      tab.reloadTimer = null;
      reloadSettlers.delete(tab);
      void reload(sessionId, tab).finally(settle);
    }, deps.reloadDebounceMs ?? RELOAD_DEBOUNCE_MS);
    tab.reloadTimer.unref?.();
  };

  const watchTab = (sessionId: string, tab: TabState): void => {
    tab.unwatch = tab.targets.map((target) => deps.watch(target.path, () => scheduleReload(sessionId, tab)));
  };

  return {
    reload,
    watchTab,
    cancelScheduledReload,
    /** Resolves once every file-change reload scheduled so far (and any it
     *  triggers) has finished: debounce, re-resolve, version snapshot, publish. */
    async settled(): Promise<void> {
      while (pendingReloads.size) {
        // A waiter keeps the (unref'd) debounce timers alive.
        for (const state of sessions.values()) for (const tab of state.tabs) tab.reloadTimer?.ref?.();
        await Promise.all(pendingReloads);
      }
    },
  };
}

export type Reloads = ReturnType<typeof createReloads>;
