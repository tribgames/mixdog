import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  ModelProxyChannel,
  MODEL_PROXY_METHODS,
  encodeModelProxyWire,
  installModelProxyChannel,
  modelProxyErrorToWire,
} from './model-proxy-channel.mjs';
import { ModelProxyProvider, loadModelProxyProviderConfig } from './model-proxy-provider.mjs';
import { readRemoteOAuthUsage, remoteQuotaScope } from './model-proxy-usage.mjs';
import { recordQuotaReadings } from './lib/quota-readings.mjs';
import { closeUsageLedgers, getUsageLedger } from '../../../shared/llm/usage-ledger.mjs';
import { accountProviderSend } from '../../../shared/llm/usage-accounting.mjs';
import { noteAbandonedUsage } from '../../../shared/llm/usage-context.mjs';
import { createUsageStatsApi } from '../../../../session-runtime/usage-stats-api.mjs';

const provider = 'openai-oauth';
const accountA = `proxy-${'a'.repeat(64)}`;
const accountB = `proxy-${'b'.repeat(64)}`;
const accountC = `proxy-${'c'.repeat(64)}`;
const observedAt = Date.UTC(2026, 0, 1, 12);
const ready = (account = accountA, cachedAt = observedAt, usedPct = 20) => ({
  status: 'ready',
  accounts: [accountA, accountB],
  account,
  snapshot: {
    provider,
    accountId: account,
    source: 'desktop-oauth',
    cachedAt,
    quotaWindows: [{ label: '5H', usedPct, resetAt: observedAt + 3_600_000 }],
  },
});

