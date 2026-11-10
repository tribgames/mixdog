// Client side of the discovery file (lifecycle spec §4): where a running core listens and the one token that opens
// both of its listeners. The core writes `<runtime root>/daemon.json`; this module only reads it. Callers read it
// anew for every connection attempt because the ports and the token change with every core.
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { resolveRuntimeRoot } from '../../runtime/shared/runtime-root.mjs';

export const DISCOVERY_FILE = 'daemon.json';

export function discoveryPath(root = resolveRuntimeRoot()) {
  return join(root, DISCOVERY_FILE);
}

/** `code`: `absent` (no core is running), `malformed` (not a core's discovery document) or `noRpc`. */
export class CoreDiscoveryError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'CoreDiscoveryError';
    this.code = code;
  }
}

function endpoint(port, token) {
  return Number.isInteger(port) && port > 0 && typeof token === 'string' && token ? { port, token } : null;
}

export function parseDiscovery(text, path) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new CoreDiscoveryError('malformed', `${path}: ${error.message}`);
  }
  const token = parsed?.endpoints?.session?.token;
  const core = parsed?.core;
  if (!Number.isInteger(parsed?.pid) || typeof core?.state !== 'string' || !endpoint(core?.control?.port, token)) {
    throw new CoreDiscoveryError('malformed', `${path}: not a Mixdog core discovery document`);
  }
  return {
    pid: parsed.pid,
    token,
    state: core.state,
    version: core.version,
    build: core.build,
    instanceId: core.instanceId,
    processStartTime: core.processStartTime,
    blocked: core.blocked ?? null,
    drain: core.drain ?? null,
    rpcPort: Number.isInteger(core.rpc?.port) ? core.rpc.port : null,
    controlPort: core.control.port,
  };
}

export async function readCoreDiscovery(path = discoveryPath()) {
  let text;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') throw new CoreDiscoveryError('absent', `no core is running (${path})`);
    throw error;
  }
  return parseDiscovery(text, path);
}

/** The RPC listener and the token that opens it; only a `serving` core has one. */
export function rpcEndpoint(discovery) {
  const found = endpoint(discovery.rpcPort, discovery.token);
  if (!found) throw new CoreDiscoveryError('noRpc', `the core is ${discovery.state} and has no RPC listener`);
  return found;
}

export function controlEndpoint(discovery) {
  return { port: discovery.controlPort, token: discovery.token };
}
