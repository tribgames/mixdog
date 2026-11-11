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
import { SECTION_NAMES, type DesktopSectionsSnapshot } from '../shared/contract-sections';
import type { ProtocolClient, SessionFold } from '../../../../packages/protocol-client/src/index.ts';
import { mergeToolRows, rowOf, sessionStateOf } from '../../../../packages/protocol-client/src/index.ts';
import { createChatHostApi, READ_NOT_HELD, READ_NOT_VIEWED, type ChatHostShared } from './remote-chat-host';
import { createCapabilityLane } from '../main/protocol/capability-route';
import { coreErrorForWindow } from '../main/protocol/core-error';
import { routeService } from '../main/protocol/service-route';
import { summariesOfThreadRows } from '../main/protocol/thread-rows';
import { remoteToolOutput } from '../main/remote-transcript';
import { approvalAllowIsPointerOnly, approvalAllowOnceDecision } from '../shared/approval-enter-rule';
import { normalizedProviderModels } from '../shared/desktop-transcript-limits';

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
  /** Runs `resume` (the thread's subscription) and resolves once the client has folded the thread's snapshot: the client folds a
   *  snapshot in budgeted steps after the subscription's reply (client.ts `fold`), so the reply alone leaves no fold to read. */
  whenFolded(threadId: string, resume: () => Promise<unknown>): Promise<void>;
  /** Resolves once the core no longer asks request `id` of this connection (`serverRequest/resolved`, or the socket's end). */
  whenSettled(id: string): Promise<void>;
  /** The pending server request whose card shows `cardId`; an id no card shows is passed on as it is. */
  approvalRequestId(cardId: string): string;
  /** `remoteToolOutput` (main/remote-transcript.ts) over a folded state. */
  remoteToolOutput(
    state: unknown,
    itemId: string
  ): { id: string; result?: unknown; rawResult?: unknown; uiDiff?: unknown } | null;
}

export type ApprovalNotificationAnswer = 'answered' | 'settled' | 'open';


const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

