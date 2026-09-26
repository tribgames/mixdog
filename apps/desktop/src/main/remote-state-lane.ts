import { createSnapshotDeltaEncoder, isNoDelta, type SnapshotDeltaEncoder } from './state-delta';
import { createLatestStateMailbox, type LatestStateMailbox } from './desktop-service-protocol';

/** Each receiver owns its baseline and one coalescing mailbox. Recovering a
 *  sleeping phone must not invalidate another phone's healthy delta stream. */
export function createRemoteStateLane(compact: boolean, send: (payload: unknown, droppable: boolean) => Promise<void>) {
  let encoder: SnapshotDeltaEncoder = createSnapshotDeltaEncoder({ compact });
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
    let delivered: Promise<void> = Promise.resolve();
    if (!isNoDelta(wire)) delivered = baselineSend ? baselineSend(payload) : send(payload, !critical);
    lastDelivery = delivered;
    void delivered.catch(() => undefined).finally(() => mailbox.acknowledge(sequence));
  });
  return {
    publish(snapshot: unknown): void {
      mailbox.publish({ snapshot, critical: false });
    },
    reset(snapshot: unknown, baselineSend?: (payload: unknown) => Promise<void>): Promise<void> {
      encoder.reset();
      mailbox.reset({ snapshot, critical: true, baselineSend });
      return lastDelivery;
    },
    /** Nothing has left this lane yet, so its receiver still holds whatever
     *  a previous connection's encoder sent. */
    pristine(): boolean {
      return !encoder.emitted;
    },
    /** Continues a parked encoder's stream: the first frame is the delta from
     *  what the receiver already holds to `snapshot`. */
    resume(
      snapshot: unknown,
      parked: SnapshotDeltaEncoder,
      deliver: (payload: unknown) => Promise<void>
    ): Promise<void> {
      encoder = parked;
      mailbox.reset({ snapshot, critical: true, baselineSend: deliver });
      return lastDelivery;
    },
    /** Hands the encoder over for a later resume; this lane starts afresh. */
    park(): SnapshotDeltaEncoder {
      const parked = encoder;
      encoder = createSnapshotDeltaEncoder({ compact });
      mailbox.clear();
      return parked;
    },
    clear(): void {
      encoder.reset();
      mailbox.clear();
    },
  };
}
