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
  /** `remoteToolOutput` (main/remote-transcript.ts) over a folded state. */
  remoteToolOutput(
    state: unknown,
    itemId: string
  ): { id: string; result?: unknown; rawResult?: unknown; uiDiff?: unknown } | null;
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
      const output = shared.remoteToolOutput(state, itemId);
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

// ── The phone's thread list (decisions.md, "Phone thread list after a core restart") ─────────────────────────────────────────────────
// Node's view sync subscribed to the catalog, then listed it, and a roster pushed during that read outranked the listing
// (view-synchronizer.ts readCatalog); the phone replaced its list with that baseline on every attach, a restarted desktop's included.
// The core republishes no thread edge after a restart and rejects an old-epoch replay, so after the app feed is re-subscribed the
// list is read again, in full, and the edges that arrived meanwhile are laid over it: an edge outranks the listing, as the push did.

type ThreadRow = Record<string, unknown>;

/** The part of `ProtocolClient` the roster reads. */
export interface RosterClient {
  call(method: string, params: unknown): Promise<unknown>;
  on(listener: (event: { type: string; notification?: { method: string; params?: unknown } }) => void): () => void;
  readonly store: {
    subscribe(listener: (change: { type: string; feedId?: string; state?: string }) => void): () => void;
  };
}

const PAGE_LIMIT = 1000; // the core's largest `thread/list` page (thread_list.rs MAX_PAGE_LIMIT)
const idOf = (row: ThreadRow): string => String(row.id ?? '');
// The catalog's order (thread_edges.rs place_of): newest activity first, then the id.
const activityOf = (row: ThreadRow): number => Number(row.activityAt ?? row.updatedAt) || 0;
const inCatalogOrder = (a: ThreadRow, b: ThreadRow): number =>
  activityOf(b) - activityOf(a) || (idOf(a) < idOf(b) ? -1 : idOf(a) > idOf(b) ? 1 : 0);

export function createRosterFeed<S>(options: {
  /** The sidebar projection of core rows (`summariesOfThreadRows`, main/protocol/thread-rows.ts). */
  summaries(rows: ThreadRow[]): S[];
  /** `ctx.sessionsCatalog`: what `subscribeSessions` listeners hear. */
  publish(rows: S[]): void;
}) {
  let held = new Map<string, ThreadRow>();
  let known = false;
  let reading: Promise<S[]> | null = null;
  // Edges since the read began (or, before any read, since the feed attached): they outrank the listing.
  const edges = new Map<string, ThreadRow | null>();
  const project = (rows: Iterable<ThreadRow>): S[] => options.summaries([...rows].sort(inCatalogOrder));

  const apply = (target: Map<string, ThreadRow>, id: string, row: ThreadRow | null): void => {
    if (row) target.set(id, row);
    else target.delete(id);
  };

  /** `client` is the caller's own (a phone call's request carries that call's claim). */
  const list = (client: Pick<RosterClient, 'call'>): Promise<S[]> => {
    if (reading) return reading;
    const read = (async () => {
      const listed = new Map<string, ThreadRow>();
      for (let cursor: string | undefined; ; ) {
        const page = (await client.call('thread/list', { limit: PAGE_LIMIT, ...(cursor ? { cursor } : {}) })) as {
          data?: ThreadRow[];
          nextCursor?: string;
        };
        for (const row of page.data ?? []) listed.set(idOf(row), row);
        if (!page.nextCursor) break;
        cursor = page.nextCursor;
      }
      for (const [id, row] of edges) apply(listed, id, row);
      edges.clear();
      held = listed;
      known = true;
      const rows = project(held.values());
      options.publish(rows);
      return rows;
    })();
    reading = read;
    const done = (): void => {
      if (reading === read) reading = null;
    };
    read.then(done, done);
    return read;
  };

  const onEdge = (method: string, params: Record<string, unknown>): void => {
    const thread = params.thread as ThreadRow | undefined;
    const id = method === 'thread/deleted' ? String(params.threadId ?? '') : thread ? idOf(thread) : '';
    if (!id) return;
    const row = method === 'thread/deleted' ? null : (thread as ThreadRow);
    if (reading || !known) {
      edges.set(id, row);
      return;
    }
    const was = held.get(id);
    if (JSON.stringify(was) === JSON.stringify(row)) return; // CatalogChannel.publish skipped an unchanged roster
    apply(held, id, row);
    options.publish(project(held.values()));
  };

  return {
    list,
    /** Watches one connection's client; `listFor` is the read after its app feed is back (no caller's claim is involved). */
    attach(client: RosterClient): () => void {
      const offEvents = client.on((event) => {
        const n = event.notification;
        if (event.type === 'notification' && n && (n.method === 'thread/started' || n.method === 'thread/summary/updated' || n.method === 'thread/deleted')) {
          onEdge(n.method, (n.params ?? {}) as Record<string, unknown>);
        }
      });
      const offStore = client.store.subscribe((change) => {
        // ppSnapshot names no feed (it is the app feed's own); a subscription change names it.
        if (change.type === 'subscription' && change.feedId !== 'app') return;
        if (change.type === 'subscription' && change.state === 'lost') known = false;
        // The re-attachment of a reconnect, or the first snapshot of an attach: list again, as Node's baseline was.
        else if ((change.type === 'subscription' && change.state === 'restored') || (change.type === 'appSnapshot' && !known)) {
          void list(client).catch(() => undefined); // a connection that ends mid-read is read again by the next reconnect
        }
      });
      return () => {
        offEvents();
        offStore();
      };
    },
  };
}

