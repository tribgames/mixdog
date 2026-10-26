// What arrives on the desktop leg, before the per-type routing: the relay's
// oversize-frame refusals, a phone's encrypted frames (handed to that phone's
// lifecycle), and the media lane's request and flow-control envelopes.
import {
  RELAY_FRAME_TOO_LARGE,
  readRelayPayloadRejection,
  relayPayloadRejectedFrame,
  type RelayPayloadRejection,
} from '../shared/remote-payload-limit';
import type { RelayClientState, SendEncryptedFrame } from './remote-relay-clients';
import type { RelayMediaLane } from './remote-relay-media';

export interface RelayInboundDeps {
  learnRefusedFrameLimit(rejection: Pick<RelayPayloadRejection, 'limit'>): void;
  sendEncryptedFrame: SendEncryptedFrame;
  onRelayPayloadRefused?: (detail: { bytes: number | null; limit: number | null }) => void;
  client(clientId: string): RelayClientState | undefined;
  receive(clientId: string, client: RelayClientState, frame: string | ArrayBufferView): void;
  /** Every other envelope (remote-relay-envelope.ts). */
  route(envelope: Record<string, unknown>): void;
}

export function createRelayInboundDispatch(deps: RelayInboundDeps): (envelope: Record<string, unknown>) => void {
  return (envelope) => {
    // The relay REFUSED an oversize frame instead of dropping the leg, so
    // the browser that sent it is waiting on a call that will never be
    // answered. Forward the refusal to it (encrypted, like every other
    // event) and let it fail that call with a real reason.
    //
    // The relay derives this clientId from the binary frame header or a
    // bounded JSON scan — never from parsing the payload — so it is used
    // here as a LOOKUP KEY only: an unknown id finds no client and an
    // absent one means the refusal could not be attributed, which every
    // active client has to consider. A malformed envelope yields no
    // rejection and returns quietly; nothing here can throw or close.
    if (envelope.type === RELAY_FRAME_TOO_LARGE) {
      const rejection = readRelayPayloadRejection(envelope);
      if (!rejection) return;
      // A frame slipped past the pre-send check, so the ceiling this leg
      // believed in was too generous: tighten it permanently. The notice
      // itself names no call and NEVER selects one — the relay cannot know
      // which frame it refused, and guessing by size blames innocents.
      deps.learnRefusedFrameLimit(rejection);
      const clientId = typeof envelope.clientId === 'string' ? envelope.clientId : '';
      if (!clientId) {
        // Unattributed. It concerns exactly ONE client and nothing can say
        // which, so no client is told: a sibling would learn another
        // client's refused size and see an error for traffic it never
        // sent. The learned ceiling above is the repair that matters; the
        // event itself is recorded on the leg it happened on.
        console.error(
          '[mixdog-remote] relay refused an oversize frame' +
            ` bytes=${rejection.bytes ?? 'unknown'} limit=${rejection.limit ?? 'unknown'}` +
            ' (no client attributed)'
        );
        deps.onRelayPayloadRefused?.({
          bytes: rejection.bytes,
          limit: rejection.limit,
        });
        return;
      }
      // Named: only that leg hears about it, and never as a victim.
      void deps.sendEncryptedFrame(
        clientId,
        relayPayloadRejectedFrame({ ...rejection, callId: null, scope: 'unknown' })
      );
      return;
    }
    if (envelope.type !== 'frame' || typeof envelope.clientId !== 'string') {
      deps.route(envelope);
      return;
    }
    const client = deps.client(envelope.clientId);
    if (!client) return;
    const frame = envelope.data;
    if (typeof frame !== 'string' && !ArrayBuffer.isView(frame)) return;
    deps.receive(envelope.clientId, client, frame);
  };
}

/** A `media-*` envelope: a phone's HTTP request, or the relay's flow control
 *  for one in flight. One without an id is ignored. */
export function routeRelayMediaEnvelope(mediaLane: RelayMediaLane, envelope: Record<string, unknown>): void {
  const id = String(envelope.id ?? '');
  if (!id) return;
  if (envelope.type === 'media-request') {
    void mediaLane.serve({
      id,
      assetId: String(envelope.assetId ?? ''),
      variant: String(envelope.variant ?? 'original'),
      method: String(envelope.method ?? 'GET'),
      range: String(envelope.range ?? ''),
      sid: String(envelope.sid ?? ''),
      enc: String(envelope.enc ?? ''),
    });
  } else if (envelope.type === 'media-abort') {
    mediaLane.abort(id);
  } else if (envelope.type === 'media-pause' || envelope.type === 'media-resume') {
    mediaLane.setPaused(id, envelope.type === 'media-pause');
  }
}
