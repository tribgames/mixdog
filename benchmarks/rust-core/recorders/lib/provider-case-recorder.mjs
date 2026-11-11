// Shared plumbing of the per-test-file provider recorders: one deterministic Node world over the exact b6f tree, the cases of one
// Node test file run against the product's real entry points, and the result written as `cases.json` plus `MANIFEST.json`.
//
// World: env scrubbed and pointed at a temp data directory (normalised in every recorded string), a virtual clock (`Date.now` and
// `setTimeout` follow `clock`; a timer runs only when `clock.advance` reaches it), fixed pid and random draws, no OS keychain
// (a stub), no ACL child process, and every `fetch` redirected to a scripted loopback endpoint that records the request as it
// arrived (origin the product addressed, path, headers in arrival order, body bytes) and answers from `net.reply`.
//
// A case is `rec.run(id, source, input, fn)`: `fn(ctx)` returns the observable result; a throw is recorded as the error (name,
// message, code and every other own property). `source` is `<test file>:<line>` of the Node test case. Nothing is filtered but the
// strings normalised in `view` (data/tree paths).
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { createRequire, register } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { FIXTURES_ROOT, commitStage, exactProductIdentity, parseArgs, resolveTree, stageSet, writeJson, writeSetManifest } from './common.mjs';
import { installDeterministicWorld } from './deterministic-world.mjs';
import { recorderProvenance } from './provenance.mjs';

export const NODE_COMMIT = 'b6f10295a2f698afc85332467192de28500bd146';
export const T0 = Date.parse('2026-11-09T12:00:00Z');
const realSetTimeout = globalThis.setTimeout;
const realClearTimeout = globalThis.clearTimeout;
/** A failure bound on one case on the real clock (the product's own timers are virtual and never fire). */
export const CASE_DEADLINE_MS = 60_000;

