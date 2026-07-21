#!/usr/bin/env node
// Mixdog remote relay (stage 2 of the mobile companion).
//
// Topology: the desktop keeps ONE outbound WebSocket to this relay (so no
// port-forwarding/NAT work on the user side), phones connect here with the
// pairing token, and the relay forwards frames between them verbatim. The
// phone-side wire protocol is IDENTICAL to the desktop's LAN bridge
// (apps/desktop/src/main/remote-bridge.ts), so the renderer's remote shim
// works unchanged whether it talks to the LAN bridge or to this relay.
//
// Envelope protocol on the desktop leg (JSON, one object per message):
//   relay -> desktop: { type: 'client-open',  clientId }
//                     { type: 'client-close', clientId }
//                     { type: 'frame', clientId, data }   // phone RPC frame
//   desktop -> relay: { type: 'frame', clientId, data }   // RPC response
//                     { type: 'broadcast', data }         // state/term push
//                     { type: 'set-client-token', token } // phone auth token
//
// Auth: desktops self-register on first connect (trust-on-first-use device
// id + secret, hashes persisted under DATA_DIR); phones present the client
// token the desktop registered. Payloads are relayed without inspection.
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync, createReadStream, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { createServer as createTlsServer } from 'node:https';
import { extname, join, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

import { WebSocketServer } from 'ws';

const MAX_WS_PAYLOAD_BYTES = 64 * 1024 * 1024;

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.wasm': 'application/wasm',
  '.txt': 'text/plain; charset=utf-8',
  '.apk': 'application/vnd.android.package-archive',
};

function sha256(value) {
  return createHash('sha256').update(String(value)).digest('hex');
}

function hashesMatch(expectedHex, candidate) {
  if (!expectedHex || !candidate) return false;
  const a = Buffer.from(expectedHex, 'hex');
  const b = createHash('sha256').update(String(candidate)).digest();
  return a.length === b.length && timingSafeEqual(a, b);
}

class DeviceStore {
  constructor(dataDir) {
    this.path = join(dataDir, 'devices.json');
    this.devices = new Map();
    try {
      const parsed = JSON.parse(readFileSync(this.path, 'utf8'));
      for (const [id, row] of Object.entries(parsed)) this.devices.set(id, row);
    } catch { /* first run */ }
  }

  save() {
    const plain = Object.fromEntries(this.devices);
    try {
      mkdirSync(resolve(this.path, '..'), { recursive: true });
      writeFileSync(this.path, JSON.stringify(plain, null, 2), 'utf8');
    } catch (error) {
      console.error('[relay] failed to persist device store:', error.message);
    }
  }

  authenticate(deviceId, secret) {
    const known = this.devices.get(deviceId);
    if (!known) {
      this.devices.set(deviceId, { secretHash: sha256(secret), clientTokenHash: '' });
      this.save();
      return true;
    }
    return hashesMatch(known.secretHash, secret);
  }

  setClientToken(deviceId, token) {
    const known = this.devices.get(deviceId);
    if (!known) return;
    known.clientTokenHash = sha256(token);
    this.save();
  }

  deviceIdForClientToken(token) {
    for (const [id, row] of this.devices) {
      if (hashesMatch(row.clientTokenHash, token)) return id;
    }
    return null;
  }
}

