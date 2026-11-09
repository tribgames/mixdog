#!/usr/bin/env node
// The credential and listener lifecycle of the MCP connector sign-in (`createMcpOAuth`, `startMcpOAuthSwitch`) as the
// real Node client runs it against an in-process MCP + authorization server whose every request is scripted and
// logged. Each case records what a caller and a user can observe, from real signals only (server events, socket
// events, the listener's own `close` / `closeAllConnections` calls, promises the client exposes):
//   - the complete credential store before and after (every entry, normalized for ports and the random revision) and
//     the order of its writes and deletions;
//   - every request the servers saw (path, grant type, client id), in order;
//   - the caller's outcome (the response or the error, or a switch's resolved sign-in / rejection);
//   - the events of the listener lifecycle in their order, and what a browser request gets afterwards.
// The 1 s bound of the page flush is driven under virtual timers: the recorder replaces `setTimeout` for the one
// 1000 ms timer created by oauth-callback.mjs and fires it by hand. Real timers are used only for the login deadline
// (`timeoutMs`), which is the Node product's own timer.
//
//   node benchmarks/rust-core/recorders/record-oauth-mcp-lifecycle.mjs --tree <git checkout at --commit, with node_modules> --commit <40-hex> [--only <title fragment>]
//
// Output: native/core/fixtures/oauth-mcp-lifecycle/golden.json (not written with --only).
process.env.TZ = 'UTC';
process.env.MIXDOG_SKIP_USER_DATA_BACKUP = '1';
import http, { createServer } from 'node:http';
import { createConnection } from 'node:net';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FIXTURES_ROOT, commitCheckoutIdentity, commitStage, importFrom, parseArgs, resolveTree, stageSet, writeJson, writeSetManifest } from './lib/common.mjs';
import { rawExchange } from './lib/raw-http.mjs';

const args = parseArgs();
const tree = resolveTree(args);
const commit = args.get('commit');
if (!commit) throw new Error('--commit <40-hex> is required');
const only = args.get('only') ?? null;
const identity = commitCheckoutIdentity(tree, commit);
const finalDir = join(FIXTURES_ROOT, 'oauth-mcp-lifecycle');
const recorder = 'benchmarks/rust-core/recorders/record-oauth-mcp-lifecycle.mjs';

const scratch = mkdtempSync(join(tmpdir(), 'oauth-mcp-lifecycle-'));
for (const key of ['MIXDOG_DATA_DIR', 'MIXDOG_HOME', 'MIXDOG_DESKTOP_USER_DATA', 'MIXDOG_CONFIG_DIR', 'MIXDOG_RUNTIME_ROOT', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA']) {
  process.env[key] = join(scratch, key);
  mkdirSync(process.env[key], { recursive: true });
}

// ---- virtual timers: only the flush bound created by oauth-callback.mjs --------------------------------------------
const realSetTimeout = globalThis.setTimeout;
const realClearTimeout = globalThis.clearTimeout;
const virtualTimers = new Set();
let virtualFlushBound = false;
globalThis.setTimeout = function (fn, ms, ...rest) {
  if (virtualFlushBound && ms === 1000 && new Error().stack.includes('oauth-callback.mjs')) {
    const timer = { fn, rest, unref: () => timer, ref: () => timer };
    virtualTimers.add(timer);
    return timer;
  }
  return realSetTimeout(fn, ms, ...rest);
};
globalThis.clearTimeout = function (timer) {
  if (virtualTimers.delete(timer)) return undefined;
  return realClearTimeout(timer);
};
const tickVirtualTimers = () => {
  for (const timer of [...virtualTimers]) {
    virtualTimers.delete(timer);
    timer.fn(...timer.rest);
  }
};

const sleep = (ms) => new Promise((resolve) => realSetTimeout(resolve, ms));
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
};
/** `promise`, or `fallback` when it has not settled within `ms` (a watchdog for a defect, never a synchronization). */
const within = (promise, ms, fallback) => Promise.race([promise, sleep(ms).then(() => fallback)]);

