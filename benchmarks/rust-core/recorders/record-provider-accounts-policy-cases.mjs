#!/usr/bin/env node
// Recording of shared/provider-accounts-policy.test.mjs (b6f10295a): the provider-account roster's switching policy
// (shared/provider-accounts.mjs): the roster file as an older build wrote it (`auto` only) read back as a policy, policy and auto
// writes (changeProviderAccounts) keeping `auto` readable, the account pick of manual / limit / headroom
// (chooseProviderAccount) and the family-scoped limit (providerAccountLimit, providerAccountExhaustedForModelOnly). The real roster
// file under a temp data dir; the owner-only ACL helper is stubbed (as in the test: it is a Windows-only side effect).
//
//   node --experimental-test-module-mocks benchmarks/rust-core/recorders/record-provider-accounts-policy-cases.mjs --tree <export of b6f10295a with node_modules>
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mock } from 'node:test';
import { pathToFileURL } from 'node:url';
import { openSet } from './lib/case-set.mjs';

const set = openSet('provider-accounts-policy-cases', import.meta.url);
const dir = mkdtempSync(join(tmpdir(), 'provider-accounts-policy-'));
process.env.MIXDOG_DATA_DIR = dir;
mock.module(pathToFileURL(join(set.tree, 'src/runtime/shared/file-permissions.mjs')).href, { namedExports: { enforceOwnerOnlyAclWin32() {}, async enforceOwnerOnlyAclWin32Async() {} } });
const { registerProviderAccount, changeProviderAccounts, readProviderAccountPool, newProviderAccountId, chooseProviderAccount, providerAccountLimit, providerAccountExhaustedForModelOnly } = await set.load('src/runtime/shared/provider-accounts.mjs');

const provider = 'openai-oauth';
const file = join(dir, 'provider-accounts.json');
function rewrite(edit) {
  const raw = JSON.parse(readFileSync(file, 'utf8'));
  edit(raw.providers[provider]);
  writeFileSync(file, JSON.stringify(raw));
}
const idShape = (id) => ({ isString: typeof id === 'string', length: String(id).length });
const poolView = (pool) => ({ policy: pool.policy, auto: pool.auto, accounts: (pool.accounts ?? []).length, selected: Boolean(pool.selectedId) });
const rawView = () => { const p = JSON.parse(readFileSync(file, 'utf8')).providers[provider]; return { policy: p.policy ?? null, auto: p.auto ?? null, keys: Object.keys(p).sort() }; };
const failure = (e) => ({ name: e?.name ?? null, message: String(e?.message ?? e) });

await set.run('a roster saved before switching policies maps auto onto a policy', async () => {
  await registerProviderAccount(provider, newProviderAccountId());
  const log = [];
  rewrite((pool) => { delete pool.policy; pool.auto = false; });
  log.push({ step: 'file: no policy, auto false', read: poolView(readProviderAccountPool(provider)) });
  rewrite((pool) => { pool.auto = true; });
  log.push({ step: 'file: no policy, auto true', read: poolView(readProviderAccountPool(provider)) });
  rewrite((pool) => { pool.policy = 'headroom'; pool.auto = false; });
  log.push({ step: 'file: policy headroom, auto false (an older build turned switching off)', read: poolView(readProviderAccountPool(provider)) });
  return { provider, log };
});
await set.run('policy writes keep auto readable for builds that predate it', async () => {
  const log = [];
  let pool = await changeProviderAccounts(provider, { policy: 'headroom' });
  log.push({ change: { policy: 'headroom' }, pool: poolView(pool), file: rawView() });
  for (const change of [{ auto: true }, { auto: false }, { auto: true }, { policy: 'manual' }]) {
    pool = await changeProviderAccounts(provider, change);
    log.push({ change, pool: poolView(pool), file: rawView() });
  }
  let rejected = null;
  try { await changeProviderAccounts(provider, { policy: 'fastest' }); } catch (e) { rejected = failure(e); }
  log.push({ change: { policy: 'fastest' }, rejected });
  return { provider, log };
});
const now = 5_000_000;
const row = (id, windows, extra = {}) => ({ id, usage: { windows, checkedAt: now }, ...extra });
await set.run('manual, limit and headroom pick accounts as their names say', () => {
  const accounts = [row('a', [{ label: '5H', usedPct: 60 }]), row('b', [{ label: '5H', usedPct: 10 }]), row('c', [{ label: '5H', usedPct: 30 }])];
  const base = { accounts, selectedId: 'a' };
  const headroom = { ...base, auto: true, policy: 'headroom' };
  const unknown = { ...headroom, accounts: [...accounts.slice(0, 2), { id: 'c' }] };
  const picks = [
    ['manual, nothing used up', { ...base, auto: false }, [], undefined],
    ['manual, selected account used up', { ...base, auto: false }, ['a'], undefined],
    ['limit (auto, no policy)', { ...base, auto: true }, [], undefined],
    ['headroom, first request', headroom, [], undefined],
    ['headroom, session keeps its usable account', headroom, [], { sessionAccountId: 'c' }],
    ['headroom, session account hit a limit', headroom, ['c'], { sessionAccountId: 'c' }],
    ['headroom, unknown usage keeps roster order', unknown, [], undefined],
  ].map(([label, pool, used, options]) => ({ label, pool, usedUp: used, options: options ?? null, now, picked: (options ? chooseProviderAccount(pool, new Set(used), now, 'm', options) : chooseProviderAccount(pool, new Set(used), now, 'm'))?.id ?? null }));
  return { model: 'm', now, picks };
});
await set.run('a full model-family window limits that family only', () => {
  const fable = row('a', [{ label: '5H', usedPct: 12, resetAt: now + 1000 }, { label: '7D Fable', usedPct: 100, resetAt: now + 1000 }]);
  const spent = row('b', [{ label: '5H', usedPct: 100, resetAt: now + 1000 }, { label: '7D Fable', usedPct: 100, resetAt: now + 1000 }]);
  const scopedBlock = row('c', [{ label: '7D Fable', usedPct: 40 }], { blockedUntil: now + 1000, blockedModel: 'claude-fable-5' });
  const blockedOther = { id: 'd', blockedUntil: now + 1000, blockedModel: 'gpt-5' };
  const nearFull = row('e', [{ label: '7D', usedPct: 99 }]);
  return {
    now,
    limits: [fable, spent, scopedBlock, blockedOther, nearFull].map((account) => ({ account, limit: providerAccountLimit(account, now) })),
    exhaustedForModelOnly: [[fable, 'claude-fable-5'], [fable, 'claude-opus-4'], [spent, 'claude-fable-5']].map(([account, model]) => ({ accountId: account.id, model, answer: providerAccountExhaustedForModelOnly(account, now, model) })),
  };
});

await set.finish({
  entry: { runs: 'shared/provider-accounts.mjs (registerProviderAccount, changeProviderAccounts, readProviderAccountPool, chooseProviderAccount, providerAccountLimit, providerAccountExhaustedForModelOnly) over the real provider-accounts.json in a temp data dir', notRun: 'the owner-only ACL helper (a Windows side effect) is stubbed as in the test; no provider usage fetch' },
  replay: { entry: 'mixdog-ai accounts/policy.rs (and the roster file reader/writer): replay the file edits and policy/auto writes (compare the pool view and the file keys), and the pure picks/limits on the recorded pools', normalised: { accountIds: 'the registered account id is random: not recorded', dataDir: 'temp, not in the recording' } },
});
rmSync(dir, { recursive: true, force: true });
process.exit(0);
