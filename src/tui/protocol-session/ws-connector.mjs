// The protocol-client `Connector` over a loopback WebSocket (protocol spec §4.1): `ws://127.0.0.1:<port>/rpc`,
// `Authorization: Bearer <discovery token>` on the upgrade, no `Origin`. Discovery is read on every open because
// the token and the port change with every core.
import WebSocket from 'ws';
import { readCoreDiscovery, rpcEndpoint } from './discovery.mjs';

const CLOSE_INVALID_PAYLOAD = 1007;

export function createWebSocketConnector({ readDiscovery = readCoreDiscovery, WebSocketImpl = WebSocket } = {}) {
  return {
    async open(_target, sink) {
      const { port, token } = rpcEndpoint(await readDiscovery());
      const socket = new WebSocketImpl(`ws://127.0.0.1:${port}/rpc`, {
        headers: { Authorization: `Bearer ${token}` },
        perMessageDeflate: false,
      });
      const writer = {
        send: (text) => socket.send(text),
        close: (code, reason) => socket.close(code, reason),
      };
      return new Promise((resolve, reject) => {
        let opened = false;
        socket.on('open', () => {
          opened = true;
          resolve(writer);
        });
        socket.on('message', (data, isBinary) => {
          if (isBinary) socket.close(CLOSE_INVALID_PAYLOAD, 'binary frame');
          else sink.frame(data.toString('utf8'));
        });
        socket.on('close', (code, reason) => {
          if (opened) sink.closed(code, reason.toString('utf8'));
        });
        // A failure after the upgrade is followed by 'close', which is the only reconnect trigger.
        socket.on('error', (error) => {
          if (!opened) reject(error);
        });
        socket.on('unexpected-response', (_request, response) => {
          reject(new Error(`core refused the connection (HTTP ${response.statusCode})`));
          socket.terminate();
        });
      });
    },
  };
}
