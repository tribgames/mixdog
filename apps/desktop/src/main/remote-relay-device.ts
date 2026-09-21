// Relay endpoint policy and this install's device registration: the identity
// file, the queued revocations that let Unpair work offline, and the one-shot
// sockets that carry an authenticated `revoke-device` to the relay.
import { randomBytes, randomUUID } from 'node:crypto';
import { join } from 'node:path';

import WebSocket from 'ws';

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

async function loadQueuedRevocations(userDataPath: string): Promise<DeviceIdentity[]> {
  try {
    const parsed = JSON.parse((await readSecretFile(join(userDataPath, DEVICE_REVOCATIONS_FILE))) ?? '[]') as unknown;
    return Array.isArray(parsed) ? parsed.filter(validDeviceIdentity) : [];
  } catch {
    return [];
  }
}

async function writeQueuedRevocations(userDataPath: string, identities: DeviceIdentity[]): Promise<void> {
  await writeSecretFile(join(userDataPath, DEVICE_REVOCATIONS_FILE), JSON.stringify(identities, null, 2));
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
  try {
    const parsed = JSON.parse((await readSecretFile(path)) ?? 'null') as unknown;
    if (validDeviceIdentity(parsed)) {
      return { deviceId: parsed.deviceId, deviceSecret: parsed.deviceSecret };
    }
  } catch {
    /* first run */
  }
  return writeDeviceIdentity(path);
}

/** Queue the current identity for authenticated server-side deletion, then
 * replace it immediately so Unpair can refresh QRs even while the VPS is down. */
export async function rotateRemoteDevice(userDataPath: string): Promise<DeviceIdentity> {
  return mutateDeviceFiles(async () => {
    const previous = await loadOrCreateDevice(userDataPath);
    const queued = await loadQueuedRevocations(userDataPath);
    if (!queued.some((identity) => identity.deviceId === previous.deviceId)) {
      await writeQueuedRevocations(userDataPath, [...queued, previous]);
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
      let message: { type?: unknown; ok?: unknown };
      try {
        message = JSON.parse(String(raw)) as { type?: unknown; ok?: unknown };
      } catch {
        return;
      }
      if (message.type === 'device-revoked') finish(message.ok !== false);
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
      let message: { type?: unknown; ok?: unknown };
      try {
        message = JSON.parse(String(raw)) as { type?: unknown; ok?: unknown };
      } catch {
        return;
      }
      if (message.type !== 'device-revoked') return;
      if (message.ok === false) {
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
