// The renderer's own protocol client: the client library's `connect` over a MessagePort to this window's core, with the
// identity the main process's connection had (open-core.ts) and no host role (no `host`, no `modelProxy`).
// A main window has one client (slot `primary`). A server window has two: `primary` is its server's core and `pc` is this
// PC's core (role `server:<id>`); `pcCoreClient()` answers with the one that is this PC's.
import {
  connect,
  sessionReducer,
  type ProtocolClient,
  type SessionFold,
} from '../../../../../packages/protocol-client/src/index.ts';
import type { InitializeResponse } from '../../../../../packages/protocol/src/index';
import { createPortConnector, type CorePortBridge, type PortSlot } from './port-connector.ts';

export interface OpenDirectClientOptions {
  bridge: CorePortBridge;
  version: string;
  build?: string;
  /** Which port the client rides on. A client on `pc` is the server window's link to this PC's core. */
  slot?: PortSlot;
}

/** The window as the core's initialize reply names it (`connection.window`): absent from a core that predates Window scope. */
export interface CoreWindowInfo {
  readonly role?: string;
  readonly [key: string]: unknown;
}

const clients = new Map<PortSlot, ProtocolClient<SessionFold>>();
const windows = new Map<PortSlot, CoreWindowInfo | undefined>();
let warnedWindowScope = false;
// Only a server window opens slot `pc` (its link to this PC's core, role `server:<id>`): set when that open is asked for,
// so the server's own primary client is never taken for this PC's while the pc client is still opening.
let serverWindow = false;

/** `connection.window` of an initialize reply, or undefined (said once, at warn level, that the core predates it). */
// Only the connection is read: the client library's reply type comes from @mixdog/protocol, which may be an older copy
// of the generated types than packages/protocol (its capabilities lack fields this file does not read).
export function windowOfReply(reply: Pick<InitializeResponse, 'connection'> | undefined): CoreWindowInfo | undefined {
  const window = (reply?.connection as { window?: CoreWindowInfo } | undefined)?.window;
  if (window) return window;
  if (!warnedWindowScope) {
    warnedWindowScope = true;
    console.warn('core predates Window scope');
  }
  return undefined;
}

export async function openDirectClient(o: OpenDirectClientOptions): Promise<ProtocolClient<SessionFold>> {
  const slot: PortSlot = o.slot ?? 'primary';
  if (slot === 'pc') serverWindow = true;
  const client = await connect<SessionFold>({
    target: { id: slot === 'pc' ? 'pc' : 'core' },
    connector: createPortConnector(o.bridge),
    clientInfo: {
      name: 'mixdog-desktop-window',
      title: 'Mixdog Desktop',
      version: o.version,
      kind: 'desktop',
      ...(o.build ? { build: o.build } : {}),
    },
    capabilities: { approvalsInbox: true },
    threadReducer: sessionReducer,
    clock: { sleep: (ms) => new Promise((done) => setTimeout(done, ms)) },
    random: Math.random,
  });
  clients.set(slot, client);
  windows.set(slot, windowOfReply(client.server));
  return client;
}

/** The window this renderer is, from the primary client's initialize reply; undefined before it opens or on an older core. */
export function directWindow(): CoreWindowInfo | undefined {
  return windows.get('primary');
}

/** The client to this PC's core: the primary one in a main window, the one on slot `pc` in a server window
 *  (role `server:<id>`). Null until that client is open. */
export function pcCoreClient(): ProtocolClient<SessionFold> | null {
  const isServer =
    serverWindow || [...windows.values()].some((w) => typeof w?.role === 'string' && w.role.startsWith('server:'));
  return clients.get(isServer ? 'pc' : 'primary') ?? null;
}

/** Forgets a slot's client (it was closed, or replaced by a reopen). */
export function forgetDirectClient(slot: PortSlot = 'primary'): void {
  clients.delete(slot);
  windows.delete(slot);
  if (clients.size === 0) serverWindow = false;
}
