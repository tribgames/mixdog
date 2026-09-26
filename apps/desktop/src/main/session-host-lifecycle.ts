import { randomUUID } from 'node:crypto';

import type {
  DesktopAbortOptions,
  DesktopCapability,
  DesktopCapabilityReadRequest,
  DesktopCapabilityReadResult,
  DesktopCapabilityResult,
  DesktopModelCatalogOptions,
  DesktopModelOption,
  DesktopModelSelection,
  DesktopNewTaskDraft,
  DesktopNewTaskSubmitResult,
  DesktopPromptContent,
  DesktopSessionFrameSource,
  DesktopSessionStateUpdate,
  DesktopSessionSummary,
  DesktopSubmitOptions,
  SessionSnapshot,
  ToolApprovalDecision,
} from '../shared/contract';
import { reportTranscriptRead, transcriptReadTraceId } from '../shared/transcript-read-diagnostics';
import { normalizeSessionTitle, promptTitle } from '../shared/session-title.mjs';
import { TRANSCRIPT_READ_TIMEOUT_MS } from '../shared/transcript-read-policy';
import { copyCapabilityValue, normalizedProviderModels } from './desktop-support';
import type { DesktopSessionMetadata } from './desktop-session-metadata';
import type { NewTaskRequest, NewTaskRequests } from './new-task-requests';
import { searchProjectDirectory } from './project-file-search';
import type { SessionHostPublication } from './session-host-publication';
import { sessionIdOf, type SessionClient, type SessionCallOptions } from './session-host-transport';
import type { SessionTranscriptWindows } from './session-transcript-windows';
import type { SessionViewRegistry } from './session-view-registry';

export type SessionWorkspaceResolution = {
  registeredProject: string;
  cwd: string;
  desktopSession: { classification: 'project'; projectPath: string } | { classification: 'task'; projectPath: null };
};

export interface SessionHostLifecycleOwner {
  readonly client: SessionClient;
  readonly publication: SessionHostPublication;
  readonly sessionViews: SessionViewRegistry;
  readonly visibleSessionIds: Set<string>;
  readonly visibleSessionSources: Map<string, Set<string>>;
  readonly newTaskRequests: NewTaskRequests;
  readonly pendingCatalogSessionIds: Set<string>;
  readonly sessionMetadata: DesktopSessionMetadata;
  readonly transcriptWindows: SessionTranscriptWindows;
  isDisposed(): boolean;
  callOptions(callId?: string, timeoutMs?: number): SessionCallOptions;
  taskWorkspace(): Promise<string>;
  canonicalDirectory(path: string): Promise<string>;
  enterProject(path: string): Promise<void>;
  knownProject(path: string): Promise<string>;
  touchProject(path: string): Promise<void>;
  resolveSessionWorkspace(projectPath?: string | null): Promise<SessionWorkspaceResolution>;
  projectDirectory(projectPath: string): Promise<string>;
  openHints(sessionId: string): Record<string, unknown>;
  readSession(
    sessionId: string,
    forceFull?: boolean,
    publish?: boolean,
    readTraceId?: string,
    page?: boolean
  ): Promise<SessionSnapshot>;
  invokeSession(
    sessionId: string,
    method: string,
    args?: unknown[]
  ): Promise<{ value: unknown; snapshot: SessionSnapshot; result: Record<string, unknown> }>;
  ensureControlSession(): Promise<string>;
  invokeControlResult(
    method: string,
    args?: unknown[]
  ): Promise<{ value: unknown; snapshot: SessionSnapshot; result: Record<string, unknown> }>;
  invokeControl(method: string, args?: unknown[]): Promise<unknown>;
  applySessionResult(
    sessionId: string,
    value: Record<string, unknown> | null | undefined,
    publish?: boolean
  ): SessionSnapshot;
  publishSession(
    sessionId: string,
    snapshot: SessionSnapshot,
    frameSource?: DesktopSessionFrameSource,
    readTraceId?: string
  ): void;
  snapshotWithRemoteSession(snapshot: SessionSnapshot): SessionSnapshot;
  snapshotWithShellJobs(sessionId: string, snapshot: SessionSnapshot): SessionSnapshot;
  publishShell(snapshot: SessionSnapshot): void;
  ensureColdViewRefresh(): void;
  listSessions(): Promise<DesktopSessionSummary[]>;
  sessionCatalogLoaded(): boolean;
  sessionCatalog(): DesktopSessionSummary[];
  publishSessionCatalog(sessions: DesktopSessionSummary[]): void;
  publishCatalogs(): Promise<void>;
}

