import type {
  DesktopAbortOptions,
  DesktopTurnTakeover,
  DesktopTurnTakeoverReceipt,
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
  DesktopRewindTarget,
  DesktopTranscriptHistoryPage,
  DesktopTranscriptHistoryRequest,
  DesktopTranscriptMove,
  SessionSnapshot,
  ToolApprovalDecision,
} from '../shared/contract';
import { SECTION_NAMES, type DesktopSectionsSnapshot } from '../shared/contract-sections';
import type { ProtocolClient, SessionFold } from '../../../../packages/protocol-client/src/index.ts';
import {
  mergeToolRows,
  moveTranscriptWindow,
  rowsOf,
  sessionStateOf,
} from '../../../../packages/protocol-client/src/index.ts';
import { createChatHostApi, READ_NOT_HELD, READ_NOT_VIEWED, type ChatHostShared } from './remote-chat-host';
import { callSharingControlThread } from './remote-capability-lane';
import { followSessionStates, type SessionStateFollower } from './remote-session-states';
import { phoneTransferCall } from './remote-transfer-call';
import { remoteSessionIdOf, withRemoteSession } from '../shared/blank-snapshot.ts';
import { createCapabilityLane } from '../main/protocol/capability-route';
import { coreErrorForWindow } from '../main/protocol/core-error';
import { routeService } from '../main/protocol/service-route';
import { reissuedOnceIfNotApplied } from '../shared/outcome-unknown';
import { summariesOfThreadRows } from '../main/protocol/thread-rows';
import { findToolRecord, remoteToolOutput, remoteTranscriptSnapshot } from '../main/remote-transcript';
import { approvalAllowIsPointerOnly } from '../shared/approval-enter-rule';
import { normalizedProviderModels } from '../shared/desktop-transcript-limits';
import { outputCutByCore, readWholeToolOutput, type WholeOutputReader } from './remote-item-output';
import { record } from './record-utils';
import { createRosterFeed, type RosterTimers, type ThreadRow } from './remote-roster-feed';
import type { PhoneProtocolAdapter, PhoneProtocolHost } from './remote-shim-protocol';

