/**
 * Discovery-file reader shared by the Browser Use and Computer Use clients.
 * The desktop app publishes `{ version, port, token, pid }` for each bridge;
 * the runtime trusts the file only while it is fresh (heartbeat touched it
 * recently) and its writer is still alive. A dead writer's file is stale even
 * when fresh: a live app's heartbeat may keep touching a file another process
 * overwrote before crashing, and that must not surface a dead tool.
 */
import { readFileSync, statSync } from 'node:fs';
import { readFile, stat as statAsync } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { createWatchedFileCache } from './shared/watched-file-cache.mjs';

const DISCOVERY_VERSION = 1;
/** Bridge heartbeat touches the file every 60s; anything older is a crash
 *  leftover and must not surface a dead tool. */
const DISCOVERY_MAX_AGE_MS = 5 * 60_000;

/** Same resolution the desktop uses when publishing: an isolated profile sets
 *  MIXDOG_BRIDGE_DISCOVERY_DIR so its bridges stay out of the shared data dir. */
export function bridgeDiscoveryDirectory() {
  return (
    process.env.MIXDOG_BRIDGE_DISCOVERY_DIR ||
    process.env.MIXDOG_DATA_DIR ||
    join(process.env.MIXDOG_HOME || join(homedir(), '.mixdog'), 'data')
  );
}

/** True unless the pid is known not to exist. A permission error still means
 *  a process is there, so it counts as alive. */
export function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code !== 'ESRCH';
  }
}

/** `{ port, token }` when the bridge is discoverable, otherwise `null` with a
 *  `reason` available through {@link readBridgeDiscoveryDetail}. Answers from
 *  the watched copy: for availability gates, which must not touch the disk. */
export function readBridgeDiscovery(fileName) {
  return readBridgeDiscoveryDetail(fileName).discovery;
}

/** {@link readBridgeDiscovery} read from the file now, off the loop: a request
 *  about to go out, or the check for a replacement after one failed, must see
 *  a bridge the desktop republished a moment ago, which the watched copy
 *  learns only after its debounced re-read. A read that fails (a sharing
 *  violation, a half-written file) answers the last good advertisement. */
export async function readBridgeDiscoveryFresh(fileName) {
  return (await readBridgeDiscoveryFreshDetail(fileName)).discovery;
}

/** True when the on-disk advertisement names a different loopback endpoint
 *  than the one this call already used. Observations may retry there;
 *  mutations must not. */
export function bridgeDiscoveryChanged(current, replacement) {
  return Boolean(replacement && (replacement.port !== current?.port || replacement.token !== current?.token));
}

// Status reads ask often: the file is kept in memory and reloaded
// off the loop once it changed (a heartbeat touch included). A fresh read
// (a request) loads it now and refreshes the copy.
const advertisement = (stat, text) => ({
  value: { mtimeMs: Number(stat.mtimeMs), parsed: JSON.parse(text) },
});
// Only a file that is not there reads as missing; a read that failed or
// found no JSON throws, so the cache keeps the last advertisement.
const absent = (error) => {
  if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return { value: null };
  throw error;
};
async function loadAdvertisementAsync(path) {
  try {
    return advertisement(await statAsync(path), await readFile(path, 'utf8'));
  } catch (error) {
    return absent(error);
  }
}
const changeListeners = new Set();
const announce = (path) => {
  for (const listener of changeListeners) {
    try {
      listener(path);
    } catch {}
  }
};
// path -> generation of its cached advertisement: advanced by every change the
// watch reports, every cold read and every store of a fresh read, so a fresh
// read that finishes after another value landed knows it was overtaken.
const generations = new Map();
const generationOf = (path) => generations.get(path) ?? 0;
const advance = (path) => generations.set(path, generationOf(path) + 1);
const discoveryCache = createWatchedFileCache(
  {
    // A cold read: the copy takes what it returns at once, with no change
    // reported, so it advances the generation itself.
    load(path) {
      let loaded;
      try {
        loaded = advertisement(statSync(path), readFileSync(path, 'utf8'));
      } catch (error) {
        loaded = absent(error);
      }
      advance(path);
      return loaded;
    },
    loadAsync: loadAdvertisementAsync,
  },
  {
    onChange(path) {
      advance(path);
      announce(path);
    },
  }
);

/** Test seam: resolves once the watched copy of `path` has no re-read due,
 *  queued or running; rejects after `timeoutMs`. */
export function _bridgeDiscoverySettledForTest(path, timeoutMs) {
  return discoveryCache._settledForTest(path, timeoutMs);
}

/** `listener(path)` hears every change of an advertisement the watched copy
 *  holds (the full path of its file). Returns the unsubscribe. */
export function onBridgeDiscoveryChange(listener) {
  changeListeners.add(listener);
  return () => changeListeners.delete(listener);
}

const failureReason = (error) =>
  error instanceof SyntaxError ? 'invalid' : `unreadable (${error?.code || error?.message})`;

function cachedAdvertisement(path) {
  try {
    return { entry: discoveryCache.get(path) };
  } catch (error) {
    return { reason: failureReason(error) };
  }
}

export function readBridgeDiscoveryDetail(fileName) {
  return discoveryDetail(cachedAdvertisement(join(bridgeDiscoveryDirectory(), fileName)));
}

/** {@link readBridgeDiscoveryDetail} of {@link readBridgeDiscoveryFresh}. */
export async function readBridgeDiscoveryFreshDetail(fileName) {
  const path = join(bridgeDiscoveryDirectory(), fileName);
  const started = generationOf(path);
  let loaded;
  try {
    loaded = await loadAdvertisementAsync(path);
  } catch (error) {
    // The copy still holds the last good advertisement (undefined: none yet).
    const current = discoveryCache.peek(path);
    return discoveryDetail(current === undefined ? { reason: failureReason(error) } : { entry: current });
  }
  // A change landed while this read was out: its bytes may be older than the
  // copy's, which is the answer instead.
  if (generationOf(path) !== started) return discoveryDetail({ entry: discoveryCache.peek(path) });
  const current = discoveryCache.peek(path);
  discoveryCache.set(path, loaded.value);
  advance(path);
  if (current !== undefined && !isDeepStrictEqual(current, loaded.value)) announce(path);
  return discoveryDetail({ entry: loaded.value });
}

function discoveryDetail({ entry, reason }) {
  if (reason) return { discovery: null, reason };
  if (!entry) return { discovery: null, reason: 'missing' };
  if (Date.now() - entry.mtimeMs >= DISCOVERY_MAX_AGE_MS) return { discovery: null, reason: 'expired' };
  const { parsed } = entry;
  const version = Number(parsed?.version);
  const port = Number(parsed?.port);
  const token = String(parsed?.token || '');
  const pid = Number(parsed?.pid || 0);
  if (version !== DISCOVERY_VERSION || !Number.isInteger(port) || port <= 0 || port > 65_535 || !token) {
    return { discovery: null, reason: 'invalid' };
  }
  if (!processAlive(pid)) {
    return { discovery: null, reason: `stale (writer pid ${pid} has exited)` };
  }
  return { discovery: { port, token }, reason: '' };
}
