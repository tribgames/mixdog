// Wires desktop session state and roster subscriptions to the relay. Recovery
// stays beside those subscriptions so a replacement client cannot receive a
// late read from the previous relay leg.
import { createPushNotifier, type NativePushMessage } from './push-notifier';
import type { NativePushStore } from './native-push-store';
import type { PushSubscriptionStore } from './push-subscription-store';
import type { DesktopService } from './desktop-service-contract';
import type { RelayCatalogs } from './remote-relay-catalog';
import type { RelayClientState, RelayClientRegistry, SendEncryptedFrame } from './remote-relay-clients';
import { createRelayPushLanes } from './remote-relay-push-lanes';
import type { RelaySessionStateFanout } from './remote-relay-session-state';
import { synchronizeRelayViews } from './remote-view-sync';

export interface RelaySessionWiringDeps {
  host: DesktopService;
  clients: RelayClientRegistry;
  catalogs: RelayCatalogs;
  sessionStates: RelaySessionStateFanout;
  pushStore: PushSubscriptionStore;
  nativePush?: {
    store: NativePushStore;
    send(message: NativePushMessage): boolean;
  };
  live(clientId: string, state: RelayClientState): boolean;
  closed(): boolean;
  sendEncryptedFrame: SendEncryptedFrame;
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
        readFinalAnswer: (sessionId, startedAt) => deps.host.readSessionFinalAnswer(sessionId, startedAt),
        // Connected is not enough: a phone that just left the app keeps its
        // socket through a background grace and reports itself hidden.
        // The subscription names the BROWSER; relay legs carry a per-connection
        // id, so the leg is found by the browser id it reported.
        isClientForeground: (browserId) => {
          for (const client of deps.clients.clients.values()) {
            if (client.browserId === browserId && !client.background) return true;
          }
          return false;
        },
        ...(deps.nativePush
          ? {
              native: {
                list: () => deps.nativePush!.store.list(),
                // A native client is a paired credential; any live leg of it
                // that has not gone to the background is watching.
                isClientForeground: (clientId: string) => {
                  for (const client of deps.clients.clients.values()) {
                    if (client.credentialId === clientId && !client.background) return true;
                  }
                  return false;
                },
                send: (message: NativePushMessage) => deps.nativePush!.send(message),
                removeByClient: (clientId: string) => deps.nativePush!.store.removeByClient(clientId),
              },
            }
          : {}),
        onError: (detail) => console.error(`[mixdog-remote-push] ${detail}`),
        onDiagnostic: (event, details) =>
          console.info(
            `[mixdog-remote-push] ${event}` +
              Object.entries(details)
                .map(([key, value]) => ` ${key}=${String(value)}`)
                .join('')
          ),
      });
      const unsubscribeState = deps.host.subscribe((snapshot) => broadcastState(snapshot));
      const unsubscribeSessions = deps.host.subscribeSessions((sessions) => {
        deps.catalogs.publishSessions(sessions);
        pushNotifier.onSessions(sessions);
      });
      const unsubscribeAgentPool = deps.host.subscribeAgentPool((agents) => {
        deps.catalogs.publishAgentPool(agents);
        pushNotifier.onAgentPool(agents);
      });
      const unsubscribeSessionStates = deps.host.subscribeSessionStates((update) => {
        pushNotifier.onSessionState(update);
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
