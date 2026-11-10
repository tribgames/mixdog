// The phone's native push registration (audit PH-2 "Notifications": `registerNativePush`, `removeNativePush`), a notification's
// Allow / Deny (`answerApprovalNotification`) and the desktop notices it is shown, over the protocol.
//
// Registration: Node bound `{platform, token, publicKey, sandbox}` to the paired client behind the connection and answered `true`
// (remote-push-methods.ts:45-63); the core does the same under `remoteAccess/registerNativePush` / `remoteAccess/removeNativePush`,
// with Node's sentences.
//
// Notices: Node sent a phone a raised notice once, as it was raised, and only to the phones connected then; a phone that connected later
// was sent none of the notices standing (remote-relay-push-lanes.ts:50-62, :178; desktop-service.ts:744-750). The core keeps a raised
// notice as an entry of the `notice` section until it is cleared, so a window that attaches later still shows it; on the phone only an
// entry the connected client hears added is a notice raised now. What a connection's snapshot holds is not shown, and the page's section
// store does not carry the section (phone-sections.ts).
import type { ProtocolClient, SessionFold } from '../../../../packages/protocol-client/src/index.ts';
import { readDesktopNotice } from '../shared/desktop-notice';
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
    // A snapshot announces what stands (`store.owed` is set while it does): those were raised before this connection.
    if (change.type !== 'section' || change.section !== 'notice' || client.store.owed) return;
    const notice = readDesktopNotice(client.store.section('notice', change.key)?.value);
    if (notice) host.ctx.fanOut(host.ctx.desktopNoticeListeners, notice);
  });
}

export const adapter: PhoneProtocolAdapter = {
  group: 'notifications',
  calls: {
    registerNativePush: ([input], host) => rpc(host, 'remoteAccess/registerNativePush', { input: input ?? null }),
    // A notification's Allow / Deny (native-push-bridge.ts `answerApproval`). Which Allow is taken, and with which decision, is the
    // core's rule (`thread/approval/answerNotification`, remote-session-methods.ts:200-215), never the phone's.
    answerApprovalNotification: async ([sessionId, approvalId, action], host) =>
      ((await rpc(host, 'thread/approval/answerNotification', { threadId: sessionId, approvalId, action })) as { outcome: string }).outcome,
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
