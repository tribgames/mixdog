#!/usr/bin/env node
// Node half of the WebSocket twin comparison (tests/ws.rs): a `ws` WebSocketServer in noServer mode with the options
// apps/relay/server.mjs gives its own (maxPayload, perMessageDeflate: false, no subprotocols), behind a node:http server
// that hands every upgrade to handleUpgrade, as the relay does.
//
// Invocation:  node node-ws-echo.mjs '<json>'      json: { "maxPayload": bytes, "closeTimeout": milliseconds }
//
// stdout, one JSON object per line: {"listening": port} first, then one line per event of every socket, in the order the
// events happened:
//   {"ev":"message","binary":bool,"hex":"..."}   {"ev":"ping","hex":"..."}   {"ev":"pong","hex":"..."}
//   {"ev":"error","code":"WS_ERR_...","message":"..."}   {"ev":"close","code":n,"hex":"reason bytes"}
//
// Every message is echoed with its own type, except a text message that starts with "cmd:", which the server obeys:
//   cmd:close:<code>   ws.close(code, 'bye')        cmd:terminate   ws.terminate()        cmd:ping   ws.ping()
//
// The twin harness runs the same script against this file and against the Rust server and compares what the peer
// received and the events.

import http from 'node:http';
import { WebSocketServer } from 'ws';

const options = JSON.parse(process.argv[2] || '{}');
const serverOptions = {
  noServer: true,
  maxPayload: options.maxPayload ?? 64 * 1024 * 1024 + 4 * 1024 * 1024,
  perMessageDeflate: false,
};
if (options.closeTimeout !== undefined) serverOptions.closeTimeout = options.closeTimeout;
const wss = new WebSocketServer(serverOptions);

function emit(record) {
  process.stdout.write(`${JSON.stringify(record)}\n`);
}

const server = http.createServer();
server.on('upgrade', (request, socket, head) => {
  wss.handleUpgrade(request, socket, head, (ws) => {
    ws.on('message', (data, isBinary) => {
      emit({ ev: 'message', binary: isBinary, hex: data.toString('hex') });
      const text = isBinary ? '' : data.toString('utf8');
      if (text.startsWith('cmd:close:')) {
        ws.close(Number(text.slice('cmd:close:'.length)), 'bye');
      } else if (text === 'cmd:terminate') {
        ws.terminate();
      } else if (text === 'cmd:ping') {
        ws.ping();
      } else {
        ws.send(data, { binary: isBinary });
      }
    });
    ws.on('ping', (data) => emit({ ev: 'ping', hex: data.toString('hex') }));
    ws.on('pong', (data) => emit({ ev: 'pong', hex: data.toString('hex') }));
    ws.on('error', (error) => emit({ ev: 'error', code: error.code, message: error.message }));
    ws.on('close', (code, reason) => emit({ ev: 'close', code, hex: reason.toString('hex') }));
  });
});
server.listen(0, '127.0.0.1', () => emit({ listening: server.address().port }));
