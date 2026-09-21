/**
 * The loopback bridge the session runtime's `computer` tool talks to. It is
 * published through a heartbeated discovery file. Native workers start on
 * demand, and a dropped connection is treated as the caller's abort.
 */
import { randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { createBridgeDiscovery } from '../../bridge/discovery-file';
import { CHROME_SETUP_SESSION_ID } from '../session/chrome-setup';
import { computerUseCoordinator } from '../session/coordinator';
import { createBridgeServerState, type BridgeServerHost } from './bridge-server-contract';
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

export function createBridgeServer(host: BridgeServerHost) {
  const {
    powerShellBySession,
    elevatedSessionIds,
    abortComputerSession,
    reapIdleSessionWorkers,
    dataDirectory,
    isBridgeWanted,
    isDisposed,
    diagnose,
  } = host;
  const discovery = createBridgeDiscovery({
    fileName: 'computer-bridge.json',
    dataDirectory,
  });
  const state = createBridgeServerState();

  /** Every live session is aborted; the coordinator resets only once the
   *  aborts settled and input cleanup is confirmed. */
  async function releaseSessions(): Promise<void> {
    const stopped = await Promise.allSettled(
      [...new Set([...powerShellBySession.keys(), ...elevatedSessionIds()])]
        .filter((sessionId) => sessionId !== CHROME_SETUP_SESSION_ID)
        .map((sessionId) =>
          abortComputerSession({
            action: 'session_abort',
            session_id: sessionId,
          })
        )
    );
    const cleanupConfirmed = (await host.waitForCleanup?.()) ?? true;
    if (cleanupConfirmed && stopped.every((result) => result.status === 'fulfilled')) computerUseCoordinator.reset();
    else computerUseCoordinator.pauseForUser('input_cleanup_unconfirmed');
  }

  async function stopBridge(): Promise<void> {
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
      if (isBridgeWanted() && !isDisposed()) startBridge();
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
    created.listen(0, '127.0.0.1', () => {
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
          reapIdleSessionWorkers,
          diagnose,
          restart: stopBridge,
        },
        { port, token: activeToken, generation, startedAt, stillCurrent }
      );
    });
  }

  return { startBridge, stopBridge };
}
