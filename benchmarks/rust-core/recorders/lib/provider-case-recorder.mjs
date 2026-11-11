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
import netModule from 'node:net';
import { createRequire, register } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { exact } from './exact.mjs';
import { FIXTURES_ROOT, commitStage, exactProductIdentity, parseArgs, resolveTree, stageSet, writeJson, writeSetManifest } from './common.mjs';
import { installDeterministicWorld } from './deterministic-world.mjs';
import { recorderProvenance } from './provenance.mjs';
import { RecorderError } from './recorder-error.mjs';
import { startWsWorld } from './ws-world.mjs';

export { RecorderError };

/** Plain descriptions of live objects a replay must rebuild: a stream as its chunks, a Response as status, headers and body bytes, a constructed instance as its constructor arguments. */
const described = new WeakMap();
export const describe = (object, description) => {
  described.set(object, description);
  return object;
};
/** A Response whose body is delivered chunk by chunk (strings or bytes), described as status, headers and the chunks as delivered. */
export const scriptedResponse = (chunks, init = {}) => {
  const encoder = new TextEncoder();
  const bytes = chunks.map((c) => (typeof c === 'string' ? Buffer.from(encoder.encode(c)) : Buffer.from(c)));
  const response = new Response(new ReadableStream({ start(controller) { for (const b of bytes) controller.enqueue(new Uint8Array(b)); controller.close(); } }), init);
  return describe(response, { $response: { status: response.status, statusText: response.statusText, headers: [...response.headers.entries()], bodyChunks: bytes } });
};

export const NODE_COMMIT = 'b6f10295a2f698afc85332467192de28500bd146';
export const T0 = Date.parse('2026-11-09T12:00:00Z');
const realSetTimeout = globalThis.setTimeout;
const realClearTimeout = globalThis.clearTimeout;
/** A failure bound on one case on the real clock (the product's own timers are virtual and never fire). */
export const CASE_DEADLINE_MS = 60_000;

