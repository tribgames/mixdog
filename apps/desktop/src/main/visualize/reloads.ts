import type { VisualizeInlineContent, VisualizePaneView } from '../../shared/visualize';
import type { VisualizeServiceContext } from './context';
import { type FileTarget, installLivePanes, markFileTabMissing, rekeyFileTab, type TabState } from './tab-state';
import { step, type TabWork, whileOpen } from './tabs';
import { isFileMissing, liveFilesFingerprint, OutsideRecordedRootError, resolveTargetWithin } from './targets';
import { followShown, heldTurn, publishShown, shownAs } from './turn-hold';

export type LeaseRefreshResult =
  | { outcome: 'refreshed'; panes: VisualizePaneView[] }
  | { outcome: 'missing' }
  | { outcome: 'superseded' }
  | { outcome: 'closed' }
  | { outcome: 'failed' };

/** A file reloads once its writes have gone quiet this long. */
const RELOAD_DEBOUNCE_MS = 1200;
/** A tab whose files are gone looks for them again this often: the watch may
 *  have died with the folder, so it cannot be relied on to report their return. */
const MISSING_RETRY_MS = 2000;

/** A load started at `stamp` may commit to `tab` only when no load started
 *  later already did: `loadedStamp` only ever grows. */
export const loadIsCurrent = (tab: TabState, stamp: number): boolean => stamp > (tab.loadedStamp ?? 0);

/** What a restore of the version on screen would overwrite may have changed
 *  with the files: re-read it and publish when it did. */
