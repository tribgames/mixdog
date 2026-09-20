import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readLiveServiceAdvert } from '../../runtime/shared/service-discovery.mjs';
import { isPidAlive, parsePid } from '../../runtime/shared/pid-liveness.mjs';
import { readSingletonOwner, releaseSingletonOwner } from '../../runtime/shared/singleton-owner.mjs';
import { resolveRuntimeRoot } from '../../runtime/shared/runtime-root.mjs';
import { sleep as delay } from '../../runtime/shared/sleep.mjs';
import { requestJson } from './rpc.mjs';

function readActiveInstance() {
  try {
    return JSON.parse(readFileSync(join(resolveRuntimeRoot(), 'active-instance.json'), 'utf8'));
  } catch {
    return null;
  }
}

function parsePort(value) {
  const port = Number(value);
  return Number.isInteger(port) && port > 0 && port < 65536 ? port : null;
}

// The published daemon endpoint: the single-writer discovery advert
// (discovery/memory.json) first, then the legacy active-instance.json
// memory_port/memory_server_pid fields as a cross-version fallback.
function readPublishedDaemon() {
  const advert = readLiveServiceAdvert('memory', { requirePid: false });
  const active = advert ? null : readActiveInstance();
  const port = advert ? parsePort(advert.port) : parsePort(active?.memory_port);
  if (!port) return null;
  const ownerPid = advert ? parsePid(advert.pid) : parsePid(active?.memory_server_pid);
  return { port, ownerPid };
}

export function createDaemonDiscovery({ state, ownerPath, singletonEnabled }) {
  async function isHealthyPort(port, timeoutMs = 1500) {
    try {
      const health = await requestJson({ port, path: '/health', timeoutMs });
      return health?.status === 'ok';
    } catch {
      return false;
    }
  }
  // A health probe failed (ECONNREFUSED / timeout) against a published port:
  // when the on-disk owner is a dead pid, release it so a fresh claim in
  // start() is not blocked by a corpse owner file.
  function releaseDeadOwner() {
    if (!singletonEnabled) return;
    const owner = readSingletonOwner(ownerPath);
    if (owner.owner && !owner.alive) {
      try {
        releaseSingletonOwner(ownerPath, parsePid(owner.owner.pid) ?? process.pid);
      } catch {}
    }
  }
  async function findLivePort({ allowStarting = false } = {}) {
    const published = readPublishedDaemon();
    if (!published) return null;
    // A dead server pid means the published port is stale — the daemon that
    // owned it is gone. Clearing the cache lets the caller re-claim + respawn
    // instead of wedging on the stale port.
    if (published.ownerPid && !isPidAlive(published.ownerPid)) {
      state.portCache = null;
      return null;
    }
    const { port } = published;
    try {
      const health = await requestJson({ port, path: '/health', timeoutMs: allowStarting ? 2000 : 500 });
      if (health?.status === 'ok' || (allowStarting && health?.status === 'starting')) {
        state.portCache = port;
        return port;
      }
    } catch {}
    // Reachable-but-unhealthy or unreachable: treat the published port as
    // stale so start() falls through to (re)claim the singleton and respawn.
    state.portCache = null;
    releaseDeadOwner();
    return null;
  }
  async function waitForPort(timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    let lastError = null;
    while (Date.now() < deadline) {
      const port = await findLivePort({ allowStarting: true });
      if (port) {
        try {
          const health = await requestJson({ port, path: '/health', timeoutMs: 1500 });
          if (health?.status === 'ok') return port;
        } catch (error) {
          lastError = error;
        }
      }
      await delay(100);
    }
    throw lastError || new Error('memory runtime did not become ready');
  }
  return { findLivePort, waitForPort, isHealthyPort };
}
