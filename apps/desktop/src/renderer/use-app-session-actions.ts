import { useCallback, useEffect, type Dispatch, type MutableRefObject, type SetStateAction } from 'react';
import type { DesktopSessionSummary, SessionSnapshot } from '../shared/contract';
import { isAgentHomeSessionId } from '../shared/core-src/runtime/agent/orchestrator/session/agent-home.mjs';
import { sessionSummaryTitle } from '../shared/session-title.mjs';
import { t } from './i18n';
import { forgetComposerScope } from './composer-draft';
import { errorMessage } from './editor-pane-session-errors';
import { deleteSessionImagePreviews } from './image-preview-store';
import type { NavigationSelection, WorkspaceTab } from './navigation';
import type { SessionTabsClosed } from './session-tab-cleanup';
import { navigationKey } from './text-format';
import { useStableEvent } from './use-stable-event';

export function useAppSessionActions({
  sessions,
  setSessions,
  tabs,
  setTabs,
  setError,
  refreshSessions,
  pendingRenames,
  pendingArchives,
  pendingDeletes,
  invalidateSessionListings,
  applySnapshot,
  activateSelection,
  onSessionDeleted,
  closeSessionTabs,
  openSession,
  navigationEpoch,
  setRequestedSessionId,
  subscribeSessionsRemoved,
  selectionRef,
  viewedSessionRef,
  unreadViewedSessionRef,
  setSelection,
  lastSessionStorageKey,
}: {
  sessions: DesktopSessionSummary[];
  setSessions: Dispatch<SetStateAction<DesktopSessionSummary[]>>;
  tabs: WorkspaceTab[];
  setTabs: Dispatch<SetStateAction<WorkspaceTab[]>>;
  setError: Dispatch<SetStateAction<string>>;
  refreshSessions(): Promise<DesktopSessionSummary[]>;
  pendingRenames: MutableRefObject<Map<string, { title: string }>>;
  pendingArchives: MutableRefObject<Map<string, { archived: boolean }>>;
  pendingDeletes: MutableRefObject<Set<string>>;
  invalidateSessionListings(): void;
  applySnapshot(next: SessionSnapshot | null): void;
  activateSelection(selection: NavigationSelection, title: string, replaceKey?: string): void;
  onSessionDeleted(sessionId: string): void;
  /** Closes every tab of the session (tab list and panes); reports whether it
   *  was the focused active tab and the neighbour tab to show then. */
  closeSessionTabs(sessionId: string): SessionTabsClosed;
  openSession(sessionId: string): void | Promise<void>;
  navigationEpoch: MutableRefObject<number>;
  setRequestedSessionId: Dispatch<SetStateAction<string>>;
  /** Sessions a host catalog no longer lists: deleted on another device, in another window, or by a sweep. */
  subscribeSessionsRemoved(listener: (sessionIds: string[]) => void): () => void;
  selectionRef: MutableRefObject<NavigationSelection>;
  viewedSessionRef: MutableRefObject<string>;
  unreadViewedSessionRef: MutableRefObject<string>;
  setSelection: Dispatch<SetStateAction<NavigationSelection>>;
  lastSessionStorageKey: string;
}) {
  const renameSession = useCallback(
    async (sessionId: string, rawTitle: string) => {
      const title = rawTitle.trim();
      if (!title) return;
      const previousSession = sessions.find((session) => session.id === sessionId);
      if (!previousSession || sessionSummaryTitle(previousSession) === title) return;
      const tabKey = navigationKey({ kind: 'session', id: sessionId });
      const previousTabTitle = tabs.find((tab) => tab.key === tabKey)?.title;
      const pending = { title };
      pendingRenames.current.set(sessionId, pending);
      setSessions((current) => current.map((session) => (session.id === sessionId ? { ...session, title } : session)));
      setTabs((current) => current.map((tab) => (tab.key === tabKey ? { ...tab, title } : tab)));
      setError('');
      try {
        await window.mixdogDesktop.renameSession(sessionId, title);
      } catch (reason) {
        if (pendingRenames.current.get(sessionId) !== pending) return;
        pendingRenames.current.delete(sessionId);
        invalidateSessionListings();
        setSessions((current) =>
          current.map((session) =>
            session.id === sessionId && session.title === title ? { ...session, title: previousSession.title } : session
          )
        );
        if (previousTabTitle !== undefined) {
          setTabs((current) =>
            current.map((tab) =>
              tab.key === tabKey && tab.title === title ? { ...tab, title: previousTabTitle } : tab
            )
          );
        }
        setError(errorMessage(reason));
        return;
      }
      if (pendingRenames.current.get(sessionId) === pending) {
        try {
          await refreshSessions();
        } catch {
          // The persisted optimistic title remains authoritative if reconciliation is unavailable.
        } finally {
          if (pendingRenames.current.get(sessionId) === pending) {
            pendingRenames.current.delete(sessionId);
          }
        }
      }
    },
    [invalidateSessionListings, pendingRenames, refreshSessions, sessions, setError, setSessions, setTabs, tabs]
  );

  /** The selection leaves a session that no longer exists, opening no tab:
   *  the panes keep showing what they show. */
  const leaveDeletedSelection = useCallback(() => {
    selectionRef.current = { kind: 'new' };
    viewedSessionRef.current = '';
    unreadViewedSessionRef.current = '';
    setSelection({ kind: 'new' });
    setRequestedSessionId('');
    try {
      window.localStorage.removeItem(lastSessionStorageKey);
    } catch {
      /* best-effort */
    }
  }, [
    lastSessionStorageKey,
    selectionRef,
    setRequestedSessionId,
    setSelection,
    unreadViewedSessionRef,
    viewedSessionRef,
  ]);

  /** Closes every tab of a deleted or archived session, exactly like closing
   *  it by hand: whether to move on is read from the focused pane as it is
   *  now, never from a selection captured when the request started. A
   *  `deleted` session is never left selected: behind a file tab the pane
   *  shows, in an unfocused pane, or with no conversation to move to. */
  const closeTabsAndFollow = useCallback(
    (sessionId: string, deleted = false) => {
      const { shown, fallback } = closeSessionTabs(sessionId);
      if (shown) {
        navigationEpoch.current += 1;
        if (fallback?.selection.kind === 'session') {
          void openSession(fallback.selection.id);
        } else if (fallback?.selection.kind === 'new' || fallback?.selection.kind === 'project') {
          activateSelection(fallback.selection, fallback.title);
          setRequestedSessionId('');
        } else if (fallback) {
          // The pane already activated its neighbouring file/terminal/... tab.
          setRequestedSessionId('');
        } else {
          activateSelection({ kind: 'new' }, t('New task'));
          setRequestedSessionId('');
        }
      }
      const selected = selectionRef.current;
      if (deleted && selected.kind === 'session' && selected.id === sessionId) leaveDeletedSelection();
    },
    [
      activateSelection,
      closeSessionTabs,
      leaveDeletedSelection,
      navigationEpoch,
      openSession,
      selectionRef,
      setRequestedSessionId,
    ]
  );

  /** What a deleted session leaves in this window, wherever it was deleted:
   *  its surfaces, composer draft, image previews, pending rename and tabs. */
  const forgetDeletedSession = useCallback(
    (sessionId: string) => {
      onSessionDeleted(sessionId);
      forgetComposerScope(sessionId);
      deleteSessionImagePreviews(sessionId);
      pendingRenames.current.delete(sessionId);
      closeTabsAndFollow(sessionId, true);
    },
    [closeTabsAndFollow, onSessionDeleted, pendingRenames]
  );

  const forgetRemovedSessions = useStableEvent((sessionIds: string[]) => {
    // An agent's home keeps its fixed id for good: after 대화 초기화 it is
    // empty, so the catalog leaves it out, yet its chat stays open.
    for (const sessionId of sessionIds) if (!isAgentHomeSessionId(sessionId)) forgetDeletedSession(sessionId);
  });
  useEffect(() => subscribeSessionsRemoved(forgetRemovedSessions), [subscribeSessionsRemoved, forgetRemovedSessions]);

  const archiveSession = useCallback(
    async (sessionId: string, archived: boolean) => {
      const previousSession = sessions.find((session) => session.id === sessionId);
      if (!previousSession || previousSession.archived === archived) return;
      const pending = { archived };
      pendingArchives.current.set(sessionId, pending);
      invalidateSessionListings();
      setSessions((current) =>
        current.map((session) => (session.id === sessionId ? { ...session, archived } : session))
      );
      setError('');
      try {
        await window.mixdogDesktop.setSessionArchived?.(sessionId, archived);
      } catch (reason) {
        if (pendingArchives.current.get(sessionId) !== pending) return;
        pendingArchives.current.delete(sessionId);
        invalidateSessionListings();
        setSessions((current) =>
          current.map((session) =>
            session.id === sessionId && session.archived === archived
              ? { ...session, archived: previousSession.archived }
              : session
          )
        );
        setError(errorMessage(reason));
        throw reason;
      }
      if (pendingArchives.current.get(sessionId) !== pending) return;
      pendingArchives.current.delete(sessionId);
      // An archived session leaves the tab strip; restoring reopens nothing.
      if (archived) closeTabsAndFollow(sessionId);
    },
    [closeTabsAndFollow, invalidateSessionListings, pendingArchives, sessions, setError, setSessions]
  );

  const favoriteSession = useCallback(
    async (sessionId: string, favorite: boolean) => {
      const previousSession = sessions.find((session) => session.id === sessionId);
      if (!previousSession || Boolean(previousSession.favorite) === favorite) return;
      invalidateSessionListings();
      setSessions((current) =>
        current.map((session) => (session.id === sessionId ? { ...session, favorite } : session))
      );
      setError('');
      try {
        await window.mixdogDesktop.setSessionFavorite?.(sessionId, favorite);
      } catch (reason) {
        invalidateSessionListings();
        setSessions((current) =>
          current.map((session) =>
            session.id === sessionId && session.favorite === favorite
              ? { ...session, favorite: previousSession.favorite }
              : session
          )
        );
        setError(errorMessage(reason));
        throw reason;
      }
    },
    [invalidateSessionListings, sessions, setError, setSessions]
  );

  /** Changes the session's working folder ('' = no project: the task
   *  workspace); the sidebar follows once the host republishes the catalog. */
  const moveSessionToProject = useCallback(
    async (sessionId: string, projectPath: string) => {
      if (!sessions.some((session) => session.id === sessionId)) return;
      setError('');
      try {
        await window.mixdogDesktop.setSessionProject?.(sessionId, projectPath);
      } catch (reason) {
        setError(errorMessage(reason));
        throw reason;
      } finally {
        invalidateSessionListings();
      }
    },
    [invalidateSessionListings, sessions, setError]
  );

  const deleteSession = useCallback(
    async (sessionId: string) => {
      const previousSession = sessions.find((session) => session.id === sessionId);
      if (!previousSession || pendingDeletes.current.has(sessionId)) return;
      pendingDeletes.current.add(sessionId);
      setError('');
      let next: SessionSnapshot;
      try {
        next = await window.mixdogDesktop.deleteSession(sessionId);
      } catch (reason) {
        pendingDeletes.current.delete(sessionId);
        setError(errorMessage(reason));
        throw reason;
      }
      invalidateSessionListings();
      applySnapshot(next);
      setSessions((current) => current.filter((session) => session.id !== sessionId));
      forgetDeletedSession(sessionId);
      try {
        await refreshSessions();
      } catch {
        // The successful deletion remains authoritative if reconciliation is unavailable.
      } finally {
        pendingDeletes.current.delete(sessionId);
      }
    },
    [
      applySnapshot,
      forgetDeletedSession,
      invalidateSessionListings,
      pendingDeletes,
      refreshSessions,
      sessions,
      setError,
      setSessions,
    ]
  );

  // Handed to the memoised session sidebars and tab strips: each action reads
  // the latest sessions/tabs/selection when called, so their identities need
  // not change with them (every session switch rebuilt them).
  return {
    renameSession: useStableEvent(renameSession),
    archiveSession: useStableEvent(archiveSession),
    favoriteSession: useStableEvent(favoriteSession),
    moveSessionToProject: useStableEvent(moveSessionToProject),
    deleteSession: useStableEvent(deleteSession),
  };
}
