// The DesktopService methods over the one protocol connection (protocol.md section 12.3): on a connection with a core,
// `DesktopServiceClient` sends each method as the core request(s) below, not as a call of the Node service. Positional
// arguments become the named params of the Rust op, in the declared order of `client_methods.json`; a thread-addressed
// op gets `threadId` from the session argument. The client library adds `opId` to every mutation (`call`), so none is
// set here. A method with no request op is refused before anything is sent (`unknownMethod`): there is no fallback.
import { roomIdOfSession } from '../core-src/runtime/agent/orchestrator/session/agent-room.mjs';
import { blankSnapshot, remoteSessionIdOf, START_CALLS, startFolder } from '../blank-snapshot';
import type { StartCall } from '../blank-snapshot';
import type { SessionSnapshot } from '../contract';
import { DESKTOP_TRANSCRIPT_TAIL_ITEMS } from '../desktop-transcript-limits';
import { requiredVisibleSessionVersion } from '../desktop-state';
import { coreErrorForWindow } from './core-error';

export interface ServiceRequest {
  method: string;
  params: Record<string, unknown>;
}

/** What the caller gets back: the core's reply, or the shell snapshot this process holds (a core reply carries no
 *  session state, it arrives on the thread feeds), or nothing. */
export type ServiceResult = 'reply' | 'snapshot' | 'none' | 'accepted' | 'interrupt';

interface Route {
  requests: ServiceRequest[];
  result: ServiceResult;
  /** The method's own answer made from the core's reply, where the contract's is not the reply itself. */
  shape?(reply: any): unknown;
}

/** `project/list` as the contract's project rows (the core's rows also carry `hidden` and `lastUsedAt`). */
export const projectSummaries = (reply: unknown): Array<{ name: string; path: string; alias: string | null }> =>
  ((reply as { projects: Array<{ name: string; path: string; alias: string | null }> }).projects).map(({ name, path, alias }) => ({
    name,
    path,
    alias,
  }));

/** The folder a project method answers: the core answers `{ path }`, the contract a string. */
const pathOf = (reply: { path: string }): string => reply.path;

export const unknownService = (method: string): Error =>
  Object.assign(new Error(`${method} has no protocol method.`), { code: 'unknownMethod' });

const one = (method: string, params: Record<string, unknown>, result: ServiceResult = 'reply'): Route => ({
  requests: [{ method, params }],
  result,
});
const shaped = (method: string, params: Record<string, unknown>, shape: (reply: any) => unknown): Route => ({
  ...one(method, params),
  shape,
});

/** A param left out of the request when the caller gave none. */
const given = (params: Record<string, unknown>): Record<string, unknown> =>
  Object.fromEntries(Object.entries(params).filter(([, value]) => value !== undefined && value !== null));

// `SubmitOptions` (client_methods.json) has no `additionalProperties`: Node's `id` is `clientSubmissionId`, and the
// host-stamped fields (`device`, `hop`, `roomRow`, `origin`) are not the caller's to send.
const SUBMIT_OPTION_KEYS = [
  'submittedAt',
  'displayText',
  'goalCommand',
  'retryFailedTurn',
  'priority',
  'pastedImages',
  'pastedTexts',
  'kickoff',
] as const;

function turnInput(prompt: unknown, options: Record<string, unknown> | undefined): Record<string, unknown> {
  const sent: Record<string, unknown> = {};
  for (const key of SUBMIT_OPTION_KEYS) if (options?.[key] !== undefined) sent[key] = options[key];
  if (options?.id !== undefined) sent.clientSubmissionId = options.id;
  return { prompt, options: sent };
}

/** A stored attachment's name: its content hash (attachment-thumbnail.ts `ATTACHMENT_REF_PATTERN`). */
const ATTACHMENT_REF = /^[a-f0-9]{64}$/;
/** Raw bytes per `blob/read` page, under the core's page bound (`limits.maxBlobPageBytes`, 1 MiB). */
const BLOB_PAGE_BYTES = 786_432;

const tail = (items: unknown): { lastItems: number } => ({
  lastItems: typeof items === 'number' ? items : DESKTOP_TRANSCRIPT_TAIL_ITEMS,
});

type Single = (args: readonly any[]) => Route;

