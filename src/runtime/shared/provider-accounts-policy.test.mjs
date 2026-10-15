import assert from 'node:assert/strict';
import { test, after, mock } from 'node:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

mock.module(new URL('./file-permissions.mjs', import.meta.url).href, {
  namedExports: { enforceOwnerOnlyAclWin32() {}, async enforceOwnerOnlyAclWin32Async() {} },
});

const dir = mkdtempSync(join(tmpdir(), 'mixdog-provider-accounts-policy-'));
process.env.MIXDOG_DATA_DIR = dir;
const {
  registerProviderAccount,
  changeProviderAccounts,
  readProviderAccountPool,
  newProviderAccountId,
  chooseProviderAccount,
  providerAccountLimit,
  providerAccountExhaustedForModelOnly,
} = await import('./provider-accounts.mjs');
after(() => rmSync(dir, { recursive: true, force: true }));

const provider = 'openai-oauth';
const file = join(dir, 'provider-accounts.json');
function rewrite(edit) {
  const raw = JSON.parse(readFileSync(file, 'utf8'));
  edit(raw.providers[provider]);
  writeFileSync(file, JSON.stringify(raw));
}

test('a roster saved before switching policies maps auto onto a policy', async () => {
  await registerProviderAccount(provider, newProviderAccountId());
  rewrite((pool) => {
    delete pool.policy;
    pool.auto = false;
  });
  assert.equal(readProviderAccountPool(provider).policy, 'manual');
  rewrite((pool) => {
    pool.auto = true;
  });
  assert.equal(readProviderAccountPool(provider).policy, 'limit');
  assert.equal(readProviderAccountPool(provider).auto, true);
  // An older build that only knows `auto` turned switching off.
  rewrite((pool) => {
    pool.policy = 'headroom';
    pool.auto = false;
  });
  assert.equal(readProviderAccountPool(provider).policy, 'manual');
});

test('policy writes keep auto readable for builds that predate it', async () => {
  let pool = await changeProviderAccounts(provider, { policy: 'headroom' });
  assert.equal(pool.policy, 'headroom');
  assert.equal(pool.auto, true);
  const raw = JSON.parse(readFileSync(file, 'utf8')).providers[provider];
  assert.equal(raw.policy, 'headroom');
  assert.equal(raw.auto, true);
  pool = await changeProviderAccounts(provider, { auto: true });
  assert.equal(pool.policy, 'headroom', 'switching on keeps the chosen non-manual policy');
  pool = await changeProviderAccounts(provider, { auto: false });
  assert.equal(pool.policy, 'manual');
  pool = await changeProviderAccounts(provider, { auto: true });
  assert.equal(pool.policy, 'limit');
  pool = await changeProviderAccounts(provider, { policy: 'manual' });
  assert.equal(pool.auto, false);
  await assert.rejects(() => changeProviderAccounts(provider, { policy: 'fastest' }), /Unknown account switching/);
});

const now = 5_000_000;
const row = (id, windows, extra = {}) => ({ id, usage: { windows, checkedAt: now }, ...extra });

test('manual, limit and headroom pick accounts as their names say', () => {
  const accounts = [
    row('a', [{ label: '5H', usedPct: 60 }]),
    row('b', [{ label: '5H', usedPct: 10 }]),
    row('c', [{ label: '5H', usedPct: 30 }]),
  ];
  const base = { accounts, selectedId: 'a' };
  assert.equal(chooseProviderAccount({ ...base, auto: false }, new Set(), now, 'm').id, 'a');
  assert.equal(chooseProviderAccount({ ...base, auto: false }, new Set(['a']), now, 'm'), null);
  assert.equal(chooseProviderAccount({ ...base, auto: true }, new Set(), now, 'm').id, 'a');
  const headroom = { ...base, auto: true, policy: 'headroom' };
  assert.equal(chooseProviderAccount(headroom, new Set(), now, 'm').id, 'b', 'first request: most headroom');
  assert.equal(
    chooseProviderAccount(headroom, new Set(), now, 'm', { sessionAccountId: 'c' }).id,
    'c',
    'a session keeps its account while it is usable'
  );
  assert.equal(
    chooseProviderAccount(headroom, new Set(['c']), now, 'm', { sessionAccountId: 'c' }).id,
    'b',
    'on a limit the session moves to the most headroom'
  );
  const unknown = { ...headroom, accounts: [...accounts.slice(0, 2), { id: 'c' }] };
  assert.equal(chooseProviderAccount(unknown, new Set(), now, 'm').id, 'a', 'unknown usage keeps roster order');
});

test('a full model-family window limits that family only', () => {
  const fable = row('a', [
    { label: '5H', usedPct: 12, resetAt: now + 1000 },
    { label: '7D Fable', usedPct: 100, resetAt: now + 1000 },
  ]);
  assert.deepEqual(providerAccountLimit(fable, now), { scope: 'model', families: ['Fable'] });
  assert.equal(providerAccountExhaustedForModelOnly(fable, now, 'claude-fable-5'), true);
  assert.equal(providerAccountExhaustedForModelOnly(fable, now, 'claude-opus-4'), false);
  const spent = row('b', [
    { label: '5H', usedPct: 100, resetAt: now + 1000 },
    { label: '7D Fable', usedPct: 100, resetAt: now + 1000 },
  ]);
  assert.deepEqual(providerAccountLimit(spent, now), { scope: 'account' });
  assert.equal(providerAccountExhaustedForModelOnly(spent, now, 'claude-fable-5'), false);
  const scopedBlock = row('c', [{ label: '7D Fable', usedPct: 40 }], {
    blockedUntil: now + 1000,
    blockedModel: 'claude-fable-5',
  });
  assert.deepEqual(providerAccountLimit(scopedBlock, now), { scope: 'model', families: ['Fable'] });
  assert.deepEqual(providerAccountLimit({ id: 'd', blockedUntil: now + 1000, blockedModel: 'gpt-5' }, now), {
    scope: 'account',
  });
  assert.equal(providerAccountLimit(row('e', [{ label: '7D', usedPct: 99 }]), now), null);
});
