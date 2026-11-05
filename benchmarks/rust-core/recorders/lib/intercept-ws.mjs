// `ws` stand-in: same API, but every client socket connects to the local hub.
// The original URL and the handshake headers the adapter built reach the hub.
import * as real from 'ws';

const Real = real.WebSocket;

export class WebSocket extends Real {
  constructor(address, protocols, options) {
    const hub = globalThis.__benchHub;
    if (!hub?.wsPort) return super(address, protocols, options);
    if (protocols && !Array.isArray(protocols) && typeof protocols === 'object') {
      options = protocols;
      protocols = undefined;
    }
    const url = new URL(String(address));
    const { createConnection, agent, servername, ...rest } = options ?? {};
    const headers = { ...(rest.headers ?? {}), 'x-bench-origin': url.origin };
    super(`ws://127.0.0.1:${hub.wsPort}${url.pathname}${url.search}`, protocols, { ...rest, headers });
  }
}

export const WebSocketServer = real.WebSocketServer;
export const Receiver = real.Receiver;
export const Sender = real.Sender;
export const createWebSocketStream = real.createWebSocketStream;
export default WebSocket;
