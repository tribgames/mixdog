// A transcript link's file lives in a pane's side dock, outside the tab list,
// so the tab-close path never sees its unsaved edits. This guard puts every
// way that file can go away — close, replacement by another link, a main tab
// taking the same file — behind the unsaved-changes confirmation the main
// tabs use, and keeps one file from being mounted in two editors at once
// (two sessions on one Monaco model each keep their own saved baseline, so
// the second save would be stale).
import { navigationKey } from './text-format';
import type { PaneSideDockFile } from './pane-side-dock';

export type SideFileTarget = { project: string; rel: string; accessToken?: string };

export function sideFileDirtyKey(leafId: string): string {
  return `side-file:${leafId}`;
}

export function sideFileTargetKey(target: SideFileTarget): string {
  return navigationKey({ kind: 'file', project: target.project, rel: target.rel, accessToken: target.accessToken });
}

export type OpenFileTab = (
  project: string,
  rel: string,
  line?: number,
  accessToken?: string,
  preview?: boolean,
  mode?: 'preview' | 'pinned'
) => void;

export interface SideFileGuardDeps {
  /** The live side file of every pane. */
  sideFiles(): ReadonlyArray<{ leafId: string; file: PaneSideDockFile }>;
  /** Keys of the file tabs open in any pane. */
  mainTabKeys(): ReadonlySet<string>;
  isDirty(key: string): boolean;
  clearDirty(key: string): void;
  /** Shows the unsaved-changes dialog; `proceed` runs after Save or Discard. */
  confirm(key: string, target: SideFileTarget, proceed: () => void): void;
  dockOpenFile(
    leafId: string,
    project: string,
    rel: string,
    line?: number,
    accessToken?: string,
    column?: number
  ): void;
  dockCloseFile(leafId: string): void;
  openMainTab: OpenFileTab;
}

export function createSideFileGuard(deps: SideFileGuardDeps) {
  /** Runs `proceed` now, or after the dialog when the pane's side file has unsaved edits. */
  const whenSideFileSettled = (leafId: string, file: SideFileTarget, proceed: () => void) => {
    const key = sideFileDirtyKey(leafId);
    if (!deps.isDirty(key)) {
      proceed();
      return;
    }
    deps.confirm(key, file, () => {
      deps.clearDirty(key);
      proceed();
    });
  };

  const closeSideFile = (leafId: string, then?: () => void) => {
    const held = deps.sideFiles().find((entry) => entry.leafId === leafId);
    const finish = () => {
      deps.dockCloseFile(leafId);
      then?.();
    };
    if (!held) finish();
    else whenSideFileSettled(leafId, held.file, finish);
  };

  /** A main tab for a file shown in a side dock takes the file over: the side
   *  editor closes first (confirming unsaved edits), so one model never has
   *  two editors. This is also what "Open in main tab" does. */
  const openFileTab: OpenFileTab = (project, rel, line, accessToken, preview, mode) => {
    const key = sideFileTargetKey({ project, rel, accessToken });
    const holder = deps.sideFiles().find((entry) => sideFileTargetKey(entry.file) === key);
    if (!holder) {
      deps.openMainTab(project, rel, line, accessToken, preview, mode);
      return;
    }
    whenSideFileSettled(holder.leafId, holder.file, () => {
      deps.dockCloseFile(holder.leafId);
      deps.openMainTab(project, rel, line, accessToken, preview, mode);
    });
  };

  /** A transcript file link: the pane's side dock, replacing its file after
   *  confirming unsaved edits. A file already open elsewhere stays there. */
  const openFileInSideDock = (
    leafId: string,
    project: string,
    rel: string,
    line?: number,
    accessToken?: string,
    column?: number
  ) => {
    const dockOpen = () =>
      column
        ? deps.dockOpenFile(leafId, project, rel, line, accessToken, column)
        : deps.dockOpenFile(leafId, project, rel, line, accessToken);
    const target = { project, rel, accessToken };
    const key = sideFileTargetKey(target);
    const holder = deps.sideFiles().find((entry) => sideFileTargetKey(entry.file) === key);
    if (holder?.leafId === leafId) {
      dockOpen();
      return;
    }
    if (holder || deps.mainTabKeys().has(key)) {
      openFileTab(project, rel, line, accessToken);
      return;
    }
    const current = deps.sideFiles().find((entry) => entry.leafId === leafId);
    if (current) whenSideFileSettled(leafId, current.file, dockOpen);
    else dockOpen();
  };

  return { closeSideFile, openFileTab, openFileInSideDock };
}
