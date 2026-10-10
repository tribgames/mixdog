import { navigationKey } from '../text-format';
import type { usePaneWorkspace } from '../pane-workspace-state';
import type { useAppSideDocks } from '../use-app-side-docks';
import { getLinkPreview } from '../link-preview-preference';
import { paneDockActiveFile } from '../pane-side-dock';
import { bindSideFileGuard } from './use-side-file-guard';

type SideFileGuardDeps = Parameters<typeof bindSideFileGuard>[1];

/** Binds this render's side-file guard: which files the side docks and main
 *  tabs show, which are dirty, and how a file moves between them. */
export function bindAppFrameSideFileGuard({
  sideFileGuardRef,
  paneSideDocks,
  paneWorkspace,
  dirtyFileKeys,
  handleFileDirty,
  confirmSideFileExit,
  openFileTabRaw,
}: {
  sideFileGuardRef: Parameters<typeof bindSideFileGuard>[0];
  paneSideDocks: ReturnType<typeof useAppSideDocks>['paneSideDocks'];
  paneWorkspace: ReturnType<typeof usePaneWorkspace>;
  dirtyFileKeys: ReadonlySet<string>;
  handleFileDirty(key: string, dirty: boolean): void;
  confirmSideFileExit: SideFileGuardDeps['confirm'];
  openFileTabRaw: SideFileGuardDeps['openMainTab'];
}) {
  // The dock's eviction reads the live dirty keys: dirty tabs are never dropped.
  paneSideDocks.dirtyKeysRef.current = dirtyFileKeys;
  return bindSideFileGuard(sideFileGuardRef, {
    sideFiles: () =>
      Object.entries(paneSideDocks.docks).flatMap(([leafId, entry]) => {
        const active = paneDockActiveFile(entry);
        return (entry.files ?? []).map((file) => ({ leafId, file, active: file === active }));
      }),
    mainTabKeys: () =>
      new Set(
        paneWorkspace.leaves.flatMap((leaf) =>
          leaf.tabs.filter((selection) => selection.kind === 'file').map((selection) => navigationKey(selection))
        )
      ),
    isDirty: (key) => dirtyFileKeys.has(key),
    clearDirty: (key) => handleFileDirty(key, false),
    confirm: confirmSideFileExit,
    dockOpenFile: paneSideDocks.openFile,
    dockCloseFile: paneSideDocks.closeFile,
    openMainTab: openFileTabRaw,
    linkPreview: getLinkPreview,
  });
}
