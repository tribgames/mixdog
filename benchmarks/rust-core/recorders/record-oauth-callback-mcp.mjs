#!/usr/bin/env node
// What a user's browser is shown by the loopback callback of an MCP connector sign-in (`createMcpOAuth`, the SDK
// browser login): the real Node client signs in to an in-process MCP + authorization server (discovery, dynamic
// registration or a pre-registered client, a scripted token endpoint); its `openBrowser` makes raw HTTP requests to the
// callback listener and the complete answers are recorded (status line, every header but `Date`, body bytes; a
// connection the listener no longer accepts as such). A request marked `hold` is the callback whose page is held until
// the code exchange ends; `during` requests are made while that exchange is held at the token endpoint; `post`
// requests after the sign-in ended. Rust `mixdog_mcp::oauth` (the `LoginFlow` over the same server) must answer every
// request of every case the same.
//
//   node benchmarks/rust-core/recorders/record-oauth-callback-mcp.mjs --tree <git checkout at --commit, with node_modules> --commit <40-hex>
//
// Output: native/core/fixtures/oauth-callback-mcp/golden.json.
process.env.TZ = 'UTC';
process.env.MIXDOG_SKIP_USER_DATA_BACKUP = '1';
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FIXTURES_ROOT, commitCheckoutIdentity, commitStage, importFrom, parseArgs, resolveTree, stageSet, writeJson, writeSetManifest } from './lib/common.mjs';
import http from 'node:http';
import { rawExchange } from './lib/raw-http.mjs';

const args = parseArgs();
const tree = resolveTree(args);
const commit = args.get('commit');
if (!commit) throw new Error('--commit <40-hex> is required');
const identity = commitCheckoutIdentity(tree, commit);
const finalDir = join(FIXTURES_ROOT, 'oauth-callback-mcp');
const stage = stageSet(finalDir);
const recorder = 'benchmarks/rust-core/recorders/record-oauth-callback-mcp.mjs';

