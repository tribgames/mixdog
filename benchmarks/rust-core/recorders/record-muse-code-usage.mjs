#!/usr/bin/env node
// Golden twin of `MuseCodeOAuthProvider.getUsageSnapshot()` (providers/muse-code-oauth.mjs): the key
// request (`requestMuseCodeKey`: url, header order, body, redirect mode, timeout), the quota windows
// read from `subs_usage` (`quotaWindowsFromSubsUsage`), the key payload validation, the 5-minute
// failure cooldown and the last good snapshot it keeps, all bound to the signed-in credential. Node's
// real provider runs on a temp credentials file with a scripted `fetch`, a stepped clock and a fixed
// `Math.random` (so the jittered cooldown is exactly 5 minutes).
//
// Every user directory is a temp dir before any Mixdog module loads.
//   node benchmarks/rust-core/recorders/record-muse-code-usage.mjs --tree <dir with node_modules> [--out <dir>]
import { existsSync, mkdirSync, mkdtempSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FIXTURES_ROOT, importFrom, parseArgs, resolveTree, writeJson, writeSetManifest } from './lib/common.mjs';

const cli = parseArgs();
const tree = resolveTree(cli);
const outDir = cli.get('out') ?? join(FIXTURES_ROOT, 'muse-code-usage');
const base = mkdtempSync(join(tmpdir(), 'muse-code-usage-'));
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
let NOW = 1_800_000_000_000;
Date.now = () => NOW;
Math.random = () => 0.5;

const mod = await importFrom(tree, 'src/runtime/agent/orchestrator/providers/muse-code-oauth.mjs');

let timeouts = [];
const realTimeout = AbortSignal.timeout.bind(AbortSignal);
AbortSignal.timeout = (ms) => {
  timeouts.push(ms);
  return realTimeout(2_147_000_000);
};
let script = [];
let wire = [];
globalThis.fetch = async (url, options = {}) => {
  wire.push({ url: String(url), method: options.method ?? 'GET', headers: Object.entries(options.headers ?? {}), body: options.body ?? null, redirect: options.redirect ?? null, timeoutMs: timeouts.shift() ?? null });
  const next = script.shift();
  if (!next || next.fail) throw new TypeError('fetch failed');
  return new Response(next.text ?? JSON.stringify(next.body), { status: next.status ?? 200 });
};

const CREDS = { accessToken: 'meta-token-1', apiKey: 'muse-key-1', accountId: 'acct-1', email: 'stored@b.test' };
const win = (usedPercent, mins, resets) => ({ used_percent: usedPercent, ...(mins === undefined ? {} : { window_duration_mins: mins }), ...(resets === undefined ? {} : { resets_at: resets }) });
const payload = (extra = {}) => ({ api_key: 'muse-key-1', is_subs_active: true, user_id: ' u-9 ', user_email: ' Who@Example.TEST ', subs_tier_name: ' Pro ', subs_usage: { window: win(12.345, 300, '2027-01-01T00:00:00Z'), weekly: win(50, undefined, 1_900_000_000) }, ...extra });
const ok = (body) => ({ status: 200, body });
const snap = () => ({ op: 'snapshot' });
const step = (ms) => ({ op: 'advance', ms });
const login = (creds) => ({ op: 'login', creds });
const logout = () => ({ op: 'logout' });

