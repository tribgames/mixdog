// Relay endpoint policy and this install's device registration: the identity
// file, the queued revocations that let Unpair work offline, and the one-shot
// sockets that carry an authenticated `revoke-device` to the relay.
import { randomBytes, randomUUID } from 'node:crypto';
import { join } from 'node:path';

import WebSocket from 'ws';

import {
  parseJsonText,
  quarantinePath,
  withFileLock,
  writeJsonAtomicAsync,
} from '../../../../src/runtime/shared/atomic-file.mjs';
import { readSecretFile, writeSecretFile } from './secret-file';

export const REVOKE_TIMEOUT_MS = 5_000;

/** Packaged default: every install dials this relay so phone pairing works
 *  out of the box, with no VPS/env setup on the user side.
 *  MIXDOG_RELAY_URL=<wss url> overrides; 0/false/off disables. */
const DEFAULT_RELAY_URL = 'wss://192-255-139-161.sslip.io';

export function validatedRelayUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new TypeError('MIXDOG_RELAY_URL is invalid.');
  }
  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  const loopback = hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1';
  if (url.protocol !== 'wss:' && !(url.protocol === 'ws:' && loopback)) {
    throw new TypeError('MIXDOG_RELAY_URL must use wss://; ws:// is allowed only for loopback development.');
  }
  if (url.username || url.password) {
    throw new TypeError('MIXDOG_RELAY_URL must not contain credentials.');
  }
  return url.toString();
}

export function resolveRelayUrl(env: NodeJS.ProcessEnv): string | null {
  const raw = (env.MIXDOG_RELAY_URL || '').trim();
  const flag = raw.toLowerCase();
  if (flag === '0' || flag === 'false' || flag === 'off') return null;
  return validatedRelayUrl(raw || DEFAULT_RELAY_URL);
}

export interface DeviceIdentity {
  deviceId: string;
  deviceSecret: string;
}

const DEVICE_IDENTITY_FILE = 'relay-device.json';
const DEVICE_REVOCATIONS_FILE = 'relay-device-revocations.json';
let deviceFileMutation: Promise<void> = Promise.resolve();

function validDeviceIdentity(value: unknown): value is DeviceIdentity {
  const identity = value as Partial<DeviceIdentity> | null;
  return (
    typeof identity?.deviceId === 'string' &&
    /^[0-9a-f-]{8,64}$/.test(identity.deviceId) &&
    typeof identity.deviceSecret === 'string' &&
    identity.deviceSecret.length >= 16
  );
}

async function writeDeviceIdentity(path: string): Promise<DeviceIdentity> {
  const identity = { deviceId: randomUUID(), deviceSecret: randomBytes(24).toString('hex') };
  await writeSecretFile(path, JSON.stringify(identity, null, 2));
  return identity;
}

/** The stored identity; null when the file is absent; `{ corrupt }` with the
 *  unreadable text when it was read but holds no valid identity. Read,
 *  permission and lock errors propagate. */
async function readStoredDevice(path: string): Promise<DeviceIdentity | { corrupt: string } | null> {
  const text = await readSecretFile(path);
  if (text === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { corrupt: text };
  }
  if (!validDeviceIdentity(parsed)) return { corrupt: text };
  return { deviceId: parsed.deviceId, deviceSecret: parsed.deviceSecret };
}

function queuedIdentities(value: unknown): DeviceIdentity[] {
  if (!Array.isArray(value)) throw new TypeError('The queued revocations are not a list.');
  if (!value.every(validDeviceIdentity)) throw new TypeError('The queued revocations hold an invalid identity.');
  return value;
}

/** The queue file was read but is not a list of identities (NUL-filled,
 *  truncated). That is not an empty queue: whatever it listed may be lost, and
 *  nothing writes over it until `rotateRemoteDevice` has answered the loss. */
class RevocationQueueDamaged extends Error {
  constructor(readonly text: string) {
    super('The queued device revocations are damaged.');
  }
}

/** The queued identities; [] only when no queue was ever written. A damaged
 *  file throws `RevocationQueueDamaged`. Read, permission and lock errors
 *  propagate too: an unreadable queue is not empty. */
async function loadQueuedRevocations(userDataPath: string): Promise<DeviceIdentity[]> {
  const path = join(userDataPath, DEVICE_REVOCATIONS_FILE);
  // The credentials' access is tightened before they are used.
  const text = await readSecretFile(path);
  if (text === null) return [];
  try {
    return queuedIdentities(parseJsonText(text));
  } catch {
    throw new RevocationQueueDamaged(text);
  }
}

/** Whether the queue file is damaged, i.e. revocations may have been lost. */
export async function revocationQueueDamaged(userDataPath: string): Promise<boolean> {
  try {
    await loadQueuedRevocations(userDataPath);
    return false;
  } catch (error) {
    if (error instanceof RevocationQueueDamaged) return true;
    throw error;
  }
}

