// Main-process proxy over the terminal utility process. Structurally matches
// the TerminalManager surface consumed by ipc.ts / remote-methods.ts, so the
// in-main backend (MIXDOG_TERMINAL_PROCESS=main) and this out-of-process
// backend are interchangeable at every call site.
import {
  terminalMessageData,
  type TerminalSpawnProfile,
  type TerminalWorkerInbound,
  type TerminalWorkerOutbound,
} from './terminal-worker-protocol';

export interface TerminalWorkerTransport {
  postMessage(message: TerminalWorkerInbound): void;
  kill(): boolean;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  on(event: string, listener: (...args: any[]) => void): unknown;
}

interface PendingEnsure {
  resolve(value: { id: string; replay: string }): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

const ENSURE_TIMEOUT_MS = 15_000;
const DISPOSE_KILL_DELAY_MS = 750;

export class TerminalHost {
  private readonly listeners = new Set<(event: { id: string; data: string }) => void>();
  private readonly pendingEnsures = new Map<number, PendingEnsure>();
  private child: TerminalWorkerTransport | null = null;
  private nextRequestId = 1;
  private spawnCount = 0;
  private disposed = false;

  constructor(private readonly spawnWorker: () => TerminalWorkerTransport) {}

  get workerSpawnCount(): number {
    return this.spawnCount;
  }

  subscribe(listener: (event: { id: string; data: string }) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private ensureChild(): TerminalWorkerTransport {
    if (this.child) return this.child;
    const child = this.spawnWorker();
    this.child = child;
    this.spawnCount += 1;
    child.on('message', (event: unknown) => {
      if (child !== this.child) return;
      this.handleMessage(event);
    });
    child.on('exit', () => {
      if (child !== this.child) return;
      // The worker took every PTY with it. Reject in-flight ensures; the next
      // ensure() lazily respawns a fresh worker (renderer reattach path).
      this.child = null;
      this.rejectPending(new Error('Mixdog terminal worker exited.'));
    });
    return child;
  }

  private handleMessage(event: unknown): void {
    const value = terminalMessageData(event);
    if (!value || typeof value !== 'object') return;
    const message = value as TerminalWorkerOutbound;
    if (message.kind === 'data') {
      for (const listener of this.listeners) {
        listener({ id: String(message.id || ''), data: String(message.data ?? '') });
      }
      return;
    }
    if (message.kind !== 'ensure-result') return;
    const pending = this.pendingEnsures.get(message.requestId);
    if (!pending) return;
    this.pendingEnsures.delete(message.requestId);
    clearTimeout(pending.timer);
    if (message.ok) pending.resolve(message.value);
    else pending.reject(new Error(message.error || 'Terminal worker request failed.'));
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pendingEnsures.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pendingEnsures.clear();
  }

  async ensure(
    id: string | null,
    cwd: string | null,
    profile?: TerminalSpawnProfile | null,
  ): Promise<{ id: string; replay: string }> {
    if (this.disposed) throw new Error('Terminal host is disposed.');
    const child = this.ensureChild();
    const requestId = this.nextRequestId++;
    return await new Promise<{ id: string; replay: string }>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingEnsures.delete(requestId);
        reject(new Error('Terminal worker did not answer in time.'));
      }, ENSURE_TIMEOUT_MS);
      timer.unref?.();
      this.pendingEnsures.set(requestId, { resolve, reject, timer });
      try {
        child.postMessage({ kind: 'ensure', requestId, id, cwd, ...(profile ? { profile } : {}) });
      } catch (error) {
        clearTimeout(timer);
        this.pendingEnsures.delete(requestId);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  private post(message: TerminalWorkerInbound): void {
    // Fire-and-forget lanes never spawn a worker: writing to a terminal that
    // no longer exists is a no-op, exactly like the in-main Map miss.
    if (this.disposed || !this.child) return;
    try {
      this.child.postMessage(message);
    } catch { /* worker exit handler owns cleanup */ }
  }

  write(id: string, data: string): void {
    this.post({ kind: 'write', id, data });
  }

  resize(id: string, cols: number, rows: number): void {
    this.post({ kind: 'resize', id, cols, rows });
  }

  pauseOutput(id: string): void {
    this.post({ kind: 'pause', id });
  }

  resumeOutput(id: string): void {
    this.post({ kind: 'resume', id });
  }

  dispose(id: string): void {
    this.post({ kind: 'dispose', id });
  }

  disposeAll(): void {
    this.disposed = true;
    const child = this.child;
    this.child = null;
    this.rejectPending(new Error('Terminal host is disposed.'));
    this.listeners.clear();
    if (!child) return;
    // Graceful first (worker kills its PTY tree, then exits), bounded by a
    // hard kill so quit never waits on a wedged worker.
    try {
      child.postMessage({ kind: 'dispose-all' });
    } catch {
      try { child.kill(); } catch { /* already gone */ }
      return;
    }
    const killTimer = setTimeout(() => {
      try { child.kill(); } catch { /* already exited */ }
    }, DISPOSE_KILL_DELAY_MS);
    killTimer.unref?.();
  }
}
