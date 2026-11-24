export interface CoreState {
  state: string;
  rpcPort: number | null;
  blocked?: unknown;
  /** The process the discovery names: one that no longer runs names no core. */
  pid?: number | null;
  /** The control listener's port (`core.control.port`): what `pingCore` asks. */
  controlPort?: number | null;
  /** The session token (`endpoints.session.token`) the control listener takes. */
  token?: string | null;
  /** The sessions the core's index rebuild has read of how many; null (or absent) when none runs. */
  rebuild?: RebuildProgress | null;
}
export interface RebuildProgress {
  done: number;
  total: number;
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
  /** The ask of a core that still says it is starting once the ready time has passed (`pingCore` outside a test). */
  ping?(discovery: CoreState): Promise<{ answered: boolean; stalledMs: number }>;
  /** Told each time what the core does before it serves changes (null when it ends or it does nothing), with the pid of the core boot the counts are of, while this waits for `serving`. */
  onProgress?(progress: (RebuildProgress & { stage: 'migration' | 'rebuild' | 'legacy' }) | null, boot: number | null): void;
  /** Asks the earlier version's daemon the file names to step aside (when no `retirement` is shared). */
  retireLegacy?(discovery: CoreState): Promise<LegacyAnswer | null>;
  /** What every attempt of one launcher knows of the earlier daemons it asked ([`legacyRetirement`]). */
  retirement?: LegacyRetirement;
}
export interface LegacyAnswer {
  accepted: boolean;
  status?: number | null;
  error?: string | null;
}
export interface LegacyRetirementRecord {
  pid: number;
  accepted: boolean;
  answer: LegacyAnswer | null;
  endpoint: { sessionPort: number | null; token: string | null };
}
export interface LegacyRetirement {
  ask(discovery: CoreState): Promise<LegacyRetirementRecord>;
  of(pid: number): Promise<LegacyRetirementRecord | null>;
}
export function legacyRetirement(retireLegacy?: (discovery: CoreState) => Promise<LegacyAnswer | null>): LegacyRetirement;
export function launchCore(options?: {
  bin?: string;
  env?: NodeJS.ProcessEnv;
  spawnImpl?: unknown;
  log?(line: string): void;
  beginCapture?(options: unknown): unknown;
  detached?: boolean;
  desktopConfirmationPipe?: boolean;
}): Promise<unknown>;
export function processRuns(pid: number): boolean;
export function ensureCore(options: EnsureCoreOptions): Promise<CoreState>;
export const CORE_PING_INTERVAL_MS: number;
export const CORE_PING_TIMEOUT_MS: number;
export const CORE_UNANSWERED_LIMIT_MS: number;
export const CORE_SLEEP_GAP_MS: number;
/** `answered` is false for no answer and for a refusal; `stalledMs` is the runtime's stall the control status reports. */
export interface CorePing {
  answered: boolean;
  stalledMs: number;
}
export function pingCore(
  discovery: CoreState,
  options?: { timeoutMs?: number; fetchImpl?: typeof fetch }
): Promise<CorePing>;
export interface WatchCoreOptions {
  readDiscovery(): Promise<CoreState>;
  /** The pid of the core this launcher started (null when none): no other core is touched. */
  ownedPid(): number | null;
  ping?(discovery: CoreState): Promise<CorePing>;
  kill?(pid: number): void;
  onKilled?(discovery: CoreState): void | Promise<void>;
  sleep?(ms: number): Promise<void>;
  now?(): number;
  intervalMs?: number;
  unansweredLimitMs?: number;
  runs?(pid: number): boolean;
  log?(line: string): void;
  /** Said just before the kill: which core, why (`statusUnanswered` or `runtimeStalled`) and for how long. */
  onEnding?(ending: {
    pid: number;
    reason: 'statusUnanswered' | 'runtimeStalled';
    unansweredMs: number;
    stalledMs: number;
    limitMs: number;
  }): void;
}
export function watchCore(options: WatchCoreOptions): { stop(): void; done: Promise<void> };
