import { useCallback, useRef } from 'react';

import { t } from '../i18n';
import type { NavigationSelection } from '../navigation';
import type { usePaneSideDocks } from '../pane-side-dock-state';
import type { usePaneWorkspace } from '../pane-workspace-state';
import { sideFileDirtyKey, type SideFileRef } from '../side-file-tabs';
import { navigationKey } from '../text-format';

type FileSelection = Extract<NavigationSelection, { kind: 'file' }>;

const comparablePath = (path: string) =>
  path
    .replace(/[\\/]+/g, '/')
    .replace(/\/$/, '')
    .toLocaleLowerCase();

const fileName = (rel: string) => rel.split('/').at(-1) || rel;

export function useProjectEntryRename({
  paneWorkspace,
  paneSideDocks,
  dirtyFileKeys,
  registerWorkspaceSelection,
}: {
  paneWorkspace: Pick<ReturnType<typeof usePaneWorkspace>, 'leaves' | 'promoteInLeaf'>;
  paneSideDocks: Pick<ReturnType<typeof usePaneSideDocks>, 'docks' | 'retargetFiles'>;
  dirtyFileKeys: ReadonlySet<string>;
  registerWorkspaceSelection(selection: NavigationSelection, title: string, replaceKey?: string): void;
}) {
  const latest = useRef({ paneWorkspace, paneSideDocks, dirtyFileKeys });
  latest.current = { paneWorkspace, paneSideDocks, dirtyFileKeys };
  return useCallback(
    async (projectPath: string, relPath: string, newName: string): Promise<void> => {
      const fromRel = relPath.replace(/\\/g, '/');
      const parentRel = fromRel.split('/').slice(0, -1).join('/');
      const toRel = parentRel ? `${parentRel}/${newName}` : newName;
      const project = comparablePath(projectPath);
      const { paneWorkspace: workspace, paneSideDocks: docks, dirtyFileKeys: dirty } = latest.current;
      const moves = (file: Pick<SideFileRef, 'project' | 'rel'>) =>
        comparablePath(file.project) === project && (file.rel === fromRel || file.rel.startsWith(`${fromRel}/`));
      const renamed = (rel: string) => `${toRel}${rel.slice(fromRel.length)}`;
      const affected = workspace.leaves.flatMap((leaf) =>
        leaf.tabs
          .filter((tab): tab is FileSelection => tab.kind === 'file' && moves(tab))
          .map((tab) => ({ leafId: leaf.id, tab }))
      );
      // Side-dock file tabs, those held for another tab included.
      const sideFiles = Object.values(docks.docks).flatMap((entry) =>
        [entry, ...Object.values(entry.held ?? {})].flatMap((part) => (part.files ?? []).filter(moves))
      );
      const unsaved =
        affected.find(({ tab }) => dirty.has(navigationKey(tab)))?.tab ??
        sideFiles.find((file) => dirty.has(sideFileDirtyKey(file)));
      if (unsaved) {
        throw new Error(t('Save or revert {{name}} before renaming it.', { name: fileName(unsaved.rel) }));
      }
      await window.mixdogDesktop.renameProjectEntry?.(projectPath, relPath, newName);
      for (const { leafId, tab } of affected) {
        const rel = renamed(tab.rel);
        const next: FileSelection = { ...tab, rel };
        workspace.promoteInLeaf(leafId, next, navigationKey(tab));
        registerWorkspaceSelection(next, fileName(rel), navigationKey(tab));
      }
      if (sideFiles.length > 0) docks.retargetFiles((file) => (moves(file) ? renamed(file.rel) : null));
    },
    [registerWorkspaceSelection]
  );
}
