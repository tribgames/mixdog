import type {
  DesktopAbortOptions,
  DesktopAgentPoolRow,
  DesktopCapability,
  DesktopCapabilityReadRequest,
  DesktopCapabilityReadResult,
  DesktopCapabilityResult,
  DesktopModelCatalogOptions,
  DesktopModelOption,
  DesktopModelSelection,
  DesktopNewTaskDraft,
  DesktopNewTaskSubmitResult,
  DesktopProjectSummary,
  DesktopPromptContent,
  DesktopSessionSummary,
  DesktopSessionStateUpdate,
  DesktopSubmitOptions,
  EngineSnapshot,
  ToolApprovalDecision,
} from '../shared/contract';
import type {
  DesktopBackend,
  DesktopBackendMethod,
  SerializableDesktopBackendOptions,
} from './backend-api';
import type {
  DesktopBackendInbound,
  DesktopBackendOutbound,
} from './desktop-backend-protocol';
import { createSnapshotDeltaDecoder, releaseHiddenSessionStateEntries } from './state-delta';

export interface BackendTransport {
  postMessage(message: DesktopBackendInbound): void;
  close(): Promise<void>;
  on(event: string, listener: (...args: any[]) => void): unknown;
}

export interface DesktopBackendClientOptions {
  connect(): BackendTransport;
  engineOptions(): SerializableDesktopBackendOptions;
  initialSnapshot?: EngineSnapshot;
  requestTimeoutMs?: number;
  startupTimeoutMs?: number;
  restartBaseDelayMs?: number;
  restartMaxDelayMs?: number;
  restartStableMs?: number;
  failureNoticeDelayMs?: number;
  onDiagnostic?(event: string, data: Record<string, unknown>): void;
}

interface PendingRequest {
  method: DesktopBackendMethod;
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

const DEFAULT_REQUEST_TIMEOUT_MS = 120_000;
const DEFAULT_STARTUP_TIMEOUT_MS = 15_000;
const DEFAULT_RESTART_BASE_DELAY_MS = 250;
const DEFAULT_RESTART_MAX_DELAY_MS = 5_000;
const DEFAULT_RESTART_STABLE_MS = 30_000;
const DEFAULT_FAILURE_NOTICE_DELAY_MS = 10_000;
const PROCESS_FAILURE_TOAST_ID = 'backend-connection-stopped';

function displayExitCode(code: number): string {
  if (
    process.platform === 'win32'
    && Number.isSafeInteger(code)
    && code >= 0x80000000
    && code <= 0xffffffff
  ) {
    return `0x${code.toString(16).padStart(8, '0').toUpperCase()}`;
  }
  return String(code);
}

class BackendTransportExitError extends Error {
  constructor(readonly exitCode: number, cause?: Error) {
    super(cause?.message || `Mixdog backend transport exited with code ${displayExitCode(exitCode)}.`);
    this.name = 'BackendTransportExitError';
    if (cause) this.cause = cause;
  }
}

function responseError(error: { name: string; message: string; code?: string }): Error {
  const result = new Error(error.message);
  result.name = error.name || 'Error';
  if (error.code) (result as NodeJS.ErrnoException).code = error.code;
  return result;
}

export class DesktopBackendClient implements DesktopBackend {
  private readonly listeners = new Set<(snapshot: EngineSnapshot) => void>();
  private readonly sessionListeners = new Set<(sessions: DesktopSessionSummary[]) => void>();
  private readonly agentPoolListeners = new Set<(agents: DesktopAgentPoolRow[]) => void>();
  private readonly backendEventListeners = new Set<
    (event: { name: string; value: unknown }) => void
  >();
  private readonly sessionStateListeners = new Set<(update: DesktopSessionStateUpdate) => void>();
  private readonly sessionStateDecoders = new Map<string, ReturnType<typeof createSnapshotDeltaDecoder>>();
  private readonly pending = new Map<number, PendingRequest>();
  private readonly decoder = createSnapshotDeltaDecoder();
  private transport: BackendTransport | null = null;
  private cachedSnapshot: EngineSnapshot;
  private bootstrapSnapshot: EngineSnapshot;
  private cachedSessions: DesktopSessionSummary[] | null = null;
  private cachedAgentPool: DesktopAgentPoolRow[] | null = null;
  private activeSessionId = '';
  private sessionCacheFresh = false;
  private agentPoolCacheFresh = false;
  private visibleSessionIds: string[] = [];
  private nextRequestId = 1;
  private generation = 0;
  private lastExitError: Error | null = null;
  private readyPromise: Promise<void> | null = null;
  private readyResolve: (() => void) | null = null;
  private readyReject: ((error: Error) => void) | null = null;
  private startupTimer: ReturnType<typeof setTimeout> | null = null;
  private restartTimer: ReturnType<typeof setTimeout> | null = null;
  private stableTimer: ReturnType<typeof setTimeout> | null = null;
  private failureNoticeTimer: ReturnType<typeof setTimeout> | null = null;
  private consecutiveExitCount = 0;
  private nextRestartAt = 0;
  private disposing = false;
  private disposed = false;
  private recovering = false;

