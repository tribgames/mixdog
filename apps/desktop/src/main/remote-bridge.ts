// LAN remote bridge (stage 1 of the mobile companion): a plain HTTP server
// that serves the built renderer to a phone browser, plus a token-gated
// WebSocket that carries DesktopApi RPC frames and state/terminal pushes.
// The relay-server stage reuses this exact message protocol.
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { createReadStream, existsSync, statSync, promises as fsp } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { networkInterfaces } from 'node:os';
import { extname, join, resolve, sep } from 'node:path';

import { WebSocketServer, type WebSocket } from 'ws';

import { createRemoteMethods, executeRemoteFrame, type RemoteMethodDependencies } from './remote-methods';
import { createSnapshotDeltaEncoder, isStateResyncFrame, type SnapshotDeltaEncoder } from './state-delta';

export const DEFAULT_REMOTE_BRIDGE_PORT = 8791;
// Headroom over the IPC surface's 28M-base64 attachment ceiling.
const MAX_WS_PAYLOAD_BYTES = 64 * 1024 * 1024;

const MIME_TYPES: Record<string, string> = {
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

export interface RemoteBridgeOptions extends RemoteMethodDependencies {
  port: number;
  userDataPath: string;
  rendererDir: string;
  subscribeTerminalData?: (listener: (event: { id: string; data: string }) => void) => () => void;
}

export interface RemoteBridgeHandle {
  port: number;
  token: string;
  urls: string[];
  close(): Promise<void>;
}

/** Default ON (the phone app must survive however the desktop was launched):
 *  MIXDOG_REMOTE_BRIDGE_PORT=<port> overrides, MIXDOG_REMOTE_BRIDGE=0/false/off
 *  disables. The socket stays token-gated either way. */
export function resolveRemoteBridgePort(env: NodeJS.ProcessEnv): number | null {
  const raw = (env.MIXDOG_REMOTE_BRIDGE_PORT || '').trim();
  if (raw) {
    const port = Number(raw);
    return Number.isInteger(port) && port >= 0 && port <= 65_535 ? port : null;
  }
  const flag = (env.MIXDOG_REMOTE_BRIDGE || '').trim().toLowerCase();
  return flag === '0' || flag === 'false' || flag === 'off' ? null : DEFAULT_REMOTE_BRIDGE_PORT;
}

export async function loadOrCreateToken(userDataPath: string): Promise<string> {
  const tokenPath = join(userDataPath, 'remote-bridge.token');
  try {
    const existing = (await fsp.readFile(tokenPath, 'utf8')).trim();
    if (/^[0-9a-f]{32,128}$/.test(existing)) return existing;
  } catch { /* first run */ }
  const token = randomBytes(24).toString('hex');
  await fsp.mkdir(userDataPath, { recursive: true });
  await fsp.writeFile(tokenPath, token, 'utf8');
  return token;
}

function tokenMatches(expected: string, candidate: string | null): boolean {
  if (!candidate) return false;
  // Hash both sides so timingSafeEqual gets equal-length buffers.
  const a = createHash('sha256').update(expected).digest();
  const b = createHash('sha256').update(candidate).digest();
  return timingSafeEqual(a, b);
}

function lanUrls(port: number): string[] {
  const urls: string[] = [];
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family === 'IPv4' && !entry.internal) urls.push(`http://${entry.address}:${port}`);
    }
  }
  return urls.length ? urls : [`http://127.0.0.1:${port}`];
}

function serveStatic(
  rendererDir: string,
  userDataPath: string,
  request: IncomingMessage,
  response: ServerResponse,
): void {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    response.writeHead(405).end();
    return;
  }
  let pathname: string;
  try {
    pathname = decodeURIComponent(new URL(request.url || '/', 'http://localhost').pathname);
  } catch {
    response.writeHead(400).end();
    return;
  }
  // The Android package downloads from a STABLE home (userData survives
  // renderer rebuilds; out/renderer is wiped by every build, and the SPA
  // fallback then served index.html as "mixdog.apk" — the web app opened
  // instead of the installer).
  if (pathname === '/mixdog.apk') {
    const apk = join(userDataPath, 'mixdog.apk');
    if (!existsSync(apk) || !statSync(apk).isFile()) {
      response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
        .end('Mixdog remote bridge: no Android package staged.');
      return;
    }
    response.writeHead(200, {
      'Content-Type': MIME_TYPES['.apk'],
      'Content-Length': statSync(apk).size,
      // Forces a download even in in-app browsers that would otherwise try
      // to render the package (user saw a blank page, not the installer).
      'Content-Disposition': 'attachment; filename="mixdog.apk"',
      'Cache-Control': 'no-store',
    });
    if (request.method === 'HEAD') {
      response.end();
      return;
    }
    createReadStream(apk).on('error', () => response.destroy()).pipe(response);
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
  // 404 instead of masquerading as the web app.
  if (target === join(root, 'index.html') && extname(pathname) && pathname !== '/index.html') {
    response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Not found.');
    return;
  }
  if (!existsSync(target)) {
    response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
      .end('Mixdog remote bridge: renderer build not found. Run `npm run build` in apps/desktop.');
    return;
  }
  const type = MIME_TYPES[extname(target).toLowerCase()] || 'application/octet-stream';
  const cache = target.endsWith('index.html') ? 'no-cache' : 'public, max-age=86400';
  response.writeHead(200, { 'Content-Type': type, 'Cache-Control': cache });
  if (request.method === 'HEAD') {
    response.end();
    return;
  }
  createReadStream(target).on('error', () => response.destroy()).pipe(response);
}

