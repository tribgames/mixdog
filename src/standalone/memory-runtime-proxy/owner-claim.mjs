import {
  claimSingletonOwner,
  handoffSingletonOwner,
  readSingletonOwner,
  releaseSingletonOwner,
} from '../../runtime/shared/singleton-owner.mjs';
import { sleep as delay } from '../../runtime/shared/sleep.mjs';

const NOT_READY = 'memory runtime did not become ready';

// Singleton-owner claim for the daemon: at most one proxy per machine forks
// the memory daemon; the others attach to the winner's published port.
export function createOwnerClaim({ ownerPath, singletonEnabled, cwd, discovery }) {
  function claimOwner() {
    if (!singletonEnabled) return { owned: true, owner: { pid: process.pid } };
    return claimSingletonOwner(ownerPath, {
      kind: 'memory-runtime-daemon',
      pid: process.pid,
      meta: { cwd, clientPid: process.pid },
    });
  }
  function releaseOwnerIfSelf() {
    if (!singletonEnabled) return;
    releaseSingletonOwner(ownerPath, process.pid);
  }
  // Atomic parent->child handoff under the claim lock. A plain
  // release()+claim() opened a window where a concurrent proxy could claim +
  // fork a competing daemon; the loser child then died on the owner lock and
  // its ready promise rejected instead of falling back.
  function handoffToChild(childPid) {
    if (!singletonEnabled || !childPid) return;
    handoffSingletonOwner(ownerPath, process.pid, {
      kind: 'memory-runtime-daemon',
      pid: childPid,
      meta: { cwd, launcherPid: process.pid },
    });
  }
  function releaseChild(childPid) {
    if (singletonEnabled && childPid) releaseSingletonOwner(ownerPath, childPid);
  }
  // Another owner holds the singleton. If it is live AND serving a healthy
  // port, use it. If it is live but NOT healthy (a daemon that is draining /
  // shutting down never revives), poll: reclaim the instant the old owner
  // exits so a quick restart still ends with a fresh, working daemon instead
  // of binding to the dying one and failing the pending RPC.
  async function waitForOwnerOrLivePort() {
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      const livePort = await discovery.findLivePort({ allowStarting: true });
      if (livePort && (await discovery.isHealthyPort(livePort))) return livePort;
      if (claimOwner().owned) return null;
      await delay(150);
    }
    const owner = readSingletonOwner(ownerPath);
    if (owner.alive) throw new Error(NOT_READY);
    releaseOwnerIfSelf();
    if (!claimOwner().owned) throw new Error(NOT_READY);
    return null;
  }
  // Resolves to a live port served by another owner, or to null once THIS
  // proxy owns the claim and must fork the daemon itself.
  async function acquireOwnership() {
    if (claimOwner().owned) return null;
    return await waitForOwnerOrLivePort();
  }
  return { acquireOwnership, handoffToChild, releaseChild };
}
