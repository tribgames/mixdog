import { Suspense, useRef, type Dispatch, type MutableRefObject, type SetStateAction } from "react";
import type { NavigationSelection, WorkspaceSelection } from "./navigation";
import { paneActiveSelection, type PaneLeaf } from "./pane-layout";
import type { usePaneWorkspace } from "./pane-workspace-state";
import type { useWorkbenchWorkspace } from "./workbench-workspace";
import { navigationKey } from "./text-format";
import { BrowserPane, FolderPane } from "./lazy-widgets";
import { PullRequestEditor } from "./PullRequestsPane";
import {
  DeferredPersistentSurface,
  PersistentPanePortal,
} from "./PaneSurfaceGate";
import {
  DIFF_STARTUP_DELAY_MS,
  EDITOR_STARTUP_DELAY_MS,
  paneUtilitySurfaceSlotId,
  ReadyEditorPane,
  ReadyGitDiffPane,
  ReadyStudioPane,
  ReadyTerminalPane,
  TERMINAL_STARTUP_DELAY_MS,
} from "./app-shell-components";
import { DesktopLoadingSurface } from "./RendererRecovery";

type PaneWorkspace = ReturnType<typeof usePaneWorkspace>;
type WorkbenchWorkspace = ReturnType<typeof useWorkbenchWorkspace>;

type UtilitySelection = Extract<WorkspaceSelection, {
  kind: "studio" | "terminal" | "folder" | "browser" | "diff" | "pull-request";
}>;

/** Tabs that own a persistent utility surface (one mounted pane each). */
function isUtilitySelection(selection: WorkspaceSelection): selection is UtilitySelection {
  return selection.kind === "studio" || selection.kind === "terminal"
    || selection.kind === "folder" || selection.kind === "browser"
    || selection.kind === "diff" || selection.kind === "pull-request";
}

interface EditorNavigationLocation {
  project: string;
  rel: string;
  line: number;
  accessToken?: string;
}

