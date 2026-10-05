import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const realFetch = globalThis.fetch;
const ENV_KEYS = ['MIXDOG_GROK_CLIENT_VERSION', 'MIXDOG_DISABLE_LIVE_CLI_VERSIONS'];
let nonce = 0;

async function fresh(fetchImpl, env = {}) {
  for (const k of ENV_KEYS) delete process.env[k];
  // Each case starts with no remembered version and never touches the operator's.
  process.env.MIXDOG_DATA_DIR = mkdtempSync(join(tmpdir(), 'mixdog-client-version-'));
  Object.assign(process.env, env);
  const calls = [];
  globalThis.fetch = async (url, opts) => {
    calls.push(String(url));
    return fetchImpl(url, opts);
  };
  const mod = await import(`./grok-client-version.mjs?n=${++nonce}`);
  return { mod, calls };
}

const registry = (version) => async () => ({ ok: true, json: async () => ({ version }) });

test.afterEach(() => {
  globalThis.fetch = realFetch;
  for (const k of ENV_KEYS) delete process.env[k];
});

test('live npm version is used after warm-up and deduped', async () => {
  const { mod, calls } = await fresh(registry('1.1.44'));
  await Promise.all([mod.warmGrokCliVersion(), mod.warmGrokCliVersion()]);
  await mod.warmGrokCliVersion();
  assert.equal(mod.grokCliVersion(), '1.1.44');
  assert.deepEqual(calls, ['https://registry.npmjs.org/@xai-official/grok/latest']);
  assert.deepEqual(mod.grokClientVersionHeaders(), {
    'x-grok-client-version': '1.1.44',
    'User-Agent': 'xai-grok-build/1.1.44',
  });
});

test('env override wins and skips the registry', async () => {
  const { mod, calls } = await fresh(registry('1.1.44'), { MIXDOG_GROK_CLIENT_VERSION: '9.9.9' });
  await mod.warmGrokCliVersion();
  assert.equal(mod.grokCliVersion(), '9.9.9');
  assert.equal(calls.length, 0);
});

test('fetch failure falls back to the floor', async () => {
  const { mod } = await fresh(async () => {
    throw new Error('offline');
  });
  await mod.warmGrokCliVersion();
  assert.equal(mod.grokCliVersion(), mod.GROK_CLI_VERSION_FLOOR);
});

test('a live version below the floor never lowers the version', async () => {
  const { mod } = await fresh(registry('0.0.1'));
  await mod.warmGrokCliVersion();
  assert.equal(mod.grokCliVersion(), mod.GROK_CLI_VERSION_FLOOR);
});

test('426 minimum is learned once and only upward', async () => {
  const { mod } = await fresh(registry('not-a-version'));
  await mod.warmGrokCliVersion();
  assert.equal(mod.learnGrokRequiredVersion('client outdated'), false);
  assert.equal(mod.learnGrokRequiredVersion('426: minimum version 3.0.0 required'), true);
  assert.equal(mod.grokCliVersion(), '3.0.0');
  assert.equal(mod.learnGrokRequiredVersion('minimum version 2.0.0'), false);
});

test('oauth-usage sends the same version headers as the proxy', async () => {
  await fresh(registry('1.1.44'));
  const seen = [];
  globalThis.fetch = async (url, opts) => {
    if (String(url).includes('registry.npmjs.org')) return registry('1.1.44')();
    seen.push(opts.headers);
    return { ok: false, status: 404, json: async () => ({}) };
  };
  // Same module instance oauth-usage imports (no query string).
  const shared = await import('./grok-client-version.mjs');
  const usage = await import('./oauth-usage.mjs');
  const provider = { ensureAuth: async () => ({ access_token: 't', user_id: 'u' }) };
  await usage.fetchOAuthUsageSnapshot({ provider: 'grok-oauth', accountId: 'default' }, provider, () => {}, {
    force: true,
  });
  const expected = shared.grokClientVersionHeaders();
  assert.equal(expected['x-grok-client-version'], '1.1.44');
  const billing = seen.find((h) => h['x-grok-client-version']);
  assert.ok(billing, 'billing probe sent version headers');
  assert.equal(billing['x-grok-client-version'], expected['x-grok-client-version']);
  assert.equal(billing['User-Agent'], expected['User-Agent']);
});

test('the last live version outlives the process and an offline start', async () => {
  const first = await fresh(registry('1.2.0'));
  await first.mod.warmGrokCliVersion();
  const dataDir = process.env.MIXDOG_DATA_DIR;
  const offline = async () => {
    throw new Error('offline');
  };
  const second = await fresh(offline);
  process.env.MIXDOG_DATA_DIR = dataDir;
  // Answered from disk before any refresh lands, and kept when the refresh fails.
  assert.equal(second.mod.grokCliVersion(), '1.2.0');
  await second.mod.warmGrokCliVersion();
  assert.equal(second.mod.grokCliVersion(), '1.2.0');
});
