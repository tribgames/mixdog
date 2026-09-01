import {
  useCallback,
  type Dispatch,
  type MutableRefObject,
  type SetStateAction,
} from "react";
import type {
  DesktopSessionSummary,
  SessionSnapshot,
} from "../shared/contract";
import { sessionSummaryTitle } from "../shared/session-title.mjs";
import type {
  NavigationSelection,
  WorkspaceTab,
} from "./navigation";
import { navigationKey } from "./text-format";

export function useAppSessionActions({
  sessions,
  setSessions,
  tabs,
  setTabs,
  selection,
  setError,
  refreshSessions,
  pendingRenames,
  pendingArchives,
  pendingDeletes,
  invalidateSessionListings,
  applySnapshot,
  activateSelection,
  onSessionDeleted,
  navigationEpoch,
  setRequestedSessionId,
}: {
  sessions: DesktopSessionSummary[];
  setSessions: Dispatch<SetStateAction<DesktopSessionSummary[]>>;
  tabs: WorkspaceTab[];
  setTabs: Dispatch<SetStateAction<WorkspaceTab[]>>;
  selection: NavigationSelection;
  setError: Dispatch<SetStateAction<string>>;
  refreshSessions(): Promise<DesktopSessionSummary[]>;
  pendingRenames: MutableRefObject<Map<string, { title: string }>>;
  pendingArchives: MutableRefObject<Map<string, { archived: boolean }>>;
  pendingDeletes: MutableRefObject<Set<string>>;
  invalidateSessionListings(): void;
  applySnapshot(next: SessionSnapshot | null): void;
  activateSelection(
    selection: NavigationSelection,
    title: string,
    replaceKey?: string,
  ): void;
  onSessionDeleted(sessionId: string): void;
  navigationEpoch: MutableRefObject<number>;
  setRequestedSessionId: Dispatch<SetStateAction<string>>;
}) {
  const renameSession = useCallback(async (sessionId: string, rawTitle: string) => {
    const title = rawTitle.trim();
    if (!title) return;
    const previousSession = sessions.find((session) => session.id === sessionId);
    if (!previousSession || sessionSummaryTitle(previousSession) === title) return;
    const tabKey = navigationKey({ kind: "session", id: sessionId });
    const previousTabTitle = tabs.find((tab) => tab.key === tabKey)?.title;
    const pending = { title };
    pendingRenames.current.set(sessionId, pending);
    setSessions((current) => current.map((session) => session.id === sessionId
      ? { ...session, title }
      : session));
    setTabs((current) => current.map((tab) => tab.key === tabKey ? { ...tab, title } : tab));
    setError("");
    try {
      await window.mixdogDesktop.renameSession(sessionId, title);
    } catch (reason) {
      if (pendingRenames.current.get(sessionId) !== pending) return;
      pendingRenames.current.delete(sessionId);
      invalidateSessionListings();
      setSessions((current) => current.map((session) =>
        session.id === sessionId && session.title === title ? previousSession : session));
      if (previousTabTitle !== undefined) {
        setTabs((current) => current.map((tab) =>
          tab.key === tabKey && tab.title === title ? { ...tab, title: previousTabTitle } : tab));
      }
      setError(reason instanceof Error ? reason.message : String(reason));
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
  }, [
    invalidateSessionListings,
    pendingRenames,
    refreshSessions,
    sessions,
    setError,
    setSessions,
    setTabs,
    tabs,
  ]);

  const archiveSession = useCallback(async (sessionId: string, archived: boolean) => {
    const previousSession = sessions.find((session) => session.id === sessionId);
    if (!previousSession || previousSession.archived === archived) return;
    const pending = { archived };
    pendingArchives.current.set(sessionId, pending);
    invalidateSessionListings();
    setSessions((current) => current.map((session) => session.id === sessionId
      ? { ...session, archived }
      : session));
    setError("");
    try {
      await window.mixdogDesktop.setSessionArchived?.(sessionId, archived);
    } catch (reason) {
      if (pendingArchives.current.get(sessionId) !== pending) return;
      pendingArchives.current.delete(sessionId);
      invalidateSessionListings();
      setSessions((current) => current.map((session) =>
        session.id === sessionId && session.archived === archived ? previousSession : session));
      setError(reason instanceof Error ? reason.message : String(reason));
      throw reason;
    }
    if (pendingArchives.current.get(sessionId) === pending) {
      pendingArchives.current.delete(sessionId);
    }
  }, [
    invalidateSessionListings,
    pendingArchives,
    sessions,
    setError,
    setSessions,
  ]);

  const deleteSession = useCallback(async (sessionId: string) => {
    const previousSession = sessions.find((session) => session.id === sessionId);
    if (!previousSession || pendingDeletes.current.has(sessionId)) return;
    const deletingCurrent = selection.kind === "session" && selection.id === sessionId;
    pendingDeletes.current.add(sessionId);
    setError("");
    let next: SessionSnapshot;
    try {
      next = await window.mixdogDesktop.deleteSession(sessionId);
    } catch (reason) {
      pendingDeletes.current.delete(sessionId);
      setError(reason instanceof Error ? reason.message : String(reason));
      throw reason;
    }
    onSessionDeleted(sessionId);
    invalidateSessionListings();
    pendingRenames.current.delete(sessionId);
    applySnapshot(next);
    setSessions((current) => current.filter((session) => session.id !== sessionId));
    setTabs((current) => current.filter((tab) =>
      !(tab.selection.kind === "session" && tab.selection.id === sessionId)));
    if (deletingCurrent) {
      navigationEpoch.current += 1;
      activateSelection({ kind: "new" }, "New task");
      setRequestedSessionId("");
    }
    try {
      await refreshSessions();
    } catch {
      // The successful deletion remains authoritative if reconciliation is unavailable.
    } finally {
      pendingDeletes.current.delete(sessionId);
    }
  }, [
    activateSelection,
    applySnapshot,
    invalidateSessionListings,
    navigationEpoch,
    onSessionDeleted,
    pendingDeletes,
    pendingRenames,
    refreshSessions,
    selection,
    sessions,
    setError,
    setRequestedSessionId,
    setSessions,
    setTabs,
  ]);

  return { renameSession, archiveSession, deleteSession };
}
