// Local recording hub for provider adapters. `install(tree)` must run BEFORE any
// provider module is imported: it registers the `ws` / `node:http2` module
// stand-ins and replaces globalThis.fetch. All traffic then lands on loopback
// servers owned by the hub, which records the request the adapter really sent
// (original origin, headers with secrets redacted, body bytes / frames) and
// answers from a per-scenario script. No real host is ever contacted.
import http from 'node:http';
import http2 from 'node:http2';
import { register } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { installDeterminism } from './determinism.mjs';
import { cleanHeaders } from './headers.mjs';

const clean = cleanHeaders;

export async function install(tree) {
  const { WebSocketServer } = await import(pathToFileURL(join(tree, 'node_modules/ws/wrapper.mjs')).href);
  const hub = { script: null, records: [], realFetch: globalThis.fetch };
  globalThis.__benchHub = hub;

  // --- HTTP (global fetch is redirected here) ---
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const origin = req.headers['x-bench-origin'] ?? null;
    const rec = { transport: 'http', origin, method: req.method, path: req.url, headers: clean(req.headers, origin), rawHeaderOrder: req.rawHeaders.filter((_v, i) => i % 2 === 0).map((n) => n.toLowerCase()).filter((n) => n !== 'x-bench-origin'), bodyText: Buffer.concat(chunks).toString('utf8') };
    // The adapters' trace sink posts to the local daemon; that is not provider traffic.
    if (req.url.startsWith('/admin/')) {
      res.writeHead(204).end();
      return;
    }
    hub.records.push(rec);
    const reply = hub.script?.http?.(rec, hub.records.filter((r) => r.transport === 'http').length) ?? { status: 404, body: 'no script' };
    rec.served = reply.body;
    res.writeHead(reply.status ?? 200, { 'content-type': reply.contentType ?? 'text/event-stream', ...(reply.headers ?? {}) });
    if (reply.truncate) {
      res.write(reply.body);
      setTimeout(() => res.destroy(), 20);
    } else res.end(reply.body);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  hub.httpPort = server.address().port;
  hub.realFetch = globalThis.fetch;
  globalThis.fetch = (input, init) => {
    const req = input instanceof Request ? input : null;
    const url = new URL(req ? req.url : String(input));
    const headers = new Headers(init?.headers ?? req?.headers ?? {});
    headers.set('x-bench-origin', url.origin);
    return hub.realFetch(`http://127.0.0.1:${hub.httpPort}${url.pathname}${url.search}`, req ? { method: req.method, headers, body: req.body, duplex: 'half', signal: req.signal, ...init, headers } : { ...init, headers });
  };

  // --- WebSocket ---
  const wss = new WebSocketServer({
    port: 0,
    host: '127.0.0.1',
    verifyClient: (info, cb) => {
      const status = hub.script?.wsHandshakeStatus;
      if (!status) return cb(true);
      const origin = info.req.headers['x-bench-origin'] ?? null;
      hub.records.push({ transport: 'ws', origin, path: info.req.url, headers: clean(info.req.headers, origin), handshakeRejectedWith: status, frames: [] });
      cb(false, status, 'fixture handshake rejection');
    },
  });
  await new Promise((r) => wss.on('listening', r));
  hub.wsPort = wss.address().port;
  wss.on('connection', (socket, req) => {
    const origin = req.headers['x-bench-origin'] ?? null;
    const rec = { transport: 'ws', origin, path: req.url, headers: clean(req.headers, origin), frames: [] };
    hub.records.push(rec);
    const out = (data) => {
      const text = typeof data === 'string' ? data : JSON.stringify(data);
      rec.frames.push({ dir: 'out', text });
      socket.send(text);
    };
    hub.script?.ws?.onOpen?.({ out, close: (code) => socket.close(code), terminate: () => socket.terminate() });
    socket.on('message', (data) => {
      const text = data.toString('utf8');
      // The adapter stamps the send time (wall clock) into the request metadata; it is
      // not a protocol fact, so the recording keeps a placeholder (shape unchanged).
      rec.frames.push({ dir: 'in', text: text.replace(/(turn_started_at_unix_ms\\?":)\d+/g, '$1"<wallclock-ms>"').replace(/("x-codex-ws-stream-request-start-ms":")\d+/g, '$1<wallclock-ms>') });
      hub.script?.ws?.onMessage?.(text, { out, close: (code) => socket.close(code), terminate: () => socket.terminate() }, rec.frames.filter((f) => f.dir === 'in').length);
    });
  });

  // --- HTTP/2 cleartext (cursor connect protocol) ---
  const h2 = http2.createServer();
  h2.on('stream', (stream, headers) => {
    const chunks = [];
    stream.on('error', () => {});
    stream.session?.on('error', () => {});
    stream.on('data', (c) => chunks.push(c));
    stream.on('end', () => {
      const body = Buffer.concat(chunks);
      const rec = { transport: 'h2', origin: hub.lastH2Origin ?? null, method: headers[':method'], path: headers[':path'], headers: clean(headers, hub.lastH2Origin ?? null), bodyBase64: body.toString('base64') };
      hub.records.push(rec);
      const reply = hub.script?.h2?.(rec, body) ?? { status: 404, frames: [] };
      stream.respond({ ':status': reply.status ?? 200, 'content-type': reply.contentType ?? 'application/connect+proto' });
      rec.served = (reply.frames ?? []).map((f) => Buffer.from(f).toString('base64'));
      for (const f of reply.frames ?? []) stream.write(f);
      if (reply.reset) stream.close(http2.constants.NGHTTP2_INTERNAL_ERROR);
      else stream.end();
    });
  });
  await new Promise((r) => h2.listen(0, '127.0.0.1', r));
  hub.h2Port = h2.address().port;

  register('./intercept-hooks.mjs', { parentURL: import.meta.url, data: { tree: pathToFileURL(tree).href } });

  installDeterminism(hub, tree);
  // `id` seeds Math.random and scopes the timer log; hub.lastDeterminism holds
  // the rng samples and scheduled timers of the scenario that just ran.
  hub.run = async (script, fn, id) => {
    hub.script = script;
    hub.records = [];
    hub.beginScenario(id);
    try {
      return await fn();
    } finally {
      hub.lastDeterminism = hub.endScenario();
      hub.script = null;
    }
  };
  hub.close = async () => {
    hub.restoreDeterminism();
    globalThis.fetch = hub.realFetch;
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
    for (const c of wss.clients) c.terminate();
    await new Promise((r) => wss.close(r));
    h2.close();
  };
  return hub;
}