export function useAppPersistentPaneSurfaces({
  paneWorkspace,
  workbenchWorkspace,
  fileReveal,
  handleFileDirty,
  registerEditorSaveHandle,
  openFileTab,
  latestEditorLocation,
  openDroppedPaths,
  setFolderPaneTitles,
  sidebarOpen,
  toggleSidebar,
}: {
  paneWorkspace: PaneWorkspace;
  workbenchWorkspace: WorkbenchWorkspace;
  fileReveal: { key: string; line: number; nonce: number } | null;
  handleFileDirty(key: string, dirty: boolean): void;
  registerEditorSaveHandle(key: string, save: { save(): Promise<boolean>; discard(): Promise<void> } | null): void;
  openFileTab(project: string, rel: string, line?: number, accessToken?: string): void;
  latestEditorLocation: MutableRefObject<EditorNavigationLocation | null>;
  openDroppedPaths(leafId: string, paths: string[]): Promise<void>;
  setFolderPaneTitles: Dispatch<SetStateAction<ReadonlyMap<string, string>>>;
  sidebarOpen: boolean;
  toggleSidebar(): void;
}) {
  // An activation latch is WORKSPACE-wide, so it may only be pruned against
  // every matching tab in every leaf, and only closing a tab releases it.
  // Pruning against ONE leaf's tabs evicted the other panes' surfaces:
  // Monaco instances remounted, LSP state churned, and unsaved-backup
  // restoration raced the remount.
  const pruneActivationLatch = (
    latched: Set<string>,
    owns: (selection: WorkspaceSelection) => boolean,
  ): void => {
    const openKeys = new Set<string>();
    for (const leaf of paneWorkspace.leaves) {
      for (const selection of leaf.tabs) {
        if (owns(selection)) openKeys.add(navigationKey(selection));
      }
    }
    for (const key of [...latched]) {
      if (!openKeys.has(key)) latched.delete(key);
    }
  };
  const activatedFileKeys = useRef(new Set<string>());
  pruneActivationLatch(activatedFileKeys.current, (selection) => selection.kind === "file");
  const paneFileEditors = (
    leaf: PaneLeaf,
    focused: boolean,
    focusPane: () => void,
  ) => {
    const active = paneActiveSelection(leaf);
    const paneActiveFileKey = active?.kind === "file" ? navigationKey(active) : "";
    if (paneActiveFileKey) activatedFileKeys.current.add(paneActiveFileKey);
    return leaf.tabs
      .filter((paneSelection): paneSelection is Extract<NavigationSelection, { kind: "file" }> => (
        paneSelection.kind === "file"
        && (navigationKey(paneSelection) === paneActiveFileKey
          || activatedFileKeys.current.has(navigationKey(paneSelection)))
      ))
      .map((fileSelection) => {
        const key = navigationKey(fileSelection);
        const fileActive = key === paneActiveFileKey;
        return <div key={key}
          className="schedules-pane editor-tab-pane stable-surface-preserved stable-pane-surface"
          data-surface-active={fileActive ? "true" : "false"}
          inert={fileActive ? undefined : true}
          aria-hidden={fileActive ? undefined : true}
          // Let Monaco own the complete pointer gesture before pane routing:
          // its text caret and scrollbar both capture on pointerdown. Moving
          // the pane after pointerup preserves first-click editing and allows
          // the first scrollbar gesture to drag instead of merely focusing.
          onPointerUpCapture={focused ? undefined : (event) => {
            if (event.button === 0) window.setTimeout(focusPane, 0);
          }}>
          <DeferredPersistentSurface active={fileActive || activatedFileKeys.current.has(key)}
              startupDelayMs={EDITOR_STARTUP_DELAY_MS}
              fallback={<DesktopLoadingSurface label="Loading editor…" />}>
            <ReadyEditorPane projectPath={fileSelection.project} relPath={fileSelection.rel}
                accessToken={fileSelection.accessToken}
                workspaceFile={workbenchWorkspace.workspace.workspaceFile}
                active={fileActive}
                focused={focused}
                onDirty={(dirty) => handleFileDirty(key, dirty)}
                onSaveHandle={(save) => registerEditorSaveHandle(key, save)}
                reveal={fileReveal && fileReveal.key === key ? fileReveal : null}
                codeGraph={fileSelection.accessToken ? undefined : (mode, symbol) =>
                  window.mixdogDesktop?.codeGraphQuery?.(fileSelection.project, mode, symbol)
                  ?? Promise.resolve("")}
                onOpenAt={fileSelection.accessToken ? undefined
                  : (rel, line) => openFileTab(fileSelection.project, rel, line)}
                onNavigationLocation={(rel, line) => {
                  if (!fileActive || !focused) return;
                  latestEditorLocation.current = {
                    project: fileSelection.project,
                    rel,
                    line,
                    ...(fileSelection.accessToken ? { accessToken: fileSelection.accessToken } : {}),
                  };
                }} />
          </DeferredPersistentSurface>
        </div>;
      });
  };
  // Utility surfaces (Studio/terminal/diff/PR) used to exist only while their
  // tab was the ACTIVE selection, so navigating away unmounted the whole pane
  // and coming back replayed the cold "Preparing …" cover (user: Studio가 백
  // 후 재진입마다 다시 로딩). Once a surface has been activated it stays
  // mounted — hidden and inert — for as long as its tab remains open; closing
  // the tab still disposes it.
  const activatedUtilitySurfaceKeys = useRef(new Set<string>());
  const paneUtilityTabs = (
    leaf: PaneLeaf,
    focused: boolean,
    focusPane: () => void,
  ) => {
    const active = paneActiveSelection(leaf);
    return leaf.tabs
      .filter((selection): selection is UtilitySelection => isUtilitySelection(selection)
        && (Boolean(active && navigationKey(active) === navigationKey(selection))
          || activatedUtilitySurfaceKeys.current.has(navigationKey(selection))))
      .map((utilitySelection) => {
        const key = navigationKey(utilitySelection);
        const utilityActive = active ? navigationKey(active) === key : false;
        return <div key={key}
          id={paneUtilitySurfaceSlotId(leaf.id, key)}
          className={`workspace-utility-tab ${utilitySelection.kind}-tab-pane stable-surface-preserved stable-pane-surface`}
          data-surface-active={utilityActive ? "true" : "false"}
          inert={utilityActive ? undefined : true}
          aria-hidden={utilityActive ? undefined : true}
          onPointerDownCapture={focused ? undefined : (event) => {
            if (event.button === 0) focusPane();
          }}>
        </div>;
      });
  };
  const utilitySurfaceDescriptors = new Map<string, {
    key: string;
    leafId: string;
    focused: boolean;
    active: boolean;
    selection: UtilitySelection;
  }>();
  for (const leaf of paneWorkspace.leaves) {
    const active = paneActiveSelection(leaf);
    for (const selection of leaf.tabs) {
      if (!isUtilitySelection(selection)) continue;
      const key = navigationKey(selection);
      const selectionActive = Boolean(active && navigationKey(active) === key);
      // Idempotent render-time latch: by the time the user leaves this tab,
      // many committed renders have already recorded the activation.
      if (selectionActive) activatedUtilitySurfaceKeys.current.add(key);
      else if (!activatedUtilitySurfaceKeys.current.has(key)) continue;
      const descriptor = {
        key,
        leafId: leaf.id,
        focused: leaf.id === paneWorkspace.focusedLeafId,
        active: selectionActive,
        selection,
      };
      const previous = utilitySurfaceDescriptors.get(key);
      if (!previous || (descriptor.active && !previous.active)
        || (descriptor.active && descriptor.focused)) {
        utilitySurfaceDescriptors.set(key, descriptor);
      }
    }
  }
  pruneActivationLatch(activatedUtilitySurfaceKeys.current, isUtilitySelection);
  const paneUtilitySurfacePortals = [...utilitySurfaceDescriptors.values()].map((descriptor) => {
    const { key, leafId, selection: utilitySelection } = descriptor;
    const utilityActive = descriptor.active;
    const startupDelayMs = utilitySelection.kind === "studio"
      ? 0
      : utilitySelection.kind === "diff"
        ? DIFF_STARTUP_DELAY_MS
        : utilitySelection.kind === "terminal" ? TERMINAL_STARTUP_DELAY_MS : 0;
    const startupLabel = utilitySelection.kind === "studio"
      ? "Preparing Studio…"
      : utilitySelection.kind === "diff"
        ? "Loading diff…"
        : utilitySelection.kind === "terminal"
          ? "Loading terminal…"
          : utilitySelection.kind === "browser"
            ? "Loading browser…"
          : utilitySelection.kind === "folder"
            ? "Loading folder…"
            : "Loading pull request…";
    return <PersistentPanePortal key={key}
      targetId={paneUtilitySurfaceSlotId(leafId, key)}
      className={`${utilitySelection.kind}-persistent-surface`}
      onPointerDownCapture={descriptor.focused ? undefined : (event) => {
        if (event.button === 0) paneWorkspace.focusLeaf(leafId);
      }}>
      <DeferredPersistentSurface
          active={utilityActive || activatedUtilitySurfaceKeys.current.has(key)}
          startupDelayMs={startupDelayMs}
          fallback={<DesktopLoadingSurface label={startupLabel} />}>
        {utilitySelection.kind === "studio"
          ? <ReadyStudioPane active={utilityActive}
              sidebarOpen={sidebarOpen} onToggleSidebar={toggleSidebar} />
          : utilitySelection.kind === "terminal"
            ? <ReadyTerminalPane cwd={utilitySelection.cwd || null}
                terminalId={utilitySelection.id} active={utilityActive} />
            : utilitySelection.kind === "browser"
              ? <Suspense fallback={null}>
                  <BrowserPane paneId={utilitySelection.id} active={utilityActive} />
                </Suspense>
            : utilitySelection.kind === "folder"
              ? <Suspense fallback={null}>
                  <FolderPane paneId={utilitySelection.id}
                    root={utilitySelection.path} active={utilityActive}
                    onOpenTextFile={(path) => openDroppedPaths(leafId, [path])}
                    onTitleChange={(title) => setFolderPaneTitles((current) => {
                      if (current.get(key) === title) return current;
                      const next = new Map(current);
                      next.set(key, title);
                      return next;
                    })} />
                </Suspense>
            : utilitySelection.kind === "diff"
              ? <ReadyGitDiffPane selection={utilitySelection} active={utilityActive}
                  onOpenFile={openFileTab} />
              : <PullRequestEditor projectPath={utilitySelection.project}
                  number={utilitySelection.number} mode={utilitySelection.mode}
                  active={utilityActive} />}
      </DeferredPersistentSurface>
    </PersistentPanePortal>;
  });


  return { paneFileEditors, paneUtilitySurfacePortals, paneUtilityTabs };
}
