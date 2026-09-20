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
import { desktopSessionSummaries } from './desktop-state';
import type { DesktopService, SerializableDesktopServiceOptions } from './desktop-service-contract';
import { SessionHostCatalog, catalogRelevantStoreEntry } from './session-host-catalog';
import { SessionHostPublication } from './session-host-publication';
import { SessionHostLifecycle, mergeSessionHistorySnapshot } from './session-host-lifecycle';
export { mergeSessionHistorySnapshot };
import { SessionHostTransport } from './session-host-transport';
import type { SessionCallOptions, SessionClient } from './session-host-transport';
export type { SessionClient } from './session-host-transport';
import {
  DESKTOP_TRANSCRIPT_ITEM_LIMIT,
  type MixdogProjectsModule,
  type MixdogSessionStoreModule,
  type StatuslineSegmentsModule,
} from './desktop-support';
import { DesktopProjectRegistry } from './desktop-project-registry';
import { DesktopSessionMetadata } from './desktop-session-metadata';
import { SessionViewRegistry } from './session-view-registry';
import { NewTaskRequests } from './new-task-requests';
import { createShellJobsPoller } from './shell-jobs-poller';
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

interface SessionHostRuntime {
  attachSessionClient(options: {
    onFrame(frame: Record<string, unknown>): void;
    onFatal?(reason: string): void;
  }): Promise<SessionClient>;
  loadProjects(): Promise<MixdogProjectsModule>;
  loadSessionStore(): Promise<MixdogSessionStoreModule>;
  loadStatuslineSegments(): Promise<StatuslineSegmentsModule>;
  executeCodeGraphTool(name: string, args: Record<string, unknown>, cwd: string): Promise<unknown>;
}

export { catalogRelevantStoreEntry };

