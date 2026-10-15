import { useCallback, useState } from 'react';
import { usePaneTypingFocus } from '../use-composer-focus';
import { useDraftPanePreferences } from '../use-draft-pane-preferences';
import { useUnreadSessions } from '../app-unread-sessions';
import { useSessionCatalog } from '../app-session-catalog';
import { useAppOnboarding } from '../use-app-boot';
import { useAppFrameEntryIntake } from './app-frame-entry-intake';
import { useAppFrameNavigationState } from './app-frame-navigation-state';
import { useAppFrameBootEffects } from './app-frame-boot-effects';
import { useSidebarFocusRestore } from './use-sidebar-focus-restore';
import { useAppInvocation } from './use-app-invocation';
import type { AppWorkspaceShell } from './use-app-workspace-shell';

/** Selection/navigation state, draft-pane preferences, boot flags, invocation and the session catalog. */
export function useAppNavigationShell(shell: AppWorkspaceShell) {
  const {
    startupNavigationSelection,
    snapshot,
    projectCatalog,
    paneWorkspace,
    focusedPaneSelection,
    shellPanels,
    error,
    connected,
    setError,
    sideDocks,
    focusedLeafIdRef,
  } = shell;
  const { projectCatalogValidated, preferredDraftProjectPath, effectiveDraftProjectPath } = projectCatalog;
  const { applySidebarOpen, setSettingsOpen, sidebarOpen, trackSidebarPanelModule } = shellPanels;
  const { paneSideDocks } = sideDocks;

  const {
    selection,
    setSelection,
    selectionRef,
    requestedSessionId,
    setRequestedSessionId,
    pendingConversationHandoff,
    conversationHandoff,
    setConversationHandoff,
    openSessionRef,
    navigationEpoch,
    viewedSessionRef,
    unreadViewedSessionRef,
    sidebarSelection,
  } = useAppFrameNavigationState(startupNavigationSelection);

  const {
    clearNewTaskPreferences,
    draftPanePrefs,
    inheritedDraftPrefs,
    lastNewTaskPrefs,
    newTaskDeferred,
    newTaskModelSelection,
    newTaskProjectPath,
    newTaskWorkflow,
    newTaskOrchestrationMode,
    persistDraftPanePrefs,
    rememberSessionRouteForNextTask,
    resetNewTaskDraft,
    resolvedDraftPrefsFor,
    setDraftPrefsVersion,
    setNewTaskDeferred,
    stageNewTaskModelSelection,
    stageNewTaskProject,
    stageNewTaskWorkflow,
    stageNewTaskOrchestrationMode,
  } = useDraftPanePreferences({
    selection,
    selectionRef,
    snapshot,
    projectCatalogValidated,
    preferredDraftProjectPath,
    effectiveDraftProjectPath,
  });
  const [sessionCatalogReady, setSessionCatalogReady] = useState(false);
  const [startupSettled, setStartupSettled] = useState(() =>
    Boolean((window as typeof window & { __mixdogStartupSettled?: boolean }).__mixdogStartupSettled)
  );
  useAppFrameEntryIntake({ sessionCatalogReady, openSessionRef, paneWorkspace });
  const [composerFocusRequest, setComposerFocusRequest] = useState(0);
  usePaneTypingFocus(paneWorkspace.focusedLeafId, focusedPaneSelection?.kind);
  useAppFrameBootEffects(startupSettled, trackSidebarPanelModule);
  const { onboardingOpen, setOnboardingOpen, onboardingReady } = useAppOnboarding(setSettingsOpen);
  useSidebarFocusRestore(sidebarOpen);

  const { invokeResult, invoke, errors } = useAppInvocation({ error, connected, setError });

  const closeSidebarForNavigation = useCallback(
    (motion: 'animated' | 'instant' = 'animated') => {
      if (window.innerWidth <= 760) {
        applySidebarOpen(false, motion);
        paneSideDocks.setOpen(focusedLeafIdRef.current, false);
      }
    },
    [applySidebarOpen, paneSideDocks]
  );

  const sessionCatalog = useUnreadSessionCatalog(unreadViewedSessionRef);

  return {
    selection,
    setSelection,
    selectionRef,
    requestedSessionId,
    setRequestedSessionId,
    pendingConversationHandoff,
    conversationHandoff,
    setConversationHandoff,
    openSessionRef,
    navigationEpoch,
    viewedSessionRef,
    unreadViewedSessionRef,
    sidebarSelection,
    clearNewTaskPreferences,
    draftPanePrefs,
    inheritedDraftPrefs,
    lastNewTaskPrefs,
    newTaskDeferred,
    newTaskModelSelection,
    newTaskProjectPath,
    newTaskWorkflow,
    newTaskOrchestrationMode,
    persistDraftPanePrefs,
    rememberSessionRouteForNextTask,
    resetNewTaskDraft,
    resolvedDraftPrefsFor,
    setDraftPrefsVersion,
    setNewTaskDeferred,
    stageNewTaskModelSelection,
    stageNewTaskProject,
    stageNewTaskWorkflow,
    stageNewTaskOrchestrationMode,
    sessionCatalogReady,
    setSessionCatalogReady,
    startupSettled,
    setStartupSettled,
    composerFocusRequest,
    setComposerFocusRequest,
    onboardingOpen,
    setOnboardingOpen,
    onboardingReady,
    invokeResult,
    invoke,
    errors,
    closeSidebarForNavigation,
    ...sessionCatalog,
  };
}

/** Unread-session dots and the sidebar session catalog they reconcile against. */
function useUnreadSessionCatalog(unreadViewedSessionRef: Parameters<typeof useUnreadSessions>[0]['viewedSessionRef']) {
  const { unreadSessionIds, reconcileUnreadSessions, consumeUnread } = useUnreadSessions({
    viewedSessionRef: unreadViewedSessionRef,
  });

  // Sidebar catalog state, optimistic rename/archive/delete overlay, push + poll
  // freshness: app-session-catalog.ts.
  const {
    sessions,
    setSessions,
    stageCreatedSession,
    refreshSessions,
    pendingRenames: pendingSessionRenames,
    pendingArchives: pendingSessionArchives,
    pendingDeletes: pendingSessionDeletes,
    invalidateInFlight: invalidateSessionListings,
    subscribeRemoved: subscribeSessionsRemoved,
  } = useSessionCatalog(reconcileUnreadSessions);

  return {
    unreadSessionIds,
    consumeUnread,
    sessions,
    setSessions,
    stageCreatedSession,
    refreshSessions,
    pendingSessionRenames,
    pendingSessionArchives,
    pendingSessionDeletes,
    invalidateSessionListings,
    subscribeSessionsRemoved,
  };
}

export type AppNavigationShell = ReturnType<typeof useAppNavigationShell>;
