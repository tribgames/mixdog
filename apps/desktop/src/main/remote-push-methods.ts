// Web Push and native push registration for one remote connection.
import { requiredString } from './ipc-validation';
import type { RemoteMethod, RemoteMethodClient, RemoteMethodDependencies } from './remote-methods';

export function pushRemoteMethods(
  push: RemoteMethodDependencies['push'],
  nativePush: RemoteMethodDependencies['nativePush'],
  client: RemoteMethodClient | undefined
): Record<string, RemoteMethod> {
  const requiredNativePush = (): NonNullable<RemoteMethodDependencies['nativePush']> => {
    if (!nativePush || nativePush.platforms().length === 0) {
      throw new TypeError('Native push is unavailable on this connection.');
    }
    return nativePush;
  };
  const connectionClientId = (): string => {
    const id = client?.credentialId?.() ?? '';
    if (!id) throw new TypeError('Native push needs a paired client.');
    return id;
  };
  const requiredPush = (): NonNullable<RemoteMethodDependencies['push']> => {
    if (!push) throw new TypeError('Push notifications are unavailable on this connection.');
    return push;
  };
  return {
    // Web Push. The browser subscribes with the key this returns and hands the
    // resulting endpoint back over the SAME encrypted channel, so the relay
    // never sees which device wants notifications.
    pushPublicKey: () => requiredPush().publicKey(),
    registerPushSubscription: async ([input]) => {
      const record = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
      await requiredPush().register({
        endpoint: requiredString(record.endpoint, 'endpoint'),
        p256dh: requiredString(record.p256dh, 'p256dh'),
        auth: requiredString(record.auth, 'auth'),
        ...(typeof record.clientId === 'string' ? { clientId: record.clientId } : {}),
        ...(typeof record.label === 'string' ? { label: record.label } : {}),
      });
      return true;
    },
    removePushSubscription: ([endpoint]) => requiredPush().remove(requiredString(endpoint, 'endpoint')),
    // Native app push. `{ platform, token, publicKey }` arrives over the
    // encrypted channel and is bound to the paired client behind it; the
    // content of every later push is encrypted for `publicKey`.
    registerNativePush: async ([input]) => {
      const native = requiredNativePush();
      const record = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
      if (typeof record.platform !== 'string' || !native.platforms().includes(record.platform)) {
        throw new TypeError('Native push is unavailable for this platform.');
      }
      await native.register({
        clientId: connectionClientId(),
        platform: record.platform,
        token: record.token,
        publicKey: record.publicKey,
        sandbox: record.sandbox,
      });
      return true;
    },
    removeNativePush: ([token]) => {
      if (token !== undefined && typeof token !== 'string') throw new TypeError('token must be a string.');
      return requiredNativePush().remove(connectionClientId(), token);
    },
  };
}
