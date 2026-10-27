// Recent-list unread dots. Seen state is a per-session MESSAGE COUNT (v2) in
// localStorage: only message growth that lands while the surface is unread —
// hidden, unfocused, or showing another session — earns a dot, so housekeeping
// saves never re-dot a checked row.
import { useCallback, useRef, useState, type MutableRefObject } from 'react';

import type { DesktopSessionSummary } from '../shared/contract';

const SEEN_COUNTS_KEY = 'mixdog.desktop.session-seen-counts';
const SEEN_EPOCHS_KEY = 'mixdog.desktop.session-seen-epochs';
const LEGACY_TIMESTAMP_KEY = 'mixdog.desktop.session-last-seen';
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
  if (typeof document === 'undefined') return false;
  if (document.visibilityState !== 'visible') return false;
  return typeof document.hasFocus === 'function' ? document.hasFocus() : true;
}

function sharedReadCount(row: DesktopSessionSummary): number {
  const value = Number(row.readMessageCount);
  return Number.isInteger(value) && value >= 0 && value <= MAX_PLAUSIBLE_COUNT ? value : 0;
}

/** A seen count is in the numbering of the `compactCount` it was recorded
 *  under, and a compaction trims a session's live messages and restarts that
 *  numbering. A count recorded under another one follows the shared cursor,
 *  which the host restarts with it (the turn that compacted stays unread). A
 *  count from before the epoch was recorded is lowered to the row's message
 *  count only when the session is known compacted and that count is a real
 *  one below it. A row without a `compactCount` settles nothing. Returns
 *  whether the seen count or its epoch changed. */
function settleSeen(
  seen: Map<string, number>,
  epochs: Map<string, number>,
  row: DesktopSessionSummary,
  sharedCount: number
): boolean {
  const epoch = row.compactCount;
  if (epoch === undefined || !Number.isSafeInteger(epoch) || epoch < 0) return false;
  const recorded = epochs.get(row.id);
  if (recorded === epoch) return false;
  const last = seen.get(row.id);
  if (last !== undefined) {
    if (recorded !== undefined) seen.set(row.id, sharedCount);
    else if (epoch > 0) {
      // Not settled, nor stamped, without a real count to judge it by.
      const count = Number(row.messageCount);
      if (!Number.isSafeInteger(count) || count < 1) return false;
      seen.set(row.id, Math.min(last, count));
    }
  }
  epochs.set(row.id, epoch);
  return true;
}

function sharedReadRevision(row: DesktopSessionSummary): number {
  const value = Number(row.readRevision);
  return Number.isSafeInteger(value) && value > 0 ? value : 0;
}

/** A bot chat's or room's row lists the messages that arrived (`incomingTail`):
 *  its growth is unread only when one of them is past the seen count, so the
 *  user's own words and a turn answered by a reaction alone leave no dot. */
function noNewIncoming(row: DesktopSessionSummary | undefined, last: number | undefined): boolean {
  return Array.isArray(row?.incomingTail) && last !== undefined && !row.incomingTail.some((place) => place > last);
}

export function sharedReadClearsUnread(row: DesktopSessionSummary, previousRevision: number | undefined): boolean {
  const revision = sharedReadRevision(row);
  return (
    previousRevision !== undefined &&
    revision > previousRevision &&
    sharedReadCount(row) >= Math.max(0, Number(row.messageCount) || 0)
  );
}

export function shouldPublishSessionRead(
  row: DesktopSessionSummary,
  messageCount: number,
  consumedUnread: boolean
): boolean {
  return consumedUnread || messageCount > sharedReadCount(row);
}

/** Whether `id` is read when the sessions `read` says are: itself, or a
 *  session up its `readWith` chain (the chat a bot's task session reports to,
 *  the session a sub-agent works under). The chain is followed to its end; a
 *  session met twice closes a cycle and stops it. */
export function readAlong(
  id: string,
  upperOf: ReadonlyMap<string, string>,
  read: (sessionId: string) => boolean
): boolean {
  let current = id;
  const visited = new Set<string>();
  while (current && !visited.has(current)) {
    visited.add(current);
    if (read(current)) return true;
    current = upperOf.get(current) ?? '';
  }
  return false;
}