function* refreshRestoreAssets(
  ctx: Pick<VisualizeServiceContext, 'tabVersions' | 'publish'>,
  sessionId: string,
  tab: TabState,
  shown: NonNullable<TabState['shown']>
): TabWork {
  const restoreAssets = yield* step(ctx.tabVersions.restoreAssetsOf(sessionId, tab, shown.n));
  if (tab.shown === shown && restoreAssets.join('\0') !== shown.restoreAssets.join('\0')) {
    shown.restoreAssets = restoreAssets;
    ctx.publish(sessionId);
  }
}

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
    | 'views'
  >
) {
  const { deps, sessions, pendingReloads } = ctx;
  const reloadSettlers = new WeakMap<TabState, () => void>();

  const publishLeaseUpdate = (sessionId: string, tab: TabState): void => {
    const hold = ctx.holds.get(sessionId);
    if (hold && shownAs(ctx, hold, sessionId, tab.id) === 'live') {
      followShown(ctx, hold, sessionId, tab.id);
      if (!hold.flushing) {
        publishShown(ctx.deps, hold, sessionId);
        return;
      }
    }
    ctx.publish(sessionId);
  };

  const cancelScheduledReload = (tab: TabState): void => {
    if (tab.reloadTimer) clearTimeout(tab.reloadTimer);
    tab.reloadTimer = null;
    if (tab.retryTimer) clearTimeout(tab.retryTimer);
    tab.retryTimer = null;
    reloadSettlers.get(tab)?.();
    reloadSettlers.delete(tab);
  };

  const armMissingRetry = (sessionId: string, tab: TabState): void => {
    if (tab.verify || tab.lifetime.signal.aborted) return;
    if (tab.retryTimer) clearTimeout(tab.retryTimer);
    tab.retryTimer = setTimeout(() => {
      tab.retryTimer = null;
      scheduleReload(sessionId, tab);
    }, deps.reloadDebounceMs ?? MISSING_RETRY_MS);
    tab.retryTimer.unref?.();
  };

  /** One reload of `tab`, run while the tab is open (`reload`). */
  function* reloadSteps(sessionId: string, tab: TabState, versionLabel?: string): TabWork {
    // A kept version is on screen: live reloads wait for "Back to live".
    if (tab.shown) {
      tab.pendingReload = true;
      yield* refreshRestoreAssets(ctx, sessionId, tab, tab.shown);
      return;
    }
    // Everything below is resolved against this cwd; a reopen in another cwd,
    // or a reload started later, that commits first makes this result stale.
    const cwd = tab.cwd;
    const stamp = ctx.nextLoadStamp();
    const superseded = () => tab.cwd !== cwd || !loadIsCurrent(tab, stamp);
    try {
      // Re-resolve from the original request every time, inside the root
      // recorded at open: a parent folder swapped for a link must not carry
      // the tab (its page assets, versions or remote reads) anywhere else.
      const targets: FileTarget[] = yield* step(
        Promise.all(tab.targets.map((target) => resolveTargetWithin(cwd, target.target, [target.root])))
      );
      const panes = yield* step(ctx.panes.preparePanes(targets));
      if (superseded()) {
        ctx.tabs.releasePanes(panes);
        return;
      }
      const liveStat = yield* step(liveFilesFingerprint(targets));
      if (superseded()) {
        ctx.tabs.releasePanes(panes);
        return;
      }
      const moved = targets.some((target, index) => target.path !== tab.targets[index]?.path);
      // The files are back: a watch that died with their folder is armed again.
      const rearm = moved || tab.missing === true;
      installLivePanes(tab, panes, {
        loadedStamp: stamp,
        targets,
        ...(liveStat ? { liveStat } : { liveStat: undefined }),
      });
      const state = sessions.get(sessionId);
      if (state) rekeyFileTab(state, tab, targets);
      ctx.leases.claimLeases(sessionId, tab, panes);
      tab.problems = [];
      ctx.thumbnails.invalidate(tab);
      if (rearm) {
        for (const stop of tab.unwatch) stop();
        watchTab(sessionId, tab);
      }
      yield* step(ctx.tabVersions.recordVersion(sessionId, tab, versionLabel));
      // A content update happens in place: no reveal, no activation.
      ctx.publish(sessionId, undefined, tab.id);
      ctx.thumbnails.refresh(sessionId, tab);
    } catch (error) {
      // A newer open or reload already decided what the tab shows.
      if (superseded()) return;
      if (error instanceof OutsideRecordedRootError) {
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
        tab.loadedStamp = stamp;
        if (!tab.missing) {
          markFileTabMissing(sessions.get(sessionId), tab);
          ctx.publish(sessionId);
        }
        armMissingRetry(sessionId, tab);
      }
    }
  }

  /** Work for a tab closed meanwhile, or whose session was deleted, stops
   *  where it waits (`whileOpen`). */
  const reload = async (sessionId: string, tab: TabState, versionLabel?: string): Promise<void> => {
    await whileOpen(tab, reloadSteps(sessionId, tab, versionLabel));
  };

  /** Re-issue page-server leases in place without recording a new version entry. */
  function* refreshLeaseSteps(sessionId: string, tab: TabState, version?: number): TabWork<LeaseRefreshResult> {
    const prepareInlineOrRevoke = async (content: VisualizeInlineContent): Promise<VisualizePaneView> => {
      const pane = await ctx.panes.inlinePaneFor(content);
      if (tab.lifetime.signal.aborted) ctx.tabs.releasePanes([pane]);
      return pane;
    };

    if (version !== undefined) {
      const shown = tab.shown;
      if (!shown || shown.n !== version) return { outcome: 'superseded' };
      if (tab.inline) {
        const entry = tab.inlineHistory?.find((candidate) => candidate.n === shown.n);
        if (!entry) return { outcome: 'failed' };
        const pane = yield* step(prepareInlineOrRevoke(entry.content));
        if (tab.shown !== shown) {
          ctx.tabs.releasePanes([pane]);
          return { outcome: 'superseded' };
        }
        ctx.tabs.releasePanes(shown.panes);
        shown.panes = [pane];
        ctx.leases.claimLeases(sessionId, tab, shown.panes);
        tab.problems = tab.problems.filter((problem) => problem.version !== shown.n);
        tab.problemSeq += 1;
        publishLeaseUpdate(sessionId, tab);
        return { outcome: 'refreshed', panes: shown.panes };
      }
      try {
        const panes = yield* step(ctx.panes.preparePanes(shown.targets));
        if (tab.shown !== shown) return { outcome: 'superseded' };
        shown.panes = panes;
        ctx.leases.claimLeases(sessionId, tab, panes);
        tab.problems = tab.problems.filter((problem) => problem.version !== shown.n);
        tab.problemSeq += 1;
        publishLeaseUpdate(sessionId, tab);
        return { outcome: 'refreshed', panes };
      } catch (error) {
        console.warn('visualize version lease refresh failed:', (error as Error).message);
        return { outcome: 'failed' };
      }
    }

    if (tab.url) return { outcome: 'superseded' };
    if (tab.inline) {
      const inline = tab.inline;
      const pane = yield* step(prepareInlineOrRevoke(inline));
      if (tab.inline !== inline) {
        ctx.tabs.releasePanes([pane]);
        return { outcome: 'superseded' };
      }
      ctx.tabs.releasePanes(tab.panes);
      tab.panes = [pane];
      ctx.leases.claimLeases(sessionId, tab, tab.panes);
      tab.problems = tab.problems.filter((problem) => problem.version !== undefined);
      tab.problemSeq += 1;
      publishLeaseUpdate(sessionId, tab);
      return { outcome: 'refreshed', panes: tab.panes };
    }

    const cwd = tab.cwd;
    const stamp = ctx.nextLoadStamp();
    const superseded = () => tab.cwd !== cwd || !loadIsCurrent(tab, stamp);
    try {
      const targets: FileTarget[] = yield* step(
        Promise.all(tab.targets.map((target) => resolveTargetWithin(cwd, target.target, [target.root])))
      );
      const panes = yield* step(ctx.panes.preparePanes(targets));
      if (superseded()) {
        ctx.tabs.releasePanes(panes);
        return { outcome: 'superseded' };
      }
      const liveStat = yield* step(liveFilesFingerprint(targets));
      if (superseded()) {
        ctx.tabs.releasePanes(panes);
        return { outcome: 'superseded' };
      }
      const moved = targets.some((target, index) => target.path !== tab.targets[index]?.path);
      const rearm = moved || tab.missing === true;
      installLivePanes(tab, panes, {
        loadedStamp: stamp,
        targets,
        ...(liveStat ? { liveStat } : { liveStat: undefined }),
      });
      const state = sessions.get(sessionId);
      if (state) rekeyFileTab(state, tab, targets);
      ctx.leases.claimLeases(sessionId, tab, panes);
      tab.problems = tab.problems.filter((problem) => problem.version !== undefined);
      tab.problemSeq += 1;
      if (rearm) {
        for (const stop of tab.unwatch) stop();
        watchTab(sessionId, tab);
      }
      publishLeaseUpdate(sessionId, tab);
      return { outcome: 'refreshed', panes };
    } catch (error) {
      if (superseded()) return { outcome: 'superseded' };
      if (error instanceof OutsideRecordedRootError) {
        console.warn('visualize tab closed:', error.message);
        ctx.tabs.closeTab(sessionId, tab.id);
        return { outcome: 'closed' };
      }
      if (isFileMissing(error)) {
        tab.loadedStamp = stamp;
        if (!tab.missing) {
          console.warn('visualize reload failed:', (error as Error).message);
          markFileTabMissing(sessions.get(sessionId), tab);
          tab.problems = tab.problems.filter((problem) => problem.version !== undefined);
          tab.problemSeq += 1;
          publishLeaseUpdate(sessionId, tab);
        }
        armMissingRetry(sessionId, tab);
        return { outcome: 'missing' };
      }
      console.warn('visualize lease refresh failed:', (error as Error).message);
      return { outcome: 'failed' };
    }
  }

  const refreshLease = (sessionId: string, tab: TabState, version?: number): Promise<LeaseRefreshResult> => {
    const run = whileOpen(tab, refreshLeaseSteps(sessionId, tab, version)).then(
      (result) => result ?? { outcome: 'closed' as const }
    );
    const tracked = run.then(
      () => undefined,
      () => undefined
    );
    pendingReloads.add(tracked);
    void tracked.finally(() => pendingReloads.delete(tracked));
    return run;
  };

  const scheduleReload = (sessionId: string, tab: TabState): void => {
    cancelScheduledReload(tab);
    // A verify-only tab is read off screen from the files as they are; it
    // keeps no live state to refresh (open it again to keep a version).
    // A closed one arms nothing: a change event or retry that outlived it ends here.
    if (tab.verify || tab.lifetime.signal.aborted) return;
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
    refreshLease,
    watchTab,
    armMissingRetry,
    cancelScheduledReload,
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
