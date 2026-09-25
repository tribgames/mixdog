import type React from 'react';
import type { DesktopWorkspaceFolder } from '../../shared/contract';
import { SessionSidebar, type NavigationSelection } from '../navigation';
import { paneActiveSelection, type PaneLeaf } from '../pane-layout';
import type { usePaneWorkspace } from '../pane-workspace-state';
import { DEFAULT_SIDEBAR_VIEW_ORDER } from '../sidebar-view-layout';
import type { SidebarPanelKey } from '../app-shell-components';
import { SessionDiffPane } from '../SessionDiffPane';
import { prefetchDiffView } from '../lazy-widgets';
import { SnapshotUtilityDock } from '../app-snapshot-views';
import type { DesktopSnapshotStore } from '../desktop-snapshot-store';
import type { UtilityDockTab } from '../UtilityDock';
import { sidebarDiffColumnAvailable } from '../sidebar-diff-column';
import type { SourceControlDiffRequest } from '../SourceControlDock';
import type { PullRequestOpenHandler } from '../PullRequestsPane';
import { useAppDockWarmup } from '../use-app-boot';
import { renderPaneSideDockView } from '../app-shell-side-dock';
import { renderPaneProblemsView } from '../app-shell-pane-problems';
import type { WorkbenchSide, WorkbenchSideTitleDragProps, WorkbenchSideViewId } from '../workbench-side-view-layout';
import type { useAppSideDocks } from '../use-app-side-docks';
import type { useSessionPaneSurfaces } from '../use-session-pane-surfaces';
import type { createAppSideViewDescriptors } from '../app-side-view-descriptors';
import type { DraftPanePrefs } from '../use-draft-pane-preferences';
import type { useAppShellPanels } from '../use-app-shell-panels';
import type { useSessionCatalog } from '../app-session-catalog';
import type { useSideViewReordering } from '../app-shell-side-views';
import type { useEditorNavigation } from '../use-editor-navigation';

export interface UseAppWorkbenchViewsOptions {
  sessions: ReturnType<typeof useSessionCatalog>['sessions'];
  sessionCatalogReady: boolean;
  workingSessionIds: ReadonlySet<string>;
  unreadSessionIds: ReadonlySet<string>;
  sidebarSelection: NavigationSelection;
  sidebarNewTask: () => void;
  sidebarNewStudio: () => void;
  prefetchSession: (sessionId: string) => Promise<boolean>;
  sidebarResumeSession: (sessionId: string) => void;
  renameSession: (sessionId: string, title: string) => Promise<void>;
  archiveSession: (sessionId: string, archived: boolean) => Promise<void>;
  deleteSession: (sessionId: string) => Promise<void>;

  sideViewDescriptors: ReturnType<typeof createAppSideViewDescriptors>;
  renderSidebarPanel: (id: SidebarPanelKey, active: boolean) => React.ReactNode;
  sessionDiffs: ReturnType<typeof useSessionPaneSurfaces>['sessionDiffs'];
  setSessionDiff: ReturnType<typeof useSessionPaneSurfaces>['setSessionDiff'];

  snapshotStore: DesktopSnapshotStore;
  observedAgentSessionIds: readonly string[];
  quickAccessProjectPath: string;
  workbenchWorkspace: { workspace: { folders: Array<{ path: string }> } };
  selectToolProject: (path: string) => void;

  dockOpenFile: (project: string, rel: string, mode?: 'preview' | 'pinned') => void;
  dockOpenFileAt: (
    project: string,
    rel: string,
    line?: number,
    accessToken?: string,
    preview?: boolean,
    mode?: 'preview' | 'pinned'
  ) => void;
  dockOpenDiff: (project: string, rel: string, request: SourceControlDiffRequest) => void;
  dockOpenPullRequest: PullRequestOpenHandler;
  dockOpenLeadSession: (sessionId: string) => void;
  dockOpenAgentSession: (sessionId: string, title: string, ownerSessionId: string) => void;

  paneSideDocks: ReturnType<typeof useAppSideDocks>['paneSideDocks'];
  setSidebarDiff: ReturnType<typeof useAppSideDocks>['setSidebarDiff'];

  registeredProjectPath: (path: string) => string;
  resolvedDraftPrefsFor: (draftKey: string) => DraftPanePrefs;

