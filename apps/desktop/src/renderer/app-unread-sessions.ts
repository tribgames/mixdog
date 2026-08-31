// Recent-list unread dots. Seen state is a per-session MESSAGE COUNT (v2) in
// localStorage: only message growth that lands while the surface is unread —
// hidden, unfocused, or showing another session — earns a dot, so housekeeping
// saves never re-dot a checked row. Extracted from App.tsx.
import { useCallback, useRef, useState, type MutableRefObject } from "react";

import type { DesktopSessionSummary } from "../shared/contract";

const SEEN_COUNTS_KEY = "mixdog.desktop.session-seen-counts";
const LEGACY_TIMESTAMP_KEY = "mixdog.desktop.session-last-seen";
// Counts are small; a timestamp mistakenly stored as a count (~1.7e12) would
// suppress the dot forever, so absurd values are dropped and re-baselined.
const MAX_PLAUSIBLE_COUNT = 1e7;

/** Reading requires ATTENTION, not mere presence on screen: the surface must be
 *  visible AND focused. A desktop window sitting behind another app, or a phone
 *  whose tab lost focus, is not being read — a turn that completes there keeps
 *  its dot and the Agents pane's completion notice (user: 작업 완료 후 읽지도
 *  않았는데 대기중). Both surfaces run this same renderer, so the rule is one.
 *  A host without `hasFocus` degrades to visibility alone. */
export function sessionSurfaceEngaged(): boolean {
  if (typeof document === "undefined") return false;
  if (document.visibilityState !== "visible") return false;
  return typeof document.hasFocus === "function" ? document.hasFocus() : true;
}

function sharedReadCount(row: DesktopSessionSummary): number {
  const value = Number(row.readMessageCount);
  return Number.isInteger(value) && value >= 0 && value <= MAX_PLAUSIBLE_COUNT ? value : 0;
}

function sharedReadRevision(row: DesktopSessionSummary): number {
  const value = Number(row.readRevision);
  return Number.isSafeInteger(value) && value > 0 ? value : 0;
}

export function sharedReadClearsUnread(
  row: DesktopSessionSummary,
  previousRevision: number | undefined,
): boolean {
  const revision = sharedReadRevision(row);
  return previousRevision !== undefined
    && revision > previousRevision
    && sharedReadCount(row) >= Math.max(0, Number(row.messageCount) || 0);
}

export function shouldPublishSessionRead(
  row: DesktopSessionSummary,
  messageCount: number,
  consumedUnread: boolean,
): boolean {
  return consumedUnread || messageCount > sharedReadCount(row);
}

export function resolveUnreadViewedSessionId({
  viewedSessionId,
  requestedSessionId,
  mobile,
  sidebarOpen,
  dockOpen,
  bottomPanelOpen,
  settingsOpen,
}: {
  viewedSessionId: string;
  requestedSessionId: string;
  mobile: boolean;
  sidebarOpen: boolean;
  dockOpen: boolean;
  bottomPanelOpen: boolean;
  settingsOpen: boolean;
}): string {
  const target = requestedSessionId || viewedSessionId;
  if (!mobile) return target;
  return sidebarOpen || dockOpen || bottomPanelOpen || settingsOpen ? "" : target;
}