const SINGLE: Readonly<Record<string, Single>> = {
  submitNewTask: ([prompt, options, draft]) =>
    one('thread/start', given({ kind: 'task', projectPath: draft?.projectPath, draft, initialInput: turnInput(prompt, options) })),
  listProjects: () => shaped('project/list', {}, projectSummaries),
  addProject: ([path]) => one('project/create', { path }),
  projectDirectory: ([path]) => shaped('project/directory', { path }, pathOf),
  projectRecoveryDirectory: ([path]) => shaped('project/recoveryDirectory', { path }, pathOf),
  renameProject: ([path, alias]) => one('project/update', { path, alias }),
  removeProject: ([path]) => one('project/delete', { path }),
  getTaskWorkspace: () => shaped('project/taskWorkspace', {}, pathOf),
  codeGraphQuery: ([path, mode, query]) => one('project/codeGraph', { path, mode, query }),
  listProjectDir: ([root, rel]) => one('projectFs/listDir', { root, rel }),
  readProjectTextFile: ([root, rel]) => one('projectFs/readText', { root, rel }),
  writeProjectTextFile: ([root, rel, content, expectedContent, encoding]) =>
    one('projectFs/writeText', given({ root, rel, content, expectedContent, encoding })),
  statProjectFile: ([root, rel]) => one('projectFs/stat', { root, rel }),
  createProjectEntry: ([root, relDir, name, directory]) => one('projectFs/create', { root, relDir, name, directory }),
  renameProjectEntry: ([root, rel, newName]) => one('projectFs/rename', { root, rel, newName }),
  moveProjectEntry: ([root, rel, targetDirRel]) => one('projectFs/move', { root, rel, targetDirRel }),
  copyProjectEntry: ([root, rel, targetDirRel]) => one('projectFs/copy', { root, rel, targetDirRel }),
  projectEntryPath: ([root, rel]) => shaped('projectFs/entryPath', { root, rel }, pathOf),
  markSessionRead: ([threadId, messageCount, consumedUnread]) =>
    one('thread/readState/update', { threadId, messageCount, consumedUnread }),
  searchSessionContent: ([query]) => one('thread/search', { query }),
  listAgentPool: () => one('agent/pool/list', {}),
  renameSession: ([threadId, title]) => one('thread/name/set', { threadId, title }),
  continueSessionInModel: ([threadId, route]) => one('thread/continueInModel', { threadId, route }),
  scheduleQuotaResume: ([threadId]) => one('thread/quotaResume/schedule', { threadId }),
  cancelQuotaResume: ([threadId]) => one('thread/quotaResume/cancel', { threadId }),
  stopShellJob: ([threadId, taskId]) => one('thread/backgroundTerminals/terminate', { threadId, taskId }),
  releaseShellJob: ([threadId, taskId]) => one('thread/backgroundTerminals/release', { threadId, taskId }),
  // `quotaAutoResume` is the config key the core reads; Node's `quotaResume.autoResume` is moved to it by the 1.4.5 migration.
  setQuotaAutoResume: ([enabled]) => one('config/value/write', { path: 'quotaAutoResume', value: enabled }),
  readSessionFinalAnswer: ([threadId, startedAt]) => one('thread/finalAnswer/read', { threadId, startedAt }),
  // The window a read of the session's transcript asks for (the phone's adapter resumes the thread with it). The session
  // lane answers the desktop's own `prefetchSession`, the catalog, the transcript reads and the history pages.
  prefetchSession: ([threadId, items]) => one('thread/read', { threadId, window: tail(items) }),
  setSessionFavorite: ([threadId, favorite]) => one('thread/metadata/update', { threadId, favorite }),
  setSessionProject: ([threadId, projectPath]) => one('thread/metadata/update', { threadId, projectPath }),
  setSessionArchived: ([threadId, archived]) => one(archived ? 'thread/archive' : 'thread/unarchive', { threadId }),
  deleteSession: ([threadId]) => one('thread/delete', { threadId }),
  openAgentHome: ([agentId]) => one('agent/home/open', { agentId }),
  resetAgentHome: ([agentId]) => one('agent/home/reset', { agentId }),
  listAgentMemory: ([agentId]) => one('agent/memory/list', { agentId }),
  deleteAgentMemory: ([agentId, entry]) =>
    one('agent/memory/delete', { agentId, entryId: entry.id, indexRevision: entry.indexRevision }),
  inheritSession: ([threadId, route, options]) =>
    one('thread/fork', given({ threadId, route, compact: options?.compact }), 'reply'),
  // A room log runs no turn: a message into it is the room's (`session-host.ts:1089-1091` → `agentRooms.send`), `room/send`
  // with the same input, whose reply is `true`.
  submitToSession: ([threadId, prompt, options]) =>
    roomIdOfSession(threadId)
      ? one('room/send', { input: { threadId, ...turnInput(prompt, options) } })
      : one('turn/start', { threadId, input: turnInput(prompt, options) }, 'accepted'),
  abortSession: ([threadId, options]) =>
    one('turn/interrupt', given({ threadId, restorePrompt: options?.restorePrompt, submissionId: options?.submissionId }), 'interrupt'),
  listProviderModels: ([options]) => one('model/list', given({ force: options?.force, refresh: options?.refresh, quick: options?.quick })),
};

