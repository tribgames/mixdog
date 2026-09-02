/**
 * Discovery-file reader shared by the Browser Use and Computer Use clients.
 * The desktop app publishes `{ version, port, token, pid }` for each bridge;
 * the runtime trusts the file only while it is fresh (heartbeat touched it
 * recently) and its writer is still alive. A dead writer's file is stale even
 * when fresh: a live app's heartbeat may keep touching a file another process
 * overwrote before crashing, and that must not surface a dead tool.
 */
import { readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const DISCOVERY_VERSION = 1;
/** Bridge heartbeat touches the file every 60s; anything older is a crash
 *  leftover and must not surface a dead tool. */
const DISCOVERY_MAX_AGE_MS = 5 * 60_000;

/** Same resolution the desktop uses when publishing: an isolated profile sets
 *  MIXDOG_BRIDGE_DISCOVERY_DIR so its bridges stay out of the shared data dir. */
export function bridgeDiscoveryDirectory() {
  return process.env.MIXDOG_BRIDGE_DISCOVERY_DIR
    || process.env.MIXDOG_DATA_DIR
    || join(process.env.MIXDOG_HOME || join(homedir(), '.mixdog'), 'data');
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
 *  `reason` available through {@link readBridgeDiscoveryDetail}. */
export function readBridgeDiscovery(fileName) {
  return readBridgeDiscoveryDetail(fileName).discovery;
}

export function readBridgeDiscoveryDetail(fileName) {
  const path = join(bridgeDiscoveryDirectory(), fileName);
  let parsed;
  try {
    if (Date.now() - statSync(path).mtimeMs >= DISCOVERY_MAX_AGE_MS) {
      return { discovery: null, reason: 'expired' };
    }
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return { discovery: null, reason: 'missing' };
  }
  const version = Number(parsed?.version);
  const port = Number(parsed?.port);
  const token = String(parsed?.token || '');
  const pid = Number(parsed?.pid || 0);
  if (version !== DISCOVERY_VERSION
    || !Number.isInteger(port) || port <= 0 || port > 65_535 || !token) {
    return { discovery: null, reason: 'invalid' };
  }
  if (!processAlive(pid)) {
    return { discovery: null, reason: `stale (writer pid ${pid} has exited)` };
  }
  return { discovery: { port, token }, reason: '' };
}
