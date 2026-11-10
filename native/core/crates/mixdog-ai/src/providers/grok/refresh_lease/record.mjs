// Records what Node's own Grok token refresh (b6f10295a: `GrokOAuthProvider.ensureAuth`, grok-oauth.mjs:338-399, and
// `refreshTokens`, grok-oauth-tokens.mjs:384-433, under `withFileLock`, shared/file-lock.mjs) decides over a grid of
// cases: the margin, the lease's wait and expiry, the takeover of a stale lease, a credential another process rewrites
// while the caller waits, the refresh attempts and the grace window, and concurrent callers of one owner and of two
// owners in one process. Two real processes are `processes.mjs`'s.
// The cases are written into `node-recorded.json` beside what Node did in each, and the core replays them
// (`refresh_lease/tests.rs`). It writes the set's MANIFEST.json and refuses a tree that is not exactly b6f10295a.
//
// Two owners in one process: the tree's modules are loaded twice (a resolve hook gives every module of the tree a
// `?copy=A` or `?copy=B` copy), so each copy has its own file-lock owner token and line, its own refreshes in flight,
// its own provider. Both share the pid, which `ownerIsLive` takes for live without asking the system
// (file-lock.mjs:138-148): a dead holder and a foreign pid are `processes.mjs`'s cases.
//
// Inputs that are fixed, not observed:
// - the clock: `Date.now()` is a virtual clock that starts each case at T0, and every timer of the product's code is a
//   virtual timer, fired in due-time then registration order, one at a time, with microtasks drained between. The only
//   timers left real are the Windows ACL helper's (shared/file-permissions.mjs: its request deadline, cleared when the
//   helper answers): while one is outstanding the clock does not move. The helper and the sync bridge are started
//   before the first case, so no case waits on their start;
// - `Math.random()` is 0.5 (the jitter of the lease waits and of the refresh backoff);
// - `node:fs/promises` completes each call synchronously (the same call through its `fs` twin, settled in a
//   microtask): the lease's file steps take no time on the clock, as the core's do;
// - the token endpoint is a script: `fetch` answers each request with the case's next reply after its `afterMs` on
//   the virtual clock;
// - the credential file of the case is bound through the auth bindings (`mixdog.providerAuthBindings`).
// Observed per case: each token request (its time, the process, the url and the form body), each lease or backoff
// wait as it fires (the timers set by shared/sleep.mjs and by grok-oauth-tokens.mjs), each caller's result (the access
// token, or the error's message, status, code and `reauthRequired`), and at the end the credential file's text and the
// names in its directory.
// Usage: node record.mjs --tree <git archive export of b6f10295a, with node_modules>
import { AsyncLocalStorage, AsyncResource } from 'node:async_hooks';
import { createRequire, register, syncBuiltinESMExports } from 'node:module';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..', '..', '..', '..', '..', '..', '..', '..');
const { commitStage, exactProductIdentity, parseArgs, resolveTree, sha256, stageSet, writeJson, writeSetManifest } = await import(
  pathToFileURL(join(repo, 'benchmarks/rust-core/recorders/lib/common.mjs')).href
);

const COMMIT = 'b6f10295a2f698afc85332467192de28500bd146';
const finalDir = join(repo, 'native/core/fixtures/grok-refresh-lease');
const recorder = relative(repo, fileURLToPath(import.meta.url)).replaceAll('\\', '/');
const args = parseArgs();
const tree = resolveTree(args);
const identity = exactProductIdentity(tree, COMMIT);
const only = args.get('only') ?? null;

const T0 = 1_800_000_000_000;
const SKEW = 300_000;
const ENDPOINT = 'https://auth.x.ai/oauth2/token';
// A pid no process has: not a multiple of 4 (Windows) and past every `pid_max` (Linux).
const DEAD_PID = 2147483645;
const ok = (access, refresh, afterMs = 1, expiresIn = 3600) => ({
  afterMs,
  status: 200,
  body: JSON.stringify({ access_token: access, refresh_token: refresh, expires_in: expiresIn }),
});
const fail = (status, body, afterMs = 1) => ({ afterMs, status, body });
const stored = (access, refresh, expiresAt) => JSON.stringify({ access_token: access, refresh_token: refresh, expires_at: expiresAt, token_endpoint: ENDPOINT });
const caller = (at, proc = 'A', force = false) => ({ at, proc, force });