export class SessionHostLifecycle {
  constructor(private readonly owner: SessionHostLifecycleOwner) {}

  private blankSnapshot(cwd: string, projectPath: string | null): SessionSnapshot {
    return this.owner.snapshotWithRemoteSession({
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
    const canonical = await this.owner.canonicalDirectory(projectPath);
    await this.owner.enterProject(canonical);
    const snapshot = this.blankSnapshot(canonical, canonical);
    this.owner.publishShell(snapshot);
    return snapshot;
  }

  async startProjectTask(projectPath: string): Promise<SessionSnapshot> {
    const registered = await this.owner.knownProject(projectPath);
    const canonical = await this.owner.canonicalDirectory(registered);
    await this.owner.touchProject(registered);
    const snapshot = this.blankSnapshot(canonical, canonical);
    this.owner.publishShell(snapshot);
    return snapshot;
  }

  async startTask(): Promise<SessionSnapshot> {
    const snapshot = this.blankSnapshot(await this.owner.taskWorkspace(), null);
    this.owner.publishShell(snapshot);
    return snapshot;
  }

  async markSessionRead(sessionId: string, messageCount: number, consumedUnread = false): Promise<boolean> {
    const id = sessionIdOf(sessionId);
    const changed = await this.owner.sessionMetadata.markRead(id, messageCount, consumedUnread);
    if (!changed) return false;
    await this.republishSessionCatalog();
    return true;
  }

  /** Re-project the resident rows when the catalog is loaded; otherwise read
   *  both catalogs. */
  private async republishSessionCatalog(): Promise<void> {
    if (this.owner.sessionCatalogLoaded()) this.owner.publishSessionCatalog(this.owner.sessionCatalog());
    else await this.owner.publishCatalogs();
  }

  async renameSession(sessionId: string, title: string): Promise<void> {
    const id = sessionIdOf(sessionId);
    const normalized = normalizeSessionTitle(title, '');
    if (!normalized) throw new TypeError('Session title is invalid.');
    if ((await this.owner.invokeControl('renameSessionTitle', [id, normalized])) !== true) {
      throw new Error('Session is not available.');
    }
    await this.owner.sessionMetadata.setName(id, normalized);
    await this.owner.publishCatalogs();
  }

  async setSessionArchived(sessionId: string, archived: boolean): Promise<void> {
    const id = sessionIdOf(sessionId);
    await this.owner.sessionMetadata.load();
    if (!(await this.owner.sessionMetadata.setArchived(id, archived))) return;
    // Archive metadata does not alter daemon sessions or the process-global
    // agent pool. Re-project the resident rows instead of paying for both
    // catalogs and a full session-store identity/stat scan before replying.
    await this.republishSessionCatalog();
  }

  async deleteSession(sessionId: string): Promise<SessionSnapshot> {
    const id = sessionIdOf(sessionId);
    if (!(await this.owner.listSessions()).some((row) => row.id === id)) {
      throw new Error('Session is not available.');
    }
    if ((await this.owner.invokeControl('deleteSession', [id])) !== true) {
      throw new Error('Session could not be deleted.');
    }
    try {
      await this.owner.client.unsubscribe({ sessionId: id }, this.owner.callOptions());
    } catch {}
    this.owner.visibleSessionIds.delete(id);
    for (const sessions of this.owner.visibleSessionSources.values()) sessions.delete(id);
    this.owner.publication.projections.delete(id);
    await this.owner.sessionMetadata.forget(id);
    await this.owner.publishCatalogs();
    return null;
  }

  /** Read a session's transcript window; a `transcriptItemLimit` beyond the
   *  current window grows it with older history, served by the daemon for
   *  live and stored sessions alike (one baseline, so live patches keep
   *  applying). Without a limit the current window is re-read. */
  async prefetchSession(sessionId: string, transcriptItemLimit?: number, readTraceId?: string): Promise<boolean> {
    const id = sessionIdOf(sessionId);
    const traceId = transcriptReadTraceId(readTraceId);
    const startedAt = performance.now();
    reportTranscriptRead(id, traceId, 'host-start');
    let grown = false;
    if (typeof transcriptItemLimit === 'number') {
      // The page's byte budget bounds only the rows above what this host holds.
      const held = this.owner.publication.projections.get(id)?.snapshot?.items?.length ?? 0;
      grown = this.owner.transcriptWindows.grow(
        id,
        Math.max(1, Math.min(8_192, Math.floor(Number(transcriptItemLimit)))),
        held
      );
    }
    try {
      // A grown window is a page: the daemon may send only the revealed rows.
      const snapshot = await this.owner.readSession(id, false, false, traceId, grown);
      reportTranscriptRead(id, traceId, 'host-projected', {
        elapsedMs: performance.now() - startedAt,
        itemCount: Array.isArray(snapshot?.items) ? snapshot.items.length : 0,
      });
      this.owner.publishSession(id, snapshot, 'replay', traceId);
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
    const release = this.owner.publication.retainProjections(ids);
    try {
      await Promise.all(
        ids.map(async (id) => {
          try {
            await this.owner.readSession(id, false, false);
          } catch (error) {
            if (!(error instanceof Error) || !error.message.includes(`session ${id} is not available`)) throw error;
            gone.add(id);
            this.owner.publication.projections.delete(id);
          }
        })
      );
      if (this.owner.isDisposed()) throw new Error('Mixdog service host is disposed.');
      // Capture and deliver in one synchronous turn. A live update that arrived
      // during a read is already in this map and must outrank the earlier reply.
      deliver(
        ids.map((sessionId) => ({
          sessionId,
          snapshot: gone.has(sessionId)
            ? null
            : this.owner.snapshotWithRemoteSession(
                this.owner.snapshotWithShellJobs(
                  sessionId,
                  this.owner.publication.projections.get(sessionId)?.snapshot ?? null
                )
              ),
          frameSource: 'replay' as const,
          ...(gone.has(sessionId) ? { laneEnd: 'gone' as const } : {}),
        }))
      );
    } finally {
      release();
    }
  }

  async setVisibleSessions(sessionIds: string[]): Promise<boolean> {
    return this.setVisibleSessionsForSource('desktop', sessionIds);
  }

  /** `legacyTranscript`: this source cannot page from `transcriptHasOlder`
   *  (an old phone build) and keeps the 512-item page it was built for. */
  async setVisibleSessionsForSource(
    sourceId: string,
    sessionIds: string[],
    legacyTranscript = false
  ): Promise<boolean> {
    const source = String(sourceId || '').trim();
    if (!source) throw new TypeError('sourceId is required.');
    const requested = [...new Set(sessionIds.map(sessionIdOf))];
    this.owner.transcriptWindows.setLegacySource(source, legacyTranscript && requested.length > 0);
    try {
      const accepted = await this.owner.sessionViews.set(
        source,
        requested,
        (sessionId, alreadyVisible) => this.attachVisibleSession(sessionId, alreadyVisible),
        (sessionId) => this.owner.client.unsubscribe({ sessionId }, this.owner.callOptions())
      );
      this.owner.ensureColdViewRefresh();
      return accepted;
    } finally {
      this.owner.transcriptWindows.prune(this.owner.visibleSessionIds);
      this.owner.publication.pruneProjections();
    }
  }

  private async attachVisibleSession(sessionId: string, alreadyVisible: boolean): Promise<boolean> {
    if (alreadyVisible) {
      const projection = this.owner.publication.projections.get(sessionId);
      // A newly joined legacy source widens the window: re-read, never replay
      // a tail that source cannot page from.
      if (projection && !this.owner.transcriptWindows.stale(sessionId)) {
        this.owner.publishSession(sessionId, projection.snapshot, 'replay');
      } else await this.owner.readSession(sessionId);
      return true;
    }
    const prior = this.owner.publication.projections.get(sessionId);
    try {
      const result = await this.owner.client.subscribe(
        {
          sessionId,
          open: this.owner.openHints(sessionId),
          ...this.owner.transcriptWindows.send(sessionId),
          baseRevision: prior?.revision ?? null,
          // Live frames to this host may carry older-history pages as the
          // revealed rows only.
          transcriptPrepend: true,
        },
        this.owner.callOptions(undefined, TRANSCRIPT_READ_TIMEOUT_MS)
      );
      this.owner.applySessionResult(sessionId, result, false);
      const projection = this.owner.publication.projections.get(sessionId);
      if (projection) this.owner.publishSession(sessionId, projection.snapshot, 'replay');
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes(`session ${sessionId} is not available`)) return false;
      throw error;
    }
  }

  async searchProjectFiles(projectIdOrWorkspaceId: string, query: string, limit = 50): Promise<string[]> {
    const root = await this.owner.projectDirectory(projectIdOrWorkspaceId);
    return searchProjectDirectory(root, query, limit);
  }

  async submitNewTask(
    prompt: DesktopPromptContent,
    options: DesktopSubmitOptions = {},
    draft: DesktopNewTaskDraft = {}
  ): Promise<DesktopNewTaskSubmitResult> {
    const id = String(options.id || '').trim() || randomUUID();
    const stableOptions = { ...options, id, submittedAt: undefined };
    return this.owner.newTaskRequests.run(id, { prompt, options: stableOptions, draft }, async (request) => {
      if (request.phase === 'accepted') {
        return {
          accepted: true,
          sessionId: request.sessionId,
          snapshot: await this.owner.readSession(request.sessionId, false, false),
        };
      }
      return this.createNewTask(prompt, { ...options, id }, draft, request);
    });
  }

  /** Apply the draft's workflow, orchestration mode and route to a freshly
   *  reserved session, before its first submission. */
  private async configureDraft(sessionId: string, draft: DesktopNewTaskDraft): Promise<void> {
    if (draft.workflowId) {
      await this.owner.invokeSession(sessionId, 'setWorkflow', [draft.workflowId]);
    }
    if (draft.orchestrationMode !== undefined) {
      await this.owner.invokeSession(sessionId, 'setOrchestrationMode', [draft.orchestrationMode]);
    }
    if (!draft.route) return;
    const routeResult = await this.owner.invokeSession(sessionId, 'setRoute', [
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

  private async createNewTask(
    prompt: DesktopPromptContent,
    options: DesktopSubmitOptions,
    draft: DesktopNewTaskDraft,
    request: NewTaskRequest
  ): Promise<DesktopNewTaskSubmitResult> {
    const { registeredProject, cwd, desktopSession } = await this.owner.resolveSessionWorkspace(draft.projectPath);
    const created = await this.owner.client.create(
      { sessionId: request.sessionId, cwd, desktopSession },
      this.owner.callOptions(`session-create:${request.sessionId}`)
    );
    const sessionId = sessionIdOf(created.sessionId);
    if (sessionId !== request.sessionId) throw new Error('New task service returned a mismatched reserved session id.');
    this.owner.pendingCatalogSessionIds.add(sessionId);
    this.owner.applySessionResult(sessionId, created);
    try {
      if (request.phase === 'reserved') {
        await this.configureDraft(sessionId, draft);
        await request.commit('configured');
      }
      const goalCommand = String(options.goalCommand || '').trim();
      if (goalCommand) {
        const goalResult = await this.owner.invokeSession(sessionId, 'goalControl', [
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
        await this.owner.sessionMetadata.load();
        this.owner.sessionMetadata.rememberGeneratedTitle(sessionId, objective);
        this.owner.pendingCatalogSessionIds.delete(sessionId);
        await request.commit('accepted');
        void this.owner.publishCatalogs();
        return { accepted: true, sessionId, snapshot: goalResult.snapshot };
      }
      const submissionId = String(options.id || '').trim() || `desktop-submit-${sessionId}-${Date.now()}`;
      const prior = this.owner.publication.projections.get(sessionId);
      const result = await this.owner.client.submit(
        {
          sessionId,
          prompt,
          options: { ...options, id: submissionId },
          open: { cwd, desktopSession },
          baseRevision: prior?.revision ?? null,
        },
        this.owner.callOptions(`session-submit:${sessionId}:${submissionId}`)
      );
      if (String(result.sessionId || '') !== sessionId) {
        throw new Error('New task service returned a mismatched session id.');
      }
      const accepted = result.accepted === true;
      const snapshot = this.owner.applySessionResult(sessionId, result);
      if (String(snapshot?.sessionId || '') !== sessionId) {
        throw new Error('New task service returned a mismatched session snapshot.');
      }
      if (!accepted) {
        await this.owner.client.unsubscribe({ sessionId }, this.owner.callOptions()).catch(() => ({}));
        return { accepted: false, sessionId: '', snapshot: null };
      }
      if (registeredProject) await this.owner.touchProject(registeredProject);
      await this.owner.sessionMetadata.load();
      this.owner.sessionMetadata.rememberGeneratedTitle(sessionId, promptTitle(prompt, options.displayText || ''));
      this.owner.pendingCatalogSessionIds.delete(sessionId);
      await request.commit('accepted');
      void this.owner.publishCatalogs();
      return { accepted: true, sessionId, snapshot };
    } catch (error) {
      try {
        await this.owner.client.unsubscribe({ sessionId }, this.owner.callOptions());
      } catch {}
      throw error;
    } finally {
      this.owner.pendingCatalogSessionIds.delete(sessionId);
    }
  }

  async inheritSession(
    sourceSessionId: string,
    route?: DesktopModelSelection | null
  ): Promise<{ sessionId: string; snapshot: SessionSnapshot | null }> {
    const source = sessionIdOf(sourceSessionId);
    const rows = await this.owner.listSessions();
    const { cwd, desktopSession } = await this.owner.resolveSessionWorkspace(
      rows.find((entry) => entry.id === source)?.projectPath
    );
    const created = await this.owner.client.create(
      {
        cwd,
        desktopSession,
        ...(route?.provider ? { provider: route.provider } : {}),
        ...(route?.model ? { model: route.model } : {}),
      },
      this.owner.callOptions(`session-create:${process.pid}:${randomUUID()}`)
    );
    const sessionId = sessionIdOf(created.sessionId);
    this.owner.pendingCatalogSessionIds.add(sessionId);
    this.owner.applySessionResult(sessionId, created);
    try {
      // The heir opens on the route the user is looking at; without this it
      // would inherit the daemon's current default instead.
      if (route) {
        await this.owner.invokeSession(sessionId, 'setRoute', [
          {
            ...route,
            applyToCurrentSession: true,
          },
        ]);
      }
      const inherited = await this.owner.invokeSession(sessionId, 'inheritFrom', [source]);
      await this.owner.sessionMetadata.load();
      this.owner.pendingCatalogSessionIds.delete(sessionId);
      void this.owner.publishCatalogs();
      return { sessionId, snapshot: inherited.snapshot ?? null };
    } catch (error) {
      // A half-built heir must not linger in the catalog.
      try {
        await this.owner.client.unsubscribe({ sessionId }, this.owner.callOptions());
      } catch {
        /* the create is being abandoned either way */
      }
      throw error;
    } finally {
      this.owner.pendingCatalogSessionIds.delete(sessionId);
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
    const prior = this.owner.publication.projections.get(id);
    const result = await this.owner.client.submit(
      {
        sessionId: id,
        prompt,
        options: { ...options, id: submissionId },
        open: this.owner.openHints(id),
        baseRevision: prior?.revision ?? null,
      },
      this.owner.callOptions(`session-submit:${id}:${submissionId}`)
    );
    this.owner.applySessionResult(id, result);
    return result.accepted === true;
  }

  async abortSession(sessionId: string, options: DesktopAbortOptions = {}): Promise<unknown> {
    const id = sessionIdOf(sessionId);
    const result = await this.owner.client.abort(
      {
        sessionId: id,
        options,
        open: this.owner.openHints(id),
        baseRevision: this.owner.publication.projections.get(id)?.revision ?? null,
      },
      this.owner.callOptions()
    );
    this.owner.applySessionResult(id, result);
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
    const result = await this.owner.client.approve(
      {
        sessionId: target,
        approvalId: id,
        decision,
        open: this.owner.openHints(target),
        baseRevision: this.owner.publication.projections.get(target)?.revision ?? null,
      },
      this.owner.callOptions()
    );
    this.owner.applySessionResult(target, result);
    return result.approved === true;
  }

  async listProviderModels(options: DesktopModelCatalogOptions = {}): Promise<DesktopModelOption[]> {
    return normalizedProviderModels(await this.owner.invokeControl('listProviderModels', [options]));
  }

  async setModelRoute(selection: DesktopModelSelection, sessionId?: string): Promise<SessionSnapshot> {
    const target = sessionId || (await this.owner.ensureControlSession());
    const { value, snapshot } = await this.owner.invokeSession(target, 'setRoute', [
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
    const target = sessionId || (await this.owner.ensureControlSession());
    return (await this.owner.invokeSession(target, 'setFast', [enabled])).snapshot;
  }

  async invokeCapability<T = unknown>(
    capability: DesktopCapability,
    args: unknown[] = [],
    sessionId?: string
  ): Promise<DesktopCapabilityResult<T>> {
    const result = sessionId
      ? await this.owner.invokeSession(sessionId, capability, args)
      : await this.owner.invokeControlResult(capability, args);
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
            value: copyCapabilityValue(await this.owner.invokeControl(request.capability, request.args || [])),
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
}
