import { isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';

import type {
  DesktopAgentPoolRow,
  DesktopEngineState,
  DesktopModelCatalogOptions,
  DesktopModelOption,
  DesktopModelSelection,
  DesktopPromptContent,
  DesktopSubmitOptions,
  EngineSnapshot,
  ToolApprovalDecision
} from '../shared/contract';
import { DESKTOP_CAPABILITIES } from '../shared/contract';
import {
  DESKTOP_TERMINAL_AGENT_STATUS,
  desktopAgentIdentity,
  isActiveDesktopAgentEntry,
  isQueuedDesktopAgentEntry,
} from '../shared/agent-activity';
import {
  isSyntheticSessionDisplayText,
  stripInjectedDisplayText,
  stripSessionEnvelope
} from '../shared/session-title.mjs';
// @ts-expect-error The shared runtime module is plain ESM and has no declaration file.
import { isInternalTranscriptDisplayText } from '../../../../src/runtime/shared/tool-execution-contract.mjs';
import { searchProjectDirectory } from './project-file-search';

export interface MixdogEngine {
  getState(): Record<string, unknown>;
  subscribe(listener: () => void): () => void;
  submit(prompt: DesktopPromptContent, options?: DesktopSubmitOptions): boolean;
  abort(): unknown;
  resolveToolApproval(id: string, decision: ToolApprovalDecision): boolean;
  listProviderModels(options: DesktopModelCatalogOptions): Promise<unknown>;
  setRoute(options: DesktopModelSelection & { applyToCurrentSession?: boolean }): Promise<boolean>;
  setFast(value: boolean): Promise<boolean | null>;
  listSessions(options?: { refreshFromStorage?: boolean }): Array<Record<string, unknown>>;
  sessionStoreDir?(): string | null;
  renameSessionTitle?(id: string, title: string): Promise<boolean>;
  deleteSession(id: string): Promise<boolean>;
  switchContext?(options: {
    cwd: string;
    desktopSession: { classification: 'task' | 'project'; projectPath: string | null } | null;
    forResume?: boolean;
  }): Promise<boolean>;
  newSession(): Promise<boolean>;
  prefetchSession?(id: string): boolean | Promise<boolean>;
  resume(id: string, options?: { transcriptItemLimit?: number }): Promise<boolean>;
  dispose(reason?: string, options?: { keepBackgroundWork?: boolean }): Promise<void>;
  [key: string]: unknown;
}

export type SnapshotListener = (snapshot: EngineSnapshot) => void;
export type EngineFactory = (options: Record<string, unknown>) => Promise<MixdogEngine>;
const snapshotFieldClonesByEngine = new WeakMap<MixdogEngine, Map<string, unknown>>();
const snapshotItemsByEngine = new WeakMap<
  MixdogEngine,
  { source: readonly unknown[]; cloned: unknown[] }
>();
const streamingTailClones = new WeakMap<object, unknown>();
const STREAMING_TAIL_TEXT_EPOCH = Symbol.for('mixdog.streaming-tail-text-epoch');

export function streamingTailAppendEpoch(snapshot: EngineSnapshot): number | null {
  if (!snapshot || typeof snapshot !== 'object') return null;
  const value = (snapshot as Record<PropertyKey, unknown>)[STREAMING_TAIL_TEXT_EPOCH];
  return Number.isSafeInteger(value) ? value as number : null;
}

export interface EngineHostOptions {
  userDataPath?: string;
  getUserDataPath?: () => string;
  createEngine?: EngineFactory;
  loadProjects?: () => Promise<MixdogProjectsModule>;
  loadSessionStore?: () => Promise<MixdogSessionStoreModule>;
  packaged?: boolean;
  resourcesPath?: string;
  appPath?: string;
  runtimeRoot?: string;
  searchProjectDirectory?: typeof searchProjectDirectory;
}

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

export interface DesktopOAuthFlow {
  id: string;
  provider: string;
  url: string | null;
  manualUrl: string | null;
  state: 'pending' | 'complete' | 'failed' | 'cancelled';
  result: unknown;
  error: string | null;
  completeCode?: (code: string) => Promise<unknown>;
  cancel?: () => unknown;
  timeout: NodeJS.Timeout;
}

export interface StatuslineSegmentsModule {
  shellJobsStatus(options?: { clientHostPid?: number; sessionId?: string }): {
    count?: number;
    elapsedLabel?: string;
    /** Per-session buckets (omitted by older runtimes). */
    sessions?: Record<string, { count?: number; elapsedLabel?: string }>;
  };
}

export interface StoredSessionLiveViewer {
  dispose(): void;
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
  createStoredSessionLiveViewer?(
    sessionId: string,
    options: {
      initialSnapshot: EngineSnapshot;
      onSnapshot(snapshot: EngineSnapshot): void;
      onOwnerClosed(): void;
    },
  ): Promise<StoredSessionLiveViewer | null>;
}

export const DESKTOP_CAPABILITY_SET = new Set<string>(DESKTOP_CAPABILITIES);
export const ENGINE_PUBLICATION_INTERVAL_MS = 50;
// Every visible pane is foreground. Coalesce its engine events to at most one
// publication per display frame without adding a perceptible 50ms lane delay.
export const FOREGROUND_SESSION_PUBLICATION_INTERVAL_MS = 16;
// Sidebar push debounce: session-store fs events coalesce for this long before
// one listSessions() refresh fans out to subscribers.
export const SESSIONS_CHANGED_DEBOUNCE_MS = 500;
// Perf instrumentation (MIXDOG_DESKTOP_PERF=1): appends coarse stage timings
// to <userData>/desktop-perf.log so slow session-switch/settings reports can
// be diagnosed from a real run instead of guesses. Zero-cost when unset.
export const DESKTOP_PERF_ENABLED = process.env.MIXDOG_DESKTOP_PERF === '1';
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
    const releaseDate = typeof row.releaseDate === 'string' ? row.releaseDate.trim() : '';
    const family = typeof row.family === 'string' ? row.family.trim() : '';
    const savedEffort = typeof row.savedEffort === 'string' &&
      effortOptions.some((option) => option.value === row.savedEffort)
      ? row.savedEffort
      : undefined;
    const savedFast = typeof row.savedFast === 'boolean' ? row.savedFast : undefined;
    return [{
      provider,
      model,
      display: display?.trim() || model,
      ...(Number.isFinite(created) && created > 0 ? { created } : {}),
      ...(releaseDate ? { releaseDate } : {}),
      ...(Number.isFinite(contextWindow) && contextWindow > 0 ? { contextWindow } : {}),
      ...(family ? { family } : {}),
      ...(row.latest === true ? { latest: true } : {}),
      effortOptions,
      fastCapable,
      fastPreferred: fastCapable && (row.fastPreferred === true || row.savedFast === true),
      ...(savedEffort ? { savedEffort } : {}),
      ...(savedFast === undefined ? {} : { savedFast }),
    }];
  });
}

