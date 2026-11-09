import { isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import type { DesktopShellJobRow, DesktopAgentPoolRow } from '../shared/contract';
import { packagedRuntimeSourceRoot } from './runtime-layout';
import { DESKTOP_TRANSCRIPT_TAIL_ITEMS, REMOTE_TRANSCRIPT_TAIL_BYTES, normalizedProviderModels } from '../shared/desktop-transcript-limits';
export { DESKTOP_TRANSCRIPT_TAIL_ITEMS, REMOTE_TRANSCRIPT_TAIL_BYTES, normalizedProviderModels };

export interface DesktopProjectPreferences {
  version: 2;
  aliases: Record<string, string>;
  hidden: string[];
}

export interface MixdogProject {
  name: string;
  path: string;
  addedAt: number;
  lastSelectedAt?: number;
}

export interface MixdogProjectsModule {
  listProjects(): MixdogProject[];
  addProject(projectPath: string): MixdogProject | null;
  touchProjectSelected(projectPath: string): MixdogProject | null;
  renameProject(projectPath: string, name: string): MixdogProject | null;
  removeProject(projectPath: string): boolean;
  resolveProjectPath?(projectPath: string): string;
}

/** Registry entry of a Mixdog-managed git worktree (the fields the host reads). */
export interface ManagedWorktreeEntry {
  /** Registered Project (main repository) the worktree belongs to. */
  projectPath: string;
  /** Absolute worktree folder under the data dir's managed root. */
  path: string;
  state?: string;
}

/** The worktree manager's registry, the only authority on managed folders. */
export interface MixdogWorktreesModule {
  withWorktreeRecoveryStore?<T>(
    root: string,
    directory: string,
    action: 'write' | 'restore' | 'inspect' | 'discard',
    run: () => Promise<T>
  ): Promise<T>;
  /** The registry entry whose folder is `path`, or null when none is. */
  getWorktreeByPath(path: string): ManagedWorktreeEntry | null | Promise<ManagedWorktreeEntry | null>;
  /** The registry entry whose folder is `path` or contains it (a subfolder
   *  Project's session root). Optional: older daemons match exact folders only. */
  findWorktreeContaining?(path: string): ManagedWorktreeEntry | null | Promise<ManagedWorktreeEntry | null>;
  /** Register a releaser the manager runs before it deletes a worktree, ahead
   *  of its cache cleanups and `git worktree remove`. Returns unregister. */
  registerRootReleaser?(name: string, releaser: (root: string) => unknown): () => void;
}

export interface StatuslineShellJobsStatus {
  count?: number;
  elapsedLabel?: string;
  jobs?: DesktopShellJobRow[];
  /** Per-session buckets (omitted by older runtimes). */
  sessions?: Record<
    string,
    {
      count?: number;
      elapsedLabel?: string;
      jobs?: DesktopShellJobRow[];
      finished?: DesktopShellJobRow[];
    }
  >;
  /** Held shells whose owner session closed: listed for every session that
   *  sees their folder (shellJobVisibleFrom). */
  orphaned?: DesktopShellJobRow[];
}

export interface StatuslineSegmentsModule {
  /** Same folder or same repository (omitted by older runtimes). */
  shellJobVisibleFrom?(job: DesktopShellJobRow, sessionCwd: string): boolean;
  /** Cache-only: answers from the previous scan and kicks the next one. */
  shellJobsStatus(options?: { clientHostPid?: number; sessionId?: string }): StatuslineShellJobsStatus;
  /** Awaited fresh scan (omitted by older runtimes, which fall back to the cache read). */
  shellJobsStatusFresh?(options?: { clientHostPid?: number }): Promise<StatuslineShellJobsStatus>;
}

export interface MixdogSessionSearchModule {
  searchSessionMessages(
    query: string,
    options?: { limit?: number; dataDir?: string }
  ): Promise<Array<{ sessionId: string; rank: number; snippet: string }>>;
}

export interface MixdogSessionStoreModule {
  listStoredSessionSummaries(options?: {
    rebuildIfMissing?: boolean;
    refreshFromStorage?: boolean;
  }): Array<Record<string, unknown>>;
  /** `changed()` runs when the store's background verification corrects the
   *  catalog; returns the unsubscribe function. Optional: older runtimes. */
  subscribeStoredSessionCatalogChanges?(changed: () => void): () => void;
  storedAgentWorkerIndexPath?(): string;
  /** The daemon answers asynchronously (its store reads are awaited). */
  listStoredAgentWorkers?(): DesktopAgentPoolRow[] | Promise<DesktopAgentPoolRow[]>;
}

/** Items a runtime restores on resume, and the page an old (non-paging)
 *  remote client keeps receiving. */
export const DESKTOP_TRANSCRIPT_ITEM_LIMIT = 512;
/** First-open tail for a session only remote (relay) views show: a phone's
 *  ~700px transcript paints about 12 rows plus overscan, so 20 items cover its
 *  first screen and older rows page in as it scrolls up. Fewer bytes cross the
 *  relay and fewer rows mount before the first paint. */
export const REMOTE_TRANSCRIPT_TAIL_ITEMS = 20;
export const DESKTOP_TRANSCRIPT_TAIL_BYTES = 1_000_000;
/** Serialized bytes of the older rows one history page reveals (the page adds
 *  up to 64 items, the renderer's TRANSCRIPT_TAIL_PAGE_ITEMS); the daemon
 *  always reveals at least 8 (TRANSCRIPT_WINDOW_MIN_ITEMS) so paging progresses. */
export const DESKTOP_TRANSCRIPT_PAGE_BYTES = 1_000_000;
// shellJobsStatus itself is cache-only and refreshes its disk-backed cache
// asynchronously. Polling at the cache's 1s cadence keeps disk work out of the
// engine's 50ms publication path.
const SHELL_JOBS_ACTIVE_POLL_INTERVAL_MS = 1_000;
const SHELL_JOBS_IDLE_POLL_INTERVAL_MS = 5_000;


/** Editor F12/references: the bundled code-graph dispatcher (same module the
 *  agent's code_graph tool uses; disk cache makes repeat queries ~ms). */
export function codeGraphModuleUrl(packaged = false, resourcesPath = process.resourcesPath, appPath?: string): string {
  const modulePath = packaged
    ? join(
        packagedRuntimeSourceRoot(resourcesPath),
        'runtime',
        'agent',
        'orchestrator',
        'tools',
        'code-graph',
        'dispatch.mjs'
      )
    : resolve(requiredApplicationPath(appPath), '../../src/runtime/agent/orchestrator/tools/code-graph/dispatch.mjs');
  return pathToFileURL(modulePath).href;
}

/** Client for the machine-global daemon. The desktop is a VIEW over it,
 *  so a request for a session no local view holds is addressed to the daemon
 *  instead of being rejected. */
export function sessionClientModuleUrl(
  packaged = false,
  resourcesPath = process.resourcesPath,
  appPath?: string
): string {
  const modulePath = packaged
    ? join(packagedRuntimeSourceRoot(resourcesPath), 'standalone', 'session-client.mjs')
    : resolve(requiredApplicationPath(appPath), '../../src/standalone/session-client.mjs');
  return pathToFileURL(modulePath).href;
}

function requiredApplicationPath(appPath: string | undefined): string {
  if (typeof appPath !== 'string' || !appPath.trim() || !isAbsolute(appPath)) {
    throw new TypeError('Electron application path must be an absolute path.');
  }
  return appPath;
}

export function normalizedProjectKey(projectPath: string): string {
  const absolute = resolve(projectPath).replace(/[\\/]+$/, '');
  return process.platform === 'win32' ? absolute.toLowerCase() : absolute;
}

export function matchingProjectPath(paths: readonly string[], projectPath: string): string | null {
  const target = normalizedProjectKey(projectPath);
  return paths.find((candidate) => normalizedProjectKey(candidate) === target) ?? null;
}

export function withoutMatchingProject(paths: readonly string[], projectPath: string): string[] {
  const target = normalizedProjectKey(projectPath);
  return paths.filter((candidate) => normalizedProjectKey(candidate) !== target);
}

export function projectAlias(aliases: Readonly<Record<string, string>>, projectPath: string): string | null {
  const exact = aliases[projectPath];
  if (typeof exact === 'string' && exact.trim()) return exact.trim();
  const key = normalizedProjectKey(projectPath);
  for (const [candidate, alias] of Object.entries(aliases)) {
    if (normalizedProjectKey(candidate) === key && alias.trim()) return alias.trim();
  }
  return null;
}

export function shellJobsPollDelay(state: Readonly<Record<string, unknown>> | null, runningShellCount = 0): number {
  return state?.busy === true || state?.commandBusy === true || runningShellCount > 0
    ? SHELL_JOBS_ACTIVE_POLL_INTERVAL_MS
    : SHELL_JOBS_IDLE_POLL_INTERVAL_MS;
}

export function copyCapabilityValue<T>(value: T): T {
  try {
    return structuredClone(value);
  } catch {
    // Some core read models intentionally carry TUI-only formatter functions.
    // Electron cannot clone those across IPC, so project a detached data-only
    // copy without changing the existing engine result or its cached objects.
  }
  const seen = new WeakMap<object, unknown>();
  const visit = (input: unknown): unknown => {
    if (typeof input === 'function' || typeof input === 'symbol') return undefined;
    if (input === null || typeof input !== 'object') return input;
    if (seen.has(input)) return seen.get(input);
    if (input instanceof Date) return new Date(input.getTime());
    if (input instanceof RegExp) return new RegExp(input.source, input.flags);
    if (input instanceof Error) {
      return { name: input.name, message: input.message, stack: input.stack };
    }
    if (Array.isArray(input)) {
      const output: unknown[] = [];
      seen.set(input, output);
      for (const entry of input) output.push(visit(entry));
      return output;
    }
    try {
      const cloned = structuredClone(input);
      seen.set(input, cloned);
      return cloned;
    } catch {
      const output: Record<string, unknown> = {};
      seen.set(input, output);
      for (const [key, entry] of Object.entries(input)) {
        const copied = visit(entry);
        if (copied !== undefined) output[key] = copied;
      }
      return output;
    }
  };
  return visit(value) as T;
}
