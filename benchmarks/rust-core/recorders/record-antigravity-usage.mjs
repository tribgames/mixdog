#!/usr/bin/env node
// Golden twin of `AntigravityOAuthProvider.getUsageSnapshot()` (providers/antigravity-oauth.mjs):
// the `retrieveUserQuotaSummary` request (url, header order, body, redirect mode, timeout), the
// quota rows `antigravityQuotaWindows` builds from the bucket groups (Gemini 5H/7D, Argon, Claude/GPT
// and the model scopes each gates), the token refresh behind an expiring credential, and every failure.
// Node's real provider runs on a temp credentials file with a scripted `fetchFn` and a frozen clock.
// The refresh request's form body carries the app's client secret: it is recorded as `<form>`.
//
// Every user directory is a temp dir before any Mixdog module loads.
//   node benchmarks/rust-core/recorders/record-antigravity-usage.mjs --tree <dir with node_modules> [--out <dir>]
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FIXTURES_ROOT, importFrom, parseArgs, resolveTree, writeJson, writeSetManifest } from './lib/common.mjs';

const cli = parseArgs();
const tree = resolveTree(cli);
const outDir = cli.get('out') ?? join(FIXTURES_ROOT, 'antigravity-usage');
const base = mkdtempSync(join(tmpdir(), 'antigravity-usage-'));
const userDirs = { HOME: 'home', USERPROFILE: 'home', APPDATA: 'appdata', LOCALAPPDATA: 'localappdata', MIXDOG_HOME: 'mixdog-home' };
for (const [name, dir] of Object.entries(userDirs)) {
  mkdirSync(join(base, dir), { recursive: true });
  process.env[name] = join(base, dir);
}
process.env.MIXDOG_SKIP_USER_DATA_BACKUP = '1';
process.env.MIXDOG_DATA_DIR = join(base, 'data');
process.env.MIXDOG_ANTIGRAVITY_VERSION = '9.9.9';
mkdirSync(process.env.MIXDOG_DATA_DIR, { recursive: true });
delete process.env.MIXDOG_MODEL_PROXY;
delete process.env.NODE_TEST_CONTEXT;
const NOW = 1_800_000_000_000;
Date.now = () => NOW;

const mod = await importFrom(tree, 'src/runtime/agent/orchestrator/providers/antigravity-oauth.mjs');

let timeouts = [];
const realTimeout = AbortSignal.timeout.bind(AbortSignal);
AbortSignal.timeout = (ms) => {
  timeouts.push(ms);
  return realTimeout(2_147_000_000);
};

const QUOTA = 'https://daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary';
const TOKEN = 'https://oauth2.googleapis.com/token';
const FAR = NOW + 3_600_000;
const creds = (extra = {}) => ({ access_token: 'ya29.access-1', refresh_token: 'refresh-1', expires_at: FAR, project_id: 'proj-1', tier_id: 'free-tier', email: 'a@b.test', user_id: 'u1', ...extra });
const bucket = (bucketId, window, remainingFraction, resetTime) => ({ bucketId, window, ...(remainingFraction === undefined ? {} : { remainingFraction }), ...(resetTime === undefined ? {} : { resetTime }) });
const group = (...buckets) => ({ name: 'g', buckets });
const summary = (...groups) => ({ groups });
const ok = (body) => ({ url: QUOTA, status: 200, body });
const fail = (status, text) => ({ url: QUOTA, status, text });
const G5 = (rf, rt) => bucket('gemini-5h', '5h', rf, rt);
const GW = (rf, rt) => bucket('gemini-weekly', 'weekly', rf, rt);
const AW = (rf, rt) => bucket('gemini-argon-wtu-weekly', 'weekly', rf, rt);
const T5 = (rf, rt) => bucket('3p-5h', '5h', rf, rt);
const TW = (rf, rt) => bucket('3p-weekly', 'weekly', rf, rt);
const R = '2027-01-01T00:00:00Z';

