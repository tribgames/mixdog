// The one reader of the daemon's per-row wire for the global lists
// (D:\mixdog-build\tmp\node-status\wire.md v2, "Global lists"): a frame
//   { kind: 'list-row', list, epoch, seq, id, after, row } | { ..., id, removed: true }
// and a read answer { list, epoch, seq, rows }. Should the wire's names change,
// only this file does.
import type { DesktopAgentPoolRow, DesktopSessionSummary } from '../shared/contract';
import type { RowChange, RowList } from '../shared/row-notifications';
import type { DesktopServiceOutbound } from './desktop-service-protocol';

export type ListRowName = 'agent-pool' | 'sessions';

export interface ListRows {
  'agent-pool': DesktopAgentPoolRow;
  sessions: DesktopSessionSummary;
}

/** The daemon's diff point of one list (`desktopRuntime.listRowFeed(list)`):
 *  `publish` returns the row frames of a whole publication, `read` the answer. */
export interface ListRowFeed {
  publish(rows: readonly unknown[]): Extract<DesktopServiceOutbound, { kind: 'list-row' }>[];
  read(): unknown;
}

/** The service method answering a read; its only argument is the list name
 *  (the daemon's registry appends the caller's client epoch, desktop-asks.md). */
export const LIST_ROW_READ_METHOD = 'readListRows';

/** The end of one publication of a list (desktop-asks.md): every frame up to
 *  `seq` is in it; sent for an unchanged publication too. One kind per list,
 *  so a backed-up stream keeps the lists' markers apart. */
export const LIST_PUBLISHED_KIND = {
  sessions: 'sessions-published',
  'agent-pool': 'agent-pool-published',
} as const;

export interface ListPublishedMarker {
  list: ListRowName;
  epoch: string;
  seq: number;
}

export function listPublishedMarker(list: ListRowName, epoch: string, seq: number) {
  return { kind: LIST_PUBLISHED_KIND[list], list, epoch, seq };
}

export function readListPublishedMarker(message: unknown): ListPublishedMarker | null {
  const marker = message as Record<string, unknown> | null;
  if (!marker || !isList(marker.list) || marker.kind !== LIST_PUBLISHED_KIND[marker.list]) return null;
  if (typeof marker.epoch !== 'string' || !Number.isSafeInteger(marker.seq)) return null;
  return { list: marker.list, epoch: marker.epoch, seq: marker.seq as number };
}

/** Which clients (by the registry's client epoch) a service message is for:
 *  a registry that cannot route (today's) delivers to every client. */
export interface ServiceDelivery {
  to?: readonly number[];
  except?: readonly number[];
}

export interface ListRowFrame<Row> {
  list: ListRowName;
  epoch: string;
  seq: number;
  change: RowChange<Row>;
}

export interface ListRowAnswer<Row> extends RowList<Row> {
  epoch: string;
  seq: number;
}

/** A row's identity on the wire. */
const ROW_ID: { [List in ListRowName]: (row: ListRows[List]) => unknown } = {
  'agent-pool': (row) => row?.sessionId,
  sessions: (row) => row?.id,
};

const isList = (value: unknown): value is ListRowName => value === 'agent-pool' || value === 'sessions';

export function readListRowFrame(message: unknown): ListRowFrame<unknown> | null {
  const frame = message as Record<string, unknown> | null;
  if (!frame || frame.kind !== 'list-row' || !isList(frame.list)) return null;
  const id = typeof frame.id === 'string' ? frame.id : '';
  if (!id || typeof frame.epoch !== 'string' || !Number.isSafeInteger(frame.seq)) return null;
  const change: RowChange<unknown> =
    frame.removed === true
      ? { id, removed: true }
      : { id, after: typeof frame.after === 'string' ? frame.after : null, row: frame.row };
  return { list: frame.list, epoch: frame.epoch, seq: frame.seq as number, change };
}

/** A whole-list message (`sessions` / `agent-pool`) tagged with the row-feed
 *  position it stands at, as an answer; null when untagged (a service without
 *  row feeds, which an older client keeps by whole lists alone). */
export function readWholeList<List extends ListRowName>(list: List, message: unknown): ListRowAnswer<ListRows[List]> | null {
  const whole = message as Record<string, unknown> | null;
  if (!whole || typeof whole.epoch !== 'string' || !Number.isSafeInteger(whole.seq)) return null;
  const rows = list === 'sessions' ? whole.sessions : whole.agents;
  return readListRowAnswer(list, { list, epoch: whole.epoch, seq: whole.seq, rows });
}

export function readListRowAnswer<List extends ListRowName>(list: List, value: unknown): ListRowAnswer<ListRows[List]> {
  const answer = value as Record<string, unknown> | null;
  if (!answer || answer.list !== list || typeof answer.epoch !== 'string' || !Number.isSafeInteger(answer.seq)) {
    throw new Error(`malformed ${list} row list`);
  }
  const rows = (Array.isArray(answer.rows) ? answer.rows : []) as ListRows[List][];
  return {
    epoch: answer.epoch,
    seq: answer.seq as number,
    ids: rows.map((row) => String(ROW_ID[list](row) ?? '')),
    rows,
  };
}
