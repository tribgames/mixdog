import { useMemo } from 'react';
import type { Snapshot } from './desktop-types';
import { defaultSessionLaneStore, useSessionLane } from './session-lane-store';
import { resolveSessionRows } from './turn-review-model';
import { useSessionDiffRefresh } from './use-session-diff-refresh';

function activityKey(snapshot: Snapshot | null): string {
  const items = Array.isArray(snapshot?.items) ? snapshot.items : [];
  const last = items.at(-1);
  return [
    items.length,
    String(last?.id || ''),
    String(last?.completedAt || last?.completedCount || ''),
    String(snapshot?.contentRevision ?? ''),
    snapshot?.busy ? '1' : '0',
    snapshot?.commandBusy ? '1' : '0',
  ].join(':');
}

function sessionDiffSnapshotsEqual(left: Snapshot, right: Snapshot): boolean {
  return activityKey(left) === activityKey(right);
}

/** The session's diff rows: the runtime diff, refreshed on session activity,
 *  completed with the transcript's own edits. */
export function useSessionDiffRows(sessionId: string, active: boolean, cwd: string | undefined) {
  const lane = useSessionLane(sessionId, defaultSessionLaneStore, sessionDiffSnapshotsEqual, active);
  const revision = activityKey(lane);
  const busy = Boolean(lane?.busy || lane?.commandBusy);
  // A revisited session paints its cached rows instantly while the refresh
  // below revalidates behind them.
  const { result, loading, error, refresh, adoptions } = useSessionDiffRefresh({
    sessionId,
    active,
    revision,
    busy,
  });
  // The island completes the runtime diff with the transcript's own edits;
  // the pane does the same so its list, title and totals match the island.
  const laneItems = lane?.items;
  const rows = useMemo(
    () => resolveSessionRows(result, Array.isArray(laneItems) ? laneItems : [], cwd),
    [result, laneItems, cwd]
  );
  return { revision, busy, result, loading, error, refresh, adoptions, rows };
}
