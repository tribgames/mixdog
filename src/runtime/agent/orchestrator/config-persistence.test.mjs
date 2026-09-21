import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');

function runIsolatedConfigTest(prefix, source) {
  const dataDir = mkdtempSync(join(tmpdir(), prefix));
  try {
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', source], {
      cwd: repoRoot,
      env: {
        ...process.env,
        MIXDOG_DATA_DIR: dataDir,
        MIXDOG_CONFIG_READ_TTL_MS: '0',
        MIXDOG_USER_DATA_BACKUP_ROOT: join(dataDir, 'backups'),
      },
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
}

test('sync and async config writes preserve user fields without persisting secrets or probe failures', () => {
  runIsolatedConfigTest(
    'mixdog-config-persistence-',
    `
    import assert from 'node:assert/strict';
    import { readFileSync, writeFileSync } from 'node:fs';
    import { join } from 'node:path';
    import {
      loadConfig, saveConfig, saveConfigAsync, patchSkillsDisabled, patchSkillsDisabledAsync,
    } from './src/runtime/agent/orchestrator/config.mjs';

    const path = join(process.env.MIXDOG_DATA_DIR, 'mixdog-config.json');
    const read = () => JSON.parse(readFileSync(path, 'utf8')).agent;
    for (const save of [saveConfig, saveConfigAsync]) {
      const config = {
        providers: {
          openai: { enabled: true, apiKey: 'never-persist-this-key', baseURL: 'https://example.test', customTransport: { mode: 'sse' } },
          xai: { enabled: false },
          'anthropic-oauth': { enabled: false, credentialProbeUnavailable: true, websocket: false },
        },
        modelSettings: { 'openai/test-model': { contextPercent: 70, custom: true } },
        profile: { title: '재영님', language: 'ko', experienceLevel: 'vibe-coder' },
        skills: { disabled: ['alpha'] },
        disabledAgents: ['reviewer'],
        extensionScopes: {},
        autoClear: { enabled: false, idleMs: 90000, minContextPercent: 25 },
        compaction: { auto: false, summaryModel: 'summary-test', memoryTimeoutMs: 1000 },
        shell: { command: 'pwsh', args: ['-NoProfile'] },
        modules: { webSearch: { enabled: false } },
      };
      // The unmanaged field exists only in the in-lock baseline, not the snapshot.
      writeFileSync(path, JSON.stringify({ agent: { unmanaged: { revision: 7 } } }));
      await save(config);
      const persisted = read();
      assert.deepEqual(persisted.providers, {
        openai: { enabled: true, baseURL: 'https://example.test', customTransport: { mode: 'sse' } },
        xai: { enabled: false },
        'anthropic-oauth': { websocket: false },
      });
      assert.equal(readFileSync(path, 'utf8').includes('never-persist-this-key'), false);
      assert.deepEqual(persisted.unmanaged, { revision: 7 });
      assert.deepEqual(persisted.modelSettings, config.modelSettings);
      assert.deepEqual(persisted.profile, config.profile);
      assert.deepEqual(persisted.disabledAgents, ['reviewer']);
      for (const field of ['skills', 'autoClear', 'compaction', 'shell', 'modules']) {
        assert.deepEqual(persisted[field], config[field]);
      }
      assert.equal(Object.hasOwn(persisted, 'extensionScopes'), false);
      const loaded = loadConfig({ secrets: false });
      assert.equal(loaded.providers.xai.enabled, false);
      assert.deepEqual(loaded.profile, config.profile);
      assert.deepEqual(loaded.disabledAgents, ['reviewer']);
      for (const field of ['skills', 'autoClear', 'compaction', 'shell', 'modules']) {
        assert.deepEqual(loaded[field], config[field]);
      }

      // Re-enabling clears disabledAgents from disk
      await save({ ...config, disabledAgents: [] });
      assert.equal(Object.hasOwn(read(), 'disabledAgents'), false);
      assert.equal(Object.hasOwn(loadConfig({ secrets: false }), 'disabledAgents'), false);
    }

    for (const patch of [patchSkillsDisabled, patchSkillsDisabledAsync]) {
      const before = read();
      // An inert old nested section must not redirect a canonical field patch.
      const nested = { providers: { stale: {} }, skills: { disabled: ['untouched'] } };
      writeFileSync(path, JSON.stringify({ agent: { ...before, agent: nested } }));
      assert.deepEqual(await patch([' zeta ', 'alpha', 'zeta']), { disabled: ['alpha', 'zeta'] });
      assert.deepEqual(read(), { ...before, agent: nested, skills: { disabled: ['alpha', 'zeta'] } });
    }

    const nested = { providers: { stale: {} }, mcpServers: { preserve: { command: 'nested' } } };
    writeFileSync(path, JSON.stringify({ agent: {
      agent: nested,
      mcpServers: {
        mixdog: { command: 'self' },
        'trib-plugin': { command: 'self' },
        keep: { command: 'other' },
      },
    } }));
    const sanitized = loadConfig({ secrets: false });
    assert.deepEqual(sanitized.mcpServers, { keep: { command: 'other' } });
    assert.deepEqual(read().mcpServers, sanitized.mcpServers);
    assert.deepEqual(read().agent, nested);
  `
  );
});

test('read-time canonicalization cannot restore settings removed by a newer writer', () => {
  runIsolatedConfigTest(
    'mixdog-config-rebase-',
    `
    import assert from 'node:assert/strict';
    import fs from 'node:fs';
    import { syncBuiltinESMExports } from 'node:module';
    import { join } from 'node:path';
    import { loadConfig } from './src/runtime/agent/orchestrator/config.mjs';
    const path = join(process.env.MIXDOG_DATA_DIR, 'mixdog-config.json');
    fs.writeFileSync(path, JSON.stringify({
      agent: {
        autoClear: { enabled: false, thresholdMs: 90000 },
        compaction: { enabled: false },
        shell: { command: 'pwsh' },
        recap: { enabled: false },
        profile: { title: 'Old title', language: 'ko' },
      },
    }));
    const current = { agent: { profile: { title: '', language: 'en' } } };
    const read = fs.readFileSync;
    let replaced = false;
    fs.readFileSync = (target, ...args) => {
      const result = read(target, ...args);
      if (target === path && !replaced) {
        replaced = true;
        fs.writeFileSync(path, JSON.stringify(current));
      }
      return result;
    };
    syncBuiltinESMExports();
    loadConfig({ secrets: false });
    assert.equal(replaced, true);
    const saved = JSON.parse(read(path, 'utf8')).agent;
    for (const field of ['autoClear', 'compaction', 'shell', 'recap']) {
      assert.equal(Object.hasOwn(saved, field), false, field + ' was restored from a stale read');
    }
    assert.equal(saved.profile.title, '');
    assert.equal(saved.profile.language, 'en');
  `
  );
});

test('saving a secrets-less snapshot keeps a signed-in OAuth provider usable', () => {
  runIsolatedConfigTest(
    'mixdog-config-oauth-probe-',
    `
    import assert from 'node:assert/strict';
    import { readFileSync, writeFileSync } from 'node:fs';
    import { join } from 'node:path';
    import { loadConfig, saveConfig } from './src/runtime/agent/orchestrator/config.mjs';

    const dataDir = process.env.MIXDOG_DATA_DIR;
    const path = join(dataDir, 'mixdog-config.json');
    const read = () => JSON.parse(readFileSync(path, 'utf8')).agent;
    writeFileSync(join(dataDir, 'anthropic-oauth-credentials.json'), JSON.stringify({
      claudeAiOauth: {
        accessToken: 'access-token',
        refreshToken: 'refresh-token',
        expiresAt: Date.now() + 3600000,
        scopes: ['user:inference'],
      },
    }));

    // The stored config carries no Anthropic OAuth entry, so its enabled state
    // is derived from the credential probe on every load. A save of a snapshot
    // that never probed must not turn that into a stored disable.
    writeFileSync(path, JSON.stringify({ agent: { profile: { title: 'tester', language: 'ko' } } }));
    saveConfig(loadConfig({ secrets: false }));
    assert.equal(Object.hasOwn(read().providers || {}, 'anthropic-oauth'), false);
    assert.equal(loadConfig().providers['anthropic-oauth'].enabled, true);

    // A stored disable is the user's own decision and still survives the same
    // secrets-less save, credentials present or not.
    writeFileSync(path, JSON.stringify({ agent: { providers: { 'anthropic-oauth': { enabled: false } } } }));
    saveConfig(loadConfig({ secrets: false }));
    assert.deepEqual(read().providers['anthropic-oauth'], { enabled: false });
    assert.equal(loadConfig().providers['anthropic-oauth'].enabled, false);
  `
  );
});

test('preset lookup and maintenance normalization preserve storage boundaries', () => {
  runIsolatedConfigTest(
    'mixdog-config-normalization-',
    `
    import assert from 'node:assert/strict';
    import { getPreset, listPresets } from './src/runtime/agent/orchestrator/config-presets.mjs';
    import { normalizeMaintenanceRoutes } from './src/runtime/agent/orchestrator/config-storage.mjs';

    const named = { id: 'first', name: 'First' };
    const nameOnly = { name: 'Name only' };
    const config = { presets: [null, named, nameOnly] };
    assert.equal(listPresets(config), config.presets);
    for (const key of ['first', 1, '01']) assert.equal(getPreset(config, key), named);
    assert.equal(getPreset(config, 'Name only'), nameOnly);
    for (const key of [null, '', 0, -1, 'First', 'missing']) assert.equal(getPreset(config, key), null);
    for (const value of [null, {}, { presets: {} }]) {
      assert.deepEqual(listPresets(value), []);
      assert.equal(getPreset(value, 'first'), null);
    }

    assert.deepEqual(normalizeMaintenanceRoutes({
      aliased: { provider: ' openai-api ', model: ' gpt-test ', effort: ' high ', fast: true, ignored: 'x' },
      ordinary: { provider: 'anthropic', model: 'haiku', effort: ' ', fast: 1 },
      noProvider: { model: 'haiku' },
      noModel: { provider: 'openai' },
      nil: null,
      flag: true,
      list: [{ provider: 'openai', model: 'gpt-test' }],
    }), {
      aliased: { provider: 'openai', model: 'gpt-test', effort: 'high', fast: true },
      ordinary: { provider: 'anthropic', model: 'haiku' },
    });
    assert.deepEqual(normalizeMaintenanceRoutes(null), {});
    assert.deepEqual(normalizeMaintenanceRoutes([{ provider: 'gemini-api', model: 'gemini-test' }]), {
      0: { provider: 'gemini', model: 'gemini-test' },
    });
    const failure = new Error('provider fixture failure');
    assert.throws(
      () => normalizeMaintenanceRoutes({ broken: { get provider() { throw failure; } } }),
      (error) => error === failure
    );
  `
  );
});
