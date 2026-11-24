import type { ProtocolClient, SessionFold } from '../../../../packages/protocol-client/src/index.ts';
import { readDesktopNotice } from '../shared/desktop-notice';
import { requiredString } from '../shared/remote-arguments';
import { failure } from './remote-protocol-files';
import type { PhoneProtocolAdapter, PhoneProtocolHost } from './remote-shim-protocol';

type Client = ProtocolClient<SessionFold>;

const rpc = async (host: PhoneProtocolHost, method: string, params: Record<string, unknown>): Promise<unknown> => {
  try {
    return await (host.client().call as (m: string, p: unknown) => Promise<unknown>)(method, params);
  } catch (error) {
    throw failure(error);
  }
};

/** Shows the page each notice the connected client hears raised. */
function followNotices(host: PhoneProtocolHost, client: Client): () => void {
  return client.store.subscribe((change) => {
    // A snapshot announces what stands, a resumed subscription replays what changed while the connection was away: neither was raised
    // while this phone was connected.
    if (change.type !== 'section' || change.section !== 'notice' || !client.store.appLive()) return;
    const notice = readDesktopNotice(client.store.section('notice', change.key)?.value);
    if (notice) host.ctx.fanOut(host.ctx.desktopNoticeListeners, notice);
  });
}

export const adapter: PhoneProtocolAdapter = {
  group: 'notifications',
  calls: {
    // The PC-signed Web Push fallback (remote-push-methods.ts at 0bf8fe0457): the core mints the key, this browser subscribes with it and
    // hands its endpoint back over the encrypted channel. The core's `remoteAccess` methods hold Node's argument checks and sentences.
    pushPublicKey: (_params, host) => rpc(host, 'remoteAccess/pushPublicKey', {}),
    registerPushSubscription: ([input], host) =>
      rpc(host, 'remoteAccess/registerPushSubscription', { input: input ?? null }),
    removePushSubscription: ([endpoint], host) =>
      rpc(host, 'remoteAccess/removePushSubscription', { endpoint: requiredString(endpoint, 'endpoint') }),
    registerNativePush: ([input], host) => rpc(host, 'remoteAccess/registerNativePush', { input: input ?? null }),
    // remote-shim-pairing.ts `deliverControllerKey`: the core binds the key to the credential of this connection.
    deliverScreenControllerKey: ([publicKey], host) =>
      rpc(host, 'remoteAccess/deliverScreenControllerKey', { input: publicKey ?? null }),
    // A notification's Allow / Deny (native-push-bridge.ts `answerApproval`). Which Allow is taken, and with which decision, is the
    // core's rule (`thread/approval/answerNotification`, remote-session-methods.ts:200-215), never the phone's.
    answerApprovalNotification: async ([sessionId, approvalId, action], host) =>
      (
        (await rpc(host, 'thread/approval/answerNotification', { threadId: sessionId, approvalId, action })) as {
          outcome: string;
        }
      ).outcome,
    removeNativePush: ([token], host) => {
      // remote-push-methods.ts:59
      if (token !== undefined && typeof token !== 'string') throw new Error('token must be a string.');
      return rpc(host, 'remoteAccess/removeNativePush', token === undefined ? {} : { token });
    },
  },
  install(host) {
    let off: (() => void) | undefined;
    const stop = host.onClient?.((client) => {
      off?.();
      off = followNotices(host, client);
    });
    return () => {
      stop?.();
      off?.();
    };
  },
};
