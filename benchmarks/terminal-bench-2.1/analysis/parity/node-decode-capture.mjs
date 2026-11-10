#!/usr/bin/env node
// What the product's `fetch` hands its consumer for a compressed response body: the bytes the body stream yields, then
// its end or its error. A raw TCP listener writes prepared bytes (a status line, `content-encoding`, `content-length`,
// the body) and closes; nothing on the server side is a library. Run it under the runtime the product runs its core
// under, the desktop's Electron in node mode (`ELECTRON_RUN_AS_NODE=1`), whose bundled undici decodes the body
// (`lib/web/fetch/index.js`, the `decoders` of `onHeaders`); the manifest names it. The bodies are written into the
// recording, so the Rust test serves the same bytes.
//
// Usage: ELECTRON_RUN_AS_NODE=1 electron node-decode-capture.mjs --out <node-decode.json> [--only <case>]
import crypto from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';

const DEADLINE_MS = 30000;
const arg = (name) => (process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : null);
const only = arg('--only');

const text = (s) => Buffer.from(s, 'latin1');
const P = text('hello parity '.repeat(200));
const Q = text('second member '.repeat(150));
const gz = (b) => zlib.gzipSync(b, { level: 6 });
const df = (b) => zlib.deflateSync(b, { level: 6 });
const raw = (b) => zlib.deflateRawSync(b, { level: 6 });
const br = (b) => zlib.brotliCompressSync(b, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 5 } });
const zs = zlib.zstdCompressSync ? (b) => zlib.zstdCompressSync(b) : null;
const cut = (b, n) => b.subarray(0, n);
const cat = (...parts) => Buffer.concat(parts);
const garbage = text('garbage after the stream');

/** name, content-encoding (null: no header), body */
const CASES = [
  ['gzip', 'gzip', gz(P)],
  ['x-gzip', 'x-gzip', gz(P)],
  ['gzip in upper case', 'GZIP', gz(P)],
  ['gzip padded', ' gzip ', gz(P)],
  ['gzip, two members', 'gzip', cat(gz(P), gz(Q))],
  ['gzip, garbage after the end', 'gzip', cat(gz(P), garbage)],
  ['gzip, one magic byte after the end', 'gzip', cat(gz(P), Buffer.from([0x1f, 0x00, 0x41, 0x42]))],
  ['gzip, zeros after the end', 'gzip', cat(gz(P), Buffer.alloc(16))],
  ['gzip, a second member cut short', 'gzip', cat(gz(P), cut(gz(Q), 20))],
  ['gzip, cut in the middle', 'gzip', cut(gz(P), 30)],
  ['gzip, cut before the trailer', 'gzip', cut(gz(P), gz(P).length - 4)],
  ['gzip, header only', 'gzip', cut(gz(P), 10)],
  ['gzip, corrupt', 'gzip', cat(cut(gz(P), 10), Buffer.alloc(40, 0xff))],
  ['gzip, bad crc', 'gzip', (() => { const b = Buffer.from(gz(P)); b[b.length - 6] ^= 0xff; return b; })()],
  ['gzip, a megabyte after the end', 'gzip', cat(gz(P), Buffer.alloc(1 << 20, 0x78))],
  ['deflate (zlib)', 'deflate', df(P)],
  ['deflate (raw)', 'deflate', raw(P)],
  ['deflate (zlib), two streams', 'deflate', cat(df(P), df(Q))],
  ['deflate (zlib), garbage after the end', 'deflate', cat(df(P), garbage)],
  ['deflate (raw), garbage after the end', 'deflate', cat(raw(P), garbage)],
  ['deflate (zlib), cut', 'deflate', cut(df(P), 30)],
  ['deflate (zlib), cut before the checksum', 'deflate', cut(df(P), df(P).length - 2)],
  ['deflate (raw), cut', 'deflate', cut(raw(P), 30)],
  ['deflate (zlib), bad checksum', 'deflate', (() => { const b = Buffer.from(df(P)); b[b.length - 1] ^= 0xff; return b; })()],
  ['br', 'br', br(P)],
  ['br, two streams', 'br', cat(br(P), br(Q))],
  ['br, garbage after the end', 'br', cat(br(P), garbage)],
  ['br, cut', 'br', cut(br(P), 20)],
  ['br, corrupt', 'br', Buffer.alloc(40, 0xff)],
  ...(zs
    ? [
        ['zstd', 'zstd', zs(P)],
        ['zstd, two frames', 'zstd', cat(zs(P), zs(Q))],
        ['zstd, garbage after the end', 'zstd', cat(zs(P), garbage)],
        ['zstd, cut', 'zstd', cut(zs(P), 20)],
      ]
    : []),
  ['br then gzip', 'br, gzip', gz(br(P))],
  ['gzip then deflate', 'gzip,deflate', df(gz(P))],
  ['gzip and identity', 'gzip, identity', gz(P)],
  ['identity', 'identity', P],
  ['an unknown coding', 'compress', gz(P)],
  ['gzip and an unknown coding', 'gzip, compress', gz(P)],
  ['an unknown coding and gzip', 'compress, gzip', gz(P)],
  ['an empty coding in the list', 'gzip,,', gz(P)],
  ['an empty header', '', P],
  ['five codings', 'gzip, gzip, gzip, gzip, gzip', gz(gz(gz(gz(gz(P)))))],
  ['six codings', 'gzip, gzip, gzip, gzip, gzip, gzip', gz(gz(gz(gz(gz(gz(P))))))],
  ['six unknown codings', 'a, b, c, d, e, f', P],
  ['no content-encoding', null, P],
];