// ---- the loopback listener of the login, observed through the instance's own calls ----------------------------------
let events = [];
let capture = false;
let loginListener = null;
const realListen = http.Server.prototype.listen;
http.Server.prototype.listen = function (...listenArgs) {
  if (capture && !loginListener) {
    const server = this;
    const state = { server, port: 0, connections: 0, waiters: [], up: deferred() };
    loginListener = state;
    server.once('listening', () => {
      state.port = server.address().port;
      events.push('listener-up');
      state.up.resolve();
    });
    // `dataFrom`: the client ports of the connections the server has received bytes on (a real signal that a half-sent
    // request was consumed, which decides whether destroying the socket ends it with FIN or with a reset).
    state.dataFrom = new Set();
    server.on('connection', (socket) => {
      state.connections += 1;
      socket.on('data', () => {
        state.dataFrom.add(socket.remotePort);
        for (const waiter of state.waiters.splice(0)) waiter();
      });
      for (const waiter of state.waiters.splice(0)) waiter();
    });
    for (const call of ['close', 'closeAllConnections']) {
      const original = server[call].bind(server);
      server[call] = (...callArgs) => {
        events.push(`listener.${call}`);
        return original(...callArgs);
      };
    }
  }
  return realListen.apply(this, listenArgs);
};
const connectionsAtLeast = (count) =>
  new Promise((resolve) => {
    const check = () => {
      if (loginListener.connections >= count) resolve();
      else loginListener.waiters.push(check);
    };
    check();
  });

// ---- the page of the callback: an end held back, to land requests between the outcome and the close ---------------
// `hook`: null | { delay: ms } | { stall: true } for the first page written to the callback port after the token
// request arrived. `intercepted` resolves when that page's end is held back; `endHeld()` ends it.
let hook = null;
let tokenArrived = false;
let intercepted = deferred();
let heldEnds = [];
const realEnd = http.ServerResponse.prototype.end;
http.ServerResponse.prototype.end = function (...endArgs) {
  if (hook && tokenArrived && loginListener && this.req.socket.localPort === loginListener.port) {
    const { delay } = hook;
    hook = null;
    events.push('page-end-held');
    this.once('finish', () => events.push('page-finished'));
    const end = () => realEnd.apply(this, endArgs);
    intercepted.resolve();
    if (delay) realSetTimeout(end, delay);
    else heldEnds.push(end);
    return this;
  }
  return realEnd.apply(this, endArgs);
};

// ---- the credential store --------------------------------------------------------------------------------------
function memoryStore() {
  const values = new Map();
  const ops = [];
  return {
    getSecretAsync: async (key) => values.get(key),
    setSecretAsync: async (key, value) => {
      values.set(key, value);
      ops.push('set');
    },
    deleteSecretAsync: async (key) => {
      values.delete(key);
      ops.push('delete');
    },
    values,
    ops,
  };
}

// ---- the MCP server that is also its authorization server ------------------------------------------------------
const STATIC = { clientId: 'static-client', clientSecret: 'static-secret' };
const SEED_TOKEN = 'fixture-token';
const MAIN_TOKEN = 'fixture-token-2';

