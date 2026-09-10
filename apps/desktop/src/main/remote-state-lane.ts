import { createSnapshotDeltaEncoder, isNoDelta } from './state-delta';
import { createLatestStateMailbox, type LatestStateMailbox } from './desktop-service-protocol';

/** Each receiver owns its baseline and one coalescing mailbox. Recovering a
 *  sleeping phone must not invalidate another phone's healthy delta stream. */
export function createRemoteStateLane(
  compact: boolean,
  send: (payload: unknown, droppable: boolean) => Promise<void>,
) {
  const encoder = createSnapshotDeltaEncoder({ compact });
  type Publication = {
    snapshot: unknown;
    critical: boolean;
    baselineSend?: (payload: unknown) => Promise<void>;
  };
  let lastDelivery: Promise<void> = Promise.resolve();
  let mailbox!: LatestStateMailbox<Publication>;
  mailbox = createLatestStateMailbox((sequence, { snapshot, critical, baselineSend }) => {
    const wire = encoder.encode(snapshot);
    const payload = compact ? { e: 'S', w: wire } : { event: 'state', payload: wire };
    const delivered = isNoDelta(wire)
      ? Promise.resolve()
      : baselineSend ? baselineSend(payload) : send(payload, !critical);
    lastDelivery = delivered;
    void delivered.catch(() => undefined).finally(() => mailbox.acknowledge(sequence));
  });
  return {
    publish(snapshot: unknown): void { mailbox.publish({ snapshot, critical: false }); },
    reset(snapshot: unknown, baselineSend?: (payload: unknown) => Promise<void>): Promise<void> {
      encoder.reset();
      mailbox.reset({ snapshot, critical: true, baselineSend });
      return lastDelivery;
    },
    clear(): void {
      encoder.reset();
      mailbox.clear();
    },
  };
}
