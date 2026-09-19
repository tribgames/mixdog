import type React from 'react';
import type { DesktopModelSelection } from '../../shared/contract';
import { sessionSummaryTitle } from '../../shared/session-title.mjs';
import type { NavigationSelection } from '../navigation';
import { AppConversationPaneSurface } from '../app-conversation-pane-surfaces';
import { StableSessionTitle } from '../app-shell-components';
import type { ConversationHandoff } from '../use-pane-tab-close';
import type { DraftPanePrefs, useDraftPanePreferences } from '../use-draft-pane-preferences';
import type { useSessionCatalog } from '../app-session-catalog';
import type { useAppSessionTitle } from '../app-shell-session-title';
import type { useAppProjectCatalog } from '../use-app-project-catalog';
import type { useAppSubmitRouting } from '../use-app-submit-routing';
import type { useDesktopState } from '../app-desktop-state';
import type { useAppShellPanels } from '../use-app-shell-panels';
import type { useAppSettingsRouter } from './use-app-settings-router';
import type { applySessionLaneResult } from './use-app-task-lifecycle';

export interface PaneConversationRendererOptions {
  conversationHandoff: ConversationHandoff | null;
  resolvedDraftPrefsFor: (draftKey: string) => DraftPanePrefs;
  sessions: ReturnType<typeof useSessionCatalog>['sessions'];
  registeredProjectPath: (path: string) => string;
  projectChromeLabel: (path: string) => string;

  selectedSession: ReturnType<typeof useAppSessionTitle>['selectedSession'];
  headerTitleEditingSessionId: string;
  headerTitleDraft: string;
  headerTitleInvalid: boolean;
  openHeaderTitleEditor: () => void;
  setHeaderTitleDraft: (draft: string) => void;
  commitHeaderTitleEditor: () => void;
  closeHeaderTitleEditor: () => void;

  paneTranscriptRendererPending: boolean;
  requestedSessionId: string;
  invokeResult: <T>(action: () => T | Promise<T>) => Promise<T | undefined>;
  errors: string[];
  paneSubmitFor: ReturnType<typeof useAppSubmitRouting>['paneSubmitFor'];
  paneDraftSubmitFor: ReturnType<typeof useAppSubmitRouting>['paneDraftSubmitFor'];
  submit: ReturnType<typeof useAppSubmitRouting>['submit'];
  applySessionLaneResult: typeof applySessionLaneResult;
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
  stageNewTaskModelSelection: ReturnType<typeof useDraftPanePreferences>['stageNewTaskModelSelection'];
  rememberSessionRouteForNextTask: ReturnType<typeof useDraftPanePreferences>['rememberSessionRouteForNextTask'];
  stageNewTaskWorkflow: ReturnType<typeof useDraftPanePreferences>['stageNewTaskWorkflow'];
  stageNewTaskOrchestrationMode: ReturnType<typeof useDraftPanePreferences>['stageNewTaskOrchestrationMode'];
  conversationSelectProject: (path: string) => void;
  openConversationCommandSurface: ReturnType<typeof useAppShellPanels>['openConversationCommandSurface'];
  openFileTab: (project: string, rel: string) => void;
  replaceWithInheritedSession: (sessionId: string, route: DesktopModelSelection) => Promise<void>;
}