// The lease waits with Math.random() 0.5 are 37, 75, 137, 237, 237, ... ms: a caller that finds the lease held at 0
// attempts again at 37, 112, 249, 486, 723, ...; the deadline's own attempt is at 120000.
const ACQUIRED_AFTER_500 = 723;
// Three failed attempts (each answered 1 ms after it went out) with backoffs 300 and 600 ms between: the third answers
// at 903.
const THIRD_FAILURE = 903;

function cases() {
  const list = [];
  const add = (name, c) => list.push({ name, lock: null, actions: [], ...c });
  for (const [name, delta] of [['margin-minus-1', -1], ['margin-exact', 0], ['margin-plus-1', 1]]) {
    add(`expiry-at-${name}`, { file: stored('a0', 'r0', T0 + SKEW + delta), replies: [ok('a1', 'r1')], callers: [caller(0)] });
  }
  add('one-process-two-callers', { file: stored('a0', 'r0', T0 + 1000), replies: [ok('a1', 'r1', 1000)], callers: [caller(0), caller(0)] });
  add('two-owners-in-one-process', { file: stored('a0', 'r0', T0 + 1000), replies: [ok('a1', 'r1', 1000)], callers: [caller(0, 'A'), caller(0, 'B')] });
  add('two-owners-in-one-process-the-second-forced', { file: stored('a0', 'r0', T0 + 1000), replies: [ok('a1', 'r1', 1000)], callers: [caller(0, 'A'), caller(0, 'B', true)] });
  add('two-owners-in-one-process-the-first-forced', { file: stored('a0', 'r0', T0 + 1000), replies: [ok('a1', 'r1', 1000)], callers: [caller(0, 'A', true), caller(0, 'B')] });
  for (const [name, delta] of [['minus-1', -1], ['exact', 0], ['plus-1', 1]]) {
    add(`rewritten-while-waiting-expiry-at-valid-after-${name}`, {
      file: stored('a0', 'r0', T0 + 1000),
      lock: { kind: 'live', ageMs: 0 },
      actions: [
        { at: 500, kind: 'write', text: stored('a9', 'r9', T0 + ACQUIRED_AFTER_500 + SKEW + delta) },
        { at: 500, kind: 'release' },
      ],
      replies: [ok('a1', 'r1')],
      callers: [caller(0)],
    });
  }
  add('rewritten-while-waiting-forced', {
    file: stored('a0', 'r0', T0 + 1000),
    lock: { kind: 'live', ageMs: 0 },
    actions: [{ at: 500, kind: 'write', text: stored('a9', 'r9', T0 + ACQUIRED_AFTER_500 + 1) }, { at: 500, kind: 'release' }],
    replies: [ok('a1', 'r1')],
    callers: [caller(0, 'A', true)],
  });
  // The forced refresh's boundary: a rewritten generation whose expiry is the instant the lease is taken.
  add('rewritten-while-waiting-forced-expiry-at-now', {
    file: stored('a0', 'r0', T0 + 1000),
    lock: { kind: 'live', ageMs: 0 },
    actions: [{ at: 500, kind: 'write', text: stored('a9', 'r9', T0 + ACQUIRED_AFTER_500) }, { at: 500, kind: 'release' }],
    replies: [ok('a1', 'r1')],
    callers: [caller(0, 'A', true)],
  });
  add('rewritten-only-the-refresh-token', {
    file: stored('a0', 'r0', T0 + 1000),
    lock: { kind: 'live', ageMs: 0 },
    actions: [{ at: 500, kind: 'write', text: stored('a0', 'r9', T0 + 3_600_000) }, { at: 500, kind: 'release' }],
    replies: [ok('a1', 'r1')],
    callers: [caller(0)],
  });
  add('released-unchanged', {
    file: stored('a0', 'r0', T0 + 1000),
    lock: { kind: 'live', ageMs: 0 },
    actions: [{ at: 500, kind: 'release' }],
    replies: [ok('a1', 'r1')],
    callers: [caller(0)],
  });
  for (const [name, delta] of [['minus-1', -1], ['exact', 0], ['plus-1', 1]]) {
    add(`lease-released-at-deadline-${name}`, {
      file: stored('a0', 'r0', T0 + 200_000),
      lock: { kind: 'live', ageMs: 0 },
      actions: [{ at: 120_000 + delta, kind: 'release' }],
      replies: [ok('a1', 'r1')],
      callers: [caller(0)],
    });
  }
  for (const [name, delta] of [['minus-1', -1], ['exact', 0], ['plus-1', 1]]) {
    add(`ownerless-lease-aged-stale-${name}`, { file: stored('a0', 'r0', T0 + 1000), lock: { kind: 'ownerless', ageMs: 120_000 + delta }, replies: [ok('a1', 'r1')], callers: [caller(0)] });
  }
  add('dead-owner-lease', { file: stored('a0', 'r0', T0 + 1000), lock: { kind: 'dead', ageMs: 0 }, replies: [ok('a1', 'r1')], callers: [caller(0)] });
  add('third-attempt-succeeds', { file: stored('a0', 'r0', T0 + 5000), replies: [fail(500, 'upstream down'), fail(503, '{"error":"temporarily_unavailable"}'), ok('a1', 'r1')], callers: [caller(0)] });
  add('a-reply-without-a-token-is-tried-again', { file: stored('a0', 'r0', T0 + 5000), replies: [ok('', 'r1'), ok('a1', 'r1')], callers: [caller(0)] });
  for (const [name, delta] of [['minus-1', -1], ['exact', 0], ['plus-1', 1]]) {
    add(`three-failures-expiry-at-failure-${name}`, {
      file: stored('a0', 'r0', T0 + THIRD_FAILURE + delta),
      replies: [fail(500, 'a'), fail(500, 'b'), fail(500, 'c')],
      callers: [caller(0)],
    });
  }
  add('grace-serves-the-next-call', { file: stored('a0', 'r0', T0 + 5000), replies: [fail(500, 'a'), fail(500, 'b'), fail(500, 'c')], callers: [caller(0), caller(2000)] });
  add('three-failures-forced', { file: stored('a0', 'r0', T0 + 5000), replies: [fail(500, 'a'), fail(500, 'b'), fail(500, 'c')], callers: [caller(0, 'A', true)] });
  add('invalid-grant-inside-the-grace-window', { file: stored('a0', 'r0', T0 + 5000), replies: [fail(400, '{"error":"invalid_grant","error_description":"used"}')], callers: [caller(0)] });
  add('invalid-client-forced', { file: stored('a0', 'r0', T0 + 5000), replies: [fail(401, '{"error":"invalid_client"}')], callers: [caller(0, 'A', true)] });
  add('invalid-grant-after-a-rotation-outside-the-lease', {
    file: stored('a0', 'r0', T0 + 5000),
    actions: [{ at: 50, kind: 'write', text: stored('a9', 'r9', T0 + 3_600_000) }],
    replies: [fail(400, '{"error":"invalid_grant"}', 100)],
    callers: [caller(0)],
  });
  add('invalid-grant-after-a-rotation-that-is-expiring', {
    file: stored('a0', 'r0', T0 + 5000),
    actions: [{ at: 50, kind: 'write', text: stored('a9', 'r9', T0 + 6000) }],
    replies: [fail(400, '{"error":"invalid_grant"}', 100), ok('a1', 'r1')],
    callers: [caller(0)],
  });
  return only ? list.filter((c) => c.name === only) : list;
}

