#!/usr/bin/env node
// What Node's global `fetch` (the client every OpenAI HTTP request of b6f10295a goes through, http-agent.mjs) does with
// a request method: the method it writes on the request line, or the error it throws before any socket is opened. A
// raw TCP listener reads the request line off the socket; nothing is parsed by a library.
//
// Usage: node node-method-capture.mjs --out <node-methods.json>
import crypto from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const METHODS = ['GET', 'get', 'Get', 'post', 'Post', 'put', 'delete', 'head', 'options', 'patch', 'Patch', 'PATCH', 'query', 'purge', 'connect', 'Connect', 'CONNECT', 'trace', 'Trace', 'TRACE', 'track', 'TRACK', 'bad method'];
const DEADLINE_MS = 30000;

const lines = [];
let lineArrived = null;
const server = net.createServer((socket) => {
  let head = '';
  socket.on('data', (chunk) => {
    head += chunk.toString('latin1');
    const end = head.indexOf('\r\n\r\n');
    if (end < 0) return;
    lineArrived(head.slice(0, head.indexOf('\r\n')));
    socket.end('HTTP/1.1 200 OK\r\ncontent-length: 0\r\nconnection: close\r\n\r\n');
  });
  socket.on('error', () => {});
});
await new Promise((done) => server.listen(0, '127.0.0.1', done));
const url = `http://127.0.0.1:${server.address().port}/m`;

for (const method of METHODS) {
  const line = new Promise((done) => { lineArrived = done; });
  let timer;
  const deadline = new Promise((_, fail) => { timer = setTimeout(() => fail(new Error(`timed out after ${DEADLINE_MS} ms awaiting the answer to ${method}`)), DEADLINE_MS); });
  try {
    const response = await Promise.race([fetch(url, { method }), deadline]);
    await Promise.race([response.arrayBuffer(), deadline]);
    lines.push({ method, wrote: (await Promise.race([line, deadline])).split(' ')[0] });
  } catch (error) {
    if (error.message.startsWith('timed out after')) throw error;
    lines.push({ method, error: { name: error.name, message: error.message } });
  } finally {
    clearTimeout(timer);
  }
}
server.close();
const self = fileURLToPath(import.meta.url);
const manifest = {
  exact: true,
  node: process.version,
  undici: process.versions.undici,
  harness: { 'node-method-capture.mjs': crypto.createHash('sha256').update(readFileSync(self)).digest('hex') },
};
writeFileSync(resolve(process.argv[process.argv.indexOf('--out') + 1]), `${JSON.stringify({ manifest, methods: lines }, null, 1)}\n`);
console.log(lines.map((l) => `${l.method}: ${l.wrote ?? l.error.message}`).join('\n'));
