import type React from 'react';
import { DESKTOP_WORKSPACE_MIN_WIDTH } from '../../shared/window-layout';
import { DesktopTitlebar } from '../navigation';
import { DesktopBootGate } from '../PaneSurfaceGate';
import { RemoteConnectionBanner } from '../RemoteConnectionBanner';
import { SessionBrowserParkingHost } from '../session-browser-surfaces';
import { SessionTerminalParkingHost } from '../session-terminal-surfaces';
import { PanelBackdrop, SidebarBackdrop } from './app-backdrops';
import { AppShellOverlays } from './AppShellOverlays';
import { AppWorkspaceMain } from './AppWorkspaceMain';
import { AppSidebarDrawer } from './AppSidebarDrawer';
import type { useAppWorkbenchViews } from './use-app-workbench-views';
import type { AppWorkspaceShell } from './use-app-workspace-shell';
import type { AppNavigationShell } from './use-app-navigation-shell';
import type { AppSessionLifecycle } from './use-app-session-lifecycle';
import type { AppSessionCommands } from './use-app-session-commands';
import type { AppSelectionContext } from './use-app-selection-context';
import type { AppTabWorkflow } from './use-app-tab-workflow';
import type { AppWorkbenchHubs } from './use-app-workbench-hubs';
import type { useAppPaneSurfaces } from './use-app-pane-surfaces';

export type AppShellLayoutProps = {
  shell: AppWorkspaceShell;
  nav: AppNavigationShell;
  lifecycle: AppSessionLifecycle;
  commands: AppSessionCommands;
  context: AppSelectionContext;
  tabWorkflow: AppTabWorkflow;
  hubs: AppWorkbenchHubs;
  surfaces: ReturnType<typeof useAppPaneSurfaces>;
  views: ReturnType<typeof useAppWorkbenchViews>;
};

/** The desktop shell markup: titlebar, sidebar drawer, main workspace, parking hosts and overlays. */
export function AppShellLayout({
  shell,
  nav,
  lifecycle,
  commands,
  context,
  tabWorkflow,
  hubs,
  surfaces,
  views,
}: AppShellLayoutProps) {
  const { shellPanels, sideDocks, paneWorkspace, sessionPaneSurfaces, projectCatalog, applySnapshot } = shell;
  const { sidebarOpen, applySidebarOpen, mainPanelRef, bottomPanel, openSidebar, openConversationCommandSurface } =
    shellPanels;
  const { workbenchSideLayout, activeSideViews, sidebarDiff, closeSidebarDiff } = sideDocks;
  const {
    onboardingOpen,
    onboardingReady,
    closeSidebarForNavigation,
    invokeResult,
    errors,
    composerFocusRequest,
    newTaskModelSelection,
    newTaskWorkflow,
    newTaskOrchestrationMode,
    stageNewTaskModelSelection,
    rememberSessionRouteForNextTask,
    stageNewTaskWorkflow,
    stageNewTaskOrchestrationMode,
  } = nav;
  const { taskLifecycle, updaterState, openDesktopUpdate } = lifecycle;
  const { openSettings } = commands;
  const {
    sessionTitle,
    navigationSelection,
    activeProjectLabel,
    transcriptRendererPending,
    submit,
    activeProjectPath,
  } = context;
  const { openFileTab, openDroppedPaths } = tabWorkflow;
  const {
    sideViewDescriptors,
    selectWorkbenchSideView,
    moveWorkbenchSideGroup,
    moveWorkbenchSideView,
    paneStripFor,
    activatePaneSurface,
    projectEditorHost,
    projectAddHost,
  } = hubs;
  const { paneConversationSurface, paneFileEditors, paneUtilityTabs, paneUtilitySurfacePortals, desktopBootReady } =
    surfaces;
  const { renderWorkbenchSideView, leftViewInputs, renderPaneSideDock, renderPaneProblems } = views;

  return (
    <DesktopBootGate restorePending={paneWorkspace.restorePending} ready={desktopBootReady}>
      <div
        className={`app-shell ${sidebarOpen && workbenchSideLayout.layout.left.length ? '' : 'sidebar-collapsed'}`}
        style={
          {
            '--desktop-workspace-min-width': `${DESKTOP_WORKSPACE_MIN_WIDTH}px`,
          } as React.CSSProperties
        }
      >
        <RemoteConnectionBanner />
        <DesktopTitlebar />
        <div className="desktop-body">
          <AppSidebarDrawer
            {...shellPanels}
            onboardingActive={onboardingOpen || !onboardingReady}
            closeSidebarForNavigation={closeSidebarForNavigation}
            openSettings={openSettings}
            updaterState={updaterState}
            openDesktopUpdate={openDesktopUpdate}
            workbenchSideLayout={workbenchSideLayout}
            sideViewDescriptors={sideViewDescriptors}
            activeSideViews={activeSideViews}
            selectWorkbenchSideView={selectWorkbenchSideView}
            moveWorkbenchSideGroup={moveWorkbenchSideGroup}
            moveWorkbenchSideView={moveWorkbenchSideView}
            renderWorkbenchSideView={renderWorkbenchSideView}
            leftViewInputs={leftViewInputs}
            sidebarDiff={sidebarDiff}
            closeSidebarDiff={closeSidebarDiff}
            openFileTab={openFileTab}
          />
          <SidebarBackdrop open={sidebarOpen} onClose={() => applySidebarOpen(false)} />
          <main className="main-panel" ref={mainPanelRef}>
            <AppWorkspaceMain
              {...taskLifecycle}
              {...sessionTitle}
              navigationSelection={navigationSelection}
              activeProjectLabel={activeProjectLabel}
              transcriptRendererPending={transcriptRendererPending}
              invokeResult={invokeResult}
              errors={errors}
              submit={submit}
              applySnapshot={applySnapshot}
              composerFocusRequest={composerFocusRequest}
              openSidebar={openSidebar}
              openSettings={openSettings}
              projects={projectCatalog.projects}
              newTaskModelSelection={newTaskModelSelection}
              newTaskWorkflow={newTaskWorkflow}
              newTaskOrchestrationMode={newTaskOrchestrationMode}
              stageNewTaskModelSelection={stageNewTaskModelSelection}
              rememberSessionRouteForNextTask={rememberSessionRouteForNextTask}
              stageNewTaskWorkflow={stageNewTaskWorkflow}
              stageNewTaskOrchestrationMode={stageNewTaskOrchestrationMode}
              activeProjectPath={activeProjectPath}
              openFileTab={openFileTab}
              openConversationCommandSurface={openConversationCommandSurface}
              paneWorkspace={paneWorkspace}
              observedAgentSessionIds={sessionTitle.observedAgentSessionIds}
              paneStripFor={paneStripFor}
              paneConversationSurface={paneConversationSurface}
              paneFileEditors={paneFileEditors}
              paneUtilityTabs={paneUtilityTabs}
              renderPaneSideDock={renderPaneSideDock}
              renderPaneProblems={renderPaneProblems}
              activatePaneSurface={activatePaneSurface}
              openDroppedPaths={openDroppedPaths}
            />
          </main>
          <SessionBrowserParkingHost controller={sessionPaneSurfaces.browserSurfaces} />
          <SessionTerminalParkingHost controller={sessionPaneSurfaces.terminalSurfaces} />
          <PanelBackdrop open={bottomPanel.open} onClose={() => bottomPanel.setOpen(false)} />
        </div>
        {paneUtilitySurfacePortals}
        {renderAppShellOverlays({ shell, nav, lifecycle, commands, tabWorkflow, hubs })}
        {projectEditorHost}
        {projectAddHost}
      </div>
    </DesktopBootGate>
  );
}

