/**
 * Ordered relay input (shared/remote-webrtc.ts RemoteWebrtcRelayInputOrder):
 * per client × session, the stream, run, last seq and whether the run is
 * poisoned. Judged where relay page input executes, which is serialized in
 * decode order (general-lane writes), so a failure poisons everything behind it.
 */
import type { RemoteWebrtcRelayInputOrder } from '../../shared/remote-webrtc';

interface OrderState {
  stream: string;
  run: number;
  lastSeq: number;
  poisoned: boolean;
}

type RemoteRelayInputVerdict = { dispatch: true } | { dispatch: false; error: string };

export function createRemoteRelayInputOrder() {
  const states = new Map<string, OrderState>();
  const key = (clientId: string, sessionId: string) => `${clientId}\u0000${sessionId}`;

  return {
    /** Whether this ordered control may be dispatched now. */
    admit(clientId: string, sessionId: string, order: RemoteWebrtcRelayInputOrder): RemoteRelayInputVerdict {
      const k = key(clientId, sessionId);
      let state = states.get(k);
      if (!state || state.stream !== order.stream) {
        state = { stream: order.stream, run: order.run, lastSeq: 0, poisoned: false };
        states.set(k, state);
      }
      if (order.run < state.run) return { dispatch: false, error: 'Remote Browser Use input of an older run; input was not sent.' };
      if (order.run > state.run) {
        state.run = order.run;
        state.poisoned = false;
      }
      if (order.seq <= state.lastSeq) return { dispatch: false, error: 'Remote Browser Use input repeated; input was not sent.' };
      state.lastSeq = order.seq;
      if (state.poisoned) {
        return { dispatch: false, error: 'Remote Browser Use input behind a failed one; input was not sent.' };
      }
      return { dispatch: true };
    },
    /** The dispatch of `order` threw: the rest of its run is refused. */
    failed(clientId: string, sessionId: string, order: RemoteWebrtcRelayInputOrder): void {
      const state = states.get(key(clientId, sessionId));
      if (state && state.stream === order.stream && state.run === order.run) state.poisoned = true;
    },
    /** The client left the relay. */
    dropClient(clientId: string): void {
      for (const k of [...states.keys()]) if (k.startsWith(`${clientId}\u0000`)) states.delete(k);
    },
  };
}

export type RemoteRelayInputOrder = ReturnType<typeof createRemoteRelayInputOrder>;
