// Relay-owned Web Push (RFC 8030 delivery, RFC 8292 VAPID).
//
// A browser subscription is bound to ONE applicationServerKey. When every
// desktop held its own key, a browser paired with several PCs could only be
// subscribed for one of them. The relay therefore owns the single sender
// identity every PC delivers through: the browser subscribes once with the
// relay's public key, and each paired PC holds its OWN association with that
// subscription, made by the browser with that PC's pairing credential.
//
// The relay never sees notification content. The desktop encrypts every
// payload for the subscription (RFC 8291 aes128gcm) with the browser's
// p256dh/auth, which reach the desktop sealed to its E2EE identity
// (`sealed` below) — the relay only stores and forwards that box. The relay
// signs the VAPID JWT and posts the ciphertext to the push service.
//
// The private key never leaves this process or its data dir.
import { createPrivateKey, createPublicKey, generateKeyPairSync, randomUUID, sign as cryptoSign } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export const VAPID_FILE = 'webpush-vapid.json';
export const SUBSCRIPTIONS_FILE = 'webpush-subscriptions.json';
/** RFC 8292 wants a contactable sender; it names the software, not a user. */
export const VAPID_SUBJECT = 'mailto:support@tribgames.com';
/** Comfortably inside the 24-hour ceiling even with a skewed push service. */
const VAPID_LIFETIME_SECONDS = 12 * 60 * 60;
const DEFAULT_TTL_SECONDS = 24 * 60 * 60;
const MAX_TTL_SECONDS = 28 * 24 * 60 * 60;
const SEND_TIMEOUT_MS = 10_000;
/** One aes128gcm record: the push services cap a message at 4 KB. */
export const MAX_WEB_PUSH_BODY_BYTES = 4096;
const MAX_ENDPOINT_CHARS = 2048;
/** A browser paired with many PCs holds one association per PC credential. */
const MAX_ASSOCIATIONS_PER_ENDPOINT = 32;
const MAX_ASSOCIATIONS_PER_DEVICE = 64;
const MAX_ENDPOINTS = 100_000;
const URGENCIES = new Set(['very-low', 'low', 'normal', 'high']);
const TOPIC = /^[A-Za-z0-9_-]{1,32}$/u;
const B64URL = /^[A-Za-z0-9_-]*$/u;

/** Write-then-rename, owner-only: the VAPID private key lives in one of these. */
function writeOwnerOnly(path, text) {
  const directory = dirname(path);
  const temporary = join(directory, `.webpush-${process.pid}-${randomUUID()}.tmp`);
  try {
    mkdirSync(directory, { recursive: true });
    writeFileSync(temporary, text, { encoding: 'utf8', mode: 0o600 });
    chmodSync(temporary, 0o600);
    renameSync(temporary, path);
    try {
      chmodSync(path, 0o600);
    } catch {
      /* committed; tightening is best effort on exotic filesystems */
    }
  } finally {
    rmSync(temporary, { force: true });
  }
}

/** The uncompressed point (0x04 ‖ X ‖ Y), base64url — the applicationServerKey. */
function rawPublicKey(keyObject) {
  const jwk = keyObject.export({ format: 'jwk' });
  return Buffer.concat([Buffer.of(0x04), Buffer.from(jwk.x, 'base64url'), Buffer.from(jwk.y, 'base64url')]).toString(
    'base64url'
  );
}

/**
 * The relay's VAPID identity, minted once and persisted in the data dir.
 * Rotating it would strand every subscription, so a file that exists but
 * cannot be read DISABLES web push (null) instead of being replaced.
 */
export function loadOrCreateVapidKeys(dataDir, { log = console.error } = {}) {
  const path = join(dataDir, VAPID_FILE);
  let text = null;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      log(`[relay] web push identity unreadable: ${error?.message || error}`);
      return null;
    }
  }
  if (text !== null) {
    try {
      const parsed = JSON.parse(text);
      const privateKey = createPrivateKey({ key: parsed.privateKeyJwk, format: 'jwk' });
      const publicKey = rawPublicKey(createPublicKey(privateKey));
      if (publicKey !== parsed.publicKey) throw new Error('public key does not match the private key');
      return { publicKey, privateKey };
    } catch (error) {
      log(`[relay] web push identity unusable: ${error?.message || error}`);
      return null;
    }
  }
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const keys = { publicKey: rawPublicKey(publicKey), privateKey };
  try {
    writeOwnerOnly(
      path,
      JSON.stringify(
        { version: 1, publicKey: keys.publicKey, privateKeyJwk: privateKey.export({ format: 'jwk' }) },
        null,
        2
      )
    );
  } catch (error) {
    // An identity that only lives in memory would change on the next start.
    log(`[relay] web push identity could not be stored: ${error?.message || error}`);
    return null;
  }
  return keys;
}

