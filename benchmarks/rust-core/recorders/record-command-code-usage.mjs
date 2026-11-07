#!/usr/bin/env node
// Golden twin of `CommandCodeOAuthProvider.getUsageSnapshot()` (providers/command-code-oauth.mjs):
// the credit request it puts on the wire (url, method, headers, redirect mode, timeout), what it
// reads out of the credits answer (`quotaWindowsFromCredits`), and every way the call fails (message
// and status). Node's real provider runs on a temp credentials file with a scripted `fetchImpl`
// and a frozen clock.
//
// Every user directory is a temp dir before any Mixdog module loads.
//   node benchmarks/rust-core/recorders/record-command-code-usage.mjs --tree <dir with node_modules> [--out <dir>]
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FIXTURES_ROOT, importFrom, parseArgs, resolveTree, writeJson, writeSetManifest } from './lib/common.mjs';

const cli = parseArgs();
const tree = resolveTree(cli);
const outDir = cli.get('out') ?? join(FIXTURES_ROOT, 'command-code-usage');
const base = mkdtempSync(join(tmpdir(), 'command-code-usage-'));
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

const mod = await importFrom(tree, 'src/runtime/agent/orchestrator/providers/command-code-oauth.mjs');

let timeouts = [];
const realTimeout = AbortSignal.timeout.bind(AbortSignal);
AbortSignal.timeout = (ms) => {
  timeouts.push(ms);
  return realTimeout(2_147_000_000);
};

const KEY = 'cc_key_ABCDEF0123456789';
const FAR = 1_900_000_000_000;
const window = (cap, used, resetAt) => ({ cap, used, ...(resetAt === undefined ? {} : { resetAt }) });
const credits = (fiveHour, weekly) => ({ windowLimits: { ...(fiveHour === undefined ? {} : { fiveHour }), ...(weekly === undefined ? {} : { weekly }) } });

const flows = [
  { name: 'both windows', creds: { apiKey: KEY, userId: 'user_1', userName: 'n' }, reply: { body: credits(window(100, 25, FAR), window(1000, 500, FAR + 1000)) } },
  { name: 'the answer wrapped in data', creds: { apiKey: KEY, userId: 'user_1' }, reply: { body: { data: credits(window(100, 10, FAR)) } } },
  { name: 'no user id', creds: { apiKey: KEY }, reply: { body: credits(window(100, 10)) } },
  { name: 'blank user id', creds: { apiKey: KEY, userId: '  ' }, reply: { body: credits(window(100, 10)) } },
  { name: 'only the weekly window', creds: { apiKey: KEY, userId: 'u' }, reply: { body: credits(undefined, window(8, 8, FAR)) } },
  { name: 'warning at 90 percent', creds: { apiKey: KEY, userId: 'u' }, reply: { body: credits(window(100, 90), window(100, 89.99)) } },
  { name: 'exhausted and over the cap', creds: { apiKey: KEY, userId: 'u' }, reply: { body: credits(window(100, 100), window(100, 250)) } },
  { name: 'fractional percent rounds to two places', creds: { apiKey: KEY, userId: 'u' }, reply: { body: credits(window(3, 1), window(7, 2)) } },
  { name: 'numeric strings count', creds: { apiKey: KEY, userId: 'u' }, reply: { body: credits(window('200', '50'), window(' 10 ', '1')) } },
  { name: 'a zero or negative cap, a negative use, no entry', creds: { apiKey: KEY, userId: 'u' }, reply: { body: credits(window(0, 0), window(100, -1)) } },
  { name: 'null, boolean and text values', creds: { apiKey: KEY, userId: 'u' }, reply: { body: credits(window(null, 5), window('x', 1)) } },
  { name: 'a boolean cap and a missing use', creds: { apiKey: KEY, userId: 'u' }, reply: { body: credits(window(true, 0), { cap: 10 }) } },
  { name: 'reset in seconds', creds: { apiKey: KEY, userId: 'u' }, reply: { body: credits(window(10, 1, 1_900_000_000), window(10, 1, 999_999_999_999)) } },
  { name: 'reset as ISO text and numeric text', creds: { apiKey: KEY, userId: 'u' }, reply: { body: credits(window(10, 1, '2030-01-01T00:00:00Z'), window(10, 1, '1900000000')) } },
  { name: 'reset zero, negative, garbage', creds: { apiKey: KEY, userId: 'u' }, reply: { body: credits(window(10, 1, 0), window(10, 1, 'soon')) } },
  { name: 'reset null', creds: { apiKey: KEY, userId: 'u' }, reply: { body: credits(window(10, 1, null), window(10, 1, -5)) } },
  { name: 'no window limits', creds: { apiKey: KEY, userId: 'u' }, reply: { body: { data: {} } } },
  { name: 'an empty object', creds: { apiKey: KEY, userId: 'u' }, reply: { body: {} } },
  { name: 'a null body', creds: { apiKey: KEY, userId: 'u' }, reply: { text: 'null' } },
  { name: 'an array body', creds: { apiKey: KEY, userId: 'u' }, reply: { text: '[]' } },
  { name: 'invalid JSON', creds: { apiKey: KEY, userId: 'u' }, reply: { text: 'not json' } },
  { name: 'rejected key', creds: { apiKey: KEY, userId: 'u' }, reply: { status: 401, text: `denied ${KEY}` } },
  { name: 'rejected key without detail', creds: { apiKey: KEY, userId: 'u' }, reply: { status: 401, text: '' } },
  { name: 'server error with a detail', creds: { apiKey: KEY, userId: 'u' }, reply: { status: 500, text: `  boom ${KEY} ${'x'.repeat(400)}  ` } },
  { name: 'server error without a body', creds: { apiKey: KEY, userId: 'u' }, reply: { status: 503, text: '' } },
  { name: 'forbidden', creds: { apiKey: KEY, userId: 'u' }, reply: { status: 403, text: '{"error":"no"}' } },
  { name: 'transport failure', creds: { apiKey: KEY, userId: 'u' }, reply: { fail: true } },
  { name: 'no credentials file', creds: null, reply: { body: credits(window(10, 1)) } },
  { name: 'a file without a key', creds: { userId: 'u' }, reply: { body: credits(window(10, 1)) } },
  { name: 'a blank key', creds: { apiKey: '   ', userId: 'u' }, reply: { body: credits(window(10, 1)) } },
  { name: 'a padded key is trimmed', creds: { apiKey: `  ${KEY}  `, userId: ' u2 ' }, reply: { body: credits(window(10, 1)) } },
];