export function engineModuleUrl(
  packaged = false,
  resourcesPath = process.resourcesPath,
  appPath?: string,
): string {
  const enginePath = packaged
    ? join(resourcesPath, 'runtime.asar', 'node_modules', 'mixdog', 'src', 'tui', 'engine.mjs')
    : resolve(requiredApplicationPath(appPath), '../../src/tui/engine.mjs');
  return pathToFileURL(enginePath).href;
}

export function projectsModuleUrl(
  packaged = false,
  resourcesPath = process.resourcesPath,
  appPath?: string,
): string {
  const projectsPath = packaged
    ? join(resourcesPath, 'runtime.asar', 'node_modules', 'mixdog', 'src', 'standalone', 'projects.mjs')
    : resolve(requiredApplicationPath(appPath), '../../src/standalone/projects.mjs');
  return pathToFileURL(projectsPath).href;
}

export function sessionStoreModuleUrl(
  packaged = false,
  resourcesPath = process.resourcesPath,
  appPath?: string,
): string {
  const modulePath = packaged
    ? join(resourcesPath, 'runtime.asar', 'node_modules', 'mixdog', 'src', 'runtime',
      'agent', 'orchestrator', 'session', 'store-summary-reader.mjs')
    : resolve(requiredApplicationPath(appPath),
      '../../src/runtime/agent/orchestrator/session/store-summary-reader.mjs');
  return pathToFileURL(modulePath).href;
}

