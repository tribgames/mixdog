export interface CoreState {
  state: string;
  rpcPort: number | null;
  blocked?: unknown;
}
export interface EnsureCoreOptions {
  readDiscovery(): Promise<CoreState>;
  launch(options?: { log?(line: string): void }): Promise<unknown>;
  sleep?(ms: number): Promise<void>;
  readyTimeoutMs?: number;
  now?(): number;
  log?(line: string): void;
}
export function launchCore(options?: { bin?: string; env?: NodeJS.ProcessEnv; spawnImpl?: unknown; log?(line: string): void; beginCapture?(options: unknown): unknown }): Promise<unknown>;
export function ensureCore(options: EnsureCoreOptions): Promise<CoreState>;
