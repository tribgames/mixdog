/**
 * A visualize file tab's kept versions in the version store: snapshotting
 * its files, the page assets a restore would overwrite, and dropping them.
 * Showing a version is `version-select.ts`; restoring one `version-restore.ts`.
 */
import type { VisualizeServiceContext } from './context';
import type { TabState } from './tab-state';
import { VersionHistoryFullError, versionChanges } from './versions';

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
      tab.versions = versions.list(sessionId, tab.id).map(({ n, at, label, turns }) => ({
        n,
        at,
        ...(label ? { label } : {}),
        ...(turns?.length ? { turns } : {}),
      }));
    }
  };

  /** Keep the tab's current files as a version when they changed. */
  const recordVersion = async (sessionId: string, tab: TabState, label?: string): Promise<void> => {
    if (!versions || tab.inline) return;
    try {
      await versions.snapshot(sessionId, tab.id, tab.targets, label);
      tab.historyFull = false;
    } catch (error) {
      // The tab keeps working live; its version list stays as it was.
      if (error instanceof VersionHistoryFullError) tab.historyFull = true;
      else console.warn('visualize version snapshot failed:', (error as Error).message);
    }
    syncVersions(sessionId);
  };

  /** Kept version `n`'s page assets a restore would overwrite now. */
  const restoreAssetsOf = async (sessionId: string, tab: TabState, n: number): Promise<string[]> => {
    const version = versions?.get(sessionId, tab.id, n);
    if (!version?.assets.length) return [];
    try {
      const changes = await versionChanges(
        version,
        tab.targets.map((target) => target.path)
      );
      return changes.filter((change) => change.asset).map((change) => change.name);
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
