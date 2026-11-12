// The session list and the agent pool travel as per-row changes, the shape the
// daemon sends them in (wire.md "Global lists"): one row upserted right after
// the row `after` (null: first), or one row removed. Applied in order to the
// last read they rebuild the list exactly. Main → renderer numbers each batch
// of changes (`seq`); the whole list moves only through an explicit read.
import type { DesktopAgentPoolRow, DesktopSessionSummary } from './contract';
import { desktopAgentIdentity } from './agent-activity';

export type RowChange<Row> = { id: string; after: string | null; row: Row } | { id: string; removed: true };

/** A list with the id of each row. */
export interface RowList<Row> {
  ids: string[];
  rows: Row[];
}

/** One source change of a list: every row it changed, applied together. */
export interface RowChanges<Row> {
  seq: number;
  changes: RowChange<Row>[];
}

/** The whole list as of notification `seq`. */
export interface RowListSnapshot<Row> extends RowList<Row> {
  seq: number;
}

export const sessionRowKey = (row: DesktopSessionSummary): string => String(row?.id ?? '');

export const agentPoolRowKey = (row: DesktopAgentPoolRow): string =>
  `${String(row?.sessionId || '')}\0${desktopAgentIdentity(row)}`;

/** One id per row: its key, numbered when a list repeats the key. */
export function rowIds<Row>(rows: readonly Row[], keyOf: (row: Row) => string): string[] {
  const seen = new Map<string, number>();
  return rows.map((row) => {
    const key = keyOf(row);
    const repeat = seen.get(key) ?? 0;
    seen.set(key, repeat + 1);
    return repeat ? `${key}\0#${repeat}` : key;
  });
}

interface RowNode<Row> {
  row: Row;
  prev: string | null;
  next: string | null;
}

/** A list indexed by row id and ordered as a doubly linked chain, so one
 *  change costs O(1) (a map lookup and relinking), never a scan or a splice
 *  of the whole list. Reading the list out (`rows()`, `list()`) is O(n) and
 *  happens only where a whole array is needed. Untouched rows keep their
 *  object identity. */
export class OrderedRows<Row> {
  private readonly nodes = new Map<string, RowNode<Row>>();
  private head: string | null = null;
  private tail: string | null = null;

  constructor(list?: RowList<Row>) {
    if (list) list.ids.forEach((id, index) => this.insertAfter(id, list.rows[index], this.tail));
  }

  get size(): number {
    return this.nodes.size;
  }

  /** Applies one change; false (nothing changed) when it names a
   *  predecessor this list lacks, which only a read can repair. */
  apply(change: RowChange<Row>): boolean {
    if ('removed' in change) {
      this.unlink(change.id);
      return true;
    }
    if (change.after !== null && (change.after === change.id || !this.nodes.has(change.after))) return false;
    this.unlink(change.id);
    this.insertAfter(change.id, change.row, change.after);
    return true;
  }

  rows(): Row[] {
    const rows: Row[] = [];
    for (let id = this.head; id !== null; id = this.nodes.get(id)!.next) rows.push(this.nodes.get(id)!.row);
    return rows;
  }

  list(): RowList<Row> {
    const ids: string[] = [];
    const rows: Row[] = [];
    for (let id = this.head; id !== null; id = this.nodes.get(id)!.next) {
      ids.push(id);
      rows.push(this.nodes.get(id)!.row);
    }
    return { ids, rows };
  }

  private unlink(id: string): void {
    const node = this.nodes.get(id);
    if (!node) return;
    if (node.prev === null) this.head = node.next;
    else this.nodes.get(node.prev)!.next = node.next;
    if (node.next === null) this.tail = node.prev;
    else this.nodes.get(node.next)!.prev = node.prev;
    this.nodes.delete(id);
  }

  private insertAfter(id: string, row: Row, after: string | null): void {
    const next = after === null ? this.head : this.nodes.get(after)!.next;
    this.nodes.set(id, { row, prev: after, next });
    if (after === null) this.head = id;
    else this.nodes.get(after)!.next = id;
    if (next === null) this.tail = id;
    else this.nodes.get(next)!.prev = id;
  }
}

/** The changes that turn `list` into `next`: removals first, then every row
 *  that is new, changed (by `signature`) or out of place, in its new order. */
export function diffRows<Row>(
  list: RowList<Row>,
  next: RowList<Row>,
  signature: (row: Row, id: string, side: 'previous' | 'next') => string
): RowChange<Row>[] {
  const changes: RowChange<Row>[] = [];
  const kept = new Set(next.ids);
  const previousRows = new Map(list.ids.map((id, index) => [id, list.rows[index]]));
  const order = list.ids.filter((id) => {
    if (kept.has(id)) return true;
    changes.push({ id, removed: true });
    return false;
  });
  next.ids.forEach((id, index) => {
    const previous = previousRows.get(id);
    const row = next.rows[index];
    if (
      order[index] === id &&
      previous !== undefined &&
      signature(previous, id, 'previous') === signature(row, id, 'next')
    ) {
      return;
    }
    const at = order.indexOf(id);
    if (at >= 0) order.splice(at, 1);
    order.splice(index, 0, id);
    changes.push({ id, after: index > 0 ? next.ids[index - 1] : null, row });
  });
  return changes;
}
