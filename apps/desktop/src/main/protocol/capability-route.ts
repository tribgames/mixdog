// The renderer's session capabilities over the one protocol connection (protocol.md §12.3-12.4): `invokeCapability`
// and `readCapabilities` become `<namespace>/<action>` with the positional arguments as the method's named params, and
// the session the call is addressed to as `threadId`. A call without a session is the control session's: no
// `threadId` (a thread-scoped request is `thread_id`, a control one `global(<domain>)`, protocol.md §12 preamble).
// The routing table is the TUI's (`src/standalone/protocol-session`); only actions the TUI does not route are added.
// The control session is a real thread of the core, started on first need and addressed by the ops that require one and by
// the MCP actions (Node sends the control session's id with every MCP action, session and control path alike).
import {
  desktopSessionState,
  sessionReducer,
} from '../../../../../packages/protocol-client/src/index.ts';
import { ACTION_NAMESPACES } from '../../../../../src/standalone/protocol-session/action-namespaces.mjs';
import { resolveAction } from '../../../../../src/standalone/protocol-session/action-route.mjs';
import type {
  DesktopCapability,
  DesktopCapabilityReadRequest,
  DesktopCapabilityReadResult,
  DesktopCapabilityResult,
  SessionSnapshot,
} from '../../shared/contract';
import { normalizeSessionTitle } from '../../shared/session-title.mjs';
import { isSessionId } from '../desktop-state';
import type { ProtocolConnection } from './connection';
import { coreErrorForWindow } from './core-error';

/** `sessionIdOf` of the Node transport (`session-host-transport.ts`), which this file cannot import: that module has a
 *  TypeScript parameter property, and the harness loads this one with Node's strip-only mode. */
const sessionIdOf = (value: unknown): string => {
  const id = String(value || '');
  if (!isSessionId(id)) throw new TypeError('session id is invalid.');
  return id;
};

export interface CapabilityRoute {
  method: string;
  params: Record<string, unknown>;
}

type Override = (args: readonly unknown[], ctx: { threadId?: string }) => CapabilityRoute;

const defined = (params: Record<string, unknown>, threadId: string | undefined): Record<string, unknown> =>
  Object.fromEntries(Object.entries({ threadId, ...params }).filter(([, value]) => value !== undefined));

// Actions whose Rust op exists under another namespace or name than `<namespace>/<action>` (operations_map.json:
// `getBotOrder`/`setBotOrder` → `config/*`, `setAgentRoute` → `route/set{agentId, route}`) and that the TUI lacks, plus the
// seven the gap analysis closed (desktop-gaps-1: queue edits, review reads, `setModel`).
const DESKTOP_OVERRIDES: Readonly<Record<string, Override>> = {
  getBotOrder: (_args, { threadId }) => ({ method: 'config/getBotOrder', params: defined({}, threadId) }),
  setBotOrder: ([order], { threadId }) => ({ method: 'config/setBotOrder', params: defined({ order }, threadId) }),
  setAgentRoute: ([agentId, route], { threadId }) => ({
    method: 'route/set',
    params: defined({ agentId, route }, threadId),
  }),
  prioritizeQueued: ([selectedId], { threadId }) => ({
    method: 'turn/steer',
    params: defined({ queuedId: selectedId }, threadId),
  }),
  restoreQueued: ([currentText, selectedId], { threadId }) => ({
    method: 'thread/queue/delete',
    params: defined({ queuedId: selectedId, currentText, restore: true }, threadId),
  }),
  getSessionReviewDiff: (_args, { threadId }) => ({
    method: 'review/diff/get',
    params: defined({ scope: 'session' }, threadId),
  }),
  getSessionReviewFilePatch: ([file, oldPath], { threadId }) => ({
    method: 'review/diff/get',
    params: defined({ scope: 'session', path: file, oldPath }, threadId),
  }),
  // `refresh`/`poll` are dropped: Node's `readTurnReview` ignores them.
  getTurnReviewDiff: ([options], { threadId }) => {
    const { summary, known } = (options ?? {}) as { summary?: unknown; known?: unknown };
    return {
      method: 'review/diff/get',
      params: defined({ scope: 'turn', summary: summary === true ? true : undefined, known }, threadId),
    };
  },
  getTurnReviewFilePatch: ([file], { threadId }) => ({
    method: 'review/diff/get',
    params: defined({ scope: 'turn', path: file }, threadId),
  }),
  getTurnChanges: ([options], { threadId }) => {
    const { checkpointId, patch, file } = (options ?? {}) as { checkpointId?: unknown; patch?: unknown; file?: unknown };
    return {
      method: 'review/diff/get',
      params: defined({ scope: 'turn', checkpointId, patch, path: file }, threadId),
    };
  },
  setModel: ([model], { threadId }) => ({ method: 'route/set', params: defined({ route: { model } }, threadId) }),
};

