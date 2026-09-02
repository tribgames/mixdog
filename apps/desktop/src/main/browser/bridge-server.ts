import { randomBytes } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { homedir } from 'node:os';
import { join } from 'node:path';

const DISCOVERY_FILE = 'browser-bridge.json';
const DISCOVERY_VERSION = 1;
const HEARTBEAT_MS = 60_000;
const DEFAULT_MAX_REQUEST_BYTES = 256 * 1024;
const DEFAULT_MAX_CONCURRENT_REQUESTS = 32;
const MAX_CONNECTIONS = 64;

export function mixdogDataDirectory(): string {
  return process.env.MIXDOG_DATA_DIR
    || join(process.env.MIXDOG_HOME || join(homedir(), '.mixdog'), 'data');
}

export interface BrowserBridgeServerOptions<TCommand extends object> {
  execute(command: TCommand, signal: AbortSignal): Promise<unknown>;
  redactError(value: string): string;
  onReady?(): void;
  onInactive?(): void;
  dataDirectory?: string;
  maxRequestBytes?: number;
  maxConcurrentRequests?: number;
}

export class BrowserBridgeServer<TCommand extends object> {
  private readonly token = randomBytes(24).toString('base64url');
  private readonly controllers = new Set<AbortController>();
  private server: Server | null = null;
  private heartbeat: NodeJS.Timeout | null = null;
  private discoveryPath: string | null = null;

  constructor(private readonly options: BrowserBridgeServerOptions<TCommand>) {}

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

  private respond(response: ServerResponse, status: number, body: unknown): void {
    const payload = JSON.stringify(body);
    response.writeHead(status, {
      'content-type': 'application/json',
      'content-length': Buffer.byteLength(payload),
    });
    response.end(payload);
  }

  private writeDiscovery(port: number): void {
    const directory = this.options.dataDirectory || mixdogDataDirectory();
    mkdirSync(directory, { recursive: true });
    this.discoveryPath = join(directory, DISCOVERY_FILE);
    writeFileSync(this.discoveryPath, `${JSON.stringify({
      version: DISCOVERY_VERSION,
      port,
      token: this.token,
      pid: process.pid,
      startedAt: Date.now(),
    })}\n`);
    try {
      chmodSync(this.discoveryPath, 0o600);
    } catch { /* Windows ACLs: the per-user data dir is already private */ }
  }

  private heartbeatDiscovery(port: number): void {
    if (!this.discoveryPath) return;
    try {
      const now = new Date();
      utimesSync(this.discoveryPath, now, now);
    } catch {
      try {
        this.writeDiscovery(port);
      } catch { /* data dir gone mid-shutdown */ }
    }
  }

  private removeOwnDiscovery(): void {
    if (!this.discoveryPath) return;
    try {
      const current = JSON.parse(readFileSync(this.discoveryPath, 'utf8')) as { token?: string };
      if (current?.token === this.token) unlinkSync(this.discoveryPath);
    } catch { /* replaced or already gone */ }
    this.discoveryPath = null;
  }

  private deactivate(): void {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
    this.removeOwnDiscovery();
    this.options.onInactive?.();
  }

  start(): void {
    if (this.server) return;
    const server = createServer((request, response) => {
      void (async () => {
        if (request.method !== 'POST' || request.url !== '/command') {
          this.respond(response, 404, { ok: false, error: 'not found' });
          return;
        }
        if (String(request.headers.authorization || '') !== `Bearer ${this.token}`) {
          this.respond(response, 401, { ok: false, error: 'unauthorized' });
          return;
        }
        let command: TCommand;
        try {
          command = JSON.parse(await this.readRequestBody(request)) as TCommand;
        } catch (error) {
          this.respond(response, 400, { ok: false, error: `invalid request: ${(error as Error).message}` });
          return;
        }
        const maxConcurrentRequests = Math.max(
          1,
          Math.trunc(this.options.maxConcurrentRequests || DEFAULT_MAX_CONCURRENT_REQUESTS),
        );
        if (this.controllers.size >= maxConcurrentRequests) {
          this.respond(response, 429, { ok: false, error: 'too many concurrent browser commands' });
          return;
        }
        const controller = new AbortController();
        this.controllers.add(controller);
        const abort = () => controller.abort(new Error('browser bridge client disconnected'));
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
          this.respond(response, 200, {
            ok: false,
            error: this.options.redactError((error as Error).message || String(error)),
          });
        } finally {
          request.removeListener('aborted', abort);
          this.controllers.delete(controller);
        }
      })().catch(() => {
        try {
          response.destroy();
        } catch { /* already gone */ }
      });
    });
    server.maxConnections = MAX_CONNECTIONS;
    server.headersTimeout = 10_000;
    server.requestTimeout = 30_000;
    server.keepAliveTimeout = 5_000;
    this.server = server;
    server.once('error', (error) => {
      console.error('browser bridge server failed:', this.options.redactError(error.message));
      if (this.server === server) this.server = null;
      this.deactivate();
    });
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = address && typeof address === 'object' ? address.port : 0;
      if (!port || this.server !== server) return;
      try {
        this.writeDiscovery(port);
        this.heartbeat = setInterval(() => this.heartbeatDiscovery(port), HEARTBEAT_MS);
        this.heartbeat.unref?.();
        this.options.onReady?.();
      } catch (error) {
        console.error('browser bridge discovery write failed:', error);
      }
    });
  }

  async stop(): Promise<void> {
    for (const controller of this.controllers) {
      controller.abort(new Error('browser bridge stopped'));
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