function serveStatic(rendererDir, request, response) {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    response.writeHead(405).end();
    return;
  }
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(request.url || '/', 'http://localhost').pathname);
  } catch {
    response.writeHead(400).end();
    return;
  }
  if (pathname === '/healthz') {
    response.writeHead(200, { 'Content-Type': 'application/json' }).end('{"status":"ok"}');
    return;
  }
  if (!rendererDir) {
    response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
      .end('Mixdog relay: no RENDERER_DIR configured; this relay only forwards WebSocket traffic.');
    return;
  }
  const root = resolve(rendererDir);
  let target = resolve(root, `.${pathname}`);
  if (target !== root && !target.startsWith(root + sep)) {
    response.writeHead(403).end();
    return;
  }
  try {
    if (target === root || !statSync(target).isFile()) target = join(root, 'index.html');
  } catch {
    target = join(root, 'index.html');
  }
  // SPA fallback belongs to extension-less routes only: a missing FILE must
  // 404 instead of masquerading as the web app (an .apk download would
  // otherwise save index.html as the installer).
  if (target === join(root, 'index.html') && extname(pathname) && pathname !== '/index.html') {
    response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Not found.');
    return;
  }
  if (!existsSync(target)) {
    response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
      .end('Mixdog relay: renderer build not found.');
    return;
  }
  const type = MIME_TYPES[extname(target).toLowerCase()] || 'application/octet-stream';
  const cache = target.endsWith('index.html') ? 'no-cache' : 'public, max-age=86400';
  const headers = { 'Content-Type': type, 'Content-Length': statSync(target).size, 'Cache-Control': cache };
  if (extname(target).toLowerCase() === '.apk') {
    // Mirror the desktop bridge: never cache the installer (a stale cached
    // copy re-installs an old/broken package) and force a download even in
    // in-app browsers that would try to render it.
    headers['Cache-Control'] = 'no-store';
    headers['Content-Disposition'] = 'attachment; filename="mixdog.apk"';
  }
  response.writeHead(200, headers);
  if (request.method === 'HEAD') {
    response.end();
    return;
  }
  createReadStream(target).on('error', () => response.destroy()).pipe(response);
}

export async function startRelay({
  port = 9800,
  dataDir = './data',
  rendererDir = '',
  // TLS termination stays in-process (no reverse proxy in the data path):
  // point these at fullchain.pem / privkey.pem to serve https+wss directly.
  tlsCert = '',
  tlsKey = '',
} = {}) {
  const store = new DeviceStore(resolve(dataDir));
  // deviceId -> { socket, clients: Map<clientId, phoneSocket> }
  const liveDesktops = new Map();
  const handler = (request, response) => serveStatic(rendererDir, request, response);
  const server = tlsCert && tlsKey
    ? createTlsServer({ cert: readFileSync(tlsCert), key: readFileSync(tlsKey) }, handler)
    : createServer(handler);
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: MAX_WS_PAYLOAD_BYTES,
    // Relayed transcript pushes are repetitive text: deflate cuts them 5-10x.
    perMessageDeflate: { threshold: 1024 },
  });

  const sendJson = (socket, payload) => {
    if (socket && socket.readyState === socket.OPEN) {
      try { socket.send(JSON.stringify(payload)); } catch { /* peer vanished */ }
    }
  };

  const attachDesktop = (deviceId, socket) => {
    const previous = liveDesktops.get(deviceId);
    if (previous) {
      try { previous.socket.close(4000, 'superseded'); } catch { /* already gone */ }
      for (const phone of previous.clients.values()) {
        try { phone.close(4001, 'desktop reconnected'); } catch { /* already gone */ }
      }
    }
    const entry = { socket, clients: new Map() };
    liveDesktops.set(deviceId, entry);
    return entry;
  };

  server.on('upgrade', (request, rawSocket, head) => {
    let url;
    try {
      url = new URL(request.url || '/', 'http://localhost');
    } catch {
      rawSocket.destroy();
      return;
    }
    const reject = () => {
      rawSocket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      rawSocket.destroy();
    };
    if (url.pathname === '/desktop') {
      const deviceId = url.searchParams.get('device') || '';
      const secret = url.searchParams.get('secret') || '';
      if (!/^[0-9a-f-]{8,64}$/.test(deviceId) || secret.length < 16 || !store.authenticate(deviceId, secret)) {
        reject();
        return;
      }
      wss.handleUpgrade(request, rawSocket, head, (socket) =>
        runDesktopLeg({ store, sendJson, attachDesktop, liveDesktops }, deviceId, socket));
      return;
    }
    if (url.pathname === '/ws') {
      const token = url.searchParams.get('token') || '';
      const deviceId = store.deviceIdForClientToken(token);
      const entry = deviceId ? liveDesktops.get(deviceId) : null;
      if (!entry || entry.socket.readyState !== entry.socket.OPEN) {
        reject();
        return;
      }
      wss.handleUpgrade(request, rawSocket, head, (socket) => runClientLeg(entry, sendJson, socket));
      return;
    }
    rawSocket.destroy();
  });

  return finishRelayStart({ server, wss, store, liveDesktops, port, sendJson });
}

