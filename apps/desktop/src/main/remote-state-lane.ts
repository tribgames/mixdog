import { createSnapshotDeltaEncoder, isNoDelta } from './state-delta';
import { createLatestStateMailbox, type LatestStateMailbox } from './desktop-service-protocol';

/** Each receiver owns its baseline and one coalescing mailbox. Recovering a
 *  sleeping phone must not invalidate another phone's healthy delta stream. */
export function createRemoteStateLane(
  compact: boolean,
  send: (payload: unknown, droppable: boolean) => Promise<void>,
) {
  const encoder = createSnapshotDeltaEncoder({ compact });
  type Publication = { snapshot: unknown; critical: boolean };
  let lastDelivery: Promise<void> = Promise.resolve();
  let mailbox!: LatestStateMailbox<Publication>;
  mailbox = createLatestStateMailbox((sequence, { snapshot, critical }) => {
    const wire = encoder.encode(snapshot);
    const delivered = isNoDelta(wire)
      ? Promise.resolve()
      : send(compact ? { e: 'S', w: wire } : { event: 'state', payload: wire }, !critical);
    lastDelivery = delivered;
    void delivered.catch(() => undefined).finally(() => mailbox.acknowledge(sequence));
  });
  return {
    publish(snapshot: unknown): void { mailbox.publish({ snapshot, critical: false }); },
    reset(snapshot: unknown): Promise<void> {
      encoder.reset();
      mailbox.reset({ snapshot, critical: true });
      return lastDelivery;
    },
    clear(): void {
      encoder.reset();
      mailbox.clear();
    },
  };
}
