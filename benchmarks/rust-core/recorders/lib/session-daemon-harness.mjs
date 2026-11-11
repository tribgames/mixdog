// Harness shared by the session-transport recorders (record-session-transport-*.mjs): the product's own test
// scaffold (`scripts/session-transport/_shared.mjs` of the Node tree: real session service + real HTTP/SSE transport
// on 127.0.0.1 + real session client, a STUB session runtime), plus a logging `withDaemon` and the normaliser that
// makes the recording byte-identical across runs. Nothing here is code under test.
//
// Waits are events with a deadline: `signal.until(predicate, label)` re-checks after every `signal.notify()` (an
// SSE frame, a client registration change) and rejects at the deadline with a message naming the step.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const DEADLINE_MS = 10_000;

export class Signal {
  constructor() { this.waiters = new Set(); }
  notify() { for (const check of [...this.waiters]) check(); }
  until(predicate, label, ms = DEADLINE_MS) {
    return new Promise((resolve, reject) => {
      const check = () => {
        let value;
        try { value = predicate(); } catch (error) { cleanup(); reject(error); return; }
        if (value) { cleanup(); resolve(value); }
      };
      const timer = setTimeout(() => { cleanup(); reject(new Error(`timed out waiting for: ${label}`)); }, ms);
      const cleanup = () => { clearTimeout(timer); this.waiters.delete(check); };
      this.waiters.add(check);
      check();
    });
  }
}

/** The per-case normaliser. Declared in every manifest that uses it (see `NORMALISED`). */
export function createNormaliser(runtimeRoot) {
  const clients = new Map();
  const sessions = new Map();
  let epochBase = null;
  const label = (map, prefix, key) => { if (!map.has(key)) map.set(key, `<${prefix} ${map.size + 1}>`); return map.get(key); };
  const text = (value) => {
    let out = value;
    for (const token of clients.keys()) out = out.split(token).join(clients.get(token));
    out = out.replace(/sess_daemon_\d+_[0-9a-f]{32}/g, (id) => label(sessions, 'daemon session', id));
    out = out.split(runtimeRoot).join('<runtime root>').split(process.cwd()).join('<cwd>');
    return out;
  };
  const norm = (value, key = '') => {
    if (typeof value === 'string') return text(value);
    if (typeof value === 'number') {
      if (/revision$/i.test(key) && value > 1e12) { epochBase ??= value; return `<epoch revision>+${value - epochBase}`; }
      if ((key === 'leadPid' || key === 'pid') && value === process.pid) return '<pid>';
      if ((key === 'leadPid' || key === 'pid') && value === process.ppid) return '<ppid>';
      return value;
    }
    if (Array.isArray(value)) return value.map((item) => norm(item, key));
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, norm(v, k)]));
    return value;
  };
  return { norm, clientLabel: (token) => label(clients, 'client', token), clients, sessions };
}

export const NORMALISED = [
  'client tokens (random uuid) -> <client N> by first appearance; daemon session ids sess_daemon_<ms>_<32 hex> -> <daemon session N>',
  'revision / baseRevision values above 1e12 (epoch-based, restart-monotonic) -> <epoch revision>+offset from the first one seen in the case',
  'the runtime root temp dir -> <runtime root>, this process\'s cwd -> <cwd>, its pid/ppid in leadPid fields -> <pid>/<ppid>',
  'queuedMs of a service call (time in the lane) is not recorded: it is a wall-clock measure',
];

/** `{ ok }` / `{ error: { message, code } }` of a client call, normalised. */
export async function callOutcome(norm, promise) {
  try { return { ok: norm(await promise) }; } catch (error) {
    return { error: { message: norm(String(error?.message ?? error)), code: error?.code ?? null } };
  }
}

/**
 * The test scaffold's `withDaemon`, with every call the service receives logged (`calls`: name, args, context,
 * outcome) and a `signal` poked on every client registration change. `S` is the tree's `_shared.mjs` module.
 */
export async function withLoggedDaemon(S, norm, ids, run, { sessionFactory = async () => S.createStubSessionRuntime(), desktopRuntime = null } = {}) {
  const calls = [];
  const signal = new Signal();
  let clientsEmptyReason = null;
  const service = S.createSessionService({ createSessionRuntime: sessionFactory, publishIntervalMs: 5, onFrame: (frame, targets) => transport.broadcast(frame, targets), idleEvictMs: null, softRssMb: null, desktopRuntime });
  const transport = S.createSessionTransport({
    handleCall: async (name, args, ctx) => {
      const entry = { name, args: norm(args), context: norm({ clientToken: ids.clientLabel(ctx?.clientToken ?? ''), leadPid: ctx?.leadPid ?? null, cwd: ctx?.cwd ?? null, revision: ctx?.revision ?? 0 }) };
      calls.push(entry);
      try {
        const result = await service.handleCall(name, args, ctx);
        entry.result = norm(result);
        return result;
      } catch (error) {
        entry.error = { message: norm(String(error?.message ?? error)), code: error?.code ?? null };
        throw error;
      } finally { signal.notify(); }
    },
    clientGraceMs: 50,
    onClientsEmpty: () => { clientsEmptyReason = 'empty'; signal.notify(); },
    onClientDropped: (token) => { service.releaseClient(token); signal.notify(); },
  });
  const { port, token } = await transport.start();
  const discovery = { pid: process.pid, port, token };
  // createSession (the remote runtime client) finds the daemon through this file, as the product does.
  writeFileSync(join(S.RUNTIME_ROOT, 'daemon.json'), JSON.stringify({ pid: process.pid, startedAt: Date.now(), endpoints: { session: { port, token } } }));
  try {
    return await run({ transport, service, discovery, calls, signal, clientsEmpty: () => clientsEmptyReason });
  } finally {
    await service.stop('recorder end');
    await transport.stop();
  }
}

