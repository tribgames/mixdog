export interface AtomicFileOptions {
  secret?: boolean;
  createOnly?: boolean;
  mode?: number;
  encoding?: BufferEncoding;
  fsync?: boolean;
  fsyncDir?: boolean;
  /** Serialize with other writers through `${path}.lock`. */
  lock?: boolean;
  /** Keep the replaced version as `<path>.bak` (JSON writes: only if it still parses). */
  backup?: boolean;
  /** With `backup`: whether the replaced content may become the backup. */
  backupAccepts?: (content: Buffer) => boolean;
}

export function writeFileAtomicAsync(
  filePath: string,
  data: string | Uint8Array,
  options?: AtomicFileOptions
): Promise<boolean>;

export function writeFileAtomicSync(filePath: string, data: string | Uint8Array, options?: AtomicFileOptions): boolean;

/** Atomic JSON publication used by TypeScript desktop hosts. */
export function writeJsonAtomicAsync(
  filePath: string,
  value: unknown,
  options?: AtomicFileOptions & { compact?: boolean }
): Promise<boolean>;

export function writeJsonAtomicSync(
  filePath: string,
  value: unknown,
  options?: AtomicFileOptions & { compact?: boolean }
): boolean;

export interface JsonStateOptions<T> {
  /** Maps the parsed value; throwing marks the file damaged. */
  validate?: (value: unknown) => T;
  /** Maps the file's bytes to JSON text (e.g. unsealing); throwing marks it damaged. */
  decode?: (content: Buffer) => string;
  /** Returned as is when the file is missing or damaged with no good backup. */
  fallback?: T;
  /** Leave a damaged file in place when there is no good `.bak` (for files where "missing" is permissive). */
  keepWithoutBackup?: boolean;
  /** false: never restore `.bak` (an older copy is worse than none, e.g. revoked grants). */
  restoreBackup?: boolean;
  secret?: boolean;
  mode?: number;
}

/** Reads a JSON state file that must never block its feature: a damaged file
 *  is kept aside as `<path>.corrupt-<ts>` and `<path>.bak` restored when valid. */
export function readJsonState<T = unknown>(filePath: string, options?: JsonStateOptions<T>): Promise<T>;

export function readJsonStateSync<T = unknown>(filePath: string, options?: JsonStateOptions<T>): T;

/** A collision-proof, non-dot-prefixed destination for a damaged copy: `<path>.corrupt-<ms>` (the first ms whose name is unused). Call under the file's lock. */
export function quarantinePath(filePath: string): string;

/** For `validate`: an intact file in a newer build's format; it is left in place and the read answers the fallback. */
export function unsupportedState(message: string): Error;

/** True when `err` is a filesystem refusing fsync on a file (EPERM, ENOTSUP, EINVAL), not a real I/O error. */
export function isFileFsyncUnsupported(err: unknown): boolean;

/** True when the content is only NUL bytes and whitespace (what a crash leaves). */
export function holdsNoData(content: string | Uint8Array): boolean;

/** JSON.parse that also accepts a leading byte order mark. */
export function parseJsonText(text: string): unknown;

export function withFileLock<T>(
  lockPath: string,
  task: () => T | Promise<T>,
  options?: { timeoutMs?: number; staleMs?: number; secret?: boolean; strictOwner?: boolean }
): Promise<T>;
