// The loopback server of the Node half of the wire parity check: a raw TCP listener that records, byte for byte, what the
// real clients (undici's `fetch`, the `ws` package) write, and answers as the scenario's script says. Nothing is parsed
// by a library: the request line, the headers (name, value, in the order sent) and the body come from the bytes read off
// the socket; a WebSocket frame is read from its header (fin, rsv bits, opcode, mask bit, length) and its payload unmasked.
//
// The recording is a list of events in the order the server received them:
//   { kind: 'http', conn, line, headers: [[name, value]...], body: { encoding, bytes, sha256, text } | null }
//   { kind: 'ws-upgrade', conn, line, headers }
//   { kind: 'ws-frame', opcode, fin, rsv, masked, bytes, text | hex }
//   { kind: 'closed', conn }                 (only when the script awaits it)
// `Sec-WebSocket-Key` is the one value the client draws at random for every connection (RFC 6455 4.1); it is replaced
// by `<random>` unless `keepRandom` (wire-random-proof.mjs records twice with it kept to show it is the only value that
// differs between runs).
import crypto from 'node:crypto';
import net from 'node:net';
import { gunzipSync, zstdDecompressSync } from 'node:zlib';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
export const RANDOM = '<random>';

const sha256 = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');

/** The head of an HTTP/1.1 message: its first line and its header fields as they were sent. */
function parseHead(text) {
  const [line, ...fields] = text.split('\r\n');
  const headers = fields.map((field) => {
    const at = field.indexOf(':');
    return [field.slice(0, at), field.slice(at + 1).trim()];
  });
  return { line, headers };
}
const headerOf = (headers, name) => headers.find(([n]) => n.toLowerCase() === name)?.[1];

/** The body as sent, and as the provider meant it: gzip and zstd bodies are decoded for the text. */
function bodyRecord(bytes, headers) {
  if (!bytes.length) return null;
  const encoding = headerOf(headers, 'content-encoding') ?? null;
  const decoded = encoding === 'gzip' ? gunzipSync(bytes) : encoding === 'zstd' ? zstdDecompressSync(bytes) : bytes;
  return { encoding, bytes: bytes.length, sha256: sha256(bytes), text: decoded.toString('utf8') };
}

const serverFrame = (opcode, payload) => {
  const n = payload.length;
  const head = n < 126 ? Buffer.from([0x80 | opcode, n]) : n < 65536 ? Buffer.from([0x80 | opcode, 126, n >> 8, n & 255]) : (() => { const h = Buffer.alloc(10); h[0] = 0x80 | opcode; h[1] = 127; h.writeBigUInt64BE(BigInt(n), 2); return h; })();
  return Buffer.concat([head, payload]);
};

/**
 * Listens on 127.0.0.1 and records into `traffic.sink`; `traffic.script` says what to answer:
 *   dials:   one per upgrade request: { accept: true, headers } or { accept: false, status, headers, body }
 *   ws:      one per data message received: a list of events (sent as text frames), or { events, then: 'close' | 'reset'
 *            | 'hold' } ('hold': nothing more is sent, and `traffic.held()` is called once the events are written)
 *   http:    one per request: a list of events (a 200 event stream), or { status, headers, events | body, then: 'reset' }
 *   awaitClose: a connection number the scenario ends on once it closed
 * A request with nothing left to answer it is recorded, and `traffic.unanswered(kind)` is called.
 */