/** The part of `ProtocolClient` (packages/protocol-client) this adapter uses. */
export interface ChatClient {
  call(method: string, params: unknown): Promise<unknown>;
  /** `join`: a resume of the thread the client already has in flight (its snapshot not folded yet) answers this one; none is sent. */
  resumeThread(
    threadId: string,
    window: unknown,
    options?: { readonly join?: boolean; readonly force?: boolean }
  ): Promise<unknown>;
  /** The user's retry: the thread is let go and opened anew, joining nothing that is out. */
  reopenThread(threadId: string, window: unknown): Promise<unknown>;
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
  invokeValue(capability: string, args: unknown[], sessionId: string | undefined): Promise<{ value: unknown }>;
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
  /** The window a positioned thread's subscription holds follows the reader (protocol-client `moveTranscriptWindow`). */
  moveWindow(threadId: string, move: DesktopTranscriptMove): Promise<boolean>;
  /** The phone's transcript window (main/remote-phone-transcript.ts `createPhoneTranscript`, kept out of this bundle's imports as
   *  main code): the states the phone is shown pass through its `view`. */
  transcript: {
    /** False when nothing older could join the window. */
    page(threadId: string, state: unknown, limit: number): Promise<boolean>;
    output(
      threadId: string,
      state: unknown,
      itemId: string
    ): { id: string; result?: unknown; rawResult?: unknown; uiDiff?: unknown } | null;
  };
}

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
    (await lane.invokeValue(capability, args, sessionId)).value === true;

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
  /** The core hands a pending request only to a connection that follows its thread (outgoing.rs `deliver`), so the thread is followed first. */
  const shownApproval = async (
    sessionId: string
  ): Promise<{ id: string; approval: Record<string, unknown> } | null> => {
    const approval = (await snapshotOf(sessionId))?.toolApproval as unknown;
    if (!approval || typeof approval !== 'object' || record(approval).kind === 'question') return null;
    return { id: String(record(approval).id ?? 'pending'), approval: record(approval) };
  };

  return {
    viewerDevice: async (): Promise<string> => client.server.connection?.device || 'Web app',
    // The rows of a pool the core publishes as a count-only stub (agent-activity-model.ts `startAgentPool`).
    listAgentPool: (): Promise<unknown> => service('listAgentPool', []),
    markSessionRead: async (sessionId: string, messageCount: number, consumedUnread = false): Promise<boolean> =>
      (await service('markSessionRead', [sessionId, messageCount, consumedUnread])) === true,
    searchSessionContent: async (query: string): Promise<DesktopSessionContentMatch[]> => {
      const hits = await service('searchSessionContent', [query]);
      return Array.isArray(hits)
        ? hits.map(({ sessionId, snippet, rank, position }) => ({
            sessionId,
            snippet,
            rank,
            ...(typeof position === 'string' && position ? { position } : {}),
          }))
        : [];
    },
    moveTranscriptWindow: (sessionId: string, move: DesktopTranscriptMove): Promise<boolean> =>
      shared.moveWindow(sessionId, move),
    listRewindTargets: async (
      sessionId: string,
      options: { cursor?: string; limit?: number } = {}
    ): Promise<{ data: DesktopRewindTarget[]; nextCursor?: string }> => {
      const page = record(
        await send({
          method: 'thread/rewindTargets/list',
          params: {
            threadId: sessionId,
            ...(options.cursor ? { cursor: options.cursor } : {}),
            ...(options.limit ? { limit: options.limit } : {}),
          },
        })
      );
      const data = Array.isArray(page.data) ? (page.data as DesktopRewindTarget[]) : [];
      return { data, ...(typeof page.nextCursor === 'string' ? { nextCursor: page.nextCursor } : {}) };
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
      // The core sent this row's output cut to what the phone shows: the rest is read from the core, now that it is asked for.
      if (!outputCutByCore(state, itemId)) return output;
      const coreItemId = findToolRecord(state, itemId)?.coreItemId;
      return (
        (await readWholeToolOutput(
          client as WholeOutputReader,
          sessionId,
          itemId,
          typeof coreItemId === 'string' ? coreItemId : itemId
        )) ?? output
      );
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
      _readTraceId?: string,
      options?: { readonly retry?: boolean }
    ): Promise<boolean> => {
      const retry = options?.retry === true;
      // A thread the phone follows pages its own window (Node: requestPhoneTranscriptPage); one it does not is resumed.
      const state = shared.sessionStateOf(sessionId);
      if (state && !retry) {
        // A read that names no rows is of the state, which is held: nothing is asked of the core. Older history is the
        // pane's own page request (use-transcript-history.ts), which names its rows.
        if (typeof transcriptItemLimit !== 'number') return true;
        return shared.transcript.page(sessionId, state, transcriptItemLimit);
      }
      const [resume] = shared.routeService('prefetchSession', [sessionId, transcriptItemLimit]).requests;
      // The user's Retry is an open of its own: an attach that never arrived is not joined again.
      if (retry) await client.reopenThread(sessionId, resume?.params.window);
      else await client.resumeThread(sessionId, resume?.params.window, { join: true });
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
      const started = record(await reissuedOnceIfNotApplied(() => service('submitNewTask', [prompt, submit, draft])));
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
      await reissuedOnceIfNotApplied(() => service('submitToSession', [sessionId, prompt, submit]));
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
      return {
        aborted: reply.cancelRequested === true,
        restoreText: reply.restoreText || '',
        ...(reply.content ? { content: reply.content } : {}),
        ...(reply.notice ? { notice: reply.notice } : {}),
        pastedImages: reply.pastedImages ?? null,
        pastedTexts: reply.pastedTexts ?? null,
        discardPastedImages: reply.discardPastedImages ?? null,
        discardPastedTexts: reply.discardPastedTexts ?? null,
        restoredSubmissionIds: Array.isArray(reply.restoredSubmissionIds) ? reply.restoredSubmissionIds : [],
        ...(typeof reply.restoreId === 'string' ? { restoreId: reply.restoreId } : {}),
      };
    },
    // One request: the connection itself sends a lost reply's request again under the press's `opId`.
    takeOverTurn: (sessionId: string, takeover: DesktopTurnTakeover): Promise<DesktopTurnTakeoverReceipt> =>
      service('takeOverTurn', [sessionId, takeover]) as Promise<DesktopTurnTakeoverReceipt>,
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

export {
  createRosterFeed,
  STORE_REFRESH_DEBOUNCE_MS,
  STORE_REFRESH_MIN_GAP_MS,
  type RosterClient,
  type RosterTimers,
} from './remote-roster-feed';

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
  'listAgentPool',
  'listProviderModels',
  'listRewindTargets',
  'markSessionRead',
  'moveTranscriptWindow',
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
  'takeOverTurn',
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
    const client = host.client();
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
    return held ? withRemoteSession(held, remoteSessionIdOf(options.remoteSession(host.client()))) : null;
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
    const client: ChatClient = host.client();
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
    return feed.current() ?? feed.listFirst(host.client());
  };
  calls.sessionStreamPosition = (params, host) => host.client().feedPosition(String(params[0] ?? '')) ?? null;
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
          if (!stopped) off = feedFor(host).attach(host.client());
        });
      }
      // Each client the page is handed replaces the one before: the old one's follower stops before the new one starts.
      const offClients = host.onClient?.((client) => {
        if (stopped) return;
        retire();
        off = feedFor(host).attach(client);
        const chat: ChatClient = client;
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
    moveWindow: (threadId, move) => moveTranscriptWindow(client, threadId, move),
    // The client's own fold of thread items into transcript rows (`rowsOf`: a row and the compaction dividers after it, then `mergeToolRows`).
    foldRows: (items) => mergeToolRows(items.flatMap((item) => rowsOf(item as never))),
  };
};

type FoldClient = Pick<ProtocolClient<SessionFold>, 'resumeThread' | 'store'>;

