import type React from 'react';
import type { DesktopProjectSummary, DesktopWorkspaceFolder } from '../../shared/contract';
import { SessionSidebar, type NavigationSelection } from '../navigation';
import { paneActiveSelection, type PaneLeaf } from '../pane-layout';
import { navigationKey } from '../text-format';
import type { usePaneWorkspace } from '../pane-workspace-state';
import { DEFAULT_SIDEBAR_VIEW_ORDER } from '../sidebar-view-layout';
import type { SidebarPanelKey } from '../app-shell-components';
import { requestPaneDockClose } from '../pane-dock-chrome';
import { PhoneDeferredMount } from '../phone-deferred-mount';
import type { SessionDiffPane as SessionDiffPaneComponent } from '../SessionDiffPane';
import type { ServerPortsPanel as ServerPortsPanelComponent } from '../ServerPortsPanel';
import { useDeferredModule } from '../deferred-module';
import { serverPortsPanelModule, sessionDiffPaneModule, visualizePaneModule } from '../first-screen-deferred';
import type { VisualizePane as VisualizePaneComponent } from '../VisualizePane';
import { DesktopLoadingSurface } from '../RendererRecovery';
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
import type { createSideFileGuard } from '../side-file-guard';
import { WorkbenchProblemsPane } from '../WorkbenchProblems';
import type { EditorSaveHandle } from '../use-pane-tab-close';
import { cleanDiffTarget } from './workspace-targets';
import { showDesktopToast } from '../desktop-toasts';
import { errorMessageText } from '../ErrorNotice';
import { t } from '../i18n';
import { resolveLocalLink } from '../local-link-resolver';
import { isAbsolutePath } from '../session-diff-model';
import { sideFileKey } from '../side-file-tabs';
import { closingDrawerFirst } from './drawer-navigation';

// The Visualize panel is never part of the first screen, and its source view
// statically pulls the whole highlight.js core and language set: kept out of
// the startup graph, a phone cold open neither downloads nor evaluates it.
// Rendered synchronously once loaded (the phone's lane): a React.lazy suspends
// its first render even with the chunk in, behind a throttled reveal.
function VisualizePane(props: React.ComponentProps<typeof VisualizePaneComponent>) {
  const module = useDeferredModule(visualizePaneModule);
  return module ? <module.VisualizePane {...props} /> : null;
}

// The Changes and Ports views are side views no first screen shows: their
// chunks load on first mount (or from the idle lane), behind the shared
// delayed loading surface, which a warm or local load never shows.
function SessionDiffPane(props: React.ComponentProps<typeof SessionDiffPaneComponent>) {
  const module = useDeferredModule(sessionDiffPaneModule, { bootSurface: props.active ? 'session-diff' : undefined });
  const loading = <DesktopLoadingSurface label={t('Loading view…')} />;
  return module ? (
    <PhoneDeferredMount placeholder={loading}>
      <module.SessionDiffPane {...props} />
    </PhoneDeferredMount>
  ) : (
    loading
  );
}

function ServerPortsPanel(props: React.ComponentProps<typeof ServerPortsPanelComponent>) {
  const module = useDeferredModule(serverPortsPanelModule, { bootSurface: props.active ? 'server-ports' : undefined });
  return module ? <module.ServerPortsPanel {...props} /> : <DesktopLoadingSurface label={t('Loading view…')} />;
}

export interface UseAppWorkbenchViewsOptions {
  sessions: ReturnType<typeof useSessionCatalog>['sessions'];
  sessionCatalogReady: boolean;
  projects: readonly DesktopProjectSummary[];
  sidebarNewProjectTask: (projectPath: string) => void;
  sidebarOpenSessionInSplit: (sessionId: string, title: string) => void;
  sidebarInheritSession: (sessionId: string) => void;
  sidebarRenameProject: (projectPath: string, alias: string) => void;
  sidebarRevealProject?: (projectPath: string) => void;
  sidebarOpenProjectSettings: (projectPath: string) => void;
  sidebarAddProject: (onAdded?: (projectPath: string) => void) => void;
  revealedProject: { path: string; nonce: number };
  workingSessionIds: ReadonlySet<string>;
  unreadSessionIds: ReadonlySet<string>;
  sidebarSelection: NavigationSelection;
  sidebarNewTask: () => void;
  sidebarNewStudio: () => void;
  prefetchSession: (sessionId: string) => Promise<boolean>;
  sidebarResumeSession: (sessionId: string) => void;
  renameSession: (sessionId: string, title: string) => Promise<void>;
  archiveSession: (sessionId: string, archived: boolean) => Promise<void>;
  favoriteSession: (sessionId: string, favorite: boolean) => Promise<void>;
  moveSessionToProject: (sessionId: string, projectPath: string) => Promise<void>;
  deleteSession: (sessionId: string) => Promise<void>;

