#!/usr/bin/env node
// The Devin sign-in (providers/devin-auth.mjs): `generateDevinOAuthParams` (the authorize URL a
// login opens) and the real `exchangeDevinCode` over a scripted `fetch` (the request it sends, the
// token record it stores or the coded failure it raises), `Date.now` fixed. Rust
// `mixdog_ai::providers::devin::login::DevinLogin` must build the same URL from the same state and
// challenge, send the same request and store / refuse the same.
//
//   node benchmarks/rust-core/recorders/record-devin-login.mjs [--tree <dir>]
//
// Output: native/core/fixtures/devin-login/golden.json.
process.env.TZ = 'UTC';
process.env.MIXDOG_SKIP_USER_DATA_BACKUP = '1';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FIXTURES_ROOT, commitStage, importFrom, parseArgs, resolveTree, stageSet, writeJson, writeSetManifest } from './lib/common.mjs';

const NOW = 1_800_000_000_000;
Date.now = () => NOW;
const tree = resolveTree(parseArgs());
const finalDir = join(FIXTURES_ROOT, 'devin-login');
const stage = stageSet(finalDir);
const recorder = 'benchmarks/rust-core/recorders/record-devin-login.mjs';
process.env.MIXDOG_DATA_DIR = mkdtempSync(join(tmpdir(), 'devin-login-rec-'));
process.env.MIXDOG_HOME = mkdtempSync(join(tmpdir(), 'devin-login-home-'));
const auth = await importFrom(tree, 'src/runtime/agent/orchestrator/providers/devin-auth.mjs');

// Short header and signature keep the fixture from looking like a real token.
const jwt = (claims) => ['h', Buffer.from(JSON.stringify(claims)).toString('base64url'), 's'].join('.');
const exp = Math.floor(NOW / 1000) + 3600;
const answer = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => (typeof body === 'string' ? JSON.parse(body) : body) });
const SCENARIOS = [
  ['token with exp, sub and email', () => answer(200, { token: jwt({ exp, sub: 'user-1', email: 'ann@x.test' }) })],
  ['token with sub only', () => answer(200, { token: jwt({ exp, sub: 'user-2' }) })],
  ['token with padded fields', () => answer(200, { token: jwt({ exp, sub: ' user-3 ', email: '  ' }) })],
  ['token without exp: a year', () => answer(200, { token: jwt({ sub: 'user-4' }) })],
  ['token that is not a JWT', () => answer(200, { token: 'opaque-token' })],
  ['token whose claims are not an object', () => answer(200, { token: ['h', Buffer.from('[1]').toString('base64url'), 's'].join('.') })],
  ['no token in the answer', () => answer(200, { other: 1 })],
  ['empty token', () => answer(200, { token: '' })],
  ['token that is not a string', () => answer(200, { token: 5 })],
  ['answer that is not JSON', () => answer(200, 'null')],
  ['401', () => answer(401, { error: 'denied', token: 'leaky' })],
  ['500', () => answer(500, {})],
  ['no answer', () => { throw new TypeError('fetch failed'); }],
];
const exchanges = [];
for (const [name, respond] of SCENARIOS) {
  const requests = [];
  const fetchFn = async (url, init) => {
    requests.push({ url, method: init.method, headers: init.headers, body: init.body, redirect: init.redirect });
    return respond();
  };
  let outcome;
  try {
    outcome = { tokens: await auth.exchangeDevinCode('the-code', 'the-verifier', { fetchFn }) };
  } catch (error) {
    outcome = { message: error.message, failureCode: error.failureCode ?? null };
  }
  exchanges.push({ name, now: NOW, requests, outcome });
}

// The authorize URL: Node draws the state and challenge itself, so they are read back from it.
const params = auth.generateDevinOAuthParams();
const url = new URL(params.loginUrl);
const authorize = { state: params.state, challenge: params.challenge, url: params.loginUrl, keys: [...url.searchParams.keys()] };

writeJson(join(stage, 'golden.json'), { authorize, exchanges });
writeSetManifest(stage, { set: 'devin-login', recorder, command: 'node ' + recorder + ' --tree <tree>', identityTree: tree });
commitStage(stage, finalDir);
