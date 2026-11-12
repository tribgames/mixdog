// The DesktopService methods over the one protocol connection (protocol.md section 12.3): on a connection with a core,
// `DesktopServiceClient` sends each method as the core request(s) below, not as a call of the Node service. Positional
// arguments become the named params of the Rust op, in the declared order of `client_methods.json`; a thread-addressed
// op gets `threadId` from the session argument. The client library adds `opId` to every mutation (`call`), so none is
// set here. A method with no request op is refused before anything is sent (`unknownMethod`): there is no fallback.
import { roomIdOfSession } from '../../shared/core-src/runtime/agent/orchestrator/session/agent-room.mjs';
import { blankSnapshot, remoteSessionIdOf, START_CALLS, startFolder } from '../../shared/blank-snapshot';
import type { StartCall } from '../../shared/blank-snapshot';
import type { SessionSnapshot } from '../../shared/contract';
import { DESKTOP_TRANSCRIPT_TAIL_ITEMS } from '../../shared/desktop-transcript-limits';
import { requiredVisibleSessionVersion } from '../desktop-state';
import type { ProtocolConnection } from './connection';
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
  setModelRoute: ([route, threadId]) => one('route/set', given({ threadId, route }), 'snapshot'),
  setFast: ([on, threadId]) => one('fast/set', given({ threadId, on }), 'snapshot'),
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
 *  request), the others through the capability and operation lanes. `perfLog` is the `client/perfLog` notification. */
export const SERVICE_NOT_ROUTED = [
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
}

/** `snapshot` is the shell snapshot this process holds, as in the capability lane. */
export function createServiceLane({
  protocol,
  snapshot,
}: {
  protocol: Pick<ProtocolConnection, 'call' | 'notify' | 'resumeThread' | 'unsubscribeThread' | 'onEvent'> &
    Partial<Pick<ProtocolConnection, 'onReplaced'>>;
  snapshot(): SessionSnapshot;
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
  // A visible thread is followed through the client library, which folds its feed (session-lane.ts publishes the fold).
  const resume = (threadId: string): Promise<unknown> => answered(protocol.resumeThread(threadId, tail(undefined)), threadId);
  // The threads this process resumed (`setVisibleSessions` names the visible set; the core feeds only those).
  // Each entry's token is that resume's own: a replacement's rejection that arrives after the thread was hidden and
  // shown again finds another token and leaves the newer state alone.
  const resumed = new Map<string, object>();
  // A replaced client has none of the threads' subscriptions: they are resumed on it again, so a visible thread's
  // stream goes on. One the core refuses is dropped from the set; the next `setVisibleSessions` resumes it.
  protocol.onReplaced?.(() => {
    for (const [threadId, token] of [...resumed]) {
      void resume(threadId).catch(() => {
        if (resumed.get(threadId) === token) resumed.delete(threadId);
      });
    }
  });
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
  return {
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
        const visible = new Set(ids);
        for (const threadId of [...resumed.keys()]) {
          if (visible.has(threadId)) continue;
          resumed.delete(threadId);
          await answered(protocol.unsubscribeThread(threadId), threadId);
        }
        for (const threadId of visible) {
          if (resumed.has(threadId)) continue;
          await resume(threadId);
          resumed.set(threadId, {});
        }
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