// `holds.discovery` / `holds.register`: the first such request waits for `release()`; a token script entry 'gate' does
// the same for the token endpoint (then answers like 'ok'). `arrived` resolves when the held request reached the
// server, `closed` when its socket closed (the client dropped it) - the real signals of an abort.
async function fixture() {
  let origin;
  const log = [];
  const state = { phase: 'seed', script: [], holds: {} };
  const makeHold = () => {
    const arrived = deferred();
    const closed = deferred();
    const gate = deferred();
    return { arrived, closed, gate, used: false };
  };
  state.holds = { discovery: null, register: null, token: makeHold() };
  const hold = async (name, req) => {
    const held = state.holds[name];
    if (!held || held.used) return;
    held.used = true;
    held.arrived.resolve();
    req.socket.once('close', () => held.closed.resolve());
    await held.gate.promise;
  };
  const json = (res, status, doc) => res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(doc));
  const server = createServer(async (req, res) => {
    const path = new URL(req.url, origin).pathname;
    let body = '';
    for await (const chunk of req) body += chunk;
    if (path.startsWith('/.well-known/oauth-protected-resource')) {
      log.push(`${req.method} ${path}`);
      await hold('discovery', req);
      json(res, 200, { resource: `${origin}/mcp`, authorization_servers: [origin] });
    } else if (path.startsWith('/.well-known/')) {
      log.push(`${req.method} ${path}`);
      json(res, 200, {
        issuer: origin,
        authorization_endpoint: `${origin}/authorize`,
        token_endpoint: `${origin}/token`,
        registration_endpoint: `${origin}/register`,
        response_types_supported: ['code'],
        grant_types_supported: ['authorization_code', 'refresh_token'],
        code_challenge_methods_supported: ['S256'],
        token_endpoint_auth_methods_supported: ['none'],
      });
    } else if (path === '/register') {
      log.push('POST /register');
      await hold('register', req);
      json(res, 201, { ...JSON.parse(body), client_id: 'fixture-client' });
    } else if (path === '/token') {
      const form = new URLSearchParams(body);
      log.push(`POST /token ${form.get('grant_type')} client=${form.get('client_id')}`);
      tokenArrived = true;
      const entry = state.script.shift() ?? 'ok';
      if (entry === 'gate') {
        await hold('token', req);
      }
      if (entry === 'network') return req.socket.destroy();
      if (entry === 'html') return res.writeHead(500, { 'Content-Type': 'text/html' }).end('<html>oops</html>');
      if (entry === 'server_error') return json(res, 500, { error: 'server_error' });
      if (typeof entry === 'object') return json(res, 400, { error: entry.error });
      const seed = state.phase === 'seed';
      json(res, 200, {
        access_token: seed ? SEED_TOKEN : MAIN_TOKEN,
        refresh_token: seed ? 'fixture-refresh' : 'fixture-refresh-2',
        token_type: 'Bearer',
        expires_in: 3600,
      });
    } else if (path === '/mcp') {
      const bearer = req.headers.authorization?.slice('Bearer '.length) ?? '-';
      log.push(`${req.method} /mcp bearer=${bearer === SEED_TOKEN || bearer === MAIN_TOKEN ? bearer : bearer === '-' ? '-' : 'other'}`);
      const accepted = state.phase === 'seed' ? SEED_TOKEN : MAIN_TOKEN;
      if (bearer === accepted) return res.writeHead(405).end();
      res.writeHead(401, { 'WWW-Authenticate': `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource"` }).end();
    } else res.writeHead(404).end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
  return {
    url: `${origin}/mcp`,
    origin: () => origin,
    log,
    state,
    makeHold,
    close() {
      server.closeAllConnections();
      server.close();
    },
  };
}

const { createMcpOAuth, startMcpOAuthSwitch } = await importFrom(tree, 'src/runtime/agent/orchestrator/mcp/oauth.mjs');

// ---- one case ---------------------------------------------------------------------------------------------------
const TOKEN_ERRORS = {
  invalid_client: { error: 'invalid_client' },
  unauthorized_client: { error: 'unauthorized_client' },
  invalid_grant: { error: 'invalid_grant' },
  invalid_scope: { error: 'invalid_scope' },
  network: 'network',
};
const GOOD = (path, state) => `${path}?code=fixture-code&state=${state}`;

const page = (answer) =>
  answer.connection
    ? { connection: answer.connection }
    : { statusLine: answer.statusLine, bodySha1: createHash('sha1').update(answer.body).digest('hex').slice(0, 12) };

async function runCase(spec) {
  const server = await fixture();
  const store = memoryStore();
  const client = spec.client === 'static' ? STATIC : null;
  const name = 'Fixture';
  const callbackFor = {};
  let seedPort = 0;
  const normalize = (text) => {
    let out = text.replaceAll(server.origin(), '<origin>');
    if (loginListener?.port) out = out.replaceAll(`127.0.0.1:${loginListener.port}`, '127.0.0.1:<callback>');
    if (callbackFor.port) out = out.replaceAll(`127.0.0.1:${callbackFor.port}`, '127.0.0.1:<callback>');
    if (seedPort) out = out.replaceAll(`127.0.0.1:${seedPort}`, '127.0.0.1:<callback>');
    return out;
  };
  const snapshot = () => {
    const out = {};
    let index = 0;
    for (const [, value] of [...store.values.entries()].sort()) {
      const doc = JSON.parse(value);
      if (doc.revision) doc.revision = '<revision>';
      out[`entry${++index}`] = JSON.parse(normalize(JSON.stringify(doc)));
    }
    return out;
  };
  const outcomeOf = (value) => value;

  // A first browser sign-in whose callback is delivered, to leave a genuine stored entry behind.
  const browserCallback = async (href, deliver) => {
    const authorization = new URL(href);
    const redirect = new URL(authorization.searchParams.get('redirect_uri'));
    Object.assign(callbackFor, { host: redirect.hostname, port: Number(redirect.port), path: redirect.pathname, state: authorization.searchParams.get('state') });
    return deliver;
  };
  const request = (target, hostHeader) => ({ method: 'GET', target, hostHeader: hostHeader ?? `${callbackFor.host}:${callbackFor.port}` });

  if (spec.seed) {
    const seedStore = store;
    const seeded = createMcpOAuth({
      url: server.url,
      credentialStore: seedStore,
      interactive: true,
      serverName: name,
      oauthClient: client,
      openBrowser: async (href) => {
        await browserCallback(href);
        // The held page ends with the sign-in; it is not awaited here.
        seedPage = rawExchange(callbackFor.host, callbackFor.port, request(GOOD(callbackFor.path, callbackFor.state)));
      },
    });
    var seedPage;
    const seedResponse = await seeded.fetch(server.url);
    if (seedResponse.status !== 405) throw new Error(`${spec.title}: seed sign-in ended with ${seedResponse.status}`);
    await seedPage;
    seedPort = callbackFor.port;
    seeded.close();
    store.ops.length = 0;
    for (const key of Object.keys(callbackFor)) delete callbackFor[key];
  }
  const before = snapshot();
  server.state.phase = 'main';
  server.state.script = [...(spec.script ?? [])];
  server.log.length = 0;
  for (const name of ['discovery', 'register']) server.state.holds[name] = spec.hold === name ? server.makeHold() : null;
  const tokenHold = server.state.holds.token;
  events = [];
  loginListener = null;
  capture = true;
  tokenArrived = false;
  intercepted = deferred();
  heldEnds = [];
  hook = spec.hook ?? null;
  virtualFlushBound = Boolean(spec.virtualFlush);

  let browserOpened = deferred();
  let heldPage = null;
  let deniedPage = null;
  const sockets = [];
  const opened = async (href) => {
    await browserCallback(href);
    events.push('browser-opened');
    browserOpened.resolve();
    if (spec.browser === 'code') heldPage = rawExchange(callbackFor.host, callbackFor.port, request(GOOD(callbackFor.path, callbackFor.state)));
    if (spec.browser === 'empty-code') heldPage = rawExchange(callbackFor.host, callbackFor.port, request(`${callbackFor.path}?code=&state=${callbackFor.state}`));
    if (spec.browser === 'denied') deniedPage = await rawExchange(callbackFor.host, callbackFor.port, request(`${callbackFor.path}?error=access_denied&state=${callbackFor.state}`));
  };

  let abort;
  let paste;
  let caller;
  const timeoutOption = spec.action === 'timeout' ? { timeoutMs: 6000 } : {};
  let settled = false;
  if (spec.mode === 'switch') {
    const sw = startMcpOAuthSwitch({ url: server.url, launch: opened, serverName: name, credentialStore: store, oauthClient: client, ...timeoutOption });
    abort = () => sw.cancel();
    paste = (url) => sw.answer(url);
    caller = sw.done.then(
      (value) => ({ kind: 'resolved', accessToken: value.tokens?.access_token ?? null, refreshToken: value.tokens?.refresh_token ?? null, clientInformation: value.clientInformation ? normalize(JSON.stringify(value.clientInformation)) : null, identity: value.identity }),
      (error) => ({ kind: 'rejected', name: error.name, code: error.code ?? null, message: normalize(error.message) })
    );
  } else {
    const oauth = createMcpOAuth({ url: server.url, credentialStore: store, interactive: true, serverName: name, oauthClient: client, openBrowser: opened, ...timeoutOption });
    abort = () => oauth.close();
    paste = (url) => oauth.completeCallback(url);
    caller = oauth.fetch(server.url).then(
      (response) => ({ kind: 'response', status: response.status, loginCompleted: oauth.loginCompleted }),
      (error) => ({ kind: 'error', name: error.name, code: error.code ?? null, message: normalize(error.message), loginCompleted: oauth.loginCompleted })
    );
    var closeOauth = () => oauth.close();
  }
  caller = caller.then((value) => {
    settled = true;
    events.push('caller-settled');
    return value;
  });

  const note = {};
  const probe = async (label) => {
    note[label] = page(await rawExchange(callbackFor.host, callbackFor.port, request(GOOD(callbackFor.path, callbackFor.state))));
  };
  const probes = async (label, paths) => {
    note[label] = [];
    for (const path of paths) note[label].push(page(await rawExchange(callbackFor.host, callbackFor.port, request(path))));
  };

  // Wait for the point the case acts at, from the client's own signals.
  const target = () => {
    if (!callbackFor.port && loginListener?.port) Object.assign(callbackFor, { host: '127.0.0.1', port: loginListener.port, path: '/oauth/callback', state: 'unknown' });
  };
  if (spec.sockets) {
    await within(browserOpened.promise, 60000, null);
    await loginListener.up.promise;
    for (const kind of ['idle', 'partial']) {
      const socket = createConnection({ host: callbackFor.host, port: callbackFor.port });
      const entry = { kind, closed: null, done: deferred() };
      sockets.push(entry);
      const end = (how) => {
        entry.closed ??= how;
        entry.done.resolve();
      };
      socket.on('error', (error) => end(`error ${error.code}`));
      socket.on('close', () => {
        events.push(`${kind}-socket-closed`);
        end('closed');
      });
      socket.on('connect', () => { if (kind === 'partial') socket.write('GET /oauth/callback?code=fix'); });
      entry.socket = socket;
    }
    await connectionsAtLeast(sockets.length + (spec.browser === 'code' ? 1 : 0));
    // The half-sent request has reached the server before the listener ends, so that destroying the connection is a
    // plain close in every run (a reset would depend on whether the server had read the bytes yet).
    const partial = sockets.find((s) => s.kind === 'partial');
    await new Promise((resolve) => {
      const check = () => {
        if (partial.socket.localPort && loginListener.dataFrom.has(partial.socket.localPort)) resolve();
        else loginListener.waiters.push(check);
      };
      check();
    });
  }
  if (spec.at === 'waiting') {
    await within(browserOpened.promise, 60000, null);
    await loginListener.up.promise;
  } else if (spec.at === 'exchange') {
    await within(tokenHold.arrived.promise, 60000, null);
  } else if (spec.at === 'discovery' || spec.at === 'register') {
    await within(server.state.holds[spec.at].arrived.promise, 60000, null);
    if (loginListener) await loginListener.up.promise;
    target();
  }
  if (spec.action === 'timeout' && settled) throw new Error(`${spec.title}: the deadline fired before the case reached ${spec.at}`);

  if (spec.virtualFlush || spec.hook) {
    // The page's end is held back: requests land between the outcome and the close of the listener.
    if (spec.at === undefined || spec.at === 'flush') {
      await within(intercepted.promise, 60000, null);
      if (spec.probeDuring) await probes('duringFlush', ['/oauth/callback?code=fixture-code&state=' + callbackFor.state, '/wrong']);
      note.callerSettledDuringFlush = settled;
      if (spec.virtualFlush === 'tick') tickVirtualTimers();
      else for (const end of heldEnds.splice(0)) end();
    }
  }
  if (spec.probeAtGate) await probe('atGate');
  if (spec.action === 'cancel') {
    events.push('abort-requested');
    abort();
  } else if (spec.action === 'paste') {
    events.push('paste');
    paste(`http://${callbackFor.host}:${callbackFor.port}${callbackFor.path}?code=fixture-code&state=${callbackFor.state}`);
  }
  const outcome = await within(caller, 30000, { kind: 'not settled within 30 s' });
  const settledWithoutRelease = settled;
  // The gate is released only now: the case observes what happened without it.
  const heldRequest = spec.at === 'exchange' ? tokenHold : server.state.holds[spec.at];
  let serverSawClose = null;
  if (heldRequest) serverSawClose = await within(heldRequest.closed.promise.then(() => true), 3000, false);
  for (const held of [tokenHold, server.state.holds.discovery, server.state.holds.register]) held?.gate.resolve();
  for (const end of heldEnds.splice(0)) end();
  // A socket of an ended listener closes by itself; one still open after the watchdog is recorded as open.
  await within(Promise.all(sockets.map((s) => s.done.promise)), 10000, null);
  const heldAnswer = heldPage ? await within(heldPage, 5000, { connection: 'no answer within 5 s' }) : null;
  target();
  if (callbackFor.port) await probe('afterwards');
  const result = {
    title: spec.title,
    spec: { mode: spec.mode ?? 'login', client: spec.client ?? 'dynamic', seed: Boolean(spec.seed), script: spec.script ?? [], browser: spec.browser ?? 'wait', at: spec.at ?? null, action: spec.action ?? null, hold: spec.hold ?? null, sockets: Boolean(spec.sockets), hook: spec.hook ?? null, virtualFlush: spec.virtualFlush ?? null },
    storeBefore: before,
    storeAfter: snapshot(),
    storeOps: store.ops,
    requests: server.log,
    outcome: outcomeOf(outcome),
    settledWithoutRelease,
    serverSawClose,
    heldPage: heldAnswer ? page(heldAnswer) : null,
    deniedPage: deniedPage ? page(deniedPage) : null,
    sockets: sockets.map((s) => ({ kind: s.kind, closed: s.closed })),
    virtualTimersLeft: virtualTimers.size,
    events,
    ...note,
  };
  virtualTimers.clear();
  virtualFlushBound = false;
  capture = false;
  closeOauthSafely(typeof closeOauth === 'function' ? closeOauth : abort);
  server.close();
  return result;
}
function closeOauthSafely(close) {
  try {
    close();
  } catch {
    /* already closed */
  }
}

// ---- the cases ----------------------------------------------------------------------------------------------------
const CASES = [];
const add = (spec) => CASES.push(spec);
const clients = ['dynamic', 'static'];

// A: the exchange of the authorization code is rejected, in every context.
for (const [errorName, error] of Object.entries(TOKEN_ERRORS)) {
  for (const client of clients) {
    add({ title: `exchange ${errorName}, first sign-in, ${client} client`, client, script: [error, 'ok'], browser: 'code' });
    add({ title: `exchange ${errorName}, seeded re-auth after a refused refresh, ${client} client`, client, seed: true, script: [{ error: 'invalid_grant' }, error, 'ok'], browser: 'code' });
    add({ title: `exchange ${errorName}, seeded re-auth (refresh unreachable, tokens kept), ${client} client`, client, seed: true, script: ['network', error, 'ok'], browser: 'code' });
    add({ title: `exchange ${errorName}, failed switch, ${client} client`, mode: 'switch', client, seed: true, script: [error, 'ok'], browser: 'code' });
  }
}
// A static client whose rejected grant is retried by the SDK: the second exchange fails, or succeeds.
for (const client of ['static']) {
  add({ title: `exchange invalid_grant then invalid_grant again, first sign-in, ${client} client`, client, script: [{ error: 'invalid_grant' }, { error: 'invalid_grant' }], browser: 'code' });
  add({ title: `exchange invalid_grant then invalid_grant again, failed switch, ${client} client`, mode: 'switch', client, seed: true, script: [{ error: 'invalid_grant' }, { error: 'invalid_grant' }], browser: 'code' });
}
// B: the refresh of a stored sign-in fails.
const REFRESH_ERRORS = { ...TOKEN_ERRORS, server_error: 'server_error', unknown_code: { error: 'weird_code' }, html_500: 'html' };
for (const [errorName, error] of Object.entries(REFRESH_ERRORS)) {
  for (const client of clients) add({ title: `refresh ${errorName}, ${client} client`, client, seed: true, script: [error, 'ok'], browser: 'code' });
}
// C: the browser step ends without a code, or the login is aborted while it waits for one.
for (const client of clients) {
  add({ title: `denied before any code, first sign-in, ${client} client`, client, script: ['ok'], browser: 'denied' });
  add({ title: `denied before any code, seeded, ${client} client`, client, seed: true, script: ['network', 'ok'], browser: 'denied' });
  add({ title: `denied before any code, switch, ${client} client`, mode: 'switch', client, seed: true, script: ['ok'], browser: 'denied' });
  add({ title: `cancel while waiting, first sign-in, ${client} client`, client, script: ['ok'], at: 'waiting', action: 'cancel' });
  add({ title: `cancel while waiting, seeded, ${client} client`, client, seed: true, script: ['network', 'ok'], at: 'waiting', action: 'cancel' });
  add({ title: `cancel while waiting, switch, ${client} client`, mode: 'switch', client, seed: true, script: ['ok'], at: 'waiting', action: 'cancel' });
  add({ title: `timeout while waiting, first sign-in, ${client} client`, client, script: ['ok'], at: 'waiting', action: 'timeout' });
  add({ title: `timeout while waiting, seeded, ${client} client`, client, seed: true, script: ['network', 'ok'], at: 'waiting', action: 'timeout' });
  add({ title: `timeout while waiting, switch, ${client} client`, mode: 'switch', client, seed: true, script: ['ok'], at: 'waiting', action: 'timeout' });
}
add({ title: 'empty code, seeded, dynamic client', seed: true, script: ['network', 'ok'], browser: 'empty-code' });
// D: discovery and registration are gated when the login is cancelled or its deadline passes.
for (const action of ['cancel', 'timeout']) {
  add({ title: `${action} while discovery is gated, first sign-in`, script: ['ok'], hold: 'discovery', at: 'discovery', action, probeAtGate: true });
  add({ title: `${action} while registration is gated, first sign-in`, script: ['ok'], hold: 'register', at: 'register', action, probeAtGate: true });
}
add({ title: 'cancel while registration is gated, switch', mode: 'switch', script: ['ok'], hold: 'register', at: 'register', action: 'cancel', probeAtGate: true });
// E: idle and half-sent connections when the listener ends, by cancel, paste and a normal end, with and without a flush.
add({ title: 'sockets: cancel while waiting (no flush)', script: ['ok'], at: 'waiting', action: 'cancel', sockets: true });
add({ title: 'sockets: paste while waiting (no flush)', script: ['ok'], at: 'waiting', action: 'paste', sockets: true });
add({ title: 'sockets: denied callback (no flush)', script: ['ok'], at: 'waiting', browser: 'denied', sockets: true });
add({ title: 'sockets: cancel during the exchange (failure page flush, delayed)', script: ['gate'], browser: 'code', at: 'exchange', action: 'cancel', sockets: true, hook: { delay: 600 } });
add({ title: 'sockets: success callback (page flush, delayed)', script: ['ok'], browser: 'code', sockets: true, hook: { delay: 600 } });
// F: the 1 s flush bound under virtual timers; a flush that finishes in time.
add({ title: 'flush bound: success page never flushed, bound fires', script: ['ok'], browser: 'code', hook: { stall: true }, virtualFlush: 'tick', probeDuring: true, at: 'flush' });
add({ title: 'flush bound: failure page never flushed, bound fires', script: [{ error: 'invalid_grant' }], browser: 'code', hook: { stall: true }, virtualFlush: 'tick', probeDuring: true, at: 'flush' });
add({ title: 'flush bound: success page flushed before the bound', script: ['ok'], browser: 'code', hook: { stall: true }, virtualFlush: 'release', probeDuring: true, at: 'flush' });
// G: the exchange is gated and the login aborted; the gate is not released until the abort was observed.
for (const client of clients) {
  add({ title: `cancel while the exchange is held, first sign-in, ${client} client`, client, script: ['gate'], browser: 'code', at: 'exchange', action: 'cancel' });
  add({ title: `timeout while the exchange is held, first sign-in, ${client} client`, client, script: ['gate'], browser: 'code', at: 'exchange', action: 'timeout' });
}
add({ title: 'cancel while the exchange is held, seeded', seed: true, script: ['network', 'gate'], browser: 'code', at: 'exchange', action: 'cancel' });
add({ title: 'cancel while the exchange is held, switch', mode: 'switch', seed: true, script: ['gate'], browser: 'code', at: 'exchange', action: 'cancel' });

const selected = CASES.filter((spec) => !only || spec.title.includes(only));
const results = [];
for (const spec of selected) {
  results.push(await runCase(spec));
  process.stderr.write(`recorded: ${spec.title}\n`);
}
if (only) {
  process.stdout.write(`${JSON.stringify(results, null, 1)}\n`);
  process.exit(0);
}
const stage = stageSet(finalDir);
writeJson(join(stage, 'golden.json'), { cases: results });
writeSetManifest(stage, { set: 'oauth-mcp-lifecycle', recorder, command: `node ${recorder} --tree <git checkout of ${commit}> --commit ${commit}`, identity });
commitStage(stage, finalDir);
process.exit(0);