export async function startWireServer({ traffic, keepRandom = false }) {
  const live = new Set();
  const ended = new Map();
  const upgraded = new Set();
  let next = 0;
  const server = net.createServer((socket) => {
    live.add(socket);
    const closedPromise = new Promise((resolve) => socket.once('close', () => { live.delete(socket); resolve(); }));
    // A connection is numbered by its first recorded event, not by its accept: two connections opened together may be
    // accepted in either order, and what each one sent first is what the recording orders by.
    let conn = 0;
    const record = (event) => {
      if (!conn) { conn = ++next; ended.set(conn, closedPromise); }
      if (!traffic.paused) traffic.sink.push({ ...event, conn });
    };
    let buffer = Buffer.alloc(0);
    let mode = 'head';
    let pending = null;
    const consume = () => {
      for (;;) {
        if (mode === 'head') {
          const end = buffer.indexOf('\r\n\r\n');
          if (end < 0) return;
          const head = parseHead(buffer.subarray(0, end).toString('latin1'));
          buffer = buffer.subarray(end + 4);
          if (headerOf(head.headers, 'upgrade')?.toLowerCase() === 'websocket') {
            upgrade(head);
            mode = 'frames';
          } else {
            if (headerOf(head.headers, 'transfer-encoding')) throw new Error('the recorder reads content-length bodies only');
            pending = { ...head, length: Number(headerOf(head.headers, 'content-length') ?? 0) };
            mode = 'body';
          }
        } else if (mode === 'body') {
          if (buffer.length < pending.length) return;
          const body = buffer.subarray(0, pending.length);
          buffer = buffer.subarray(pending.length);
          record({ kind: 'http', line: pending.line, headers: pending.headers, body: bodyRecord(body, pending.headers) });
          answerHttp(pending.line);
          pending = null;
          mode = 'head';
        } else {
          if (!frame()) return;
        }
      }
    };
    const upgrade = (head) => {
      const key = headerOf(head.headers, 'sec-websocket-key');
      const headers = keepRandom ? head.headers : head.headers.map(([n, v]) => [n, n.toLowerCase() === 'sec-websocket-key' ? RANDOM : v]);
      record({ kind: 'ws-upgrade', line: head.line, headers });
      upgraded.add(conn);
      const dial = traffic.script.dials.shift() ?? { accept: true };
      const extra = Object.entries(dial.headers || {}).map(([n, v]) => `${n}: ${v}\r\n`).join('');
      if (dial.accept) {
        const accept = crypto.createHash('sha1').update(key + GUID).digest('base64');
        socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n${extra}\r\n`);
        return;
      }
      const body = Buffer.from(dial.body || '');
      socket.write(`HTTP/1.1 ${dial.status} Refused\r\n${extra}content-length: ${body.length}\r\nconnection: close\r\n\r\n`);
      socket.write(body);
    };
    const frame = () => {
      if (buffer.length < 2) return false;
      const masked = (buffer[1] & 128) !== 0;
      let length = buffer[1] & 127;
      let at = 2;
      if (length === 126) { if (buffer.length < 4) return false; length = buffer.readUInt16BE(2); at = 4; }
      else if (length === 127) { if (buffer.length < 10) return false; length = Number(buffer.readBigUInt64BE(2)); at = 10; }
      const maskKey = masked ? buffer.subarray(at, at + 4) : null;
      if (masked) at += 4;
      if (buffer.length < at + length) return false;
      const payload = Buffer.from(buffer.subarray(at, at + length));
      if (masked) for (let i = 0; i < payload.length; i += 1) payload[i] ^= maskKey[i % 4];
      const first = buffer[0];
      buffer = buffer.subarray(at + length);
      const opcode = first & 15;
      const event = { kind: 'ws-frame', opcode, fin: (first & 128) !== 0, rsv: [(first & 64) !== 0, (first & 32) !== 0, (first & 16) !== 0], masked, bytes: payload.length };
      if (opcode === 1) event.text = payload.toString('utf8');
      else event.hex = payload.toString('hex');
      record(event);
      if (opcode === 8) socket.write(serverFrame(8, payload));
      if (opcode === 9) socket.write(serverFrame(10, payload));
      if (opcode === 1 || opcode === 2) answerWs();
      return true;
    };
    const answerWs = () => {
      const reply = traffic.script.replies.shift();
      if (!reply) return traffic.unanswered?.('ws');
      const { events, then } = Array.isArray(reply) ? { events: reply } : reply;
      for (const event of events || []) socket.write(serverFrame(1, Buffer.from(JSON.stringify(event))));
      if (then === 'close') socket.end(serverFrame(8, Buffer.from([3, 232])));
      if (then === 'reset') socket.destroy();
      if (then === 'hold') socket.write('', () => traffic.held?.());
    };
    const answerHttp = (line) => {
      // A HEAD request is a socket warm-up (Node's `preconnect`), not a turn: it is recorded and answered empty.
      if (line.startsWith('HEAD ')) return socket.end('HTTP/1.1 200 OK\r\ncontent-length: 0\r\nconnection: close\r\n\r\n');
      const reply = traffic.script.http.shift();
      if (!reply) return traffic.unanswered?.('http');
      const { status = 200, headers = {}, events, body, then } = Array.isArray(reply) ? { events: reply } : reply;
      const text = events ? events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join('') : body ?? '';
      const bytes = Buffer.from(text);
      const fields = { ...(events ? { 'content-type': 'text/event-stream' } : {}), ...headers, 'content-length': bytes.length };
      socket.write(`HTTP/1.1 ${status} X\r\n${Object.entries(fields).map(([n, v]) => `${n}: ${v}\r\n`).join('')}\r\n`);
      socket.write(bytes);
      if (then === 'reset') socket.destroy();
    };
    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      consume();
    });
    socket.on('error', () => {});
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    port: server.address().port,
    /** Resolves when connection `conn` has closed, recording it; the caller puts the deadline on it. */
    closed: async (conn, recorded) => {
      await ended.get(conn);
      if (recorded && !traffic.paused) traffic.sink.push({ kind: 'closed', conn });
    },
    /** The numbers of the connections that upgraded to a WebSocket. */
    openSockets: () => [...ended.keys()].filter((conn) => upgraded.has(conn)),
    stop: () => { for (const socket of live) socket.destroy(); server.close(); },
  };
}