  paneWorkspace: ReturnType<typeof usePaneWorkspace>;
  sessionPaneSurfaces: ReturnType<typeof useSessionPaneSurfaces>;
  workbenchSideLayout: ReturnType<typeof useAppSideDocks>['workbenchSideLayout'];
  closePaneRightRegion: ReturnType<typeof useAppSideDocks>['closePaneRightRegion'];
  selectWorkbenchSideView: (viewId: WorkbenchSideViewId) => void;
  moveWorkbenchSideGroup: ReturnType<typeof useSideViewReordering>['moveWorkbenchSideGroup'];
  moveWorkbenchSideView: ReturnType<typeof useSideViewReordering>['moveWorkbenchSideView'];
  openFileTab: (project: string, rel: string, line?: number) => void;

  desktopBootReady: boolean;

  bottomPanel: ReturnType<typeof useAppShellPanels>['bottomPanel'];
  problemsFilter: ReturnType<typeof useAppShellPanels>['problemsFilter'];
  setProblemsFilter: ReturnType<typeof useAppShellPanels>['setProblemsFilter'];
  problemsCollapseNonce: number;
  setProblemsCollapseNonce: React.Dispatch<React.SetStateAction<number>>;
  openProblemQuickFix: ReturnType<typeof useEditorNavigation>['openProblemQuickFix'];
}