function environment(t) {
  t.mock.method(globalThis, 'fetch', async () => assert.fail('daemon usage must not make provider HTTP requests'));
  const directory = mkdtempSync(join(tmpdir(), 'mixdog-remote-usage-'));
  const prior = {};
  for (const [key, value] of Object.entries({
    MIXDOG_MODEL_PROXY: 'client',
    MIXDOG_DATA_DIR: directory,
    MIXDOG_USAGE_LEDGER_PATH: join(directory, 'ledger.sqlite'),
  })) {
    prior[key] = process.env[key];
    process.env[key] = value;
  }
  t.after(async () => {
    await closeUsageLedgers();
    for (const [key, value] of Object.entries(prior)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(directory, { recursive: true, force: true });
  });
}

function desktop(t) {
  const channel = new ModelProxyChannel();
  const calls = [];
  const state = {
    config: { ready: true, providers: { [provider]: { enabled: true, modelProxy: { oauthUsage: true } } } },
    usage: ready(),
    result: { model: 'fixture-model', usage: { inputTokens: 10, outputTokens: 2 } },
    handle: null,
  };
  const attach = () => channel.attachPublisher(({ requests }) => {
    for (const { id } of requests) {
      const claimed = channel.claim(id);
      if (!claimed) continue;
      const call = JSON.parse(claimed.payload);
      calls.push(call);
      void Promise.resolve().then(async () => {
        try {
          const value = state.handle
            ? await state.handle(call)
            : call.method === 'providerConfig' ? state.config
              : call.method === 'oauthUsage' ? state.usage : state.result;
          channel.resolve(id, true, encodeModelProxyWire(value));
        } catch (error) {
          channel.resolve(id, false, null, encodeModelProxyWire(modelProxyErrorToWire(error)));
        }
      });
    }
  });
  let detach = attach();
  t.after(() => detach());
  t.after(installModelProxyChannel(channel));
  return {
    channel, calls, state,
    disconnect: () => detach(),
    reconnect: () => { detach(); detach = attach(); },
  };
}

test('real JSON usage transport preserves timestamps, strips secrets and deduplicates across durable reopen', async (t) => {
  environment(t);
  const f = desktop(t);
  assert.ok(MODEL_PROXY_METHODS.includes('oauthUsage'));
  f.state.usage.snapshot.raw = { access_token: 'SECRET' };
  f.state.usage.snapshot.quotaWindows[0].email = 'private@example.com';
  const first = await readRemoteOAuthUsage(provider, { channel: f.channel });
  assert.equal(first.status, 'ready');
  assert.equal(first.snapshot.cachedAt, observedAt);
  assert.equal(JSON.stringify(first).includes('SECRET'), false);
  assert.equal(JSON.stringify(first).includes('@'), false);
  const samples = () => getUsageLedger().db.prepare('SELECT ts,seen_until,used_pct FROM quota_samples').all();
  const original = samples();
  assert.equal(original.length, 1);
  assert.equal(original[0].ts, observedAt);
  await closeUsageLedgers();
  assert.equal((await readRemoteOAuthUsage(provider, { channel: f.channel })).status, 'ready');
  assert.deepEqual(samples(), original);
  f.state.usage = ready(accountA, observedAt + 60_000);
  await readRemoteOAuthUsage(provider, { channel: f.channel });
  assert.equal(samples()[0].seen_until, observedAt + 60_000);
});

test('normal and forced reads coalesce by generation/provider and force joins a pending measurement', async (t) => {
  environment(t);
  const f = desktop(t);
  const received = Promise.withResolvers();
  const release = Promise.withResolvers();
  f.state.handle = async (call) => {
    if (call.method === 'providerConfig') return f.state.config;
    received.resolve();
    await release.promise;
    return f.state.usage;
  };
  const first = readRemoteOAuthUsage(provider, { channel: f.channel });
  await received.promise;
  const forced = readRemoteOAuthUsage(provider, { channel: f.channel, force: true });
  assert.equal(first, forced);
  release.resolve();
  assert.equal((await forced).status, 'ready');
  assert.equal(f.calls.filter((call) => call.method === 'oauthUsage').length, 1);
  f.state.handle = null;
  await readRemoteOAuthUsage(provider, { channel: f.channel, force: true });
  assert.equal(f.calls.at(-1).force, true);
});

test('capability is fresh and ready legacy/disabled/missing clients never receive an unsupported RPC', async (t) => {
  environment(t);
  const f = desktop(t);
  // Seed the registry's ordinary cache with a newer client, then sign out.
  await loadModelProxyProviderConfig({ channel: f.channel });
  for (const [config, status] of [
    [{ [provider]: { enabled: true } }, 'unsupported-client'],
    [{ [provider]: { enabled: false, modelProxy: { oauthUsage: true } } }, 'not-configured'],
    [{}, 'not-configured'],
  ]) {
    f.state.config = { ready: true, providers: config };
    assert.equal((await readRemoteOAuthUsage(provider, { channel: f.channel })).status, status);
    assert.equal((await remoteQuotaScope({ channel: f.channel })).status, status);
  }
  assert.ok(f.calls.every((call) => call.method === 'providerConfig'));
  f.state.handle = () => { throw new Error('private config failure'); };
  assert.deepEqual(await readRemoteOAuthUsage(provider, { channel: f.channel }), { status: 'unavailable', accounts: [] });
  f.disconnect();
  const before = f.calls.length;
  assert.equal((await readRemoteOAuthUsage(provider, { channel: f.channel })).status, 'unavailable');
  assert.equal(f.calls.length, before);
});

test('disconnect retires late replies; reconnects neither join old work nor inherit capability', async (t) => {
  environment(t);
  const f = desktop(t);
  const received = Promise.withResolvers();
  const release = Promise.withResolvers();
  f.state.handle = async (call) => {
    if (call.method === 'providerConfig') return f.state.config;
    received.resolve();
    await release.promise;
    return ready();
  };
  const old = readRemoteOAuthUsage(provider, { channel: f.channel });
  await received.promise;
  f.reconnect();
  f.state.handle = null;
  f.state.config = { ready: true, providers: { [provider]: { enabled: true } } };
  assert.equal((await readRemoteOAuthUsage(provider, { channel: f.channel })).status, 'unsupported-client');
  release.resolve();
  assert.equal((await old).status, 'unavailable');
  assert.equal(getUsageLedger().db.prepare('SELECT COUNT(*) AS count FROM quota_samples').get().count, 0);
});

test('a submitted correctly scoped write may finish as history but never returns as current after disconnect', async (t) => {
  environment(t);
  const f = desktop(t);
  const ledger = getUsageLedger();
  const submitted = Promise.withResolvers();
  const release = Promise.withResolvers();
  const write = ledger.recordQuotaQueued.bind(ledger);
  t.mock.method(ledger, 'recordQuotaQueued', (samples) => {
    const saved = write(samples);
    submitted.resolve();
    return saved.then(() => release.promise);
  });
  const reading = readRemoteOAuthUsage(provider, { channel: f.channel });
  await submitted.promise;
  f.disconnect();
  release.resolve();
  assert.equal((await reading).status, 'unavailable');
  await ledger.settleWrites();
  assert.equal(ledger.db.prepare('SELECT account FROM quota_samples').get().account, accountA);
  assert.equal(await recordQuotaReadings(provider, accountB, ready(accountB).snapshot, () => {}, observedAt, () => false), false);
  assert.equal(ledger.db.prepare('SELECT COUNT(*) AS count FROM quota_samples').get().count, 1);
});

test('persistence failure cannot publish a ready reading or discard confirmed ownership', async (t) => {
  environment(t);
  const f = desktop(t);
  t.mock.method(getUsageLedger(), 'recordQuotaQueued', async () => { throw new Error('disk failure'); });
  const reply = await readRemoteOAuthUsage(provider, { channel: f.channel });
  assert.deepEqual(reply, { status: 'unavailable', accounts: [accountA, accountB], account: accountA });
  const scope = await remoteQuotaScope({ channel: f.channel });
  assert.equal(scope.status, 'unavailable');
  assert.deepEqual(scope.scopes, { [provider]: [accountA, accountB] });
  assert.deepEqual(scope.inUse, { [provider]: accountA });
});

test('history authorizes every current identity even when measurement fails, switches selection and excludes other clients/local data', async (t) => {
  environment(t);
  t.mock.method(Date, 'now', () => observedAt + 120_000);
  const f = desktop(t);
  const ledger = getUsageLedger();
  for (const [account, usedPct] of [[accountA, 10], [accountB, 20], [accountC, 30], ['default', 99]]) {
    ledger.recordQuota([{ provider, account, label: '5H', ts: observedAt, usedPct, resetAt: observedAt + 3_600_000 }]);
  }
  let localProbes = 0;
  const forbidden = () => { localProbes += 1; throw new Error('local account probe'); };
  const api = createUsageStatsApi({ accountPool: forbidden, accountEmails: forbidden, getSessionId: () => 'visible-session' });
  f.state.usage = { status: 'unavailable', accounts: [accountA, accountB], account: accountB };
  const history = await api.getQuotaHistory();
  assert.equal(history.desktopUsageStatus, 'unavailable');
  assert.equal(history.selection.account, accountB);
  assert.deepEqual(new Set(history.subscriptions.map((row) => row.account)), new Set([accountA, accountB]));
  assert.ok(history.subscriptions.every((row) => row.accountInRoster && !row.accountLabel && !row.accountEmail));
  assert.equal((await api.getQuotaHistory({ account: accountA, page: 0 })).selection.account, accountA);
  f.state.usage = { status: 'unsupported', accounts: [accountA, accountB], account: accountA };
  assert.equal((await api.getQuotaHistory()).desktopUsageStatus, 'unsupported');
  const session = await api.getSessionUsage({ sessionIds: ['agent-session'] });
  assert.equal(session.sessionId, 'visible-session');
  assert.equal(localProbes, 0);
  f.state.usage = ready(accountB);
  assert.equal((await api.getQuotaHistory()).selection.account, accountB);
  f.state.usage = { status: 'unavailable', accounts: [accountC], account: accountC };
  const switched = await api.getQuotaHistory({ account: accountA });
  assert.deepEqual(switched.subscriptions.map((row) => row.account), [accountC]);
  assert.equal(switched.selection.account, accountC);
});

test('history publication is generation checked after its ledger query', async (t) => {
  environment(t);
  const f = desktop(t);
  const ledger = getUsageLedger();
  const query = ledger.quotaHistoryAsync.bind(ledger);
  t.mock.method(ledger, 'quotaHistoryAsync', async (options) => {
    const result = await query(options);
    f.reconnect();
    return result;
  });
  const history = await createUsageStatsApi().getQuotaHistory();
  assert.equal(history.desktopUsageStatus, 'unavailable');
  assert.equal(history.selection, null);
  assert.deepEqual(history.subscriptions, []);
});

test('send attribution trusts only a successful PC proof, never selected defaults or failure/partial stamps', async (t) => {
  environment(t);
  const f = desktop(t);
  const proxy = new ModelProxyProvider(provider, { modelProxy: { consumesReadWindows: true } }, f.channel);
  assert.equal(proxy.consumesReadWindows, true);
  const run = (sessionId) => accountProviderSend(
    provider, proxy, () => proxy.send([], 'fixture-model', [], { sessionId }), 'fixture-model', { sessionId }
  );
  f.state.result.modelProxyUsageAccount = accountB;
  await run('proven');
  f.state.result.modelProxyUsageAccount = 'default';
  await run('unproven');
  delete f.state.result.modelProxyUsageAccount;
  await run('missing-proof');
  f.state.handle = () => {
    throw Object.assign(new Error('failed'), {
      usage: { inputTokens: 3, outputTokens: 1 },
      modelProxyUsageAccount: accountA,
    });
  };
  await assert.rejects(run('failed-proof'), /failed/);
  f.state.handle = () => {
    throw Object.assign(new Error('partial'), {
      partialUsage: { inputTokens: 3, outputTokens: 1 },
      modelProxyUsageAccount: accountA,
    });
  };
  await assert.rejects(run('partial-proof'), /partial/);
  await accountProviderSend(provider, proxy, async () => {
    noteAbandonedUsage({ inputTokens: 3, outputTokens: 1 }, 'abandoned-model');
    return { model: 'fixture-model', modelProxyUsageAccount: accountA, usage: { inputTokens: 1, outputTokens: 1 } };
  }, 'fixture-model', { sessionId: 'abandoned' });
  const rows = getUsageLedger().db.prepare(`
    SELECT s.value AS session, json_extract(r.signature,'$[8]') AS account, json_extract(r.signature,'$[1]') AS model
    FROM usage_events e JOIN usage_routes r ON r.id=e.route JOIN usage_sessions s ON s.id=e.session
  `).all();
  assert.equal(rows.find((row) => row.session === 'proven').account, accountB);
  for (const session of ['unproven', 'missing-proof', 'failed-proof', 'partial-proof'])
    assert.equal(rows.find((row) => row.session === session).account, 'proxy-unattributed', session);
  assert.equal(rows.find((row) => row.model === 'abandoned-model').account, 'proxy-unattributed');
  assert.equal(rows.find((row) => row.session === 'abandoned' && row.model === 'fixture-model').account, accountA);
});
