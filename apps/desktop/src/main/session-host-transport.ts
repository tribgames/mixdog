import { randomUUID } from 'node:crypto';

import type { SessionSnapshot } from '../shared/contract';
import { DESKTOP_READ_CAPABILITIES } from '../shared/contract';
import { reportTranscriptRead } from '../shared/transcript-read-diagnostics';
import { TRANSCRIPT_READ_TIMEOUT_MS } from '../shared/transcript-read-policy';
import { isSessionId } from './desktop-state';
import { longRunningRequestTimeout } from './local-provider-install-timeout';
import type { TranscriptWindowRequest } from './session-transcript-windows';

export interface SessionCallOptions {
  callId?: string;
  timeoutMs?: number;
}

export interface SessionClient {
  list(args?: Record<string, unknown>, options?: SessionCallOptions): Promise<Record<string, unknown>>;
  create(args?: Record<string, unknown>, options?: SessionCallOptions): Promise<Record<string, unknown>>;
  read(args?: Record<string, unknown>, options?: SessionCallOptions): Promise<Record<string, unknown>>;
  subscribe(args?: Record<string, unknown>, options?: SessionCallOptions): Promise<Record<string, unknown>>;
  unsubscribe(args?: Record<string, unknown>, options?: SessionCallOptions): Promise<Record<string, unknown>>;
  submit(args?: Record<string, unknown>, options?: SessionCallOptions): Promise<Record<string, unknown>>;
  abort(args?: Record<string, unknown>, options?: SessionCallOptions): Promise<Record<string, unknown>>;
  approve(args?: Record<string, unknown>, options?: SessionCallOptions): Promise<Record<string, unknown>>;
  configure(args?: Record<string, unknown>, options?: SessionCallOptions): Promise<Record<string, unknown>>;
  close(reason?: string): Promise<void>;
}

export interface SessionHostProjection {
  revision: number;
  projectionStamp?: string;
}

export interface SessionHostTransportOwner {
  isDisposed(): boolean;
  taskWorkspace(): Promise<string>;
  openHints(sessionId: string): Record<string, unknown>;
  /** The transcript window this read asks for (see SessionTranscriptWindows). */
  transcriptWindow(sessionId: string): TranscriptWindowRequest;
  projection(sessionId: string): SessionHostProjection | undefined;
  applySessionResult(
    sessionId: string,
    value: Record<string, unknown> | null | undefined,
    publish?: boolean
  ): SessionSnapshot;
  deleteProjection(sessionId: string): void;
}

const READ_CAPABILITIES = new Set<string>(DESKTOP_READ_CAPABILITIES);

export function sessionIdOf(value: unknown): string {
  const id = String(value || '');
  if (!isSessionId(id)) throw new TypeError('session id is invalid.');
  return id;
}

export class SessionHostTransport {
  private controlSessionIdValue = '';
  private controlSessionPromise: Promise<string> | null = null;

  constructor(
    readonly client: SessionClient,
    private readonly owner: SessionHostTransportOwner
  ) {}

  get controlSessionId(): string {
    return this.controlSessionIdValue;
  }

  setControlSessionId(sessionId: string): void {
    this.controlSessionIdValue = sessionId;
  }

  callOptions(callId: string = randomUUID(), timeoutMs?: number): SessionCallOptions {
    if (this.owner.isDisposed()) throw new Error('Mixdog service host is disposed.');
    return { callId, ...(timeoutMs ? { timeoutMs } : {}) };
  }

  async readSession(
    sessionId: string,
    forceFull = false,
    publish = true,
    readTraceId?: string
  ): Promise<SessionSnapshot> {
    const id = sessionIdOf(sessionId);
    const prior = this.owner.projection(id);
    const startedAt = performance.now();
    reportTranscriptRead(id, readTraceId, 'host-read-start');
    const result = await this.client.read(
      {
        sessionId: id,
        open: this.owner.openHints(id),
        ...this.owner.transcriptWindow(id),
        baseRevision: forceFull ? null : (prior?.revision ?? null),
        ...(!forceFull && prior?.projectionStamp ? { baseProjectionStamp: prior.projectionStamp } : {}),
      },
      this.callOptions(undefined, TRANSCRIPT_READ_TIMEOUT_MS)
    );
    reportTranscriptRead(id, readTraceId, 'host-read-result', {
      durationMs: performance.now() - startedAt,
    });
    const current = this.owner.projection(id);
    const hasFull = result.full !== null && typeof result.full === 'object';
    const hasBaseline =
      current &&
      (result.patch ? Number(result.baseRevision) === current.revision : Number(result.revision) === current.revision);
    if (!hasFull && !hasBaseline) {
      if (forceFull) throw new Error('Session recovery returned no usable baseline.');
      return this.readSession(id, true, publish, readTraceId);
    }
    return this.owner.applySessionResult(id, result, publish);
  }