// `agentRoomAction(action, args)`: Node's `AgentRooms` methods take positional arguments, the core's `input` is one
// object (`roomId` plus the patch).
const ROOM_ACTIONS: Readonly<Record<string, (args: readonly any[]) => ServiceRequest>> = {
  create: ([config]) => ({ method: 'room/create', params: { input: config } }),
  update: ([roomId, patch]) => ({ method: 'room/update', params: { input: { roomId, ...patch } } }),
  continue: ([roomId]) => ({ method: 'room/continue', params: { input: { roomId } } }),
  leave: ([roomId]) => ({ method: 'room/leave', params: { input: { roomId } } }),
  remove: ([roomId]) => ({ method: 'room/remove', params: { input: { roomId } } }),
  reset: ([roomId]) => ({ method: 'room/reset', params: { input: { roomId } } }),
};

/** Methods that are not requests of this lane: it refuses them with `unknownMethod`. The client sends the first two through
 *  the capability lane (`getQuotaAutoResume` reads the `config` section, `resolveToolApprovalForSession` answers the server
 *  request), the others through the capability and operation lanes. `perfLog` is the `client/perfLog` notification.
 *  `setModelRoute` is the capability lane's `setRoute`: Node answered the session's state after the change, which only that lane
 *  reads from the core (`thread/read`). */
export const SERVICE_NOT_ROUTED = [
  'setModelRoute',
  'setFast',
  'getQuotaAutoResume',
  'resolveToolApprovalForSession',
  'invokeCapability',
  'readCapabilities',
  'invokeDesktopOperation',
] as const;

/** The core request for `method(...args)` of a stateless method. */
export function routeService(method: string, args: readonly unknown[]): Route {
  if (method === 'agentRoomAction') {
    const [action, roomArgs] = args as [string, unknown[]];
    const room = Object.hasOwn(ROOM_ACTIONS, action) ? ROOM_ACTIONS[action] : undefined;
    if (!room) throw unknownService(`agentRoomAction(${action})`);
    return { requests: [room(roomArgs ?? [])], result: 'reply' };
  }
  const route = Object.hasOwn(SINGLE, method) ? SINGLE[method] : undefined;
  if (!route) throw unknownService(method);
  return route(args);
}

/** The file methods that take a project path and work in its folder. Node resolved it in the daemon (`session-host.ts`
 *  `projectDirectory`: a registered project or worktree, else a refusal); the core's `projectFs` ops take the
 *  folder itself and trust a local caller with it, so the lane resolves it through `project/directory` first and sends
 *  that folder, never the project string. */
const ROOTED_SERVICE_METHODS: ReadonlySet<string> = new Set([
  'listProjectDir',
  'readProjectTextFile',
  'writeProjectTextFile',
  'statProjectFile',
  'createProjectEntry',
  'renameProjectEntry',
  'moveProjectEntry',
  'copyProjectEntry',
  'projectEntryPath',
  'codeGraphQuery',
]);

export interface ServiceLane {
  call<T = unknown>(method: string, args: unknown[], signal?: AbortSignal): Promise<T>;
  /** Stops following the visible threads' convergence: no request or retry starts after it. */
  dispose(): void;
}

/** What the lane reads of the open client (the library's `threadSubscription`): whether it follows a thread, whether its own
 *  restore of the thread is in flight, a mark that changes whenever such a restore starts, and on which of its transport
 *  connections. A client that cannot say is judged by the lane's own record of the requests it answered. */
export interface FollowingClient {
  readonly status: { readonly state: string };
  threadSubscription?(threadId: string): {
    readonly followed: boolean;
    readonly restoring: boolean;
    readonly restoresStarted: number;
    readonly connection: number;
  };
  /** The client's fold store. Its `threads` map (the library's `ProtocolClient.store`) lists the threads the client holds a
   *  fold of, whoever subscribed them (a `thread/resume` or the attach of a `thread/start`); read at run time, since the
   *  connection's own store type does not declare it. */
  readonly store?: unknown;
}

