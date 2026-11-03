import { type Dispatch, type MutableRefObject, type SetStateAction, useEffect, useRef } from 'react';

import type { DesktopSessionSummary } from '../shared/contract';
import { displaySessionTitle, sessionDisplayTitle } from './session-display-title';
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

/** The stored last session is not in the catalog yet and the host's catalog
 *  has not answered. The phone keeps no catalog cache between loads (its
 *  conversation content is memory-only), so its catalog is empty until the
 *  relay lists sessions; judging the stored id before that dropped it and
 *  landed on a blank task. */
export function startupRestoreSessionPending({
  sessionCatalogReady,
  storedSessionId,
  storedSessionKnown,
}: {
  sessionCatalogReady: boolean;
  storedSessionId: string;
  storedSessionKnown: boolean;
}): boolean {
  return !sessionCatalogReady && Boolean(storedSessionId) && !storedSessionKnown;
}

export function useAppStartupRestore({
  restorePending,
  restoredFromStorage,
  startupFocusedPaneSelection,
  startupNavigationSelection,
  startFresh,
  startProjectlessTask,
  projectCatalogReady,
  snapshot,
  snapshotReady,
  sessions,
  sessionCatalogReady,
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
  /** "Start screen" asks for a projectless new conversation on this launch. */
  startFresh?: boolean;
  startProjectlessTask?(): void;
  projectCatalogReady: boolean;
  snapshot: Snapshot;
  snapshotReady: boolean;
  sessions: DesktopSessionSummary[];
  /** The host has answered the first session listing. */
  sessionCatalogReady: boolean;
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
    // Overrides both the restored panes and the last-session/project fallback;
    // the other restored tabs stay where they are.
    if (startFresh && startProjectlessTask) {
      restoredStartupNavigation.current = true;
      startProjectlessTask();
      settleStartup();
      return;
    }
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
    const storedSessionKnown = Boolean(storedSessionId && sessions.some((session) => session.id === storedSessionId));
    if (startupRestoreSessionPending({ sessionCatalogReady, storedSessionId, storedSessionKnown })) return;
    restoredStartupNavigation.current = true;
    const plan = startupRestorePlan({
      storedSessionId,
      storedSessionKnown,
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
          ? sessionDisplayTitle(current, t('Untitled session'))
          : displaySessionTitle(String(snapshot.desktopSessionTitle || '')) || t('New task')
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
    sessionCatalogReady,
    sessions,
    setNewTaskDeferred,
    setSelection,
    setStartupSettled,
    snapshot,
    snapshotReady,
    startFresh,
    startProjectlessTask,
    startupFocusedPaneSelection,
    startupNavigationSelection,
    unreadViewedSessionRef,
    viewedSessionRef,
  ]);
}
