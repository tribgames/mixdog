// Persists this desktop's push identity and every browser that asked to be
// notified. The file holds the VAPID private key, so it lands through the same
// owner-only path the pairing token uses.
import { join } from 'node:path';

import { readSecretFile, writeSecretFile } from './secret-file';
import { generateWebPushKeys, type WebPushKeys, type WebPushSubscription } from './web-push';

export interface StoredPushSubscription extends WebPushSubscription {
  /** The paired browser that registered this endpoint. While that browser is
   *  connected it is watching the app live and needs no notification. */
  clientId: string;
  /** Shown in Settings so a user can tell two phones apart. */
  label: string;
  createdAt: number;
}

export interface PushSubscriptionStore {
  /** The applicationServerKey a browser subscribes with; minted on first ask. */
  publicKey(): Promise<string>;
  keys(): Promise<WebPushKeys>;
  list(): Promise<StoredPushSubscription[]>;
  register(input: {
    endpoint: string;
    p256dh: string;
    auth: string;
    clientId?: string;
    label?: string;
  }): Promise<StoredPushSubscription>;
  remove(endpoint: string): Promise<boolean>;
  /** Revoking a browser's access must also stop its notifications. */
  removeByClient(clientId: string): Promise<boolean>;
}

interface PushFileShape {
  version: 1;
  keys: WebPushKeys | null;
  subscriptions: StoredPushSubscription[];
}

/** Far more than the paired-browser ceiling; the cap only exists so a
 *  misbehaving client cannot grow the file without bound. */
const MAX_SUBSCRIPTIONS = 32;
const MAX_LABEL_CHARS = 60;

function sanitizeText(value: unknown, limit: number): string {
  return String(value ?? '').replace(/\s+/gu, ' ').trim().slice(0, limit);
}

/** Only a real https push endpoint is accepted: this desktop POSTs to whatever
 *  is stored here, so an arbitrary URL would make it a confused deputy. */
function validEndpoint(value: unknown): string {
  const raw = String(value ?? '').trim();
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new TypeError('Push endpoint must be an absolute URL.');
  }
  if (url.protocol !== 'https:') throw new TypeError('Push endpoint must use https.');
  if (url.username || url.password) throw new TypeError('Push endpoint must not carry credentials.');
  return url.toString();
}

function validKeyMaterial(p256dh: unknown, auth: unknown): { p256dh: string; auth: string } {
  const publicKey = String(p256dh ?? '').trim();
  const secret = String(auth ?? '').trim();
  if (Buffer.from(publicKey, 'base64url').length !== 65) {
    throw new TypeError('Push subscription key must be a 65-byte P-256 point.');
  }
  if (Buffer.from(secret, 'base64url').length !== 16) {
    throw new TypeError('Push subscription auth secret must be 16 bytes.');
  }
  return { p256dh: publicKey, auth: secret };
}

function readStored(text: string | null): PushFileShape {
  const empty: PushFileShape = { version: 1, keys: null, subscriptions: [] };
  if (!text) return empty;
  try {
    const parsed = JSON.parse(text) as Partial<PushFileShape>;
    const keys = parsed?.keys && typeof parsed.keys.publicKey === 'string'
      ? parsed.keys as WebPushKeys
      : null;
    const subscriptions = Array.isArray(parsed?.subscriptions)
      ? parsed.subscriptions.filter((entry): entry is StoredPushSubscription =>
        Boolean(entry && typeof entry.endpoint === 'string' && typeof entry.p256dh === 'string'))
      : [];
    return { version: 1, keys, subscriptions: subscriptions.slice(0, MAX_SUBSCRIPTIONS) };
  } catch {
    // A corrupt file must not disable notifications forever; the next write
    // replaces it and the browser re-registers on its next visit.
    return empty;
  }
}

export function createPushSubscriptionStore(userDataPath: string): PushSubscriptionStore {
  const path = join(userDataPath, 'remote-push.json');
  let loaded: Promise<PushFileShape> | null = null;

  const state = (): Promise<PushFileShape> => {
    loaded ??= readSecretFile(path).then(readStored);
    return loaded;
  };
  const persist = async (next: PushFileShape): Promise<void> => {
    loaded = Promise.resolve(next);
    await writeSecretFile(path, JSON.stringify(next, null, 2));
  };
  const ensureKeys = async (): Promise<WebPushKeys> => {
    const current = await state();
    if (current.keys) return current.keys;
    const keys = generateWebPushKeys();
    await persist({ ...current, keys });
    return keys;
  };

  return {
    keys: ensureKeys,
    publicKey: async () => (await ensureKeys()).publicKey,
    list: async () => [...(await state()).subscriptions],
    async register(input) {
      const endpoint = validEndpoint(input.endpoint);
      const material = validKeyMaterial(input.p256dh, input.auth);
      await ensureKeys();
      const current = await state();
      const entry: StoredPushSubscription = {
        endpoint,
        ...material,
        clientId: sanitizeText(input.clientId, 64),
        label: sanitizeText(input.label, MAX_LABEL_CHARS),
        createdAt: Date.now(),
      };
      // Re-subscribing replaces the old row: a browser may rotate its endpoint
      // at any time, and the stale one would keep failing until it expired.
      const kept = current.subscriptions.filter((row) => row.endpoint !== endpoint
        && !(entry.clientId && row.clientId === entry.clientId));
      const subscriptions = [...kept, entry].slice(-MAX_SUBSCRIPTIONS);
      await persist({ ...current, subscriptions });
      return entry;
    },
    async remove(endpoint) {
      const current = await state();
      const subscriptions = current.subscriptions.filter((row) => row.endpoint !== endpoint);
      if (subscriptions.length === current.subscriptions.length) return false;
      await persist({ ...current, subscriptions });
      return true;
    },
    async removeByClient(clientId) {
      const id = sanitizeText(clientId, 64);
      if (!id) return false;
      const current = await state();
      const subscriptions = current.subscriptions.filter((row) => row.clientId !== id);
      if (subscriptions.length === current.subscriptions.length) return false;
      await persist({ ...current, subscriptions });
      return true;
    },
  };
}
