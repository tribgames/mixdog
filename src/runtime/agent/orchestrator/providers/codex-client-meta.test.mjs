import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { CODEX_CLIENT_VERSION_FLOOR } from './codex-client-meta.mjs';

// A version `n` minors above the shipped floor, which every release raises.
const ahead = (n) => {
  const [major, minor] = CODEX_CLIENT_VERSION_FLOOR.split('.').map(Number);
  return `${major}.${minor + n}.0`;
};

const realFetch = globalThis.fetch;
let nonce = 0;
let respond;

async function fresh(fetchImpl) {
  delete process.env.MIXDOG_DISABLE_LIVE_CLI_VERSIONS;
  for (const key of ['MIXDOG_CODEX_VERSION', 'MIXDOG_CODEX_USER_AGENT', 'MIXDOG_CODEX_ORIGINATOR']) {
    delete process.env[key];
  }
  // Each case starts with no remembered version and never touches the operator's.
  process.env.MIXDOG_DATA_DIR = mkdtempSync(join(tmpdir(), 'mixdog-codex-version-'));
  respond = fetchImpl;
  const calls = [];
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    return respond();
  };
  return { mod: await import(`./codex-client-meta.mjs?n=${++nonce}`), calls };
}

const registry = (version) => async () => ({ ok: true, json: async () => ({ version }) });
const offline = async () => {
  throw new Error('offline');
};

test.afterEach(() => {
  globalThis.fetch = realFetch;
});

test('the live Codex CLI version is reported after one shared lookup', async () => {
  const { mod, calls } = await fresh(registry(ahead(1)));
  const warmed = await Promise.all([mod.warmCodexClientVersion(), mod.warmCodexClientVersion()]);
  assert.deepEqual(warmed, [ahead(1), ahead(1)]);
  assert.equal(mod.codexVersionHeader(), ahead(1));
  assert.match(mod.codexUserAgent(), new RegExp(`^codex_cli_rs/${ahead(1).replaceAll('.', '\\.')} `));
  assert.deepEqual(calls, ['https://registry.npmjs.org/@openai/codex/latest']);
});

test('an offline lookup or an older published version reports the floor', async () => {
  for (const fetchImpl of [offline, registry('0.1.0')]) {
    const { mod } = await fresh(fetchImpl);
    assert.equal(await mod.warmCodexClientVersion(), CODEX_CLIENT_VERSION_FLOOR);
    assert.equal(mod.codexVersionHeader(), CODEX_CLIENT_VERSION_FLOOR);
  }
});

test('a failed lookup is retried within minutes instead of pinning the floor for a day', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const { mod, calls } = await fresh(offline);
  assert.equal(await mod.warmCodexClientVersion(), CODEX_CLIENT_VERSION_FLOOR);

  respond = registry(ahead(1));
  t.mock.timers.tick(10 * 60_000 + 1);
  assert.equal(await mod.warmCodexClientVersion(), ahead(1));
  assert.equal(calls.length, 2);
});
