// Recent-list unread dots. Seen state is a per-session MESSAGE COUNT (v2) in
// localStorage: only message growth that lands while the window is hidden or
// while another session is viewed earns a dot, so housekeeping saves never
// re-dot a checked row. Extracted from App.tsx.
import { useCallback, useRef, useState, type MutableRefObject } from "react";

import type { DesktopSessionSummary } from "../shared/contract";

const SEEN_COUNTS_KEY = "mixdog.desktop.session-seen-counts";
const LEGACY_TIMESTAMP_KEY = "mixdog.desktop.session-last-seen";
// Counts are small; a timestamp mistakenly stored as a count (~1.7e12) would
// suppress the dot forever, so absurd values are dropped and re-baselined.
const MAX_PLAUSIBLE_COUNT = 1e7;

export function useUnreadSessions({
  viewedSessionRef,
}: {
  /** The session on screen, including an in-flight switch target. */
  viewedSessionRef: MutableRefObject<string>;
}) {
  const [unreadSessionIds, setUnreadSessionIds] = useState<ReadonlySet<string>>(() => new Set());
  // Completion is an activity signal even when a final catalog push races the
  // message-count update: track working -> settled transitions too.
  const previousWorkingSessionIds = useRef<ReadonlySet<string>>(new Set());
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

  const reconcileUnreadSessions = useCallback((rows: DesktopSessionSummary[]) => {
    const seen = loadSeen();
    const activeId = viewedSessionRef.current;
    const liveIds = new Set(rows.map((row) => row.id));
    const workingIds = new Set(rows.filter((row) => row.working === true).map((row) => row.id));
    const completedIds = new Set([...previousWorkingSessionIds.current]
      .filter((id) => liveIds.has(id) && !workingIds.has(id)));
    previousWorkingSessionIds.current = workingIds;
    // "Viewed" means the window is actually on screen: an unfocused but visible
    // desktop mirroring a terminal-owned turn IS being watched (user report).
    const engaged = document.visibilityState === "visible";
    let dirty = false;
    for (const id of [...seen.keys()]) {
      if (liveIds.has(id)) continue;
      seen.delete(id);
      dirty = true;
    }
    const unread = new Set<string>();
    for (const row of rows) {
      const count = Math.max(0, Number(row.messageCount) || 0);
      const last = seen.get(row.id);
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
        continue;
      }
      if (count > last) unread.add(row.id);
    }
    if (dirty) persistSeen(seen);
    setUnreadSessionIds((current) => {
      // Preserve completion-only dots across later catalog pushes until the row
      // is actually viewed: message-count unread stays derivable from `seen`,
      // but completion unread may be the only signal when save ordering exposes
      // heartbeat removal before the final assistant count.
      for (const id of current) {
        if (liveIds.has(id) && !(id === activeId && engaged)) unread.add(id);
      }
      for (const id of completedIds) {
        if (!(id === activeId && engaged)) unread.add(id);
      }
      if (current.size === unread.size && [...unread].every((id) => current.has(id))) return current;
      return unread;
    });
  }, [loadSeen, persistSeen, viewedSessionRef]);

  // Viewing a session consumes its marker — but only while the window is on
  // screen, so a selected session in a hidden window keeps its dot. The caller
  // fires this from an effect once the viewed selection is known.
  const consumeUnread = useCallback((viewedSessionId: string, sessions: DesktopSessionSummary[]) => {
    if (!viewedSessionId) return;
    if (document.visibilityState !== "visible") return;
    const seen = loadSeen();
    const row = sessions.find((session) => session.id === viewedSessionId);
    const count = Math.max(Number(row?.messageCount) || 0, seen.get(viewedSessionId) || 0);
    if (count > 0 && seen.get(viewedSessionId) !== count) {
      seen.set(viewedSessionId, count);
      persistSeen(seen);
    }
    setUnreadSessionIds((current) => {
      if (!current.has(viewedSessionId)) return current;
      const next = new Set(current);
      next.delete(viewedSessionId);
      return next;
    });
  }, [loadSeen, persistSeen]);

  return { unreadSessionIds, reconcileUnreadSessions, consumeUnread };
}
