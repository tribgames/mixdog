// Harness shared by the session-transport recorders (record-session-transport-*.mjs): the product's own test scaffold
// (`scripts/session-transport/_shared.mjs` of the Node tree: real session service + real HTTP/SSE transport on 127.0.0.1 +
// real session client, a STUB session runtime), a logging `withDaemon`, a TCP tap that records the HTTP the client and the
// server exchange, and the determinism the recording needs. Nothing here is code under test.
//
// Determinism (inputs, not normalisation): the recorder gives the tree a counter-based `crypto.randomUUID`, a fixed
// `Date.now()`, a fixed `performance.now()` and fixed `process.pid` / `process.ppid`, so every token, session id, revision,
// callId and queuedMs the code under test makes is the same on every run and is recorded as it is.
//
// Waits are events with a deadline: `signal.until(predicate, label)` re-checks after every `signal.notify()` and rejects at the
// deadline with a message naming the step.
import crypto from 'node:crypto';
import { writeFileSync } from 'node:fs';
import module from 'node:module';
import net from 'node:net';
import { join } from 'node:path';
import { exact } from './exact.mjs';
import { markMachineText } from './tmp-mark.mjs';

export const DEADLINE_MS = 10_000;
// The real timers, taken at import: a deadline keeps running when a recorder fakes the global setTimeout.
const realSetTimeout = globalThis.setTimeout;
const realClearTimeout = globalThis.clearTimeout;
export const FIXED_NOW = 1_700_000_000_000;
/** The virtual wall clock: `Date.now()` returns `clock.now`; a recorder moves it only by a recorded step. */
export const clock = { now: FIXED_NOW };
export const FIXED_PID = 4242;
export const FIXED_PPID = 4241;
export const FIXED_CWD = 'C:\\recorded\\cwd';

// Every global the harness patches, and where product code branches on it (found by grepping src/ of the base commit).
export const DETERMINISM_BRANCHES = [
  'GLOBALS PATCHED by installDeterminism(): crypto.randomUUID, crypto.randomBytes (no-callback form), Date.now, performance.now, process.pid, process.ppid, process.kill (signal 0 of the fixed pid only). The child-process preloads (lib/determinism-preload.mjs, determinism-preload-other-process.mjs) patch crypto.randomUUID, crypto.randomBytes, Date.now and process.pid only (pid 4242, the second process 4243); they leave process.kill, performance.now and process.ppid alone',
  'BRANCH process.pid liveness (isPidAlive / process.kill(pid, 0): src/runtime/shared/pid-liveness.mjs, ~54 files: daemon discovery in session-client, writer and process locks): the fixed pid is answered alive by the process.kill hook in the recording process; a child process preloaded with the fixed pid has no such hook, so it would judge the parent\'s pid dead and could steal a lock the parent held: no recorded flow has a lock held across processes (restart-prefix phases run one after the other, the lifecycle parent holds nothing while its child runs)',
  'BRANCH process.pid equality (own-lock re-entrancy, ~33 sites such as memory-process-lock, scheduler): a recorded flow with two processes gives them different pids (4242, 4243) so they are different owners, as in production',
  'BRANCH id collision: session ids are sess_<pid>_<n>_<Date.now()>_<randomBytes(16)>; with a fixed pid, a fixed or stepped clock and a counter for the bytes, uniqueness rests on the store\'s own sequence number n (nextId) and on the counters not being reset between live sessions: determinism.reset() is called only where the previous session is finished (lifecycle fresh()), and a collision would fail the save, not pass unnoticed',
  'BRANCH ordering by time (~23 sort sites on updatedAt/createdAt): with a fixed clock timestamps tie, so a listing sorted by time falls back to insertion order; no recorded case reads a time-ordered listing of several sessions (directory listings are recorded in the OS order)',
  'BRANCH deadlines on Date.now / performance.now (~74 performance.now sites, Date.now deadline loops such as settleTurnJournalWrites and lock timeouts): with the clock fixed they never expire inside the code under test; every wait of a recorder carries its own real-timer deadline instead, and the cases that need elapsed time move the virtual clock by a recorded step',
];

export const DETERMINISM = [
  'crypto.randomUUID returns 00000000-0000-4000-8000-<12-digit counter> in call order (client tokens, registration ids, server tokens, daemon session ids, call ids all come from it)',
  'crypto.randomBytes(n) (without a callback) returns the next n values of a running byte counter modulo 256',
  `Date.now() is ${FIXED_NOW} and performance.now() is 0 for the whole run (revisions are Date.now()*1000, queuedMs is 0) unless a case moves the virtual clock by a recorded step`,
  `process.pid is ${FIXED_PID} (process.kill(pid, 0) of it answers alive, as it is this process) and process.ppid is ${FIXED_PPID}; the recorded cwd is the constant ${JSON.stringify(FIXED_CWD)}`,
  ...DETERMINISM_BRANCHES,
];

