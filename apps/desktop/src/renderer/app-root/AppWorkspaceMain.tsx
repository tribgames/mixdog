import type React from 'react';
import type { DesktopModelSelection, DesktopWorkflowState } from '../../shared/contract';
import type { NavigationSelection } from '../navigation';
import { PaneWorkspace } from '../PaneWorkspace';
import { WorkspaceEmptyState } from '../WorkspaceEmptyState';
import { DraftConversation } from '../app-snapshot-views';
import { StableSessionTitle } from '../app-shell-components';
import { desktopFeatureEnabled } from '../desktop-feature-config';
import { t } from '../i18n';
import type { usePaneWorkspace } from '../pane-workspace-state';
import type { useAppSessionTitle } from '../app-shell-session-title';
import type { useAppProjectCatalog } from '../use-app-project-catalog';
import type { useAppSubmitRouting } from '../use-app-submit-routing';
import type { useDraftPanePreferences } from '../use-draft-pane-preferences';
import type { useAppPaneChrome } from '../use-app-pane-chrome';
import type { useAppPersistentPaneSurfaces } from '../use-app-persistent-pane-surfaces';
import type { useDesktopState } from '../app-desktop-state';
import type { useAppShellPanels } from '../use-app-shell-panels';
import type { useAppSettingsRouter } from './use-app-settings-router';
import type { useAppWorkbenchViews } from './use-app-workbench-views';

export interface AppWorkspaceMainProps {
  navigationSelection: NavigationSelection;
  visibleSessionTitle: string;
  selectedSession: ReturnType<typeof useAppSessionTitle>['selectedSession'];
  headerTitleEditingSessionId: string;
  headerTitleDraft: string;
  headerTitleInvalid: boolean;
  openHeaderTitleEditor: () => void;
  setHeaderTitleDraft: (draft: string) => void;
  commitHeaderTitleEditor: () => void;
  closeHeaderTitleEditor: () => void;
  activeProjectLabel: string;

  transcriptRendererPending: boolean;
  invokeResult: <T>(action: () => T | Promise<T>) => Promise<T | undefined>;
  errors: string[];
  submit: ReturnType<typeof useAppSubmitRouting>['submit'];
  applySnapshot: ReturnType<typeof useDesktopState>['applySnapshot'];
  composerFocusRequest: number;

  conversationNewTask: () => void;
  conversationClearToNewTask: (sessionId: string) => void;
  conversationClearProject: () => void;
  conversationResumeSession: (sessionId: string) => void;
  openSidebar: () => void;
  conversationOpenProjects: () => void;
  openSettings: ReturnType<typeof useAppSettingsRouter>['openSettings'];

  projects: ReturnType<typeof useAppProjectCatalog>['projects'];
  selection: NavigationSelection;
  newTaskModelSelection: DesktopModelSelection | null;
  newTaskWorkflow: DesktopWorkflowState | null;
  newTaskOrchestrationMode: ReturnType<typeof useDraftPanePreferences>['newTaskOrchestrationMode'];
  stageNewTaskModelSelection: ReturnType<typeof useDraftPanePreferences>['stageNewTaskModelSelection'];
  rememberSessionRouteForNextTask: ReturnType<typeof useDraftPanePreferences>['rememberSessionRouteForNextTask'];
  stageNewTaskWorkflow: ReturnType<typeof useDraftPanePreferences>['stageNewTaskWorkflow'];
  stageNewTaskOrchestrationMode: ReturnType<typeof useDraftPanePreferences>['stageNewTaskOrchestrationMode'];
  activeProjectPath: string;
  conversationSelectProject: (path: string) => void;
  openFileTab: (project: string, rel: string, line?: number) => void;
  openConversationCommandSurface: ReturnType<typeof useAppShellPanels>['openConversationCommandSurface'];

  paneWorkspace: ReturnType<typeof usePaneWorkspace>;
  observedAgentSessionIds: readonly string[];
  paneStripFor: ReturnType<typeof useAppPaneChrome>['paneStripFor'];
  paneConversationSurface: (
    paneSelection: NavigationSelection,
    focused: boolean,
    focusPane: () => void,
    leafId: string
  ) => React.ReactElement;
  paneFileEditors: ReturnType<typeof useAppPersistentPaneSurfaces>['paneFileEditors'];
  paneUtilityTabs: ReturnType<typeof useAppPersistentPaneSurfaces>['paneUtilityTabs'];
  renderPaneSideDock: ReturnType<typeof useAppWorkbenchViews>['renderPaneSideDock'];
  renderPaneProblems: ReturnType<typeof useAppWorkbenchViews>['renderPaneProblems'];
  activatePaneSurface: ReturnType<typeof useAppPaneChrome>['activatePaneSurface'];
  openDroppedPaths: (leafId: string, paths: string[]) => Promise<void>;
}

