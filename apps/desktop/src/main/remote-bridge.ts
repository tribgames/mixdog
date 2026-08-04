// LAN remote bridge (stage 1 of the mobile companion): a plain HTTP server
// that serves the built renderer to a phone browser, plus a token-gated
// WebSocket that carries DesktopApi RPC frames and state/terminal pushes.
// The relay-server stage reuses this exact message protocol.
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { networkInterfaces } from 'node:os';
import { join } from 'node:path';

import { WebSocketServer, type WebSocket } from 'ws';

import {
  pairingCookieHeaders,
  parseCookieToken,
  resolveStaticTarget,
  sendApkFile,
  sendStaticFile,
} from '../../../relay/lib/static-http.mjs';
import { parseMediaRequest, sendMediaFile } from '../../../relay/lib/media-http.mjs';
import type { DesktopEngineHost } from './engine-host-api';
import { resolveMediaFileTarget } from './media-source';
import { createRemoteMethods, executeRemoteFrame, type RemoteMethodDependencies } from './remote-methods';
import { readSecretFile, writeSecretFile } from './secret-file';
import { createSnapshotDeltaEncoder, isStateResyncFrame, type SnapshotDeltaEncoder } from './state-delta';

const DEFAULT_REMOTE_BRIDGE_PORT = 8791;
// Headroom over the IPC surface's 28M-base64 attachment ceiling.
const MAX_WS_PAYLOAD_BYTES = 64 * 1024 * 1024;

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
  const existing = (await readSecretFile(tokenPath))?.trim();
  if (existing && /^[0-9a-f]{32,128}$/.test(existing)) return existing;
  return writeToken(tokenPath);
}

async function writeToken(tokenPath: string): Promise<string> {
  const token = randomBytes(24).toString('hex');
  await writeSecretFile(tokenPath, token);
  return token;
}

/** Revocation: mint a new pairing token so every QR/deep link handed out so
 *  far stops working. Callers must restart the bridge/relay legs to load it. */
export async function rotateRemoteToken(userDataPath: string): Promise<string> {
  return writeToken(join(userDataPath, 'remote-bridge.token'));
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
  token: string,
  request: IncomingMessage,
  response: ServerResponse,
): void {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    response.writeHead(405).end();
    return;
  }
  let pathname: string;
  let queryToken = '';
  try {
    const url = new URL(request.url || '/', 'http://localhost');
    pathname = decodeURIComponent(url.pathname);
    queryToken = url.searchParams.get('token') || '';
  } catch {
    response.writeHead(400).end();
    return;
  }
  // The app shell and the staged APK are for paired phones only: the LAN leg
  // now gates them exactly like the relay, so a random host on the network
  // cannot pull the installer or fingerprint the build.
  if (!tokenMatches(token, queryToken || parseCookieToken(request.headers.cookie))) {
    response.writeHead(401, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Unauthorized.');
    return;
  }
  const authCookie = pairingCookieHeaders(queryToken, request);
  // The Android package downloads from a STABLE home (userData survives
  // renderer rebuilds; out/renderer is wiped by every build, and the SPA
  // fallback then served index.html as "mixdog.apk" — the web app opened
  // instead of the installer).
  if (pathname === '/mixdog.apk') {
    if (!sendApkFile(request, response, join(userDataPath, 'mixdog.apk'), authCookie)) {
      response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
        .end('Mixdog remote bridge: no Android package staged.');
    }
    return;
  }
  const resolved = resolveStaticTarget(rendererDir, pathname);
  if (resolved.status === 403) {
    response.writeHead(403).end();
    return;
  }
  if (resolved.status === 404) {
    response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
      .end('Not found.');
    return;
  }
  sendStaticFile(request, response, resolved.target, authCookie);
}

/**
 * `/media/<assetId>?variant=` — the gallery's byte lane over the LAN leg.
 *
 * Returns true once it owns the request. Token gate first (same credential as
 * the app shell), then the runtime resolves the file and the shared helper
 * answers with cache validators and Range support.
 */
function handleMediaRequest(
  host: DesktopEngineHost,
  token: string,
  request: IncomingMessage,
  response: ServerResponse,
): boolean {
  let url: URL;
  try {
    url = new URL(request.url || '/', 'http://localhost');
  } catch {
    return false;
  }
  const pathname = decodeURIComponent(url.pathname);
  if (!pathname.startsWith('/media/')) return false;
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    response.writeHead(405).end();
    return true;
  }
  if (!tokenMatches(token, url.searchParams.get('token') || parseCookieToken(request.headers.cookie))) {
    response.writeHead(401, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Unauthorized.');
    return true;
  }
  // Feature probe: the web client only switches to URL mode when its host
  // actually serves this lane (an older relay/bridge answers 404).
  if (pathname === '/media/healthz') {
    response.writeHead(200, { 'Content-Type': 'application/json' }).end('{"status":"ok"}');
    return true;
  }
  const target = parseMediaRequest(pathname, url.searchParams);
  if (!target) {
    response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Not found.');
    return true;
  }
  void (async () => {
    try {
      const file = await resolveMediaFileTarget(host, target.assetId, target.variant);
      if (!file) {
        response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Not found.');
        return;
      }
      sendMediaFile(request, response, {
        path: file.path,
        mime: file.mime,
        assetId: target.assetId,
        variant: target.variant,
      });
    } catch {
      try {
        response.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Media failed.');
      } catch { /* client vanished */ }
    }
  })();
  return true;
}

export async function startRemoteBridge(options: RemoteBridgeOptions): Promise<RemoteBridgeHandle> {
  const token = await loadOrCreateToken(options.userDataPath);
  const methods = createRemoteMethods(options);
  const server = createServer((request, response) => {
    // Media is a byte lane, not an RPC payload: it answers before the app
    // shell so a tile or a video seek never touches the socket.
    if (handleMediaRequest(options.host, token, request, response)) return;
    serveStatic(options.rendererDir, options.userDataPath, token, request, response);
  });
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
