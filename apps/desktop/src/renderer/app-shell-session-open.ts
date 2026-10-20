import { startTransition } from 'react';
import type { NavigationSelection, WorkspaceTab } from './navigation';
import type { DesktopSessionSummary } from '../shared/contract';
import { sessionDisplayTitle } from './session-display-title';
import { t } from './i18n';
import { defaultSessionLaneStore } from './session-lane-store';
import { requestSessionRead } from './app-snapshot-views';

interface SessionOpenProps {
  navigationEpoch: React.MutableRefObject<number>;
  closeSidebarForNavigation: () => void;
  setRequestedSessionId: (id: string) => void;
  sessions: DesktopSessionSummary[];
  tabs: WorkspaceTab[];
  finishPendingConversationHandoff: () => void;
  activateSelection: (selection: NavigationSelection, title: string, replaceKey?: string) => void;
  /** Shows the session's tab in the focused strip ahead of the transition. */
  announceOpen: (selection: NavigationSelection) => void;
}

export function useAppSessionOpen({
  navigationEpoch,
  closeSidebarForNavigation,
  setRequestedSessionId,
  sessions,
  tabs,
  finishPendingConversationHandoff,
  activateSelection,
  announceOpen,
}: SessionOpenProps) {
  /** `replaceKey`: the tab the session takes the place of (an untouched draft). */
  const openSession = async (sessionId: string, _force = false, fallbackTitle = '', replaceKey = ''): Promise<void> => {
    const navigationToken = ++navigationEpoch.current;
    closeSidebarForNavigation();
    setRequestedSessionId(sessionId);
    // Select immediately; a cold lane fills behind the already-committed tab
    // instead of making the relay RTT part of navigation latency.
    const laneReady = defaultSessionLaneStore.get(sessionId) ? Promise.resolve(true) : requestSessionRead(sessionId);
    if (navigationEpoch.current !== navigationToken) return;
    const session = sessions.find((item) => item.id === sessionId);
    finishPendingConversationHandoff();
    // Pin explicit titles such as "Reviewer · tag" across pane moves and
    // catalog refreshes. Re-entering an open tab recovers its pin rather than
    // replacing it with the session's generated title or a placeholder.
    const openedTab = tabs.find((tab) => tab.selection.kind === 'session' && tab.selection.id === sessionId);
    const openedPinnedTitle =
      openedTab && openedTab.selection.kind === 'session' ? String(openedTab.selection.title || '').trim() : '';
    const pinnedTitle = fallbackTitle.trim() || openedPinnedTitle;
    // Cleared as a transition: pending transitions render together, so a
    // warm lane drops the requested id in the same commit that selects the
    // session. Cleared urgently it committed first, alone: the sidebar row
    // fell back to the outgoing session for that commit and every shell
    // surface rendered once more.
    void laneReady.finally(() => {
      if (navigationEpoch.current === navigationToken) startTransition(() => setRequestedSessionId(''));
    });
    const selection: NavigationSelection = {
      kind: 'session',
      id: sessionId,
      ...(pinnedTitle ? { title: pinnedTitle } : {}),
    };
    // The requested id and the announced tab are the urgent part of the
    // click: the sidebar row and the focused strip's tab select in its own
    // commit (the tab used to wait for the whole incoming pane, then grow in
    // under that pane's first long tasks). Rendering the incoming pane
    // (transcript, dock) is a transition, so it yields to input and the
    // outgoing pane stays on screen, whole, until the new one commits.
    // A replacing open swaps the tab in place; announcing would add a second.
    if (!replaceKey) announceOpen(selection);
    startTransition(() =>
      activateSelection(
        selection,
        pinnedTitle || (session ? sessionDisplayTitle(session, t('Untitled session')) : t('Untitled session')),
        replaceKey
      )
    );
  };

  return {
    openSession,
  };
}
