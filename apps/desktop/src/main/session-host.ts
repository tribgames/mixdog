import { randomUUID } from 'node:crypto';
import { watch, type FSWatcher } from 'node:fs';
import { mkdir, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

import type {
  DesktopAbortOptions,
  DesktopAgentPoolRow,
  DesktopCapability,
  DesktopCapabilityReadRequest,
  DesktopCapabilityReadResult,
  DesktopCapabilityResult,
  DesktopModelCatalogOptions,
  DesktopModelOption,
  DesktopModelSelection,
  DesktopNewTaskDraft,
  DesktopNewTaskSubmitResult,
  DesktopProjectSummary,
  DesktopPromptContent,
  DesktopSessionStateUpdate,
  DesktopSessionSummary,
  DesktopSubmitOptions,
  SessionSnapshot,
  ToolApprovalDecision,
} from '../shared/contract';
import { DESKTOP_READ_CAPABILITIES } from '../shared/contract';
import {
  normalizeSessionTitle,
  promptTitle,
} from '../shared/session-title.mjs';
import { desktopSessionSummaries } from './desktop-state';
import type { DesktopService, SerializableDesktopServiceOptions } from './desktop-service-contract';
import {
  DESKTOP_TRANSCRIPT_ITEM_LIMIT,
  copyCapabilityValue,
  normalizedProviderModels,
  type MixdogProjectsModule,
  type MixdogSessionStoreModule,
  type StatuslineSegmentsModule,
} from './desktop-support';
import { DesktopProjectRegistry } from './desktop-project-registry';
import { DesktopSessionMetadata } from './desktop-session-metadata';
import { createShellJobsPoller } from './shell-jobs-poller';
import { searchProjectDirectory } from './project-file-search';
import {
  codeGraphQueryIn,
  copyProjectEntryIn,
  createProjectEntryIn,
  listProjectDirIn,
  moveProjectEntryIn,
  projectEntryPathIn,
  readProjectTextFileIn,
  renameProjectEntryIn,
  statProjectFileIn,
  writeProjectTextFileIn,
} from './project-files';

export interface SessionClient {
  list(args?: Record<string, unknown>, options?: { callId?: string }): Promise<Record<string, unknown>>;
  create(args?: Record<string, unknown>, options?: { callId?: string }): Promise<Record<string, unknown>>;
  read(args?: Record<string, unknown>, options?: { callId?: string }): Promise<Record<string, unknown>>;
  subscribe(args?: Record<string, unknown>, options?: { callId?: string }): Promise<Record<string, unknown>>;
  unsubscribe(args?: Record<string, unknown>, options?: { callId?: string }): Promise<Record<string, unknown>>;
  submit(args?: Record<string, unknown>, options?: { callId?: string }): Promise<Record<string, unknown>>;
  abort(args?: Record<string, unknown>, options?: { callId?: string }): Promise<Record<string, unknown>>;
  approve(args?: Record<string, unknown>, options?: { callId?: string }): Promise<Record<string, unknown>>;
  configure(args?: Record<string, unknown>, options?: { callId?: string }): Promise<Record<string, unknown>>;
  close(reason?: string): Promise<void>;
}

export interface SessionHostRuntime {
  attachSessionClient(options: {
    onFrame(frame: Record<string, unknown>): void;
    onFatal?(reason: string): void;
  }): Promise<SessionClient>;
  loadProjects(): Promise<MixdogProjectsModule>;
  loadSessionStore(): Promise<MixdogSessionStoreModule>;
  loadStatuslineSegments(): Promise<StatuslineSegmentsModule>;
  executeCodeGraphTool(
    name: string,
    args: Record<string, unknown>,
    cwd: string,
  ): Promise<unknown>;
}

type SessionProjection = {
  revision: number;
  snapshot: SessionSnapshot;
};

const READ_CAPABILITIES = new Set<string>(DESKTOP_READ_CAPABILITIES);

function statePatch(
  snapshot: SessionSnapshot,
  patch: Record<string, unknown>,
): SessionSnapshot {
  const base = snapshot && typeof snapshot === 'object' ? snapshot : {};
  const set = patch.set && typeof patch.set === 'object' && !Array.isArray(patch.set)
    ? patch.set as Record<string, unknown>
    : {};
  const next: Record<string, unknown> = { ...base, ...set };
  const append = patch.itemsAppend && typeof patch.itemsAppend === 'object'
    ? patch.itemsAppend as Record<string, unknown>
    : null;
  if (append) {
    const items = Array.isArray(base.items) ? base.items : [];
    const from = Math.max(0, Math.floor(Number(append.from) || 0));
    next.items = items.slice(0, from).concat(
      Array.isArray(append.values) ? append.values : [],
    );
  }
  for (const key of Array.isArray(patch.remove) ? patch.remove : []) {
    if (typeof key === 'string') delete next[key];
  }
  return next as SessionSnapshot;
}

function dataDirectory(): string {
  if (process.env.MIXDOG_DATA_DIR) return process.env.MIXDOG_DATA_DIR;
  return join(process.env.MIXDOG_HOME || join(homedir(), '.mixdog'), 'data');
}

function sessionIdOf(value: unknown): string {
  const id = String(value || '');
  if (!/^[A-Za-z0-9_-]+$/.test(id)) throw new TypeError('session id is invalid.');
  return id;
}

/**
 * Service-native host used by every visual client.
 *
 * It owns no current session runtime and never parks, swaps, or disposes an execution
 * runtime. The singleton daemon owns session entries; this class only issues
 * session-addressed commands, projects their event stream, and exposes the
 * daemon's non-session project/catalog services to transports.
 */
export class SessionHost implements DesktopService {
  private readonly listeners = new Set<(snapshot: SessionSnapshot) => void>();
  private readonly sessionListeners = new Set<(sessions: DesktopSessionSummary[]) => void>();
  private readonly agentPoolListeners = new Set<(agents: DesktopAgentPoolRow[]) => void>();
  private readonly sessionStateListeners = new Set<(update: DesktopSessionStateUpdate) => void>();
  private readonly sessionProjections = new Map<string, SessionProjection>();
  private readonly visibleSessionIds = new Set<string>();
  /** A new runtime exists on disk before its first prompt/title is accepted.
   *  Keep watcher scans from exposing that half-created row ahead of the
   *  renderer's atomic draft promotion. */
  private readonly pendingCatalogSessionIds = new Set<string>();
  private readonly projects: DesktopProjectRegistry;
  private readonly sessionMetadata: DesktopSessionMetadata;
  private readonly sessionClient: SessionClient;
  private readonly shellJobsPoller: ReturnType<typeof createShellJobsPoller>;
  private readonly taskWorkspacePath: string;
  private shellSnapshot: SessionSnapshot = null;
  private controlSessionId = '';
  private controlSessionPromise: Promise<string> | null = null;
  private rawSessionRows: Array<Record<string, unknown>> = [];
  private sessionCatalogLoaded = false;
  private sessionCatalogPromise: Promise<DesktopSessionSummary[]> | null = null;
  private storeWatcher: FSWatcher | null = null;
  private storeRefreshTimer: NodeJS.Timeout | null = null;
  private remoteSessionId = '';
  private disposed = false;

  private constructor(
    private readonly options: SerializableDesktopServiceOptions,
    private readonly runtime: SessionHostRuntime,
    sessionClient: SessionClient,
  ) {
    this.sessionClient = sessionClient;
    this.shellJobsPoller = createShellJobsPoller({
      getEngineState: () => this.shellSnapshot && typeof this.shellSnapshot === 'object'
        ? this.shellSnapshot as Record<string, unknown>
        : null,
      moduleUrl: () => '',
      loadModule: runtime.loadStatuslineSegments,
      onChange: (sessionIds) => this.publishShellJobChanges(sessionIds),
    });
    this.taskWorkspacePath = join(options.userDataPath, 'workspace', 'unclassified');
    this.projects = new DesktopProjectRegistry({
      loadProjectsModule: runtime.loadProjects,
      userDataRoot: () => options.userDataPath,
    });
    this.sessionMetadata = new DesktopSessionMetadata(() => options.userDataPath);
  }

  static async create(
    options: SerializableDesktopServiceOptions,
    runtime: SessionHostRuntime,
  ): Promise<SessionHost> {
    let host: SessionHost | null = null;
    const sessionClient = await runtime.attachSessionClient({
      onFrame(frame) {
        host?.handleSessionFrame(frame);
      },
      onFatal() {
        host?.handleSessionTransportLoss();
      },
    });
    host = new SessionHost(options, runtime, sessionClient);
    host.shellJobsPoller.start();
    return host;
  }

  getSnapshot(): SessionSnapshot {
    return this.shellSnapshot;
  }

  subscribe(listener: (snapshot: SessionSnapshot) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  subscribeSessions(listener: (sessions: DesktopSessionSummary[]) => void): () => void {
    this.sessionListeners.add(listener);
    this.ensureStoreWatcher();
    return () => this.sessionListeners.delete(listener);
  }

  subscribeAgentPool(listener: (agents: DesktopAgentPoolRow[]) => void): () => void {
    this.agentPoolListeners.add(listener);
    this.ensureStoreWatcher();
    return () => this.agentPoolListeners.delete(listener);
  }

  subscribeSessionStates(listener: (update: DesktopSessionStateUpdate) => void): () => void {
    this.sessionStateListeners.add(listener);
    return () => this.sessionStateListeners.delete(listener);
  }

  private snapshotWithRemoteSession(snapshot: SessionSnapshot): SessionSnapshot {
    if (!snapshot || typeof snapshot !== 'object') return snapshot;
    return {
      ...snapshot,
      remoteEnabled: Boolean(this.remoteSessionId),
      remoteSessionId: this.remoteSessionId || null,
    };
  }

  private applyRemoteSessionState(value: unknown): void {
    const state = value && typeof value === 'object'
      ? value as Record<string, unknown>
      : {};
    const candidate = String(state.sessionId || '');
    const next = state.enabled === true
      && candidate.length <= 256
      && /^[A-Za-z0-9_-]+$/.test(candidate)
      ? candidate
      : '';
    if (next === this.remoteSessionId) return;
    this.remoteSessionId = next;
    if (this.shellSnapshot) this.publishShell(this.shellSnapshot);
    for (const sessionId of this.visibleSessionIds) {
      const projection = this.sessionProjections.get(sessionId);
      if (projection) this.publishSession(sessionId, projection.snapshot);
    }
  }

  private publishShell(snapshot: SessionSnapshot): void {
    const visibleSnapshot = this.snapshotWithRemoteSession(snapshot);
    this.shellSnapshot = visibleSnapshot;
    for (const listener of [...this.listeners]) {
      try { listener(visibleSnapshot); } catch { /* a presentation listener owns its failure */ }
    }
    this.shellJobsPoller.onEngineEvent();
  }

  private snapshotWithShellJobs(sessionId: string, snapshot: SessionSnapshot): SessionSnapshot {
    if (!snapshot || typeof snapshot !== 'object') return snapshot;
    const shellJobs = this.shellJobsPoller.statusFor(sessionId);
    const hostShellJobs = this.shellJobsPoller.status;
    return {
      ...snapshot,
      shellJobs: { ...shellJobs, jobs: [...shellJobs.jobs] },
      hostShellJobs: { ...hostShellJobs, jobs: [...hostShellJobs.jobs] },
    };
  }

  private publishShellJobChanges(sessionIds: readonly string[]): void {
    for (const sessionId of sessionIds) {
      const projection = this.sessionProjections.get(sessionId);
      if (projection) this.publishSession(sessionId, projection.snapshot);
    }
  }

  private publishSession(sessionId: string, snapshot: SessionSnapshot): void {
    const visibleSnapshot = this.snapshotWithRemoteSession(
      this.snapshotWithShellJobs(sessionId, snapshot),
    );
    for (const listener of [...this.sessionStateListeners]) {
      try {
        listener({ sessionId, snapshot: visibleSnapshot, frameSource: 'live' });
      } catch {
        // A visual client cannot affect service execution.
      }
    }
  }

  private applySessionResult(
    sessionId: string,
    value: Record<string, unknown> | null | undefined,
    publish = true,
  ): SessionSnapshot {
    const id = sessionIdOf(value?.sessionId || sessionId);
    const prior = this.sessionProjections.get(id);
    const revision = Number(value?.revision);
    let snapshot = prior?.snapshot ?? null;
    if (value && Object.prototype.hasOwnProperty.call(value, 'full')) {
      const full = value.full;
      snapshot = full && typeof full === 'object'
        ? { ...(full as Record<string, unknown>), sessionId: id } as SessionSnapshot
        : { sessionId: id, items: [], queued: [] } as SessionSnapshot;
    } else if (value?.patch && typeof value.patch === 'object'
      && prior && Number(value.baseRevision) === prior.revision) {
      snapshot = statePatch(prior.snapshot, value.patch as Record<string, unknown>);
    }
    if (!snapshot) snapshot = { sessionId: id, items: [], queued: [] } as SessionSnapshot;
    const nextRevision = Number.isFinite(revision) ? revision : (prior?.revision ?? 0);
    this.sessionProjections.set(id, { revision: nextRevision, snapshot });
    if (publish && id !== this.controlSessionId) this.publishSession(id, snapshot);
    return this.snapshotWithRemoteSession(snapshot);
  }

  private handleSessionFrame(frame: Record<string, unknown>): void {
    if (this.disposed) return;
    if (frame.type === 'remote-session-state') {
      this.applyRemoteSessionState(frame);
      return;
    }
    const sessionId = String(frame.sessionId || '');
    if (!sessionId) return;
    if (sessionId === this.controlSessionId) {
      if (frame.type === 'session-gone') {
        this.sessionProjections.delete(sessionId);
        this.controlSessionId = '';
      }
      return;
    }
    if (frame.type === 'session-gone') {
      this.sessionProjections.delete(sessionId);
      for (const listener of [...this.sessionStateListeners]) {
        try { listener({ sessionId, snapshot: null, frameSource: 'live' }); } catch {}
      }
      return;
    }
    if (frame.type !== 'session-state') return;
    const prior = this.sessionProjections.get(sessionId);
    if (frame.resyncRequired === true
      || (frame.patch && (!prior || Number(frame.baseRevision) !== prior.revision))) {
      void this.readSession(sessionId).catch(() => undefined);
      return;
    }
    this.applySessionResult(sessionId, frame);
  }

  private handleSessionTransportLoss(): void {
    this.controlSessionId = '';
    this.sessionProjections.clear();
    for (const sessionId of this.visibleSessionIds) {
      for (const listener of [...this.sessionStateListeners]) {
        try { listener({ sessionId, snapshot: null, frameSource: 'live' }); } catch {}
      }
    }
  }

  private callOptions(callId: string = randomUUID()): { callId: string } {
    if (this.disposed) throw new Error('Mixdog service host is disposed.');
    return { callId };
  }

  private async taskWorkspace(): Promise<string> {
    await mkdir(this.taskWorkspacePath, { recursive: true });
    return realpath(this.taskWorkspacePath);
  }

  private async canonicalDirectory(path: string): Promise<string> {
    const canonical = await realpath(path);
    if (!(await stat(canonical)).isDirectory()) {
      throw new TypeError('Session workspace is not a directory.');
    }
    return canonical;
  }

  private openHints(sessionId: string): Record<string, unknown> {
    const row = this.rawSessionRows.find((entry) => String(entry.id || '') === sessionId);
    const cwd = String(row?.cwd || '');
    const desktopSession = row?.desktopSession && typeof row.desktopSession === 'object'
      ? row.desktopSession as Record<string, unknown>
      : null;
    return {
      ...(cwd ? { cwd } : {}),
      ...(desktopSession ? { desktopSession } : {}),
      resumeOptions: { transcriptItemLimit: DESKTOP_TRANSCRIPT_ITEM_LIMIT },
    };
  }

  private async readSession(sessionId: string): Promise<SessionSnapshot> {
    const id = sessionIdOf(sessionId);
    const prior = this.sessionProjections.get(id);
    const result = await this.sessionClient.read({
      sessionId: id,
      open: this.openHints(id),
      baseRevision: prior?.revision ?? null,
    }, this.callOptions());
    return this.applySessionResult(id, result);
  }

  private async invokeSession(
    sessionId: string,
    method: string,
    args: unknown[] = [],
  ): Promise<{ value: unknown; snapshot: SessionSnapshot; result: Record<string, unknown> }> {
    const id = sessionIdOf(sessionId);
    const prior = this.sessionProjections.get(id);
    const params = {
      sessionId: id,
      action: method,
      args,
      open: this.openHints(id),
      baseRevision: prior?.revision ?? null,
    };
    const result = READ_CAPABILITIES.has(method)
      ? await this.sessionClient.read(params, this.callOptions())
      : await this.sessionClient.configure(params, this.callOptions());
    return {
      value: result.value,
      snapshot: this.applySessionResult(id, result),
      result,
    };
  }

  private async ensureControlSession(): Promise<string> {
    if (this.controlSessionId) return this.controlSessionId;
    if (this.controlSessionPromise) return this.controlSessionPromise;
    const pending = (async () => {
      const result = await this.sessionClient.create({
        cwd: await this.taskWorkspace(),
        desktopSession: null,
      }, this.callOptions(`service-control-create:${process.pid}:${randomUUID()}`));
      const sessionId = sessionIdOf(result.sessionId);
      this.controlSessionId = sessionId;
      this.applySessionResult(sessionId, result, false);
      return sessionId;
    })();
    this.controlSessionPromise = pending;
    try {
      return await pending;
    } finally {
      if (this.controlSessionPromise === pending) this.controlSessionPromise = null;
    }
  }

  private async invokeControlResult(
    method: string,
    args: unknown[] = [],
  ): Promise<{ value: unknown; snapshot: SessionSnapshot; result: Record<string, unknown> }> {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const sessionId = await this.ensureControlSession();
      try {
        const params = {
          sessionId,
          action: method,
          args,
          open: { cwd: await this.taskWorkspace(), desktopSession: null },
          baseRevision: this.sessionProjections.get(sessionId)?.revision ?? null,
        };
        const result = READ_CAPABILITIES.has(method)
          ? await this.sessionClient.read(params, this.callOptions())
          : await this.sessionClient.configure(params, this.callOptions());
        return {
          value: result.value,
          snapshot: this.applySessionResult(sessionId, result, false),
          result,
        };
      } catch (error) {
        if (attempt > 0) throw error;
        this.sessionProjections.delete(sessionId);
        this.controlSessionId = '';
      }
    }
    throw new Error('Service control session is unavailable.');
  }

  private async invokeControl(method: string, args: unknown[] = []): Promise<unknown> {
    return (await this.invokeControlResult(method, args)).value;
  }

  private blankSnapshot(
    cwd: string,
    projectPath: string | null,
  ): SessionSnapshot {
    return this.snapshotWithRemoteSession({
      sessionId: '',
      items: [],
      queued: [],
      busy: false,
      commandBusy: false,
      cwd,
      currentProject: projectPath,
      desktopSession: {
        classification: projectPath ? 'project' : 'task',
        projectPath,
      },
    } as SessionSnapshot);
  }

  async startProject(projectPath: string): Promise<SessionSnapshot> {
    const canonical = await this.canonicalDirectory(projectPath);
    await this.projects.enter(canonical);
    const snapshot = this.blankSnapshot(canonical, canonical);
    this.publishShell(snapshot);
    return snapshot;
  }

  async startProjectTask(projectPath: string): Promise<SessionSnapshot> {
    const registered = await this.projects.knownPath(projectPath);
    const canonical = await this.canonicalDirectory(registered);
    await this.projects.touchSelected(registered);
    const snapshot = this.blankSnapshot(canonical, canonical);
    this.publishShell(snapshot);
    return snapshot;
  }

  async startTask(): Promise<SessionSnapshot> {
    const snapshot = this.blankSnapshot(await this.taskWorkspace(), null);
    this.publishShell(snapshot);
    return snapshot;
  }

  async listProjects(): Promise<DesktopProjectSummary[]> {
    return (await this.projects.list()).projects;
  }

  async addProject(projectPath: string): Promise<void> {
    await this.projects.register(await this.canonicalDirectory(projectPath));
  }

  async projectDirectory(projectPath: string): Promise<string> {
    return this.canonicalDirectory(await this.projects.knownPath(projectPath));
  }

  async renameProject(projectPath: string, alias: string): Promise<void> {
    await this.projects.rename(projectPath, alias.trim());
  }

  async removeProject(projectPath: string): Promise<void> {
    await this.projects.remove(projectPath);
  }

  async listProjectDir(projectPath: string, relDir: string): Promise<unknown> {
    return listProjectDirIn(await this.projectDirectory(projectPath), relDir);
  }

  async readProjectTextFile(projectPath: string, relPath: string): Promise<unknown> {
    return readProjectTextFileIn(await this.projectDirectory(projectPath), relPath);
  }

  async writeProjectTextFile(
    projectPath: string,
    relPath: string,
    content: string,
    expectedContent: string,
    encoding?: import('./project-files').ProjectTextEncoding,
  ): Promise<unknown> {
    return writeProjectTextFileIn(
      await this.projectDirectory(projectPath),
      relPath,
      content,
      expectedContent,
      encoding,
    );
  }

  async statProjectFile(projectPath: string, relPath: string): Promise<unknown> {
    return statProjectFileIn(await this.projectDirectory(projectPath), relPath);
  }

  async createProjectEntry(
    projectPath: string,
    relDir: string,
    name: string,
    directory: boolean,
  ): Promise<unknown> {
    return createProjectEntryIn(await this.projectDirectory(projectPath), relDir, name, directory);
  }

  async renameProjectEntry(projectPath: string, relPath: string, newName: string): Promise<unknown> {
    return renameProjectEntryIn(await this.projectDirectory(projectPath), relPath, newName);
  }

  async moveProjectEntry(projectPath: string, relPath: string, targetDirRel: string): Promise<unknown> {
    return moveProjectEntryIn(await this.projectDirectory(projectPath), relPath, targetDirRel);
  }

  async copyProjectEntry(projectPath: string, relPath: string, targetDirRel: string): Promise<unknown> {
    return copyProjectEntryIn(await this.projectDirectory(projectPath), relPath, targetDirRel);
  }

  async projectEntryPath(projectPath: string, relPath: string): Promise<string> {
    return projectEntryPathIn(await this.projectDirectory(projectPath), relPath);
  }

  async codeGraphQuery(
    projectPath: string,
    mode: 'find_symbol' | 'references' | 'symbols',
    query: string,
  ): Promise<unknown> {
    return codeGraphQueryIn(
      await this.projectDirectory(projectPath),
      mode,
      query,
      {
        packaged: this.options.packaged,
        resourcesPath: this.options.resourcesPath,
        appPath: this.options.appPath,
        executeCodeGraphTool: this.runtime.executeCodeGraphTool,
      },
    );
  }

  async listSessions(): Promise<DesktopSessionSummary[]> {
    if (this.sessionCatalogPromise) return this.sessionCatalogPromise;
    const pending = (async () => {
      await this.sessionMetadata.load();
      // Cold desktop catalogs use the durable summary index and incrementally
      // inspect only changed/new/deleted records. Exact pane addressing remains
      // guarded by sessionClient.read/subscribe in the daemon.
      const catalog = await this.sessionClient.list({
        refreshFromStorage: false,
      }, this.callOptions());
      this.applyRemoteSessionState(catalog.remoteSession);
      this.rawSessionRows = Array.isArray(catalog.sessions)
        ? catalog.sessions as Array<Record<string, unknown>>
        : [];
      this.sessionCatalogLoaded = true;
      this.ensureStoreWatcher();
      const sessions = this.sessionCatalog();
      return this.pendingCatalogSessionIds.size === 0
        ? sessions
        : sessions.filter((session) => !this.pendingCatalogSessionIds.has(session.id));
    })();
    this.sessionCatalogPromise = pending;
    try {
      return await pending;
    } finally {
      if (this.sessionCatalogPromise === pending) this.sessionCatalogPromise = null;
    }
  }

  async listAgentPool(): Promise<DesktopAgentPoolRow[]> {
    const store = await this.runtime.loadSessionStore();
    const rows = store.listStoredAgentWorkers?.();
    return Array.isArray(rows) ? rows : [];
  }

  async renameSession(sessionId: string, title: string): Promise<void> {
    const id = sessionIdOf(sessionId);
    const normalized = normalizeSessionTitle(title, '');
    if (!normalized) throw new TypeError('Session title is invalid.');
    if (await this.invokeControl('renameSessionTitle', [id, normalized]) !== true) {
      throw new Error('Session is not available.');
    }
    await this.sessionMetadata.setName(id, normalized);
    await this.publishCatalogs();
  }

  async setSessionArchived(sessionId: string, archived: boolean): Promise<void> {
    const id = sessionIdOf(sessionId);
    await this.sessionMetadata.load();
    if (!(await this.sessionMetadata.setArchived(id, archived))) return;
    // Archive metadata does not alter daemon sessions or the process-global
    // agent pool. Re-project the resident rows instead of paying for both
    // catalogs and a full session-store identity/stat scan before replying.
    if (this.sessionCatalogLoaded) this.publishSessionCatalog(this.sessionCatalog());
    else await this.publishCatalogs();
  }

  async deleteSession(sessionId: string): Promise<SessionSnapshot> {
    const id = sessionIdOf(sessionId);
    if (!(await this.listSessions()).some((row) => row.id === id)) {
      throw new Error('Session is not available.');
    }
    if (await this.invokeControl('deleteSession', [id]) !== true) {
      throw new Error('Session could not be deleted.');
    }
    try { await this.sessionClient.unsubscribe({ sessionId: id }, this.callOptions()); } catch {}
    this.visibleSessionIds.delete(id);
    this.sessionProjections.delete(id);
    await this.sessionMetadata.forget(id);
    await this.publishCatalogs();
    return null;
  }

  async prefetchSession(sessionId: string): Promise<boolean> {
    await this.readSession(sessionId);
    return true;
  }

  async setVisibleSessions(sessionIds: string[]): Promise<boolean> {
    const requested = [...new Set(sessionIds.map(sessionIdOf))];
    // Subscribe is already an exact, single-record authorization boundary in
    // the daemon. Do not scan the complete catalog merely to validate the few
    // session ids represented by visible panes.
    const accepted = await Promise.all(requested.map(async (sessionId) => {
      if (this.visibleSessionIds.has(sessionId)) return sessionId;
      const prior = this.sessionProjections.get(sessionId);
      try {
        const result = await this.sessionClient.subscribe({
          sessionId,
          open: this.openHints(sessionId),
          baseRevision: prior?.revision ?? null,
        }, this.callOptions());
        this.applySessionResult(sessionId, result);
        return sessionId;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (message.includes(`session ${sessionId} is not available`)) return null;
        throw error;
      }
    }));
    const next = new Set(accepted.filter((id): id is string => Boolean(id)));
    const removed = [...this.visibleSessionIds].filter((id) => !next.has(id));
    this.visibleSessionIds.clear();
    for (const id of next) this.visibleSessionIds.add(id);
    await Promise.allSettled(removed.map((sessionId) =>
      this.sessionClient.unsubscribe({ sessionId }, this.callOptions())));
    return true;
  }

  async searchProjectFiles(
    projectIdOrWorkspaceId: string,
    query: string,
    limit = 50,
  ): Promise<string[]> {
    const root = await this.projectDirectory(projectIdOrWorkspaceId);
    return searchProjectDirectory(root, query, limit);
  }

  async submitNewTask(
    prompt: DesktopPromptContent,
    options: DesktopSubmitOptions = {},
    draft: DesktopNewTaskDraft = {},
  ): Promise<DesktopNewTaskSubmitResult> {
    const requestedProject = String(draft.projectPath || '').trim();
    const registeredProject = requestedProject
      ? await this.projects.knownPath(requestedProject)
      : '';
    const cwd = registeredProject
      ? await this.canonicalDirectory(registeredProject)
      : await this.taskWorkspace();
    const desktopSession = registeredProject
      ? { classification: 'project' as const, projectPath: cwd }
      : { classification: 'task' as const, projectPath: null };
    const created = await this.sessionClient.create(
      { cwd, desktopSession },
      this.callOptions(`session-create:${process.pid}:${randomUUID()}`),
    );
    const sessionId = sessionIdOf(created.sessionId);
    this.pendingCatalogSessionIds.add(sessionId);
    this.applySessionResult(sessionId, created);
    try {
      if (draft.workflowId) {
        await this.invokeSession(sessionId, 'setWorkflow', [draft.workflowId]);
      }
      if (draft.route) {
        const routeResult = await this.invokeSession(sessionId, 'setRoute', [{
          provider: draft.route.provider,
          model: draft.route.model,
          ...(draft.route.effort ? { effort: draft.route.effort } : {}),
          ...(typeof draft.route.fast === 'boolean' ? { fast: draft.route.fast } : {}),
          ...(draft.route.modelParameters ? { modelParameters: draft.route.modelParameters } : {}),
          ...(typeof draft.route.contextPercent === 'number'
            ? { contextPercent: draft.route.contextPercent }
            : {}),
          applyToCurrentSession: true,
        }]);
        const resolvedRoute = routeResult.value && typeof routeResult.value === 'object'
          ? routeResult.value as Record<string, unknown>
          : null;
        // Validate against setRoute's authoritative result. Its projected
        // snapshot is delivered independently and may still describe the
        // pre-route state during the first task after startup.
        if (draft.route.fast === true && resolvedRoute?.fast !== true) {
          throw new Error(
            `fast mode is not available for ${draft.route.provider}/${draft.route.model}`,
          );
        }
      }
      const submissionId = String(options.id || '').trim()
        || `desktop-submit-${sessionId}-${Date.now()}`;
      const prior = this.sessionProjections.get(sessionId);
      const result = await this.sessionClient.submit({
        sessionId,
        prompt,
        options: { ...options, id: submissionId },
        open: { cwd, desktopSession },
        baseRevision: prior?.revision ?? null,
      }, this.callOptions(`session-submit:${sessionId}:${submissionId}`));
      if (String(result.sessionId || '') !== sessionId) {
        throw new Error('New task service returned a mismatched session id.');
      }
      const accepted = result.accepted === true;
      const snapshot = this.applySessionResult(sessionId, result);
      if (String(snapshot?.sessionId || '') !== sessionId) {
        throw new Error('New task service returned a mismatched session snapshot.');
      }
      if (!accepted) {
        await this.sessionClient.unsubscribe(
          { sessionId },
          this.callOptions(),
        ).catch(() => ({}));
        return { accepted: false, sessionId: '', snapshot: null };
      }
      if (registeredProject) await this.projects.touchSelected(registeredProject);
      await this.sessionMetadata.load();
      this.sessionMetadata.rememberGeneratedTitle(
        sessionId,
        promptTitle(prompt, options.displayText || ''),
      );
      this.pendingCatalogSessionIds.delete(sessionId);
      void this.publishCatalogs();
      return { accepted: true, sessionId, snapshot };
    } catch (error) {
      try {
        await this.sessionClient.unsubscribe({ sessionId }, this.callOptions());
      } catch {}
      throw error;
    } finally {
      this.pendingCatalogSessionIds.delete(sessionId);
    }
  }

  async submitToSession(
    sessionId: string,
    prompt: DesktopPromptContent,
    options: DesktopSubmitOptions = {},
  ): Promise<boolean> {
    const id = sessionIdOf(sessionId);
    const submissionId = String(options.id || '').trim()
      || `desktop-submit-${id}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const prior = this.sessionProjections.get(id);
    const result = await this.sessionClient.submit({
      sessionId: id,
      prompt,
      options: { ...options, id: submissionId },
      open: this.openHints(id),
      baseRevision: prior?.revision ?? null,
    }, this.callOptions(`session-submit:${id}:${submissionId}`));
    this.applySessionResult(id, result);
    return result.accepted === true;
  }

  async abortSession(sessionId: string, options: DesktopAbortOptions = {}): Promise<unknown> {
    const id = sessionIdOf(sessionId);
    const result = await this.sessionClient.abort({
      sessionId: id,
      options,
      open: this.openHints(id),
      baseRevision: this.sessionProjections.get(id)?.revision ?? null,
    }, this.callOptions());
    this.applySessionResult(id, result);
    return {
      aborted: result.aborted === true,
      restoreText: result.restoreText || '',
      pastedImages: result.pastedImages ?? null,
      pastedTexts: result.pastedTexts ?? null,
      discardPastedImages: result.discardPastedImages ?? null,
      discardPastedTexts: result.discardPastedTexts ?? null,
      restoredSubmissionIds: Array.isArray(result.restoredSubmissionIds)
        ? result.restoredSubmissionIds
        : [],
    };
  }

  async resolveToolApprovalForSession(
    sessionId: string,
    id: string,
    decision: ToolApprovalDecision,
  ): Promise<boolean> {
    const target = sessionIdOf(sessionId);
    const result = await this.sessionClient.approve({
      sessionId: target,
      approvalId: id,
      decision,
      open: this.openHints(target),
      baseRevision: this.sessionProjections.get(target)?.revision ?? null,
    }, this.callOptions());
    this.applySessionResult(target, result);
    return result.approved === true;
  }

  async listProviderModels(
    options: DesktopModelCatalogOptions = {},
  ): Promise<DesktopModelOption[]> {
    return normalizedProviderModels(
      await this.invokeControl('listProviderModels', [options]),
    );
  }

  async setModelRoute(
    selection: DesktopModelSelection,
    sessionId?: string,
  ): Promise<SessionSnapshot> {
    const target = sessionId || await this.ensureControlSession();
    const { snapshot } = await this.invokeSession(target, 'setRoute', [{
      ...selection,
      applyToCurrentSession: true,
    }]);
    return snapshot;
  }

  async setFast(enabled: boolean, sessionId?: string): Promise<SessionSnapshot> {
    const target = sessionId || await this.ensureControlSession();
    return (await this.invokeSession(target, 'setFast', [enabled])).snapshot;
  }

  async invokeCapability<T = unknown>(
    capability: DesktopCapability,
    args: unknown[] = [],
    sessionId?: string,
  ): Promise<DesktopCapabilityResult<T>> {
    const result = sessionId
      ? await this.invokeSession(sessionId, capability, args)
      : await this.invokeControlResult(capability, args);
    return {
      value: copyCapabilityValue(result.value) as T,
      snapshot: result.snapshot,
    };
  }

  async readCapabilities(
    requests: ReadonlyArray<DesktopCapabilityReadRequest>,
  ): Promise<DesktopCapabilityReadResult[]> {
    const results: DesktopCapabilityReadResult[] = [];
    for (const request of requests) {
      try {
        results.push({
          ok: true,
          value: copyCapabilityValue(
            await this.invokeControl(request.capability, request.args || []),
          ),
        });
      } catch (error) {
        results.push({
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return results;
  }

  async invokeDesktopOperation(): Promise<unknown> {
    throw new Error('invokeDesktopOperation is supplied by the service operation adapter.');
  }

  subscribeDesktopEvents(): () => void {
    return () => {};
  }

  perfLog(line: string): void {
    if (process.env.MIXDOG_DESKTOP_PERF === '1') {
      console.error(`[mixdog-service] ${line}`);
    }
  }

  private ensureStoreWatcher(): void {
    if (this.storeWatcher || this.disposed) return;
    try {
      this.storeWatcher = watch(dataDirectory(), { persistent: false }, () => {
        if (this.storeRefreshTimer) clearTimeout(this.storeRefreshTimer);
        this.storeRefreshTimer = setTimeout(() => {
          this.storeRefreshTimer = null;
          void this.publishCatalogs();
        }, 100);
        this.storeRefreshTimer.unref?.();
      });
      this.storeWatcher.on('error', () => {
        try { this.storeWatcher?.close(); } catch {}
        this.storeWatcher = null;
      });
    } catch {
      this.storeWatcher = null;
    }
  }

  private sessionCatalog(): DesktopSessionSummary[] {
    return this.sessionMetadata.withArchiveFlags(desktopSessionSummaries(
      this.rawSessionRows,
      this.sessionMetadata.titles,
      this.sessionMetadata.names,
    ));
  }

  private publishSessionCatalog(sessions: DesktopSessionSummary[]): void {
    if (this.disposed) return;
    const visible = this.pendingCatalogSessionIds.size === 0
      ? sessions
      : sessions.filter((session) => !this.pendingCatalogSessionIds.has(session.id));
    for (const listener of [...this.sessionListeners]) {
      try { listener(visible); } catch {}
    }
  }

  private async publishCatalogs(): Promise<void> {
    if (this.disposed) return;
    const [sessions, agents] = await Promise.all([
      this.listSessions().catch(() => []),
      this.listAgentPool().catch(() => []),
    ]);
    this.publishSessionCatalog(sessions);
    for (const listener of [...this.agentPoolListeners]) {
      try { listener(agents); } catch {}
    }
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.shellJobsPoller.stop();
    if (this.storeRefreshTimer) clearTimeout(this.storeRefreshTimer);
    this.storeRefreshTimer = null;
    try { this.storeWatcher?.close(); } catch {}
    this.storeWatcher = null;
    await this.sessionMetadata.flush();
    try { await this.sessionClient.close('service host disposed'); } catch {}
    this.listeners.clear();
    this.sessionListeners.clear();
    this.agentPoolListeners.clear();
    this.sessionStateListeners.clear();
    this.sessionProjections.clear();
    this.visibleSessionIds.clear();
  }
}