  sideViewDescriptors: ReturnType<typeof createAppSideViewDescriptors>;
  renderSidebarPanel: (id: SidebarPanelKey, active: boolean) => React.ReactNode;

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
  /** Phone drawer close (no-op on wide layouts); left-drawer results close it. */
  closeSidebarForNavigation?: () => void;
  renameProjectEntry: (projectPath: string, relPath: string, newName: string) => Promise<void>;

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
  sideFileGuard: ReturnType<typeof createSideFileGuard>;
  handleFileDirty: (key: string, dirty: boolean) => void;
  registerEditorSaveHandle: (key: string, save: EditorSaveHandle | null, released?: EditorSaveHandle) => void;

  desktopBootReady: boolean;

  bottomPanel: ReturnType<typeof useAppShellPanels>['bottomPanel'];
  problemsFilter: ReturnType<typeof useAppShellPanels>['problemsFilter'];
  setProblemsFilter: ReturnType<typeof useAppShellPanels>['setProblemsFilter'];
  problemsCollapseNonce: number;
  setProblemsCollapseNonce: React.Dispatch<React.SetStateAction<number>>;
  openProblemQuickFix: ReturnType<typeof useEditorNavigation>['openProblemQuickFix'];
}

// A Changes-pane file opens as a (pinned) tab of the pane's own side dock.
// Project files are already relative; a file outside the project resolves
// through the same absolute-path route chat file links use (one-off grant).
function openSessionDiffFile(
  sideFileGuard: UseAppWorkbenchViewsOptions['sideFileGuard'],
  leafId: string,
  projectPath: string,
  sessionId: string,
  path: string
): void {
  const open = (project: string, rel: string, accessToken?: string) =>
    sideFileGuard.openFileInSideDock(leafId, project, rel, undefined, accessToken, undefined, undefined, true);
  if (!isAbsolutePath(path) && projectPath) {
    open(projectPath, path);
    return;
  }
  resolveLocalLink(projectPath, path, sessionId)
    .then((target) => {
      if (!target.directory) open(target.project, target.path, target.accessToken);
    })
    .catch((error: unknown) => {
      showDesktopToast(t('Unable to open file: {{error}}', { error: errorMessageText(error) }), 'error');
    });
}

