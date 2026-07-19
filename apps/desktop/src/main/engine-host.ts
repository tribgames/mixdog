import { mkdir, readFile, realpath, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { appendFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import type {
  DesktopCapability,
  DesktopCapabilityReadRequest,
  DesktopCapabilityReadResult,
  DesktopCapabilityResult,
  DesktopEngineState,
  DesktopModelCatalogOptions,
  DesktopSessionSummary,
  DesktopProjectSummary,
  DesktopModelOption,
  DesktopModelSelection,
  DesktopPromptContent,
  DesktopSubmitOptions,
  EngineSnapshot,
  ToolApprovalDecision,
} from '../shared/contract';
import { DESKTOP_CAPABILITIES } from '../shared/contract';
import {
  generatedSessionTitle,
  isGeneratedSessionTitleNoise,
  isSyntheticSessionDisplayText,
  normalizeSessionTitle,
  promptTitle,
  stripInjectedDisplayText,
  stripSessionEnvelope,
} from '../shared/session-title.mjs';
import { desktopSessionSummaries, desktopSnapshot } from './desktop-state';
import { searchProjectDirectory } from './project-file-search';

interface MixdogEngine {
  getState(): Record<string, unknown>;
  subscribe(listener: () => void): () => void;
  submit(prompt: DesktopPromptContent, options?: DesktopSubmitOptions): boolean;
  abort(): unknown;
  resolveToolApproval(id: string, decision: ToolApprovalDecision): boolean;
  listProviderModels(options: DesktopModelCatalogOptions): Promise<unknown>;
  setRoute(options: DesktopModelSelection & { applyToCurrentSession?: boolean }): Promise<boolean>;
  setFast(value: boolean): Promise<boolean | null>;
  listSessions(options?: { refreshFromStorage?: boolean }): Array<Record<string, unknown>>;
  deleteSession(id: string): Promise<boolean>;
  switchContext?(options: {
    cwd: string;
    desktopSession: { classification: 'task' | 'project'; projectPath: string | null } | null;
  }): Promise<boolean>;
  newSession(): Promise<boolean>;
  resume(id: string): Promise<boolean>;
  dispose(reason?: string): Promise<void>;
  [key: string]: unknown;
}

type SnapshotListener = (snapshot: EngineSnapshot) => void;
type EngineFactory = (options: Record<string, unknown>) => Promise<MixdogEngine>;

interface EngineHostOptions {
  userDataPath?: string;
  getUserDataPath?: () => string;
  createEngine?: EngineFactory;
  loadProjects?: () => Promise<MixdogProjectsModule>;
  packaged?: boolean;
  resourcesPath?: string;
  appPath?: string;
  searchProjectDirectory?: typeof searchProjectDirectory;
}

interface DesktopProjectPreferences {
  version: 2;
  aliases: Record<string, string>;
  pinned: string[];
  hidden: string[];
}

interface MixdogProject {
  name: string;
  path: string;
  addedAt: number;
  lastSelectedAt?: number;
}

interface MixdogProjectsModule {
  listProjects(): MixdogProject[];
  addProject(projectPath: string): MixdogProject | null;
  touchProjectSelected(projectPath: string): MixdogProject | null;
  renameProject(projectPath: string, name: string): MixdogProject | null;
  removeProject(projectPath: string): boolean;
  resolveProjectPath?(projectPath: string): string;
}

interface DesktopSessionMetadataFile {
  version: 2;
  titles: Record<string, string>;
  names: Record<string, string>;
}

type DesktopSessionScope = { classification: 'task' | 'project'; projectPath: string | null };

interface DesktopOAuthFlow {
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

interface StatuslineSegmentsModule {
  shellJobsStatus(options?: { clientHostPid?: number }): { count?: number; elapsedLabel?: string };
}

const EMPTY_PROJECT_PREFERENCES: DesktopProjectPreferences = {
  version: 2,
  aliases: {},
  pinned: [],
  hidden: [],
};

const DESKTOP_CAPABILITY_SET = new Set<string>(DESKTOP_CAPABILITIES);
const ENGINE_PUBLICATION_INTERVAL_MS = 50;
// Perf instrumentation (MIXDOG_DESKTOP_PERF=1): appends coarse stage timings
// to <userData>/desktop-perf.log so slow session-switch/settings reports can
// be diagnosed from a real run instead of guesses. Zero-cost when unset.
const DESKTOP_PERF_ENABLED = process.env.MIXDOG_DESKTOP_PERF === '1';
// shellJobsStatus itself is cache-only and refreshes its disk-backed cache
// asynchronously. Polling at the cache's 1s cadence keeps disk work out of the
// engine's 50ms publication path.
const SHELL_JOBS_ACTIVE_POLL_INTERVAL_MS = 1_000;
const SHELL_JOBS_IDLE_POLL_INTERVAL_MS = 5_000;

function normalizedProviderModels(value: unknown): DesktopModelOption[] {
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

function requiredApplicationPath(appPath: string | undefined): string {
  if (typeof appPath !== 'string' || !appPath.trim() || !isAbsolute(appPath)) {
    throw new TypeError('Electron application path must be an absolute path.');
  }
  return appPath;
}

function normalizedProjectKey(projectPath: string): string {
  const absolute = resolve(projectPath).replace(/[\\/]+$/, '');
  return process.platform === 'win32' ? absolute.toLowerCase() : absolute;
}

function matchingProjectPath(paths: readonly string[], projectPath: string): string | null {
  const target = normalizedProjectKey(projectPath);
  return paths.find((candidate) => normalizedProjectKey(candidate) === target) ?? null;
}

function withoutMatchingProject(paths: readonly string[], projectPath: string): string[] {
  const target = normalizedProjectKey(projectPath);
  return paths.filter((candidate) => normalizedProjectKey(candidate) !== target);
}

function projectAlias(
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

function recordValue(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function normalizedMarker(value: unknown): string {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

function hasExplicitInternalMarker(value: unknown, includeRoleAndKind = true): boolean {
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

function isInternalTranscriptItem(value: unknown): boolean {
  const item = recordValue(value);
  if (!item) return false;
  return hasExplicitInternalMarker(item)
    || hasExplicitInternalMarker(item.metadata, false);
}

function removeInternalToolDisplayMetadata(value: unknown): void {
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

function sanitizeTranscriptItem(value: unknown): boolean {
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
    if (visibleText !== item.text) item.text = visibleText;
    if (!visibleText.trim()) return false;
  }
  if (kind === 'tool') removeInternalToolDisplayMetadata(item);
  return true;
}

function sanitizeDesktopDisplaySnapshot(snapshot: Record<string, unknown>): Record<string, unknown> {
  if (Array.isArray(snapshot.items)) {
    snapshot.items = snapshot.items.filter(sanitizeTranscriptItem);
  }
  if (snapshot.streamingTail != null && !sanitizeTranscriptItem(snapshot.streamingTail)) {
    snapshot.streamingTail = null;
  }
  return snapshot;
}

function activeToolsFromSummary(value: unknown): DesktopEngineState['activeTools'] {
  const [exploreCount, exploreStartedAt, searchCount, searchStartedAt] = String(value || '')
    .split(':')
    .map((entry) => Number(entry) || 0);
  if (!exploreCount && !searchCount) return null;
  return {
    explore: { count: exploreCount, startedAt: exploreStartedAt },
    search: { count: searchCount, startedAt: searchStartedAt },
  };
}

const TERMINAL_AGENT_STATUS = /idle|done|complete|success|closed|error|fail|cancel|killed|timeout/i;

function projectedAgentEntry(value: unknown): Record<string, unknown> | null {
  const entry = recordValue(value);
  if (!entry) return null;
  const projected: Record<string, unknown> = {};
  for (const key of ['tag', 'agent', 'name', 'type', 'task_id', 'taskId', 'stage', 'status'] as const) {
    if (typeof entry[key] === 'string' && entry[key].trim()) projected[key] = entry[key];
  }
  const startedAt = entry.startedAt ?? entry.startTime ?? entry.createdAt;
  if ((typeof startedAt === 'number' && Number.isFinite(startedAt)) || typeof startedAt === 'string') {
    projected.startedAt = startedAt;
  }
  return projected;
}

export function projectDesktopLiveWorkState(snapshot: Record<string, unknown>): Record<string, unknown> {
  const workers = (Array.isArray(snapshot.agentWorkers) ? snapshot.agentWorkers : [])
    .flatMap((value) => {
      const entry = projectedAgentEntry(value);
      return entry && !TERMINAL_AGENT_STATUS.test(String(entry.stage || entry.status || '')) ? [entry] : [];
    });
  const jobs = (Array.isArray(snapshot.agentJobs) ? snapshot.agentJobs : [])
    .flatMap((value) => {
      const source = recordValue(value);
      const entry = projectedAgentEntry(value);
      if (!source || !entry || !/running/i.test(String(source.status || source.stage || ''))) return [];
      return [entry];
    });
  snapshot.agentWorkers = workers;
  snapshot.agentJobs = jobs;
  snapshot.activeTools = activeToolsFromSummary(snapshot.activeToolSummary);
  snapshot.remoteEnabled = snapshot.remoteEnabled === true;
  return snapshot;
}

function copySnapshot(engine: MixdogEngine | null): EngineSnapshot {
  if (!engine) return null;
  const displayCopy = structuredClone(engine.getState());
  const snapshot = sanitizeDesktopDisplaySnapshot(displayCopy);
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

function copyCapabilityValue<T>(value: T): T {
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

export class EngineHost {
  private engine: MixdogEngine | null = null;
  private currentProject: string | null = null;
  private recentProjects: string[] = [];
  private unsubscribeEngine: (() => void) | null = null;
  private readonly listeners = new Set<SnapshotListener>();
  private transition: Promise<void> = Promise.resolve();
  private readonly userDataPath: string | null;
  private readonly getUserDataPath: (() => string) | null;
  private readonly createEngineOverride: EngineFactory | null;
  private readonly loadProjectsModule: () => Promise<MixdogProjectsModule>;
  private readonly packaged: boolean;
  private readonly resourcesPath: string;
  private readonly appPath: string | undefined;
  private projectPreferences: DesktopProjectPreferences | null = null;
  private sessionTitles: Record<string, string> | null = null;
  private sessionNames: Record<string, string> | null = null;
  private sessionTitleWrite: Promise<void> = Promise.resolve();
  private engineWorkspace: string | null = null;
  private engineDesktopSession: DesktopSessionScope | null = null;
  private pendingFastPreference: boolean | null = null;
  private publicationHoldDepth = 0;
  private publicationPending = false;
  private publicationPendingSnapshot: EngineSnapshot | undefined;
  private publicationTimer: NodeJS.Timeout | null = null;
  private shellJobsTimer: NodeJS.Timeout | null = null;
  private shellJobsPollDelayMs = 0;
  private shellJobsModule: Promise<StatuslineSegmentsModule> | null = null;
  private shellJobs = { count: 0, elapsedLabel: '' };
  private readonly oauthFlows = new Map<string, DesktopOAuthFlow>();
  private oauthFlowSequence = 0;
  private readonly searchProjectDirectory: typeof searchProjectDirectory;

  constructor(options: EngineHostOptions = {}) {
    this.userDataPath = options.userDataPath ?? null;
    this.getUserDataPath = options.getUserDataPath ?? null;
    this.createEngineOverride = options.createEngine ?? null;
    this.packaged = options.packaged === true;
    this.resourcesPath = options.resourcesPath ?? process.resourcesPath;
    this.appPath = options.appPath;
    this.searchProjectDirectory = options.searchProjectDirectory ?? searchProjectDirectory;
    this.loadProjectsModule = options.loadProjects ?? (async () => import(
      /* @vite-ignore */ projectsModuleUrl(this.packaged, this.resourcesPath, this.appPath)
    ) as Promise<MixdogProjectsModule>);
    if (!this.packaged && !this.createEngineOverride) requiredApplicationPath(this.appPath);
  }

  subscribe(listener: SnapshotListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  getSnapshot(): EngineSnapshot {
    const cloneStarted = DESKTOP_PERF_ENABLED ? performance.now() : 0;
    const snapshot = desktopSnapshot(copySnapshot(this.engine), this.currentProject, this.recentProjects);
    if (DESKTOP_PERF_ENABLED) {
      const ms = performance.now() - cloneStarted;
      if (ms >= 5) {
        const items = Array.isArray(snapshot?.items) ? snapshot.items.length : 0;
        this.perfLog(`snapshot-clone ms=${ms.toFixed(1)} items=${items}`);
      }
    }
    const sessionId = String(snapshot?.sessionId || '');
    const desktopSessionTitle = sessionId
      ? this.sessionNames?.[sessionId] || this.sessionTitles?.[sessionId]
      : '';
    const decorated = {
      ...snapshot,
      ...(desktopSessionTitle ? { desktopSessionTitle } : {}),
      shellJobs: { ...this.shellJobs },
    };
    if (this.pendingFastPreference === null) return decorated;
    // Engine session state can lag one event-loop turn behind an applied Fast
    // preference. Keep overriding the snapshot until the engine reflects it,
    // then drop the pending marker instead of hard-failing the mutation.
    if (typeof snapshot?.fast === 'boolean' && snapshot.fast === this.pendingFastPreference) {
      this.pendingFastPreference = null;
      return decorated;
    }
    return { ...decorated, fast: this.pendingFastPreference };
  }

  async startProject(projectPath: string): Promise<EngineSnapshot> {
    const requestedPath = projectPath.trim();
    if (!requestedPath) throw new TypeError('A project folder is required.');

    let result: EngineSnapshot = null;
    await this.exclusive(async () => {
      await this.loadSessionTitles();
      const projectStore = await this.loadProjectsModule();
      const canonicalPath = await realpath(requestedPath);
      const info = await stat(canonicalPath);
      if (!info.isDirectory()) throw new TypeError('The selected project is not a directory.');

      await this.replaceEngine(canonicalPath, {
        classification: 'project',
        projectPath: canonicalPath,
      }, 'desktop-project-switch');
      this.currentProject = canonicalPath;
      const registered = projectStore.addProject(canonicalPath);
      if (!registered) throw new Error('Unable to register the selected project.');
      projectStore.touchProjectSelected(registered.path);
      const preferences = await this.loadProjectPreferences();
      preferences.hidden = withoutMatchingProject(preferences.hidden, registered.path);
      await this.saveProjectPreferences(projectStore);
      this.recentProjects = this.registeredProjects(projectStore)
        .map((project) => project.path)
        .slice(0, 12);
      // Return the same decorated state that is published. Returning the raw
      // engine snapshot here lets a renderer invoke response overwrite the
      // navigation metadata from the richer state publication.
      result = this.getSnapshot();
      this.publish();
    });
    return result;
  }

  async startProjectTask(projectPath: string): Promise<EngineSnapshot> {
    const requestedPath = projectPath.trim();
    if (!requestedPath) throw new TypeError('A project folder is required.');
    let result: EngineSnapshot = null;
    await this.exclusive(async () => {
      await this.loadSessionTitles();
      const projectStore = await this.loadProjectsModule();
      const registered = this.knownProject(projectStore, requestedPath);
      const canonicalPath = await this.canonicalDirectory(registered.path);
      await this.replaceEngine(canonicalPath, {
        classification: 'project',
        projectPath: canonicalPath,
      }, 'desktop-new-project-task');
      this.currentProject = canonicalPath;
      projectStore.touchProjectSelected(registered.path);
      this.recentProjects = this.registeredProjects(projectStore)
        .map((project) => project.path)
        .slice(0, 12);
      result = this.getSnapshot();
      this.publish();
    });
    return result;
  }

  async listProjects(): Promise<DesktopProjectSummary[]> {
    let projects: DesktopProjectSummary[] = [];
    await this.exclusive(async () => {
      const projectStore = await this.loadProjectsModule();
      const registered = this.registeredProjects(projectStore);
      const preferences = await this.loadProjectPreferences();
      projects = registered
        .map((project) => ({
          name: project.name,
          path: project.path,
          alias: projectAlias(preferences.aliases, project.path),
          pinned: matchingProjectPath(preferences.pinned, project.path) !== null,
        }))
        // Array#sort is stable. Explicitly pinned projects move to the front,
        // while both groups retain the core projects.json recency order.
        .sort((a, b) => Number(b.pinned) - Number(a.pinned));
      this.recentProjects = registered.map((project) => project.path).slice(0, 12);
    });
    return projects;
  }

  async projectDirectory(projectPath: string): Promise<string> {
    let directory = '';
    await this.exclusive(async () => {
      const projectStore = await this.loadProjectsModule();
      const registered = this.knownProject(projectStore, projectPath);
      directory = await this.canonicalDirectory(registered.path);
    });
    return directory;
  }

  async renameProject(projectPath: string, alias: string): Promise<void> {
    const displayAlias = alias.trim();
    if (displayAlias.length > 120 || /[\u0000-\u001f\u007f]/.test(displayAlias)) {
      throw new TypeError('Project name is invalid.');
    }
    await this.exclusive(async () => {
      const projectStore = await this.loadProjectsModule();
      const known = this.knownProject(projectStore, projectPath).path;
      const renamed = projectStore.renameProject(known, displayAlias);
      if (!renamed) throw new Error('Project is not available.');
      const preferences = await this.loadProjectPreferences();
      for (const candidate of Object.keys(preferences.aliases)) {
        if (normalizedProjectKey(candidate) === normalizedProjectKey(known)) {
          delete preferences.aliases[candidate];
        }
      }
      if (displayAlias) preferences.aliases[known] = displayAlias;
      await this.saveProjectPreferences(projectStore);
    });
  }

  async setProjectPinned(projectPath: string, pinned: boolean): Promise<void> {
    await this.exclusive(async () => {
      const projectStore = await this.loadProjectsModule();
      const known = this.knownProject(projectStore, projectPath).path;
      const preferences = await this.loadProjectPreferences();
      preferences.pinned = pinned
        ? [known, ...withoutMatchingProject(preferences.pinned, known)]
        : withoutMatchingProject(preferences.pinned, known);
      await this.saveProjectPreferences(projectStore);
    });
  }

  async removeProject(projectPath: string): Promise<void> {
    await this.exclusive(async () => {
      const projectStore = await this.loadProjectsModule();
      const known = this.knownProject(projectStore, projectPath).path;
      if (projectStore.removeProject(known) !== true) {
        throw new Error('Project is not available.');
      }
      const preferences = await this.loadProjectPreferences();
      preferences.hidden = [known, ...withoutMatchingProject(preferences.hidden, known)];
      preferences.pinned = withoutMatchingProject(preferences.pinned, known);
      await this.saveProjectPreferences(projectStore);
      this.recentProjects = this.registeredProjects(projectStore)
        .map((project) => project.path)
        .slice(0, 12);
    });
  }

  async startTask(): Promise<EngineSnapshot> {
    let result: EngineSnapshot = null;
    await this.exclusive(async () => {
      await this.loadSessionTitles();
      const workspace = await this.taskWorkspace();
      await this.replaceEngine(workspace, {
        classification: 'task',
        projectPath: null,
      }, 'desktop-new-task');
      this.currentProject = null;
      result = this.getSnapshot();
      this.publish();
    });
    return result;
  }

  async listSessions(): Promise<DesktopSessionSummary[]> {
    let summaries: DesktopSessionSummary[] = [];
    await this.exclusive(async () => {
      await this.loadSessionTitles();
      if (!this.engine) {
        const workspace = await this.taskWorkspace();
        await this.replaceEngine(workspace, {
          classification: 'task',
          projectPath: null,
        }, 'desktop-session-browser');
      }
      summaries = this.sessionSummaries();
    });
    return summaries;
  }

  async renameSession(sessionId: string, title: string): Promise<void> {
    if (!/^[A-Za-z0-9_-]+$/.test(sessionId)) throw new TypeError('session id is invalid.');
    const normalized = normalizeSessionTitle(title, '');
    if (!normalized) throw new TypeError('Session title is invalid.');
    await this.exclusive(async () => {
      await this.loadSessionTitles();
      if (!this.engine) {
        const workspace = await this.taskWorkspace();
        await this.replaceEngine(workspace, {
          classification: 'task',
          projectPath: null,
        }, 'desktop-session-rename');
      }
      if (!this.sessionSummaries().some((session) => session.id === sessionId)) {
        throw new Error('Session is not available.');
      }
      this.sessionNames![sessionId] = normalized;
      await this.queueSessionTitleWrite();
      if (String(this.engine?.getState()?.sessionId || '') === sessionId) this.publish();
    });
  }

  async deleteSession(sessionId: string): Promise<EngineSnapshot> {
    if (!/^[A-Za-z0-9_-]+$/.test(sessionId)) throw new TypeError('session id is invalid.');
    let result: EngineSnapshot = null;
    await this.exclusive(async () => {
      await this.withPublicationsHeld(async () => {
        await this.loadSessionTitles();
        if (!this.engine) {
          const workspace = await this.taskWorkspace();
          await this.replaceEngine(workspace, {
            classification: 'task',
            projectPath: null,
          }, 'desktop-session-delete');
        }
        const engine = this.requireEngine();
        const state = engine.getState();
        if (state.busy === true || state.commandBusy === true) {
          throw new Error('Engine is busy.');
        }
        let rawSessions = engine.listSessions() || [];
        let available = desktopSessionSummaries(
          rawSessions,
          String(state.sessionId || ''),
          this.sessionTitles || {},
          this.sessionNames || {},
        ).some((session) => session.id === sessionId);
        if (!available) {
          rawSessions = engine.listSessions({ refreshFromStorage: true }) || [];
          available = desktopSessionSummaries(
            rawSessions,
            String(state.sessionId || ''),
            this.sessionTitles || {},
            this.sessionNames || {},
          ).some((session) => session.id === sessionId);
        }
        if (!available) throw new Error('Session is not available.');
        if (await engine.deleteSession(sessionId) !== true) {
          throw new Error('Session could not be deleted.');
        }
        const hadMetadata = Object.prototype.hasOwnProperty.call(this.sessionTitles, sessionId)
          || Object.prototype.hasOwnProperty.call(this.sessionNames, sessionId);
        delete this.sessionTitles![sessionId];
        delete this.sessionNames![sessionId];
        if (hadMetadata) await this.queueSessionTitleWrite();
        result = this.getSnapshot();
        this.publish();
      });
    });
    return result;
  }

  async searchProjectFiles(
    projectIdOrWorkspaceId: string,
    query: string,
    limit = 50,
  ): Promise<string[]> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
      throw new TypeError('File search limit is invalid.');
    }
    const requested = projectIdOrWorkspaceId.trim();
    if (!requested) throw new TypeError('Project or workspace id is invalid.');
    if (typeof query !== 'string' || query.length > 1_024) {
      throw new TypeError('File search query is invalid.');
    }
    let root = '';
    await this.exclusive(async () => {
      const active = this.currentProject ?? this.engineWorkspace;
      if (!active || normalizedProjectKey(active) !== normalizedProjectKey(requested)) {
        throw new Error('Project or workspace is not active.');
      }
      root = await this.canonicalDirectory(active);
    });
    const results = await this.searchProjectDirectory(root, query, limit);
    await this.exclusive(async () => {
      const active = this.currentProject ?? this.engineWorkspace;
      if (!active || normalizedProjectKey(active) !== normalizedProjectKey(root)) {
        throw new Error('Project or workspace changed during file search.');
      }
    });
    return results;
  }

  async listProviderModels(options: DesktopModelCatalogOptions = {}): Promise<DesktopModelOption[]> {
    let models: DesktopModelOption[] = [];
    await this.exclusive(async () => {
      if (!this.engine) {
        const workspace = await this.taskWorkspace();
        await this.replaceEngine(workspace, {
          classification: 'task',
          projectPath: null,
        }, 'desktop-model-selector');
      }
      const refresh = options.force === true || options.refresh === true;
      const engine = this.requireEngine();
      if (refresh) {
        models = normalizedProviderModels(await engine.listProviderModels({ force: true, quick: false }));
      } else if (options.quick === true) {
        // Match the TUI picker: seed the authoritative secrets-aware request
        // before reading quick route rows. Starting these in separate renderer
        // IPC calls would serialize at EngineHost.exclusive and make the quick
        // response wait for the network catalog, so the ordering belongs here.
        // The following full desktop read joins this core promise.
        try {
          void Promise.resolve(engine.listProviderModels({ quick: false })).catch((error: unknown) => {
            console.warn('Desktop model catalog background refresh failed:', error);
          });
        } catch (error) {
          // Quick rows remain useful, but a synchronous setup failure should
          // still be diagnosable rather than disappearing into the warmup path.
          console.warn('Desktop model catalog background refresh could not start:', error);
        }
        models = normalizedProviderModels(await engine.listProviderModels({ quick: true }));
      } else {
        // A quick request starts the core's advisory no-secrets warmup. If a
        // full request arrives while that warmup is in flight, the first call
        // can legally join it and receive its partial provider set. A second
        // non-quick read is free when the first call was authoritative (the
        // core cache answers it), while after an advisory warmup it starts the
        // required secrets-aware load. This keeps the desktop catalog aligned
        // with /model without forcing a network refresh on every open.
        await engine.listProviderModels({ quick: false });
        models = normalizedProviderModels(await engine.listProviderModels({ quick: false }));
      }
    });
    return models;
  }

  async setModelRoute(selection: DesktopModelSelection): Promise<EngineSnapshot> {
    let result: EngineSnapshot = null;
    await this.exclusive(async () => {
      const engine = this.requireEngine();
      const state = engine.getState();
      // Match the TUI: a model change during an active turn is a preference for
      // the next session and must not rewrite the in-flight session. Concurrent
      // command mutations remain blocked.
      if (state.commandBusy === true) {
        throw new Error('Engine is busy.');
      }
      const model = normalizedProviderModels(await engine.listProviderModels({ quick: false }))
        .find((option) => option.provider === selection.provider && option.model === selection.model);
      if (!model) throw new Error('Selected provider/model is unavailable.');
      if (selection.effort !== undefined &&
        !model.effortOptions.some((option) => option.value === selection.effort)) {
        throw new Error('Selected effort is unavailable.');
      }
      if (selection.fast === true && !model.fastCapable) {
        throw new Error('Fast mode is unavailable for the selected provider/model.');
      }
      const latestState = engine.getState();
      if (latestState.commandBusy === true) {
        throw new Error('Engine is busy.');
      }
      // Preserve the engine's route contract: model changes are next-session
      // preferences unless the engine itself decides the current empty session
      // can safely adopt them. Rewriting a live route invalidates its provider-
      // keyed prompt cache.
      if (await engine.setRoute(selection) !== true) {
        throw new Error('Engine is busy.');
      }
      const routeState = engine.getState();
      // A successful route mutation supersedes any pristine Fast-only choice.
      // Keep an explicit route Fast value for the no-session renderer; when
      // omitted, let the engine's newly persisted route own the next session.
      this.pendingFastPreference = !routeState.sessionId && typeof selection.fast === 'boolean'
        ? selection.fast
        : null;
      result = this.getSnapshot();
      this.publish();
    });
    return result;
  }

  async setFast(enabled: boolean): Promise<EngineSnapshot> {
    let result: EngineSnapshot = null;
    await this.exclusive(async () => {
      if (!this.engine) {
        const workspace = await this.taskWorkspace();
        await this.replaceEngine(workspace, {
          classification: 'task',
          projectPath: null,
        }, 'desktop-fast-preference');
      }
      const engine = this.requireEngine();
      const state = engine.getState();
      if (state.busy === true || state.commandBusy === true) {
        throw new Error('Engine is busy.');
      }
      // The runtime owns capability resolution (including metadata that may
      // have arrived after the last renderer snapshot), so its setFast return
      // value is authoritative. A stale desktop fastCapable field must not
      // prevent the backend from applying a valid stored preference.
      const applied = await engine.setFast(enabled);
      if (applied !== enabled) {
        const latest = engine.getState();
        if (latest.busy === true || latest.commandBusy === true) {
          throw new Error('Engine is busy.');
        }
        throw new Error('Fast mode preference was not applied.');
      }
      const latest = engine.getState();
      const hasActiveSession = Boolean(latest.sessionId);
      // The route API is authoritative: `applied === enabled` here. Session-
      // derived state may lag one event-loop turn (or not exist yet), so a
      // mismatch is reconciled via the pending override instead of throwing —
      // the previous hard error surfaced as a user-facing toast on a state
      // race even though the preference was applied successfully.
      const reflected = hasActiveSession
        && typeof latest.fast === 'boolean' && latest.fast === applied;
      this.pendingFastPreference = reflected ? null : applied;
      result = this.getSnapshot();
      this.publish();
    });
    return result;
  }

  async resumeSession(sessionId: string): Promise<EngineSnapshot> {
    if (!/^[A-Za-z0-9_-]+$/.test(sessionId)) throw new TypeError('session id is invalid.');
    let result: EngineSnapshot = null;
    const totalStarted = DESKTOP_PERF_ENABLED ? performance.now() : 0;
    let stageNote = '';
    await this.exclusive(async () => {
      await this.withPublicationsHeld(async () => {
        await this.loadSessionTitles();
        if (!this.engine) {
          const workspace = await this.taskWorkspace();
          await this.replaceEngine(workspace, {
            classification: 'task',
            projectPath: null,
          }, 'desktop-session-browser');
        }
        if (String(this.engine?.getState()?.sessionId || '') === sessionId) {
          result = this.getSnapshot();
          return;
        }
        let rawSessions = this.engine?.listSessions() || [];
        let selected = desktopSessionSummaries(
          rawSessions,
          String(this.engine?.getState()?.sessionId || ''),
        ).find((row) => row.id === sessionId);
        // Session navigation is populated from this same cached catalog. Only
        // rescan storage if the requested row is absent (for example, a session
        // created by another process since the sidebar was loaded).
        if (!selected) {
          rawSessions = this.engine?.listSessions({ refreshFromStorage: true }) || [];
          selected = desktopSessionSummaries(
            rawSessions,
            String(this.engine?.getState()?.sessionId || ''),
          ).find((row) => row.id === sessionId);
        }
        if (!selected) throw new Error('Session is not available.');
        const rawSelected = rawSessions.find((row) => String(row.id || '') === sessionId);
        const storedDesktop = rawSelected?.desktopSession && typeof rawSelected.desktopSession === 'object'
          ? rawSelected.desktopSession as Record<string, unknown>
          : null;
        const isDesktopManaged = storedDesktop?.classification === 'task' ||
          storedDesktop?.classification === 'project';

        const workspace = selected.classification === 'task'
          ? await this.taskWorkspace()
          : await this.canonicalDirectory(selected.projectPath || selected.cwd);
        const desktopSession: DesktopSessionScope = selected.classification === 'project'
          ? { classification: 'project', projectPath: workspace }
          : { classification: 'task', projectPath: null };
        // Legacy CLI/TUI Lead sessions intentionally resume without a desktop
        // capability marker. The core then follows its historical resume path;
        // desktop-created rows still pass their durable marker and retain the
        // cross-class tamper guard.
        const targetDesktopSession = isDesktopManaged ? desktopSession : null;
        const sameManagedContext = Boolean(this.engine && this.engineWorkspace === workspace && (
          targetDesktopSession === null
            ? this.engineDesktopSession === null
            : this.engineDesktopSession?.classification === targetDesktopSession.classification &&
              this.engineDesktopSession?.projectPath === targetDesktopSession.projectPath
        ));
        const nextEngine = sameManagedContext
          ? this.requireEngine()
          : await (async () => {
            const replaceStarted = DESKTOP_PERF_ENABLED ? performance.now() : 0;
            const engine = await this.replaceEngine(workspace, targetDesktopSession, 'desktop-session-resume');
            if (DESKTOP_PERF_ENABLED) stageNote += ` replace-engine=${(performance.now() - replaceStarted).toFixed(0)}ms`;
            return engine;
          })();
        const resumeStarted = DESKTOP_PERF_ENABLED ? performance.now() : 0;
        if (await nextEngine.resume(sessionId) !== true) {
          if (!sameManagedContext) await this.disposeCurrent('desktop-session-resume-failed');
          throw new Error('Session could not be resumed.');
        }
        if (DESKTOP_PERF_ENABLED) stageNote += ` engine-resume=${(performance.now() - resumeStarted).toFixed(0)}ms`;
        if (String(nextEngine.getState()?.sessionId || '') !== sessionId) {
          if (!sameManagedContext) await this.disposeCurrent('desktop-session-resume-mismatch');
          throw new Error('Session resume returned an unexpected session.');
        }
        this.currentProject = selected.classification === 'project' ? workspace : null;
        this.rememberCurrentSessionTitle();
        result = this.getSnapshot();
        // The result is already a detached, renderer-safe snapshot. Reuse it
        // for the held publication instead of cloning a long transcript twice.
        this.publish(result);
      });
    });
    if (DESKTOP_PERF_ENABLED) {
      this.perfLog(`resume-session id=${sessionId} total=${(performance.now() - totalStarted).toFixed(0)}ms${stageNote}`);
    }
    return result;
  }

  async submit(prompt: DesktopPromptContent, options: DesktopSubmitOptions = {}): Promise<boolean> {
    const hasText = typeof prompt === 'string'
      ? Boolean(prompt.trim())
      : prompt.some((part) => part.type === 'image' || Boolean(part.text?.trim()));
    if (!hasText) return false;
    let accepted = false;
    await this.exclusive(async () => {
      const engine = this.requireEngine();
      // A blank desktop task owns only its workspace and route preferences.
      // Materialize the persisted runtime session at the first real submit so
      // merely opening a task or changing its model never writes/tombstones an
      // empty system/tool prompt.
      if (!String(engine.getState()?.sessionId || '')) {
        if (await engine.newSession() !== true) {
          throw new Error('Unable to create a task session for the first message.');
        }
        await this.applyPendingFastPreference(engine);
      }
      accepted = engine.submit(prompt, options);
      if (accepted) {
        const sessionId = String(engine.getState()?.sessionId || '');
        this.rememberSessionTitle(sessionId, promptTitle(prompt, options.displayText || ''));
      }
      this.publish();
    });
    return accepted;
  }

  async invokeCapability<T = unknown>(
    capability: DesktopCapability,
    args: unknown[] = [],
  ): Promise<DesktopCapabilityResult<T>> {
    if (!DESKTOP_CAPABILITY_SET.has(capability)) {
      throw new TypeError('Desktop capability is unavailable.');
    }
    if (capability === 'getOAuthProviderLoginStatus' ||
      capability === 'completeOAuthProviderLogin' || capability === 'cancelOAuthProviderLogin') {
      return this.invokeOAuthCapability<T>(capability, args);
    }
    let result: DesktopCapabilityResult<T> = { value: undefined as T, snapshot: null };
    await this.exclusive(async () => {
      if (!this.engine) {
        const workspace = await this.taskWorkspace();
        await this.replaceEngine(workspace, {
          classification: 'task',
          projectPath: null,
        }, `desktop-capability-${capability}`);
      }
      const engine = this.requireEngine();
      const method = engine[capability];
      if (typeof method !== 'function') {
        throw new Error(`The active Mixdog engine does not support ${capability}.`);
      }
      const rawValue = await (method as (...values: unknown[]) => unknown).apply(engine, args);
      const value = capability === 'beginOAuthProviderLogin'
        ? this.registerOAuthFlow(rawValue)
        : rawValue;
      result = { value: copyCapabilityValue(value) as T, snapshot: this.getSnapshot() };
      this.publish();
    });
    return result;
  }

  async readCapabilities(
    requests: ReadonlyArray<DesktopCapabilityReadRequest>,
  ): Promise<DesktopCapabilityReadResult[]> {
    let results: DesktopCapabilityReadResult[] = [];
    await this.exclusive(async () => {
      if (!this.engine) {
        const workspace = await this.taskWorkspace();
        await this.replaceEngine(workspace, {
          classification: 'task',
          projectPath: null,
        }, 'desktop-capability-read');
      }
      const engine = this.requireEngine();
      results = [];
      // Keep reads ordered inside one engine lease. Some getters lazily warm
      // shared caches, so parallel execution would turn a UI optimization into
      // a new backend concurrency contract.
      for (const request of requests) {
        try {
          const method = engine[request.capability];
          if (typeof method !== 'function') {
            throw new Error(`The active Mixdog engine does not support ${request.capability}.`);
          }
          const rawValue = await (method as (...values: unknown[]) => unknown)
            .apply(engine, request.args || []);
          results.push({ ok: true, value: copyCapabilityValue(rawValue) });
        } catch (reason) {
          results.push({
            ok: false,
            error: reason instanceof Error ? reason.message : String(reason),
          });
        }
      }
      // Read-only settings inspection neither mutates visible engine state nor
      // publishes it. This avoids cloning and serializing a long transcript
      // twice for every row in a settings section.
    });
    return results;
  }

  abort(): unknown {
    return this.requireEngine().abort();
  }

  resolveToolApproval(id: string, decision: ToolApprovalDecision): boolean {
    return this.requireEngine().resolveToolApproval(id, decision);
  }

  async dispose(): Promise<void> {
    await this.exclusive(async () => this.disposeCurrent('desktop-dispose'));
    await this.sessionTitleWrite;
    this.cancelScheduledPublication();
    this.stopShellJobsPolling();
    this.publish();
    this.listeners.clear();
  }

  private requireEngine(): MixdogEngine {
    if (!this.engine) throw new Error('No Mixdog project is active.');
    return this.engine;
  }

  private async applyPendingFastPreference(engine: MixdogEngine): Promise<void> {
    const preference = this.pendingFastPreference;
    if (preference === null) return;
    const current = engine.getState();
    if (typeof current.fast === 'boolean' && current.fast === preference) {
      this.pendingFastPreference = null;
      return;
    }
    const applied = await engine.setFast(preference);
    if (applied !== preference) {
      throw new Error('Fast mode preference was not applied to the new session.');
    }
    const latest = engine.getState();
    if (typeof latest.fast === 'boolean' && latest.fast !== preference) {
      throw new Error('Fast mode preference was not reflected by the new session.');
    }
    this.pendingFastPreference = null;
  }

  private publish(snapshot?: EngineSnapshot): void {
    this.cancelScheduledPublication();
    if (this.publicationHoldDepth > 0) {
      this.publicationPending = true;
      this.publicationPendingSnapshot = snapshot;
      return;
    }
    this.publishNow(snapshot);
  }

  private publishEngineEvent(): void {
    if (this.publicationHoldDepth > 0) {
      this.publicationPending = true;
      // An engine event after a prepared snapshot means that prepared value
      // may be stale. Fall back to a fresh snapshot when the hold is released.
      this.publicationPendingSnapshot = undefined;
      return;
    }
    if (this.listeners.size === 0 || this.publicationTimer) return;
    this.publicationTimer = setTimeout(() => {
      this.publicationTimer = null;
      if (this.publicationHoldDepth > 0) {
        this.publicationPending = true;
        this.publicationPendingSnapshot = undefined;
        return;
      }
      this.publishNow();
    }, ENGINE_PUBLICATION_INTERVAL_MS);
    this.publicationTimer.unref?.();
  }

  private cancelScheduledPublication(): void {
    if (!this.publicationTimer) return;
    clearTimeout(this.publicationTimer);
    this.publicationTimer = null;
  }

  private publishNow(snapshot?: EngineSnapshot): void {
    // Once a window has released its subscription, engine events have nowhere
    // to go. Avoid cloning a potentially long transcript until another window
    // subscribes.
    if (this.listeners.size === 0) return;
    const publishStarted = DESKTOP_PERF_ENABLED ? performance.now() : 0;
    const published = snapshot === undefined ? this.getSnapshot() : snapshot;
    for (const listener of this.listeners) listener(published);
    if (DESKTOP_PERF_ENABLED) {
      const ms = performance.now() - publishStarted;
      if (ms >= 10) this.perfLog(`publish ms=${ms.toFixed(1)}`);
    }
  }

  perfLog(line: string): void {
    if (!DESKTOP_PERF_ENABLED) return;
    try {
      appendFileSync(join(this.userDataRoot(), 'desktop-perf.log'), `${new Date().toISOString()} ${line}\n`);
    } catch { /* diagnostics only */ }
  }

  private async withPublicationsHeld<T>(action: () => Promise<T>): Promise<T> {
    this.publicationHoldDepth += 1;
    try {
      return await action();
    } finally {
      this.publicationHoldDepth -= 1;
      if (this.publicationHoldDepth === 0 && this.publicationPending) {
        this.publicationPending = false;
        const snapshot = this.publicationPendingSnapshot;
        this.publicationPendingSnapshot = undefined;
        this.publishNow(snapshot);
      }
    }
  }

  private async disposeCurrent(reason: string): Promise<void> {
    this.cancelOAuthFlows();
    const current = this.engine;
    this.engine = null;
    this.stopShellJobsPolling();
    this.shellJobs = { count: 0, elapsedLabel: '' };
    this.engineWorkspace = null;
    this.engineDesktopSession = null;
    try {
      this.unsubscribeEngine?.();
    } catch (error) {
      // A broken unsubscribe must not retain the engine by preventing disposal.
      console.error('Failed to unsubscribe from the Mixdog engine:', error);
    }
    this.unsubscribeEngine = null;
    if (current) await current.dispose(reason);
  }

  private registerOAuthFlow(value: unknown): Record<string, unknown> {
    const started = recordValue(value);
    if (!started) throw new Error('OAuth provider did not return a login flow.');
    const provider = String(started.provider || '').trim();
    if (!provider) throw new Error('OAuth provider login is missing its provider id.');
    const id = `oauth_${Date.now().toString(36)}_${(++this.oauthFlowSequence).toString(36)}`;
    const flow: DesktopOAuthFlow = {
      id,
      provider,
      url: typeof started.url === 'string' ? started.url : null,
      manualUrl: typeof started.manualUrl === 'string' ? started.manualUrl : null,
      state: 'pending',
      result: null,
      error: null,
      completeCode: typeof started.completeCode === 'function'
        ? started.completeCode as (code: string) => Promise<unknown>
        : undefined,
      cancel: typeof started.cancel === 'function' ? started.cancel as () => unknown : undefined,
      timeout: setTimeout(() => {
        const current = this.oauthFlows.get(id);
        if (!current) return;
        this.cancelOAuthFlow(current, 'expired');
        this.oauthFlows.delete(id);
      }, 10 * 60 * 1_000),
    };
    flow.timeout.unref?.();
    this.oauthFlows.set(id, flow);
    const waitForCallback = started.waitForCallback;
    if (waitForCallback && typeof (waitForCallback as PromiseLike<unknown>).then === 'function') {
      void Promise.resolve(waitForCallback).then((result) => {
        const current = this.oauthFlows.get(id);
        if (!current || current.state !== 'pending' || !result) return;
        current.state = 'complete';
        current.result = true;
      }).catch((error) => {
        const current = this.oauthFlows.get(id);
        if (!current || current.state !== 'pending') return;
        current.state = 'failed';
        current.error = error instanceof Error ? error.message : String(error);
      });
    }
    return this.oauthFlowStatus(flow);
  }

  private async invokeOAuthCapability<T>(
    capability: 'getOAuthProviderLoginStatus' | 'completeOAuthProviderLogin' | 'cancelOAuthProviderLogin',
    args: unknown[],
  ): Promise<DesktopCapabilityResult<T>> {
    const id = String(args[0] || '').trim();
    if (!/^oauth_[a-z0-9_]+$/i.test(id)) throw new TypeError('OAuth flow id is invalid.');
    const flow = this.oauthFlows.get(id);
    if (!flow) throw new Error('OAuth login flow is no longer available.');
    if (capability === 'completeOAuthProviderLogin') {
      if (!flow.completeCode) throw new Error('This OAuth provider does not accept a manual code.');
      const code = String(args[1] || '').trim();
      if (!code || code.length > 16_384) throw new TypeError('OAuth code is invalid.');
      try {
        const completed = await flow.completeCode(code);
        flow.result = Boolean(completed);
        flow.state = completed ? 'complete' : 'failed';
        flow.error = completed ? null : 'OAuth code did not complete the login.';
      } catch (error) {
        flow.state = 'failed';
        flow.error = error instanceof Error ? error.message : String(error);
        throw error;
      }
    } else if (capability === 'cancelOAuthProviderLogin') {
      try { await flow.cancel?.(); } finally {
        flow.state = 'cancelled';
        clearTimeout(flow.timeout);
      }
    }
    const value = this.oauthFlowStatus(flow) as T;
    if (capability === 'cancelOAuthProviderLogin') this.oauthFlows.delete(id);
    this.publish();
    return { value, snapshot: this.getSnapshot() };
  }

  private oauthFlowStatus(flow: DesktopOAuthFlow): Record<string, unknown> {
    return {
      flowId: flow.id,
      provider: flow.provider,
      url: flow.url,
      manualUrl: flow.manualUrl,
      state: flow.state,
      completed: flow.state === 'complete',
      error: flow.error,
      manualCodeSupported: Boolean(flow.completeCode),
    };
  }

  private cancelOAuthFlows(): void {
    for (const flow of this.oauthFlows.values()) {
      clearTimeout(flow.timeout);
      this.cancelOAuthFlow(flow, 'disposed');
    }
    this.oauthFlows.clear();
  }

  private cancelOAuthFlow(flow: DesktopOAuthFlow, reason: string): void {
    try {
      const result = flow.cancel?.();
      if (result && typeof (result as PromiseLike<unknown>).then === 'function') {
        void Promise.resolve(result).catch((error: unknown) => {
          console.warn(`OAuth flow could not be ${reason}:`, error);
        });
      }
    } catch (error) {
      console.warn(`OAuth flow could not be ${reason}:`, error);
    }
  }

  private async taskWorkspace(): Promise<string> {
    const root = this.userDataPath ?? this.getUserDataPath?.();
    if (!root) throw new Error('Electron userData path is unavailable.');
    const workspace = join(root, 'workspace', 'unclassified');
    await mkdir(workspace, { recursive: true });
    return realpath(workspace);
  }

  private async canonicalDirectory(input: string): Promise<string> {
    if (!input) throw new TypeError('Session workspace is unavailable.');
    const canonical = await realpath(input);
    if (!(await stat(canonical)).isDirectory()) throw new TypeError('Session workspace is not a directory.');
    return canonical;
  }

  private userDataRoot(): string {
    const root = this.userDataPath ?? this.getUserDataPath?.();
    if (!root) throw new Error('Electron userData path is unavailable.');
    return root;
  }

  private async loadProjectPreferences(): Promise<DesktopProjectPreferences> {
    if (this.projectPreferences) return this.projectPreferences;
    let parsed: Partial<DesktopProjectPreferences> = {};
    try {
      parsed = JSON.parse(await readFile(join(this.userDataRoot(), 'desktop-projects.json'), 'utf8'));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw new Error('Desktop project preferences could not be loaded.');
      }
    }
    const strings = (value: unknown) => Array.isArray(value)
      ? value.filter((entry): entry is string => typeof entry === 'string' && Boolean(entry)).slice(0, 50)
      : [];
    const aliases = parsed.aliases && typeof parsed.aliases === 'object'
      ? Object.fromEntries(Object.entries(parsed.aliases).filter(([path, alias]) =>
        Boolean(path) && typeof alias === 'string' && alias.length <= 120).slice(0, 200))
      : {};
    this.projectPreferences = {
      version: 2,
      aliases,
      pinned: [...new Set(strings(parsed.pinned))],
      hidden: [...new Set(strings(parsed.hidden))],
    };
    return this.projectPreferences;
  }

  private async saveProjectPreferences(projectStore?: MixdogProjectsModule): Promise<void> {
    if (!this.projectPreferences) return;
    if (projectStore) {
      const registeredPaths = this.registeredProjects(projectStore).map((project) => project.path);
      this.projectPreferences.pinned = this.projectPreferences.pinned.filter((candidate) =>
        matchingProjectPath(registeredPaths, candidate) !== null);
      // `hidden` is retained only as a legacy desktop tombstone. A path that
      // the shared core store currently registers must always be visible.
      this.projectPreferences.hidden = this.projectPreferences.hidden.filter((candidate) =>
        matchingProjectPath(registeredPaths, candidate) === null);
    }
    const root = this.userDataRoot();
    await mkdir(root, { recursive: true });
    await writeFile(
      join(root, 'desktop-projects.json'),
      `${JSON.stringify(this.projectPreferences, null, 2)}\n`,
      { encoding: 'utf8', mode: 0o600 },
    );
  }

  private registeredProjects(projectStore: MixdogProjectsModule): MixdogProject[] {
    const listed = projectStore.listProjects();
    if (!Array.isArray(listed)) return [];
    return listed.flatMap((entry): MixdogProject[] => {
      if (!entry || typeof entry !== 'object') return [];
      const path = typeof entry.path === 'string' ? entry.path.trim() : '';
      if (!path || !isAbsolute(path)) return [];
      const name = typeof entry.name === 'string' && entry.name.trim()
        ? entry.name.trim()
        : path;
      return [{
        name,
        path,
        addedAt: Number(entry.addedAt) || 0,
        ...(Number(entry.lastSelectedAt) > 0
          ? { lastSelectedAt: Number(entry.lastSelectedAt) }
          : {}),
      }];
    });
  }

  private knownProject(projectStore: MixdogProjectsModule, projectPath: string): MixdogProject {
    const requested = projectPath.trim();
    if (!requested) throw new Error('Project is not available.');
    const resolved = projectStore.resolveProjectPath?.(requested) || resolve(requested);
    const key = normalizedProjectKey(resolved);
    const project = this.registeredProjects(projectStore)
      .find((entry) => normalizedProjectKey(entry.path) === key);
    if (!project) throw new Error('Project is not available.');
    return project;
  }

  private async loadEngine(options: Record<string, unknown>): Promise<MixdogEngine> {
    if (this.createEngineOverride) return this.createEngineOverride(options);
    // Keep the engine external to the desktop bundle. Production resolves the
    // curated runtime resource; development resolves the same source tree.
    const engineModule = (await import(
      /* @vite-ignore */ engineModuleUrl(this.packaged, this.resourcesPath, this.appPath)
    )) as {
      createEngineSession(options?: Record<string, unknown>): Promise<MixdogEngine>;
    };
    return engineModule.createEngineSession(options);
  }

  private async replaceEngine(
    cwd: string,
    desktopSession: DesktopSessionScope | null,
    reason: string,
  ): Promise<MixdogEngine> {
    this.currentProject = null;
    const current = this.engine;
    const previousCwd = process.cwd();
    if (current?.switchContext) {
      this.cancelOAuthFlows();
      process.chdir(cwd);
      try {
        if (await current.switchContext({ cwd, desktopSession }) !== true) {
          throw new Error('Engine context switch was rejected.');
        }
        this.engineWorkspace = cwd;
        this.engineDesktopSession = desktopSession;
        this.publish();
        return current;
      } catch {
        process.chdir(previousCwd);
        try {
          await this.disposeCurrent(`${reason}-context-recovery`);
        } finally {
          this.publish();
        }
      }
    } else {
      try {
        await this.disposeCurrent(reason);
      } finally {
        this.publish();
      }
    }
    process.chdir(cwd);
    let nextEngine: MixdogEngine;
    try {
      nextEngine = await this.loadEngine({
        remote: false,
        cwd,
        ...(desktopSession ? { desktopSession } : {}),
      });
    } catch (error) {
      process.chdir(previousCwd);
      throw error;
    }
    this.engine = nextEngine;
    this.engineWorkspace = cwd;
    this.engineDesktopSession = desktopSession;
    try {
      this.unsubscribeEngine = nextEngine.subscribe(() => this.handleEngineEvent());
      this.startShellJobsPolling();
    } catch (error) {
      process.chdir(previousCwd);
      try {
        await this.disposeCurrent(`${reason}-subscribe-failed`);
      } catch (cleanupError) {
        console.error('Failed to dispose an engine after subscription setup failed:', cleanupError);
      }
      throw error;
    }
    return nextEngine;
  }

  private startShellJobsPolling(): void {
    this.stopShellJobsPolling();
    this.scheduleShellJobsPoll(true);
  }

  private handleEngineEvent(): void {
    this.publishEngineEvent();
    const desiredDelay = shellJobsPollDelay(this.engine?.getState() || null, this.shellJobs.count);
    if (!this.shellJobsTimer || desiredDelay < this.shellJobsPollDelayMs) {
      this.scheduleShellJobsPoll(true);
    }
  }

  private scheduleShellJobsPoll(immediate = false): void {
    if (!this.engine) return;
    if (this.shellJobsTimer) clearTimeout(this.shellJobsTimer);
    this.shellJobsPollDelayMs = shellJobsPollDelay(this.engine.getState(), this.shellJobs.count);
    this.shellJobsTimer = setTimeout(
      () => {
        this.shellJobsTimer = null;
        void this.pollShellJobs();
      },
      immediate ? 0 : this.shellJobsPollDelayMs,
    );
    this.shellJobsTimer.unref?.();
  }

  private async pollShellJobs(): Promise<void> {
    const ownerPid = Number(this.engine?.getState()?.clientHostPid) || 0;
    if (!ownerPid) {
      this.scheduleShellJobsPoll();
      return;
    }
    try {
      this.shellJobsModule ??= import(
        /* @vite-ignore */ statuslineSegmentsModuleUrl(this.packaged, this.resourcesPath, this.appPath)
      ) as Promise<StatuslineSegmentsModule>;
      const module = await this.shellJobsModule;
      const value = module.shellJobsStatus({ clientHostPid: ownerPid });
      const next = {
        count: Math.max(0, Number(value?.count) || 0),
        elapsedLabel: String(value?.elapsedLabel || ''),
      };
      if (next.count !== this.shellJobs.count || next.elapsedLabel !== this.shellJobs.elapsedLabel) {
        this.shellJobs = next;
        this.publishEngineEvent();
      }
    } catch {
      // The status strip is optional; engine activity remains publishable if
      // the external runtime module is unavailable.
    } finally {
      this.scheduleShellJobsPoll();
    }
  }

  private stopShellJobsPolling(): void {
    if (!this.shellJobsTimer) return;
    clearInterval(this.shellJobsTimer);
    this.shellJobsTimer = null;
    this.shellJobsPollDelayMs = 0;
  }

  private sessionSummaries(): DesktopSessionSummary[] {
    const currentId = String(this.engine?.getState()?.sessionId || '');
    const rows = this.engine?.listSessions() || [];
    return desktopSessionSummaries(
      rows,
      currentId,
      this.sessionTitles || {},
      this.sessionNames || {},
    );
  }

  private async loadSessionTitles(): Promise<Record<string, string>> {
    if (this.sessionTitles && this.sessionNames) return this.sessionTitles;
    let parsed: Record<string, unknown> = {};
    try {
      const value: unknown = JSON.parse(
        await readFile(join(this.userDataRoot(), 'desktop-session-metadata.json'), 'utf8'),
      );
      if (value !== null && typeof value === 'object' && !Array.isArray(value) &&
        (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)) {
        parsed = value as Record<string, unknown>;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' && !(error instanceof SyntaxError)) {
        throw new Error('Desktop session metadata could not be loaded.');
      }
    }
    let generatedMetadataChanged = false;
    const normalizedMap = (source: unknown, generated = false): Record<string, string> => {
      const result = Object.create(null) as Record<string, string>;
      if (!source || typeof source !== 'object' || Array.isArray(source)) return result;
      for (const [id, value] of Object.entries(source)) {
        if (!/^[A-Za-z0-9_-]+$/.test(id) || typeof value !== 'string') continue;
        const title = generated
          ? generatedSessionTitle(value, '')
          : normalizeSessionTitle(value, '');
        if (generated && title !== value.trim()) generatedMetadataChanged = true;
        if (title) result[id] = title;
      }
      return result;
    };
    const legacy = parsed.version !== 2;
    this.sessionTitles = legacy
      ? Object.create(null) as Record<string, string>
      : normalizedMap(parsed.titles, true);
    this.sessionNames = normalizedMap(legacy ? parsed.titles : parsed.names);
    if (!legacy && generatedMetadataChanged) await this.queueSessionTitleWrite();
    return this.sessionTitles;
  }

  private rememberCurrentSessionTitle(): void {
    const state = this.engine?.getState();
    const firstUser = Array.isArray(state?.items)
      ? state.items.find((item) => {
        if (!item || typeof item !== 'object') return false;
        const candidate = item as Record<string, unknown>;
        return candidate.kind === 'user' &&
          !isGeneratedSessionTitleNoise(candidate.text) &&
          Boolean(generatedSessionTitle(candidate.text, ''));
      }) as Record<string, unknown> | undefined
      : undefined;
    const firstUserText = String(firstUser?.text || '');
    this.rememberSessionTitle(
      String(state?.sessionId || ''),
      generatedSessionTitle(firstUserText, /\[Image\b/i.test(firstUserText) ? '[Image]' : ''),
    );
  }

  private rememberSessionTitle(sessionId: string, title: string): void {
    if (!this.sessionTitles || !/^[A-Za-z0-9_-]+$/.test(sessionId) ||
      this.sessionNames?.[sessionId] || this.sessionTitles[sessionId]) return;
    const normalized = generatedSessionTitle(title, '');
    if (!normalized) return;
    this.sessionTitles[sessionId] = normalized;
    void this.queueSessionTitleWrite();
  }

  private queueSessionTitleWrite(): Promise<void> {
    const titles = Object.fromEntries(Object.entries(this.sessionTitles || {}));
    const names = Object.fromEntries(Object.entries(this.sessionNames || {}));
    this.sessionTitleWrite = this.sessionTitleWrite.then(async () => {
      const root = this.userDataRoot();
      await mkdir(root, { recursive: true });
      const target = join(root, 'desktop-session-metadata.json');
      const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
      try {
        const metadata: DesktopSessionMetadataFile = {
          version: 2,
          titles,
          names,
        };
        await writeFile(temporary, `${JSON.stringify(metadata, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
        await rename(temporary, target);
      } catch (error) {
        await unlink(temporary).catch(() => undefined);
        throw error;
      }
    }).catch((error: unknown) => {
      console.error('Failed to persist desktop session metadata:', error);
    });
    return this.sessionTitleWrite;
  }

  private async exclusive(action: () => Promise<void>): Promise<void> {
    const run = this.transition.then(action, action);
    this.transition = run.catch(() => undefined);
    await run;
  }
}