export function useAppWorkbenchViews({
  sessions,
  sessionCatalogReady,
  workingSessionIds,
  unreadSessionIds,
  sidebarSelection,
  sidebarNewTask,
  sidebarNewStudio,
  prefetchSession,
  sidebarResumeSession,
  renameSession,
  archiveSession,
  deleteSession,
  sideViewDescriptors,
  renderSidebarPanel,
  sessionDiffs,
  setSessionDiff,
  snapshotStore,
  observedAgentSessionIds,
  quickAccessProjectPath,
  workbenchWorkspace,
  selectToolProject,
  dockOpenFile,
  dockOpenFileAt,
  dockOpenDiff,
  dockOpenPullRequest,
  dockOpenLeadSession,
  dockOpenAgentSession,
  paneSideDocks,
  setSidebarDiff,
  registeredProjectPath,
  resolvedDraftPrefsFor,
  paneWorkspace,
  sessionPaneSurfaces,
  workbenchSideLayout,
  closePaneRightRegion,
  selectWorkbenchSideView,
  moveWorkbenchSideGroup,
  moveWorkbenchSideView,
  openFileTab,
  desktopBootReady,
  bottomPanel,
  problemsFilter,
  setProblemsFilter,
  problemsCollapseNonce,
  setProblemsCollapseNonce,
  openProblemQuickFix,
}: UseAppWorkbenchViewsOptions) {
  const renderWorkbenchSideView = (
    side: WorkbenchSide,
    id: WorkbenchSideViewId,
    active: boolean,
    titleDragProps: WorkbenchSideTitleDragProps,
    pane?: {
      leafId: string;
      projectPath: string;
      sessionId: string;
      prewarm?: boolean;
    }
  ): React.ReactNode => {
    const sessionSidebarProps = {
      open: active,
      panelTitleDragProps: titleDragProps,
      sessions,
      sessionsReady: sessionCatalogReady,
      workingSessionIds,
      unreadSessionIds,
      selection: sidebarSelection,
      onNewTask: sidebarNewTask,
      onNewStudio: sidebarNewStudio,
      onPrefetchSession: window.mixdogDesktop?.prefetchSession ? prefetchSession : undefined,
      onResumeSession: sidebarResumeSession,
      onRenameSession: renameSession,
      onArchiveSession: archiveSession,
      onDeleteSession: deleteSession,
    };
    if (id === 'sessions') return <SessionSidebar {...sessionSidebarProps} />;
    if (DEFAULT_SIDEBAR_VIEW_ORDER.includes(id as SidebarPanelKey)) {
      return (
        <SessionSidebar {...sessionSidebarProps} panelActive panelTitle={sideViewDescriptors.get(id)?.label}>
          {renderSidebarPanel(id as SidebarPanelKey, active)}
        </SessionSidebar>
      );
    }
    if (id === 'session-diff') {
      if (!pane) return null;
      const sessionId = pane.sessionId;
      return (
        <SessionDiffPane
          sessionId={sessionId}
          active={active}
          openRel={sessionDiffs.get(sessionId)?.rel ?? ''}
          onOpenDiff={
            sessionId && pane.projectPath
              ? (rel) => {
                  void prefetchDiffView().catch(() => {});
                  setSessionDiff(sessionId, {
                    kind: 'diff',
                    project: pane.projectPath,
                    rel,
                    source: 'session',
                    hash: sessionId,
                  });
                }
              : undefined
          }
        />
      );
    }
    // Session-owned surfaces render in the pane dock's persistent stack.
    if (id === 'browser' || id === 'terminal') return null;
    const tab = id as UtilityDockTab;
    return (
      <SnapshotUtilityDock
        snapshotStore={snapshotStore}
        hidden={!active}
        prewarm={Boolean(pane?.prewarm)}
        open={active}
        tab={tab}
        showTitle={!pane}
        title={sideViewDescriptors.get(id)?.label}
        titleDragProps={titleDragProps}
        sessions={sessions}
        sessionsReady={sessionCatalogReady}
        activeSessionIds={observedAgentSessionIds}
        unreadSessionIds={unreadSessionIds}
        onPrefetchSession={prefetchSession}
        projectPath={pane?.projectPath || quickAccessProjectPath}
        workspaceFolders={workbenchWorkspace.workspace.folders as DesktopWorkspaceFolder[]}
        onSelectProject={selectToolProject}
        metricSurface={side === 'left' ? 'sidebar' : 'dock'}
        entering
        contentReady
        onOpenFile={dockOpenFile}
        onOpenFileAt={dockOpenFileAt}
        onOpenDiff={
          pane
            ? (project, rel, request) => {
                void prefetchDiffView().catch(() => {});
                paneSideDocks.openDiff(pane.leafId, project, rel, request);
              }
            : (project, rel, request) => {
                const cleanProject = String(project || '').trim();
                const cleanRel = String(rel || '')
                  .replace(/\\/g, '/')
                  .replace(/^\/+/, '');
                if (!cleanProject || !cleanRel) return;
                if (!sidebarDiffColumnAvailable()) {
                  dockOpenDiff(project, rel, request);
                  return;
                }
                void prefetchDiffView().catch(() => {});
                setSidebarDiff({
                  view: id,
                  diff: { kind: 'diff', project: cleanProject, rel: cleanRel, ...request },
                });
              }
        }
        onOpenPullRequest={dockOpenPullRequest}
        onOpenLeadSession={dockOpenLeadSession}
        onOpenAgentSession={dockOpenAgentSession}
      />
    );
  };

  const paneProjectPathFor = (leaf: PaneLeaf): string => {
    const active = paneActiveSelection(leaf);
    if (active?.kind === 'session') {
      const row = sessions.find((session) => session?.id === active.id);
      const registered = registeredProjectPath(String(row?.projectPath || ''));
      if (registered) return registered;
    }
    if (active?.kind === 'file' && active.project) return active.project;
    if (active?.kind === 'new') {
      const prefs = resolvedDraftPrefsFor(active.draftId || 'default');
      if (prefs.projectPath) return prefs.projectPath;
    }
    return quickAccessProjectPath;
  };

  const focusedPaneForDockPrewarm = paneWorkspace.leaves.find((leaf) => leaf.id === paneWorkspace.focusedLeafId);
  const focusedPaneDockProjectPath = focusedPaneForDockPrewarm
    ? paneProjectPathFor(focusedPaneForDockPrewarm)
    : quickAccessProjectPath;
  const dockBodyWarm = useAppDockWarmup(desktopBootReady, focusedPaneDockProjectPath);

  const renderPaneSideDock = (leaf: PaneLeaf, focused: boolean) =>
    renderPaneSideDockView(leaf, focused, {
      paneWorkspace,
      paneSideDocks,
      sessionSurfaces: sessionPaneSurfaces,
      workbenchSideLayout,
      sideViewDescriptors,
      dockBodyWarm,
      closePaneRightRegion,
      selectWorkbenchSideView,
      moveWorkbenchSideGroup,
      moveWorkbenchSideView,
      openFileTab,
      paneProjectPathFor,
      renderRightView: (id, active, titleDragProps, pane) =>
        renderWorkbenchSideView('right', id, active, titleDragProps, pane),
    });

  const renderPaneProblems = (leaf: PaneLeaf) =>
    renderPaneProblemsView(leaf, {
      bottomPanel,
      problemsFilter,
      setProblemsFilter,
      problemsCollapseNonce,
      setProblemsCollapseNonce,
      openFileTab,
      openProblemQuickFix,
    });

  return {
    renderWorkbenchSideView,
    paneProjectPathFor,
    renderPaneSideDock,
    renderPaneProblems,
  };
}
