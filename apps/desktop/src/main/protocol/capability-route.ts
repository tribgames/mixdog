// The renderer's session capabilities over the one protocol connection (protocol.md §12.3-12.4): `invokeCapability`
// and `readCapabilities` become `<namespace>/<action>` with the positional arguments as the method's named params, and
// the session the call is addressed to as `threadId`. A call without a session is the control session's: no
// `threadId` (a thread-scoped request is `thread_id`, a control one `global(<domain>)`, protocol.md §12 preamble).
// The routing table is the TUI's (`src/standalone/protocol-session`); only actions the TUI does not route are added.
// The control session is a real thread of the core, started on first need and addressed by the ops that require one.
import {
  desktopSessionState,
  sessionReducer,
} from '../../../../../packages/protocol-client/src/index.ts';
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
 *  A pending tool approval is not part of that read, so `toolApproval` is `null` here; it reaches the pane with its server
 *  request. */
export function createCapabilityLane({
  protocol,
}: {
  protocol: Pick<ProtocolConnection, 'call' | 'snapshot'>;
}): CapabilityLane {
  const request = (method: string, params: unknown): Promise<unknown> =>
    protocol.call(method, params).catch((error: unknown) => {
      throw coreErrorForWindow(error);
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
    const thread = sessionId ?? (THREAD_REQUIRED_CAPABILITIES.has(capability) ? await controlThread() : undefined);
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
      [],
      hostShellJobs as Parameters<typeof desktopSessionState>[2]
    ) as unknown as SessionSnapshot;
  };
  return {
    async invoke<T>(capability: DesktopCapability, args: unknown[] = [], sessionId?: string) {
      const value = (await send(capability, args, sessionId)) as T;
      return { value, snapshot: await stateOf(sessionId ?? (await controlThread())) };
    },
    // Node answers every read from the control session and ignores the request's `sessionId`; so does this. Reads are
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