// --- The environment ------------------------------------------------------------------------------------------------

const runDir = fs.mkdtempSync(join(tmpdir(), 'grok-lease-'));
process.env.MIXDOG_DATA_DIR = join(runDir, 'data');
process.env.MIXDOG_QUIET_PROVIDER_LOG = '1';
fs.mkdirSync(process.env.MIXDOG_DATA_DIR, { recursive: true });
const bindings = (globalThis[Symbol.for('mixdog.providerAuthBindings')] = {});

const require = createRequire(import.meta.url);
const fsp = require('node:fs/promises');
for (const [name, twin] of Object.entries({
  link: fs.linkSync,
  mkdir: fs.mkdirSync,
  readdir: fs.readdirSync,
  readFile: fs.readFileSync,
  rename: fs.renameSync,
  stat: fs.statSync,
  unlink: fs.unlinkSync,
  writeFile: fs.writeFileSync,
})) {
  fsp[name] = (...callArgs) => new Promise((resolve, reject) => {
    try {
      resolve(twin(...callArgs));
    } catch (error) {
      reject(error);
    }
  });
}
syncBuiltinESMExports();
Math.random = () => 0.5;

const srcRoot = pathToFileURL(join(tree, 'src') + '/').href;
const hook = `
let root;
export async function initialize(data) { root = data.root; }
export async function resolve(specifier, context, next) {
  const resolved = await next(specifier, context);
  const copy = context.parentURL && /[?&]copy=([AB])$/.exec(context.parentURL);
  if (copy && resolved.url.startsWith(root) && !resolved.url.includes('?')) return { ...resolved, url: resolved.url + '?copy=' + copy[1] };
  return resolved;
}`;
register(`data:text/javascript,${encodeURIComponent(hook)}`, { data: { root: srcRoot } });
const load = (copy, path) => import(`${pathToFileURL(join(tree, path)).href}?copy=${copy}`);
const copies = {};
for (const copy of ['A', 'B']) {
  copies[copy] = {
    oauth: await load(copy, 'src/runtime/agent/orchestrator/providers/grok-oauth.mjs'),
    acl: await load(copy, 'src/runtime/shared/file-permissions.mjs'),
  };
}
// The ACL helper and the sync bridge of each copy, started before the clock is virtual.
for (const copy of Object.values(copies)) {
  const warm = join(runDir, `warm-${Math.random().toString(36).slice(2)}-${Object.keys(copies).length}`);
  for (const [i, run] of [(p) => copy.acl.enforceOwnerOnlyAclWin32Async(p, { fresh: true }), (p) => copy.acl.enforceOwnerOnlyAclWin32(p, { fresh: true })].entries()) {
    const file = `${warm}-${i}`;
    fs.writeFileSync(file, '');
    await run(file);
  }
}

