import type { ProtocolClient, SessionFold } from '../../../../packages/protocol-client/src/index.ts';
import { createCapabilityLane } from '../main/protocol/capability-route';
import { DESKTOP_READ_CAPABILITIES, type DesktopCapability } from '../shared/contract';
import type { PhoneProtocolHost } from './remote-shim-protocol';
import { phoneTransferCall } from './remote-transfer-call';

type Client = ProtocolClient<SessionFold>;

/** The connection's control thread, started once per connection however many calls need it (the lane starts it on first need and
 *  keeps it; a lane is made per call, so the start is shared here). A connection is told by its fold store, which every call's scoped
 *  view of the client shares. */
const controlThreads = new WeakMap<object, Promise<unknown>>();

/** `client.call` for a capability lane made over this call's client: a `thread/start` of `kind: "control"` is answered by the
 *  connection's one control thread (started by the first call that needs it), so a lane made per call never starts another. */
export function callSharingControlThread(client: Client): (method: string, params: unknown) => Promise<unknown> {
  /** Whether the client still holds the thread a start answered with: the library subscribes a control thread it started again
   *  after each redial, and drops it when the core no longer has it (or the client is another one: the store is the client's). */
  const stillHeld = async (reply: unknown): Promise<boolean> => {
    const id = (reply as { thread?: { id?: unknown } } | null)?.thread?.id;
    const library = client as {
      threadSubscription?(threadId: string): { readonly held: boolean };
      whenHeldSettled?(threadId: string): Promise<void>;
    };
    if (typeof id !== 'string' || !library.threadSubscription) return true;
    // Settled first: after a redial the client's resume of the thread decides whether it is still the core's.
    await library.whenHeldSettled?.(id);
    return library.threadSubscription(id).held;
  };
  return async (method: string, params: unknown): Promise<unknown> => {
    if (method !== 'thread/start' || (params as { kind?: unknown } | null)?.kind !== 'control') {
      return phoneTransferCall(client, method, params);
    }
    for (;;) {
      let known = controlThreads.get(client.store);
      if (!known) {
        const started = client.call(method as never, params as never) as Promise<unknown>;
        controlThreads.set(client.store, started);
        // A failed start is tried again by the next call, as the lane's own does.
        started.catch(() => {
          if (controlThreads.get(client.store) === started) controlThreads.delete(client.store);
        });
        known = started;
      }
      const reply = await known;
      if (await stillHeld(reply)) return reply;
      if (controlThreads.get(client.store) === known) controlThreads.delete(client.store);
    }
  };
}

/** The lane over this call's client: its frames are this call's (the router's send claim). */
function laneOf(client: Client) {
  return createCapabilityLane({
    protocol: {
      call: callSharingControlThread(client),
      // The sections the lane reads into a call's session state: the host's shell jobs, the remote channel's session and the
      // config switches.
      snapshot: () => ({
        status: 'ready',
        entries: [
          ...client.store.sections('hostShellJobs'),
          ...client.store.sections('hostState' as never),
          ...client.store.sections('config'),
        ],
      }),
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
  const { code, details, detail } = error as Error & { code?: unknown; details?: unknown; detail?: unknown };
  const rebuilt: Error & { code?: string; details?: unknown; detail?: unknown } = new Error(
    error.message || 'remote call failed.'
  );
  if (typeof code === 'string' && code) rebuilt.code = code;
  if (details !== undefined) rebuilt.details = details;
  // The client library's failure stays readable by its kind.
  if (detail !== undefined) rebuilt.detail = detail;
  return rebuilt;
}

const READ_CAPABILITIES: ReadonlySet<string> = new Set(DESKTOP_READ_CAPABILITIES);

/** One checked capability call: the lane's answer, value-only where Node's relay sent the value alone. */
export async function invokePhoneCapability(
  host: PhoneProtocolHost,
  request: { capability: string; args: unknown[]; sessionId?: string },
  valueOnly: boolean
): Promise<unknown> {
  try {
    const lane = laneOf(host.client());
    const capability = request.capability as DesktopCapability;
    // A read changes nothing of the session, so the state read that would answer beside it is not asked of the core.
    return valueOnly || READ_CAPABILITIES.has(request.capability)
      ? await lane.invokeValue(capability, request.args, request.sessionId)
      : await lane.invoke(capability, request.args, request.sessionId);
  } catch (error) {
    throw relayedError(error);
  }
}
