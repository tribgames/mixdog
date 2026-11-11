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
import { exact } from './exact.mjs';
import { FIXTURES_ROOT, commitStage, exactProductIdentity, parseArgs, resolveTree, stageSet, writeJson, writeSetManifest } from './common.mjs';
import { installDeterministicWorld } from './deterministic-world.mjs';
import { recorderProvenance } from './provenance.mjs';

export const NODE_COMMIT = 'b6f10295a2f698afc85332467192de28500bd146';
export const T0 = Date.parse('2026-11-09T12:00:00Z');
const realSetTimeout = globalThis.setTimeout;
const realClearTimeout = globalThis.clearTimeout;
/** A failure bound on one case on the real clock (the product's own timers are virtual and never fire). */
export const CASE_DEADLINE_MS = 60_000;

export async function startRecording({ recorderUrl, set, entry, replay, compare, dataFiles = [], exclusions = [], net = true }) {
  const args = parseArgs();
  const tree = resolveTree(args);
  const only = args.get('only');
  const identity = exactProductIdentity(tree, NODE_COMMIT);
  mkdirSync('D:/mixdog-build/tmp/w22', { recursive: true });
  const dataDir = `D:/mixdog-build/tmp/w22/${set}`;
  rmSync(dataDir, { recursive: true, force: true });
  mkdirSync(dataDir, { recursive: true });
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
      // Every header as it arrived (raw name, arrival order); `host` carries the loopback port, so it is written as the host of the origin the
      // product addressed; the recorder's own x-bench-origin header is left out.
      const headers = [];
      for (let i = 0; i < req.rawHeaders.length; i += 2) if (req.rawHeaders[i].toLowerCase() !== 'x-bench-origin') headers.push([req.rawHeaders[i], req.rawHeaders[i].toLowerCase() === 'host' ? new URL(origin).host : req.rawHeaders[i + 1]]);
      const raw = Buffer.concat(chunks);
      const text = raw.toString('utf8');
      const record = { method: req.method, origin, path: req.url, headers, body: Buffer.from(text, 'utf8').equals(raw) ? text : raw };
      // For the recorder's own code (not recorded): the headers by lower-case name.
      Object.defineProperty(record, 'h', { value: Object.fromEntries(headers.map(([n, v]) => [n.toLowerCase(), v])), enumerable: false });
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

  // Values are stored through the shared `exact` encoder (lib/exact.mjs). A function (a callback the recorder hands the product) has no
  // exact form: it is recorded as the plain object { callback: <name> }; the classes below are recorded as the plain value they carry. Any
  // other live object throws with its path (a case must not record what it cannot hold).
  const asPlain = (value) => {
    if (typeof value === 'function') return { callback: value.name };
    if (Array.isArray(value)) return value.map(asPlain);
    if (value !== null && typeof value === 'object' && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)) return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, asPlain(v)]));
    return value;
  };
  const CLASSES = {
    Headers: (h) => ({ headers: [...h.entries()] }),
    URL: (u) => ({ href: u.href }),
    AbortSignal: (s) => ({ aborted: s.aborted, reason: s.reason }),
    Response: (r) => ({ status: r.status, statusText: r.statusText, url: r.url, headers: [...r.headers.entries()] }),
  };
  const view = (value) => exact(asPlain(value), { classes: CLASSES });
  // Every call the recorder makes to a product export (function, class constructor, instance method) is logged with its exact arguments
  // (viewed at call time), so each case's inputs are in `calls` whether or not the case also declares an `input`. An argument larger than
  // 4000 bytes of JSON is stored once in the set's `shared` table and referenced as {"$shared": n}.
  let current = null;
  const shared = [];
  const sharedIndex = new Map();
  const argView = (arg) => {
    let v;
    try {
      v = view(arg);
    } catch (error) {
      v = { unrecordable: error.message };
    }
    if (v !== null && typeof v === 'object') {
      const text = JSON.stringify(v);
      if (text.length > 4000) {
        let i = sharedIndex.get(text);
        if (i === undefined) {
          i = shared.length;
          shared.push(v);
          sharedIndex.set(text, i);
        }
        return { $shared: i };
      }
    }
    return v;
  };
  const logCall = (entry, args) => void current?.push({ entry, args: args.map(argView) });
  const wrappedCache = new WeakMap();
  const isClass = (fn) => /^class\b/.test(Function.prototype.toString.call(fn));
  const wrapInstance = (name, instance) => new Proxy(instance, {
    get(target, key) {
      const value = Reflect.get(target, key, target);
      if (typeof value !== 'function' || typeof key !== 'string' || key === 'constructor') return value;
      return (...args) => { logCall(`${name}#${key}`, args); return Reflect.apply(value, target, args); };
    },
  });
  const wrapExport = (name, fn) => {
    if (wrappedCache.has(fn)) return wrappedCache.get(fn);
    const wrapped = isClass(fn)
      ? new Proxy(fn, { construct(target, args, newTarget) { logCall(`new ${name}`, args); return wrapInstance(name, Reflect.construct(target, args, newTarget === wrapped ? target : newTarget)); } })
      : Object.assign(Object.defineProperty(function (...args) { logCall(name, args); return Reflect.apply(fn, this, args); }, 'name', { value: fn.name }), fn);
    wrappedCache.set(fn, wrapped);
    return wrapped;
  };
  const wrapModule = (label, ns) => new Proxy(ns, { get: (target, key) => (typeof target[key] === 'function' && typeof key === 'string' ? wrapExport(`${label}.${key}`, target[key]) : target[key]) });
  const cases = [];
  const rec = {
    tree,
    dataDir,
    clock,
    net: hub,
    secrets,
    view,
    load: async (rel) => wrapModule(rel, await import(pathToFileURL(join(tree, rel)).href)),
    P: async (rel) => wrapModule(`src/runtime/${rel}`, await import(pathToFileURL(join(tree, 'src/runtime', rel)).href)),
    write: (name, text) => {
      mkdirSync(join(dataDir, name, '..'), { recursive: true });
      writeFileSync(join(dataDir, name), text);
    },
    async run(id, source, input, fn) {
      if (only && only !== id) return;
      hub.records = [];
      hub.reply = null;
      const row = { id, source, input: view(input) };
      const calls = [];
      current = calls;
      let timer;
      const deadline = new Promise((_, reject) => {
        timer = realSetTimeout(() => reject(new Error(`recorder: case ${id} did not settle within ${CASE_DEADLINE_MS} ms`)), CASE_DEADLINE_MS);
      });
      try {
        const result = await Promise.race([fn({ net: hub, clock }), deadline]);
        row.result = view(result);
      } catch (error) {
        if (/^recorder: case/.test(error?.message ?? '')) throw error;
        row.error = view(error);
      } finally {
        realClearTimeout(timer);
      }
      current = null;
      if (calls.length) row.calls = calls;
      if (hub.records.length) row.requests = hub.records.map((r) => view(r));
      cases.push(row);
    },
    /** Writes `cases.json` + MANIFEST.json of `<set>` and stops the loopback endpoint. */
    async finish(extra = {}) {
      server?.close();
      const finalDir = join(FIXTURES_ROOT, set);
      const stage = stageSet(finalDir);
      writeJson(join(stage, 'cases.json'), { set, nodeCommit: NODE_COMMIT, shared, cases, ...extra });
      writeSetManifest(stage, {
        set,
        recorder: recorderProvenance(recorderUrl).recorder,
        command: `node ${recorderProvenance(recorderUrl).recorder} --tree <exact export of ${NODE_COMMIT}>`,
        identity,
        extra: { ...recorderProvenance(recorderUrl, dataFiles), entry, replay, compare, calls: 'every call the recorder made to a product export (function, class constructor `new X`, instance method `X#m`) with its arguments viewed at call time, in order; an argument over 4000 bytes of JSON is stored once in the set `shared` table and referenced as {"$shared": n}', valueTags: { '{"$cycle":true}': 'a reference back to an ancestor object',  '{"$undefined":true}': 'undefined (a key or array element that held undefined keeps the tag; none is dropped)', '{"$number":"NaN"|"Infinity"|"-Infinity"|"-0"}': 'a number JSON cannot hold', '{"$bigint":"<digits>"}': 'bigint', '{"$date":"<ISO>"}': 'Date', '{"$bytesHex":"<hex>"}': 'Buffer / Uint8Array', '{"$map":[[k,v]...]}': 'Map, insertion order', '{"$set":[v...]}': 'Set, insertion order', '{"$function":"<name>"}': 'a function', '{"$symbol":"<text>"}': 'a symbol' }, ...(net ? { replayExclusions: { 'request headers host, connection, accept, accept-language, sec-fetch-mode, accept-encoding and a `user-agent: node` (the fetch client writes them on a plain-http loopback; a product that sets its own user-agent or accept is compared)': 'written by undici, not by the product; the replay compares the headers the Rust request sets itself and the origin/path as recorded' } } : {}), exclusions: [...exclusions, 'no string is rewritten: the data directory is the fixed D:/mixdog-build/tmp/w22/<set> and the product tree D:/mixdog-build/tmp/b6f-tree (paths as Node produced them, Windows separators where Node wrote them): a replay maps its own temp directory to that prefix', 'net requests: x-stainless-os / -arch / -runtime-version and the user-agent of the SDK client stack carry the recording host\'s OS, architecture and Node version', 'net requests: the recorder\'s x-bench-origin header is left out and `host` is the host of the origin the product addressed (the loopback port is random)'] },
      });
      commitStage(stage, finalDir);
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