export function installDeterminism() {
  let counter = 0;
  crypto.randomUUID = () => `00000000-0000-4000-8000-${String(++counter).padStart(12, '0')}`;
  const realRandomBytes = crypto.randomBytes;
  let byteCounter = 0;
  crypto.randomBytes = (size, callback) => (typeof callback === 'function' ? realRandomBytes(size, callback) : Buffer.from(Array.from({ length: size }, () => ++byteCounter % 256)));
  module.syncBuiltinESMExports();
  Date.now = () => clock.now;
  performance.now = () => 0;
  Object.defineProperty(process, 'pid', { value: FIXED_PID, configurable: true });
  Object.defineProperty(process, 'ppid', { value: FIXED_PPID, configurable: true });
  // The fixed pid is this process: the liveness probe process.kill(pid, 0) of the fixed pid answers alive.
  const realKill = process.kill.bind(process);
  process.kill = (pid, signal) => (pid === FIXED_PID && signal === 0 ? true : realKill(pid === FIXED_PID ? process.pid : pid, signal));
  // Both counters back to their start: a recorder calls this where a step must not depend on how many random values earlier
  // (background) work consumed.
  return { reset: () => { counter = 0; byteCounter = 0; } };
}

export { realSetTimeout, realClearTimeout };

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
      const timer = realSetTimeout(() => { cleanup(); reject(new Error(`timed out waiting for: ${label}`)); }, ms);
      const cleanup = () => { realClearTimeout(timer); this.waiters.delete(check); };
      this.waiters.add(check);
      check();
    });
  }
}

// ---- the wire tap -------------------------------------------------------------------------------------------------
// A TCP proxy in front of an HTTP/1.1 server. Every request and response crossing it is parsed (start line, headers in the
// order sent with their case, body decoded from Content-Length or chunked framing; an event-stream body as its frames in
// arrival order) and logged in request order. The bytes the client and the server exchange are untouched.
class HttpParser {
  constructor(kind, onHead) { this.kind = kind; this.onHead = onHead; this.buf = Buffer.alloc(0); this.state = 'head'; this.message = null; this.decoder = null; }
  feed(chunk) { this.buf = Buffer.concat([this.buf, chunk]); this.run(); }
  finish() { if (this.message && this.state === 'body-close') this.endBody(); }
  run() {
    for (;;) {
      if (this.state === 'head') {
        const end = this.buf.indexOf('\r\n\r\n');
        if (end < 0) return;
        const [startLine, ...lines] = this.buf.subarray(0, end).toString('utf8').split('\r\n');
        this.buf = this.buf.subarray(end + 4);
        const headers = lines.map((line) => { const at = line.indexOf(':'); return [line.slice(0, at), line.slice(at + 1).trim()]; });
        const get = (name) => headers.find(([n]) => n.toLowerCase() === name)?.[1];
        const message = { startLine, headers, body: '' };
        if ((get('content-type') ?? '').includes('text/event-stream')) { message.frames = []; delete message.body; message.sse = ''; }
        this.message = message;
        // One decoder per message: a character split across TCP fragments or chunks is decoded once, whole.
        this.decoder = new TextDecoder('utf-8');
        this.onHead(message);
        if (get('transfer-encoding')?.toLowerCase() === 'chunked') this.state = 'chunk-size';
        else if (get('content-length') !== undefined) { this.remaining = Number(get('content-length')); this.state = this.remaining ? 'body-length' : 'done'; }
        else if (this.kind === 'response' && !/^HTTP\/1\.1 (1|204|304)/.test(startLine)) this.state = 'body-close';
        else this.state = 'done';
        if (this.state === 'done') this.endBody();
        continue;
      }
      if (this.state === 'body-length') {
        if (!this.buf.length) return;
        const take = Math.min(this.remaining, this.buf.length);
        this.addBody(this.buf.subarray(0, take));
        this.buf = this.buf.subarray(take);
        this.remaining -= take;
        if (!this.remaining) this.endBody();
        continue;
      }
      if (this.state === 'body-close') { if (!this.buf.length) return; this.addBody(this.buf); this.buf = Buffer.alloc(0); return; }
      if (this.state === 'chunk-size') {
        const end = this.buf.indexOf('\r\n');
        if (end < 0) return;
        this.remaining = parseInt(this.buf.subarray(0, end).toString('latin1'), 16);
        this.buf = this.buf.subarray(end + 2);
        this.state = this.remaining === 0 ? 'chunk-trailer' : 'chunk-data';
        continue;
      }
      if (this.state === 'chunk-data') {
        if (this.buf.length < this.remaining + 2) return;
        this.addBody(this.buf.subarray(0, this.remaining));
        this.buf = this.buf.subarray(this.remaining + 2);
        this.state = 'chunk-size';
        continue;
      }
      if (this.state === 'chunk-trailer') {
        if (this.buf.length < 2) return;
        this.buf = this.buf.subarray(2);
        this.endBody();
        continue;
      }
    }
  }
  addBody(bytes) {
    const text = this.decoder.decode(bytes, { stream: true });
    if (this.message.frames) {
      this.message.sse += text;
      for (let at = this.message.sse.indexOf('\n\n'); at >= 0; at = this.message.sse.indexOf('\n\n')) {
        this.message.frames.push(this.message.sse.slice(0, at));
        this.message.sse = this.message.sse.slice(at + 2);
      }
    } else this.message.body += text;
  }
  endBody() {
    const rest = this.decoder.decode();
    if (rest) { if (this.message.frames) this.message.sse += rest; else this.message.body += rest; }
    this.state = 'head';
    this.message = null;
  }
}

