/**
 * The loopback bridge the session runtime's `computer` tool talks to. It is
 * published through a heartbeated discovery file only once the resident
 * backend is warm, and a dropped connection is treated as the caller's abort.
 */
import { randomBytes } from 'node:crypto';
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import type { ComputerCommand, ComputerCommandResult } from '../shared/types';
import { createBridgeDiscovery } from '../../bridge/discovery-file';
import {
  bridgeDiscoveryPublicIdentity,
  createBridgeDiscoveryRecord,
  sameBridgeDiscovery,
  type BridgeDiscoveryRecord,
} from '../../bridge/discovery-ownership';
import { CHROME_SETUP_SESSION_ID } from '../session/chrome-setup';
import { computerUseCoordinator } from '../session/coordinator';
import type { createWorkerPool } from '../backend/worker-pool';
import { HOST_WARMUP_SESSION_ID, isComputerLifecycleControl } from './action-sets';
import type { SessionLifecycle } from './session-lifecycle';

const HEARTBEAT_MS = 60_000;

type WorkerPool = ReturnType<typeof createWorkerPool>;

export interface BridgeServerHost extends
  Pick<WorkerPool, 'callPowerShell' | 'adoptWarmedWorker' | 'releaseSpareWorker' | 'powerShellBySession'>,
  Pick<SessionLifecycle, 'abortComputerSession' | 'executeSerialized' | 'reapIdleSessionWorkers'> {
  dataDirectory(): string;
  isBridgeWanted(): boolean;
  isDisposed(): boolean;
  diagnose(event: string, data?: Record<string, unknown>): void;
}