export async function startRecording({ recorderUrl, set, entry, replay, dataFiles = [], exclusions = [], net = true }) {
  const args = parseArgs();
  const tree = resolveTree(args);
  const only = args.get('only');
  const identity = exactProductIdentity(tree, NODE_COMMIT);
  mkdirSync('D:/mixdog-build/tmp/w22', { recursive: true });
  const dataDir = mkdtempSync(`D:/mixdog-build/tmp/w22/${set}-`);
  process.env.MIXDOG_DATA_DIR = dataDir;
  process.env.MIXDOG_HOME = join(dataDir, 'home');
  process.env.HOME = process.env.USERPROFILE = join(dataDir, 'home');
  process.env.MIXDOG_USAGE_LEDGER_PATH = ':memory:';
  process.env.MIXDOG_QUIET_PROVIDER_LOG = '1';
  process.env.MIXDOG_AGENT_TRACE_DISABLE = '1';
  process.env.MIXDOG_AGENT_TRACE_LOCAL_DISABLE = '1';
  process.env.MIXDOG_DISABLE_LIVE_CLI_VERSIONS = '1';
  process.env.TZ = 'UTC';
  for (const k of Object.keys(process.env)) if (/API_KEY|TOKEN|SECRET|^MIXDOG_(XAI|OAI)_/.test(k)) delete process.env[k];

  const world = installDeterministicWorld({ start: T0, pid: 4242 });
  let seed = 0x2545f491;
  Math.random = () => {
    seed = (Math.imul(seed ^ (seed >>> 15), 0x2c1b3c6d) + 0x6d2b79f5) >>> 0;
    return seed / 4294967296;
  };
  const clock = { seq: 0, timers: new Map() };
  globalThis.setTimeout = (fn, ms = 0, ...rest) => {
    const id = ++clock.seq;
    clock.timers.set(id, { id, due: world.now() + Math.max(0, Number(ms) || 0), fn, rest });
    return { id, unref() { return this; }, ref() { return this; }, hasRef: () => true, refresh() { return this; }, [Symbol.toPrimitive]: () => id };
  };
  globalThis.clearTimeout = (timer) => void clock.timers.delete(timer?.id ?? timer);
  /** Moves the virtual clock by `ms`, running every timer that comes due in due-time order (microtasks drained between). */
  clock.advance = async (ms) => {
    const end = world.now() + ms;
    for (;;) {
      const next = [...clock.timers.values()].filter((t) => t.due <= end).sort((a, b) => a.due - b.due || a.id - b.id)[0];
      if (!next) break;
      clock.timers.delete(next.id);
      world.advance(Math.max(0, next.due - world.now()));
      next.fn(...next.rest);
      for (let i = 0; i < 20; i += 1) await Promise.resolve();
    }
    world.advance(Math.max(0, end - world.now()));
  };
  clock.pending = () => [...clock.timers.values()].map((t) => ({ due: t.due - T0 })).sort((a, b) => a.due - b.due);

  const secrets = {};
  const keychain = createRequire(join(tree, 'package.json'))('./src/lib/keychain-cjs.cjs');
  keychain.getSecret = (account) => secrets[account] ?? null;
  keychain.getSecretAsync = async (account) => secrets[account] ?? null;
  keychain.hasSecret = (account) => Boolean(secrets[account]);
  const permissionsStub = [
    'export function disableOwnerOnlyAclSyncBridgeForTests() {}',
    'export async function prewarmOwnerOnlyAclWin32() {}',
    'export function ownerOnlyAclHelperForTests() { return null; }',
    'export function enforceOwnerOnlyAclWin32() {}',
    'export async function enforceOwnerOnlyAclWin32Async() {}',
    'export async function enforceOwnerOnlyDirectoryWin32Async() {}',
  ].join('\n');
  const hooks = `export async function load(url, context, next) {
  if (url.endsWith('/src/runtime/shared/file-permissions.mjs')) return { format: 'module', source: ${JSON.stringify(permissionsStub)}, shortCircuit: true };
  return next(url, context);
}`;
  register(`data:text/javascript,${encodeURIComponent(hooks)}`);

  const hub = { records: [], reply: null };
  let server = null;
  if (net) {
    server = http.createServer(async (req, res) => {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const origin = req.headers['x-bench-origin'];
      const order = req.rawHeaders.filter((_v, i) => i % 2 === 0).map((n) => n.toLowerCase()).filter((n) => n !== 'x-bench-origin');
      const headers = {};
      for (const name of order) headers[name] = name === 'host' ? new URL(origin).host : req.headers[name];
      const record = { method: req.method, origin, path: req.url, headers, body: Buffer.concat(chunks).toString('utf8') };
      hub.records.push(record);
      const reply = hub.reply?.(record, hub.records.length) ?? { status: 404, contentType: 'application/json', body: '{"error":{"message":"not scripted"}}' };
      record.reply = reply;
      res.writeHead(reply.status ?? 200, { 'content-type': reply.contentType ?? 'text/event-stream', ...(reply.headers ?? {}) });
      res.end(reply.body);
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    const realFetch = globalThis.fetch;
    globalThis.fetch = (input, init) => {
      const req = input instanceof Request ? input : null;
      const url = new URL(req ? req.url : String(input));
      const headers = new Headers(init?.headers ?? req?.headers ?? {});
      headers.set('x-bench-origin', url.origin);
      const target = `http://127.0.0.1:${port}${url.pathname}${url.search}`;
      return realFetch(target, req ? { method: req.method, body: req.body, duplex: 'half', signal: req.signal, ...init, headers } : { ...init, headers });
    };
  }

  const norm = (text) => text.replaceAll(dataDir, '<data>').replaceAll(dataDir.replaceAll('/', '\\'), '<data>').replaceAll(tree.replaceAll('\\', '/'), '<tree>').replaceAll(tree, '<tree>');
  const view = (value, depth = 0) => {
    if (depth > 24) return '[depth]';
    if (value === undefined) return undefined;
    if (value === null || typeof value === 'boolean') return value;
    if (typeof value === 'number') return Number.isFinite(value) ? value : String(value);
    if (typeof value === 'string') return norm(value);
    if (typeof value === 'bigint') return `${value}n`;
    if (typeof value === 'function') return '[function]';
    if (typeof value === 'symbol') return String(value);
    if (value instanceof Error) {
      const out = { name: value.name, message: norm(value.message) };
      for (const key of Object.keys(value)) out[key] = view(value[key], depth + 1);
      if (value.cause !== undefined) out.cause = view(value.cause, depth + 1);
      return out;
    }
    if (Buffer.isBuffer(value) || value instanceof Uint8Array) return { bytesHex: Buffer.from(value).toString('hex') };
    if (value instanceof Map) return { map: [...value].map(([k, v]) => [view(k, depth + 1), view(v, depth + 1)]) };
    if (value instanceof Set) return { set: [...value].map((v) => view(v, depth + 1)) };
    if (value instanceof Date) return { date: value.toISOString() };
    if (Array.isArray(value)) return value.map((v) => view(v, depth + 1) ?? null);
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      const seen = view(v, depth + 1);
      if (seen !== undefined) out[k] = seen;
    }
    return out;
  };

  const cases = [];
  const rec = {
    tree,
    dataDir,
    clock,
    net: hub,
    secrets,
    view,
    norm,
    load: (rel) => import(pathToFileURL(join(tree, rel)).href),
    P: (rel) => import(pathToFileURL(join(tree, 'src/runtime', rel)).href),
    write: (name, text) => {
      mkdirSync(join(dataDir, name, '..'), { recursive: true });
      writeFileSync(join(dataDir, name), text);
    },
    async run(id, source, input, fn) {
      if (only && only !== id) return;
      hub.records = [];
      hub.reply = null;
      const row = { id, source, input: view(input) };
      let timer;
      const deadline = new Promise((_, reject) => {
        timer = realSetTimeout(() => reject(new Error(`recorder: case ${id} did not settle within ${CASE_DEADLINE_MS} ms`)), CASE_DEADLINE_MS);
      });
      try {
        const result = await Promise.race([fn({ net: hub, clock }), deadline]);
        row.result = view(result) ?? null;
      } catch (error) {
        if (/^recorder: case/.test(error?.message ?? '')) throw error;
        row.error = view(error);
      } finally {
        realClearTimeout(timer);
      }
      if (hub.records.length) row.requests = hub.records.map((r) => view(r));
      cases.push(row);
    },
    /** Writes `cases.json` + MANIFEST.json of `<set>` and stops the loopback endpoint. */
    async finish(extra = {}) {
      server?.close();
      const finalDir = join(FIXTURES_ROOT, set);
      const stage = stageSet(finalDir);
      writeJson(join(stage, 'cases.json'), { set, nodeCommit: NODE_COMMIT, cases, ...extra });
      writeSetManifest(stage, {
        set,
        recorder: recorderProvenance(recorderUrl).recorder,
        command: `node ${recorderProvenance(recorderUrl).recorder} --tree <exact export of ${NODE_COMMIT}>`,
        identity,
        extra: { ...recorderProvenance(recorderUrl, dataFiles), entry, replay, exclusions: [...exclusions, 'the temp data directory and the tree path are written <data> / <tree> in every string (they differ per run)', 'JSON drops keys whose value is undefined; an Error is recorded as name, message and every own property, never its stack'] },
      });
      commitStage(stage, finalDir);
      rmSync(dataDir, { recursive: true, force: true });
      console.log(`${set}: ${cases.length} case(s) recorded`);
      process.exit(0);
    },
  };
  return rec;
}

/** An async iterable over `values`. */
export async function* stream(values) {
  yield* values;
}

/** A Chat Completions SSE body from chunk objects. */
export const sseBody = (events, named = false) => events.map((e) => `${named ? `event: ${e.type}\n` : ''}data: ${JSON.stringify(e)}\n\n`).join('');
