import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';

const dir = mkdtempSync(join(tmpdir(), 'mixdog-proxy-usage-host-'));
process.env.MIXDOG_DATA_DIR = dir;
delete process.env.MIXDOG_MODEL_PROXY;
const { createModelProxyUsage } = await import('./model-proxy-usage-host.mjs');
const { providerUsageAccounts } = await import('../../../../session-runtime/services/provider-admin.mjs');
const { registerProviderAccount, providerAccountPath } = await import('../../../shared/provider-accounts.mjs');
const { writeJsonAtomicSync } = await import('../../../shared/atomic-file.mjs');
after(() => rmSync(dir, { recursive: true, force: true }));

const provider = 'anthropic-oauth';
const slot = 'cab7f9f6-5de5-44ef-a036-42a18f7da280';
const otherSlot = 'cab7f9f6-5de5-44ef-a036-42a18f7da281';
const row = (id, identityId, version = 'revision-1') => ({
  id,
  authenticated: true,
  identity: { id: identityId },
  version,
});
const scope = (name, id, identity, owner = 'profile-fixture') =>
  `proxy-${createHash('sha256').update(JSON.stringify([owner, name, id, identity])).digest('hex')}`;
const observation = (cachedAt = Date.now() - 1_000) => ({
  cachedAt,
  quotaWindows: [{ label: '5H', usedPct: 12, resetAt: Date.now() + 60_000 }],
});
function fixture(extra = {}) {
  const pool = { selectedId: slot, accounts: [row(slot, 'private-user-a'), row(otherSlot, 'private-user-b')] };
  const bound = { getUsageSnapshot() {} };
  const bindings = [];
  const usage = createModelProxyUsage({
    accounts: () => pool,
    owner: () => 'profile-fixture',
    fetchUsage: async () => observation(),
    ...extra,
  });
  const instance = {
    forAccount(id) {
      bindings.push(id);
      return bound;
    },
  };
  return { pool, usage, instance, bound, bindings };
}
function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test('a selected-account reading exposes only bounded fields, but proves every current account', async () => {
  const at = Date.now() - 120_000;
  const raw = {
    ...observation(at),
    email: 'secret@example.com',
    identity: 'private-user-a',
    accessToken: 'secret-token',
    resetCredits: { available: 99 },
    raw: { secrets: 'secret-payload' },
  };
  raw.quotaWindows[0].email = raw.email;
  const { pool, usage, instance, bound, bindings } = fixture({
    fetchUsage: async (route, target) => {
      assert.deepEqual(route, { provider, accountId: slot });
      assert.equal(target, bound);
      return raw;
    },
  });
  pool.accounts.push({ ...row('unproven', ''), label: 'another-person@example.com', identity: null });
  pool.accounts.push({ ...row('signed-out', 'signed-out'), authenticated: false });
  const account = scope(provider, slot, pool.accounts[0].identity);
  const reply = await usage.snapshot(provider, instance);
  assert.deepEqual(reply, {
    status: 'ready',
    accounts: [account, scope(provider, otherSlot, pool.accounts[1].identity)],
    account,
    snapshot: {
      provider,
      accountId: account,
      source: 'desktop-oauth',
      cachedAt: at,
      quotaWindows: raw.quotaWindows.map(({ label, usedPct, resetAt }) => ({ label, usedPct, resetAt })),
    },
  });
  assert.deepEqual(bindings, [slot], 'no other authenticated account is measured');
  assert.doesNotMatch(JSON.stringify(reply), /secret|private-user|example\.com|resetCredits|raw/);
});

test('force bypasses a completed cache, joins pending work, and never restamps an observation', async () => {
  const work = deferred();
  let calls = 0;
  const at = Date.now() - 2_000;
  const measured = observation(at);
  const { usage, instance } = fixture({
    fetchUsage: async () => {
      calls += 1;
      return work.promise;
    },
  });
  const first = usage.snapshot(provider, instance);
  const forcedPending = usage.snapshot(provider, instance, { force: true });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 1);
  work.resolve(measured);
  const replies = await Promise.all([first, forcedPending]);
  assert.deepEqual(replies[0], replies[1]);
  assert.equal(replies[0].snapshot.cachedAt, at);
  assert.equal((await usage.snapshot(provider, instance)).snapshot.cachedAt, at);
  assert.equal(calls, 1);
  assert.equal((await usage.snapshot(provider, instance, { force: true })).snapshot.cachedAt, at);
  assert.equal(calls, 2);
});

