// The phone's `invokeCapability` for the capability groups it answers over the protocol: Node's relay method (remote-methods.ts
// `invokeCapability` at b6f10295a) was the host's request check (shared/capability-request.ts), then the host's call, whose
// failure carried its worktree code in the message (worktree-validation.ts worktreeErrorWithCode) and only its public params
// (coded-error.ts). Here the host's call is the desktop's own capability lane (main/protocol/capability-route.ts
// createCapabilityLane) over the phone's client: the same routing to core methods, the same control thread for a call that names
// no session, the same error framing (main/protocol/core-error.ts).
import type { ProtocolClient, SessionFold } from '../../../../packages/protocol-client/src/index.ts';
import { createCapabilityLane } from '../main/protocol/capability-route';
import type { DesktopCapability } from '../shared/contract';
import type { PhoneProtocolHost } from './remote-shim-protocol';

type Client = ProtocolClient<SessionFold>;

/** The connection's control thread, started once per connection however many calls need it (the lane starts it on first need and
 *  keeps it; a lane is made per call, so the start is shared here). A connection is told by its fold store, which every call's scoped
 *  view of the client shares. */
const controlThreads = new WeakMap<object, Promise<unknown>>();

/** The lane over this call's client: its frames are this call's (the router's send claim). */
function laneOf(client: Client) {
  const call = (method: string, params: unknown): Promise<unknown> => {
    if (method !== 'thread/start' || (params as { kind?: unknown } | null)?.kind !== 'control') {
      return client.call(method as never, params as never);
    }
    const held = controlThreads.get(client.store);
    if (held) return held;
    const started = client.call(method as never, params as never) as Promise<unknown>;
    controlThreads.set(client.store, started);
    // A failed start is tried again by the next call, as the lane's own does.
    started.catch(() => {
      if (controlThreads.get(client.store) === started) controlThreads.delete(client.store);
    });
    return started;
  };
  return createCapabilityLane({
    protocol: {
      call,
      // The sections the lane reads into a call's session state: the host's shell jobs and the config switches.
      snapshot: () => ({ status: 'ready', entries: [...client.store.sections('hostShellJobs'), ...client.store.sections('config')] }),
      noteUserInput: () => undefined,
      respond: (id, answer) => client.respond(id, answer as never),
      pendingServerRequests: () => client.pendingServerRequests(),
    },
  });
}

/** What the page's rebuilt Error carried of a failed relay frame (remote-shim-dispatch.ts at b6f10295a): the message, the error's
 *  own string `code` and its public params as `details`. A lost or closed connection stays the client's error, which the router
 *  turns into the interruption. */
function relayedError(error: unknown): unknown {
  const ended = (error as { detail?: { kind?: string } } | null)?.detail?.kind;
  if (ended === 'connectionLost' || ended === 'clientClosed' || !(error instanceof Error)) return error;
  const { code, details } = error as Error & { code?: unknown; details?: unknown };
  const rebuilt: Error & { code?: string; details?: unknown } = new Error(error.message || 'remote call failed.');
  if (typeof code === 'string' && code) rebuilt.code = code;
  if (details !== undefined) rebuilt.details = details;
  return rebuilt;
}

/** One checked capability call: the lane's answer, value-only where Node's relay sent the value alone. */
export async function invokePhoneCapability(
  host: PhoneProtocolHost,
  request: { capability: string; args: unknown[]; sessionId?: string },
  valueOnly: boolean
): Promise<unknown> {
  try {
    const result = await laneOf(host.client()).invoke(request.capability as DesktopCapability, request.args, request.sessionId);
    return valueOnly ? { value: result.value } : result;
  } catch (error) {
    throw relayedError(error);
  }
}
