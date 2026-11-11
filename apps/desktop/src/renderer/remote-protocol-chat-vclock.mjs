// The inputs of a Node process that are not messages, put under the recorder's control (the history recorder,
// remote-protocol-chat-history.record.mjs): time and randomness. Loaded first in the recorder's own process (Node's SessionHost runs there)
// and, through NODE_OPTIONS `--import`, in every Node process the daemon is (VCLOCK_PORT names the recorder's control port).
//  - Time: `setTimeout`/`setInterval` (globals, node:timers, node:timers/promises), `Date`, `performance.now` and `process.hrtime` run on a
//    clock of their own. Until `freeze`, timers are the real ones (the daemon's start, the host's attach); `freeze` moves every pending
//    timer onto the virtual clock (its full delay from the frozen instant) and sets the clock to a fixed instant. From then on time only
//    moves when the recorder advances it: the due timers fire one at a time in due order (ties in creation order).
//  - Randomness: `Math.random`, `crypto.randomUUID`, `randomBytes`, `randomFillSync`, `getRandomValues`, `randomInt` draw from a PRNG seeded
//    by VCLOCK_SEED and the process's role, so ids minted by Node are the same on every run.
//  - Quiet: a process is quiet when no callback of Node's ran during two turns of its event loop and no short-lived request (a file
//    operation, a socket write or connect, a DNS lookup, a crypto job) is pending; it reports its loopback sockets' byte counts with it, so
//    the recorder knows nothing is in flight between two participants (what one wrote, the other read).
import { createHook, executionAsyncId } from 'node:async_hooks';
import childProcess, { ChildProcess } from 'node:child_process';
import crypto from 'node:crypto';
import dns from 'node:dns';
import fs, { appendFileSync, existsSync, statSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { syncBuiltinESMExports } from 'node:module';
import net from 'node:net';
import timers from 'node:timers';
import timersPromises from 'node:timers/promises';
import { promisify } from 'node:util';
import workerThreads from 'node:worker_threads';

const real = {
  setTimeout: globalThis.setTimeout,
  clearTimeout: globalThis.clearTimeout,
  setInterval: globalThis.setInterval,
  clearInterval: globalThis.clearInterval,
  setImmediate: globalThis.setImmediate,
  Date: globalThis.Date,
  dateNow: Date.now,
  perfNow: performance.now.bind(performance),
  hrtime: process.hrtime,
  hrtimeBigint: process.hrtime.bigint,
};
export const realTimers = { setTimeout: real.setTimeout, clearTimeout: real.clearTimeout, setImmediate: real.setImmediate };

/** A deadline on real time (the recorder's own; never a virtual timer): `race(promise, what)` rejects naming `what` and `seen()`. */
export function realDeadline(ms, seen) {
  let label = 'start';
  let timer;
  const hang = new Promise((_, reject) => {
    timer = real.setTimeout(() => reject(new Error(`HANG after ${ms} ms: still waiting for ${label}; ${seen()}`)), ms);
  });
  hang.catch(() => {});
  return {
    race(promise, what) {
      label = what;
      return Promise.race([promise, hang]);
    },
    clear: () => real.clearTimeout(timer),
  };
}

let virtual = false;
let now = 0; // virtual Date.now
let perf = 0; // virtual performance.now
let seq = 0;
const pending = new Map(); // id -> VTimer, every timer not yet fired or cleared (both modes)

class VTimer {
  constructor(callback, args, delay, repeat) {
    this.id = ++seq;
    this.callback = callback;
    this.args = args;
    this.delay = Math.max(1, Number.isFinite(Number(delay)) ? Number(delay) : 1);
    this.repeat = repeat;
    this.refed = true;
    this.handle = null;
    this.due = 0;
    pending.set(this.id, this);
    if (process.env.VCLOCK_TRACE) this.origin = new Error().stack.split('\n').slice(2, 9).join(' <- ');
    this.arm();
  }
  arm() {
    if (virtual) {
      this.due = perf + this.delay;
      return;
    }
    this.handle = real.setTimeout(() => this.fire(), this.delay);
    if (!this.refed) this.handle.unref();
  }
  fire() {
    this.handle = null;
    if (this.repeat) this.arm();
    else pending.delete(this.id);
    this.callback(...this.args);
  }
  ref() { this.refed = true; this.handle?.ref(); return this; }
  unref() { this.refed = false; this.handle?.unref(); return this; }
  hasRef() { return this.refed; }
  refresh() {
    if (!pending.has(this.id)) return this;
    if (this.handle) real.clearTimeout(this.handle);
    this.arm();
    return this;
  }
  close() { clear(this); return this; }
  [Symbol.toPrimitive]() { return this.id; }
}

function clear(timer) {
  const t = timer instanceof VTimer ? timer : pending.get(Number(timer));
  if (!t) return;
  pending.delete(t.id);
  if (t.handle) real.clearTimeout(t.handle);
  t.handle = null;
}

const vSetTimeout = (callback, delay, ...args) => new VTimer(callback, args, delay, false);
const vSetInterval = (callback, delay, ...args) => new VTimer(callback, args, delay, true);
const vPromiseTimeout = (delay, value, options = {}) =>
  new Promise((resolve, reject) => {
    const signal = options?.signal;
    if (signal?.aborted) return reject(signal.reason ?? new DOMException('The operation was aborted', 'AbortError'));
    const t = vSetTimeout(() => resolve(value), delay);
    signal?.addEventListener('abort', () => { clear(t); reject(signal.reason ?? new DOMException('The operation was aborted', 'AbortError')); }, { once: true });
  });

// ── randomness ────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
function seeded(seedText) {
  // sfc32 over a hash of the seed text.
  const h = crypto.createHash('sha256').update(seedText).digest();
  let a = h.readUInt32LE(0), b = h.readUInt32LE(4), c = h.readUInt32LE(8), d = h.readUInt32LE(12);
  return () => {
    a >>>= 0; b >>>= 0; c >>>= 0; d >>>= 0;
    const t = (a + b) | 0;
    a = b ^ (b >>> 9);
    b = (c + (c << 3)) | 0;
    c = (c << 21) | (c >>> 11);
    d = (d + 1) | 0;
    const r = (t + d) | 0;
    c = (c + r) | 0;
    return (r >>> 0) / 4294967296;
  };
}

function installRandom(seedText) {
  const next = seeded(seedText);
  const fill = (view) => {
    const bytes = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
    for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(next() * 256);
    return view;
  };
  Math.random = next;
  crypto.randomFillSync = (buffer, offset = 0, size) => {
    const view = ArrayBuffer.isView(buffer) ? buffer : new Uint8Array(buffer);
    const end = size === undefined ? view.byteLength - offset : size;
    fill(new Uint8Array(view.buffer, view.byteOffset + offset, end));
    return buffer;
  };
  crypto.randomBytes = (size, callback) => {
    const out = fill(Buffer.alloc(size));
    if (typeof callback === 'function') { process.nextTick(callback, null, out); return undefined; }
    return out;
  };
  crypto.randomInt = (min, max, callback) => {
    if (max === undefined || typeof max === 'function') { callback = max; max = min; min = 0; }
    const value = min + Math.floor(next() * (max - min));
    if (typeof callback === 'function') { process.nextTick(callback, null, value); return undefined; }
    return value;
  };
  crypto.randomUUID = () => {
    const b = fill(Buffer.alloc(16));
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    const h = b.toString('hex');
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
  };
  const set = (target, key, value) => Object.defineProperty(target, key, { value, writable: true, configurable: true, enumerable: true });
  // node:crypto's `getRandomValues` is a fixed getter over webcrypto's; webcrypto's methods are its prototype's.
  const webProto = Object.getPrototypeOf(crypto.webcrypto);
  set(webProto, 'getRandomValues', (view) => fill(view));
  set(webProto, 'randomUUID', crypto.randomUUID);
  syncBuiltinESMExports();
}

// ── time ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
function installTime() {
  const VDate = new Proxy(real.Date, {
    construct: (target, args, newTarget) => Reflect.construct(target, args.length ? args : [virtual ? now : real.dateNow()], newTarget),
    apply: () => new real.Date(virtual ? now : real.dateNow()).toString(),
  });
  real.Date.now = () => (virtual ? now : real.dateNow());
  globalThis.Date = VDate;
  performance.now = () => (virtual ? perf : real.perfNow());
  const hrtime = (previous) => {
    if (!virtual) return real.hrtime(previous);
    const ns = BigInt(Math.round(perf * 1e6));
    const pair = [Number(ns / 1_000_000_000n), Number(ns % 1_000_000_000n)];
    if (!previous) return pair;
    let s = pair[0] - previous[0];
    let n = pair[1] - previous[1];
    if (n < 0) { s -= 1; n += 1e9; }
    return [s, n];
  };
  hrtime.bigint = () => (virtual ? BigInt(Math.round(perf * 1e6)) : real.hrtimeBigint());
  process.hrtime = hrtime;
  globalThis.setTimeout = vSetTimeout;
  globalThis.setInterval = vSetInterval;
  // AbortSignal.timeout (http-agent.mjs preconnect's 10 s) runs on one of Node's internal timers: on the virtual clock instead.
  AbortSignal.timeout = (ms) => {
    const controller = new AbortController();
    vSetTimeout(() => controller.abort(new DOMException('The operation was aborted due to timeout', 'TimeoutError')), ms).unref();
    return controller.signal;
  };
  globalThis.clearTimeout = clear;
  globalThis.clearInterval = clear;
  timers.setTimeout = vSetTimeout;
  timers.setInterval = vSetInterval;
  timers.clearTimeout = clear;
  timers.clearInterval = clear;
  timersPromises.setTimeout = vPromiseTimeout;
  if (timersPromises.scheduler) timersPromises.scheduler.wait = (delay, options) => vPromiseTimeout(delay, undefined, options);
  syncBuiltinESMExports();
}

/** Moves every pending timer onto the virtual clock at `epoch` (Date) / `perfBase` (performance.now). */
export function freeze(epoch, perfBase) {
  if (virtual) throw new Error('the clock is frozen already');
  now = epoch;
  perf = perfBase;
  virtual = true;
  for (const t of pending.values()) {
    if (t.handle) real.clearTimeout(t.handle);
    t.handle = null;
    t.due = perf + t.delay;
    if (process.env.VCLOCK_TRACE) own(() => appendFileSync(`${process.env.VCLOCK_TRACE}/${process.pid}.log`, `frozen pending delay ${t.delay}${t.repeat ? ' repeat' : ''} ${t.origin}\n`));
  }
}

/** Back to real time (the world's teardown waits on its own timers): every pending timer runs out the rest of its virtual delay. */
export function thaw() {
  if (!virtual) return;
  virtual = false;
  for (const t of pending.values()) {
    const rest = Math.max(1, t.due - perf);
    t.handle = real.setTimeout(() => t.fire(), rest);
    if (!t.refed) t.handle.unref();
  }
}

/** The earliest due time of a pending timer (performance.now scale), or null. */
export function nextDue() {
  let best = null;
  for (const t of pending.values()) if (best === null || t.due < best) best = t.due;
  return best;
}

/** Fires every timer due at `at` or before, one at a time in due order (each fire may schedule more), then sets the clock to `at`. */
export function fireDue(at) {
  for (;;) {
    let first = null;
    for (const t of pending.values()) if (t.due <= at && (first === null || t.due < first.due || (t.due === first.due && t.id < first.id))) first = t;
    if (!first) break;
    now += first.due - perf;
    perf = first.due;
    if (process.env.VCLOCK_TRACE) traceFire(first);
    try {
      first.fire();
    } catch (error) {
      real.setImmediate(() => { throw error; });
    }
  }
  now += at - perf;
  perf = at;
}
export const clockNow = () => ({ now, perf, virtual });
// Diagnosis only (VCLOCK_TRACE names a folder): each virtual timer fired, with where it was created, one file per process.
function traceFire(t) {
  own(() => appendFileSync(`${process.env.VCLOCK_TRACE}/${process.pid}.log`, `${perf} delay ${t.delay}${t.repeat ? ' repeat' : ''} ${t.origin}\n`));
}

// ── quiet ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
// HTTPCLIENTREQUEST and undici's UNDICI_REQUEST live as long as their response (a stream the daemon keeps open; undici's connect and
// body timeouts are virtual timers): not short-lived. Their bytes are in the socket table.
const TRANSIENT = /^(FSREQCALLBACK|FSREQPROMISE|FILEHANDLECLOSEREQ|WRITEWRAP|SHUTDOWNWRAP|TCPCONNECTWRAP|PIPECONNECTWRAP|GETADDRINFOREQWRAP|GETNAMEINFOREQWRAP|QUERYWRAP.*|ZLIB|(?!HTTPCLIENT|UNDICI_).*REQUEST)$/;
const transient = new Map(); // asyncId -> type
const types = new Map(); // asyncId -> type, of every resource of Node's (for the report of what ran)
const ours = new Set();
let ownWork = false;
let ran = 0;
let ranTypes = {};
function installQuiet() {
  createHook({
    init(asyncId, type) {
      if (ownWork) { ours.add(asyncId); return; }
      // Ticks and microtasks only ever run after a macrotask that is counted itself (and the control socket's own writes queue ticks).
      if (type !== 'PROMISE' && type !== 'TickObject' && type !== 'Microtask') types.set(asyncId, type);
      if (TRANSIENT.test(type)) transient.set(asyncId, type);
      if (type === 'Timeout' && process.env.VCLOCK_TRACE) own(() => appendFileSync(`${process.env.VCLOCK_TRACE}/${process.pid}.log`, `${perf} realtimer ${new Error().stack.split('\n').slice(2, 12).join(' <- ')}\n`));
    },
    before(asyncId) {
      if (ours.has(asyncId) || !types.has(asyncId)) return;
      ran += 1;
      const type = types.get(asyncId);
      ranTypes[type] = (ranTypes[type] ?? 0) + 1;
    },
    destroy(asyncId) {
      transient.delete(asyncId);
      types.delete(asyncId);
      ours.delete(asyncId);
    },
  }).enable();
}
const own = (fn) => { ownWork = true; try { return fn(); } finally { ownWork = false; } };
const turn = () => new Promise((resolve) => own(() => real.setImmediate(resolve)));

// A child process that is not Node (a shell, git, the ACL helper) runs on real time, outside every clock, so the process that started it
// is not quiet while it owes an answer:
//  - a child the spawner talks to over its stdin (file-permissions.mjs `startAclHelper`, long-lived): while it has answered fewer lines
//    than it was sent;
//  - a detached child (the daemon's supervisor, daemon-candidate.mjs): never (it outlives the spawner and answers nothing);
//  - any other child (a command run to completion): until it exits.
// A Node child loads this module and is a participant itself.
const children = new Map(); // ChildProcess -> { pid, file, owes(), settled: () => Promise }
const nodeChildren = new Set(); // pids of live Node children
const everNode = new Set(); // pids of every Node child this process started
const childExits = new Set(); // waiters woken on a Node child's exit
/** Resolves once one of `pids` (Node children of this process) is no longer alive here. */
export const childEnded = (pids) => own(() => new Promise((resolve) => {
  const check = () => { if (pids.some((pid) => everNode.has(pid) && !nodeChildren.has(pid))) { childExits.delete(check); resolve(); } };
  childExits.add(check);
  check();
}));
const lines = (chunk) => { let n = 0; for (const ch of String(chunk)) if (ch === '\n') n += 1; return n; };
let inExecFile = 0; // > 0 while child_process.execFile is starting its child (synchronously, inside the call)
function installChildren() {
  const execFile = childProcess.execFile;
  childProcess.execFile = function (...args) {
    inExecFile += 1;
    try { return execFile.apply(this, args); } finally { inExecFile -= 1; }
  };
  // promisify(execFile) resolves { stdout, stderr } through Node's own custom form, which calls the original execFile directly.
  const custom = execFile[promisify.custom];
  childProcess.execFile[promisify.custom] = function (...args) {
    inExecFile += 1;
    try { return custom.apply(this, args); } finally { inExecFile -= 1; }
  };
  syncBuiltinESMExports();
  const spawn = ChildProcess.prototype.spawn;
  ChildProcess.prototype.spawn = function (options) {
    const file = String(options?.file ?? '');
    const isNode = file === process.execPath || /(^|[\\/])node(\.exe)?$/i.test(file);
    // A Node child started in a frozen world starts frozen at the world's instant (VCLOCK_AT): its start-up timers are virtual from its
    // first instruction, never real ones that may or may not fire before it joins.
    // Any child: a native one (the daemon's supervisor, daemon-candidate.mjs launchCandidate) passes it on to the Node process it starts.
    if (virtual && Array.isArray(options?.envPairs)) options.envPairs = [...options.envPairs.filter((p) => !p.startsWith('VCLOCK_AT=')), `VCLOCK_AT=${now},${perf}`];
    const result = spawn.call(this, options);
    if (process.env.VCLOCK_TRACE) {
      const what = `${this.pid} ${file} ${(options?.args ?? []).slice(1, 6).join(' ').slice(0, 200)} detached=${Boolean(options?.detached)}`;
      own(() => appendFileSync(`${process.env.VCLOCK_TRACE}/${process.pid}.log`, `${perf} spawn ${what} <- ${new Error().stack.split('\n').slice(2, 8).join(' <- ')}\n`));
      this.once('exit', () => own(() => appendFileSync(`${process.env.VCLOCK_TRACE}/${process.pid}.log`, `${perf} exit ${what}\n`)));
    }
    // A Node child is a participant only once it has said hello to the recorder; until then (its start runs on real time) it is
    // reported, and the recorder takes the world as not settled while a reported child has not joined.
    if (this.pid && isNode) {
      const pid = this.pid;
      nodeChildren.add(pid);
      everNode.add(pid);
      this.once('exit', () => { nodeChildren.delete(pid); for (const check of [...childExits]) check(); });
    }
    if (!this.pid || isNode) return result;
    let exited = false;
    let wake = () => {};
    const changed = () => { const w = wake; wake = () => {}; w(); };
    if (options?.detached) {
      // A detached child outlives its spawner. One the spawner reads (the daemon's supervisor: daemon-candidate.mjs launchCandidate reads
      // `spawned <pid>` and `ready` from its stdout, then unrefs it) holds the spawner's clock until the spawner unrefs it, its own
      // statement that it waits no more (the world meanwhile runs: the daemon it starts is a participant); one it does not read is
      // never waited for.
      if (!this.stdout) return result;
      let released = false;
      const unref = this.unref;
      this.unref = function (...args) { released = true; changed(); return unref.apply(this, args); };
      this.stdout.prependListener('data', () => changed());
      this.once('exit', () => { exited = true; children.delete(this); changed(); });
      const entry = { pid: this.pid, file: file.split(/[\\/]/).pop(), sent: 0, answered: 0, detached: true, owes: () => !exited && !released };
      entry.settled = () => new Promise((resolve) => { wake = resolve; if (!entry.owes()) changed(); });
      children.set(this, entry);
      return result;
    }
    // On exit, not on its pipes' close: a child that starts a server (pg_ctl start, process.mjs) leaves its stdio with the server, so
    // its pipes stay open for the server's life after the child itself exited. What it wrote before exiting is already in the pipe and is
    // read in the loop turns the quiet check waits for.
    this.once('exit', () => { exited = true; children.delete(this); changed(); });
    const entry = { pid: this.pid, file: file.split(/[\\/]/).pop(), sent: 0, answered: 0 };
    if (this.stdin && this.stdout) {
      const write = this.stdin.write;
      this.stdin.write = (chunk, ...rest) => { entry.sent += lines(chunk); return write.call(this.stdin, chunk, ...rest); };
      // Counted before the spawner's own listener runs (prepended), so an answer is never seen as owed after it was read.
      this.stdout.prependListener('data', (chunk) => { entry.answered += lines(chunk); changed(); });
      // A command run to completion through execFile (whoami, the ACL check's one-shot powershell: file-permissions.mjs) is
      // never written to, and its caller waits for its exit: owed until it exits. A long-lived helper owes only unanswered lines.
      const oneShot = inExecFile > 0;
      entry.owes = () => !exited && (oneShot || entry.answered < entry.sent);
    } else entry.owes = () => !exited;
    entry.settled = () => new Promise((resolve) => { wake = resolve; if (!entry.owes()) changed(); });
    children.set(this, entry);
    return result;
  };
}
const owing = () => [...children.values()].filter((c) => !c.detached && c.owes());
const holding = () => [...children.values()].filter((c) => c.detached && c.owes());
/** Resolves once a detached child this process waits on changed (wrote a line, was released, exited); at once when none is held. */
export const heldChanged = () => {
  const held = holding();
  return held.length ? own(() => Promise.race(held.map((c) => c.settled()))) : Promise.resolve();
};

/** Resolves once no child of the kind above lives, two consecutive loop turns ran no callback of Node's and no short-lived request is
 *  pending; `ran` says whether anything ran since the previous call. */
export async function quiet() {
  let any = false;
  let idleTurns = 0;
  ranTypes = {};
  while (idleTurns < 2) {
    const owed = owing();
    if (owed.length) {
      any = true;
      await own(() => Promise.race(owed.map((c) => c.settled())));
      continue;
    }
    const before = ran;
    await turn();
    if (ran !== before || transient.size) { any = true; idleTurns = 0; } else idleTurns += 1;
  }
  return { ran: any, ranTypes, sockets: socketTable(), pipes: pipeTable(), threads: threadTable(), nodeChildren: [...nodeChildren], holding: holding().length, watched: [...new Set([...watchers].map((w) => w.dir))] };
}

// A directory watcher's events (fs.watch: Node's config, file caches, transcripts) come from the OS on real time, after the write that
// caused them: a world that looks quiet may still owe them. The fence: the recorder creates a file of a reserved name in each watched
// directory once the world is otherwise quiet; the OS reports a directory's changes in order, so once every watcher of that directory
// was told of the fence, every earlier change was delivered too. The fence's own events are not Node's: they are kept from its listeners
// and not counted as work.
const FENCE = '.vclock-fence-';
const watchers = new Set(); // { dir, seen: Set<name>, wake() }
function installWatch() {
  const watch = fs.watch;
  fs.watch = function (path, ...rest) {
    const watcher = watch.call(this, path, ...rest);
    let dir = null;
    try { if (statSync(path).isDirectory()) dir = resolve(String(path)).toLowerCase(); } catch {}
    if (!dir) return watcher;
    const entry = { dir, seen: new Set(), wake: () => {} };
    // A fence already on disk when the watch began was written before it: the watcher owes nothing from before it.
    try { for (const n of fs.readdirSync(dir)) if (n.startsWith(FENCE)) entry.seen.add(n); } catch {}
    watchers.add(entry);
    const emit = watcher.emit;
    watcher.emit = function (event, type, name, ...more) {
      if (event === 'change' && name != null && basename(String(name)).startsWith(FENCE)) {
        ran -= 1;
        if (ranTypes.FSEVENTWRAP) ranTypes.FSEVENTWRAP -= 1;
        entry.seen.add(basename(String(name)));
        entry.wake();
        return true;
      }
      // A change without a name: the OS's buffer for this directory overflowed and its events were dropped (libuv reports the overflow
      // as one nameless change, after the changes it covers). Node's listeners get it as they would; a fence already on disk was among
      // the changes it covers.
      if (event === 'change' && name == null && entry.pending && existsSync(join(entry.dir, entry.pending))) {
        entry.seen.add(entry.pending);
        const delivered = emit.call(this, event, type, name, ...more);
        entry.wake();
        return delivered;
      }
      return emit.call(this, event, type, name, ...more);
    };
    watcher.once('close', () => { watchers.delete(entry); entry.wake(); });
    return watcher;
  };
  syncBuiltinESMExports();
}
/** Resolves once every watcher of each directory in `names` (directory -> fence file name) was told of its fence (or closed). */
export function fenced(names) {
  return Promise.all([...watchers].filter((w) => names[w.dir]).map((w) => own(() => new Promise((resolve) => {
    w.pending = names[w.dir];
    const check = () => { if (w.seen.has(names[w.dir]) || !watchers.has(w)) resolve(); else w.wake = check; };
    check();
  }))));
}
/** What is running or pending now (the report of a world that does not settle). */
export const busyReport = () => ({ transient: [...transient.values()], children: owing().map((c) => `${c.pid} ${c.file} sent ${c.sent} answered ${c.answered}`), ranTypes, ran, pendingTimers: pending.size, virtual });

const sockets = new Set();
function installSockets() {
  const connect = net.Socket.prototype.connect;
  net.Socket.prototype.connect = function (...args) {
    // A connection beyond this machine (undici's fetch resolves through net's own lookup, not the patched dns module) is refused as a
    // machine with no network would: its answer would come on real time, from outside every clock.
    const first = Array.isArray(args[0]) ? args[0][0] : args[0];
    const options = first && typeof first === 'object' ? first : { port: first, host: typeof args[1] === 'string' ? args[1] : undefined };
    if (!options.path && options.host !== undefined && !LOOPBACK.test(String(options.host))) {
      const error = Object.assign(new Error(`connect ENETUNREACH ${options.host}:${options.port}`), { code: 'ENETUNREACH', syscall: 'connect', address: options.host, port: options.port });
      process.nextTick(() => this.destroy(error));
      return this;
    }
    if (options.path) pipeEnd(this, options.path, 'client');
    sockets.add(this);
    this.once('close', () => sockets.delete(this));
    return connect.apply(this, args);
  };
  // The memory store's port is the first free one from 55432 up (supervisor.mjs allocatePort, process.mjs findFreePort): worlds side by
  // side would probe the same port and race between the probe and postgres binding it. Each world is given its own port (VCLOCK_PG_PORT):
  // probes of the other ports of that range are answered as a busy port would be.
  const listen = net.Server.prototype.listen;
  net.Server.prototype.listen = function (...args) {
    // Read at each listen: the recorder's own process sets it after this module installed itself.
    const assigned = Number(process.env.VCLOCK_PG_PORT) || 0;
    const port = typeof args[0] === 'object' && args[0] ? args[0].port : args[0];
    if (assigned && Number(port) >= 55432 && Number(port) <= 55632 && Number(port) !== assigned) {
      process.nextTick(() => this.emit('error', Object.assign(new Error(`listen EADDRINUSE: address already in use 127.0.0.1:${port}`), { code: 'EADDRINUSE', errno: -4091, syscall: 'listen', address: '127.0.0.1', port: Number(port) })));
      return this;
    }
    return listen.apply(this, args);
  };
  // A socket's idle timeout (Socket#setTimeout: the http agent's keep-alive and request timeouts, the http server's keep-alive, the memory
  // store's probe in pg/process.mjs tcpOk) is one of Node's internal timers, on real time: it fires on the virtual clock instead, re-armed
  // on each activity Node itself reports (Socket#_unrefTimer, called on every read and write).
  const idle = Symbol('vclock idle timeout');
  const arm = (socket) => {
    const t = socket[idle];
    if (t.timer) clear(t.timer);
    t.timer = t.ms > 0 ? vSetTimeout(() => { t.timer = null; socket.emit('timeout'); }, t.ms) : null;
    t.timer?.unref?.();
  };
  net.Socket.prototype.setTimeout = function (ms, callback) {
    this[idle] ??= { ms: 0, timer: null };
    this[idle].ms = Number(ms) || 0;
    this.timeout = this[idle].ms;
    if (callback) { if (this[idle].ms === 0) this.removeListener('timeout', callback); else this.once('timeout', callback); }
    arm(this);
    return this;
  };
  const unrefTimer = net.Socket.prototype._unrefTimer;
  net.Socket.prototype._unrefTimer = function () {
    for (let s = this; s; s = s._parent) if (s[idle]?.ms > 0) arm(s);
    return unrefTimer.call(this);
  };
  const destroy = net.Socket.prototype._destroy;
  net.Socket.prototype._destroy = function (...args) {
    if (this[idle]?.timer) { clear(this[idle].timer); this[idle].timer = null; }
    return destroy.apply(this, args);
  };
  const emit = net.Server.prototype.emit;
  net.Server.prototype.emit = function (event, socket, ...rest) {
    if (event === 'connection' && socket instanceof net.Socket) {
      if (this._pipeName) pipeEnd(socket, this._pipeName, 'server');
      sockets.add(socket);
      socket.once('close', () => sockets.delete(socket));
    }
    return emit.call(this, event, socket, ...rest);
  };
}
// Named pipes (the session's own channel between the host and the daemon, among others) have no ports to pair their two ends by: they
// are counted per pipe name and side, the bytes of ended connections included, so the recorder can see what one side wrote and the
// other has not read.
const pipeEnds = new Map(); // socket -> { name, side }
const pipeClosed = new Map(); // `${name} ${side}` -> { read, written }
const pipeName = (path) => String(path).toLowerCase().replace(/^\\\\\?\\/, '\\\\.\\').replace(/\//g, '\\');
function pipeEnd(socket, path, side) {
  const end = { name: pipeName(path), side };
  pipeEnds.set(socket, end);
  socket.once('close', () => {
    pipeEnds.delete(socket);
    const key = `${end.name} ${end.side}`;
    const t = pipeClosed.get(key) ?? { read: 0, written: 0 };
    pipeClosed.set(key, { read: t.read + socket.bytesRead, written: t.written + socket.bytesWritten });
  });
}
function pipeTable() {
  const totals = new Map(pipeClosed);
  for (const [s, end] of pipeEnds) {
    if (s === control || excluded.has(s)) continue;
    const key = `${end.name} ${end.side}`;
    const t = totals.get(key) ?? { read: 0, written: 0 };
    totals.set(key, { read: t.read + s.bytesRead, written: t.written + s.bytesWritten - (s.writableLength ?? 0) });
  }
  return [...totals].map(([key, t]) => ({ key, ...t }));
}
let control = null;
const excluded = new Set();
/** A socket of the recorder's own (a control connection): its callbacks are not Node's work and its bytes are not between participants. */
export function markOwn(socket) {
  excluded.add(socket);
  const id = socket._handle?.getAsyncId?.();
  if (id) ours.add(id);
}
/** Runs `fn` as the recorder's own work: what it creates (timers' immediates, sockets, writes) is not counted as Node's. */
export const asOwn = (fn) => own(fn);
const lastLook = new WeakMap();
function socketTable() {
  const out = [];
  for (const s of sockets) {
    if (s === control || excluded.has(s) || s.destroyed || !s.localPort || !s.remotePort) continue;
    if (s.remoteAddress !== '127.0.0.1' && s.remoteAddress !== '::1' && s.remoteAddress !== '::ffff:127.0.0.1') continue;
    const written = s.bytesWritten - (s.writableLength ?? 0);
    // Whether this end wrote after the last bytes it read: a request a peer outside every clock (the memory store's postgres) still owes
    // an answer to. Observed here: when the read count moved since the last look, what was written by then has been answered.
    const seen = lastLook.get(s);
    if (!seen || seen.read !== s.bytesRead) lastLook.set(s, { read: s.bytesRead, written: seen || s.bytesRead ? written : 0 });
    const awaiting = written > lastLook.get(s).written;
    out.push({ local: s.localPort, remote: s.remotePort, read: s.bytesRead, written, awaiting });
  }
  return out;
}

// ── the network beyond this machine: refused at once ─────────────────────────────────────────────────────────────────────────────────
// A lookup of any name but the loopback's fails as an unknown host, synchronously queued (the answer of a machine with no network), so
// nothing Node fetches from outside (a model catalog, an update check) answers at a time the recorder does not choose.
const LOOPBACK = /^(localhost|127\.\d+\.\d+\.\d+|::1)$/i;
function installNetwork() {
  const refuse = (hostname) => Object.assign(new Error(`getaddrinfo ENOTFOUND ${hostname}`), { code: 'ENOTFOUND', errno: -3008, syscall: 'getaddrinfo', hostname });
  const lookup = dns.lookup;
  dns.lookup = function (hostname, options, callback) {
    const cb = typeof options === 'function' ? options : callback;
    if (!LOOPBACK.test(String(hostname))) { process.nextTick(cb, refuse(hostname)); return {}; }
    return lookup.call(this, hostname, options, callback);
  };
  const promised = dns.promises.lookup;
  dns.promises.lookup = (hostname, options) => (LOOPBACK.test(String(hostname)) ? promised(hostname, options) : Promise.reject(refuse(hostname)));
  syncBuiltinESMExports();
}

/** Installs the clock, the seeded randomness, the refused network and the quiet detector in this process. */
// ── worker threads: messages between a thread and its parent ─────────────────────────────────────────────────────────────────────────
// A worker thread is a participant of its own (it loads this module through NODE_OPTIONS and reports on its own control connection).
// A message one thread posted and the other has not handled yet is invisible to both quiet checks (worker-requests.mjs: a request to
// the ACL or catalog worker, its answer back): each side counts what it posted and handled on the channel `${pid}:${worker threadId}`,
// `down` (parent to worker) and `up` (worker to parent), and the recorder takes the world as not settled while a channel's counts differ.
const threadChannels = new Map(); // key -> { sent, handled } as seen from this thread
const channel = (key) => threadChannels.get(key) ?? threadChannels.set(key, { sent: 0, handled: 0 }).get(key);
// Counts each delivered message once, through the handlers Node's worker code attaches (a listener of the recorder's own on a port would
// ref and start it): the handlers of one message run in one synchronous dispatch, so the first of them counts it and a microtask, run
// after the dispatch, lets the next message count again.
function countHandled(target, key) {
  let counted = false;
  for (const method of ['on', 'addListener', 'once', 'prependListener', 'prependOnceListener']) {
    const original = target[method];
    target[method] = function (event, listener, ...rest) {
      if (event !== 'message' || typeof listener !== 'function') return original.call(this, event, listener, ...rest);
      const wrapped = function (...args) {
        if (!counted) { counted = true; channel(key).handled += 1; queueMicrotask(() => { counted = false; }); }
        return listener.apply(this, args);
      };
      wrapped.listener = listener; // removeListener(event, listener) finds it (EventEmitter matches `.listener`)
      return original.call(this, event, wrapped, ...rest);
    };
  }
}
function installThreads() {
  if (!workerThreads.isMainThread && workerThreads.parentPort) {
    const key = `${process.pid}:${workerThreads.threadId}`;
    const port = workerThreads.parentPort;
    const post = port.postMessage;
    port.postMessage = function (...args) { channel(`${key} up`).sent += 1; return post.apply(this, args); };
    countHandled(port, `${key} down`);
  }
  const Base = workerThreads.Worker;
  class Worker extends Base {
    constructor(...args) {
      super(...args);
      const key = `${process.pid}:${this.threadId}`;
      channel(`${key} down`);
      channel(`${key} up`);
      // The worker's 'message' events are emitted on this object: a prepended listener only counts (a Worker's listeners do not ref it).
      this.prependListener('message', () => { channel(`${key} up`).handled += 1; });
      this.once('exit', () => { threadChannels.delete(`${key} down`); threadChannels.delete(`${key} up`); });
    }
    postMessage(...args) {
      channel(`${process.pid}:${this.threadId} down`).sent += 1;
      return super.postMessage(...args);
    }
  }
  workerThreads.Worker = Worker;
  syncBuiltinESMExports();
}
const threadTable = () => [...threadChannels].map(([key, c]) => ({ key, ...c }));

export function install(seedText) {
  installNetwork();
  installTime();
  installRandom(seedText);
  installSockets();
  installChildren();
  installThreads();
  installWatch();
  installQuiet();
}

// ── the preload: a Node process of the daemon, controlled over loopback ──────────────────────────────────────────────────────────────
function controlled(port, seedRoot) {
  const role = `${process.argv.slice(1).map((a) => a.replace(/\\/g, '/').split('/').pop()).join(' ')}`;
  install(`${seedRoot}:${role}`);
  if (process.env.VCLOCK_AT) {
    const [epoch, perfBase] = process.env.VCLOCK_AT.split(',').map(Number);
    freeze(epoch, perfBase);
  }
  own(() => {
    control = net.connect({ host: '127.0.0.1', port }, () => {
      own(() => control.write(`${JSON.stringify({ op: 'hello', pid: process.pid, role })}\n`));
    });
    control.unref();
  });
  let buffer = '';
  const reply = (message) => own(() => control.write(`${JSON.stringify(message)}\n`));
  control.on('data', (chunk) => {
    buffer += chunk;
    for (let at = buffer.indexOf('\n'); at >= 0; at = buffer.indexOf('\n')) {
      const line = buffer.slice(0, at);
      buffer = buffer.slice(at + 1);
      const m = JSON.parse(line);
      // A process started frozen (VCLOCK_AT) is frozen already when its hello is answered with the world's instant.
      if (m.op === 'freeze') { if (!virtual) freeze(m.epoch, m.perfBase); reply({ re: m.n }); }
      else if (m.op === 'thaw') { thaw(); reply({ re: m.n }); }
      else if (m.op === 'report') reply({ re: m.n, ...busyReport() });
      else if (m.op === 'nextDue') reply({ re: m.n, due: nextDue() });
      else if (m.op === 'fire') { fireDue(m.at); reply({ re: m.n }); }
      else if (m.op === 'quiet') quiet().then((q) => reply({ re: m.n, ...q }));
      else if (m.op === 'fenced') fenced(m.names).then(() => reply({ re: m.n }));
      else if (m.op === 'heldChanged') heldChanged().then(() => reply({ re: m.n }));
      else if (m.op === 'childEnded') childEnded(m.pids).then(() => reply({ re: m.n }));
    }
  });
  control.on('error', () => {});
}

if (process.env.VCLOCK_PORT) controlled(Number(process.env.VCLOCK_PORT), process.env.VCLOCK_SEED ?? '');
