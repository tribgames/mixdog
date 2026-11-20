// PH-2 "Chat" group of the phone over `mixdogd`: the DesktopApi calls the phone made as Node-name relay calls
// (remote-shim-api.ts) become protocol requests, answered with what Node's host returned to the phone.
//
// The desktop's own conversions are not copied: the request mapping (`routeService`, service-route.ts), the capability
// lane (`createCapabilityLane`, capability-route.ts: rename, archive/favorite/project, delete, shell jobs, quota switch,
// approvals, route/fast snapshots, capability reads) and the folded-state readers come in through `ChatShared`, which
// `sharedFor` builds from those modules. `createChatApi` takes it as a parameter so tests can supply their own.
import type {
  DesktopAbortOptions,
  DesktopCapabilityReadRequest,
  DesktopCapabilityReadResult,
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
import { SECTION_NAMES, type DesktopSectionsSnapshot } from '../shared/contract-sections';
import type { ProtocolClient, SessionFold } from '../../../../packages/protocol-client/src/index.ts';
import { mergeToolRows, rowsOf, sessionStateOf } from '../../../../packages/protocol-client/src/index.ts';
import { createChatHostApi, READ_NOT_HELD, READ_NOT_VIEWED, type ChatHostShared } from './remote-chat-host';
import { callSharingControlThread } from './remote-capability-lane';
import { followSessionStates, type SessionStateFollower } from './remote-session-states';
import { remoteConnectionInterruptedError } from './remote-connection-state';
import { phoneTransferCall } from './remote-transfer-call';
import { remoteSessionIdOf, withRemoteSession } from '../shared/blank-snapshot.ts';
import { createCapabilityLane } from '../main/protocol/capability-route';
import { coreErrorForWindow } from '../main/protocol/core-error';
import { routeService } from '../main/protocol/service-route';
import { summariesOfThreadRows } from '../main/protocol/thread-rows';
import { remoteToolOutput, remoteTranscriptSnapshot } from '../main/remote-transcript';
import { approvalAllowIsPointerOnly } from '../shared/approval-enter-rule';
import { markPartialCatalog } from '../shared/session-catalog';
import { normalizedProviderModels } from '../shared/desktop-transcript-limits';

/** The part of `ProtocolClient` (packages/protocol-client) this adapter uses. */
export interface ChatClient {
  call(method: string, params: unknown): Promise<unknown>;
  /** `join`: a resume of the thread the client already has in flight (its snapshot not folded yet) answers this one; none is sent. */
  resumeThread(
    threadId: string,
    window: unknown,
    options?: { readonly join?: boolean; readonly force?: boolean }
  ): Promise<unknown>;
  unsubscribeThread(threadId: string): Promise<void>;
  readonly server: { readonly connection?: { readonly device?: string } };
}

export interface ChatRoute {
  requests: ReadonlyArray<{ method: string; params: Record<string, unknown> }>;
  /** How the desktop's lane answers the method (service-route.ts `ServiceResult`); this adapter reads only the requests. */
  result: string;
}

/** `createCapabilityLane(...)` of main/protocol/capability-route.ts. */
export interface ChatLane {
  invoke(
    capability: string,
    args: unknown[],
    sessionId: string | undefined
  ): Promise<{ value: unknown; snapshot: SessionSnapshot }>;
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
  /** Optional transport for routing large submission fields outside the control RPC. */
  sendTransfer?(method: string, params: unknown): Promise<unknown>;
  /** The lane of capability-route.ts, built on the connection this client is. */
  lane: ChatLane;
  coreErrorForWindow(error: unknown): unknown;
  /** `normalizedProviderModels` (main/desktop-support.ts): Node's host shaped the daemon's catalog rows with it. */
  normalizedProviderModels(rows: unknown): DesktopModelOption[];
  /** `sessionStateOf` (protocol-client): the `SessionSnapshot` of a thread this client folds. */
  sessionStateOf(threadId: string): SessionSnapshot | undefined;
  /** Runs `resume` (the thread's subscription) and resolves once the client has folded the thread's snapshot: the client folds a
   *  snapshot in budgeted steps after the subscription's reply (client.ts `fold`), so the reply alone leaves no fold to read. */
  whenFolded(threadId: string, resume: () => Promise<unknown>): Promise<void>;
  /** Resolves once the core no longer asks request `id` of this connection (`serverRequest/resolved`, or the socket's end). */
  whenSettled(id: string): Promise<void>;
  /** The pending server request whose card shows `cardId`; an id no card shows is passed on as it is. */
  approvalRequestId(cardId: string): string;
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

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

export function createChatApi(client: ChatClient, shared: ChatShared) {
  const { lane } = shared;
  const call = shared.sendTransfer ?? ((method: string, params: unknown) => client.call(method, params));
  const send = (request: { method: string; params: unknown }): Promise<unknown> =>
    call(request.method, request.params).catch((error: unknown) => {
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
    await shared.whenFolded(threadId, () => client.resumeThread(threadId, resume?.params.window, { join: true }));
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

  // Node's host answered once the daemon had resolved the approval (session-host resolveToolApproval awaits the daemon's reply), so a
  // second answer to it found it settled: an answer here is over when the core has resolved the request it answered.
  const resolveApproval = async (
    sessionId: string,
    cardId: string,
    decision: Record<string, unknown>
  ): Promise<boolean> => {
    // The phone names the approval by its card's id (room_approval.rs `card_id`); the core answers the request that carries it.
    const id = shared.approvalRequestId(cardId);
    const settled = shared.whenSettled(id);
    const answered = await lane.resolveToolApproval(sessionId, id, decision);
    if (answered) await settled;
    return answered;
  };
  /** The approval the session shows now, as Node's push notifier held it from the host's session states (push-notifier.ts
   *  onSessionState: `toolApproval`, a question being none, its id `String(id ?? 'pending')`), read from this client's fold of the
   *  thread. The thread is followed first when it is not: the core hands a pending request only to a connection that follows its
   *  thread (outgoing.rs `deliver`), and the answer goes to that request. */
  const shownApproval = async (
    sessionId: string
  ): Promise<{ id: string; approval: Record<string, unknown> } | null> => {
    const approval = (await snapshotOf(sessionId))?.toolApproval as unknown;
    if (!approval || typeof approval !== 'object' || record(approval).kind === 'question') return null;
    return { id: String(record(approval).id ?? 'pending'), approval: record(approval) };
  };

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
    readTranscriptItem: async (sessionId: string, itemId: string, replayToken?: string) => {
      const state = shared.sessionStateOf(sessionId);
      if (!state) throw new Error(READ_NOT_VIEWED);
      // A digest is not permission to read a historical row, and the stored
      // item reader does not address a specific position. Never fall back to
      // the current row for an exact-revision request.
      if (replayToken !== undefined) return null;
      const output = shared.transcript.output(sessionId, state, itemId);
      if (!output) throw new Error(READ_NOT_HELD);
      return output;
    },
    setSessionArchived: (sessionId: string, archived: boolean): Promise<void> =>
      lane.setSessionArchived(sessionId, archived),
    setSessionFavorite: (sessionId: string, favorite: boolean): Promise<void> =>
      lane.setSessionFavorite(sessionId, favorite),
    setSessionProject: (sessionId: string, projectPath: string): Promise<void> =>
      lane.setSessionProject(sessionId, projectPath),
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
    prefetchSession: async (
      sessionId: string,
      transcriptItemLimit?: number,
      _readTraceId?: string
    ): Promise<boolean> => {
      // A thread the phone follows pages its own window (Node: requestPhoneTranscriptPage); one it does not is resumed.
      const state = shared.sessionStateOf(sessionId);
      if (state && typeof transcriptItemLimit === 'number') {
        await shared.transcript.page(sessionId, state, transcriptItemLimit);
        return true;
      }
      const [resume] = shared.routeService('prefetchSession', [sessionId, transcriptItemLimit]).requests;
      await client.resumeThread(sessionId, resume?.params.window, { join: true });
      return true;
    },
    // Rust gap (position paging): Node's own answer for a host that cannot, which the page meets by growing its window.
    readTranscriptHistory: async (
      _sessionId: string,
      _request: DesktopTranscriptHistoryRequest
    ): Promise<DesktopTranscriptHistoryPage> => ({ items: [], hasOlder: false, hasNewer: false, unsupported: true }),
    startProject: async (projectPath: string): Promise<SessionSnapshot> =>
      blankSnapshot(await service('startProject', [projectPath])),
    startProjectTask: async (projectPath: string): Promise<SessionSnapshot> =>
      blankSnapshot(await service('startProjectTask', [projectPath])),
    startTask: async (): Promise<SessionSnapshot> => blankSnapshot(await service('startTask', [])),
    submitNewTask: async (
      prompt: DesktopPromptContent,
      submit: DesktopSubmitOptions = {},
      draft: DesktopNewTaskDraft = {}
    ): Promise<DesktopNewTaskSubmitResult> => {
      const started = record(await service('submitNewTask', [prompt, submit, draft]));
      // A refusal is an error, not a reply; a reply without turn answers a retry of a submission the core already accepted.
      const sessionId = String(record(started.thread).id || '');
      if (!sessionId)
        return { accepted: false, sessionId: '', snapshot: null } as unknown as DesktopNewTaskSubmitResult;
      // Node answers the session's projection (session-host-lifecycle.ts:938 applySessionResult), not the published state the host
      // decorates with its shell jobs (session-host.ts snapshotWithShellJobs).
      const {
        shellJobs: _shellJobs,
        hostShellJobs: _hostShellJobs,
        ...snapshot
      } = (await snapshotOf(sessionId)) as Record<string, unknown>;
      return { accepted: true, sessionId, snapshot } as unknown as DesktopNewTaskSubmitResult;
    },
    submitToSession: async (
      sessionId: string,
      prompt: DesktopPromptContent,
      submit: DesktopSubmitOptions = {}
    ): Promise<boolean> => {
      await service('submitToSession', [sessionId, prompt, submit]);
      return true;
    },
    abortSession: async (sessionId: string, abort: DesktopAbortOptions = {}): Promise<unknown> => {
      // A Stop of a thread that runs no turn is Node's `aborted: false` (abort.mjs:129 `reclaimIdleSubmission`, no submission named).
      const reply = record(
        await service('abortSession', [sessionId, abort]).catch((error: unknown) => {
          if ((error as { detail?: { data?: { reason?: unknown } } } | null)?.detail?.data?.reason === 'turnNotActive')
            return { cancelRequested: false };
          throw error;
        })
      );
      // The core's reply is Node's `createAbortAction` result (abort.mjs:205-218): the hand-back fields ride the reply itself (handle.rs `stop`).
      const restore = reply;
      return {
        aborted: reply.cancelRequested === true,
        restoreText: restore.restoreText || '',
        ...(restore.content ? { content: restore.content } : {}),
        ...(restore.notice ? { notice: restore.notice } : {}),
        pastedImages: restore.pastedImages ?? null,
        pastedTexts: restore.pastedTexts ?? null,
        discardPastedImages: restore.discardPastedImages ?? null,
        discardPastedTexts: restore.discardPastedTexts ?? null,
        restoredSubmissionIds: Array.isArray(restore.restoredSubmissionIds) ? restore.restoredSubmissionIds : [],
        ...(typeof restore.restoreId === 'string' ? { restoreId: restore.restoreId } : {}),
      };
    },
    resolveToolApprovalForSession: async (
      sessionId: string,
      id: string,
      decision: ToolApprovalDecision
    ): Promise<boolean> => {
      const answer = decision as unknown as Record<string, unknown>;
      // remote-session-methods.ts:175-183: a bare Allow of the shown approval that only a click allows (push-notifier.ts approvalPointerOnly).
      if (answer.approved && answer.response === undefined) {
        const shown = await shownApproval(sessionId);
        if (shown?.id === id && approvalAllowIsPointerOnly(shown.approval)) return false;
      }
      return resolveApproval(sessionId, id, answer);
    },
    provideSecretInput: async (requestId: string, value: string): Promise<boolean> => {
      await send({
        method: 'approval/provideSecret',
        params: { requestId, secret: typeof value === 'string' ? value : '' },
      });
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
    readCapabilities: (requests: DesktopCapabilityReadRequest[]): Promise<DesktopCapabilityReadResult[]> =>
      lane.read(requests),
  };
}

export type ChatApi = ReturnType<typeof createChatApi>;

// The phone's thread list (decisions.md, "Phone thread list after a core restart").
// Node's view sync subscribed to the catalog, then listed it, and a roster pushed during that read outranked the listing
// (view-synchronizer.ts readCatalog); the phone replaced its list with that baseline on every attach, a restarted desktop's included.
// On reconnect the same client claims its last folded app position and missed edges replay. Only a snapshot (first attach or
// replay unavailable) needs the list read again, with edges that arrive during the walk laid over it.

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
// Node's catalog order: byActivityThenId (catalog-db/schema.mjs:122 at b6f10295a), activity `lastUsedAt || updatedAt || 0`, ties by id in
// code-unit order; the core's `activityAt` is that activity (thread_edges.rs place_of).
const activityOf = (row: ThreadRow): number => Number(row.activityAt) || Number(row.updatedAt) || 0;
const inCatalogOrder = (a: ThreadRow, b: ThreadRow): number => {
  const byActivity = activityOf(b) - activityOf(a);
  if (byActivity) return byActivity;
  const [idA, idB] = [idOf(a), idOf(b)];
  if (idA < idB) return -1;
  return idA > idB ? 1 : 0;
};

/** The catalog clock's timers (the real ones outside a replay). */
export interface RosterTimers {
  now(): number;
  setTimeout(run: () => void, ms: number): unknown;
}

// Node's catalog clock (session-host-catalog.ts:10-11, 170-180 scheduleCatalogRefresh at b6f10295a): a store change republished the
// catalog after a 400 ms debounce, no sooner than 2 s after the last such refresh; changes meanwhile joined the one pending refresh.
export const STORE_REFRESH_DEBOUNCE_MS = 400;
export const STORE_REFRESH_MIN_GAP_MS = 2_000;
const realTimers: RosterTimers = { now: () => Date.now(), setTimeout: (run, ms) => setTimeout(run, ms) };

export function createRosterFeed<S>(options: {
  /** The sidebar projection of core rows (`summariesOfThreadRows`, main/protocol/thread-rows.ts). */
  summaries(rows: ThreadRow[]): S[];
  /** `ctx.sessionsCatalog`: what `subscribeSessions` listeners hear. */
  publish(rows: S[]): void;
  timers?: RosterTimers;
}) {
  const timers = options.timers ?? realTimers;
  let held = new Map<string, ThreadRow>();
  // What was last published (a refresh that changes nothing is not heard: remote-relay-catalog.ts:79-91 isNoListDelta).
  let shown = '';
  let refreshTimer: unknown = null;
  let refreshedAt = 0;
  const publishHeld = (): void => {
    if (retired || !known) return;
    const rows = project(held.values());
    const key = JSON.stringify(rows);
    if (key === shown) return;
    shown = key;
    options.publish(rows);
  };
  const scheduleRefresh = (): void => {
    if (refreshTimer) return;
    const delay = Math.max(STORE_REFRESH_DEBOUNCE_MS, STORE_REFRESH_MIN_GAP_MS - (timers.now() - refreshedAt));
    const mine = generation;
    refreshTimer = timers.setTimeout(() => {
      refreshTimer = null;
      if (mine !== generation && !known) return;
      refreshedAt = timers.now();
      publishHeld();
    }, delay);
  };
  let known = false;
  // Whether the page was ever handed a whole list by this feed: only before that does it have nothing to lose by a first page.
  let everKnown = false;
  let reading: Promise<S[]> | null = null;
  // The current read's first page (resolved only while the page has no list from this feed, and a later page is still to come).
  let firstPage: Promise<S[]> | null = null;
  // A first page was (or is about to be) handed to a caller: it is handed once, so every other read, a retry after a failed walk
  // included, is answered with a whole list or an error and never with page one again.
  let partialGiven = false;
  // Which listing is the current one: a snapshot (the core says changes were missed) or a reset (another pairing) ends the one before it.
  let generation = 0;
  let retired = false;
  // Edges since the read began (or, before any read, since the feed attached): they outrank the listing.
  const edges = new Map<string, ThreadRow | null>();
  // An archive change whose row the listing has not brought yet.
  const pendingArchive = new Map<string, boolean>();
  const project = (rows: Iterable<ThreadRow>): S[] => options.summaries([...rows].sort(inCatalogOrder));

  const apply = (target: Map<string, ThreadRow>, id: string, row: ThreadRow | null): void => {
    if (row) target.set(id, row);
    else target.delete(id);
  };

  /** `client` is the caller's own (a phone call's request carries that call's claim). */
  const list = (client: Pick<RosterClient, 'call'>, afresh = false): Promise<S[]> => {
    if (retired) return Promise.reject(remoteConnectionInterruptedError());
    if (reading && !afresh) return reading;
    if (afresh) {
      // What was seen before the gap is the new listing's to outrank, not to be laid over it.
      generation += 1;
      edges.clear();
      pendingArchive.clear();
    }
    const mine = generation;
    const superseded = (): Promise<S[]> => {
      if (retired) return Promise.reject(remoteConnectionInterruptedError());
      return (
        reading ??
        (known ? Promise.resolve(project(held.values())) : Promise.reject(remoteConnectionInterruptedError()))
      );
    };
    const first: { show?: (rows: S[]) => void; shown?: boolean } = {};
    firstPage = everKnown ? null : new Promise<S[]>((resolve) => (first.show = resolve));
    const read = (async () => {
      const listed = new Map<string, ThreadRow>();
      for (let cursor: string | undefined; ; ) {
        const page = (await client.call('thread/list', { limit: PAGE_LIMIT, ...(cursor ? { cursor } : {}) })) as {
          data?: ThreadRow[];
          nextCursor?: string;
        };
        if (mine !== generation) return superseded();
        for (const row of page.data ?? []) listed.set(idOf(row), row);
        if (!page.nextCursor) break;
        if (!cursor && first.show) {
          // The edges heard so far outrank the page, as they do the whole listing below.
          const early = new Map(listed);
          for (const [id, row] of edges) apply(early, id, row);
          for (const [id, flag] of pendingArchive) {
            const row = early.get(id);
            if (row && !edges.has(id)) early.set(id, { ...row, archived: flag });
          }
          first.show(project(early.values()));
          first.shown = true;
        }
        cursor = page.nextCursor;
      }
      // The read is over from here: a re-attachment announced after this point starts a read of its own, not this one's answer.
      reading = null;
      for (const [id, row] of edges) apply(listed, id, row);
      for (const [id, flag] of pendingArchive) {
        const row = listed.get(id);
        if (row && !edges.has(id)) listed.set(id, { ...row, archived: flag });
      }
      edges.clear();
      pendingArchive.clear();
      held = listed;
      known = true;
      everKnown = true;
      firstPage = null;
      const rows = project(held.values());
      shown = JSON.stringify(rows);
      options.publish(rows);
      return rows;
    })();
    reading = read;
    const done = (): void => {
      if (reading === read) reading = null;
    };
    read.then(done, () => {
      done();
      // A walk that failed before its first page was shown handed nothing out: the next read may still show one.
      if (!first.shown) partialGiven = false;
    });
    return read;
  };

  // The core announces an archive change by `thread/archived` / `thread/unarchived` alone (thread_edges.rs:12), never as a summary
  // edge, so it is a change of the one row's flag: laid over the held row, or over the row an earlier edge brought.
  const archiveOf =
    (archived: boolean) =>
    (was: ThreadRow | null | undefined): ThreadRow | null | undefined =>
      was ? { ...was, archived } : was;

  const onEdge = (method: string, params: Record<string, unknown>): void => {
    const thread = params.thread as ThreadRow | undefined;
    let flag: boolean | undefined;
    if (method === 'thread/archived') flag = true;
    else if (method === 'thread/unarchived') flag = false;
    const deleted = method === 'thread/deleted';
    let id = '';
    if (deleted || flag !== undefined) id = String(params.threadId ?? '');
    else if (thread) id = idOf(thread);
    if (!id) return;
    const row = deleted ? null : (thread ?? null);
    if (reading || !known) {
      if (flag === undefined) edges.set(id, row);
      else if (edges.has(id)) edges.set(id, archiveOf(flag)(edges.get(id)) ?? null);
      else pendingArchive.set(id, flag);
      return;
    }
    const was = held.get(id);
    const next = flag === undefined ? row : archiveOf(flag)(was);
    if (next === undefined || JSON.stringify(was) === JSON.stringify(next)) return; // CatalogChannel.publish skipped an unchanged roster
    apply(held, id, next);
    scheduleRefresh();
  };

  return {
    list,
    /** `list`, answered with the first page when the page has had no list from this feed yet and more pages follow: the page paints
     *  from it, and the whole list reaches it by `publish` when the read ends. Any other time (a refresh, a reconnect) the answer
     *  is the whole list, since the page treats a catalog it is handed as exact (a session missing from it was deleted). */
    listFirst(client: Pick<RosterClient, 'call'>): Promise<S[]> {
      const whole = list(client);
      if (!firstPage || partialGiven) return whole;
      partialGiven = true;
      // Marked, so the page takes it as rows to add and update and never as the list (shared/session-catalog.ts).
      return Promise.race([whole, firstPage.then(markPartialCatalog)]);
    },
    /** The list the roster holds while it is exact (a read is not under way and every attach has been read); undefined when it must be read. */
    current: (): S[] | undefined => (known && !reading ? project(held.values()) : undefined),
    /** The roster belongs to the client it is attached to: another pairing's client gets none of it. */
    retire(): void {
      retired = true;
      generation += 1;
      held = new Map();
      known = false;
      reading = null;
      firstPage = null;
      shown = '';
      edges.clear();
      pendingArchive.clear();
    },
    /** Node's host republished the catalog itself before answering these calls (session-host-lifecycle.ts:203, 231, 311, 336, 493,
     *  500, 576): the rows held now are published at once, the pending refresh still to come. */
    flush: publishHeld,
    /** Watches one connection's client; `listFor` is the read after its app feed is back (no caller's claim is involved). */
    attach(client: RosterClient): () => void {
      const offEvents = client.on((event) => {
        const n = event.notification;
        if (
          event.type === 'notification' &&
          n &&
          (n.method === 'thread/started' ||
            n.method === 'thread/summary/updated' ||
            n.method === 'thread/deleted' ||
            n.method === 'thread/archived' ||
            n.method === 'thread/unarchived')
        ) {
          onEdge(n.method, (n.params ?? {}) as Record<string, unknown>);
        }
      });
      const offStore = client.store.subscribe((change) => {
        // ppSnapshot names no feed (it is the app feed's own); a subscription change names it.
        if (change.type === 'subscription' && change.feedId !== 'app') return;
        if (change.type === 'subscription' && change.state === 'lost') {
          generation += 1;
          reading = null;
          known = false;
        }
        // A snapshot is the core's answer that it cannot continue the position the list stood at (a restart, a gap, a first attach):
        // the list is read, in pages, and what arrives meanwhile is laid over it. A replay is the changes since, and needs no read.
        else if (change.type === 'appSnapshot') {
          known = false;
          void list(client, true).catch(() => undefined); // a connection that ends mid-read is read again by the next reconnect
        } else if (change.type === 'subscription' && change.state === 'restored' && !known) {
          void list(client).catch(() => undefined);
        }
      });
      return () => {
        offEvents();
        offStore();
      };
    },
  };
}

import type { PhoneProtocolAdapter, PhoneProtocolHost } from './remote-shim-protocol';

/** How long a fresh recovery waits for a thread this client does not yet fold. */
const FRESH_FOLD_WAIT_MS = 3000;

const CHAT_CALLS = [
  'abortSession',
  'agentRoomAction',
  'cancelQuotaResume',
  'continueSessionInModel',
  'deleteSession',
  'getQuotaAutoResume',
  'getTaskWorkspace',
  'inheritSession',
  'listProviderModels',
  'markSessionRead',
  'openAgentHome',
  'prefetchSession',
  'provideSecretInput',
  'readCapabilities',
  'readTranscriptHistory',
  'readTranscriptItem',
  'releaseShellJob',
  'renameSession',
  'resetAgentHome',
  'resolveToolApprovalForSession',
  'scheduleQuotaResume',
  'searchSessionContent',
  'setModelRoute',
  'setQuotaAutoResume',
  'setSessionArchived',
  'setSessionFavorite',
  'setSessionProject',
  'startProject',
  'startProjectTask',
  'startTask',
  'stopShellJob',
  'submitNewTask',
  'submitToSession',
  'viewerDevice',
  'setFast',
] as const satisfies ReadonlyArray<keyof ChatApi>;
/** The calls Node's host answered after republishing the catalog itself (session-host-lifecycle.ts at b6f10295a: markSessionRead 203,
 *  renameSession 231, setSessionFavorite 311, setSessionProject 336, setSessionArchived 493/500, deleteSession 576). */
const CATALOG_PUBLISHING_CALLS = [
  'markSessionRead',
  'renameSession',
  'setSessionFavorite',
  'setSessionProject',
  'setSessionArchived',
  'deleteSession',
] as const satisfies ReadonlyArray<(typeof CHAT_CALLS)[number]>;
/** The calls whose answer Node's host also published as its shell snapshot (session-host-lifecycle.ts:170-190). */
const SHELL_PUBLISHING_CALLS = ['startProject', 'startProjectTask', 'startTask'] as const satisfies ReadonlyArray<
  (typeof CHAT_CALLS)[number]
>;

/** `sharedFor` and the api are made PER CALL from `host.client()`: that client carries this call's transmission claim
 *  (phone-send-scope.ts), so a request written through anything built from it is claimed; one captured at start would not be. */
/** The calls are the host's (remote-chat-host.ts `createChatHostApi`) over the base api: the start calls, the snapshot's remote
 *  fields, paging, the stale-view refusal and the refusal texts Node's host answered the phone with. */
export function createChatAdapter(options: {
  sharedFor(client: ChatClient): ChatHostShared;
  /** The `hostState` value of key `remoteSession` this client holds (remote-chat-host.ts `ChatHostOptions`). */
  remoteSession(client: ChatClient): unknown;
  roster: { summaries(rows: ThreadRow[]): unknown[]; timers?: RosterTimers };
}): PhoneProtocolAdapter {
  // One roster feed per page context: a feed publishes into the catalog of the page it was made for, so a second page served by this
  // adapter (another phone, or a page made again after a core restarted) gets its own and not the first page's.
  const feeds = new WeakMap<object, ReturnType<typeof createRosterFeed>>();
  const feedFor = (host: PhoneProtocolHost) => {
    let feed = feeds.get(host.ctx);
    if (!feed) {
      feed = createRosterFeed({
        summaries: options.roster.summaries,
        publish: (rows) => host.ctx.sessionsCatalog.publish(rows as never),
        ...(options.roster.timers ? { timers: options.roster.timers } : {}),
      });
      feeds.set(host.ctx, feed);
    }
    return feed;
  };
  const api = (host: PhoneProtocolHost) => {
    const client = host.client() as unknown as ChatClient;
    const shared = options.sharedFor(client);
    const base = createChatApi(client, shared);
    return createChatHostApi(client, shared, base, { remoteSession: () => options.remoteSession(client) });
  };
  const calls: Record<string, (params: unknown[], host: PhoneProtocolHost) => unknown> = {};
  for (const name of CHAT_CALLS) {
    calls[name] = (params, host) => (api(host)[name] as (...args: unknown[]) => unknown)(...params);
  }
  // The core sends these calls' row edges before it answers (thread_settings.rs); Node's host published them before answering.
  for (const name of CATALOG_PUBLISHING_CALLS) {
    calls[name] = async (params, host) => {
      const feed = feedFor(host);
      const answer = await (api(host)[name] as (...args: unknown[]) => unknown)(...params);
      feed.flush();
      return answer;
    };
  }
  // `getSnapshot` is Node's host shell snapshot (session-host.ts:436 `publication.shellSnapshot`): null until a start call published
  // one (session-host-lifecycle.ts:170-190 `publishShell`), then the latest start's blank snapshot, its remote fields as the remote
  // channel stands now (session-host-publication.ts:281-301). The shell is this page's: a start made in the desktop window is not seen.
  const shells = new WeakMap<object, SessionSnapshot>();
  for (const name of SHELL_PUBLISHING_CALLS) {
    calls[name] = async (params, host) => {
      const snapshot = (await (api(host)[name] as (...args: unknown[]) => Promise<SessionSnapshot>)(
        ...params
      )) as SessionSnapshot;
      shells.set(host.ctx, snapshot);
      return snapshot;
    };
  }
  calls.getSnapshot = (_params, host) => {
    const held = shells.get(host.ctx);
    return held
      ? withRemoteSession(held, remoteSessionIdOf(options.remoteSession(host.client() as unknown as ChatClient)))
      : null;
  };
  /** A thread's state as the page is shown it (Node's host pushed it as a `sessionState` frame, remote-shim-dispatch.ts at v1.4.5),
   *  with the remote channel's session as this client holds it now. */
  const decorated = (client: ChatClient, state: unknown): SessionSnapshot =>
    // The core sends tool results whole; the page is shown them capped (main/remote-transcript.ts). The fold itself stays whole,
    // which is where `readTranscriptItem` reads "show full output" from.
    withRemoteSession(
      remoteTranscriptSnapshot(state),
      remoteSessionIdOf(options.remoteSession(client))
    ) as unknown as SessionSnapshot;
  /** The page's follower of its current client's threads (remote-session-states.ts), per page: the page's sessions are these
   *  states (session-lane-store.ts). A page whose host hands it no client (`onClient`) has none. */
  const followers = new WeakMap<object, SessionStateFollower>();
  const followerOf = (host: PhoneProtocolHost): SessionStateFollower | undefined => followers.get(host.ctx);
  const deleteSession = calls.deleteSession!;
  // A deleted thread is gone for the page too (Node's host ended its lane with `laneEnd: 'gone'`). The answer is the client's that
  // sent the delete: it ends that client's lane, and nothing if that client was replaced meanwhile (its follower is stopped).
  calls.deleteSession = async (params, host) => {
    const follower = followerOf(host);
    const answer = await deleteSession(params, host);
    follower?.gone(String(params[0] ?? ''));
    return answer;
  };
  // A refused approval answer: the page's session state is projected anew from this client's own fold (its current pending
  // list) and published to the page, whatever the feed replays (a same-window resume at the cursor replays nothing). A thread
  // this client does not fold gets one bounded resume; no fold, nothing is published and the card stays retryable. One publication
  // per baseline: a held fold has nothing new for the feed to publish, so it is published here; a resumed one arrives as a first
  // fold, which the follower publishes.
  calls.refreshSessionState = async (params, host) => {
    const sessionId = String(params[0] ?? '');
    const client = host.client() as unknown as ChatClient;
    const shared = options.sharedFor(client);
    const follower = followerOf(host);
    const held = shared.sessionStateOf(sessionId);
    if (held) {
      if (follower) return follower.republish(sessionId);
      host.ctx.sessionInbox.publish({ sessionId, snapshot: decorated(client, held), frameSource: 'live' });
      return true;
    }
    const [resume] = shared.routeService('prefetchSession', [sessionId]).requests;
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      shared
        .whenFolded(sessionId, () => client.resumeThread(sessionId, resume?.params.window, { force: true }))
        .catch(() => undefined),
      new Promise<void>((resolve) => (timer = setTimeout(resolve, FRESH_FOLD_WAIT_MS))),
    ]);
    clearTimeout(timer);
    const state = shared.sessionStateOf(sessionId);
    if (!state) return false;
    if (!follower)
      host.ctx.sessionInbox.publish({ sessionId, snapshot: decorated(client, state), frameSource: 'live' });
    return true;
  };
  calls.listSessions = (_params, host) => {
    const feed = feedFor(host);
    return feed.current() ?? feed.listFirst(host.client() as unknown as RosterClient);
  };
  calls.sessionStreamPosition = (params, host) =>
    (host.client() as unknown as ProtocolClient<SessionFold>).feedPosition(String(params[0] ?? '')) ?? null;
  return {
    group: 'chat',
    calls,
    install(host) {
      let off: (() => void) | undefined;
      let stopped = false;
      // The roster is one client's: a client that replaces it (a re-pairing in the same page) starts from nothing.
      const retire = (): void => {
        off?.();
        off = undefined;
        feeds.get(host.ctx)?.retire();
        feeds.delete(host.ctx);
        followers.get(host.ctx)?.stop();
        followers.delete(host.ctx);
        shells.delete(host.ctx);
      };
      const offReset = host.onPairingReset?.(retire);
      if (!host.onClient) {
        void host.ctx.phone.start().then(() => {
          if (!stopped) off = feedFor(host).attach(host.client() as unknown as RosterClient);
        });
      }
      // Each client the page is handed replaces the one before: the old one's follower stops before the new one starts.
      const offClients = host.onClient?.((client) => {
        if (stopped) return;
        retire();
        off = feedFor(host).attach(client as unknown as RosterClient);
        const chat = client as unknown as ChatClient;
        const follower = followSessionStates(client, {
          publish: (update) => host.ctx.sessionInbox.publish(update),
          decorate: (state) => decorated(chat, state),
          stateOf: (threadId) => sessionStateOf(client, threadId),
        });
        followers.set(host.ctx, follower);
      });
      // The page's view settled (remote-shim-api.ts `setVisibleSessions`): the threads it let go of end as unloaded. Only a page
      // that is handed its clients has a follower, and a view.
      const sweep = (): void => followerOf(host)?.sweep();
      if (offClients) host.ctx.viewSettledListeners.add(sweep);
      return () => {
        stopped = true;
        retire();
        offReset?.();
        offClients?.();
        if (offClients) host.ctx.viewSettledListeners.delete(sweep);
        followers.get(host.ctx)?.stop();
        followers.delete(host.ctx);
      };
    },
  };
}

const connectionStatus = (client: ProtocolClient<SessionFold>): DesktopSectionsSnapshot['status'] => {
  const { state } = client.status;
  if (state === 'ready' || state === 'closed') return state;
  return 'reconnecting';
};

/** The desktop's capability lane (main/protocol/capability-route.ts) over this phone's client: the same conversions, the same
 *  core replies, with `client` being the one call's scoped client. The desktop's own session lane (main/protocol/session-lane.ts)
 *  builds the same over its connection's client. The lane is made per call, so a call that names no session is sent to the
 *  connection's one control thread (`callSharingControlThread`), as Node's host sent every phone call to its one control session. */
export const sharedFor = (scoped: ChatClient): ChatHostShared => {
  const client = scoped as unknown as ProtocolClient<SessionFold>;
  const lane = createCapabilityLane({
    protocol: {
      call: callSharingControlThread(client),
      snapshot: () => ({
        status: connectionStatus(client),
        entries: SECTION_NAMES.flatMap((name) => [...client.store.sections(name)]),
      }),
      // `client/activity` is the desktop window's rate-limited presence ping; Node's phone never sent one.
      noteUserInput: () => undefined,
      respond: (id, answer) => client.respond(id as never, answer as never),
      pendingServerRequests: () => client.pendingServerRequests(),
    },
  });
  return {
    routeService,
    sendTransfer: (method, params) => phoneTransferCall(client, method, params),
    lane,
    coreErrorForWindow,
    normalizedProviderModels,
    sessionStateOf: (threadId) => sessionStateOf(client, threadId) as unknown as SessionSnapshot | undefined,
    whenFolded: async (threadId, resume) => {
      let off = (): void => undefined;
      // Listened for before the subscription is asked for, so a fold that lands with its reply is not missed.
      const folded = new Promise<void>((resolve) => {
        off = client.store.subscribe((change) => {
          if (change.type === 'thread' && change.threadId === threadId) resolve();
        });
      });
      try {
        await resume();
        await folded;
      } finally {
        off();
      }
    },
    whenSettled: (id) =>
      new Promise<void>((resolve) => {
        const pending = () => client.pendingServerRequests().some((asked) => String(asked.id) === id);
        if (!pending()) return resolve();
        const off = client.on((event) => {
          if (event.type !== 'serverRequestResolved' && event.type !== 'status') return;
          if (pending()) return;
          off();
          resolve();
        });
      }),
    approvalRequestId: (cardId) => {
      const asked = client.pendingServerRequests().find((r) => {
        const card = (r.params as { card?: { id?: unknown } } | undefined)?.card;
        return card?.id === cardId;
      });
      return asked ? String(asked.id) : cardId;
    },
    transcript: foldTranscript(client),
    // The client's own fold of thread items into transcript rows (`rowsOf`: a row and the compaction dividers after it, then `mergeToolRows`).
    foldRows: (items) => mergeToolRows(items.flatMap((item) => rowsOf(item as never))),
  };
};

/** The transcript this page shows: its own fold of the thread (`sessionStateOf`), whole within the thread's `thread/resume` window. A
 *  page grows that window (Node's `prefetchSession` limit); a tool row's whole output is read from the fold (`remoteToolOutput`). */
export const foldTranscript = (client: Pick<ChatClient, 'resumeThread'>): ChatShared['transcript'] => ({
  page: async (threadId, _state, limit) => {
    const [resume] = routeService('prefetchSession', [threadId, limit]).requests;
    await client.resumeThread(threadId, resume?.params.window);
  },
  output: (_threadId, state, itemId) => remoteToolOutput(state, itemId),
});

/** The core's `hostState` key `remoteSession` as this client's section store holds it. */
export const remoteSession = (scoped: ChatClient): unknown =>
  (scoped as unknown as ProtocolClient<SessionFold>).store.section('hostState', 'remoteSession')?.value;

/** The phone's chat adapter; `timers` is the catalog clock (a replay's own; the real one otherwise). */
export const phoneChatAdapter = (timers?: RosterTimers): PhoneProtocolAdapter =>
  createChatAdapter({
    sharedFor,
    remoteSession,
    roster: { summaries: summariesOfThreadRows, ...(timers ? { timers } : {}) },
  });

export const adapter: PhoneProtocolAdapter = phoneChatAdapter();
