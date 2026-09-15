import type { NavigationSelection, WorkspaceTab } from "./navigation";
import type { DesktopSessionSummary } from "../shared/contract";
import { sessionSummaryTitle } from "../shared/session-title.mjs";
import { defaultSessionLaneStore } from "./session-lane-store";
import { requestSessionRead } from "./app-snapshot-views";

export interface SessionOpenProps {
  navigationEpoch: React.MutableRefObject<number>;
  closeSidebarForNavigation: () => void;
  setRequestedSessionId: (id: string) => void;
  sessions: DesktopSessionSummary[];
  tabs: WorkspaceTab[];
  finishPendingConversationHandoff: () => void;
  activateSelection: (selection: NavigationSelection, title: string) => void;
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
  const openSession = async (
    sessionId: string,
    _force = false,
    fallbackTitle = "",
  ): Promise<void> => {
    const navigationToken = ++navigationEpoch.current;
    closeSidebarForNavigation();
    setRequestedSessionId(sessionId);
    // Select immediately; a cold lane fills behind the already-committed tab
    // instead of making the relay RTT part of navigation latency.
    const laneReady = defaultSessionLaneStore.get(sessionId)
      ? Promise.resolve(true)
      : requestSessionRead(sessionId);
    if (navigationEpoch.current !== navigationToken) return;
    const session = sessions.find((item) => item.id === sessionId);
    finishPendingConversationHandoff();
    // Pin explicit titles such as "Reviewer · tag" across pane moves and
    // catalog refreshes. Re-entering an open tab recovers its pin rather than
    // replacing it with the session's generated title or a placeholder.
    const openedTab = tabs.find((tab) => tab.selection.kind === "session"
      && tab.selection.id === sessionId);
    const openedPinnedTitle = openedTab && openedTab.selection.kind === "session"
      ? String(openedTab.selection.title || "").trim()
      : "";
    const pinnedTitle = fallbackTitle.trim() || openedPinnedTitle;
    void laneReady.finally(() => {
      if (navigationEpoch.current === navigationToken) setRequestedSessionId("");
    });
    activateSelection(
      {
        kind: "session",
        id: sessionId,
        ...(pinnedTitle ? { title: pinnedTitle } : {}),
      },
      pinnedTitle || (session ? sessionSummaryTitle(session) : "Untitled session"),
    );
  };

  return {
    openSession,
  };
}