const flows = [
  { name: 'every bucket', creds: creds(), replies: [ok(summary(group(G5(0.75, R), GW(0.5, R)), group(AW(0.9, R)), group(T5(0.2, R), TW(0.1, R))))] },
  { name: 'the Gemini pair alone gates everything', creds: creds(), replies: [ok(summary(group(G5(0.75, R), GW(0.5))))] },
  { name: 'the third-party pair claims its models from Gemini', creds: creds(), replies: [ok(summary(group(G5(0.5), GW(0.5)), group(T5(0.5, R))))] },
  { name: 'a lone third-party weekly bucket', creds: creds(), replies: [ok(summary(group(TW(0.4, R))))] },
  { name: 'the Argon bucket claims Argon', creds: creds(), replies: [ok(summary(group(G5(0.5)), group(AW(0.3, R))))] },
  { name: 'Argon alone', creds: creds(), replies: [ok(summary(group(AW(0.3))))] },
  { name: 'remaining fractions', creds: creds(), replies: [ok(summary(group(G5(0), GW(1)), group(AW(0.123456), T5(1.5), TW(-0.5))))] },
  { name: 'unusable fractions drop the row', creds: creds(), replies: [ok(summary(group(G5('0.5'), GW(null), bucket('gemini-weekly', 'weekly'), AW(Number.NaN))))] },
  { name: 'reset forms', creds: creds(), replies: [ok(summary(group(G5(0.5, ''), GW(0.5, 12345)), group(AW(0.5, 'soon'), T5(0.5, '1970-01-01T00:00:00Z'), TW(0.5, '1900000000'))))] },
  { name: 'a null and a false reset', creds: creds(), replies: [ok(summary(group(G5(0.5, null), GW(0.5, false))))] },
  { name: 'the bucket id with the wrong window', creds: creds(), replies: [ok(summary(group(bucket('gemini-5h', 'weekly', 0.5), bucket('gemini-weekly', '5h', 0.5), bucket('3p-5h', 'weekly', 0.5))))] },
  { name: 'the first matching bucket wins', creds: creds(), replies: [ok(summary(group(G5(0.1, R)), group(G5(0.9, R))))] },
  { name: 'buckets across groups', creds: creds(), replies: [ok(summary(group(G5(0.5)), group(GW(0.5))))] },
  { name: 'odd groups and buckets', creds: creds(), replies: [ok({ groups: [null, 5, [], { buckets: 'x' }, { buckets: [null, 3, [], G5(0.5)] }] })] },
  { name: 'groups is not an array', creds: creds(), replies: [ok({ groups: { a: 1 } })] },
  { name: 'an empty summary', creds: creds(), replies: [ok({})] },
  { name: 'a null summary', creds: creds(), replies: [{ url: QUOTA, status: 200, text: 'null' }] },
  { name: 'an array summary', creds: creds(), replies: [{ url: QUOTA, status: 200, text: '[]' }] },
  { name: 'not JSON', creds: creds(), replies: [{ url: QUOTA, status: 200, text: 'nope' }] },
  { name: 'an empty body', creds: creds(), replies: [{ url: QUOTA, status: 200, text: '' }] },
  { name: 'rejected token', creds: creds(), replies: [fail(401, 'denied')] },
  { name: 'server error with a long body', creds: creds(), replies: [fail(500, `boom ${'x'.repeat(400)}`)] },
  { name: 'an error body that names a token', creds: creds(), replies: [fail(403, '{"error":"no","access_token":"ya29.secret","n":1}')] },
  { name: 'an error body with a bearer token', creds: creds(), replies: [fail(500, 'Authorization: Bearer abc.def-123 failed')] },
  { name: 'an empty error body', creds: creds(), replies: [fail(503, '')] },
  { name: 'transport failure', creds: creds(), replies: [{ url: QUOTA, fail: true }] },
  { name: 'no project id', creds: creds({ project_id: '' }), replies: [ok(summary(group(G5(0.5))))] },
  { name: 'a camelCase project id', creds: { access_token: 'a', refresh_token: 'r', expiresAt: FAR, projectId: 'proj-2' }, replies: [ok(summary(group(G5(0.5))))] },
  { name: 'expiry in seconds', creds: creds({ expires_at: Math.floor(FAR / 1000) }), replies: [ok(summary(group(G5(0.5))))] },
  { name: 'no expiry is not refreshed', creds: creds({ expires_at: 0 }), replies: [ok(summary(group(G5(0.5))))] },
  { name: 'an expiring token is refreshed first', creds: creds({ expires_at: NOW + 60_000 }), replies: [{ url: TOKEN, status: 200, body: { access_token: 'ya29.access-2', expires_in: 3600 } }, ok(summary(group(G5(0.5))))] },
  { name: 'a refresh that fails on a still valid token', creds: creds({ expires_at: NOW + 60_000 }), replies: [{ url: TOKEN, status: 500, text: 'down' }, ok(summary(group(G5(0.5))))] },
  { name: 'a refresh the server rejects on a still valid token is refused', creds: creds({ expires_at: NOW + 60_000 }), replies: [{ url: TOKEN, status: 400, text: '{"error":"invalid_grant"}' }] },
  { name: 'an expired token and a failing refresh', creds: creds({ expires_at: NOW - 1000 }), replies: [{ url: TOKEN, status: 500, text: 'down' }] },
  { name: 'no credentials file', creds: null, replies: [] },
  { name: 'a file without a refresh token', creds: { access_token: 'a' }, replies: [] },
];

