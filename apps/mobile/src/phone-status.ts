// What the phone UI shows about its connection, derived from the client library's `ConnectionStatus` and the relay socket's
// close codes. The renderer applies these to its existing connection indicator and pairing screen.
import type { ConnectionStatus } from '../../../packages/protocol-client/src/index.ts';
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

/** Core close code for a version mismatch, forwarded to the phone by the bridge (lifecycle-remote §9 test 4). */
export const CLOSE_VERSION_MISMATCH = 4002;

/** The terminal state a relay close code names, if any. */
export function terminalOfClose(code: number, reason: string): 'update-required' | 'pairing-lost' | undefined {
  if (code === CLOSE_VERSION_MISMATCH) return 'update-required';
  if (isInvalidRemotePairingClose({ code, reason })) return 'pairing-lost';
  return undefined;
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
