import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'mixdog-account-pool-'));
process.env.MIXDOG_DATA_DIR = dir;
const {
  registerProviderAccount, changeProviderAccounts, readProviderAccountPool,
  newProviderAccountId, recordProviderAccountUsage, chooseProviderAccount,
  providerAccountPath, removeProviderAccount,
} = await import('../../../shared/provider-accounts.mjs');
const { withProviderAccount, boundProviderAuthPath, currentProviderAccountId, replaceProviderAuthBindings } =
  await import('../../../shared/provider-auth-binding.mjs');
const { createAccountPoolProvider, isAccountQuotaError } = await import('./account-pool.mjs');
const { cloneProviderReplay } = await import('./lib/provider-replay.mjs');
after(() => rmSync(dir, { recursive: true, force: true }));

function setup(provider) {
  const ids = [newProviderAccountId(), newProviderAccountId(), newProviderAccountId()];
  for (const [i, id] of ids.entries()) registerProviderAccount(provider, id, { label: `Account ${i + 1}` });
  changeProviderAccounts(provider, { selectedId: ids[0] });
  return ids;
}
function quotaError() { return Object.assign(new Error('Quota exhausted'), { code: 'usage_limit_reached', status: 429 }); }
function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

test('persisted order controls quota failover and preserves selection across reloads', async () => {
  const provider = 'openai-oauth';
  const ids = setup(provider);
  changeProviderAccounts(provider, { order: [ids[0], ids[2], ids[1]] });
  const calls = [];
  const gateway = createAccountPoolProvider(provider, () => ({
    async send(messages, model, tools, opts) {
      const id = currentProviderAccountId(provider);
      calls.push(id);
      if (id === ids[0]) throw quotaError();
      assert.equal(model, 'same-model');
      assert.equal(messages[0].content, 'keep this');
      assert.equal(messages[0].providerReplay, undefined);
      return {
        content: 'done', providerReplay: { version: 1, provider: 'openai-responses', items: [{ type: 'message' }] },
        providerState: { responseId: 'response' },
      };
    },
  }));
  const result = await gateway.send([{ role: 'assistant', content: 'keep this',
    providerReplay: { accountId: ids[0], items: [] } }], 'same-model', [], { sessionId: 'visible-session' });
  assert.deepEqual(calls, [ids[0], ids[2]]);
  assert.equal(result.content, 'done');
  assert.equal(cloneProviderReplay(result.providerReplay).accountId, ids[2]);
  assert.equal(result.providerState.providerAccountId, ids[2]);
  assert.equal(JSON.parse(readFileSync(join(dir, 'provider-accounts.json'), 'utf8')).providers[provider].selectedId, ids[2]);
  assert.throws(() => changeProviderAccounts(provider, { order: [ids[0], ids[0], ids[2]] }), /exactly once/);
  assert.throws(() => changeProviderAccounts(provider, { selectedId: '../../credentials' }), /Invalid/);
  assert.throws(() => providerAccountPath(provider, '../outside'), /Invalid/);
});

test('manual switching never changes authentication inside an in-flight request', async () => {
  const provider = 'anthropic-oauth';
  const ids = setup(provider);
  const entered = deferred();
  const release = deferred();
  const gateway = createAccountPoolProvider(provider, () => {
    const ownPath = boundProviderAuthPath(provider);
    return {
      async send(_messages, _model, _tools, options) {
        if (options.wait) { entered.resolve(); await release.promise; }
        assert.equal(boundProviderAuthPath(provider), ownPath);
        return { content: currentProviderAccountId(provider) };
      },
    };
  });
  const first = gateway.send([], 'model', [], { wait: true });
  await entered.promise;
  changeProviderAccounts(provider, { selectedId: ids[1] });
  assert.equal((await gateway.send([], 'model', [])).content, ids[1]);
  release.resolve();
  assert.equal((await first).content, ids[0]);
  assert.equal(currentProviderAccountId(provider), ids[1]);
  await Promise.all(ids.map((id) => withProviderAccount(provider, id, async () => {
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(boundProviderAuthPath(provider), providerAccountPath(provider, id));
  })));
});

test('quota snapshots skip exhausted windows, and an elapsed reset becomes eligible', () => {
  const provider = 'grok-oauth';
  const ids = setup(provider);
  const now = Date.now();
  recordProviderAccountUsage(provider, ids[0], { quotaWindows: [{ label: '7D', usedPct: 100, resetAt: now + 60_000 }] });
  recordProviderAccountUsage(provider, ids[1], { quotaWindows: [{ label: '5H', usedPct: 100, resetAt: now + 120_000 }] });
  const pool = readProviderAccountPool(provider);
  assert.equal(chooseProviderAccount(pool, new Set(), now).id, ids[2]);
  assert.equal(chooseProviderAccount(pool, new Set(), now + 60_001).id, ids[0]);
  assert.equal(pool.accounts[2].usage, undefined);
});

