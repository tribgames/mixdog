/**
 * Loopback command server behind the runtime's read-only `terminal` tool.
 * Same shape as the browser bridge: publishes its port/token through the shared
 * bridge discovery file and keeps ownership of that file, reclaiming it from a
 * dead foreign writer on the next heartbeat.
 */
import { randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

import { createBridgeDiscovery } from '../bridge/discovery-file';
import {
  bridgeDiscoveryPublicIdentity,
  createBridgeDiscoveryRecord,
  sameBridgeDiscovery,
  type BridgeDiscoveryRecord,
} from '../bridge/discovery-ownership';

const DISCOVERY_FILE = 'terminal-bridge.json';
const HEARTBEAT_MS = 60_000;
const DEFAULT_MAX_REQUEST_BYTES = 16 * 1024;
const DEFAULT_MAX_CONCURRENT_REQUESTS = 8;
const MAX_CONNECTIONS = 16;

interface TerminalBridgeServerOptions<TCommand extends object> {
  execute(command: TCommand, signal: AbortSignal): Promise<unknown>;
  onReady?(): void;
  onInactive?(): void;
  /** Where the discovery file is published; never defaulted so an isolated
   *  profile or a test cannot claim the shared data directory by omission. */
  dataDirectory: string | (() => string);
  maxRequestBytes?: number;
  maxConcurrentRequests?: number;
  heartbeatMs?: number;
}

export class TerminalBridgeServer<TCommand extends object> {
  private readonly controllers = new Set<AbortController>();
  private readonly discovery;
  private server: Server | null = null;
  private heartbeat: NodeJS.Timeout | null = null;
  private generation = 0;
  private wantRunning = false;
  private lifecycle = 0;
  private record: BridgeDiscoveryRecord | null = null;
  private token = '';

  constructor(private readonly options: TerminalBridgeServerOptions<TCommand>) {
    const { dataDirectory } = options;
    this.discovery = createBridgeDiscovery({
      fileName: DISCOVERY_FILE,
      dataDirectory: typeof dataDirectory === 'function' ? dataDirectory : () => dataDirectory,
    });
  }

  private respond(response: ServerResponse, status: number, body: unknown): void {
    this.discovery.respond(response, status, body);
  }

  private handleHealth(response: ServerResponse, authorization: string, generation: number): void {
    if (authorization !== `Bearer ${this.token}`) {
      this.respond(response, 401, { ok: false, error: 'unauthorized' });
      return;
    }
    const identity = this.record;
    if (!identity || identity.generation !== generation) {
      this.respond(response, 503, { ok: false, error: 'bridge generation is not active' });
      return;
    }
    this.respond(response, 200, { ok: true, identity: bridgeDiscoveryPublicIdentity(identity) });
  }

  private async handleCommand(request: IncomingMessage, response: ServerResponse): Promise<void> {
    let command: TCommand;
    try {
      command = JSON.parse(await this.readRequestBody(request)) as TCommand;
    } catch (error) {
      this.respond(response, 400, { ok: false, error: `invalid request: ${(error as Error).message}` });
      return;
    }
    const maxConcurrentRequests = Math.max(
      1,
      Math.trunc(this.options.maxConcurrentRequests || DEFAULT_MAX_CONCURRENT_REQUESTS)
    );
    if (this.controllers.size >= maxConcurrentRequests) {
      this.respond(response, 429, { ok: false, error: 'too many concurrent terminal commands' });
      return;
    }
    const controller = new AbortController();
    this.controllers.add(controller);
    const abort = () => controller.abort(new Error('terminal bridge client disconnected'));
    request.once('aborted', abort);
    response.once('close', () => {
      if (!response.writableEnded) abort();
    });
    try {
      const value = await this.options.execute(command, controller.signal);
      if (controller.signal.aborted || response.destroyed) return;
      this.respond(response, 200, { ok: true, value });
    } catch (error) {
      if (controller.signal.aborted || response.destroyed) return;
      this.respond(response, 200, { ok: false, error: (error as Error).message || String(error) });
    } finally {
      request.removeListener('aborted', abort);
      this.controllers.delete(controller);
    }
  }

  private async readRequestBody(request: IncomingMessage): Promise<string> {
    const maxBytes = this.options.maxRequestBytes || DEFAULT_MAX_REQUEST_BYTES;
    return await new Promise<string>((resolve, reject) => {
      const chunks: Buffer[] = [];
      let bytes = 0;
      request.on('data', (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > maxBytes) {
          reject(new Error('request too large'));
          request.destroy();
          return;
        }
        chunks.push(chunk);
      });
      request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      request.on('error', reject);
    });
  }

  private clearHeartbeat(): void {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
  }

  private deactivate(): void {
    this.clearHeartbeat();
    const record = this.record;
    this.record = null;
    if (record) this.discovery.removeDiscovery(record);
    this.options.onInactive?.();
  }

  /** One heartbeat: keep the file fresh while it is ours, reclaim it from a
   *  dead foreign writer, and restart when our own endpoint has vanished. */
  private async maintain(record: BridgeDiscoveryRecord, server: Server): Promise<void> {
    const status = await this.discovery.heartbeatDiscovery(record);
    if (this.server !== server || !sameBridgeDiscovery(this.record, record)) return;
    if (status === 'lost') {
      console.warn('terminal bridge endpoint lost; restarting');
      const lifecycle = this.lifecycle;
      await this.stop(true);
      if (this.wantRunning && this.lifecycle === lifecycle) this.start(true);
    } else if (status === 'occupied') {
      console.warn('terminal bridge discovery is held by another live bridge');
    }
  }

  /** `internal` restarts leave the desired state and lifecycle untouched. */
  start(internal = false): void {
    if (!internal) {
      this.wantRunning = true;
      this.lifecycle += 1;
    }
    if (this.server) return;
    this.generation += 1;
    const generation = this.generation;
    const startedAt = Date.now();
    this.token = randomBytes(24).toString('base64url');
    const server = createServer((request, response) => {
      void (async () => {
        const authorization = String(request.headers.authorization || '');
        if (request.method === 'GET' && request.url === '/health') {
          this.handleHealth(response, authorization, generation);
          return;
        }
        if (request.method !== 'POST' || request.url !== '/command') {
          this.respond(response, 404, { ok: false, error: 'not found' });
          return;
        }
        if (authorization !== `Bearer ${this.token}`) {
          this.respond(response, 401, { ok: false, error: 'unauthorized' });
          return;
        }
        await this.handleCommand(request, response);
      })().catch(() => {
        try {
          response.destroy();
        } catch {
          /* already gone */
        }
      });
    });
    server.maxConnections = MAX_CONNECTIONS;
    server.headersTimeout = 10_000;
    server.requestTimeout = 30_000;
    server.keepAliveTimeout = 5_000;
    this.server = server;
    server.once('error', (error) => {
      console.error('terminal bridge server failed:', error.message);
      if (this.server === server) this.server = null;
      this.deactivate();
    });
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = address && typeof address === 'object' ? address.port : 0;
      if (!port || this.server !== server) return;
      const record = createBridgeDiscoveryRecord({ port, token: this.token, generation, startedAt });
      this.record = record;
      void this.discovery
        .writeDiscovery(record)
        .then((ownership) => {
          if (this.server !== server || !sameBridgeDiscovery(this.record, record)) return;
          if (ownership !== 'owned') {
            console.warn(`terminal bridge discovery ${ownership}; heartbeat will retry`);
          }
          this.heartbeat = setInterval(() => {
            void this.maintain(record, server).catch((error) => {
              console.error('terminal bridge discovery heartbeat failed:', error);
            });
          }, this.options.heartbeatMs || HEARTBEAT_MS);
          this.heartbeat.unref?.();
          this.options.onReady?.();
        })
        .catch((error) => {
          console.error('terminal bridge discovery write failed:', error);
        });
    });
  }

  async stop(internal = false): Promise<void> {
    if (!internal) {
      this.wantRunning = false;
      this.lifecycle += 1;
    }
    for (const controller of this.controllers) {
      controller.abort(new Error('terminal bridge stopped'));
    }
    this.controllers.clear();
    this.deactivate();
    const closing = this.server;
    this.server = null;
    await new Promise<void>((resolve) => {
      if (!closing) {
        resolve();
        return;
      }
      closing.close(() => resolve());
      closing.closeAllConnections?.();
    });
  }
}
