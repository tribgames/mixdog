// The first flight (the ClientHello) Node's clients put on a TLS connection, taken as raw bytes at a plain TCP listener:
// undici's connector as `http-agent.mjs:432` builds it (`buildConnector({})`) for HTTPS, and `ws` for WSS. Written as JSON
// next to the Rust capture (`mixdog-ai/tests/it/tls_hello.rs`, MIXDOG_TLS_HELLO_OUT), for `tls-hello-report.mjs`.
// Usage: node tls-hello-capture.mjs <node-tree> --node-commit <sha> --out <file>
import { createRequire } from 'node:module';
import { writeFileSync } from 'node:fs';
import net from 'node:net';
import { resolve } from 'node:path';

const tree = resolve(process.argv[2]);
const arg = (name) => process.argv[process.argv.indexOf(name) + 1];
const require = createRequire(`${tree}/package.json`);
const undici = require('undici');
const WebSocket = require('ws');
/** The longest a first flight may take to arrive at the listener. */
const FLIGHT_DEADLINE_MS = 10_000;

const listener = net.createServer();
await new Promise((resolveListen) => listener.listen(0, '127.0.0.1', resolveListen));
const port = listener.address().port;
/** The first TLS record of the next connection: its 5-byte header, then the length it names. */
const nextFlight = () => new Promise((resolveFlight, reject) => {
  const timer = setTimeout(() => reject(new Error(`no first flight within ${FLIGHT_DEADLINE_MS} ms`)), FLIGHT_DEADLINE_MS);
  listener.once('connection', (socket) => {
    let data = Buffer.alloc(0);
    socket.on('data', (chunk) => {
      data = Buffer.concat([data, chunk]);
      if (data.length >= 5 && data.length >= 5 + data.readUInt16BE(3)) {
        clearTimeout(timer);
        socket.destroy();
        resolveFlight(data.subarray(0, 5 + data.readUInt16BE(3)).toString('hex'));
      }
    });
    socket.on('error', () => {});
  });
});

const url = `https://localhost:${port}/`;
const httpsFlight = nextFlight();
const agent = new undici.Agent({ connect: undici.buildConnector({}) });
undici.request(url, { dispatcher: agent }).catch(() => {});
const https = await httpsFlight;
await agent.destroy().catch(() => {});

const wssFlight = nextFlight();
const socket = new WebSocket(url.replace('https', 'wss'));
socket.on('error', () => {});
const wss = await wssFlight;
socket.terminate();
listener.close();

writeFileSync(resolve(arg('--out')), JSON.stringify({
  nodeCommit: arg('--node-commit'), node: process.version, openssl: process.versions.openssl, undici: require('undici/package.json').version, ws: require(require.resolve('ws').replace(/[\\/]wrapper\.mjs$|[\\/]index\.js$/, '') + '/package.json').version, https, wss,
}, null, 1));
console.log(`wrote ${arg('--out')} (node ${process.version}, openssl ${process.versions.openssl})`);
process.exit(0);