// --- The virtual clock ---------------------------------------------------------------------------------------------

const realSetTimeout = globalThis.setTimeout;
const realClearTimeout = globalThis.clearTimeout;
let virtualNow = T0;
Date.now = () => virtualNow;
let seq = 0;
let timers = [];
const realOutstanding = new Set();
let current = null;
let kicked = false;

function kick() {
  if (kicked) return;
  kicked = true;
  setImmediate(step);
}

// A timer due at `due` on the virtual clock; `ms` is what it was asked to wait.
function virtualTimer(fn, due, ms, recorded) {
  const timer = { id: (seq += 1), due, ms, fn: AsyncResource.bind(fn), recorded, cleared: false };
  timers.push(timer);
  const handle = { ref: () => handle, unref: () => handle, hasRef: () => true, refresh: () => handle, [Symbol.toPrimitive]: () => timer.id, timer };
  return handle;
}

globalThis.setTimeout = (fn, ms, ...rest) => {
  const stack = new Error().stack.split('\n');
  if (stack.some((line) => line.includes('file-permissions.mjs'))) {
    const handle = realSetTimeout(() => {
      realOutstanding.delete(handle);
      fn(...rest);
      kick();
    }, ms);
    realOutstanding.add(handle);
    return handle;
  }
  const site = stack[2] ?? '';
  const recorded = /[\\/]shared[\\/]sleep\.mjs/.test(site) || /grok-oauth-tokens\.mjs/.test(site);
  // Node's `setTimeout`: a delay that is not at least 1 is 1.
  const after = Number(ms) >= 1 ? Math.floor(Number(ms)) : 1;
  return virtualTimer(() => fn(...rest), virtualNow + after, after, recorded);
};
globalThis.clearTimeout = (handle) => {
  if (handle && realOutstanding.has(handle)) {
    realOutstanding.delete(handle);
    realClearTimeout(handle);
    kick();
    return;
  }
  if (handle?.timer) handle.timer.cleared = true;
  else realClearTimeout(handle);
};

function step() {
  kicked = false;
  if (!current || realOutstanding.size) return;
  if (current.pending === 0) {
    const finish = current.finish;
    current = null;
    finish();
    return;
  }
  timers = timers.filter((t) => !t.cleared);
  if (!timers.length) {
    current.fail(new Error(`${current.name}: ${current.pending} caller(s) wait on nothing the clock can fire`));
    current = null;
    return;
  }
  timers.sort((a, b) => a.due - b.due || a.id - b.id);
  const next = timers.shift();
  virtualNow = next.due;
  if (next.recorded) current.events.push({ at: virtualNow - T0, kind: 'wait', ms: next.ms });
  next.fn();
  kick();
}

// --- The token endpoint ---------------------------------------------------------------------------------------------

const processOf = new AsyncLocalStorage();
globalThis.fetch = (url, init = {}) => {
  const run = current;
  run.events.push({ at: virtualNow - T0, kind: 'request', proc: processOf.getStore(), url: String(url), body: String(init.body ?? '') });
  const reply = run.replies.shift();
  if (!reply) return Promise.reject(new Error(`${run.name}: a token request the case has no reply for`));
  const response = {
    ok: reply.status >= 200 && reply.status < 300,
    status: reply.status,
    headers: new Headers(),
    text: async () => reply.body,
    json: async () => JSON.parse(reply.body),
  };
  return new Promise((resolve) => virtualTimer(() => resolve(response), virtualNow + reply.afterMs, reply.afterMs, false));
};

