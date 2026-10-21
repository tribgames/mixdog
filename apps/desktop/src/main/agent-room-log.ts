// A group room's log (agent-rooms.ts owns the records): rows are posted into
// the room's log session through the daemon, and read back in log order with
// the rows this host posted, so a row the log's projection has not caught up
// with is never missed.
import {
  type RoomRow,
  roomRowsOfItems,
  roomSessionId,
} from '../../../../src/runtime/agent/orchestrator/session/agent-room.mjs';
import { plainPreviewText } from '../../../../src/runtime/shared/plain-preview.mjs';
import type { AgentRoomDeps, AgentRoomRecord } from './agent-rooms';

const RECENT_ROWS = 200;

/**
 * One list in log order from `read`, a snapshot of the log's tail window (in
 * log order, the authority), and `posted`, the rows this host posted since it
 * started (in log order, a subsequence of the log). The log also holds rows
 * the host never posted (the daemon's task reports), so a row's place comes
 * from the read, never from who posted it or from its `at` (a report carries
 * the time it was queued, not posted). A posted row the read lacks sits
 * before the window when a later posted row is in it (it fell out of the
 * tail), and after it otherwise (the read has not caught up with it). With no
 * posted row in the window, time decides which side the posted rows go.
 */
export function inLogOrder(read: RoomRow[], posted: RoomRow[]): RoomRow[] {
  const at = new Map(read.map((row, index) => [row.id, index]));
  const older: RoomRow[] = [];
  const before = new Map<number, RoomRow[]>();
  let pending: RoomRow[] = [];
  let shared = false;
  for (const row of posted) {
    const index = at.get(row.id);
    if (index === undefined) {
      pending.push(row);
      continue;
    }
    // Rows ahead of the first shared one fell out of the window; any between
    // two shared ones go right before the later one.
    if (shared) before.set(index, pending);
    else older.push(...pending);
    shared = true;
    pending = [];
  }
  if (!shared) {
    const opens = read.at(-1)?.at;
    const newer = !read.length || !(typeof opens === 'number' && Number(posted[0]?.at) <= opens);
    return newer ? [...read, ...posted] : [...posted, ...read];
  }
  return [...older, ...read.flatMap((row, index) => [...(before.get(index) ?? []), row]), ...pending];
}

export function createRoomLog(
  deps: Pick<AgentRoomDeps, 'appendRows' | 'readItems' | 'republishCatalog'>,
  rooms: () => Record<string, AgentRoomRecord>
) {
  /** Rows this host posted, per room. */
  const recent = new Map<string, RoomRow[]>();
  return {
    async post(roomId: string, rows: RoomRow[]): Promise<void> {
      const stored = (await deps.appendRows(roomSessionId(roomId), rows)) as { rows?: unknown } | undefined;
      // The log's copies: a user row's files as stored references, never bytes.
      const kept = Array.isArray(stored?.rows) ? (stored.rows as RoomRow[]) : rows;
      const list = [...(recent.get(roomId) ?? []), ...kept].slice(-RECENT_ROWS);
      recent.set(roomId, list);
      // The list row's preview follows every spoken line, as a home thread's does.
      const said = [...rows].reverse().find((row) => row.kind === 'user' || row.kind === 'speech');
      const room = rooms()[roomId];
      if (said && room) {
        room.lastPreview = plainPreviewText(said.text).slice(0, 200);
        deps.republishCatalog();
      }
    },
    /** The room's rows in log order. */
    async rows(roomId: string): Promise<RoomRow[]> {
      const read = roomRowsOfItems(await deps.readItems(roomSessionId(roomId)).catch(() => []));
      return inLogOrder(read, recent.get(roomId) ?? []);
    },
    /** The room's log was removed or emptied: its posted rows go too. */
    forget(roomId: string): void {
      recent.delete(roomId);
    },
  };
}
