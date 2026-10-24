import { useMemo, useRef, useState } from 'react';
import type { NavigationSelection, WorkspaceSelection } from '../navigation';
import { navigationKey } from '../text-format';
import type { ConversationHandoff } from '../use-pane-tab-close';

/** The navigation identity every session switch reads and writes: the
 *  current selection, the in-flight switch target, the conversation handoff
 *  and the refs that keep async completions from activating a stale target. */
export function useAppFrameNavigationState(startupNavigationSelection: NavigationSelection | null) {
  const [selection, setSelection] = useState<NavigationSelection>(() => startupNavigationSelection ?? { kind: 'new' });
  const selectionRef = useRef<NavigationSelection>(selection);
  selectionRef.current = selection;
  const [requestedSessionId, setRequestedSessionId] = useState('');
  // Closing a conversation removes its tab model immediately. The existing
  // Conversation owner remains visible but inert until the fallback session
  // is ready, so slow/failed host resumes never make Ctrl+Q feel ignored.
  const pendingConversationHandoff = useRef<ConversationHandoff | null>(null);
  const [conversationHandoff, setConversationHandoff] = useState<ConversationHandoff | null>(null);
  const openSessionRef = useRef<(sessionId: string, force?: boolean) => Promise<void>>(async () => {});
  // The pane chrome's activatePaneSurface (an existing tab became the focused
  // one: the selection follows it), for entry points wired before the chrome.
  const activatePaneSurfaceRef = useRef<(selection: WorkspaceSelection) => void>(() => {});
  // Monotonic navigation stamp: an async switch completion may only activate
  // its target while no NEWER navigation happened in flight (user: + during a
  // settling session switch resurrected the old transcript in the new draft).
  const navigationEpoch = useRef(0);
  // The session currently on screen (selection or in-flight switch target):
  // reconcile must never dot it, and selectionRef lags behind a switch.
  const viewedSessionRef = useRef('');
  // Unread consumption additionally treats an IN-FLIGHT switch target
  // (requestedSessionId) as viewed: a slow resume or a fork-on-resume commits
  // a different id, which left the clicked row's dot unconsumed (user report).
  const unreadViewedSessionRef = useRef('');
  // Stable identity: SessionSidebar is memoised and must not re-render from a
  // fresh selection object literal on every App commit. A switch hands it the
  // requested target first and the committed selection of the same session
  // later: the sidebar reads only the navigation identity, so an equal one
  // keeps the object it already has.
  const sidebarSelectionRef = useRef<NavigationSelection | null>(null);
  const sidebarSelection: NavigationSelection = useMemo(() => {
    const next: NavigationSelection = requestedSessionId ? { kind: 'session', id: requestedSessionId } : selection;
    const previous = sidebarSelectionRef.current;
    return previous && navigationKey(previous) === navigationKey(next) ? previous : next;
  }, [requestedSessionId, selection]);
  sidebarSelectionRef.current = sidebarSelection;
  return {
    selection,
    setSelection,
    selectionRef,
    requestedSessionId,
    setRequestedSessionId,
    pendingConversationHandoff,
    conversationHandoff,
    setConversationHandoff,
    openSessionRef,
    activatePaneSurfaceRef,
    navigationEpoch,
    viewedSessionRef,
    unreadViewedSessionRef,
    sidebarSelection,
  };
}
