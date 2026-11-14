/**
 * The loopback bridge the Node-hosted session runtime's `computer` tool talks to. It is published through a
 * heartbeated discovery file and forwards every command to the core's computer service; a dropped connection is
 * the caller's abort.
 */
import { randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { listenOnFetchSafePort } from '../../../shared/core-src/runtime/shared/fetch-safe-listen.mjs';
import { createBridgeDiscovery } from '../../bridge/discovery-file';
import { createBridgeServerState, type BridgeServerHost } from './bridge-server-contract';
import { abortSessionOnCore } from './bridge-command-dispatch';
import { publishBridgeDiscovery } from './bridge-server-discovery';
import { createBridgeRequestHandler } from './bridge-server-request';

export type { BridgeServerHost } from './bridge-server-contract';

function closeServer(active: Server): Promise<void> {
  return new Promise<void>((resolve) => {
    active.close(() => resolve());
    active.closeAllConnections?.();
    setTimeout(resolve, 250).unref?.();
  });
}

/** Pause before restarting a bridge whose server failed to listen. */
export const LISTEN_RETRY_MS = 5_000;

export function createBridgeServer(host: BridgeServerHost) {
  const { callCore, dataDirectory, isBridgeWanted, isDisposed, diagnose } = host;
  const discovery = createBridgeDiscovery({
    fileName: 'computer-bridge.json',
    dataDirectory,
  });
  const state = createBridgeServerState();

  /** Every session that sent a command is ended in the core (its queued and running work, its helper's input). */
  async function releaseSessions(): Promise<void> {
    const sessions = [...state.sessions];
    state.sessions.clear();
    await Promise.allSettled(sessions.map((sessionKey) => abortSessionOnCore(callCore, sessionKey)));
  }

  let listenRetryTimer: NodeJS.Timeout | null = null;
  const clearListenRetry = (): void => {
    if (listenRetryTimer) clearTimeout(listenRetryTimer);
    listenRetryTimer = null;
  };

  /** One restart after a listen failure, a pause later, if still wanted. */
  function scheduleListenRetry(): void {
    clearListenRetry();
    listenRetryTimer = setTimeout(() => {
      listenRetryTimer = null;
      if (isBridgeWanted() && !isDisposed()) startBridge();
    }, LISTEN_RETRY_MS);
    listenRetryTimer.unref?.();
  }

  /** Bumped by every explicit stop; a listen-failure cleanup that an explicit stop overtook must not arm a retry. */
  let explicitStops = 0;

  async function stopBridge(restartNow = true): Promise<void> {
    if (restartNow) explicitStops += 1;
    clearListenRetry();
    if (state.stopPromise) return await state.stopPromise;
    state.stopPromise = (async () => {
      state.generation += 1;
      if (state.heartbeat) clearInterval(state.heartbeat);
      state.heartbeat = null;
      const activeDiscovery = state.discoveryRecord;
      state.discoveryRecord = null;
      if (activeDiscovery) discovery.removeDiscovery(activeDiscovery);
      const activeServer = state.server;
      state.server = null;
      if (activeServer) await closeServer(activeServer);
      await releaseSessions();
    })();
    try {
      await state.stopPromise;
    } finally {
      state.stopPromise = null;
      if (restartNow && isBridgeWanted() && !isDisposed()) startBridge();
    }
  }

  function startBridge(): void {
    if (isDisposed() || !isBridgeWanted() || state.server || state.stopPromise) return;
    const generation = ++state.generation;
    const activeToken = randomBytes(24).toString('base64url');
    const startedAt = Date.now();
    diagnose('computer-bridge-start', { generation });
    const created = createServer(
      createBridgeRequestHandler({ host, state, respond: discovery.respond }, activeToken, generation)
    );
    created.maxConnections = 64;
    created.headersTimeout = 10_000;
    created.requestTimeout = 30_000;
    created.keepAliveTimeout = 5_000;
    state.server = created;
    const stillCurrent = (): boolean =>
      !isDisposed() && isBridgeWanted() && state.server === created && state.generation === generation;
    created.once('error', (error) => {
      diagnose('computer-bridge-error', { generation, message: error.message });
      // stopBridge clears this server's state and releases what a published generation held; the restart waits, so
      // a persistent failure cannot spin.
      if (state.server !== created) return;
      const stopsBefore = explicitStops;
      void stopBridge(false)
        .catch((stopError) => diagnose('computer-bridge-stop-failed', { message: String(stopError) }))
        .finally(() => {
          if (explicitStops === stopsBefore) scheduleListenRetry();
        });
    });
    listenOnFetchSafePort(
      created,
      '127.0.0.1',
      () => {
        const address = created.address();
        const port = address && typeof address === 'object' ? address.port : 0;
        if (!port) return;
        diagnose('computer-bridge-listening', {
          generation,
          durationMs: Date.now() - startedAt,
        });
        publishBridgeDiscovery(
          {
            state,
            writeDiscovery: discovery.writeDiscovery,
            heartbeatDiscovery: discovery.heartbeatDiscovery,
            diagnose,
            restart: () => stopBridge(),
          },
          { port, token: activeToken, generation, startedAt, stillCurrent }
        );
      },
      { isCurrent: stillCurrent }
    );
  }

  return { startBridge, stopBridge: () => stopBridge() };
}