/** How long a thread the client follows without the lane wanting it (a new thread's attach, a resume made to answer an
 *  approval or read a state) may stay subscribed before the lane lets it go. A followed thread is kept loaded in the core, off
 *  its idle eviction; Codex unloads an unsubscribed thread after 60 s (`thread_unload_delay`). */
export const STRAY_FOLLOW_RELEASE_MS = 60_000;

/** What the lane needs from the desktop's protocol connection (`ProtocolConnection` of main/protocol/connection.ts), declared
 *  here so the shared lane imports nothing from main. */
export interface ServiceProtocol {
  call(method: string, params: unknown): Promise<unknown>;
  notify(method: string, params: unknown): void;
  resumeThread(threadId: string, window: unknown): Promise<unknown>;
  unsubscribeThread(threadId: string): Promise<void>;
  onEvent(listener: (event: ServiceProtocolEvent) => void): () => void;
  onReplaced?(listener: () => void): () => void;
  /** The client open now; null while none is. */
  client?(): FollowingClient | null;
  /** Every change of the open client's store (a subscription restored or lost is `subscription` of its feed). */
  onStoreChange?(listener: (change: { readonly type: string; readonly feedId?: string }) => void): () => void;
}

/** Where the lane leaves evidence of a thread that keeps failing. */
export type FollowReport = (line: string) => void;
/** A thread's failures in a row are reported at the third, then at every twentieth after it (about ten minutes apart once
 *  retries are at the cap). */
const reportedFailure = (failures: number): boolean => failures === 3 || (failures > 3 && (failures - 3) % 20 === 0);

/** Starts `run` after `ms`; returns its cancellation. */
export type ScheduleRetry = (run: () => void, ms: number) => () => void;
const scheduleTimer: ScheduleRetry = (run, ms) => {
  const timer = setTimeout(run, ms);
  return () => clearTimeout(timer);
};
/** The stray sweep's timer: it never holds the process open by itself. */
const scheduleSweep: ScheduleRetry = (run, ms) => {
  const timer = setTimeout(run, ms);
  (timer as { unref?: () => void }).unref?.();
  return () => clearTimeout(timer);
};
/** A visible thread's failed request is sent again after this, doubled per failure in a row up to the cap: the rate is
 *  bounded, the retries are not, so an open pane is never left unfollowed for good. */
export const FOLLOW_RETRY_MS = 500;
export const FOLLOW_RETRY_MAX_MS = 30_000;

/** The connection a request went out on: the lane's replacement count, the client object and the client's own transport
 *  connection. The core's subscriptions of one end with it, so what was learned under another says nothing now. */
interface Generation {
  readonly replaced: number;
  readonly client: FollowingClient | null;
  readonly connection: number | undefined;
}
const sameGeneration = (a: Generation, b: Generation): boolean =>
  a.replaced === b.replaced && a.client === b.client && a.connection === b.connection;
/** The same client object: a subscription it holds outlives its own reconnects (it restores them), not a replacement. */
const sameClient = (a: Generation, b: Generation): boolean => a.replaced === b.replaced && a.client === b.client;

/** A registered thread's convergence: the lane manages only threads `setVisibleSessions` asked for, and lets a thread go once
 *  its own subscription of it is gone, so a fold another caller made (a new thread's snapshot) is never torn down here. At
 *  most one request is in flight: `running` is its attempt. */
interface Follow {
  attempt: number;
  running: number;
  /** The lane's own subscription: on this client the thread was followed while wanted, and the lane has not unsubscribed it
   *  since. Also what a client that cannot say what it follows is judged by. */
  mine?: Generation;
  /** An unsubscribe failed, or a restore of the thread overlapped it, on this generation: the core may still feed it until
   *  absence is confirmed there or the generation retires. */
  owed?: Generation;
  /** A wake arrived while a request was in flight: the thread is looked at again when it is answered; after a failure only
   *  a changed need acts at once. */
  dirty?: boolean;
  failures: number;
  cancelRetry?: () => void;
  /** What the pending retry is for: until its deadline, a wake for the same need changes nothing. */
  backoff?: Need;
}
/** The request a thread needs: a resume (wanted) or an unsubscribe, on a generation. */
interface Need {
  readonly wanted: boolean;
  readonly generation: Generation;
}

/** A thread the core does not have (Node's `session <id> is not available`). */
const unavailable = (error: unknown): boolean => {
  const detail = (error as { detail?: { kind?: unknown; data?: { reason?: unknown } } } | null)?.detail;
  return detail?.kind === 'rpc' && detail.data?.reason === 'threadNotFound';
};

