#!/usr/bin/env node
// Golden twin of `CursorOAuthProvider.getUsageSnapshot()` (providers/cursor.mjs, cursor-wire-models.mjs):
// the two unary Connect calls it makes (`GetCurrentPeriodUsage`, `GetPlanInfo`: path, header names and
// values, empty body), the protobuf answers it decodes with Node's own schema codec, and
// `normalizeCursorUsage` (the Basic / API progress lanes, the included-balance window, the usage-based
// spend window, the plan block). Node's real provider runs against a local cleartext HTTP/2 server
// (`CURSOR_API_URL`) that answers each path as the case scripts; answers are built with Node's own
// `encodeMessage` or given as raw bytes (malformed ones). The access token is injected (`config.accessToken`).
//
// Every user directory is a temp dir before any Mixdog module loads.
//   node benchmarks/rust-core/recorders/record-cursor-usage.mjs --tree <dir with node_modules> [--out <dir>]
import http2 from 'node:http2';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FIXTURES_ROOT, importFrom, parseArgs, resolveTree, writeJson, writeSetManifest } from './lib/common.mjs';

const cli = parseArgs();
const tree = resolveTree(cli);
const outDir = cli.get('out') ?? join(FIXTURES_ROOT, 'cursor-usage');
const base = mkdtempSync(join(tmpdir(), 'cursor-usage-'));
const userDirs = { HOME: 'home', USERPROFILE: 'home', APPDATA: 'appdata', LOCALAPPDATA: 'localappdata', MIXDOG_HOME: 'mixdog-home' };
for (const [name, dir] of Object.entries(userDirs)) {
  mkdirSync(join(base, dir), { recursive: true });
  process.env[name] = join(base, dir);
}
process.env.MIXDOG_SKIP_USER_DATA_BACKUP = '1';
process.env.MIXDOG_DATA_DIR = join(base, 'data');
mkdirSync(process.env.MIXDOG_DATA_DIR, { recursive: true });
process.env.MIXDOG_CURSOR_CLIENT_VERSION = 'cli-9999.01.01-abcdef0';
delete process.env.MIXDOG_MODEL_PROXY;
delete process.env.NODE_TEST_CONTEXT;
delete process.env.HTTPS_PROXY;
delete process.env.HTTP_PROXY;
delete process.env.https_proxy;
delete process.env.http_proxy;

const USAGE = '/aiserver.v1.DashboardService/GetCurrentPeriodUsage';
const PLAN = '/aiserver.v1.DashboardService/GetPlanInfo';
let script = { usage: null, plan: null };
let seen = [];

const server = http2.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const path = req.headers[':path'];
    const answer = path === USAGE ? script.usage : path === PLAN ? script.plan : null;
    const headers = Object.entries(req.headers).filter(([k]) => !k.startsWith(':')).map(([k, v]) => [k, k === 'x-request-id' ? (/^[0-9a-f-]{36}$/.test(String(v)) ? '<uuid>' : String(v)) : String(v)]);
    seen.push({ path, method: req.headers[':method'], headers, bodyBytes: Buffer.concat(chunks).length });
    if (!answer || answer.reset) {
      res.stream.close(http2.constants.NGHTTP2_INTERNAL_ERROR);
      return;
    }
    res.writeHead(answer.status ?? 200, { 'content-type': 'application/proto', ...(answer.headers ?? {}) });
    res.end(Buffer.from(answer.hex ?? '', 'hex'));
  });
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
process.env.CURSOR_API_URL = `http://127.0.0.1:${server.address().port}`;

const protobuf = await importFrom(tree, 'src/runtime/agent/orchestrator/providers/cursor-wire-protobuf.mjs');
const cursor = await importFrom(tree, 'src/runtime/agent/orchestrator/providers/cursor.mjs');
const hex = (bytes) => Buffer.from(bytes).toString('hex');
const enc = (type, value) => hex(protobuf.encodeMessage(type, value));
const frame = (payloadHex, flags = 0) => {
  const payload = Buffer.from(payloadHex, 'hex');
  const head = Buffer.alloc(5);
  head[0] = flags;
  head.writeUInt32BE(payload.length, 1);
  return Buffer.concat([head, payload]).toString('hex');
};
const usage = (value) => ({ hex: enc('CursorCurrentPeriodUsage', value) });
const plan = (info) => ({ hex: enc('CursorPlanInfoResponse', info === null ? {} : { planInfo: info }) });
const raw = (h, extra = {}) => ({ hex: h, ...extra });
const FULL = { billingCycleStart: 1_790_000_000_000, billingCycleEnd: 1_800_000_000_000, planUsage: { totalSpend: 1234, includedSpend: 1000, bonusSpend: 234, remaining: 8766, limit: 10000, autoSpend: 100, apiSpend: 1134, autoPercentUsed: 12.5, apiPercentUsed: 40.25, totalPercentUsed: 30 }, spendLimitUsage: { totalSpend: 500, pooledLimit: 5000, pooledUsed: 500, pooledRemaining: 4500, limitType: 'pooled' }, displayThreshold: 90, enabled: true, displayMessage: 'On track' };

