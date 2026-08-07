import { randomUUID } from 'node:crypto';

import {
  engineDaemonClientModuleUrl,
} from './backend-support';
import type {
  DesktopBackendInbound,
  DesktopBackendOutbound,
} from './desktop-backend-protocol';
import type {
  BackendTransport,
} from './desktop-backend-client';

interface AttachedDaemon {
  call(
    name: string,
    args?: Record<string, unknown>,
    options?: { timeoutMs?: number; callId?: string },
  ): Promise<unknown>;
  close(reason?: string): Promise<void>;
}

interface EngineDaemonClient {
  ensureEngineDaemon(options?: {
    cwd?: string;
    log?: (line: string) => void;
  }): Promise<Record<string, unknown>>;
  attachEngineDaemon(options: {
    discovery: Record<string, unknown>;
    cwd?: string;
    onFrame?: (frame: Record<string, unknown>) => void;
    onFatal?: (reason: string) => void;
    onStreamDisconnect?: (details: Record<string, unknown>) => void;
    onStreamReconnect?: (details: Record<string, unknown>) => void;
    log?: (line: string) => void;
  }): Promise<AttachedDaemon>;
}

type EngineDaemonClientLoader = (
  options: Extract<DesktopBackendInbound, { kind: 'init' }>['options'],
) => Promise<EngineDaemonClient>;

function isTransientConnectionReset(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const record = error as Record<string, unknown>;
  const code = String(record.code || '').toUpperCase();
  const message = error instanceof Error ? error.message : String(error);
  return code === 'ECONNRESET'
    || code === 'EPIPE'
    || /socket hang up|read ECONNRESET|write EPIPE/i.test(message);
}

function desktopDaemonCompatibilityError(error: unknown): Error {
  if (!error || typeof error !== 'object'
    || (error as Record<string, unknown>).daemonNewerThanClient !== true) {
    return error instanceof Error ? error : new Error(String(error));
  }
  const cause = error instanceof Error ? error : new Error(String(error));
  return new Error(
    'A newer Mixdog backend is already running. Update this desktop app, or close every '
      + 'Mixdog window and terminal before reopening it.',
    { cause },
  );
}

/** Desktop backend client transport backed by the singleton daemon. */
export class DaemonEngineTransport implements BackendTransport {
  private readonly listeners = new Map<string, Set<(...args: any[]) => void>>();
  private readonly requestedDesktopId = `desktop_${process.pid}_${randomUUID().replaceAll('-', '')}`;
  private desktopId = this.requestedDesktopId;
  private client: AttachedDaemon | null = null;
  private initializing: Promise<void> | null = null;
  private closePromise: Promise<void> | null = null;
  private streamResync: Promise<void> | null = null;
  private closed = false;

  constructor(
    private readonly moduleUrl: string,
    private readonly cwd = process.cwd(),
    private readonly loadClientModule: EngineDaemonClientLoader | null = null,
  ) {}

  on(event: string, listener: (...args: any[]) => void): unknown {
    let bucket = this.listeners.get(event);
    if (!bucket) {
      bucket = new Set();
      this.listeners.set(event, bucket);
    }
    bucket.add(listener);
    return this;
  }

  private emit(event: string, ...args: unknown[]): void {
    for (const listener of this.listeners.get(event) ?? []) {
      try { listener(...args); } catch { /* host listener owns its diagnostics */ }
    }
  }

  postMessage(message: DesktopBackendInbound): void {
    if (this.closed) throw new Error('Mixdog daemon transport is closed.');
    if (message.kind === 'init') {
      void this.initialize(message).catch((error) => this.fail(error));
      return;
    }
    if (message.kind === 'request') {
      void this.request(message);
      return;
    }
    if (message.kind === 'notify') {
      void this.notify(message).catch(() => {
        // A lost keystroke is not worth tearing the transport down; the next
        // one (or the terminal's own redraw) carries on.
      });
      return;
    }
    void this.control(message).catch((error) => this.fail(error));
  }

  private async initialize(
    message: Extract<DesktopBackendInbound, { kind: 'init' }>,
  ): Promise<void> {
    if (this.initializing) return this.initializing;
    this.initializing = (async () => {
      const daemonModule = this.loadClientModule
        ? await this.loadClientModule(message.options)
        : await import(
          /* @vite-ignore */ engineDaemonClientModuleUrl(
            message.options.packaged,
            message.options.resourcesPath,
            message.options.appPath,
          )
        ) as EngineDaemonClient;
      let discovery: Record<string, unknown>;
      try {
        discovery = await daemonModule.ensureEngineDaemon({
          cwd: this.cwd,
          log: (line) => this.emit('error', 'daemon', line),
        });
      } catch (error) {
        throw desktopDaemonCompatibilityError(error);
      }
      const client = await daemonModule.attachEngineDaemon({
        discovery,
        cwd: this.cwd,
        onFrame: (frame) => {
          if (frame?.type !== 'desktop-event') return;
          if (String(frame.desktopId || '') !== this.desktopId) return;
          const outbound = frame.message as DesktopBackendOutbound;
          if (outbound && typeof outbound === 'object') this.emit('message', outbound);
        },
        onFatal: (reason) => this.fail(new Error(`Mixdog backend daemon disconnected: ${reason}`)),
        onStreamDisconnect: (details) => {
          this.emit('diagnostic', 'backend-stream-reconnecting', details);
        },
        onStreamReconnect: (details) => {
          this.emit('diagnostic', 'backend-stream-reconnected', details);
          void this.resyncAfterStreamReconnect(details);
        },
      });
      if (this.closed) {
        await client.close('desktop transport closed during init');
        return;
      }
      this.client = client;
      const initialized = await client.call('desktop.init', {
        desktopId: this.requestedDesktopId,
        moduleUrl: this.moduleUrl,
        options: message.options,
      }) as { desktopId?: unknown };
      this.desktopId = String(initialized?.desktopId || this.requestedDesktopId);
      await client.call('desktop.control', {
        desktopId: this.desktopId,
        message: { kind: 'state-resync' },
      });
      this.emit('message', { kind: 'ready' } satisfies DesktopBackendOutbound);
    })();
    try {
      await this.initializing;
    } finally {
      this.initializing = null;
    }
  }

