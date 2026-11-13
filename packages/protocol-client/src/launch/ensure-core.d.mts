export interface CoreState {
  state: string;
  rpcPort: number | null;
  blocked?: unknown;
  /** The process the discovery names: one that no longer runs names no core. */
  pid?: number | null;
}
export interface EnsureCoreOptions {
  /** Whether a process still runs (the real check outside a test). */
  runs?(pid: number): boolean;
  readDiscovery(): Promise<CoreState>;
  launch(options?: { log?(line: string): void }): Promise<unknown>;
  sleep?(ms: number): Promise<void>;
  readyTimeoutMs?: number;
  now?(): number;
  log?(line: string): void;
}
export function launchCore(options?: { bin?: string; env?: NodeJS.ProcessEnv; spawnImpl?: unknown; log?(line: string): void; beginCapture?(options: unknown): unknown; detached?: boolean }): Promise<unknown>;
export function processRuns(pid: number): boolean;
export function ensureCore(options: EnsureCoreOptions): Promise<CoreState>;