// ── The adapter the phone's switch point loads ───────────────────────────────────────────────────────────────────────────────────────
import type { PhoneProtocolAdapter, PhoneProtocolHost } from './remote-shim-protocol';

const CHAT_CALLS = [
  'abortSession', 'agentRoomAction', 'answerApprovalNotification', 'cancelQuotaResume', 'continueSessionInModel', 'deleteSession',
  'getQuotaAutoResume', 'getTaskWorkspace', 'inheritSession', 'listProviderModels', 'markSessionRead', 'openAgentHome',
  'prefetchSession', 'provideSecretInput', 'readCapabilities', 'readTranscriptHistory', 'readTranscriptItem', 'releaseShellJob',
  'renameSession', 'resetAgentHome', 'resolveToolApprovalForSession', 'scheduleQuotaResume', 'searchSessionContent', 'setModelRoute',
  'setQuotaAutoResume', 'setSessionArchived', 'setSessionFavorite', 'setSessionProject', 'startProject', 'startProjectTask',
  'startTask', 'stopShellJob', 'submitFeedback', 'submitNewTask', 'submitToSession', 'viewerDevice', 'setFast',
] as const satisfies ReadonlyArray<keyof ChatApi>;

/** `sharedFor` and the api are made PER CALL from `host.client()`: that client carries this call's transmission claim
 *  (phone-send-scope.ts), so a request written through anything built from it is claimed; one captured at start would not be. */
export function createChatAdapter(options: {
  sharedFor(client: ChatClient): ChatShared;
  approvalNotifications?: ChatApprovalNotifications;
  roster: { summaries(rows: ThreadRow[]): unknown[] };
}): PhoneProtocolAdapter {
  let feed: ReturnType<typeof createRosterFeed> | undefined;
  const feedFor = (host: PhoneProtocolHost) =>
    (feed ??= createRosterFeed({ summaries: options.roster.summaries, publish: (rows) => host.ctx.sessionsCatalog.publish(rows as never) }));
  const api = (host: PhoneProtocolHost) => {
    const client = host.client() as unknown as ChatClient;
    return createChatApi(client, options.sharedFor(client), { approvalNotifications: options.approvalNotifications });
  };
  const calls: Record<string, (params: unknown[], host: PhoneProtocolHost) => unknown> = {};
  for (const name of CHAT_CALLS) {
    calls[name] = (params, host) => (api(host)[name] as (...args: unknown[]) => unknown)(...params);
  }
  calls.listSessions = (_params, host) => feedFor(host).list(host.client() as unknown as RosterClient);
  return {
    group: 'chat',
    calls,
    install(host) {
      let off: (() => void) | undefined;
      let stopped = false;
      void host.ctx.phone.start().then(() => {
        if (!stopped) off = feedFor(host).attach(host.client() as unknown as RosterClient);
      });
      return () => {
        stopped = true;
        off?.();
      };
    },
  };
}
