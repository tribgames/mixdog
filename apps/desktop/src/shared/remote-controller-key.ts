// The paired phone's secure-desktop controller key on its way to the PC
// (docs/remote-screen.md "PC access: install and enroll moments"). Right after
// a pairing is approved the phone calls this method over the E2EE relay RPC;
// the PC binds the key to the relay credential that call came from and keeps
// it with that paired-device record: the Windows "PC access" setup enrolls
// every paired phone's key, and a phone paired after it is enrolled through
// the service's delegation (main/pc-access.ts).

/** Phone → PC RPC: `[publicKey]` (base64url raw P-256 point). Answers true. */
export const REMOTE_CONTROLLER_KEY_METHOD = 'deliverScreenControllerKey';

/** Service → desktop app event after a paired phone delivered its key:
 *  `{ publicKey }`. The app enrolls it (delegated) when PC access is set up. */
export const REMOTE_CONTROLLER_KEY_DELIVERED_EVENT = 'remote-controller-key-delivered';

/** Service → desktop app event after a pairing removal (unpair, rotate,
 *  recovery) recorded access revocations as owed: the app takes them over and
 *  revokes them (main/pc-access.ts). No value. */
export const REMOTE_CONTROLLER_KEYS_OWED_EVENT = 'remote-controller-keys-owed';

/** The secure-desktop revocations the service owes for removed pairings. */
export interface RemoteControllerKeysOwed {
  /** Controller keys of removed pairings, not yet taken over by the app. */
  keys: string[];
  /** Non-zero while revocations may be missing (a damaged record, or past
   *  the cap); a new number each time, so settling an older one never
   *  clears a newer. */
  unknown: number;
}

/** One paired phone's delivered key, as the PC keeps it. */
export interface RemoteControllerKeyRecord {
  /** The relay credential (paired-device id) the key arrived under. */
  clientId: string;
  publicKey: string;
  /** The device's unpair is recorded but not confirmed by the relay yet. */
  unpaired: boolean;
}