export async function startRemoteBridge(options: RemoteBridgeOptions): Promise<RemoteBridgeHandle> {
  const token = await loadOrCreateToken(options.userDataPath);
  const methods = createRemoteMethods(options);
  const server = createServer((request, response) =>
    serveStatic(options.rendererDir, options.userDataPath, request, response));
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: MAX_WS_PAYLOAD_BYTES,
    // Transcript pushes are highly repetitive text: deflate cuts them 5-10x.
    perMessageDeflate: { threshold: 1024 },
  });

  server.on('upgrade', (request, socket, head) => {
    let authorized = false;
    try {
      const url = new URL(request.url || '/', 'http://localhost');
      authorized = url.pathname === '/ws' && tokenMatches(token, url.searchParams.get('token'));
    } catch {
      authorized = false;
    }
    if (!authorized) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(request, socket, head, (client) => wss.emit('connection', client, request));
  });

  const send = (client: WebSocket, payload: unknown): void => {
    if (client.readyState === client.OPEN) {
      try { client.send(JSON.stringify(payload)); } catch { /* client vanished mid-send */ }
    }
  };
  const broadcast = (payload: unknown): void => {
    if (wss.clients.size === 0) return;
    const message = JSON.stringify(payload);
    for (const client of wss.clients) {
      if (client.readyState === client.OPEN) {
        try { client.send(message); } catch { /* client vanished mid-send */ }
      }
    }
  };
  // State pushes ride a per-connection items delta (see state-delta.ts):
  // each socket tracks its own shared prefix, so a fresh phone gets one full
  // snapshot and then pays only for appended/changed items.
  const deltaEncoders = new WeakMap<WebSocket, SnapshotDeltaEncoder>();
  const broadcastState = (snapshot: unknown): void => {
    for (const client of wss.clients) {
      if (client.readyState !== client.OPEN) continue;
      const encoder = deltaEncoders.get(client);
      if (!encoder) continue;
      send(client, { event: 'state', payload: encoder.encode(snapshot) });
    }
  };

  wss.on('connection', (client) => {
    const encoder = createSnapshotDeltaEncoder();
    deltaEncoders.set(client, encoder);
    const live = client as WebSocket & { isAlive?: boolean };
    live.isAlive = true;
    client.on('pong', () => { live.isAlive = true; });
    client.on('error', () => { /* connection errors surface as close */ });
    client.on('message', (raw) => {
      live.isAlive = true;
      void (async () => {
        const frame = String(raw);
        // Phone-side liveness probe: answer locally without engine work.
        if (frame.startsWith('{"ping"')) {
          send(client, { pong: 1 });
          return;
        }
        if (isStateResyncFrame(frame)) {
          encoder.reset();
          send(client, { event: 'state', payload: encoder.encode(options.host.getSnapshot()) });
          return;
        }
        const response = await executeRemoteFrame(methods, frame);
        if (response !== undefined) send(client, response);
      })();
    });
  });

  // Reap half-dead phone sockets (screen-off, NAT idle timeout): ping every
  // 25s; a client that missed the previous ping is gone.
  const heartbeat = setInterval(() => {
    for (const client of wss.clients) {
      const live = client as WebSocket & { isAlive?: boolean };
      if (live.isAlive === false) {
        try { client.terminate(); } catch { /* already gone */ }
        continue;
      }
      live.isAlive = false;
      try { client.ping(); } catch { /* surfaces as close */ }
    }
  }, 25_000);
  heartbeat.unref?.();

  const unsubscribeState = options.host.subscribe(broadcastState);
  const unsubscribeTerminals = options.subscribeTerminalData?.((event) =>
    broadcast({ event: 'termData', payload: event })) ?? (() => {});

  await new Promise<void>((resolveListen, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(options.port, '0.0.0.0', () => {
      server.removeListener('error', rejectListen);
      resolveListen();
    });
  });
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : options.port;

  let closed = false;
  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    clearInterval(heartbeat);
    unsubscribeState();
    unsubscribeTerminals();
    for (const client of wss.clients) {
      try { client.terminate(); } catch { /* already gone */ }
    }
    await new Promise<void>((resolveClose) => wss.close(() => resolveClose()));
    await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
  };

  return { port, token, urls: lanUrls(port), close };
}