test('a stale adapter observation is preserved and cannot become a fresh completed cache', async () => {
  let calls = 0;
  const at = Date.now() - 300_000;
  const { usage, instance } = fixture({
    fetchUsage: async () => {
      calls += 1;
      return observation(at);
    },
  });
  assert.equal((await usage.snapshot(provider, instance)).snapshot.cachedAt, at);
  assert.equal((await usage.snapshot(provider, instance)).snapshot.cachedAt, at);
  assert.equal(calls, 2);
});

test('measurement failure retains independently proven history scopes and leaks no error', async () => {
  const { usage, instance, pool } = fixture({
    fetchUsage: async () => {
      throw new Error('secret-token private-user-a secret@example.com');
    },
  });
  assert.deepEqual(await usage.snapshot(provider, instance), {
    status: 'unavailable',
    accounts: pool.accounts.map((entry) => scope(provider, entry.id, entry.identity)),
    account: scope(provider, slot, pool.accounts[0].identity),
  });
});

test('unsupported providers and missing adapter measurements still expose proven history, never guessed identities', async () => {
  let fetched = false;
  const { usage, instance, pool, bound } = fixture({
    fetchUsage: async () => {
      fetched = true;
      return observation();
    },
  });
  const mimo = await usage.snapshot('mimo-oauth', instance);
  assert.equal(mimo.status, 'unsupported');
  assert.deepEqual(mimo.accounts, pool.accounts.map((entry) => scope('mimo-oauth', entry.id, entry.identity)));
  delete bound.getUsageSnapshot;
  const muse = await usage.snapshot('muse-code-oauth', instance);
  assert.equal(muse.status, 'unsupported');
  assert.equal(muse.accounts.length, 2);
  assert.equal(fetched, false);
  assert.deepEqual(await usage.snapshot('openai', instance), { status: 'unsupported', accounts: [] });
  pool.accounts[0].identity = null;
  const unavailable = await usage.snapshot(provider, instance);
  assert.equal(unavailable.status, 'unavailable');
  assert.equal(unavailable.account, undefined);
  assert.deepEqual(unavailable.accounts, [scope(provider, otherSlot, pool.accounts[1].identity)]);
});

test('the desktop exports at most twenty currently authenticated account scopes', async () => {
  const { usage, instance, pool } = fixture();
  pool.accounts = Array.from({ length: 25 }, (_, index) => row(`slot-${index}`, `person-${index}`));
  pool.selectedId = 'slot-0';
  const reply = await usage.snapshot('mimo-oauth', instance);
  assert.equal(reply.status, 'unsupported');
  assert.equal(reply.accounts.length, 20);
  assert.deepEqual(reply.accounts, pool.accounts.slice(0, 20).map((entry) => scope('mimo-oauth', entry.id, entry.identity)));
});

for (const change of ['identity', 'selection', 'revision']) {
  test(`${change} changes during measurement retire the obsolete reading and return only current scopes`, async () => {
    const work = deferred();
    const { usage, instance, pool } = fixture({ fetchUsage: () => work.promise });
    const pending = usage.snapshot(provider, instance);
    await new Promise((resolve) => setImmediate(resolve));
    if (change === 'identity') {
      pool.accounts[0] = row(slot, 'replacement-user', 'revision-2');
    } else if (change === 'selection') {
      pool.selectedId = otherSlot;
    } else {
      // Identity A -> B -> A: the stable identity matches, the revision does not.
      pool.accounts[0].version = 'revision-3';
    }
    const joined = usage.snapshot(provider, instance, { force: true });
    work.resolve(observation());
    const reply = await pending;
    assert.equal(reply.status, 'unavailable');
    assert.equal(reply.snapshot, undefined);
    assert.deepEqual(reply.accounts, pool.accounts.map((entry) => scope(provider, entry.id, entry.identity)));
    assert.equal(reply.account, scope(provider, pool.selectedId, pool.accounts.find((r) => r.id === pool.selectedId).identity));
    const next = await joined;
    if (change === 'revision') assert.equal(next.status, 'unavailable', 'a new revision cannot inherit pending old work');
  });
}

