import { type RefObject, useEffect } from 'react';
import { OPEN_TASK_SESSION_EVENT } from '../agent-task-events';
import { focusOpenNotificationSession } from '../desktop-notification-navigation';
import type { usePaneWorkspace } from '../pane-workspace-state';
import { useSharedIntakeBoot } from '../share-target-intake';
import { usePushNotificationNavigation } from '../use-push-notification-navigation';

/** Entry points from outside the window: a tapped push notification opens the
 *  session it came from (the app may not even have been running), and a
 *  screenshot shared from the phone's share sheet is claimed at launch. */
export function useAppFrameEntryIntake({
  sessionCatalogReady,
  openSessionRef,
  paneWorkspace,
}: {
  sessionCatalogReady: boolean;
  openSessionRef: RefObject<(sessionId: string, force?: boolean) => Promise<void>>;
  paneWorkspace: ReturnType<typeof usePaneWorkspace>;
}) {
  usePushNotificationNavigation({
    ready: sessionCatalogReady,
    openSession: (sessionId) => {
      void openSessionRef.current(sessionId);
    },
    desktopReady: !paneWorkspace.restorePending,
    focusDesktopSession: (sessionId) => {
      focusOpenNotificationSession(paneWorkspace, sessionId);
    },
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
