export function makeTempDirSync(prefix: string): string;
export function registerOwnedTempDir(dir: string): string;
export function redirectSystemTemp(prefix?: string): string;
export function removeTempDirSync(dir: string): void;
export function removeTempDir(dir: string): Promise<void>;
export function tempDirFor(t: { after(fn: () => unknown): void }, prefix: string): string;
export interface ScopedTempDir {
  path: string;
  join(...parts: string[]): string;
  remove(): Promise<void>;
  removeSync(): void;
  [Symbol.asyncDispose](): Promise<void>;
  [Symbol.dispose](): void;
}
export function scopedTempDir(prefix: string): ScopedTempDir;
export function withTempDir<T>(prefix: string, fn: (dir: string) => T | Promise<T>): Promise<T>;
