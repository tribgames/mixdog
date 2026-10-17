import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

const dir = mkdtempSync(join(tmpdir(), 'mixdog-oauth-proxy-host-'));
process.env.MIXDOG_DATA_DIR = dir;
delete process.env.MIXDOG_MODEL_PROXY;
const { measureOAuthUsageSnapshot, readCachedOAuthUsageSnapshot, fetchOAuthUsageSnapshot } = await import('./oauth-usage.mjs');
after(() => rmSync(dir, { recursive: true, force: true }));

test('desktop measurement reuses normalized HTTP usage without reading a local cache or redeeming credits', async (t) => {
  const prior = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = prior;
  });
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push(url);
    assert.equal(options.headers.Authorization, 'Bearer fixture-token');
    return {
      ok: true,
      json: async () => ({
        five_hour: { utilization: 15, resets_at: '2030-01-01T00:00:00Z' },
        seven_day: { utilization: 20, resets_at: '2030-01-02T00:00:00Z' },
      }),
    };
  };
  const start = Date.now();
  const result = await measureOAuthUsageSnapshot(
    { provider: 'anthropic-oauth', accountId: 'default' },
    { ensureAuth: async () => ({ accessToken: 'fixture-token' }) }
  );
  assert.deepEqual(calls, ['https://api.anthropic.com/api/oauth/usage']);
  assert.deepEqual(result.quotaWindows.map(({ label, usedPct }) => [label, usedPct]), [['5H', 15], ['7D', 20]]);
  assert.ok(result.cachedAt >= start && result.cachedAt <= Date.now());
  assert.equal(readCachedOAuthUsageSnapshot({ provider: 'anthropic-oauth' }), null, 'measurement does not populate local caches');
});

test('Muse last-good readings keep fetchedAt; missing or invalid observation times are refused', async () => {
  const at = Date.now() - 300_000;
  const quotaWindows = [{ label: '5H', usedPct: 32 }];
  for (const name of ['muse-code-oauth', 'command-code-oauth']) {
    const result = await measureOAuthUsageSnapshot(
      { provider: name },
      { getUsageSnapshot: async () => ({ fetchedAt: at, quotaWindows }) }
    );
    assert.equal(result.cachedAt, at);
    assert.equal(
      await measureOAuthUsageSnapshot({ provider: name }, { getUsageSnapshot: async () => ({ quotaWindows }) }),
      null
    );
  }
  for (const fetchedAt of [0, NaN, 'now', Date.now() + 60_000]) {
    assert.equal(
      await measureOAuthUsageSnapshot(
        { provider: 'muse-code-oauth' },
        { getUsageSnapshot: async () => ({ fetchedAt, quotaWindows }) }
      ),
      null
    );
  }
});

test('completed live adapter reads may use completion time, while an explicit original cachedAt wins', async () => {
  const quotaWindows = [{ label: '7D', usedPct: 4 }];
  const start = Date.now();
  const live = await measureOAuthUsageSnapshot(
    { provider: 'antigravity-oauth' },
    { getUsageSnapshot: async () => ({ quotaWindows }) }
  );
  assert.ok(live.cachedAt >= start && live.cachedAt <= Date.now());
  const cachedAt = start - 200_000;
  const cached = await measureOAuthUsageSnapshot(
    { provider: 'cursor-oauth' },
    { getUsageSnapshot: async () => ({ cachedAt, quotaWindows }) }
  );
  assert.equal(cached.cachedAt, cachedAt);
});

test('proxy cached reads return null; async reads route only to the daemon and desktop measurement cannot recurse', async (t) => {
  const provider = 'anthropic-oauth';
  const local = { provider, cachedAt: Date.now(), quotaWindows: [{ label: '5H', usedPct: 88 }] };
  writeFileSync(join(dir, 'gateway-oauth-usage-cache.json'), JSON.stringify({ version: 1, routes: { [provider]: local } }));
  assert.deepEqual(readCachedOAuthUsageSnapshot({ provider }), local);
  const account = `proxy-${'a'.repeat(64)}`;
  const remote = {
    provider,
    accountId: account,
    source: 'desktop-oauth',
    cachedAt: Date.now() - 10_000,
    quotaWindows: [{ label: '5H', usedPct: 17 }],
  };
  const calls = [];
  t.mock.module('./model-proxy-usage.mjs', {
    namedExports: {
      readRemoteOAuthUsage: async (name, options) => {
        calls.push([name, options]);
        return { status: 'ready', accounts: [account], account, snapshot: remote };
      },
    },
  });
  process.env.MIXDOG_MODEL_PROXY = 'client';
  t.after(() => {
    delete process.env.MIXDOG_MODEL_PROXY;
  });
  const noCredentials = new Proxy({}, { get: () => { throw new Error('server credentials must never be accessed'); } });
  assert.equal(readCachedOAuthUsageSnapshot({ provider }, { allowStale: true }), null);
  assert.deepEqual(await fetchOAuthUsageSnapshot({ provider }, noCredentials, () => {}, { force: true }), remote);
  assert.deepEqual(calls, [[provider, { force: true }]]);
  assert.equal(await measureOAuthUsageSnapshot({ provider }, noCredentials), null);
  assert.equal(calls.length, 1, 'desktop measurement does not call the daemon');
});
