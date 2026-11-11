// A real WebSocket server on loopback for the recorders of the Responses WebSocket transport. The product's own client (`ws`, through
// openai-ws-connect.mjs createWsConnection) connects to it: the only substitution is `tls.connect`, which dials the loopback server
// instead of the named host (the host the product addressed is recorded in `dials`, and the upgrade request carries it as its Host header).
//
// `world.trace` is the ONE ordered record of the case: the dial, the upgrade request (method, target, every header in arrival order),
// the upgrade response (status line and headers in order, or the refusal), every frame in each direction (text or bytes, in the order the
// server saw / sent it), pings, closes with their codes, and whatever the case itself pushes through `world.note` (callbacks, results).
// A wait on the server side ends on the event it waits for (`world.until`) and has a deadline that names the step.
import http from 'node:http';
import net from 'node:net';
import tls from 'node:tls';
import { createRequire } from 'node:module';
import { join } from 'node:path';

const realSetTimeout = globalThis.setTimeout;
const realClearTimeout = globalThis.clearTimeout;
const DEADLINE_MS = 20_000;

const pairs = (raw) => {
  const out = [];
  for (let i = 0; i < raw.length; i += 2) out.push([raw[i], raw[i + 1]]);
  return out;
};
const payload = (data, isBinary) => (isBinary ? { binary: true, bytesHex: Buffer.from(data).toString('hex') } : { text: Buffer.from(data).toString('utf8') });

export async function startWsWorld({ tree }) {
  const { WebSocketServer } = createRequire(join(tree, 'package.json'))('ws');
  const world = { trace: [], dials: [], script: {}, conns: [] };
  const waiters = new Set();
  const note = (entry) => {
    world.trace.push(entry);
    for (const w of [...waiters]) w();
  };
  world.note = note;
  world.reset = (script = {}) => {
    for (const c of world.conns) c.ws.terminate();
    world.conns.length = 0;
    world.trace.length = 0;
    world.dials.length = 0;
    world.script = script;
  };
  /** Waits until `predicate(trace)` holds, woken by every trace entry; fails after the deadline naming `what`. */
  world.until = (predicate, what) =>
    new Promise((resolve, reject) => {
      const check = () => {
        if (!predicate(world.trace)) return;
        waiters.delete(check);
        realClearTimeout(timer);
        resolve();
      };
      const timer = realSetTimeout(() => {
        waiters.delete(check);
        reject(new Error(`recorder: ws world did not reach "${what}" within ${DEADLINE_MS} ms`));
      }, DEADLINE_MS);
      waiters.add(check);
      check();
    });
  const count = (trace, match) => trace.filter(match).length;
  world.count = (match) => count(world.trace, match);

  const server = http.createServer((req, res) => {
    res.writeHead(426, { connection: 'close' });
    res.end();
  });
  const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false });
  wss.on('headers', (lines, req) => {
    const extra = world.script.upgradeHeaders?.(req);
    if (extra) for (const [n, v] of extra) lines.push(`${n}: ${v}`);
    note({ event: 'upgrade-response', lines: [...lines] });
  });
  server.on('upgrade', (req, socket, head) => {
    note({ event: 'upgrade-request', method: req.method, target: req.url, httpVersion: req.httpVersion, headers: pairs(req.rawHeaders) });
    const refusal = world.script.refuse?.(req, world.count((e) => e.event === 'upgrade-request'));
    if (refusal) {
      const headerLines = (refusal.headers ?? []).map(([n, v]) => `${n}: ${v}`);
      const bodyChunks = refusal.bodyChunks ?? [refusal.body ?? ''];
      const body = bodyChunks.join('');
      const head1 = `HTTP/1.1 ${refusal.status} ${refusal.statusText ?? http.STATUS_CODES[refusal.status] ?? ''}`;
      note({ event: 'upgrade-refused', status: refusal.status, statusText: refusal.statusText ?? http.STATUS_CODES[refusal.status] ?? '', headers: refusal.headers ?? [], bodyChunks });
      socket.write(`${[head1, ...headerLines, `content-length: ${Buffer.byteLength(body)}`, 'connection: close'].join('\r\n')}\r\n\r\n`);
      // Each chunk is its own write, one event-loop turn apart, so the client reads them as separate data events.
      (async () => {
        for (const chunk of bodyChunks) {
          socket.write(chunk);
          await new Promise((resolve) => setImmediate(resolve));
        }
        socket.end();
      })();
      return;
    }
    if (refusal === null) {
      // The server accepts the TCP connection and never answers the upgrade.
      note({ event: 'upgrade-left-unanswered' });
      world.conns.push({ ws: { terminate: () => socket.destroy() } });
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      let serverInitiated = false;
      const conn = {
        ws,
        send: (frame) => {
          const isBinary = Buffer.isBuffer(frame);
          const data = isBinary || typeof frame === 'string' ? frame : JSON.stringify(frame);
          note({ event: 'frame', dir: 'server->client', ...payload(typeof data === 'string' ? Buffer.from(data) : data, isBinary) });
          ws.send(data, { binary: isBinary });
        },
        close: (code, reason = '') => {
          serverInitiated = true;
          note({ event: 'close-sent', by: 'server', code, reason });
          ws.close(code, reason);
        },
        terminate: () => {
          serverInitiated = true;
          note({ event: 'terminate', by: 'server' });
          ws.terminate();
        },
        ping: (data = '') => {
          note({ event: 'ping', dir: 'server->client', data: String(data) });
          ws.ping(data);
        },
      };
      world.conns.push(conn);
      ws.on('message', (data, isBinary) => {
        note({ event: 'frame', dir: 'client->server', ...payload(data, isBinary) });
        world.script.onFrame?.(conn, isBinary ? data : JSON.parse(data.toString('utf8')), world.count((e) => e.event === 'frame' && e.dir === 'client->server'));
      });
      ws.on('ping', (data) => note({ event: 'ping', dir: 'client->server', data: data.toString('utf8') }));
      ws.on('pong', (data) => note({ event: 'pong', dir: 'client->server', data: data.toString('utf8') }));
      ws.on('close', (code, reason) => note({ event: 'closed', serverInitiated, code, reason: reason.toString('utf8') }));
      ws.on('error', (error) => note({ event: 'socket-error', message: error.message, code: error.code ?? null }));
      note({ event: 'open' });
      world.script.onOpen?.(conn);
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const realConnect = tls.connect;
  tls.connect = (options) => {
    note({ event: 'dial', host: options.host ?? null, port: options.port ?? null, servername: options.servername ?? null });
    world.dials.push({ host: options.host ?? null, port: options.port ?? null });
    return net.connect({ host: '127.0.0.1', port });
  };
  world.close = () => {
    tls.connect = realConnect;
    world.reset();
    server.close();
    server.closeAllConnections?.();
  };
  return world;
}
