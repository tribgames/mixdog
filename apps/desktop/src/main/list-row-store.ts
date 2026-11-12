// One global list kept from the daemon's row frames (wire.md "Consistent
// start"): read the list, hold what arrives until the answer, apply what comes
// after it by seq, then everything in order; a gap, an unknown predecessor or
// another epoch reads again, and an answer older than what is held is dropped.
// Each frame is handed on the moment it is applied — nothing is batched,
// merged or deferred, so every change reaches the reducers, in order. Whole-list
// consumers are told once per daemon publication (its marker), with the list
// as it stood at that boundary. Per frame: O(1) (OrderedRows).
//
// Invariant: `rows` is exactly what has been delivered downstream (every
// change handed to `onChange`, applied in order). It is the baseline of every
// later diff and survives a disconnect; a disconnect only marks the copy as not
// current. After any read is applied, downstream equals the read list: the
// read is delivered as its diff against `rows` — removals included — so a
// daemon that came back with fewer, no or reordered rows is followed exactly.
// Held frames that continue `rows` (same epoch, next seq) are delivered before
// the answer, one by one (frames `rows` already covers are skipped): an answer
// covering them would otherwise skip steps the reducers are sensitive to (a
// run's origin, a cancel).
//
// Nothing published from the subscription resuming to the read's answer is
// dropped. Until the service has handled this client's read it does not know
// the client reads rows and sends it the whole lists, each tagged with the
// feed position it stands at (global-list-publisher.ts); every one newer than
// `rows` is delivered as it arrives, like an answer (its diff, change by
// change), and the row frames then continue from the answer's seq. A whole
// list, frame or answer at or before what `rows` holds changes nothing.
import { diffRows, OrderedRows, type RowChange, type RowList } from '../shared/row-notifications';
import type { ListPublishedMarker, ListRowAnswer, ListRowFrame } from './list-row-adapter';

interface ListRowStoreOptions<Row> {
  read(): Promise<ListRowAnswer<Row>>;
  /** Each change as it is applied (a read that replaced the list: its diff, change by change). */
  onChange(change: RowChange<Row>): void;
  /** The list at each publication boundary, and after each read. */
  onPublication(rows: Row[]): void;
}

type Held<Row> = { frame: ListRowFrame<Row> } | { marker: ListPublishedMarker };

export class ListRowStore<Row> {
  /** What downstream holds (see the invariant above). */
  private rows = new OrderedRows<Row>();
  private epoch = '';
  private seq = 0;
  /** `rows` is the daemon's list as of `seq` on the live connection. */
  private current = false;
  /** A read has answered: the daemon sends row frames. */
  private active = false;
  private reading: Promise<RowList<Row>> | null = null;
  /** Bumped by every reconnect; a read begun before one is followed by another. */
  private connection = 0;
  private held: Held<Row>[] = [];
  /** The position whole-list consumers were last told (once per publication). */
  private told = '';

  constructor(private readonly options: ListRowStoreOptions<Row>) {}

  /** Whether row frames, not whole-list messages, keep this list. */
  isActive(): boolean {
    return this.active;
  }

  /** The current list, read first when it is not current. */
  currentList(): Promise<RowList<Row>> {
    if (this.current && !this.reading) return Promise.resolve(this.rows.list());
    return this.resync();
  }

  /** The current list, or null while it is not current. */
  currentRows(): Row[] | null {
    return this.current && !this.reading ? this.rows.rows() : null;
  }

  /** Reads the whole list again (start, reconnect, a gap). */
  resync(): Promise<RowList<Row>> {
    if (this.reading) return this.reading;
    const connection = this.connection;
    const reading = this.options.read().then(
      (answer) => {
        this.reading = null;
        this.active = true;
        this.held = this.deliverContinuing(this.held);
        if (!(this.epoch && answer.epoch === this.epoch && answer.seq < this.seq)) {
          this.apply(answer);
          this.tell(true);
        }
        if (connection !== this.connection) return this.resync();
        this.current = true;
        const held = this.held;
        this.held = [];
        for (const entry of held) {
          if ('frame' in entry) this.receive(entry.frame);
          else this.published(entry.marker, true);
        }
        return this.rows.list();
      },
      (error: unknown) => {
        this.reading = null;
        if (connection !== this.connection) return this.resync();
        // An older service: its whole-list messages keep the list.
        this.active = false;
        throw error;
      }
    );
    this.reading = reading;
    reading.catch(() => undefined);
    return reading;
  }