  constructor(private readonly options: DesktopBackendClientOptions) {
    this.cachedSnapshot = options.initialSnapshot ?? null;
    this.bootstrapSnapshot = options.initialSnapshot ?? null;
  }

  start(): Promise<void> {
    if (this.disposed || this.disposing) {
      return Promise.reject(new Error('Mixdog desktop backend client is disposed.'));
    }
    if (this.readyPromise) return this.readyPromise;
    this.readyPromise = new Promise<void>((resolve, reject) => {
      this.readyResolve = resolve;
      this.readyReject = reject;
    });
    const readyPromise = this.readyPromise;
    const restartDelayMs = Math.max(0, this.nextRestartAt - Date.now());
    if (restartDelayMs > 0) {
      this.restartTimer = setTimeout(() => {
        this.restartTimer = null;
        this.connectBackend();
      }, restartDelayMs);
      this.restartTimer.unref?.();
    } else {
      this.connectBackend();
    }
    return readyPromise;
  }

  private connectBackend(): void {
    if (this.disposed || this.disposing) {
      this.rejectStartup(new Error('Mixdog desktop backend client is disposed.'));
      return;
    }
    let transport: BackendTransport;
    try {
      transport = this.options.connect();
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error));
      this.rejectStartup(failure);
      return;
    }
    this.transport = transport;
    this.generation += 1;
    transport.on('message', (message: unknown) => this.handleMessage(transport, message));
    transport.on('error', (type: unknown, location: unknown) => {
      this.options.onDiagnostic?.('backend-transport-error', {
        type: String(type || ''),
        location: String(location || ''),
      });
    });
    transport.on('diagnostic', (event: unknown, details: unknown) => {
      this.options.onDiagnostic?.(
        String(event || 'backend-transport-diagnostic'),
        details && typeof details === 'object'
          ? details as Record<string, unknown>
          : {},
      );
    });
    transport.on('exit', (code: unknown, cause: unknown) => this.handleExit(
      transport,
      Number(code) || 0,
      cause instanceof Error ? cause : undefined,
    ));
    this.startupTimer = setTimeout(() => {
      if (transport !== this.transport || !this.readyReject) return;
      const error = new Error('Mixdog backend startup timed out.');
      this.rejectStartup(error);
      void transport.close().catch(() => {});
    }, this.options.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS);
    this.startupTimer.unref?.();
    try {
      transport.postMessage({ kind: 'init', options: this.options.engineOptions() });
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error));
      this.rejectStartup(failure);
      void transport.close().catch(() => {});
    }
  }

  getSnapshot(): EngineSnapshot {
    return this.cachedSnapshot;
  }

  subscribe(listener: (snapshot: EngineSnapshot) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  subscribeSessions(listener: (sessions: DesktopSessionSummary[]) => void): () => void {
    this.sessionListeners.add(listener);
    return () => this.sessionListeners.delete(listener);
  }

  subscribeAgentPool(listener: (agents: DesktopAgentPoolRow[]) => void): () => void {
    this.agentPoolListeners.add(listener);
    return () => this.agentPoolListeners.delete(listener);
  }

  subscribeSessionStates(listener: (update: DesktopSessionStateUpdate) => void): () => void {
    this.sessionStateListeners.add(listener);
    return () => this.sessionStateListeners.delete(listener);
  }

  subscribeBackendEvents(listener: (event: { name: string; value: unknown }) => void): () => void {
    this.backendEventListeners.add(listener);
    return () => this.backendEventListeners.delete(listener);
  }

  private handleMessage(transport: BackendTransport, value: unknown): void {
    if (transport !== this.transport || !value || typeof value !== 'object') return;
    const message = value as DesktopBackendOutbound;
    if (message.kind === 'ready') {
      if (this.startupTimer) clearTimeout(this.startupTimer);
      this.startupTimer = null;
      this.nextRestartAt = 0;
      if (this.stableTimer) clearTimeout(this.stableTimer);
      this.stableTimer = setTimeout(() => {
        this.stableTimer = null;
        this.consecutiveExitCount = 0;
      }, this.options.restartStableMs ?? DEFAULT_RESTART_STABLE_MS);
      this.stableTimer.unref?.();
      const resolve = this.readyResolve;
      this.readyResolve = null;
      this.readyReject = null;
      resolve?.();
      if (this.visibleSessionIds.length > 0) {
        void this.sendRequest<boolean>('setVisibleSessions', [this.visibleSessionIds])
          .catch(() => { /* renderer registration remains cached for the next restart */ });
      }
      return;
    }
    if (message.kind === 'state') {
      const decoded = this.decoder.decode(message.wire);
      if (!decoded.ok) {
        transport.postMessage({ kind: 'state-resync' });
        return;
      }
      const snapshot = decoded.snapshot as EngineSnapshot;
      try {
        if (this.recovering) {
          this.recovering = false;
          this.clearFailureNoticeTimer();
          this.publish(this.recoveredSnapshot(snapshot));
        } else {
          this.publish(snapshot);
        }
      } finally {
        // Acknowledge only after decode/publication. The transport keeps at most
        // one frame in flight and collapses any intermediate publications.
        try {
          transport.postMessage({ kind: 'state-ack', sequence: message.sequence });
        } catch {
          // Backend reconnect owns the failed transport.
        }
      }
      return;
    }
    if (message.kind === 'sessions') {
      const sessions = Array.isArray(message.sessions) ? message.sessions.slice() : [];
      this.cachedSessions = sessions;
      this.sessionCacheFresh = true;
      const projected = sessions.map((session) => ({
        ...session,
        currentSession: session.id === this.activeSessionId,
      }));
      for (const listener of this.sessionListeners) listener(projected);
      return;
    }
    if (message.kind === 'agent-pool') {
      const agents = Array.isArray(message.agents) ? message.agents.slice() : [];
      this.cachedAgentPool = agents;
      this.agentPoolCacheFresh = true;
      for (const listener of this.agentPoolListeners) listener(agents.slice());
      return;
    }
    if (message.kind === 'backend-event') {
      const event = { name: String(message.name || ''), value: message.value };
      if (!event.name) return;
      for (const listener of this.backendEventListeners) listener(event);
      return;
    }
    if (message.kind === 'session-state') {
      const sessionId = String(message.sessionId || '');
      if (!sessionId) return;
      let decoder = this.sessionStateDecoders.get(sessionId);
      if (decoder) this.sessionStateDecoders.delete(sessionId);
      else decoder = createSnapshotDeltaDecoder();
      this.sessionStateDecoders.set(sessionId, decoder);
      const decoded = decoder.decode(message.wire);
      if (!decoded.ok) {
        decoder.reset();
        try { transport.postMessage({ kind: 'session-state-resync', sessionId }); } catch {}
        return;
      }
      if (message.wire === null) this.sessionStateDecoders.delete(sessionId);
      const update: DesktopSessionStateUpdate = {
        sessionId,
        snapshot: decoded.snapshot as EngineSnapshot,
        ...(message.frameSource ? { frameSource: message.frameSource } : {}),
        ...(typeof message.contentRevision === 'number'
          ? { contentRevision: message.contentRevision }
          : {}),
      };
      for (const listener of this.sessionStateListeners) listener(update);
      if (sessionId === this.activeSessionId) this.publish(update.snapshot);
      return;
    }
    if (message.kind !== 'response') return;
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    clearTimeout(pending.timer);
    if (message.ok) pending.resolve(message.value);
    else pending.reject(responseError(message.error));
  }

  private handleExit(transport: BackendTransport, code: number, cause?: Error): void {
    if (transport !== this.transport) return;
    this.transport = null;
    this.decoder.reset();
    this.sessionStateDecoders.clear();
    if (this.startupTimer) clearTimeout(this.startupTimer);
    this.startupTimer = null;
    if (this.stableTimer) clearTimeout(this.stableTimer);
    this.stableTimer = null;
    const error = new BackendTransportExitError(code, cause);
    this.lastExitError = error;
    this.readyReject?.(error);
    this.readyResolve = null;
    this.readyReject = null;
    this.readyPromise = null;
    this.rejectPending(error);
    if (this.disposing || this.disposed) return;
    this.consecutiveExitCount += 1;
    const baseDelayMs = Math.max(
      0,
      this.options.restartBaseDelayMs ?? DEFAULT_RESTART_BASE_DELAY_MS,
    );
    const maxDelayMs = Math.max(
      baseDelayMs,
      this.options.restartMaxDelayMs ?? DEFAULT_RESTART_MAX_DELAY_MS,
    );
    const restartDelayMs = Math.min(
      maxDelayMs,
      baseDelayMs * (2 ** Math.min(this.consecutiveExitCount - 1, 10)),
    );
    this.nextRestartAt = Date.now() + restartDelayMs;
    this.options.onDiagnostic?.('backend-transport-exit', {
      code,
      displayCode: displayExitCode(code),
      restartCount: this.consecutiveExitCount,
      restartDelayMs,
    });
    this.scheduleProcessFailure();
    void this.start().catch((restartError) => {
      if (this.disposing || this.disposed) return;
      this.options.onDiagnostic?.('backend-transport-restart-failed', {
        errorName: restartError instanceof Error ? restartError.name : 'Error',
      });
    });
  }

  private rejectStartup(error: Error): void {
    if (this.startupTimer) clearTimeout(this.startupTimer);
    this.startupTimer = null;
    this.readyReject?.(error);
    this.readyResolve = null;
    this.readyReject = null;
    this.readyPromise = null;
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  private publish(snapshot: EngineSnapshot): void {
    const next = this.snapshotWithBootstrap(snapshot);
    this.cachedSnapshot = next;
    for (const listener of this.listeners) listener(next);
  }

  private snapshotWithBootstrap(snapshot: EngineSnapshot): EngineSnapshot {
    const bootstrap = this.bootstrapSnapshot;
    if (!bootstrap || typeof bootstrap !== 'object') return snapshot;
    const state = snapshot && typeof snapshot === 'object'
      ? snapshot as Record<string, unknown>
      : {};
    if (String(state.provider || '').trim() && String(state.model || '').trim()) {
      this.bootstrapSnapshot = null;
      return snapshot;
    }
    // The backend's first route-less frame is transport readiness, not an
    // authoritative model reset. Retain the lightweight persisted route until
    // the live engine publishes its own provider/model pair.
    return { ...bootstrap, ...state } as EngineSnapshot;
  }

  private scheduleProcessFailure(): void {
    this.recovering = true;
    if (this.failureNoticeTimer) return;
    const delayMs = Math.max(
      0,
      this.options.failureNoticeDelayMs ?? DEFAULT_FAILURE_NOTICE_DELAY_MS,
    );
    if (delayMs === 0) {
      this.publish(this.processFailureSnapshot(this.cachedSnapshot));
      return;
    }
    this.failureNoticeTimer = setTimeout(() => {
      this.failureNoticeTimer = null;
      if (!this.recovering || this.disposed || this.disposing) return;
      this.publish(this.processFailureSnapshot(this.cachedSnapshot));
    }, delayMs);
    this.failureNoticeTimer.unref?.();
  }

  private clearFailureNoticeTimer(): void {
    if (this.failureNoticeTimer) clearTimeout(this.failureNoticeTimer);
    this.failureNoticeTimer = null;
  }

  private recoveredSnapshot(snapshot: EngineSnapshot): EngineSnapshot {
    if (!snapshot || typeof snapshot !== 'object') return snapshot;
    const previous = snapshot as Record<string, unknown>;
    const existingToasts = Array.isArray(previous.toasts) ? previous.toasts : [];
    const toasts = existingToasts.filter((toast) => (
      !toast || typeof toast !== 'object'
      || (toast as Record<string, unknown>).id !== PROCESS_FAILURE_TOAST_ID
    ));
    if (toasts.length === existingToasts.length) return snapshot;
    return { ...previous, toasts } as EngineSnapshot;
  }

  private processFailureSnapshot(snapshot: EngineSnapshot): EngineSnapshot {
    const previous = snapshot && typeof snapshot === 'object'
      ? snapshot as Record<string, unknown>
      : {};
    const existingToasts = Array.isArray(previous.toasts) ? previous.toasts : [];
    return {
      ...previous,
      items: Array.isArray(previous.items) ? previous.items : [],
      queued: [],
      busy: false,
      commandBusy: false,
      toasts: [
        ...existingToasts.filter((toast) => (
          !toast || typeof toast !== 'object'
          || (toast as Record<string, unknown>).id !== PROCESS_FAILURE_TOAST_ID
        )),
        {
          id: PROCESS_FAILURE_TOAST_ID,
          tone: 'error',
          text: 'The backend connection stopped. Retrying automatically.',
        },
      ].slice(-8),
    } as EngineSnapshot;
  }

  private async invoke<T>(method: DesktopBackendMethod, args: unknown[] = []): Promise<T> {
    const ready = this.start();
    const generation = this.generation;
    await ready;
    if (generation !== this.generation) {
      throw this.lastExitError
        ?? new Error('Mixdog backend transport changed before the request was sent.');
    }
    return await this.sendRequest<T>(method, args);
  }

  private async invokeRead<T>(method: DesktopBackendMethod, args: unknown[] = []): Promise<T> {
    try {
      return await this.invoke<T>(method, args);
    } catch (error) {
      if (!(error instanceof BackendTransportExitError) || this.disposed || this.disposing) throw error;
      return await this.invoke<T>(method, args);
    }
  }

  private sendRequest<T>(
    method: DesktopBackendMethod,
    args: unknown[],
    timeoutMs = this.options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
  ): Promise<T> {
    const transport = this.transport;
    if (!transport) {
      return Promise.reject(
        this.lastExitError ?? new Error('Mixdog backend is unavailable.'),
      );
    }
    const id = this.nextRequestId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Mixdog engine request timed out: ${method}.`));
      }, timeoutMs);
      this.pending.set(id, {
        method,
        resolve: (value) => resolve(value as T),
        reject,
        timer,
      });
      try {
        transport.postMessage({ kind: 'request', id, method, args });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  async startProject(projectPath: string): Promise<EngineSnapshot> {
    const snapshot = await this.invoke<EngineSnapshot>('startProject', [projectPath]);
    this.activeSessionId = '';
    this.publish(snapshot);
    return snapshot;
  }
  async startProjectTask(projectPath: string): Promise<EngineSnapshot> {
    const snapshot = await this.invoke<EngineSnapshot>('startProjectTask', [projectPath]);
    this.activeSessionId = '';
    this.publish(snapshot);
    return snapshot;
  }
  async startTask(): Promise<EngineSnapshot> {
    const snapshot = await this.invoke<EngineSnapshot>('startTask');
    this.activeSessionId = '';
    this.publish(snapshot);
    return snapshot;
  }
  listProjects(): Promise<DesktopProjectSummary[]> {
    return this.invokeRead('listProjects');
  }
  addProject(projectPath: string): Promise<unknown> {
    return this.invoke('addProject', [projectPath]);
  }
  projectDirectory(projectPath: string): Promise<string> {
    return this.invokeRead('projectDirectory', [projectPath]);
  }
  renameProject(projectPath: string, alias: string): Promise<unknown> {
    return this.invoke('renameProject', [projectPath, alias]);
  }
  removeProject(projectPath: string): Promise<unknown> {
    return this.invoke('removeProject', [projectPath]);
  }
  listProjectDir(projectPath: string, relDir: string): Promise<unknown> {
    return this.invokeRead('listProjectDir', [projectPath, relDir]);
  }
  readProjectTextFile(projectPath: string, relPath: string): Promise<unknown> {
    return this.invokeRead('readProjectTextFile', [projectPath, relPath]);
  }
  writeProjectTextFile(
    projectPath: string,
    relPath: string,
    content: string,
    expectedContent: string,
    encoding?: import('./project-files').ProjectTextEncoding,
  ): Promise<unknown> {
    return this.invoke('writeProjectTextFile', [
      projectPath,
      relPath,
      content,
      expectedContent,
      encoding,
    ]);
  }
  statProjectFile(projectPath: string, relPath: string): Promise<unknown> {
    return this.invokeRead('statProjectFile', [projectPath, relPath]);
  }
  createProjectEntry(
    projectPath: string,
    relDir: string,
    name: string,
    directory: boolean,
  ): Promise<unknown> {
    return this.invoke('createProjectEntry', [projectPath, relDir, name, directory]);
  }
  renameProjectEntry(projectPath: string, relPath: string, newName: string): Promise<unknown> {
    return this.invoke('renameProjectEntry', [projectPath, relPath, newName]);
  }
  moveProjectEntry(projectPath: string, relPath: string, targetDirRel: string): Promise<unknown> {
    return this.invoke('moveProjectEntry', [projectPath, relPath, targetDirRel]);
  }
  copyProjectEntry(projectPath: string, relPath: string, targetDirRel: string): Promise<unknown> {
    return this.invoke('copyProjectEntry', [projectPath, relPath, targetDirRel]);
  }
  projectEntryPath(projectPath: string, relPath: string): Promise<string> {
    return this.invokeRead('projectEntryPath', [projectPath, relPath]);
  }
  codeGraphQuery(
    projectPath: string,
    mode: 'find_symbol' | 'references' | 'symbols',
    query: string,
  ): Promise<unknown> {
    return this.invokeRead('codeGraphQuery', [projectPath, mode, query]);
  }
  async listSessions(): Promise<DesktopSessionSummary[]> {
    await this.start();
    if (this.sessionCacheFresh && this.cachedSessions) {
      this.sessionCacheFresh = false;
      return this.cachedSessions.map((session) => ({
        ...session,
        currentSession: session.id === this.activeSessionId,
      }));
    }
    const sessions = await this.invokeRead<DesktopSessionSummary[]>('listSessions');
    this.cachedSessions = Array.isArray(sessions) ? sessions.slice() : [];
    return this.cachedSessions.map((session) => ({
      ...session,
      currentSession: session.id === this.activeSessionId,
    }));
  }
  async listAgentPool(): Promise<DesktopAgentPoolRow[]> {
    await this.start();
    if (this.agentPoolCacheFresh && this.cachedAgentPool) {
      this.agentPoolCacheFresh = false;
      return this.cachedAgentPool.slice();
    }
    const agents = await this.invokeRead<DesktopAgentPoolRow[]>('listAgentPool');
    this.cachedAgentPool = Array.isArray(agents) ? agents.slice() : [];
    return this.cachedAgentPool.slice();
  }
  renameSession(sessionId: string, title: string): Promise<unknown> {
    return this.invoke('renameSession', [sessionId, title]);
  }
  setSessionArchived(sessionId: string, archived: boolean): Promise<unknown> {
    return this.invoke('setSessionArchived', [sessionId, archived]);
  }
  deleteSession(sessionId: string): Promise<unknown> {
    return this.invoke('deleteSession', [sessionId]);
  }
  prefetchSession(sessionId: string): Promise<boolean> {
    return this.invokeRead('prefetchSession', [sessionId]);
  }
  peekSession(sessionId: string): Promise<boolean> {
    return this.invokeRead('peekSession', [sessionId]);
  }
  setVisibleSessions(sessionIds: string[]): Promise<boolean> {
    this.visibleSessionIds = [...new Set(sessionIds
      .map((value) => String(value || ''))
      .filter((value) => /^[A-Za-z0-9_-]+$/.test(value)))];
    const visible = new Set(this.visibleSessionIds);
    releaseHiddenSessionStateEntries(
      visible,
      [this.sessionStateDecoders],
      (sessionId) => this.sessionStateDecoders.get(sessionId)?.reset(),
    );
    return this.invokeRead('setVisibleSessions', [this.visibleSessionIds]);
  }
  async resumeSession(sessionId: string): Promise<EngineSnapshot> {
    const snapshot = await this.invoke<EngineSnapshot>('resumeSession', [sessionId]);
    this.activeSessionId = String(snapshot?.sessionId || sessionId);
    this.publish(snapshot);
    return snapshot;
  }
  searchProjectFiles(
    projectIdOrWorkspaceId: string,
    query: string,
    limit = 50,
  ): Promise<string[]> {
    return this.invokeRead('searchProjectFiles', [projectIdOrWorkspaceId, query, limit]);
  }
  submit(prompt: DesktopPromptContent, options: DesktopSubmitOptions = {}): Promise<boolean> {
    if (!this.activeSessionId) return Promise.resolve(false);
    return this.submitToSession(this.activeSessionId, prompt, options);
  }
  async submitNewTask(
    prompt: DesktopPromptContent,
    options: DesktopSubmitOptions = {},
    draft: DesktopNewTaskDraft = {},
  ): Promise<DesktopNewTaskSubmitResult> {
    const result = await this.invoke<DesktopNewTaskSubmitResult>(
      'submitNewTask',
      [prompt, options, draft],
    );
    if (result.accepted && result.sessionId) {
      this.activeSessionId = result.sessionId;
      if (result.snapshot) this.publish(result.snapshot);
    }
    return result;
  }
  abort(options: DesktopAbortOptions = {}): Promise<unknown> {
    if (!this.activeSessionId) return Promise.resolve({ aborted: false });
    return this.abortSession(this.activeSessionId, options);
  }
  resolveToolApproval(id: string, decision: ToolApprovalDecision): Promise<boolean> {
    if (!this.activeSessionId) return Promise.resolve(false);
    return this.resolveToolApprovalForSession(this.activeSessionId, id, decision);
  }
  submitToSession(
    sessionId: string,
    prompt: DesktopPromptContent,
    options: DesktopSubmitOptions = {},
  ): Promise<boolean> {
    return this.invoke('submitToSession', [sessionId, prompt, options]);
  }
  abortSession(sessionId: string, options: DesktopAbortOptions = {}): Promise<unknown> {
    return this.invoke('abortSession', [sessionId, options]);
  }
  resolveToolApprovalForSession(
    sessionId: string,
    id: string,
    decision: ToolApprovalDecision,
  ): Promise<boolean> {
    return this.invoke('resolveToolApprovalForSession', [sessionId, id, decision]);
  }
  listProviderModels(options: DesktopModelCatalogOptions = {}): Promise<DesktopModelOption[]> {
    return this.invokeRead('listProviderModels', [options]);
  }
  setModelRoute(selection: DesktopModelSelection, sessionId?: string): Promise<EngineSnapshot> {
    const target = sessionId || this.activeSessionId;
    return this.invoke('setModelRoute', [selection, target || undefined]);
  }
  setFast(enabled: boolean, sessionId?: string): Promise<EngineSnapshot> {
    const target = sessionId || this.activeSessionId;
    return this.invoke('setFast', [enabled, target || undefined]);
  }
  invokeCapability<T = unknown>(
    capability: DesktopCapability,
    args: unknown[] = [],
    sessionId?: string,
  ): Promise<DesktopCapabilityResult<T>> {
    return this.invoke('invokeCapability', [
      capability,
      args,
      sessionId || this.activeSessionId || undefined,
    ]);
  }
  readCapabilities(
    requests: ReadonlyArray<DesktopCapabilityReadRequest>,
  ): Promise<DesktopCapabilityReadResult[]> {
    return this.invokeRead('readCapabilities', [requests]);
  }
  backendInvoke(method: string, args: unknown[] = []): Promise<unknown> {
    return this.invoke('backendInvoke', [method, args]);
  }
  /** Fire-and-forget backend call. Terminal keystrokes/resizes used to open a
   *  pending request (with its 120s timer) per keypress and wait for a reply
   *  behind whatever engine traffic was in flight. */
  backendNotify(method: string, args: unknown[] = []): void {
    const transport = this.transport;
    if (!transport) {
      // Pre-ready (or mid-restart): fall back to the request lane, which waits
      // for the transport instead of dropping the input.
      void this.invoke('backendInvoke', [method, args]).catch(() => { /* input lost */ });
      return;
    }
    try {
      transport.postMessage({ kind: 'notify', method: 'backendInvoke', args: [method, args] });
    } catch { /* the next keystroke re-syncs */ }
  }
  perfLog(line: string): void {
    void this.invoke('perfLog', [line]).catch(() => { /* diagnostics only */ });
  }

  async dispose(): Promise<void> {
    if (this.disposed || this.disposing) return;
    this.disposing = true;
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.restartTimer = null;
    if (this.stableTimer) clearTimeout(this.stableTimer);
    this.stableTimer = null;
    this.clearFailureNoticeTimer();
    const transport = this.transport;
    this.transport = null;
    this.disposed = true;
    const disposedError = new Error('Mixdog desktop backend client is disposed.');
    this.readyReject?.(disposedError);
    this.readyResolve = null;
    this.readyReject = null;
    this.rejectPending(disposedError);
    this.readyPromise = null;
    this.listeners.clear();
    this.sessionListeners.clear();
    this.agentPoolListeners.clear();
    this.backendEventListeners.clear();
    this.sessionStateListeners.clear();
    this.visibleSessionIds = [];
    if (transport) {
      try { await transport.close(); } catch { /* process exit is the fallback */ }
    }
  }
}
