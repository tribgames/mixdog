import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';

import {
  sessionClientModuleUrl,
} from './desktop-support';
import type {
  DesktopServiceInbound,
  DesktopServiceOutbound,
} from './desktop-service-protocol';
import type {
  DesktopTransport,
} from './desktop-service-client';

interface AttachedDaemon {
  call(
    name: string,
    args?: Record<string, unknown>,
    options?: { timeoutMs?: number; callId?: string },
  ): Promise<unknown>;
  close(reason?: string): Promise<void>;
}

interface SessionClientModule {
  ensureDaemon(options?: {
    cwd?: string;
    log?: (line: string) => void;
  }): Promise<Record<string, unknown>>;
  attachSession(options: {
    discovery: Record<string, unknown>;
    cwd?: string;
    clientKind?: 'desktop' | 'session';
    onFrame?: (frame: Record<string, unknown>) => void;
    onFatal?: (reason: string) => void;
    onStreamDisconnect?: (details: Record<string, unknown>) => void;
    onStreamReconnect?: (details: Record<string, unknown>) => void;
    log?: (line: string) => void;
  }): Promise<AttachedDaemon>;
}

type SessionClientLoader = (
  options: Extract<DesktopServiceInbound, { kind: 'init' }>['options'],
) => Promise<SessionClientModule>;
type DesktopInitOptions = Extract<DesktopServiceInbound, { kind: 'init' }>['options'];

function isTransientConnectionReset(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const record = error as Record<string, unknown>;
  const code = String(record.code || '').toUpperCase();
  const message = error instanceof Error ? error.message : String(error);
  return code === 'ECONNRESET'
    || code === 'EPIPE'
    || /socket hang up|read ECONNRESET|write EPIPE/i.test(message);
}

function isDaemonTransportFailure(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const record = error as Record<string, unknown>;
  const code = String(record.code || '').toUpperCase();
  const message = error instanceof Error ? error.message : String(error);
  return record.daemonTransportError === true
    || ['ECONNREFUSED', 'ECONNRESET', 'EPIPE', 'ETIMEDOUT'].includes(code)
    || /socket hang up|ECONNREFUSED|ECONNRESET|EPIPE|daemon (?:exited|replaced)/i.test(message);
}

function desktopSessionProtocolError(error: unknown): Error {
  if (!error || typeof error !== 'object'
    || (error as Record<string, unknown>).sessionProtocolMismatch !== true) {
    return error instanceof Error ? error : new Error(String(error));
  }
  const cause = error instanceof Error ? error : new Error(String(error));
  return new Error(
    'A different Mixdog session contract is already running. Close every Mixdog window and '
      + 'terminal before reopening the current build.',
    { cause },
  );
}

/** Desktop service client transport connected to the singleton daemon. */
export class SessionTransport implements DesktopTransport {
  private readonly listeners = new Map<string, Set<(...args: any[]) => void>>();
  private readonly requestedDesktopId = `desktop_${process.pid}_${randomUUID().replaceAll('-', '')}`;
  private desktopId = this.requestedDesktopId;
  private client: AttachedDaemon | null = null;
  private daemonModule: SessionClientModule | null = null;
  private initOptions: DesktopInitOptions | null = null;
  private initializing: Promise<void> | null = null;
  private recovering: Promise<void> | null = null;
  private closePromise: Promise<void> | null = null;
  private streamResync: Promise<void> | null = null;
  private closed = false;
  private readonly bootStartedAt = performance.now();
  private connectAttempt = 0;