const scratch = mkdtempSync(join(tmpdir(), 'oauth-callback-mcp-'));
for (const key of ['MIXDOG_DATA_DIR', 'MIXDOG_HOME', 'MIXDOG_DESKTOP_USER_DATA', 'MIXDOG_CONFIG_DIR', 'MIXDOG_RUNTIME_ROOT', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA']) {
  process.env[key] = join(scratch, key);
  mkdirSync(process.env[key], { recursive: true });
}
const { createMcpOAuth } = await importFrom(tree, 'src/runtime/agent/orchestrator/mcp/oauth.mjs');

const memoryStore = () => {
  const values = new Map();
  return {
    getSecretAsync: async (key) => values.get(key),
    setSecretAsync: async (key, value) => { values.set(key, value); },
    deleteSecretAsync: async (key) => { values.delete(key); },
  };
};

const CALENDAR = 'https://www.googleapis.com/auth/calendar.events';
const SCOPED_CLIENT = { clientId: 'scoped-client', scopes: ['openid', 'email', CALENDAR] };

// The MCP server that is also its authorization server. `token`: 'ok' | 'refused' | 'missing scope' | 'gated' (the
// exchange waits for `release()`, which the case does once its `during` requests were answered).
async function fixture(token) {
  let origin;
  let exchanges = 0;
  let arrive;
  const arrived = new Promise((resolve) => { arrive = resolve; });
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const json = (res, status, doc) => res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(doc));
  const server = createServer(async (req, res) => {
    const path = new URL(req.url, origin).pathname;
    let body = '';
    for await (const chunk of req) body += chunk;
    if (path.startsWith('/.well-known/oauth-protected-resource')) json(res, 200, { resource: `${origin}/mcp`, authorization_servers: [origin] });
    else if (path.startsWith('/.well-known/')) {
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
    } else if (path === '/register') json(res, 201, { ...JSON.parse(body), client_id: 'fixture-client' });
    else if (path === '/token') {
      exchanges++;
      arrive();
      if (token === 'gated') await gate;
      if (token === 'refused') return json(res, 400, { error: 'invalid_grant' });
      json(res, 200, {
        access_token: 'fixture-token',
        refresh_token: 'fixture-refresh',
        token_type: 'Bearer',
        expires_in: 3600,
        ...(token === 'missing scope' && { scope: 'openid email' }),
      });
    } else if (path === '/mcp') {
      if (req.headers.authorization === 'Bearer fixture-token') return res.writeHead(405).end();
      res.writeHead(401, { 'WWW-Authenticate': `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource"` }).end();
    } else res.writeHead(404).end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
  return {
    url: `${origin}/mcp`,
    exchanges: () => exchanges,
    arrived,
    release,
    close() {
      server.closeAllConnections();
      server.close();
    },
  };
}

// A slow flush of the held page, to land requests in the window between the login's outcome and the close of the
// listener (Node awaits the page's flush, then closes). With `slowFlush` set the next page written after the
// token request arrived is ended `slowFlush` ms late; `flushing` resolves when that wait starts.
let slowFlush = 0;
let tokenArrived = false;
let callbackPort = 0;
let flushing = () => {};
const realEnd = http.ServerResponse.prototype.end;
http.ServerResponse.prototype.end = function (...args) {
  if (slowFlush && tokenArrived && this.req.socket.localPort === callbackPort) {
    const wait = slowFlush;
    slowFlush = 0;
    flushing();
    setTimeout(() => realEnd.apply(this, args), wait);
    return this;
  }
  return realEnd.apply(this, args);
};

const GOOD = '{path}?code=fixture-code&state={state}';
const get = (target, extra = {}) => ({ method: 'GET', target, ...extra });
const CASES = [
  { title: 'success', token: 'ok', pre: [get(GOOD, { hold: true })], post: [get(GOOD)] },
  { title: 'success of a server named with markup', token: 'ok', serverName: 'Fixture <Docs> & "co"', pre: [get(GOOD, { hold: true })], post: [] },
  { title: 'authorization denied', token: 'ok', pre: [get('{path}?error=access_denied&error_description=%3Cscript%3Ereflected%3C%2Fscript%3E&state={state}')], post: [get(GOOD)] },
  { title: 'authorization denied beside a code', token: 'ok', serverName: 'Denied', pre: [get('{path}?error=access_denied&code=fixture-code&state={state}')], post: [] },
  { title: 'authorization denied with another state, then the callback', token: 'ok', pre: [get('{path}?error=access_denied&state=wrong'), get(GOOD, { hold: true })], post: [] },
  {
    title: 'requests that are not the callback, then the callback',
    token: 'ok',
    pre: [
      get('/wrong?code=fixture-code&state={state}'),
      get('{path}/?code=fixture-code&state={state}'),
      get('{path}?code=fixture-code'),
      get('{path}?code=fixture-code&state='),
      get('{path}?code=fixture-code&state=attacker'),
      get('{path}?code=fixture-code&state={state}&state=attacker'),
      get('{path}?code=fixture-code&state=attacker&state={state}'),
      get('{path}?state={state}'),
      get('{path}?code=a&code=b&state={state}'),
      get('{path}#frag?code=fixture-code&state={state}'),
      { method: 'POST', target: GOOD },
      { method: 'HEAD', target: GOOD },
      { method: 'OPTIONS', target: GOOD },
      { method: 'PUT', target: GOOD },
      get(GOOD, { hostHeader: 'evil.test' }),
      get(GOOD, { hostHeader: 'localhost:{port}' }),
      get(GOOD, { hold: true }),
    ],
    post: [],
  },
  { title: 'empty code', token: 'ok', pre: [get('{path}?code=&state={state}', { hold: true })], post: [get(GOOD)] },
  { title: 'token endpoint refused the code', token: 'refused', pre: [get(GOOD, { hold: true })], post: [get(GOOD)] },
  { title: 'a granular consent left a scope unchecked', token: 'missing scope', client: SCOPED_CLIENT, serverName: 'Google Drive', pre: [get(GOOD, { hold: true })], post: [] },
  {
    title: 'requests while the code exchange is held',
    token: 'gated',
    pre: [get(GOOD, { hold: true })],
    during: [get(GOOD), get('{path}?code=fixture-code&state=attacker'), get('{path}?error=access_denied&state={state}'), get('/wrong'), { method: 'POST', target: GOOD }],
    post: [get(GOOD)],
  },
  // A pasted callback stops the listener before the exchange: a browser request meanwhile is refused.
  {
    title: 'a pasted callback while the code exchange is held',
    token: 'gated',
    paste: true,
    pre: [],
    during: [get(GOOD), get('/wrong'), { method: 'POST', target: GOOD }],
    post: [get(GOOD)],
  },
  // The page is flushed late: requests in that window still reach the open listener (the login's callback is taken,
  // so they get the invalid-link page), and the listener closes only after the flush.
  { title: 'requests while the success page is flushed', token: 'ok', slowFlush: 600, pre: [get(GOOD, { hold: true })], flush: [get(GOOD), get('/wrong'), get('{path}?code=fixture-code&state=attacker'), { method: 'POST', target: GOOD }], post: [get(GOOD)] },
  { title: 'requests while the failure page is flushed', token: 'refused', slowFlush: 600, pre: [get(GOOD, { hold: true })], flush: [get(GOOD), get('/wrong')], post: [get(GOOD)] },
];

const cases = [];
for (const spec of CASES) {
  const server = await fixture(spec.token);
  const steps = [];
  const held = [];
  const callbackFor = {};
  const send = async (phase, step) => {
    const { host, port, path, state } = callbackFor;
    const fill = (text) => text.replaceAll('{path}', path).replaceAll('{state}', state).replaceAll('{port}', String(port));
    const request = { method: step.method, target: fill(step.target), hostHeader: step.hostHeader ? fill(step.hostHeader) : `${host}:${port}` };
    const record = { phase, method: step.method, target: step.target, hostHeader: step.hostHeader ?? null, hold: step.hold ?? false, answer: null };
    steps.push(record);
    if (step.hold) held.push(rawExchange(host, port, request).then((answer) => { record.answer = answer; }));
    else record.answer = await rawExchange(host, port, request);
  };
  let during = Promise.resolve();
  let flushPhase = Promise.resolve();
  const oauth = createMcpOAuth({
    url: server.url,
    credentialStore: memoryStore(),
    interactive: true,
    serverName: spec.serverName ?? 'Fixture',
    oauthClient: spec.client ?? null,
    openBrowser: async (href) => {
      slowFlush = spec.slowFlush ?? 0;
      tokenArrived = false;
      server.arrived.then(() => { tokenArrived = true; });
      const authorization = new URL(href);
      const redirect = new URL(authorization.searchParams.get('redirect_uri'));
      callbackPort = Number(redirect.port);
      Object.assign(callbackFor, { host: redirect.hostname, port: Number(redirect.port), path: redirect.pathname, state: authorization.searchParams.get('state') });
      for (const step of spec.pre) await send('pre', step);
      if (spec.flush) {
        flushPhase = (async () => {
          await new Promise((resolve) => { flushing = resolve; });
          for (const step of spec.flush) await send('flush', step);
        })();
      }
      if (spec.during) {
        during = (async () => {
          if (spec.paste) {
            const pasted = `${redirect.origin}${redirect.pathname}?code=fixture-code&state=${authorization.searchParams.get('state')}`;
            for (let attempt = 0; ; attempt += 1) {
              try {
                oauth.completeCallback(pasted);
                break;
              } catch (error) {
                if (attempt > 400) throw error;
                await new Promise((resolve) => setTimeout(resolve, 5));
              }
            }
          }
          await server.arrived;
          for (const step of spec.during) await send('during', step);
          server.release();
        })();
      }
    },
  });
  const outcome = await oauth.fetch(server.url).then((response) => `status ${response.status}`, (error) => `error: ${error.message}`);
  await during;
  await flushPhase;
  await Promise.all(held);
  for (const step of spec.post) await send('post', step);
  cases.push({
    title: spec.title,
    token: spec.token,
    paste: spec.paste ?? false,
    slowFlush: spec.slowFlush ?? 0,
    serverName: spec.serverName ?? 'Fixture',
    client: spec.client ?? null,
    steps,
    exchanges: server.exchanges(),
    signedIn: oauth.loginCompleted,
    outcome,
  });
  oauth.close();
  server.close();
}

writeJson(join(stage, 'golden.json'), { cases });
writeSetManifest(stage, { set: 'oauth-callback-mcp', recorder, command: `node ${recorder} --tree <git checkout of ${commit}> --commit ${commit}`, identity });
commitStage(stage, finalDir);
process.exit(0);