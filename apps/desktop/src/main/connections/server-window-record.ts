// A server window's record: what main knows of a server whose window the core asked for (`host/window/open`). The core
// owns the connection (the tunnel, the link, the reconnects); main keeps the id, the name, and the one question a window
// needs answered: where the server's core listens (`connections/endpoint`, asked of this PC's core on every dial, so a
// tunnel the core re-opened is followed). Nothing else of the old per-server connection object lives in this process.
import type { ConnectionEndpoint, ConnectionIdParams, SshOpenEphemeralParams } from '../../../../../packages/protocol/src/index.ts';
import type { CoreEndpoint } from '../core-port/relay';
import { LOCAL_CONNECTION_ID } from './contract';

/** The calls main makes of this PC's core (`ProtocolConnection.call`). */
export interface CoreCaller {
  call(method: string, params: unknown): Promise<unknown>;
}

export interface ServerWindowEndpoint {
  readonly url: string;
  readonly token: string;
}

export interface ServerWindowRecord {
  readonly id: string;
  readonly kind: 'ssh';
  readonly name: string;
  /** Where this server's core listens now; rejects with the core's own error while the server is not connected. */
  endpoint(): Promise<ServerWindowEndpoint>;
}

export function createServerWindowRecord(
  spec: { id: string; kind: 'ssh'; name: string },
  core: CoreCaller
): ServerWindowRecord {
  return {
    id: spec.id,
    kind: spec.kind,
    name: spec.name,
    endpoint: async () => {
      const params: ConnectionIdParams = { connectionId: spec.id };
      const reply = (await core.call('connections/endpoint', params)) as Partial<ConnectionEndpoint> | null;
      if (typeof reply?.url !== 'string' || typeof reply.token !== 'string' || !reply.url || !reply.token) {
        throw new Error(`This PC's core gave no endpoint for the server "${spec.id}".`);
      }
      return { url: reply.url, token: reply.token };
    },
  };
}

export interface ServerWindowsDeps {
  core: CoreCaller;
  /** Opens the record's window, or brings the one already open (or being made) to the front; one window per id. */
  showWindow(record: ServerWindowRecord): Promise<void>;
  /** This PC's core: its url and token (the resolver the main window's own link dials with). */
  localEndpoint(): Promise<ServerWindowEndpoint>;
}

export interface ServerWindows {
  /** The `windows.open` of the host role (host/window/open): false when the window could not be made. */
  open(params: { connectionId: string; kind: 'ssh'; name: string }): Promise<boolean>;
  get(connectionId: string): ServerWindowRecord | undefined;
  /** The window is gone (or never came up): the record is dropped. */
  release(connectionId: string): void;
  /** The relay's endpoints for a window of this connection: `primary` the server's core (host claimant only) and, for a
   *  server window, `pc` this PC's, both under the role `server:<id>`; the main window only has its own. */
  endpointsFor(connectionId: string): Promise<CoreEndpoint[]>;
}

export function createServerWindows(deps: ServerWindowsDeps): ServerWindows {
  const records = new Map<string, ServerWindowRecord>();
  return {
    open: async ({ connectionId, kind, name }) => {
      const record = records.get(connectionId) ?? createServerWindowRecord({ id: connectionId, kind, name }, deps.core);
      records.set(connectionId, record);
      try {
        await deps.showWindow(record);
        return true;
      } catch (error) {
        if (records.get(connectionId) === record) records.delete(connectionId);
        throw error;
      }
    },
    get: (connectionId) => records.get(connectionId),
    release: (connectionId) => void records.delete(connectionId),
    endpointsFor: async (connectionId) => {
      if (connectionId === LOCAL_CONNECTION_ID) {
        const local = await deps.localEndpoint();
        return [{ slot: 'primary', ...local, target: 'local', role: 'main' }];
      }
      const record = records.get(connectionId);
      if (!record) throw new Error(`The server window "${connectionId}" is not open.`);
      const role = `server:${connectionId}` as const;
      const [server, local] = await Promise.all([record.endpoint(), deps.localEndpoint()]);
      return [
        { slot: 'primary', ...server, target: 'server', role },
        { slot: 'pc', ...local, target: 'local', role },
      ];
    },
  };
}

/** `MIXDOG_SSH_TARGET` (development and tests): the core connects the target as a server that is not saved and asks this
 *  desktop for its window (`host/window/open`). Called once the host role has claimed. A refusal rejects with the
 *  failure code. */
export async function openEnvSshTarget(core: CoreCaller, target: string): Promise<void> {
  const params: SshOpenEphemeralParams = { target, name: target };
  const result = (await core.call('connections/ssh/openEphemeral', params)) as { ok?: unknown; failure?: unknown } | null;
  if (result?.ok === true) return;
  const failure = result?.failure as { code?: unknown; kind?: unknown } | undefined;
  const reason = [failure?.code, failure?.kind].find((value) => typeof value === 'string' && value);
  throw new Error(`The server ${target} could not be opened${reason ? `: ${reason}` : '.'}`);
}
