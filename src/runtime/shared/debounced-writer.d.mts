export interface DebouncedWriter<T> {
  schedule(value: T, flushPending?: () => unknown): void;
  flush(): Promise<boolean>;
  flushSyncIfIdle(writeSync: (value: T) => void): boolean;
  hasPending(): boolean;
  getPending(): T | null;
}

export function createDebouncedWriter<T>(options: {
  write: (value: T) => unknown | Promise<unknown>;
  onError: (error: unknown, synchronous: boolean) => void;
  delayMs: number;
}): DebouncedWriter<T>;
