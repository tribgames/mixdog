import { randomUUID } from 'node:crypto';
import {
  agentNotificationMutePath,
  createAgentNotificationMuteStore,
  type AgentNotificationMuteStore,
} from './agent-notification-mute';
import { mkdir, realpath, stat } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { canonicalPath } from '../../../../src/runtime/shared/worktrees/paths.mjs';

import type {
  DesktopAbortOptions,
  DesktopAgentMemoryEntry,
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
  DesktopSessionContentMatch,
  DesktopSessionFrameSource,
  DesktopSessionStateUpdate,
  DesktopSessionSummary,
  DesktopSubmitOptions,
  SessionSnapshot,
  ToolApprovalDecision,
} from '../shared/contract';
import {
  isAttachmentReference,
  isPermanentAttachmentError,
  readAttachmentBuffer,
} from '../../../../src/runtime/attachments/store.mjs';
import { isActiveDesktopAgentEntry } from '../shared/agent-activity';
import { desktopSessionSummaries } from './desktop-state';
import type { RoomDecision } from '../../../../src/runtime/agent/orchestrator/session/agent-room-supervisor.mjs';
import { type AgentRooms, createAgentRoomFileStore, createAgentRooms } from './agent-rooms';
import { deleteAgentMemory, listAgentMemory } from './agent-memory';
import {
  isSessionMissingError,
  sessionFinalAnswer,
  withSessionMissingCode,
  type SessionFinalAnswer,
} from './session-final-answer';
import type { DesktopService, SerializableDesktopServiceOptions } from './desktop-service-contract';
import { mixdogDataDirectory } from './computer/shared/common';
import { SessionHostCatalog, catalogRelevantStoreEntry } from './session-host-catalog';
import { SessionHostPublication } from './session-host-publication';
import { SessionHostLifecycle } from './session-host-lifecycle';
import { SessionHostTransport, sessionIdOf } from './session-host-transport';
import { SessionTranscriptWindows } from './session-transcript-windows';
import type { SessionCallOptions, SessionClient } from './session-host-transport';
export type { SessionClient } from './session-host-transport';
import {
  DESKTOP_TRANSCRIPT_ITEM_LIMIT,
  type MixdogProjectsModule,
  type MixdogWorktreesModule,
  type MixdogSessionSearchModule,
  type MixdogSessionStoreModule,
  type StatuslineSegmentsModule,
} from './desktop-support';
import { DesktopProjectRegistry } from './desktop-project-registry';
import { resolveManagedWorktree, type ManagedWorktreeScope } from './managed-worktree-path';
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
  /** Worktree registry; optional: an older daemon has no managed worktrees. */
  loadWorktrees?(): Promise<MixdogWorktreesModule>;
  loadSessionStore(): Promise<MixdogSessionStoreModule>;
  loadSessionSearch?(): Promise<MixdogSessionSearchModule>;
  loadStatuslineSegments(): Promise<StatuslineSegmentsModule>;
  executeCodeGraphTool(name: string, args: Record<string, unknown>, cwd: string): Promise<unknown>;
}

