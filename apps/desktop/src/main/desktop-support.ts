import { isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import type {
  DesktopShellJobRow,
  DesktopAgentPoolRow,
  DesktopModelOption,
} from '../shared/contract';
import { packagedRuntimeSourceRoot } from './runtime-layout';

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

export interface DesktopSessionMetadataFile {
  version: 2;
  titles: Record<string, string>;
  names: Record<string, string>;
  /** Archive map: id → archivedAt ms. Present only when non-empty. */
  archived?: Record<string, number>;
}

export type DesktopSessionScope = { classification: 'task' | 'project'; projectPath: string | null };

export interface StatuslineSegmentsModule {
  shellJobsStatus(options?: { clientHostPid?: number; sessionId?: string }): {
    count?: number;
    elapsedLabel?: string;
    jobs?: DesktopShellJobRow[];
    /** Per-session buckets (omitted by older runtimes). */
    sessions?: Record<string, {
      count?: number;
      elapsedLabel?: string;
      jobs?: DesktopShellJobRow[];
    }>;
  };
}

export interface MixdogSessionStoreModule {
  listStoredSessionSummaries(options?: {
    rebuildIfMissing?: boolean;
    refreshFromStorage?: boolean;
  }): Array<Record<string, unknown>>;
  storedAgentWorkerIndexPath?(): string;
  listStoredAgentWorkers?(): DesktopAgentPoolRow[];
  readStoredSessionTranscript?(
    sessionId: string,
    options?: { transcriptItemLimit?: number },
  ): Promise<Record<string, unknown> | null>;
}

export const DESKTOP_TRANSCRIPT_ITEM_LIMIT = 512;
// shellJobsStatus itself is cache-only and refreshes its disk-backed cache
// asynchronously. Polling at the cache's 1s cadence keeps disk work out of the
// engine's 50ms publication path.
export const SHELL_JOBS_ACTIVE_POLL_INTERVAL_MS = 1_000;
export const SHELL_JOBS_IDLE_POLL_INTERVAL_MS = 5_000;

export function normalizedProviderModels(value: unknown): DesktopModelOption[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry): DesktopModelOption[] => {
    if (!entry || typeof entry !== 'object') return [];
    const row = entry as Record<string, unknown>;
    const provider = typeof row.provider === 'string' ? row.provider.trim() : '';
    const model = typeof row.id === 'string' ? row.id.trim() : '';
    const display = [row.display, row.name, model]
      .find((candidate) => typeof candidate === 'string' && candidate.trim()) as string | undefined;
    // The TUI falls back from display/name to the model id. Do the same here
    // so an otherwise selectable model from a user-configured provider is not
    // silently removed merely because its catalog omits an optional label.
    if (!provider || !model) return [];
    const effortOptions = Array.isArray(row.effortOptions)
      ? row.effortOptions.flatMap((option) => {
        if (!option || typeof option !== 'object') return [];
        const item = option as Record<string, unknown>;
        const value = typeof item.value === 'string' ? item.value.trim() : '';
        const label = typeof item.label === 'string' ? item.label.trim() : '';
        return value && label ? [{ value, label }] : [];
      })
      : [];
    const fastCapable = row.fastCapable === true;
    const created = Number(row.created);
    const contextWindow = Number(row.contextWindow);
    const maxContextWindow = Number(row.maxContextWindow);
    const releaseDate = typeof row.releaseDate === 'string' ? row.releaseDate.trim() : '';
    const family = typeof row.family === 'string' ? row.family.trim() : '';
    const description = typeof row.description === 'string' ? row.description.trim() : '';
    const savedEffort = typeof row.savedEffort === 'string' &&
      effortOptions.some((option) => option.value === row.savedEffort)
      ? row.savedEffort
      : undefined;
    const savedFast = typeof row.savedFast === 'boolean' ? row.savedFast : undefined;
    const savedContextPercent = Number(row.savedContextPercent);
    const modelParameterOptions = Array.isArray(row.modelParameterOptions)
      ? row.modelParameterOptions as DesktopModelOption['modelParameterOptions']
      : [];
    const parameterVariants = Array.isArray(row.parameterVariants)
      ? row.parameterVariants as Array<Record<string, string>>
      : [];
    const defaultModelParameters = row.defaultModelParameters && typeof row.defaultModelParameters === 'object'
      ? row.defaultModelParameters as Record<string, string>
      : {};
    const savedModelParameters = row.savedModelParameters && typeof row.savedModelParameters === 'object'
      ? row.savedModelParameters as Record<string, string>
      : {};
    return [{
      provider,
      model,
      display: display?.trim() || model,
      ...(Number.isFinite(created) && created > 0 ? { created } : {}),
      ...(releaseDate ? { releaseDate } : {}),
      ...(Number.isFinite(contextWindow) && contextWindow > 0 ? { contextWindow } : {}),
      ...(Number.isFinite(maxContextWindow) && maxContextWindow > 0 ? { maxContextWindow } : {}),
      ...(family ? { family } : {}),
      ...(row.latest === true ? { latest: true } : {}),
      ...(description ? { description } : {}),
      ...(row.supportsVision === true ? { supportsVision: true } : {}),
      effortOptions,
      fastCapable,
      fastPreferred: fastCapable && (row.fastPreferred === true || row.savedFast === true),
      ...(savedEffort ? { savedEffort } : {}),
      ...(savedFast === undefined ? {} : { savedFast }),
      ...(Number.isFinite(savedContextPercent) && savedContextPercent >= 10 && savedContextPercent <= 100
        ? { savedContextPercent }
        : {}),
      ...(typeof row.defaultEffort === 'string' && row.defaultEffort ? { defaultEffort: row.defaultEffort } : {}),
      ...(row.defaultFast === true ? { defaultFast: true } : {}),
      modelParameterOptions,
      parameterVariants,
      defaultModelParameters,
      savedModelParameters,
    }];
  });
}

