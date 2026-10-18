import { useCallback, useEffect } from 'react';
import { OPEN_CONNECTION_SETTINGS_EVENT } from '../remote-claim-events';
import {
  IMPORT_CATALOGS_CHANGED_EVENT,
  OPEN_IMPORTED_SESSION_EVENT,
  type OpenImportedSessionDetail,
} from '../import-conversation-events';
import { startImportJobStore } from '../import-job-store';
import { requestSessionRead } from '../app-snapshot-views';
import { createProjectActions } from '../app-project-actions';
import { useAppSessionActions } from '../use-app-session-actions';
import { closeSessionPaneTabs } from '../session-tab-cleanup';
import { useAppSessionOpen } from '../app-shell-session-open';
import { useAppSettingsRouter } from './use-app-settings-router';
import type { AppWorkspaceShell } from './use-app-workspace-shell';
import type { AppNavigationShell } from './use-app-navigation-shell';
import type { AppSessionLifecycle } from './use-app-session-lifecycle';

/** Project and session commands, session opening and the Settings router. */
export function useAppSessionCommands(
  shell: AppWorkspaceShell,
  nav: AppNavigationShell,
  lifecycle: AppSessionLifecycle
) {
  const {
    projectCatalog,
    applySnapshot,
    setError,
    sessionPaneSurfaces,
    shellPanels,
    sideDocks,
    setExtensionsSection,
    focusedLeafIdRef,
    snapshot,
    paneLeavesRef,
    paneWorkspace,
  } = shell;
  const closePaneTab = paneWorkspace.closeTabByKey;
  const { projects, refreshProjects } = projectCatalog;
  const { releaseDeletedSessionSurfaces } = sessionPaneSurfaces;
  const {
    invoke,
    closeSidebarForNavigation,
    refreshSessions,
    navigationEpoch,
    sessions,
    setSessions,
    selection,
    pendingSessionRenames,
    pendingSessionArchives,
    pendingSessionDeletes,
    invalidateSessionListings,
    setRequestedSessionId,
    openSessionRef,
  } = nav;
  const { tabs, setTabs, activateSelection, synchronizeActualHost, finishPendingConversationHandoff } =
    lifecycle.taskLifecycle;

  const refreshSessionsBestEffort = useCallback(() => {
    void refreshSessions().catch(() => undefined);
  }, [refreshSessions]);

  // Project navigation and registry edits: app-project-actions.ts.
  const { startProject, renameProject, removeProject, openProjectInExplorer } = createProjectActions({
    projects,
    invoke,
    applySnapshot,
    activateSelection,
    synchronizeActualHost,
    closeSidebarForNavigation,
    refreshProjects,
    refreshSessionsBestEffort,
    beginNavigation: () => {
      navigationEpoch.current += 1;
    },
  });
  const closeSessionTabs = useCallback(
    (sessionId: string) =>
      closeSessionPaneTabs(sessionId, paneLeavesRef.current, focusedLeafIdRef.current, tabs, closePaneTab),
    [paneLeavesRef, focusedLeafIdRef, tabs, closePaneTab]
  );
  const { renameSession, archiveSession, favoriteSession, moveSessionToProject, deleteSession } = useAppSessionActions({
    sessions,
    setSessions,
    tabs,
    setTabs,
    selection,
    setError,
    refreshSessions,
    pendingRenames: pendingSessionRenames,
    pendingArchives: pendingSessionArchives,
    pendingDeletes: pendingSessionDeletes,
    invalidateSessionListings,
    applySnapshot,
    activateSelection,
    onSessionDeleted: releaseDeletedSessionSurfaces,
    closeSessionTabs,
    openSession: (sessionId) => openSessionRef.current(sessionId),
    navigationEpoch,
    setRequestedSessionId,
  });

  const { openSession } = useAppSessionOpen({
    navigationEpoch,
    closeSidebarForNavigation,
    setRequestedSessionId,
    sessions,
    tabs,
    finishPendingConversationHandoff,
    activateSelection,
    announceOpen: paneWorkspace.announceOpenInFocused,
  });
  openSessionRef.current = openSession;
  const prefetchSession = useCallback((sessionId: string) => requestSessionRead(sessionId), []);
  const { openSettings } = useAppSettingsRouter({
    ...shellPanels,
    ...sideDocks,
    setExtensionsSection,
    focusedLeafIdRef,
    uiOpenRequest: snapshot.uiOpenRequest,
    sessionId: snapshot.sessionId,
    setupUiRequest: snapshot.setupUiRequest,
    setupChanged: snapshot.setupChanged,
  });
  // A remote window's PC menu asks this window for Settings → Connection.
  useEffect(
    () => window.mixdogDesktop?.subscribeShowConnectionSettings?.(() => openSettings('connection')),
    [openSettings]
  );

  // The title-bar PC menu and the "a device is asking to connect" notice open
  // the page (with the dialog they asked for).
  useEffect(() => {
    const open = () => openSettings('connection');
    window.addEventListener(OPEN_CONNECTION_SETTINGS_EVENT, open);
    return () => window.removeEventListener(OPEN_CONNECTION_SETTINGS_EVENT, open);
  }, [openSettings]);

  const { setSettingsOpen } = shellPanels;
  // Batch imports register their projects; refresh both catalogs, leaving the active chat alone.
  useEffect(() => {
    startImportJobStore();
    const refresh = () => {
      refreshSessionsBestEffort();
      void Promise.resolve(refreshProjects()).catch(() => undefined);
    };
    window.addEventListener(IMPORT_CATALOGS_CHANGED_EVENT, refresh);
    return () => window.removeEventListener(IMPORT_CATALOGS_CHANGED_EVENT, refresh);
  }, [refreshProjects, refreshSessionsBestEffort]);
  // A finished single import: refresh the catalog, then open it like any other
  // existing session (no prompt is submitted).
  useEffect(() => {
    const open = (event: Event) => {
      const detail = (event as CustomEvent<OpenImportedSessionDetail>).detail;
      if (!detail?.sessionId) return;
      setSettingsOpen(false);
      void refreshSessions()
        .catch(() => undefined)
        .then(() => openSessionRef.current(detail.sessionId));
    };
    window.addEventListener(OPEN_IMPORTED_SESSION_EVENT, open);
    return () => window.removeEventListener(OPEN_IMPORTED_SESSION_EVENT, open);
  }, [openSessionRef, refreshSessions, setSettingsOpen]);

  return {
    startProject,
    renameProject,
    removeProject,
    openProjectInExplorer,
    renameSession,
    archiveSession,
    favoriteSession,
    moveSessionToProject,
    deleteSession,
    openSession,
    prefetchSession,
    openSettings,
  };
}

export type AppSessionCommands = ReturnType<typeof useAppSessionCommands>;
