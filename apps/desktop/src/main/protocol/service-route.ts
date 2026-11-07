// The DesktopService methods over the one protocol connection (protocol.md section 12.3): on a connection with a core,
// `DesktopServiceClient` sends each method as the core request(s) below, not as a call of the Node service. Positional
// arguments become the named params of the Rust op, in the declared order of `client_methods.json`; a thread-addressed
// op gets `threadId` from the session argument. The client library adds `opId` to every mutation (`call`), so none is
// set here. A method with no request op is refused before anything is sent (`unknownMethod`): there is no fallback.
import type { SessionSnapshot } from '../../shared/contract';
import { DESKTOP_TRANSCRIPT_TAIL_ITEMS } from '../desktop-support';
import type { ProtocolConnection } from './connection';
import { coreErrorForWindow } from './core-error';

export interface ServiceRequest {
  method: string;
  params: Record<string, unknown>;
}

/** What the caller gets back: the core's reply, or the shell snapshot this process holds (a core reply carries no
 *  session state, it arrives on the thread feeds), or nothing. */
export type ServiceResult = 'reply' | 'snapshot' | 'none';

interface Route {
  requests: ServiceRequest[];
  result: ServiceResult;
}

export const unknownService = (method: string): Error =>
  Object.assign(new Error(`${method} has no protocol method.`), { code: 'unknownMethod' });