/** `Authorization` for one push service origin, short-lived (RFC 8292 §2). */
export function vapidAuthorization({ endpoint, keys, subject = VAPID_SUBJECT, nowMs = Date.now() }) {
  const issuedAt = Math.floor(nowMs / 1000);
  const header = Buffer.from(JSON.stringify({ typ: 'JWT', alg: 'ES256' })).toString('base64url');
  const claims = Buffer.from(
    JSON.stringify({ aud: new URL(endpoint).origin, exp: issuedAt + VAPID_LIFETIME_SECONDS, sub: subject })
  ).toString('base64url');
  // JWS wants raw r‖s; DER is refused by every push service with a bare 401.
  const signature = cryptoSign('sha256', Buffer.from(`${header}.${claims}`), {
    key: keys.privateKey,
    dsaEncoding: 'ieee-p1363',
  }).toString('base64url');
  return `vapid t=${header}.${claims}.${signature}, k=${keys.publicKey}`;
}

/**
 * The push services browsers subscribe through. The relay POSTs to whatever
 * endpoint a browser registers, so the endpoint's host is matched against the
 * known services rather than screened for "private" names: a public DNS name
 * may resolve anywhere, and a name check cannot see that.
 *   Chrome, Edge, Opera, Brave, Samsung Internet  fcm.googleapis.com
 *   Firefox                                       updates.push.services.mozilla.com
 *   Safari (macOS 13+, iOS 16.4+)                 web.push.apple.com
 *   Edge on WNS (legacy)                          *.notify.windows.com
 */
const PUSH_SERVICE_HOSTS = ['fcm.googleapis.com'];
const PUSH_SERVICE_SUFFIXES = ['.push.services.mozilla.com', '.push.apple.com', '.notify.windows.com'];

/** The host in the one spelling it is matched in: lower case, no trailing
 *  root dot(s) (`fcm.googleapis.com.` names the same host). */
function canonicalHost(hostname) {
  return hostname.toLowerCase().replace(/\.+$/u, '');
}

export function knownPushServiceHost(hostname) {
  const host = canonicalHost(hostname);
  return PUSH_SERVICE_HOSTS.includes(host) || PUSH_SERVICE_SUFFIXES.some((suffix) => host.endsWith(suffix));
}

/** The canonical endpoint, or '' when it is not an https URL on a known push
 *  service: anything else would make the relay a confused deputy for the
 *  network it runs in. Checked when a browser registers AND before each send. */
export function validWebPushEndpoint(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_ENDPOINT_CHARS) return '';
  let url;
  try {
    url = new URL(value);
  } catch {
    return '';
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.port || !knownPushServiceHost(url.hostname)) {
    return '';
  }
  url.hostname = canonicalHost(url.hostname);
  return url.toString();
}

/** The browser's p256dh/auth sealed to ONE desktop's E2EE identity
 *  (shared/remote-e2ee.ts sealRelayWebPushKeys). Opaque here. */
export function validSealedKeys(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const { version, ephemeralPublicKey, nonce, ciphertext } = value;
  if (
    version !== 1 ||
    typeof ephemeralPublicKey !== 'string' ||
    !/^[A-Za-z0-9_-]{87}$/u.test(ephemeralPublicKey) ||
    typeof nonce !== 'string' ||
    !/^[A-Za-z0-9_-]{16}$/u.test(nonce) ||
    typeof ciphertext !== 'string' ||
    !/^[A-Za-z0-9_-]{22,512}$/u.test(ciphertext)
  ) {
    return null;
  }
  return { version: 1, ephemeralPublicKey, nonce, ciphertext };
}

const associationKey = (deviceId, clientId) => `${deviceId}\n${clientId}`;

const DEVICE_ID = /^[A-Za-z0-9_-]{1,128}$/u;