let answer = null;
const server = net.createServer((socket) => {
  let head = '';
  socket.on('data', (chunk) => {
    head += chunk.toString('latin1');
    if (!head.includes('\r\n\r\n')) return;
    const [encoding, body] = answer;
    const lines = ['HTTP/1.1 200 OK', 'content-type: application/octet-stream', ...(encoding === null ? [] : [`content-encoding: ${encoding}`]), `content-length: ${body.length}`, 'connection: close'];
    socket.end(Buffer.concat([text(`${lines.join('\r\n')}\r\n\r\n`), body]));
  });
  socket.on('error', () => {});
});
await new Promise((done) => server.listen(0, '127.0.0.1', done));
const url = `http://127.0.0.1:${server.address().port}/d`;

const describe = (error) => {
  if (!error || typeof error !== 'object') return { message: String(error) };
  const out = { name: error.name, message: error.message };
  if (error.code) out.code = error.code;
  if (error.cause) out.cause = describe(error.cause);
  return out;
};

const results = [];
for (const [name, encoding, body] of CASES) {
  if (only && name !== only) continue;
  answer = [encoding, body];
  let timer;
  const deadline = new Promise((_, fail) => { timer = setTimeout(() => fail(new Error(`timed out after ${DEADLINE_MS} ms awaiting ${name}`)), DEADLINE_MS); });
  const entry = { name, encoding, bodyHex: body.toString('hex') };
  const received = [];
  try {
    const response = await Promise.race([fetch(url), deadline]);
    const reader = response.body.getReader();
    for (;;) {
      const { done, value } = await Promise.race([reader.read(), deadline]);
      if (done) break;
      received.push(Buffer.from(value));
    }
    entry.end = 'end';
  } catch (error) {
    if (error.message?.startsWith('timed out after')) throw error;
    entry.end = 'error';
    entry.error = describe(error);
  } finally {
    clearTimeout(timer);
  }
  entry.receivedHex = Buffer.concat(received).toString('hex');
  results.push(entry);
}
server.close();
const self = fileURLToPath(import.meta.url);
const manifest = {
  exact: true,
  node: process.version,
  undici: process.versions.undici,
  electron: process.versions.electron ?? null,
  harness: { 'node-decode-capture.mjs': crypto.createHash('sha256').update(readFileSync(self)).digest('hex') },
  ...(only ? { only } : {}),
};
writeFileSync(resolve(arg('--out')), `${JSON.stringify({ manifest, cases: results }, null, 1)}\n`);
console.log(results.map((r) => `${r.name}: ${r.receivedHex.length / 2} bytes, ${r.end}${r.error ? ` (${r.error.name}: ${r.error.message}${r.error.cause ? ` / ${r.error.cause.code ?? ''} ${r.error.cause.message}` : ''})` : ''}`).join('\n'));
