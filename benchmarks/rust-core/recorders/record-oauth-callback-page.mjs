#!/usr/bin/env node
// What a user's browser is shown by the loopback callback server of each PKCE login (Anthropic, OpenAI, Grok, Devin,
// Antigravity): the real Node `beginOAuthLogin` of each provider is started with its token endpoint scripted, then raw
// HTTP requests (as a browser, or a stray local client, would send them) are made to its real callback server and the
// complete answers are recorded: status line, every header but `Date`, and the body bytes; a connection the server no
// longer accepts is recorded as such. Every case is a fresh login, so whether a request ended the login or left it
// waiting shows in how the requests after it are answered. Rust `mixdog_ai::oauth::CallbackServer` (through
// `PkceLoginFlow`) must answer every request of every case the same.
//
//   node benchmarks/rust-core/recorders/record-oauth-callback-page.mjs --tree <git checkout at --commit, with node_modules> --commit <40-hex>
//
// Output: native/core/fixtures/oauth-callback-page/golden.json.
process.env.TZ = 'UTC';
process.env.MIXDOG_SKIP_USER_DATA_BACKUP = '1';
// The Claude CLI version Anthropic's pages quote (`resolveCliVersion`) is otherwise learned from the npm registry and a
// local `claude`: pin it to the product's default so the recording does not depend on this machine.
process.env.MIXDOG_CLI_VERSION = '2.1.317';
import { rawExchange } from './lib/raw-http.mjs';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FIXTURES_ROOT, commitCheckoutIdentity, commitStage, importFrom, parseArgs, resolveTree, stageSet, writeJson, writeSetManifest } from './lib/common.mjs';

const args = parseArgs();
const tree = resolveTree(args);
const commit = args.get('commit');
if (!commit) throw new Error('--commit <40-hex> is required');
const identity = commitCheckoutIdentity(tree, commit);
const finalDir = join(FIXTURES_ROOT, 'oauth-callback-page');
const stage = stageSet(finalDir);
const recorder = 'benchmarks/rust-core/recorders/record-oauth-callback-page.mjs';