  constructor(
    private readonly moduleUrl: string,
    private readonly cwd = process.cwd(),
    private readonly loadClientModule: SessionClientLoader | null = null,
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

  private async measureBootPhase<T>(
    phase: string,
    task: () => Promise<T>,
    details: Record<string, unknown> = {},
  ): Promise<T> {
    const startedAt = performance.now();
    this.emit('diagnostic', 'desktop-boot-phase', {
      phase,
      status: 'start',
      totalMs: Math.round((startedAt - this.bootStartedAt) * 10) / 10,
      ...details,
    });
    try {
      const result = await task();
      const endedAt = performance.now();
      this.emit('diagnostic', 'desktop-boot-phase', {
        phase,
        status: 'ready',
        durationMs: Math.round((endedAt - startedAt) * 10) / 10,
        totalMs: Math.round((endedAt - this.bootStartedAt) * 10) / 10,
        ...details,
      });
      return result;
    } catch (error) {
      const endedAt = performance.now();
      this.emit('diagnostic', 'desktop-boot-phase', {
        phase,
        status: 'failed',
        durationMs: Math.round((endedAt - startedAt) * 10) / 10,
        totalMs: Math.round((endedAt - this.bootStartedAt) * 10) / 10,
        errorName: error instanceof Error ? error.name : typeof error,
        ...details,
      });
      throw error;
    }
  }

  postMessage(message: DesktopServiceInbound): void {
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
    message: Extract<DesktopServiceInbound, { kind: 'init' }>,
  ): Promise<void> {
    if (this.initializing) return this.initializing;
    this.initializing = (async () => {
      const daemonModule = await this.measureBootPhase('session-client-import', async () => (
        this.loadClientModule
          ? await this.loadClientModule(message.options)
          : await import(
            /* @vite-ignore */ sessionClientModuleUrl(
              message.options.packaged,
              message.options.resourcesPath,
              message.options.appPath,
            )
          ) as SessionClientModule
      ));
      this.daemonModule = daemonModule;
      this.initOptions = message.options;
      await this.connectDaemon(daemonModule, message.options);
      this.emit('diagnostic', 'desktop-boot-phase', {
        phase: 'transport-ready',
        status: 'ready',
        totalMs: Math.round((performance.now() - this.bootStartedAt) * 10) / 10,
        attempt: this.connectAttempt,
      });
      this.emit('message', { kind: 'ready' } satisfies DesktopServiceOutbound);
    })();
    try {
      await this.initializing;
    } finally {
      this.initializing = null;
    }
  }

  private async connectDaemon(
    daemonModule: SessionClientModule,
    options: DesktopInitOptions,
  ): Promise<AttachedDaemon> {
    const attempt = ++this.connectAttempt;
    let discovery: Record<string, unknown>;
    try {
      discovery = await this.measureBootPhase(
        'ensure-daemon',
        () => daemonModule.ensureDaemon({
          cwd: this.cwd,
          log: (line) => this.emit('error', 'daemon', line),
        }),
        { attempt },
      );
    } catch (error) {
      throw desktopSessionProtocolError(error);
    }
    let attached: AttachedDaemon | null = null;
    let fatalDuringAttach = '';
    try {
      attached = await this.measureBootPhase(
        'attach-session',
        () => daemonModule.attachSession({
          discovery,
          cwd: this.cwd,
          clientKind: 'desktop',
          onFrame: (frame) => {
            if (frame?.type !== 'desktop-event') return;
            if (String(frame.desktopId || '') !== this.desktopId) return;
            const outbound = frame.message as DesktopServiceOutbound;
            if (outbound && typeof outbound === 'object') this.emit('message', outbound);
          },
          onFatal: (reason) => {
            if (!attached) {
              fatalDuringAttach = reason;
              return;
            }
            void this.recoverDaemon(attached, reason).catch(() => {});
          },
          onStreamDisconnect: (details) => {
            this.emit('diagnostic', 'session-stream-reconnecting', details);
          },
          onStreamReconnect: (details) => {
            this.emit('diagnostic', 'session-stream-reconnected', details);
            void this.resyncAfterStreamReconnect(details);
          },
        }),
        { attempt },
      );
      if (fatalDuringAttach) {
        throw new Error(`Mixdog daemon disconnected during attach: ${fatalDuringAttach}`);
      }
      if (this.closed) {
        await attached.close('desktop transport closed during init');
        throw new Error('Mixdog daemon transport is closed.');
      }
      const initialized = await this.measureBootPhase(
        'desktop-init',
        () => attached!.call('desktop.init', {
          desktopId: this.requestedDesktopId,
          moduleUrl: this.moduleUrl,
          options,
        }) as Promise<{ desktopId?: unknown }>,
        { attempt },
      );
      this.desktopId = String(initialized?.desktopId || this.requestedDesktopId);
      await this.measureBootPhase(
        'desktop-state-resync',
        () => attached!.call('desktop.control', {
          desktopId: this.desktopId,
          message: { kind: 'state-resync' },
        }),
        { attempt },
      );
      await this.measureBootPhase(
        'desktop-background-ready',
        () => attached!.call('desktop.ready', {
          desktopId: this.desktopId,
        }),
        { attempt },
      );
      this.client = attached;
      return attached;
    } catch (error) {
      await attached?.call('desktop.unsubscribe', {
        desktopId: this.desktopId,
      }, {
        timeoutMs: 1_000,
      }).catch(() => {});
      await attached?.close('desktop daemon attach failed').catch(() => {});
      throw error;
    }
  }

  private recoverDaemon(failedClient: AttachedDaemon, reason: string): Promise<void> {
    if (this.recovering) return this.recovering;
    if (this.closed || this.client !== failedClient) return Promise.resolve();
    const daemonModule = this.daemonModule;
    const options = this.initOptions;
    if (!daemonModule || !options) {
      return Promise.reject(new Error('Mixdog daemon recovery is not initialized.'));
    }
    this.client = null;
    const previous = {
      reason,
      oldPid: Number((failedClient as AttachedDaemon & { pid?: number }).pid) || 0,
      oldPort: Number((failedClient as AttachedDaemon & { port?: number }).port) || 0,
    };
    this.emit('diagnostic', 'session-daemon-reconnecting', previous);
    const recovery = (async () => {
      await failedClient.close('desktop daemon replaced').catch(() => {});
      const next = await this.connectDaemon(daemonModule, options);
      this.emit('diagnostic', 'session-daemon-reconnected', {
        ...previous,
        newPid: Number((next as AttachedDaemon & { pid?: number }).pid) || 0,
        newPort: Number((next as AttachedDaemon & { port?: number }).port) || 0,
      });
      // Reattaching restores the CALLS, not the services the old daemon ran.
      // Its relay leg died with the process, and a diagnostic is read by
      // nobody who could redial it, so the replacement is announced on the
      // message lane instead. Without this the phone stays dark until the
      // app is restarted.
      this.emit('message', { kind: 'daemon-replaced' } satisfies DesktopServiceOutbound);
    })();
    this.recovering = recovery;
    void recovery.catch((error) => this.fail(error)).finally(() => {
      if (this.recovering === recovery) this.recovering = null;
    });
    return recovery;
  }

  private async activeClient(): Promise<AttachedDaemon> {
    if (this.initializing) await this.initializing;
    if (this.recovering) await this.recovering;
    if (!this.client) throw new Error('Mixdog daemon is not initialized.');
    return this.client;
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
          this.emit('diagnostic', 'session-stream-resync-complete', {
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
      this.emit('diagnostic', 'session-stream-resync-failed', {
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
    message: Extract<DesktopServiceInbound, { kind: 'request' }>,
  ): Promise<void> {
    try {
      let client = await this.activeClient();
      const args = {
        desktopId: this.desktopId,
        method: message.method,
        args: message.args,
      };
      const callId = `desktop-invoke:${this.requestedDesktopId}:${message.id}`;
      let value: unknown;
      try {
        value = await client.call('desktop.invoke', args, { callId });
      } catch (error) {
        // A pooled loopback socket can be reset while the daemon itself stays
        // healthy (notably during adapter handoff). Retry the exact logical
        // request once under the same call id: the daemon's idempotency cache
        // returns the original result if it already committed.
        let failure = error;
        if (isTransientConnectionReset(error)) {
          try {
            value = await client.call('desktop.invoke', args, { callId });
            failure = null;
          } catch (retryError) {
            failure = retryError;
          }
        }
        if (failure) {
          if (!isDaemonTransportFailure(failure)) throw failure;
          await this.recoverDaemon(
            client,
            failure instanceof Error ? failure.message : String(failure),
          );
          client = await this.activeClient();
          value = await client.call('desktop.invoke', args, { callId });
        }
      }
      this.emit('message', {
        kind: 'response',
        id: message.id,
        ok: true,
        value: value ?? null,
      } satisfies DesktopServiceOutbound);
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
      } satisfies DesktopServiceOutbound);
    }
  }

  private async control(message: DesktopServiceInbound): Promise<void> {
    const client = await this.activeClient();
    await client.call('desktop.control', {
      desktopId: this.desktopId,
      message,
    });
  }

  /** Same daemon route as `request`, without the response frame. */
  private async notify(
    message: Extract<DesktopServiceInbound, { kind: 'notify' }>,
  ): Promise<void> {
    const client = await this.activeClient();
    await client.call('desktop.invoke', {
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
    this.closePromise = (async () => {
      await this.recovering?.catch(() => {});
      const client = this.client;
      this.client = null;
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