export function createPaneConversationRenderer(options: PaneConversationRendererOptions) {
  return function renderPaneConversation(
    paneSelection: NavigationSelection,
    focused: boolean,
    focusPane: () => void,
    leafId: string
  ): React.ReactElement {
    const activeHandoff = options.conversationHandoff?.leafId === leafId ? options.conversationHandoff : null;
    const presentedSelection = activeHandoff?.selection ?? paneSelection;
    const paneSessionId = presentedSelection.kind === 'session' ? presentedSelection.id : '';
    const draftKey = presentedSelection.kind === 'new' ? presentedSelection.draftId || 'default' : '';
    const prefs = options.resolvedDraftPrefsFor(draftKey);
    const sessionRow = paneSessionId ? options.sessions.find((row) => row?.id === paneSessionId) : undefined;
    const paneProjectPath = paneSessionId
      ? options.registeredProjectPath(sessionRow?.projectPath || '')
      : prefs.projectPath || '';
    const paneProjectLabel = options.projectChromeLabel(paneProjectPath);
    const pinnedPaneTitle = presentedSelection.kind === 'session' ? String(presentedSelection.title || '').trim() : '';
    let paneTitle = 'New task';
    if (paneSessionId) {
      if (pinnedPaneTitle) {
        paneTitle = pinnedPaneTitle;
      } else if (sessionRow) {
        paneTitle = sessionSummaryTitle(sessionRow);
      } else {
        paneTitle = 'Untitled session';
      }
    }
    const focusedDraft = focused && Boolean(draftKey);
    const focusedSession = focused && Boolean(paneSessionId);

    let submit = options.submit;
    if (paneSessionId) {
      submit = options.paneSubmitFor(paneSessionId);
    } else if (presentedSelection.kind === 'new') {
      submit = options.paneDraftSubmitFor(presentedSelection, leafId);
    }

    return (
      <AppConversationPaneSurface
        focused={focused}
        focusPane={focusPane}
        handoffActive={Boolean(activeHandoff)}
        title={paneTitle}
        projectLabel={paneSessionId ? paneProjectLabel : ''}
        titleContent={
          focusedSession && options.selectedSession ? (
            <StableSessionTitle
              title={paneTitle}
              editing={options.headerTitleEditingSessionId === options.selectedSession.id}
              draft={options.headerTitleDraft}
              invalid={options.headerTitleInvalid}
              onOpen={options.openHeaderTitleEditor}
              onDraftChange={options.setHeaderTitleDraft}
              onCommit={options.commitHeaderTitleEditor}
              onCancel={options.closeHeaderTitleEditor}
            />
          ) : (
            paneTitle
          )
        }
        conversationProps={{
          focused,
          sessionId: paneSessionId,
          hidden: false,
          transcriptPending: Boolean(paneSessionId) && options.paneTranscriptRendererPending,
          reconcileOnMount: paneSessionId !== options.requestedSessionId,
          invokeResult: options.invokeResult,
          errors: options.errors,
          submit,
          applySnapshot: paneSessionId
            ? (next) => options.applySessionLaneResult(paneSessionId, next)
            : options.applySnapshot,
          transitioning: false,
          composerFocusRequest: focused ? options.composerFocusRequest : 0,
          onNewTask: options.conversationNewTask,
          onClearToNewTask: options.conversationClearToNewTask,
          onClearProject: options.conversationClearProject,
          onResumeSession: options.conversationResumeSession,
          onOpenSessions: options.openSidebar,
          onOpenProjects: options.conversationOpenProjects,
          onOpenSettings: options.openSettings,
          projects: options.projects,
          showProjectSelector: Boolean(draftKey),
          draftMode: Boolean(draftKey),
          draftId: draftKey,
          draftModelSelection: draftKey ? prefs.modelSelection : undefined,
          draftWorkflow: draftKey ? prefs.workflow : undefined,
          draftOrchestrationMode: draftKey ? prefs.orchestrationMode : undefined,
          onDraftModelSelection: focusedDraft ? options.stageNewTaskModelSelection : undefined,
          onRoutePreferenceApplied: options.rememberSessionRouteForNextTask,
          onDraftWorkflow: focusedDraft ? options.stageNewTaskWorkflow : undefined,
          onDraftOrchestrationMode: focusedDraft ? options.stageNewTaskOrchestrationMode : undefined,
          activeProjectPath: paneProjectPath,
          activeProjectLabel: paneProjectLabel,
          onSelectProject: options.conversationSelectProject,
          onOpenCommandSurface: (surface) => options.openConversationCommandSurface(surface, paneSessionId),
          onOpenFile: (project, rel) => {
            focusPane();
            options.openFileTab(project, rel);
          },
          onInheritSession: options.replaceWithInheritedSession,
        }}
      />
    );
  };
}