async function finishRelayStart({ server, wss, store, liveDesktops, port, sendJson }) {
  await new Promise((resolveListen, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(port, '0.0.0.0', () => {
      server.removeListener('error', rejectListen);
      resolveListen();
    });
  });
  // NAT/middleboxes drop idle WebSockets silently; sweep every 25s so dead
  // desktop legs release their registration (phones otherwise blackhole)
  // and dead phone legs stop holding broadcast fan-out slots.
  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (ws.isAlive === false) {
        try { ws.terminate(); } catch { /* already gone */ }
        continue;
      }
      ws.isAlive = false;
      try { ws.ping(); } catch { /* surfaced as close */ }
    }
  }, 25_000);
  heartbeat.unref?.();
  const address = server.address();
  const boundPort = typeof address === 'object' && address ? address.port : port;
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    clearInterval(heartbeat);
    for (const entry of liveDesktops.values()) {
      try { entry.socket.terminate(); } catch { /* already gone */ }
      for (const phone of entry.clients.values()) {
        try { phone.terminate(); } catch { /* already gone */ }
      }
    }
    liveDesktops.clear();
    await new Promise((resolveClose) => wss.close(() => resolveClose()));
    await new Promise((resolveClose) => server.close(() => resolveClose()));
  };
  return { port: boundPort, store, close };
}

const invokedDirectly = Boolean(process.argv[1])
  && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  const port = Number(process.env.PORT || 9800);
  const dataDir = process.env.DATA_DIR || './data';
  const rendererDir = process.env.RENDERER_DIR || '';
  const tlsCert = process.env.TLS_CERT || '';
  const tlsKey = process.env.TLS_KEY || '';
  startRelay({ port, dataDir, rendererDir, tlsCert, tlsKey }).then((relay) => {
    const scheme = tlsCert && tlsKey ? 'https' : 'http';
    console.log(`[relay] ${scheme} listening on :${relay.port} (renderer: ${rendererDir || 'none'})`);
  }).catch((error) => {
    console.error('[relay] failed to start:', error.message);
    process.exit(1);
  });
}

function runDesktopLeg(context, deviceId, socket) {
  const { store, sendJson, attachDesktop, liveDesktops } = context;
  const entry = attachDesktop(deviceId, socket);
  socket.isAlive = true;
  socket.on('pong', () => { socket.isAlive = true; });
  socket.on('error', () => { /* surfaced as close */ });
  socket.on('message', (raw) => {
    socket.isAlive = true;
    let message;
    try { message = JSON.parse(raw.toString()); } catch { return; }
    if (message.type === 'set-client-token' && typeof message.token === 'string' && message.token.length >= 16) {
      store.setClientToken(deviceId, message.token);
      return;
    }
    if (message.type === 'frame' && typeof message.data === 'string') {
      const phone = entry.clients.get(String(message.clientId || ''));
      if (phone && phone.readyState === phone.OPEN) {
        try { phone.send(message.data); } catch { /* phone vanished */ }
      }
      return;
    }
    if (message.type === 'broadcast' && typeof message.data === 'string') {
      for (const phone of entry.clients.values()) {
        if (phone.readyState === phone.OPEN) {
          try { phone.send(message.data); } catch { /* phone vanished */ }
        }
      }
    }
  });
  socket.on('close', () => {
    if (liveDesktops.get(deviceId)?.socket === socket) {
      for (const phone of entry.clients.values()) {
        try { phone.close(4002, 'desktop offline'); } catch { /* already gone */ }
      }
      liveDesktops.delete(deviceId);
    }
  });
}

function runClientLeg(entry, sendJson, socket) {
  const clientId = randomUUID();
  entry.clients.set(clientId, socket);
  sendJson(entry.socket, { type: 'client-open', clientId });
  socket.isAlive = true;
  socket.on('pong', () => { socket.isAlive = true; });
  socket.on('error', () => { /* surfaced as close */ });
  socket.on('message', (raw) => {
    socket.isAlive = true;
    const text = raw.toString();
    // Phone liveness probe: answered at the relay — reaching this hop is the
    // question being asked (a dead desktop closes this leg outright).
    if (text.startsWith('{"ping"')) {
      try { socket.send('{"pong":1}'); } catch { /* surfaced as close */ }
      return;
    }
    sendJson(entry.socket, { type: 'frame', clientId, data: text });
  });
  socket.on('close', () => {
    entry.clients.delete(clientId);
    sendJson(entry.socket, { type: 'client-close', clientId });
  });
}
