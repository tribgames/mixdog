// The client library's `Connector` over a WebSocket opened from Node (protocol.md §4.1: headers, no Origin, loopback
// only). Credentials are re-resolved on every open, so a core restarted with a new discovery token is reached by the
// ladder without the connection being rebuilt.
import WebSocket from 'ws';

export interface WsEndpoint {
  /** `ws://127.0.0.1:<port>/rpc` of the core, or of an SSH tunnel to a server's core. */
  readonly url: string;
  /** The discovery token; sent as `Authorization: Bearer`. */
  readonly token: string;
}

export interface WsTarget {
  readonly id: string;
}

interface Sink {
  frame(text: string): void;
  closed(code: number, reason: string): void;
}

interface Writer {
  send(text: string): void;
  close(code: number, reason: string): void;
}

/** Large enough for a full app snapshot (`maxSnapshotBytes`); the core's own caps are the real limit. */
const MAX_INBOUND_BYTES = 16 * 1024 * 1024;

export function createWsConnector(resolve: (target: WsTarget) => Promise<WsEndpoint>) {
  return {
    async open(target: WsTarget, sink: Sink): Promise<Writer> {
      const endpoint = await resolve(target);
      const socket = new WebSocket(endpoint.url, {
        headers: { Authorization: `Bearer ${endpoint.token}` },
        maxPayload: MAX_INBOUND_BYTES,
        perMessageDeflate: false,
      });
      await new Promise<void>((resolveOpen, rejectOpen) => {
        socket.once('open', () => resolveOpen());
        socket.once('error', rejectOpen);
        socket.once('unexpected-response', (_request, response) =>
          rejectOpen(new Error(`The core refused the connection (HTTP ${response.statusCode}).`))
        );
      });
      socket.on('message', (data, isBinary) => {
        if (isBinary) return;
        sink.frame(data.toString('utf8'));
      });
      let ended = false;
      socket.on('close', (code, reason) => {
        if (ended) return;
        ended = true;
        sink.closed(code, reason.toString('utf8'));
      });
      // An error always precedes a close event that carries the code; the library reconnects on `closed` only.
      socket.on('error', () => {});
      return {
        send: (text) => socket.send(text),
        close: (code, reason) => socket.close(code, reason),
      };
    },
  };
}
