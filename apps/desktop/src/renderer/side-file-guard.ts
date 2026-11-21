// One file must never be mounted in two editors: two sessions on one Monaco
// model each keep their own saved baseline, so the second save would be stale.
import {
  planSideFileOpen,
  sideFileDirtyKey,
  sideFileKey,
  sideFileTabDirtyKey,
  type PaneSideDockFile,
} from './side-file-tabs';

export { sideFileDirtyKey };

export type SideFileTarget = { project: string; rel: string; accessToken?: string };

export type SideFileDockRequest = { preview?: boolean; from?: string; sidePreview?: boolean };

export type OpenFileTab = (
  project: string,
  rel: string,
  line?: number,
  accessToken?: string,
  preview?: boolean,
  mode?: 'preview' | 'pinned'
) => void;

export interface SideFileGuardDeps {
  /** Every file tab of every pane's side dock, in tab order. */
  sideFiles(): ReadonlyArray<{ leafId: string; file: PaneSideDockFile; active?: boolean }>;
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
    column?: number,
    request?: SideFileDockRequest
  ): void;
  /** Closes one file tab (the active one without a key). */
  dockCloseFile(leafId: string, fileKey?: string): void;
  openMainTab: OpenFileTab;
  /** Link preview setting; ON when absent. */
  linkPreview?(): boolean;
  now?(): number;
}

export function createSideFileGuard(deps: SideFileGuardDeps) {
  /** Runs `proceed` now, or after the dialog when that tab has unsaved edits. */
  const whenSideFileSettled = (leafId: string, file: SideFileTarget, proceed: () => void) => {
    const key = sideFileDirtyKey(leafId, file);
    if (!deps.isDirty(key)) {
      proceed();
      return;
    }
    deps.confirm(key, file, () => {
      deps.clearDirty(key);
      proceed();
    });
  };

  /** Closes one tab, confirming its unsaved edits first. */
  const closeSideFileTab = (leafId: string, fileKey: string, then?: () => void) => {
    const held = deps.sideFiles().find((entry) => entry.leafId === leafId && sideFileKey(entry.file) === fileKey);
    const finish = () => {
      deps.dockCloseFile(leafId, fileKey);
      then?.();
    };
    if (!held) finish();
    else whenSideFileSettled(leafId, held.file, finish);
  };

  /** Closes every tab of the pane's dock, one confirmation per dirty tab. */
  const closeSideFile = (leafId: string, then?: () => void) => {
    const held = deps
      .sideFiles()
      .filter((entry) => entry.leafId === leafId)
      .map((entry) => entry.file);
    const closeFrom = (index: number) => {
      const file = held[index];
      if (!file) {
        then?.();
        return;
      }
      whenSideFileSettled(leafId, file, () => {
        deps.dockCloseFile(leafId, sideFileKey(file));
        closeFrom(index + 1);
      });
    };
    if (held.length === 0) {
      deps.dockCloseFile(leafId);
      then?.();
    } else closeFrom(0);
  };

  /** A main tab for a file shown in a side dock takes the file over: the side
   *  editor closes first (confirming unsaved edits), so one model never has
   *  two editors. This is also what "Open in main tab" does. */
  const openFileTab: OpenFileTab = (project, rel, line, accessToken, preview, mode) => {
    const key = sideFileKey({ project, rel, accessToken });
    const holder = deps.sideFiles().find((entry) => sideFileKey(entry.file) === key && !entry.file.sidePreview);
    if (!holder) {
      deps.openMainTab(project, rel, line, accessToken, preview, mode);
      return;
    }
    whenSideFileSettled(holder.leafId, holder.file, () => {
      deps.dockCloseFile(holder.leafId, key);
      deps.openMainTab(project, rel, line, accessToken, preview, mode);
    });
  };

  /** A transcript file link or Files-tree open: a tab in the pane's side
   *  dock (the preview tab under Link preview; a file with a tab is just
   *  activated). A dirty tab the open would drop is confirmed first. A file
   *  already open in a main tab or another pane's dock stays there.
   *  `from` is the tab the link was followed from; `pinned` opens a normal
   *  tab even under Link preview (a phone Files-tree tap). */
  const openFileInSideDock = (
    leafId: string,
    project: string,
    rel: string,
    line?: number,
    accessToken?: string,
    column?: number,
    from?: string,
    pinned?: boolean
  ) => {
    const preview = !pinned && (deps.linkPreview?.() ?? true);
    const request: SideFileDockRequest = { preview, ...(from ? { from } : {}) };
    const dockOpen = () => deps.dockOpenFile(leafId, project, rel, line, accessToken, column || undefined, request);
    const key = sideFileKey({ project, rel, accessToken });
    const holder = deps.sideFiles().find((entry) => sideFileKey(entry.file) === key);
    if (holder?.leafId === leafId) {
      dockOpen();
      return;
    }
    if (holder || deps.mainTabKeys().has(key)) {
      openFileTab(project, rel, line, accessToken);
      return;
    }
    const tabs = deps.sideFiles().filter((entry) => entry.leafId === leafId);
    const activeTab = tabs.find((entry) => entry.active);
    const plan = planSideFileOpen(
      { files: tabs.map((entry) => entry.file), active: activeTab ? sideFileKey(activeTab.file) : null },
      { project, rel, accessToken },
      0,
      {
        preview,
        from,
        now: deps.now?.(),
        isDirty: (fileKey) => deps.isDirty(sideFileTabDirtyKey(leafId, fileKey)),
      }
    );
    const dropFrom = (index: number) => {
      const file = plan.removed[index];
      if (!file) {
        dockOpen();
        return;
      }
      if (!deps.isDirty(sideFileDirtyKey(leafId, file))) {
        dropFrom(index + 1);
        return;
      }
      whenSideFileSettled(leafId, file, () => {
        deps.dockCloseFile(leafId, sideFileKey(file));
        dropFrom(index + 1);
      });
    };
    dropFrom(0);
  };

  /** "Open Preview to the Side": the file a main tab edits, as a read-only
   *  rendered tab in the pane's dock; it mounts no editor of its own. */
  const openPreviewToSide = (leafId: string, project: string, rel: string, accessToken?: string) => {
    deps.dockOpenFile(leafId, project, rel, undefined, accessToken, undefined, { preview: false, sidePreview: true });
  };

  return { closeSideFile, closeSideFileTab, openFileTab, openFileInSideDock, openPreviewToSide };
}
