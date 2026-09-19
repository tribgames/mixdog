import type React from 'react';
import { useCallback, useEffect, useState } from 'react';
import type { DesktopModelSelection, DesktopWorkflowState, SessionSnapshot } from '../../shared/contract';
import { sessionSummaryTitle } from '../../shared/session-title.mjs';
import type { NavigationSelection, WorkspaceTab } from '../navigation';
import { canSplitPaneSize, type PaneLeaf } from '../pane-layout';
import type { usePaneWorkspace } from '../pane-workspace-state';
import { defaultSessionLaneStore } from '../session-lane-store';
import { asRecord, displayProject, navigationKey, newDraftSelection } from '../text-format';
import type { ConversationHandoff } from '../use-pane-tab-close';
import {
  draftModelSelectionFromSnapshot,
  resolvedStoredProjectPath,
  type DraftPanePrefs,
} from '../use-draft-pane-preferences';
import { inheritSessionInPlace } from '../app-session-inheritance';
import { useStableEvent } from '../use-stable-event';
import { desktopFeatureEnabled } from '../desktop-feature-config';
import { requestSessionRead } from '../app-snapshot-views';
import type { useSessionCatalog } from '../app-session-catalog';
import type { useAppProjectCatalog } from '../use-app-project-catalog';
import type { Snapshot } from '../desktop-types';
import type { useDesktopState } from '../app-desktop-state';
import type { useAppShellPanels } from '../use-app-shell-panels';

export const LAST_SESSION_KEY = 'mixdog.desktop-last-session.v1';

export function applySessionLaneResult(sessionId: string, next: SessionSnapshot | null): void {
  if (!sessionId || !next || typeof next !== 'object') return;
  const returnedSessionId = String((next as Snapshot).sessionId || '');
  if (returnedSessionId && returnedSessionId !== sessionId) return;
  defaultSessionLaneStore.apply({
    sessionId,
    snapshot: next,
    frameSource: 'live',
  });
}

export interface UseAppTaskLifecycleOptions {
  // The App owns the committed selection: draft-pane preferences read it
  // earlier in the same render, so it cannot live inside this hook.
  selection: NavigationSelection;
  setSelection: React.Dispatch<React.SetStateAction<NavigationSelection>>;
  selectionRef: React.MutableRefObject<NavigationSelection>;
  paneWorkspace: ReturnType<typeof usePaneWorkspace>;
  paneLeavesRef: React.MutableRefObject<readonly PaneLeaf[]>;
  focusedLeafIdRef: React.MutableRefObject<string>;
  viewedSessionRef: React.MutableRefObject<string>;
  unreadViewedSessionRef: React.MutableRefObject<string>;
  pendingConversationHandoff: React.MutableRefObject<ConversationHandoff | null>;
  setConversationHandoff: React.Dispatch<React.SetStateAction<ConversationHandoff | null>>;
  navigationEpoch: React.MutableRefObject<number>;
  setRequestedSessionId: React.Dispatch<React.SetStateAction<string>>;
  setComposerFocusRequest: React.Dispatch<React.SetStateAction<number>>;
  closeSidebarForNavigation: (motion?: 'animated' | 'instant') => void;
  newTaskDeferred: boolean;
  lastNewTaskPrefs: React.MutableRefObject<DraftPanePrefs | null>;
  effectiveDraftProjectPath: (path?: string | null) => string;
  preferredDraftProjectPath: string;
  resetNewTaskDraft: (projectPath: string | null) => void;
  draftPanePrefs: React.MutableRefObject<Map<string, DraftPanePrefs>>;
  inheritedDraftPrefs: () => DraftPanePrefs;
  persistDraftPanePrefs: () => void;
  setDraftPrefsVersion: React.Dispatch<React.SetStateAction<number>>;
  openSessionRef: React.MutableRefObject<(sessionId: string, force?: boolean) => Promise<void>>;
  openProjects: () => void;
  refreshProjects: () => Promise<unknown>;
  stageNewTaskProject: (path: string) => void;
  sessions: ReturnType<typeof useSessionCatalog>['sessions'];
  refreshSessions: ReturnType<typeof useSessionCatalog>['refreshSessions'];
  applySnapshot: ReturnType<typeof useDesktopState>['applySnapshot'];
  projects: ReturnType<typeof useAppProjectCatalog>['projects'];
  clearNewTaskPreferences: () => void;
  setCommandSurface: ReturnType<typeof useAppShellPanels>['setCommandSurface'];
  setCommandSurfaceSessionId: (id: string) => void;
}