/** The page still on its way from a fold, by the fold's `origin` (one per snapshot): it goes with the fold. */
const pagesOut = new WeakMap<object, Promise<boolean>>();

/** The folds a page's own snapshot brought with fewer core items than the page asked for, by `origin` (it goes with the fold):
 *  the core's view of the thread ends where such a fold begins. Only `pageLanded` adds one, for a caller that names what was
 *  asked. */
const cameShort = new WeakSet<object>();

/** The window, in core items, a page of `limit` rows asks of a fold that shows `shown` rows: the rows asked beyond those shown, past
 *  the items the fold holds (`SessionFold.coreItems`: a reasoning item folds to no row, a run of tool calls to one card). 0: the
 *  fold answers as it is, holding the thread's start or showing that many rows already; there is nothing to ask the core. null:
 *  nothing older can join it (`cameShort`); older rows are read by position. */
export function pageWindow(fold: SessionFold, shown: number, limit: number): number | null {
  if (limit <= shown || fold.history !== 'older') return 0;
  if (fold.origin && cameShort.has(fold.origin)) return null;
  return (fold.coreItems?.length ?? 0) + limit - shown;
}

/** Whether `after` holds history older than `before` did: the item `before`'s window began at lies inside `after`'s, past its
 *  first, or `after` holds the thread's start. Read from the two folds alone: a window that moved toward newer history, was cut
 *  back, or belongs to the thread opened again is no page.
 *
 *  `asked` is the window the page asked for, and is given only by a caller for which `after` is the fold that page's own snapshot
 *  brought, as it was folded: such a fold holding fewer items is where the core's view ends (`cameShort`). A caller that cannot
 *  tell its snapshot from another fold of the thread gives none. */
export function pageLanded(before: SessionFold, after: SessionFold | undefined, asked?: number): boolean {
  if (!after) return false;
  if (asked !== undefined && after.origin && after.origin !== before.origin && (after.coreItems?.length ?? 0) < asked)
    cameShort.add(after.origin);
  if (after.history !== 'older') return true;
  const start = before.coreItems?.[0];
  // A window that held nothing (a rewind above it took all it had) gains history with any item.
  if (start === undefined) return (after.coreItems?.length ?? 0) > 0;
  return (after.coreItems?.indexOf(start) ?? -1) > 0;
}

/** The fold's window grown to `items` core items; false when nothing older joined it.
 *
 *  The page belongs to `fold`: it ends at the first change of the store that finds another fold of the thread there (the page's
 *  snapshot, or one of the thread opened again) or none (the thread let go, or lost), and what it answers is read from the fold
 *  found then. The client names no subscription, so that fold is not known to be the page's own snapshot: nothing is recorded
 *  about it (`pageLanded` without `asked`), and a view that ended is found by the page that brings no older item. */
async function growFold(client: FoldClient, threadId: string, fold: SessionFold, items: number) {
  const [resume] = routeService('prefetchSession', [threadId, items]).requests;
  let off = (): void => undefined;
  const replaced = new Promise<SessionFold | undefined>((resolve) => {
    off = client.store.subscribe(() => {
      const next = client.store.thread(threadId)?.state;
      if (next?.origin !== fold.origin) resolve(next);
    });
  });
  try {
    const reply = await client.resumeThread(threadId, resume?.params.window as never);
    // A replay of the window already folded brings nothing.
    if (reply?.subscription?.mode !== 'snapshot') return false;
    return pageLanded(fold, await replaced);
  } finally {
    off();
  }
}

/** The transcript this page shows: its own fold of the thread (`sessionStateOf`), whole within the thread's `thread/resume` window. A
 *  page grows that window; a tool row's whole output is read from the fold (`remoteToolOutput`).
 *
 *  The page asks for `limit` transcript rows and the window counts core items (`pageWindow`). A page that asks the core for
 *  nothing is answered here, about its own `limit`, and is not a page on its way; one that does ask joins the page already on its
 *  way from the same fold, whose answer (older history joined this fold's window, or not) is the same whatever each asked. */
export const foldTranscript = (client: FoldClient): ChatShared['transcript'] => ({
  page: (threadId, state, limit) => {
    const fold = client.store.thread(threadId)?.state;
    const origin = fold?.origin;
    if (!fold || !origin) return Promise.resolve(false);
    // A positioned window grows by the reader's moves (`moveTranscriptWindow`), never by a larger snapshot.
    if (fold.held) return Promise.resolve(true);
    const shown = (state as { items?: readonly unknown[] } | null)?.items?.length ?? 0;
    const items = pageWindow(fold, shown, limit);
    // The thread's start is held, or the rows asked for are shown already; or nothing older can join the window.
    if (!items) return Promise.resolve(items === 0);
    const out = pagesOut.get(origin);
    if (out) return out;
    const grown = growFold(client, threadId, fold, items);
    pagesOut.set(origin, grown);
    void grown.then(
      () => pagesOut.delete(origin),
      () => pagesOut.delete(origin)
    );
    return grown;
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