export function useAppWorkbenchViews({
  sessions,
  sessionCatalogReady,
  projects,
  sidebarNewProjectTask,
  sidebarOpenSessionInSplit,
  sidebarInheritSession,
  sidebarRenameProject,
  sidebarRevealProject,
  sidebarOpenProjectSettings,
  sidebarAddProject,
  revealedProject,
  workingSessionIds,
  unreadSessionIds,
  sidebarSelection,
  sidebarNewTask,
  sidebarNewStudio,
  prefetchSession,
  sidebarResumeSession,
  renameSession,
  archiveSession,
  favoriteSession,
  moveSessionToProject,
  deleteSession,
  sideViewDescriptors,
  renderSidebarPanel,
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
  closeSidebarForNavigation,
  renameProjectEntry,
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
  sideFileGuard,
  handleFileDirty,
  registerEditorSaveHandle,
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
      projects,
      onNewProjectTask: sidebarNewProjectTask,
      onOpenSessionInSplit: sidebarOpenSessionInSplit,
      onInheritSession: sidebarInheritSession,
      onRenameProject: sidebarRenameProject,
      onRevealProject: sidebarRevealProject,
      onOpenProjectSettings: sidebarOpenProjectSettings,
      onAddProject: sidebarAddProject,
      revealedProject,
      workingSessionIds,
      unreadSessionIds,
      selection: sidebarSelection,
      onNewTask: sidebarNewTask,
      onNewStudio: sidebarNewStudio,
      onPrefetchSession: window.mixdogDesktop?.prefetchSession ? prefetchSession : undefined,
      onResumeSession: sidebarResumeSession,
      onRenameSession: renameSession,
      onArchiveSession: archiveSession,
      onFavoriteSession: favoriteSession,
      onMoveSessionToProject: moveSessionToProject,
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
    if (id === 'ports') {
      return (
        <SessionSidebar {...sessionSidebarProps} panelActive panelTitle={sideViewDescriptors.get(id)?.label}>
          <ServerPortsPanel active={active} />
        </SessionSidebar>
      );
    }
    if (id === 'session-diff') {
      if (!pane) return null;
      const sessionId = pane.sessionId;
      const sideFiles = paneSideDocks.entryFor(pane.leafId).files ?? [];
      return (
        <SessionDiffPane
          sessionId={sessionId}
          active={active}
          cwd={pane.projectPath}
          onClose={() => requestPaneDockClose('session-diff')}
          onOpenFile={(path) => openSessionDiffFile(sideFileGuard, pane.leafId, pane.projectPath, sessionId, path)}
          fileTabs={{
            tabs: sideFiles.map((file) => ({
              key: sideFileKey(file),
              name: file.rel.split('/').at(-1) ?? file.rel,
              title: file.rel,
            })),
            onSelect: (key) => paneSideDocks.activateFile(pane.leafId, key),
            onClose: (key) => sideFileGuard.closeSideFileTab(pane.leafId, key),
          }}
        />
      );
    }
    if (id === 'visualize') {
      if (!pane) return null;
      return (
        <PhoneDeferredMount>
          <VisualizePane sessionId={pane.sessionId} active={active} onClose={() => requestPaneDockClose('visualize')} />
        </PhoneDeferredMount>
      );
    }
    // Session-owned surfaces render in the pane dock's persistent stack.
    if (id === 'browser' || id === 'terminal') return null;
    const tab = id as UtilityDockTab;
    // A result opened from the left drawer closes it on the phone so the
    // result is visible; the pane's own right dock is unchanged.
    const closeDrawer = side === 'left' && !pane ? closeSidebarForNavigation : undefined;
    // Search's file tree reveals the editor of the pane this view serves.
    const dockLeaf = paneWorkspace.leaves.find((leaf) => leaf.id === (pane?.leafId ?? paneWorkspace.focusedLeafId));
    const dockSelection = dockLeaf ? paneActiveSelection(dockLeaf) : null;
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
        onOpenFile={closingDrawerFirst(closeDrawer, dockOpenFile)}
        onOpenFileAt={closingDrawerFirst(closeDrawer, dockOpenFileAt)}
        activeFileKey={dockSelection?.kind === 'file' ? navigationKey(dockSelection) : ''}
        onRenameProjectEntry={renameProjectEntry}
        onOpenDiff={
          pane
            ? (project, rel, request) => {
                void prefetchDiffView().catch(() => {});
                paneSideDocks.openDiff(pane.leafId, project, rel, request);
              }
            : (project, rel, request) => {
                const target = cleanDiffTarget(project, rel);
                if (!target) return;
                if (!sidebarDiffColumnAvailable()) {
                  closingDrawerFirst(closeDrawer, dockOpenDiff)(project, rel, request);
                  return;
                }
                void prefetchDiffView().catch(() => {});
                setSidebarDiff({
                  view: id,
                  diff: { kind: 'diff', ...target, ...request },
                });
              }
        }
        onOpenPullRequest={closingDrawerFirst(closeDrawer, dockOpenPullRequest)}
        onOpenLeadSession={closingDrawerFirst(closeDrawer, dockOpenLeadSession)}
        onOpenAgentSession={closingDrawerFirst(closeDrawer, dockOpenAgentSession)}
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
      sideFileGuard,
      renameProjectEntry,
      renderFileProblems: (file) => (
        <WorkbenchProblemsPane
          projectPath={file.project}
          active
          activeFileRel={file.rel}
          filter={{ ...problemsFilter, activeFileOnly: true }}
          collapseNonce={problemsCollapseNonce}
          onOpenFile={openFileTab}
          onQuickFix={openProblemQuickFix}
        />
      ),
      handleFileDirty,
      registerEditorSaveHandle,
      paneProjectPathFor,
      sessionWorkspaceCwdFor: (sessionId) =>
        sessions.find((session) => session?.id === sessionId)?.workspace?.cwd || null,
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
