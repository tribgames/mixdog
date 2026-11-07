#!/usr/bin/env node
// Golden twin of `providerQuotaUsable(provider, model)` (providers/quota-reading.mjs): the
// answer a quota resume asks before it fires. Node's real function runs over a throwaway data dir
// with a seeded account roster and an injected provider whose usage snapshot per account is
// scripted (the forced reading `fetchOAuthUsageSnapshot` takes; it records what it measured into
// the roster itself). A case holds the roster before the readings, the readings asked for in
// order (account and what the script answered), the roster after them, the clock at the answer
// and the answer. Proxy mode (MIXDOG_MODEL_PROXY=client) runs over the real `ModelProxyChannel`:
// disconnected PC, absent client, PC answers, PC error, unclaimed and lapsed calls.
//
// Every user directory is a temp dir before any Mixdog module loads.
//   node benchmarks/rust-core/recorders/record-quota-usable.mjs --tree <dir with node_modules> [--out <dir>]
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FIXTURES_ROOT, importFrom, parseArgs, resolveTree, writeJson, writeSetManifest } from './lib/common.mjs';

const cli = parseArgs();
const tree = resolveTree(cli);
const outDir = cli.get('out') ?? join(FIXTURES_ROOT, 'quota-usable');
const base = mkdtempSync(join(tmpdir(), 'quota-usable-'));
const userDirs = { HOME: 'home', USERPROFILE: 'home', APPDATA: 'appdata', LOCALAPPDATA: 'localappdata', MIXDOG_HOME: 'mixdog-home' };
for (const [name, dir] of Object.entries(userDirs)) {
  mkdirSync(join(base, dir), { recursive: true });
  process.env[name] = join(base, dir);
}
process.env.MIXDOG_SKIP_USER_DATA_BACKUP = '1';
delete process.env.MIXDOG_MODEL_PROXY;
delete process.env.NODE_TEST_CONTEXT;

const reading = await importFrom(tree, 'src/runtime/agent/orchestrator/providers/quota-reading.mjs');
const accounts = await importFrom(tree, 'src/runtime/shared/provider-accounts.mjs');
const channelModule = await importFrom(tree, 'src/runtime/agent/orchestrator/providers/model-proxy-channel.mjs');

const plain = (v) => (v === undefined ? null : JSON.parse(JSON.stringify(v)));
const ID = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const FAR = 9_000_000_000_000;

let n = 0;
async function seed(provider, roster) {
  n += 1;
  const dataDir = join(base, `data-${n}`);
  mkdirSync(dataDir, { recursive: true });
  process.env.MIXDOG_DATA_DIR = dataDir;
  if (roster.accounts === 0) return;
  for (let i = 1; i <= roster.accounts; i += 1) await accounts.registerProviderAccount(provider, ID(i), { label: `Account ${i}` });
  if (roster.change) await accounts.changeProviderAccounts(provider, roster.change);
  for (const block of roster.blocks ?? []) await accounts.blockProviderAccount(provider, ID(block.account), FAR, block.model ?? '');
}

const window = (usedPct, extra = {}) => ({ label: '5h', usedPct, resetAt: FAR, ...extra });
const scripts = {
  ok: () => ({ default: { quotaWindows: [window(10)] }, 1: { quotaWindows: [window(10)] }, 2: { quotaWindows: [window(10)] }, 3: { quotaWindows: [window(10)] } }),
  spent: () => ({ default: { quotaWindows: [window(100)] }, 1: { quotaWindows: [window(100)] }, 2: { quotaWindows: [window(100)] }, 3: { quotaWindows: [window(100)] } }),
  mixed: () => ({ default: { quotaWindows: [window(10)] }, 1: { quotaWindows: [window(100)] }, 2: { quotaWindows: [window(10)] }, 3: null }),
  none: () => ({ default: null, 1: null, 2: null, 3: null }),
  throws: () => ({ default: 'throw', 1: { quotaWindows: [window(10)] }, 2: 'throw', 3: { quotaWindows: [window(100)] } }),
  balance: () => ({ default: { balance: { unlimited: true } }, 1: { balance: { remainingCredits: 5 } }, 2: { balance: { remainingUsd: 0 } }, 3: { balance: { remainingCredits: 3 }, quotaWindows: [window(100)] } }),
  scoped: () => {
    const rows = { quotaWindows: [window(100, { models: ['claude'] }), window(5, { models: ['gemini'] })] };
    return { default: rows, 1: rows, 2: { quotaWindows: [window(100, { except: ['gemini'] }), window(5, { models: ['claude'] })] }, 3: rows };
  },
  unmeasured: () => ({ default: { quotaWindows: [window(null)] }, 1: { quotaWindows: [window(null)] }, 2: { quotaWindows: [window(10), window(null)] }, 3: { quotaWindows: [window(10)] } }),
};
const rosters = {
  none: { accounts: 0 },
  one: { accounts: 1 },
  three: { accounts: 3, change: { selectedId: ID(2), policy: 'limit' } },
  manual: { accounts: 3, change: { selectedId: ID(2), auto: false } },
  headroom: { accounts: 3, change: { selectedId: ID(3), policy: 'headroom' } },
  blocked: { accounts: 3, change: { selectedId: ID(1) }, blocks: [{ account: 1 }] },
  'blocked-model': { accounts: 3, change: { selectedId: ID(2) }, blocks: [{ account: 2, model: 'claude-sonnet' }, { account: 3, model: 'gemini-pro' }] },
  credits: { accounts: 3, change: { selectedId: ID(1), useCredits: true } },
};
const models = ['', 'gpt-5', 'claude-sonnet', 'gemini-pro'];

