// The local core's endpoint from its discovery file (lifecycle-remote.md §4): `core.rpc.port` is present only
// while the core is `serving`, `endpoints.session.token` authenticates the upgrade.
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { RemoteDaemonConnector } from '../ssh/remote-session';
import type { WsEndpoint } from './ws-connector';

export function parseDiscovery(text: string): WsEndpoint {
  const record = JSON.parse(text) as {
    endpoints?: { session?: { token?: unknown } };
    core?: { state?: unknown; rpc?: { port?: unknown } };
  };
  const port = record.core?.rpc?.port;
  const token = record.endpoints?.session?.token;
  if (typeof port !== 'number' || typeof token !== 'string' || !token) {
    throw new Error(`The core is not serving (state ${String(record.core?.state ?? 'unknown')}).`);
  }
  return { url: `ws://127.0.0.1:${port}/rpc`, token };
}

/** A server's core as the SSH tunnel exposes it. The live attachment's discovery is used as is; without one
 *  (first dial, or after an invalidate) the connector bootstraps and brings the tunnel up again. */
export async function resolveTunnelEndpoint(
  connector: Pick<RemoteDaemonConnector, 'connect' | 'currentDiscovery'>,
  log: (line: string) => void = () => {}
): Promise<WsEndpoint> {
  const discovery = connector.currentDiscovery() ?? (await connector.connect(log)).discovery;
  return { url: `ws://127.0.0.1:${discovery.port}/rpc`, token: discovery.token };
}

export async function readLocalDiscovery(runtimeRoot: string): Promise<WsEndpoint> {
  return parseDiscovery(await readFile(join(runtimeRoot, 'daemon.json'), 'utf8'));
}
