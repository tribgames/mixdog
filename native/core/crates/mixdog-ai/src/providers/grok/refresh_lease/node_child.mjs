// One Node process of a two-process lease case (`processes.mjs`): Node b6f10295a's own Grok provider
// (`GrokOAuthProvider.ensureAuth`, grok-oauth.mjs:338, and its `refreshTokens` under `withFileLock`,
// grok-oauth-tokens.mjs:386-433) over the credential file the coordinator names, stepped by the coordinator over
// stdin and stdout, one JSON line each way (the child's lines start with `@lease `).
//
// Fixed inputs, as in `record.mjs`: `Date.now()` is a virtual clock the coordinator sets with every command; every
// timer of the product's code is a virtual timer this process fires only when the coordinator says so (`fire`), in
// due-time then registration order; the Windows ACL helper's timers stay real, and while one is outstanding the process
// is not settled; `Math.random()` is 0.5; `node:fs/promises` completes each call synchronously; `fetch` is the
// coordinator's token endpoint: the request is reported, and the answer (`reply`) arrives after its `afterMs` on the
// virtual clock.
//
// Commands: `init` (the credential file, the data folder, the start instant), `call` (a caller starts `ensureAuth`),
// `fire` (the earliest timer fires: it is due now), `reply` (the token request in flight is answered), `exit`. After
// each, once nothing more can run without the clock, the child answers with its `status`: the due time of its earliest
// timer and what happened (`wait` as a lease or backoff wait fires, `request` as a token request goes out, `result` as
// a caller settles).
// Usage: node node_child.mjs --tree <git archive export of b6f10295a, with node_modules>
import { createRequire, syncBuiltinESMExports } from 'node:module';
import * as fs from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';

const treeAt = process.argv.indexOf('--tree');
if (treeAt < 0) throw new Error('node_child.mjs: --tree <b6f10295a export> is required');
const tree = process.argv[treeAt + 1];

const say = (message) => process.stdout.write(`@lease ${JSON.stringify(message)}\n`);
const commands = createInterface({ input: process.stdin });
const queue = [];
let waiting = null;
commands.on('line', (line) => {
  const command = JSON.parse(line);
  if (waiting) {
    const take = waiting;
    waiting = null;
    take(command);
  } else queue.push(command);
});
const nextCommand = () => (queue.length ? Promise.resolve(queue.shift()) : new Promise((take) => (waiting = take)));

const init = await nextCommand();
if (init.cmd !== 'init') throw new Error(`node_child.mjs: the first command is ${init.cmd}, not init`);
process.env.MIXDOG_DATA_DIR = init.dataDir;
process.env.MIXDOG_QUIET_PROVIDER_LOG = '1';
fs.mkdirSync(init.dataDir, { recursive: true });
globalThis[Symbol.for('mixdog.providerAuthBindings')] = { 'grok-oauth': init.path };

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

const load = (path) => import(pathToFileURL(join(tree, path)).href);
const { GrokOAuthProvider } = await load('src/runtime/agent/orchestrator/providers/grok-oauth.mjs');
const acl = await load('src/runtime/shared/file-permissions.mjs');
// The ACL helper and the sync bridge, started before the clock is virtual.
for (const [i, run] of [(p) => acl.enforceOwnerOnlyAclWin32Async(p, { fresh: true }), (p) => acl.enforceOwnerOnlyAclWin32(p, { fresh: true })].entries()) {
  const file = join(init.dataDir, `warm-${i}`);
  fs.writeFileSync(file, '');
  await run(file);
}

// --- The virtual clock ---------------------------------------------------------------------------------------------

const realSetTimeout = globalThis.setTimeout;
const realClearTimeout = globalThis.clearTimeout;
let virtualNow = init.now;
Date.now = () => virtualNow;
let seq = 0;
let timers = [];
const realOutstanding = new Set();
const events = [];
let quiet = null;

function virtualTimer(fn, due, ms, recorded) {
  const timer = { id: (seq += 1), due, ms, fn, recorded, cleared: false };
  timers.push(timer);
  const handle = { ref: () => handle, unref: () => handle, hasRef: () => true, refresh: () => handle, [Symbol.toPrimitive]: () => timer.id, timer };
  return handle;
}

function check() {
  if (!quiet || realOutstanding.size) return;
  const done = quiet;
  quiet = null;
  done();
}

globalThis.setTimeout = (fn, ms, ...rest) => {
  const stack = new Error().stack.split('\n');
  if (stack.some((line) => line.includes('file-permissions.mjs'))) {
    const handle = realSetTimeout(() => {
      realOutstanding.delete(handle);
      fn(...rest);
      setImmediate(check);
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
    setImmediate(check);
    return;
  }
  if (handle?.timer) handle.timer.cleared = true;
  else realClearTimeout(handle);
};

/** Resolves once everything that can run without the virtual clock has run (microtasks drained, no real timer left). */
function settled() {
  return new Promise((resolve) => {
    quiet = resolve;
    setImmediate(check);
  });
}

// --- The token endpoint ---------------------------------------------------------------------------------------------

let inFlight = null;
globalThis.fetch = (url, init = {}) => {
  events.push({ kind: 'request', url: String(url), body: String(init.body ?? '') });
  if (inFlight) return Promise.reject(new Error('a second token request while one is in flight'));
  return new Promise((resolve) => {
    inFlight = resolve;
  });
};

function errorOf(error) {
  return {
    message: String(error?.message ?? error),
    status: Number.isFinite(error?.status) ? error.status : null,
    code: typeof error?.code === 'string' ? error.code : null,
    reauthRequired: error?.reauthRequired === true,
  };
}

const provider = new GrokOAuthProvider({ preconnect: false });
say({ ready: { pid: process.pid, node: process.version } });

while (true) {
  const command = await nextCommand();
  if (command.cmd === 'exit') break;
  virtualNow = command.now;
  if (command.cmd === 'call') {
    provider.ensureAuth({ forceRefresh: command.force }).then(
      (tokens) => events.push({ kind: 'result', caller: command.caller, token: tokens.access_token }),
      (error) => events.push({ kind: 'result', caller: command.caller, error: errorOf(error) })
    );
  } else if (command.cmd === 'fire') {
    timers = timers.filter((t) => !t.cleared);
    timers.sort((a, b) => a.due - b.due || a.id - b.id);
    const next = timers.shift();
    if (!next || next.due !== virtualNow) throw new Error(`fire at ${virtualNow}: the earliest timer is due at ${next?.due}`);
    if (next.recorded) events.push({ kind: 'wait', ms: next.ms });
    next.fn();
  } else if (command.cmd === 'reply') {
    const answer = inFlight;
    if (!answer) throw new Error('a reply with no token request in flight');
    inFlight = null;
    const response = {
      ok: command.status >= 200 && command.status < 300,
      status: command.status,
      headers: new Headers(),
      text: async () => command.body,
      json: async () => JSON.parse(command.body),
    };
    virtualTimer(() => answer(response), virtualNow + command.afterMs, command.afterMs, false);
  } else throw new Error(`node_child.mjs: unknown command ${command.cmd}`);
  await settled();
  timers = timers.filter((t) => !t.cleared);
  const next = timers.reduce((min, t) => (min === null || t.due < min ? t.due : min), null);
  say({ status: { next, events: events.splice(0) } });
}
commands.close();
process.exit(0);
