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
import type { ProtocolConnection } from './connection';
import { coreErrorForWindow } from './core-error';

export interface CapabilityRoute {
  method: string;
  params: Record<string, unknown>;
}

type Override = (args: readonly unknown[], ctx: { threadId?: string }) => CapabilityRoute;

const defined = (params: Record<string, unknown>, threadId: string | undefined): Record<string, unknown> =>
  Object.fromEntries(Object.entries({ threadId, ...params }).filter(([, value]) => value !== undefined));

// Actions whose Rust op exists under another namespace or name than `<namespace>/<action>` (operations_map.json:
// `getBotOrder`/`setBotOrder` → `config/*`, `setAgentRoute` → `route/set{agentId, route}`) and that the TUI lacks.
const DESKTOP_OVERRIDES: Readonly<Record<string, Override>> = {
  getBotOrder: (_args, { threadId }) => ({ method: 'config/getBotOrder', params: defined({}, threadId) }),
  setBotOrder: ([order], { threadId }) => ({ method: 'config/setBotOrder', params: defined({ order }, threadId) }),
  setAgentRoute: ([agentId, route], { threadId }) => ({
    method: 'route/set',
    params: defined({ agentId, route }, threadId),
  }),
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
}

/** The converted capabilities whose op requires a `threadId`. Node serves them from its control session when the call has
 *  no session, so a call without one is addressed to the control thread. */
export const THREAD_REQUIRED_CAPABILITIES: ReadonlySet<string> = new Set([
  'rewindToItem',
  'retryFailedTurn',
  'stopShellJobs',
  'releaseShellJob',
  'goalControl',
  'compact',
  'clear',
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

/** Every call is a request of the connection's core. The control thread is started (`thread/start`, a task, the way Node
 *  creates its control session) on first need and kept. A reply carries the state of the thread the call was addressed to,
 *  read from the core when the reply arrives (`thread/read` without items, folded by the client library's own
 *  `sessionReducer`/`desktopSessionState`, with the `hostShellJobs` section the core pushes): nothing is held between calls.
 *  The pending approvals are the ones the core asked this connection
 *  for (`item/*` server requests), joined by the library's own projection, so `toolApproval` is what Node's reply shows. */
export function createCapabilityLane({
  protocol,
}: {
  protocol: Pick<ProtocolConnection, 'call' | 'snapshot' | 'onEvent'>;
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
    const pending = request('thread/start', { kind: 'task' }).then(startedThreadId);
    control = pending;
    // A failed start is tried again by the next call; this one still rejects to its caller.
    pending.catch(() => {
      if (control === pending) control = null;
    });
    return pending;
  };
  const send = async (capability: string, args: readonly unknown[], sessionId?: string): Promise<unknown> => {
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