/** A client event as the lane reads it (`ConnectionClientEvent` of the connection). */
export type ServiceProtocolEvent =
  | { readonly type: 'status'; readonly status: { readonly state: string } }
  | {
      readonly type: 'notification';
      readonly notification: { readonly method: string; readonly params?: unknown; readonly feed?: { readonly id: string } };
    }
  | { readonly type: 'serverRequest'; readonly request: { readonly id: string | number; readonly method: string; readonly params: unknown } }
  | { readonly type: 'serverRequestResolved'; readonly params: { readonly requestId?: string | number } }
  | { readonly type: string };

/** `snapshot` is the shell snapshot this process holds, as in the capability lane. */
export function createServiceLane({
  protocol,
  snapshot,
  schedule = scheduleTimer,
  sweep = scheduleSweep,
  report = (line) => console.error(line),
}: {
  protocol: ServiceProtocol;
  snapshot(): SessionSnapshot;
  schedule?: ScheduleRetry;
  /** The stray follows' sweep timer, apart from the retries' (`STRAY_FOLLOW_RELEASE_MS`). */
  sweep?: ScheduleRetry;
  report?: FollowReport;
}): ServiceLane {
  const answered = (reply: Promise<unknown>, threadId: unknown): Promise<unknown> =>
    reply.catch((error: unknown) => {
      // A thread the core does not have is Node's `session <id> is not available` (session-views.mjs, session-action.mjs).
      const reason = (error as { detail?: { kind?: unknown; data?: { reason?: unknown } } } | null)?.detail;
      if (reason?.kind === 'rpc' && reason.data?.reason === 'threadNotFound' && typeof threadId === 'string') {
        throw new Error(`session ${threadId} is not available`);
      }
      throw coreErrorForWindow(error);
    });
  const send = ({ method, params }: ServiceRequest): Promise<unknown> => answered(protocol.call(method, params), params.threadId);
  const searching = new Map<string, string>();
  // The query each search session is answering: a newer query of the same consumer ends the older one's wait, since the
  // core completes only the query it holds.
  const superseded = new Map<string, () => void>();
  /** The files of `query` as Node's file search named them (a folder's path ends with a slash): what `search/updated`
   *  last carried when `search/completed` arrives for that query. */
  const searchAnswer = async (sessionId: string, query: string): Promise<string[]> => {
    // The core echoes the query with a lone surrogate replaced, as its JSON reader read it.
    const echoed = query.replace(/[\ud800-\udfff]/gu, '\ufffd');
    let files: string[] = [];
    superseded.get(sessionId)?.();
    let finish = (): void => undefined;
    const completed = new Promise<void>((resolve) => (finish = resolve));
    superseded.set(sessionId, finish);
    const off = protocol.onEvent((event) => {
      if (event.type !== 'notification') return;
      const { method, params } = (event as { notification: { method: string; params?: unknown } }).notification;
      const update = params as { sessionId?: string; query?: string; files?: Array<{ path: string; matchType: string }> } | undefined;
      if (update?.sessionId !== sessionId || update.query !== echoed) return;
      if (method === 'search/updated') files = (update.files ?? []).map((row) => (row.matchType === 'directory' ? `${row.path}/` : row.path));
      else if (method === 'search/completed') finish();
    });
    try {
      await send({ method: 'search/update', params: { sessionId, query } });
      await completed;
    } finally {
      off();
      if (superseded.get(sessionId) === finish) superseded.delete(sessionId);
    }
    return files;
  };
  /** Node's `readAttachmentImage` (session-host.ts): the stored blob as base64; null for no reference, for a blob the store
   *  no longer has or that fails its content check, and for one over the caller's bound. Read a page at a time. */
  const readAttachment = async (ref: unknown, maxBytes: unknown): Promise<string | null> => {
    if (typeof ref !== 'string' || !ATTACHMENT_REF.test(ref)) return null;
    // A page is a multiple of three bytes, so the pages' base64 joins into the blob's.
    let base64 = '';
    let size = 0;
    for (;;) {
      let page: string;
      try {
        page = ((await protocol.call('blob/read', { digest: `sha256:${ref}`, offset: size, length: BLOB_PAGE_BYTES })) as { bytesB64: string }).bytesB64;
      } catch (error) {
        const reason = (error as { detail?: { data?: { reason?: unknown } } } | null)?.detail?.data?.reason;
        if (reason === 'blobNotFound' || reason === 'blobCorrupt') return null;
        throw coreErrorForWindow(error);
      }
      const bytes = (page.length / 4) * 3 - (page.endsWith('==') ? 2 : page.endsWith('=') ? 1 : 0);
      base64 += page;
      size += bytes;
      if (typeof maxBytes === 'number' && size > maxBytes) return null;
      if (bytes < BLOB_PAGE_BYTES) break;
    }
    return base64;
  };
  // The newest `setVisibleSessions` version this process sent (desktop-service-client.ts numbers them): an older or equal one
  // that arrives after it (a retried call) changes nothing (Node's desktop-service-state-sync.ts `setDeliveryFilter` fence).
  // It is this process's own counter: a restarted desktop starts over at 1 on its own connection.
  let shownVersion: number | undefined;
  // The visible threads. A registration records what is wanted and wakes the threads it touches; each thread is then brought
  // there on its own, comparing what is wanted with what the open client follows (not with a record of past requests), one
  // request at a time. Nothing is queued: a notification only wakes a thread, which reads the state again. So one thread's
  // slow or failing request holds back no other thread and no registration (Node's session-view-registry.ts attaches each
  // session apart as well).
  let desired = new Set<string>();
  const follows = new Map<string, Follow>();
  let replacements = 0;
  let disposed = false;
  const generationNow = (threadId: string): Generation => {
    const client = protocol.client?.() ?? null;
    return { replaced: replacements, client, connection: client?.threadSubscription?.(threadId).connection };
  };
  const owes = (follow: Follow, now: Generation): boolean => follow.owed !== undefined && sameGeneration(follow.owed, now);
  /** Whether the core feeds the thread to the open client: `restoring` while the client's own resume of it after a reconnect
   *  is in flight (the core may attach it after any unsubscribe answered meanwhile), `unknown` while cleanup is owed. */
  const observed = (threadId: string, follow: Follow, now: Generation): 'attached' | 'absent' | 'unknown' | 'restoring' => {
    const told = now.client?.threadSubscription?.(threadId);
    if (told?.restoring) return 'restoring';
    if (owes(follow, now)) return 'unknown';
    const followed = told ? told.followed : follow.mine !== undefined && sameClient(follow.mine, now);
    return followed ? 'attached' : 'absent';
  };
  const retryLater = (threadId: string, follow: Follow, delay: number, need: Need): void => {
    follow.cancelRetry?.();
    follow.backoff = need;
    follow.cancelRetry = schedule(() => {
      follow.cancelRetry = undefined;
      follow.backoff = undefined;
      wake(threadId);
    }, delay);
  };
  /** Brings one thread to what is wanted of it. Ends when it is there, when a retry is scheduled, or when its attempt was
   *  retired (a replacement or the lane's end): after every await it checks it still owns the thread. */
  const reconcile = async (threadId: string, follow: Follow): Promise<void> => {
    for (;;) {
      follow.dirty = false;
      const now = generationNow(threadId);
      const wanted = desired.has(threadId);
      const seen = observed(threadId, follow, now);
      if (wanted && seen === 'attached') {
        follow.mine = now;
        follow.failures = 0;
        return;
      }
      // Not wanted, and neither the lane's subscription nor its owed cleanup is on this client: nothing here is the lane's.
      if (!wanted && (seen === 'absent' || !((follow.mine !== undefined && sameClient(follow.mine, now)) || owes(follow, now)))) {
        follows.delete(threadId);
        return;
      }
      // The client's restore decides first; its end (restored or lost) wakes the thread.
      if (seen === 'restoring') return;
      const attempt = ++follow.attempt;
      follow.running = attempt;
      let failure: { error: unknown } | undefined;
      // Read before the request can go out (the connection may hand it to the client later), compared after its answer.
      const restoreBefore = now.client?.threadSubscription?.(threadId);
      try {
        if (wanted) await protocol.resumeThread(threadId, tail(undefined));
        else {
          // The client stops following before its request goes out.
          follow.mine = undefined;
          await protocol.unsubscribeThread(threadId);
        }
      } catch (error) {
        failure = { error };
      }
      if (disposed || follow.attempt !== attempt || follows.get(threadId) !== follow) return;
      follow.running = 0;
      const after = generationNow(threadId);
      // An unsubscribe that a restore of the thread overlapped (in flight at any point from before the request could go out
      // until now, however it ended) confirms nothing: the core may have attached the restore after removing the thread, and
      // the order of their answers says nothing about that. Cleanup stays owed and the unsubscribe is sent again once the
      // restore has ended; a redundant one costs nothing at the core.
      const restoreAfter = sameClient(now, after) ? after.client?.threadSubscription?.(threadId) : undefined;
      const overlapped =
        !wanted &&
        restoreAfter !== undefined &&
        (restoreBefore?.restoring === true ||
          restoreAfter.restoring ||
          restoreBefore?.restoresStarted !== restoreAfter.restoresStarted);
      // Answered on a generation that is gone: it says nothing about the current one, which is read again.
      if (!sameGeneration(now, after)) {
        if (overlapped) follow.owed = after;
        continue;
      }
      if (!failure) {
        follow.failures = 0;
        if (wanted) {
          follow.owed = undefined;
          follow.mine = now;
        } else follow.owed = overlapped ? now : undefined;
        continue;
      }
      // The core may still feed this generation: cleanup stays owed until absence is confirmed on it or it retires.
      if (!wanted) follow.owed = now;
      follow.failures += 1;
      // A thread the core does not have is asked again at the slowest rate (it may be created yet); no other waits on it.
      const delay = unavailable(failure.error)
        ? FOLLOW_RETRY_MAX_MS
        : Math.min(FOLLOW_RETRY_MAX_MS, FOLLOW_RETRY_MS * 2 ** Math.min(follow.failures - 1, 16));
      if (reportedFailure(follow.failures)) {
        const reason = failure.error instanceof Error ? failure.error.message : String(failure.error);
        report(
          `[mixdog-lane] follow failing thread=${threadId.slice(-8)} ${wanted ? 'resume' : 'unsubscribe'} failures=${follow.failures} retryMs=${delay} error=${reason.slice(0, 160)}`
        );
      }
      // Woken while the request was in flight: only a changed need acts now (the generation is the same here); the same
      // request again waits out its backoff.
      if (follow.dirty && desired.has(threadId) !== wanted) continue;
      retryLater(threadId, follow, delay, { wanted, generation: now });
      return;
    }
  };
  /** Marks a thread for another look. One with a request in flight is marked dirty and looked at again when that is answered.
   *  A thread the lane has no record of is taken on only when it is wanted. */
  const wake = (threadId: string): void => {
    if (disposed) return;
    let follow = follows.get(threadId);
    if (!follow) {
      if (!desired.has(threadId)) return;
      follow = { attempt: 0, running: 0, failures: 0 };
      follows.set(threadId, follow);
    }
    // Waiting out a backoff: the same request on the same generation waits for its deadline; a changed need acts now.
    const { backoff } = follow;
    if (backoff && desired.has(threadId) === backoff.wanted && sameGeneration(backoff.generation, generationNow(threadId))) return;
    follow.cancelRetry?.();
    follow.cancelRetry = undefined;
    follow.backoff = undefined;
    if (follow.running === 0) void reconcile(threadId, follow);
    else follow.dirty = true;
  };
  const wakeAll = (): void => {
    for (const threadId of new Set([...desired, ...follows.keys()])) wake(threadId);
  };
  // A replaced client follows none of the threads, and whatever is in flight belongs to the old one: every attempt is retired
  // now, so a late answer of the old client changes nothing and a request it never answers holds no thread.
  const offReplaced = protocol.onReplaced?.(() => {
    replacements += 1;
    for (const follow of follows.values()) {
      follow.attempt += 1;
      follow.running = 0;
    }
    wakeAll();
  });
  const offEvents = protocol.onEvent((event) => {
    // A connection that is ready again: what failed while it was down is tried now, and owed cleanups of the ended
    // connection are void.
    if (event.type === 'status' && (event as { status: { state: string } }).status.state === 'ready') wakeAll();
    else if (event.type === 'subscriptionLost') {
      const threadId = (event as { threadId?: unknown }).threadId;
      if (typeof threadId !== 'string') return;
      const follow = follows.get(threadId);
      if (follow) follow.mine = undefined;
      wake(threadId);
    }
  });
  // The end of the client's restore of a thread (`subscription` restored or lost): a thread waiting on it is looked at again.
  const offStore = protocol.onStoreChange?.((change) => {
    if (change.type === 'subscription' && change.feedId !== undefined) wake(change.feedId);
  });
  // Folds the lane never made and nothing wants: released once they have stayed unwanted for `STRAY_FOLLOW_RELEASE_MS`, so a
  // window open for hours does not keep every thread it ever touched loaded in the core. A thread that becomes wanted is
  // the lane's again (its convergence resumes it).
  const strays = new Map<string, number>();
  let cancelSweep: (() => void) | undefined;
  const sweepStrays = (): void => {
    cancelSweep = undefined;
    if (disposed) return;
    const client = protocol.client?.() ?? null;
    const threads = (client?.store as { readonly threads?: { keys(): Iterable<string> } } | null | undefined)?.threads;
    const held = new Set<string>(threads ? [...threads.keys()] : []);
    const now = Date.now();
    for (const threadId of [...strays.keys()]) if (!held.has(threadId)) strays.delete(threadId);
    for (const threadId of held) {
      if (desired.has(threadId) || follows.has(threadId)) {
        strays.delete(threadId);
        continue;
      }
      const since = strays.get(threadId);
      if (since === undefined) {
        strays.set(threadId, now);
        continue;
      }
      if (now - since < STRAY_FOLLOW_RELEASE_MS) continue;
      strays.delete(threadId);
      void protocol
        .unsubscribeThread(threadId)
        .catch(() => undefined)
        .then(() => {
          // Wanted while the release was in flight: the convergence brings it back.
          if (desired.has(threadId)) wake(threadId);
        });
    }
    cancelSweep = sweep(sweepStrays, STRAY_FOLLOW_RELEASE_MS / 2);
  };
  cancelSweep = sweep(sweepStrays, STRAY_FOLLOW_RELEASE_MS / 2);
  return {
    dispose() {
      if (disposed) return;
      disposed = true;
      cancelSweep?.();
      offReplaced?.();
      offEvents();
      offStore?.();
      for (const follow of follows.values()) follow.cancelRetry?.();
      follows.clear();
    },
    async call<T>(method: string, args: unknown[], signal?: AbortSignal): Promise<T> {
      if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error('Request aborted.');
      if (method === 'perfLog') {
        protocol.notify('client/perfLog', { line: String(args[0] ?? '') });
        return undefined as T;
      }
      if (method === 'setVisibleSessions') {
        const [ids, version] = args as [string[], unknown];
        if (version !== undefined) {
          const next = requiredVisibleSessionVersion(version);
          if (shownVersion !== undefined && next <= shownVersion) return true as T;
          shownVersion = next;
        }
        // `true` is acceptance: the lane has taken the set over and brings each thread there, retrying what fails (as
        // Node's answer stayed true for a session the core refused).
        const prior = desired;
        desired = new Set(ids);
        // The threads still converging are woken too: a registration repairs a pending retry at once.
        for (const threadId of new Set([...prior, ...desired, ...follows.keys()])) wake(threadId);
        return true as T;
      }
      if (method === 'readAttachmentImage') return (await readAttachment(args[0], args[1])) as T;
      if (method === 'searchProjectFiles') {
        // One search session per consumer, started on its root and re-queried: `search/start` once, `search/update` after.
        const [root, query, limit, includeIgnored, includeDirectories, consumer] = args as [
          string, string, number, boolean, boolean, string | undefined,
        ];
        const sessionId = `search:${consumer ?? 'default'}`;
        if (searching.get(sessionId) !== root) {
          await send({
            method: 'search/start',
            params: given({ sessionId, roots: [root], limit, includeIgnored, includeDirectories, consumer }),
          });
          searching.set(sessionId, root);
        }
        return (await searchAnswer(sessionId, query)) as T;
      }
      if (START_CALLS.has(method)) {
        // No thread: Node's blank snapshot, composed from the project methods (shared/blank-snapshot.ts).
        const { cwd, projectPath } = await startFolder(send, method as StartCall, args[0] as string | undefined);
        const held = snapshot() as { remoteSessionId?: unknown } | null;
        return blankSnapshot(cwd, projectPath, remoteSessionIdOf({ sessionId: held?.remoteSessionId })) as T;
      }
      if (ROOTED_SERVICE_METHODS.has(method)) {
        const [project, ...rest] = args;
        const folder = (await send({ method: 'project/directory', params: { path: project } })) as { path?: unknown } | null;
        if (typeof folder?.path !== 'string') throw new TypeError('project/directory did not answer a folder.');
        args = [folder.path, ...rest];
      }
      const { requests, result, shape } = routeService(method, args);
      let reply: unknown;
      for (const request of requests) reply = await send(request);
      if (shape) return shape(reply) as T;
      // `interrupt`: Node's `abortSession` answer, without the wire's own `cancelRequested` and `turnId`.
      if (result === 'interrupt' && reply && typeof reply === 'object') {
        const { cancelRequested: _cancelRequested, turnId: _turnId, ...answer } = reply as Record<string, unknown>;
        return answer as T;
      }
      // `accepted`: the contract's `true` of a submission the core took (a refusal is the request's error).
      return (result === 'snapshot' ? snapshot() : result === 'none' ? undefined : result === 'accepted' ? true : reply) as T;
    },
  };
}
