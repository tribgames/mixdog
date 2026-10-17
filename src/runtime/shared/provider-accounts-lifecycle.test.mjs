import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, mock, test } from 'node:test';

mock.module(new URL('./file-permissions.mjs', import.meta.url).href, {
  namedExports: { enforceOwnerOnlyAclWin32() {}, async enforceOwnerOnlyAclWin32Async() {} },
});
const dir = mkdtempSync(join(tmpdir(), 'mixdog-account-lifecycle-'));
process.env.MIXDOG_DATA_DIR = dir;
const {
  registerProviderAccount,
  removeProviderAccount,
  readProviderAccountPool,
  providerAccountUsageIncarnation,
  changeProviderAccounts,
  newProviderAccountId,
} = await import('./provider-accounts.mjs');
after(() => rmSync(dir, { recursive: true, force: true }));
const file = join(dir, 'provider-accounts.json');
const provider = 'openai-oauth';
const empty = { accounts: [], selectedId: null, auto: true, policy: 'limit' };

test('implicit and materialized legacy defaults share a lifetime without mutating read-only APIs', async () => {
  assert.deepEqual(readProviderAccountPool(provider), empty);
  assert.equal(providerAccountUsageIncarnation(provider, 'default'), null);
  assert.equal(existsSync(file), false);
  await registerProviderAccount(provider, 'default');
  assert.equal(providerAccountUsageIncarnation(provider, 'default'), null);
  await changeProviderAccounts(provider, { rename: { id: 'default', label: 'Renamed' }, policy: 'headroom' });
  assert.equal(providerAccountUsageIncarnation(provider, 'default'), null);
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).defaultAccountEpochs, undefined);
});

test('default removal persists its next lifetime even when empty; re-add and other roster mutations preserve it', async () => {
  const removed = await removeProviderAccount(provider, 'default');
  assert.deepEqual(removed, { ...empty, policy: 'headroom' });
  const epoch = providerAccountUsageIncarnation(provider, 'default');
  assert.match(epoch, /^[a-f0-9-]{36}$/);
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).defaultAccountEpochs[provider], epoch);
  assert.equal('defaultAccountEpochs' in readProviderAccountPool(provider), false);
  const restarted = await import('./provider-accounts.mjs?lifecycle-restart');
  assert.equal(restarted.providerAccountUsageIncarnation(provider, 'default'), epoch);
  const id = newProviderAccountId();
  await registerProviderAccount(provider, id, { includeDefault: true });
  await changeProviderAccounts(provider, { selectedId: id, order: [id, 'default'], auto: false });
  await removeProviderAccount(provider, id);
  assert.equal(providerAccountUsageIncarnation(provider, 'default'), epoch);
  assert.equal(providerAccountUsageIncarnation(provider, id), null, 'UUID slots already carry their own incarnation');
  await removeProviderAccount(provider, 'default');
  assert.notEqual(providerAccountUsageIncarnation(provider, 'default'), epoch);
});

test('removing a still-implicit default also rotates its lifetime without requiring a prior usage or roster read', async () => {
  const name = 'anthropic-oauth';
  const removed = await removeProviderAccount(name, 'default');
  assert.deepEqual(removed, empty);
  const epoch = providerAccountUsageIncarnation(name, 'default');
  assert.match(epoch, /^[a-f0-9-]{36}$/);
  await registerProviderAccount(name, 'default');
  assert.equal(providerAccountUsageIncarnation(name, 'default'), epoch);
});

test('unreadable lifecycle evidence is not silently treated as the legacy default lifetime', (t) => {
  const corrupt = mkdtempSync(join(tmpdir(), 'mixdog-account-lifecycle-corrupt-'));
  t.after(() => rmSync(corrupt, { recursive: true, force: true }));
  writeFileSync(join(corrupt, 'provider-accounts.json'), JSON.stringify({
    version: 1,
    providers: {},
    defaultAccountEpochs: { [provider]: 42 },
  }));
  assert.throws(() => providerAccountUsageIncarnation(provider, 'default', corrupt), /lifecycle settings are unreadable/);
});
