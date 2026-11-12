// A list kept from per-row notifications (shared/row-notifications.ts): read
// once, then every numbered message applied in order, each handed on as the
// whole list it leaves (main sends one change per message on the daemon's
// row lane, so the reducers run once per change). Messages arriving during a
// read wait for it; those the read already covers are dropped; a missing
// number reads the whole list again.
import { OrderedRows, type RowChanges, type RowListSnapshot } from '../shared/row-notifications';

interface RowListFeedOptions<Row> {
  subscribe(listener: (changes: RowChanges<Row>) => void): () => void;
  read(): Promise<RowListSnapshot<Row>>;
  /** The list after the read and after each message, every one in order. */
  onList(rows: Row[]): void;
  onReadError?(): void;
}

export function followRowList<Row>({ subscribe, read, onList, onReadError }: RowListFeedOptions<Row>): () => void {
  let rows = new OrderedRows<Row>();
  let seq: number | null = null;
  let reading = false;
  let stopped = false;
  let waiting: RowChanges<Row>[] = [];

  const apply = (message: RowChanges<Row>): void => {
    if (seq === null || message.seq <= seq) return;
    if (message.seq !== seq + 1 || !message.changes.every((change) => rows.apply(change))) {
      waiting = [message];
      load();
      return;
    }
    seq = message.seq;
    // O(n): the reducers take the whole list, and themselves map every row.
    onList(rows.rows());
  };

  const load = (): void => {
    if (reading) return;
    reading = true;
    seq = null;
    read().then(
      (snapshot) => {
        reading = false;
        if (stopped) return;
        rows = new OrderedRows(snapshot);
        seq = snapshot.seq;
        onList(rows.rows());
        const held = waiting;
        waiting = [];
        for (const message of held) apply(message);
      },
      () => {
        reading = false;
        if (!stopped) onReadError?.();
      }
    );
  };

  const unsubscribe = subscribe((message) => {
    if (stopped || !message || !Array.isArray(message.changes)) return;
    if (seq === null) {
      waiting.push(message);
      load();
      return;
    }
    apply(message);
  });
  load();
  return () => {
    stopped = true;
    unsubscribe();
  };
}
