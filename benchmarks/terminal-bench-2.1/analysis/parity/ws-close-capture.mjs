#!/usr/bin/env node
// What the Node client's WebSocket (`ws`, from the Node tree's own node_modules) puts on the socket when the server
// closes: a raw TCP server answers the upgrade, sends one close frame, and records, byte for byte, every frame the
// client writes after it (unmasked) and the client's end of the TCP stream (`end`, its FIN). The server sends nothing
// else and ends its own side only after the client's FIN, so an `end` inside the step deadline (10 s, a third of ws's
// 30 s closeTimeout) is the client closing on the handshake, not on its timer.
// Usage: node ws-close-capture.mjs <node-tree> --node-commit <sha> --out <file>
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const tree = resolve(process.argv[2]);
const arg = (name) => process.argv[process.argv.indexOf(name) + 1];
const require = createRequire(`${tree}/package.json`);
const WebSocket = require('ws');
const wsVersion = require(join(dirname(require.resolve('ws')), 'package.json')).version;
const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const STEP_DEADLINE_MS = 10_000;
const within = (promise, what) => {
  let timer;
  const deadline = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${what}: no result within ${STEP_DEADLINE_MS} ms`)), STEP_DEADLINE_MS); });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
};

// The close frames a server sends (unmasked, final): a code and a reason, a code alone, none, a code ws refuses
// (1002), a reason that is not UTF-8 (1007).
const CASES = [
  { name: 'code and reason', frame: '880503e8627965' },
  { name: 'a library code alone', frame: '88020fa0' },
  { name: 'no payload', frame: '8800' },
  { name: 'a code ws refuses', frame: '880203e7' },
  { name: 'a reason that is not UTF-8', frame: '880403e8c328' },
];

/** The frames in `bytes` (client frames, unmasked here), and the bytes left over. */
function frames(bytes) {
  const out = [];
  let at = 0;
  while (bytes.length - at >= 2) {
    const masked = (bytes[at + 1] & 0x80) !== 0;
    let length = bytes[at + 1] & 0x7f;
    let head = 2;
    if (length === 126) { if (bytes.length - at < 4) break; length = bytes.readUInt16BE(at + 2); head = 4; }
    else if (length === 127) { if (bytes.length - at < 10) break; length = Number(bytes.readBigUInt64BE(at + 2)); head = 10; }
    const total = head + (masked ? 4 : 0) + length;
    if (bytes.length - at < total) break;
    const key = masked ? bytes.subarray(at + head, at + head + 4) : null;
    const payload = Buffer.from(bytes.subarray(at + total - length, at + total));
    if (key) for (let i = 0; i < payload.length; i += 1) payload[i] ^= key[i % 4];
    const first = bytes[at];
    out.push({ kind: 'frame', fin: (first & 0x80) !== 0, rsv: (first >> 4) & 7, opcode: first & 15, masked, hex: payload.toString('hex') });
    at += total;
  }
  return { out, rest: bytes.subarray(at) };
}

async function record(c) {
  const events = [];
  let finished;
  const done = new Promise((resolveDone) => { finished = resolveDone; });
  const server = net.createServer((socket) => {
    let buffer = Buffer.alloc(0);
    let upgraded = false;
    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (!upgraded) {
        const end = buffer.indexOf('\r\n\r\n');
        if (end < 0) return;
        const key = buffer.subarray(0, end).toString('latin1').split('\r\n').find((l) => l.toLowerCase().startsWith('sec-websocket-key:')).split(':')[1].trim();
        buffer = buffer.subarray(end + 4);
        upgraded = true;
        const accept = crypto.createHash('sha1').update(key + GUID).digest('base64');
        socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
        socket.write(Buffer.from(c.frame, 'hex'));
      }
      const { out, rest } = frames(buffer);
      events.push(...out);
      buffer = rest;
    });
    socket.on('end', () => {
      events.push({ kind: 'end', unread: buffer.toString('hex') });
      socket.end();
    });
    socket.on('close', () => finished());
    socket.on('error', () => {});
  });
  await within(new Promise((ok) => server.listen(0, '127.0.0.1', ok)), 'listening');
  const client = new WebSocket(`ws://127.0.0.1:${server.address().port}/`);
  client.on('error', () => {});
  await within(done, `${c.name}: the connection's end`);
  server.close();
  return { name: c.name, frame: c.frame, events };
}

const results = [];
for (const c of CASES) results.push(await record(c));
const sha = (file) => crypto.createHash('sha256').update(readFileSync(file)).digest('hex');
const manifest = { exact: true, nodeCommit: arg('--node-commit'), node: process.version, ws: wsVersion, harness: { 'ws-close-capture.mjs': sha(fileURLToPath(import.meta.url)) } };
writeFileSync(resolve(arg('--out')), `${JSON.stringify({ manifest, cases: results }, null, 1)}\n`);
console.log(results.map((r) => `${r.name}: ${JSON.stringify(r.events)}`).join('\n'));