export function useAppTaskLifecycle({
  selection,
  setSelection,
  selectionRef,
  paneWorkspace,
  paneLeavesRef,
  focusedLeafIdRef,
  viewedSessionRef,
  unreadViewedSessionRef,
  pendingConversationHandoff,
  setConversationHandoff,
  navigationEpoch,
  setRequestedSessionId,
  setComposerFocusRequest,
  closeSidebarForNavigation,
  newTaskDeferred,
  lastNewTaskPrefs,
  effectiveDraftProjectPath,
  preferredDraftProjectPath,
  resetNewTaskDraft,
  draftPanePrefs,
  inheritedDraftPrefs,
  persistDraftPanePrefs,
  setDraftPrefsVersion,
  openSessionRef,
  openProjects,
  refreshProjects,
  stageNewTaskProject,
  sessions,
  refreshSessions,
  applySnapshot,
  projects,
  clearNewTaskPreferences,
  setCommandSurface,
  setCommandSurfaceSessionId,
}: UseAppTaskLifecycleOptions) {
  const [tabs, setTabs] = useState<WorkspaceTab[]>([]);

  const {
    openInFocused: openSelectionInFocusedPane,
    promoteInLeaf: promoteSelectionInLeaf,
    splitFocused: splitFocusedPane,
  } = paneWorkspace;

  const registerWorkspaceSelection = useCallback(
    (nextSelection: NavigationSelection, title: string, replaceKey = '') => {
      const key = navigationKey(nextSelection);
      setTabs((current) => {
        const existing = current.findIndex((tab) => tab.key === key);
        if (replaceKey) {
          const replaced = current.findIndex((tab) => tab.key === replaceKey);
          if (replaced >= 0) {
            const next = [...current];
            next[replaced] = { key, title, selection: nextSelection };
            if (existing >= 0 && existing !== replaced) next.splice(existing, 1);
            return next;
          }
        }
        if (existing >= 0) {
          if (current[existing].title === title && navigationKey(current[existing].selection) === key) return current;
          const next = [...current];
          next[existing] = { key, title, selection: nextSelection };
          return next;
        }
        return [...current, { key, title, selection: nextSelection }];
      });
    },
    []
  );

  const activateSelection = useCallback(
    (nextSelection: NavigationSelection, title: string, replaceKey = '') => {
      try {
        window.mixdogDesktop?.perfLog?.(
          `selection-commit kind=${nextSelection.kind}` +
            ` target=${nextSelection.kind === 'session' ? nextSelection.id : '(none)'}`
        );
      } catch {
        /* diagnostics only */
      }
      try {
        if (nextSelection.kind === 'session') {
          window.localStorage.setItem(LAST_SESSION_KEY, nextSelection.id);
        } else {
          window.localStorage.removeItem(LAST_SESSION_KEY);
        }
      } catch {
        /* startup restoration remains best-effort */
      }
      selectionRef.current = nextSelection;
      viewedSessionRef.current = nextSelection.kind === 'session' ? nextSelection.id : '';
      unreadViewedSessionRef.current = viewedSessionRef.current;
      setSelection(nextSelection);
      openSelectionInFocusedPane(nextSelection, replaceKey);
      registerWorkspaceSelection(nextSelection, title, replaceKey);
    },
    [openSelectionInFocusedPane, registerWorkspaceSelection, viewedSessionRef, unreadViewedSessionRef]
  );

  useEffect(() => {
    const onPaneSplitKey = (event: globalThis.KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.key !== '\\') return;
      event.preventDefault();
      const fresh = newDraftSelection();
      const direction = event.shiftKey ? 'column' : 'row';
      const paneElement = Array.from(document.querySelectorAll<HTMLElement>('[data-pane-id]')).find(
        (element) => element.dataset.paneId === paneWorkspace.focusedLeafId
      );
      const rect = paneElement?.getBoundingClientRect();
      if (rect && !canSplitPaneSize(direction, rect.width, rect.height)) return;
      splitFocusedPane(direction, fresh, rect ? { width: rect.width, height: rect.height } : undefined);
      activateSelection(fresh, 'New task');
    };
    window.addEventListener('keydown', onPaneSplitKey);
    return () => window.removeEventListener('keydown', onPaneSplitKey);
  }, [activateSelection, paneWorkspace.focusedLeafId, splitFocusedPane]);

  const finishPendingConversationHandoff = useCallback(() => {
    if (!pendingConversationHandoff.current) return;
    pendingConversationHandoff.current = null;
    setConversationHandoff(null);
  }, [pendingConversationHandoff, setConversationHandoff]);

  const startTask = useCallback(
    (draft?: NavigationSelection, requestComposerFocus = true) => {
      closeSidebarForNavigation();
      navigationEpoch.current += 1;
      setRequestedSessionId('');
      finishPendingConversationHandoff();
      const alreadyActive = selectionRef.current.kind === 'new';
      const revisit = draft?.kind === 'new';
      const nextSelection = revisit && draft ? draft : newDraftSelection();
      activateSelection(nextSelection, 'New task');
      if (requestComposerFocus) setComposerFocusRequest((value) => value + 1);
      if (revisit || alreadyActive) return;
      if (newTaskDeferred && tabs.some((tab) => tab.selection.kind === 'new')) return;
      const cachedProjectPath = lastNewTaskPrefs.current?.projectPath ?? null;
      resetNewTaskDraft(
        cachedProjectPath === null
          ? effectiveDraftProjectPath(preferredDraftProjectPath) || null
          : resolvedStoredProjectPath(cachedProjectPath, effectiveDraftProjectPath)
      );
    },
    [
      activateSelection,
      closeSidebarForNavigation,
      effectiveDraftProjectPath,
      finishPendingConversationHandoff,
      lastNewTaskPrefs,
      navigationEpoch,
      newTaskDeferred,
      preferredDraftProjectPath,
      resetNewTaskDraft,
      setComposerFocusRequest,
      setRequestedSessionId,
      tabs,
    ]
  );

  const clearSessionToNewTask = useCallback(
    (sessionId: string) => {
      const sessionKey = navigationKey({ kind: 'session', id: sessionId });
      const leaves = paneLeavesRef.current;
      const ownerLeaf =
        leaves.find(
          (leaf) => leaf.id === focusedLeafIdRef.current && leaf.tabs.some((tab) => navigationKey(tab) === sessionKey)
        ) ?? leaves.find((leaf) => leaf.tabs.some((tab) => navigationKey(tab) === sessionKey));
      const source = defaultSessionLaneStore.get(sessionId);
      const inherited = inheritedDraftPrefs();
      const seeded: DraftPanePrefs = {
        projectPath: effectiveDraftProjectPath(
          String(source?.currentProject || source?.project || '') || inherited.projectPath
        ),
        modelSelection: (source ? draftModelSelectionFromSnapshot(source) : null) ?? inherited.modelSelection,
        workflow:
          (asRecord(source?.workflow) ? (source?.workflow as unknown as DesktopWorkflowState) : null) ??
          inherited.workflow,
        orchestrationMode: source?.orchestrationMode ?? inherited.orchestrationMode,
      };
      const draftSelection = newDraftSelection();
      const draftPrefsKey = draftSelection.kind === 'new' ? draftSelection.draftId || 'default' : 'default';
      draftPanePrefs.current.set(draftPrefsKey, seeded);
      lastNewTaskPrefs.current = seeded;
      persistDraftPanePrefs();
      setDraftPrefsVersion((value) => value + 1);
      navigationEpoch.current += 1;
      setRequestedSessionId('');
      finishPendingConversationHandoff();
      if (ownerLeaf && ownerLeaf.id !== focusedLeafIdRef.current) {
        promoteSelectionInLeaf(ownerLeaf.id, draftSelection, sessionKey);
        registerWorkspaceSelection(draftSelection, 'New task', sessionKey);
        return;
      }
      activateSelection(draftSelection, 'New task', ownerLeaf ? sessionKey : '');
      setComposerFocusRequest((value) => value + 1);
    },
    [
      activateSelection,
      draftPanePrefs,
      effectiveDraftProjectPath,
      finishPendingConversationHandoff,
      focusedLeafIdRef,
      inheritedDraftPrefs,
      lastNewTaskPrefs,
      navigationEpoch,
      paneLeavesRef,
      persistDraftPanePrefs,
      promoteSelectionInLeaf,
      registerWorkspaceSelection,
      setComposerFocusRequest,
      setDraftPrefsVersion,
      setRequestedSessionId,
    ]
  );

  const synchronizeActualHost = useCallback(async () => {
    const actual = (await window.mixdogDesktop?.getSnapshot().catch(() => null)) ?? null;
    applySnapshot(actual);
    const state = actual && typeof actual === 'object' ? (actual as Snapshot) : null;
    const actualProject = String(state?.currentProject || state?.project || '');
    const actualSessionId = String(state?.sessionId || '');
    const knownActualSession = actualSessionId && sessions.some((session) => session?.id === actualSessionId);
    if (knownActualSession) {
      const actualSession = sessions.find((session) => session?.id === actualSessionId);
      activateSelection({ kind: 'session', id: actualSessionId }, sessionSummaryTitle(actualSession));
    } else if (actualProject) {
      const project = projects.find((item) => item.path === actualProject);
      activateSelection(
        { kind: 'project', path: actualProject },
        project?.alias?.trim() || project?.name?.trim() || displayProject(actualProject).name || 'Project'
      );
    } else if (actualSessionId) {
      activateSelection({ kind: 'new' }, 'New task');
      clearNewTaskPreferences();
    } else {
      activateSelection({ kind: 'new' }, 'New task');
    }
  }, [activateSelection, applySnapshot, clearNewTaskPreferences, projects, sessions]);

  const conversationNewTask = useStableEvent(() => startTask());
  const conversationClearToNewTask = useStableEvent(clearSessionToNewTask);
  const conversationClearProject = useStableEvent(() => stageNewTaskProject(''));
  const conversationResumeSession = useStableEvent((sessionId: string) => {
    void openSessionRef.current(sessionId);
  });
  const conversationOpenProjects = useStableEvent(() => {
    if (!desktopFeatureEnabled('projects')) return;
    openProjects();
    void refreshProjects().catch(() => undefined);
  });
  const conversationSelectProject = useStableEvent((path: string) => {
    stageNewTaskProject(path);
  });

  const replaceWithInheritedSession = useStableEvent(async (sourceSessionId: string, route: DesktopModelSelection) => {
    const api = window.mixdogDesktop;
    if (typeof api?.inheritSession !== 'function') {
      throw new Error('Session inheritance is unavailable on this surface.');
    }
    await inheritSessionInPlace(sourceSessionId, route, {
      inherit: (id, sel) => api.inheritSession(id, sel),
      leaves: () => paneLeavesRef.current,
      focusedLeafId: () => focusedLeafIdRef.current,
      sourceTitle: () => {
        const row = sessions.find((entry) => entry?.id === sourceSessionId);
        return row
          ? sessionSummaryTitle(row)
          : tabs.find((tab) => tab.key === `session:${sourceSessionId}`)?.title || '';
      },
      refreshSessions,
      readSession: requestSessionRead,
      snapshot: (id) => defaultSessionLaneStore.get(id) as SessionSnapshot,
      prepare: applySessionLaneResult,
      replace: (leafId, sel, title, sourceKey, focused) => {
        if (focused) {
          navigationEpoch.current += 1;
          setRequestedSessionId('');
          finishPendingConversationHandoff();
          activateSelection(sel, title, sourceKey);
        } else {
          promoteSelectionInLeaf(leafId, sel, sourceKey);
          registerWorkspaceSelection(sel, title, sourceKey);
        }
      },
    });
    setCommandSurface(null);
    setCommandSurfaceSessionId('');
  });

  return {
    selection,
    selectionRef,
    setSelection,
    tabs,
    setTabs,
    registerWorkspaceSelection,
    activateSelection,
    finishPendingConversationHandoff,
    startTask,
    clearSessionToNewTask,
    synchronizeActualHost,
    conversationNewTask,
    conversationClearToNewTask,
    conversationClearProject,
    conversationResumeSession,
    conversationOpenProjects,
    conversationSelectProject,
    replaceWithInheritedSession,
  };
}