const plain = (v) => (v === undefined ? null : JSON.parse(JSON.stringify(v)));
const results = [];
let n = 0;
for (const flow of flows) {
  n += 1;
  const path = join(base, `creds-${n}.json`);
  process.env.ANTIGRAVITY_OAUTH_CREDENTIALS_PATH = path;
  if (flow.creds) writeFileSync(path, JSON.stringify(flow.creds));
  const script = flow.replies.map((r) => ({ ...r }));
  const wire = [];
  timeouts = [];
  const fetchFn = async (url, options = {}) => {
    const isToken = String(url) === TOKEN;
    wire.push({ url: String(url), method: options.method ?? 'GET', headers: Object.entries(options.headers ?? {}), body: isToken ? '<form>' : options.body ?? null, redirect: options.redirect ?? null, timeoutMs: timeouts.shift() ?? null });
    const next = script.find((entry) => entry.url === String(url) && !entry.used);
    if (!next || next.fail) {
      if (next) next.used = true;
      throw new TypeError('fetch failed');
    }
    next.used = true;
    return new Response(next.text ?? JSON.stringify(next.body), { status: next.status ?? 200 });
  };
  let out;
  try {
    const provider = new mod.AntigravityOAuthProvider({ fetchFn, preconnectFn: () => {} });
    out = { snapshot: plain(await provider.getUsageSnapshot()) };
  } catch (error) {
    out = { error: { message: String(error?.message ?? error), status: error?.status ?? null, reauthRequired: error?.reauthRequired === true } };
  }
  const stored = flow.creds ? JSON.parse(readFileSync(path, 'utf8')) : null;
  results.push({ name: flow.name, creds: flow.creds, replies: flow.replies, wire, ...out, stored });
}

writeJson(join(outDir, 'golden.json'), { domain: 'antigravity-usage', recorder: 'benchmarks/rust-core/recorders/record-antigravity-usage.mjs', now: NOW, flows: results });
writeSetManifest(outDir, {
  set: 'antigravity-usage',
  recorder: 'benchmarks/rust-core/recorders/record-antigravity-usage.mjs',
  command: 'node benchmarks/rust-core/recorders/record-antigravity-usage.mjs --tree <tree>',
  identityTree: tree,
});
for (const r of results) console.log(r.name.padEnd(62), r.wire.length, r.error ? `ERR ${r.error.status ?? ''} ${r.error.message.slice(0, 70)}` : `${r.snapshot.quotaWindows.length} rows`);