/** The core request for `capability(...args)` issued by the surface that paints `sessionId` (none = control session).
 *  An action with no Rust op is refused here, before anything is sent: `unknownMethod`. */
export function routeCapability(capability: string, args: readonly unknown[], sessionId?: string): CapabilityRoute {
  const ctx = sessionId ? { threadId: sessionId } : {};
  const override = DESKTOP_OVERRIDES[capability];
  return override ? override(args, ctx) : resolveAction(capability, args, ctx);
}

export interface CapabilityLane {
  invoke<T = unknown>(
    capability: DesktopCapability,
    args: unknown[] | undefined,
    sessionId: string | undefined
  ): Promise<DesktopCapabilityResult<T>>;
  read(requests: ReadonlyArray<DesktopCapabilityReadRequest>): Promise<DesktopCapabilityReadResult[]>;
  /** `SessionHostLifecycle.renameSession` on a core connection: the host's own checks, then `thread/name/set`. */
  renameSession(sessionId: string, title: string): Promise<void>;
  /** The DesktopService session methods a core connection serves itself (there is no Node host: protocol.md §12.3).
   *  `setSessionFavorite`/`setSessionProject` are `thread/metadata/update` (the metadata lives on the thread, SPEC.md metadata
   *  row), `setSessionArchived` is `thread/archive`/`thread/unarchive` (the core cascades over sub-agent sessions). */
  setSessionFavorite(sessionId: string, favorite: boolean): Promise<void>;
  setSessionProject(sessionId: string, projectPath: string): Promise<void>;
  setSessionArchived(sessionId: string, archived: boolean): Promise<void>;
  /** `thread/delete`. A session the core does not have is a no-op, as in Node (`deleteSessionLocked`: deleting a missing session is
   *  never an error surfaced to the UI); the harness case `deleteSession-missing` records Node ok / Rust `threadNotFound`. */
  deleteSession(sessionId: string): Promise<void>;
  /** `thread/backgroundTerminals/terminate` | `release`, answered as the host did: a failed call is `{stopped|released: false, error}`. */
  stopShellJob(sessionId: string, taskId: string): Promise<ShellJobResult>;
  releaseShellJob(sessionId: string, taskId: string): Promise<{ released: boolean; error?: string }>;
  /** The config key `quotaAutoResume` (desktop-services.md A2/D1): read from the `config` section, written with
   *  `config/value/write`; on unless it is `false`. */
  getQuotaAutoResume(): Promise<boolean>;
  setQuotaAutoResume(enabled: boolean): Promise<boolean>;
}

export interface ShellJobResult {
  stopped: boolean;
  unconfirmed?: boolean;
  finished?: boolean;
  error?: string;
}

/** The converted capabilities whose op needs a `threadId`. Node serves them from its control session when the call has
 *  no session, so a call without one is addressed to the control thread. Most have a schema-required `threadId`; four have
 *  an optional one that their handler refuses to go without (`getBranchMenu`, `setOutputStyle`, `setOrchestrationMode`:
 *  `thread_of`), or answers `null` without (`contextStatus`: the daemon has no ambient current session, while Node's control
 *  session answers its own, empty, status record). */
export const THREAD_REQUIRED_CAPABILITIES: ReadonlySet<string> = new Set([
  'rewindToItem',
  'retryFailedTurn',
  'stopShellJobs',
  'releaseShellJob',
  'goalControl',
  'compact',
  'clear',
  'prioritizeQueued',
  'restoreQueued',
  'getBranchMenu',
  'setOutputStyle',
  'setOrchestrationMode',
  'contextStatus',
]);

