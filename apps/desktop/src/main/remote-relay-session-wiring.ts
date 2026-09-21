// Wires desktop session state and roster subscriptions to the relay. Recovery
// stays beside those subscriptions so a replacement client cannot receive a
// late read from the previous relay leg.
import { createPushNotifier } from './push-notifier';
import type { PushSubscriptionStore } from './push-subscription-store';
import type { DesktopService } from './desktop-service-contract';
import type { RelayCatalogs } from './remote-relay-catalog';
import type { RelayClientState, RelayClientRegistry } from './remote-relay-clients';
import { createRelayPushLanes } from './remote-relay-push-lanes';
import type { RelaySessionStateFanout } from './remote-relay-session-state';
import { synchronizeRelayViews } from './remote-view-sync';

export interface RelaySessionWiringDeps {
  host: DesktopService;
  clients: RelayClientRegistry;
  catalogs: RelayCatalogs;
  sessionStates: RelaySessionStateFanout;
  pushStore: PushSubscriptionStore;
  live(clientId: string, state: RelayClientState): boolean;
  closed(): boolean;
  sendEncryptedFrame(
    clientId: string,
    payload: unknown,
    droppable?: boolean,
    onSent?: (bytes: number) => void,
    requireDelivery?: boolean
  ): Promise<void>;
  broadcastEncrypted(payload: unknown, droppable: boolean, include?: (state: RelayClientState) => boolean): void;
  subscribeTerminalData?: (listener: (event: { id: string; data: string }) => void) => () => void;
}

export interface RelaySessionSubscriptions {
  forgetClient(clientId: string): void;
  dispose(): void;
}

export interface RelaySessionWiring {
  resyncClient(clientId: string, state: RelayClientState): void;
  broadcastState(snapshot: unknown): void;
  start(): RelaySessionSubscriptions;
}

export function createRelaySessionWiring(deps: RelaySessionWiringDeps): RelaySessionWiring {
  const resyncClient = (clientId: string, state: RelayClientState): void => {
    if (deps.host.replaySessionStates) {
      if (state.viewRecovery) return;
      const recovery = synchronizeRelayViews(
        deps.host,
        state,
        () => deps.live(clientId, state),
        (frame) => deps.sendEncryptedFrame(clientId, frame, false, undefined, true)
      );
      state.viewRecovery = recovery;
      void recovery
        .catch((error) => {
          console.error('[mixdog-remote] view recovery failed', error);
          if (deps.clients.attached(clientId, state)) deps.clients.close(clientId, 'view recovery failed');
        })
        .finally(() => {
          if (state.viewRecovery === recovery) state.viewRecovery = undefined;
        });
      return;
    }
    state.sessionStateEncoders.clear();
    state.stateLane?.reset(deps.host.getSnapshot());
    deps.catalogs.sendClientLists(clientId, state);
  };
  const broadcastState = (snapshot: unknown): void => {
    for (const state of deps.clients.clients.values()) {
      if (!state.syncing) state.stateLane?.publish(snapshot);
    }
  };

  return {
    resyncClient,
    broadcastState,
    start: () => {
      const pushNotifier = createPushNotifier({
        store: deps.pushStore,
        isEnabled: () => !deps.closed(),
        isClientConnected: (clientId) => deps.clients.get(clientId) !== undefined,
        onError: (detail) => console.error(`[mixdog-remote-push] ${detail}`),
      });
      const unsubscribeState = deps.host.subscribe((snapshot) => broadcastState(snapshot));
      const unsubscribeSessions = deps.host.subscribeSessions((sessions) => {
        deps.catalogs.publishSessions(sessions);
        pushNotifier.onSessions(sessions);
      });
      const unsubscribeAgentPool = deps.host.subscribeAgentPool((agents) => deps.catalogs.publishAgentPool(agents));
      const unsubscribeSessionStates = deps.host.subscribeSessionStates((update) => {
        if (deps.clients.size === 0) return;
        deps.sessionStates.publish(update);
      });
      const pushLanes = createRelayPushLanes({
        clients: deps.clients.clients,
        broadcastEncrypted: deps.broadcastEncrypted,
        subscribeTerminalData: deps.subscribeTerminalData,
        subscribeDesktopEvents: deps.host.subscribeDesktopEvents?.bind(deps.host),
      });
      return {
        forgetClient: (clientId: string): void => {
          pushNotifier.forgetClient(clientId);
        },
        dispose: (): void => {
          unsubscribeState();
          unsubscribeSessions();
          pushNotifier.dispose();
          unsubscribeAgentPool();
          unsubscribeSessionStates();
          pushLanes.dispose();
        },
      };
    },
  };
}
