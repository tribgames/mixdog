// Routes envelopes arriving on the desktop leg to the owning relay
// responsibilities: control replies, client lifecycle, media flow control and
// encrypted browser frames.
import type { RelayControlRequests } from './remote-relay-control';

export interface RelayEnvelopeDispatcherDeps {
  control: RelayControlRequests;
  onCapabilities(envelope: Record<string, unknown>): void;
  onClientClaim(envelope: Record<string, unknown>): void;
  onClientOpen(clientId: string): void;
  onClientClose(clientId: string): void;
  onMediaFlowControl(id: string): void;
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
    if (envelope.type === 'client-claim') {
      deps.onClientClaim(envelope);
      return;
    }
    if (envelope.type === 'client-open') {
      if (typeof envelope.clientId === 'string') deps.onClientOpen(envelope.clientId);
      return;
    }
    if (envelope.type === 'client-close') {
      if (typeof envelope.clientId === 'string') deps.onClientClose(envelope.clientId);
      return;
    }
    // Relay flow control for the phone leg: its HTTP response filled up,
    // so stop reading until it drains. An older relay never sends these.
    if (typeof envelope.type === 'string' && envelope.type.startsWith('media-')) {
      const id = String(envelope.id ?? '');
      deps.onMediaFlowControl(id);
      return;
    }
  };
}
