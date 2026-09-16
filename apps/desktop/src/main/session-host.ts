import { randomUUID } from 'node:crypto';
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
  DesktopSessionFrameSource,
  DesktopSessionStateUpdate,
  DesktopSessionSummary,
  DesktopSubmitOptions,
  SessionSnapshot,
  ToolApprovalDecision,
} from '../shared/contract';
import { DESKTOP_READ_CAPABILITIES } from '../shared/contract';
import { reportTranscriptRead, transcriptReadTraceId } from '../shared/transcript-read-diagnostics';
import { normalizeSessionTitle, promptTitle } from '../shared/session-title.mjs';
import { desktopSessionSummaries, isSessionId } from './desktop-state';
import type { DesktopService, SerializableDesktopServiceOptions } from './desktop-service-contract';
import { SessionHostCatalog, catalogRelevantStoreEntry } from './session-host-catalog';
import { SessionHostPublication } from './session-host-publication';
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
import { SessionViewRegistry } from './session-view-registry';
import { TRANSCRIPT_READ_TIMEOUT_MS } from '../shared/transcript-read-policy';
import { NewTaskRequests, type NewTaskRequest } from './new-task-requests';
import { longRunningRequestTimeout } from './local-provider-install-timeout';
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

interface SessionCallOptions {
  callId?: string;
  timeoutMs?: number;
}

export interface SessionClient {
  list(args?: Record<string, unknown>, options?: SessionCallOptions): Promise<Record<string, unknown>>;
  create(args?: Record<string, unknown>, options?: SessionCallOptions): Promise<Record<string, unknown>>;
  read(args?: Record<string, unknown>, options?: SessionCallOptions): Promise<Record<string, unknown>>;
  subscribe(args?: Record<string, unknown>, options?: SessionCallOptions): Promise<Record<string, unknown>>;
  unsubscribe(args?: Record<string, unknown>, options?: SessionCallOptions): Promise<Record<string, unknown>>;
  submit(args?: Record<string, unknown>, options?: SessionCallOptions): Promise<Record<string, unknown>>;
  abort(args?: Record<string, unknown>, options?: SessionCallOptions): Promise<Record<string, unknown>>;
  approve(args?: Record<string, unknown>, options?: SessionCallOptions): Promise<Record<string, unknown>>;
  configure(args?: Record<string, unknown>, options?: SessionCallOptions): Promise<Record<string, unknown>>;
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
  executeCodeGraphTool(name: string, args: Record<string, unknown>, cwd: string): Promise<unknown>;
}

const READ_CAPABILITIES = new Set<string>(DESKTOP_READ_CAPABILITIES);

export { catalogRelevantStoreEntry };

function dataDirectory(): string {
  if (process.env.MIXDOG_DATA_DIR) return process.env.MIXDOG_DATA_DIR;
  return join(process.env.MIXDOG_HOME || join(homedir(), '.mixdog'), 'data');
}

function sessionIdOf(value: unknown): string {
  const id = String(value || '');
  if (!isSessionId(id)) throw new TypeError('session id is invalid.');
  return id;
}

function sameTranscriptItem(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (!left || !right || typeof left !== 'object' || typeof right !== 'object') return false;
  const a = left as Record<string, unknown>;
  const b = right as Record<string, unknown>;
  if (a.id != null && b.id != null) return String(a.id) === String(b.id);
  return String(a.kind || '') === String(b.kind || '') && String(a.text ?? '') === String(b.text ?? '');
}

/** Add a larger durable history head without replacing live work fields or
 * the identity-stable tail currently owned by the runtime. */
