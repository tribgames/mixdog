import type React from 'react';
import type { DesktopModelSelection } from '../../shared/contract';
import { displaySessionTitle, sessionDisplayTitle } from '../session-display-title';
import { t } from '../i18n';
import { chatLinkMainTabMode, getLinkPreview } from '../link-preview-preference';
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

interface PaneConversationRendererOptions {
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
  openFileTab: (
    project: string,
    rel: string,
    line?: number,
    accessToken?: string,
    recordHistory?: boolean,
    mode?: 'preview' | 'pinned'
  ) => void;
  /** Opens a transcript file link in the pane's side dock; absent where the
   *  surface has no dock, so links keep opening main tabs. */
  openFileInSideDock?: (
    leafId: string,
    project: string,
    rel: string,
    line?: number,
    accessToken?: string,
    column?: number
  ) => void;
  /** Reveals a transcript folder link in the pane's side-dock Files tree;
   *  absent where the surface has no dock. */
  openFolderInSideDock?: (leafId: string, project: string, rel: string) => void;
  /** Opens the pane's side dock on the session diff (the composer island's
   *  files segment); absent where the surface has no dock. */
  openSessionDiffInSideDock?: (leafId: string) => void;
  /** Opens an agent's session (the composer island's jobs panel rows). */
  openAgentSession: (sessionId: string, title: string, ownerSessionId: string) => void;
  replaceWithInheritedSession: (sessionId: string, route: DesktopModelSelection) => Promise<void>;
}

/** The side-dock open routes a renderer offers transcript links and editors:
 *  every surface with a right side layout — the phone/web renderer's
 *  full-screen sheet included — opens files, folders and the session diff
 *  in the pane's side dock, exactly like the PC. Without one,
 *  none are offered and links keep opening main tabs. */
export function paneSideDockLinkRoutes<T extends object>(rightGroups: readonly unknown[], routes: T): Partial<T> {
  return rightGroups.length > 0 ? routes : {};
}

/** What a pane's conversation routes read when they fire: the render that
 *  last drew the pane. */
interface PaneRouteTarget {
  options: PaneConversationRendererOptions;
  leafId: string;
  paneSessionId: string;
  focusPane: () => void;
}

/** One set of conversation routes per pane and session. The
 *  renderer runs on every App commit (a session switch is several) and its
 *  closures were fresh each time, so the memoised PaneConversation re-rendered
 *  the outgoing pane on the switch's first commit with nothing to change.
 *  Each route calls the target the latest render recorded. */
interface PaneRoutes {
  target: PaneRouteTarget;
  applySessionLane: (next: Parameters<PaneConversationRendererOptions['applySnapshot']>[0]) => void;
  openSessions: () => void;
  openCommandSurface: (
    surface: Parameters<PaneConversationRendererOptions['openConversationCommandSurface']>[0]
  ) => void;
  openFile: (project: string, rel: string, line?: number, accessToken?: string, column?: number) => void;
  openFolder: (project: string, rel: string) => void;
  openSessionDiff: () => void;
  openAgentSession: (sessionId: string, title: string, ownerSessionId: string) => void;
}

const paneRoutes = new Map<string, PaneRoutes>();
const PANE_ROUTES_MAX = 64;

