import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { DEFAULT_CLI_VERSION } from './anthropic-oauth-client-version.mjs';

// Keep the floor/learned tests offline; the live-version test opts back in.
process.env.MIXDOG_DISABLE_LIVE_CLI_VERSIONS = '1';

// Versions `n` patches above the shipped floor, which every release raises.
const above = (n) => {
  const [major, minor, patch] = DEFAULT_CLI_VERSION.split('.').map(Number);
  return `${major}.${minor}.${patch + n}`;
};
const gate = (current, required) =>
  `Claude Code ${current} does not support this model; version ${required} or newer is required.`;

test('effective Claude CLI version is max(floor, learned, live npm)', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'mixdog-anthropic-cli-live-'));
  const saved = { ...process.env };
  const realFetch = globalThis.fetch;
  try {
    process.env.MIXDOG_DATA_DIR = dataDir;
    delete process.env.MIXDOG_CLI_VERSION;
    delete process.env.MIXDOG_DISABLE_LIVE_CLI_VERSIONS;
    const calls = [];
    let live = above(620);
    globalThis.fetch = async (url) => {
      calls.push(String(url));
      if (live === null) throw new Error('offline');
      return { ok: true, json: async () => ({ version: live }) };
    };
    const nonce = `${process.pid}-${Date.now()}`;
    let mod = await import(`./anthropic-oauth-client-version.mjs?live=${nonce}`);
    await Promise.all([mod.warmCliVersion(), mod.warmCliVersion()]);
    assert.equal(mod.resolveCliVersion(), above(620));
    assert.deepEqual(calls, ['https://registry.npmjs.org/@anthropic-ai/claude-code/latest']);
    assert.ok(mod.claudeCliUserAgent().startsWith(`claude-cli/${above(620)} `));

    mod.learnRequiredCliVersion(gate('2.1.251', above(670)));
    assert.equal(mod.resolveCliVersion(), above(670));

    process.env.MIXDOG_CLI_VERSION = '7.7.7';
    assert.equal(mod.resolveCliVersion(), '7.7.7');
    delete process.env.MIXDOG_CLI_VERSION;

    live = null;
    mod = await import(`./anthropic-oauth-client-version.mjs?offline=${nonce}`);
    await mod.warmCliVersion();
    assert.equal(mod.resolveCliVersion(), above(670));
  } finally {
    globalThis.fetch = realFetch;
    for (const k of ['MIXDOG_DATA_DIR', 'MIXDOG_CLI_VERSION', 'MIXDOG_DISABLE_LIVE_CLI_VERSIONS'])
      restoreEnv(k, saved[k]);
    await rm(dataDir, { recursive: true, force: true });
  }
});

function restoreEnv(name, value) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

