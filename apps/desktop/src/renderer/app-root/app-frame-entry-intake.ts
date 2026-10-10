import type { RefObject } from 'react';
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
  // The service worker parked the share during the launch this claims it from.
  useSharedIntakeBoot();
}