/** The harness's own check: multi-byte text forced across fragment boundaries must come out whole, as a Content-Length body, a chunked body and event-stream frames. */
export function selfCheck() {
  const text = '€uro 한글 𝄞';
  const bytes = Buffer.from(text);
  const split = (buffer, ...cuts) => { const parts = []; let at = 0; for (const cut of [...cuts, buffer.length]) { parts.push(buffer.subarray(at, cut)); at = cut; } return parts; };
  const run = (head, bodyBytes, cuts) => {
    const out = [];
    const parser = new HttpParser('response', (message) => out.push(message));
    for (const part of split(Buffer.concat([Buffer.from(head), bodyBytes]), ...cuts)) parser.feed(part);
    return out[0];
  };
  // cuts inside the 3-byte €, the 3-byte Hangul and the 4-byte 𝄞
  const cuts = [bytes.length - 2, 2, 8, bytes.indexOf(0xf0) + 2].sort((a, b) => a - b);
  const lengthHead = `HTTP/1.1 200 OK\r\nContent-Length: ${bytes.length}\r\n\r\n`;
  const headLen = Buffer.byteLength(lengthHead);
  const a = run(lengthHead, bytes, cuts.map((cut) => headLen + cut));
  if (a.body !== text) throw new Error(`wire tap self-check: Content-Length body corrupted: ${JSON.stringify(a.body)}`);
  const sse = Buffer.from(`data: ${text}\n\n`);
  const sseHead = 'HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nTransfer-Encoding: chunked\r\n\r\n';
  const framed = Buffer.concat([Buffer.from(sseHead), Buffer.from(`${sse.length.toString(16)}\r\n`), sse, Buffer.from('\r\n0\r\n\r\n')]);
  const base = Buffer.byteLength(sseHead) + 3 + 6;
  const b = run('', framed, [base + 1, base + 3, base + 7]);
  if (b.frames[0] !== `data: ${text}`) throw new Error(`wire tap self-check: event-stream frame corrupted: ${JSON.stringify(b.frames[0])}`);
  const chunkedHead = 'HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n';
  const chunked = Buffer.concat([Buffer.from(chunkedHead), Buffer.from(`${bytes.length.toString(16)}\r\n`), bytes, Buffer.from('\r\n0\r\n\r\n')]);
  const start = Buffer.byteLength(chunkedHead) + 3;
  const d = run('', chunked, [start + 1, start + 2, start + 6]);
  if (d.body !== text) throw new Error(`wire tap self-check: chunked body corrupted: ${JSON.stringify(d.body)}`);
}