function paneRoutesFor(target: PaneRouteTarget): PaneRoutes {
  // Per pane AND session: a pane may draw retained sessions beside its shown
  // one, each with its own routes.
  const key = `${target.leafId}\u0000${target.paneSessionId}`;
  const known = paneRoutes.get(key);
  if (known) {
    known.target = target;
    // Most recently drawn last: eviction takes panes and sessions long gone.
    paneRoutes.delete(key);
    paneRoutes.set(key, known);
    return known;
  }
  const routes: PaneRoutes = {
    target,
    applySessionLane: (next) => {
      const { options, paneSessionId } = routes.target;
      options.applySessionLaneResult(paneSessionId, next);
    },
    openSessions: () => routes.target.options.openSidebar(),
    openCommandSurface: (surface) => {
      const { options, paneSessionId } = routes.target;
      options.openConversationCommandSurface(surface, paneSessionId);
    },
    // A chat link carries its line and, for files outside the Project,
    // its file-scoped access token. Dropping either opened the file at
    // line 1, or failed to open it at all.
    openFile: (project, rel, line, accessToken, column) => {
      const { options, leafId, focusPane } = routes.target;
      focusPane();
      if (options.openFileInSideDock) {
        if (column) options.openFileInSideDock(leafId, project, rel, line, accessToken, column);
        else options.openFileInSideDock(leafId, project, rel, line, accessToken);
      } else {
        // No right side layout: a main tab, the preview one under Link preview.
        options.openFileTab(project, rel, line, accessToken, true, chatLinkMainTabMode(getLinkPreview()));
      }
    },
    openFolder: (project, rel) => {
      const { options, leafId, focusPane } = routes.target;
      focusPane();
      options.openFolderInSideDock?.(leafId, project, rel);
    },
    openSessionDiff: () => {
      const { options, leafId, focusPane } = routes.target;
      focusPane();
      options.openSessionDiffInSideDock?.(leafId);
    },
    openAgentSession: (sessionId, title, ownerSessionId) => {
      const { options, focusPane } = routes.target;
      focusPane();
      options.openAgentSession(sessionId, title, ownerSessionId);
    },
  };
  paneRoutes.set(key, routes);
  for (const oldest of paneRoutes.keys()) {
    if (paneRoutes.size <= PANE_ROUTES_MAX) break;
    paneRoutes.delete(oldest);
  }
  return routes;
}

export function createPaneConversationRenderer(options: PaneConversationRendererOptions) {
  return function renderPaneConversation(
    paneSelection: NavigationSelection,
    focused: boolean,
    focusPane: () => void,
    leafId: string,
    warm = false,
    visible = true
  ): React.ReactElement {
    // A warm (retained) surface already shows its own session; a close
    // handoff presents the closed one only in the pane's cold surface.
    const activeHandoff = !warm && options.conversationHandoff?.leafId === leafId ? options.conversationHandoff : null;
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
    let paneTitle = t('New task');
    if (paneSessionId) {
      if (pinnedPaneTitle) {
        paneTitle = displaySessionTitle(pinnedPaneTitle);
      } else if (sessionRow) {
        paneTitle = sessionDisplayTitle(sessionRow, t('Untitled session'));
      } else {
        paneTitle = t('Untitled session');
      }
    }
    const focusedDraft = focused && Boolean(draftKey);
    const focusedSession = focused && Boolean(paneSessionId);

    const routes = paneRoutesFor({ options, leafId, paneSessionId, focusPane });
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
          surfaceVisible: visible,
          transcriptPending: Boolean(paneSessionId) && options.paneTranscriptRendererPending,
          reconcileOnMount: paneSessionId !== options.requestedSessionId,
          invokeResult: options.invokeResult,
          errors: options.errors,
          submit,
          applySnapshot: paneSessionId ? routes.applySessionLane : options.applySnapshot,
          transitioning: false,
          composerFocusRequest: focused ? options.composerFocusRequest : 0,
          onNewTask: options.conversationNewTask,
          onClearToNewTask: options.conversationClearToNewTask,
          onClearProject: options.conversationClearProject,
          onResumeSession: options.conversationResumeSession,
          onOpenSessions: routes.openSessions,
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
          onOpenCommandSurface: routes.openCommandSurface,
          onOpenFile: routes.openFile,
          onOpenFolder: options.openFolderInSideDock ? routes.openFolder : undefined,
          onOpenSessionDiff: options.openSessionDiffInSideDock ? routes.openSessionDiff : undefined,
          onOpenAgentSession: routes.openAgentSession,
          onInheritSession: options.replaceWithInheritedSession,
        }}
      />
    );
  };
}