// --- The cases ------------------------------------------------------------------------------------------------------

function errorOf(error) {
  return {
    message: String(error?.message ?? error),
    status: Number.isFinite(error?.status) ? error.status : null,
    code: typeof error?.code === 'string' ? error.code : null,
    reauthRequired: error?.reauthRequired === true,
  };
}

async function runCase(spec) {
  const dir = join(runDir, spec.name);
  fs.mkdirSync(dir, { recursive: true });
  const path = join(dir, 'grok-oauth.json');
  bindings['grok-oauth'] = path;
  fs.writeFileSync(path, spec.file);
  const lockPath = `${path}.refresh.lock`;
  if (spec.lock) {
    const record = { live: `${process.pid} ${T0} holder000000000000000000`, dead: `${DEAD_PID} ${T0} holder000000000000000000`, ownerless: '' }[spec.lock.kind];
    fs.writeFileSync(lockPath, record);
    const mtime = (T0 - spec.lock.ageMs) / 1000;
    fs.utimesSync(lockPath, mtime, mtime);
  }
  virtualNow = T0;
  timers = [];
  const providers = {};
  const provider = (proc) => (providers[proc] ??= new copies[proc].oauth.GrokOAuthProvider({ preconnect: false }));
  for (const proc of new Set(spec.callers.map((c) => c.proc))) provider(proc);
  const events = [];
  const replies = spec.replies.slice();
  const done = new Promise((finish, fail) => {
    current = { name: spec.name, events, replies, pending: spec.callers.length, finish, fail };
  });
  // The other process's steps, then the callers, each at its time (registered in that order: at one instant they run
  // in that order).
  for (const action of spec.actions) {
    virtualTimer(() => {
      if (action.kind === 'write') fs.writeFileSync(path, action.text);
      else fs.unlinkSync(lockPath);
    }, T0 + action.at, action.at, false);
  }
  spec.callers.forEach((c, index) => {
    virtualTimer(() => {
      processOf.run(c.proc, () => {
        provider(c.proc)
          .ensureAuth({ forceRefresh: c.force })
          .then(
            (tokens) => events.push({ at: virtualNow - T0, kind: 'result', caller: index, token: tokens.access_token }),
            (error) => events.push({ at: virtualNow - T0, kind: 'result', caller: index, error: errorOf(error) })
          )
          .finally(() => {
            current.pending -= 1;
            kick();
          });
      });
    }, T0 + c.at, c.at, false);
  });
  const deadline = realSetTimeout(() => current?.fail(new Error(`${spec.name}: not settled within 60000 ms of real time`)), 60_000);
  kick();
  try {
    await done;
  } finally {
    realClearTimeout(deadline);
  }
  const entries = fs.readdirSync(dir).sort();
  return { ...spec, events, fileAfter: fs.readFileSync(path, 'utf8'), entries, unusedReplies: replies.length };
}

const recorded = [];
for (const spec of cases()) {
  const outcome = await runCase(spec);
  recorded.push(outcome);
  console.log(`${spec.name}: ${outcome.events.map((e) => (e.kind === 'result' ? `result@${e.at}=${e.token ?? e.error.code ?? e.error.message}` : `${e.kind}@${e.at}`)).join(' ')}`);
}
fs.rmSync(runDir, { recursive: true, force: true });

if (only) {
  writeJson(join(tmpdir(), `grok-refresh-lease-${only}.json`), { cases: recorded });
  console.log(`--only ${only}: written to ${join(tmpdir(), `grok-refresh-lease-${only}.json`)}, the fixture is untouched`);
  process.exit(0);
}
const stage = stageSet(finalDir, ['node-recorded.json', 'MANIFEST.json']);
writeJson(join(stage, 'node-recorded.json'), { t0: T0, skewMs: SKEW, cases: recorded });
const extra = { scripts: { 'benchmarks/rust-core/recorders/lib/common.mjs': sha256(fs.readFileSync(join(repo, 'benchmarks/rust-core/recorders/lib/common.mjs'))) }, recorderSha256: sha256(fs.readFileSync(fileURLToPath(import.meta.url))), runtime: { node: process.versions.node, electron: process.versions.electron ?? null } };
writeSetManifest(stage, { set: 'grok-refresh-lease', recorder, command: `node ${recorder} --tree <b6f10295a export>`, identity, extra });
commitStage(stage, finalDir);
console.log(`${recorded.length} cases recorded from ${COMMIT}`);
process.exit(0);