export async function startWireTap(targetPort) {
  selfCheck();
  const exchanges = [];
  const connections = [];
  const sockets = new Set();
  const waiters = new Set();
  const poke = () => { for (const check of [...waiters]) check(); };
  const server = net.createServer((client) => {
    sockets.add(client);
    const conn = { index: connections.length, queue: [] };
    connections.push(conn);
    const upstream = net.connect({ host: '127.0.0.1', port: targetPort });
    sockets.add(upstream);
    const requests = new HttpParser('request', (request) => { const exchange = { connection: conn.index, request, response: null }; conn.queue.push(exchange); exchanges.push(exchange); });
    const responses = new HttpParser('response', (response) => { const exchange = conn.queue.shift(); if (exchange) exchange.response = response; poke(); });
    client.on('data', (chunk) => { requests.feed(chunk); upstream.write(chunk); });
    upstream.on('data', (chunk) => { responses.feed(chunk); client.write(chunk); });
    client.on('close', () => { upstream.destroy(); });
    upstream.on('close', () => { responses.finish(); conn.closed = true; client.destroy(); poke(); });
    client.on('error', () => upstream.destroy());
    upstream.on('error', () => client.destroy());
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port;
  const strip = (message) => {
    if (!message) return message;
    const { sse: _pending, ...rest } = message;
    // Declared normalisation: the `Host` header's ephemeral port -> <port>; `Date` -> <date>; and this machine's roots
    // (checkout, temp dir, home: lib/tmp-mark.mjs) -> <CWD>/<TMP>/<HOME> in startLine, header values, body and frames.
    // Content-Length stays the one Node sent: `rewrites` {label: {originalLength, count}} says what each label stands for.
    const rewrites = {};
    const mark = (text) => { const done = markMachineText(text); for (const [label, hit] of Object.entries(done.rewrites)) { const have = rewrites[label]; rewrites[label] = have ? { originalLength: hit.originalLength, count: have.count + hit.count } : hit; } return done.text; };
    const out = { ...rest, startLine: mark(rest.startLine), headers: message.headers.map(([name, value]) => [name, name.toLowerCase() === 'host' ? value.replace(/:\d+$/, ':<port>') : name.toLowerCase() === 'date' ? '<date>' : mark(value)]) };
    if (typeof rest.body === 'string') out.body = mark(rest.body);
    if (Array.isArray(rest.frames)) out.frames = rest.frames.map((frame) => (typeof frame === 'string' ? mark(frame) : frame));
    if (Object.keys(rewrites).length) out.rewrites = rewrites;
    return out;
  };
  // Resolves when every request seen so far has its response head (or its connection closed): a snapshot never holds a
  // response still in flight. An event wait with a deadline.
  const settled = (label = 'the wire tap') => new Promise((resolve, reject) => {
    const open = () => exchanges.some((e) => !e.response && !connections[e.connection].closed);
    const check = () => { if (!open()) { realClearTimeout(timer); waiters.delete(check); resolve(); } };
    const timer = realSetTimeout(() => { waiters.delete(check); reject(new Error(`timed out waiting for every request to be answered: ${label}`)); }, DEADLINE_MS);
    waiters.add(check);
    check();
  });
  const view = (list) => exact(list.map(({ connection, request, response }) => ({ connection, request: strip(request), response: strip(response) })));
  return {
    port,
    /** Every exchange so far, in the order its request arrived, once all of them are answered. */
    exchanges: async () => { await settled('exchanges()'); return view(exchanges); },
    mark: () => exchanges.length,
    since: async (mark) => { await settled('since()'); return view(exchanges.slice(mark)); },
    stop: () => new Promise((resolve) => { server.close(resolve); for (const socket of sockets) socket.destroy(); }),
  };
}

/**
 * The test scaffold's `withDaemon`, with a wire tap in front of the transport and every call the service receives logged
 * (`calls`: name, args, context, outcome, all through `exact` at the moment of the call) and a `signal` poked on every
 * registration change. `S` is the tree's `_shared.mjs` module.
 */
export async function withLoggedDaemon(S, run, { sessionFactory = async () => S.createStubSessionRuntime(), desktopRuntime = null } = {}) {
  const calls = [];
  const signal = new Signal();
  let clientsEmptyReason = null;
  const service = S.createSessionService({ createSessionRuntime: sessionFactory, publishIntervalMs: 5, onFrame: (frame, targets) => transport.broadcast(frame, targets), idleEvictMs: null, softRssMb: null, desktopRuntime });
  const transport = S.createSessionTransport({
    handleCall: async (name, args, ctx) => {
      const entry = { name, args: exact(args), context: exact(ctx) };
      calls.push(entry);
      try {
        const result = await service.handleCall(name, args, ctx);
        entry.result = exact(result);
        return result;
      } catch (error) {
        entry.error = exact(error);
        throw error;
      } finally { signal.notify(); }
    },
    clientGraceMs: 50,
    onClientsEmpty: () => { clientsEmptyReason = 'empty'; signal.notify(); },
    onClientDropped: (token) => { service.releaseClient(token); signal.notify(); },
  });
  const { port, token } = await transport.start();
  const tap = await startWireTap(port);
  const discovery = { pid: process.pid, port: tap.port, token };
  // createSession (the remote runtime client) finds the daemon through this file, as the product does.
  writeFileSync(join(S.RUNTIME_ROOT, 'daemon.json'), JSON.stringify({ pid: process.pid, startedAt: Date.now(), endpoints: { session: { port: tap.port, token } } }));
  try {
    return await run({ transport, service, discovery, calls, signal, wire: tap, clientsEmpty: () => clientsEmptyReason });
  } finally {
    await tap.stop();
    await service.stop('recorder end');
    await transport.stop();
  }
}