const flows = [
  { name: 'both windows', replies: [ok(payload())], ops: [snap()] },
  { name: 'extra fields stay in raw, the key does not', replies: [ok(payload({ plan: 'x', subs_tier_id: 'T', zeta: 1, alpha: { a: 1 } }))], ops: [snap()] },
  { name: 'tier from the id', replies: [ok(payload({ subs_tier_name: null, subs_tier_id: ' tier-7 ' }))], ops: [snap()] },
  { name: 'no tier', replies: [ok(payload({ subs_tier_name: '  ', subs_tier_id: null }))], ops: [snap()] },
  { name: 'identity falls back to the stored account', replies: [ok(payload({ user_id: '  ', user_email: '' }))], ops: [snap()] },
  { name: 'identity falls back to the email', replies: [ok(payload({ user_id: '', user_email: ' A@B.C ' }))], ops: [snap()], creds: { ...CREDS, accountId: '', email: '' } },
  { name: 'no identity at all', replies: [ok(payload({ user_id: '', user_email: '' }))], ops: [snap()], creds: { ...CREDS, accountId: '', email: '' } },
  { name: 'stored email when the payload names none', replies: [ok(payload({ user_email: undefined }))], ops: [snap()] },
  { name: 'rolling window default', replies: [ok(payload({ subs_usage: { window: win(10) } }))], ops: [snap()] },
  { name: 'rolling window 90 minutes', replies: [ok(payload({ subs_usage: { window: win(10, 90) } }))], ops: [snap()] },
  { name: 'rolling window 60 minutes', replies: [ok(payload({ subs_usage: { window: win(10, 60) } }))], ops: [snap()] },
  { name: 'rolling window 1 minute', replies: [ok(payload({ subs_usage: { window: win(10, 1) } }))], ops: [snap()] },
  { name: 'rolling window 59.6 minutes', replies: [ok(payload({ subs_usage: { window: win(10, 59.6) } }))], ops: [snap()] },
  { name: 'rolling window 0 and negative minutes', replies: [ok(payload({ subs_usage: { window: win(10, 0) } })), ok(payload({ subs_usage: { window: win(10, -5) } }))], ops: [snap(), step(400_000), snap()] },
  { name: 'usage is clamped and warns', replies: [ok(payload({ subs_usage: { window: win(250, 300), weekly: win(90) } }))], ops: [snap()] },
  { name: 'exhausted weekly', replies: [ok(payload({ subs_usage: { weekly: win(100) } }))], ops: [snap()] },
  { name: 'a negative use drops the window', replies: [ok(payload({ subs_usage: { window: win(-1, 300), weekly: win(5) } }))], ops: [snap()] },
  { name: 'reset forms', replies: [ok(payload({ subs_usage: { window: win(1, 60, 'garbage'), weekly: win(1, undefined, 999_999_999_999) } })), ok(payload({ subs_usage: { window: win(1, 60, 0), weekly: win(1, undefined, '2027-03-01T10:00:00Z') } }))], ops: [snap(), step(400_000), snap()] },
  { name: 'no usage windows', replies: [ok(payload({ subs_usage: {} }))], ops: [snap()] },
  { name: 'no usage at all', replies: [ok(payload({ subs_usage: undefined }))], ops: [snap()] },
  { name: 'null usage', replies: [ok(payload({ subs_usage: null }))], ops: [snap()] },
  { name: 'a string percent invalidates the payload', replies: [ok(payload({ subs_usage: { window: { used_percent: '5' } } }))], ops: [snap()] },
  { name: 'a null reset invalidates the payload', replies: [ok(payload({ subs_usage: { window: { used_percent: 5, resets_at: null } } }))], ops: [snap()] },
  { name: 'an array usage invalidates the payload', replies: [ok(payload({ subs_usage: [] }))], ops: [snap()] },
  { name: 'a numeric api_key invalidates the payload', replies: [ok(payload({ api_key: 5 }))], ops: [snap()] },
  { name: 'a null api_key invalidates the payload', replies: [ok(payload({ api_key: null }))], ops: [snap()] },
  { name: 'a non-boolean flag invalidates the payload', replies: [ok(payload({ is_subs_active: 'yes' }))], ops: [snap()] },
  { name: 'a text action_url is fine', replies: [ok(payload({ action_url: 'https://x.test', require_payment: false, require_payment_action_url: 'u' }))], ops: [snap()] },
  { name: 'a numeric action_url invalidates the payload', replies: [ok(payload({ action_url: 5 }))], ops: [snap()] },
  { name: 'an array body', replies: [ok([])], ops: [snap()] },
  { name: 'not JSON', replies: [{ status: 200, text: 'nope' }], ops: [snap()] },
  { name: 'inactive subscription, then the cooldown', replies: [ok(payload({ is_subs_active: false })), ok(payload())], ops: [snap(), step(299_999), snap(), step(2), snap()] },
  { name: 'rejected session 401', replies: [{ status: 401, text: 'no' }], ops: [snap(), snap()] },
  { name: 'rejected session 403', replies: [{ status: 403, text: 'no' }], ops: [snap()] },
  { name: 'server error, then the cooldown', replies: [{ status: 500, text: 'boom' }, ok(payload())], ops: [snap(), snap(), step(300_001), snap()] },
  { name: 'transport failure', replies: [{ fail: true }], ops: [snap()] },
  { name: 'the last good snapshot survives a failure', replies: [ok(payload()), { status: 500, text: 'x' }], ops: [snap(), step(1000), snap(), snap(), step(300_000), snap()] },
  { name: 'a rejection clears the last good snapshot', replies: [ok(payload()), { status: 401, text: 'x' }, { status: 500, text: 'x' }], ops: [snap(), step(1), snap(), step(300_001), snap()] },
  { name: 'a success clears the failure', replies: [{ status: 500, text: 'x' }, ok(payload()), ok(payload({ subs_usage: { weekly: win(7) } }))], ops: [snap(), step(300_001), snap(), snap()] },
  { name: 'a changed sign-in drops the cooldown', replies: [{ status: 500, text: 'x' }, ok(payload())], ops: [snap(), login({ ...CREDS, accessToken: 'meta-token-2' }), snap()] },
  { name: 'a changed sign-in drops the last good snapshot', replies: [ok(payload()), { status: 500, text: 'x' }], ops: [snap(), login({ ...CREDS, accessToken: 'meta-token-2' }), snap()] },
  { name: 'a changed account id drops the state', replies: [{ status: 500, text: 'x' }, ok(payload())], ops: [snap(), login({ ...CREDS, accountId: 'acct-2' }), snap()] },
  { name: 'the same sign-in rewritten keeps the state', replies: [ok(payload()), { status: 500, text: 'x' }], ops: [snap(), login({ ...CREDS }), step(1), snap()] },
  { name: 'a sign-out nobody read keeps the state', replies: [ok(payload()), { status: 500, text: 'x' }], ops: [snap(), logout(), login({ ...CREDS }), snap()] },
  { name: 'a sign-out that was read drops the state', replies: [ok(payload()), { status: 500, text: 'x' }], ops: [snap(), logout(), snap(), login({ ...CREDS }), snap()] },
  { name: 'no credentials file', replies: [], ops: [logout(), snap()], creds: null },
  { name: 'a file without a key', replies: [], ops: [snap()], creds: { accessToken: 'a' } },
  { name: 'a blank access token', replies: [], ops: [snap()], creds: { ...CREDS, accessToken: '  ' } },
  { name: 'padded credentials are sent as stored', replies: [ok(payload())], ops: [snap()], creds: { ...CREDS, accessToken: ' tok ' } },
];