test('no replay after emitted output, cancellation, auth failure, or disabled automatic switching', async () => {
  const provider = 'cursor-oauth';
  const ids = setup(provider);
  for (const kind of ['text', 'tool', 'unsafe', 'auth', 'cancel', 'manual']) {
    changeProviderAccounts(provider, { selectedId: ids[0], auto: kind !== 'manual' });
    recordProviderAccountUsage(provider, ids[0], { quotaWindows: [{ usedPct: 0 }] });
    let calls = 0;
    const controller = new AbortController();
    const gateway = createAccountPoolProvider(provider, () => ({
      async send(_messages, _model, _tools, opts) {
        calls++;
        if (kind === 'text') opts.onTextDelta('visible');
        if (kind === 'tool') opts.onToolCall({ id: 'executed' });
        if (kind === 'cancel') controller.abort();
        const error = quotaError();
        if (kind === 'unsafe') error.unsafeToRetry = true;
        if (kind === 'auth') error.status = 403;
        throw error;
      },
    }));
    await assert.rejects(gateway.send([], 'model', [], { signal: controller.signal }));
    assert.equal(calls, 1, kind);
  }
  assert.equal(isAccountQuotaError({ status: 429, code: 'rate_limit_exceeded' }), false);
  assert.equal(isAccountQuotaError({ status: 500, code: 'server_error' }), false);
});

test('all accounts exhausted stop without cycling, and explicit host bindings bypass the pool', async () => {
  const provider = 'antigravity-oauth';
  setup(provider);
  let calls = 0;
  const gateway = createAccountPoolProvider(provider, () => ({ async send() { calls++; throw quotaError(); } }));
  await assert.rejects(gateway.send([], 'model', []), /Quota exhausted/);
  assert.equal(calls, 3);
  await assert.rejects(gateway.send([], 'model', []), /All connected accounts/);
  assert.equal(calls, 3);
  const restore = replaceProviderAuthBindings({ [provider]: join(dir, 'isolated.json') });
  try {
    const explicit = createAccountPoolProvider(provider, () => ({ async send() { return boundProviderAuthPath(provider); } }));
    assert.equal(await explicit.send(), join(dir, 'isolated.json'));
  } finally { restore(); }
});

test('removing a selected account picks a remaining account; corrupt metadata is not overwritten', () => {
  const provider = 'openai-oauth';
  const before = readProviderAccountPool(provider);
  removeProviderAccount(provider, before.selectedId);
  assert.notEqual(readProviderAccountPool(provider).selectedId, before.selectedId);
  const path = join(dir, 'provider-accounts.json');
  const saved = readFileSync(path, 'utf8');
  writeFileSync(path, '{invalid');
  assert.throws(() => changeProviderAccounts(provider, { auto: false }));
  assert.equal(readFileSync(path, 'utf8'), '{invalid');
  writeFileSync(path, saved);
});

test('native OAuth refreshes remain isolated when two accounts refresh concurrently', async () => {
  const { writeJsonAtomicSync } = await import('../../../shared/atomic-file.mjs');
  const { ensureAccessToken } = await import('./antigravity-oauth-tokens.mjs');
  const provider = 'antigravity-oauth';
  const ids = [newProviderAccountId(), newProviderAccountId()];
  for (const id of ids) {
    writeJsonAtomicSync(providerAccountPath(provider, id), {
      access_token: `old-${id}`, refresh_token: `refresh-${id}`, expires_at: 1, project_id: id,
    }, { mode: 0o600, secret: true });
  }
  const release = deferred();
  const seen = [];
  const fetchFn = async (_url, options) => {
    const token = options.body.get('refresh_token');
    seen.push(token);
    await release.promise;
    return new Response(JSON.stringify({ access_token: `new-${token}`, expires_in: 3600 }), { status: 200 });
  };
  const pending = ids.map((id) => withProviderAccount(provider, id, () => ensureAccessToken({ fetchFn })));
  release.resolve();
  const results = await Promise.all(pending);
  assert.equal(seen.length, 2);
  for (const [i, result] of results.entries()) {
    assert.equal(result.access_token, `new-refresh-${ids[i]}`);
    assert.equal(JSON.parse(readFileSync(providerAccountPath(provider, ids[i]), 'utf8')).access_token, result.access_token);
  }
});

test('usage caches never return a different account quota after selection changes', async () => {
  const { fetchOAuthUsageSnapshot, readCachedOAuthUsageSnapshot } = await import('./oauth-usage.mjs');
  const provider = 'cursor-oauth';
  const [a, b] = readProviderAccountPool(provider).accounts.map((row) => row.id);
  await Promise.all([[a, 14], [b, 87]].map(([accountId, usedPct]) =>
    fetchOAuthUsageSnapshot({ provider, accountId }, {
      async getUsageSnapshot() { return { quotaWindows: [{ label: '7D', usedPct, resetAt: Date.now() + 60_000 }] }; },
    }, () => {}, { force: true })));
  changeProviderAccounts(provider, { selectedId: a });
  assert.equal(readCachedOAuthUsageSnapshot({ provider }).quotaWindows[0].usedPct, 14);
  changeProviderAccounts(provider, { selectedId: b });
  assert.equal(readCachedOAuthUsageSnapshot({ provider }).quotaWindows[0].usedPct, 87);
});
