import { startTransition } from 'react';
import type { NavigationSelection, WorkspaceTab } from './navigation';
import type { DesktopSessionSummary } from '../shared/contract';
import { sessionDisplayTitle } from './session-display-title';
import { t } from './i18n';
import { defaultSessionLaneStore } from './session-lane-store';
import { requestSessionRead, usesVisibleSessionActivation } from './session-read-request';
import { confirmSessionOpen } from './session-open-intent';

interface SessionOpenProps {
  navigationEpoch: React.MutableRefObject<number>;
  closeSidebarForNavigation: () => void;
  setRequestedSessionId: (id: string) => void;
  sessions: DesktopSessionSummary[];
  tabs: WorkspaceTab[];
  finishPendingConversationHandoff: () => void;
  activateSelection: (selection: NavigationSelection, title: string, replaceKey?: string) => void;
}

export function beginProjectNavigation(
  navigationEpoch: React.MutableRefObject<number>,
  setRequestedSessionId: (id: string) => void
): void {
  navigationEpoch.current += 1;
  setRequestedSessionId('');
}

export function useAppSessionOpen({
  navigationEpoch,
  closeSidebarForNavigation,
  setRequestedSessionId,
  sessions,
  tabs,
  finishPendingConversationHandoff,
  activateSelection,
}: SessionOpenProps) {
  /** `replaceKey`: the tab the session takes the place of (an untouched draft). */
  const openSession = async (sessionId: string, _force = false, fallbackTitle = '', replaceKey = ''): Promise<void> => {
    const navigationToken = ++navigationEpoch.current;
    closeSidebarForNavigation();
    // Select immediately; a cold lane fills behind the already-committed tab
    // instead of making the relay RTT part of navigation latency. A warm lane
    // has nothing in flight to bridge, so it never holds a requested id.
    const warm = Boolean(defaultSessionLaneStore.get(sessionId));
    // The pane's visibility registration owns the core-direct first frame. A parallel read would open and decode it twice.
    const laneReady = !warm && !usesVisibleSessionActivation() ? requestSessionRead(sessionId) : null;
    setRequestedSessionId(laneReady ? sessionId : '');
    if (navigationEpoch.current !== navigationToken) return;
    // The navigation goes ahead: the press or focus that led here is an open.
    confirmSessionOpen(sessionId);
    const session = sessions.find((item) => item.id === sessionId);
    finishPendingConversationHandoff();
    // Pin explicit titles such as "Reviewer · tag" across pane moves and
    // catalog refreshes. Re-entering an open tab recovers its pin rather than
    // replacing it with the session's generated title or a placeholder.
    const openedTab = tabs.find((tab) => tab.selection.kind === 'session' && tab.selection.id === sessionId);
    const openedPinnedTitle =
      openedTab && openedTab.selection.kind === 'session' ? String(openedTab.selection.title || '').trim() : '';
    const pinnedTitle = fallbackTitle.trim() || openedPinnedTitle;
    // A cold lane's id is dropped once its read settles; the selection is
    // already committed by then, so the clear repaints nothing.
    if (laneReady) {
      void laneReady.finally(() => {
        if (navigationEpoch.current === navigationToken) startTransition(() => setRequestedSessionId(''));
      });
    }
    const selection: NavigationSelection = {
      kind: 'session',
      id: sessionId,
      ...(pinnedTitle ? { title: pinnedTitle } : {}),
    };
    activateSelection(
      selection,
      pinnedTitle || (session ? sessionDisplayTitle(session, t('Untitled session')) : t('Untitled session')),
      replaceKey
    );
  };

  return {
    openSession,
  };
}