const scratch = mkdtempSync(join(tmpdir(), 'oauth-callback-page-'));
for (const key of ['MIXDOG_DATA_DIR', 'MIXDOG_HOME', 'MIXDOG_DESKTOP_USER_DATA', 'MIXDOG_CONFIG_DIR', 'MIXDOG_RUNTIME_ROOT', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA']) {
  process.env[key] = join(scratch, key);
  mkdirSync(process.env[key], { recursive: true });
}

const openai = await importFrom(tree, 'src/runtime/agent/orchestrator/providers/openai-oauth-tokens.mjs');
const anthropic = await importFrom(tree, 'src/runtime/agent/orchestrator/providers/anthropic-oauth-credentials.mjs');
const grok = await importFrom(tree, 'src/runtime/agent/orchestrator/providers/grok-oauth-login.mjs');
const devin = await importFrom(tree, 'src/runtime/agent/orchestrator/providers/devin-auth.mjs');
const antigravity = await importFrom(tree, 'src/runtime/agent/orchestrator/providers/antigravity-oauth-login.mjs');

// --- the scripted network -------------------------------------------------------------------------------------------
const jwt = (claims) => ['h', Buffer.from(JSON.stringify(claims)).toString('base64url'), 's'].join('.');
const ACCESS = jwt({ exp: 4_102_444_800, sub: 'user-1', email: 'ann@x.test' });
const GRANT = { access_token: ACCESS, refresh_token: 'refresh-1', expires_in: 3600, id_token: ACCESS };

// What the token endpoint does, by behavior name. Each is served for the one token request of a case.
const BEHAVIORS = {
  ok: null,
  timeout: { threw: { name: 'TimeoutError', message: 'The operation was aborted due to timeout' } },
  reset: { threw: { name: 'TypeError', message: 'fetch failed', cause: { code: 'ECONNRESET', message: 'read ECONNRESET' } } },
  network: { threw: { name: 'TypeError', message: 'fetch failed' } },
  http400: { status: 400, body: '{"error":"invalid_grant","error_description":"The code is invalid <b>or</b> used"}' },
  http403: { status: 403, body: '{"error":"forbidden"}' },
  http500: { status: 500, body: 'upstream\n  down' },
  notJson: { status: 200, body: 'not json' },
  missingTokens: { status: 200, body: '{}' },
};

const served = [];
let behavior = 'ok';
let okBody = JSON.stringify(GRANT);
const fail = (spec) => {
  const error = Object.assign(new Error(spec.message), { name: spec.name });
  if (spec.cause) error.cause = Object.assign(new Error(spec.cause.message), { code: spec.cause.code });
  return error;
};
const reply = (status, body) => new Response(body, { status, headers: { 'content-type': 'application/json' } });
const route = async (input, init = {}) => {
  const url = String(input instanceof URL ? input.href : (input?.url ?? input));
  const method = init.method ?? 'GET';
  if (url.includes('/.well-known/openid-configuration')) {
    return reply(200, JSON.stringify({ authorization_endpoint: 'https://auth.x.ai/oauth2/authorize', token_endpoint: 'https://auth.x.ai/oauth2/token' }));
  }
  if (url.endsWith('/oauth2/device/code') || url.endsWith('/deviceauth/usercode')) return new Response('', { status: 404 });
  let answer;
  if (url.includes('userinfo')) answer = { status: 200, body: JSON.stringify({ email: 'ann@x.test', id: 'g-1' }) };
  else if (url.includes('v1internal')) {
    answer = { status: 200, body: JSON.stringify({ currentTier: { id: 'standard-tier' }, paidTier: { id: 'g1-pro-tier' }, cloudaicompanionProject: 'proj-1' }) };
  } else {
    answer = BEHAVIORS[behavior] ?? { status: 200, body: okBody };
  }
  served.push({ method, url, ...answer });
  if (answer.threw) throw fail(answer.threw);
  return reply(answer.status, answer.body);
};
globalThis.fetch = route;

let onListening = () => {};
const realWrite = process.stderr.write.bind(process.stderr);
process.stderr.write = (chunk, ...rest) => {
  if (/Open (this URL|the Devin sign-in page)/.test(String(chunk))) onListening();
  return realWrite(chunk, ...rest);
};

// --- the cases ---------------------------------------------------------------------------------------------------------
const PROVIDERS = {
  anthropic: { host: 'localhost', port: 54545, path: '/callback', begin: () => anthropic.beginOAuthLogin({ openBrowser: false }) },
  openai: { host: '127.0.0.1', port: 1455, path: '/auth/callback', begin: () => openai.beginOAuthLogin({ openBrowser: false }) },
  grok: { host: '127.0.0.1', port: 56121, path: '/callback', begin: () => grok.beginOAuthLogin({ openBrowser: false }) },
  devin: { host: '127.0.0.1', port: 59653, path: '/callback', begin: () => devin.beginDevinOAuthLogin({ openBrowser: false, fetchFn: route }) },
  antigravity: { host: '127.0.0.1', port: 51121, path: '/oauth-callback', begin: () => antigravity.beginOAuthLogin({ openBrowser: false, fetchFn: route }) },
};

// `{path}` and `{state}` are the provider's callback path and this login's state; `{host}` is the Host the browser sent.
const CASES = [
  ['success', 'ok', [{ method: 'GET', target: '{path}?code=abc&state={state}' }]],
  ['wrong path, then the callback', 'ok', [{ method: 'GET', target: '/nope?code=abc&state={state}' }, { method: 'GET', target: '{path}?code=abc&state={state}' }]],
  ['trailing slash, then dot segments', 'ok', [{ method: 'GET', target: '{path}/?code=abc&state={state}' }, { method: 'GET', target: '/x/..{path}?code=abc&state={state}' }]],
  ['wrong state and no state, then the callback', 'ok', [{ method: 'GET', target: '{path}?code=abc&state=wrong' }, { method: 'GET', target: '{path}?code=abc' }, { method: 'GET', target: '{path}?code=abc&state={state}' }]],
  ['no code, then the callback', 'ok', [{ method: 'GET', target: '{path}?state={state}' }, { method: 'GET', target: '{path}?code=abc&state={state}' }]],
  ['empty code, then the callback', 'ok', [{ method: 'GET', target: '{path}?code=&state={state}' }, { method: 'GET', target: '{path}?code=abc&state={state}' }]],
  ['blank code, then the callback', 'ok', [{ method: 'GET', target: '{path}?code=%20&state={state}' }, { method: 'GET', target: '{path}?code=abc&state={state}' }]],
  ['authorization error, then the callback', 'ok', [{ method: 'GET', target: '{path}?error=access_denied&state={state}' }, { method: 'GET', target: '{path}?code=abc&state={state}' }]],
  ['authorization error with markup in its description, then the callback', 'ok', [{ method: 'GET', target: '{path}?error=access_denied&error_description=%3Cb%3Ex%3C%2Fb%3E&state={state}' }, { method: 'GET', target: '{path}?code=abc&state={state}' }]],
  ['authorization error with another state, then the callback', 'ok', [{ method: 'GET', target: '{path}?error=access_denied&state=wrong' }, { method: 'GET', target: '{path}?code=abc&state={state}' }]],
  ['authorization error beside a code, then the callback', 'ok', [{ method: 'GET', target: '{path}?error=access_denied&code=abc&state={state}' }, { method: 'GET', target: '{path}?code=abc&state={state}' }]],
  ['POST of the callback, then GET', 'ok', [{ method: 'POST', target: '{path}?code=abc&state={state}' }, { method: 'GET', target: '{path}?code=abc&state={state}' }]],
  ['another Host', 'ok', [{ method: 'GET', target: '{path}?code=abc&state={state}', hostHeader: 'evil.test' }]],
  ['repeated parameters', 'ok', [{ method: 'GET', target: '{path}?code=abc&code=zzz&state={state}&state=wrong' }]],
  ['callback repeated after the login ended', 'ok', [{ method: 'GET', target: '{path}?code=abc&state={state}' }, { method: 'GET', target: '{path}?code=abc&state={state}' }]],
  ['token endpoint timed out', 'timeout', [{ method: 'GET', target: '{path}?code=abc&state={state}' }]],
  ['token endpoint reset the connection', 'reset', [{ method: 'GET', target: '{path}?code=abc&state={state}' }]],
  ['token endpoint unreachable', 'network', [{ method: 'GET', target: '{path}?code=abc&state={state}' }]],
  ['token endpoint refused the code (400)', 'http400', [{ method: 'GET', target: '{path}?code=abc&state={state}' }, { method: 'GET', target: '{path}?code=abc&state={state}' }]],
  ['token endpoint forbade the request (403)', 'http403', [{ method: 'GET', target: '{path}?code=abc&state={state}' }]],
  ['token endpoint failed (500)', 'http500', [{ method: 'GET', target: '{path}?code=abc&state={state}' }]],
  ['token endpoint answered without JSON', 'notJson', [{ method: 'GET', target: '{path}?code=abc&state={state}' }]],
  ['token endpoint answered without tokens', 'missingTokens', [{ method: 'GET', target: '{path}?code=abc&state={state}' }]],
];

const cases = [];
for (const [name, spec] of Object.entries(PROVIDERS)) {
  for (const [title, behaviorName, requests] of CASES) {
    behavior = behaviorName;
    served.length = 0;
    // Every login names its URL on stderr once its listener is bound (Anthropic's `beginOAuthLogin` returns before that).
    const listening = new Promise((resolve) => { onListening = resolve; });
    const login = await spec.begin();
    await listening;
    const state = new URL(login.url).searchParams.get('state');
    let settled = 'pending';
    login.waitForCallback.then(
      (value) => { settled = value == null ? 'null' : 'tokens'; },
      (error) => { settled = `error: ${error.message}`; }
    );
    const answers = [];
    for (const request of requests) {
      const filled = (text) => text.replaceAll('{path}', spec.path).replaceAll('{state}', state);
      const sent = { method: request.method, target: filled(request.target), hostHeader: request.hostHeader ?? `${spec.host}:${spec.port}` };
      const answer = await rawExchange(spec.host, spec.port, sent);
      answers.push({ method: request.method, target: request.target, hostHeader: request.hostHeader ?? null, answer });
    }
    // A login settles before its last answer is written; a tick lets the settlement reach the flag.
    await new Promise((resolve) => setImmediate(resolve));
    cases.push({ provider: name, title, behavior: behaviorName, path: spec.path, served: [...served], settled, answers });
    login.cancel();
    await new Promise((resolve) => setImmediate(resolve));
  }
}

writeJson(join(stage, 'golden.json'), { cases });
writeSetManifest(stage, { set: 'oauth-callback-page', recorder, command: `node ${recorder} --tree <git checkout of ${commit}> --commit ${commit}`, identity });
commitStage(stage, finalDir);
process.exit(0);