const plain = (v) => (v === undefined ? null : JSON.parse(JSON.stringify(v)));
const results = [];
let n = 0;
for (const flow of flows) {
  n += 1;
  const path = join(base, `creds-${n}.json`);
  process.env.COMMAND_CODE_OAUTH_CREDENTIALS_PATH = path;
  if (flow.creds) writeFileSync(path, JSON.stringify(flow.creds));
  const wire = [];
  timeouts = [];
  const fetchImpl = async (url, options = {}) => {
    wire.push({ url: String(url), method: options.method ?? 'GET', headers: Object.entries(options.headers ?? {}), redirect: options.redirect ?? null, timeoutMs: timeouts.shift() ?? null });
    if (flow.reply.fail) throw new TypeError('fetch failed');
    const text = flow.reply.text ?? JSON.stringify(flow.reply.body);
    return new Response(text, { status: flow.reply.status ?? 200 });
  };
  let out;
  try {
    const provider = new mod.CommandCodeOAuthProvider({ preconnect: false, fetchImpl });
    out = { snapshot: plain(await provider.getUsageSnapshot()) };
  } catch (error) {
    out = { error: { message: String(error?.message ?? error), status: error?.status ?? null, reauthRequired: error?.reauthRequired === true } };
  }
  results.push({ name: flow.name, creds: flow.creds, reply: { status: flow.reply.status ?? 200, ...(flow.reply.fail ? { fail: true } : { text: flow.reply.text ?? JSON.stringify(flow.reply.body) }) }, wire, ...out });
}

writeJson(join(outDir, 'golden.json'), { domain: 'command-code-usage', recorder: 'benchmarks/rust-core/recorders/record-command-code-usage.mjs', now: NOW, flows: results });
writeSetManifest(outDir, {
  set: 'command-code-usage',
  recorder: 'benchmarks/rust-core/recorders/record-command-code-usage.mjs',
  command: 'node benchmarks/rust-core/recorders/record-command-code-usage.mjs --tree <tree>',
  identityTree: tree,
});
for (const r of results) console.log(r.name.padEnd(48), r.wire.length, r.error ? `ERR ${r.error.status ?? ''} ${r.error.message.slice(0, 70)}` : r.snapshot ? `${r.snapshot.quotaWindows.length}w ${r.snapshot.accountId ?? '-'}` : 'null');