const plain = (v) => (v === undefined ? null : JSON.parse(JSON.stringify(v)));
const results = [];
let n = 0;
for (const flow of flows) {
  n += 1;
  NOW = 1_800_000_000_000;
  const path = join(base, `creds-${n}.json`);
  process.env.MUSE_CODE_OAUTH_CREDENTIALS_PATH = path;
  const creds = flow.creds === undefined ? CREDS : flow.creds;
  if (creds) writeFileSync(path, JSON.stringify(creds));
  script = flow.replies.map((r) => ({ ...r }));
  wire = [];
  timeouts = [];
  const provider = new mod.MuseCodeOAuthProvider({});
  const ops = [];
  for (const op of flow.ops) {
    if (op.op === 'advance') {
      NOW += op.ms;
      ops.push({ ...op });
    } else if (op.op === 'login') {
      writeFileSync(path, JSON.stringify(op.creds));
      // The file's modified time is what the provider re-reads on.
      const later = new Date(Date.now() + 5000 * ops.length + 5000);
      (await import('node:fs')).utimesSync(path, later, later);
      ops.push({ ...op });
    } else if (op.op === 'logout') {
      if (existsSync(path)) unlinkSync(path);
      ops.push({ ...op });
    } else {
      wire = [];
      let out;
      try {
        out = { value: plain(await provider.getUsageSnapshot()) };
      } catch (error) {
        out = { error: { message: String(error?.message ?? error), status: error?.status ?? null, reauthRequired: error?.reauthRequired === true } };
      }
      ops.push({ ...op, now: NOW, wire, ...out });
    }
  }
  results.push({ name: flow.name, creds, replies: flow.replies, ops });
}

writeJson(join(outDir, 'golden.json'), { domain: 'muse-code-usage', recorder: 'benchmarks/rust-core/recorders/record-muse-code-usage.mjs', now: 1_800_000_000_000, flows: results });
writeSetManifest(outDir, {
  set: 'muse-code-usage',
  recorder: 'benchmarks/rust-core/recorders/record-muse-code-usage.mjs',
  command: 'node benchmarks/rust-core/recorders/record-muse-code-usage.mjs --tree <tree>',
  identityTree: tree,
});
for (const r of results) console.log(r.name.padEnd(56), r.ops.filter((o) => o.op === 'snapshot').map((o) => (o.error ? `ERR${o.error.status ?? ''}` : o.value ? `${o.value.quotaWindows.length}w/${o.wire.length}r` : `null/${o.wire.length}r`)).join(' '));
