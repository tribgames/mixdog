// Native (APNs/FCM) push registrations of paired clients. A row is bound to
// the paired client (relay credential) that registered it over the encrypted
// channel, so unpairing that client removes it. The device token is only an
// address; the content is encrypted for `publicKey`, which never leaves the
// phone's private half.
import { join } from 'node:path';

import { isNativePushPublicKey } from '../shared/native-push-crypto';
import { readSecretFile, writeSecretFile } from './secret-file';

export type NativePushPlatform = 'apns' | 'fcm';

export interface NativePushSubscription {
  clientId: string;
  platform: NativePushPlatform;
  token: string;
  publicKey: string;
  /** APNs only: the token belongs to the sandbox environment. */
  sandbox: boolean;
  createdAt: number;
}

export interface NativePushStore {
  list(): Promise<NativePushSubscription[]>;
  register(input: {
    clientId: string;
    platform: unknown;
    token: unknown;
    publicKey: unknown;
    sandbox?: unknown;
  }): Promise<NativePushSubscription>;
  /** Removes the client's registration (or only the row holding `token`). */
  remove(clientId: string, token?: string): Promise<boolean>;
  /** Drops a token the relay reported invalid, whoever registered it. */
  removeToken(token: string): Promise<boolean>;
  removeByClient(clientId: string): Promise<boolean>;
}

const MAX_SUBSCRIPTIONS = 32;
const MAX_TOKEN_CHARS = 4096;

export function validNativePushToken(platform: NativePushPlatform, token: unknown): string {
  const value = typeof token === 'string' ? token.trim() : '';
  if (!value || value.length > MAX_TOKEN_CHARS) throw new TypeError('Native push token is invalid.');
  const pattern = platform === 'apns' ? /^[0-9a-fA-F]{32,400}$/u : /^[A-Za-z0-9_:.\-]{32,4096}$/u;
  if (!pattern.test(value)) throw new TypeError(`Native push token is not a valid ${platform.toUpperCase()} token.`);
  return value;
}

export function validNativePushInput(input: {
  platform: unknown;
  token: unknown;
  publicKey: unknown;
  sandbox?: unknown;
}): { platform: NativePushPlatform; token: string; publicKey: string; sandbox: boolean } {
  if (input.platform !== 'apns' && input.platform !== 'fcm') {
    throw new TypeError("Native push platform must be 'apns' or 'fcm'.");
  }
  const platform: NativePushPlatform = input.platform;
  const token = validNativePushToken(platform, input.token);
  if (!isNativePushPublicKey(input.publicKey)) {
    throw new TypeError('Native push publicKey must be an uncompressed P-256 point (base64url).');
  }
  if (input.sandbox !== undefined && typeof input.sandbox !== 'boolean') {
    throw new TypeError('Native push sandbox must be a boolean.');
  }
  return { platform, token, publicKey: input.publicKey, sandbox: platform === 'apns' && input.sandbox === true };
}

function readStored(text: string | null): NativePushSubscription[] {
  if (!text) return [];
  try {
    const parsed = JSON.parse(text) as { subscriptions?: unknown };
    if (!Array.isArray(parsed.subscriptions)) return [];
    return parsed.subscriptions
      .filter(
        (row): row is NativePushSubscription =>
          Boolean(row) &&
          typeof row.clientId === 'string' &&
          (row.platform === 'apns' || row.platform === 'fcm') &&
          typeof row.token === 'string' &&
          isNativePushPublicKey(row.publicKey)
      )
      .slice(0, MAX_SUBSCRIPTIONS);
  } catch {
    return [];
  }
}

export function createNativePushStore(userDataPath: string): NativePushStore {
  const path = join(userDataPath, 'remote-native-push.json');
  let loaded: Promise<NativePushSubscription[]> | null = null;
  const state = (): Promise<NativePushSubscription[]> => {
    loaded ??= readSecretFile(path).then(readStored);
    return loaded;
  };
  const persist = async (subscriptions: NativePushSubscription[]): Promise<void> => {
    loaded = Promise.resolve(subscriptions);
    await writeSecretFile(path, JSON.stringify({ version: 1, subscriptions }, null, 2));
  };
  const dropWhere = async (drop: (row: NativePushSubscription) => boolean): Promise<boolean> => {
    const current = await state();
    const kept = current.filter((row) => !drop(row));
    if (kept.length === current.length) return false;
    await persist(kept);
    return true;
  };

  return {
    list: async () => [...(await state())],
    async register(input) {
      const clientId = String(input.clientId || '').slice(0, 64);
      if (!clientId) throw new TypeError('Native push needs a paired client.');
      const valid = validNativePushInput(input);
      const entry: NativePushSubscription = { clientId, ...valid, createdAt: Date.now() };
      const current = await state();
      // One registration per paired client; a token moves to its latest owner.
      const kept = current.filter((row) => row.clientId !== clientId && row.token !== entry.token);
      await persist([...kept, entry].slice(-MAX_SUBSCRIPTIONS));
      return entry;
    },
    remove: (clientId, token) => dropWhere((row) => row.clientId === clientId && (!token || row.token === token)),
    removeToken: (token) => dropWhere((row) => row.token === token),
    removeByClient: (clientId) => dropWhere((row) => row.clientId === clientId),
  };
}