function loadAssociations(path, log) {
  const endpoints = new Map();
  const capable = new Set();
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    if (error?.code !== 'ENOENT') log(`[relay] web push subscriptions unreadable: ${error?.message || error}`);
    return { endpoints, capable };
  }
  try {
    const parsed = JSON.parse(text);
    for (const deviceId of Array.isArray(parsed?.devices) ? parsed.devices : []) {
      if (typeof deviceId === 'string' && DEVICE_ID.test(deviceId)) capable.add(deviceId);
    }
    for (const row of Array.isArray(parsed?.subscriptions) ? parsed.subscriptions : []) {
      const endpoint = validWebPushEndpoint(row?.endpoint);
      if (!endpoint || !Array.isArray(row.associations)) continue;
      const associations = new Map();
      for (const association of row.associations) {
        const sealed = validSealedKeys(association?.sealed);
        if (!sealed || typeof association.deviceId !== 'string' || typeof association.clientId !== 'string') continue;
        associations.set(associationKey(association.deviceId, association.clientId), {
          deviceId: association.deviceId,
          clientId: association.clientId,
          sealed,
          createdAt: Number(association.createdAt) || Date.now(),
        });
      }
      if (associations.size > 0) endpoints.set(endpoint, associations);
    }
  } catch (error) {
    // Browsers re-register on their next launch; a corrupt file costs a gap,
    // never a crash.
    log(`[relay] web push subscriptions unusable: ${error?.message || error}`);
  }
  return { endpoints, capable };
}

const sameSealed = (left, right) =>
  left.version === right.version &&
  left.ephemeralPublicKey === right.ephemeralPublicKey &&
  left.nonce === right.nonce &&
  left.ciphertext === right.ciphertext;

/**
 * The associations `endpoint -> {(deviceId, clientId) -> sealed}`. Each one
 * was made by the browser with THAT PC's credential, and each is removed on
 * its own: unregistering or revoking one PC never touches another's. Persisted
 * because a browser registers once while its PCs come and go.
 */
export function createWebPushRegistry({ dataDir, log = console.error }) {
  const path = join(dataDir, SUBSCRIPTIONS_FILE);
  // `capable`: the PCs that said they deliver through the relay
  // (`webpush-ready`). Kept on disk, since a browser registers while its PCs
  // are offline; an older PC never says so and keeps its legacy path.
  const { endpoints, capable } = loadAssociations(path, log);
  const persist = () => {
    try {
      const subscriptions = [...endpoints].map(([endpoint, associations]) => ({
        endpoint,
        associations: [...associations.values()],
      }));
      writeOwnerOnly(path, JSON.stringify({ version: 1, devices: [...capable], subscriptions }));
      return true;
    } catch (error) {
      log(`[relay] web push subscriptions could not be stored: ${error?.message || error}`);
      return false;
    }
  };
  const countFor = (deviceId) => {
    let count = 0;
    for (const associations of endpoints.values()) {
      for (const association of associations.values()) if (association.deviceId === deviceId) count += 1;
    }
    return count;
  };
  /** Removes matching associations; returns what went, so it can be put back. */
  const remove = (predicate, only = null) => {
    const removed = [];
    for (const endpoint of only === null ? [...endpoints.keys()] : [only]) {
      const associations = endpoints.get(endpoint);
      if (!associations) continue;
      for (const [key, association] of associations) {
        if (predicate(association)) {
          associations.delete(key);
          removed.push({ endpoint, key, association });
        }
      }
      if (associations.size === 0) endpoints.delete(endpoint);
    }
    return removed;
  };
  const restore = (removed) => {
    for (const { endpoint, key, association } of removed) {
      if (!endpoints.has(endpoint)) endpoints.set(endpoint, new Map());
      endpoints.get(endpoint).set(key, association);
    }
  };

  return {
    /** 'ok' | 'unchanged' | 'quota' | 'store-failed'. Re-binding with a new
     *  box refreshes it; re-binding with the same one writes nothing. */
    bind(deviceId, clientId, endpoint, sealed) {
      const key = associationKey(deviceId, clientId);
      const existing = endpoints.get(endpoint);
      const previous = existing?.get(key);
      if (previous && sameSealed(previous.sealed, sealed)) return 'unchanged';
      if (!previous) {
        if (!existing && endpoints.size >= MAX_ENDPOINTS) return 'quota';
        if (existing && existing.size >= MAX_ASSOCIATIONS_PER_ENDPOINT) return 'quota';
        if (countFor(deviceId) >= MAX_ASSOCIATIONS_PER_DEVICE) return 'quota';
      }
      const associations = existing ?? new Map();
      associations.set(key, { deviceId, clientId, sealed, createdAt: previous?.createdAt ?? Date.now() });
      if (!existing) endpoints.set(endpoint, associations);
      if (persist()) return 'ok';
      // Memory and disk stay one state: an association that would vanish on
      // restart is not reported as made.
      if (previous) associations.set(key, previous);
      else associations.delete(key);
      if (associations.size === 0) endpoints.delete(endpoint);
      return 'store-failed';
    },
    /** 'removed' | 'absent' | 'store-failed'. Like bind, a removal that would
     *  come back on restart is undone and reported as failed. */
    unbind(deviceId, clientId, endpoint) {
      const removed = remove((row) => row.deviceId === deviceId && row.clientId === clientId, endpoint);
      if (removed.length === 0) return 'absent';
      if (persist()) return 'removed';
      restore(removed);
      return 'store-failed';
    },
    /** The PC delivers through the relay. 'ok' | 'unchanged' | 'store-failed'. */
    markCapable(deviceId) {
      if (typeof deviceId !== 'string' || !DEVICE_ID.test(deviceId)) return 'store-failed';
      if (capable.has(deviceId)) return 'unchanged';
      capable.add(deviceId);
      if (persist()) return 'ok';
      capable.delete(deviceId);
      return 'store-failed';
    },
    isCapable(deviceId) {
      return capable.has(deviceId);
    },
    has(deviceId, clientId, endpoint) {
      return endpoints.get(endpoint)?.has(associationKey(deviceId, clientId)) === true;
    },
    /** Every association one PC holds: what that PC may deliver to. */
    listFor(deviceId) {
      const rows = [];
      for (const [endpoint, associations] of endpoints) {
        for (const association of associations.values()) {
          if (association.deviceId === deviceId) {
            rows.push({ endpoint, clientId: association.clientId, sealed: association.sealed });
          }
        }
      }
      return rows;
    },
    /** The push service retired the subscription (404/410): it is gone for
     *  every PC. Returns the PCs that held it, so each can be told. */
    dropEndpoint(endpoint) {
      const associations = endpoints.get(endpoint);
      if (!associations) return [];
      const devices = new Set([...associations.values()].map((row) => row.deviceId));
      endpoints.delete(endpoint);
      persist();
      return [...devices];
    },
    /** A revoked client (or, without clientId, a revoked device). */
    dropClient(deviceId, clientId = null) {
      const removed = remove((row) => row.deviceId === deviceId && (clientId === null || row.clientId === clientId));
      const forgotten = clientId === null && capable.delete(deviceId);
      if (removed.length > 0 || forgotten) persist();
      return removed.length > 0;
    },
  };
}

