import { useCallback, useRef } from 'react';

import { t } from '../i18n';
import type { NavigationSelection } from '../navigation';
import type { usePaneWorkspace } from '../pane-workspace-state';
import { navigationKey } from '../text-format';

type FileSelection = Extract<NavigationSelection, { kind: 'file' }>;

const comparablePath = (path: string) =>
  path
    .replace(/[\\/]+/g, '/')
    .replace(/\/$/, '')
    .toLocaleLowerCase();

export function useProjectEntryRename({
  paneWorkspace,
  dirtyFileKeys,
  registerWorkspaceSelection,
}: {
  paneWorkspace: Pick<ReturnType<typeof usePaneWorkspace>, 'leaves' | 'promoteInLeaf'>;
  dirtyFileKeys: ReadonlySet<string>;
  registerWorkspaceSelection(selection: NavigationSelection, title: string, replaceKey?: string): void;
}) {
  const latest = useRef({ paneWorkspace, dirtyFileKeys });
  latest.current = { paneWorkspace, dirtyFileKeys };
  return useCallback(
    async (projectPath: string, relPath: string, newName: string): Promise<void> => {
      const fromRel = relPath.replace(/\\/g, '/');
      const parentRel = fromRel.split('/').slice(0, -1).join('/');
      const toRel = parentRel ? `${parentRel}/${newName}` : newName;
      const project = comparablePath(projectPath);
      const { paneWorkspace: workspace, dirtyFileKeys: dirty } = latest.current;
      const affected = workspace.leaves.flatMap((leaf) =>
        leaf.tabs
          .filter(
            (tab): tab is FileSelection =>
              tab.kind === 'file' &&
              comparablePath(tab.project) === project &&
              (tab.rel === fromRel || tab.rel.startsWith(`${fromRel}/`))
          )
          .map((tab) => ({ leafId: leaf.id, tab }))
      );
      const unsaved = affected.find(({ tab }) => dirty.has(navigationKey(tab)));
      if (unsaved) {
        throw new Error(
          t('Save or revert {{name}} before renaming it.', {
            name: unsaved.tab.rel.split('/').at(-1) || unsaved.tab.rel,
          })
        );
      }
      await window.mixdogDesktop.renameProjectEntry?.(projectPath, relPath, newName);
      for (const { leafId, tab } of affected) {
        const rel = `${toRel}${tab.rel.slice(fromRel.length)}`;
        const next: FileSelection = { ...tab, rel };
        workspace.promoteInLeaf(leafId, next, navigationKey(tab));
        registerWorkspaceSelection(next, rel.split('/').at(-1) || rel, navigationKey(tab));
      }
    },
    [registerWorkspaceSelection]
  );
}
