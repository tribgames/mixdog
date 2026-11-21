import { useCallback, useRef, useState, type MutableRefObject } from 'react';

import type { DesktopSessionSummary } from '../shared/contract';

const SEEN_COUNTS_KEY = 'mixdog.desktop.session-seen-counts';
const SEEN_EPOCHS_KEY = 'mixdog.desktop.session-seen-epochs';
const LEGACY_TIMESTAMP_KEY = 'mixdog.desktop.session-last-seen';
// Counts are small; a timestamp mistakenly stored as a count (~1.7e12) would
// suppress the dot forever, so absurd values are dropped and re-baselined.
const MAX_PLAUSIBLE_COUNT = 1e7;

/** Reading requires attention: the surface is visible AND focused. A host
 *  without `hasFocus` degrades to visibility alone. */
export function sessionSurfaceEngaged(): boolean {
  if (typeof document === 'undefined') return false;
  if (document.visibilityState !== 'visible') return false;
  return typeof document.hasFocus === 'function' ? document.hasFocus() : true;
}

function sharedReadCount(row: DesktopSessionSummary): number {
  const value = Number(row.readMessageCount);
  return Number.isInteger(value) && value >= 0 && value <= MAX_PLAUSIBLE_COUNT ? value : 0;
}

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

/** The per-session seen message counts (and the compaction epoch each was
 *  recorded under, see settleSeen), persisted to localStorage. */
function createSeenStore() {
  let counts: Map<string, number> | null = null;
  const epochs = new Map<string, number>();
  return {
    epochs,
    load(): Map<string, number> {
      if (counts) return counts;
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
          if (Number.isSafeInteger(at) && (at as number) >= 0) epochs.set(id, at as number);
        }
      } catch {
        // Unread markers degrade to in-memory tracking without persistent storage.
      }
      counts = map;
      return map;
    },
    // The epoch map is written only when an epoch changed: a count-only change
    // must not reserialize every session's epoch.
    persist(map: Map<string, number>, epochsChanged: boolean) {
      try {
        window.localStorage.setItem(SEEN_COUNTS_KEY, JSON.stringify(Object.fromEntries(map)));
        if (epochsChanged) {
          window.localStorage.setItem(SEEN_EPOCHS_KEY, JSON.stringify(Object.fromEntries(epochs)));
        }
      } catch {
        // Unread markers degrade to in-memory tracking without persistent storage.
      }
    },
  };
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
  const [seenStore] = useState(createSeenStore);

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
      const seen = seenStore.load();
      const activeId = viewedSessionRef.current;
      const screenIds = new Set(screenSessionIdsRef?.current);
      const liveIds = new Set(rows.map((row) => row.id));
      const workingIds = new Set(rows.filter((row) => row.working === true).map((row) => row.id));
      const completedIds = new Set(
        [...previousWorkingSessionIds.current].filter((id) => liveIds.has(id) && !workingIds.has(id))
      );
      previousWorkingSessionIds.current = workingIds;
      const engaged = sessionSurfaceEngaged();
      const upperOf = readWithMap(rows);
      const onScreen = (id: string) => id === activeId || screenIds.has(id);
      const viewing = (id: string) => engaged && readAlong(id, upperOf, onScreen);
      let dirty = false;
      let epochsDirty = false;
      for (const id of [...seen.keys()]) {
        if (liveIds.has(id)) continue;
        seen.delete(id);
        if (seenStore.epochs.delete(id)) epochsDirty = true;
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
        if (settleSeen(seen, seenStore.epochs, row, sharedCount)) {
          dirty = true;
          epochsDirty = true;
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
      if (dirty) seenStore.persist(seen, epochsDirty);
      // Preserve completion-only dots across later catalog pushes until the row
      // is viewed on either surface. A shared revision advance consumes them.
      for (const id of unreadSessionIdsRef.current) {
        if (liveIds.has(id) && !remotelyReadIds.has(id) && !viewing(id)) unread.add(id);
      }
      const rowById = completedIds.size ? new Map(rows.map((row) => [row.id, row])) : null;
      for (const id of completedIds) {
        const row = rowById?.get(id);
        if (!remotelyReadIds.has(id) && !viewing(id) && !noNewIncoming(row, seen.get(id))) unread.add(id);
      }
      commitUnread(unread);
    },
    [commitUnread, seenStore, publishRead, screenSessionIdsRef, viewedSessionRef]
  );

  const consumeUnread = useCallback(
    (viewedSessionId: string, sessions: DesktopSessionSummary[]) => {
      if (!viewedSessionId) return;
      if (!sessionSurfaceEngaged()) return;
      const seen = seenStore.load();
      const upperOf = readWithMap(sessions);
      const along = sessions
        .filter((session) => session.id !== viewedSessionId)
        .filter((session) => readAlong(session.id, upperOf, (id) => id === viewedSessionId))
        .map((session) => session.id);
      const current = unreadSessionIdsRef.current;
      const next = new Set(current);
      let dirty = false;
      let epochsDirty = false;
      const rowById = new Map(sessions.map((session) => [session.id, session]));
      for (const id of [viewedSessionId, ...along]) {
        const row = rowById.get(id);
        if (row && settleSeen(seen, seenStore.epochs, row, sharedReadCount(row))) {
          dirty = true;
          epochsDirty = true;
        }
        const count = Math.max(Number(row?.messageCount) || 0, seen.get(id) || 0);
        if (count > 0 && seen.get(id) !== count) {
          seen.set(id, count);
          dirty = true;
        }
        const consumedUnread = current.has(id);
        if (row) publishRead(row, count, consumedUnread);
        next.delete(id);
      }
      if (dirty) seenStore.persist(seen, epochsDirty);
      if (next.size !== current.size) commitUnread(next);
    },
    [commitUnread, seenStore, publishRead]
  );

  return { unreadSessionIds, reconcileUnreadSessions, consumeUnread };
}