function dataDirectory(): string {
  if (process.env.MIXDOG_DATA_DIR) return process.env.MIXDOG_DATA_DIR;
  return join(process.env.MIXDOG_HOME || join(homedir(), '.mixdog'), 'data');
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
  private readonly transport: SessionHostTransport;
  private readonly lifecycle: SessionHostLifecycle;
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
  private readonly shellJobsPoller: ReturnType<typeof createShellJobsPoller>;
  private readonly taskWorkspacePath: string;
  /** Poller-facing engine state. The shell snapshot is the BLANK frame New
   *  Task/Project publishes: it carries no clientHostPid, so the poller read
   *  an owner pid of 0 and never scanned a single job record. Session frames
   *  carry both the owning host pid and the live busy flags. */
  private engineSnapshot: SessionSnapshot = null;
  private engineClientHostPid = 0;
  private rawSessionRows: Array<Record<string, unknown>> = [];
  private sessionCatalogLoaded = false;
  private sessionCatalogPromise: Promise<DesktopSessionSummary[]> | null = null;
  private disposed = false;
  private disposePromise: Promise<void> | null = null;

  private get sessionClient(): SessionClient {
    return this.transport.client;
  }

  private constructor(
    private readonly options: SerializableDesktopServiceOptions,
    private readonly runtime: SessionHostRuntime,
    sessionClient: SessionClient
  ) {
    this.publication = new SessionHostPublication({
      isDisposed: () => this.disposed,
      controlSessionId: () => this.transport.controlSessionId,
      setControlSessionId: (sessionId) => this.transport.setControlSessionId(sessionId),
      visibleSessionIds: () => this.visibleSessionIds,
      readSession: (sessionId) => this.transport.readSession(sessionId),
      snapshotWithShellJobs: (sessionId, snapshot) => this.snapshotWithShellJobs(sessionId, snapshot),
      trackShellJobsEngineState: (snapshot) => this.trackShellJobsEngineState(snapshot),
      onShellPublished: () => this.shellJobsPoller.onEngineEvent(),
    });
    this.transport = new SessionHostTransport(sessionClient, {
      isDisposed: () => this.disposed,
      taskWorkspace: () => this.taskWorkspace(),
      openHints: (sessionId) => this.openHints(sessionId),
      projection: (sessionId) => {
        const projection = this.publication.projections.get(sessionId);
        if (!projection) return undefined;
        return {
          revision: projection.revision,
          ...(projection.projectionStamp ? { projectionStamp: projection.projectionStamp } : {}),
        };
      },
      applySessionResult: (sessionId, value, publish) => this.publication.applySessionResult(sessionId, value, publish),
      deleteProjection: (sessionId) => {
        this.publication.projections.delete(sessionId);
      },
    });
    this.catalog = new SessionHostCatalog(
      {
        isDisposed: () => this.disposed,
        listSessions: () => this.listSessions(),
        listAgentPool: () => this.listAgentPool(),
        publishSessions: (sessions) => this.publishSessionCatalog(sessions),
        publishAgents: (agents) => this.publication.publishAgents(agents),
        coldSessionIds: () =>
          [...this.visibleSessionIds].filter((sessionId) => Boolean(this.publication.projections.get(sessionId)?.cold)),
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
    this.lifecycle = new SessionHostLifecycle({
      client: this.sessionClient,
      publication: this.publication,
      sessionViews: this.sessionViews,
      visibleSessionIds: this.visibleSessionIds,
      visibleSessionSources: this.visibleSessionSources,
      newTaskRequests: this.newTaskRequests,
      pendingCatalogSessionIds: this.pendingCatalogSessionIds,
      sessionMetadata: this.sessionMetadata,
      isDisposed: () => this.disposed,
      callOptions: (callId, timeoutMs) => this.callOptions(callId, timeoutMs),
      taskWorkspace: () => this.taskWorkspace(),
      canonicalDirectory: (path) => this.canonicalDirectory(path),
      enterProject: async (path) => {
        await this.projects.enter(path);
      },
      knownProject: (path) => this.projects.knownPath(path),
      touchProject: async (path) => {
        await this.projects.touchSelected(path);
      },
      resolveSessionWorkspace: (path) => this.resolveSessionWorkspace(path),
      projectDirectory: (path) => this.projectDirectory(path),
      openHints: (sessionId) => this.openHints(sessionId),
      readSession: (sessionId, forceFull, publish, readTraceId) =>
        this.readSession(sessionId, forceFull, publish, readTraceId),
      invokeSession: (sessionId, method, args) => this.invokeSession(sessionId, method, args),
      ensureControlSession: () => this.ensureControlSession(),
      invokeControlResult: (method, args) => this.invokeControlResult(method, args),
      invokeControl: (method, args) => this.invokeControl(method, args),
      applySessionResult: (sessionId, value, publish) => this.applySessionResult(sessionId, value, publish),
      publishSession: (sessionId, snapshot, frameSource, readTraceId) =>
        this.publishSession(sessionId, snapshot, frameSource, readTraceId),
      snapshotWithRemoteSession: (snapshot) => this.snapshotWithRemoteSession(snapshot),
      snapshotWithShellJobs: (sessionId, snapshot) => this.snapshotWithShellJobs(sessionId, snapshot),
      publishShell: (snapshot) => this.publishShell(snapshot),
      ensureColdViewRefresh: () => this.ensureColdViewRefresh(),
      listSessions: () => this.listSessions(),
      sessionCatalogLoaded: () => this.sessionCatalogLoaded,
      sessionCatalog: () => this.sessionCatalog(),
      publishSessionCatalog: (sessions) => this.publishSessionCatalog(sessions),
      publishCatalogs: () => this.publishCatalogs(),
      loadSessionStore: runtime.loadSessionStore,
    });
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
    // The poller needs ownership and activity, never the full transcript.
    this.engineSnapshot = {
      ownerClientHostPid: state.ownerClientHostPid,
      clientHostPid: state.clientHostPid,
      busy: snapshot.busy,
      commandBusy: snapshot.commandBusy,
    };
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
    return this.transport.readSession(sessionId, forceFull, publish, readTraceId);
  }

  private async invokeSession(
    sessionId: string,
    method: string,
    args: unknown[] = []
  ): Promise<{ value: unknown; snapshot: SessionSnapshot; result: Record<string, unknown> }> {
    return this.transport.invokeSession(sessionId, method, args);
  }

  private async ensureControlSession(): Promise<string> {
    return this.transport.ensureControlSession();
  }

  private async invokeControlResult(
    method: string,
    args: unknown[] = []
  ): Promise<{ value: unknown; snapshot: SessionSnapshot; result: Record<string, unknown> }> {
    return this.transport.invokeControlResult(method, args);
  }

  private async invokeControl(method: string, args: unknown[] = []): Promise<unknown> {
    return this.transport.invokeControl(method, args);
  }

  async startProject(projectPath: string): Promise<SessionSnapshot> {
    return this.lifecycle.startProject(projectPath);
  }

  async startProjectTask(projectPath: string): Promise<SessionSnapshot> {
    return this.lifecycle.startProjectTask(projectPath);
  }

  async startTask(): Promise<SessionSnapshot> {
    return this.lifecycle.startTask();
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
    return this.lifecycle.markSessionRead(sessionId, messageCount, consumedUnread);
  }

  async renameSession(sessionId: string, title: string): Promise<void> {
    return this.lifecycle.renameSession(sessionId, title);
  }

  async setSessionArchived(sessionId: string, archived: boolean): Promise<void> {
    return this.lifecycle.setSessionArchived(sessionId, archived);
  }

  async deleteSession(sessionId: string): Promise<SessionSnapshot> {
    return this.lifecycle.deleteSession(sessionId);
  }

  async prefetchSession(
    sessionId: string,
    transcriptItemLimit = DESKTOP_TRANSCRIPT_ITEM_LIMIT,
    readTraceId?: string
  ): Promise<boolean> {
    return this.lifecycle.prefetchSession(sessionId, transcriptItemLimit, readTraceId);
  }

  async replaySessionStates(
    sessionIds: string[],
    deliver: (updates: DesktopSessionStateUpdate[]) => void
  ): Promise<void> {
    return this.lifecycle.replaySessionStates(sessionIds, deliver);
  }

  async setVisibleSessions(sessionIds: string[]): Promise<boolean> {
    return this.lifecycle.setVisibleSessions(sessionIds);
  }

  async setVisibleSessionsForSource(sourceId: string, sessionIds: string[]): Promise<boolean> {
    return this.lifecycle.setVisibleSessionsForSource(sourceId, sessionIds);
  }

  async searchProjectFiles(projectIdOrWorkspaceId: string, query: string, limit = 50): Promise<string[]> {
    return this.lifecycle.searchProjectFiles(projectIdOrWorkspaceId, query, limit);
  }

  async submitNewTask(
    prompt: DesktopPromptContent,
    options: DesktopSubmitOptions = {},
    draft: DesktopNewTaskDraft = {}
  ): Promise<DesktopNewTaskSubmitResult> {
    return this.lifecycle.submitNewTask(prompt, options, draft);
  }

  async inheritSession(
    sourceSessionId: string,
    route?: DesktopModelSelection | null
  ): Promise<{ sessionId: string; snapshot: SessionSnapshot | null }> {
    return this.lifecycle.inheritSession(sourceSessionId, route);
  }

  async submitToSession(
    sessionId: string,
    prompt: DesktopPromptContent,
    options: DesktopSubmitOptions = {}
  ): Promise<boolean> {
    return this.lifecycle.submitToSession(sessionId, prompt, options);
  }

  async abortSession(sessionId: string, options: DesktopAbortOptions = {}): Promise<unknown> {
    return this.lifecycle.abortSession(sessionId, options);
  }

  async resolveToolApprovalForSession(sessionId: string, id: string, decision: ToolApprovalDecision): Promise<boolean> {
    return this.lifecycle.resolveToolApprovalForSession(sessionId, id, decision);
  }

  async listProviderModels(options: DesktopModelCatalogOptions = {}): Promise<DesktopModelOption[]> {
    return this.lifecycle.listProviderModels(options);
  }

  async setModelRoute(selection: DesktopModelSelection, sessionId?: string): Promise<SessionSnapshot> {
    return this.lifecycle.setModelRoute(selection, sessionId);
  }

  async setFast(enabled: boolean, sessionId?: string): Promise<SessionSnapshot> {
    return this.lifecycle.setFast(enabled, sessionId);
  }

  async invokeCapability<T = unknown>(
    capability: DesktopCapability,
    args: unknown[] = [],
    sessionId?: string
  ): Promise<DesktopCapabilityResult<T>> {
    return this.lifecycle.invokeCapability(capability, args, sessionId);
  }

  async readCapabilities(
    requests: ReadonlyArray<DesktopCapabilityReadRequest>
  ): Promise<DesktopCapabilityReadResult[]> {
    return this.lifecycle.readCapabilities(requests);
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
