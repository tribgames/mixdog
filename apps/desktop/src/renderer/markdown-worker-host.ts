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

/** Owns only worker lifetime and delivery; cache/fallback policy stays in the
 * client. The parser stays resident. */
export class MarkdownWorkerHost {
  private worker: Worker | null = null;
  private failure: Error | null = null;
  private sequence = 0;
  private readonly pending = new Map<number, PendingMarkdownRequest>();

  constructor(
    private readonly createWorker: () => Worker = () => {
      if (typeof Worker === 'undefined') throw new Error('Markdown Worker is unavailable');
      return new Worker(new URL('./markdown-parser.worker.ts', import.meta.url), {
        type: 'module',
        name: 'mixdog-markdown-parser',
      });
    }
  ) {}

  /** False once the worker failed; nothing should be sent speculatively then. */
  get available(): boolean {
    return this.failure === null;
  }

  parse(text: string): Promise<MarkdownAstRoot> {
    return new Promise((resolve, reject) => {
      const worker = this.getWorker();
      const id = ++this.sequence;
      this.pending.set(id, { resolve, reject });
      try {
        worker.postMessage({ id, text });
      } catch (error) {
        this.pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  private fail(worker: Worker, error: Error): void {
    // Events already queued by a failed worker are ignored after it retires.
    if (this.worker !== worker) return;
    this.failure = error;
    this.worker = null;
    worker.terminate();
    for (const request of this.pending.values()) request.reject(error);
    this.pending.clear();
  }

  private getWorker(): Worker {
    if (this.worker) return this.worker;
    if (this.failure) throw this.failure;
    const worker = this.createWorker();
    this.worker = worker;
    worker.addEventListener('message', (event: MessageEvent<MarkdownWorkerResponse>) => {
      if (this.worker !== worker) return;
      const id = Number(event.data?.id);
      const request = this.pending.get(id);
      if (!request) return;
      this.pending.delete(id);
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