  async invokeSession(
    sessionId: string,
    method: string,
    args: unknown[] = []
  ): Promise<{ value: unknown; snapshot: SessionSnapshot; result: Record<string, unknown> }> {
    const id = sessionIdOf(sessionId);
    const prior = this.owner.projection(id);
    const params = {
      sessionId: id,
      action: method,
      args,
      open: this.owner.openHints(id),
      baseRevision: prior?.revision ?? null,
    };
    const callOptions = this.callOptions(randomUUID(), longRunningRequestTimeout(method, args));
    const result = READ_CAPABILITIES.has(method)
      ? await this.client.read(params, callOptions)
      : await this.client.configure(params, callOptions);
    const current = this.owner.projection(id);
    // A stream publication may have advanced the baseline while configure
    // awaited its reply. Recover the resulting state, never replay the command
    // or acknowledge a successful selection with the old cached values.
    const needsFull =
      result.patch &&
      !Object.hasOwn(result, 'full') &&
      (!current || (Number(result.revision) > current.revision && Number(result.baseRevision) !== current.revision));
    return {
      value: result.value,
      snapshot: needsFull ? await this.readSession(id, true) : this.owner.applySessionResult(id, result),
      result,
    };
  }

  async ensureControlSession(): Promise<string> {
    if (this.controlSessionIdValue) return this.controlSessionIdValue;
    if (this.controlSessionPromise) return this.controlSessionPromise;
    const pending = (async () => {
      const result = await this.client.create(
        {
          cwd: await this.owner.taskWorkspace(),
          desktopSession: null,
        },
        this.callOptions(`service-control-create:${process.pid}:${randomUUID()}`)
      );
      const sessionId = sessionIdOf(result.sessionId);
      this.controlSessionIdValue = sessionId;
      this.owner.applySessionResult(sessionId, result, false);
      return sessionId;
    })();
    this.controlSessionPromise = pending;
    try {
      return await pending;
    } finally {
      if (this.controlSessionPromise === pending) this.controlSessionPromise = null;
    }
  }

  async invokeControlResult(
    method: string,
    args: unknown[] = []
  ): Promise<{ value: unknown; snapshot: SessionSnapshot; result: Record<string, unknown> }> {
    const replayable = READ_CAPABILITIES.has(method);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const sessionId = await this.ensureControlSession();
      try {
        const params = {
          sessionId,
          action: method,
          args,
          open: { cwd: await this.owner.taskWorkspace(), desktopSession: null },
          baseRevision: this.owner.projection(sessionId)?.revision ?? null,
        };
        const callOptions = this.callOptions(randomUUID(), longRunningRequestTimeout(method, args));
        const result = READ_CAPABILITIES.has(method)
          ? await this.client.read(params, callOptions)
          : await this.client.configure(params, callOptions);
        return {
          value: result.value,
          snapshot: this.owner.applySessionResult(sessionId, result, false),
          result,
        };
      } catch (error) {
        this.owner.deleteProjection(sessionId);
        this.controlSessionIdValue = '';
        // Reads are safe to replay after a stale control session. A mutation
        // may already have committed before its reply failed (as with the MCP
        // durable-address error), so replaying it can duplicate side effects.
        if (!replayable || attempt > 0) throw error;
      }
    }
    throw new Error('Service control session is unavailable.');
  }

  async invokeControl(method: string, args: unknown[] = []): Promise<unknown> {
    return (await this.invokeControlResult(method, args)).value;
  }

  close(reason?: string): Promise<void> {
    return this.client.close(reason);
  }
}