const flows = [
  { name: 'every section', usage: usage(FULL), plan: plan({ planName: 'Pro', includedAmountCents: 10000, price: '$20/mo', billingCycleEnd: 1_801_000_000_000, planOwner: 1 }) },
  { name: 'only the Basic lane', usage: usage({ planUsage: { autoPercentUsed: 50 } }), plan: plan(null) },
  { name: 'only the API lane', usage: usage({ planUsage: { apiPercentUsed: 25.123456 } }), plan: plan(null) },
  { name: 'lane percentages are clamped and rounded', usage: usage({ planUsage: { autoPercentUsed: 150, apiPercentUsed: -5 } }), plan: plan(null) },
  { name: 'a lane at the rounding edge', usage: usage({ planUsage: { autoPercentUsed: 33.33335, apiPercentUsed: 0.00005 } }), plan: plan(null) },
  { name: 'a non-finite lane is dropped', usage: usage({ planUsage: { autoPercentUsed: Number.POSITIVE_INFINITY, apiPercentUsed: 10 } }), plan: plan(null) },
  { name: 'the included balance without lanes', usage: usage({ billingCycleEnd: 1_800_000_000_000, planUsage: { totalSpend: 2500, limit: 5000, remaining: 2500 } }), plan: plan({ planName: 'Pro+' }) },
  { name: 'the included balance without a plan name', usage: usage({ planUsage: { totalSpend: 100, limit: 2000 } }), plan: plan(null) },
  { name: 'remaining absent is derived from the limit', usage: usage({ planUsage: { totalSpend: 300, limit: 1000 } }), plan: plan(null) },
  { name: 'remaining present and zero stays zero', usage: usage({ planUsage: { totalSpend: 300, limit: 1000, remaining: 0 } }), plan: plan(null) },
  { name: 'the limit from the plan', usage: usage({ planUsage: { totalSpend: 300 } }), plan: plan({ planName: 'Team', includedAmountCents: 4000 }) },
  { name: 'overspent clamps the derived remainder', usage: usage({ planUsage: { totalSpend: 1500, limit: 1000 } }), plan: plan(null) },
  { name: 'fractional cents round half up', usage: usage({ planUsage: { totalSpend: 1005, limit: 2015, remaining: 1010 } }), plan: plan(null) },
  { name: 'negative amounts', usage: usage({ planUsage: { totalSpend: -5, limit: 100, remaining: -250 } }), plan: plan(null) },
  { name: 'amounts past 2^53', usage: usage({ planUsage: { totalSpend: 9_007_199_254_740_993, limit: 9_007_199_254_740_993 } }), plan: plan(null) },
  { name: 'nothing included', usage: usage({ enabled: true }), plan: plan(null) },
  { name: 'spend limit overall wins', usage: usage({ spendLimitUsage: { overallLimit: 9000, overallUsed: 100, overallRemaining: 8900, individualLimit: 1, individualUsed: 2, individualRemaining: 3, pooledLimit: 4, pooledUsed: 5, pooledRemaining: 6, totalSpend: 7 } }), plan: plan(null) },
  { name: 'spend limit individual then pooled', usage: usage({ spendLimitUsage: { individualLimit: 2000, individualUsed: 0, pooledUsed: 50, pooledRemaining: 1950 } }), plan: plan(null) },
  { name: 'spend limit with only the total', usage: usage({ spendLimitUsage: { totalSpend: 321 } }), plan: plan(null) },
  { name: 'spend limit remaining only', usage: usage({ spendLimitUsage: { pooledRemaining: 700 } }), plan: plan(null) },
  { name: 'spend limit all zero is no window', usage: usage({ spendLimitUsage: { overallLimit: 0, overallUsed: 0, overallRemaining: 0 } }), plan: plan(null) },
  { name: 'spend limit negative values are no window', usage: usage({ spendLimitUsage: { overallLimit: -1, overallUsed: -2, overallRemaining: -3 } }), plan: plan(null) },
  { name: 'the reset from the plan', usage: usage({ planUsage: { autoPercentUsed: 5 } }), plan: plan({ billingCycleEnd: 1_801_000_000_000 }) },
  { name: 'the usage reset wins over the plan', usage: usage({ billingCycleEnd: 1_800_000_000_000, planUsage: { autoPercentUsed: 5 } }), plan: plan({ billingCycleEnd: 1_801_000_000_000 }) },
  { name: 'the plan block alone', usage: usage({}), plan: plan({ planName: 'Hobby', price: 'free', includedAmountCents: 0 }) },
  { name: 'the plan call fails, the usage stands', usage: usage(FULL), plan: { status: 500 } },
  { name: 'the plan call is refused', usage: usage(FULL), plan: { status: 403 } },
  { name: 'the plan answer is garbage', usage: usage(FULL), plan: raw('ffff') },
  { name: 'the plan answer is empty', usage: usage(FULL), plan: raw('') },
  { name: 'disabled with a message', usage: usage({ enabled: false, displayMessage: 'Paused' }), plan: plan(null) },
  { name: 'no flags', usage: raw(''), plan: raw('') },
  { name: 'unknown fields are skipped', usage: raw(enc('CursorCurrentPeriodUsage', { enabled: true }) + '9a0603616263' + 'a806ffffff0f' + '7d01020304' + '710102030405060708'), plan: plan(null) },
  { name: 'an unsupported wire type', usage: raw('0b'), plan: plan(null) },
  { name: 'a truncated varint', usage: raw('08ff'), plan: plan(null) },
  { name: 'a truncated field', usage: raw('1a05010203'), plan: plan(null) },
  { name: 'a varint that never ends', usage: raw('08' + 'ff'.repeat(12)), plan: plan(null) },
  { name: 'a double on the wrong wire type', usage: raw('6000' + enc('CursorPlanUsage', {}).slice(0, 0) + '1a0262' + '00'), plan: plan(null) },
  { name: 'a nested message on a varint', usage: raw('1801'), plan: plan(null) },
  { name: 'a string over a truncated length', usage: raw('3a0a41'), plan: plan(null) },
  { name: 'field zero', usage: raw('0001'), plan: plan(null) },
  { name: 'the answer in one envelope', usage: raw(frame(enc('CursorCurrentPeriodUsage', FULL))), plan: raw(frame(enc('CursorPlanInfoResponse', { planInfo: { planName: 'Pro' } }))) },
  { name: 'an end-stream envelope is not unwrapped', usage: raw(frame(enc('CursorCurrentPeriodUsage', FULL), 2)), plan: plan(null) },
  { name: 'a compressed envelope is not unwrapped', usage: raw(frame(enc('CursorCurrentPeriodUsage', FULL), 1)), plan: plan(null) },
  { name: 'an envelope shorter than it says', usage: raw('00000000ff0102'), plan: plan(null) },
  { name: 'rejected token', usage: raw('', { status: 401 }), plan: plan(null) },
  { name: 'forbidden', usage: raw('', { status: 403 }), plan: plan(null) },
  { name: 'throttled with a retry-after', usage: raw('', { status: 429, headers: { 'retry-after': '7' } }), plan: plan(null) },
  { name: 'not found', usage: raw('', { status: 404 }), plan: plan(null) },
  { name: 'server error', usage: raw('', { status: 500 }), plan: plan(null) },
  { name: 'bad gateway', usage: raw('', { status: 502 }), plan: plan(null) },
  { name: 'an unmapped status', usage: raw('', { status: 418 }), plan: plan(null) },
  { name: 'a redirect is not followed', usage: raw('', { status: 302, headers: { location: 'http://127.0.0.1:1/' } }), plan: plan(null) },
];

