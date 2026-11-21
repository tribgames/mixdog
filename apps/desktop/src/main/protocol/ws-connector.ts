// The client library's `Connector` over a WebSocket opened from Node (protocol.md §4.1: headers, no Origin, loopback
// only). Credentials are re-resolved on every open, so a core restarted with a new discovery token is reached by the
// ladder without the connection being rebuilt.
import WebSocket from 'ws';
import type { SentClaim, TransportSink, TransportWriter } from '../../../../../packages/protocol-client/src/api';
import { observeSocketProgress } from './socket-progress';

export interface WsEndpoint {
  /** `ws://127.0.0.1:<port>/rpc` of the core, or of an SSH tunnel to a server's core. */
  readonly url: string;
  /** The discovery token; sent as `Authorization: Bearer`. */
  readonly token: string;
}

export interface WsTarget {
  readonly id: string;
}

/** Large enough for a full app snapshot (`maxSnapshotBytes`); the core's own caps are the real limit. */
const MAX_INBOUND_BYTES = 16 * 1024 * 1024;

/** `log` is the desktop diagnostics sink: one line per socket opened, failed to open and closed (no frames, no token). */
export function createWsConnector(
  resolve: (target: WsTarget) => Promise<WsEndpoint>,
  /** Already the owner's log (`createLinkLog`): it cannot throw into the socket and carries the owner identity. */
  log: (event: string, fields?: Record<string, unknown>) => void = () => {}
) {
  let dials = 0;
  return {
    async open(target: WsTarget, sink: TransportSink): Promise<TransportWriter> {
      const dial = ++dials;
      const endpoint = await resolve(target);
      const socket = new WebSocket(endpoint.url, {
        headers: { Authorization: `Bearer ${endpoint.token}` },
        maxPayload: MAX_INBOUND_BYTES,
        perMessageDeflate: false,
      });
      try {
        await new Promise<void>((resolveOpen, rejectOpen) => {
          socket.once('open', () => resolveOpen());
          socket.once('error', rejectOpen);
          socket.once('unexpected-response', (_request, response) =>
            rejectOpen(new Error(`The core refused the connection (HTTP ${response.statusCode}).`))
          );
        });
      } catch (error) {
        log('core-socket-open-failed', {
          dial,
          message: (error instanceof Error ? error.message : String(error)).slice(0, 200),
        });
        throw error;
      }
      const openedAt = Date.now();
      log('core-socket-open', { dial });
      // Bytes of a message still arriving are the core's progress (a socket delivers a message only when it is whole).
      observeSocketProgress(socket, () => {
        if (!ended) sink.progress?.();
      });
      socket.on('message', (data, isBinary) => {
        if (isBinary) return;
        sink.frame(data.toString('utf8'));
      });
      // The one close line of this socket: who asked for it (this side's `close`) or that the peer or the network ended it.
      let ended = false;
      let requested = false;
      let socketError = '';
      socket.on('close', (code, reason) => {
        if (ended) return;
        ended = true;
        log('core-socket-close', {
          dial,
          code,
          reason: reason.toString('utf8').slice(0, 200),
          openMs: Date.now() - openedAt,
          initiator: requested ? 'desktop' : 'core-or-network',
          ...(socketError ? { error: socketError } : {}),
        });
        // Why the link went is known here and nowhere after: every request it carried only says `connectionLost`.
        console.error(
          `[mixdog] core socket closed code=${code} reason=${JSON.stringify(reason.toString('utf8').slice(0, 300))}`
        );
        sink.closed(code, reason.toString('utf8'));
      });
      // An error always precedes a close event that carries the code; the library reconnects on `closed` only.
      socket.on('error', (error) => {
        socketError = (error instanceof Error ? error.message : String(error)).slice(0, 200);
      });
      return {
        // The departure receipt is the `ws` send callback: the write of this frame completed locally. A failed write, or a socket that
        // closed first, rejects it; it never resolves for a frame that did not leave.
        send: (text, sent?: SentClaim) => {
          if (!sent) return socket.send(text);
          sent(
            new Promise<void>((resolveSent, rejectSent) => {
              socket.send(text, (error) => (error ? rejectSent(error) : resolveSent()));
            })
          );
        },
        // The media lane (protocol.md X17): a frame the paired device's stream receives as a binary message.
        sendBinary: (data) => socket.send(data, { binary: true }),
        close: (code, reason) => {
          requested = true;
          socket.close(code, reason);
        },
      };
    },
  };
}
