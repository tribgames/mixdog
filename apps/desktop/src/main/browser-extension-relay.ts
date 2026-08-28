import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { join } from 'node:path';
import { WebSocket, WebSocketServer, type RawData } from 'ws';

const RELAY_PORT = 18_795;
const REQUEST_TIMEOUT_MS = 15_000;
const KEEPALIVE_MS = 20_000;
const PAIRING_FILE = 'browser-extension-relay.json';

interface RelayOptions {
  userDataDirectory: string;
  extensionPath: string;
  port?: number;
}

export interface BrowserExtensionPairingInfo {
  port: number;
  pairingToken: string;
  extensionPath: string;
  connected: boolean;
}

interface PendingExtensionRequest {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timer: NodeJS.Timeout;
}

interface InternalSession {
  socket: WebSocket;
  targetId: string;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function safeJson(value: RawData): Record<string, unknown> | null {
  try {
    return record(JSON.parse(value.toString()));
  } catch {
    return null;
  }
}

function sameSecret(actual: string, expected: string): boolean {
  const actualHash = createHash('sha256').update(actual).digest();
  const expectedHash = createHash('sha256').update(expected).digest();
  return timingSafeEqual(actualHash, expectedHash);
}

function readOrCreatePairingToken(userDataDirectory: string): string {
  const path = join(userDataDirectory, PAIRING_FILE);
  try {
    const saved = record(JSON.parse(readFileSync(path, 'utf8')));
    const token = String(saved.pairingToken || '');
    if (/^[a-f0-9]{64}$/i.test(token)) return token;
  } catch {
    // Create the file below.
  }
  mkdirSync(userDataDirectory, { recursive: true });
  const pairingToken = randomBytes(32).toString('hex');
  writeFileSync(path, `${JSON.stringify({ pairingToken }, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
  return pairingToken;
}

export class BrowserExtensionRelay {
  private readonly pairingToken: string;
  private readonly internalToken = randomBytes(32).toString('hex');
  private readonly websocketServer = new WebSocketServer({ noServer: true });
  private port: number;
  private server: Server | null = null;
  private startPromise: Promise<void> | null = null;
  private extensionSocket: WebSocket | null = null;
  private keepalive: NodeJS.Timeout | null = null;
  private nextRequestId = 0;
  private readonly pending = new Map<string, PendingExtensionRequest>();
  private readonly sessions = new Map<string, InternalSession>();

  constructor(private readonly options: RelayOptions) {
    this.pairingToken = readOrCreatePairingToken(options.userDataDirectory);
    this.port = options.port ?? RELAY_PORT;
  }

  pairingInfo(): BrowserExtensionPairingInfo {
    return {
      port: this.port,
      pairingToken: this.pairingToken,
      extensionPath: this.options.extensionPath,
      connected: this.extensionSocket?.readyState === WebSocket.OPEN,
    };
  }

  async internalWebSocketEndpoint(): Promise<string> {
    await this.start();
    return `ws://127.0.0.1:${this.port}/devtools/browser/mixdog?token=${this.internalToken}`;
  }

  start(): Promise<void> {
    if (this.startPromise) return this.startPromise;
    this.startPromise = new Promise<void>((resolve, reject) => {
      const server = createServer((_request, response) => {
        response.writeHead(200, {
          'Cache-Control': 'no-store',
          'Content-Type': 'text/plain; charset=utf-8',
        });
        response.end('Mixdog Browser Extension Relay');
      });
      this.server = server;
      server.on('upgrade', (request, socket, head) => {
        this.upgrade(request, socket, head);
      });
      server.once('error', (error) => {
        this.startPromise = null;
        this.server = null;
        reject(new Error(`Could not start the Chrome extension relay on 127.0.0.1:${this.port}: ${errorMessage(error)}`));
      });
      server.listen(this.port, '127.0.0.1', () => {
        const address = server.address();
        if (address && typeof address === 'object') this.port = address.port;
        server.removeAllListeners('error');
        server.on('error', () => {});
        resolve();
      });
    });
    return this.startPromise;
  }

  async stop(): Promise<void> {
    this.startPromise = null;
    if (this.keepalive) clearInterval(this.keepalive);
    this.keepalive = null;
    this.extensionSocket?.close(1001, 'Mixdog stopped');
    this.extensionSocket = null;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error('Chrome extension relay stopped'));
    }
    this.pending.clear();
    this.sessions.clear();
    for (const socket of this.websocketServer.clients) socket.close(1001, 'Mixdog stopped');
    const server = this.server;
    this.server = null;
    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }

  private upgrade(
    request: IncomingMessage,
    socket: import('node:stream').Duplex,
    head: Buffer,
  ): void {
    let url: URL;
    try {
      url = new URL(request.url || '/', `http://${request.headers.host || '127.0.0.1'}`);
    } catch {
      socket.destroy();
      return;
    }
    const token = url.searchParams.get('token') || '';
    const origin = String(request.headers.origin || '');
    const extensionRequest = url.pathname === '/extension'
      && /^chrome-extension:\/\/[a-z]{32}$/i.test(origin)
      && sameSecret(token, this.pairingToken);
    const internalRequest = url.pathname === '/devtools/browser/mixdog'
      && !origin
      && sameSecret(token, this.internalToken);
    if (!extensionRequest && !internalRequest) {
      socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    this.websocketServer.handleUpgrade(request, socket, head, (websocket) => {
      if (extensionRequest) this.attachExtension(websocket);
      else this.attachInternalClient(websocket);
    });
  }

  private attachExtension(socket: WebSocket): void {
    this.extensionSocket?.close(4000, 'A newer Mixdog extension connection replaced this one');
    this.extensionSocket = socket;
    socket.on('message', (data) => this.handleExtensionMessage(data));
    socket.once('close', () => {
      if (this.extensionSocket !== socket) return;
      this.extensionSocket = null;
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(new Error('Mixdog Chrome extension disconnected'));
      }
      this.pending.clear();
      for (const session of this.sessions.values()) {
        session.socket.close(1011, 'Mixdog Chrome extension disconnected');
      }
      this.sessions.clear();
    });
    socket.send(JSON.stringify({ type: 'ready', protocolVersion: 1 }));
    if (this.keepalive) clearInterval(this.keepalive);
    this.keepalive = setInterval(() => {
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: 'ping', at: Date.now() }));
      }
    }, KEEPALIVE_MS);
    this.keepalive.unref?.();
  }

  private attachInternalClient(socket: WebSocket): void {
    socket.on('message', (data) => {
      void this.handleInternalMessage(socket, data);
    });
    socket.once('close', () => {
      for (const [sessionId, session] of this.sessions) {
        if (session.socket !== socket) continue;
        this.sessions.delete(sessionId);
        void this.extensionRequest('detachTarget', { targetId: session.targetId }).catch(() => {});
      }
    });
  }

  private async handleInternalMessage(socket: WebSocket, data: RawData): Promise<void> {
    const message = safeJson(data);
    if (!message || !Number.isInteger(message.id) || typeof message.method !== 'string') {
      socket.close(1008, 'Invalid CDP message');
      return;
    }
    const id = message.id as number;
    try {
      const result = await this.dispatchInternal(
        socket,
        String(message.method),
        record(message.params),
        typeof message.sessionId === 'string' ? message.sessionId : '',
      );
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ id, result }));
      }
    } catch (error) {
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({
          id,
          error: { code: -32_000, message: errorMessage(error) },
        }));
      }
    }
  }

  private async dispatchInternal(
    socket: WebSocket,
    method: string,
    params: Record<string, unknown>,
    sessionId: string,
  ): Promise<unknown> {
    if (method === 'Target.getTargets') {
      return await this.extensionRequest('listTargets', {});
    }
    if (method === 'Target.attachToTarget') {
      const targetId = String(params.targetId || '');
      if (!targetId) throw new Error('Target id is required');
      await this.extensionRequest('attachTarget', { targetId });
      const createdSessionId = `mixdog-extension-${randomBytes(12).toString('hex')}`;
      this.sessions.set(createdSessionId, { socket, targetId });
      return { sessionId: createdSessionId };
    }
    if (method === 'Target.detachFromTarget') {
      const detachedSessionId = String(params.sessionId || sessionId);
      const session = this.sessions.get(detachedSessionId);
      if (session) {
        this.sessions.delete(detachedSessionId);
        await this.extensionRequest('detachTarget', { targetId: session.targetId });
      }
      return {};
    }
    const session = this.sessions.get(sessionId);
    if (!session || session.socket !== socket) {
      throw new Error('The selected Chrome tab session is no longer allowed');
    }
    return await this.extensionRequest('cdp', {
      targetId: session.targetId,
      method,
      params,
    });
  }

  private handleExtensionMessage(data: RawData): void {
    const message = safeJson(data);
    if (!message) return;
    if (message.type === 'response') {
      const requestId = String(message.requestId || '');
      const pending = this.pending.get(requestId);
      if (!pending) return;
      this.pending.delete(requestId);
      clearTimeout(pending.timer);
      if (message.error) pending.reject(new Error(errorMessage(message.error)));
      else pending.resolve(message.result);
      return;
    }
    if (message.type !== 'event') return;
    const targetId = String(message.targetId || '');
    const method = String(message.method || '');
    if (!targetId || !method) return;
    for (const [sessionId, session] of this.sessions) {
      if (session.targetId !== targetId || session.socket.readyState !== WebSocket.OPEN) continue;
      session.socket.send(JSON.stringify({
        method,
        params: record(message.params),
        sessionId,
      }));
    }
  }

  private extensionRequest(action: string, payload: Record<string, unknown>): Promise<unknown> {
    const socket = this.extensionSocket;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      throw new Error(
        'Mixdog Chrome extension is not connected. Load the extension, enter the pairing token, and allow a tab.',
      );
    }
    const requestId = `relay-${++this.nextRequestId}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error(`Chrome extension request timed out: ${action}`));
      }, REQUEST_TIMEOUT_MS);
      timer.unref?.();
      this.pending.set(requestId, { resolve, reject, timer });
      socket.send(JSON.stringify({ type: 'request', requestId, action, ...payload }));
    });
  }
}

export function createBrowserExtensionRelay(options: RelayOptions): BrowserExtensionRelay {
  return new BrowserExtensionRelay(options);
}