export { catalogRelevantStoreEntry };

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
  /** Group rooms: their records, and the members' turns in flight. */
  private readonly agentRooms: AgentRooms;
  private readonly catalog: SessionHostCatalog;
  private readonly sessionViews = new SessionViewRegistry();
  private readonly visibleSessionIds = this.sessionViews.visible;
  private readonly visibleSessionSources = this.sessionViews.sources;
  private readonly transcriptWindows = new SessionTranscriptWindows(this.visibleSessionSources);
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
  private publishedAgentRows: DesktopAgentPoolRow[] = [];
  private sessionCatalogPromise: Promise<DesktopSessionSummary[]> | null = null;
  private agentPoolRowsPromise: Promise<DesktopAgentPoolRow[]> | null = null;
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
      readSession: (sessionId, forceFull) => this.transport.readSession(sessionId, forceFull),
      snapshotWithShellJobs: (sessionId, snapshot) => this.snapshotWithShellJobs(sessionId, snapshot),
      trackShellJobsEngineState: (snapshot) => this.trackShellJobsEngineState(snapshot),
      onShellPublished: () => this.shellJobsPoller.onEngineEvent(),
      clearSessionActivity: () => this.clearSessionActivity(),
    });
    this.transport = new SessionHostTransport(sessionClient, {
      isDisposed: () => this.disposed,
      taskWorkspace: () => this.taskWorkspace(),
      openHints: (sessionId) => this.openHints(sessionId),
      transcriptWindow: (sessionId) => this.transcriptWindows.send(sessionId),
      projection: (sessionId) => {
        const projection = this.publication.projections.get(sessionId);
        if (!projection) return undefined;
        return {
          revision: projection.revision,
          ...(projection.projectionStamp ? { projectionStamp: projection.projectionStamp } : {}),
        };
      },
      applySessionResult: (sessionId, value, publish) => this.publication.applySessionResult(sessionId, value, publish),
      heldTranscript: (sessionId) => this.publication.heldTranscript(sessionId),
      applyTranscriptPage: (sessionId, value, publish) =>
        this.publication.applyTranscriptPage(sessionId, value, publish),
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
        publishAgents: (agents) => this.publishAgentPool(agents),
        coldSessionIds: () =>
          [...this.visibleSessionIds].filter((sessionId) => Boolean(this.publication.projections.get(sessionId)?.cold)),
        readSession: (sessionId) => this.readSession(sessionId),
      },
      {
        directory: mixdogDataDirectory,
        // The daemon hosts this service and the stored-session reader in one
        // process: the reader's background corrections refresh the catalog.
        subscribeStoreChanges: async (changed) =>
          (await runtime.loadSessionStore()).subscribeStoredSessionCatalogChanges?.(changed),
      }
    );
    this.shellJobsPoller = createShellJobsPoller({
      getEngineState: () => this.shellJobsEngineState(),
      loadModule: runtime.loadStatuslineSegments,
      onChange: (sessionIds, everySession) => this.publishShellJobChanges(sessionIds, everySession),
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
      transcriptWindows: this.transcriptWindows,
      agentGreetingsPath: join(options.userDataPath, 'agent-greetings.json'),
      isDisposed: () => this.disposed,
      callOptions: (callId, timeoutMs) => this.callOptions(callId, timeoutMs),
      taskWorkspace: () => this.taskWorkspace(),
      canonicalDirectory: (path) => this.canonicalDirectory(path),
      enterProject: async (path) => {
        await this.projects.enter(path);
      },
      knownProject: (path) => this.knownProjectPath(path),
      registeredProject: (path) => this.projects.knownPath(path),
      touchProject: async (path) => {
        try {
          await this.projects.touchSelected(path);
        } catch {
          // Recency is advisory, including after the daemon accepts a task.
          // Registration and explicit mutations keep their strict boundaries.
        }
      },
      resolveSessionWorkspace: (path) => this.resolveSessionWorkspace(path),
      sessionProjectPath: (session) => this.projects.sessionProjectPath(session),
      projectDirectory: (path) => this.projectDirectory(path),
      openHints: (sessionId) => this.openHints(sessionId),
      readSession: (sessionId, forceFull, publish, readTraceId, page) =>
        this.readSession(sessionId, forceFull, publish, readTraceId, page),
      invokeSession: (sessionId, method, args) => this.transport.invokeSession(sessionId, method, args),
      ensureControlSession: () => this.transport.ensureControlSession(),
      invokeControlResult: (method, args) => this.transport.invokeControlResult(method, args),
      invokeControl: (method, args) => this.transport.invokeControl(method, args),
      applySessionResult: (sessionId, value, publish) => this.publication.applySessionResult(sessionId, value, publish),
      publishSession: (sessionId, snapshot, frameSource, readTraceId) =>
        this.publishSession(sessionId, snapshot, frameSource, readTraceId),
      snapshotWithRemoteSession: (snapshot) => this.publication.snapshotWithRemoteSession(snapshot),
      snapshotWithShellJobs: (sessionId, snapshot) => this.snapshotWithShellJobs(sessionId, snapshot),
      publishShell: (snapshot) => this.publication.publishShell(snapshot),
      ensureColdViewRefresh: () => this.catalog.ensureColdViewRefresh(),
      listSessions: () => this.listSessions(),
      storedSessionIds: () => this.rawSessionRows.map((row) => String(row.id || '')).filter(Boolean),
      storedSessionRows: () => this.rawSessionRows,
      sessionCatalogLoaded: () => this.sessionCatalogLoaded,
      sessionCatalog: () => this.sessionCatalog(),
      publishSessionCatalog: (sessions) => this.publishSessionCatalog(sessions),
      publishCatalogs: () => this.catalog.publishCatalogs(),
    });
    this.agentRooms = createAgentRooms({
      store: createAgentRoomFileStore(join(options.userDataPath, 'agent-rooms.json')),
      listAgents: () => this.transport.invokeControl('listAgents', []),
      leadName: async () =>
        String(((await this.transport.invokeControl('getLeadStatus', [])) as { name?: unknown } | null)?.name || ''),
      mixyRoute: async () =>
        ((await this.transport.invokeControl('getLeadStatus', [])) as { route?: unknown } | null)?.route ?? null,
      sessionExists: async (sessionId) => {
        try {
          await this.readSession(sessionId, false, false);
          return true;
        } catch (error) {
          if (isSessionMissingError(error)) return false;
          throw error;
        }
      },
      createSession: async (sessionId, params) => {
        const created = await this.sessionClient.create(
          { ...params, sessionId },
          this.callOptions(`session-create:${sessionId}`)
        );
        if (sessionIdOf(created.sessionId) !== sessionId) throw new Error('Room returned a mismatched session id.');
        this.publication.applySessionResult(sessionId, created, false);
      },
      renameSession: (sessionId, title) => this.lifecycle.renameSession(sessionId, title),
      appendRows: (sessionId, rows) => this.transport.invokeControl('appendRoomRows', [sessionId, rows]),
      readItems: async (sessionId) => (await this.readSession(sessionId, false, false))?.items ?? [],
      // A member's turn goes in as any chat prompt does; the user's files in it
      // are already stored references, which the daemon intake takes as they are.
      submit: (sessionId, prompt) => this.lifecycle.submitToSession(sessionId, prompt as DesktopPromptContent, {}),
      readSnapshot: (sessionId) => this.readSession(sessionId, false, false),
      decideTurn: async (input) =>
        ((await this.transport.invokeControl('decideRoomTurn', [input])) as
          | RoomDecision
          | { action: 'unmanaged' }
          | null) ?? null,
      abort: async (sessionId) => {
        await this.lifecycle.abortSession(sessionId, {});
      },
      approve: (sessionId, approvalId, decision) =>
        this.lifecycle.resolveToolApprovalForSession(sessionId, approvalId, decision),
      deleteSession: async (sessionId) => {
        await this.lifecycle.deleteSession(sessionId);
      },
      setArchived: (sessionId, archived) => this.lifecycle.setSessionArchived(sessionId, archived),
      startOver: (sessionId) => this.lifecycle.startSessionOver(sessionId),
      resetMember: (sessionId) => this.lifecycle.resetSessionConversation(sessionId, { fork: false }),
      taskWorkspace: () => this.taskWorkspace(),
      republish: (sessionId) => {
        const projection = this.publication.projections.get(sessionId);
        if (projection) this.publishSession(sessionId, projection.snapshot);
      },
      republishCatalog: () => {
        if (this.sessionCatalogLoaded) this.publishSessionCatalog(this.sessionCatalog());
        else void this.catalog.publishCatalogs();
      },
    });
  }

  /** The cached rows' `working` / `agentWorking` come from the daemon's
   *  in-memory run state and die with its connection: strip them and republish
   *  so the sidebar stops spinning. The next listing restores whatever the
   *  daemon reports again. */
  private clearSessionActivity(): void {
    this.settlePublishedAgentPool();
    let changed = false;
    this.rawSessionRows = this.rawSessionRows.map((row) => {
      if (!('working' in row) && !('agentWorking' in row)) return row;
      changed = true;
      const { working: _working, agentWorking: _agentWorking, ...settled } = row;
      return settled;
    });
    if (changed) this.publishSessionCatalog(this.sessionCatalog());
  }

  private publishAgentPool(agents: DesktopAgentPoolRow[]): void {
    this.publishedAgentRows = agents;
    this.publication.publishAgents(agents);
  }

  /** Pool rows read `running` only from the daemon's report. With the daemon
   *  gone, a still-active published row reads `unknown` (as the daemon itself
   *  projects a declared-working row it does not run) until its next report. */
  private settlePublishedAgentPool(): void {
    let changed = false;
    const settled = this.publishedAgentRows.map((row) => {
      if (!isActiveDesktopAgentEntry(row)) return row;
      changed = true;
      const { awaitingUser: _awaitingUser, ...rest } = row as DesktopAgentPoolRow & { awaitingUser?: unknown };
      return { ...rest, status: 'unknown', stage: 'unknown', turnStartedAt: null } as DesktopAgentPoolRow;
    });
    if (!changed) return;
    this.publishAgentPool(settled);
  }

  static async create(options: SerializableDesktopServiceOptions, runtime: SessionHostRuntime): Promise<SessionHost> {
    let host: SessionHost | null = null;
    const sessionClient = await runtime.attachSessionClient({
      onFrame(frame) {
        host?.publication.handleSessionFrame(frame);
      },
      onFatal() {
        host?.publication.handleSessionTransportLoss();
      },
    });
    host = new SessionHost(options, runtime, sessionClient);
    host.shellJobsPoller.start();
    // Secure the receipts folder now, off the first submission's path.
    void host.newTaskRequests.prepare();
    // A group-room exchange a restart cut off is marked interrupted, never resumed.
    void host.agentRooms
      .recover()
      .catch((error) => console.warn('[mixdog-rooms] Could not recover group rooms:', error));
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

  /** Live engine state for the shell-job poller: newest session frame first,
   *  with the blank shell snapshot as the only fallback. A frame that lost its
   *  pid field still polls under the last known owner. */
  private shellJobsEngineState(): Record<string, unknown> | null {
    const base = (this.engineSnapshot ?? this.publication.shellSnapshot) as Record<string, unknown> | null;
    if (!base || typeof base !== 'object') return null;
    if (Number(base.clientHostPid) > 0) return base;
    return this.engineClientHostPid > 0 ? { ...base, clientHostPid: this.engineClientHostPid } : base;
  }

  /** Every session frame refreshes the poller's engine state and re-arms it,
   *  so a shell promoted to the background surfaces on the fast cadence. */
  private trackShellJobsEngineState(snapshot: SessionSnapshot): void {
    if (!snapshot || typeof snapshot !== 'object') return;
    const state = snapshot as Record<string, unknown>;
    const pid = Number(state.clientHostPid) || 0;
    if (pid > 0) this.engineClientHostPid = pid;
    // The poller needs ownership and activity, never the full transcript.
    this.engineSnapshot = {
      clientHostPid: state.clientHostPid,
      busy: snapshot.busy,
      commandBusy: snapshot.commandBusy,
    };
    this.shellJobsPoller.onEngineEvent();
  }

  private snapshotWithShellJobs(sessionId: string, snapshot: SessionSnapshot): SessionSnapshot {
    if (!snapshot || typeof snapshot !== 'object') return snapshot;
    const shellJobs = this.shellJobsPoller.statusFor(sessionId, this.sessionCwd(sessionId));
    const hostShellJobs = this.shellJobsPoller.status;
    // A group room's log also shows its members' exchange in flight.
    return this.agentRooms.decorate(sessionId, {
      ...snapshot,
      shellJobs: { ...shellJobs, jobs: [...shellJobs.jobs] },
      hostShellJobs: { ...hostShellJobs, jobs: [...hostShellJobs.jobs] },
    });
  }

  private publishShellJobChanges(sessionIds: readonly string[], everySession = false): void {
    const targets = everySession ? new Set([...sessionIds, ...this.publication.projections.keys()]) : sessionIds;
    for (const sessionId of targets) {
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

  private callOptions(callId: string = randomUUID(), timeoutMs?: number): SessionCallOptions {
    return this.transport.callOptions(callId, timeoutMs);
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
    if (!requested) {
      return {
        registeredProject: '',
        cwd: await this.taskWorkspace(),
        desktopSession: { classification: 'task', projectPath: null },
      };
    }
    // A managed worktree executes in its own folder while the session's
    // project identity stays the registered main Project.
    const { projectPath: registeredProject, worktree } = await this.projectScope(requested);
    const project = await this.canonicalDirectory(registeredProject);
    return {
      registeredProject,
      cwd: worktree?.path ?? project,
      desktopSession: { classification: 'project', projectPath: project },
    };
  }

  /** The registered Project a path belongs to: the path itself, or the owner of
   *  the managed worktree it names. Any other path is rejected. */
  private async projectScope(path: string): Promise<{ projectPath: string; worktree: ManagedWorktreeScope | null }> {
    try {
      return { projectPath: await this.projects.knownPath(path), worktree: null };
    } catch (error) {
      const worktree = await resolveManagedWorktree(
        this.runtime.loadWorktrees ? () => this.runtime.loadWorktrees!() : undefined,
        (projectPath) => this.projects.knownPath(projectPath),
        path
      );
      if (!worktree) throw error;
      return { projectPath: worktree.projectPath, worktree };
    }
  }

  private async knownProjectPath(path: string): Promise<string> {
    return (await this.projectScope(path)).projectPath;
  }

  private async canonicalDirectory(path: string): Promise<string> {
    const canonical = await realpath(path);
    if (!(await stat(canonical)).isDirectory()) {
      throw new TypeError('Session workspace is not a directory.');
    }
    return canonical;
  }

  private sessionRow(sessionId: string) {
    const row = this.rawSessionRows.find((entry) => String(entry.id || '') === sessionId);
    const workspace =
      row?.workspace && typeof row.workspace === 'object' ? (row.workspace as Record<string, unknown>) : null;
    // The execution root may be a managed worktree; the project identity is
    // always the registered main Project.
    return { row, workspace, cwd: String(workspace?.cwd || row?.cwd || '') };
  }

  private sessionCwd(sessionId: string): string {
    return this.sessionRow(sessionId).cwd;
  }

  private openHints(sessionId: string): Record<string, unknown> {
    const { row, workspace, cwd } = this.sessionRow(sessionId);
    const stored =
      row?.desktopSession && typeof row.desktopSession === 'object'
        ? (row.desktopSession as Record<string, unknown>)
        : null;
    const workspaceProject = String(workspace?.projectPath || '');
    const desktopSession =
      stored ?? (workspaceProject ? { classification: 'project', projectPath: workspaceProject } : null);
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
    readTraceId?: string,
    page = false,
    signal?: AbortSignal
  ): Promise<SessionSnapshot> {
    return this.transport.readSession(sessionId, forceFull, publish, readTraceId, page, signal);
  }

  async readAttachmentImage(attachmentRef: string): Promise<string | null> {
    if (!isAttachmentReference({ attachmentRef })) return null;
    try {
      return readAttachmentBuffer(attachmentRef).toString('base64');
    } catch (error) {
      if (isPermanentAttachmentError(error)) return null;
      throw error;
    }
  }

  async readSessionFinalAnswer(
    sessionId: string,
    startedAt: number,
    signal?: AbortSignal
  ): Promise<SessionFinalAnswer | null> {
    // Read this session without selecting it or publishing a pane snapshot.
    try {
      return sessionFinalAnswer(await this.readSession(sessionId, false, false, undefined, false, signal), startedAt);
    } catch (error) {
      throw withSessionMissingCode(error);
    }
  }

  async readSessionTranscript(sessionId: string): Promise<SessionSnapshot> {
    const id = sessionIdOf(sessionId);
    // The held projection is exactly what this host published to its views.
    return this.publication.projections.get(id)?.snapshot ?? (await this.readSession(id, false, false));
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

  async projectRecoveryDirectory(projectPath: string): Promise<string> {
    try {
      const known = await this.projects.knownPath(projectPath);
      try {
        return await this.canonicalDirectory(known);
      } catch (cause) {
        // Live projects must use the same canonical journal key as edits.
        // Missing registered roots still allow inspection of retained backups.
        if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return resolve(known);
        throw cause;
      }
    } catch (error) {
      if (!isAbsolute(projectPath) || !this.runtime.loadWorktrees) throw error;
      const worktrees = await this.runtime.loadWorktrees();
      const requested = resolve(projectPath);
      const entry = await (worktrees.findWorktreeContaining ?? worktrees.getWorktreeByPath)(requested);
      if (!entry || !['ready', 'deleting', 'recovery'].includes(entry.state ?? 'ready')) throw error;
      await this.projects.knownPath(entry.projectPath);
      const key = (path: string) => (process.platform === 'win32' ? resolve(path).toLowerCase() : resolve(path));
      const within = (base: string, path: string) => key(path) === key(base) || key(path).startsWith(key(base) + sep);
      // Resolve parent aliases/Windows short names even after the checkout is
      // gone. Do not resolve the checkout itself: it may be a replacement link.
      const stableRoot = join(canonicalPath(dirname(entry.path)), basename(entry.path));
      const spelling = [resolve(entry.path), stableRoot].find((base) => within(base, requested));
      if (!spelling) throw error;
      const target = join(stableRoot, relative(spelling, requested));
      let canonical: string;
      try {
        canonical = await realpath(target);
      } catch (cause) {
        if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return target;
        throw cause;
      }
      return within(stableRoot, canonical) ? canonical : target;
    }
  }

  async projectDirectory(projectPath: string): Promise<string> {
    const { projectPath: known, worktree } = await this.projectScope(projectPath);
    return worktree?.path ?? this.canonicalDirectory(known);
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
      this.publication.applyRemoteSessionState(catalog.remoteSession);
      this.rawSessionRows = Array.isArray(catalog.sessions) ? (catalog.sessions as Array<Record<string, unknown>>) : [];
      this.sessionCatalogLoaded = true;
      this.catalog.ensureStoreWatcher();
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

  async searchSessionContent(query: string): Promise<DesktopSessionContentMatch[]> {
    const search = await this.runtime.loadSessionSearch?.();
    if (!search) return [];
    const hits = await search.searchSessionMessages(query, { limit: 50 });
    return Array.isArray(hits) ? hits.map(({ sessionId, snippet, rank }) => ({ sessionId, snippet, rank })) : [];
  }

  async listAgentPool(): Promise<DesktopAgentPoolRow[]> {
    let pending = this.agentPoolRowsPromise;
    if (!pending) {
      pending = (async () => {
        const store = await this.runtime.loadSessionStore();
        const rows = await store.listStoredAgentWorkers?.();
        return Array.isArray(rows) ? rows : [];
      })();
      this.agentPoolRowsPromise = pending;
    }
    // Share only the outstanding store read: each caller gets fresh row
    // objects, and the next settled call must observe subsequent store changes.
    try {
      return (await pending).map((row) => ({ ...row }));
    } finally {
      if (this.agentPoolRowsPromise === pending) this.agentPoolRowsPromise = null;
    }
  }

  async markSessionRead(sessionId: string, messageCount: number, consumedUnread = false): Promise<boolean> {
    return this.lifecycle.markSessionRead(sessionId, messageCount, consumedUnread);
  }

  async renameSession(sessionId: string, title: string): Promise<void> {
    return this.lifecycle.renameSession(sessionId, title);
  }

  async continueSessionInModel(sessionId: string, route: DesktopModelSelection): Promise<boolean> {
    return this.lifecycle.continueSessionInModel(sessionId, route);
  }

  async scheduleQuotaResume(sessionId: string): Promise<boolean> {
    return this.lifecycle.scheduleQuotaResume(sessionId);
  }

  async cancelQuotaResume(sessionId: string): Promise<boolean> {
    return this.lifecycle.cancelQuotaResume(sessionId);
  }

  async stopShellJob(sessionId: string, taskId: string): Promise<{ stopped: boolean; error?: string }> {
    return this.lifecycle.stopShellJob(sessionId, taskId);
  }

  async releaseShellJob(sessionId: string, taskId: string): Promise<{ released: boolean; error?: string }> {
    return this.lifecycle.releaseShellJob(sessionId, taskId);
  }

  async getQuotaAutoResume(): Promise<boolean> {
    return this.lifecycle.getQuotaAutoResume();
  }

  async setQuotaAutoResume(enabled: boolean): Promise<boolean> {
    return this.lifecycle.setQuotaAutoResume(enabled);
  }

  async setSessionFavorite(sessionId: string, favorite: boolean): Promise<void> {
    return this.lifecycle.setSessionFavorite(sessionId, favorite);
  }

  async setSessionProject(sessionId: string, projectPath: string): Promise<void> {
    return this.lifecycle.setSessionProject(sessionId, projectPath);
  }

  async setSessionArchived(sessionId: string, archived: boolean): Promise<void> {
    return this.lifecycle.setSessionArchived(sessionId, archived);
  }

  async archiveSessionAlone(sessionId: string): Promise<void> {
    return this.lifecycle.setSessionArchived(sessionId, true, false);
  }

  async forgetSessionMetadata(sessionId: string): Promise<void> {
    return this.lifecycle.forgetSessionMetadata(sessionId);
  }

  async sessionSidebarState(): Promise<{ archived: Record<string, number> }> {
    return this.lifecycle.sessionSidebarState();
  }

  async openAgentHome(agentId: string): Promise<{ sessionId: string }> {
    return this.lifecycle.openAgentHome(agentId);
  }

  private notificationMuteStore: AgentNotificationMuteStore | null = null;
  private get notificationMutes(): AgentNotificationMuteStore {
    this.notificationMuteStore ??= createAgentNotificationMuteStore(
      agentNotificationMutePath(this.options.userDataPath)
    );
    return this.notificationMuteStore;
  }

  /** Per-agent push mute (agent-notification-mute.ts): pushes only, in-app state untouched. */
  async getAgentNotificationMute(agentId: string): Promise<boolean> {
    return this.notificationMutes.isMuted(agentId);
  }

  async setAgentNotificationMute(agentId: string, muted: boolean): Promise<boolean> {
    return this.notificationMutes.setMuted(agentId, muted);
  }

  /** Local (push notifier): whether the agent `sessionId` belongs to is muted. */
  isSessionNotificationMuted(sessionId: string): boolean {
    return this.notificationMutes.isSessionMuted(sessionId);
  }

  async resetAgentHome(agentId: string): Promise<{ sessionId: string; archivedSessionId: string | null }> {
    return this.lifecycle.resetAgentHome(agentId);
  }

  async listAgentMemory(agentId: string): Promise<DesktopAgentMemoryEntry[]> {
    return listAgentMemory((method, args) => this.transport.invokeControl(method, args), agentId);
  }

  async deleteAgentMemory(
    agentId: string,
    entry: Pick<DesktopAgentMemoryEntry, 'id' | 'indexRevision'>
  ): Promise<void> {
    return deleteAgentMemory((method, args) => this.transport.invokeControl(method, args), agentId, entry);
  }

  async deleteSession(sessionId: string): Promise<SessionSnapshot> {
    return this.lifecycle.deleteSession(sessionId);
  }

  async prefetchSession(sessionId: string, transcriptItemLimit?: number, readTraceId?: string): Promise<boolean> {
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

  async setVisibleSessionsForSource(
    sourceId: string,
    sessionIds: string[],
    legacyTranscript = false
  ): Promise<boolean> {
    return this.lifecycle.setVisibleSessionsForSource(sourceId, sessionIds, legacyTranscript);
  }

  async searchProjectFiles(
    projectIdOrWorkspaceId: string,
    query: string,
    limit = 50,
    includeIgnored = false,
    includeDirectories = false
  ): Promise<string[]> {
    return this.lifecycle.searchProjectFiles(projectIdOrWorkspaceId, query, limit, includeIgnored, includeDirectories);
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
    route?: DesktopModelSelection | null,
    options?: { compact: boolean } | null
  ): Promise<{ sessionId: string; snapshot: SessionSnapshot | null }> {
    return this.lifecycle.inheritSession(sourceSessionId, route, options);
  }

  async submitToSession(
    sessionId: string,
    prompt: DesktopPromptContent,
    options: DesktopSubmitOptions = {}
  ): Promise<boolean> {
    // A group room's composer (any surface) posts into the room, which runs
    // its members; the log session itself never runs a turn.
    if (this.agentRooms.isRoom(sessionIdOf(sessionId))) {
      return this.agentRooms.send(sessionIdOf(sessionId), prompt, String(options.id || ''), options);
    }
    return this.lifecycle.submitToSession(sessionId, prompt, options);
  }

  async abortSession(sessionId: string, options: DesktopAbortOptions = {}): Promise<unknown> {
    if (this.agentRooms.isRoom(sessionIdOf(sessionId))) {
      return { aborted: this.agentRooms.stop(sessionIdOf(sessionId)), restoreText: '', restoredSubmissionIds: [] };
    }
    return this.lifecycle.abortSession(sessionId, options);
  }

  async resolveToolApprovalForSession(sessionId: string, id: string, decision: ToolApprovalDecision): Promise<boolean> {
    if (this.agentRooms.isRoom(sessionIdOf(sessionId))) {
      return this.agentRooms.approve(sessionIdOf(sessionId), id, decision);
    }
    return this.lifecycle.resolveToolApprovalForSession(sessionId, id, decision);
  }

  /** Group rooms (agent-rooms.ts): `create` (config) → `{ sessionId }`,
   *  `update` (roomId, patch), `continue` (roomId), `leave` (roomId),
   *  `reset` (roomId) → `{ archivedSessionId }`, `remove` (roomId). */
  async agentRoomAction(action: string, args: unknown[] = []): Promise<unknown> {
    const [first, second] = args;
    const roomId = typeof first === 'string' ? first : '';
    if (action === 'create') return this.agentRooms.create((first ?? {}) as Record<string, unknown>);
    if (action === 'update') return this.agentRooms.update(roomId, (second ?? {}) as Record<string, unknown>);
    if (action === 'continue') return this.agentRooms.proceed(roomId);
    if (action === 'leave') return this.agentRooms.leave(roomId);
    if (action === 'reset') return this.agentRooms.reset(roomId);
    if (action === 'remove') return this.agentRooms.remove(roomId);
    throw new TypeError(`Unknown room action "${action}".`);
  }

  async listProviderModels(options: DesktopModelCatalogOptions = {}): Promise<DesktopModelOption[]> {
    return this.lifecycle.listProviderModels(options);
  }

  /** See SessionHostLifecycle.invalidateReadCaches. */
  invalidateReadCaches(): void {
    this.lifecycle.invalidateReadCaches();
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

  private sessionCatalog(): DesktopSessionSummary[] {
    return this.sessionMetadata.withReadCursors(
      this.sessionMetadata.withFavoriteFlags(
        this.sessionMetadata.withRetiredFlags(
          this.sessionMetadata.withArchiveFlags(
            this.agentRooms.withRooms(
              desktopSessionSummaries(this.rawSessionRows, this.sessionMetadata.titles, this.sessionMetadata.names)
            )
          )
        )
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
        } catch {
          // Best-effort close: disposal continues regardless.
        }
        this.publication.clearProjections();
        this.visibleSessionIds.clear();
        this.visibleSessionSources.clear();
      }
    })();
    return this.disposePromise;
  }
}