export function useUnreadSessions({
  viewedSessionRef,
}: {
  /** The session on screen, including an in-flight switch target. */
  viewedSessionRef: MutableRefObject<string>;
}) {
  const [unreadSessionIds, setUnreadSessionIds] = useState<ReadonlySet<string>>(() => new Set());
  const unreadSessionIdsRef = useRef<ReadonlySet<string>>(new Set());
  // Completion is an activity signal even when a final catalog push races the
  // message-count update: track working -> settled transitions too.
  const previousWorkingSessionIds = useRef<ReadonlySet<string>>(new Set());
  const sharedReadRevisions = useRef<Map<string, number>>(new Map());
  const sessionLastSeen = useRef<Map<string, number> | null>(null);

  const loadSeen = useCallback(() => {
    if (sessionLastSeen.current) return sessionLastSeen.current;
    const map = new Map<string, number>();
    try {
      window.localStorage.removeItem(LEGACY_TIMESTAMP_KEY);
      const raw = window.localStorage.getItem(SEEN_COUNTS_KEY);
      const parsed = raw ? JSON.parse(raw) as Record<string, unknown> : null;
      for (const [id, at] of Object.entries(parsed || {})) {
        const value = Number(at);
        if (Number.isFinite(value) && value >= 0 && value < MAX_PLAUSIBLE_COUNT) map.set(id, value);
      }
    } catch {
      // Unread markers degrade to in-memory tracking without persistent storage.
    }
    sessionLastSeen.current = map;
    return map;
  }, []);

  const persistSeen = useCallback((map: Map<string, number>) => {
    try {
      window.localStorage.setItem(SEEN_COUNTS_KEY, JSON.stringify(Object.fromEntries(map)));
    } catch {
      // Unread markers degrade to in-memory tracking without persistent storage.
    }
  }, []);

  const commitUnread = useCallback((next: ReadonlySet<string>) => {
    const current = unreadSessionIdsRef.current;
    if (current.size === next.size && [...next].every((id) => current.has(id))) return;
    unreadSessionIdsRef.current = next;
    setUnreadSessionIds(next);
  }, []);

  const publishRead = useCallback((
    row: DesktopSessionSummary,
    messageCount: number,
    consumedUnread: boolean,
  ) => {
    const markSessionRead = window.mixdogDesktop?.markSessionRead;
    if (typeof markSessionRead !== "function"
      || !shouldPublishSessionRead(row, messageCount, consumedUnread)) return;
    try {
      void Promise.resolve(markSessionRead(row.id, messageCount, consumedUnread)).catch(() => undefined);
    } catch {
      // The local cursor remains the fallback when the host lane is unavailable.
    }
  }, []);

  const reconcileUnreadSessions = useCallback((rows: DesktopSessionSummary[]) => {
    const seen = loadSeen();
    const activeId = viewedSessionRef.current;
    const liveIds = new Set(rows.map((row) => row.id));
    const workingIds = new Set(rows.filter((row) => row.working === true).map((row) => row.id));
    const completedIds = new Set([...previousWorkingSessionIds.current]
      .filter((id) => liveIds.has(id) && !workingIds.has(id)));
    previousWorkingSessionIds.current = workingIds;
    // "Viewed" means the surface is on screen AND focused; see
    // sessionSurfaceEngaged.
    const engaged = sessionSurfaceEngaged();
    let dirty = false;
    for (const id of [...seen.keys()]) {
      if (liveIds.has(id)) continue;
      seen.delete(id);
      dirty = true;
    }
    for (const id of [...sharedReadRevisions.current.keys()]) {
      if (!liveIds.has(id)) sharedReadRevisions.current.delete(id);
    }
    const unread = new Set<string>();
    const remotelyReadIds = new Set<string>();
    for (const row of rows) {
      const count = Math.max(0, Number(row.messageCount) || 0);
      const priorRevision = sharedReadRevisions.current.get(row.id);
      const revision = sharedReadRevision(row);
      if (priorRevision === undefined || revision > priorRevision) {
        sharedReadRevisions.current.set(row.id, revision);
      }
      if (sharedReadClearsUnread(row, priorRevision)) remotelyReadIds.add(row.id);
      const sharedCount = sharedReadCount(row);
      let last = seen.get(row.id);
      if (sharedCount > (last ?? -1)) {
        seen.set(row.id, sharedCount);
        last = sharedCount;
        dirty = true;
      }
      // Automation fires are BORN in the background (each fire is a fresh
      // session): their first sighting IS the notification, so they skip the
      // read-by-definition baseline until actually viewed.
      const automationBorn = row.sourceType === "schedule" || row.sourceType === "webhook";
      if (last === undefined && automationBorn && !(row.id === activeId && engaged)) {
        if (count > 0) unread.add(row.id);
        continue;
      }
      if (last === undefined || (row.id === activeId && engaged)) {
        if (last !== count) {
          seen.set(row.id, count);
          dirty = true;
        }
        if (row.id === activeId && engaged) {
          publishRead(
            row,
            count,
            !remotelyReadIds.has(row.id)
              && (unreadSessionIdsRef.current.has(row.id) || completedIds.has(row.id)),
          );
        }
        continue;
      }
      if (count > last) unread.add(row.id);
    }
    if (dirty) persistSeen(seen);
    // Preserve completion-only dots across later catalog pushes until the row
    // is viewed on either surface. A shared revision advance consumes them.
    for (const id of unreadSessionIdsRef.current) {
      if (liveIds.has(id) && !remotelyReadIds.has(id) && !(id === activeId && engaged)) unread.add(id);
    }
    for (const id of completedIds) {
      if (!remotelyReadIds.has(id) && !(id === activeId && engaged)) unread.add(id);
    }
    commitUnread(unread);
  }, [commitUnread, loadSeen, persistSeen, publishRead, viewedSessionRef]);

  // Viewing a session consumes its marker — but only while the surface is
  // engaged, so a selected session in a hidden or unfocused window keeps its
  // dot. The caller fires this from an effect once the selection is known, and
  // again whenever focus returns.
  const consumeUnread = useCallback((viewedSessionId: string, sessions: DesktopSessionSummary[]) => {
    if (!viewedSessionId) return;
    if (!sessionSurfaceEngaged()) return;
    const seen = loadSeen();
    const row = sessions.find((session) => session.id === viewedSessionId);
    const count = Math.max(Number(row?.messageCount) || 0, seen.get(viewedSessionId) || 0);
    if (count > 0 && seen.get(viewedSessionId) !== count) {
      seen.set(viewedSessionId, count);
      persistSeen(seen);
    }
    const current = unreadSessionIdsRef.current;
    const consumedUnread = current.has(viewedSessionId);
    if (row) publishRead(row, count, consumedUnread);
    if (consumedUnread) {
      const next = new Set(current);
      next.delete(viewedSessionId);
      commitUnread(next);
    }
  }, [commitUnread, loadSeen, persistSeen, publishRead]);

  return { unreadSessionIds, reconcileUnreadSessions, consumeUnread };
}