export function webPushBody(value) {
  if (typeof value !== 'string' || value.length === 0 || !B64URL.test(value)) return null;
  const body = Buffer.from(value, 'base64url');
  return body.length > 0 && body.length <= MAX_WEB_PUSH_BODY_BYTES ? body : null;
}

export function webPushOptions(message) {
  const ttl = Number.isInteger(message.ttl) && message.ttl >= 0 && message.ttl <= MAX_TTL_SECONDS ? message.ttl : null;
  return {
    ttl: ttl ?? DEFAULT_TTL_SECONDS,
    urgency: URGENCIES.has(message.urgency) ? message.urgency : 'high',
    topic: typeof message.topic === 'string' && TOPIC.test(message.topic) ? message.topic : '',
  };
}

/** Posts one already-encrypted message. Resolves `{ ok, status, expired?,
 *  error? }`; never rejects. */
export function createWebPushSender({ keys, fetchImpl = globalThis.fetch, now = Date.now, subject = VAPID_SUBJECT }) {
  return {
    async send({ endpoint, body, ttl = DEFAULT_TTL_SECONDS, urgency = 'high', topic = '' }) {
      // Again here, not only at registration: whatever reached the registry
      // (an older file, a looser earlier rule) is never posted to.
      if (validWebPushEndpoint(endpoint) !== endpoint) {
        return { ok: false, status: 0, error: 'endpoint-not-allowed' };
      }
      const abort = new AbortController();
      const timer = setTimeout(() => abort.abort(), SEND_TIMEOUT_MS);
      timer.unref?.();
      try {
        const response = await fetchImpl(endpoint, {
          method: 'POST',
          headers: {
            Authorization: vapidAuthorization({ endpoint, keys, subject, nowMs: now() }),
            'Content-Encoding': 'aes128gcm',
            'Content-Type': 'application/octet-stream',
            TTL: String(ttl),
            Urgency: urgency,
            ...(topic ? { Topic: topic } : {}),
          },
          body: new Uint8Array(body),
          signal: abort.signal,
          redirect: 'error',
        });
        const status = response.status;
        const expired = status === 404 || status === 410;
        return {
          ok: status >= 200 && status < 300,
          status,
          ...(expired ? { expired: true } : {}),
        };
      } catch (error) {
        return { ok: false, status: 0, error: error?.message || 'send failed' };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
