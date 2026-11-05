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
 *  `reason` available through {@link readBridgeDiscoveryDetail}. Recovery after
 *  a failed request uses `fresh` to see a replacement before the watch reload. */
export function readBridgeDiscovery(fileName, options) {
  return readBridgeDiscoveryDetail(fileName, options).discovery;
}

/** True when the on-disk advertisement names a different loopback endpoint
 *  than the one this call already used. Observations may retry there;
 *  mutations must not. */
export function bridgeDiscoveryChanged(current, replacement) {
  return Boolean(replacement && (replacement.port !== current?.port || replacement.token !== current?.token));
}

// Status reads ask often: the file is kept in memory and reloaded
// off the loop once it changed (a heartbeat touch included).
const advertisement = (stat, text) => ({
  value: { mtimeMs: Number(stat.mtimeMs), parsed: JSON.parse(text) },
});
// Only a file that is not there reads as missing; a read that failed or
// found no JSON throws, so the cache keeps the last advertisement.
const absent = (error) => {
  if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return { value: null };
  throw error;
};
const discoveryCache = createWatchedFileCache({
  load(path) {
    try {
      return advertisement(statSync(path), readFileSync(path, 'utf8'));
    } catch (error) {
      return absent(error);
    }
  },
  async loadAsync(path) {
    try {
      return advertisement(await statAsync(path), await readFile(path, 'utf8'));
    } catch (error) {
      return absent(error);
    }
  },
});

function cachedAdvertisement(path, options) {
  try {
    return { entry: discoveryCache.get(path, options) };
  } catch (error) {
    return { reason: error instanceof SyntaxError ? 'invalid' : `unreadable (${error?.code || error?.message})` };
  }
}

export function readBridgeDiscoveryDetail(fileName, options) {
  const { entry, reason } = cachedAdvertisement(join(bridgeDiscoveryDirectory(), fileName), options);
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