const plain = (v) => (v === undefined ? null : JSON.parse(JSON.stringify(v)));
const results = [];
for (const flow of flows) {
  script = { usage: flow.usage, plan: flow.plan };
  seen = [];
  let out;
  try {
    const provider = new cursor.CursorOAuthProvider({ accessToken: 'cursor-token-1' });
    out = { snapshot: plain(await provider.getUsageSnapshot()) };
  } catch (error) {
    out = { error: { message: String(error?.message ?? error), status: error?.status ?? null, code: error?.code ?? null } };
  }
  // The two calls run together: their order on the wire is not a fact to keep.
  seen.sort((a, b) => a.path.localeCompare(b.path));
  results.push({ name: flow.name, usage: flow.usage, plan: flow.plan, seen, ...out });
}
server.close();

writeJson(join(outDir, 'golden.json'), { domain: 'cursor-usage', recorder: 'benchmarks/rust-core/recorders/record-cursor-usage.mjs', clientVersion: 'cli-9999.01.01-abcdef0', flows: results });
writeSetManifest(outDir, {
  set: 'cursor-usage',
  recorder: 'benchmarks/rust-core/recorders/record-cursor-usage.mjs',
  command: 'node benchmarks/rust-core/recorders/record-cursor-usage.mjs --tree <tree>',
  identityTree: tree,
});
for (const r of results) console.log(r.name.padEnd(54), r.seen.length, r.error ? `ERR ${r.error.status ?? ''} ${r.error.message.slice(0, 70)}` : `${r.snapshot.quotaWindows.length}w ${r.snapshot.balance ? 'bal' : ''}`);
process.exit(0);
