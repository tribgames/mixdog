import {
  diffRows,
  OrderedRows,
  rowIds,
  type RowChange,
  type RowChanges,
  type RowList,
  type RowListSnapshot,
} from '../shared/row-notifications';

interface RowLaneSource<Row> {
  /** The whole list from the host (a host without row changes). */
  list(): Promise<Row[]>;
  /** The host's own row list, which its row changes continue; rejects when
   *  the host's service has none (an older daemon). */
  rowList?(): Promise<RowList<Row>>;
}

/** What the renderer holds of one list, kept by per-row changes: forwarded
 *  one call at a time from a host that has them (each call is one renderer
 *  message, so every change reaches the renderer's reducers on its own), else
 *  diffed here from each whole list by row identity (one message per list).
 *  Nothing is sent before the renderer's first read. */
export class RendererRowLane<Row> {
  private rows = new OrderedRows<Row>();
  /** Serialised rows by id (whole-list mode only). */
  private signatures = new Map<string, string>();
  private seq = 0;
  private mode: 'rows' | 'lists' | null = null;
  private read = false;

  constructor(
    private readonly keyOf: (row: Row) => string,
    private readonly source: RowLaneSource<Row>,
    private readonly send: (message: RowChanges<Row>) => void
  ) {}

  /** A whole list from the host; ignored once the host's row changes drive the lane. */
  fromList(value: readonly Row[]): void {
    if (this.mode === 'rows') return;
    const rows = Array.isArray(value) ? value.slice() : [];
    const next = { ids: rowIds(rows, this.keyOf), rows };
    const nextSignatures = new Map(next.ids.map((id, index) => [id, JSON.stringify(rows[index])]));
    const changes = diffRows(this.rows.list(), next, (_row, id, side) =>
      side === 'next' ? (nextSignatures.get(id) ?? '') : (this.signatures.get(id) ?? '')
    );
    this.rows = new OrderedRows(next);
    this.signatures = nextSignatures;
    this.publish(changes);
  }

  /** Row changes from the host, in its order: O(1) per change here. */
  fromChanges(changes: readonly RowChange<Row>[]): void {
    if (this.mode !== 'rows' || changes.length === 0) return;
    for (const change of changes) this.rows.apply(change);
    this.publish(changes.slice());
  }

  /** The renderer's read: the whole list as of the last change it was sent. */
  async snapshot(): Promise<RowListSnapshot<Row>> {
    if (this.mode === null && this.source.rowList) {
      try {
        const list = await this.source.rowList();
        if (this.mode === null) {
          this.rows = new OrderedRows(list);
          this.mode = 'rows';
        }
      } catch {
        this.mode = 'lists';
      }
    }
    if (this.mode !== 'rows') {
      this.mode = 'lists';
      this.fromList(await this.source.list());
    }
    this.read = true;
    return { seq: this.seq, ...this.rows.list() };
  }

  private publish(changes: RowChange<Row>[]): void {
    if (changes.length === 0) return;
    this.seq += 1;
    if (this.read) this.send({ seq: this.seq, changes });
  }
}
