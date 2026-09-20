/** Publishes a listening bridge through the heartbeated discovery file, and
 *  restarts the bridge when a heartbeat reports the endpoint lost. */
import type { createBridgeDiscovery } from '../../bridge/discovery-file';
import { createBridgeDiscoveryRecord, sameBridgeDiscovery } from '../../bridge/discovery-ownership';
import type { BridgeServerHost, BridgeServerState } from './bridge-server-contract';

const HEARTBEAT_MS = 60_000;

type Discovery = ReturnType<typeof createBridgeDiscovery>;

export interface BridgeDiscoveryPublisher
  extends Pick<Discovery, 'writeDiscovery' | 'heartbeatDiscovery'>,
    Pick<BridgeServerHost, 'reapIdleSessionWorkers' | 'diagnose'> {
  state: BridgeServerState;
  /** Stops the bridge; the stop path restarts it while the bridge is still wanted. */
  restart(): Promise<void>;
}

export interface BridgeEndpoint {
  port: number;
  token: string;
  generation: number;
  startedAt: number;
  /** Whether this generation's server is still the live one. */
  stillCurrent(): boolean;
}

export function publishBridgeDiscovery(publisher: BridgeDiscoveryPublisher, endpoint: BridgeEndpoint): void {
  const { state, writeDiscovery, heartbeatDiscovery, reapIdleSessionWorkers, diagnose, restart } = publisher;
  const { generation, startedAt, stillCurrent } = endpoint;
  const discoveryRecord = createBridgeDiscoveryRecord({
    port: endpoint.port,
    token: endpoint.token,
    generation,
    startedAt,
  });
  // Discovery describes the authenticated bridge, not a pre-spawned worker.
  // The first command still passes through the normal admission and safety gates.
  state.discoveryRecord = discoveryRecord;
  const current = (): boolean => stillCurrent() && sameBridgeDiscovery(state.discoveryRecord, discoveryRecord);

  function beat(): void {
    if (!stillCurrent()) return;
    void heartbeatDiscovery(discoveryRecord)
      .then((status) => {
        if (status !== 'lost' || !current()) return;
        void restart().catch((error) => {
          console.error('computer bridge restart after endpoint loss failed:', error);
        });
      })
      .catch((error) => {
        console.error('computer bridge discovery heartbeat failed:', error);
      });
    reapIdleSessionWorkers();
  }

  void writeDiscovery(discoveryRecord)
    .then((ownership) => {
      if (!current()) return;
      if (ownership !== 'owned') {
        console.warn(`computer bridge discovery ${ownership}; heartbeat will retry`);
      }
      state.heartbeat = setInterval(beat, HEARTBEAT_MS);
      state.heartbeat.unref?.();
      diagnose('computer-bridge-ready', {
        generation,
        durationMs: Date.now() - startedAt,
        ownership,
      });
    })
    .catch((error) => {
      if (!stillCurrent()) return;
      console.error('computer bridge discovery write failed:', error);
      diagnose('computer-bridge-failed', {
        generation,
        durationMs: Date.now() - startedAt,
        phase: 'discovery',
        errorName: error instanceof Error ? error.name : typeof error,
      });
    });
}
