import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

test('real settings writes preserve peer settings, explicit provider OFF, and the rest of the config', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mixdog-settings-concurrency-'));
  const source = String.raw`
    import assert from 'node:assert/strict';
    import { resolve } from 'node:path';
    import * as cfgMod from './src/runtime/agent/orchestrator/config.mjs';
    import * as sharedCfgMod from './src/runtime/shared/config.mjs';
    import { createConfigLifecycle } from './src/session-runtime/config-lifecycle.mjs';
    import { createSettingsApi } from './src/session-runtime/settings-api.mjs';

    function runtime() {
      let config = cfgMod.loadConfig({ secrets: false });
      let secrets = false;
      let webSearchRoute = null;
      const lifecycle = createConfigLifecycle({
        getConfig: () => config,
        setConfig: next => { config = next; },
        getConfigHasSecrets: () => secrets,
        setConfigHasSecrets: next => { secrets = next; },
        getWebSearchRoute: () => webSearchRoute,
        setWebSearchRoute: next => { webSearchRoute = next; },
        getRoute: () => ({ provider: 'openai' }),
        cfgMod, sharedCfgMod,
        setConfiguredShell() {},
        normalizeSystemShellConfig: value => ({ command: value?.command || '' }),
        normalizeWebSearchRouteConfig: value => value || null,
        LAZY_SECRET_PROVIDERS: new Set(),
        clean: value => String(value || '').trim(),
        resolve,
        STANDALONE_DATA_DIR: process.env.MIXDOG_DATA_DIR,
      });
      const api = createSettingsApi({
        getConfig: () => config,
        cfgMod,
        hasOwn: Object.hasOwn,
        saveConfigAndAdopt: lifecycle.saveConfigAndAdopt,
        adoptConfig: lifecycle.adoptConfig,
        scheduleSkillsSave: lifecycle.scheduleSkillsSave,
      });
      return { api, lifecycle, config: () => config };
    }

    await sharedCfgMod.updateConfigAsync(() => ({
      agent: {
        profile: { title: 'Initial', language: 'ko' },
        compaction: { auto: true },
        autoClear: { enabled: true },
        skills: { disabled: [] },
        builtins: {},
      },
      desktop: { keepAwake: false },
      outputStyle: 'simple',
      memory: { embedding: { dtype: 'q8' } },
    }));
    const read = () => sharedCfgMod.readConfig();
    const a = runtime();
    const b = runtime();
    a.api.setProfile({ language: 'en' });
    await a.lifecycle.flushAllConfigSavesAsync({ requireSaved: true });
    b.api.setProfile({ title: 'Updated by B' });
    await b.lifecycle.flushAllConfigSavesAsync({ requireSaved: true });
    assert.equal(read().agent.profile.language, 'en');
    assert.equal(read().agent.profile.title, 'Updated by B');

    const c = runtime();
    await sharedCfgMod.updateConfigAsync(root => ({
      ...root,
      agent: {
        ...root.agent,
        compaction: { ...root.agent.compaction, auto: false },
        autoClear: { ...root.agent.autoClear, enabled: false },
      },
    }));
    await cfgMod.patchSkillsDisabledAsync(['browser-use']);
    c.api.setProfile({ title: 'Unrelated profile edit' });
    await c.lifecycle.flushAllConfigSavesAsync({ requireSaved: true });
    assert.equal(read().agent.compaction.auto, false);
    assert.equal(read().agent.autoClear.enabled, false);
    assert.deepEqual(read().agent.skills.disabled, ['browser-use']);

    const d = runtime();
    const e = runtime();
    d.api.setProfile({ language: 'ja' });
    e.api.setProfile({ title: 'Concurrent title' });
    await Promise.all([
      d.lifecycle.flushAllConfigSavesAsync({ requireSaved: true }),
      e.lifecycle.flushAllConfigSavesAsync({ requireSaved: true }),
    ]);
    assert.equal(read().agent.profile.language, 'ja');
    assert.equal(read().agent.profile.title, 'Concurrent title');

    // A deleted nested setting must stay deleted without touching its siblings.
    const before = cfgMod.loadConfig({ secrets: false });
    const withShell = { ...before, shell: { command: 'pwsh', args: ['-NoProfile'] } };
    await cfgMod.saveConfigAsync(withShell, { baseConfig: before });
    const shellBaseline = cfgMod.loadConfig({ secrets: false });
    await sharedCfgMod.updateConfigAsync(root => ({
      ...root, agent: { ...root.agent, shell: { ...root.agent.shell, extra: 'peer' } },
    }));
    const cleared = { ...shellBaseline, shell: { args: [] } };
    await cfgMod.saveConfigAsync(cleared, { baseConfig: shellBaseline });
    assert.deepEqual(read().agent.shell, { args: [], extra: 'peer' });

    // Compare aliases after normalization, and never treat keychain overlays as edits.
    assert.deepEqual(cfgMod.createConfigPatch(
      { autoClear: { thresholdMs: 90000 }, compaction: { enabled: false }, providers: { openai: { enabled: true, apiKey: 'old' } } },
      { autoClear: { idleMs: 90000 }, compaction: { auto: false }, providers: { openai: { enabled: true, apiKey: 'new' } } }
    ), []);

    // A synchronous provider edit also rebases on its supplied baseline.
    const providerBaseline = cfgMod.loadConfig();
    assert.equal(providerBaseline.providers.openai.enabled, true);
    await sharedCfgMod.updateConfigAsync(root => ({
      ...root, agent: { ...root.agent, profile: { ...root.agent.profile, language: 'ko' } },
    }));
    cfgMod.saveConfig({
      ...providerBaseline,
      providers: { ...providerBaseline.providers, openai: { ...providerBaseline.providers.openai, enabled: false } },
    }, { baseConfig: providerBaseline });
    assert.equal(read().agent.profile.language, 'ko');
    assert.equal(read().agent.providers.openai.enabled, false);
    const full = cfgMod.loadConfig();
    assert.equal(full.providers.openai.enabled, false);
    assert.equal(typeof full.providers.openai.apiKey, 'string');
    await cfgMod.saveConfigAsync({ ...full, profile: { ...full.profile, title: 'After secrets load' } });
    assert.equal(read().agent.providers.openai.enabled, false);
    assert.equal(Object.hasOwn(read().agent.providers.openai, 'apiKey'), false);

    assert.deepEqual(read().desktop, { keepAwake: false });
    assert.equal(read().outputStyle, 'simple');
    assert.deepEqual(read().memory, { embedding: { dtype: 'q8' } });
  `;
  try {
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', source], {
      cwd: fileURLToPath(new URL('../../', import.meta.url)),
      env: {
        ...process.env,
        MIXDOG_HOME: dir,
        MIXDOG_DATA_DIR: join(dir, 'data'),
        MIXDOG_USER_DATA_BACKUP_ROOT: join(dir, 'backups'),
        MIXDOG_CONFIG_READ_TTL_MS: '0',
        ...Object.fromEntries(
          [
            'OPENAI_API_KEY',
            'ANTHROPIC_API_KEY',
            'GEMINI_API_KEY',
            'DEEPSEEK_API_KEY',
            'XAI_API_KEY',
            'OPENCODE_API_KEY',
            'OPENROUTER_API_KEY',
          ].map((key) => [key, 'fixture-key-not-a-real-credential'])
        ),
      },
      encoding: 'utf8',
      timeout: 30_000,
    });
    assert.equal(result.error, undefined, result.error?.message);
    assert.equal(result.status, 0, result.stderr || result.stdout);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
