export interface CoreState {
  state: string;
  rpcPort: number | null;
  blocked?: unknown;
}
export interface EnsureCoreOptions {
  readDiscovery(): Promise<CoreState>;
  launch(): Promise<void>;
  sleep?(ms: number): Promise<void>;
  readyTimeoutMs?: number;
  now?(): number;
  log?(line: string): void;
}
export function launchCore(options?: { bin?: string; env?: NodeJS.ProcessEnv; spawnImpl?: unknown }): Promise<void>;
export function ensureCore(options: EnsureCoreOptions): Promise<CoreState>;