  receive(frame: ListRowFrame<Row>): void {
    if (this.reading || !this.current) {
      this.hold({ frame });
      return;
    }
    if (frame.epoch === this.epoch && frame.seq <= this.seq) return;
    if (frame.epoch !== this.epoch || frame.seq !== this.seq + 1 || !this.rows.apply(frame.change)) {
      this.held = [{ frame }];
      void this.resync().catch(() => undefined);
      return;
    }
    this.seq = frame.seq;
    this.options.onChange(frame.change);
  }

  /** A publication's end; `replayed`: held while reading, so the read or a
   *  whole list may already have told its list. */
  published(marker: ListPublishedMarker, replayed = false): void {
    if (this.reading || !this.current) {
      this.hold({ marker });
      return;
    }
    if (marker.epoch === this.epoch && marker.seq === this.seq) {
      this.tell(replayed);
      return;
    }
    // A marker ahead of the frames held means frames were lost.
    if (marker.epoch !== this.epoch || marker.seq > this.seq) {
      this.held = [{ marker }];
      void this.resync().catch(() => undefined);
    }
  }

  /** The connection is gone: the copy is no longer current, and what arrives
   *  waits for the next read. What downstream holds is unchanged. */
  disconnect(): void {
    this.current = false;
    this.connection += 1;
    this.told = '';
  }

  /** A whole list the service sent this client (see the header): delivered
   *  in arrival order, after the held frames that continue `rows`, when it is
   *  newer than what `rows` holds. */
  receiveWhole(list: ListRowAnswer<Row>): void {
    const live = this.current && !this.reading;
    this.held = this.deliverContinuing(this.held);
    const sameFeed = Boolean(this.epoch) && list.epoch === this.epoch;
    if (sameFeed && list.seq < this.seq) return;
    if (!sameFeed || list.seq > this.seq) this.apply(list);
    // A live row client is told by the publication's marker (a registry that
    // cannot route sends it both); before the read, the whole list is the publication.
    if (!live) this.tell();
  }

  /** A new connection: frames are not replayed, so a list ever held is read
   *  again (after the read in flight, if one was begun on the old connection). */
  reconnected(): void {
    this.connection += 1;
    if (this.epoch) void this.resync().catch(() => undefined);
  }

  private hold(entry: Held<Row>): void {
    this.held.push(entry);
    if (!this.reading) void this.resync().catch(() => undefined);
  }

  /** Held frames that continue what downstream holds (same epoch, next seq)
   *  are history an answer only sums up: delivered first, one by one, with
   *  their publication markers; frames and markers `rows` already covers are
   *  skipped. Returns what is left held, from the first entry that does not
   *  continue `rows`. */
  private deliverContinuing(held: Held<Row>[]): Held<Row>[] {
    for (let index = 0; index < held.length; index += 1) {
      const entry = held[index];
      if ('marker' in entry) {
        if (entry.marker.epoch !== this.epoch || entry.marker.seq > this.seq) return held.slice(index);
        if (entry.marker.seq === this.seq) this.tell(true);
        continue;
      }
      const { frame } = entry;
      if (!this.epoch || frame.epoch !== this.epoch) return held.slice(index);
      if (frame.seq <= this.seq) continue;
      if (frame.seq !== this.seq + 1 || !this.rows.apply(frame.change)) return held.slice(index);
      this.seq = frame.seq;
      this.options.onChange(frame.change);
    }
    return [];
  }

  /** Delivers `answer` downstream as its diff against what downstream holds. */
  private apply(answer: ListRowAnswer<Row>): void {
    const previous = this.rows.list();
    const json = (row: Row) => JSON.stringify(row);
    const changes = diffRows(previous, answer, json);
    this.rows = new OrderedRows(answer);
    this.epoch = answer.epoch;
    this.seq = answer.seq;
    for (const change of changes) this.options.onChange(change);
  }

  /** Tells whole-list consumers the list: at every publication, and `once`
   *  where another path (a read, a whole list, a replayed marker) may already
   *  have told this position since the last disconnect. */
  private tell(once = false): void {
    const position = `${this.epoch}\0${this.seq}`;
    if (once && position === this.told) return;
    this.told = position;
    this.options.onPublication(this.rows.rows());
  }
}
