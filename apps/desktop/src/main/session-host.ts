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
  DesktopSessionFrameSource,
  DesktopSessionLaneEnd,
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
import { reconcileSessionProjection } from './state-delta';
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

// Cold-view (stored-projection) refresh cadence. Only sessions that publish no
// live frames are re-read, and the worker runtime persists its in-progress
// transcript on a 2s clock, so a 1s reader keeps a visible agent pane current
// without adding a faster poll than there is new content to read.
const COLD_VIEW_REFRESH_MS = 1_000;

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

function sameTranscriptItem(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (!left || !right || typeof left !== 'object' || typeof right !== 'object') return false;
  const a = left as Record<string, unknown>;
  const b = right as Record<string, unknown>;
  if (a.id != null && b.id != null) return String(a.id) === String(b.id);
  return String(a.kind || '') === String(b.kind || '')
    && String(a.text ?? '') === String(b.text ?? '');
}

/** Add a larger durable history head without replacing live work fields or
 * the identity-stable tail currently owned by the runtime. */
export function mergeSessionHistorySnapshot(
  sessionId: string,
  live: SessionSnapshot,
  stored: Record<string, unknown>,
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
  private readonly listeners = new Set<(snapshot: SessionSnapshot) => void>();
  private readonly sessionListeners = new Set<(sessions: DesktopSessionSummary[]) => void>();
  private readonly agentPoolListeners = new Set<(agents: DesktopAgentPoolRow[]) => void>();
  private readonly sessionStateListeners = new Set<(update: DesktopSessionStateUpdate) => void>();
  private readonly sessionProjections = new Map<string, SessionProjection>();
  private readonly recoveringSessionIds = new Set<string>();
  private readonly visibleSessionIds = new Set<string>();
  private readonly visibleSessionSources = new Map<string, Set<string>>();
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
  private storeWatcher: FSWatcher | null = null;
  private storeRefreshTimer: NodeJS.Timeout | null = null;
  private coldViewTimer: NodeJS.Timeout | null = null;
  private remoteSessionId = '';
  private disposed = false;

  private constructor(
    private readonly options: SerializableDesktopServiceOptions,
    private readonly runtime: SessionHostRuntime,
    sessionClient: SessionClient,
  ) {
    this.sessionClient = sessionClient;
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

  /** Live engine state for the shell-job poller: newest session frame first,
   *  with the blank shell snapshot as the only fallback. A frame that lost its
   *  pid field still polls under the last known owner. */
  private shellJobsEngineState(): Record<string, unknown> | null {
    const base = (this.engineSnapshot ?? this.shellSnapshot) as Record<string, unknown> | null;
    if (!base || typeof base !== 'object') return null;
    if (Number(base.ownerClientHostPid || base.clientHostPid) > 0) return base;
    return this.engineClientHostPid > 0
      ? { ...base, clientHostPid: this.engineClientHostPid }
      : base;
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
      const projection = this.sessionProjections.get(sessionId);
      if (projection) this.publishSession(sessionId, projection.snapshot);
    }
  }

  private publishSession(
    sessionId: string,
    snapshot: SessionSnapshot,
    frameSource: DesktopSessionFrameSource = 'live',
  ): void {
    const visibleSnapshot = this.snapshotWithRemoteSession(
      this.snapshotWithShellJobs(sessionId, snapshot),
    );
    for (const listener of [...this.sessionStateListeners]) {
      try {
        listener({ sessionId, snapshot: visibleSnapshot, frameSource });
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
      const rebuilt = full && typeof full === 'object'
        ? { ...(full as Record<string, unknown>), sessionId: id } as SessionSnapshot
        : null;
      // A stored read carries no baseline, so it always answers FULL — and a
      // visible cold view is re-read on a one second clock. Folding the fresh
      // parse onto the retained projection keeps the object identity that every
      // delta encoder downstream reads as "already sent".
      if (rebuilt) {
        snapshot = prior?.snapshot
          ? reconcileSessionProjection(prior.snapshot, rebuilt)
          : rebuilt;
      }
    } else if (value?.patch && typeof value.patch === 'object'
      && prior && Number(value.baseRevision) === prior.revision) {
      snapshot = statePatch(prior.snapshot, value.patch as Record<string, unknown>);
    }
    if (!snapshot) {
      // The service control session owns no pane and is never published, so an
      // empty projection cannot blank anything: it keeps the cheap fallback
      // rather than paying for a recovery read on every global capability.
      if (id === this.controlSessionId) {
        snapshot = { sessionId: id, items: [], queued: [] } as SessionSnapshot;
      } else {
        this.recoverMissingSessionBaseline(id);
        return { sessionId: id, items: [], queued: [] } as SessionSnapshot;
      }
    }
    const nextRevision = Number.isFinite(revision) ? revision : (prior?.revision ?? 0);
    // Publishing a projection that did not move repaints nothing and costs a
    // whole transcript on the relay leg: the reader already holds this frame.
    const unmoved = prior !== undefined
      && prior.snapshot === snapshot
      && prior.revision === nextRevision;
    this.sessionProjections.set(id, { revision: nextRevision, snapshot });
    this.trackShellJobsEngineState(snapshot);
    if (publish && !unmoved && id !== this.controlSessionId) this.publishSession(id, snapshot);
    return this.snapshotWithRemoteSession(snapshot);
  }

  /** A reply can outlive the baseline it was computed against: the projection
   *  is dropped when the daemon reclaims an unwatched session and when the
   *  daemon transport blips, so a reply that answers "unchanged since revision
   *  N" — or carries a patch against it — arrives with nothing to apply it to.
   *  Fabricating `{ items: [] }` for that case PUBLISHED AN EMPTY LIVE FRAME
   *  and blanked a pane that was on screen and working (user: 데스크탑 세션
   *  pane이 완전히 비어졌다 다시 나옴). Re-read instead: with no baseline to
   *  announce, the daemon must answer FULL, and nothing is published until that
   *  real content lands. The in-flight set keeps a read that itself finds no
   *  content from starting another one. */
  private recoverMissingSessionBaseline(sessionId: string): void {
    if (this.disposed || this.recoveringSessionIds.has(sessionId)) return;
    this.recoveringSessionIds.add(sessionId);
    console.error(`[mixdog-lane] missing baseline session=${sessionId} — re-reading`);
    void this.readSession(sessionId)
      .catch(() => undefined)
      .finally(() => { this.recoveringSessionIds.delete(sessionId); });
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
      // The daemon's idle sweep reclaims an unwatched session's MEMORY
      // (session-service: 'idle and unwatched') and reloads it on demand; the
      // transcript never left disk. Publishing that as an unqualified null
      // made the renderer drop its cached lane and repaint a live task as an
      // empty New Task (user: 진행중인 TASK창이 갑자기 NEWTASK처럼 아예
      // 비어버린다). Name the reason so only a real teardown clears a pane.
      const laneEnd: DesktopSessionLaneEnd = String(frame.reason || '') === 'idle and unwatched'
        ? 'unloaded'
        : 'gone';
      for (const listener of [...this.sessionStateListeners]) {
        try { listener({ sessionId, snapshot: null, frameSource: 'live', laneEnd }); } catch {}
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
        // Recovery re-attaches to the daemon and resyncs. Until it lands, a
        // pane keeps showing what it already has instead of blanking.
        try {
          listener({ sessionId, snapshot: null, frameSource: 'live', laneEnd: 'disconnected' });
        } catch {}
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
    for (const sessions of this.visibleSessionSources.values()) sessions.delete(id);
    this.sessionProjections.delete(id);
    await this.sessionMetadata.forget(id);
    await this.publishCatalogs();
    return null;
  }

  async prefetchSession(
    sessionId: string,
    transcriptItemLimit = DESKTOP_TRANSCRIPT_ITEM_LIMIT,
  ): Promise<boolean> {
    const id = sessionIdOf(sessionId);
    const limit = Math.max(
      1,
      Math.min(8_192, Math.floor(Number(transcriptItemLimit) || DESKTOP_TRANSCRIPT_ITEM_LIMIT)),
    );
    if (limit <= DESKTOP_TRANSCRIPT_ITEM_LIMIT) {
      await this.readSession(id);
      return true;
    }
    const store = await this.runtime.loadSessionStore();
    const stored = await store.readStoredSessionTranscript?.(id, {
      transcriptItemLimit: limit,
    });
    if (!stored || typeof stored !== 'object') return false;
    const live = this.sessionProjections.get(id)?.snapshot ?? null;
    this.publishSession(id, mergeSessionHistorySnapshot(id, live, stored), 'replay');
    return true;
  }

  async setVisibleSessions(sessionIds: string[]): Promise<boolean> {
    return this.setVisibleSessionsForSource('desktop', sessionIds);
  }

  async setVisibleSessionsForSource(sourceId: string, sessionIds: string[]): Promise<boolean> {
    const source = String(sourceId || '').trim();
    if (!source) throw new TypeError('sourceId is required.');
    const requested = [...new Set(sessionIds.map(sessionIdOf))];
    const priorSourceSessions = this.visibleSessionSources.get(source);
    // Subscribe is already an exact, single-record authorization boundary in
    // the daemon. Do not scan the complete catalog merely to validate the few
    // session ids represented by visible panes.
    const accepted = await Promise.all(requested.map(async (sessionId) => {
      if (this.visibleSessionIds.has(sessionId)) {
        // A projection can already be resident for the desktop or another
        // phone. A NEW source still needs one full replay: subscribing again
        // would duplicate the daemon read, while returning silently leaves the
        // new phone blank until the next live token arrives.
        if (!priorSourceSessions?.has(sessionId)) {
          const projection = this.sessionProjections.get(sessionId);
          if (projection) this.publishSession(sessionId, projection.snapshot, 'replay');
          else await this.readSession(sessionId);
        }
        return sessionId;
      }
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
    const sourceSessions = new Set(accepted.filter((id): id is string => Boolean(id)));
    if (sourceSessions.size > 0) this.visibleSessionSources.set(source, sourceSessions);
    else this.visibleSessionSources.delete(source);
    const next = new Set<string>();
    for (const sessions of this.visibleSessionSources.values()) {
      for (const sessionId of sessions) next.add(sessionId);
    }
    const removed = [...this.visibleSessionIds].filter((id) => !next.has(id));
    this.visibleSessionIds.clear();
    for (const id of next) this.visibleSessionIds.add(id);
    await Promise.allSettled(removed.map((sessionId) =>
      this.sessionClient.unsubscribe({ sessionId }, this.callOptions())));
    this.ensureColdViewRefresh();
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
      const goalCommand = String(options.goalCommand || '').trim();
      if (goalCommand) {
        const goalResult = await this.invokeSession(sessionId, 'goalControl', [{
          command: goalCommand,
        }]);
        const goalValue = goalResult.value && typeof goalResult.value === 'object'
          ? goalResult.value as Record<string, unknown>
          : null;
        const goal = goalValue?.goal && typeof goalValue.goal === 'object'
          ? goalValue.goal as Record<string, unknown>
          : null;
        if (goalValue?.ok !== true || !goal) {
          throw new Error(String(goalValue?.message || 'Goal could not be created.'));
        }
        const objective = String(goal?.objective || goalCommand).trim();
        await this.sessionMetadata.load();
        this.sessionMetadata.rememberGeneratedTitle(sessionId, objective);
        this.pendingCatalogSessionIds.delete(sessionId);
        void this.publishCatalogs();
        return { accepted: true, sessionId, snapshot: goalResult.snapshot };
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

  /**
   * /inherit — carry an existing conversation into a NEW session id running on
   * the currently selected model. The source session file is untouched, so the
   * two transcripts share a prefix and then diverge.
   */
  async inheritSession(
    sourceSessionId: string,
    route?: DesktopModelSelection | null,
  ): Promise<{ sessionId: string; snapshot: SessionSnapshot | null }> {
    const source = sessionIdOf(sourceSessionId);
    const rows = await this.listSessions();
    const projectPath = String(
      rows.find((entry) => entry.id === source)?.projectPath || '',
    ).trim();
    const registeredProject = projectPath
      ? await this.projects.knownPath(projectPath)
      : '';
    const cwd = registeredProject
      ? await this.canonicalDirectory(registeredProject)
      : await this.taskWorkspace();
    const desktopSession = registeredProject
      ? { classification: 'project' as const, projectPath: cwd }
      : { classification: 'task' as const, projectPath: null };
    const created = await this.sessionClient.create(
      {
        cwd,
        desktopSession,
        ...(route?.provider ? { provider: route.provider } : {}),
        ...(route?.model ? { model: route.model } : {}),
      },
      this.callOptions(`session-create:${process.pid}:${randomUUID()}`),
    );
    const sessionId = sessionIdOf(created.sessionId);
    this.pendingCatalogSessionIds.add(sessionId);
    this.applySessionResult(sessionId, created);
    try {
      // The heir opens on the route the user is looking at; without this it
      // would inherit the daemon's current default instead.
      if (route) {
        await this.invokeSession(sessionId, 'setRoute', [{
          ...route,
          applyToCurrentSession: true,
        }]);
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
      } catch { /* the create is being abandoned either way */ }
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

  /** Cold-view refresh.
   *
   *  A session served from its STORED projection carries revision 0 and
   *  receives no live frames, because only a materialized daemon entry
   *  publishes those. An agent worker session never materializes one: it runs
   *  inside its Lead's runtime, so a pane opened on a working agent would sit
   *  forever on whatever snapshot it happened to load first (user report:
   *  위임한 세션이 pane에서 안 도는 것처럼 보인다).
   *
   *  Re-reading the visible cold views turns that pane into a live one. A
   *  session that later materializes starts publishing live frames, its
   *  revision leaves 0, and it drops out of this set on its own. */
  private ensureColdViewRefresh(): void {
    if (this.coldViewTimer || this.disposed) return;
    this.coldViewTimer = setInterval(() => {
      void this.refreshColdViews();
    }, COLD_VIEW_REFRESH_MS);
    this.coldViewTimer.unref?.();
  }

  private async refreshColdViews(): Promise<void> {
    if (this.disposed) return;
    const cold = [...this.visibleSessionIds]
      .filter((sessionId) => this.sessionProjections.get(sessionId)?.revision === 0);
    if (cold.length === 0) {
      if (this.coldViewTimer) clearInterval(this.coldViewTimer);
      this.coldViewTimer = null;
      return;
    }
    await Promise.allSettled(cold.map((sessionId) => this.readSession(sessionId)));
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
    if (this.coldViewTimer) clearInterval(this.coldViewTimer);
    this.coldViewTimer = null;
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
    this.visibleSessionSources.clear();
  }
}