export async function startRecording({ recorderUrl, set, entry, replay, compare, dataFiles = [], exclusions = [], net = true, maskRow = null, pure = {} }) {
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
  const clock = { seq: 0, timers: new Map(), armListeners: new Set(), eventListeners: new Set() };
  // Every observable event of the world wakes the waiters of `clock.advance({ until })`: a timer armed or fired, a request arriving at the endpoint, an entry of the ws world.
  clock.notify = () => { for (const listener of [...clock.eventListeners]) listener(); };
  globalThis.setTimeout = (fn, ms = 0, ...rest) => {
    const id = ++clock.seq;
    clock.timers.set(id, { id, due: world.now() + Math.max(0, Number(ms) || 0), fn, rest, site: new Error().stack });
    for (const listener of [...clock.armListeners]) listener();
    clock.notify();
    // undici's parser records the timer's type right after arming it, so the waiters look again once this synchronous arming has returned.
    if (fn?.name === 'onParserTimeout') queueMicrotask(clock.notify);
    return { id, unref() { return this; }, ref() { return this; }, hasRef: () => true, refresh() { return this; }, [Symbol.toPrimitive]: () => id };
  };
  globalThis.clearTimeout = (timer) => void clock.timers.delete(timer?.id ?? timer);
  /**
   * Moves the virtual clock by `ms`, running every timer that comes due in due-time order. No event-loop turn is counted: a callback that returns
   * a promise is awaited (with a deadline naming the step); any other firing is not waited on here - what it causes is waited for as an event by
   * whoever observes it: the case's `until` (an observable event of the world: a request arriving at the endpoint, a ws-world entry, a timer
   * armed - see `clock.notify`), the next retry timer or the settling of the send (`followRetries`), or the promise the case awaits.
   * Every step is appended to `clock.trace` (the ordered record of the case): the advance, the clock before and after, the
   * timers that fired (due time relative to the start of the recording, in firing order; timer ids and the set of still-armed timers are not recorded: they include the product's incidental background timers, whose number varies between runs).
   */
  clock.trace = [];
  /**
   * A response the scripted endpoint has finished is taken up by the product's HTTP client (undici) as an event of its own: the client reads
   * it to the end and then gives the connection its next timer (the keep-alive timer when idle, the headers timer when it sends the next
   * request), or the connection is destroyed. The clock does not move past a fired timer while such a take-up is outstanding: after each
   * firing it waits (woken by the arming of the client's parser timers and the endpoint's events, with the step deadline) until every
   * finished response's connection has its next client timer, carries a later request, or is destroyed. A connection whose client never
   * armed a parser timer (not undici) is not waited on. Nothing else a firing causes is waited on here: whoever observes it waits for it
   * (`until`, `followRetries`, the case's own awaits).
   */
  const clientSockets = new Map();
  const realNetConnect = netModule.connect;
  netModule.connect = (...args) => {
    const socket = realNetConnect(...args);
    socket.once('connect', () => clientSockets.set(socket.localPort, new WeakRef(socket)));
    return socket;
  };
  const finishedResponses = new Map();
  const TIMEOUT_KEEP_ALIVE_BIT = 8;
  const parserOf = (socket) => {
    const key = socket && Object.getOwnPropertySymbols(socket).find((s) => s.description === 'parser');
    return key ? socket[key] : null;
  };
  const clientTookUp = (port, finishedAt) => {
    const parser = parserOf(clientSockets.get(port)?.deref());
    if (!parser) return true;
    if (parser.socket?.destroyed) return true;
    if (parser.timeoutType & TIMEOUT_KEEP_ALIVE_BIT) return true;
    return hub.records.slice(finishedAt).some((record) => record.connectionPort === port);
  };
  const clientsSettled = () => {
    for (const [port, finishedAt] of finishedResponses) if (clientTookUp(port, finishedAt)) finishedResponses.delete(port);
    return finishedResponses.size === 0;
  };
  const within = async (promise, what) => {
    let timer;
    const limit = new Promise((_, reject) => {
      timer = realSetTimeout(() => reject(new RecorderError(`recorder: clock step did not settle within ${CASE_DEADLINE_MS} ms: ${what}`)), CASE_DEADLINE_MS);
    });
    try {
      return await Promise.race([promise, limit]);
    } finally {
      realClearTimeout(timer);
    }
  };
  clock.advance = async (ms, { until, what = 'clock step' } = {}) => {
    const start = world.now();
    const end = start + ms;
    const step = { advanceMs: ms, fromMs: start - T0, fired: [] };
    for (;;) {
      const next = [...clock.timers.values()].filter((t) => t.due <= end).sort((a, b) => a.due - b.due || a.id - b.id)[0];
      if (!next) break;
      clock.timers.delete(next.id);
      world.advance(Math.max(0, next.due - world.now()));
      step.fired.push({ dueMs: next.due - T0 });
      const returned = next.fn(...next.rest);
      if (returned && typeof returned.then === 'function') await within(returned, `${what}: timer ${next.id} callback`);
      clock.notify();
      await clock.until(clientsSettled, `${what}: timer ${next.id}: the HTTP client taking up the finished responses`);
    }
    world.advance(Math.max(0, end - world.now()));
    if (until) await clock.until(until, what);
    step.toMs = world.now() - T0;
    clock.trace.push(step);
  };
  /** Waits, without moving the clock or recording a step, until `predicate()` holds: woken by the events of the world (see `clock.notify`),
   *  not by turns of the event loop; the deadline names the step. */
  clock.until = (predicate, what) => within(new Promise((resolve) => {
    const check = () => {
      if (!predicate()) return;
      clock.eventListeners.delete(check);
      resolve();
    };
    clock.eventListeners.add(check);
    check();
  }), `${what}: observable event`);
  /**
   * Follows the retries of `promise` (a send that retries): whenever a timer created from `sites` (a pattern over the creating stack: the product's retry sleep function, not its first-byte or idle watchdogs) is armed, the clock
   * moves to it (one recorded step) - the wait for the next arm is woken by the arming itself, with the case deadline. `causes(site)` names the
   * event the firing of a timer created at `site` causes (a predicate over the world, e.g. the retried request arriving at the endpoint) or
   * null when its firing has no consequence to wait for; after such a step the clock does not move again until that event (or the settling of
   * `promise`) - woken by `clock.notify`, with the case deadline. `ready()`, when given, is an event of the world the clock waits for before
   * each step (e.g. the endpoint having seen a connection it ended close). Returns when `promise` settles.
   */
  clock.followRetries = async (promise, { sites = /at (async )?\S*[sS]leep\S* /, what = 'retry backoff', causes = () => null, ready = null } = {}) => {
    let settled = false;
    const done = promise.then(() => { settled = true; clock.notify(); }, () => { settled = true; clock.notify(); });
    while (!settled) {
      const armed = [...clock.timers.values()].filter((t) => sites.test(t.site));
      if (!armed.length) {
        let wake;
        const armedOrDone = new Promise((resolve) => { wake = resolve; clock.armListeners.add(wake); });
        await within(Promise.race([done, armedOrDone]), `${what}: waiting for a retry timer`);
        clock.armListeners.delete(wake);
        continue;
      }
      const next = armed.sort((a, b) => a.due - b.due || a.id - b.id)[0];
      if (ready) await clock.until(() => settled || ready(), `${what}: ready for the next step`);
      if (settled) break;
      const caused = causes(next.site);
      await clock.advance(Math.max(0, next.due - world.now()), { what, until: caused && (() => settled || caused()) });
    }
    return promise;
  };
  /** The armed timers created from a stack matching `sites` (the creating function, e.g. the product's retry sleep), by due time: [{ id, due }]. */
  clock.pendingFrom = (sites) => [...clock.timers.values()].filter((x) => sites.test(x.site)).map((x) => ({ id: x.id, due: x.due - T0 })).sort((a, b) => a.due - b.due || a.id - b.id);
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

  const direct = new Set();
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
      // For the recorder's own waits (not recorded): resolves when the client side of this connection closes.
      Object.defineProperty(record, 'whenClientClosed', { value: new Promise((resolve) => res.on('close', resolve)) });
      // For the clock (not recorded): the client's end of this connection, and the moment the endpoint finished its response.
      Object.defineProperty(record, 'connectionPort', { value: req.socket.remotePort });
      res.on('finish', () => {
        finishedResponses.set(record.connectionPort, hub.records.length);
        clock.notify();
      });
      req.socket.once('close', clock.notify);
      hub.records.push(record);
      clock.notify();
      const reply = hub.reply?.(record, hub.records.length) ?? { status: 404, contentType: 'application/json', body: '{"error":{"message":"not scripted"}}' };
      record.reply = reply;
      if (reply.destroy) {
        // The endpoint resets the connection instead of answering (the client sees a network error).
        req.socket.destroy();
        return;
      }
      // `date` is the one wall-clock header Node adds; fixed so the response heads the product records are stable.
      res.setHeader('date', 'Thu, 01 Jan 2026 00:00:00 GMT');
      res.writeHead(reply.status ?? 200, { 'content-type': reply.contentType ?? 'text/event-stream', ...(reply.headers ?? {}) });
      if (reply.chunks) {
        res.flushHeaders();
        // A scripted stream: every chunk is its own socket write (the write callback is the wait for it), the ordered input of the case.
        for (const chunk of reply.chunks) await new Promise((resolve, reject) => res.write(chunk, (error) => (error ? reject(error) : resolve())));
        if (reply.hold) {
          // The endpoint keeps the response open until the client closes the connection (a cancelled or idle-aborted read); that close is part of the record.
          await record.whenClientClosed;
          record.clientClosedConnection = true;
        } else res.end();
      } else res.end(reply.body);
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    const realFetch = globalThis.fetch;
    globalThis.fetch = (input, init) => {
      const req = input instanceof Request ? input : null;
      const url = new URL(req ? req.url : String(input));
      // A gateway the recorder started itself (its port registered through `rec.allowDirect`) is reached directly; every other address goes to the scripted endpoint.
      if (direct.has(url.port)) return realFetch(input, init);
      const headers = new Headers(init?.headers ?? req?.headers ?? {});
      headers.set('x-bench-origin', url.origin);
      const target = `http://127.0.0.1:${port}${url.pathname}${url.search}`;
      // The response says it came from the address the product asked for (the loopback port is random).
      return realFetch(target, req ? { method: req.method, body: req.body, duplex: 'half', signal: req.signal, ...init, headers } : { ...init, headers }).then((response) => Object.defineProperty(response, 'url', { value: url.href }));
    };
  }

  if (!net) {
    // No scripted endpoint in this recording: a fetch to anything but the recorder's own loopback fails at once - the real network is never reached.
    const realFetch = globalThis.fetch;
    globalThis.fetch = (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (direct.has(url.port)) return realFetch(input, init);
      return Promise.reject(Object.assign(new Error(`recorder: real network is not allowed (net: false): ${url.origin}`), { code: 'ERECORDERNONET' }));
    };
  }

  // Values are stored through the shared `exact` encoder (lib/exact.mjs). A function (a callback the recorder hands the product) has no
  // exact form: it is recorded as the plain object { callback: <name> }; the classes below are recorded as the plain value they carry. Any
  // other live object throws with its path (a case must not record what it cannot hold).
  const asPlain = (value) => {
    if (value !== null && typeof value === 'object' && described.has(value)) return asPlain(described.get(value));
    if (typeof value === 'function') return { callback: value.name };
    if (Array.isArray(value)) return value.map(asPlain);
    if (value !== null && typeof value === 'object' && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)) return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, asPlain(v)]));
    return value;
  };
  const CLASSES = {
    Headers: (h) => ({ headers: [...h.entries()] }),
    URL: (u) => ({ href: u.href }),
    AbortSignal: (s) => ({ aborted: s.aborted, reason: s.reason }),
    AbortController: (c) => ({ aborted: c.signal.aborted, reason: c.signal.reason }),
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
    const v = view(arg);
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
      ? new Proxy(fn, { construct(target, args, newTarget) { logCall(`new ${name}`, args); const instance = Reflect.construct(target, args, newTarget === wrapped ? target : newTarget); const proxy = wrapInstance(name, instance); const description = { $instance: name, constructedWith: args.map(argView) }; described.set(instance, description); described.set(proxy, description); return proxy; } })
      : Object.assign(Object.defineProperty(function (...args) { logCall(name, args); return Reflect.apply(fn, this, args); }, 'name', { value: fn.name }), fn);
    wrappedCache.set(fn, wrapped);
    return wrapped;
  };
  const wrapModule = (label, ns) => new Proxy(ns, { get: (target, key) => (typeof target[key] === 'function' && typeof key === 'string' ? wrapExport(`${label}.${key}`, target[key]) : target[key]) });
  const cases = [];
  let wsWorld = null;
  const rec = {
    tree,
    dataDir,
    clock,
    net: hub,
    secrets,
    view,
    T0,
    describe,
    /** Registers the port of a loopback server the recorder itself started: fetches to it are not redirected to the scripted endpoint. */
    allowDirect: (port) => direct.add(String(port)),
    /** A function the product returned (a fetch, a callback factory result): every call of it is logged with its arguments, like a product export. */
    wrapFn: (name, fn) => wrapExport(name, fn),
    /** A scripted fetch Response (status, headers, body chunks as delivered), recorded as such when handed to the product. */
    response: scriptedResponse,
    /** A real WebSocket server on loopback (lib/ws-world.mjs); closed when the recording finishes. */
    wsWorld: async () => {
      if (!wsWorld) {
        wsWorld = await startWsWorld({ tree });
        wsWorld.onNote = clock.notify;
      }
      return wsWorld;
    },
    /** A product module as it is, its calls not logged (plumbing the recorder drives, not the entry under test). */
    raw: (rel) => import(pathToFileURL(join(tree, 'src/runtime', rel)).href),
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
      clock.trace.length = 0;
      const row = { id, source, input: view(input) };
      const calls = [];
      current = calls;
      let timer;
      const deadline = new Promise((_, reject) => {
        timer = realSetTimeout(() => reject(new RecorderError(`recorder: case ${id} did not settle within ${CASE_DEADLINE_MS} ms`)), CASE_DEADLINE_MS);
      });
      try {
        const result = await Promise.race([fn({ net: hub, clock }), deadline]);
        row.result = view(result);
      } catch (error) {
        // Every recorder-side failure (the case deadline, a clock step's deadline, a ws-world wait, a recorder's own deadline) stops the recording.
        if (error instanceof RecorderError) throw error;
        row.error = view(error);
      } finally {
        realClearTimeout(timer);
      }
      current = null;
      if (calls.length) row.calls = calls;
      // Declared real-clock paths (the recorder's `maskRow`, each named in its manifest exclusions) are replaced by a marker here, never by a global rewrite.
      maskRow?.(row);
      if (clock.trace.length) row.clock = clock.trace.map((x) => ({ ...x }));
      if (hub.records.length) {
        row.requests = hub.records.map((r) => view(r));
        // Declared normalisation (see the manifest exclusions): the three SDK headers that carry the recording host's OS, architecture and Node version.
        for (const request of row.requests) for (const pair of request.headers ?? []) if (/^x-stainless-(os|arch|runtime-version)$/i.test(pair[0])) pair[1] = `<recording host ${pair[0].toLowerCase()}>`;
      }
      cases.push(row);
    },
    /** Writes `cases.json` + MANIFEST.json of `<set>` and stops the loopback endpoint. */
    async finish(extra = {}) {
      server?.close();
      wsWorld?.close();
      // The level of every case (the decided rule): `wire` = the case went through a socket (the request or the upgrade as it arrived is recorded); `pure` = only for a case
      // whose Node test calls a pure function, with the public Rust function of the same input and output named in `pure` ({ '<case id>' | '<prefix>*' | '*': 'path:line fn' }).
      const levelOf = (row) => {
        if (row.requests?.length || JSON.stringify(row.result ?? null).includes('"upgrade-request"')) return { id: row.id, level: 'wire' };
        const key = Object.keys(pure).find((k) => k === row.id || (k.endsWith('*') && row.id.startsWith(k.slice(0, -1))));
        return { id: row.id, level: 'pure', rust: key ? pure[key] : null };
      };
      const levels = cases.map(levelOf);
      const finalDir = join(FIXTURES_ROOT, set);
      const stage = stageSet(finalDir);
      writeJson(join(stage, 'cases.json'), { set, nodeCommit: NODE_COMMIT, shared, cases, ...extra });
      writeSetManifest(stage, {
        set,
        recorder: recorderProvenance(recorderUrl).recorder,
        command: `node ${recorderProvenance(recorderUrl).recorder} --tree <exact export of ${NODE_COMMIT}>`,
        identity,
        extra: { ...recorderProvenance(recorderUrl, dataFiles), levels, entry, replay, compare, calls: 'every call the recorder made to a product export (function, class constructor `new X`, instance method `X#m`) with its arguments viewed at call time, in order; an argument over 4000 bytes of JSON is stored once in the set `shared` table and referenced as {"$shared": n}', values: 'exact (benchmarks/rust-core/recorders/lib/exact.mjs): every input, argument list, result and error is stored through the shared encoder; what JSON cannot hold is a {"$exact": <kind>} tag', describedValues: { '{"$stream": [chunk...]}': 'an async stream the recorder handed the product, as the chunks it yields in order', '{"$response": {status, statusText, headers, bodyChunks}}': 'a fetch Response handed to the product: status, headers (in order) and the body chunks as delivered (bytes)', '{"$instance": name, constructedWith: [args]}': 'an instance of a product class, as the arguments it was constructed with', '{"callback": name}': 'a function the recorder handed the product; its scripted behaviour is the case body' }, ...(net ? { replayExclusions: { 'request headers': 'the whole request as it arrived is recorded and compared: method, path, EVERY header in arrival order (including host, connection, accept, accept-language, sec-fetch-mode, accept-encoding and the client library\'s user-agent) and the body bytes; no header is excluded from the comparison' } } : {}), exclusions: [...exclusions, 'no string is rewritten: the data directory is the fixed D:/mixdog-build/tmp/w22/<set> and the product tree D:/mixdog-build/tmp/b6f-tree (paths as Node produced them, Windows separators where Node wrote them): a replay maps its own temp directory to that prefix', 'net requests: the VALUES of the request headers x-stainless-os, x-stainless-arch and x-stainless-runtime-version (the SDK client stack writes the recording host\'s OS, architecture and Node version) are replaced by the marker `<recording host <header name>>` at exactly those header names; every other header is recorded and compared as it arrived', 'net requests: the recorder\'s x-bench-origin header is left out and `host` is the host of the origin the product addressed (the loopback port is random)'] },
      });
      commitStage(stage, finalDir);
      console.log(`${set}: ${cases.length} case(s) recorded`);
      process.exit(0);
    },
  };
  return rec;
}

/** An async iterable over `values`. */
export async function* streamGenerator(values) {
  yield* values;
}
export const stream = (values) => describe(streamGenerator(values), { $stream: values });

/** A Chat Completions SSE body from chunk objects. */
export const sseBody = (events, named = false) => events.map((e) => `${named ? `event: ${e.type}\n` : ''}data: ${JSON.stringify(e)}\n\n`).join('');