/** What can still be known of a damaged queue: its text is kept aside and the
 *  previous version (`.bak`) is read for the identities it names. That copy is
 *  older and may lack the latest entry, so it only adds revocations to attempt;
 *  it never says the queue is complete. */
async function salvageDamagedQueue(userDataPath: string, damaged: RevocationQueueDamaged): Promise<DeviceIdentity[]> {
  const path = join(userDataPath, DEVICE_REVOCATIONS_FILE);
  await writeSecretFile(quarantinePath(path), damaged.text);
  const previous = await readSecretFile(`${path}.bak`).catch(() => null);
  if (previous === null) return [];
  try {
    return queuedIdentities(parseJsonText(previous));
  } catch {
    return [];
  }
}

async function writeQueuedRevocations(userDataPath: string, identities: DeviceIdentity[]): Promise<void> {
  // Callers hold `mutateDeviceFiles`, which orders these writes.
  await writeJsonAtomicAsync(join(userDataPath, DEVICE_REVOCATIONS_FILE), identities, {
    secret: true,
    fsyncDir: true,
    backup: true,
  });
}

function mutateDeviceFiles<T>(operation: () => Promise<T>): Promise<T> {
  const result = deviceFileMutation.then(operation, operation);
  deviceFileMutation = result.then(
    () => undefined,
    () => undefined
  );
  return result;
}

// Stable per-install identity for the relay's trust-on-first-use device
// registration; the secret never leaves this machine except toward the relay.
// It authenticates this desktop's leg, so it lives in an owner-only file.
export async function loadOrCreateDevice(userDataPath: string): Promise<DeviceIdentity> {
  const path = join(userDataPath, DEVICE_IDENTITY_FILE);
  // Only a genuinely absent file (readSecretFile -> null) mints an identity;
  // any read/permission/lock error propagates so the relay retries later
  // instead of orphaning every paired phone's device id.
  // A file that reads fine but holds no valid identity can never recover on
  // retry: keep its text beside it, then mint a new identity.
  const existing = await readStoredDevice(path);
  if (existing && !('corrupt' in existing)) return existing;
  return withFileLock(
    `${path}.lock`,
    async () => {
      const stored = await readStoredDevice(path);
      if (stored && !('corrupt' in stored)) return stored;
      if (stored) await writeSecretFile(quarantinePath(path), stored.corrupt);
      return writeDeviceIdentity(path);
    },
    { secret: true }
  );
}

/** Queue the current identity for authenticated server-side deletion, then
 * replace it immediately so Unpair can refresh QRs even while the VPS is down.
 * A damaged queue does not block this: the replaced identity is the one that
 * must be revoked, and the rewritten queue is what answers the damage. */
export async function rotateRemoteDevice(userDataPath: string): Promise<DeviceIdentity> {
  return mutateDeviceFiles(async () => {
    const previous = await loadOrCreateDevice(userDataPath);
    let queued: DeviceIdentity[];
    let damaged = false;
    try {
      queued = await loadQueuedRevocations(userDataPath);
    } catch (error) {
      if (!(error instanceof RevocationQueueDamaged)) throw error;
      queued = await salvageDamagedQueue(userDataPath, error);
      damaged = true;
    }
    const listed = queued.some((identity) => identity.deviceId === previous.deviceId);
    if (damaged || !listed) {
      await writeQueuedRevocations(userDataPath, listed ? queued : [...queued, previous]);
    }
    return writeDeviceIdentity(join(userDataPath, DEVICE_IDENTITY_FILE));
  });
}

async function removeQueuedRevocation(userDataPath: string, deviceId: string): Promise<void> {
  await mutateDeviceFiles(async () => {
    const queued = await loadQueuedRevocations(userDataPath);
    await writeQueuedRevocations(
      userDataPath,
      queued.filter((identity) => identity.deviceId !== deviceId)
    );
  });
}

export function relayDeviceSocketOptions(
  relayUrl: string,
  identity: DeviceIdentity
): { url: string; headers: Record<string, string> } {
  const target = new URL(validatedRelayUrl(relayUrl));
  target.pathname = '/desktop';
  target.search = '';
  target.hash = '';
  return {
    url: target.toString(),
    headers: {
      Authorization: `Basic ${Buffer.from(`${identity.deviceId}:${identity.deviceSecret}`, 'utf8').toString('base64')}`,
    },
  };
}

/** The relay's `device-revoked` answer, or null for any other message. */
function readDeviceRevokedReply(raw: WebSocket.RawData): { ok?: unknown } | null {
  try {
    const message = JSON.parse(String(raw)) as { type?: unknown; ok?: unknown };
    return message.type === 'device-revoked' ? message : null;
  } catch {
    return null;
  }
}

