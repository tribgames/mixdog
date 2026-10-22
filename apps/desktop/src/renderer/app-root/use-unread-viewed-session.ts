import { useEffect, type MutableRefObject } from 'react';
import { isMobileRemoteSurface } from '../mobile-surface';
import { resolveUnreadViewedSessionId } from '../app-unread-sessions';
import { currentScreenSessionIds, useScreenSessionIds } from '../use-visible-sessions';
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
  /** Sessions the window's other visible panes show (side pane, split). */
  screenSessionIdsRef: MutableRefObject<readonly string[]>;
  consumeUnread: (sessionId: string, sessions: DesktopSessionSummary[]) => void;
}

/** Publishes the on-screen sessions to the viewed refs and consumes their unread dots. */
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
  screenSessionIdsRef,
  consumeUnread,
}: UseUnreadViewedSessionOptions) {
  const viewedSessionId = navigationSelection.kind === 'session' ? navigationSelection.id : '';
  viewedSessionRef.current = viewedSessionId;
  const mobile = isMobileRemoteSurface();
  const unreadViewedSessionId = resolveUnreadViewedSessionId({
    viewedSessionId,
    requestedSessionId,
    mobile,
    sidebarOpen,
    dockOpen,
    bottomPanelOpen,
    settingsOpen,
  });
  unreadViewedSessionRef.current = unreadViewedSessionId;
  // Every other visible pane is read like the focused one. The phone shows a
  // single pane, whose sheet and sidebar rule above already decides.
  const otherSessionIds = (ids: readonly string[]) =>
    mobile ? [] : ids.filter((id) => id !== unreadViewedSessionId);
  const screenSessionIds = useScreenSessionIds();
  screenSessionIdsRef.current = otherSessionIds(screenSessionIds);
  // biome-ignore lint/correctness/useExhaustiveDependencies: Window focus must recheck unread state even when session data is unchanged; screenSessionIds re-runs it on a pane report.
  useEffect(() => {
    // The live report, not this render's: a pane hidden in this very commit
    // has already left it (reports land in layout effects).
    const others = otherSessionIds(currentScreenSessionIds());
    screenSessionIdsRef.current = others;
    for (const sessionId of [unreadViewedSessionId, ...others]) consumeUnread(sessionId, sessions);
  }, [consumeUnread, mobile, screenSessionIds, sessions, unreadViewedSessionId, windowFocusTick]);
}