/** The capabilities served by the core's `mcp/*` and `connector/*` ops: the same set as Node's `MCP_ACTIONS`
 *  (`session-host-transport.ts`). A call of one without a session is addressed to the control thread, whose scope is the
 *  draft scope a request with no `threadId` would have named. */
export const MCP_CAPABILITIES: ReadonlySet<string> = new Set([
  ...ACTION_NAMESPACES.mcp,
  ...ACTION_NAMESPACES.connector,
]);

const failureMessage = (error: unknown): string => {
  const shown = coreErrorForWindow(error);
  return shown instanceof Error ? shown.message : String(shown);
};

const startedThreadId = (started: unknown): string => {
  const id = (started as { thread?: { id?: unknown } } | null)?.thread?.id;
  if (typeof id !== 'string' || !id) throw new Error('The core did not start a control thread.');
  return id;
};

/** Every call is a request of the connection's core. The control thread is started (`thread/start` of `kind: "control"`, the
 *  way Node creates its control session in `ensureControlSession`) on first need and kept. A reply carries the state of the thread the call was addressed to,
 *  read from the core when the reply arrives (`thread/read` without items, folded by the client library's own
 *  `sessionReducer`/`desktopSessionState`, with the `hostShellJobs` section the core pushes): nothing is held between calls.
 *  The pending approvals are the ones the core asked this connection
 *  for (`item/*` server requests), joined by the library's own projection, so `toolApproval` is what Node's reply shows. */
