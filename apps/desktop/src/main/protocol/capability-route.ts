// The renderer's session capabilities over the one protocol connection (protocol.md §12.3-12.4): `invokeCapability`
// and `readCapabilities` become `<namespace>/<action>` with the positional arguments as the method's named params, and
// the session the call is addressed to as `threadId`. A call without a session is the control session's: no
// `threadId` (a thread-scoped request is `thread_id`, a control one `global(<domain>)`, protocol.md §12 preamble).
// The routing table is the TUI's (`src/standalone/protocol-session`); only actions the TUI does not route are added.
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

const failureMessage = (error: unknown): string => {
  const shown = coreErrorForWindow(error);
  return shown instanceof Error ? shown.message : String(shown);
};

/** `snapshot` is the shell snapshot this process holds: a core reply carries no session state (it arrives on the
 *  thread feeds), so a capability result repeats what is held instead of replaying a stale session frame. */
export function createCapabilityLane({
  protocol,
  snapshot,
}: {
  protocol: Pick<ProtocolConnection, 'call'>;
  snapshot(): SessionSnapshot;
}): CapabilityLane {
  const send = async (capability: string, args: readonly unknown[], sessionId?: string): Promise<unknown> => {
    const { method, params } = routeCapability(capability, args, sessionId);
    return protocol.call(method, params).catch((error: unknown) => {
      throw coreErrorForWindow(error);
    });
  };
  return {
    async invoke<T>(capability: DesktopCapability, args: unknown[] = [], sessionId?: string) {
      return { value: (await send(capability, args, sessionId)) as T, snapshot: snapshot() };
    },
    // Reads are independent getters, answered together; the result order stays positional.
    read: (requests) =>
      Promise.all(
        requests.map(async (request): Promise<DesktopCapabilityReadResult> => {
          try {
            return { ok: true, value: await send(request.capability, request.args ?? [], request.sessionId) };
          } catch (error) {
            return { ok: false, error: failureMessage(error) };
          }
        })
      ),
  };
}
