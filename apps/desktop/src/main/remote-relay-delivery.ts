// Encrypted delivery on the relay leg: one payload sealed into one client's
// E2EE channel, measured exactly as the relay charges it, refused here when it
// would exceed the relay's ceiling, and only then written to the socket.
import type { createRemoteByteMeter } from '../shared/remote-performance';
import { reportRemoteByteWindow } from './remote-performance-diagnostics';
import {
  relayFrameByteLength,
  relayFrameCallId,
  relayFrameRefusal,
  relayPayloadRejectedFrame,
} from '../shared/remote-payload-limit';
import type { RelayClientRegistry, RelayClientState, SendEncryptedFrame } from './remote-relay-clients';
// @ts-expect-error Relay framing is shared with the plain-ESM VPS server.
import { encodeRelayBinaryFrame } from '../../../relay/lib/relay-binary-frame.mjs';

export interface RelayEncryptedDeliveryDeps {
  /** The live client registry; read at send time, never snapshotted. */
  clients: Pick<RelayClientRegistry, 'clients' | 'get' | 'close'>;
  /** Whether the relay accepted binary frames on the CURRENT connection. */
  relayBinaryFrames(): boolean;
  /** The relay's per-frame ceiling as currently known for this connection. */
  relayFrameLimit(): number;
  /** Writes an already serialized frame to the current relay socket. */
  sendRawAndWait(frame: string | Uint8Array): Promise<void>;
  byteMeter: Pick<ReturnType<typeof createRemoteByteMeter>, 'record'>;
}

export interface RelayEncryptedDelivery {
  sendEncryptedFrame: SendEncryptedFrame;
  broadcastEncryptedAsync(
    payload: unknown,
    droppable: boolean,
    include?: (state: RelayClientState) => boolean
  ): Promise<void>;
  broadcastEncrypted(payload: unknown, droppable: boolean, include?: (state: RelayClientState) => boolean): void;
}

export function createRelayEncryptedDelivery(deps: RelayEncryptedDeliveryDeps): RelayEncryptedDelivery {
  const { clients } = deps;
  /** Refusing an oversize frame BEFORE it is sent is what makes attribution
   *  structural: the frame in hand is the frame that fails, so the call it
   *  answers is known exactly — no size matching, no log, nothing to evict or
   *  confuse. The browser is told through the encrypted channel, carrying that
   *  id (a push carries none and blames no call). */
  const deliverEncryptedFrame = async (
    clientId: string,
    payload: unknown,
    droppable: boolean,
    guardOversize: boolean,
    onSent?: (bytes: number) => void,
    requireDelivery = false
  ): Promise<void> => {
    const state = clients.get(clientId);
    if (!state?.channel) {
      if (requireDelivery) throw new Error('Remote client disconnected.');
      return;
    }
    try {
      const binary = deps.relayBinaryFrames() && state.binaryFrames;
      let wire: string | Uint8Array;
      if (binary) {
        wire = encodeRelayBinaryFrame({ clientId, data: await state.channel.encryptBinary(payload), droppable });
      } else {
        wire = JSON.stringify({
          type: 'frame',
          clientId,
          data: await state.channel.encryptJson(payload),
          ...(droppable ? { droppable: true } : {}),
        });
      }
      // Measured exactly as the relay charges it: the declared payload length
      // of the whole outgoing message (apps/relay/server.mjs frameBytes).
      const bytes = relayFrameByteLength(wire);
      const refusal = guardOversize
        ? relayFrameRefusal(bytes, deps.relayFrameLimit(), relayFrameCallId(payload))
        : null;
      if (refusal) {
        // Never sent: the relay would refuse it, and nothing downstream could
        // say whose frame it was. Answer the waiting call instead.
        await deliverEncryptedFrame(clientId, relayPayloadRejectedFrame(refusal), false, false, onSent);
        if (requireDelivery) throw new Error('View synchronization payload exceeds the relay frame limit.');
        return;
      }
      // Count only a completed socket write, not a refused or failed send.
      await deps.sendRawAndWait(wire);
      const meterReport = deps.byteMeter.record(payload, bytes);
      if (meterReport) reportRemoteByteWindow(meterReport);
      onSent?.(bytes);
    } catch (error) {
      if (requireDelivery) throw error;
      clients.close(clientId, 'relay encryption failed');
    }
  };
  const sendEncryptedFrame = (
    clientId: string,
    payload: unknown,
    droppable = false,
    onSent?: (bytes: number) => void,
    requireDelivery = false
  ): Promise<void> => deliverEncryptedFrame(clientId, payload, droppable, true, onSent, requireDelivery);
  const broadcastEncryptedAsync = (
    payload: unknown,
    droppable: boolean,
    include: (state: RelayClientState) => boolean = () => true
  ): Promise<void> =>
    Promise.all(
      [...clients.clients].map(([clientId, state]) =>
        state.channel && include(state) ? sendEncryptedFrame(clientId, payload, droppable) : Promise.resolve()
      )
    ).then(() => undefined);
  const broadcastEncrypted = (
    payload: unknown,
    droppable: boolean,
    include?: (state: RelayClientState) => boolean
  ): void => {
    void broadcastEncryptedAsync(payload, droppable, include);
  };
  return { sendEncryptedFrame, broadcastEncryptedAsync, broadcastEncrypted };
}
