// PH-2 "Chat" group of the phone over `mixdogd`: the DesktopApi calls the phone made as Node-name relay calls
// (remote-shim-api.ts) become protocol requests, answered with what Node's host returned to the phone.
//
// The desktop's own conversions are not copied: the request mapping (`routeService`, service-route.ts), the capability
// lane (`createCapabilityLane`, capability-route.ts: rename, archive/favorite/project, delete, shell jobs, quota switch,
// approvals, route/fast snapshots, capability reads) and the folded-state readers come in through `ChatShared`. Those
// modules import Node (`node:path`, desktop-support, runtime-layout) or `.ts` specifiers that the web build refuses
// (tsconfig.web.json), so the caller injects them until they are moved to `src/shared/`.
import type {
  DesktopAbortOptions,
  DesktopCapabilityReadRequest,
  DesktopCapabilityReadResult,
  DesktopFeedbackReceipt,
  DesktopModelCatalogOptions,
  DesktopModelOption,
  DesktopModelSelection,
  DesktopNewTaskDraft,
  DesktopNewTaskSubmitResult,
  DesktopPromptContent,
  DesktopSessionContentMatch,
  DesktopShellStopResult,
  DesktopSubmitOptions,
  DesktopTranscriptHistoryPage,
  DesktopTranscriptHistoryRequest,
  SessionSnapshot,
  ToolApprovalDecision,
} from '../shared/contract';

/** The part of `ProtocolClient` (packages/protocol-client) this adapter uses. */
export interface ChatClient {
  call(method: string, params: unknown): Promise<unknown>;
  resumeThread(threadId: string, window: unknown): Promise<unknown>;
  unsubscribeThread(threadId: string): Promise<void>;
  readonly server: { readonly connection?: { readonly device?: string } };
}

export interface ChatRoute {
  requests: ReadonlyArray<{ method: string; params: Record<string, unknown> }>;
  result: 'reply' | 'snapshot' | 'none';
}

/** `createCapabilityLane(...)` of main/protocol/capability-route.ts. */
export interface ChatLane {
  invoke(capability: string, args: unknown[], sessionId: string | undefined): Promise<{ value: unknown; snapshot: SessionSnapshot }>;
  read(requests: ReadonlyArray<DesktopCapabilityReadRequest>): Promise<DesktopCapabilityReadResult[]>;
  renameSession(sessionId: string, title: string): Promise<void>;
  setSessionFavorite(sessionId: string, favorite: boolean): Promise<void>;
  setSessionProject(sessionId: string, projectPath: string): Promise<void>;
  setSessionArchived(sessionId: string, archived: boolean): Promise<void>;
  deleteSession(sessionId: string): Promise<void>;
  stopShellJob(sessionId: string, taskId: string): Promise<DesktopShellStopResult>;
  releaseShellJob(sessionId: string, taskId: string): Promise<{ released: boolean; error?: string }>;
  getQuotaAutoResume(): Promise<boolean>;
  setQuotaAutoResume(enabled: boolean): Promise<boolean>;
  resolveToolApproval(sessionId: string, id: string, decision: Record<string, unknown>): Promise<boolean>;
}

export interface ChatShared {
  routeService(method: string, args: readonly unknown[]): ChatRoute;
  /** The lane of capability-route.ts, built on the connection this client is. */
  lane: ChatLane;
  coreErrorForWindow(error: unknown): unknown;
  /** `normalizedProviderModels` (main/desktop-support.ts): Node's host shaped the daemon's catalog rows with it. */
  normalizedProviderModels(rows: unknown): DesktopModelOption[];
  /** `sessionStateOf` (protocol-client): the `SessionSnapshot` of a thread this client folds. */
  sessionStateOf(threadId: string): SessionSnapshot | undefined;
  /** The phone's transcript window (main/remote-phone-transcript.ts `createPhoneTranscript`, kept out of this bundle's imports as
   *  main code): the states the phone is shown pass through its `view`. */
  transcript: {
    page(threadId: string, state: unknown, limit: number): Promise<void>;
    output(
      threadId: string,
      state: unknown,
      itemId: string
    ): { id: string; result?: unknown; rawResult?: unknown; uiDiff?: unknown } | null;
  };
}