  private resyncAfterStreamReconnect(details: Record<string, unknown>): Promise<void> {
    if (this.streamResync) return this.streamResync;
    const client = this.client;
    if (!client || this.closed) return Promise.resolve();
    this.streamResync = (async () => {
      let lastError: unknown = null;
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        if (this.closed || client !== this.client) return;
        try {
          await client.call('desktop.control', {
            desktopId: this.desktopId,
            message: { kind: 'state-resync' },
          });
          this.emit('diagnostic', 'backend-stream-resync-complete', {
            ...details,
            attempt,
          });
          return;
        } catch (error) {
          lastError = error;
          if (attempt < 3) {
            await new Promise((resolve) => setTimeout(resolve, attempt * 100));
          }
        }
      }
      const record = lastError && typeof lastError === 'object'
        ? lastError as Record<string, unknown>
        : null;
      this.emit('diagnostic', 'backend-stream-resync-failed', {
        ...details,
        errorName: lastError instanceof Error ? lastError.name : typeof lastError,
        ...(typeof record?.code === 'string' ? { code: record.code } : {}),
      });
    })().finally(() => {
      this.streamResync = null;
    });
    return this.streamResync;
  }

  private async request(
    message: Extract<DesktopBackendInbound, { kind: 'request' }>,
  ): Promise<void> {
    try {
      if (this.initializing) await this.initializing;
      if (!this.client) throw new Error('Mixdog backend daemon is not initialized.');
      const args = {
        desktopId: this.desktopId,
        method: message.method,
        args: message.args,
      };
      const callId = `desktop-invoke:${this.requestedDesktopId}:${message.id}`;
      let value: unknown;
      try {
        value = await this.client.call('desktop.invoke', args, { callId });
      } catch (error) {
        // A pooled loopback socket can be reset while the daemon itself stays
        // healthy (notably during adapter handoff). Retry the exact logical
        // request once under the same call id: the daemon's idempotency cache
        // returns the original result if it already committed.
        if (!isTransientConnectionReset(error)) throw error;
        value = await this.client.call('desktop.invoke', args, { callId });
      }
      this.emit('message', {
        kind: 'response',
        id: message.id,
        ok: true,
        value: value ?? null,
      } satisfies DesktopBackendOutbound);
    } catch (error) {
      const record = error && typeof error === 'object'
        ? error as Record<string, unknown>
        : null;
      this.emit('message', {
        kind: 'response',
        id: message.id,
        ok: false,
        error: {
          name: error instanceof Error ? error.name : typeof error,
          message: error instanceof Error ? error.message : String(error),
          ...(typeof record?.code === 'string' ? { code: record.code } : {}),
        },
      } satisfies DesktopBackendOutbound);
    }
  }

  private async control(message: DesktopBackendInbound): Promise<void> {
    if (this.initializing) await this.initializing;
    if (!this.client) return;
    await this.client.call('desktop.control', {
      desktopId: this.desktopId,
      message,
    });
  }

  /** Same daemon route as `request`, without the response frame. */
  private async notify(
    message: Extract<DesktopBackendInbound, { kind: 'notify' }>,
  ): Promise<void> {
    if (this.initializing) await this.initializing;
    if (!this.client) return;
    await this.client.call('desktop.invoke', {
      desktopId: this.desktopId,
      method: message.method,
      args: message.args,
    });
  }

  private fail(error: unknown): void {
    if (this.closed) return;
    const failure = error instanceof Error ? error : new Error(String(error));
    this.emit('error', 'daemon', failure.message);
    this.closed = true;
    void this.closeClient('desktop daemon transport failed')
      .finally(() => this.emit('exit', 1, failure));
  }

  private closeClient(reason: string): Promise<void> {
    if (this.closePromise) return this.closePromise;
    const client = this.client;
    this.client = null;
    this.closePromise = (async () => {
      if (!client) return;
      await client.call('desktop.unsubscribe', { desktopId: this.desktopId }, {
        timeoutMs: 1_000,
      }).catch(() => {});
      await client.close(reason).catch(() => {});
    })();
    return this.closePromise;
  }

  async close(): Promise<void> {
    if (!this.closed) this.closed = true;
    await this.closeClient('desktop view closed');
  }
}
