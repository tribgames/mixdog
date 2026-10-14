/**
 * Restoring a file tab's kept version over the project files (and the page
 * assets kept with them), contained in the tab's working directory.
 */
import { realpath } from 'node:fs/promises';

import type { VisualizeServiceContext } from './context';
import type { FileTarget, TabState } from './tab-state';
import { resolveVisualizeTarget } from './targets';
import { showLive } from './version-select';
import { restoreDestination, versionChanges, writeFileInside } from './versions';

export function createVersionRestore(
  ctx: Pick<VisualizeServiceContext, 'versions' | 'thumbnails' | 'publish' | 'reloads'>
) {
  return {
    /** Write kept version `n` back over the tab's project files and the page
     *  assets kept with them, where they differ; the restored content becomes
     *  the newest version. A changed asset the user did not confirm (`confirmed`,
     *  cwd-relative) refuses the whole restore. */
    async restoreVersion(sessionId: string, tab: TabState, n: number, confirmed: string[]): Promise<void> {
      if (tab.inline) throw new Error(`tab ${tab.id} shows inline content, which has no project file to restore`);
      const version = ctx.versions?.get(sessionId, tab.id, n);
      if (!version) throw new Error(`tab ${tab.id} has no version ${n}`);
      // Re-resolve every pane target: the restored bytes must land inside cwd.
      const targets = (await Promise.all(
        tab.targets.map((target) => resolveVisualizeTarget(tab.cwd, target.target))
      )) as FileTarget[];
      const root = await realpath(tab.cwd);
      const changes = await versionChanges(
        version,
        root,
        targets.map((target) => target.path)
      );
      const unconfirmed = changes.filter((change) => change.asset && !confirmed.includes(change.rel));
      if (unconfirmed.length) {
        // Refresh the list the confirm shows, then let the user review it.
        if (tab.shown?.n === n) {
          tab.shown.restoreAssets = changes.filter((change) => change.asset).map((change) => change.rel);
          ctx.publish(sessionId);
        }
        throw new Error(
          `v${n} was not restored: it would also overwrite ${unconfirmed.map((change) => change.rel).join(', ')}, which the confirmation did not list; review and restore again`
        );
      }
      // Every destination is checked before anything is written, and each one
      // again right before its own write.
      for (const change of changes) {
        await restoreDestination(root, change.path).catch((error: Error) => {
          throw new Error(`v${n} was not restored: ${error.message}`);
        });
      }
      const restored: string[] = [];
      for (const change of changes) {
        try {
          await writeFileInside(root, change.path, change.data);
        } catch (error) {
          const partial = restored.length ? `; already restored: ${restored.join(', ')}` : '';
          throw new Error(`restoring v${n} stopped at ${change.rel}: ${(error as Error).message}${partial}`);
        }
        restored.push(change.rel);
      }
      showLive(tab, (shown) => ctx.thumbnails.invalidate(shown));
      tab.pendingReload = false;
      await ctx.reloads.reload(sessionId, tab, `Restored from v${n}`);
    },
  };
}

export type VersionRestore = ReturnType<typeof createVersionRestore>;
