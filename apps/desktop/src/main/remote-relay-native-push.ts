// Native app push (APNs/FCM) over the relay leg: the relay only sends to tokens
// this desktop bound to a paired client, so stored tokens are bound whenever
// the relay can deliver, unbound when removed, and dropped when the platform
// says they are dead.
import type { NativePushStore, NativePushSubscription } from './native-push-store';
import type { NativePushMessage } from './push-notifier';

export interface RelayNativePushDeps {
  store: NativePushStore;
  /** Platforms the relay can deliver to on the current connection. */
  platforms(): readonly string[];
  sendEnvelope(payload: unknown): boolean;
  connected(): boolean;
}

export interface RelayNativePush {
  /** A message to one token, when the relay can deliver it right now. */
  send(message: NativePushMessage): boolean;
  /** The relay's verdict on one send (`native-push-result`). */
  handleResult(envelope: Record<string, unknown>): void;
  /** The relay can deliver again: bind every stored token. */
  rebindAll(): void;
  register(input: Parameters<NativePushStore['register']>[0]): Promise<NativePushSubscription>;
  remove(clientId: string, tokenFilter?: string): Promise<boolean>;
}

export function createRelayNativePush(deps: RelayNativePushDeps): RelayNativePush {
  // The relay only sends to tokens this desktop bound to a paired client, so a
  // bind precedes the first send on every connection.
  const bind = (row: NativePushSubscription): void => {
    if (!deps.platforms().includes(row.platform)) return;
    deps.sendEnvelope({ type: 'native-push-bind', clientId: row.clientId, platform: row.platform, token: row.token });
  };
  return {
    send: (message) => {
      if (!deps.platforms().includes(message.platform)) return false;
      if (!deps.connected()) return false;
      deps.sendEnvelope({ type: 'native-push', ...message });
      return true;
    },
    handleResult: (envelope) => {
      // The platform said the token is dead (APNs 410 / FCM UNREGISTERED).
      if (envelope.invalid === true && typeof envelope.token === 'string') {
        void deps.store.removeToken(envelope.token).catch(() => false);
      }
    },
    rebindAll: () => {
      void deps.store
        .list()
        .then((rows) => rows.forEach(bind))
        .catch(() => undefined);
    },
    register: async (input) => {
      const entry = await deps.store.register(input);
      bind(entry);
      return entry;
    },
    remove: async (clientId, tokenFilter) => {
      const rows = (await deps.store.list()).filter(
        (row) => row.clientId === clientId && (!tokenFilter || row.token === tokenFilter)
      );
      const removed = await deps.store.remove(clientId, tokenFilter);
      for (const row of rows)
        deps.sendEnvelope({ type: 'native-push-unbind', token: row.token, clientId: row.clientId });
      return removed;
    },
  };
}
