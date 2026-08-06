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
  EngineSnapshot,
  ToolApprovalDecision,
} from '../shared/contract';
import {
  normalizeSessionTitle,
  promptTitle,
} from '../shared/session-title.mjs';
import { desktopSessionSummaries } from './desktop-state';
import type { DesktopEngineHost, SerializableEngineHostOptions } from './engine-host-api';
import {
  DESKTOP_TRANSCRIPT_ITEM_LIMIT,
  copyCapabilityValue,
  normalizedProviderModels,
  type MixdogProjectsModule,
  type MixdogSessionStoreModule,
} from './engine-host-support';
import { DesktopProjectRegistry } from './engine-projects';
import { DesktopSessionMetadata } from './engine-session-metadata';
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

export interface BackendSessionClient {
  call(
    name: string,
    args?: Record<string, unknown>,
    options?: { callId?: string },
  ): Promise<Record<string, unknown>>;
  close(reason?: string): Promise<void>;
}

export interface BackendHostRuntime {
  attachSessionClient(options: {
    onFrame(frame: Record<string, unknown>): void;
    onFatal?(reason: string): void;
  }): Promise<BackendSessionClient>;
  loadProjects(): Promise<MixdogProjectsModule>;
  loadSessionStore(): Promise<MixdogSessionStoreModule>;
  executeCodeGraphTool(
    name: string,
    args: Record<string, unknown>,
    cwd: string,
  ): Promise<unknown>;
}

type SessionProjection = {
  revision: number;
  snapshot: EngineSnapshot;
};

