// Each paired phone's secure-desktop controller key, as the phone hands it to
// the PC right after its pairing is approved (shared/remote-controller-key.ts).
// The key is bound to the relay credential of the connection it arrived on —
// never to anything the request names — and kept with that paired-device
// record (remote-client-cache.ts). Only a paired connection reaches this: the
// method table is served from frames decrypted on an established E2EE channel
// (remote-relay-client-calls.ts), and a device whose unpair is recorded is
// refused. Nothing here elevates: each accepted delivery is announced to the
// desktop app, which enrolls the key (main/pc-access.ts).
import type { RemoteControllerKeyRecord, RemoteControllerKeysOwed } from '../shared/remote-controller-key';
import { isSecureDesktopControllerKey } from '../shared/secure-desktop-grant';
import type { RemoteClientCache } from './remote-client-cache';

export interface RemoteControllerKeys {
  /** A paired connection's key delivery; rejects anything else. */
  deliver(credentialId: string, publicKey: unknown): Promise<boolean>;
  /** Every delivered key, unpaired ones marked. */
  list(): RemoteControllerKeyRecord[];
  /** The access revocations owed for removed pairings (the desktop app's). */
  owed(): RemoteControllerKeysOwed;
  /** The desktop app took these over durably; `args` as the operation sends
   *  them (`[keys, unknown]`), checked here. */
  settleOwed(args: unknown[]): Promise<void>;
}

export function createRemoteControllerKeys(
  store: Pick<RemoteClientCache, 'pending' | 'controllerKeys' | 'setControllerKey' | 'owedAccess' | 'settleOwedAccess'>,
  /** An accepted key, kept: the desktop app's enroll (every connection
   *  delivers again, so a failed enroll is tried again next time). */
  onDelivered: (publicKey: string) => void = () => {}
): RemoteControllerKeys {
  return {
    async deliver(credentialId, publicKey) {
      if (!credentialId) throw new TypeError('This connection has no paired device identity.');
      if (store.pending().includes(credentialId)) throw new TypeError('This device is no longer paired.');
      if (!isSecureDesktopControllerKey(publicKey)) throw new TypeError('The controller key is invalid.');
      await store.setControllerKey(credentialId, publicKey);
      onDelivered(publicKey);
      return true;
    },
    list: () => store.controllerKeys(),
    owed: () => store.owedAccess(),
    async settleOwed([keys, unknown]) {
      if (!Array.isArray(keys) || !keys.every((key) => typeof key === 'string')) {
        throw new TypeError('The settled keys are not a list.');
      }
      if (!Number.isSafeInteger(unknown)) throw new TypeError('The settled marker is not a count.');
      await store.settleOwedAccess(keys, unknown as number);
    },
  };
}