function readWithMap(rows: readonly DesktopSessionSummary[]): Map<string, string> {
  const upper = new Map<string, string>();
  for (const row of rows) if (row.readWith) upper.set(row.id, row.readWith);
  return upper;
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
  return sidebarOpen || dockOpen || bottomPanelOpen || settingsOpen ? '' : target;
}

export function useUnreadSessions({
  viewedSessionRef,
  screenSessionIdsRef,
}: {
  /** The session on screen, including an in-flight switch target. */
  viewedSessionRef: MutableRefObject<string>;
  /** Sessions the window's other visible panes show: read the same way. */
  screenSessionIdsRef?: MutableRefObject<readonly string[]>;
}) {
  const [unreadSessionIds, setUnreadSessionIds] = useState<ReadonlySet<string>>(() => new Set());
  const unreadSessionIdsRef = useRef<ReadonlySet<string>>(new Set());
  // Completion is an activity signal even when a final catalog push races the
  // message-count update: track working -> settled transitions too.
  const previousWorkingSessionIds = useRef<ReadonlySet<string>>(new Set());
  const sharedReadRevisions = useRef<Map<string, number>>(new Map());
  const sessionLastSeen = useRef<Map<string, number> | null>(null);
  // The compaction count each seen count was recorded under (see settleSeen).
  const sessionSeenEpochs = useRef<Map<string, number>>(new Map());

  const loadSeen = useCallback(() => {
    if (sessionLastSeen.current) return sessionLastSeen.current;
    const map = new Map<string, number>();
    try {
      window.localStorage.removeItem(LEGACY_TIMESTAMP_KEY);
      const raw = window.localStorage.getItem(SEEN_COUNTS_KEY);
      const parsed = raw ? (JSON.parse(raw) as Record<string, unknown>) : null;
      for (const [id, at] of Object.entries(parsed || {})) {
        const value = Number(at);
        if (Number.isFinite(value) && value >= 0 && value < MAX_PLAUSIBLE_COUNT) map.set(id, value);
      }
      const rawEpochs = window.localStorage.getItem(SEEN_EPOCHS_KEY);
      const parsedEpochs = rawEpochs ? (JSON.parse(rawEpochs) as Record<string, unknown>) : null;
      for (const [id, at] of Object.entries(parsedEpochs || {})) {
        if (Number.isSafeInteger(at) && (at as number) >= 0) sessionSeenEpochs.current.set(id, at as number);
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
      window.localStorage.setItem(SEEN_EPOCHS_KEY, JSON.stringify(Object.fromEntries(sessionSeenEpochs.current)));
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

  const publishRead = useCallback((row: DesktopSessionSummary, messageCount: number, consumedUnread: boolean) => {
    const markSessionRead = window.mixdogDesktop?.markSessionRead;
    if (typeof markSessionRead !== 'function' || !shouldPublishSessionRead(row, messageCount, consumedUnread)) return;
    try {
      void Promise.resolve(markSessionRead(row.id, messageCount, consumedUnread)).catch(() => undefined);
    } catch {
      // The local cursor remains the fallback when the host lane is unavailable.
    }
  }, []);

  const reconcileUnreadSessions = useCallback(
    (rows: DesktopSessionSummary[]) => {
      const seen = loadSeen();
      const activeId = viewedSessionRef.current;
      const screenIds = new Set(screenSessionIdsRef?.current);
      const liveIds = new Set(rows.map((row) => row.id));
      const workingIds = new Set(rows.filter((row) => row.working === true).map((row) => row.id));
      const completedIds = new Set(
        [...previousWorkingSessionIds.current].filter((id) => liveIds.has(id) && !workingIds.has(id))
      );
      previousWorkingSessionIds.current = workingIds;
      // "Viewed" means the surface is on screen AND focused (see
      // sessionSurfaceEngaged), in any visible pane, focused or not. A bot's
      // task session (and the sub-agents under it) is also read with the chat
      // it reports to: reading that chat reads them.
      const engaged = sessionSurfaceEngaged();
      const upperOf = readWithMap(rows);
      const onScreen = (id: string) => id === activeId || screenIds.has(id);
      const viewing = (id: string) => engaged && readAlong(id, upperOf, onScreen);
      let dirty = false;
      for (const id of [...seen.keys()]) {
        if (liveIds.has(id)) continue;
        seen.delete(id);
        sessionSeenEpochs.current.delete(id);
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
        if (settleSeen(seen, sessionSeenEpochs.current, row, sharedCount)) {
          dirty = true;
          last = seen.get(row.id);
        }
        if (sharedCount > (last ?? -1)) {
          seen.set(row.id, sharedCount);
          last = sharedCount;
          dirty = true;
        }
        // Automation fires are BORN in the background (each fire is a fresh
        // session): their first sighting IS the notification, so they skip the
        // read-by-definition baseline until actually viewed.
        const automationBorn = row.sourceType === 'schedule' || row.sourceType === 'webhook';
        if (last === undefined && automationBorn && !viewing(row.id)) {
          if (count > 0) unread.add(row.id);
          continue;
        }
        if (last === undefined || viewing(row.id)) {
          if (last !== count) {
            seen.set(row.id, count);
            dirty = true;
          }
          if (viewing(row.id)) {
            publishRead(
              row,
              count,
              !remotelyReadIds.has(row.id) && (unreadSessionIdsRef.current.has(row.id) || completedIds.has(row.id))
            );
          }
          continue;
        }
        if (count > last && !noNewIncoming(row, last)) unread.add(row.id);
      }
      if (dirty) persistSeen(seen);
      // Preserve completion-only dots across later catalog pushes until the row
      // is viewed on either surface. A shared revision advance consumes them.
      for (const id of unreadSessionIdsRef.current) {
        if (liveIds.has(id) && !remotelyReadIds.has(id) && !viewing(id)) unread.add(id);
      }
      for (const id of completedIds) {
        const row = rows.find((candidate) => candidate.id === id);
        if (!remotelyReadIds.has(id) && !viewing(id) && !noNewIncoming(row, seen.get(id))) unread.add(id);
      }
      commitUnread(unread);
    },
    [commitUnread, loadSeen, persistSeen, publishRead, screenSessionIdsRef, viewedSessionRef]
  );

  // Viewing a session consumes its marker — but only while the surface is
  // engaged, so a selected session in a hidden or unfocused window keeps its
  // dot. The caller fires this from an effect once the selection is known, and
  // again whenever focus returns. The sessions read with it (a bot chat's task
  // sessions and their sub-agents: readAlong) are consumed with it.
  const consumeUnread = useCallback(
    (viewedSessionId: string, sessions: DesktopSessionSummary[]) => {
      if (!viewedSessionId) return;
      if (!sessionSurfaceEngaged()) return;
      const seen = loadSeen();
      const upperOf = readWithMap(sessions);
      const along = sessions
        .filter((session) => session.id !== viewedSessionId)
        .filter((session) => readAlong(session.id, upperOf, (id) => id === viewedSessionId))
        .map((session) => session.id);
      const current = unreadSessionIdsRef.current;
      const next = new Set(current);
      let dirty = false;
      for (const id of [viewedSessionId, ...along]) {
        const row = sessions.find((session) => session.id === id);
        if (row && settleSeen(seen, sessionSeenEpochs.current, row, sharedReadCount(row))) dirty = true;
        const count = Math.max(Number(row?.messageCount) || 0, seen.get(id) || 0);
        if (count > 0 && seen.get(id) !== count) {
          seen.set(id, count);
          dirty = true;
        }
        const consumedUnread = current.has(id);
        if (row) publishRead(row, count, consumedUnread);
        next.delete(id);
      }
      if (dirty) persistSeen(seen);
      if (next.size !== current.size) commitUnread(next);
    },
    [commitUnread, loadSeen, persistSeen, publishRead]
  );

  return { unreadSessionIds, reconcileUnreadSessions, consumeUnread };
}