/** Editor F12/references: the bundled code-graph dispatcher (same module the
 *  agent's code_graph tool uses; disk cache makes repeat queries ~ms). */
export function codeGraphModuleUrl(
  packaged = false,
  resourcesPath = process.resourcesPath,
  appPath?: string,
): string {
  const modulePath = packaged
    ? join(resourcesPath, 'runtime.asar', 'node_modules', 'mixdog', 'src', 'runtime',
      'agent', 'orchestrator', 'tools', 'code-graph', 'dispatch.mjs')
    : resolve(requiredApplicationPath(appPath),
      '../../src/runtime/agent/orchestrator/tools/code-graph/dispatch.mjs');
  return pathToFileURL(modulePath).href;
}

export function statuslineSegmentsModuleUrl(
  packaged = false,
  resourcesPath = process.resourcesPath,
  appPath?: string,
): string {
  const modulePath = packaged
    ? join(resourcesPath, 'runtime.asar', 'node_modules', 'mixdog', 'src', 'ui', 'statusline-segments.mjs')
    : resolve(requiredApplicationPath(appPath), '../../src/ui/statusline-segments.mjs');
  return pathToFileURL(modulePath).href;
}

/** Client for the machine-global engine daemon. The desktop is a VIEW over it,
 *  so a request for a session no local view holds is addressed to the daemon
 *  instead of being rejected. */
export function engineDaemonClientModuleUrl(
  packaged = false,
  resourcesPath = process.resourcesPath,
  appPath?: string,
): string {
  const modulePath = packaged
    ? join(resourcesPath, 'runtime.asar', 'node_modules', 'mixdog', 'src', 'standalone',
      'engine-daemon-client.mjs')
    : resolve(requiredApplicationPath(appPath), '../../src/standalone/engine-daemon-client.mjs');
  return pathToFileURL(modulePath).href;
}