const one = (method: string, params: Record<string, unknown>, result: ServiceResult = 'reply'): Route => ({
  requests: [{ method, params }],
  result,
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

const tail = (items: unknown): { lastItems: number } => ({
  lastItems: typeof items === 'number' ? items : DESKTOP_TRANSCRIPT_TAIL_ITEMS,
});

type Single = (args: readonly any[]) => Route;

const SINGLE: Readonly<Record<string, Single>> = {
  startProject: ([projectPath]) => one('thread/start', { kind: 'project', projectPath }, 'snapshot'),
  startProjectTask: ([projectPath]) => one('thread/start', { kind: 'projectTask', projectPath }, 'snapshot'),
  startTask: () => one('thread/start', { kind: 'task' }, 'snapshot'),
  submitNewTask: ([prompt, options, draft]) =>
    one('thread/start', given({ kind: 'task', projectPath: draft?.projectPath, draft, initialInput: turnInput(prompt, options) })),
  listProjects: () => one('project/list', {}),
  addProject: ([path]) => one('project/create', { path }),
  projectDirectory: ([path]) => one('project/directory', { path }),
  projectRecoveryDirectory: ([path]) => one('project/recoveryDirectory', { path }),
  renameProject: ([path, alias]) => one('project/update', { path, alias }),
  removeProject: ([path]) => one('project/delete', { path }),
  getTaskWorkspace: () => one('project/taskWorkspace', {}),
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
  projectEntryPath: ([root, rel]) => one('projectFs/entryPath', { root, rel }),
  // Node's `listSessions` is the whole catalog; the core pages it, and the first page is asked for with no cursor.
  listSessions: () => one('thread/list', {}),
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
  // `quotaResume.autoResume` is the config path the Rust `QuotaAutoResume` setting reads and writes.
  setQuotaAutoResume: ([enabled]) => one('config/value/write', { path: 'quotaResume.autoResume', value: enabled }),
  readAttachmentImage: ([digest, maxBytes]) => one('blob/read', given({ digest, length: maxBytes })),
  readSessionTranscript: ([threadId]) => one('thread/read', { threadId, window: tail(512) }),
  readSessionHistory: ([threadId]) => one('thread/items/list', { threadId }),
  readSessionFinalAnswer: ([threadId, startedAt]) => one('thread/finalAnswer/read', { threadId, startedAt }),
  // The trace id is a Node-side diagnostic; the op has no field for it.
  prefetchSession: ([threadId, items]) => one('thread/read', { threadId, window: tail(items) }),
  // `before`/`after` are item-anchored pages: the core pages older unless `sortDirection` is `asc`.
  readTranscriptHistory: ([threadId, request]) => {
    const anchor = request.before ?? request.after;
    return one(
      'thread/items/list',
      given({
        threadId,
        cursor: anchor === undefined ? undefined : { type: 'item', itemId: anchor },
        limit: request.limit,
        byteBudget: request.byteBudget,
        sortDirection: request.after === undefined ? 'desc' : 'asc',
      })
    );
  },
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
  submitToSession: ([threadId, prompt, options]) => one('turn/start', { threadId, input: turnInput(prompt, options) }),
  abortSession: ([threadId, options]) =>
    one('turn/interrupt', given({ threadId, restorePrompt: options?.restorePrompt, submissionId: options?.submissionId })),
  listProviderModels: ([options]) => one('model/list', given({ force: options?.force, refresh: options?.refresh, quick: options?.quick })),
  setModelRoute: ([route, threadId]) => one('route/set', given({ threadId, route }), 'snapshot'),
  setFast: ([on, threadId]) => one('fast/set', given({ threadId, on }), 'snapshot'),
};

// `agentRoomAction(action, args)`: Node's `AgentRooms` methods take positional arguments, the core's `input` is one
// object (`roomId` plus the patch). `reset` has no op.
const ROOM_ACTIONS: Readonly<Record<string, (args: readonly any[]) => ServiceRequest>> = {
  create: ([config]) => ({ method: 'room/create', params: { input: config } }),
  update: ([roomId, patch]) => ({ method: 'room/update', params: { input: { roomId, ...patch } } }),
  continue: ([roomId]) => ({ method: 'room/continue', params: { input: { roomId } } }),
  proceed: ([roomId]) => ({ method: 'room/continue', params: { input: { roomId } } }),
  leave: ([roomId]) => ({ method: 'room/leave', params: { input: { roomId } } }),
  remove: ([roomId]) => ({ method: 'room/remove', params: { input: { roomId } } }),
};

/** Methods that are not requests of the core: the lane refuses them with `unknownMethod`, or (`perfLog`) drops them. */
export const SERVICE_NOT_ROUTED = [
  'getQuotaAutoResume',
  'resolveToolApprovalForSession',
  'invokeCapability',
  'readCapabilities',
  'invokeDesktopOperation',
  'perfLog',
] as const;

/** The core request for `method(...args)` of a stateless method. */
export function routeService(method: string, args: readonly unknown[]): Route {
  if (method === 'agentRoomAction') {
    const [action, roomArgs] = args as [string, unknown[]];
    const room = ROOM_ACTIONS[action];
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
  protocol: Pick<ProtocolConnection, 'call'>;
  snapshot(): SessionSnapshot;
}): ServiceLane {
  const send = ({ method, params }: ServiceRequest): Promise<unknown> =>
    protocol.call(method, params).catch((error: unknown) => {
      throw coreErrorForWindow(error);
    });
  // The threads this process resumed (`setVisibleSessions` names the visible set; the core feeds only those).
  const resumed = new Set<string>();
  const searching = new Map<string, string>();
  return {
    async call<T>(method: string, args: unknown[], signal?: AbortSignal): Promise<T> {
      if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error('Request aborted.');
      if (method === 'perfLog') return undefined as T;
      if (method === 'setVisibleSessions') {
        const [ids] = args as [string[]];
        const visible = new Set(ids);
        for (const threadId of [...resumed]) {
          if (visible.has(threadId)) continue;
          resumed.delete(threadId);
          await send({ method: 'thread/unsubscribe', params: { threadId } });
        }
        for (const threadId of visible) {
          if (resumed.has(threadId)) continue;
          await send({ method: 'thread/resume', params: { threadId, window: tail(undefined) } });
          resumed.add(threadId);
        }
        return true as T;
      }
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
        return (await send({ method: 'search/update', params: { sessionId, query } })) as T;
      }
      if (ROOTED_SERVICE_METHODS.has(method)) {
        const [project, ...rest] = args;
        const folder = (await send({ method: 'project/directory', params: { path: project } })) as { path?: unknown } | null;
        if (typeof folder?.path !== 'string') throw new TypeError('project/directory did not answer a folder.');
        args = [folder.path, ...rest];
      }
      const { requests, result } = routeService(method, args);
      let reply: unknown;
      for (const request of requests) reply = await send(request);
      return (result === 'snapshot' ? snapshot() : result === 'none' ? undefined : reply) as T;
    },
  };
}