export function createChatApi(client: ChatClient, shared: ChatShared) {
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
    await shared.whenFolded(threadId, () => client.resumeThread(threadId, resume?.params.window));
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
  const resolveApproval = async (sessionId: string, cardId: string, decision: Record<string, unknown>): Promise<boolean> => {
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
  const shownApproval = async (sessionId: string): Promise<{ id: string; approval: Record<string, unknown> } | null> => {
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
      // Node answers the session's projection (session-host-lifecycle.ts:938 applySessionResult), not the published state the host
      // decorates with its shell jobs (session-host.ts snapshotWithShellJobs).
      const { shellJobs: _shellJobs, hostShellJobs: _hostShellJobs, ...snapshot } = (await snapshotOf(sessionId)) as Record<string, unknown>;
      return { accepted: true, sessionId, snapshot } as unknown as DesktopNewTaskSubmitResult;
    },
    submitToSession: async (sessionId: string, prompt: DesktopPromptContent, submit: DesktopSubmitOptions = {}): Promise<boolean> => {
      await service('submitToSession', [sessionId, prompt, submit]);
      return true;
    },
    abortSession: async (sessionId: string, abort: DesktopAbortOptions = {}): Promise<unknown> => {
      // A Stop of a thread that runs no turn is Node's `aborted: false` (abort.mjs:129 `reclaimIdleSubmission`, no submission named).
      const reply = record(
        await service('abortSession', [sessionId, abort]).catch((error: unknown) => {
          if ((error as { detail?: { data?: { reason?: unknown } } } | null)?.detail?.data?.reason === 'turnNotActive') return { cancelRequested: false };
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
      };
    },
    resolveToolApprovalForSession: async (sessionId: string, id: string, decision: ToolApprovalDecision): Promise<boolean> => {
      const answer = decision as unknown as Record<string, unknown>;
      // remote-session-methods.ts:175-183: a bare Allow of the shown approval that only a click allows (push-notifier.ts approvalPointerOnly).
      if (answer.approved && answer.response === undefined) {
        const shown = await shownApproval(sessionId);
        if (shown?.id === id && approvalAllowIsPointerOnly(shown.approval)) return false;
      }
      return resolveApproval(sessionId, id, answer);
    },
    // remote-session-methods.ts:199-213: Deny answers as the card's 거절; Allow answers with the decision the card's 한 번만 허용 sends,
    // and only for the approval the session shows now where a bare Enter allows it once (push-notifier.ts approvalAllowDecision);
    // any other Allow is 'open'.
    answerApprovalNotification: async (sessionId: string, id: string, action: 'allow' | 'deny'): Promise<ApprovalNotificationAnswer> => {
      if (action !== 'allow' && action !== 'deny') throw new TypeError('action must be allow or deny.');
      const shown = await shownApproval(sessionId);
      const decision = action === 'allow' ? (shown?.id === id ? approvalAllowOnceDecision(shown.approval) : null) : { approved: false };
      if (!decision) return 'open';
      return (await resolveApproval(sessionId, id, decision as unknown as Record<string, unknown>)) ? 'answered' : 'settled';
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
// Node's catalog order: byActivityThenId (catalog-db/schema.mjs:122 at b6f10295a), activity `lastUsedAt || updatedAt || 0`, ties by id in
// code-unit order; the core's `activityAt` is that activity (thread_edges.rs place_of).
const activityOf = (row: ThreadRow): number => Number(row.activityAt) || Number(row.updatedAt) || 0;
const inCatalogOrder = (a: ThreadRow, b: ThreadRow): number =>
  activityOf(b) - activityOf(a) || (idOf(a) < idOf(b) ? -1 : idOf(a) > idOf(b) ? 1 : 0);

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
    const rows = project(held.values());
    const key = JSON.stringify(rows);
    if (key === shown) return;
    shown = key;
    options.publish(rows);
  };
  const scheduleRefresh = (): void => {
    if (refreshTimer) return;
    const delay = Math.max(STORE_REFRESH_DEBOUNCE_MS, STORE_REFRESH_MIN_GAP_MS - (timers.now() - refreshedAt));
    refreshTimer = timers.setTimeout(() => {
      refreshTimer = null;
      refreshedAt = timers.now();
      publishHeld();
    }, delay);
  };
  let known = false;
  let reading: Promise<S[]> | null = null;
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
      const rows = project(held.values());
      shown = JSON.stringify(rows);
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

  // The core announces an archive change by `thread/archived` / `thread/unarchived` alone (thread_edges.rs:12), never as a summary
  // edge, so it is a change of the one row's flag: laid over the held row, or over the row an earlier edge brought.
  const archiveOf = (archived: boolean) => (was: ThreadRow | null | undefined): ThreadRow | null | undefined => (was ? { ...was, archived } : was);

  const onEdge = (method: string, params: Record<string, unknown>): void => {
    const thread = params.thread as ThreadRow | undefined;
    const flag = method === 'thread/archived' ? true : method === 'thread/unarchived' ? false : undefined;
    const id = method === 'thread/deleted' || flag !== undefined ? String(params.threadId ?? '') : thread ? idOf(thread) : '';
    if (!id) return;
    const row = method === 'thread/deleted' ? null : thread ? (thread as ThreadRow) : null;
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
    /** Node's host republished the catalog itself before answering these calls (session-host-lifecycle.ts:203, 231, 311, 336, 493,
     *  500, 576): the rows held now are published at once, the pending refresh still to come. */
    flush: publishHeld,
    /** Watches one connection's client; `listFor` is the read after its app feed is back (no caller's claim is involved). */
    attach(client: RosterClient): () => void {
      const offEvents = client.on((event) => {
        const n = event.notification;
        if (event.type === 'notification' && n && (n.method === 'thread/started' || n.method === 'thread/summary/updated' || n.method === 'thread/deleted' || n.method === 'thread/archived' || n.method === 'thread/unarchived')) {
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
/** The calls Node's host answered after republishing the catalog itself (session-host-lifecycle.ts at b6f10295a: markSessionRead 203,
 *  renameSession 231, setSessionFavorite 311, setSessionProject 336, setSessionArchived 493/500, deleteSession 576). */
const CATALOG_PUBLISHING_CALLS = [
  'markSessionRead', 'renameSession', 'setSessionFavorite', 'setSessionProject', 'setSessionArchived', 'deleteSession',
] as const satisfies ReadonlyArray<(typeof CHAT_CALLS)[number]>;

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
      const answer = await (api(host)[name] as (...args: unknown[]) => unknown)(...params);
      feedFor(host).flush();
      return answer;
    };
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

// ── The adapter the phone's switch point finds (remote-shim-adapters.ts) ─────────────────────────────────────────────────────────────
const connectionStatus = (client: ProtocolClient<SessionFold>): DesktopSectionsSnapshot['status'] => {
  const state = client.status.state;
  return state === 'ready' ? 'ready' : state === 'closed' ? 'closed' : 'reconnecting';
};

/** The desktop's capability lane (main/protocol/capability-route.ts) over this phone's client: the same conversions, the same
 *  core replies, with `client` being the one call's scoped client. */
const sharedFor = (scoped: ChatClient): ChatHostShared => {
  const client = scoped as unknown as ProtocolClient<SessionFold>;
  const lane = createCapabilityLane({
    protocol: {
      call: (method, params) => client.call(method as never, params as never) as Promise<unknown>,
      snapshot: () => ({ status: connectionStatus(client), entries: SECTION_NAMES.flatMap((name) => [...client.store.sections(name)]) }),
      // `client/activity` is the desktop window's rate-limited presence ping; Node's phone never sent one.
      noteUserInput: () => undefined,
      respond: (id, answer) => client.respond(id as never, answer as never),
      pendingServerRequests: () => client.pendingServerRequests(),
    },
  });
  return {
    routeService,
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
    remoteToolOutput,
    // The client's own fold of thread items into transcript rows (`rowOf`, then `mergeToolRows`).
    foldRows: (items) => mergeToolRows(items.map((item) => rowOf(item as never)).filter((row) => row !== null)),
  };
};

/** The core's `hostState` key `remoteSession` as this client's section store holds it. */
const remoteSession = (scoped: ChatClient): unknown =>
  (scoped as unknown as ProtocolClient<SessionFold>).store.section('hostState', 'remoteSession')?.value;

/** The phone's chat adapter; `timers` is the catalog clock (a replay's own; the real one otherwise). */
export const phoneChatAdapter = (timers?: RosterTimers): PhoneProtocolAdapter =>
  createChatAdapter({ sharedFor, remoteSession, roster: { summaries: summariesOfThreadRows, ...(timers ? { timers } : {}) } });

export const adapter: PhoneProtocolAdapter = phoneChatAdapter();
