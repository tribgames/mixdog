/**
 * Restoring a file tab's kept version over its files (and the page assets
 * kept with them), each contained in the root the version recorded for it
 * (the cwd, or an outside page's own folder) when it was kept.
 */
import type { VisualizeServiceContext } from './context';
import type { TabState } from './tab-state';
import { resolveTargetWithin } from './targets';
import { showLive } from './version-select';
import { keptPaneRoots, restoreDestination, versionChanges, writeFileInside } from './versions';

export function createVersionRestore(
  ctx: Pick<VisualizeServiceContext, 'versions' | 'thumbnails' | 'publish' | 'reloads'>
) {
  return {
    /** Write kept version `n` back over the tab's project files and the page
     *  assets kept with them, where they differ; the restored content becomes
     *  the newest version. A changed asset the user did not confirm (`confirmed`:
     *  `keptAssetNames` names, as `restoreAssets` lists them) refuses the whole
     *  restore. */
    async restoreVersion(sessionId: string, tab: TabState, n: number, confirmed: string[]): Promise<void> {
      if (tab.inline) throw new Error(`tab ${tab.id} shows inline content, which has no project file to restore`);
      const version = ctx.versions?.get(sessionId, tab.id, n);
      if (!version) throw new Error(`tab ${tab.id} has no version ${n}`);
      // Re-resolve every pane target inside the root the version recorded for
      // it when it was kept: a restore never authorizes a folder found now.
      const roots = keptPaneRoots(version);
      const targets = await Promise.all(
        tab.targets.map((target, pane) =>
          resolveTargetWithin(tab.cwd, target.target, [roots[pane]]).catch((error: Error) => {
            throw new Error(`v${n} was not restored: ${error.message}`);
          })
        )
      );
      const changes = await versionChanges(
        version,
        targets.map((target) => target.path)
      );
      // Each asset is authorized by its root-qualified name: a confirmed file
      // of one root never stands in for a same-named file of another.
      const unconfirmed = changes.filter((change) => change.asset && !confirmed.includes(change.name));
      if (unconfirmed.length) {
        // Refresh the list the confirm shows, then let the user review it.
        if (tab.shown?.n === n) {
          tab.shown.restoreAssets = changes.filter((change) => change.asset).map((change) => change.name);
          ctx.publish(sessionId);
        }
        throw new Error(
          `v${n} was not restored: it would also overwrite ${unconfirmed.map((change) => change.name).join(', ')}, which the confirmation did not list; review and restore again`
        );
      }
      // Every destination is checked before anything is written, and each one
      // again right before its own write.
      for (const change of changes) {
        await restoreDestination(change.root, change.path).catch((error: Error) => {
          throw new Error(`v${n} was not restored: ${error.message}`);
        });
      }
      const restored: string[] = [];
      for (const change of changes) {
        try {
          await writeFileInside(change.root, change.path, change.data);
        } catch (error) {
          const partial = restored.length ? `; already restored: ${restored.join(', ')}` : '';
          throw new Error(`restoring v${n} stopped at ${change.name}: ${(error as Error).message}${partial}`);
        }
        restored.push(change.name);
      }
      showLive(tab, (shown) => ctx.thumbnails.invalidate(shown));
      tab.pendingReload = false;
      await ctx.reloads.reload(sessionId, tab, `Restored from v${n}`);
    },
  };
}

export type VersionRestore = ReturnType<typeof createVersionRestore>;