export function createCapabilityLane({
  protocol,
}: {
  protocol: Pick<ProtocolConnection, 'call' | 'snapshot' | 'onEvent' | 'noteUserInput'>;
}): CapabilityLane {
  const request = (method: string, params: unknown): Promise<unknown> =>
    protocol.call(method, params).catch((error: unknown) => {
      throw coreErrorForWindow(error);
    });
  // The approvals the core is waiting on, as the client library's `pendingServerRequests` holds them: added when the core asks,
  // removed when it resolves the ask, all dropped with the socket (the core asks again after a reconnect).
  const pendingApprovals = new Map<string, unknown>();
  protocol.onEvent((event) => {
    if (event.type === 'serverRequest') {
      const asked = (event as { request: { id: unknown; method: string } }).request;
      if (asked.method.startsWith('item/')) pendingApprovals.set(JSON.stringify(asked.id), asked);
    } else if (event.type === 'serverRequestResolved') {
      pendingApprovals.delete(JSON.stringify((event as { params: { requestId?: unknown } }).params.requestId));
    } else if (event.type === 'status' && (event as { status: { state: string } }).status.state !== 'ready') {
      pendingApprovals.clear();
    }
  });
  let control: Promise<string> | null = null;
  const controlThread = (): Promise<string> => {
    if (control) return control;
    const pending = request('thread/start', { kind: 'control' }).then(startedThreadId);
    control = pending;
    // A failed start is tried again by the next call; this one still rejects to its caller.
    pending.catch(() => {
      if (control === pending) control = null;
    });
    return pending;
  };
  const send = async (capability: string, args: readonly unknown[], sessionId?: string): Promise<unknown> => {
    // `noteUserInput(at)` is the `client/activity {at}` notification (rate-limited by the connection), not a request; it has no value.
    if (capability === 'noteUserInput') {
      protocol.noteUserInput(args[0] as number);
      return undefined;
    }
    let thread = sessionId;
    if (!thread && (THREAD_REQUIRED_CAPABILITIES.has(capability) || MCP_CAPABILITIES.has(capability))) {
      // An action with no op fails here, before a thread is started for it.
      routeCapability(capability, args);
      thread = await controlThread();
    }
    // `retryFailedTurn(sessionId, turnKey)` names its thread as its first argument; left out, it is the one addressed.
    const named = capability === 'retryFailedTurn' && !args[0] ? [thread, ...args.slice(1)] : args;
    const { method, params } = routeCapability(capability, named, thread);
    return request(method, params);
  };
  const stateOf = async (threadId: string): Promise<SessionSnapshot> => {
    const read = await request('thread/read', { threadId, window: { none: true } });
    const hostShellJobs = protocol.snapshot().entries.find((entry) => entry.section === 'hostShellJobs')?.value;
    return desktopSessionState(
      sessionReducer.initial(read as Parameters<typeof sessionReducer.initial>[0]),
      [...pendingApprovals.values()] as Parameters<typeof desktopSessionState>[1],
      hostShellJobs as Parameters<typeof desktopSessionState>[2]
    ) as unknown as SessionSnapshot;
  };
  return {
    async invoke<T>(capability: DesktopCapability, args: unknown[] = [], sessionId?: string) {
      const value = (await send(capability, args, sessionId)) as T;
      return { value, snapshot: await stateOf(sessionId ?? (await controlThread())) };
    },
    async setSessionFavorite(sessionId, favorite) {
      await request('thread/metadata/update', { threadId: sessionIdOf(sessionId), favorite });
    },
    async setSessionProject(sessionId, projectPath) {
      await request('thread/metadata/update', { threadId: sessionIdOf(sessionId), projectPath });
    },
    async setSessionArchived(sessionId, archived) {
      await request(archived ? 'thread/archive' : 'thread/unarchive', { threadId: sessionIdOf(sessionId) });
    },
    async deleteSession(sessionId) {
      try {
        await request('thread/delete', { threadId: sessionIdOf(sessionId) });
      } catch (error) {
        const detail = (error as { detail?: { kind?: unknown; data?: { reason?: unknown } } } | null)?.detail;
        if (detail?.kind === 'rpc' && detail.data?.reason === 'threadNotFound') return;
        throw error;
      }
    },
    async stopShellJob(sessionId, taskId) {
      const id = sessionIdOf(sessionId);
      try {
        const result = ((await send('stopShellJob', [taskId], id)) ?? {}) as {
          stopped?: unknown;
          unconfirmed?: unknown;
          finished?: unknown;
          error?: unknown;
        };
        if (result.stopped === true) return { stopped: true };
        return {
          stopped: false,
          ...(result.unconfirmed === true ? { unconfirmed: true } : {}),
          ...(result.finished === true ? { finished: true } : {}),
          error: typeof result.error === 'string' && result.error ? result.error : 'The job was not stopped.',
        };
      } catch (error) {
        return { stopped: false, error: failureMessage(error) };
      }
    },
    async releaseShellJob(sessionId, taskId) {
      const id = sessionIdOf(sessionId);
      try {
        const result = ((await send('releaseShellJob', [taskId], id)) ?? {}) as { released?: unknown; error?: unknown };
        if (result.released === true) return { released: true };
        return {
          released: false,
          error: typeof result.error === 'string' && result.error ? result.error : 'The job was not released.',
        };
      } catch (error) {
        return { released: false, error: failureMessage(error) };
      }
    },
    async getQuotaAutoResume() {
      const config = protocol.snapshot().entries.find((entry) => entry.section === 'config')?.value as
        | { quotaAutoResume?: unknown }
        | undefined;
      return config?.quotaAutoResume !== false;
    },
    async setQuotaAutoResume(enabled) {
      await request('config/value/write', { path: 'quotaAutoResume', value: enabled });
      return enabled;
    },
    // Node's host throws `TypeError('Session title is invalid.')` for a title that is empty once normalized, before the
    // runtime is reached; the core cannot tell that case from a refusal ("Session is not available.", the runtime's `false`,
    // which it sends as a code-less `domainError`), so the host check stays here. `setName` and `publishCatalogs` are the
    // core's own (the title is stored and the section pushed by `thread/name/set`).
    async renameSession(sessionId, title) {
      const id = sessionIdOf(sessionId);
      const normalized = normalizeSessionTitle(title, '');
      if (!normalized) throw new TypeError('Session title is invalid.');
      await send('renameSessionTitle', [id, normalized], id);
    },
    // Node answers every read from the control session and ignores the request's `sessionId`; so does this (an MCP read is
    // addressed to the control thread, as Node's carrier does). Reads are
    // independent getters, answered together; the result order stays positional.
    read: (requests) =>
      Promise.all(
        requests.map(async (item): Promise<DesktopCapabilityReadResult> => {
          try {
            return { ok: true, value: await send(item.capability, item.args ?? []) };
          } catch (error) {
            return { ok: false, error: failureMessage(error) };
          }
        })
      ),
  };
}