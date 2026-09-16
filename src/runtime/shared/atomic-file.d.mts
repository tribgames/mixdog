export interface AtomicFileOptions {
  secret?: boolean;
  createOnly?: boolean;
  mode?: number;
  encoding?: BufferEncoding;
  fsync?: boolean;
  fsyncDir?: boolean;
}

export function writeFileAtomicAsync(
  filePath: string,
  data: string | Uint8Array,
  options?: AtomicFileOptions
): Promise<boolean>;

/** Atomic JSON publication used by TypeScript desktop hosts. */
export function writeJsonAtomicAsync(
  filePath: string,
  value: unknown,
  options?: AtomicFileOptions & { compact?: boolean }
): Promise<boolean>;

export function withFileLock<T>(
  lockPath: string,
  task: () => T | Promise<T>,
  options?: { timeoutMs?: number; staleMs?: number; secret?: boolean }
): Promise<T>;
