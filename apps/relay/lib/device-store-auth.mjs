import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

import { isRoutingId } from './ids.mjs';

const PROFILE_FIELD_LIMIT = 80;
const DEFAULT_CLIENT_NAME = 'Browser';
const MAX_PAIRED_CLIENTS_PER_DEVICE = 256;
const REGISTRABLE_DEVICE_ID =
  /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{32,64})$/;

function sha256(value) {
  return createHash('sha256').update(String(value)).digest('hex');
}

function clipField(value, fallback = '') {
  return String(value || fallback).slice(0, PROFILE_FIELD_LIMIT);
}

export function clientProfile(profile = {}, defaultName = DEFAULT_CLIENT_NAME) {
  return {
    name: clipField(profile.name, defaultName),
    platform: clipField(profile.platform),
    browser: clipField(profile.browser),
  };
}

function hashesMatch(expectedHex, candidate) {
  if (!expectedHex || !candidate) return false;
  const a = Buffer.from(expectedHex, 'hex');
  const b = createHash('sha256').update(String(candidate)).digest();
  return a.length === b.length && timingSafeEqual(a, b);
}

export function readDeviceCredentials(request, _url) {
  const authorization = String(request.headers?.authorization || '');
  const match = /^Basic\s+([A-Za-z0-9+/]+={0,2})$/i.exec(authorization);
  if (match) {
    try {
      const decoded = Buffer.from(match[1], 'base64').toString('utf8');
      const divider = decoded.indexOf(':');
      if (divider > 0) {
        return {
          deviceId: decoded.slice(0, divider),
          secret: decoded.slice(divider + 1),
        };
      }
    } catch {
      /* invalid Basic authorization */
    }
  }
  return { deviceId: '', secret: '' };
}

// Trust-on-first-use only binds ids that cannot be guessed ahead of the device
// that owns them: a full UUID (what the desktop and the hook worker mint) or an
// equivalent 32+ hex-character id. Routing still accepts the wider shape, so
// existing rows and links keep working.
export function registrableDeviceId(deviceId) {
  return REGISTRABLE_DEVICE_ID.test(String(deviceId || ''));
}

// Trust-on-first-use registration is what makes setup zero-config, but an
// unauthenticated caller must not be able to mint rows at network speed.
// The caller applies the per-IP registration limiter; legitimate fleet
// growth itself is unbounded here and can move to sharded storage later.
export function authenticateDevice(store, deviceId, secret) {
  const known = store.devices.get(deviceId);
  if (!known) {
    // A NEW id is bound to whichever secret arrives first, so the id itself
    // has to be unguessable: a short or predictable label could be preclaimed
    // before the real device ever dials, and the owner would then be locked
    // out of its own route. Desktops and hook workers mint a UUID; ids
    // already in the store keep authenticating on their secret alone.
    if (!registrableDeviceId(deviceId)) return false;
    store.devices.set(deviceId, { secretHash: sha256(secret), clientTokenHash: '', clients: {} });
    // Persist BEFORE the credential goes live. A registration that only
    // exists in memory authenticates until the next restart and then
    // silently becomes a stranger — worse, a failed write would leave the id
    // claimed here while the owner's next dial re-registers it elsewhere.
    if (!store.saveOrLog()) {
      store.devices.delete(deviceId);
      return false;
    }
    return true;
  }
  return hashesMatch(known.secretHash, secret);
}

export function setClientToken(store, deviceId, token) {
  const known = store.devices.get(deviceId);
  if (!known) return false;
  const hash = sha256(token);
  // Every desktop reconnect re-announces its (unchanged) pairing token;
  // rewriting the store for that would turn restarts into a write storm. A
  // CHANGED token is rare, so it persists synchronously before it is honored.
  if (known.clientTokenHash === hash) return true;
  const previousHash = known.clientTokenHash;
  if (previousHash) store.tokenIndex.delete(previousHash);
  known.clientTokenHash = hash;
  store.tokenIndex.set(hash, deviceId);
  if (!store.saveOrLog()) {
    store.tokenIndex.delete(hash);
    known.clientTokenHash = previousHash;
    if (previousHash) store.tokenIndex.set(previousHash, deviceId);
    return false;
  }
  return true;
}