export function createBridgeServer(host: BridgeServerHost) {
  const {
    callPowerShell,
    adoptWarmedWorker,
    releaseSpareWorker,
    powerShellBySession,
    abortComputerSession,
    executeSerialized,
    reapIdleSessionWorkers,
    dataDirectory,
    isBridgeWanted,
    isDisposed,
    diagnose,
  } = host;
  const {
    readRequestBody,
    respond,
    writeDiscovery,
    heartbeatDiscovery,
    removeDiscovery,
  } = createBridgeDiscovery({ fileName: 'computer-bridge.json', dataDirectory });

  let heartbeat: NodeJS.Timeout | null = null;
  let server: Server | null = null;
  let bridgeStopPromise: Promise<void> | null = null;
  let bridgeGeneration = 0;
  let bridgeDiscoveryRecord: BridgeDiscoveryRecord | null = null;

  async function stopBridge(): Promise<void> {
    if (bridgeStopPromise) return await bridgeStopPromise;
    bridgeStopPromise = (async () => {
      bridgeGeneration += 1;
      if (heartbeat) clearInterval(heartbeat);
      heartbeat = null;
      const activeDiscovery = bridgeDiscoveryRecord;
      bridgeDiscoveryRecord = null;
      if (activeDiscovery) removeDiscovery(activeDiscovery);
      const activeServer = server;
      server = null;
      if (activeServer) {
        await new Promise<void>((resolve) => {
          activeServer.close(() => resolve());
          activeServer.closeAllConnections?.();
          setTimeout(resolve, 250).unref?.();
        });
      }
      releaseSpareWorker();
      await Promise.allSettled(
        [...powerShellBySession.keys()]
          .filter((sessionId) => sessionId !== CHROME_SETUP_SESSION_ID)
          .map((sessionId) => abortComputerSession({
            action: 'session_abort',
            session_id: sessionId,
          })),
      );
      computerUseCoordinator.reset();
    })();
    try {
      await bridgeStopPromise;
    } finally {
      bridgeStopPromise = null;
      if (isBridgeWanted() && !isDisposed()) startBridge();
    }
  }

  function handleRequest(
    activeToken: string,
    generation: number,
  ): (request: IncomingMessage, response: ServerResponse) => void {
    return (request, response) => {
      void (async () => {
        if (request.method === 'GET' && request.url === '/health') {
          if (String(request.headers.authorization || '') !== `Bearer ${activeToken}`) {
            respond(response, 401, { ok: false, error: 'unauthorized' });
            return;
          }
          const identity = bridgeDiscoveryRecord;
          if (!identity
            || identity.token !== activeToken
            || identity.generation !== generation) {
            respond(response, 503, { ok: false, error: 'bridge generation is not active' });
            return;
          }
          respond(response, 200, {
            ok: true,
            identity: bridgeDiscoveryPublicIdentity(identity),
          });
          return;
        }
        if (request.method !== 'POST' || request.url !== '/command') {
          respond(response, 404, { ok: false, error: 'not found' });
          return;
        }
        if (String(request.headers.authorization || '') !== `Bearer ${activeToken}`) {
          respond(response, 401, { ok: false, error: 'unauthorized' });
          return;
        }
        let command: ComputerCommand;
        try {
          command = JSON.parse(await readRequestBody(request)) as ComputerCommand;
        } catch (error) {
          respond(response, 400, { ok: false, error: `invalid request: ${(error as Error).message}` });
          return;
        }
        // A dropped connection is the only cancellation signal left when the
        // runtime dies before it can send session_abort. Without this the queued
        // input keeps driving the user's desktop until the command timeout.
        let clientGone = false;
        const abortOnDisconnect = (): void => {
          if (clientGone) return;
          clientGone = true;
          if (isComputerLifecycleControl(command)) return;
          void abortComputerSession(command).catch(() => { /* host already idle */ });
        };
        request.once('aborted', abortOnDisconnect);
        response.once('close', () => {
          if (!response.writableEnded) abortOnDisconnect();
        });
        try {
          const value: ComputerCommandResult = command.action === 'session_abort'
            ? await abortComputerSession(command)
            : await executeSerialized(command);
          if (!clientGone) respond(response, 200, { ok: true, value });
        } catch (error) {
          if (!clientGone) {
            respond(response, 200, { ok: false, error: (error as Error).message || String(error) });
          }
        } finally {
          request.removeListener('aborted', abortOnDisconnect);
        }
      })().catch(() => {
        try { response.destroy(); } catch { /* already gone */ }
      });
    };
  }

  function startBridge(): void {
    if (isDisposed() || !isBridgeWanted() || server || bridgeStopPromise) return;
    const generation = ++bridgeGeneration;
    const activeToken = randomBytes(24).toString('base64url');
    const startedAt = Date.now();
    diagnose('computer-bridge-start', { generation });
    const created = createServer(handleRequest(activeToken, generation));
    server = created;
    const stillCurrent = (): boolean =>
      !isDisposed() && isBridgeWanted() && server === created && bridgeGeneration === generation;
    created.listen(0, '127.0.0.1', () => {
      const address = created.address();
      const port = address && typeof address === 'object' ? address.port : 0;
      if (!port) return;
      diagnose('computer-bridge-listening', {
        generation,
        durationMs: Date.now() - startedAt,
      });
      const discoveryRecord = createBridgeDiscoveryRecord({
        port,
        token: activeToken,
        generation,
        startedAt,
      });
      // Publish only after the native backend is warm. Disabling Computer Use
      // closes this listener and revokes its token without affecting Browser
      // Use's narrowly scoped internal UIA route.
      void callPowerShell({
        action: 'wait',
        duration: 0,
        session_id: HOST_WARMUP_SESSION_ID,
        read_only: true,
      }).then(async () => {
        if (!stillCurrent()) return;
        // The warm-up worker already paid startup, so it becomes the spare the
        // first real session adopts instead of being reaped and respawned.
        adoptWarmedWorker(HOST_WARMUP_SESSION_ID);
        bridgeDiscoveryRecord = discoveryRecord;
        try {
          const ownership = await writeDiscovery(discoveryRecord);
          if (ownership !== 'owned') {
            console.warn(`computer bridge discovery ${ownership}; heartbeat will retry`);
          }
          heartbeat = setInterval(
            () => {
              void heartbeatDiscovery(discoveryRecord).then((status) => {
                if (status !== 'lost'
                  || !stillCurrent()
                  || !sameBridgeDiscovery(bridgeDiscoveryRecord, discoveryRecord)) return;
                void stopBridge().catch((error) => {
                  console.error('computer bridge restart after endpoint loss failed:', error);
                });
              }).catch((error) => {
                console.error('computer bridge discovery heartbeat failed:', error);
              });
              reapIdleSessionWorkers();
            },
            HEARTBEAT_MS,
          );
          heartbeat.unref?.();
          diagnose('computer-bridge-ready', {
            generation,
            durationMs: Date.now() - startedAt,
            ownership,
          });
        } catch (error) {
          console.error('computer bridge discovery write failed:', error);
          diagnose('computer-bridge-failed', {
            generation,
            durationMs: Date.now() - startedAt,
            phase: 'discovery',
            errorName: error instanceof Error ? error.name : typeof error,
          });
        }
      }).catch((error) => {
        if (!stillCurrent()) return;
        console.error('computer resident backend warm-up failed:', error);
        diagnose('computer-bridge-failed', {
          generation,
          durationMs: Date.now() - startedAt,
          phase: 'backend-warmup',
          errorName: error instanceof Error ? error.name : typeof error,
        });
      });
    });
  }

  return { startBridge, stopBridge };
}

export type BridgeServer = ReturnType<typeof createBridgeServer>;
