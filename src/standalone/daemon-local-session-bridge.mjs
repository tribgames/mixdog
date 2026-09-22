// In-process session views (the desktop main process hosted by this daemon)
// reach the session service without a socket. attach() hands back the same
// session-protocol client a remote view gets; publish() fans a frame out to the
// attached callbacks; close() fails every attached view at shutdown.
//
// Client tokens are what the session service refcounts views with, so each
// attach owns exactly one token and releases it on close — a terminal exiting
// cannot destroy a session a desktop window is still streaming.
//
// Inputs: `getSessionService` (the service is wired after this bridge exists),
// `log`, `pid` (token namespace). Output: { attach, publish, close }.
import { createSessionProtocolClient } from './session-protocol.mjs';

export function createLocalSessionBridge({ getSessionService, log, pid = process.pid }) {
  const clients = new Map();
  let nextClient = 0;
  return {
    attach({ onFrame = () => {}, onFatal = () => {} } = {}) {
      const clientToken = `daemon_local_${pid}_${++nextClient}`;
      let closed = false;
      clients.set(clientToken, { onFrame, onFatal });
      return createSessionProtocolClient({
        call(name, args = {}, options = {}) {
          if (closed) throw new Error('daemon-local session client is closed');
          return getSessionService().handleCall(name, args, {
            clientToken,
            ...(options?.callId ? { callId: String(options.callId) } : {}),
          });
        },
        async close(reason = 'local session view closed') {
          if (closed) return;
          closed = true;
          clients.delete(clientToken);
          try {
            getSessionService().releaseClient(clientToken);
          } catch {}
          log(`${reason} (${clientToken})`);
        },
      });
    },
    publish(frame, targetTokens = null) {
      const targets = targetTokens ? new Set(targetTokens) : null;
      for (const [clientToken, client] of clients) {
        if (targets && !targets.has(clientToken)) continue;
        try {
          client.onFrame(frame);
        } catch {}
      }
    },
    async close(reason = 'daemon shutdown') {
      for (const [clientToken, client] of clients) {
        try {
          client.onFatal(reason);
        } catch {}
        try {
          getSessionService().releaseClient(clientToken);
        } catch {}
      }
      clients.clear();
    },
  };
}
