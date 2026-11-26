import type { MarkdownAstRoot } from './markdown-ast';
import { rememberMarkdownAstWeight } from './markdown-ast-weight';

interface MarkdownWorkerResponse {
  id: number;
  root?: MarkdownAstRoot;
  retainedChars?: number;
  error?: string;
}

interface PendingMarkdownRequest {
  resolve(root: MarkdownAstRoot): void;
  reject(error: Error): void;
}

const DEFAULT_IDLE_TIMEOUT_MS = 0;

/** Owns only worker lifetime and delivery; cache/fallback policy stays in the
 * client. Spawns lazily on first parse and stays warm during active use;
 * callers reclaim it via `terminateIdle()` or an explicit `idleTimeoutMs`. */
export class MarkdownWorkerHost {
  private worker: Worker | null = null;
  private failure: Error | null = null;
  private sequence = 0;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly pending = new Map<number, PendingMarkdownRequest>();

  constructor(
    private readonly createWorker: () => Worker = () => {
      if (typeof Worker === 'undefined') throw new Error('Markdown Worker is unavailable');
      return new Worker(new URL('./markdown-parser.worker.ts', import.meta.url), {
        type: 'module',
        name: 'mixdog-markdown-parser',
      });
    },
    private readonly idleTimeoutMs: number = DEFAULT_IDLE_TIMEOUT_MS
  ) {}

  /** False once the worker failed; nothing should be sent speculatively then. */
  get available(): boolean {
    return this.failure === null;
  }

  /** True while a worker instance is currently alive. */
  get active(): boolean {
    return this.worker !== null;
  }

  parse(text: string): Promise<MarkdownAstRoot> {
    this.clearIdleTimer();
    return new Promise((resolve, reject) => {
      const worker = this.getWorker();
      const id = ++this.sequence;
      this.pending.set(id, { resolve, reject });
      try {
        worker.postMessage({ id, text });
      } catch (error) {
        this.pending.delete(id);
        this.armIdleTimer();
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  /** Terminates the worker when no parse is in flight without marking it failed. */
  terminateIdle(): boolean {
    if (!this.worker || this.pending.size > 0) return false;
    this.clearIdleTimer();
    const worker = this.worker;
    this.worker = null;
    worker.terminate();
    return true;
  }

  private clearIdleTimer(): void {
    if (this.idleTimer !== null) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }

  private armIdleTimer(): void {
    this.clearIdleTimer();
    if (!this.worker || this.pending.size > 0 || this.idleTimeoutMs <= 0) return;
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      this.terminateIdle();
    }, this.idleTimeoutMs);
    if (typeof this.idleTimer === 'object' && this.idleTimer !== null && 'unref' in this.idleTimer) {
      (this.idleTimer as { unref(): void }).unref();
    }
  }

  private fail(worker: Worker, error: Error): void {
    // Events already queued by a failed worker are ignored after it retires.
    if (this.worker !== worker) return;
    this.clearIdleTimer();
    this.failure = error;
    this.worker = null;
    worker.terminate();
    for (const request of this.pending.values()) request.reject(error);
    this.pending.clear();
  }

  private getWorker(): Worker {
    if (this.worker) return this.worker;
    if (this.failure) throw this.failure;
    let worker: Worker;
    try {
      worker = this.createWorker();
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error));
      this.failure = failure;
      throw failure;
    }
    this.worker = worker;
    worker.addEventListener('message', (event: MessageEvent<MarkdownWorkerResponse>) => {
      if (this.worker !== worker) return;
      const id = Number(event.data?.id);
      const request = this.pending.get(id);
      if (!request) return;
      this.pending.delete(id);
      if (this.pending.size === 0) this.armIdleTimer();
      if (event.data.error || !event.data.root) {
        request.reject(new Error(event.data.error || 'Markdown Worker returned no AST'));
      } else {
        rememberMarkdownAstWeight(event.data.root, event.data.retainedChars);
        request.resolve(event.data.root);
      }
    });
    worker.addEventListener('error', (event) => {
      // Suppress the duplicate window error; the client recovers via its
      // renderer parser and a broken bootstrap is never retried in a loop.
      event.preventDefault?.();
      this.fail(worker, new Error(event.message || 'Markdown Worker failed'));
    });
    worker.addEventListener('messageerror', (event) => {
      event.preventDefault?.();
      this.fail(worker, new Error('Markdown Worker returned an unreadable response'));
    });
    return worker;
  }
}
