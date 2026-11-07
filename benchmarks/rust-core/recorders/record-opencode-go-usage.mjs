#!/usr/bin/env node
// Golden twin of `OpenCodeGoOAuthProvider.getUsageSnapshot()` (providers/opencode-go-oauth.mjs): the
// `/api/go/status` request (url, header order, redirect mode, timeout), the meters it reads
// (`snapshotFromStatus`), the refresh behind an expiring or a rejected token (`withConsoleTokenRetry`:
// one refresh per 401, a changed sign-in, a second 401) and every failure with its message and status.
// Node's real provider runs on a temp credentials file with a scripted `fetchImpl` and a frozen clock.
//
// Every user directory is a temp dir before any Mixdog module loads.
//   node benchmarks/rust-core/recorders/record-opencode-go-usage.mjs --tree <dir with node_modules> [--out <dir>]
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FIXTURES_ROOT, importFrom, parseArgs, resolveTree, writeJson, writeSetManifest } from './lib/common.mjs';

const cli = parseArgs();
const tree = resolveTree(cli);
const outDir = cli.get('out') ?? join(FIXTURES_ROOT, 'opencode-go-usage');
const base = mkdtempSync(join(tmpdir(), 'opencode-go-usage-'));
const userDirs = { HOME: 'home', USERPROFILE: 'home', APPDATA: 'appdata', LOCALAPPDATA: 'localappdata', MIXDOG_HOME: 'mixdog-home' };
for (const [name, dir] of Object.entries(userDirs)) {
  mkdirSync(join(base, dir), { recursive: true });
  process.env[name] = join(base, dir);
}
process.env.MIXDOG_SKIP_USER_DATA_BACKUP = '1';
process.env.MIXDOG_DATA_DIR = join(base, 'data');
mkdirSync(process.env.MIXDOG_DATA_DIR, { recursive: true });
delete process.env.MIXDOG_MODEL_PROXY;
delete process.env.NODE_TEST_CONTEXT;
const NOW = 1_800_000_000_000;
Date.now = () => NOW;

const mod = await importFrom(tree, 'src/runtime/agent/orchestrator/providers/opencode-go-oauth.mjs');

// The two ways a request gets its deadline: `AbortSignal.timeout` (console requests) and a timer
// (the status read). Both are noted, none fires.
let timeouts = [];
const realTimeout = AbortSignal.timeout.bind(AbortSignal);
AbortSignal.timeout = (ms) => {
  timeouts.push(ms);
  return realTimeout(2_147_000_000);
};
const realSetTimeout = globalThis.setTimeout;
globalThis.setTimeout = (fn, ms, ...rest) => {
  if (ms === 6500) timeouts.push(ms);
  return realSetTimeout(fn, ms, ...rest);
};

const STATUS = 'https://opencode.ai/console/api/go/status';
const REFRESH = 'https://opencode.ai/console/auth/device/token';
const FAR = NOW + 3_600_000;
const creds = (extra = {}) => ({ access_token: 'acc-1', refresh_token: 'ref-1', expires_at: FAR, account_id: 'acct-9', email: 'a@b.test', org_id: 'org-1', org_name: 'Org', ...extra });
const meter = (limit, used, resetsAt) => ({ limitMicroCents: limit, usedMicroCents: used, ...(resetsAt === undefined ? {} : { resetsAt }) });
const status = (meters) => ({ access: { meters } });
const grant = (extra = {}) => ({ access_token: 'acc-2', refresh_token: 'ref-2', expires_in: 3600, ...extra });
const ok = (body) => ({ url: STATUS, status: 200, body });
const get = (code, body = {}) => ({ url: STATUS, status: code, body });
const refresh = (code, body) => ({ url: REFRESH, status: code, body });

