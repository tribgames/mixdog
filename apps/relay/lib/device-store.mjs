// Persistent device/browser credentials. Extracted from server.mjs
// (behavior-preserving): registration and revocation still acknowledge the
// caller only once the change is on disk.
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { isRoutingId } from './ids.mjs';

const PROFILE_FIELD_LIMIT = 80;
const DEFAULT_CLIENT_NAME = 'Browser';
const HEX_HASH = /^[0-9a-f]{64}$/;
const MAX_PAIRED_CLIENTS_PER_DEVICE = 256;
const REGISTRABLE_DEVICE_ID = /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{32,64})$/;

function sha256(value) {
  return createHash('sha256').update(String(value)).digest('hex');
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isHexHash(value) {
  return HEX_HASH.test(String(value || ''));
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

export function readDeviceCredentials(request, url) {
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

function applyStoredClient(client) {
  const profile = clientProfile(client);
  client.name = profile.name;
  client.platform = profile.platform;
  client.browser = profile.browser;
  client.createdAt = Number.isFinite(client.createdAt) ? client.createdAt : Date.now();
  client.lastSeenAt = Number.isFinite(client.lastSeenAt) ? client.lastSeenAt : client.createdAt;
}

export class DeviceStore {
  constructor(dataDir) {
    this.path = join(dataDir, 'devices.json');
    this.devices = new Map();
    try {
      const parsed = JSON.parse(readFileSync(this.path, 'utf8'));
      if (!isPlainObject(parsed)) {
        throw new TypeError('device store root is invalid');
      }
      for (const [id, row] of Object.entries(parsed)) {
        if (
          !isRoutingId(id) ||
          !isPlainObject(row) ||
          !isHexHash(row.secretHash) ||
          (row.clientTokenHash && !isHexHash(row.clientTokenHash)) ||
          (row.clients && !isPlainObject(row.clients))
        ) {
          throw new TypeError('device store row is invalid');
        }
        if (!row.clientTokenHash) row.clientTokenHash = '';
        if (!row.clients) row.clients = {};
        for (const [clientId, client] of Object.entries(row.clients)) {
          if (!isRoutingId(clientId) || !isPlainObject(client) || !isHexHash(client.tokenHash)) {
            throw new TypeError('device store client row is invalid');
          }
          applyStoredClient(client);
        }
        this.devices.set(id, row);
      }
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        throw new Error(`failed to load device store: ${error.message}`, { cause: error });
      }
    }
    // sha256(token) hex -> deviceId. Phone auth is on the hot path of every
    // /ws upgrade and static GET; a linear scan over all devices would decay
    // with fleet size. Indexing by digest keeps lookup O(1) and leaks nothing
    // useful: matching a key requires the token preimage.
    this.tokenIndex = new Map();
    this.clientTokenIndex = new Map();
    for (const [id, row] of this.devices) {
      if (row.clientTokenHash) this.tokenIndex.set(row.clientTokenHash, id);
      for (const [clientId, client] of Object.entries(row.clients)) {
        this.clientTokenIndex.set(client.tokenHash, { deviceId: id, clientId });
      }
    }
    this.saveTimer = null;
  }

  // Throws on failure by design: registration and revocation acknowledge their
  // caller only once the credential change is on disk, and a swallowed write
  // here would report success for state that reappears after a restart.
  save() {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    const plain = Object.fromEntries(this.devices);
    const directory = dirname(this.path);
    const temporary = join(directory, `.devices-${process.pid}-${randomUUID()}.tmp`);
    try {
      mkdirSync(directory, { recursive: true });
      // Write-then-rename keeps the previous authentication database intact
      // across interruption; the replacement itself is owner-only.
      writeFileSync(temporary, JSON.stringify(plain, null, 2), {
        encoding: 'utf8',
        mode: 0o600,
      });
      chmodSync(temporary, 0o600);
      renameSync(temporary, this.path);
      // Past the rename the state IS committed. A chmod hiccup here (exotic fs,
      // Windows) must not be reported as a failed write: callers would roll
      // back live state that the next restart loads anyway.
      try {
        chmodSync(this.path, 0o600);
      } catch (error) {
        console.error('[relay] device store written but not tightened:', error.message);
      }
    } finally {
      rmSync(temporary, { force: true });
    }
  }

  /** Persist for the paths with nobody to answer (the debounced beat and the
   *  shutdown flush). False means the write did not land. */
  saveOrLog() {
    try {
      this.save();
      return true;
    } catch (error) {
      console.error('[relay] failed to persist device store:', error.message);
      return false;
    }
  }

  // A relay restart makes the whole fleet redial at once; coalescing the
  // (synchronous) devices.json rewrites keeps that stampede off the event
  // loop. Registration is still durable within a beat, and close() flushes.
  scheduleSave() {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.saveOrLog();
    }, 250);
    this.saveTimer.unref?.();
  }

  isKnown(deviceId) {
    return this.devices.has(deviceId);
  }

  // Trust-on-first-use registration is what makes setup zero-config, but an
  // unauthenticated caller must not be able to mint rows at network speed.
  // The caller applies the per-IP registration limiter; legitimate fleet
  // growth itself is unbounded here and can move to sharded storage later.
  authenticate(deviceId, secret) {
    const known = this.devices.get(deviceId);
    if (!known) {
      // A NEW id is bound to whichever secret arrives first, so the id itself
      // has to be unguessable: a short or predictable label could be preclaimed
      // before the real device ever dials, and the owner would then be locked
      // out of its own route. Desktops and hook workers mint a UUID; ids
      // already in the store keep authenticating on their secret alone.
      if (!registrableDeviceId(deviceId)) return false;
      this.devices.set(deviceId, { secretHash: sha256(secret), clientTokenHash: '', clients: {} });
      // Persist BEFORE the credential goes live. A registration that only
      // exists in memory authenticates until the next restart and then
      // silently becomes a stranger — worse, a failed write would leave the id
      // claimed here while the owner's next dial re-registers it elsewhere.
      if (!this.saveOrLog()) {
        this.devices.delete(deviceId);
        return false;
      }
      return true;
    }
    return hashesMatch(known.secretHash, secret);
  }

  setClientToken(deviceId, token) {
    const known = this.devices.get(deviceId);
    if (!known) return false;
    const hash = sha256(token);
    // Every desktop reconnect re-announces its (unchanged) pairing token;
    // rewriting the store for that would turn restarts into a write storm. A
    // CHANGED token is rare, so it persists synchronously before it is honored.
    if (known.clientTokenHash === hash) return true;
    const previousHash = known.clientTokenHash;
    if (previousHash) this.tokenIndex.delete(previousHash);
    known.clientTokenHash = hash;
    this.tokenIndex.set(hash, deviceId);
    if (!this.saveOrLog()) {
      this.tokenIndex.delete(hash);
      known.clientTokenHash = previousHash;
      if (previousHash) this.tokenIndex.set(previousHash, deviceId);
      return false;
    }
    return true;
  }

  revoke(deviceId) {
    const known = this.devices.get(deviceId);
    if (!known) return false;
    if (known.clientTokenHash) this.tokenIndex.delete(known.clientTokenHash);
    for (const client of Object.values(known.clients || {})) {
      this.clientTokenIndex.delete(client.tokenHash);
    }
    this.devices.delete(deviceId);
    // The acknowledgement is the durability boundary for Unpair: persist
    // synchronously before telling the desktop that the registration is gone.
    // A write that fails is reported as a failed revocation — otherwise the
    // credential returns on the next restart while the user was told it was
    // gone; restore the in-memory row so relay and disk stay one state.
    if (!this.saveOrLog()) {
      this.devices.set(deviceId, known);
      if (known.clientTokenHash) this.tokenIndex.set(known.clientTokenHash, deviceId);
      for (const [clientId, client] of Object.entries(known.clients || {})) {
        this.clientTokenIndex.set(client.tokenHash, { deviceId, clientId });
      }
      return false;
    }
    return true;
  }

  deviceIdForClientToken(token) {
    return this.clientAccessForToken(token)?.deviceId ?? null;
  }

  clientAccessForToken(token) {
    if (!token) return null;
    const hash = sha256(token);
    const deviceId = this.tokenIndex.get(hash);
    if (deviceId) return { deviceId, clientId: null };
    return this.clientTokenIndex.get(hash) ?? null;
  }

  registerClient(deviceId, clientId, profile = {}) {
    const known = this.devices.get(deviceId);
    if (!known || !isRoutingId(clientId)) return null;
    known.clients ||= {};
    if (!known.clients[clientId] && Object.keys(known.clients).length >= MAX_PAIRED_CLIENTS_PER_DEVICE) return null;
    const previous = known.clients[clientId];
    if (previous?.tokenHash) this.clientTokenIndex.delete(previous.tokenHash);
    const token = randomBytes(32).toString('hex');
    const now = Date.now();
    const client = {
      tokenHash: sha256(token),
      ...clientProfile(profile),
      createdAt: previous?.createdAt || now,
      lastSeenAt: now,
    };
    known.clients[clientId] = client;
    this.clientTokenIndex.set(client.tokenHash, { deviceId, clientId });
    // The token IS the answer to the caller: handing out one the store could
    // not record would authenticate a browser only until the next restart.
    if (!this.saveOrLog()) {
      delete known.clients[clientId];
      this.clientTokenIndex.delete(client.tokenHash);
      if (previous?.tokenHash) {
        known.clients[clientId] = previous;
        this.clientTokenIndex.set(previous.tokenHash, { deviceId, clientId });
      }
      return null;
    }
    return { token, client: { id: clientId, ...client } };
  }

  touchClient(deviceId, clientId, profile = {}) {
    const client = this.devices.get(deviceId)?.clients?.[clientId];
    if (!client) return false;
    client.lastSeenAt = Date.now();
    if (profile.name) client.name = clipField(profile.name);
    if (profile.platform) client.platform = clipField(profile.platform);
    if (profile.browser) client.browser = clipField(profile.browser);
    this.scheduleSave();
    return true;
  }

  listClients(deviceId, online = new Set()) {
    const clients = this.devices.get(deviceId)?.clients || {};
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

  revokeClient(deviceId, clientId) {
    const known = this.devices.get(deviceId);
    const client = known?.clients?.[clientId];
    if (!known || !client) return false;
    this.clientTokenIndex.delete(client.tokenHash);
    delete known.clients[clientId];
    // Same durability boundary as device revocation: a browser reported as
    // unpaired must not come back when the relay restarts.
    if (!this.saveOrLog()) {
      known.clients[clientId] = client;
      this.clientTokenIndex.set(client.tokenHash, { deviceId, clientId });
      return false;
    }
    return true;
  }
}
