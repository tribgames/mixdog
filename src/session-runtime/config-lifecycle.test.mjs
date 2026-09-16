import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { setImmediate, setTimeout } from 'node:timers/promises';
import test from 'node:test';
import { createConfigLifecycle, resolveInitialConfigState } from './config-lifecycle.mjs';

function deferred() {
  let resolve;
  const promise = new Promise((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}

function fixture() {
  let current = { builtins: {}, providers: { demo: { enabled: true } }, skills: { disabled: [] }, theme: 'old' };
  let root = { agent: structuredClone(current), outputStyle: 'simple' };
  let hasSecrets = false;
  let webSearchRoute = null;
  const writes = [];
  const cfgMod = {
    loadConfig: () => structuredClone(root.agent),
    saveConfig: (snapshot) => {
      writes.push('config:sync');
      root.agent = structuredClone(snapshot);
    },
    saveConfigAsync: async (snapshot) => {
      writes.push('config');
      root.agent = structuredClone(snapshot);
    },
    patchSkillsDisabled: (names) => {
      writes.push('skills:sync');
      root.agent.skills = { ...root.agent.skills, disabled: [...names] };
    },
    patchSkillsDisabledAsync: async (names) => {
      writes.push('skills');
      root.agent.skills = { ...root.agent.skills, disabled: [...names] };
    },
  };
  const sharedCfgMod = {
    updateConfigAsync: async (update) => {
      writes.push('style');
      root = update(root);
    },
    pendingConfigWrites: async () => {},
  };
  const lifecycle = createConfigLifecycle({
    getConfig: () => current,
    setConfig: (next) => {
      current = next;
    },
    getWebSearchRoute: () => webSearchRoute,
    setWebSearchRoute: (next) => {
      webSearchRoute = next;
    },
    getConfigHasSecrets: () => hasSecrets,
    setConfigHasSecrets: (next) => {
      hasSecrets = next;
    },
    getRoute: () => ({ provider: 'demo' }),
    cfgMod,
    sharedCfgMod,
    setConfiguredShell() {},
    normalizeSystemShellConfig: () => ({ command: '' }),
    normalizeWebSearchRouteConfig: (value) => value || null,
    outputStyleStatus: () => ({}),
    LAZY_SECRET_PROVIDERS: new Set(),
    clean: (value) => String(value || '').trim(),
    resolve,
    STANDALONE_DATA_DIR: process.cwd(),
  });
  return { lifecycle, cfgMod, sharedCfgMod, writes, config: () => current, disk: () => root };
}

test('synchronous reload cannot overtake an older asynchronous config write', async () => {
  const f = fixture();
  const gate = deferred();
  const save = f.cfgMod.saveConfigAsync;
  let calls = 0;
  f.cfgMod.saveConfigAsync = async (snapshot) => {
    if (++calls === 1) await gate.promise;
    await save(snapshot);
  };
  f.lifecycle.saveConfigAndAdopt({ ...f.config(), theme: 'first' });
  const flushed = f.lifecycle.flushAllConfigSavesAsync();
  await setImmediate();
  f.lifecycle.saveConfigAndAdopt({ ...f.config(), theme: 'latest' });
  f.disk().agent.providers.demo.apiKey = 'from-keychain';
  const loaded = f.lifecycle.reloadFullConfig();
  assert.equal(loaded.theme, 'latest');
  assert.equal(loaded.providers.demo.apiKey, 'from-keychain');
  assert.equal(f.writes.includes('config:sync'), false);
  gate.resolve();
  await flushed;
  assert.equal(f.disk().agent.theme, 'latest');
});

test('failed synchronous reload preserves an explicitly disabled provider when overlaying secrets', async () => {
  const f = fixture();
  f.cfgMod.saveConfig = () => {
    throw new Error('fixture lock busy');
  };
  f.disk().agent.providers.demo.apiKey = 'from-keychain';
  f.lifecycle.saveConfigAndAdopt({ ...f.config(), providers: { demo: { enabled: false } }, theme: 'latest' });
  const loaded = f.lifecycle.reloadFullConfig();
  assert.equal(loaded.providers.demo.enabled, false);
  assert.equal(loaded.providers.demo.apiKey, 'from-keychain');
  assert.equal(loaded.theme, 'latest');
  await f.lifecycle.flushAllConfigSavesAsync();
  assert.equal(f.disk().agent.providers.demo.enabled, false);
});

test('a failed asynchronous skills patch is retained for the next flush', async () => {
  const f = fixture();
  const save = f.cfgMod.patchSkillsDisabledAsync;
  f.cfgMod.patchSkillsDisabledAsync = async () => {
    throw new Error('fixture write failed');
  };
  f.lifecycle.scheduleSkillsSave(['demo']);
  await f.lifecycle.flushSkillsSave();
  assert.deepEqual(f.disk().agent.skills.disabled, []);
  f.cfgMod.patchSkillsDisabledAsync = save;
  await f.lifecycle.flushSkillsSave();
  assert.deepEqual(f.disk().agent.skills.disabled, ['demo']);
});

test('a failed synchronous skills patch survives reload and a later async flush', async () => {
  const f = fixture();
  f.cfgMod.patchSkillsDisabled = () => {
    throw new Error('fixture lock busy');
  };
  f.lifecycle.scheduleSkillsSave(['demo']);
  assert.deepEqual(f.lifecycle.reloadFullConfig().skills.disabled, ['demo']);
  await f.lifecycle.flushSkillsSave();
  assert.deepEqual(f.disk().agent.skills.disabled, ['demo']);
});

test('failed output-style writes retain their value and remove only the obsolete agent copy', async () => {
  const f = fixture();
  const save = f.sharedCfgMod.updateConfigAsync;
  f.disk().agent.outputStyle = 'old-location';
  f.sharedCfgMod.updateConfigAsync = async () => {
    throw new Error('fixture write failed');
  };
  f.lifecycle.scheduleOutputStyleSave('detailed');
  await f.lifecycle.flushAllConfigSavesAsync();
  assert.equal(f.disk().outputStyle, 'simple');
  f.sharedCfgMod.updateConfigAsync = save;
  await f.lifecycle.flushAllConfigSavesAsync();
  assert.equal(f.disk().outputStyle, 'detailed');
  assert.equal(Object.hasOwn(f.disk().agent, 'outputStyle'), false);
  assert.equal(f.disk().agent.theme, 'old');
});

test('automatic skills debounce drains the older whole-config snapshot first', async () => {
  const f = fixture();
  // Schedule the skills timer first to exercise ordering rather than relying
  // on timer registration order to protect its more specific patch.
  f.lifecycle.scheduleSkillsSave(['demo']);
  f.lifecycle.saveConfigAndAdopt({ ...f.config(), theme: 'latest' });
  await setTimeout(200);
  assert.deepEqual(f.writes, ['config', 'skills']);
  assert.deepEqual(f.disk().agent.skills.disabled, ['demo']);
  assert.equal(f.disk().agent.theme, 'latest');
});

function initialState(overrides = {}) {
  const stored = { presets: {}, route: 'stored' };
  return resolveInitialConfigState({
    loadConfig: () => stored,
    resolveRoute: (config, { provider, model }) => ({
      provider: provider || 'stored-provider',
      model: model || 'stored-model',
      effort: 'high',
      fast: true,
      fromConfig: config.route,
    }),
    ...overrides,
  });
}

test('boot route overrides apply only when the caller supplied them', () => {
  const untouched = initialState();
  assert.equal(untouched.route.effort, 'high');
  assert.equal(untouched.route.fast, true);
  assert.equal(untouched.route.modelParameters, undefined);
  assert.equal(untouched.route.fromConfig, 'stored');

  const overridden = initialState({
    provider: 'demo',
    model: 'demo-model',
    effort: '',
    fast: false,
    modelParameters: { context: '1m' },
  });
  assert.equal(overridden.route.provider, 'demo');
  assert.equal(overridden.route.model, 'demo-model');
  // An explicit empty effort clears the stored one; `fast: false` is a real
  // choice, not "unset".
  assert.equal(overridden.route.effort, null);
  assert.equal(overridden.route.fast, false);
  assert.deepEqual(overridden.route.modelParameters, { context: '1m' });
});

test('an injected initial config is adopted instead of loading from disk', () => {
  let loads = 0;
  const state = initialState({
    initialConfig: { presets: {}, route: 'injected' },
    loadConfig: () => {
      loads += 1;
      return { route: 'stored' };
    },
  });

  assert.equal(loads, 0);
  assert.equal(state.route.fromConfig, 'injected');
  // The builtins section is stamped on adoption, exactly as a disk load is.
  assert.equal(typeof state.config.builtins, 'object');
});

test('an unset web-search route resolves to the follow-the-main-model default', () => {
  assert.deepEqual(initialState().webSearchRoute, { provider: 'default', model: 'default' });
  assert.deepEqual(
    initialState({ initialConfig: { webSearchRoute: { provider: 'openai', model: 'gpt-5' } } }).webSearchRoute,
    { provider: 'openai', model: 'gpt-5' }
  );
});

test('a failed whole-config write cannot consume the pending skills patch', async () => {
  const f = fixture();
  const save = f.cfgMod.saveConfigAsync;
  f.cfgMod.saveConfigAsync = async () => {
    throw new Error('fixture write failed');
  };
  f.lifecycle.saveConfigAndAdopt({ ...f.config(), theme: 'latest' });
  f.lifecycle.scheduleSkillsSave(['demo']);
  await f.lifecycle.flushAllConfigSavesAsync();
  assert.deepEqual(f.writes, []);
  f.cfgMod.saveConfigAsync = save;
  await f.lifecycle.flushAllConfigSavesAsync();
  assert.deepEqual(f.writes, ['config', 'skills']);
  assert.equal(f.disk().agent.theme, 'latest');
  assert.deepEqual(f.disk().agent.skills.disabled, ['demo']);
});
