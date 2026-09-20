import { readSingletonOwner } from '../../runtime/shared/singleton-owner.mjs';
import { MEMORY_CRASH_COOLDOWN_MS } from './daemon-spawn.mjs';

const running = (port) => ({ running: true, port, mode: 'http-proxy' });

// start(): reuse a live daemon (cached port, then the published one), honour
// a cached deterministic crash, and otherwise share one claim + fork across
// concurrent callers.
export function createDaemonStarter({ state, ownerPath, singletonEnabled, discovery, ownerClaim, spawner }) {
  async function findReusablePort() {
    if (state.portCache) {
      const port = await discovery.findLivePort();
      if (port) return port;
      state.portCache = null;
    }
    return await discovery.findLivePort();
  }
  // Persistent crash-loop guard: no live daemon and a recent deterministic
  // spawn crash → fail fast with the cached reason. But a healthy singleton
  // owner may be mid-boot and not yet advertising a port; await it before
  // trusting the cached crash so a recovering daemon is not handed a stale
  // hard failure.
  async function resolveCachedCrash() {
    if (singletonEnabled && readSingletonOwner(ownerPath).alive) {
      const live = await discovery.waitForPort(15_000);
      state.crashState = null;
      return live;
    }
    throw new Error(state.crashState.reason);
  }
  async function claimAndSpawn() {
    const livePort = await ownerClaim.acquireOwnership();
    if (livePort) return livePort;
    return await spawner.spawnDaemon();
  }
  return async function start() {
    const existing = await findReusablePort();
    if (existing) {
      state.crashState = null;
      return running(existing);
    }
    if (state.crashState && Date.now() - state.crashState.at < MEMORY_CRASH_COOLDOWN_MS) {
      return running(await resolveCachedCrash());
    }
    if (state.startPromise) return running(await state.startPromise);
    state.startPromise = claimAndSpawn().finally(() => {
      state.startPromise = null;
    });
    return running(await state.startPromise);
  };
}
