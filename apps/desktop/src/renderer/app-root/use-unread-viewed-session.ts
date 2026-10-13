import { useEffect, type MutableRefObject } from 'react';
import { isMobileRemoteSurface } from '../mobile-surface';
import { resolveUnreadViewedSessionId } from '../app-unread-sessions';
import type { DesktopSessionSummary } from '../../shared/contract';
import type { NavigationSelection } from '../navigation';

interface UseUnreadViewedSessionOptions {
  navigationSelection: NavigationSelection;
  requestedSessionId: string;
  sidebarOpen: boolean;
  dockOpen: boolean;
  bottomPanelOpen: boolean;
  settingsOpen: boolean;
  sessions: DesktopSessionSummary[];
  windowFocusTick: number;
  viewedSessionRef: MutableRefObject<string>;
  unreadViewedSessionRef: MutableRefObject<string>;
  consumeUnread: (sessionId: string, sessions: DesktopSessionSummary[]) => void;
}

/** Publishes the on-screen session to the viewed refs and consumes its unread dot. */
export function useUnreadViewedSession({
  navigationSelection,
  requestedSessionId,
  sidebarOpen,
  dockOpen,
  bottomPanelOpen,
  settingsOpen,
  sessions,
  windowFocusTick,
  viewedSessionRef,
  unreadViewedSessionRef,
  consumeUnread,
}: UseUnreadViewedSessionOptions) {
  const viewedSessionId = navigationSelection.kind === 'session' ? navigationSelection.id : '';
  viewedSessionRef.current = viewedSessionId;
  const unreadViewedSessionId = resolveUnreadViewedSessionId({
    viewedSessionId,
    requestedSessionId,
    mobile: isMobileRemoteSurface(),
    sidebarOpen,
    dockOpen,
    bottomPanelOpen,
    settingsOpen,
  });
  unreadViewedSessionRef.current = unreadViewedSessionId;
  // biome-ignore lint/correctness/useExhaustiveDependencies: Window focus must recheck unread state even when session data is unchanged.
  useEffect(() => {
    consumeUnread(unreadViewedSessionId, sessions);
  }, [consumeUnread, sessions, unreadViewedSessionId, windowFocusTick]);
}