export interface EngineDaemonClientModule {
  callDaemonSession(options: {
    sessionId: string;
    method: string;
    args?: unknown[];
    open?: Record<string, unknown>;
    cwd?: string;
    log?: (line: string) => void;
  }): Promise<{ value?: unknown; engineId?: string; sessionId?: string }>;
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

const INTERNAL_TRANSCRIPT_ROLES = new Set(['system', 'developer']);
const INTERNAL_TRANSCRIPT_KINDS = new Set(['system', 'developer', 'synthetic', 'internal', 'hidden']);
const INTERNAL_DISPLAY_FIELDS = new Set(['display', 'displayMetadata', 'toolDisplay', 'summaryMetadata']);

export function recordValue(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

export function normalizedMarker(value: unknown): string {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

export function hasExplicitInternalMarker(value: unknown, includeRoleAndKind = true): boolean {
  const record = recordValue(value);
  if (!record) return false;
  if (record.internal === true || record.hidden === true || record.synthetic === true) return true;
  if (normalizedMarker(record.visibility) === 'internal' || normalizedMarker(record.visibility) === 'hidden') {
    return true;
  }
  if (normalizedMarker(record.audience) === 'internal') return true;
  if (!includeRoleAndKind) return false;
  return INTERNAL_TRANSCRIPT_ROLES.has(normalizedMarker(record.role))
    || INTERNAL_TRANSCRIPT_KINDS.has(normalizedMarker(record.kind));
}

export function isInternalTranscriptItem(value: unknown): boolean {
  const item = recordValue(value);
  if (!item) return false;
  return hasExplicitInternalMarker(item)
    || hasExplicitInternalMarker(item.metadata, false);
}

export function removeInternalToolDisplayMetadata(value: unknown): void {
  if (Array.isArray(value)) {
    for (const entry of value) removeInternalToolDisplayMetadata(entry);
    return;
  }
  const record = recordValue(value);
  if (!record) return;
  for (const [key, child] of Object.entries(record)) {
    if (INTERNAL_DISPLAY_FIELDS.has(key) && hasExplicitInternalMarker(child)) {
      delete record[key];
      continue;
    }
    removeInternalToolDisplayMetadata(child);
  }
}

export function sanitizeTranscriptItem(value: unknown): boolean {
  if (isInternalTranscriptItem(value)) return false;
  const item = recordValue(value);
  const kind = normalizedMarker(item?.kind);
  const role = normalizedMarker(item?.role);
  if ((kind === 'user' || role === 'user') && typeof item?.text === 'string') {
    if (isSyntheticSessionDisplayText(item.text)) return false;
    const visibleText = stripInjectedDisplayText(stripSessionEnvelope(item.text))
      .replace(/[ \t]+\r?\n/g, '\n')
      .replace(/\r?\n{3,}/g, '\n\n')
      .trim();
    // Model-only control turns stay in session history for the next model step,
    // but never belong in the human transcript — including persisted legacy
    // wrappers, raw runtime envelopes, and protected context blocks.
    if (isInternalTranscriptDisplayText(visibleText)) return false;
    if (visibleText !== item.text) item.text = visibleText;
    if (!visibleText.trim()) return false;
  }
  if (kind === 'tool') removeInternalToolDisplayMetadata(item);
  return true;
}

// Transcript items are immutable BY IDENTITY (the engine replaces a changed
// item object instead of mutating it), so each item needs exactly one
// clone+sanitize. Re-cloning the whole transcript on every 50ms publication
// made long sessions pay O(transcript) per frame; with this cache the steady-
// state publication cost is O(changed items). Cached clones are shared across
// snapshots and MUST stay read-only downstream (IPC serialization, remote
// relay JSON, renderer deserialized copies) — none of those mutate them.
const sanitizedItemClones = new WeakMap<object, { keep: boolean; clone: unknown }>();

export function sanitizedItemClone(item: unknown): { keep: boolean; clone: unknown } {
  if (!item || typeof item !== 'object') {
    const clone = structuredClone(item);
    return { keep: sanitizeTranscriptItem(clone), clone };
  }
  const cached = sanitizedItemClones.get(item);
  if (cached) return cached;
  const clone = structuredClone(item);
  const entry = { keep: sanitizeTranscriptItem(clone), clone };
  sanitizedItemClones.set(item, entry);
  return entry;
}

export function activeToolsFromSummary(value: unknown): DesktopEngineState['activeTools'] {
  const [exploreCount, exploreStartedAt, searchCount, searchStartedAt] = String(value || '')
    .split(':')
    .map((entry) => Number(entry) || 0);
  if (!exploreCount && !searchCount) return null;
  return {
    explore: { count: exploreCount, startedAt: exploreStartedAt },
    search: { count: searchCount, startedAt: searchStartedAt },
  };
}

export const TERMINAL_AGENT_STATUS = DESKTOP_TERMINAL_AGENT_STATUS;

export function projectedAgentEntry(value: unknown): Record<string, unknown> | null {
  const entry = recordValue(value);
  if (!entry) return null;
  const projected: Record<string, unknown> = {};
  for (const key of [
    'tag', 'agent', 'name', 'type', 'provider', 'model',
    'task_id', 'taskId', 'stage', 'status',
  ] as const) {
    if (typeof entry[key] === 'string' && entry[key].trim()) projected[key] = entry[key];
  }
  const startedAt = entry.startedAt ?? entry.startTime ?? entry.createdAt;
  if ((typeof startedAt === 'number' && Number.isFinite(startedAt)) || typeof startedAt === 'string') {
    projected.startedAt = startedAt;
  }
  return projected;
}

export function projectDesktopLiveWorkState(snapshot: Record<string, unknown>): Record<string, unknown> {
  const workers: Record<string, unknown>[] = [];
  const workerSources = new Map<string, Record<string, unknown>>();
  for (const value of Array.isArray(snapshot.agentWorkers) ? snapshot.agentWorkers : []) {
    const source = recordValue(value);
    const entry = projectedAgentEntry(value);
    if (!source || !entry) continue;
    const identity = desktopAgentIdentity(source);
    if (identity) workerSources.set(identity, source);
    if (isActiveDesktopAgentEntry(source)) workers.push(entry);
  }
  const jobs: Record<string, unknown>[] = [];
  for (const value of Array.isArray(snapshot.agentJobs) ? snapshot.agentJobs : []) {
    const source = recordValue(value);
    const entry = projectedAgentEntry(value);
    if (!source || !entry || !isActiveDesktopAgentEntry(source)) continue;
    const identity = desktopAgentIdentity(source);
    const worker = identity ? workerSources.get(identity) : undefined;
    // A worker row is authoritative once a spawn exists. Its terminal state
    // suppresses a lagging `running` job tombstone; a genuinely new queued
    // reuse remains visible until its worker starts.
    if (worker && (isActiveDesktopAgentEntry(worker) || !isQueuedDesktopAgentEntry(source))) continue;
    jobs.push(entry);
  }
  snapshot.agentWorkers = workers;
  snapshot.agentJobs = jobs;
  snapshot.activeTools = activeToolsFromSummary(snapshot.activeToolSummary);
  snapshot.remoteEnabled = snapshot.remoteEnabled === true;
  return snapshot;
}

export function copySnapshot(engine: MixdogEngine | null): EngineSnapshot {
  if (!engine) return null;
  const state = engine.getState();
  const previousFields = snapshotFieldClonesByEngine.get(engine);
  const nextFields = new Map<string, unknown>();
  const snapshot: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(state)) {
    if (key === 'items' || key === 'streamingTail') continue;
    const previous = previousFields?.get(key);
    const clone = previousFields?.has(key) && isDeepStrictEqual(value, previous)
      ? previous
      : structuredClone(value);
    snapshot[key] = clone;
    nextFields.set(key, clone);
  }
  snapshotFieldClonesByEngine.set(engine, nextFields);
  const items = Array.isArray(state.items) ? state.items : [];
  const previousItems = snapshotItemsByEngine.get(engine);
  let cloned: unknown[];
  if (previousItems?.source === items) {
    cloned = previousItems.cloned;
  } else {
    cloned = [];
    for (const item of items) {
      const entry = sanitizedItemClone(item);
      if (entry.keep) cloned.push(entry.clone);
    }
    snapshotItemsByEngine.set(engine, { source: items, cloned });
  }
  snapshot.items = cloned;
  if (state.streamingTail != null) {
    const source = recordValue(state.streamingTail);
    let tail: unknown;
    if (source) {
      const cached = streamingTailClones.get(source);
      if (cached !== undefined) {
        tail = cached;
      } else {
        const { text, ...metadata } = source;
        tail = structuredClone(metadata);
        if (Object.hasOwn(source, 'text')) (tail as Record<string, unknown>).text = text;
        tail = sanitizeTranscriptItem(tail) ? tail : null;
        streamingTailClones.set(source, tail);
      }
      const textEpoch = (source as Record<PropertyKey, unknown>)[STREAMING_TAIL_TEXT_EPOCH];
      if (Number.isSafeInteger(textEpoch)) {
        // Enumerable symbols survive desktopSnapshot's object spread but are
        // ignored by Object.entries/structured clone, so this main-only hint
        // reaches IPC without entering the renderer wire contract.
        Object.defineProperty(snapshot, STREAMING_TAIL_TEXT_EPOCH, {
          value: textEpoch,
          enumerable: true,
        });
      }
    } else {
      tail = structuredClone(state.streamingTail);
      tail = sanitizeTranscriptItem(tail) ? tail : null;
    }
    snapshot.streamingTail = tail;
  }
  return projectDesktopLiveWorkState(snapshot);
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
