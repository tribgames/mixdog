import type React from 'react';
import { useMemo } from 'react';
import type { WorkspaceSelection } from '../navigation';
import { paneActiveSelection, paneLeafIdInVerticalDirection, paneTabAcrossVisualBoundary } from '../pane-layout';
import { navigationKey } from '../text-format';
import type { usePaneWorkspace } from '../pane-workspace-state';
import { useAppWorkspaceNavigation } from '../use-app-workspace-navigation';
import { buildAppWorkbenchCommands } from '../app-workbench-commands';
import type { WorkbenchQuickAccessMode } from '../workbench-overlays-loader';
import type { EditorSaveHandle } from '../use-pane-tab-close';
import type { useAppShellPanels } from '../use-app-shell-panels';
import type { usePaneTabNavigation } from '../use-pane-tab-navigation';
import type { useAppSideDocks } from '../use-app-side-docks';
import type { useEditorNavigation } from '../use-editor-navigation';
import type { useAppPaneChrome } from '../use-app-pane-chrome';
import type { WorkbenchCommand } from '../WorkbenchOverlays';
import type { useAppEditorState } from './use-app-editor-state';
import type { useAppSettingsRouter } from './use-app-settings-router';
import type { useAppTaskLifecycle } from './use-app-task-lifecycle';

export interface UseAppWorkbenchNavigationHubOptions {
  paneWorkspace: ReturnType<typeof usePaneWorkspace>;
  requestedSessionId: string;
  focusedPaneSelection: WorkspaceSelection | null;
  activeTabKey: string;
  navigateTab: ReturnType<typeof usePaneTabNavigation>['navigateTab'];
  focusPaneTypingSurface: ReturnType<typeof usePaneTabNavigation>['focusPaneTypingSurface'];
  activatePaneSurface: ReturnType<typeof useAppPaneChrome>['activatePaneSurface'];
  startTask: ReturnType<typeof useAppTaskLifecycle>['startTask'];
  openSettings: ReturnType<typeof useAppSettingsRouter>['openSettings'];
  toggleSidebar: () => void;
  toggleDock: (leafId?: string) => void;
  toggleBottomPanel: ReturnType<typeof useAppShellPanels>['toggleBottomPanel'];
  setQuickAccessMode: React.Dispatch<React.SetStateAction<WorkbenchQuickAccessMode | null>>;
  openDockTab: ReturnType<typeof useAppSideDocks>['openDockTab'];
  navigateEditorHistory: ReturnType<typeof useEditorNavigation>['navigateEditorHistory'];
  editorNavigationHistory: ReturnType<typeof useEditorNavigation>['editorNavigationHistory'];
  chooseFileTab: (leafId?: string) => Promise<void>;
  activeFileKey: string;
  editorSaveHandles: React.MutableRefObject<Map<string, EditorSaveHandle>>;
  dirtyFileKeys: ReadonlySet<string>;
  bottomPanel: ReturnType<typeof useAppShellPanels>['bottomPanel'];
  editorCommandCapabilities: ReturnType<typeof useAppEditorState>['editorCommandCapabilities'];
  openTerminalTab: (leafId?: string) => void;
  openStudioTab: (leafId?: string) => void;
  toolProjectPath: string;
  workbenchWorkspace: { workspace: { folders: Array<{ path: string }> } };
  quickAccessMode: WorkbenchQuickAccessMode | null;
}

export function useAppWorkbenchNavigationHub({
  paneWorkspace,
  requestedSessionId,
  focusedPaneSelection,
  activeTabKey,
  navigateTab,
  focusPaneTypingSurface,
  activatePaneSurface,
  startTask,
  openSettings,
  toggleSidebar,
  toggleDock,
  toggleBottomPanel,
  setQuickAccessMode,
  openDockTab,
  navigateEditorHistory,
  editorNavigationHistory,
  chooseFileTab,
  activeFileKey,
  editorSaveHandles,
  dirtyFileKeys,
  bottomPanel,
  editorCommandCapabilities,
  openTerminalTab,
  openStudioTab,
  toolProjectPath,
  workbenchWorkspace,
  quickAccessMode,
}: UseAppWorkbenchNavigationHubOptions) {
  // Ctrl+Left/Right crosses pane boundaries in visual row-major order and
  // enters at the adjacent edge tab, never the pane's stale active tab.
  const focusSiblingPane = (offset: number) => {
    const target = paneTabAcrossVisualBoundary(paneWorkspace.layout, paneWorkspace.focusedLeafId, offset);
    if (!target) return;
    paneWorkspace.focusLeaf(target.leafId);
    paneWorkspace.activateTab(target.leafId, navigationKey(target.selection));
    activatePaneSurface(target.selection);
    focusPaneTypingSurface(target.leafId, target.selection);
  };

  const focusVerticalPane = (direction: 'up' | 'down') => {
    const nextId = paneLeafIdInVerticalDirection(paneWorkspace.layout, paneWorkspace.focusedLeafId, direction);
    if (!nextId) return;
    const next = paneWorkspace.leaves.find((leaf) => leaf.id === nextId);
    if (!next) return;
    paneWorkspace.focusLeaf(next.id);
    const nextActive = paneActiveSelection(next);
    if (nextActive) activatePaneSurface(nextActive);
    focusPaneTypingSurface(next.id, nextActive);
  };

  const { focusedLeafForShortcuts, focusedLeafTabs, tabSwitcher } = useAppWorkspaceNavigation({
    paneWorkspace,
    requestedSessionId,
    focusedPaneSelection,
    activeTabKey,
    navigateTab,
    focusPaneTypingSurface,
    focusSiblingPane,
    focusVerticalPane,
    startTask,
    openSettings,
    toggleSidebar,
    toggleDock,
    toggleBottomPanel,
    setQuickAccessMode,
    openDockTab,
    navigateEditorHistory,
  });

  const quickAccessProjectPath = toolProjectPath || workbenchWorkspace.workspace.folders[0]?.path || '';

  const quickAccessRecentFiles = useMemo(() => {
    const seen = new Set<string>();
    const paths: string[] = [];
    for (const leaf of paneWorkspace.leaves) {
      for (const paneTab of leaf.tabs) {
        if (paneTab.kind !== 'file' || paneTab.project !== quickAccessProjectPath || seen.has(paneTab.rel)) continue;
        seen.add(paneTab.rel);
        paths.push(paneTab.rel);
      }
    }
    return paths;
  }, [paneWorkspace.leaves, quickAccessProjectPath]);

  // This registry is large and only consumed by the command palette. Avoid
  // rebuilding its callbacks and objects behind every unrelated button click.
  const workbenchCommands: WorkbenchCommand[] = buildAppWorkbenchCommands({
    quickAccessMode,
    editorNavigationHistory,
    navigateEditorHistory,
    setQuickAccessMode,
    chooseFileTab,
    activeFileKey,
    editorSaveHandles,
    dirtyFileKeys,
    focusedLeafTabs,
    openDockTab,
    bottomPanel,
    toggleBottomPanel,
    editorCommandCapabilities,
    toggleSidebar,
    toggleDock,
    openTerminalTab,
    startTask,
    openStudioTab,
    openSettings,
  });

  return {
    focusedLeafForShortcuts,
    focusedLeafTabs,
    tabSwitcher,
    quickAccessProjectPath,
    quickAccessRecentFiles,
    workbenchCommands,
  };
}
