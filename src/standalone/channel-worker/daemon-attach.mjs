// channel-worker/daemon-attach.mjs
// The worker's one live attachment to the channel daemon: discover → verify
// the daemon behind the discovery file → attach, spawning a daemon when none
// answers, with a bounded deadline. A generation counter invalidates attaches
// still in flight when the client is dropped (transport failure, SSE fatal,
// stop), so a superseded attach closes itself instead of becoming current.
import { attachChannel, probeChannelHealth } from '../channel-client.mjs';

const ATTACH_DEADLINE_MS = 30_000;
const MAX_AUTH_REJECTIONS = 5;
const delay = (ms) => new Promise((resolveDelay) => setTimeout(resolveDelay, ms));

function attachCancelledError() {
  const error = new Error('channel service attach superseded');
  error.daemonAttachCancelled = true;
  return error;
}

const sameDaemon = (health, discovery) => Number(health?.pid) === Number(discovery.pid);

export function createDaemonAttachment({ discoverChannel, spawnDaemon, leadPid, cwd, getSessionId, onNotify, log }) {
  let client = null;
  let pid = null;
  let attachPromise = null;
  let generation = 0;
  let stopRequested = false;

  const cancelled = (gen) => stopRequested || gen !== generation;

  function invalidate(reason = 'invalidate', expected = null) {
    if (expected && client !== expected) return;
    generation += 1;
    const dropped = client;
    client = null;
    attachPromise = null;
    pid = null;
    if (dropped) {
      try {
        dropped.close(reason);
      } catch {}
    }
  }

  async function attachTo(discovery, gen) {
    let attached = null;
    let fatalDuringAttach = false;
    attached = await attachChannel({
      discovery,
      leadPid,
      cwd,
      restoreSessionId: typeof getSessionId === 'function' ? getSessionId() : null,
      onNotify: (message) => {
        try {
          onNotify?.(message);
        } catch {}
      },
      onFatal: () => {
        fatalDuringAttach = true;
        invalidate('sse fatal', attached);
        if (!stopRequested) void ensureAttached().catch(() => {});
      },
      log,
    });
    if (cancelled(gen) || fatalDuringAttach) {
      await attached.close('attach superseded');
      const error = attachCancelledError();
      if (fatalDuringAttach && !cancelled(gen)) error.daemonDiscoveryStale = true;
      throw error;
    }
    client = attached;
    pid = discovery.pid;
    return attached;
  }

  /** Attaches to a discovered daemon once its health answers with the
   *  discovered pid; resolves null when it does not. */
  async function attachIfLive(discovery, gen, timeoutMs) {
    const health = await probeChannelHealth({ port: discovery.port, token: discovery.token, timeoutMs });
    if (cancelled(gen)) throw attachCancelledError();
    return sameDaemon(health, discovery) ? attachTo(discovery, gen) : null;
  }

  async function attachLoop(gen) {
    const deadline = Date.now() + ATTACH_DEADLINE_MS;
    let authRejections = 0;
    for (let attempt = 0; ; attempt += 1) {
      if (cancelled(gen)) throw attachCancelledError();
      let discovery = discoverChannel();
      if (discovery) {
        try {
          const attached = await attachIfLive(discovery, gen, attempt === 0 ? 800 : 2_000);
          if (attached) return attached;
        } catch (error) {
          if (!error?.daemonDiscoveryStale) throw error;
          if (error?.daemonAuthRejected) authRejections += 1;
          if (authRejections >= MAX_AUTH_REJECTIONS || Date.now() >= deadline) {
            throw new Error('channel service repeatedly rejected discovery authentication');
          }
          await delay(Math.min(200 * 2 ** authRejections, 2_000));
          continue;
        }
      }
      await spawnDaemon();
      discovery = discoverChannel();
      if (discovery) {
        const health = await probeChannelHealth({ port: discovery.port, token: discovery.token, timeoutMs: 3_000 });
        if (sameDaemon(health, discovery)) {
          try {
            return await attachTo(discovery, gen);
          } catch (error) {
            if (!error?.daemonDiscoveryStale) throw error;
          }
        }
      }
      if (Date.now() >= deadline) throw new Error('channel service did not become ready');
      await delay(200);
    }
  }

  async function ensureAttached() {
    if (stopRequested) throw attachCancelledError();
    if (client) return client;
    if (attachPromise) return attachPromise;
    const promise = attachLoop(generation);
    attachPromise = promise;
    try {
      return await promise;
    } finally {
      if (attachPromise === promise) attachPromise = null;
    }
  }

  /** Drops the current client without closing it and hands back what stop()
   *  must settle: the client to close and any attach still in flight. */
  function detach() {
    const inFlightAttach = attachPromise;
    generation += 1;
    const current = client;
    client = null;
    attachPromise = null;
    pid = null;
    return { client: current, inFlightAttach };
  }

  return {
    ensureAttached,
    invalidate,
    detach,
    requestStop: () => {
      stopRequested = true;
    },
    resume: () => {
      stopRequested = false;
    },
    current: () => client,
    pid: () => pid,
  };
}
