import { useRef, useState } from 'react';
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
import { useAppSettingsMount } from '../use-app-boot';
import { useStartupPaneSelection } from './use-startup-pane-selection';
import { useAppEditorState } from './use-app-editor-state';

/** Desktop snapshot, pane workspace, shell panels, side docks, project catalog and editor state. */
export function useAppWorkspaceShell() {
  const { snapshotStore, connected, hydrated: snapshotHydrated, error, setError, applySnapshot } = useDesktopState();
  const snapshot = useDesktopSnapshotSelector(snapshotStore, selectDesktopSnapshot, desktopChromeSnapshotsEqual);
  const paneWorkspace = usePaneWorkspace();
  const sessionPaneSurfaces = useSessionPaneSurfaces();
  const shellPanels = useAppShellPanels(paneWorkspace.focusedLeafId);
  const { applySidebarOpen, bottomPanel, settingsOpen } = shellPanels;
  const { settingsMounted, settingsPrewarmed } = useAppSettingsMount(settingsOpen);
  const sideDocks = useAppSideDocks({
    paneWorkspace,
    sessionSurfaces: sessionPaneSurfaces,
    applySidebarOpen,
  });
  const [extensionsSection, setExtensionsSection] = useState<ExtensionsSection>('plugins');
  const projectCatalog = useAppProjectCatalog(snapshot);
  // Persisted panes restore synchronously. Session addresses are reconciled
  // incrementally after first paint and remain guarded by exact daemon reads.
  // File editors are normal tabs in the focused pane. The focused leaf is the
  // single source of truth for the Files highlight and tab shortcuts; a
  // separate global editor key made a file take over the whole main panel.
  const { focusedPaneSelection, startupNavigationSelection } = useStartupPaneSelection(paneWorkspace);
  const startupFocusedPaneSelection = focusedPaneSelection;
  const editorState = useAppEditorState({ paneWorkspace, startupFocusedPaneSelection, bottomPanel });

  const paneLeavesRef = useRef(paneWorkspace.leaves);
  paneLeavesRef.current = paneWorkspace.leaves;
  const focusedLeafIdRef = useRef(paneWorkspace.focusedLeafId);
  focusedLeafIdRef.current = paneWorkspace.focusedLeafId;
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
    settingsMounted,
    settingsPrewarmed,
    sideDocks,
    extensionsSection,
    setExtensionsSection,
    projectCatalog,
    focusedPaneSelection,
    startupNavigationSelection,
    startupFocusedPaneSelection,
    editorState,
    paneLeavesRef,
    focusedLeafIdRef,
    activeFileKey,
    quickAccessMode,
    setQuickAccessMode,
  };
}

export type AppWorkspaceShell = ReturnType<typeof useAppWorkspaceShell>;