test('Claude CLI compatibility floors validate, persist, and never downgrade', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'mixdog-anthropic-cli-version-'));
  const previousDataDir = process.env.MIXDOG_DATA_DIR;
  const previousOverride = process.env.MIXDOG_CLI_VERSION;
  try {
    process.env.MIXDOG_DATA_DIR = dataDir;
    delete process.env.MIXDOG_CLI_VERSION;
    const nonce = `${process.pid}-${Date.now()}`;
    const versions = await import(`./anthropic-oauth-client-version.mjs?floor=${nonce}`);

    assert.equal(versions.resolveCliVersion(), DEFAULT_CLI_VERSION);
    assert.equal(versions.learnRequiredCliVersion('generic invalid request'), null);

    const learned = versions.learnRequiredCliVersion(gate('2.1.251', above(20)));
    assert.deepEqual(learned, {
      requiredVersion: above(20),
      activeVersion: above(20),
      updated: true,
      retryable: true,
    });
    assert.equal(versions.resolveCliVersion(), above(20));

    const persisted = JSON.parse(await readFile(join(dataDir, 'anthropic-oauth-cli-version.json'), 'utf-8'));
    assert.equal(persisted.cliVersion, above(20));

    const reloaded = await import(`./anthropic-oauth-client-version.mjs?reload=${nonce}`);
    assert.equal(reloaded.resolveCliVersion(), above(20));

    await writeFile(
      join(dataDir, 'anthropic-oauth-cli-version.json'),
      JSON.stringify({ version: 1, cliVersion: above(220), updatedAt: Date.now() })
    );
    const concurrentRaise = versions.learnRequiredCliVersion(gate(above(20), above(120)));
    assert.equal(concurrentRaise.activeVersion, above(220));

    process.env.MIXDOG_CLI_VERSION = '9.9.9';
    const overridden = reloaded.learnRequiredCliVersion(gate(above(220), above(320)));
    assert.equal(overridden.retryable, false);
    assert.equal(reloaded.resolveCliVersion(), '9.9.9');

    delete process.env.MIXDOG_CLI_VERSION;
    assert.equal(reloaded.resolveCliVersion(), above(320));
    const downgrade = reloaded.learnRequiredCliVersion(gate(above(320), '2.1.251'));
    assert.equal(downgrade.updated, false);
    assert.equal(reloaded.resolveCliVersion(), above(320));
  } finally {
    restoreEnv('MIXDOG_DATA_DIR', previousDataDir);
    restoreEnv('MIXDOG_CLI_VERSION', previousOverride);
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('Anthropic OAuth retries the exact version gate once and leaves generic 400s terminal', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'mixdog-anthropic-cli-retry-'));
  const previousDataDir = process.env.MIXDOG_DATA_DIR;
  const previousOverride = process.env.MIXDOG_CLI_VERSION;
  const previousProxy = process.env.HTTPS_PROXY;
  try {
    process.env.MIXDOG_DATA_DIR = dataDir;
    process.env.HTTPS_PROXY = 'http://127.0.0.1:1';
    delete process.env.MIXDOG_CLI_VERSION;
    const nonce = `${process.pid}-${Date.now()}`;
    const { AnthropicOAuthProvider } = await import(`./anthropic-oauth.mjs?retry=${nonce}`);
    const { resolveCliVersion } = await import('./anthropic-oauth-client-version.mjs');

    const provider = Object.create(AnthropicOAuthProvider.prototype);
    provider.config = {};
    provider.fastModeBetaHeaderLatched = false;
    provider.ensureAuth = async () => ({ accessToken: 'test-access-token' });
    provider.scrubTokens = (text) => String(text || '');
    provider._refreshModelCache = async () => [];

    const requestVersions = [];
    const response = (status, text = '') => ({
      status,
      ok: status >= 200 && status < 300,
      headers: new Headers(),
      text: async () => text,
    });
    const requestResult = (status, text = '') => {
      const controller = new AbortController();
      return {
        response: response(status, text),
        controller,
        cancelHandler: null,
      };
    };
    const parseSuccess = async (...args) => {
      args[5].sawMessageStart = true;
      return {
        content: 'ok',
        model: 'claude-fable-5-1',
        toolCalls: [],
        usage: { inputTokens: 1, outputTokens: 1 },
      };
    };

    const result = await provider.send([{ role: 'user', content: 'hello' }], 'claude-fable-5-1', [], {
      _doRequestFn: async () => {
        requestVersions.push(resolveCliVersion());
        if (requestVersions.length === 1) {
          return requestResult(400, gate('2.1.251', above(120)));
        }
        return requestResult(200);
      },
      _parseSSEFn: parseSuccess,
    });
    assert.equal(result.content, 'ok');
    assert.deepEqual(requestVersions, [DEFAULT_CLI_VERSION, above(120)]);

    let genericAttempts = 0;
    await assert.rejects(
      provider.send([{ role: 'user', content: 'hello again' }], 'claude-fable-5-1', [], {
        _doRequestFn: async () => {
          genericAttempts += 1;
          return requestResult(400, 'generic invalid request');
        },
        _parseSSEFn: parseSuccess,
      }),
      /generic invalid request/
    );
    assert.equal(genericAttempts, 1);
  } finally {
    restoreEnv('MIXDOG_DATA_DIR', previousDataDir);
    restoreEnv('MIXDOG_CLI_VERSION', previousOverride);
    restoreEnv('HTTPS_PROXY', previousProxy);
    await rm(dataDir, { recursive: true, force: true });
  }
});
