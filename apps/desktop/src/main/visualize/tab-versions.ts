import type { VisualizeVersionView } from '../../shared/visualize';
import type { VisualizeServiceContext } from './context';
import type { TabState } from './tab-state';
import { step, type TabWork, whileOpen } from './tabs';
import { changedRestoreAssets, VersionHistoryFullError } from './versions';

/** Project a file tab's kept versions into renderer/host views. */
export function versionViewsOf(
  versions: NonNullable<VisualizeServiceContext['versions']>,
  sessionId: string,
  tabId: string
): VisualizeVersionView[] {
  return versions.list(sessionId, tabId).map(({ n, at, label, turns }) => ({
    n,
    at,
    ...(label ? { label } : {}),
    ...(turns?.length ? { turns } : {}),
  }));
}

/** The "no such version" error, listing what the tab keeps. */
export const noVersion = (tab: TabState, n: number, kept: number[]): Error =>
  new Error(
    `tab ${tab.id} has no version ${n}; ${kept.length ? `kept versions: ${kept.join(', ')}` : 'it keeps no versions'}`
  );

export function createTabVersions(ctx: Pick<VisualizeServiceContext, 'versions' | 'sessions'>) {
  const { versions, sessions } = ctx;

  /** Refresh every file tab's version list (eviction spans the session). */
  const syncVersions = (sessionId: string) => {
    if (!versions) return;
    for (const tab of sessions.get(sessionId)?.tabs ?? []) {
      if (tab.url || tab.inline) continue;
      tab.versions = versionViewsOf(versions, sessionId, tab.id);
    }
  };

  function* recordSteps(sessionId: string, tab: TabState, label?: string): TabWork {
    if (!versions || tab.inline) return;
    try {
      const outcome = yield* step(versions.record(sessionId, tab.id, tab.targets, label));
      tab.historyFull = false;
      tab.liveUnkept = outcome.status === 'too-large';
    } catch (error) {
      // The tab keeps working live; its version list stays as it was.
      if (error instanceof VersionHistoryFullError) {
        tab.historyFull = true;
        tab.liveUnkept = true;
      } else {
        console.warn('visualize version snapshot failed:', (error as Error).message);
        tab.liveUnkept = true;
      }
    }
    syncVersions(sessionId);
  }

  /** Keep the tab's current files as a version when they changed, while the
   *  tab is open: a closed tab's dropped history is never started again. */
  const recordVersion = async (sessionId: string, tab: TabState, label?: string): Promise<void> => {
    await whileOpen(tab, recordSteps(sessionId, tab, label));
  };

  /** Kept version `n`'s page assets a restore would overwrite now. */
  const restoreAssetsOf = async (sessionId: string, tab: TabState, n: number): Promise<string[]> => {
    const version = versions?.get(sessionId, tab.id, n);
    if (!version?.assets.length) return [];
    try {
      return await changedRestoreAssets(version);
    } catch {
      // Unlisted: a restore then refuses any changed asset until listed.
      return [];
    }
  };

  const dropVersions = (sessionId: string, tabId: string): void => {
    // Best effort: a version folder left behind only costs disk space.
    void versions?.drop(sessionId, tabId).catch(() => {});
  };

  return { recordVersion, restoreAssetsOf, dropVersions };
}

export type TabVersionRecords = ReturnType<typeof createTabVersions>;
