import { startTransition } from 'react';
import type { NavigationSelection, WorkspaceTab } from './navigation';
import type { DesktopSessionSummary } from '../shared/contract';
import { sessionDisplayTitle } from './session-display-title';
import { t } from './i18n';
import { defaultSessionLaneStore } from './session-lane-store';
import { requestSessionRead } from './app-snapshot-views';
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

/** A navigation that is not a session open (entering a project) supersedes
 *  one in flight: its epoch moves on, so the open's own clear of the
 *  requested id no longer runs, and the id is dropped here instead. Left set it
 *  kept the sidebar on the abandoned session's row. */
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
    setRequestedSessionId(warm ? '' : sessionId);
    const laneReady = warm ? Promise.resolve(true) : requestSessionRead(sessionId);
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
    if (!warm) {
      void laneReady.finally(() => {
        if (navigationEpoch.current === navigationToken) startTransition(() => setRequestedSessionId(''));
      });
    }
    const selection: NavigationSelection = {
      kind: 'session',
      id: sessionId,
      ...(pinnedTitle ? { title: pinnedTitle } : {}),
    };
    // The click's selection, tab, sidebar row and incoming pane commit
    // together: a transition (or an announced tab ahead of it) committed the
    // strip and sidebar first, leaving the outgoing transcript painted for
    // the frames the incoming pane took to render.
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