export function mergeSessionHistorySnapshot(
  sessionId: string,
  live: SessionSnapshot,
  stored: Record<string, unknown>
): SessionSnapshot {
  const historyItems = Array.isArray(stored.items) ? stored.items : [];
  if (!live || !Array.isArray(live.items) || live.items.length === 0) {
    return { ...stored, sessionId, queued: Array.isArray(stored.queued) ? stored.queued : [] };
  }
  const liveItems = live.items;
  let overlap = -1;
  for (let index = 0; index < historyItems.length; index += 1) {
    if (sameTranscriptItem(historyItems[index], liveItems[0])) {
      overlap = index;
      break;
    }
  }
  if (overlap < 0) return live;
  const shared = Math.min(historyItems.length - overlap, liveItems.length);
  for (let index = 1; index < shared; index += 1) {
    if (!sameTranscriptItem(historyItems[overlap + index], liveItems[index])) return live;
  }
  return {
    ...stored,
    ...live,
    sessionId,
    items: [...historyItems.slice(0, overlap), ...liveItems],
  };
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
  private readonly publication: SessionHostPublication;
  private readonly catalog: SessionHostCatalog;
  private readonly sessionViews = new SessionViewRegistry();
  private readonly visibleSessionIds = this.sessionViews.visible;
  private readonly visibleSessionSources = this.sessionViews.sources;
  private readonly newTaskRequests: NewTaskRequests;
  /** A new runtime exists on disk before its first prompt/title is accepted.
   *  Keep watcher scans from exposing that half-created row ahead of the
   *  renderer's atomic draft promotion. */
  private readonly pendingCatalogSessionIds = new Set<string>();
  private readonly projects: DesktopProjectRegistry;
  private readonly sessionMetadata: DesktopSessionMetadata;
  private readonly sessionClient: SessionClient;
  private readonly shellJobsPoller: ReturnType<typeof createShellJobsPoller>;
  private readonly taskWorkspacePath: string;
  /** Poller-facing engine state. The shell snapshot is the BLANK frame New
   *  Task/Project publishes: it carries no clientHostPid, so the poller read
   *  an owner pid of 0 and never scanned a single job record. Session frames
   *  carry both the owning host pid and the live busy flags. */
  private engineSnapshot: SessionSnapshot = null;
  private engineClientHostPid = 0;
  private controlSessionId = '';
  private controlSessionPromise: Promise<string> | null = null;
  private rawSessionRows: Array<Record<string, unknown>> = [];
  private sessionCatalogLoaded = false;
  private sessionCatalogPromise: Promise<DesktopSessionSummary[]> | null = null;
  private disposed = false;
  private disposePromise: Promise<void> | null = null;

  private constructor(
    private readonly options: SerializableDesktopServiceOptions,
    private readonly runtime: SessionHostRuntime,
    sessionClient: SessionClient
  ) {
    this.sessionClient = sessionClient;
    this.publication = new SessionHostPublication({
      isDisposed: () => this.disposed,
      controlSessionId: () => this.controlSessionId,
      setControlSessionId: (sessionId) => {
        this.controlSessionId = sessionId;
      },
      visibleSessionIds: () => this.visibleSessionIds,
      readSession: (sessionId) => this.readSession(sessionId),
      snapshotWithShellJobs: (sessionId, snapshot) => this.snapshotWithShellJobs(sessionId, snapshot),
      trackShellJobsEngineState: (snapshot) => this.trackShellJobsEngineState(snapshot),
      onShellPublished: () => this.shellJobsPoller.onEngineEvent(),
    });
    this.catalog = new SessionHostCatalog(
      {
        isDisposed: () => this.disposed,
        listSessions: () => this.listSessions(),
        listAgentPool: () => this.listAgentPool(),
        publishSessions: (sessions) => this.publishSessionCatalog(sessions),
        publishAgents: (agents) => this.publication.publishAgents(agents),
        coldSessionIds: () =>
          [...this.visibleSessionIds].filter((sessionId) => this.publication.projections.get(sessionId)?.cold === true),
        readSession: (sessionId) => this.readSession(sessionId),
      },
      { directory: dataDirectory }
    );
    this.shellJobsPoller = createShellJobsPoller({
      getEngineState: () => this.shellJobsEngineState(),
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
    this.newTaskRequests = new NewTaskRequests(options.userDataPath);
  }

  static async create(options: SerializableDesktopServiceOptions, runtime: SessionHostRuntime): Promise<SessionHost> {
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
    return this.publication.shellSnapshot;
  }

  subscribe(listener: (snapshot: SessionSnapshot) => void): () => void {
    return this.publication.subscribe(listener);
  }

  subscribeSessions(listener: (sessions: DesktopSessionSummary[]) => void): () => void {
    const unsubscribe = this.publication.subscribeSessions(listener);
    this.catalog.ensureStoreWatcher();
    return unsubscribe;
  }

  subscribeAgentPool(listener: (agents: DesktopAgentPoolRow[]) => void): () => void {
    const unsubscribe = this.publication.subscribeAgentPool(listener);
    this.catalog.ensureStoreWatcher();
    return unsubscribe;
  }

  subscribeSessionStates(listener: (update: DesktopSessionStateUpdate) => void): () => void {
    return this.publication.subscribeSessionStates(listener);
  }

  private snapshotWithRemoteSession(snapshot: SessionSnapshot): SessionSnapshot {
    return this.publication.snapshotWithRemoteSession(snapshot);
  }

  private applyRemoteSessionState(value: unknown): void {
    this.publication.applyRemoteSessionState(value);
  }

  private publishShell(snapshot: SessionSnapshot): void {
    this.publication.publishShell(snapshot);
  }

  /** Live engine state for the shell-job poller: newest session frame first,
   *  with the blank shell snapshot as the only fallback. A frame that lost its
   *  pid field still polls under the last known owner. */
  private shellJobsEngineState(): Record<string, unknown> | null {
    const base = (this.engineSnapshot ?? this.publication.shellSnapshot) as Record<string, unknown> | null;
    if (!base || typeof base !== 'object') return null;
    if (Number(base.ownerClientHostPid || base.clientHostPid) > 0) return base;
    return this.engineClientHostPid > 0 ? { ...base, clientHostPid: this.engineClientHostPid } : base;
  }

  /** Every session frame refreshes the poller's engine state and re-arms it,
   *  so a shell promoted to the background surfaces on the fast cadence. */
  private trackShellJobsEngineState(snapshot: SessionSnapshot): void {
    if (!snapshot || typeof snapshot !== 'object') return;
    const state = snapshot as Record<string, unknown>;
    const pid = Number(state.ownerClientHostPid || state.clientHostPid) || 0;
    if (pid > 0) this.engineClientHostPid = pid;
    this.engineSnapshot = snapshot;
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
      const projection = this.publication.projections.get(sessionId);
      if (projection) this.publishSession(sessionId, projection.snapshot);
    }
  }

  private publishSession(
    sessionId: string,
    snapshot: SessionSnapshot,
    frameSource: DesktopSessionFrameSource = 'live',
    readTraceId?: string
  ): void {
    this.publication.publishSession(sessionId, snapshot, frameSource, readTraceId);
  }

  private applySessionResult(
    sessionId: string,
    value: Record<string, unknown> | null | undefined,
    publish = true
  ): SessionSnapshot {
    return this.publication.applySessionResult(sessionId, value, publish);
  }

  private handleSessionFrame(frame: Record<string, unknown>): void {
    this.publication.handleSessionFrame(frame);
  }

  private handleSessionTransportLoss(): void {
    this.publication.handleSessionTransportLoss();
  }

  private callOptions(callId: string = randomUUID(), timeoutMs?: number): SessionCallOptions {
    if (this.disposed) throw new Error('Mixdog service host is disposed.');
    return { callId, ...(timeoutMs ? { timeoutMs } : {}) };
  }

  private async taskWorkspace(): Promise<string> {
    await mkdir(this.taskWorkspacePath, { recursive: true });
    return realpath(this.taskWorkspacePath);
  }

  private async resolveSessionWorkspace(projectPath?: string | null): Promise<{
    registeredProject: string;
    cwd: string;
    desktopSession: { classification: 'project'; projectPath: string } | { classification: 'task'; projectPath: null };
  }> {
    const requested = String(projectPath || '').trim();
    const registeredProject = requested ? await this.projects.knownPath(requested) : '';
    const cwd = registeredProject ? await this.canonicalDirectory(registeredProject) : await this.taskWorkspace();
    return {
      registeredProject,
      cwd,
      desktopSession: registeredProject
        ? { classification: 'project', projectPath: cwd }
        : { classification: 'task', projectPath: null },
    };
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
    const desktopSession =
      row?.desktopSession && typeof row.desktopSession === 'object'
        ? (row.desktopSession as Record<string, unknown>)
        : null;
    return {
      ...(cwd ? { cwd } : {}),
      ...(desktopSession ? { desktopSession } : {}),
      resumeOptions: { transcriptItemLimit: DESKTOP_TRANSCRIPT_ITEM_LIMIT },
    };
  }

  private async readSession(
    sessionId: string,
    forceFull = false,
    publish = true,
    readTraceId?: string
  ): Promise<SessionSnapshot> {
    const id = sessionIdOf(sessionId);
    const prior = this.publication.projections.get(id);
    const startedAt = performance.now();
    reportTranscriptRead(id, readTraceId, 'host-read-start');
    const result = await this.sessionClient.read(
      {
        sessionId: id,
        open: this.openHints(id),
        baseRevision: forceFull ? null : (prior?.revision ?? null),
        ...(!forceFull && prior?.projectionStamp ? { baseProjectionStamp: prior.projectionStamp } : {}),
      },
      this.callOptions(undefined, TRANSCRIPT_READ_TIMEOUT_MS)
    );
    reportTranscriptRead(id, readTraceId, 'host-read-result', {
      durationMs: performance.now() - startedAt,
    });
    const current = this.publication.projections.get(id);
    const hasFull = result.full !== null && typeof result.full === 'object';
    const hasBaseline =
      current &&
      (result.patch ? Number(result.baseRevision) === current.revision : Number(result.revision) === current.revision);
    if (!hasFull && !hasBaseline) {
      if (forceFull) throw new Error('Session recovery returned no usable baseline.');
      return this.readSession(id, true, publish, readTraceId);
    }
    return this.applySessionResult(id, result, publish);
  }

  private async invokeSession(
    sessionId: string,
    method: string,
    args: unknown[] = []
  ): Promise<{ value: unknown; snapshot: SessionSnapshot; result: Record<string, unknown> }> {
    const id = sessionIdOf(sessionId);
    const prior = this.publication.projections.get(id);
    const params = {
      sessionId: id,
      action: method,
      args,
      open: this.openHints(id),
      baseRevision: prior?.revision ?? null,
    };
    const callOptions = this.callOptions(randomUUID(), longRunningRequestTimeout(method, args));
    const result = READ_CAPABILITIES.has(method)
      ? await this.sessionClient.read(params, callOptions)
      : await this.sessionClient.configure(params, callOptions);
    const current = this.publication.projections.get(id);
    // A stream publication may have advanced the baseline while configure
    // awaited its reply. Recover the resulting state, never replay the command
    // or acknowledge a successful selection with the old cached values.
    const needsFull =
      result.patch &&
      !Object.hasOwn(result, 'full') &&
      (!current || (Number(result.revision) > current.revision && Number(result.baseRevision) !== current.revision));
    return {
      value: result.value,
      snapshot: needsFull ? await this.readSession(id, true) : this.applySessionResult(id, result),
      result,
    };
  }

  private async ensureControlSession(): Promise<string> {
    if (this.controlSessionId) return this.controlSessionId;
    if (this.controlSessionPromise) return this.controlSessionPromise;
    const pending = (async () => {
      const result = await this.sessionClient.create(
        {
          cwd: await this.taskWorkspace(),
          desktopSession: null,
        },
        this.callOptions(`service-control-create:${process.pid}:${randomUUID()}`)
      );
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
    args: unknown[] = []
  ): Promise<{ value: unknown; snapshot: SessionSnapshot; result: Record<string, unknown> }> {
    const replayable = READ_CAPABILITIES.has(method);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const sessionId = await this.ensureControlSession();
      try {
        const params = {
          sessionId,
          action: method,
          args,
          open: { cwd: await this.taskWorkspace(), desktopSession: null },
          baseRevision: this.publication.projections.get(sessionId)?.revision ?? null,
        };
        const callOptions = this.callOptions(randomUUID(), longRunningRequestTimeout(method, args));
        const result = READ_CAPABILITIES.has(method)
          ? await this.sessionClient.read(params, callOptions)
          : await this.sessionClient.configure(params, callOptions);
        return {
          value: result.value,
          snapshot: this.applySessionResult(sessionId, result, false),
          result,
        };
      } catch (error) {
        this.publication.projections.delete(sessionId);
        this.controlSessionId = '';
        // Reads are safe to replay after a stale control session. A mutation
        // may already have committed before its reply failed (as with the MCP
        // durable-address error), so replaying it can duplicate side effects.
        if (!replayable || attempt > 0) throw error;
      }
    }
    throw new Error('Service control session is unavailable.');
  }

  private async invokeControl(method: string, args: unknown[] = []): Promise<unknown> {
    return (await this.invokeControlResult(method, args)).value;
  }

  private blankSnapshot(cwd: string, projectPath: string | null): SessionSnapshot {
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
    encoding?: import('./project-files').ProjectTextEncoding
  ): Promise<unknown> {
    return writeProjectTextFileIn(
      await this.projectDirectory(projectPath),
      relPath,
      content,
      expectedContent,
      encoding
    );
  }

  async statProjectFile(projectPath: string, relPath: string): Promise<unknown> {
    return statProjectFileIn(await this.projectDirectory(projectPath), relPath);
  }

  async createProjectEntry(projectPath: string, relDir: string, name: string, directory: boolean): Promise<unknown> {
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
    query: string
  ): Promise<unknown> {
    return codeGraphQueryIn(await this.projectDirectory(projectPath), mode, query, {
      packaged: this.options.packaged,
      resourcesPath: this.options.resourcesPath,
      appPath: this.options.appPath,
      executeCodeGraphTool: this.runtime.executeCodeGraphTool,
    });
  }

  async listSessions(): Promise<DesktopSessionSummary[]> {
    if (this.sessionCatalogPromise) return this.sessionCatalogPromise;
    const pending = (async () => {
      await this.sessionMetadata.load();
      // Cold desktop catalogs use the durable summary index and incrementally
      // inspect only changed/new/deleted records. Exact pane addressing remains
      // guarded by sessionClient.read/subscribe in the daemon.
      const catalog = await this.sessionClient.list(
        {
          refreshFromStorage: false,
        },
        this.callOptions()
      );
      this.applyRemoteSessionState(catalog.remoteSession);
      this.rawSessionRows = Array.isArray(catalog.sessions) ? (catalog.sessions as Array<Record<string, unknown>>) : [];
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

  async markSessionRead(sessionId: string, messageCount: number, consumedUnread = false): Promise<boolean> {
    const id = sessionIdOf(sessionId);
    const changed = await this.sessionMetadata.markRead(id, messageCount, consumedUnread);
    if (!changed) return false;
    if (this.sessionCatalogLoaded) this.publishSessionCatalog(this.sessionCatalog());
    else await this.publishCatalogs();
    return true;
  }

  async renameSession(sessionId: string, title: string): Promise<void> {
    const id = sessionIdOf(sessionId);
    const normalized = normalizeSessionTitle(title, '');
    if (!normalized) throw new TypeError('Session title is invalid.');
    if ((await this.invokeControl('renameSessionTitle', [id, normalized])) !== true) {
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
    if ((await this.invokeControl('deleteSession', [id])) !== true) {
      throw new Error('Session could not be deleted.');
    }
    try {
      await this.sessionClient.unsubscribe({ sessionId: id }, this.callOptions());
    } catch {}
    this.visibleSessionIds.delete(id);
    for (const sessions of this.visibleSessionSources.values()) sessions.delete(id);
    this.publication.projections.delete(id);
    await this.sessionMetadata.forget(id);
    await this.publishCatalogs();
    return null;
  }

  async prefetchSession(
    sessionId: string,
    transcriptItemLimit = DESKTOP_TRANSCRIPT_ITEM_LIMIT,
    readTraceId?: string
  ): Promise<boolean> {
    const id = sessionIdOf(sessionId);
    const traceId = transcriptReadTraceId(readTraceId);
    const startedAt = performance.now();
    reportTranscriptRead(id, traceId, 'host-start');
    const limit = Math.max(
      1,
      Math.min(8_192, Math.floor(Number(transcriptItemLimit) || DESKTOP_TRANSCRIPT_ITEM_LIMIT))
    );
    try {
      let snapshot: SessionSnapshot;
      if (limit <= DESKTOP_TRANSCRIPT_ITEM_LIMIT) {
        snapshot = await this.readSession(id, false, false, traceId);
      } else {
        reportTranscriptRead(id, traceId, 'host-read-start');
        const store = await this.runtime.loadSessionStore();
        const stored = await store.readStoredSessionTranscript?.(id, {
          transcriptItemLimit: limit,
        });
        reportTranscriptRead(id, traceId, 'host-read-result', {
          durationMs: performance.now() - startedAt,
        });
        if (!stored || typeof stored !== 'object') {
          reportTranscriptRead(id, traceId, 'host-failed');
          return false;
        }
        const live = this.publication.projections.get(id)?.snapshot ?? null;
        snapshot = mergeSessionHistorySnapshot(id, live, stored);
      }
      reportTranscriptRead(id, traceId, 'host-projected', {
        elapsedMs: performance.now() - startedAt,
        itemCount: Array.isArray(snapshot?.items) ? snapshot.items.length : 0,
      });
      this.publishSession(id, snapshot, 'replay', traceId);
      reportTranscriptRead(id, traceId, 'host-published', {
        elapsedMs: performance.now() - startedAt,
      });
      return true;
    } catch (error) {
      reportTranscriptRead(id, traceId, 'host-failed', {
        elapsedMs: performance.now() - startedAt,
      });
      throw error;
    }
  }

  async replaySessionStates(
    sessionIds: string[],
    deliver: (updates: DesktopSessionStateUpdate[]) => void
  ): Promise<void> {
    const ids = [...new Set(sessionIds.map(sessionIdOf))];
    const gone = new Set<string>();
    await Promise.all(
      ids.map(async (id) => {
        try {
          await this.readSession(id, false, false);
        } catch (error) {
          if (!(error instanceof Error) || !error.message.includes(`session ${id} is not available`)) throw error;
          gone.add(id);
          this.publication.projections.delete(id);
        }
      })
    );
    if (this.disposed) throw new Error('Mixdog service host is disposed.');
    // Capture and deliver in one synchronous turn. A live update that arrived
    // during a read is already in this map and must outrank the earlier reply.
    deliver(
      ids.map((sessionId) => ({
        sessionId,
        snapshot: gone.has(sessionId)
          ? null
          : this.snapshotWithRemoteSession(
              this.snapshotWithShellJobs(sessionId, this.publication.projections.get(sessionId)?.snapshot ?? null)
            ),
        frameSource: 'replay' as const,
        ...(gone.has(sessionId) ? { laneEnd: 'gone' as const } : {}),
      }))
    );
  }

  async setVisibleSessions(sessionIds: string[]): Promise<boolean> {
    return this.setVisibleSessionsForSource('desktop', sessionIds);
  }

  async setVisibleSessionsForSource(sourceId: string, sessionIds: string[]): Promise<boolean> {
    const source = String(sourceId || '').trim();
    if (!source) throw new TypeError('sourceId is required.');
    const requested = [...new Set(sessionIds.map(sessionIdOf))];
    const accepted = await this.sessionViews.set(
      source,
      requested,
      (sessionId, alreadyVisible) => this.attachVisibleSession(sessionId, alreadyVisible),
      (sessionId) => this.sessionClient.unsubscribe({ sessionId }, this.callOptions())
    );
    this.ensureColdViewRefresh();
    return accepted;
  }

  private async attachVisibleSession(sessionId: string, alreadyVisible: boolean): Promise<boolean> {
    if (alreadyVisible) {
      const projection = this.publication.projections.get(sessionId);
      if (projection) this.publishSession(sessionId, projection.snapshot, 'replay');
      else await this.readSession(sessionId);
      return true;
    }
    const prior = this.publication.projections.get(sessionId);
    try {
      const result = await this.sessionClient.subscribe(
        {
          sessionId,
          open: this.openHints(sessionId),
          baseRevision: prior?.revision ?? null,
        },
        this.callOptions(undefined, TRANSCRIPT_READ_TIMEOUT_MS)
      );
      this.applySessionResult(sessionId, result, false);
      const projection = this.publication.projections.get(sessionId);
      if (projection) this.publishSession(sessionId, projection.snapshot, 'replay');
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes(`session ${sessionId} is not available`)) return false;
      throw error;
    }
  }

  async searchProjectFiles(projectIdOrWorkspaceId: string, query: string, limit = 50): Promise<string[]> {
    const root = await this.projectDirectory(projectIdOrWorkspaceId);
    return searchProjectDirectory(root, query, limit);
  }

  async submitNewTask(
    prompt: DesktopPromptContent,
    options: DesktopSubmitOptions = {},
    draft: DesktopNewTaskDraft = {}
  ): Promise<DesktopNewTaskSubmitResult> {
    const id = String(options.id || '').trim() || randomUUID();
    const stableOptions = { ...options, id, submittedAt: undefined };
    return this.newTaskRequests.run(id, { prompt, options: stableOptions, draft }, async (request) => {
      if (request.phase === 'accepted') {
        return {
          accepted: true,
          sessionId: request.sessionId,
          snapshot: await this.readSession(request.sessionId, false, false),
        };
      }
      return this.createNewTask(prompt, { ...options, id }, draft, request);
    });
  }

  private async createNewTask(
    prompt: DesktopPromptContent,
    options: DesktopSubmitOptions,
    draft: DesktopNewTaskDraft,
    request: NewTaskRequest
  ): Promise<DesktopNewTaskSubmitResult> {
    const { registeredProject, cwd, desktopSession } = await this.resolveSessionWorkspace(draft.projectPath);
    const created = await this.sessionClient.create(
      { sessionId: request.sessionId, cwd, desktopSession },
      this.callOptions(`session-create:${request.sessionId}`)
    );
    const sessionId = sessionIdOf(created.sessionId);
    if (sessionId !== request.sessionId) throw new Error('New task service returned a mismatched reserved session id.');
    this.pendingCatalogSessionIds.add(sessionId);
    this.applySessionResult(sessionId, created);
    try {
      if (request.phase === 'reserved' && draft.workflowId) {
        await this.invokeSession(sessionId, 'setWorkflow', [draft.workflowId]);
      }
      if (request.phase === 'reserved' && draft.route) {
        const routeResult = await this.invokeSession(sessionId, 'setRoute', [
          {
            provider: draft.route.provider,
            model: draft.route.model,
            ...(draft.route.effort ? { effort: draft.route.effort } : {}),
            ...(typeof draft.route.fast === 'boolean' ? { fast: draft.route.fast } : {}),
            ...(draft.route.modelParameters ? { modelParameters: draft.route.modelParameters } : {}),
            ...(typeof draft.route.contextPercent === 'number' ? { contextPercent: draft.route.contextPercent } : {}),
            applyToCurrentSession: true,
          },
        ]);
        const resolvedRoute =
          routeResult.value && typeof routeResult.value === 'object'
            ? (routeResult.value as Record<string, unknown>)
            : null;
        // Validate against setRoute's authoritative result. Its projected
        // snapshot is delivered independently and may still describe the
        // pre-route state during the first task after startup.
        if (draft.route.fast === true && resolvedRoute?.fast !== true) {
          throw new Error(`fast mode is not available for ${draft.route.provider}/${draft.route.model}`);
        }
      }
      if (request.phase === 'reserved') await request.commit('configured');
      const goalCommand = String(options.goalCommand || '').trim();
      if (goalCommand) {
        const goalResult = await this.invokeSession(sessionId, 'goalControl', [
          {
            command: goalCommand,
          },
        ]);
        const goalValue =
          goalResult.value && typeof goalResult.value === 'object'
            ? (goalResult.value as Record<string, unknown>)
            : null;
        const goal =
          goalValue?.goal && typeof goalValue.goal === 'object' ? (goalValue.goal as Record<string, unknown>) : null;
        if (goalValue?.ok !== true || !goal) {
          throw new Error(String(goalValue?.message || 'Goal could not be created.'));
        }
        const objective = String(goal?.objective || goalCommand).trim();
        await this.sessionMetadata.load();
        this.sessionMetadata.rememberGeneratedTitle(sessionId, objective);
        this.pendingCatalogSessionIds.delete(sessionId);
        await request.commit('accepted');
        void this.publishCatalogs();
        return { accepted: true, sessionId, snapshot: goalResult.snapshot };
      }
      const submissionId = String(options.id || '').trim() || `desktop-submit-${sessionId}-${Date.now()}`;
      const prior = this.publication.projections.get(sessionId);
      const result = await this.sessionClient.submit(
        {
          sessionId,
          prompt,
          options: { ...options, id: submissionId },
          open: { cwd, desktopSession },
          baseRevision: prior?.revision ?? null,
        },
        this.callOptions(`session-submit:${sessionId}:${submissionId}`)
      );
      if (String(result.sessionId || '') !== sessionId) {
        throw new Error('New task service returned a mismatched session id.');
      }
      const accepted = result.accepted === true;
      const snapshot = this.applySessionResult(sessionId, result);
      if (String(snapshot?.sessionId || '') !== sessionId) {
        throw new Error('New task service returned a mismatched session snapshot.');
      }
      if (!accepted) {
        await this.sessionClient.unsubscribe({ sessionId }, this.callOptions()).catch(() => ({}));
        return { accepted: false, sessionId: '', snapshot: null };
      }
      if (registeredProject) await this.projects.touchSelected(registeredProject);
      await this.sessionMetadata.load();
      this.sessionMetadata.rememberGeneratedTitle(sessionId, promptTitle(prompt, options.displayText || ''));
      this.pendingCatalogSessionIds.delete(sessionId);
      await request.commit('accepted');
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

  /**
   * /inherit — carry an existing conversation into a NEW session id running on
   * the currently selected model. The source session file is untouched, so the
   * two transcripts share a prefix and then diverge.
   */
  async inheritSession(
    sourceSessionId: string,
    route?: DesktopModelSelection | null
  ): Promise<{ sessionId: string; snapshot: SessionSnapshot | null }> {
    const source = sessionIdOf(sourceSessionId);
    const rows = await this.listSessions();
    const { cwd, desktopSession } = await this.resolveSessionWorkspace(
      rows.find((entry) => entry.id === source)?.projectPath
    );
    const created = await this.sessionClient.create(
      {
        cwd,
        desktopSession,
        ...(route?.provider ? { provider: route.provider } : {}),
        ...(route?.model ? { model: route.model } : {}),
      },
      this.callOptions(`session-create:${process.pid}:${randomUUID()}`)
    );
    const sessionId = sessionIdOf(created.sessionId);
    this.pendingCatalogSessionIds.add(sessionId);
    this.applySessionResult(sessionId, created);
    try {
      // The heir opens on the route the user is looking at; without this it
      // would inherit the daemon's current default instead.
      if (route) {
        await this.invokeSession(sessionId, 'setRoute', [
          {
            ...route,
            applyToCurrentSession: true,
          },
        ]);
      }
      const inherited = await this.invokeSession(sessionId, 'inheritFrom', [source]);
      await this.sessionMetadata.load();
      this.pendingCatalogSessionIds.delete(sessionId);
      void this.publishCatalogs();
      return { sessionId, snapshot: inherited.snapshot ?? null };
    } catch (error) {
      // A half-built heir must not linger in the catalog.
      try {
        await this.sessionClient.unsubscribe({ sessionId }, this.callOptions());
      } catch {
        /* the create is being abandoned either way */
      }
      throw error;
    } finally {
      this.pendingCatalogSessionIds.delete(sessionId);
    }
  }

  async submitToSession(
    sessionId: string,
    prompt: DesktopPromptContent,
    options: DesktopSubmitOptions = {}
  ): Promise<boolean> {
    const id = sessionIdOf(sessionId);
    const submissionId =
      String(options.id || '').trim() || `desktop-submit-${id}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const prior = this.publication.projections.get(id);
    const result = await this.sessionClient.submit(
      {
        sessionId: id,
        prompt,
        options: { ...options, id: submissionId },
        open: this.openHints(id),
        baseRevision: prior?.revision ?? null,
      },
      this.callOptions(`session-submit:${id}:${submissionId}`)
    );
    this.applySessionResult(id, result);
    return result.accepted === true;
  }

  async abortSession(sessionId: string, options: DesktopAbortOptions = {}): Promise<unknown> {
    const id = sessionIdOf(sessionId);
    const result = await this.sessionClient.abort(
      {
        sessionId: id,
        options,
        open: this.openHints(id),
        baseRevision: this.publication.projections.get(id)?.revision ?? null,
      },
      this.callOptions()
    );
    this.applySessionResult(id, result);
    return {
      aborted: result.aborted === true,
      restoreText: result.restoreText || '',
      pastedImages: result.pastedImages ?? null,
      pastedTexts: result.pastedTexts ?? null,
      discardPastedImages: result.discardPastedImages ?? null,
      discardPastedTexts: result.discardPastedTexts ?? null,
      restoredSubmissionIds: Array.isArray(result.restoredSubmissionIds) ? result.restoredSubmissionIds : [],
    };
  }

  async resolveToolApprovalForSession(sessionId: string, id: string, decision: ToolApprovalDecision): Promise<boolean> {
    const target = sessionIdOf(sessionId);
    const result = await this.sessionClient.approve(
      {
        sessionId: target,
        approvalId: id,
        decision,
        open: this.openHints(target),
        baseRevision: this.publication.projections.get(target)?.revision ?? null,
      },
      this.callOptions()
    );
    this.applySessionResult(target, result);
    return result.approved === true;
  }

  async listProviderModels(options: DesktopModelCatalogOptions = {}): Promise<DesktopModelOption[]> {
    return normalizedProviderModels(await this.invokeControl('listProviderModels', [options]));
  }

  async setModelRoute(selection: DesktopModelSelection, sessionId?: string): Promise<SessionSnapshot> {
    const target = sessionId || (await this.ensureControlSession());
    const { value, snapshot } = await this.invokeSession(target, 'setRoute', [
      {
        ...selection,
        applyToCurrentSession: true,
      },
    ]);
    if (value === false) {
      throw new Error('Model change was not applied because another session command is running.');
    }
    return snapshot;
  }

  async setFast(enabled: boolean, sessionId?: string): Promise<SessionSnapshot> {
    const target = sessionId || (await this.ensureControlSession());
    return (await this.invokeSession(target, 'setFast', [enabled])).snapshot;
  }

  async invokeCapability<T = unknown>(
    capability: DesktopCapability,
    args: unknown[] = [],
    sessionId?: string
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
    requests: ReadonlyArray<DesktopCapabilityReadRequest>
  ): Promise<DesktopCapabilityReadResult[]> {
    // Reads are independent getters: they go to the control session TOGETHER
    // so one slow status probe (MCP, plugins, skills, voice) never holds the
    // rest of its batch (user: 설정값 반응성). Result order stays positional.
    return Promise.all(
      requests.map(async (request): Promise<DesktopCapabilityReadResult> => {
        try {
          return {
            ok: true,
            value: copyCapabilityValue(await this.invokeControl(request.capability, request.args || [])),
          };
        } catch (error) {
          return {
            ok: false,
            error: error instanceof Error ? error.message : String(error),
          };
        }
      })
    );
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

  private ensureColdViewRefresh(): void {
    this.catalog.ensureColdViewRefresh();
  }

  private ensureStoreWatcher(): void {
    this.catalog.ensureStoreWatcher();
  }

  private sessionCatalog(): DesktopSessionSummary[] {
    return this.sessionMetadata.withReadCursors(
      this.sessionMetadata.withArchiveFlags(
        desktopSessionSummaries(this.rawSessionRows, this.sessionMetadata.titles, this.sessionMetadata.names)
      )
    );
  }

  private publishSessionCatalog(sessions: DesktopSessionSummary[]): void {
    if (this.disposed) return;
    const visible =
      this.pendingCatalogSessionIds.size === 0
        ? sessions
        : sessions.filter((session) => !this.pendingCatalogSessionIds.has(session.id));
    this.publication.publishSessions(visible);
  }

  private async publishCatalogs(): Promise<void> {
    await this.catalog.publishCatalogs();
  }

  dispose(): Promise<void> {
    if (this.disposePromise) return this.disposePromise;
    this.disposed = true;
    this.publication.clearListeners();
    this.disposePromise = (async () => {
      try {
        this.shellJobsPoller.stop();
        this.catalog.close();
        this.sessionViews.close();
        await this.sessionMetadata.flush();
      } finally {
        try {
          await this.sessionClient.close('service host disposed');
        } catch {}
        this.publication.clearProjections();
        this.visibleSessionIds.clear();
        this.visibleSessionSources.clear();
      }
    })();
    return this.disposePromise;
  }
}