const cases = [];
async function record(provider, rosterName, scriptName, model) {
  const roster = rosters[rosterName];
  await seed(provider, roster);
  const script = scripts[scriptName]();
  const calls = [];
  const readFor = (id) => {
    const key = id === 'default' ? 'default' : String(Number(id.slice(-12)));
    calls.push({ account: id, answer: plain(script[key]) });
    if (script[key] === 'throw') throw new Error('usage unavailable');
    return script[key];
  };
  const providerObj = {
    forAccount: (id) => ({ getUsageSnapshot: async () => readFor(id) }),
    getUsageSnapshot: async () => readFor('default'),
  };
  const isAccount = accounts.ACCOUNT_PROVIDERS.includes(provider);
  const poolBefore = isAccount ? plain(accounts.readProviderAccountPool(provider)) : null;
  let out;
  try {
    out = { value: await reading.providerQuotaUsable(provider, model, { provider: providerObj }) };
  } catch (error) {
    out = { error: String(error?.message ?? error) };
  }
  const now = Date.now();
  cases.push({ provider, roster: rosterName, script: scriptName, model, poolBefore, calls, poolAfter: isAccount ? plain(accounts.readProviderAccountPool(provider)) : null, now, ...out });
}

for (const provider of ['cursor-oauth', 'antigravity-oauth']) {
  for (const rosterName of Object.keys(rosters)) {
    for (const scriptName of Object.keys(scripts)) {
      for (const model of models) await record(provider, rosterName, scriptName, model);
    }
  }
}
// A provider that reports no exhausted quota reads nothing at all.
for (const provider of ['openai', 'anthropic', 'mixdog-local', 'nope', '']) {
  for (const model of ['', 'gpt-5']) await record(provider, 'none', 'ok', model);
}
// A provider that is not an account provider is answered before anything is read.
const unread = cases.filter((c) => !['cursor-oauth', 'antigravity-oauth'].includes(c.provider));

// ---- proxy mode: the PC answers `quotaUsable`
process.env.MIXDOG_MODEL_PROXY = 'client';
const proxy = [];
// The channel's deadlines are unref'd timers: keep the process alive while they run.
const keepAlive = setInterval(() => {}, 1000);
const tick = () => new Promise((r) => setTimeout(r, 0));
// `connect` runs before the call (a channel without a client refuses at once), `after` while it is out.
async function viaChannel(name, provider, model, { connect = true, absent = false, after = async () => {} } = {}, options = {}) {
  const channel = new channelModule.ModelProxyChannel(options);
  const restore = channelModule.installModelProxyChannel(channel);
  const published = [];
  const entry = { name, provider, model };
  let detach = () => {};
  try {
    if (connect) detach = channel.attachPublisher((state) => published.push(state));
    if (absent) channel.setClientPresent(false);
    // Settled at once: a refusal can come before the scripted PC has finished.
    const answer = reading.providerQuotaUsable(provider, model).then((value) => ({ value }), (error) => ({ error }));
    await tick();
    await after(channel, published, detach);
    const settled = await answer;
    if ('error' in settled) throw settled.error;
    entry.value = settled.value;
  } catch (error) {
    entry.error = { message: String(error?.message ?? error), code: error?.code ?? null, name: error?.name ?? null };
  } finally {
    detach();
    restore();
  }
  entry.published = plain(published.map((state) => state.requests.map(({ provider: p, method, model: m }) => ({ provider: p, method, model: m }))).find((list) => list.length) ?? []);
  proxy.push(entry);
}
const answerWith = (value, ok = true, errorText = null) => async (channel, published) => {
  const id = published.at(-1).requests[0].id;
  channel.claim(id);
  channel.resolve(id, ok, ok ? JSON.stringify(value) : null, errorText);
};
for (const provider of ['openai-oauth', 'openai', '']) {
  for (const model of ['', 'gpt-5']) {
    for (const value of [true, false, 'true', 1, null, { ok: true }]) await viaChannel(`PC answers ${JSON.stringify(value)}`, provider, model, { after: answerWith(value) });
    await viaChannel('PC fails the call', provider, model, { after: answerWith(null, false, JSON.stringify({ name: 'Error', message: 'PC broke', props: { code: 'EPC' } })) });
    await viaChannel('PC fails with a bad error record', provider, model, { after: answerWith(null, false, 'not json') });
    await viaChannel('no client connected', provider, model, { connect: false });
    await viaChannel('the client is marked absent', provider, model, { absent: true });
    await viaChannel('the client goes away mid-call', provider, model, { after: async (_c, _p, detach) => detach() });
    await viaChannel('nobody claims the call', provider, model, {}, { claimTimeoutMs: 30 });
    await viaChannel('the PC stops answering', provider, model, { after: async (channel, published) => channel.claim(published.at(-1).requests[0].id) }, { leaseMs: 30 });
  }
}clearInterval(keepAlive);
delete process.env.MIXDOG_MODEL_PROXY;

writeJson(join(outDir, 'quota-usable-twin.json'), {
  domain: 'quota-usable-twin',
  recorder: 'benchmarks/rust-core/recorders/record-quota-usable.mjs',
  cases,
  proxy,
});
writeSetManifest(outDir, {
  set: 'quota-usable',
  recorder: 'benchmarks/rust-core/recorders/record-quota-usable.mjs',
  command: 'node benchmarks/rust-core/recorders/record-quota-usable.mjs --tree <tree>',
  identityTree: tree,
});
const tally = (list) => list.reduce((acc, c) => ({ ...acc, [String(c.value ?? c.error?.message ?? c.error)]: (acc[String(c.value ?? c.error?.message ?? c.error)] ?? 0) + 1 }), {});
console.log(`recorded ${cases.length} reading cases (${unread.length} unread), ${proxy.length} proxy cases`);
console.log(JSON.stringify(tally(cases)), JSON.stringify(tally(proxy)));
