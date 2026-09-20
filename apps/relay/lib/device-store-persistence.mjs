import { randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { isRoutingId } from './ids.mjs';
import { clientProfile } from './device-store-auth.mjs';

const HEX_HASH = /^[0-9a-f]{64}$/;

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isHexHash(value) {
  return HEX_HASH.test(String(value || ''));
}

function applyStoredClient(client) {
  const profile = clientProfile(client);
  client.name = profile.name;
  client.platform = profile.platform;
  client.browser = profile.browser;
  client.createdAt = Number.isFinite(client.createdAt) ? client.createdAt : Date.now();
  client.lastSeenAt = Number.isFinite(client.lastSeenAt) ? client.lastSeenAt : client.createdAt;
}

export function loadDeviceStore(path) {
  const devices = new Map();
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
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
      devices.set(id, row);
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      throw new Error(`failed to load device store: ${error.message}`, { cause: error });
    }
  }
  return devices;
}

// sha256(token) hex -> deviceId. Phone auth is on the hot path of every
// /ws upgrade and static GET; a linear scan over all devices would decay
// with fleet size. Indexing by digest keeps lookup O(1) and leaks nothing
// useful: matching a key requires the token preimage.
export function buildTokenIndexes(devices) {
  const tokenIndex = new Map();
  const clientTokenIndex = new Map();
  for (const [id, row] of devices) {
    if (row.clientTokenHash) tokenIndex.set(row.clientTokenHash, id);
    for (const [clientId, client] of Object.entries(row.clients)) {
      clientTokenIndex.set(client.tokenHash, { deviceId: id, clientId });
    }
  }
  return { tokenIndex, clientTokenIndex };
}

// Throws on failure by design: registration and revocation acknowledge their
// caller only once the credential change is on disk, and a swallowed write
// here would report success for state that reappears after a restart.
export function saveDeviceStore(store) {
  const plain = Object.fromEntries(store.devices);
  const directory = dirname(store.path);
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
    renameSync(temporary, store.path);
    // Past the rename the state IS committed. A chmod hiccup here (exotic fs,
    // Windows) must not be reported as a failed write: callers would roll
    // back live state that the next restart loads anyway.
    try {
      chmodSync(store.path, 0o600);
    } catch (error) {
      console.error('[relay] device store written but not tightened:', error.message);
    }
  } finally {
    rmSync(temporary, { force: true });
  }
}

/** Persist for the paths with nobody to answer (the debounced beat and the
 * shutdown flush). False means the write did not land. */
export function saveOrLog(store) {
  try {
    store.save();
    return true;
  } catch (error) {
    console.error('[relay] failed to persist device store:', error.message);
    return false;
  }
}

// A relay restart makes the whole fleet redial at once; coalescing the
// (synchronous) devices.json rewrites keeps that stampede off the event
// loop. Registration is still durable within a beat, and close() flushes.
export function scheduleSave(store) {
  if (store.saveTimer) return;
  store.saveTimer = setTimeout(() => {
    store.saveTimer = null;
    store.saveOrLog();
  }, 250);
  store.saveTimer.unref?.();
}