export function AppWorkspaceMain({
  navigationSelection,
  visibleSessionTitle,
  selectedSession,
  headerTitleEditingSessionId,
  headerTitleDraft,
  headerTitleInvalid,
  openHeaderTitleEditor,
  setHeaderTitleDraft,
  commitHeaderTitleEditor,
  closeHeaderTitleEditor,
  activeProjectLabel,
  transcriptRendererPending,
  invokeResult,
  errors,
  submit,
  applySnapshot,
  composerFocusRequest,
  conversationNewTask,
  conversationClearToNewTask,
  conversationClearProject,
  conversationResumeSession,
  openSidebar,
  conversationOpenProjects,
  openSettings,
  projects,
  selection,
  newTaskModelSelection,
  newTaskWorkflow,
  newTaskOrchestrationMode,
  stageNewTaskModelSelection,
  rememberSessionRouteForNextTask,
  stageNewTaskWorkflow,
  stageNewTaskOrchestrationMode,
  activeProjectPath,
  conversationSelectProject,
  openFileTab,
  openConversationCommandSurface,
  paneWorkspace,
  observedAgentSessionIds,
  paneStripFor,
  paneConversationSurface,
  paneFileEditors,
  paneUtilityTabs,
  renderPaneSideDock,
  renderPaneProblems,
  activatePaneSurface,
  openDroppedPaths,
}: AppWorkspaceMainProps) {
  const workspaceSurface = (
    <div className="workspace">
      <header className="session-header" aria-label={t('Current task')}>
        <div className="session-header-content">
          <h1 data-tooltip={visibleSessionTitle}>
            {selectedSession ? (
              <StableSessionTitle
                title={visibleSessionTitle}
                editing={headerTitleEditingSessionId === selectedSession.id}
                draft={headerTitleDraft}
                invalid={headerTitleInvalid}
                onOpen={openHeaderTitleEditor}
                onDraftChange={setHeaderTitleDraft}
                onCommit={commitHeaderTitleEditor}
                onCancel={closeHeaderTitleEditor}
              />
            ) : (
              visibleSessionTitle
            )}
          </h1>
          {navigationSelection.kind === 'session' && activeProjectLabel && (
            <span className="session-project-badge">{activeProjectLabel}</span>
          )}
        </div>
      </header>
      <DraftConversation
        transcriptPending={transcriptRendererPending}
        invokeResult={invokeResult}
        errors={errors}
        submit={submit}
        applySnapshot={applySnapshot}
        transitioning={false}
        composerFocusRequest={composerFocusRequest}
        onNewTask={conversationNewTask}
        onClearToNewTask={conversationClearToNewTask}
        onClearProject={conversationClearProject}
        onResumeSession={conversationResumeSession}
        onOpenSessions={desktopFeatureEnabled('sessions') ? openSidebar : () => {}}
        onOpenProjects={conversationOpenProjects}
        onOpenSettings={openSettings}
        projects={projects}
        showProjectSelector={selection.kind === 'new'}
        draftMode={selection.kind === 'new'}
        draftId={selection.kind === 'new' ? selection.draftId || 'default' : ''}
        draftModelSelection={newTaskModelSelection}
        draftWorkflow={newTaskWorkflow}
        draftOrchestrationMode={newTaskOrchestrationMode}
        onDraftModelSelection={selection.kind === 'new' ? stageNewTaskModelSelection : undefined}
        onRoutePreferenceApplied={rememberSessionRouteForNextTask}
        onDraftWorkflow={selection.kind === 'new' ? stageNewTaskWorkflow : undefined}
        onDraftOrchestrationMode={selection.kind === 'new' ? stageNewTaskOrchestrationMode : undefined}
        activeProjectPath={activeProjectPath}
        activeProjectLabel={activeProjectLabel}
        onSelectProject={conversationSelectProject}
        onOpenFile={openFileTab}
        onOpenCommandSurface={openConversationCommandSurface}
      />
    </div>
  );

  return (
    <PaneWorkspace
      workspace={paneWorkspace}
      observedSessionIds={observedAgentSessionIds}
      renderStrip={paneStripFor}
      renderConversation={paneConversationSurface}
      renderFileEditors={paneFileEditors}
      renderUtilityTabs={paneUtilityTabs}
      renderSideDock={renderPaneSideDock}
      renderProblems={renderPaneProblems}
      onFocusSelection={activatePaneSurface}
      onOpenDroppedPaths={openDroppedPaths}
      renderActive={(leaf) => (leaf.tabs.length === 0 ? <WorkspaceEmptyState /> : workspaceSurface)}
    />
  );
}
