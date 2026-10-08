import type { RemoteRelayHandle } from './remote-relay';

/** A device route is usable only after the relay has registered this desktop.
 *  Creating the local handle starts the socket, but does not await registration.
 *  A successful control reply proves the authenticated desktop leg is ready. */
export async function remoteAccessDescriptor(
  relay: Pick<RemoteRelayHandle, 'clientUrl' | 'token' | 'listClients'> | null
) {
  if (!relay) return null;
  try {
    const clients = await relay.listClients();
    return { relay: { clientUrl: relay.clientUrl, token: relay.token, clients } };
  } catch {
    // The existing reconnect loop and the Connection card's polling retry.
    return null;
  }
}
