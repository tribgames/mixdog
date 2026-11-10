// The loopback server of the Node half of the Grok wire recording: a raw TCP listener that keeps, byte for byte, what
// Node's real clients (undici) write, and answers as the scenario's script says. Nothing is parsed by a library: the
// request line, the headers (name and value, in the order sent) and the body come from the bytes read off the socket.
//
// The recording is a list of events in the order the server received them:
//   { kind: 'http', conn, line, headers: [[name, value]...], body: { bytes, sha256, text } | null }
// A connection is numbered by its first recorded event (two connections opened together may be accepted in either order;
// what each sent first is what the recording orders by).
import crypto from 'node:crypto';
import net from 'node:net';

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

/**
 * Listens on 127.0.0.1 and records into `traffic.sink`; `traffic.script.http` says what to answer, one entry per request
 * that is not a HEAD: a list of events (a 200 event stream) or { status, headers, events | body }. A HEAD is a socket
 * warm-up (Node's `preconnect`): recorded, answered empty. A request with nothing left to answer it is recorded and
 * `traffic.unanswered()` is called.
 */
export async function startWireServer({ traffic }) {
  const live = new Set();
  let next = 0;
  const server = net.createServer((socket) => {
    live.add(socket);
    socket.once('close', () => live.delete(socket));
    let conn = 0;
    let buffer = Buffer.alloc(0);
    let pending = null;
    const record = (event) => {
      if (!conn) conn = ++next;
      traffic.sink.push({ ...event, conn });
    };
    const answer = (line) => {
      if (line.startsWith('HEAD ')) return socket.end('HTTP/1.1 200 OK\r\ncontent-length: 0\r\nconnection: close\r\n\r\n');
      const reply = traffic.script.http.shift();
      if (!reply) return traffic.unanswered();
      const { status = 200, headers = {}, events, body } = Array.isArray(reply) ? { events: reply } : reply;
      const text = events ? events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join('') : body ?? '';
      const bytes = Buffer.from(text);
      const fields = { ...(events ? { 'content-type': 'text/event-stream' } : {}), ...headers, 'content-length': bytes.length };
      socket.write(`HTTP/1.1 ${status} X\r\n${Object.entries(fields).map(([n, v]) => `${n}: ${v}\r\n`).join('')}\r\n`);
      socket.write(bytes);
    };
    const consume = () => {
      for (;;) {
        if (!pending) {
          const end = buffer.indexOf('\r\n\r\n');
          if (end < 0) return;
          const head = parseHead(buffer.subarray(0, end).toString('latin1'));
          buffer = buffer.subarray(end + 4);
          if (headerOf(head.headers, 'transfer-encoding')) throw new Error('the recorder reads content-length bodies only');
          pending = { ...head, length: Number(headerOf(head.headers, 'content-length') ?? 0) };
        }
        if (buffer.length < pending.length) return;
        const body = buffer.subarray(0, pending.length);
        buffer = buffer.subarray(pending.length);
        record({ kind: 'http', line: pending.line, headers: pending.headers, body: body.length ? { bytes: body.length, sha256: sha256(body), text: body.toString('utf8') } : null });
        const { line } = pending;
        pending = null;
        answer(line);
      }
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
    /** A scenario starts: its connections are numbered from 1. */
    restart: () => { next = 0; },
    stop: () => { for (const socket of live) socket.destroy(); server.close(); },
  };
}