function statePatch(
  snapshot: EngineSnapshot,
  patch: Record<string, unknown>,
): EngineSnapshot {
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
  return next as EngineSnapshot;
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
 * Backend-native host used by every visual client.
 *
 * It owns no current engine and never parks, swaps, or disposes an execution
 * runtime. The singleton daemon owns session entries; this class only issues
 * session-addressed commands, projects their event stream, and exposes the
 * daemon's non-session project/catalog services to transports.
 */
export class BackendHost implements DesktopEngineHost {
  private readonly listeners = new Set<(snapshot: EngineSnapshot) => void>();
  private readonly sessionListeners = new Set<(sessions: DesktopSessionSummary[]) => void>();
  private readonly agentPoolListeners = new Set<(agents: DesktopAgentPoolRow[]) => void>();
  private readonly sessionStateListeners = new Set<(update: DesktopSessionStateUpdate) => void>();
  private readonly sessionProjections = new Map<string, SessionProjection>();
  private readonly visibleSessionIds = new Set<string>();
  private readonly projects: DesktopProjectRegistry;
  private readonly sessionMetadata: DesktopSessionMetadata;
  private readonly sessionClient: BackendSessionClient;
  private readonly taskWorkspacePath: string;
  private activeSessionId = '';
  private activeSnapshot: EngineSnapshot = null;
  private controlSessionId = '';
  private rawSessionRows: Array<Record<string, unknown>> = [];
  private storeWatcher: FSWatcher | null = null;
  private storeRefreshTimer: NodeJS.Timeout | null = null;
  private disposed = false;

  private constructor(
    private readonly options: SerializableEngineHostOptions,
    private readonly runtime: BackendHostRuntime,
    sessionClient: BackendSessionClient,
  ) {
    this.sessionClient = sessionClient;
    this.taskWorkspacePath = join(options.userDataPath, 'workspace', 'unclassified');
    this.projects = new DesktopProjectRegistry({
      loadProjectsModule: runtime.loadProjects,
      userDataRoot: () => options.userDataPath,
    });
    this.sessionMetadata = new DesktopSessionMetadata(() => options.userDataPath);
  }

  static async create(
    options: SerializableEngineHostOptions,
    runtime: BackendHostRuntime,
  ): Promise<BackendHost> {
    let host: BackendHost | null = null;
    const sessionClient = await runtime.attachSessionClient({
      onFrame(frame) {
        host?.handleSessionFrame(frame);
      },
      onFatal() {
        host?.handleSessionTransportLoss();
      },
    });
    host = new BackendHost(options, runtime, sessionClient);
    return host;
  }

  getSnapshot(): EngineSnapshot {
    return this.activeSnapshot;
  }

  subscribe(listener: (snapshot: EngineSnapshot) => void): () => void {
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

  private publishActive(snapshot: EngineSnapshot): void {
    this.activeSnapshot = snapshot;
    for (const listener of [...this.listeners]) {
      try { listener(snapshot); } catch { /* a presentation listener owns its failure */ }
    }
  }

  private publishSession(sessionId: string, snapshot: EngineSnapshot): void {
    for (const listener of [...this.sessionStateListeners]) {
      try {
        listener({ sessionId, snapshot, frameSource: 'live' });
      } catch {
        // A visual client cannot affect backend execution.
      }
    }
    if (this.activeSessionId === sessionId) this.publishActive(snapshot);
  }

  private applySessionResult(
    sessionId: string,
    value: Record<string, unknown> | null | undefined,
    publish = true,
  ): EngineSnapshot {
    const id = sessionIdOf(value?.sessionId || sessionId);
    const prior = this.sessionProjections.get(id);
    const revision = Number(value?.revision);
    let snapshot = prior?.snapshot ?? null;
    if (value && Object.prototype.hasOwnProperty.call(value, 'full')) {
      const full = value.full;
      snapshot = full && typeof full === 'object'
        ? { ...(full as Record<string, unknown>), sessionId: id } as EngineSnapshot
        : { sessionId: id, items: [], queued: [] } as EngineSnapshot;
    } else if (value?.patch && typeof value.patch === 'object'
      && prior && Number(value.baseRevision) === prior.revision) {
      snapshot = statePatch(prior.snapshot, value.patch as Record<string, unknown>);
    }
    if (!snapshot) snapshot = { sessionId: id, items: [], queued: [] } as EngineSnapshot;
    const nextRevision = Number.isFinite(revision) ? revision : (prior?.revision ?? 0);
    this.sessionProjections.set(id, { revision: nextRevision, snapshot });
    if (publish && id !== this.controlSessionId) this.publishSession(id, snapshot);
    return snapshot;
  }

  private handleSessionFrame(frame: Record<string, unknown>): void {
    if (this.disposed) return;
    const sessionId = String(frame.sessionId || '');
    if (!sessionId || sessionId === this.controlSessionId) return;
    if (frame.type === 'session-gone') {
      this.sessionProjections.delete(sessionId);
      for (const listener of [...this.sessionStateListeners]) {
        try { listener({ sessionId, snapshot: null }); } catch {}
      }
      if (this.activeSessionId === sessionId) {
        this.activeSessionId = '';
        this.publishActive(null);
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
    this.sessionProjections.clear();
    for (const sessionId of this.visibleSessionIds) {
      for (const listener of [...this.sessionStateListeners]) {
        try { listener({ sessionId, snapshot: null }); } catch {}
      }
    }
  }

  private call(
    name: string,
    args: Record<string, unknown>,
    callId: string = randomUUID(),
  ): Promise<Record<string, unknown>> {
    if (this.disposed) return Promise.reject(new Error('Mixdog backend host is disposed.'));
    return this.sessionClient.call(name, args, { callId });
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

  private async readSession(sessionId: string): Promise<EngineSnapshot> {
    const id = sessionIdOf(sessionId);
    const prior = this.sessionProjections.get(id);
    const result = await this.call('session.read', {
      sessionId: id,
      open: this.openHints(id),
      baseRevision: prior?.revision ?? null,
    });
    return this.applySessionResult(id, result);
  }

  private async invokeSession(
    sessionId: string,
    method: string,
    args: unknown[] = [],
  ): Promise<{ value: unknown; snapshot: EngineSnapshot; result: Record<string, unknown> }> {
    const id = sessionIdOf(sessionId);
    const prior = this.sessionProjections.get(id);
    const result = await this.call('session.invoke', {
      sessionId: id,
      method,
      args,
      open: this.openHints(id),
      baseRevision: prior?.revision ?? null,
    });
    return {
      value: result.value,
      snapshot: this.applySessionResult(id, result),
      result,
    };
  }

  private async ensureControlSession(): Promise<string> {
    if (this.controlSessionId) return this.controlSessionId;
    const result = await this.call('session.create', {
      cwd: await this.taskWorkspace(),
      desktopSession: null,
    }, `backend-control-create:${process.pid}:${randomUUID()}`);
    const sessionId = sessionIdOf(result.sessionId);
    this.controlSessionId = sessionId;
    this.applySessionResult(sessionId, result, false);
    return sessionId;
  }

  private async invokeControl(method: string, args: unknown[] = []): Promise<unknown> {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const sessionId = await this.ensureControlSession();
      try {
        const result = await this.call('session.invoke', {
          sessionId,
          method,
          args,
          open: { cwd: await this.taskWorkspace(), desktopSession: null },
          baseRevision: this.sessionProjections.get(sessionId)?.revision ?? null,
        });
        this.applySessionResult(sessionId, result, false);
        return result.value;
      } catch (error) {
        if (attempt > 0) throw error;
        this.sessionProjections.delete(sessionId);
        this.controlSessionId = '';
      }
    }
    throw new Error('Backend control session is unavailable.');
  }

  private blankSnapshot(
    cwd: string,
    projectPath: string | null,
  ): EngineSnapshot {
    return {
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
    } as EngineSnapshot;
  }

  async startProject(projectPath: string): Promise<EngineSnapshot> {
    const canonical = await this.canonicalDirectory(projectPath);
    await this.projects.enter(canonical);
    this.activeSessionId = '';
    const snapshot = this.blankSnapshot(canonical, canonical);
    this.publishActive(snapshot);
    return snapshot;
  }

  async startProjectTask(projectPath: string): Promise<EngineSnapshot> {
    const registered = await this.projects.knownPath(projectPath);
    const canonical = await this.canonicalDirectory(registered);
    await this.projects.touchSelected(registered);
    this.activeSessionId = '';
    const snapshot = this.blankSnapshot(canonical, canonical);
    this.publishActive(snapshot);
    return snapshot;
  }

  async startTask(): Promise<EngineSnapshot> {
    this.activeSessionId = '';
    const snapshot = this.blankSnapshot(await this.taskWorkspace(), null);
    this.publishActive(snapshot);
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
    await this.sessionMetadata.load();
    const store = await this.runtime.loadSessionStore();
    this.rawSessionRows = store.listStoredSessionSummaries({
      rebuildIfMissing: false,
    });
    const summaries = desktopSessionSummaries(
      this.rawSessionRows,
      this.activeSessionId,
      this.sessionMetadata.titles,
      this.sessionMetadata.names,
    );
    this.ensureStoreWatcher();
    return this.sessionMetadata.withArchiveFlags(summaries);
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
    if (!(await this.listSessions()).some((row) => row.id === id)) {
      throw new Error('Session is not available.');
    }
    await this.invokeControl('renameSessionTitle', [id, normalized]);
    await this.sessionMetadata.setName(id, normalized);
    await this.publishCatalogs();
  }

  async setSessionArchived(sessionId: string, archived: boolean): Promise<void> {
    const id = sessionIdOf(sessionId);
    await this.sessionMetadata.load();
    if (await this.sessionMetadata.setArchived(id, archived)) await this.publishCatalogs();
  }

  async deleteSession(sessionId: string): Promise<EngineSnapshot> {
    const id = sessionIdOf(sessionId);
    if (!(await this.listSessions()).some((row) => row.id === id)) {
      throw new Error('Session is not available.');
    }
    if (await this.invokeControl('deleteSession', [id]) !== true) {
      throw new Error('Session could not be deleted.');
    }
    try { await this.call('session.unsubscribe', { sessionId: id }); } catch {}
    this.visibleSessionIds.delete(id);
    this.sessionProjections.delete(id);
    await this.sessionMetadata.forget(id);
    if (this.activeSessionId === id) {
      this.activeSessionId = '';
      this.publishActive(null);
    }
    await this.publishCatalogs();
    return null;
  }

  async prefetchSession(sessionId: string): Promise<boolean> {
    await this.readSession(sessionId);
    return true;
  }

  async peekSession(sessionId: string): Promise<boolean> {
    await this.readSession(sessionId);
    return true;
  }

  async setVisibleSessions(sessionIds: string[]): Promise<boolean> {
    const next = new Set(sessionIds.map(sessionIdOf));
    const added = [...next].filter((id) => !this.visibleSessionIds.has(id));
    const removed = [...this.visibleSessionIds].filter((id) => !next.has(id));
    this.visibleSessionIds.clear();
    for (const id of next) this.visibleSessionIds.add(id);
    await Promise.all(added.map(async (sessionId) => {
      const prior = this.sessionProjections.get(sessionId);
      const result = await this.call('session.subscribe', {
        sessionId,
        open: this.openHints(sessionId),
        baseRevision: prior?.revision ?? null,
      });
      this.applySessionResult(sessionId, result);
    }));
    await Promise.allSettled(removed.map((sessionId) =>
      this.call('session.unsubscribe', { sessionId })));
    return true;
  }

  async resumeSession(sessionId: string): Promise<EngineSnapshot> {
    const id = sessionIdOf(sessionId);
    const prior = this.sessionProjections.get(id);
    const result = await this.call('session.subscribe', {
      sessionId: id,
      open: this.openHints(id),
      baseRevision: prior?.revision ?? null,
    });
    this.activeSessionId = id;
    const snapshot = this.applySessionResult(id, result);
    this.publishActive(snapshot);
    return snapshot;
  }

  async searchProjectFiles(
    projectIdOrWorkspaceId: string,
    query: string,
    limit = 50,
  ): Promise<string[]> {
    const root = await this.projectDirectory(projectIdOrWorkspaceId);
    return searchProjectDirectory(root, query, limit);
  }

  async submit(
    prompt: DesktopPromptContent,
    options: DesktopSubmitOptions = {},
  ): Promise<boolean> {
    if (!this.activeSessionId) {
      throw new Error('sessionId is required for submission.');
    }
    return this.submitToSession(this.activeSessionId, prompt, options);
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
    const created = await this.call('session.create', { cwd, desktopSession },
      `session-create:${process.pid}:${randomUUID()}`);
    const sessionId = sessionIdOf(created.sessionId);
    this.applySessionResult(sessionId, created);
    try {
      if (draft.workflowId) {
        await this.invokeSession(sessionId, 'setWorkflow', [draft.workflowId]);
      }
      if (draft.route) {
        await this.invokeSession(sessionId, 'setRoute', [{
          provider: draft.route.provider,
          model: draft.route.model,
          ...(draft.route.effort ? { effort: draft.route.effort } : {}),
          applyToCurrentSession: true,
        }]);
        if (typeof draft.route.fast === 'boolean') {
          await this.invokeSession(sessionId, 'setFast', [draft.route.fast]);
        }
      }
      const submissionId = String(options.id || '').trim()
        || `desktop-submit-${sessionId}-${Date.now()}`;
      const prior = this.sessionProjections.get(sessionId);
      const result = await this.call('session.submit', {
        sessionId,
        prompt,
        options: { ...options, id: submissionId },
        open: { cwd, desktopSession },
        baseRevision: prior?.revision ?? null,
      }, `session-submit:${sessionId}:${submissionId}`);
      if (String(result.sessionId || '') !== sessionId) {
        throw new Error('New task backend returned a mismatched session id.');
      }
      const accepted = result.accepted === true;
      const snapshot = this.applySessionResult(sessionId, result);
      if (String(snapshot?.sessionId || '') !== sessionId) {
        throw new Error('New task backend returned a mismatched session snapshot.');
      }
      if (!accepted) {
        await this.call('session.unsubscribe', { sessionId }).catch(() => ({}));
        return { accepted: false, sessionId: '', snapshot: null };
      }
      this.activeSessionId = sessionId;
      this.publishActive(snapshot);
      if (registeredProject) await this.projects.touchSelected(registeredProject);
      await this.sessionMetadata.load();
      this.sessionMetadata.rememberGeneratedTitle(
        sessionId,
        promptTitle(prompt, options.displayText || ''),
      );
      if (draft.remote === true) {
        void this.invokeSession(sessionId, 'claimRemote').catch(() => undefined);
      }
      void this.publishCatalogs();
      return { accepted: true, sessionId, snapshot };
    } catch (error) {
      try { await this.call('session.unsubscribe', { sessionId }); } catch {}
      throw error;
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
    const result = await this.call('session.submit', {
      sessionId: id,
      prompt,
      options: { ...options, id: submissionId },
      open: this.openHints(id),
      baseRevision: prior?.revision ?? null,
    }, `session-submit:${id}:${submissionId}`);
    this.applySessionResult(id, result);
    return result.accepted === true;
  }

  async abort(options: DesktopAbortOptions = {}): Promise<unknown> {
    if (!this.activeSessionId) return { aborted: false };
    return this.abortSession(this.activeSessionId, options);
  }

  async abortSession(sessionId: string, options: DesktopAbortOptions = {}): Promise<unknown> {
    const id = sessionIdOf(sessionId);
    const result = await this.call('session.abort', {
      sessionId: id,
      options,
      open: this.openHints(id),
      baseRevision: this.sessionProjections.get(id)?.revision ?? null,
    });
    this.applySessionResult(id, result);
    return { aborted: result.aborted === true };
  }

  async resolveToolApproval(
    id: string,
    decision: ToolApprovalDecision,
  ): Promise<boolean> {
    if (!this.activeSessionId) return false;
    return this.resolveToolApprovalForSession(this.activeSessionId, id, decision);
  }

  async resolveToolApprovalForSession(
    sessionId: string,
    id: string,
    decision: ToolApprovalDecision,
  ): Promise<boolean> {
    const target = sessionIdOf(sessionId);
    const result = await this.call('session.approve', {
      sessionId: target,
      approvalId: id,
      decision,
      open: this.openHints(target),
      baseRevision: this.sessionProjections.get(target)?.revision ?? null,
    });
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
  ): Promise<EngineSnapshot> {
    const target = sessionId || this.activeSessionId;
    if (!target) throw new Error('sessionId is required for a model route.');
    const { snapshot } = await this.invokeSession(target, 'setRoute', [{
      ...selection,
      applyToCurrentSession: true,
    }]);
    return snapshot;
  }

  async setFast(enabled: boolean, sessionId?: string): Promise<EngineSnapshot> {
    const target = sessionId || this.activeSessionId;
    if (!target) throw new Error('sessionId is required for Fast mode.');
    return (await this.invokeSession(target, 'setFast', [enabled])).snapshot;
  }

  async invokeCapability<T = unknown>(
    capability: DesktopCapability,
    args: unknown[] = [],
    sessionId?: string,
  ): Promise<DesktopCapabilityResult<T>> {
    const target = sessionId || this.activeSessionId || await this.ensureControlSession();
    const result = await this.invokeSession(target, capability, args);
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

  async backendInvoke(): Promise<unknown> {
    throw new Error('backendInvoke is supplied by the backend operation adapter.');
  }

  subscribeBackendEvents(): () => void {
    return () => {};
  }

  perfLog(line: string): void {
    if (process.env.MIXDOG_DESKTOP_PERF === '1') {
      console.error(`[mixdog-backend] ${line}`);
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

  private async publishCatalogs(): Promise<void> {
    if (this.disposed) return;
    const [sessions, agents] = await Promise.all([
      this.listSessions().catch(() => []),
      this.listAgentPool().catch(() => []),
    ]);
    for (const listener of [...this.sessionListeners]) {
      try { listener(sessions); } catch {}
    }
    for (const listener of [...this.agentPoolListeners]) {
      try { listener(agents); } catch {}
    }
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    if (this.storeRefreshTimer) clearTimeout(this.storeRefreshTimer);
    this.storeRefreshTimer = null;
    try { this.storeWatcher?.close(); } catch {}
    this.storeWatcher = null;
    await this.sessionMetadata.flush();
    try { await this.sessionClient.close('backend host disposed'); } catch {}
    this.listeners.clear();
    this.sessionListeners.clear();
    this.agentPoolListeners.clear();
    this.sessionStateListeners.clear();
    this.sessionProjections.clear();
    this.visibleSessionIds.clear();
  }
}

