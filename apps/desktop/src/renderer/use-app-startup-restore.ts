import { type Dispatch, type MutableRefObject, type SetStateAction, useEffect, useRef } from 'react';

import type { DesktopSessionSummary } from '../shared/contract';
import { sessionSummaryTitle } from '../shared/session-title.mjs';
import { t } from './i18n';
import { markBootStage } from './boot-metrics';
import type { Snapshot } from './desktop-types';
import type { NavigationSelection, WorkspaceSelection } from './navigation';
import { startupRestorePlan } from './renderer-logic.mjs';
import { resolvedStoredProjectPath } from './use-draft-pane-preferences';

export function startupRestoreCatalogPending({
  projectCatalogReady,
  storedSessionId,
  storedProjectPath,
}: {
  projectCatalogReady: boolean;
  storedSessionId: string;
  storedProjectPath: string;
}): boolean {
  return !projectCatalogReady && Boolean(storedSessionId || storedProjectPath);
}

export function useAppStartupRestore({
  restorePending,
  restoredFromStorage,
  startupFocusedPaneSelection,
  startupNavigationSelection,
  projectCatalogReady,
  snapshot,
  snapshotReady,
  sessions,
  selectionRef,
  viewedSessionRef,
  unreadViewedSessionRef,
  setSelection,
  setStartupSettled,
  activateSelection,
  openSessionRef,
  lastNewTaskPrefs,
  effectiveDraftProjectPath,
  preferredDraftProjectPath,
  setNewTaskDeferred,
  resetNewTaskDraft,
  lastSessionStorageKey,
  lastProjectStorageKey,
}: {
  restorePending: boolean;
  restoredFromStorage: boolean;
  startupFocusedPaneSelection: WorkspaceSelection | null | undefined;
  startupNavigationSelection: NavigationSelection | null | undefined;
  projectCatalogReady: boolean;
  snapshot: Snapshot;
  snapshotReady: boolean;
  sessions: DesktopSessionSummary[];
  selectionRef: MutableRefObject<NavigationSelection>;
  viewedSessionRef: MutableRefObject<string>;
  unreadViewedSessionRef: MutableRefObject<string>;
  setSelection: Dispatch<SetStateAction<NavigationSelection>>;
  setStartupSettled: Dispatch<SetStateAction<boolean>>;
  activateSelection(selection: NavigationSelection, title: string, replaceKey?: string): void;
  openSessionRef: MutableRefObject<(sessionId: string, force?: boolean) => Promise<void>>;
  lastNewTaskPrefs: MutableRefObject<{ projectPath: string | null } | null>;
  effectiveDraftProjectPath(path: string): string;
  preferredDraftProjectPath: string;
  setNewTaskDeferred: Dispatch<SetStateAction<boolean>>;
  resetNewTaskDraft(projectPath: string | null): void;
  lastSessionStorageKey: string;
  lastProjectStorageKey: string;
}) {
  const restoredStartupNavigation = useRef(false);

  useEffect(() => {
    const settleStartup = () => {
      (window as { __mixdogStartupSettled?: boolean }).__mixdogStartupSettled = true;
      setStartupSettled(true);
      markBootStage('startup-settled');
      window.dispatchEvent(new Event('mixdog:startup-settled'));
    };
    if (restoredStartupNavigation.current) return;
    if (restorePending) return;
    // The phone opens straight into the session it showed last, like the
    // desktop: the relay client names that session among its visible sessions
    // when it connects, so its transcript arrives with the first view sync
    // instead of after a drawer tap and a second round trip.
    if (restoredFromStorage && startupFocusedPaneSelection) {
      restoredStartupNavigation.current = true;
      if (startupNavigationSelection) {
        selectionRef.current = startupNavigationSelection;
        setSelection(startupNavigationSelection);
        viewedSessionRef.current = startupNavigationSelection.kind === 'session' ? startupNavigationSelection.id : '';
        unreadViewedSessionRef.current = viewedSessionRef.current;
        try {
          if (startupNavigationSelection.kind === 'session') {
            window.localStorage.setItem(lastSessionStorageKey, startupNavigationSelection.id);
          } else {
            window.localStorage.removeItem(lastSessionStorageKey);
          }
        } catch {
          // Startup routing remains best-effort.
        }
      }
      window.requestAnimationFrame(settleStartup);
      return;
    }
    if (!snapshotReady) return;
    let storedSessionId = '';
    let storedProject = '';
    try {
      // An absent stored id is meaningful to startupRestorePlan: it lands on
      // the New task draft.
      storedSessionId = window.localStorage.getItem(lastSessionStorageKey) || '';
      storedProject = window.localStorage.getItem(lastProjectStorageKey) || '';
    } catch {
      // Continue with the safe draft fallback.
    }
    // A truly fresh New Task has no persisted route to validate. Its complete
    // shell can open immediately and adopt the background project catalog when
    // it arrives; persisted session/project routes still wait for authority.
    if (
      startupRestoreCatalogPending({
        projectCatalogReady,
        storedSessionId,
        storedProjectPath: storedProject,
      })
    )
      return;
    restoredStartupNavigation.current = true;
    const plan = startupRestorePlan({
      storedSessionId,
      storedSessionKnown: Boolean(storedSessionId && sessions.some((session) => session.id === storedSessionId)),
      engineSessionId: String(snapshot.sessionId || ''),
    });
    if (plan.clearStored) {
      try {
        window.localStorage.removeItem(lastSessionStorageKey);
      } catch {
        // A stale key is harmless.
      }
    }
    try {
      window.mixdogDesktop?.perfLog?.(
        `startup-restore action=${plan.action} target=${plan.sessionId || '(none)'}` +
          ` stored=${storedSessionId || '(none)'}` +
          ` engine=${String(snapshot.sessionId || '') || '(none)'}`
      );
    } catch {
      // Diagnostics only.
    }
    if (plan.action === 'activate') {
      const current = sessions.find((session) => session.id === plan.sessionId);
      activateSelection(
        { kind: 'session', id: plan.sessionId },
        current
          ? sessionSummaryTitle(current, t('Untitled session'))
          : String(snapshot.desktopSessionTitle || t('New task'))
      );
      settleStartup();
      return;
    }
    if (plan.action === 'resume') {
      void openSessionRef.current(plan.sessionId, true).finally(settleStartup);
      return;
    }
    const cachedProjectPath = lastNewTaskPrefs.current?.projectPath ?? null;
    // Only an EXPLICIT stored choice is restored — "" keeps No project. With
    // no choice at all the draft keeps INHERITING, so a phone that boots
    // before its relay-backed project catalog lands still adopts the last
    // project when it arrives instead of freezing an empty one (user:
    // 마지막으로 쓴 프로젝트가 안 잡힘).
    const cachedDraftProject =
      cachedProjectPath === null
        ? effectiveDraftProjectPath(storedProject || preferredDraftProjectPath) || null
        : resolvedStoredProjectPath(cachedProjectPath, effectiveDraftProjectPath);
    if (cachedDraftProject === '') {
      setNewTaskDeferred(true);
      settleStartup();
      return;
    }
    resetNewTaskDraft(cachedDraftProject);
    activateSelection({ kind: 'new' }, t('New task'));
    settleStartup();
  }, [
    activateSelection,
    effectiveDraftProjectPath,
    lastNewTaskPrefs,
    lastProjectStorageKey,
    lastSessionStorageKey,
    openSessionRef,
    preferredDraftProjectPath,
    projectCatalogReady,
    resetNewTaskDraft,
    restorePending,
    restoredFromStorage,
    selectionRef,
    sessions,
    setNewTaskDeferred,
    setSelection,
    setStartupSettled,
    snapshot,
    snapshotReady,
    startupFocusedPaneSelection,
    startupNavigationSelection,
    unreadViewedSessionRef,
    viewedSessionRef,
  ]);
}