test('a load failure needs no adapter to establish history ownership; roster reads failing prove nothing', async () => {
  const { usage, pool } = fixture();
  const reply = await usage.snapshot(provider, undefined);
  assert.equal(reply.status, 'unavailable');
  assert.deepEqual(reply.accounts, pool.accounts.map((entry) => scope(provider, entry.id, entry.identity)));
  const broken = createModelProxyUsage({
    accounts: () => {
      throw new Error('unreadable roster');
    },
  });
  assert.deepEqual(await broken.snapshot(provider, undefined), { status: 'unavailable', accounts: [] });
});

test('durable scope uses installation/profile, provider, slot, and stable identity, not credential revisions', async () => {
  const { pool, instance } = fixture();
  const make = (owner) =>
    createModelProxyUsage({ accounts: () => pool, owner: () => owner, fetchUsage: async () => observation() });
  const first = await make('profile-a').snapshot(provider, instance);
  pool.accounts[0].version = 'rotated-token';
  assert.equal((await make('profile-a').snapshot(provider, instance)).account, first.account);
  assert.notEqual((await make('profile-b').snapshot(provider, instance)).account, first.account);
  pool.accounts[0].identity = { id: 'new-login' };
  assert.notEqual((await make('profile-a').snapshot(provider, instance)).account, first.account);
});

test('the installation namespace survives host/module recreation and contains no account identity', async () => {
  const { pool, instance } = fixture();
  const options = { accounts: () => pool, fetchUsage: async () => observation() };
  const first = await createModelProxyUsage(options).snapshot(provider, instance);
  const reloaded = await import('./model-proxy-usage-host.mjs?namespace-restart');
  assert.equal((await reloaded.createModelProxyUsage(options).snapshot(provider, instance)).account, first.account);
  const stored = JSON.parse(readFileSync(join(dir, 'model-proxy-usage-owner.json'), 'utf8'));
  assert.deepEqual(Object.keys(stored), ['id']);
  assert.match(stored.id, /^[a-f0-9-]{36}$/);
});

test('internal account evidence uses full identity, follows each credential binding, and notices A -> B -> A', async () => {
  const name = 'openai-oauth';
  const ids = [slot, otherSlot];
  for (const id of ids) await registerProviderAccount(name, id, { label: 'private-label@example.com' });
  const document = (id, token) => ({
    access_token: token,
    refresh_token: 'private-refresh',
    identity: { id, email: 'private-email@example.com' },
    account_id: 'truncated-display-hint',
  });
  for (const id of ids) {
    const path = providerAccountPath(name, id);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(document(`real-${id}`, 'private-token')));
  }
  const before = providerUsageAccounts(name);
  assert.equal(before.accounts.length, 2);
  assert.deepEqual(before.accounts[0].identity, { id: `real-${slot}` });
  assert.equal(before.accounts[0].authenticated, true);
  assert.doesNotMatch(JSON.stringify(before), /private-label|private-email|private-token|private-refresh|display-hint/);
  const path = providerAccountPath(name, slot);
  writeJsonAtomicSync(path, document('other-login', 'replacement-token'));
  writeJsonAtomicSync(path, document(`real-${slot}`, 'private-token'));
  const after = providerUsageAccounts(name);
  assert.deepEqual(after.accounts[0].identity, before.accounts[0].identity);
  assert.notEqual(after.accounts[0].version, before.accounts[0].version);
  writeJsonAtomicSync(path, { access_token: 'private-token', refresh_token: 'private-refresh', account_id: 'abc12345…' });
  assert.equal(providerUsageAccounts(name).accounts[0].identity, null, 'a truncated display id is not ownership proof');
});

test('serving proof requires actual adapter identity and a stable credential revision, not a selected account', () => {
  const { usage, pool } = fixture();
  const instance = { credentials: { identity: { id: 'private-user-b' } } };
  assert.equal(usage.captureAccount(provider, slot, instance), undefined);
  const confirm = usage.captureAccount(provider, otherSlot, instance);
  assert.equal(confirm(), scope(provider, otherSlot, pool.accounts[1].identity));
  pool.selectedId = otherSlot;
  pool.accounts[1].version = 'revision-after-A-B-A';
  assert.equal(confirm(), undefined);
  pool.accounts[1].version = 'revision-1';
  const replacement = usage.captureAccount(provider, otherSlot, instance);
  instance.credentials = { identity: { id: 'different-user' } };
  assert.equal(replacement(), undefined);
  assert.equal(usage.captureAccount(provider, slot, {}), undefined);
});