/** RemoteMethodDependencies['approvalNotifications'] (remote-methods.ts): the host's rules for a phone's bare Allow. */
export interface ChatApprovalNotifications {
  approvalPointerOnly(sessionId: string, approvalId: string): boolean;
  approvalAllowDecision(sessionId: string, approvalId: string): Record<string, unknown> | null | undefined;
}

export type ApprovalNotificationAnswer = 'answered' | 'settled' | 'open';

// remote-session-methods.ts READ_NOT_VIEWED / READ_NOT_HELD
export const READ_NOT_VIEWED = 'This session is not open on this device.';
export const READ_NOT_HELD = 'This row is not in the transcript this device holds.';

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

export function createChatApi(
  client: ChatClient,
  shared: ChatShared,
  options: { approvalNotifications?: ChatApprovalNotifications } = {}
) {
  const { lane } = shared;
  const send = (request: { method: string; params: unknown }): Promise<unknown> =>
    client.call(request.method, request.params).catch((error: unknown) => {
      throw shared.coreErrorForWindow(error);
    });
  const service = async (method: string, args: readonly unknown[]): Promise<unknown> => {
    let reply: unknown;
    for (const request of shared.routeService(method, args).requests) reply = await send(request);
    return reply;
  };
  /** The state of a thread the phone is about to show: the fold of its feed, resumed first when it is not followed. */
  const snapshotOf = async (threadId: string): Promise<SessionSnapshot> => {
    const held = shared.sessionStateOf(threadId);
    if (held) return held;
    const [resume] = shared.routeService('prefetchSession', [threadId]).requests;
    await client.resumeThread(threadId, resume?.params.window);
    const resumed = shared.sessionStateOf(threadId);
    if (!resumed) throw new Error('The core did not fold the thread.');
    return resumed;
  };
  // Node's `blankSnapshot` (session-host-lifecycle.ts:144): no session yet, the folder the next task starts in.
  const blankSnapshot = (started: unknown): SessionSnapshot => {
    const thread = record(record(started).thread);
    const projectPath = typeof thread.projectPath === 'string' ? thread.projectPath : null;
    return {
      sessionId: '',
      items: [],
      queued: [],
      busy: false,
      commandBusy: false,
      cwd: thread.cwd,
      currentProject: projectPath,
      desktopSession: { classification: projectPath ? 'project' : 'task', projectPath },
    } as unknown as SessionSnapshot;
  };
  const addressed = async (capability: string, args: unknown[], sessionId: string): Promise<boolean> =>
    (await lane.invoke(capability, args, sessionId)).value === true;

  const resolveApproval = (sessionId: string, id: string, decision: Record<string, unknown>) =>
    lane.resolveToolApproval(sessionId, id, decision);

  return {
    viewerDevice: async (): Promise<string> => client.server.connection?.device || 'Web app',
    markSessionRead: async (sessionId: string, messageCount: number, consumedUnread = false): Promise<boolean> =>
      (await service('markSessionRead', [sessionId, messageCount, consumedUnread])) === true,
    searchSessionContent: async (query: string): Promise<DesktopSessionContentMatch[]> => {
      const hits = await service('searchSessionContent', [query]);
      return Array.isArray(hits) ? hits.map(({ sessionId, snippet, rank }) => ({ sessionId, snippet, rank })) : [];
    },
    renameSession: (sessionId: string, title: string): Promise<void> => lane.renameSession(sessionId, title),
    continueSessionInModel: (sessionId: string, route: DesktopModelSelection): Promise<boolean> =>
      addressed('continueSessionInModel', [route], sessionId),
    scheduleQuotaResume: (sessionId: string): Promise<boolean> => addressed('scheduleQuotaResume', [], sessionId),
    cancelQuotaResume: (sessionId: string): Promise<boolean> => addressed('cancelQuotaResume', [], sessionId),
    stopShellJob: (sessionId: string, taskId: string) => lane.stopShellJob(sessionId, taskId),
    releaseShellJob: (sessionId: string, taskId: string) => lane.releaseShellJob(sessionId, taskId),
    getQuotaAutoResume: (): Promise<boolean> => lane.getQuotaAutoResume(),
    setQuotaAutoResume: (enabled: boolean): Promise<boolean> => lane.setQuotaAutoResume(enabled),
    getTaskWorkspace: async (): Promise<string> => String(record(await service('getTaskWorkspace', [])).path),
    readTranscriptItem: async (sessionId: string, itemId: string) => {
      const state = shared.sessionStateOf(sessionId);
      if (!state) throw new Error(READ_NOT_VIEWED);
      const output = shared.transcript.output(sessionId, state, itemId);
      if (!output) throw new Error(READ_NOT_HELD);
      return output;
    },
    setSessionArchived: (sessionId: string, archived: boolean): Promise<void> => lane.setSessionArchived(sessionId, archived),
    setSessionFavorite: (sessionId: string, favorite: boolean): Promise<void> => lane.setSessionFavorite(sessionId, favorite),
    setSessionProject: (sessionId: string, projectPath: string): Promise<void> => lane.setSessionProject(sessionId, projectPath),
    openAgentHome: async (agentId: string): Promise<{ sessionId: string }> =>
      (await service('openAgentHome', [agentId])) as { sessionId: string },
    resetAgentHome: async (agentId: string): Promise<{ sessionId: string; archivedSessionId: string | null }> =>
      (await service('resetAgentHome', [agentId])) as { sessionId: string; archivedSessionId: string | null },
    agentRoomAction: async (action: string, args: unknown[]): Promise<unknown> => {
      const reply = await service('agentRoomAction', [action, args]);
      // Node's remove answered nothing; `room/remove` answers `{}` (service.rs:268).
      return action === 'remove' ? undefined : reply;
    },
    deleteSession: async (sessionId: string): Promise<SessionSnapshot> => {
      await lane.deleteSession(sessionId);
      await client.unsubscribeThread(sessionId).catch(() => undefined);
      // Node answers `null`: the page keeps its own state (use-app-session-actions applySnapshot).
      return null as unknown as SessionSnapshot;
    },
    prefetchSession: async (sessionId: string, transcriptItemLimit?: number, _readTraceId?: string): Promise<boolean> => {
      // A thread the phone follows pages its own window (Node: requestPhoneTranscriptPage); one it does not is resumed.
      const state = shared.sessionStateOf(sessionId);
      if (state && typeof transcriptItemLimit === 'number') {
        await shared.transcript.page(sessionId, state, transcriptItemLimit);
        return true;
      }
      const [resume] = shared.routeService('prefetchSession', [sessionId, transcriptItemLimit]).requests;
      await client.resumeThread(sessionId, resume?.params.window);
      return true;
    },
    // Rust gap (position paging): Node's own answer for a host that cannot, which the page meets by growing its window.
    readTranscriptHistory: async (
      _sessionId: string,
      _request: DesktopTranscriptHistoryRequest
    ): Promise<DesktopTranscriptHistoryPage> => ({ items: [], hasOlder: false, hasNewer: false, unsupported: true }),
    startProject: async (projectPath: string): Promise<SessionSnapshot> => blankSnapshot(await service('startProject', [projectPath])),
    startProjectTask: async (projectPath: string): Promise<SessionSnapshot> =>
      blankSnapshot(await service('startProjectTask', [projectPath])),
    startTask: async (): Promise<SessionSnapshot> => blankSnapshot(await service('startTask', [])),
    submitNewTask: async (
      prompt: DesktopPromptContent,
      submit: DesktopSubmitOptions = {},
      draft: DesktopNewTaskDraft = {}
    ): Promise<DesktopNewTaskSubmitResult> => {
      const started = record(await service('submitNewTask', [prompt, submit, draft]));
      if (!started.turn) return { accepted: false, sessionId: '', snapshot: null } as unknown as DesktopNewTaskSubmitResult;
      const sessionId = String(record(started.thread).id);
      return { accepted: true, sessionId, snapshot: await snapshotOf(sessionId) } as unknown as DesktopNewTaskSubmitResult;
    },
    submitToSession: async (sessionId: string, prompt: DesktopPromptContent, submit: DesktopSubmitOptions = {}): Promise<boolean> => {
      await service('submitToSession', [sessionId, prompt, submit]);
      return true;
    },
    abortSession: async (sessionId: string, abort: DesktopAbortOptions = {}): Promise<unknown> => {
      const reply = record(await service('abortSession', [sessionId, abort]));
      // Rust gap: `turn/interrupt` hands no prompt back (restorePrompt is not acted on), so nothing is restored.
      return {
        aborted: reply.cancelRequested === true,
        restoreText: '',
        pastedImages: null,
        pastedTexts: null,
        discardPastedImages: null,
        discardPastedTexts: null,
        restoredSubmissionIds: [],
      };
    },
    resolveToolApprovalForSession: async (sessionId: string, id: string, decision: ToolApprovalDecision): Promise<boolean> => {
      const answer = decision as unknown as Record<string, unknown>;
      // remote-session-methods.ts:183: a bare Allow of an approval the notification already opened the app on.
      if (answer.approved && answer.response === undefined && options.approvalNotifications?.approvalPointerOnly(sessionId, id) === true) {
        return false;
      }
      return resolveApproval(sessionId, id, answer);
    },
    answerApprovalNotification: async (sessionId: string, id: string, action: 'allow' | 'deny'): Promise<ApprovalNotificationAnswer> => {
      if (action !== 'allow' && action !== 'deny') throw new TypeError('action must be allow or deny.');
      const decision = action === 'allow' ? options.approvalNotifications?.approvalAllowDecision(sessionId, id) : { approved: false };
      if (!decision) return 'open';
      return (await resolveApproval(sessionId, id, decision)) ? 'answered' : 'settled';
    },
    provideSecretInput: async (requestId: string, value: string): Promise<boolean> => {
      await send({ method: 'approval/provideSecret', params: { requestId, secret: typeof value === 'string' ? value : '' } });
      return true;
    },
    inheritSession: async (
      sourceSessionId: string,
      selection?: DesktopModelSelection | null,
      inherit?: { compact: boolean } | null
    ): Promise<{ sessionId: string; snapshot: SessionSnapshot | null }> => {
      const forked = record(await service('inheritSession', [sourceSessionId, selection ?? null, inherit ?? null]));
      const sessionId = String(record(forked.thread).id);
      return { sessionId, snapshot: await snapshotOf(sessionId) };
    },
    listProviderModels: async (catalog: DesktopModelCatalogOptions = {}): Promise<DesktopModelOption[]> =>
      shared.normalizedProviderModels(await service('listProviderModels', [catalog])),
    setModelRoute: async (selection: DesktopModelSelection, sessionId?: string): Promise<SessionSnapshot> =>
      (
        await lane.invoke(
          'setRoute',
          [{ ...selection, applyToCurrentSession: true, keepMainModel: Boolean(sessionId) }],
          sessionId || undefined
        )
      ).snapshot,
    setFast: async (enabled: boolean, sessionId?: string): Promise<SessionSnapshot> =>
      (await lane.invoke('setFast', [enabled], sessionId || undefined)).snapshot,
    submitFeedback: async (input: unknown): Promise<DesktopFeedbackReceipt> =>
      (await send({ method: 'feedback/upload', params: { input } })) as DesktopFeedbackReceipt,
    readCapabilities: (requests: DesktopCapabilityReadRequest[]): Promise<DesktopCapabilityReadResult[]> => lane.read(requests),
  };
}

export type ChatApi = ReturnType<typeof createChatApi>;
