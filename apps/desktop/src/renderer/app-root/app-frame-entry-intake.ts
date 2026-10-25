import { type RefObject, useEffect } from 'react';
import { OPEN_TASK_SESSION_EVENT } from '../agent-task-events';
import { focusOpenNotificationSession } from '../desktop-notification-navigation';
import type { WorkspaceSelection } from '../navigation';
import type { usePaneWorkspace } from '../pane-workspace-state';
import { useSharedIntakeBoot } from '../share-target-intake';
import { usePushNotificationNavigation } from '../use-push-notification-navigation';

/** Entry points from outside the window: a tapped push notification opens the
 *  session it came from (the app may not even have been running), and a
 *  screenshot shared from the phone's share sheet is claimed at launch. */
export function useAppFrameEntryIntake({
  sessionCatalogReady,
  openSessionRef,
  activatePaneSurfaceRef,
  navigationEpoch,
  setRequestedSessionId,
  paneWorkspace,
  sessions,
}: {
  sessionCatalogReady: boolean;
  /** The loaded catalog: a notification for a session it lacks opens nothing. */
  sessions: readonly { id: string }[];
  openSessionRef: RefObject<(sessionId: string, force?: boolean) => Promise<void>>;
  /** The app's navigation stamp and in-flight open (app-frame-navigation-state.ts). */
  navigationEpoch: RefObject<number>;
  setRequestedSessionId: (sessionId: string) => void;
  /** The pane chrome's activatePaneSurface: a revealed tab carries the selection. */
  activatePaneSurfaceRef: RefObject<(selection: WorkspaceSelection) => void>;
  paneWorkspace: Pick<ReturnType<typeof usePaneWorkspace>, 'layout' | 'activateTab' | 'restorePending'>;
}) {
  usePushNotificationNavigation({
    ready: sessionCatalogReady,
    hasSession: (sessionId) => sessions.some((session) => session.id === sessionId),
    openSession: (sessionId) => {
      void openSessionRef.current(sessionId);
    },
    desktopReady: !paneWorkspace.restorePending,
    focusDesktopSession: (sessionId) =>
      focusOpenNotificationSession(paneWorkspace, sessionId, (selection) => {
        // The reveal is the newest navigation: a cold open still loading must
        // neither keep the sidebar on its row (requestedSessionId outranks the
        // selection) nor clear it later, so the reveal supersedes it.
        navigationEpoch.current += 1;
        setRequestedSessionId('');
        activatePaneSurfaceRef.current(selection);
      }),
  });
  // "Open" on a task session's line in an agent's chat (agent-task-line.tsx).
  useEffect(() => {
    const open = (event: Event) => {
      const sessionId = String((event as CustomEvent<{ sessionId?: unknown }>).detail?.sessionId || '');
      if (sessionId) void openSessionRef.current(sessionId);
    };
    window.addEventListener(OPEN_TASK_SESSION_EVENT, open);
    return () => window.removeEventListener(OPEN_TASK_SESSION_EVENT, open);
  }, [openSessionRef]);
  // The service worker parked the share during the launch this claims it from.
  useSharedIntakeBoot();
}
