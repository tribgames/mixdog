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
export const CORE_PING_INTERVAL_MS: number;
export const CORE_PING_TIMEOUT_MS: number;
export const CORE_STALL_LIMIT_MS: number;
export const CORE_MISSED_LIMIT: number;
export function pingCore(discovery: CoreState, options?: { timeoutMs?: number; stallLimitMs?: number; fetchImpl?: typeof fetch }): Promise<boolean>;
export interface WatchCoreOptions {
  readDiscovery(): Promise<CoreState>;
  /** The pid of the core this launcher started (null when none): no other core is touched. */
  ownedPid(): number | null;
  ping?(discovery: CoreState): Promise<boolean>;
  kill?(pid: number): void;
  onKilled?(discovery: CoreState): void | Promise<void>;
  sleep?(ms: number): Promise<void>;
  intervalMs?: number;
  missedLimit?: number;
  runs?(pid: number): boolean;
  log?(line: string): void;
}
export function watchCore(options: WatchCoreOptions): { stop(): void; done: Promise<void> };
