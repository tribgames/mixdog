import assert from 'node:assert/strict';
import { test, after, mock } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// The owner-only ACL step is the slow part of a secret write on Windows. Model
// it as a slow ASYNC call; the event loop must stay free while it is pending.
let aclDelayMs = 0;
mock.module(new URL('./file-permissions.mjs', import.meta.url).href, {
  namedExports: {
    enforceOwnerOnlyAclWin32() {},
    async enforceOwnerOnlyAclWin32Async() {
      if (aclDelayMs) await new Promise((resolve) => setTimeout(resolve, aclDelayMs));
    },
  },
});

const dir = mkdtempSync(join(tmpdir(), 'mixdog-provider-accounts-async-'));
process.env.MIXDOG_DATA_DIR = dir;
const {
  registerProviderAccount,
  changeProviderAccounts,
  removeProviderAccount,
  readProviderAccountPool,
  newProviderAccountId,
  selectProviderAccountIf,
} = await import('./provider-accounts.mjs');
const { currentProviderAccountId } = await import('./provider-auth-binding.mjs');
const { createAccountPoolProvider } = await import('../agent/orchestrator/providers/account-pool.mjs');
after(() => rmSync(dir, { recursive: true, force: true }));

const provider = 'grok-oauth';

test('a pending account write does not block the event loop', async () => {
  aclDelayMs = 200;
  let ticks = 0;
  const timer = setInterval(() => {
    ticks += 1;
  }, 10);
  try {
    await registerProviderAccount(provider, newProviderAccountId());
  } finally {
    clearInterval(timer);
    aclDelayMs = 0;
  }
  assert.ok(ticks >= 5, `timer fired ${ticks} times during the write`);
});

test('concurrent updates in one process lose neither change', async () => {
  const ids = [newProviderAccountId(), newProviderAccountId()];
  await Promise.all([
    registerProviderAccount(provider, ids[0]),
    registerProviderAccount(provider, ids[1]),
    changeProviderAccounts(provider, { auto: false }),
  ]);
  const pool = readProviderAccountPool(provider);
  for (const id of ids) assert.ok(pool.accounts.some((row) => row.id === id));
  assert.equal(pool.auto, false);
});

test('a refused account is blocked and committed before the next account is chosen', async () => {
  const [a, b] = [newProviderAccountId(), newProviderAccountId()];
  for (const row of readProviderAccountPool(provider).accounts) await removeProviderAccount(provider, row.id);
  await registerProviderAccount(provider, a);
  await registerProviderAccount(provider, b);
  await changeProviderAccounts(provider, { selectedId: a, auto: true });
  const used = [];
  const gateway = createAccountPoolProvider(provider, () => {
    const id = currentProviderAccountId(provider);
    return {
      async send() {
        used.push(id);
        if (id === a) throw Object.assign(new Error('Quota exhausted'), { code: 'usage_limit_reached', status: 429 });
        return { content: 'ok' };
      },
    };
  });
  aclDelayMs = 50;
  try {
    assert.equal((await gateway.send([], 'm', [], {})).content, 'ok');
  } finally {
    aclDelayMs = 0;
  }
  assert.deepEqual(used, [a, b]);
  const pool = readProviderAccountPool(provider);
  assert.ok(pool.accounts.find((row) => row.id === a).blockedUntil > Date.now());
  assert.equal(pool.selectedId, b);
});

test('a fallback queued behind a manual switch does not overwrite it', async () => {
  const [a, b, c] = [newProviderAccountId(), newProviderAccountId(), newProviderAccountId()];
  for (const row of readProviderAccountPool(provider).accounts) await removeProviderAccount(provider, row.id);
  for (const id of [a, b, c]) await registerProviderAccount(provider, id);
  await changeProviderAccounts(provider, { selectedId: a });
  // Both start from selection `a`; the manual switch to `c` is queued first.
  const [manual, fallback] = await Promise.all([
    changeProviderAccounts(provider, { selectedId: c }),
    selectProviderAccountIf(provider, a, b),
  ]);
  assert.equal(manual.selectedId, c);
  assert.equal(fallback, null, 'a superseded fallback reports no change');
  assert.equal(readProviderAccountPool(provider).selectedId, c);
  // With the selection still as expected, the fallback commits.
  assert.equal((await selectProviderAccountIf(provider, c, b)).selectedId, b);
});