/** Editor F12/references: the bundled code-graph dispatcher (same module the
 *  agent's code_graph tool uses; disk cache makes repeat queries ~ms). */
export function codeGraphModuleUrl(
  packaged = false,
  resourcesPath = process.resourcesPath,
  appPath?: string,
): string {
  const modulePath = packaged
    ? join(packagedRuntimeSourceRoot(resourcesPath), 'runtime',
      'agent', 'orchestrator', 'tools', 'code-graph', 'dispatch.mjs')
    : resolve(requiredApplicationPath(appPath),
      '../../src/runtime/agent/orchestrator/tools/code-graph/dispatch.mjs');
  return pathToFileURL(modulePath).href;
}

/** Client for the machine-global daemon. The desktop is a VIEW over it,
 *  so a request for a session no local view holds is addressed to the daemon
 *  instead of being rejected. */
export function sessionClientModuleUrl(
  packaged = false,
  resourcesPath = process.resourcesPath,
  appPath?: string,
): string {
  const modulePath = packaged
    ? join(packagedRuntimeSourceRoot(resourcesPath), 'standalone',
      'session-client.mjs')
    : resolve(requiredApplicationPath(appPath), '../../src/standalone/session-client.mjs');
  return pathToFileURL(modulePath).href;
}


export function requiredApplicationPath(appPath: string | undefined): string {
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

export function projectAlias(
  aliases: Readonly<Record<string, string>>,
  projectPath: string,
): string | null {
  const exact = aliases[projectPath];
  if (typeof exact === 'string' && exact.trim()) return exact.trim();
  const key = normalizedProjectKey(projectPath);
  for (const [candidate, alias] of Object.entries(aliases)) {
    if (normalizedProjectKey(candidate) === key && alias.trim()) return alias.trim();
  }
  return null;
}

export function shellJobsPollDelay(
  state: Readonly<Record<string, unknown>> | null,
  runningShellCount = 0,
): number {
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