/** The shell overlays element (quick access, tab switcher, unsaved-close, settings, onboarding, update, errors). */
function renderAppShellOverlays({
  shell,
  nav,
  lifecycle,
  commands,
  tabWorkflow,
  hubs,
}: Pick<AppShellLayoutProps, 'shell' | 'nav' | 'lifecycle' | 'commands' | 'tabWorkflow' | 'hubs'>) {
  const {
    shellPanels,
    quickAccessMode,
    setQuickAccessMode,
    settingsMounted,
    settingsPrewarmed,
    error,
    connected,
    setError,
    snapshot,
  } = shell;
  const { sessions, onboardingOpen, setOnboardingOpen } = nav;
  const { taskLifecycle, updateDialogOpen, updaterState, closeDesktopUpdate, installDesktopUpdate } = lifecycle;
  const {
    openFileTab,
    pendingUnsavedClose,
    unsavedCloseBusy,
    unsavedCloseError,
    saveAndClosePendingTab,
    discardAndClosePendingTab,
    cancelPendingTabClose,
  } = tabWorkflow;
  const {
    quickAccessProjectPath,
    quickAccessRecentFiles,
    workbenchCommands,
    sidebarResumeSession,
    tabSwitcher,
    focusedLeafForShortcuts,
    stripTitleFor,
  } = hubs;

  return (
    <AppShellOverlays
      {...shellPanels}
      quickAccessMode={quickAccessMode}
      quickAccessProjectPath={quickAccessProjectPath}
      quickAccessRecentFiles={quickAccessRecentFiles}
      workbenchCommands={workbenchCommands}
      openFileTab={openFileTab}
      setQuickAccessMode={setQuickAccessMode}
      sessions={sessions}
      openSearchSession={sidebarResumeSession}
      tabSwitcher={tabSwitcher}
      focusedLeafForShortcuts={focusedLeafForShortcuts}
      stripTitleFor={stripTitleFor}
      pendingUnsavedClose={pendingUnsavedClose}
      unsavedCloseBusy={unsavedCloseBusy}
      unsavedCloseError={unsavedCloseError}
      saveAndClosePendingTab={saveAndClosePendingTab}
      discardAndClosePendingTab={discardAndClosePendingTab}
      cancelPendingTabClose={cancelPendingTabClose}
      settingsMounted={settingsMounted}
      settingsPrewarmed={settingsPrewarmed}
      openSettings={commands.openSettings}
      replaceWithInheritedSession={taskLifecycle.replaceWithInheritedSession}
      onboardingOpen={onboardingOpen}
      setOnboardingOpen={setOnboardingOpen}
      updateDialogOpen={updateDialogOpen}
      updaterState={updaterState}
      closeDesktopUpdate={closeDesktopUpdate}
      installDesktopUpdate={installDesktopUpdate}
      error={error}
      connected={connected}
      setError={setError}
      snapshot={snapshot}
    />
  );
}
