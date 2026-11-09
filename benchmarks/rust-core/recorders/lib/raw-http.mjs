// One raw HTTP/1.1 request over a plain socket and the complete answer, for recorders of local servers:
// `{ statusLine, headers, body }` (header names lowercase, `Date` left out, a chunked body decoded), or
// `{ connection: <error code> }` when the server does not accept or answer.
import { createConnection } from 'node:net';

function dechunk(raw) {
  const parts = [];
  let at = 0;
  for (;;) {
    const lineEnd = raw.indexOf('\r\n', at);
    const size = parseInt(raw.subarray(at, lineEnd).toString('latin1'), 16);
    if (size === 0) return Buffer.concat(parts);
    parts.push(raw.subarray(lineEnd + 2, lineEnd + 2 + size));
    at = lineEnd + 2 + size + 2;
  }
}

/** `extraHeaders`: [name, value] pairs sent after `Host` and `Connection: close`; `body`: a string sent with its length. */
export function rawExchange(host, port, { method, target, hostHeader, extraHeaders = [], body = null }) {
  return new Promise((resolve) => {
    const socket = createConnection({ host, port });
    const chunks = [];
    socket.on('connect', () => {
      const payload = body === null ? null : Buffer.from(body);
      const lines = [`${method} ${target} HTTP/1.1`, `Host: ${hostHeader}`, 'Connection: close', ...extraHeaders.map(([name, value]) => `${name}: ${value}`)];
      if (payload) lines.push(`Content-Length: ${payload.length}`);
      socket.write(`${lines.join('\r\n')}\r\n\r\n`);
      if (payload) socket.write(payload);
    });
    socket.on('data', (chunk) => chunks.push(chunk));
    socket.on('error', (error) => resolve({ connection: error.code }));
    socket.on('close', () => {
      const bytes = Buffer.concat(chunks);
      if (!bytes.length) return resolve({ connection: 'closed without an answer' });
      const split = bytes.indexOf('\r\n\r\n');
      const [statusLine, ...lines] = bytes.subarray(0, split).toString('utf8').split('\r\n');
      const headers = lines.map((line) => [line.slice(0, line.indexOf(':')).toLowerCase(), line.slice(line.indexOf(':') + 1).trim()]).filter(([name]) => name !== 'date');
      const raw = bytes.subarray(split + 4);
      const chunked = headers.some(([name, value]) => name === 'transfer-encoding' && value === 'chunked');
      resolve({ statusLine, headers, body: (chunked ? dechunk(raw) : raw).toString('utf8') });
    });
  });
}