function revokeIdentity(
  relayUrl: string,
  identity: DeviceIdentity,
  sockets: Set<WebSocket>,
  maxPayload: number
): Promise<boolean> {
  return new Promise((resolve) => {
    const connection = relayDeviceSocketOptions(relayUrl, identity);
    const ws = new WebSocket(connection.url, {
      headers: connection.headers,
      maxPayload,
      // Frames on this leg are E2EE ciphertext (incompressible) or small
      // control envelopes; payload compression happens inside the encrypted
      // envelope instead. Transport deflate only cost CPU on both ends.
      perMessageDeflate: false,
    });
    sockets.add(ws);
    let settled = false;
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      sockets.delete(ws);
      try {
        ws.terminate();
      } catch {
        /* already gone */
      }
      resolve(ok);
    };
    const timeout = setTimeout(() => finish(false), REVOKE_TIMEOUT_MS);
    timeout.unref?.();
    ws.once('open', () => {
      ws.send(JSON.stringify({ type: 'revoke-device' }), (error) => {
        if (error) finish(false);
      });
    });
    ws.on('message', (raw) => {
      const reply = readDeviceRevokedReply(raw);
      if (reply) finish(reply.ok !== false);
    });
    ws.once('error', () => finish(false));
    ws.once('close', () => finish(false));
  });
}

/** The entry URL carries a ROUTE, not a credential: it only says which desktop
 *  to ask. An install captures this URL through the manifest's start_url, which
 *  is what lets a freshly installed web app — a storage container that can
 *  inherit nothing — request approval from the right machine. */
export function relayClientUrl(relayUrl: string, deviceId: string): string {
  const url = new URL(relayUrl);
  url.protocol = url.protocol === 'wss:' ? 'https:' : 'http:';
  url.pathname = `/d/${deviceId}/`;
  url.search = '';
  url.hash = '';
  return url.toString();
}

export interface RevocationDrainDeps {
  relayUrl: string;
  userDataPath: string;
  /** The live registration; a queued copy of it is skipped, never revoked. */
  deviceId: string;
  /** Sockets opened for queued revocations, so `close()` can terminate them. */
  sockets: Set<WebSocket>;
  maxPayload: number;
  closed(): boolean;
}

/** Unpair is local-first so it also works offline. Once any new relay leg
 *  opens, dispose the owner-authenticated registrations queued while down.
 *  One drain runs at a time; a second call while one is in flight is a no-op. */
export function createRevocationDrain(deps: RevocationDrainDeps): () => Promise<void> {
  let draining = false;
  return async (): Promise<void> => {
    if (deps.closed() || draining) return;
    draining = true;
    try {
      const queued = await loadQueuedRevocations(deps.userDataPath);
      for (const identity of queued) {
        if (deps.closed()) break;
        // A failed identity-file rotation may leave the current identity in the
        // queue. Never let cleanup revoke the live registration in that case.
        if (identity.deviceId === deps.deviceId) continue;
        const removed = await revokeIdentity(deps.relayUrl, identity, deps.sockets, deps.maxPayload);
        if (removed) await removeQueuedRevocation(deps.userDataPath, identity.deviceId);
      }
    } catch (error) {
      // A queue that cannot be read now stays on disk, never overwritten; the
      // next relay leg drains it, and a damaged one is answered by the pairing
      // reset that runs before a relay leg opens (desktop-service).
      console.warn('[mixdog-relay] Queued revocations could not be drained:', error);
    } finally {
      draining = false;
    }
  };
}

/** Delete this install's authenticated registration over the live relay leg,
 *  waiting (briefly) for the leg to be open before sending. */
export function revokeDeviceOverSocket(deps: { currentSocket(): WebSocket | null; closed(): boolean }): Promise<void> {
  return new Promise((resolve, reject) => {
    let retryTimer: NodeJS.Timeout | null = null;
    let target: WebSocket | null = null;
    let settled = false;
    const cleanup = () => {
      clearTimeout(timeout);
      if (retryTimer) clearTimeout(retryTimer);
      target?.off('message', onMessage);
      target?.off('close', onClose);
    };
    const succeed = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve();
    };
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const onMessage = (raw: WebSocket.RawData) => {
      const reply = readDeviceRevokedReply(raw);
      if (!reply) return;
      if (reply.ok === false) {
        fail(new Error('Relay registration was not found.'));
        return;
      }
      succeed();
    };
    const onClose = () => fail(new Error('Relay disconnected before confirming revocation.'));
    const send = () => {
      if (deps.closed()) {
        fail(new Error('Relay client is closed.'));
        return;
      }
      const socket = deps.currentSocket();
      if (!socket || socket.readyState !== WebSocket.OPEN) {
        retryTimer = setTimeout(send, 50);
        retryTimer.unref?.();
        return;
      }
      target = socket;
      target.on('message', onMessage);
      target.once('close', onClose);
      target.send(JSON.stringify({ type: 'revoke-device' }), (error) => {
        if (error) fail(error);
      });
    };
    const timeout = setTimeout(() => {
      fail(new Error('Timed out waiting for relay revocation.'));
    }, REVOKE_TIMEOUT_MS);
    timeout.unref?.();
    send();
  });
}
