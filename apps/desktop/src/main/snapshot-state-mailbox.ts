import { createLatestStateMailbox, type LatestStateMailbox } from './desktop-service-protocol';
import { createSnapshotDeltaEncoder, isNoDelta } from './state-delta';

/** Only transmitted snapshots wait for a receiver acknowledgement. An
 * unchanged snapshot has no wire payload and must release its own slot. */
export function createSnapshotStateMailbox<T>(
  send: (sequence: number, wire: unknown) => void,
): LatestStateMailbox<T> {
  const encoder = createSnapshotDeltaEncoder();
  const mailbox = createLatestStateMailbox<T>((sequence, snapshot) => {
    const wire = encoder.encode(snapshot);
    if (isNoDelta(wire)) {
      mailbox.acknowledge(sequence);
      return;
    }
    send(sequence, wire);
  });
  return {
    publish: mailbox.publish,
    acknowledge: mailbox.acknowledge,
    reset(snapshot): void {
      encoder.reset();
      mailbox.reset(snapshot);
    },
    clear(): void {
      encoder.reset();
      mailbox.clear();
    },
  };
}