const flows = [
  { name: 'three meters', creds: creds(), replies: [ok(status({ fiveHour: meter('1200000000', '300000000', '2027-01-01T00:00:00Z'), week: meter('3000000000', '0', '2027-01-05T00:00:00Z'), month: meter('6000000000', '5999999999', '2027-02-01T00:00:00Z') }))] },
  { name: 'one meter, no reset yet', creds: creds(), replies: [ok(status({ fiveHour: meter('1200000000', '600000000', null) }))] },
  { name: 'a zero limit', creds: creds(), replies: [ok(status({ week: meter('0', '5') }))] },
  { name: 'numbers, empty text, null and text values', creds: creds(), replies: [ok(status({ fiveHour: meter(1200000000, 300000000), week: meter('', ''), month: meter(null, 5) }))] },
  { name: 'a missing and a non-numeric value drop the window', creds: creds(), replies: [ok(status({ fiveHour: { limitMicroCents: '1' }, week: meter('x', '1'), month: meter('100000000', '50000000') }))] },
  { name: 'fractional dollars round', creds: creds(), replies: [ok(status({ fiveHour: meter('123456789', '12345678'), week: meter('333333333', '111111111'), month: meter('100000000', '-100000000') }))] },
  { name: 'reset text', creds: creds(), replies: [ok(status({ fiveHour: meter('100000000', '1', '  2027-03-01T10:00:00Z  '), week: meter('100000000', '1', 'soon'), month: meter('100000000', '1', 12345) }))] },
  { name: 'unknown meters are ignored', creds: creds(), replies: [ok(status({ day: meter('1', '1'), fiveHour: meter('100000000', '50000000') }))] },
  { name: 'no meters', creds: creds(), replies: [ok({ access: {} })] },
  { name: 'meters are not an object', creds: creds(), replies: [ok({ access: { meters: 'x' } })] },
  { name: 'every meter unusable', creds: creds(), replies: [ok(status({ fiveHour: 5, week: null, month: {} }))] },
  { name: 'not JSON', creds: creds(), replies: [{ url: STATUS, status: 200, text: 'nope' }] },
  { name: 'an empty body', creds: creds(), replies: [{ url: STATUS, status: 200, text: '' }] },
  { name: 'null body', creds: creds(), replies: [{ url: STATUS, status: 200, text: 'null' }] },
  { name: 'server error', creds: creds(), replies: [get(500)] },
  { name: 'forbidden', creds: creds(), replies: [get(403)] },
  { name: 'transport failure', creds: creds(), replies: [{ url: STATUS, fail: true }] },
  { name: 'no email, no account', creds: creds({ email: undefined, account_id: undefined }), replies: [ok(status({ fiveHour: meter('100000000', '1') }))] },
  { name: 'padded identity', creds: creds({ email: ' a@b.test ', account_id: ' acct-9 ', org_id: ' org-1 ' }), replies: [ok(status({ fiveHour: meter('100000000', '1') }))] },
  { name: 'no organization', creds: creds({ org_id: undefined }), replies: [ok(status({ fiveHour: meter('100000000', '1') }))] },
  { name: '401 then refreshed', creds: creds(), replies: [get(401), refresh(200, grant()), ok(status({ fiveHour: meter('100000000', '1') }))] },
  { name: '401 twice', creds: creds(), replies: [get(401), refresh(200, grant()), get(401)] },
  { name: '401 then the refresh is rejected', creds: creds(), replies: [get(401), refresh(401, { error: 'invalid_grant' })] },
  { name: '401 then an invalid grant', creds: creds(), replies: [get(401), refresh(400, { error: 'invalid_grant' })] },
  { name: '401 then the refresh fails', creds: creds(), replies: [get(401), { url: REFRESH, status: 503, text: `unavailable acc-1 ref-1 ${'z'.repeat(300)}` }] },
  { name: '401 then the organization changes', creds: creds(), replies: [get(401), refresh(200, grant({ org_id: 'org-2' }))] },
  { name: '401 then a grant without a refresh token', creds: creds(), replies: [get(401), refresh(200, { access_token: 'x' })] },
  { name: 'an expiring token is refreshed first', creds: creds({ expires_at: NOW + 60_000 }), replies: [refresh(200, grant()), ok(status({ fiveHour: meter('100000000', '1') }))] },
  { name: 'an expired token and a rejected refresh', creds: creds({ expires_at: NOW - 1000 }), replies: [refresh(401, {})] },
  { name: 'a token without expiry is not refreshed', creds: creds({ expires_at: 0 }), replies: [ok(status({ fiveHour: meter('100000000', '1') }))] },
  { name: 'no credentials file', creds: null, replies: [] },
  { name: 'a blank refresh token', creds: creds({ refresh_token: '  ' }), replies: [] },
  { name: 'a file without an access token', creds: { refresh_token: 'r' }, replies: [] },
];

const plain = (v) => (v === undefined ? null : JSON.parse(JSON.stringify(v)));
const results = [];
let n = 0;
for (const flow of flows) {
  n += 1;
  const path = join(base, `creds-${n}.json`);
  process.env.OPENCODE_GO_OAUTH_CREDENTIALS_PATH = path;
  if (flow.creds) writeFileSync(path, JSON.stringify(flow.creds));
  const script = flow.replies.map((r) => ({ ...r }));
  const wire = [];
  timeouts = [];
  const fetchImpl = async (url, options = {}) => {
    wire.push({ url: String(url), method: options.method ?? 'GET', headers: Object.entries(options.headers ?? {}), body: options.body ?? null, redirect: options.redirect ?? null, timeoutMs: timeouts.shift() ?? null });
    const next = script.find((entry) => entry.url === String(url) && !entry.used);
    if (!next || next.fail) {
      if (next) next.used = true;
      throw new TypeError('fetch failed');
    }
    next.used = true;
    const text = next.text ?? JSON.stringify(next.body);
    return new Response(text, { status: next.status ?? 200 });
  };
  let out;
  try {
    const provider = new mod.OpenCodeGoOAuthProvider({ fetchImpl });
    out = { snapshot: plain(await provider.getUsageSnapshot()) };
  } catch (error) {
    out = { error: { message: String(error?.message ?? error), status: error?.status ?? null, reauthRequired: error?.reauthRequired === true, kind: error?.kind ?? null, code: error?.code ?? null } };
  }
  const stored = flow.creds ? JSON.parse(readFileSync(path, 'utf8')) : null;
  results.push({ name: flow.name, creds: flow.creds, replies: flow.replies, wire, ...out, stored });
}
globalThis.setTimeout = realSetTimeout;

writeJson(join(outDir, 'golden.json'), { domain: 'opencode-go-usage', recorder: 'benchmarks/rust-core/recorders/record-opencode-go-usage.mjs', now: NOW, flows: results });
writeSetManifest(outDir, {
  set: 'opencode-go-usage',
  recorder: 'benchmarks/rust-core/recorders/record-opencode-go-usage.mjs',
  command: 'node benchmarks/rust-core/recorders/record-opencode-go-usage.mjs --tree <tree>',
  identityTree: tree,
});
for (const r of results) console.log(r.name.padEnd(54), r.wire.length, r.error ? `ERR ${r.error.status ?? ''} ${r.error.message.slice(0, 80)}` : `${r.snapshot.quotaWindows.length}w`);
