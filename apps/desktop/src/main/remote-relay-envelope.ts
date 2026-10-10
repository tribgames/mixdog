// Routes envelopes arriving on the desktop leg to the owning relay
// responsibilities: control replies, client lifecycle, media requests and flow
// control, and encrypted browser frames.
import type { RelayControlRequests } from './remote-relay-control';

export interface RelayEnvelopeDispatcherDeps {
  control: RelayControlRequests;
  onCapabilities(envelope: Record<string, unknown>): void;
  onClientClaim(envelope: Record<string, unknown>): void;
  onClientOpen(clientId: string, credentialId: string): void;
  onClientClose(clientId: string): void;
  onMedia(envelope: Record<string, unknown>): void;
  /** The relay's verdict on a native push (invalid token, rate limit). */
  onNativePushResult?(envelope: Record<string, unknown>): void;
}

export function createRelayEnvelopeDispatcher(
  deps: RelayEnvelopeDispatcherDeps
): (envelope: Record<string, unknown>) => void {
  return (envelope) => {
    if (envelope.type === 'relay-capabilities') {
      deps.onCapabilities(envelope);
      return;
    }
    if (deps.control.settle(envelope)) return;
    if (envelope.type === 'native-push-result') {
      deps.onNativePushResult?.(envelope);
      return;
    }
    if (envelope.type === 'client-claim') {
      deps.onClientClaim(envelope);
      return;
    }
    if (envelope.type === 'client-open') {
      if (typeof envelope.clientId === 'string') {
        // The relay names the credential it authenticated for this leg; an
        // older relay omits it and the leg simply stays untrusted.
        deps.onClientOpen(envelope.clientId, typeof envelope.browserClientId === 'string' ? envelope.browserClientId : '');
      }
      return;
    }
    if (envelope.type === 'client-close') {
      if (typeof envelope.clientId === 'string') deps.onClientClose(envelope.clientId);
      return;
    }
    // The media lane: a phone's HTTP request (`media-request`) and, for a
    // request in flight, the relay's flow control (pause/resume when its
    // HTTP response filled up or drained) or abort.
    if (typeof envelope.type === 'string' && envelope.type.startsWith('media-')) {
      deps.onMedia(envelope);
      return;
    }
  };
}
