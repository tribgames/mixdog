// What the phone UI shows about its connection, derived from the client library's `ConnectionStatus` and the relay socket's
// close codes. The renderer applies these to its existing connection indicator and pairing screen.
import type { ConnectionStatus } from '../../../packages/protocol-client/src/index.ts';
import { DESKTOP_OFFLINE_CLOSE } from '../../relay/lib/relay-close-codes.mjs';
import { isInvalidRemotePairingClose } from '../../desktop/src/renderer/remote-pairing-recovery.ts';

export type PhoneConnection =
  | { readonly state: 'connecting' }
  | { readonly state: 'reconnecting' }
  | { readonly state: 'connected' }
  /** The core runs another version than this page (initialize refusal, or close 4002): the page must be reloaded from the relay after the update. */
  | { readonly state: 'update-required' }
  /** The PC revoked this device or refused its credential: only a new pairing recovers. */
  | { readonly state: 'pairing-lost' }
  | { readonly state: 'closed' };

/** The relay's close for a paired phone whose PC has no live leg. The core's version refusal also closes with 4002, but only
 *  after the `initialize` refusal frame, which the client library turns into `versionRefused` first; so a 4002 close seen here is
 *  always the PC being offline (transient), never a terminal state. */
export const CLOSE_DESKTOP_OFFLINE = DESKTOP_OFFLINE_CLOSE;

/** The terminal state a relay close code names, if any. */
export function terminalOfClose(code: number, reason: string): 'pairing-lost' | undefined {
  return isInvalidRemotePairingClose({ code, reason }) ? 'pairing-lost' : undefined;
}

export function phoneConnectionOf(status: ConnectionStatus): PhoneConnection {
  switch (status.state) {
    case 'ready':
      return { state: 'connected' };
    case 'reconnecting':
      return { state: 'reconnecting' };
    case 'closed':
      return status.reason.kind === 'versionRefused' ? { state: 'update-required' } : { state: 'closed' };
  }
}