export function revokeDevice(store, deviceId) {
  const known = store.devices.get(deviceId);
  if (!known) return false;
  if (known.clientTokenHash) store.tokenIndex.delete(known.clientTokenHash);
  for (const client of Object.values(known.clients || {})) {
    store.clientTokenIndex.delete(client.tokenHash);
  }
  store.devices.delete(deviceId);
  // The acknowledgement is the durability boundary for Unpair: persist
  // synchronously before telling the desktop that the registration is gone.
  // A write that fails is reported as a failed revocation — otherwise the
  // credential returns on the next restart while the user was told it was
  // gone; restore the in-memory row so relay and disk stay one state.
  if (!store.saveOrLog()) {
    store.devices.set(deviceId, known);
    if (known.clientTokenHash) store.tokenIndex.set(known.clientTokenHash, deviceId);
    for (const [clientId, client] of Object.entries(known.clients || {})) {
      store.clientTokenIndex.set(client.tokenHash, { deviceId, clientId });
    }
    return false;
  }
  return true;
}

export function deviceIdForClientToken(store, token) {
  return clientAccessForToken(store, token)?.deviceId ?? null;
}

export function clientAccessForToken(store, token) {
  if (!token) return null;
  const hash = sha256(token);
  const deviceId = store.tokenIndex.get(hash);
  if (deviceId) return { deviceId, clientId: null };
  return store.clientTokenIndex.get(hash) ?? null;
}

export function registerClient(store, deviceId, clientId, profile = {}) {
  const known = store.devices.get(deviceId);
  if (!known || !isRoutingId(clientId)) return null;
  known.clients ||= {};
  if (!known.clients[clientId] && Object.keys(known.clients).length >= MAX_PAIRED_CLIENTS_PER_DEVICE) return null;
  const previous = known.clients[clientId];
  if (previous?.tokenHash) store.clientTokenIndex.delete(previous.tokenHash);
  const token = randomBytes(32).toString('hex');
  const now = Date.now();
  const client = {
    tokenHash: sha256(token),
    ...clientProfile(profile),
    createdAt: previous?.createdAt || now,
    lastSeenAt: now,
  };
  known.clients[clientId] = client;
  store.clientTokenIndex.set(client.tokenHash, { deviceId, clientId });
  // The token IS the answer to the caller: handing out one the store could
  // not record would authenticate a browser only until the next restart.
  if (!store.saveOrLog()) {
    delete known.clients[clientId];
    store.clientTokenIndex.delete(client.tokenHash);
    if (previous?.tokenHash) {
      known.clients[clientId] = previous;
      store.clientTokenIndex.set(previous.tokenHash, { deviceId, clientId });
    }
    return null;
  }
  return { token, client: { id: clientId, ...client } };
}

export function touchClient(store, deviceId, clientId, profile = {}) {
  const client = store.devices.get(deviceId)?.clients?.[clientId];
  if (!client) return false;
  client.lastSeenAt = Date.now();
  if (profile.name) client.name = clipField(profile.name);
  if (profile.platform) client.platform = clipField(profile.platform);
  if (profile.browser) client.browser = clipField(profile.browser);
  store.scheduleSave();
  return true;
}

export function listClients(store, deviceId, online = new Set()) {
  const clients = store.devices.get(deviceId)?.clients || {};
  return Object.entries(clients)
    .map(([id, client]) => ({
      id,
      name: client.name,
      platform: client.platform,
      browser: client.browser,
      createdAt: client.createdAt,
      lastSeenAt: client.lastSeenAt,
      online: online.has(id),
    }))
    .sort((left, right) => right.lastSeenAt - left.lastSeenAt);
}

export function revokeClient(store, deviceId, clientId) {
  const known = store.devices.get(deviceId);
  const client = known?.clients?.[clientId];
  if (!known || !client) return false;
  store.clientTokenIndex.delete(client.tokenHash);
  delete known.clients[clientId];
  // Same durability boundary as device revocation: a browser reported as
  // unpaired must not come back when the relay restarts.
  if (!store.saveOrLog()) {
    known.clients[clientId] = client;
    store.clientTokenIndex.set(client.tokenHash, { deviceId, clientId });
    return false;
  }
  return true;
}
