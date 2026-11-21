import { useMemo, useState } from 'react';
import { usePaneWorkspace } from '../pane-workspace-state';
import type { ExtensionsSection } from '../extension-sections';
import type { WorkbenchQuickAccessMode } from '../workbench-overlays-loader';
import { navigationKey } from '../text-format';
import { desktopChromeSnapshotsEqual } from '../desktop-snapshot-store';
import { selectDesktopSnapshot, useDesktopSnapshotSelector } from '../app-snapshot-views';
import { useDesktopState } from '../app-desktop-state';
import { useAppShellPanels } from '../use-app-shell-panels';
import { useSessionPaneSurfaces } from '../use-session-pane-surfaces';
import { useAppProjectCatalog } from '../use-app-project-catalog';
import { useAppSideDocks } from '../use-app-side-docks';
import { useStartupPaneSelection } from './use-startup-pane-selection';
import { useAppEditorState } from './use-app-editor-state';

/** Desktop snapshot, pane workspace, shell panels, side docks, project catalog and editor state. */
export function useAppWorkspaceShell() {
  const { snapshotStore, connected, hydrated: snapshotHydrated, error, setError, applySnapshot } = useDesktopState();
  const snapshot = useDesktopSnapshotSelector(snapshotStore, selectDesktopSnapshot, desktopChromeSnapshotsEqual);
  const paneWorkspace = usePaneWorkspace();
  const sessionPaneSurfaces = useSessionPaneSurfaces(
    paneWorkspace.leaves.flatMap((leaf) => leaf.tabs.flatMap((tab) => (tab.kind === 'session' ? [tab.id] : [])))
  );
  const shellPanels = useAppShellPanels(paneWorkspace.focusedLeafId);
  const { applySidebarOpen, bottomPanel } = shellPanels;
  const sideDocks = useAppSideDocks({
    paneWorkspace,
    sessionSurfaces: sessionPaneSurfaces,
    applySidebarOpen,
  });
  const [extensionsSection, setExtensionsSection] = useState<ExtensionsSection>('plugins');
  const projectCatalog = useAppProjectCatalog(snapshot);
  const { focusedPaneSelection, startupNavigationSelection, startFresh } = useStartupPaneSelection(paneWorkspace);
  const startupFocusedPaneSelection = focusedPaneSelection;
  const editorState = useAppEditorState({ paneWorkspace, startupFocusedPaneSelection, bottomPanel });

  // Both read through to the workspace as it is now, not as it last rendered:
  // two handlers in one batch (a bulk archive's completions) each see what the
  // one before did.
  const { now: paneWorkspaceNow } = paneWorkspace;
  const paneLeavesRef = useMemo(
    () => ({
      get current() {
        return paneWorkspaceNow().leaves;
      },
    }),
    [paneWorkspaceNow]
  );
  const focusedLeafIdRef = useMemo(
    () => ({
      get current() {
        return paneWorkspaceNow().focusedLeafId;
      },
    }),
    [paneWorkspaceNow]
  );
  const activeFileKey = focusedPaneSelection?.kind === 'file' ? navigationKey(focusedPaneSelection) : '';
  const [quickAccessMode, setQuickAccessMode] = useState<WorkbenchQuickAccessMode | null>(null);

  return {
    snapshotStore,
    connected,
    snapshotHydrated,
    error,
    setError,
    applySnapshot,
    snapshot,
    paneWorkspace,
    sessionPaneSurfaces,
    shellPanels,
    sideDocks,
    extensionsSection,
    setExtensionsSection,
    projectCatalog,
    focusedPaneSelection,
    startupNavigationSelection,
    startupFocusedPaneSelection,
    startFresh,
    editorState,
    paneLeavesRef,
    focusedLeafIdRef,
    activeFileKey,
    quickAccessMode,
    setQuickAccessMode,
  };
}

export type AppWorkspaceShell = ReturnType<typeof useAppWorkspaceShell>;
