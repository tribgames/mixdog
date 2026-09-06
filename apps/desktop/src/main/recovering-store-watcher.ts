import { watch, type FSWatcher } from 'node:fs';

/** A watcher is a recoverable resource, not proof of a permanent subscription.
 * While it is unavailable, each bounded retry also reconciles the catalog. */
export class RecoveringStoreWatcher {
  private watcher: FSWatcher | null = null;
  private retry: ReturnType<typeof setTimeout> | null = null;
  private delay = 250;
  private closed = false;

  constructor(private readonly options: {
    directory(): string;
    relevant(filename: string | Buffer | null): boolean;
    changed(): void;
    error(error: unknown): void;
    watch?: typeof watch;
  }) {}

  start(): void {
    if (this.closed || this.watcher || this.retry) return;
    try {
      const watcher = (this.options.watch ?? watch)(
        this.options.directory(), { persistent: false }, (_event, filename) => {
          if (this.watcher === watcher && this.options.relevant(filename)) this.options.changed();
        },
      );
      this.watcher = watcher;
      this.delay = 250;
      watcher.on('error', (error) => {
        if (this.watcher !== watcher) return;
        this.watcher = null;
        try { watcher.close(); } catch { /* already closed */ }
        this.recover(error);
      });
    } catch (error) {
      this.recover(error);
    }
  }

  private recover(error: unknown): void {
    if (this.closed || this.retry) return;
    this.options.error(error);
    const delay = this.delay;
    this.delay = Math.min(10_000, delay * 2);
    this.retry = setTimeout(() => {
      this.retry = null;
      if (this.closed) return;
      this.options.changed();
      this.start();
    }, delay);
    this.retry.unref?.();
  }

  close(): void {
    this.closed = true;
    if (this.retry) clearTimeout(this.retry);
    this.retry = null;
    try { this.watcher?.close(); } catch { /* already closed */ }
    this.watcher = null;
  }
}
